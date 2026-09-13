import { NextRequest, NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { fetchPonsTrades } from "@/lib/providers/pons";

export const dynamic = "force-dynamic";

// Trades on a Pons launch's bonding curve, read from its CurveBuy/CurveSell
// logs. Separate from /api/trades, which reads an indexed POOL: a token still
// on its curve has no pool, and a graduated one is better served by the
// indexer. `curve` is the curve address from /api/pons, not the token.
const TRADES_TTL = 8_000;

export async function GET(req: NextRequest) {
  const curve = (req.nextUrl.searchParams.get("curve") ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(curve)) return NextResponse.json({ trades: [] });
  try {
    const trades = await cached(`pons:trades:${curve.toLowerCase()}`, TRADES_TTL, () => fetchPonsTrades(curve));
    return NextResponse.json({ trades });
  } catch {
    return NextResponse.json({ trades: [] });
  }
}
