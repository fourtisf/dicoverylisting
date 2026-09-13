import { MEDIA_MAX_BYTES, saveMedia } from "../mediaStore.ts";
import { mediaPath } from "../mediaFile.ts";

/**
 * PIN A RESOLVED LOGO ONTO OUR OWN DISK, so no post ever asks a public gateway
 * for it again.
 *
 * ⚠️ THE LAST DICE ROLL IN THE ARTWORK CHAIN. `$GG`'s CID flipped ✓/✗ across
 * four deploys with ZERO lines changed on that path — whether a public gateway
 * holds a CID this minute is a fact about that gateway's cache, and every
 * render re-rolled it. The paid post learnt to pin the bytes it just drew from;
 * the RESOLVER — which is what actually fills most rows, in the background,
 * where nobody is watching — did not, so a healed row kept a gateway url for
 * ever and `post:check` could only print a `--pin` line for an operator to
 * remember. **apt-get install is not a fix, it is a request**, and that rule
 * has cost this repo six days of banners once already.
 *
 * BEST-EFFORT AND SILENT ON FAILURE. The row already has a url that loaded a
 * moment ago; a pin that cannot be made leaves exactly today's behaviour, which
 * is why nothing here throws and nothing here clears.
 *
 * ⚠️ AND IT IS THE ONLY WRITE A BACKGROUND SWEEP MAY MAKE, which is what makes
 * it safe: `commit` is the store's compare-and-set (`applyPinnedLogo`) — the
 * destination must be one of OUR uploads, the source must still be the exact
 * external url the row holds, and an admin who set a different logo in between
 * wins silently.
 */
const FETCH_MS = Number(process.env.LOGO_PIN_MS) > 0 ? Number(process.env.LOGO_PIN_MS) : 6000;

export interface PinDeps {
  fetchBytes?: (url: string) => Promise<Uint8Array | null>;
  save?: (bytes: Uint8Array) => Promise<{ url: string } | null>;
  commit?: (chain: string, address: string, fromUrl: string, toUrl: string) => Promise<boolean>;
}

/** Whether this url is worth pinning at all. */
export function pinnable(url: string): boolean {
  const s = String(url ?? "").trim();
  // Already ours — the whole point of the pin. `mediaPath` is the one owner of
  // that question, and it accepts the relative form AND an absolute on one of
  // our own hosts, because both spellings have been stored.
  if (mediaPath(s)) return false;
  return /^https?:\/\/[^\s"'<>]+$/i.test(s);
}

/**
 * ⚠️ REDIRECTS ARE FOLLOWED, and that is a judgement rather than an oversight.
 *
 * `/api/logo` follows them BY HAND and re-checks every hop, because it serves
 * the bytes back to a browser and an allowed host answering `302
 * http://169.254.169.254/…` would have this server fetch its own cloud
 * metadata and publish it. Neither half is true here: this is the SAME request
 * `tokenLogo.checkImage` made moments ago to verify the url (same default
 * follow, same third-party candidate list), so it adds no class of exposure —
 * and what comes back is stored only if `sniffImage` says it is a PNG, JPG,
 * GIF or WEBP, which no metadata endpoint answers with. Recorded so it is not
 * rediscovered as an oversight.
 */
async function defaultFetch(url: string): Promise<Uint8Array | null> {
  let r: Response;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS), redirect: "follow" });
  } catch {
    return null;
  }
  if (!r.ok) {
    // Release it: this runs per resolved row on a server doing this all day.
    try { await r.arrayBuffer(); } catch { /* nothing to release */ }
    return null;
  }
  // Refuse an oversized body BEFORE downloading it where the host declares one.
  const len = Number(r.headers.get("content-length") || 0);
  if (len && len > MEDIA_MAX_BYTES) {
    try { await r.arrayBuffer(); } catch { /* nothing to release */ }
    return null;
  }
  try {
    const buf = new Uint8Array(await r.arrayBuffer());
    return buf.byteLength > 0 && buf.byteLength <= MEDIA_MAX_BYTES ? buf : null;
  } catch {
    return null;
  }
}

/**
 * @returns the `/api/media/...` url now on the row, or null when nothing was
 *   pinned — which is never an error and never a reason to touch the row.
 */
export async function pinResolvedLogo(
  chain: string,
  address: string,
  url: string,
  deps: PinDeps = {},
): Promise<string | null> {
  if (!pinnable(url)) return null;
  const bytes = await (deps.fetchBytes ?? defaultFetch)(url);
  if (!bytes) return null;
  const saved = await (deps.save ?? saveMedia)(bytes);
  if (!saved) return null;
  if (!deps.commit) return null;
  // ⚠️ THE CAS DECIDES, NOT US. A row that moved on between the resolve and
  // here keeps what it moved to; the file we just wrote is then orphaned, which
  // costs bytes and never a wrong picture — the direction this trade has to go.
  const wrote = await deps.commit(chain, address, url, saved.url).catch(() => false);
  return wrote ? saved.url : null;
}
