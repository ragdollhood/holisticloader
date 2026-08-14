/* visits.js — SHARED across every Holistic Loader page (about, breathing,
   game, index, instruments, nutriloader, store, yoga-loader, ...). One
   copy, one place to fix bugs or change the tracking table, instead of
   the same ~65 lines pasted into each page with a different `page:`
   value each time.

   WHERE TO LOAD IT:
     Near the end of <body>, AFTER supabase-js and auth.js (this file
     uses the shared SUPABASE_URL / SUPABASE_ANON_KEY globals auth.js
     defines — loading it any earlier throws "SUPABASE_URL is not
     defined" and silently drops that page's visit, caught by the
     try/catch below but never sent). Set window.HL_PAGE_NAME right
     before the <script src="visits.js"> tag so this file knows which
     page it's running on:

       <script src="auth.js"></script>
       <script>window.HL_PAGE_NAME = "breathing";</script>
       <script src="visits.js"></script>

   Existing page: values, kept as-is so historical Supabase rows stay
   comparable — just set HL_PAGE_NAME to the matching one per page:
     about.html         → (not currently tracked)
     breathing.html      → "breathing"
     game.html            → "game"
     index.html            → "startsida"
     instruments.html      → "instruments"
     nutriloader.html      → "nutriloader"
     store.html            → "shop"
     yoga-loader.html      → "yoga"
*/

/* owner's own visitor IDs — never counted as visits */
const EXCLUDED_VISITOR_IDS = [
  "183871a4-aa9b-4eaa-8668-2cd14de446c2",
  "9fe82a0f-073b-43ac-b5ec-27e3637fc35e",
  "bb5f4d85-4d84-448d-ad42-60480d8cbc1b",
  "071e4c9d-2b06-41d2-9353-77d61f3a83c4"
];

function getVisitorId() {
  let id = localStorage.getItem("visitor_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("visitor_id", id);
  }
  return id;
}

async function getVisitorCountry() {
  try {
    const response = await fetch("https://ipapi.co/json/");
    const data = await response.json();
    return data.country_name || "Unknown";
  } catch (error) {
    return "Unknown";
  }
}

async function registerVisit() {
  if (localStorage.getItem("site_owner") === "true") return;

  const visitorId = getVisitorId();
  if (EXCLUDED_VISITOR_IDS.includes(visitorId)) return;

  const pageName = window.HL_PAGE_NAME;
  if (!pageName) {
    // Fails loudly in the console instead of silently mislabeling (or
    // dropping) the visit — set window.HL_PAGE_NAME before this
    // script tag on every page that includes it.
    console.error("visits.js: window.HL_PAGE_NAME was not set — visit not recorded.");
    return;
  }

  try {
    const country = await getVisitorCountry();

    await fetch(`${SUPABASE_URL}/rest/v1/visits`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        site: "holisticloader",
        page: pageName,
        page_url: window.location.pathname,
        visitor_id: visitorId,
        country: country
      })
    });
  } catch (error) {
    console.error("Visit registration failed:", error);
  }
}

registerVisit();
