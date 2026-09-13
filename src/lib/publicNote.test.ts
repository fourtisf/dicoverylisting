// A public token page must not carry operator instructions.
//
// Reported 2026-09-06 with a screenshot of dexvra.io/token/bsc/0x75B3…7777,
// where the Transactions panel read, in full:
//
//   Couldn't read recent trades just now (over this process's GeckoTerminal
//   budget (5/min, shared with the bot suite on this IP) — raise GT_MAX_RPM or
//   set GECKOTERMINAL_API_KEY).
//
// Two env var names, our own process's budget, and the fact that a bot suite
// shares this IP — on the page a project sends its investors to. The chart note
// beside it was worse: it carried the upstream's Cloudflare probe verbatim.
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { publicNote, publicKind } from "./publicNote.ts";

// The vocabulary that gives an operator instructions. Every one of these is a
// real substring of a reason this app produces today.
const OPERATOR_ONLY = [
  /GT_MAX_RPM/i,
  /GECKOTERMINAL_API_KEY/i,
  /DS_CHART_/i,
  /this process/i,
  /bot suite/i,
  /req\/min/i,
  /\breq\b/i,
  /budget/i,
  /window\.__CF/i,
  /\.env\b/i,
];

// The reasons that actually reach these routes, copied from the sources that
// build them (gt.ts, dsChart.ts) and from the live screenshot.
const REAL_REASONS = [
  "over this process's GeckoTerminal budget (5/min, shared with the bot suite on this IP) — raise GT_MAX_RPM or set GECKOTERMINAL_API_KEY",
  "GeckoTerminal is rate limited — cooling down for 92s",
  "io.dexscreener.com 404 — Error Cannot GET /dex/chart/... window.__CF$cv$params={r:'a36be9ab5ab3577b'} — the request shape is a guess; set DS_CHART_PATH",
  "GeckoTerminal 429 (rate limited)",
  "fetch failed: ECONNRESET",
  "HTTP 500",
];

test("no reason a visitor is shown carries an operator instruction", () => {
  for (const reason of REAL_REASONS) {
    for (const subject of ["recent trades", "the chart"]) {
      const out = publicNote(subject, reason);
      for (const forbidden of OPERATOR_ONLY) {
        assert.ok(!forbidden.test(out), `"${forbidden}" reached the page:\n  from: ${reason}\n  out:  ${out}`);
      }
      // …and it must still SAY something. A blank is the other way to fail.
      assert.ok(out.length > 20 && out.includes(subject), out);
      // ⚠️ LOAD-BEARING SUBSTRING. CandleChart classifies error-vs-answer on
      // /couldn't read/i and only an ERROR gets the fast retry that makes a
      // chart appear the moment a GT cooldown lifts. Drop these two words and
      // a rate-limited chart reads as "no candles" and stays blank until the
      // reader reloads — which is the commonest failure, so it is the one that
      // must not go quiet. The first cut of publicNote lost it.
      assert.match(out, /couldn't read/i, `the panel's error classifier needs these words: ${out}`);
    }
  }
});

test("a rate limit is told apart from an outage, because only one passes by itself", () => {
  assert.strictEqual(publicKind("over this process's GeckoTerminal budget (5/min)"), "busy");
  assert.strictEqual(publicKind("GeckoTerminal 429 (rate limited)"), "busy");
  assert.strictEqual(publicKind("cooling down for 92s"), "busy");
  assert.strictEqual(publicKind("fetch failed: ECONNRESET"), "unavailable");
  assert.strictEqual(publicKind("io.dexscreener.com 404"), "unavailable");
  // An unrecognised reason falls to the VAGUE end, never to the raw text — the
  // whole point of classifying rather than denylisting words.
  assert.strictEqual(publicKind("something nobody has seen yet"), "unavailable");
});

test("the internal reason may travel, but it may not reach a response", () => {
  // The mutation this exists to catch: putting `${readWhy(err)}` back into the
  // JSON the browser receives. A source scan is the right shape — the defect is
  // WHERE the string goes, not what it says.
  //
  // ⚠️ It is deliberately NOT "readWhy must only appear beside console.warn".
  // The reasons are SUPPOSED to travel internally: /api/ohlcv carries both
  // sources' reasons so "GeckoTerminal 429 with a second source silently
  // unreachable behind it" cannot be reported as a settled answer. That design
  // is the thing an over-strict guard would have deleted — the first cut of
  // this test flagged it, which is how the distinction got written down.
  for (const f of ["src/app/api/trades/route.ts", "src/app/api/ohlcv/route.ts"]) {
    const src = fs.readFileSync(path.join(process.cwd(), f), "utf8");
    const stripped = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const line of stripped.split("\n")) {
      if (!/readWhy\(/.test(line)) continue;
      assert.ok(
        !/NextResponse\.json\(|\bfail\(/.test(line),
        `${f}: the internal reason must not be handed to the browser:\n${line.trim()}`,
      );
    }
    assert.match(stripped, /publicNote\(/, `${f} never calls publicNote`);
  }
});

test("every hardcoded sentence a response can carry is safe to show a stranger", () => {
  // The branches that answer with their OWN wording rather than an upstream's
  // ("GeckoTerminal doesn't index a pool…") are fine and stay specific — but
  // nothing was checking that the next one added will be.
  for (const f of ["src/app/api/trades/route.ts", "src/app/api/ohlcv/route.ts"]) {
    const src = fs.readFileSync(path.join(process.cwd(), f), "utf8");
    const stripped = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of stripped.matchAll(/why:\s*"([^"]+)"/g)) {
      for (const forbidden of OPERATOR_ONLY) {
        assert.ok(!forbidden.test(m[1]), `${f}: "${forbidden}" in a response sentence:\n  ${m[1]}`);
      }
    }
  }
});
