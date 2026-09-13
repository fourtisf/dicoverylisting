import { NextRequest, NextResponse } from "next/server";
import { internalAuthorized, unauthorizedInternal } from "@/lib/internalAuth";
import { buildRow } from "@/lib/adminValidate";
import { addListing, allListings } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  /api/internal/listings          → every stored listing (bot reads: pump
//                                         checker, trending poster, dedup).
// POST /api/internal/listings          → create an APPROVED listing (a paid
//                                         listing/xpress order that cleared
//                                         on-chain payment via the bot). Goes
//                                         live immediately, same as an admin add.

export async function GET(req: NextRequest) {
  if (!internalAuthorized(req)) return unauthorizedInternal();
  return NextResponse.json({ listings: await allListings() });
}

export async function POST(req: NextRequest) {
  if (!internalAuthorized(req)) return unauthorizedInternal();
  const body = await req.json().catch(() => ({}));
  const built = buildRow(body);
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 });
  const listing = await addListing(built.row, { status: "approved", source: "bot" });
  return NextResponse.json({ listing });
}
