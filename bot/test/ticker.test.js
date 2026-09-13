// The ticker rule must match the SITE's (src/lib/adminValidate.ts). When it
// doesn't, the bot happily takes payment for a listing the site then refuses
// with "400: Invalid ticker" — the buyer has paid and gets nothing (incident
// 2026-07-23, order mrxqsrvz_5c44391a).
const test = require("node:test");
const assert = require("node:assert");
const { normalizeTicker, isValidTicker, sanitizeTicker, MAX_TICKER } = require("../src/helpers/ticker");

test("normalize: strips $, trims, uppercases — and never truncates", () => {
  assert.strictEqual(normalizeTicker("  $pepe "), "PEPE");
  assert.strictEqual(normalizeTicker("$$doge"), "DOGE");
  assert.strictEqual(normalizeTicker(null), "");
  // Truncating here would silently publish a DIFFERENT ticker than the one the
  // buyer typed. Over-long is an error to report, not something to fix quietly.
  assert.strictEqual(normalizeTicker("x".repeat(40)).length, 40);
});

test("valid: what the site accepts", () => {
  for (const ok of ["PEPE", "$pepe", "wif", "A1", "DOG_E", "DOG-E", "DOG.E", "旺旺", "ПЕПЕ"]) {
    assert.ok(isValidTicker(ok), `should be accepted: ${ok}`);
  }
});

test("invalid: exactly the cases that used to fail AFTER payment", () => {
  for (const bad of [
    "",
    "   ",
    "$",
    "SAFE MOON", // whitespace — the classic autofilled symbol
    "PEPE🐸", // emoji
    "<b>PEPE</b>", // markup: the site renders tickers into escaped HTML
    "PEPE&CO",
    "PE​PE", // zero-width — invisible, and breaks the signal wire
  ]) {
    assert.ok(!isValidTicker(bad), `should be rejected: ${JSON.stringify(bad)}`);
  }
});

test("length: 24 is the limit, and the bot draws it in the same place as the site", () => {
  assert.ok(isValidTicker("A".repeat(24)));
  assert.ok(!isValidTicker("A".repeat(25)), "the site refuses this — so must the bot, up front");
  // Repair (autofill / post-payment rescue) may shorten; user input may not.
  assert.strictEqual(sanitizeTicker("A".repeat(40)), "A".repeat(24));
});

test("sanitize: repairs an autofilled symbol instead of losing the sale", () => {
  assert.strictEqual(sanitizeTicker("SAFE MOON"), "SAFEMOON");
  assert.strictEqual(sanitizeTicker("PEPE🐸"), "PEPE");
  assert.strictEqual(sanitizeTicker("$wif "), "WIF");
  assert.strictEqual(sanitizeTicker("<b>PEPE</b>"), "BPEPEB"); // markup stripped, letters kept
  // Nothing usable left → "" so the caller ASKS a human rather than inventing one.
  assert.strictEqual(sanitizeTicker("🐸🚀"), "");
  assert.strictEqual(sanitizeTicker(""), "");
});

test("sanitize always produces something the site would accept (or nothing)", () => {
  for (const raw of ["SAFE MOON", "PEPE🐸", "  $a b c  ", "<b>x</b>", "旺 旺", "A".repeat(40)]) {
    const s = sanitizeTicker(raw);
    if (s) assert.ok(isValidTicker(s), `sanitized ${JSON.stringify(raw)} → ${JSON.stringify(s)} still invalid`);
  }
});
