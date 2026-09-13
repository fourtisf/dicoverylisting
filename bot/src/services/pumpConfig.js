// Admin-configurable pump-alert window (min% / max%), persisted so the operator
// can tune it from @dexvraadminbot without editing code or restarting. pumpChecker
// reads get() fresh each poll, so a change takes effect on the next cycle.
const { loadJSONSync, saveJSON } = require("../helpers/persist");

const FILE = "pumpConfig.json";
const DEFAULT_MIN = 100; // a token must be up at least this % to alert
const DEFAULT_MAX = 2000; // above this it's almost always bad market data — skip
// Sanity rails so a fat-finger can't disable alerts entirely or spam on noise.
const HARD_MIN = 10;
const HARD_MAX = 1_000_000;
const GAP = 10; // max must stay at least this far above min

function clampNum(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/** Current { minPct, maxPct } — defaults when nothing saved. */
function get() {
  const c = loadJSONSync(FILE, {}) || {};
  const minPct = Number.isFinite(c.minPct) ? c.minPct : DEFAULT_MIN;
  const maxPct = Number.isFinite(c.maxPct) ? c.maxPct : DEFAULT_MAX;
  return { minPct, maxPct };
}

/** Patch min and/or max (either may be omitted). Enforces sane rails and keeps
 *  max strictly above min. Returns the persisted { minPct, maxPct }. */
async function set({ minPct, maxPct } = {}) {
  const cur = get();
  let min = minPct != null ? clampNum(minPct, HARD_MIN, HARD_MAX, cur.minPct) : cur.minPct;
  let max = maxPct != null ? clampNum(maxPct, HARD_MIN, HARD_MAX, cur.maxPct) : cur.maxPct;
  // Keep the window valid: max always at least GAP above min.
  if (max < min + GAP) {
    if (maxPct != null && minPct == null) min = Math.max(HARD_MIN, max - GAP); // lowered max → pull min down
    else max = Math.min(HARD_MAX, min + GAP); // raised min (or both) → push max up
  }
  await saveJSON(FILE, { minPct: min, maxPct: max });
  return { minPct: min, maxPct: max };
}

/** Back to the built-in 100%–2000% window. */
async function reset() {
  await saveJSON(FILE, { minPct: DEFAULT_MIN, maxPct: DEFAULT_MAX });
  return { minPct: DEFAULT_MIN, maxPct: DEFAULT_MAX };
}

module.exports = { get, set, reset, DEFAULT_MIN, DEFAULT_MAX, HARD_MIN, HARD_MAX };
