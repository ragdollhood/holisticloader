/* visits2.js — visit tracker for the standalone game2 page. Same pattern
   as visits.js (game.html's tracker) but tagged page: "game2" instead of
   page: "game", so its visits are counted separately in Supabase from the
   original game. Depends on SUPABASE_URL / SUPABASE_ANON_KEY globals
   defined by auth.js, and must load after game2.js (same position as
   visits.js does on game.html). */

/* ---------- Visit tracking (same "visits" table as game.html/
   nutriloader.html, just with page: "game2" so you can filter by page in
   Supabase). auth.js (loaded above) already defines the shared
   SUPABASE_URL / SUPABASE_ANON_KEY consts this uses. ---------- */

/* owner's own visitor IDs — never counted as visits (same list as game.html) */
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
        page: "game2",
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
