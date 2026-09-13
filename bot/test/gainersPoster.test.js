// The main-bot side: the once-a-day guarantee, and publishing what the admin bot
// queued. Both are stubbed at the seam (an injected post fn / a patched
// channels/post) so nothing here touches Telegram.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-poster-"));
process.env.BOT_DATA_DIR = DIR;

const cfg = require("../src/services/gainersConfig");
const store = require("../src/gainerspost/store");
const post = require("../src/channels/post");
const poster = require("../src/services/gainersPoster");

const AT = new Date("2026-07-30T02:00:00Z"); // 09:00 in Asia/Jakarta
const state = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, poster.STATE_FILE), "utf8"));
  } catch {
    return {};
  }
};
const clearState = () => fs.rmSync(path.join(DIR, poster.STATE_FILE), { force: true });

test("the daily post does nothing while it is switched off", async () => {
  clearState();
  await cfg.set({ daily: false, dailyTime: "09:00", tz: "Asia/Jakarta" });
  let calls = 0;
  assert.strictEqual(await poster._dailyTick(AT, { post: async () => (calls++, { ok: true }) }), false);
  assert.strictEqual(calls, 0);
});

test("it only fires in its configured minute", async () => {
  clearState();
  await cfg.set({ daily: true, dailyTime: "09:00", tz: "Asia/Jakarta" });
  let calls = 0;
  const stub = async () => (calls++, { ok: true, url: "https://t.me/c/1", template: "list5", symbols: ["A"] });
  assert.strictEqual(await poster._dailyTick(new Date("2026-07-30T01:59:00Z"), { post: stub }), false, "08:59 is not 09:00");
  assert.strictEqual(calls, 0);
  assert.strictEqual(await poster._dailyTick(AT, { post: stub }), true);
  assert.strictEqual(calls, 1);
});

test("a whole minute of 30s beats produces exactly ONE post", async () => {
  clearState();
  await cfg.set({ daily: true, dailyTime: "09:00", tz: "Asia/Jakarta" });
  let calls = 0;
  const stub = async () => (calls++, { ok: true, url: "https://t.me/c/2", template: "list5", symbols: ["A"] });
  for (const s of [0, 30, 45, 59]) {
    await poster._dailyTick(new Date(`2026-07-30T02:00:${String(s).padStart(2, "0")}Z`), { post: stub });
  }
  assert.strictEqual(calls, 1, "the day is claimed before posting, so later beats are no-ops");
  assert.strictEqual(state().lastDay, "2026-07-30");
  assert.strictEqual(state().lastUrl, "https://t.me/c/2");
});

test("a failed post RELEASES the day so the next beat can retry", async () => {
  clearState();
  await cfg.set({ daily: true, dailyTime: "09:00", tz: "Asia/Jakarta" });
  let calls = 0;
  const flaky = async () => {
    calls++;
    return calls === 1 ? { ok: false, reason: "no live gainers" } : { ok: true, url: "https://t.me/c/3", template: "list5", symbols: ["A"] };
  };
  assert.strictEqual(await poster._dailyTick(AT, { post: flaky }), false);
  assert.strictEqual(state().lastError, "no live gainers");
  assert.ok(!state().lastDay, "a day with nothing published must not count as done");
  assert.strictEqual(await poster._dailyTick(AT, { post: flaky }), true, "the retry lands");
  assert.strictEqual(state().lastDay, "2026-07-30");
  assert.strictEqual(state().lastError, null);
});

test("the next calendar day posts again", async () => {
  clearState();
  await cfg.set({ daily: true, dailyTime: "09:00", tz: "Asia/Jakarta" });
  let calls = 0;
  const stub = async () => (calls++, { ok: true, url: "https://t.me/c/4", template: "list5", symbols: ["A"] });
  await poster._dailyTick(AT, { post: stub });
  await poster._dailyTick(new Date("2026-07-31T02:00:00Z"), { post: stub });
  assert.strictEqual(calls, 2);
  assert.strictEqual(state().lastDay, "2026-07-31");
});

test("the timezone decides the minute, not the server clock", async () => {
  clearState();
  await cfg.set({ daily: true, dailyTime: "09:00", tz: "UTC" });
  let calls = 0;
  const stub = async () => (calls++, { ok: true, url: "u", template: "list5", symbols: ["A"] });
  await poster._dailyTick(AT, { post: stub }); // 02:00 UTC — not 09:00 UTC
  assert.strictEqual(calls, 0);
  await poster._dailyTick(new Date("2026-07-30T09:00:30Z"), { post: stub });
  assert.strictEqual(calls, 1);
});

// ── publishing the admin bot's queued banners ───────────────────────────────
function patchSendPhoto(impl) {
  const real = post.sendPhoto;
  post.sendPhoto = impl;
  return () => {
    post.sendPhoto = real;
  };
}
const img = () => Buffer.from("89504e470d0a1a0a" + "00".repeat(64), "hex");

test("a queued banner is published from its file and marked done", async () => {
  const job = await store.request({
    image: img(),
    caption: { text: "hi", entities: [] },
    channel: "@dexvratrending",
    template: "list5",
    symbols: ["A", "B"],
  });
  const seen = [];
  const restore = patchSendPhoto(async (channel, photo, caption, opts) => {
    seen.push({ channel, photo, caption, opts });
    return { message_id: 4242 };
  });
  try {
    await poster._drainQueue();
  } finally {
    restore();
  }
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].channel, "@dexvratrending");
  assert.ok(seen[0].photo.source, "the image is uploaded from the queued file");
  const done = store.get(job.id);
  assert.strictEqual(done.status, "done");
  assert.strictEqual(done.result.messageId, 4242);
  assert.match(done.result.url, /t\.me\/dexvratrending\/4242/);
});

test("a channel that refuses the post is recorded as failed, not retried forever", async () => {
  const job = await store.request({ image: img(), caption: { text: "hi", entities: [] }, channel: "@nope", template: "list5" });
  const restore = patchSendPhoto(async () => null); // channels/post returns null on refusal
  try {
    await poster._drainQueue();
  } finally {
    restore();
  }
  assert.strictEqual(store.get(job.id).status, "failed");
  const restore2 = patchSendPhoto(async () => {
    throw new Error("should not be called again");
  });
  try {
    await poster._drainQueue();
  } finally {
    restore2();
  }
});

test("a throwing transport is caught and the job is closed with the reason", async () => {
  const job = await store.request({ image: img(), caption: { text: "hi", entities: [] }, channel: "@x", template: "list5" });
  const restore = patchSendPhoto(async () => {
    throw new Error("network is down");
  });
  try {
    await poster._drainQueue();
  } finally {
    restore();
  }
  const j = store.get(job.id);
  assert.strictEqual(j.status, "failed");
  assert.match(j.error, /network is down/);
});

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
