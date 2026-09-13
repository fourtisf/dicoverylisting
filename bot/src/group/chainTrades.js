// Per-transaction buys read STRAIGHT FROM THE CHAIN, with no indexer in front.
//
// WHY THIS EXISTS
// The buy bot read its trades from GeckoTerminal, and GeckoTerminal refuses
// this server. Not by volume — a diagnostic run tracking ONE pool, needing 2.4
// requests a minute against a 25/minute budget, was 429'd on its second call
// from a fresh process. That is an IP-level refusal, standard for datacenter
// ranges, and no amount of pacing or prioritising can argue with it. DexScreener
// answers the same server fine, which is why prices kept working while every
// group went silent.
//
// So this reads the swaps itself. The chain is the source that cannot rate-limit
// us out of our own product, it is free, and it is the only feed that is
// genuinely realtime rather than realtime-once-an-index-catches-up.
//
// THE RETURN CONTRACT IS gtTrades.fetchPoolBuys's, deliberately, so the caller
// can try one and fall back to the other:
//
//   null  unreadable — every endpoint failed, or the pool's shape is not one we
//         decode. The caller must NOT read this as "no buys".
//   []    read fine, nothing new.
//
// USD is not on the chain. Amounts here are exact; the dollar figure is the
// pool's own price applied to them, passed in by the caller, so it agrees with
// the price printed on the same card.
const { rpcRead } = require("../config/rpc");
const { chainOf } = require("../config/chains");
const log = require("../helpers/logger");

const TIMEOUT_MS = 9000;
const BUDGET_MS = 20000;
// A HARD CEILING ON THE WHOLE READ. The first cut had none, and it cost the
// thing it was built to fix: a poll fetched up to forty transactions ONE AT A
// TIME from a public Solana node, so a cycle that should take 25 seconds took
// six MINUTES — and then fell back to the indexer anyway. A reader that makes
// the bot slower than the feed it replaced is worse than no reader.
const DEADLINE_MS = 12000;
// How many transaction reads are in flight at once. Sequential is what made the
// poll take minutes; unbounded is how a free RPC key answers 429 to everything.
const CONCURRENCY = 6;
// Anything older than this is not news and buyMonitor drops it anyway
// (MAX_ALERT_AGE_MS). Filtering here, on the block time the signature listing
// already carries, is the difference between spending a getTransaction on it
// and not.
const MAX_AGE_MS = 30 * 60 * 1000;
// A poll that finds more than this is a pool we have fallen far behind on —
// buyMonitor caps what it will post anyway (MAX_PER_POLL), and reading a
// thousand transactions to throw away 992 of them is how a free RPC key gets
// spent by lunchtime.
//
// ⚠️ AND IT IS THE BIGGEST SINGLE NUMBER IN THIS BOT'S SOLANA BILL, so it is a
// knob rather than a constant. Measured: one tracked Solana pool costs
// `1 + MAX_TX` requests every `BUYBOT_POOL_MIN_MS` — at the shipped 40 and 25s
// that is up to 41 requests per pool per 25s, ~142,000 a DAY per pool, and
// `getTransaction` is one of the heavier methods a provider meters. The whole
// TRADE bot spends on the order of 1,500 a day, so this reader outweighs it by
// three orders of magnitude: "we are on a paid key and still hitting the limit"
// is answered here, not there.
//
// LOWERING IT COSTS COVERAGE, NOT CORRECTNESS. The window is sorted NEWEST
// first before the slice, so a smaller cap drops the OLDEST buys of a busy
// poll — an alert that was going to be minutes stale anyway. That is a
// trade-off for whoever pays the bill, which is exactly why it is an env var.
const MAX_TX = Math.max(4, Math.min(200, Number(process.env.BUYBOT_MAX_TX) || 40));
// How far back a FIRST sight looks. buyMonitor applies its own first-sight
// window on top; this only bounds the work.
const FIRST_SIGHT_BLOCKS = 500;
const FIRST_SIGHT_SIGS = 25;
/**
 * THE WIDEST eth_getLogs WINDOW WE WILL ASK FOR.
 *
 * Without this a quiet pool destroys itself. buyMonitor only advances the
 * cursor when a poll actually finds buys, so on a pool nobody is trading the
 * window grows by one poll interval, every poll, forever — until it passes
 * whatever the node allows (5000 blocks on the public BSC dataseeds) and the
 * node refuses it. That refusal is NOT a transport error, so rpcRead rethrows
 * on the first endpoint instead of walking the rest, fetchPoolBuys returns
 * null, and the pool falls onto the indexer permanently. Cursors are persisted,
 * so it survives every restart: a pool that goes quiet for long enough never
 * reads the chain again.
 *
 * The floor is set by what buyMonitor can still POST — MAX_ALERT_AGE_MS is 30
 * minutes, so the window only has to outlast that. 3000 blocks is ~37min on
 * BSC (0.75s), ~100min on Base, ~10h on Ethereum: past the age filter on every
 * chain we read, and under the caps the free endpoints enforce.
 */
const MAX_LOG_RANGE = Math.max(200, Number(process.env.CHAINTRADES_MAX_LOG_RANGE) || 3000);
// A node refusing a window says so in its own words, and it is deliberately NOT
// in rpc.js's TRANSPORT_RE: asking three more endpoints the same oversized
// question just fails four times instead of once. Shrink and re-ask the SAME
// node instead.
const RANGE_RE =
  /exceed[sd]? maximum block range|block range too large|query returned more than|response size exceeded|limit exceeded|too many blocks|range is too large/i;

// ── lazy libs ────────────────────────────────────────────────────────────────
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
let solMod = null;
function solLib() {
  if (solMod === null) {
    try {
      solMod = require("@solana/web3.js");
    } catch {
      solMod = false;
    }
  }
  return solMod || null;
}

// One provider/connection per ENDPOINT, reused. Same reasoning as
// walletHoldings: a fresh one per poll opens a socket per poll, and an
// unreachable node then leaves a pile of them retrying forever — enough to hold
// the event loop open on its own.
const providers = new Map();
function evmProvider(ethers, url) {
  if (!providers.has(url)) providers.set(url, new ethers.JsonRpcProvider(url));
  return providers.get(url);
}
const connections = new Map();
function solConnection(web3, url) {
  if (!connections.has(url)) connections.set(url, new web3.Connection(url, "confirmed"));
  return connections.get(url);
}
function dropEndpoint(url) {
  const p = providers.get(url);
  providers.delete(url);
  connections.delete(url);
  try {
    p?.destroy?.();
  } catch {
    /* best effort — the point is to stop the retry loop, not to succeed at it */
  }
}

// config/chains describes a chain by `family`, not by a chainId/kind pair — the
// shape this first assumed. Guessing it wrong is silent: supports() returns
// false for every chain and the reader is never called at all, which looks
// exactly like the reader not working.
/**
 * Map with bounded concurrency and a deadline.
 *
 * Returns what finished in time. A partial read is fine here — the cursor only
 * advances past what was actually posted, so anything missed is picked up on
 * the next poll. Blocking the whole poll waiting for the tail is not.
 */
async function mapBounded(items, fn, { limit = CONCURRENCY, deadline }) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      if (deadline && Date.now() > deadline) return;
      const item = items[i++];
      try {
        const r = await fn(item);
        if (r) out.push(r);
      } catch {
        /* one unreadable transaction is not a failed poll */
      }
    }
  });
  await Promise.all(workers);
  return out;
}

const isEvm = (chain) => (chainOf(chain) || {}).family === "evm";
const isSvm = (chain) => (chainOf(chain) || {}).family === "solana";

/** Does this chain have a reader at all? Callers use it to decide whether the
 *  chain path is even worth trying before falling back to an indexer. */
const supports = (chain) => isEvm(chain) || isSvm(chain);

// ── EVM ──────────────────────────────────────────────────────────────────────
//
// Uniswap V2 and V3 pools emit different Swap events and the difference is not
// cosmetic: V2 gives four UNSIGNED amounts (in0,in1,out0,out1) and V3 gives two
// SIGNED ones, where negative means "left the pool", i.e. went to the trader.
// Reading a V3 log with V2's shape does not fail, it silently reports the wrong
// direction — which on a buy bot means posting a green alert on a dump.
const V2_SWAP = "Swap(address,uint256,uint256,uint256,uint256,address)";
const V3_SWAP = "Swap(address,address,int256,int256,uint160,uint128,int24)";
// PancakeSwap V3 — THE dominant DEX on BSC. Uniswap V3's event plus two
// protocol-fee words, so a DIFFERENT topic0 and the amounts in the same place.
const PCS_V3_SWAP = "Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)";
// Aerodrome / Velodrome / Solidly — THE dominant DEX on Base. V2's four
// amounts, but `to` is indexed as well as `sender`.
const SOLIDLY_SWAP = "Swap(address,address,uint256,uint256,uint256,uint256)";

/**
 * Every Swap shape we decode.
 *
 * WHY A TABLE. The filter used to name two topics and the decoder used to
 * branch on the same two, written out separately — so the two lists could
 * drift, and they had both been wrong in the same way since the file was
 * written: a PancakeSwap V3 pool on BSC and an Aerodrome pool on Base matched
 * NEITHER topic, so getLogs returned nothing and the pool read as one that
 * nobody trades. Not an error, not a fallback to the indexer — a silent,
 * permanent "quiet pool" on the busiest DEX of each chain. The getLogs filter
 * is derived from this table now, so the two can no longer disagree.
 *
 * `kind` — v2: four UNSIGNED amounts (ours = out, spent = in).
 *          v3: two SIGNED amounts, negative meaning it LEFT the pool, i.e. the
 *              trader received it.
 * `at`   — where the amounts start in parseLog's args, which follow
 *          DECLARATION order and include the indexed params. This index is the
 *          entire reason a table beats a branch: Solidly indexes `to` as well
 *          as `sender`, which shifts its amounts from args[1..4] to args[2..5].
 *          Reading them at Uniswap's offsets does NOT throw — args[1] is an
 *          address string and BigInt("0x2222…") is a perfectly good number — it
 *          silently reports a sell as a buy.
 */
const SWAP_SHAPES = [
  {
    kind: "v2",
    at: 1,
    sig: V2_SWAP,
    abi: "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  },
  {
    kind: "v3",
    at: 2,
    sig: V3_SWAP,
    abi: "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  },
  {
    kind: "v3",
    at: 2,
    sig: PCS_V3_SWAP,
    abi: "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint128 protocolFeesToken0, uint128 protocolFeesToken1)",
  },
  {
    kind: "v2",
    at: 2,
    sig: SOLIDLY_SWAP,
    abi: "event Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)",
  },
];

// Built on first use, never at module scope: `ethers` is an optional lazy
// dependency here, and a top-level ethers.id() would crash the whole bot on a
// box that has not installed it.
let shapeMap = null;
function swapShapes(ethers) {
  if (!shapeMap) {
    shapeMap = new Map();
    for (const s of SWAP_SHAPES) {
      shapeMap.set(ethers.id(s.sig), { ...s, iface: new ethers.Interface([s.abi]) });
    }
  }
  return shapeMap;
}

const token0Cache = new Map(); // `${chain}:${pool}` → token0 address, lowercased
const decimalsCache = new Map(); // `${chain}:${token}` → decimals

/**
 * A token's decimals, from the token itself.
 *
 * NOT from the pool snapshot: that comes from an indexer and does not carry
 * them, so trusting a default of 18 puts a 6-decimal token out by a factor of a
 * trillion — and the number it lands on is still a plausible-looking amount, so
 * nothing about the alert says it is wrong. Cached only after a node has
 * actually answered, so a NaN from a half-broken endpoint is not remembered.
 */
async function evmDecimals(chain, token) {
  const key = `${chain}:${String(token).toLowerCase()}`;
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  const ethers = ethersLib();
  if (!ethers) return null;
  const { value } = await rpcRead(
    chain,
    async (url) => {
      const c = new ethers.Contract(token, ["function decimals() view returns (uint8)"], evmProvider(ethers, url));
      const d = Number(await c.decimals());
      return Number.isFinite(d) ? d : null;
    },
    { timeoutMs: TIMEOUT_MS, budgetMs: BUDGET_MS, onFail: dropEndpoint },
  );
  if (Number.isFinite(value)) decimalsCache.set(key, value);
  return Number.isFinite(value) ? value : null;
}

async function evmToken0(chain, pool) {
  const key = `${chain}:${String(pool).toLowerCase()}`;
  if (token0Cache.has(key)) return token0Cache.get(key);
  const ethers = ethersLib();
  if (!ethers) return null;
  const { value } = await rpcRead(
    chain,
    async (url) => {
      const c = new ethers.Contract(pool, ["function token0() view returns (address)"], evmProvider(ethers, url));
      return String(await c.token0()).toLowerCase();
    },
    { timeoutMs: TIMEOUT_MS, budgetMs: BUDGET_MS, onFail: dropEndpoint },
  );
  if (value) token0Cache.set(key, value);
  return value || null;
}

/**
 * One Swap log → a buy of `token`, or null.
 *
 * `tokenIsZero` decides which side of the pool is ours, and it comes from the
 * pool's own token0() rather than from address ordering — a pool is free to be
 * created either way round and guessing costs a reversed alert.
 */
function decodeEvmSwap(ethers, logEntry, tokenIsZero) {
  const shape = swapShapes(ethers).get((logEntry.topics || [])[0]);
  if (!shape) return null; // a shape we do not decode — never guessed at
  let tokenOut = 0n;
  let spent = 0n;
  try {
    const d = shape.iface.parseLog(logEntry);
    if (!d) return null;
    const at = shape.at;
    if (shape.kind === "v2") {
      const a0In = BigInt(d.args[at]);
      const a1In = BigInt(d.args[at + 1]);
      const a0Out = BigInt(d.args[at + 2]);
      const a1Out = BigInt(d.args[at + 3]);
      tokenOut = tokenIsZero ? a0Out : a1Out;
      spent = tokenIsZero ? a1In : a0In;
    } else {
      const a0 = BigInt(d.args[at]);
      const a1 = BigInt(d.args[at + 1]);
      // Negative = out of the pool, into the trader's hands.
      const ours = tokenIsZero ? a0 : a1;
      const other = tokenIsZero ? a1 : a0;
      if (ours >= 0n) return null; // our token went INTO the pool — a sell
      tokenOut = -ours;
      spent = other > 0n ? other : 0n;
    }
  } catch {
    return null;
  }
  if (tokenOut <= 0n) return null; // not a buy of our token
  // NOBODY PAID. A flash swap borrows and repays the same token in one log
  // (amount0In === amount0Out), which reads as a buy of our token for nothing —
  // and arbitrage bots do it routinely. Posting it means a green alert, priced
  // at whatever the tokens are worth, for a trade in which no one bought.
  if (spent <= 0n) return null;
  return { tokenOut, spent };
}

async function evmBuys(chain, pool, token, { sinceBlock, counterAddress, deadline }) {
  const ethers = ethersLib();
  if (!ethers) return null;
  const tok0 = await evmToken0(chain, pool);
  if (!tok0) return null;
  const tokenIsZero = tok0 === String(token).toLowerCase();
  const decimals = await evmDecimals(chain, token);
  // No decimals, no amounts worth printing. Returning null sends the caller to
  // the indexer rather than posting a figure that is wrong by orders of
  // magnitude and looks perfectly reasonable.
  if (decimals == null) return null;
  // The counter side is usually wrapped native (18) but can be USDC (6). Only
  // the "(3.46 SOL)" style suffix depends on it, so a failure here costs that
  // and not the alert.
  const counterDecimals = counterAddress ? await evmDecimals(chain, counterAddress).catch(() => null) : null;

  // DERIVED from the decode table, never written out again: the filter and the
  // decoder disagreeing is exactly how PancakeSwap V3 and Aerodrome pools read
  // as pools nobody trades.
  const wantTopics = [...swapShapes(ethers).keys()];

  const { value } = await rpcRead(
    chain,
    async (url) => {
      const provider = evmProvider(ethers, url);
      const head = await provider.getBlockNumber();
      const want = sinceBlock > 0 ? Math.max(0, Number(sinceBlock)) : Math.max(0, head - FIRST_SIGHT_BLOCKS);
      // Math.max, so this can only ever NARROW: a first sight stays at its own
      // 500 blocks and is never widened to the cap.
      let from = Math.max(0, want, head - MAX_LOG_RANGE);
      if (from > head) return [];
      let logs = null;
      for (let attempt = 0; ; attempt++) {
        try {
          logs = await provider.getLogs({
            address: pool,
            fromBlock: from,
            toBlock: head,
            topics: [wantTopics],
          });
          break;
        } catch (e) {
          // Only a window refusal is retryable here, and only by narrowing.
          // Bounded at two shrinks because this runs inside rpcRead's
          // per-endpoint timeout — a long retry chain spends the budget and
          // the timeout DOES match TRANSPORT_RE, which would then walk every
          // endpoint for a question none of them will answer.
          if (attempt >= 2 || !RANGE_RE.test(String((e && (e.message || e.code)) || e))) throw e;
          from = Math.max(0, head - Math.max(200, Math.floor((head - from) / 4)));
        }
      }
      // NEWEST first when there are more than we can use, for the same reason
      // as the Solana path: a backlog crawled oldest-first makes every alert
      // staler than the last.
      const recent = logs.slice(-MAX_TX);
      const decoded = [];
      for (const l of recent) {
        const hit = decodeEvmSwap(ethers, l, tokenIsZero);
        if (hit) decoded.push({ log: l, hit });
      }
      if (!decoded.length) return [];

      // Block timestamps come from a per-block cache: a burst of buys shares
      // blocks, and asking for the same one per log is the difference between
      // three requests and thirty.
      const blockTimes = new Map();
      const blocks = [...new Set(decoded.map((d) => d.log.blockNumber))];
      await mapBounded(
        blocks,
        async (n) => {
          const b = await provider.getBlock(n).catch(() => null);
          blockTimes.set(n, b && b.timestamp ? b.timestamp * 1000 : 0);
          return null;
        },
        { deadline },
      );
      const cutoff = Date.now() - MAX_AGE_MS;
      const wanted = decoded.filter((d) => {
        const t = blockTimes.get(d.log.blockNumber) || 0;
        return !t || t >= cutoff;
      });

      // The BUYER is the transaction's sender, not the Swap event's
      // `to`/`recipient`: on any routed swap those are the router, and a buy
      // bot that names the router names the same wallet on every alert.
      const out = await mapBounded(
        wanted,
        async (d) => {
          const tx = await provider.getTransaction(d.log.transactionHash).catch(() => null);
          return {
            txHash: d.log.transactionHash,
            buyer: (tx && tx.from) || "",
            tokenAmount: Number(ethers.formatUnits(d.hit.tokenOut, decimals)),
            spentAmount: Number(ethers.formatUnits(d.hit.spent, counterDecimals ?? 18)),
            blockNumber: Number(d.log.blockNumber),
            blockTimeMs: blockTimes.get(d.log.blockNumber) || 0,
          };
        },
        { deadline },
      );
      return out;
    },
    { timeoutMs: TIMEOUT_MS, budgetMs: BUDGET_MS, onFail: dropEndpoint },
  );
  return value || null;
}

// ── Solana ───────────────────────────────────────────────────────────────────
//
// Read the BALANCE DELTA, never the instruction. Solana has a dozen DEX
// programs and a routed swap can touch several in one transaction; decoding
// each program's instruction layout is a maintenance treadmill that breaks
// every time one of them ships a new version. The signer's token balance going
// UP is the same fact on every one of them, and it is what a block explorer
// shows the user anyway.
async function solanaBuys(chain, pool, token, { sinceSig, sinceSlot, deadline }) {
  const web3 = solLib();
  if (!web3) return null;
  const { value } = await rpcRead(
    chain,
    async (url) => {
      const conn = solConnection(web3, url);
      const poolKey = new web3.PublicKey(pool);
      const sigs = await conn.getSignaturesForAddress(poolKey, {
        limit: sinceSig ? MAX_TX : FIRST_SIGHT_SIGS,
        ...(sinceSig ? { until: sinceSig } : {}),
      });
      if (!sigs.length) return [];
      // getSignaturesForAddress returns NEWEST first; alerts must post in the
      // order the buys happened.
      //
      // FILTERED BEFORE ANY getTransaction. The listing already carries slot,
      // blockTime and err, so a failed transaction or one older than half an
      // hour can be dropped for free — and buyMonitor was going to drop it
      // anyway. Fetching forty transactions to keep eight is how this reader
      // turned a 25-second poll into a six-minute one.
      const cutoff = Date.now() - MAX_AGE_MS;
      const wanted = sigs
        .filter((x) => !x.err)
        .filter((x) => !sinceSlot || x.slot > sinceSlot)
        .filter((x) => !x.blockTime || x.blockTime * 1000 >= cutoff)
        // NEWEST first is what we keep when there are more than we can use: a
        // buy from forty minutes ago is not news, and crawling through a
        // backlog oldest-first means every alert is staler than the last.
        .slice(0, MAX_TX)
        .reverse();
      if (!wanted.length) return [];

      // COUNTED, because "nothing decoded" and "nothing could be read" are
      // opposite facts that used to look identical.
      //
      // A public Solana endpoint rate-limits a burst of getTransaction calls
      // long before forty of them land. Every fetch then failed, `out` came
      // back empty, and an empty array means "the pool is quiet" — so
      // buyMonitor advanced the cursor past buys it had never seen and the
      // group went silent for good, with nothing logged and nothing to fall
      // back to. A token that was set up correctly simply never alerted.
      //
      // The count is of transactions FETCHED, never of buys emitted: a window
      // of forty sells reads perfectly and emits nothing, and calling that
      // unreadable would put every dumping pool on the indexer and fire a
      // dead-pool warning at a reader that is working exactly as intended.
      let fetched = 0;
      let firstErr = null;
      const out = await mapBounded(
        wanted,
        async (sig) => {
          let tx = null;
          try {
            tx = await conn.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
          } catch (e) {
            // KEPT, not swallowed. The node's own words are what rpcRead
            // classifies on: a 429 is a transport failure worth asking another
            // endpoint about, and a malformed request is not. Replacing it
            // with a message of our own throws that away and makes every
            // failure look permanent.
            if (!firstErr) firstErr = e;
          }
          if (!tx || !tx.meta) return null;
          fetched++;
          const keys = tx.transaction.message.staticAccountKeys
            ? tx.transaction.message.staticAccountKeys.map((k) => k.toBase58())
            : (tx.transaction.message.accountKeys || []).map((k) => (k.toBase58 ? k.toBase58() : String(k)));
          const payer = keys[0] || "";
          if (!payer) return null;
          // The fee payer's balance of OUR mint, before and after. Anyone
          // else's delta in the same transaction is the pool's or the router's.
          const mine = (list) =>
            (list || []).find(
              (b) => b.mint === token && (b.owner === payer || keys[b.accountIndex] === payer),
            );
          const pre = mine(tx.meta.preTokenBalances);
          const post = mine(tx.meta.postTokenBalances);
          const before = Number((pre && pre.uiTokenAmount && pre.uiTokenAmount.uiAmount) || 0);
          const after = Number((post && post.uiTokenAmount && post.uiTokenAmount.uiAmount) || 0);
          const gained = after - before;
          if (!(gained > 0)) return null; // a sell, or not a trade of this token
          // What they paid, in SOL: the lamport delta with the fee added back,
          // so the figure matches the swap rather than the swap plus gas.
          const idx = keys.indexOf(payer);
          const solBefore = Number((tx.meta.preBalances || [])[idx] || 0);
          const solAfter = Number((tx.meta.postBalances || [])[idx] || 0);
          const lamports = solBefore - solAfter - Number(tx.meta.fee || 0);
          return {
            txHash: sig.signature,
            buyer: payer,
            tokenAmount: gained,
            spentAmount: lamports > 0 ? lamports / 1e9 : 0,
            blockNumber: Number(sig.slot) || 0,
            blockTimeMs: sig.blockTime ? sig.blockTime * 1000 : 0,
          };
        },
        { deadline },
      );
      // Signatures to read, and not one of them readable. That is the endpoint
      // refusing us, not a quiet pool — throw, so rpcRead tries the next node
      // and, if they all refuse, fetchPoolBuys returns null and the caller
      // falls back to the indexer instead of advancing past buys it never saw.
      if (!fetched) throw firstErr || new Error(`solana: ${wanted.length} signature(s) to read, none readable`);
      return out;
    },
    { timeoutMs: TIMEOUT_MS, budgetMs: BUDGET_MS, onFail: dropEndpoint },
  );
  return value || null;
}

/**
 * Buys of `token` in `pool`, read from the chain.
 *
 * Amounts only — the chain does not know dollars. The caller applies the pool's
 * price, and does so only once there is something to price, so a quiet pool
 * never asks an indexer anything at all.
 */
async function fetchPoolBuys(chain, pool, token, opts = {}) {
  if (!pool || !token || !supports(chain)) return null;
  const { counterSymbol, counterAddress } = opts;
  // Every read shares ONE wall-clock budget. The poll interval is the thing
  // this must never exceed: a reader that makes the bot slower than the feed it
  // replaced is worse than no reader, which is exactly what the first cut was.
  const deadline = Date.now() + DEADLINE_MS;
  let raw = null;
  try {
    raw = isSvm(chain)
      ? await solanaBuys(chain, pool, token, { sinceSig: opts.sinceSig, sinceSlot: opts.sinceBlock, deadline })
      : await evmBuys(chain, pool, token, { sinceBlock: opts.sinceBlock, counterAddress, deadline });
  } catch (e) {
    log.debug(`[chaintrades] ${chain}/${pool}: ${e && e.message}`);
    return null;
  }
  if (raw == null) return null;
  // NO USD HERE. Dollars are not on the chain, and asking an indexer for a
  // price before we even know whether anything traded is what let a rate limit
  // on that indexer silence a pool whose RPC was healthy. The caller prices
  // these once it has something worth pricing.
  return raw
    .map((b) => ({ ...b, spentToken: counterAddress || "", counterSymbol: counterSymbol || "" }))
    .sort((a, b) => a.blockNumber - b.blockNumber || a.blockTimeMs - b.blockTimeMs);
}

module.exports = {
  fetchPoolBuys,
  supports,
  decodeEvmSwap,
  V2_SWAP,
  V3_SWAP,
  PCS_V3_SWAP,
  SOLIDLY_SWAP,
  SWAP_SHAPES,
  swapShapes,
  MAX_TX,
  _reset: () => {
    token0Cache.clear();
    decimalsCache.clear();
    providers.clear();
    connections.clear();
    shapeMap = null; // the interfaces are built from whichever `ethers` a test injected
  },
};
