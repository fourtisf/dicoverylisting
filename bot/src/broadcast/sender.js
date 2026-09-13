// Broadcast sender — runs in the MAIN bot process (only it can DM /start users).
// Polls for pending/in-progress jobs and delivers with fourtis-style rules:
// paced BROADCAST_RATE msg/s in BROADCAST_CONCURRENCY-wide batches, media
// uploaded ONCE then reused by file_id, 429 retry_after honoured, progress
// persisted per batch (restart-resumable). Two job kinds share the loop:
// "send" delivers a new message (recording each recipient's message id), and
// "edit" rewrites the messages a completed send delivered — ✏️ Edit Sent on
// the admin's Broadcast Manager.
const { BROADCAST_RATE, BROADCAST_CONCURRENCY, BROADCAST_POLL_MS } = require("../config/constants");
const store = require("./store");
const log = require("../helpers/logger");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function retryAfter(e) {
  const p1 = e && e.response && e.response.parameters && e.response.parameters.retry_after;
  if (p1 != null) return Number(p1);
  const p2 = e && e.parameters && e.parameters.retry_after;
  if (p2 != null) return Number(p2);
  return null;
}

/** Caption/text extra for a job: admin-composed entities (premium emoji kept —
 *  Telegram strips custom emoji it can't send, leaving the unicode fallback)
 *  or legacy HTML when the compose had no entities. */
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

/** Delivered message ids are RECORDED per recipient (job.sentIds) — they are
 *  what makes ✏️ Edit Sent possible at all: without the id, a delivered
 *  message can never be found again. */
function recordSent(job, userId, msg) {
  if (msg && msg.message_id != null) {
    (job.sentIds = job.sentIds || {})[String(userId)] = msg.message_id;
  }
}

async function sendOne(telegram, job, userId) {
  try {
    let msg;
    if (job.mediaFileId) {
      msg = await telegram.sendPhoto(userId, job.mediaFileId, job.text ? jobExtra(job, true) : {});
    } else {
      msg = await telegram.sendMessage(userId, job.text, jobExtra(job, false));
    }
    recordSent(job, userId, msg);
    return true;
  } catch (e) {
    const ra = retryAfter(e);
    if (ra != null) {
      await sleep((ra + 1) * 1000);
      return sendOne(telegram, job, userId);
    }
    return false; // user blocked / deactivated / bad id — count as failed, don't retry
  }
}

/** One recipient of an ✏️ edit job: rewrite the message the source send
 *  delivered to them. Text edits text; a media send edits the CAPTION — the
 *  photo itself cannot be replaced by an edit job, and the panel says so. */
async function editOne(telegram, job, userId) {
  const mid = job.mids ? job.mids[String(userId)] : null;
  if (mid == null) return false;
  const ents = job.entities || [];
  try {
    if (job.hasMedia) {
      await telegram.editMessageCaption(
        userId,
        mid,
        undefined,
        job.text,
        ents.length ? { caption_entities: ents } : { parse_mode: "HTML" },
      );
    } else {
      await telegram.editMessageText(userId, mid, undefined, job.text, jobExtra(job, false));
    }
    return true;
  } catch (e) {
    // "message is not modified" = the message already says exactly this.
    // Nothing was lost, so it counts as edited — a red ❌ for it would send
    // the admin hunting for a fault that does not exist.
    if (/not modified/i.test((e && e.message) || "")) return true;
    const ra = retryAfter(e);
    if (ra != null) {
      await sleep((ra + 1) * 1000);
      return editOne(telegram, job, userId);
    }
    return false; // recipient deleted the message / left — count as failed
  }
}

/** Upload media once to the FIRST recipient, capture the main-bot file_id. */
async function primeMedia(telegram, job) {
  if (!job.mediaPath || job.mediaFileId) return;
  const first = job.targets[job.cursor];
  if (first == null) return;
  try {
    const msg = await telegram.sendPhoto(
      first,
      { source: job.mediaPath },
      job.text ? jobExtra(job, true) : {},
    );
    const photos = msg && msg.photo;
    if (photos && photos.length) job.mediaFileId = photos[photos.length - 1].file_id;
    recordSent(job, first, msg);
    job.sent += 1;
    job.cursor += 1;
    await store.saveJob(job);
  } catch (e) {
    const ra = retryAfter(e);
    if (ra != null) {
      await sleep((ra + 1) * 1000);
      return primeMedia(telegram, job);
    }
    // first recipient unreachable — skip it, still try to get a file_id next batch
    job.failed += 1;
    job.cursor += 1;
    await store.saveJob(job);
  }
}

async function runJob(telegram, job) {
  const isEdit = (job.kind || "send") === "edit";
  job.status = "in_progress";
  job.startedAt = job.startedAt || Date.now();
  await store.saveJob(job);
  log.info(
    `[broadcast] running ${job.id} (${job.total} targets${isEdit ? ", EDIT" : ""}${job.test ? ", TEST" : ""})`,
  );

  if (!isEdit) await primeMedia(telegram, job); // upload media once

  const worker = isEdit ? editOne : sendOne;
  const CONC = BROADCAST_CONCURRENCY;
  const targetMs = (CONC / BROADCAST_RATE) * 1000;
  for (let i = job.cursor; i < job.targets.length; i += CONC) {
    const batch = job.targets.slice(i, i + CONC);
    const t0 = Date.now();
    const res = await Promise.all(batch.map((uid) => worker(telegram, job, uid)));
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
  log.report(
    `📣 <b>Broadcast ${isEdit ? "edit " : ""}complete</b>${job.test ? " (TEST)" : ""}\n` +
      `<b>${isEdit ? "Edited" : "Sent"}:</b> ${job.sent}  <b>Failed:</b> ${job.failed}  <b>Total:</b> ${job.total}\n` +
      `<b>By:</b> ${job.createdByUsername ? "@" + job.createdByUsername : ""} <code>${job.createdBy}</code>`,
  );
}

let running = false;

function start(telegram) {
  const tick = async () => {
    if (running) return;
    // resume an interrupted job first, then start the next pending one
    const jobs = [...store.jobsByStatus("in_progress"), ...store.jobsByStatus("pending")];
    if (!jobs.length) return;
    running = true;
    try {
      await runJob(telegram, jobs[0]);
    } catch (e) {
      log.warn(`[broadcast] ${e.message}`);
    } finally {
      running = false;
    }
  };
  const iv = setInterval(tick, BROADCAST_POLL_MS);
  const kick = setTimeout(tick, 4000);
  return {
    stop: () => {
      clearInterval(iv);
      clearTimeout(kick);
    },
  };
}

module.exports = { start, runJob };
