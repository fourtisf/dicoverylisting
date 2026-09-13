// How much of the tracked token does this buyer already hold?
//
// WHAT THIS IS, AND WHAT IT IS NOT
// It reads the buyer's balance OF THE TRACKED TOKEN, on chain, and values it at
// the pool price. It is NOT a portfolio valuation — this bot has no
// portfolio API, and every chain would need a different one.
//
// That distinction is the whole reason the alert says "Holds" and not "Wallet
// Balance". Printing a single-token figure under a label that promises a total
// is a wrong number presented as a right one, which is the failure mode this
// codebase has the longest history with. The signal a group actually wants —
// is this a big holder of OUR token? — is exactly what this measures.
//
// Chains without a reader here simply return null: whale detection is skipped
// and ordinary buy alerts are unaffected.
//
// Every lookup goes through config/rpc.js, which walks that chain's endpoints
// until one answers. This is a pure READ, so falling back is free — and on the
// public nodes these chains default to, the alternative is that a busy hour on
// one shared endpoint turns every holder into a minnow with nothing in the log
// to say why.
const { rpcRead } = require("../config/rpc");
const log = require("../helpers/logger");

// A buy alert is waiting on this, and up to MAX_PER_POLL of them are handled in
// one pass — so the BUDGET is what matters, not the per-endpoint timeout. It is
// deliberately set to the 6s this lookup already had when it was pinned to one
// endpoint: adding a second opinion must not make a whale badge cost the group
// a slower alert. Better a missed badge than a card that lands a minute after
// the trade it describes.
const TIMEOUT_MS = 4000; // per endpoint
const BUDGET_MS = 6000; // across all of them — unchanged from the single-endpoint days
// A wallet's holding barely moves between two buys seconds apart, and a busy
// pool would otherwise spend one RPC call per alert per wallet.
const CACHE_MS = 2 * 60 * 1000;
const CACHE_MAX = 2000;
// A failed lookup is remembered for much less time than a good one — long
// enough to stop a dead RPC costing a timeout per buy, short enough that a
// recovery is picked up quickly.
const FAIL_CACHE_MS = 60 * 1000;
// Token decimals never change, so they are worth remembering for the process.
const decimalsCache = new Map();
const holdCache = new Map(); // `${chain}:${token}:${wallet}` → { at, amount }

const EVM_FAMILY = new Set(["ethereum", "bsc", "base", "robinhood", "polygon", "arbitrum", "optimism", "avalanche", "berachain", "sonic", "hyperevm", "abstract", "apechain", "blast", "sei", "unichain", "plasma"]);

// ── EVM ──────────────────────────────────────────────────────────────────────

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

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

// ONE provider per ENDPOINT, reused. Constructing one per lookup opens a fresh
// socket for every buy, and an unreachable RPC then leaves a pile of them
// waiting — enough to keep the process's event loop alive on its own.
//
// Keyed by url rather than by chain because the endpoint a read lands on now
// varies: key it by chain and a fallback would hand back the provider pointed
// at the node that just failed.
const providers = new Map();
function evmProvider(ethers, url) {
  if (!providers.has(url)) providers.set(url, new ethers.JsonRpcProvider(url));
  return providers.get(url);
}

// A provider pointed at an unreachable node does NOT go quiet: ethers retries
// network detection once a second, forever, and keeps the event loop open doing
// it. Cached and never torn down, one bad endpoint is a permanent background
// request loop — and a CLI script that touches this module never exits.
function dropProvider(url) {
  const p = providers.get(url);
  providers.delete(url);
  try {
    p?.destroy?.();
  } catch {
    /* best effort — the point is to stop the retry loop, not to succeed at it */
  }
}

async function evmHolding(chain, token, wallet) {
  const ethers = ethersLib();
  if (!ethers) return null;
  const dKey = `${chain}:${token}`;
  const { value } = await rpcRead(
    chain,
    async (url) => {
      const c = new ethers.Contract(token, ERC20, evmProvider(ethers, url));
      let decimals = decimalsCache.get(dKey);
      if (decimals == null) {
        decimals = Number(await c.decimals());
        if (!Number.isFinite(decimals)) return null;
        // Cached only once a node has actually answered — a decimals() that
        // came back NaN from a half-broken endpoint would otherwise be
        // remembered for the life of the process.
        decimalsCache.set(dKey, decimals);
      }
      const raw = await c.balanceOf(wallet);
      return Number(raw) / 10 ** decimals;
    },
    { timeoutMs: TIMEOUT_MS, budgetMs: BUDGET_MS, onFail: dropProvider },
  );
  return value;
}

// ── Solana ───────────────────────────────────────────────────────────────────

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

// Same reasoning as the EVM providers: one Connection per endpoint, reused.
const connections = new Map();
function solConnection(web3, url) {
  if (!connections.has(url)) connections.set(url, new web3.Connection(url, "confirmed"));
  return connections.get(url);
}

async function solanaHolding(chain, mint, wallet) {
  const web3 = solLib();
  if (!web3) return null;
  const owner = new web3.PublicKey(wallet);
  const mintKey = new web3.PublicKey(mint);
  const { value } = await rpcRead(
    chain,
    async (url) => {
      const res = await solConnection(web3, url).getParsedTokenAccountsByOwner(owner, { mint: mintKey });
      // A wallet can hold the same mint across several token accounts.
      let total = 0;
      for (const { account } of (res && res.value) || []) {
        const amt = account?.data?.parsed?.info?.tokenAmount?.uiAmount;
        if (Number.isFinite(amt)) total += amt;
      }
      return total;
    },
    { timeoutMs: TIMEOUT_MS, budgetMs: BUDGET_MS },
  );
  return value;
}

// ── Public ───────────────────────────────────────────────────────────────────

function sweepCache(at) {
  if (holdCache.size <= CACHE_MAX) return;
  for (const [k, v] of holdCache) if (at - v.at > CACHE_MS) holdCache.delete(k);
  if (holdCache.size > CACHE_MAX) holdCache.clear();
}

/**
 * The buyer's balance of `token`, in whole tokens. null when we cannot read it —
 * an unsupported chain, a dead RPC, a malformed address. NEVER throws, and a
 * null must never stop an alert: not knowing how big a holder someone is is not
 * a reason to withhold the buy.
 *
 * `fresh` skips a cached SUCCESS. The Position row reports the balance AFTER a
 * specific trade, and the one wallet whose balance certainly just moved is the
 * one that made it — by exactly the amount the row is reporting. The cache
 * comment used to justify itself with "a wallet's holding barely moves between
 * two buys seconds apart", which is true of every wallet EXCEPT this one.
 *
 * That made the cache pure harm on the only path that uses it: one read per buy
 * is already guaranteed by the caller resolving the position once per buy rather
 * than once per group, so a cached hit could only ever be a SECOND buy by the
 * same wallet inside two minutes — the exact case where the stale number is
 * wrong, and wrong in a way the group can check against an explorer.
 *
 * A cached MISS still short-circuits even when `fresh` is set: it is there to
 * stop a dead RPC costing a six-second timeout on every qualifying buy, and that
 * cost does not change according to who is asking.
 */
async function holdingOf(chain, token, wallet, { at = Date.now(), fresh = false } = {}) {
  if (!chain || !token || !wallet) return null;
  const key = `${chain}:${token}:${wallet}`;
  const hit = holdCache.get(key);
  if (hit && at - hit.at < CACHE_MS && (!fresh || hit.amount == null)) return hit.amount;

  let amount = null;
  try {
    if (chain === "solana") amount = await solanaHolding(chain, token, wallet);
    else if (EVM_FAMILY.has(chain)) amount = await evmHolding(chain, token, wallet);
  } catch (e) {
    log.debug(`[buybot] holding lookup failed for ${chain}/${wallet}: ${e && e.message}`);
    amount = null;
  }
  if (amount == null || !Number.isFinite(amount)) {
    // Remember the MISS too, briefly. An unreachable RPC would otherwise cost a
    // six-second timeout on every qualifying buy, for as long as it stays down.
    holdCache.set(key, { at: at - (CACHE_MS - FAIL_CACHE_MS), amount: null });
    sweepCache(at);
    return null;
  }
  holdCache.set(key, { at, amount });
  sweepCache(at);
  return amount;
}

/** Is this chain one we can read holdings on at all? Lets the caller skip the
 *  work — and skip promising a feature it cannot deliver. */
const supports = (chain) => chain === "solana" || EVM_FAMILY.has(chain);

function _reset() {
  holdCache.clear();
  decimalsCache.clear();
}

function _reset2() {
  for (const p of providers.values()) {
    try {
      p.destroy?.();
    } catch {
      /* best effort */
    }
  }
  providers.clear();
  connections.clear();
  require("../config/rpc")._reset();
}

module.exports = { holdingOf, supports, _reset, _resetProviders: _reset2, CACHE_MS, FAIL_CACHE_MS, EVM_FAMILY };
