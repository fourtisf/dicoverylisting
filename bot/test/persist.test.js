// The Mongo durable mirror must be FAIL-OPEN: with no MONGO_URI the bot behaves
// exactly as the old local-file-only store. These pin that contract (no live
// Mongo needed) — a regression here would risk the whole persistence layer.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
delete process.env.MONGO_URI; // force file-only mode
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-persist-"));

const test = require("node:test");
const assert = require("node:assert");
const persist = require("../src/helpers/persist");
const mongo = require("../src/db/mongo");

test("without MONGO_URI, mongo is disabled and its helpers are safe no-ops", async () => {
  assert.strictEqual(mongo.configured(), false);
  assert.strictEqual(mongo.enabled(), false);
  assert.strictEqual(await mongo.connect(), null);
  assert.deepStrictEqual(await mongo.kvAll(), []);
  assert.strictEqual(await mongo.kvGet("anything"), undefined);
  await mongo.kvSet("x", { a: 1 }); // must not throw
});

test("hydrate() is a no-op in file mode and never throws", async () => {
  const r = await persist.hydrate();
  assert.strictEqual(r.mode, "file");
});

test("saveJSON/loadJSONSync round-trip on local disk (unchanged behaviour)", async () => {
  await persist.saveJSON("round.json", { hello: "world", n: 3 });
  assert.deepStrictEqual(persist.loadJSONSync("round.json", null), { hello: "world", n: 3 });
  // the physical file is still written (primary source of truth)
  const onDisk = JSON.parse(fss.readFileSync(path.join(process.env.BOT_DATA_DIR, "round.json"), "utf8"));
  assert.deepStrictEqual(onDisk, { hello: "world", n: 3 });
});

test("loadJSONSync returns the default for a missing store", () => {
  assert.deepStrictEqual(persist.loadJSONSync("nope.json", ["def"]), ["def"]);
});

test("DedupSet persists across instances via the local file", async () => {
  const a = new persist.DedupSet("dedup.json");
  assert.strictEqual(await a.add("k1"), true);
  assert.strictEqual(await a.add("k1"), false); // already present
  const b = new persist.DedupSet("dedup.json"); // reloads from disk
  assert.strictEqual(b.has("k1"), true);
  await b.delete("k1");
  assert.strictEqual(new persist.DedupSet("dedup.json").has("k1"), false);
});
