/**
 * Node-only boot work, in its own file for a bundler reason rather than a
 * tidiness one.
 *
 * ⚠️ `instrumentation.ts` IS COMPILED FOR THE EDGE RUNTIME TOO, and an early
 * `return` is not something a bundler can act on: with the import written
 * inline, webpack still pulled `providers → store → mongo` into the edge bundle
 * and the whole build failed on `Can't resolve 'net'`. A dynamic import of a
 * SEPARATE module, inside a positive `process.env.NEXT_RUNTIME === "nodejs"`
 * branch, is the shape Next can eliminate — the constant is inlined, so the
 * edge build never follows this file at all.
 */

/**
 * ⚠️ THE FIRST VISITOR AFTER A RESTART IS THE ONE THE CACHE CANNOT COVER.
 *
 * `SiteLayout` seeds the board into the HTML from `getTokensPayload()` and
 * waits at most `SSR_WAIT_MS` for it — bounded on purpose, because a page that
 * hangs is worse than one that fetches late. A process that has just booted has
 * an empty cache, so a cold start is exactly what that bound catches: the board
 * is dropped from the HTML and those readers are back on the slow path until
 * the client fetch lands. This box is redeployed constantly, and the person
 * most likely to load the page in that window is the operator checking whether
 * the deploy worked.
 *
 * So the load starts at BOOT rather than on the first request. Fire-and-forget:
 * `register()` blocks the server from accepting connections, and waiting on a
 * market read before serving anything is the very stall this exists to avoid.
 * Its failure is free — `getTokensPayload` has its own fallback and its own
 * bound, and this only ever pre-pays a request somebody was going to make.
 */
export function warmBoard(): void {
  const t0 = Date.now();
  void import("./lib/providers")
    .then(({ getTokensPayload }) => getTokensPayload())
    .then((p) => console.log(`[boot] board warm in ${Date.now() - t0}ms · ${p.tokens.length} token(s) · live ${p.live}`))
    // Said, not swallowed: a cold board is why a reader gets skeleton rows, and
    // "it could not be warmed" and "nobody has asked yet" are different facts.
    .catch((err) => console.warn("[boot] board could not be warmed:", err instanceof Error ? err.message : err));
}
