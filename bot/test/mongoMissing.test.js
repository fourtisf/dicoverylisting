// A deploy that pulls the code but skips `npm install` leaves the `mongodb`
// package absent. Because db/mongo.js sits at the base of the persist chain, an
// unguarded require('mongodb') there would crash the ENTIRE bot at boot (live
// incident 2026-07-20). This pins the fail-open guard: a missing driver behaves
// exactly like an unset MONGO_URI — the bot runs on local files.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");

// Simulate `mongodb` not installed — intercept its require BEFORE loading mongo.js.
const Module = require("node:module");
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "mongodb") {
    const e = new Error("Cannot find module 'mongodb'");
    e.code = "MODULE_NOT_FOUND";
    throw e;
  }
  return origLoad.call(this, request, ...rest);
};

// MONGO_URI is SET — proving the guard is about the missing DRIVER, not config.
process.env.MONGO_URI = "mongodb+srv://x:y@z.mongodb.net/dexvra";
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-nomongo-"));

const test = require("node:test");
const assert = require("node:assert");
const mongo = require("../src/db/mongo");
const persist = require("../src/helpers/persist");

test("missing mongodb driver → mongo is disabled even with MONGO_URI set", async () => {
  assert.strictEqual(mongo.configured(), false);
  assert.strictEqual(mongo.enabled(), false);
  assert.strictEqual(await mongo.connect(), null);
});

test("bot still persists to local files when the driver is missing", async () => {
  const r = await persist.hydrate();
  assert.strictEqual(r.mode, "file");
  await persist.saveJSON("probe.json", { ok: 1 });
  assert.deepStrictEqual(persist.loadJSONSync("probe.json", null), { ok: 1 });
});

test.after(() => {
  Module._load = origLoad;
});
