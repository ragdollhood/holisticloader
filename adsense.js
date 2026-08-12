/* =======================================================================
   HOLISTIC LOADER — ADS MODULE (Google AdSense)
   File: adsense.js
   -----------------------------------------------------------------------
   WHERE TO PUT THIS FILE:
     Save as adsense.js next to auth.js and game.html.

   WHERE TO LOAD IT (game.html already updated to do this):
     1. In <head>, the AdSense loader script (once per page):
          <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1322447721565676" crossorigin="anonymous"></script>
     2. Near the end of <body>, AFTER auth.js (needs its `isPremium` /
        onPremiumStatusChange) and BEFORE the page's own inline script
        that calls AdBanner():
          <script src="auth.js"></script>
          <script src="adsense.js"></script>

   WHAT THIS FILE DOES
     1. canShowAds() — false for ANY premium access (paid OR active
        trial, i.e. auth.js's `isPremium`), true for everyone else.
        Ads are a free-tier-only thing; trial users get the same
        ad-free experience as paying customers.
     2. AdBanner(containerId, slotId, format, upsellId) — mounts (once)
        a Google AdSense unit inside the element #containerId, and
        keeps it — plus an optional #upsellId "Remove Ads" strip next
        to it — in sync with premium status. Safe to call once per
        containerId per page load; a second call for the same id is a
        no-op besides re-syncing visibility.
     3. Auto re-syncs every mounted banner whenever premium status
        changes (login, logout, trial expiry, purchase) via auth.js's
        onPremiumStatusChange().

   PLACEMENT RULE (already followed by game.html's markup):
     Only ever mount AdBanner() inside elements that use the existing
     `.map-only` visibility class — i.e. the start/map screen and the
     side panel while on it. NEVER mount an ad inside `.stage`/`.board`
     (the merge board itself), a level-reveal, or the world-clear
     animation — those must always stay ad-free so the ad never
     interrupts actual gameplay.
   ======================================================================= */

const AD_CLIENT = "ca-pub-1322447721565676";

// Registry of every AdBanner() instance mounted on this page, so one
// premium-status change can resync them all in a single pass.
const _adBanners = [];

function canShowAds() {
  // isPremium (from auth.js) is true for BOTH paid and trial users —
  // neither should ever see an ad. Falls back to "show ads" if auth.js
  // hasn't loaded yet, since that only happens for guests anyway.
  return typeof isPremium !== "undefined" ? !isPremium : true;
}

/**
 * Mounts (once) a Google AdSense unit inside #containerId and keeps it,
 * plus an optional adjacent "Remove Ads" upsell element, in sync with
 * premium status. Calling this again for a containerId that's already
 * mounted just re-syncs visibility — it never re-creates or re-pushes
 * the ad (AdSense throws if you push into the same <ins> twice).
 *
 * @param {string} containerId - id of an existing empty element to render into
 * @param {string} slotId - your AdSense ad unit slot ID (from the AdSense dashboard)
 * @param {"auto"|"horizontal"|"rectangle"|"fluid"} [format="auto"]
 * @param {string} [upsellId] - id of a "Remove Ads" element to show/hide alongside the ad
 */
function AdBanner(containerId, slotId, format, upsellId) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const entry = { el, upsellEl: upsellId ? document.getElementById(upsellId) : null };

  if (el.dataset.adMounted === "true") { _syncAdBanner(entry); return; }
  el.dataset.adMounted = "true";

  el.insertAdjacentHTML("beforeend", `
    <ins class="adsbygoogle"
         style="display:block"
         data-ad-client="${AD_CLIENT}"
         data-ad-slot="${slotId}"
         data-ad-format="${format || "auto"}"
         data-full-width-responsive="true"></ins>
  `);

  _adBanners.push(entry);
  _syncAdBanner(entry); // correct show/hide before the first real paint
}

function _syncAdBanner(entry) {
  const show = canShowAds();
  entry.el.classList.toggle("ad-hidden", !show);
  if (entry.upsellEl) entry.upsellEl.classList.toggle("ad-hidden", !show);

  // Only ever push once per unit — AdSense fills the same <ins> node
  // it was pushed with; pushing again after a later show/hide toggle
  // throws "already have ads in it".
  if (show && entry.el.dataset.adPushed !== "true") {
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); }
    catch (e) { console.error("AdSense push failed:", e); }
    entry.el.dataset.adPushed = "true";
  }
}

function refreshAllAdBanners() {
  _adBanners.forEach(_syncAdBanner);
}

// Keep every mounted banner in sync with login/trial/purchase changes.
if (typeof onPremiumStatusChange === "function") {
  onPremiumStatusChange(refreshAllAdBanners);
} else {
  console.error("adsense.js loaded before auth.js — ads will not react to premium status.");
}
