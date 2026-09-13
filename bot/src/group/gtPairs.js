// GeckoTerminal client for the group buy bot: one HTTP layer, one rate-limit
// cooldown, one pool cache — shared by the pool resolver below and by the
// per-transaction trades feed in gtTrades.js.
//
// SHARING IS THE POINT. GT's free tier is roughly 30 requests/minute for the
// whole process, and it is counted per IP, not per caller. Two modules with
// their own fetch and their own backoff means one of them keeps hammering
// through a 429 that the other has already noticed — so the cooldown lives
// here, above both, and a 429 from either one silences both. Give gtTrades.js
// its own client and this guarantee is gone.
//
// NEVER match a pool by address across chains — we always query the token on
// its OWN geckoNetwork, so a same-address deploy elsewhere cannot leak in.
// (fourtis published a "+100% pump" for a token that was down 62%, because a
// same-address token on another chain supplied the price.)
const { chainOf, DEXSCREENER_SLUG } = require("../config/chains");
const log = require("../helpers/logger");

// GeckoTerminal's free endpoint, and the Pro one an API key unlocks. The free
// tier is ~30 requests/minute for the WHOLE process, shared with the listing,
// trending and pump pipelines — and a 429 arms a process-wide cooldown during
// which the buy bot cannot read any pool's trades, so every group it serves
// goes quiet at once. That ceiling is the single thing most likely to make a
// busy deployment look broken, and a key is the only real way past it.
//
// Set GECKOTERMINAL_API_KEY to use the Pro base and send the key header.
// Unset — the default — nothing changes.
const GT_KEY = String(process.env.GECKOTERMINAL_API_KEY || "").trim();
const GT = String(process.env.GECKOTERMINAL_API_BASE || "").trim().replace(/\/+$/, "")
  || (GT_KEY ? "https://pro-api.coingecko.com/api/v3/onchain" : "https://api.geckoterminal.com/api/v2");
const HEADERS = GT_KEY
  ? { accept: "application/json;version=20230302", "x-cg-pro-api-key": GT_KEY }
  : { accept: "application/json;version=20230302" };
const TIMEOUT_MS = 8000;

// Chains DexScreener does NOT index — must go through GT (mirror marketdata's
// DS_CHAIN gaps). Kept as a set so the buy-bot never falls back to a source
// that returns nothing for these. Robinhood LEFT this set when DexScreener
// added the chain (~July 2026): keeping it here meant every robinhood pool
// read spent the shared ~30/min GT quota on a number DexScreener now also
// carries — on the chain with the most listings on the box.
const GT_PRIMARY = new Set(["plasma"]);
const isGtPrimary = (chain) => GT_PRIMARY.has(chain);

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

const isHexAddress = (s) => /^0x[0-9a-fA-F]+$/.test(s);

/**
 * An address as it must appear IN A GECKOTERMINAL PATH.
 *
 * Hex is case-insensitive, so folding an EVM address is free. Everything else
 * is not: a Solana pool is base58, where `5P…` and `5p…` are different
 * addresses, and TON/Sui/Tron are the same. Lowercasing one produces a path
 * GeckoTerminal 404s — which the trades feed reads as "unavailable", which used
 * to mean the volume estimator posted instead, and now means the group is
 * simply silent. That is exactly what happened: every Solana group was being
 * served estimates it should never have needed, and the moment the estimator
 * was retired they went quiet while other bots on the same token kept posting.
 *
 * So: fold hex, never anything else. Mirrors tradebot/core.js `_idQ`.
 */
const gtAddr = (a) => (isHexAddress(String(a)) ? String(a).toLowerCase() : String(a));

/**
 * Do two token addresses refer to the same token?
 *
 * Lives here because gtTrades.js imports from this module (not the other way
 * round), and both need it. EVM addresses are hex and case-insensitive — GT
 * mixes checksummed and lowercased forms in one payload, so a bare === misses.
 * Solana mints, Tron and TON addresses are case-SENSITIVE base58/base64, so
 * lowercasing those to compare would be a correctness bug.
 */
function sameToken(a, b) {
  const x = String(a || "").trim();
  const y = String(b || "").trim();
  if (!x || !y) return false;
  if (x === y) return true;
  if (isHexAddress(x) && isHexAddress(y)) return x.toLowerCase() === y.toLowerCase();
  return false;
}

// GT relationship ids are "{network}_{address}".
const relAddress = (rel) => {
  const id = String((rel && rel.data && rel.data.id) || "");
  const i = id.indexOf("_");
  return i === -1 ? "" : id.slice(i + 1);
};

/**
 * The TRACKED token's ticker, from a GT pool.
 *
 * `attributes.name` is "BASE / QUOTE", so which half applies depends on which
 * side our token sits — and getting that backwards labels every buy alert with
 * the counterparty's ticker (WETH, SOL) instead of the customer's.
 */
function symbolFromGtPool(pool, tokenAddress) {
  return sidesOfGtPool(pool, tokenAddress).symbol;
}

/**
 * Both halves of a GT pool, from OUR token's point of view.
 *
 *   symbol / address        the tracked token
 *   counterSymbol/-Address  what it trades against
 *
 * The counterparty matters because a buy alert wants to say "$48.97 (0.6646
 * SOL)" — and the only honest source for that native figure is the amount the
 * trader actually SPENT, which is only a native amount when the other side of
 * the pool IS the native coin.
 */
function sidesOfGtPool(pool, tokenAddress) {
  const a = (pool && pool.attributes) || {};
  const rel = (pool && pool.relationships) || {};
  const parts = String(a.name || "").split("/").map((s) => s.trim());
  const quoteAddr = relAddress(rel.quote_token);
  const baseAddr = relAddress(rel.base_token);
  if (parts.length < 2) return { symbol: "", counterSymbol: "", address: "", counterAddress: "" };
  const tokenIsQuote = sameToken(quoteAddr, tokenAddress);
  return {
    symbol: (tokenIsQuote ? parts[1] : parts[0]) || "",
    counterSymbol: (tokenIsQuote ? parts[0] : parts[1]) || "",
    address: tokenIsQuote ? quoteAddr : baseAddr,
    counterAddress: tokenIsQuote ? baseAddr : quoteAddr,
  };
}

/**
 * The token's NAME ("The Nietzschean Dog"), which the pool listing does not
 * carry — its `name` is the PAIR ("HOPPY / WETH"). Called once at /settoken and
 * on self-heal, never per poll.
 */
async function fetchTokenInfo(chain, address) {
  const net = networkOf(chain);
  if (net) {
    const res = await gtGet(`/networks/${net}/tokens/${address}`);
    const a = res && res.ok && res.body && res.body.data && res.body.data.attributes;
    if (a && (a.name || a.symbol)) return { name: String(a.name || ""), symbol: String(a.symbol || "") };
  }
  if (!isGtPrimary(chain)) {
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (r.ok) {
        const j = await r.json();
        const p = (j.pairs || []).find((x) => x && (sameToken(x.baseToken?.address, address) || sameToken(x.quoteToken?.address, address)));
        const t = p && (sameToken(p.baseToken?.address, address) ? p.baseToken : p.quoteToken);
        if (t) return { name: String(t.name || ""), symbol: String(t.symbol || "") };
      }
    } catch {
      /* best effort — the alert falls back to the ticker */
    }
  }
  return null;
}

// ── One rate limiter for every GeckoTerminal request in this process ─────────
//
// The free tier is ~30 requests/minute for the whole IP, and the bot used to
// discover that ceiling the only way it could: by being punished. A 429 arms a
// 120-SECOND PROCESS-WIDE cooldown, during which no group gets a buy alert at
// all. So the cost of one request too many was two minutes of silence for
// everybody, and the cost of DELAYING that request by two seconds is nothing
// anyone notices. Pacing is strictly better than backing off.
//
// PRIORITY matters as much as the pacing. Nine background pipelines — pump,
// rank-up, auto-trend, gainers, trending poster, fulfilment — price tokens on
// timers, and marketdata.js used to reach GeckoTerminal through its OWN fetch,
// so those requests were invisible to the cooldown AND to any budget. The
// realtime path was being starved by jobs that did not know there was a budget
// to starve it out of. The buy bot's trades feed now goes first, always.
/**
 * GeckoTerminal's free ceiling, in requests a minute, counted PER IP.
 *
 * ⚠️ THIS WAS 30, AND 30 WAS A GUESS WE HAD BEEN BUDGETING AGAINST FOR MONTHS.
 * GeckoTerminal's own API page (geckoterminal.com/dex-api) states the free
 * figure while advertising the paid one: "increase rate limits by 25X, from
 * 10 calls/min to 250 calls/min". Ten, not thirty.
 *
 * Which means the split was never a split: half of an imagined 30 is 15, the
 * website takes another 15, and the two processes together were asking for
 * THREE TIMES what the IP is allowed. That is not a busy minute occasionally
 * going over — it is a guaranteed 429, continuously, which is exactly what the
 * token page kept reporting ("GeckoTerminal is rate limited — cooling down").
 * We were not losing a race for the quota. We were the ones exceeding it.
 *
 * Being throttled by our OWN budget and being 429'd by theirs are not
 * comparable failures: our budget PACES a request (it waits for a slot), while
 * their 429 arms a 120s process-wide cooldown that blanks every chart on the
 * site. Half the throughput, gracefully, beats three times the throughput into
 * a wall.
 *
 * Env-overridable because a tier is a fact about the account, not about this
 * code: an operator whose plan really is 30/min raises it in one line, and a
 * key raises the real limit far past either figure.
 */
const GT_FREE_CEILING_RPM = (() => {
  const n = Number(String(process.env.GT_FREE_CEILING_RPM || "").trim());
  return Number.isFinite(n) && n > 0 ? n : 10;
})();

/**
 * The default budget when nothing is pinned.
 *
 * ⚠️ IT IS A SPLIT, NOT A SOLO CEILING. It used to be 25 — "comfortably under
 * the free ceiling" — and that was true while this process was the only thing
 * on the box. It is not any more: the website (dexvra.io) runs on the same IP,
 * and its candlestick charts have exactly ONE free source of OHLCV, which is
 * this one. At 25 the bot could take the whole ceiling by itself, and did: the
 * site answered `Couldn't read the chart just now (GeckoTerminal 429)` while a
 * bare `curl` to GeckoTerminal from the same box answered 429 too. Nothing was
 * wrong with the chart.
 *
 * So the keyless default leaves the other half of the IP's allowance alone.
 * Pure and exported because the split is a number to be tested, not a comment
 * to be believed — and because a test cannot read the default at all once the
 * runner has pinned `GT_MAX_RPM` in the environment.
 *
 * A key raises the real limit far past either figure.
 */
const defaultRpm = (hasKey) => (hasKey ? 300 : Math.floor(GT_FREE_CEILING_RPM / 2));

const GT_RPM = (() => {
  const n = Number(String(process.env.GT_MAX_RPM || "").trim());
  if (Number.isFinite(n) && n > 0) return n;
  return defaultRpm(!!GT_KEY);
})();
const GT_MIN_GAP_MS = Math.ceil(60000 / GT_RPM);
// Past this the request is refused rather than queued. An unbounded queue turns
// a rate limit into a memory leak, and a buy alert that arrives ten minutes
// late is not a buy alert.
const GT_QUEUE_MAX = 200;

const PRIO_REALTIME = 0; // the buy bot's trades feed
const PRIO_BACKGROUND = 1; // everything on a timer

const gtQueue = [[], []];
let gtNextFreeAt = 0;
let gtTimer = null;

function gtDrain() {
  if (gtTimer) return;
  const next = gtQueue[PRIO_REALTIME].length ? PRIO_REALTIME : PRIO_BACKGROUND;
  if (!gtQueue[next].length) return;
  const wait = Math.max(0, gtNextFreeAt - Date.now());
  gtTimer = setTimeout(() => {
    gtTimer = null;
    // Re-pick the tier AFTER waiting: a realtime request that arrived during the
    // gap must not sit behind the background one that was queued first.
    const tier = gtQueue[PRIO_REALTIME].length ? PRIO_REALTIME : PRIO_BACKGROUND;
    const release = gtQueue[tier].shift();
    if (release) {
      gtNextFreeAt = Date.now() + GT_MIN_GAP_MS;
      release();
    }
    gtDrain();
  }, wait);
  // NOT unref'd. A queued request is WORK: an unref'd timer does not hold the
  // event loop open, so a short-lived process — every scripts/*-check.js, and
  // any test — would exit with the promise still pending and the caller hanging
  // forever. The timer only exists while somebody is waiting, and never lasts
  // longer than one gap, so refing it cannot keep the process alive by itself.
}

/** Wait for this process's turn to call GeckoTerminal. Rejects when the queue
 *  is saturated, which the caller must treat as "unavailable" — the same as any
 *  other failed read. */
function gtSlot(priority = PRIO_BACKGROUND) {
  const p = priority === PRIO_REALTIME ? PRIO_REALTIME : PRIO_BACKGROUND;
  if (gtQueue[0].length + gtQueue[1].length >= GT_QUEUE_MAX) {
    return Promise.reject(new Error("GeckoTerminal request queue is full"));
  }
  return new Promise((resolve) => {
    gtQueue[p].push(resolve);
    gtDrain();
  });
}

/** Queue depth, for the diagnostics scripts. */
const gtPressure = () => ({ realtime: gtQueue[0].length, background: gtQueue[1].length, rpm: GT_RPM });

/**
 * The line an operator greps to answer "which GeckoTerminal tier and what
 * budget is this process on?" — printed at boot, next to the build sha, for
 * exactly the reason that one is: from outside, a quiet buy bot and an empty
 * chart look identical whether the ceiling is 30 requests a minute shared with
 * the website or the Pro tier's.
 *
 * The web app prints its own `[gt]` line for the same question. Two processes,
 * one IP, one allowance — and the two lines together are the only way to see
 * how it is being split.
 *
 * The KEY is never printed. It would land in pm2's log.
 */
function gtBanner() {
  log.info(
    `[gt] ${
      GT_KEY
        ? "API key set"
        : `PUBLIC free tier (~${GT_FREE_CEILING_RPM} req/min per IP, shared with the website on this box)`
    } · budget ${GT_RPM}/min${process.env.GT_MAX_RPM ? " (GT_MAX_RPM)" : ""}`,
  );
}

// ── Shared rate-limit cooldown ───────────────────────────────────────────────
// Armed by a 429 (or a 5xx run) and honoured by EVERY caller. While it is armed
// gtGet returns `{ ok: false }` without making a request — which the trades feed
// reads as "unavailable" and degrades on, rather than as "no buys".
const COOLDOWN_MS = 120 * 1000;
let cooldownUntil = 0;

const inCooldown = (at = Date.now()) => at < cooldownUntil;
/** How much of the cooldown is left, in ms (0 when it is not armed).
 *
 *  A caller that CAN wait needs the number, not the boolean. The buy monitor
 *  cannot — a buy alert two minutes late is not a buy alert — but a bulk
 *  one-off like `seed:chain` has nothing to lose by sleeping, and without this
 *  it reported "could not read the market" for every chain after the first,
 *  which reads as a dead chain rather than as our own quota. */
const cooldownRemaining = (at = Date.now()) => Math.max(0, cooldownUntil - at);

function armCooldown(why, at = Date.now()) {
  if (inCooldown(at)) return;
  cooldownUntil = at + COOLDOWN_MS;
  // noise, not warn: the bot handles this by itself (pauses, then recovers),
  // and under a sustained limit the same message re-armed every couple of
  // minutes and drowned the ops channel — the operator asked for it gone.
  // pm2 logs keep every line, with the GECKOTERMINAL_API_KEY hint; set
  // OPS_VERBOSE=1 to put it back in the channel while chasing something.
  log.noise(
    `[buybot] GeckoTerminal backing off for ${COOLDOWN_MS / 1000}s — ${why}. ` +
      (GT_KEY
        ? "Buy alerts are paused process-wide until it lifts."
        : "Buy alerts are paused process-wide until it lifts; set GECKOTERMINAL_API_KEY to raise the limit."),
  );
}

/**
 * One GET against GT. Never throws.
 * Returns { ok:true, status, body } or { ok:false, status, reason }.
 *
 * `ok:false` deliberately covers everything from a dead socket to a 404: the
 * only thing a caller can do with any of them is stop trusting the answer, and
 * collapsing them here keeps that decision in one place.
 */
async function gtGet(path, params, priority = PRIO_BACKGROUND) {
  if (inCooldown()) return { ok: false, status: 0, reason: "cooldown" };
  const qs = new URLSearchParams(params || {}).toString();
  const url = `${GT}${path}${qs ? `?${qs}` : ""}`;
  // Wait for a slot BEFORE checking the clock again: a request that queued for
  // a while may have been overtaken by a 429 armed by whatever went out ahead
  // of it, and firing it anyway is how a cooldown gets extended.
  try {
    await gtSlot(priority);
  } catch (e) {
    return { ok: false, status: 0, reason: (e && e.message) || "queue full" };
  }
  if (inCooldown()) return { ok: false, status: 0, reason: "cooldown" };
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 429) {
      armCooldown("HTTP 429 (rate limited)");
      return { ok: false, status: 429, reason: "rate limited" };
    }
    // A 5xx does NOT arm the cooldown. It is a per-request failure and says
    // nothing about our quota, whereas the cooldown is process-wide: arming it
    // here would let one bad moment on one pool stop every group's buy bot for
    // two minutes — and, because an unreadable feed degrades to the volume
    // estimator, replace real alerts with estimates while it did. 429 is the
    // only status that genuinely means "all of you, stop".
    if (res.status >= 500) return { ok: false, status: res.status, reason: "server error" };
    if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    return { ok: true, status: res.status, body: await res.json() };
  } catch (e) {
    // A timeout is not a rate limit — do NOT arm the shared cooldown for it, or
    // one slow pool takes every group's buy bot offline for two minutes.
    return { ok: false, status: 0, reason: (e && e.message) || "request failed" };
  }
}

const networkOf = (chain) => (chainOf(chain) && chainOf(chain).geckoNetwork) || null;

/**
 * Resolve the token's deepest pool on its chain into a snapshot:
 *   { poolAddress, priceUsd, mcap, volume24h, liquidity, buys24h, sells24h }
 * Returns null when neither GT nor DexScreener has the token.
 *
 * ⚠️ DEXSCREENER FIRST WHERE IT INDEXES THE CHAIN, and the reason is the same
 * one the file header gives for sharing a cooldown, one step further out: the
 * ~30-requests-a-minute free ceiling is counted PER IP, and the website on this
 * same box draws candlestick charts whose ONLY free source of OHLCV is
 * GeckoTerminal. Price, market cap, liquidity and the pool's two sides all have
 * a second source that costs us none of that budget — so spending a GT request
 * on them is spending the one thing the charts cannot get anywhere else.
 *
 * The buy bot no longer needs GT for DETECTION either (chainTrades reads the
 * pool's own Swap events), so what is left here is decoration on an alert. GT
 * remains first — in fact the only source — for the GT-primary chains, and the
 * fallback everywhere else, so nothing loses an answer it used to have.
 */
async function fetchPool(chain, address) {
  const ds = isGtPrimary(chain) ? null : await fetchDsPool(chain, address).catch(() => null);
  if (ds && ds.priceUsd > 0) return ds;
  const net = networkOf(chain);
  if (net) {
    const gt = await fetchGtPool(net, address).catch(() => null);
    if (gt) return gt;
  }
  // A DexScreener pair with no usable price still beats nothing: it carries the
  // pool address, the ticker and the counter side, which is what a self-heal is
  // after. Returning null here would send the caller back to GT next poll for
  // an answer we already have.
  return ds;
}

// ── Pool metadata cache ──────────────────────────────────────────────────────
// Price / mcap / liquidity only decorate an alert; they are not what detects
// one. With the trades feed as the detector, an idle pool must cost exactly ONE
// request per poll (the trades call) — so metadata is fetched only when a buy
// actually needs rendering, and then reused for a minute.
const META_TTL_MS = 60 * 1000;
const metaCache = new Map(); // `${chain}/${address}` → { at, pool }

async function fetchPoolCached(chain, address, at = Date.now()) {
  const k = `${chain}/${address}`;
  const hit = metaCache.get(k);
  if (hit && at - hit.at < META_TTL_MS) return hit.pool;
  const pool = await fetchPool(chain, address).catch(() => null);
  // Only a SUCCESSFUL lookup is cached. Caching a miss would hold a whole
  // minute of alerts at "price —" because one request happened to time out.
  if (pool) metaCache.set(k, { at, pool });
  return pool || (hit ? hit.pool : null);
}

async function fetchGtPool(net, address) {
  const res = await gtGet(`/networks/${net}/tokens/${address}/pools`, { page: 1 });
  if (!res.ok) return null;
  const pools = (res.body && res.body.data) || [];
  if (!pools.length) return null;
  // deepest-liquidity pool wins
  pools.sort((a, b) => (num(b.attributes?.reserve_in_usd) || 0) - (num(a.attributes?.reserve_in_usd) || 0));
  const a = pools[0].attributes || {};
  const tx = (a.transactions && a.transactions.h24) || {};
  const sides = sidesOfGtPool(pools[0], address);
  return {
    poolAddress: a.address || null,
    symbol: sides.symbol,
    counterSymbol: sides.counterSymbol,
    counterAddress: sides.counterAddress,
    priceUsd: num(a.base_token_price_usd) ?? num(a.token_price_usd),
    mcap: num(a.market_cap_usd) ?? num(a.fdv_usd),
    volume24h: (a.volume_usd && num(a.volume_usd.h24)) || 0,
    liquidity: num(a.reserve_in_usd) || 0,
    buys24h: num(tx.buys) || 0,
    sells24h: num(tx.sells) || 0,
    change24h: num(a.price_change_percentage && a.price_change_percentage.h24),
    source: "gt",
  };
}

// ⚠️ ONE OWNER FOR THE DEXSCREENER CHAIN MAP, and this is the THIRD module to
// have needed that fix. `config/chains.js` DEXSCREENER_SLUG is the map; this
// file carried a private seven-entry copy of it, and the copy had **no
// robinhood** — so fetchDsPool("robinhood", …) returned null WITHOUT MAKING A
// REQUEST, and DexScreener was never asked about the chain with the most
// listings on this box. GT was then the only source left, and GT queues.
//
// It is the identical defect this repo already recorded for the auto-lister
// ("TWO OWNERS FOR THE DEXSCREENER SLUG, disagreeing about one chain" — sei
// answered 'no market data' for every token), fixed in `dexscreener.js` and
// left standing here. A lesson applied to one of two modules.
//
// Reading the real map also picks up the July 2026 Robinhood flip and the
// fifteen chains this copy never had — and the slug is not always the chain
// key (`sei` → `seiv2`), which is exactly what a hand-written copy gets wrong.
const dsSlug = (chain) => DEXSCREENER_SLUG[String(chain || "").toLowerCase()] || null;

// DexScreener's chainId → our chain key. Built from the one map rather than
// typed out, so it can never disagree with the forward direction.
const DS_KEY = new Map(Object.entries(DEXSCREENER_SLUG).map(([k, slug]) => [slug, k]));

// One DexScreener request for a token, whatever chain it is on.
//
// ⚠️ `latest/dex/tokens/{address}` ANSWERS FOR EVERY CHAIN AT ONCE, and this
// file used to throw away all but one of them — so resolving a pasted contract
// made FIVE identical requests to this same URL and discarded four fifths of
// each answer, then fell through to the GeckoTerminal queue for the chains the
// private map above did not have. The answer was in the first response.
const dsFetch = async (address) => {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  const j = await res.json();
  return Array.isArray(j && j.pairs) ? j.pairs : [];
};

// The deepest pair wins. A token seen through a thin pool reads as a different
// asset — the rule `deepestPool` and `topPoolAddress` already state.
const byDepth = (a, b) => (num(b.liquidity?.usd) || 0) - (num(a.liquidity?.usd) || 0);

/**
 * Which of `chains` does DexScreener actually have this token on, and on which
 * is its pool deepest? ONE request, no GeckoTerminal, no queue.
 *
 * ⚠️ CHOSEN BY DEPTH, NEVER BY THE ORDER OF THE CANDIDATE LIST. `0x…` resolves
 * to five candidates with ethereum first and robinhood FOURTH, so a positional
 * pick answers "ethereum" for every EVM token that has so much as a dust pair
 * there — which decides, on the Mass DM flow, what currency the buyer is
 * charged.
 */
async function dsResolveAcross(address, chains) {
  const want = new Map();
  for (const c of chains || []) {
    const slug = dsSlug(c);
    if (slug) want.set(slug, c);
  }
  if (!want.size) return null;
  const pairs = await dsFetch(address).catch(() => null);
  if (!pairs || !pairs.length) return null;
  const mine = pairs.filter((p) => p && want.has(p.chainId));
  if (!mine.length) return null;
  mine.sort(byDepth);
  const best = mine[0];
  return { chain: want.get(best.chainId), pool: dsPoolOf(best, address) };
}

function dsPoolOf(p, address) {
  const tx = (p.txns && p.txns.h24) || {};
  const quoteSide = sameToken(p.quoteToken && p.quoteToken.address, address);
  const ours = (quoteSide ? p.quoteToken : p.baseToken) || {};
  const other = (quoteSide ? p.baseToken : p.quoteToken) || {};
  return {
    poolAddress: p.pairAddress || null,
    symbol: ours.symbol || "",
    name: ours.name || "",
    counterSymbol: other.symbol || "",
    counterAddress: other.address || "",
    priceUsd: num(p.priceUsd),
    mcap: num(p.marketCap) ?? num(p.fdv),
    volume24h: (p.volume && num(p.volume.h24)) || 0,
    liquidity: num(p.liquidity?.usd) || 0,
    buys24h: num(tx.buys) || 0,
    sells24h: num(tx.sells) || 0,
    change24h: num(p.priceChange && p.priceChange.h24),
    source: "ds",
  };
}

async function fetchDsPool(chain, address) {
  const dsChain = dsSlug(chain);
  if (!dsChain) return null;
  const pairs = await dsFetch(address);
  if (!pairs) return null;
  const mine = pairs.filter((p) => p && p.chainId === dsChain);
  if (!mine.length) return null;
  mine.sort(byDepth);
  return dsPoolOf(mine[0], address);
}

/** Test seam — clear the shared cooldown and the metadata cache. */
function _reset() {
  cooldownUntil = 0;
  metaCache.clear();
}

module.exports = {
  GT_BASE: GT,
  gtSlot,
  gtPressure,
  gtBanner,
  PRIO_REALTIME,
  PRIO_BACKGROUND,
  gtAddr,
  isHexAddress,
  defaultRpm,
  GT_FREE_CEILING_RPM,
  hasApiKey: () => !!GT_KEY,
  fetchPool,
  dsResolveAcross,
  fetchPoolCached,
  isGtPrimary,
  gtGet,
  sameToken,
  symbolFromGtPool,
  sidesOfGtPool,
  fetchTokenInfo,
  networkOf,
  inCooldown,
  cooldownRemaining,
  armCooldown,
  _reset,
  GT,
  COOLDOWN_MS,
  META_TTL_MS,
};
