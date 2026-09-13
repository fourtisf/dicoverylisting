// The site's canonical origin, and the helpers every SEO surface reads.
//
// One definition, because search engines punish disagreement: a canonical tag
// saying dexvra.io, a sitemap saying www.dexvra.io and an OG image on a relative
// path are three ways of telling Google this is three different sites. Every
// absolute URL the app emits — canonicals, sitemap entries, JSON-LD ids, social
// card images — is built from SITE_ORIGIN.
//
// Overridable so a staging deploy does not publish canonicals pointing at
// production (which would ask Google to index prod's copy of a preview page).
// Set NEXT_PUBLIC_SITE_URL in that environment; leave it unset in production.
import { BRAND_DOMAIN, BRAND_NAME } from "./brand.ts";

/** Trailing slash stripped, scheme forced — `new URL()` throws on a bare host,
 *  and a metadataBase that throws takes the whole page down at build time. */
function normalizeOrigin(raw: string | undefined): string {
  const v = String(raw || "").trim();
  if (!v) return `https://${BRAND_DOMAIN}`;
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  return withScheme.replace(/\/+$/, "");
}

export const SITE_ORIGIN = normalizeOrigin(process.env.NEXT_PUBLIC_SITE_URL);

/** An absolute URL for a site-relative path. */
export const absolute = (path = "/"): string =>
  `${SITE_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;

// The social-card image. It already existed in public/brand and nothing
// referenced it, so every link to the site shared as a blank rectangle.
export const OG_IMAGE = {
  url: "/brand/og-image.png",
  width: 1200,
  height: 630,
  alt: `${BRAND_NAME} — multi-chain token listing & discovery`,
};

/** The logo used by structured data (Organization.logo). Square, not the OG
 *  banner: Google rejects a wide crop where it expects a mark. */
export const LOGO_IMAGE = "/icons/icon-512.png";
