import type { BoardToken, ListingTier, PeriodKey } from "./types";
import { dexvraScore } from "./score";
import { tierMeta } from "./packages";
import { syntheticTrend, visualFor } from "./visual";

// Dexvra is PAID-LISTING ONLY — tokens exist here because a project paid to
// list, never auto-indexed. These are real example listings (real contract
// addresses); the provider layer enriches each with live market data by
// address, and these figures are the fallback when a provider is unreachable.
export interface ListingRow {
  chain: string;
  address: string;
  sym: string;
  name: string;
  emoji: string;
  tier: ListingTier;
  trendingRank?: number; // present = featured on Trending; value is only a stable sub-order within a tier (Diamond-first ordering wins), never shown as a number
  logoUrl?: string; // admin-set logo image URL; overrides the emoji + live logo
  listedMin: number; // seed-only fallback age (minutes) when listedAt is absent
  listedAt?: number; // ms epoch the listing went live (real listings) — drives a LIVE "listed X ago"
  tax: number;
  holders: number;
  price: number;
  chg24h: number;
  mcap: number;
  liq: number;
  vol24h: number;
  buyShare: number; // 0..1 share of txns that are buys
  tx24h: number;
  website?: string;
  twitter?: string;
  telegram?: string;
  overview?: string; // short project description (bot listing flow / admin edit)
  // Time-boxed Trending slot (set when a project buys a Trending package via the
  // Telegram bot). `trendingRank` is the featured sub-order; `trendExp` is when
  // the slot ends — the provider stops featuring the token past it, and the
  // bot's sweeper clears `trendingRank` in the store shortly after.
  trendStart?: number; // ms epoch the slot began
  trendExp?: number; // ms epoch the slot ends
}

// Only real tokens that resolve to a GeckoTerminal pool, so every listing
// opens with a live candlestick chart (Solana / ETH / Base / BSC — the
// chains GeckoTerminal charts). TON & Robinhood stay supported chains for
// real paid listings, but aren't seeded here (no reliable chart source).
export const SEED_ROWS: ListingRow[] = [
  { chain: "solana", address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", sym: "$BONK", name: "Bonk", emoji: "🐕", logoUrl: "https://dd.dexscreener.com/ds-data/tokens/solana/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263.png?size=lg", tier: "DIAMOND", trendingRank: 1, listedMin: 18, tax: 0, holders: 812000, price: 0.0000246, chg24h: 12.4, mcap: 1720000000, liq: 24000000, vol24h: 138000000, buyShare: 0.56, tx24h: 240000, twitter: "https://x.com/bonk_inu" },
  { chain: "solana", address: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", sym: "$WIF", name: "dogwifhat", emoji: "🐶", logoUrl: "https://dd.dexscreener.com/ds-data/tokens/solana/EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm.png?size=lg", tier: "GOLD", trendingRank: 3, listedMin: 44, tax: 0, holders: 214000, price: 1.83, chg24h: 6.1, mcap: 1830000000, liq: 31000000, vol24h: 96000000, buyShare: 0.52, tx24h: 88000, twitter: "https://x.com/dogwifcoin" },
  { chain: "solana", address: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", sym: "$POPCAT", name: "Popcat", emoji: "🐱", logoUrl: "https://dd.dexscreener.com/ds-data/tokens/solana/7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr.png?size=lg", tier: "PLATINUM", listedMin: 22, tax: 0, holders: 96000, price: 0.94, chg24h: 22.7, mcap: 924000000, liq: 12800000, vol24h: 41000000, buyShare: 0.6, tx24h: 52000 },
  { chain: "solana", address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", sym: "$JUP", name: "Jupiter", emoji: "🪐", logoUrl: "https://dd.dexscreener.com/ds-data/tokens/solana/JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN.png?size=lg", tier: "SILVER", listedMin: 320, tax: 0, holders: 640000, price: 0.78, chg24h: -3.4, mcap: 1050000000, liq: 18000000, vol24h: 34000000, buyShare: 0.47, tx24h: 44000 },
  { chain: "solana", address: "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5", sym: "$MEW", name: "cat in a dogs world", emoji: "🐈", logoUrl: "https://dd.dexscreener.com/ds-data/tokens/solana/MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5.png?size=lg", tier: "XPRESS", listedMin: 130, tax: 0, holders: 128000, price: 0.0079, chg24h: 17.8, mcap: 700000000, liq: 9600000, vol24h: 26000000, buyShare: 0.58, tx24h: 30000 },
  { chain: "ethereum", address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933", sym: "$PEPE", name: "Pepe", emoji: "🐸", logoUrl: "https://dd.dexscreener.com/ds-data/tokens/ethereum/0x6982508145454ce325ddbe47a25d4ec3d2311933.png?size=lg", tier: "DIAMOND", trendingRank: 2, listedMin: 61, tax: 0, holders: 428000, price: 0.0000119, chg24h: 8.9, mcap: 5000000000, liq: 42000000, vol24h: 210000000, buyShare: 0.54, tx24h: 61000, twitter: "https://x.com/pepecoineth" },
  { chain: "ethereum", address: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", sym: "$SHIB", name: "Shiba Inu", emoji: "🐕", logoUrl: "https://dd.dexscreener.com/ds-data/tokens/ethereum/0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce.png?size=lg", tier: "GOLD", listedMin: 540, tax: 0, holders: 1350000, price: 0.0000131, chg24h: 2.1, mcap: 7700000000, liq: 38000000, vol24h: 128000000, buyShare: 0.5, tx24h: 39000 },
  { chain: "ethereum", address: "0xaaeE1A9723aaDB7afA2810263653A34bA2C21C7a", sym: "$MOG", name: "Mog Coin", emoji: "😼", logoUrl: "https://dd.dexscreener.com/ds-data/tokens/ethereum/0xaaee1a9723aadb7afa2810263653a34ba2c21c7a.png?size=lg", tier: "PLATINUM", listedMin: 210, tax: 0, holders: 42000, price: 0.0000018, chg24h: 31.5, mcap: 700000000, liq: 9200000, vol24h: 28000000, buyShare: 0.62, tx24h: 21000 },
  { chain: "ethereum", address: "0xA35923162C49cF95e6BF26623385eb431ad920D3", sym: "$TURBO", name: "Turbo", emoji: "🐸", logoUrl: "https://dd.dexscreener.com/ds-data/tokens/ethereum/0xa35923162c49cf95e6bf26623385eb431ad920d3.png?size=lg", tier: "BRONZE", listedMin: 40, tax: 0, holders: 58000, price: 0.0061, chg24h: 26.3, mcap: 420000000, liq: 7100000, vol24h: 19000000, buyShare: 0.63, tx24h: 17000 },
  { chain: "base", address: "0x532f27101965dd16442E59d40670FaF5eBB142E4", sym: "$BRETT", name: "Brett", emoji: "🔵", logoUrl: "https://dd.dexscreener.com/ds-data/tokens/base/0x532f27101965dd16442e59d40670faf5ebb142e4.png?size=lg", tier: "DIAMOND", listedMin: 33, tax: 0, holders: 118000, price: 0.089, chg24h: 15.2, mcap: 880000000, liq: 14000000, vol24h: 36000000, buyShare: 0.58, tx24h: 27000, twitter: "https://x.com/basedbrett" },
  { chain: "base", address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", sym: "$DEGEN", name: "Degen", emoji: "🎩", logoUrl: "https://dd.dexscreener.com/ds-data/tokens/base/0x4ed4e862860bed51a9570b96d89af5e1b0efefed.png?size=lg", tier: "SILVER", listedMin: 150, tax: 0, holders: 168000, price: 0.0072, chg24h: -6.8, mcap: 128000000, liq: 6400000, vol24h: 11000000, buyShare: 0.45, tx24h: 15000 },
  { chain: "base", address: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4", sym: "$TOSHI", name: "Toshi", emoji: "🐈", logoUrl: "https://dd.dexscreener.com/ds-data/tokens/base/0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4.png?size=lg", tier: "XPRESS", trendingRank: 5, listedMin: 12, tax: 0, holders: 88000, price: 0.00016, chg24h: 44.3, mcap: 160000000, liq: 5200000, vol24h: 18000000, buyShare: 0.66, tx24h: 19000 },
  { chain: "bsc", address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", sym: "$CAKE", name: "PancakeSwap", emoji: "🥞", logoUrl: "https://dd.dexscreener.com/ds-data/tokens/bsc/0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82.png?size=lg", tier: "GOLD", listedMin: 400, tax: 0, holders: 1600000, price: 2.34, chg24h: 1.8, mcap: 720000000, liq: 22000000, vol24h: 41000000, buyShare: 0.5, tx24h: 33000 },
  { chain: "bsc", address: "0xfb5B838b6cfEEdC2873aB27866079AC55363D37E", sym: "$FLOKI", name: "Floki", emoji: "🐺", logoUrl: "https://dd.dexscreener.com/ds-data/tokens/bsc/0xfb5b838b6cfeedc2873ab27866079ac55363d37e.png?size=lg", tier: "PLATINUM", trendingRank: 4, listedMin: 90, tax: 0, holders: 470000, price: 0.00015, chg24h: 9.4, mcap: 1450000000, liq: 16000000, vol24h: 52000000, buyShare: 0.55, tx24h: 28000 },
];

// Real socials for the well-known SEED/demo tokens, so the sample board never
// shows a token with no links. Real listings carry their own socials (from the
// listing form) and always take precedence over this map.
export const SEED_SOCIALS: Record<string, { website?: string; twitter?: string; telegram?: string }> = {
  BONK: { website: "https://bonkcoin.com", twitter: "https://x.com/bonk_inu", telegram: "https://t.me/bonk_inu" },
  WIF: { website: "https://dogwifcoin.org", twitter: "https://x.com/dogwifcoin", telegram: "https://t.me/dogwifhatcto" },
  POPCAT: { website: "https://www.popcat.click", twitter: "https://x.com/Popcatsolana" },
  JUP: { website: "https://jup.ag", twitter: "https://x.com/JupiterExchange", telegram: "https://t.me/jup_dao" },
  MEW: { website: "https://mew.xyz", twitter: "https://x.com/mew" },
  PEPE: { website: "https://www.pepe.vip", twitter: "https://x.com/pepecoineth", telegram: "https://t.me/pepecoineth" },
  SHIB: { website: "https://shibatoken.com", twitter: "https://x.com/Shibtoken", telegram: "https://t.me/ShibaInu_Dogecoinkiller" },
  MOG: { website: "https://www.mogcoin.xyz", twitter: "https://x.com/MogCoin", telegram: "https://t.me/MogCoinCommunity" },
  TURBO: { website: "https://turbotoad.com", twitter: "https://x.com/TurboToadToken", telegram: "https://t.me/turbotoadportal" },
  BRETT: { website: "https://www.basedbrett.com", twitter: "https://x.com/basedbrett", telegram: "https://t.me/BrettBaseChain" },
  DEGEN: { website: "https://www.degen.tips", twitter: "https://x.com/degentokenbase", telegram: "https://t.me/degentokenbase" },
  TOSHI: { website: "https://www.toshithecat.com", twitter: "https://x.com/Toshi_base", telegram: "https://t.me/ToshiOnBase" },
  CAKE: { website: "https://pancakeswap.finance", twitter: "https://x.com/PancakeSwap", telegram: "https://t.me/pancakeswap" },
  FLOKI: { website: "https://floki.com", twitter: "https://x.com/RealFlokiInu", telegram: "https://t.me/FLOKIVIKINGS" },
};

const PERIOD_FACTOR: Record<PeriodKey, number> = { "5m": 0.05, "1h": 0.17, "6h": 0.48, "24h": 1 };

function perPeriod(base: number): Record<PeriodKey, number> {
  return {
    "5m": base * PERIOD_FACTOR["5m"],
    "1h": base * PERIOD_FACTOR["1h"],
    "6h": base * PERIOD_FACTOR["6h"],
    "24h": base,
  };
}

/**
 * Does this tier carry the verified badge?
 *
 * Read from the tier's own `verified` flag — the same field /verified and
 * /advertise render their perk lists from. It used to be a hardcoded list here,
 * and that list said XPRESS carries the badge while packages.ts, both pricing
 * pages and verified.test.ts all say it does not. That divergence is exactly
 * what the flag was introduced to end (see the comment on ListingTierMeta), and
 * it reached real tokens: the bot's auto-lister hands out the XPRESS tier for
 * free, so every free auto-listing was flagged verified — the one badge Diamond,
 * Gold and Platinum buyers are actually paying for.
 *
 * FREE has verified:false, so an auto listing never claims it either.
 */
export const verifiedTier = (tier: ListingRow["tier"]): boolean => tierMeta(tier)?.verified ?? false;

// DexScreener's public token-image CDN — deterministic by chain+address, loaded
// browser-side. Best-effort: tokens it doesn't know 404 and the Coin component
// falls back to the emoji, so a guess is always safe.
const DS_IMG_CHAIN: Record<string, string> = {
  solana: "solana",
  ethereum: "ethereum",
  base: "base",
  bsc: "bsc",
  tron: "tron",
};
export function fallbackLogoUrl(chain: string, address: string): string | null {
  const slug = DS_IMG_CHAIN[chain];
  if (!slug || !address) return null;
  const addr = address.startsWith("0x") ? address.toLowerCase() : address;
  return `https://dd.dexscreener.com/ds-data/tokens/${slug}/${addr}.png?size=lg`;
}

/** Pure map from a listing row (seed or admin-managed store record) to a
 *  BoardToken. The provider layer enriches the result with live market data. */
export function rowToBoardToken(r: ListingRow): BoardToken {
  const v = visualFor(r.sym);
  const txns = {} as BoardToken["txns"];
  (Object.keys(PERIOD_FACTOR) as PeriodKey[]).forEach((p) => {
    const total = Math.round(r.tx24h * PERIOD_FACTOR[p]);
    const buys = Math.round(total * r.buyShare);
    txns[p] = { buys, sells: Math.max(total - buys, 0) };
  });
  const chg = perPeriod(r.chg24h);
  const vol = perPeriod(r.vol24h);
  const score = dexvraScore({ chg, liq: r.liq, taxPct: r.tax, txns, holders: r.holders });
  return {
    key: `${r.chain}:${r.address}`,
    chain: r.chain,
    address: r.address,
    symbol: r.sym,
    name: r.name,
    logoUrl: r.logoUrl ?? fallbackLogoUrl(r.chain, r.address),
    emoji: r.emoji,
    gradient: v.gradient,
    priceUsd: r.price,
    mcap: r.mcap,
    liq: r.liq,
    chg,
    vol,
    txns,
    holders: r.holders,
    taxPct: r.tax,
    ageMinutes: null,
    trend: syntheticTrend(r.sym, r.chg24h),
    verified: verifiedTier(r.tier),
    source: "seed",
    tier: r.tier,
    trendingRank: r.trendingRank ?? null,
    // Seed/demo tokens are long-standing coins, not fresh paid listings — age
    // them past the 48h tier-tag window (+3 days) so they carry NO tier badge
    // (only genuinely recent real listings do). Real rows use their real time.
    listedMinutesAgo: r.listedAt ? Math.max(0, Math.floor((Date.now() - r.listedAt) / 60000)) : r.listedMin + 4320,
    score,
    poolAddress: null,
    // Only REAL socials: the listing's own (always wins), else the known-good
    // seed map for demo tokens. Never a fabricated dexscreener/X-search link —
    // the UI hides any icon whose link is missing.
    links: (() => {
      const s = SEED_SOCIALS[r.sym.replace(/^\$/, "").toUpperCase()] ?? {};
      return {
        website: r.website ?? s.website ?? null,
        twitter: r.twitter ?? s.twitter ?? null,
        telegram: r.telegram ?? s.telegram ?? null,
      };
    })(),
    overview: r.overview ?? null,
  };
}

export function rowsToBoardTokens(rows: ListingRow[]): BoardToken[] {
  return rows.map(rowToBoardToken);
}

/** Addresses grouped by chain — the provider fetches live data for exactly
 *  these (the paid listings), never the whole chain. */
export function rowsToAddressesByChain(rows: ListingRow[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.chain] ??= []).push(r.address);
  return out;
}
