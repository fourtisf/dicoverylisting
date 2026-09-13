// User-facing Telegram helpers. Enforces the fourtis "single live card" UX:
// each step deletes the previous bot message and sends a fresh one, so the flow
// feels like one updating message.
//
// Text arguments accept either a plain HTML string (legacy, parse_mode:"HTML")
// or a template PAYLOAD from templates.render():
//   { text, entities } — premium-markup template → sent with entity arrays and
//     NO parse_mode. These are PRIVATE chats, so the custom emoji animate as
//     soon as the bot's OWNER has Telegram Premium — see premium.js's header
//     for the rule and for what the channel needs instead. Telegram strips them
//     when it does not, which is a downgrade rather than a failure.
//   { html }           — legacy admin-saved HTML template
const log = require("./logger");

const HTML = { parse_mode: "HTML", disable_web_page_preview: true };

/** Payload → { text, extra } for sendMessage / { text, extra } captions. */
function payloadArgs(payload, forCaption = false) {
  if (payload && typeof payload === "object") {
    if (payload.html != null) return { text: payload.html, extra: { ...HTML } };
    const ents = payload.entities || [];
    const extra = { disable_web_page_preview: true };
    if (ents.length) extra[forCaption ? "caption_entities" : "entities"] = ents;
    return { text: payload.text || "", extra };
  }
  return { text: String(payload == null ? "" : payload), extra: { ...HTML } };
}

/** answerCbQuery, swallowing the "query is too old" errors on stale taps. */
async function answer(ctx, text, extra) {
  try {
    await ctx.answerCbQuery(text, extra);
  } catch {
    /* stale / double-tap */
  }
}

async function deleteLatest(ctx) {
  const id = ctx.session && ctx.session.latest_bot_message;
  if (!id) return;
  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, id);
  } catch {
    /* already gone / too old */
  }
  if (ctx.session) ctx.session.latest_bot_message = null;
}

/** Delete the previous card, send a fresh text card, remember its id. */
async function sendCard(ctx, payload, keyboard, opts = {}) {
  await deleteLatest(ctx);
  const { text, extra } = payloadArgs(payload, false);
  try {
    const msg = await ctx.reply(text, { ...extra, ...opts, ...(keyboard || {}) });
    if (ctx.session) ctx.session.latest_bot_message = msg.message_id;
    return msg;
  } catch (e) {
    log.warn(`[msg] sendCard failed: ${e.message}`);
    return null;
  }
}

/** Same, but with a photo (used for the listing review card). `photo` is a
 *  file_id, URL string, or { source }. Falls back to a text card on failure. */
async function sendPhotoCard(ctx, photo, payload, keyboard, opts = {}) {
  await deleteLatest(ctx);
  const { text, extra } = payloadArgs(payload, true);
  try {
    const msg = await ctx.replyWithPhoto(photo, { caption: text, ...extra, ...opts, ...(keyboard || {}) });
    if (ctx.session) ctx.session.latest_bot_message = msg.message_id;
    return msg;
  } catch (e) {
    log.debug(`[msg] photo card failed (${e.message}) — falling back to text`);
    return sendCard(ctx, payload, keyboard, opts);
  }
}

/** Plain reply that does NOT touch the single-card slot (transient notices). */
async function toast(ctx, payload, opts = {}) {
  const { text, extra } = payloadArgs(payload, false);
  try {
    return await ctx.reply(text, { ...extra, ...opts });
  } catch {
    return null;
  }
}

/** Extract the file_id of any media in the incoming message (photo/doc/anim/video). */
function getMediaFileId(ctx) {
  const m = (ctx && ctx.message) || {};
  if (m.photo && m.photo.length) return m.photo[m.photo.length - 1].file_id;
  if (m.document) return m.document.file_id;
  if (m.animation) return m.animation.file_id;
  if (m.video) return m.video.file_id;
  return null;
}

module.exports = { answer, deleteLatest, sendCard, sendPhotoCard, toast, getMediaFileId, payloadArgs, HTML };
