// Paid Mass DM flow (public): CA FIRST → compose → pay → admin review → send.
// Like fourtis: the buyer drops their token's contract address first, which
// locks the payment currency to that token's chain (Solana→SOL, ETH/Base→ETH,
// everything else→BNB). Then they compose one message and pay. The order only
// PERSISTS a pending_review job on payment (funds are swept before onSuccess,
// so fulfilment must never throw). Admins get a FREE test-send.
const { answer, toast, sendCard } = require("../helpers/message");
const { nativeOf, chainOf, payChainOf, payNativeOf } = require("../config/chains");
const { MASS_DM_PRICE, MASS_DM_ENABLED, isAdminUser, ADMIN_IDS } = require("../config/constants");
// ⚠️ THE MODULE, NOT A DESTRUCTURED startPayment. A destructured import is
// bound at require time, so no test could pin what this flow hands the payment
// path — the amount, the coin, or (since the photo became settable) the media
// TYPE that decides whether 12,000 sends go out as sendPhoto or sendAnimation.
// The rule listing.js already states at its own require.
const payFlow = require("./pay");
const groupSetup = require("../group/setup");
const menu = require("./menu");
const { Markup } = menu;
const tpl = require("../templates");
const premium = require("../premium");
const store = require("../massdm/store");

function freshSession(ctx, patch) {
  const prev = ctx.session && ctx.session.latest_bot_message;
  ctx.session = { latest_bot_message: prev, ...patch };
}

const fmtPrice = (n, sym) => (n == null ? "—" : `${n} ${sym}`);

// The Mass DM pay currency, mapped from the token's chain. The buyer pays in
// the currency of the chain their token lives on — through the SAME
// payChainOf/payNativeOf every other package uses, so a Robinhood project is
// billed in ETH on Robinhood Chain here exactly as it is for a listing.
//
// ⚠️ It used to be a private three-way map — solana → SOL, ethereum/base → ETH,
// EVERYTHING ELSE → BNB on BSC — written before Robinhood was a chain here. So
// a Robinhood project buying Mass DM saw "💳 Pay 0.15 BNB" and a picker with BSC
// first, while the listing it had just bought was billed in ETH on its own
// chain: two packages, two answers to "what does my chain pay in". The table
// only prices three currencies, so a chain whose coin it does not price (TRX,
// TON) still settles in BNB on BSC, which is what those buyers have always
// been offered.
function currencyOf(chain) {
  const own = payNativeOf(chain);
  return MASS_DM_PRICE[own] != null ? own : "BNB";
}
function payFor(tokenChain) {
  const currency = currencyOf(tokenChain);
  const own = payNativeOf(tokenChain);
  // Its own chain when that is what it pays in; the BSC fallback otherwise.
  const payChain = currency === own ? payChainOf(tokenChain) : "bsc";
  return { currency, payChain, native: currency, price: MASS_DM_PRICE[currency] };
}

// Loose CA shape check (matches the chains we support) before we scan it.
const CA_RE = /^(0x[a-fA-F0-9]{40}(::[A-Za-z0-9_]+)*|0x[a-fA-F0-9]{1,64}(::[A-Za-z0-9_]+){1,2}|T[1-9A-HJ-NP-Za-km-z]{33}|(EQ|UQ|0:)[A-Za-z0-9_-]{40,66}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
const looksLikeCA = (s) => CA_RE.test(String(s || "").trim());

async function entryMassDm(ctx) {
  await answer(ctx);
  if (ctx.chat && ctx.chat.type !== "private") return;
  if (!MASS_DM_ENABLED) return toast(ctx, tpl.render("massdm_disabled"));
  freshSession(ctx, { type: "massdm", awaitingField: "massdm_ca" });
  const intro = tpl.render("massdm_intro", {
    sol: fmtPrice(MASS_DM_PRICE.SOL, "SOL"),
    bnb: fmtPrice(MASS_DM_PRICE.BNB, "BNB"),
    eth: fmtPrice(MASS_DM_PRICE.ETH, "ETH"),
  });
  await sendCard(ctx, intro, menu.withHome([]));
}

// Step 1 — capture the token CA, resolve its chain, lock the pay currency.
async function captureCa(ctx, input) {
  const s = ctx.session;
  const ca = String(input || "").trim().split(/\s+/)[0];
  if (!looksLikeCA(ca)) return sendCard(ctx, tpl.render("massdm_ca_invalid"), menu.withHome([]));
  await ctx.reply("🔍 Detecting your token's chain…").catch(() => {});
  // ⚠️ BOUNDED. resolveToken probes five candidate chains SERIALLY through the
  // shared GeckoTerminal queue, which has no deadline of its own — so on a busy
  // box this step used to sit there for minutes and the paste was answered by
  // nothing at all. See resolveTokenSoon for the whole reasoning.
  const { res } = await groupSetup.resolveTokenSoon(ca);
  const chain = res ? res.chain : groupSetup.candidateChains(ca)[0]; // fall back to the shape guess
  const pay = payFor(chain);
  s.massForm = { ca, chain, pay };
  s.awaitingField = "massdm_compose";
  // ⚠️ A GUESSED CHAIN MAY NOT BE ANNOUNCED AS A DETECTED ONE. Which chain this
  // is decides which CURRENCY the buyer pays in, and for any 0x… address the
  // fallback is simply the first candidate — so "✅ Token detected on Ethereum"
  // over an unresolved BSC token is a wrong number on the screen that takes the
  // money. The two facts get two cards.
  await sendCard(
    ctx,
    tpl.render(res ? "massdm_compose_prompt" : "massdm_chain_unconfirmed", {
      chain: chainOf(chain) ? chainOf(chain).label : chain,
      amount: `${pay.price} ${pay.native}`,
    }),
    menu.withHome([]),
  );
}

// ── The photo is OPTIONAL, and both halves of that had to be sayable ────────
//
// "aturan bisa set media juga kalo mau skip juga bisa dn kasih tau": the flow
// was ONE-SHOT. Whatever the buyer's first message carried was the whole
// broadcast for ever — send text and there was no way to attach a photo
// afterwards, and the preview card neither said whether one was attached nor
// that text-only is perfectly fine. Both states rendered identically on the
// screen the buyer taps Pay from.
//
// ⚠️ AND THE TYPE HAS TO TRAVEL. getMediaFileId answers for animations and
// videos too, and this flow hardcoded "photo" all the way down — so a GIF
// preview threw into a bare catch (the card claiming "👆 This is your
// broadcast" over nothing) and every one of 12,000 sendPhoto calls would have
// failed on an animation file_id. CLAUDE.md records that exact lesson for the
// listing add-on ("a clip sent through sendPhoto is an ERROR, not a still") and
// it was never applied to the standalone product: a lesson applied to one of
// two siblings.
const MEDIA_KIND = { photo: "Photo", animation: "GIF", video: "Video" };
const REPLY_METHOD = { photo: "replyWithPhoto", animation: "replyWithAnimation", video: "replyWithVideo" };
// The extension follows the TYPE: an .mp4 written as .jpg uploads as a document
// and Telegram renders a file card instead of an inline, autoplaying clip.
const MEDIA_EXT = { photo: "jpg", animation: "mp4", video: "mp4" };

/** {fileId, type} for something we can broadcast, else {why} naming the fix. */
function mediaOf(ctx) {
  const m = (ctx && ctx.message) || {};
  if (m.photo && m.photo.length) return { fileId: m.photo[m.photo.length - 1].file_id, type: "photo" };
  if (m.animation) return { fileId: m.animation.file_id, type: "animation" };
  if (m.video) return { fileId: m.video.file_id, type: "video" };
  // ⚠️ A DOCUMENT IS REFUSED, and that is the honest answer rather than a
  // narrow one. Telegram will not take a document file_id in sendPhoto, so
  // accepting one queues a paid broadcast that fails for every single
  // recipient — and the buyer fixes it by re-sending from the gallery.
  if (m.document) return { fileId: null, why: "massdm_media_as_file" };
  return { fileId: null, why: null };
}

// Telegram counts a caption in UTF-16 units, which is exactly String#length.
// Read from channels/post, the ONE owner of that number.
const captionLimit = () => require("../channels/post").CAPTION_LIMIT;

// THREE states, and ONE owner of which it is. Each is its own template, so an
// operator can edit all three — premium emoji included, which is why the row is
// RENDERED whole and appended rather than substituted in as markup.
function mediaState(s) {
  const f = (s && s.massForm) || {};
  const key = !f.mediaFileId
    ? "massdm_media_none"
    : f.mediaShown === false
      ? "massdm_media_unpreviewable"
      : "massdm_media_on";
  return { key, vars: { kind: MEDIA_KIND[f.mediaType] || MEDIA_KIND.photo } };
}

/** The attachment row, rendered — an operator can edit all three states. */
function mediaLine(s) {
  const { key, vars } = mediaState(s);
  return tpl.render(key, vars);
}

/**
 * ⚠️ ENFORCED HERE, NOT TRUSTED TO THE TEMPLATE — the same rule, and the same
 * reason, as ensureNetwork on the pay card: `massdm_preview` is editable in
 * @dexvraadminbot and an operator's saved copy wins over the shipped default
 * for ever, so a card saved before {media} existed would say nothing at all
 * about what is attached — on the screen the buyer taps Pay from.
 *
 * premium.appendBlock owns the appending — the offsets, the html shape, the
 * "already there" test — for this row and for the pay card's two. It is where
 * the entity-carrying shape lives, which is what keeps a premium emoji pasted
 * into massdm_media_on alive; this wrapper exists so the call site reads as
 * what it is.
 */
function ensureMediaLine(payload, line) {
  return premium.appendBlock(payload, line);
}

/** The ONE preview renderer — the message, then the card. */
async function showPreview(ctx) {
  const s = ctx.session;
  const f = s.massForm;
  s.awaitingField = null;
  const extra = (f.entities || []).length
    ? { entities: f.entities, disable_web_page_preview: true }
    : { disable_web_page_preview: true };
  f.mediaShown = true;
  try {
    if (f.mediaFileId) {
      const method = REPLY_METHOD[f.mediaType] || REPLY_METHOD.photo;
      await ctx[method](f.mediaFileId, f.text ? { caption: f.text, caption_entities: f.entities } : {});
    } else if (f.text) {
      await ctx.reply(f.text, extra);
    }
  } catch {
    // Best-effort, and never SILENT: the card below says "👆 This is your
    // broadcast", and over nothing at all that is a claim about a broken thing.
    f.mediaShown = false;
  }
  const card = tpl.render("massdm_preview", { amount: `${f.pay.price} ${f.pay.native}` });
  await sendCard(ctx, ensureMediaLine(card, mediaLine(s)), reviewKb(ctx));
}

const composing = (s) => !!(s && s.massForm && s.massForm.pay && s.massForm.text != null);

/** 📎 Add / 🖼 Change — ask for the photo, with the skip on screen. */
async function mediaAsk(ctx) {
  await answer(ctx);
  const s = ctx.session;
  if (!composing(s)) return toast(ctx, tpl.render("session_expired"));
  s.awaitingField = "massdm_media";
  await sendCard(ctx, tpl.render("massdm_media_prompt"), mediaKb(s));
}

/** ⏭ Keep it text-only / ↩️ Keep it — back to the preview, nothing changed. */
async function mediaBack(ctx) {
  await answer(ctx);
  const s = ctx.session;
  if (!composing(s)) return toast(ctx, tpl.render("session_expired"));
  return showPreview(ctx);
}

/**
 * ✏️ Edit — re-open the compose step with the ORDER INTACT.
 *
 * ⚠️ It replaces ✏️ Recompose, which pointed at `ad_massdm` — entryMassDm, which
 * freshSessions and asks for the contract address again. So a buyer who wanted
 * to change a word paid the chain detection over again (five candidate chains,
 * bounded at CA_RESOLVE_MS) and could land on a different answer. A button
 * labelled Edit that restarts the flow is the label-contradicting-its-action
 * defect this file keeps recording, so the action moved rather than the word.
 */
async function mdEdit(ctx) {
  await answer(ctx);
  const s = ctx.session;
  if (!composing(s)) return toast(ctx, tpl.render("session_expired"));
  s.awaitingField = "massdm_compose";
  await sendCard(ctx, tpl.render("massdm_edit_prompt"), menu.withHome([]));
}

/** 🗑 Remove — the explicit skip, once something is attached. */
async function mediaClear(ctx) {
  await answer(ctx);
  const s = ctx.session;
  if (!composing(s)) return toast(ctx, tpl.render("session_expired"));
  s.massForm.mediaFileId = null;
  s.massForm.mediaType = null;
  await note(ctx, tpl.render("massdm_media_cleared"));
  return showPreview(ctx);
}

/** A short spoken notice — SENT, not edited into a card that may be off screen. */
async function note(ctx, payload) {
  const { text, extra } = require("../helpers/message").payloadArgs(payload, false);
  await ctx.reply(text, extra).catch(() => {});
}

/** Attach media to a message that has already been composed. */
async function setMedia(ctx, { fileId, type, caption, captionEntities }) {
  const s = ctx.session;
  const f = s.massForm;
  // ⚠️ A CAPTION SENT WITH THE PHOTO REPLACES THE TEXT, AND WE SAY SO. Which of
  // the two readings holds — a deliberate rewrite, or a buyer who typed a line
  // out of habit over the paragraph they already wrote — cannot be inferred
  // from the message, and taking either silently destroys the other.
  const hasCaption = !!(caption && caption.trim());
  const text = hasCaption ? caption : f.text || "";
  const entities = hasCaption ? captionEntities || [] : f.entities || [];
  const limit = captionLimit();
  if (text.length > limit) {
    // ⚠️ REFUSED, NEVER TRIMMED, and NOTHING IS CHANGED. A caption past the
    // limit makes every sendPhoto THROW, so attaching here would fail all
    // 12,000 sends of a broadcast somebody paid for; trimming instead would
    // silently delete most of what they wrote. The numbers are on the card.
    // ⚠️ …and the card carries the ✏️ Edit it tells them to tap. An
    // instruction pointing at a button that is not on the screen is the
    // "📝 Templates → pilih templatenya" defect, on the one card whose whole job
    // is handing the buyer something they can act on.
    return sendCard(
      ctx,
      tpl.render("massdm_media_too_long", { len: String(text.length), limit: String(limit) }),
      mediaKb(s, { recompose: true }),
    );
  }
  f.text = text;
  f.entities = entities;
  f.mediaFileId = fileId;
  f.mediaType = type;
  await note(
    ctx,
    tpl.render("massdm_media_set", {
      kind: MEDIA_KIND[type] || MEDIA_KIND.photo,
      caption: hasCaption ? "Its caption replaced your text." : "Your text is kept as its caption.",
    }),
  );
  return showPreview(ctx);
}

function mediaKb(s, { recompose = false } = {}) {
  const rows = [];
  if (recompose) rows.push([Markup.button.callback("✏️ Edit", "md_edit")]);
  if (s && s.massForm && s.massForm.mediaFileId) {
    rows.push([
      Markup.button.callback("🗑 Remove the photo", "md_nomedia"),
      Markup.button.callback("↩️ Keep it", "md_back"),
    ]);
  } else {
    // THE SKIP, stated as a button rather than left to be inferred.
    rows.push([Markup.button.callback("⏭ Keep it text-only", "md_back")]);
  }
  return menu.withHome(rows);
}

// Step 2 — capture the broadcast message, show the preview + pay/test controls.
async function capture(ctx, { text, entities, mediaFileId, mediaType }) {
  const s = ctx.session;
  const had = s.massForm || {};
  // ⚠️ A MESSAGE CARRYING NO MEDIA KEEPS WHAT IS ATTACHED. On the first compose
  // there is nothing to keep, so this is a no-op there; on ✏️ Edit it is the
  // difference between changing a word and silently deleting the photo the
  // buyer attached two taps ago. Removing it is 🗑 Remove photo, which says so.
  const keep = !mediaFileId && had.mediaFileId;
  s.massForm = {
    ...had,
    text: text || "",
    entities: entities || [],
    mediaFileId: keep ? had.mediaFileId : mediaFileId || null,
    mediaType: keep ? had.mediaType : mediaFileId ? mediaType || "photo" : null,
  };
  return showPreview(ctx);
}

function reviewKb(ctx) {
  const f = ctx.session.massForm;
  const rows = [[Markup.button.callback(`💳 Pay ${f.pay.price} ${f.pay.native}`, "md_pay")]];
  if (isAdminUser(ctx)) rows.push([Markup.button.callback("🧪 Test send (admins only • FREE)", "md_test")]);
  // ⚠️ 🗑 Remove exists only while there is something to remove. A button whose
  // only outcome is a no-op is the row the engine ignores, one screen over.
  rows.push(
    f.mediaFileId
      ? [Markup.button.callback("🖼 Change photo", "md_media"), Markup.button.callback("🗑 Remove photo", "md_nomedia")]
      : [Markup.button.callback("📎 Add a photo", "md_media")],
  );
  rows.push([Markup.button.callback("✏️ Edit", "md_edit"), Markup.button.callback("🏠 Home", "home")]);
  return Markup.inlineKeyboard(rows);
}

async function handleText(ctx) {
  const s = ctx.session;
  if (s.type !== "massdm") return;
  const text = (ctx.message.text || "").trim();
  if (!text) return;
  if (s.awaitingField === "massdm_ca") return captureCa(ctx, text);
  if (s.awaitingField === "massdm_compose") return capture(ctx, { text, entities: ctx.message.entities || [] });
  // ⚠️ TEXT AT THE PHOTO STEP NAMES BOTH READINGS rather than guessing which it
  // is — a new caption, or a buyer who forgot to attach. Taking either silently
  // overwrites the other.
  if (s.awaitingField === "massdm_media") return sendCard(ctx, tpl.render("massdm_media_not_photo"), mediaKb(s));
}

async function handlePhoto(ctx) {
  const s = ctx.session;
  if (s.type !== "massdm") return;
  const m = mediaOf(ctx);
  if (s.awaitingField === "massdm_compose") {
    if (!m.fileId) return sendCard(ctx, tpl.render(m.why || "massdm_media_as_file"), menu.withHome([]));
    return capture(ctx, {
      text: ctx.message.caption || "",
      entities: ctx.message.caption_entities || [],
      mediaFileId: m.fileId,
      mediaType: m.type,
    });
  }
  // The photo step, and the PREVIEW itself: a buyer who drops a photo onto the
  // preview means to attach it, and answering that with silence is "the button
  // does nothing" on a screen they are about to pay from.
  const atPreview = !s.awaitingField && s.massForm && s.massForm.pay && s.massForm.text != null;
  if (s.awaitingField !== "massdm_media" && !atPreview) return;
  if (!m.fileId) return sendCard(ctx, tpl.render(m.why || "massdm_media_as_file"), mediaKb(s));
  return setMedia(ctx, {
    fileId: m.fileId,
    type: m.type,
    caption: ctx.message.caption || "",
    captionEntities: ctx.message.caption_entities || [],
  });
}

async function payPick(ctx) {
  await answer(ctx);
  const s = ctx.session;
  if (!s.massForm || !s.massForm.pay || s.massForm.text == null) return toast(ctx, tpl.render("session_expired"));
  const pay = s.massForm.pay;
  if (pay.price == null) return toast(ctx, tpl.render("pricing_unavailable"));
  await payFlow.startPayment(ctx, {
    kind: "mass_dm",
    chain: pay.payChain,
    native: pay.native,
    humanAmount: pay.price,
    // Mass DM is priced in all three currencies already; handing the table over
    // lets a Solana or BSC buyer settle in ETH on Ethereum or Robinhood Chain.
    prices: MASS_DM_PRICE,
    label: `Mass DM broadcast — to all Dexvra users`,
    payload: {
      text: s.massForm.text,
      entities: s.massForm.entities,
      mediaFileId: s.massForm.mediaFileId,
      // ⚠️ THE TYPE TRAVELS. Without it queueBroadcast files every attachment as
      // a photo, and a GIF broadcast fails on every one of 12,000 sendPhoto
      // calls — the job the buyer just paid for, delivered to nobody.
      mediaType: s.massForm.mediaType || null,
      tokenCa: s.massForm.ca,
      tokenChain: s.massForm.chain,
    },
  });
}

async function testSend(ctx) {
  await answer(ctx);
  if (!isAdminUser(ctx)) return toast(ctx, "Admins only.");
  const s = ctx.session;
  if (!s.massForm || s.massForm.text == null) return toast(ctx, tpl.render("session_expired"));
  const composer = String(ctx.from.id);
  const targets = Array.from(new Set([...ADMIN_IDS.map(String), composer])).filter(Boolean);
  let mediaPath = null;
  const mediaType = s.massForm.mediaFileId ? s.massForm.mediaType || "photo" : undefined;
  if (s.massForm.mediaFileId) mediaPath = await downloadMedia(ctx, s.massForm.mediaFileId, mediaType).catch(() => null);
  await store.createJob({
    text: s.massForm.text,
    entities: s.massForm.entities,
    mediaPath,
    mediaType,
    createdBy: ctx.from.id,
    createdByUsername: ctx.from.username || null,
    targets,
    test: true,
    reportChatId: ctx.from.id,
    ref: refFor(),
  });
  freshSession(ctx, {});
  await sendCard(ctx, tpl.render("massdm_test_queued"), menu.postPurchase());
}

function refFor() {
  return `MD-${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

async function downloadMedia(ctx, fileId, mediaType) {
  const os = require("node:os");
  const path = require("node:path");
  const { promises: fs } = require("node:fs");
  const link = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(link.href || String(link), { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const dir = path.join(os.tmpdir(), "dexvra-massdm");
  await fs.mkdir(dir, { recursive: true });
  const ext = MEDIA_EXT[mediaType] || MEDIA_EXT.photo;
  const file = path.join(dir, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`);
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

module.exports = { entryMassDm, handleText, handlePhoto, payPick, testSend, refFor, downloadMedia, currencyOf, payFor, looksLikeCA, mediaAsk, mediaBack, mediaClear, mdEdit, mediaOf, ensureMediaLine, mediaLine };
