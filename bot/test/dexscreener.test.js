// THE PARSER EVERY GATE READS, and until now it had no test at all.
//
// `autoLister.rejectReason` judges a token on `symbol`, `name`, `mcap`, `liq`,
// `vol24` and `pairCreatedAt`, and every one of them is produced here. If
// DexScreener renames a field — or the `pairs` envelope, or the endpoint — this
// function answers `null` for EVERY candidate on EVERY chain, the scan files
// that as "no market data" (a claim about the token), and the full suite stays
// green because every auto-lister fixture is hand-built and never passes through
// this parser. A rename would be indistinguishable from a quiet market from
// every surface an operator has.
//
// So: a captured payload in, the real parser, and the output fed straight into
// the real gate. A field rename fails the build.
const test = require("node:test");
const assert = require("node:assert");

const ds = require("../src/dexscreener");
const al = require("../src/services/autoLister");

const HOUR = 3_600_000;
const now = 1_800_000_000_000;

// A DexScreener /latest/dex/tokens/<addr> response, trimmed to the fields this
// repo reads. Shape captured from the live API.
const PAYLOAD = {
  schemaVersion: "1.0.0",
  pairs: [
    {
      chainId: "solana",
      dexId: "raydium",
      pairAddress: "PAIR_DEEP",
      baseToken: { address: "So1Mint", name: "Nine Hood", symbol: "NINEHOOD" },
      quoteToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
      priceUsd: "0.001234",
      liquidity: { usd: 184_000, base: 1, quote: 2 },
      volume: { h24: 412_000, h6: 1, h1: 1 },
      priceChange: { h24: 18.4 },
      fdv: 1_800_000,
      marketCap: 1_240_000,
      pairCreatedAt: now - 72 * HOUR,
      info: {
        imageUrl: "https://dd.dexscreener.com/ds-data/tokens/solana/So1Mint.png",
        websites: [{ label: "Website", url: "https://ninehood.io" }],
        socials: [
          { type: "twitter", url: "https://x.com/ninehood" },
          { type: "telegram", url: "https://t.me/ninehood" },
        ],
      },
    },
    {
      // A thinner pair for the SAME token — the parser must take the deepest, or
      // a real token seen through a dust pool reads as illiquid and is refused.
      chainId: "solana",
      pairAddress: "PAIR_THIN",
      baseToken: { address: "So1Mint", name: "Nine Hood", symbol: "NINEHOOD" },
      priceUsd: "0.9",
      liquidity: { usd: 900 },
      volume: { h24: 12 },
      marketCap: 99,
      pairCreatedAt: now - 1 * HOUR,
    },
    {
      // Another chain entirely. Matching it would price a token against a
      // same-address contract on a different network.
      chainId: "base",
      pairAddress: "PAIR_BASE",
      baseToken: { address: "So1Mint", name: "Impostor", symbol: "FAKE" },
      liquidity: { usd: 5_000_000 },
      volume: { h24: 9_000_000 },
      marketCap: 90_000_000,
    },
  ],
};

/** Stand in for global fetch for one test. */
function stubFetch(t, handler) {
  const real = global.fetch;
  global.fetch = handler;
  t.after(() => (global.fetch = real));
}
const reply = (body, init = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, ...init });

test("every field the gates read survives the parse — a rename fails here, not silently in production", async (t) => {
  stubFetch(t, async () => reply(PAYLOAD));
  const { info, ok, why } = await ds.fetchTokenInfoX("solana", "So1Mint");
  assert.strictEqual(ok, true);
  assert.strictEqual(why, null);
  // The deepest pair, not the first and not the thin one.
  assert.strictEqual(info.symbol, "NINEHOOD");
  assert.strictEqual(info.name, "Nine Hood");
  assert.strictEqual(info.mcap, 1_240_000);
  assert.strictEqual(info.liq, 184_000);
  assert.strictEqual(info.vol24, 412_000);
  assert.strictEqual(info.pairCreatedAt, now - 72 * HOUR);
  assert.strictEqual(info.priceUsd, 0.001234);
  assert.strictEqual(info.logoUrl, PAYLOAD.pairs[0].info.imageUrl);
  assert.strictEqual(info.website, "https://ninehood.io");
  assert.strictEqual(info.twitter, "https://x.com/ninehood");
  assert.strictEqual(info.telegram, "https://t.me/ninehood");
  // Only the pairs on the asked-for chain are counted.
  assert.strictEqual(info.pairCount, 2);
});

test("…and that record passes the REAL gate — the two halves are pinned together", async (t) => {
  stubFetch(t, async () => reply(PAYLOAD));
  const { info } = await ds.fetchTokenInfoX("solana", "So1Mint");
  const cfg = { ...al.DEFAULTS };
  // Its own hash-derived trigger, so "clears the bar" is computed, not assumed.
  const trigger = al.triggerMcap("So1Mint", cfg);
  const why = al.rejectReason(info, cfg, Math.min(trigger, info.mcap), now);
  assert.strictEqual(why, null, `a healthy DexScreener payload must qualify, got: ${why}`);
});

test("⚠️ the fixture is not vacuous — dropping a field the gate reads must fail the gate", async (t) => {
  stubFetch(t, async () =>
    reply({ pairs: [{ ...PAYLOAD.pairs[0], liquidity: undefined, volume: undefined }] }),
  );
  const { info } = await ds.fetchTokenInfoX("solana", "So1Mint");
  const cfg = { ...al.DEFAULTS };
  assert.match(String(al.rejectReason(info, cfg, 1, now)), /thin liquidity/);
});

test("a chain DexScreener does not index is an ANSWER, not a failure", async (t) => {
  stubFetch(t, async () => {
    throw new Error("must not be called");
  });
  const r = await ds.fetchTokenInfoX("no-such-chain", "x");
  assert.strictEqual(r.ok, true, "the caller should fall through to another source, not retry us");
  assert.strictEqual(r.info, null);
});

test("no pair on the asked-for chain is an ANSWER about the token", async (t) => {
  stubFetch(t, async () => reply({ pairs: [PAYLOAD.pairs[2]] })); // base only
  const r = await ds.fetchTokenInfoX("solana", "So1Mint");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.info, null);
  assert.match(r.why, /no solana pair/);
});

test("⚠️ a REFUSAL is not an answer — and it does not become one because the body was empty", async (t) => {
  ds.resetBench();
  stubFetch(t, async () => reply("", { status: 429 }));
  const r = await ds.fetchTokenInfoX("solana", "So1Mint");
  assert.strictEqual(r.ok, false, "a 429 recorded as 'no market data' benches a healthy token for 12 hours");
  assert.match(r.why, /429/);
  ds.resetBench();
});

test("a 404 IS about the token — it must not bench the host", async (t) => {
  ds.resetBench();
  stubFetch(t, async () => reply("", { status: 404 }));
  const r = await ds.fetchTokenInfoX("solana", "So1Mint");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(ds.benched(), null, "one missing token must not stop the whole scan");
});

test("a transport failure keeps the syscall — 'fetch failed' alone cost this repo a round of guessing", async (t) => {
  ds.resetBench();
  stubFetch(t, async () => {
    const e = new Error("fetch failed");
    e.cause = { code: "ENOTFOUND" };
    throw e;
  });
  const r = await ds.fetchTokenInfoX("solana", "So1Mint");
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /ENOTFOUND/);
  assert.strictEqual(ds.benched(), null, "a dead socket says nothing about a quota");
});

test("⚠️ a refusal BENCHES the host, and the bench answers without making a request", async (t) => {
  ds.resetBench();
  let calls = 0;
  stubFetch(t, async () => {
    calls++;
    return reply("", { status: 403 });
  });
  await ds.fetchTokenInfoX("solana", "So1Mint");
  assert.strictEqual(calls, 1);
  // 43 requests per scan into a host that has already said no is what keeps the
  // refusal in place. The second call must not leave the process.
  const second = await ds.fetchTokenInfoX("solana", "So1Other");
  assert.strictEqual(calls, 1, "the benched call still went out");
  assert.strictEqual(second.ok, false);
  assert.match(second.why, /refusing this server/);
  // …and the DISCOVERY feeds share the same bench: they are the same host, and
  // two benches would let one half keep the refusal alive for the other.
  const d = await ds.fetchDiscoveryX();
  assert.strictEqual(calls, 1);
  assert.strictEqual(d.ok, false);
  ds.resetBench();
});

test("a feed that answers 200 with a non-list is RESHAPED, not empty", async (t) => {
  ds.resetBench();
  stubFetch(t, async () => reply({ data: [] }));
  const d = await ds.fetchDiscoveryX(["https://api.dexscreener.com/token-profiles/latest/v1"]);
  assert.strictEqual(d.ok, false);
  assert.match(d.why, /non-list body/);
});

test("the discovery feed maps DexScreener's chain slug back to ours — including the one they spell differently", async (t) => {
  ds.resetBench();
  stubFetch(t, async () =>
    reply([
      { chainId: "solana", tokenAddress: "So1a" },
      { chainId: "seiv2", tokenAddress: "0xsei" }, // ⚠️ they call it seiv2, we call it sei
      { chainId: "not-a-chain", tokenAddress: "0xnope" },
    ]),
  );
  const d = await ds.fetchDiscoveryX(["https://api.dexscreener.com/token-profiles/latest/v1"]);
  assert.strictEqual(d.ok, true);
  assert.deepStrictEqual(
    d.items.map((c) => c.chain),
    ["solana", "sei"],
    "a slug we cannot map is dropped; one we CAN must not be",
  );
});

test("⚠️ REFUSALS ONLY — a 5xx must NOT bench the host", async (t) => {
  ds.resetBench();
  stubFetch(t, async () => reply("", { status: 500 }));
  const r = await ds.fetchTokenInfoX("solana", "So1Mint");
  assert.strictEqual(r.ok, false, "a 500 is still 'could not ask'");
  // The bench is ONE bench for the whole host, so arming it here would stop
  // pricing AND all three discovery feeds — the scan would then record
  // "discovery could not reach any source" and three of those page the ops
  // channel. A whole-feed outage manufactured from one slow response.
  assert.strictEqual(ds.benched(), null, "a per-request failure says nothing about the quota");
});

test("Retry-After is honoured, and bounded — a hostile header must not bench us for a day", async (t) => {
  ds.resetBench();
  stubFetch(t, async () => reply("", { status: 429, headers: { "retry-after": "86400" } }));
  await ds.fetchTokenInfoX("solana", "So1Mint");
  const held = ds.benched();
  assert.ok(held, "a 429 must bench");
  const secs = Number((held.match(/(\d+)s/) || [])[1]);
  assert.ok(secs > 0 && secs <= 600, `benched for ${secs}s — the cap is ten minutes`);
  ds.resetBench();
});
