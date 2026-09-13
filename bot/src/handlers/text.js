// Free-text + media routers. Dispatch to whichever flow is active on the
// session. Private-chat only. Registered LAST so specific actions win first.
const log = require("../helpers/logger");

const LISTING = new Set(["xpress_listing", "tiered_listing"]);

/** A contract pasted with nothing running. Answered only when it really is a
 *  contract AND already listed — anything else stays silent, because this path
 *  sees every stray message in every DM. */
async function bareContract(ctx, raw) {
  if (raw.startsWith("/")) return;
  const listed = require("../helpers/listedGuard");
  const hit = listed.extractAddress(raw);
  if (!hit) return;
  try {
    const row = await listed.existingListing(hit.address, hit.chain);
    if (row) await listed.sendAlreadyListed(ctx, row);
  } catch (e) {
    // Not listed, or we could not tell: say nothing. An unprompted error card
    // for a message the user never asked us to act on is worse than silence.
    log.warn(`[text] bare-contract lookup: ${e.message}`);
  }
}

async function textRouter(ctx) {
  if (!ctx.chat || ctx.chat.type !== "private") return;
  const s = ctx.session || {};
  const raw = ctx.message && ctx.message.text ? ctx.message.text : "";
  // The broadcast add-on used to intercept here, above the `!s.type` return,
  // because it was composed from the PAY CARD and that card has no session.type
  // of its own. It is ONE TAP now and carries the listing card itself, so there
  // is no text step to route — see handlers/pay.js. Do not add one back without
  // reading that header: a compose step on this card must run above the flow
  // dispatch, not inside any one flow.
  //
  // No flow running. Pasting a contract straight into the chat is the most
  // common thing a project owner does, and it used to fall into "ignore
  // chatter" — the bot said nothing at all. If the token is already on the
  // site, answer with its page and point at Book Trending.
  if (!s.type) return await bareContract(ctx, raw);
  const text = raw;
  // Let real commands fall through to their bot.command handlers (except /skip,
  // which flows consume as an inline "skip this field").
  if (text.startsWith("/") && text !== "/skip") return;

  try {
    if (LISTING.has(s.type)) return await require("./listing").handleText(ctx);
    if (s.type === "trend") return await require("./trending").handleText(ctx);
    if (s.type === "banner") return await require("./banner").handleText(ctx);
    if (s.type === "massdm") return await require("./massdm").handleText(ctx);
  } catch (e) {
    log.warn(`[text] ${s.type} handler: ${e.message}`);
    // ⚠️ The user was PROMPTED for this input — a flow asked a question and
    // they answered it. Swallowing the error into a warn nobody reads leaves
    // the prompt card standing over a bot that never replies, which reads as
    // dead and gets reported as dead. The refusal-off-screen lesson, on text.
    await require("../helpers/message").toast(ctx, require("../templates").render("flow_step_failed"));
  }
}

async function mediaRouter(ctx) {
  if (!ctx.chat || ctx.chat.type !== "private") return;
  const s = ctx.session || {};
  if (!s.type) return;
  try {
    if (LISTING.has(s.type)) return await require("./listing").handlePhoto(ctx);
    if (s.type === "banner") return await require("./banner").handlePhoto(ctx);
    if (s.type === "massdm") return await require("./massdm").handlePhoto(ctx);
  } catch (e) {
    log.warn(`[media] ${s.type} handler: ${e.message}`);
    // Same rule as textRouter: an answered prompt is never met with silence.
    await require("../helpers/message").toast(ctx, require("../templates").render("flow_step_failed"));
  }
}

module.exports = { textRouter, mediaRouter };
