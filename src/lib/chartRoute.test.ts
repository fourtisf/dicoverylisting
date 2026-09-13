// /api/ohlcv and the panel it feeds. Source guards, because the route imports
// "@/"-aliased Next modules the test runner cannot resolve — the numbers
// themselves are driven for real in ohlcv.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const ROUTE = read("src/app/api/ohlcv/route.ts");
const CHART = read("src/components/CandleChart.tsx");
const PAGE = read("src/app/(site)/token/[chain]/[address]/page.tsx");
const POOL = read("src/app/api/pool/route.ts");
const GTPOOL = read("src/lib/providers/gtPool.ts");
const CSS = read("src/app/globals.css");
/** Comments quote the code they guard, so a POSITIONAL check has to read the
 *  code alone — the first mention of the cache key in this route is the comment
 *  explaining why it is built after the chain check. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("⚠️ the candles are asked for OUR token, not the pool's base side", () => {
  // GT's OHLCV defaults to `base`, which is our token only by luck: in a
  // WETH/OURTOKEN pool it is WETH, and the page would draw Ethereum's chart
  // under a memecoin's ticker — a WRONG number, not a missing one.
  assert.match(ROUTE, /token,/);
  assert.match(ROUTE, /never the pool's base side/i, "and the reason is written down where the param is set");
});

test("a 404 is an answer about the pool; anything else means GT never looked", () => {
  // Caching a 429 would let a two-minute backoff blank every chart on the site
  // for the TTL — the bot's changeFromCandles lesson, one surface over.
  assert.match(ROUTE, /if \(res\.status === 404\) return null;/);
  assert.match(ROUTE, /class Unreadable extends Error/);
  const handler = ROUTE.slice(ROUTE.indexOf("export async function GET"));
  assert.match(handler, /catch/, "a transient failure answers without being cached");
  assert.ok(!/cached\([^)]*Unreadable/.test(ROUTE));
});

test("a pool address from the caller is a HINT, and a 404 on it re-resolves", () => {
  // The token page passes the pool GeckoTerminal named, but a preview built
  // from DexScreener carries a PAIR address GT has never indexed.
  assert.match(ROUTE, /A caller-supplied pool is a HINT/);
  // Distance-free: a character window between two lines breaks the moment a
  // comment is added between them, which is a test about formatting.
  assert.match(ROUTE, /if \(candles == null \|\| candles\.length === 0\)/, "a 404 OR an empty list re-resolves");
  assert.match(ROUTE, /topPoolAddress\(network, address\)/, "…to the pool GT does know");
  assert.match(ROUTE, /deeper\.length > 0 \|\| candles == null/, "and a worse answer there never replaces a good one");
});

test("⚠️ every answer names the BUILD that produced it", () => {
  // A chart that fails and a chart whose fix was never deployed look identical
  // from outside. Working that out cost a round trip on this endpoint: the
  // server had merged a stale remote ref, so the old code answered and nothing
  // said so. The stamp is the cheapest possible tell, and /api/token-preview
  // already carries it for the same reason.
  assert.match(ROUTE, /build: string;/, "it is part of the response shape, not a debug flag");
  assert.match(ROUTE, /process\.env\.NEXT_PUBLIC_BUILD/);
  // ⚠️ THE PROPERTY, NOT THE BRACE. This used to match `{ ok: true, ` — the
  // one-line spelling — and count `fail()` separately as the `+1`. A response
  // literal broken across lines carried no `{ ok:` on it, so the guard could
  // not see it at all: an UNSTAMPED multi-line response would have passed,
  // which is the one shape this test exists to catch. Counting the property
  // covers both spellings and drops the special case.
  // ⚠️ THE CODE, NOT THE PROSE. A comment in the route quoting `ok: true,` —
  // written to explain why the builders keep that spelling — counted as a
  // sixth response and failed this guard. The repo's own rule: a scan for a
  // line has to read the code, because comments quote the defect they guard.
  const src = code(ROUTE);
  const responses = (src.match(/\bok: (?:true|false),/g) ?? []).length;
  const stamped = (src.match(/build: BUILD/g) ?? []).length;
  assert.ok(responses >= 3, "the route builds at least the ok / no-candles / fail responses");
  assert.equal(stamped, responses, "every hand-built response — an unstamped one is the one you would be reading");
});

test("⚠️ the reason an upstream gave is never dropped on the way to the panel", () => {
  // The first live failure on the server answered a bare "Couldn't read the
  // chart just now." — the pool lookup throws a plain Error, so the branch that
  // only unwrapped `Unreadable` threw the reason away. Rate-limited, 404'd and
  // unreachable are three different problems, and that was one shrug for all.
  assert.match(ROUTE, /readWhy\(err\)/);
  assert.ok(!/: "Couldn't read the chart just now\."/.test(ROUTE), "no reasonless branch left");
});

test("'no pool yet' and 'we could not read it' stay different answers", () => {
  // An empty grid gives the reader the same reaction to both.
  assert.match(ROUTE, /No pool indexed for this token yet/);
  assert.match(ROUTE, /Couldn't read the chart just now/);
  assert.match(CHART, /status === "error" \? "Chart unavailable right now" : "No candles yet"/);
});

test("⚠️ an unknown chain is refused BEFORE the cache key is built", () => {
  // The key is `ohlcv:<chain>:…` and the cache lives as long as the process:
  // an unvalidated chain is an unbounded set of keys anybody can create from a
  // query string, for answers nobody could use.
  const handler = code(ROUTE.slice(ROUTE.indexOf("export async function GET")));
  const guard = handler.indexOf("if (!network)");
  const key = handler.indexOf("`ohlcv:");
  assert.ok(guard > 0 && key > guard, "the chain check comes first");
});

test("the panel never renders a blank box", () => {
  // status "ok" with no geometry yet drew NOTHING — no chart, no message —
  // which reads exactly like a chart still loading, for ever.
  assert.match(CHART, /status === "ok" && !geo && !tooSmall/);
  assert.match(CHART, /Not enough room here to draw the chart/);
  // …and the measurement no longer depends on ResizeObserver existing.
  assert.match(CHART, /measure\(\);/);
});

test("the address and pool that go into an upstream path are bounded", () => {
  assert.match(ROUTE, /safeAddress\(address\)/);
  assert.match(ROUTE, /safeAddress\(hint\)/);
  assert.match(GTPOOL, /a\.length <= 90 && !\/\[\^A-Za-z0-9:_-\]\/\.test\(a\)/);
});

test("one owner answers 'which pool do we chart?'", () => {
  // Two copies of that lookup drift into two plausible-looking pool addresses
  // with nothing to say which is right.
  assert.match(POOL, /topPoolAddress/);
  assert.match(ROUTE, /topPoolAddress/);
  assert.ok(!/api\.geckoterminal\.com/.test(POOL), "the route no longer holds its own copy");
});

test("the pool we chart is the DEEPEST, not whichever GT listed first", () => {
  // A token seen through a thin pool reads as a different asset.
  assert.match(GTPOOL, /reduce\(\(best, p\) =>/);
  assert.match(GTPOOL, /reserve_in_usd/);
});

// ── the panel ───────────────────────────────────────────────────────────────

test("⚠️ the token page draws no fabricated price history", () => {
  // syntheticTrend() is a curve generated from the ticker's hash. On a 34px
  // sparkline it is decoration; at 640×120 under the words "Price trend" it is
  // a claim about a market nobody measured.
  assert.ok(!/pathFrom\(t\.trend/.test(PAGE), "the hash-generated area chart is gone");
  assert.ok(!/<iframe/.test(PAGE), "and so is the third-party embed");
  assert.match(PAGE, /<CandleChart/);
});

test("the chart is candles, with volume, on a timeframe the reader picks", () => {
  assert.match(CHART, /ck-wick/);
  assert.match(CHART, /ck-body/);
  assert.match(CHART, /ck-vol/);
  assert.match(CHART, /TIMEFRAMES\.map/);
  assert.match(CHART, /role="tab"/);
  // The renderer is ours end to end. An embed must not creep back in through
  // the component now that the unlisted page — which used to guard this — no
  // longer mounts it at all.
  assert.match(CHART, /fetch\(`\/api\/ohlcv\?/);
});

test("⚠️ the embed is a FALLBACK, never the default — the ban moved, it did not lift", () => {
  // "kalo misal apikey gecko terminal limit ganti dexscreener gpp ada
  // watermark" — the operator's call, and the boundary is the whole of it. The
  // original ban was on a third-party iframe on EVERY token page: it sat on
  // "Loading chart settings…" and planted a competitor's wordmark across a
  // Dexvra page. That still may not happen. What it replaces is an APOLOGY over
  // an empty panel, which is strictly worse than a working chart with somebody
  // else's watermark on it.
  const iframes = CHART.match(/<iframe/g) ?? [];
  assert.equal(iframes.length, 1, "exactly one iframe, and it is the fallback");
  // Gated on the ERROR state — not on "none", which is a fact about the TOKEN
  // (nothing has traded yet), where their chart is just as empty while implying
  // the failure was ours.
  //
  // ⚠️ THE PROPERTY, NOT THE SPELLING. This asserted the literal
  // `status === "error" && embedUrl ? (` and therefore went red the day the two
  // decisions were collapsed into one owner — over code that keeps the rule
  // perfectly. Pinning a line rather than a rule is this repo's own recurring
  // defect (the four-way pool-TTL guard, the `{ ok: true,` build stamp), and it
  // costs a reader a failing suite with nothing wrong.
  assert.match(CHART, /status === "error" \? embedUrl : null/, "the embed is reachable only from the error state");
  assert.match(CHART, /const showEmbed = embedSrc !== null;/, "…through one owner the class and the iframe share");
  assert.ok(
    !/status === "none"[^\n]*embedUrl/.test(CHART),
    "a token with no pool must not be handed a third-party empty chart",
  );
  // ⚠️ AND WE ADD NO CAPTION OF OUR OWN UNDER IT.
  //
  // This block went the long way round, so the reasoning is worth keeping. It
  // began as "a chart the reader cannot attribute is worse than no chart", and
  // demanded a note carrying `via DexScreener` AND `feed?.why`. Both halves
  // were then reported from the live page:
  //
  //   • the reason, because it printed "Couldn't read the chart just now"
  //     under a DexScreener chart that had drawn perfectly — a panel
  //     contradicting itself, the false half under the true one;
  //   • the label, because the embed is a third-party iframe that paints
  //     "Tracked by DEXSCREENER" with their logo across its own foot. Our line
  //     said the same thing a second time, one row lower.
  //
  // The attribution RULE is sound and is still enforced where it applies — the
  // `ck-src` chip on the NATIVE DexScreener source, whose candles are drawn in
  // our own colours and are otherwise indistinguishable from GeckoTerminal's.
  // What was wrong was carrying it to a surface that self-attributes.
  assert.ok(
    !/ck-embed-note/.test(CHART),
    "the embed captions itself — a second attribution one row lower is noise",
  );
  assert.ok(!/ck-embed-note/.test(CSS), "…and its style must go with it, not linger as dead CSS");
  // The rule it came from is NOT deleted: the native source still says so.
  const chip = CHART.match(/feed\?\.source === "dexscreener" && \([\s\S]{0,400}?<\/span>/);
  assert.ok(chip, "the native DexScreener source lost its attribution chip");
  assert.match(chip[0], /via DexScreener/);
});

test("the embed URL is built in ONE place, and never for a chain DexScreener lacks", () => {
  // A constructed URL for a chain it has never indexed frames DexScreener's own
  // "not found" inside our panel, which reads as OUR page being broken.
  assert.ok(!/dexscreener\.com\//.test(CHART), "the component builds no third-party URL of its own");
  assert.match(CHART, /dsEmbedUrl\(chain, address\)/);
  const OWNER = readFileSync(join(process.cwd(), "src/lib/dsEmbed.ts"), "utf8");
  assert.match(OWNER, /const slug = CHAINS\[chain\]\?\.dexscreener;/);
  assert.match(OWNER, /if \(!slug \|\| !address\) return null;/);
  assert.match(OWNER, /embed=1/);
});

test("⚠️ the embed surface is PROBED — on a desktop and on a phone", () => {
  // The embed shipped with TWO TOOLBARS STACKED ON A PHONE and was reported
  // from a screenshot, because `chart:preview` — the script whose whole subject
  // is that this panel is judged by LOOKING at it — never rendered the one
  // state a busy GeckoTerminal produces. "The list is the guard": a renderer
  // nobody probes is exactly how a banner shipped boxes for six days.
  const PREVIEW = readFileSync(join(process.cwd(), "scripts/chart-preview.mjs"), "utf8");
  const P = code(PREVIEW);
  assert.match(P, /\.ck--embed iframe/, "the embed state is never rendered");
  assert.match(P, /\.ck-ctl"\)\.count\(\)\) === 0/, "nothing asserts the inert controls are dropped");
  assert.match(P, /phone-embed/, "the embed is not measured on the viewport it was reported on");
  // ⚠️ THE PHONE CONTEXT WAS PINNED TO THE HEALTHY CHART (`stub(m, () => "ok")`),
  // so the one viewport that mattered could only ever be shown the state that
  // was fine. A guard measuring a stack the reader does not use.
  assert.ok(!/stub\(m, \(\) => "ok"\)/.test(P), "the phone can only be shown the healthy chart");
  assert.match(P, /stub\(m, \(\) => mmode\)/);
});

test("⚠️ one stale wait may not un-probe every surface below it", () => {
  // The `.ck-empty` wait for "chart unavailable" stopped matching the moment
  // that state began rendering the embed — and because waitForSelector THROWS,
  // the harness caught it, printed one line, and never ran the fallback chip,
  // the unlisted page or the entire phone context. Thirty checks silenced by
  // one changed panel. Each state section is independent (it reloads the page),
  // so a throw in one is one red line now.
  const PREVIEW = readFileSync(join(process.cwd(), "scripts/chart-preview.mjs"), "utf8");
  const P = code(PREVIEW);
  assert.match(P, /const section = async \(name, fn\) => \{/);
  assert.match(P, /check\(name, false,/, "a section that throws must be a FAIL line, not a silence");
  // Every state section goes through it — the empty panel, the embed, the
  // native fallback, the unlisted page, the phone, and the embed on a phone.
  assert.ok((P.match(/await section\(/g) || []).length >= 6, "a state section is running unguarded");
});

test("a poll that fails never blanks a chart that is already drawn", () => {
  // A quiet poll that comes back empty/failed short-circuits while candles are
  // on screen — it no longer re-renders, it just reports the status upward.
  assert.match(CHART, /if \(quiet && drawn > 0\) return "ok";/);
  assert.match(CHART, /pollMsFor\(tf\)/, "a settled chart never polls faster than the answer can change");
});

test("⚠️ a transient cooldown recovers on screen, without hammering GeckoTerminal", () => {
  // The chart failure the operator saw was "cooling down for 1s" — the tail of
  // a 120s rate-limit window. A request made while the cooldown holds returns
  // WITHOUT reaching GT (providers/gt), so a quick client re-poll is free
  // upstream and lets the chart draw itself the moment the window clears,
  // instead of waiting out the slow 30–90s poll.
  assert.match(CHART, /st === "error" && recovering < RECOVER_MAX/, "only the transient state is fast-retried");
  assert.match(CHART, /RECOVER_MAX = 8/, "and it is bounded — a truly unreachable box falls back to the slow poll");
  // "none" (no pool indexed) is a real answer, never fast-retried.
  assert.ok(!/st === "none"[^;]*RECOVER/.test(CHART));
});

test("every drawn number is measured over the window that is actually drawn", () => {
  // A percentage taken over candles that were never drawn is a figure the
  // reader cannot check against the chart it sits on.
  assert.match(CHART, /const view = geo\?\.view \?\? \[\]/);
  assert.match(CHART, /windowChangePct\(view\)/);
  assert.match(CHART, /geo\.view\.map/);
});

// ── the reader's vertical ───────────────────────────────────────────────────

test("THE BUG: a 30x move on a linear axis has no vertical the reader controls", () => {
  // $BREAKING ran $0.000803 → $0.0281 in two days and the whole history sat
  // flat on the floor of the panel. Every number correct, the picture useless.
  // The answer is both halves: a LOG axis, and a scale the reader can drag.
  assert.match(CHART, /priceScale\(range, mode, adjust/, "the vertical is a computed scale, not a fixed lo/hi");
  assert.match(CHART, /zoomByDrag\(a, dy, geo\.priceH\)/, "drag the gutter to stretch or squash");
  assert.match(CHART, /panByDrag\(a, dy, geo\.priceH\)/, "drag the chart to move it up and down");
  assert.match(CHART, /onDoubleClick=\{resetScale\}/, "and double-click hands it back to the data");
});

test("the scale math is one owner, and the panel does not grow a second copy", () => {
  // A screen that computes its own version of a rule eventually disagrees with
  // the rule. Every way the axis can be wrong — a zero span, a log of a
  // non-positive price, an axis walked into negative dollars — is arithmetic,
  // and it lives where node:test can drive it.
  assert.ok(!/Math\.log10/.test(code(CHART)), "no private log transform in the renderer");
  assert.ok(!/\(1 - \(p - lo\)/.test(code(CHART)), "no second y-mapping");
  assert.match(CHART, /from "@\/lib\/chartScale"/);
});

test("⚠️ the reader can see WHICH axis they are looking at, off the picture", () => {
  // A log chart and a linear one of the same token are different pictures, and
  // so are an auto range and a stretched one. Anybody comparing two
  // screenshots is owed the difference — the same reason the DexScreener
  // fallback names itself rather than drawing an identical chart in silence.
  assert.match(CHART, /\["lin", "log"\] as const/, "both modes are on screen, not one toggle");
  assert.match(CHART, /aria-pressed=\{m === mode\}/);
  assert.match(
    CHART,
    /\(isAdjusted\(adjust\) \|\| isTimeAdjusted\(timeView\)\) && \(/,
    "⤢ Auto appears the moment EITHER axis is no longer the data's own",
  );
});

test("⚠️ a stretched chart cannot draw over the volume band or the axis", () => {
  // Zoom in far enough and unclipped wicks run through the histogram, the time
  // stamps and the header. That is not a chart with a bug in it.
  assert.match(CHART, /<clipPath id=\{`ckp\$\{clipId\}`\}>/);
  assert.match(CHART, /clipPath=\{`url\(#ckp\$\{clipId\}\)`\}/);
  // …and the last-price TAG is pinned instead of clipped: it is the number the
  // reader came for, and a scale they dragged must not take it off screen.
  assert.match(CHART, /const lastTagY =/);
  assert.match(CHART, /Math\.min\(PAD_T \+ geo\.priceH - 10, Math\.max\(PAD_T \+ 10, geo\.yOf\(last\.c\)\)\)/);
});

test("⚠️ a phone can still scroll the page past the chart", () => {
  // A vertical touch drag across the plot is how a phone scrolls. Stealing it
  // would trap the reader on the chart — so only a MOUSE pans the body, and
  // touch-action:none is taken on the narrow gutter alone.
  // The rule moved when the body drag gained a horizontal axis: a phone GETS
  // the sideways pan (the page scrolls vertically, so there is no conflict) and
  // never the vertical one.
  assert.match(CHART, /if \(dy && e\.pointerType === "mouse"\) setAdjust/);
  assert.match(CHART, /if \(dx\) setTimeView/, "…and the horizontal is for every pointer");
  const ck = CSS.slice(CSS.indexOf("CANDLESTICK CHART"), CSS.indexOf("GENERAL TIDY-UPS"));
  assert.match(ck, /\.ck-yaxis\{[^}]*touch-action:none/);
  assert.match(ck, /\.ck-plot\{[^}]*touch-action:pan-y/, "the plot body leaves the page scroller alone");
});

test("⚠️ the gutter is INSIDE the plot, and pointer events bubble", () => {
  // Without this, every pointer event over the price axis ran BOTH handlers
  // and the two fought over one drag. Measured on a build with the three calls
  // removed: a 60px pan moved the chart 210px. It still "worked" — the chart
  // did stretch and did move — which is why only a measurement caught it, and
  // why `chart:preview` asserts the movement MATCHES the drag.
  const drag = CHART.slice(CHART.indexOf("const startDrag"), CHART.indexOf("// ── the price gutter"));
  assert.equal((drag.match(/e\.stopPropagation\(\)/g) ?? []).length, 3, "start, move and end each stop there");
});

test("a manual stretch belongs to the window it was aimed at", () => {
  // A zoom set on two days of 15m candles means nothing over six months of
  // daily ones — inheriting it opens the new tab on an axis with no candles in
  // it. The MODE is a preference and does survive.
  assert.match(CHART, /setAdjust\(AUTO\);\s*\n\s*setTimeView\(AUTO_TIME\);\s*\n\s*\}, \[chain, address, tf\]\)/);
});

test("the chart travels through time, and the reader can aim it", () => {
  // "bisa di geser ke kanan ke kiri chartnya" — a chart you cannot move through
  // time is a picture. Drag sideways to travel, wheel to zoom, and the candle
  // under the cursor stays under the cursor.
  assert.match(CHART, /panTimeByDrag\(t, dx, geo\.step, candles\.length, geo\.fit\)/);
  assert.match(CHART, /zoomTimeAt\(t, factor, frac, candlesRef\.current, g\.fit\)/);
  assert.match(CHART, /timeWindow\(candles\.length, fit, timeView\)/, "the window is computed, not `slice(-fit)`");
  assert.ok(!/candles\.slice\(-Math\.max/.test(code(CHART)), "the fixed most-recent window is gone");
});

test("⚠️ the wheel listener is NATIVE and non-passive, or it cannot work at all", () => {
  // React attaches `onWheel` passively, and a passive listener cannot
  // preventDefault — the handler would zoom the chart and let the page scroll
  // away underneath it at the same time.
  assert.ok(!/onWheel=/.test(code(CHART)), "no React onWheel — it would be passive");
  assert.match(CHART, /addEventListener\("wheel", onWheel, \{ passive: false \}\)/);
  assert.match(CHART, /removeEventListener\("wheel", onWheel\)/, "and it is removed");
  // Bound once, so it must read the live geometry rather than one render's.
  assert.match(CHART, /geoRef\.current = geo;/);
});

test("⚠️ the live dot does not claim 'live' over candles from two days ago", () => {
  // Scrolled back into history the chart is still refreshing, but what the
  // reader is looking at is not the present — the pulsing dot would be the
  // reassuring reading of a state that is not.
  assert.match(CHART, /geo\.win\.atLiveEdge && \(\s*\n\s*<span className="ck-live"/);
  assert.match(CHART, /!geo\.win\.atLiveEdge/, "…and it says so instead");
});

test("⚠️ the time-axis anchor is the renderer's, and CSS does not override it", () => {
  // A CSS declaration beats an SVG presentation attribute, so `text-anchor` in
  // the stylesheet silently overrode the per-label anchor that keeps the end
  // stamps inside the plot — and the left-most label shipped as "3:46" for
  // 23:46, a WRONG time rather than a clipped one.
  assert.match(CHART, /textAnchor=\{anchor\}/);
  const ck = CSS.slice(CSS.indexOf("CANDLESTICK CHART"), CSS.indexOf("GENERAL TIDY-UPS"));
  assert.ok(!/\.ck-axis-x\{[^}]*text-anchor/.test(ck), "no text-anchor in the chart's stylesheet");
});
