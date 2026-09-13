// Seeing the buy card before a real buy does.
//
// An emoji on a button is not the card. 🪙 next to 🔵 in a keyboard grid says
// nothing about whether the 🪙 row reads well under the 💲 row, and the only way
// to find out was to wait for somebody to buy the token — hours on a quiet
// contract, in a customer's group, in public.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-bprev-"));

const test = require("node:test");
const assert = require("node:assert");
const tpl = require("../src/templates");
const mon = require("../src/group/buyMonitor");
const admin = require("../src/admin/adminBot");
const { payloadArgs } = require("../src/helpers/message");
const { buyPreviews, buyEmojiKb, buyEmojiSlots, BUY_CARD_EMOJI_KEYS, CARD_OF_KEY, sendBuyPreview, sendTemplatePreview } = admin._buyEmoji;

const preview = (label) => buyPreviews().find((p) => p.label === label).payload;
const reset = () => Promise.all([...BUY_CARD_EMOJI_KEYS, "chain_emojis"].map((k) => tpl.resetTemplate(k)));
async function swap(char, to) {
  const slot = buyEmojiSlots().find((s) => s.char === char && !s.chain);
  for (const t of slot.spots) await tpl.replaceEmojiAt(t.key, t.i, to);
}

test("both cards are previewed, not just the ordinary one", () => {
  assert.deepStrictEqual(buyPreviews().map((p) => p.label), ["Buy alert", "Whale alert"]);
});

test("the preview is the REAL card — every row a group would get", () => {
  // Rendered by the alert's own renderer, not a lookalike built in the admin
  // bot. A second renderer agrees with the real one right up until the day it
  // does not, and the whole point of looking is to trust what you see.
  const text = preview("Buy alert").text;
  for (const row of [/^🚨 NEW BUY ALERT alon BUY!/m, /^🟣 alon \$ALON$/m, /^💲 \$804\.72 \(4\.2318 SOL\)$/m,
                     /^🪙 [\d,.]+ \$ALON$/m, /^📊 .+ · MC .+$/m,
                     /^👤 .+ · Txn$/m, /^✅ Position: .+ · Wallet$/m]) {
    assert.match(text, row);
  }
  // The liquidity / 24h row was dropped: pool depth has not changed since the
  // last alert and will not change by the next, so repeating it under every buy
  // spent a line restating the background instead of reporting the event.
  assert.doesNotMatch(text, /24h/);
  assert.match(preview("Whale alert").text, /WHALE WALLET!/);
});

test("a swapped icon shows up in the preview immediately", async () => {
  // The reason the preview exists: choosing an icon, not just changing one.
  await swap("🪙", "🌊");
  try {
    assert.match(preview("Buy alert").text, /^🌊 /m);
    assert.doesNotMatch(preview("Buy alert").text, /🪙/);
    assert.match(preview("Whale alert").text, /^🌊 /m, "the whale card moves with it");
  } finally {
    await reset();
  }
});

test("a swapped CHAIN mark shows up too — it leads the token row", async () => {
  const solana = buyEmojiSlots().find((s) => s.chain && s.label === "solana");
  await tpl.replaceEmojiAt("chain_emojis", solana.spots[0].i, "🦊");
  try {
    assert.match(preview("Buy alert").text, /^🦊 alon \$ALON$/m);
  } finally {
    await reset();
  }
});

test("the preview goes out with ENTITIES, never wrapped in HTML", () => {
  // Entity offsets are counted against the message text. Wrapping the card in a
  // "here is your preview" header would slide every link — and every premium
  // emoji — onto the wrong characters.
  const payload = preview("Buy alert");
  const { text, extra } = payloadArgs(payload);
  assert.strictEqual(text, payload.text, "the card is its own message, unwrapped");
  assert.ok(extra.entities && extra.entities.length, "links ride as entities");
  assert.ok(!extra.parse_mode, "no parse_mode — the text is not markup any more");
});

test("the links a reader taps all survive into the preview", () => {
  const byLabel = {};
  const p = preview("Buy alert");
  for (const e of p.entities) if (e.type === "text_link") byLabel[p.text.substr(e.offset, e.length)] = e.url;
  assert.match(byLabel["Trade on Dexvra"], /^https:\/\/t\.me\/.+\?start=ca_solana_/);
  assert.match(byLabel["Chart"], /^https:\/\/dexscreener\.com\//);
  assert.ok(byLabel["Txn"], "the proof link — the card's whole claim");
  assert.ok(byLabel["Wallet"], "the buyer's holdings");
});

test("a premium emoji reaches the preview as a real custom_emoji entity", async () => {
  // This is the honest answer to "does premium survive in a group?". The
  // preview is sent BY THE ADMIN BOT — a regular bot, exactly like the one that
  // posts into groups — so what the operator sees here is what the group gets.
  await swap("💲", "[🤑](emoji/5445284980978621387)");
  try {
    const p = preview("Buy alert");
    const prem = p.entities.filter((e) => e.type === "custom_emoji");
    assert.strictEqual(prem.length, 1);
    assert.strictEqual(prem[0].custom_emoji_id, "5445284980978621387");
    assert.strictEqual(p.text.substr(prem[0].offset, prem[0].length), "🤑", "over the right character");
  } finally {
    await reset();
  }
});

test("the preview is one tap from the emoji screen", () => {
  const flat = buyEmojiKb().reply_markup.inline_keyboard.flat();
  assert.ok(flat.some((b) => b.callback_data === "bemp"), "a look-at-it button");
});

test("previewing never writes anything", async () => {
  // It renders from the live templates and must not save a thing — an operator
  // pressing 👁 must not be able to turn a default template into a custom one.
  const before = tpl.overrideCount();
  buyPreviews();
  assert.strictEqual(tpl.overrideCount(), before);
});

// ── One card per template, and the clip rides along ──────────────────────────

test("a card's own template previews that card ALONE — the other is not noise under it", () => {
  // "Lihat hasilnya" on the buy-alert template used to send the whale card too,
  // every time — two cards for a one-card question. Each card's own pieces
  // preview just that card; only the shared rows (money column, buyer row,
  // position, chain marks) show both, because a swap there moves both.
  assert.deepStrictEqual(buyPreviews("buy").map((p) => p.label), ["Buy alert"]);
  assert.deepStrictEqual(buyPreviews("whale").map((p) => p.label), ["Whale alert"]);
  assert.deepStrictEqual(buyPreviews().map((p) => p.label), ["Buy alert", "Whale alert"]);
  assert.strictEqual(CARD_OF_KEY.group_buy_alert, "buy");
  assert.strictEqual(CARD_OF_KEY.group_buy_intro, "buy");
  assert.strictEqual(CARD_OF_KEY.group_whale_alert, "whale");
  assert.strictEqual(CARD_OF_KEY.group_whale_intro, "whale");
  for (const shared of ["group_buy_style", "group_name_row", "group_buyer_row", "group_position_row", "chain_emojis"]) {
    assert.strictEqual(CARD_OF_KEY[shared], undefined, `${shared} feeds both cards`);
  }
});

/** A ctx that records what the preview sends, shaped like sendAlert's fake tg. */
function fakeCtx() {
  const sent = [];
  return {
    sent,
    chat: { id: 42 },
    reply: async (text, extra) => sent.push(["reply", text, extra]),
    telegram: {
      sendMessage: async (c, text, extra) => sent.push(["text", c, text, extra]),
      sendAnimation: async (c, media, extra) => sent.push(["anim", c, media, extra]),
      sendVideo: async (c, media, extra) => sent.push(["video", c, media, extra]),
      sendPhoto: async (c, media, extra) => sent.push(["photo", c, media, extra]),
    },
  };
}
const DIR = process.env.BOT_DATA_DIR;
const clipPath = (kind) => path.join(DIR, `banner-media-${kind}.gif`);
const clearClips = () => {
  for (const kind of ["buy", "whale", "default"]) {
    try {
      fss.unlinkSync(clipPath(kind));
    } catch {
      /* not there */
    }
  }
};

test("the preview rides the alert's OWN sender — clip above, card as its caption", async (t) => {
  t.after(clearClips);
  // A real alert plays the uploaded GIF with the card as caption. A preview
  // that arrives as bare text is answering a question nobody asked: whether
  // the icons read well is a question about the message the group actually
  // gets, clip included.
  fss.writeFileSync(clipPath("buy"), "GIF89a-not-really");
  fss.writeFileSync(clipPath("whale"), "GIF89a-not-really-either");
  const ctx = fakeCtx();
  await sendBuyPreview(ctx, "buy");
  const [header, card] = ctx.sent;
  assert.strictEqual(header[0], "reply");
  assert.match(header[1], /Buy alert/);
  assert.strictEqual(card[0], "anim", "the clip leads, exactly like a group alert");
  assert.strictEqual(card[1], 42);
  assert.strictEqual(card[2].source, clipPath("buy"), "the BUY clip — never the whale's");
  assert.match(card[3].caption, /NEW BUY ALERT/);
  assert.ok(card[3].caption_entities && card[3].caption_entities.length, "links survive as caption_entities");
  assert.strictEqual(ctx.sent.length, 2, "one header, one card — nothing else");

  const whaleCtx = fakeCtx();
  await sendBuyPreview(whaleCtx, "whale");
  assert.strictEqual(whaleCtx.sent[1][2].source, clipPath("whale"), "the whale preview plays the WHALE clip");
});

test("a REFUSED clip is reported to the operator, not silently degraded to text", async (t) => {
  t.after(clearClips);
  // In a group the text fallback is the right instinct; here it renders
  // indistinguishable from "no clip uploaded" and hides the one
  // misconfiguration (card too long for the 1024-char caption) this screen
  // exists to surface.
  fss.writeFileSync(clipPath("buy"), "GIF89a-not-really");
  const ctx = fakeCtx();
  ctx.telegram.sendAnimation = async () => {
    throw new Error("400: message caption is too long");
  };
  await sendBuyPreview(ctx, "buy");
  const warn = ctx.sent.find(([k, text]) => k === "reply" && /ditolak Telegram/.test(text));
  assert.ok(warn, `the refusal is reported: ${JSON.stringify(ctx.sent.map((s) => s[0]))}`);
  assert.match(warn[1], /caption is too long/, "…with Telegram's own reason");
  assert.ok(ctx.sent.some(([k]) => k === "text"), "and the plain-text card still arrives, like a real group");
});

test("with no clip uploaded the preview is plain text — same fallback as a real alert", async () => {
  clearClips();
  const ctx = fakeCtx();
  await sendBuyPreview(ctx, "buy");
  assert.strictEqual(ctx.sent[1][0], "text");
  assert.match(ctx.sent[1][2], /NEW BUY ALERT/);
});

test("sendTemplatePreview routes each buy-card key to its own card", async () => {
  clearClips();
  const headers = async (key) => {
    const ctx = fakeCtx();
    await sendTemplatePreview(ctx, key);
    return ctx.sent.filter(([k]) => k === "reply").map(([, text]) => text);
  };
  assert.match((await headers("group_buy_alert")).join("|"), /^[^|]*Buy alert[^|]*$/, "buy template → buy card only");
  assert.match((await headers("group_whale_alert")).join("|"), /^[^|]*Whale alert[^|]*$/, "whale template → whale card only");
  const both = await headers("group_position_row");
  assert.strictEqual(both.length, 2, "a shared row previews both cards");
});

test("the preview sample is unmistakably a SAMPLE, not a real contract", () => {
  // It used to be a real third-party token's real addresses, which is wrong
  // twice over: every operator's preview advertised somebody else's coin with
  // live links to it, and an operator who later found that same contract
  // configured in their group could not tell the two facts apart — they spent
  // an evening certain the bot shipped a hardcoded default CA.
  // The token address rides in the link URLs, not in the visible text — the
  // card shows the BUYER shortened and keeps the contract inside the entities.
  const p = buyPreviews("buy")[0].payload;
  const urls = (p.entities || []).filter((e) => e.type === "text_link").map((e) => e.url).join(" ");
  assert.match(urls, /DexvraPreview/, "the contract the preview links to names itself as a preview");
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "admin", "adminBot.js"), "utf8");
  assert.doesNotMatch(src, /8XtRWb4uAAJFMP4QQhoYYCWR6XXb7ybcCdiqPwz9s5WS/, "the real contract is gone from the source");
});
