// Durable mirror of the bot's BINARY data (banner GIF/MP4/webm/mov clips, still
// artwork PNGs, the welcome banner image) into MongoDB GridFS — the JSON stores
// go through persist.js/kv, this covers everything kv can't. Same contract as
// persist.hydrate(): fail-open (no-op without Mongo), restore-missing-then-seed
// on boot, and a periodic sweep so files written by the OTHER process (the web
// admin panel writes clips/artwork straight into this shared DATA_DIR) get
// mirrored too, without either process having to call us.
const path = require("node:path");
const fss = require("node:fs");
const { DATA_DIR, GRAMJS_SESSION_FILE } = require("../config/constants");
const mongo = require("./mongo");
const log = require("../helpers/logger");

// The premium userbot login (a GramJS string session). Mirroring it means a
// fresh container recovers the premium account WITHOUT a manual re-login. It is
// auth material — keep the Mongo DB private. Lives OUTSIDE DATA_DIR, so it is
// handled explicitly (not by the DATA_DIR blob scan).
const SESSION_BLOB = "gramjs-session";

// Binary files worth backing up (NOT the .json stores — those go via kv, and a
// .tmp write-in-progress must never be mirrored).
// gainers-background.png is the artwork an admin uploads for the Top-Gainers
// banner; like every other uploaded asset it must survive a container replace,
// or the operator silently loses their background on the next deploy.
// jpg/png belong on the banner-media branch too: the group-alert slots take a
// still photo as their media, and a media type missing from here is an upload
// the operator loses on the next container replace, silently.
const BLOB_RE = /^(banner-media-.+\.(gif|mp4|webm|mov|jpe?g|png)|banner-template-.+\.png|gainers-background\.png|banner)$/i;
const isBlob = (name) => BLOB_RE.test(name) && !name.endsWith(".tmp");

function localBlobs() {
  try {
    return fss.readdirSync(DATA_DIR).filter((f) => isBlob(f) && safeSize(f) > 0);
  } catch {
    return [];
  }
}
function safeSize(name) {
  try {
    return fss.statSync(path.join(DATA_DIR, name)).size;
  } catch {
    return 0;
  }
}

/** Push one local file to Mongo (best-effort; never throws). */
async function mirrorFile(name) {
  if (!isBlob(name) || !mongo.enabled()) return;
  try {
    const buf = await fss.promises.readFile(path.join(DATA_DIR, name));
    if (buf.length > 0) await mongo.blobSet(name, buf);
  } catch (e) {
    log.warn(`[media] mirror ${name}: ${e && e.message}`);
  }
}
/** Drop a file's Mongo copy (called when the local file is removed). */
async function deleteMirror(name) {
  if (!mongo.enabled()) return;
  await mongo.blobDelete(name).catch(() => {});
}

/** Push the premium userbot session to Mongo (best-effort). */
async function mirrorSession() {
  if (!mongo.enabled() || !GRAMJS_SESSION_FILE) return;
  try {
    const buf = await fss.promises.readFile(GRAMJS_SESSION_FILE);
    if (buf.length > 10) await mongo.blobSet(SESSION_BLOB, buf);
  } catch {
    /* no session file yet — nothing to mirror */
  }
}
/** Restore the session from Mongo when it's missing locally. Returns true if it
 *  wrote one (so the caller can log that the premium login was recovered). */
async function restoreSession() {
  if (!mongo.enabled() || !GRAMJS_SESSION_FILE) return false;
  let localSize = 0;
  try {
    localSize = (await fss.promises.stat(GRAMJS_SESSION_FILE)).size;
  } catch {
    /* missing */
  }
  if (localSize > 10) return false; // a valid local session already exists
  try {
    const buf = await mongo.blobGet(SESSION_BLOB);
    if (buf && buf.length > 10) {
      await fss.promises.mkdir(path.dirname(GRAMJS_SESSION_FILE), { recursive: true });
      await writeAtomic(GRAMJS_SESSION_FILE, buf);
      return true;
    }
  } catch (e) {
    log.warn(`[media] session restore: ${e && e.message}`);
  }
  return false;
}

/** Boot convergence: restore any mirrored blob missing locally (fresh container),
 *  then seed Mongo from any local blob not yet mirrored. Runs AFTER
 *  persist.hydrate() has established the connection. No-op off Mongo. */
async function hydrate() {
  if (!mongo.configured()) return { mode: "file" };
  const db = await mongo.connect();
  if (!db || !mongo.enabled()) return { mode: "file" };
  try {
    const remote = await mongo.blobList();
    const remoteByName = new Map(remote.map((f) => [f.filename, f]));
    let restored = 0;
    for (const f of remote) {
      const p = path.join(DATA_DIR, f.filename);
      const local = safeSize(f.filename);
      if (local === 0 || local !== f.length) {
        const buf = await mongo.blobGet(f.filename);
        if (buf && buf.length) {
          await fss.promises.mkdir(DATA_DIR, { recursive: true });
          await writeAtomic(p, buf);
          restored++;
        }
      }
    }
    let seeded = 0;
    for (const name of localBlobs()) {
      const r = remoteByName.get(name);
      if (!r || r.length !== safeSize(name)) {
        await mirrorFile(name);
        seeded++;
      }
    }
    // Premium userbot session: restore if missing (before GramJS connects), else
    // seed the mirror from the local one.
    const sessRestored = await restoreSession();
    await mirrorSession();
    log.info(
      `[media] mongo hydrate: ${remote.length} blob(s) in db, restored ${restored}, seeded ${seeded}` +
        (sessRestored ? " · premium session RESTORED" : ""),
    );
    return { mode: "mongo", blobs: remote.length, restored, seeded, sessRestored };
  } catch (e) {
    log.warn(`[media] hydrate error — continuing on local files: ${e && e.message}`);
    return { mode: "file" };
  }
}

async function writeAtomic(file, buf) {
  const tmp = `${file}.mmirror.${process.pid}.tmp`;
  await fss.promises.writeFile(tmp, buf);
  await fss.promises.rename(tmp, file);
}

/** Periodic sweep: mirror any local blob whose size differs from Mongo's copy
 *  (catches files the web admin panel wrote into DATA_DIR). Cheap — it only
 *  compares sizes and uploads the diffs. Returns a stop() handle. */
function startSweep(everyMs = 10 * 60 * 1000) {
  const run = async () => {
    if (!mongo.enabled()) return;
    try {
      const remote = new Map((await mongo.blobList()).map((f) => [f.filename, f.length]));
      for (const name of localBlobs()) {
        if (remote.get(name) !== safeSize(name)) await mirrorFile(name);
      }
      // Catch a re-login done via scripts/gramjs-login.js between boots.
      await mirrorSession();
    } catch (e) {
      log.debug(`[media] sweep: ${e && e.message}`);
    }
  };
  const iv = setInterval(run, everyMs);
  const kick = setTimeout(run, 90_000); // first pass shortly after boot
  return {
    stop: () => {
      clearInterval(iv);
      clearTimeout(kick);
    },
  };
}

module.exports = { mirrorFile, deleteMirror, hydrate, startSweep, localBlobs, isBlob, mirrorSession, restoreSession };
