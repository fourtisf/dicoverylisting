import { NextResponse } from "next/server";
import { displayBanners } from "@/lib/banners";

export const dynamic = "force-dynamic";

// Public: currently-running banner bookings for the homepage ad row
// (components/HomeBannerStrip). Only the fields the client needs to render —
// `slot` decides whether a booking takes half the row (Standard) or all of it
// (Wide). The "carousel takeover" this once mentioned was never wired: booked
// creatives render in the ad row only, so the same one never shows twice.
export async function GET() {
  try {
    const active = await displayBanners();
    const banners = active.map((b) => ({
      slot: b.slot,
      size: b.size,
      imageUrl: b.imageUrl,
      linkUrl: b.linkUrl,
      title: b.title ?? null,
      endsAt: b.endsAt,
    }));
    return NextResponse.json(
      { banners },
      // no-store, deliberately. This list is edited live from the admin panel,
      // and a 30s max-age + 60s stale-while-revalidate meant a banner kept
      // showing for up to 90s after it was removed — indistinguishable from a
      // delete that silently failed. The payload is a few hundred bytes on an
      // already force-dynamic route, so there is nothing to save by caching it.
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ banners: [] });
  }
}
