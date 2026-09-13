// Group buy bot — address→chain candidate probing, emoji scaling, and the
// config store.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-grp-"));

const test = require("node:test");
const assert = require("node:assert");
const mon = require("../src/group/buyMonitor");
const setup = require("../src/group/setup");
const cfg = require("../src/group/config");

test("there is no volume estimator to fall back to", () => {
  // It diffed the rolling 24h volume and posted "≈ $340 across 11 buys" with no
  // transaction to link — and suppressed the real alerts for those same buys,
  // because an estimate has no hash for the latch to dedupe on. A GT rate-limit
  // cooldown was enough to replace a group's verifiable alerts with one summary
  // it could not check. Deleted, and this is what keeps it deleted.
  assert.strictEqual(typeof mon.estimateBuys, "undefined");
  assert.strictEqual(typeof mon.renderEstimateAlert, "undefined");
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "buyMonitor.js"), "utf8");
  assert.ok(!/async function pollEstimate/.test(src), "and no poller for it");
  assert.ok(!require("../src/templates").getRawValue("group_buy_alert_est"), "and no template to render");
});

// Icons are space-separated (premium icons render as wide art tiles, and a
// crammed row wrapped on phones), so count icons, not code units.
const glyphs = (s) => s.split(" ").filter(Boolean).length;

test("buyEmojiRow scales with size, and is floored AND capped", () => {
  assert.strictEqual(glyphs(mon.buyEmojiRow(500)), 8); // one per $50, capped at 8
  assert.strictEqual(glyphs(mon.buyEmojiRow(1_000_000)), 8); // capped, never a wall
  assert.strictEqual(glyphs(mon.buyEmojiRow(0)), 3); // floored, never empty
  // The cap is the point: an uncapped row wraps on a phone — premium tiles
  // even sooner than unicode — and pushes the numbers off the first screen.
  assert.ok(glyphs(mon.buyEmojiRow(9e9)) <= 8);
});

test("candidateChains guesses by address shape", () => {
  assert.deepStrictEqual(setup.candidateChains("0x" + "a".repeat(40)).slice(0, 2), ["ethereum", "bsc"]);
  assert.deepStrictEqual(setup.candidateChains("T" + "1".repeat(33)), ["tron"]);
  assert.deepStrictEqual(setup.candidateChains("EQabcdef"), ["ton"]);
  assert.deepStrictEqual(setup.candidateChains("0xabc::coin::COIN"), ["sui"]);
  assert.deepStrictEqual(setup.candidateChains("So1anaBase58Mint"), ["solana"]);
});

test("config store: upsert, active filter, remove", async () => {
  await cfg.upsert(123, { chain: "solana", address: "AAA", pairAddress: "P", on: true });
  assert.strictEqual(cfg.get(123).address, "AAA");
  assert.strictEqual(cfg.active().length, 1);
  // off → not active
  await cfg.upsert(123, { on: false });
  assert.strictEqual(cfg.active().length, 0);
  // on but no token → not active
  await cfg.upsert(456, { on: true });
  assert.strictEqual(cfg.active().length, 0);
  await cfg.remove(123);
  assert.strictEqual(cfg.get(123), null);
});

// ── The main-menu entry point ────────────────────────────────────────────────

test("the group button opens Telegram's group picker on the FIRST tap", () => {
  // It used to be a callback opening a how-to card whose only real content was
  // another button saying "➕ Add to your group" — one screen between the
  // operator and the thing they had already chosen.
  const { mainMenu } = require("../src/handlers/menu");
  const rows = mainMenu().reply_markup.inline_keyboard;
  const btn = rows.flat().find((b) => /group/i.test(b.text));
  assert.ok(btn, "the group entry is still on the main menu");
  assert.ok(!btn.callback_data, "no intermediate screen");
  assert.match(btn.url, /^https:\/\/t\.me\/[^/?]+\?startgroup=/, "a ?startgroup deep link");
});

test("the deep link points at THIS bot, never a hardcoded handle", () => {
  // Nothing calls getMe, so BOT_USERNAME is used verbatim. Hardcode a handle
  // here and every operator running their own instance is sending their users
  // to add somebody else's bot to their group — and this is now the most-tapped
  // button on the menu, not a link buried two screens deep.
  const { BOT_USERNAME, addToGroupUrl } = require("../src/config/constants");
  const { mainMenu } = require("../src/handlers/menu");
  const btn = mainMenu()
    .reply_markup.inline_keyboard.flat()
    .find((b) => /group/i.test(b.text));
  // Built by the shared helper, so this button cannot drift from the one on the
  // already-listed card. What the link CARRIES beyond the handle — the admin
  // rights — is test/addToGroup.test.js's business, not this test's.
  assert.strictEqual(btn.url, addToGroupUrl());
  assert.match(btn.url, new RegExp(`^https://t\\.me/${BOT_USERNAME}\\?startgroup=true`));
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "handlers", "menu.js"), "utf8");
  assert.ok(!/t\.me\/dexvrabot/.test(src), "the handle is read from config, not written in");
});

test("landing in a group still explains itself, which is what the skipped card said", () => {
  // Dropping the DM how-to costs nothing because the two in-group messages
  // cover it between them, in the place the work is actually done: group_added
  // (my_chat_member) asks for the rights, group_start (/start) points the bot
  // at a token. Asserted as a PAIR, not against one template — which of the two
  // carries which half is a copy decision, and pinning it to group_start is how
  // this test failed the moment the admin ask moved to where it belongs.
  const tpl = require("../src/templates");
  const flow = tpl.t("group_added") + "\n" + tpl.t("group_start", { bot: "@dexvrabot" });
  assert.match(flow, /admin/i, "it says the bot needs admin rights");
  assert.match(flow, /buy bot/i, "and names the thing it is here to do");
  // It used to assert the text named /settoken. That is a BUTTON now, so the
  // half of the flow that starts the buy bot lives on the keyboard — asserting
  // it against the copy would only pass again by putting the syntax back.
  const kb = require("../src/handlers/start").groupStartKeyboard();
  assert.ok(
    kb.inline_keyboard.flat().some((b) => b.callback_data === "bs_buybot"),
    "and the card carries the one tap that starts it",
  );
});
