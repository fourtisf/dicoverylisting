/**
 * The token's own `logo()` string, or null — the ONE owner of what the Pons
 * provider may publish as artwork.
 *
 * Pure, and in its own module, for the reason `logoWrite.ts` and `relist.ts`
 * are: a rule about what may be published is something a source scan cannot
 * tell from a comment about one, so it is tested by being CALLED. It is also
 * the only part of the Pons reader that can be exercised without an RPC.
 *
 * ⚠️ THIS WAS `/^https?:\/\//.test(logo) ? logo : null`, AND IT THREW AWAY
 * EVERY PONS LOGO THERE IS. A launchpad pins its artwork on IPFS, so the string
 * the contract publishes is `ipfs://<cid>` — real artwork, and nulled here
 * before `/api/pons` could return it. The listing bot's review card then read
 * `Logo: not set` for a token whose picture is on its own pad page, and
 * `pons:check` printed the url the app was discarding, because the check reads
 * the CONTRACT and the app read this. A guard is only honest while it measures
 * the stack the caller actually uses.
 *
 * It is still an ALLOWLIST, because this string is written by whoever deployed
 * the token: anyone can launch on a permissionless pad, and `logo()` is free
 * text. What it allows is exactly what both consumers can RENDER —
 * `logoSrc` → `/api/logo` rewrites `ipfs://` to a gateway (with failover) and
 * the bot's `httpsLogo` does the same for the listing form. Publishing a scheme
 * neither can draw turns "no logo" into a broken image, which is worse than the
 * monogram: the monogram at least looks deliberate.
 *
 * ⚠️ `ar://` is deliberately NOT allowed, and that is a judgement rather than
 * an oversight. `arweave.net` is already on the proxy's host allowlist, so an
 * `https://arweave.net/<txid>` logo works today; what does not exist is an
 * `ar://` → gateway rewrite in either consumer, so allowing the URI here would
 * publish a value both of them refuse. If a Pons token ever ships one, the fix
 * is that rewrite — not a wider test here.
 */
export function tokenLogo(raw: string | null): string | null {
  const s = (raw ?? "").trim();
  // An on-chain string is unbounded; this one lands in a JSON payload, a
  // Telegram form and a listing row. A logo url is never four figures long.
  if (!s || s.length > 2048) return null;
  return /^(?:https?|ipfs):\/\//i.test(s) ? s : null;
}
