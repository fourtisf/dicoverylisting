// What a project sees the moment the bot lands in their group: the permissions
// greeting, the "/" command menu, and the fact that every word of the setup
// flow is now an admin-editable template rather than a string literal.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-onb-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");
const start = require("../src/handlers/start");

const src = (rel) => fss.readFileSync(path.join(__dirname, "..", "src", rel), "utf8");

// ── The greeting on being added ──────────────────────────────────────────────

function addCtx(over = {}) {
  const sent = [];
  return {
    sent,
    chat: { id: -1001, type: "supergroup", title: "tes fourportal2" },
    myChatMember: {
      old_chat_member: { status: "left" },
      new_chat_member: { status: "member" },
      ...(over.myChatMember || {}),
    },
    reply: async (text, extra) => {
      sent.push({ text, extra });
      return { message_id: 1 };
    },
    ...over,
  };
}

test.beforeEach(() => start._greeted.clear());

test("being added asks for the three permissions the bot actually uses", async () => {
  const ctx = addCtx();
  await start.botAddedToGroup(ctx);
  assert.strictEqual(ctx.sent.length, 1, "it speaks up without waiting to be asked");
  const t = ctx.sent[0].text;
  // Each one is a permission the code genuinely needs — pinning for whale
  // alerts and the raid card, deleting for the raid panel's cleanup, banning
  // for the chat lock. Asking for more than you use earns a refusal of all of it.
  for (const perm of ["Delete messages", "Ban users", "Pin messages"]) {
    assert.ok(t.includes(perm), `it names ${perm}`);
  }
  // It used to end on "then hit /start". The card now carries the keyboard, so
  // the next step is a button — asserting the command back would only pass by
  // reintroducing the syntax the buttons replaced.
  assert.match(t, /Buy Bot/i, "and points at the button that starts the setup");
  const kb = ctx.sent[0].extra && ctx.sent[0].extra.reply_markup;
  assert.ok(kb && kb.inline_keyboard.flat().some((b) => b.callback_data === "bs_buybot"),
    "which is actually on the message");
});

test("the greeting is Dexvra's own copy, not the card every other group bot posts", () => {
  // The first cut of this was the neighbouring bot's message with two words
  // changed. Dexvra reads as a clone the moment it borrows that — the same
  // reason group_buy_alert refuses the copy-trading bots' layout.
  const t = tpl.t("group_added");
  for (const tell of [/thanks for adding me/i, /‼️/, /then type \/start/i, /to setting/i]) {
    assert.ok(!tell.test(t), `the greeting still carries "${tell}"`);
  }
  // The substantive difference, and the part worth locking: every permission
  // SAYS WHAT IT IS FOR. A bare list of three powerful rights reads as a bot
  // asking for the keys to the group, and an admin is right to hesitate.
  for (const perm of ["Pin messages", "Delete messages", "Ban users"]) {
    const line = t.split("\n").find((l) => l.includes(perm));
    assert.ok(line, `${perm} is named`);
    assert.match(line, /—\s*\S/, `${perm} says what it is used for`);
  }
});

test("the in-group copy does not talk about itself in the first person", () => {
  // "make me an admin", "DM me", "I keep a scoreboard" — three different voices
  // across two messages that arrive seconds apart in the same chat.
  for (const key of ["group_added", "group_start"]) {
    const t = tpl.t(key);
    for (const m of t.matchAll(/\b(I'll|I keep|DM me|add me|make me)\b/gi)) {
      assert.fail(`${key} says "${m[0]}" — state what happens, not who does it`);
    }
  }
});

test("a permission change is not a new arrival", async () => {
  // Telegram sends my_chat_member for every admin-rights edit too. Greeting on
  // each one means a fresh welcome every time somebody ticks a checkbox.
  for (const [was, now] of [
    ["member", "administrator"],
    ["administrator", "member"],
    ["administrator", "administrator"],
  ]) {
    const ctx = addCtx({ myChatMember: { old_chat_member: { status: was }, new_chat_member: { status: now } } });
    await start.botAddedToGroup(ctx);
    assert.strictEqual(ctx.sent.length, 0, `${was} → ${now} is not an arrival`);
  }
});

test("being removed says nothing at all", async () => {
  for (const now of ["left", "kicked"]) {
    const ctx = addCtx({ myChatMember: { old_chat_member: { status: "administrator" }, new_chat_member: { status: now } } });
    await start.botAddedToGroup(ctx);
    assert.strictEqual(ctx.sent.length, 0, `→ ${now} is silent`);
  }
});

test("added straight as an admin still counts as arriving", async () => {
  const ctx = addCtx({ myChatMember: { old_chat_member: { status: "left" }, new_chat_member: { status: "administrator" } } });
  await start.botAddedToGroup(ctx);
  assert.strictEqual(ctx.sent.length, 1);
});

test("a private chat never gets the group greeting", async () => {
  const ctx = addCtx({ chat: { id: 7, type: "private" } });
  await start.botAddedToGroup(ctx);
  assert.strictEqual(ctx.sent.length, 0);
});

test("the ➕ deep link does not produce two welcomes stacked on each other", async () => {
  // Adding through the main-menu button fires BOTH: my_chat_member, and the
  // /start Telegram INJECTS into the group right behind it. The injected one
  // carries the deep link's payload — ?startgroup=true sends "/start true".
  const ctx = addCtx({ startPayload: "true" });
  await start.botAddedToGroup(ctx);
  assert.strictEqual(ctx.sent.length, 1, "the greeting");
  await start.groupStart(ctx);
  assert.strictEqual(ctx.sent.length, 1, "and the injected /start behind it stays quiet");
});

test("a /start somebody TYPED always answers, even seconds after the bot joined", async () => {
  // The first cut gated on a 20-second window, and this is what it broke: for
  // twenty seconds after joining — exactly when somebody is setting the bot up
  // and pressing things — /start did nothing, and logged nothing either.
  const ctx = addCtx(); // no startPayload: nobody types one
  await start.botAddedToGroup(ctx);
  assert.strictEqual(ctx.sent.length, 1, "the greeting");
  await start.groupStart(ctx);
  assert.strictEqual(ctx.sent.length, 2, "and /start is answered on the spot");
  assert.match(ctx.sent[1].text, /Buy Bot/i, "with the setup guide");
  const kb = ctx.sent[1].extra && ctx.sent[1].extra.reply_markup;
  assert.ok(kb && kb.inline_keyboard.flat().some((b) => b.callback_data === "gs_raid"),
    "and its buttons, so a typed /start is not a worse answer than the greeting");
});

test("/help in a group answers too — it carries no payload either", async () => {
  const ctx = addCtx();
  await start.botAddedToGroup(ctx);
  await start.groupStart(ctx); // bot.help() routes here with no startPayload
  assert.strictEqual(ctx.sent.length, 2);
});

test("an injected /start long after the greeting still answers", async () => {
  // The payload check narrows WHICH /start can be suppressed; the window still
  // decides WHEN. A deep link followed hours later is a fresh request.
  const ctx = addCtx({ startPayload: "true" });
  await start.botAddedToGroup(ctx);
  start._greeted.set(String(ctx.chat.id), Date.now() - 60_000);
  await start.groupStart(ctx);
  assert.strictEqual(ctx.sent.length, 2);
});

test("a group template that fails to render is LOGGED, not swallowed", () => {
  // A swallowed failure here is /start doing nothing at all, forever, with
  // nothing in the logs to say why: a saved template whose markup will not
  // parse looks exactly like a bot that has stopped working.
  const s = src("handlers/start.js");
  const fn = s.slice(s.indexOf("async function sendGroupTemplate"), s.indexOf("async function groupStart"));
  assert.match(fn, /catch \(e\)/, "the error is captured");
  assert.match(fn, /log\.warn\(/, "and reported");
  assert.ok(!/catch \{\s*\/\* ignore \*\/\s*\}/.test(fn), "no silent catch left");
});

test("the greeting is wired to the update it rides on", () => {
  const reg = src("handlers/registry.js");
  assert.match(reg, /bot\.on\("my_chat_member"/, "registered");
  assert.match(reg, /start\.botAddedToGroup/, "…to the right handler");
  const block = reg.slice(reg.indexOf('bot.on("my_chat_member"'), reg.indexOf('bot.on("my_chat_member"') + 400);
  assert.match(block, /return next\(\)/, "and passes the update on — other pipelines still need it");
});

// ── The "/" menu inside a group ──────────────────────────────────────────────

test("a group's command menu lists the group commands, not start/home/help", () => {
  const { GROUP_COMMANDS, COMMANDS } = require("../src/bot");
  const names = GROUP_COMMANDS.map((c) => c.command);
  for (const c of ["settoken", "setchain", "setminbuy", "setwhale", "buybot", "raid"]) {
    assert.ok(names.includes(c), `/${c} is offered in groups`);
  }
  assert.ok(!COMMANDS.map((c) => c.command).includes("settoken"), "and the DM list is left alone");
});

test("every command offered in a group is actually registered", () => {
  // A command listed and not registered is worse than one that is missing:
  // tapping it does nothing at all, with no error to explain why.
  const { GROUP_COMMANDS } = require("../src/bot");
  const reg = src("handlers/registry.js") + src("raid/index.js");
  for (const { command } of GROUP_COMMANDS) {
    assert.match(reg, new RegExp(`bot\\.(command\\("${command}"|start)`), `/${command} has a handler`);
  }
});

test("the group list is published under the group SCOPE", () => {
  // Without the scope it overwrites the default list and every DM user loses
  // their menu.
  const bot = src("bot.js");
  assert.match(bot, /setMyCommands\(GROUP_COMMANDS, \{ scope: \{ type: "all_group_chats" \} \}\)/);
  const fn = bot.slice(bot.indexOf("async function publishCommands"));
  assert.match(fn.slice(0, 700), /\.catch\(/, "its failure must not cost the default list");
});

// ── Everything the setup flow says is editable ───────────────────────────────

test("no user-facing string is left hardcoded in the group setup commands", () => {
  const s = src("group/setup.js");
  // Every reply goes through say(key) → tpl.render. A literal sentence passed
  // to ctx.reply is one the operator cannot reword without a deploy.
  const literals = [...s.matchAll(/ctx\s*\.?\s*reply\(\s*(["'`])/g)];
  assert.strictEqual(literals.length, 0, "no ctx.reply with a literal string");
  // The KEY is what matters — that every reply names a template instead of
  // carrying a sentence. What say() takes after that is free to grow (it gained
  // an `opts` for dropEmpty), and pinning the exact arity made this fail over a
  // change that could not put a literal anywhere.
  assert.match(s, /function say\(ctx, key, vars[,)]/, "there is one helper and it takes a key");
});

test("no user-facing string is left hardcoded in the raid panel", () => {
  const s = src("raid/panel.js");
  const literals = [...s.matchAll(/ctx\s*\.?\s*reply\(\s*(["'])/g)];
  assert.strictEqual(literals.length, 0, "no ctx.reply with a literal string");
});

test("every setup and raid template is reachable in the editor", () => {
  const groups = tpl.groups();
  for (const key of [
    "group_added",
    "group_start",
    "settoken_ok",
    "settoken_not_found",
    "setwhale_ok",
    "setwhale_off",
    "buybot_status",
    "buybot_need_token",
    "group_ca",
    "pin_on",
    "setup_admin_only",
  ]) {
    assert.strictEqual(tpl.meta(key).group, "Group Setup", `${key} is in the editor`);
  }
  for (const key of ["raid_panel", "raid_group_only", "raid_bad_url", "raid_reposts_only", "raid_no_goals"]) {
    assert.strictEqual(tpl.meta(key).group, "Dexvra Raid", `${key} is in the editor`);
  }
  assert.ok(groups["Group Setup"].length >= 20, "the whole setup flow, not a sample");
});

test("every placeholder a setup template uses is one its caller passes", () => {
  // A {placeholder} nobody fills renders as empty string — silently, in a
  // customer's group. This is the cheap check that catches a rename.
  const setup = src("group/setup.js");
  for (const key of tpl.keys()) {
    if (tpl.meta(key).group !== "Group Setup") continue;
    for (const [, ph] of String(tpl.getRaw(key)).matchAll(/\{(\w+)\}/g)) {
      // baseVars supplies these to every template with no call site involved.
      if (["site", "listing", "trending", "announce", "xlisting", "bot", "botName"].includes(ph)) continue;
      assert.ok(tpl.meta(key).ph.includes(ph), `${key} uses {${ph}} — declare it in META so the editor lists it`);
      assert.match(setup, new RegExp(`\\b${ph}\\s*[,:}]`), `${key} uses {${ph}} — nothing in setup.js passes it`);
    }
  }
});

test("the setup replies are premium markup, not the HTML they used to be", () => {
  // These render through premium.parse now. A stray <b> would reach the group
  // as literal angle brackets.
  for (const key of tpl.keys()) {
    if (tpl.meta(key).group !== "Group Setup") continue;
    const raw = String(tpl.getRaw(key));
    assert.ok(!/<\/?(b|i|code|pre|a)\b/i.test(raw), `${key} still carries an HTML tag`);
  }
});
