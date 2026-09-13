// Chain RPC endpoints — the list, the ordering, and the read-side fallback.
//
// WHY THIS IS A LIST AND NOT A STRING
// Every chain used to have exactly one endpoint. That is fine right up until
// the node has a bad afternoon, and then the bot does not report an error — it
// reports the WRONG ANSWER. An unreadable balance during payment polling looks
// exactly like "the customer has not paid yet", and an unreadable token balance
// makes every whale look like a minnow. Neither logs anything alarming.
//
// So a READ walks the list until one endpoint answers.
//
// THE RULE THAT MUST NOT BE BROKEN: A SEND NEVER FALLS BACK.
// A broadcast that fails at the transport layer may still have reached the
// network. Re-sending the same signed transfer to a second node risks paying
// twice. So the sweep adapters take the endpoint that answered their OPENING
// BALANCE READ and stay on it — read and send must share a node, or reading
// from a healthy backup while broadcasting to a dead primary just moves where
// it fails. Nothing is signed until an endpoint has already answered, so
// choosing at that point cannot double-spend.
//
// CONFIGURING
//   RPC_<CHAIN>          one endpoint; becomes the PRIMARY, defaults follow it
//   RPC_<CHAIN>_URLS     comma-separated list; WINS OUTRIGHT (defaults dropped)
// e.g. RPC_BSC=https://my-paid-node.example  or
//      RPC_SOLANA_URLS=https://a.example,https://b.example
//
// The defaults below are keyless public endpoints. They are rate-limited and
// shared with the whole internet — fine for a small group, not for a busy one.
// `npm run rpc:check` reports which of them actually answer from YOUR server.

const env = process.env;

// Best-first. The first entry of each list is what a SEND uses.
const DEFAULTS = {
  // ── Chains with a wallet adapter (payments + sweeps run here) ──────────────
  ethereum: [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.llamarpc.com",
    "https://eth.drpc.org",
    "https://rpc.flashbots.net",
  ],
  bsc: [
    "https://bsc-rpc.publicnode.com",
    "https://bsc-dataseed.bnbchain.org",
    "https://bsc-dataseed1.defibit.io",
    "https://bsc.drpc.org",
  ],
  base: [
    "https://base-rpc.publicnode.com",
    "https://mainnet.base.org",
    "https://base.drpc.org",
  ],
  // Dexvra's own chain. One published endpoint — if it is down there is no
  // second opinion, which is precisely why the check script exists.
  robinhood: ["https://rpc.mainnet.chain.robinhood.com"],
  solana: [
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
    "https://solana.drpc.org",
  ],
  tron: ["https://api.trongrid.io", "https://tron-rpc.publicnode.com"],
  ton: ["https://toncenter.com/api/v2/jsonRPC"],

  // ── Tracked-only EVM chains ───────────────────────────────────────────────
  // These are billed on another chain (payVia), so no wallet is ever created
  // here and no sweep ever runs. They are listed because the buy bot reads
  // holder balances on them: without an endpoint, whale detection silently
  // cannot work — it does not fail, it just never finds a whale.
  polygon: [
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon-rpc.com",
    "https://polygon.drpc.org",
  ],
  arbitrum: [
    "https://arbitrum-one-rpc.publicnode.com",
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum.drpc.org",
  ],
  optimism: [
    "https://optimism-rpc.publicnode.com",
    "https://mainnet.optimism.io",
    "https://optimism.drpc.org",
  ],
  avalanche: [
    "https://avalanche-c-chain-rpc.publicnode.com",
    "https://api.avax.network/ext/bc/C/rpc",
    "https://avalanche.drpc.org",
  ],
  berachain: ["https://rpc.berachain.com", "https://berachain-rpc.publicnode.com"],
  sonic: ["https://rpc.soniclabs.com", "https://sonic-rpc.publicnode.com"],
  hyperevm: ["https://rpc.hyperliquid.xyz/evm", "https://rpc.hypurrscan.io"],
  abstract: ["https://api.mainnet.abs.xyz"],
  apechain: ["https://apechain.calderachain.xyz/http"],
  blast: ["https://rpc.blast.io", "https://blast-rpc.publicnode.com"],
  sei: ["https://evm-rpc.sei-apis.com", "https://sei-evm-rpc.publicnode.com"],
  unichain: ["https://mainnet.unichain.org", "https://unichain-rpc.publicnode.com"],
  plasma: ["https://rpc.plasma.to"],
};

const RPC_CHAINS = Object.keys(DEFAULTS);

const envKey = (chain) => String(chain || "").toUpperCase().replace(/[^A-Z0-9]/g, "_");
const splitList = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Every endpoint for `chain`, best-first, as CONFIGURED — no health reordering,
 * so this is stable and safe to print in a report.
 *
 * `RPC_<CHAIN>_URLS` replaces the list entirely: an operator who names their
 * endpoints does not want a public node quietly appended as a fourth choice,
 * carrying their traffic (and their addresses) somewhere they did not pick.
 * `RPC_<CHAIN>` is the softer form — it leads, the defaults stay as backup.
 */
function rpcUrls(chain) {
  const key = envKey(chain);
  const listed = splitList(env[`RPC_${key}_URLS`]);
  if (listed.length) return [...new Set(listed)];
  const single = String(env[`RPC_${key}`] || "").trim();
  return [...new Set([single, ...(DEFAULTS[chain] || [])].filter(Boolean))];
}

/** The primary endpoint — what a SEND uses, and what `constants.RPC` holds.
 *  "" when the chain has none. */
const rpcUrl = (chain) => rpcUrls(chain)[0] || "";

// ── Endpoint health ──────────────────────────────────────────────────────────
// An endpoint that just failed goes to the BACK of the order for a while. It is
// never removed: a demotion is an opinion about the last minute, and the list
// is the only thing standing between the bot and a chain it cannot read at all.
const COOLDOWN_MS = 5 * 60 * 1000;
const badUntil = new Map(); // url → timestamp

function noteBad(url, at = Date.now()) {
  if (url) badUntil.set(url, at + COOLDOWN_MS);
}
function noteGood(url) {
  if (url) badUntil.delete(url);
}
const isCooling = (url, at = Date.now()) => (badUntil.get(url) || 0) > at;

/** `rpcUrls` with recently-failed endpoints moved to the back (order otherwise
 *  preserved). This is what a READ walks. */
function rankedUrls(chain, at = Date.now()) {
  const all = rpcUrls(chain);
  const live = all.filter((u) => !isCooling(u, at));
  const cooling = all.filter((u) => isCooling(u, at));
  return [...live, ...cooling];
}

// ── Read with fallback ───────────────────────────────────────────────────────

const TIMEOUT_MS = 6000; // per endpoint
const BUDGET_MS = 12000; // across all of them — a caller is waiting

// Transport failures are worth asking a different node about. A revert, a bad
// address or a malformed request is not: it will fail identically everywhere,
// and walking four endpoints turns one fast error into a slow one.
const TRANSPORT_RE =
  /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|socket|network|fetch failed|failed to fetch|SERVER_ERROR|NETWORK_ERROR|could not detect network|502|503|504|429|rate.?limit|too many requests|service unavailable|bad gateway|gateway timeout/i;

const isTransportError = (e) => TRANSPORT_RE.test(String((e && (e.message || e.code)) || e || ""));

// The timer is deliberately NOT unref'd, and is cleared the moment the race
// settles. An unref'd timeout is only a timeout while something ELSE is keeping
// the event loop alive: under the bot's polling loop it fires, but in a CLI
// script (treasury --live, a sweep pass) the loop empties, the timer never
// fires, and a hung endpoint means the command exits silently having done
// nothing. Clearing on settle gives the same "holds the process open for at
// most ms" property without that hole.
function withTimeout(p, ms) {
  let timer;
  const alarm = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`rpc timeout after ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(p), alarm]).finally(() => clearTimeout(timer));
}

/**
 * Run `fn(url)` against each endpoint until one answers.
 *
 * Resolves `{ value, url }` — the url is returned because the caller may need
 * to STAY on it (see the send rule at the top of this file). Throws the last
 * error when every endpoint fails: an unreadable balance is UNKNOWN, never
 * zero, and returning a default here is how a paid order gets reported as
 * unpaid.
 *
 * `opts.onFail(url, err)` fires whenever an endpoint is demoted, INCLUDING the
 * timeout case where `fn`'s own promise never settles and its `catch` never
 * runs. A caller holding a client for that url needs that hook to tear it down:
 * an ethers JsonRpcProvider pointed at an unreachable node retries network
 * detection once a second, forever, and holds the event loop open doing it.
 */
async function rpcRead(chain, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const budgetMs = opts.budgetMs || BUDGET_MS;
  const started = Date.now();
  const urls = rankedUrls(chain, started);
  if (!urls.length) throw new Error(`no RPC configured for chain "${chain}"`);

  let last = null;
  for (const url of urls) {
    const remaining = budgetMs - (Date.now() - started);
    if (last && remaining <= 0) break; // a caller is waiting
    try {
      // Never let a late attempt run past the budget it was admitted under, or
      // the real worst case is budget + one full timeout rather than budget.
      const value = await withTimeout(Promise.resolve(fn(url)), Math.min(timeoutMs, Math.max(1, remaining)));
      noteGood(url);
      return { value, url };
    } catch (e) {
      last = e;
      if (!isTransportError(e)) throw e; // same answer everywhere — do not walk
      noteBad(url, Date.now());
      try {
        opts.onFail?.(url, e);
      } catch {
        /* a cleanup hook must never decide the outcome of a read */
      }
    }
  }
  throw last || new Error(`no RPC answered for chain "${chain}"`);
}

function _reset() {
  badUntil.clear();
}

module.exports = {
  DEFAULTS,
  RPC_CHAINS,
  rpcUrls,
  rpcUrl,
  rankedUrls,
  rpcRead,
  isTransportError,
  noteBad,
  noteGood,
  isCooling,
  COOLDOWN_MS,
  TIMEOUT_MS,
  BUDGET_MS,
  _reset,
};
