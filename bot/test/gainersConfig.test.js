// Config + queue for the Top-Gainers banner. Both are on disk and both are read
// by a DIFFERENT process than the one that writes them, so the rules under test
// are: a hand-edited/garbage value degrades to something sane on READ, an admin's
// typo is rejected with a reason on WRITE, and a queued job can never be
// published twice or published stale.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Own the data dir BEFORE requiring anything that reads DATA_DIR at load time.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-gainers-"));
process.env.BOT_DATA_DIR = DIR;

const cfg = require("../src/services/gainersConfig");
const store = require("../src/gainerspost/store");
const gb = require("../src/gainersBanner");

const write = (obj) => fs.writeFileSync(path.join(DIR, cfg.FILE), JSON.stringify(obj));

test("defaults: the daily post is OFF until someone turns it on", () => {
  fs.rmSync(path.join(DIR, cfg.FILE), { force: true });
  const c = cfg.get();
  assert.strictEqual(c.daily, false, "a deploy must never start posting to a public channel by itself");
  assert.strictEqual(c.dailyTime, "09:00");
  assert.strictEqual(c.template, "random");
  assert.deepStrictEqual(c.pool, []);
  assert.ok(cfg.targetChannel(c).startsWith("@"), "falls back to the trending channel");
});

test("a hand-edited config is repaired on read, not obeyed", () => {
  write({
    daily: "yes", // not a boolean → ignored
    dailyTime: "99:99", // impossible → default
    tz: "Mars/Olympus_Mons", // unknown zone → default
    template: "does-not-exist", // stale id → default
    pool: ["list5", "gone", "list5"], // filtered + deduped
    minGainPct: 99999, // clamped
    minLiqUsd: -5, // clamped
  });
  const c = cfg.get();
  assert.strictEqual(c.daily, false);
  assert.strictEqual(c.dailyTime, "09:00");
  assert.strictEqual(c.tz, "Asia/Jakarta");
  assert.strictEqual(c.template, "random");
  assert.deepStrictEqual(c.pool, ["list5"]);
  assert.strictEqual(c.minGainPct, 1000);
  assert.strictEqual(c.minLiqUsd, 0);
});

test("set() persists, pads the hour (9:05 → 09:05), and validates the template", async () => {
  await cfg.set({ dailyTime: "9:05", template: "podium", channel: " @dexvratrending ", minGainPct: 7.6 });
  const c = cfg.get();
  assert.strictEqual(c.dailyTime, "09:05");
  assert.strictEqual(c.template, "podium");
  assert.strictEqual(c.channel, "@dexvratrending");
  assert.strictEqual(c.minGainPct, 7.6);
  assert.strictEqual(cfg.targetChannel(c), "@dexvratrending");
});

test("set() explains a typo instead of silently storing the default", async () => {
  await assert.rejects(() => cfg.set({ dailyTime: "9am" }), /HH:MM/);
  // Ambiguous rather than wrong: a scheduler must not decide whether the operator
  // meant 09:05 or 09:50.
  await assert.rejects(() => cfg.set({ dailyTime: "9:5" }), /HH:MM/);
  await assert.rejects(() => cfg.set({ tz: "Nope/Nope" }), /timezone/);
  await assert.rejects(() => cfg.set({ template: "top99" }), /unknown template/);
  assert.strictEqual(cfg.get().dailyTime, "09:05", "a rejected write changed nothing");
});

test('channel "" means the default, and it round-trips', async () => {
  await cfg.set({ channel: "" });
  assert.strictEqual(cfg.get().channel, "");
  assert.ok(cfg.targetChannel().startsWith("@"));
});

test("togglePool adds then removes, and only known templates", async () => {
  await cfg.set({ pool: [] });
  assert.deepStrictEqual(await cfg.togglePool("list5"), ["list5"]);
  const two = await cfg.togglePool("grid10");
  assert.deepStrictEqual([...two].sort(), ["grid10", "list5"]);
  assert.deepStrictEqual(await cfg.togglePool("list5"), ["grid10"]);
  assert.deepStrictEqual(await cfg.togglePool("nonsense"), ["grid10"], "a bogus id is dropped, not stored");
});

test("nowHHMM / dayKey are wall-clock in the configured timezone", async () => {
  const at = new Date("2026-07-30T23:30:00Z"); // 06:30 next day in Jakarta (+7)
  const c = { ...cfg.DEFAULTS, tz: "Asia/Jakarta" };
  assert.strictEqual(cfg.nowHHMM(c, at), "06:30");
  assert.strictEqual(cfg.dayKey(c, at), "2026-07-31");
  const utc = { ...cfg.DEFAULTS, tz: "UTC" };
  assert.strictEqual(cfg.nowHHMM(utc, at), "23:30");
  assert.strictEqual(cfg.dayKey(utc, at), "2026-07-30");
  // A bogus zone must not throw inside the scheduler loop.
  assert.match(cfg.nowHHMM({ ...cfg.DEFAULTS, tz: "Mars/Olympus" }, at), /^\d{2}:\d{2}$/);
});

test("reset() puts every value back to the shipped default", async () => {
  await cfg.set({ daily: true, minGainPct: 40, template: "podium" });
  assert.strictEqual(cfg.get().daily, true);
  const c = await cfg.reset();
  assert.strictEqual(c.daily, false);
  assert.strictEqual(c.minGainPct, cfg.DEFAULTS.minGainPct);
  assert.strictEqual(c.template, cfg.DEFAULTS.template);
});

// ── the publish queue ───────────────────────────────────────────────────────
const img = () => Buffer.from("89504e470d0a1a0a" + "00".repeat(64), "hex");
const caption = { text: "hello", entities: [] };

test("request() writes the image AND the job; pending() sees it once", async () => {
  const job = await store.request({ image: img(), caption, channel: "@x", template: "list5", symbols: ["A", "B"] });
  assert.strictEqual(job.status, "pending");
  assert.ok(fs.existsSync(job.imagePath), "the PNG is a file, not base64 inside the JSON");
  const p = store.pending();
  assert.ok(p.some((j) => j.id === job.id));
  assert.deepStrictEqual(store.get(job.id).symbols, ["A", "B"]);
});

test("claim() is the double-post guard: only the first caller gets the job", async () => {
  const job = await store.request({ image: img(), caption, channel: "@x", template: "list5" });
  assert.ok(await store.claim(job.id));
  assert.strictEqual(await store.claim(job.id), null, "a second runner (or a restart) must not re-publish");
  assert.ok(!store.pending().some((j) => j.id === job.id));
});

test("finish() records the outcome and drops the image", async () => {
  const job = await store.request({ image: img(), caption, channel: "@x", template: "list5" });
  await store.claim(job.id);
  await store.finish(job.id, { ok: true, result: { url: "https://t.me/x/1" } });
  const done = store.get(job.id);
  assert.strictEqual(done.status, "done");
  assert.strictEqual(done.result.url, "https://t.me/x/1");
  assert.ok(!fs.existsSync(job.imagePath), "the payload bytes are not kept around");
});

test("a job the main bot never collected EXPIRES instead of posting later", async () => {
  const job = await store.request({ image: img(), caption, channel: "@x", template: "list5" });
  // Backdate it past the staleness window.
  const file = path.join(store.GP_DIR, `${job.id}.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...raw, at: Date.now() - store.STALE_MS - 1000 }));
  assert.ok(!store.pending().some((j) => j.id === job.id), "a stale job is not offered to the runner");
  assert.strictEqual(await store.expireStale(), 1);
  assert.strictEqual(store.get(job.id).status, "expired");
  assert.ok(!fs.existsSync(job.imagePath));
});

test("prune() clears finished jobs but never touches live ones", async () => {
  const live = await store.request({ image: img(), caption, channel: "@x", template: "list5" });
  const old = await store.request({ image: img(), caption, channel: "@x", template: "list5" });
  await store.claim(old.id);
  await store.finish(old.id, { ok: true });
  const file = path.join(store.GP_DIR, `${old.id}.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...raw, doneAt: Date.now() - 48 * 3600 * 1000 }));
  assert.strictEqual(await store.prune(), 1);
  assert.strictEqual(store.get(old.id), null);
  assert.ok(store.get(live.id), "a pending job is never pruned");
});

test("the gainers queue has its own directory, apart from force-post's mailbox", () => {
  const fp = require("../src/forcepost/store");
  assert.notStrictEqual(store.GP_DIR, fp.FP_DIR, "one runner claiming another's jobs is how a post gets published twice");
  assert.ok(gb.TEMPLATE_IDS.length, "sanity: the renderer is loadable alongside the stores");
});

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
