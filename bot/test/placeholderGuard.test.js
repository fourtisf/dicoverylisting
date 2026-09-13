// A saved template can break its own placeholders, and only the editor can say so.
//
// A group's buy card went out reading "{💎}" where its size row belongs.
// Something had turned {emoji} into {💎} — most likely an emoji swap landing on
// the wrong span — and nothing objected, because a mangled placeholder is just
// text. It renders as text, in a customer's group, under their ticker. By the
// time an alert posts it is far too late to notice.
//
// So the check runs where a human is looking: on the controls card, every time
// the template is opened, not only after a save. The template that broke was
// ALREADY broken; an operator opening it has to be told, not left to spot a
// stray brace in a wall of copy.
//
// A WARNING, never a refusal — deleting a placeholder on purpose is the whole
// point of editing a template.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-phguard-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");
const { placeholderWarning, viewText } = require("../src/admin/adminBot")._tpl;

test("a {} whose contents are not a name is mangled — nothing will fill it", () => {
  assert.deepStrictEqual(tpl.mangledPlaceholders("size row: {💎} here"), ["{💎}"]);
  assert.deepStrictEqual(tpl.mangledPlaceholders("{emo ji} {tier-2}"), ["{emo ji}", "{tier-2}"]);
  // Real placeholders, and prose that merely contains braces, are not flagged.
  assert.deepStrictEqual(tpl.mangledPlaceholders("{emoji} {tokenAmt} {usd}"), []);
});

test("a placeholder the default had and the save does not is reported as dropped", () => {
  const def = String(tpl.DEFAULTS.group_buy_alert);
  assert.deepStrictEqual(tpl.missingPlaceholders("group_buy_alert", def), []);
  assert.deepStrictEqual(tpl.missingPlaceholders("group_buy_alert", def.replace("{emoji}", "{💎}")), ["emoji"]);
});

test("both readings apply to an entity-saved template, not just a plain string", () => {
  // Premium-pasted templates are stored as {text, entities}; the placeholders
  // live in .text, and reading the object with String() would see [object Object]
  // and find nothing wrong with anything.
  const val = { text: "{💎} {usd}", entities: [{ type: "bold", offset: 0, length: 3 }] };
  assert.deepStrictEqual(tpl.mangledPlaceholders(val), ["{💎}"]);
});

test("opening the template announces the break — it does not wait for the next save", async () => {
  await tpl.setTemplate("group_buy_alert", String(tpl.DEFAULTS.group_buy_alert).replace("{emoji}", "{💎}"));
  try {
    const card = viewText("group_buy_alert");
    assert.match(card, /Placeholder rusak/);
    assert.match(card, /\{💎\}/);
    assert.match(card, /Tidak lagi dipakai/); // {emoji} went missing with it
    assert.match(card, /Reset default/); // and how to get it back
  } finally {
    await tpl.resetTemplate("group_buy_alert");
  }
});

test("a healthy template says nothing at all", async () => {
  assert.strictEqual(placeholderWarning("group_buy_alert"), "");
  assert.doesNotMatch(viewText("group_buy_alert"), /Placeholder rusak/);
});

test("dropping a placeholder deliberately is a note, not an alarm", async () => {
  // No braces harmed — just a shorter card. That is allowed, and the wording
  // has to read as informational or operators learn to ignore the real one.
  await tpl.setTemplate("group_buy_alert", "{nameRow}\n💲 {usd}");
  try {
    const w = placeholderWarning("group_buy_alert");
    assert.doesNotMatch(w, /rusak/);
    assert.match(w, /Tidak lagi dipakai/);
  } finally {
    await tpl.resetTemplate("group_buy_alert");
  }
});
