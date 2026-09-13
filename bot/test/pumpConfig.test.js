// pumpConfig — admin-configurable pump alert window. Isolated data dir so the
// test never touches real runtime state.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-pcfg-"));

const test = require("node:test");
const assert = require("node:assert");
const pc = require("../src/services/pumpConfig");

test("defaults to the 100%–2000% window", () => {
  const w = pc.get();
  assert.strictEqual(w.minPct, 100);
  assert.strictEqual(w.maxPct, 2000);
});

test("set persists min/max independently and round-trips", async () => {
  await pc.set({ minPct: 250 });
  assert.strictEqual(pc.get().minPct, 250);
  assert.strictEqual(pc.get().maxPct, 2000, "max untouched when only min set");
  await pc.set({ maxPct: 1500 });
  assert.deepStrictEqual(pc.get(), { minPct: 250, maxPct: 1500 });
});

test("keeps the window valid — max always above min", async () => {
  await pc.reset();
  // raise min above max → max is pushed up to stay above min
  const a = await pc.set({ minPct: 1600 });
  assert.ok(a.maxPct > a.minPct, `max ${a.maxPct} must stay above min ${a.minPct}`);
  // lower max below min → min is pulled down
  await pc.reset();
  const b = await pc.set({ maxPct: 50 });
  assert.ok(b.minPct < b.maxPct, `min ${b.minPct} must stay below max ${b.maxPct}`);
});

test("clamps fat-finger values to sane rails", async () => {
  const r = await pc.set({ minPct: -999, maxPct: 9_999_999 });
  assert.strictEqual(r.minPct, pc.HARD_MIN);
  assert.strictEqual(r.maxPct, pc.HARD_MAX);
});

test("reset returns to defaults", async () => {
  await pc.set({ minPct: 300, maxPct: 900 });
  const r = await pc.reset();
  assert.deepStrictEqual(r, { minPct: pc.DEFAULT_MIN, maxPct: pc.DEFAULT_MAX });
  assert.deepStrictEqual(pc.get(), { minPct: 100, maxPct: 2000 });
});
