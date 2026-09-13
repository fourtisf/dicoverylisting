// The group settings hub: /buybot's buttons, the 🐋 picker, and the paste-the-CA
// prompt behind /settoken.
//
// Setting the buy bot up used to mean knowing five command names and the shape
// of each one's argument, read off a welcome message. Everything here exists so
// the only thing a project ever types is the contract address itself.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-set-"));

const test = require("node:test");
const assert = require("node:assert");
const setup = require("../src/group/setup");
const cfg = require("../src/group/config");
const gt = require("../src/group/gtPairs");

// The pool lookup is the one thing here that would touch the network. Replaced
// on the module object, which is the same object setup.js holds.
gt.fetchPool = async () => ({ poolAddress: "POOL", symbol: "RUSS", name: "Russ" });
gt.fetchTokenInfo = async () => ({ symbol: "RUSS", name: "Russ" });

const CA = "G9j8WWDeJXZdvwQgP82ooDuHmpc3Gy8NCSins71Lpump";

function ctxFor({ text = "", data = null, chatId = -2001, userId = 7, admin = true, replyTo = null } = {}) {
  const c = {
    chat: { id: chatId, type: "supergroup" },
    from: { id: userId },
    message: { text, message_id: 5, reply_to_message: replyTo ? { message_id: replyTo } : undefined },
    match: data ? /^(?:mb|wb|bs)_([a-z0-9]+)$/.exec(data) : null,
    callbackQuery: data ? { message: { message_id: 42 } } : undefined,
    telegram: { getChatMember: async () => ({ status: admin ? "administrator" : "member" }) },
    replies: [],
    edits: [],
    toasts: [],
    nexted: 0,
  };
  c.reply = async (t, extra) => (c.replies.push({ text: t, extra }), { message_id: 99 });
  c.editMessageText = async (t, extra) => (c.edits.push({ text: t, extra }), true);
  c.answerCbQuery = async (t) => (c.toasts.push(t || ""), true);
  c.next = async () => c.nexted++;
  return c;
}

const labels = (extra) => (extra.reply_markup.inline_keyboard || []).flat().map((b) => b.text);

test("a bare /settoken asks for the address with a forced reply", async () => {
  const ctx = ctxFor({ text: "/settoken@dexvrabot", chatId: -2001 });
  await setup.settoken(ctx);
  const rm = ctx.replies[0].extra.reply_markup;
  assert.strictEqual(rm.force_reply, true);
  // Without selective, every member of the group gets an input box shoved in
  // front of them by a setting that is not theirs to change.
  assert.strictEqual(rm.selective, true);
  assert.strictEqual(ctx.replies[0].extra.reply_to_message_id, 5, "aimed at the admin who ran it");
});

test("replying to the prompt sets the token; nothing else is touched", async () => {
  const open = ctxFor({ text: "/settoken", chatId: -2002 });
  await setup.settoken(open); // prompt is message_id 99

  const chatter = ctxFor({ text: "gm", chatId: -2002 });
  await setup.groupTokenReply(chatter, chatter.next);
  assert.strictEqual(chatter.nexted, 1, "ordinary group talk falls through to the private router");

  const stranger = ctxFor({ text: CA, chatId: -2002, userId: 999, admin: false, replyTo: 99 });
  await setup.groupTokenReply(stranger, stranger.next);
  assert.strictEqual(stranger.nexted, 1, "a member who did not open the prompt is not answered");
  assert.strictEqual(cfg.get(-2002), null);

  const admin = ctxFor({ text: CA, chatId: -2002, replyTo: 99 });
  await setup.groupTokenReply(admin, admin.next);
  assert.strictEqual(admin.nexted, 0, "the prompt's own reply is consumed");
  assert.strictEqual(cfg.get(-2002).address, CA);
  assert.strictEqual(cfg.get(-2002).on, true, "setting a token arms the bot");

  // The prompt is spent. A later reply to the same message is just chat again.
  const late = ctxFor({ text: "0xdeadbeef", chatId: -2002, replyTo: 99 });
  await setup.groupTokenReply(late, late.next);
  assert.strictEqual(late.nexted, 1);
  assert.strictEqual(cfg.get(-2002).address, CA, "and it did not overwrite the token");
});

test("an admin dropping a bare CA is ANSWERED, and nothing is armed until they tap", async () => {
  // This used to arm the bot on the spot. That is how a group ends up watching
  // a token nobody chose — somebody pastes a contract to show it to a member
  // and the bot reads a message that was never addressed to it as a command.
  // See test/pastedCa.test.js for the confirmation card in full.
  const paste = ctxFor({ text: `  ${CA} `, chatId: -2009 });
  await setup.groupTokenReply(paste, paste.next);
  assert.strictEqual(paste.nexted, 0, "the paste is handled, not passed along");
  assert.strictEqual(cfg.get(-2009), null, "…but nothing is configured by the paste itself");

  // The guards that remain. A CA inside a sentence is someone TALKING about a
  // token, and a non-admin cannot point the bot anywhere.
  const chat = ctxFor({ text: `have you seen ${CA} yet`, chatId: -2010 });
  await setup.groupTokenReply(chat, chat.next);
  assert.strictEqual(chat.nexted, 1);

  const other = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
  const member = ctxFor({ text: other, chatId: -2011, admin: false });
  await setup.groupTokenReply(member, member.next);
  assert.strictEqual(member.nexted, 1);
  assert.strictEqual(cfg.get(-2011), null);
});

test("setting a token reports what is live and offers the hub, not homework", async () => {
  const ctx = ctxFor({ text: `/settoken ${CA}`, chatId: -2012 });
  await setup.settoken(ctx);
  const done = ctx.replies[ctx.replies.length - 1];
  assert.match(done.text, /\$10/, "it names the floor that is already in force");
  assert.deepStrictEqual(labels(done.extra), ["⚙️ Settings"]);
  // The old card ended on "/setminbuy 50 · /setwhale 50000 · /buybot off" —
  // three commands to go and run at the moment setup had just finished.
  assert.ok(!/\/setminbuy|\/setwhale|\/buybot/.test(done.text), "no command list");
});

test("/buybot on a group with no token offers the one button that means anything", async () => {
  const ctx = ctxFor({ text: "/buybot", chatId: -2003 });
  await setup.buybot(ctx);
  // "Add CA", not "Set token": the panel's own copy calls it a contract address
  // and so does every other surface, and one button is still the whole point —
  // offering a min-buy picker to a group with no token is a dead end.
  assert.deepStrictEqual(labels(ctx.replies[0].extra), ["📄 Add CA"]);
});

test("the settings hub toggles pin and power in place", async () => {
  await cfg.upsert(-2004, { chain: "solana", address: CA, pairAddress: "P", on: true });
  const pin = ctxFor({ data: "bs_pin", chatId: -2004 });
  await setup.settingsTap(pin);
  assert.strictEqual(cfg.get(-2004).pin, false);
  assert.ok(labels(pin.edits[0].extra).includes("📌 Pin: off"), "the button shows the new state");

  const power = ctxFor({ data: "bs_power", chatId: -2004 });
  await setup.settingsTap(power);
  assert.strictEqual(cfg.get(-2004).on, false);
  assert.ok(labels(power.edits[0].extra).includes("🟢 Turn the buy bot on"));
});

test("the hub will not switch on a group that has no token", async () => {
  // It would report success and then call nothing at all, forever.
  await cfg.upsert(-2005, {});
  const ctx = ctxFor({ data: "bs_power", chatId: -2005 });
  await setup.settingsTap(ctx);
  assert.ok(!cfg.get(-2005).on);
  assert.strictEqual(ctx.edits.length, 0);
  assert.ok(ctx.toasts[0], "and it says why");
});

test("a non-admin taps nothing on the hub", async () => {
  await cfg.upsert(-2006, { chain: "solana", address: CA, pairAddress: "P", on: true });
  const ctx = ctxFor({ data: "bs_power", chatId: -2006, admin: false });
  await setup.settingsTap(ctx);
  assert.strictEqual(cfg.get(-2006).on, true);
  assert.strictEqual(ctx.edits.length, 0);
});

test("the whale picker sets a bar and turns it off", async () => {
  await cfg.upsert(-2007, { chain: "solana", address: CA, pairAddress: "P", on: true });
  const set = ctxFor({ data: "wb_25000", chatId: -2007 });
  await setup.whalePick(set);
  assert.strictEqual(cfg.get(-2007).whales, true);
  assert.strictEqual(cfg.get(-2007).whaleWalletUsd, 25000);
  assert.ok(labels(set.edits[0].extra).includes("$25,000 ✓"));

  const off = ctxFor({ data: "wb_off", chatId: -2007 });
  await setup.whalePick(off);
  assert.strictEqual(cfg.get(-2007).whales, false);
  assert.ok(
    !labels(off.edits[0].extra).some((l) => l.includes("$") && l.includes("✓")),
    "no bar is ticked while whale calls are off",
  );
});

test("a bare /setwhale opens the picker instead of printing syntax", async () => {
  await cfg.upsert(-2008, { chain: "solana", address: CA, pairAddress: "P", on: true });
  const ctx = ctxFor({ text: "/setwhale@dexvrabot", chatId: -2008 });
  await setup.setwhale(ctx);
  assert.ok(setup.WHALE_PRESETS.length >= 3);
  assert.ok(labels(ctx.replies[0].extra).some((l) => l.startsWith("$")), "bars to tap");
});

test("the /settoken receipt leads its chain row with THAT chain's own mark", async () => {
  // A fixed 🔗 said "chain" to a reader who could already see the word Chain
  // beside it, and spent the one position on the row that could carry the
  // network's identity. It reads the same admin-editable `chain_emojis` map as
  // the buy cards and the channel posts, so setting a premium Solana emoji
  // once lights it up in all three.
  const tpl = require("../src/templates");
  const { chainEmoji } = require("../src/channels/format");
  const vars = { nameRow: "📃 **Plumber**", address: "GCa9pump", links: "", minBuy: "$10", whale: "$50,000" };
  for (const chain of ["solana", "robinhood", "bsc"]) {
    const line = tpl
      .render("settoken_ok", { ...vars, chain, chainEmoji: chainEmoji(chain) })
      .text.split("\n")
      .find((l) => l.includes("Chain:"));
    assert.ok(line.startsWith(chainEmoji(chain)), `${chain}: row leads with its own mark, got ${line}`);
  }
  // Two different chains must not render the same mark, or the row says nothing.
  assert.notStrictEqual(chainEmoji("solana"), chainEmoji("robinhood"));
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "setup.js"), "utf8");
  assert.match(src, /chainEmoji: require\("\.\.\/channels\/format"\)\.chainEmoji/, "fed from the shared map, not a literal");
});
