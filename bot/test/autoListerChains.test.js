// The auto-lister's CHAIN SCOPE — "kalau pilih Base, fokus ke Base" (operator,
// 2026-08-22). Empty scope = every supported chain, the behaviour the service
// has always had; a non-empty scope focuses the whole scan budget there.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-alchains-"));

const test = require("node:test");
const assert = require("node:assert");

const al = require("../src/services/autoLister");
const api = require("../src/api/dexvra");

const M = 1_000_000;
const HOUR = 3_600_000;
const now = 1_800_000_000_000;

const healthy = (over = {}) => ({
  name: "Nine Hood",
  symbol: "NINEHOOD",
  mcap: 1.5 * M,
  liq: 120_000,
  vol24: 300_000,
  priceUsd: 0.0012,
  pairCreatedAt: now - 48 * HOUR,
  ...over,
});

function stubApi(t, created) {
  const real = { createListing: api.createListing, getListings: api.getListings, canCreate: api.canCreate };
  // ⚠️ The WRITE PROBE too. 🔎 Test scan asks `api.canCreate()` now — it used to
  // exercise only the read path and so reported "2 qualify" over a service whose
  // every create was being refused. A stub that leaves it out talks to the real
  // site, which is a test passing or failing on somebody's network.
  api.canCreate = async () => ({ ok: true, status: 400, why: null });
  api.createListing = async (input) => {
    created.push(input);
    return { id: "x", ...input };
  };
  api.getListings = async () => [];
  t.after(() => Object.assign(api, real));
}

test("empty scope means EVERY chain — the behaviour every existing install keeps", async () => {
  await al.reset();
  assert.deepStrictEqual(al.get().chains, [], "fresh install: no scope");
  assert.strictEqual(al.chainAllowed(al.get(), "base"), true);
  assert.strictEqual(al.chainAllowed(al.get(), "solana"), true);
});

test("an unknown chain key is DROPPED, not stored — a typo'd scope lists nothing forever", async () => {
  await al.reset();
  const c = await al.set({ chains: ["base", "notachain", "base", "solana"] });
  assert.deepStrictEqual(c.chains, ["base", "solana"], "valid keys survive, deduped; junk does not");
  await al.reset();
});

test("a Base scope lists Base and spends NO lookups on anything else", async (t) => {
  await al.reset();
  const created = [];
  stubApi(t, created);
  // `paceListings: false` so the scan runs the whole candidate list: this test
  // counts what the SCOPE skipped, and a paced scan stops after its one listing
  // with the tally still short of the candidates behind it.
  await al.set({ enabled: true, paceListings: false, chains: ["base"], maxPerRun: 5, maxPerDay: 5, minMcap: 1 * M, maxMcap: 1.5 * M, postChannel: false });

  const priced = [];
  const n = await al.runOnce({
    now,
    deps: {
      fetchDiscovery: async () => [
        { chain: "solana", address: "So1anaMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1" },
        { chain: "base", address: "0xBa5eBa5eBa5eBa5eBa5eBa5eBa5eBa5eBa5e0001" },
        { chain: "bsc", address: "0xB5CB5CB5CB5CB5CB5CB5CB5CB5CB5CB5CB5C0001" },
      ],
      fetchTokenInfo: async (chain, address) => {
        priced.push(`${chain}:${address}`);
        return healthy({ mcap: 1.49 * M });
      },
    },
  });

  assert.strictEqual(n, 1, "one listing — the Base candidate");
  assert.deepStrictEqual(created.map((c) => c.chain), ["base"]);
  // ⚠️ The whole point of focusing: off-scope candidates cost NOTHING. Pricing
  // them and rejecting them would still burn maxLookupsPerRun on chains the
  // operator excluded — the budget starvation the scope exists to end.
  assert.strictEqual(priced.length, 1, "exactly one lookup was spent");
  assert.match(priced[0], /^base:/);

  const scan = al.lastScan();
  assert.strictEqual(scan.offChain, 2, "…and the skipped ones are COUNTED");
  assert.match(al.scanLine(scan), /2 outside chain scope/, "the panel's scan line says so");
  await al.reset();
  await al.resetState();
});

test("the dry run honours the scope — a preview of chains the scan will never list is a market that does not exist", async (t) => {
  await al.reset();
  stubApi(t, []);
  await al.set({ chains: ["base"] });
  const priced = [];
  const r = await al.dryRun({
    now,
    deps: {
      fetchDiscovery: async () => [
        { chain: "solana", address: "So1anaMintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2" },
        { chain: "base", address: "0xBa5eBa5eBa5eBa5eBa5eBa5eBa5eBa5eBa5e0002" },
      ],
      fetchTokenInfo: async (chain, address) => {
        priced.push(chain);
        return healthy();
      },
    },
  });
  assert.deepStrictEqual(priced, ["base"]);
  assert.strictEqual(r.offChain, 1);
  await al.reset();
});

test("clearing the scope restores every chain", async (t) => {
  await al.reset();
  await al.set({ chains: ["base"] });
  const c = await al.set({ chains: [] });
  assert.deepStrictEqual(c.chains, []);
  assert.strictEqual(al.chainAllowed(c, "solana"), true);
});
