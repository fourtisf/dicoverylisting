// "Add Buy Bot / Raid" must open the GROUP PICKER on the first tap.
//
// The "already listed" card's button was a callback: it opened a how-to screen
// whose one piece of real content was another button saying "➕ Add to your
// group". A screen standing between the operator and the thing they had already
// tapped, and a second tap most people never made. The main menu had already
// skipped that trip — the two had simply drifted apart.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-a2g-"));

const test = require("node:test");
const assert = require("node:assert");
const { addToGroupUrl, ADD_TO_GROUP_RIGHTS, BOT_USERNAME } = require("../src/config/constants");

/** Every button on a keyboard, flattened. */
const flat = (kb) => (kb.reply_markup ? kb.reply_markup.inline_keyboard : kb.inline_keyboard).flat();
/** The buttons offering to put the bot in a group. */
const addBtns = (kb) => flat(kb).filter((b) => /add .*(buy bot|raid)|add to your group/i.test(b.text));

test("the link opens Telegram's own group picker", () => {
  const url = addToGroupUrl();
  assert.match(url, new RegExp(`^https://t\\.me/${BOT_USERNAME}\\?startgroup=true`));
});

test("it asks for exactly the rights the code uses — no more", () => {
  // Added as a plain member the bot posts buy alerts fine, so everything LOOKS
  // healthy while whale alerts never pin, the raid panel cannot tidy up after
  // itself, and /raid lock does nothing. Three features failing silently, days
  // apart, with no error anywhere. `admin=` ticks the boxes in the add dialog.
  //
  // And no more than that: rights we never exercise are how an add dialog
  // starts looking like something to refuse.
  assert.deepStrictEqual(ADD_TO_GROUP_RIGHTS.split("+").sort(), [
    "delete_messages", // raid panel replacing itself   — raid/runner
    "pin_messages", //    whale alerts + the raid panel — group/buyMonitor, raid/runner
    "restrict_members", // /raid lock                    — raid/lock
  ]);
  assert.match(addToGroupUrl(), /[?&]admin=/);
});

test("the main menu's button goes straight there", () => {
  const menu = require("../src/handlers/menu");
  const btns = addBtns(menu.mainMenu());
  assert.strictEqual(btns.length, 1);
  assert.strictEqual(btns[0].url, addToGroupUrl());
});

test("the already-listed card's button goes straight there too", () => {
  // The one that did not, and the reason for this file.
  const listed = require("../src/helpers/listedGuard");
  const kb = listed._test
    ? listed._test.listedKeyboard({ chain: "bsc", address: "0x" + "a".repeat(40), sym: "JACKET" })
    : null;
  assert.ok(kb, "listedKeyboard must be reachable for this to be testable");
  const btns = addBtns(kb);
  assert.strictEqual(btns.length, 1);
  assert.strictEqual(btns[0].url, addToGroupUrl(), "a URL button, not a callback");
  assert.ok(!btns[0].callback_data, "a callback would cost a second tap");
});

test("no add-the-bot button anywhere is still a callback", () => {
  // The drift this file exists to stop: one entry point fixed, another left
  // behind, and nothing saying the two disagree.
  const menu = require("../src/handlers/menu");
  const listed = require("../src/helpers/listedGuard");
  const kbs = [menu.mainMenu(), listed._test.listedKeyboard({ chain: "bsc", address: "0x1", sym: "X" })];
  for (const kb of kbs) for (const b of addBtns(kb)) assert.ok(b.url, `"${b.text}" must be a URL button`);
});

test("the how-to handler survives for buttons already sent", () => {
  // Inline keyboards live forever in chat history. Nothing emits `buybot_help`
  // now, but an old card somebody scrolls back to must still do something.
  const registry = fss.readFileSync(path.join(__dirname, "..", "src", "handlers", "registry.js"), "utf8");
  assert.match(registry, /bot\.action\("buybot_help"/);
});
