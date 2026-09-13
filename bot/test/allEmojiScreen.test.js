// The buy card's and the raid's icons, on one screen.
//
// THE FAILURE, in the operator's own words: "saya capek set ulang 1/1".
// Restyling the buy alert meant visiting eight templates and the raid card
// twenty more — open, tap Swap emoji, choose, go back, repeat, with no way to
// know you had finished.
//
// SCOPED to those two surfaces on the operator's own instruction: "khusus buy
// alert dan raid, yang lainnya ga usah, jangan diubah apapun". The receipts and
// prompts are already styled, and a screen that changes everything is a screen
// you cannot use once you are happy with most of it.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-allemo-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");
const admin = require("../src/admin/adminBot");
const { allEmojiSlots, allEmojiKb, allEmojiText, allEmojiPages, ALL_EMOJI_PER_PAGE } = admin._allEmoji;

const flat = (kb) => kb.reply_markup.inline_keyboard.flat();

test("one screen reaches every icon on BOTH surfaces", () => {
  const slots = allEmojiSlots();
  const covered = new Set(slots.flatMap((s) => s.spots.map((p) => `${p.key}#${p.i}`)));
  const missing = [];
  for (const key of tpl.keys()) {
    if (key === "chain_emojis") continue;
    const group = tpl.meta(key).group;
    if (group !== "Group Buy Bot" && group !== "Dexvra Raid") continue;
    for (const e of tpl.listEmojis(key)) {
      if (!covered.has(`${key}#${e.i}`)) missing.push(`${key}#${e.i} ${e.char}`);
    }
  }
  assert.deepStrictEqual(missing, [], "an icon with no slot is an icon the operator cannot reach");
});

test("and it reaches NOTHING else — the rest is already styled and stays put", () => {
  // The operator's instruction, as a test: a swap aimed at a buy alert must not
  // drag a receipt or a prompt along with it.
  const touched = new Set(allEmojiSlots().flatMap((s) => s.spots.map((p) => p.key)));
  const strays = [...touched].filter((k) => {
    const g = tpl.meta(k).group;
    return g !== "Group Buy Bot" && g !== "Dexvra Raid";
  });
  assert.deepStrictEqual(strays, [], "only the buy-bot and raid groups are in scope");
  assert.ok(touched.size < tpl.keys().length / 2, "a small, deliberate slice of the templates");
});

test("the raid card is genuinely covered, not just the buy card", () => {
  const touched = new Set(allEmojiSlots().flatMap((s) => s.spots.map((p) => p.key)));
  assert.ok(touched.has("raid_card"), "the live raid card's icons are reachable here");
  assert.ok(touched.has("group_buy_alert"), "…and so are the buy card's");
});

test("identical icons are ONE tap, which is the entire point", () => {
  // An operator thinks in icons, not in template rows. The ✅ on a position row
  // and the ✅ on a receipt are one decision, and a bot whose ✅ changed in some
  // places and not others reads as broken rather than as styled.
  const slots = allEmojiSlots();
  const chars = slots.map((s) => s.char);
  assert.strictEqual(new Set(chars).size, chars.length, "no glyph appears on two buttons");
  const busiest = slots[0];
  assert.ok(busiest.spots.length > 3, `the top slot covers several places, got ${busiest.spots.length}`);
  const places = slots.reduce((n, s) => n + s.spots.length, 0);
  assert.ok(places > slots.length, `${places} places behind ${slots.length} buttons — that ratio IS the feature`);
});

test("the busiest icons come first — they are not on page four", () => {
  const slots = allEmojiSlots();
  for (let i = 1; i < slots.length; i++) {
    assert.ok(slots[i - 1].spots.length >= slots[i].spots.length, "sorted by reach, descending");
  }
});

test("each button says how many places it moves, before it is tapped", () => {
  // One tap here can change thirty-nine places. That is not a thing to discover
  // afterwards.
  const labels = flat(allEmojiKb(0)).map((b) => b.text);
  const busiest = allEmojiSlots()[0];
  assert.ok(labels.some((l) => l.includes(`×${busiest.spots.length}`)), `the reach is on the button: ${labels[0]}`);
  assert.match(allEmojiText(0), /×N/, "and the header explains what the number means");
});

test("paging covers every slot exactly once, and a button means the same slot on any page", () => {
  const slots = allEmojiSlots();
  const pages = allEmojiPages();
  const seen = [];
  for (let p = 0; p < pages; p++) {
    for (const b of flat(allEmojiKb(p))) {
      const m = /^aemx:(\d+)$/.exec(b.callback_data || "");
      if (m) seen.push(Number(m[1]));
    }
  }
  assert.deepStrictEqual([...seen].sort((a, b) => a - b), slots.map((_, i) => i), "every slot, once");
  assert.ok(pages > 1 && slots.length > ALL_EMOJI_PER_PAGE, "and it really does need paging");
});

test("network marks are NOT here — the bot picks those by chain", () => {
  // Same carve-out the buy-card screen makes: `plasma = 🟢` collides with the
  // buy-size 🟢, and folding them together would repaint every small buy the
  // day somebody rebranded a chain.
  const keys = new Set(allEmojiSlots().flatMap((s) => s.spots.map((p) => p.key)));
  assert.ok(!keys.has("chain_emojis"));
  assert.match(allEmojiText(0), /Chain emoji/, "…and the screen says where they live instead");
  assert.match(allEmojiText(0), /tidak ikut berubah/, "and that nothing else is touched");
});

test("one swap really does move every place at once", async () => {
  const before = allEmojiSlots()[0];
  assert.ok(before.spots.length > 1);
  for (const spot of before.spots) await tpl.replaceEmojiAt(spot.key, spot.i, "🦊");
  try {
    for (const spot of before.spots) {
      const now = tpl.listEmojis(spot.key)[spot.i];
      assert.strictEqual(now.char, "🦊", `${spot.key}#${spot.i} followed the swap`);
    }
    // …and it is still ONE button afterwards, not one per template.
    const fox = allEmojiSlots().find((s) => s.char === "🦊");
    assert.strictEqual(fox.spots.length, before.spots.length, "the slot did not split apart");
  } finally {
    for (const key of new Set(before.spots.map((s) => s.key))) await tpl.resetTemplate(key);
  }
});

test("the screen is one tap from the main menu", () => {
  const labels = admin._menu.mainKb().reply_markup.inline_keyboard.flat();
  assert.ok(labels.some((b) => b.callback_data === "aem:0"), "an entry on the front page");
});

test("the screen can SHOW the result — an icon on a button is not the card", () => {
  // The hint beside a button names the row the icon sits on, which is enough to
  // pick the right button and nowhere near enough to judge the result: whether
  // the new glyph is wider than the one it replaced, whether it still reads
  // under the row above it. Both surfaces this screen owns are previewable.
  const cb = flat(allEmojiKb(0)).map((b) => b.callback_data);
  assert.ok(cb.some((d) => /^aemp:\d+$/.test(d)), `a look-at-it button: ${cb.join(", ")}`);
  // And it returns to the page it was opened from, not to page one.
  const fromPage2 = flat(allEmojiKb(1)).map((b) => b.callback_data);
  assert.ok(fromPage2.includes("aemp:1"), "the preview carries the page back with it");
});

test("both cards this screen styles actually render", () => {
  // A preview that throws is worse than none: it is the screen telling an
  // operator their template is broken when it is the preview that is.
  const { renderSample } = admin._preview;
  const raid = renderSample("raid_card");
  assert.ok(raid.text.includes("Crew"), "the raid card is real");
  const buy = admin._buyEmoji.buyPreviews("buy")[0].payload;
  assert.match(buy.text, /BUY!/, "and so is the buy card");
});

test("the prompt NAMES the templates, it does not just count them", () => {
  // "6 tempat di 6 template" tells an operator the blast radius and nothing
  // about the blast: they are about to change an icon they cannot place, on
  // cards they cannot see from that screen. "untuk yang mana?" was the question,
  // and it has to be answered before the answer matters.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "admin", "adminBot.js"), "utf8");
  assert.match(src, /labels\.map\(\(l\) => `• \$\{escapeHtml\(l\)\}`\)/, "each template is listed by its own label");
  assert.match(src, /await sendSlotPreview\(ctx, slot\)/, "and the card is shown with it");
});

test("a slot previews the card it actually lives on, and only that one", () => {
  // Sending a raid card under a question about the money row is noise, and
  // noise is what an operator scrolls past instead of reading.
  const { BUY_CARD_EMOJI_KEYS } = admin._buyEmoji;
  const surfaces = (char) => {
    const slot = allEmojiSlots().find((s) => s.char === char);
    assert.ok(slot, `${char} is on the screen`);
    const keys = new Set(slot.spots.map((s) => s.key));
    return {
      buy: BUY_CARD_EMOJI_KEYS.some((k) => keys.has(k)),
      raid: [...keys].some((k) => k.startsWith("raid_")),
    };
  };
  // 💲 is the buy card's money row and has nothing to do with a raid.
  assert.deepStrictEqual(surfaces("💲"), { buy: true, raid: false });
  // 🤝 is the raid's Crew row and has nothing to do with a buy alert.
  assert.deepStrictEqual(surfaces("🤝"), { buy: false, raid: true });
});

test("a button carries the slot's NAME, so a swapped icon stays findable", () => {
  // A button showing only the current glyph becomes unfindable the moment it is
  // swapped: change 🤝 for a premium emoji whose fallback is ⚡ and the row
  // reads "💎⚡ ×6", so an operator hunting for Crew cannot see it and reports
  // it as missing. That is exactly what happened.
  // ACROSS EVERY PAGE, not page 0. The screen is paginated and ordered by how
  // many places a slot covers, so which page a name lands on shifts whenever a
  // template is added — and that is not what this test is about. Pinning page 0
  // made a new template group look like a lost button.
  const labels = [];
  for (let p = 0; p < allEmojiPages(); p++) labels.push(...flat(allEmojiKb(p)).map((b) => b.text));
  for (const name of ["Crew", "Chart", "Likes"]) {
    assert.ok(labels.some((l) => l.includes(name)), `"${name}" is on a button somewhere: ${labels.slice(0, 6).join(" | ")}`);
  }
  const named = allEmojiSlots().filter((s) => s.label).length;
  assert.ok(named > allEmojiSlots().length / 2, `${named} of ${allEmojiSlots().length} slots know their own name`);
});

test("the raid preview is built by the RAID'S OWN builder, not a typed lookalike", async () => {
  // SAMPLE_VARS.progress was a literal string with ❤️ 💬 🤝 ▰ ▱ typed into it,
  // so the preview showed those five PLAIN whatever the operator had set. They
  // swapped them for premium, opened the preview, saw bare glyphs and reported
  // the swap as broken — when the swap had worked and the preview was lying.
  const { renderSample } = admin._preview;
  await tpl.replaceEmojiAt("raid_style", 0, "[❤️](emoji/111)");
  try {
    const card = renderSample("raid_card");
    const prem = (card.entities || []).filter((e) => e.type === "custom_emoji" && e.custom_emoji_id === "111");
    assert.strictEqual(prem.length, 1, "the preview shows what the group would actually receive");
    assert.strictEqual(card.text.substr(prem[0].offset, prem[0].length), "❤️");
  } finally {
    await tpl.resetTemplate("raid_style");
  }
});

test("no two icons share a name, and none is named after a stray word", () => {
  // emojiHint reads the first word after the icon — right on a data row
  // ("💲 {usd}" → usd), worthless in a sentence: "❌ That isn't an X post link"
  // → "That", and BOTH "⌛ RAID EXPIRED" and "🛑 RAID STOPPED" → "RAID", which
  // put two different icons on the screen under one meaningless name.
  const slots = allEmojiSlots();
  const named = slots.filter((s) => s.label);
  assert.strictEqual(named.length, slots.length, "every icon on this screen has a name");
  const names = named.map((s) => s.label.toLowerCase());
  assert.strictEqual(new Set(names).size, names.length, `no duplicate names: ${names.join(", ")}`);
  // The specific words the heuristic produced, as a regression guard.
  for (const junk of ["that", "every", "raid"]) {
    const dupes = named.filter((s) => s.label.toLowerCase() === junk);
    assert.ok(dupes.length <= 1, `"${junk}" must not name several icons`);
  }
});

test("a curated name survives the swap that hides the icon", () => {
  // Keyed on the glyph the CODE ships, so the operator who changed ⌛ for
  // something else still reads "expired" rather than hunting for an hourglass
  // that is no longer there.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "admin", "adminBot.js"), "utf8");
  assert.match(src, /EMOJI_NAMES\[identity\] \|\| emojiHint/, "curated first, derived as the fallback");
  const slots = allEmojiSlots();
  for (const want of ["expired", "stopped", "bad link", "group only"]) {
    assert.ok(slots.some((s) => s.label === want), `"${want}" is on the screen`);
  }
});
