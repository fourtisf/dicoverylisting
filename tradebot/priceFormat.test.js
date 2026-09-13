// usdX — the dollar formatter every card prints prices through.
//
// $TLNCH trades at 0.0000026, and two decimal places rendered that as "$0.00":
// the single number a trader opened the card to read, shown as zero, next to a
// market cap and a liquidity figure that were both correct. Below a cent the
// formatter now uses the subscript form every chart uses — $0.0₅26 is five
// zeros then 26.
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert");

// Lifted from the real source, so this cannot pass against a copy that drifted.
const SRC = fs.readFileSync(path.join(__dirname, "telegram.js"), "utf8");
const usdX = (() => {
  const start = SRC.indexOf("const usdX = (n) =>");
  const end = SRC.indexOf('// A "contract" the user can paste');
  assert.ok(start > -1 && end > start, "usdX moved — update the markers here");
  return new Function(SRC.slice(start, end) + "\nreturn usdX;")();
})();

test("a sub-cent price is never rendered as $0.00", () => {
  assert.strictEqual(usdX(0.0000026), "$0.0₅26");
  assert.strictEqual(usdX(0.00000000123), "$0.0₈123");
  for (const n of [1e-3, 1e-5, 1e-7, 1e-9, 2.6e-6, 9.9e-8]) {
    assert.notStrictEqual(usdX(n), "$0.00", `${n} rendered as zero`);
  }
});

test("the subscript count is the number of zeros after the point", () => {
  // 0.0₅26 = 0.0000026: five zeros, then the digits. Off by one here and every
  // price on every card is out by a factor of ten.
  const [, zeros, digits] = usdX(0.0000026).match(/^\$0\.0(₅)(\d+)$/) || [];
  assert.strictEqual(zeros, "₅");
  assert.strictEqual(digits, "26");
  assert.strictEqual(Number("0." + "0".repeat(5) + "26"), 0.0000026);
});

test("two or fewer zeros are written out — the subscript is for the rest", () => {
  assert.strictEqual(usdX(0.0042), "$0.0042");
  assert.strictEqual(usdX(0.009), "$0.009");
});

test("ordinary money is untouched", () => {
  // The whole point of usdX over fmt() is that it does NOT abbreviate below a
  // million; a regression here would silently change every wallet screen.
  assert.strictEqual(usdX(2601.41), "$2,601.41");
  assert.strictEqual(usdX(38.64), "$38.64");
  assert.strictEqual(usdX(0.5), "$0.50");
  assert.strictEqual(usdX(1234567), "$1.23M");
  assert.strictEqual(usdX(0), "$0.00");
});

test("a missing or junk value is still $0.00, not NaN", () => {
  for (const bad of [null, undefined, NaN, "", "abc"]) assert.strictEqual(usdX(bad), "$0.00");
});
