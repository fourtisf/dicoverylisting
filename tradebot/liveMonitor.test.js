// "monitor live tidak otomatis dan sangat lambat."
//
// A 32-finding audit of the monitor path found both complaints had several
// independent causes. These pin the ones that produced what the user saw.
//
// NOT AUTOMATIC
//   • edit()/send() resolve with {ok:false} on a Telegram rejection — they do
//     not throw. The reuse branch's try/catch was therefore unreachable, so a
//     deleted monitor card meant startMonitor silently no-opped and returned.
//   • the multi-wallet buy never called startMonitor at all, and its receipt had
//     no 📍 button either.
//   • a failed send() was swallowed by a bare `return`, with nothing logged.
//   • the 📍 button toasted "Monitor started" without checking anything.
//
// STOPS AFTER ONE BLIP
//   • tokenBalance() returns 0n on an RPC error, and the payload read that zero
//     as "position closed" — one flaky read after a real buy unpinned the card
//     and killed the timer for good.
//   • any thrown error in the tick called stopMonitor, so one network blip ended
//     the tracker for the rest of its window.
//
// SLOW
//   • two independent network reads ran in SERIES (up to 11s a tick)
//   • the refresh was every 45s, on top of that
const fs = require("node:fs");
const path = require("node:path");

const test = require("node:test");
const assert = require("node:assert");

const RAW = fs.readFileSync(path.join(__dirname, "telegram.js"), "utf8");
const TG = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CORE = fs
  .readFileSync(path.join(__dirname, "core.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const START = TG.slice(TG.indexOf("async function _startMonitor("), TG.indexOf("function runMonitorLoop("));
// stopMonitor sits ABOVE startMonitor in the file, so slicing to it would give
// an empty string and every assertion below would vacuously pass.
const LOOP = TG.slice(TG.indexOf("function runMonitorLoop("), TG.indexOf("function askExport("));
assert.ok(LOOP.includes("const tick = async () =>"), "the loop slice is wrong — fix the markers before trusting anything below");
const PAYLOAD = TG.slice(TG.indexOf("async function monitorPayload("), TG.indexOf("const _monitorByToken"));
assert.ok(START.includes("const existing = _monitorByToken.get(tkey);") && PAYLOAD.includes("const [snap, allBals"),
  "a slice marker is stale — fix it before trusting anything below");

// ── not automatic ───────────────────────────────────────────────────────────

test("a Telegram rejection is read from the RESULT, never waited for as a throw", () => {
  // The root cause. tg() returns r.json(); fetch does not reject on 4xx, so a
  // rejected edit resolves with {ok:false} and the catch never runs.
  assert.match(TG, /function edit\(chatId, mid, text, kb\) \{ return tg\(/, "edit is a thin wrapper — it cannot throw on ok:false");
  assert.match(START, /const er = await edit\(chatId, existing, np\.text, np\.kb\);/);
  assert.match(START, /ok = !!\(er && \(er\.ok \|\| \/message is not modified\/i\.test\(er\.description \|\| ''\)\)\);/,
    "…and an unchanged body counts as success, not as a failure");
});

test("an uneditable card falls through to posting a new one", () => {
  // It used to `return` here, leaving the receipt with nothing under it.
  const i = START.indexOf("if (ok) {");
  // Search FROM the ok-branch: an explicit 📍 tap now retires the old card
  // before this point too, so the first stopMonitor in the file is no longer
  // the one this test is about.
  const j = START.indexOf("stopMonitor(chatId, existing);", i);
  assert.ok(i > -1 && j > i, "the failure path must continue past the reuse branch");
  assert.match(START.slice(j), /const r = await send\(chatId, p\.text, p\.kb\);/, "…and post a fresh monitor");
});

test("startMonitor reports whether a monitor is actually live", () => {
  // The 📍 button toasted "Monitor started" unconditionally, so every failure
  // above showed a success message and no monitor.
  const exits = START.match(/return (true|false);/g) || [];
  assert.ok(exits.includes("return false;"), `no failure exit: ${exits.join(" ")}`);
  assert.ok(exits.includes("return true;"));
  assert.match(TG, /const started = await startMonitor\(chatId, tca, ch, wid, \{ surface: true \}\)\.catch\(\(\) => false\);/);
  assert.match(TG, /started \? '📍 Monitor opened below' : '⚠️ Could not open the monitor/);
});

test("a failed send is logged, not swallowed", () => {
  assert.match(START, /console\.error\('\[monitor\] send failed'/);
  assert.match(START, /console\.error\('\[monitor\] startMonitor failed'/);
  assert.ok(!/catch \(_\) \{\}\s*\}\s*$/.test(START), "no bare swallow is left in startMonitor");
});

test("a multi-wallet buy opens a monitor and its receipt offers one", () => {
  const buy = TG.slice(TG.indexOf("async function doBuy("), TG.indexOf("const SELL_ESCALATION"));
  const multi = buy.slice(buy.indexOf("} else {"));
  // `surface: true` since the "harusnya ada monitor lgsung" report: the five
  // receipts land ON TOP of the card, so reusing it in place leaves the user
  // looking at five 📍 buttons and no position. See callbackAck.test.js.
  assert.match(multi, /if \(okN > 0\) startMonitor\(chatId, ca, chainKey, targets\[filled >= 0 \? filled : 0\]\.id, \{ surface: true \}\)/,
    "anyone trading more than one wallet used to get a fill and nothing to watch it with");
  assert.match(multi, /btn\('📍 Monitor', `monn:\$\{chainKey\}:\$\{wi\}:\$\{ca\}`\)/, "…and no button either");
  assert.ok(!/if \(okN > 0\) startMonitor[\s\S]{0,80}okN === 0/.test(multi), "sanity");
});

// ── stops after one blip ────────────────────────────────────────────────────

test("a failed balance read is distinguishable from a real zero", () => {
  // tokenBalance() collapses both to 0n. Fine for a display; wrong wherever the
  // number decides something. The monitor reads every wallet now, and
  // tokenBalancesAcross carries the same distinction per wallet: raw is null on
  // failure, never 0.
  assert.match(CORE, /async function tokenBalanceOrNull\(ca, addr, chainKey\)/);
  assert.match(CORE, /\} catch \(_\) \{ return null; \}/);
  assert.match(CORE, /async function tokenBalancesAcross\(chatId, ca, chainKey\)/);
  assert.match(CORE, /raw: await tokenBalanceOrNull\(/, "the cross-wallet read must keep null-not-zero");
  assert.match(PAYLOAD, /core\.tokenBalancesAcross\(chatId, ca, chainKey\)/);
});

test("only a CONFIRMED zero may close the position", () => {
  // "Confirmed" now means EVERY wallet with a stake answered — a partial read
  // must not close a position another wallet may still be holding.
  assert.match(PAYLOAD, /const balKnown = holders\.length > 0 && holders\.every\(\(h\) => h\.known\);/);
  assert.match(PAYLOAD, /if \(noPosition \|\| \(balKnown && !\(balNow > 0\)\)\) \{/,
    "an unread balance must not read as closed");
  assert.match(PAYLOAD, /Balance unavailable right now — retrying/, "…and it says so rather than lying");
});

test("the recorded position is a real fallback now, not dead code", () => {
  // The branch existed before but could never run: the failure it was written
  // for arrived as 0n, which took the other path. It is now per wallet.
  // The recorded size is now decoded ONCE per wallet, up front, because the
  // reconciliation against the live balance needs it too — so the fallback
  // branch tests the decoded number rather than re-parsing the raw field.
  assert.match(PAYLOAD, /\} else if \(recorded > 0\) \{/);
  assert.match(PAYLOAD, /tokens = recorded; stale = true;/);
  assert.match(PAYLOAD, /BigInt\(p\.tokens\)/);
  // And the rows themselves come from the WALLET LIST, not from the read — a
  // read that throws returns [] , and deriving rows from it wiped the cost basis
  // and closed the position, which is the very failure this file exists for.
  assert.match(PAYLOAD, /core\.walletList\(u\)\.forEach\(\(wal, i\) => \{/,
    "rows must not be derived from the thing that fails");
});

test("it takes TWO closed readings to stop — one RPC is not evidence", () => {
  assert.match(TG, /const CLOSED_STREAK_TO_STOP = 2;/);
  assert.match(LOOP, /state\.closedStreak = np\.closed \? state\.closedStreak \+ 1 : 0;/, "a good read resets the streak");
  assert.match(LOOP, /if \(state\.closedStreak >= CLOSED_STREAK_TO_STOP\) return finish\(true\);/);
});

test("a transient error never ends the monitor; a permanent one does", () => {
  // The old tick called stopMonitor from its catch, so one blip killed the
  // tracker for the rest of its window.
  const tickCatch = LOOP.slice(LOOP.indexOf("} catch (e) {"), LOOP.indexOf("if (!state.stopped) state.timer"));
  assert.ok(!/finish\(|stopMonitor/.test(tickCatch), `a thrown tick must not stop the loop: ${tickCatch}`);
  assert.match(tickCatch, /console\.error\('\[monitor\] tick failed'/);
  assert.match(LOOP, /if \(er && er\.ok === false && MON_FATAL_TG\.test\(er\.description \|\| ''\)\) return finish\(false\);/);
  assert.match(TG, /message to edit not found\|message can't be edited/, "only a gone message is fatal");
});

test("the loop reschedules itself instead of stacking", () => {
  // setInterval let a slow tick overlap the next one, two renders racing on the
  // same message.
  assert.ok(!/setInterval/.test(LOOP), "no interval may drive the monitor");
  assert.match(LOOP, /state\.timer = setTimeout\(tick, MON_EVERY_MS\);/);
  assert.match(LOOP, /if \(_monitors\.has\(k\)\) return;/, "and never two loops on one card");
});

test("an expired window pauses the card instead of leaving it claiming to be live", () => {
  assert.match(LOOP, /⏸ Paused · last updated/);
  assert.match(TG, /🔄 Updates automatically · last updated/, "the live wording is what it replaces");
});

test("stopMonitor cannot reach into another chat", () => {
  const stop = TG.slice(TG.indexOf("function stopMonitor("), TG.indexOf("function stopMonitor(") + 700);
  assert.match(stop, /tk\.startsWith\(prefix\)/, "matching on message id alone deleted other chats' entries");
});

// ── slow ────────────────────────────────────────────────────────────────────

test("every network read the card needs runs in PARALLEL", () => {
  // They are independent, and in series a slow chain paid every timeout back to
  // back — up to 11s on a card whose whole job is to feel live. The socials
  // lookup joined them later and must not be awaited on its own either.
  assert.match(PAYLOAD, /const \[snap, allBals[^\]]*\] = await Promise\.all\(\[/);
  assert.ok(!/\]\);[\s\S]{0,600}await withTmo\(tokeninfo\.socials/.test(PAYLOAD),
    "the socials lookup was moved out of the parallel batch");
  assert.ok(!/await withTmo\(core\.tokenSnapshot[\s\S]{0,400}await withTmo\(core\.tokenBalance/.test(PAYLOAD),
    "no serial pair may return");
});

test("the refresh is seconds, not most of a minute", () => {
  assert.match(TG, /const MON_EVERY_MS = Math\.max\(5000, Number\(process\.env\.MONITOR_REFRESH_MS \|\| 10000\)\);/);
  // 45s + up to 11s of serial reads put the median data age near 24s and the
  // worst case near two minutes.
  const every = 10000;
  const worstRead = 6000;
  assert.ok(every + worstRead < 20000, "worst-case data age must stay under 20s");
});

test("the window is long enough to be worth pinning, and a re-buy extends it", () => {
  assert.match(TG, /const MON_WINDOW_MS = Math\.max\(60000, Number\(process\.env\.MONITOR_WINDOW_MS \|\| 60 \* 60 \* 1000\)\);/);
  assert.match(START, /live\.until = Date\.now\(\) \+ MON_WINDOW_MS;/, "a fresh buy deserves a fresh window");
});

test("a reused card follows the wallet and chain of the buy that reused it", () => {
  // The interval closed over the FIRST call's chain and wallet, so a re-buy on
  // another wallet rewrote the same card with numbers from the old one.
  assert.match(START, /live\.chainKey = chainKey; live\.wid = wid;/);
  assert.match(LOOP, /monitorPayload\(chatId, ca, state\.chainKey, state\.wid\)/, "the tick reads the live state, not a closure");
});

test("the timestamp changes every tick", () => {
  // At minute resolution ~25% of refreshes produced byte-identical text, which
  // Telegram rejects as "message is not modified" — the card visibly froze.
  assert.match(PAYLOAD, /toISOString\(\)\.slice\(11, 19\)/);
});

// ── surviving a restart ─────────────────────────────────────────────────────
// Added after a runtime audit: every source assertion above passes on code that
// still loses every monitor on `pm2 restart`, because the registry was a Map.
// liveMonitorRuntime.test.js exercises these for real; these pin the wiring.

test("the registry is on disk, so a deploy does not orphan every pinned card", () => {
  assert.match(CORE, /function monitorSave\(key, rec\) \{ monitorsAll\(\)\[key\] = rec; saveStoreNow\(\); \}/,
    "written through — the restart it guards can come at any moment");
  assert.match(CORE, /DB\.monitors = \(parsed && parsed\.monitors\) \|\| \{\};/, "…and read back at boot");
  assert.match(TG, /core\.monitorSave\(tkey, \{ mid, ca, chainKey, wid, until: state\.until \}\);/);
  assert.match(TG, /_monitorByToken\.delete\(tk\); core\.monitorDrop\(tk\);/, "a stopped monitor leaves no record behind");
});

test("boot adopts the cards still in their window and retires the rest", () => {
  const fn = TG.slice(TG.indexOf("async function resumeMonitors("), TG.indexOf("function askExport("));
  assert.match(fn, /adoptMonitor\(chatId, rec\.ca, rec\.chainKey, rec\.wid, rec\.mid, Number\(rec\.until\)\)/);
  assert.match(fn, /⏸ Paused · last updated/, "an expired card is signed off, not left claiming to be live");
  assert.match(fn, /unpinChatMessage/);
  assert.match(TG, /resumeMonitors\(\)\.catch\(/, "and it runs at boot");
  const boot = TG.slice(TG.indexOf("async function start()"));
  assert.ok(boot.indexOf("resumeMonitors()") < boot.indexOf("let offset = 0;"), "before the first update is polled");
});

test("two starts on one token cannot post two pinned cards", () => {
  // _monitorByToken is written AFTER an await, so concurrent callers both saw an
  // empty map. A buy finishing while the user taps 📍 is exactly that race.
  assert.match(TG, /const _monitorStarting = new Map\(\);/);
  assert.match(TG, /running\s*\?\s*running\.catch\(\(\) => \{\}\)\.then\(\(\) => _startMonitor\(chatId, ca, chainKey, wid, opts\)\)/,
    "the second caller queues behind the first and then takes the reuse path");
  assert.match(TG, /_monitorStarting\.delete\(tkey\)/, "…and the guard is always released");
});

test("🔄 Refresh revives an undriven card instead of updating it once", () => {
  const h = TG.slice(TG.indexOf("if (k === 'mon') {"));
  const body = h.slice(0, h.indexOf("if (k === 'monn')"));
  assert.match(body, /if \(er && er\.ok && !p2\.closed\) adoptMonitor\(chatId, tca, ch, wid, mid\);/);
  assert.match(TG, /function adoptMonitor\(chatId, ca, chainKey, wid, mid, until\)/);
  assert.match(TG, /if \(_monitors\.has\(chatId \+ ':' \+ mid\)\) return true;/, "idempotent — no second loop on a live card");
});

test("a fallback bag is labelled, and a missing USD feed does not blank a known price", () => {
  assert.match(PAYLOAD, /balStale \? ' <i>\(last known — chain unreachable\)<\/i>' : ''/,
    "a recorded bag rendered identically to a live read");
  assert.match(PAYLOAD, /snap\.mcapEth > 0 \? fmt\(snap\.mcapEth\) \+ ' ' \+ nat : '—'/,
    "the card knows the market cap in native units — printing — is it looking broken over a problem it does not have");
});

// ── every wallet, not just one ───────────────────────────────────────────────

test("the card reads EVERY wallet, because a multi-wallet buy fills several", () => {
  // A 4-wallet buy filled three of them and the card showed one, so the P/L on
  // screen was a third of the position actually held, with no hint the rest
  // existed.
  assert.match(PAYLOAD, /core\.tokenBalancesAcross\(chatId, ca, chainKey\)/, "the card still reads one wallet");
  assert.match(PAYLOAD, /const balNow = holders\.reduce\(/, "the held total must span wallets");
  assert.match(PAYLOAD, /const cost = holders\.reduce\(/, "the invested total must span wallets");
  assert.match(PAYLOAD, /💳 <b>Per wallet<\/b>/, "there is no per-wallet breakdown");
});

test("the header names the wallet the SELL buttons act on, never the count", () => {
  // tradeTargets() sends a sell to the card's wallet (or the user's trade
  // selection) — never to every wallet listed. A header reading "3 wallets" over
  // a "Sell 100%" button invites selling a third of a position believing it is
  // all of it.
  assert.match(PAYLOAD, /💳 \$\{esc\(core\.walletLabel\(w, wi\)\)\}/, "the header must name the bound wallet");
  assert.ok(!/💳 \$\{esc\(who\)\}/.test(PAYLOAD), "the header must not be the wallet COUNT");
  assert.match(PAYLOAD, /Sell acts here/, "the breakdown must mark which row the buttons touch");
});

test("a long wallet list is truncated out loud, never silently", () => {
  // Dropping wallets from the card reads as not owning them.
  assert.match(PAYLOAD, /holders\.slice\(0, MON_WALLET_ROWS\)/);
  assert.match(PAYLOAD, /and \$\{holders\.length - MON_WALLET_ROWS\} more/);
});
