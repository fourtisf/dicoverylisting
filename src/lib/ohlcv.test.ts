import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TF,
  TF,
  chartPrefOf,
  chartSourceBanner,
  TIMEFRAMES,
  normalizeCandles,
  pollMsFor,
  priceRange,
  tfOf,
  windowChangePct,
  type Timeframe,
} from "./ohlcv.ts";

// A GeckoTerminal row: [timestamp, open, high, low, close, volume].
const row = (t: number, o: number, h: number, l: number, c: number, v = 100) => [t, o, h, l, c, v];
const T0 = 1_700_000_000; // fixed, so nothing here depends on the clock
const NOW = (T0 + 3600) * 1000;

test("candles come back oldest-first however GeckoTerminal ordered them", () => {
  // GT documents newest-first. Trusting that rather than sorting is the
  // difference between a chart and its mirror image.
  const out = normalizeCandles(
    [row(T0 + 600, 3, 3, 3, 3), row(T0 + 300, 2, 2, 2, 2), row(T0, 1, 1, 1, 1)],
    { now: NOW },
  );
  assert.deepEqual(out.map((c) => c.t), [T0, T0 + 300, T0 + 600]);
});

test("a zero or negative price is not a price", () => {
  // One zeroed close drags the y-axis to the floor and flattens every real
  // candle beside it into a line.
  const out = normalizeCandles(
    [row(T0, 1, 1.2, 0.9, 1.1), row(T0 + 300, 0, 0, 0, 0), row(T0 + 600, 1.1, 1.3, -1, 1.2)],
    { now: NOW },
  );
  assert.deepEqual(out.map((c) => c.t), [T0]);
});

test("zero volume survives — a quiet candle is a fact, not a broken row", () => {
  const out = normalizeCandles([row(T0, 1, 1, 1, 1, 0)], { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].v, 0);
});

test("a missing or negative volume reads as 0 and keeps the candle", () => {
  const out = normalizeCandles([[T0, 1, 1.1, 0.9, 1], row(T0 + 300, 1, 1, 1, 1, -5)], { now: NOW });
  assert.deepEqual(out.map((c) => c.v), [0, 0]);
  assert.equal(out.length, 2, "prices were fine; only the volume was not");
});

test("wicks widen to contain the body, never the other way round", () => {
  // A feed reporting high BELOW close (rounding at the top of a minute, a
  // partially filled current candle) would draw a body outside its own range.
  const [c] = normalizeCandles([row(T0, 1, 1.05, 0.99, 1.2)], { now: NOW });
  assert.equal(c.h, 1.2, "high widened to the close");
  assert.equal(c.c, 1.2, "and the reported close is untouched");
  const [d] = normalizeCandles([row(T0, 1, 1.3, 1.05, 0.8)], { now: NOW });
  assert.equal(d.l, 0.8);
});

test("a timestamp from the future is refused", () => {
  // A seconds/milliseconds mix-up plots one candle a lifetime away and
  // squashes the whole window into the left edge.
  const out = normalizeCandles([row(T0, 1, 1, 1, 1), row(T0 * 1000, 2, 2, 2, 2)], { now: NOW });
  assert.deepEqual(out.map((c) => c.t), [T0]);
});

test("the candle for the minute we are in is not 'the future'", () => {
  const nowSec = Math.floor(NOW / 1000);
  const out = normalizeCandles([row(nowSec + 30, 1, 1, 1, 1)], { now: NOW });
  assert.equal(out.length, 1);
});

test("a repeated timestamp collapses to one, deterministically", () => {
  // Two bodies stacked at one x is a rendering artefact. Which row is "newer"
  // is not knowable from the payload, so the rule is last-one-wins and is
  // pinned here rather than described as something it cannot know.
  const out = normalizeCandles([row(T0, 1, 1, 1, 1), row(T0, 1, 2, 1, 1.8)], { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].c, 1.8);
});

test("junk in, empty out — never a throw", () => {
  assert.deepEqual(normalizeCandles(null), []);
  assert.deepEqual(normalizeCandles(undefined), []);
  assert.deepEqual(normalizeCandles({ ohlcv_list: [] } as unknown), []);
  assert.deepEqual(normalizeCandles([[T0, 1, 2]], { now: NOW }), [], "a short row is not a candle");
  assert.deepEqual(normalizeCandles(["nope"], { now: NOW }), []);
});

test("the window change is first open → last close, and null when unmeasurable", () => {
  const cs = normalizeCandles([row(T0, 1, 1, 1, 1), row(T0 + 300, 1, 2, 1, 2)], { now: NOW });
  assert.equal(windowChangePct(cs), 100);
  // One candle has no change. Printing 0.0% for it would be the fabricated
  // flat this repo refuses everywhere else.
  assert.equal(windowChangePct(cs.slice(0, 1)), null);
  assert.equal(windowChangePct([]), null);
});

test("priceRange is null on nothing, and gives a flat window some height", () => {
  assert.equal(priceRange([]), null);
  const flat = normalizeCandles([row(T0, 5, 5, 5, 5), row(T0 + 300, 5, 5, 5, 5)], { now: NOW });
  const r = priceRange(flat);
  assert.ok(r && r.hi > r.lo, "a zero-height window is a division by zero in the y-axis");
  const real = priceRange(normalizeCandles([row(T0, 1, 3, 0.5, 2)], { now: NOW }));
  assert.deepEqual(real, { lo: 0.5, hi: 3 });
});

test("an unrecognised timeframe becomes the default, never an upstream path", () => {
  // This value lands in GeckoTerminal's URL path.
  assert.equal(tfOf("../../etc"), DEFAULT_TF);
  assert.equal(tfOf(null), DEFAULT_TF);
  assert.equal(tfOf(""), DEFAULT_TF);
  assert.equal(tfOf("1H"), "1h", "case is a typo, not a different timeframe");
  for (const k of TIMEFRAMES) assert.equal(tfOf(k), k);
});

test("every timeframe is a combination GeckoTerminal actually serves", () => {
  // GT serves minute 1/5/15, hour 1/4/12, day 1 and 400s anything else — so a
  // typo here is a chart that never loads for one tab only.
  const allowed: Record<string, number[]> = { minute: [1, 5, 15], hour: [1, 4, 12], day: [1] };
  const base: Record<string, number> = { minute: 60, hour: 3600, day: 86_400 };
  for (const k of TIMEFRAMES) {
    const spec = TF[k];
    assert.ok(allowed[spec.path].includes(spec.aggregate), `${k}: ${spec.path}/${spec.aggregate} is not served`);
    assert.equal(spec.seconds, base[spec.path] * spec.aggregate, `${k}: candle width disagrees with the request`);
    assert.ok(spec.limit > 0 && spec.limit <= 1000, `${k}: GT caps a request at 1000 candles`);
    assert.ok(spec.ttlMs > 0);
  }
  assert.ok(TIMEFRAMES.includes(DEFAULT_TF));
  assert.equal(Object.keys(TF).length, TIMEFRAMES.length, "a timeframe with no tab, or a tab with no spec");
});

test("the client never polls faster than the answer can change", () => {
  // A poll inside the route's cache TTL only ever returns the same bytes.
  for (const k of TIMEFRAMES) assert.ok(pollMsFor(k as Timeframe) >= TF[k as Timeframe].ttlMs);
});

// ── which source goes first ─────────────────────────────────────────────────

test("CHART_SOURCE resolves the order, and blank is the shipped default", () => {
  // `Number('')`-shaped defaults have cost this repo four separate outages, so
  // an unset var resolves to what shipped and nothing else.
  assert.equal(chartPrefOf(undefined), "auto");
  assert.equal(chartPrefOf(""), "auto");
  assert.equal(chartPrefOf("  "), "auto");
  assert.equal(chartPrefOf("banana"), "auto", "an unreadable value is never a guess");
  assert.equal(chartPrefOf("dexscreener"), "dexscreener");
  assert.equal(chartPrefOf(" DexScreener "), "dexscreener");
  assert.equal(chartPrefOf("ds"), "dexscreener");
  assert.equal(chartPrefOf("gt"), "geckoterminal");
});

test("the boot line says which order is in effect, and what a failure would mean", () => {
  // Same reason as the `[gt]` tier line: a setting that never arrived and a
  // setting that did not help are indistinguishable from a browser.
  assert.match(chartSourceBanner("auto"), /GeckoTerminal first/);
  assert.match(chartSourceBanner("dexscreener"), /DexScreener FIRST/);
  assert.match(chartSourceBanner("dexscreener"), /\.env fix/, "a guessed shape failing is a config fix, not a deploy");
  assert.match(chartSourceBanner("geckoterminal"), /ONLY/);
  assert.match(chartSourceBanner("geckoterminal"), /blanks every chart/, "…and it names what that costs");
});
