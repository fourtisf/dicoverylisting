// Package catalogue — mirrors the website's src/lib/packages.ts EXACTLY.
// Keep the two in sync (the web renders the same prices on /advertise). Prices
// are billed in each chain's native coin; trending/banner rows are per native
// symbol. Durations are strings; durationToHours() converts for expiry math.
const { nativeOf, payNativeOf } = require("./chains");

// ── Listing tiers (the tag every listed token carries) ───────────────────────
// rank 1 = Diamond … 5 = Bronze; 0 = Xpress (instant, unranked). announce=true
// tiers get an @announcement post. Prices keyed by native symbol.
const LISTING_TIERS = [
  { key: "DIAMOND", rank: 1, label: "Diamond", glyph: "◆", color: "#8FE3FF", emoji: "💎", announce: true, instant: false,
    price: { BNB: 1.5, SOL: 5, ETH: 0.26, TON: 250, TRX: 5000 },
    blurb: "Diamond · Tier #1 — top listing placement, verified badge, announcement post." },
  { key: "GOLD", rank: 2, label: "Gold", glyph: "★", color: "#E7C77A", emoji: "🥇", announce: true, instant: false,
    price: { BNB: 1.25, SOL: 4.5, ETH: 0.24, TON: 225, TRX: 4500 },
    blurb: "Gold · Tier #2 — high placement, verified badge, announcement post." },
  { key: "PLATINUM", rank: 3, label: "Platinum", glyph: "◈", color: "#D8DEE9", emoji: "🏆", announce: true, instant: false,
    price: { BNB: 1.15, SOL: 4, ETH: 0.22, TON: 200, TRX: 4000 },
    blurb: "Platinum · Tier #3 — priority placement, verified badge, announcement post." },
  { key: "SILVER", rank: 4, label: "Silver", glyph: "●", color: "#AAB2BD", emoji: "🥈", announce: false, instant: false,
    price: { BNB: 1, SOL: 3.5, ETH: 0.2, TON: 175, TRX: 3500 },
    blurb: "Silver · Tier #4 — standard listing on the board & discovery." },
  { key: "BRONZE", rank: 5, label: "Bronze", glyph: "●", color: "#CB8E5E", emoji: "🥉", announce: false, instant: false,
    price: { BNB: 0.75, SOL: 3, ETH: 0.18, TON: 150, TRX: 3000 },
    blurb: "Bronze · Tier #5 — entry listing on the board & discovery." },
  { key: "XPRESS", rank: 0, label: "Xpress", glyph: "⚡", color: "#4CC7D4", emoji: "⚡", announce: false, instant: true,
    price: { ETH: 0.06, SOL: 1, BNB: 0.25, TON: 40, TRX: 900 },
    blurb: "Xpress — instant activation, live on the dexvra.io board + listing alert, priority verification." },
];

const TIER_MAP = Object.fromEntries(LISTING_TIERS.map((t) => [t.key, t]));
const tierMeta = (key) => TIER_MAP[key] || null;
const tierLabel = (key) => TIER_MAP[key]?.label ?? key;
const tierColor = (key) => TIER_MAP[key]?.color ?? "#AAB2BD";
const tierGlyph = (key) => TIER_MAP[key]?.glyph ?? "●";
const tierEmoji = (key) => TIER_MAP[key]?.emoji ?? "🪙";
const tierRank = (key) => TIER_MAP[key]?.rank ?? 0;
const tierAnnounces = (key) => Boolean(TIER_MAP[key]?.announce);

/** Native-coin price of a tier on a given chain (e.g. Diamond on Solana → 5).
 *  Priced in the chain's PAY currency — Sui listings pay in BNB, Plasma in ETH. */
const tierPrice = (key, chain) => {
  const m = TIER_MAP[key];
  if (!m) return null;
  return m.price[payNativeOf(chain)] ?? null;
};

// The 5 ranked tiers (Listing & Trending flow) vs the single instant Xpress.
const RANKED_TIERS = LISTING_TIERS.filter((t) => t.rank > 0);
const XPRESS_TIER = TIER_MAP.XPRESS;

// ── Trending packages (time-boxed featured slots) ────────────────────────────
const TRENDING = {
  BNB: [
    { duration: "3H", price: 0.25, discount: 0 },
    { duration: "6H", price: 0.5, discount: 0 },
    { duration: "12H", price: 0.9, discount: 10 },
    { duration: "18H", price: 1.2, discount: 20 },
    { duration: "24H", price: 1.5, discount: 25 },
    { duration: "48H", price: 2.8, discount: 30 },
  ],
  ETH: [
    { duration: "6H", price: 0.1, discount: 0 },
    { duration: "12H", price: 0.18, discount: 10 },
    { duration: "16H", price: 0.23, discount: 15 },
    { duration: "18H", price: 0.24, discount: 20 },
    { duration: "24H", price: 0.3, discount: 25 },
    { duration: "48H", price: 0.56, discount: 30 },
  ],
  SOL: [
    { duration: "6H", price: 1.25, discount: 0 },
    { duration: "12H", price: 2.25, discount: 10 },
    { duration: "18H", price: 3.2, discount: 15 },
    { duration: "24H", price: 4, discount: 20 },
    { duration: "48H", price: 7.5, discount: 25 },
  ],
  TRX: [
    { duration: "6H", price: 1250, discount: 0 },
    { duration: "12H", price: 2375, discount: 5 },
    { duration: "16H", price: 3000, discount: 10 },
    { duration: "24H", price: 4250, discount: 15 },
    { duration: "48H", price: 8000, discount: 20 },
  ],
  TON: [
    { duration: "6H", price: 40, discount: 0 },
    { duration: "12H", price: 72, discount: 10 },
    { duration: "18H", price: 100, discount: 15 },
    { duration: "24H", price: 130, discount: 20 },
    { duration: "48H", price: 240, discount: 25 },
  ],
};
// Priced in the chain's PAY currency (Sui → BNB table, Plasma → ETH table).
const trendingForChain = (chain) => TRENDING[payNativeOf(chain)] ?? TRENDING.SOL;

/** What one duration costs in EVERY currency that offers it — the shape
 *  payOptionsFor() reads, so a buyer can settle a trending slot in ETH.
 *
 *  ⚠️ THE DURATIONS ARE NOT THE SAME ACROSS CURRENCIES, which is why this
 *  filters rather than assuming: the ETH table has no 3H row and the BNB table
 *  no 16H, so a currency offered for a duration it cannot price would arm an
 *  order for `undefined`. A currency missing here is simply not offered.
 *
 *  `discountPct` is the renewal cut (trendingUpsell), applied to every currency
 *  alike — a renewal that was 20% off in BNB must not become full price in ETH.
 */
const trendingPrices = (duration, discountPct = 0) => {
  const want = String(duration).trim().toUpperCase();
  const out = {};
  for (const [native, rows] of Object.entries(TRENDING)) {
    const row = rows.find((r) => String(r.duration).toUpperCase() === want);
    if (!row) continue;
    const price = Number(row.price) * (1 - (Number(discountPct) || 0) / 100);
    out[native] = Number(price.toFixed(6));
  }
  return out;
};

/** "3H" → 3, "48H" → 48. */
const durationToHours = (d) => {
  const m = /^(\d+)\s*H$/i.exec(String(d).trim());
  return m ? Number(m[1]) : 0;
};
/** 24H & 48H trending runs are posted to the announcement channel. */
const trendingAnnounces = (duration) => /^(24|48)H$/i.test(String(duration).trim());

// ── Banner ads (billed in USD by run length) ─────────────────────────────────
// The homepage sizes each tile from the CREATIVE, so these numbers decide how
// big an ad looks on the site — not any CSS. Tuned against the competition:
// The ad row is a 4-COLUMN grid: a Wide takes 2 columns (left), a Standard 1
// (right). At those widths 2.5:1 and 5:1 both land ~145px tall — the same share
// of the row the rest of the market runs. 728 × 90 was far too thin (~72px, a
// footnote); the same card ratios on an earlier 2-column grid overshot to
// ~250px. A Wide is exactly two Standards wide, at the same height.
// Changing these numbers changes what advertisers upload — keep them in sync
// with src/lib/packages.ts and the SLOTS map in /api/admin/banners.
const BANNERS = [
  {
    name: "Standard Banner", size: "600 × 240", key: "standard",
    rows: [
      { duration: "1 Day", hours: 24, usd: 225, discount: 10 },
      { duration: "3 Days", hours: 72, usd: 670, discount: 20 },
      { duration: "7 Days", hours: 168, usd: 1220, discount: 30 },
    ],
  },
  {
    name: "Wide Banner", size: "1200 × 240", key: "wide",
    rows: [
      { duration: "1 Day", hours: 24, usd: 400, discount: 10 },
      { duration: "3 Days", hours: 72, usd: 1080, discount: 20 },
      { duration: "7 Days", hours: 168, usd: 2205, discount: 30 },
    ],
  },
];
const bannerByKey = (key) => BANNERS.find((b) => b.key === key) || null;

// Bundled Trending feature (hours) granted with each Listing purchase — this is
// the "& Trending" in "Listing & Trending". Mirrors the fourtis listTrendPlans
// durations. Xpress is listing-ONLY: no trending slot, no trending-channel post
// (operator decision 2026-07 — "xpress only gets listing alert + website").
const TIER_TREND_HOURS = { DIAMOND: 48, GOLD: 24, PLATINUM: 18, SILVER: 12, BRONZE: 6, XPRESS: 0 };
const tierTrendingHours = (key) => TIER_TREND_HOURS[key] || 0;

// ── Formatting ───────────────────────────────────────────────────────────────
const fmtAmount = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6))));
const fmtNative = (n, sym) => `${fmtAmount(n)} ${sym}`;
const fmtUsd = (n) => `$${Number(n).toLocaleString("en-US")}`;

module.exports = {
  LISTING_TIERS, TIER_MAP, RANKED_TIERS, XPRESS_TIER,
  tierMeta, tierLabel, tierColor, tierGlyph, tierEmoji, tierRank, tierAnnounces, tierPrice,
  TRENDING, trendingForChain, trendingPrices, durationToHours, trendingAnnounces,
  BANNERS, bannerByKey,
  TIER_TREND_HOURS, tierTrendingHours,
  fmtAmount, fmtNative, fmtUsd,
};
