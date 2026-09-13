// Force post: publish any post type on demand, into its REAL channel, through
// the production code path. It's a public action, so what matters is that it
// hits the right channels, survives a token with no market data, and reports a
// refusal instead of pretending it posted.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-fp-"));

const test = require("node:test");
const assert = require("node:assert");

const md = require("../src/marketdata");
md.fetchMarket = async () => ({ priceUsd: 0.0000123, mcap: 812_000_000, change24h: 42.5 });
const api = require("../src/api/dexvra");
const post = require("../src/channels/post");
const { CHANNELS } = require("../src/config/constants");

const LISTING = {
  status: "approved",
  name: "Bonk",
  sym: "BONK",
  chain: "solana",
  address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  tier: "GOLD",
  trendingRank: 1,
  website: "https://bonkcoin.com",
  twitter: "https://x.com/bonk_inu",
  telegram: "https://t.me/bonkinu",
};
api.getListings = async () => [LISTING];

const forcePost = require("../src/admin/forcePost");

// Capture every delivery instead of talking to Telegram.
let sent = [];
const realSendMedia = post.sendMedia;
test.beforeEach(() => {
  sent = [];
  post.sendMedia = async (channel, media, payload) => {
    sent.push({ channel, media, payload });
    return { message_id: 100 + sent.length };
  };
});
test.after(() => {
  post.sendMedia = realSendMedia;
});

test("every kind is routed to its real channel", async () => {
  const expected = {
    listing: [CHANNELS.listing],
    listing_trending: [CHANNELS.listing, CHANNELS.announce, CHANNELS.trending],
    trending: [CHANNELS.trending],
    rankup: [CHANNELS.trending],
    pump: [CHANNELS.listing],
    banner: [CHANNELS.announce],
  };
  assert.deepStrictEqual(forcePost.kindIds().sort(), Object.keys(expected).sort(), "no kind is missing a route");
  for (const [kind, chans] of Object.entries(expected)) {
    sent = [];
    const res = await forcePost.forcePost(kind);
    assert.deepStrictEqual(sent.map((s) => s.channel), chans, `${kind} channels`);
    assert.deepStrictEqual(res.map((r) => r.channel), chans, `${kind} reports what it did`);
    assert.ok(res.every((r) => r.ok && r.url.startsWith("https://t.me/")), `${kind} returns openable links`);
    // The confirmation screen must promise exactly what send() does.
    assert.deepStrictEqual(forcePost.channelsOf(kind), chans, `${kind}: confirm text matches reality`);
  }
});

test("the post is the real one: caption rendered from the live template", async () => {
  await forcePost.forcePost("rankup");
  const { payload } = sent[0];
  assert.ok(payload.text.includes("$BONK"), payload.text);
  assert.ok(payload.text.includes("#1"), "rank present");
  assert.ok(payload.text.includes(LISTING.address), "CA present");
  assert.ok(Array.isArray(payload.entities) && payload.entities.length, "entities, not raw markup");
  assert.ok(!/\{\w+\}/.test(payload.text), `no unsubstituted placeholders: ${payload.text}`);
});

test("a channel that refuses the post is reported, not swallowed", async () => {
  post.sendMedia = async () => null; // Telegram refused / bot not admin
  const res = await forcePost.forcePost("trending");
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].ok, false, "reported as failed");
  assert.strictEqual(res[0].url, null, "no fake link");
});

test("works with no listings and no market data (fresh install)", async () => {
  const realList = api.getListings;
  const realMarket = md.fetchMarket;
  api.getListings = async () => [];
  md.fetchMarket = async () => null;
  try {
    const res = await forcePost.forcePost("listing");
    assert.ok(res[0].ok, "still publishes using the built-in example token");
    assert.ok(sent[0].payload.text.length > 0);
    assert.ok(!/\{\w+\}/.test(sent[0].payload.text), "no placeholders leak when data is missing");
  } finally {
    api.getListings = realList;
    md.fetchMarket = realMarket;
  }
});

test("an unknown kind throws instead of posting something random", async () => {
  await assert.rejects(() => forcePost.forcePost("nope"), /unknown post kind/);
  assert.strictEqual(sent.length, 0);
});

// ── The cross-process hand-off ──────────────────────────────────────────────
// The admin bot CANNOT publish: it isn't a channel admin and mustn't open a
// second GramJS client on the same session. It queues; the main bot publishes.
const store = require("../src/forcepost/store");
const runner = require("../src/services/forcePostRunner");

test("queued request → main bot publishes it → result comes back", async () => {
  const job = await store.request("trending", { by: "@alfa" });
  assert.strictEqual(job.status, "pending");
  assert.deepStrictEqual(store.pending().map((j) => j.id), [job.id]);

  await runner._tick();

  const done = store.get(job.id);
  assert.strictEqual(done.status, "done");
  assert.strictEqual(done.results[0].channel, CHANNELS.trending);
  assert.ok(done.results[0].url.startsWith("https://t.me/"));
  assert.deepStrictEqual(sent.map((s) => s.channel), [CHANNELS.trending], "published exactly once");
  assert.deepStrictEqual(store.pending(), [], "and is off the queue");
});

test("a second tick never re-publishes the same request", async () => {
  const job = await store.request("trending", { by: "@alfa" });
  await runner._tick();
  await runner._tick();
  assert.strictEqual(sent.length, 1, "claimed before publishing, so no double post");
  assert.strictEqual(store.get(job.id).status, "done");
});

test("a failure is reported back, not silently dropped", async () => {
  post.sendMedia = async () => {
    throw new Error("CHAT_WRITE_FORBIDDEN");
  };
  const job = await store.request("trending", { by: "@alfa" });
  await runner._tick();
  const done = store.get(job.id);
  assert.strictEqual(done.status, "failed");
  assert.match(done.error, /CHAT_WRITE_FORBIDDEN/);
});

test("a request the main bot never picked up expires instead of firing late", async () => {
  const job = await store.request("trending", { by: "@alfa" });
  // Backdate it past the staleness window (main bot was down for an hour).
  const fss2 = require("node:fs");
  const p = require("node:path").join(store.FP_DIR, `${job.id}.json`);
  const raw = JSON.parse(fss2.readFileSync(p, "utf8"));
  fss2.writeFileSync(p, JSON.stringify({ ...raw, at: Date.now() - store.STALE_MS - 1000 }));

  assert.deepStrictEqual(store.pending(), [], "not offered to the runner");
  await runner._tick();
  assert.strictEqual(sent.length, 0, "an unexpected public post an hour later is worse than none");
  assert.strictEqual(store.get(job.id).status, "expired");
});

// ── The board refresh rides this table, and must not look like a POST ────────
test("board_refresh is a hidden JOB, not an entry in the Force-post menu", () => {
  const fp = require("../src/admin/forcePost");
  assert.ok(!fp.kindIds().includes("board_refresh"),
    "it would appear under a confirm screen reading 'Real, public post — subscribers will see it', which is false: it edits the board that is already pinned");
  assert.ok(fp.KINDS.board_refresh, "…but it is still a kind the runner can execute by id");
  assert.strictEqual(fp.KINDS.board_refresh.noRow, true, "a refresh needs no sample token — that would be a listings API call per tap");
});

test("the board refresh runs the REAL poster, in the process that owns the board", async () => {
  const fp = require("../src/admin/forcePost");
  const post = require("../src/channels/post");
  const poster = require("../src/services/trendingPoster");

  const realRun = poster.runOnce;
  const realTg = post.telegram;
  try {
    // No Telegram attached (the admin bot's own process) must be an explicit
    // error, never a silent "ok" that leaves the operator believing it ran.
    post.telegram = () => null;
    await assert.rejects(() => fp.forcePost("board_refresh", { by: "test" }), /dexvra-bot/);

    post.telegram = () => ({ marker: "the main bot's Telegram" });
    let got = null;
    poster.runOnce = async (tg) => { got = tg; return { how: "edited", mode: "premium", premium: 9, messageId: 42 }; };
    const [res] = await fp.forcePost("board_refresh", { by: "test" });
    assert.strictEqual(got && got.marker, "the main bot's Telegram", "the poster must be handed the attached Telegram");
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.board, { how: "edited", mode: "premium", premium: 9, messageId: 42 },
      "the outcome is carried through the job file verbatim — it is the whole answer the operator gets");
  } finally {
    poster.runOnce = realRun;
    post.telegram = realTg;
  }
});
