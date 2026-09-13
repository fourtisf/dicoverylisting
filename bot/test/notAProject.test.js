// $USDT and $USDC on the public board, at $185B and $76B.
//
// The filter was right and never saw them. Tether's omnichain token is branded
// **USD₮0** — U+20AE, not a T — so `NOT_A_PROJECT.has('USD₮0')` was false, and
// the site then rendered it as `$USDT` because `sanitizeTicker` strips the ₮ on
// the way in. The symbol we JUDGED and the symbol we PUBLISHED were different
// strings, which is exactly why nothing looked wrong at either end.
const test = require("node:test");
const assert = require("node:assert");
const { notAProject, NOT_A_PROJECT, _fold } = require("../src/services/bigCoins");

test("a ticker is not written in ASCII — the symbol is FOLDED before matching", () => {
  assert.strictEqual(_fold("USD₮0"), "USDT0");
  assert.strictEqual(_fold("USDC.e"), "USDCE");
  assert.strictEqual(_fold("usdt"), "USDT");
  for (const sym of ["USD₮0", "USD₮", "USDT", "usdt", "USDT.e", "USDC.e", "USDC0"]) {
    assert.ok(notAProject(sym, ""), `${sym} reached the board`);
  }
});

test("a bridged or versioned wrapper of refused money is refused too", () => {
  // USDT0 → USDT, USDCE → USDC. Bounded to a trailing digit or an E/B suffix,
  // so a real ticker that merely ends in one is untouched.
  assert.ok(notAProject("USDT0", ""));
  assert.ok(notAProject("WETH", ""));
  assert.ok(!notAProject("USDX", "Some Project"), "USDX is not USD");
  assert.ok(!notAProject("PEPE", "Pepe"));
  assert.ok(!notAProject("MOONB", "Moon Bags"), "a B suffix is not a wrapper marker on its own");
});

test("the ISSUER's name is matched, because a ticker changes and a brand does not", () => {
  assert.ok(notAProject("XYZ", "Tether USD"));
  assert.ok(notAProject("XYZ", "Bridged USDC"));
  assert.ok(notAProject("XYZ", "Binance-Peg BUSD"));
  assert.ok(notAProject("XYZ", "Wrapped Bitcoin"));
  assert.ok(notAProject("XYZ", "Staked Ether"));
  // ⚠️ The blunt edge, stated rather than hidden: a memecoin called "Tether
  // Killer" is refused too. That trade is deliberate — a false positive costs
  // one listing nobody misses, a false negative puts a $185B stablecoin on a
  // public board being sold as a find.
  assert.ok(notAProject("KILL", "Tether Killer"));
  // …but only ANCHORED, so a name that merely mentions money is fine.
  assert.ok(!notAProject("GOLD", "Digital Gold Standard"));
  assert.ok(!notAProject("BANK", "The Wrapped Cat"), "wrapped must lead, not appear");
});

test("real projects with big caps still list", () => {
  for (const [s, n] of [["LINK", "ChainLink Token"], ["TRUMP", "OFFICIAL TRUMP"], ["UNI", "Uniswap"], ["AAVE", "Aave Token"], ["CAKE", "PancakeSwap Token"]]) {
    assert.ok(!notAProject(s, n), `${s} was refused and should not be`);
  }
});

test("⚠️ a currency glyph is TRANSLITERATED, not deleted", () => {
  // The first cut stripped every non-alphanumeric, so USD₮0 folded to USD0 —
  // still not USDT, still not refused, and it would have shipped looking fixed.
  assert.strictEqual(_fold("USD₮0"), "USDT0");
  assert.strictEqual(_fold("₿TC"), "BTC");
  assert.ok(notAProject("USD₮0", ""), "the whole point of the fold");
});

test("the set itself is uppercase and ASCII — folding assumes it", () => {
  // A lowercase or accented entry would be unreachable through `fold`, which
  // is the same class of silent miss this whole fix is about.
  for (const s of NOT_A_PROJECT) {
    assert.strictEqual(s, _fold(s), `${s} can never match a folded symbol`);
  }
});

test("both seeding sources share this one judgement", () => {
  // Two ideas of "is this the money?" would eventually disagree, and the
  // disagreement would show up as a stablecoin on the board.
  const fss = require("node:fs");
  const ds = fss.readFileSync(require.resolve("../src/services/dsBigCoins.js"), "utf8");
  assert.match(ds, /require\('\.\/bigCoins'\)/);
  assert.ok(!/NOT_A_PROJECT\s*=/.test(ds), "dsBigCoins must not grow its own list");
});
