#!/usr/bin/env node
// Is the bot's state — above all the PREMIUM EMOJI an admin pasted into
// templates — actually in MongoDB right now?
//
// WHY THIS SCRIPT EXISTS
// data/ is gitignored and lives only on the VPS. Premium emoji reach the bot in
// two ways and both land there: an admin pastes them into a template in
// @dexvraadminbot (stored as {text, entities} in templates.json), and every paid
// listing mints a per-token animated pack whose custom_emoji_id is kept in
// tokenemoji.json. Losing that directory means redoing work nobody remembers
// the details of — which pack, which emoji, in which position.
//
// The Mongo mirror covers it, but the mirror writes are fire-and-forget: they
// are meant to never delay a payment or a message send, which also means a
// failed one is invisible. "Probably backed up" is not an answer you want to
// discover was wrong on the day the VPS dies. This script asks.
//
//     cd bot && npm run backup:check
//     cd bot && npm run backup:check -- --fix    # re-mirror anything stale
//
// NOT `npm run mongo:check` — that one is a different question. It tests whether
// a MONGO_URI is valid before you commit to it (reachable, right credentials,
// read/write allowed). This one assumes the connection works and asks whether
// what is on disk has actually made it across.
//
// Read-only unless --fix is passed. Never deletes anything, on either side.
// One owner for "which .env does this process read" — repo root, then bot/, then
// the cwd, with override. dotenv on its own resolves against the CWD alone, so
// four scripts here quietly disagreed about which file counted.
require("../src/config/loadEnv").loadEnv();

const path = require("node:path");
const fss = require("node:fs");
const { DATA_DIR, MONGO_URI, MONGO_DB } = require("../src/config/constants");
const mongo = require("../src/db/mongo");
const persist = require("../src/helpers/persist");

const FIX = process.argv.includes("--fix");
const ok = (s) => `✅ ${s}`;
const bad = (s) => `❌ ${s}`;
const warn = (s) => `⚠️  ${s}`;

const serialize = (d) => JSON.stringify(d, null, 2);
const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** Every custom_emoji_id reachable from a stored value, however it is nested.
 *  Templates hold them in entity arrays; token packs hold them as bare ids. */
function emojiIdsIn(value, out = new Set()) {
  if (!value) return out;
  if (typeof value === "string") {
    // The markup form a default template carries: [💎](emoji/5427168083074628963)
    for (const m of value.matchAll(/\(emoji\/(\d+)\)/g)) out.add(m[1]);
    // A bare id stored as a string (tokenemoji.json keeps them this way).
    if (/^\d{10,}$/.test(value)) out.add(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) emojiIdsIn(v, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "custom_emoji_id" && v != null) out.add(String(v));
      else emojiIdsIn(v, out);
    }
  }
  return out;
}

// The stores whose loss actually costs somebody an afternoon. Everything else is
// checked too, just not called out by name.
const HEADLINE = {
  "templates.json": "admin-edited copy + the premium emoji pasted into it",
  "tokenemoji.json": "per-token animated emoji packs (custom_emoji_id per listing)",
};

(async function main() {
  console.log("Dexvra state backup check");
  console.log("─".repeat(72));
  console.log(`data dir : ${DATA_DIR}`);
  console.log(`mongo uri: ${MONGO_URI ? MONGO_URI.replace(/\/\/[^@]*@/, "//***@") : "— NOT SET"}`);
  console.log(`mongo db : ${MONGO_DB || "(from the URI)"}`);
  console.log("─".repeat(72));

  if (!MONGO_URI) {
    console.log(bad("MONGO_URI is not set — NOTHING is backed up."));
    console.log("   Every template, every premium emoji and every listing pack lives only in");
    console.log(`   ${DATA_DIR}, which is gitignored and dies with this VPS.`);
    console.log("\n   Validate a URI first with:  npm run mongo:check \"mongodb+srv://…\"");
    console.log("   Then set MONGO_URI in bot/.env and:");
    console.log("     cd /opt/dexvra/bot && pm2 restart ecosystem.config.js --update-env");
    console.log("   Boot seeds the mirror from what is already on disk — nothing is lost by");
    console.log("   turning it on late.");
    process.exit(1);
  }
  if (!mongo.configured()) {
    console.log(bad("MONGO_URI is set but the 'mongodb' driver is missing — the bot is on local files only."));
    console.log("   cd /opt/dexvra/bot && npm install");
    process.exit(1);
  }

  const db = await mongo.connect();
  if (!db || !mongo.enabled()) {
    console.log(bad("Could not reach MongoDB. The bot is running on local files, unmirrored."));
    console.log("   `npm run mongo:check` says exactly why — usually this VPS's IP is not in");
    console.log("   Atlas → Network Access, or the password in the URI is wrong.");
    process.exit(1);
  }
  console.log(ok("connected"));

  const docs = await mongo.kvAll();
  const remote = new Map(docs.map((d) => [d._id, d.data]));
  const local = fss.existsSync(DATA_DIR)
    ? fss.readdirSync(DATA_DIR, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".json")).map((d) => d.name)
    : [];

  const stale = [];
  const missing = [];
  const rows = [];
  for (const name of new Set([...local, ...remote.keys()].sort())) {
    const file = path.join(DATA_DIR, name);
    const onDisk = fss.existsSync(file);
    const inMongo = remote.has(name);
    let state;
    if (!onDisk && inMongo) state = "mongo only (would be restored on boot)";
    else if (onDisk && !inMongo) {
      state = "NOT MIRRORED";
      missing.push(name);
    } else {
      let localData = null;
      try {
        localData = JSON.parse(fss.readFileSync(file, "utf8"));
      } catch {
        state = "local file unreadable";
      }
      if (state === undefined) {
        if (serialize(localData) === serialize(remote.get(name))) state = "in sync";
        else {
          // NOT stale yet — possibly just in flight. saveJSON writes the file
          // first and mirrors asynchronously, so a store being written while
          // this runs is momentarily ahead of Mongo through no fault of
          // anything. orders.json is rewritten whole on every payment poll,
          // which makes it by far the likeliest to be caught mid-write and
          // reported as a failure it never had. Look twice before accusing.
          state = "recheck";
          stale.push(name);
        }
      }
    }
    const size = onDisk ? bytes(fss.statSync(file).size) : "—";
    rows.push({ name, size, state });
  }

  // Second look at anything that did not match, after giving an in-flight
  // mirror write time to land.
  if (stale.length) {
    await new Promise((r) => setTimeout(r, 2000));
    const settled = [];
    for (const name of stale) {
      let localData = null;
      try {
        localData = JSON.parse(fss.readFileSync(path.join(DATA_DIR, name), "utf8"));
      } catch {
        settled.push(name);
        continue;
      }
      const fresh = await mongo.kvGet(name);
      const row = rows.find((r) => r.name === name);
      if (serialize(localData) === serialize(fresh && fresh.data !== undefined ? fresh.data : fresh)) {
        row.state = "in sync (mirror landed while checking)";
      } else {
        row.state = "STALE IN MONGO";
        settled.push(name);
      }
    }
    stale.length = 0;
    stale.push(...settled);
  }

  console.log("\nStores");
  const w = Math.max(...rows.map((r) => r.name.length), 8);
  for (const r of rows) {
    const mark = r.state.startsWith("in sync") || r.state.startsWith("mongo only") ? "✅" : "❌";
    const note = HEADLINE[r.name] ? `   ← ${HEADLINE[r.name]}` : "";
    console.log(`  ${mark} ${r.name.padEnd(w)}  ${r.size.padStart(8)}  ${r.state}${note}`);
  }

  // ── The premium emoji themselves ──────────────────────────────────────────
  console.log("\nPremium emoji");
  let anyEmoji = false;
  for (const name of ["templates.json", "tokenemoji.json"]) {
    const localIds = fss.existsSync(path.join(DATA_DIR, name))
      ? emojiIdsIn(JSON.parse(fss.readFileSync(path.join(DATA_DIR, name), "utf8") || "null"))
      : new Set();
    const remoteIds = remote.has(name) ? emojiIdsIn(remote.get(name)) : new Set();
    if (!localIds.size && !remoteIds.size) {
      console.log(`  ·  ${name}: no custom emoji stored yet`);
      continue;
    }
    anyEmoji = true;
    const onlyLocal = [...localIds].filter((id) => !remoteIds.has(id));
    if (onlyLocal.length) {
      console.log(bad(` ${name}: ${localIds.size} emoji on disk, ${onlyLocal.length} of them NOT in Mongo`));
      console.log(`     at risk: ${onlyLocal.slice(0, 6).join(", ")}${onlyLocal.length > 6 ? " …" : ""}`);
    } else {
      console.log(ok(` ${name}: ${localIds.size} custom emoji, all mirrored`));
    }
  }
  if (!anyEmoji) {
    console.log("     Nothing to lose yet. The packs themselves live on Telegram's side and");
    console.log("     survive this VPS regardless — it is the IDs that map them to tokens and");
    console.log("     templates that only exist here.");
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(72));
  if (!stale.length && !missing.length) {
    console.log(ok("Everything on disk is in the mirror. A VPS replace restores it at boot."));
    await mongo.close().catch(() => {});
    process.exit(0);
  }
  if (missing.length) console.log(bad(`${missing.length} store(s) never mirrored: ${missing.join(", ")}`));
  if (stale.length) {
    console.log(bad(`${stale.length} store(s) stale in Mongo: ${stale.join(", ")}`));
    // WHICH keys differ, never their values: orders.json is payment records and
    // this output gets pasted into chats. Key names alone are enough to tell a
    // lagging mirror from a genuinely divergent one.
    for (const name of stale) {
      try {
        const localData = JSON.parse(fss.readFileSync(path.join(DATA_DIR, name), "utf8"));
        const doc = await mongo.kvGet(name);
        const remoteData = doc && doc.data !== undefined ? doc.data : doc;
        if (localData && remoteData && typeof localData === "object" && typeof remoteData === "object") {
          const lk = Object.keys(localData);
          const rk = Object.keys(remoteData);
          const onlyLocal = lk.filter((k) => !(k in remoteData));
          const changed = lk.filter((k) => k in remoteData && serialize(remoteData[k]) !== serialize(localData[k]));
          console.log(`     ${name}: ${lk.length} key(s) on disk, ${rk.length} in mongo` +
            `${onlyLocal.length ? ` · ${onlyLocal.length} only on disk` : ""}` +
            `${changed.length ? ` · ${changed.length} differing` : ""}`);
        }
      } catch { /* the summary is a nicety — never fail the check over it */ }
    }
  }
  if (FIX) {
    console.log("\nRe-mirroring…");
    const res = await persist.sweepMirror();
    console.log(ok(`swept ${res.swept} store(s), re-mirrored ${res.mirrored}`));
    console.log("   Run without --fix to confirm.");
  } else {
    console.log(warn("The running bot re-mirrors these on its own within MIRROR_SWEEP_MS (5 min default)."));
    console.log("   To do it now: npm run backup:check -- --fix");
  }
  await mongo.close().catch(() => {});
  process.exit(FIX ? 0 : 1);
})().catch((e) => {
  console.error("failed:", (e && (e.stack || e.message)) || e);
  process.exit(1);
});
