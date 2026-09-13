// "trending base dan ethereum sangat sedikit, tidak sesuai minimum yang di set"
//
// The board published 3 Ethereum rows and 2 Base rows against a per-chain target
// of 5 — because auto-trend promotes what is LISTED on a chain, and those chains
// had 3 and 2 listings in total. It had been saying so every cycle ("list more
// tokens on those chains"), to an operator who cannot list a token from
// Telegram. These pin the bridge that closes it: when a chain runs out of things
// to promote, its biggest tokens get listed.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-tf-"));

const test = require("node:test");
const assert = require("node:assert");

const bigCoins = require("../src/services/bigCoins");
const trendFill = require("../src/services/trendFill");
const autoTrend = require("../src/services/autoTrend");

// ── The market source ───────────────────────────────────────────────────────

const pool = (sym, name, addr, { mcap, liq = 500_000, vol = 1_000_000 } = {}) => ({
  attributes: {
    market_cap_usd: mcap == null ? null : String(mcap),
    fdv_usd: String(mcap == null ? 0 : mcap),
    reserve_in_usd: String(liq),
    volume_usd: { h24: String(vol) },
    price_change_percentage: { h24: "-4.16" },
    base_token_price_usd: "0.42",
  },
  relationships: { base_token: { data: { id: `eth_${addr}` } } },
  _tok: { id: `eth_${addr}`, type: "token", attributes: { address: addr, name, symbol: sym, image_url: "https://img/x.png" } },
});
const gtBody = (pools) => ({ data: pools, included: pools.map((p) => p._tok) });

function stubGt(pagesOrFn) {
  const gt = require("../src/group/gtPairs");
  const real = gt.gtGet;
  gt.gtGet = typeof pagesOrFn === "function" ? pagesOrFn : async (_p, params) => {
    const page = Number((params && params.page) || 1);
    const body = pagesOrFn[page - 1];
    return body ? { ok: true, status: 200, body } : { ok: true, status: 200, body: { data: [], included: [] } };
  };
  return () => { gt.gtGet = real; };
}

test("the biggest tokens come back cap-first, and the money is not one of them", async () => {
  const restore = stubGt([
    gtBody([
      // The pool's other side wearing a $60B cap: a trending board whose
      // Ethereum section reads WETH · USDC is worse than one with three rows.
      pool("WETH", "Wrapped Ether", "0xweth", { mcap: 60_000_000_000 }),
      pool("USDC", "USD Coin", "0xusdc", { mcap: 40_000_000_000 }),
      pool("wstETH", "Wrapped liquid staked Ether", "0xwsteth", { mcap: 20_000_000_000 }),
      pool("PEPE", "Pepe", "0xpepe", { mcap: 4_000_000_000 }),
      pool("SHIB", "Shiba Inu", "0xshib", { mcap: 8_000_000_000 }),
      pool("TURBO", "Turbo", "0xturbo", { mcap: 300_000_000 }),
    ]),
  ]);
  try {
    const r = await bigCoins.topByMcap("ethereum", { minMcap: 1_000_000, minLiq: 1000 });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.items.map((t) => t.symbol), ["SHIB", "PEPE", "TURBO"], "cap order, and no wrappers or stables");
    assert.strictEqual(r.items[0].logoUrl, "https://img/x.png", "the artwork GT already gave us is not thrown away");
  } finally {
    restore();
  }
});

test("one token in five pools is judged by its DEEPEST one", async () => {
  const restore = stubGt([
    gtBody([
      pool("BRETT", "Brett", "0xbrett", { mcap: 500_000_000, liq: 12_000 }),
      pool("BRETT", "Brett", "0xbrett", { mcap: 500_000_000, liq: 3_000_000 }),
    ]),
  ]);
  try {
    const r = await bigCoins.topByMcap("base", { minMcap: 1_000_000, minLiq: 1_000_000 });
    assert.strictEqual(r.items.length, 1, "the same token must not be listed twice");
    assert.strictEqual(r.items[0].liq, 3_000_000, "a thin pool made a real token look illiquid");
  } finally {
    restore();
  }
});

test("'GT did not answer' and 'this chain has nothing big' are DIFFERENT answers", async () => {
  // Collapsing them into [] is how a rate limit reads as an empty chain and the
  // board stays short with nobody the wiser.
  let restore = stubGt(async () => ({ ok: false, status: 0, reason: "cooldown" }));
  try {
    const down = await bigCoins.topByMcap("ethereum", {});
    assert.strictEqual(down.ok, false);
    assert.match(down.why, /cooldown/);
    assert.deepStrictEqual(down.items, []);
  } finally {
    restore();
  }
  restore = stubGt([gtBody([pool("SMOL", "Smol", "0xsmol", { mcap: 12_000 })])]);
  try {
    const quiet = await bigCoins.topByMcap("ethereum", { minMcap: 5_000_000 });
    assert.strictEqual(quiet.ok, true, "GT answered — that is a different fact from being unreachable");
    assert.deepStrictEqual(quiet.items, []);
  } finally {
    restore();
  }
});

test("a chain GeckoTerminal cannot be asked about says so, rather than reporting nothing", async () => {
  const r = await bigCoins.topByMcap("no-such-chain", {});
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /no GeckoTerminal network id/);
});

// ── The fill ────────────────────────────────────────────────────────────────

const deps = (over = {}) => ({
  topByMcap: async () => ({
    ok: true,
    why: null,
    items: [
      { chain: "base", address: "0xbrett", symbol: "BRETT", name: "Brett", mcap: 500_000_000, liq: 3e6, vol24: 1e6, change24h: -4 },
      { chain: "base", address: "0xtoshi", symbol: "TOSHI", name: "Toshi", mcap: 400_000_000, liq: 2e6, vol24: 1e6, change24h: -1 },
      { chain: "base", address: "0xdegen", symbol: "DEGEN", name: "Degen", mcap: 300_000_000, liq: 1e6, vol24: 1e6, change24h: 3 },
    ],
  }),
  getListings: async () => [],
  wasEverListed: () => false,
  fetchTokenInfo: async () => null,
  createFromInfo: async (chain, address, info) => ({ listing: { id: 1 }, input: { sym: info.symbol, tier: "GOLD" } }),
  ...over,
});

test("it lists EXACTLY the shortfall, biggest first", async () => {
  const r = await trendFill.fillChain("base", 2, { deps: deps() });
  assert.deepStrictEqual(r.listed.map((x) => x.sym), ["BRETT", "TOSHI"]);
  assert.strictEqual(r.why, null, "it filled the gap, so there is nothing to explain");
});

test("a token already on the site is never listed twice", async () => {
  const r = await trendFill.fillChain("base", 2, {
    deps: deps({ getListings: async () => [{ chain: "base", address: "0xBRETT" }] }),
  });
  assert.deepStrictEqual(r.listed.map((x) => x.sym), ["TOSHI", "DEGEN"], "address comparison must be case-insensitive");
});

test("a token that was listed once and removed does not come back free", async () => {
  const r = await trendFill.fillChain("base", 3, {
    deps: deps({ wasEverListed: (_c, a) => a === "0xtoshi" }),
  });
  assert.deepStrictEqual(r.listed.map((x) => x.sym), ["BRETT", "DEGEN"]);
});

test("the site refusing ONE token does not end the fill", async () => {
  const r = await trendFill.fillChain("base", 2, {
    deps: deps({
      createFromInfo: async (_c, address, info) => {
        if (address === "0xbrett") throw new Error("duplicate");
        return { listing: { id: 2 }, input: { sym: info.symbol, tier: "GOLD" } };
      },
    }),
  });
  assert.deepStrictEqual(r.listed.map((x) => x.sym), ["TOSHI", "DEGEN"]);
});

test("what it could NOT do is reported, never returned as a quiet zero", async () => {
  const unreadable = await trendFill.fillChain("base", 2, {
    deps: deps({ topByMcap: async () => ({ ok: false, why: "rate limited", items: [] }) }),
  });
  assert.deepStrictEqual(unreadable.listed, []);
  assert.match(unreadable.why, /could not read the market/, "a rate limit must not read as an empty chain");

  const allKnown = await trendFill.fillChain("base", 2, {
    deps: deps({ getListings: async () => [{ chain: "base", address: "0xbrett" }, { chain: "base", address: "0xtoshi" }, { chain: "base", address: "0xdegen" }] }),
  });
  assert.match(allKnown.why, /already listed/);

  const noApi = await trendFill.fillChain("base", 2, {
    deps: deps({ getListings: async () => { throw new Error("502"); } }),
  });
  // Without the site's list we cannot tell new from listed, and a duplicate is
  // worse than a cycle spent short.
  assert.deepStrictEqual(noApi.listed, []);
  assert.match(noApi.why, /site API unreachable/);
});

test("the token's real identity is used when the enrichment answers, and the fill survives when it does not", async () => {
  let seen = null;
  await trendFill.fillChain("base", 1, {
    deps: deps({
      fetchTokenInfo: async () => ({ name: "Brett (Based)", symbol: "BRETT", logoUrl: "https://cdn/brett.png", twitter: "https://x.com/brett" }),
      createFromInfo: async (_c, _a, info) => { seen = info; return { listing: {}, input: { sym: info.symbol, tier: "GOLD" } }; },
    }),
  });
  assert.strictEqual(seen.name, "Brett (Based)");
  assert.strictEqual(seen.twitter, "https://x.com/brett");

  // …and a failed lookup must cost the socials, never the listing: GT already
  // gave us a name, a symbol and a cap.
  const r = await trendFill.fillChain("base", 1, {
    deps: deps({ fetchTokenInfo: async () => { throw new Error("dexscreener down"); } }),
  });
  assert.deepStrictEqual(r.listed.map((x) => x.sym), ["BRETT"]);
});

test("a big-cap in FREE-FALL is not listed either — one bound, two doors", async () => {
  // The promoter refuses to put a listed token below −15% on the board. A
  // filler that lists a big-cap down 40% into the same slot makes that rule
  // decorative, and on a red day it would do it on every chain, every cycle.
  const r = await trendFill.fillChain("base", 2, {
    maxDropPct: 15,
    deps: deps({
      topByMcap: async () => ({
        ok: true,
        why: null,
        items: [
          { chain: "base", address: "0xcrash", symbol: "CRASH", name: "Crash", mcap: 900_000_000, change24h: -41 },
          { chain: "base", address: "0xedge", symbol: "EDGE", name: "Edge", mcap: 800_000_000, change24h: -15 },
          { chain: "base", address: "0xdark", symbol: "DARK", name: "Dark", mcap: 700_000_000, change24h: null },
        ],
      }),
    }),
  });
  // −15 is AT the bound, not past it, so EDGE is listed.
  //
  // DARK is refused for a DIFFERENT reason, and it did not used to be: an
  // unreadable change is not a fall, but it is not a trending row either. A
  // filled listing books its slot directly, so listing DARK puts a row with no
  // percentage on the pinned board — which is what got reported. Base has two
  // candidates with real readings, so the narrow exemption (below) does not
  // apply here.
  assert.deepStrictEqual(r.listed.map((x) => x.sym), ["EDGE"]);
});

test("…but on a chain where NOTHING reads, the unreadable are still listed", async () => {
  // The exemption the promoter makes, unchanged and exactly as narrow: a chain
  // no indexer covers would otherwise never be filled at all.
  const r = await trendFill.fillChain("base", 2, {
    maxDropPct: 15,
    deps: deps({
      topByMcap: async () => ({
        ok: true,
        why: null,
        items: [
          { chain: "base", address: "0xdark", symbol: "DARK", name: "Dark", mcap: 700_000_000, change24h: null },
          { chain: "base", address: "0xdim", symbol: "DIM", name: "Dim", mcap: 600_000_000, change24h: null },
        ],
      }),
    }),
  });
  assert.deepStrictEqual(r.listed.map((x) => x.sym), ["DARK", "DIM"]);
});

test("a chain where every big-cap is falling says so, and does not read as 'already listed'", async () => {
  const r = await trendFill.fillChain("base", 2, {
    maxDropPct: 15,
    deps: deps({
      topByMcap: async () => ({
        ok: true,
        why: null,
        items: [{ chain: "base", address: "0xcrash", symbol: "CRASH", name: "Crash", mcap: 9e8, change24h: -41 }],
      }),
    }),
  });
  assert.deepStrictEqual(r.listed, []);
  assert.match(r.why, /down more than 15%/, "the reason an operator needs is WHICH refusal this was");
});

test("the bound has ONE owner — autoTrend's, not a second copy here", async () => {
  const autoTrendMod = require("../src/services/autoTrend");
  assert.strictEqual(typeof autoTrendMod.FLOOR_FILL_MAX_DROP, "number");
  // No maxDropPct passed: the lazy fallback must reach that same number, or the
  // two doors drift and the one nobody is looking at is the one that drifted.
  const r = await trendFill.fillChain("base", 1, {
    deps: deps({
      topByMcap: async () => ({
        ok: true,
        why: null,
        items: [{ chain: "base", address: "0xcrash", symbol: "CRASH", name: "Crash", mcap: 9e8, change24h: -(autoTrendMod.FLOOR_FILL_MAX_DROP + 1) }],
      }),
    }),
  });
  assert.deepStrictEqual(r.listed, []);
});

test("nothing is listed when nothing is missing", async () => {
  const r = await trendFill.fillChain("base", 0, { deps: deps() });
  assert.deepStrictEqual(r.listed, []);
});

// ── The wiring: auto-trend must ASK for the fill, and bound it ───────────────

test("a chain with nothing left to promote is filled, and the request is the real shortfall", async () => {
  const calls = [];
  const api = require("../src/api/dexvra");
  const realGet = api.getListings;
  // Base has ONE featured token and nothing spare — the reported state.
  api.getListings = async () => [
    { status: "approved", chain: "base", address: "0x1", sym: "ONE", trendingRank: 1, trendExp: Date.now() + 3.6e6 },
  ];
  try {
    await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, perChain: 5, chains: ["base"], fillFromMarket: true, fillMaxPerCycle: 3 });
    await autoTrend.runOnce({
      rng: () => 0.5,
      deps: { fillChain: async (chain, need) => { calls.push([chain, need]); return { chain, need, listed: [], tried: 0, why: "test" }; } },
    });
    assert.deepStrictEqual(calls, [["base", 3]], "the fill must be asked for the gap, capped at fillMaxPerCycle");

    // …and OFF means OFF: a chain stays short rather than being filled behind
    // the operator's back.
    calls.length = 0;
    await autoTrend.set({ fillFromMarket: false });
    await autoTrend.runOnce({ rng: () => 0.5, deps: { fillChain: async (c, n) => { calls.push([c, n]); return { listed: [] }; } } });
    assert.deepStrictEqual(calls, []);
  } finally {
    api.getListings = realGet;
    await autoTrend.reset();
  }
});

test("a RED day is not a listing spree — the gain floor must not trigger the filler", async () => {
  // The board goes short for two unrelated reasons and only one is fixed by
  // listing something: a chain with nothing left to promote, versus a chain
  // whose listings are all simply DOWN. With `min +5% 24h` set, the second
  // happens to every chain on any red day — and feeding it to the filler would
  // list fillMaxPerCycle fresh tokens per chain, every cycle, all day, while
  // the tokens already listed there sat unused because they were down 2%.
  const calls = [];
  const api = require("../src/api/dexvra");
  const market = require("../src/marketdata");
  const realGet = api.getListings;
  const realFetch = market.fetchMarket;
  const realBook = api.bookTrending;
  // Base has FIVE spare listings — plenty to promote — and every one is down.
  api.getListings = async () =>
    ["b1", "b2", "b3", "b4", "b5"].map((address) => ({ status: "approved", chain: "base", address, sym: address, trendingRank: null }));
  market.fetchMarket = async () => ({ change24h: -3 });
  api.bookTrending = async () => ({});
  try {
    await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, chains: ["base"], perChainMin: 5, perChainMax: 5, minGainPct: 5, fillFromMarket: true, fillMaxPerCycle: 6 });
    await autoTrend.runOnce({
      rng: () => 0.5,
      deps: { fillChain: async (chain, need) => { calls.push([chain, need]); return { listed: [] }; } },
    });
    assert.deepStrictEqual(calls, [], "the chain has five listings — being down is the gain filter working, not a shortage");
  } finally {
    api.getListings = realGet;
    market.fetchMarket = realFetch;
    api.bookTrending = realBook;
    await autoTrend.reset();
  }
});

test("a spare in FREE-FALL is not a spare — the chain is still asked to be filled", async () => {
  // Live board, 19 Aug: Base 4/5 with two spare listings, and it stayed there.
  // Both were below −15%, so the floor fill skipped them (right) and the filler
  // was never asked because the chain "has listings" (wrong). Nothing in the
  // loop could ever move it: the promoter refuses those two on every cycle for
  // the same reason, and a refusal is not a state that resolves itself.
  const calls = [];
  const api = require("../src/api/dexvra");
  const market = require("../src/marketdata");
  const realGet = api.getListings;
  const realFetch = market.fetchMarket;
  const realBook = api.bookTrending;
  api.getListings = async () => [
    ...["f1", "f2", "f3", "f4"].map((address, i) => ({
      status: "approved", chain: "base", address, sym: address, trendingRank: i + 1, trendExp: Date.now() + 3.6e6,
    })),
    { status: "approved", chain: "base", address: "s1", sym: "S1", trendingRank: null },
    { status: "approved", chain: "base", address: "s2", sym: "S2", trendingRank: null },
  ];
  market.fetchMarket = async () => ({ change24h: -30 });
  api.bookTrending = async () => ({});
  try {
    await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, chains: ["base"], perChainMin: 5, perChainMax: 5, minGainPct: 5, fillFromMarket: true, fillMaxPerCycle: 3 });
    await autoTrend.runOnce({
      rng: () => 0.5,
      deps: { fillChain: async (chain, need) => { calls.push([chain, need]); return { listed: [] }; } },
    });
    // ONE — the FLOOR shortfall and no more. Above the minimum the gain floor
    // is still the one that decides, which is what keeps a red day from
    // becoming a listing spree.
    assert.deepStrictEqual(calls, [["base", 1]]);
  } finally {
    api.getListings = realGet;
    market.fetchMarket = realFetch;
    api.bookTrending = realBook;
    await autoTrend.reset();
  }
});

test("a chain ABOVE its minimum whose spares are falling is left alone", async () => {
  // The same shape one row up: 5/5 with two spares at −30%. The board has what
  // the operator asked for, so the rolled target above it is the gain floor's
  // to refuse — asking for a fill here is the red-day spree.
  const calls = [];
  const api = require("../src/api/dexvra");
  const market = require("../src/marketdata");
  const realGet = api.getListings;
  const realFetch = market.fetchMarket;
  const realBook = api.bookTrending;
  api.getListings = async () => [
    ...["f1", "f2", "f3", "f4", "f5"].map((address, i) => ({
      status: "approved", chain: "base", address, sym: address, trendingRank: i + 1, trendExp: Date.now() + 3.6e6,
    })),
    { status: "approved", chain: "base", address: "s1", sym: "S1", trendingRank: null },
    { status: "approved", chain: "base", address: "s2", sym: "S2", trendingRank: null },
  ];
  market.fetchMarket = async () => ({ change24h: -30 });
  api.bookTrending = async () => ({});
  try {
    await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, chains: ["base"], perChainMin: 5, perChainMax: 8, minGainPct: 5, fillFromMarket: true, fillMaxPerCycle: 3 });
    await autoTrend.runOnce({ rng: () => 0.999, deps: { fillChain: async (c, n) => { calls.push([c, n]); return { listed: [] }; } } });
    assert.deepStrictEqual(calls, []);
  } finally {
    api.getListings = realGet;
    market.fetchMarket = realFetch;
    api.bookTrending = realBook;
    await autoTrend.reset();
  }
});

test("a token with NO MARKET is not auto-promoted while the chain has priced spares", async () => {
  // "$BINGBONG" and "$BISKIT" reached the pinned board as bare tickers — no
  // percentage, no market cap, nothing. GT and DexScreener both have nothing
  // for them, so there was never anything to print. The unpriced exemption in
  // the floor fill is for a CHAIN no indexer covers, not for a token with no
  // market on a chain that is indexed fine.
  const calls = [];
  const api = require("../src/api/dexvra");
  const market = require("../src/marketdata");
  const realGet = api.getListings;
  const realFetch = market.fetchMarket;
  const realBook = api.bookTrending;
  api.getListings = async () => [
    { status: "approved", chain: "robinhood", address: "dead1", sym: "BINGBONG", trendingRank: null },
    { status: "approved", chain: "robinhood", address: "dead2", sym: "BISKIT", trendingRank: null },
    { status: "approved", chain: "robinhood", address: "live1", sym: "WTH", trendingRank: null },
  ];
  // Two have no market at all; one is priced but DOWN, which the floor fill
  // still takes — a real market beats no market even at −8%.
  market.fetchMarket = async (_c, address) =>
    address === "live1" ? { priceUsd: 0.4, mcap: 2_576_172, change24h: -8 } : null;
  const booked = [];
  api.bookTrending = async (_c, address) => {
    booked.push(address);
    return {};
  };
  try {
    await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, chains: ["robinhood"], perChainMin: 1, perChainMax: 1, minGainPct: 5, fillFromMarket: false });
    await autoTrend.runOnce({ rng: () => 0.5, deps: { fillChain: async (c, n) => { calls.push([c, n]); return { listed: [] }; } } });
    assert.deepStrictEqual(booked, ["live1"], "a bare ticker with no price and no cap took a public board slot");
  } finally {
    api.getListings = realGet;
    market.fetchMarket = realFetch;
    api.bookTrending = realBook;
    await autoTrend.reset();
  }
});

test("…but on a chain NOTHING can price, the unpriced still go on", async () => {
  // The exemption's original reason, unchanged: judging a chain no indexer
  // covers by a number nobody can read means never filling it at all.
  const api = require("../src/api/dexvra");
  const market = require("../src/marketdata");
  const realGet = api.getListings;
  const realFetch = market.fetchMarket;
  const realBook = api.bookTrending;
  api.getListings = async () => [
    { status: "approved", chain: "robinhood", address: "d1", sym: "ONE", trendingRank: null },
    { status: "approved", chain: "robinhood", address: "d2", sym: "TWO", trendingRank: null },
  ];
  market.fetchMarket = async () => null;
  const booked = [];
  api.bookTrending = async (_c, address) => {
    booked.push(address);
    return {};
  };
  try {
    await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, chains: ["robinhood"], perChainMin: 1, perChainMax: 1, minGainPct: 5, fillFromMarket: false });
    await autoTrend.runOnce({ rng: () => 0.5, deps: { fillChain: async () => ({ listed: [] }) } });
    assert.strictEqual(booked.length, 1, "a chain no indexer covers must still fill");
  } finally {
    api.getListings = realGet;
    market.fetchMarket = realFetch;
    api.bookTrending = realBook;
    await autoTrend.reset();
  }
});

// ── The MINIMUM outranks the gain floor ─────────────────────────────────────
//
// "trending untuk token base dan eth sangat sedikit dari minimal", with a panel
// showing Ethereum 3/5–8 and Base 3/5–8 and `min +5% 24h` set. Every spare
// listing on those chains was down a percent or two, so nothing was promoted and
// the board simply stayed short — the operator had to tap ⚡ Run now (which
// ignores the floor) to get a token on, which is what gave it away.

test("below the minimum, the best candidates go on even when they are DOWN", async () => {
  const api = require("../src/api/dexvra");
  const market = require("../src/marketdata");
  const realGet = api.getListings;
  const realFetch = market.fetchMarket;
  const realBook = api.bookTrending;
  const now = Date.now();
  const gains = { e1: -0.4, e2: -2.3, e3: -0.1, e4: -9 };
  const promoted = [];
  // Ethereum: 3 featured, four spares, all red. Floor is 5.
  api.getListings = async () => [
    ...["f1", "f2", "f3"].map((address, i) => ({ status: "approved", chain: "ethereum", address, trendingRank: i + 1, trendExp: now + 3.6e6 })),
    ...Object.keys(gains).map((address) => ({ status: "approved", chain: "ethereum", address, sym: address, trendingRank: null })),
  ];
  market.fetchMarket = async (_c, address) => ({ change24h: gains[address] });
  api.bookTrending = async (_c, address) => (promoted.push(address), {});
  try {
    await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, chains: ["ethereum"], perChainMin: 5, perChainMax: 8, minGainPct: 5, fillFromMarket: true });
    await autoTrend.runOnce({ rng: () => 0.999, deps: { fillChain: async () => ({ listed: [] }) } });
    // Exactly TWO — enough to reach the floor of 5, and no more: the rolled
    // target above the minimum is still the gain floor's to refuse.
    assert.strictEqual(promoted.length, 2, `reached the floor and stopped: ${promoted.join(",")}`);
    // …and it takes the BEST of the losers, not a random two.
    assert.deepStrictEqual(promoted.sort(), ["e1", "e3"], "the least-bad candidates are the ones that go on");
  } finally {
    api.getListings = realGet;
    market.fetchMarket = realFetch;
    api.bookTrending = realBook;
    await autoTrend.reset();
  }
});

test("at or above the minimum the gain floor still refuses — it only yields to the floor", async () => {
  const api = require("../src/api/dexvra");
  const market = require("../src/marketdata");
  const realGet = api.getListings;
  const realFetch = market.fetchMarket;
  const realBook = api.bookTrending;
  const now = Date.now();
  const promoted = [];
  // FIVE featured already (at the floor), spares all down: the board is where
  // the operator said it must be, so a token down 2% has not earned a slot.
  api.getListings = async () => [
    ...["f1", "f2", "f3", "f4", "f5"].map((address, i) => ({ status: "approved", chain: "ethereum", address, trendingRank: i + 1, trendExp: now + 3.6e6 })),
    { status: "approved", chain: "ethereum", address: "spare", sym: "SPARE", trendingRank: null },
  ];
  market.fetchMarket = async () => ({ change24h: -2 });
  api.bookTrending = async (_c, address) => (promoted.push(address), {});
  try {
    await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, chains: ["ethereum"], perChainMin: 5, perChainMax: 8, minGainPct: 5 });
    await autoTrend.runOnce({ rng: () => 0.999, deps: { fillChain: async () => ({ listed: [] }) } });
    assert.deepStrictEqual(promoted, [], "at the floor, a losing token must not be promoted to pad the board");
  } finally {
    api.getListings = realGet;
    market.fetchMarket = realFetch;
    api.bookTrending = realBook;
    await autoTrend.reset();
  }
});

test("a cycle that ends with a chain short RECORDS it — the operator is not the detector", async () => {
  // Three rounds of "trending sangat sedikit" were found by the operator
  // counting rows in the channel. The cycle now judges the board it just left
  // behind and pages when a chain stays under its minimum.
  const api = require("../src/api/dexvra");
  const { loadJSONSync } = require("../src/helpers/persist");
  const realGet = api.getListings;
  const now = Date.now();
  // Base: one featured, nothing spare, and the fill could not help.
  api.getListings = async () => [
    { status: "approved", chain: "base", address: "b1", trendingRank: 1, trendExp: now + 3.6e6 },
  ];
  try {
    await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, chains: ["base"], perChainMin: 5, perChainMax: 5, fillFromMarket: true });
    await autoTrend.runOnce({
      rng: () => 0.5,
      deps: { fillChain: async () => ({ listed: [], why: "every big token on base is already listed" }) },
    });
    const st = loadJSONSync("autoTrendState.json", {});
    assert.ok(st.boardWatch && st.boardWatch.base, `the shortfall was not recorded: ${JSON.stringify(st.boardWatch)}`);
    assert.ok(st.boardWatch.base.since > 0, "no clock on it, so 'for how long' can never be answered");
    // The reason the FILLER gave is what reaches the operator — "short" alone
    // sends them back into the three-round investigation.
    assert.strictEqual(st.boardWatch.base.why, "fill_failed", JSON.stringify(st.boardWatch.base));
  } finally {
    api.getListings = realGet;
    await autoTrend.reset();
  }
});
