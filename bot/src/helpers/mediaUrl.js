"use strict";
/**
 * Is this logo url one of OUR OWN uploads — and what is its site-relative path?
 *
 * ⚠️ TWO SPELLINGS OF ONE UPLOAD. `api.uploadImage` returned
 * `${DEXVRA_API_BASE}${url}` — an ABSOLUTE `http://127.0.0.1:3005/api/media/
 * <hex>.png` — while its call site's comment said "relative", and the row was
 * stored that way for a month. Every consumer knew only the relative form:
 * the site proxied the absolute one and drew a monogram (non-https localhost
 * is refused by /api/logo's allowlist), and the moment this bot's banner fetch
 * moved behind that same proxy it lost the artwork too — and reported *"no
 * gateway served it as an image"* about a file on its own disk.
 *
 * The producer stores the relative form now; this accepts BOTH so every row
 * stored the old way keeps working. Mirrors `mediaPath` in src/lib/mediaFile.ts,
 * because this package cannot import a .ts module and a rule about which url
 * is ours has to be the same rule on both sides of the box.
 *
 * ⚠️ A FOREIGN HOST WITH THE SAME PATH IS NOT AN UPLOAD. `https://evil.example/
 * api/media/<hex>.png` must keep going through the proxy and its allowlist.
 */
const { SITE_URL, DEXVRA_API_BASE } = require("../config/constants");

const NAME_RE = /^\/api\/media\/([a-f0-9]{24}\.(?:png|jpe?g|gif|webp))$/i;

const hostOf = (origin) => {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const OWN_HOSTS = new Set(
  ["127.0.0.1", "localhost", "::1", hostOf(SITE_URL), hostOf(DEXVRA_API_BASE)].filter(Boolean),
);

/** `/api/media/<name>` for a relative or own-origin absolute upload url; null for anything else. */
function mediaPath(url) {
  const s = String(url == null ? "" : url).trim();
  if (!s) return null;
  const rel = NAME_RE.exec(s);
  if (rel) return `/api/media/${rel[1].toLowerCase()}`;
  if (!/^https?:\/\//i.test(s)) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!OWN_HOSTS.has(u.hostname.toLowerCase())) return null;
  const m = NAME_RE.exec(u.pathname);
  return m ? `/api/media/${m[1].toLowerCase()}` : null;
}

module.exports = { mediaPath, _OWN_HOSTS: OWN_HOSTS };
