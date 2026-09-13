// Chain registry — the bot's chain ids MUST match dexvra's src/config/chains.ts
// (the web store validates `chain` against them). Adding a chain is one entry.
// `family` selects the payment adapter; `native`/`decimals` drive on-chain
// amount math; `geckoNetwork` drives live market data for posts.

// DexScreener's own chain slug, for the 📈 Chart link on a group buy alert.
//
// Almost every id already matches; the map exists for the ones that do not. A
// missing entry means "DexScreener has no such chain" and the caller falls
// back. Robinhood spent this file's whole history absent on purpose ("GT
// carries it and DexScreener does not") — DexScreener added the chain around
// July 2026 (dexscreener.com/new-pairs/robinhood), and keeping it absent had
// become the opposite of the entry's stated reason: every robinhood read paid
// the shared GT quota for a number DexScreener now also publishes. Whether DS
// actually answers for a given token is measured on the box, never assumed.
const DEXSCREENER_SLUG = {
  robinhood: "robinhood",
  solana: "solana",
  bsc: "bsc",
  ethereum: "ethereum",
  base: "base",
  tron: "tron",
  ton: "ton",
  sui: "sui",
  plasma: "plasma",
  polygon: "polygon",
  arbitrum: "arbitrum",
  optimism: "optimism",
  avalanche: "avalanche",
  berachain: "berachain",
  sonic: "sonic",
  hyperevm: "hyperevm",
  abstract: "abstract",
  apechain: "apechain",
  blast: "blast",
  sei: "seiv2",
  aptos: "aptos",
  unichain: "unichain",
};

/**
 * The DexScreener chart for a pool, or null when that chain isn't on it.
 *
 * Prefers the POOL address — that opens the exact pair the alert is reporting.
 * A token address also resolves (DexScreener picks its top pair), so it is the
 * fallback for a group whose pool hasn't been resolved yet.
 */
function chartUrl(chain, poolOrToken) {
  const slug = DEXSCREENER_SLUG[String(chain || "").toLowerCase()];
  if (!slug || !poolOrToken) return null;
  return `https://dexscreener.com/${slug}/${poolOrToken}`;
}

/**
 * The trade bot, already scanning this contract.
 *
 * ?start=ca_<chain>_<address> is the payload tradebot/telegram.js reads to skip
 * straight to the scan instead of asking for an address. Lives here, beside
 * chartUrl and txUrl, because more than one surface offers it — the buy card
 * and /ca — and a second copy is a second thing to fix when the payload shape
 * changes. Required lazily: config/constants reads process.env at load time.
 */
const tradeDeepLink = (chain, address) =>
  `https://t.me/${require("./constants").TRADEBOT_USERNAME}?start=ca_${String(chain).toLowerCase().replace(/[^a-z0-9]/g, "")}_${address}`;

const CHAINS = {
  solana: {
    id: "solana", label: "Solana", native: "SOL", family: "solana", decimals: 9,
    geckoNetwork: "solana",
    addressPattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    explorer: (a) => `https://solscan.io/token/${a}`,
    buyUrl: (a) => `https://jup.ag/swap/SOL-${a}`,
  },
  bsc: {
    id: "bsc", label: "BSC", native: "BNB", family: "evm", decimals: 18,
    geckoNetwork: "bsc",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://bscscan.com/token/${a}`,
    buyUrl: (a) => `https://pancakeswap.finance/swap?outputCurrency=${a}`,
  },
  ethereum: {
    id: "ethereum", label: "Ethereum", native: "ETH", family: "evm", decimals: 18,
    geckoNetwork: "eth",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://etherscan.io/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=mainnet&outputCurrency=${a}`,
  },
  base: {
    id: "base", label: "Base", native: "ETH", family: "evm", decimals: 18,
    geckoNetwork: "base",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://basescan.org/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=base&outputCurrency=${a}`,
  },
  robinhood: {
    id: "robinhood", label: "Robinhood", native: "ETH", family: "evm", decimals: 18,
    geckoNetwork: "robinhood", // GT indexes Robinhood Chain (DexScreener doesn't)
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://dexscreener.com/search?q=${a}`,
    buyUrl: (a) => `https://dexscreener.com/search?q=${a}`,
  },
  tron: {
    id: "tron", label: "Tron", native: "TRX", family: "tron", decimals: 6,
    geckoNetwork: "tron",
    addressPattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    explorer: (a) => `https://tronscan.org/#/token20/${a}`,
    buyUrl: (a) => `https://sunswap.com/#/home?tokenAddress=${a}`,
  },
  ton: {
    id: "ton", label: "TON", native: "TON", family: "ton", decimals: 9,
    geckoNetwork: "ton",
    addressPattern: /^(EQ|UQ|0:)[A-Za-z0-9_-]{40,66}$/,
    explorer: (a) => `https://tonviewer.com/${a}`,
    buyUrl: (a) => `https://app.ston.fi/swap?ft=TON&tt=${a}`,
  },
  // ── payVia chains — listed/tracked here, but PAID on another chain (the
  //    fourtis "monad via ETH/Base" pattern). No wallet adapter needed: every
  //    payment call routes through payChainOf() below. ──
  sui: {
    id: "sui", label: "Sui", native: "SUI", family: null, payVia: "bsc", decimals: 9,
    geckoNetwork: "sui-network",
    // Sui coin type: 0x<hex>::module::SYMBOL (bare object addresses accepted too)
    addressPattern: /^0x[a-fA-F0-9]{1,64}(::[A-Za-z0-9_]+){0,2}$/,
    explorer: (a) => `https://suivision.xyz/coin/${encodeURIComponent(a)}`,
    buyUrl: (a) => `https://app.cetus.zone/swap/?to=${encodeURIComponent(a)}`,
  },
  plasma: {
    id: "plasma", label: "Plasma", native: "XPL", family: null, payVia: "ethereum", decimals: 18,
    geckoNetwork: "plasma",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://dexscreener.com/plasma/${a}`,
    buyUrl: (a) => `https://dexscreener.com/plasma/${a}`,
  },
  // ── More EVM chains — all PAID IN BNB via BSC (payVia:"bsc"), no wallet
  //    adapter needed (same pattern as Sui). geckoNetwork drives live market
  //    data for posts; every token address is a standard 0x… EVM address. ──
  polygon: {
    id: "polygon", label: "Polygon", native: "POL", family: null, payVia: "bsc", decimals: 18,
    geckoNetwork: "polygon_pos",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://polygonscan.com/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=polygon&outputCurrency=${a}`,
  },
  arbitrum: {
    id: "arbitrum", label: "Arbitrum", native: "ETH", family: null, payVia: "bsc", decimals: 18,
    geckoNetwork: "arbitrum",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://arbiscan.io/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=arbitrum&outputCurrency=${a}`,
  },
  optimism: {
    id: "optimism", label: "Optimism", native: "ETH", family: null, payVia: "bsc", decimals: 18,
    geckoNetwork: "optimism",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://optimistic.etherscan.io/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=optimism&outputCurrency=${a}`,
  },
  avalanche: {
    id: "avalanche", label: "Avalanche", native: "AVAX", family: null, payVia: "bsc", decimals: 18,
    geckoNetwork: "avax",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://snowtrace.io/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=avalanche&outputCurrency=${a}`,
  },
  berachain: {
    id: "berachain", label: "Berachain", native: "BERA", family: null, payVia: "bsc", decimals: 18,
    geckoNetwork: "berachain",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://berascan.com/token/${a}`,
    buyUrl: (a) => `https://dexscreener.com/berachain/${a}`,
  },
  sonic: {
    id: "sonic", label: "Sonic", native: "S", family: null, payVia: "bsc", decimals: 18,
    geckoNetwork: "sonic",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://sonicscan.org/token/${a}`,
    buyUrl: (a) => `https://dexscreener.com/sonic/${a}`,
  },
  hyperevm: {
    id: "hyperevm", label: "HyperEVM", native: "HYPE", family: null, payVia: "bsc", decimals: 18,
    geckoNetwork: "hyperevm",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://dexscreener.com/hyperevm/${a}`,
    buyUrl: (a) => `https://dexscreener.com/hyperevm/${a}`,
  },
  abstract: {
    id: "abstract", label: "Abstract", native: "ETH", family: null, payVia: "bsc", decimals: 18,
    geckoNetwork: "abstract",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://abscan.org/token/${a}`,
    buyUrl: (a) => `https://dexscreener.com/abstract/${a}`,
  },
  apechain: {
    id: "apechain", label: "ApeChain", native: "APE", family: null, payVia: "bsc", decimals: 18,
    geckoNetwork: "apechain",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://apescan.io/token/${a}`,
    buyUrl: (a) => `https://dexscreener.com/apechain/${a}`,
  },
  blast: {
    id: "blast", label: "Blast", native: "ETH", family: null, payVia: "bsc", decimals: 18,
    geckoNetwork: "blast",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://blastscan.io/token/${a}`,
    buyUrl: (a) => `https://dexscreener.com/blast/${a}`,
  },
  sei: {
    id: "sei", label: "Sei", native: "SEI", family: null, payVia: "bsc", decimals: 18,
    geckoNetwork: "sei-evm",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://seitrace.com/token/${a}?chain=pacific-1`,
    buyUrl: (a) => `https://dexscreener.com/seiv2/${a}`,
  },
  aptos: {
    // Non-EVM (Move). Address = a coin type (0x…::module::SYMBOL) or a bare
    // object / fungible-asset address. Still billed in BNB via BSC (payVia).
    id: "aptos", label: "Aptos", native: "APT", family: null, payVia: "bsc", decimals: 8,
    geckoNetwork: "aptos",
    addressPattern: /^0x[a-fA-F0-9]{1,64}(::[A-Za-z0-9_]+){0,2}$/,
    explorer: (a) => `https://dexscreener.com/aptos/${a}`,
    buyUrl: (a) => `https://dexscreener.com/aptos/${a}`,
  },
  unichain: {
    id: "unichain", label: "Unichain", native: "ETH", family: null, payVia: "bsc", decimals: 18,
    geckoNetwork: "unichain",
    addressPattern: /^0x[a-fA-F0-9]{40}$/,
    explorer: (a) => `https://uniscan.xyz/token/${a}`,
    buyUrl: (a) => `https://app.uniswap.org/swap?chain=unichain&outputCurrency=${a}`,
  },
};

// Menu / selector order across the bot (mirrors the website's chain order).
// Order of the trending board's sections, the chain picker, and the admin
// panel's per-chain rows — one list, so those three can never disagree.
// Robinhood sits THIRD by operator decision: it is Dexvra's own chain, and
// burying it under Ethereum and Base put the network the product is built
// around at the bottom of its own board.
const CHAIN_ORDER = [
  "solana", "bsc", "robinhood", "ethereum", "base", "tron", "ton", "sui", "plasma",
  "polygon", "arbitrum", "optimism", "avalanche", "berachain", "sonic", "hyperevm", "abstract",
  "apechain", "blast", "sei", "aptos", "unichain",
];
const CHAIN_IDS = CHAIN_ORDER.filter((id) => CHAINS[id]);

const chainOf = (id) => CHAINS[id] || null;
const nativeOf = (id) => CHAINS[id]?.native || "SOL";
const decimalsOf = (id) => CHAINS[id]?.decimals ?? 9;
const familyOf = (id) => CHAINS[id]?.family || null;

/** The chain PAYMENT actually happens on (Sui pays in BNB on BSC, Plasma pays
 *  in ETH on Ethereum). Identity for chains with their own wallet adapter. */
const payChainOf = (id) => CHAINS[id]?.payVia || id;
/** Native coin the buyer sends for a listing on `id` (SUI → BNB, XPL → ETH). */
const payNativeOf = (id) => nativeOf(payChainOf(id));
/** Chains money can be RECEIVED on (banner pay-method picker etc). */
const PAYABLE_CHAIN_IDS = CHAIN_IDS.filter((id) => !CHAINS[id].payVia);

/** Loose per-chain contract-address validation (the fourtis bot skipped this — we don't). */
function isValidAddress(chain, address) {
  const c = CHAINS[chain];
  if (!c || typeof address !== "string") return false;
  return c.addressPattern.test(address.trim());
}

// ── Transaction / account explorer links ─────────────────────────────────────
// The per-chain `explorer` above points at a TOKEN page, which is the only
// thing the listing posts ever needed. The group buy bot posts REAL
// transactions, so it needs the two links a reader actually wants to click:
// the transaction itself, and the wallet that made it.
//
// Kept as one table rather than two more closures per chain entry: most chains
// are Blockscout/Etherscan clones where both URLs derive from one host, and the
// handful that are not (Solana, Tron, TON, Move chains) are the exceptions
// worth spelling out. An unknown chain returns null and the alert simply omits
// the link — a buy alert must never be blocked by a missing explorer.
const EVM_EXPLORER_BASE = {
  ethereum: "https://etherscan.io",
  bsc: "https://bscscan.com",
  base: "https://basescan.org",
  // Matches the web app's src/config/chains.ts, so a link is the same wherever
  // it is published. (The token `explorer` above still points at DexScreener;
  // that is a separate, older choice and changing it would move the links in
  // every existing channel post.)
  robinhood: "https://robinhoodchain.blockscout.com",
  polygon: "https://polygonscan.com",
  arbitrum: "https://arbiscan.io",
  optimism: "https://optimistic.etherscan.io",
  avalanche: "https://snowtrace.io",
  berachain: "https://berascan.com",
  sonic: "https://sonicscan.org",
  hyperevm: "https://hyperevmscan.io",
  abstract: "https://abscan.org",
  apechain: "https://apescan.io",
  blast: "https://blastscan.io",
  sei: "https://seitrace.com",
  unichain: "https://uniscan.xyz",
  plasma: "https://plasmascan.to",
};

const SPECIAL_EXPLORER = {
  solana: {
    tx: (h) => `https://solscan.io/tx/${h}`,
    account: (a) => `https://solscan.io/account/${a}`,
  },
  tron: {
    tx: (h) => `https://tronscan.org/#/transaction/${h}`,
    account: (a) => `https://tronscan.org/#/address/${a}`,
  },
  ton: {
    tx: (h) => `https://tonviewer.com/transaction/${h}`,
    account: (a) => `https://tonviewer.com/${a}`,
  },
  sui: {
    tx: (h) => `https://suivision.xyz/txblock/${h}`,
    account: (a) => `https://suivision.xyz/account/${a}`,
  },
  aptos: {
    tx: (h) => `https://explorer.aptoslabs.com/txn/${h}?network=mainnet`,
    account: (a) => `https://explorer.aptoslabs.com/account/${a}?network=mainnet`,
  },
};

/** Explorer URL for a transaction hash, or null when the chain has none. */
function txUrl(chain, hash) {
  if (!hash) return null;
  const special = SPECIAL_EXPLORER[chain];
  if (special) return special.tx(hash);
  const base = EVM_EXPLORER_BASE[chain];
  return base ? `${base}/tx/${hash}` : null;
}

/** Explorer URL for a wallet/account, or null when the chain has none. */
function accountUrl(chain, address) {
  if (!address) return null;
  const special = SPECIAL_EXPLORER[chain];
  if (special) return special.account(address);
  const base = EVM_EXPLORER_BASE[chain];
  return base ? `${base}/address/${address}` : null;
}

/** `0x1234…cdef` — a hash/address short enough to read in a chat line. */
function shortAddress(a, head = 6, tail = 4) {
  const s = String(a || "");
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

module.exports = {
  chartUrl,
  tradeDeepLink,
  DEXSCREENER_SLUG,
  CHAINS,
  CHAIN_ORDER,
  CHAIN_IDS,
  PAYABLE_CHAIN_IDS,
  chainOf,
  txUrl,
  accountUrl,
  shortAddress,
  EVM_EXPLORER_BASE,
  nativeOf,
  decimalsOf,
  familyOf,
  payChainOf,
  payNativeOf,
  isValidAddress,
};
