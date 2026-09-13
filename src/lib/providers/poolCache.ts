// WHICH POOL DO WE CHART — asked once, remembered for everyone who asks next.
//
// ⚠️ FOUR FILES DECLARED THIS TTL SEPARATELY and all four wrote the SAME cache
// key: providers/index.ts, /api/pool, /api/ohlcv and /api/trades. Four copies
// of one number sharing one key means whichever writes last sets the expiry,
// and changing one of them looks like it works while three others disagree.
// `topPoolAddress` is already the one owner of "which pool"; this is the one
// owner of "how long we remember the answer".
//
// WHY IT MATTERS BEYOND TIDINESS: resolving a pool is a GeckoTerminal request,
// and GT is the only free source of candles for an arbitrary DEX token. Its
// free tier is ~30 requests a minute counted PER IP, shared here with the bot
// suite on the same box — and one 429 arms a process-wide cooldown that blanks
// EVERY chart on the site until it lifts. So every resolution we do not have to
// repeat is a chart that draws.
import { cached, cache } from "../cache";

/**
 * A token's deepest pool is not a per-minute fact. It changes when liquidity
 * migrates, which is rare — and the caller re-resolves anyway when the pool it
 * was handed comes back with nothing, so a stale one self-corrects rather than
 * sticking. Ten minutes was paying for that stability six times an hour.
 */
export const POOL_TTL_MS = 60 * 60_000;

export const poolKey = (network: string, address: string) => `pool:${network}:${address}`;

/** Remember a pool an upstream already told us about — the board gets one with
 *  every market refresh, so planting it here costs nothing and saves a request
 *  the moment somebody opens that token's page. */
export function rememberPool(network: string, address: string, pool: string): void {
  cache.set(poolKey(network, address), pool, POOL_TTL_MS);
}

/** The pool for this token, resolving it only if nobody has already. */
export function cachedPool(
  network: string,
  address: string,
  resolve: () => Promise<string | null>,
): Promise<string | null> {
  return cached(poolKey(network, address), POOL_TTL_MS, resolve);
}

/** Forget it, because the pool we handed out answered with nothing. Without
 *  this a pool that dies mid-TTL keeps being handed back for the whole hour —
 *  the cost a longer TTL would otherwise buy. */
export function forgetPool(network: string, address: string): void {
  cache.set(poolKey(network, address), undefined as unknown as string, 0);
}
