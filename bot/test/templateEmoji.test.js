// Swapping ONE emoji in a template, without re-sending the whole message.
//
// The hard part is the {text, entities} form an admin creates by pasting a
// message with premium emoji: replacing text in the MIDDLE means re-mapping
// every entity offset after the cut. Get it wrong and the premium emoji slide
// onto the wrong characters — silently, in a live channel post.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-temoji-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");
const premium = require("../src/premium");

const KEY = "session_expired"; // small, and its default is a plain markup string

test("lists every emoji in a default template, in reading order", () => {
  // `welcome` is the emoji-heaviest default and stays that way; the receipts got
  // deliberately terse, so they are a poor sample for "several emoji".
  const list = tpl.listEmojis("welcome");
  assert.ok(list.length >= 5, `expected several emoji, got ${list.length}`);
  assert.deepStrictEqual(list.map((e) => e.i), list.map((_, i) => i), "indexed 0..n in order");
  assert.ok(list.every((e) => e.start < e.end), "each carries its own span");
  // Reading order, not match order.
  for (let i = 1; i < list.length; i++) assert.ok(list[i].start > list[i - 1].start);
});

test("keycaps, flags and ZWJ sequences count as ONE emoji each", async () => {
  await tpl.setTemplate(KEY, "1️⃣ a 🇮🇩 b 👨‍👩‍👧 c ⚡");
  try {
    assert.deepStrictEqual(tpl.listEmojis(KEY).map((e) => e.char), ["1️⃣", "🇮🇩", "👨‍👩‍👧", "⚡"]);
  } finally {
    await tpl.resetTemplate(KEY);
  }
});

test("markup template: swap plain → premium, and premium → plain", async () => {
  await tpl.setTemplate(KEY, "⌛ Your session expired — send /start.");
  try {
    await tpl.replaceEmojiAt(KEY, 0, "[🔥](emoji/5445284980978621387)");
    const raw = tpl.getRawValue(KEY);
    assert.ok(String(raw).startsWith("[🔥](emoji/5445284980978621387)"), raw);
    assert.ok(String(raw).includes("session expired"), "the rest of the text is untouched");
    // The stored markup renders to a real custom_emoji entity.
    const p = premium.parse(String(raw));
    assert.ok(p.entities.some((e) => e.type === "custom_emoji"), "renders premium");
    assert.strictEqual(tpl.listEmojis(KEY)[0].id, "5445284980978621387");
    // …and back to a plain one.
    await tpl.replaceEmojiAt(KEY, 0, "✅");
    assert.ok(String(tpl.getRawValue(KEY)).startsWith("✅ Your session"), tpl.getRawValue(KEY));
    assert.strictEqual(tpl.listEmojis(KEY)[0].id, null);
  } finally {
    await tpl.resetTemplate(KEY);
  }
});

test("entity template: the OTHER entities keep their characters", async () => {
  // "⌛ Session over — read the docs" with bold on "Session over" and a link on
  // "docs", plus a premium emoji at the front.
  const text = "⌛ Session over — read the docs";
  const entities = [
    { type: "custom_emoji", offset: 0, length: 1, custom_emoji_id: "111" },
    { type: "bold", offset: 2, length: 12 },
    { type: "text_link", offset: 26, length: 4, url: "https://dexvra.io" },
  ];
  assert.strictEqual(text.substr(2, 12), "Session over");
  assert.strictEqual(text.substr(26, 4), "docs");
  await tpl.setTemplate(KEY, { text, entities });
  try {
    // ⌛ (1 unit) → 🔥 (2 units): everything after the cut must shift by +1.
    await tpl.replaceEmojiAt(KEY, 0, "[🔥](emoji/222)");
    const v = tpl.getRawValue(KEY);
    assert.ok(v.text.startsWith("🔥 Session over"), v.text);
    const bold = v.entities.find((e) => e.type === "bold");
    const link = v.entities.find((e) => e.type === "text_link");
    const ce = v.entities.find((e) => e.type === "custom_emoji");
    assert.strictEqual(v.text.substr(bold.offset, bold.length), "Session over", "bold still covers its words");
    assert.strictEqual(v.text.substr(link.offset, link.length), "docs", "the link still covers 'docs'");
    assert.strictEqual(link.url, "https://dexvra.io", "…and still points where it did");
    assert.strictEqual(ce.custom_emoji_id, "222", "the new premium id replaced the old one");
    assert.strictEqual(v.text.substr(ce.offset, ce.length), "🔥", "…on ITS character");
    assert.strictEqual(v.entities.filter((e) => e.type === "custom_emoji").length, 1, "no leftover from the old one");
  } finally {
    await tpl.resetTemplate(KEY);
  }
});

test("entity template: swapping a LATER emoji doesn't disturb earlier entities", async () => {
  const text = "⚡ Fast · ⌛ Slow";
  const entities = [
    { type: "custom_emoji", offset: 0, length: 1, custom_emoji_id: "aaa" },
    { type: "bold", offset: 2, length: 4 },
  ];
  await tpl.setTemplate(KEY, { text, entities });
  try {
    await tpl.replaceEmojiAt(KEY, 1, "🔥"); // the second emoji
    const v = tpl.getRawValue(KEY);
    assert.strictEqual(v.text, "⚡ Fast · 🔥 Slow");
    const ce = v.entities.find((e) => e.type === "custom_emoji");
    assert.strictEqual(ce.offset, 0, "the untouched premium emoji stayed put");
    const bold = v.entities.find((e) => e.type === "bold");
    assert.strictEqual(v.text.substr(bold.offset, bold.length), "Fast");
  } finally {
    await tpl.resetTemplate(KEY);
  }
});

test("bad input is refused, not half-applied", async () => {
  await tpl.setTemplate(KEY, "⌛ hi");
  try {
    await assert.rejects(() => tpl.replaceEmojiAt(KEY, 9, "🔥"), /no emoji/i);
    await assert.rejects(() => tpl.replaceEmojiAt(KEY, 0, "   "), /single emoji/i);
    assert.strictEqual(tpl.getRawValue(KEY), "⌛ hi", "template untouched after a refused edit");
  } finally {
    await tpl.resetTemplate(KEY);
  }
});
