// A pasted contract address is a QUESTION, never an instruction.
//
// THE FAILURE: dropping a bare CA into a group called applyToken() on the spot,
// so a group ended up watching a token nobody in it had chosen — somebody
// pasted a contract to show it to a member and the bot read a message that was
// never addressed to it as a command. The admin then found a token configured
// they had no memory of setting, which is exactly the report this came from.
//
// And the guard that made that "safe" made it useless too: it bailed out when a
// token was already set, so pasting a NEW address into a configured group did
// nothing whatsoever and read as a dead bot. Replacing a live config is the one
// case that most needs confirming, not skipping.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-pasteca-"));

const test = require("node:test");
const assert = require("node:assert");
const setup = require("../src/group/setup");
const cfg = require("../src/group/config");

const CHAT = -1001;
const CA = "0x" + "3e".repeat(20);
const OTHER = "0x" + "ab".repeat(20);

/** A ctx that records what the bot sent, with the admin check stubbed. */
function ctxFor(text, { admin = true, from = { id: 7, username: "alfaaaa16" } } = {}) {
  const sent = [];
  return {
    sent,
    chat: { id: CHAT, type: "supergroup" },
    from,
    message: { text, message_id: 1, chat: { id: CHAT, type: "supergroup" } },
    telegram: {
      getChatMember: async () => ({ status: admin ? "administrator" : "member" }),
    },
    reply: async (t, extra) => (sent.push({ text: t, extra }), { message_id: 2 }),
    answerCbQuery: async () => {},
    deleteMessage: async () => {},
    editMessageReplyMarkup: async () => {},
  };
}
const buttons = (msg) =>
  ((msg && msg.extra && msg.extra.reply_markup && msg.extra.reply_markup.inline_keyboard) || []).flat();

test.beforeEach(async () => {
  await cfg.remove(CHAT);
  setup._pendingActivate.clear();
});

test("a pasted CA ASKS before it arms anything", async () => {
  const ctx = ctxFor(CA);
  await setup.groupTokenReply(ctx, () => {});
  const card = ctx.sent[0];
  assert.ok(card, "the bot answers a pasted address — it used to answer silently by acting");
  assert.match(card.text, /Activate the buy bot/i);
  assert.match(card.text, /alfaaaa16/, "and names who asked, so the group can see whose request it is");
  // The decisive assertion: NOTHING was configured by the paste itself.
  assert.strictEqual(cfg.get(CHAT), null, "no config is written until somebody taps");
  const cb = buttons(card).map((b) => b.callback_data);
  assert.ok(cb.some((d) => /^bs_act:\d+$/.test(d)), `a confirm button: ${cb.join(", ")}`);
  assert.ok(cb.some((d) => /^bs_actno:\d+$/.test(d)), `and a cancel button: ${cb.join(", ")}`);
});

test("pasting into a CONFIGURED group offers the swap, and says what it replaces", async () => {
  // The old code returned early here, so this did nothing at all and looked
  // like a broken bot — while the case that most needs a confirmation is
  // precisely the one that overwrites a live token.
  await cfg.upsert(CHAT, { chain: "solana", address: OTHER, sym: "ALON", on: true });
  const ctx = ctxFor(CA);
  await setup.groupTokenReply(ctx, () => {});
  const card = ctx.sent[0];
  assert.ok(card, "a paste into a configured group is answered, not ignored");
  assert.match(card.text, /replaces/i, "and is honest that it overwrites");
  assert.match(card.text, /ALON/, "naming the token that would be lost");
  assert.strictEqual(cfg.get(CHAT).address, OTHER, "still watching the old token until the tap");
});

test("pasting the CA the group ALREADY watches is not a question worth asking", async () => {
  await cfg.upsert(CHAT, { chain: "bsc", address: CA, sym: "DEX", on: true });
  let passed = false;
  await setup.groupTokenReply(ctxFor(CA), () => (passed = true));
  assert.strictEqual(passed, true, "it falls through to the other text routers");
});

test("a non-admin pasting a CA is ignored — a group is not configured by whoever talks", async () => {
  const ctx = ctxFor(CA, { admin: false });
  let passed = false;
  await setup.groupTokenReply(ctx, () => (passed = true));
  assert.deepStrictEqual(ctx.sent, []);
  assert.strictEqual(passed, true);
});

test("Cancel changes nothing at all", async () => {
  const ctx = ctxFor(CA);
  await setup.groupTokenReply(ctx, () => {});
  const id = buttons(ctx.sent[0])
    .map((b) => b.callback_data)
    .find((d) => /^bs_actno:/.test(d));
  const tap = ctxFor("");
  tap.callbackQuery = { data: id };
  await setup.activateTap(tap);
  assert.strictEqual(cfg.get(CHAT), null, "cancelling must leave the group exactly as it was");
});

test("a member cannot arm an admin's card", async () => {
  // The card is visible to the whole group and the TAP is when the contract
  // actually changes, so admin is re-checked there — not trusted from the paste.
  const ctx = ctxFor(CA);
  await setup.groupTokenReply(ctx, () => {});
  const id = buttons(ctx.sent[0])
    .map((b) => b.callback_data)
    .find((d) => /^bs_act:\d+$/.test(d));
  const tap = ctxFor("", { admin: false, from: { id: 99, username: "randomer" } });
  tap.callbackQuery = { data: id };
  await setup.activateTap(tap);
  assert.strictEqual(cfg.get(CHAT), null, "a member's tap arms nothing");
});

test("a stale card cannot arm whatever the group is discussing now", async () => {
  // Inline keyboards live forever in chat history. Without the sequence number
  // an old card would apply the CURRENT pending address, which is a different
  // token entirely.
  const ctx = ctxFor(CA);
  await setup.groupTokenReply(ctx, () => {});
  const stale = buttons(ctx.sent[0])
    .map((b) => b.callback_data)
    .find((d) => /^bs_act:\d+$/.test(d));
  // A newer paste supersedes it.
  await setup.groupTokenReply(ctxFor(OTHER), () => {});
  const tap = ctxFor("");
  tap.callbackQuery = { data: stale };
  await setup.activateTap(tap);
  assert.strictEqual(cfg.get(CHAT), null, "the superseded card is refused, not applied");
});

test("an untouched group has no token, and no default one either", async () => {
  // The complaint that started this: a group nobody had configured showed a CA.
  // Nothing anywhere may invent one.
  assert.strictEqual(cfg.get(CHAT), null);
  await cfg.upsert(CHAT, { on: false });
  assert.strictEqual(cfg.get(CHAT).address, undefined, "a fresh row carries no address");
  assert.deepStrictEqual(cfg.active(), [], "and nothing with no address is ever polled");
});
