// Broadcast job store (data/broadcasts/). The admin bot writes a job; the MAIN
// bot's sender picks it up and delivers (only the main bot can DM users who
// /start-ed it). Audience = data/users.json (the /start set).
const fss = require("node:fs");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { DATA_DIR, loadJSONSync } = require("../helpers/persist");
const jobMirror = require("../db/jobMirror");

const BC_DIR = path.join(DATA_DIR, "broadcasts");

/** All /start user ids (strings). */
function audience() {
  return (loadJSONSync("users.json", []) || []).map(String).filter(Boolean);
}

function ensureDir() {
  try {
    fss.mkdirSync(BC_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function newId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function saveJob(job) {
  ensureDir();
  const file = path.join(BC_DIR, `${job.id}.json`);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(job, null, 2), "utf8");
  await fs.rename(tmp, file);
  jobMirror.mirrorJob("broadcasts", job); // durable mirror (best-effort, off Mongo → no-op)
}

async function createJob({ text, entities, mediaPath, createdBy, createdByUsername, targets, test }) {
  const job = {
    id: newId(),
    status: "pending",
    text: text || "",
    entities: entities || [], // premium-emoji/format entities from the admin's compose message
    mediaPath: mediaPath || null,
    mediaFileId: null, // filled after the first upload (reused thereafter)
    createdBy,
    createdByUsername: createdByUsername || null,
    test: !!test,
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
    return JSON.parse(fss.readFileSync(path.join(BC_DIR, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

function jobsByStatus(status) {
  try {
    return fss
      .readdirSync(BC_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => loadJob(f.replace(/\.json$/, "")))
      .filter((j) => j && j.status === status)
      .sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

/** Every job on disk, newest first — the manager panel's history. */
function allJobs() {
  try {
    return fss
      .readdirSync(BC_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => loadJob(f.replace(/\.json$/, "")))
      .filter(Boolean)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } catch {
    return [];
  }
}

/** All-time numbers for the Broadcast Manager card. REAL sends only: a 🧪
 *  test is the admin checking their own copy, and an ✏️ edit re-touches
 *  messages a send already counted — either would inflate every number the
 *  card exists to report. Takes the job list as an argument so the arithmetic
 *  is testable without a disk (and so a test cannot race another suite's
 *  transient job files). */
function stats(jobs = allJobs()) {
  const real = jobs.filter((j) => !j.test && (j.kind || "send") === "send");
  const done = real.filter((j) => j.status === "completed");
  const sent = done.reduce((s, j) => s + (j.sent || 0), 0);
  const failed = done.reduce((s, j) => s + (j.failed || 0), 0);
  const attempted = sent + failed;
  return {
    broadcasts: real.length,
    done: done.length,
    sent,
    failed,
    // null, never a fabricated 100%: with nothing attempted there is no rate.
    successRate: attempted ? (sent / attempted) * 100 : null,
    lastCompleted:
      done.slice().sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))[0] || null,
  };
}

/** Queue an ✏️ EDIT of an already-delivered broadcast — the same new text on
 *  every message the send actually delivered, paced by the same sender.
 *  Self-contained on purpose: the recipient message ids are COPIED in, so
 *  nothing that later happens to the source job can re-aim the edits. */
async function createEditJob({ sourceId, text, entities, createdBy, createdByUsername }) {
  const src = loadJob(sourceId);
  if (!src) return { error: "not_found" };
  const mids = src.sentIds || {};
  const targets = Object.keys(mids);
  // A job sent before message ids were recorded has nothing to point an edit
  // at — a different fact from "the job does not exist", and the panel says so.
  if (!targets.length) return { error: "no_ids" };
  const job = {
    id: newId(),
    kind: "edit",
    sourceId,
    status: "pending",
    text: text || "",
    entities: entities || [],
    mids,
    hasMedia: !!(src.mediaFileId || src.mediaPath),
    createdBy,
    createdByUsername: createdByUsername || null,
    test: !!src.test,
    targets,
    total: targets.length,
    sent: 0,
    failed: 0,
    cursor: 0,
    createdAt: Date.now(),
  };
  await saveJob(job);
  return { job };
}

module.exports = {
  audience,
  createJob,
  createEditJob,
  saveJob,
  loadJob,
  jobsByStatus,
  allJobs,
  stats,
  BC_DIR,
};
