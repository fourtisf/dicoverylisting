// Why the auto-lister listed nothing must be ANSWERABLE.
//
// The operator's report (2026-08-06): the panel said Auto Listing was ON and
// nothing had been listed for two days. Every reason this service does nothing
// went to log.debug — which only prints when DEBUG is set, and production does
// not set it — and "discovery returned no candidates" was not logged at all. A
// healthy-but-idle scan and a service broken for two days produced identical
// output: none. These tests pin the three things that fixes it: every scan
// files a report, a scan that cannot run says so, and enough of those page the
// operator instead of waiting to be noticed.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-alvis-"));

const test = require("node:test");
const assert = require("node:assert");

const al = require("../src/services/autoLister");
const api = require("../src/api/dexvra");
const ds = require("../src/dexscreener");
const log = require("../src/helpers/logger");

const M = 1_000_000;
const HOUR = 3_600_000;
const now = 1_800_000_000_000;

const healthy = (over = {}) => ({
  name: "Nine Hood",
  symbol: "NINEHOOD",
  mcap: 1.2 * M,
  liq: 120_000,
  vol24: 300_000,
  priceUsd: 0.0012,
  pairCreatedAt: now - 48 * HOUR,
  ...over,
});

/** Stub the site API for one test. */
function stubApi(t, { listings = [], create = async (i) => ({ id: "x", ...i }) } = {}) {
  const real = { createListing: api.createListing, getListings: api.getListings, canCreate: api.canCreate };
  api.getListings = async () => (typeof listings === "function" ? listings() : listings);
  api.createListing = create;
  // ⚠️ The WRITE PROBE too. 🔎 Test scan asks `api.canCreate()` now — it used to
  // exercise only the read path and so reported "2 qualify" over a service whose
  // every create was being refused. A stub that leaves it out talks to the real
  // site, which is a test passing or failing on somebody's network.
  api.canCreate = async () => ({ ok: true, status: 400, why: null });
  t.after(() => Object.assign(api, real));
}

/** Capture log.alert for one test. */
function capture(t) {
  const real = log.alert;
  const seen = [];
  log.alert = (html) => seen.push(String(html));
  t.after(() => (log.alert = real));
  return seen;
}

const reset = async () => {
  await al.reset();
  await al.resetState();
  await al.set({ enabled: true, minMcap: 1 * M, maxMcap: 1.5 * M, postChannel: false });
};

// ── Every scan leaves a record ──────────────────────────────────────────────

test("a scan that lists nothing still says what it saw and why", async (t) => {
  await reset();
  stubApi(t);
  // Each token has its OWN hash-derived trigger, so "over the trigger" has to be
  // computed rather than assumed — this one clears its own and then fails on
  // liquidity, which is the reason under test.
  const thinMcap = al.triggerMcap("0xthin", al.get()) + 1;
  await al.runOnce({
    now,
    deps: {
      fetchDiscovery: async () => [
        { chain: "solana", address: "So1poor" },
        { chain: "bsc", address: "0xthin" },
      ],
      fetchTokenInfo: async (chain) =>
        chain === "solana" ? healthy({ mcap: 40_000 }) : healthy({ mcap: thinMcap, liq: 900 }),
    },
  });

  const scan = al.lastScan();
  assert.ok(scan, "no report was filed — this is the whole bug");
  assert.strictEqual(scan.candidates, 2);
  assert.strictEqual(scan.priced, 2);
  assert.strictEqual(scan.listed, 0);
  assert.strictEqual(scan.blocker, null, "a quiet market is not a fault");
  // The tally is what turns "nothing happened" into a diagnosis.
  assert.deepStrictEqual(scan.reasons, { "below its trigger": 1, "thin liquidity": 1 });
  // Figures are stripped, or every rejection would be its own bucket.
  assert.ok(!Object.keys(scan.reasons).some((r) => /\d/.test(r)), `reasons carry numbers: ${Object.keys(scan.reasons)}`);
});

test("a scan that lists something reports that too", async (t) => {
  await reset();
  stubApi(t);
  const n = await al.runOnce({
    now,
    deps: {
      fetchDiscovery: async () => [{ chain: "solana", address: "So1good" }],
      fetchTokenInfo: async () => healthy({ mcap: 1.9 * M }),
    },
  });
  assert.strictEqual(n, 1);
  const scan = al.lastScan();
  assert.strictEqual(scan.listed, 1);
  assert.strictEqual(scan.blocker, null);
});

// ── The states where the service looks ON and cannot work ───────────────────

test("empty discovery is a BLOCKER, not a quiet market", async (t) => {
  await reset();
  stubApi(t);
  await al.runOnce({ now, deps: { fetchDiscovery: async () => [] } });
  const scan = al.lastScan();
  assert.match(scan.blocker, /no candidates/);
  // This is the exact case that used to `return 0` with no log line anywhere.
  assert.strictEqual(scan.candidates, 0);
});

test("an unreachable site API is a BLOCKER and names the error", async (t) => {
  await reset();
  stubApi(t, {
    listings: () => {
      throw new Error("GET /api/internal/listings → 401: unauthorized");
    },
  });
  await al.runOnce({
    now,
    deps: { fetchDiscovery: async () => [{ chain: "solana", address: "So1x" }], fetchTokenInfo: async () => healthy() },
  });
  const scan = al.lastScan();
  assert.match(scan.blocker, /site API unreachable/);
  assert.match(scan.blocker, /401/, "the operator needs the real error, not a category");
});

test("discovery throwing is a BLOCKER", async (t) => {
  await reset();
  stubApi(t);
  await al.runOnce({
    now,
    deps: {
      fetchDiscovery: async () => {
        throw new Error("fetch failed");
      },
    },
  });
  assert.match(al.lastScan().blocker, /discovery failed: fetch failed/);
});

test("the daily cap is reported but is NOT a fault — the operator set it", async (t) => {
  await reset();
  await al.set({ maxPerDay: 1 });
  stubApi(t);
  await al.runOnce({
    now,
    deps: {
      fetchDiscovery: async () => [{ chain: "solana", address: "So1cap" }],
      fetchTokenInfo: async () => healthy({ mcap: 1.9 * M }),
    },
  });
  await al.runOnce({
    now,
    deps: {
      fetchDiscovery: async () => [{ chain: "solana", address: "So1cap2" }],
      fetchTokenInfo: async () => healthy({ mcap: 1.9 * M }),
    },
  });
  const scan = al.lastScan();
  assert.strictEqual(scan.blocker, null, "a cap doing its job must never page anyone");
  assert.strictEqual(scan.capped, "1/1");
  assert.match(al.scanLine(scan), /daily cap reached \(1\/1\)/);
});

// ── Escalation ──────────────────────────────────────────────────────────────

test("blocked scans page the operator — once, on the third, then recover", async (t) => {
  await reset();
  stubApi(t);
  const alerts = capture(t);
  const blocked = { fetchDiscovery: async () => [] };

  await al.runOnce({ now, deps: blocked });
  await al.runOnce({ now, deps: blocked });
  assert.strictEqual(alerts.length, 0, "two blocked scans is a blip, not a page");

  await al.runOnce({ now, deps: blocked });
  assert.strictEqual(alerts.length, 1, "three in a row must page");
  assert.match(alerts[0], /Auto-Listing has stopped working/);

  await al.runOnce({ now, deps: blocked });
  await al.runOnce({ now, deps: blocked });
  assert.strictEqual(alerts.length, 1, "a paged fault must not re-page every scan");

  // …and recovery is announced, or the operator never learns it is fixed.
  await al.runOnce({
    now,
    deps: {
      fetchDiscovery: async () => [{ chain: "solana", address: "So1back" }],
      fetchTokenInfo: async () => healthy({ mcap: 10_000 }),
    },
  });
  assert.strictEqual(alerts.length, 2);
  assert.match(alerts[1], /scanning again/);
});

test("a scan that runs fine resets the blocked streak", async (t) => {
  await reset();
  stubApi(t);
  const alerts = capture(t);
  const blocked = { fetchDiscovery: async () => [] };
  const fine = {
    fetchDiscovery: async () => [{ chain: "solana", address: "So1ok" }],
    fetchTokenInfo: async () => healthy({ mcap: 10_000 }),
  };
  await al.runOnce({ now, deps: blocked });
  await al.runOnce({ now, deps: blocked });
  await al.runOnce({ now, deps: fine }); // streak broken
  await al.runOnce({ now, deps: blocked });
  await al.runOnce({ now, deps: blocked });
  assert.strictEqual(alerts.length, 0, "an intermittent feed must not page");
});

// ── The cool-off that stops the scan re-pricing the same rejects ────────────

test("a token nowhere near its trigger is not re-priced next scan", async (t) => {
  await reset();
  stubApi(t);
  const cands = [{ chain: "solana", address: "So1far" }];
  let priced = 0;
  const deps = {
    fetchDiscovery: async () => cands,
    fetchTokenInfo: async () => {
      priced++;
      return healthy({ mcap: 20_000 }); // ~1.5% of its trigger
    },
  };
  await al.runOnce({ now, deps });
  assert.strictEqual(priced, 1);
  await al.runOnce({ now: now + 30 * 60_000, deps });
  assert.strictEqual(priced, 1, "re-pricing a token 50x below its trigger wastes the lookup budget");
  assert.strictEqual(al.lastScan().cooled, 1, "and the panel should say the budget went further");
  // The cool-off expires — it is a delay, never a permanent exclusion.
  await al.runOnce({ now: now + 13 * HOUR, deps });
  assert.strictEqual(priced, 2);
});

test("a token CLOSE to its trigger is re-priced every scan — it is about to cross", async (t) => {
  await reset();
  stubApi(t);
  // Just under this token's OWN trigger — the case where the next scan is the
  // one that matters, so a cool-off here would miss the crossing.
  const near = Math.round(al.triggerMcap("So1near", al.get()) * 0.8);
  let priced = 0;
  const deps = {
    fetchDiscovery: async () => [{ chain: "solana", address: "So1near" }],
    fetchTokenInfo: async () => {
      priced++;
      return healthy({ mcap: near });
    },
  };
  await al.runOnce({ now, deps });
  await al.runOnce({ now: now + 30 * 60_000, deps });
  assert.strictEqual(priced, 2, "a token one step from its trigger must never be on cool-off");
});

test("cool-off never outlives the age gate it is waiting for", () => {
  const cfg = { ...al.get(), minAgeHours: 6 };
  const born = now - 2 * HOUR;
  const until = al.coolUntil("too new (2h old)", { pairCreatedAt: born, mcap: 1.2 * M }, cfg, 1.1 * M, now);
  // Exactly when it becomes eligible — not a guess, and not a fixed delay that
  // would either re-price it pointlessly or hold it back after it qualifies.
  assert.strictEqual(until, born + 6 * HOUR);
});

test("a token that QUALIFIES is never left on cool-off", async (t) => {
  await reset();
  stubApi(t);
  let mcap = 20_000;
  const deps = {
    fetchDiscovery: async () => [{ chain: "solana", address: "So1climb" }],
    fetchTokenInfo: async () => healthy({ mcap }),
  };
  await al.runOnce({ now, deps }); // rejected → cooled for 12h
  mcap = 1.9 * M; // …and then it moons inside that window
  const listed = await al.runOnce({ now: now + 13 * HOUR, deps });
  assert.strictEqual(listed, 1);
  // Nothing may hold a qualifying token back once the memo expires.
  assert.strictEqual(al.lastScan().listed, 1);
});

// ── Discovery must not spend the whole budget on one feed ───────────────────

test("candidates are interleaved across feeds, not concatenated", async () => {
  const feed = (chainId, n, tag) =>
    Array.from({ length: n }, (_, i) => ({ chainId, tokenAddress: `${tag}${i}` }));
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = String(url).includes("profiles")
      ? feed("solana", 60, "prof") // the noisy feed: brand-new microcaps
      : String(url).includes("boosts/top")
        ? feed("bsc", 5, "top")
        : feed("base", 5, "new");
    return { ok: true, json: async () => body };
  };
  try {
    const out = await ds.fetchDiscovery();
    // The lister prices only the first maxLookupsPerRun (40 by default). Under
    // the old concatenation those 40 were ALL profiles, so the boosted feeds —
    // where established $1M+ projects actually appear — were never priced.
    const head = out.slice(0, 40).map((c) => c.chain);
    assert.ok(head.includes("bsc"), "the boosted feed never reaches the lookup budget");
    assert.ok(head.includes("base"), "the newly-boosted feed never reaches the lookup budget");
    // Nothing is lost — the long feed still contributes all of its entries.
    assert.strictEqual(out.length, 70);
  } finally {
    globalThis.fetch = real;
  }
});

test("discovery still de-duplicates across feeds", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [{ chainId: "solana", tokenAddress: "SAME" }],
  });
  try {
    assert.deepStrictEqual(await ds.fetchDiscovery(), [{ chain: "solana", address: "SAME" }]);
  } finally {
    globalThis.fetch = real;
  }
});

// ── The dry run behind "🔎 Test scan" ───────────────────────────────────────

test("the test scan reports verdicts and lists NOTHING", async (t) => {
  await reset();
  let created = 0;
  stubApi(t, {
    create: async (i) => {
      created++;
      return { id: "x", ...i };
    },
  });
  // ⚠️ The report BEFORE, not `null`. 🧹 Clear history preserves the scan report
  // now — it is an observation about the LOOP, not knowledge about tokens, and
  // wiping it made the panel instantly accuse a healthy loop of being dead. So
  // "the dry run writes no state" is asserted as "the report did not change",
  // which is the same rule stated more exactly and survives that.
  const before = JSON.stringify(al.lastScan());
  const r = await al.dryRun({
    now,
    deps: {
      fetchDiscovery: async () => [
        { chain: "solana", address: "So1win" },
        { chain: "bsc", address: "0xlose" },
      ],
      fetchTokenInfo: async (chain) => (chain === "solana" ? healthy({ mcap: 1.9 * M }) : healthy({ mcap: 5_000 })),
    },
  });
  assert.strictEqual(created, 0, "a dry run that lists is not a dry run");
  assert.strictEqual(r.listed, 1, "it must still say what a real scan WOULD list");
  assert.strictEqual(r.qualified.length, 1);
  assert.strictEqual(r.qualified[0].sym, "NINEHOOD");
  assert.deepStrictEqual(r.reasons, { "below its trigger": 1 });
  // …and it writes no state: the report on disk is untouched.
  assert.strictEqual(JSON.stringify(al.lastScan()), before);
});

test("the test scan answers even when the service is OFF", async (t) => {
  await reset();
  await al.set({ enabled: false });
  stubApi(t);
  const r = await al.dryRun({
    now,
    deps: {
      fetchDiscovery: async () => [{ chain: "solana", address: "So1off" }],
      fetchTokenInfo: async () => healthy({ mcap: 1.9 * M }),
    },
  });
  // "Would this list anything if I turned it on?" is exactly the question an
  // operator has before turning it on.
  assert.strictEqual(r.listed, 1);
});

test("the test scan surfaces the same blockers a real scan hits", async (t) => {
  await reset();
  stubApi(t, {
    listings: () => {
      throw new Error("ECONNREFUSED 127.0.0.1:3005");
    },
  });
  const r = await al.dryRun({
    now,
    deps: { fetchDiscovery: async () => [{ chain: "solana", address: "So1y" }], fetchTokenInfo: async () => healthy() },
  });
  assert.match(r.blocker, /site API unreachable/);
  assert.match(r.blocker, /ECONNREFUSED/);
});

test("the scan line reads as a sentence, blocked or not", () => {
  assert.match(
    al.scanLine({ candidates: 90, priced: 40, listed: 0, known: 12, cooled: 8, reasons: { "below its trigger": 31 }, blocker: null }),
    /90 candidates · 40 priced · 0 listed · 12 already known · 8 on cool-off — below its trigger ×31/,
  );
  assert.match(al.scanLine({ ...al.lastScan?.(), blocker: "site API unreachable: 401" }), /⛔ site API unreachable: 401/);
});

// ── Discovery must cover the chains the bot says it covers ──────────────────

test("every supported chain is discoverable — the panel says 'every supported chain'", () => {
  const { CHAINS } = require("../src/config/chains");
  const { DS_CHAIN } = require("../src/dexscreener");
  const missing = Object.keys(CHAINS).filter((c) => !DS_CHAIN[c]);
  // It was 13 of 22: Polygon, Arbitrum, Optimism, Avalanche, Blast, Sei and the
  // rest could never be auto-listed, because OUR_CHAIN could not map their feed
  // entries back and discovery dropped them before pricing.
  assert.deepStrictEqual(missing, [], `chains the auto-lister can never surface: ${missing.join(", ")}`);
});

test("the map is derived, so adding a chain cannot silently skip discovery", () => {
  const src = fss.readFileSync(path.join(__dirname, "../src/dexscreener.js"), "utf8");
  assert.match(src, /Object\.keys\(CHAINS\)/, "DS_CHAIN is hand-listed again — it will drift from chains.js");
});

test("the chain map round-trips: every slug maps back to the chain it came from", () => {
  const { CHAINS } = require("../src/config/chains");
  const { DS_CHAIN } = require("../src/dexscreener");
  // OUR_CHAIN is the inverse of DS_CHAIN. Two of our chains sharing one slug
  // would make discovery attribute a token to the wrong network.
  const slugs = Object.values(DS_CHAIN);
  assert.strictEqual(new Set(slugs).size, slugs.length, `duplicate DexScreener slugs: ${slugs.join(", ")}`);
  assert.strictEqual(slugs.length, Object.keys(CHAINS).length);
});

// ── The test scan is a button tap, not a background job ─────────────────────

test("the dry run is bounded and says when it sampled", async (t) => {
  await reset();
  stubApi(t);
  let priced = 0;
  const r = await al.dryRun({
    now,
    deps: {
      fetchDiscovery: async () =>
        Array.from({ length: 60 }, (_, i) => ({ chain: "solana", address: `So1many${i}` })),
      fetchTokenInfo: async () => {
        priced++;
        return healthy({ mcap: 10_000 });
      },
    },
  });
  // 40 serial quotes at an 8s timeout is up to five minutes of a frozen panel.
  assert.ok(priced <= 15, `dry run priced ${priced} tokens inside a button tap`);
  assert.strictEqual(r.sampled, true, "a partial scan must not read as a full one");
  assert.strictEqual(r.candidates, 60, "…while still reporting how many there were");
});

test("a dry run that reaches the end of the candidates is NOT flagged as sampled", async (t) => {
  await reset();
  stubApi(t);
  const r = await al.dryRun({
    now,
    deps: {
      fetchDiscovery: async () => [{ chain: "solana", address: "So1one" }],
      fetchTokenInfo: async () => healthy({ mcap: 10_000 }),
    },
  });
  assert.ok(!r.sampled, "claiming a sample when nothing was skipped understates the answer");
});
