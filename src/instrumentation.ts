/**
 * The web app's BOOT LINE — what `dexvra-bot` and `dexvra-tradebot` have always
 * printed and the site never did.
 *
 * The release flow in CLAUDE.md ends with "verify what is running before
 * believing anything about it", and every process prints its commit at boot —
 * except this one, which is exactly the process whose deploy has now twice been
 * mistaken for a code fault (a stale remote ref merged as a no-op, then a
 * banner that only printed once a request happened to import its module).
 *
 * Next 14 calls `register()` ONCE per server start — `next start` and `next
 * dev`, and NOT during `next build` (measured on 14.2.35: a full build log
 * contains neither line).
 *
 * ⚠️ AND IT MUST NEVER THROW. Next re-throws anything but MODULE_NOT_FOUND out
 * of `prepareImpl()` while the server is starting, so an exception in here does
 * not lose a log line — it takes the whole site down. A boot line is worth
 * nothing at that price, so the body is wrapped and a failure is reported and
 * swallowed.
 */
export async function register(): Promise<void> {
  // The hook runs in the edge runtime too; printing there would double the line
  // and the GT client is node-only anyway.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    console.log(`[boot] build ${process.env.NEXT_PUBLIC_BUILD || "unknown"} · node ${process.version} · pid ${process.pid}`);
    const { gtBanner } = await import("./lib/providers/gt");
    gtBanner();
    const { chartSourceBanner } = await import("./lib/ohlcv");
    console.log(chartSourceBanner());
    // Separate module, positive guard — see instrumentation.node.ts. Written
    // inline it takes mongo into the edge bundle and the build fails.
    if (process.env.NEXT_RUNTIME === "nodejs") {
      const { warmBoard } = await import("./instrumentation.node");
      warmBoard();
    }
  } catch (err) {
    console.error("[boot] instrumentation failed (the site is unaffected):", err);
  }
}
