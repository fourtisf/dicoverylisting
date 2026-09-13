// Paid Mass DM job store — DELIBERATELY ISOLATED from the admin broadcast store
// (src/broadcast/store.js → data/broadcasts/). Public users pay a flat price to
// DM the whole /start audience once, but nothing sends until an admin approves
// (anti-spam / anti-ban). Keeping the dir separate means the admin broadcast
// sender/watchdog can NEVER see a paid public job and start a second sender
// against it, and vice-versa (fourtis incident 2026-07-16).
//
// Status: pending_review → in_progress → completed | rejected.
//
// ⚠️ TWO WAYS TO SKIP THE REVIEW, AND THEY ARE NOT THE SAME THING.
// `test` is the admin's free verification run (a handful of targets, no
// receipt, labelled as a test in the report). `autoSend` is a REAL paid job
// that needs no human because the bot WROTE it: the listing broadcast add-on
// DMs the listing card this process just rendered and posted to the channel.
// A stranger's free text — the standalone /massdm product — still waits for an
// admin, which is what the anti-spam note above is about.
const fss = require("node:fs");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { DATA_DIR, loadJSONSync } = require("../helpers/persist");
const jobMirror = require("../db/jobMirror");

const MD_DIR = path.join(DATA_DIR, "mass_dm");

/** All /start user ids (strings) — same audience as the admin broadcast. */
function audience() {
  return (loadJSONSync("users.json", []) || []).map(String).filter(Boolean);
}

function ensureDir() {
  try {
    fss.mkdirSync(MD_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function newId() {
  return `md_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function saveJob(job) {
  ensureDir();
  const file = path.join(MD_DIR, `${job.id}.json`);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(job, null, 2), "utf8");
  await fs.rename(tmp, file);
  jobMirror.mirrorJob("mass_dm", job); // durable mirror (best-effort, off Mongo → no-op)
}

/**
 * Create a Mass DM job. `test` jobs (free admin verification) and `autoSend`
 * jobs (content this bot wrote — see the header) skip review and go straight to
 * in_progress; anything a person typed lands in pending_review.
 *
 * `mediaType` is "photo" | "animation" | "video" — the listing add-on carries
 * the same artwork the channel post does, and that can be the admin's GIF/MP4
 * clip. A clip sent through sendPhoto is an error, not a still.
 */
async function createJob({ text, entities, mediaPath, mediaFileId, mediaType, createdBy, createdByUsername, targets, test, autoSend, paid, reportChatId, ref }) {
  const job = {
    id: newId(),
    kind: "mass_dm",
    status: test || autoSend ? "in_progress" : "pending_review",
    text: text || "",
    entities: entities || [],
    mediaPath: mediaPath || null,
    // Already a Telegram file_id (or a URL Telegram can fetch): nothing to
    // upload, so primeMedia skips straight to the paced send.
    mediaFileId: mediaFileId || null,
    mediaType: mediaType || "photo",
    autoSend: !!autoSend,
    createdBy,
    createdByUsername: createdByUsername || null,
    test: !!test,
    // What paid for it, in the operator's words — the delivery report reads it
    // back. An add-on and a standalone purchase land in the same channel, and
    // "paid" with no source is a line nobody can act on.
    paid: paid || null,
    ref: ref || null, // short human ref shown to the buyer / in the receipt
    reportChatId: reportChatId || null, // where the delivery report goes
    targets,
    total: targets.length,
    sent: 0,
    failed: 0,
    cursor: 0,
    createdAt: Date.now(),
  };
  await saveJob(job);
  return job;
}

function loadJob(id) {
  try {
    return JSON.parse(fss.readFileSync(path.join(MD_DIR, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

function jobsByStatus(status) {
  try {
    return fss
      .readdirSync(MD_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => loadJob(f.replace(/\.json$/, "")))
      .filter((j) => j && j.status === status)
      .sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

module.exports = { audience, createJob, saveJob, loadJob, jobsByStatus, MD_DIR };
