// Streams a channel-banner asset (still artwork PNG or the GIF/video clip) for
// preview in the admin panel. The files live in the bot's data dir, outside the
// web app's public/, so they need an authenticated route to serve them.
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, unauthorized } from "@/lib/adminGuard";
import { CHANNEL_KINDS, readAsset, type ChannelKind } from "@/lib/channelBanners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isKind = (k: string): k is ChannelKind => (CHANNEL_KINDS as readonly string[]).includes(k);

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return unauthorized();
  const kind = req.nextUrl.searchParams.get("kind") || "";
  const type = req.nextUrl.searchParams.get("type") || "";
  if (!isKind(kind) || (type !== "artwork" && type !== "clip")) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const asset = readAsset(kind, type);
  if (!asset) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(asset.buf as unknown as BodyInit, {
    headers: {
      "content-type": asset.contentType,
      "cache-control": "no-store, max-age=0",
    },
  });
}
