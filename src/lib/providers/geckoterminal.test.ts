// The chunked GT fetch. The bug this pins: `addresses.slice(0, 30)` — written
// against a 14-token seed, shipped to a store of 173 listings, where it
// silently dropped tokens 31+ per chain. 53 of 83 Solana listings could never
// price and rendered +0.0% forever, with nothing anywhere saying why.
import test from "node:test";
import assert from "node:assert";
import { GT_MULTI_MAX, fetchListedMarket } from "./geckoterminal.ts";
import { _gtReset } from "./gt.ts";

// ⚠️ The 429 cooldown is PROCESS-WIDE by design (providers/gt.ts), so a test
// that earns one silences every test after it — which showed up as two
// unrelated sibling-pool tests failing for no visible reason.
test.beforeEach(_gtReset);

const realFetch = globalThis.fetch;

// A base58-shaped, case-significant address per index — casing must survive.
const addr = (i: number) => `Mint${i}aBcDeFgHiJkLmNpQrStUvWxYz${i}`;

function gtToken(address: string) {
  return {
    id: `solana_${address}`,
    attributes: {
      address, name: "T", symbol: "T", image_url: null,
      price_usd: "1.5", market_cap_usd: "1000000", fdv_usd: null, total_reserve_in_usd: "50000",
    },
    relationships: { top_pools: { data: [] } },
  };
}

/** Mock GT: records every URL, answers each chunk with its own tokens. */
function mockGt(failStatuses: (number | null)[] = []) {
  const urls: string[] = [];
  let call = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const status = failStatuses[call++] ?? null;
    if (status != null) return new Response("rate limited", { status });
    const listed = decodeURIComponent(url.split("/multi/")[1].split("?")[0]).split(",");
    return Response.json({ data: listed.map(gtToken), included: [] });
  }) as typeof fetch;
  return urls;
}

const addrsIn = (url: string) => decodeURIComponent(url.split("/multi/")[1].split("?")[0]).split(",");

test("EVERY address is requested, in chunks the endpoint can answer", async () => {
  try {
    const addresses = Array.from({ length: 83 }, (_, i) => addr(i));
    const urls = mockGt();
    const map = await fetchListedMarket("solana", addresses);

    assert.strictEqual(urls.length, Math.ceil(83 / GT_MULTI_MAX), "83 → 3 requests");
    const sent = urls.flatMap(addrsIn);
    assert.strictEqual(sent.length, 83, "no token is silently dropped");
    for (const u of urls)
      assert.ok(addrsIn(u).length <= GT_MULTI_MAX, "no request exceeds the endpoint's cap");
    assert.strictEqual(map.size, 83, "and every one came back priced");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("addresses reach GT VERBATIM — base58 is case-significant", async () => {
  // The backend repo already paid for this one: lowercasing a base58 address
  // asks GT about an address that does not exist, silently, forever.
  try {
    const urls = mockGt();
    const map = await fetchListedMarket("solana", [addr(1)]);
    assert.ok(urls[0].includes(addr(1)), "the exact casing was sent");
    assert.ok(map.has(addr(1).toLowerCase()), "our keys are lowercased — they only have to be consistent");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a 429 stops the rest of the cycle AND fails the chain, so DexScreener takes it", async () => {
  // Two rules moved here, in two steps, and both are about the same thing.
  //
  // 1. A 429 stops the remaining chunks. The old test asserted chunk 3 still
  //    went out after chunk 2 was rate-limited, which only ever "worked" in a
  //    mock: a real 429 means the IP is over its ceiling, so the next chunk is
  //    another 429 that extends the window.
  // 2. And the SHORTENED cycle must not be returned as a partial answer. The
  //    "a failed chunk is skipped" contract was written for one bad chunk out
  //    of many; under a process-wide cooldown it would hand the caller 30 live
  //    tokens and 140 silently unpriced ones, which `cached()` then serves as
  //    the board for a minute. Throwing sends the WHOLE chain to DexScreener
  //    (indexedMarket), which is the fallback that exists for exactly this and
  //    which covers 22 of the 23 registered chains.
  try {
    const addresses = Array.from({ length: 70 }, (_, i) => addr(i));
    const urls = mockGt([null, 429, null]); // chunk 2 of 3 is rate-limited
    await assert.rejects(() => fetchListedMarket("solana", addresses), /429/);
    assert.strictEqual(urls.length, 2, "chunk 3 was never fired into a live rate limit");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("…but an ORDINARY failed chunk is still just skipped", async () => {
  // The original lesson stands wherever the quota is not the problem: a 500 on
  // one chunk costs its tokens their reading this cycle, not the whole chain.
  try {
    const addresses = Array.from({ length: 70 }, (_, i) => addr(i));
    mockGt([null, 500, null]);
    const map = await fetchListedMarket("solana", addresses);
    assert.strictEqual(map.size, 40, "chunks 1 and 3 landed");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("but a chain where NOTHING answered throws — down and empty are different facts", async () => {
  // Returning an empty map for a 429 would tell the caller "these 83 tokens
  // have no market", and the board would quietly keep captured figures with
  // `live` reading true.
  try {
    mockGt([429, 429, 429]);
    await assert.rejects(
      // The CAUSE, not the consequence: the later chunks fail with "cooling
      // down", and reporting that would hide the 429 that armed it.
      () => fetchListedMarket("solana", Array.from({ length: 70 }, (_, i) => addr(i))),
      /GeckoTerminal 429/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a chain GT does not index, or an empty list, answers empty without a request", async () => {
  try {
    const urls = mockGt();
    assert.strictEqual((await fetchListedMarket("nosuchchain", [addr(1)])).size, 0);
    assert.strictEqual((await fetchListedMarket("solana", [])).size, 0);
    assert.strictEqual(urls.length, 0, "no network call for either");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── the sibling-pool CHANGE borrow ──────────────────────────────────────────
// GT sends `price_change_percentage.h24: null` for a pool that has not traded
// in the window — a different fact from the pool not existing. Reading only
// the top pool turned that null into a fabricated ▲0.0% even when a sibling
// pool of the SAME token carried a real reading (the bot repo's
// changeFromPools lesson, on the web surface).

function gtPool(id: string, reserve: string, chg: Partial<Record<"m5" | "h1" | "h6" | "h24", string>>) {
  return {
    id,
    attributes: {
      address: id.split("_")[1],
      reserve_in_usd: reserve,
      pool_created_at: null,
      price_change_percentage: chg,
      volume_usd: {},
      transactions: {},
    },
  };
}

function mockGtPayload(payload: unknown) {
  globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
}

function poolsPayload(address: string, pools: ReturnType<typeof gtPool>[]) {
  return {
    data: [{
      id: `solana_${address}`,
      attributes: {
        address, name: "T", symbol: "T", image_url: null,
        price_usd: "1.5", market_cap_usd: "1000000", fdv_usd: null, total_reserve_in_usd: null,
      },
      relationships: { top_pools: { data: pools.map((p) => ({ id: p.id })) } },
    }],
    included: pools,
  };
}

test("a quiet top pool borrows its change from the deepest sibling that has one", async () => {
  try {
    const a = addr(1);
    mockGtPayload(poolsPayload(a, [
      gtPool("solana_pMain", "100000", { h1: "2.0" }), // h24 missing — quiet in that window
      gtPool("solana_pThin", "20000", { h24: "5.0" }),
      gtPool("solana_pDeep", "60000", { h24: "12.5" }), // deepest sibling WITH a reading wins
    ]));
    const m = (await fetchListedMarket("solana", [a])).get(a.toLowerCase());
    assert.strictEqual(m?.chg["24h"], 12.5, "borrowed from the deepest sibling that has it");
    assert.strictEqual(m?.chg["1h"], 2.0, "a window the top pool HAS is never overridden");
    assert.strictEqual(m?.liq, 100000, "liquidity still comes from the top pool alone");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a dust sibling may never supply the change", async () => {
  // A four-figure percentage off a $5k pool is the thing judging by the
  // DEEPEST pool exists to refuse — below the share floor, 0 stands.
  try {
    const a = addr(2);
    mockGtPayload(poolsPayload(a, [
      gtPool("solana_pMain", "100000", {}),
      gtPool("solana_pDust", "5000", { h24: "900" }), // 5% of top liq — under the 10% floor
    ]));
    const m = (await fetchListedMarket("solana", [a])).get(a.toLowerCase());
    assert.strictEqual(m?.chg["24h"], 0, "the dust pool's reading was refused");
  } finally {
    globalThis.fetch = realFetch;
  }
});
