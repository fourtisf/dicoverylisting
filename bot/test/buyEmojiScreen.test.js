// Every icon on the buy card, on one screen, without rewriting a word of it.
//
// Restyling the buy alert used to mean visiting EIGHT templates: the banner in
// group_buy_intro, the size icons in group_buy_style, the buyer row, the
// Position tick, the network mark in chain_emojis, and the 💲🪙📊 column in
// group_buy_alert — with group_whale_alert carrying its own copy of that column.
// Eight screens, each with its own "😀 Swap emoji", and the only way to change
// an icon in some of them was to retype the whole card.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-bemo-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");
const mon = require("../src/group/buyMonitor");
const admin = require("../src/admin/adminBot");
const { buyEmojiSlots, buyEmojiKb, buyEmojiText, BUY_CARD_EMOJI_KEYS } = admin._buyEmoji;

const g = { chatId: "-1", chain: "solana", address: "So1", sym: "ALON", name: "alon", minBuyUsd: 0 };
const buy = { txHash: "t", buyer: "GDAtwgaaaaaaaaaaaaaaaaaaaaaaaaZ7tX", usd: 40, tokenAmount: 100 };
const pool = { priceUsd: 1, mcap: 1, liquidity: 1, change24h: 1 };
const pos = { held: 100, holdsUsd: 100, position: "+1%" };

/** Simulate the save path: one emoji, written to every spot the slot owns. */
async function swap(slot, to) {
  for (const t of slot.spots) await tpl.replaceEmojiAt(t.key, t.i, to);
}
const slotFor = (char) => buyEmojiSlots().find((s) => s.char === char && !s.chain);
const chainSlot = (label) => buyEmojiSlots().find((s) => s.chain && s.label === label);
const reset = () => Promise.all([...BUY_CARD_EMOJI_KEYS, "chain_emojis"].map((k) => tpl.resetTemplate(k)));

test("every icon the rendered card shows is reachable from this one screen", async () => {
  // The whole promise of the screen. If a card icon has no slot, the operator is
  // back to hunting through eight templates for the one that owns it.
  const card = mon.renderRealAlert(g, buy, pool, pos).text;
  const whale = tpl.render("group_whale_alert", mon.alertVars(g, buy, pool, pos)).text;
  const covered = new Set(buyEmojiSlots().map((s) => s.char));
  const onCards = [...new Set([...(card + whale).matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]))];
  assert.deepStrictEqual(onCards.filter((c) => !covered.has(c)), []);
});

test("swapping one slot moves BOTH cards — they are deliberately one grammar", async () => {
  // 💲 exists in group_buy_alert AND group_whale_alert. Every drift between
  // these two cards happened because one of them was edited alone.
  const slot = slotFor("💲");
  assert.strictEqual(slot.spots.length, 2, "the money row lives on both cards");
  await swap(slot, "🤑");
  try {
    assert.match(mon.renderRealAlert(g, buy, pool, pos).text, /^🤑 /m);
    assert.match(tpl.render("group_whale_alert", mon.alertVars(g, buy, pool, pos)).text, /^🤑 /m);
  } finally {
    await reset();
  }
});

test("a chain mark is NOT folded into a card icon that happens to look the same", async () => {
  // `plasma = 🟢` and the 🟢 buy-size icon are the same character and completely
  // different settings. Folding them would repaint every small buy the day
  // somebody rebranded a network — and the collision list is not fixed, so this
  // stays true whatever rows the cards gain.
  await swap(chainSlot("plasma"), "🥑");
  try {
    assert.strictEqual(slotFor("🟢").label, "buy", "the size icon is untouched");
    assert.match(mon.renderRealAlert(g, buy, pool, pos).text, /🟢/, "small buys still show 🟢");
  } finally {
    await reset();
  }
});

test("swapping a chain mark repaints only that network", async () => {
  await swap(chainSlot("solana"), "🦊");
  try {
    assert.match(mon.alertVars(g, buy, pool, pos).nameRow, /^🦊 /);
    assert.match(mon.alertVars({ ...g, chain: "base" }, buy, pool, pos).nameRow, /^🔵 /);
  } finally {
    await reset();
  }
});

test("the template's TEXT is never touched — only the character changes", async () => {
  // The point of the screen: an operator restyling the card must not have to
  // retype it, and must not risk mangling a {placeholder} while doing so.
  const before = String(tpl.getRawValue("group_buy_alert"));
  await swap(slotFor("🪙"), "🌕");
  try {
    assert.strictEqual(String(tpl.getRawValue("group_buy_alert")), before.replace("🪙", "🌕"));
    assert.strictEqual(admin._tpl.placeholderWarning("group_buy_alert"), "", "no placeholder disturbed");
  } finally {
    await reset();
  }
});

test("a premium emoji survives the swap, and the slot then shows 💎", async () => {
  await swap(slotFor("🚨"), "[🔥](emoji/5445284980978621387)");
  try {
    const s = slotFor("🔥");
    assert.strictEqual(s.id, "5445284980978621387");
    assert.match(buyEmojiText(), /💎 1 emoji sudah premium/);
  } finally {
    await reset();
  }
});

test("each button says what its icon is for, read out of the template itself", () => {
  // Derived, not hand-written: a hand-written table is a second copy of the
  // card's layout and starts lying the first time somebody rewords a row.
  const label = (c) => slotFor(c).label;
  assert.strictEqual(label("💲"), "usd");
  assert.strictEqual(label("📈"), "Chart");
  assert.strictEqual(label("✅"), "Position");
  assert.strictEqual(label("🟢"), "buy", "a pipe list has no words — the field position is the meaning");
  assert.strictEqual(chainSlot("solana").char, "🟣");
});

test("the hint follows a reworded row instead of going stale", async () => {
  await tpl.setTemplate("group_buyer_row", "👤 Pembeli {buyer}{txn}");
  try {
    assert.strictEqual(slotFor("👤").label, "Pembeli");
  } finally {
    await reset();
  }
});

test("the way in is on every template the screen covers — raid included", () => {
  // Whichever piece an operator happens to open, the whole palette is one tap
  // away rather than a dozen screens away.
  //
  // THE RAID KEYS ARE THE POINT. They were added to the SCREEN and never to the
  // way IN, which was gated on the buy card's eight — so an admin who opened
  // raid_card looking for 📊 saw that one template's icons and no route to the
  // rest, and the button they could not see was labelled "kartu buy" anyway.
  // Between them, indistinguishable from raid icons not being editable at all.
  // WHERE it goes, not merely that it is there. There are TWO screens — `bem` is
  // the buy card's, `aem` covers buy AND raid — and a raid template sent to
  // `bem` opens a wall of buy-card glyphs holding no raid icon at all, which
  // looks like the wrong button was pressed. Asserting only that a button exists
  // is what let that through the first time.
  const covered = admin._allEmoji.allEmojiKeys();
  assert.ok(covered.includes("raid_card"), "the screen covers the raid card");
  assert.ok(covered.includes("raid_panel"), "…and the raid panel");

  const wayIn = (key) =>
    admin._tpl
      .viewKb(key)
      .reply_markup.inline_keyboard.flat()
      .find((b) => /^(bem|aem:)/.test(String(b.callback_data)));

  for (const key of covered) {
    const btn = wayIn(key);
    assert.ok(btn, `${key} must offer a shared emoji screen`);
    const buyPiece = BUY_CARD_EMOJI_KEYS.includes(key);
    assert.strictEqual(
      btn.callback_data,
      buyPiece ? "bem" : "aem:0",
      `${key} must open the screen that actually holds its icons`,
    );
  }
  assert.strictEqual(wayIn("chain_emojis").callback_data, "bem");

  // And nowhere else — it would be a dead end on a channel post.
  assert.strictEqual(wayIn("post_trending"), undefined);
});

test("the button names the screen it opens", () => {
  // A label naming the wrong surface is why the screen went unopened by the
  // person who needed it — and a label promising raid while opening the buy-only
  // screen would be worse than the silence it replaced.
  const label = (key) =>
    admin._tpl
      .viewKb(key)
      .reply_markup.inline_keyboard.flat()
      .find((b) => /^(bem|aem:)/.test(String(b.callback_data))).text;
  assert.match(label("raid_card"), /raid/i, "the raid route says raid");
  assert.match(label("raid_card"), /buy/i, "…and warns it moves the buy card too");
  assert.doesNotMatch(label("group_buy_alert"), /raid/i, "the buy-only screen must not promise raid");
});

test("an icon shared by both cards is named for BOTH of its jobs", () => {
  // The hint is derived from whichever template the screen reads first, and that
  // is always a buy one — so the raid's "12% complete" icon was labelled
  // "price", its Record line "Chart", and its completed banner "Position". The
  // icons were editable the whole time and unfindable by anyone looking for
  // them, which from where that person is standing is the same thing.
  const slots = admin._allEmoji.allEmojiSlots();
  const named = (char) => (slots.find((s) => s.char === char) || {}).label || "";
  assert.match(named("📊"), /raid/i, "📊 draws the raid's % complete as well as the buy price");
  assert.match(named("📈"), /record/i);
  assert.match(named("✅"), /done/i);
  // …and the buy meaning is not lost in the process.
  assert.match(named("📊"), /price/i);
});

test("every button maps back to the slot it was built from", () => {
  // The callback carries an INDEX, and the handler re-derives the list at press
  // time — an operator can leave this screen open while editing elsewhere.
  const slots = buyEmojiSlots();
  const taps = buyEmojiKb()
    .reply_markup.inline_keyboard.flat()
    .filter((b) => b.callback_data.startsWith("bemx:"));
  assert.strictEqual(taps.length, slots.length, "one button per slot, none dropped");
  for (const b of taps) {
    const s = slots[Number(b.callback_data.split(":")[1])];
    assert.ok(s, `${b.callback_data} points at nothing`);
    assert.ok(b.text.includes(s.char), `${b.text} should show ${s.char}`);
  }
});

test("every emoji in every template can say which row it is for", () => {
  // The per-template picker used to show bare glyphs: six anonymous icons in a
  // grid, two of them 📈, with nothing saying which was the price row and which
  // was the Chart button. "the emoji don't match the card" is what that looks
  // like from the other side of the screen.
  const { emojiHint } = admin._buyEmoji;
  const unlabelled = [];
  for (const key of ["group_buy_alert", "group_whale_alert", "chain_emojis", "group_buy_style", "group_position_row"]) {
    for (const e of tpl.listEmojis(key)) if (!emojiHint(key, e)) unlabelled.push(`${key}#${e.i} ${e.char}`);
  }
  assert.deepStrictEqual(unlabelled, []);
});

test("the hint is the row's own word, so the button matches the card", () => {
  const { emojiHint } = admin._buyEmoji;
  const hint = (key, char) => emojiHint(key, tpl.listEmojis(key).find((e) => e.char === char));
  assert.strictEqual(hint("group_buy_alert", "💲"), "usd");
  assert.strictEqual(hint("group_buy_alert", "📊"), "price");
  assert.strictEqual(hint("group_buy_alert", "📈"), "Chart", "the CTA button, not the price row");
  // Both cards read the same, because they ARE the same card below the banner.
  for (const char of ["💲", "🪙", "📊", "⚡", "📈", "💎"]) {
    assert.strictEqual(hint("group_whale_alert", char), hint("group_buy_alert", char), char);
  }
});

test("colliding swaps never swallow a button — slots group on the SHIPPED glyph", async () => {
  // The operator swapped price to a custom emoji whose fallback is 📈 — the
  // Chart icon's char — and the intro to one whose fallback is 💎, the Dexvra
  // icon's char. Grouped on the current char, Chart merged into "price" and
  // Dexvra into "NEW": their buttons vanished and their spots moved with every
  // edit of the wrong row. Identity is the shipped glyph, not today's look.
  await tpl.replaceEmojiAt("group_buy_intro", 0, "[💎](emoji/1)");
  await tpl.replaceEmojiAt("group_buy_alert", 2, "[📈](emoji/2)");
  try {
    const labels = buyEmojiSlots().filter((s) => !s.chain).map((s) => s.label);
    for (const wanted of ["Chart", "Dexvra", "price", "NEW"]) {
      assert.ok(labels.includes(wanted), `${wanted} still has its own button: ${labels.join(", ")}`);
    }
    // …and the swallowed-button failure mode: the Chart slot's spots must NOT
    // be carried by the price slot.
    const price = buyEmojiSlots().find((s) => s.label === "price");
    assert.strictEqual(price.spots.length, 2, "price owns its own two spots (buy + whale), nothing else's");
  } finally {
    await reset();
  }
});

test("the screen states the REAL premium rule — owner Premium, not 'bots never can'", () => {
  // Bot API formatting rules: a bot's custom emoji render in group chats when
  // the bot's OWNER has Telegram Premium (channels still need GramJS). The old
  // note said bots can never animate premium — an operator read their fallback
  // chars as a bug, because the note told them nothing could be done.
  assert.match(buyEmojiText(), /PEMILIK bot/, "names the thing that unlocks it");
  assert.match(buyEmojiText(), /Transfer Ownership/, "…and the exact BotFather action");
});
