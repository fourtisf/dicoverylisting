// Best-effort without a deadline is not best-effort, it is a hang.
//
// Reported 2026-09-06: an Xpress listing sat on "Running your order — hang
// tight…" for TEN MINUTES. Detaching fulfilment from Telegraf's 120s timeout
// stopped it being KILLED; it did nothing about how long it takes.
//
// Both decorative steps declare themselves best-effort in their own comments —
// the animated custom emoji ("a failure NEVER blocks a paid listing") and the
// ffmpeg overlay composite ("any failure falls back to the raw clip") — and
// both were unbounded. The fallback only runs if the step FINISHES, and an
// ffmpeg that never returns never fails either.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-bounded-"));

const test = require("node:test");
const assert = require("node:assert");
const { bounded } = require("../src/helpers/bounded");

test("a step past its budget yields the fallback instead of blocking", async () => {
  const t0 = Date.now();
  const out = await bounded(new Promise((r) => setTimeout(r, 5000, "never seen")), 200, () => "FALLBACK");
  assert.strictEqual(out, "FALLBACK");
  assert.ok(Date.now() - t0 < 1500, `waited ${Date.now() - t0}ms — the budget did not bind`);
});

test("a step that finishes in time is untouched", async () => {
  assert.strictEqual(await bounded(Promise.resolve("real"), 5000, () => "FALLBACK"), "real");
});

test("⚠️ the timer does not hold the loop open after a fast win", async () => {
  // The other half: clearing the timer only on timeout would keep the event
  // loop alive for the whole budget after a step that finished in 200ms — a
  // 60s budget would add a minute to every process exit.
  const before = Date.now();
  await bounded(Promise.resolve(1), 60000, () => 2);
  // If the timer were still pending this test file would not exit for 60s;
  // node:test would report the whole file as timed out rather than this line.
  assert.ok(Date.now() - before < 500);
});

test("⚠️ …and it is NOT unref'd — something is awaiting it", () => {
  // An unref'd timer does not hold the loop open, so a process with nothing
  // else pending exits with the caller hung for ever. This repo has that scar
  // twice already (tradebot's bounded(), fulfilDetached.test.js's first cut).
  // ⚠️ COMMENT-BLIND, and asserted to be: the file's own header explains the
  // rule, and a scan that reads comments would go red on correct code the day
  // somebody writes `.unref()` in that explanation. This repo has that scar.
  const src = fss.readFileSync(require.resolve("../src/helpers/bounded.js"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/\.unref\(\)/.test(code), "an awaited timer may never be unref'd");
  assert.match(src, /unref/, "…and the rule must still be EXPLAINED in the file it governs");
});

test("both decorative steps in a listing are bounded, and the buyer's are not", () => {
  const src = fss.readFileSync(require.resolve("../src/fulfillment.js"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  // The two that hang: ffmpeg over the admin's clip, and the sticker build.
  assert.match(code, /bounded\([\s\S]{0,400}?composeOntoClip/, "the ffmpeg overlay must be bounded");
  assert.match(code, /bounded\(bannerTemplate\.toInlineClip/, "the gif→mp4 conversion must be bounded");
  assert.match(code, /bounded\(\s*tokenEmoji\.ensureTokenEmoji/, "the animated emoji must be bounded");
  // ⚠️ THE MARKET READ, which is the one that made listings "always" slow.
  // fetchMarket queues on gtSlot(PRIO_BACKGROUND) — the shared GeckoTerminal
  // queue, no deadline of its own, up to 200 entries released one per 4–12s —
  // so a PAID listing sat behind every timer job on the box. Structural, not
  // intermittent, which is exactly how it was reported. This repo bounded the
  // listing FORM's autofill for the identical reason and never bounded
  // fulfilment, where the buyer has already paid.
  assert.ok(!/await market\.fetchMarket/.test(code), "every fulfilment market read must be bounded");
  // ⚠️ PINNED TO A COUNT OF TWO, this went red the day the listing's and the
  // trending slot's identical reads became one owner — a guard failing over
  // code that keeps its rule. The rule is that fulfilment makes NO unbounded
  // market read and that both posts reach the market through the bounded one.
  assert.strictEqual(
    (code.match(/market\.fetchMarket\(/g) || []).length,
    (code.match(/bounded\(\s*market\.fetchMarket/g) || []).length,
    "a fulfilment market read that is not inside bounded()",
  );
  assert.ok(/bounded\(\s*market\.fetchMarket/.test(code), "the market read must be bounded");
  assert.strictEqual(
    (code.match(/readPostMarket\(/g) || []).length,
    3,
    "one bounded read, and both the listing and the trending post calling it",
  );

  // ⚠️ And NOT the steps that ARE the product. A deadline on createListing
  // would drop a paid listing on a slow minute — the opposite of the fix.
  for (const hard of ["api.createListing", "api.bookTrending"]) {
    assert.ok(!new RegExp(`bounded\\([\\s\\S]{0,120}?${hard.replace(".", "\\.")}`).test(code), `${hard} must never be bounded`);
  }
});
