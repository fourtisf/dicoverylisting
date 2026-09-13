// Live market data for a listed token (GeckoTerminal free API, DexScreener
// fallback), used to enrich channel/X posts and drive the pump checker. Same
// sources the website uses; we only ever query specific listed addresses
// (never crawl a chain). Robinhood has no GT coverage (geckoNetwork:null) →
// DexScreener only; chains neither indexes → null (posts show TBA).
const { chainOf } = require("./config/chains");
const launchpads = require("./launchpads");
const ponsChain = require("./ponsChain");
const { bounded } = require("./helpers/bounded");
const log = require("./helpers/logger");

const GT = "https://api.geckoterminal.com/api/v2";

/**
 * How much of a caller's budget the GeckoTerminal stage may spend.
 *
 * Only binds when the caller SAYS it is on a clock (`opts.budgetMs`); the nine
 * background pipelines pass nothing and keep waiting as they always have. What
 * the remainder buys is the launchpad and the curve contract — the two sources
 * that answer for a token no pool indexes, i.e. exactly the token GT is slowest
 * to give up on.
 */
const GT_STAGE_SHARE = 0.55;
// Kept back from the launchpad's slice for the chain merge that follows it.
const CHAIN_RESERVE_MS = 400;
// This module has its own fetch calls against GeckoTerminal, and for a long
// time they went out with no regard for the shared 429 cooldown or for any
// budget — nine background pipelines (pump, rank-up, auto-trend, gainers,
// trending poster, fulfilment, listing) all price tokens through here on
// timers. So the jobs nobody is watching in real time were tripping the rate
// limit, and the buy bot — the one path a group notices going quiet — took the
// two-minute punishment for it.
//
// Same gate as group/gtPairs now, at BACKGROUND priority: these wait, the buy
// bot's trades feed does not.
const gtGate = require("./group/gtPairs");
/** Wait for this process's GeckoTerminal turn. Resolves false when the shared
 *  cooldown is armed or the queue is saturated — the caller must then treat GT
 *  as unavailable and fall through to DexScreener, which is what it already
 *  does for a timeout. */
async function gtTurn() {
  if (gtGate.inCooldown()) return false;
  try {
    await gtGate.gtSlot(gtGate.PRIO_BACKGROUND);
  } catch (_) {
    return false;
  }
  return !gtGate.inCooldown();
}
const HEADERS = { accept: "application/json;version=20230302" };

// num(null) must be null, NOT 0 — Number(null) === 0, which silently defeated
// the `market_cap_usd ?? fdv_usd` fallback (GT returns market_cap_usd:null for
// most unverified/new tokens → mcap became 0 → posts showed "TBA" forever).
const num = (x) => {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
};
// Signed finite number — for values that can legitimately be ≤ 0 (24h change).
const snum = (x) => {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
// A TRADED VOLUME. Zero is a FACT — a pool nobody touched for a day traded
// nothing, and that is exactly the reading the free-trending floor is there to
// act on — so `num` (which answers null for 0) is the wrong reader here and
// would turn "this token is dead" into "we could not tell". A NEGATIVE volume
// is a broken row and is refused, so the two states stay distinguishable:
// `0` means measured-and-empty, `null` means nobody published one.
const vnum = (x) => {
  const n = snum(x);
  return n != null && n >= 0 ? n : null;
};

// DexScreener chainId per dexvra chain — used ONLY to filter candidate pairs.
// NEVER match a DexScreener pair by address alone: the token endpoint returns
// same-address deploys on every chain, and a wrong-chain pair means a wrong
// price. No chain-matching pair → null, never a wrong-chain fallback.
const DS_CHAIN = {
  solana: "solana",
  bsc: "bsc",
  ethereum: "ethereum",
  base: "base",
  tron: "tron",
  ton: "ton",
  sui: "sui",
  // DexScreener now indexes these — used to FILL liquidity/mcap that GT leaves
  // blank for GT-primary chains. Chain-filtered, so price stays correct-chain.
  robinhood: "robinhood",
  plasma: "plasma",
};

// A 24h change beyond this is broken data, not a market move — a pool created
// hours ago compares against a near-zero opening tick and prints six digits.
// format.js already refuses to publish such a number in pump/rank-up copy; the
// board printed "+521366.00%" for BONK because nothing filtered it upstream.
const SANE_CHANGE_PCT = 5000;
// Two sources disagreeing by more than this on market cap means one of them is
// reading a poisoned pool. BONK showed $258M on one refresh and $1.3T on the
// next — a 5,000× "move" in five minutes.
const MCAP_DISAGREE_FACTOR = 20;

// One complaint per token per hour about a broken pool. Bounded so a long-lived
// process cannot accumulate an entry per token it has ever priced.
const BROKEN_POOL_QUIET_MS = 60 * 60 * 1000;
const _brokenPool = new Map(); // "chain/address" → last complaint (ms)
function noteBrokenPool(chain, address) {
  const key = `${chain}/${address}`;
  const now = Date.now();
  const last = _brokenPool.get(key);
  if (last && now - last < BROKEN_POOL_QUIET_MS) return false;
  if (_brokenPool.size > 1000) _brokenPool.clear();
  _brokenPool.set(key, now);
  return true;
}

/** The pool a token's numbers should come from: the DEEPEST one, not whichever
 *  GeckoTerminal happened to list first. A thin, freshly-created pool is where
 *  the absurd percentages and fake valuations live. */
function deepestPool(j) {
  const ids = new Set((j.data?.relationships?.top_pools?.data || []).map((p) => p.id));
  const pools = (j.included || []).filter((p) => p && ids.has(p.id) && p.attributes);
  if (!pools.length) return null;
  return pools.reduce((best, p) =>
    (num(p.attributes.reserve_in_usd) || 0) > (num(best.attributes.reserve_in_usd) || 0) ? p : best,
  );
}

/** A pool's own 24h reading, or null. GT sends the object with a null h24 for a
 *  pool that has not traded in the window, which is a different thing from the
 *  pool not existing. */
const poolChange = (pool) =>
  pool && pool.attributes && pool.attributes.price_change_percentage
    ? snum(pool.attributes.price_change_percentage.h24)
    : null;

/** How thin a sibling pool may be before its percentage stops being about the
 *  token and starts being about the pool. A tenth of the deepest pool's
 *  liquidity is still a real market; a dust pool is where a 4-figure percentage
 *  comes from, which is the thing `deepestPool` exists to avoid. */
const CHANGE_POOL_MIN_SHARE = 0.1;

/**
 * The 24h change to publish, given the deepest pool.
 *
 * ⚠️ "ADA BEBERAPA TOKEN TIDAK ADA PERSENAN" — rows on the public board with a
 * market cap and no percentage. One cause is here: the change was read from the
 * DEEPEST pool and from nowhere else, so a token whose main pool has not traded
 * in 24h (GT sends h24: null) lost its percentage even when a sibling pool of
 * the same token had a perfectly good reading.
 *
 * Price, cap and liquidity still come from the deepest pool — those are claims
 * about the market, and the deepest pool is the honest one. Only the CHANGE
 * falls back, and only to a pool with real liquidity behind it.
 */
function changeFromPools(j, deepest) {
  const own = poolChange(deepest);
  if (own != null) return own;
  const ids = new Set((j.data?.relationships?.top_pools?.data || []).map((p) => p.id));
  const floor = (num(deepest && deepest.attributes && deepest.attributes.reserve_in_usd) || 0) * CHANGE_POOL_MIN_SHARE;
  const alt = (j.included || [])
    .filter((p) => p && ids.has(p.id) && p.attributes && p !== deepest)
    .filter((p) => poolChange(p) != null && (num(p.attributes.reserve_in_usd) || 0) >= floor)
    .sort((a, b) => (num(b.attributes.reserve_in_usd) || 0) - (num(a.attributes.reserve_in_usd) || 0))[0];
  return alt ? poolChange(alt) : null;
}

// ── LAST RESORT: measure the 24h change ourselves, from the pool's own candles ─
//
// "beberapa token di trending channel mengapa tidak ada kenaikan atau penurunan
// %" — rows on the PINNED board with a market cap and no percentage, reported
// again after the sibling-pool fallback and the DexScreener pass had both been
// added. Most of the leftovers were on ROBINHOOD, and that is the whole tell:
// DexScreener did not index it then (`GT_PRIMARY` in group/gtPairs), so GT's `h24`
// is the ONLY reading in the entire fallback chain — when it is null there is
// nothing behind it, and the row publishes bare.
//
// GeckoTerminal serves the same pool's OHLCV, and a 24h change IS "the price
// now against the price 24 hours ago". Two real closes is a MEASUREMENT, not
// the fabricated `+0.00%` this file has always refused to print — the same
// number, taken the long way, and only for a token that would otherwise
// publish a blank.
//
// Through `gtGet`, not a private fetch: it owns the Pro base, the API key, the
// shared 429 cooldown and the queue. A fourth idea of how GT fails is exactly
// what this repo keeps paying for.
const CANDLE_TF = "hour";
const CANDLE_LIMIT = 48; // 48 hourly closes always SPAN at least 24h; see below
const DAY_SEC = 24 * 60 * 60;
// A 24h change moves slowly and the board republishes every few minutes, so the
// same unreadable token would otherwise buy this request on every cycle of
// nine background pipelines. Misses are cached too — a pool with under 24h of
// history does not grow it in ten minutes — but ONLY definitive ones: a
// cooldown or a dead socket is not an answer about the pool, and caching it
// would let a two-minute backoff blank the board for ten.
const CANDLE_TTL_MS = 10 * 60 * 1000;
const CANDLE_CACHE_MAX = 500;
const _candles = new Map(); // "chain/pool" → { at, change, why }

/**
 * The 24h change of one pool, computed from its candles. `{ change, why }`,
 * where `change` is null when it cannot be measured and `why` says so.
 *
 * The two closes are picked by TIMESTAMP, never by position in the list:
 *   • `now`  = the newest candle's close (the pool's last trade)
 *   • `then` = the newest candle at or before `now − 24h` (the last trade
 *              before the boundary — i.e. the price 24 hours ago)
 *
 * A pool that has not traded at all in the window resolves BOTH to the same
 * candle and measures 0.00% — which is the truth about it, and is arrived at
 * rather than assumed. A pool with no candle before the boundary is younger
 * than a day: its "24h change" would be measured from its opening tick, which
 * is precisely where `+521366%` comes from, so it stays unmeasurable.
 *
 * ⚠️ `token` is the TOKEN'S OWN ADDRESS, and it is not optional. GT's OHLCV
 * defaults to the pool's BASE side, which is our token only by luck — in a
 * WETH/OURTOKEN pool it is WETH, and the board would have carried Ethereum's
 * 24h change under a memecoin's ticker. Naming the address removes the guess.
 */
async function changeFromCandles(chain, pool, token, now = Date.now()) {
  const net = chainOf(chain) && chainOf(chain).geckoNetwork;
  if (!net || !pool || !token) return { change: null, why: null };
  const key = `${chain}/${pool}/${token}`;
  const hit = _candles.get(key);
  if (hit && now - hit.at < CANDLE_TTL_MS) return { change: hit.change, why: hit.why };

  const res = await gtGate.gtGet(`/networks/${net}/pools/${pool}/ohlcv/${CANDLE_TF}`, {
    aggregate: 1,
    limit: CANDLE_LIMIT,
    currency: "usd",
    token,
  });
  if (!res.ok) {
    // "GT is rate limited" and "GT has no such pool" are different facts, and
    // only the second one is about the pool — the same line this repo draws
    // everywhere else: an HTTP status means the host was there and answered, a
    // transport failure means it was not. So a 4xx is cached (asking again in
    // ten minutes gets the identical 404, and `poolAddress` can legitimately be
    // a DexScreener pair address GT does not know) while a cooldown, a 429, a
    // 5xx or a dead socket is re-asked. Caching those would let a two-minute
    // backoff blank the board for ten.
    const out = { change: null, why: `could not read the pool's candles (${res.reason || `HTTP ${res.status}`})` };
    const answered = res.status >= 400 && res.status < 500 && res.status !== 429;
    if (answered) {
      if (_candles.size > CANDLE_CACHE_MAX) _candles.clear();
      _candles.set(key, { at: now, ...out });
    }
    return out;
  }

  const list = (res.body && res.body.data && res.body.data.attributes && res.body.data.attributes.ohlcv_list) || [];
  // GT documents newest-first; sorting rather than trusting that costs nothing
  // and is the difference between a percentage and its inverse.
  const rows = list
    .filter((c) => Array.isArray(c) && Number.isFinite(Number(c[0])) && num(c[4]))
    .map((c) => ({ t: Number(c[0]), close: num(c[4]) }))
    .sort((a, b) => b.t - a.t);

  let out;
  if (!rows.length) {
    out = { change: null, why: "the pool has no candles at all" };
  } else {
    const cut = Math.floor(now / 1000) - DAY_SEC;
    const then = rows.find((c) => c.t <= cut);
    if (!then) {
      out = { change: null, why: "the pool has under 24h of history — a change measured from its opening tick is the +521366% defect" };
    } else {
      const pct = (rows[0].close / then.close - 1) * 100;
      out = Math.abs(pct) > SANE_CHANGE_PCT
        ? { change: null, why: `the candles gave ${Math.round(pct).toLocaleString("en-US")}% — refused as broken (over ${SANE_CHANGE_PCT}%)` }
        : { change: pct, why: null };
    }
  }
  if (_candles.size > CANDLE_CACHE_MAX) _candles.clear();
  _candles.set(key, { at: now, ...out });
  return out;
}

async function fetchGT(chain, address) {
  const net = chainOf(chain) && chainOf(chain).geckoNetwork;
  if (!net) return null;
  try {
    if (!(await gtTurn())) return null; // GT is rate limited — DexScreener fills in
    const res = await fetch(`${GT}/networks/${net}/tokens/${address}?include=top_pools`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const attr = j.data && j.data.attributes;
    if (!attr) return null;
    const price = num(attr.price_usd);
    const mcap = num(attr.market_cap_usd) ?? num(attr.fdv_usd);
    const pool = deepestPool(j);
    const poolId = j.data.relationships?.top_pools?.data?.[0]?.id;
    const poolAddress =
      (pool && pool.attributes && pool.attributes.address) ||
      (poolId ? poolId.split("_").slice(1).join("_") || null : null);
    const rawChange = changeFromPools(j, pool);
    // Publish nothing rather than nonsense: the board prints this straight.
    let change24h = rawChange;
    // WHY there is no reading, for the operator — the board renders "no pool
    // traded in 24h" and "the reading was 12,400% and we refused it" the same
    // way, and only one of those is a broken pool. Never rendered publicly;
    // `trending:check --rows` is the only reader.
    let changeWhy = rawChange == null ? (deepestPool(j) ? "pools have no 24h reading (no trades in the window)" : "GT lists no pool for this token") : null;
    if (rawChange != null && Math.abs(rawChange) > SANE_CHANGE_PCT) {
      // Once per token per hour, not once per poll. A pool with a broken
      // opening tick stays broken, and this runs on the board's refresh
      // interval — one BSC token produced a warning every three minutes,
      // indefinitely. The rejection itself is silent and permanent; the
      // operator only needs to be told the token exists.
      if (noteBrokenPool(chain, address)) {
        log.noise(`[market] GT ${chain}/${address}: ignoring absurd 24h change ${rawChange}% (pool data is broken)`);
      }
      change24h = null;
      changeWhy = `the pool reported ${Math.round(rawChange).toLocaleString("en-US")}% — refused as broken (over ${SANE_CHANGE_PCT}%)`;
    }
    const img = attr.image_url;
    const liq = pool && pool.attributes ? num(pool.attributes.reserve_in_usd) : null;
    // FROM THE DEEPEST POOL, like the price and the liquidity beside it — never
    // summed across pools. A token's siblings are the same market seen twice,
    // and adding them up inflates the one number the trending floor judges a
    // token by. Only the CHANGE falls back to a sibling (see `changeFromPools`),
    // because a missing percentage is a blank row and a missing volume is not.
    const vol24h = pool && pool.attributes ? vnum(pool.attributes.volume_usd?.h24) : null;
    return {
      priceUsd: price,
      mcap,
      liq,
      vol24h,
      poolAddress,
      change24h,
      changeWhy,
      name: attr.name || null,
      symbol: attr.symbol || null,
      logoUrl: img && img !== "missing.png" ? img : null,
    };
  } catch (e) {
    log.debug(`[market] GT ${chain}/${address}: ${e.message}`);
    return null;
  }
}

/** DexScreener fallback — fills price/mcap when GT hasn't indexed the token
 *  yet (fresh pump.fun launches etc.). Pairs are filtered by chain, then the
 *  deepest-liquidity pair wins. */
async function fetchDS(chain, address) {
  const dsChain = DS_CHAIN[chain];
  if (!dsChain) return null;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const pairs = (j.pairs || []).filter((p) => p && p.chainId === dsChain);
    if (!pairs.length) return null;
    pairs.sort((a, b) => (num(b.liquidity?.usd) || 0) - (num(a.liquidity?.usd) || 0));
    const p = pairs[0];
    const base = p.baseToken || {};
    return {
      priceUsd: num(p.priceUsd),
      mcap: num(p.marketCap) ?? num(p.fdv),
      liq: num(p.liquidity?.usd),
      vol24h: vnum(p.volume?.h24),
      poolAddress: p.pairAddress || null,
      change24h: p.priceChange ? snum(p.priceChange.h24) : null,
      name: base.name || null,
      symbol: base.symbol || null,
      logoUrl: (p.info && p.info.imageUrl) || null,
    };
  } catch (e) {
    log.debug(`[market] DS ${chain}/${address}: ${e.message}`);
    return null;
  }
}

const tidyDesc = (d) => {
  if (!d || typeof d !== "string") return null;
  const clean = d.replace(/\s+/g, " ").trim();
  // code-point slice — never split an emoji's surrogate pair at the cap
  return clean.length >= 20 ? Array.from(clean).slice(0, 500).join("") : null;
};

/** A launchpad carries the project's OWN description (set at mint) for launches
 *  GeckoTerminal hasn't enriched yet — the text DexScreener shows.
 *
 *  THIS USED TO BE A HARDCODED pump.fun URL, and it was wrong twice over. A
 *  token launched on bonk.fun, Believe, Boop or Moonshot got no overview at all
 *  and the listing fell back to the auto-written intro; and it was this repo's
 *  SECOND private answer to "which pump.fun host is current", the other living
 *  in tradebot/solana.js — the two drifted apart once already and Solana snipe
 *  discovery was blind for days behind a green health tick. There is now one
 *  table, in shared/launchpads, and both processes read it.
 *
 *  Best-effort: any failure → null, the caller falls back to an auto-intro. */
async function fetchLaunchpadDescription(chain, address) {
  try {
    return await launchpads.fetchDescription(chain, address);
  } catch (e) {
    log.debug(`[market] launchpad ${chain}/${address}: ${e.message}`);
    return null;
  }
}

/** Project description for the "overview" paragraph — GeckoTerminal's token-info
 *  endpoint first, then the launchpad the token was minted on (GT often lacks
 *  it for a fresh launch, and always lacks it before migration). One collapsed
 *  paragraph, or null. */
async function fetchTokenDescription(chain, address) {
  const net = chainOf(chain) && chainOf(chain).geckoNetwork;
  // `if (net && await gtTurn())`, NOT an early return inside the try: a rate
  // limited GeckoTerminal must fall THROUGH to the launchpad below, which is the
  // better source for a fresh launch anyway. Returning here would have
  // made every description on Solana disappear for the length of a cooldown.
  if (net && (await gtTurn())) {
    try {
      const res = await fetch(`${GT}/networks/${net}/tokens/${address}/info`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const j = await res.json();
        const gt = tidyDesc(j.data && j.data.attributes && j.data.attributes.description);
        if (gt) return gt;
      }
    } catch (e) {
      log.debug(`[market] GT info ${chain}/${address}: ${e.message}`);
    }
  }
  // Every chain a pad covers, not just Solana — four.meme on BNB Chain and
  // Virtuals on Base have the same gap, and the old `chain === "solana"` guard
  // meant they could never be asked.
  if (launchpads.covers(chain)) return fetchLaunchpadDescription(chain, address);
  return null;
}

/**
 * The launchpad, LAST, and only for what the indexers left blank.
 *
 * Both indexers read pools. A token that has not migrated has no pool, so both
 * come back empty for its entire pre-migration life and every post about it
 * said "TBA" — for a token whose price, market cap and holder count are all
 * public on its launchpad. Filling here rather than replacing keeps the rule
 * the rest of this file is built on: a live pool reading always beats a
 * launchpad's copy of the same number.
 */
async function fillFromLaunchpad(chain, address, out, padMs = 0) {
  if (!launchpads.covers(chain)) return out;
  const read = launchpads.fetchTokenInfo(chain, address).catch((e) => {
    log.debug(`[market] launchpad ${chain}/${address}: ${e.message}`);
    return null;
  });
  // ⚠️ A SLICE for a caller on a clock, never the whole of what is left. A
  // pad host that hangs costs LAUNCHPAD_TIMEOUT_MS (6s) per read until its
  // breaker benches it; behind the GT slice (4.4s of an 8s budget) that is a
  // pad leg ending at t≈10.4s — past the post's bound, with the chain read
  // that had answered at t≈1s still un-consulted one line below. The pad's
  // answer keeps precedence when it arrives in time; a pad that overruns its
  // slice is INCONCLUSIVE, and the chain fills what it left. Unbudgeted
  // callers wait exactly as they always did.
  const lp = padMs > 0
    ? await bounded(read, padMs, () => {
        log.debug(`[market] launchpad ${chain}/${address}: passed its ${padMs}ms slice — falling through to the chain`);
        return null;
      })
    : await read;
  return mergeCurve(out, lp);
}

/**
 * The CURVE CONTRACT, after the HTTP pad — the one source that cannot be
 * unreachable.
 *
 * ⚠️ "Market cap: TBA · Price: TBA" WENT OUT AGAIN, and the round before had
 * fixed a different cause. $WROTE was 1% along a Pons bonding curve, so it has
 * NO POOL and neither indexer can price it however cheaply they are asked —
 * and the leg above then asks Pons over HTTP on a host and a path this repo has
 * never verified (`verified: false`), which the operator's own
 * `launchpads:check` reports unreachable. So every source in this function was
 * either structurally blind to a curve or a guess, while ponsfamily.com showed
 * $0.000004 on a $4,494.71 cap in the same minute.
 *
 * This file already knows the answer and says it one module over: *"the one
 * source that cannot be unreachable — the token contract itself — was the one
 * nobody asked."* That was wired into `discovery.fetchTokenInfoX` for the
 * LISTING FORM and nowhere else, so the form autofilled a name and a ticker
 * off the chain and the post announcing the very same token printed TBA.
 *
 * Order is the SAME as discovery's (pads, then chain) rather than a second
 * private precedence for the same two sources — two orders is how the form and
 * the post come to disagree about a token's price.
 *
 * ⚠️ BUT THE REQUEST IS STARTED AT THE TOP OF `fetchMarket`, NOT HERE, AND
 * WITHOUT THAT THIS WHOLE FIX SHIPS INERT. Precedence is about which ANSWER
 * wins; it must not decide who gets to ASK. Read serially this is fourth in a
 * queue inside the post's 8s ceiling — DexScreener misses, GeckoTerminal waits
 * on `gtSlot(PRIO_BACKGROUND)` which has no deadline of its own, the launchpad
 * spends 6s discovering that its guessed host is unreachable — so the contract
 * would be asked with about two seconds left of an 8s budget, against its own
 * 5s timeout, and the post would print TBA exactly as it did before. A wiring
 * that does nothing refuses beautifully.
 *
 * Starting it up front costs an INDEXED Robinhood token one localhost request
 * whose answer is then thrown away — bounded by `covers` (Robinhood only), by
 * the route's own cache, and by the reader's memo of the tokens Pons never
 * launched, which is the answer for every graduated token on the chain.
 */
function startChainRead(chain, address) {
  if (!ponsChain.covers(chain)) return null;
  // ⚠️ `.catch` AT CREATION, not at the await. Nothing awaits this promise on
  // the path where the indexers answered everything, and an unhandled
  // rejection ends the process on Node 18.
  return ponsChain.fetchTokenInfoX(chain, address).catch((e) => {
    log.debug(`[market] pons-chain ${chain}/${address}: ${e.message}`);
    return null;
  });
}

async function fillFromChain(chain, address, out, started) {
  if (!ponsChain.covers(chain)) return out;
  const r = await (started || startChainRead(chain, address));
  // "We could not ask" and "Pons never launched this token" are different
  // facts, and only the second is about the token — but neither fills anything,
  // so the distinction is only worth a line for whoever reads the log.
  if (r && !r.ok && r.why) log.debug(`[market] pons-chain ${chain}/${address}: ${r.why}`);
  return mergeCurve(out, r && r.info);
}

/**
 * Fill an indexer record's holes from a pre-migration source, or build one from
 * scratch when the indexers had nothing at all.
 *
 * One merge for both curve sources: they answer the same fields in the same
 * shape, and a second copy of these rules is how the pad leg and the chain leg
 * would come to disagree about whether a curve has a volume.
 */
function mergeCurve(out, lp) {
  if (!lp) return out;
  const base = out || {};
  return {
    ...base,
    priceUsd: num(base.priceUsd) ?? num(lp.priceUsd),
    mcap: num(base.mcap) ?? num(lp.mcap),
    liq: num(base.liq) ?? num(lp.liq),
    // A launchpad publishes no 24h volume, so this can only ever carry through
    // what an indexer already found. NOT defaulted to 0: a token still on a
    // bonding curve has traded, and calling that "zero volume" would let the
    // free-trending floor refuse it on a number nobody measured.
    vol24h: vnum(base.vol24h),
    // No pool is the whole point — there is nothing to link to yet, and
    // inventing an address here would send a chart link somewhere that 404s.
    poolAddress: base.poolAddress || null,
    change24h: base.change24h ?? null,
    name: base.name || lp.name || null,
    symbol: base.symbol || lp.symbol || null,
    logoUrl: base.logoUrl || lp.logoUrl || null,
    // The curve source's own reason, ONLY while nothing priced the record: a
    // priced record has no hole to explain, and a stale sentence beside a real
    // number is the two-cells-disagreeing defect this repo keeps paying for.
    marketWhy: (num(base.priceUsd) ?? num(lp.priceUsd)) == null ? lp.marketWhy || null : null,
    // Curve state, for the callers that know to look. Ignored by the ones that
    // do not, which is every existing one.
    onCurve: lp.onCurve,
    progressPct: lp.progressPct,
    launchpad: lp.launchpad,
  };
}

/**
 * A PRICED record with NO ARTWORK still takes the CURVE'S logo — from the
 * contract, then from the pad — and says so when it could not ask.
 *
 * DexScreener indexes some pads' bonding curves as ordinary pairs (Pons on
 * Robinhood among them) and has no picture for a token minutes old — so a
 * curve token DS happened to index was priced by DS and drawn by nobody, while
 * the chain read that carries its logo was "one localhost request whose answer
 * is thrown away". The row was born blank on exactly the path that looked
 * healthiest. Every exit of `fetchMarket` goes through here, because a priced
 * answer leaves by three doors and a rule on one of them is a rule the other
 * two do not have.
 *
 * ⚠️ ONLY FOR A CALLER ON A CLOCK (`opts.budgetMs` — the paid post). The nine
 * background pipelines poll every listing on timers and must not wait on a
 * chain read, or pay a pad round trip, for a field they do not render; for them
 * this is a no-op and the read they started stays fire-and-forget exactly as
 * before. An indexer's own logo is an ANSWER and is never replaced.
 */
async function logoFromCurve(out, { chainP, opts, chain, address, startedAt, padAsked }) {
  if (!out || out.logoUrl) return out;
  if (!(Number.isFinite(opts && opts.budgetMs) && opts.budgetMs > 0)) return out;

  // 1. THE CHAIN, which is already in flight and therefore free.
  const r = chainP ? await chainP : null;
  if (r && r.info && r.info.logoUrl) return { ...out, logoUrl: r.info.logoUrl };

  // 2. THE PAD — a genuinely second source, over a different transport.
  //
  // ⚠️ THIS DOOR ASKED ONE SOURCE FOR THE ARTWORK, AND THAT WAS THE WHOLE
  // DEFECT ONE ROUND OVER. `$ORCHFLOWS` (Pons, Robinhood) went out to 12,514
  // subscribers drawing the Dexvra mark, with its own logo rendering on
  // ponsfamily.com in the same minute and its market cap on the banner correct
  // — DexScreener priced it in full, so this returned here, and the single
  // chain read behind it had nothing to give. The chain leg was ADDED to these
  // doors precisely because the pad leg below them is unreachable when an
  // indexer answers everything; asking only the chain is that same lesson
  // half-learnt, one source over.
  //
  // Chain FIRST because it costs nothing extra and it is the authority; the pad
  // only when the chain gave no artwork, at most ONE request per paid post, and
  // never on the doors where `fillFromLaunchpad` already asked it.
  if (!padAsked && launchpads.covers(chain)) {
    const padMs = Math.max(500, opts.budgetMs - (Date.now() - startedAt));
    const lp = await bounded(
      launchpads.fetchTokenInfo(chain, address).catch(() => null),
      padMs,
      () => null,
    );
    if (lp && lp.logoUrl) return { ...out, logoUrl: lp.logoUrl };
  }

  // 3. NOTHING HAS ARTWORK — and "the creator published none" is a CLAIM.
  //
  // A blank row renders as the Dexvra mark, which is the design for a logoless
  // token and looks entirely deliberate, so the post watch deliberately stays
  // silent on it. That silence is only honest while the sources ANSWERED: a
  // node that refused us produces the identical blank, and reporting it as the
  // creator's choice is this file's oldest defect on the one field whose loss
  // is invisible. Only the CHAIN can make the claim — it is the source that
  // cannot be unreachable — so a benched pad says nothing here, or the alert
  // would be permanently red on every Robinhood listing whose owner uploaded
  // nothing.
  let why = null;
  if (ponsChain.covers(chain)) {
    if (!r) why = "the chain read threw";
    else if (!r.ok) why = r.why || "the chain read failed";
    // `ok` with no `info` is a real answer ("not a Pons launch"), and the
    // artwork question is then not ours to answer at all.
    else if (r.info && r.info.readWhy) why = r.info.readWhy;
  }
  return why ? { ...out, logoWhy: why } : out;
}

/**
 * @param {object}  [opts]
 * @param {boolean} [opts.cheap] Ask DexScreener FIRST and stop there the moment
 *   it has the price and the market cap — see `fetchPrice` below for why.
 * @returns {Promise<{priceUsd:number|null,mcap:number|null,liq:number|null,vol24h:number|null,change24h:number|null,poolAddress:string|null}|null>}
 */
async function fetchMarket(chain, address, opts = {}) {
  // ⚠️ THIS PROCESS IS NOT THE ONLY THING ON THIS IP.
  //
  // GeckoTerminal's free tier is ~30 requests a minute counted PER IP, and the
  // website (dexvra.io) runs on the same box. Its candlestick charts have
  // exactly ONE free source of OHLCV — GeckoTerminal — while a price and a
  // market cap have TWO, and DexScreener's costs us nothing at all. So a caller
  // that reads a price and nothing else must not spend the one budget the
  // charts cannot do without: the site answered "Couldn't read the chart just
  // now (GeckoTerminal 429)" while the bot's background pipelines were priced
  // through here on timers.
  //
  // It is not a second idea of how these hosts fail — same two readers, same
  // merge below, one different ORDER — because a third private answer to "is
  // GeckoTerminal up" is what this repo keeps paying for.
  // Started HERE so it runs alongside the indexers rather than behind them —
  // see fillFromChain's header for the arithmetic that makes this load-bearing.
  const chainP = startChainRead(chain, address);
  const startedAt = Date.now();
  const dsFirst = opts.cheap ? await fetchDS(chain, address) : null;
  // ⚠️ THE CHEAP ANSWER HAS TO CARRY WHAT THIS CALLER ACTUALLY READS.
  //
  // This used to return the moment DexScreener had a price and a cap — right
  // for `fetchPrice`, whose callers read exactly those two and throw the rest
  // away, and WRONG for anyone who needs more: they would get a record with
  // `change24h` missing, and a caller that sorts by it (the trending promoter)
  // reads that as "this token has no reading" and refuses the row. Turning the
  // promoter cheap without this would have made the board SHORTER, not
  // cheaper — the fix producing a worse version of the bug it fixes.
  //
  // So the caller names its fields. DexScreener answers only when it has all of
  // them; otherwise this falls through to GT exactly as before, and `dsFirst`
  // is reused below rather than re-asked.
  //
  // 0 is a READING for a volume or a 24h change (a quiet day) and not a price
  // or a cap — which is why the two groups are tested differently rather than
  // with one truthiness check that would drop a real 0.00%.
  const NEED_DEFAULT = ["priceUsd", "mcap"];
  const need = Array.isArray(opts.need) && opts.need.length ? opts.need : NEED_DEFAULT;
  const hasField = (o, f) => (f === "priceUsd" || f === "mcap" ? !!o[f] : Number.isFinite(o[f]));
  if (dsFirst && need.every((f) => hasField(dsFirst, f)))
    return logoFromCurve(dsFirst, { chainP, opts, chain, address, startedAt, padAsked: false });

  // ⚠️ NO SINGLE STAGE MAY CONSUME THE WHOLE BUDGET.
  //
  // `$GG` — a pump.fun Solana token — published `price · market cap · liquidity
  // as TBA` on a box where pump.fun answers perfectly well and the pad entry is
  // `verified: true`. DexScreener misses a bonding curve (no pair), this read
  // then queues on `gtSlot(PRIO_BACKGROUND)` WHICH HAS NO DEADLINE OF ITS OWN,
  // it spent the caller's entire 8s, and `fillFromLaunchpad` two lines below —
  // the one source that HAS that token's price — was never reached.
  //
  // That is the defect the chain leg was fixed for last round, left in place on
  // the leg one line above it: a lesson applied to one branch is a lesson
  // half-learnt. The fix there was concurrency; here it is a SLICE, because a
  // pad request fired for every indexed token on every poll of nine background
  // pipelines is a cost the post does not need to pay — GT answers in
  // milliseconds when it answers at all, so a bound costs a healthy read
  // nothing and only ever takes time away from a queue.
  //
  // A stage that overruns its slice is INCONCLUSIVE, never a verdict — the rule
  // `curveTrade`'s STAGE_MS states, and the fail-safe direction: falling
  // through to the pad costs a request, while treating a queue as "this token
  // has no market" is the TBA being fixed.
  const gtMs = Number.isFinite(opts.budgetMs) && opts.budgetMs > 0
    ? Math.max(1000, Math.floor(opts.budgetMs * GT_STAGE_SHARE))
    : 0;
  const gt = gtMs
    ? await bounded(fetchGT(chain, address), gtMs, () => {
        log.debug(`[market] ${chain}/${address}: GT passed its ${gtMs}ms slice — falling through to the pads`);
        return null;
      })
    : await fetchGT(chain, address);
  // Only skip DexScreener when GT already has EVERYTHING. GT often returns a
  // price+mcap but no liquidity (reserve_in_usd null) for GT-primary chains
  // (Robinhood/Plasma) — without this, "Liquidity: —" stuck forever.
  //
  // `change24h` counts as part of EVERYTHING, for the same reason: the trending
  // board prints it, and a row with a cap and no percentage reads as broken to
  // 10,593 subscribers. It costs nothing where it cannot help — DexScreener
  // does not index the GT-primary chains at all, so `fetchDS` returns before
  // any request is made.
  if (gt && gt.priceUsd && gt.mcap && gt.liq && gt.change24h != null)
    return logoFromCurve(gt, { chainP, opts, chain, address, startedAt, padAsked: false });
  // GT missing entirely, or missing price/mcap/liq → let DexScreener fill gaps.
  // In cheap mode it has ALREADY been asked, and its answer is reused — a miss
  // included. `dsFirst || await fetchDS(...)` would re-ask on every miss, which
  // is the shape that made the cheap read cost two requests instead of one.
  const ds = opts.cheap ? dsFirst : await fetchDS(chain, address);
  let out;
  if (!gt && !ds) out = null;
  else if (!gt) out = ds;
  else if (!ds) out = gt;
  else {
    // Both sources answered. If their market caps disagree wildly, one is reading
    // a poisoned pool — take the numbers backed by the DEEPER liquidity, and say
    // so. Silently averaging or preferring a fixed source is how a $1.3T BONK
    // reaches a pinned public board.
    const trusted = pickTrusted(gt, ds, chain, address);
    out = {
      ...trusted,
      priceUsd: trusted.priceUsd ?? gt.priceUsd ?? ds.priceUsd,
      mcap: trusted.mcap ?? gt.mcap ?? ds.mcap,
      liq: trusted.liq ?? gt.liq ?? ds.liq,
      vol24h: trusted.vol24h ?? gt.vol24h ?? ds.vol24h,
      poolAddress: trusted.poolAddress || gt.poolAddress || ds.poolAddress,
      change24h: trusted.change24h ?? gt.change24h ?? ds.change24h,
      changeWhy: gt.changeWhy || null,
      name: gt.name || ds.name,
      symbol: gt.symbol || ds.symbol,
      logoUrl: gt.logoUrl || ds.logoUrl,
    };
  }
  // Only when something the callers actually render is still missing — an
  // indexed token must not pay a launchpad round trip on every poll, and nine
  // background pipelines call this on timers.
  let padAsked = false;
  if (!out || !out.priceUsd || !out.mcap) {
    // What is LEFT of a budgeted caller's clock, less a reserve for the chain
    // merge below (the chain read started at t=0 and has its own bound, so by
    // now it is usually settled). 0 = no slice = the old unbounded wait.
    const budgeted = Number.isFinite(opts.budgetMs) && opts.budgetMs > 0;
    const padMs = budgeted ? Math.max(500, opts.budgetMs - (Date.now() - startedAt) - CHAIN_RESERVE_MS) : 0;
    out = await fillFromLaunchpad(chain, address, out, padMs);
    padAsked = true;
  }
  // Re-tested, not chained onto the line above: the pad may have answered some
  // of it, and a token whose price arrived but whose cap did not is still a
  // post that prints TBA on one of the two figures it exists to carry.
  if (!out || !out.priceUsd || !out.mcap) out = await fillFromChain(chain, address, out, chainP);
  // EVERY TRENDING ROW CARRIES A PERCENTAGE — the operator's rule, and this is
  // the last place that can still make it true from published data. Only
  // reached when every source above came back with no reading, so an indexed,
  // healthy token never pays for the request.
  //
  // ⚠️ AND NEVER ON THE CHEAP READ. This is an OHLCV call — the single most
  // expensive thing in this file, and the exact endpoint the website's charts
  // are queuing for. A caller that opted out of GeckoTerminal for a price must
  // not be handed a GeckoTerminal request for a 24h change it does not read.
  // A cheap read that reaches DexScreener for the price and GT for the cap
  // would otherwise land here and buy candles for nobody.
  if (!opts.cheap && out && out.change24h == null && out.poolAddress) {
    const c = await changeFromCandles(chain, out.poolAddress, address);
    if (Number.isFinite(c.change)) {
      out.change24h = c.change;
      out.changeWhy = null;
      // Provenance, because the two are not the same claim: the indexer's h24
      // is a published figure, this one we computed. Absent = as published.
      out.changeFrom = "candles";
    } else if (c.why) {
      // Never discard the reason. `trending:check --rows` is the only reader,
      // and "no trades in the window" and "the pool is younger than a day" send
      // an operator to different places.
      out.changeWhy = out.changeWhy ? `${out.changeWhy}; ${c.why}` : c.why;
    }
  }
  return logoFromCurve(out, { chainP, opts, chain, address, startedAt, padAsked });
}

/**
 * Price and market cap for a caller that needs NOTHING ELSE — the cheap read.
 *
 * `fetchMarket` stays GeckoTerminal-first and is still right for everything
 * that publishes a 24h change, a liquidity figure, a pool address or a logo:
 * GT is the better source for all of those, and for the GT-primary chains
 * (Robinhood, Plasma) it is the only one. This is for the pipelines that look
 * at `priceUsd` and `mcap` and throw the rest away — the pump checker being by
 * far the biggest, because it prices EVERY approved listing on a three-minute
 * timer, which is a request a second against a thirty-a-minute ceiling shared
 * with the site's charts.
 *
 * ⚠️ A STORED BASELINE MAY THEREFORE BE COMPARED AGAINST THE OTHER SOURCE, and
 * that is not new: `fetchMarket` already falls through to DexScreener whenever
 * GT is cooled down, so a pump baseline recorded from GT has always been
 * compared against DexScreener readings — intermittently, flipping between the
 * two from poll to poll. Reading one source consistently is strictly steadier
 * than alternating, and the two agree to a fraction of a percent on any token
 * whose deepest pool both can see. `pickTrusted` below is what catches the case
 * where they do not.
 */
const fetchPrice = (chain, address) => fetchMarket(chain, address, { cheap: true });

/** Which of two disagreeing sources to believe. Agreement (or a missing value)
 *  keeps the GeckoTerminal reading, which is the normal path. */
function pickTrusted(gt, ds, chain, address) {
  const a = num(gt.mcap);
  const b = num(ds.mcap);
  if (!a || !b) return gt;
  const ratio = a > b ? a / b : b / a;
  if (ratio < MCAP_DISAGREE_FACTOR) return gt;
  const winner = (num(ds.liq) || 0) > (num(gt.liq) || 0) ? ds : gt;
  log.warn(
    `[market] ${chain}/${address}: market cap disagreement ${Math.round(ratio)}× ` +
      `(GT $${Math.round(a).toLocaleString("en-US")} / DS $${Math.round(b).toLocaleString("en-US")}) — ` +
      `using the deeper-liquidity source (${winner === ds ? "DexScreener" : "GeckoTerminal"})`,
  );
  return winner;
}

module.exports = {
  _deepestPool: deepestPool,
  _changeFromPools: changeFromPools,
  _changeFromCandles: changeFromCandles,
  _resetCandleCache: () => _candles.clear(),
  CANDLE_TTL_MS,
  CHANGE_POOL_MIN_SHARE,
  _pickTrusted: pickTrusted,
  SANE_CHANGE_PCT,
  MCAP_DISAGREE_FACTOR, fetchMarket, fetchPrice, fetchTokenDescription };
