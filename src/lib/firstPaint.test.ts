// WHAT THE READER SEES FIRST, and how long they wait for it.
//
// Two causes, both measured in a real browser rather than reasoned about. The
// board was fetched by the CLIENT, so first paint was skeleton rows and the
// real numbers were three serial steps away — bundle, hydrate, round trip. And
// the webfonts arrived through a CSS `@import`, which is three more serial
// round trips to a third-party origin, all render-blocking, and a pending
// stylesheet stops SCRIPTS from running: /api/tokens was not even requested
// until t=13056ms. Time to the first real board row went 13470ms → 467ms.
//
// These are source scans: every file below is a .tsx behind the "@/" alias,
// which this runner cannot resolve. Each one is mutation-tested against the
// revision it describes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Comments quote the defect they guard against — `@import` appears in the
 *  note left where the old one was, and a scan that read it would pass on the
 *  revision it exists to catch. */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ROOT = read("src/app/layout.tsx");
const SITE = read("src/app/(site)/layout.tsx");
const APP = read("src/components/AppState.tsx");
const CSS = read("src/app/globals.css");
const MOVERS = read("src/components/MarketMovers.tsx");

test("⚠️ no stylesheet is @import'ed from a third party — that is three serial round trips", () => {
  // The browser must download and parse globals.css before it can even discover
  // an @import, then open a fresh connection for the CSS, then a third for the
  // .woff2 files. All render-blocking, and a pending stylesheet also blocks
  // script execution — so hydration and the board's own fetch waited on Google.
  assert.doesNotMatch(strip(CSS), /@import/, "globals.css is loading something over the network");
});

test("the font CSS is loaded NON-BLOCKING, with both origins preconnected", () => {
  const body = strip(ROOT);
  assert.match(body, /rel="preconnect" href="https:\/\/fonts\.googleapis\.com"/);
  assert.match(body, /rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossOrigin/,
    "the file host needs its own preconnect, and it is a CORS fetch");
  // media="print" does not match a screen, so it is fetched at low priority and
  // never blocks; the promoter turns it on once it has arrived.
  assert.match(body, /rel="stylesheet" href=\{FONT_CSS\} media="print"/);
  assert.match(body, /l\.sheet\?go\(\):l\.addEventListener\('load',go\)/,
    "a cached file can be ready before the script runs, and a fired onload never fires again");
  assert.match(body, /<noscript>[\s\S]*?href=\{FONT_CSS\}[\s\S]*?<\/noscript>/,
    "with no JS nothing can promote the link");
  // One owner: the URL is referenced twice and two spellings would eventually
  // load two different sets of faces.
  assert.equal((body.match(/https:\/\/fonts\.googleapis\.com\/css2/g) ?? []).length, 1);
  assert.match(body, /display=swap/, "text must be readable in the fallback face while it arrives");
});

test("⚠️ the board arrives WITH the html — the layout seeds it and is rendered per request", () => {
  const body = strip(SITE);
  assert.match(body, /export const dynamic = "force-dynamic";/,
    "prerendered, the board would be frozen at whatever the market looked like at build time");
  assert.match(body, /<AppProvider initialData=\{initialData\} initialFng=\{initialFng\}>/);
  // …and the head start may never cost more than the shell it replaced.
  assert.match(body, /within\(getTokensPayload\(\), SSR_WAIT_MS\)/);
  assert.match(body, /within\(getFearGreed\(\), SSR_WAIT_MS\)/);
  assert.match(body, /const SSR_WAIT_MS = [\d_]+;/);
  assert.match(body, /initialData: tokens\.ok \? tokens\.value : null/,
    "a server-side failure must cost the head start and nothing else");
});

test("AppProvider actually seeds its state from what the server handed it", () => {
  const body = strip(APP);
  assert.match(body, /useState<TokensPayload \| null>\(initialData\)/);
  assert.match(body, /useState<FearGreed \| null>\(initialFng\)/);
  // The polling effect is untouched and still loads on mount, which is what
  // makes the seed a pure head start rather than a trade against freshness.
  assert.match(body, /if \(visible\(\)\) void load\(\);\n\s*const id = setInterval\(tick, POLL_TOKENS_MS\);/);
});

test("⚠️ a relative time is not rendered on the server — it is the one string that depends on WHEN", () => {
  // freshness() would be computed once against the server clock and again, a
  // second later, against the browser's: different text for identical props,
  // which is a hydration mismatch React patches over in silence.
  const body = strip(MOVERS);
  assert.match(body, /loading \|\| !mounted \? "…" : <>\{freshness\(updatedAt\)\}/);
  assert.match(body, /useEffect\(\(\) => setMounted\(true\), \[\]\)/);
});

// ── The check itself ────────────────────────────────────────────────────────
// `npm run firstpaint:check` replaced a one-liner that printed 0 in the seconds
// after a restart and read as a broken deploy. Its own first two cuts each
// carried a defect of exactly the kind it exists to catch, so its predicates
// are exported and driven here rather than trusted.
const { boardRows, fontVerdict, importsOverNetwork } = await import("../../scripts/firstpaint-check.mjs");

test("the row count ignores the header row", () => {
  assert.equal(boardRows('<div class="board"><div class="row head">h</div><div class="row  ">a</div><div class="row ">b</div></div>'), 2);
  assert.equal(boardRows('<div class="row head">h</div>'), 0, "a header alone is not a board");
  assert.equal(boardRows("<div>nothing</div>"), 0);
});

test("⚠️ the <noscript> fallback is SUPPOSED to have no media=print — the check may not call it broken", () => {
  // The first cut matched it and reported correct code as red. A check that is
  // red on a healthy page teaches the reader to ignore the red.
  const good =
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?x" media="print" data-webfont=""/>' +
    "<script>!function(){var l=q();l.sheet?go():l.addEventListener('load',go)}()</script>" +
    '<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?x"/></noscript>';
  const v = fontVerdict(good);
  assert.deepEqual(
    { links: v.links, blocking: v.blocking, promoted: v.promoted, noscript: v.noscript, preconnected: v.preconnected },
    { links: 1, blocking: 0, promoted: true, noscript: true, preconnected: true },
  );
});

test("…and it does catch a genuinely render-blocking font link", () => {
  const bad = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?x"/>';
  const v = fontVerdict(bad);
  assert.equal(v.blocking, 1);
  assert.equal(v.promoted, false);
  assert.equal(v.noscript, false);
  assert.equal(v.preconnected, false);
});

test("⚠️ a MINIFIED @import is the one the build actually emits", () => {
  // The first cut only matched the source spelling `@import url('…')`, so it
  // printed ✓ over the very build it exists to catch: a minifier rewrites that
  // as `@import"…"`.
  assert.equal(importsOverNetwork('@import"https://fonts.googleapis.com/css2?x";body{}'), true, "minified");
  assert.equal(importsOverNetwork("@import url('https://fonts.googleapis.com/css2?x');"), true, "source spelling");
  assert.equal(importsOverNetwork("@import url(https://fonts.googleapis.com/css2?x);"), true, "unquoted");
  assert.equal(importsOverNetwork('@import "./local.css";'), false, "a local import costs no round trip");
  assert.equal(importsOverNetwork("body{color:red}"), false);
});
