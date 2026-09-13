// EVERY TRENDING ROW CARRIES A PERCENTAGE.
//
// Reported from the live board with a screenshot: `$MOONCOIN | 12,220,809$`,
// `$RLUSD | 53,093,333$` and a bare `$BISKIT`, sitting on a pinned post 10,593
// people read — "beberapa token di trending channel mengapa tidak ada kenaikan
// atau penurunan %".
//
// The answer is NOT a printed 0%: an unreadable change is not a zero, and this
// repo has refused to invent one since the board published +521366% for BONK.
// It is four layers, and each closes a hole the others cannot:
//
//   1. marketdata computes the change from the pool's own candles when every
//      published reading is empty — a measurement, not a fabrication
//   2. autoTrend will not book a slot for a token with no reading
//   3. trendFill will not LIST one into a slot either
//   4. the board fills the percentage column with a marked "—" rather than
//      dropping the segment, so the only rows that can reach it are paid ones
//
// No network: every upstream is stubbed.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-pct-"));

const test = require("node:test");
const assert = require("node:assert");

const market = require("../src/marketdata");
const api = require("../src/api/dexvra");
const autoTrend = require("../src/services/autoTrend");
const trendFill = require("../src/services/trendFill");
const poster = require("../src/services/trendingPoster");
const tb = require("../src/services/trendingBoard");

const HOUR = 3600;
/** A GT ohlcv_list, newest first: [ts, o, h, l, close, vol]. */
const candles = (rows) => ({
  data: { attributes: { ohlcv_list: rows.map(([t, c]) => [t, c, c, c, c, 1]) } },
});
/** A GT token payload with ONE pool and no 24h reading on it — the shape that
 *  put a cap on the board with nothing beside it. */
const gtTokenNoChange = (mcap = 12_220_809) => ({
  data: {
    attributes: { price_usd: "0.5", market_cap_usd: String(mcap) },
    relationships: { top_pools: { data: [{ id: "robinhood_POOL" }] } },
  },
  included: [
    {
      id: "robinhood_POOL",
      attributes: { address: "POOL", reserve_in_usd: "400000", price_change_percentage: { h24: null } },
    },
  ],
});

/** Router over global.fetch. `null` → 404, a string reason → transport failure. */
function stubFetch(router) {
  const orig = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    const body = router(u);
    if (body === null) return { ok: false, status: 404, json: async () => ({}) };
    if (typeof body === "string") throw new Error(body);
    return { ok: true, status: 200, json: async () => body };
  };
  return { seen, restore: () => (global.fetch = orig) };
}

// ── 1. the candle recovery ───────────────────────────────────────────────────

test("a pool with no published 24h reading is MEASURED from its own candles", async () => {
  market._resetCandleCache();
  const now = Date.now();
  const t = Math.floor(now / 1000);
  const f = stubFetch((u) => {
    if (u.includes("/ohlcv/")) {
      // 1.00 → 1.25 across the day: +25%. The candles deliberately do NOT line
      // up on 24 neat hours, because a sparse pool's never do — the two closes
      // are picked by TIMESTAMP, and picking by position would read the wrong
      // one here.
      return candles([
        [t - 1 * HOUR, 1.25],
        [t - 9 * HOUR, 1.1],
        [t - 26 * HOUR, 1.0],
        [t - 47 * HOUR, 0.4],
      ]);
    }
    if (u.includes("geckoterminal") || u.includes("onchain")) return gtTokenNoChange();
    return null; // DexScreener does not index Robinhood
  });
  try {
    const m = await market.fetchMarket("robinhood", "MOONCOIN");
    assert.ok(m, "the token still prices");
    assert.ok(Math.abs(m.change24h - 25) < 1e-9, `expected +25%, got ${m.change24h}`);
    assert.strictEqual(m.changeFrom, "candles", "provenance is recorded — this one we computed");
    assert.strictEqual(m.changeWhy, null, "and there is nothing left to explain");
    assert.strictEqual(m.mcap, 12_220_809, "the rest of the reading is untouched");
  } finally {
    f.restore();
  }
});

test("the candles are asked for OUR token, not the pool's base side", async () => {
  // GT's OHLCV defaults to the pool's base token. In a WETH/OURTOKEN pool that
  // is WETH — the board would have published Ethereum's 24h change under a
  // memecoin's ticker, which is a wrong number rather than a missing one.
  market._resetCandleCache();
  const t = Math.floor(Date.now() / 1000);
  let asked = null;
  const f = stubFetch((u) => {
    if (u.includes("/ohlcv/")) return (asked = u), candles([[t - HOUR, 2], [t - 30 * HOUR, 1]]);
    if (u.includes("geckoterminal") || u.includes("onchain")) return gtTokenNoChange();
    return null;
  });
  try {
    await market.fetchMarket("robinhood", "0xOURTOKEN");
    assert.ok(asked, "the candle endpoint was asked");
    assert.match(asked, /token=0xOURTOKEN/, `the base side was assumed: ${asked}`);
    assert.match(asked, /\/pools\/POOL\/ohlcv\/hour/, "…on the deepest pool");
  } finally {
    f.restore();
  }
});

test("a pool younger than a day is left unmeasured — that is where +521366% comes from", async () => {
  market._resetCandleCache();
  const t = Math.floor(Date.now() / 1000);
  const f = stubFetch((u) => {
    if (u.includes("/ohlcv/")) return candles([[t - 1 * HOUR, 5], [t - 5 * HOUR, 0.0001]]);
    if (u.includes("geckoterminal") || u.includes("onchain")) return gtTokenNoChange();
    return null;
  });
  try {
    const m = await market.fetchMarket("robinhood", "FRESH");
    assert.strictEqual(m.change24h, null, "no candle before the boundary → no 24h change");
    assert.match(m.changeWhy, /under 24h of history/);
  } finally {
    f.restore();
  }
});

test("a pool that has not traded in 24h measures 0.00% — arrived at, never assumed", async () => {
  market._resetCandleCache();
  const t = Math.floor(Date.now() / 1000);
  const f = stubFetch((u) => {
    // Last trade 30h ago. Both ends of the window resolve to the same close, so
    // the price genuinely has not moved. That is a fact about the pool, which
    // is the whole difference between this and printing a 0% for a blank.
    if (u.includes("/ohlcv/")) return candles([[t - 30 * HOUR, 2], [t - 40 * HOUR, 1]]);
    if (u.includes("geckoterminal") || u.includes("onchain")) return gtTokenNoChange();
    return null;
  });
  try {
    const m = await market.fetchMarket("robinhood", "QUIET");
    assert.strictEqual(m.change24h, 0);
    assert.strictEqual(m.changeFrom, "candles");
  } finally {
    f.restore();
  }
});

test("an absurd computed change is refused, exactly like a published one", async () => {
  market._resetCandleCache();
  const t = Math.floor(Date.now() / 1000);
  const f = stubFetch((u) => {
    if (u.includes("/ohlcv/")) return candles([[t - HOUR, 5000], [t - 30 * HOUR, 0.0001]]);
    if (u.includes("geckoterminal") || u.includes("onchain")) return gtTokenNoChange();
    return null;
  });
  try {
    const m = await market.fetchMarket("robinhood", "BROKEN");
    assert.strictEqual(m.change24h, null);
    assert.match(m.changeWhy, /refused as broken/);
  } finally {
    f.restore();
  }
});

test("a FAILED candle read is not cached — a 2-minute backoff must not blank the board for ten", async () => {
  market._resetCandleCache();
  const t = Math.floor(Date.now() / 1000);
  let candleCalls = 0;
  let dead = true;
  const f = stubFetch((u) => {
    if (u.includes("/ohlcv/")) {
      candleCalls++;
      if (dead) return "fetch failed";
      return candles([[t - HOUR, 2], [t - 30 * HOUR, 1]]);
    }
    if (u.includes("geckoterminal") || u.includes("onchain")) return gtTokenNoChange();
    return null;
  });
  try {
    const first = await market.fetchMarket("robinhood", "FLAKY");
    assert.strictEqual(first.change24h, null);
    assert.match(first.changeWhy, /could not read the pool's candles/);
    dead = false;
    const second = await market.fetchMarket("robinhood", "FLAKY");
    assert.strictEqual(candleCalls, 2, "the transport failure was re-asked, not remembered");
    assert.strictEqual(second.change24h, 100, "and the recovery lands as soon as GT answers");
  } finally {
    f.restore();
  }
});

test("a 404 IS cached — GT answered, and it will answer the same in ten minutes", async () => {
  // `poolAddress` can legitimately be a DexScreener pair address GT has never
  // heard of. An HTTP status means the host was there and answered; re-asking
  // it every cycle is the latency of a request that was always going to fail.
  market._resetCandleCache();
  let candleCalls = 0;
  const f = stubFetch((u) => {
    if (u.includes("/ohlcv/")) return candleCalls++, null;
    if (u.includes("geckoterminal") || u.includes("onchain")) return gtTokenNoChange();
    return null;
  });
  try {
    await market.fetchMarket("robinhood", "GHOST");
    const second = await market.fetchMarket("robinhood", "GHOST");
    assert.strictEqual(candleCalls, 1);
    assert.strictEqual(second.change24h, null);
  } finally {
    f.restore();
  }
});

test("a definitive miss IS cached — an unreadable token must not buy a request every cycle", async () => {
  market._resetCandleCache();
  const t = Math.floor(Date.now() / 1000);
  let candleCalls = 0;
  const f = stubFetch((u) => {
    if (u.includes("/ohlcv/")) return candleCalls++, candles([[t - HOUR, 5]]);
    if (u.includes("geckoterminal") || u.includes("onchain")) return gtTokenNoChange();
    return null;
  });
  try {
    await market.fetchMarket("robinhood", "YOUNG");
    await market.fetchMarket("robinhood", "YOUNG");
    assert.strictEqual(candleCalls, 1, "the pool's lack of history does not change in ten minutes");
  } finally {
    f.restore();
  }
});

test("a token the indexer already read pays nothing — the recovery is a LAST resort", async () => {
  market._resetCandleCache();
  const f = stubFetch((u) => {
    if (u.includes("/ohlcv/")) throw new Error("the candle endpoint must not be asked");
    if (u.includes("geckoterminal") || u.includes("onchain")) {
      const j = gtTokenNoChange();
      j.included[0].attributes.price_change_percentage = { h24: "3.5" };
      return j;
    }
    return null;
  });
  try {
    const m = await market.fetchMarket("robinhood", "FINE");
    assert.strictEqual(m.change24h, 3.5);
    assert.strictEqual(m.changeFrom, undefined, "published readings carry no provenance mark");
    assert.ok(!f.seen.some((u) => u.includes("/ohlcv/")), "no candle request was made");
  } finally {
    f.restore();
  }
});

// ── 2. the promoter ──────────────────────────────────────────────────────────

/** Drive one auto-trend pass over `rows` with `gains` as the market. */
async function promoteWith(rows, reading) {
  const real = market.fetchMarket;
  market.fetchMarket = async (_chain, address) => reading(address);
  api.getListings = async () => rows;
  const booked = [];
  api.bookTrending = async (chain, address) => booked.push(address);
  try {
    await autoTrend.runOnce({ rng: () => 0.5 });
  } finally {
    market.fetchMarket = real;
  }
  return booked;
}

const listing = (address) => ({ status: "approved", chain: "solana", address, sym: address, trendingRank: null });

test("a token with no 24h reading is NOT promoted while the chain has tokens that do", async () => {
  await autoTrend.reset();
  await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, chains: ["solana"], perChainMin: 3, perChainMax: 3, announce: false, fillFromMarket: false });
  const booked = await promoteWith(
    [listing("up"), listing("flat"), listing("blank"), listing("down")],
    (a) => (a === "blank" ? { priceUsd: 1, mcap: 5e6, change24h: null } : { priceUsd: 1, mcap: 5e6, change24h: { up: 20, flat: 1, down: -3 }[a] }),
  );
  assert.ok(!booked.includes("blank"), `a blank row was booked anyway: ${booked.join(",")}`);
  assert.deepStrictEqual(booked.sort(), ["down", "flat", "up"], "the three readable ones fill the chain");
});

test("…but where NOTHING on the chain has a reading, they still go on", async () => {
  // The Robinhood exemption, unchanged and exactly as narrow as it always was:
  // a chain no indexer covers would otherwise never fill, and a short board on
  // it helps nobody.
  await autoTrend.reset();
  await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, chains: ["solana"], perChainMin: 2, perChainMax: 2, announce: false, fillFromMarket: false });
  const booked = await promoteWith([listing("a"), listing("b")], () => ({ priceUsd: 1, mcap: 5e6, change24h: null }));
  assert.deepStrictEqual(booked.sort(), ["a", "b"]);
});

test("the FLOOR fill honours the reading rule too — or the rule is decorative", async () => {
  // `minGainPct` refuses everything here, so every pick comes from the floor
  // fill below it. That is the door the free-fall bound was once missing from.
  await autoTrend.reset();
  await autoTrend.set({
    enabled: true, chains: ["solana"], perChainMin: 2, perChainMax: 2,
    // Stated, not inherited: this test is about the READING rule, and the
    // quality floors would refuse every fixture here for publishing no volume.
    minMcapUsd: 0, minVol24hUsd: 0,
    minGainPct: 50, announce: false, fillFromMarket: false,
  });
  const booked = await promoteWith(
    [listing("mild"), listing("blank"), listing("mild2")],
    (a) => (a === "blank" ? { priceUsd: 1, mcap: 5e6, change24h: null } : { priceUsd: 1, mcap: 5e6, change24h: -2 }),
  );
  assert.ok(!booked.includes("blank"), `the floor fill booked a blank row: ${booked.join(",")}`);
  assert.deepStrictEqual(booked.sort(), ["mild", "mild2"]);
});

// ── 3. the market filler ─────────────────────────────────────────────────────

const bigCoin = (symbol, change24h) => ({
  chain: "base", address: `0x${symbol}`, symbol, name: `${symbol} Token`, mcap: 2e7, liq: 5e5, change24h,
});

test("the filler will not LIST a token with no 24h reading into a board slot", async () => {
  const made = [];
  const res = await trendFill.fillChain("base", 2, {
    deps: {
      topByMcap: async () => ({ ok: true, items: [bigCoin("BLANK", null), bigCoin("REAL", 4), bigCoin("REAL2", 2)] }),
      fetchTokenInfo: async () => null,
      getListings: async () => [],
      wasEverListed: () => false,
      createFromInfo: async (chain, address, merged) => (made.push(merged.symbol), { input: { sym: merged.symbol, tier: null } }),
    },
  });
  assert.deepStrictEqual(made, ["REAL", "REAL2"], "the unreadable candidate was skipped");
  assert.strictEqual(res.listed.length, 2);
});

test("…and where no big token on the chain has a reading, it fills anyway", async () => {
  const made = [];
  await trendFill.fillChain("base", 1, {
    deps: {
      topByMcap: async () => ({ ok: true, items: [bigCoin("NOIDX", null)] }),
      fetchTokenInfo: async () => null,
      getListings: async () => [],
      wasEverListed: () => false,
      createFromInfo: async (chain, address, merged) => (made.push(merged.symbol), { input: { sym: merged.symbol, tier: null } }),
    },
  });
  assert.deepStrictEqual(made, ["NOIDX"]);
});

test("a chain whose only candidates are unreadable SAYS so, rather than 'already listed'", async () => {
  const res = await trendFill.fillChain("base", 1, {
    deps: {
      topByMcap: async () => ({ ok: true, items: [bigCoin("BLANK", null), bigCoin("REAL", 4)] }),
      fetchTokenInfo: async () => null,
      getListings: async () => [{ chain: "base", address: "0xREAL" }],
      wasEverListed: () => false,
      createFromInfo: async () => null,
    },
  });
  assert.match(res.why, /no 24h reading/);
});

// ── 4. the board ─────────────────────────────────────────────────────────────

async function boardWith(reading) {
  const real = market.fetchMarket;
  market.fetchMarket = async (_chain, address) => reading(address);
  poster._resetState();
  try {
    return await poster.buildText();
  } finally {
    market.fetchMarket = real;
  }
}

test("the percentage column is never left EMPTY — the segment used to just drop", async () => {
  api.getListings = async () => [
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "moon", sym: "MOONCOIN" },
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "pepe", sym: "PEPE" },
  ];
  const text = await boardWith((a) => (a === "moon" ? { mcap: 12_220_809, change24h: null } : { mcap: 1e9, change24h: 1.23 }));
  const moon = text.split("\n").find((l) => l.includes("$MOONCOIN"));
  const pepe = text.split("\n").find((l) => l.includes("$PEPE"));
  assert.ok(moon.includes("—"), `the row still publishes bare: ${moon}`);
  assert.ok(moon.includes("12,220,809$"), "and keeps the cap it does have");
  assert.ok(pepe.includes("+1.23%"), "a readable row is unchanged");
  assert.ok(!pepe.includes("—"), "and carries no marker");
  assert.ok(text.includes("— = no 24h reading"), "the legend explains the marker");
});

test("the legend is printed ONLY when something on the board needs it", async () => {
  api.getListings = async () => [
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "pepe", sym: "PEPE" },
  ];
  const text = await boardWith(() => ({ mcap: 1e9, change24h: 4.5 }));
  assert.ok(text.includes("+4.50%"));
  assert.ok(!text.includes("no 24h reading"), "a legend for a mark that is not there sends the reader hunting");
});

test("an absurd percentage still reaches the column as the marker, never as a number", async () => {
  // The last line of defence before a pinned public board. It refused to print
  // +521366% before this change and dropped the segment; now it says why.
  api.getListings = async () => [
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "bonk", sym: "BONK" },
  ];
  const text = await boardWith(() => ({ mcap: 2.5e8, change24h: 521366 }));
  const row = text.split("\n").find((l) => l.includes("$BONK"));
  assert.ok(!row.includes("521366"), `an absurd reading reached the board: ${row}`);
  assert.ok(row.includes("—"));
});

test("the board asks the market MODULE, so the source stays stubbable", async () => {
  // A captured `const { fetchMarket } = require(...)` cannot be swapped, which
  // is why no test could pin what this file renders for a missing reading — the
  // exact defect being fixed. autoTrend.js states the same rule at its require.
  const src = fss.readFileSync(require.resolve("../src/services/trendingPoster"), "utf8");
  assert.ok(!/const\s*\{[^}]*fetchMarket[^}]*\}\s*=\s*require/.test(src), "destructured again");
  await tb.reset();
});

// ── 5. so it cannot happen again quietly ─────────────────────────────────────
//
// The four layers above fix the CAUSES. What stops the next one is that a board
// publishing dashes can no longer go unnoticed — in all three rounds of this
// the OPERATOR was the detector: they read the pinned channel, saw a row with
// no number, and asked. Exactly the shape `trendingWatch.evaluate` already
// exists for one symptom over.

const watch = require("../src/services/trendingWatch");

test("the board RECORDS every row it drew, with the reason a percentage is missing", async () => {
  api.getListings = async () => [
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "moon", sym: "MOONCOIN" },
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "pepe", sym: "PEPE" },
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "ghost", sym: "BISKIT" },
  ];
  await boardWith((a) =>
    a === "pepe"
      ? { mcap: 1e9, change24h: 1.23 }
      : a === "moon"
        ? { mcap: 12_220_809, change24h: null, changeWhy: "pools have no 24h reading (no trades in the window)" }
        : null,
  );
  const rec = poster.lastRender();
  assert.strictEqual(rec.rows, 3, "every row is counted, not just the blank ones");
  assert.deepStrictEqual(rec.blank.map((b) => b.sym).sort(), ["BISKIT", "MOONCOIN"]);
  const moon = rec.blank.find((b) => b.sym === "MOONCOIN");
  assert.match(moon.why, /no trades in the window/, "the recorded reason survives to the operator");
  const biskit = rec.blank.find((b) => b.sym === "BISKIT");
  assert.match(biskit.why, /no market anywhere/, "…and 'no market at all' stays a different fact");
});

test("the watch alerts on the TRANSITION, after a grace period — not every cycle", () => {
  const t0 = 1_700_000_000_000;
  const opts = { graceMs: 45 * 60_000, repeatMs: 12 * 3600_000 };
  const render = { rows: 27, blank: [{ chain: "robinhood", sym: "MOONCOIN", why: "pools have no 24h reading" }] };

  // One cycle blank is a slot rolling over, not an incident.
  let r = watch.evaluateRows(render, {}, { ...opts, now: t0 });
  assert.deepStrictEqual(r.alerts, [], "no alert inside the grace period");
  assert.strictEqual(r.state.since, t0, "…but the clock started");

  r = watch.evaluateRows(render, r.state, { ...opts, now: t0 + 50 * 60_000 });
  assert.strictEqual(r.alerts.length, 1, "past the grace period it is worth saying");
  assert.match(r.alerts[0].text, /1<\/b> of 27 row/);
  assert.match(r.alerts[0].text, /MOONCOIN/, "the message names the token");
  assert.match(r.alerts[0].text, /no 24h reading/, "…and which of the causes it is");

  // It does not repeat on the next cycle. A channel nobody reads by the second
  // hour is the failure mode upstreams.js had to learn first.
  const quiet = watch.evaluateRows(render, r.state, { ...opts, now: t0 + 55 * 60_000 });
  assert.deepStrictEqual(quiet.alerts, []);
  // …but it does repeat eventually: one message on day one is scrolled past by
  // day three.
  const again = watch.evaluateRows(render, r.state, { ...opts, now: t0 + 13 * 3600_000 });
  assert.strictEqual(again.alerts.length, 1);
});

test("a RECOVERY is an alert too — a fixed board and a forgotten one look identical", () => {
  const t0 = 1_700_000_000_000;
  const opts = { graceMs: 45 * 60_000, repeatMs: 12 * 3600_000 };
  const blank = { rows: 27, blank: [{ chain: "ethereum", sym: "RLUSD", why: "x" }] };
  let r = watch.evaluateRows(blank, {}, { ...opts, now: t0 });
  r = watch.evaluateRows(blank, r.state, { ...opts, now: t0 + 50 * 60_000 });
  assert.strictEqual(r.alerts.length, 1, "complained");
  const ok = watch.evaluateRows({ rows: 27, blank: [] }, r.state, { ...opts, now: t0 + 60 * 60_000 });
  assert.strictEqual(ok.alerts.length, 1);
  assert.match(ok.alerts[0].text, /carries a percentage again/);
  assert.deepStrictEqual(ok.state, {}, "a healthy board keeps no state");
});

test("…but a board that fixed itself before anyone was told says nothing", () => {
  const t0 = 1_700_000_000_000;
  const opts = { graceMs: 45 * 60_000, repeatMs: 12 * 3600_000 };
  const r = watch.evaluateRows({ rows: 9, blank: [{ chain: "base", sym: "X" }] }, {}, { ...opts, now: t0 });
  const ok = watch.evaluateRows({ rows: 9, blank: [] }, r.state, { ...opts, now: t0 + 60_000 });
  assert.deepStrictEqual(ok.alerts, [], "a recovery nobody was warned about is noise");
});

test("a long blank list is TRUNCATED — a 40-line alert is not read", () => {
  const blank = Array.from({ length: 11 }, (_, i) => ({ chain: "solana", sym: `T${i}`, why: "quiet pool" }));
  const t0 = 1_700_000_000_000;
  const opts = { graceMs: 1, repeatMs: 12 * 3600_000 };
  const r = watch.evaluateRows({ rows: 40, blank }, { since: t0 - 60_000 }, { ...opts, now: t0 });
  assert.match(r.alerts[0].text, /and 5 more/);
});

test("the watch runs BEFORE the 'unchanged' early return, or a stuck board reads as no symptom", async () => {
  // The board is edited in place and skipped when the text has not changed —
  // which is precisely the state a persistently blank board sits in. Folding
  // the watch in after that return would freeze it on the boards that stay
  // broken longest: the state that looks most like a healthy one.
  const realEval = watch.evaluateRows;
  const realFetch = market.fetchMarket;
  let evals = 0;
  watch.evaluateRows = (...a) => (evals++, realEval(...a));
  market.fetchMarket = async () => ({ mcap: 1e9, change24h: null });
  api.getListings = async () => [
    { status: "approved", trendingRank: 1, trendExp: 0, chain: "solana", address: "moon", sym: "MOONCOIN" },
  ];
  poster._resetState();
  const tg = {
    sendMessage: async () => ({ message_id: 7 }),
    editMessageText: async () => ({}),
    pinChatMessage: async () => ({}),
    deleteMessage: async () => ({}),
  };
  try {
    const first = await poster.runOnce(tg);
    const second = await poster.runOnce(tg);
    assert.strictEqual(second.how, "unchanged", `expected a skipped cycle, got ${second.how} (first: ${first.how})`);
    assert.strictEqual(evals, 2, "the cycle that published nothing still measured the board");
  } finally {
    watch.evaluateRows = realEval;
    market.fetchMarket = realFetch;
    poster._resetState();
  }
});

test("trending:check drives the RENDERER, never a second copy of its question", () => {
  // `fonts:check` printed nine green ticks over a banner publishing boxes
  // because it measured a font stack that renderer did not use. This check has
  // exactly that shape available to it: it used to call fetchMarket itself, so
  // any filter the poster applied was invisible to it.
  const src = fss.readFileSync(require.resolve("../scripts/trending-check.js"), "utf8");
  assert.match(src, /poster\.buildText\(\)/, "it must render the board it reports on");
  assert.match(src, /poster\.lastRender\(\)/, "…and read what that render actually drew");
  assert.ok(
    !/market\.fetchMarket\(/.test(src),
    "re-deriving the rows is how a green check over a broken board happens",
  );
  // Green has to mean "the board is safe", not "the counts add up".
  assert.match(src, /blankRows/, "a board of dashes must fail the check");
  assert.match(src, /process\.exit\(1\)/);
});
