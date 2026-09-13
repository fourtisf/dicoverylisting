import { NextRequest, NextResponse } from "next/server";
import { networkOf, readWhy, safeAddress, topPoolAddress } from "@/lib/providers/gtPool";
import { cachedPool } from "@/lib/providers/poolCache";

export const dynamic = "force-dynamic";


// Resolve a token's top pool. GeckoTerminal keys candles and trades by POOL
// address, not token address, so the client needs this to ask for either.
//
// The lookup itself lives in providers/gtPool — /api/ohlcv needs the same
// answer, and two copies of "where does this token trade" would diverge into
// two plausible-looking pool addresses with nothing to say which is right.
export async function GET(req: NextRequest) {
  const chain = (req.nextUrl.searchParams.get("chain") ?? "").trim();
  const address = (req.nextUrl.searchParams.get("address") ?? "").trim();
  const network = networkOf(chain);
  if (!network || !safeAddress(address)) {
    return NextResponse.json({ network: null, poolAddress: null }, { status: 200 });
  }
  try {
    const poolAddress = await cachedPool(network, address, () => topPoolAddress(network, address));
    // A null here is an ANSWER: GeckoTerminal indexes no pool for this token.
    return NextResponse.json({ network, poolAddress, why: poolAddress ? null : "No pool indexed for this token yet." });
  } catch (err) {
    // ⚠️ AND A NULL HERE IS A SILENCE. `topPoolAddress` is careful to throw for
    // everything that is not a 404 — a rate-limit cooldown included — and this
    // catch used to flatten that into the same `poolAddress: null` the answer
    // uses. One field, two opposite meanings, and the caller could not tell.
    return NextResponse.json({ network, poolAddress: null, why: `Couldn't look up the pool just now (${readWhy(err)}).` });
  }
}
