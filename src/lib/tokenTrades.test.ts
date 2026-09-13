import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TRADES = readFileSync(join(process.cwd(), "src/components/TokenTrades.tsx"), "utf8");
const CHART = readFileSync(join(process.cwd(), "src/components/CandleChart.tsx"), "utf8");
const CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

// ⚠️ COMMENT-STRIPPED. Both files EXPLAIN the defects they are shaped around —
// "GeckoTerminal is asked harder, not less", "every control in our header is
// inert" — and a scan that reads comments passes on the revision it exists to
// catch, or goes red on the explanation. This repo's own rule for a source
// scan, and it has been broken twice.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const T = strip(TRADES);
const C = strip(CHART);

// ── The transactions panel ────────────────────────────────────────────────

test("a failed poll backs off instead of asking a busy upstream harder", () => {
  assert.match(T, /wait = Math\.min\(wait \* 2, MAX_POLL_MS\)/);
  assert.match(T, /setTimeout\(tick, wait\)/, "the back-off has to reach the scheduler");
  assert.match(T, /wait = POLL_MS/, "…and a success has to clear it, or one blip slows the panel for ever");
});

test("a hidden tab is not polled at all", () => {
  assert.match(T, /visibilityState === "hidden"/);
});

test("the activity fallback costs no request — it reads the token in hand", () => {
  // The whole justification: `t.txns` / `t.vol` ride the board payload this
  // component is already handed. A fetch here would be a second GT consumer
  // added by the fix for the first one.
  assert.match(T, /function activity\(t: BoardToken\)/);
  const body = T.slice(T.indexOf("function activity"), T.indexOf("export function TokenTrades"));
  assert.ok(!/fetch\(/.test(body), "the activity line may never make a request");
  assert.match(body, /t\.txns\?\.\["24h"\]/);
});

test("⚠️ …and only from a LIVE row", () => {
  // A seed row's counts are captured-at-listing defaults, not measurements.
  // Rendering those as activity is the fabricated reading this repo refuses
  // everywhere else, one panel over.
  const body = T.slice(T.indexOf("function activity"), T.indexOf("export function TokenTrades"));
  assert.match(body, /t\.source !== "live"/);
  assert.match(body, /figureReading\(/, "the volume goes through the one owner of that question");
});

test("the demo-trade fabricator has not come back", () => {
  // The rule this panel exists under: real rows, or a sentence saying why there
  // are none. The activity line is a READING, never a row.
  //
  // ⚠️ COMMENT-STRIPPED, and it had to be: the file's own header QUOTES
  // `demoTrades(t)` in the note explaining what was deleted and why, so the
  // first cut of this guard went red on correct code. That is this repo's own
  // recurring shape — a scan catching its own explanation — and the assertion
  // below is what makes the stripping load-bearing rather than incidental.
  assert.ok(!/demoTrades/.test(T), "no fabricator may return to this file");
  assert.ok(!/Math\.random/.test(T), "no invented trade may be drawn here, ever");
  // A deleted feature leaves a note where it was, or the next person to notice
  // this panel has no rows simply adds one back.
  assert.match(TRADES, /demoTrades/, "…and the deletion must still be EXPLAINED in the file it governs");
});

// ── The chart panel over the DexScreener embed ────────────────────────────

test("our chart controls are DROPPED while the embed is on screen", () => {
  // Over a third-party iframe LIN/LOG, the timeframes and ⤢ Auto do nothing —
  // and the embed carries its own timeframe row directly beneath ours, which on
  // a phone is two stacked rows of buttons, one of them inert, above a chart
  // squeezed into what is left.
  assert.match(C, /\{!showEmbed && \(\s*<div className="ck-ctl">/);
});

test("…from ONE owner, so the class and the iframe cannot disagree", () => {
  assert.match(C, /const embedSrc = status === "error" \? embedUrl : null;/);
  assert.match(C, /const showEmbed = embedSrc !== null;/);
  assert.match(C, /className=\{`ck\$\{showEmbed \? " ck--embed" : ""\}`\}/);
  assert.match(C, /\{showEmbed \? \(/, "the render reads the same value the class does");
  assert.match(C, /src=\{embedSrc\}/);
});

test("the panel grows for the embed, and only for the embed", () => {
  // Their widget stacks a toolbar, the plot, a volume pane, an axis and a
  // watermark strip; ours draws one compact axis. 360px is right for one and
  // unreadable for the other.
  assert.match(CSS, /\.tp-chart-wrap:has\(\.ck--embed\)\{height:480px\}/);
  assert.match(CSS, /\.tp-chart-wrap:has\(\.ck--embed\)\{height:560px\}/);
  // The native chart's own heights are untouched — this may not change the
  // panel a reader gets when everything is working.
  assert.match(CSS, /@media \(max-width:640px\)\{[\s\S]*?\.tp-chart-wrap\{height:360px\}/);
});

test("⚠️ the embed is still never the DEFAULT", () => {
  // The ban that stands: a third-party iframe on every token page. It is the
  // ALTERNATIVE to an apology, nothing more — `status === "none"` (a fact about
  // the token) deliberately does not get it either.
  assert.match(C, /status === "error" \? embedUrl : null/);
  assert.ok(!/status === "ok"[^\n]*embed/i.test(C), "a drawable chart is always ours");
});
