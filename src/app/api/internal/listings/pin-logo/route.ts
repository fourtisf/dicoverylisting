import { NextRequest, NextResponse } from "next/server";
import { internalAuthorized, unauthorizedInternal } from "@/lib/internalAuth";
import { pinLogo } from "@/lib/store";

// POST /api/internal/listings/pin-logo  { chain, address, fromUrl, toUrl } → { pinned }
//
// The bot calls this the moment a paid post holds artwork bytes the proxy just
// served, having uploaded them to /api/media: point the row at our own copy so
// no later render asks a public gateway for it. A DEDICATED route rather than
// PATCH /api/internal/listings/:id, because `updateListing` writes
// unconditionally and would re-fill a logo an admin had just cleared — this is
// a compare-and-swap (lib/logoWrite applyPinnedLogo), and `pinned:false` is an
// ordinary answer meaning "the row no longer holds that url".
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!internalAuthorized(req)) return unauthorizedInternal();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const chain = String(body.chain ?? "").trim();
  const address = String(body.address ?? "").trim();
  const fromUrl = String(body.fromUrl ?? "").trim();
  const toUrl = String(body.toUrl ?? "").trim();
  if (!chain || !address || !fromUrl || !toUrl) {
    return NextResponse.json({ error: "chain, address, fromUrl and toUrl are required" }, { status: 400 });
  }
  const pinned = await pinLogo(chain, address, fromUrl, toUrl);
  return NextResponse.json({ pinned });
}
