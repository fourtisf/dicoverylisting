/**
 * DEXSCREENER'S OWN CHART, AS THE LAST RESORT — with its watermark on it.
 *
 * "kalo misal apikey gecko terminal limit ganti dexscreener gpp ada watermark."
 * The operator's explicit call, and it reverses a documented ban, so the
 * boundary matters more than the code.
 *
 * ⚠️ THE BAN WAS ON THE EMBED AS THE DEFAULT, and that ban stands. A
 * third-party iframe on every token page sat on "Loading chart settings…" for
 * seconds and then planted a competitor's logo and wordmark across a Dexvra
 * page. Nothing here changes that: the native chart is still what a reader
 * gets whenever either source can draw it — our colours, our type, our LIN/LOG
 * and drag controls, and no other brand on the page.
 *
 * What changed is only the ALTERNATIVE. This is shown where the page would
 * otherwise render an apology and an empty panel, which is strictly worse than
 * a working chart with somebody's watermark in the corner:
 *
 *   Chart unavailable right now
 *   Couldn't read the chart just now (GeckoTerminal is rate limited — cooling
 *   down for 44s; DexScreener has no chart at any path we know …)
 *
 * That is a real state on this box: the GT free ceiling is ~10 req/min for the
 * whole IP, and DexScreener publishes no documented OHLCV endpoint, so our
 * native DexScreener path is a guess that `ds:probe` has not yet landed.
 */
// Relative import, not the "@/" alias — node:test resolves this file too, and
// the rule it holds (never a URL for a chain DexScreener lacks) is worth a real
// test rather than a source scan. The same note `dexscreener.ts` carries.
import { CHAINS } from "../config/chains.ts";

/**
 * The embeddable URL for a token's DexScreener page, or null.
 *
 * ⚠️ NULL WHEN DEXSCREENER DOES NOT INDEX THE CHAIN — never a constructed URL
 * for a chain it has never heard of. Framing that shows DexScreener's own "not
 * found" inside our panel, which reads as OUR page being broken and is worse
 * than the honest apology it replaced. The registry is the one owner of which
 * chains it covers (`dsCovers` orders the market cycle on the same field).
 *
 * A TOKEN address is passed, not a pair: dexscreener.com resolves it to that
 * token's top pair itself, so this costs no request of ours and cannot go stale
 * the way a cached pair address can.
 */
export function dsEmbedUrl(chain: string, address: string): string | null {
  const slug = CHAINS[chain]?.dexscreener;
  if (!slug || !address) return null;
  // `embed=1` drops their nav and header; `info=0&trades=0` leaves the chart
  // and nothing else, so the panel carries a chart rather than a whole site.
  return (
    `https://dexscreener.com/${slug}/${encodeURIComponent(address)}` +
    `?embed=1&theme=dark&info=0&trades=0&chartLeftToolbar=0`
  );
}
