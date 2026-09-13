// Market data: the num(null) regression (Number(null)===0 defeated the
// market_cap_usd ?? fdv_usd fallback → mcap "TBA" on every new token) and the
// DexScreener fallback with MANDATORY chain filtering (never price a token off
// a same-address pair on another chain).
const test = require("node:test");
const assert = require("node:assert");
const market = require("../src/marketdata");

const gtBody = (attrs) =>
  JSON.stringify({ data: { attributes: attrs, relationships: {} }, included: [] });
const dsBody = (pairs) => JSON.stringify({ pairs });

function stubFetch(router) {
  const orig = global.fetch;
  global.fetch = async (url) => {
    const body = router(String(url));
    if (body === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  };
  return () => (global.fetch = orig);
}

test("GT market_cap_usd:null falls back to fdv_usd (num(null) must be null, not 0)", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("geckoterminal"))
      return gtBody({ price_usd: "0.0042", market_cap_usd: null, fdv_usd: "123456" });
    return null;
  });
  try {
    const m = await market.fetchMarket("solana", "So1anaAddr111");
    assert.ok(m);
    assert.strictEqual(m.priceUsd, 0.0042);
    assert.strictEqual(m.mcap, 123456); // was 0 → "TBA" before the fix
  } finally {
    restore();
  }
});

test("GT unindexed token → DexScreener fallback, chain-filtered", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("geckoterminal")) return null; // GT hasn't indexed it yet
    if (url.includes("dexscreener"))
      return dsBody([
        // same-address deploy on ANOTHER chain with a huge (wrong) price — must be ignored
        { chainId: "bsc", priceUsd: "99", marketCap: 9e9, liquidity: { usd: 5e6 }, pairAddress: "wrong" },
        { chainId: "solana", priceUsd: "0.001", fdv: 250000, liquidity: { usd: 20000 }, pairAddress: "poolA",
          baseToken: { name: "Rise", symbol: "RISE" } },
      ]);
    return null;
  });
  try {
    const m = await market.fetchMarket("solana", "So1anaAddr111");
    assert.ok(m);
    assert.strictEqual(m.priceUsd, 0.001);
    assert.strictEqual(m.mcap, 250000); // marketCap missing → fdv
    assert.strictEqual(m.poolAddress, "poolA");
    assert.strictEqual(m.symbol, "RISE");
  } finally {
    restore();
  }
});

test("no chain-matching DexScreener pair → null (never a wrong-chain price)", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("geckoterminal")) return null;
    if (url.includes("dexscreener"))
      return dsBody([{ chainId: "bsc", priceUsd: "99", marketCap: 9e9, liquidity: { usd: 5e6 } }]);
    return null;
  });
  try {
    const m = await market.fetchMarket("solana", "So1anaAddr111");
    assert.strictEqual(m, null);
  } finally {
    restore();
  }
});

test("GT price present but mcap missing → DS fills only the gap", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("geckoterminal"))
      return gtBody({ price_usd: "0.5", market_cap_usd: null, fdv_usd: null });
    if (url.includes("dexscreener"))
      return dsBody([
        { chainId: "ethereum", priceUsd: "0.49", marketCap: 777777, liquidity: { usd: 1000 }, pairAddress: "p1" },
      ]);
    return null;
  });
  try {
    const m = await market.fetchMarket("ethereum", "0x" + "a".repeat(40));
    assert.ok(m);
    assert.strictEqual(m.priceUsd, 0.5); // GT price wins
    assert.strictEqual(m.mcap, 777777); // DS fills mcap
  } finally {
    restore();
  }
});

// ── A missing PERCENTAGE is missing data too ────────────────────────────────
//
// "ADA BEBERAPA TOKEN TIDAK ADA PERSENAN TOKENYA WHY?" — rows on the public
// trending board carrying a market cap and no percentage. `fetchMarket` skipped
// DexScreener whenever GT had price+cap+liquidity, and `change24h` was not part
// of that test — so a GT answer with no 24h reading ended the lookup even where
// a second source had one. The board prints this field; it counts as part of
// "GT already has EVERYTHING".
test("a GT answer with no 24h change still consults DexScreener", async () => {
  let askedDs = false;
  const restore = stubFetch((url) => {
    if (url.includes("geckoterminal")) {
      // Everything the old early-return wanted — price, cap, liquidity — and no
      // percentage, which is exactly the state that reached the board.
      return JSON.stringify({
        data: {
          attributes: { price_usd: "1.5", market_cap_usd: "9265672", fdv_usd: "9265672" },
          relationships: { top_pools: { data: [{ id: "p1" }] } },
        },
        included: [{ id: "p1", attributes: { address: "p1", reserve_in_usd: "800000" } }],
      });
    }
    if (url.includes("dexscreener")) {
      askedDs = true;
      return dsBody([
        { chainId: "ethereum", priceUsd: "1.5", marketCap: 9265672, liquidity: { usd: 800000 },
          pairAddress: "p1", priceChange: { h24: "6.4" }, baseToken: { symbol: "MOON" } },
      ]);
    }
    return null;
  });
  try {
    const m = await market.fetchMarket("ethereum", "0x" + "b".repeat(40));
    assert.strictEqual(askedDs, true, "the lookup stopped at GT and the row published with no percentage");
    assert.strictEqual(m.change24h, 6.4);
    assert.strictEqual(m.mcap, 9265672, "the cap still comes from the source that had it");
  } finally {
    restore();
  }
});

test("a GT answer that HAS everything still short-circuits — one field must not cost a request per poll", async () => {
  let askedDs = false;
  const restore = stubFetch((url) => {
    if (url.includes("geckoterminal"))
      return JSON.stringify({
        data: {
          attributes: { price_usd: "1.5", market_cap_usd: "9265672" },
          relationships: { top_pools: { data: [{ id: "p1" }] } },
        },
        included: [{ id: "p1", attributes: { address: "p1", reserve_in_usd: "800000", price_change_percentage: { h24: "3.1" } } }],
      });
    if (url.includes("dexscreener")) {
      askedDs = true;
      return dsBody([]);
    }
    return null;
  });
  try {
    const m = await market.fetchMarket("ethereum", "0x" + "c".repeat(40));
    assert.strictEqual(m.change24h, 3.1);
    assert.strictEqual(askedDs, false, "nine background pipelines call this on timers");
  } finally {
    restore();
  }
});

// ── `need`: the cheap answer has to carry what the CALLER reads ─────────────
//
// The cheap path used to return the moment DexScreener had a price and a cap —
// right for `fetchPrice`, whose callers read exactly those two, and wrong for
// the trending promoter, which sorts by `change24h` and applies floors to
// `mcap`/`vol24h`. Turning that pass cheap without this would have handed it
// records with no percentage, which it reads as "this token has no reading" and
// refuses — a cheap read that makes the board SHORTER, not cheaper.

const dsPair = (over = {}) => ({
  chainId: "solana",
  baseToken: { address: "So1anaAddr111", name: "Tok", symbol: "TOK" },
  priceUsd: "1.5",
  liquidity: { usd: 200_000 },
  volume: { h24: 90_000 },
  priceChange: { h24: 4.2 },
  marketCap: 7_000_000,
  ...over,
});

test("⚠️ cheap STOPS at DexScreener only when it has every field the caller named", async () => {
  let gtAsked = 0;
  const restore = stubFetch((url) => {
    if (url.includes("geckoterminal")) {
      gtAsked++;
      return gtBody({ price_usd: "1.5", market_cap_usd: "7000000", fdv_usd: null });
    }
    return dsBody([dsPair()]);
  });
  try {
    const m = await market.fetchMarket("solana", "So1anaAddr111", {
      cheap: true,
      need: ["priceUsd", "mcap", "vol24h", "change24h"],
    });
    assert.strictEqual(m.change24h, 4.2);
    assert.strictEqual(m.vol24h, 90_000);
    assert.strictEqual(gtAsked, 0, "GeckoTerminal was asked anyway — the whole saving is gone");
  } finally {
    restore();
  }
});

test("⚠️ …and FALLS THROUGH to GT when DexScreener is missing one of them", async () => {
  let gtAsked = 0;
  const restore = stubFetch((url) => {
    if (url.includes("geckoterminal")) {
      gtAsked++;
      return gtBody({ price_usd: "1.5", market_cap_usd: "7000000", fdv_usd: null });
    }
    // A price and a cap, and NO percentage — exactly the record the old cheap
    // test accepted, and exactly the one the promoter cannot use.
    return dsBody([dsPair({ priceChange: {} })]);
  });
  try {
    await market.fetchMarket("solana", "So1anaAddr111", {
      cheap: true,
      need: ["priceUsd", "mcap", "vol24h", "change24h"],
    });
    assert.strictEqual(gtAsked, 1, "it stopped at a record with no percentage");
  } finally {
    restore();
  }
});

test("⚠️ a measured 0.00% / $0 volume SATISFIES `need` — they are readings, not blanks", async () => {
  let gtAsked = 0;
  const restore = stubFetch((url) => {
    if (url.includes("geckoterminal")) {
      gtAsked++;
      return gtBody({ price_usd: "1.5", market_cap_usd: "7000000", fdv_usd: null });
    }
    // A pool that traded nothing all day. A truthiness test would drop both and
    // send the row to GT — the exact quota this change exists to save.
    return dsBody([dsPair({ volume: { h24: 0 }, priceChange: { h24: 0 } })]);
  });
  try {
    const m = await market.fetchMarket("solana", "So1anaAddr111", {
      cheap: true,
      need: ["priceUsd", "mcap", "vol24h", "change24h"],
    });
    assert.strictEqual(m.change24h, 0);
    assert.strictEqual(m.vol24h, 0);
    assert.strictEqual(gtAsked, 0);
  } finally {
    restore();
  }
});

test("the DEFAULT stays what it was — fetchPrice's callers read price and cap", async () => {
  let gtAsked = 0;
  const restore = stubFetch((url) => {
    if (url.includes("geckoterminal")) {
      gtAsked++;
      return gtBody({ price_usd: "1.5", market_cap_usd: "7000000", fdv_usd: null });
    }
    return dsBody([dsPair({ priceChange: {}, volume: {} })]);
  });
  try {
    const m = await market.fetchMarket("solana", "So1anaAddr111", { cheap: true });
    assert.strictEqual(m.priceUsd, 1.5);
    assert.strictEqual(gtAsked, 0, "the cheap default regressed — every pump-checker poll now costs a GT read");
  } finally {
    restore();
  }
});
