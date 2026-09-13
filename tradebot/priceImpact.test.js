// "di Maestro sukses, bot kita fail."
//
// A 0.05 ETH buy was refused: "Buy blocked — thin pool … would move the price
// ~11% — over the 10% limit." Maestro filled the same trade. Two separate
// mistakes were stacked on top of each other:
//
//   1. the number was computed with a V2 constant-product formula against a V3
//      pool's raw balance. V3 liquidity is CONCENTRATED — a pool holding 0.8
//      ETH can fill a 0.05 ETH buy at almost no impact — so the 11% was an
//      artefact, not a measurement.
//   2. even when the number is real, refusing outright ignores the slippage the
//      user set, which is their own statement of what they will accept.
const fs = require("node:fs");
const path = require("node:path");

const test = require("node:test");
const assert = require("node:assert");

const strip = (f) =>
  fs.readFileSync(path.join(__dirname, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CORE = strip("core.js");
const TG = strip("telegram.js");

test("a V3 pool is never judged by the constant-product formula", () => {
  // THE bug. A V3 pool's WETH balance is not its depth at spot, so this formula
  // invents an impact that is not there — and it refused a trade Maestro filled.
  const fn = TG.slice(TG.indexOf("async function impactNote("));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /if \(!pick \|\| pick\.kind === 'v3' \|\| pick\.wethBal == null\) return '';/);
  assert.match(body, /\(amtN \/ \(reserve \+ amtN\)\) \* 100/, "the formula runs only past that gate");
});

test("nothing refuses a buy any more — not the engine, not the UI", () => {
  // Operator's rule: the user must always be able to buy. Their slippage is the
  // only limit, and the on-chain minOut enforces it — a fill worse than they
  // asked for reverts by itself, which is the protection that actually works.
  assert.ok(!/PRICE_IMPACT_MAX_PCT/.test(CORE), "the engine ceiling is gone");
  assert.ok(!/PRICE_IMPACT_MAX_PCT/.test(TG), "…and the UI never had its own to keep");
  assert.ok(!/Buy blocked/.test(TG) && !/buy blocked/.test(CORE), "no refusal path is left");
  assert.match(CORE, /const minTok = expTok \* \(10000n - slip\) \/ 10000n;/, "the real guard is still there");
});

test("the trade starts before ANYTHING is awaited", () => {
  // The latency the user felt: a bestDexVenue probe with a 6s timeout, then a
  // Telegram round-trip for "Buying…", both in series ahead of the buy. Up to
  // ~6.5s before a single on-chain call, against a bot that fills immediately.
  const fn = TG.slice(TG.indexOf("async function doBuy("));
  const single = fn.slice(fn.indexOf("if (targets.length <= 1)"), fn.indexOf("} else {"));
  const iBuy = single.indexOf("const buying = core.buy(");
  const iProgress = single.indexOf("const progress = expert ? null : await send(");
  const iProbe = single.indexOf("const impactP = impactNote(");
  assert.ok(iBuy > -1 && iProgress > -1 && iProbe > -1, single);
  assert.ok(iBuy < iProgress, "the buy must be in flight before the progress message is awaited");
  assert.ok(iBuy < iProbe, "…and before the depth probe");
  assert.ok(!/await core\.buy\(/.test(single), "core.buy is started, not awaited, on that line");
  assert.match(single, /const r = await buying;/, "awaited only once there is nothing else to do");
});

test("the multi-wallet buy and the sell start the same way", () => {
  const fn = TG.slice(TG.indexOf("async function doBuy("));
  const multi = fn.slice(fn.indexOf("} else {"));
  // The progress line is now ENQUEUED rather than awaited inline — it has to
  // claim its slot in the chat before any wallet can report itself, or a fast
  // fill lands above the header for its own batch. What this test is about is
  // unchanged and still holds: the trades are dispatched first.
  assert.ok(
    multi.indexOf("const raw = targets.map((t) => core.buy(") < multi.indexOf("const progressP = expert ?"),
    "every wallet's buy is in flight before the progress message",
  );
  const sell = TG.slice(TG.indexOf("async function doSell("));
  assert.ok(
    sell.indexOf("const selling = sellWithRetry(") < sell.indexOf("progress = expert ? null : await send("),
    "an exit is where a round-trip of delay is felt most",
  );
  // …and the MULTI-wallet exit, which was never held to this at all: its
  // fan-out sat after the progress await, so every multi-wallet sell paid a
  // full Telegram round trip before a single sell was dispatched.
  const sellMulti = sell.slice(sell.indexOf("} else {"));
  assert.ok(
    sellMulti.indexOf("const rawSells = targets.map((t) => sellWithRetry(") < sellMulti.indexOf("const progressP = expert ?"),
    "every wallet's sell is in flight before the progress message",
  );
});

test("the probe's result still reaches the user — it is just no longer in the way", () => {
  const fn = TG.slice(TG.indexOf("async function doBuy("));
  assert.match(fn, /const note = await impactP\.catch\(\(\) => ''\);/, "and a failed probe cannot break the receipt");
  assert.match(fn, /edit\(chatId, pid, receipt \+ note, kb\)/);
});

test("an unreadable pool says nothing, rather than stopping anything", () => {
  const fn = TG.slice(TG.indexOf("async function impactNote("));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /return '';\s*\/\/ an unreadable pool is not a reason to say anything/);
  assert.ok(!/throw|return send\(/.test(body), "it can only ever produce a string");
});

test("the message no longer claims the bot cannot trade V3", () => {
  // It can — core.buy has a full V3 path. Telling the user to go to the DEX
  // instead sent away a trade the bot would have filled.
  assert.ok(!/this bot can't trade it/.test(TG));
  assert.match(CORE, /if \(pick\.kind === 'v3'\) \{/);
});
