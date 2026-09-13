// THE MONEY IS NOT A PROJECT.
//
// Reported as "hapus stable coin", with the Top Coins board opening on
// `$WTRX Wrapped TRX` and carrying `$USDG Global Dollar` at rank 7. The bot has
// refused to LIST these since its market filler was written; the site never had
// the rule, so it happily ranked the ones listed before that rule existed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NOT_A_PROJECT, fold, hideFromBoard, notAProject, hiddenReport, _resetHiddenReport } from "./notAProject.ts";

test("the reported rows are refused, and the projects beside them are not", () => {
  // Straight off the screenshot, in the order it listed them.
  assert.equal(notAProject("WTRX", "Wrapped TRX"), true);
  assert.equal(notAProject("USDG", "Global Dollar"), true);
  assert.equal(notAProject("BTCB", "BTCB Token"), true);
  // …and the rest of that board is real and must stay.
  assert.equal(notAProject("SHIB", "Shiba Inu"), false);
  assert.equal(notAProject("PUMP", "Pump"), false);
  assert.equal(notAProject("LGNS", "Longinus"), false);
  assert.equal(notAProject("M21NT", "M21NT"), false);
});

test("⚠️ no substring match on USD — that would eat every stablecoin-themed memecoin", () => {
  for (const sym of ["USDUCK", "USDX", "BUSDT_INU", "MYUSD", "USDOG"])
    assert.equal(notAProject(sym, sym), false, `${sym} is a memecoin, not the money`);
});

test("⚠️ the suffix trim is BOUNDED — a memecoin whose base is money must survive", () => {
  // `USDC.e` folds to USDCE and must be refused, so a trailing `E`/`B`/digit is
  // trimmed before re-checking. Trimming ANY trailing character instead would
  // refuse `$SOLD` (base SOL), `$DAIS` (DAI), `$POLY` (POL) and `$BTCX` (BTC) —
  // four ordinary memecoin tickers deleted by a rule about stablecoins.
  //
  // ⚠️ THIS TEST EXISTS BECAUSE THE FIRST ONE FOR IT WAS VACUOUS: it used
  // `USDX`, which folds to `USD` — a string that is not in the set either way,
  // so the mutant that unbounds the trim survived it untouched.
  for (const sym of ["SOLD", "DAIS", "POLY", "BTCX"])
    assert.equal(notAProject(sym, sym), false, `$${sym} is a memecoin, not the money`);
  // …and the case the trim is FOR still works.
  assert.equal(notAProject("USDC.e", "USDC.e"), true);
  assert.equal(notAProject("USDT0", "USDT0"), true);
});

test("⚠️ a currency glyph is TRANSLITERATED, not stripped — USD₮0 is USDT", () => {
  // The bot's own scar: $USDT reached a public board at $185B because Tether
  // brands its omnichain token with U+20AE. Deleting the glyph folds it to
  // USD0 — still not refused, and the fix would have shipped looking fixed.
  assert.equal(fold("USD₮0"), "USDT0");
  assert.equal(notAProject("USD₮0", "Tether USD₮0"), true);
  assert.equal(notAProject("USDC.e", "Bridged USDC"), true, "a bridged wrapper of something refused");
  assert.equal(notAProject("₿TC", "Bitcoin"), true);
});

test("the ISSUER name is matched, because a ticker is renamed far more readily than a brand", () => {
  assert.equal(notAProject("XYZ", "Wrapped Something"), true);
  assert.equal(notAProject("XYZ", "Binance-Peg Whatever"), true);
  assert.equal(notAProject("XYZ", "Tether Gold"), true);
  // Anchored: the word has to LEAD the name, or "Doge Wrapped In Bacon" goes.
  assert.equal(notAProject("XYZ", "Doge Wrapped In Bacon"), false);
});

test("⚠️ hideFromBoard is given the DISPLAY symbol, which carries a $", () => {
  // The defect this test exists for, and the reason the tests above could not
  // catch it: they passed raw tickers — the shape the BOT sees — while the site
  // passes `BoardToken.symbol`, which is "$"-prefixed. `fold` turns `$` into an
  // S (it transliterates currency glyphs rather than stripping them, which is
  // right for `₮`), so "$WTRX" folded to "SWTRX" and every symbol rule was
  // inert. It read as working because the NAME rules still caught two of the
  // three rows on the reported board.
  //
  // ⚠️ $BTCB is the whole test: "BTCB Token" matches no name rule, so it is
  // caught by the SYMBOL or not at all.
  assert.equal(hideFromBoard({ symbol: "$BTCB", name: "BTCB Token", tier: "FREE" }), true);
  assert.equal(hideFromBoard({ symbol: "$WTRX", name: "Wrapped TRX", tier: "FREE" }), true);
  assert.equal(hideFromBoard({ symbol: "$USDG", name: "Global Dollar", tier: "FREE" }), true);
  assert.equal(hideFromBoard({ symbol: "$USDT", name: "Whatever", tier: "FREE" }), true);
  // …and a project is still a project once the prefix is off.
  assert.equal(hideFromBoard({ symbol: "$SHIB", name: "Shiba Inu", tier: "FREE" }), false);
  assert.equal(hideFromBoard({ symbol: "$PUMP", name: "Pump", tier: "FREE" }), false);
});

test("⚠️ ONLY an auto-listing is hidden — a paid listing is somebody's money", () => {
  const usdg = { symbol: "USDG", name: "Global Dollar" };
  assert.equal(hideFromBoard({ ...usdg, tier: "FREE" }), true);
  // Every other tier was bought. A project that pays to list a stablecoin gets
  // exactly what it paid for; hiding it is a refund conversation.
  for (const tier of ["DIAMOND", "GOLD", "PLATINUM", "SILVER", "BRONZE", "XPRESS"])
    assert.equal(hideFromBoard({ ...usdg, tier }), false, `${tier} is paid`);
  assert.equal(hideFromBoard({ symbol: "SHIB", name: "Shiba Inu", tier: "FREE" }), false);
});

test("⚠️ the port and the bot's list are EQUAL — two owners of one rule is worse than one", () => {
  // The bot is a separate CommonJS package this build cannot import, so the
  // list is duplicated. A duplicate that DRIFTS is worse than no duplicate at
  // all, because both copies look right: the site would rank what the bot
  // refuses to list. Same guard `market:check`'s ported chain map carries.
  const src = readFileSync(join(process.cwd(), "bot/src/services/bigCoins.js"), "utf8");
  const block = src.slice(src.indexOf("const NOT_A_PROJECT = new Set(["));
  const list = block.slice(0, block.indexOf("]);"));
  const theirs = new Set([...list.matchAll(/'([A-Z0-9]+)'/g)].map((m) => m[1]));
  assert.ok(theirs.size > 40, `only parsed ${theirs.size} symbols — the scan has stopped seeing the list`);
  assert.deepEqual([...NOT_A_PROJECT].sort(), [...theirs].sort());
});

test("⚠️ the ISSUER regex is equal too — a name rule drifts as easily as a list", () => {
  const src = readFileSync(join(process.cwd(), "bot/src/services/bigCoins.js"), "utf8");
  const m = src.match(/^const MONEY_NAME = (\/.*\/i);$/m);
  assert.ok(m, "MONEY_NAME is no longer a single-line literal — the scan cannot read it");
  const ours = readFileSync(join(process.cwd(), "src/lib/notAProject.ts"), "utf8");
  const mine = ours.match(/^\s*(\/\^\(tether.*\/i);$/m);
  assert.ok(mine, "the site's MONEY_NAME is no longer a single-line literal");
  assert.equal(mine[1], m[1]);
});

test("⚠️ filtered ONCE, in the payload — not per component", () => {
  // Patching it into each surface is how the board and the ticker end up
  // disagreeing about what is on the board. Filtering the payload makes it true
  // of the trending board, Top Coins, the movers, the heat map, the wire, the
  // chain counts and the tracked-volume figure at the same instant.
  // (Source scan: providers/index.ts imports through the "@/" alias, which this
  // runner cannot resolve.)
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const pipe = strip(readFileSync(join(process.cwd(), "src/lib/providers/index.ts"), "utf8"));
  assert.match(pipe, /const hidden = tokens\.filter\(hideFromBoard\);/);
  assert.match(pipe, /tokens = tokens\.filter\(\(t\) => !hideFromBoard\(t\)\);/);
  // Reported through the one owner, so the cadence rule cannot be re-decided
  // here — this line was itself a per-cycle flood for a whole deploy.
  assert.match(pipe, /hiddenReport\(hidden\.map\(\(t\) => t\.symbol\)\)/);
  // Before buildSignals, or the wire headline can still crown a stablecoin.
  assert.ok(
    pipe.indexOf("hideFromBoard(t)") < pipe.indexOf("buildSignals(tokens)"),
    "the filter must run before the signals are built from the list",
  );
  // A row that disappears with nothing naming a cause is the shape this repo
  // keeps having to diagnose from a screenshot.


  for (const f of ["src/components/TopCoins.tsx", "src/components/TokenBoard.tsx", "src/components/MarketMovers.tsx"])
    assert.doesNotMatch(strip(readFileSync(join(process.cwd(), f), "utf8")), /notAProject|hideFromBoard/,
      `${f} is growing a second copy of the rule`);
});

// ── Reporting it ─────────────────────────────────────────────────────────────
// ⚠️ The filter's own line was the flood it was printed next to: `[market] 2
// auto-listed stablecoin/wrapper row(s) kept off the board`, once per 60s cycle
// for ever, added in the very change that made the line beside it report on the
// transition only.
test("⚠️ the filter reports on CHANGE, not on a cadence", () => {
  _resetHiddenReport();
  const first = hiddenReport(["$WTRX", "$USDG"]);
  assert.match(String(first), /2 auto-listed/);
  assert.equal(hiddenReport(["$WTRX", "$USDG"]), null, "the same roster is not news");
  assert.equal(hiddenReport(["$USDG", "$WTRX"]), null, "…nor is it in a different order");
});

test("⚠️ it NAMES them — a count cannot say which two of three", () => {
  // "2" over three visible offenders is exactly the ambiguity that hid a dead
  // symbol rule for a whole deploy.
  _resetHiddenReport();
  const line = String(hiddenReport(["$BTCB", "$WTRX", "$USDG"]));
  for (const sym of ["$BTCB", "$WTRX", "$USDG"]) assert.ok(line.includes(sym), `${sym} is not named`);
});

test("a roster that empties is said too, and only once", () => {
  _resetHiddenReport();
  hiddenReport(["$USDG"]);
  assert.match(String(hiddenReport([])), /no auto-listed stablecoin/);
  assert.equal(hiddenReport([]), null);
});

test("a roster that GROWS is news again", () => {
  _resetHiddenReport();
  hiddenReport(["$WTRX"]);
  assert.match(String(hiddenReport(["$WTRX", "$BTCB"])), /\$BTCB/);
});

test("nothing hidden on a fresh process says nothing at all", () => {
  _resetHiddenReport();
  assert.equal(hiddenReport([]), null, "a clean board must not announce itself at boot");
});
