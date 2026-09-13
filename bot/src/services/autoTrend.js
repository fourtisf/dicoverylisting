// Auto-Trending — keeps the Trending board alive between PAID slots. When the
// operator enables it, it periodically tops the featured set up to a target by
// promoting RANDOM eligible listings for a RANDOM duration (hard-capped at 18h,
// never 24/48), at RANDOM intervals — so trending never looks empty and slots
// that expire get auto-refilled. Auto slots carry no tier, so paid tiers always
// sort ABOVE them on the board. Everything is tunable from @dexvraadminbot; the
// loop re-reads config each cycle, so changes apply without a restart.
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const api = require("../api/dexvra");
// Imported as a MODULE, not destructured: a captured binding cannot be swapped,
// and the price source has to be stubbable to test the ranking at all.
const market = require("../marketdata");
const { CHAINS } = require("../config/chains");
const ops = require("../helpers/opsThrottle");
const log = require("../helpers/logger");
// The repo's one money formatter. A refusal that says "$0.05 24h volume" is a
// diagnosis; one that says "below the volume floor" sends the operator back to
// the board to work out which token and by how much.
const { fmtCap } = require("../helpers/format");

const FILE = "autoTrend.json";
/**
 * How far down a token may be and still be promoted to reach the per-chain
 * MINIMUM (percent, 24h). Not a setting: it exists only to keep one incident
 * impossible — a board carrying $Z at −99.94% on a $1,648 cap — while letting
 * the ordinary case through, which is a chain whose spares are down a percent
 * or two on a flat day. Above the minimum, the operator's own `minGainPct` is
 * what decides, and this is not consulted.
 */
const FLOOR_FILL_MAX_DROP = 15;
const DEFAULTS = {
  enabled: false,
  minHours: 3,
  maxHours: 18, // HARD CAP — deliberately never 24 or 48
  minGapMin: 20, // random wait between top-ups
  maxGapMin: 120,
  // PER CHAIN, not board-wide. A single global target sounded equivalent and was
  // not: the eligible pool is dominated by whichever network has the most
  // listings, so one shuffle across all of them put 5 Solana tokens on the board
  // and left BSC, Ethereum and Base with one each — and Robinhood with none at
  // all. The board GROUPS by chain, so a chain with nothing featured renders as
  // nothing, and the operator sees a Solana board with three footnotes.
  // A RANGE, and the target is rolled per chain. One fixed number made every
  // chain publish exactly the same count, for ever — five rows, five rows, five
  // rows — which reads as a generated list rather than a board. The operator's
  // call: "min 5 max 8 harus random per chain".
  //
  // The FLOOR is what triggers a top-up; the target rolled for that top-up is
  // anywhere in [min, max]. Re-rolling on every cycle regardless would converge
  // on max and delete the randomness — nothing ever takes a slot away, only
  // expiry lowers a count, so a chain would ratchet up to the highest number it
  // ever rolled and stay there.
  perChainMin: 5,
  perChainMax: 8,
  // A "top gainers" board that carries a token down 99.94% at a $1,648 market
  // cap is not a top-gainers board. Ranking alone could not prevent that: with
  // five slots and five candidates, sorting still promotes the worst of them.
  // A candidate must be at least this far UP to be auto-promoted. Unpriced
  // tokens are exempt — Robinhood has no indexer, and judging them by a number
  // nobody can read would mean never filling that chain at all.
  minGainPct: 0,
  // ── What is big enough and busy enough to deserve a FREE slot ──
  //
  // "untuk free trending mohon di filter agar high mc dan vol yang rame yang
  // ditrendingkan, bukan kaya vol bahkan ga ada $10 di trendingin". The board
  // was publishing rows like `$MRNA · MCAP $157.7K · VOL $0.05 · 10 txns` —
  // five cents of trading over a whole day — beside real markets, and a reader
  // cannot tell which is which from a percentage alone. A +465% move on a token
  // nobody traded is not a trend; it is one buy against an empty book, which is
  // the same defect `minGainPct` was written for one field over (a huge
  // percentage off a $1,648 cap) and which ranking alone can never fix: with
  // five slots and five junk candidates, sorting still promotes junk.
  //
  // These are QUALITY floors, not discretionary ones. `minGainPct` deliberately
  // governs only the part of the target above `perChainMin` — a board under the
  // operator's minimum is a worse product than a board carrying something down
  // 2%. These are the opposite: they bind every free slot this bot books, on
  // BOTH doors and on a forced run, because "the board must be full" was never
  // an argument for filling it with a dead token. A chain that cannot reach its
  // minimum from its own listings raises a gap instead, and the market filler —
  // whose whole job is that case — lists real big coins into it.
  //
  // ⚠️ They ship ON, and that CHANGES an existing install's board on deploy.
  // Deliberate, the way `minMcapUsd` did for the gainers banner: it is what was
  // asked for. Either is switched off with a 0 on the panel.
  minMcapUsd: 100_000,
  minVol24hUsd: 10_000,
  // ── When a chain has nothing left to promote ──
  // Auto-trend promotes what is LISTED, so a chain with three listings caps out
  // at three rows however often it runs. Ethereum published 3 and Base 2
  // against a target of 5, every cycle, and the only trace was a log line
  // telling the operator to "list more tokens on those chains" — which they
  // cannot do from Telegram. ON, because a board that stays short is the state
  // being fixed; the floors below are what keep it from listing noise.
  fillFromMarket: true,
  fillMinMcap: 5_000_000, // a "big coin" floor — below this it is a find, not a filler
  fillMinLiq: 100_000,
  fillMaxPerCycle: 3, // per CHAIN per cycle: a shortfall is filled over a few passes, not in one burst
  // The networks auto-trending keeps alive. Everything else is paid-only: a
  // chain nobody has listed on cannot be filled, and pretending otherwise just
  // logs a failure every cycle.
  // ⚠️ TRON was missing, and the operator named it: "yang untuk di show
  // trending chain sol bsc eth robinhood base dan tron". A chain absent here is
  // not merely un-promoted — it can never appear on the board at all, which
  // from the channel is indistinguishable from a chain with nothing worth
  // trending. Six now.
  //
  // ⚠️ A STORED VALUE BEATS THIS. `set()` persists `chains`, so any box where
  // ⚙️ Auto-Trend settings has ever been touched keeps its own list and this
  // change reaches it never. `npm run trending:chains` prints what is actually
  // live and can write the default back.
  chains: ["solana", "bsc", "ethereum", "base", "robinhood", "tron"],
  // ── Public announcement of an auto-promotion ──
  // A slot lasts 3–18h and the target is 8, so refills alone produce roughly
  // 8 ÷ 10.5h × 24 ≈ 18 promotions a day. Announcing every one would bury the
  // paid posts (and the deep link a buyer was just DM'd as proof of delivery),
  // so the caps below are the feature, not decoration.
  // The card is IDENTICAL to a paid trending post — same post_trending
  // template, same artwork, same badge (operator's explicit call, 2026-07-25:
  // "templatenya harus sama dengan trending yang sudah di set, nothing beda").
  // The rails below are what keeps that from drowning the paid posts.
  announce: false, // OFF until the operator turns it on — it publishes in public
  // A token on the board WITHOUT a post is a product nobody can see, so every
  // promotion is announced — the rails below space them out, they no longer
  // decide which ones happen. That distinction is the whole design: a
  // promotion that cannot post right now is QUEUED, not dropped.
  //
  // The arithmetic they have to survive: 5 chains × 5 slots = 25 live, each
  // lasting 3–18h (~10.5h average), so steady state is roughly 57 promotions a
  // day. A 60-minute gap could clear 24 of them — the queue would grow forever.
  announcePerDay: 100, // a safety valve, not a policy: 0 = announce nothing
  announceGapMin: 15, // spacing between two auto posts
  announceCooldownDays: 7, // per token: never announce the same one twice in a week
};

// NOTE: there is deliberately NO tier gate in this file. Operator's rule, in
// their words: every listed token can get trending, free or paid — Xpress
// included. An earlier version excluded Xpress from the free fill to protect an
// upsell, which left chains visibly stuck and was not what was wanted. The paid
// flow (handlers/trending.js → fulfillTrending) has never had a tier check
// either. Do not reintroduce one in either place.
// Sanity rails so a fat-finger can't set a 48h run or a runaway target.
const HARD = {
  hoursMin: 1,
  hoursMax: 18,
  gapMin: 5,
  gapMax: 1440,
  // Bounds on the SETTING (not the setting itself, which is perChainMin/Max).
  perChainFloor: 0, // 0 = leave this chain to paid slots only
  perChainCeil: 20,
  fillMinMcapMin: 100_000,
  fillMinMcapMax: 5_000_000_000,
  fillMinLiqMin: 0,
  fillMinLiqMax: 50_000_000,
  fillMaxPerCycleMin: 0,   // 0 = never fill from the market
  fillMaxPerCycleMax: 10,
  // 0 = the floor is OFF, and it has to stay expressible: an operator who wants
  // the old unfiltered board must be able to say so. The ceilings are the real
  // rails — a ten-billion floor would empty the board for good, which is the
  // same reason the gainers caps have theirs.
  minMcapUsdMin: 0,
  minMcapUsdMax: 10_000_000_000,
  minVol24hUsdMin: 0,
  minVol24hUsdMax: 1_000_000_000,
  minGainPct: [-100, 500],
  // The old ceiling was 24/day, which is BELOW the ~57 promotions a day that 5
  // chains × 5 slots actually produce — so "announce everything" was
  // unreachable no matter how the panel was set.
  announcePerDay: [0, 200],
  announceGapMin: [5, 1440],
  announceCooldownDays: [0, 90],
};

function clampInt(v, lo, hi, fb) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fb;
}

/** Current config, defaults applied and every value forced within its rails. */
function get() {
  const c = loadJSONSync(FILE, {}) || {};
  const g = { ...DEFAULTS };
  if (typeof c.enabled === "boolean") g.enabled = c.enabled;
  g.minHours = clampInt(c.minHours, HARD.hoursMin, HARD.hoursMax, DEFAULTS.minHours);
  g.maxHours = clampInt(c.maxHours, HARD.hoursMin, HARD.hoursMax, DEFAULTS.maxHours);
  if (g.maxHours < g.minHours) g.maxHours = g.minHours; // keep the range valid
  g.minGapMin = clampInt(c.minGapMin, HARD.gapMin, HARD.gapMax, DEFAULTS.minGapMin);
  g.maxGapMin = clampInt(c.maxGapMin, HARD.gapMin, HARD.gapMax, DEFAULTS.maxGapMin);
  if (g.maxGapMin < g.minGapMin) g.maxGapMin = g.minGapMin;
  // MIGRATION: an install that predates the range has `perChain` stored, and a
  // stored value beats a shipped default — so it becomes the FLOOR rather than
  // being silently replaced. The ceiling then defaults to the shipped 8, or to
  // the floor if the operator had deliberately set a higher number.
  // ⚠️ `undefined`, never `null`: clampInt does Number(v), and Number(null) is 0
  // — a finite 0, which clamps to the FLOOR instead of falling back to the
  // default. A fresh install came out with a per-chain floor of zero, i.e. a
  // board that never fills itself, and nothing errored. Same trap the launchpad
  // env reader hit with Number('').
  const legacy = Number.isFinite(Number(c.perChain)) ? Number(c.perChain) : undefined;
  g.perChainMin = clampInt(
    c.perChainMin != null ? c.perChainMin : legacy,   // both absent → undefined → the default
    HARD.perChainFloor, HARD.perChainCeil, DEFAULTS.perChainMin,
  );
  g.perChainMax = clampInt(
    c.perChainMax != null ? c.perChainMax : Math.max(g.perChainMin, DEFAULTS.perChainMax),
    HARD.perChainFloor, HARD.perChainCeil, DEFAULTS.perChainMax,
  );
  // A max under the min is a range that can never be satisfied; the floor wins,
  // because it is the number the operator set to keep the board from looking
  // empty.
  if (g.perChainMax < g.perChainMin) g.perChainMax = g.perChainMin;
  g.minGainPct = clampInt(c.minGainPct, ...HARD.minGainPct, DEFAULTS.minGainPct);
  g.minMcapUsd = clampInt(c.minMcapUsd, HARD.minMcapUsdMin, HARD.minMcapUsdMax, DEFAULTS.minMcapUsd);
  g.minVol24hUsd = clampInt(c.minVol24hUsd, HARD.minVol24hUsdMin, HARD.minVol24hUsdMax, DEFAULTS.minVol24hUsd);
  g.fillFromMarket = c.fillFromMarket !== false;
  g.fillMinMcap = clampInt(c.fillMinMcap, HARD.fillMinMcapMin, HARD.fillMinMcapMax, DEFAULTS.fillMinMcap);
  g.fillMinLiq = clampInt(c.fillMinLiq, HARD.fillMinLiqMin, HARD.fillMinLiqMax, DEFAULTS.fillMinLiq);
  g.fillMaxPerCycle = clampInt(c.fillMaxPerCycle, HARD.fillMaxPerCycleMin, HARD.fillMaxPerCycleMax, DEFAULTS.fillMaxPerCycle);
  // An unknown chain id would be topped up forever with nothing eligible, so the
  // list is filtered against the real chain table rather than trusted.
  if (Array.isArray(c.chains)) {
    const ids = c.chains.map((x) => String(x).toLowerCase()).filter((x) => CHAINS[x]);
    if (ids.length) g.chains = [...new Set(ids)];
  }
  if (typeof c.announce === "boolean") g.announce = c.announce;
  // One-time migration. These two were saved under the OLD policy, where the
  // rails decided WHICH promotions got announced and most were dropped. Under
  // the current one — every trending token gets its post — a stored 3/day and
  // 60min are not a preference, they are a leftover that makes the policy
  // impossible: three posts a day against ~57 promotions, and the rest sit in
  // the queue until their slots expire. A value that still equals the old
  // default is treated as never-set.
  const OLD_PER_DAY = 3;
  const OLD_GAP_MIN = 60;
  const perDay = c.announcePerDay === OLD_PER_DAY ? undefined : c.announcePerDay;
  const gapMin = c.announceGapMin === OLD_GAP_MIN ? undefined : c.announceGapMin;
  g.announcePerDay = clampInt(perDay, ...HARD.announcePerDay, DEFAULTS.announcePerDay);
  g.announceGapMin = clampInt(gapMin, ...HARD.announceGapMin, DEFAULTS.announceGapMin);
  g.announceCooldownDays = clampInt(c.announceCooldownDays, ...HARD.announceCooldownDays, DEFAULTS.announceCooldownDays);
  return g;
}

/** Patch any subset of the config; persists and returns the clamped result. */
async function set(patch = {}) {
  const next = { ...get() };
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (typeof patch.announce === "boolean") next.announce = patch.announce;
  // A boolean that only ever reached `get()` and never the FILE is a setting
  // that reverts on the next read — the toggle would report ON and the loop
  // would keep the old value.
  if (typeof patch.fillFromMarket === "boolean") next.fillFromMarket = patch.fillFromMarket;
  for (const k of ["minHours", "maxHours", "minGapMin", "maxGapMin", "perChainMin", "perChainMax", "minGainPct", "minMcapUsd", "minVol24hUsd", "fillMinMcap", "fillMinLiq", "fillMaxPerCycle", "announcePerDay", "announceGapMin", "announceCooldownDays"]) {
    if (patch[k] != null) next[k] = patch[k];
  }
  if (Array.isArray(patch.chains)) next.chains = patch.chains;
  await saveJSON(FILE, next);
  return get();
}

async function reset() {
  await saveJSON(FILE, { ...DEFAULTS });
  return get();
}

// ── Announce state (persisted, shared by both processes via DATA_DIR) ───────
// autoTrend had no state file at all, so nothing stopped the same token being
// re-promoted — and, once we publish, re-ANNOUNCED — every few hours as slots
// expire and refill. This is that memory.
//
// `pending` is the cross-process hand-off: forceChain() runs inside the ADMIN
// bot, and channels/post.js is only attach()ed in the MAIN bot (src/bot.js), so
// the admin process cannot post at all. It queues here instead and the main
// process drains it seconds later — the same shape as the force-post job store.
const STATE_FILE = "autoTrendState.json";
const keyOf = (chain, address) => `${chain}:${String(address).toLowerCase()}`;
const dayKey = (now) => new Date(now).toISOString().slice(0, 10);

function loadState() {
  const s = loadJSONSync(STATE_FILE, {}) || {};
  return {
    announced: s.announced && typeof s.announced === "object" ? s.announced : {},
    day: s.day || null,
    lastAt: Number(s.lastAt) || 0,
    pending: Array.isArray(s.pending) ? s.pending : [],
    // Per-chain "how long has this been under its minimum" — see trendingWatch.
    boardWatch: s.boardWatch && typeof s.boardWatch === "object" ? s.boardWatch : {},
    // chain:address → when the ranking pass last OPENED this candidate. It is
    // what makes the probe window rotate instead of re-reading the same N rows
    // for ever; see PROBE_CAP for the board that sat at 1–2 rows because of it.
    probe: s.probe && typeof s.probe === "object" ? s.probe : {},
  };
}
const saveState = (st) => saveJSON(STATE_FILE, st).catch(() => {});
const todayCount = (st, now) => (st.day && st.day.key === dayKey(now) ? st.day.n : 0);

/** Forget every announcement — the operator's "start fresh" for the cooldowns. */
async function resetAnnounceState() {
  // ⚠️ THE ROTATION AND THE WATCH CLOCK SURVIVE IT. This writes a whole fresh
  // object, so every field not named here is deleted — and two of them are
  // nothing to do with announcing. Wiping `probe` restarts the probe window at
  // the front of every chain (the prefix bug, for one sweep); wiping
  // `boardWatch` resets "how long has this chain been short", so a board that
  // has been under its minimum for two days serves out its grace period again
  // and the alert never lands. An operator clearing announcement cooldowns is
  // not asking for either.
  const st = loadState();
  await saveJSON(STATE_FILE, { announced: {}, day: null, lastAt: 0, pending: [], boardWatch: st.boardWatch, probe: st.probe });
}

/** Why this token is NOT getting announced, or null when it may be. One
 *  function so every refusal is a readable log line rather than a silent skip. */
// Refusals that are a matter of TIME. A promotion blocked by one of these has
// not been rejected — it is waiting, and the queue must hold on to it. Anything
// else ("off", "already announced this week") is a real no.
const RETRYABLE = /^(daily cap reached|too soon)/;
const isRetryable = (why) => !!why && RETRYABLE.test(why);

function announceReason(row, st, cfg, now = Date.now()) {
  if (!cfg.announce) return "announcements are off";
  if (!row || !row.chain || !row.address) return "no token";
  if (cfg.announcePerDay <= 0) return "daily cap is 0";
  if (todayCount(st, now) >= cfg.announcePerDay) return `daily cap reached (${cfg.announcePerDay})`;
  if (st.lastAt && now - st.lastAt < cfg.announceGapMin * 60_000) {
    return `too soon — ${Math.ceil((cfg.announceGapMin * 60_000 - (now - st.lastAt)) / 60_000)}min to go`;
  }
  const last = st.announced[keyOf(row.chain, row.address)];
  if (last && now - last < cfg.announceCooldownDays * 86_400_000) {
    return `${row.sym || row.address} was announced ${Math.round((now - last) / 86_400_000)}d ago (cooldown ${cfg.announceCooldownDays}d)`;
  }
  return null;
}

/**
 * Post the auto-spotlight card for one token. MAIN PROCESS ONLY — channels/post
 * is attached there. Best-effort: the promotion has already happened and must
 * never be undone by a failed post.
 */
let _announcer = null; // test seam: swap the channel post for a recorder
async function announceOne(row, hours) {
  if (_announcer) return _announcer(row, hours);
  const post = require("../channels/post");
  const fmt = require("../channels/format");
  const { CHANNELS, SITE_URL } = require("../config/constants");
  const { postMedia } = require("../fulfillment");
  const { chainOf } = require("../config/chains");
  const market = require("../marketdata");
  const tokenEmoji = require("../tokenEmoji");

  const live = await market.fetchMarket(row.chain, row.address).catch(() => null);
  const coin = {
    name: row.name,
    symbol: row.sym || row.symbol,
    chain: row.chain,
    address: row.address,
    tier: row.tier,
    price: live && live.priceUsd,
    mcap: live && live.mcap,
    liq: live && live.liq,
    links: { website: row.website, twitter: row.twitter, telegram: row.telegram },
    siteUrl: `${SITE_URL}/token/${row.chain}/${row.address}`,
  };
  // The pack must exist BEFORE the card renders — emojiTag() reads it synchronously.
  await tokenEmoji
    .ensureFromUrl({ chain: row.chain, address: row.address, symbol: coin.symbol }, row.logoUrl)
    .catch(() => null);
  const media = await postMedia(
    "trending",
    {
      symbol: coin.symbol,
      name: coin.name,
      chain: String(chainOf(row.chain) ? chainOf(row.chain).label : row.chain).toUpperCase(),
      price: live && live.priceUsd ? `$${Number(live.priceUsd).toPrecision(4)}` : "TBA",
      mcap: live && live.mcap ? `$${Math.round(live.mcap).toLocaleString("en-US")}` : null,
      links: coin.links,
    },
    null,
    null,
    row.logoUrl || "",
    // Same badge a paid run gets, stating this slot's REAL length.
    hours ? `Trending ${hours}H` : null,
  ).catch(() => null);
  // Never pinned (the Trending board owns that pin) and never @dexvraio (the
  // announcement headline is a 24H/48H paid inclusion).
  return post.sendMedia(CHANNELS.trending, media, fmt.trendingPost(coin));
}

/**
 * Announce `row` if every rail allows it, and record it. Returns the reason it
 * was skipped, or null when it posted.
 */
async function tryAnnounce(row, { now = Date.now(), hours = 0 } = {}) {
  const cfg = get();
  const st = loadState();
  const why = announceReason(row, st, cfg, now);
  if (why) {
    log.debug(`[autotrend] not announcing ${row && row.sym}: ${why}`);
    return why;
  }
  let msg = null;
  try {
    msg = await announceOne(row, hours);
  } catch (e) {
    log.warn(`[autotrend] announce ${row.sym || row.address}: ${e.message}`);
    return `post failed (${e.message})`;
  }
  if (!msg) return "post failed";
  // Counted only after it really posted — a failed post must not spend the
  // token's cooldown or the day's budget.
  st.announced[keyOf(row.chain, row.address)] = now;
  st.lastAt = now;
  st.day = { key: dayKey(now), n: todayCount(st, now) + 1 };
  await saveState(st);
  log.info(`[autotrend] announced ${row.sym || row.address} on ${row.chain} → ${msg.message_id}`);
  return null;
}

/** Queue an announcement for the MAIN process (used by the admin bot). */
async function queueAnnounce(row, hours = 0) {
  const st = loadState();
  st.pending = [
    ...st.pending.filter((p) => keyOf(p.chain, p.address) !== keyOf(row.chain, row.address)),
    { chain: row.chain, address: row.address, hours, at: Date.now() },
    // A cold start across five chains can enqueue 25 at once, and a slow drain
    // must not silently discard the tail. Bounded, but generously.
  ].slice(-200);
  await saveState(st);
}

/** Main-process drain of whatever the admin bot queued. */
async function drainPending({ now = Date.now() } = {}) {
  const st = loadState();
  if (!st.pending.length) return 0;
  const next = st.pending[0];
  // Look BEFORE removing. The old order popped the head, saved, and then tried
  // to post — so a "too soon, 12 min to go" threw the promotion away, and the
  // token sat on the board with no post for its whole slot. Nothing may leave
  // this queue until it has either posted or been refused for good.
  const cfg = get();
  const why = announceReason({ chain: next.chain, address: next.address }, st, cfg, now);
  if (isRetryable(why)) return 0; // still queued; the next tick tries again

  st.pending = st.pending.slice(1);
  await saveState(st);
  if (why) {
    log.debug(`[autotrend] dropping queued ${next.chain}/${next.address}: ${why}`);
    return 0;
  }
  let listings = [];
  try {
    listings = await api.getListings();
  } catch {
    return 0;
  }
  const row = listings.find((r) => keyOf(r.chain, r.address) === keyOf(next.chain, next.address));
  if (!row) return 0;
  // The queue can be hours deep, and a slot lasts 3–18h. Announcing a token
  // whose slot has already ended posts a card for something no longer on the
  // board — worse than not posting it.
  if (row.trendingRank == null || (row.trendExp && row.trendExp <= now)) {
    log.debug(`[autotrend] dropping queued ${row.sym || row.address}: its slot ended before the queue reached it`);
    return 0;
  }
  return (await tryAnnounce(row, { now, hours: next.hours })) ? 0 : 1;
}

/** How many promotions are waiting to be posted (shown in the admin panel). */
function pendingCount() {
  return loadState().pending.length;
}

/** One top-up pass: promote random eligible listings until `target` are featured.
 *  `rng` is injectable so tests are deterministic. Returns how many were promoted.
 *  Never throws — a hiccup must not take down the service loop. */
// ── Ranking: top gainers ─────────────────────────────────────────────────────
// A trending board is a claim about what is MOVING. Filling it at random made
// that claim false — a token down 80% sat next to one up 40% with nothing to
// tell them apart, and the operator could not point at the board and say why
// anything on it was there.
//
// Live 24h change per candidate, best first. Bounded and paced, because this
// runs on a timer and the price API is shared with the board poster:
//   • at most PROBE_CAP candidates per chain get a lookup
//   • PROBE_GAP_MS between calls
//   • a token whose price cannot be read sorts LAST but is still available —
//     never promoting an unpriced token would quietly exclude every new listing
//     on a chain no indexer covers, which is most of Robinhood.
//
// ⚠️ AND *WHICH* ONES GET THAT LOOKUP IS THE SIXTH CAUSE OF A SHORT BOARD.
//
// This used to be `rows.slice(0, PROBE_CAP)` — the first N of the eligible
// list in store order, which is `addListing`'s newest-first insertion order and
// therefore the SAME N on every cycle, for ever. On a chain with five listings
// that is every listing and nobody noticed for a year. On Solana, with ~190
// spares, it is a 13% sample chosen by nothing at all: if those particular rows
// happen to be dead — old memecoins under the cap floor, a pool nobody has
// traded all day — the chain can never reach its minimum from its own listings
// again, however good the tokens at position 26 are. Measured before a line was
// changed: 25 dead rows in front of 175 excellent ones promotes ZERO, on every
// cycle, and the board publishes 1–2 rows against a minimum of 5. That is the
// report ("min 5 max 8 tpi yang di baca channel cmn 1/2").
//
// So the probe order is LEAST-RECENTLY-OPENED FIRST (never opened = first of
// all), stamped per chain+address in the state file. That is one cursor per
// chain in the only form that survives the list changing underneath it — an
// index would drift by one on every new listing, because the store PREPENDS —
// and it buys the guarantee a prefix never could: every listing on a chain is
// opened within ceil(n / PROBE_CAP) passes, and a chain that is short keeps
// sweeping until it finds something.
//
// The budget is a matter of SPEED now rather than of reach, which is what makes
// it safe to widen: the read below is DexScreener-first, so a wider window
// costs almost nothing against the GeckoTerminal ceiling.
const PROBE_CAP = Math.max(5, Math.round(Number(process.env.AUTOTREND_PROBE_CAP)) || 40);
const PROBE_GAP_MS = 250;
// A stamp is only ever used to ORDER the next pass, so forgetting one costs a
// re-read and nothing else — which is why this can be pruned bluntly. Without
// it the map grows by one entry per token ever considered and never shrinks.
const PROBE_MEMO_KEEP_MS = 14 * 24 * 3600_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Drop stamps nothing will read again. Mutates and returns the same object. */
function pruneProbes(probes, now) {
  for (const k of Object.keys(probes)) {
    const at = Number(probes[k]);
    if (!Number.isFinite(at) || now - at > PROBE_MEMO_KEEP_MS) delete probes[k];
  }
  return probes;
}

/**
 * ⚠️ THE ONE OWNER OF "IS THIS BIG ENOUGH AND BUSY ENOUGH FOR A FREE SLOT".
 *
 * Every door onto this board asks it: the gain-floor pass, the floor fill, the
 * forced per-chain run, and `trendFill` for the tokens it would LIST into a
 * slot. That is not tidiness — the free-fall bound taught this exact lesson one
 * field over. `FLOOR_FILL_MAX_DROP` bound the promoter and not the filler, so
 * the filler would have listed a big-cap down 40% into the very slot the
 * promoter had just refused a token down 20% for: the rule made decorative by
 * the code written to help it. Two copies of a floor is two floors.
 *
 * Returns `null` when the candidate is fine, or the REASON it was refused —
 * because a count of refusals sends the operator back to the board to work out
 * which one it was, and this repo has paid for that shape more than once.
 *
 * It takes plain `{mcap, vol24}` rather than a row, deliberately: the promoter
 * annotates `_mcap`/`_vol24` onto a LISTING and the filler reads `mcap`/`vol24`
 * off a MARKET candidate, and a predicate that knew one shape would have forced
 * the other door to write its own — which is the whole failure this exists to
 * prevent. The adapter is one object literal at each call site.
 *
 * A floor set to 0 is OFF and asks nothing at all, so an unreadable cap on a
 * chain no indexer covers costs nothing until an operator actually sets a
 * floor. Once one is set, an unreadable value is REFUSED: the floor is a claim
 * ("cap ≥ $100K"), and a token whose cap nobody publishes cannot be shown to
 * satisfy it. Same rule, same wording, as the gainers banner's `minMcapUsd`.
 */
function floorRefusal({ mcap, vol24 }, cfg) {
  const minMcap = Number(cfg && cfg.minMcapUsd) || 0;
  const minVol = Number(cfg && cfg.minVol24hUsd) || 0;
  if (minMcap > 0) {
    if (!Number.isFinite(mcap)) return { code: "mcap", why: "market cap could not be read" };
    if (mcap < minMcap) return { code: "mcap", why: `${fmtCap(mcap)} cap`, value: mcap };
  }
  if (minVol > 0) {
    if (!Number.isFinite(vol24)) return { code: "vol", why: "24h volume could not be read" };
    if (vol24 < minVol) return { code: "vol", why: `${fmtCap(vol24)} 24h volume`, value: vol24 };
  }
  return null;
}
/** The promoter's adapter: a ranked LISTING carries byGain's annotations. */
const rowRefusal = (r, cfg) => floorRefusal({ mcap: r._mcap, vol24: r._vol24 }, cfg);

/**
 * ⚠️ THE ONE WAY A PAIR OF FLOORS IS SPELLED IN PROSE — and it exists because
 * `fmtCap(0)` is `"$0"`.
 *
 * `0` means OFF. The panel already knew that (`floorLabel` renders "OFF", and
 * its comment says `$0` on a row labelled "min cap" "says the floor is set to
 * nothing, which is the opposite of what it means") — and then FIVE other
 * surfaces built the same parenthetical from raw `fmtCap` and printed
 * `(cap $0, 24h vol $10.0K)`: the ⚡ Run now refusal, the cycle's log line, the
 * short-board alert in the ops channel, the filler's `why`, and the check
 * script's config line. So an operator who switched the cap floor off was told
 * their tokens were refused by a floor of $0, on every surface except the one
 * that got it right.
 *
 * A floor that is OFF is simply not named: it refused nothing, so listing it is
 * noise at best and a false accusation at worst.
 */
function floorsPhrase(cfg) {
  const parts = [];
  if (Number(cfg && cfg.minMcapUsd) > 0) parts.push(`cap ${fmtCap(Number(cfg.minMcapUsd))}`);
  if (Number(cfg && cfg.minVol24hUsd) > 0) parts.push(`24h vol ${fmtCap(Number(cfg.minVol24hUsd))}`);
  return parts.length ? parts.join(", ") : "no quality floors set";
}

/**
 * How many of a `byGain`-ranked list the floors refused — the number that
 * reaches the watch, the log line and `trending:check`.
 *
 * ⚠️ IT IS A FUNCTION BECAUSE THE CHECK SCRIPT HAD ITS OWN COPY OF IT, and the
 * copy was missing the "we actually looked" half — so on a chain with 44
 * spares it reported 44 refusals where the bot reports 25, and the two
 * disagreed about the one number the operator would act on. A check that
 * measures its own copy of the question proves nothing; `fonts:check` printed
 * nine green ticks over a banner drawing boxes for exactly this reason.
 *
 * `_change === undefined` is this repo's spelling of "byGain never priced this
 * one" (the tail past PROBE_CAP). Those rows are still refused — promoting a
 * token nobody priced is how a dead row reaches the board — they are simply not
 * COUNTED as having failed a floor nobody read them against.
 */
// "We opened this row and got an answer." `undefined` is the unprobed tail past
// PROBE_CAP; `_unread` is a row we DID probe and could not read — the upstream
// refused us. Neither may be counted as having failed a floor.
const looked = (r) => r._change !== undefined && !r._unread;
// "We OPENED this row" — spent a read on it, whatever the upstream then said.
// Distinct from `looked` on purpose: `looked` is about the ANSWER (and so
// excludes a row the upstream refused us), this is about the WINDOW, and the
// window is what every "every spare is…" sentence was wrong about.
const opened = (r) => r._change !== undefined;
function countFloorRefusals(ranked, cfg) {
  return ranked.filter((r) => looked(r) && rowRefusal(r, cfg)).length;
}

/**
 * @param {object[]} rows      the chain's spare listings, in store order
 * @param {function} rng
 * @param {object}  [opts]
 * @param {object}  [opts.probes] chain:address → when we last opened it,
 *   MUTATED with a fresh stamp for every row this pass reads. The CALLER owns
 *   persistence: `runOnce` and `forceChain` save it, and `trending:check`
 *   deliberately does not — a diagnostic that advanced the bot's own rotation
 *   would change the very thing it is measuring.
 */
async function byGain(rows, rng = Math.random, { probes = null, now = Date.now() } = {}) {
  // ⚠️ LEAST-RECENTLY-OPENED FIRST, never store order. See PROBE_CAP.
  // Stable: rows never opened at all carry 0 and keep their store order among
  // themselves, so a chain that fits inside one budget behaves exactly as it
  // always did.
  const order = rows
    .map((r, i) => ({ r, i, at: probes ? Number(probes[keyOf(r.chain, r.address)]) || 0 : 0 }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.r);
  // No shortcut for a single candidate: it still has to be PRICED, or the
  // caller's floor sees an unannotated row and reads it as "never looked" —
  // which is how the one token on a chain silently stopped being promotable.
  const probe = order.slice(0, PROBE_CAP);
  const rest = order.slice(PROBE_CAP);
  const scored = [];
  for (let pi = 0; pi < probe.length; pi++) {
    const r = probe[pi];
    // `now + pi`, not a flat `now`: two passes inside the same millisecond
    // would otherwise stamp identically, the stable sort would fall back to
    // store order, and the second pass would re-open the first pass's window —
    // the very prefix this replaced. The drift is at most PROBE_CAP ms against
    // a 14-day prune.
    if (probes) probes[keyOf(r.chain, r.address)] = now + pi;
    let change = null;
    let priced = false;
    let mcap = null;
    let vol24 = null;
    // ⚠️ "WE COULD NOT ASK" IS NOT "THIS TOKEN HAS NOTHING", and this loop
    // collapsed the two. A throw, and a `fetchMarket` that answers `null`
    // because neither GeckoTerminal nor DexScreener could be reached, both left
    // `change`/`mcap`/`vol24` null — exactly what an indexer ANSWERING with no
    // data leaves. Three rules downstream then act on that:
    //   • `hasReading` refuses the row (right — a blank row may not be
    //     published — but for a reason that is not about the token);
    //   • `rowRefusal` reads a null cap as failing the free-trending floors,
    //     so the log accuses the operator's own listings of being too small;
    //   • the chain's shortfall is attributed to the floors rather than to the
    //     upstream, which is the cause an operator would act on.
    // GT's free tier is ~30 req/min PER IP and this box shares it with the
    // website, so a cycle that loses most of its reads is ordinary here — and
    // the board then publishes only as many rows as GT happened to answer for.
    let unread = false;
    try {
      // ⚠️ DEXSCREENER FIRST, and it is the single biggest saving on this path.
      //
      // This pass prices up to PROBE_CAP candidates on EVERY configured chain,
      // every cycle — six chains is up to 150 reads — and it was GT-first, into
      // a ~30 req/min ceiling counted PER IP that this box already shares with
      // the website's charts. Losing most of a cycle's reads was ordinary, and
      // a lost read is a row that does not reach the board (see `_unread`).
      //
      // A PRICE has two free sources; only a CANDLE has one. Everything this
      // loop reads — price, cap, 24h volume, 24h change — DexScreener also
      // publishes, so naming those four lets it answer and GT is never asked.
      // Where DexScreener is missing any of them (it does not index the
      // GT-primary chains at all) this falls through to GT exactly as before,
      // and its answer is reused rather than re-requested.
      const m = await market.fetchMarket(r.chain, r.address, {
        cheap: true,
        need: ["priceUsd", "mcap", "vol24h", "change24h"],
      });
      // `fetchMarket` returns null only when BOTH readers came up empty, which
      // on this box is far more often a shared 429 than a token nobody indexes.
      if (!m) unread = true;
      if (m && Number.isFinite(m.change24h)) change = m.change24h;
      // The SAME read, not a second lookup. `fetchMarket` already returns the
      // cap and the 24h volume, and this loop is paced at 250ms against a quota
      // shared with the website's charts — a floor that re-fetched what it was
      // just handed would double the cost of every cycle.
      //
      // null is "nobody published one", never 0. `clearsFloors` refuses that
      // when a floor is on, because a floor is a CLAIM ("cap ≥ $100K") and a
      // token with no cap cannot be shown to satisfy it — the gainers banner's
      // `minMcapUsd` states the same rule. A genuine 0 (a pool that traded
      // nothing all day) is a reading, and it is the exact one being filtered.
      if (m && Number.isFinite(m.mcap)) mcap = m.mcap;
      if (m && Number.isFinite(m.vol24h)) vol24 = m.vol24h;
      // "NO 24h READING" AND "NO MARKET AT ALL" ARE DIFFERENT FACTS, and the
      // board renders them identically — which is how `$BINGBONG` reached a
      // pinned public board as a bare ticker with no percentage and no market
      // cap beside it. A quiet pool still has a price to publish; a token with
      // no pool anywhere has nothing, and a row for it is decoration.
      if (m && Number.isFinite(m.priceUsd)) priced = true;
    } catch {
      unread = true; // the read itself failed — a fact about the upstream
    }
    r._change = change;   // carried so the caller can apply a floor without re-fetching
    r._priced = priced;
    r._mcap = mcap;
    r._vol24 = vol24;
    // Not a verdict about the token. `looked()` reads this, so an unread row is
    // still refused (a blank row may not be published) and is NOT counted as
    // having failed a floor nobody could read it against.
    r._unread = unread;
    scored.push({ r, change });
    await sleep(PROBE_GAP_MS);
  }
  const priced = scored.filter((x) => x.change != null).sort((a, b) => b.change - a.change);
  // Unpriced candidates keep a random order among themselves, so a chain with no
  // price data at all still rotates instead of promoting the same token forever.
  const unpriced = scored.filter((x) => x.change == null).map((x) => x.r);
  for (let i = unpriced.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [unpriced[i], unpriced[j]] = [unpriced[j], unpriced[i]];
  }
  // The unprobed tail keeps _change undefined rather than null, so the floor can
  // tell "we looked and there is no price" from "we never looked". The cap and
  // the volume are set the same way and for the same reason: `undefined` is the
  // only value that cannot be mistaken for a measurement, and promoting a token
  // nobody looked at is how a dead row reaches the board with no decision
  // behind it.
  for (const r of rest) {
    r._change = undefined;
    r._mcap = undefined;
    r._vol24 = undefined;
  }
  return [...priced.map((x) => x.r), ...unpriced, ...rest];
}

/**
 * One top-up pass. `chain` restricts it to a single network and makes the run
 * FORCED: it ignores the enabled switch and the global target, and promotes up
 * to `count` tokens on that chain. That is what the admin panel's per-chain
 * "Run now" needs — the board groups by chain, so a chain with no featured
 * token shows nothing at all, and waiting for the random cycle to happen to
 * pick that chain is not a plan.
 */
// `deps` is a test seam only: the board filler reaches the network and the site
// API, and a test that had to stub those globally would be pinning the wiring
// rather than the behaviour.
async function runOnce({ rng = Math.random, chain = null, count = 1, deps = {} } = {}) {
  const cfg = get();
  if (!cfg.enabled && !chain) return 0; // a forced per-chain run is deliberate
  let listings;
  try {
    listings = await api.getListings();
  } catch (e) {
    // ⚠️ THE WHOLE CYCLE DIES HERE, and this was a debug line — a level
    // production does not print. So a site the bot cannot read stops every
    // promotion on every chain in complete silence: the board decays as slots
    // expire, `trending:check` still works (it is a different process with its
    // own env), and there is nothing anywhere to tell the two apart. Fourth
    // instance of this asymmetry in this file, second in this function.
    log.warn(`[autotrend] cycle ABORTED — could not read the listings API: ${e.message}`);
    return 0;
  }
  const now = Date.now();
  const isFeatured = (r) => r.status === "approved" && r.trendingRank != null && (!r.trendExp || r.trendExp > now);
  const on = (r, id) => String(r.chain).toLowerCase() === String(id).toLowerCase();

  // Each chain is topped up against ITS OWN count — doing this globally meant
  // the network with the most listings won every shuffle and the rest of the
  // board stayed empty (see DEFAULTS.perChainMin) — and to ITS OWN rolled target. A chain still AT or above
  // the floor is left alone — that is what keeps the counts different from each
  // other instead of every chain sitting on the same number.
  const rollTarget = () => cfg.perChainMin + Math.floor(rng() * (cfg.perChainMax - cfg.perChainMin + 1));
  const plan = chain
    ? [{ id: chain, need: count, forced: true }]
    : cfg.chains.map((id) => {
        const have = listings.filter((r) => isFeatured(r) && on(r, id)).length;
        return {
          id,
          need: have >= cfg.perChainMin ? 0 : rollTarget() - have,
          // How many of those are needed just to REACH the minimum. The gain
          // floor is allowed to leave the rolled part unfilled; it is not
          // allowed to leave the board under the number the operator set.
          needFloor: Math.max(0, cfg.perChainMin - have),
          forced: false,
        };
      });

  let promoted = 0;
  // ONE public post per run, across every chain — not one per chain. A cold
  // start tops up five networks at once, and five cards in a row is a firehose.
  let announcedThisRun = false;
  const short = [];
  // The same shortfall, as data. It used to exist only as English inside
  // `short`, which is why nothing could act on it.
  const gaps = new Map();
  /**
   * ⚠️ ONLY a LISTING shortage belongs here.
   *
   * The board can end up short for two completely different reasons, and only
   * one of them is fixed by listing something:
   *
   *   • the chain has no spare listings left  → nothing to promote → FILL
   *   • the chain has plenty, but they are all DOWN → the `minGainPct` floor
   *     did its job, and the board is short ON PURPOSE
   *
   * Feeding the second case to the filler turns a red market into a listing
   * spree: with `min +5% 24h` set, every chain looks "short" on any red day, so
   * the bot would list `fillMaxPerCycle` fresh tokens per chain per cycle —
   * every cycle, all day — while the tokens already listed there sit unused
   * because they are down 2%. The gain floor and the filler would be fighting
   * each other, and the filler would win because its listings book their slot
   * directly.
   */
  const gap = (id, n) => {
    if (n > 0) gaps.set(id, Math.max(gaps.get(id) || 0, n));
  };
  // Per chain: how many spares the free-trending floors refused this pass. The
  // watch renders "short" three different ways and the shortfall's CAUSE is
  // what tells them apart — a count nobody can read is the same as no count,
  // which is how three rounds of "trending minimal harus 5" each had to be
  // diagnosed from scratch.
  const floorRefusedByChain = new Map();
  // Per chain: how many candidates this pass could not PRICE at all. Its own
  // counter because it is its own cause with its own fix — "GT is rate limited"
  // sends an operator to a key, "below the floors" sends them to a setting, and
  // until now the first was reported as the second.
  const unreadByChain = new Map();
  // Per chain: how many of its spares this pass actually OPENED. The probe
  // window is bounded and it ROTATES, so on a chain with hundreds of listings
  // a pass judges a slice — and every "every spare is…" sentence below spoke
  // about all of them. A count nobody can read is the same as no count; a
  // count that is WRONG sends the operator to change the wrong setting, which
  // is what five earlier rounds of a short board each cost.
  const consideredByChain = new Map();
  // ⚠️ THE PROMOTER NEVER HAD THE REFUSAL LADDER THE FILLER ALREADY HAS.
  //
  // `trendFill` reports the DOMINANT counter and says whether it accounts for
  // all of them, precisely because "every big token here is in free-fall" and
  // "every one is below the floors" send an operator to different places. This
  // pass reported whichever counter was written down first — so a live board
  // showed `Ethereum 4/5 · 10 of 18 opened are below the floors` under the
  // sentence "they are below the floors, and none went on", about a chain where
  // EIGHT spares had cleared the floors and something else refused them. A
  // cause that does not account for the shortfall is the wrong cause.
  const freeFallByChain = new Map();
  const noReadingByChain = new Map();
  const bookFailedByChain = new Map();
  // The rotation's memory, read for the probe ORDER and stamped by byGain.
  // Held for the whole run and written ONCE below the promotion loop: every
  // announce path reloads the state file, so a per-chain save would race them.
  const probes = loadState().probe;
  let probesTouched = false;

  for (const step of plan) {
    if (step.need <= 0) continue;
    const eligible = listings.filter(
      (r) =>
        r.status === "approved" &&
        !isFeatured(r) &&
        on(r, step.id),
    );
    if (!eligible.length) {
      if (step.forced) log.info(`[autotrend] forced run on ${step.id}: nothing eligible (every listed token there is already featured?)`);
      else { short.push(`${step.id} (needs ${step.need}, none eligible)`); gap(step.id, step.need); }
      continue;
    }
    if (eligible.length < step.need) { short.push(`${step.id} (needs ${step.need}, only ${eligible.length} eligible)`); gap(step.id, step.need - eligible.length); }
    // TOP GAINERS, not a shuffle. A trending board is a claim about what is
    // moving; filling it at random made that claim false, and put a token down
    // 80% next to one up 40% with nothing to tell them apart.
    const ranked = await byGain(eligible, rng, { probes, now });
    probesTouched = true;
    let bookFailed = 0;
    let lastBookErr = null;
    // ⚠️ `ranked.length` is every spare on the chain; this is the subset the
    // pass opened. They are not the same number and the difference IS the
    // rotation — saying "200 candidate(s), none up 5%" about 40 we opened is
    // the false claim this pass had been making since it was written.
    const considered = ranked.filter(opened).length;
    consideredByChain.set(step.id, considered);
    const ofSpares = considered < ranked.length ? ` (${considered} of ${ranked.length} opened this pass)` : "";
    // ⚠️ THE QUALITY FLOORS RUN FIRST, AND THEY BIND A FORCED RUN TOO.
    //
    // First, so `worthy` and the floor fill below both draw from a list the
    // floors have already been applied to — a rule those two passes do not
    // honour is a rule they delete.
    //
    // ⚠️ BUT `anyPriced` / `anyReading` ARE ASKED OF `ranked`, NOT OF THIS
    // LIST, and the distinction is the whole reason they exist. Those two
    // exemptions answer "does an indexer cover this CHAIN at all?" — the
    // Robinhood case, where refusing the unreadable would mean never filling
    // the chain. That is a property of every spare on it, not of the subset
    // that happens to clear a size floor.
    //
    // Scoping them here instead reads plausibly and is wrong: a chain with one
    // readable token too small to promote ($60K cap, +8%) and one big unreadable
    // one (a pool younger than a day) would have `anyReading` false, fire the
    // exemption, and publish the unreadable one as a row with a BLANK
    // PERCENTAGE — on a chain that demonstrably has coverage. That is
    // `$MOONCOIN | 12,220,809$` with nothing beside it, the exact row
    // `hasReading` was written to keep off the board, reintroduced by the code
    // written to improve it. With `ranked` the chain simply goes short and the
    // market filler covers it, which is what a gap is for.
    //
    // And a forced run, because that is the one place this differs from every
    // other rule here. `step.forced` (⚡ Run now, and `forceChain`) deliberately
    // ignores the gain floor and the free-fall bound: those govern how
    // DISCRETIONARY the bot is being, and an operator tapping Run now has
    // decided that for it. These floors are not that — they are the operator's
    // standing answer to "what may go on this board at all", and a button that
    // quietly published `VOL $0.05` would reproduce the exact report this was
    // written for, from the one path an operator uses while they are watching.
    // Refusing costs nothing they cannot see: it is counted, named with the
    // token and its number, and both floors are one tap away on the same panel.
    const refusals = [];
    const ranQualified = ranked.filter((r) => {
      const bad = rowRefusal(r, cfg);
      // ⚠️ ONLY A ROW WE ACTUALLY LOOKED AT IS COUNTED AS REFUSED.
      //
      // `byGain` prices at most PROBE_CAP candidates a chain and leaves
      // the tail annotated `undefined` — "we never looked", deliberately
      // distinct from "we looked and there is nothing". Those rows are still
      // filtered out, and must be: promoting a token nobody priced is how a
      // dead row reaches the board with no decision behind it. But COUNTING
      // them as "below the floors" would tell an operator with 100 listings
      // that 75 of their tokens are too small, about tokens this pass never
      // opened — a number that sends them to change a setting over a cap
      // nobody read. `_change === undefined` is the repo's existing spelling
      // of "never looked".
      if (bad && looked(r)) refusals.push({ r, bad });
      return !bad;
    });
    const unread = ranked.filter((r) => r._unread).length;
    if (unread) {
      unreadByChain.set(step.id, unread);
      // INFO, not debug. A cycle that could not read most of its candidates
      // publishes a short board, and "why is the board short" has to be
      // answerable from pm2 alone.
      log.info(
        `[autotrend] ${step.id}: could not price ${unread} of the ${considered} candidate(s) opened — the market read failed, ` +
          `not the tokens. GECKOTERMINAL_API_KEY raises the shared ceiling; see the [gt] boot line.`,
      );
    }
    if (refusals.length) {
      // INFO, not debug: with the floors on, this is the commonest reason a
      // chain sits under its minimum, and "why is the board short" has to be
      // answerable from pm2 alone. Capped — a chain with forty dead listings
      // must not print forty of them every cycle.
      log.info(
        `[autotrend] ${step.id}: ${refusals.length} candidate(s) below the free-trending floors ` +
          `(${floorsPhrase(cfg)}) — ` +
          refusals.slice(0, 5).map(({ r, bad }) => `${r.sym || "?"} ${bad.why}`).join(", ") +
          (refusals.length > 5 ? `, +${refusals.length - 5} more` : ""),
      );
    }
    // Losers are not promoted. `change` is attached by byGain; null means the
    // price could not be read, and those stay eligible on purpose.
    // A token with no market ANYWHERE (no price, not merely no 24h reading) is
    // only a candidate where nothing else on the chain is priced either — see
    // the floor fill below, which states the reasoning in full.
    const anyPriced = ranked.some((r) => r._priced);
    const hasMarket = (r) => !anyPriced || r._priced !== false;
    // ⚠️ A TRENDING ROW WITHOUT A PERCENTAGE IS THE THING THAT GOT REPORTED.
    //
    // "beberapa token di trending channel mengapa tidak ada kenaikan atau
    // penurunan %" — $MOONCOIN and $RLUSD sat on the pinned board with a market
    // cap and no number beside it. The board is a claim about what is MOVING;
    // a row that cannot say how much is a row that cannot make the claim, and
    // an unreadable change may never be rendered as a 0% to say it anyway.
    //
    // So a slot this bot books ITSELF must carry a reading. The exemption is
    // the same one `hasMarket` makes and is exactly as narrow: only where
    // NOTHING on the chain has a reading do the unreadable go on — otherwise a
    // chain no indexer covers would never fill, which is the whole reason the
    // unpriced exemption exists. The unprobed tail (`_change === undefined`) is
    // treated as unreadable rather than as a maybe: promoting a token we never
    // looked at is how a blank reaches the board with nobody having decided it
    // should.
    const anyReading = ranked.some((r) => Number.isFinite(r._change));
    const hasReading = (r) => !anyReading || Number.isFinite(r._change);
    const worthy = step.forced
      ? ranQualified
      : ranQualified.filter(
          (r) => (r._change === null || r._change >= cfg.minGainPct) && hasMarket(r) && hasReading(r),
        );
    // ⚠️ THE MINIMUM OUTRANKS THE GAIN FLOOR.
    //
    // `min +5% 24h` with a flat market left ETHEREUM publishing 3 rows and BASE
    // 2 against a floor of 5 — every spare listing on those chains was down a
    // percent or two, so nothing was promoted and the board simply stayed
    // short. The operator had to tap ⚡ Run now by hand (which ignores the
    // floor) to get a token on the board, which is the tell.
    //
    // So the floor applies to the DISCRETIONARY part of the target only. Up to
    // `perChainMin` the best available candidates go on regardless — `ranked` is
    // already sorted by 24h change, so "regardless" still means the best ones —
    // because a board under the number the operator set is a worse product than
    // a board carrying a token that is down 2%. Above the minimum, the floor is
    // honoured and the chain is simply left where it is.
    const picks = worthy.slice(0, step.need);
    if (!step.forced && picks.length < step.needFloor) {
      const chosen = new Set(picks);
      // …but NOT at any price. The board once carried a token at −99.94% on a
      // $1,648 market cap, and "the board must be full" must not bring that
      // back: a slot filled by a token in free-fall is worse than a short
      // board, which is the one direction this trade-off does not go. Unpriced
      // tokens stay exempt (Robinhood has no indexer — judging them by a number
      // nobody can read would mean never filling that chain at all).
      // The unpriced exemption is deliberate and NARROWER than it looks. Its
      // stated reason is "a chain no indexer covers would never fill" — so it
      // applies to a token whose 24h READING is missing, not to one with no
      // market at all. A token GT and DexScreener both have nothing for
      // publishes as a bare ticker: no percentage, no cap, nothing. That row
      // was on the board, and it is what got reported.
      //
      // `_priced === false` is only trusted where something else on this chain
      // IS priced. Where nothing is, the old reason still holds and the
      // unpriced go on — a short board on a chain no indexer covers helps
      // nobody.
      // `hasReading` binds THIS door too. The free-fall bound taught the same
      // lesson one field over: a rule the floor fill does not honour is a rule
      // the floor fill deletes, because its picks book their slot directly.
      const fillable = (r) =>
        !chosen.has(r) &&
        (r._change === null || r._change >= -FLOOR_FILL_MAX_DROP) &&
        hasMarket(r) &&
        hasReading(r);
      // ⚠️ FROM `ranQualified`, NEVER FROM `ranked`. This is the pass whose
      // whole purpose is to overrule a floor — the minimum outranks the gain
      // floor — so it is exactly the pass that would delete the cap and volume
      // floors by reaching around them, and it would do it silently, on the
      // chains that are short, which is every chain the operator is looking at.
      // The free-fall bound has this scar already: a rule the floor fill does
      // not honour is a rule the floor fill deletes.
      const extra = ranQualified.filter(fillable).slice(0, step.needFloor - picks.length);
      if (extra.length) {
        log.info(
          `[autotrend] ${step.id}: promoting ${extra.length} below the +${cfg.minGainPct}% floor to reach the minimum of ${cfg.perChainMin} ` +
            `(${extra.map((r) => `${r.sym || "?"} ${r._change === null ? "unpriced" : `${r._change.toFixed(1)}%`}`).join(", ")})`,
        );
      }
      picks.push(...extra);
    }
    // ⚠️ A SPARE IN FREE-FALL IS NOT A SPARE — the fourth cause.
    //
    // Live board, 19 Aug: Base sat at 4/5 with two spare listings and stayed
    // there. Both were below −15%, so the floor fill above skipped them (right),
    // and `gap()` was never called because the chain "has listings" (wrong) —
    // so the market filler was never asked either. Nothing in the loop could
    // move it, ever: the promoter refuses those two on every cycle for the same
    // reason, and refusing is not a state that resolves itself.
    //
    // The gate `gap()` documents is "can this chain fill the minimum from its
    // OWN listings?", and a token this pass may never promote cannot. It is
    // only the FLOOR shortfall that is asked for — above the minimum the
    // operator's `minGainPct` legitimately leaves the chain where it is, which
    // is the red-day spree `gap()` exists to prevent and which this does not
    // re-open.
    if (!step.forced && picks.length < step.needFloor) {
      // ⚠️ NAME WHICH REFUSAL IT WAS. This line used to assert "every spare is
      // below −15%" for every way a spare can be unusable, and with the quality
      // floors on that is now most often false — it would send an operator to
      // look at a percentage when the real answer is a $0.05 volume. The
      // refusals were counted a few lines up precisely so this can say so.
      // ⚠️ …AND "EVERY SPARE" IS ONLY EVER TRUE OF THE SPARES THIS PASS
      // OPENED. It said it about all of them while the ranking pass read a
      // bounded window, so a chain with 175 unopened listings was reported as
      // a chain of dead tokens — the sentence an operator acts on, about rows
      // nobody had looked at.
      const scope = considered < ranked.length ? "every spare opened this pass" : "every spare";
      const whyShort = refusals.length
        ? `${scope} is below the free-trending floors (${floorsPhrase(cfg)})`
        : `${scope} is below −${FLOOR_FILL_MAX_DROP}%`;
      short.push(`${step.id} (needs ${step.needFloor - picks.length} more to reach the minimum; ${whyShort}${ofSpares})`);
      gap(step.id, step.needFloor - picks.length);
    }
    // How many of this chain's spares the floors refused, so the watch can name
    // the cause rather than guessing between three of them. Recorded even when
    // the chain filled anyway: the board is what matters, and a chain that
    // reached its minimum is not short whatever was refused on the way.
    floorRefusedByChain.set(step.id, refusals.length);
    // Counted over `ranQualified` — the rows that CLEARED the floors — because
    // that is the set the shortfall has to be explained out of. Mutually
    // exclusive with the floor count by construction, so the ladder in
    // `trendingWatch` can say which one accounts for all of them.
    freeFallByChain.set(
      step.id,
      ranQualified.filter((r) => Number.isFinite(r._change) && r._change < -FLOOR_FILL_MAX_DROP).length,
    );
    noReadingByChain.set(step.id, ranQualified.filter((r) => !hasReading(r) || !hasMarket(r)).length);
    if (!picks.length) {
      // No gap() HERE: this chain is at or above the minimum and its spares are
      // simply not up enough — the gain floor working as designed. Anything
      // below the minimum was already gapped above. See gap().
      short.push(`${step.id} (needs ${step.need}; ${ranked.length} candidate(s)${ofSpares}, none up ${cfg.minGainPct}% or more)`);
      continue;
    }
    if (picks.length < step.need) {
      short.push(`${step.id} (needs ${step.need}, only ${picks.length} up ${cfg.minGainPct}% or more${ofSpares})`);
    }
    for (const r of picks) {
      // Random duration in [minHours, maxHours] — different per token, so the
      // slots expire at staggered (random) times and refill naturally.
      const hours = cfg.minHours + Math.floor(rng() * (cfg.maxHours - cfg.minHours + 1));
      try {
        await api.bookTrending(r.chain, r.address, hours);
        promoted++;
        log.info(
          `[autotrend] ${step.forced ? "FORCED " : ""}promoted ${r.chain}/${String(r.address).slice(0, 8)}… (${r.sym || "?"}) for ${hours}h`,
        );
        // The first promotion of a run posts immediately; the rest queue and
        // drain on the 45s timer, spaced by announceGapMin. A cold start tops
        // up five networks at once — posting all 25 in a burst is the firehose
        // this used to avoid by DROPPING them, which left tokens on the board
        // with no post at all. Queue, don't drop.
        if (!announcedThisRun) {
          const why = await tryAnnounce(r, { hours }).catch(() => "error");
          announcedThisRun = why === null;
          if (isRetryable(why)) await queueAnnounce(r, hours);
        } else {
          await queueAnnounce(r, hours);
        }
      } catch (e) {
        // ⚠️ AS LOUD AS THE LINE ABOVE IT. This was `log.debug`, and the
        // SUCCESS beside it is `log.info` — so a working promotion logged and
        // a failing one did not, on the one path that puts a row on the board.
        // Production does not print debug, so a site refusing every booking
        // decayed the board with nothing anywhere saying why: the chain simply
        // read as short, every surface blamed the floors, and the operator was
        // sent to change a setting that had refused nothing. This file's own
        // notes say the exact asymmetry has had to be fixed in three services;
        // this is the fourth.
        bookFailed++;
        lastBookErr = e.message;
        log.warn(`[autotrend] ${step.id}: the site refused a booking for ${r.sym || String(r.address).slice(0, 8)} — ${e.message}`);
      }
    }
    if (bookFailed) bookFailedByChain.set(step.id, { n: bookFailed, why: lastBookErr });
  }
  // The rotation's stamps, written ONCE. Every announce path above reloads the
  // state file, so a per-chain save would be overwritten by the next of them.
  if (probesTouched) {
    const st = loadState();
    st.probe = pruneProbes(probes, now);
    await saveState(st);
  }
  // The board is short and nothing here can fix it: those chains need LISTINGS,
  // not another cycle. It is ADVICE about a semi-permanent condition, not an
  // incident — so it goes out once a DAY, and the mark is on disk.
  //
  // It used to be an hourly in-memory guard and it spammed the operator's
  // channel anyway: `lastShortWarnAt` and the logger's own 15-minute
  // de-duplication both live in process memory, so every pm2 restart re-armed
  // both. A deploy afternoon put five identical warnings in the channel inside
  // ninety minutes. pm2 logs still get the line every cycle at debug level.
  // ── The gap the promotion pass could not close ───────────────────────────
  //
  // Promoting can only ever reach as far as what is LISTED on a chain, so a
  // chain with three listings publishes three rows for ever. This is where that
  // stops being a note in a log an operator does not read and becomes an
  // action: list the chain's biggest tokens, exactly as many as are missing.
  //
  // Bounded three ways on purpose — a floor on market cap, a floor on
  // liquidity, and a cap per chain per cycle — because the failure mode of an
  // unbounded filler is a public board full of tokens nobody chose.
  const filled = [];
  const fillWhyByChain = new Map();
  if (cfg.fillFromMarket && cfg.fillMaxPerCycle > 0 && gaps.size) {
    const fill = (deps && deps.fillChain) || require("./trendFill").fillChain;
    for (const [id, need] of gaps) {
      try {
        const r = await fill(id, Math.min(need, cfg.fillMaxPerCycle), { cfg, now, maxDropPct: FLOOR_FILL_MAX_DROP });
        if (r && r.listed.length) {
          filled.push(`${id}: ${r.listed.map((x) => x.sym).join(", ")}`);
          log.info(`[autotrend] filled ${id} with ${r.listed.length} big-cap listing(s) — the board was ${need} short`);
        } else if (r && r.why) {
          fillWhyByChain.set(id, r.why);
          // A fill that could not happen is its own fact, and it is the one an
          // operator needs: "GT is rate-limited" and "every big token here is
          // already listed" have different answers.
          // INFO, not debug — production does not print debug, so the one line
          // explaining a permanently short board went to nobody. It is also the
          // line that distinguishes "GT is rate-limited" from "every big token
          // here is already listed", which have different answers.
          log.info(`[autotrend] could not fill ${id}: ${r.why}`);
          short.push(`${id} (could not fill: ${r.why})`);
        }
      } catch (e) {
        log.warn(`[autotrend] fill ${id} failed: ${e.message}`);
      }
    }
  }
  if (filled.length) log.info(`[autotrend] board topped up from the market → ${filled.join(" · ")}`);

  // ── Did the board actually end up where the operator set it? ──────────────
  //
  // Everything above is a CAUSE. This watches the promise: every configured
  // chain carries at least `perChainMin`. Three rounds of "trending sangat
  // sedikit" were reported by the operator counting rows in the channel,
  // because nothing here ever said it out loud — see trendingWatch.js.
  if (!chain) {
    try {
      const watch = require("./trendingWatch");
      const st = loadState();
      const after = await api.getListings().catch(() => listings);
      const snapshot = cfg.chains.map((id) => ({
        id,
        featured: after.filter((r) => isFeatured(r) && on(r, id)).length,
        floor: cfg.perChainMin,
        eligible: after.filter((r) => r.status === "approved" && !isFeatured(r) && on(r, id)).length,
        fillWhy: fillWhyByChain.get(id) || null,
        gainFloor: cfg.minGainPct,
        // ⚠️ `eligible` above is the RAW spare count — approved and not
        // featured, before any floor. Without this the watch would report a
        // chain full of $0.05-volume listings as "N spare listing(s) here and
        // none went on — they are below −15%", which is a true count under a
        // false reason, and it is the reason the operator would act on.
        floorRefused: floorRefusedByChain.get(id) || 0,
        unread: unreadByChain.get(id) || 0,
        // How many of `eligible` this pass actually opened. Without it the
        // watch asserts "N spare listing(s) here, and none went on" about rows
        // the rotating window has not reached yet — the same false claim the
        // log line was making one function up.
        considered: consideredByChain.has(id) ? consideredByChain.get(id) : null,
        // The two gates BELOW the floors, plus the one that is not a refusal at
        // all: a booking the site declined. Without them a chain whose spares
        // cleared every floor and still did not go on is reported as a floor
        // problem — the cause that does not account for the shortfall.
        freeFall: freeFallByChain.has(id) ? freeFallByChain.get(id) : 0,
        noReading: noReadingByChain.has(id) ? noReadingByChain.get(id) : 0,
        bookFailed: (bookFailedByChain.get(id) || {}).n || 0,
        bookWhy: (bookFailedByChain.get(id) || {}).why || null,
        // The PHRASE, not the two numbers: `trendingWatch` is pure and must not
        // grow its own idea of how a floor of 0 reads (it had one, and it
        // printed `min cap $0`).
        floorsText: floorsPhrase(cfg),
      }));
      const { state: nextWatch, alerts } = watch.evaluate(snapshot, st.boardWatch, { now: Date.now() });
      st.boardWatch = nextWatch;
      await saveState(st);
      for (const a of alerts) log.alert(a.text);
    } catch (e) {
      // A diagnostic must never be why a cycle fails.
      log.debug(`[autotrend] board watch: ${e.message}`);
    }
  }

  if (short.length) {
    const line = `[autotrend] board below target on ${short.join(", ")} — list more tokens on those chains, or lower the per-chain target`;
    log.debug(line);
    if (ops.due(SHORT_WARN_KEY, SHORT_WARN_MS)) {
      await ops.mark(SHORT_WARN_KEY).catch(() => {});
      log.noise(line);
    }
  }
  return promoted;
}
const OFF_NOTE_KEY = "autotrend_off_note";
const OFF_NOTE_MS = 3600_000;
const SHORT_WARN_KEY = "autotrend_board_short";
const SHORT_WARN_MS = Math.max(3600_000, Number(process.env.AUTOTREND_SHORT_WARN_HOURS || 24) * 3600_000);

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

/** Self-rescheduling loop with a RANDOM gap each cycle. Config is re-read every
 *  cycle, so enabling/tuning it from the admin bot applies without a restart.
 *  While disabled it still ticks (every 10 min) so an enable is picked up. */
function start() {
  let timer = null;
  let stopped = false;
  // Drain whatever the ADMIN bot queued (its per-chain "Run now") — here, in the
  // process that can actually post. 45s so a forced promotion is announced
  // within a minute instead of at the next random cycle, up to 2h away.
  const drain = setInterval(() => {
    drainPending().catch((e) => log.debug(`[autotrend] drain: ${e.message}`));
  }, 45_000);
  if (drain.unref) drain.unref();
  const schedule = () => {
    if (stopped) return;
    const cfg = get();
    const gapMin = cfg.enabled ? randInt(cfg.minGapMin, cfg.maxGapMin) : 10;
    timer = setTimeout(tick, gapMin * 60 * 1000);
  };
  const tick = async () => {
    // ⚠️ THE HEARTBEAT, and it is the point of this whole block.
    //
    // Every failure path in this loop logged at `debug` and every success at
    // `info`, so the loop was only ever VISIBLE WHEN IT WORKED. A live box went
    // nine hours and three restarts with no `[autotrend]` line at all while the
    // board decayed from 5/5 to 2/5 — and "the cycle is not running", "the
    // cycle ran and had nothing to do" and "the cycle threw" were the same
    // observation: none.
    //
    // So a cycle that COMPLETES says so, once, at info. Silence now means the
    // loop is dead, which is the only thing an operator can act on. It is at
    // most three lines an hour on the shipped 20–120 min band — and the enabled
    // check is here rather than inside `runOnce` because the early return for a
    // disabled service is one of the silences this exists to break.
    const t0 = Date.now();
    const on = get().enabled;
    try {
      const n = await runOnce();
      if (on) {
        log.info(`[autotrend] cycle done in ${Date.now() - t0}ms — ${n} promoted`);
      } else if (ops.due(OFF_NOTE_KEY, OFF_NOTE_MS)) {
        // Ticking every 10 min while OFF would put 144 of these a day in the
        // log. Hourly, so silence still means the loop stopped rather than that
        // the operator switched it off.
        await ops.mark(OFF_NOTE_KEY).catch(() => {});
        log.info(`[autotrend] cycle skipped — auto-trending is OFF on ⚙️ Auto-Trend`);
      }
    } catch (e) {
      // Swallowed at debug before, so a cycle that threw on every pass was
      // indistinguishable from a healthy quiet one.
      log.warn(`[autotrend] cycle FAILED after ${Date.now() - t0}ms: ${e.message}`);
    }
    schedule();
  };
  // RANDOM boot delay, not a fixed 60s: once this loop publishes, a fixed delay
  // puts a public post at exactly one minute after every restart — a visible
  // machine cadence, the same tell the random gap already avoids.
  timer = setTimeout(tick, (30 + Math.random() * 150) * 1000);
  return {
    stop: () => {
      stopped = true;
      clearInterval(drain);
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Force a promotion on ONE chain and say what happened.
 *
 * runOnce() returns a count, which is all the scheduler needs — but a button in
 * the admin panel has to explain a zero, and "0" has three very different
 * causes: nothing listed on that chain, everything there already trending, or
 * the API refused the booking. Silence on a tap reads as "the button is
 * broken", which is exactly how this was reported.
 *
 * @returns {Promise<{promoted:number, syms:string[], reason:string}>}
 */
async function forceChain(chain, { count = 1, rng = Math.random } = {}) {
  const cfg = get();
  const id = String(chain || "").toLowerCase();
  let listings;
  try {
    listings = await api.getListings();
  } catch (e) {
    return { promoted: 0, syms: [], reason: `listings unavailable (${e.message})` };
  }
  const now = Date.now();
  const isFeatured = (r) => r.status === "approved" && r.trendingRank != null && (!r.trendExp || r.trendExp > now);
  const onChain = (r) => String(r.chain || "").toLowerCase() === id;
  const approved = listings.filter((r) => r.status === "approved" && onChain(r));
  if (!approved.length) return { promoted: 0, syms: [], reason: `no listings on ${id} yet` };
  // No tier filter: this is the admin's own "put one there now" button.
  const eligible = approved.filter((r) => !isFeatured(r));
  if (!eligible.length) {
    return { promoted: 0, syms: [], reason: `all ${approved.length} listed token(s) on ${id} are already trending` };
  }
  // Rotates like the cycle does, and for the same reason: a ⚡ tap that opened
  // the same window every time would keep answering "all your listings are
  // below the floors" about the same rows, on a chain with hundreds. The
  // stamps are shared with `runOnce`, so a tap moves the cycle's window on too.
  const probes = loadState().probe;
  const ranked = await byGain(eligible, rng, { probes, now });
  {
    const st = loadState();
    st.probe = pruneProbes(probes, now);
    await saveState(st);
  }
  // The quality floors bind this button too — see the long note on the same
  // filter in `runOnce`. ⚡ Run now is the path an operator uses while they are
  // WATCHING the board, so it is the last place that may publish a token with
  // five cents of volume; a floor it did not honour would be a floor with a
  // one-tap bypass. The refusal names the tokens and both numbers, because
  // "nothing qualified" with no figures beside it is a button that appears
  // broken, and the fix (lower a floor, or 🧲 fill from market) is on the same
  // screen.
  const refused = [];
  const qualified = ranked.filter((r) => {
    const bad = rowRefusal(r, cfg);
    // ⚠️ ONLY A ROW WE OPENED IS NAMED AS REFUSED — the counter's rule, which
    // this button never had. `rowRefusal` answers "cap could not be read" for
    // the unopened tail exactly as readily as for a $1K token, so on a chain
    // with 200 spares this said "all 200 spare listing(s) on solana are below
    // the free-trending floors" about 160 rows nobody had looked at: a false
    // accusation, on the one screen an operator is watching while they tap,
    // pointing them at a floor that had refused nothing of the sort.
    if (bad && looked(r)) refused.push(`${r.sym || String(r.address).slice(0, 6)} ${bad.why}`);
    return !bad;
  });
  if (!qualified.length) {
    const seen = ranked.filter(opened).length;
    const tail = ranked.length - seen;
    return {
      promoted: 0,
      syms: [],
      reason:
        `${refused.length} of the ${seen} spare listing(s) opened on ${id} are below the free-trending floors ` +
        `(${floorsPhrase(cfg)}): ${refused.slice(0, 4).join(", ")}` +
        (refused.length > 4 ? `, +${refused.length - 4} more` : "") +
        (tail > 0 ? ` — ${tail} more spare(s) are still queued for the next passes, so tap again` : ""),
    };
  }
  const syms = [];
  let lastErr = null;
  for (const r of qualified.slice(0, Math.max(1, count))) {
    const hours = cfg.minHours + Math.floor(rng() * (cfg.maxHours - cfg.minHours + 1));
    try {
      await api.bookTrending(r.chain, r.address, hours);
      syms.push(`${r.sym || String(r.address).slice(0, 6)} ${hours}h`);
      log.info(`[autotrend] FORCED ${r.chain}/${String(r.address).slice(0, 8)}… (${r.sym || "?"}) for ${hours}h`);
      // forceChain runs in the ADMIN process, where channels/post was never
      // attach()ed — posting from here throws. Hand it to the main bot, which
      // drains the queue within a minute.
      if (get().announce) await queueAnnounce(r, hours).catch(() => {});
    } catch (e) {
      lastErr = e.message;
      log.warn(`[autotrend] forced bookTrending ${r.sym || r.address}: ${e.message}`);
    }
  }
  if (!syms.length) return { promoted: 0, syms, reason: `the site refused the booking (${lastErr || "unknown"})` };
  return { promoted: syms.length, syms, reason: "" };
}

/** How many tokens are featured per chain right now — the panel shows this so
 *  the operator can see WHICH chain is empty before forcing one. */
async function featuredByChain(now = Date.now()) {
  const out = {};
  let listings = [];
  try {
    listings = await api.getListings();
  } catch (e) {
    log.debug(`[autotrend] featuredByChain: ${e.message}`);
    return out;
  }
  for (const r of listings) {
    if (r.status !== "approved") continue;
    const id = String(r.chain || "").toLowerCase();
    out[id] = out[id] || { featured: 0, eligible: 0 };
    if (r.trendingRank != null && (!r.trendExp || r.trendExp > now)) out[id].featured++;
    else out[id].eligible++;
  }
  return out;
}

module.exports = {
  _test: {
    resetShortWarn: () => ops.clear(SHORT_WARN_KEY),
    SHORT_WARN_KEY,
    setAnnouncer: (fn) => (_announcer = fn),
    setLastAt: async (t) => { const st = loadState(); st.lastAt = t; await saveState(st); },
    setAnnounced: async (chain, address, t) => { const st = loadState(); st.announced[keyOf(chain, address)] = t; await saveState(st); },
    // The rotation stamps are persisted and this suite shares one DATA_DIR, so
    // a test that leaves them behind reorders the next test's probe window —
    // the "a persisted setting LEAKS BETWEEN TESTS" scar, one file over.
    forgetProbes: async () => { const st = loadState(); st.probe = {}; await saveState(st); },
    probes: () => loadState().probe,
    setProbes: async (m) => { const st = loadState(); st.probe = m; await saveState(st); },
    boardWatch: () => loadState().boardWatch,
    setBoardWatch: async (w) => { const st = loadState(); st.boardWatch = w; await saveState(st); },
  },
  resetState: resetAnnounceState,
  queueAnnounce,
  get,
  set,
  reset,
  runOnce,
  forceChain,
  featuredByChain,
  announceReason,
  tryAnnounce,
  drainPending,
  isRetryable,
  byGain,
  pendingCount,
  resetAnnounceState,
  start,
  DEFAULTS,
  HARD,
  // The free-fall bound, exported because BOTH doors onto the board have to
  // honour it: promotion here, and the market fill in trendFill.js. One of them
  // refusing a token at −20% while the other lists one is the same board saying
  // two things.
  FLOOR_FILL_MAX_DROP,
  countFloorRefusals,
  /**
   * How many of a `byGain`-ranked list this pass actually OPENED — exported for
   * the same reason `countFloorRefusals` is. `trending:check` had its own copy
   * of the predicate (`r._change !== undefined`), and this file's scar says
   * what a second copy costs: the check's own count of refusals drifted from
   * the bot's and the two disagreed about the one number an operator acts on.
   */
  countOpened: (ranked) => ranked.filter(opened).length,
  // The same predicate, for a caller that needs to FILTER rather than count.
  // Both come from one function so the check cannot end up with a third idea
  // of "did we open this row" — the scar `countFloorRefusals` carries.
  opened,
  floorsPhrase,
  // The probe budget, exported because `trending:check` mirrors this pass and
  // the tests pin that it is BOUNDED — a fixture with fewer rows than the cap
  // cannot reach the branch it claims to cover, which is how a vacuous test
  // goes on passing over a broken window.
  PROBE_CAP,
  /**
   * The rotation's stamps, for a caller that wants to price the window the bot
   * is about to open rather than a prefix of its own. READ-ONLY by contract:
   * `byGain` mutates whatever it is handed and the CALLER persists, so a
   * diagnostic passing this in measures the next window without moving it — a
   * check that advanced the rotation would change the thing it measures.
   */
  probeStamps: () => loadState().probe,
  // …and the quality floors, for exactly the same reason, one round later. Both
  // doors ask THIS function: the promoter through `rowRefusal` above, and
  // `trendFill` for the tokens it would list straight into a slot. A second
  // copy would be two floors, and the free-fall bound has already shown which
  // way that fails — the door without the rule wins, because its picks book
  // their slot directly.
  floorRefusal,
};
