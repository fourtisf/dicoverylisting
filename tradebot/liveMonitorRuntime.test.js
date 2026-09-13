// The other monitor tests read the SOURCE. That proves the right text is in the
// file, not that a monitor ever refreshes. This one RUNS it: real startMonitor,
// real runMonitorLoop, real monitorPayload, with only the two edges stubbed —
// Telegram (globalThis.fetch) and the two network reads on core.
//
// Everything below is a behaviour the user reported or that a stubbed-out unit
// test would have missed.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-monrt-"));
process.env.TRADEBOT_TOKEN = process.env.TRADEBOT_TOKEN || "test:token";
process.env.WALLET_SECRET = process.env.WALLET_SECRET || "0123456789abcdef0123456789abcdef";

const _test = require("node:test");

// Node's mock.timers gained the { apis } OPTIONS OBJECT and Date support in
// v20.4. On v18 `enable` takes a bare array and cannot mock Date at all, so
// every test in this file dies with
//   The "timers" argument must be an instance of Array. Received an instance of Object
// — nineteen red lines that say nothing about the bot, on a server running
// v18.19.1 while package.json claimed ">=18" was enough. A test suite that
// cannot run is worse than one that admits it: this SKIPS with the reason, so
// `npm test` stays a usable deploy gate on the Node the box actually has.
const [NODE_MAJ, NODE_MIN] = process.versions.node.split(".").map(Number);
const MOCK_TIMERS_OK = NODE_MAJ > 20 || (NODE_MAJ === 20 && NODE_MIN >= 4);
const SKIP = MOCK_TIMERS_OK
  ? false
  : `needs Node >= 20.4 for mock.timers({ apis, Date }) — this is v${process.versions.node}`;
const test = (name, fn) => _test(name, { skip: SKIP }, fn);
const assert = require("node:assert");

const core = require("./core");
const { _test: T } = require("./telegram");

const CA = "0x1111111111111111111111111111111111111111";
const CHAIN = "ethereum";

// ── the two stubbed edges ───────────────────────────────────────────────────

/** Every Telegram call the code makes, in order. `reply` decides what comes back. */
let tgCalls = [];
let reply = () => ({ ok: true, result: { message_id: 1 } });
globalThis.fetch = async (url, init) => {
  const method = String(url).split("/").pop();
  const body = JSON.parse(init.body);
  tgCalls.push({ method, body });
  const r = reply(method, body, tgCalls.length) || { ok: true, result: { message_id: 1 } };
  return { json: async () => r };
};
const calls = (m) => tgCalls.filter((c) => c.method === m);

/** core's network reads. `null` means "could not read" — never "holds nothing".
 *  The monitor reads EVERY wallet now (tokenBalancesAcross), so that is the edge
 *  to stub; `balance` stays the single knob every test below turns, and applies
 *  to each wallet. tokenBalanceOrNull is stubbed too because other screens still
 *  call it, and a real one here would reach the network mid-test. */
let snapshot = { sym: "TEST", priceEth: 2, mcapEth: 1000 };
let balance = 10n ** 18n;
const _bal = () => (typeof balance === "function" ? balance() : balance);
core.tokenSnapshot = async () => (typeof snapshot === "function" ? snapshot() : snapshot);
core.tokenBalanceOrNull = async () => _bal();
// The supply read is a network edge too — unstubbed it hangs under mocked
// timers (withTmo's timeout never fires) and every test here dies with
// "Promise resolution is still pending". null = supply unknown, the default.
let supplyUi = null;
core.tokenSupplyUi = async () => (typeof supplyUi === "function" ? supplyUi() : supplyUi);
core.tokenBalancesAcross = async (chatId) => {
  const u = core.DB.users[chatId] || {};
  return (u.wallets || []).map((w, i) => ({ id: w.id, index: i + 1, label: w.name || `Wallet ${i + 1}`, raw: _bal() }));
};

/** A user holding a position that cost 0.5 ETH, so PnL has something to say. */
function seed(chatId) {
  const u = (core.DB.users[chatId] = {
    chatId,
    wallets: [
      { id: "wA", name: "A", address: "0x" + "a".repeat(40), positions: {}, orders: [] },
      { id: "wB", name: "B", address: "0x" + "b".repeat(40), positions: {}, orders: [] },
    ],
    activeWalletId: "wA",
  });
  for (const w of u.wallets) w.positions[core.posKey(CHAIN, CA)] = { sym: "TEST", dec: 18, costEth: 0.5, tokens: (10n ** 18n).toString() };
  return u;
}

/** Reset every piece of shared state between tests — these are module-level Maps
 *  in telegram.js, so a leak here would make later tests pass on stale entries. */
function reset(chatId) {
  tgCalls = [];
  reply = () => ({ ok: true, result: { message_id: 1 } });
  snapshot = { sym: "TEST", priceEth: 2, mcapEth: 1000 };
  balance = 10n ** 18n;
  supplyUi = null;
  for (const k of [...T._monitors.keys()]) T.stopMonitor(Number(k.split(":")[0]), Number(k.split(":")[1]));
  T._monitors.clear();
  T._monitorByToken.clear();
  seed(chatId);
}

// ── driving the clock ───────────────────────────────────────────────────────
// The loop is a setTimeout chain whose callback is async, so ticking the clock
// only STARTS a refresh. Each tick is followed by real microtask/IO drains so
// the tick body runs to completion and registers the next timer.
const drain = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
async function advance(t, n = 1) {
  for (let i = 0; i < n; i++) { t.mock.timers.tick(T.MON_EVERY_MS); await drain(); }
}
function fakeClock(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  return drain();
}

// ── it actually refreshes ───────────────────────────────────────────────────

test("a started monitor keeps editing its own card, unprompted", async (t) => {
  reset(101);
  await fakeClock(t);
  reply = (m) => (m === "sendMessage" ? { ok: true, result: { message_id: 77 } } : { ok: true, result: {} });

  assert.strictEqual(await T.startMonitor(101, CA, CHAIN, "wA"), true);
  assert.strictEqual(calls("sendMessage").length, 1, "it posts the card");
  assert.strictEqual(calls("pinChatMessage").length, 1, "…and pins it");
  assert.strictEqual(calls("editMessageText").length, 0, "nothing has refreshed yet");

  await advance(t, 3);
  const edits = calls("editMessageText");
  assert.strictEqual(edits.length, 3, `three periods → three refreshes, got ${edits.length}`);
  assert.strictEqual(edits[0].body.message_id, 77, "it edits the card it posted");
  assert.match(edits[0].body.text, /Live position — \$TEST/);
  assert.match(edits[0].body.text, /Profit\/Loss:<\/b> \+300\.00%/, "0.5 ETH in, 1 token worth 2 ETH");
});

test("the refresh period is the one advertised, not a longer one", async (t) => {
  reset(102);
  await fakeClock(t);
  await T.startMonitor(102, CA, CHAIN, "wA");
  t.mock.timers.tick(T.MON_EVERY_MS - 1); await drain();
  assert.strictEqual(calls("editMessageText").length, 0, "not before the period is up");
  t.mock.timers.tick(1); await drain();
  assert.strictEqual(calls("editMessageText").length, 1, "and exactly on it");
  assert.ok(T.MON_EVERY_MS <= 10000, `${T.MON_EVERY_MS}ms is not "live"`);
});

// ── it survives what killed it before ───────────────────────────────────────

test("one unreadable balance does not close a position that is still open", async (t) => {
  // The self-destruct: tokenBalance() returned 0n on an RPC error and the card
  // read that as "sold". One blip after a real buy unpinned and stopped it.
  reset(103);
  await fakeClock(t);
  await T.startMonitor(103, CA, CHAIN, "wA");

  balance = null;                       // the RPC fails
  await advance(t, 1);
  const t1 = calls("editMessageText").at(-1).body.text;
  assert.match(t1, /last known — chain unreachable/, "it falls back to the recorded bag, and says that is what it is");
  assert.doesNotMatch(t1, /No open position/, "…rather than declaring the bag gone");
  assert.strictEqual(calls("unpinChatMessage").length, 0, "and it stays pinned");
  assert.strictEqual(T._monitors.size, 1, "and alive");

  balance = 10n ** 18n;                 // the RPC recovers
  await advance(t, 1);
  assert.match(calls("editMessageText").at(-1).body.text, /Profit\/Loss/, "it comes straight back");
  assert.strictEqual(T._monitors.size, 1);
});

test("a real sale closes it — but only after two readings agree", async (t) => {
  reset(104);
  await fakeClock(t);
  await T.startMonitor(104, CA, CHAIN, "wA");

  balance = 0n;                         // genuinely sold
  await advance(t, 1);
  assert.strictEqual(T._monitors.size, 1, "one reading is not evidence");
  assert.match(calls("editMessageText").at(-1).body.text, /No open position/);
  await advance(t, 1);
  assert.strictEqual(T._monitors.size, 0, "the second one is");
  assert.strictEqual(calls("unpinChatMessage").length, 1, "and it unpins itself");
});

test("a zero that turns out to be a blip resets the streak", async (t) => {
  reset(105);
  await fakeClock(t);
  await T.startMonitor(105, CA, CHAIN, "wA");
  balance = 0n;   await advance(t, 1);
  balance = 10n ** 18n; await advance(t, 1);
  balance = 0n;   await advance(t, 1);
  assert.strictEqual(T._monitors.size, 1, "one closed reading either side of a good one must not add up to two");
});

test("a thrown read does not end the monitor", async (t) => {
  // The old tick called stopMonitor from its catch: one blip ended the tracker
  // for the rest of its window.
  reset(106);
  await fakeClock(t);
  await T.startMonitor(106, CA, CHAIN, "wA");
  const boom = () => { throw new Error("RPC exploded"); };
  snapshot = boom; balance = boom;
  await advance(t, 2);
  assert.strictEqual(T._monitors.size, 1, "still running");
  snapshot = { sym: "TEST", priceEth: 2, mcapEth: 1000 }; balance = 10n ** 18n;
  await advance(t, 1);
  assert.match(calls("editMessageText").at(-1).body.text, /Profit\/Loss/, "and it recovers on its own");
});

test("a Telegram 429 does not end the monitor; a deleted message does", async (t) => {
  reset(107);
  await fakeClock(t);
  await T.startMonitor(107, CA, CHAIN, "wA");

  reply = (m) => (m === "editMessageText" ? { ok: false, error_code: 429, description: "Too Many Requests: retry after 3" } : { ok: true, result: {} });
  await advance(t, 2);
  assert.strictEqual(T._monitors.size, 1, "a rate limit is transient");

  reply = (m) => (m === "editMessageText" ? { ok: false, error_code: 400, description: "Bad Request: message to edit not found" } : { ok: true, result: {} });
  await advance(t, 1);
  assert.strictEqual(T._monitors.size, 0, "a gone message is not");
});

// ── opening it ──────────────────────────────────────────────────────────────

test("an uneditable existing card is replaced, and the answer is still true", async (t) => {
  // The {ok:false}-never-throws bug: startMonitor used to return as if it had
  // refreshed, leaving the receipt with nothing under it.
  reset(108);
  await fakeClock(t);
  let mid = 200;
  reply = (m) => (m === "sendMessage" ? { ok: true, result: { message_id: ++mid } } : { ok: true, result: {} });
  await T.startMonitor(108, CA, CHAIN, "wA");
  assert.strictEqual(calls("sendMessage").length, 1);

  // the user deleted the card
  reply = (m) => (m === "editMessageText" ? { ok: false, description: "Bad Request: message to edit not found" }
    : m === "sendMessage" ? { ok: true, result: { message_id: ++mid } } : { ok: true, result: {} });
  assert.strictEqual(await T.startMonitor(108, CA, CHAIN, "wA"), true, "it must not report success without a monitor");
  assert.strictEqual(calls("sendMessage").length, 2, "a fresh card is posted");
  assert.strictEqual(T._monitors.size, 1, "exactly one loop is running");

  reply = () => ({ ok: true, result: {} });
  await advance(t, 1);
  assert.strictEqual(calls("editMessageText").at(-1).body.message_id, 202, "and it drives the NEW card");
});

test("startMonitor returns false when Telegram will not accept the card", async (t) => {
  reset(109);
  await fakeClock(t);
  reply = () => ({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
  assert.strictEqual(await T.startMonitor(109, CA, CHAIN, "wA"), false);
  assert.strictEqual(T._monitors.size, 0, "and leaves nothing running");
});

test("an unchanged body counts as a refresh, not as a dead card", async (t) => {
  reset(110);
  await fakeClock(t);
  await T.startMonitor(110, CA, CHAIN, "wA");
  reply = (m) => (m === "editMessageText" ? { ok: false, description: "Bad Request: message is not modified" } : { ok: true, result: { message_id: 300 } });
  assert.strictEqual(await T.startMonitor(110, CA, CHAIN, "wA"), true);
  assert.strictEqual(calls("sendMessage").length, 1, "it must not post a duplicate card over an identical one");
});

test("buying the same token again reuses one card and re-points it", async (t) => {
  reset(111);
  await fakeClock(t);
  await T.startMonitor(111, CA, CHAIN, "wA");
  const before = T._monitors.get([...T._monitors.keys()][0]).until;

  t.mock.timers.tick(60000); await drain();          // an hour of the window burnt
  assert.strictEqual(await T.startMonitor(111, CA, CHAIN, "wB"), true);
  assert.strictEqual(calls("sendMessage").length, 1, "no second card");
  assert.strictEqual(T._monitors.size, 1, "no second loop");
  const st = T._monitors.get([...T._monitors.keys()][0]);
  assert.ok(st.until > before, "the window is extended by the new buy");
  assert.strictEqual(st.wid, "wB", "and follows the wallet that bought");

  await advance(t, 1);
  assert.match(calls("editMessageText").at(-1).body.text, /💳 B/, "the card shows the new wallet, not the first one");
});

test("the window expires into a paused card, not a frozen live one", async (t) => {
  reset(112);
  await fakeClock(t);
  await T.startMonitor(112, CA, CHAIN, "wA");
  await advance(t, 1);
  assert.match(calls("editMessageText").at(-1).body.text, /🔄 Updates automatically/);

  t.mock.timers.tick(T.MON_WINDOW_MS + T.MON_EVERY_MS); await drain();
  const last = calls("editMessageText").at(-1).body.text;
  assert.match(last, /⏸ Paused · last updated/, "it signs off");
  assert.doesNotMatch(last, /Updates automatically/);
  assert.strictEqual(calls("unpinChatMessage").length, 1, "and unpins");
  assert.strictEqual(T._monitors.size, 0);
});

test("stopping one chat's monitor leaves another chat's alone", async (t) => {
  reset(113); seed(114);
  await fakeClock(t);
  reply = () => ({ ok: true, result: { message_id: 42 } });   // SAME id in both chats
  await T.startMonitor(113, CA, CHAIN, "wA");
  await T.startMonitor(114, CA, CHAIN, "wA");
  assert.strictEqual(T._monitorByToken.size, 2);
  T.stopMonitor(113, 42);
  assert.strictEqual(T._monitorByToken.size, 1, "matching on message id alone wiped both");
  assert.ok(T._monitorByToken.has("114:" + CA.toLowerCase()));
  T.stopMonitor(114, 42);
});

test("a stopped monitor stops ticking for good", async (t) => {
  reset(115);
  await fakeClock(t);
  await T.startMonitor(115, CA, CHAIN, "wA");
  await advance(t, 1);
  const n = calls("editMessageText").length;
  T.stopMonitor(115, 1);
  await advance(t, 3);
  assert.strictEqual(calls("editMessageText").length, n, "a stopped loop must not keep editing");
});

// ── content ─────────────────────────────────────────────────────────────────

test("every refresh differs, so Telegram never rejects one as unmodified", async (t) => {
  // At minute resolution ~25% of refreshes were byte-identical and the card
  // visibly froze. This is what the seconds-resolution stamp is for.
  reset(116);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  await drain();
  await T.startMonitor(116, CA, CHAIN, "wA");
  await advance(t, 3);
  const texts = calls("editMessageText").map((c) => c.body.text);
  assert.strictEqual(new Set(texts).size, texts.length, `identical bodies would be rejected:\n${texts.join("\n---\n")}`);
});

test("a monitor with no price still renders and still refreshes", async (t) => {
  reset(117);
  await fakeClock(t);
  snapshot = null;                       // no indexer coverage — common on Robinhood
  assert.strictEqual(await T.startMonitor(117, CA, CHAIN, "wA"), true);
  await advance(t, 1);
  const txt = calls("editMessageText").at(-1).body.text;
  assert.match(txt, /You hold:/, "the bag is still shown");
  assert.match(txt, /Now worth:.*—/, "the value it cannot know is blank, not zero");
  assert.strictEqual(T._monitors.size, 1);
});

test("the bag's share of supply is on the card — and an unknown supply is silence, not 0%", async (t) => {
  reset(118);
  await fakeClock(t);
  // Two wallets holding 1.0 each of a 100-token supply → 2.00% of supply.
  supplyUi = 100;
  assert.strictEqual(await T.startMonitor(118, CA, CHAIN, "wA"), true);
  await advance(t, 1);
  const txt = calls("editMessageText").at(-1).body.text;
  assert.match(txt, /2\.00%<\/b> of supply/, "the share the user asked for is missing");
});

test("an unknown supply is silence, not 0%", async (t) => {
  // "0.00% of supply" under an unreadable supply would be a stated fact that
  // is false — the phrase must not appear at all.
  reset(119);
  await fakeClock(t);
  assert.strictEqual(await T.startMonitor(119, CA, CHAIN, "wA"), true);
  await advance(t, 1);
  const txt = calls("editMessageText").at(-1).body.text;
  assert.ok(!/of supply/.test(txt), "an unknown supply was rendered as a share");
});

// ── the gaps the source-level audit could not see ───────────────────────────

test("a restart adopts the pinned cards instead of orphaning them", async (t) => {
  reset(120);
  await fakeClock(t);
  reply = (m) => (m === "sendMessage" ? { ok: true, result: { message_id: 555 } } : { ok: true, result: {} });
  await T.startMonitor(120, CA, CHAIN, "wA");

  // What pm2 does on every deploy: the process dies, the pinned card does not.
  T._monitors.clear(); T._monitorByToken.clear();
  await T.resumeMonitors();
  await advance(t, 2);
  const drove = calls("editMessageText").filter((c) => c.body.message_id === 555);
  assert.ok(drove.length >= 2, `the surviving card must keep refreshing, got ${drove.length} edits`);
  assert.strictEqual(calls("sendMessage").length, 1, "and no duplicate card is posted");
});

test("two starts racing produce one card, not two", async (t) => {
  // A 📍 tap while a buy is finishing. _monitorByToken is set AFTER an await, so
  // both callers saw an empty map and both posted.
  reset(121);
  await fakeClock(t);
  let mid = 600;
  reply = (m) => (m === "sendMessage" ? { ok: true, result: { message_id: ++mid } } : { ok: true, result: {} });
  await Promise.all([T.startMonitor(121, CA, CHAIN, "wA"), T.startMonitor(121, CA, CHAIN, "wA")]);
  assert.strictEqual(calls("sendMessage").length, 1, "two pinned cards for one token");
  assert.strictEqual(T._monitors.size, 1, "…each with its own loop, both editing");
});

test("🔄 Refresh revives a card nothing is driving", async (t) => {
  reset(122);
  await fakeClock(t);
  reply = (m) => (m === "sendMessage" ? { ok: true, result: { message_id: 700 } } : { ok: true, result: {} });
  await T.startMonitor(122, CA, CHAIN, "wA");
  T._monitors.clear(); T._monitorByToken.clear();          // undriven, e.g. after a restart

  await T.adoptMonitor(122, CA, CHAIN, "wA", 700);
  await advance(t, 2);
  assert.ok(calls("editMessageText").filter((c) => c.body.message_id === 700).length >= 2,
    "a manual refresh on a dead card must restart it, not update it once");
});
