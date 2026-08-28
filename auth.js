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
        (NO magic links, NO OTP). Accounts get created in TWO ways now:
        (a) self-serve, via the "Free Trial (14 Days)" button in the
        login modal (or the matching button in the premium popup) — no
        payment, starts a 14-day trial from created_at; (b) on
        thank-you.html after a successful Stripe purchase, which also
        calls registerUser() itself. The header always shows one account
        icon: logged out it opens the login modal directly, logged in it
        opens the account dropdown. "Get Premium" opens the premium
        popup that starts Stripe Checkout.
     3. Restores the session automatically on page refresh
        (Supabase JS keeps the session in localStorage — this is just the
        auth token, NOT the premium flag, so it satisfies "premium must
        come from Supabase" — see isPremiumUser() below).
     4. On register, creates a matching row in the `profiles` table.
     5. Exposes isPremiumUser() which reads profiles.premium fresh from
        Supabase and combines it with the 14-day trial window (see
        hasPremiumAccess() below) to decide real premium access.
     6. Maintains a global `isPremium` boolean (paid OR trial access), a
        global `isPaidPremium` boolean (paying customers only), and a
        global `currentUser` object that the rest of your site can read.
     7. Renders the header UI (one always-visible account icon, plus the
        "Logged in as: ..." dropdown once logged in) and the login modal.
        The modal itself is appended directly to <body> (not left inside
        the header's DOM), so a transformed/filtered header never traps
        its fixed positioning.
     8. Exposes a "Forgot password?" link inside the login modal, which
        calls sb.auth.resetPasswordForEmail() and redirects the emailed
        link to reset-password.html (which must exist at your site root
        and use the SAME Supabase project's URL/anon key).

      FLOW ( button -> non-paying trial user):
       Click " (14 Days)" (login modal or premium popup)
         -> the same email/password form switches to register mode
         -> submit -> registerUser() creates the auth user (Postgres
            trigger creates their profiles row with premium=false)
         -> hasPremiumAccess() gives them full access for 14 days from
            their account's created_at, no payment involved
         -> after 14 days, access falls back to guest-level automatically

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
let isPremium = false;      // true if user has ANY premium access (paid OR active trial)
let isPaidPremium = false;  // true ONLY for actual paying customers (profiles.premium === true)
let currentUser = null;     // Supabase auth user object, or null when logged out
let currentDisplayName = null; // profiles.display_name for currentUser; null = not fetched yet, '' = fetched but not set

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
/* Central access rule: paying customers always have access. Everyone
   else gets a 14-day  starting from their account's
   created_at (Supabase Auth user.created_at). */
function hasPremiumAccess(user, profileData) {
  if (profileData && profileData.premium) return true;
  // game.html (window.HL_HIDE_TRIAL_UI = true) has no free-trial premium
  // at all — "Create your account" there exists purely to let a guest
  // pay the one-time $2.99 Remove Ads charge, so a brand-new account
  // must NOT get 14 days of isPremium=true (that was masking the ads
  // as already removed and short-circuiting the Stripe redirect). The
  // trial stays fully intact on every other page that loads auth.js
  // without setting this flag.
  if (window.HL_HIDE_TRIAL_UI) return false;
  if (!user || !user.created_at) return false;
  const createdAt = new Date(user.created_at).getTime();
  const trialEnds = createdAt + (14 * 24 * 60 * 60 * 1000);
  return Date.now() < trialEnds;
}

/* Whole days left of the trial, for the banner. Returns 0 once the
   trial has ended or for users without a created_at (logged out). */
function getTrialDaysRemaining(user) {
  if (!user || !user.created_at) return 0;
  const createdAt = new Date(user.created_at).getTime();
  const trialEnds = createdAt + (14 * 24 * 60 * 60 * 1000);
  const msLeft = trialEnds - Date.now();
  if (msLeft <= 0) return 0;
  return Math.ceil(msLeft / (24 * 60 * 60 * 1000));
}

async function isPremiumUser() {
  if (!currentUser) { isPaidPremium = false; return false; }
  const { data, error } = await sb
    .from("profiles")
    .select("premium")
    .eq("user_id", currentUser.id)
    .maybeSingle();

  if (error) {
    console.error("isPremiumUser() error:", error.message);
    isPaidPremium = false;
    return false;
  }
  isPaidPremium = !!(data && data.premium); // real paying customer, no trial involved
  return hasPremiumAccess(currentUser, data);
}

async function refreshPremiumStatus() {
  isPremium = await isPremiumUser();
  await fetchDisplayName();
  _firePremiumChangeListeners();
  renderAuthUI();
  renderTrialBanner();
  return isPremium;
}

/* Reads profiles.display_name fresh from Supabase (same column used by
   the intuition-game leaderboard's own name form — this just gives the
   account dropdown a second, site-wide way to set/change it). Keeps
   currentDisplayName in sync on login/logout/refresh. */
async function fetchDisplayName() {
  if (!currentUser) { currentDisplayName = null; return null; }
  try {
    const { data, error } = await sb
      .from("profiles")
      .select("display_name")
      .eq("user_id", currentUser.id)
      .maybeSingle();
    if (error) throw error;
    currentDisplayName = (data && data.display_name) ? data.display_name : "";
  } catch (e) {
    console.error("fetchDisplayName() error:", e.message || e);
    currentDisplayName = "";
  }
  return currentDisplayName;
}

/* Shows "X days left of your trial" only for logged-in, non-paying
   users who currently have access via the trial, with 4 days or less
   remaining. Paying customers and expired/no-trial users never see it. */
function renderTrialBanner() {
  const banner = document.getElementById("trialBanner");
  if (!banner) return;

  // Pages that opt out of the trial messaging entirely (currently just
  // game.html — a one-time "Remove Ads" purchase, not the Premium
  // subscription trial) never show this banner, no matter how many
  // trial days the account actually has left.
  if (window.HL_HIDE_TRIAL_UI) { banner.style.display = "none"; return; }

  if (currentUser && !isPaidPremium && isPremium) {
    const daysLeft = getTrialDaysRemaining(currentUser);
    if (daysLeft > 0 && daysLeft <= 4) {
      banner.textContent = "⭐ Du har " + daysLeft + " dag" + (daysLeft === 1 ? "" : "ar") + " kvar av din Premium-testperiod.";
      banner.style.display = "";
      _syncTrialBannerHeight(banner);
      return;
    }
  }
  banner.style.display = "none";
  document.documentElement.style.setProperty("--trial-banner-h", "0px");
}

/* Keeps the sticky header (and the hamburger menu, which is positioned
   relative to it) below the fixed trial banner instead of underneath it.
   .topbar reads this custom property as its sticky `top` offset. Runs
   once immediately (next frame, so the browser has laid the banner out)
   and again via ResizeObserver whenever the banner's own size changes —
   e.g. the Swedish message wrapping onto two lines on a narrow phone. */
let _trialBannerObserver = null;
function _syncTrialBannerHeight(banner) {
  const apply = () => {
    document.documentElement.style.setProperty("--trial-banner-h", banner.offsetHeight + "px");
  };
  requestAnimationFrame(apply);
  if (!_trialBannerObserver && "ResizeObserver" in window) {
    _trialBannerObserver = new ResizeObserver(apply);
    _trialBannerObserver.observe(banner);
  }
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
      <button id="registerBtn" type="button" style="display:none">Get Premium</button>
      <div id="accountRoot">
        <button id="accountBtn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Account">
          <svg viewBox="0 0 24 24"><path d="M12 12.5a4.75 4.75 0 1 0 0-9.5 4.75 4.75 0 0 0 0 9.5Z"/><path d="M4 20.25c0-3.73 3.58-6.75 8-6.75s8 3.02 8 6.75"/></svg>
        </button>
        <div id="accountMenu" role="menu">
          <p id="accountGreeting" hidden></p>
          <div id="accountEmailLabel"></div>
          <label id="accountNameLabel" for="accountNameInput">Choose a display name</label>
          <div id="accountNameRow">
            <input id="accountNameInput" type="text" maxlength="20" placeholder="Choose a display name">
            <button id="accountNameSaveBtn" type="button">Save</button>
          </div>
          <p id="accountNameMsg" role="status"></p>
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
        <button id="authModalClose" type="button" aria-label="Close">&times;</button>
        <h2 id="authModalTitle">Log in</h2>
        <form id="authForm" novalidate>
          <div id="authEmailRow">
            <label for="authEmail">Email</label>
            <input id="authEmail" type="email" autocomplete="email" required>
          </div>
          <label for="authPassword">Password</label>
          <input id="authPassword" type="password" autocomplete="current-password" required minlength="6">
          <div id="authRow">
            <button id="forgotPasswordBtn" type="button">Forgot password?</button>
          </div>
          <p id="authMessage" role="alert"></p>
          <button id="authSubmit" type="submit">Log in</button>
        </form>
        <button id="startTrialBtn" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6.06 6.6.87-4.85 4.6 1.2 6.6L12 17.4l-5.85 3.23 1.2-6.6L2.5 9.43l6.6-.87L12 2.5z"/></svg>
          <span>Free Registration</span>
        </button>
      </div>
    `;
    document.body.appendChild(modal);
  }

  let trialBanner = document.getElementById("trialBanner");
  if (!trialBanner) {
    trialBanner = document.createElement("div");
    trialBanner.id = "trialBanner";
    trialBanner.style.display = "none";
    document.body.appendChild(trialBanner);
  }

  _wireAuthDom();
}

/* There is no self-serve registration anymore: accounts are only created
   after a successful Stripe purchase, on thank-you.html (which calls
   registerUser() itself once payment is confirmed). The modal also lets
   a NEW visitor start a free 14-day trial (self-serve, no payment) via
   the "Free Trial (14 Days)" button, which toggles the same form into
   register mode — see _setAuthMode() below. */
function _wireAuthDom() {
  const registerBtn = document.getElementById("registerBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const manageSubBtn = document.getElementById("manageSubBtn");
  const accountBtn = document.getElementById("accountBtn");
  const accountRoot = document.getElementById("accountRoot");
  const accountMenu = document.getElementById("accountMenu");
  const accountNameInput = document.getElementById("accountNameInput");
  const accountNameSaveBtn = document.getElementById("accountNameSaveBtn");
  const accountNameMsg = document.getElementById("accountNameMsg");
  const modal = document.getElementById("authModal");
  const closeBtn = document.getElementById("authModalClose");
  const form = document.getElementById("authForm");
  const messageEl = document.getElementById("authMessage");
  const forgotBtn = document.getElementById("forgotPasswordBtn");
  const startTrialBtn = document.getElementById("startTrialBtn");

  let _authMode = "login"; // "login" | "register" — which action authForm submits as

  function showAuthMessage(text, type) {
    messageEl.textContent = text;
    messageEl.className = type || "";
  }

  // Switches the SAME email/password form between "Log in" and
  // "Start your free trial" (register) without duplicating any markup.
  function _setAuthMode(mode) {
    _authMode = mode;
    const title = document.getElementById("authModalTitle");
    const submitBtn = document.getElementById("authSubmit");
    const forgotRow = document.getElementById("authRow");
    const passwordInput = document.getElementById("authPassword");
    const trialLabel = startTrialBtn ? startTrialBtn.querySelector("span") : null;

    const readMoreBtn = document.getElementById("readMorePremiumBtn");
    // "Read more about Premium" only ever makes sense on pages that
    // actually sell the Premium subscription — never on the
    // HL_HIDE_TRIAL_UI (game.html / Remove Ads) flow.
    if (readMoreBtn) {
      readMoreBtn.style.display = window.HL_HIDE_TRIAL_UI ? "none" : "";
    }
    passwordInput.required = true;

    if (mode === "register") {
      title.textContent = window.HL_HIDE_TRIAL_UI ? "Create your account" : "Free Registration";
      submitBtn.textContent = window.HL_HIDE_TRIAL_UI ? "Create Account" : "Free Registration";
      if (trialLabel) trialLabel.textContent = "Back to Login";
      if (forgotRow) forgotRow.style.display = "none";
      passwordInput.setAttribute("autocomplete", "new-password");
    } else {
      title.textContent = "Log in";
      submitBtn.textContent = "Log in";
      if (trialLabel) trialLabel.textContent = "Free Registration";
      if (forgotRow) forgotRow.style.display = "";
      passwordInput.setAttribute("autocomplete", "current-password");
    }
  }

  function openModal(mode) {
    showAuthMessage("", "");
    form.reset();
    _setAuthMode(mode || "login");
    modal.classList.add("show");
    document.getElementById("authEmail").focus();
  }
  function closeModal() {
    modal.classList.remove("show");
  }

  // Lets any other script (e.g. the premium modal's own "Free Trial"
  // button, defined per-page in index.html/instruments.html/etc.) open
  // this same modal directly in register mode.
  window.openFreeTrialSignup = () => openModal("register");

  if (startTrialBtn) {
    startTrialBtn.onclick = () => {
      showAuthMessage("", "");
      _setAuthMode(_authMode === "register" ? "login" : "register");
    };
  }

  // "Read more about Premium" opens the full premium modal (defined on
  // the page, in index.html).
  const readMorePremiumBtn = document.getElementById("readMorePremiumBtn");
  function goToPremiumModal() {
    if (typeof window.openPremiumModal === "function") {
      closeModal();
      window.openPremiumModal("login");
    }
  }
  if (readMorePremiumBtn) readMorePremiumBtn.onclick = goToPremiumModal;

  function openAccountMenu() {
    // Close the hamburger menu (if the page built one) before opening
    // this one, so only one menu is ever open at a time.
    if (typeof window.closeHamburgerMenu === "function") window.closeHamburgerMenu();
    accountMenu.classList.add("show");
    accountBtn.setAttribute("aria-expanded", "true");
  }
  function closeAccountMenu() {
    accountMenu.classList.remove("show");
    accountBtn.setAttribute("aria-expanded", "false");
  }
  // Exposed so the page's hamburger menu can close this one when it opens.
  window.closeAccountMenu = closeAccountMenu;
  function toggleAccountMenu() {
    if (accountMenu.classList.contains("show")) closeAccountMenu();
    else openAccountMenu();
  }

  accountBtn.onclick = (e) => {
    e.stopPropagation();
    if (currentUser) toggleAccountMenu();
    else openModal();
  };
  document.addEventListener("click", (e) => {
    if (!accountRoot.contains(e.target)) closeAccountMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAccountMenu();
  });

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

  // Lets a logged-in user set/change the same profiles.display_name
  // used by the intuition-game leaderboard, from anywhere on the site.
  if (accountNameSaveBtn) {
    accountNameSaveBtn.onclick = async () => {
      if (!currentUser) return;
      const name = (accountNameInput.value || "").trim().slice(0, 20);
      if (!name) {
        accountNameMsg.textContent = "Please enter a name.";
        return;
      }
      accountNameSaveBtn.disabled = true;
      try {
        const { error } = await sb
          .from("profiles")
          .update({ display_name: name })
          .eq("user_id", currentUser.id);
        if (error) throw error;
        currentDisplayName = name;
        accountNameInput.value = name;
        accountNameMsg.textContent = "Saved!";
        renderAuthUI(); // updates the "Hello, <name>" greeting above the email
        // Other page scripts (e.g. the intuition-game leaderboard) listen
        // via onPremiumStatusChange to re-sync their own copy of the name.
        _firePremiumChangeListeners();
      } catch (e) {
        console.error("Save display name error:", e);
        accountNameMsg.textContent = "Could not save \u2014 try again.";
      } finally {
        accountNameSaveBtn.disabled = false;
      }
    };
  }
  if (accountNameInput) {
    accountNameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        accountNameSaveBtn.click();
      }
    });
    // Typing again after a save clears the old "Saved!" message.
    accountNameInput.addEventListener("input", () => {
      accountNameMsg.textContent = "";
    });
  }

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
      if (_authMode === "register") {
        const result = await registerUser(email, password);
        if (result && result.session) {
          // Email confirmation is OFF in Supabase — signUp already
          // returned a session, so onAuthStateChange fires and the
          // trial (based on the new account's created_at) is active
          // right away.
          showAuthMessage(
            window.HL_HIDE_TRIAL_UI
              ? "Account created! You can now continue."
              : "Your free trial has started! Enjoy full Premium access for 14 days.",
            "success"
          );
          setTimeout(closeModal, 1400);
        } else {
          // Email confirmation is ON — there's no session yet. The
          // trial still starts from created_at, but the user needs to
          // confirm their email and log in before it's usable.
          showAuthMessage("Almost there! Check your email to confirm your account, then log in to start your free trial.", "success");
        }
      } else {
        await loginUser(email, password);
        closeModal();
      }
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

/* The account icon in the header is now always visible: logged out it
   opens the login modal directly on click, logged in it opens the
   account dropdown (email + logout). "Get Premium" still also lives in
   the hamburger menu (#getPremiumMenuBtn), which forwards its click to
   the hidden #registerBtn below — guarded since not every page has it. */
function renderAuthUI() {
  const accountRoot = document.getElementById("accountRoot");
  const accountMenu = document.getElementById("accountMenu");
  const accountBtn = document.getElementById("accountBtn");
  const emailLabel = document.getElementById("accountEmailLabel");
  const manageSubBtn = document.getElementById("manageSubBtn");
  const getPremiumMenuBtn = document.getElementById("getPremiumMenuBtn");
  const accountNameLabel = document.getElementById("accountNameLabel");
  const accountNameRow = document.getElementById("accountNameRow");
  const accountNameInput = document.getElementById("accountNameInput");
  const accountNameMsg = document.getElementById("accountNameMsg");
  const accountGreeting = document.getElementById("accountGreeting");
  if (!accountRoot) return; // DOM not built yet

  if (currentUser) {
    accountRoot.classList.add("loggedIn");
    accountBtn.setAttribute("aria-label", "Account menu");
    emailLabel.textContent = "Logged in as: " + currentUser.email;
    if (accountGreeting) {
      if (currentDisplayName) {
        accountGreeting.textContent = "Hello, " + currentDisplayName;
        accountGreeting.hidden = false;
      } else {
        accountGreeting.hidden = true;
      }
    }
    // Only ACTUAL PAYING customers have a Stripe subscription to manage
    // — trial users are premium (isPremium) but have nothing to manage.
    manageSubBtn.style.display = isPaidPremium ? "" : "none";
    if (getPremiumMenuBtn) getPremiumMenuBtn.style.display = "none";
    if (accountNameLabel) accountNameLabel.style.display = "";
    if (accountNameRow) accountNameRow.style.display = "";
    // Don't stomp on text the user is actively typing/hasn't saved yet —
    // only sync the field from the fetched value when it's still empty.
    if (accountNameInput && document.activeElement !== accountNameInput && !accountNameInput.value) {
      accountNameInput.value = currentDisplayName || "";
    }
  } else {
    accountRoot.classList.remove("loggedIn");
    accountBtn.setAttribute("aria-label", "Log in");
    emailLabel.textContent = "";
    if (accountGreeting) accountGreeting.hidden = true;
    manageSubBtn.style.display = "none";
    // Logged out (or logging out) — always collapse the menu.
    accountMenu.classList.remove("show");
    accountBtn.setAttribute("aria-expanded", "false");
    if (getPremiumMenuBtn) getPremiumMenuBtn.style.display = "";
    if (accountNameLabel) accountNameLabel.style.display = "none";
    if (accountNameRow) accountNameRow.style.display = "none";
    if (accountNameInput) accountNameInput.value = "";
    if (accountNameMsg) accountNameMsg.textContent = "";
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
