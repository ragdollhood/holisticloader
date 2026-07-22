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
        (NO magic links, NO OTP).
     3. Restores the session automatically on page refresh
        (Supabase JS keeps the session in localStorage — this is just the
        auth token, NOT the premium flag, so it satisfies "premium must
        come from Supabase" — see isPremiumUser() below).
     4. On register, creates a matching row in the `profiles` table.
     5. Exposes isPremiumUser() which reads profiles.premium fresh
        from Supabase (source of truth).
     6. Maintains a global `isPremium` boolean and a global `currentUser`
        object that the rest of your site can read.
     7. Renders the header UI (Login / Register / Logout buttons,
        "Logged in as: ..." text) and the login/register modal.
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

  // If email confirmations are OFF in your Supabase Auth settings,
  // data.session will already be set and the user is logged in now.
  // If confirmations are ON, data.user exists but there's no session yet
  // until they confirm — the profile row is still created either way.
  if (data.user) {
    const { error: profileError } = await sb.from("profiles").insert({
      user_id: data.user.id,
      email: data.user.email,
      premium: false
    });
    // Ignore "duplicate row" errors (e.g. if a trigger already created it,
    // or the user re-submits) but surface anything else.
    if (profileError && profileError.code !== "23505") {
      console.error("Profile creation error:", profileError.message);
    }
  }

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
   6. LOGOUT
----------------------------------------------------------------------- */
async function logoutUser() {
  const { error } = await sb.auth.signOut();
  if (error) throw error;
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

  root.innerHTML = `
    <div id="authButtons">
      <button id="loginBtn" type="button">Login</button>
      <button id="registerBtn" type="button">Register</button>
      <span id="authStatus" style="display:none">
        <span id="authEmailLabel"></span>
        <button id="logoutBtn" type="button">Logout</button>
      </span>
    </div>

    <div id="authModal" role="dialog" aria-modal="true" aria-labelledby="authModalTitle">
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
          <p id="authError" role="alert"></p>
          <button id="authSubmit" type="submit">Log in</button>
        </form>
        <p id="authSwitchWrap">
          <span id="authSwitchText">Don't have an account?</span>
          <button id="authSwitchBtn" type="button">Register</button>
        </p>
      </div>
    </div>
  `;

  _wireAuthDom();
}

let _authMode = "login"; // "login" | "register"

function _wireAuthDom() {
  const loginBtn = document.getElementById("loginBtn");
  const registerBtn = document.getElementById("registerBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const modal = document.getElementById("authModal");
  const closeBtn = document.getElementById("authModalClose");
  const form = document.getElementById("authForm");
  const switchBtn = document.getElementById("authSwitchBtn");
  const errorEl = document.getElementById("authError");

  function openModal(mode) {
    _authMode = mode;
    errorEl.textContent = "";
    form.reset();
    _renderAuthModalMode();
    modal.classList.add("show");
    document.getElementById("authEmail").focus();
  }
  function closeModal() {
    modal.classList.remove("show");
  }

  loginBtn.onclick = () => openModal("login");
  registerBtn.onclick = () => openModal("register");
  closeBtn.onclick = closeModal;
  modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

  switchBtn.onclick = () => {
    _authMode = _authMode === "login" ? "register" : "login";
    _renderAuthModalMode();
  };

  logoutBtn.onclick = async () => {
    logoutBtn.disabled = true;
    try {
      await logoutUser();
    } catch (e) {
      console.error(e);
    } finally {
      logoutBtn.disabled = false;
    }
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    const email = document.getElementById("authEmail").value.trim();
    const password = document.getElementById("authPassword").value;
    const submitBtn = document.getElementById("authSubmit");
    submitBtn.disabled = true;

    try {
      if (_authMode === "register") {
        await registerUser(email, password);
      } else {
        await loginUser(email, password);
      }
      closeModal();
    } catch (err) {
      errorEl.textContent = err.message || "Something went wrong. Please try again.";
    } finally {
      submitBtn.disabled = false;
    }
  };
}

function _renderAuthModalMode() {
  const title = document.getElementById("authModalTitle");
  const submit = document.getElementById("authSubmit");
  const switchText = document.getElementById("authSwitchText");
  const switchBtn = document.getElementById("authSwitchBtn");
  const pwField = document.getElementById("authPassword");

  if (_authMode === "register") {
    title.textContent = "Create your account";
    submit.textContent = "Create account";
    switchText.textContent = "Already have an account?";
    switchBtn.textContent = "Log in";
    pwField.setAttribute("autocomplete", "new-password");
  } else {
    title.textContent = "Log in";
    submit.textContent = "Log in";
    switchText.textContent = "Don't have an account?";
    switchBtn.textContent = "Register";
    pwField.setAttribute("autocomplete", "current-password");
  }
}

/* Shows/hides the right buttons and the "Logged in as" label. */
function renderAuthUI() {
  const loginBtn = document.getElementById("loginBtn");
  const registerBtn = document.getElementById("registerBtn");
  const authStatus = document.getElementById("authStatus");
  const emailLabel = document.getElementById("authEmailLabel");
  if (!loginBtn) return; // DOM not built yet

  if (currentUser) {
    loginBtn.style.display = "none";
    registerBtn.style.display = "none";
    authStatus.style.display = "inline-flex";
    emailLabel.textContent = "Logged in as: " + currentUser.email;
  } else {
    loginBtn.style.display = "";
    registerBtn.style.display = "";
    authStatus.style.display = "none";
    emailLabel.textContent = "";
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
   10. EXAMPLE — how your existing premium-locked code should use this.

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
