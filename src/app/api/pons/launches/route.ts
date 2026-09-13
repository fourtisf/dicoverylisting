import { NextRequest, NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { PONS } from "@/config/pons";
import { fetchPonsLaunchFeed, isPonsChain } from "@/lib/providers/pons";

export const dynamic = "force-dynamic";

// Newly launched tokens, read from the Pons v2 factory's TokenLaunched stream.
//
// NOT the same feed as /api/launches, and deliberately at its own path: that
// one is pools.trade's list over HTTP, this one is the factory's own log. Two
// readings of the same chain that can disagree must not share a URL — when
// they do, nobody can tell which source a wrong row came from.
//
// These are NOT Dexvra listings — Dexvra is paid-listing only, and the feed is
// labelled as discovery everywhere it surfaces. `listed` is deliberately absent
// here; the admin queue is the surface that resolves it.
const FEED_TTL = 45_000;
const MAX_LIMIT = 50;

export async function GET(req: NextRequest) {
  const chain = (req.nextUrl.searchParams.get("chain") ?? PONS.chain).trim();
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 20));

  if (!isPonsChain(chain)) {
    return NextResponse.json({ error: "no launch feed for this chain", chain }, { status: 404 });
  }

  try {
    const feed = await cached(`pons:launches:${limit}`, FEED_TTL, () => fetchPonsLaunchFeed(limit));
    return NextResponse.json(
      { chain, launchpad: "pons-v2", live: true, ...feed },
      { headers: { "Cache-Control": "public, max-age=20, stale-while-revalidate=60" } },
    );
  } catch {
    return NextResponse.json(
      { chain, launchpad: "pons-v2", live: false, items: [], coverageMinutes: 0, updatedAt: Date.now() },
      { status: 200 },
    );
  }
}
