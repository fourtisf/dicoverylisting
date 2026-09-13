// Admin: read + update the homepage "Pumped on Dexvra" showcase. Same cookie +
// host guard as the rest of the panel.
import { NextRequest, NextResponse } from "next/server";
import { isAdmin, unauthorized } from "@/lib/adminGuard";
import { getPromo, setPromo } from "@/lib/promo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return unauthorized();
  return NextResponse.json(await getPromo());
}

export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return unauthorized();
  const body = await req.json().catch(() => ({}));
  const saved = await setPromo(body);
  return NextResponse.json(saved);
}
