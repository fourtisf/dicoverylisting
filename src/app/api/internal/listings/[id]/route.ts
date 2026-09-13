import { NextRequest, NextResponse } from "next/server";
import { internalAuthorized, unauthorizedInternal } from "@/lib/internalAuth";
import { sanitizePatch } from "@/lib/adminValidate";
import { allListings, deleteListing, updateListing } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH /api/internal/listings/:id → partial field update (tier, logoUrl,
// socials, trendingRank, trendStart/trendExp). chain/address are immutable.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  if (!internalAuthorized(req)) return unauthorizedInternal();
  const body = await req.json().catch(() => ({}));
  const patch = sanitizePatch(body);
  const listing = await updateListing(params.id, patch);
  if (!listing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ listing });
}

// DELETE /api/internal/listings/:id → remove a listing the BOT created.
//
// It exists for one job: undoing bulk auto-listings (`seed:chain` filled TON
// with 15 rows nobody wanted). The admin panel's own DELETE has no such
// restriction — an admin removing a listing by hand is a decision, and this is
// a script acting in bulk, which is a different risk entirely.
//
// ⚠️ SO IT REFUSES ANYTHING SOMEBODY PAID FOR. Only `source: "bot"` rows on the
// FREE tier with no trending window can be removed here; a real tier or a live
// slot is inventory a customer bought, and the one thing a bulk cleanup must
// never be able to do is take that away. The refusal names which rule stopped
// it, because "403" over a bulk run tells the operator nothing about whether
// their data is safe.
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  if (!internalAuthorized(req)) return unauthorizedInternal();
  const row = (await allListings()).find((r) => r.id === params.id);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (row.source !== "bot") {
    return NextResponse.json({ error: `refused: source is "${row.source ?? "unknown"}", not "bot"` }, { status: 409 });
  }
  if (String(row.tier || "").toUpperCase() !== "FREE") {
    return NextResponse.json({ error: `refused: tier is "${row.tier}" — somebody paid for that` }, { status: 409 });
  }
  if (row.trendingRank != null || row.trendExp) {
    return NextResponse.json({ error: "refused: it holds a trending slot" }, { status: 409 });
  }

  const ok = await deleteListing(params.id);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ deleted: true, chain: row.chain, address: row.address, sym: row.sym });
}
