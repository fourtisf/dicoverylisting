// Page metadata and structured data.
//
// WHAT THIS IS FOR: a search for the brand name should return dexvra.io. Three
// things decide that, and none of them is a keyword:
//
//   1. The site has to be crawlable and enumerable — robots.ts + sitemap.ts.
//   2. Every page has to say WHICH url it is (canonical) and what it is about
//      (its own title/description, not the homepage's). One title repeated
//      across fifteen pages reads as one page to a crawler.
//   3. The brand has to be described in a machine-readable way, and linked to
//      the accounts that carry the same name — that is what `sameAs` on the
//      Organization node is, and it is the strongest signal available for
//      "these Telegram/X accounts and this domain are the same entity".
//
// None of this makes a ranking promise. It removes the reasons a site does not
// appear at all, which is a different and achievable thing.
import type { Metadata } from "next";
import { BRAND_NAME, BRAND_TAGLINE, BRAND_DOMAIN } from "../config/brand.ts";
import { SOCIALS, SUPPORT_EMAIL } from "../config/socials.ts";
import { SITE_ORIGIN, absolute, OG_IMAGE, LOGO_IMAGE } from "../config/site.ts";

export const SITE_DESCRIPTION =
  "Multi-chain token listing & discovery. Fresh launches, trending boards, and safety scans across Solana, Base, Ethereum, BSC, TON, Tron, and Robinhood Chain.";

interface PageMetaInput {
  /** The page's own title, WITHOUT the brand — the template adds it. */
  title: string;
  description: string;
  /** Site-relative path, e.g. "/trending". Becomes the canonical. */
  path: string;
  /** Leave a page out of the index without hiding it from users — the pages
   *  that are personal (watchlist, account) or a duplicate of a filtered view. */
  noindex?: boolean;
}

/**
 * Metadata for one page: its own title, its own description, and — the part
 * that is easy to forget and expensive to omit — its own canonical.
 *
 * Without a canonical, every query-string variant of a page (?ref=, ?chain=,
 * a tracking parameter someone pasted into Telegram) is a separate url to a
 * crawler, and the ranking signal for the page is split across all of them.
 */
export function pageMetadata({ title, description, path, noindex }: PageMetaInput): Metadata {
  const url = absolute(path);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: `${title} · ${BRAND_NAME}`,
      description,
      url,
      siteName: BRAND_NAME,
      images: [OG_IMAGE],
      type: "website",
      locale: "en_US",
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} · ${BRAND_NAME}`,
      description,
      images: [OG_IMAGE.url],
    },
    ...(noindex ? { robots: { index: false, follow: true } } : {}),
  };
}

// ── Structured data (JSON-LD) ────────────────────────────────────────────────
//
// Two nodes, one graph, emitted once on every page from the root layout.
//
// Organization is the brand record: the name, the mark, and `sameAs` — the list
// of accounts that are the same entity. A brand query is exactly the case this
// exists for; without it, "Dexvra" is a string on a page rather than a named
// thing with a website.
//
// WebSite carries `alternateName` (people type the bare domain as often as the
// name) and the SearchAction that makes Google offer a search box for the site
// in results. `@id` cross-links them so the two are read as one entity, not two.

const ORG_ID = `${SITE_ORIGIN}/#organization`;
const SITE_ID = `${SITE_ORIGIN}/#website`;

/** Every official account, straight from the socials list — the one place they
 *  are defined, so a renamed account cannot leave a dead `sameAs` behind. */
const sameAs = (): string[] => [...new Set(SOCIALS.map((s) => s.url))].sort();

export function organizationLd() {
  return {
    "@type": "Organization",
    "@id": ORG_ID,
    name: BRAND_NAME,
    alternateName: BRAND_DOMAIN,
    url: `${SITE_ORIGIN}/`,
    logo: {
      "@type": "ImageObject",
      url: absolute(LOGO_IMAGE),
      width: 512,
      height: 512,
    },
    image: absolute(OG_IMAGE.url),
    description: SITE_DESCRIPTION,
    slogan: BRAND_TAGLINE,
    sameAs: sameAs(),
    // The inbox, on the brand record: a "dexvra support" query is exactly what
    // an impersonator answers first, and a mailbox stated by the entity itself
    // is the one Google can attribute.
    email: SUPPORT_EMAIL,
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer support",
      email: SUPPORT_EMAIL,
      availableLanguage: ["en", "id"],
    },
  };
}

export function webSiteLd() {
  return {
    "@type": "WebSite",
    "@id": SITE_ID,
    name: BRAND_NAME,
    alternateName: [BRAND_DOMAIN, `${BRAND_NAME} Discovery`],
    url: `${SITE_ORIGIN}/`,
    description: SITE_DESCRIPTION,
    publisher: { "@id": ORG_ID },
    inLanguage: "en",
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${SITE_ORIGIN}/search?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}

/** The whole graph, ready to serialize into one <script type="application/ld+json">. */
export function siteJsonLd() {
  return { "@context": "https://schema.org", "@graph": [organizationLd(), webSiteLd()] };
}

/**
 * Serialize JSON-LD for embedding in a <script> tag.
 *
 * `<` is escaped because a token name or project description reaching this
 * unescaped could close the script element and inject markup — the payload is
 * partly operator- and partly project-supplied, so it is not trusted input.
 */
export const jsonLdText = (data: unknown): string =>
  JSON.stringify(data).replace(/</g, "\\u003c");
