const test = require("node:test");
const assert = require("node:assert");
const { toSmallest, toHuman } = require("../src/payments/units");

test("toSmallest — exact, no float error", () => {
  assert.strictEqual(toSmallest("ethereum", "0.06").toString(), "60000000000000000");
  assert.strictEqual(toSmallest("ethereum", 0.06).toString(), "60000000000000000");
  assert.strictEqual(toSmallest("bsc", "1.5").toString(), "1500000000000000000");
  assert.strictEqual(toSmallest("solana", "5").toString(), "5000000000");
  assert.strictEqual(toSmallest("tron", "900").toString(), "900000000");
  assert.strictEqual(toSmallest("ton", "40").toString(), "40000000000");
});

test("toSmallest — truncates over-precision instead of throwing", () => {
  assert.strictEqual(toSmallest("tron", 4.0000001).toString(), "4000000"); // 6 decimals
  assert.strictEqual(toSmallest("solana", "1.1234567891").toString(), "1123456789"); // 9 decimals
});

test("toHuman — round trips", () => {
  assert.strictEqual(toHuman("solana", "5000000000"), "5");
  assert.strictEqual(toHuman("ethereum", "60000000000000000"), "0.06");
  assert.strictEqual(toHuman("tron", "900000000"), "900");
});
