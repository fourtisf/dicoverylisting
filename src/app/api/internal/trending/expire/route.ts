import { NextRequest, NextResponse } from "next/server";
import { internalAuthorized, unauthorizedInternal } from "@/lib/internalAuth";
import { allListings, updateListing } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/internal/trending/expire
// Clear the featured rank on every listing whose Trending window has ended, so
// the store + admin panel reflect reality (the public board already stops
// featuring expired slots at render time). The bot's trending sweeper polls
// this. Idempotent.
export async function POST(req: NextRequest) {
  if (!internalAuthorized(req)) return unauthorizedInternal();
  const now = Date.now();
  const rows = await allListings();
  const due = rows.filter((r) => r.trendExp != null && r.trendExp <= now && r.trendingRank != null);
  for (const r of due) {
    await updateListing(r.id, { trendingRank: undefined, trendStart: undefined, trendExp: undefined });
  }
  return NextResponse.json({ cleared: due.length });
}
