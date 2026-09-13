// The group welcome card's inline keyboard.
//
// Every feature here already worked; none of it was reachable without typing a
// command. A group admin who has just added a bot is looking for something to
// press, so Buy Bot and Raid now sit on the card itself.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-gsb-"));

const test = require("node:test");
const assert = require("node:assert");
const start = require("../src/handlers/start");
const tpl = require("../src/templates");

const flat = (kb) => kb.inline_keyboard.flat();
const dataOf = (kb) => flat(kb).filter((b) => b.callback_data).map((b) => b.callback_data);

test("Buy Bot and Raid are one tap from the welcome card", () => {
  const kb = start.groupStartKeyboard();
  const data = dataOf(kb);
  assert.ok(data.includes("bs_buybot"), "buy bot");
  assert.ok(data.includes("gs_raid"), "raid");
  assert.ok(data.includes("bs_home"), "settings");
});

test("every button carries exactly one of callback_data or url", () => {
  // Telegram rejects the WHOLE message for a button with neither or both, which
  // would take the welcome card down entirely — the failure is not local to the
  // button.
  for (const b of flat(start.groupStartKeyboard())) {
    assert.ok(b.text && b.text.trim(), "a button with no label");
    const kinds = ["callback_data", "url"].filter((k) => b[k]);
    assert.strictEqual(kinds.length, 1, `${b.text}: expected one of callback_data/url, got ${kinds.length}`);
    if (b.url) assert.match(b.url, /^https:\/\//, `${b.text}: not an https URL`);
    // Telegram's own limit; a longer one is rejected at send time.
    if (b.callback_data) assert.ok(Buffer.byteLength(b.callback_data) <= 64, `${b.text}: callback_data too long`);
  }
});

test("a link button is dropped rather than sent malformed", () => {
  // SITE_URL and the announce channel are env-driven and can be blank or junk on
  // someone else's instance. One bad URL fails the send for the whole card, so
  // the button has to vanish instead.
  const realSite = process.env.SITE_URL;
  try {
    delete require.cache[require.resolve("../src/config/constants")];
    delete require.cache[require.resolve("../src/handlers/start")];
    process.env.SITE_URL = "dexvra.io"; // no scheme — Telegram rejects it
    const fresh = require("../src/handlers/start");
    assert.ok(
      !flat(fresh.groupStartKeyboard()).some((b) => b.url && !/^https:\/\//.test(b.url)),
      "no schemeless URL survives into the keyboard",
    );
  } finally {
    if (realSite === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = realSite;
    delete require.cache[require.resolve("../src/config/constants")];
    delete require.cache[require.resolve("../src/handlers/start")];
  }
});

test("labels fall back field by field, so a half-typed override still renders", () => {
  const real = tpl.t;
  try {
    tpl.t = (k) => (k === "group_start_buttons" ? "Beli||" : real(k));
    const labels = flat(start.groupStartKeyboard()).map((b) => b.text);
    assert.strictEqual(labels[0], "Beli", "the one that was set");
    assert.ok(labels.every((l) => l && l.trim()), "and nothing blank behind it");
  } finally {
    tpl.t = real;
  }
});

test("the card stops telling people to type the commands the buttons replaced", () => {
  // Leaving the syntax in makes the buttons look optional, which is how a
  // feature ends up with two front doors and neither obviously the right one.
  const card = tpl.DEFAULTS.group_start;
  for (const cmd of ["/settoken", "/setminbuy", "/setwhale", "/raid", "/buybot"]) {
    assert.ok(!card.includes(cmd), `${cmd} is a button now, not an instruction`);
  }
});

test("every callback the card offers is actually registered", () => {
  // A button wired to nothing is worse than no button: it looks like the
  // feature is broken rather than absent.
  const reg = fss.readFileSync(path.join(__dirname, "..", "src", "handlers", "registry.js"), "utf8");
  for (const cb of dataOf(start.groupStartKeyboard())) {
    const handled = reg.includes(`"${cb}"`) || /bs_\(\[a-z\]\+\)/.test(reg) && cb.startsWith("bs_");
    assert.ok(handled, `${cb} has no handler`);
  }
  assert.match(reg, /gs_raid/, "the raid button is wired");
  const setup = fss.readFileSync(path.join(__dirname, "..", "src", "group", "setup.js"), "utf8");
  assert.match(setup, /what === "buybot"/, "and bs_buybot has a branch in the settings hub");
});
