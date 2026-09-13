// Admin-editable settings for the Top-Gainers banner: which channel it posts to,
// which layout, the daily auto-post time, and the data filters. Persisted in
// DATA_DIR so @dexvraadminbot writes it and the MAIN bot's poster reads it fresh
// each cycle — no redeploy, and no restart to pick up a change.
//
// Everything is clamped on READ as well as on write: this file is on disk, an
// operator can hand-edit it, and a stray `dailyTime: "99:99"` must degrade to a
// sane value rather than wedge the scheduler.
const fss = require("node:fs");
const path = require("node:path");
const { loadJSONSync, saveJSON, DATA_DIR } = require("../helpers/persist");
const { CHANNELS } = require("../config/constants");

const FILE = "gainersBanner.json";
// The admin-uploaded background artwork. Named here, once: the admin bot writes
// it and the main bot's poster reads it, and a filename spelled out in two places
// is a filename that eventually differs in one of them.
const BG_FILE = "gainers-background.png";
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const DEFAULTS = {
  // Daily auto-post. OFF by default: this posts to a public channel, so it is an
  // explicit decision, never something a deploy silently starts doing.
  daily: false,
  dailyTime: "09:00", // HH:MM in `tz`
  tz: "Asia/Jakarta",
  channel: "", // "" → CHANNELS.trending
  template: "random", // a template id, or "random" over `pool`
  pool: [], // random rotation; [] → every template
  minGainPct: 1, // a "+0.02%" gainer is not a gainer
  minLiqUsd: 0, // liquidity floor (0 = off)
  // MARKET-CAP FLOOR, and it defaults ON at $1M.
  //
  // A live board, 2026-08-17: $PATE took #2 with +1562% on a market cap of
  // $52.6K. At that size a single $500 buy is a four-figure percentage, so the
  // leaderboard was ranking noise above a token up 126% on $40.89M. A gain is
  // only interesting next to something worth gaining on.
  //
  // Unlike minLiqUsd this ships non-zero: it changes what an existing install
  // posts, deliberately, because zero is what produced the reported banner.
  minMcapUsd: 1_000_000, // market-cap floor (0 = off)
  showDate: true,
  showMcap: false, // market cap in the CAPTION (the artwork always shows it)
  // THE PERCENTAGE, on the artwork AND in the caption/tweet together. ON by
  // default — a gainers board with no gains printed is a list of tickers — and
  // switchable because an operator may want exactly that: the ranking without
  // the figures. One flag for both surfaces, or the banner says +2163% under a
  // caption that says nothing, and a reader is left deciding which is true.
  showPct: true,
  pin: false,
};

const HARD = {
  minGainPct: [0, 1000],
  minLiqUsd: [0, 100_000_000],
  minMcapUsd: [0, 100_000_000_000],
};

const clampNum = (v, [lo, hi], fb) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fb;
};

/** Template ids, resolved lazily so this module stays requirable without canvas. */
const templateIds = () => require("../gainersBanner").TEMPLATE_IDS;

/** Current config: defaults, with every stored value validated. */
function get() {
  const c = loadJSONSync(FILE, {}) || {};
  const g = { ...DEFAULTS };
  for (const k of ["daily", "showDate", "showMcap", "showPct", "pin"]) {
    if (typeof c[k] === "boolean") g[k] = c[k];
  }
  if (TIME_RE.test(String(c.dailyTime || ""))) g.dailyTime = normalizeTime(c.dailyTime);
  if (c.tz && validTz(c.tz)) g.tz = String(c.tz);
  if (typeof c.channel === "string") g.channel = c.channel.trim();
  const ids = templateIds();
  if (c.template === "random" || ids.includes(c.template)) g.template = c.template;
  if (Array.isArray(c.pool)) g.pool = [...new Set(c.pool.filter((t) => ids.includes(t)))];
  g.minGainPct = clampNum(c.minGainPct, HARD.minGainPct, DEFAULTS.minGainPct);
  g.minLiqUsd = clampNum(c.minLiqUsd, HARD.minLiqUsd, DEFAULTS.minLiqUsd);
  g.minMcapUsd = clampNum(c.minMcapUsd, HARD.minMcapUsd, DEFAULTS.minMcapUsd);
  return g;
}

/** "9:05" → "09:05" — pads the HOUR so the scheduler's string compare against
 *  nowHHMM() is exact. The minute must already be two digits: "9:5" is genuinely
 *  ambiguous (09:05 or 09:50?), and a scheduler is the wrong place to guess — it
 *  is rejected with a message instead. */
function normalizeTime(t) {
  const m = TIME_RE.exec(String(t || "").trim());
  if (!m) return DEFAULTS.dailyTime;
  return `${String(Number(m[1])).padStart(2, "0")}:${m[2]}`;
}

function validTz(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: String(tz) });
    return true;
  } catch {
    return false;
  }
}

/** Patch any subset; persists and returns the validated result. Throws only on
 *  input the admin can fix (a bad time / timezone / template), so the panel can
 *  show them what was wrong instead of silently storing the default. */
async function set(patch = {}) {
  const next = { ...get() };
  for (const k of ["daily", "showDate", "showMcap", "showPct", "pin"]) {
    if (typeof patch[k] === "boolean") next[k] = patch[k];
  }
  if (patch.dailyTime != null) {
    if (!TIME_RE.test(String(patch.dailyTime).trim())) throw new Error(`"${patch.dailyTime}" isn't a HH:MM time (e.g. 09:00)`);
    next.dailyTime = normalizeTime(patch.dailyTime);
  }
  if (patch.tz != null) {
    if (!validTz(patch.tz)) throw new Error(`"${patch.tz}" isn't a known timezone (e.g. Asia/Jakarta)`);
    next.tz = String(patch.tz).trim();
  }
  if (patch.channel != null) next.channel = String(patch.channel).trim();
  if (patch.template != null) {
    const t = String(patch.template);
    if (t !== "random" && !templateIds().includes(t)) throw new Error(`unknown template "${t}"`);
    next.template = t;
  }
  if (Array.isArray(patch.pool)) next.pool = [...new Set(patch.pool.filter((x) => templateIds().includes(x)))];
  if (patch.minGainPct != null) next.minGainPct = clampNum(patch.minGainPct, HARD.minGainPct, DEFAULTS.minGainPct);
  if (patch.minLiqUsd != null) next.minLiqUsd = clampNum(patch.minLiqUsd, HARD.minLiqUsd, DEFAULTS.minLiqUsd);
  if (patch.minMcapUsd != null) next.minMcapUsd = clampNum(patch.minMcapUsd, HARD.minMcapUsd, DEFAULTS.minMcapUsd);
  await saveJSON(FILE, next);
  return get();
}

/** Toggle a template in/out of the random rotation. Returns the new pool. */
async function togglePool(id) {
  const cfg = get();
  const pool = new Set(cfg.pool);
  if (pool.has(id)) pool.delete(id);
  else pool.add(id);
  return (await set({ pool: [...pool] })).pool;
}

async function reset() {
  await saveJSON(FILE, { ...DEFAULTS });
  return get();
}

/** Where a post actually goes: the configured channel, else @dexvratrending. */
const targetChannel = (cfg = get()) => cfg.channel || CHANNELS.trending;

/** Absolute path of the background artwork (whether or not it exists). */
const bgPath = () => path.join(DATA_DIR, BG_FILE);
/** Is there a usable background artwork? A zero-byte file counts as none. */
function hasBg() {
  try {
    return fss.existsSync(bgPath()) && fss.statSync(bgPath()).size > 0;
  } catch {
    return false;
  }
}
/** What to hand the renderer: the artwork path, or "" for the built-in backdrop. */
const bgForRender = () => (hasBg() ? bgPath() : "");

/** "HH:MM" right now in the configured timezone — what the scheduler compares
 *  against `dailyTime`. Wall-clock rather than a cron expression because the
 *  admin sets a time in words and the server runs in UTC. */
function nowHHMM(cfg = get(), now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: cfg.tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  }
}

/** The local calendar day (YYYY-MM-DD) in the configured timezone — the key the
 *  poster uses to guarantee at most one automatic post per day. */
function dayKey(cfg = get(), now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: cfg.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

module.exports = {
  FILE,
  BG_FILE,
  DEFAULTS,
  get,
  set,
  reset,
  togglePool,
  targetChannel,
  bgPath,
  hasBg,
  bgForRender,
  nowHHMM,
  dayKey,
  normalizeTime,
  validTz,
};
