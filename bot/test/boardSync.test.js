// THE CHANNEL BOARD MIRRORS THE WEBSITE — with booked slots pinned.
//
// "di website sudah ada trending, nah itu aja yang diambil, harus sinkron" —
// a project opens dexvra.io and @dexvratrending side by side and sees two
// different sets of tokens, because the two ranked from different places. And
// a chain with fewer booked slots than the operator's minimum published a short
// board for six rounds running.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-sync-"));

const test = require("node:test");
const assert = require("node:assert");
const api = require("../src/api/dexvra");
const market = require("../src/marketdata");
const poster = require("../src/services/trendingPoster");
const autoTrend = require("../src/services/autoTrend");
const log = require("../src/helpers/logger");

const listing = (over) => ({
  status: "approved", chain: "solana", sym: "X", trendingRank: null, ...over,
});
const siteRow = (symbol, change, over) => ({
  chain: "solana", address: `site${symbol}`, symbol, name: symbol,
  change24h: change, mcap: 5e6, booked: false, ...over,
});

async function render({ listings, chains, live = true, perChainMin = 5, perChainMax = null, autoChains = ["solana"] }) {
  const realGet = api.getListings;
  const realRank = api.boardRank;
  const realFetch = market.fetchMarket;
  api.getListings = async () => listings;
  api.boardRank = async () => ({ frame: "24h", live, chains });
  market.fetchMarket = async (_c, a) => ({ change24h: 1, mcap: 1e6, priceUsd: 1, poolAddress: `p${a}` });
  // perChainMax defaults to perChainMin so the ROW COUNTS in these fixtures are
  // deterministic. The rolled range has its own test below; a case that is not
  // about the range must pin it, or it asserts against a coin flip.
  await autoTrend.set({ perChainMin, perChainMax: perChainMax == null ? perChainMin : perChainMax, chains: autoChains });
  try {
    poster._resetState();
    return await poster.buildText();
  } finally {
    api.getListings = realGet;
    api.boardRank = realRank;
    market.fetchMarket = realFetch;
  }
}

test("a chain short of the minimum is topped up from the website's order", async () => {
  // Two booked slots against a minimum of five: the board used to publish two
  // rows and the operator counted them and asked, six times.
  const now = Date.now();
  const text = await render({
    listings: [
      listing({ address: "paid1", sym: "PAID1", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "DIAMOND" }),
      listing({ address: "paid2", sym: "PAID2", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "GOLD" }),
    ],
    chains: { solana: [siteRow("AAA", 90), siteRow("BBB", 50), siteRow("CCC", 10)] },
  });
  for (const s of ["PAID1", "PAID2", "AAA", "BBB", "CCC"]) {
    assert.ok(text.includes(`$${s}`), `${s} missing from the board:\n${text}`);
  }
});

test("⚠️ a PAID row is never displaced by the website's ranking", async () => {
  // The whole reason this is a top-up and not a mirror. Somebody bought that
  // row; a board that dropped it because the token was down today is a refund
  // conversation, and every other ranking surface in this repo demotes rather
  // than hides for exactly that reason.
  const now = Date.now();
  const text = await render({
    listings: [listing({ address: "paid1", sym: "SLUMP", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "DIAMOND" })],
    chains: { solana: Array.from({ length: 9 }, (_, i) => siteRow(`HOT${i}`, 100 - i)) },
  });
  assert.ok(text.includes("$SLUMP"), `the paid row was displaced:\n${text}`);
  // …and it is ABOVE the site's rows, which is what the tier buys.
  assert.ok(text.indexOf("$SLUMP") < text.indexOf("$HOT0"), `a paid row sorted below a free one:\n${text}`);
});

test("the top-up stops at the minimum — it does not flood the board", async () => {
  const now = Date.now();
  const text = await render({
    listings: [listing({ address: "p", sym: "PAID", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "DIAMOND" })],
    chains: { solana: Array.from({ length: 20 }, (_, i) => siteRow(`T${i}`, 50 - i)) },
    perChainMin: 3,
  });
  const rows = text.split("\n").filter((l) => /\| \[\$/.test(l));
  assert.strictEqual(rows.length, 3, `expected 3 rows, got ${rows.length}:\n${text}`);
});

test("⚠️ DEMO data never reaches the channel", async () => {
  // `live:false` is the site saying these are captured-at-listing numbers, not
  // readings. Publishing a board built from them is the fabricated figure this
  // board already refuses to render, arrived at one layer earlier.
  const now = Date.now();
  const text = await render({
    listings: [listing({ address: "p", sym: "PAID", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "DIAMOND" })],
    chains: { solana: [siteRow("DEMO", 99)] },
    live: false,
  });
  assert.ok(text.includes("$PAID"), "the booked slot must still publish");
  assert.ok(!text.includes("$DEMO"), `demo data reached the channel:\n${text}`);
});

test("⚠️ a row with NO 24h reading is never chosen by us", async () => {
  // A slot this board books itself must carry a percentage — the promoter and
  // the market filler both honour that. A paid row keeps its space and renders
  // "—"; a row we chose has no such claim on it.
  const now = Date.now();
  const text = await render({
    listings: [listing({ address: "p", sym: "PAID", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "DIAMOND" })],
    chains: { solana: [siteRow("BLANK", null), siteRow("REAL", 12)] },
  });
  assert.ok(text.includes("$REAL"), `a readable row was skipped:\n${text}`);
  assert.ok(!text.includes("$BLANK"), `we put an unreadable row on the board:\n${text}`);
});

test("the site being unreachable still publishes the booked slots", async () => {
  // A board that vanished is worse than one that is short: those rows are real
  // and somebody paid for them.
  const now = Date.now();
  const realGet = api.getListings;
  const realRank = api.boardRank;
  const realFetch = market.fetchMarket;
  api.getListings = async () => [listing({ address: "p", sym: "PAID", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "DIAMOND" })];
  api.boardRank = async () => { throw new Error("fetch failed"); };
  market.fetchMarket = async () => ({ change24h: 5, mcap: 2e6, priceUsd: 1 });
  try {
    poster._resetState();
    const text = await poster.buildText();
    assert.ok(text.includes("$PAID"), `the board vanished when the site was down:\n${text}`);
  } finally {
    api.getListings = realGet;
    api.boardRank = realRank;
    market.fetchMarket = realFetch;
  }
});

test("⚠️ the bot does not rank for itself — it reads the site's order", async () => {
  // `byChange` on the site is the one owner of "which change may rank this".
  // A copy inside the bot is the fourth private answer to that question in this
  // repo, and the first three put `$MRNA +465%` on five cents of volume at the
  // top of a public board.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "services", "trendingPoster.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /api\.boardRank\(/, "the poster must read the site's ranking");
  assert.ok(
    !/changeRank|tradedEnough/.test(code),
    "the poster grew its own copy of the site's ranking rule",
  );
  assert.ok(/changeRank|tradedEnough/.test(fss.readFileSync(path.join(__dirname, "..", "..", "src", "lib", "home.ts"), "utf8")),
    "…and the site's owner must still exist, or this scan proves nothing");
});

test("⚠️ every publish SAYS what the top-up did, or why it did not happen", async () => {
  // The first cut warned on failure and said nothing on success, so "the site
  // was unreachable", "the site is on demo data", "there was nothing readable
  // to add" and "it worked" were one observation from the channel: a board
  // that is still short. That is this session's own recurring defect, in the
  // code written to end it.
  const realInfo = log.info;
  const lines = [];
  log.info = (m) => lines.push(String(m));
  const now = Date.now();
  const paid = listing({ address: "p", sym: "PAID", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "DIAMOND" });
  try {
    lines.length = 0;
    await render({ listings: [paid], chains: { solana: [siteRow("AAA", 20), siteRow("BBB", 10)] } });
    const ok = lines.find((l) => /\[trending\] board:/.test(l));
    assert.ok(ok, `no publish line at all: ${JSON.stringify(lines)}`);
    assert.match(ok, /solana 1\+2/, `it did not say what it added: ${ok}`);
    assert.ok(!/NOT mirrored/.test(ok), `a working mirror reported as broken: ${ok}`);

    // …and the reason is NAMED when the site is on demo data.
    lines.length = 0;
    await render({ listings: [paid], chains: { solana: [siteRow("AAA", 20)] }, live: false });
    const demo = lines.find((l) => /\[trending\] board:/.test(l));
    assert.match(demo, /NOT mirrored/, demo);
    assert.match(demo, /demo data/, `the reason must be actionable, not "unknown": ${demo}`);
  } finally {
    log.info = realInfo;
  }
});

test("⚠️ the top-up never invents a chain section the operator did not configure", async () => {
  // The first cut filled every chain in CHAIN_ORDER, so the board grew POLYGON,
  // OPTIMISM, BERACHAIN and HYPEREVM sections overnight — four networks nobody
  // had put on it, each topped up to five rows. `cfg.chains` has always ended
  // its own comment with "Everything else is PAID-ONLY".
  const now = Date.now();
  const text = await render({
    listings: [listing({ address: "p", sym: "PAID", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "DIAMOND" })],
    chains: {
      solana: [siteRow("MINE", 20)],
      polygon: [{ chain: "polygon", address: "0xpoly", symbol: "LGNS", name: "L", change24h: 9, mcap: 5e6, booked: false }],
    },
    autoChains: ["solana"],
  });
  assert.ok(text.includes("$MINE"), `the configured chain was not topped up:\n${text}`);
  assert.ok(!text.includes("$LGNS"), `a chain the operator never configured appeared on the board:\n${text}`);
  assert.ok(!/POLYGON/i.test(text), `an unconfigured chain got its own section:\n${text}`);
});

test("…but a chain the operator did not configure still publishes a PAID slot", async () => {
  // The paid-only rule cuts both ways: this list governs what the bot adds by
  // itself, never what a purchase may buy.
  const now = Date.now();
  const text = await render({
    listings: [{ status: "approved", chain: "polygon", address: "0xbought", sym: "BOUGHT", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "DIAMOND" }],
    chains: { polygon: [{ chain: "polygon", address: "0xfree", symbol: "FREE", name: "F", change24h: 9, mcap: 5e6, booked: false }] },
    autoChains: ["solana"],
  });
  assert.ok(text.includes("$BOUGHT"), `a paid slot was dropped from an unconfigured chain:\n${text}`);
  assert.ok(!text.includes("$FREE"), `…but the bot must not top that chain up:\n${text}`);
});

test("⚠️ a switched-off chain with a FREE booked slot gets no section at all", async () => {
  // THE reported case, and the one the other two tests missed: POLYGON,
  // OPTIMISM, BERACHAIN and HYPEREVM had booked rows the bot had put there
  // itself, so gating only the TOP-UP left every section standing. Caught by
  // mutation testing — deleting the section gate failed nothing until this
  // existed, which is the vacuity this file keeps having to name.
  const now = Date.now();
  const text = await render({
    listings: [
      listing({ address: "s1", sym: "MINE", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "DIAMOND" }),
      // Booked, but nobody BOUGHT it — no real tier. This is what the bot's own
      // promoter and market filler produce.
      { status: "approved", chain: "polygon", address: "0xauto", sym: "AUTO", trendingRank: 1, trendStart: now, trendExp: now + 3600_000 },
    ],
    chains: { solana: [siteRow("AAA", 20)] },
    autoChains: ["solana"],
  });
  assert.ok(text.includes("$MINE"), `the configured chain lost its rows:\n${text}`);
  assert.ok(!text.includes("$AUTO"), `a switched-off chain kept its free booked row:\n${text}`);
  assert.ok(!/POLYGON/i.test(text), `a switched-off chain kept its section:\n${text}`);
});

// ── how many rows a chain shows ─────────────────────────────────────────────

test("⚠️ the row count is ROLLED in [min, max] — not pinned to the minimum", async () => {
  // "mengapa semua chain 5 5 doang kan random min 5 max 8". The first cut of
  // the mirror filled every chain to `perChainMin`, so all six published
  // exactly five rows for ever — the very defect the range was added to end.
  const now = Date.now();
  const CHAINS = ["solana", "bsc", "ethereum", "base", "robinhood", "tron"];
  const t = CHAINS.map((c) => poster._rolledTarget(c, 5, 8, now));
  for (const n of t) assert.ok(n >= 5 && n <= 8, `target ${n} outside the range`);
  assert.ok(new Set(t).size > 1, `every chain got the same count again: ${t.join(",")}`);
});

test("the roll HOLDS within its bucket, then moves on by itself", async () => {
  // The board is edited in place every few minutes; a fresh roll each publish
  // would make the count flicker 5 → 8 → 6 while somebody is reading it.
  //
  // ⚠️ MEASURED FROM A BUCKET BOUNDARY, not an arbitrary instant. The first cut
  // asserted stability at t0+2h against a 3h bucket and failed — because t0
  // happened to sit near a boundary, so the offset crossed into the next
  // bucket. The premise was wrong, not the code: a bucketed roll is stable
  // INSIDE a bucket by construction and must change at the edge, and a test
  // that cannot say which side of the edge it is on proves neither.
  const BUCKET = 3 * 3600_000;
  const start = Math.ceil(1_700_000_000_000 / BUCKET) * BUCKET;
  const at = (ms) => poster._rolledTarget("solana", 5, 8, ms);
  const held = at(start);
  for (const off of [0, 1, 60_000, BUCKET / 2, BUCKET - 1]) {
    assert.strictEqual(at(start + off), held, `the count changed ${off}ms into its own bucket`);
  }
  // …and over a long enough span it does not sit on one number for ever.
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(at(start + i * BUCKET));
  assert.ok(seen.size > 1, `the count never changed across a week: ${[...seen]}`);
});

test("a PINNED range (min = max) is a fixed count, and stays one", async () => {
  for (let i = 0; i < 20; i++) {
    assert.strictEqual(poster._rolledTarget("bsc", 5, 5, Date.now() + i * 3600_000), 5);
  }
});

test("the board actually renders the rolled target, not the minimum", async () => {
  // Driving the real renderer, because the roll is only worth anything if the
  // fill loop reads it — the constant it replaced was read in two places.
  const now = Date.now();
  const target = poster._rolledTarget("solana", 5, 8, now);
  const text = await render({
    listings: [listing({ address: "p", sym: "PAID", trendingRank: 1, trendStart: now, trendExp: now + 3600_000, tier: "DIAMOND" })],
    chains: { solana: Array.from({ length: 20 }, (_, i) => siteRow(`T${i}`, 50 - i)) },
    perChainMin: 5,
    perChainMax: 8,
  });
  const rows = text.split("\n").filter((l) => /\| \[\$/.test(l));
  assert.strictEqual(rows.length, target, `rendered ${rows.length} rows for a rolled target of ${target}`);
});
