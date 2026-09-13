// The 🌐 chain-scope PICKER, driven through real Telegraf updates — because
// the first cut shipped with `cb` undefined inside alchKb(): the module
// required cleanly, the service tests were green, and every tap on 🌐 answered
// and then threw inside bot.catch — a button that visibly did nothing, live,
// reported by the operator as "chainnya harus bisa request". A source scan or
// a require-check passes on that revision; only DISPATCHING the tap fails.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-alchpanel-"));
process.env.BOT_DATA_DIR = DIR;
process.env.ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "123456:TEST_ALCH_PANEL";

const test = require("node:test");
const assert = require("node:assert");

const { Telegram } = require("telegraf");
const adminBot = require("../src/admin/adminBot");
const autoLister = require("../src/services/autoLister");
const { ADMIN_IDS } = require("../src/config/constants");

const ADMIN = { id: Number(ADMIN_IDS[0]), is_bot: false, first_name: "Owner", username: "owner" };
const CHAT = { id: 4242, type: "private" };
const REAL_CALL_API = Telegram.prototype.callApi;

function harness() {
  const bot = adminBot.build();
  bot.botInfo = { id: 777, is_bot: true, first_name: "Dexvra Admin", username: "dexvraadminbot" };
  // A handler that throws must FAIL the test — swallowing it is exactly how
  // the live bug looked healthy from every angle but the operator's.
  let thrown = null;
  bot.catch((e) => {
    thrown = e;
  });
  const calls = [];
  let mid = 100;
  Telegram.prototype.callApi = async function (method, payload) {
    calls.push({ method, payload });
    if (method === "sendMessage") return { message_id: ++mid, date: 0, chat: CHAT, text: payload && payload.text };
    return true;
  };
  let uid = 0;
  const tap = async (data) => {
    await bot.handleUpdate({
      update_id: ++uid,
      callback_query: {
        id: String(++uid),
        from: ADMIN,
        chat_instance: "1",
        data,
        message: { message_id: ++mid, date: 0, chat: CHAT, from: ADMIN, text: "panel" },
      },
    });
    if (thrown) throw thrown;
  };
  const edits = () => calls.filter((c) => c.method === "editMessageText");
  return { tap, edits, calls };
}

test("tapping 🌐 RENDERS the picker — with every supported chain as a button", async (t) => {
  t.after(() => {
    Telegram.prototype.callApi = REAL_CALL_API;
  });
  await autoLister.reset();
  const h = harness();
  await h.tap("alch");
  const e = h.edits();
  assert.strictEqual(e.length, 1, "the tap must EDIT the panel, not only answer");
  assert.match(e[0].payload.text, /chain scope/i);
  const buttons = e[0].payload.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.length >= 20, `every supported chain is offered (${buttons.length} buttons)`);
  assert.ok(buttons.some((b) => /ALL chains/.test(b.text)), "…including the way back to ALL");
});

test("the taps drive the real scope: focus Base, add Ethereum, clear to ALL", async (t) => {
  t.after(() => {
    Telegram.prototype.callApi = REAL_CALL_API;
  });
  await autoLister.reset();
  const h = harness();
  await h.tap("alchn:base");
  assert.deepStrictEqual(autoLister.get().chains, ["base"], "one tap focuses the scan");
  await h.tap("alchn:ethereum");
  assert.deepStrictEqual(autoLister.get().chains, ["base", "ethereum"], "multi-select");
  await h.tap("alchn:base");
  assert.deepStrictEqual(autoLister.get().chains, ["ethereum"], "tapping again removes");
  await h.tap("alchall");
  assert.deepStrictEqual(autoLister.get().chains, [], "ALL clears the scope");
  // Widening back to the whole market is an alert, not a toast someone taps past.
  await h.tap("alchn:tron");
  await h.tap("alchn:tron"); // removing the LAST one = back to ALL
  const answers = h.calls.filter((c) => c.method === "answerCallbackQuery");
  const last = answers[answers.length - 1].payload;
  assert.ok(last.show_alert, "falling back to ALL is a show_alert");
  await autoLister.reset();
});
