import { NextRequest, NextResponse } from "next/server";
import { cache, cached } from "@/lib/cache";
import { PONS } from "@/config/pons";
import { fetchPonsLaunch, unpricedByUs } from "@/lib/providers/pons";

export const dynamic = "force-dynamic";

// Launch state for a Pons v2 token on Robinhood Chain: graduation phase,
// bonding-curve progress, price and the locked-liquidity fact. Read straight
// off the launch factory and the curve — Pons publishes no HTTP API of its own.
const LAUNCH_TTL = 20_000;
// ⚠️ A record whose USD figures are missing for OUR reason — the ETH/USD ladder
// had no rung standing while the curve answered its price in ETH — is served
// for this long, not LAUNCH_TTL. Cached for the full twenty seconds it was the
// ladder's worst minute handed to every reader after the ladder had recovered,
// the bot on its 5s clock among them, and a paid post read TBA off a cache
// rather than off a source. Short, not zero: every reader re-running a
// three-rung ladder that is genuinely down is the stampede the cache exists to
// stop, and the ladder's own success cache makes the retry one bounded read.
const UNPRICED_TTL = 3_000;

export async function GET(req: NextRequest) {
  const address = (req.nextUrl.searchParams.get("address") ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }

  try {
    const key = `pons:launch:${address.toLowerCase()}`;
    const launch = await cached(key, LAUNCH_TTL, () => fetchPonsLaunch(address));
    if (unpricedByUs(launch)) cache.set(key, launch, UNPRICED_TTL);
    if (!launch) {
      return NextResponse.json({ error: "not a Pons launch", chain: PONS.chain }, { status: 404 });
    }
    return NextResponse.json(
      { chain: PONS.chain, chainId: PONS.chainId, launchpad: "pons-v2", launch },
      { headers: { "Cache-Control": "public, max-age=10, stale-while-revalidate=30" } },
    );
  } catch (err) {
    // ⚠️ THE REASON TRAVELS, AND THE URL NEVER DOES. "site answered 503" is
    // what the bot parks on and what the operator reads, and it says nothing
    // about whether the node refused us, the socket died, or Pons is fine —
    // which is the whole distinction this provider carries. A paid RPC keeps
    // its key in the path, so anything URL-shaped is stripped before it can
    // reach a public response or the bot's log.
    const raw = err instanceof Error ? err.message : "";
    const why = raw.replace(/https?:\/\/\S+/g, "the RPC endpoint").slice(0, 200);
    return NextResponse.json(
      { error: why || "upstream unavailable", chain: PONS.chain },
      { status: 503 },
    );
  }
}
