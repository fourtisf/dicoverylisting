// Durable mirror for the bot's per-job stores (data/broadcasts/, data/mass_dm/).
// Those dirs hold one JSON file per job with resumable delivery state (status,
// cursor, sent/failed) — losing them on a VPS reset would strand an in-flight
// broadcast or a paid-and-approved Mass DM. This mirrors every saveJob into the
// `jobs` collection and, at boot, restores any job file missing on disk so the
// sender/watchdog/review poller pick up exactly where they left off.
//
// Same fail-open contract as persist.js: without a live Mongo connection every
// call is a no-op and the job stores behave as pure local dirs.
const fss = require("node:fs");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const mongo = require("./mongo");
const { DATA_DIR } = require("../config/constants");
const log = require("../helpers/logger");

const FAMILIES = ["broadcasts", "mass_dm"];

/** Best-effort mirror of one job. Fire-and-forget — never delays saveJob. */
function mirrorJob(dir, job) {
  if (!job || !job.id || !mongo.enabled()) return;
  mongo.jobSet(dir, job.id, job).catch((e) => log.warn(`[jobmirror] ${dir}/${job.id} failed: ${e && e.message}`));
}

/** Restore every mirrored job for a family whose local file is missing. */
async function restoreFamily(dir) {
  if (!mongo.enabled()) return 0;
  const targetDir = path.join(DATA_DIR, dir);
  let restored = 0;
  try {
    const jobs = await mongo.jobsAll(dir);
    if (!jobs.length) return 0;
    await fs.mkdir(targetDir, { recursive: true });
    for (const j of jobs) {
      if (!j || !j.id || j.data === undefined) continue;
      const file = path.join(targetDir, `${j.id}.json`);
      if (fss.existsSync(file)) continue; // never clobber a present (possibly newer) local file
      const tmp = `${file}.${process.pid}.restore.tmp`;
      await fs.writeFile(tmp, JSON.stringify(j.data, null, 2), "utf8");
      await fs.rename(tmp, file);
      restored++;
    }
    return restored;
  } catch (e) {
    log.warn(`[jobmirror] restore ${dir} failed: ${e && e.message}`);
    return restored;
  }
}

/** Restore all job families from the mirror. Call once at boot after
 *  persist.hydrate() (which establishes the Mongo connection). No-op off Mongo. */
async function restoreAll() {
  if (!mongo.enabled()) return;
  let total = 0;
  const counts = [];
  for (const dir of FAMILIES) {
    const n = await restoreFamily(dir);
    total += n;
    counts.push(`${dir}:${n}`);
  }
  if (total > 0) log.info(`[jobmirror] restored ${total} job(s) from mongo (${counts.join(", ")})`);
}

module.exports = { mirrorJob, restoreFamily, restoreAll, FAMILIES };
