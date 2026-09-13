// The photo on a standalone /massdm broadcast — settable, skippable, and SAID.
//
// "aturan bisa set media juga kalo mau skip juga bisa dn kasih tau". The flow
// was ONE-SHOT: whatever the buyer's first message carried was the whole
// broadcast for ever, and the preview card said nothing about which of the two
// states it was in — on the screen they tap Pay from.
//
// Everything here DRIVES the registered handlers through real updates. A source
// scan passes on a wiring that is never reached, which is this repo's own
// curveBuyPath scar: a wiring that does nothing refuses beautifully.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
const dataDir = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-mdmedia-"));
process.env.BOT_DATA_DIR = dataDir;
process.env.MASS_DM_REVIEW_CHAT_ID = "";

const test = require("node:test");
const assert = require("node:assert");
const md = require("../src/handlers/massdm");
const tpl = require("../src/templates");
const { CAPTION_LIMIT } = require("../src/channels/post");

const PAY = { currency: "ETH", payChain: "ethereum", native: "ETH", price: 0.1 };

/** A private chat in the compose-done state: text composed, no photo. */
function ctxAt(state = {}) {
  const sent = [];
  const media = [];
  const ctx = {
    chat: { id: 7, type: "private" },
    from: { id: 7, username: "buyer" },
    message: {},
    session: {
      type: "massdm",
      awaitingField: null,
      massForm: { ca: "0xabc", chain: "ethereum", pay: PAY, text: "hello", entities: [], mediaFileId: null, mediaType: null, ...state },
    },
    telegram: { deleteMessage: async () => {} },
    answerCbQuery: async () => {},
    reply: async (text, extra) => { sent.push({ text, extra }); return { message_id: sent.length }; },
    replyWithPhoto: async (id, extra) => { media.push({ how: "photo", id, extra }); return { message_id: 99 }; },
    replyWithAnimation: async (id, extra) => { media.push({ how: "animation", id, extra }); return { message_id: 99 }; },
    replyWithVideo: async (id, extra) => { media.push({ how: "video", id, extra }); return { message_id: 99 }; },
  };
  return { ctx, sent, media };
}

/** The last message the bot sent — the card, which always comes last. */
const card = (sent) => sent[sent.length - 1];
const btns = (m) =>
  ((m.extra && m.extra.reply_markup && m.extra.reply_markup.inline_keyboard) || []).flat();
const cbs = (m) => btns(m).map((b) => b.callback_data);
const labels = (m) => btns(m).map((b) => b.text).join(" | ");
const allText = (sent) => sent.map((m) => m.text).join("\n---\n");

const photoMsg = (caption) => ({ photo: [{ file_id: "PH1" }], ...(caption ? { caption, caption_entities: [] } : {}) });

// ── The state is on the card, and so is the way out ─────────────────────────

test("text-only preview SAYS no photo is attached, and offers one", async () => {
  const { ctx, sent } = ctxAt();
  ctx.message = { text: "hello", entities: [] };
  ctx.session.awaitingField = "massdm_compose";
  await md.handleText(ctx);

  const c = card(sent);
  assert.match(c.text, /No photo attached/i, c.text);
  assert.match(c.text, /text only/i, "it says what will actually go out");
  assert.ok(cbs(c).includes("md_media"), `no way to add one: ${cbs(c)}`);
  assert.ok(!cbs(c).includes("md_nomedia"), "nothing to remove, so no remove button");
  // ✏️ Edit, never ad_massdm: that one restarts at "paste your CA".
  assert.ok(cbs(c).includes("md_edit"), `no way to edit: ${cbs(c)}`);
  assert.ok(!cbs(c).includes("ad_massdm"), "Edit must not restart the whole flow");
  assert.match(labels(c), /Edit/, labels(c));
  assert.doesNotMatch(labels(c), /Recompose/i, labels(c));
});

// ── ✏️ Edit keeps the order ─────────────────────────────────────────────────

test("✏️ Edit re-opens compose with the token, the chain and the price intact", async () => {
  const { ctx, sent } = ctxAt({ mediaFileId: "PH1", mediaType: "photo" });
  await md.mdEdit(ctx);
  assert.strictEqual(ctx.session.awaitingField, "massdm_compose");
  assert.strictEqual(ctx.session.massForm.ca, "0xabc", "the CA was thrown away");
  assert.strictEqual(ctx.session.massForm.chain, "ethereum", "the detected chain was thrown away");
  assert.strictEqual(ctx.session.massForm.pay.price, 0.1);
  assert.strictEqual(ctx.session.massForm.mediaFileId, "PH1", "the photo was thrown away");
  assert.match(card(sent).text, /stays/i, card(sent).text);
});

test("a new message during an edit KEEPS the attached photo", async () => {
  const { ctx, sent } = ctxAt({ mediaFileId: "PH1", mediaType: "animation" });
  await md.mdEdit(ctx);
  ctx.message = { text: "new words", entities: [] };
  await md.handleText(ctx);
  assert.strictEqual(ctx.session.massForm.text, "new words");
  assert.strictEqual(ctx.session.massForm.mediaFileId, "PH1", "silently dropped the attachment");
  assert.strictEqual(ctx.session.massForm.mediaType, "animation", "…and forgot it was a clip");
  assert.match(card(sent).text, /GIF attached/i, card(sent).text);
});

test("a new PHOTO during an edit replaces the old one", async () => {
  const { ctx } = ctxAt({ mediaFileId: "OLD", mediaType: "photo" });
  await md.mdEdit(ctx);
  ctx.message = { photo: [{ file_id: "NEW" }], caption: "cap", caption_entities: [] };
  await md.handlePhoto(ctx);
  assert.strictEqual(ctx.session.massForm.mediaFileId, "NEW");
  assert.strictEqual(ctx.session.massForm.text, "cap");
});

test("the photo step puts the SKIP on screen as a button", async () => {
  const { ctx, sent } = ctxAt();
  await md.mediaAsk(ctx);
  assert.strictEqual(ctx.session.awaitingField, "massdm_media");
  const c = card(sent);
  assert.ok(cbs(c).includes("md_back"), `no skip: ${cbs(c)}`);
  assert.match(labels(c), /text-only/i, labels(c));
  assert.match(c.text, /optional|text-only/i, c.text);
});

test("a photo at the photo step attaches it, KEEPS the text, and says which", async () => {
  const { ctx, sent, media } = ctxAt();
  await md.mediaAsk(ctx);
  ctx.message = photoMsg();
  await md.handlePhoto(ctx);

  assert.strictEqual(ctx.session.massForm.mediaFileId, "PH1");
  assert.strictEqual(ctx.session.massForm.mediaType, "photo");
  assert.strictEqual(ctx.session.massForm.text, "hello", "the composed text survives");
  assert.match(allText(sent), /kept as its caption/i, "the buyer is told what happened to their text");
  assert.strictEqual(media[0].how, "photo");
  const c = card(sent);
  assert.match(c.text, /Photo attached/i, c.text);
  assert.deepStrictEqual(cbs(c).filter((x) => x.startsWith("md_")).sort(), ["md_edit", "md_media", "md_nomedia", "md_pay"]);
});

test("a caption sent with the photo REPLACES the text — and that is said too", async () => {
  const { ctx, sent } = ctxAt();
  await md.mediaAsk(ctx);
  ctx.message = photoMsg("brand new words");
  await md.handlePhoto(ctx);

  assert.strictEqual(ctx.session.massForm.text, "brand new words");
  assert.match(allText(sent), /replaced your text/i, "silently destroying the old text is the defect");
});

test("🗑 Remove is the explicit skip — it clears and says so", async () => {
  const { ctx, sent } = ctxAt({ mediaFileId: "PH1", mediaType: "photo" });
  await md.mediaClear(ctx);
  assert.strictEqual(ctx.session.massForm.mediaFileId, null);
  assert.strictEqual(ctx.session.massForm.mediaType, null);
  assert.match(allText(sent), /removed/i, allText(sent));
  assert.match(card(sent).text, /No photo attached/i);
});

test("↩️ Keep it changes nothing", async () => {
  const { ctx, sent } = ctxAt({ mediaFileId: "PH1", mediaType: "photo" });
  await md.mediaBack(ctx);
  assert.strictEqual(ctx.session.massForm.mediaFileId, "PH1");
  assert.match(card(sent).text, /Photo attached/i);
});

// ── A photo dropped on the preview means to attach ──────────────────────────

test("a photo dropped ON THE PREVIEW attaches — never silence", async () => {
  const { ctx, sent } = ctxAt(); // awaitingField is null: the preview state
  ctx.message = photoMsg();
  await md.handlePhoto(ctx);
  assert.strictEqual(ctx.session.massForm.mediaFileId, "PH1", "the buyer's photo was ignored");
  assert.ok(sent.length, "answering a dropped photo with nothing is 'the button does nothing'");
});

test("a photo with no massdm form in flight is still ignored", async () => {
  const { ctx, sent } = ctxAt();
  ctx.session.massForm = { ca: "0xabc", chain: "ethereum", pay: PAY }; // no text yet
  ctx.message = photoMsg();
  await md.handlePhoto(ctx);
  assert.strictEqual(sent.length, 0);
});

// ── Both readings named, never guessed ──────────────────────────────────────

test("TEXT at the photo step names both readings and changes nothing", async () => {
  const { ctx, sent } = ctxAt();
  await md.mediaAsk(ctx);
  const before = { ...ctx.session.massForm };
  ctx.message = { text: "oh wait", entities: [] };
  await md.handleText(ctx);

  assert.strictEqual(ctx.session.massForm.text, before.text, "the composed text was overwritten");
  assert.strictEqual(ctx.session.massForm.mediaFileId, null);
  const c = card(sent);
  assert.match(c.text, /photo or GIF/i, c.text);
  assert.match(c.text, /text-only/i, "the other reading is offered too");
  assert.strictEqual(ctx.session.awaitingField, "massdm_media", "still waiting for the photo");
});

test("an image sent as a FILE is refused, naming the fix — never queued", async () => {
  const { ctx, sent } = ctxAt();
  await md.mediaAsk(ctx);
  ctx.message = { document: { file_id: "DOC1" } };
  await md.handlePhoto(ctx);
  assert.strictEqual(ctx.session.massForm.mediaFileId, null, "a document file_id fails every sendPhoto");
  assert.match(card(sent).text, /as a \*?\*?photo|send as file/i, card(sent).text);
});

// ── The TYPE travels ────────────────────────────────────────────────────────

test("a GIF is carried as an animation, previewed as one, and paid as one", async () => {
  const { ctx, sent, media } = ctxAt();
  await md.mediaAsk(ctx);
  ctx.message = { animation: { file_id: "GIF1" } };
  await md.handlePhoto(ctx);

  assert.strictEqual(ctx.session.massForm.mediaType, "animation");
  assert.strictEqual(media[0].how, "animation", "a clip through sendPhoto is an ERROR, not a still");
  assert.match(card(sent).text, /GIF attached/i, card(sent).text);

  // ⚠️ DRIVEN THROUGH THE REAL payPick, which is why massdm.js imports the pay
  // MODULE rather than a destructured startPayment: a destructured import is
  // bound at require time, so no test could ever pin what this flow hands the
  // payment path. The rule listing.js already carries at its own require.
  let armed = null;
  const pay = require("../src/handlers/pay");
  const real = pay.startPayment;
  pay.startPayment = async (_c, o) => { armed = o; };
  try {
    await md.payPick(ctx);
  } finally {
    pay.startPayment = real;
  }
  assert.ok(armed, "payPick never armed — massdm.js destructured startPayment");
  assert.strictEqual(armed.payload.mediaType, "animation", "the type has to reach the job");
  assert.strictEqual(armed.payload.mediaFileId, "GIF1");
});

test("downloadMedia writes the extension the TYPE implies", async () => {
  const seen = [];
  const ctx = {
    telegram: { getFileLink: async () => ({ href: "https://x/y" }) },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
  try {
    seen.push(await md.downloadMedia(ctx, "A", "animation"));
    seen.push(await md.downloadMedia(ctx, "B", "photo"));
    seen.push(await md.downloadMedia(ctx, "C", undefined));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(seen[0].endsWith(".mp4"), seen[0]);
  assert.ok(seen[1].endsWith(".jpg"), seen[1]);
  assert.ok(seen[2].endsWith(".jpg"), "an unknown type falls back to a still");
  for (const f of seen) fss.rmSync(f, { force: true });
});

// ── Refused, never trimmed ──────────────────────────────────────────────────

test("a text too long for a caption REFUSES the photo and changes nothing", async () => {
  const long = "x".repeat(CAPTION_LIMIT + 40);
  const { ctx, sent } = ctxAt({ text: long });
  await md.mediaAsk(ctx);
  ctx.message = photoMsg();
  await md.handlePhoto(ctx);

  assert.strictEqual(ctx.session.massForm.mediaFileId, null, "attaching would fail all 12,000 sends");
  assert.strictEqual(ctx.session.massForm.text, long, "trimming would delete what they paid to send");
  const c = card(sent);
  assert.match(c.text, new RegExp(String(CAPTION_LIMIT)), c.text);
  assert.match(c.text, new RegExp(String(long.length)), "it names their own length too");
  assert.match(c.text, /Nothing was changed/i);
  // The card carries the button its own sentence tells them to tap.
  assert.ok(cbs(c).includes("md_edit"), `✏️ Edit is named and not offered: ${cbs(c)}`);
  assert.ok(cbs(c).includes("md_back"), "…and text-only is still one tap away");
});

test("the limit comes from channels/post, not a second copy of 1024", () => {
  const src = fss.readFileSync(require.resolve("../src/handlers/massdm.js"), "utf8").replace(/\/\/[^\n]*/g, "");
  assert.ok(/require\("\.\.\/channels\/post"\)\.CAPTION_LIMIT/.test(src), "reads the one owner");
  assert.ok(!/\b1024\b/.test(src), "a second copy of the number is how the two disagree");
});

// ── The line survives an operator's saved card ──────────────────────────────

test("an operator's saved preview card still gets the attachment line", () => {
  const saved = { text: "Pay up.", entities: [{ type: "bold", offset: 0, length: 3 }] };
  const line = { text: "📎 Photo attached — it goes out.", entities: [{ type: "bold", offset: 3, length: 14 }] };
  const out = md.ensureMediaLine(saved, line);
  assert.ok(out.text.includes("Photo attached"), out.text);
  assert.deepStrictEqual(out.entities[0], { type: "bold", offset: 0, length: 3 }, "nothing already there moves");
  const moved = out.entities[1];
  assert.strictEqual(out.text.slice(moved.offset, moved.offset + moved.length), "Photo attached", "the bold landed off the words");
});

test("a card that already carries the line is not given it twice", () => {
  const line = { text: "📎 Photo attached.", entities: [] };
  const already = { text: `Head\n\n${line.text}\n\nPay`, entities: [] };
  assert.strictEqual(md.ensureMediaLine(already, line), already);
});

test("an operator's PREMIUM EMOJI in the attachment row survives onto the card", async () => {
  // ⚠️ THE RULE THIS WHOLE PATH EXISTS FOR. A pasted template is stored as
  // {text, entities}; substituting it into the card as MARKUP would keep the
  // characters and drop the custom_emoji entities, so the 💎 would flatten on
  // the one surface the admin bot promises can carry it. Rendered whole and
  // appended, it is an ordinary template render and the entity travels.
  const rich = {
    text: "⚡ Photo attached — it goes out.",
    entities: [{ type: "custom_emoji", offset: 0, length: 1, custom_emoji_id: "5771234567890123456" }],
  };
  await tpl.setTemplate("massdm_media_on", rich);
  try {
    const { ctx, sent } = ctxAt({ mediaFileId: "PH1", mediaType: "photo" });
    await md.mediaBack(ctx);
    const c = card(sent);
    const ce = (c.extra.entities || []).find((e) => e.type === "custom_emoji");
    assert.ok(ce, `the premium emoji was flattened:\n${JSON.stringify(c.extra.entities)}`);
    assert.strictEqual(ce.custom_emoji_id, "5771234567890123456");
    assert.strictEqual(c.text.slice(ce.offset, ce.offset + ce.length), "⚡", "the entity landed off its glyph");
  } finally {
    await tpl.resetTemplate("massdm_media_on");
  }
});

test("the row is added exactly once", async () => {
  const { ctx, sent } = ctxAt({ mediaFileId: "PH1", mediaType: "photo" });
  await md.mediaBack(ctx);
  const c = card(sent);
  const hits = c.text.split("Photo attached").length - 1;
  assert.strictEqual(hits, 1, `the row was added twice:\n${c.text}`);
});

// ── …all the way into the job somebody paid for ─────────────────────────────

test("a paid GIF reaches the job as an ANIMATION, not a photo", async () => {
  const store = require("../src/massdm/store");
  const { fulfillMassDm } = require("../src/fulfillment");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  try {
    await fulfillMassDm(
      {
        from: { id: 4242, username: "gifbuyer" },
        telegram: { getFileLink: async () => ({ href: "https://x/y" }), sendMessage: async () => {} },
        reply: async () => ({ message_id: 1 }),
      },
      {
        id: "ord_gif",
        kind: "mass_dm",
        buyerId: 4242,
        payload: { text: "watch this", entities: [], mediaFileId: "GIF1", mediaType: "animation" },
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  const job = store.jobsByStatus("pending_review").find((j) => j.createdBy === 4242);
  assert.ok(job, "no job was queued");
  assert.strictEqual(job.mediaType, "animation", "sendPhoto on an animation THROWS — for every recipient");
  assert.ok(String(job.mediaPath).endsWith(".mp4"), job.mediaPath);
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test("the three media taps are registered", () => {
  const seen = new Set();
  // A Proxy rather than a hand-listed stub: the assertion is about which
  // actions are registered, and a stub missing whatever method the registry
  // grows next would fail for a reason that has nothing to do with that.
  const bot = new Proxy(
    { action: (k) => seen.add(String(k)), telegram: {} },
    { get: (t, k) => (k in t ? t[k] : () => {}) },
  );
  require("../src/handlers/registry").registerHandlers(bot);
  assert.ok(seen.has("md_pay"), `the registry did not run: ${seen.size} actions seen`);
  for (const a of ["md_media", "md_back", "md_nomedia", "md_edit"]) assert.ok(seen.has(a), `${a} is not wired`);
});

test("every new template is editable in the admin bot", () => {
  const keys = tpl.keys();
  for (const k of [
    "massdm_media_none", "massdm_media_on", "massdm_media_unpreviewable", "massdm_media_prompt",
    "massdm_media_not_photo", "massdm_media_as_file", "massdm_media_too_long",
    "massdm_media_set", "massdm_media_cleared", "massdm_edit_prompt",
  ]) {
    assert.ok(keys.includes(k), `${k} is not listed for the template editor`);
  }
});
