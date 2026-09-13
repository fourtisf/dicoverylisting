import { NextRequest, NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { POOLS_TRADE_CHAIN, POOLS_TRADE_ENABLED, fetchLaunches, type PoolsLaunch } from "@/lib/providers/poolstrade";

export const dynamic = "force-dynamic";

// Launches from pools.trade, newest first — the tracking feed for Robinhood
// Chain, which no general indexer covers while a token is still on its bonding
// curve.
//
// Read-only and public, like /api/tokens: it exposes nothing the launchpad does
// not already publish. Writes still go through /api/internal/* behind the
// shared-secret guard.
const TTL = 60_000;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

// Newest first, and tokens the API gave no timestamp for sort last rather than
// jumping to the front on a `null` comparison.
const byNewest = (a: PoolsLaunch, b: PoolsLaunch) => (b.createdAt ?? 0) - (a.createdAt ?? 0);

export async function GET(req: NextRequest) {
  if (!POOLS_TRADE_ENABLED) {
    return NextResponse.json({ chain: POOLS_TRADE_CHAIN, enabled: false, launches: [], source: "disabled" });
  }

  const params = req.nextUrl.searchParams;
  const rawLimit = Number(params.get("limit"));
  const limit = Number.isFinite(rawLimit) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(rawLimit))) : DEFAULT_LIMIT;
  // ?bonding=1 — only tokens still on the curve. `graduated: null` means the API
  // did not say, and an unknown must not be presented as a confirmed answer to
  // either filter.
  const bonding = params.get("bonding") === "1";

  try {
    const all = await cached(`poolstrade:launches`, TTL, () => fetchLaunches());
    const rows = (bonding ? all.filter((l) => l.graduated === false) : all).slice().sort(byNewest).slice(0, limit);
    return NextResponse.json({
      chain: POOLS_TRADE_CHAIN,
      enabled: true,
      total: all.length,
      launches: rows,
      source: "live",
    });
  } catch {
    // Same contract as the rest of the API surface: a provider outage degrades
    // to an empty, clearly-labelled payload instead of a 5xx the UI must handle.
    return NextResponse.json({ chain: POOLS_TRADE_CHAIN, enabled: true, total: 0, launches: [], source: "unavailable" });
  }
}
