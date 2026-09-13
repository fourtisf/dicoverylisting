// How often the trades feed may cost an upstream request — ONE owner, read by
// the route and by the panel.
//
// ⚠️ THEY USED TO DISAGREE, AND THE DISAGREEMENT WAS THE BUG. The route cached
// for 8s while the panel polled every 12s, so the entry expired ~4s before
// every single poll arrived: a lone viewer produced a guaranteed upstream miss
// on every tick, and the cache coalesced concurrent viewers and nothing else.
// On a box whose GeckoTerminal quota is counted per IP and shared with the bot
// suite, that was ~5 requests a minute per open token page.
//
// The chart already keeps its two numbers together (lib/ohlcv `pollMsFor`);
// this is the same rule for the tape.

/** How long one pool's trades stay fresh in the route's cache. */
export const TRADES_TTL_MS = 25_000;

/** What the panel polls at. Strictly ABOVE the TTL: polling inside it only ever
 *  re-reads the same bytes, and polling exactly at it races the expiry. */
export const TRADES_POLL_MS = TRADES_TTL_MS + 5_000;
