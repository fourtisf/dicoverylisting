// Tiny JSON-file persistence under DATA_DIR (gitignored). Used for restart-safe
// dedup sets (pump latch, trending post locks), the /start audience, paid-order
// recovery records, templates, group + banner config, etc.
//
// DURABILITY: when MONGO_URI is set (see db/mongo.js) every saveJSON ALSO mirrors
// the store into MongoDB's `kv` collection, and hydrate() at boot restores any
// store whose local file is missing (fresh container / VPS replace). Reads stay
// on the local file — the two bot processes share one DATA_DIR, so the file is
// already the live cross-process medium; Mongo is the durable backup. Everything
// is fail-open: no MONGO_URI or an unreachable server → exactly the old
// local-file-only behaviour.
const fss = require("node:fs");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DATA_DIR, MIRROR_SWEEP_MS } = require("../config/constants");
const mongo = require("../db/mongo");
const log = require("./logger");

function ensureDir() {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function loadJSONSync(name, def) {
  return readJSONSync(name, def).value;
}

/**
 * The same read, with the reason — because "there is no file yet" and "the file
 * is there and I could not read it" are DIFFERENT FACTS and `loadJSONSync`
 * answers `def` to both.
 *
 * ⚠️ That collapse is destructive for an append-only store. `autoLister`'s
 * `everListed` is the permanent ledger that stops a token which was listed once
 * — including one somebody PAID for and later deleted — being handed back as a
 * free auto listing. A truncated write, a full disk or a half-restored volume
 * makes the file unreadable, `loadState()` reads it as a first run, and the very
 * next save writes the empty ledger over the top and mirrors it to Mongo. The
 * loss is silent and permanent, and its symptom is free listings appearing for
 * tokens the site has already sold.
 *
 * `existed` is what separates the two: a fresh install has no file at all.
 */
function readJSONSync(name, def) {
  const file = path.join(DATA_DIR, name);
  let text;
  try {
    text = fss.readFileSync(file, "utf8");
  } catch (e) {
    // ENOENT is the ordinary "nothing saved yet". Anything else — EACCES, EIO,
    // EISDIR — is a real read failure about a file that may well be there.
    const missing = e && e.code === "ENOENT";
    return { value: def, ok: missing, existed: !missing, why: missing ? null : `${name}: ${e.message}` };
  }
  try {
    return { value: JSON.parse(text), ok: true, existed: true, why: null };
  } catch (e) {
    return { value: def, ok: false, existed: true, why: `${name}: unreadable JSON (${e.message})` };
  }
}

let seq = 0;
async function writeFileAtomic(file, data) {
  ensureDir();
  const tmp = `${file}.${process.pid}.${seq++}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

// WHAT WE HAVE PROVED IS IN MONGO: store name → hash of the exact bytes whose
// kvSet resolved. A fire-and-forget mirror write that rejected — Mongo down, a
// network blip, a failover — leaves no trace anywhere, and boot-time seeding
// only ever looked at stores Mongo had NEVER seen. So a store already in the
// mirror that failed one write stayed stale in it for good, and the operator
// had no way to know: `templates.json` is written the moment an admin saves a
// template with their premium emoji in it, which is exactly the edit nobody
// wants to redo. This map is what lets the sweep below notice and retry.
const mirroredHash = new Map();
const hashOf = (text) => crypto.createHash("sha1").update(text).digest("hex");
// The same serialization writeFileAtomic uses, so a hash taken from the data
// and a hash taken from the file on disk are comparable.
const serialize = (data) => JSON.stringify(data, null, 2);

async function saveJSON(name, data) {
  const file = path.join(DATA_DIR, name);
  await writeFileAtomic(file, data); // local file stays the primary (sync source of truth)
  // Durable mirror — best-effort, never blocks or fails the local write. A slow
  // or down Mongo must never delay a payment/broadcast; the sweep and boot-time
  // convergence catch anything a fire-and-forget write missed.
  if (mongo.enabled()) queueMirror(name, data, hashOf(serialize(data)));
}

// One in-flight mirror write per store, in the order the saves happened.
//
// Without this, two saves close together race: orders.json is rewritten WHOLE on
// every status change during a payment poll, so kvSet(A) and kvSet(B) are
// routinely in flight at once — and nothing makes them land in that order. B
// then A leaves Mongo holding the OLDER order state, and mirroredHash agreeing
// with neither. The sweep repairs it within MIRROR_SWEEP_MS, but "the payment
// record in the backup is a few minutes behind, sometimes" is not a property
// worth having when serialising the writes costs one Map entry.
const mirrorChain = new Map(); // store name → the promise for its last queued write
function queueMirror(name, data, hash) {
  const prev = mirrorChain.get(name) || Promise.resolve();
  const next = prev.then(
    () => mongo.kvSet(name, data).then(
      () => { mirroredHash.set(name, hash); },
      (e) => {
        // Drop any hash we were holding: this store is now UNPROVEN, and the
        // sweep must treat it as needing a retry rather than as up to date.
        mirroredHash.delete(name);
        log.warn(`[persist] mongo mirror failed for ${name} — will retry on the next sweep: ${e && e.message}`);
      },
    ),
  );
  // The chain must never reject, or the next write links onto a rejected
  // promise and is dropped silently — the exact failure this is meant to stop.
  mirrorChain.set(name, next);
  next.then(() => { if (mirrorChain.get(name) === next) mirrorChain.delete(name); });
  return next;
}

/** Resolves once every queued mirror write has settled. Tests and the backup
 *  checker use it; nothing on the hot path waits for the mirror. */
const mirrorIdle = () => Promise.all([...mirrorChain.values()]);

/**
 * Re-mirror every local store whose bytes we have not PROVED are in Mongo.
 *
 * Cheap on purpose: it hashes local files and compares against what a kvSet
 * actually confirmed, so a steady state costs one stat + read per store and no
 * Mongo traffic at all. Mongo is only written to when something is genuinely
 * out of sync.
 */
async function sweepMirror() {
  if (!mongo.enabled()) return { swept: 0, mirrored: 0 };
  let mirrored = 0;
  const names = localKvFiles();
  for (const name of names) {
    let text;
    try {
      text = fss.readFileSync(path.join(DATA_DIR, name), "utf8");
    } catch {
      continue; // vanished between readdir and read — nothing to mirror
    }
    const h = hashOf(text);
    if (mirroredHash.get(name) === h) continue;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // A half-written or corrupt local file must NEVER overwrite a good mirror
      // copy. The mirror is the thing that survives this file being wrong.
      log.warn(`[persist] ${name} is not valid JSON — leaving the Mongo copy alone`);
      continue;
    }
    try {
      await mongo.kvSet(name, data);
      mirroredHash.set(name, h);
      mirrored++;
    } catch (e) {
      log.warn(`[persist] sweep could not mirror ${name}: ${e && e.message}`);
    }
  }
  if (mirrored) log.info(`[persist] mongo sweep: re-mirrored ${mirrored} of ${names.length} store(s)`);
  return { swept: names.length, mirrored };
}

/** Run sweepMirror on a timer. Returns a stop function. No-op without Mongo. */
function startMirrorSweep(everyMs = MIRROR_SWEEP_MS) {
  if (!mongo.configured() || everyMs <= 0) return () => {};
  const iv = setInterval(() => {
    sweepMirror().catch((e) => log.warn(`[persist] sweep error: ${e && e.message}`));
  }, everyMs);
  if (iv.unref) iv.unref();
  return () => clearInterval(iv);
}

// Only top-level *.json files are KV stores (job dirs like broadcasts/ manage
// their own files). Skip tmp files and subdirectories.
function localKvFiles() {
  try {
    return fss
      .readdirSync(DATA_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".json"))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// Boot-time convergence between local disk and the Mongo mirror. Called ONCE by
// each bot process before it reads any state. Restores stores missing on disk
// (fresh container) from Mongo, and seeds Mongo from any local store not yet
// mirrored (first run against an existing VPS). Never clobbers a present local
// file (single-VPS deploy → disk is authoritative for live edits).
async function hydrate() {
  if (!mongo.configured()) return { mode: "file" };
  const db = await mongo.connect();
  if (!db || !mongo.enabled()) return { mode: "file" };
  ensureDir();
  let restored = 0;
  let seeded = 0;
  try {
    const docs = await mongo.kvAll();
    const inMongo = new Set();
    for (const d of docs) {
      inMongo.add(d._id);
      const file = path.join(DATA_DIR, d._id);
      if (!fss.existsSync(file) && d.data !== undefined) {
        try {
          await writeFileAtomic(file, d.data);
          mirroredHash.set(d._id, hashOf(serialize(d.data)));
          restored++;
        } catch (e) {
          log.warn(`[persist] restore of ${d._id} failed: ${e && e.message}`);
        }
      }
    }
    // Seed anything Mongo has never seen, AND re-seed anything whose mirrored
    // copy no longer matches the disk. Only the first half used to happen, so a
    // store that was mirrored once and then diverged — because a fire-and-forget
    // kvSet rejected while Mongo was unreachable — stayed stale in the mirror
    // permanently, and a restore would hand back an old templates.json with the
    // admin's newer premium emoji missing from it.
    const remote = new Map(docs.map((d) => [d._id, d.data]));
    for (const name of localKvFiles()) {
      const local = loadJSONSync(name, null);
      if (local === null) continue; // unreadable/corrupt — never overwrite a good mirror copy
      const localText = serialize(local);
      if (inMongo.has(name) && serialize(remote.get(name)) === localText) {
        mirroredHash.set(name, hashOf(localText)); // already proven — skip it in the sweep
        continue;
      }
      try {
        await mongo.kvSet(name, local);
        mirroredHash.set(name, hashOf(localText));
        seeded++;
      } catch (e) {
        log.warn(`[persist] seed of ${name} failed: ${e && e.message}`);
      }
    }
    log.info(`[persist] mongo hydrate: ${docs.length} store(s) in db, restored ${restored}, seeded ${seeded}`);
    return { mode: "mongo", docs: docs.length, restored, seeded };
  } catch (e) {
    log.warn(`[persist] hydrate error — continuing on local files: ${e && e.message}`);
    return { mode: "file", error: e && e.message };
  }
}

/** A persisted string Set — for once-only dedup (pump latch, trend post locks). */
class DedupSet {
  constructor(name) {
    this.name = name;
    this.set = new Set(loadJSONSync(name, []));
  }
  has(k) {
    return this.set.has(k);
  }
  async add(k) {
    if (this.set.has(k)) return false;
    this.set.add(k);
    await saveJSON(this.name, [...this.set]).catch(() => {});
    return true;
  }
  /** Add several keys in ONE write. add() rewrites the whole file per key, which
   *  is fine one at a time but not when a caller marks a run of keys at once —
   *  the pump ladder consumes every milestone below the one it just announced. */
  async addAll(keys) {
    let changed = false;
    for (const k of keys) if (!this.set.has(k)) { this.set.add(k); changed = true; }
    if (changed) await saveJSON(this.name, [...this.set]).catch(() => {});
    return changed;
  }
  async delete(k) {
    if (!this.set.delete(k)) return;
    await saveJSON(this.name, [...this.set]).catch(() => {});
  }
}

module.exports = {
  sweepMirror,
  mirrorIdle,
  startMirrorSweep, loadJSONSync, readJSONSync, saveJSON, ensureDir, hydrate, DedupSet, DATA_DIR };
