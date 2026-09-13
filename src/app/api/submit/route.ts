import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/adminGuard";
import { buildRow } from "@/lib/adminValidate";
import { addListing, allListings } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public listing submissions land in the admin "pending" queue. Rate-limited so
// the queue can't be flooded.
const MAX = 5;
const WINDOW_MS = 10 * 60 * 1000;
const hits = new Map<string, { n: number; until: number }>();

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = hits.get(ip);
  if (rec && rec.until > now && rec.n >= MAX) {
    return NextResponse.json({ error: "Too many submissions — try again later." }, { status: 429 });
  }
  const base = rec && rec.until > now ? rec : { n: 0, until: now + WINDOW_MS };
  hits.set(ip, { n: base.n + 1, until: base.until });

  const body = await req.json().catch(() => ({}));
  // A public submitter can pick a package tier, but never self-assign a trending slot.
  const built = buildRow({ ...body, trendingRank: null });
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 });

  // ⚠️ ONE TOKEN, ONE LISTING — and this is the lock, not a nicety.
  //
  // `addListing` treats a chain+address it already holds as the SAME listing
  // and keeps its id. So a submission for an address that is already a live
  // paid listing did not create anything: it took that row over. It set the
  // status back to `pending` (and `approvedRows()` filters on approved, so the
  // listing left the site), it replaced the name and the ticker, and because a
  // public submitter may pick a tier, it handed out a free upgrade. Anyone
  // could do it, five times per IP per ten minutes, by typing somebody else's
  // contract address into the public form.
  //
  // The bot's own listing flow states the same rule and checks it BEFORE it
  // will even take the form ("One token, one listing" — handlers/listing.js).
  // Refusing outright is the only answer that cannot be turned into an edit of
  // a stranger's row; an admin can always re-approve from the panel.
  const existing = (await allListings().catch(() => [])).find(
    (r) => r.chain === built.row.chain && r.address.toLowerCase() === built.row.address.toLowerCase(),
  );
  if (existing) {
    // The state is named, because "already submitted" and "already live" are
    // different things to the person typing — and neither of them is a fault
    // on their side.
    const why =
      existing.status === "approved"
        ? "That token is already listed on Dexvra."
        : existing.status === "pending"
          ? "That token is already in the review queue."
          : "That token has already been submitted — contact us if you think it was reviewed in error.";
    return NextResponse.json({ error: why }, { status: 409 });
  }

  await addListing(built.row, { status: "pending", source: "submission" });
  return NextResponse.json({ ok: true });
}
