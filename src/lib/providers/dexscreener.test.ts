// The DexScreener gap-filler — the second source chains.ts documented and
// nobody built, while every bot-listed launch rendered a fabricated ▲0.0%
// until GT indexed its first pool.
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DS_MULTI_MAX, dsCovers, fetchDsMarket, partitionByFallback } from "./dexscreener.ts";

const realFetch = globalThis.fetch;
const addr = (i: number) => `Mint${i}aBcDeFgHiJkLmNpQrStUvWxYz${i}`;

function pair(base: string, over: Record<string, unknown> = {}) {
  return {
    chainId: "solana", pairAddress: `pool_${base}`,
    baseToken: { address: base, name: "T", symbol: "T" },
    priceUsd: "0.5", marketCap: 1_000_000, liquidity: { usd: 40_000 },
    priceChange: { m5: 1, h1: 2, h6: 3, h24: 4 },
    volume: { m5: 10, h1: 20, h6: 30, h24: 40 },
    txns: { h24: { buys: 5, sells: 3 } },
    pairCreatedAt: Date.now() - 3_600_000,
    ...over,
  };
}

function mockDs(answer: (chunk: string[]) => unknown, failStatuses: (number | null)[] = []) {
  const urls: string[] = [];
  let call = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const status = failStatuses[call++] ?? null;
    if (status != null) return new Response("nope", { status });
    const chunk = decodeURIComponent(url.split("/").pop()!.split("?")[0]).split(",");
    return Response.json(answer(chunk));
  }) as typeof fetch;
  return urls;
}

test("every address is asked for, chunked, verbatim, on the chain-scoped path", async () => {
  try {
    const addresses = Array.from({ length: 45 }, (_, i) => addr(i));
    const urls = mockDs((chunk) => chunk.map((a) => pair(a)));
    const map = await fetchDsMarket("solana", addresses);
    assert.strictEqual(urls.length, Math.ceil(45 / DS_MULTI_MAX));
    // chain in the PATH is what makes the wrong-chain-pair problem impossible
    for (const u of urls) assert.match(u, /\/tokens\/v1\/solana\//);
    assert.ok(urls[0].includes(addr(1)), "casing survives — base58 is case-significant");
    assert.strictEqual(map.size, 45);
    assert.strictEqual(map.get(addr(3).toLowerCase())?.chg["1h"], 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a token with several pairs is judged by its DEEPEST", async () => {
  try {
    const a = addr(1);
    mockDs(() => [
      pair(a, { liquidity: { usd: 500 }, priceChange: { h24: 4000 } }), // dust pool, absurd pct
      pair(a, { liquidity: { usd: 90_000 }, priceChange: { h24: 7 } }),
    ]);
    const m = await fetchDsMarket("solana", [a]);
    assert.strictEqual(m.get(a.toLowerCase())?.chg["24h"], 7, "the deep pool's reading wins");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a pair where the asked token is the QUOTE side never counts", async () => {
  try {
    mockDs(() => [pair("SomeOtherBase111111111111111111111111111111")]);
    const m = await fetchDsMarket("solana", [addr(1)]);
    assert.strictEqual(m.size, 0, "identity is the base token's address, nothing else");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the DS pool address never reaches poolAddress — it feeds a GT chart embed", async () => {
  try {
    mockDs((chunk) => chunk.map((a) => pair(a)));
    const m = await fetchDsMarket("solana", [addr(1)]);
    assert.strictEqual(m.get(addr(1).toLowerCase())?.poolAddress, null,
      "a pool GT never indexed renders as a 404 inside the token page");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a chain DexScreener does not carry answers empty without a request", async () => {
  try {
    const urls = mockDs(() => []);
    // A chain id with no chains.ts entry stands in for "no DS coverage" — the
    // real chains all carry a slug today (Robinhood was the last holdout, and
    // DexScreener added it ~July 2026), and this rule must outlive the roster.
    assert.strictEqual((await fetchDsMarket("no-such-chain", [addr(1)])).size, 0);
    assert.strictEqual(urls.length, 0, "chains.ts has no dexscreener slug there");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("total failure throws; partial failure keeps what answered", async () => {
  try {
    mockDs(() => [], [429, 429]);
    await assert.rejects(() => fetchDsMarket("solana", Array.from({ length: 40 }, (_, i) => addr(i))), /DexScreener 429/);
    mockDs((chunk) => chunk.map((a) => pair(a)), [429, null]);
    const m = await fetchDsMarket("solana", Array.from({ length: 40 }, (_, i) => addr(i)));
    assert.strictEqual(m.size, 10, "the second chunk landed");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the chains with no DexScreener fallback are exactly the GT-only set", () => {
  // Robinhood sat at 0/66 priced while Solana sat at 162/192: the market cycle
  // fired every chain concurrently against a GT budget the site's own demand
  // exceeds, and the one chain that cannot recover through DexScreener lost
  // the race every time. The scheduler now spends the budget on these first.
  // Robinhood was the motivating case and is COVERED now (DexScreener added
  // the chain ~July 2026) — the mechanism outlives the roster: any chain
  // without a slug goes in the first-priority group, today and later.
  assert.equal(dsCovers("robinhood"), true);
  assert.equal(dsCovers("solana"), true);
  assert.equal(dsCovers("no-such-chain"), false);
  const [gtOnly, covered] = partitionByFallback([
    ["solana", []], ["no-such-chain", []], ["bsc", []],
  ]);
  assert.deepEqual(gtOnly.map((e) => e[0]), ["no-such-chain"], "the GT-only chain must be in the first-priority group");
  assert.deepEqual(covered.map((e) => e[0]), ["solana", "bsc"]);
});

test("the market cycle awaits the GT-only chains before the covered ones start", () => {
  // A scheduling property, pinned at the source: the priority group is only a
  // priority while it is AWAITED first — launched concurrently it is just a
  // longer list.
  const src = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
  assert.match(src, /const \[gtOnly, covered\] = partitionByFallback/);
  assert.match(src, /\.\.\.\(await Promise\.allSettled\(gtOnly\.map\(fetchOne\)\)\),\s*\n\s*\.\.\.\(await Promise\.allSettled\(covered\.map\(fetchOne\)\)\),/, "the GT-only group is no longer awaited ahead of the covered group");
});
