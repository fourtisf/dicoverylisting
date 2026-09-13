// Nothing told anyone when the bot stopped working. PM2 restarts a crash, but
// the expensive failures are quiet: a wedged poller with the process still
// "online", Mongo gone, an order that took payment and stalled. The first
// notification was a customer complaining.
//
// These tests drive the monitor's real check pass with a fake clock, because
// every decision it makes is about TIME — how long a fault has lasted, and
// whether today's heartbeat already went out.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-health-"));

const test = require("node:test");
const assert = require("node:assert");

const log = require("../src/helpers/logger");
const orders = require("../src/payments/orders");
const health = require("../src/services/healthMonitor");

const MIN = 60 * 1000;

/** Records what the ERROR channel would receive, and resets the monitor. */
function harness({ telegramOk = true, boots = [], heartbeatDate = "2026-07-26" } = {}) {
  const sent = [];
  log._resetDedupe();
  log.attach(
    { telegram: { sendMessage: async (chat, text) => (chat === "@errors" ? sent.push(text) : null) } },
    "@visitors",
    "@errors",
  );
  health._test.faults.clear();
  health._test.setState({ boots: boots.slice(), lastHeartbeatDate: heartbeatDate });
  health._test.setStartedAt(Date.parse("2026-07-26T00:00:00Z"));
  const tg = { getMe: async () => { if (!telegramOk) throw new Error("connect ETIMEDOUT 149.154.167.220:443"); return { username: "dexvrabot" }; } };
  return { sent, tg };
}
/** Wipes the order store between cases (it is module-level state). */
async function setOrders(list) {
  // The store is module-level and shared across cases. Age the leftovers out of
  // every window the monitor looks at, so one test's fixtures cannot show up in
  // another's counts.
  for (const o of orders.allOrders()) await orders.setStatus(o.id, "wiped", { createdAt: 0, updatedAt: 0 });
  for (const o of list) await orders.saveOrder(o);
}

const T0 = Date.parse("2026-07-26T00:30:00Z"); // before the heartbeat hour

test("a fault must LAST before it wakes anyone", async () => {
  // The lesson the sibling bot paid for: Atlas reaps idle sockets, so a bare
  // "disconnected" event paged daily for something that healed in seconds. A
  // monitor that cries wolf gets muted, and a muted monitor is worse than none.
  const { sent, tg } = harness({ telegramOk: false });
  await setOrders([]);
  await health._test.runOnce(tg, T0);
  assert.strictEqual(sent.length, 0, "first bad check is not yet news");
  await health._test.runOnce(tg, T0 + 2 * MIN);
  assert.strictEqual(sent.length, 0, "still inside the grace period");
  await health._test.runOnce(tg, T0 + 4 * MIN);
  assert.strictEqual(sent.length, 1, `past the grace, it pages:\n${sent.join("\n")}`);
  assert.match(sent[0], /Cannot reach Telegram/);
  assert.match(sent[0], /ETIMEDOUT/, "and quotes the real error, not a generic one");
});

test("it pages ONCE per outage, not once per minute", async () => {
  const { sent, tg } = harness({ telegramOk: false });
  await setOrders([]);
  for (let i = 0; i <= 30; i++) await health._test.runOnce(tg, T0 + i * MIN);
  assert.strictEqual(sent.length, 1, `half an hour of outage is one message, got ${sent.length}`);
});

test("recovery is reported too — silence after a page is ambiguous", async () => {
  const { sent } = harness({ telegramOk: false });
  await setOrders([]);
  let up = false;
  const tg = { getMe: async () => { if (!up) throw new Error("ETIMEDOUT"); return {}; } };
  await health._test.runOnce(tg, T0);
  await health._test.runOnce(tg, T0 + 5 * MIN);
  assert.strictEqual(sent.length, 1);
  up = true;
  await health._test.runOnce(tg, T0 + 12 * MIN);
  assert.strictEqual(sent.length, 2);
  assert.match(sent[1], /✅ <b>Telegram reachable again<\/b> — after ~12 min/, sent[1]);
});

test("a fault that heals inside its grace is never mentioned at all", async () => {
  const { sent } = harness();
  await setOrders([]);
  let up = false;
  const tg = { getMe: async () => { if (!up) throw new Error("blip"); return {}; } };
  await health._test.runOnce(tg, T0);
  up = true;
  await health._test.runOnce(tg, T0 + MIN);
  assert.deepStrictEqual(sent, [], "a 60-second blip is not an incident");
});

test("an order that took money and stalled is the alert that matters most", async () => {
  const { sent, tg } = harness();
  await setOrders([
    { id: "ord_paid_old", status: "paid", kind: "listing", createdAt: T0 - 60 * MIN, updatedAt: T0 - 40 * MIN },
    { id: "ord_paid_new", status: "paid", kind: "listing", createdAt: T0 - 2 * MIN, updatedAt: T0 - 2 * MIN },
    { id: "ord_done", status: "fulfilled", createdAt: T0 - 90 * MIN, updatedAt: T0 - 89 * MIN },
  ]);
  await health._test.runOnce(tg, T0);
  assert.strictEqual(sent.length, 1, sent.join("\n"));
  assert.match(sent[0], /1 paid order not fulfilled/, sent[0]);
  assert.match(sent[0], /ord_paid_old/);
  assert.ok(!sent[0].includes("ord_paid_new"), "an order 2 minutes old is still being worked on");
  assert.ok(!sent[0].includes("ord_done"), "a fulfilled order is not stuck");
  assert.match(sent[0], /paid and received nothing/, "it must say what is actually at stake");
});

test("the backlog clearing is reported, so the operator knows to stop looking", async () => {
  const { sent, tg } = harness();
  await setOrders([{ id: "ord_x", status: "paid", createdAt: T0 - 60 * MIN, updatedAt: T0 - 60 * MIN }]);
  await health._test.runOnce(tg, T0);
  assert.strictEqual(sent.length, 1);
  await orders.setStatus("ord_x", "fulfilled");
  await health._test.runOnce(tg, T0 + 20 * MIN);
  assert.match(sent[1], /All paid orders fulfilled/, sent[1]);
});

test("a crash loop is caught, because every fresh boot passes every other check", async () => {
  // The failure mode that looks perfectly healthy: PM2 restarts, the new process
  // reaches Telegram and Mongo fine, and it dies again a minute later.
  const boots = [1, 2, 3, 4, 5].map((i) => T0 - i * MIN);
  const { sent, tg } = harness({ boots });
  await setOrders([]);
  await health._test.runOnce(tg, T0);
  assert.strictEqual(sent.length, 1, sent.join("\n"));
  assert.match(sent[0], /restarting in a loop/);
  assert.match(sent[0], /5 starts in the last 10 min/);
  assert.match(sent[0], /pm2 logs dexvra-bot --err/, "an alert must say what to run next");
});

test("a normal deploy is not a crash loop", async () => {
  // Three restarts in a few minutes is what shipping a fix looks like.
  const { sent, tg } = harness({ boots: [T0 - 3 * MIN, T0 - 2 * MIN, T0 - MIN] });
  await setOrders([]);
  await health._test.runOnce(tg, T0);
  assert.deepStrictEqual(sent, []);
});

test("the daily heartbeat is the only check that survives the bot dying", async () => {
  // An in-process monitor cannot report its own death. So the signal is
  // inverted: the line arriving means alive, and the line MISSING means look.
  const { sent, tg } = harness({ heartbeatDate: "2026-07-25" });
  await setOrders([{ id: "o1", status: "fulfilled", createdAt: T0 - 30 * MIN, updatedAt: T0 - 29 * MIN }]);
  const morning = Date.parse("2026-07-26T01:30:00Z");
  await health._test.runOnce(tg, morning);
  const beat = sent.find((s) => s.includes("daily health"));
  assert.ok(beat, `no heartbeat:\n${sent.join("\n")}`);
  assert.match(beat, /Uptime/);
  assert.match(beat, /Orders 24h: <b>1<\/b>/);
  assert.match(beat, /If this line stops arriving, the bot is down/, "it must explain its own purpose");
});

test("the heartbeat reads the pass's clock, not the wall clock", async () => {
  // Mixing the two meant one pass could ask "did I already send today's?"
  // against a different day than the one it was checking. Harmless 23 hours out
  // of 24, and then a duplicate (or a skipped) heartbeat exactly at the UTC
  // rollover — which is the one moment nobody is watching.
  const { sent, tg } = harness({ heartbeatDate: "2026-07-25" });
  await setOrders([]);
  // A pass dated the 26th must mark the 26th, whatever today happens to be.
  await health._test.runOnce(tg, Date.parse("2026-07-26T01:30:00Z"));
  assert.strictEqual(health._test.getState().lastHeartbeatDate, "2026-07-26");
  assert.strictEqual(sent.filter((x) => x.includes("daily health")).length, 1);
  // …and a later pass on the SAME dated day must not send a second.
  await health._test.runOnce(tg, Date.parse("2026-07-26T23:59:00Z"));
  assert.strictEqual(sent.filter((x) => x.includes("daily health")).length, 1);
  // The next day does send one.
  await health._test.runOnce(tg, Date.parse("2026-07-27T01:00:00Z"));
  assert.strictEqual(sent.filter((x) => x.includes("daily health")).length, 2);
});

test("the heartbeat fires once a day, not once per restart", async () => {
  const { sent, tg } = harness({ heartbeatDate: "2026-07-25" });
  await setOrders([]);
  const morning = Date.parse("2026-07-26T01:30:00Z");
  for (let i = 0; i < 20; i++) await health._test.runOnce(tg, morning + i * MIN);
  assert.strictEqual(sent.filter((s) => s.includes("daily health")).length, 1);
  // …and the mark is on disk, so a restart cannot re-send it.
  const onDisk = JSON.parse(fss.readFileSync(path.join(process.env.BOT_DATA_DIR, "health.json"), "utf8"));
  assert.strictEqual(onDisk.lastHeartbeatDate, "2026-07-26", JSON.stringify(onDisk));
});

test("alerts go to the error channel and are never de-duplicated", async () => {
  // The visitor feed is a business feed. And the monitor owns its own "have I
  // said this" state — folding alerts into the logger's 15-minute window would
  // swallow a second, genuinely new outage inside it.
  const feed = [];
  const errors = [];
  log._resetDedupe();
  log.attach(
    { telegram: { sendMessage: async (chat, text) => (chat === "@errors" ? errors : feed).push(text) } },
    "@visitors",
    "@errors",
  );
  log.alert("🚨 same text");
  log.alert("🚨 same text");
  assert.strictEqual(errors.length, 2, "two alerts are two alerts");
  assert.strictEqual(feed.length, 0, "and none of them belong in the visitor feed");
});

test("a broken check can never take down the bot it watches", async () => {
  const { sent } = harness();
  await setOrders([]);
  const tg = { getMe: () => { throw new Error("not even a promise"); } };
  await assert.doesNotReject(() => health._test.runOnce(tg, T0));
  assert.deepStrictEqual(sent, []);
});

test("the monitor is actually wired into boot — an unstarted service watches nothing", () => {
  const src = fss.readFileSync(require.resolve("../src/services/attach.js"), "utf8");
  // Wired through add(), which guards each service on its own. Pushed directly
  // into the chain instead, a failure ABOVE it would stop it from ever
  // starting — and a monitor that never started is the one thing that cannot
  // report its own absence.
  assert.match(src, /add\("healthMonitor", \(\) => require\("\.\/healthMonitor"\)\.start\(tg\)\)/);
  // Comments stripped: the file's header quotes the OLD wiring on purpose, to
  // tell the next reader what it cost, so a check on what the CODE does has to
  // read past the explanation.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/services\.push\(require\(/.test(code), "a service bypasses the per-service guard");
  // It must return a stop handle like every other service, or SIGTERM hangs.
  const mon = fss.readFileSync(require.resolve("../src/services/healthMonitor.js"), "utf8");
  assert.match(mon, /return \{\n\s*stop\(\) \{/);
  assert.match(mon, /if \(timer\.unref\) timer\.unref\(\);/, "a monitor must not hold the process open by itself");
});
