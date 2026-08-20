/* game.js — extracted from game.html for caching/perf.
   Must load after supabase-js, the window.HL_HIDE_TRIAL_UI flag,
   auth.js, and adsense.js — same position/order as the original
   inline <script> block it replaces. */

/* -----------------------------------------------------------------
   MERGE SOUND — a bright, happy little chime played every time three
   (or more) matching items merge into a new one: a quick ascending
   major arpeggio (C5-E5-G5-C6) with a bell-like sparkle on top of
   each note, plus a soft high shimmer at the end. Replaces the
   previous low symphonic-gong strike with something more upbeat and
   celebratory to match a "beautiful merge" moment.

   Two things this guards against:
   - Chain merges: resolveMerges() can call this several times within
     the same millisecond (a single tap that cascades level 3 -> 4 -> 5).
     A compressor on the output bus plus a short amplitude "duck" on
     back-to-back strikes stops those overlapping hits from summing
     into clipping/distortion.
   - The noise "shimmer" burst used to build a fresh ~22K-sample random
     buffer on every single call — real, avoidable CPU work sitting
     right in the placeTile() hot path. It's built once lazily and
     reused (safe: multiple simultaneous AudioBufferSourceNodes can
     share one AudioBuffer).

   The AudioContext is created lazily on the first merge, inside a
   click-driven call stack (placeTile → resolveMerges), which counts
   as a user gesture so autoplay policies won't block it.
----------------------------------------------------------------- */
let mergeAc = null;
let mergeLimiter = null; // shared DynamicsCompressor all strikes route through
let mergeNoiseBuf = null; // shared, built once on first use
function getMergeAc() {
  if (!mergeAc) {
    mergeAc = new (window.AudioContext || window.webkitAudioContext)();
    mergeLimiter = mergeAc.createDynamicsCompressor();
    mergeLimiter.threshold.value = -12;
    mergeLimiter.knee.value = 6;
    mergeLimiter.ratio.value = 12;
    mergeLimiter.attack.value = 0.003;
    mergeLimiter.release.value = 0.25;
    mergeLimiter.connect(mergeAc.destination);
  }
  if (mergeAc.state === "suspended") mergeAc.resume();
  return mergeAc;
}
function getMergeNoiseBuf(ac, dur) {
  if (!mergeNoiseBuf) {
    const buf = ac.createBuffer(1, Math.max(1, Math.floor(ac.sampleRate * dur)), ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
    mergeNoiseBuf = buf;
  }
  return mergeNoiseBuf;
}
// Bright ascending major arpeggio — C5, E5, G5, C6 — the "happy little
// sparkle" that plays on every merge. Notes fire in quick succession
// (MERGE_CHIME_NOTE_GAP apart) rather than all at once, so it reads as a
// cheerful little run up the scale instead of one flat chord.
const MERGE_CHIME_NOTES = [523.25, 659.25, 783.99, 1046.50];
const MERGE_CHIME_NOTE_GAP = 0.045;
const MERGE_CHIME_ATTACK = 0.006;
const MERGE_CHIME_DECAY = 0.42;
const MERGE_CHIME_PEAK = 0.22;
const MERGE_CHIME_SPARKLE_RATIO = 3; // bright overtone, an octave-plus-a-fifth above each note
const MERGE_CHIME_SPARKLE_AMOUNT = 0.28;

// Rapid-succession ducking: a chain of merges within ~1.2s of each other
// gets a quieter chime so back-to-back cascades don't pile up into an
// overloud stack.
let lastMergeGongTime = -Infinity;

function playMergeGong() {
  const ac = getMergeAc();
  const t0 = ac.currentTime + 0.02;
  const nowMs = performance.now();
  const duck = (nowMs - lastMergeGongTime) < 1200 ? .62 : 1;
  lastMergeGongTime = nowMs;
  const v = 0.9 * duck; // overall one-shot level

  MERGE_CHIME_NOTES.forEach((freq, i) => {
    const noteStart = t0 + i * MERGE_CHIME_NOTE_GAP;
    const noteEnd = noteStart + MERGE_CHIME_ATTACK + MERGE_CHIME_DECAY;

    const g = ac.createGain();
    g.connect(mergeLimiter);
    g.gain.setValueAtTime(0.0001, noteStart);
    g.gain.linearRampToValueAtTime(v * MERGE_CHIME_PEAK, noteStart + MERGE_CHIME_ATTACK);
    g.gain.exponentialRampToValueAtTime(0.0001, noteEnd);

    // Fundamental — a clean sine "ding" for each note.
    const o = ac.createOscillator();
    o.type = "sine";
    o.frequency.value = freq;
    o.connect(g);
    o.start(noteStart);
    o.stop(noteEnd + 0.1);

    // Bright overtone layered on top for a little bell-like sparkle.
    const sparkleGain = ac.createGain();
    sparkleGain.gain.value = MERGE_CHIME_SPARKLE_AMOUNT;
    sparkleGain.connect(g);
    const sparkle = ac.createOscillator();
    sparkle.type = "sine";
    sparkle.frequency.value = freq * MERGE_CHIME_SPARKLE_RATIO;
    sparkle.connect(sparkleGain);
    sparkle.start(noteStart);
    sparkle.stop(noteEnd + 0.1);
  });

  // A soft high shimmer right at the end of the run, like a little
  // twinkle — reuses the single shared noise buffer built by
  // getMergeNoiseBuf() instead of generating a fresh one on every call.
  const shimmerStart = t0 + (MERGE_CHIME_NOTES.length - 1) * MERGE_CHIME_NOTE_GAP;
  const ndur = 0.35;
  const nb = ac.createBufferSource();
  nb.buffer = getMergeNoiseBuf(ac, ndur);
  const nf = ac.createBiquadFilter();
  nf.type = "bandpass";
  nf.frequency.value = 4200;
  nf.Q.value = 0.9;
  const ng = ac.createGain();
  ng.gain.setValueAtTime(0.0001, shimmerStart);
  ng.gain.linearRampToValueAtTime(v * 0.05, shimmerStart + 0.004);
  ng.gain.exponentialRampToValueAtTime(0.0001, shimmerStart + ndur);
  nb.connect(nf).connect(ng).connect(mergeLimiter);
  nb.start(shimmerStart);
  nb.stop(shimmerStart + ndur + 0.05);
}

/* -----------------------------------------------------------------
   LEVEL-CLEAR FANFARE — a longer, bigger celebration sound played once
   whenever an island is actually cleared (reaching 5/5 for the first
   time in that world — see checkWorldClear()). Builds on the same
   "bright and happy" palette as the merge chime above (same shared
   AudioContext/limiter/noise buffer) but is deliberately longer and
   fuller: a quick rising run-up into a big sustained major chord with
   a sparkly shimmer underneath, so it reads as a small triumphant
   fanfare rather than just another merge ding.
----------------------------------------------------------------- */
const WORLD_CLEAR_RUN_NOTES = [392.00, 523.25, 659.25, 783.99]; // G4, C5, E5, G5 — quick run-up
const WORLD_CLEAR_RUN_GAP = 0.09;
const WORLD_CLEAR_RUN_ATTACK = 0.012;
const WORLD_CLEAR_RUN_DECAY = 0.2;
const WORLD_CLEAR_RUN_PEAK = 0.18;
const WORLD_CLEAR_CHORD_NOTES = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6 — the big landing chord
const WORLD_CLEAR_CHORD_ATTACK = 0.02;
const WORLD_CLEAR_CHORD_DECAY = 1.5;
const WORLD_CLEAR_CHORD_PEAK = 0.20;
const WORLD_CLEAR_CHORD_SPARKLE_RATIO = 2; // an octave up, for extra shine on the landing chord
const WORLD_CLEAR_CHORD_SPARKLE_AMOUNT = 0.22;

function playWorldClearFanfare() {
  const ac = getMergeAc();
  const t0 = ac.currentTime + 0.02;

  // Quick rising run-up leading into the landing chord.
  WORLD_CLEAR_RUN_NOTES.forEach((freq, i) => {
    const noteStart = t0 + i * WORLD_CLEAR_RUN_GAP;
    const noteEnd = noteStart + WORLD_CLEAR_RUN_ATTACK + WORLD_CLEAR_RUN_DECAY;
    const g = ac.createGain();
    g.connect(mergeLimiter);
    g.gain.setValueAtTime(0.0001, noteStart);
    g.gain.linearRampToValueAtTime(WORLD_CLEAR_RUN_PEAK, noteStart + WORLD_CLEAR_RUN_ATTACK);
    g.gain.exponentialRampToValueAtTime(0.0001, noteEnd);

    const o = ac.createOscillator();
    o.type = "triangle";
    o.frequency.value = freq;
    o.connect(g);
    o.start(noteStart);
    o.stop(noteEnd + 0.05);
  });

  // Big bright chord landing at the end of the run-up — the "you did
  // it" swell, held for over a second.
  const chordStart = t0 + WORLD_CLEAR_RUN_NOTES.length * WORLD_CLEAR_RUN_GAP;
  const chordEnd = chordStart + WORLD_CLEAR_CHORD_ATTACK + WORLD_CLEAR_CHORD_DECAY;

  WORLD_CLEAR_CHORD_NOTES.forEach((freq) => {
    const g = ac.createGain();
    g.connect(mergeLimiter);
    g.gain.setValueAtTime(0.0001, chordStart);
    g.gain.linearRampToValueAtTime(WORLD_CLEAR_CHORD_PEAK, chordStart + WORLD_CLEAR_CHORD_ATTACK);
    g.gain.exponentialRampToValueAtTime(0.0001, chordEnd);

    const o = ac.createOscillator();
    o.type = "sine";
    o.frequency.value = freq;
    o.connect(g);
    o.start(chordStart);
    o.stop(chordEnd + 0.15);

    const sparkleGain = ac.createGain();
    sparkleGain.gain.value = WORLD_CLEAR_CHORD_SPARKLE_AMOUNT;
    sparkleGain.connect(g);
    const sparkle = ac.createOscillator();
    sparkle.type = "sine";
    sparkle.frequency.value = freq * WORLD_CLEAR_CHORD_SPARKLE_RATIO;
    sparkle.connect(sparkleGain);
    sparkle.start(chordStart);
    sparkle.stop(chordEnd + 0.15);
  });

  // Soft shimmer underneath the chord, same shared noise buffer the
  // merge chime uses.
  const ndur = 1.0;
  const nb = ac.createBufferSource();
  nb.buffer = getMergeNoiseBuf(ac, ndur);
  const nf = ac.createBiquadFilter();
  nf.type = "bandpass";
  nf.frequency.value = 5000;
  nf.Q.value = 0.7;
  const ng = ac.createGain();
  ng.gain.setValueAtTime(0.0001, chordStart);
  ng.gain.linearRampToValueAtTime(0.06, chordStart + 0.02);
  ng.gain.exponentialRampToValueAtTime(0.0001, chordStart + ndur);
  nb.connect(nf).connect(ng).connect(mergeLimiter);
  nb.start(chordStart);
  nb.stop(chordStart + ndur + 0.05);
}

/* -----------------------------------------------------------------
   ITEMS — a single shared set of merge-tile art used in every world:
   { level, image, name, score }. No emoji anywhere: every tile,
   the "next up" preview, the collection strip, and the merge burst
   all render a real <img class="item-icon"> pointed at `image`.

   Swap art without touching any other code: point `image` at .png
   or .webp — nothing else in the game cares which format you use.

   Expected folder layout (create these in images/ next to the HTML):
     images/game-item1.webp/.png ... game-item5.webp/.png
       (shared fallback icon per level — unused in practice here since
        every one of this game's 10 worlds has its own themed item art
        via WORLD_ITEM_IMAGES below, but kept as a safety fallback.)
     images/game11-20/game-world11.webp/.jpg ... game-world20.webp/.jpg
       (stage backdrop, one per world — BOTH a .webp and a .jpg are
        expected for each number; getWorldBackgroundUrl() picks
        whichever the browser actually supports at runtime.)

     STANDALONE GAME NOTE: this is a self-contained 10-world game built
     from the original Holistic Loader template. It keeps the original
     world numbering (11-20) in its filenames/keys purely because that's
     what the supplied art is named — there is no "world 1-10" game
     attached to this file.

   Add a new world by adding one more key to WORLD_BACKGROUNDS and
   WORLD_LABELS below — setWorld() and renderWorldPicker() both
   iterate WORLD_KEYS automatically, no other code changes needed.
----------------------------------------------------------------- */
const ITEMS = [
  { level: 1, image: "images/game-item1", name: "Level 1",     score: 5 },
  { level: 2, image: "images/game-item2", name: "Level 2",   score: 22 },
  { level: 3, image: "images/game-item3", name: "Level 3",    score: 80 },
  { level: 4, image: "images/game-item4", name: "Level 4",    score: 260 },
  { level: 5, image: "images/game-item5", name: "Level 5",    score: 780 }
];

// Per-world item-art overrides — keyed by world key, then indexed by
// level (1-5). Any world not listed here falls back to the shared ITEMS
// art above, unchanged. Add more worlds the same way if/when they get
// their own themed item set. Same webp/png fallback rule as the shared
// art (see getItemImageUrl() below) — every image here needs BOTH a
// .webp AND a .png file present in images/.
const WORLD_ITEM_IMAGES = {
  troll: {
    1: "images/game11-20/game-item-11troll1",
    2: "images/game11-20/game-item-11troll2",
    3: "images/game11-20/game-item-11troll3",
    4: "images/game11-20/game-item-11troll4",
    5: "images/game11-20/game-item-11troll5"
  },
  desert: {
    1: "images/game11-20/game-item-12desert1",
    2: "images/game11-20/game-item-12desert2",
    3: "images/game11-20/game-item-12desert3",
    4: "images/game11-20/game-item-12desert4",
    5: "images/game11-20/game-item-12desert5"
  },
  pastry: {
    1: "images/game11-20/game-item-13forest1",
    2: "images/game11-20/game-item-13forest2",
    3: "images/game11-20/game-item-13forest3",
    4: "images/game11-20/game-item-13forest4",
    5: "images/game11-20/game-item-13forest5"
  },
  purplefox: {
    1: "images/game11-20/game-item-14fox1",
    2: "images/game11-20/game-item-14fox2",
    3: "images/game11-20/game-item-14fox3",
    4: "images/game11-20/game-item-14fox4",
    5: "images/game11-20/game-item-14fox5"
  },
  glacier: {
    1: "images/game11-20/game-item-15glacier1",
    2: "images/game11-20/game-item-15glacier2",
    3: "images/game11-20/game-item-15glacier3",
    4: "images/game11-20/game-item-15glacier4",
    5: "images/game11-20/game-item-15glacier5"
  },
  garden: {
    1: "images/game11-20/game-item-16magic1",
    2: "images/game11-20/game-item-16magic2",
    3: "images/game11-20/game-item-16magic3",
    4: "images/game11-20/game-item-16magic4",
    5: "images/game11-20/game-item-16magic5"
  },
  waterfall: {
    1: "images/game11-20/game-item17-plant1",
    2: "images/game11-20/game-item17-plant2",
    3: "images/game11-20/game-item17-plant3",
    4: "images/game11-20/game-item17-plant4",
    5: "images/game11-20/game-item17-plant5"
  },
  djungle: {
    1: "images/game11-20/game-item-18djungle1",
    2: "images/game11-20/game-item-18djungle2",
    3: "images/game11-20/game-item-18djungle3",
    4: "images/game11-20/game-item-18djungle4",
    5: "images/game11-20/game-item-18djungle5"
  },
  icecave: {
    1: "images/game11-20/game-item-19crystal1",
    2: "images/game11-20/game-item-19crystal2",
    3: "images/game11-20/game-item-19crystal3",
    4: "images/game11-20/game-item-19crystal4",
    5: "images/game11-20/game-item-19crystal5"
  },
  cosmos: {
    1: "images/game11-20/game-item-20rymd1",
    2: "images/game11-20/game-item-20rymd2",
    3: "images/game11-20/game-item-20rymd3",
    4: "images/game11-20/game-item-20rymd4",
    5: "images/game11-20/game-item-20rymd5"
  }
};

// Declaration order of the keys below = world/unlock order everywhere else.
// This is a standalone 10-world game (islands 11-20 from the original
// Holistic Loader numbering, renumbered 1-10 here since this game only
// contains this set). Backdrop art lives at images/game11-20/game-world<N>
// using the ORIGINAL numbering (11-20) to match the supplied filenames.
// No file extension here on purpose: getWorldBackgroundUrl() below appends
// .webp or .jpg depending on what the browser actually supports, so
// every world needs BOTH a .webp AND a .jpg file present.
const WORLD_BACKGROUNDS = {
  troll:       "images/game11-20/game-world11",
  desert:  "images/game11-20/game-world12",
  pastry:    "images/game11-20/game-world13",
  purplefox:     "images/game11-20/game-world14",
  glacier:          "images/game11-20/game-world15",
  garden:    "images/game11-20/game-world16",
  waterfall: "images/game11-20/game-world17",
  djungle:  "images/game11-20/game-world18",
  icecave:     "images/game11-20/game-world19",
  cosmos:    "images/game11-20/game-world20"
};

// ---------- WebP support detection (with format fallback) ----------
// canvas.toDataURL("image/webp") is a synchronous, well-supported way to
// check this: modern browsers return a real "data:image/webp" string,
// while browsers that can't encode webp silently fall back to PNG (so the
// check below correctly evaluates to false for them). Any older/unusual
// browser (or webview with canvas fingerprinting protection blocking the
// check) then transparently falls back — to .png for item icons (keeps
// their transparency) and .jpg for world backdrops (opaque anyway, so
// jpg's smaller size wins there).
function supportsWebP() {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    return canvas.toDataURL("image/webp").indexOf("data:image/webp") === 0;
  } catch (err) {
    return false;
  }
}
const WEBP_SUPPORTED = supportsWebP();

function getWorldBackgroundUrl(key) {
  const base = WORLD_BACKGROUNDS[key];
  return base ? `${base}.${WEBP_SUPPORTED ? "webp" : "jpg"}` : null;
}

function getItemImageUrl(item) {
  // .png (not .jpg) fallback: item icons are transparent circular art —
  // a jpg fallback would show each one on an opaque square instead.
  if (!item || !item.image) return null;
  const override = WORLD_ITEM_IMAGES[currentWorldKey] && WORLD_ITEM_IMAGES[currentWorldKey][item.level];
  const base = override || item.image;
  return `${base}.${WEBP_SUPPORTED ? "webp" : "png"}`;
}

// Map background is responsive on top of the webp/jpg format swap: phones
// get the portrait images/game-karta1-10mobile.*, desktop/laptop widths
// (DESKTOP_MEDIA_QUERY, declared further down) get the landscape
// images/game-karta1-10laptop.*. Called both up front and again any time
// the mobile/desktop breakpoint is crossed at runtime — see the
// DESKTOP_MEDIA_QUERY "change" listener below.
function getMapBackgroundUrl(page) {
  if (!MAP_PAGES[page]) return null;
  const base = (typeof DESKTOP_MEDIA_QUERY !== "undefined" && DESKTOP_MEDIA_QUERY.matches) ? MAP_IMAGE_LAPTOP : MAP_IMAGE_MOBILE;
  return `${base}.${WEBP_SUPPORTED ? "webp" : "jpg"}`;
}

const WORLD_KEYS = Object.keys(WORLD_BACKGROUNDS);

const WORLD_LABELS = {

  troll:    "The Trolls", // island 11
  desert:       "The Desert",       // island 12
  pastry:        "The Meadow",        // island 13
  purplefox:      "The Foxes",      // island 14
  glacier:     "The Glacier",     // island 15
  garden:       "The Garden",       // island 16
  waterfall:     "The Waterfall",     // island 17
  djungle:         "The Djungle",         // island 18
  icecave:       "The Icecave",       // island 19
  cosmos:     "The Universe",     // island 20

};

/* -----------------------------------------------------------------
   MAP SCREEN — a single artwork holds all 10 islands, so there's only
   ever one "page" now (kept as an object/mapPage variable purely so
   the rest of the map plumbing below — and the existing map_page
   cloud column — doesn't need to change shape). The map is the
   landing screen after login; tapping an unlocked island calls
   enterWorld() to open that world's board. "Clearing" an island =
   creating CLEAR_ITEM_LEVEL's item (level 5, "Lotus") at least once
   while that world is active — see checkWorldClear() in placeTile().
   Clearing island N unlocks island N+1.

   The map background image is responsive — see getMapBackgroundUrl()
   below — using images/game-karta1-10mobile.* (portrait) on phones
   and images/game-karta1-10laptop.* (landscape) on desktop/laptop
   widths, each with a .webp (preferred) and .jpg fallback.

   Positions are percentages (of the map image's width/height) for
   each numbered circle in the artwork, laid out as a snaking 3-column
   path (boustrophedon) bottom -> top: 1, 2, 3 left-to-right along the
   bottom row; 4 above 3, 5 left of 4, 6 above 1 along the next row
   (right-to-left); 7 above 6, 8 right of 7, 9 right of 8 along the row
   above that (left-to-right); 10 alone at the very top. Both the
   mobile (portrait) and laptop (landscape) artwork use the same
   number-to-slot order — only the actual pixel percentages differ
   between the two images. See ISLAND_POSITIONS_MOBILE /
   ISLAND_POSITIONS_LAPTOP and getIslandPositions() below — the x/y
   values there are a best-guess grid and may need eyeballing against
   the real map artwork to land each numbered circle exactly on its
   island.
----------------------------------------------------------------- */
const CLEAR_ITEM_LEVEL = 5;
const MAP_WORLD_KEYS = WORLD_KEYS.slice(0, 10); // islands 1-10
const MAP_PAGES = {
  1: { keys: MAP_WORLD_KEYS, offset: 0 }
};
const MAP_IMAGE_MOBILE = "images/game11-20/game-karta11-20mobil";
const MAP_IMAGE_LAPTOP = "images/game11-20/game-karta11-20laptop";

// Snaking 3-column path, bottom -> top (boustrophedon):
//   row 1 (bottom, left -> right):  1, 2, 3
//   row 2 (right -> left):          4 (above 3), 5 (left of 4), 6 (above 1)
//   row 3 (left -> right):          7 (above 6), 8 (right of 7), 9 (right of 8)
//   row 4 (top, single, centered):  10
// Portrait artwork:
const ISLAND_POSITIONS_MOBILE = {
  1:  { x: 20, y: 88 }, // bottom row, left — journey start
  2:  { x: 50, y: 88 }, // bottom row, middle
  3:  { x: 80, y: 88 }, // bottom row, right
  4:  { x: 80, y: 64 }, // row 2, right — above 3
  5:  { x: 50, y: 64 }, // row 2, middle — left of 4
  6:  { x: 20, y: 64 }, // row 2, left — above 1
  7:  { x: 20, y: 40 }, // row 3, left — above 6
  8:  { x: 50, y: 40 }, // row 3, middle — right of 7
  9:  { x: 80, y: 40 }, // row 3, right — right of 8
  10: { x: 50, y: 20 }  // top, single — journey end
};

// Landscape artwork: same snake pattern/order, laid out across the
// wider 3-column grid.
const ISLAND_POSITIONS_LAPTOP = {
  1:  { x: 22, y: 85 }, // bottom row, left — journey start
  2:  { x: 50, y: 85 }, // bottom row, middle
  3:  { x: 78, y: 85 }, // bottom row, right
  4:  { x: 78, y: 58 }, // row 2, right — above 3
  5:  { x: 50, y: 58 }, // row 2, middle — left of 4
  6:  { x: 22, y: 58 }, // row 2, left — above 1
  7:  { x: 22, y: 31 }, // row 3, left — above 6
  8:  { x: 50, y: 31 }, // row 3, middle — right of 7
  9:  { x: 78, y: 31 }, // row 3, right — right of 8
  10: { x: 50, y: 15 }  // top, single — journey end
};

// Picks whichever position set matches the map image currently showing
// (see getMapBackgroundUrl(), same breakpoint check).
function getIslandPositions() {
  return (typeof DESKTOP_MEDIA_QUERY !== "undefined" && DESKTOP_MEDIA_QUERY.matches) ? ISLAND_POSITIONS_LAPTOP : ISLAND_POSITIONS_MOBILE;
}

const EMPTY_ITEM = { level: 0, image: null, name: "Empty", score: 0 };

function currentWorldItems() { return ITEMS; }

// Single lookup used everywhere a tile needs its icon/name/score —
// level 0 (empty circle) always resolves to EMPTY_ITEM. Item art is
// shared across every world, so this doesn't depend on currentWorldKey.
function getItem(level) {
  if (level <= 0) return EMPTY_ITEM;
  return ITEMS[level - 1] || EMPTY_ITEM;
}

    // Desktop/laptop widths get 2 extra board columns (7 instead of 5) —
    // rows stay at 5 there. Declared here (not further down, where
    // applyStageAspectRatio() used to be the only thing reading it) so
    // COLS below can use it immediately at page load.
    //
    // Width-only on purpose: this used to also match landscape
    // orientation on coarse-pointer (touch) devices, so a tablet turned
    // sideways got the laptop/desktop side-by-side view instead of the
    // stacked mobile layout. Tablets should look like the phone view
    // (image on top, controls stacked below) at any orientation, so
    // that extra clause is gone — the width check alone now decides,
    // matching the CSS media queries (`(min-width: 1200px)`) further up.
    // Also matches short landscape phones (orientation:landscape AND
    // max-height:600px) so turning a phone sideways switches it into
    // this same desktop/laptop layout — see the matching CSS media
    // query above and its comment for the height-threshold reasoning.
    const DESKTOP_MEDIA_QUERY = window.matchMedia("(min-width: 1200px), (orientation: landscape) and (max-height: 600px)");

    // Board column count specifically: width-only, NOT the same query as
    // DESKTOP_MEDIA_QUERY above. DESKTOP_MEDIA_QUERY also matches short
    // landscape phones (so the side panel/next-box/map art etc. can
    // reuse the desktop-style side-by-side layout there — see its own
    // comment) but a narrow phone turned sideways is still a phone, not
    // a real 1200px+ desktop viewport, so it should keep the same
    // 6-column board mobile portrait uses (bigger cells) rather than
    // desktop's cramped 7 columns squeezed into a much smaller absolute
    // frame. Real desktop/laptop widths are untouched either way.
    const BOARD_COLS_QUERY = window.matchMedia("(min-width: 1200px)");

    // Mobile only: +1 row (added at the TOP — see addStartingTiles()
    // below, which shifts its fixed cluster down/right to match) and +2
    // columns (one added on each side) versus the previous 5x5 mobile
    // board. Desktop/laptop is untouched (still 5 rows x 7 cols).
    const ROWS_DESKTOP = 5;
    const ROWS_MOBILE = 5;
    let ROWS = DESKTOP_MEDIA_QUERY.matches ? ROWS_DESKTOP : ROWS_MOBILE;
    const COLS_MOBILE = 6;
    const COLS_DESKTOP = 7;
    let COLS = BOARD_COLS_QUERY.matches ? COLS_DESKTOP : COLS_MOBILE;


    /* Progress lives in Supabase only (table: garden_saves — see the
       setup notes near GARDEN_TABLE below), not localStorage. Logged-in
       players' cloud row is always the source of truth; guests (no
       account) just play island 1 in memory for the session — see
       syncToCloud()'s currentUser guard and onAuthOrPremiumChange(). */
    let board = createEmptyBoard();
    let nextLevel = 1;
    let score = 0;
    let moves = 0;
    let best = 0;
    let history = [];
    let collection = [];
    // Levels that have actually been CREATED at least once via a real
    // merge (3+ same-level tiles combining), for this world/playthrough.
    // Level 1 is always in here (it's the base tile, never merged into
    // existence). This is what gates randomNextLevel() below — see the
    // comment there for why it's a separate thing from `collection`.
    let unlockedLevels = new Set([1]);
    function resetUnlockedLevels() { unlockedLevels = new Set([1]); }
    let currentWorldKey = WORLD_KEYS[0];


    // Difficulty is a local device preference (not part of the cloud
    // save) — "easy" merges any touching cluster of 3+ regardless of
    // shape (the game's original behavior), "hard" only merges straight
    // three-in-a-rows. See setDifficulty() and findConnectedGroupStraight().
    let difficulty = localStorage.getItem("difficulty") === "hard" ? "hard" : "easy";

    // Map progression state — persisted to Supabase alongside the rest
    // of the save (see currentSaveRow() / loadFromCloud()).
    let clearedWorlds = [];   // world keys that have been "cleared" (see CLEAR_ITEM_LEVEL)
    let mapPage = 1;          // always 1 now — single map image holds all 10 islands (var kept for the cloud row's shape)
    let onMap = true;         // true while the map screen is showing instead of the board
    let justUnlockedKey = null; // world key to pulse on the map right after it unlocks
    let resetBoardOnEnterKey = null; // world key whose board should start empty next time enterWorld() opens it — set by checkWorldClear() right after an island is cleared (5/5) and the next one unlocks
    let isLoadingGarden = false; // true while loadFromCloud() is populating state — guards setWorld() from firing a sync mid-load, see setWorld() below
    let cloudSaveReadyForUser = null; // only this user_id may write to Supabase after cloud load/no-row handling has completed
    let lastKnownClearedWorlds = []; // local safety snapshot so auth-status flickers never erase map progression in memory

    const stageEl = document.getElementById("stage");
    const gameLayoutEl = document.getElementById("gameLayout");
    const stageFrameEl = document.getElementById("stageFrame");
    const boardEl = document.getElementById("board");
    const nextTileEl = document.getElementById("nextTile");
    const scoreStatEl = document.getElementById("scoreStat");
    const movesStatEl = document.getElementById("movesStat");
    const bestStatEl = document.getElementById("bestStat");
    const collectionEl = document.getElementById("collection");
    const toastEl = document.getElementById("toast");
    const modalEl = document.getElementById("gameOverModal");
    const levelRevealEl = document.getElementById("levelReveal");
    const levelRevealIconEl = document.getElementById("levelRevealIcon");
    const levelRevealTextEl = document.getElementById("levelRevealText");
    const levelRevealDoneEl = document.getElementById("levelRevealDone");
    const gameOverTextEl = document.getElementById("gameOverText");
    const worldNameEl = document.getElementById("worldName");
    const worldPickerEl = document.getElementById("worldPicker");
    const mapScreenEl = document.getElementById("mapScreen");
    const mapFrameEl = document.getElementById("mapFrame"); // holds the artwork + island badges — see .map-frame CSS
    const mapAdSlotEl = document.getElementById("mapAdSlot"); // see the reserved-space comment in layoutMapFrame() below
    const mapTitleEl = document.getElementById("mapTitle");
    const mapBrandEl = document.getElementById("mapBrand");
    const sidePanelEl = document.getElementById("sidePanel");
    const homeBtnEl = document.getElementById("homeBtn");
    const nextItemGroupEl = document.getElementById("nextItemGroup");
    const nextItemLabelEl = document.getElementById("nextItemLabel");
    const nextBoxEl = document.getElementById("nextBox");
    const scoreBoxEl = document.getElementById("scoreBox");
    const actionsBoxEl = document.getElementById("actionsBox");
    const authRootEl = document.getElementById("authRoot");
    const topRowEl = document.querySelector(".top-row");
    const stageTitleEl = document.getElementById("stageTitle");
    const brandGameplayEl = document.getElementById("brandGameplay");
    const brandLogoTextEl = document.getElementById("brandLogoText");
    const brandFallbackTextEl = document.getElementById("brandFallbackText");

    // Same tightly-scoped "phone turned sideways" combo used elsewhere
    // (orientation:landscape AND max-height:600px AND max-width:1199px)
    // — matches ONLY short mobile-landscape, never real desktop/laptop
    // (excluded by max-width) and never portrait/tall-landscape mobile
    // (excluded by the other two clauses).
    const MOBILE_LANDSCAPE_QUERY = window.matchMedia("(orientation: landscape) and (max-height: 600px) and (max-width: 1199px)");

    // Same idea as MOBILE_LANDSCAPE_QUERY above, but WITHOUT the
    // max-height:600px restriction — matches a tablet in landscape
    // too (which is too tall to trigger DESKTOP_MEDIA_QUERY/
    // MOBILE_LANDSCAPE_QUERY and so falls into layoutSideExtras()'s
    // "mobile" else-branch below, same as mobile portrait). Used only
    // to decide the next-item badge's placement within that branch,
    // so a tablet turned sideways gets the same bottom-left stage
    // overlay a phone in landscape gets, instead of the portrait-style
    // score-row pill.
    const LANDSCAPE_UNDER_DESKTOP_QUERY = window.matchMedia("(orientation: landscape) and (max-width: 1199px)");

    // Moves just the title wordmark image (+ its text fallback) between
    // its usual home in the side-panel's top-row (next to the world
    // name) and #stageTitle, overlaid on the game-world art's top-left
    // corner — mobile-landscape gameplay only. The world name text
    // itself (#worldName) always stays put in the side panel. Called
    // once at load, on MOBILE_LANDSCAPE_QUERY's "change" event, and
    // from showMap()/hideMap() (since it also depends on onMap). */
    function layoutStageTitle() {
      if (MOBILE_LANDSCAPE_QUERY.matches && !onMap) {
        stageTitleEl.appendChild(brandLogoTextEl);
        stageTitleEl.appendChild(brandFallbackTextEl);
      } else {
        brandGameplayEl.insertBefore(brandFallbackTextEl, worldNameEl);
        brandGameplayEl.insertBefore(brandLogoTextEl, brandFallbackTextEl);
      }
    }

    /* Moves the home-thumb ("back to the map") button and the next-item
       badge between their homes depending on the desktop/mobile
       breakpoint:
       - Desktop/laptop: home-thumb + next-item badge both live in
         #nextBox (see .next-box CSS); login icon stays in .top-row.
       - Mobile: home-thumb + next-item badge live in the score row
         alongside the 3 stats (next-item badge first, home-thumb
         last). The login/account icon now ALWAYS stays put in
         .top-row (its original markup position) on every breakpoint —
         it used to get pulled into #actionsBox on mobile, but
         #actionsBox is a "gameplay-only" box that's display:none while
         the map/start screen is showing (see
         "#gameLayout.on-map .side-panel > *:not(.top-row):not(.map-brand)"),
         so the icon disappeared entirely on the mobile start screen.
         Keeping it in .top-row means it's visible in both the map
         screen (top-right of the icon bar) and during gameplay (top-row
         is reordered to the very top there too).
       Also relocates the big map-screen title image (#mapBrand):
       - Desktop/laptop: unchanged — stays inside .map-screen itself,
         overlaid on top of the map artwork.
       - Mobile: moved into the icon bar itself (.top-row), between the
         "how to play" and login icons, so all three sit on the same row
         (see the max-width:1199px .top-row .map-brand rules) instead of
         the logo getting its own row below the icons.
       Called once at load and again every time DESKTOP_MEDIA_QUERY's
       "change" event fires, so resizing across the breakpoint (or
       rotating a foldable) relocates them immediately. */
    function layoutSideExtras() {
      topRowEl.appendChild(authRootEl);
      if (DESKTOP_MEDIA_QUERY.matches) {
        // homeBtnEl (the "back to start" thumbnail card) is no longer
        // shown on desktop/laptop at all — #homeActionBtn in .actions
        // covers that job there instead (see its own click handler
        // below). It's left in place in #scoreBox (hidden via the
        // ".home-thumb { display:none }" desktop rule) so it's still
        // ready to be used the moment the layout drops back to mobile.
        if (MOBILE_LANDSCAPE_QUERY.matches) {
          // Short mobile-landscape phone: the next-item badge moves
          // into the side panel itself now, inserted directly before
          // #collection so it takes over that prominent slot (with
          // collection demoted to a slim strip right below it) —
          // instead of floating as a bare icon overlay on the board
          // art like it used to. See the matching CSS block
          // (".side-panel .next-item-group ...") a few hundred lines
          // up for the layout that goes with this.
          sidePanelEl.insertBefore(nextItemGroupEl, collectionEl);
          nextItemLabelEl.textContent = "Next item";
        } else {
          nextBoxEl.appendChild(nextItemGroupEl);
          nextItemLabelEl.textContent = "Next item";
        }
        mapScreenEl.insertBefore(mapBrandEl, mapTitleEl);
      } else if (LANDSCAPE_UNDER_DESKTOP_QUERY.matches) {
        // Tablet in landscape (too tall for MOBILE_LANDSCAPE_QUERY to
        // count it as "short", so it lands in this else-branch same as
        // mobile portrait): still landscape though, so match the phone-
        // landscape treatment — next-item badge overlaid bottom-left on
        // the stage — instead of the portrait-style score-row pill.
        stageEl.appendChild(nextItemGroupEl);
        nextItemLabelEl.textContent = "Next";
        scoreBoxEl.appendChild(homeBtnEl);
        topRowEl.insertBefore(mapBrandEl, authRootEl);
      } else {
        // Mobile portrait: next-item badge sits first in the score row
        // (directly under the board image, no longer overlaid on top
        // of it), then the 3 stats, then "Back to start" at the very
        // end — see the max-width:1199px .score rules for the matching
        // 5-column layout.
        scoreBoxEl.insertBefore(nextItemGroupEl, scoreBoxEl.firstChild);
        scoreBoxEl.appendChild(homeBtnEl);
        // Logo goes inside the icon bar, before the login icon — its
        // default flex order (0) naturally lands it between
        // howtoplay-btn's order:-1 and #authRoot's order:1.
        topRowEl.insertBefore(mapBrandEl, authRootEl);
      }
    }
    layoutSideExtras();
    layoutStageTitle();
    MOBILE_LANDSCAPE_QUERY.addEventListener("change", () => {
      layoutStageTitle();
      layoutSideExtras();
    });
    LANDSCAPE_UNDER_DESKTOP_QUERY.addEventListener("change", () => {
      layoutSideExtras();
    });

    const mobileMapRemoveAdsBtnEl = document.getElementById("mobileMapRemoveAdsBtn");
    mobileMapRemoveAdsBtnEl.addEventListener("click", startRemoveAdsPurchase);

    document.getElementById("newBtn").addEventListener("click", newGarden);
    document.getElementById("diffEasyBtn").addEventListener("click", () => { setDifficulty("easy"); showDifficultyRulesToast(); });
    document.getElementById("diffHardBtn").addEventListener("click", () => { setDifficulty("hard"); showDifficultyRulesToast(); });
    setDifficulty(difficulty); // reflect the stored/default preference in the button styling on load — NOT wrapped in showDifficultyRulesToast(), so loading a saved preference stays silent and only an actual tap flashes the toast

    // Mobile-landscape only (see .side-panel .difficulty-rules.show in
    // the CSS, scoped to the same MOBILE_LANDSCAPE_QUERY breakpoint):
    // briefly flashes the illustrated Easy/Hard rule diagram center-
    // screen for 1.5s, then fades it out — same timing/interaction
    // pattern as showToast()'s "Beautiful merge" toast, so it reads as
    // a momentary confirmation rather than a permanent fixture eating
    // side-panel space. Desktop/laptop and mobile-portrait are
    // untouched: the CSS only turns .difficulty-rules into this
    // fixed-position toast within that one media query, so calling
    // this outside it (guarded below) would have nothing to show
    // against anyway.
    let difficultyRulesToastTimer = null;
    function showDifficultyRulesToast() {
      if (!MOBILE_LANDSCAPE_QUERY.matches) return;
      const rulesEl = document.getElementById("difficultyRules");
      if (!rulesEl) return;
      clearTimeout(difficultyRulesToastTimer);
      rulesEl.classList.add("show");
      difficultyRulesToastTimer = setTimeout(() => rulesEl.classList.remove("show"), 1500);
    }
    document.getElementById("againBtn").addEventListener("click", () => { hideModal(); newGarden(); });
    document.getElementById("closeModalBtn").addEventListener("click", hideModal);

    // Mobile "How to play" info icon → modal (see .howtoplay-btn in the
    // CSS/markup). Desktop never shows the icon, so this only ever
    // opens on phones, where the standing side-panel text box is
    // replaced by this popup.
    const howToPlayModalEl = document.getElementById("howToPlayModal");
    document.getElementById("howToPlayBtn").addEventListener("click", () => {
      howToPlayModalEl.classList.add("show");
    });
    // Landscape-mobile's "How to Use" button (icon + label, inline in
    // the side panel) — same modal, see .how-to-play-compact-btn CSS.
    document.getElementById("howToPlayCompactBtn").addEventListener("click", () => {
      howToPlayModalEl.classList.add("show");
    });
    document.getElementById("howToPlayCloseBtn").addEventListener("click", () => {
      howToPlayModalEl.classList.remove("show");
    });
    howToPlayModalEl.addEventListener("click", (e) => {
      if (e.target === howToPlayModalEl) howToPlayModalEl.classList.remove("show");
    });
    document.getElementById("undoBtn").addEventListener("click", undo);
    homeBtnEl.addEventListener("click", () => showMap(null)); // opens the map screen — the only entry point to it now that the separate Map button is gone
    document.getElementById("homeActionBtn").addEventListener("click", () => showMap(null)); // desktop/laptop's "Home" button next to "New" — same destination as homeBtnEl above
    boardEl.addEventListener("click", (e) => {
      const cell = e.target.closest(".cell");
      if (!cell || !boardEl.contains(cell)) return;
      placeTile(Number(cell.dataset.r), Number(cell.dataset.c));
    });
    // Opens the login/sign-up modal directly — #accountBtn is built by
    // auth.js into #authRoot; logged out, a click on it does exactly that.
    function openLoginModal() {
      const accountBtn = document.getElementById("accountBtn");
      if (accountBtn) accountBtn.click();
    }

    // Opens the same login/create-account modal auth.js builds into
    // #authRoot, directly in "create account" mode — for flows (like
    // Remove Ads) that want a logged-out guest to land on account
    // creation rather than sign-in.
    //
    // auth.js already exposes exactly this as a real API:
    // window.openFreeTrialSignup() calls its internal openModal("register"),
    // which shows the modal in register mode. Since this page already
    // sets window.HL_HIDE_TRIAL_UI = true (see near the auth.js <script>
    // tag), auth.js's own mode-label logic (_setAuthMode() in auth.js)
    // shows "Create your account" / "Create Account" here instead of
    // free-trial copy — no extra flag needed on our side.
    function openCreateAccountModal() {
      if (typeof window.openFreeTrialSignup === "function") {
        window.openFreeTrialSignup();
      } else {
        // auth.js didn't load / hasn't defined it yet — fall back to
        // the normal login modal rather than doing nothing.
        console.warn("openCreateAccountModal(): window.openFreeTrialSignup() not found — falling back to openLoginModal().");
        openLoginModal();
      }
    }

    // Sidebar Remove Ads card (map-only, hidden once ads are already
    // gone — see .remove-ads-card CSS / refreshMonetizationUI()). Buy
    // starts the Stripe purchase; the member line opens the login
    // modal for existing Holistic Loader accounts. Neither shows any
    // subscription pricing — that lives only on holisticloader.com.
    document.getElementById("removeAdsBuyBtn").addEventListener("click", startRemoveAdsPurchase);
    document.getElementById("holisticMemberSignInBtn").addEventListener("click", openLoginModal);

    // "Level cleared" / "island locked" / "need an account to buy"
    // nudge for guests — see openGuestUpsellModal() /
    // checkWorldClear() / enterWorld() / startRemoveAdsPurchase()
    // below. Islands and cloud save are free with any account now, so
    // this is just a "create a free account" prompt — no pricing, no
    // trial.
    const guestClearModalEl = document.getElementById("guestClearModal");
    let guestUpsellReason = null; // remembered so the two entry buttons below know which flow they're in
    function closeGuestUpsellModal() {
      guestClearModalEl.classList.remove("show");
      document.body.classList.remove("any-modal-open");
    }
    function openGuestUpsellModal(reason) {
      // "buyAds" is no longer a valid reason here — Remove Ads goes
      // straight to openCreateAccountModal() instead (see
      // startRemoveAdsPurchase()). This modal is island/cloud-save
      // messaging only now.
      guestUpsellReason = reason;
      const kicker = document.getElementById("guestClearKicker");
      const warning = document.getElementById("guestClearWarning");
      if (kicker) {
        kicker.textContent = reason === "locked"
          ? "This island is locked"
          : "Island 1 cleared! 🌱";
      }
      if (warning) {
        warning.textContent = "Heads up — your progress won't be saved unless you log in.";
      }
      guestClearModalEl.classList.add("show");
      document.body.classList.add("any-modal-open");
    }

    /* ---------- Pending purchase intent ----------
       Remembers "the player was trying to buy Remove Ads" across the
       trip through account creation/login, so onAuthOrPremiumChange()
       can resume straight into Stripe Checkout the moment a session
       exists — no second click needed. Uses localStorage (not
       sessionStorage) so it survives an email-confirmation link opening
       in a new tab on the SAME browser; stamped with an expiry so a
       stale intent can never fire a purchase days later. If email
       confirmation opens on a DIFFERENT device, the intent simply won't
       be there and the player just clicks Remove Ads again — acceptable
       for a $2.99 item. */
    const PENDING_INTENT_KEY = "hl_pending_purchase_intent";
    function setPendingPurchaseIntent(intent) {
      localStorage.setItem(PENDING_INTENT_KEY, JSON.stringify({
        intent, expires: Date.now() + 30 * 60 * 1000 // 30 minutes
      }));
    }
    function consumePendingPurchaseIntent() {
      const raw = localStorage.getItem(PENDING_INTENT_KEY);
      localStorage.removeItem(PENDING_INTENT_KEY);
      if (!raw) return null;
      try {
        const { intent, expires } = JSON.parse(raw);
        return (expires > Date.now()) ? intent : null;
      } catch { return null; }
    }

    document.getElementById("guestClearCloseBtn").addEventListener("click", closeGuestUpsellModal);
    document.getElementById("guestClearSignUpBtn").addEventListener("click", () => {
      closeGuestUpsellModal();
      openLoginModal();
    });
    document.getElementById("guestClearLoginBtn").addEventListener("click", () => {
      closeGuestUpsellModal();
      openLoginModal();
    });
    document.getElementById("guestClearLaterBtn").addEventListener("click", closeGuestUpsellModal);
    guestClearModalEl.addEventListener("click", (e) => {
      if (e.target === guestClearModalEl) closeGuestUpsellModal();
    });

    // ---------- Monetization: Remove Ads ($2.99, one-time) ----------
    // The only purchasable offer in the game. A purchase needs an
    // account so it can be recorded server-side (see ad_removals in
    // Supabase) and follow the player across devices/sessions — guests
    // are asked to create an account first via openCreateAccountModal(),
    // not sent straight to Stripe.
    //
    // Calls the create-checkout-session Edge Function to create the
    // Stripe Checkout Session server-side (see supabase/functions/
    // create-checkout-session, confirm-purchase, and
    // stripe-remove-ads-webhook alongside this file) and redirects to
    // the Checkout URL it returns. The Edge Function re-derives the
    // user from their own auth token and independently checks
    // ad_removals before creating a session — the client never claims
    // ownership or constructs a Stripe URL itself.

    async function startRemoveAdsPurchase() {
      if (!currentUser) {
        // Remove Ads needs an account so the purchase can follow the
        // player across devices. After signup/login,
        // onAuthOrPremiumChange() will resume this purchase flow.
        setPendingPurchaseIntent("removeAds");
        openCreateAccountModal();
        return;
      }

      if (window.userAdsRemoved) {
        refreshMonetizationUI();
        return;
      }

      const buyBtn = document.getElementById("removeAdsBuyBtn");
      const mobileBuyBtn = document.getElementById("mobileMapRemoveAdsBtn");

      [buyBtn, mobileBuyBtn].forEach((b) => {
        if (b) b.disabled = true;
      });

      try {
        // sb.functions.invoke() automatically attaches the current
        // user's access token as the Authorization header (same
        // pattern as openBillingPortal() in auth.js). The Edge
        // Function re-derives the user from that token server-side
        // and independently checks ad_removals before creating a
        // session — the client never claims ownership or constructs
        // a Stripe URL itself, and payment_method_types is locked
        // down server-side too.
        const { data, error } = await sb.functions.invoke("create-checkout-session");

        if (error) throw error;
        if (data && data.alreadyOwned) {
          refreshMonetizationUI();
          return;
        }
        if (!data || !data.url) throw new Error("No checkout URL returned");

        window.location.href = data.url;
      } catch (err) {
        console.error("startRemoveAdsPurchase() error:", err);
        showToast("Couldn't start checkout — please try again.");

        [buyBtn, mobileBuyBtn].forEach((b) => {
          if (b) b.disabled = false;
        });
      }
    }

    // Whether the *current* signed-in user has ads_removed=true in
    // Supabase (independent of Holistic Loader Premium, which auth.js
    // already tracks via isPremium). Populated by
    // refreshAdsRemovedStatus() below; adsense.js's canShowAds() reads
    // this same flag off window.
    window.userAdsRemoved = false;

    async function refreshAdsRemovedStatus() {
      if (!currentUser || typeof sb === "undefined") {
        window.userAdsRemoved = false;
        refreshMonetizationUI();
        return;
      }
      // Capture which account this query is for — if the user logs out
      // (or a different account logs in) before Supabase responds, a
      // stale response for the OLD account must NOT overwrite the
      // current (correct) state. Without this guard, logging out while
      // this request is still in flight could leave userAdsRemoved
      // (and the "Premium Active" badge) stuck on from the previous
      // account.
      const requestedUserId = currentUser.id;
      try {
        const { data, error } = await sb
          .from("ad_removals")
          .select("ads_removed")
          .eq("user_id", requestedUserId)
          .maybeSingle();
        if (error) throw error;
        if (!currentUser || currentUser.id !== requestedUserId) return; // stale response — ignore
        window.userAdsRemoved = !!(data && data.ads_removed);
      } catch (err) {
        console.error("refreshAdsRemovedStatus() error:", err);
        if (!currentUser || currentUser.id !== requestedUserId) return; // stale response — ignore
      }
      refreshMonetizationUI();
    }

    // Drives every "ads are gone" UI state in one place: the sidebar
    // Remove Ads card / member line vs. the Premium Active badge (see
    // .ads-removed CSS above), the mobile floating button, and every
    // mounted AdBanner (via canShowAds() picking up window.userAdsRemoved).
    function refreshMonetizationUI() {
      console.log("[HolisticGame] refreshMonetizationUI() build 2026-08-13-guard — currentUser:", !!currentUser, "isPremium:", typeof isPremium !== "undefined" ? isPremium : "(undefined)", "userAdsRemoved:", window.userAdsRemoved);
      // Logged-out players can NEVER show as ads-removed/Premium Active,
      // full stop — regardless of whatever isPremium currently holds.
      // isPremium is a global owned by auth.js and only gets recomputed
      // async (refreshPremiumStatus()); if this function ever runs
      // during a brief window where currentUser has already gone null
      // but isPremium hasn't caught up yet (auth-state flicker — see
      // the "AUTH RESET FIRED" logging in onAuthOrPremiumChange), that
      // stale true must not leak into the UI. This check is the single
      // source of truth for that, independent of fixing the race itself.
      if (!currentUser) {
        window.userAdsRemoved = false;
        gameLayoutEl.classList.remove("ads-removed");
        if (typeof refreshAllAdBanners === "function") refreshAllAdBanners();
        return;
      }
      const adsRemoved = (typeof isPremium !== "undefined" && isPremium) || window.userAdsRemoved === true;
      gameLayoutEl.classList.toggle("ads-removed", adsRemoved);
      if (typeof refreshAllAdBanners === "function") refreshAllAdBanners();
    }

    // If we're back from a Stripe purchase: try the fast synchronous
    // confirm-purchase Edge Function first (works even if the webhook
    // hasn't landed yet, since it verifies the session directly against
    // Stripe). Fall back to a short poll only if that call itself fails
    // — the webhook is still writing ad_removals in the background
    // either way, so this is belt-and-suspenders, not the only path.
    (function checkReturnFromPurchase() {
      const params = new URLSearchParams(window.location.search);
      const purchase = params.get("purchase");
      const sessionId = params.get("session_id");
      if (!purchase) return;

      params.delete("purchase");
      params.delete("session_id");
      const cleanUrl = window.location.pathname + (params.toString() ? "?" + params.toString() : "") + window.location.hash;
      window.history.replaceState({}, "", cleanUrl);

      if (purchase === "cancelled") {
        showToast("Checkout cancelled — no charge was made.");
        return;
      }
      if (purchase !== "success") return;

      (async function confirmAndRefresh() {
        if (sessionId && currentUser) {
          try {
            const { data, error } = await sb.functions.invoke("confirm-purchase", {
              body: { session_id: sessionId }
            });
            if (!error && data && data.adsRemoved) {
              window.userAdsRemoved = true;
              refreshMonetizationUI();
              showToast("Ads removed — thank you!");
              return;
            }
          } catch (err) {
            console.error("confirm-purchase failed, falling back to polling:", err);
          }
        }

        let attempts = 0;
        const poll = setInterval(async () => {
          attempts++;
          await refreshAdsRemovedStatus();
          if (window.userAdsRemoved || attempts >= 6) clearInterval(poll);
        }, 2000);
      })();
    })();

    // ---------- Ads (Google AdSense, see adsense.js) ----------
    // Replace "YOUR_SIDEBAR_SLOT_ID" / "YOUR_MAP_SLOT_ID" with the actual
    // ad unit slot IDs from your AdSense dashboard (Ads -> By ad unit ->
    // create a "Display ad" for each placement). Both slots are map-only
    // in the markup/CSS, so they only ever render on the map/start
    // screen — AdBanner() itself additionally hides them for anyone with
    // Premium OR a completed Remove Ads purchase (see adsense.js).
    if (typeof AdBanner === "function") {
      // No upsellId here anymore — the single "Remove Ads" offer lives
      // only in the .remove-ads-card above (#removeAdsBuyBtn), so the
      // button text/CTA isn't duplicated next to the ad slot too.
      AdBanner("sidebarAdSlot", "YOUR_SIDEBAR_SLOT_ID", "auto");
      // mapAdSlot still holds the TEMPORARY static house-ad picture
      // (see the comment on #mapAdSlot in game.html). Mounting a real
      // AdSense unit into the same box on top of that placeholder
      // creates a second, empty/unfilled <ins> stacked below the
      // picture in the flex column — which is what shows up as a
      // blurry extra box under the landscape ad on mobile. Leave this
      // commented out until "YOUR_MAP_SLOT_ID" is replaced with a
      // real, approved AdSense slot ID AND the static <picture> block
      // is removed from game.html at the same time.
      // AdBanner("mapAdSlot", "YOUR_MAP_SLOT_ID", "auto");
    }

    function createEmptyBoard() {
      return Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 0));
    }

    // Reshapes any board (freshly loaded from the cloud, or already in
    // play) to exactly ROWS x COLS, preserving whatever tiles already
    // line up at the same [r][c] position and padding the rest with
    // empty (0) cells. Needed because COLS differs between mobile (5)
    // and desktop (7) — the SAME cloud save can be opened on either, or
    // the browser window can cross the breakpoint mid-session, so the
    // board array's shape can't be assumed to already match COLS/ROWS.
    // Tiles beyond the new bounds (e.g. columns 6-7 when shrinking from
    // desktop's 7 down to mobile's 5) are dropped — there's no sensible
    // place to move them to without disturbing the rest of the layout.
    function reshapeBoardToDims(source) {
      return Array.from({ length: ROWS }, (_, r) =>
        Array.from({ length: COLS }, (_, c) => (source[r] && source[r][c] !== undefined) ? source[r][c] : 0)
      );
    }

    function cloneBoard(source) { return source.map(row => row.slice()); }

    // Same odds as the original: level 3 only has a shot (7%) once
    // score > 2400; level 2 gets a boosted shot (18%) once score > 900,
    // otherwise it's the "roll >= 0.80" fallback; level 1 is the common
    // case (80% base chance). Level 4 and 5 are never return values here
    // — those can only ever be reached by merging.
    //
    // GATED by unlockedLevels: a level can only ever be handed out as the
    // next item once it has actually been CREATED at least once through a
    // real merge in this world/playthrough — level 2 can't appear until
    // three level-1s have merged into one, level 3 can't appear until
    // three level-2s have merged into one, and so on. Until a level is
    // unlocked, any roll that would have picked it quietly falls back to
    // level 1 instead, so the player is never handed a tile "from the
    // future" that skips the merge chain.
    function randomNextLevel() {
      const roll = Math.random();
      if (score > 2400 && roll < 0.07 && unlockedLevels.has(3)) return 3;
      if (score > 900 && roll < 0.18 && unlockedLevels.has(2)) return 2;
      if (roll < 0.80) return 1;
      return unlockedLevels.has(2) ? 2 : 1;
    }

    // setWorld("underwaterKingdom") / setWorld("dragonsValley") / setWorld("iceCavern")
    // / setWorld("cosmos") — call this from anywhere (auto-progression below,
    // the world-picker dots, or your own console/menu) to swap both the
    // stage backdrop AND every tile's icon set at once.
    function setWorld(key) {
      if (!WORLD_BACKGROUNDS[key]) {
        console.error(`setWorld(): unknown world "${key}" — staying on "${currentWorldKey}"`);
        return;
      }
      currentWorldKey = key;
      stageEl.style.setProperty("--world-bg", `url("${getWorldBackgroundUrl(key)}")`);
      worldNameEl.textContent = WORLD_LABELS[key] || key;
      renderWorldPicker();
      invalidateBoardRenderCache(); // same levels can look different in the new world (WORLD_ITEM_IMAGES) — force a full repaint
      renderBoard();   // existing tiles must switch to the new world's icons immediately
      renderNext();
      renderCollection();
      if (!isLoadingGarden) {
        syncToCloud(false, true);
      }
      applyStageAspectRatio(key);
    }

    /* -----------------------------------------------------------------
       Desktop/laptop only: shape .stage-frame to match each world (or
       map) image's REAL proportions (measured, not guessed), so
       background-size: cover (set globally, see .stage/.map-screen in
       the CSS) fills it with zero cropping and zero letterboxing — the
       frame's aspect ratio and the image's aspect ratio end up
       identical. Mobile is left alone entirely: its own media query
       already forces a square .stage regardless of --stage-ratio (see
       the CSS), so this is a no-op there by design (checked via
       DESKTOP_MEDIA_QUERY below) rather than fighting that layout.

       measureAndApplyRatio() is the shared engine behind both
       applyStageAspectRatio() (world backgrounds) and
       applyMapAspectRatio() (map screens) below — one probe/cache
       implementation instead of two near-duplicates.
    ----------------------------------------------------------------- */
    const ratioCache = {}; // cache key ("world:<key>" / "map:<page>") -> width/height, so re-showing something already measured this session doesn't re-fetch/re-decode its image just to read its size

    function measureAndApplyRatio(cacheKey, url, isStillRelevant) {
      if (!DESKTOP_MEDIA_QUERY.matches) return; // mobile sizes its own stage in CSS (flex-fill, no fixed aspect-ratio) — don't bother measuring
      const cached = ratioCache[cacheKey];
      if (cached) {
        stageFrameEl.style.setProperty("--stage-ratio", cached);
        return;
      }
      if (!url) return;
      const probe = new Image();
      probe.onload = () => {
        if (!probe.naturalWidth || !probe.naturalHeight) return;
        const ratio = probe.naturalWidth / probe.naturalHeight;
        ratioCache[cacheKey] = ratio;
        // Only apply if the thing we measured is still what's showing —
        // the player may have already navigated away before this
        // (possibly slow, uncached) image finished loading.
        if (isStillRelevant()) stageFrameEl.style.setProperty("--stage-ratio", ratio);
      };
      probe.onerror = () => {
        console.warn(`[stage aspect ratio] failed to load: ${url} — keeping current --stage-ratio`);
      };
      probe.src = url;
    }

    function applyStageAspectRatio(key) {
      measureAndApplyRatio(`world:${key}`, getWorldBackgroundUrl(key), () => currentWorldKey === key);
    }

    // Own probe/cache, separate from measureAndApplyRatio() above: that
    // one is desktop-only by design (world board sizing, see its own
    // comment). .map-frame needs its ratio on EVERY window size, mobile
    // included — the mismatch between the two is exactly what let
    // mobile-mode windows pillarbox the map art without anything
    // correcting for it (see .map-frame's CSS comment for the full
    // story). Reuses the same ratioCache map (keys are already
    // namespaced with "map:" so they can't collide with "world:" keys).
    // Own probe/cache, separate from measureAndApplyRatio() above: that
    // one is desktop-only by design (world board sizing, see its own
    // comment). .map-frame needs its ratio on EVERY window size, mobile
    // included — the mismatch between the two is exactly what let
    // mobile-mode windows pillarbox the map art without anything
    // correcting for it (see .map-frame's CSS comment for the full
    // story). Reuses the same ratioCache map (keys are already
    // namespaced with "map:" so they can't collide with "world:" keys).
    //
    // Sizing itself is done by layoutMapFrame() below via explicit
    // pixel width/height, NOT by setting a --map-ratio custom property
    // and leaving a CSS "aspect-ratio + max-width/max-height, both
    // width/height left auto" box to size itself inside a centered
    // grid cell. That CSS-only trick relies on the browser giving an
    // un-stretched, content-less box (no <img>, just a background-
    // image) an intrinsic size from aspect-ratio alone — which isn't
    // guaranteed the way it is for a replaced element like <img>, and
    // in practice collapsed .map-frame to 0×0 here: no artwork showed,
    // and every island badge's %-based left/top resolved against that
    // same zero-size box, stacking all ten badges on the exact same
    // spot (only the last one appended — #10 — was visible, since it
    // painted on top of the identical badges underneath it). Computing
    // the fitted box in JS and setting real px width/height sidesteps
    // that entirely.
    let currentMapRatio = 1;

    // Mobile-landscape ("horizontal") only: also shapes .stage-frame
    // ITSELF to the map artwork's real ratio, the same way
    // measureAndApplyRatio() shapes it to each world's ratio during
    // gameplay. Without this, .stage-frame stays sized to whatever
    // world ratio was last applied, so the map — contain-fit inside
    // that mismatched box by layoutMapFrame() — ends up smaller than
    // the box, letterboxed, instead of matching the game-world art's
    // size and position exactly. Once the box itself matches the
    // map's ratio, that same contain-fit math naturally fills the
    // whole box with zero letterbox, so nothing else needs to change.
    // Desktop/laptop are untouched (real desktop keeps its original
    // contain-fit behaviour).
    function applyMapStageRatio(ratio) {
      if (typeof MOBILE_LANDSCAPE_QUERY !== "undefined" && MOBILE_LANDSCAPE_QUERY.matches) {
        stageFrameEl.style.setProperty("--stage-ratio", ratio);
      }
    }

    function applyMapAspectRatio(page) {
      const info = MAP_PAGES[page];
      if (!info) return;
      const cacheKey = `map:${page}:${DESKTOP_MEDIA_QUERY.matches ? "laptop" : "mobile"}`;
      const isStillRelevant = () => onMap && mapPage === page;

      const cached = ratioCache[cacheKey];
      if (cached) {
        currentMapRatio = cached;
        applyMapStageRatio(cached);
        layoutMapFrame();
        return;
      }
      const url = getMapBackgroundUrl(page);
      if (!url) return;
      const probe = new Image();
      probe.onload = () => {
        if (!probe.naturalWidth || !probe.naturalHeight) return;
        const ratio = probe.naturalWidth / probe.naturalHeight;
        ratioCache[cacheKey] = ratio;
        if (isStillRelevant()) {
          currentMapRatio = ratio;
          applyMapStageRatio(ratio);
          layoutMapFrame();
        }
      };
      probe.onerror = () => {
        console.warn(`[map aspect ratio] failed to load: ${url} — keeping current map frame size`);
      };
      probe.src = url;
    }

    // Fits .map-frame to currentMapRatio inside .map-screen's actual
    // rendered box (the same "contain" math the old background-size:
    // contain used to do for us) and applies it as explicit px width/
    // height — see the comment above applyMapAspectRatio() for why
    // this replaced a CSS-only attempt. Safe to call any time; no-ops
    // if the map isn't showing or hasn't been laid out yet (a
    // subsequent call — on show, resize, or once the ratio arrives —
    // picks it up).
    function layoutMapFrame() {
      if (!onMap) return;
      const boxW = mapScreenEl.clientWidth;
      let boxH = mapScreenEl.clientHeight;
      if (!boxW || !boxH) return;

      // Reserve room for #mapAdSlot when it's stacked below the map
      // artwork in normal document/grid flow (mobile/tablet — see
      // .ad-slot--map's own min-width:1200px override in the CSS,
      // the only place it switches to an absolute overlay ON TOP of
      // the map instead). Without this, the map artwork below was
      // always sized to fill the FULL box height with no idea the ad
      // also needs to fit underneath it in the same box — pushing the
      // ad (and its ✕) below the visible area, reachable only by
      // scrolling, which on a short mobile viewport made the ad look
      // like it had taken over the entire game-map box and made the
      // close button hard to find/tap.
      // Checked via computed position (not a hardcoded breakpoint list)
      // so this stays correct however the ad ends up sized/positioned,
      // and via offsetParent (not a display/visibility check) so a
      // display:none ad (ads-removed, or not yet loaded) never reserves
      // space for nothing.
      if (mapAdSlotEl && mapAdSlotEl.offsetParent !== null) {
        const adStyle = getComputedStyle(mapAdSlotEl);
        if (adStyle.position !== "absolute" && adStyle.position !== "fixed") {
          const adRect = mapAdSlotEl.getBoundingClientRect();
          const adMarginTop = parseFloat(adStyle.marginTop) || 0;
          const adMarginBottom = parseFloat(adStyle.marginBottom) || 0;
          boxH = Math.max(1, boxH - (adRect.height + adMarginTop + adMarginBottom));
        }
      }

      const boxRatio = boxW / boxH;
      let drawW, drawH;
      if (currentMapRatio > boxRatio) {
        drawW = boxW;
        drawH = boxW / currentMapRatio;
      } else {
        drawH = boxH;
        drawW = boxH * currentMapRatio;
      }
      mapFrameEl.style.width = `${drawW}px`;
      mapFrameEl.style.height = `${drawH}px`;
    }

    // .map-screen's own box can change size for reasons that never
    // fire DESKTOP_MEDIA_QUERY's "change" event (an ordinary window
    // resize that stays on the same side of the breakpoint, a
    // fullscreen toggle, etc.) — watch the frame it lives in directly
    // so .map-frame always stays fitted.
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => layoutMapFrame()).observe(stageFrameEl);
    }

    // Toggles .can-scroll on the side panel whenever its content is
    // actually taller than the panel's own (stretched, capped) height —
    // gates the bottom fade-cue in the short-landscape-phone CSS (see
    // the orientation:landscape/max-height:600px query in game.css) so
    // it only appears when there's really something to scroll to.
    // Re-checked on resize/orientation change AND via ResizeObserver on
    // the panel itself, since its content can grow taller later without
    // any resize event firing at all — e.g. once a real ad finishes
    // loading into #sidebarAdSlot and takes up real height instead of
    // the empty placeholder box it starts as.
    function refreshSidePanelScrollability() {
      if (!sidePanelEl) return;
      const scrollable = sidePanelEl.scrollHeight > sidePanelEl.clientHeight + 1;
      sidePanelEl.classList.toggle("can-scroll", scrollable);
    }
    if (sidePanelEl) {
      refreshSidePanelScrollability();
      if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(refreshSidePanelScrollability).observe(sidePanelEl);
      }
      window.addEventListener("resize", refreshSidePanelScrollability);
      window.addEventListener("orientationchange", refreshSidePanelScrollability);
    }

    // Both the mobile (portrait) and laptop (landscape) map images are
    // needed the moment login resolves (the map is the landing screen)
    // and are otherwise only fetched lazily on first display — warm the
    // browser cache for both up front so crossing the mobile/desktop
    // breakpoint (or reloading mid-session) never shows a blank/loading
    // frame.
    function preloadMapImages() {
      [MAP_IMAGE_MOBILE, MAP_IMAGE_LAPTOP].forEach(base => {
        new Image().src = `${base}.${WEBP_SUPPORTED ? "webp" : "jpg"}`;
      });
    }
    preloadMapImages();

    // Crossing the desktop/mobile breakpoint at runtime (resizing a
    // browser window, or rotating/un-rotating a foldable) should apply
    // or clear the measured ratio immediately rather than waiting for
    // the next world switch.
    DESKTOP_MEDIA_QUERY.addEventListener("change", (e) => {
      // mobile/laptop map art swap AND island button positions both
      // depend on this breakpoint — re-render the whole map (not just
      // the background) so the numbered circles jump to their other
      // layout's spots immediately instead of staying put on the new
      // art. Cheap either way: at most 10 buttons.
      if (onMap) {
        renderMap();
        applyMapAspectRatio(mapPage); // mobile/laptop art swapped — re-measure for the newly-shown image
      }
      if (e.matches) {
        if (!onMap) applyStageAspectRatio(currentWorldKey);
      } else {
        stageFrameEl.style.removeProperty("--stage-ratio"); // back to the CSS default (square)
      }
      setColsForBreakpoint(e.matches);
      layoutSideExtras();
    });

    // Keeps the live board array's row/column counts in sync with
    // ROWS/COLS whenever the mobile/desktop breakpoint is crossed
    // (resizing a browser window, rotating/un-rotating a foldable) —
    // not just at page load. Existing tiles are preserved wherever they
    // still fit (see reshapeBoardToDims); a no-op if the breakpoint
    // didn't actually change ROWS/COLS (e.g. only --stage-ratio needed
    // updating). Mobile drops to 4 rows (desktop keeps 5) — see
    // ROWS_MOBILE/ROWS_DESKTOP above.
    // isRowsDesktop drives ROWS only (from DESKTOP_MEDIA_QUERY, which
    // also matches short landscape phones); COLS is decided separately
    // from BOARD_COLS_QUERY (width-only) so those same short landscape
    // phones keep mobile's 6-column board instead of desktop's 7 — see
    // BOARD_COLS_QUERY's comment above.
    function setColsForBreakpoint(isRowsDesktop) {
      const nextCols = BOARD_COLS_QUERY.matches ? COLS_DESKTOP : COLS_MOBILE;
      const nextRows = isRowsDesktop ? ROWS_DESKTOP : ROWS_MOBILE;
      if (nextCols === COLS && nextRows === ROWS) return;
      COLS = nextCols;
      ROWS = nextRows;
      stageFrameEl.style.setProperty("--board-cols", COLS);
      stageFrameEl.style.setProperty("--board-rows", ROWS);
      board = reshapeBoardToDims(board);
      render();
    }

    // Built once (fixed set of dots) instead of torn down and rebuilt
    // on every setWorld() call — after the first render, only the
    // .active class needs to move, which is far cheaper than 20 fresh
    // buttons + 20 fresh listeners every time a world changes.
    // The #worldPicker element itself has been removed from game2.html
    // (it let players jump to ANY world directly, bypassing the map's
    // unlock/progression gate — not wanted here). setWorld() still calls
    // this every time it runs, so this just no-ops safely instead.
    let worldPickerBuilt = false;
    function renderWorldPicker() {
      if (!worldPickerEl) return;
      if (!worldPickerBuilt) {
        worldPickerEl.innerHTML = "";
        WORLD_KEYS.forEach(key => {
          const label = WORLD_LABELS[key] || key;
          const btn = document.createElement("button");
          btn.className = "world-dot";
          btn.title = label;
          btn.setAttribute("aria-label", label);
          btn.dataset.worldKey = key;
          worldPickerEl.appendChild(btn);
        });
        worldPickerEl.addEventListener("click", (e) => {
          const btn = e.target.closest(".world-dot");
          if (btn) {
            // Manually picking a world from these dots always starts a
            // fresh game there (empty board, score/moves/collection
            // reset) — NOT just a visual re-skin of whatever's
            // currently on the board. setWorld() first so newGarden()'s
            // resetSeenLevelIntros()/WORLD_ITEM_IMAGES lookups already
            // see the new world.
            setWorld(btn.dataset.worldKey);
            newGarden();
          }
        });
        worldPickerBuilt = true;
      }
      worldPickerEl.querySelectorAll(".world-dot").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.worldKey === currentWorldKey);
      });
    }

    /* -----------------------------------------------------------------
       MAP SCREEN — see the MAP_PAGES / ISLAND_POSITIONS comment above
       for the data this reads.
    ----------------------------------------------------------------- */
    function isWorldCleared(key) { return clearedWorlds.includes(key); }

    // Island 1 is always free to play, even without an account. Every
    // later island needs (a) the one before it (in MAP_WORLD_KEYS order)
    // cleared, AND (b) an account — logged-out players never unlock
    // island 2+, no matter how many times they clear island 1 in a
    // single session, since guest progress isn't saved anyway.
    function isWorldUnlocked(key) {
      const idx = MAP_WORLD_KEYS.indexOf(key);
      if (idx <= 0) return true;
      if (!currentUser) return false;
      return isWorldCleared(MAP_WORLD_KEYS[idx - 1]);
    }

    function showMap(highlightKey) {
      onMap = true;
      gameLayoutEl.classList.add("on-map");
      layoutStageTitle();
      justUnlockedKey = highlightKey || null;
      renderMap();
      mapScreenEl.classList.add("show");
      layoutMapFrame(); // size .map-frame immediately with whatever ratio is already known, so it's never briefly empty
      applyMapAspectRatio(mapPage);
      if (justUnlockedKey) {
        setTimeout(() => {
          justUnlockedKey = null;
          renderMap();
        }, 3000);
      }
    }

    // Just the background swap (mobile <-> laptop art), without rebuilding
    // the island buttons — used when only the breakpoint changed, not the
    // map's unlock state.
    function updateMapBackground() {
      mapScreenEl.style.setProperty("--map-bg", `url("${getMapBackgroundUrl(mapPage)}")`);
    }

    function hideMap() {
      onMap = false;
      gameLayoutEl.classList.remove("on-map");
      mapScreenEl.classList.remove("show");
      layoutStageTitle();
    }

    function enterWorld(key) {
      if (!isWorldUnlocked(key)) {
        // Guests always hit the account upsell here, since island 2+ is
        // locked for them regardless of clearedWorlds progress.
        if (!currentUser) { openGuestUpsellModal("locked"); return; }
        showToast("Clear the island before this one first");
        return;
      }
      hideMap();
      // Every time a world is opened — including re-entering the world
      // that's already showing — start it with a clean, empty board
      // instead of carrying over whatever tiles were left on it (they'd
      // otherwise stay on the board, or get re-painted with the new
      // world's art if the world actually changed — see the "old tiles
      // survive the new world in the new world's skin" bug, and the
      // separate "re-opening the same world keeps the old garden" bug).
      // This does NOT touch clearedWorlds, so progress/unlocks are unaffected.
      resetBoardOnEnterKey = null;
      board = createEmptyBoard();
      history = [];
      collection = [];
      resetUnlockedLevels();
      addStartingTiles();
      nextLevel = 1; // guaranteed level 1 for the first tile of a new world
      resetSeenLevelIntros(key); // fresh play-through of this world — level reveals should replay
      seenLevelIntros[key].add(1); // level 1 is guaranteed as the first tile — mark it seen right away
      collection.push(1); // ...and give it its collection icon immediately, so order tracking starts at 1
      setWorld(key); // already flushes an immediate sync internally
      render();
    }

    function renderMap() {
      const page = MAP_PAGES[mapPage] || MAP_PAGES[1];
      updateMapBackground();
      mapTitleEl.textContent = "Choose an island";

      // Re-render every button (cheap: at most 10) rather than diffing —
      // this only runs when the map is opened, an island is cleared, or
      // the 3s "just unlocked" pulse expires.
      mapFrameEl.querySelectorAll(".island-btn").forEach(el => el.remove());

      page.keys.forEach((key, i) => {
        const islandNumber = page.offset + i + 1;
        const pos = getIslandPositions()[islandNumber];
        if (!pos) return;
        const unlocked = isWorldUnlocked(key);
        const cleared = isWorldCleared(key);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "island-btn"
          + (unlocked ? "" : " locked")
          + (cleared ? " cleared" : "")
          + (key === justUnlockedKey ? " just-unlocked" : "");
        btn.style.left = `${pos.x}%`;
        btn.style.top = `${pos.y}%`;
        btn.textContent = String(islandNumber);
        btn.setAttribute("aria-label", `${WORLD_LABELS[key] || key} — island ${islandNumber}${cleared ? ", cleared" : unlocked ? "" : ", locked"}`);
        btn.dataset.worldKey = key; // read by the single delegated listener below, added once
        mapFrameEl.appendChild(btn);
      });
    }

    mapScreenEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".island-btn");
      if (!btn) return;
      enterWorld(btn.dataset.worldKey);
    });

    // Called from placeTile() right after a merge. If the item just
    // created is the "clear" tier (CLEAR_ITEM_LEVEL) and this world
    // hasn't been marked cleared yet, mark it, unlock the next island,
    // and drop the player back on the map with the new island pulsing.
    function checkWorldClear(createdLevel) {
      if (createdLevel < CLEAR_ITEM_LEVEL) return false;
      if (!MAP_WORLD_KEYS.includes(currentWorldKey)) return false;
      if (isWorldCleared(currentWorldKey)) return false;

      clearedWorlds = Array.from(new Set([...(Array.isArray(clearedWorlds) ? clearedWorlds : []), currentWorldKey]));
      lastKnownClearedWorlds = clearedWorlds.slice();
      playWorldClearFanfare();
      const idx = MAP_WORLD_KEYS.indexOf(currentWorldKey);
      const nextKey = MAP_WORLD_KEYS[idx + 1] || null;

      if (!currentUser) {
        // Guests can clear island 1, but island 2 stays locked until
        // they have an account — surface the upsell instead of
        // pretending the next island just opened.
        showToast("Island cleared!");
        setTimeout(() => { showMap(null); openGuestUpsellModal("cleared"); }, 1100);
        return true;
      }

      showToast(nextKey ? "Island cleared! A new one has opened" : "Island cleared!");
      resetBoardOnEnterKey = nextKey; // next island starts on a fresh board — see enterWorld()
      syncToCloud(false, true);
      setTimeout(() => showMap(nextKey), 1100);
      return true;
    }

    // Resets local board state only — does NOT touch clearedWorlds and does
    // NOT sync to the cloud. Used when we can't be sure it's safe to write
    // (see loadFromCloud()'s no-data/error paths below) — a genuine new
    // player still gets saved the moment they place their first tile, via
    // the debounced syncToCloud(false) in placeTile().
    function resetGardenStateLocally() {
      board = createEmptyBoard();
      score = 0;
      moves = 0;
      history = [];
      collection = [];
      resetUnlockedLevels();
      nextLevel = 1;
      addStartingTiles();
      resetSeenLevelIntros(currentWorldKey); // fresh play-through of this world — level reveals should replay
      seenLevelIntros[currentWorldKey].add(1); // level 1 is guaranteed as the first tile — mark it seen right away
      collection.push(1); // ...and give it its collection icon immediately, so order tracking starts at 1
      render();
    }

    // User-facing "start over" action (Again button, explicit new-garden
    // flows) — resets local state AND immediately writes it to the cloud.
    // Do NOT call this from loadFromCloud()'s failure paths — see
    // resetGardenStateLocally() above.
    function newGarden() {
      resetGardenStateLocally();
      showToast("New garden planted");
      syncToCloud(false, true);
    }

    function addStartingTiles() {
      // Board now starts completely empty — no pre-placed tiles.
      // (Was a 3-tile starter cluster; left as a documented no-op,
      // rather than removing every call site, so newGarden()/initial
      // load/etc. don't need to change.)
    }

    function saveHistory() {
      history.push({ board: cloneBoard(board), nextLevel, score, moves, collection: collection.slice(), unlockedLevels: new Set(unlockedLevels) });
      if (history.length > 20) history.shift();
    }

    function undo() {
      const previous = history.pop();
      if (!previous) { showToast("Nothing to undo"); return; }
      board = cloneBoard(previous.board);
      nextLevel = previous.nextLevel;
      score = previous.score;
      moves = previous.moves;
      collection = previous.collection.slice();
      // Fall back to just [1] for history entries saved before this field
      // existed (older in-memory history from the same session).
      unlockedLevels = previous.unlockedLevels ? new Set(previous.unlockedLevels) : new Set([1]);
      render();
      showToast("One step back");
      syncToCloud(false, true);
    }

    /* -----------------------------------------------------------------
       CLOUD SAVE — Supabase, same pattern as nutriloader.html's food
       log (auth.js provides the shared `sb` client and `currentUser`).
       Unlike the food log, there's no localStorage fallback here:
       playing this game requires being logged in, so the cloud row is
       always the only copy — one row per account, upserted on every
       move.

       IMPORTANT — this is a STANDALONE game sharing the same Supabase
       project (and the same logged-in accounts) as the original 20-world
       game. It intentionally uses its OWN table (garden_saves_game2, not
       garden_saves) so a returning player's save here never gets mixed
       up with — or overwritten by — their save in the original game.
       Using the same table name as the original would make a logged-in
       player's board come back full of tiles from the OTHER game the
       moment they enter a world here.

       REQUIRED ONE-TIME SUPABASE SETUP (run once in the SQL Editor,
       same project as auth.js's `profiles`/`log_entries` tables):

         create table public.garden_saves_game2 (
           user_id       uuid primary key references auth.users(id) on delete cascade,
           board         jsonb not null default '[]',
           next_level    int not null default 1,
           score         int not null default 0,
           moves         int not null default 0,
           collection    jsonb not null default '[]',
           current_world text not null default 'iceCavern',
           best          int not null default 0,
           cleared_worlds jsonb not null default '[]',
           map_page      int not null default 1,
           updated_at    timestamptz not null default now()
         );

         alter table public.garden_saves_game2 enable row level security;

         create policy "Users can view their own garden"
         on public.garden_saves_game2 for select
         to authenticated
         using (auth.uid() = user_id);

         create policy "Users can insert their own garden"
         on public.garden_saves_game2 for insert
         to authenticated
         with check (auth.uid() = user_id);

         create policy "Users can update their own garden"
         on public.garden_saves_game2 for update
         to authenticated
         using (auth.uid() = user_id)
         with check (auth.uid() = user_id);
    ----------------------------------------------------------------- */
    const GARDEN_TABLE = "garden_saves_game2";

    function currentSaveRow() {
      return {
        user_id: currentUser.id,
        board,
        next_level: nextLevel,
        score,
        moves,
        collection,
        current_world: currentWorldKey,
        best,
        cleared_worlds: Array.isArray(clearedWorlds) ? clearedWorlds.slice() : [],
        map_page: mapPage,
        unlocked_levels: Array.from(unlockedLevels),
        updated_at: new Date().toISOString()
      };
    }

    // Debounced so a burst of rapid moves (placing several tiles in a
    // row) collapses into ONE upsert instead of one per move — this is
    // the single biggest network-cost cut in the file, since placeTile()
    // used to fire a Supabase write on every tap. syncToCloud(show) still
    // schedules a write within SYNC_DEBOUNCE_MS; pass immediate=true for
    // writes that must land right away (explicit Save, clearing an
    // island, switching/leaving a world) rather than get coalesced.
const SYNC_DEBOUNCE_MS = 900;
let syncTimer = null;
let syncPendingFeedback = false;

let saveCounter = 0; // TEMP DEBUG

async function performSync(showFeedback) {
  if (!currentUser || typeof sb === "undefined") return;
  if (isLoadingGarden || cloudSaveReadyForUser !== currentUser.id) {
    console.warn("syncToCloud() skipped: garden is not ready for cloud writes yet", {
      user: currentUser && currentUser.id,
      cloudSaveReadyForUser,
      isLoadingGarden
    });
    return;
  }
  try {
    saveCounter++;
    const row = currentSaveRow();
    console.log(
      `SAVE #${saveCounter}`,
      "cleared_worlds:",
      JSON.stringify(row.cleared_worlds),
      "updated_at:",
      row.updated_at
    );
    const { error } = await sb
      .from(GARDEN_TABLE)
      .upsert(row, { onConflict: "user_id" });
    if (error) throw error;
    if (Array.isArray(row.cleared_worlds)) {
      lastKnownClearedWorlds = row.cleared_worlds.slice();
    }
    if (showFeedback) {
      showToast("Garden saved");
    }
  } catch (err) {
    console.error("syncToCloud() error:", err);
    if (showFeedback) {
      showToast("Could not save — try again");
    }
  }
}
    function syncToCloud(showFeedback, immediate) {
      if (!currentUser || typeof sb === "undefined") return;
      syncPendingFeedback = syncPendingFeedback || !!showFeedback;
      if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
      if (immediate) {
        const feedback = syncPendingFeedback;
        syncPendingFeedback = false;
        performSync(feedback);
        return;
      }
      syncTimer = setTimeout(() => {
        syncTimer = null;
        const feedback = syncPendingFeedback;
        syncPendingFeedback = false;
        performSync(feedback);
      }, SYNC_DEBOUNCE_MS);
    }

    // A debounced write can still be sitting in the timer when the tab is
    // closed or backgrounded — flush it immediately in either case so the
    // last move or two are never silently lost.
    function flushPendingSync() {
      if (!syncTimer) return;
      clearTimeout(syncTimer);
      syncTimer = null;
      const feedback = syncPendingFeedback;
      syncPendingFeedback = false;
      performSync(feedback);
    }
    document.addEventListener("visibilitychange", () => { if (document.hidden) flushPendingSync(); });
    window.addEventListener("pagehide", flushPendingSync);

    async function loadFromCloud() {
      isLoadingGarden = true;
      if (!currentUser || typeof sb === "undefined") {
        isLoadingGarden = false;
        cloudSaveReadyForUser = null;
        resetGardenStateLocally();
        return;
      }
      try {
        const { data, error } = await sb
          .from(GARDEN_TABLE)
          .select("*")
          .eq("user_id", currentUser.id)
          .maybeSingle();
        if (error) throw error;

        if (data) {
          board = reshapeBoardToDims(data.board || createEmptyBoard());
          nextLevel = data.next_level || 1;
          score = data.score || 0;
          moves = data.moves || 0;
          collection = data.collection || [];
          // Older rows saved before this column existed have no
          // unlocked_levels — default to just [1] rather than assuming
          // every level is unlocked, so the merge-gate applies to
          // existing players' saves too (a returning player whose board
          // still has level-2+ tiles sitting on it isn't blocked from
          // playing; they just won't get MORE of that level as a "next"
          // tile until they merge one again in this state).
          unlockedLevels = new Set(Array.isArray(data.unlocked_levels) && data.unlocked_levels.length ? data.unlocked_levels : [1]);
          currentWorldKey = (typeof data.current_world === "string" && WORLD_BACKGROUNDS[data.current_world]) ? data.current_world : WORLD_KEYS[0];
          best = typeof data.best === "number" ? data.best : 0;
          clearedWorlds = Array.isArray(data.cleared_worlds) ? data.cleared_worlds.slice() : [];
          lastKnownClearedWorlds = clearedWorlds.slice();
          cloudSaveReadyForUser = currentUser.id;
          mapPage = 1; // only one map page now (all 10 islands on one image) — kept as a var for the cloud row's shape
          history = [];
          setWorld(currentWorldKey);
          isLoadingGarden = false;
          bestStatEl.textContent = formatNumber(best);
          render();
          showMap(null); // land on the map first every time the garden loads
          showToast("Garden restored");
        } else {
          // No row found for this user. This SHOULD only mean "first time
          // this account plays" — but if it fires for a returning player
          // (e.g. an RLS/session-timing hiccup on this query), calling the
          // cloud-writing newGarden() here would silently wipe their real
          // saved progress. Use the local-only reset instead: a genuine
          // new player still gets saved on their first move (see
          // resetGardenStateLocally()'s comment above).
          console.warn("loadFromCloud(): no row found for user", currentUser.id, "— starting local-only fresh garden (not synced yet)"); // TEMP DEBUG
          cloudSaveReadyForUser = currentUser.id;
          isLoadingGarden = false;
          resetGardenStateLocally();
          showMap(null);
        }
      } catch (err) {
        console.error("loadFromCloud() error:", err);
        showToast("Could not load your garden");
        cloudSaveReadyForUser = null;
        isLoadingGarden = false;
        // Deliberately NOT calling newGarden() here — a transient load
        // failure must never overwrite the real cloud save with a blank
        // one. Keep the last known map progression in memory too; a
        // later successful load will replace it with the real cloud data.
        if (Array.isArray(lastKnownClearedWorlds)) {
          clearedWorlds = lastKnownClearedWorlds.slice();
        }
        resetGardenStateLocally();
      }
    }

    function placeTile(r, c) {
      if (board[r][c] !== 0) return;
      saveHistory();
      board[r][c] = nextLevel;
      moves++;
      const createdLevels = resolveMerges(r, c); // every level created this move, in ascending order (a single move can cascade through several)
      const createdLevel = createdLevels.length ? Math.max(...createdLevels) : 0;
      // First-time-ever reaching a given level (2 through the top level)
      // this playthrough — drives the big celebratory reveal AND which
      // icons land in the collection strip. Computed once here (instead
      // of once per merge) so each level gets exactly one collection icon
      // per playthrough, not a duplicate every time it's merged again.
      //
      // IMPORTANT: randomNextLevel() can hand out a level-2 (or level-3)
      // tile directly, with no merge involved. If we only looked at
      // createdLevels here, a directly-spawned level-2 tile would never
      // get marked as "reached" until it was later merged — so a player
      // could merge their way to level 3 (a real createdLevels entry)
      // before level 2 ever got registered, and the collection strip
      // would show 3 landing before 2. registerLevelsReached() folds in
      // the level of the tile that was just placed, and backfills any
      // skipped intermediate levels, so the strip always fills in strict
      // ascending/chronological order.
      const touchedLevels = [nextLevel, ...createdLevels].filter(level => level >= 2);
      const newlyReachedLevels = registerLevelsReached(touchedLevels);
      newlyReachedLevels.forEach(level => collection.push(level));
      nextLevel = randomNextLevel();
      updateBest();
      const clearedThisMove = checkWorldClear(createdLevel);
      render();
      if (createdLevel >= 5) showToast(`${getItem(5).name} awakened`);
      else if (createdLevel > 0) showToast("Beautiful merge");
      if (newlyReachedLevels.length) queueLevelReveals(newlyReachedLevels);
      if (isFull()) showGameOver();
      // A world-clear already forced an immediate save above. Avoid a second
      // delayed save from the same move, because auth/premium listeners can
      // briefly reset local state before the debounce fires.
      if (!clearedThisMove) syncToCloud(false);
    }

    function resolveMerges(startR, startC) {
      let currentR = startR;
      let currentC = startC;
      const createdLevels = [];
      let keepMerging = true;
      while (keepMerging) {
        keepMerging = false;
        const level = board[currentR][currentC];
        if (level <= 0 || level >= currentWorldItems().length) break; // already at this world's max level
        const group = difficulty === "hard"
          ? findConnectedGroupStraight(currentR, currentC, level)
          : findConnectedGroup(currentR, currentC, level);
        if (group.length >= 3) {
          group.forEach(pos => { board[pos.r][pos.c] = 0; });
          board[currentR][currentC] = level + 1;
          const createdItem = getItem(level + 1);
          score += createdItem.score * group.length;
          createdLevels.push(level + 1);
          unlockedLevels.add(level + 1); // this level has now genuinely been merged into existence — randomNextLevel() may offer it from here on
          spawnBurst(currentR, currentC, getItemImageUrl(createdItem));
          playMergeGong();
          keepMerging = true;
        }
      }
      return createdLevels;
    }

    /* -----------------------------------------------------------------
       First-time level-reveal celebration — "seenLevelIntros" tracks,
       per world AND per play-through, which levels have already gotten
       the big centered reveal so it only plays the first time each one
       is reached *this* game round in *that* world. It is intentionally
       NOT persisted to localStorage/cloud: starting a new game, or
       opening a world with a fresh board (including one you've already
       completed before), resets that world's set — see the
       resetSeenLevelIntros() calls in newGarden() and enterWorld() —
       so the reveal happens again every time it's genuinely the first
       time this playthrough, not just the first time ever on this
       device.
    ----------------------------------------------------------------- */
    let seenLevelIntros = {}; // { [worldKey]: Set<level> }

    function resetSeenLevelIntros(worldKey) {
      seenLevelIntros[worldKey] = new Set();
    }

    function markLevelFirstSeen(level) {
      const set = seenLevelIntros[currentWorldKey] || (seenLevelIntros[currentWorldKey] = new Set());
      if (set.has(level)) return false;
      set.add(level);
      return true;
    }

    // Given the levels touched by a single move (the placed tile's level
    // plus any levels produced by merging), mark every not-yet-seen level
    // from 2 up through the highest one touched as "reached" — backfilling
    // any that got skipped (e.g. a level-2 tile was spawned directly and
    // never merged, or level 3 was reached by merging spawned level-2
    // tiles before a "real" level-2 merge ever happened). This guarantees
    // the collection strip / reveal queue always receives levels in
    // strict ascending order, so a higher level can never land before a
    // lower one.
    function registerLevelsReached(levels) {
      if (!levels.length) return [];
      const maxLevel = Math.max(...levels);
      const newlyReached = [];
      for (let lvl = 2; lvl <= maxLevel; lvl++) {
        if (markLevelFirstSeen(lvl)) newlyReached.push(lvl);
      }
      return newlyReached;
    }

    const LEVEL_REVEAL_HOLD_MS = 1500; // how long the big icon stays centered before flying down
    const LEVEL_REVEAL_FLY_MS = 650;   // duration of the fly-down-to-collection animation
    let levelRevealQueue = [];
    let levelRevealBusy = false;

    function queueLevelReveals(levels) {
      levelRevealQueue.push(...levels);
      processLevelRevealQueue();
    }

    function processLevelRevealQueue() {
      if (levelRevealBusy || !levelRevealQueue.length) return;
      levelRevealBusy = true;
      const level = levelRevealQueue.shift();
      showLevelReveal(level, () => {
        levelRevealBusy = false;
        processLevelRevealQueue();
      });
    }

    function showLevelReveal(level, onDone) {
      const item = getItem(level);
      const total = currentWorldItems().length;

      levelRevealIconEl.removeAttribute("style");
      levelRevealIconEl.classList.remove("pop");
      levelRevealIconEl.innerHTML = "";
      const img = document.createElement("img");
      img.src = getItemImageUrl(item);
      img.alt = item.name;
      img.draggable = false;
      img.decoding = "async";
      levelRevealIconEl.appendChild(img);

      levelRevealTextEl.textContent = `${level}/${total}`;
      levelRevealTextEl.style.opacity = "1";
      levelRevealDoneEl.style.opacity = "1";
      levelRevealEl.classList.toggle("well-done", level >= total);
      levelRevealEl.classList.add("show");
      // Restart the pop-in animation.
      void levelRevealIconEl.offsetWidth;
      levelRevealIconEl.classList.add("pop");

      setTimeout(() => {
        const startRect = levelRevealIconEl.getBoundingClientRect();
        const targetRect = collectionEl.getBoundingClientRect();
        const startX = startRect.left + startRect.width / 2;
        const startY = startRect.top + startRect.height / 2;
        const targetX = targetRect.left + targetRect.width / 2;
        const targetY = targetRect.top + targetRect.height / 2;
        const dx = targetX - startX;
        const dy = targetY - startY;

        levelRevealTextEl.style.opacity = "0";
        levelRevealDoneEl.style.opacity = "0";

        levelRevealIconEl.classList.remove("pop");
        levelRevealIconEl.style.position = "fixed";
        levelRevealIconEl.style.left = `${startX}px`;
        levelRevealIconEl.style.top = `${startY}px`;
        levelRevealIconEl.style.width = `${startRect.width}px`;
        levelRevealIconEl.style.height = `${startRect.height}px`;
        levelRevealIconEl.style.margin = "0";
        levelRevealIconEl.style.transform = "translate(-50%, -50%) scale(1)";
        levelRevealIconEl.style.opacity = "1";
        void levelRevealIconEl.offsetWidth; // force reflow so the transition below actually animates
        levelRevealIconEl.style.transition = `transform ${LEVEL_REVEAL_FLY_MS}ms cubic-bezier(.4,0,.7,1), opacity ${LEVEL_REVEAL_FLY_MS}ms ease`;
        levelRevealIconEl.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.2)`;
        levelRevealIconEl.style.opacity = "0.15";

        setTimeout(() => {
          levelRevealEl.classList.remove("show", "well-done");
          levelRevealIconEl.removeAttribute("style");
          levelRevealIconEl.classList.remove("pop");
          levelRevealIconEl.innerHTML = "";
          if (typeof onDone === "function") onDone();
        }, LEVEL_REVEAL_FLY_MS);
      }, LEVEL_REVEAL_HOLD_MS);
    }

    function findConnectedGroup(r, c, level) {
      const visited = new Set();
      const result = [];
      const queue = [{ r, c }];
      while (queue.length) {
        const pos = queue.shift();
        const cellKey = `${pos.r},${pos.c}`;
        if (visited.has(cellKey)) continue;
        visited.add(cellKey);
        if (!inBounds(pos.r, pos.c)) continue;
        if (board[pos.r][pos.c] !== level) continue;
        result.push(pos);
        getNeighbors(pos.r, pos.c).forEach(next => { if (!visited.has(`${next.r},${next.c}`)) queue.push(next); });
      }
      return result;
    }

    function getNeighbors(r, c) {
      return [{ r: r - 1, c }, { r: r + 1, c }, { r, c: c - 1 }, { r, c: c + 1 }].filter(pos => inBounds(pos.r, pos.c));
    }

    // "Hard" mode's match-finder — unlike findConnectedGroup() (any
    // touching blob of 3+, straight or angled), this only counts a
    // straight run of 3+ matching tiles through (r,c): it walks left/
    // right for the horizontal run and up/down for the vertical run
    // and only keeps whichever run(s) are actually >=3 long. A pure
    // L-shape/angle (2 horizontal + 2 vertical, neither reaching 3 on
    // its own) returns an empty array, so it does NOT merge. A T/plus
    // shape that has a genuine 3+ run in both directions merges both
    // runs together in one go.
    function findConnectedGroupStraight(r, c, level) {
      const horizontal = [{ r, c }];
      for (let cc = c - 1; cc >= 0 && board[r][cc] === level; cc--) horizontal.unshift({ r, c: cc });
      for (let cc = c + 1; cc < COLS && board[r][cc] === level; cc++) horizontal.push({ r, c: cc });

      const vertical = [{ r, c }];
      for (let rr = r - 1; rr >= 0 && board[rr][c] === level; rr--) vertical.unshift({ r: rr, c });
      for (let rr = r + 1; rr < ROWS && board[rr][c] === level; rr++) vertical.push({ r: rr, c });

      const result = [];
      const seen = new Set();
      const addRun = (run) => {
        if (run.length < 3) return;
        run.forEach(pos => {
          const key = `${pos.r},${pos.c}`;
          if (!seen.has(key)) { seen.add(key); result.push(pos); }
        });
      };
      addRun(horizontal);
      addRun(vertical);
      return result;
    }

    // Switches between "easy" (any touching 3+, straight or angled)
    // and "hard" (straight three-in-a-rows only) and remembers the
    // choice locally for next time. Doesn't touch the board — it only
    // changes how the NEXT placed tile resolves merges.
    function setDifficulty(mode) {
      difficulty = mode === "hard" ? "hard" : "easy";
      localStorage.setItem("difficulty", difficulty);
      const easyBtn = document.getElementById("diffEasyBtn");
      const hardBtn = document.getElementById("diffHardBtn");
      if (easyBtn && hardBtn) {
        easyBtn.classList.toggle("secondary", difficulty !== "easy");
        hardBtn.classList.toggle("secondary", difficulty !== "hard");
        easyBtn.setAttribute("aria-pressed", String(difficulty === "easy"));
        hardBtn.setAttribute("aria-pressed", String(difficulty === "hard"));
      }
      // Shows only the matching illustrated rule group below the
      // buttons (see .diff-rule-group[data-rule] in the CSS) — laptop/
      // desktop and mobile-landscape only; mobile-portrait hides
      // #difficultyRules entirely regardless, so this class has no
      // visible effect there.
      const rulesEl = document.getElementById("difficultyRules");
      if (rulesEl) {
        rulesEl.classList.toggle("mode-easy", difficulty === "easy");
        rulesEl.classList.toggle("mode-hard", difficulty === "hard");
      }
    }

    function inBounds(r, c) { return r >= 0 && c >= 0 && r < ROWS && c < COLS; }
    function isFull() { return board.every(row => row.every(cell => cell !== 0)); }

    function updateBest() {
      if (score > best) {
        best = score;
      }
    }

    // No longer called from placeTile() — islands 1-10 now unlock via
    // checkWorldClear() (map progress) instead of a score threshold.
    // Left here in case you want a score-based fallback for worlds
    // beyond island 10 (11-20), which don't have map art yet.
    function autoUnlockWorld() {
      const targetIndex = Math.min(WORLD_KEYS.length - 1, Math.floor(score / 2500));
      const targetKey = WORLD_KEYS[targetIndex];
      if (WORLD_KEYS.indexOf(targetKey) > WORLD_KEYS.indexOf(currentWorldKey)) setWorld(targetKey);
    }

    function render() { renderBoard(); renderStats(); renderNext(); renderCollection(); }

    // Small helper so every icon spot (board tile / next-up / collection /
    // merge burst) creates the same kind of <img class="item-icon"> element.
    function createItemIcon(item, extraClass) {
      const img = document.createElement("img");
      img.className = extraClass ? `item-icon ${extraClass}` : "item-icon";
      img.src = getItemImageUrl(item);
      img.alt = item.name;
      img.draggable = false;
      // decoding="async" lets the browser decode off the main thread instead
      // of blocking a paint on it — matters most on lower-powered mobile
      // devices where several tiles can render/re-render in the same frame
      // (e.g. after a merge). loading="eager" is explicit (not the default
      // "lazy") because every tile here is already inside the visible board.
      img.decoding = "async";
      img.loading = "eager";
      // If an icon file 404s / fails to load, the browser's default
      // fallback (a broken-image glyph plus the alt text rendered at
      // full font size) can overflow way outside its circle and make
      // the whole board look broken. Swap in a small "?" badge instead
      // — contained, and still visible enough to tell you *something*
      // is missing (check the console for exactly which file failed).
      img.addEventListener("error", () => {
        console.warn(`[item icon] failed to load: ${img.src}`);
        img.style.display = "none";
        const fallback = document.createElement("span");
        fallback.className = "icon-fallback";
        fallback.textContent = "?";
        fallback.setAttribute("aria-hidden", "true");
        img.insertAdjacentElement("afterend", fallback);
      }, { once: true });
      return img;
    }

    // renderBoard() used to wipe #board with innerHTML="" and rebuild
    // every single cell/tile/icon from scratch on every call — and it's
    // called after every tap (via render(), from placeTile()). For a
    // 25-42 cell board that meant destroying and recreating dozens of
    // DOM nodes (several of them <img>, forcing a fresh decode each
    // time) even for the ~24-41 cells that didn't change on that move.
    // Now the grid of <button class="cell"> elements is built ONCE and
    // reused; each render only touches the cells whose level actually
    // changed since the last render, tracked in lastRenderedLevels.
    // A full rebuild still happens automatically whenever ROWS/COLS
    // themselves change (crossing the desktop/mobile breakpoint), since
    // that's the one case the cached grid no longer matches.
    let boardCellEls = null;       // ROWS x COLS grid of <button class="cell"> elements, reused across renders
    let lastRenderedLevels = null; // ROWS x COLS grid of the level last painted into each cell

    function paintCell(cell, level) {
      const item = getItem(level);
      cell.className = "cell" + (level === 0 ? " empty" : "");
      cell.setAttribute("aria-label", level === 0 ? "Empty planting circle" : item.name);
      cell.innerHTML = "";
      if (level > 0) {
        const tile = document.createElement("span");
        tile.className = `tile level-${level}`;
        tile.appendChild(createItemIcon(item));
        cell.appendChild(tile);
      }
    }

    function renderBoard() {
      const dimsMatch = boardCellEls && boardCellEls.length === ROWS && boardCellEls[0] && boardCellEls[0].length === COLS;
      if (!dimsMatch) {
        boardEl.innerHTML = "";
        boardCellEls = [];
        for (let r = 0; r < ROWS; r++) {
          const cellRow = [];
          for (let c = 0; c < COLS; c++) {
            const cell = document.createElement("button");
            cell.type = "button";
            // Position stored as data-attributes and read by a single
            // delegated listener on #board (added once, outside this
            // function) — now set just once per cell (at creation)
            // instead of on every render, since the cell element itself
            // persists across renders.
            cell.dataset.r = r;
            cell.dataset.c = c;
            boardEl.appendChild(cell);
            cellRow.push(cell);
          }
          boardCellEls.push(cellRow);
        }
        lastRenderedLevels = null; // grid was rebuilt from scratch — repaint every cell below too
      }
      if (!lastRenderedLevels) {
        lastRenderedLevels = boardCellEls.map(row => row.map(() => undefined));
      }
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const level = board[r][c];
          if (lastRenderedLevels[r][c] === level) continue; // nothing changed in this circle — leave its DOM alone
          lastRenderedLevels[r][c] = level;
          paintCell(boardCellEls[r][c], level);
        }
      }
    }

    // Call before renderBoard() whenever something OTHER than the `board`
    // array itself changes what a given level should look like — right
    // now that's just switching worlds (each world reuses the same level
    // numbers but has its own item art via WORLD_ITEM_IMAGES). Without
    // this, renderBoard()'s diff would see the same levels as last time
    // and skip repainting cells whose icon actually needs to change.
    function invalidateBoardRenderCache() {
      lastRenderedLevels = null;
    }


    function renderStats() {
      scoreStatEl.textContent = formatNumber(score);
      movesStatEl.textContent = String(moves);
      bestStatEl.textContent = formatNumber(best);
    }

    function renderNext() {
      const item = getItem(nextLevel);
      nextTileEl.innerHTML = "";
      nextTileEl.appendChild(createItemIcon(item));
    }

    function renderCollection() {
      collectionEl.innerHTML = "";
      // Guard against the same level ever getting a second icon in the
      // strip — normally registerLevelsReached()/markLevelFirstSeen()
      // already prevent this per world-playthrough, but this dedupe is a
      // cheap belt-and-suspenders safety net at render time so a
      // duplicate push (e.g. from an edge case in that upstream gating)
      // can never actually show twice. Keeps first-seen order, which is
      // also chronological order since `collection` is only ever
      // appended to.
      const seenLevels = new Set();
      const uniqueLevels = collection.filter(level => {
        if (seenLevels.has(level)) return false;
        seenLevels.add(level);
        return true;
      });
      uniqueLevels.slice(-12).forEach(level => {
        collectionEl.appendChild(createItemIcon(getItem(level)));
      });
    }

    function spawnBurst(r, c, image) {
      const boardRect = boardEl.getBoundingClientRect();
      const cellW = boardRect.width / COLS;
      const cellH = boardRect.height / ROWS;
      const burst = document.createElement("div");
      burst.className = "merge-burst";
      const img = document.createElement("img");
      img.className = "item-icon";
      img.src = image;
      img.alt = "";
      img.draggable = false;
      img.decoding = "async";
      burst.appendChild(img);
      burst.style.left = `${boardRect.left + cellW * (c + .5)}px`;
      burst.style.top = `${boardRect.top + cellH * (r + .5)}px`;
      document.body.appendChild(burst);
      setTimeout(() => burst.remove(), 850);
    }

    function showGameOver() {
      gameOverTextEl.textContent = `Your garden is full. You scored ${formatNumber(score)} harmony in ${moves} moves.`;
      modalEl.classList.add("show");
    }

    function hideModal() { modalEl.classList.remove("show"); }

    function showToast(message) {
      toastEl.textContent = message;
      toastEl.classList.add("show");
      setTimeout(() => toastEl.classList.remove("show"), 1500);
    }

    function formatNumber(value) { return new Intl.NumberFormat("sv-SE").format(value); }

    /* -----------------------------------------------------------------
       AUTH STATE — island 1 is playable by anyone, no account needed;
       only islands 2+ (and cloud saving) require being logged in. This
       hook (from auth.js, driven by sb.auth.onAuthStateChange) fires on
       initial load, login, and logout alike, so it doubles as a general
       "auth state changed" hook here even though its name is about
       premium status.
    ----------------------------------------------------------------- */
    let gardenLoadedForUser = null; // tracks which user_id we've already loaded, to avoid reloading on unrelated premium-status refreshes

    function onAuthOrPremiumChange() {
      // Guard against a debounced sync (queued by syncToCloud(false), see
      // placeTile()) firing AFTER an auth-state flicker resets local state
      // below — without this, a stale timer could still send whatever
      // currentSaveRow() looks like at that later moment (e.g. a wiped
      // clearedWorlds) and overwrite good cloud data. See the "cleared_worlds
      // keeps coming back empty" bug.
      if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; syncPendingFeedback = false; }

      // Drives the CSS rule that shows/hides the "Sign in here" member
      // line — see `#gameLayout.on-map:not(.is-logged-in) .holistic-member-line`
      // above.
      gameLayoutEl.classList.toggle("is-logged-in", !!currentUser);

      if (currentUser) {
        closeGuestUpsellModal();
        if (gardenLoadedForUser !== currentUser.id) {
          gardenLoadedForUser = currentUser.id;
          cloudSaveReadyForUser = null;
          loadFromCloud();
        }
        // Look up this account's Remove Ads purchase (independent of
        // Premium, already reflected via isPremium) and refresh the
        // Remove Ads card / Premium Active badge / ad banners.
        refreshAdsRemovedStatus().then(() => {
          // If the player got here via "Create account" / "Log in" from
          // the Remove Ads upsell modal, resume straight into Stripe
          // Checkout now that a session exists — no second click needed.
          const pending = consumePendingPurchaseIntent();
          if (pending === "removeAds" && !window.userAdsRemoved) {
            startRemoveAdsPurchase();
          }
        });
      } else {
        console.warn("AUTH RESET FIRED — currentUser is null, clearedWorlds being wiped to []"); // TEMP DEBUG
        console.trace("AUTH RESET trace"); // TEMP DEBUG
        gardenLoadedForUser = null;
        cloudSaveReadyForUser = null;
        // Reset the visible board so a previous account's garden never
        // lingers on screen for whoever uses this device/browser next,
        // then drop the guest onto a fresh, playable island 1 — no
        // account required. Progress here is session-only (never synced
        // to Supabase, see syncToCloud()'s currentUser guard).
        // Do not blindly wipe clearedWorlds here: auth/premium can briefly
        // report null during refresh and that was erasing map progress in
        // memory after a correct save. Guests still cannot unlock island 2+
        // because isWorldUnlocked() requires currentUser.
        board = createEmptyBoard();
        score = 0; moves = 0; history = []; collection = []; nextLevel = 1; best = 0;
        resetUnlockedLevels();
        clearedWorlds = Array.isArray(lastKnownClearedWorlds) ? lastKnownClearedWorlds.slice() : [];
        mapPage = 1;
        addStartingTiles();
        resetSeenLevelIntros(WORLD_KEYS[0]); // fresh guest playthrough — level reveals should replay
        seenLevelIntros[WORLD_KEYS[0]].add(1); // level 1 is guaranteed as the first tile — mark it seen right away
        collection.push(1); // ...and give it its collection icon immediately, so order tracking starts at 1
        setWorld(WORLD_KEYS[0]); // also resets background/name display and re-renders
        bestStatEl.textContent = formatNumber(best);
        render();
        showMap(null);
        window.userAdsRemoved = false;
        refreshMonetizationUI();
      }
    }

    stageFrameEl.style.setProperty("--board-cols", COLS); // match the CSS var to the COLS this page actually loaded with
    stageFrameEl.style.setProperty("--board-rows", ROWS); // match the CSS var to the ROWS this page actually loaded with
    // Guarded with isLoadingGarden too: currentUser can already be truthy
    // here (auth.js may hydrate a cached session synchronously) even though
    // loadFromCloud() — which populates the real clearedWorlds — hasn't run
    // yet (it only fires later via onPremiumStatusChange() below). Without
    // this guard, setWorld()'s internal syncToCloud(false, true) could fire
    // right here and overwrite the real cloud save with the still-default
    // (empty) clearedWorlds. See the "cleared_worlds keeps coming back
    // empty" bug — confirmed via stack trace pointing at this exact line.
    isLoadingGarden = true;
    cloudSaveReadyForUser = null;
    setWorld(currentWorldKey); // sets an initial background (and picker dots) before auth resolves
    isLoadingGarden = false;
    addStartingTiles();
    render();
    showMap(null); // land on the map immediately — island 1 is playable before auth even resolves

    if (typeof onPremiumStatusChange === "function") {
      onPremiumStatusChange(onAuthOrPremiumChange);
    } else {
      console.error("auth.js did not load — playing as guest only.");
    }
