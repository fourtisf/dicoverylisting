// /setminbuy — the picker, and the bug that made it necessary.
//
// A bare /setminbuy used to fall through to Number("") — which is 0, finite and
// >= 0, so it passed validation. Tapping the command in Telegram's command menu
// therefore SET the group's floor to $0 and answered "Floor set", wiping a
// configured floor with a tap that was only ever a question.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-mb-"));

const test = require("node:test");
const assert = require("node:assert");
const setup = require("../src/group/setup");
const cfg = require("../src/group/config");

function ctxFor({ text = "", data = null, chatId = -1001, admin = true } = {}) {
  const c = {
    chat: { id: chatId, type: "supergroup" },
    from: { id: 7 },
    message: { text },
    match: data ? /^mb_(\d+)$/.exec(data) : null,
    telegram: { getChatMember: async () => ({ status: admin ? "administrator" : "member" }) },
    replies: [],
    edits: [],
    toasts: [],
  };
  c.reply = async (t, extra) => (c.replies.push({ text: t, extra }), { message_id: 1 });
  c.editMessageText = async (t, extra) => (c.edits.push({ text: t, extra }), true);
  c.answerCbQuery = async (t) => (c.toasts.push(t), true);
  return c;
}

const buttons = (extra) => (extra.reply_markup.inline_keyboard || []).flat();
const ticked = (extra) => buttons(extra).filter((b) => b.text.includes("✓")).map((b) => b.callback_data);

test("a bare /setminbuy opens the picker and does not touch the floor", async () => {
  await cfg.upsert(-1001, { chain: "solana", address: "AAA", minBuyUsd: 50 });
  const ctx = ctxFor({ text: "/setminbuy@dexvrabot" });
  await setup.setminbuy(ctx);

  assert.strictEqual(cfg.get(-1001).minBuyUsd, 50, "the floor survived a bare /setminbuy");
  assert.strictEqual(ctx.replies.length, 1);
  const kb = buttons(ctx.replies[0].extra);
  assert.ok(kb.length >= 6, "the picker offers presets to tap");
  assert.deepStrictEqual(ticked(ctx.replies[0].extra), ["mb_50"], "the current floor is the ticked one");
});

test("tapping a preset sets the floor and refreshes the picker in place", async () => {
  await cfg.upsert(-1002, { chain: "solana", address: "AAA", minBuyUsd: 50 });
  const ctx = ctxFor({ data: "mb_250", chatId: -1002 });
  await setup.minBuyPick(ctx);

  assert.strictEqual(cfg.get(-1002).minBuyUsd, 250);
  assert.strictEqual(ctx.replies.length, 0, "it edits the panel, it does not stack a new one");
  assert.strictEqual(ctx.edits.length, 1);
  assert.deepStrictEqual(ticked(ctx.edits[0].extra), ["mb_250"], "the tick followed the tap");
  assert.ok(ctx.toasts[0] && ctx.toasts[0].includes("250"), "the tapper gets a toast naming the amount");
});

test("$10 is the bottom of the range, in every path into it", async () => {
  // A chat of $0.40 alerts reads as a dead token, so "call every buy" is not on
  // offer — the picker starts at the floor and a smaller typed amount lands on
  // it rather than being refused.
  assert.strictEqual(cfg.MIN_BUY_FLOOR_USD, 10);
  assert.ok(!setup.MIN_BUY_PRESETS.some((n) => n < 10), "no preset undercuts the floor");

  await cfg.upsert(-1003, { chain: "solana", address: "AAA", minBuyUsd: 100 });
  const typed = ctxFor({ text: "/setminbuy 2", chatId: -1003 });
  await setup.setminbuy(typed);
  assert.strictEqual(cfg.get(-1003).minBuyUsd, 10, "a typed $2 lands on the floor");

  // A stale keyboard from before the floor existed still carries mb_0.
  const tapped = ctxFor({ data: "mb_0", chatId: -1003 });
  await setup.minBuyPick(tapped);
  assert.strictEqual(cfg.get(-1003).minBuyUsd, 10);
  assert.deepStrictEqual(ticked(tapped.edits[0].extra), ["mb_10"]);
});

test("a group that never chose a floor is on $10, not $0", async () => {
  // Every group created before the floor carries a literal minBuyUsd: 0, and so
  // does one the bare-/setminbuy bug reset. Neither ever meant "call dust", so
  // buyMonitor reads through minBuyOf rather than off the record.
  await cfg.upsert(-1006, { chain: "solana", address: "AAA", minBuyUsd: 0 });
  assert.strictEqual(cfg.minBuyOf(cfg.get(-1006)), 10);
  assert.strictEqual(cfg.minBuyOf({}), 10, "a record with no floor at all");
  assert.strictEqual(cfg.minBuyOf({ minBuyUsd: 250 }), 250, "a chosen floor is left alone");
});

test("a non-admin tapping the picker changes nothing", async () => {
  // The picker lives in a group chat where every member can reach the buttons,
  // so the admin check on /setminbuy does not cover the taps that follow it.
  await cfg.upsert(-1004, { chain: "solana", address: "AAA", minBuyUsd: 50 });
  const ctx = ctxFor({ data: "mb_1000", chatId: -1004, admin: false });
  await setup.minBuyPick(ctx);
  assert.strictEqual(cfg.get(-1004).minBuyUsd, 50);
  assert.strictEqual(ctx.edits.length, 0);
});

test("/setminbuy with an amount still sets it; junk gets the usage note", async () => {
  await cfg.upsert(-1005, { chain: "solana", address: "AAA", minBuyUsd: 50 });
  const ok = ctxFor({ text: "/setminbuy $1,000", chatId: -1005 });
  await setup.setminbuy(ok);
  assert.strictEqual(cfg.get(-1005).minBuyUsd, 1000, "$ and thousands separators are tolerated");

  const junk = ctxFor({ text: "/setminbuy later", chatId: -1005 });
  await setup.setminbuy(junk);
  assert.strictEqual(cfg.get(-1005).minBuyUsd, 1000, "junk left the floor alone");
  assert.ok(!junk.replies[0].extra.reply_markup, "junk gets the usage note, not the picker");
});
