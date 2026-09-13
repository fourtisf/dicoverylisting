import test from "node:test";
import assert from "node:assert/strict";
import { fmtCap, fmtPrice } from "./format.ts";

// ⚠️ A PRINTED ZERO IS A CLAIM.
//
// "vol 0 padahal ada transaksi buy and sale" (2026-08-26) — the board showed a
// $0 volume column beside its own transaction count on the same row:
//
//   $MRNA   +185.0%   MCAP $157.7K   VOL $0   TXNS 13 · 6 buys / 7 sells
//
// Measured against the live API, the volume was not zero at all: MRNA $0.06,
// GOOGL $0.04, AMZN $0.31. Nothing in the data layer invented it — `fmtCap`
// ended in `Math.round(n)`, so every real figure under half a dollar rendered
// as "$0" and the row asserted that no trading happened over data proving it
// had. This repo already refuses the same shape for an unreadable 24h change;
// it had simply never been applied to money.

test("a real figure under a dollar is never rendered as $0", () => {
  // The exact values that were on the board when this was reported.
  assert.equal(fmtCap(0.06), "$0.06");
  assert.equal(fmtCap(0.04), "$0.04");
  assert.equal(fmtCap(0.31), "$0.31");
  assert.equal(fmtCap(0.02), "$0.02");
  assert.equal(fmtCap(0.07), "$0.07");
});

test("…however small, it keeps enough decimals to stay non-zero", () => {
  for (const v of [0.5, 0.1, 0.01, 0.004, 0.0009, 0.00004, 1e-7]) {
    const s = fmtCap(v);
    assert.notEqual(s, "$0", `${v} rendered as a flat $0`);
    assert.ok(/[1-9]/.test(s), `${v} rendered with no significant digit: ${s}`);
  }
});

test("a TRUE zero still prints $0 — that row really did have no trades", () => {
  // The board carried one of these too: AMZN, vol 0, txns 0 buys / 0 sells.
  // Zero is a fact there, and hiding it would be the opposite defect.
  assert.equal(fmtCap(0), "$0");
});

test("null is still 'not known', and never confused with zero", () => {
  assert.equal(fmtCap(null), "—");
});

test("nothing above a dollar changed", () => {
  assert.equal(fmtCap(1), "$1");
  assert.equal(fmtCap(13), "$13");
  assert.equal(fmtCap(999), "$999");
  assert.equal(fmtCap(4707.61), "$4.7K");
  assert.equal(fmtCap(157_700), "$157.7K");
  assert.equal(fmtCap(1.5e6), "$1.50M");
  assert.equal(fmtCap(2.3e9), "$2.30B");
});

test("⚠️ no branch can emit a bare '<' — the bot's port reaches parse_mode HTML", () => {
  // One bare "<" makes Telegram reject the whole message, so "<$0.01" is not
  // available as a spelling however tempting it reads.
  for (const v of [0, 1e-9, 0.004, 0.06, 0.99, 1, 999, 1e6, 1e9])
    assert.ok(!fmtCap(v).includes("<"), `fmtCap(${v}) = ${fmtCap(v)}`);
});

test("a price nobody measured is a dash, never $0", () => {
  // The board rendered seven Robinhood rows as "$0" price — the store's
  // captured-at-listing default on rows no provider had priced. fmtPrice(null)
  // is the renderer's way to say "not known", same as fmtCap and fmtNum.
  assert.equal(fmtPrice(null), "—");
  assert.equal(fmtPrice(NaN), "—");
  // …and a literal zero passed in still prints $0 — the CALLER decides what a
  // zero means (figureReading), the formatter only refuses to invent one.
  assert.equal(fmtPrice(0), "$0");
});
