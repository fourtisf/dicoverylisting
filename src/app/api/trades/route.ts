import { NextRequest, NextResponse } from "next/server";
import { CHAINS } from "@/config/chains";
import { cached } from "@/lib/cache";
import { gtGet } from "@/lib/providers/gt";
import { readWhy, safeAddress, topPoolAddress } from "@/lib/providers/gtPool";
import { cachedPool } from "@/lib/providers/poolCache";
import { publicNote } from "@/lib/publicNote";
import { TRADES_TTL_MS } from "@/lib/trades";
import type { Trade } from "@/lib/types";

export const dynamic = "force-dynamic";

// The TTL and the panel's poll interval live together in lib/trades — a route
// file may not export anything but its handlers, and these two numbers
// disagreeing is what made every poll a guaranteed upstream miss.

interface GtTrade {
  attributes: {
    block_timestamp: string;
    tx_from_address: string;
    from_token_amount: string;
    to_token_amount: string;
    price_from_in_usd: string | null;
    price_to_in_usd: string | null;
    volume_in_usd: string | null;
    kind: "buy" | "sell";
  };
}

async function fetchOnce(network: string, pool: string): Promise<Trade[]> {
  // Through the shared client: this route is polled every ~12s by every open
  // token page, so it is one of the app's biggest GT consumers and must be
  // silenced by a 429 anybody else earned.
  const res = await gtGet<{ data?: GtTrade[] }>(
    // trade_volume_in_usd_greater_than=0 keeps out dust; GeckoTerminal returns
    // the most recent ~300 trades for the pool — we surface the freshest 60.
    `/networks/${network}/pools/${pool}/trades`,
    { trade_volume_in_usd_greater_than: 0 },
  );
  // A 404 is an ANSWER about the pool — GeckoTerminal does not index it — and
  // an answer is cacheable. Throwing here is what made an unindexed pool cost a
  // request per poll for ever.
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(res.reason ?? "GeckoTerminal failed");
  return (res.body?.data ?? []).slice(0, 60).map((tr) => {
    const a = tr.attributes;
    const buy = a.kind === "buy";
    return {
      ts: Math.floor(Date.parse(a.block_timestamp) / 1000),
      kind: a.kind,
      usd: Number(a.volume_in_usd ?? 0),
      amount: Number(buy ? a.to_token_amount : a.from_token_amount) || 0,
      price: Number((buy ? a.price_to_in_usd : a.price_from_in_usd) ?? 0) || 0,
      trader: a.tx_from_address ?? "",
    };
  });
}

/**
 * ⚠️ NO BLANKET RETRY. This used to re-ask on ANY throw — including a 404 for a
 * pool GeckoTerminal does not index, which never becomes a 200 however many
 * times you ask. Since `cached()` stores nothing when the loader throws, an
 * unindexed pool cost TWO upstream requests on every poll, for every viewer,
 * for as long as the page stayed open. The shared client already refuses to
 * spend a request while a 429 cooldown holds, which is what the retry was
 * really for.
 */
async function fetchTrades(network: string, pool: string): Promise<Trade[]> {
  return fetchOnce(network, pool);
}


export async function GET(req: NextRequest) {
  const chain = (req.nextUrl.searchParams.get("chain") ?? "").trim();
  const hint = (req.nextUrl.searchParams.get("pool") ?? "").trim();
  const address = (req.nextUrl.searchParams.get("address") ?? "").trim();
  const network = CHAINS[chain]?.geckoNetwork;
  if (!network) return NextResponse.json({ trades: [], why: "We don't have a trade feed for that chain yet." });

  // ⚠️ A MISSING POOL IS NOT AN ANSWER. The panel used to decide "no indexed
  // pool for this token yet" from `t.poolAddress` being null — but that field
  // is null for every token DexScreener priced rather than GeckoTerminal, which
  // GT often indexes perfectly well. So the route resolves it, through the one
  // module that owns that question, exactly as /api/ohlcv does.
  let pool = safeAddress(hint) ? hint : null;
  if (!pool && safeAddress(address)) {
    try {
      pool = await cachedPool(network, address, () => topPoolAddress(network, address));
    } catch (err) {
      // The DETAIL stays — it just goes to the operator, not to the visitor.
      console.warn(`[trades] ${network}/${address}: pool lookup failed — ${readWhy(err)}`);
      return NextResponse.json({ trades: [], why: publicNote("recent trades", err) });
    }
  }
  if (!pool) {
    return NextResponse.json({ trades: [], why: "No indexed pool for this token yet, so there are no trades to show." });
  }

  try {
    const trades = await cached(`trades:${network}:${pool}`, TRADES_TTL_MS, () => fetchTrades(network, pool));
    // An empty list from a pool that DOES exist is an answer: nothing has
    // traded in the window. It is not the same as "we could not look".
    return NextResponse.json({ trades, why: trades.length ? null : "No trades in this pool's recent window." });
  } catch (err) {
    // ⚠️ THE REASON TRAVELS. The panel used to receive a bare empty list for
    // every failure and answer it by DRAWING TWELVE INVENTED TRADES — see
    // components/TokenTrades. Whatever it renders now, it renders knowing
    // which of the two things happened.
    //
    // …but the reason a VISITOR gets is not the one an operator gets. gt.ts's
    // refusal names two env vars and this process's budget, and it was being
    // rendered verbatim on a public token page. publicNote is the one owner of
    // that translation; the full text goes to the log.
    console.warn(`[trades] ${network}/${pool}: ${readWhy(err)}`);
    return NextResponse.json({ trades: [], why: publicNote("recent trades", err) });
  }
}
