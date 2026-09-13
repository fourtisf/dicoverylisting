// Public: the homepage carousel reads the editable "Pumped on Dexvra" showcase.
import { NextResponse } from "next/server";
import { getPromo } from "@/lib/promo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getPromo());
}
