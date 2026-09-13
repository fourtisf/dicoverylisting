'use strict';
/*
 * Uniswap V4.
 *
 * v4 has no pair contract and no per-pool contract. Every pool in a deployment
 * lives inside ONE PoolManager, in a mapping keyed by
 *
 *     poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))
 *
 * so there is nothing for V2's getPair or V3's getPool to return, and a v4-only
 * token is invisible to both. That is exactly what happened to $TLNCH on
 * Robinhood Chain: a live pool with real liquidity, and the bot answered
 * "couldn't price it" while Maestro showed the price, because Maestro reads the
 * PoolManager directly.
 *
 * Reading and swapping are configured SEPARATELY, because they fail
 * differently. Pricing needs only the PoolManager; swapping needs the Universal
 * Router (and Permit2 to sell). A chain may have the first without the second,
 * and then the card prices the token and says it cannot fill a swap — which is
 * the honest state, not a broken one.
 *
 * NOTHING HERE GUESSES AN ADDRESS — but it does OBSERVE one. Those are not the
 * same thing, and the difference is the whole design:
 *
 *   • A GUESS is "Uniswap deploys the router here on most chains, so try it."
 *     That is what put a wrong V3 quoter on Robinhood Chain, and it is still
 *     banned.
 *   • An OBSERVATION is "this contract emitted the Initialize log that created
 *     the pool", or "this contract is the one that called swap() on the
 *     PoolManager". The chain is the source, and it cannot be out of date.
 *
 * So the env vars below are still read first and still win, but when they are
 * unset the module finds the PoolManager from the token's own Initialize log
 * and the router from the senders of that PoolManager's own Swap logs. Waiting
 * for an operator to paste three addresses into .env is why a live v4 token
 * with real liquidity was answered with "Dexvra can't route through that yet".
 *
 * AND NOTHING IS SIGNED UNSIGHTED. Every swap is eth_call'd first (simulate()):
 * the action encoding is the part most likely to differ on a fork, and a wrong
 * encoding has to cost a refused trade, never a sent one. That rail is what
 * makes an observed router safe to try — a candidate that cannot fill the swap
 * we built reverts in a simulation instead of in a transaction, and the next
 * candidate is tried. Nothing is ever sent to an address that has not already
 * executed this exact calldata for free.
 */
const { ethers } = require('ethers');

// Uniswap's canonical fee/tickSpacing pairings. A pool may use any combination,
// but every deployment's UI creates these four, so a sweep of them finds the
// pool a normal launch made. Widen with <CHAIN>_V4_FEE_TIERS if a deployment
// uses something else: "fee:tickSpacing,fee:tickSpacing".
const DEFAULT_TIERS = [[100, 1], [500, 10], [3000, 60], [10000, 200]];

// Storage slot of PoolManager's `_pools` mapping. v4-periphery's StateView reads
// it at 6; kept as an env override because a fork is free to lay its storage out
// differently, and a wrong slot reads zeros — which is indistinguishable from
// "no pool" and would send us back to the same dead end with no clue why.
const DEFAULT_POOLS_SLOT = 6;
// Pool.State: slot0, feeGrowthGlobal0X128, feeGrowthGlobal1X128, liquidity.
const LIQUIDITY_OFFSET = 3n;

const EXTSLOAD_ABI = ['function extsload(bytes32 slot) view returns (bytes32)'];
const STATEVIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
];

// PoolManager's pool-creation event, and the ONE definition of it.
//
// The first three parameters are INDEXED — they are topics, not data. A copy of
// this without the `indexed` keywords still hashes to the right topic0 (indexed
// does not affect the signature), so getLogs finds the logs and every one of
// them then fails to parse: right filter, unreadable result. That is exactly
// what v4-discover did on its first run — it reported a hit and then printed
// nothing at all.
const INITIALIZE_EVENT =
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)';
const INITIALIZE_TOPIC = ethers.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
// One owner for the Transfer topic — `curveIface` defines it and this reads the
// same logs for a different reason.
const { TRANSFER_TOPIC } = require('./curveIface.js');
const v4cd = require('./v4Calldata.js');

const NATIVE = '0x0000000000000000000000000000000000000000';
const coder = ethers.AbiCoder.defaultAbiCoder();

const _env = (k) => (process.env[k] || '').trim();
const _isAddr = (a) => { try { return !!a && ethers.isAddress(a) && a !== ethers.ZeroAddress; } catch (_) { return false; } };

/** v4 config for a chain, or null when it isn't set up.
 *
 *  `poolManagerOverride` is how a DISCOVERED PoolManager (see cfgLive) reuses
 *  the rest of this — the fee tiers, the storage slot, the StateView — without a
 *  second copy of the env parsing that has already been wrong once. */
function cfg(chainKey, poolManagerOverride) {
  const P = String(chainKey).toUpperCase();
  const poolManager = _isAddr(poolManagerOverride) ? poolManagerOverride : _env(`${P}_V4_POOLMANAGER`);
  if (!_isAddr(poolManager)) return null;
  const stateView = _env(`${P}_V4_STATEVIEW`);
  // NOT Number(_env(...)) alone: an unset var is "", Number("") is 0, and 0 is
  // finite and >= 0 — so the default slot silently became 0, which reads the
  // wrong storage word and returns zeros, which is indistinguishable from
  // "no pool here". An empty string means unset, not zero.
  const slotStr = _env(`${P}_V4_POOLS_SLOT`);
  const slotRaw = slotStr === '' ? NaN : Number(slotStr);
  const tiersRaw = _env(`${P}_V4_FEE_TIERS`);
  const tiers = tiersRaw
    ? tiersRaw.split(',').map((s) => s.split(':').map(Number)).filter((t) => t.length === 2 && t.every(Number.isFinite))
    : DEFAULT_TIERS;
  return {
    poolManager,
    stateView: _isAddr(stateView) ? stateView : null,
    poolsSlot: Number.isFinite(slotRaw) && slotRaw >= 0 ? slotRaw : DEFAULT_POOLS_SLOT,
    tiers: tiers.length ? tiers : DEFAULT_TIERS,
  };
}

// ─────────────────────────────── discovery ───────────────────────────────────
//
// Everything from here to the price math answers one question: what do we not
// know about this chain's v4 deployment that the chain itself can tell us?
//
// Kill switch: <CHAIN>_V4_AUTODISCOVER=0 pins a chain to its env alone.

const SCAN_STEP_DEFAULT = 9000;          // the common public-RPC eth_getLogs range cap
const SCAN_BLOCKS_DEFAULT = 4000000;     // how far back a stepped scan is willing to walk

// PoolManager.Swap. Only the TOPICS are read, never the data: topic2 is
// `sender`, which for a v4 swap is whatever contract unlocked the PoolManager —
// i.e. the router that filled it. That is the Universal Router's address stated
// by the chain, with no transaction fetch and no guess.
const SWAP_TOPIC = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');

const _autoOk = (chainKey) => _env(`${String(chainKey).toUpperCase()}_V4_AUTODISCOVER`) !== '0';
const _scanBlocks = (chainKey) => {
  const n = Number(_env(`${String(chainKey).toUpperCase()}_V4_SCAN_BLOCKS`));
  return Number.isFinite(n) && n > 0 ? n : SCAN_BLOCKS_DEFAULT;
};
const _scanStep = (chainKey) => {
  const n = Number(_env(`${String(chainKey).toUpperCase()}_V4_SCAN_STEP`));
  return Number.isFinite(n) && n > 0 ? n : SCAN_STEP_DEFAULT;
};

// Discovery is an eth_getLogs sweep, which is the most expensive read in this
// file — so each answer is cached, and a MISS is cached too (briefly). Without
// the negative cache, a token that genuinely has no v4 pool would re-scan the
// whole chain on every card refresh of every open live monitor.
const HIT_TTL_MS = 6 * 3600 * 1000;
// A token that has no pool YET may have one in a minute, so that miss expires
// quickly. A CHAIN that has no v4 deployment will not grow one this afternoon,
// and re-sweeping its whole log history every five minutes — on every token
// nothing else could price — is how a bot gets itself rate-limited off its own
// RPC. The two misses are not the same fact and do not get the same TTL.
const MISS_TTL_MS = 5 * 60 * 1000;
const CHAIN_MISS_TTL_MS = 6 * 3600 * 1000;
const _disc = new Map();   // cacheKey → { at, val, missTtl }
function _cached(key, val, missTtl) { _disc.set(key, { at: Date.now(), val, missTtl: missTtl || MISS_TTL_MS }); return val; }
function _lookup(key) {
  const hit = _disc.get(key);
  if (!hit) return undefined;
  const ttl = (hit.val && (!Array.isArray(hit.val) || hit.val.length)) ? HIT_TTL_MS : hit.missTtl;
  if (Date.now() - hit.at > ttl) { _disc.delete(key); return undefined; }
  return hit.val;
}

/**
 * eth_getLogs over a whole chain, the cheap way first.
 *
 * One unbounded call is a single round trip and most nodes answer it happily
 * when the filter is topic-narrow (an indexed address pins it to a handful of
 * logs). Nodes that refuse — the ones with a hard range cap — throw, and only
 * then is the stepped walk paid for. Doing it the other way round costs
 * hundreds of requests on every chain that never needed them.
 *
 * Never throws: discovery failing has to look like "found nothing", because the
 * caller's fallback for both is the same and a throw here would take down a
 * price card over a log query.
 */
const SCAN_MAX_REQUESTS = 60;
async function _scanLogs(provider, chainKey, { address, topics, limit = 40 }) {
  if (!provider || typeof provider.getLogs !== 'function') return [];
  const filter = address ? { address, topics } : { topics };
  try {
    const logs = await provider.getLogs({ ...filter, fromBlock: 0, toBlock: 'latest' });
    if (Array.isArray(logs)) return logs.slice(-limit);
  } catch (_) { /* range-capped node — fall through to the stepped walk */ }
  let head = 0;
  try { head = await provider.getBlockNumber(); } catch (_) { return []; }
  const step = _scanStep(chainKey);
  const floor = Math.max(0, head - _scanBlocks(chainKey));
  const out = [];
  // NEWEST FIRST, and on a REQUEST BUDGET. A pool's Initialize is one log in the
  // chain's whole history, but a live token's most recent activity is near the
  // head, so walking forwards from the floor would pay for every empty range
  // before reaching it. The budget is the other half: without it, one chain
  // whose node caps ranges at 9k blocks turns a single unpriceable token into
  // several hundred requests, which is how a bot gets itself throttled off the
  // RPC it needs for trading.
  let spent = 0;
  for (let hi = head; hi >= floor && out.length < limit && spent < SCAN_MAX_REQUESTS; hi -= step) {
    const lo = Math.max(floor, hi - step + 1);
    spent++;
    try {
      const logs = await provider.getLogs({ ...filter, fromBlock: lo, toBlock: hi });
      if (Array.isArray(logs) && logs.length) out.push(...logs);
    } catch (_) { /* one bad range must not abandon the rest of the walk */ }
    if (lo === floor) break;
  }
  return out.slice(0, limit);
}

const _initTopics = (token) => {
  // The token is currency0 OR currency1, and both are indexed — so it takes two
  // filters. topic1 is the poolId, which we are not filtering on.
  const t = ethers.zeroPadValue(ethers.getAddress(token), 32);
  return [[INITIALIZE_TOPIC, null, t], [INITIALIZE_TOPIC, null, null, t]];
};

/** Every Initialize log naming `ca`, from `poolManager` if we know it yet. */
async function _initLogs(provider, chainKey, ca, poolManager) {
  const out = [];
  for (const topics of _initTopics(ca)) {
    out.push(...await _scanLogs(provider, chainKey, { address: poolManager || undefined, topics }));
  }
  return out;
}

/**
 * The PoolManager for a chain, observed from a pool this token is actually in.
 *
 * Whatever contract emitted an Initialize log that names this token IS the
 * PoolManager of the deployment that pool lives in — there is nothing to derive
 * and nothing to look up, which is why scripts/v4-discover.js has always worked
 * this way. This is that script's core, moved inside the bot so an operator
 * having not run it yet stops being the reason a token cannot be traded.
 *
 * Cached per CHAIN, not per token: a chain has one PoolManager, so the first
 * v4 token anyone pastes configures it for every token after it.
 */
async function discoverPoolManager(chainKey, ca, deps) {
  if (!_autoOk(chainKey)) return null;
  const ck = `pm:${chainKey}`;
  const hit = _lookup(ck);
  if (hit !== undefined) return hit;
  let provider; try { provider = deps.providerFor(chainKey); } catch (_) { return _cached(ck, null, CHAIN_MISS_TTL_MS); }
  const logs = await _initLogs(provider, chainKey, ca, null);
  // Most Initialize logs wins. A chain running more than one v4 deployment (a
  // fork alongside the canonical one) is exactly when picking the busier is
  // right, and picking arbitrarily is wrong.
  const tally = new Map();
  for (const l of logs) {
    if (!l || !l.address) continue;
    let a; try { a = ethers.getAddress(l.address); } catch (_) { continue; }
    tally.set(a, (tally.get(a) || 0) + 1);
  }
  const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  return _cached(ck, best ? best[0] : null, CHAIN_MISS_TTL_MS);
}

/**
 * cfg(), plus discovery when the env is unset.
 *
 * `ca` is only used to find the PoolManager the first time — after that the
 * chain's answer is cached and this is as cheap as cfg().
 */
async function cfgLive(chainKey, ca, deps) {
  const direct = cfg(chainKey);
  if (direct) return direct;
  if (!deps || typeof deps.providerFor !== 'function') return null;
  const pm = await discoverPoolManager(chainKey, ca, deps).catch(() => null);
  return pm ? cfg(chainKey, pm) : null;
}

/**
 * The pool keys this token is REALLY in, read off the Initialize logs.
 *
 * This is the difference between finding $TLNCH and not finding it. The tier
 * sweep below can only try keys it can construct, which means hookless ones at
 * four canonical fee tiers — and a token that graduated off a launchpad is
 * almost always in a HOOKED pool, whose poolId the sweep can therefore never
 * reproduce. The Initialize log carries the whole PoolKey, hooks included, so
 * the pool is found as it actually is rather than as we assumed it would be.
 *
 * A key whose OTHER currency is not native or wrapped native is dropped. Pricing
 * a token against, say, USDC and then treating that number as native is the
 * 10^n class of error the whole price path is shaped around avoiding — and a
 * quote currency we cannot value is not a quote.
 */
/*
 * A THIRD SOURCE: the pool the token's OWN TRADES name.
 *
 * The constructed sweep guesses native/WETH pairings; `discoverPoolKeys` reads
 * Initialize logs. Both can miss the same pool — the sweep because the pairing
 * is a third token, the Initialize scan because that one log is somewhere in the
 * whole history and a range-capped node can hide it. Meanwhile the token trades
 * every few minutes, and every one of those trades is a router call that NAMES
 * the pool it went through.
 *
 * That is the case the reported token sits in: a launchpad router, a pairing
 * against a tokenised asset, and a card that could price it but not route it.
 * A competitor trades it by hand-writing an integration per launchpad; this
 * reads the same fact off the chain and proves it, which is why it needs no
 * per-pad code at all.
 *
 * ⚠️ THE CALLDATA IS NEVER REPLAYED — see `v4Calldata.js`. Only a PoolKey comes
 * out, proved by recomputing its own id, and every candidate still has to
 * survive the state read in `bestPool` below: a pool that does not exist on
 * chain, or holds nothing, is dropped exactly like any other. So the worst a
 * hostile trade can do is name a pool that is not there.
 */
const TRADE_SCAN_TX = Math.max(1, Number(process.env.V4_TRADE_SCAN_TX || 6));
const TRADE_SCAN_MS = Math.max(500, Number(process.env.V4_TRADE_SCAN_MS || 4000));

async function tradePoolKeys(ca, chainKey, deps) {
  if (!_autoOk(chainKey)) return [];
  const ck = `tradekeys:${chainKey}:${String(ca).toLowerCase()}`;
  const hit = _lookup(ck);
  if (hit !== undefined) return hit || [];
  let provider; try { provider = deps.providerFor(chainKey); } catch (_) { return _cached(ck, null) || []; }
  if (typeof provider.getTransaction !== 'function') return _cached(ck, null) || [];

  /*
   * ⚠️ BOUNDED IN TIME AND IN WORK, because this sits on the card's critical
   * path and on `canTradeNow`, which every snipe polls on a timer. Reading the
   * pool out of a router's calldata costs a log scan, a handful of
   * `getTransaction`, and a bounded search per call — and this repo has just
   * spent three rounds on a single unbounded stage eating a whole budget.
   */
  const until = Date.now() + TRADE_SCAN_MS;
  const budget = { left: v4cd.MAX_HASHES };
  const logs = await _scanLogs(provider, chainKey, { address: ca, topics: [TRANSFER_TOPIC], limit: 40 });
  if (Date.now() > until) return _cached(ck, null) || [];
  // Newest first, and deduplicated: a trade emits several Transfers and they all
  // point at the same call.
  const hashes = [];
  for (let i = logs.length - 1; i >= 0 && hashes.length < TRADE_SCAN_TX; i--) {
    const h = logs[i] && logs[i].transactionHash;
    if (h && !hashes.includes(h)) hashes.push(h);
  }
  const keys = [];
  const seen = new Set();
  for (const h of hashes) {
    // A partial answer beats a late one: whatever was proved so far is already
    // verified by its own poolId and is handed on.
    if (Date.now() > until || budget.left <= 0) break;
    let tx = null;
    try { tx = await provider.getTransaction(h); } catch (_) { continue; }
    if (!tx || !tx.data) continue;
    for (const k of v4cd.poolKeysFrom(tx.data, ca, poolId, { budget })) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      keys.push(k);
    }
  }
  return _cached(ck, keys.length ? keys : null) || [];
}

async function discoverPoolKeys(ca, chainKey, c, deps) {
  if (!_autoOk(chainKey)) return [];
  const ck = `keys:${chainKey}:${String(ca).toLowerCase()}`;
  const hit = _lookup(ck);
  if (hit !== undefined) return hit || [];
  let provider; try { provider = deps.providerFor(chainKey); } catch (_) { return _cached(ck, null) || []; }
  const chain = (typeof deps.chainOf === 'function' && deps.chainOf(chainKey)) || {};
  const want = new Set([NATIVE]);
  if (_isAddr(chain.weth)) want.add(String(chain.weth).toLowerCase());
  const token = String(ca).toLowerCase();

  const logs = await _initLogs(provider, chainKey, ca, c.poolManager);
  const iface = new ethers.Interface([INITIALIZE_EVENT]);
  const keys = [];
  const seen = new Set();
  for (const l of logs) {
    let d; try { d = iface.parseLog(l); } catch (_) { continue; }
    if (!d) continue;
    const currency0 = String(d.args[1]).toLowerCase();
    const currency1 = String(d.args[2]).toLowerCase();
    const tokenIsZero = currency0 === token;
    // The filter matched on an indexed topic, so one side IS this token — but
    // which side decides whether the price inverts, so it is established here
    // rather than assumed. A log naming neither side is not ours.
    if (!tokenIsZero && currency1 !== token) continue;
    const quote = tokenIsZero ? currency1 : currency0;
    if (!want.has(quote)) continue;              // priced in something we cannot value — not a quote
    const fee = Number(d.args[3]);
    const tickSpacing = Number(d.args[4]);
    const hooks = String(d.args[5]).toLowerCase();
    const id = String(d.args[0]).toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    // The id in the log is authoritative; ours has to reproduce it or our key
    // encoding does not match this deployment, and every read after this would
    // be of a pool that does not exist. Trust the chain, not the reconstruction.
    if (poolId(currency0, currency1, fee, tickSpacing, hooks).toLowerCase() !== id) continue;
    keys.push({ id, fee, tickSpacing, hooks, quote, tokenIsZero, currency0, currency1 });
  }
  return _cached(ck, keys.length ? keys : null) || [];
}

/**
 * Universal Router candidates for a chain: the env one first, then whatever
 * contracts have actually been observed filling swaps on this PoolManager.
 *
 * `sender` on a v4 Swap log is the contract that unlocked the PoolManager, so
 * every address here has already executed a real v4 swap on this exact
 * deployment. That still is not proof it speaks the Universal Router's
 * `execute(bytes,bytes[],uint256)` — a position manager or an aggregator shows
 * up in the same list — which is why the caller ELECTS one by simulating the
 * swap it is about to sign against each in turn. An address that cannot fill
 * our calldata for free never gets to fill it for money.
 */
async function routerCandidates(chainKey, c, deps) {
  const out = [];
  const rc = routerCfg(chainKey);
  if (rc) out.push(rc.router);
  if (!_autoOk(chainKey) || !c) return out;
  const ck = `ur:${chainKey}`;
  let found = _lookup(ck);
  if (found === undefined) {
    let provider; try { provider = deps.providerFor(chainKey); } catch (_) { provider = null; }
    const logs = provider ? await _scanLogs(provider, chainKey, { address: c.poolManager, topics: [SWAP_TOPIC], limit: 120 }) : [];
    const tally = new Map();
    for (const l of logs) {
      const t = l && Array.isArray(l.topics) ? l.topics[2] : null;
      if (!t || t.length !== 66) continue;
      let a; try { a = ethers.getAddress('0x' + t.slice(26)); } catch (_) { continue; }
      if (a === ethers.ZeroAddress) continue;
      if (a.toLowerCase() === String(c.poolManager).toLowerCase()) continue;
      tally.set(a, (tally.get(a) || 0) + 1);
    }
    // Busiest first: the router the deployment's own UI uses is the one most of
    // its swaps came through, so the election below usually ends on the first try.
    found = _cached(ck, [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([a]) => a), CHAIN_MISS_TTL_MS);
  }
  for (const a of found || []) if (!out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(a);
  // The router that has already filled a swap on this chain goes first, and a
  // demoted one goes last. Election is per chain and outlives the trade that
  // did it: without that, a SELL — which has to approve before it can simulate —
  // would be approving whichever candidate happened to sort highest.
  const elected = _lookup(`elect:${chainKey}`);
  const demoted = _lookup(`demote:${chainKey}`) || [];
  const rank = (a) => (elected && a.toLowerCase() === elected.toLowerCase() ? -1 : demoted.includes(a.toLowerCase()) ? 1 : 0);
  return out.sort((a, b) => rank(a) - rank(b));
}

/** Remember the router that actually filled a swap here. */
function electRouter(chainKey, router) { if (_isAddr(router)) _cached(`elect:${chainKey}`, ethers.getAddress(router)); }

/**
 * Mark a candidate as the wrong one.
 *
 * The ERC20 side of a swap has to approve BEFORE it can simulate, so a wrong
 * top candidate cannot simply be skipped mid-trade — the next one has no
 * allowance either, and every candidate then fails for a reason that has
 * nothing to do with whether it is a router. Demoting it makes the retry try
 * somebody else instead of failing the same way forever.
 */
function demoteRouter(chainKey, router) {
  if (!_isAddr(router)) return;
  const k = `demote:${chainKey}`;
  const cur = _lookup(k) || [];
  const a = String(router).toLowerCase();
  if (!cur.includes(a)) _cached(k, [...cur, a], CHAIN_MISS_TTL_MS);
  const el = _lookup(`elect:${chainKey}`);
  if (el && el.toLowerCase() === a) _disc.delete(`elect:${chainKey}`);
}

/** Forget every discovered address. Tests only — production caches for hours. */
function _resetDiscovery() { _disc.clear(); }

/** poolId for a PoolKey. currency0 MUST sort below currency1 — v4 rejects a key
 *  that doesn't, and the id would be for a pool that cannot exist. */
/*
 * ⚠️ HAND-ENCODED, AND THE EQUIVALENCE IS PINNED BY A TEST.
 *
 * `AbiCoder.encode` costs ~156µs a call, which is nothing for the handful of
 * ids the constructed sweep needs and is the whole budget for `v4Calldata`,
 * which hashes thousands of candidate assignments to find a pool in a router's
 * calldata. Five fixed 32-byte words need no coder: this is ~7× faster and, for
 * the same reason it must be, byte-identical — `uniswapV4.test.js` asserts it
 * against `coder.encode` on the negative tickSpacing and the boundary values,
 * because a hand-rolled encoder is exactly the kind of thing that agrees on the
 * easy cases.
 *
 * It stays the ONE owner of the hash. A second, faster copy inside v4Calldata is
 * how two modules end up disagreeing about the very thing being proved.
 */
const _pidBuf = new Uint8Array(160);
function _putAddr(a, off) {
  const h = String(a);
  const p = h.charCodeAt(1) === 120 /* x */ ? 2 : 0;   // tolerate a bare hex string
  for (let i = 0; i < 20; i++) _pidBuf[off + 12 + i] = parseInt(h.substr(p + i * 2, 2), 16);
}
/*
 * ⚠️ NO EXPLICIT TWO'S-COMPLEMENT STEP, and that is deliberate rather than an
 * omission. `int24` encodes negative ticks as two's complement, and BigInt's `&`
 * and `>>` already operate in infinite two's complement — so `-120n & 0xffn` is
 * 136n, which is the byte `abi.encode` writes. An explicit `n += 1n << 256n`
 * above this loop produces identical bytes; a mutation run deleting it failed
 * nothing, which is what a redundant guard looks like. Saying so beats carrying
 * a line that reads as load-bearing. The equivalence itself is pinned in
 * `uniswapV4.test.js` against the coder, on both int24 boundaries.
 */
function _putInt(v, end) {
  let n = BigInt(v);
  for (let i = 0; i < 32; i++) { _pidBuf[end - i] = Number(n & 0xffn); n >>= 8n; }
}
function poolId(currency0, currency1, fee, tickSpacing, hooks = NATIVE) {
  _pidBuf.fill(0);
  _putAddr(currency0, 0);
  _putAddr(currency1, 32);
  _putInt(fee, 95);
  _putInt(tickSpacing, 127);
  _putAddr(hooks == null ? NATIVE : hooks, 128);
  return ethers.keccak256(_pidBuf);
}

/** The two currencies of a token↔native pool, in v4's required order. */
function orderCurrencies(token, quote) {
  const a = String(token).toLowerCase();
  const b = String(quote).toLowerCase();
  return a < b ? { currency0: a, currency1: b, tokenIsZero: true } : { currency0: b, currency1: a, tokenIsZero: false };
}

/** slot0 + liquidity for a poolId. Zero sqrtPrice = the pool does not exist. */
async function poolState(provider, c, id) {
  if (c.stateView) {
    try {
      const sv = new ethers.Contract(c.stateView, STATEVIEW_ABI, provider);
      const [sqrtPriceX96] = await sv.getSlot0(id);
      if (!sqrtPriceX96 || sqrtPriceX96 === 0n) return null;
      const liquidity = await sv.getLiquidity(id).catch(() => 0n);
      return { sqrtPriceX96: BigInt(sqrtPriceX96), liquidity: BigInt(liquidity || 0n) };
    } catch (_) { return null; }
  }
  // No StateView deployed — read the PoolManager's storage directly. This is
  // what StateView itself does; it is only sugar over extsload.
  try {
    const pm = new ethers.Contract(c.poolManager, EXTSLOAD_ABI, provider);
    const base = BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint256'], [id, c.poolsSlot])));
    const word = await pm.extsload(ethers.toBeHex(base, 32));
    const raw = BigInt(word);
    const sqrtPriceX96 = raw & ((1n << 160n) - 1n);   // slot0 packs sqrtPriceX96 in the low 160 bits
    if (sqrtPriceX96 === 0n) return null;
    let liquidity = 0n;
    try { liquidity = BigInt(await pm.extsload(ethers.toBeHex(base + LIQUIDITY_OFFSET, 32))); } catch (_) {}
    return { sqrtPriceX96, liquidity };
  } catch (_) { return null; }
}

const Q192 = 1n << 192n;
const NAT = 10n ** 18n;   // native decimals — every chain in the registry is 18
const WAD = 10n ** 18n;   // precision scale for the BigInt→Number handoff

/**
 * Native per ONE WHOLE token, from sqrtPriceX96.
 *
 * v4 inherits v3's convention: (sqrtPriceX96 / 2^96)^2 is the price of currency0
 * in currency1, in RAW units. Decimals and the currency ordering both have to be
 * undone or the answer is out by 10^n — a silently wrong price being far worse
 * than no price, this is done in BigInt and only converted at the end.
 */
function priceNativeFromSqrt(sqrtPriceX96, tokenDecimals, tokenIsZero) {
  const px192 = BigInt(sqrtPriceX96) * BigInt(sqrtPriceX96);
  if (px192 <= 0n) return 0;
  const tokUnit = 10n ** BigInt(tokenDecimals);
  // tokenIsZero: price(1 token in native) = P · 10^dec / 10^18
  // else:        price(1 token in native) = 10^dec / (P · 10^18)   [P inverted]
  const scaled = tokenIsZero
    ? (px192 * tokUnit * WAD) / (Q192 * NAT)
    : (tokUnit * Q192 * WAD) / (px192 * NAT);
  return Number(scaled) / Number(WAD);
}

/**
 * The deepest v4 pool for `ca` against native ETH or wrapped native.
 *
 * Native first: v4 supports ETH as a currency directly (address(0)), which is
 * what a v4-era launch actually pairs against — checking only WETH would miss
 * the common case entirely.
 */
async function bestPool(ca, chainKey, deps) {
  const c = await cfgLive(chainKey, ca, deps);
  if (!c) return null;
  const chain = deps.chainOf(chainKey);
  if (!chain) return null;
  const provider = deps.providerFor(chainKey);
  // Explicit seam: the storage read is the one part that needs a live chain, so
  // tests substitute it. Patching the module export instead would not work —
  // this function calls the local binding.
  const read = deps.poolState || poolState;
  const quotes = [NATIVE];
  if (_isAddr(chain.weth)) quotes.push(String(chain.weth).toLowerCase());

  // Two sources, deliberately both. The SWEEP is four hashes and no log query,
  // so it answers instantly for an ordinary hookless pool; the OBSERVED keys
  // cost an eth_getLogs but are the only way a hooked pool — or one on a fee
  // tier nobody's UI offers — is ever found at all. Running the sweep alone is
  // what made a live token look like it did not exist.
  const candidates = new Map();   // poolId → key
  for (const quote of quotes) {
    const { currency0, currency1, tokenIsZero } = orderCurrencies(ca, quote);
    for (const [fee, tickSpacing] of c.tiers) {
      const id = poolId(currency0, currency1, fee, tickSpacing);
      candidates.set(id, { id, fee, tickSpacing, quote, tokenIsZero, currency0, currency1, hooks: NATIVE });
    }
  }
  for (const k of await discoverPoolKeys(ca, chainKey, c, deps).catch(() => [])) {
    if (!candidates.has(k.id)) candidates.set(k.id, k);
  }
  // THE THIRD SOURCE. Asked LAST and only for what the first two missed: it
  // costs a log scan plus a few getTransaction, where the sweep is four hashes
  // and no request at all. It is the only one that can find a pool whose
  // Initialize log a capped node hides, or whose pairing nobody would have
  // guessed — which is exactly the reported token.
  for (const k of await tradePoolKeys(ca, chainKey, deps).catch(() => [])) {
    if (!candidates.has(k.id)) candidates.set(k.id, k);
  }

  const found = [];
  await Promise.all([...candidates.values()].map(async (k) => {
    const st = await read(provider, c, k.id).catch(() => null);
    // The whole key travels WITH the hit — currency0/1, fee, tickSpacing AND
    // hooks. The swap is built from the key whose id was actually found on
    // chain, never rebuilt from assumptions, or a hooked pool would be read at
    // one address and swapped at another.
    if (st) found.push({ ...st, ...k });
  }));
  if (!found.length) return null;
  // Deepest by in-range liquidity. A pool that is initialised but empty prices
  // at whatever it was initialised to, which is not a market.
  found.sort((a, b) => (a.liquidity > b.liquidity ? -1 : a.liquidity < b.liquidity ? 1 : 0));
  return found[0];
}

/**
 * What ONE exact-input swap through this pool actually pays out, in raw units.
 *
 * minOut used to be derived from the SPOT price — which charges no fee and has
 * no depth term, so it overstates the fill by the fee on every trade and by a
 * lot more on a thin pool. On the $2k-liquidity pools this feature exists for,
 * a $20 buy is 1% of the book: spot said one thing, the pool paid another, and
 * the difference came out of the user's slippage before their slippage had
 * protected anything.
 *
 * This is v3's single-range step math, which v4 inherits unchanged: take the
 * fee off the input, walk sqrtPrice to where that input moves it, and measure
 * the other side. Exact while the swap stays inside the current tick range and
 * close outside it — and either way it is the pool's own arithmetic rather than
 * a straight-line guess from the mid price. Returns 0n when it cannot be
 * computed, which callers must treat as "no quote", never as "zero out".
 */
function quoteExactIn(pool, amountIn, tokenIn) {
  try {
    const amt = BigInt(amountIn);
    const L = BigInt(pool.liquidity || 0n);
    const sqrtP = BigInt(pool.sqrtPriceX96 || 0n);
    if (amt <= 0n || L <= 0n || sqrtP <= 0n) return 0n;
    const fee = BigInt(Math.max(0, Math.min(1000000, Number(pool.fee) || 0)));
    // v4 fees are hundredths of a bip, same as v3: 3000 = 0.30%.
    const inLessFee = (amt * (1000000n - fee)) / 1000000n;
    if (inLessFee <= 0n) return 0n;
    const zeroForOne = String(tokenIn).toLowerCase() === String(pool.currency0).toLowerCase();
    if (zeroForOne) {
      // currency0 in, currency1 out — the price falls.
      const num = L << 96n;
      const next = (num * sqrtP) / (num + inLessFee * sqrtP);
      if (next <= 0n || next >= sqrtP) return 0n;
      return (L * (sqrtP - next)) >> 96n;
    }
    // currency1 in, currency0 out — the price rises.
    const next = sqrtP + (inLessFee << 96n) / L;
    if (next <= sqrtP) return 0n;
    return (L * ((next - sqrtP) << 96n)) / (next * sqrtP);
  } catch (_) { return 0n; }
}

/** { priceEth, liquidity, fee, … } for the deepest v4 pool, or null. */
async function price(ca, chainKey, decimals, deps) {
  const p = await bestPool(ca, chainKey, deps);
  if (!p) return null;
  const priceEth = priceNativeFromSqrt(p.sqrtPriceX96, decimals, p.tokenIsZero);
  if (!(priceEth > 0)) return null;
  return { priceEth, fee: p.fee, tickSpacing: p.tickSpacing, quote: p.quote, liquidity: p.liquidity, poolId: p.id };
}

const enabled = (chainKey) => !!cfg(chainKey);

// ─────────────────────────────── swapping ───────────────────────────────────
//
// v4 has no router of its own. A swap goes through the Universal Router as one
// V4_SWAP command whose payload is a list of ACTIONS: do the swap, settle what
// you owe, take what you're due. The encoding below is that list.
//
// Every constant here is env-overridable. They are Uniswap's published values,
// but this bot has already been burned once by a canonical address that did not
// match a fork (the V3 quoter on Robinhood Chain), and an action byte that a
// deployment numbers differently would build a transaction that does something
// other than what it says. Overridable beats a redeploy when that happens.
const CMD_V4_SWAP = '0x10';
const ACT_SWAP_EXACT_IN_SINGLE = '06';
const ACT_SETTLE_ALL = '0c';
const ACT_TAKE_ALL = '0f';

const UR_ABI = ['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'];
const PERMIT2_ABI = [
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
];

// Permit2 is not a per-deployment address the way a router is. It is deployed
// through the deterministic CREATE2 factory from a fixed salt and fixed
// bytecode, so the SAME address on every EVM chain that has one at all — a
// derived constant, not a guess. Still verified before use: permit2Calls checks
// there is code there, because "most chains" is not "this chain".
const CANONICAL_PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/** Router config for a chain, or null. Separate from cfg(): reading v4 prices
 *  needs only the PoolManager, and a chain may have one without the other.
 *
 *  `routerOverride` carries a DISCOVERED router (routerCandidates) through the
 *  same action/command env parsing an operator-set one gets. */
function routerCfg(chainKey, routerOverride) {
  const P = String(chainKey).toUpperCase();
  const router = _isAddr(routerOverride) ? routerOverride : _env(`${P}_V4_UNIVERSAL_ROUTER`);
  if (!_isAddr(router)) return null;
  const permit2 = _env(`${P}_V4_PERMIT2`);
  const actions = _env(`${P}_V4_ACTIONS`);   // "06,0c,0f" — swap,settle,take
  const [a0, a1, a2] = actions ? actions.split(',').map((s) => s.trim().replace(/^0x/, '')) : [];
  return {
    router,
    // An operator-set Permit2 wins; otherwise the canonical one, which
    // permit2Calls only uses after confirming code lives at it.
    permit2: _isAddr(permit2) ? permit2 : CANONICAL_PERMIT2,
    // Whether the operator vouched for this router or we observed it. It decides
    // how much the Permit2 allowance is worth: see permit2Calls.
    trusted: !_isAddr(routerOverride),
    command: _env(`${P}_V4_COMMAND`) || CMD_V4_SWAP,
    swap: a0 || ACT_SWAP_EXACT_IN_SINGLE,
    settle: a1 || ACT_SETTLE_ALL,
    take: a2 || ACT_TAKE_ALL,
  };
}

const canSwap = (chainKey) => !!(cfg(chainKey) && routerCfg(chainKey));

/**
 * canSwap(), but allowed to go and look.
 *
 * The sync one answers from env alone and is what a fast UI path wants; this
 * one is the honest answer to "could a Buy button on this card actually fill?"
 * and is worth the round trips a card render can afford.
 */
async function canSwapLive(ca, chainKey, deps) {
  if (canSwap(chainKey)) return true;
  const c = await cfgLive(chainKey, ca, deps).catch(() => null);
  if (!c) return false;
  const cands = await routerCandidates(chainKey, c, deps).catch(() => []);
  return cands.length > 0;
}

/**
 * Calldata for one exact-input v4 swap.
 *
 * `pool` is what bestPool() returned, so the PoolKey is the one whose id was
 * actually found on-chain — never rebuilt from assumptions here.
 */
function swapCalldata(chainKey, pool, { tokenIn, amountIn, minOut, deadline, router }) {
  const rc = routerCfg(chainKey, router);
  if (!rc) return null;
  const { currency0, currency1 } = pool;
  const zeroForOne = String(tokenIn).toLowerCase() === String(currency0).toLowerCase();
  const currencyIn = zeroForOne ? currency0 : currency1;
  const currencyOut = zeroForOne ? currency1 : currency0;
  const poolKey = [currency0, currency1, pool.fee, pool.tickSpacing, pool.hooks || NATIVE];

  const actions = '0x' + rc.swap + rc.settle + rc.take;
  const params = [
    coder.encode(
      ['tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,bytes)'],
      [[poolKey, zeroForOne, amountIn, minOut, '0x']],
    ),
    coder.encode(['address', 'uint256'], [currencyIn, amountIn]),     // SETTLE_ALL — what we owe
    coder.encode(['address', 'uint256'], [currencyOut, minOut]),      // TAKE_ALL — the floor we accept
  ];
  const input = coder.encode(['bytes', 'bytes[]'], [actions, params]);
  const data = new ethers.Interface(UR_ABI).encodeFunctionData('execute', [rc.command, [input], deadline]);
  // Native in is paid as msg.value; an ERC20 in is pulled through Permit2 and
  // the call carries nothing.
  return { to: rc.router, data, value: currencyIn === NATIVE ? BigInt(amountIn) : 0n, currencyIn, currencyOut, zeroForOne, trusted: rc.trusted };
}

/**
 * Simulate the swap before anything is signed.
 *
 * This is the safety rail the whole feature rests on. The action bytes and the
 * parameter layout are the parts most likely to be wrong for a given
 * deployment, and a wrong encoding must cost a REFUSED trade, never a sent one.
 * eth_call it first: it reverts on a bad encoding exactly as the real send
 * would, for no gas and no funds.
 */
async function simulate(provider, from, call) {
  try {
    await provider.call({ to: call.to, data: call.data, value: call.value, from });
    return { ok: true };
  } catch (e) {
    return { ok: false, err: (e && (e.shortMessage || e.reason || e.message)) || String(e) };
  }
}

/**
 * Build the swap, then ELECT the router that can actually fill it.
 *
 * This is where an observed address earns the right to be sent money. Every
 * candidate gets the exact calldata we intend to sign, run as an eth_call from
 * the user's own address: a contract that is not a Universal Router — a
 * position manager, an aggregator, something that merely once touched the
 * PoolManager — reverts on `execute(bytes,bytes[],uint256)` and is dropped for
 * free. The first that returns cleanly is the one that gets the transaction,
 * and it has by then already executed this trade in simulation.
 *
 * Returns { call, router } or { err } — never a throw, and never a call that
 * has not simulated.
 */
async function prepareSwap(provider, chainKey, pool, from, opts, deps) {
  // The TOKEN, not tokenIn: on a buy tokenIn is native, and discovering a
  // PoolManager from address(0) finds nothing and then caches that nothing for
  // the whole chain. `pool` came from bestPool, so this is a cache hit anyway —
  // it just has to be a hit on the right key.
  const token = String(pool.tokenIsZero ? pool.currency0 : pool.currency1);
  const c = deps && deps.providerFor ? await cfgLive(chainKey, token, deps).catch(() => null) : cfg(chainKey);
  const cands = c ? await routerCandidates(chainKey, c, deps || {}).catch(() => []) : [];
  const list = cands.length ? cands : (routerCfg(chainKey) ? [routerCfg(chainKey).router] : []);
  if (!list.length) return { err: 'no Uniswap v4 router is configured or discoverable on this chain' };
  let lastErr = 'the v4 swap would revert';
  for (const router of list) {
    const call = swapCalldata(chainKey, pool, { ...opts, router });
    if (!call) continue;
    const sim = await simulate(provider, from, call);
    if (sim.ok) { electRouter(chainKey, router); return { call, router }; }
    lastErr = sim.err || lastErr;
  }
  return { err: lastErr, tried: list };
}

/** Permit2 allowance top-up, when selling an ERC20 into a v4 pool. Returns the
 *  calls that still need sending, in order — empty when nothing is needed, and
 *  null when this sell must be REFUSED rather than attempted.
 *
 *  `router` names a discovered router when one was elected; without it the
 *  env-configured one is used. */
async function permit2Calls(provider, chainKey, token, owner, amount, router) {
  const rc = routerCfg(chainKey, router);
  if (!rc || !rc.permit2) return null;   // not configured → caller must refuse the sell
  // The canonical Permit2 is the same address on every chain that has one —
  // which is not every chain. Approving a token to an address with no code
  // there would burn a transaction and then leave the sell to revert anyway, so
  // the existence check is part of the decision, not a nicety. A provider that
  // cannot answer it is also a no: an unverifiable spender on the exit path is
  // exactly the thing not to take on faith.
  try {
    const code = await provider.getCode(rc.permit2);
    if (!code || code === '0x') return null;
  } catch (_) { return null; }
  const out = [];
  const erc20 = new ethers.Contract(token, ['function allowance(address,address) view returns (uint256)'], provider);
  const cur = await erc20.allowance(owner, rc.permit2).catch(() => 0n);
  if (BigInt(cur) < BigInt(amount)) {
    out.push({
      to: token,
      data: new ethers.Interface(['function approve(address,uint256)']).encodeFunctionData('approve', [rc.permit2, ethers.MaxUint256]),
      what: 'approve Permit2',
    });
  }
  const p2 = new ethers.Contract(rc.permit2, PERMIT2_ABI, provider);
  let have = 0n, exp = 0;
  try { const a = await p2.allowance(owner, token, rc.router); have = BigInt(a[0]); exp = Number(a[1]); } catch (_) {}
  const now = Math.floor(Date.now() / 1000);
  if (have < BigInt(amount) || exp <= now) {
    const MAX160 = (1n << 160n) - 1n;
    const EXPIRY = now + 30 * 24 * 3600;
    // AN OPERATOR-SET ROUTER GETS A STANDING ALLOWANCE; A DISCOVERED ONE GETS
    // THIS SELL AND NOTHING MORE. The swap itself is protected by simulation and
    // by minOut, but a Permit2 allowance outlives the trade — it is a standing
    // right to move this token out of the wallet. An address nobody vouched for
    // does not get one, and the few thousand gas a per-sell approval costs is
    // the cheapest insurance in this file.
    const allow = rc.trusted ? MAX160 : BigInt(amount);
    out.push({
      to: rc.permit2,
      data: new ethers.Interface(PERMIT2_ABI).encodeFunctionData('approve', [token, rc.router, allow, EXPIRY]),
      what: 'approve the router through Permit2',
    });
  }
  return out;
}

module.exports = {
  cfg, cfgLive, enabled, poolId, orderCurrencies, poolState, bestPool, price, priceNativeFromSqrt, tradePoolKeys,
  quoteExactIn, discoverPoolManager, discoverPoolKeys, routerCandidates, electRouter, demoteRouter,
  routerCfg, canSwap, canSwapLive, swapCalldata, simulate, prepareSwap, permit2Calls,
  // Whether this chain may DISCOVER its v4 deployment, as opposed to having one
  // pinned in env. The boot log needs the difference: unset env is not "no v4".
  autoOk: _autoOk,
  NATIVE, DEFAULT_TIERS, DEFAULT_POOLS_SLOT, CMD_V4_SWAP, CANONICAL_PERMIT2,
  INITIALIZE_EVENT, INITIALIZE_TOPIC, SWAP_TOPIC,
  _resetDiscovery,
};
