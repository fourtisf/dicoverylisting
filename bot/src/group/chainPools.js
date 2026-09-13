// Finding a token's pool STRAIGHT FROM THE CHAIN, with no indexer in front.
//
// WHY THIS EXISTS
// /settoken could only ever find a pool by asking GeckoTerminal, with a
// DexScreener second opinion that does not cover every chain. So a real pool
// with real trades in it — $415 of liquidity on Robinhood Chain, say — was
// invisible, and the group was told "No live pool on that CA" about a pool
// that plainly exists. The token was not missing. The INDEXER's knowledge of it
// was, and an indexer's coverage is a business decision about which tokens are
// worth indexing, taken by somebody else, about our customers.
//
// The chain has no such opinion.
//
// HOW: BY TOPIC, NEVER BY FACTORY ADDRESS.
// Every Uniswap-shaped factory announces a new pool with the two tokens as
// INDEXED parameters. Indexed parameters are topics, and topics are searchable
// without naming the contract that emitted them — so one eth_getLogs filtered
// on "this token, in either position" finds the pool no matter which factory
// made it. That is what makes this work on a fork nobody has written a registry
// entry for, on a chain that launched last week. A factory registry would have
// to be researched, hand-entered and maintained per chain, and every gap in it
// would look exactly like the bug this replaces.
//
// THIS IS A FALLBACK, NOT A REPLACEMENT. The indexer is asked first: it is one
// cheap request and it carries the price and market cap that this cannot.
const { rpcRead } = require("../config/rpc");
const { chainOf } = require("../config/chains");
const log = require("../helpers/logger");

const TIMEOUT_MS = 9000;
const BUDGET_MS = 20000;
// The whole search, per chain. /settoken probes five chains for a 0x address,
// so an address that exists nowhere must not leave an operator staring at a
// spinner: five chains × this is the worst case a wrong paste can cost.
const DEADLINE_MS = 12000;
// A stepped walk's ceiling. A chain that refuses wide ranges is walked
// backwards from the head, and this bounds what one miss can spend.
const SCAN_STEP = 9000; // the common public-RPC eth_getLogs range cap
const SCAN_MAX_REQUESTS = 40;
// More pools than this and we are looking at a token whose liquidity is
// scattered across so many venues that picking one is guesswork anyway.
const MAX_CANDIDATES = 12;

// ── the creation events ──────────────────────────────────────────────────────
//
// V2 and V3 put the two tokens in the SAME topic positions (1 and 2), so one
// query covers both. V4 does not — its topic 1 is the poolId — so it needs its
// own. Getting a position wrong does not throw: getLogs returns nothing and the
// token reads as one with no pool, which is precisely the bug being fixed.
const V2_CREATED = "PairCreated(address,address,address,uint256)";
const V3_CREATED = "PoolCreated(address,address,uint24,int24,address)";
const V4_INIT = "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)";

const CREATION = {
  v2: {
    sig: V2_CREATED,
    abi: "event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)",
    tokenTopics: [1, 2],
    // The pool is an ADDRESS in the data — the thing chainTrades can getLogs on.
    poolFrom: (parsed) => String(parsed.args[2]),
  },
  v3: {
    sig: V3_CREATED,
    abi: "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
    tokenTopics: [1, 2],
    poolFrom: (parsed) => String(parsed.args[4]),
  },
  v4: {
    sig: V4_INIT,
    abi: "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
    // topic 1 is the poolId, so the currencies sit one place further along.
    tokenTopics: [2, 3],
    // There IS no pool address: a v4 pool is a mapping entry inside one
    // PoolManager, and its identity is that bytes32. chainTrades reads swaps
    // with getLogs({address: pool}), which a bytes32 cannot satisfy — so this
    // is reported and deliberately NOT configured. See findPool.
    poolFrom: (parsed) => String(parsed.args[0]),
  },
};

let ethersMod = null;
function ethersLib() {
  if (ethersMod === null) {
    try {
      ethersMod = require("ethers").ethers;
    } catch {
      ethersMod = false;
    }
  }
  return ethersMod || null;
}

// Built on first use, never at module scope: ethers is an optional dependency
// here and a top-level ethers.id() would crash the bot on a box without it.
let ifaces = null;
function creationIfaces(ethers) {
  if (!ifaces) {
    ifaces = {};
    for (const [kind, c] of Object.entries(CREATION)) {
      ifaces[kind] = { ...c, topic0: ethers.id(c.sig), iface: new ethers.Interface([c.abi]) };
    }
  }
  return ifaces;
}

const providers = new Map();
function evmProvider(ethers, url) {
  if (!providers.has(url)) providers.set(url, new ethers.JsonRpcProvider(url));
  return providers.get(url);
}
function dropEndpoint(url) {
  const p = providers.get(url);
  providers.delete(url);
  try {
    p?.destroy?.();
  } catch {
    /* best effort — the point is to stop the retry loop, not to succeed at it */
  }
}

const supports = (chain) => (chainOf(chain) || {}).family === "evm";

// ── cache ────────────────────────────────────────────────────────────────────
//
// A full-history log sweep is the most expensive read in this file, so every
// answer is kept — including the misses, which are the expensive ones. The two
// kinds of miss are NOT the same fact and must not share a TTL: a token with no
// pool YET may have one in a minute, but a chain that refuses log queries
// outright will still refuse them this afternoon, and re-sweeping it for every
// token nothing else could resolve is how a bot rate-limits itself off its own
// RPC. (The same argument, and the same shape, as tradebot/v4.js's discovery.)
const HIT_TTL_MS = 6 * 3600 * 1000;
const MISS_TTL_MS = 5 * 60 * 1000;
const CHAIN_MISS_TTL_MS = 6 * 3600 * 1000;
const cache = new Map(); // key → { at, val, ttl }
function cached(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key);
    return undefined;
  }
  return hit.val;
}
function remember(key, val, ttl) {
  cache.set(key, { at: Date.now(), val, ttl: ttl || (val ? HIT_TTL_MS : MISS_TTL_MS) });
  return val;
}

/**
 * One eth_getLogs over the whole chain, the cheap way first.
 *
 * A topic-narrow filter (an indexed address pins it to a handful of logs) is a
 * single round trip and most nodes answer it happily. Nodes with a hard range
 * cap throw, and only THEN is the stepped walk paid for — doing it the other
 * way round costs dozens of requests on every chain that never needed them.
 *
 * Never throws. Discovery failing has to look like "found nothing", because the
 * caller's next move is the same either way.
 */
async function sweep(provider, topics, head, deadline) {
  try {
    return await provider.getLogs({ topics, fromBlock: 0, toBlock: head });
  } catch {
    /* a range cap, almost certainly — walk it */
  }
  const out = [];
  let to = head;
  for (let i = 0; i < SCAN_MAX_REQUESTS && to > 0; i++) {
    if (Date.now() > deadline) break;
    const from = Math.max(0, to - SCAN_STEP);
    try {
      const logs = await provider.getLogs({ topics, fromBlock: from, toBlock: to });
      // Newest first: a pool created recently — which is every token this
      // exists for — is found in the first step or two, and the walk stops.
      if (logs.length) out.push(...logs);
      if (out.length) break;
    } catch {
      /* one bad window is not a failed sweep */
    }
    if (from === 0) break;
    to = from - 1;
  }
  return out;
}

const topicOf = (ethers, addr) => ethers.zeroPadValue(String(addr).toLowerCase(), 32);

/**
 * Every pool this chain knows of for `token`.
 *
 * Four queries: V2+V3 with the token in either token position (they share
 * those positions), then V4 in either currency position.
 */
async function discover(ethers, provider, token, head, deadline) {
  const I = creationIfaces(ethers);
  const t = topicOf(ethers, token);
  const jobs = [
    { kinds: ["v2", "v3"], topics: [[I.v2.topic0, I.v3.topic0], t] },
    { kinds: ["v2", "v3"], topics: [[I.v2.topic0, I.v3.topic0], null, t] },
    { kinds: ["v4"], topics: [I.v4.topic0, null, t] },
    { kinds: ["v4"], topics: [I.v4.topic0, null, null, t] },
  ];
  const found = [];
  for (const job of jobs) {
    if (Date.now() > deadline) break;
    const logs = await sweep(provider, job.topics, head, deadline);
    for (const l of logs) {
      const kind = job.kinds.find((k) => I[k].topic0 === l.topics[0]);
      if (!kind) continue;
      try {
        const parsed = I[kind].iface.parseLog(l);
        if (!parsed) continue;
        const pool = I[kind].poolFrom(parsed);
        // Which side is ours decides which side is the counter — the thing the
        // "(0.42 ETH)" suffix and any chain-side pricing needs.
        const a = String(parsed.args[kind === "v4" ? 1 : 0]).toLowerCase();
        const b = String(parsed.args[kind === "v4" ? 2 : 1]).toLowerCase();
        const mine = String(token).toLowerCase();
        if (a !== mine && b !== mine) continue; // a topic collision, not our token
        found.push({ kind, poolAddress: pool, counterAddress: a === mine ? b : a, block: Number(l.blockNumber) || 0 });
      } catch {
        /* a log we cannot parse is not a pool we can offer */
      }
      if (found.length >= MAX_CANDIDATES) break;
    }
  }
  return found;
}

/**
 * Of several pools, the one a buy bot should watch.
 *
 * Ranked by how much of the TOKEN each pool actually holds — one balanceOf per
 * candidate, which is the cheapest honest measure of "where the trading is".
 * It is a proxy and it can be wrong: a pool holding a large amount of a token
 * priced at nothing is not deep. It beats the alternatives, which are picking
 * the newest (a fresh dust pool wins over the real one) or picking the first
 * the node happened to return (arbitrary).
 *
 * A balance that cannot be read scores zero rather than failing the search —
 * one unreadable candidate must not cost the operator the pool.
 */
async function rankByDepth(ethers, provider, token, candidates) {
  if (candidates.length <= 1) return candidates;
  const erc20 = new ethers.Contract(token, ["function balanceOf(address) view returns (uint256)"], provider);
  const scored = [];
  for (const c of candidates) {
    let held = 0n;
    try {
      held = BigInt(await erc20.balanceOf(c.poolAddress));
    } catch {
      /* unreadable — scores zero, still a candidate */
    }
    scored.push({ ...c, held });
  }
  scored.sort((x, y) => (y.held > x.held ? 1 : y.held < x.held ? -1 : 0));
  return scored;
}

/**
 * The pool to watch for `token` on `chain`, or null.
 *
 * Returns { poolAddress, counterAddress, kind, viaChain: true }.
 *
 * A v4-only token resolves to NULL, deliberately, and says so in the log. Its
 * pool is a mapping entry inside a PoolManager identified by a bytes32, and
 * chainTrades reads swaps with getLogs({address: pool}) — handing it a bytes32
 * would configure a group whose alerts could never work, which is worse than
 * telling the operator we could not place the token.
 */
async function findPool(chain, token) {
  if (!supports(chain) || !token) return null;
  const key = `${chain}:${String(token).toLowerCase()}`;
  const hit = cached(key);
  if (hit !== undefined) return hit;

  const ethers = ethersLib();
  if (!ethers) return null;
  const deadline = Date.now() + DEADLINE_MS;
  let res;
  try {
    res = await rpcRead(
      chain,
      async (url) => {
        const provider = evmProvider(ethers, url);
        const head = await provider.getBlockNumber();
        const found = await discover(ethers, provider, token, head, deadline);
        if (!found.length) return { pools: [] };
        const ranked = await rankByDepth(
          ethers,
          provider,
          token,
          found.filter((f) => f.kind !== "v4"),
        );
        return { pools: ranked, v4: found.filter((f) => f.kind === "v4").length };
      },
      { timeoutMs: TIMEOUT_MS, budgetMs: BUDGET_MS, onFail: dropEndpoint },
    );
  } catch (e) {
    // Every endpoint refused. That is a fact about the CHAIN, not the token —
    // and re-sweeping it for the next token would refuse just as fast.
    log.debug(`[chainpools] ${chain}: sweep unavailable (${e && e.message})`);
    return remember(`chain:${chain}`, null, CHAIN_MISS_TTL_MS) && null;
  }
  const { pools, v4 } = res.value || { pools: [], v4: 0 };
  if (!pools.length) {
    if (v4) {
      // Worth a line: the operator's token is real, it has a pool, and we are
      // declining it for a reason they cannot see from the chat.
      log.warn(
        `[chainpools] ${chain}/${token}: found ${v4} Uniswap v4 pool(s) and no v2/v3 pool — ` +
          `v4 pools have no address to watch, so this token cannot be configured yet`,
      );
    }
    return remember(key, null);
  }
  const best = pools[0];
  log.info(
    `[chainpools] ${chain}/${token}: pool ${best.poolAddress} (${best.kind}, counter ${best.counterAddress})` +
      `${pools.length > 1 ? ` — deepest of ${pools.length}` : ""}`,
  );
  return remember(key, { poolAddress: best.poolAddress, counterAddress: best.counterAddress, kind: best.kind, viaChain: true });
}

// ── Reading a pool the indexers do not price ─────────────────────────────────
//
// Finding the pool is only half the job. buyMonitor will not post a buy it
// cannot put a dollar figure on — it HOLDS it, deliberately, so the next poll
// can price it — and the price comes from the same indexer that did not know
// the token existed. So a token rescued by the discovery above would configure
// cleanly, read its buys perfectly, and then sit silent forever, which is a
// worse failure than the honest "No live pool on that CA" it replaced.
//
// The chain knows the price. It is the ratio of what is in the pool.
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];
const V2_POOL_ABI = ["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)"];
const V3_POOL_ABI = ["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)", "function token0() view returns (address)"];

// Counter tokens whose USD value is 1 by construction. Symbol-matched rather
// than address-matched on purpose: an address registry would need an entry per
// stablecoin per chain, and the chains this exists for are exactly the ones
// nobody has written that registry for.
const STABLES = new Set(["USDT", "USDC", "USDBC", "DAI", "BUSD", "FDUSD", "TUSD", "USDE", "USD₮0"]);

/** The USD value of one unit of the pool's counter token, or null when we
 *  cannot say. Null is the honest answer and it costs the caller nothing — the
 *  indexer path is still there. A GUESS here would misprice every alert. */
async function counterUsd(chain, symbol) {
  const s = String(symbol || "").toUpperCase();
  if (STABLES.has(s)) return 1;
  const native = String((chainOf(chain) || {}).native || "").toUpperCase();
  // "WETH" on a chain whose native is ETH, and plain "ETH" too.
  if (native && (s === native || s === `W${native}`)) {
    const px = await require("../nativeprice").usdPrices().catch(() => ({}));
    const v = px && px[native];
    return v > 0 ? v : null;
  }
  return null;
}

/**
 * Price a pool from its own contents.
 *
 * V2 keeps both sides as reserves, so the price is their ratio. V3 keeps a
 * sqrtPriceX96 in slot0 instead, because its liquidity is concentrated and the
 * balances are NOT the price — reading a V3 pool's balances as a ratio is a
 * plausible-looking number that is simply wrong. Which one a pool is, is
 * decided by asking: getReserves() reverts on a V3 pool and slot0() reverts on
 * a V2 one.
 *
 * Returns the shape gtPairs.fetchPoolCached returns, so buyMonitor cannot tell
 * the difference — minus what the chain genuinely does not know. `change24h`
 * has no on-chain answer at all and stays null rather than becoming a zero that
 * would render as a confident "0%".
 */
async function readPool(chain, poolAddress, token) {
  if (!supports(chain) || !poolAddress || !token) return null;
  const ethers = ethersLib();
  if (!ethers) return null;
  let out = null;
  try {
    const res = await rpcRead(
      chain,
      async (url) => {
        const provider = evmProvider(ethers, url);
        const v2 = new ethers.Contract(poolAddress, V2_POOL_ABI, provider);
        const tok0 = String(await v2.token0()).toLowerCase();
        const tokenIsZero = tok0 === String(token).toLowerCase();

        let tokenAmt = null;
        let counterAmt = null;
        let counter = null;
        let sqrt = null;
        try {
          const r = await v2.getReserves();
          const r0 = BigInt(r[0]);
          const r1 = BigInt(r[1]);
          tokenAmt = tokenIsZero ? r0 : r1;
          counterAmt = tokenIsZero ? r1 : r0;
        } catch {
          const v3 = new ethers.Contract(poolAddress, V3_POOL_ABI, provider);
          sqrt = BigInt((await v3.slot0())[0]);
        }
        // The counter token's identity comes from the pool, never from a
        // caller-supplied guess — the pool is the only thing that knows.
        const pairAbi = ["function token0() view returns (address)", "function token1() view returns (address)"];
        const pair = new ethers.Contract(poolAddress, pairAbi, provider);
        counter = String(tokenIsZero ? await pair.token1() : await pair.token0());

        const tokenC = new ethers.Contract(token, ERC20_ABI, provider);
        const counterC = new ethers.Contract(counter, ERC20_ABI, provider);
        const [tDec, cDec, cSym] = await Promise.all([
          tokenC.decimals().then(Number),
          counterC.decimals().then(Number),
          counterC.symbol().catch(() => ""),
        ]);
        const anchor = await counterUsd(chain, cSym);
        if (!(anchor > 0)) return { unpriceable: true, counterAddress: counter };

        // All of it in floats only AFTER the integer maths, so a 6-decimal
        // counter against an 18-decimal token cannot lose a factor of 10^12.
        let priceUsd = null;
        let liquidity = null;
        if (sqrt !== null) {
          // (sqrtPriceX96 / 2^96)^2 is token1-per-token0, in raw units.
          const num = Number(sqrt) / 2 ** 96;
          const raw = num * num; // token1 per token0
          const t1PerT0 = raw * 10 ** (tokenIsZero ? tDec - cDec : cDec - tDec);
          priceUsd = (tokenIsZero ? t1PerT0 : 1 / t1PerT0) * anchor;
        } else {
          const tokenF = Number(ethers.formatUnits(tokenAmt, tDec));
          const counterF = Number(ethers.formatUnits(counterAmt, cDec));
          if (!(tokenF > 0)) return { unpriceable: true, counterAddress: counter };
          priceUsd = (counterF / tokenF) * anchor;
          // Both sides of a constant-product pool are worth the same, so the
          // counter side doubled IS the pool's depth. No such shortcut exists
          // for V3, which is why liquidity stays null there rather than being
          // invented.
          liquidity = counterF * anchor * 2;
        }
        if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) return { unpriceable: true, counterAddress: counter };

        // FDV, and it is named honestly in the code even though the card says
        // "MC": totalSupply is every token that exists, which for the tokens
        // this path rescues — young, fully-circulating memecoins — is the same
        // number. A token with vesting would read high here. Best-effort: a
        // missing supply costs the row, never the alert.
        let mcap = null;
        try {
          const supply = Number(ethers.formatUnits(await tokenC.totalSupply(), tDec));
          if (supply > 0) mcap = supply * priceUsd;
        } catch {
          /* the row renders "—" */
        }
        return { priceUsd, mcap, liquidity, counterAddress: counter, change24h: null, poolAddress, viaChain: true };
      },
      { timeoutMs: TIMEOUT_MS, budgetMs: BUDGET_MS, onFail: dropEndpoint },
    );
    out = res.value;
  } catch (e) {
    log.debug(`[chainpools] ${chain}/${poolAddress}: price unreadable (${e && e.message})`);
    return null;
  }
  if (!out || out.unpriceable) {
    // A pool quoted in something we cannot value — a token/token pair. Saying
    // so once beats a group wondering why alerts stopped.
    if (out && out.unpriceable) {
      log.debug(`[chainpools] ${chain}/${poolAddress}: counter token has no USD anchor`);
    }
    return null;
  }
  return out;
}

/** symbol / name straight from the token contract. The indexer that has never
 *  heard of this token cannot supply them either, and without them every alert
 *  headlines the "$TOKEN" placeholder. */
async function tokenMeta(chain, token) {
  if (!supports(chain) || !token) return null;
  const ethers = ethersLib();
  if (!ethers) return null;
  try {
    const { value } = await rpcRead(
      chain,
      async (url) => {
        const c = new ethers.Contract(token, ERC20_ABI, evmProvider(ethers, url));
        const [symbol, name] = await Promise.all([c.symbol().catch(() => ""), c.name().catch(() => "")]);
        return { symbol: String(symbol || "").slice(0, 20), name: String(name || "").slice(0, 60) };
      },
      { timeoutMs: TIMEOUT_MS, budgetMs: BUDGET_MS, onFail: dropEndpoint },
    );
    return value;
  } catch {
    return null;
  }
}

module.exports = {
  findPool,
  readPool,
  tokenMeta,
  counterUsd,
  supports,
  CREATION,
  V2_CREATED,
  V3_CREATED,
  V4_INIT,
  creationIfaces,
  _reset: () => {
    cache.clear();
    providers.clear();
    ifaces = null;
  },
};
