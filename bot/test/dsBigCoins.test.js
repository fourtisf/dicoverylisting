// The DexScreener seeding source. "add pakai api dexscrener aja" — GT's free
// ~30/min ceiling is shared with the running bot, and one seeding run spent
// twelve minutes on one chain waiting out 429s that also paused every group's
// buy alerts.
//
// The thing to pin is that this API CANNOT be asked the question GT answers
// (`dexscreener.js` says so at its own top: no "every token above $X on chain
// Y" endpoint), so it asks two it can — a search per quote token, and the
// discovery feeds priced in batches — and everything below is a way that
// substitution could quietly go wrong: answers from other chains leaking in,
// the money being listed as a project, a failed query reading as an empty
// chain.
const test = require("node:test");
const assert = require("node:assert");
const ds = require("../src/services/dsBigCoins");

const pair = (over = {}) => ({
  chainId: "bsc",
  baseToken: { address: `0x${String(over.n || 1).padStart(40, "b")}`, symbol: `T${over.n || 1}`, name: `Token ${over.n || 1}` },
  quoteToken: { symbol: "WBNB" },
  priceUsd: "1.5",
  marketCap: 5_000_000,
  liquidity: { usd: 200_000 },
  volume: { h24: 90_000 },
  priceChange: { h24: 4.2 },
  info: { imageUrl: "https://img/x.png", socials: [{ type: "twitter", url: "https://x.com/t" }], websites: [{ url: "https://t.io" }] },
  ...over,
});

/** Stub global.fetch with a url → payload router. */
function stubFetch(route) {
  const seen = [];
  const real = global.fetch;
  global.fetch = async (url) => {
    seen.push(String(url));
    const r = route(String(url));
    if (r === undefined) return { ok: false, status: 404, async json() { return {}; } };
    if (r instanceof Error) throw r;
    return { ok: true, status: 200, async json() { return r; } };
  };
  return { seen, restore: () => { global.fetch = real; } };
}

test("it searches the chain's own quote tokens, and keeps only that chain", async () => {
  const f = stubFetch((url) =>
    url.includes("/search")
      ? { pairs: [pair({ n: 1 }), pair({ n: 2, chainId: "ethereum" }), pair({ n: 3 })] }
      : [],
  );
  try {
    const r = await ds.topByMcap("bsc", { feeds: false });
    assert.strictEqual(r.ok, true);
    // Search answers across EVERY chain — an unfiltered merge would list an
    // Ethereum token on BSC, which is the wrong-chain defect this repo has
    // paid for in the price path already.
    assert.deepStrictEqual(r.items.map((i) => i.symbol).sort(), ["T1", "T3"]);
    const queries = f.seen.filter((u) => u.includes("/search"));
    assert.strictEqual(queries.length, ds.queriesFor("bsc").length);
    assert.ok(queries.some((u) => /q=WBNB/.test(u)), "the native wrapper is the query most pairs are quoted in");
  } finally {
    f.restore();
  }
});

test("the money is not a project — stables and wrappers never fill a chain", async () => {
  const f = stubFetch((url) =>
    url.includes("/search")
      ? {
          pairs: [
            pair({ n: 1, baseToken: { address: "0xw", symbol: "WETH", name: "Wrapped Ether" }, marketCap: 9e11 }),
            pair({ n: 2, baseToken: { address: "0xu", symbol: "USDC", name: "USD Coin" }, marketCap: 6e10 }),
            pair({ n: 3, baseToken: { address: "0xs", symbol: "STETH", name: "Staked Ether" }, marketCap: 3e10 }),
            pair({ n: 4, baseToken: { address: "0xr", symbol: "REAL", name: "Real Project" } }),
          ],
        }
      : [],
  );
  try {
    const r = await ds.topByMcap("bsc", { feeds: false });
    // They have the biggest caps on every chain, so without this the top of a
    // board reads WETH · USDC · USDT.
    assert.deepStrictEqual(r.items.map((i) => i.symbol), ["REAL"]);
  } finally {
    f.restore();
  }
});

test("one token, many pools → judged by its DEEPEST", async () => {
  const same = { address: "0xsame", symbol: "ONE", name: "One" };
  const f = stubFetch((url) =>
    url.includes("/search")
      ? { pairs: [pair({ n: 1, baseToken: same, liquidity: { usd: 5_000 } }), pair({ n: 2, baseToken: same, liquidity: { usd: 900_000 } })] }
      : [],
  );
  try {
    const r = await ds.topByMcap("bsc", { feeds: false });
    assert.strictEqual(r.items.length, 1, "one token, one row");
    assert.strictEqual(r.items[0].liq, 900_000, "a real token seen through a thin pool reads as illiquid");
  } finally {
    f.restore();
  }
});

test("a failed query costs that query, not the chain", async () => {
  let n = 0;
  const f = stubFetch((url) => {
    if (!url.includes("/search")) return [];
    return ++n === 1 ? new Error("socket hang up") : { pairs: [pair({ n: 9 })] };
  });
  try {
    const r = await ds.topByMcap("bsc", { feeds: false });
    assert.strictEqual(r.ok, true, "the queries that answered are a real answer");
    assert.strictEqual(r.items.length, 1);
    assert.match(r.why, /socket hang up/, "and the failure is carried, never thrown away");
  } finally {
    f.restore();
  }
});

test("EVERY query failing is ok:false — not an empty chain", async () => {
  const f = stubFetch(() => new Error("ENOTFOUND"));
  try {
    const r = await ds.topByMcap("bsc", { feeds: false });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.items, []);
    assert.match(r.why, /ENOTFOUND/);
  } finally {
    f.restore();
  }
});

test("a chain DexScreener does not index says so, and costs no request", async () => {
  const f = stubFetch(() => ({ pairs: [] }));
  try {
    const r = await ds.topByMcap("notachain", {});
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /no DexScreener chain id/);
    assert.strictEqual(f.seen.length, 0);
  } finally {
    f.restore();
  }
});

test("the market-cap floor is the only floor by default", async () => {
  const f = stubFetch((url) =>
    url.includes("/search")
      ? {
          pairs: [
            pair({ n: 1, marketCap: 2_000_000, liquidity: { usd: 300 }, volume: { h24: 0 } }),
            pair({ n: 2, marketCap: 400_000, liquidity: { usd: 900_000 } }),
          ],
        }
      : [],
  );
  try {
    // "min mc 1 juta gada vol dll" — a thin $2M passes, a deep $400k does not.
    const r = await ds.topByMcap("bsc", { feeds: false });
    assert.deepStrictEqual(r.items.map((i) => i.symbol), ["T1"]);
    // …and a floor is still expressible, because a cap with no depth is real.
    const guarded = await ds.topByMcap("bsc", { feeds: false, minLiq: 50_000 });
    assert.deepStrictEqual(guarded.items, []);
  } finally {
    f.restore();
  }
});

test("a pair carries its socials and logo, so no second lookup is needed", async () => {
  const f = stubFetch((url) => (url.includes("/search") ? { pairs: [pair({ n: 1 })] } : []));
  try {
    const [it] = (await ds.topByMcap("bsc", { feeds: false })).items;
    assert.strictEqual(it.twitter, "https://x.com/t");
    assert.strictEqual(it.website, "https://t.io");
    assert.strictEqual(it.logoUrl, "https://img/x.png");
    // Fifty enrichment calls asking DexScreener the same question about the
    // same tokens is the request budget this source was chosen to save.
    assert.strictEqual(it.enriched, true);
  } finally {
    f.restore();
  }
});

test("a pair with no logo or link is NOT marked enriched", async () => {
  const f = stubFetch((url) => (url.includes("/search") ? { pairs: [pair({ n: 1, info: {} })] } : []));
  try {
    const [it] = (await ds.topByMcap("bsc", { feeds: false })).items;
    assert.strictEqual(it.enriched, false, "it still deserves the enrichment pass");
  } finally {
    f.restore();
  }
});

test("the feeds top up only when search came up short, and are batched", async () => {
  const many = Array.from({ length: 70 }, (_, i) => ({ chainId: "bsc", tokenAddress: `0xfeed${i}` }));
  const f = stubFetch((url) => {
    if (url.includes("/search")) return { pairs: [pair({ n: 1 })] };
    if (url.includes("token-boosts") || url.includes("token-profiles")) return many;
    return { pairs: [pair({ n: 2 })] };
  });
  try {
    await ds.topByMcap("bsc", { limit: 60 });
    const batches = f.seen.filter((u) => u.includes("/dex/tokens/"));
    assert.ok(batches.length >= 1, "the feed addresses are priced");
    for (const b of batches) {
      // /tokens/ truncates past 30 silently, which would look like tokens that
      // cannot be priced rather than a request that asked for too much.
      assert.ok(decodeURIComponent(b).split(",").length <= 30, `a batch asked for more than 30: ${b}`);
    }
  } finally {
    f.restore();
  }
});

test("queries are env-overridable per chain, and no chain is left unaskable", () => {
  process.env.DS_SEED_QUERIES_BSC = "FOO, BAR ,";
  try {
    assert.deepStrictEqual(ds.queriesFor("bsc"), ["FOO", "BAR"]);
  } finally {
    delete process.env.DS_SEED_QUERIES_BSC;
  }
  assert.deepStrictEqual(ds.queriesFor("bsc", { vocab: false }), ds.QUERIES.bsc, "the table is the fallback");
  // A chain with no table entry must still be seedable — silence there would
  // be a chain that simply never fills, which is the state this whole feature
  // exists to end.
  const guessed = ds.queriesFor("tron", { vocab: false });
  assert.ok(guessed.length > 0 && guessed.includes("WTRX"), `generic guess was ${guessed}`);
});

test("BOTH SIDES of a pair are considered — the project is often the QUOTE", async () => {
  // The defect this fixes, and it produced a live run of bsc 1 · base 1 ·
  // ethereum 0: searching `q=WETH` returns pairs OF WETH with WETH on the BASE
  // side, `notAProject` correctly drops the base, and the project sitting on
  // the quote side went out with it. Nearly every result looked like this.
  const priced = [];
  const f = stubFetch((url) => {
    if (url.includes("/search")) {
      return {
        pairs: [
          {
            ...pair({ n: 1 }),
            baseToken: { address: "0xweth", symbol: "WETH", name: "Wrapped Ether" },
            quoteToken: { address: "0xproj", symbol: "PROJ", name: "Project" },
          },
        ],
      };
    }
    if (url.includes("/dex/tokens/")) {
      priced.push(decodeURIComponent(url.split("/dex/tokens/")[1]));
      return { pairs: [pair({ n: 2, baseToken: { address: "0xproj", symbol: "PROJ", name: "Project" } })] };
    }
    return [];
  });
  try {
    const r = await ds.topByMcap("bsc", { feeds: false });
    assert.ok(priced.some((b) => b.includes("0xproj")), "the quote-side address must be priced");
    assert.ok(!priced.some((b) => b.includes("0xweth")), "and the money must not be");
    assert.deepStrictEqual(r.items.map((i) => i.symbol), ["PROJ"]);
    // Its cap comes from the batch lookup, where it is the BASE — the pair it
    // was found in reports the OTHER token's cap.
    assert.strictEqual(r.items[0].mcap, 5_000_000);
  } finally {
    f.restore();
  }
});

test("a base-side project is free data and is not re-priced", async () => {
  const priced = [];
  const f = stubFetch((url) => {
    if (url.includes("/search")) return { pairs: [pair({ n: 1 })] };
    if (url.includes("/dex/tokens/")) {
      priced.push(url);
      return { pairs: [] };
    }
    return [];
  });
  try {
    const r = await ds.topByMcap("bsc", { feeds: false });
    assert.deepStrictEqual(r.items.map((i) => i.symbol), ["T1"]);
    // The search answer already carried its cap, liquidity, logo and socials.
    // Asking again is one request per token, which is the budget this source
    // was chosen to save.
    assert.ok(!priced.some((u) => u.toLowerCase().includes("bbbb")), `re-priced a token it already had: ${priced}`);
  } finally {
    f.restore();
  }
});

// ── The vocabulary — "masih sama aja tidak bertambah" ───────────────────────

test("queries go WIDER than quote tokens, or a listed chain finds only itself", () => {
  // The first live --apply listed 82 tokens across 22 chains and BSC gained
  // FIVE. Four quote-token queries return the same few dozen deep pairs, and
  // on a chain that already has listings those are exactly the ones we have.
  const q = ds.queriesFor("bsc");
  assert.ok(q.length >= 20, `only ${q.length} queries — that is the same few pairs again`);
  assert.deepStrictEqual(q.slice(0, 4), ds.QUERIES.bsc, "the chain's own quote tokens still lead");
  for (const term of ds.VOCAB) assert.ok(q.includes(term), `${term} missing from the net`);
  // …and the narrow set stays reachable, because it is the cheap read.
  assert.deepStrictEqual(ds.queriesFor("bsc", { vocab: false }), ds.QUERIES.bsc);
});

test("it STOPS querying once there is plainly enough", async () => {
  const many = Array.from({ length: 200 }, (_, i) => pair({ n: i + 1 }));
  const f = stubFetch((url) => (url.includes("/search") ? { pairs: many } : []));
  try {
    await ds.topByMcap("bsc", { limit: 10, feeds: false });
    const queries = f.seen.filter((u) => u.includes("/search"));
    // A chain that filled from the first query must not spend thirty requests
    // proving it — the vocabulary is a long tail, not a fixed cost.
    assert.ok(queries.length < ds.queriesFor("bsc").length, `ran all ${queries.length} queries anyway`);
  } finally {
    f.restore();
  }
});

test("an env override still replaces the whole list, vocabulary included", () => {
  process.env.DS_SEED_QUERIES_BSC = "ONLY,THESE";
  try {
    assert.deepStrictEqual(ds.queriesFor("bsc"), ["ONLY", "THESE"]);
  } finally {
    delete process.env.DS_SEED_QUERIES_BSC;
  }
});
