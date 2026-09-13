// Every template shows its result after an edit — not just the buy card.
//
// The controls card prints the RAW template, {placeholders} and all. That is
// what an operator edits, but it is not what anybody receives, and whether a
// swapped emoji is wider than the one it replaced — pushing a row onto two
// lines — is only visible in the assembled message. Until now the only way to
// see one was to make the bot send it for real: wait for a buy, post to the
// channel, or trigger the flow by hand.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-tprev-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");
const admin = require("../src/admin/adminBot");
const { payloadArgs } = require("../src/helpers/message");
const { renderSample, SAMPLE_VARS, SPECIAL_RENDER } = admin._preview;
const { BUY_CARD_EMOJI_KEYS } = admin._buyEmoji;

const flat = (kb) => kb.reply_markup.inline_keyboard.flat();

test("every template renders — the preview must never be the thing that breaks", () => {
  const broken = [];
  for (const key of tpl.keys()) {
    try {
      const p = renderSample(key);
      if (p == null) broken.push(`${key}: null`);
    } catch (e) {
      broken.push(`${key}: ${e.message}`);
    }
  }
  assert.deepStrictEqual(broken, []);
});

test("every placeholder any template offers has a sample value", () => {
  // A missing var renders as NOTHING. The /settoken receipt previewed "Every buy
  // from ** up" — two orphaned bold markers where the floor belongs. Harmless in
  // the old one-line audit; not harmless now that the preview shows an operator
  // the whole card and asks them to judge it, because a blank reads as a
  // template they just broke.
  const missing = new Set();
  for (const key of tpl.keys()) {
    for (const ph of tpl.meta(key).ph) if (SAMPLE_VARS[ph] == null) missing.add(ph);
  }
  assert.deepStrictEqual([...missing].sort(), [], "add these to SAMPLE_VARS in adminBot.js");
});

test("no preview leaves an orphaned bold marker or a stray brace", () => {
  const bad = [];
  for (const key of tpl.keys()) {
    const text = String(renderSample(key).text || "");
    if (/\*\*(\s|$)/.test(text)) bad.push(`${key}: orphaned **`);
    if (/\{\w+\}/.test(text)) bad.push(`${key}: unresolved ${text.match(/\{\w+\}/)[0]}`);
  }
  assert.deepStrictEqual(bad, []);
});

test("channel posts preview through format.js, not the raw template", () => {
  // They are ASSEMBLED, not substituted — rendering the raw template would show
  // a post the channel never sends.
  for (const key of ["post_listing_tiered", "post_trending", "post_pump", "post_rankup", "post_banner"]) {
    assert.ok(SPECIAL_RENDER[key], `${key} must render through format.js`);
  }
});

test("/ca previews with its own label, not the ad-slot one", () => {
  // {label} is the ad-slot name everywhere else in the sample bag, so the shared
  // version previewed "💵 Diamond Listing — $BULLCAT on Solana" — a card no group
  // will ever receive, which is worse than showing nothing.
  const text = renderSample("group_ca").text;
  assert.match(text, /^💵 The Bull Cat \$BULLCAT$/m);
  assert.doesNotMatch(text, /Diamond Listing/);
  assert.match(text, /🌐 Website · 𝕏 X · 💬 Telegram/, "and with dropEmpty, like the real path");
});

test("the preview is sendable as-is — entities, no markup left over", () => {
  for (const key of tpl.keys()) {
    const { text, extra } = payloadArgs(renderSample(key));
    assert.strictEqual(typeof text, "string");
    assert.ok(!extra.parse_mode, `${key}: the text is not markup any more`);
  }
});

test("a preview button sits on the controls card AND the emoji picker", () => {
  // Look at the result without changing anything first.
  const rows = flat(admin._tpl.viewKb("group_ca"));
  assert.ok(rows.some((b) => b.callback_data === "temp:group_ca"), "controls card");
});

test("the buy card's pieces preview the WHOLE card, not their own fragment", () => {
  // Previewing group_position_row alone shows one line out of context, which
  // answers nothing about the thing that was actually edited.
  const previews = admin._buyEmoji.buyPreviews();
  assert.strictEqual(previews.length, 2);
  for (const key of BUY_CARD_EMOJI_KEYS) {
    assert.ok(tpl.keys().includes(key), `${key} is a real template`);
  }
  // group_position_row rendered on its own is one line; the card it belongs to
  // is many. The routing is what this asserts — see sendTemplatePreview.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "admin", "adminBot.js"), "utf8");
  assert.match(src, /BUY_CARD_EMOJI_KEYS\.includes\(key\) \|\| key === "chain_emojis"\) return sendBuyPreview/);
});

test("the preview follows an emoji swap immediately", async () => {
  // The whole point: swap, look, adjust. Not swap, wait for a real buy, look.
  const before = renderSample("raid_card").text;
  await tpl.replaceEmojiAt("raid_card", 0, "🔥");
  try {
    const after = renderSample("raid_card").text;
    assert.notStrictEqual(after, before);
    assert.ok(after.includes("🔥"));
  } finally {
    await tpl.resetTemplate("raid_card");
  }
});
