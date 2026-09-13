import { CHAINS } from "@/config/chains";
import type { ListingRow } from "./listings";
import type { ListingTier } from "./types";

export const TIER_KEYS: ListingTier[] = ["DIAMOND", "GOLD", "PLATINUM", "SILVER", "BRONZE", "XPRESS", "FREE"];
const isTier = (x: unknown): x is ListingTier => typeof x === "string" && (TIER_KEYS as string[]).includes(x);

const URL_RE = /^https?:\/\/[^\s]+$/i;
// Logo may be a full https URL OR a same-origin uploaded file (served by
// /api/media/<24hex>.<ext>).
const LOGO_RE = /^(https?:\/\/[^\s]+|\/api\/media\/[a-f0-9]{24}\.(png|jpe?g|webp|gif))$/i;
const NUM_FIELDS = ["tax", "holders", "price", "chg24h", "mcap", "liq", "vol24h", "buyShare", "tx24h", "listedMin"] as const;

const num = (x: unknown, d: number): number => (Number.isFinite(Number(x)) ? Number(x) : d);
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

export interface ListingInput {
  chain?: string;
  address?: string;
  sym?: string;
  name?: string;
  emoji?: string;
  tier?: string;
  trendingRank?: number | null;
  logoUrl?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  overview?: string;
  tax?: number;
  holders?: number;
  price?: number;
  chg24h?: number;
  mcap?: number;
  liq?: number;
  vol24h?: number;
  buyShare?: number;
  tx24h?: number;
  listedMin?: number;
  trendStart?: number;
  trendExp?: number;
}

/** Optional non-negative integer (epoch ms / rank); undefined when absent. */
const optInt = (x: unknown): number | undefined =>
  x != null && Number.isFinite(Number(x)) ? Math.max(0, Math.round(Number(x))) : undefined;

type BuildResult = { ok: true; row: ListingRow } | { ok: false; error: string };

/** Validate + normalize a full new listing (admin add or public submission). */
export function buildRow(input: ListingInput): BuildResult {
  const chain = String(input.chain ?? "").trim();
  if (!CHAINS[chain]) return { ok: false, error: "Unknown chain" };

  const address = String(input.address ?? "").trim();
  if (!CHAINS[chain].addressPattern.test(address)) {
    return { ok: false, error: `Invalid ${CHAINS[chain].label} contract address` };
  }

  const symRaw = String(input.sym ?? "").trim().replace(/^\$+/, "").toUpperCase();
  // Allow Unicode LETTERS + DIGITS (so CJK/Cyrillic meme tickers like $旺旺 list,
  // not just ASCII) plus . _ - — but still reject whitespace, markup (< > & …),
  // emoji, and control/format chars (zero-width, bidi overrides). \p{L}\p{N}
  // covers real scripts; the excluded classes are exactly the ones that could
  // break escaped rendering on the site or in the signal wire.
  if (!symRaw || symRaw.length > 24 || !/^[\p{L}\p{N}._-]+$/u.test(symRaw)) {
    return { ok: false, error: "Invalid ticker" };
  }

  for (const [v, label] of [
    [input.website, "website"],
    [input.twitter, "X"],
    [input.telegram, "Telegram"],
  ] as const) {
    if (v && !URL_RE.test(String(v))) return { ok: false, error: `${label} must be a full https:// URL` };
  }
  if (input.logoUrl && !LOGO_RE.test(String(input.logoUrl))) {
    return { ok: false, error: "Logo must be an https image URL or an uploaded file" };
  }

  const row: ListingRow = {
    chain,
    address,
    sym: `$${symRaw}`,
    name: String(input.name ?? "").trim().slice(0, 60) || symRaw,
    emoji: String(input.emoji ?? "").trim().slice(0, 4) || "🪙",
    tier: isTier(input.tier) ? input.tier : "BRONZE",
    trendingRank:
      input.trendingRank == null ? undefined : Math.max(1, Math.round(num(input.trendingRank, 1))),
    trendStart: optInt(input.trendStart),
    trendExp: optInt(input.trendExp),
    listedMin: Math.max(0, Math.round(num(input.listedMin, 0))),
    tax: clamp(num(input.tax, 0), 0, 100),
    holders: Math.max(0, Math.round(num(input.holders, 0))),
    price: Math.max(0, num(input.price, 0)),
    chg24h: num(input.chg24h, 0),
    mcap: Math.max(0, num(input.mcap, 0)),
    liq: Math.max(0, num(input.liq, 0)),
    vol24h: Math.max(0, num(input.vol24h, 0)),
    buyShare: clamp(num(input.buyShare, 0.5), 0, 1),
    tx24h: Math.max(0, Math.round(num(input.tx24h, 0))),
    logoUrl: input.logoUrl ? String(input.logoUrl) : undefined,
    website: input.website ? String(input.website) : undefined,
    twitter: input.twitter ? String(input.twitter) : undefined,
    telegram: input.telegram ? String(input.telegram) : undefined,
    overview:
      typeof input.overview === "string"
        ? Array.from(input.overview.replace(/\s+/g, " ").trim()).slice(0, 600).join("") || undefined
        : undefined,
  };
  return { ok: true, row };
}

/** Sanitize a partial edit (admin PATCH). chain/address are immutable here. */
export function sanitizePatch(body: Record<string, unknown>): Partial<ListingRow> {
  const out: Partial<ListingRow> = {};
  if (typeof body.name === "string" && body.name.trim()) out.name = body.name.trim().slice(0, 60);
  if (typeof body.emoji === "string") out.emoji = body.emoji.trim().slice(0, 4) || "🪙";
  if (isTier(body.tier)) out.tier = body.tier;
  if (body.overview === null || body.overview === "") out.overview = undefined;
  else if (typeof body.overview === "string") {
    out.overview = Array.from(body.overview.replace(/\s+/g, " ").trim()).slice(0, 600).join("") || undefined;
  }

  if (body.trendingRank === null || body.trendingRank === "") {
    out.trendingRank = undefined;
  } else if (body.trendingRank != null && Number.isFinite(Number(body.trendingRank))) {
    out.trendingRank = Math.max(1, Math.round(Number(body.trendingRank)));
  }

  // Trending-window timestamps: null/"" clears, a finite number sets.
  for (const k of ["trendStart", "trendExp"] as const) {
    const v = body[k];
    if (v === null || v === "") out[k] = undefined;
    else if (v != null && Number.isFinite(Number(v))) out[k] = Math.max(0, Math.round(Number(v)));
  }

  for (const k of ["website", "twitter", "telegram"] as const) {
    const v = body[k];
    if (typeof v === "string") {
      if (v === "") out[k] = undefined;
      else if (URL_RE.test(v)) out[k] = v;
    }
  }
  if (typeof body.logoUrl === "string") {
    if (body.logoUrl === "") out.logoUrl = undefined;
    else if (LOGO_RE.test(body.logoUrl)) out.logoUrl = body.logoUrl;
  }

  for (const k of NUM_FIELDS) {
    const v = body[k];
    if (v != null && Number.isFinite(Number(v))) {
      (out as Record<string, number>)[k] = Number(v);
    }
  }
  return out;
}
