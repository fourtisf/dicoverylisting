import { NextRequest, NextResponse } from "next/server";
import { internalAuthorized, unauthorizedInternal } from "@/lib/internalAuth";
import { allListings, updateListing } from "@/lib/store";
import { CHAINS } from "@/config/chains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/internal/trending
// Book (or extend) a time-boxed Trending slot on an already-listed token. The
// Trending page features every token with a non-null `trendingRank`; `trendExp`
// bounds the run (the provider stops featuring past it; the bot sweeper clears
// the rank in-store shortly after). Trending never changes the listing tier.
//
// Body: { chain, address, durationHours }
export async function POST(req: NextRequest) {
  if (!internalAuthorized(req)) return unauthorizedInternal();
  const body = await req.json().catch(() => ({}));
  const chain = String(body.chain ?? "").trim();
  const address = String(body.address ?? "").trim();
  const hours = Number(body.durationHours);

  if (!CHAINS[chain]) return NextResponse.json({ error: "Unknown chain" }, { status: 400 });
  if (!address) return NextResponse.json({ error: "Missing address" }, { status: 400 });
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) {
    return NextResponse.json({ error: "Invalid durationHours" }, { status: 400 });
  }

  const rows = await allListings();
  const match = rows.find(
    (r) => r.chain === chain && r.address.toLowerCase() === address.toLowerCase(),
  );
  if (!match) {
    return NextResponse.json(
      { error: "Listing not found — list the token before booking Trending" },
      { status: 404 },
    );
  }

  const now = Date.now();
  // Stack onto an active window if one is still running, else start now.
  const active = match.trendExp != null && match.trendExp > now;
  const trendStart = active ? match.trendStart ?? now : now;
  const trendExp = (active ? (match.trendExp as number) : now) + Math.round(hours * 3_600_000);

  const listing = await updateListing(match.id, {
    trendingRank: match.trendingRank ?? 1, // non-null = featured; value is a within-tier sub-order
    trendStart,
    trendExp,
  });
  return NextResponse.json({ listing });
}
