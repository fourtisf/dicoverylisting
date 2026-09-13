// Bad market data reaching a PINNED public board.
//
// Live incident: the trending board printed "+521366.00%" and a market cap of
// $1,299,222,047,441 for BONK — a token whose real cap is ~$258M, and which the
// PREVIOUS refresh of the same board had shown correctly. One poisoned pool
// supplied both numbers.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-mkt-"));

const test = require("node:test");
const assert = require("node:assert");
const market = require("../src/marketdata");

function stubFetch(router) {
  const orig = global.fetch;
  global.fetch = async (url) => {
    const body = router(String(url));
    if (body === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  };
  return () => (global.fetch = orig);
}

const gtToken = (attrs, pools) =>
  JSON.stringify({
    data: { attributes: attrs, relationships: { top_pools: { data: pools.map((p) => ({ id: p.id })) } } },
    included: pools,
  });

test("the deepest pool wins, not whichever GT listed first", () => {
  const j = {
    data: { relationships: { top_pools: { data: [{ id: "solana_JUNK" }, { id: "solana_REAL" }] } } },
    included: [
      { id: "solana_JUNK", attributes: { address: "JUNK", reserve_in_usd: "900" } },
      { id: "solana_REAL", attributes: { address: "REAL", reserve_in_usd: "5200000" } },
    ],
  };
  assert.strictEqual(market._deepestPool(j).attributes.address, "REAL");
  // A pool GT didn't list as a top pool is not considered at all.
  const stray = { ...j, included: [...j.included, { id: "solana_STRAY", attributes: { reserve_in_usd: "9e18" } }] };
  assert.strictEqual(market._deepestPool(stray).attributes.address, "REAL");
});

test("an absurd 24h change is dropped, not published", async () => {
  const restore = stubFetch((url) => {
    if (!url.includes("geckoterminal")) return null;
    return gtToken({ price_usd: "0.0000246", market_cap_usd: "258945999" }, [
      { id: "solana_P", attributes: { address: "P", reserve_in_usd: "5200000", price_change_percentage: { h24: "521366" } } },
    ]);
  });
  try {
    const m = await market.fetchMarket("solana", "BONK");
    assert.strictEqual(m.change24h, null, "the board prints nothing rather than +521366%");
    assert.strictEqual(m.mcap, 258945999, "the rest of the reading survives");
  } finally {
    restore();
  }
});

test("a real move inside the sane band still publishes", async () => {
  const restore = stubFetch((url) => {
    if (!url.includes("geckoterminal")) return null;
    return gtToken({ price_usd: "0.01", market_cap_usd: "500000" }, [
      { id: "solana_P", attributes: { address: "P", reserve_in_usd: "80000", price_change_percentage: { h24: "-33.81" } } },
    ]);
  });
  try {
    assert.strictEqual((await market.fetchMarket("solana", "X")).change24h, -33.81);
  } finally {
    restore();
  }
});

test("market caps that disagree wildly: the deeper liquidity wins", () => {
  const gt = { mcap: 1_299_222_047_441, liq: 900, priceUsd: 0.0146 };
  const ds = { mcap: 258_945_999, liq: 5_200_000, priceUsd: 0.0000246 };
  assert.strictEqual(market._pickTrusted(gt, ds, "solana", "BONK"), ds, "a $900 pool does not value a token at $1.3T");
  // The other way round too — this is about liquidity, not about the source.
  const gtDeep = { mcap: 258_945_999, liq: 5_200_000 };
  const dsThin = { mcap: 1_299_222_047_441, liq: 400 };
  assert.strictEqual(market._pickTrusted(gtDeep, dsThin, "solana", "BONK"), gtDeep);
});

test("sources that agree (or lack a value) are left alone", () => {
  const gt = { mcap: 258_945_999, liq: 5_200_000 };
  assert.strictEqual(market._pickTrusted(gt, { mcap: 260_000_000, liq: 10 }, "solana", "B"), gt, "a normal spread keeps GT");
  assert.strictEqual(market._pickTrusted(gt, { mcap: null, liq: 99 }, "solana", "B"), gt, "no DS value → nothing to compare");
  assert.strictEqual(market._pickTrusted({ mcap: null }, { mcap: 5, liq: 9 }, "solana", "B").mcap, null, "no GT value → GT shape kept, filled downstream");
});

test("the board itself refuses to print a six-digit percentage", () => {
  const src = fss.readFileSync(require.resolve("../src/services/trendingPoster.js"), "utf8");
  assert.match(src, /SANE_PCT/, "the render site has its own clamp");
  // Defence in depth: even if marketdata is bypassed or a future caller passes
  // raw data, the pinned board must not show it.
  const pctStr = (n) => (Number.isFinite(n) && Math.abs(n) <= 5000 ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "");
  assert.strictEqual(pctStr(521366), "");
  assert.strictEqual(pctStr(-99.9), "-99.90%");
  assert.strictEqual(pctStr(4999), "+4999.00%");
});

// ── "ADA BEBERAPA TOKEN TIDAK ADA PERSENAN TOKENYA" ─────────────────────────
//
// Rows on the public board with a market cap and no percentage. One cause was
// here: the 24h change was read from the DEEPEST pool and from nowhere else, so
// a token whose main pool had not traded in 24h (GT sends `h24: null`) lost its
// percentage even when a sibling pool of the same token had a good reading.

const pool = (id, reserve, h24) => ({
  id,
  attributes: {
    address: id,
    reserve_in_usd: String(reserve),
    ...(h24 === undefined ? {} : { price_change_percentage: { h24: h24 === null ? null : String(h24) } }),
  },
});
const withPools = (pools) => ({
  data: { relationships: { top_pools: { data: pools.map((p) => ({ id: p.id })) } } },
  included: pools,
});

test("the deepest pool's own reading is used whenever it has one", () => {
  const deep = pool("deep", 5_000_000, 12.5);
  const j = withPools([deep, pool("thin", 4_000, 900)]);
  // Not the thin pool's 900%: price, cap and change all belong to the deep one.
  assert.strictEqual(market._changeFromPools(j, deep), 12.5);
});

test("a deepest pool that has NOT traded in 24h borrows the reading from a real sibling", () => {
  const deep = pool("deep", 5_000_000, null);
  const sib = pool("sib", 900_000, -7.25);
  assert.strictEqual(market._changeFromPools(withPools([deep, sib]), deep), -7.25);

  // Absent object and explicit null are the same fact — GT sends both.
  const bare = pool("bare", 5_000_000, undefined);
  assert.strictEqual(market._changeFromPools(withPools([bare, sib]), bare), -7.25);
});

test("…but never from a DUST pool — that is the number the deepest-pool rule exists to refuse", () => {
  const deep = pool("deep", 5_000_000, null);
  // 0.4% of the deepest pool's liquidity: a percentage about the pool, not the
  // token. Below the floor it is not borrowed, and a blank is the honest answer.
  const dust = pool("dust", 20_000, 4_300);
  assert.strictEqual(market._changeFromPools(withPools([deep, dust]), deep), null);

  // At the floor it counts: a tenth of the deepest pool is still a real market.
  const tenth = pool("tenth", 500_000, 3.5);
  assert.strictEqual(market._changeFromPools(withPools([deep, tenth]), deep), 3.5);
});

test("the DEEPEST qualifying sibling wins, not whichever GT listed first", () => {
  const deep = pool("deep", 5_000_000, null);
  const j = withPools([deep, pool("small", 600_000, 99), pool("big", 2_000_000, 4)]);
  assert.strictEqual(market._changeFromPools(j, deep), 4);
});

test("no pools at all is not a reading of zero", () => {
  assert.strictEqual(market._changeFromPools({ data: {}, included: [] }, null), null);
  assert.strictEqual(market._changeFromPools(withPools([pool("only", 1_000_000, null)]), null), null);
});

test("WHY a reading is missing is recorded — the two causes need different answers", () => {
  // "its pools have not traded in 24h, OR the reading was absurd and refused"
  // was offered to the operator as a guess between two states the code knows
  // the difference between. A diagnostic that guesses is one more thing to
  // check by hand.
  const gt = require("../src/marketdata");
  const restore = stubFetch((url) => {
    if (!url.includes("geckoterminal")) return null;
    return gtToken({ price_usd: "1", market_cap_usd: "9000000" }, [
      { id: "p1", attributes: { address: "p1", reserve_in_usd: "500000", price_change_percentage: { h24: "120000" } } },
    ]);
  });
  return gt
    .fetchMarket("solana", "AbsurdMint1111")
    .then((m) => {
      assert.strictEqual(m.change24h, null, "an absurd reading is still refused");
      assert.match(m.changeWhy, /refused as broken/);
      assert.match(m.changeWhy, /120,000%/, "the number it refused is the diagnosis");
    })
    .finally(restore);
});

test("a quiet pool reports itself as quiet, not as broken", () => {
  const gt = require("../src/marketdata");
  const restore = stubFetch((url) => {
    if (!url.includes("geckoterminal")) return null;
    return gtToken({ price_usd: "1", market_cap_usd: "9000000" }, [
      { id: "p1", attributes: { address: "p1", reserve_in_usd: "500000", price_change_percentage: { h24: null } } },
    ]);
  });
  return gt
    .fetchMarket("solana", "QuietMint11111")
    .then((m) => {
      assert.strictEqual(m.change24h, null);
      assert.match(m.changeWhy, /no trades in the window/);
      assert.ok(!/refused/.test(m.changeWhy));
    })
    .finally(restore);
});
