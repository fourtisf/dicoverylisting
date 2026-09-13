export type PeriodKey = "5m" | "1h" | "6h" | "24h";
export const PERIOD_KEYS: PeriodKey[] = ["5m", "1h", "6h", "24h"];

export interface TxSplit {
  buys: number;
  sells: number;
}

// Listing packages (the tag every listed token carries). Ranked #1 Diamond →
// #5 Bronze, plus Xpress (instant, unranked). Pricing lives in lib/packages.ts.
// "FREE" is NOT a package anyone can buy — it marks a token the bot auto-listed
// when it climbed past the operator's market-cap threshold. It is deliberately
// absent from LISTING_TIERS (the pricing UI iterates that), so it can never show
// up for sale, while still carrying its own badge instead of impersonating a
// paid Bronze listing.
export type ListingTier = "DIAMOND" | "GOLD" | "PLATINUM" | "SILVER" | "BRONZE" | "XPRESS" | "FREE";

export interface BoardToken {
  key: string; // `${chain}:${address}` — stable identity across refreshes
  chain: string;
  address: string;
  symbol: string; // display form, "$"-prefixed
  name: string;
  logoUrl: string | null;
  emoji: string; // fallback visual when no logoUrl
  gradient: [string, string, string];
  priceUsd: number;
  mcap: number | null;
  liq: number | null;
  chg: Record<PeriodKey, number>;
  vol: Record<PeriodKey, number>;
  txns: Record<PeriodKey, TxSplit>;
  holders: number | null;
  taxPct: number | null;
  ageMinutes: number | null;
  trend: number[]; // sparkline points, oldest → newest
  verified: boolean;
  source: "live" | "seed";
  // paid-listing model: every token on Dexvra is a paid listing
  tier: ListingTier; // listing package the project bought (the tag)
  trendingRank: number | null; // booked a Trending slot? (non-null = featured); used only as a stable sub-order within a tier — no number is shown
  listedMinutesAgo: number; // how long ago the project paid to list
  score: number; // Dexvra Score 0–100 (signal-based, not votes)
  poolAddress: string | null; // top pool — used to embed the GeckoTerminal chart
  links: { website: string | null; twitter: string | null; telegram: string | null };
  overview: string | null; // short project description (shown on the token page)
}

export interface Trade {
  ts: number; // unix seconds
  kind: "buy" | "sell";
  usd: number;
  amount: number; // base token amount
  price: number;
  trader: string;
}

export interface Signal {
  kind: "whale" | "lock" | "volume" | "listing" | "score";
  color: string;
  symbol: string;
  chain: string;
  text: string;
  minutesAgo: number;
}

export interface FearGreed {
  value: number;
  label: string;
  updatedMinutesAgo: number;
  source: "live" | "seed";
}

export interface ChainHeat {
  chain: string;
  temp: number;
  vol24h: number;
}

export interface WireItem {
  color: string;
  html: string;
  time: string;
}

export interface TokensPayload {
  /** The commit this server is running. Every check in this repo prints one,
   *  for the reason `fonts:check` learned the hard way: each round of a bug
   *  begins with somebody reading a diagnostic as a statement about the fix
   *  they just deployed. `logos:check` compares it against the checkout. */
  build: string;
  tokens: BoardToken[];
  heat: ChainHeat[];
  wire: WireItem[];
  signals: Signal[];
  trackedVol24h: number;
  live: boolean;
  updatedAt: number;
}

export interface ScanFlag {
  label: string;
  value: string;
  status: "ok" | "warn" | "bad" | "na";
}

export interface ScanResult {
  address: string;
  chain: string | null;
  name: string | null;
  symbol: string | null;
  score: number | null; // 0–100 safety; null when only basic (DexScreener) data
  scoreLabel: string; // SAFE / CAUTION / HIGH RISK / LIMITED
  flags: ScanFlag[];
  verdict: "ok" | "warn";
  verdictText: string;
  live: boolean;
  dataSource: string;
}
