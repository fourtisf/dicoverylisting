'use strict';
/*
 * THE ONE OWNER of "can this launchpad curve be traded, and with what call?"
 *
 * `curveIface` reads a curve's call shape off real trades. `curveRoute` turns
 * that into OUR calldata and refuses anything it cannot explain. This ties the
 * two together, holds the cache, and runs the gates — so `core.buy` and
 * `core.sell` ask ONE question and get one answer, rather than growing two
 * private ideas of when a discovered route may be signed. Three callers were
 * about to; `canTradeNow` exists for exactly that reason, one question over.
 *
 * WHERE IT SITS. A token on a bonding curve has no AMM pool, so `bestDexVenue`
 * finds nothing and the buy path ends at:
 *
 *     "this token's liquidity is on <venue>, which Dexvra can't route through
 *      yet — no swap to sign"
 *
 * That sentence is true only while nobody has read the curve's interface. This
 * is what reads it.
 *
 * ⚠️ EVERY REFUSAL HERE IS A REFUSAL TO SIGN, NOT A VERDICT ON THE TOKEN. The
 * caller must be able to tell "we cannot build this safely" from "this token
 * cannot be traded", because the first is ours and the second is not ours to
 * assert. `why` says which, always.
 */
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { decodeCurveIface, describeIface, TRANSFER_TOPIC, classifySlots } = require('./curveIface.js');
const { buildCurveCall, buildFromShape, simulate, sane, _big: big } = require('./curveRoute.js');

/*
 * ── THE LEARNED-SHAPE REGISTRY ──────────────────────────────────────────────
 *
 * A launchpad deploys the SAME curve for every token it launches, and the
 * observed route needs two trades on the token itself — so the FIRST buyer of
 * a fresh launch could never buy, which is the whole point of a launch snipe:
 * "ini token kan belum bonding", a fresh Pons launch at 0% with one dust buy,
 * refused for ever by a route that only reads history.
 *
 * So every successful discovery RECORDS the pad's buy shape, keyed by the
 * keccak of the curve's deployed BYTECODE — and a fresh token whose curve
 * carries byte-identical code (immutables live in the code, so identity means
 * identity) gets the shape transferred. What keeps that from being a guess is
 * in buildFromShape's header: code identity carries the meaning, simulate
 * answers the storage question, and OUR strong-price floor rides on-chain.
 *
 * Persisted to DATA_DIR/curveShapes.json so one traded sibling — ever —
 * teaches every later launch on that pad, across restarts. Best-effort: a
 * box that cannot write still learns for the life of the process.
 */
const SHAPES_FILE = () => path.join(process.env.DATA_DIR || '.', 'curveShapes.json');
let _shapes = null;   // `${chainKey}:${keccak(code)}` → { curve, token, at, buy: {selector, native, slots} }
function _loadShapes() {
  if (_shapes) return _shapes;
  _shapes = {};
  try {
    const j = JSON.parse(fs.readFileSync(SHAPES_FILE(), 'utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) _shapes = j;
  } catch (_) { /* first run, or unreadable — in-memory only */ }
  return _shapes;
}
function _saveShapes() { try { fs.writeFileSync(SHAPES_FILE(), JSON.stringify(_shapes)); } catch (_) {} }

/** A leg reduced to what a transfer may carry: selector + per-slot roles.
 *  null when the leg is not cleanly explainable — an unexplained slot must not
 *  cross tokens, and neither may a quote-token or over-wide call. BigInts
 *  (ratioE18) are deliberately dropped: they are the SIBLING's price. */
function _legShape(leg, token) {
  if (!leg || leg.wide || !leg.native || leg.quote) return null;
  const cls = classifySlots(leg, token);
  if (!cls.ok) return null;
  const slots = [];
  for (const s of cls.slots) {
    if (s.role === 'token' || s.role === 'sender') slots.push({ i: s.i, role: s.role });
    else if (s.role === 'scales') slots.push({ i: s.i, role: 'scales' });
    else if (s.role === 'constant') slots.push({ i: s.i, role: 'constant', value: s.value });
    else return null;
  }
  /*
   * ⚠️ EXACTLY ONE AMOUNT-TRACKING SLOT, OR THIS TEACHES NOTHING.
   *
   * Two SAME-SIZED buys classify cleanly — and wrongly: with no variation to
   * correlate against, a real minimum-out reads as a `constant`, so the shape
   * comes out with no minimum-out at all. `buildFromShape` refuses such a shape
   * (gas alone is no gate), but recording it is worse than useless: it is
   * keyed on the pad's BYTECODE, so a degenerate reading from one thin token
   * would overwrite the good shape a properly-traded sibling taught, for every
   * token on that pad.
   */
  if (slots.filter((s) => s.role === 'scales').length !== 1) return null;
  return { selector: leg.selector, native: true, slots };
}

async function _recordShape(chain, chainKey, token, iface) {
  try {
    if (!iface || !iface.ok || iface.transferred || !iface.curve) return;
    if (typeof chain.getCode !== 'function') return;
    const shape = _legShape(iface.buy, token);
    if (!shape) return;
    const code = await chain.getCode(iface.curve);
    if (!code || code === '0x') return;
    const reg = _loadShapes();
    reg[`${chainKey}:${ethers.keccak256(code)}`] = { curve: iface.curve, token: String(token).toLowerCase(), at: Date.now(), buy: shape };
    _saveShapes();
  } catch (_) { /* learning is free — failing to learn must cost nothing */ }
}

/** The learned shape whose curve bytecode matches `pool`'s, or null. The
 *  getCode comparison IS the safety argument — see the registry header. */
async function _shapeFor(chain, chainKey, pool) {
  try {
    if (typeof chain.getCode !== 'function' || !/^0x[a-fA-F0-9]{40}$/.test(String(pool || ''))) return null;
    const code = await chain.getCode(pool);
    if (!code || code === '0x') return null;
    const hit = _loadShapes()[`${chainKey}:${ethers.keccak256(code)}`];
    return hit && hit.buy ? hit : null;
  } catch (_) { return null; }
}

/** Test seam: forget every learned shape (memory AND file). */
function _resetShapes() { _shapes = {}; _saveShapes(); }

/*
 * ⚠️ THE INDEXER'S TRADE LIST SEEDS DISCOVERY, because the window ladder can
 * be structurally blind on the box this feature is for.
 *
 * Robinhood's public RPC silently caps wide `eth_getLogs` — a 50,000-block ask
 * answered [] over real trades, which is what forced the stepped walk — and
 * the wider windows' steps grow with the span (400,000/24 ≈ 16,667 blocks), so
 * past some age the walk cannot see a trade AT ALL: every range big enough to
 * reach it within the budget is silently emptied. A curve token whose last
 * trade is half a day old therefore read "no trades found" for ever, and its
 * card said "can't route through yet" over a token DexScreener was pricing on
 * the same render.
 *
 * The indexer that prices it also PUBLISHES its trades' transaction hashes.
 * They are used as POINTERS ONLY: everything decoded still comes from the
 * chain's own receipts and transactions — the same trust base as getLogs — so
 * a wrong or fabricated hash yields no receipt or no Transfer of OUR token and
 * contributes nothing. Every gate downstream (classification, sane(),
 * simulate) is unchanged. An indexer that is down costs the seed and nothing
 * else: the ladder still runs.
 */
const SEED_MAX_TX = 12;

/** This token's trade Transfers, read off the RECEIPTS of the given hashes.
 *  Oldest-first, the order the walk produces. Per-receipt failures are
 *  skipped — a pointer that resolves to nothing contributes nothing. */
async function _receiptLogs(chain, token, hashes) {
  if (typeof chain.getTransactionReceipt !== 'function') return [];
  const lcTok = String(token).toLowerCase();
  // Newest-first from the indexer; decode expects oldest-first input.
  const want = hashes.slice(0, SEED_MAX_TX).reverse();
  // ⚠️ TOGETHER, not one per loop turn — a dozen receipts read serially is a
  // dozen round trips on the card's critical path, and they do not depend on
  // each other. The same shape `decodeCurveIface` carries for its transactions.
  const rcpts = await Promise.all(want.map((h) => chain.getTransactionReceipt(h).catch(() => null)));
  const out = [];
  want.forEach((h, i) => {
    for (const lg of (rcpts[i] && rcpts[i].logs) || []) {
      if (!lg || String(lg.address || '').toLowerCase() !== lcTok) continue;
      if (!lg.topics || lg.topics[0] !== TRANSFER_TOPIC) continue;
      out.push({ transactionHash: h, topics: lg.topics, data: lg.data, blockNumber: lg.blockNumber });
    }
  });
  return out;
}

/** Interfaces are per (chain, token) and change only when a pad redeploys, so
 *  they are worth holding — a rediscovery is a dozen RPC reads. A MISS is held
 *  far more briefly: it usually means "not enough trades yet", which the next
 *  trade fixes, and caching that for an hour would make the pad look dead. */
const OK_TTL_MS = 30 * 60_000;
const MISS_TTL_MS = 90_000;
const _cache = new Map();
const key = (chainKey, ca) => `${chainKey}:${String(ca).toLowerCase()}`;

/**
 * ⚠️ `ok: true` MEANS "WE READ A TRADE", NOT "WE CAN BUILD A CALL" — and the gap
 * between those two was taking the THIRTY-MINUTE cache.
 *
 * `curveIface` sets `ok` from having decoded a buy or a sell leg, but
 * `classifySlots` refuses to assign meaning to an argument until it has seen
 * `minSamples` (2) of the same call shape. So a curve with exactly ONE observed
 * trade is `ok` and unbuildable at the same time — and it was remembered for
 * half an hour, while the short TTL beside it says in its own words that it
 * exists for "not enough trades yet, which the next trade fixes".
 *
 * That is precisely the state of the token this feature is for: the reported
 * $CD was at 0.05% of its curve. One more trade on the pad makes it buyable,
 * and the user had to wait out a thirty-minute cache to find out — on a card
 * that now consults this cache directly.
 */
function _ttlFor(res) {
  if (!res || !res.ok) return MISS_TTL_MS;
  const seen = Math.max(Number((res.buy && res.buy.seen) || 0), Number((res.sell && res.sell.seen) || 0));
  return seen >= 2 ? OK_TTL_MS : MISS_TTL_MS;
}

function _cached(chainKey, ca) {
  const hit = _cache.get(key(chainKey, ca));
  if (!hit) return null;
  if (Date.now() - hit.ts > _ttlFor(hit.res)) { _cache.delete(key(chainKey, ca)); return null; }
  return hit.res;
}

/** Test seam — the cache is process-wide by design. */
function _reset() { _cache.clear(); _inflight.clear(); }

/** The cached interface for a token, or null. Read-only, no network.
 *
 *  `canTradeNow` needs this: it is polled on a timer by the CA snipe and the
 *  launch retry ring, so it may not pay a dozen RPC reads per probe. A cached
 *  yes is a cheap yes; the absence of one is not a no, which is why the caller
 *  must not turn a miss into "this token cannot be traded". */
function cached(chainKey, ca) { return _cached(chainKey, ca); }

/** Forget a token's interface.
 *
 *  ⚠️ A CURVE THAT REJECTS OUR CALL MAY HAVE BEEN REDEPLOYED, and the cache
 *  holds its OLD address for half an hour. Without this, every buy in that
 *  window aims at an abandoned contract, is refused with "the curve rejected
 *  this call", and there is no path back except waiting — a stuck state that
 *  looks exactly like a broken feature. Re-discovery costs a dozen reads; being
 *  stuck costs the token. */
function forget(chainKey, ca) {
  _cache.delete(key(chainKey, ca));
  // …and any discovery still in flight for it, or a redeployed curve keeps
  // being answered by the walk already running against its old address.
  for (const k of [..._inflight.keys()]) if (k.startsWith(key(chainKey, ca) + '|')) _inflight.delete(k);
}

/**
 * The curve interface for a token, discovered once and remembered.
 *
 * `chain` needs `getLogs`, `getTransaction` and `getBlockNumber`. Injected, so
 * this is provable without a node — the only way it CAN be proved from a
 * sandbox with no egress, which is where every line of it was written.
 */
/*
 * ⚠️ THE WINDOW IS ESCALATED, because "any launchpad" means any PACE.
 *
 * The decoder's default window is 5000 blocks — under three hours on a
 * two-second chain. A pad whose tokens trade a few times a day reads as "no
 * trades found" there, which is a statement about the WINDOW being reported as
 * a fact about the token, and it is what would have made this feature look
 * Pons-shaped: fine on a busy launch, blind on a quiet one.
 *
 * Widening the first look instead would make every lookup pay for the slowest
 * pad, on a call that sits inside the wallet lock. So: start cheap, and widen
 * only when the cheap look found NOTHING — which is the one answer a wider
 * window can change. A transport failure never escalates: asking a dead node
 * three times is three times the wait for the same silence.
 */
/*
 * ⚠️ NO SINGLE STAGE MAY CONSUME THE WHOLE BUDGET.
 *
 * `core._curveIface` races this against CURVE_DISCOVER_MS (12s) and renders the
 * loser to the user as "reading this curve's interface took longer than 12s".
 * The whole-chain look below has NO timeout of its own — ethers' default is
 * 300s — so on a node that is merely SLOW to answer `fromBlock: 0` (Robinhood's
 * public RPC over ~49M blocks) that one request ate the entire budget and
 * NOTHING underneath it ever ran: not the ladder, not the seed, not the learned
 * shape. The fix for the 12s refusal reproduced the 12s refusal, from a
 * different cause, which is exactly why it read as unchanged.
 *
 * A stage that overruns its slice is INCONCLUSIVE, never a verdict — the same
 * fail-safe direction the wide look's empty answer already takes.
 */
const STAGE_MS = Math.max(500, Number(process.env.CURVE_STAGE_MS || 4000));

/** Resolve to `null` if `p` has not settled in `ms`. The loser is left running
 *  into nothing; its rejection is handled here, because an unhandled one ends
 *  the process on Node 18. */
function _within(p, ms) {
  let t;
  const guard = new Promise((res) => { t = setTimeout(() => res(null), ms); });
  return Promise.race([Promise.resolve(p).then((v) => v, () => null), guard])
    .finally(() => clearTimeout(t));
}

const WINDOWS = (() => {
  const raw = String(process.env.CURVE_WINDOWS || '5000,60000,400000').split(',');
  const out = raw.map((x) => Math.floor(Number(String(x).trim()))).filter((n) => Number.isFinite(n) && n >= 100);
  return out.length ? out : [5000, 60000, 400000];
})();

/**
 * TEACH THIS PAD FROM ONE OF ITS OTHER TOKENS, and report whether any of
 * `pools` now matches.
 *
 * ⚠️ A sibling only ever teaches after its curve's BYTECODE matches (inside
 * `_shapeFor`), so a wrong list, a different pad or a hostile answer teaches
 * nothing at all. Bounded: the first sibling with a readable history wins, and
 * `learning` stops the recursion at depth 1.
 */
async function _teachFromSiblings(chain, chainKey, opts, pools) {
  const sibs = await opts.siblings().catch(() => []);
  for (const s of (Array.isArray(sibs) ? sibs : [])) {
    if (!s || !s.token) continue;
    const r = await ifaceFor(chain, chainKey, s.token, {
      learning: true,
      // A chain-found sibling arrives WITH its trade hashes (they are how its
      // token was identified at all), so the decode costs receipts only. An
      // indexer-found one is looked up the ordinary way.
      tradeHashes: Array.isArray(s.hashes) && s.hashes.length
        ? async () => s.hashes
        : (typeof opts.siblingHashes === 'function' ? () => opts.siblingHashes(s.token) : undefined),
    }).catch(() => null);
    if (!r || !r.ok || r.transferred) continue;
    for (const p of (pools || [])) {
      const h = await _shapeFor(chain, chainKey, p);
      if (h) return { pool: p, hit: h };
    }
  }
  return null;
}

/**
 * ⚠️ THE CACHE HOLDS RESULTS, NOT PROMISES — so N callers were N discoveries.
 *
 * Nothing is written until a discovery FINISHES, so a second caller arriving
 * while the first is still walking sees an empty cache and starts its own. The
 * card consults this on every render of an indexed curve token, so it stops
 * being "a user tapped twice" and becomes "everyone who pasted this CA" —
 * concurrent bursts of round trips against a chain deliberately exempt from
 * JSON-RPC batching, each making the other slower.
 *
 * ⚠️ THE KEY CARRIES THE CAPABILITY SET, not just the token. A call that can
 * seed from the indexer's trade list or teach from a sibling can succeed where
 * a bare one fails, so handing a seeded caller the seedless answer would lose
 * exactly the seed that was added to fix a quiet token. A pinned window and a
 * `learning` recursion are different questions again and are never coalesced.
 */
const _inflight = new Map();

function ifaceFor(chain, chainKey, ca, opts = {}) {
  const hit = _cached(chainKey, ca);
  if (hit) return Promise.resolve(hit);
  if (opts.blocks || opts.learning) return _discover(chain, chainKey, ca, opts);
  const k = key(chainKey, ca) + '|' + (typeof opts.tradeHashes === 'function' ? 't' : '') + (typeof opts.siblings === 'function' ? 's' : '');
  const live = _inflight.get(k);
  if (live) return live;
  // ⚠️ Only retire THIS promise: `forget()` can drop the entry mid-flight and a
  // later caller can install a fresh one under the same key, and an
  // unconditional delete would retire that newer discovery instead.
  const p = _discover(chain, chainKey, ca, opts).finally(() => { if (_inflight.get(k) === p) _inflight.delete(k); });
  _inflight.set(k, p);
  return p;
}

async function _discover(chain, chainKey, ca, opts = {}) {
  let head;
  try { head = Number(await chain.getBlockNumber()); }
  catch (e) { return { ok: false, why: `could not read the chain head (${(e && e.message) || e})` }; }   // NOT cached: an outage is not a fact about the token

  /*
   * ⚠️ THE SEED IS STARTED NOW, NOT AFTER THE LADDER.
   *
   * It used to be tried only once a window came back empty, to avoid paying for
   * an indexer request the cheap window would have made unnecessary. That
   * reasoning holds only while the walk is cheap — and on the node this feature
   * exists for it is not: the walk spent the whole 12s budget, so "seed last"
   * meant SEED NEVER, on exactly the tokens the seed answers instantly. It is a
   * DIFFERENT TRANSPORT, so a slow node cannot hide it.
   *
   * Started CONCURRENTLY with the whole-chain look below, so it costs no
   * latency at all where that look succeeds — one request either way, and both
   * are bounded.
   */
  const seedable = !opts.blocks && !opts.logs && typeof opts.tradeHashes === 'function';
  const hashesP = seedable ? _within(Promise.resolve().then(() => opts.tradeHashes()), STAGE_MS) : null;

  let seedTried = false;
  const trySeed = async () => {
    // ⚠️ A PINNED WINDOW MAY NOT REACH FOR THE INDEXER. `opts.blocks` asks about
    // that window; receipts fetched by hash come from wherever the trades are,
    // which answers a different question — the same rule the whole-chain look
    // already states one block down.
    if (seedTried || !seedable) return null;
    seedTried = true;
    let hashes = null;
    try { hashes = await hashesP; } catch (_) { return null; }
    if (!Array.isArray(hashes) || !hashes.length) return null;
    const logs = await _receiptLogs(chain, ca, hashes);
    if (!logs.length) return null;
    const r = await decodeCurveIface(chain, ca, { logs, maxTx: opts.maxTx });
    return r.ok ? r : null;
  };

  /*
   * ⚠️ ONE REQUEST BEFORE THE LADDER — this is the 12s refusal, fixed.
   *
   * The ladder below is three windows, and each that finds nothing pays a wide
   * `getLogs` plus a coarse AND a fine stepped walk: tens of SERIAL round trips
   * on a chain deliberately exempt from JSON-RPC batching (`batchMaxCount: 1`),
   * against `CURVE_DISCOVER_MS`. The user sees "reading this curve's interface
   * took longer than 12s" — arithmetic, not bad luck.
   *
   * HOISTED HERE, not inside `decodeCurveIface`, because that is called once per
   * window: an unbounded look in there costs one extra request PER WINDOW on a
   * node that refuses it, which is the opposite of the point.
   *
   * ⚠️ A caller that PINS a window is asking about that window and must not be
   * answered about the whole chain.
   */
  let wide = null;
  if (!opts.blocks && !opts.logs) {
    // ⚠️ BOUNDED. Unbounded, this single request is the 12s refusal — see
    // STAGE_MS. A null here is "we did not decide", which is the same
    // fail-safe reading an empty answer already gets.
    wide = await _within(decodeCurveIface(chain, ca, { head, full: true, maxTx: opts.maxTx }), STAGE_MS);
    // Only an EXPLICIT `retry: false` (a refusal) suppresses the ladder. A
    // missing flag means "we did not decide", and the fail-safe reading of that
    // is to pay for the windows: costing requests is recoverable, a false
    // "this token cannot be traded" is not.
    if (wide && !wide.ok && wide.retry !== false) wide = null;
  }

  /*
   * …and the seed is spent BEFORE the ladder, because it is the cheap answer:
   * a handful of receipts against ~96 stepped `getLogs`. It only fires if the
   * whole-chain look did not already settle it.
   */
  if (!wide || !wide.ok) { const s0 = await trySeed(); if (s0) wide = s0; }

  const windows = opts.blocks ? [Math.floor(Number(opts.blocks))] : WINDOWS;
  let res = wide;
  /*
   * ⚠️ THE WIDE LOOK FEEDS `res` — IT DOES NOT RETURN EARLY.
   *
   * A first cut returned straight out of the wide look, which skipped
   * everything below: `_recordShape`, the sibling teach, and the cache write.
   * So a SUCCESSFUL one-request discovery stopped teaching the pad — and the
   * next fresh launch on it, the very case the shape registry exists for, lost
   * its route. Four tests said so. A fast path that also skips the bookkeeping
   * is not the same fast path.
   */
  for (const blocks of res ? [] : windows) {
    res = await decodeCurveIface(chain, ca, { head, blocks, maxTx: opts.maxTx, steps: opts.steps });
    if (res.ok) break;
    // Only "we looked and this window held nothing" is worth widening. Every
    // other refusal — a call we cannot decode, a token that never touched the
    // contract, a node that would not answer — says the same thing at any size.
    if (!/^no trades found/.test(res.why || '')) break;
    const s = await trySeed();
    if (s) { res = s; break; }
  }
  // A walk that ended in a transport failure never reached the seed — and the
  // seed is a DIFFERENT transport, so it is still worth one try.
  if (res && !res.ok) { const s = await trySeed(); if (s) res = s; }

  /*
   * A FRESH LAUNCH HAS NO HISTORY TO READ — and that is the one refusal a
   * learned shape may answer. Only the no-usable-history family transfers; a
   * transport failure says nothing about the token and an unexplainable call
   * was refused for a reason that byte-identity does not cure.
   */
  if (res && !res.ok && typeof opts.poolHint === 'function'
      && /no trades found|no decodable calls|neither a buy nor a sell/.test(res.why || '')) {
    try {
      /*
       * The hint may be ONE address or SEVERAL. A token no indexer knows has
       * its curve named only by its launch announcement, which also names the
       * dex factory and the quote token — so the caller offers every contract
       * that log named and the bytecode gate below picks, rather than the
       * caller guessing which word of an unknown ABI is the pool.
       */
      const hinted = await opts.poolHint();
      const pools = (Array.isArray(hinted) ? hinted : [hinted]).filter((p) => /^0x[a-fA-F0-9]{40}$/.test(String(p || '')));
      let pool = null, hit = null;
      for (const p of pools) {
        const h = await _shapeFor(chain, chainKey, p);
        if (h) { pool = p; hit = h; break; }
      }
      if (!pool) pool = pools[0] || null;
      /*
       * ⚠️ NOTHING HAS TAUGHT THIS PAD YET — so TEACH IT, rather than telling
       * the operator to go and paste a traded token. That instruction is the
       * "apt-get install is not a fix, it is a request" defect on the one
       * feature that has now been reported four times: from Telegram, a route
       * that needs a manual priming step is a route that does not work.
       *
       * A sibling only ever teaches after its curve's BYTECODE matches ours
       * (inside _shapeFor), so a wrong list, a different pad or a hostile
       * answer teaches nothing at all. Bounded: the first sibling with a
       * readable history wins, and `learning` stops the recursion at depth 1.
       */
      if (!hit && !opts.learning && typeof opts.siblings === 'function') {
        const found = await _teachFromSiblings(chain, chainKey, opts, pools);
        if (found) { pool = found.pool; hit = found.hit; }
      }
      if (hit && pool) {
        res = {
          ok: true, transferred: true, why: null, curve: String(pool).toLowerCase(),
          learnedFrom: { curve: hit.curve, token: hit.token },
          buy: { selector: hit.buy.selector, native: true, quote: null, wide: false, seen: 0, args: [], samples: [], shape: hit.buy },
          sell: null, samples: 0,
        };
      }
    } catch (_) { /* no transfer — the honest refusal stands */ }
  }

  // Every real discovery teaches the pad's shape — one traded sibling, ever,
  // is what makes the NEXT fresh launch on this pad buyable by its first buyer.
  if (res.ok && !res.transferred) {
    await _recordShape(chain, chainKey, ca, res);
    /*
     * ⚠️ AND A TOKEN WITH TOO LITTLE HISTORY TEACHES NOTHING, SO IT MUST BE
     * TAUGHT — the classify-short case, which the transfer branch above never
     * sees.
     *
     * A pad token with two same-sized buys DECODES (so `ok` is true and the
     * card offers Buy) but cannot be CLASSIFIED — nothing can say which
     * argument is the minimum-out. `prepareBuy` then falls back to a learned
     * shape, and on a pad nobody has taught there is none, so the buy refused
     * with "a few more trades on the pad" while the card promised a Buy
     * button. The teach ran only where a token had NO history at all; here it
     * has some, just not enough.
     */
    if (!opts.learning && typeof opts.siblings === 'function' && res.curve && !_legShape(res.buy, ca)) {
      if (!(await _shapeFor(chain, chainKey, res.curve))) {
        await _teachFromSiblings(chain, chainKey, opts, [res.curve]).catch(() => null);
      }
    }
  }

  // A transport failure is never remembered — the `pumpfunNewX` rule, on the
  // path that spends money.
  if (res.ok || !/could not read/.test(res.why || '')) _cache.set(key(chainKey, ca), { res, ts: Date.now() });
  return res;
}

/**
 * A buy on the curve, ready to sign — or a refusal that says why.
 *
 * `expectedTokens` is what an independent source says `valueWei` should buy.
 * It is REQUIRED: without it `sane()` has nothing to catch a misread argument
 * with, and a slot read as a minimum-out that is really a fee tier estimates
 * gas perfectly cleanly.
 */
async function prepareBuy(chain, chainKey, ca, { wallet, valueWei, quoteRaw, slippageBps, expectedTokens, tolPct, minOutRaw }) {
  // Normalised at the door, so a Number from core.js's price side can never
  // reach a BigInt comparison and throw instead of refusing.
  const spendWei = big(valueWei) ?? 0n;
  // A pad priced in an ERC-20 pays nothing in `value`; what it spends is the
  // allowance the caller has already granted. One of the two must be real.
  const spendQuote = big(quoteRaw) ?? 0n;
  if (!(spendWei > 0n) && !(spendQuote > 0n)) return { ok: false, stage: 'build', why: 'no amount to spend' };
  const iface = await ifaceFor(chain, chainKey, ca);
  if (!iface.ok) return { ok: false, why: iface.why, stage: 'discover' };
  // `ok` means "an interface was read", which since the sell-only fix no longer
  // implies a BUY leg. The buy question needs its own answer and its own
  // sentence — one more trade on the pad is the fix, and saying so is the
  // difference between a diagnosis and a shrug.
  if (!iface.buy) {
    return { ok: false, stage: 'discover', needsMoreTrades: true, why: 'no BUY has been seen through this curve yet — the recent trades are all sells. One purchase by anyone on the pad teaches it.' };
  }

  /*
   * ⚠️ A PAYABLE CALL AND A QUOTE-TOKEN CALL ARE DIFFERENT TRANSACTIONS, and
   * sending one as the other loses the money: `value` handed to a function that
   * never asked for it is simply gone.
   *
   * A quote-token pad is supported now — the caller has to have swapped into
   * that token and approved the curve for it first, which is why `quoteRaw` is
   * REQUIRED here rather than assumed. Refusing without it is what stops a
   * value-less call being built for a payable pad and vice versa.
   */
  if (iface.buy.native && !(spendWei > 0n)) {
    return { ok: false, stage: 'build', why: "this pad's buy is paid in the native coin and no amount was given" };
  }
  if (!iface.buy.native) {
    if (!iface.buy.quote) {
      return { ok: false, stage: 'build', why: "this pad's buy is not paid in the native coin, and its trades do not show what it IS paid in — refusing rather than guessing a token address" };
    }
    if (!(spendQuote > 0n)) {
      return { ok: false, stage: 'quote', quoteToken: iface.buy.quote, why: `this pad is priced in ${iface.buy.quote}, not the native coin` };
    }
  }

  let built;
  if (iface.buy.shape) {
    // The transferred path — a fresh launch with no history of its own, on a
    // curve whose bytecode matches a learned sibling. buildFromShape's header
    // carries the safety argument; the strong-floor requirement is inside it.
    built = buildFromShape(iface.buy.shape, { token: ca, wallet, slippageBps, minOutRaw, valueWei: spendWei });
    if (!built.ok) return { ok: false, why: built.why, stage: 'build' };
  } else {
    built = buildCurveCall(iface.buy, {
      token: ca, wallet, slippageBps, minOutRaw,
      valueWei: iface.buy.native ? spendWei : 0n,
      sizeRaw: iface.buy.native ? 0n : spendQuote,
    });
    /*
     * ⚠️ AND A BUILD THAT SUCCEEDED WITH NO EXPECTATION IS ALSO SHORT.
     *
     * Two same-sized samples classify the minimum-out as a `constant`, so
     * `buildCurveCall` returns ok with `expected: null` — and `sane()` then
     * refuses every buy with "no independent price to check the curve quote
     * against" while the card, which only asks whether an interface was read,
     * offers a Buy button. That was the live 19:09 failure: a promise the buy
     * could not honour. The learned shape answers it under the same
     * code-identity proof as the no-history case.
     */
    const shortRead = !built.ok ? built.needsMoreTrades : built.expected == null;
    if (shortRead && iface.buy.native) {
      /*
       * ⚠️ ONE TRADE IS NOT TWO — the classify-short case. The token HAS a
       * history, just not enough of one to explain the arguments; the learned
       * shape answers that exactly the way it answers zero history, under the
       * same code-identity proof. The selector must match what was observed:
       * a shape for a different function is a shape for a different call.
       */
      const hit = await _shapeFor(chain, chainKey, iface.curve);
      if (hit && hit.buy.selector === iface.buy.selector) {
        const alt = buildFromShape(hit.buy, { token: ca, wallet, slippageBps, minOutRaw, valueWei: spendWei });
        if (alt.ok) built = alt;
      }
    }
    if (!built.ok) return { ok: false, why: built.why, stage: 'build', needsMoreTrades: built.needsMoreTrades };
  }

  const call = { to: iface.curve, data: built.data, value: iface.buy.native ? spendWei : 0n };
  const sim = await simulate(chain, call, wallet);
  // A rejected call may mean the pad redeployed under us — see `forget`.
  if (!sim.ok) { forget(chainKey, ca); return { ok: false, why: sim.why, stage: 'simulate', call }; }

  // NOT `built.expected ?? expectedTokens` — that compared the indexer's own
  // number against itself and passed everything.
  //
  // ⚠️ A TRANSFERRED build carries no expectation of its own to feed sane() —
  // nothing on THIS token was ever observed. What stands in for it: the shape
  // was sane()-checkable when it was learned, byte-identity carries the
  // meaning over, and the on-chain floor is OURS from a strong price
  // (buildFromShape refuses to build without one).
  if (!built.transferred) {
    const check = sane(built.expected, expectedTokens, tolPct);
    if (!check.ok) return { ok: false, why: check.why, stage: 'sane', call };
  }

  return { ok: true, why: null, call, gas: sim.gas, iface, slots: built.slots, quoteToken: iface.buy.native ? null : iface.buy.quote, boundedByIndependentPrice: built.boundedByIndependentPrice, transferred: !!built.transferred, describe: describeIface(iface) };
}

/**
 * A sell on the curve.
 *
 * ⚠️ SELLING NEEDS AN ALLOWANCE and this does not build one, so it refuses
 * rather than sending a call that will revert at the transferFrom. Saying that
 * plainly is the whole point: "the sell reverted" sends somebody hunting
 * through slippage settings for a step that was never taken.
 */
async function prepareSell(chain, chainKey, ca, { wallet, amountRaw, slippageBps, expectedNative, tolPct, allowance = 0n, minOutRaw }) {
  const sellRaw = big(amountRaw);
  if (!(sellRaw > 0n)) return { ok: false, stage: 'build', why: 'no amount to sell' };
  const have = big(allowance) ?? 0n;   // an allowance we could not read is not an allowance
  const iface = await ifaceFor(chain, chainKey, ca);
  if (!iface.ok) return { ok: false, why: iface.why, stage: 'discover' };
  if (!iface.sell) {
    return { ok: false, stage: 'discover', why: "no SELL has been seen on this curve yet — one sale by anyone teaches it, and then this works" };
  }

  /*
   * ⚠️ THE ALLOWANCE CHECK RUNS LAST, AND THAT ORDER IS THE POINT.
   *
   * It used to run FIRST — above build, above the price check, above simulate —
   * so a `stage:'approve'` refusal said nothing at all about whether the call
   * was buildable or sanely priced. The caller granted an allowance to a
   * contract address inferred from log scoring, re-called, and could still be
   * refused at 'build' ("argument 2 is not understood") or at 'sane'. The
   * approval stayed granted, forever, for a sell that never happened.
   *
   * Built and priced first collapses that to the one case that genuinely cannot
   * be pre-run: `simulate`, which reverts at the transferFrom without an
   * allowance. Everything that can refuse for free now refuses for free.
   */
  const built = buildCurveCall(iface.sell, { token: ca, wallet, amountRaw: sellRaw, slippageBps, minOutRaw });
  if (!built.ok) return { ok: false, why: built.why, stage: 'build', needsMoreTrades: built.needsMoreTrades };

  const check = sane(built.expected, expectedNative, tolPct);
  if (!check.ok) return { ok: false, why: check.why, stage: 'sane' };

  const call = { to: iface.curve, data: built.data, value: 0n };
  if (have < sellRaw) {
    // ⚠️ `amountRaw` EXACTLY, never an unlimited grant. The spender here was
    // inferred from Transfer logs and is vouched for by nobody — v4.js already
    // draws this line for a discovered router: "an operator-set router gets a
    // standing allowance; a discovered one gets this sell and nothing more."
    // An unlimited grant to a wrong address is the only unbounded loss in this
    // whole design, and it outlives the trade.
    return { ok: false, stage: 'approve', needsApprove: { spender: iface.curve, amountRaw: sellRaw, exact: true }, call, why: 'the curve needs an allowance for this token before it can take it' };
  }

  const sim = await simulate(chain, call, wallet);
  if (!sim.ok) { forget(chainKey, ca); return { ok: false, why: sim.why, stage: 'simulate', call }; }

  return { ok: true, why: null, call, gas: sim.gas, iface, slots: built.slots, quoteToken: (iface.sell && iface.sell.quote) || null, boundedByIndependentPrice: built.boundedByIndependentPrice };
}

module.exports = { ifaceFor, prepareBuy, prepareSell, cached, forget, _reset, _cache, _resetShapes, _shapeFor, _legShape };
