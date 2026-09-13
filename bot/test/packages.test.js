const test = require("node:test");
const assert = require("node:assert");
const pk = require("../src/config/packages");

test("tier prices match the web packages.ts (billed in native)", () => {
  assert.strictEqual(pk.tierPrice("DIAMOND", "solana"), 5);
  assert.strictEqual(pk.tierPrice("DIAMOND", "bsc"), 1.5);
  assert.strictEqual(pk.tierPrice("DIAMOND", "ethereum"), 0.26);
  assert.strictEqual(pk.tierPrice("XPRESS", "solana"), 1);
  assert.strictEqual(pk.tierPrice("XPRESS", "ethereum"), 0.06);
  assert.strictEqual(pk.tierPrice("BRONZE", "tron"), 3000);
  assert.strictEqual(pk.tierPrice("DIAMOND", "ton"), 250);
});

test("ranked tiers exclude Xpress; Xpress is instant", () => {
  assert.strictEqual(pk.RANKED_TIERS.length, 5);
  assert.ok(!pk.RANKED_TIERS.find((t) => t.key === "XPRESS"));
  assert.strictEqual(pk.XPRESS_TIER.instant, true);
});

test("announce tiers are Diamond/Gold/Platinum only", () => {
  assert.strictEqual(pk.tierAnnounces("DIAMOND"), true);
  assert.strictEqual(pk.tierAnnounces("PLATINUM"), true);
  assert.strictEqual(pk.tierAnnounces("SILVER"), false);
  assert.strictEqual(pk.tierAnnounces("XPRESS"), false);
});

test("trending per native + duration parsing + 24/48h announce", () => {
  assert.strictEqual(pk.trendingForChain("solana")[0].duration, "6H");
  assert.strictEqual(pk.trendingForChain("bsc")[0].duration, "3H");
  assert.strictEqual(pk.durationToHours("48H"), 48);
  assert.strictEqual(pk.durationToHours("3H"), 3);
  assert.strictEqual(pk.trendingAnnounces("24H"), true);
  assert.strictEqual(pk.trendingAnnounces("6H"), false);
});

test("bundled trending hours per tier", () => {
  assert.strictEqual(pk.tierTrendingHours("DIAMOND"), 48);
  assert.strictEqual(pk.tierTrendingHours("BRONZE"), 6);
  // Xpress is listing-ONLY: no bundled trending slot, no trending-channel post
  // (operator decision from live testing — do not raise above 0).
  assert.strictEqual(pk.tierTrendingHours("XPRESS"), 0);
  for (const t of pk.RANKED_TIERS) assert.ok(pk.tierTrendingHours(t.key) > 0, `${t.key} bundles trending`);
});

test("banner packs (USD) match the web", () => {
  const wide = pk.bannerByKey("wide");
  assert.strictEqual(wide.rows[0].usd, 400);
  assert.strictEqual(wide.rows[0].hours, 24);
  assert.strictEqual(pk.bannerByKey("standard").rows[2].usd, 1220);
});
