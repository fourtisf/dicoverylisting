// "di klik fiturnya not work" — ⚡ Run now on the Auto Trending panel.
//
// The button spun and nothing came back. Nothing was wrong with the promotion:
// `byGain` prices up to PROBE_CAP candidates SERIALLY with a 250ms gap and an 8s
// timeout each, so on a chain with dozens of spares (Robinhood had 44) the work
// runs well past Telegram's ~15s callback deadline. `answerCbQuery` then fails
// with "query is too old", the .catch swallows it, and the operator is told
// nothing at all — while the promotion may well have succeeded.
//
// A callback answer is the one channel with a deadline. It carries the
// ACKNOWLEDGEMENT, which is bounded; the RESULT goes on the panel, which is a
// message edit and has no deadline. `alscan` beside it already worked this way.
//
// Driven through real Telegraf updates, because the defect is entirely in WHEN
// each call happens — a source scan sees both calls and reads as fine.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-runnow-"));
process.env.BOT_DATA_DIR = DIR;
process.env.ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "123456:TEST_ADMIN_RUNNOW";

const { Telegram } = require("telegraf");
const adminBot = require("../src/admin/adminBot");
const autoTrend = require("../src/services/autoTrend");
const { ADMIN_IDS } = require("../src/config/constants");

const ADMIN = { id: Number(ADMIN_IDS[0]), is_bot: false, first_name: "Owner", username: "owner" };
const CHAT = { id: 4242, type: "private" };
const REAL_CALL_API = Telegram.prototype.callApi;

function harness() {
  const bot = adminBot.build();
  bot.botInfo = { id: 777, is_bot: true, first_name: "Dexvra Admin", username: "dexvraadminbot" };
  bot.catch((e) => {
    throw e;
  });
  const calls = [];
  let mid = 100;
  Telegram.prototype.callApi = async function stubbedCallApi(method, payload) {
    calls.push({ method, payload });
    if (method === "sendMessage") return { message_id: ++mid, date: 0, chat: CHAT, text: payload && payload.text };
    return true;
  };
  let uid = 0;
  const tap = (data) =>
    bot.handleUpdate({
      update_id: ++uid,
      callback_query: {
        id: String(++uid),
        from: ADMIN,
        chat_instance: "1",
        data,
        message: { message_id: ++mid, date: 0, chat: CHAT, from: ADMIN, text: "panel" },
      },
    });
  const answers = () => calls.filter((c) => c.method === "answerCallbackQuery").map((c) => String(c.payload.text || ""));
  const edits = () => calls.filter((c) => c.method === "editMessageText").map((c) => String(c.payload.text || ""));
  return { bot, calls, tap, answers, edits };
}

test("the tap is answered BEFORE the work finishes — the answer is what expires", async () => {
  const h = harness();
  const real = autoTrend.forceChain;
  let release;
  const started = new Promise((r) => (release = r));
  let answeredWhileWorking = null;
  autoTrend.forceChain = () =>
    new Promise((resolve) => {
      // The moment the slow work begins, what has the operator been told?
      answeredWhileWorking = h.answers();
      release();
      setTimeout(() => resolve({ promoted: 1, syms: ["BOB"], reason: null }), 5);
    });
  try {
    const done = h.tap("atrun:robinhood");
    await started;
    assert.strictEqual(answeredWhileWorking.length, 1, "the callback was still unanswered while the work ran — it expires in ~15s");
    assert.match(answeredWhileWorking[0], /robinhood/, "the acknowledgement must name what is running");
    await done;
  } finally {
    autoTrend.forceChain = real;
    Telegram.prototype.callApi = REAL_CALL_API;
  }
});

test("the RESULT is reported on the panel, which has no deadline", async () => {
  const h = harness();
  const real = autoTrend.forceChain;
  autoTrend.forceChain = async () => ({ promoted: 1, syms: ["BOB", "ALICE"], reason: null });
  try {
    await h.tap("atrun:robinhood");
    const panel = h.edits().join("\n");
    assert.match(panel, /Ran on robinhood/, "the outcome never reached the panel — a toast that expires is the whole bug");
    assert.match(panel, /BOB, ALICE/, "which tokens went on is the answer the operator tapped for");
    // …and only ONE answer: Telegram keeps the first per callback and drops the
    // rest, so a second one carrying the result would be silently discarded.
    assert.strictEqual(h.answers().length, 1);
  } finally {
    autoTrend.forceChain = real;
    Telegram.prototype.callApi = REAL_CALL_API;
  }
});

test("a run that promoted NOTHING says why, on the panel", async () => {
  const h = harness();
  const real = autoTrend.forceChain;
  autoTrend.forceChain = async () => ({ promoted: 0, syms: [], reason: "all 44 listed token(s) on robinhood are already trending" });
  try {
    await h.tap("atrun:robinhood");
    const panel = h.edits().join("\n");
    assert.match(panel, /Nothing promoted on robinhood/);
    assert.match(panel, /already trending/, "the reason IS the diagnosis — without it the tap reads as broken");
  } finally {
    autoTrend.forceChain = real;
    Telegram.prototype.callApi = REAL_CALL_API;
  }
});

test("a second tap while one is running does not start a second promotion", async () => {
  // The work outlives the answer, so a panel that looks idle invites a second
  // tap — which would book two slots for one request.
  const h = harness();
  const real = autoTrend.forceChain;
  let runs = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  autoTrend.forceChain = async () => {
    runs++;
    await gate;
    return { promoted: 1, syms: ["BOB"], reason: null };
  };
  try {
    const first = h.tap("atrun:robinhood");
    await h.tap("atrun:robinhood");
    assert.strictEqual(runs, 1, "the second tap started another run");
    assert.match(h.answers().join("\n"), /already going/);
    release();
    await first;
  } finally {
    autoTrend.forceChain = real;
    Telegram.prototype.callApi = REAL_CALL_API;
  }
});
