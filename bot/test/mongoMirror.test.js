// hydrate()'s disk↔Mongo convergence + saveJSON's mirror, exercised against an
// in-memory fake of the mongo module (no live server needed). Pins the whole
// point of the durability feature: a fresh container restores its state from
// the mirror, and an existing VPS seeds the mirror from local files.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
delete process.env.MONGO_URI;
const DATA = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-mirror-"));
process.env.BOT_DATA_DIR = DATA;

const test = require("node:test");
const assert = require("node:assert");
const mongo = require("../src/db/mongo");
const persist = require("../src/helpers/persist");
const jobMirror = require("../src/db/jobMirror");

// Swap the mongo module's methods for an in-memory "collection". persist.js /
// jobMirror.js call these via the module object, so the overrides take effect.
function fakeMongo(initial = {}, jobs = []) {
  const kv = new Map(Object.entries(initial));
  const jobDocs = jobs.slice();
  mongo.configured = () => true;
  mongo.enabled = () => true;
  mongo.connect = async () => ({}); // truthy "db"
  mongo.kvAll = async () => [...kv.entries()].map(([_id, data]) => ({ _id, data }));
  mongo.kvGet = async (n) => kv.get(n);
  mongo.kvSet = async (n, d) => {
    kv.set(n, d);
  };
  mongo.jobsAll = async (dir) => jobDocs.filter((j) => j.dir === dir);
  mongo.jobSet = async (dir, id, data) => {
    const i = jobDocs.findIndex((j) => j.dir === dir && j.id === id);
    if (i >= 0) jobDocs[i] = { dir, id, data };
    else jobDocs.push({ dir, id, data });
  };
  return { kv, jobDocs };
}

test("hydrate restores a store missing on disk from the Mongo mirror", async () => {
  fakeMongo({ "templates.json": { welcome: "hi" } });
  assert.ok(!fss.existsSync(path.join(DATA, "templates.json")), "precondition: no local file");
  const r = await persist.hydrate();
  assert.strictEqual(r.mode, "mongo");
  assert.ok(r.restored >= 1, `expected a restore, got ${JSON.stringify(r)}`);
  assert.deepStrictEqual(persist.loadJSONSync("templates.json", null), { welcome: "hi" });
});

test("hydrate does NOT clobber a present local file", async () => {
  await persist.saveJSON("templates.json", { welcome: "LOCAL-NEWER" });
  fakeMongo({ "templates.json": { welcome: "old-mirror" } });
  await persist.hydrate();
  assert.deepStrictEqual(persist.loadJSONSync("templates.json", null), { welcome: "LOCAL-NEWER" });
});

test("hydrate seeds Mongo from a local store not yet mirrored", async () => {
  await persist.saveJSON("groups.json", { g1: { on: true } });
  const { kv } = fakeMongo({}); // mirror starts empty
  const r = await persist.hydrate();
  assert.strictEqual(r.mode, "mongo");
  assert.ok(r.seeded >= 1, `expected a seed, got ${JSON.stringify(r)}`);
  assert.deepStrictEqual(kv.get("groups.json"), { g1: { on: true } });
});

test("saveJSON mirrors to Mongo when connected", async () => {
  const { kv } = fakeMongo({});
  await persist.saveJSON("orders.json", { o1: { status: "paid" } });
  await new Promise((r) => setImmediate(r)); // let the fire-and-forget mirror settle
  assert.deepStrictEqual(kv.get("orders.json"), { o1: { status: "paid" } });
});

test("jobMirror.mirrorJob upserts a job into the jobs mirror", async () => {
  const { jobDocs } = fakeMongo({}, []);
  jobMirror.mirrorJob("broadcasts", { id: "bc1", status: "in_progress", cursor: 40 });
  await new Promise((r) => setImmediate(r));
  const doc = jobDocs.find((j) => j.dir === "broadcasts" && j.id === "bc1");
  assert.ok(doc, "job not mirrored");
  assert.strictEqual(doc.data.cursor, 40);
});

test("jobMirror.restoreAll restores job files missing on disk", async () => {
  fakeMongo({}, [
    { dir: "broadcasts", id: "bc9", data: { id: "bc9", status: "in_progress", cursor: 7 } },
    { dir: "mass_dm", id: "md9", data: { id: "md9", status: "pending_review" } },
  ]);
  await jobMirror.restoreAll();
  const bc = JSON.parse(fss.readFileSync(path.join(DATA, "broadcasts", "bc9.json"), "utf8"));
  const md = JSON.parse(fss.readFileSync(path.join(DATA, "mass_dm", "md9.json"), "utf8"));
  assert.strictEqual(bc.cursor, 7);
  assert.strictEqual(md.status, "pending_review");
});

// ── Staying converged, not just converging once ──────────────────────────────
//
// The mirror write on every save is fire-and-forget so it can never delay a
// payment or a message send — which also means a failed one leaves no trace.
// These pin what notices.

test("a store already in Mongo but STALE is re-seeded at boot", async () => {
  // Only stores Mongo had NEVER seen used to be seeded. So one rejected kvSet
  // (Mongo down for a moment) left that store stale in the mirror for good, and
  // a restore handed back an old templates.json with the admin's newer premium
  // emoji missing from it. Nothing anywhere would have said so.
  const { kv } = fakeMongo({ "templates.json": { group_buy_alert: "OLD COPY" } });
  fss.writeFileSync(
    path.join(DATA, "templates.json"),
    JSON.stringify({ group_buy_alert: "NEW COPY with [💎](emoji/5427168083074628963)" }, null, 2),
  );
  await persist.hydrate();
  assert.match(kv.get("templates.json").group_buy_alert, /NEW COPY/, "the mirror caught up with the disk");
});

test("hydrate still refuses to clobber a present local file with the mirror's copy", async () => {
  // The re-seed above must not have turned into a two-way sync. Disk wins.
  fakeMongo({ "x.json": { from: "mongo" } });
  fss.writeFileSync(path.join(DATA, "x.json"), JSON.stringify({ from: "disk" }, null, 2));
  await persist.hydrate();
  assert.deepStrictEqual(JSON.parse(fss.readFileSync(path.join(DATA, "x.json"), "utf8")), { from: "disk" });
});

test("a save whose mirror write FAILED is retried by the sweep", async () => {
  // The whole point: the failure is silent and asynchronous, so the only thing
  // that can fix it is something that re-checks later.
  const { kv } = fakeMongo({});
  let allow = false;
  mongo.kvSet = async (n, d) => {
    if (!allow) throw new Error("connection reset");
    kv.set(n, d);
  };
  await persist.saveJSON("templates.json", { emoji: "[💎](emoji/5427168083074628963)" });
  await new Promise((r) => setImmediate(r)); // let the fire-and-forget rejection land
  assert.strictEqual(kv.has("templates.json"), false, "the mirror write really did fail");
  allow = true;
  const res = await persist.sweepMirror();
  assert.strictEqual(res.mirrored, 1);
  assert.deepStrictEqual(kv.get("templates.json"), { emoji: "[💎](emoji/5427168083074628963)" });
});

test("the sweep is free when nothing changed", async () => {
  // It runs every few minutes forever, so a steady state must cost no Mongo
  // writes at all — otherwise it is a background job rewriting every store.
  const { kv } = fakeMongo({});
  let writes = 0;
  const realSet = mongo.kvSet;
  mongo.kvSet = async (n, d) => {
    writes++;
    return realSet(n, d);
  };
  await persist.saveJSON("quiet.json", { a: 1 });
  await new Promise((r) => setImmediate(r));
  const before = writes;
  await persist.sweepMirror();
  await persist.sweepMirror();
  assert.strictEqual(writes, before, "two sweeps, zero writes");
  assert.deepStrictEqual(kv.get("quiet.json"), { a: 1 });
});

test("a corrupt local file never overwrites a good copy in the mirror", async () => {
  // The mirror is precisely what survives the local file being wrong. A sweep
  // that pushed truncated JSON up would destroy the thing it exists to protect.
  const { kv } = fakeMongo({ "torn.json": { good: true } });
  fss.writeFileSync(path.join(DATA, "torn.json"), '{"good": tr');
  await persist.sweepMirror();
  assert.deepStrictEqual(kv.get("torn.json"), { good: true }, "mirror untouched");
  await persist.hydrate();
  assert.deepStrictEqual(kv.get("torn.json"), { good: true }, "and hydrate leaves it alone too");
});

test("rapid saves reach Mongo in the order they happened", async () => {
  // orders.json is rewritten WHOLE on every status change during a payment
  // poll, so two kvSets are routinely in flight at once. Unchained, B then A
  // leaves the mirror holding the OLDER payment state — a backup that is
  // sometimes a few minutes behind, on the one store where that matters most.
  const { kv } = fakeMongo({});
  const landed = [];
  mongo.kvSet = async (n, d) => {
    // Make the FIRST write slow, so an unordered implementation lands it last.
    await new Promise((r) => setTimeout(r, d.step === 1 ? 40 : 0));
    landed.push(d.step);
    kv.set(n, d);
  };
  await persist.saveJSON("orders.json", { step: 1 });
  await persist.saveJSON("orders.json", { step: 2 });
  await persist.mirrorIdle();
  assert.deepStrictEqual(landed, [1, 2], "the slow first write still lands first");
  assert.deepStrictEqual(kv.get("orders.json"), { step: 2 }, "and the mirror holds the NEWEST state");
});

test("a failed mirror write does not swallow the next one", async () => {
  // The chain must never be left rejected: the following save links onto it,
  // and a rejected link would drop that write silently — the exact failure the
  // chain exists to prevent.
  const { kv } = fakeMongo({});
  let first = true;
  mongo.kvSet = async (n, d) => {
    if (first) {
      first = false;
      throw new Error("connection reset");
    }
    kv.set(n, d);
  };
  await persist.saveJSON("orders.json", { step: 1 });
  await persist.saveJSON("orders.json", { step: 2 });
  await persist.mirrorIdle();
  assert.deepStrictEqual(kv.get("orders.json"), { step: 2 }, "the second write still landed");
});
