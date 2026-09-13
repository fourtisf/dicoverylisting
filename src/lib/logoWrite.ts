import { mediaPath } from "./mediaFile.ts";
// The one write the background logo sweep is allowed to make to the public
// listing store — as a PURE decision, so the rule can be driven by a test.
//
// store.ts is unreachable from the node:test runner (it imports "./listings"
// without an extension, which only Next resolves), and this is exactly the kind
// of rule that must not be tested by reading the source: "never overwrites" is a
// mutation property, and a source scan cannot tell a guard from a comment about
// one. Same split as pnl.js in the trade bot — the arithmetic lives where a test
// can call it, the I/O stays in the store.

export interface LogoRow {
  chain: string;
  address: string;
  logoUrl?: string;
}

/**
 * Fill in a resolved logo for one listing.
 *
 * ⚠️ IT CAN ONLY TURN "NOTHING" INTO "SOMETHING". An admin-set logo and a
 * project's own upload are decisions somebody made; a resolved one is the site
 * filling a blank. That asymmetry is what makes this safe to call from a
 * background sweep nobody is watching, and it is the whole function.
 *
 * The address matches case-insensitively (a checksummed address from a market
 * provider and a lowercased one in the store are the same token) and the chain
 * exactly (the same address on two chains is two tokens).
 *
 * Returns the rows to persist and whether anything actually changed, so a sweep
 * can report how much of its work became permanent rather than only living in
 * one process's memory.
 */
export function applyResolvedLogo<T extends LogoRow>(
  rows: T[],
  chain: string,
  address: string,
  logoUrl: string,
): { rows: T[]; wrote: boolean } {
  // The value lands on a public board and in the bot's channel posts, so it is
  // checked here rather than trusted from whatever source produced it.
  if (!/^https:\/\/[^\s"'<>]+$/i.test(String(logoUrl ?? "").trim())) return { rows, wrote: false };
  const want = String(address ?? "").toLowerCase();
  if (!want || !chain) return { rows, wrote: false };

  let wrote = false;
  const next = rows.map((r) => {
    if (wrote || r.chain !== chain || String(r.address).toLowerCase() !== want || r.logoUrl) return r;
    wrote = true;
    return { ...r, logoUrl };
  });
  return wrote ? { rows: next, wrote } : { rows, wrote };
}

/**
 * Forget an uploaded logo whose FILE IS GONE.
 *
 * ⚠️ THIS IS THE ONE WRITE IN THIS FILE THAT TURNS SOMETHING INTO NOTHING, and
 * the asymmetry above is why it needs its own function and its own guard rather
 * than a flag on `applyResolvedLogo`. It is justified by one fact and no
 * judgement: the "something" does not exist. `/api/media/<hex>.png` with no
 * file behind it is not artwork somebody chose, it is a 404 wearing the shape
 * of one — and while the row holds it, `applyResolvedLogo` can never write the
 * replacement the resolver finds, because that guard sees a `logoUrl` and stops.
 *
 * It can only ever clear an UPLOAD. An external https logo may be temporarily
 * unreachable — a CDN blip, a hotlink block, a rate limit — and none of those
 * is knowable from this server; clearing one would delete a project's artwork
 * over a bad minute. An upload is on our own disk: its absence is a local fact,
 * decided by `lostUploads`, which refuses to answer at all when the directory
 * itself cannot be read.
 *
 * The caller has already established the file is missing. This is the rule for
 * what may then be written, kept pure so "only an upload, only this row" is
 * driven by a test instead of read off the source.
 */
/**
 * Swap an EXTERNAL logo for OUR OWN COPY of the same bytes — a COMPARE-AND-SWAP,
 * never an overwrite.
 *
 * WHY THIS EXISTS. `$GG`'s artwork loaded on two deploys and failed on two with
 * zero lines changed on the logo path: the row pointed at a public IPFS
 * gateway, and whether that gateway had the CID cached changed hour by hour.
 * Nothing REMEMBERED an immutable, content-addressed picture, so every paid
 * post re-ran a cold three-gateway lookup inside a 12s window. A logo that has
 * loaded ONCE is bytes in hand; this points the row at our own copy so no later
 * banner, Telegram photo, tweet or board ever asks a gateway for it again.
 *
 * ⚠️ IT IS A CAS, AND EACH GUARD IS A RULE THIS FILE ALREADY KEEPS:
 *   · `toUrl` must be OUR upload shape — this path may only ever point a row at
 *     our own disk, never at a second external host;
 *   · `fromUrl` must be an external https url — an upload is never re-pinned;
 *   · the row must STILL hold exactly `fromUrl` — an admin who changed the logo
 *     between the bot's fetch and its pin wins, which is the asymmetry
 *     `applyResolvedLogo` exists to keep ("a caller can be wrong about what it
 *     is holding, and the store cannot");
 *   · a BLANK is never filled — that is `applyResolvedLogo`'s job, and a blank
 *     may have been cleared on purpose.
 * A dedicated rule rather than the PATCH route because `updateListing` writes
 * unconditionally and would re-fill a logo an admin had just cleared.
 */
export function applyPinnedLogo<T extends LogoRow>(
  rows: T[],
  chain: string,
  address: string,
  fromUrl: string,
  toUrl: string,
): { rows: T[]; wrote: boolean } {
  const to = String(toUrl ?? "").trim();
  if (!isUpload(to)) return { rows, wrote: false };
  const from = String(fromUrl ?? "").trim();
  if (!/^https?:\/\//i.test(from)) return { rows, wrote: false };
  const want = String(address ?? "").toLowerCase();
  if (!want || !chain) return { rows, wrote: false };
  let wrote = false;
  const next = rows.map((r) => {
    if (wrote || r.chain !== chain || String(r.address ?? "").toLowerCase() !== want) return r;
    if (String(r.logoUrl ?? "").trim() !== from) return r; // the decision moved on — leave it
    wrote = true;
    return { ...r, logoUrl: to };
  });
  return wrote ? { rows: next, wrote } : { rows, wrote: false };
}

export function applyLostUpload<T extends LogoRow>(
  rows: T[],
  chain: string,
  address: string,
): { rows: T[]; wrote: boolean } {
  const want = String(address ?? "").toLowerCase();
  if (!want || !chain) return { rows, wrote: false };

  let wrote = false;
  const next = rows.map((r) => {
    if (wrote || r.chain !== chain || String(r.address).toLowerCase() !== want) return r;
    // Only an upload, and only one that is actually there to clear.
    if (!isUpload(r.logoUrl)) return r;
    wrote = true;
    const { logoUrl: _gone, ...rest } = r;
    return rest as T;
  });
  return wrote ? { rows: next, wrote } : { rows, wrote };
}

/** The same `/api/media/<24hex>.<ext>` shape the media route serves. Repeated
 *  here rather than imported so this module stays dependency-free — it is the
 *  rule file the test runner loads on its own. */
function isUpload(url: unknown): boolean {
  return /^\/api\/media\/[a-f0-9]{24}\.(?:png|jpe?g|gif|webp)$/i.test(String(url ?? "").trim());
}

/**
 * Heal a logo url stored in the bot's old ABSOLUTE spelling
 * (`http://127.0.0.1:3005/api/media/<hex>.png`) to the relative form every
 * consumer understands. A `data/listings.json` written by the old bot keeps
 * its rows for ever, and reading is the one place all of them pass through —
 * so `store.ts` calls this beside `healSeedLogos`, at BOTH load sites. Only an
 * url `mediaPath` vouches for is touched; an external logo is left exactly as
 * stored.
 *
 * PURE and here rather than in store.ts for the reason `applyResolvedLogo` is:
 * store.ts cannot be imported by the test runner (a bare `./listings`
 * specifier), and a mutation rule a test cannot CALL is a comment about one.
 * Returns how many rows it rewrote, so a load can say so.
 */
export function healUploadUrls(rows: Array<{ logoUrl?: string | null }>): number {
  let n = 0;
  for (const r of rows) {
    const rel = mediaPath(r.logoUrl);
    if (rel && rel !== r.logoUrl) {
      r.logoUrl = rel;
      n++;
    }
  }
  return n;
}
