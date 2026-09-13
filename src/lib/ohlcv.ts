// OHLCV — the price history behind the token page's candlestick chart.
//
// WHY THIS FILE EXISTS, AND WHAT IT REPLACES
// The token page drew `syntheticTrend(symbol, chg24h)` — a curve generated from
// the ticker's hash — as a full-width area chart with a price axis' worth of
// authority behind it. It is decoration on a 34px sparkline; at 640×120 under
// the words "Price trend" it is a claim about a market, and nobody measured it.
// This module is the real reading, so the page can stop drawing the fabricated
// one. The bot repo has paid for this exact distinction twice already: an
// unreadable 24h change is a blank, never a printed `0.00%`.
//
// PURE ON PURPOSE — no fetch, no cache, no Next imports. Everything that can be
// wrong about a candle list (order, broken rows, a wick shorter than its own
// body, a timestamp from the future) is decided here, where node:test can drive
// it with a literal array. Relative imports with extensions for the same reason:
// the test runner resolves this file, and "@/" is a Next-only alias.

/** One candle. `t` is a UNIX timestamp in SECONDS — GeckoTerminal's unit, kept
 *  rather than converted so a value never has to be guessed at a call site. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type Timeframe = "5m" | "15m" | "1h" | "4h" | "1d";

export interface TfSpec {
  /** GeckoTerminal's own path segment. */
  path: "minute" | "hour" | "day";
  /** …and its `aggregate` for that segment. GT only serves the combinations
   *  below: minute 1/5/15, hour 1/4/12, day 1. A pair it does not serve comes
   *  back 400, which is why this is a table and not arithmetic. */
  aggregate: number;
  /** One candle's width in seconds — the x-axis needs it to place a gap. */
  seconds: number;
  /** How many candles to ask for. GT caps a request at 1000. */
  limit: number;
  /** How long a fetched answer stays fresh. A 5m chart moves; a daily one does
   *  not, and the whole app shares one ~30-req/min GeckoTerminal budget with
   *  the listing pipeline and the bot suite on the same IP. */
  ttlMs: number;
}

/** Display order of the timeframe tabs. */
export const TIMEFRAMES: Timeframe[] = ["5m", "15m", "1h", "4h", "1d"];

/**
 * ⚠️ `limit` IS A QUERY PARAM, NOT A REQUEST COUNT. Raising it costs payload
 * and nothing else — one request per timeframe either way, and the shared
 * ~30/min GeckoTerminal ceiling is untouched. It was 180–200 across the board,
 * which is barely more than one screen fits: the chart had nothing to scroll
 * back INTO once the reader could travel through time. GT caps a request at
 * 1000; these stay well under it and each one is a round span a person can name
 * (a day of 5m, four days of 15m, a fortnight of 1h, two months of 4h, a year
 * of daily).
 */
export const TF: Record<Timeframe, TfSpec> = {
  "5m": { path: "minute", aggregate: 5, seconds: 300, limit: 288, ttlMs: 60_000 },
  "15m": { path: "minute", aggregate: 15, seconds: 900, limit: 384, ttlMs: 90_000 },
  "1h": { path: "hour", aggregate: 1, seconds: 3600, limit: 336, ttlMs: 5 * 60_000 },
  "4h": { path: "hour", aggregate: 4, seconds: 14_400, limit: 360, ttlMs: 10 * 60_000 },
  "1d": { path: "day", aggregate: 1, seconds: 86_400, limit: 365, ttlMs: 15 * 60_000 },
};

/** The default tab. 15m over a couple of days is the window a memecoin is
 *  actually looked at in, and it is one GT request either way. */
export const DEFAULT_TF: Timeframe = "15m";

/** A timeframe from user input. Never throws and never trusts: this value goes
 *  into an upstream URL path, so anything unrecognised becomes the default
 *  rather than being passed along. */
export function tfOf(raw: unknown): Timeframe {
  const s = String(raw ?? "").trim().toLowerCase();
  return (TIMEFRAMES as string[]).includes(s) ? (s as Timeframe) : DEFAULT_TF;
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A clock skew we tolerate on an upstream timestamp before calling it future.
 *  A candle for the minute we are in is normal; one dated next week is a
 *  seconds/milliseconds mix-up, and plotting it stretches the whole x-axis flat
 *  (`normalize.toMs` in shared/launchpads refuses the same thing). */
const FUTURE_SKEW_SEC = 6 * 60 * 60;

/**
 * GeckoTerminal's `ohlcv_list` → candles this app can draw.
 *
 * GT sends `[[timestamp, open, high, low, close, volume], …]`, documented as
 * newest-first. Every rule below is a way that list can be wrong:
 *
 *  • SORTED BY TIMESTAMP, never trusted by position. The bot's
 *    `changeFromCandles` states the same rule for the same reason — with two
 *    closes, believing the order is the difference between a percentage and
 *    its inverse; with two hundred, it is the difference between a chart and
 *    its mirror image.
 *  • A ZERO OR NEGATIVE price is not a price. One zeroed close drags the whole
 *    y-axis to the floor and flattens every real candle beside it into a line.
 *  • VOLUME IS ALLOWED TO BE ZERO — a quiet 5 minutes is a fact, not a broken
 *    row — but never negative, and a missing one reads as 0 rather than
 *    dropping an otherwise good candle.
 *  • THE WICKS ARE WIDENED TO CONTAIN THE BODY, not the other way round. A
 *    feed that reports `high` below `close` (rounding at the top of a minute,
 *    a partially-filled current candle) would otherwise draw a body sticking
 *    out of the range it is supposed to sit inside. Widening keeps every
 *    reported number visible; clamping the body would hide one.
 *  • DUPLICATE TIMESTAMPS collapse to ONE — the last occurrence in the
 *    response wins. Which of two rows for the same stamp is "newer" is not
 *    knowable from the payload, so this is a DETERMINISTIC choice rather than
 *    a claim: what matters is that two bodies never stack at one x.
 */
export function normalizeCandles(raw: unknown, opts: { now?: number } = {}): Candle[] {
  if (!Array.isArray(raw)) return [];
  const maxT = Math.floor((opts.now ?? Date.now()) / 1000) + FUTURE_SKEW_SEC;
  const byTime = new Map<number, Candle>();

  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const t = num(row[0]);
    const o = num(row[1]);
    const h = num(row[2]);
    const l = num(row[3]);
    const c = num(row[4]);
    const v = num(row[5]);
    if (t == null || t <= 0 || t > maxT) continue;
    if (o == null || h == null || l == null || c == null) continue;
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
    byTime.set(Math.floor(t), {
      t: Math.floor(t),
      o,
      c,
      h: Math.max(h, o, c),
      l: Math.min(l, o, c),
      v: v != null && v > 0 ? v : 0,
    });
  }

  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/** The change across the drawn window, as a percentage — first open to last
 *  close. `null` when there is nothing to measure it from, because a chart
 *  with one candle has no change and printing `0.0%` for it would be the
 *  fabricated flat this file exists to refuse. */
export function windowChangePct(candles: Candle[]): number | null {
  if (candles.length < 2) return null;
  const first = candles[0].o;
  const last = candles[candles.length - 1].c;
  if (!(first > 0) || !(last > 0)) return null;
  return (last / first - 1) * 100;
}

/** Highest high / lowest low of a window — the y-axis bounds. `null` on an
 *  empty list rather than ±Infinity, which is what `Math.max(...[])` gives and
 *  what silently renders an empty grid as a valid chart. */
export function priceRange(candles: Candle[]): { lo: number; hi: number } | null {
  if (candles.length === 0) return null;
  let lo = candles[0].l;
  let hi = candles[0].h;
  for (const c of candles) {
    if (c.l < lo) lo = c.l;
    if (c.h > hi) hi = c.h;
  }
  if (!(hi > 0) || !(lo > 0)) return null;
  // A window in which nothing moved has zero height; give it one so the candles
  // land on the middle of the panel instead of on a division by zero.
  if (hi === lo) return { lo: lo * 0.995, hi: hi * 1.005 };
  return { lo, hi };
}

/** What one OHLCV request costs to serve, in wall-clock freshness. Exported so
 *  the route and the client cannot disagree about the poll interval — a client
 *  polling faster than the cache TTL only ever gets the same bytes back. */
export const pollMsFor = (tf: Timeframe): number => Math.max(30_000, TF[tf].ttlMs);

/**
 * WHICH SOURCE GOES FIRST — an operator's standing preference.
 *
 * "saya ingin pakai api dexscreener aja untuk chart". Fair, and it is their
 * call to make: GeckoTerminal's ~30 req/min is counted PER IP and shared with
 * four bot processes on the same box, so a chart that reaches for DexScreener
 * first leaves that whole allowance for everything else — the board's prices,
 * the pool lookups, the trades feed.
 *
 * ⚠️ IT IS AN ORDER, NEVER A DELETION, and that is not me overruling the ask.
 * DexScreener publishes no documented OHLCV endpoint: the request shape in
 * dsChart.ts is a GUESS about somebody else's private API (see its header).
 * Making a guess primary is a legitimate trade — it costs nothing while it
 * works — but making it the ONLY source means the day DexScreener renames a
 * path, every chart on the site goes dark with no way back. With GT behind it,
 * that day costs a slower chart and nothing else. `CHART_SOURCE=geckoterminal`
 * is the one value that does drop a source, and it drops the guess.
 *
 *   CHART_SOURCE=auto           GeckoTerminal first, DexScreener when it cannot
 *                               answer. The default, and what shipped.
 *   CHART_SOURCE=dexscreener    DexScreener first, GeckoTerminal behind it.
 *   CHART_SOURCE=geckoterminal  GeckoTerminal only.
 *
 * Blank means `auto` — `Number('')`-shaped defaults have cost this repo four
 * separate outages, so an unset var resolves to the shipped behaviour and
 * nothing else.
 */
export type ChartPref = "auto" | "dexscreener" | "geckoterminal";
export function chartPrefOf(raw: string | undefined): ChartPref {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "dexscreener" || s === "ds") return "dexscreener";
  if (s === "geckoterminal" || s === "gt") return "geckoterminal";
  return "auto";
}

/**
 * The chart's source order, in one line, for the boot log.
 *
 * ⚠️ Printed for the reason the `[gt]` line is: "the chart is empty" looks
 * identical from outside whether the order is what the operator set or what
 * shipped. A setting that never arrived and a setting that did not help are
 * indistinguishable from a browser, and this repo has lost evenings to exactly
 * that — an `.env` written to the wrong file, a `--update-env` that was never
 * passed. One line settles it.
 */
export function chartSourceBanner(pref: ChartPref = chartPrefOf(process.env.CHART_SOURCE)): string {
  if (pref === "dexscreener")
    return "[chart] source order: DexScreener FIRST, GeckoTerminal behind it (CHART_SOURCE=dexscreener) — DexScreener's OHLCV shape is undocumented, so a failure there is a .env fix (DS_CHART_API / DS_CHART_PATH / DS_CHART_HEADERS), never a dead chart";
  if (pref === "geckoterminal")
    return "[chart] source order: GeckoTerminal ONLY (CHART_SOURCE=geckoterminal) — the DexScreener fallback is switched off, so a GT rate limit blanks every chart until it lifts";
  return "[chart] source order: GeckoTerminal first, DexScreener when it cannot answer (default) — set CHART_SOURCE=dexscreener to swap them";
}
