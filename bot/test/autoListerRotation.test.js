// Auto-Listing: several packages running at once, taking turns — and the paid
// tier the "Listing & Trending" package now draws per token.
//
// Operator's rule (2026-08-04): "paket xpress sama paket listing trending jalan
// barengan loh jadi bergilir … dan listing trending itu random bisa diamond gold
// atau silver".
//
// The tier draw is a REVERSAL of the older rule (every auto listing wore "FREE"
// so it could never be mistaken for a paid placement), so the cases here are
// deliberately explicit about what it now does — a future reader finding the old
// comments in git should land on these instead of guessing.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-alrot-"));

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

/** Run a scan that lists `n` fresh tokens, returning the created payloads. */
async function listMany(n, t, tag) {
  const created = [];
  const real = { createListing: api.createListing, getListings: api.getListings };
  api.createListing = async (input) => {
    created.push(input);
    return { id: "x", ...input };
  };
  api.getListings = async () => [];
  t.after(() => Object.assign(api, real));
  // The rotation is about which package the NEXT listing gets, and this helper
  // reads it off n listings in one scan. The listing pace caps a scan at one, so
  // it is turned off here rather than inherited — the two interact, and that
  // interaction is pinned in autoListerPace.test.js instead of hidden here.
  await al.set({ paceListings: false, maxPerRun: n, maxPerDay: n, minMcap: 1 * M, maxMcap: 1.5 * M, postChannel: false });
  await al.runOnce({
    now,
    deps: {
      fetchDiscovery: async () =>
        Array.from({ length: n }, (_, i) => ({ chain: "solana", address: `So1${tag}_${i}` })),
      fetchTokenInfo: async () => healthy(),
    },
  });
  return created;
}

// ── Rotation ────────────────────────────────────────────────────────────────

test("two packages enabled: they alternate, one listing each", async (t) => {
  await al.reset();
  await al.resetState();
  await al.set({ enabled: true, pkgs: ["xpress", "trending"] });
  assert.deepStrictEqual(al.get().pkgs, ["xpress", "trending"]);

  const created = await listMany(4, t, "rot");
  assert.strictEqual(created.length, 4);
  // Xpress → Trending → Xpress → Trending. The trending ones are the only ones
  // with a slot, which is what tells them apart without trusting the tier.
  const shape = created.map((i) => (i.trendExp ? "trending" : "xpress"));
  assert.deepStrictEqual(shape, ["xpress", "trending", "xpress", "trending"], "packages did not take turns");
  assert.strictEqual(created[0].tier, "XPRESS");
  assert.strictEqual(created[2].tier, "XPRESS");
});

test("the turn survives a restart — it is on disk, not in memory", async (t) => {
  await al.reset();
  await al.resetState();
  await al.set({ enabled: true, pkgs: ["xpress", "trending"] });

  const first = await listMany(1, t, "boot_a");
  assert.strictEqual(first[0].trendExp, undefined, "first listing takes the first package");

  // A restart is a fresh require: the module re-reads its state file.
  delete require.cache[require.resolve("../src/services/autoLister")];
  const fresh = require("../src/services/autoLister");
  assert.strictEqual(
    fresh.nextPkg().key,
    "trending",
    "after a restart the rotation went back to the start — an in-memory cursor would hand out Xpress almost every time",
  );
});

test("a rejected token does not burn a turn", async (t) => {
  await al.reset();
  await al.resetState();
  await al.set({ enabled: true, paceListings: false, pkgs: ["xpress", "trending"], maxPerRun: 2, maxPerDay: 2, minMcap: 1 * M, maxMcap: 1.5 * M, postChannel: false });

  const created = [];
  const real = { createListing: api.createListing, getListings: api.getListings };
  api.createListing = async (input) => {
    created.push(input);
    return { id: "x", ...input };
  };
  api.getListings = async () => [];
  t.after(() => Object.assign(api, real));

  // The first candidate is too thin to list; the second is fine. If the reject
  // consumed a turn, the survivor would come out as the SECOND package.
  let call = 0;
  await al.runOnce({
    now,
    deps: {
      fetchDiscovery: async () => [
        { chain: "solana", address: "So1Rejected1" },
        { chain: "solana", address: "So1Survivor1" },
      ],
      fetchTokenInfo: async () => (call++ === 0 ? healthy({ liq: 10 }) : healthy()),
    },
  });
  assert.strictEqual(created.length, 1, "only the healthy token should list");
  assert.strictEqual(created[0].tier, "XPRESS", "the rejected token spent a turn it never used");
});

test("one package enabled behaves exactly as it did before the rotation", async (t) => {
  await al.reset();
  await al.resetState();
  await al.set({ enabled: true, pkgs: ["trending"] });
  const created = await listMany(3, t, "solo");
  assert.strictEqual(created.length, 3);
  for (const i of created) assert.ok(i.trendExp, "every listing takes the only enabled package");
});

// ── Enabling / disabling ────────────────────────────────────────────────────

test("the last enabled package cannot be switched off", async () => {
  await al.reset();
  assert.deepStrictEqual(al.get().pkgs, ["free"]);
  const c = await al.togglePkg("free");
  assert.deepStrictEqual(c.pkgs, ["free"], "an empty package list is not a setting anybody chose");
});

test("toggling keeps a stable order, whatever order the buttons were tapped", async () => {
  await al.reset();
  await al.togglePkg("trending"); // free + trending
  await al.togglePkg("xpress"); // free + xpress + trending
  await al.togglePkg("free"); // xpress + trending
  assert.deepStrictEqual(al.get().pkgs, ["xpress", "trending"], "rotation order must match the button order");
  await al.togglePkg("nonsense");
  assert.deepStrictEqual(al.get().pkgs, ["xpress", "trending"], "an unknown key changes nothing");
});

test("an install saved before the rotation keeps its package", async () => {
  // The old shape on disk is a single `pkg` string. Silently reverting somebody
  // to "free" on deploy would turn their channel posts into a different product.
  await al.reset();
  await al.set({ pkg: "trending" });
  assert.deepStrictEqual(al.get().pkgs, ["trending"], "the pre-rotation choice was dropped");
  // …and a single `pkg` still REPLACES the list rather than adding to it.
  await al.set({ pkgs: ["free", "xpress"] });
  await al.set({ pkg: "trending" });
  assert.deepStrictEqual(al.get().pkgs, ["trending"]);
});

// ── The drawn tier ──────────────────────────────────────────────────────────

test("Listing & Trending draws Diamond, Gold or Silver — and only those", async () => {
  await al.reset();
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const tier = al.trendTier(`So1TierDraw_${i}`);
    assert.ok(al.TREND_TIERS.includes(tier), `drew ${tier}, which is not on the list`);
    seen.add(tier);
  }
  // Platinum and Bronze are deliberately absent — the operator named three.
  assert.deepStrictEqual([...al.TREND_TIERS].sort(), ["DIAMOND", "GOLD", "SILVER"]);
  assert.ok(seen.size >= 2, `the draw collapsed onto ${[...seen]} — it is not spreading at all`);
});

test("a token's tier is STABLE — the card and the listing can never disagree", () => {
  const a = al.trendTier("So1StableTier1");
  for (let i = 0; i < 5; i++) assert.strictEqual(al.trendTier("So1StableTier1"), a);
  assert.strictEqual(al.trendTier("SO1STABLETIER1"), a, "case-insensitive, like triggerMcap");
});

test("the tier draw does not track the trigger cap", async () => {
  // Both come off the same sha1. Reusing the SAME bytes would make every Diamond
  // land at one end of the market-cap band — a visible pattern in the feed.
  await al.set({ minMcap: 1 * M, maxMcap: 2 * M });
  const cfg = al.get();
  const rows = Array.from({ length: 120 }, (_, i) => `So1Corr_${i}`).map((a) => ({
    tier: al.trendTier(a),
    trigger: al.triggerMcap(a, cfg),
  }));
  const mean = (t) => {
    const xs = rows.filter((r) => r.tier === t).map((r) => r.trigger);
    return xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
  };
  const means = al.TREND_TIERS.map(mean);
  const spread = Math.max(...means) - Math.min(...means);
  // Each tier's mean trigger should sit near the middle of the band. A spread
  // approaching the band width means the two hashes moved together.
  assert.ok(spread < 0.4 * M, `tier and trigger correlate — mean triggers ${means.map(Math.round)}`);
  await al.reset();
});

test("free and xpress keep their fixed tiers — only trending draws", () => {
  assert.strictEqual(al.tierFor("free", "So1Any1"), "FREE");
  assert.strictEqual(al.tierFor("xpress", "So1Any1"), "XPRESS");
  assert.strictEqual(al.tierFor("nonsense", "So1Any1"), "FREE", "an unknown package must not draw a paid tier");
  assert.ok(al.TREND_TIERS.includes(al.tierFor("trending", "So1Any1")));
});

test("the card badge matches what a purchase of that tier gets", () => {
  // fulfillment.js words it "<Label> Tier" / "Xpress Listing". A Gold auto
  // listing and a Gold purchase must not look like two different products.
  assert.strictEqual(al.badgeFor("GOLD"), "Gold Tier");
  assert.strictEqual(al.badgeFor("DIAMOND"), "Diamond Tier");
  assert.strictEqual(al.badgeFor("XPRESS"), "Xpress Listing");
  // "FREE" is not a package anyone can buy, so there is no badge to wear.
  assert.strictEqual(al.badgeFor("FREE"), null);
  assert.strictEqual(al.badgeFor(undefined), null);
});
