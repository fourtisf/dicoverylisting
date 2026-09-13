// Gainers-banner publish queue — the hand-off between the two bot processes.
//
// WHY A QUEUE: @dexvraadminbot is its own process. It can neither post to the
// channels (only @dexvrabot is an admin there, and channels/post is attached in
// the MAIN bot only) nor open its own GramJS client — a second MTProto client on
// the same session risks AUTH_KEY_DUPLICATED and would revoke the premium login.
// So the admin bot RENDERS the banner (canvas works in any process), writes the
// PNG plus its caption here, and the main bot publishes it.
//
// This is deliberately its OWN directory, not forcepost/: the force-post runner
// claims every job it finds in its mailbox, and one runner reading another's dir
// is how two senders end up publishing the same thing (see CLAUDE.md gotcha 14
// on the fourtis side — the two broadcast stores stay separate for exactly this
// reason).
//
// The image is a FILE, not base64 in the JSON: a 500 KB banner inflates ~33% in
// base64, and the JSON is read by a poller every few seconds.
const fss = require("node:fs");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { DATA_DIR } = require("../helpers/persist");

const GP_DIR = path.join(DATA_DIR, "gainerspost");
// A request the runner never picked up (main bot down) must not fire hours later:
// a stale leaderboard posted as "live" is worse than no post at all.
const STALE_MS = 10 * 60 * 1000;

function ensureDir() {
  try {
    fss.mkdirSync(GP_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}
const fileOf = (id) => path.join(GP_DIR, `${id}.json`);
const imageOf = (id) => path.join(GP_DIR, `${id}.png`);
let seq = 0;
const newId = () => `gp_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function write(job) {
  ensureDir();
  const tmp = `${fileOf(job.id)}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(job, null, 2), "utf8");
  await fs.rename(tmp, fileOf(job.id));
  return job;
}

/**
 * Queue a banner for publishing.
 *
 * The IMAGE is written before the job JSON — the JSON is what the runner looks
 * for, so it must never point at a half-written PNG.
 *
 * @param {object} o
 * @param {Buffer} o.image     the rendered banner
 * @param {object} o.caption   {text, entities} payload (channels/post shape)
 * @param {string} o.channel   target channel (@name or -100…)
 * @param {string} o.template  template id, for the log line and the ack
 * @param {string[]} o.symbols tickers on the banner, for the ack
 * @param {string} o.xList     the SAME board as plain text, for the tweet. Built
 *   by the admin bot because only it has the coin objects; the X credentials and
 *   client live in the main bot, so the copy has to travel with the job. Empty
 *   string = don't tweet this one.
 * @param {string} o.xDate     date line for the tweet ("" when the operator
 *   turned the date off, so the tweet matches the banner).
 */
async function request({ image, caption, channel, template, symbols = [], xList = "", xDate = "", by = "admin", pin = false }) {
  ensureDir();
  const id = newId();
  const img = imageOf(id);
  const tmp = `${img}.${process.pid}.tmp`;
  await fs.writeFile(tmp, image);
  await fs.rename(tmp, img);
  return write({
    id,
    kind: "gainers",
    template,
    channel,
    caption,
    symbols,
    xList,
    xDate,
    imagePath: img,
    pin: Boolean(pin),
    by,
    status: "pending",
    at: Date.now(),
  });
}

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
    return fss.readdirSync(GP_DIR).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
}

/** Pending jobs, oldest first. A pure read — stale ones are filtered here and
 *  retired by expireStale(), so "did it expire yet?" never depends on a race. */
function pending() {
  const now = Date.now();
  return jobFiles()
    .map((n) => get(n.replace(/\.json$/, "")))
    .filter((j) => j && j.status === "pending" && now - j.at <= STALE_MS)
    .sort((a, b) => a.at - b.at);
}

/** Retire requests the runner never picked up, and drop their images. */
async function expireStale() {
  const now = Date.now();
  let n = 0;
  for (const name of jobFiles()) {
    const job = get(name.replace(/\.json$/, ""));
    if (!job || job.status !== "pending" || now - job.at <= STALE_MS) continue;
    await write({ ...job, status: "expired", doneAt: now });
    await fs.unlink(job.imagePath || imageOf(job.id)).catch(() => {});
    n++;
  }
  return n;
}

/** pending → running BEFORE publishing, so a crash mid-post can't double-post. */
async function claim(id) {
  const job = get(id);
  if (!job || job.status !== "pending") return null;
  return write({ ...job, status: "running", claimedAt: Date.now() });
}

/** Record the outcome and delete the image — the bytes were the payload, and the
 *  admin bot only needs the result to show an ack. */
async function finish(id, { ok, result = null, error = null }) {
  const job = get(id);
  if (!job) return null;
  await fs.unlink(job.imagePath || imageOf(id)).catch(() => {});
  return write({ ...job, status: ok ? "done" : "failed", result, error, doneAt: Date.now() });
}

/** Delete finished jobs (and any orphan image) older than `maxAgeMs`. This dir is
 *  a mailbox, not history. */
async function prune(maxAgeMs = 6 * 60 * 60 * 1000) {
  ensureDir();
  const now = Date.now();
  let n = 0;
  for (const name of jobFiles()) {
    const id = name.replace(/\.json$/, "");
    const job = get(id);
    if (!job || job.status === "pending" || job.status === "running") continue;
    if (now - (job.doneAt || job.at) > maxAgeMs) {
      await fs.unlink(path.join(GP_DIR, name)).catch(() => {});
      await fs.unlink(job.imagePath || imageOf(id)).catch(() => {});
      n++;
    }
  }
  return n;
}

module.exports = { request, get, pending, expireStale, claim, finish, prune, GP_DIR, STALE_MS, _imageOf: imageOf };
