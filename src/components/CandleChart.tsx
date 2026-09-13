"use client";

/**
 * The token page's price chart — real candles, drawn here.
 *
 * WHAT IT REPLACES, AND WHY BOTH HAD TO GO
 *
 *  1. A GeckoTerminal IFRAME, whenever we happened to know a pool address. It
 *     charts fine and it is someone else's page inside ours: another brand's
 *     type, another brand's colours, its own loading spinner, and no way to
 *     read one number out of it for anything else on the page.
 *  2. A FABRICATED AREA CHART whenever we did not — `syntheticTrend(symbol,
 *     chg24h)`, a curve generated from the ticker's hash, drawn full-width
 *     under the words "Price trend". On a 34px sparkline that is decoration.
 *     At 640×120 on the page a person opens to decide whether to buy, it is a
 *     claim about a market that nobody measured. This repo refuses a printed
 *     `0.00%` for an unreadable change; a drawn price history is the same lie
 *     with more pixels.
 *
 * So: candles from /api/ohlcv, and when there are none, the panel SAYS which
 * of the two reasons it is — no pool indexed yet, versus we could not read the
 * chart just now. Those need different reactions from the reader, and an empty
 * grid gives them the same one.
 *
 * THE VERTICAL BELONGS TO THE READER
 * $BREAKING went from $0.000803 to $0.0281 in two days and the chart of it was
 * a flat line on the floor with one spike at the right-hand edge — every number
 * correct, the picture useless, because on a LINEAR axis a 35x move spends 96%
 * of the height on the last 4% of the story. So the axis is a control now:
 * LIN/LOG in the header, drag the price gutter to stretch or squash, drag the
 * chart to move it up and down, double-click for the automatic range back. The
 * arithmetic is in lib/chartScale.ts, where a test can drive it — a scale is
 * arithmetic, and the ways it goes wrong (a zero span, a log of zero, an axis
 * walked into negative dollars) are invisible until they are on a screen.
 *
 * ⚠️ AND THE PANEL SAYS WHEN THE READER HAS MOVED IT. A log chart and a linear
 * one of the same token are different pictures, and so are an auto range and a
 * stretched one; anybody comparing two screenshots is owed the difference. The
 * mode is always visible and `⤢ Auto` appears the moment the axis is no longer
 * the data's own.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { TIMEFRAMES, pollMsFor, priceRange, windowChangePct, type Candle, type Timeframe } from "@/lib/ohlcv";
import {
  AUTO,
  AUTO_TIME,
  isAdjusted,
  isTimeAdjusted,
  panByDrag,
  panTimeByDrag,
  priceScale,
  timeWindow,
  zoomByDrag,
  zoomTimeAt,
  type ScaleAdjust,
  type ScaleMode,
  type TimeView,
} from "@/lib/chartScale";
import { fmtCap, fmtPrice } from "@/lib/format";
import { dsEmbedUrl } from "@/lib/dsEmbed";

interface Feed {
  ok: boolean;
  network: string | null;
  pool: string | null;
  candles: Candle[];
  why: string | null;
  /** Which upstream drew this — GeckoTerminal, or the DexScreener fallback that
   *  answers while GT's shared rate-limit cooldown holds. Shown, because
   *  otherwise a chart drawn by the fallback and a chart drawn by GT are
   *  identical from outside, and "the second source works" and "the second
   *  source never fires" are the same picture. */
  source?: "geckoterminal" | "dexscreener" | null;
  /** "Open it at the source", built by the route: `pool` is a GeckoTerminal
   *  pool id and a DexScreener pair address in that field would 404. */
  sourceUrl?: string | null;
}

type Status = "loading" | "ok" | "none" | "error";

// Chart furniture, in pixels. The right gutter holds the price axis, the bottom
// one the time axis; the volume histogram sits between them.
const PAD_L = 10;
const PAD_R = 74;
const PAD_T = 14;
const AXIS_H = 22;
const GAP = 10;
const MAX_BODY = 13;
const GRID_LINES = 5;
/** Narrowest a candle may get before the window is trimmed instead. Below ~4px
 *  the bodies and the gaps merge into one smear. */
const MIN_STEP = 4;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");

/** Clock label for a candle. Intraday candles are read as a time of day, daily
 *  ones as a date — a "14:30" on a 1d chart says nothing at all. */
function timeLabel(t: number, tf: Timeframe): string {
  const d = new Date(t * 1000);
  if (tf === "1d") return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
const fullLabel = (t: number): string => {
  const d = new Date(t * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

/** How much time the drawn window covers. "over 40h" is what "160 × 15m" meant
 *  and could not say — and the page header carries a 24h figure right above
 *  this one, so which period each number belongs to has to be legible. */
function spanLabel(seconds: number): string {
  const h = seconds / 3600;
  if (h < 48) return `${Math.max(1, Math.round(h))}h`;
  const d = h / 24;
  return d < 90 ? `${Math.round(d)}d` : `${Math.round(d / 30)}mo`;
}

export function CandleChart({
  chain,
  address,
  symbol,
  poolHint,
  gtUrl,
}: {
  chain: string;
  address: string;
  symbol: string;
  /** The pool the market provider already named, so the first request skips a
   *  lookup. A HINT: /api/ohlcv re-resolves if GeckoTerminal doesn't know it. */
  poolHint?: string | null;
  /** Fallback "open it elsewhere" link for the states with nothing to draw. */
  gtUrl?: string | null;
}) {
  // Resolved once: it depends only on the token, never on the feed's outcome.
  const embedUrl = useMemo(() => dsEmbedUrl(chain, address), [chain, address]);
  const [tf, setTf] = useState<Timeframe>("15m");
  const [status, setStatus] = useState<Status>("loading");
  const [feed, setFeed] = useState<Feed | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  // The reader's vertical. `mode` is a PREFERENCE and survives a timeframe
  // switch — somebody who wants a log axis wants it on every tab. `adjust` is a
  // view of ONE window and does not: a stretch aimed at two days of 15m candles
  // is meaningless over six months of daily ones, and inheriting it would open
  // the new tab on an axis with no candles in it.
  const [mode, setMode] = useState<ScaleMode>("lin");
  const [adjust, setAdjust] = useState<ScaleAdjust>(AUTO);
  // …and the horizontal. Same reasoning, other axis: a chart you cannot travel
  // through time in is a picture, not a chart.
  const [timeView, setTimeView] = useState<TimeView>(AUTO_TIME);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  /** The drag in progress, if any. A ref rather than state: it changes on every
   *  pointer event and nothing renders from it directly. */
  const dragRef = useRef<{ kind: "zoom" | "pan"; x: number; y: number; id: number } | null>(null);
  // ⚠️ `useId()` returns `:r0:` — legal in an id, and a colon inside a
  // `url(#…)` reference is one browser-quirk away from a clip that silently
  // does nothing (and it can never be found with querySelector). Stripped to
  // word characters, because the failure mode is a chart drawing over its own
  // volume band on somebody else's browser and nowhere near a test.
  const clipId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  // The wheel listener is bound ONCE (it has to be, to be non-passive), so it
  // reads the current geometry through refs rather than closing over one
  // render's — a stale `geo` there would zoom against a window that has gone.
  const geoRef = useRef<{ plotW: number; fit: number; view: Candle[] } | null>(null);
  const candlesRef = useRef(0);

  // ── data ────────────────────────────────────────────────────────────────
  // One effect owns the whole lifecycle for one (token, timeframe): the first
  // read, the poll, and the abort. `drawn` lives inside it rather than in state
  // deliberately — it is "does the panel currently show candles for THIS
  // timeframe", which is exactly what must not be inherited across a tab switch.
  useEffect(() => {
    const ac = new AbortController();
    let stopped = false;
    let drawn = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // How many times in a row we have retried a TRANSIENT failure (a GT
    // cooldown). Bounded, so a genuinely unreachable box settles to the slow
    // poll instead of retrying forever.
    let recovering = 0;

    // Returns the last status so the scheduler can decide how soon to look again.
    const run = async (quiet: boolean): Promise<Status> => {
      if (!quiet) {
        setStatus("loading");
        setFeed(null);
        setHover(null);
      }
      try {
        const qs = new URLSearchParams({ chain, address, tf });
        if (poolHint) qs.set("pool", poolHint);
        const res = await fetch(`/api/ohlcv?${qs}`, { signal: ac.signal });
        const j = (await res.json()) as Feed;
        if (stopped) return "loading";
        if (j.ok && j.candles?.length) {
          drawn = j.candles.length;
          setFeed(j);
          setStatus("ok");
          return "ok";
        }
        // A POLL THAT FAILS MUST NEVER BLANK A CHART THAT IS ALREADY DRAWN —
        // the pool did not stop existing because one request did not land, and
        // "no candles yet" over a chart the reader was just looking at is a
        // worse answer than a slightly stale one.
        if (quiet && drawn > 0) return "ok";
        setFeed(j);
        const st: Status = j.why && /couldn't read/i.test(j.why) ? "error" : "none";
        setStatus(st);
        return st;
      } catch {
        if (stopped) return "loading";
        if (quiet && drawn > 0) return "ok";
        setFeed(null);
        setStatus("error");
        return "error";
      }
    };

    // ⚠️ RECOVER FAST FROM A COOLDOWN, WITHOUT HAMMERING GECKOTERMINAL. An
    // "error" here is almost always the shared 120s rate-limit cooldown, and a
    // request made while it holds returns WITHOUT reaching GT (providers/gt) —
    // so a quick client re-poll is free upstream and simply lets the chart draw
    // itself the moment the window clears, instead of the reader staring at
    // "cooling down" until the slow 30–90s poll comes round. Bounded to a
    // handful of tries: past that the box is genuinely unreachable, and we fall
    // back to the slow poll rather than spinning. "none" (no pool indexed) is a
    // real answer, not a cooldown, so it is never fast-retried.
    const RECOVER_MS = 5_000;
    const RECOVER_MAX = 8;
    const schedule = (st: Status) => {
      if (stopped) return;
      const fast = st === "error" && recovering < RECOVER_MAX;
      recovering = st === "error" ? recovering + 1 : 0;
      timer = setTimeout(async () => schedule(await run(true)), fast ? RECOVER_MS : pollMsFor(tf));
    };

    void run(false).then(schedule);
    return () => {
      stopped = true;
      ac.abort();
      if (timer) clearTimeout(timer);
    };
  }, [chain, address, tf, poolHint]);

  // A stretch belongs to the window it was aimed at. Switching timeframe or
  // token replaces that window wholesale, so the axis goes back to the data's.
  useEffect(() => {
    setAdjust(AUTO);
    setTimeView(AUTO_TIME);
  }, [chain, address, tf]);

  // ── geometry ────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setBox({ w: Math.round(el.clientWidth), h: Math.round(el.clientHeight) });
    // ⚠️ MEASURE NOW, not only on the observer's first callback. Without
    // ResizeObserver — an old browser, or a rendering context that has none —
    // `box` stayed {0,0} for ever, `geo` stayed null, and the panel rendered
    // NOTHING AT ALL: no chart, no message, no error. A blank surface that
    // reads as "still loading" is the state this repo keeps paying for.
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const candles = feed?.candles ?? [];
  const geo = useMemo(() => {
    const { w, h } = box;
    if (w < 120 || h < 160 || candles.length === 0) return null;
    const volH = Math.min(90, Math.max(38, Math.round(h * 0.16)));
    const plotW = w - PAD_L - PAD_R;
    const priceH = h - PAD_T - volH - AXIS_H - GAP;
    if (plotW < 40 || priceH < 60) return null;

    // HOW MANY CANDLES FIT, not how many arrived. 200 candles across a phone's
    // 330px plot is a 1.6px body per candle — a green-and-red smear you cannot
    // read a single bar out of. That is the AUTO answer and the ceiling on
    // zooming out; where the window actually sits is the reader's, and
    // `timeWindow` clamps their gesture to what the data can show.
    const fit = Math.max(24, Math.floor(plotW / MIN_STEP));
    const win = timeWindow(candles.length, fit, timeView);
    const view = candles.slice(win.start, win.start + win.count);
    if (view.length === 0) return null;

    const range = priceRange(view);
    if (!range) return null;
    // The vertical, including whatever the reader has done to it. Headroom,
    // the log transform and the bounds all live in lib/chartScale.
    const scale = priceScale(range, mode, adjust, { top: PAD_T, height: priceH });
    const maxVol = view.reduce((m, c) => Math.max(m, c.v), 0);

    const step = plotW / view.length;
    const body = Math.max(1, Math.min(MAX_BODY, step * 0.66));
    const yOf = scale.yOf;
    const xOf = (i: number) => PAD_L + step * (i + 0.5);
    const volTop = PAD_T + priceH + GAP;
    const yVol = (v: number) => (maxVol > 0 ? volH - (v / maxVol) * volH : volH);

    return { w, h, scale, step, body, yOf, xOf, priceH, volH, volTop, plotW, maxVol, yVol, view, fit, win };
  }, [box, candles, mode, adjust, timeView]);

  geoRef.current = geo;
  candlesRef.current = candles.length;

  // EVERYTHING BELOW READS THE VISIBLE WINDOW, not the fetched list — a
  // percentage measured over candles that were never drawn is a number the
  // reader cannot check against the chart it sits on.
  const view = geo?.view ?? [];
  const active = hover != null && view[hover] ? view[hover] : view[view.length - 1];
  const last = view[view.length - 1];
  const change = windowChangePct(view);
  const upWindow = (change ?? 0) >= 0;
  const span = view.length > 1 ? spanLabel(view[view.length - 1].t - view[0].t) : null;

  const onMove = (clientX: number) => {
    if (!geo) return;
    const el = wrapRef.current;
    if (!el) return;
    const x = clientX - el.getBoundingClientRect().left;
    const i = Math.floor((x - PAD_L) / geo.step);
    setHover(i >= 0 && i < geo.view.length ? i : null);
  };

  // ── the reader's vertical ───────────────────────────────────────────────
  const resetScale = useCallback(() => {
    setAdjust(AUTO);
    setTimeView(AUTO_TIME);
  }, []);

  /** Start a drag. `kind` is decided by WHERE it started: the price gutter
   *  scales, the chart itself pans — the grammar every charting tool uses, so
   *  there is nothing to learn. */
  const startDrag = (e: React.PointerEvent<HTMLElement>, kind: "zoom" | "pan") => {
    // Same reason as `moveDrag`: a pointerdown on the gutter would otherwise
    // start a zoom and then bubble to the plot, which would replace it with a
    // pan — the axis control silently becoming a pan control.
    e.stopPropagation();
    dragRef.current = { kind, x: e.clientX, y: e.clientY, id: e.pointerId };
    setHover(null); // a crosshair frozen mid-drag reads as a hung chart
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const moveDrag = (e: React.PointerEvent<HTMLElement>): boolean => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId || !geo) return false;
    // ⚠️ THE GUTTER IS INSIDE THE PLOT, AND POINTER EVENTS BUBBLE — so without
    // this every pointer event over the price axis ran BOTH handlers, and the
    // two of them fought over one drag. MEASURED, not reasoned about: with the
    // three `stopPropagation` calls removed, a 60px pan moved the chart 210px
    // and the same axis drag produced a different zoom. Which handler wins in
    // which order is not worth working out; a drag belongs to the element it
    // started on, and `chart:preview` asserts the chart moves BY the drag
    // rather than merely in its direction — the version of that check that
    // said `> 20px` passed on the broken build.
    e.stopPropagation();
    const dy = e.clientY - d.y;
    const dx = e.clientX - d.x;
    d.y = e.clientY;
    d.x = e.clientX;
    if (d.kind === "zoom") {
      // The gutter scales the price axis and nothing else. Measured against the
      // PRICE area, not the whole panel: the volume band and the time axis are
      // not part of the scale being dragged.
      setAdjust((a) => zoomByDrag(a, dy, geo.priceH));
      return true;
    }
    // A body drag travels through TIME sideways and moves the price scale
    // vertically — one gesture, two axes, which is the grammar TradingView and
    // DexScreener both use.
    if (dx) setTimeView((t) => panTimeByDrag(t, dx, geo.step, candles.length, geo.fit));
    // ⚠️ VERTICAL IS THE MOUSE'S ONLY. On a phone a vertical drag across the
    // plot is how the page is scrolled, and stealing it would trap the reader
    // on the chart — `touch-action: pan-y` hands the browser the vertical and
    // leaves us the horizontal, which is exactly the half worth having there.
    if (dy && e.pointerType === "mouse") setAdjust((a) => panByDrag(a, dy, geo.priceH));
    return true;
  };

  const endDrag = (e: React.PointerEvent<HTMLElement>) => {
    e.stopPropagation();
    if (dragRef.current?.id === e.pointerId) dragRef.current = null;
    // Only what we actually took. On touch the body drag is never started (the
    // page scroller keeps it), so the pointerdown returns before capturing —
    // and every touch-scroll across the chart then arrives here with nothing to
    // release. Chromium treats that as a no-op and the phone check in
    // `chart:preview` confirms it, but the spec allows a NotFoundError and this
    // is the path every phone reader takes.
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  // ⚠️ THE WHEEL NEEDS A NATIVE, NON-PASSIVE LISTENER. React attaches `onWheel`
  // passively, and a passive listener CANNOT `preventDefault` — so the handler
  // would run, zoom the chart, and let the page scroll away underneath it at the
  // same time. Bound here instead, and only over the plot.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const g = geoRef.current;
      if (!g || g.view.length === 0) return; // nothing drawn — leave the page alone
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const frac = (e.clientX - r.left - PAD_L) / Math.max(1, g.plotW);
      // Up/away = zoom IN (fewer candles, wider bodies), the direction every
      // charting tool uses. Trackpads send small deltas and mice send ~100, so
      // the step is bounded rather than proportional.
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      setTimeView((t) => zoomTimeAt(t, factor, frac, candlesRef.current, g.fit));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // The route names the link now, because only it knows which source answered.
  // The GT-shaped fallback stays for an older cached response and for the
  // caller-supplied `gtUrl`.
  const srcLink =
    feed?.sourceUrl ??
    (feed?.network && feed?.pool ? `https://www.geckoterminal.com/${feed.network}/pools/${feed.pool}` : gtUrl ?? null);
  const srcName = feed?.source === "dexscreener" ? "DexScreener" : "GeckoTerminal";
  // We have candles and cannot draw them: the panel is too small for a chart to
  // mean anything. It must SAY so — the alternative is an empty box that reads
  // exactly like a chart still loading.
  const tooSmall = status === "ok" && !geo && box.w > 0 && box.h > 0 && candles.length > 0;
  /** Where the last-price tag sits: on the price, PINNED into the panel. A
   *  reader who has dragged the scale can put the last close off screen, and
   *  the one number they came for must not go with it. */
  const lastTagY =
    geo && last
      ? Math.min(PAD_T + geo.priceH - 10, Math.max(PAD_T + 10, geo.yOf(last.c)))
      : 0;

  /**
   * Is the panel showing DEXSCREENER'S OWN CHART rather than ours?
   *
   * ⚠️ EVERY CONTROL IN OUR HEADER IS INERT WHILE IT IS. LIN/LOG, the
   * timeframes and ⤢ Auto all drive the native renderer; over a third-party
   * iframe they do nothing at all — and the embed carries its OWN timeframe row
   * (`1s 1m 5m 15m 1h 4h D`) immediately beneath ours. On a phone that is two
   * rows of timeframe buttons stacked, one of which cannot work, above a chart
   * squeezed into what is left of a 360px panel. "A row the engine ignores" is
   * this repo's own name for it, and it costs the most exactly where there is
   * least room.
   */
  const embedSrc = status === "error" ? embedUrl : null;
  const showEmbed = embedSrc !== null;

  return (
    <div className={`ck${showEmbed ? " ck--embed" : ""}`}>
      <div className="ck-head">
        <div className="ck-title">
          <span className="ck-sym">{symbol}</span>
          {status === "ok" && change != null && (
            <span className={`ck-chg ${upWindow ? "up" : "dn"}`}>
              {upWindow ? "+" : ""}
              {change.toFixed(2)}% {span && <span className="ck-chg-tf">over {span}</span>}
            </span>
          )}
          {/* Only over a chart that is actually drawn: a live dot on a blank
              panel is the reassuring reading of a state that is not. */}
          {/* ⚠️ Only AT THE LIVE EDGE. Scrolled back into history, a pulsing
              "live" dot over candles from two days ago is the reassuring
              reading of a state that is not — the chart is still refreshing,
              but what you are looking at is not the present. */}
          {status === "ok" && geo != null && geo.win.atLiveEdge && (
            <span className="ck-live" title="Refreshing while you watch" />
          )}
          {status === "ok" && geo != null && !geo.win.atLiveEdge && (
            <span className="ck-src" title="You have scrolled back — double-click or ⤢ Auto to return to the latest candle">
              history
            </span>
          )}
          {/* The fallback SAYS it is the fallback. Named only when it is not
              the usual source, so the ordinary chart stays uncluttered — but a
              chart drawn from DexScreener resolved its own pair independently
              of GeckoTerminal's pool, and a reader comparing two screenshots
              is owed the reason they can differ. */}
          {status === "ok" && geo != null && feed?.source === "dexscreener" && (
            <span className="ck-src" title="GeckoTerminal is rate limited right now — these candles are DexScreener's">
              via DexScreener
            </span>
          )}
        </div>
        {/* Dropped, never disabled: a greyed-out row still costs the height,
            and the reader is looking at a chart that already has controls. */}
        {!showEmbed && (
        <div className="ck-ctl">
          {/* The escape hatch, and the TELL. It is only here while the axis is
              no longer the data's own — so a screenshot of a stretched chart
              carries the fact that somebody stretched it. Double-clicking the
              plot does the same thing; this is the version that works on a
              phone and the version that is discoverable. */}
          {(isAdjusted(adjust) || isTimeAdjusted(timeView)) && (
            <button className="ck-auto" onClick={resetScale} title="Back to the automatic price range">
              ⤢ Auto
            </button>
          )}
          {/* Two buttons rather than one toggle: which axis a chart is on has
              to be readable OFF the picture, not by hovering it. A log chart
              and a linear one of the same token are different pictures. */}
          <div className="ck-tfs" role="group" aria-label="Price scale">
            {(["lin", "log"] as const).map((m) => (
              <button
                key={m}
                aria-pressed={m === mode}
                className={`ck-tf ${m === mode ? "on" : ""}`}
                title={
                  m === "log"
                    ? "Logarithmic price scale — equal percentage moves are equal heights, so a 35x reads across the whole chart"
                    : "Linear price scale — equal dollar moves are equal heights"
                }
                onClick={() => setMode(m)}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="ck-tfs" role="tablist" aria-label="Chart timeframe">
            {TIMEFRAMES.map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={k === tf}
                className={`ck-tf ${k === tf ? "on" : ""}`}
                onClick={() => {
                  setHover(null);
                  setTf(k);
                }}
              >
                {k}
              </button>
            ))}
          </div>
        </div>
        )}
      </div>

      <div
        className="ck-plot"
        ref={wrapRef}
        onPointerDown={(e) => startDrag(e, "pan")}
        onPointerMove={(e) => {
          // A drag owns the pointer; only a free one moves the crosshair.
          if (!moveDrag(e)) onMove(e.clientX);
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => {
          if (!dragRef.current) setHover(null);
        }}
        onDoubleClick={resetScale}
      >
        {(status === "loading" || (status === "ok" && !geo && !tooSmall)) && (
          <div className="ck-msg">
            <span className="dot-live" /> Loading candles…
          </div>
        )}

        {tooSmall && <div className="ck-msg">Not enough room here to draw the chart.</div>}

        {/* ⚠️ AN APOLOGY IS WORSE THAN SOMEBODY ELSE'S WATERMARK. Where we could
            not READ a chart, DexScreener's own is embedded rather than an empty
            panel — the operator's explicit call ("gpp ada watermark"), and it
            reverses only the ALTERNATIVE, never the default: the native chart
            is still what a reader gets whenever either source can draw one.
            `status === "none"` deliberately does NOT get it — that is a fact
            about the TOKEN (no pool has traded yet), and their chart would be
            just as empty while implying the failure was ours. */}
        {showEmbed ? (
          <div className="ck-embed">
            <iframe
              src={embedSrc}
              title={`${symbol} chart on DexScreener`}
              loading="lazy"
              // Their chart is a TradingView widget: it needs scripts and its
              // own origin. No sandbox that would leave a blank frame — a
              // broken embed is the state this replaces, not a safer one.
              referrerPolicy="no-referrer-when-downgrade"
            />
            {/* ⚠️ NO NOTE OF OUR OWN. This carried "via DexScreener", on the
                rule that a chart the reader cannot attribute is worse than no
                chart — which is TRUE, and is why the `ck-src` chip above stays
                on the native DexScreener source: those candles are drawn in our
                colours and are indistinguishable from GeckoTerminal's.

                It does not transfer to the EMBED. That is a third-party iframe
                that paints "Tracked by DEXSCREENER" with their own logo and
                wordmark across its own foot — the very branding the original
                ban on this embed was written about. So our line said the same
                thing a second time, one row below theirs, and the operator
                asked for it to go. Attribution is not lost here; it was never
                ours to make in the first place. */}
          </div>
        ) : (status === "none" || status === "error") ? (
          <div className="ck-msg ck-empty">
            {/* The two states read differently on purpose: one is about the
                token (no pool yet), the other about us (we could not read it). */}
            <div className="ck-empty-k">{status === "error" ? "Chart unavailable right now" : "No candles yet"}</div>
            <p className="ck-empty-p">{feed?.why ?? "Couldn't read the chart just now."}</p>
            {srcLink && (
              <a className="ck-empty-a" href={srcLink} target="_blank" rel="noopener noreferrer">
                Open the pool on {srcName} ↗
              </a>
            )}
          </div>
        ) : null}

        {status === "ok" && geo && (
          <svg className="ck-svg" width={geo.w} height={geo.h} aria-label={`${symbol} price chart, ${tf} candles`} role="img">
            {/* The area a candle may be drawn in. ⚠️ WITHOUT IT A STRETCHED
                CHART DRAWS OVER EVERYTHING: zoom in and the wicks run straight
                through the volume histogram, the time axis and the header,
                which is not a chart with a bug in it, it is not a chart. */}
            <defs>
              <clipPath id={`ckp${clipId}`}>
                <rect x={0} y={PAD_T - 2} width={geo.w - PAD_R} height={geo.priceH + 4} />
              </clipPath>
            </defs>

            {/* price grid + right-hand axis */}
            {Array.from({ length: GRID_LINES }, (_, i) => {
              // Evenly spaced up the PANEL and priced from the axis — on a log
              // scale, five evenly-spaced dollar amounts bunch at one end.
              const p = geo.scale.priceAt(i / (GRID_LINES - 1));
              const y = geo.yOf(p);
              // The last-price tag is drawn in the same gutter. Two figures on
              // top of each other read as one wrong figure, so the grid label
              // gives way — the tag is the number people are looking for.
              const hidden = last != null && Math.abs(y - lastTagY) < 12;
              return (
                <g key={`g${i}`}>
                  <line x1={PAD_L} x2={geo.w - PAD_R} y1={y} y2={y} className="ck-grid" />
                  {!hidden && (
                    <text x={geo.w - PAD_R + 7} y={y + 3.5} className="ck-axis">
                      {fmtPrice(p)}
                    </text>
                  )}
                </g>
              );
            })}

            {/* volume histogram */}
            <g transform={`translate(0,${geo.volTop})`}>
              <line x1={PAD_L} x2={geo.w - PAD_R} y1={geo.volH} y2={geo.volH} className="ck-grid" />
              {geo.view.map((c, i) => {
                const top = geo.yVol(c.v);
                return (
                  <rect
                    key={`v${c.t}`}
                    x={geo.xOf(i) - geo.body / 2}
                    y={top}
                    width={geo.body}
                    height={Math.max(0.6, geo.volH - top)}
                    className={c.c >= c.o ? "ck-vol up" : "ck-vol dn"}
                  />
                );
              })}
              {/* NO VOLUME AXIS LABEL. In the right-hand gutter it sat a few
                  pixels under the lowest price label and the two read as one
                  column of unrelated numbers; over the band it sat on top of
                  the bars. Every bar's exact volume is in the readout above on
                  hover, which is where a number belongs. */}
            </g>

            {/* candles */}
            <g clipPath={`url(#ckp${clipId})`}>
            {geo.view.map((c, i) => {
              const up = c.c >= c.o;
              const x = geo.xOf(i);
              const yO = geo.yOf(c.o);
              const yC = geo.yOf(c.c);
              const top = Math.min(yO, yC);
              // A doji has zero body height and would vanish; 1px keeps the
              // open-equals-close candle on the chart as the flat it is.
              const hgt = Math.max(1, Math.abs(yC - yO));
              return (
                <g key={c.t} className={up ? "ck-c up" : "ck-c dn"}>
                  <line x1={x} x2={x} y1={geo.yOf(c.h)} y2={geo.yOf(c.l)} className="ck-wick" />
                  <rect x={x - geo.body / 2} y={top} width={geo.body} height={hgt} className="ck-body" />
                </g>
              );
            })}
            {/* The dashed line belongs to the plot and is clipped with it; the
                TAG does not — see below. */}
            {last && (
              <line
                x1={PAD_L}
                x2={geo.w - PAD_R}
                y1={geo.yOf(last.c)}
                y2={geo.yOf(last.c)}
                className={`ck-lastline ${last.c >= last.o ? "up" : "dn"}`}
              />
            )}
            </g>

            {/* last price. ⚠️ THE TAG IS PINNED INTO THE PANEL rather than
                clipped away with the line: it is the number the reader came for,
                and a scale they have dragged must not be able to take it off
                screen. It rides the edge when the price is out of view — the
                same thing every charting tool does, and the reason the grid
                label above still gives way to it. */}
            {last && (
              <g>
                <rect
                  x={geo.w - PAD_R + 2}
                  y={lastTagY - 9}
                  width={PAD_R - 6}
                  height={18}
                  rx={4}
                  className={`ck-lastbg ${last.c >= last.o ? "up" : "dn"}`}
                />
                <text x={geo.w - PAD_R + 7} y={lastTagY + 3.5} className="ck-lasttx">
                  {fmtPrice(last.c)}
                </text>
              </g>
            )}

            {/* time axis — a handful of stamps, never one per candle */}
            {(() => {
              const every = Math.max(1, Math.ceil(geo.view.length / 6));
              return geo.view.map((c, i) => {
                if (i % every !== 0) return null;
                // A centred label on the first candle hangs half of itself off
                // the left edge — "15:24" shipped as "5:24", which is a wrong
                // time rather than a clipped one. The end stamps anchor inward.
                const x = geo.xOf(i);
                const near = 26;
                const anchor: "start" | "end" | "middle" =
                  x < PAD_L + near ? "start" : x > geo.w - PAD_R - near ? "end" : "middle";
                return (
                  <text
                    key={`t${c.t}`}
                    x={anchor === "start" ? PAD_L : anchor === "end" ? geo.w - PAD_R : x}
                    y={geo.h - 6}
                    className="ck-axis ck-axis-x"
                    textAnchor={anchor}
                  >
                    {timeLabel(c.t, tf)}
                  </text>
                );
              });
            })()}

            {/* crosshair */}
            {hover != null && geo.view[hover] && (
              <line
                x1={geo.xOf(hover)}
                x2={geo.xOf(hover)}
                y1={PAD_T}
                y2={geo.volTop + geo.volH}
                className="ck-cross"
              />
            )}
          </svg>
        )}

        {/* THE PRICE GUTTER IS A CONTROL. Its own element rather than a region
            of the svg, because it needs three things the plot cannot give it:
            `touch-action: none` (so a drag here is a scale and not a page
            scroll — the one place on the chart where that trade is worth
            making), a resize cursor, and a title that says what it does. It
            sits over the axis labels, where there are no candles to hit. */}
        {status === "ok" && geo && (
          <div
            className="ck-yaxis"
            style={{ width: PAD_R }}
            title="Drag up to stretch the price scale, down to squash it · double-click for auto"
            aria-label="Price scale — drag to zoom"
            onPointerDown={(e) => startDrag(e, "zoom")}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={resetScale}
          />
        )}

        {status === "ok" && geo && active && (
          <div className="ck-tip" style={{ right: PAD_R + 4 }} aria-hidden>
            <span className="ck-tip-t">{fullLabel(active.t)}</span>
            <span className="ck-tip-v ck-tip-ohl">
              O <b>{fmtPrice(active.o)}</b>
            </span>
            <span className="ck-tip-v ck-tip-ohl">
              H <b>{fmtPrice(active.h)}</b>
            </span>
            <span className="ck-tip-v ck-tip-ohl">
              L <b>{fmtPrice(active.l)}</b>
            </span>
            <span className="ck-tip-v">
              C <b className={active.c >= active.o ? "up" : "dn"}>{fmtPrice(active.c)}</b>
            </span>
            <span className="ck-tip-v">
              Vol <b>{fmtCap(active.v)}</b>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
