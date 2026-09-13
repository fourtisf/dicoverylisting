// GT first, DexScreener for what GT could not see — the merge, alone in its
// own module so node:test can drive it with injected fetchers. index.ts
// imports "@/"-aliased modules the test runner cannot resolve, and the merge
// is exactly where a silent bug costs a chain its market.
import { fetchListedMarket, type LiveMarket } from "./geckoterminal.ts";
import { fetchDsMarket } from "./dexscreener.ts";

export interface MarketFetchers {
  gt: (chain: string, addrs: string[]) => Promise<Map<string, LiveMarket>>;
  ds: (chain: string, addrs: string[]) => Promise<Map<string, LiveMarket>>;
}

/** GT is the primary — it carries the pool address the chart embed needs —
 *  but it indexes POOLS, and a bot-listed launch an hour old has none: every
 *  fresh listing rendered a fabricated ▲0.0% until its first pool.
 *  DexScreener carries those day-one pairs, so it is asked about exactly the
 *  LEFTOVERS — a gap-filler, never a second opinion, so the two sources
 *  cannot disagree about one token.
 *
 *  When GT itself is down, DS prices the whole chain — a second source that
 *  only works while the first one does would be decoration. Both down → the
 *  chain throws, and the caller's captured-figures fallback stands. */
export async function fetchIndexedMarket(
  chain: string,
  addrs: string[],
  f: MarketFetchers = { gt: fetchListedMarket, ds: fetchDsMarket },
): Promise<Map<string, LiveMarket>> {
  let gt: Map<string, LiveMarket> | null = null;
  let gtErr: unknown;
  try {
    gt = await f.gt(chain, addrs);
  } catch (err) {
    gtErr = err;
  }
  const leftover = gt ? addrs.filter((a) => !gt.has(a.toLowerCase())) : addrs;
  let ds = new Map<string, LiveMarket>();
  if (leftover.length > 0) {
    try {
      ds = await f.ds(chain, leftover);
    } catch {
      // DS failing must never cost what GT already answered.
      if (!gt) throw gtErr instanceof Error ? gtErr : new Error(`no market source answered (${chain})`);
    }
  }
  if (!gt && ds.size === 0) throw gtErr instanceof Error ? gtErr : new Error(`no market source answered (${chain})`);
  const out = new Map(ds);
  for (const [k, v] of gt ?? []) out.set(k, v);
  return out;
}
