// GeckoTerminal is a SHARED, per-IP allowance — and this process is not alone
// on the IP.
//
// The website (dexvra.io) runs on the same box, and its candlestick charts have
// exactly ONE free source of OHLCV: GeckoTerminal. A price and a market cap have
// two. So every read in this repo that needs only a price must take the source
// that costs none of that budget, and the budget this process paces itself
// against must leave the other half of the allowance alone.
//
// The live symptom that produced all of this: the site answered
// `Couldn't read the chart just now (GeckoTerminal 429)` while a bare `curl` to
// GeckoTerminal from the same box answered 429 too. Nothing was wrong with the
// chart — the bot had eaten the minute.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const market = require("../src/marketdata");
const gtPairs = require("../src/group/gtPairs");

const GT_BASE = gtPairs.GT_BASE;
const isGt = (url) => url.startsWith(GT_BASE) || url.includes("geckoterminal");
const isDs = (url) => url.includes("dexscreener");

const gtToken = (attrs, pools = []) =>
  JSON.stringify({
    data: { attributes: attrs, relationships: { top_pools: { data: pools.map((p) => ({ id: p.id })) } } },
    included: pools,
  });
const dsBody = (pairs) => JSON.stringify({ pairs });

/** Stub global.fetch and RECORD every url, so "was GeckoTerminal asked?" is a
 *  measurement rather than a reading of the code. */
function stubFetch(router) {
  const orig = global.fetch;
  const urls = [];
  global.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    const body = router(u);
    if (body === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  };
  return {
    urls,
    gt: () => urls.filter(isGt),
    ds: () => urls.filter(isDs),
    restore: () => (global.fetch = orig),
  };
}

const DS_FULL = dsBody([
  {
    chainId: "solana",
    priceUsd: "0.004",
    marketCap: 4_000_000,
    liquidity: { usd: 120_000 },
    pairAddress: "poolA",
    priceChange: { h24: 12.5 },
    baseToken: { name: "Risey", symbol: "RISE", address: "So1anaAddr111" },
    quoteToken: { symbol: "SOL", address: "So11111111111111111111111111111111111111112" },
  },
]);

// ── the cheap read ──────────────────────────────────────────────────────────

test("fetchPrice never touches GeckoTerminal when DexScreener has the price and cap", async () => {
  // The whole point. The pump checker prices EVERY approved listing every three
  // minutes; on the heavy read that was most of a 30/min ceiling by itself.
  const f = stubFetch((url) => (isDs(url) ? DS_FULL : null));
  try {
    const m = await market.fetchPrice("solana", "So1anaAddr111");
    assert.ok(m);
    assert.strictEqual(m.priceUsd, 0.004);
    assert.strictEqual(m.mcap, 4_000_000);
    assert.deepStrictEqual(f.gt(), [], "GeckoTerminal was not asked once");
    assert.strictEqual(f.ds().length, 1, "and DexScreener was asked exactly once");
  } finally {
    f.restore();
  }
});

test("…but it falls through to GeckoTerminal when DexScreener has nothing", async () => {
  // A fresh launch DexScreener has not indexed. GT is the only remaining
  // answer, and paying a request for it is right — the budget exists to be
  // spent where there is no alternative, not to be hoarded.
  const f = stubFetch((url) => {
    if (isGt(url)) return gtToken({ price_usd: "0.0042", market_cap_usd: "88000" });
    return null; // DexScreener 404s
  });
  try {
    const m = await market.fetchPrice("solana", "So1anaAddr111");
    assert.ok(m);
    assert.strictEqual(m.priceUsd, 0.0042);
    assert.ok(f.gt().length >= 1, "GeckoTerminal was asked, because nothing else could answer");
  } finally {
    f.restore();
  }
});

test("⚠️ a DexScreener MISS is reused, not re-asked", async () => {
  // `dsFirst || await fetchDS(...)` re-asks on every miss, because a miss is
  // null — which would make the cheap read cost two requests instead of one and
  // double the load on the source it exists to prefer.
  const f = stubFetch((url) => {
    if (isGt(url)) return gtToken({ price_usd: "1", market_cap_usd: "2" });
    return null;
  });
  try {
    await market.fetchPrice("solana", "So1anaAddr111");
    assert.strictEqual(f.ds().length, 1, "DexScreener asked once, not once per pass");
  } finally {
    f.restore();
  }
});

test("⚠️ the cheap read never buys CANDLES — the very endpoint the charts queue for", async () => {
  // A cheap read that gets its price from DexScreener and its cap from GT lands
  // one line above `changeFromCandles`, which is an OHLCV call — the single most
  // expensive request in this file, made for a 24h change the caller does not
  // read. Opting out of GeckoTerminal for a price must not opt back in for this.
  market._resetCandleCache();
  const f = stubFetch((url) => {
    if (isDs(url))
      return dsBody([
        {
          chainId: "solana",
          priceUsd: "0.004",
          liquidity: { usd: 120_000 },
          pairAddress: "poolA",
          baseToken: { name: "Risey", symbol: "RISE", address: "So1anaAddr111" },
        },
      ]); // a price, no market cap → GT is reached for the cap
    if (isGt(url)) return gtToken({ price_usd: "0.004", market_cap_usd: "4000000" });
    return null;
  });
  try {
    const m = await market.fetchPrice("solana", "So1anaAddr111");
    assert.ok(m);
    assert.strictEqual(m.mcap, 4_000_000, "the cap came from GT, which is the case under test");
    assert.deepStrictEqual(
      f.gt().filter((u) => u.includes("/ohlcv/")),
      [],
      "and not one candle request went out",
    );
  } finally {
    f.restore();
  }
});

test("…while the heavy read still measures a missing change from candles", async () => {
  // The rule this repo pays for in the other direction: every trending row
  // carries a percentage. Opting the cheap read out must not disarm it.
  market._resetCandleCache();
  const f = stubFetch((url) => {
    if (url.includes("/ohlcv/"))
      return JSON.stringify({
        data: {
          attributes: {
            ohlcv_list: [
              [Math.floor(Date.now() / 1000), 0, 0, 0, "2"],
              [Math.floor(Date.now() / 1000) - 90000, 0, 0, 0, "1"],
            ],
          },
        },
      });
    if (isGt(url))
      return gtToken({ price_usd: "2", market_cap_usd: "4000000" }, [
        { id: "solana_poolA", attributes: { address: "poolA", reserve_in_usd: "120000" } },
      ]);
    return null;
  });
  try {
    const m = await market.fetchMarket("solana", "So1anaAddr111");
    assert.ok(m);
    assert.strictEqual(m.changeFrom, "candles");
    assert.strictEqual(Math.round(m.change24h), 100);
  } finally {
    f.restore();
  }
});

test("a GT-primary chain still goes straight to GeckoTerminal", async () => {
  // Plasma has no DexScreener index, so preferring DS there would be a request
  // that can never answer, ahead of the one that can. (Robinhood carried this
  // test until DexScreener added the chain ~July 2026 — it is DS-first now.)
  const f = stubFetch((url) => (isGt(url) ? gtToken({ price_usd: "0.5", market_cap_usd: "1000000" }) : null));
  try {
    const m = await market.fetchPrice("plasma", "0xabc");
    assert.ok(m);
    assert.strictEqual(m.priceUsd, 0.5);
    assert.ok(f.gt().length >= 1);
  } finally {
    f.restore();
  }
});

test("fetchMarket is UNCHANGED — the heavy read is still GeckoTerminal-first", async () => {
  // The 24h change, the liquidity, the pool address and the logo are what the
  // trending board and the listing cards publish, and GT is the better source
  // for all of them. Only a caller that throws the rest away opts out.
  const f = stubFetch((url) => {
    if (isGt(url))
      return gtToken(
        { price_usd: "0.004", market_cap_usd: "4000000", image_url: "https://img/x.png" },
        [
          {
            id: "solana_poolA",
            attributes: { address: "poolA", reserve_in_usd: "120000", price_change_percentage: { h24: "9.5" } },
          },
        ],
      );
    return DS_FULL;
  });
  try {
    const m = await market.fetchMarket("solana", "So1anaAddr111");
    assert.ok(m);
    assert.strictEqual(m.change24h, 9.5, "GT's reading, not DexScreener's");
    assert.deepStrictEqual(f.ds(), [], "and DexScreener is never asked when GT answered in full");
  } finally {
    f.restore();
  }
});

test("the pump checker reads the CHEAP source, and nothing re-derives the heavy one", () => {
  // A source guard because the loop is a timer with network in it: driving it
  // would mean standing up listings, channels and a Telegram stub to assert one
  // require. What must not come back is `fetchMarket` on this path.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "pumpChecker.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /require\("\.\.\/marketdata"\)/);
  assert.match(code, /fetchPrice\(r\.chain, r\.address\)/);
  assert.ok(!/fetchMarket/.test(code), "the heavy read is gone from the biggest consumer of the budget");
});

// ── the buy bot's pool snapshot ─────────────────────────────────────────────

test("fetchPool asks DexScreener first where DexScreener indexes the chain", async () => {
  // Detection comes off the chain now (group/chainTrades.js), so what is left
  // here is decoration on an alert — price, cap, liquidity, the two sides — and
  // every one of those has a second source that costs no GT quota.
  gtPairs._reset();
  const f = stubFetch((url) => (isDs(url) ? DS_FULL : null));
  try {
    const p = await gtPairs.fetchPool("solana", "So1anaAddr111");
    assert.ok(p);
    assert.strictEqual(p.source, "ds");
    assert.strictEqual(p.priceUsd, 0.004);
    assert.deepStrictEqual(f.gt(), [], "GeckoTerminal was not asked");
  } finally {
    f.restore();
  }
});

test("…and GeckoTerminal is still the only source for a GT-primary chain", async () => {
  gtPairs._reset();
  const f = stubFetch((url) =>
    isGt(url)
      ? JSON.stringify({
          data: [{ attributes: { address: "poolR", reserve_in_usd: "50000", base_token_price_usd: "0.5" }, relationships: {} }],
        })
      : null,
  );
  try {
    const p = await gtPairs.fetchPool("plasma", "0xabc");
    assert.ok(p);
    assert.strictEqual(p.source, "gt");
    assert.deepStrictEqual(f.ds(), [], "DexScreener does not index Plasma — asking is a wasted round trip");
  } finally {
    f.restore();
  }
});

test("⚠️ a priceless DexScreener pair is still an answer, once GeckoTerminal has also come up empty", async () => {
  // It carries the pool address, the ticker and the counter side, which is what
  // a self-heal is after. Dropping it would send the caller back to GT on the
  // next poll for something we already had.
  gtPairs._reset();
  const f = stubFetch((url) =>
    isDs(url)
      ? dsBody([
          {
            chainId: "solana",
            pairAddress: "poolA",
            baseToken: { name: "Risey", symbol: "RISE", address: "So1anaAddr111" },
            quoteToken: { symbol: "SOL", address: "So11111111111111111111111111111111111111112" },
          },
        ])
      : null,
  );
  try {
    const p = await gtPairs.fetchPool("solana", "So1anaAddr111");
    assert.ok(p, "not null");
    assert.strictEqual(p.poolAddress, "poolA");
    assert.strictEqual(p.symbol, "RISE");
    assert.ok(f.gt().length >= 1, "GT was given its turn first, because DexScreener had no price");
  } finally {
    f.restore();
  }
});

// ── the budget is a SPLIT ───────────────────────────────────────────────────

test("⚠️ the keyless budget leaves the website its half of the IP's allowance", () => {
  // It used to be 25 against a ~30/min ceiling — "comfortably under", and true
  // while this process was the only thing on the box. The web app is the other
  // half now, and its charts have no second source to fall back on.
  //
  // Tested through the pure function because the runner pins GT_MAX_RPM in the
  // environment, so the default cannot be observed from inside the suite at all.
  const ceiling = gtPairs.GT_FREE_CEILING_RPM;
  assert.ok(ceiling > 0);
  assert.ok(
    gtPairs.defaultRpm(false) <= ceiling / 2,
    `keyless default ${gtPairs.defaultRpm(false)} must not exceed half of ${ceiling}/min`,
  );
  assert.ok(gtPairs.defaultRpm(true) > ceiling, "a key raises the real limit far past the free ceiling");
});

test("the boot line says which tier and budget, and never the key", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "group", "gtPairs.js"), "utf8");
  const banner = src.slice(src.indexOf("function gtBanner"), src.indexOf("// ── Shared rate-limit cooldown"));
  assert.match(banner, /budget \$\{GT_RPM\}/);
  assert.ok(!/\$\{GT_KEY\}/.test(banner), "the key would land in pm2's log");
  const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.match(main, /gtBanner\(\)/, "and it is printed at boot, not on first use");
});
