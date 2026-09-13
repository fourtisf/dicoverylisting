// Paid Mass DM sender — runs in the MAIN bot process (only it can DM users who
// /start-ed it). Polls ONLY the mass_dm store for in_progress jobs (an admin
// approval flips pending_review→in_progress). Same delivery engine as the admin
// broadcast (paced, concurrent, media uploaded once + reused by file_id, 429
// retry_after, per-batch persistence) but a SEPARATE runner + dir so the two
// systems never collide (fourtis gotcha 14).
const { BROADCAST_RATE, BROADCAST_CONCURRENCY, BROADCAST_POLL_MS } = require("../config/constants");
const store = require("./store");
const tpl = require("../templates");
const { payloadArgs } = require("../helpers/message");
const log = require("../helpers/logger");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function retryAfter(e) {
  const p1 = e && e.response && e.response.parameters && e.response.parameters.retry_after;
  if (p1 != null) return Number(p1);
  const p2 = e && e.parameters && e.parameters.retry_after;
  if (p2 != null) return Number(p2);
  return null;
}

function jobExtra(job, forCaption) {
  const ents = job.entities || [];
  if (ents.length) {
    return forCaption
      ? { caption: job.text, caption_entities: ents }
      : { entities: ents, disable_web_page_preview: true };
  }
  return forCaption
    ? job.text
      ? { caption: job.text, parse_mode: "HTML" }
      : {}
    : { parse_mode: "HTML", disable_web_page_preview: true };
}

// ── Why a recipient did not get it ──────────────────────────────────────────
//
// A broadcast to a whole /start audience ALWAYS has failures, and nearly all of
// them are somebody who blocked the bot or deleted their account. That is not a
// fault and an operator must not be sent hunting for one — but "Failed: 418"
// with no cause is exactly the shape that sends them, which this file has had
// to fix in four services. Telegram says which in its own error text, and we
// were throwing it away.
//
// ⚠️ AND IT IS COUNTED, NEVER ASSUMED. Rendering every failure as
// "blocked/inactive" would be a cause nobody measured — the one thing this repo
// refuses — so anything OUTSIDE this family is counted apart and named, because
// that is the only half an operator can act on.
const UNREACHABLE =
  /blocked by the user|user is deactivated|chat not found|user not found|bot can'?t initiate|PEER_ID_INVALID|USER_IS_BLOCKED|chat_write_forbidden/i;

function noteFailure(job, e) {
  const why = String((e && e.message) || "");
  if (UNREACHABLE.test(why)) {
    job.unreachable = (job.unreachable || 0) + 1;
    return;
  }
  job.otherFails = (job.otherFails || 0) + 1;
  if (!job.otherWhy) job.otherWhy = why.slice(0, 140);
}

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── Premium (custom) emoji ──────────────────────────────────────────────────
//
// ⚠️ A DM IS A PRIVATE CHAT, AND THAT IS THE WHOLE POINT. Telegram's rule is
// that custom-emoji entities may be used "by bots that purchased additional
// usernames on Fragment, OR in the messages directly sent by the bot to
// private, group and supergroup chats if the owner of the bot has a Telegram
// Premium subscription". A CHANNEL is in neither list — which is why
// channels/post.js needs the GramJS premium account and why premium.js's own
// header says animation needs it. That sentence is true of the channel and NOT
// of this sender, and reading it as a general fact is how a broadcast was
// reported as unable to do something it can do.
//
// ⚠️ AND THE GRAMJS PREMIUM ACCOUNT CANNOT COVER THIS ONE. "dexvra bot sudah
// pakai emoji premium di konekan ke userbot yang punya premium" is true of the
// CHANNEL — src/gramjs.js exposes sendToChannel and nothing else, because a
// user account may not DM twelve thousand strangers who /start-ed a BOT. So the
// userbot's Premium is what animates @dexvraio; the BotFather OWNER's Premium
// is what animates these DMs, and they are two different accounts to check.
//
// So this module sends the entities untouched and lets Telegram decide. Two
// rules follow, because "it worked" and "it was silently downgraded" are
// otherwise the same observation — the defect the 🔄 Refresh board button was
// built to end one surface over. Both report to pm2 rather than to the delivery
// report; see reportText.
const EMOJI_REFUSED = /custom[_ ]?emoji|EMOJI_INVALID/i;
const customCount = (ents) => (ents || []).filter((e) => e.type === "custom_emoji").length;

/**
 * Did the custom emoji actually go out?
 *
 * Telegram ECHOES the entities it accepted on the Message it returns, so one
 * missing from the echo is one it stripped — which is exactly the question this
 * cannot otherwise answer: is this bot allowed to use them at all. ⚠️ What it
 * can NEVER say is whether a given RECIPIENT sees them animated; that is their
 * own Telegram Premium, decided client-side, and claiming it here would be a
 * fact nobody measured.
 *
 * Recorded from the FIRST send only — the answer is a property of the bot, not
 * of the recipient, so 12,000 identical readings are the same reading.
 *
 * ⚠️ THE WARN IS THE READER, now that the delivery report no longer carries the
 * verdict. A value nobody can read is the same as no value, so a downgrade that
 * recorded silently would be this repo's own defect committed by the change
 * that removed the line. Only the NEGATIVE is logged: "the emoji went out" is
 * the ordinary state of a healthy box and a line per broadcast saying so is the
 * noise the removal was asked for.
 */
function notePremium(job, msg) {
  if (job.premiumOut != null || !msg) return;
  const want = customCount(job.entities);
  if (!want) return; // nothing premium in this job — there is no verdict to take
  job.premiumOut = customCount(msg.entities || msg.caption_entities) >= want;
  job.premiumWhy = job.premiumOut
    ? null
    : "Telegram STRIPPED the custom emoji — they went out plain. The bot's OWNER account needs Telegram Premium (the GramJS userbot's Premium covers the channel, not a DM)";
  if (!job.premiumOut) log.warn(`[massdm] ${job.id}: ${job.premiumWhy}`);
}

/**
 * ⚠️ THE EMOJI MAY NEVER COST THE BROADCAST.
 *
 * If Telegram refuses the entities outright rather than stripping them, every
 * one of 12,000 sends fails the same way and a broadcast somebody PAID for
 * reaches nobody. Dropping them job-wide on the first refusal costs the
 * animation and delivers the message, which is the trade this repo makes
 * everywhere else ("losing a link beats losing the listing and the link with
 * it"). Job-wide because `job` is shared by reference: the sibling sends
 * already in flight are fixed by whichever one gets here first.
 */
function stripCustomEmoji(job) {
  if (!customCount(job.entities)) return;
  job.entities = (job.entities || []).filter((e) => e.type !== "custom_emoji");
  job.premiumOut = false;
  job.premiumWhy = "Telegram REFUSED the custom emoji — resent with the plain fallback";
  log.warn(`[massdm] ${job.id}: ${job.premiumWhy}`);
}

// ⚠️ A CLIP SENT THROUGH sendPhoto IS AN ERROR, NOT A STILL. The listing
// broadcast add-on carries the SAME artwork the channel post does, and on a box
// with an admin banner clip configured that is a GIF/MP4 — so the method has to
// follow the media, exactly as channels/post.sendMedia already does. Anything
// unknown is a photo, which is what every job before this one was.
const METHOD = { animation: "sendAnimation", video: "sendVideo" };
const sendMethod = (job) => METHOD[job && job.mediaType] || "sendPhoto";
/** The file_id Telegram hands back, under whichever key this media type uses. */
function fileIdOf(msg, kind) {
  if (!msg) return null;
  if (kind === "animation") return msg.animation && msg.animation.file_id;
  if (kind === "video") return msg.video && msg.video.file_id;
  const photos = msg.photo;
  return photos && photos.length ? photos[photos.length - 1].file_id : null;
}

// Returns the sent Message (truthy) or null — the caller only counts, but the
// MESSAGE is what carries Telegram's verdict on the emoji.
async function sendOne(telegram, job, userId, afterStrip) {
  try {
    const msg = job.mediaFileId
      ? await telegram[sendMethod(job)](userId, job.mediaFileId, job.text ? jobExtra(job, true) : {})
      : await telegram.sendMessage(userId, job.text, jobExtra(job, false));
    notePremium(job, msg);
    return msg || true;
  } catch (e) {
    const ra = retryAfter(e);
    if (ra != null) {
      await sleep((ra + 1) * 1000);
      return sendOne(telegram, job, userId, afterStrip);
    }
    if (!afterStrip && EMOJI_REFUSED.test(String((e && e.message) || ""))) {
      stripCustomEmoji(job);
      return sendOne(telegram, job, userId, true);
    }
    noteFailure(job, e);
    return null;
  }
}

async function primeMedia(telegram, job) {
  if (!job.mediaPath || job.mediaFileId) return;
  const first = job.targets[job.cursor];
  if (first == null) return;
  try {
    const msg = await telegram[sendMethod(job)](first, { source: job.mediaPath }, job.text ? jobExtra(job, true) : {});
    notePremium(job, msg);
    const id = fileIdOf(msg, job.mediaType);
    if (id) job.mediaFileId = id;
    job.sent += 1;
    job.cursor += 1;
    await store.saveJob(job);
  } catch (e) {
    const ra = retryAfter(e);
    if (ra != null) {
      await sleep((ra + 1) * 1000);
      return primeMedia(telegram, job);
    }
    noteFailure(job, e);
    job.failed += 1;
    job.cursor += 1;
    await store.saveJob(job);
  }
}

/**
 * The delivery report.
 *
 * Shaped after the bot this was compared against ("laporanya seperti fourtis
 * aja") — the ref, what paid for it, one line saying it went out, one naming
 * what could not be reached. Deliberately NOT a raw `Reached / Failed /
 * Audience` tally: three bare numbers make the reader do the arithmetic and
 * still say nothing about the only question that matters, which is whether the
 * failures are ordinary.
 *
 * ⚠️ EVERY LINE IS MEASURED, and that is where it differs from copying a
 * screenshot. "Sent to all users" is a CLAIM — false of a run that stopped
 * short and grotesque over a run that reached nobody — so it is printed only
 * when it is true, and the other two states have their own sentence.
 */

/**
 * "Did it go out" — the ONE OWNER of that claim, for BOTH surfaces.
 *
 * "jgn sebut number, blg aja to all user dexvra dan berapa banyak yang gagal
 * kaya fourtis": the ops REPORT and the buyer's RECEIPT now say the same thing
 * to two audiences, and a second copy is how one of them ends up claiming
 * "sent to all users" over a run that stopped short. Only two things differ and
 * the CALLER supplies both: the noun (the buyer is told "Dexvra users", the ops
 * channel just "users") and the emphasis, because the report is `parse_mode:
 * HTML` while the receipt is the markup the template system parses — an `<b>`
 * in a template var reaches the buyer as literal text.
 *
 * ⚠️ THE NUMBERS IN THE OTHER TWO STATES STAY, and that is not the count the
 * ask was about. "Sent to all users" is a CLAIM — grotesque over a run that
 * reached nobody, false of one that stopped short — so those states have their
 * own sentence, and "the run did not finish" with no scale is unactionable.
 */
function reachLine(job, { who = "users", b = (t) => t } = {}) {
  if (job.sent === 0 && job.total > 0) return `📭 ${b("Delivered to nobody")} — every send failed`;
  if (job.sent + job.failed >= job.total) return `📬 ${b(`Sent to all ${who}`)}`;
  return `📬 ${b(`Sent to ${job.sent} of ${job.total}`)} — the run did not finish`;
}

/**
 * What could not be reached, and whether that is ordinary.
 *
 * ⚠️ `why` is OPS-ONLY, and it is what keeps this one function safe on two
 * surfaces: Telegram's own error text is escaped for HTML here, and the buyer's
 * receipt is parsed as markup where an escaped `&lt;` would reach them
 * verbatim. It is also not theirs to read — which upstream call failed is an
 * operator's question, and the buyer's half is numbers only.
 */
function failLine(job, { b = (t) => t, why = false } = {}) {
  if (!job.failed) return ""; // a line saying 0 is noise
  const gone = job.unreachable || 0;
  const other = job.otherFails || 0;
  if (other === 0) return `\n🚫 ${b("Couldn't reach (blocked/inactive):")} ${job.failed}`;
  return (
    `\n🚫 ${b("Couldn't reach:")} ${job.failed} — ${gone} blocked/inactive, ` +
    `${b(`${other} for another reason`)}${why && job.otherWhy ? ` (${esc(job.otherWhy)})` : ""}`
  );
}

const htmlB = (t) => `<b>${t}</b>`;
const mdB = (t) => `**${t}**`;

function reportText(job) {
  const reach = reachLine(job, { b: htmlB });
  const fail = failLine(job, { b: htmlB, why: true });

  // ⚠️ THE PREMIUM-EMOJI VERDICT IS NOT ON THIS REPORT — and it is not gone.
  // It was removed on the operator's call ("hapus teks premium emoji"): they
  // read the state on every report and it never changes, because whether this
  // BOT may use custom emoji is a property of the bot, not of the run. So it
  // moved to a pm2 WARN in notePremium/stripCustomEmoji — the transition rule
  // upstreams.js states, applied to a line that was repeating a settled fact on
  // every broadcast. A plain send still never renders as a ✅ here: with the
  // line gone this report makes no claim about the emoji at all.

  // What paid for it — the add-on rides a listing order, the standalone product
  // IS the order, and an admin test is free. Three different things an operator
  // reading one channel of reports needs to tell apart.
  const paid = job.test ? "free admin test" : job.paid || "paid broadcast";

  return (
    `📣 <b>Broadcast delivered</b>\n` +
    `<b>Ref:</b> <code>${esc(job.ref || job.id)}</code>\n` +
    `<b>Paid:</b> ${esc(paid)}\n` +
    `${reach}${fail}`
  );
}

async function report(telegram, job) {
  if (!job.reportChatId) return;
  try {
    await telegram.sendMessage(job.reportChatId, reportText(job), { parse_mode: "HTML" });
  } catch (e) {
    log.debug(`[massdm] report failed: ${e.message}`);
  }
}

/**
 * The buyer's own confirmation.
 *
 * ⚠️ `reached` IS STILL PASSED even though the shipped copy no longer uses it.
 * `data/templates.json` wins over the code default for ever, so an operator who
 * has edited this card keeps their `reached **{reached}** users` line — and
 * dropping the var would render it as "reached **** users", which is worse than
 * the number the ask was about. They pick the new shape up with ♻️ Reset
 * default on **Mass DM: delivered receipt**.
 */
async function receipt(telegram, job) {
  if (job.test || !job.createdBy) return;
  try {
    const payload = tpl.render("massdm_done", {
      ref: job.ref || job.id,
      reach: reachLine(job, { who: "Dexvra users", b: mdB }),
      fail: failLine(job, { b: mdB }),
      reached: job.sent,
    });
    const { text, extra } = payloadArgs(payload, false);
    await telegram.sendMessage(job.createdBy, text, extra);
  } catch (e) {
    log.debug(`[massdm] receipt failed: ${e.message}`);
  }
}

async function runJob(telegram, job) {
  job.status = "in_progress";
  job.startedAt = job.startedAt || Date.now();
  await store.saveJob(job);
  log.info(
    `[massdm] running ${job.id} (${job.total} targets${job.test ? ", TEST" : ""}${job.autoSend ? ", auto" : ""}, ${job.mediaFileId || job.mediaPath ? job.mediaType || "photo" : "text"})`,
  );

  await primeMedia(telegram, job);

  const CONC = BROADCAST_CONCURRENCY;
  const targetMs = (CONC / BROADCAST_RATE) * 1000;
  for (let i = job.cursor; i < job.targets.length; i += CONC) {
    const batch = job.targets.slice(i, i + CONC);
    const t0 = Date.now();
    const res = await Promise.all(batch.map((uid) => sendOne(telegram, job, uid)));
    job.sent += res.filter(Boolean).length;
    job.failed += res.filter((r) => !r).length;
    job.cursor = Math.min(i + CONC, job.targets.length);
    await store.saveJob(job);
    const elapsed = Date.now() - t0;
    if (elapsed < targetMs) await sleep(targetMs - elapsed);
  }

  job.status = "completed";
  job.finishedAt = Date.now();
  await store.saveJob(job);
  await report(telegram, job);
  await receipt(telegram, job);
  log.info(`[massdm] ${job.id} complete — sent ${job.sent}, failed ${job.failed}`);
}

let running = false;

function start(telegram) {
  const tick = async () => {
    if (running) return;
    const jobs = store.jobsByStatus("in_progress"); // approval flips the status; we only run approved jobs
    if (!jobs.length) return;
    running = true;
    try {
      await runJob(telegram, jobs[0]);
    } catch (e) {
      log.warn(`[massdm] ${e.message}`);
    } finally {
      running = false;
    }
  };
  const iv = setInterval(tick, BROADCAST_POLL_MS);
  const kick = setTimeout(tick, 6000);
  return {
    stop: () => {
      clearInterval(iv);
      clearTimeout(kick);
    },
  };
}

module.exports = { start, runJob, _sendMethod: sendMethod, _fileIdOf: fileIdOf, _notePremium: notePremium, _stripCustomEmoji: stripCustomEmoji, _customCount: customCount, _reportText: reportText, _noteFailure: noteFailure, _reachLine: reachLine, _failLine: failLine };
