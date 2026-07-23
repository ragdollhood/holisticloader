/* =======================================================================
   HOLISTIC LOADER — SUPABASE AUTH MODULE
   File: auth.js
   -----------------------------------------------------------------------
   WHERE TO PUT THIS FILE:
     Save as auth.js in the same folder as your other .html files
     (same place as index.html, instruments.html, nutriloader.html, store.html).

   WHERE TO LOAD IT:
     Add these TWO script tags near the end of <body>, BEFORE your page's
     own <script> block that renders backgrounds/sounds/presets, on EVERY
     page that has premium-locked content or needs the login/logout UI:

     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
     <script src="auth.js"></script>

     auth.js must load BEFORE the page-specific script that calls
     renderReel(), renderSounds(), renderPresets(), etc., because this
     file registers a callback that re-runs those render functions
     whenever premium status changes.

   WHAT THIS FILE DOES:
     1. Creates one shared Supabase client (using your existing project).
     2. Exposes register / login / logout functions using email+password
        (NO magic links, NO OTP). There is no self-serve "Register" UI —
        accounts are only created on thank-you.html after a successful
        Stripe purchase, which calls registerUser() itself. The header
        only shows "Login" (for returning customers) and "Get Premium"
        (which opens the premium popup that starts Stripe Checkout).
     3. Restores the session automatically on page refresh
        (Supabase JS keeps the session in localStorage — this is just the
        auth token, NOT the premium flag, so it satisfies "premium must
        come from Supabase" — see isPremiumUser() below).
     4. On register, creates a matching row in the `profiles` table.
     5. Exposes isPremiumUser() which reads profiles.premium fresh
        from Supabase (source of truth).
     6. Maintains a global `isPremium` boolean and a global `currentUser`
        object that the rest of your site can read.
     7. Renders the header UI (Login / Get Premium / Logout buttons,
        "Logged in as: ..." text) and the login modal. The modal itself is
        appended directly to <body> (not left inside the header's DOM),
        so a transformed/filtered header never traps its fixed positioning.
     8. Exposes a "Forgot password?" link inside the login modal, which
        calls sb.auth.resetPasswordForEmail() and redirects the emailed
        link to reset-password.html (which must exist at your site root
        and use the SAME Supabase project's URL/anon key).

     PURCHASE FLOW (Get Premium -> paying customer):
       Click "Get Premium" (header or locked content)
         -> premium popup opens
         -> click "Get Premium for $4.99/month" inside the popup
         -> Stripe Checkout
         -> payment succeeds
         -> redirected to thank-you.html
         -> thank-you.html has the user create their account
            (calls registerUser() from this file)
         -> the Postgres trigger (see section 10 below) creates their
            profiles row; thank-you.html (or your Stripe webhook) should
            then set profiles.premium = true for that account
         -> premium is active everywhere isPremiumUser()/isPremium is used
   ======================================================================= */

/* -----------------------------------------------------------------------
   1. SUPABASE CLIENT
   These are the same project credentials you already use for the
   `visits` table tracking further down in your existing pages.
----------------------------------------------------------------------- */
const SUPABASE_URL = "https://ibytawdimgthoqwtbtgv.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_X4l9e5OPXE9Cq4XVc1jm_A_Hb6tbJUO";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,   // keeps the user logged in across refreshes
    autoRefreshToken: true, // silently refreshes the auth token
    detectSessionInUrl: false
  }
});

/* -----------------------------------------------------------------------
   2. GLOBAL STATE
   Your existing premium-locked content (isBgLocked, isSoundLocked,
   PRESETS.locked, the instruments-page LOCKED array, etc.) should be
   updated to check `isPremium` — see the integration notes at the
   bottom of this file and the separate PATCH NOTES doc.
----------------------------------------------------------------------- */
let isPremium = false;
let currentUser = null; // Supabase auth user object, or null when logged out

/* Callbacks other page scripts can register to be notified whenever
   premium status changes (e.g. so they can re-render locked grids). */
const _premiumChangeListeners = [];
function onPremiumStatusChange(fn) {
  if (typeof fn === "function") _premiumChangeListeners.push(fn);
}
function _firePremiumChangeListeners() {
  _premiumChangeListeners.forEach(fn => {
    try { fn(isPremium); } catch (e) { console.error(e); }
  });
}

/* -----------------------------------------------------------------------
   3. PREMIUM DETECTION (source of truth = Supabase, not localStorage)
----------------------------------------------------------------------- */
async function isPremiumUser() {
  if (!currentUser) return false;
  const { data, error } = await sb
    .from("profiles")
    .select("premium")
    .eq("user_id", currentUser.id)
    .maybeSingle();

  if (error) {
    console.error("isPremiumUser() error:", error.message);
    return false;
  }
  return !!(data && data.premium);
}

async function refreshPremiumStatus() {
  isPremium = await isPremiumUser();
  _firePremiumChangeListeners();
  renderAuthUI();
  return isPremium;
}

/* -----------------------------------------------------------------------
   4. REGISTER
   Creates the auth user AND the matching profiles row.
----------------------------------------------------------------------- */
async function registerUser(email, password) {
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw error;

  // NOTE: the profiles row is now created automatically by a Postgres
  // trigger (on_auth_user_created -> handle_new_user()) that runs on
  // the database side the moment a new row appears in auth.users.
  // This works reliably even when email confirmations are ON (i.e.
  // before the user has a session), which a client-side insert here
  // could not guarantee. See the SQL in the setup notes at the bottom
  // of this file if that trigger hasn't been created yet.

  return data;
}

/* -----------------------------------------------------------------------
   5. LOGIN
----------------------------------------------------------------------- */
async function loginUser(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}
/* -----------------------------------------------------------------------
   5b. WELCOME EMAIL
----------------------------------------------------------------------- */
async function sendWelcomeEmail(email) {
  try {
    const { data, error } = await sb.functions.invoke(
      "send-welcome-email",
      {
        body: { email }
      }
    );

    if (error) throw error;

    console.log("Welcome email sent:", data);
    return true;
  } catch (err) {
    console.error("sendWelcomeEmail error:", err);
    return false;
  }
}
/* -----------------------------------------------------------------------
   6. LOGOUT
----------------------------------------------------------------------- */
async function logoutUser() {
  const { error } = await sb.auth.signOut();
  if (error) throw error;
}

/* -----------------------------------------------------------------------
   6b. MANAGE SUBSCRIPTION (Stripe Billing Portal)
   Called when a logged-in premium user clicks "Manage Subscription".
   Invokes the create-portal-session Edge Function (supabase/functions/
   create-portal-session/index.ts). That function verifies the caller
   from their own session token, looks up their stripe_customer_id
   server-side, and returns a one-time Stripe Billing Portal URL.

   sb.functions.invoke() automatically attaches the current user's
   access token as the Authorization header, so nothing sensitive
   (user id, customer id) is ever sent from the client.

   Cancellations/updates the customer makes inside the Stripe-hosted
   portal still flow through your existing stripe-webhook function,
   which remains the only thing that flips profiles.premium.
----------------------------------------------------------------------- */
async function openBillingPortal(triggerBtn) {
  if (!currentUser) return;

  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = "Loading...";
  }

  try {
    const { data, error } = await sb.functions.invoke("create-portal-session", {
      body: { return_url: window.location.href },
    });

    if (error) throw error;
    if (!data || !data.url) throw new Error("No portal URL returned");

    // Full redirect — Stripe hosts the entire billing portal experience.
    window.location.href = data.url;
  } catch (err) {
    console.error("openBillingPortal() error:", err);
    alert(
      "Couldn't open the billing portal right now. Please try again in a moment."
    );
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.textContent = "Manage Subscription";
    }
  }
}

/* -----------------------------------------------------------------------
   7. AUTH STATE LISTENER
   Fires on: initial load, sign in, sign out, token refresh.
   This is what keeps the user "logged in after refresh" and keeps
   isPremium in sync everywhere.
----------------------------------------------------------------------- */
sb.auth.onAuthStateChange(async (_event, session) => {
  currentUser = session ? session.user : null;
  await refreshPremiumStatus();
});

/* -----------------------------------------------------------------------
   8. UI: header buttons + login/register modal
   This injects markup into #authRoot. Add this empty div to your header
   in each HTML file (see integration notes):

     <div id="authRoot"></div>

   Styling comes from auth-ui.css (add <link rel="stylesheet" href="auth-ui.css">
   in <head>, alongside your existing stylesheet/inline <style>).
----------------------------------------------------------------------- */
function _buildAuthDom() {
  const root = document.getElementById("authRoot");
  if (!root) return;

  // IMPORTANT: only the header buttons/account menu go inside #authRoot.
  // #authRoot lives inside #topNav, and #topNav (like the rest of this
  // site's "glass" look) uses backdrop-filter/transform. Per the CSS spec,
  // any ancestor with transform/filter/backdrop-filter/perspective/
  // will-change creates a new "containing block" for its position:fixed
  // descendants — so a `position:fixed; inset:0` modal nested inside that
  // header would size and position itself relative to the HEADER's box,
  // not the viewport. That's exactly the "modal is half off-screen and
  // looks too small" bug. Fix: build the modal separately and append it
  // straight to <body>, completely outside the header, so `inset:0` is
  // always relative to the real viewport.
  root.innerHTML = `
    <div id="authButtons">
      <button id="loginBtn" type="button">Login</button>
      <button id="registerBtn" type="button">Get Premium</button>
      <div id="accountRoot" style="display:none">
        <button id="accountBtn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Account menu">
          <svg viewBox="0 0 24 24"><path d="M12 12.5a4.75 4.75 0 1 0 0-9.5 4.75 4.75 0 0 0 0 9.5Z"/><path d="M4 20.25c0-3.73 3.58-6.75 8-6.75s8 3.02 8 6.75"/></svg>
        </button>
        <div id="accountMenu" role="menu">
          <div id="accountEmailLabel"></div>
          <button id="manageSubBtn" type="button" role="menuitem" style="display:none">Manage Subscription</button>
          <button id="logoutBtn" type="button" role="menuitem">Logout</button>
        </div>
      </div>
    </div>
  `;

  let modal = document.getElementById("authModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "authModal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "authModalTitle");
    modal.innerHTML = `
      <div id="authModalCard">
        <button id="authModalClose" type="button" aria-label="Close">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
        <h2 id="authModalTitle">Log in</h2>
        <form id="authForm" novalidate>
          <label for="authEmail">Email</label>
          <input id="authEmail" type="email" autocomplete="email" required>
          <label for="authPassword">Password</label>
          <input id="authPassword" type="password" autocomplete="current-password" required minlength="6">
          <div id="authRow">
            <button id="forgotPasswordBtn" type="button">Forgot password?</button>
          </div>
          <p id="authMessage" role="alert"></p>
          <button id="authSubmit" type="submit">Log in</button>
        </form>
      </div>
    `;
    document.body.appendChild(modal);
  }

  _wireAuthDom();
}

/* There is no self-serve registration anymore: accounts are only created
   after a successful Stripe purchase, on thank-you.html (which calls
   registerUser() itself once payment is confirmed). This modal is
   login-only for existing customers. */
function _wireAuthDom() {
  const loginBtn = document.getElementById("loginBtn");
  const registerBtn = document.getElementById("registerBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const manageSubBtn = document.getElementById("manageSubBtn");
  const accountBtn = document.getElementById("accountBtn");
  const accountRoot = document.getElementById("accountRoot");
  const accountMenu = document.getElementById("accountMenu");
  const modal = document.getElementById("authModal");
  const closeBtn = document.getElementById("authModalClose");
  const form = document.getElementById("authForm");
  const messageEl = document.getElementById("authMessage");
  const forgotBtn = document.getElementById("forgotPasswordBtn");

  function showAuthMessage(text, type) {
    messageEl.textContent = text;
    messageEl.className = type || "";
  }

  function openModal() {
    showAuthMessage("", "");
    form.reset();
    document.getElementById("authSubmit").textContent = "Log in";
    modal.classList.add("show");
    document.getElementById("authEmail").focus();
  }
  function closeModal() {
    modal.classList.remove("show");
  }

  function openAccountMenu() {
    accountMenu.classList.add("show");
    accountBtn.setAttribute("aria-expanded", "true");
  }
  function closeAccountMenu() {
    accountMenu.classList.remove("show");
    accountBtn.setAttribute("aria-expanded", "false");
  }
  function toggleAccountMenu() {
    if (accountMenu.classList.contains("show")) closeAccountMenu();
    else openAccountMenu();
  }

  accountBtn.onclick = (e) => {
    e.stopPropagation();
    toggleAccountMenu();
  };
  document.addEventListener("click", (e) => {
    if (!accountRoot.contains(e.target)) closeAccountMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAccountMenu();
  });

  loginBtn.onclick = () => openModal();
  registerBtn.onclick = () => {
    // Opens the same "premium locked content" popup used elsewhere on the
    // page (defined per-page as window.openPremiumModal). That popup now
    // contains the real "Get Premium" button that starts Stripe Checkout.
    if (typeof window.openPremiumModal === "function") {
      window.openPremiumModal();
    }
  };
  closeBtn.onclick = closeModal;
  modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

  logoutBtn.onclick = async () => {
    logoutBtn.disabled = true;
    try {
      await logoutUser();
      closeAccountMenu();
    } catch (e) {
      console.error(e);
    } finally {
      logoutBtn.disabled = false;
    }
  };

  manageSubBtn.onclick = async () => {
    closeAccountMenu();
    await openBillingPortal(manageSubBtn);
  };

  // "Forgot password?" — sends the Supabase reset email. The link inside
  // that email points at reset-password.html, which reads the recovery
  // token from the URL and lets the user set a new password.
  forgotBtn.onclick = async () => {
    const email = document.getElementById("authEmail").value.trim();
    if (!email) {
      showAuthMessage("Enter your email above first, then click \u201cForgot password?\u201d again.", "error");
      document.getElementById("authEmail").focus();
      return;
    }

    forgotBtn.disabled = true;
    const originalLabel = forgotBtn.textContent;
    forgotBtn.textContent = "Sending...";

    try {
      const { error } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + "/reset-password.html"
      });
      if (error) throw error;
      showAuthMessage("Check your email for a password reset link.", "success");
    } catch (err) {
      console.error("resetPasswordForEmail error:", err);
      const readable =
        (err && typeof err.message === "string" && err.message.trim()) ? err.message :
        "Could not send the reset email. Please try again.";
      showAuthMessage(readable, "error");
    } finally {
      forgotBtn.disabled = false;
      forgotBtn.textContent = originalLabel;
    }
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    showAuthMessage("", "");
    const email = document.getElementById("authEmail").value.trim();
    const password = document.getElementById("authPassword").value;
    const submitBtn = document.getElementById("authSubmit");
    submitBtn.disabled = true;

    try {
      await loginUser(email, password);
      closeModal();
    } catch (err) {
      // Always log the full error object to the console so it can be
      // inspected (status code, error code, etc.) even when .message
      // is empty or missing.
      console.error("Auth error (full object):", err);

      const readable =
        (err && typeof err.message === "string" && err.message.trim()) ? err.message :
        (err && typeof err.error_description === "string" && err.error_description.trim()) ? err.error_description :
        (err && err.status) ? `Request failed (status ${err.status}). Check the console for details.` :
        "Something went wrong. Please try again.";

      showAuthMessage(readable, "error");
    } finally {
      submitBtn.disabled = false;
    }
  };
}

/* Shows/hides the account icon and the "Logged in as" label.
   Login/Get Premium are never shown as header buttons — they only live
   in the hamburger menu (#loginMenuBtn / #getPremiumMenuBtn), which
   forwards its clicks to the hidden #loginBtn / #registerBtn below. */
function renderAuthUI() {
  const accountRoot = document.getElementById("accountRoot");
  const accountMenu = document.getElementById("accountMenu");
  const accountBtn = document.getElementById("accountBtn");
  const emailLabel = document.getElementById("accountEmailLabel");
  const manageSubBtn = document.getElementById("manageSubBtn");
  // Optional: the "Login" / "Get Premium" entries in the hamburger menu
  // (indextest.html / instrumentstest.html). Not every page has them,
  // so guard for null.
  const loginMenuBtn = document.getElementById("loginMenuBtn");
  const getPremiumMenuBtn = document.getElementById("getPremiumMenuBtn");
  if (!accountRoot) return; // DOM not built yet

  if (currentUser) {
    accountRoot.style.display = "inline-flex";
    emailLabel.textContent = "Logged in as: " + currentUser.email;
    // Only premium users have a Stripe subscription to manage.
    manageSubBtn.style.display = isPremium ? "" : "none";
    if (loginMenuBtn) loginMenuBtn.style.display = "none";
    if (getPremiumMenuBtn) getPremiumMenuBtn.style.display = "none";
  } else {
    accountRoot.style.display = "none";
    emailLabel.textContent = "";
    manageSubBtn.style.display = "none";
    // Logged out (or logging out) — always collapse the menu.
    accountMenu.classList.remove("show");
    accountBtn.setAttribute("aria-expanded", "false");
    if (loginMenuBtn) loginMenuBtn.style.display = "";
    if (getPremiumMenuBtn) getPremiumMenuBtn.style.display = "";
  }
}

/* -----------------------------------------------------------------------
   9. BOOTSTRAP
   Build the DOM, then restore whatever session already exists
   (this is what makes "stay logged in after refresh" work).
----------------------------------------------------------------------- */
document.addEventListener("DOMContentLoaded", async () => {
  _buildAuthDom();
  const { data: { session } } = await sb.auth.getSession();
  currentUser = session ? session.user : null;
  await refreshPremiumStatus();
});

/* -----------------------------------------------------------------------
   10. REQUIRED ONE-TIME SUPABASE SETUP (run once in the SQL Editor)

   The profiles row is created by a database trigger, not by this file,
   because that's the only approach that works reliably regardless of
   whether "confirm email" is on or off in your Auth settings.

   Run this once in Supabase -> SQL Editor:

     create or replace function public.handle_new_user()
     returns trigger
     language plpgsql
     security definer set search_path = public
     as $$
     begin
       insert into public.profiles (user_id, email, premium)
       values (new.id, new.email, false)
       on conflict (user_id) do nothing;
       return new;
     end;
     $$;

     create trigger on_auth_user_created
       after insert on auth.users
       for each row execute function public.handle_new_user();

     alter table public.profiles enable row level security;

     create policy "Users can view their own profile"
     on public.profiles
     for select
     to authenticated
     using (auth.uid() = user_id);

----------------------------------------------------------------------- */

/* -----------------------------------------------------------------------
   11. EXAMPLE — how your existing premium-locked code should use this.

   Anywhere you currently do:

       if (locked) { openPremiumModal(); }

   it should become:

       if (locked && !isPremium) { openPremiumModal(); }

   And any hard-coded lock function should be changed to also check
   isPremium, for example:

       function isBgLocked(id){ return !isPremium && !FREE_BG_IDS.has(id); }
       function isSoundLocked(id){ return !isPremium && !FREE_SOUND_IDS.has(id); }

   Then register your render functions so they re-run the moment
   isPremium flips (e.g. right after login), unlocking content live
   without needing a page refresh:

       onPremiumStatusChange(() => {
         renderReel();
         renderSounds();
         renderPresets();
       });

   See PATCH-NOTES.md for the exact line-by-line changes for
   indextest.html and instrumentstest.html.
----------------------------------------------------------------------- */

/* -----------------------------------------------------------------------
   12. MANAGE SUBSCRIPTION — REQUIRED SETUP

   The "Manage Subscription" button (visible only to logged-in premium
   users) calls the create-portal-session Edge Function, which must
   already be deployed:

     supabase functions deploy create-portal-session

   That function needs "Verify JWT" ON (the default) since it identifies
   the caller from their own Supabase session token — see the comment
   block at the top of supabase/functions/create-portal-session/index.ts
   for the full explanation and required env vars (STRIPE_SECRET_KEY,
   SITE_ORIGIN).

   Nothing else to wire up on the client: sb.functions.invoke() already
   attaches the logged-in user's access token automatically, and
   openBillingPortal() (section 6b above) handles the loading state,
   the redirect to Stripe, and any errors.
----------------------------------------------------------------------- */
