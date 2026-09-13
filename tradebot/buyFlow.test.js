// What a buy should tell you, in the order you want it:
//   1. going out  — how much, and at what market cap you are entering
//   2. filled     — what you spent, what you got, at what entry
//   3. then       — a live position that keeps updating itself
//
// It used to say "⏳ Buying 0.05 ETH…" and then a receipt, and the live monitor
// sat behind a 📍 button nobody taps. "At what MC did I get in" is the first
// thing anyone asks after a fill, and afterwards it can only be reconstructed.
const fs = require("node:fs");
const path = require("node:path");

const test = require("node:test");
const assert = require("node:assert");
const i18n = require("./i18n");

const TG = fs
  .readFileSync(path.join(__dirname, "telegram.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const BUY = TG.slice(TG.indexOf("async function doBuy("), TG.indexOf("const SELL_ESCALATION"));
const SINGLE = BUY.slice(BUY.indexOf("if (targets.length <= 1)"), BUY.indexOf("} else {"));

test("the 'going out' message names the market cap", () => {
  // The literals now live in i18n.js so the line can be Indonesian too; the
  // assertion follows them. What matters is unchanged — the message still names
  // the market cap being entered at, in whichever language is set.
  assert.match(SINGLE, /const atMc = eMc > 0 \? T\(chatId, 'buy\.at_mc', \{ mc: fmt\(eMc\) \}\) : '';/);
  assert.match(SINGLE, /T\(chatId, 'buy\.progress', \{ amt: esc\(amt\), native: chG\.native, atMc \}\)/);
  for (const lang of i18n.LANGS) {
    assert.match(i18n.t(lang, "buy.at_mc", { mc: "1.2K" }), /MC/, `${lang} lost the MC label`);
    assert.match(i18n.t(lang, "buy.at_mc", { mc: "1.2K" }), /1\.2K/, `${lang} dropped the market cap`);
    assert.match(i18n.t(lang, "buy.progress", { amt: "0.05", native: "ETH", atMc: "@MC" }), /0\.05/, `${lang} dropped the amount`);
    assert.match(i18n.t(lang, "buy.progress", { amt: "0.05", native: "ETH", atMc: "@MC" }), /@MC/, `${lang} dropped the MC slot`);
  }
});

test("…and going without one is never a reason to wait", () => {
  // A token with no readable price must not hold the message hostage. The line
  // goes out with a blank where the MC would be.
  assert.match(SINGLE, /Promise\.race\(\[entryP, new Promise\(\(res\) => setTimeout\(res, ENTRY_MC_WAIT_MS, null\)\)\]\)/);
  assert.match(TG, /const ENTRY_MC_WAIT_MS = 1200;/);
  assert.match(SINGLE, /const eMc = entry \? \(entry\.mcapUsd \|\| \(entry\.mcapEth \|\| 0\) \* eRate\) : 0;/);
});

test("that wait is not execution latency — the trade is already in flight", () => {
  // The whole point of the ordering work. If the snapshot were awaited BEFORE
  // core.buy, this message would have cost the user 1.2s of fill time.
  const iBuy = SINGLE.indexOf("const buying = core.buy(");
  const iSnap = SINGLE.indexOf("const entryP = withTmo(core.tokenSnapshot(");
  const iRace = SINGLE.indexOf("const entry = await Promise.race(");
  assert.ok(iBuy > -1 && iSnap > iBuy, "the snapshot starts after the buy is already going");
  assert.ok(iRace > iSnap, "and only then is anything awaited");
  assert.ok(SINGLE.indexOf("const r = await buying;") > iRace, "the fill is awaited last");
});

test("the receipt answers all three questions at once", () => {
  // Spent how much · got how many · at what entry and market cap.
  assert.match(SINGLE, /T\(chatId, 'buy\.receipt\.spent', \{ amt: spent\.toFixed\(6\), native: r\.native, usd: usd2\(spent\) \}\)/);
  assert.match(SINGLE, /T\(chatId, 'buy\.receipt\.got', \{ amt: fmt\(got\), sym: esc\(r\.sym\), usd: holdUsd \}\)/);
  // "Entry" is the price the TRADE filled at — spent ÷ received. This assertion
  // used to pin `pxUsd`, the price on the CARD, and so encoded the defect: a
  // receipt claiming entry $0.0000524 above a Monitor reading "Price $0.0000523
  // · P/L −9.48%". See entryPrice.test.js.
  assert.match(SINGLE, /T\(chatId, 'buy\.receipt\.entry', \{ px: fstat\.realPx \}\)/);
  // …and in EVERY language. A translation that quietly drops one of the numbers
  // is the same bug as a receipt that never printed it.
  for (const lang of i18n.LANGS) {
    const spent = i18n.t(lang, "buy.receipt.spent", { amt: "0.05", native: "ETH", usd: "$120" });
    for (const part of ["0.05", "ETH", "\\$120"]) assert.match(spent, new RegExp(part), `${lang} spent line dropped ${part}`);
    const got = i18n.t(lang, "buy.receipt.got", { amt: "1.2M", sym: "PEPE", usd: "$118" });
    for (const part of ["1\\.2M", "PEPE", "\\$118"]) assert.match(got, new RegExp(part), `${lang} got line dropped ${part}`);
    assert.match(i18n.t(lang, "buy.receipt.entry", { px: "0.00012" }), /0\.00012/, `${lang} entry line dropped the price`);
  }
});

test("one snapshot serves both, and it is the honest reference", () => {
  // It used to fetch a SECOND time after the fill — slower, and a market read
  // taken seconds after the trade is not the market the trade priced against.
  // It is the REFERENCE the fill is measured against, never the entry itself.
  assert.match(SINGLE, /const snap = await entryP;/);
  assert.strictEqual(
    (SINGLE.match(/core\.tokenSnapshot\(/g) || []).length,
    1,
    "exactly one snapshot call on the buy path",
  );
});

test("a filled buy opens the live position by itself", () => {
  // It already existed behind the 📍 button. Making someone tap for it after a
  // fill is asking them to do the obvious thing by hand.
  // `surface: true`: the receipt lands on top of any card already pinned for
  // this token, so reusing it in place buries the one thing the buy was about.
  assert.match(SINGLE, /startMonitor\(chatId, ca, r\.chain, wid, \{ surface: true \}\)\.catch\(\(\) => \{\}\);/);
  const iReceipt = SINGLE.indexOf("await edit(chatId, pid, receipt + note, kb)");
  // No trailing paren: the call carries options now, and pinning `wid)` made
  // this indexOf return -1 — which reads as "the monitor runs first" rather
  // than as a stale search string.
  const iMon = SINGLE.indexOf("startMonitor(chatId, ca, r.chain, wid");
  assert.ok(iMon > iReceipt, "the receipt lands first — the monitor follows it");
});

test("the monitor it opens is the live one, not a snapshot", () => {
  const start = TG.slice(TG.indexOf("async function _startMonitor("), TG.indexOf("function runMonitorLoop("));
  const loop = TG.slice(TG.indexOf("function runMonitorLoop("), TG.indexOf("function askExport("));
  assert.match(start, /pinChatMessage/, "it pins, so it stays at the top of the chat");
  // A self-rescheduling chain, not setInterval: a slow tick delays the next one
  // rather than running on top of it.
  assert.match(loop, /state\.timer = setTimeout\(tick, MON_EVERY_MS\);/, "it refreshes itself");
  assert.match(loop, /state\.closedStreak >= CLOSED_STREAK_TO_STOP/, "…and closes when the position is really gone");
});

test("a repeat buy does not stack monitors", () => {
  // Buying the same token three times must not leave three pinned trackers.
  const start = TG.slice(TG.indexOf("async function _startMonitor("), TG.indexOf("function runMonitorLoop("));
  assert.match(start, /const existing = _monitorByToken\.get\(tkey\);/);
  assert.match(start, /live\.until = Date\.now\(\) \+ MON_WINDOW_MS;/, "it refreshes the existing one and extends its window");
  const loop = TG.slice(TG.indexOf("function runMonitorLoop("), TG.indexOf("function askExport("));
  assert.match(loop, /if \(_monitors\.has\(k\)\) return;/, "…and never puts two loops on one card");
});

test("a monitor that fails to open cannot break the buy", () => {
  // The trade is done and the money has moved by then.
  assert.match(SINGLE, /startMonitor\([^)]*\)\.catch\(\(\) => \{\}\)/);
});
