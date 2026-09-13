// "jika sudah trending maka wajib mempostingnya di channel trending."
//
// A token on the board with no post in the channel is a product nobody can see.
// The rails were doing the opposite of their name: a promotion that arrived
// while the daily cap was spent, or inside the spacing gap, was DROPPED — and
// the token then sat on the board for its whole 3–18h slot with no post.
//
// Rails now space announcements out; they no longer decide which ones happen.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-annq-"));

const test = require("node:test");
const assert = require("node:assert");

const api = require("../src/api/dexvra");
const autoTrend = require("../src/services/autoTrend");

const MIN = 60 * 1000;
const NOW = Date.parse("2026-07-27T12:00:00Z");

const listing = (chain, address, extra = {}) => ({
  status: "approved",
  chain,
  address,
  sym: address.toUpperCase(),
  trendingRank: 1,
  trendExp: NOW + 6 * 3600 * 1000,
  ...extra,
});

test("the rails can reach the volume the board actually produces", () => {
  // 5 chains × 5 slots = 25 live, each lasting 3–18h, so steady state is ~57
  // promotions a day. A 24/day ceiling made "announce everything" unreachable
  // no matter how the panel was set, and a 60-min gap could clear only 24.
  const d = autoTrend.DEFAULTS;
  assert.ok(d.announcePerDay >= 60, `daily cap ${d.announcePerDay} is below the churn`);
  assert.ok(d.announceGapMin <= 20, `a ${d.announceGapMin}min gap cannot clear the day`);
  const perDay = (24 * 60) / d.announceGapMin;
  assert.ok(perDay >= 57, `the gap alone allows only ${perDay}/day`);
});

test("'not yet' and 'never' are different answers", () => {
  // The whole fix in one predicate: only a TIME refusal may leave a promotion
  // in the queue, and only a real refusal may throw it away.
  assert.strictEqual(autoTrend.isRetryable("daily cap reached (100)"), true);
  assert.strictEqual(autoTrend.isRetryable("too soon — 12min to go"), true);
  assert.strictEqual(autoTrend.isRetryable("announcements are off"), false);
  assert.strictEqual(autoTrend.isRetryable("$FOO was announced 2d ago (cooldown 7d)"), false);
  assert.strictEqual(autoTrend.isRetryable(null), false, "success is not a retry");
});

test("a promotion that cannot post YET stays queued", async () => {
  // The bug, exactly: drainPending popped the head, saved, and only then tried
  // to post — so "too soon, 12 min to go" ate the promotion.
  await autoTrend.resetState();
  await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, announce: true, announceGapMin: 60, announcePerDay: 100 });
  api.getListings = async () => [listing("bsc", "cake")];
  await autoTrend.queueAnnounce({ chain: "bsc", address: "cake" }, 6);
  assert.strictEqual(autoTrend.pendingCount(), 1);

  // A post landed a minute ago, so the gap has not elapsed.
  await autoTrend._test.setLastAt(NOW - MIN);
  const posted = await autoTrend.drainPending({ now: NOW });
  assert.strictEqual(posted, 0, "nothing posted — correct");
  assert.strictEqual(autoTrend.pendingCount(), 1, "…and nothing lost, which is the point");
});

test("the same promotion posts once the gap has passed", async () => {
  await autoTrend.resetState();
  await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, announce: true, announceGapMin: 15, announcePerDay: 100 });
  const posts = [];
  autoTrend._test.setAnnouncer(async (row) => (posts.push(row.address), { message_id: posts.length }));
  api.getListings = async () => [listing("bsc", "cake")];
  await autoTrend.queueAnnounce({ chain: "bsc", address: "cake" }, 6);
  await autoTrend._test.setLastAt(NOW - MIN);

  assert.strictEqual(await autoTrend.drainPending({ now: NOW }), 0, "too soon");
  assert.strictEqual(await autoTrend.drainPending({ now: NOW + 20 * MIN }), 1, "gap elapsed");
  assert.deepStrictEqual(posts, ["cake"]);
  assert.strictEqual(autoTrend.pendingCount(), 0, "and only now does it leave the queue");
  autoTrend._test.setAnnouncer(null);
});

test("a refusal that will never clear does NOT sit in the queue forever", async () => {
  // A token already announced this week is a real no. Keeping it would block
  // everything behind it — a queue that never advances is worse than a drop.
  await autoTrend.resetState();
  await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, announce: true, announceCooldownDays: 7 });
  api.getListings = async () => [listing("bsc", "cake")];
  await autoTrend._test.setAnnounced("bsc", "cake", NOW - 2 * 86400000);
  await autoTrend.queueAnnounce({ chain: "bsc", address: "cake" }, 6);
  assert.strictEqual(await autoTrend.drainPending({ now: NOW }), 0);
  assert.strictEqual(autoTrend.pendingCount(), 0, "dropped, not stuck");
});

test("a slot that ended before the queue reached it is not announced", async () => {
  // The queue can be hours deep and a slot lasts 3–18h. Posting a card for a
  // token no longer on the board is worse than not posting it.
  await autoTrend.resetState();
  await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, announce: true, announceGapMin: 5 });
  const posts = [];
  autoTrend._test.setAnnouncer(async (row) => (posts.push(row.address), { message_id: 1 }));
  api.getListings = async () => [
    listing("bsc", "gone", { trendExp: NOW - MIN }), // expired
    listing("bsc", "cleared", { trendingRank: null }), // swept
  ];
  await autoTrend.queueAnnounce({ chain: "bsc", address: "gone" }, 6);
  await autoTrend.queueAnnounce({ chain: "bsc", address: "cleared" }, 6);
  assert.strictEqual(await autoTrend.drainPending({ now: NOW }), 0);
  assert.strictEqual(await autoTrend.drainPending({ now: NOW + 10 * MIN }), 0);
  assert.deepStrictEqual(posts, [], "neither was on the board any more");
  assert.strictEqual(autoTrend.pendingCount(), 0);
  autoTrend._test.setAnnouncer(null);
});

test("a cold start queues every promotion — none is skipped", async () => {
  // Every slot filled at once used to produce ONE post and the rest as silent
  // promotions.
  await autoTrend.resetState();
  await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, announce: true, perChain: 5, announceGapMin: 15, announcePerDay: 100 });
  const rows = [];
  for (const chain of autoTrend.get().chains) {
    for (let i = 0; i < 5; i++) rows.push({ status: "approved", chain, address: `${chain}${i}`, sym: `${chain}${i}`, trendingRank: null });
  }
  api.getListings = async () => rows;
  api.bookTrending = async () => ({});
  const posted = [];
  autoTrend._test.setAnnouncer(async (row) => (posted.push(row.address), { message_id: posted.length }));

  // DERIVED from the live chain list, never a literal: the count moved from 25
  // to 30 the day Tron joined the trending set, and a hardcoded 25 turns a
  // configuration change into a red test that says nothing about the queue.
  const expected = autoTrend.get().chains.length * 5;
  const promoted = await autoTrend.runOnce({ rng: () => 0.5 });
  assert.strictEqual(promoted, expected);
  // One posts immediately; the rest are waiting, not gone.
  assert.strictEqual(posted.length, 1, `posted now: ${posted.join(", ")}`);
  assert.strictEqual(autoTrend.pendingCount(), expected - 1, "every remaining promotion is queued");
  autoTrend._test.setAnnouncer(null);
});

test("the queue holds a whole cold start", async () => {
  // It was capped at 20, below what a full cold start produces (chains × 5), so
  // the tail was discarded silently by the cap that was meant to bound it.
  await autoTrend.resetState();
  for (let i = 0; i < 40; i++) await autoTrend.queueAnnounce({ chain: "bsc", address: `t${i}` }, 3);
  assert.strictEqual(autoTrend.pendingCount(), 40);
});

test("the backlog is visible to the operator", async () => {
  // A queue nobody can see is a queue nobody notices has stopped moving.
  const admin = require("../src/admin/adminBot");
  await autoTrend.set({ announce: true });
  admin._test.setAtCounts({});
  admin._test.setAtPending(7);
  assert.match(admin._test.atText(), /7<\/b> waiting to post/, admin._test.atText());
  admin._test.setAtPending(0);
  assert.ok(!/waiting to post/.test(admin._test.atText()), "an empty queue is not news");
});
