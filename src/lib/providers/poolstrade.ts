import type { LiveMarket } from "./geckoterminal";
import type { PeriodKey, TxSplit } from "@/lib/types";

// pools.trade — the Robinhood Chain launchpad.
//
// WHY THE SITE NEEDS IT
// Every other provider here is a general indexer: it knows a token once that
// token has a liquidity pool. A launch that is still on its bonding curve has
// no pool, so GeckoTerminal returns nothing for it — and a freshly listed
// Robinhood token therefore rendered with its fallback figures (the numbers
// captured at listing time) until it graduated, which can be days. pools.trade
// is the launchpad itself, so it knows those tokens from block one.
//
// It runs as a FALLBACK, never a replacement: GeckoTerminal is asked first and
// wins wherever it answers (it has the per-period stats and the pool address
// the chart embed needs). pools.trade fills in the listings GT left empty.
//
// THE REQUEST SHAPE IS CONFIGURABLE ON PURPOSE. pools.trade indexes through
// Uniswap's launches API, which is not published as a stable public contract.
// Baking a guess into a deployed build would mean a redeploy to fix a renamed
// field, so the base URL, path, body and envelope key are all env vars, and the
// parser accepts every plausible spelling of the fields it reads.

const env = (k: string, d: string) => (process.env[k] || "").trim() || d;

const BASE = env("POOLS_TRADE_API", "https://interface.gateway.uniswap.org/v2").replace(/\/+$/, "");
const LIST_PATH = env("POOLS_TRADE_LIST_PATH", "data.v2.DataApiService/ListLaunches").replace(/^\/+/, "");
const CHAIN_ID = Number(env("POOLS_TRADE_CHAIN_ID", "4663"));
const CONTRACTS = env("POOLS_TRADE_CONTRACTS", "uniswap-cca,uniswap-bonding-curve")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const PAGE_SIZE = Math.min(500, Math.max(1, Number(env("POOLS_TRADE_PAGE_SIZE", "100")) || 100));
// 6, not the original 3: the feed is newest-first, so the window IS how old a
// still-bonding listing may be and remain priceable. At 3 pages a 1–2 day old
// listing on a busy launchpad had scrolled past the newest 300, GT had not
// indexed its pool yet, Robinhood has no DexScreener — and a token trading
// fine read as "no market anywhere", i.e. the New Listings dash. Each extra
// page is one POST per refresh cycle, and only when a cursor continues.
const MAX_PAGES = Math.min(20, Math.max(1, Number(env("POOLS_TRADE_MAX_PAGES", "6")) || 6));
const TIMEOUT_MS = Math.max(2000, Number(env("POOLS_TRADE_TIMEOUT_MS", "9000")) || 9000);
const SITE = env("POOLS_TRADE_SITE", "https://pools.trade").replace(/\/+$/, "");

/** Our chain id for everything pools.trade returns — it is a single-chain launchpad. */
export const POOLS_TRADE_CHAIN = env("POOLS_TRADE_OUR_CHAIN", "robinhood");

/** Read-only market metadata; disable with POOLS_TRADE_ENABLED=0. */
export const POOLS_TRADE_ENABLED = env("POOLS_TRADE_ENABLED", "1") !== "0";

/** A launch as pools.trade describes it, normalized. */
export interface PoolsLaunch {
  chain: string;
  address: string;
  name: string | null;
  symbol: string | null;
  logoUrl: string | null;
  priceUsd: number | null;
  mcap: number | null;
  liq: number | null;
  vol24h: number | null;
  chg24h: number | null;
  holders: number | null;
  createdAt: number | null;
  /** Curve state, for the "still bonding" badge. null = the API did not say. */
  graduated: boolean | null;
  progressPct: number | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  launchUrl: string;
}

// ── tolerant extraction ──────────────────────────────────────────────────────

type Json = unknown;

function at(obj: Json, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function pick(obj: Json, paths: string[]): unknown {
  for (const p of paths) {
    const v = at(obj, p);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

const str = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).trim();
  return s || null;
};

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[, _]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// ms epoch / s epoch / ISO-8601. Below 1e11 is seconds (1e11 ms is the year 5138).
function toMs(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d+$/.test(String(v).trim())) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

// Links come from whoever deployed the token and end up in an href on a public
// page. http(s) only — a javascript: or data: URL never reaches the DOM.
function safeUrl(v: unknown): string | null {
  const s = str(v);
  if (!s || s.length > 300) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

function socialUrl(v: unknown, base: string): string | null {
  const s = str(v);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return safeUrl(s);
  const handle = s.replace(/^@/, "");
  return /^[A-Za-z0-9_.]{1,40}$/.test(handle) ? `${base}/${handle}` : null;
}

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/** One raw record → a PoolsLaunch, or null when it carries no usable address. */
export function normalizeLaunch(raw: unknown): PoolsLaunch | null {
  if (!raw || typeof raw !== "object") return null;
  const address = str(
    pick(raw, [
      "address",
      "tokenAddress",
      "token_address",
      "contractAddress",
      "contract_address",
      "token.address",
      "token.id",
      "asset.address",
      "id",
    ]),
  );
  if (!address || !ADDRESS.test(address)) return null;

  // Believe the record over our assumption: the request asks for one chain, but the API
  // is not obliged to honour that filter and POOLS_TRADE_BODY can replace the request
  // wholesale. A foreign token stamped with POOLS_TRADE_CHAIN would render on the public
  // board with the wrong chain badge, explorer link and buy deeplink.
  const declared = num(pick(raw, ["chainId", "chain_id", "chainID", "chain.id", "network.chainId", "token.chainId"]));
  if (declared != null && declared !== CHAIN_ID) return null;

  let progressPct = num(
    pick(raw, ["progressPct", "graduationProgress", "bondingCurveProgress", "curve.progressPct", "progress"]),
  );
  // A 0..1 fraction and a 0..100 percentage are both common spellings.
  if (progressPct != null && progressPct > 0 && progressPct <= 1) progressPct *= 100;
  if (progressPct != null) progressPct = Math.max(0, Math.min(100, progressPct));

  const gradRaw = pick(raw, ["graduated", "isGraduated", "hasGraduated", "curve.graduated", "bondingCurve.graduated"]);

  return {
    chain: POOLS_TRADE_CHAIN,
    address,
    name: str(pick(raw, ["name", "token.name", "metadata.name", "tokenName"])),
    symbol: str(pick(raw, ["symbol", "ticker", "token.symbol", "metadata.symbol", "tokenSymbol"])),
    logoUrl: safeUrl(pick(raw, ["logoUrl", "logo", "imageUrl", "image", "icon", "token.logoUrl", "metadata.image"])),
    priceUsd: num(pick(raw, ["priceUsd", "price_usd", "price.usd", "usdPrice"])),
    mcap: num(
      pick(raw, ["marketCapUsd", "market_cap_usd", "marketCap", "market_cap", "marketCap.usd", "fdvUsd", "fdv_usd", "fdv"]),
    ),
    liq: num(pick(raw, ["liquidityUsd", "liquidity_usd", "liquidity.usd", "liquidity", "reserveUsd", "tvlUsd"])),
    vol24h: num(
      pick(raw, ["volume24hUsd", "volume_24h_usd", "volume24h", "volume.h24", "volumeUsd24h", "stats.volume24h"]),
    ),
    chg24h: num(pick(raw, ["priceChange24h", "price_change_24h", "priceChange.h24", "change24h", "stats.priceChange24h"])),
    holders: num(pick(raw, ["holders", "holderCount", "holder_count", "stats.holders"])),
    createdAt: toMs(
      pick(raw, ["createdAt", "created_at", "launchedAt", "launch_time", "createdAtTimestamp", "timestamp", "blockTimestamp"]),
    ),
    graduated: gradRaw === undefined ? null : Boolean(gradRaw),
    progressPct,
    website: safeUrl(pick(raw, ["links.website", "website", "metadata.website", "socials.website", "url"])),
    twitter: socialUrl(
      pick(raw, ["links.twitter", "twitter", "links.x", "metadata.twitter", "socials.twitter", "twitterHandle"]),
      "https://x.com",
    ),
    telegram: socialUrl(
      pick(raw, ["links.telegram", "telegram", "metadata.telegram", "socials.telegram", "telegramHandle"]),
      "https://t.me",
    ),
    launchUrl: `${SITE}/token/${address}`,
  };
}

const LIST_KEYS = env("POOLS_TRADE_LIST_KEY", "launches,tokens,items,data,results,pools,records")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function extractList(json: Json): unknown[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== "object") return [];
  for (const k of LIST_KEYS) {
    const v = at(json, k);
    if (Array.isArray(v) && v.length) return v;
  }
  // An envelope key we have not seen: take the first array-of-objects value.
  for (const v of Object.values(json as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
  }
  return [];
}

const nextCursor = (json: Json): string | null =>
  str(pick(json ?? {}, ["nextCursor", "next_cursor", "cursor", "page.nextCursor", "pageInfo.endCursor", "nextPageToken"]));

export function buildBody(cursor?: string | null): Record<string, unknown> {
  const custom = env("POOLS_TRADE_BODY", "");
  let body: Record<string, unknown> | null = null;
  if (custom) {
    try {
      const parsed: unknown = JSON.parse(custom);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      body = null; // a malformed override falls back to the default shape
    }
  }
  if (!body) body = { chainId: CHAIN_ID, contracts: CONTRACTS, pageSize: PAGE_SIZE };
  return cursor ? { ...body, cursor } : body;
}

async function fetchPage(cursor: string | null): Promise<Json> {
  const res = await fetch(`${BASE}/${LIST_PATH}`, {
    method: env("POOLS_TRADE_METHOD", "POST"),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(buildBody(cursor)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`pools.trade ${res.status}`);
  return res.json();
}

/**
 * Every launch pools.trade knows about, newest first where the API says so.
 * Throws on a first-page failure so the caller can fall back — matching
 * fetchListedMarket's contract; a later-page failure keeps what it has.
 */
export async function fetchLaunches(): Promise<PoolsLaunch[]> {
  if (!POOLS_TRADE_ENABLED) return [];
  const out: PoolsLaunch[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let json: Json;
    try {
      json = await fetchPage(cursor);
    } catch (e) {
      if (page === 0) throw e;
      break;
    }
    const rows = extractList(json);
    if (!rows.length) break;
    for (const raw of rows) {
      const rec = normalizeLaunch(raw);
      if (!rec) continue;
      const key = rec.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rec);
    }
    cursor = nextCursor(json);
    if (!cursor) break;
  }
  return out;
}

const ZERO_TX: Record<PeriodKey, TxSplit> = {
  "5m": { buys: 0, sells: 0 },
  "1h": { buys: 0, sells: 0 },
  "6h": { buys: 0, sells: 0 },
  "24h": { buys: 0, sells: 0 },
};

/**
 * A launch as the board's LiveMarket shape, so a pools.trade-sourced token
 * renders through exactly the same path as a GeckoTerminal one.
 *
 * The launchpad reports one 24h window, not the 5m/1h/6h/24h breakdown GT gives.
 * Rather than invent the missing periods — a fabricated 5m change would drive
 * the score and the movers board — only the 24h slot carries a number and the
 * rest read zero. That is honest: no data, no movement claimed.
 */
export function launchToMarket(l: PoolsLaunch): LiveMarket | null {
  if (l.priceUsd == null || l.priceUsd <= 0) return null;
  const zero = { "5m": 0, "1h": 0, "6h": 0, "24h": 0 } as Record<PeriodKey, number>;
  return {
    priceUsd: l.priceUsd,
    mcap: l.mcap,
    liq: l.liq,
    chg: { ...zero, "24h": l.chg24h ?? 0 },
    vol: { ...zero, "24h": l.vol24h ?? 0 },
    txns: ZERO_TX,
    ageMinutes: l.createdAt ? Math.max(0, Math.round((Date.now() - l.createdAt) / 60000)) : null,
    logoUrl: l.logoUrl,
    // No pool while a token is still on its bonding curve — the chart embed
    // needs a real pool address and must show nothing rather than a bad one.
    poolAddress: null,
  };
}

/**
 * Live market data for specific listed addresses on the pools.trade chain,
 * keyed by lowercased address — the same contract as fetchListedMarket, so the
 * provider layer can treat the two sources interchangeably.
 */
export async function fetchLaunchMarket(chainId: string, addresses: string[]): Promise<Map<string, LiveMarket>> {
  const out = new Map<string, LiveMarket>();
  if (chainId !== POOLS_TRADE_CHAIN || addresses.length === 0) return out;
  const want = new Set(addresses.map((a) => a.toLowerCase()));
  for (const l of await fetchLaunches()) {
    const key = l.address.toLowerCase();
    if (!want.has(key)) continue;
    const m = launchToMarket(l);
    if (m) out.set(key, m);
  }
  return out;
}
