// Admin banner management — create ANY homepage ad-row banner without going
// through the bot's paid flow. Admin uploads an image via /api/admin/upload,
// picks the slot, then creates a booking here (source:"admin"). DELETE removes
// a booking (paid bot bookings included — admin's call). Auth: same cookie guard
// as the rest of the panel.
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, unauthorized } from "@/lib/adminGuard";
import { activeBanners, addBanner, allBanners, removeBanner } from "@/lib/banners";

// The slots the panel can create. Names and sizes MUST match what the bot sells
// (bot/src/config/packages.js) — the homepage lays a booking out by its slot
// name, so a typo here would silently render at the wrong width. "Full Width"
// is the operator's own house banner: it fills the row like a Wide, but isn't
// tagged as sold inventory on the site.
const SLOTS: Record<string, { slot: string; size: string }> = {
  standard: { slot: "Standard Banner", size: "600 × 240" },
  wide: { slot: "Wide Banner", size: "1200 × 240" },
  house: { slot: "Homepage Banner", size: "full width" },
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return unauthorized();
  const now = Date.now();
  const active = new Set((await activeBanners(now)).map((b) => b.id));
  const banners = (await allBanners())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((b) => ({ ...b, active: active.has(b.id) }));
  return NextResponse.json({ banners });
}

export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return unauthorized();
  const body = await req.json().catch(() => ({}));
  const imageUrl = String(body.imageUrl || "").trim();
  const linkUrl = String(body.linkUrl || "").trim();
  const title = String(body.title || "").trim();
  const days = Math.min(3650, Math.max(0.04, Number(body.days) || 30)); // 1h .. 10y

  if (!imageUrl || !(imageUrl.startsWith("/api/media/") || /^https:\/\//.test(imageUrl))) {
    return NextResponse.json({ error: "Upload an image first (or provide an https image URL)" }, { status: 400 });
  }
  if (!/^https?:\/\/[^\s]+$/i.test(linkUrl)) {
    return NextResponse.json({ error: "Target link must be a valid http(s) URL" }, { status: 400 });
  }
  const pick = SLOTS[String(body.slot || "house").toLowerCase()] || SLOTS.house;
  const now = Date.now();
  const banner = await addBanner({
    slot: pick.slot,
    size: pick.size,
    imageUrl,
    linkUrl,
    title: title || undefined,
    startsAt: now,
    endsAt: now + days * 86_400_000,
    source: "admin",
  });
  return NextResponse.json({ banner });
}

export async function DELETE(req: NextRequest) {
  if (!(await isAdmin(req))) return unauthorized();
  const id = req.nextUrl.searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const removed = await removeBanner(id);
  return NextResponse.json({ removed });
}
