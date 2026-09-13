// Auto-Listing — free, automatic listings for projects that climb past the
// operator's market-cap threshold (~$1M), discovered across every supported
// chain — on DexScreener, and on pools.trade for the Robinhood Chain launches
// DexScreener does not index (see discovery.js). Off by default; everything is
// tunable from @dexvraadminbot and the loop re-reads config each cycle, so
// changes apply without a restart.
//
// WHY THE TRIGGER IS PER-TOKEN AND RANDOM
// Listing everything the instant it prints $1,000,000 makes the feed read as
// machine-generated: every entry shows the same round number. So each token gets
// its OWN trigger somewhere in [minMcap, maxMcap] — one lists at $1.08M, the
// next at $1.42M — and because a scan lands minutes after the crossing, the
// recorded cap is a little past that. That is the whole point of the band.
//
// The trigger is DERIVED FROM THE ADDRESS, not rolled fresh each scan. A fresh
// roll would re-draw until one landed under the token's current cap, which
// converges on listing everything at the floor — exactly the behaviour we are
// trying to avoid. Hashing the address means a token has to genuinely climb to
// ITS number, and the number never moves.
//
// WHAT AN AUTO-LISTED TOKEN GETS is the operator's choice — see PACKAGES below:
// a plain free listing, an Xpress Listing, or Listing & Trending with a
// time-boxed slot on the board. More than one can be enabled at a time, and
// then they TAKE TURNS: one listing gets Xpress, the next Listing & Trending,
// and so on. Operator's rule (2026-08-04) — "jalan barengan, jadi bergilir".
//
// Listing & Trending hands out a REAL paid tier — Diamond, Gold or Silver,
// drawn from the address the same way the trigger cap is. That is a deliberate
// reversal of the older rule (every auto listing wore "FREE" so it could never
// be mistaken for a paid placement), made on the operator's explicit call, and
// it has two consequences worth knowing when reading this file:
//   • the board sorts by tier first (trendingPoster.tierPrio), so an auto
//     Diamond now sits alongside a paying Diamond instead of under it;
//   • the site derives the VERIFIED badge from the tier (lib/listings.ts
//     verifiedTier), and Diamond/Gold carry it — Silver does not.
// Change TREND_TIERS below to change the draw.
const crypto = require("node:crypto");
const { loadJSONSync, readJSONSync, saveJSON } = require("../helpers/persist");
// Every discovery source behind one seam (DexScreener + pools.trade). Named
// `ds` still because the two functions it exposes are the two this service has
// always called, with the same shapes; see discovery.js for what merged.
const ds = require("../discovery");
const api = require("../api/dexvra");
const post = require("../channels/post");
const fmt = require("../channels/format");
const postids = require("../channels/postids");
const x = require("../twitter");
const { CHANNELS, SITE_URL, X_AUTOLIST_ENABLED, X_POST_TIMEOUT_MS } = require("../config/constants");
const { sanitizeTicker } = require("../helpers/ticker");
const { chainOf } = require("../config/chains");
// The repo's one money formatter — the visitor report prints caps and volumes,
// and a second spelling of "$1.10M" across surfaces is how two screens come to
// describe one number differently.
const { fmtCap } = require("../helpers/format");
const { tierLabel } = require("../config/packages");
const listingWatch = require("./listingWatch");
// The one owner of "is this the money rather than the project" — the same set
// the market filler ranks against and the site ranks against.
const { notAProject } = require("./bigCoins");
const log = require("../helpers/logger");

const FILE = "autoLister.json";
const STATE_FILE = "autoListerState.json";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// How many consecutive BLOCKED scans before the operator is paged. A scan is
// blocked when it could not do its job at all — discovery returned nothing, or
// the site's internal API refused to answer — as opposed to running fine and
// finding nothing worth listing. Scans are 25–90 min apart, so three is roughly
// 1.5–4.5 hours of silence: past a blip, and nowhere near the two days it used
// to take for anyone to notice.
const BLOCKED_ALERTS_AT = 3;

// Upper bound on the rejection memo (see coolUntil). Well past a full scan's
// candidate list; only here so a long-running process cannot grow the file
// without limit.
const MAX_COOL = 4_000;

/** Statuses that mean "this ROW is wrong", as opposed to "the site is refusing
 *  this bot" (401/403/451) or "not right now" (429/5xx). Only these are worth
 *  remembering against a token. */
const PAYLOAD_REFUSAL = new Set([400, 404, 409, 413, 422]);

/**
 * A scan that cannot even record what stopped it.
 *
 * ⚠️ Both halts below refuse to WRITE — that is the whole point of them — so
 * `fileReport` is unavailable and `lastScan()` goes stale. And a stale report is
 * exactly what `alScanLine` and `listing:check` read as "the loop has stopped",
 * so without this the diagnosis would accuse a perfectly healthy loop and send
 * the operator to pm2 to hunt a process that is running fine. `lastHalt()` is
 * the readable channel: in memory, because memory is the only place left.
 */
let haltAlerted = false;

// ⚠️ ITS OWN FILE, because the two things that need to read it are in ANOTHER
// PROCESS. The loop runs in dexvra-bot; the panel runs in dexvra-adminbot and
// `listing:check` is a third process again — so an in-memory halt is invisible
// to both, and they would go on diagnosing "the loop is not running" about a
// loop that is running perfectly. It cannot be the state file (refusing to
// write that is the whole point of a halt) and it is not the ledger, so a
// separate two-field file is safe to write even when the state file is not.
const HEALTH_FILE = "autoListerHealth.json";

async function halt(report, why) {
  report.blocker = why;
  // AWAITED. A fire-and-forget write races the very readers this file exists
  // for — the panel and `listing:check` in their own processes — so the halt
  // would be invisible for exactly as long as it takes them to look.
  await saveJSON(HEALTH_FILE, { at: report.at, why }).catch((e) => log.error(`[autolist] could not record the halt: ${e.message}`));
  log.error(`[autolist] ${why}`);
  // Once per process: this is a condition that persists, and a page every 25–90
  // min is a channel nobody reads by the second hour.
  if (!haltAlerted) {
    haltAlerted = true;
    log.alert(`🚨 <b>Auto-Listing halted</b>\n\n<code>${String(why).slice(0, 400)}</code>\n\n<i>Nothing is being listed.</i>`);
  }
  return 0;
}

/** The last halt, or null. Read by the panel and `listing:check` — both in other
 *  processes — because a halt is the one state that cannot reach the scan
 *  report. Cleared by the first scan that gets far enough to file one. */
const lastHalt = () => {
  const h = loadJSONSync(HEALTH_FILE, null);
  return h && h.at && h.why ? h : null;
};

const DEFAULTS = {
  enabled: false, // OFF until the operator turns it on — it publishes in public
  minMcap: 1_000_000, // the floor the operator asked for
  maxMcap: 1_500_000, // top of the random band → 1.1M / 1.4M listings
  maxMcapHard: 50_000_000, // past this it is an established token, not a find
  minLiq: 25_000, // a $1M cap on $300 of liquidity is not a $1M project
  minVol24: 50_000,
  minAgeHours: 6, // skip the first hours, where most rugs live
  maxPerDay: 12, // the channel/site must not read as a firehose
  maxPerRun: 3,
  maxLookupsPerRun: 40, // politeness toward the DexScreener API
  minGapMin: 25, // random wait between scans (never a fixed heartbeat)
  maxGapMin: 90,
  // ── How often a LISTING may go out, as opposed to how often we LOOK ───────
  //
  // Two different questions that had one answer. The gap above is the SCAN
  // cadence, and a scan that finds nothing lists nothing — so it was never a
  // statement about the feed. With maxPerRun 3 behind it the site could take
  // three listings inside one minute and three more half an hour later, which
  // is the firehose maxPerDay was invented to bound and does not actually
  // bound: twelve a day arriving in four bursts is still four bursts.
  //
  // The operator's ask (2026-08-25) is the other question — "berapa jam sekali
  // baru free listing di range misal range 2 sampai 3 jam". So this is a FLOOR
  // on the spacing between one free listing and the next, rolled fresh inside
  // the band each time: a fixed 2h would put every listing on the same minute
  // of the hour, which is the other half of looking machine-run (the reason the
  // scan gap is a band too).
  //
  // While it is on a scan lists AT MOST ONE token. `maxPerRun` describes how
  // big a burst may be, and the whole point of a pace is that there are none —
  // so the panel stops printing a per-scan number that can no longer happen,
  // rather than leaving a row the engine ignores.
  paceListings: true,
  minListGapMin: 120, // 2h — the operator's own example
  maxListGapMin: 180, // 3h
  // Which packages an auto listing can get. More than one → they take turns,
  // one per listing, in this order. Never empty (get() falls back to ["free"]).
  pkgs: ["free"],
  trendHours: 12, // only used by the "trending" package
  // Which chains the scan may LIST ON. Empty = every supported chain — the
  // behaviour this service has always had, and what a fresh install gets. A
  // non-empty list focuses the whole discovery budget on those chains: the
  // operator's ask was "kalau pilih Base, fokus ke Base" — a thin chain never
  // fills while 90% of every scan's lookups go to Solana launches.
  chains: [],
  postChannel: false, // list on the site only, until the operator says otherwise
  // …and, on the "trending" package only, the @dexvraio announcement too.
  // Defaults ON rather than OFF like the switches above, because it cannot fire
  // on its own: it needs postChannel already ON *and* the operator to have
  // picked "Listing & Trending". Both of those are deliberate acts, so a third
  // switch defaulting to off would only be a way to silently not do what the
  // package says it does. Operator's rule: an auto listing that also buys a
  // board slot is the one worth announcing. See announce().
  announceChannel: true,
};

// What an auto-listed token receives. The operator picks one; "free" is the
// default because it is the only option that cannot be confused with something
// somebody paid for.
//
//   free     — listed on the site with a "Free" badge. No tier, no trending.
//   xpress   — treated as an Xpress Listing: tier XPRESS, the Xpress post card.
//   trending — listed AND featured on the Trending board for `trendHours`, with
//              the Trending card as well, AND announced in @dexvraio. Carries a
//              real paid tier drawn from TREND_TIERS (see trendTier()).
//
// `tier: null` means "not fixed — ask trendTier() for this token's own".
const PACKAGES = {
  free: { label: "Free listing", tier: "FREE", trending: false },
  xpress: { label: "Xpress Listing", tier: "XPRESS", trending: false },
  trending: { label: "Listing & Trending", tier: null, trending: true },
};
const PKG_KEYS = Object.keys(PACKAGES);
const pkgOf = (key) => PACKAGES[key] || PACKAGES.free;

// The tiers Listing & Trending draws from. Platinum and Bronze are deliberately
// absent: the operator named these three (2026-08-04). Order is part of the
// stored behaviour — a token's tier is an index into this array, so reordering
// it re-labels tokens that are already listed. Append, don't shuffle.
const TREND_TIERS = ["DIAMOND", "GOLD", "SILVER"];

// Rails: a fat-finger in the admin editor must not be able to list the whole
// market or spam the channel.
const HARD = {
  mcap: [10_000, 1_000_000_000],
  liq: [0, 100_000_000],
  vol: [0, 1_000_000_000],
  ageHours: [0, 720],
  perDay: [1, 100],
  perRun: [1, 25],
  lookups: [5, 200],
  gapMin: [5, 1440],
  // 0 is deliberately legal: "no floor" is a thing an operator may mean, and it
  // is what the 🔴 OFF toggle does anyway — an expressible zero beats a hidden
  // one. A week is the ceiling; past that the feature is "off" spelled long.
  listGapMin: [0, 10_080],
  trendHours: [1, 48],
};

/** Whether the last `get()` could actually READ the config file. Its own
 *  function because `get()`'s return is compared against DEFAULTS field for
 *  field, and is what `set()` writes back. */
let cfgRead = { ok: true, why: null };
const configOk = () => ({ ok: cfgRead.ok, why: cfgRead.why });

function clampInt(v, [lo, hi], fb) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fb;
}

/** Current config, defaults applied and every value forced within its rails. */
function get() {
  // ⚠️ AN UNREADABLE CONFIG IS NOT A FRESH INSTALL EITHER, and this one is worse
  // than the state file: `DEFAULTS.enabled` is false, so a corrupt or
  // root-owned `autoLister.json` (DATA_DIR is shared by both PM2 processes —
  // one `sudo node scripts/…` is enough) reads as the operator having switched
  // the service OFF. The panel then says 🔴 OFF and `listing:check` tells them
  // to tap ▶️ Enable — which calls `set()`, which writes `{...get()}` and so
  // overwrites every tuned threshold with the shipped defaults. A read failure
  // laundered into a settings wipe.
  const read = readJSONSync(FILE, {});
  const c = read.value || {};
  // The read status is its own question and its own function (`configOk()`) —
  // NOT a field on the config, which is compared field-for-field against
  // DEFAULTS in a dozen places and is written straight back by `set()`.
  cfgRead = read;
  const g = { ...DEFAULTS };
  for (const k of ["enabled", "postChannel", "announceChannel", "paceListings"])
    if (typeof c[k] === "boolean") g[k] = c[k];
  g.minMcap = clampInt(c.minMcap, HARD.mcap, DEFAULTS.minMcap);
  g.maxMcap = clampInt(c.maxMcap, HARD.mcap, DEFAULTS.maxMcap);
  if (g.maxMcap < g.minMcap) g.maxMcap = g.minMcap; // keep the band valid
  g.maxMcapHard = clampInt(c.maxMcapHard, HARD.mcap, DEFAULTS.maxMcapHard);
  if (g.maxMcapHard < g.maxMcap) g.maxMcapHard = g.maxMcap;
  g.minLiq = clampInt(c.minLiq, HARD.liq, DEFAULTS.minLiq);
  g.minVol24 = clampInt(c.minVol24, HARD.vol, DEFAULTS.minVol24);
  g.minAgeHours = clampInt(c.minAgeHours, HARD.ageHours, DEFAULTS.minAgeHours);
  g.maxPerDay = clampInt(c.maxPerDay, HARD.perDay, DEFAULTS.maxPerDay);
  g.maxPerRun = clampInt(c.maxPerRun, HARD.perRun, DEFAULTS.maxPerRun);
  g.maxLookupsPerRun = clampInt(c.maxLookupsPerRun, HARD.lookups, DEFAULTS.maxLookupsPerRun);
  g.minGapMin = clampInt(c.minGapMin, HARD.gapMin, DEFAULTS.minGapMin);
  g.maxGapMin = clampInt(c.maxGapMin, HARD.gapMin, DEFAULTS.maxGapMin);
  if (g.maxGapMin < g.minGapMin) g.maxGapMin = g.minGapMin;
  g.minListGapMin = clampInt(c.minListGapMin, HARD.listGapMin, DEFAULTS.minListGapMin);
  g.maxListGapMin = clampInt(c.maxListGapMin, HARD.listGapMin, DEFAULTS.maxListGapMin);
  // An inverted band resolves to the FLOOR, never the ceiling — the same call
  // the per-chain trending target makes, for the same reason: the floor is the
  // number the operator set, and widening the wait to one they never typed is a
  // feed that goes quiet for hours with nothing anywhere saying why.
  if (g.maxListGapMin < g.minListGapMin) g.maxListGapMin = g.minListGapMin;
  // `pkgs` is the current shape; `pkg` (a single key) is what every install
  // before the rotation existed has on disk. Read the old one when the new one
  // is absent, so nobody's saved choice silently reverts to "free" on deploy.
  const saved = Array.isArray(c.pkgs) ? c.pkgs : c.pkg != null ? [c.pkg] : [];
  const picked = [...new Set(saved.map(String).filter((k) => PACKAGES[k]))];
  // Never empty: an empty list would make nextPkg() return undefined and every
  // listing fall back to "free" anyway — better to say so in the config.
  g.pkgs = picked.length ? picked : [...DEFAULTS.pkgs];
  // Deliberately NO `pkg` alias on the way out. "The first enabled package" and
  // "the package the next listing gets" are different answers once a rotation
  // exists, and one name for both is how they end up used interchangeably.
  g.trendHours = clampInt(c.trendHours, HARD.trendHours, DEFAULTS.trendHours);
  // Unknown chain keys are DROPPED, not kept: a typo'd "bsc " stored verbatim
  // would silently scope the scan to a chain that does not exist, which lists
  // nothing forever and looks exactly like a quiet market.
  const savedChains = Array.isArray(c.chains) ? c.chains : [];
  g.chains = [...new Set(savedChains.map(String).filter((k) => chainOf(k)))];
  return g;
}

/** Patch any subset of the config; persists and returns the clamped result. */
async function set(patch = {}) {
  const next = { ...get() };
  // Refuse rather than overwrite: writing the defaults back over a file we
  // could not read is how one bad read becomes a permanent settings wipe.
  const rd = configOk();
  if (!rd.ok) throw new Error(`cannot read ${FILE} — ${rd.why}. Refusing to overwrite it.`);
  for (const [k, v] of Object.entries(patch)) if (k in DEFAULTS && v != null) next[k] = v;
  // A single `pkg` still means "only this one, nothing else" — that is what it
  // meant before the rotation existed, and an older caller saying it must not
  // quietly ADD to whatever is already enabled.
  if (patch.pkg != null && patch.pkgs == null) next.pkgs = [patch.pkg];
  await saveJSON(FILE, next);
  return get();
}

/** Turn one package on/off. Refuses to empty the list — with nothing enabled
 *  the service would keep scanning and list everything as a plain free listing,
 *  which is a setting nobody chose. Returns the resulting config. */
async function togglePkg(key) {
  // No guard of its own: every path out of here goes through `set()`, which
  // refuses over an unreadable config. One owner for that rule.
  if (!PACKAGES[key]) return get();
  const on = get().pkgs;
  const next = on.includes(key) ? on.filter((k) => k !== key) : [...on, key];
  if (!next.length) return get();
  // Keep PKG_KEYS order rather than tap order, so the rotation reads the same
  // way as the buttons that set it: Free → Xpress → Listing & Trending.
  return set({ pkgs: PKG_KEYS.filter((k) => next.includes(k)) });
}

/**
 * Put every THRESHOLD back to its shipped value.
 *
 * ⚠️ THE SWITCH IS NOT A THRESHOLD, and this used to take it with everything
 * else. `DEFAULTS.enabled` is false — correct for a fresh install, because this
 * service publishes in public — so ↩️ Reset silently turned a running feed OFF,
 * announced as a bare "↩️ Reset". And a service that is off files no scan
 * report, so the panel then printed "⚠️ The scanner has gone quiet — the loop
 * has stopped. Check pm2 logs", sending the operator to hunt a dead process
 * that their own tap had switched off. Two taps from "free listing tidak
 * bekerja" and nothing on any screen naming the cause.
 *
 * Resetting the numbers is not a decision about whether the service runs, so
 * the switch is CARRIED OVER. Turning it off is what ⏸ Disable is for, and that
 * button says what it does.
 */
async function reset() {
  const wasEnabled = get().enabled;
  // ⚠️ THE SAME GUARD `set()` HAS, and it was missing on its sibling — which is
  // the worse of the two to miss. `get()` answers DEFAULTS for an unreadable
  // file, so `wasEnabled` reads FALSE, and this would then write the shipped
  // defaults over a config it could not read AND switch the live feed off: every
  // threshold destroyed, from the one button whose documented contract is that
  // it never touches the switch. A read failure laundered into a settings wipe,
  // by the code written to stop exactly that.
  const rd = configOk();
  if (!rd.ok) throw new Error(`cannot read ${FILE} — ${rd.why}. Refusing to overwrite it.`);
  await saveJSON(FILE, { ...DEFAULTS, enabled: wasEnabled });
  return get();
}

/** Forget EVERYTHING this service knows — what it auto-listed, today's count,
 *  and the ever-listed ledger below. The deliberate operator escape hatch
 *  ("🧹 Clear history"), used after wiping the site's listings so it can
 *  repopulate. Nothing else may clear the ledger. */
async function resetState(now = Date.now()) {
  // ⚠️ THE SCAN REPORT SURVIVES. It is an observation about the LOOP, not
  // knowledge about tokens — and clearing it made `alScanLine` instantly print
  // "the scanner has never reported … it is NOT running" over a loop that was
  // running perfectly, from the operator's own tap. Two taps from "free listing
  // tidak bekerja", with nothing on any screen naming the cause. `blocked` goes
  // with it for the same reason: it counts consecutive failures of the loop.
  const prev = loadState();
  await saveJSON(STATE_FILE, {
    listed: {},
    day: null,
    everListed: {},
    pkgTurn: 0,
    cool: {},
    scan: prev._ok ? prev.scan : null,
    blocked: prev._ok ? prev.blocked : 0,
    lastListAt: null,
    paceRoll: 0,
    watch: {},
    // When the operator cleared, so a scan already in flight cannot write its
    // pre-clear snapshot back over this. See fileReport.
    clearedAt: now,
  });
}

// ── State: what we already listed, and today's count ────────────────────────
//
// `everListed` is a PERMANENT ledger of every contract that has ever appeared
// on the site, whatever put it there. It exists because the other two guards
// both have holes: `state.listed` only knows this service's own picks, and the
// live `getListings()` set disappears the moment a row is deleted. Delete a
// listing on the site — including one somebody PAID for — and without this the
// auto-lister happily hands the same token back out for free on the next scan.
// Once a contract is in here it is never free-listed again.
const loadState = () => {
  // ⚠️ AN UNREADABLE STATE FILE IS NOT A FIRST RUN. `everListed` is append-only
  // and permanent; reading a truncated or half-restored file as `{}` and then
  // saving over it wipes the ledger for good — and its symptom is free listings
  // appearing for tokens the site has already SOLD. `runOnce` refuses to scan on
  // `_ok: false` rather than write, which is the same call `getListings()`
  // already makes one gate down: bail instead of guessing.
  const read = readJSONSync(STATE_FILE, {});
  const s = read.value || {};
  const obj = (v) => (v && typeof v === "object" ? v : {});
  return {
    _ok: read.ok,
    _why: read.why,
    listed: obj(s.listed),
    day: s.day || null,
    everListed: obj(s.everListed),
    // Where the package rotation is up to. Persisted rather than in-memory so a
    // restart doesn't put the turn back to the first package every time — on a
    // service that lists a dozen tokens a day and gets redeployed, an in-memory
    // cursor would hand out Xpress almost every time.
    pkgTurn: Number(s.pkgTurn) || 0,
    // contract key → epoch ms until which it is not worth pricing again. See
    // coolUntil(): a token 40× below its trigger does not need re-pricing every
    // 25 minutes, and re-pricing it is what stopped the scan ever reaching the
    // candidates behind it.
    cool: obj(s.cool),
    // The last scan's report, and how many scans in a row have been BLOCKED.
    // Both exist so "nothing was listed" is answerable — see scanReport().
    scan: s.scan && typeof s.scan === "object" ? s.scan : null,
    blocked: Number(s.blocked) || 0,
    // ── The pacing clock ────────────────────────────────────────────────────
    // When the last free listing went out, and the roll that decides how long
    // the wait after it is. PERSISTED, because a restart that reset the clock
    // would let a redeploy publish back-to-back listings — and this service is
    // redeployed far more often than it is paced.
    lastListAt: Number(s.lastListAt) > 0 ? Number(s.lastListAt) : null,
    // The roll is a FRACTION of the band, not an absolute "next at" timestamp,
    // so that editing the band in the panel applies to the wait already in
    // progress. A stored timestamp would go on honouring a range the operator
    // has since changed, and from the panel that is indistinguishable from a
    // clock that has stopped.
    // ⚠️ `Number(undefined)` is NaN and `Number(null)` is 0 — and 0 is a legal
    // roll meaning "the shortest wait in the band", which is the safe way to
    // fall: an unreadable roll must never freeze the feed for the maximum.
    paceRoll: rollOf(s.paceRoll),
    // When 🧹 Clear history last ran — see fileReport, which uses it to refuse a
    // stale snapshot rather than silently undoing the clear.
    clearedAt: Number(s.clearedAt) || 0,
    // The symptom watch's own clock — see services/listingWatch.js. Kept beside
    // the scan report rather than in memory for the reason the pace clock is:
    // this service is redeployed far more often than it is quiet, and a watch
    // that reset on every restart could never reach its grace period.
    watch: obj(s.watch),
  };
};

// ── Why nothing happened ────────────────────────────────────────────────────
//
// Every reason this service does nothing used to go to log.debug, which only
// prints when DEBUG is set, and production does not set it. "Discovery returned
// no candidates" was not logged at all. So a healthy-but-idle scan and a service
// that had been broken for two days produced byte-for-byte identical output:
// nothing, anywhere. The panel showed a "Listed so far" counter that simply
// stopped moving, which is not a diagnosis.
//
// Every scan now files a report — what it saw, what it priced, and either what
// it listed or the tally of why it listed nothing — and the panel shows it. A
// scan that could not run AT ALL records a `blocker`, and enough of those in a
// row pages the ops channel instead of waiting for someone to notice.
const blank = (now) => ({
  at: now,
  candidates: 0,
  priced: 0,
  listed: 0,
  known: 0, // already on the site / already listed / in the never-relist ledger
  cooled: 0, // skipped by the rejection memo
  offChain: 0, // outside the operator's chain scope — costs no lookup
  // ⚠️ A candidate on a chain `chainOf()` cannot resolve. Counted rather than
  // dropped in silence: discovery maps a feed entry back through DS_CHAIN, so
  // the only way to land here is a chain the two maps disagree about — which is
  // a whole network going invisible, and the panel used to render it as
  // candidates that simply evaporated between "seen" and "priced".
  unsupported: 0,
  reasons: {}, // rejection text (numbers stripped) → count
  // ⚠️ THE TOKEN QUALIFIED AND THE SITE WOULD NOT TAKE IT. Nothing recorded
  // this: a create that threw was one log.warn and a `continue`, so a site
  // refusing every listing produced "40 candidates · 40 priced · 0 listed" —
  // byte-identical to a healthy scan in a quiet market, with `blocker` null and
  // the blocked-scan watchdog silent. That is the state the operator reported
  // as "free listing tidak bekerja", and it was invisible from the panel, the
  // alert channel and the INFO log alike.
  refused: 0,
  refusals: {}, // the site's own words → count
  // ⚠️ "We could not ask the pricing source", which is NOT the same fact as the
  // token having no market — and rendering it as the second is what let a
  // DexScreener refusing this box read as a quiet market for as long as it did.
  unpriced: 0,
  unpricedWhy: {},
  sources: [], // per discovery source: {name, n, ok, why}
  off: false, // the operator's own switch — a REPORTED state, never a silence
  capped: null, // "9/9" when the operator's own daily cap ended the scan
  paced: null, // {waitMs, nextAt, gapMs} when the listing pace held this scan back
  blocker: null,
});

/**
 * Record a create the site would not take.
 *
 * The reason is kept VERBATIM (bounded) rather than bucketed like a market
 * rejection: `reasonBucket` strips parenthesised figures because those are live
 * numbers, while a refusal is the site's own sentence and every word of it is
 * the diagnosis — "400: Invalid ticker" and "401: unauthorized" are a listing
 * payload problem and a credentials problem, and telling them apart is the
 * whole point of writing it down.
 */
function noteRefusal(report, why) {
  const text = String(why || "refused").slice(0, 160);
  report.refused++;
  report.refusals[text] = (report.refusals[text] || 0) + 1;
}

/** The last scan's report, or null before the first one. */
const lastScan = () => loadState().scan;

/** Rejection reasons carry live figures ("thin liquidity ($1,204)"), which would
 *  make every rejection its own bucket. Strip them for the tally. */
const reasonBucket = (why) => String(why).replace(/\s*\([^)]*\)/g, "").trim();

/**
 * Persist a scan report, and page the operator when scans stay BLOCKED.
 *
 * "Blocked" is deliberately narrower than "listed nothing": a scan that priced
 * forty tokens and liked none of them is the service working correctly in a
 * quiet market, and paging for that is how a monitor gets muted. Only a scan
 * that could not do its job — no candidates at all, or a site API that would not
 * answer — counts, and only after BLOCKED_ALERTS_AT of them in a row.
 */
async function fileReport(report, state = loadState()) {
  // Reaching here at all means the halt is over — the scan read both files and
  // is about to write one. A stale halt on the panel is the same defect as a
  // stale scan report, pointing the other way.
  if (lastHalt()) {
    await saveJSON(HEALTH_FILE, {}).catch(() => {});
    haltAlerted = false;
    log.alert("✅ <b>Auto-Listing is scanning again</b> — the file it could not read is readable.");
  }
  // ⚠️ THE LEDGER IS APPEND-ONLY AND THIS IS NOT THE ONLY WRITER. `state` is a
  // snapshot taken at the top of the scan, and `fulfillment.js` calls
  // `rememberListed` the moment a PAID listing goes live — which can land in the
  // middle of a scan that takes forty serial lookups. Writing the snapshot back
  // whole would drop that entry, and the token it protects becomes eligible for
  // a free auto listing. Merged, never overwritten.
  const fresh = readJSONSync(STATE_FILE, {});
  if (fresh.ok && fresh.value) {
    // ⚠️ …AND THE OPERATOR'S CLEAR OUTRANKS THE SNAPSHOT. 🧹 Clear history can
    // land in the middle of a scan — the window is up to forty serial lookups,
    // minutes wide when DexScreener is slow, which is exactly when somebody
    // taps it — and a blind union of fresh-into-stale restores every entry they
    // just deleted. The panel would report the history cleared and the tokens
    // would go on being refused for ever. A clear stamped after this scan
    // started means the snapshot's token bookkeeping is void: keep the report,
    // discard what the scan believed about the ledger.
    if (Number(fresh.value.clearedAt) > report.at) {
      const after = loadState();
      for (const k of ["listed", "everListed", "cool", "day", "pkgTurn", "lastListAt", "paceRoll", "clearedAt"]) {
        state[k] = after[k];
      }
    } else if (fresh.value.everListed) {
      state.everListed = { ...fresh.value.everListed, ...state.everListed };
    }
  }
  const wasBlocked = state.blocked;
  state.scan = report;
  state.blocked = report.blocker ? wasBlocked + 1 : 0;

  // ── The SYMPTOM watch ─────────────────────────────────────────────────────
  // Everything above answers "could this scan run". `listingWatch` answers the
  // question the operator actually asks — "is anything being listed" — because
  // a service that runs perfectly and can never publish is the state that looks
  // most like a healthy one. Folded in HERE because this is the one function
  // every scan passes through, paced and capped scans included: hanging it off
  // the listing path instead would freeze the watch on exactly the installs
  // that stay broken longest.
  let watchAlerts = [];
  try {
    const w = listingWatch.evaluate(
      { enabled: get().enabled, lastListAt: state.lastListAt, scan: report },
      state.watch,
      { now: report.at },
    );
    state.watch = w.state;
    watchAlerts = w.alerts;
  } catch (e) {
    // A watch that throws must never cost the scan its report.
    log.debug(`[autolist] watch: ${e.message}`);
  }

  await saveJSON(STATE_FILE, state).catch((e) => log.error(`[autolist] could not persist ${STATE_FILE}: ${e.message} — this scan's bookkeeping is lost`));
  for (const a of watchAlerts) log.alert(a.text);

  if (report.blocker) {
    if (state.blocked === BLOCKED_ALERTS_AT) {
      log.alert(
        `🚨 <b>Auto-Listing has stopped working</b>\n\n` +
          `${BLOCKED_ALERTS_AT} scans in a row could not run:\n<code>${String(report.blocker).slice(0, 300)}</code>\n\n` +
          `<i>Nothing is being listed. Check DEXVRA_API_BASE + INTERNAL_API_TOKEN reach the site, ` +
          `then use 🔎 Test scan in the Auto Listing panel.</i>`,
      );
    }
    return report;
  }
  if (wasBlocked >= BLOCKED_ALERTS_AT) {
    log.alert(`✅ <b>Auto-Listing is scanning again</b> — ${report.candidates} candidates, ${report.priced} priced.`);
  }
  return report;
}

/**
 * How long to leave a rejected token alone, scaled by how far it is from
 * qualifying.
 *
 * Without this the scan re-prices the same head of the candidate list every
 * cycle — discovery order barely moves between scans — and burns its whole
 * lookup budget on tokens it has already turned down, so the ones behind them
 * are never looked at. A token sitting at $30k against a $1.4M trigger does not
 * need another quote for hours; one at $1.35M needs one on the very next scan,
 * because it is about to cross.
 *
 * "too new" is exact rather than scaled: the token becomes eligible at a known
 * moment, so wait precisely that long.
 */
function coolUntil(why, info, cfg, trigger, now) {
  if (/^too new/.test(why) && info && info.pairCreatedAt) {
    return info.pairCreatedAt + cfg.minAgeHours * HOUR_MS;
  }
  // No data / no ticker / no name / no market cap: properties of the token, not
  // of the market. They do not change on a 25-minute timescale.
  if (!info || !/^below its trigger/.test(why)) {
    // …except liquidity and volume, which move as fast as the price does.
    return now + (/^(thin liquidity|low 24h volume)/.test(why) ? HOUR_MS : 12 * HOUR_MS);
  }
  const ratio = (Number(info.mcap) || 0) / (trigger || 1);
  if (ratio >= 0.75) return 0; // within striking distance — re-price next scan
  if (ratio >= 0.4) return now + 2 * HOUR_MS;
  return now + 12 * HOUR_MS;
}

/** Drop expired entries, and cap the memo so it cannot grow without limit. */
function pruneCool(cool, now) {
  const live = Object.entries(cool).filter(([, until]) => Number(until) > now);
  if (live.length <= MAX_COOL) return Object.fromEntries(live);
  // Keep the ones with the longest to run: they are the tokens furthest from
  // qualifying, so they are the ones worth NOT re-pricing.
  return Object.fromEntries(live.sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, MAX_COOL));
}

/**
 * The package for the NEXT listing, and the cursor to store once it lands.
 *
 * With one package enabled this is just that package. With several they take
 * turns — Xpress, then Listing & Trending, then Xpress again — which is what
 * the operator asked for: both running, alternating, rather than one chosen.
 *
 * The cursor is only advanced by the caller AFTER the listing is really
 * created, so a token rejected mid-scan doesn't burn a turn and skew the mix.
 */
function nextPkg(cfg = get(), state = loadState()) {
  const list = cfg.pkgs.length ? cfg.pkgs : [...DEFAULTS.pkgs];
  const turn = ((state.pkgTurn % list.length) + list.length) % list.length; // negatives too
  return { key: list[turn], turn };
}

/** Remember contracts as listed, forever. Called with everything currently on
 *  the site at the top of each scan, and by the paid-listing path the moment a
 *  purchase goes live — a token bought and then deleted before the next scan
 *  would otherwise never make it into the ledger at all. */
async function rememberListed(rows, now = Date.now()) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  if (!list.length) return 0;
  const state = loadState();
  // ⚠️ THE GUARD LIVES HERE, not only at the scan's call site. `fulfillment.js`
  // calls this the moment a PAID listing goes live, and writing over an
  // unreadable state file re-opens every contract the site has ever held for
  // free auto-listing — plus it clears the pace clock, so the next scan
  // publishes immediately. A caller can be wrong about what it is holding; the
  // store cannot.
  if (!state._ok) {
    log.error(`[autolist] refusing to write the state file — ${state._why}. ${list.length} contract(s) not recorded.`);
    return 0;
  }
  let added = 0;
  for (const r of list) {
    if (!r || !r.chain || !r.address) continue;
    const k = keyOf(r.chain, r.address);
    if (state.everListed[k]) continue;
    state.everListed[k] = now;
    added++;
  }
  if (added) await saveJSON(STATE_FILE, state).catch((e) => log.error(`[autolist] could not persist ${STATE_FILE}: ${e.message} — this scan's bookkeeping is lost`));
  return added;
}
const dayKey = (now) => new Date(now).toISOString().slice(0, 10);
const todayCount = (state, now) => (state.day && state.day.key === dayKey(now) ? state.day.n : 0);

/** Everything the service has auto-listed, newest first (for the admin panel). */
function history(limit = 10) {
  const { listed } = loadState();
  return Object.entries(listed)
    .map(([key, v]) => ({ key, ...(typeof v === "object" ? v : { at: v }) }))
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, limit);
}

function stats(now = Date.now()) {
  const state = loadState();
  return {
    total: Object.keys(state.listed).length,
    today: todayCount(state, now),
    everListed: Object.keys(state.everListed).length,
  };
}

// ── The listing pace ────────────────────────────────────────────────────────
//
// One free listing per rolled wait, and the wait is rolled ONCE — at the moment
// a listing goes out — never re-rolled by the scans that follow it.
//
// ⚠️ A fresh roll every scan converges on the FLOOR and the randomness becomes
// decorative: with a scan every 25–90 min, the first roll that happens to land
// under the elapsed time opens the gate, so the effective spacing is the
// minimum of however many rolls fit in the window. This repo has already paid
// for that shape once, in the per-chain trending target, where re-rolling every
// cycle ratcheted the other way and pinned every chain to its maximum. Rolling
// at the listing is the same fix as hashing the trigger off the address: the
// number has to be genuinely reached, and it does not move while you wait.
//
// THE PACE BELONGS TO THE SCAN, and only to the scan. Two other services list
// through `createFromInfo` and neither is touched:
//   • trendFill.fillChain — lists to fill a trending board a chain cannot fill
//     from its own listings. Pacing it would put the "board stays short" saga
//     straight back; its own rate limit is `fillMaxPerCycle`.
//   • chainSeed — an operator-triggered bulk inventory fill. Not a feed event.
// The panel says so, because three listings appearing at once while the pace
// reads 2h–3h is otherwise a bug report.

/** A stored roll, forced into [0,1). See loadState() for why 0 is the fallback. */
function rollOf(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1 ? n : 0;
}

/** How long the wait after a listing is, for a given roll. Pure. */
function paceGapMs(cfg, roll) {
  const lo = Number(cfg.minListGapMin) || 0;
  const hi = Number(cfg.maxListGapMin) || 0;
  return (lo + rollOf(roll) * Math.max(0, hi - lo)) * 60_000;
}

/**
 * The pacing clock as a whole answer: `due` is what gates a listing, and the
 * rest is what the panel prints.
 *
 * Pure, and the ONE owner — the scan, the panel, the scan line and the tests
 * all read it. A screen that computes its own version of a rule eventually
 * disagrees with the rule, which is how the buy card ended up with two ideas of
 * "whale" and showed only one of them.
 */
function pace(cfg = get(), state = loadState(), now = Date.now()) {
  const on = !!cfg.paceListings;
  const gapMs = paceGapMs(cfg, state.paceRoll);
  const lastAt = state.lastListAt || null;
  const nextAt = lastAt == null ? null : lastAt + gapMs;
  // ⚠️ A stamp in the FUTURE is clock skew or a restored backup, not a listing
  // that has not happened yet — and there is no way to learn how long ago the
  // real one was. So the clock is treated as SPENT and the feed goes on. The
  // first cut clamped `lastAt` to `now` instead, which reads as the cautious
  // choice and is the exact opposite: `nextAt` then recedes with every tick and
  // the service never lists again, silently, with a panel still reading 🟢 ON.
  // The next listing overwrites the stamp, so it heals itself.
  const skewed = lastAt != null && lastAt > now;
  // Never listed yet → due now. A fresh install, and every install on the day
  // this ships, must not sit out a wait for a listing that never happened.
  const waitMs = !on || nextAt == null || skewed ? 0 : Math.max(0, nextAt - now);
  return {
    on,
    lastAt,
    nextAt,
    gapMs,
    waitMs,
    skewed,
    due: waitMs <= 0,
    minMin: Number(cfg.minListGapMin) || 0,
    maxMin: Number(cfg.maxListGapMin) || 0,
  };
}

/** Minutes as an operator reads them: "45 min", "2h", "2h30m". One owner, so
 *  the scan log, the panel and the alert cannot spell a duration three ways. */
function fmtGap(mins) {
  const raw = Number(mins) || 0;
  const m = Math.max(0, Math.round(raw));
  // ⚠️ A positive wait under 30s rounds to zero, and the one line whose job is
  // answering "why has nothing been listed" would then state a wait of NONE on
  // a scan that listed nothing because of it. A configured 0 still reads "0
  // min" — that band end is a real setting. No bare "<": these strings reach a
  // parse_mode HTML message, where one would make Telegram reject the whole
  // thing (see the trade bot's `&lt;0.01%`).
  if (m === 0 && raw > 0) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h${r}m` : `${h}h`;
}

/**
 * "2h30m" → 150. The INVERSE of fmtGap, and it lives beside it for that reason
 * — the rule `parseCap` states at its own definition, one module over.
 *
 * Returns null on anything it cannot read, never a number and never a default:
 * a parser that cannot fail is a parser that lies for its caller. An admin sent
 * `500k` to the gainers market-cap floor, `Number()` gave NaN, the clamp swapped
 * in the default, and the bot answered ✅ with a number nobody asked for.
 *
 * ⚠️ A BARE NUMBER IS REFUSED, and that is the one place this parser is strict.
 * "3" is three minutes to this module's storage and three hours to the panel
 * printing "Every 3h" — and guessing wrong by 20× on THIS setting turns the feed
 * into exactly the firehose the pace exists to prevent. One character of unit is
 * cheaper than that. Everything else is generous: h/m, the Indonesian jam/menit
 * an operator here actually types, decimals, spaces, and a compound like 2h30m.
 */
function parseGap(s) {
  const t = String(s == null ? "" : s).trim().toLowerCase().replace(/[\s,]/g, "");
  if (!t) return null;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const fin = (mins) => (mins != null && Number.isFinite(mins) && mins >= 0 ? Math.round(mins) : null);
  // Longest alternatives first — "hour" must not be eaten by "h" and then fail.
  const H = "hours|hour|hrs|hr|jam|h|j";
  const M = "minutes|minute|mins|min|menit|mnt|m";
  // Compound: "2h30m", "2h30", "1jam30menit"
  const both = new RegExp(`^(\\d+(?:\\.\\d+)?)(?:${H})(\\d+(?:\\.\\d+)?)(?:${M})?$`).exec(t);
  if (both) {
    const h = num(both[1]);
    const m = num(both[2]);
    return h == null || m == null ? null : fin(h * 60 + m);
  }
  const h = new RegExp(`^(\\d+(?:\\.\\d+)?)(?:${H})$`).exec(t);
  if (h) return fin((num(h[1]) ?? NaN) * 60);
  const m = new RegExp(`^(\\d+(?:\\.\\d+)?)(?:${M})$`).exec(t);
  if (m) return fin(num(m[1]) ?? NaN);
  return null; // deliberately NO bare-number branch — see the warning above
}

/** The configured band in words — "2h–3h", or one number when it is pinned. */
function paceRange(cfg = get()) {
  const lo = fmtGap(cfg.minListGapMin);
  const hi = fmtGap(cfg.maxListGapMin);
  return lo === hi ? lo : `${lo}–${hi}`;
}

const keyOf = (chain, address) => `${chain}:${String(address).toLowerCase()}`;

/** May the scan list on this chain under the current scope? Empty = all. */
const chainAllowed = (cfg, chain) => cfg.chains.length === 0 || cfg.chains.includes(chain);

/*
 * ⚠️ THE JITTER IS BOUNDED BY THE FLOOR, NOT BY THE BAND'S WIDTH.
 *
 * The band exists so listings land at $1.08M / $1.42M instead of every one at
 * a suspiciously round $1,000,000 — a NARROW smear above the floor. But the
 * trigger used to be drawn uniformly across the WHOLE band, which reads the
 * band top as "how much jitter" when every operator reads it as "up to what
 * size may a token list". The two readings coincide on the shipped $1M–$1.5M
 * and diverge catastrophically apart: an operator set the band to
 * $1M–$100M (with Ignore-above at $100M — plainly "list anything from $1M to
 * $100M") and the mean trigger became $50M. Measured: 0.4% of tokens drew a
 * trigger under $1.5M, so a feed that had listed 105 tokens went to ZERO per
 * day with every panel light green and the pace reading "due now" — the
 * quiet-market look, produced by arithmetic.
 *
 * So the draw spans at most HALF THE FLOOR above the floor (the designed
 * $1M→$1.5M smear, exactly), and the band top past that governs nothing —
 * eligibility's ceiling is `maxMcapHard`, which is its own row. On the shipped
 * band this is bit-for-bit the old draw (span 500k either way), so no
 * existing install's triggers move unless its band was wide — where the old
 * triggers were the defect.
 */
const TRIGGER_JITTER_OF_FLOOR = 0.5;

/** How far above the floor a trigger may land under `cfg`. The panel prints
 *  the effective range from this, so the screen and the draw cannot disagree. */
function triggerJitterSpan(cfg = get()) {
  const band = Math.max(0, cfg.maxMcap - cfg.minMcap);
  return Math.min(band, Math.round(cfg.minMcap * TRIGGER_JITTER_OF_FLOOR));
}

/**
 * This token's own trigger market cap, stable for as long as the band is.
 * @see the header — derived from the address on purpose, never re-rolled.
 */
function triggerMcap(address, cfg = get()) {
  const span = triggerJitterSpan(cfg);
  if (!span) return cfg.minMcap;
  const h = crypto.createHash("sha1").update(String(address).toLowerCase()).digest();
  return cfg.minMcap + (h.readUInt32BE(0) % (span + 1));
}

/**
 * This token's tier on the Listing & Trending package — Diamond, Gold or
 * Silver, drawn from TREND_TIERS.
 *
 * Derived from the ADDRESS for the same reason triggerMcap is: the draw has to
 * be stable. A fresh Math.random() per call would let listingInput() and the
 * channel card disagree about what the token is, and re-listing after a history
 * clear would silently re-label a token the site already showed as Diamond.
 * Different bytes of the same digest, so the tier does not correlate with the
 * trigger cap (every Diamond landing at the top of the band would be a pattern).
 */
function trendTier(address) {
  const h = crypto.createHash("sha1").update(String(address).toLowerCase()).digest();
  return TREND_TIERS[h.readUInt32BE(4) % TREND_TIERS.length];
}

/** The tier an auto listing carries under `pkgKey`. */
function tierFor(pkgKey, address) {
  const p = pkgOf(pkgKey);
  return p.tier === null ? trendTier(address) : p.tier;
}

/**
 * Why this token is NOT getting listed, or null when it qualifies. A single
 * function so every rejection is one readable reason in the log — "nothing was
 * listed today" is otherwise impossible to explain.
 */
function rejectReason(info, cfg, trigger, now = Date.now()) {
  if (!info) return "no market data";
  if (!sanitizeTicker(info.symbol)) return "no usable ticker";
  if (!info.name) return "no name";
  const mcap = Number(info.mcap) || 0;
  if (!mcap) return "no market cap";
  if (mcap < trigger) return `below its trigger ($${Math.round(mcap).toLocaleString("en-US")} < $${trigger.toLocaleString("en-US")})`;
  if (mcap > cfg.maxMcapHard) return `above the ceiling ($${Math.round(mcap).toLocaleString("en-US")})`;
  if ((Number(info.liq) || 0) < cfg.minLiq) return `thin liquidity ($${Math.round(info.liq || 0).toLocaleString("en-US")})`;
  if ((Number(info.vol24) || 0) < cfg.minVol24) return `low 24h volume ($${Math.round(info.vol24 || 0).toLocaleString("en-US")})`;
  if (info.pairCreatedAt && now - info.pairCreatedAt < cfg.minAgeHours * 3_600_000) {
    return `too new (${Math.round((now - info.pairCreatedAt) / 3_600_000)}h old)`;
  }
  return null;
}

/**
 * A URL the site will actually accept, or undefined.
 *
 * Mirrors `adminValidate.URL_RE` (`^https?://\S+$`) deliberately rather than
 * being cleverer than it: the point is to send only what the validator takes,
 * and a second, looser idea of "a URL" here would put the 400 straight back.
 * `https://` is upgraded from a bare `http://`-less host only where the pad gave
 * us something unambiguous — a bare `@handle` is NOT a URL and is dropped,
 * because guessing which network it belongs to is how a listing ends up linking
 * a stranger.
 */
function siteUrl(v) {
  const t = String(v == null ? "" : v).trim();
  if (!t || /\s/.test(t)) return undefined;
  if (/^https?:\/\/\S+$/i.test(t)) return t;
  // `t.me/foo`, `x.com/foo`, `project.io` — a host with a dot and no scheme is
  // a URL somebody forgot to prefix, and the site takes it once it has one.
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(t)) return `https://${t}`;
  return undefined; // a bare handle, a placeholder, or something we cannot vouch for
}

/** The listing payload the site expects for an auto-listed token, shaped by
 *  `pkgKey` — the package whose turn it is (see nextPkg). Defaults to the first
 *  enabled one so a caller that only wants to see the shape need not care. */
function listingInput(chain, address, info, cfg = get(), now = Date.now(), pkgKey = cfg.pkgs[0]) {
  const p = pkgOf(pkgKey);
  const input = {
    chain,
    address,
    sym: sanitizeTicker(info.symbol),
    name: String(info.name).slice(0, 60),
    emoji: "🪙",
    // free → "FREE", which nobody can buy (see lib/packages.ts). xpress → the
    // real XPRESS tier. trending → a real PAID tier, drawn per token: the
    // operator's call, and the one thing here that puts an auto listing on the
    // same footing as a purchase. See the file header for what that changes.
    tier: tierFor(pkgKey, address),
    logoUrl: siteUrl(info.logoUrl),
    // ⚠️ AN OPTIONAL FIELD MAY NOT COST THE WHOLE LISTING. `adminValidate.buildRow`
    // refuses the ENTIRE row with a 400 when a social is not a full http(s) URL —
    // and the launchpad half of `discovery.mergeInfo` fills these holes from pads
    // that publish bare handles (`@project`) and scheme-less hosts (`t.me/x`). So
    // one project's tidy-looking profile turned a qualifying token into a refusal,
    // and until the scan report grew `refused` that was a silent `continue`.
    // Dropping a social we cannot vouch for loses a link; sending it loses the
    // listing, and the link with it.
    website: siteUrl(info.website),
    twitter: siteUrl(info.twitter),
    telegram: siteUrl(info.telegram),
  };
  if (p.trending) {
    // Sub-order only — it marks the row as featured. WHERE it lands on the board
    // is decided by trendingPoster, which sorts by tier first, and this package
    // now carries a real one.
    input.trendingRank = 1;
    input.trendStart = now;
    input.trendExp = now + cfg.trendHours * 3_600_000;
  }
  return input;
}

/**
 * TURN A PRICED TOKEN INTO A LISTING ON THE SITE — the one place that does it.
 *
 * The scan loop below owns the discovery BUDGET (per-run caps, per-day caps,
 * the package rotation, the cooldown memo); this owns the act itself, so the
 * board filler (`trendFill.js`, which has a completely different reason to list
 * something) cannot grow a second idea of what an auto listing is. It also
 * records `everListed`, which is the memo that stops a token that was listed
 * once — and later deleted, or paid for — being handed back free by either
 * caller.
 *
 * Throws what the site threw: the caller decides whether one refusal ends its
 * run, and the two callers answer that differently.
 */
async function createFromInfo(chain, address, info, { cfg = get(), now = Date.now(), pkgKey = 'free' } = {}) {
  // ⚠️ NEVER LIST THE MONEY — and it belongs HERE, not in the callers.
  //
  // "jangan pernah listing stable coin". `bigCoins.topByMcap` has filtered
  // these out of the board FILLER's candidates since it was written, so the
  // rule looked covered — but that is one of three doors. The scan loop lists
  // from the DISCOVERY feeds (DexScreener profiles and boosts, pools.trade),
  // which are not ranked by pool depth and had no such filter at all, and
  // `chainSeed` is a third. This function is the documented one owner of "turn
  // a priced token into a listing", so the gate goes on it and every door is
  // covered at once — including the fourth one somebody adds later.
  //
  // It is a REFUSAL, not a silent skip: `null` is what the callers already read
  // as "the site did not create it", and the line says which token and why so a
  // feed full of stablecoins does not read as a quiet market.
  if (notAProject(info.symbol, info.name)) {
    log.info(`[autolist] refused ${info.symbol} on ${chain} — the money, not a project (stablecoin/wrapper)`);
    return null;
  }
  const input = listingInput(chain, address, info, cfg, now, pkgKey);
  const listing = await api.createListing(input);
  if (!listing) return null;
  await rememberListed({ chain, address }, now);
  return { listing, input };
}

/**
 * One scan. Returns how many tokens were listed. Never throws — a hiccup must
 * not take down the service loop. `deps` is injectable so tests don't touch the
 * network.
 */
/**
 * The two upstream seams, in the shape that can tell a refusal from an answer.
 *
 * A caller injecting the LEGACY `fetchDiscovery` / `fetchTokenInfo` is wrapped
 * as `ok: true` — a stub handing back a record, or null, is asserting that the
 * source ANSWERED, which is what every existing test means by it. Only a real
 * upstream can report "we could not ask", and only the X shapes carry it.
 */
function seams(deps = {}) {
  const discoverX =
    deps.fetchDiscoveryX ||
    (deps.fetchDiscovery
      ? async () => ({ items: (await deps.fetchDiscovery()) || [], ok: true, why: null, sources: [] })
      : ds.fetchDiscoveryX);
  const priceX =
    deps.fetchTokenInfoX ||
    (deps.fetchTokenInfo
      ? async (c, a) => ({ info: await deps.fetchTokenInfo(c, a), ok: true, why: null })
      : ds.fetchTokenInfoX);
  return { discoverX, priceX };
}

async function runOnce({ tg, now = Date.now(), deps = {}, rng = Math.random } = {}) {
  const cfg = get();
  const report = blank(now);
  const rd = configOk();
  if (!rd.ok) {
    // Not the OFF branch: this service has NOT been switched off, we simply
    // cannot tell what it was set to.
    return await halt(report, `cannot read ${FILE} — ${rd.why}. Auto-Listing is halted; its settings are NOT lost, but nothing will be listed until that file is readable.`);
  }
  if (!cfg.enabled) {
    // ⚠️ AN OFF SERVICE STILL FILES ITS REPORT. It used to return here in
    // silence — "not a fault, and not worth a report" — and the consequence was
    // that `state.scan` went stale, so `alScanLine` printed "⚠️ The scanner has
    // gone quiet … the loop has stopped" over a service the operator had simply
    // switched off, and sent them to pm2 logs to look for a process that was
    // running perfectly. A stale report is supposed to mean the LOOP stopped;
    // it can only mean that if every other reason files one. Same rule as
    // `lastCheckedAt` vs `lastOkAt` on the auto-raid panel.
    report.off = true;
    await fileReport(report, loadState());
    return 0;
  }
  // ⚠️ THE `X` SHAPES, because "it answered with nothing" and "it did not answer"
  // are different facts and this service used to render them identically. An
  // injected LEGACY dep is wrapped rather than refused: a stub that returns a
  // record or null is stating "it answered", which is exactly what a test means.
  const { discoverX, priceX } = seams(deps);

  let state = loadState();
  if (!state._ok) {
    // The ledger is the only thing standing between a deleted PAID listing and
    // a free re-list, so a scan that cannot read it must not run at all — and
    // must certainly not persist the empty one it just fell back to.
    return await halt(
      report,
      `cannot read the auto-lister's own state — ${state._why}. The never-relist ledger lives in that file, so the ` +
        `scan refuses to run rather than risk handing a previously PAID listing back for free. Fix or delete ` +
        `${STATE_FILE} in DATA_DIR — deleting it re-opens every contract the site has ever held.`,
    );
  }
  let today = todayCount(state, now);
  if (today >= cfg.maxPerDay) {
    // A cap the operator set, doing exactly what they set it to do. Reported so
    // the panel can say so, but never a blocker — this is not a fault.
    report.capped = `${today}/${cfg.maxPerDay}`;
    await fileReport(report, state);
    return 0;
  }

  let candidates;
  let sources = [];
  try {
    const d = await discoverX();
    candidates = d.items || [];
    sources = d.sources || [];
  } catch (e) {
    report.blocker = `discovery failed: ${e.message}`;
    log.warn(`[autolist] ${report.blocker}`);
    await fileReport(report, state);
    return 0;
  }
  report.candidates = candidates.length;
  report.sources = sources;
  if (!candidates.length) {
    // ⚠️ NAME WHAT ACTUALLY HAPPENED. This used to assert "every source empty"
    // for every way discovery can fail — and all three DexScreener feeds live
    // on ONE host, so a single 403 takes them together and the operator was
    // sent to look for a quiet market. `sources` carries each one's own answer;
    // a source that ANSWERED with nothing and one that would not answer at all
    // are different problems with different fixes.
    const down = sources.filter((x) => !x.ok);
    report.blocker = down.length
      ? `discovery could not reach ${down.length === sources.length ? "any source" : "some sources"} — ` +
        down.map((x) => `${x.name}: ${x.why}`).join(" · ")
      : "discovery returned no candidates (every source answered, with nothing — DexScreener feeds and pools.trade)";
    // To pm2 too, not just the panel: an operator grepping `autolist` during an
    // outage saw NOTHING between two healthy scans — hours of silence that read
    // as the loop having died, when it was running and being starved.
    log.warn(`[autolist] ${report.blocker}`);
    await fileReport(report, state);
    return 0;
  }

  // Anything already on the site is off the table, however it got there.
  let known = new Set();
  try {
    const rows = await api.getListings();
    // Every row this cycle, whatever its status: a contract sitting in the
    // review queue must not be auto-listed out from under the admin looking at
    // it, and a rejected one must not be handed back on the same pass.
    known = new Set(rows.map((r) => keyOf(r.chain, r.address)));
    // …and a row that was really LISTED stays off the table after it is gone.
    //
    // ⚠️ APPROVED ONLY. This used to fold the site's ENTIRE roster into a
    // PERMANENT ledger — so anyone posting a contract to the public listing form
    // (unauthenticated, `pending`) locked that token out of free auto-listing for
    // ever, as did every submission an admin rejected. The ledger's stated job is
    // "a token that was listed once, including a paid one later deleted, is never
    // handed back free"; a row nobody ever listed is not that, and the only
    // eraser is 🧹 Clear history, which re-opens everything at once.
    const added = await rememberListed(
      rows.filter((r) => (r.status || "approved") === "approved"),
      now,
    );
    if (added) {
      state = loadState(); // rememberListed wrote through — re-read before use
      log.debug(`[autolist] ledger +${added} (${Object.keys(state.everListed).length} contracts remembered)`);
    }
  } catch (e) {
    // Without this list we could double-list a paying customer's token — that is
    // worse than skipping a cycle, so bail instead of guessing. This is the
    // other silent killer: a wrong INTERNAL_API_TOKEN, a moved DEXVRA_API_BASE
    // or a site that is down stops every scan here, and used to do it at debug
    // level where nobody would ever see it.
    report.blocker = `site API unreachable: ${e.message}`;
    log.warn(`[autolist] ${report.blocker}`);
    await fileReport(report, state);
    return 0;
  }

  // ── The pace gate ─────────────────────────────────────────────────────────
  // Deliberately AFTER discovery and the ledger fold and BEFORE the first price
  // lookup. Those two calls are the only things that prove this service can
  // still see the market and reach the site — the blocked-scan watchdog is
  // built on them — so gating above them would cut its resolution from every
  // 25–90 min to once per rolled wait, and BLOCKED_ALERTS_AT would stop meaning
  // 1.5–4.5 hours. Everything past this point costs a DexScreener lookup per
  // candidate, and a scan that may not list has no use for one.
  const p = pace(cfg, state, now);
  if (!p.due) {
    report.paced = { waitMs: p.waitMs, nextAt: p.nextAt, gapMs: p.gapMs };
    await fileReport(report, state);
    // At INFO, not debug: with a 2–3h pace this is what most scans do, and
    // "why has nothing been listed" has to be answerable from pm2 alone. A
    // paced scan that logged nothing would look exactly like a dead loop.
    log.info(`[autolist] scan: ${scanLine(report)}`);
    return 0;
  }

  state.cool = pruneCool(state.cool, now);
  // While pacing is on a scan lists AT MOST ONE token: `maxPerRun` says how big
  // a burst may be, and a paced feed has no bursts.
  const perRun = p.on ? 1 : cfg.maxPerRun;
  let listedNow = 0;
  let lookups = 0;
  for (const c of candidates) {
    if (listedNow >= perRun || today >= cfg.maxPerDay) break;
    if (lookups >= cfg.maxLookupsPerRun) break;
    const key = keyOf(c.chain, c.address);
    // Three separate reasons to leave it alone: this service already picked it,
    // it is on the site right now, or it EVER was. The third is the one that
    // stops a deleted (or previously paid-for) listing being handed back free.
    if (state.listed[key] || known.has(key) || state.everListed[key]) {
      report.known++;
      continue;
    }
    // ⚠️ COUNTED, not skipped in silence. `discovery` maps a feed entry back to
    // our chain id before it is ever offered here, so a candidate that cannot be
    // resolved means the two directions of that map disagree — one whole chain
    // discovered and then dropped, with the panel showing candidates that
    // vanish between "seen" and "priced" and no line anywhere naming the chain.
    if (!chainOf(c.chain)) {
      report.unsupported++;
      continue;
    }
    // The operator's chain scope. Skipped BEFORE any lookup is spent, which is
    // the entire point of focusing: the whole pricing budget goes to the
    // chosen chains instead of being burned on the market's loudest one.
    if (!chainAllowed(cfg, c.chain)) {
      report.offChain++;
      continue;
    }
    // Turned down recently and nowhere near qualifying. Costs no lookup, which
    // is the entire point: the budget goes to tokens we have not just judged.
    if (state.cool[key] > now) {
      report.cooled++;
      continue;
    }

    lookups++;
    report.priced++;
    const ans = await priceX(c.chain, c.address).catch((e) => ({ info: null, ok: false, why: e.message }));
    // ⚠️ "WE COULD NOT ASK" IS NOT "THIS TOKEN HAS NO MARKET".
    //
    // A refusal used to arrive here as a bare null, `rejectReason` rendered it
    // as "no market data" — a claim about the TOKEN — and `coolUntil` then
    // benched it for TWELVE HOURS. So a DexScreener refusing this box produced
    // `40 priced · 0 listed — no market data ×40`, which reads as a quiet
    // market, and the damage outlived the outage by half a day. It is its own
    // counter, its own sentence, and it writes NO cool entry: the miss-vs-
    // undecided line `logoFill` draws, on the path that publishes listings.
    if (!ans.ok) {
      report.unpriced++;
      const b = reasonBucket(ans.why || "could not price it");
      report.unpricedWhy[b] = (report.unpricedWhy[b] || 0) + 1;
      log.debug(`[autolist] could not price ${c.chain}/${c.address}: ${ans.why}`);
      continue;
    }
    const info = ans.info;
    const trigger = triggerMcap(c.address, cfg);
    const why = rejectReason(info, cfg, trigger, now);
    if (why) {
      const bucket = reasonBucket(why);
      report.reasons[bucket] = (report.reasons[bucket] || 0) + 1;
      const until = coolUntil(why, info, cfg, trigger, now);
      if (until > now) state.cool[key] = until;
      log.debug(`[autolist] skip ${c.chain}/${c.address}: ${why}`);
      continue;
    }
    delete state.cool[key];

    // Whose turn it is. Read fresh from `state` each time so several listings in
    // ONE scan still alternate instead of all taking the same package.
    const { key: pkgKey } = nextPkg(cfg, state);
    let made;
    try {
      made = await createFromInfo(c.chain, c.address, info, { cfg, now, pkgKey });
    } catch (e) {
      // ON THE REPORT, not only in pm2. This token cleared every gate the
      // operator set and the site turned it down; "0 listed" with an empty
      // reason tally says the market was quiet, which is the opposite of what
      // happened. See `refused` in blank() for what that cost.
      noteRefusal(report, e.message);
      // ⚠️ A 4xx IS A FACT ABOUT THIS TOKEN'S PAYLOAD and will not change on the
      // next scan — an unparseable social, a ticker the site's validator will
      // never take. Without a memo the same token is re-priced and re-refused
      // every 25–90 min for ever, spending one of `maxLookupsPerRun` each time;
      // a handful near the head of a focused chain's candidate list is enough to
      // crowd out everything listable. A 5xx or a transport failure is a fact
      // about the SITE and is deliberately NOT memoed — cooling that would hide
      // an outage behind a bookkeeping entry, which is the line `logoFill` draws
      // between a decided miss and an undecided one.
      // ⚠️ AND NOT EVERY 4xx IS ABOUT THE PAYLOAD. 401/403/429/451 are the site
      // refusing US — they apply to every token equally, so memoing them would
      // bench the entire candidate list over a credentials problem and leave the
      // feed dead long after the token was fixed. Only a VALIDATOR refusal is a
      // fact about this row.
      const st = Number((String(e.message).match(/→\s*(\d{3})/) || [])[1]);
      if (PAYLOAD_REFUSAL.has(st)) state.cool[key] = now + 12 * HOUR_MS;
      log.warn(`[autolist] createListing ${sanitizeTicker(info.symbol)} (${c.chain}): ${e.message}`);
      continue;
    }
    if (!made) {
      // A 2xx carrying no listing. Different sentence from a thrown refusal —
      // the request succeeded and the row still does not exist — and the same
      // rule: it may not be silent.
      noteRefusal(report, "the site accepted the request but returned no listing");
      log.warn(`[autolist] createListing ${sanitizeTicker(info.symbol)} (${c.chain}): no listing returned`);
      continue;
    }
    const { input } = made;

    state.listed[key] = { at: now, sym: input.sym, mcap: Math.round(info.mcap), trigger, pkg: pkgKey, tier: input.tier };
    // `everListed` is written by createFromInfo — re-read so this scan's own
    // later iterations see it, rather than writing a second, older value here.
    state.everListed = loadState().everListed;
    // Advanced HERE, not at the top of the loop: a token rejected by its trigger
    // or refused by the site must not consume a turn, or the mix drifts toward
    // whichever package happens to follow the rejections.
    state.pkgTurn += 1;
    today += 1;
    listedNow += 1;
    state.day = { key: dayKey(now), n: today };
    // The clock starts at the listing, and the wait that follows it is rolled
    // HERE — once, for this listing — never by the scans that come after. See
    // pace(): re-rolling on each scan collapses the spacing to the floor.
    state.lastListAt = now;
    state.paceRoll = rng();
    await saveJSON(STATE_FILE, state).catch((e) => log.error(`[autolist] could not persist ${STATE_FILE}: ${e.message} — this scan's bookkeeping is lost`));
    log.info(
      `[autolist] listed ${input.sym} on ${c.chain} at $${Math.round(info.mcap).toLocaleString("en-US")} ` +
        `(its trigger was $${trigger.toLocaleString("en-US")}) as "${pkgOf(pkgKey).label}"` +
        `${input.tier && input.tier !== "FREE" ? ` [${input.tier}]` : ""} — ` +
        `${today}/${cfg.maxPerDay} today` +
        (p.on ? ` — next free listing in ${fmtGap(paceGapMs(cfg, state.paceRoll) / 60_000)}` : ""),
    );

    if (cfg.postChannel && tg) await announce(tg, c, info, input, cfg).catch(() => {});
    // ⚠️ EVERY FREE LISTING IS REPORTED TO THE VISITOR CHANNEL, and it is
    // reported whether or not it was ANNOUNCED.
    //
    // "setiap free listing harus ada kirim laporan di channel dexvra visitor,
    // bawah free listing yang jelas". Until now a free listing left no trace an
    // operator could read: `announce()` only fires when 📣 Post to channel is on
    // AND the package is the one that reaches @dexvraio, so `free` and `xpress`
    // auto listings — the great majority — went live with nothing but a pm2
    // line. The site gained a row and the operator learned about it by looking
    // at the site.
    //
    // `log.report` is the visitor-channel transport this repo already uses for
    // business events (a /start, a purchase). It is deliberately NOT
    // de-duplicated: two listings that look alike are two real listings, and
    // collapsing them would hide the feed. A failure to post must never cost
    // the listing, which has already happened.
    reportFreeListing(c, info, input, pkgKey, { today, cap: cfg.maxPerDay });
  }
  report.listed = listedNow;
  // ⚠️ EVERY CREATE REFUSED IS A BLOCKED SCAN, not a quiet market.
  //
  // `fileReport` draws that line deliberately narrowly — "a scan that priced
  // forty tokens and liked none of them is the service working correctly, and
  // paging for that is how a monitor gets muted". This is the other case, and
  // it fits that definition exactly: these tokens cleared every gate, so the
  // scan HAD something to list and could not. A rotated INTERNAL_API_TOKEN, a
  // moved DEXVRA_API_BASE, a payload the site's validator now rejects and a 500
  // all land here, and until this line existed all four read as "0 listed".
  //
  // Only when NOT ONE create landed: a scan that listed something and refused
  // one token has a per-token problem, which the panel now prints, and paging
  // for it would be the muted monitor again.
  // ⚠️ EVERY CANDIDATE UNPRICEABLE IS A BLOCKED SCAN. The pricing host refusing
  // this box is not a market that has nothing — it is the scan unable to judge
  // anything at all, and it used to print as "no market data ×40". Checked
  // BEFORE the refusal ladder below because a scan that could price nothing
  // never reached a create.
  if (!listedNow && report.unpriced > 0 && report.unpriced === report.priced) {
    const [why, n] = Object.entries(report.unpricedWhy).sort((a, b) => b[1] - a[1])[0];
    report.blocker =
      `could not price a single one of ${report.priced} candidate(s) — ` +
      `most common: ${why}${n < report.unpriced ? ` (×${n})` : ""}`;
    log.warn(`[autolist] ${report.blocker}`);
  } else if (!listedNow && report.refused > 0) {
    const [why, n] = Object.entries(report.refusals).sort((a, b) => b[1] - a[1])[0];
    report.blocker =
      `the site refused all ${report.refused} listing(s) this scan — ` +
      `most common: ${why}${n < report.refused ? ` (×${n})` : ""}`;
    log.warn(`[autolist] ${report.blocker}`);
  }
  await fileReport(report, state);
  // One line per scan at INFO, so pm2 logs alone answer "is it running and what
  // is it finding" without DEBUG. Previously the only INFO line was a successful
  // listing, so a service finding nothing logged nothing at all.
  log.info(`[autolist] scan: ${scanLine(report)}`);
  return listedNow;
}

/** A scan report as one line — used by the log, the panel and the test scan, so
 *  all three describe a scan the same way. */
function scanLine(report) {
  if (report.off) return "the service is switched OFF — nothing is scanned or listed";
  if (report.blocker) return `⛔ ${report.blocker}`;
  if (report.capped) return `daily cap reached (${report.capped}) — nothing more today, by your setting`;
  if (report.paced)
    return (
      // The candidate count rides along on purpose: it is the proof that
      // discovery is alive, and without it a long paced stretch reads as a
      // service that has gone blind.
      `${report.candidates} candidates seen · paced — next free listing due in ` +
      `${fmtGap(report.paced.waitMs / 60_000)} (this wait: ${fmtGap(report.paced.gapMs / 60_000)})`
    );
  const head =
    `${report.candidates} candidates · ${report.priced} priced · ${report.listed} listed` +
    (report.known ? ` · ${report.known} already known` : "") +
    (report.cooled ? ` · ${report.cooled} on cool-off` : "") +
    (report.offChain ? ` · ${report.offChain} outside chain scope` : "") +
    // A chain the two halves of the DexScreener slug map disagree about. Named
    // here because it is the difference between "the market is quiet" and "a
    // whole network never reaches the pricing step".
    (report.unsupported ? ` · ${report.unsupported} on an unmappable chain` : "");
  // REFUSALS LEAD THE TALLY, and they are a separate clause from the market
  // rejections. "below its trigger ×38" is the market; "the site refused it" is
  // us, and reading the second as the first is what made this invisible.
  const parts = [];
  if (report.unpriced) {
    const t = Object.entries(report.unpricedWhy || {}).sort((a, b) => b[1] - a[1])[0];
    parts.push(`⚠️ ${report.unpriced} could not be priced${t ? ` (${t[0]})` : ""}`);
  }
  if (report.refused) {
    const top = Object.entries(report.refusals || {}).sort((a, b) => b[1] - a[1])[0];
    parts.push(`⚠️ ${report.refused} refused by the site${top ? ` (${top[0]})` : ""}`);
  }
  const why = Object.entries(report.reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([r, n]) => `${r} ×${n}`)
    .join(" · ");
  if (why) parts.push(why);
  return parts.length ? `${head} — ${parts.join(" · ")}` : head;
}

/**
 * Price this scan's candidates and report the verdicts WITHOUT listing anything.
 *
 * The panel's "🔎 Test scan": an operator asking "why has nothing been listed?"
 * gets the answer in seconds instead of waiting out a 25–90 minute gap and still
 * having nothing to read. Deliberately read-only — it makes no listings, writes
 * no state and posts nothing, so it is safe to tap while the service is off, and
 * it runs in @dexvraadminbot, which is not the process that posts to channels.
 *
 * Bounded to DRY_LOOKUPS rather than the service's own maxLookupsPerRun: this
 * runs inside a button tap, and 40 serial quotes at an 8s timeout each is up to
 * five minutes of a panel that looks frozen. A sample is enough to tell "the
 * market has nothing" from "the service is broken", which is the entire
 * question. `sampled` on the report says so, so the panel never implies the
 * sample was the whole scan.
 */
const DRY_LOOKUPS = 15;

async function dryRun({ now = Date.now(), deps = {} } = {}) {
  const cfg = get();
  const { discoverX, priceX } = seams(deps);
  const report = blank(now);
  const state = loadState();

  let candidates;
  let sources = [];
  try {
    const d = await discoverX();
    candidates = d.items || [];
    sources = d.sources || [];
  } catch (e) {
    report.blocker = `discovery failed: ${e.message}`;
    return report;
  }
  report.candidates = candidates.length;
  report.sources = sources;
  if (!candidates.length) {
    const down = sources.filter((x) => !x.ok);
    report.blocker = down.length
      ? `discovery could not reach ${down.length === sources.length ? "any source" : "some sources"} — ` +
        down.map((x) => `${x.name}: ${x.why}`).join(" · ")
      : "discovery returned no candidates (every source answered, with nothing — DexScreener feeds and pools.trade)";
    return report;
  }

  let known = new Set();
  try {
    known = new Set((await api.getListings()).map((r) => keyOf(r.chain, r.address)));
  } catch (e) {
    report.blocker = `site API unreachable: ${e.message}`;
    return report;
  }

  // ⚠️ AND CAN THE SITE ACTUALLY TAKE A LISTING? The read above proves only that
  // it answers. This button exists to answer "why has nothing been listed?", and
  // until it asked this it reported "2 qualify — a real scan would list the first
  // one" over a service whose every create was being refused: the diagnostic and
  // the engine disagreeing, in the reassuring direction. `api.canCreate()` is the
  // one owner — `listing:check` asks the same question the same way — and it
  // probes with a payload the site's validator refuses outright, so it cannot
  // create anything.
  const canCreate = deps.canCreate || api.canCreate;
  const write = await canCreate().catch((e) => ({ ok: false, status: null, why: e.message }));
  report.write = write;
  if (!write.ok) {
    report.blocker = `the site will not take a listing: ${write.why}`;
    return report;
  }

  // What the PACE would do to these verdicts. On its own field, never
  // `report.paced`: that one flips scanLine into the paced branch, and a test
  // scan exists to report the MARKET — hiding the verdicts behind the wait
  // would answer a question the operator did not ask. The panel reconciles the
  // two. Without this, "2 would be listed right now" printed four lines under
  // "next one due in 2h30m" — a screen contradicting itself, which is the
  // defect this whole feature keeps being audited for.
  report.pace = pace(cfg, state, now);
  report.qualified = [];
  const budget = Math.min(DRY_LOOKUPS, cfg.maxLookupsPerRun);
  for (const c of candidates) {
    if (report.priced >= budget) {
      report.sampled = true; // more candidates remain — say so rather than imply a full scan
      break;
    }
    const key = keyOf(c.chain, c.address);
    if (state.listed[key] || known.has(key) || state.everListed[key]) {
      report.known++;
      continue;
    }
    if (!chainOf(c.chain)) {
      report.unsupported++;
      continue;
    }
    // The scope IS honoured here, unlike the cool-off below: the cool-off is
    // this service's bookkeeping, the scope is the operator's setting, and a
    // test scan that prices chains the real scan will never list on reports a
    // market that does not exist for this service.
    if (!chainAllowed(cfg, c.chain)) {
      report.offChain++;
      continue;
    }
    // The cool-off is NOT honoured here. A test scan is the operator asking what
    // the market looks like right now; answering from a memo would show them the
    // service's bookkeeping instead.
    report.priced++;
    const ans = await priceX(c.chain, c.address).catch((e) => ({ info: null, ok: false, why: e.message }));
    // The same line the real scan draws: a source that would not answer must
    // not be reported to the operator as a token with no market. This is the
    // button they tap to ask "why has nothing been listed" — answering it with
    // the wrong fact is the whole reason it exists.
    if (!ans.ok) {
      report.unpriced++;
      const b = reasonBucket(ans.why || "could not price it");
      report.unpricedWhy[b] = (report.unpricedWhy[b] || 0) + 1;
      continue;
    }
    const info = ans.info;
    const trigger = triggerMcap(c.address, cfg);
    const why = rejectReason(info, cfg, trigger, now);
    if (why) {
      const bucket = reasonBucket(why);
      report.reasons[bucket] = (report.reasons[bucket] || 0) + 1;
      continue;
    }
    report.listed++; // what a real scan WOULD have listed
    if (report.qualified.length < 5) {
      report.qualified.push({ chain: c.chain, sym: sanitizeTicker(info.symbol), mcap: Math.round(info.mcap), trigger });
    }
  }
  return report;
}

/** The banner/artwork for one of the two cards — same pipeline a paid listing
 *  uses, so an auto listing looks like every other post. */
function postMediaFor(kind, c, info, input) {
  const { postMedia } = require("../fulfillment");
  return postMedia(
    kind,
    {
      symbol: input.sym,
      name: input.name,
      chain: String(chainOf(c.chain) ? chainOf(c.chain).label : c.chain).toUpperCase(),
      price: info.priceUsd ? `$${Number(info.priceUsd).toPrecision(4)}` : "TBA",
      mcap: info.mcap ? `$${Math.round(info.mcap).toLocaleString("en-US")}` : null,
      links: { website: input.website, twitter: input.twitter, telegram: input.telegram },
    },
    null,
    null,
    input.logoUrl || "",
    badgeFor(input.tier),
  );
}

/** The artwork's tier badge, worded exactly as fulfillment.js words it for a
 *  purchase — a Gold auto listing and a Gold purchase must not be two different
 *  looking things. "FREE" gets no badge: there is no such package to wear. */
function badgeFor(tier) {
  if (tier === "XPRESS") return "Xpress Listing";
  if (!tier || tier === "FREE") return null;
  return `${tierLabel(tier)} Tier`;
}

/**
 * Channel post(s) for an auto listing, following the package it was LISTED
 * under:
 *   free     → the listing card with NO tier badge (it wasn't bought, so it
 *              must not wear a package's colours)
 *   xpress   → the Xpress card, same as a paid Xpress listing
 *   trending → the listing card carrying its drawn tier, the Trending card in
 *              @dexvratrending, AND the listing card again in @dexvraio
 *
 * Which package that was is read off `input`, not off the config: a rotation
 * means the config's first package is frequently NOT the one this token got,
 * and a post that describes a different package than the listing is worse than
 * no post. `input.tier` and `input.trendExp` are what the site was actually
 * told, so they are what the card follows.
 *
 * And a tweet, on the same terms as a paid listing (X_AUTOLIST_ENABLED=0 turns
 * only this path off). EVERY listing goes to X — an auto listing that reached
 * the channels but not the feed was the one hole in that rule, and it is the
 * hole most listings fell through once auto-listing was switched on.
 */
/**
 * The visitor-channel line for a listing this service put on the site.
 *
 * PLAIN and complete on purpose: what went live, on which chain, which package
 * it was listed under, what it was worth at the moment it was listed, and where
 * to look. An operator reading the visitor channel should not have to open the
 * site to learn what happened — that is the state this replaces.
 *
 * Never throws: it runs after the listing is already live, and a channel that
 * is unreachable must not turn a successful listing into a failed scan.
 */
function reportFreeListing(c, info, input, pkgKey, { today, cap } = {}) {
  try {
    const pkg = pkgOf(pkgKey);
    const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const money = (n) => (Number.isFinite(Number(n)) ? fmtCap(Number(n)) : "—");
    const chain = (chainOf(c.chain) && chainOf(c.chain).label) || c.chain;
    log.report(
      `🆓 <b>FREE LISTING</b> — <b>${esc(input.sym)}</b> is live on Dexvra\n` +
        `<b>${esc(input.name)}</b> · ${esc(chain)}\n` +
        `Package: <b>${esc(pkg.label)}</b>${input.tier && input.tier !== "FREE" ? ` · tier <b>${esc(input.tier)}</b>` : ""}` +
        `${input.trendExp != null ? " · <b>on the Trending board</b>" : ""}\n` +
        `Cap ${money(info.mcap)} · Liq ${money(info.liq)} · 24h vol ${money(info.vol24)}\n` +
        `<a href="${esc(SITE_URL)}/token/${esc(c.chain)}/${esc(c.address)}">Open on dexvra.io</a>` +
        `${Number.isFinite(Number(today)) ? ` · ${esc(today)}/${esc(cap)} free listings today` : ""}\n` +
        `<code>${esc(c.address)}</code>`,
    );
  } catch (e) {
    // The listing is already live. This line is a report about it, and a report
    // that throws must not be why a scan is recorded as having failed.
    log.debug(`[autolist] free-listing report: ${e.message}`);
  }
}

async function announce(tg, c, info, input, cfg = get()) {
  const isTrending = input.trendExp != null;
  const coin = {
    name: input.name,
    symbol: input.sym,
    chain: c.chain,
    address: c.address,
    price: info.priceUsd,
    mcap: info.mcap,
    liq: info.liq,
    // Whatever tier the listing really carries — XPRESS, or the Diamond/Gold/
    // Silver the trending package drew. "FREE" is not a badge anyone can buy,
    // so it stays off the card.
    tier: input.tier && input.tier !== "FREE" ? input.tier : undefined,
    links: { website: input.website, twitter: input.twitter, telegram: input.telegram },
    siteUrl: `${SITE_URL}/token/${c.chain}/${c.address}`,
  };
  try {
    // Same as a paid listing: create the token's animated custom emoji BEFORE
    // the card is rendered, or the post shows the plain fallback char where the
    // logo belongs (fmt.listingPost reads the pack id synchronously).
    await require("../tokenEmoji")
      .ensureFromUrl({ chain: c.chain, address: c.address, symbol: input.sym }, input.logoUrl)
      .catch(() => null);
    const media = await postMediaFor("listing", c, info, input).catch(() => null);
    // Tweet BEFORE the channel post, exactly like fulfillment.js, so the card
    // can carry its "Announce On X" link. Timeboxed: a hung X API delays the
    // channel post by at most X_POST_TIMEOUT_MS, and the tweet id is still
    // recorded whenever it lands, so a later pump/rank-up alert can quote it.
    await tweetListing(coin, c, input, media);
    const msg = await post.sendMedia(CHANNELS.listing, media, fmt.listingPost(coin), { pin: true });
    if (msg) log.info(`[autolist] posted ${input.sym} → ${CHANNELS.listing}/${msg.message_id}`);
    await post.mirrorToGroup(CHANNELS.listing, msg, { label: "auto-listing" });
    // @dexvraio — the announcement channel. A PAID listing only reaches it on
    // tier #1–#3 (packages.js `announce: true` → fulfillment.js); an AUTO
    // listing reaches it on the "Listing & Trending" package and nothing else.
    // That is the operator's rule (2026-08-04): the free package that also puts
    // the token on the board is the one worth announcing, so `free` and
    // `xpress` auto listings stay out of @dexvraio entirely.
    //
    // Same card, same pin as a tier #1–#3 paid listing — @dexvraio is a
    // megaphone for what just went live, and a second shape for the same event
    // would only make the channel harder to read. Since this package draws a
    // real tier, the card is now indistinguishable from a purchase of that
    // tier: deliberate, and the operator's call. Nothing downstream tells them
    // apart either, so `state.listed` is the only record of which is which.
    const annMsg =
      isTrending && cfg.announceChannel
        ? await post.sendMedia(CHANNELS.announce, media, fmt.listingPost(coin), { pin: true })
        : null;
    if (annMsg) log.info(`[autolist] announced ${input.sym} → ${CHANNELS.announce}/${annMsg.message_id}`);
    await postids.set(c.chain, c.address, {
      listingMsgId: msg && msg.message_id,
      // Pump alerts reply UNDER the announcement (pumpChecker reads annMsgId).
      // Without recording it, an auto-announced token's pump alert would land
      // only in the listing channel — one channel short of where its card is.
      annMsgId: annMsg && annMsg.message_id,
    }).catch(() => {});
    if (isTrending) {
      const tMedia = await postMediaFor("trending", c, info, input).catch(() => null);
      const tMsg = await post.sendMedia(CHANNELS.trending, tMedia, fmt.trendingPost(coin));
      if (tMsg) log.info(`[autolist] posted ${input.sym} → ${CHANNELS.trending}/${tMsg.message_id}`);
    }
  } catch (e) {
    log.warn(`[autolist] post ${input.sym}: ${e.message}`);
  }
}

/** Tweet an auto listing and hang the resulting url on `coin.xUrl` (mutates, so
 *  the caller's already-built coin object carries it into the channel card).
 *  Never throws and never blocks longer than the timeout. */
async function tweetListing(coin, c, input, media) {
  if (!X_AUTOLIST_ENABLED || !x.enabled()) return null;
  // Same artwork the channel card uses; the logo is only the fallback.
  const logo = await fetchLogo(input.logoUrl);
  const tweetP = x.postListing(coin, media, logo).catch(() => null);
  tweetP
    .then((id) => (id ? postids.set(c.chain, c.address, { listingTweetId: id }) : null))
    .catch(() => {});
  const id = await Promise.race([tweetP, new Promise((r) => setTimeout(r, X_POST_TIMEOUT_MS, null))]);
  if (id) {
    coin.xUrl = `https://x.com/i/status/${id}`;
    log.info(`[autolist] tweeted ${input.sym} → ${coin.xUrl}`);
  }
  return id;
}

/** The token logo as a Buffer for the tweet's media, or null. Best-effort. */
async function fetchLogo(logoUrl) {
  if (!logoUrl) return null;
  const url = String(logoUrl).startsWith("http") ? logoUrl : `${SITE_URL}${logoUrl}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * How long until the next scan. Pure, so the rule below is testable without a
 * timer — and it is a rule, not a formula.
 *
 * The cadence is its own random band (a fixed heartbeat puts every listing on
 * the same minute of the hour, the other half of looking machine-run), and it
 * is ALSO never allowed to sleep past the moment the listing pace opens.
 *
 * ⚠️ Without that second half a paced feed is the wait PLUS a scan gap: a rolled
 * 2h13m served by a loop that next wakes 40 min later publishes at 2h53m, and
 * over a day a band labelled "2h–3h" quietly means 2h–4h30m. Measured on a
 * simulated day before this was added — gaps of 134, 173, 192, 212 and 225 min
 * against a 120–180 band. `min()` can only ever make a scan SOONER, so the
 * blocked-scan watchdog keeps every bit of its resolution.
 */
function nextScanDelayMs(cfg = get(), state = loadState(), now = Date.now(), rng = Math.random) {
  let ms = (cfg.minGapMin + rng() * (cfg.maxGapMin - cfg.minGapMin)) * 60_000;
  const p = pace(cfg, state, now);
  // Just AFTER it opens, and jittered, so the listings do not land on a clock
  // of their own either — the pace is the thing that must not look generated.
  if (p.on && p.waitMs > 0) ms = Math.min(ms, p.waitMs + (30 + rng() * 240) * 1000);
  // Belt and braces. The 30s in the jitter above already guarantees this, so
  // the floor is unreachable today and is here only so that changing the jitter
  // cannot turn the loop into a spin. Nothing tests it as a live branch,
  // because claiming coverage of a branch that cannot be reached is worse than
  // having none.
  return Math.max(30_000, ms);
}

/**
 * Start the loop. Self-reschedules with a RANDOM gap (never setInterval) —
 * see nextScanDelayMs for the two rules that gap answers to.
 */
function start(tg, { rng = Math.random } = {}) {
  let timer = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    const ms = nextScanDelayMs(get(), loadState(), Date.now(), rng);
    log.debug(`[autolist] next scan in ${(ms / 60_000).toFixed(1)}min`);
    timer = setTimeout(run, ms);
    if (timer.unref) timer.unref();
  };
  const run = async () => {
    try {
      await runOnce({ tg });
    } catch (e) {
      // ERROR, not debug. An exception escaping runOnce is a scan that did not
      // happen, and at debug level — which production does not print — it is
      // byte-identical to a loop that never ran.
      log.error(`[autolist] scan threw: ${(e && e.stack ? String(e.stack).split("\n")[0] : e)}`);
    }
    schedule();
  };
  // Random boot delay for the same reason — a restart must not put every scan
  // back on the same clock.
  timer = setTimeout(run, (30 + rng() * 120) * 1000);
  if (timer.unref) timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

module.exports = {
  get,
  set,
  chainAllowed,
  togglePkg,
  nextPkg,
  trendTier,
  tierFor,
  badgeFor,
  PKG_KEYS,
  TREND_TIERS,
  reset,
  resetState,
  rememberListed,
  /** Has this token EVER been auto-listed? The filler must not re-list one the
   *  operator deleted, same rule the scan already follows. */
  wasEverListed: (chain, address) => !!loadState().everListed[keyOf(chain, address)],
  createFromInfo,
  start,
  runOnce,
  dryRun,
  lastScan,
  lastHalt,
  configOk,
  scanLine,
  coolUntil,
  stats,
  history,
  triggerMcap,
  triggerJitterSpan,
  pace,
  paceGapMs,
  nextScanDelayMs,
  paceRange,
  fmtGap,
  parseGap,
  rejectReason,
  listingInput,
  announce,
  tweetListing,
  PACKAGES,
  pkgOf,
  DEFAULTS,
};
