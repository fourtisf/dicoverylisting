// Trending slot-expiry upsell — renewal pricing, buyer resolution, dedup.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-upsell-"));
process.env.RENEW_DISCOUNT_PCT = "10";

const test = require("node:test");
const assert = require("node:assert");
const upsell = require("../src/services/trendingUpsell");
const orders = require("../src/payments/orders");

test("renewOffer applies the renewal discount on top of the duration price", () => {
  // SOL 24H base = 4 (packages.js), -10% renewal = 3.6
  const o = upsell.renewOffer("solana", "24H");
  assert.ok(o);
  assert.strictEqual(o.hours, 24);
  assert.strictEqual(o.base, 4);
  assert.strictEqual(o.price, 3.6);
  // Sui pays via BNB table → 24H base 1.5, -10% = 1.35
  const sui = upsell.renewOffer("sui", "24H");
  assert.strictEqual(sui.base, 1.5);
  assert.strictEqual(sui.price, 1.35);
});

test("renewOffer returns null for a duration a chain doesn't offer", () => {
  // SOL table has no 3H row (starts at 6H)
  assert.strictEqual(upsell.renewOffer("solana", "3H"), null);
});

test("refOf is deterministic and case-insensitive on address", () => {
  const a = upsell.refOf("ethereum", "0xABCdef");
  const b = upsell.refOf("ethereum", "0xabcdef");
  assert.strictEqual(a, b);
  assert.match(a, /^[a-f0-9]{12}$/);
});

test("buyerFor picks the most recent paying order for the token", async () => {
  await orders.saveOrder({ id: "o1", kind: "trending", status: "fulfilled", buyerId: 111, createdAt: 1000, payload: { chain: "solana", address: "AAA" } });
  await orders.saveOrder({ id: "o2", kind: "trending", status: "fulfilled", buyerId: 222, createdAt: 5000, payload: { chain: "solana", address: "aaa" } });
  // a listing order for the same token (nested payload shape) also counts
  await orders.saveOrder({ id: "o3", kind: "tiered_listing", status: "fulfilled", buyerId: 333, createdAt: 3000, payload: { listingInput: { chain: "solana", address: "AAA" } } });
  // an unpaid order must be ignored
  await orders.saveOrder({ id: "o4", kind: "trending", status: "pending", buyerId: 999, createdAt: 9000, payload: { chain: "solana", address: "AAA" } });

  const b = upsell.buyerFor("solana", "AAA");
  assert.ok(b);
  assert.strictEqual(b.buyerId, 222, "newest fulfilled order wins");
  // a different chain at the same address does NOT match
  assert.strictEqual(upsell.buyerFor("bsc", "AAA"), null);
});

test("RENEW_DURATIONS are the higher-value runs", () => {
  assert.deepStrictEqual(upsell.RENEW_DURATIONS, ["24H", "48H"]);
});
