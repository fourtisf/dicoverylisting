import { NextRequest, NextResponse } from "next/server";
import { isAdmin, unauthorized } from "@/lib/adminGuard";
import { cached } from "@/lib/cache";
import { PONS } from "@/config/pons";
import { buildRow, TIER_KEYS } from "@/lib/adminValidate";
import { fetchPonsLaunchFeed, type PonsLaunchFeedItem } from "@/lib/providers/pons";
import { addListing, allListings } from "@/lib/store";
import type { ListingTier } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The listing queue: recent Pons launches, each marked with whether it is
// already in the store, plus a one-click promote. Dexvra stays paid-listing
// only — this doesn't auto-list anything, it just removes the copy-paste.
const FEED_TTL = 45_000;
const QUEUE_LIMIT = 20;
const DEFAULT_TIER: ListingTier = "BRONZE";

const feed = () => cached(`pons:launches:${QUEUE_LIMIT}`, FEED_TTL, () => fetchPonsLaunchFeed(QUEUE_LIMIT));

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return unauthorized();

  try {
    const [{ items, coverageMinutes }, listings] = await Promise.all([feed(), allListings()]);
    const known = new Map(
      listings
        .filter((l) => l.chain === PONS.chain)
        .map((l) => [l.address.toLowerCase(), { id: l.id, status: l.status }]),
    );
    return NextResponse.json({
      live: true,
      coverageMinutes,
      launches: items.map((item) => ({ ...item, existing: known.get(item.address.toLowerCase()) ?? null })),
    });
  } catch {
    return NextResponse.json({ live: false, coverageMinutes: 0, launches: [] });
  }
}

/** Fills a listing row from what the launch actually says on chain, so the
 *  admin isn't retyping figures the provider is about to overwrite anyway. */
function rowInput(launch: PonsLaunchFeedItem, tier: ListingTier) {
  return {
    chain: PONS.chain,
    address: launch.address,
    sym: launch.symbol ?? "",
    name: launch.name ?? launch.symbol ?? "",
    tier,
    listedMin: 0,
    tax: launch.creatorTaxBps != null ? launch.creatorTaxBps / 100 : 0,
    price: launch.priceUsd ?? 0,
    mcap: launch.mcapUsd ?? 0,
    liq: launch.liquidityUsd ?? 0,
    vol24h: 0,
    chg24h: 0,
    holders: 0,
    buyShare: 0.5,
    tx24h: 0,
    logoUrl: launch.logo && /^https:\/\//i.test(launch.logo) ? launch.logo : undefined,
    website: launch.ponsUrl,
  };
}

export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as { address?: string; tier?: string };
  const address = String(body.address ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }
  const tier = (TIER_KEYS as string[]).includes(String(body.tier)) ? (body.tier as ListingTier) : DEFAULT_TIER;

  let launch: PonsLaunchFeedItem | undefined;
  try {
    const { items } = await feed();
    launch = items.find((i) => i.address.toLowerCase() === address.toLowerCase());
  } catch {
    return NextResponse.json({ error: "Robinhood Chain RPC unavailable" }, { status: 503 });
  }
  if (!launch) return NextResponse.json({ error: "Launch not in the current window" }, { status: 404 });
  if (!launch.symbol) return NextResponse.json({ error: "Launch has no on-chain ticker" }, { status: 422 });

  const built = buildRow(rowInput(launch, tier));
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 });

  const listing = await addListing(built.row, { status: "approved", source: "admin" });
  return NextResponse.json({ listing });
}
