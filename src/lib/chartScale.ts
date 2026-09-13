// THE CHART'S VERTICAL — where the price axis sits, and who decides.
//
// WHY IT IS A MODULE AND NOT SIX LINES INSIDE `geo`
// The token page charted $BREAKING going from $0.000803 to $0.0281 in two days,
// and the whole of that history sat flat on the floor of the panel with one
// spike at the right-hand edge. Every number on it was correct and the picture
// was useless: on a LINEAR axis a 30× move spends 96% of the height on the last
// 4% of the story. The reader asked for the one thing that fixes it — "chartnya
// bisa di set kaya di atas ke bawah" — a vertical they control.
//
// Two answers, and this file is both, because they are one transform:
//
//   · LOG — the axis every exchange offers for exactly this shape. A doubling
//     is the same distance wherever it happens, so the early history is as
//     readable as the spike.
//   · A MANUAL ADJUST — drag the price gutter to stretch or squash, drag the
//     chart to move it up and down, double-click to hand it back to the auto
//     range. TradingView's grammar, because it is the one people already know.
//
// PURE, and driven by a test rather than read off the source: a scale is
// arithmetic, the ways it can be wrong are arithmetic (a zero span, a log of a
// non-positive price, a zoom that walks the axis into negative dollars), and
// none of them is visible in a screenshot until it is on a customer's screen.
// Relative imports with extensions — the node:test runner resolves this file.

/** Linear price, or log10 of it. `lin` stays the default: it is what a price
 *  chart means unless the reader says otherwise, and a log axis that nobody
 *  asked for is a chart whose percentages do not match its heights. */
export type ScaleMode = "lin" | "log";

/**
 * What the reader has done to the automatic range.
 *
 * `zoom`  — 1 is the auto range; >1 stretches (fewer dollars across the panel),
 *           <1 squashes. Applied about the CENTRE of the current view, so
 *           stretching does not also slide the chart sideways up the axis.
 * `shift` — how far the view is moved, in multiples of the AUTO span. Positive
 *           moves the window up the axis, which moves the candles DOWN the
 *           panel — content follows the finger, which is the only direction a
 *           drag can mean.
 *
 * Kept as two dimensionless numbers rather than a `{lo, hi}` pair on purpose:
 * a stored pair would go on describing a price range the market has since left,
 * so a chart left alone for an hour would drift off its own candles. This
 * describes a RELATIONSHIP to whatever the auto range is right now, which
 * survives new candles arriving underneath it.
 */
export interface ScaleAdjust {
  zoom: number;
  shift: number;
}

export const AUTO: ScaleAdjust = { zoom: 1, shift: 0 };

/** Is the reader looking at something other than the automatic range? The panel
 *  SAYS so when they are — a chart whose axis somebody has moved and a chart
 *  that fits its own data are the same picture, and telling them apart matters
 *  to anyone comparing two screenshots. */
export const isAdjusted = (a: ScaleAdjust): boolean => a.zoom !== 1 || a.shift !== 0;

/** How far the reader may stretch or squash. Wide enough to open up a flat
 *  hour and to pull a 1000× back into one screen; bounded because past this the
 *  axis is one price repeated five times or a plot with no candle on it. */
const ZOOM_MIN = 0.02;
const ZOOM_MAX = 60;
/** …and how far the window may be pushed off the data, in auto spans. Past
 *  this there is nothing to see and no way to tell which way to drag back. */
const SHIFT_MAX = 8;

/** Headroom above and below the data so a wick never touches the frame and the
 *  last-price tag has somewhere to sit. */
const PAD_FRAC = 0.06;

/** A price floor for the log transform. `normalizeCandles` already refuses a
 *  price ≤ 0, so this is a belt on a brace — but `Math.log10(0)` is -Infinity
 *  and one of those turns the whole axis into NaN, which renders as an empty
 *  panel that reads exactly like a chart still loading. */
const MIN_PRICE = 1e-18;

export function clampAdjust(a: ScaleAdjust | null | undefined): ScaleAdjust {
  if (!a) return AUTO;
  const zoom = Number.isFinite(a.zoom) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, a.zoom)) : 1;
  const shift = Number.isFinite(a.shift) ? Math.min(SHIFT_MAX, Math.max(-SHIFT_MAX, a.shift)) : 0;
  return { zoom, shift };
}

export interface Plot {
  /** y of the top of the price area, in svg units. */
  top: number;
  /** its height. */
  height: number;
}

export interface PriceScale {
  /** The price at the top and bottom of the drawn axis — what the grid labels
   *  and the readout are built from. */
  lo: number;
  hi: number;
  mode: ScaleMode;
  /** price → y. */
  yOf: (price: number) => number;
  /** The price `f` of the way UP the axis (0 = bottom, 1 = top) — the grid's
   *  ticks, which must be evenly spaced in the axis's own space, not in
   *  dollars, or a log chart's lines bunch at one end. */
  priceAt: (f: number) => number;
}

/**
 * Build the vertical for one drawn window.
 *
 * `range` is the data's own high/low (`priceRange`); everything else is the
 * reader's. Never throws and never returns NaN: a flat window, a single
 * candle, an absurd zoom and a shift that walks off the data all resolve to
 * something drawable, because the alternative is a blank panel that reads as
 * "still loading" — the state this repo has paid for twice.
 */
export function priceScale(
  range: { lo: number; hi: number },
  mode: ScaleMode,
  adjust: ScaleAdjust,
  plot: Plot,
): PriceScale {
  const a = clampAdjust(adjust);
  const log = mode === "log";
  const toD = (p: number) => (log ? Math.log10(Math.max(p, MIN_PRICE)) : p);
  const fromD = (d: number) => (log ? 10 ** d : d);

  const rLo = Math.min(range.lo, range.hi);
  const rHi = Math.max(range.lo, range.hi);
  let d0 = toD(rLo);
  let d1 = toD(rHi);
  // A window in which nothing moved has zero height and would divide by zero.
  // `priceRange` already widens an exactly-flat window, but a rounding-flat one
  // in log space can still land here.
  if (!(d1 - d0 > 0)) {
    const e = Math.abs(d1) * 0.01 || 1;
    d0 -= e;
    d1 += e;
  }
  // Headroom, top and bottom, so a wick never touches the frame and the
  // last-price tag has somewhere to sit.
  const pad = (d1 - d0) * PAD_FRAC;
  let lo0 = d0 - pad;
  const hi0 = d1 + pad;
  // ⚠️ AND THE FLOOR THE PADDING NEEDS ON A LINEAR AXIS, which the first cut of
  // this module dropped when it replaced the six lines it grew out of. On a
  // token that has done 35x, 6% of the RANGE is far bigger than the whole
  // bottom of it, so `lo - pad` goes negative and the axis bottoms out at $0 —
  // handing a third of the panel to prices that never existed and squashing
  // the early history that much further onto the floor. On the very chart this
  // module was written for. The old rule is "never more than one halving below
  // the lowest price", and it is a LINEAR rule: log padding is symmetric in
  // ratio and behaves by itself.
  if (!log) lo0 = Math.max(lo0, rLo * 0.5);
  const padded = hi0 - lo0;
  const mid0 = (lo0 + hi0) / 2;

  // Shift is measured in AUTO spans, so the same drag moves the same distance
  // on screen whatever the zoom — and re-rolling the zoom does not also move
  // the window.
  const mid = mid0 + a.shift * padded;
  const half = padded / (2 * a.zoom);
  let lo = mid - half;
  let hi = mid + half;

  // ⚠️ A LINEAR PRICE AXIS MAY NOT GO BELOW ZERO. Squash far enough and the
  // padded range walks past the origin, and the gutter starts printing negative
  // dollars — a number that cannot exist, on the panel somebody is reading to
  // decide whether to buy. Log space has no such floor (10^-9 is a price), so
  // this only binds where it means something.
  if (!log && lo < 0) lo = 0;
  if (!(hi > lo)) hi = lo + (Math.abs(lo) * 0.01 || 1); // last resort, still drawable

  const yOf = (p: number) => plot.top + (1 - (toD(p) - lo) / (hi - lo)) * plot.height;
  const priceAt = (f: number) => fromD(lo + (hi - lo) * f);
  return { lo: fromD(lo), hi: fromD(hi), mode, yOf, priceAt };
}

/**
 * A vertical drag on the price gutter → a new zoom.
 *
 * Dragging UP stretches, which is the direction every charting tool uses and
 * the one the gesture reads as: you are pulling the axis apart. `dy` is screen
 * pixels, positive downwards (the DOM's sign), so the exponent is negated.
 *
 * Exponential rather than linear, because a scale is multiplicative: a fixed
 * step would crawl at the stretched end and jump at the squashed one.
 * `RATE` is tuned so a drag of the full plot height is a little over 5×.
 */
const RATE = 1.7;
export function zoomByDrag(a: ScaleAdjust, dyPx: number, plotHeight: number): ScaleAdjust {
  if (!(plotHeight > 0) || !Number.isFinite(dyPx)) return clampAdjust(a);
  const base = clampAdjust(a);
  return clampAdjust({ ...base, zoom: base.zoom * Math.exp((-dyPx / plotHeight) * RATE) });
}

/**
 * A vertical drag on the chart itself → a new shift.
 *
 * THE CONTENT FOLLOWS THE FINGER. Drag down and the candles go down, which
 * means the window has moved UP the price axis — the inversion is the whole of
 * this function, and getting it backwards is a chart that fights the hand on it.
 *
 * Divided by the zoom because `shift` is measured in AUTO spans while the drag
 * is measured against the VISIBLE one: without it, panning a chart the reader
 * has stretched 10× flings it off the screen in a few pixels.
 */
export function panByDrag(a: ScaleAdjust, dyPx: number, plotHeight: number): ScaleAdjust {
  if (!(plotHeight > 0) || !Number.isFinite(dyPx)) return clampAdjust(a);
  const base = clampAdjust(a);
  return clampAdjust({ ...base, shift: base.shift + dyPx / plotHeight / base.zoom });
}

// ── the horizontal, which belongs to the reader too ──────────────────────────
//
// "bisa di geser ke kanan ke kiri chartnya" — the vertical control landed and
// the very next thing asked for was the other axis, because a chart you cannot
// move through time is a picture, not a chart. TradingView and DexScreener both
// do this and it is the grammar people arrive with: drag sideways to travel,
// wheel to zoom, and the candle under the cursor stays under the cursor.
//
// The state is `{count, endOffset}` and NOT `{startIndex, endIndex}`, for the
// same reason the price scale stores `{zoom, shift}` rather than `{lo, hi}`:
// new candles arrive at the RIGHT every poll, so a pair of absolute indices
// would drift one candle further into the past on every refresh while the
// reader watched. `endOffset` is measured from the newest candle, so a reader
// parked at the live edge stays at the live edge and a reader who has scrolled
// back stays exactly where they scrolled to.

export interface TimeView {
  /** How many candles are visible. `null` = as many as fit the panel. */
  count: number | null;
  /** How many candles are hidden to the RIGHT of the view. 0 = the live edge. */
  endOffset: number;
}

export const AUTO_TIME: TimeView = { count: null, endOffset: 0 };

export const isTimeAdjusted = (t: TimeView): boolean => t.count != null || t.endOffset !== 0;

/** Fewest candles the reader may zoom into. Below this the chart is a handful
 *  of bars with no shape to read, and the axis labels collide. */
const MIN_VISIBLE = 12;

export interface Window {
  /** First visible index into the candle array. */
  start: number;
  /** How many are visible. */
  count: number;
  /** Normalised — clamped to what the data can actually show. */
  view: TimeView;
  /** Is the right edge the newest candle? The live dot means something else
   *  when the reader has scrolled back into history. */
  atLiveEdge: boolean;
}

/**
 * Which slice of the candle array is on screen.
 *
 * `fit` is how many the panel has room for at a readable width — the auto
 * answer, and also the ceiling on zooming out, because past it the bodies merge
 * into a smear (the reason `MIN_STEP` exists).
 *
 * Everything is CLAMPED to the data: a reader cannot scroll past the newest
 * candle or before the oldest one, so the panel can never come up empty from a
 * gesture. That is the horizontal version of the price axis refusing to walk
 * below zero.
 */
export function timeWindow(total: number, fit: number, tv: TimeView): Window {
  const room = Math.max(MIN_VISIBLE, Math.floor(fit) || MIN_VISIBLE);
  if (total <= 0) return { start: 0, count: 0, view: AUTO_TIME, atLiveEdge: true };
  const wanted = tv.count == null ? Math.min(room, total) : tv.count;
  const count = Math.max(1, Math.min(Math.round(clampNum(wanted, MIN_VISIBLE, Math.max(MIN_VISIBLE, room))), total));
  const endOffset = Math.round(clampNum(tv.endOffset, 0, Math.max(0, total - count)));
  const start = Math.max(0, total - endOffset - count);
  return {
    start,
    count,
    view: { count: tv.count == null ? null : count, endOffset },
    atLiveEdge: endOffset === 0,
  };
}

function clampNum(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/**
 * A sideways drag → a new time window.
 *
 * THE CONTENT FOLLOWS THE FINGER, exactly as it does vertically: drag RIGHT and
 * the candles move right, which means older ones come in from the left — so the
 * window moves BACK in time and `endOffset` grows. `step` is the pixel width of
 * one candle, which is what turns pixels into candles.
 */
export function panTimeByDrag(tv: TimeView, dxPx: number, step: number, total: number, fit: number): TimeView {
  if (!(step > 0) || !Number.isFinite(dxPx)) return tv;
  const w = timeWindow(total, fit, tv);
  // Fractional pixels accumulate: a slow drag must not be rounded away to
  // nothing on every event and leave the chart feeling stuck.
  const moved = dxPx / step;
  return timeWindow(total, fit, { count: w.count, endOffset: w.view.endOffset + moved }).view;
}

/**
 * A wheel or pinch → a new time window, ANCHORED at the pointer.
 *
 * `frac` is where the pointer sits across the plot, 0 = left edge, 1 = right.
 * The candle under it stays under it, which is the whole difference between a
 * zoom you can aim and one that throws your place away — the same rule the
 * price axis follows by zooming about the centre of the view.
 */
export function zoomTimeAt(tv: TimeView, factor: number, frac: number, total: number, fit: number): TimeView {
  if (!(factor > 0) || !Number.isFinite(frac)) return tv;
  const w = timeWindow(total, fit, tv);
  const anchor = w.start + clampNum(frac, 0, 1) * w.count; // index under the pointer
  const count = clampNum(w.count * factor, MIN_VISIBLE, total);
  const start = anchor - clampNum(frac, 0, 1) * count;
  return timeWindow(total, fit, { count, endOffset: total - (start + count) }).view;
}

export const _MIN_VISIBLE = MIN_VISIBLE;
