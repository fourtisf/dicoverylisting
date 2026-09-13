// Search-engine surface: canonicals, structured data, robots, sitemap.
//
// The goal these serve is narrow and worth stating: a search for the brand name
// should return dexvra.io. Nothing here promises a ranking — what it does is
// remove the reasons a site does not appear at all, and every case below is one
// of those reasons that was real in this repo before the file existed (no
// sitemap, no robots.txt, one title shared by fifteen pages, a social card
// image that shipped in public/ and was never referenced).
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { BRAND_DOMAIN, BRAND_NAME } from "../config/brand.ts";
import { SOCIALS } from "../config/socials.ts";
import { SITE_ORIGIN, absolute, OG_IMAGE } from "../config/site.ts";
import { organizationLd, webSiteLd, siteJsonLd, jsonLdText, pageMetadata } from "./seo.ts";

const root = (p: string) => path.join(process.cwd(), p);
const read = (p: string) => fs.readFileSync(root(p), "utf8");

// ── The origin ──────────────────────────────────────────────────────────────

test("the canonical origin is the brand domain, absolute and unslashed", () => {
  assert.strictEqual(SITE_ORIGIN, `https://${BRAND_DOMAIN}`);
  // A trailing slash here doubles up in every absolute() call ("//trending"),
  // and a bare host makes `new URL()` throw at build time in the root layout.
  assert.doesNotMatch(SITE_ORIGIN, /\/$/);
  assert.match(SITE_ORIGIN, /^https:\/\//);
  assert.strictEqual(absolute("/trending"), `https://${BRAND_DOMAIN}/trending`);
  assert.strictEqual(absolute("trending"), `https://${BRAND_DOMAIN}/trending`, "a missing leading slash must not join wrong");
});

// ── Structured data ─────────────────────────────────────────────────────────

test("the Organization node names the brand and links every official account", () => {
  const org = organizationLd();
  assert.strictEqual(org.name, BRAND_NAME);
  assert.strictEqual(org.url, `${SITE_ORIGIN}/`);
  assert.match(org.logo.url, /^https:\/\//, "a relative logo is dropped by consumers of JSON-LD");
  // sameAs is the strongest available signal that these accounts and this
  // domain are one entity — the whole point of a brand query.
  for (const s of SOCIALS) {
    assert.ok(org.sameAs.includes(s.url), `sameAs is missing ${s.url} — it is an official account`);
  }
  assert.strictEqual(new Set(org.sameAs).size, org.sameAs.length, "duplicate sameAs entries");
});

test("the WebSite node cross-links the Organization rather than repeating it", () => {
  const site = webSiteLd();
  const org = organizationLd();
  // Two unlinked nodes read as two entities. The @id reference is what makes
  // them one.
  assert.strictEqual(site.publisher["@id"], org["@id"]);
  assert.notStrictEqual(site["@id"], org["@id"], "the two nodes need distinct ids");
  assert.ok(site.alternateName.includes(BRAND_DOMAIN), "people type the bare domain as often as the name");
});

test("the sitelinks search box points at a route that exists", () => {
  const target = webSiteLd().potentialAction.target.urlTemplate;
  assert.match(target, /^https:\/\//);
  assert.ok(target.includes("{search_term_string}"), "the placeholder is what makes it a template");
  const routePath = target.replace(SITE_ORIGIN, "").split("?")[0];
  assert.ok(
    fs.existsSync(root(`src/app/(site)${routePath}/page.tsx`)),
    `SearchAction points at ${routePath}, which is not a page — Google drops the whole node`,
  );
});

test("the graph is one document, and nothing in it can close the script tag", () => {
  const graph = siteJsonLd();
  assert.strictEqual(graph["@context"], "https://schema.org");
  assert.strictEqual(graph["@graph"].length, 2);
  // The payload carries operator-supplied strings. An unescaped "<" would end
  // the <script> element early and put the rest of the JSON into the document.
  const text = jsonLdText({ evil: "</script><img src=x onerror=alert(1)>" });
  assert.ok(!text.includes("</script>"), `jsonLdText left a closing tag in: ${text}`);
  assert.deepStrictEqual(JSON.parse(text), { evil: "</script><img src=x onerror=alert(1)>" }, "escaping must not corrupt the value");
  // And it round-trips as valid JSON, or the node is silently ignored.
  JSON.parse(jsonLdText(graph));
});

// ── Per-page metadata ───────────────────────────────────────────────────────

test("every page gets its own canonical — not the homepage's", () => {
  const m = pageMetadata({ title: "Gainers & Losers", description: "d", path: "/trending" });
  assert.strictEqual(m.alternates?.canonical, `${SITE_ORIGIN}/trending`);
  // Without this, ?ref= and every tracking parameter someone pastes into
  // Telegram becomes a separate url, splitting the page's signal across all of
  // them.
  assert.strictEqual(m.openGraph?.url, `${SITE_ORIGIN}/trending`);
});

test("the social card image is referenced, and absolutely", () => {
  // og-image.png shipped in public/brand and nothing pointed at it, so every
  // link to the site shared as a blank rectangle.
  assert.ok(fs.existsSync(root(`public${OG_IMAGE.url}`)), `${OG_IMAGE.url} is referenced but not in public/`);
  const m = pageMetadata({ title: "T", description: "d", path: "/x" });
  const img = (m.openGraph?.images as Array<{ url: string }>)[0];
  assert.strictEqual(img.url, OG_IMAGE.url);
  assert.strictEqual(m.twitter?.card, "summary_large_image");
});

test("noindex is opt-in and still follows links", () => {
  const open = pageMetadata({ title: "T", description: "d", path: "/x" });
  assert.strictEqual(open.robots, undefined, "a normal page must not carry a robots override");
  const hidden = pageMetadata({ title: "T", description: "d", path: "/x", noindex: true });
  assert.deepStrictEqual(hidden.robots, { index: false, follow: true }, "nofollow would strand the pages it links to");
});

// ── Wiring: the files that make the above reachable ─────────────────────────

test("the root layout sets metadataBase and a title template", () => {
  const src = read("src/app/layout.tsx");
  // Without metadataBase, Next drops every relative OG/Twitter image.
  assert.match(src, /metadataBase:\s*new URL\(SITE_ORIGIN\)/);
  // Without a template, a child page's title loses the brand — and a title with
  // no brand in it cannot win a brand search.
  assert.match(src, /template:\s*`%s · \$\{BRAND_NAME\}`/);
  assert.match(src, /application\/ld\+json/, "the structured data is not emitted anywhere");
});

test("every public page carries its own title, and the personal ones are hidden", () => {
  // Every page.tsx under (site), at any depth — a plain segment like `token/`
  // holds no page of its own and needs no metadata, while `token/[chain]/
  // [address]/` is the biggest set of pages on the site and very much does.
  const pageDirs: string[] = [];
  const walk = (rel: string) => {
    for (const d of fs.readdirSync(root(rel), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const next = `${rel}/${d.name}`;
      if (fs.existsSync(root(`${next}/page.tsx`))) pageDirs.push(next);
      walk(next);
    }
  };
  walk("src/app/(site)");
  assert.ok(pageDirs.length >= 12, `only found ${pageDirs.length} pages — the walk is not finding them`);

  for (const dir of pageDirs) {
    const carries = (f: string) =>
      fs.existsSync(root(f)) && /export const metadata|generateMetadata/.test(read(f));
    assert.ok(
      carries(`${dir}/layout.tsx`) || carries(`${dir}/page.tsx`),
      `${dir.replace("src/app/(site)", "")} has no metadata — it inherits the homepage title and reads as a duplicate page`,
    );
  }

  // The two personal pages are noindex, and must therefore also be absent from
  // the sitemap: asking Google to crawl a page you told it not to index is a
  // contradiction it reports as an error in Search Console.
  const sitemap = read("src/app/sitemap.ts");
  for (const personal of ["watchlist", "account"]) {
    assert.match(
      read(`src/app/(site)/${personal}/layout.tsx`),
      /noindex:\s*true/,
      `/${personal} is personal and should not be indexed`,
    );
    assert.ok(!sitemap.includes(`"/${personal}"`), `/${personal} is noindex but still listed in the sitemap`);
  }
});

test("robots.txt allows the site, hides the admin surface, and names the sitemap", () => {
  const src = read("src/app/robots.ts");
  assert.match(src, /sitemap:/, "without this a crawler has no page list to find");
  assert.match(src, /"\/panel"/, "the admin login screen must never rank for the brand name");
  assert.match(src, /"\/api\/"/);
});

test("the sitemap lists real routes and survives an unreachable store", () => {
  const src = read("src/app/sitemap.ts");
  const paths = [...src.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(paths.includes("/"), "the homepage is missing from the sitemap");
  for (const p of paths) {
    if (p === "/") continue;
    assert.ok(
      fs.existsSync(root(`src/app/(site)${p}/page.tsx`)),
      `sitemap lists ${p}, which is not a page — a 404 in a sitemap costs trust in the whole file`,
    );
  }
  // Token pages are the bulk of the site; a store hiccup must degrade to the
  // static routes rather than 500, which makes Google drop the file entirely.
  assert.match(src, /catch\s*\{/, "the token lookup is not guarded");
});

test("www redirects to the apex — permanently, and never on an admin host", () => {
  const src = read("src/middleware.ts");
  // The domain has a `www` CNAME, so both spellings serve the same pages. Two
  // addresses for one site splits every ranking signal between them, which is
  // how a brand ends up ranking for neither.
  assert.match(src, /NextResponse\.redirect\(url, 308\)/, "no permanent www → apex redirect");
  // hostname, not host: `host` carries the port, and rewriting it drops :3000.
  assert.match(src, /url\.hostname = name\.slice\(4\)/, "the redirect rewrites the wrong URL field");

  // It has to sit INSIDE the public-host branch. www.dexvra.fun is an admin
  // host, and redirecting it would push the panel onto the public site.
  const publicBranch = src.match(/if \(!onAdminHost\) \{[\s\S]*?\n {2}\}/);
  assert.ok(publicBranch, "the public-host branch moved — this guard cannot check itself");
  assert.ok(publicBranch[0].includes("308"), "the www redirect escaped the public-host branch");
});

test("the admin host tells crawlers to stay out", () => {
  // A second domain carrying the brand name is exactly what a brand query does
  // not need. Every public path there 404s, but a 404 on /robots.txt reads as
  // "crawl whatever you like".
  const src = read("src/middleware.ts");
  assert.match(src, /pathname === "\/robots\.txt"/);
  assert.match(src, /Disallow: \//);
});
