// SWITCH A CHAIN ON OR OFF FOR THE TRENDING BOARD, from the admin bot.
//
// "saya tidak ingin chain ini ada di channel trending dan liat di admin bot
// harusnya bisa aktivkan dan nonaktifkan". `cfg.chains` has always governed the
// board — the poster skips a chain that is off and the promoter never fills one
// — but the only ways to change it were a code default or a shell script, so
// taking POLYGON off a channel of 10,543 people needed a deploy.
//
// Driven through real Telegraf updates, like ⚡ Run now beside it: the ORDER of
// the answer, the write and the redraw is part of what is being fixed, and a
// source scan sees all three calls and reads as fine.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-chtog-"));
process.env.ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "123456:TEST_ADMIN_CHTOG";

const { Telegram } = require("telegraf");
const adminBot = require("../src/admin/adminBot");
const autoTrend = require("../src/services/autoTrend");
const { ADMIN_IDS } = require("../src/config/constants");

const ADMIN = { id: Number(ADMIN_IDS[0]), is_bot: false, first_name: "Owner" };
const CHAT = { id: 4243, type: "private" };
const REAL_CALL_API = Telegram.prototype.callApi;

function harness() {
  const bot = adminBot.build();
  bot.botInfo = { id: 777, is_bot: true, first_name: "Dexvra Admin", username: "dexvraadminbot" };
  bot.catch((e) => { throw e; });
  const calls = [];
  let mid = 100;
  Telegram.prototype.callApi = async function stubbed(method, payload) {
    calls.push({ method, payload });
    if (method === "sendMessage") return { message_id: ++mid, date: 0, chat: CHAT, text: payload && payload.text };
    return true;
  };
  let uid = 0;
  const tap = (data) =>
    bot.handleUpdate({
      update_id: ++uid,
      callback_query: {
        id: String(++uid), from: ADMIN, chat_instance: "1", data,
        message: { message_id: ++mid, date: 0, chat: CHAT, from: ADMIN, text: "panel" },
      },
    });
  const of = (m) => calls.filter((c) => c.method === m).map((c) => String((c.payload && c.payload.text) || ""));
  const order = () => calls.map((c) => c.method);
  return { bot, tap, calls, order, answers: () => of("answerCallbackQuery"), replies: () => of("sendMessage") };
}
const labels = (kb) => kb.reply_markup.inline_keyboard.flat();

test("the panel offers an ON/OFF button per chain, and it reads its state", async () => {
  await autoTrend.set({ chains: ["solana", "bsc"] });
  adminBot._test.setAtCounts({ solana: { featured: 5, eligible: 3 }, bsc: { featured: 1, eligible: 2 }, polygon: { featured: 0, eligible: 4 } });
  const btns = labels(adminBot._test.atKb()).filter((b) => /^atch:/.test(b.callback_data || ""));
  const byId = new Map(btns.map((b) => [b.callback_data.slice(5), b.text]));
  assert.ok(byId.has("solana") && byId.has("bsc"), `no toggles for the configured chains: ${[...byId.keys()]}`);
  assert.match(byId.get("solana"), /^🟢/, `a configured chain must read ON: ${byId.get("solana")}`);
  // A chain with listings but NOT configured is offered too — that is how it
  // gets switched on — and it must read OFF.
  assert.ok(byId.has("polygon"), "a chain with listings must be offerable");
  assert.match(byId.get("polygon"), /^⚪️/, `an unconfigured chain must read OFF: ${byId.get("polygon")}`);
});

test("tapping removes the chain, and tapping again puts it back", async () => {
  await autoTrend.set({ chains: ["solana", "bsc"] });
  const h = harness();
  try {
    await h.tap("atch:bsc");
    assert.deepStrictEqual(autoTrend.get().chains, ["solana"], "the chain was not removed");
    await h.tap("atch:bsc");
    assert.deepStrictEqual(autoTrend.get().chains.slice().sort(), ["bsc", "solana"], "the chain was not restored");
  } finally {
    Telegram.prototype.callApi = REAL_CALL_API;
  }
});

test("⚠️ the LAST chain cannot be switched off", async () => {
  // `set()` reads an empty list as a mistake and falls back to the shipped six,
  // so the tap would appear to work and then silently restore every chain the
  // operator had just removed — a toggle that reverts, which this file has
  // already had to fix once for `fillFromMarket`.
  await autoTrend.set({ chains: ["solana"] });
  const h = harness();
  try {
    await h.tap("atch:solana");
    assert.deepStrictEqual(autoTrend.get().chains, ["solana"], "the last chain was removed");
    assert.ok(h.answers().some((t) => /last chain/i.test(t)), `the refusal was never shown: ${JSON.stringify(h.answers())}`);
  } finally {
    Telegram.prototype.callApi = REAL_CALL_API;
  }
});

test("⚠️ the tap is ANSWERED before the write and the redraw", async () => {
  // A callback answer is the one channel with a deadline; a write and a panel
  // edit have none. ⚡ Run now beside this was reported as a dead button for
  // exactly this ordering.
  await autoTrend.set({ chains: ["solana", "bsc"] });
  const h = harness();
  try {
    await h.tap("atch:bsc");
    const o = h.order();
    assert.ok(o.includes("answerCallbackQuery"), "the tap was never answered");
    assert.ok(
      o.indexOf("answerCallbackQuery") < o.indexOf("editMessageText"),
      `the answer must come first: ${o.join(" → ")}`,
    );
  } finally {
    Telegram.prototype.callApi = REAL_CALL_API;
  }
});

test("switching a chain OFF says the channel updates on its own timer", async () => {
  // The board is edited in place every ~5 minutes, so the channel does not
  // change the instant this is tapped — and the next report would be "saya
  // sudah matikan tapi masih ada".
  await autoTrend.set({ chains: ["solana", "bsc"] });
  const h = harness();
  try {
    await h.tap("atch:bsc");
    const said = h.replies().join(" ");
    assert.match(said, /off the trending board/i, said);
    assert.match(said, /5 min/, `it must say the channel lags: ${said}`);
    assert.match(said, /PAID/, `it must say a purchase still publishes: ${said}`);
  } finally {
    Telegram.prototype.callApi = REAL_CALL_API;
  }
});
