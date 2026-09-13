// relative + extension, not the "@/" alias: the node:test runner resolves
// this file too (geckoterminal.test.ts), and the alias is a Next-only thing —
// the same rule every other node-tested module here already follows.
import { CHAINS } from "../../config/chains.ts";
import { gtGet, gtInCooldown } from "./gt.ts";
// `dexscreener.ts` imports only a TYPE from here, so this edge is one-way at
// runtime. `dsCovers` is the one owner of "does this chain have a second
// source" and the scheduler already orders the cycle on it.
import { dsCovers } from "./dexscreener.ts";
import type { PeriodKey, TxSplit } from "@/lib/types";

// GeckoTerminal free API (no key). We fetch live market data for a SPECIFIC
// set of listed token addresses — Dexvra is paid-listing only, so we never
// crawl the whole chain. Rate-limited: always go through the cache layer.
export interface LiveMarket {
  priceUsd: number;
  mcap: number | null;
  liq: number | null;
  chg: Record<PeriodKey, number>;
  vol: Record<PeriodKey, number>;
  txns: Record<PeriodKey, TxSplit>;
  ageMinutes: number | null;
  logoUrl: string | null;
  poolAddress: string | null; // top pool contract — for the chart embed
  /**
   * How far back the per-period stats are actually backed by data, when the
   * provider fills its window incrementally. Indexers answer for a whole day
   * and omit it; the Pons on-chain reader has to scan logs, so it says how
   * much of the window it has actually seen.
   */
  statsCoverageMinutes?: number;
}

const num = (s: unknown): number | null => {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

interface GtToken {
  id: string;
  attributes: {
    address: string;
    name: string;
    symbol: string;
    image_url: string | null;
    price_usd: string | null;
    market_cap_usd: string | null;
    fdv_usd: string | null;
    total_reserve_in_usd: string | null;
  };
  relationships?: { top_pools?: { data?: { id: string }[] } };
}
interface GtPool {
  id: string;
  attributes: {
    address?: string;
    reserve_in_usd: string | null;
    pool_created_at: string | null;
    price_change_percentage: Partial<Record<"m5" | "h1" | "h6" | "h24", string>>;
    volume_usd: Partial<Record<"m5" | "h1" | "h6" | "h24", string>>;
    transactions: Partial<Record<"m5" | "h1" | "h24", { buys: number; sells: number }>>;
  };
}

// pool id looks like "<network>_<poolAddress>"
const poolAddrOf = (pool: GtPool | undefined, id: string | undefined): string | null =>
  pool?.attributes?.address ?? (id ? id.split("_").slice(1).join("_") || null : null);

/** A sibling pool may only supply a CHANGE reading if it holds at least this
 *  share of the top pool's liquidity — a four-figure percentage off a dust
 *  pool is the thing judging by the DEEPEST pool exists to refuse. */
const CHANGE_POOL_MIN_SHARE = 0.1;

/** Borrow one change window from the deepest sibling pool that HAS it.
 *
 *  GT sends `price_change_percentage.h24: null` for a pool that has not traded
 *  in the window — a different fact from the pool not existing — so a token
 *  whose main pool was quiet lost its percentage even when a sibling pool of
 *  the same token had a good one, and the row rendered a fabricated flat. The
 *  bot repo's `changeFromPools()` rule, on the web surface: only the CHANGE
 *  falls back; price, cap and liquidity still come from the top pool alone. */
function borrowChg(top: GtPool | undefined, siblings: GtPool[], k: "m5" | "h1" | "h6" | "h24"): number | null {
  const topLiq = num(top?.attributes?.reserve_in_usd);
  if (topLiq == null || topLiq <= 0) return null; // no depth to measure the floor against
  const deep = [...siblings].sort(
    (a, b) => (num(b.attributes?.reserve_in_usd) ?? 0) - (num(a.attributes?.reserve_in_usd) ?? 0),
  );
  for (const p of deep) {
    if ((num(p.attributes?.reserve_in_usd) ?? 0) < topLiq * CHANGE_POOL_MIN_SHARE) break; // sorted — the rest are thinner
    const v = num(p.attributes?.price_change_percentage?.[k]);
    if (v != null) return v;
  }
  return null;
}

function mapMarket(
  token: GtToken,
  pool: GtPool | undefined,
  poolId: string | undefined,
  siblings: GtPool[] = [],
): LiveMarket | null {
  const price = num(token.attributes.price_usd);
  if (price == null || price <= 0) return null;
  const pa = pool?.attributes;
  const win = (k: "m5" | "h1" | "h6" | "h24") =>
    num(pa?.price_change_percentage?.[k]) ?? borrowChg(pool, siblings, k) ?? 0;
  const chg = {
    "5m": win("m5"),
    "1h": win("h1"),
    "6h": win("h6"),
    "24h": win("h24"),
  } as Record<PeriodKey, number>;
  const vol = {
    "5m": num(pa?.volume_usd?.m5) ?? 0,
    "1h": num(pa?.volume_usd?.h1) ?? 0,
    "6h": num(pa?.volume_usd?.h6) ?? 0,
    "24h": num(pa?.volume_usd?.h24) ?? 0,
  } as Record<PeriodKey, number>;
  const tx = (p?: { buys: number; sells: number }): TxSplit => ({ buys: p?.buys ?? 0, sells: p?.sells ?? 0 });
  const t24 = tx(pa?.transactions?.h24);
  const ratio = vol["24h"] > 0 ? Math.min(vol["6h"] / vol["24h"], 1) : 0.25;
  const t6 = { buys: Math.round(t24.buys * ratio), sells: Math.round(t24.sells * ratio) };
  const ageMinutes = pa?.pool_created_at
    ? Math.max(0, Math.round((Date.now() - Date.parse(pa.pool_created_at)) / 60000))
    : null;
  const img = token.attributes.image_url;
  return {
    priceUsd: price,
    mcap: num(token.attributes.market_cap_usd) ?? num(token.attributes.fdv_usd),
    liq: num(token.attributes.total_reserve_in_usd) ?? num(pa?.reserve_in_usd),
    chg,
    vol,
    txns: { "5m": tx(pa?.transactions?.m5), "1h": tx(pa?.transactions?.h1), "6h": t6, "24h": t24 },
    ageMinutes,
    logoUrl: img && img !== "missing.png" ? img : null,
    poolAddress: poolAddrOf(pool, poolId),
  };
}

/** GT's tokens/multi endpoint answers at most 30 addresses per request. */
export const GT_MULTI_MAX = 30;

/** Politeness gap between chunk requests for one chain. The bot suite on the
 *  SAME server IP is a heavy GT consumer with its own shared 429 cooldown, so
 *  the web app must not burst. */
const CHUNK_GAP_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchChunk(
  chainId: string,
  network: string,
  chunk: string[],
  out: Map<string, LiveMarket>,
  waitMs: number | undefined,
): Promise<void> {
  // ⚠️ Addresses go to GT VERBATIM — base58 (Solana) is case-significant, and
  // lowercasing one asks GT about an address that does not exist. Only OUR map
  // keys are lowercased; those are ours and merely have to be consistent.
  //
  // Through the shared client (providers/gt): the board is this app's heaviest
  // GT consumer, so a 429 it earns must silence the charts and the trades feed
  // too — and a 429 THEY earn must stop the board re-asking.
  const res = await gtGet<{ data?: GtToken[]; included?: GtPool[] }>(
    `/networks/${network}/tokens/multi/${chunk.join(",")}`,
    { include: "top_pools" },
    waitMs === undefined ? undefined : { waitMs },
  );
  if (!res.ok) throw new Error(`${res.reason ?? "GeckoTerminal failed"} (${chainId})`);
  const json = res.body ?? {};
  const poolsById = new Map((json.included ?? []).map((p) => [p.id, p]));
  for (const token of json.data ?? []) {
    const ids = (token.relationships?.top_pools?.data ?? []).map((d) => d.id);
    const topId = ids[0];
    const siblings = ids
      .slice(1)
      .map((id) => poolsById.get(id))
      .filter((p): p is GtPool => p != null);
    const market = mapMarket(token, topId ? poolsById.get(topId) : undefined, topId, siblings);
    if (market) out.set(token.attributes.address.toLowerCase(), market);
  }
}

/** Live market data for specific listed addresses on one chain, keyed by
 *  lowercased address.
 *
 *  ⚠️ EVERY address is asked for, in chunks of GT_MULTI_MAX. This used to be
 *  `addresses.slice(0, 30)` — written against a 14-token seed and shipped to a
 *  store of 173 listings, where it silently dropped tokens 31+ on every chain:
 *  83 Solana listings meant 53 of them could never price, rendering +0.0%
 *  forever with nothing anywhere saying why. A cap that is not reported is a
 *  bug that looks like a market.
 *
 *  A chunk that fails is SKIPPED — its tokens keep their fallback figures this
 *  cycle — but if NO chunk answered the whole chain throws, because "GT is
 *  down" and "these tokens have no market" are different facts and the caller
 *  treats them differently. */
export async function fetchListedMarket(
  chainId: string,
  addresses: string[],
): Promise<Map<string, LiveMarket>> {
  const network = CHAINS[chainId]?.geckoNetwork;
  const out = new Map<string, LiveMarket>();
  if (!network || addresses.length === 0) return out;

  // ⚠️ THE BOARD MAY NOT QUEUE FOR A SLOT IT HAS A SECOND SOURCE FOR.
  //
  // `slot()` is serialised process-wide, so a chunk that waits its full three
  // seconds for a budget that is already spent is three seconds charged to
  // everything behind it — the next chain's chunks, and the chart request of
  // whoever just opened a token page. Measured on the shipped free budget
  // (10/min for the IP, 5/min for this process) one refresh is ~19 chunks, so
  // ~14 of them queued for a slot that was never coming: ~40s of the site's GT
  // pipeline burnt per cycle, every cycle.
  //
  // On a chain DexScreener covers, waiting buys nothing — `fetchIndexedMarket`
  // asks DexScreener for exactly these leftovers, which is where they were
  // going to end up three seconds later. A GT-ONLY chain still waits, because
  // there the wait is the difference between a priced row and a dash; it is the
  // same fact `partitionByFallback` orders the cycle on, read from the same map
  // rather than from a second list of chains.
  const waitMs = dsCovers(chainId) ? 0 : undefined;

  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += GT_MULTI_MAX) chunks.push(addresses.slice(i, i + GT_MULTI_MAX));

  let failed = 0;
  // ⚠️ The FIRST failure, not the last. Once a 429 arms the shared cooldown
  // every later chunk fails with "cooling down for 118s" — a consequence, not a
  // cause — and reporting that as the chain's error hides the 429 that produced
  // it. The first one is the diagnosis.
  let firstErr: unknown;
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(CHUNK_GAP_MS);
    try {
      await fetchChunk(chainId, network, chunks[i], out, waitMs);
    } catch (err) {
      failed++;
      if (firstErr === undefined) firstErr = err;
    }
  }
  if (failed === chunks.length) throw firstErr instanceof Error ? firstErr : new Error(`GeckoTerminal failed (${chainId})`);
  // ⚠️ A CYCLE CUT SHORT BY THE COOLDOWN IS A FAILED CYCLE, not a partial one.
  // The contract above — "a chunk that fails is SKIPPED, its tokens keep their
  // fallback figures" — was written for one bad chunk out of many. With a
  // process-wide 429 cooldown, chunk 1 can succeed and every later chunk return
  // without asking, and returning that map hands the caller 30 live tokens and
  // 140 silently unpriced ones, which `cached()` then serves as the board for a
  // minute. Throwing sends the whole chain to DexScreener instead, which is the
  // fallback that exists for exactly this.
  if (failed > 0 && gtInCooldown()) throw firstErr instanceof Error ? firstErr : new Error(`GeckoTerminal rate limited (${chainId})`);
  return out;
}

/**
 * USD price of one unit of a reference token — how a chain whose quote asset
 * GeckoTerminal does not index directly gets priced. Robinhood Chain trades in
 * ETH, so mainnet WETH is the reference.
 *
 * Goes through `gtGet` like every other GT call here: this shares the same
 * per-process budget the board spends, and a raw fetch would quietly spend
 * quota the scheduler thinks it still has. Throws when GT gave no usable price.
 */
export async function fetchTokenPriceUsd(network: string, address: string): Promise<number> {
  const res = await gtGet<{ data?: { attributes?: { token_prices?: Record<string, string> } } }>(
    `/simple/networks/${network}/token_price/${address}`,
  );
  if (!res.ok || !res.body) throw new Error(`GeckoTerminal reference price failed — ${res.reason ?? res.status}`);
  const prices = res.body.data?.attributes?.token_prices ?? {};
  const price = num(prices[address] ?? prices[address.toLowerCase()]);
  if (price == null || price <= 0) throw new Error("no reference price");
  return price;
}
