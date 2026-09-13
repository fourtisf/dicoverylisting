// ⚠️ THE CONTRACT THE PUBLISHED BOARD KEEPS — whoever produces the rows.
//
// "bagaimana agar masalah ini tidak terjadi lagi". Three regressions in three
// commits, all mine, all one cause: the board's row SELECTION moved from
// `autoTrend` (the promoter) into `trendingPoster` (the website mirror), and
// the rules that governed it did not move with it. Every one of them was
// already written down —
//
//   • `cfg.chains` … "Everything else is PAID-ONLY"  → the mirror filled every
//     chain, and POLYGON/OPTIMISM/BERACHAIN/HYPEREVM grew their own headings;
//   • the per-chain target is a ROLLED RANGE           → the mirror pinned it to
//     the minimum, and all six chains published exactly five rows for ever;
//   • a failure path is as loud as the success path    → the mirror logged only
//     failures, so four different states read as one short board.
//
// …and being written down is exactly what did not help: a comment in module A
// is not a guard on new code in module B, and CLAUDE.md is prose, not a test.
//
// So these assertions belong to the OUTPUT, not to an implementation. They
// drive the real `buildText()` and say nothing about which module chose the
// rows — a future change that moves the selection somewhere else again has to
// keep them true, or this file goes red.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-contract-"));

const test = require("node:test");
const assert = require("node:assert");
const api = require("../src/api/dexvra");
const market = require("../src/marketdata");
const log = require("../src/helpers/logger");
const poster = require("../src/services/trendingPoster");
const autoTrend = require("../src/services/autoTrend");

const CHAINS = ["solana", "bsc", "ethereum", "base", "robinhood", "tron"];
const OFF_CHAINS = ["polygon", "optimism", "berachain", "hyperevm"];

/** Deterministic PRNG so a failure is reproducible from the seed alone. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * A board built from a randomised world: some chains have paid slots, some have
 * bot-booked ones, some have neither, and the site offers a varying number of
 * rankable rows — including unreadable ones.
 */
function world(seed) {
  const r = rng(seed);
  const now = Date.now();
  const listings = [];
  const chains = {};
  const paidOn = new Set();
  for (const chain of [...CHAINS, ...OFF_CHAINS]) {
    const booked = Math.floor(r() * 4); // 0–3 booked slots
    for (let i = 0; i < booked; i++) {
      // A third of booked rows are real PURCHASES; the rest are the bot's own.
      const paid = r() < 0.34;
      if (paid) paidOn.add(chain);
      listings.push({
        status: "approved", chain, address: `${chain}-b${i}`, sym: `${chain.toUpperCase()}B${i}`,
        trendingRank: 1, trendStart: now, trendExp: now + 3600_000,
        tier: paid ? "DIAMOND" : undefined,
      });
    }
    const offered = Math.floor(r() * 12);
    chains[chain] = Array.from({ length: offered }, (_, i) => ({
      chain, address: `${chain}-s${i}`, symbol: `${chain.toUpperCase()}S${i}`, name: "S",
      // A quarter carry NO reading — the bot may never choose one of those.
      change24h: r() < 0.25 ? null : Math.round((r() * 60 - 20) * 100) / 100,
      mcap: 1e6 + Math.floor(r() * 1e8), booked: false,
    }));
  }
  return { listings, chains, paidOn, now };
}

async function publish({ listings, chains }, { live = true, min = 5, max = 8 } = {}) {
  const real = { get: api.getListings, rank: api.boardRank, fetch: market.fetchMarket, info: log.info };
  const lines = [];
  api.getListings = async () => listings;
  api.boardRank = async () => ({ frame: "24h", live, chains });
  market.fetchMarket = async () => ({ change24h: 3, mcap: 2e6, priceUsd: 1 });
  log.info = (m) => lines.push(String(m));
  try {
    await autoTrend.set({ perChainMin: min, perChainMax: max, chains: CHAINS });
    poster._resetState();
    return { text: (await poster.buildText()) || "", lines };
  } finally {
    api.getListings = real.get;
    api.boardRank = real.rank;
    market.fetchMarket = real.fetch;
    log.info = real.info;
  }
}

/**
 * The board, parsed back into { CHAIN: [ticker, …] } — what a reader sees.
 *
 * ⚠️ THE HEADER IS NOT AT THE START OF ITS LINE. It renders as
 * `[🔶](emoji/…) **BSC - Trending**`, and the first cut of this anchored the
 * match with `^\*\*` — so it returned {} for every board and three assertions
 * below iterated an empty object and passed having checked nothing at all.
 * `expectRows` is the guard: a parse that finds no board is an error, never a
 * quiet pass.
 */
function sections(text) {
  const out = {};
  let cur = null;
  for (const line of text.split("\n")) {
    const head = /\*\*([A-Z0-9 ]+) - Trending\*\*/.exec(line);
    if (head) { cur = head[1].trim(); out[cur] = []; continue; }
    const row = /\| \[\$([^\]]+)\]/.exec(line);
    if (cur && row) out[cur].push(row[1]);
  }
  return out;
}
/** …and every assertion that walks the board first proves it FOUND one. */
function expectRows(text, seed) {
  const secs = sections(text);
  const rows = Object.values(secs).flat().length;
  assert.ok(rows > 0, `seed ${seed}: the board parsed to nothing — this assertion would check nothing`);
  return secs;
}

const SEEDS = [1, 7, 42, 99, 1234, 20260830];

test("⚠️ no section for a chain the operator did not configure — unless it holds a PAID row", async () => {
  for (const seed of SEEDS) {
    const w = world(seed);
    const { text } = await publish(w);
    for (const [name, rows] of Object.entries(expectRows(text, seed))) {
      const id = name.toLowerCase();
      if (CHAINS.includes(id)) continue;
      assert.ok(w.paidOn.has(id), `seed ${seed}: ${name} has a section with no purchase on it (${rows.join(",")})`);
    }
  }
});

test("⚠️ a switched-off chain that survives on a purchase is never TOPPED UP", async () => {
  for (const seed of SEEDS) {
    const w = world(seed);
    const { text } = await publish(w);
    for (const [name, rows] of Object.entries(expectRows(text, seed))) {
      const id = name.toLowerCase();
      if (CHAINS.includes(id)) continue;
      // Only the booked rows may be there — nothing the site offered.
      for (const sym of rows) {
        assert.ok(!/S\d+$/.test(sym), `seed ${seed}: ${name} was topped up from the site (${sym})`);
      }
    }
  }
});

test("⚠️ the per-chain count is a ROLLED RANGE, not the minimum repeated", async () => {
  // The invariant the bounds alone cannot express: 5 is inside [5,8], so
  // "every chain shows 5" satisfies a range check and is exactly the defect.
  const now = Date.now();
  const t = CHAINS.map((c) => poster._rolledTarget(c, 5, 8, now));
  for (const n of t) assert.ok(n >= 5 && n <= 8, `target ${n} outside the range`);
  assert.ok(new Set(t).size > 1, `every chain got the same target: ${t.join(",")}`);
});

test("⚠️ …and the BOARD renders that roll — not just the function in isolation", async () => {
  // ⚠️ THE TEST ABOVE DOES NOT COVER THIS, and a mutation run proved it: pinning
  // the board's target back to `perChainMin` left `_rolledTarget` correct and
  // every assertion green. A guard is only honest while it measures the stack
  // the renderer actually uses — the same rule `fonts:check` learnt printing
  // nine green ticks over a banner drawing boxes.
  //
  // No booked rows anywhere, and plenty on offer, so each section's SIZE is the
  // rolled target exactly.
  const listings = [];
  const chains = {};
  for (const chain of CHAINS) {
    chains[chain] = Array.from({ length: 12 }, (_, i) => ({
      chain, address: `${chain}-s${i}`, symbol: `${chain.toUpperCase()}S${i}`, name: "S",
      change24h: 10 - i, mcap: 5e6, booked: false,
    }));
  }
  // ⚠️ AND THIS FIXTURE ALSO PINS THAT A BOARD NEEDS NO BOOKED SLOT. `buildText`
  // used to bail out on `!featured.length`, so a promoter that stalled and let
  // every slot expire took the whole board down with it — the nine-hour outage
  // this session spent the day chasing. The website's ranking can fill it alone.
  const { text } = await publish({ listings, chains }, { min: 5, max: 8 });
  const counts = Object.values(expectRows(text, "rolled")).map((r) => r.length);
  assert.strictEqual(counts.length, CHAINS.length, `expected a section per chain, got ${counts.length}`);
  for (const n of counts) assert.ok(n >= 5 && n <= 8, `a section rendered ${n} rows, outside 5–8`);
  assert.ok(new Set(counts).size > 1, `every chain rendered the same number of rows: ${counts.join(",")}`);
});

test("⚠️ a row the BOT chose always carries a reading; a purchase may render —", async () => {
  for (const seed of SEEDS) {
    const w = world(seed);
    const { text } = await publish(w);
    // Every site row the board took must be one that had a change.
    const readable = new Set();
    for (const rows of Object.values(w.chains)) {
      for (const t of rows) if (Number.isFinite(t.change24h)) readable.add(t.symbol);
    }
    for (const rows of Object.values(expectRows(text, seed))) {
      for (const sym of rows) {
        if (!/S\d+$/.test(sym)) continue; // a booked row, not one we chose
        assert.ok(readable.has(sym), `seed ${seed}: the board chose ${sym}, which had no 24h reading`);
      }
    }
  }
});

test("⚠️ a purchase is never displaced by the website's ranking", async () => {
  for (const seed of SEEDS) {
    const w = world(seed);
    const { text } = await publish(w);
    const shown = new Set(Object.values(expectRows(text, seed)).flat());
    for (const r of w.listings) {
      if (r.tier !== "DIAMOND") continue;
      assert.ok(shown.has(r.sym), `seed ${seed}: paid row ${r.sym} on ${r.chain} was dropped from the board`);
    }
  }
});

test("⚠️ demo data never publishes, and the booked slots still do", async () => {
  for (const seed of SEEDS) {
    const w = world(seed);
    const { text } = await publish(w, { live: false });
    const shown = new Set(Object.values(expectRows(text, seed)).flat());
    for (const sym of shown) {
      assert.ok(!/S\d+$/.test(sym), `seed ${seed}: ${sym} came from a board the site said was not live`);
    }
    for (const r of w.listings) {
      if (!CHAINS.includes(r.chain) && r.tier !== "DIAMOND") continue;
      assert.ok(shown.has(r.sym), `seed ${seed}: booked row ${r.sym} vanished when the site was on demo data`);
    }
  }
});

test("⚠️ every publish emits exactly ONE report line, and it names the reason when nothing was mirrored", async () => {
  const w = world(42);
  const ok = await publish(w);
  const okLines = ok.lines.filter((l) => /\[trending\] board:/.test(l));
  assert.strictEqual(okLines.length, 1, `expected one report line, got ${okLines.length}`);
  assert.ok(!/NOT mirrored/.test(okLines[0]), `a working mirror reported as broken: ${okLines[0]}`);

  const demo = await publish(w, { live: false });
  const demoLines = demo.lines.filter((l) => /\[trending\] board:/.test(l));
  assert.strictEqual(demoLines.length, 1);
  assert.match(demoLines[0], /NOT mirrored: .+/, `the reason must be named, not "unknown": ${demoLines[0]}`);
});
