// Force-post request queue — the hand-off between the two bot processes.
//
// WHY A QUEUE AND NOT A DIRECT CALL: the admin bot is its own process. It can
// neither post to the channels (only @dexvrabot is an admin there, and
// channels/post is attached in the MAIN bot only) nor open its own GramJS
// client (a second MTProto client on the same session risks AUTH_KEY_DUPLICATED
// and would revoke the premium login). So @dexvraadminbot writes a REQUEST and
// the main bot — the process that already owns both transports — publishes it.
// Same split the admin broadcast uses.
//
// One file per job, in its OWN directory: the requester writes it once, the
// runner writes the result once, so the two processes never fight over a file.
const fss = require("node:fs");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { DATA_DIR } = require("../helpers/persist");

const FP_DIR = path.join(DATA_DIR, "forcepost");
// A request the runner never picked up (main bot down) must not fire hours
// later when it comes back — an unexpected public post is worse than none.
const STALE_MS = 5 * 60 * 1000;

function ensureDir() {
  try {
    fss.mkdirSync(FP_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}
const fileOf = (id) => path.join(FP_DIR, `${id}.json`);
let seq = 0;
const newId = () => `fp_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function write(job) {
  ensureDir();
  const tmp = `${fileOf(job.id)}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(job, null, 2), "utf8");
  await fs.rename(tmp, fileOf(job.id));
  return job;
}

/** Queue a publish request. Returns the job (status "pending"). */
async function request(kind, { by = "admin" } = {}) {
  return write({ id: newId(), kind, by, status: "pending", at: Date.now() });
}

/** Read one job, or null. */
function get(id) {
  try {
    return JSON.parse(fss.readFileSync(fileOf(id), "utf8"));
  } catch {
    return null;
  }
}

function jobFiles() {
  ensureDir();
  try {
    return fss.readdirSync(FP_DIR).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
}

/** Pending jobs the runner should publish, oldest first. A pure read — stale
 *  ones are filtered out here and retired by expireStale(); a getter that also
 *  wrote made "did it expire yet?" depend on a race. */
function pending() {
  const now = Date.now();
  return jobFiles()
    .map((n) => get(n.replace(/\.json$/, "")))
    .filter((j) => j && j.status === "pending" && now - j.at <= STALE_MS)
    .sort((a, b) => a.at - b.at);
}

/** Retire requests the runner never picked up (main bot was down): publishing
 *  them an hour late would be a surprise public post. Returns how many. */
async function expireStale() {
  const now = Date.now();
  let n = 0;
  for (const name of jobFiles()) {
    const job = get(name.replace(/\.json$/, ""));
    if (!job || job.status !== "pending" || now - job.at <= STALE_MS) continue;
    await write({ ...job, status: "expired", doneAt: now });
    n++;
  }
  return n;
}

/** Record the outcome so the admin bot can show it. */
async function finish(id, { ok, results = [], error = null }) {
  const job = get(id);
  if (!job) return null;
  return write({ ...job, status: ok ? "done" : "failed", results, error, doneAt: Date.now() });
}

/** Mark a job as being worked on, so a restart mid-publish can't repeat it. */
async function claim(id) {
  const job = get(id);
  if (!job || job.status !== "pending") return null;
  return write({ ...job, status: "running", claimedAt: Date.now() });
}

/** Delete finished jobs older than a day — this dir is a mailbox, not history. */
async function prune(maxAgeMs = 24 * 60 * 60 * 1000) {
  ensureDir();
  const now = Date.now();
  let names = [];
  try {
    names = fss.readdirSync(FP_DIR).filter((n) => n.endsWith(".json"));
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    const job = get(name.replace(/\.json$/, ""));
    if (!job || job.status === "pending" || job.status === "running") continue;
    if (now - (job.doneAt || job.at) > maxAgeMs) {
      await fs.unlink(path.join(FP_DIR, name)).catch(() => {});
      n++;
    }
  }
  return n;
}

module.exports = { request, get, pending, expireStale, claim, finish, prune, FP_DIR, STALE_MS };
