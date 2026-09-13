// The REAL per-transaction buy feed: direction from token addresses, the
// null-vs-[] contract, multi-hop merging, and the shared GT cooldown.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-trades-"));

const test = require("node:test");
const assert = require("node:assert");
const trades = require("../src/group/gtTrades");
const gt = require("../src/group/gtPairs");

const CA = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WETH = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const row = (over = {}) => ({
  attributes: {
    block_number: 100,
    block_timestamp: "2026-08-08T12:00:00Z",
    tx_hash: "0xtx1",
    tx_from_address: "0xbuyer",
    from_token_address: WETH,
    to_token_address: CA,
    from_token_amount: "0.5",
    to_token_amount: "1000",
    price_to_in_usd: "0.04",
    volume_in_usd: "40",
    kind: "buy",
    ...over,
  },
});

/** Swap global fetch for one canned response, restoring afterwards. */
async function withFetch(impl, fn) {
  const real = global.fetch;
  global.fetch = impl;
  try {
    return await fn();
  } finally {
    global.fetch = real;
    gt._reset();
  }
}
const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// ── Direction ────────────────────────────────────────────────────────────────

test("direction comes from the token addresses, not from `kind`", () => {
  // Our token is RECEIVED → a buy, even though kind says sell.
  assert.strictEqual(trades.tradeIsBuyOfToken({ to_token_address: CA, from_token_address: WETH, kind: "sell" }, CA), true);
  // Our token is GIVEN → a sell, even though kind says buy. This is the case
  // that matters: on a pool where our token is the QUOTE side, GT's
  // base-relative `kind` is inverted, and trusting it posts a green buy alert
  // on every dump.
  assert.strictEqual(trades.tradeIsBuyOfToken({ to_token_address: WETH, from_token_address: CA, kind: "buy" }, CA), false);
});

test("an EVM address matches case-insensitively, a base58 mint does not", () => {
  assert.strictEqual(trades.sameToken(CA, CA.toLowerCase()), true);
  // Solana mints are case-SENSITIVE base58; lowercasing to compare would be a
  // correctness bug, so it only ever happens for 0x hex.
  assert.strictEqual(trades.sameToken("So11111111111111111111111111111111111111112", "so11111111111111111111111111111111111111112"), false);
});

test("a trade involving neither side of our token is null — never a guess", () => {
  assert.strictEqual(trades.tradeIsBuyOfToken({ to_token_address: WETH, from_token_address: "0xcc" }, CA), null);
  assert.strictEqual(trades.tradeIsBuyOfToken(null, CA), null);
  assert.strictEqual(trades.tradeIsBuyOfToken({ to_token_address: CA }, ""), null);
});

test("`kind` is consulted ONLY when there are no addresses and our token is the base", () => {
  assert.strictEqual(trades.tradeIsBuyOfToken({ kind: "buy" }, CA), null); // no proof it's the base
  assert.strictEqual(trades.tradeIsBuyOfToken({ kind: "buy" }, CA, { tokenIsBase: true }), true);
  assert.strictEqual(trades.tradeIsBuyOfToken({ kind: "sell" }, CA, { tokenIsBase: true }), false);
});

// ── Normalisation ────────────────────────────────────────────────────────────

test("a trade with no tx hash is dropped — there would be nothing to dedupe on", () => {
  assert.strictEqual(trades.toTrade(row({ tx_hash: "" }), CA), null);
});

test("USD falls back to amount x price when GT left volume_in_usd empty", () => {
  const t = trades.toTrade(row({ volume_in_usd: "0" }), CA);
  assert.strictEqual(t.usd, 1000 * 0.04);
});

test("an unpriceable buy is dropped rather than posted at $0", () => {
  assert.strictEqual(trades.toTrade(row({ volume_in_usd: "0", price_to_in_usd: "0" }), CA), null);
});

// ── Multi-hop merge ──────────────────────────────────────────────────────────

test("the legs of one routed swap merge into a single buy", () => {
  const merged = trades.mergeByTx([
    { txHash: "0xa", usd: 40, tokenAmount: 100, spentAmount: 1, buyer: "", blockNumber: 5, blockTimeMs: 200, priceUsd: 0.4 },
    { txHash: "0xa", usd: 50, tokenAmount: 120, spentAmount: 1, buyer: "0xb", blockNumber: 5, blockTimeMs: 100, priceUsd: 0.4 },
    { txHash: "0xa", usd: 30, tokenAmount: 80, spentAmount: 1, buyer: "0xc", blockNumber: 0, blockTimeMs: 300, priceUsd: 0.4 },
  ]);
  assert.strictEqual(merged.length, 1);
  const m = merged[0];
  assert.strictEqual(m.usd, 120, "amounts sum — un-merged this posts as $40 and the rest vanish into the dedupe");
  assert.strictEqual(m.tokenAmount, 300);
  assert.strictEqual(m.blockTimeMs, 100, "earliest non-zero timestamp wins");
  assert.strictEqual(m.blockNumber, 5, "a zero block never wins");
  assert.strictEqual(m.buyer, "0xb", "first non-empty buyer");
  assert.strictEqual(m.priceUsd, 120 / 300, "unit price is recomputed from the merged totals");
  assert.strictEqual(m.legs, 3);
});

// ── The null vs [] contract ──────────────────────────────────────────────────

test("a quiet pool resolves [] — the feed answered, so the caller must stay silent", async () => {
  await withFetch(async () => jsonRes({ data: [] }), async () => {
    const res = await trades.fetchPoolBuys("eth", "0xpool", CA);
    assert.ok(Array.isArray(res) && res.length === 0);
  });
});

test("an unavailable feed resolves null — 'we cannot see' is not 'nothing happened'", async () => {
  await withFetch(async () => jsonRes({}, 404), async () => {
    assert.strictEqual(await trades.fetchPoolBuys("eth", "0xpool", CA), null);
  });
  await withFetch(async () => { throw new Error("socket hang up"); }, async () => {
    assert.strictEqual(await trades.fetchPoolBuys("eth", "0xpool", CA), null);
  });
});

test("a pool of only sells resolves [] — answered, and none of them were buys", async () => {
  await withFetch(
    async () => jsonRes({ data: [row({ to_token_address: WETH, from_token_address: CA })] }),
    async () => {
      const res = await trades.fetchPoolBuys("eth", "0xpool", CA);
      assert.deepStrictEqual(res, []);
    },
  );
});

test("a pool where NOTHING involves our token is null, not authoritative silence", async () => {
  // Wrong pool, wrong chain, or an address form we failed to match. That is US
  // BEING BLIND — returning [] would assert the pool is quiet, suppress the
  // estimator, and leave the group with no alerts and nothing to explain why.
  const OTHER = "0xcccccccccccccccccccccccccccccccccccccccc";
  await withFetch(
    async () => jsonRes({ data: [row({ from_token_address: OTHER, to_token_address: WETH })] }),
    async () => {
      assert.strictEqual(await trades.fetchPoolBuys("eth", "0xpool", CA), null);
    },
  );
});

test("buys come back oldest-first, so alerts post in the order they happened", async () => {
  await withFetch(
    async () =>
      jsonRes({
        data: [
          row({ tx_hash: "0xnew", block_number: 300 }),
          row({ tx_hash: "0xold", block_number: 100 }),
          row({ tx_hash: "0xmid", block_number: 200 }),
        ],
      }),
    async () => {
      const res = await trades.fetchPoolBuys("eth", "0xpool", CA);
      assert.deepStrictEqual(res.map((b) => b.txHash), ["0xold", "0xmid", "0xnew"]);
    },
  );
});

test("the server-side volume filter is a FRACTION of the threshold, so routed legs survive", async () => {
  let seen = "";
  await withFetch(async (url) => { seen = String(url); return jsonRes({ data: [] }); }, async () => {
    // A REAL hex address, mixed case. "0xPoOl" only looks like one — it has no
    // business folding, and gtAddr is right to leave it alone, so it cannot
    // exercise the rule this line is here to check.
    await trades.fetchPoolBuys("eth", "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01", CA, { minUsd: 100 });
  });
  const q = new URL(seen).searchParams.get("trade_volume_in_usd_greater_than");
  assert.strictEqual(Number(q), 20, "100 * 0.2 — filtering at the full threshold drops legs that only sum above it");
  // A HEX pool is folded, because hex is case-insensitive and folding it is
  // free. This assertion used to read "the pool address is lowercased for GT"
  // full stop — which pinned the bug rather than the rule, and hid it: on
  // Solana, base58 "5P…" and "5p…" are different addresses, so every Solana
  // group asked GT for a pool that does not exist and had its feed reported as
  // unavailable. See gtAddressCase.test.js.
  assert.ok(seen.includes("/pools/0xabcdef0123456789abcdef0123456789abcdef01/trades"), "a hex pool address is safe to fold");
});

// ── The shared cooldown ──────────────────────────────────────────────────────

test("a 429 arms ONE cooldown shared by the trades feed and the pool resolver", async () => {
  const hosts = [];
  await withFetch(
    async (url) => {
      hosts.push(new URL(String(url)).host);
      return jsonRes({}, 429);
    },
    async () => {
      assert.strictEqual(await trades.fetchPoolBuys("eth", "0xpool", CA), null);
      const afterFirst = hosts.filter((h) => h.includes("geckoterminal")).length;
      assert.strictEqual(afterFirst, 1);
      // Both GT callers now short-circuit without making a request — a shared
      // IP limit means one refusal is everyone's refusal.
      assert.strictEqual(await trades.fetchPoolBuys("eth", "0xother", CA), null);
      await gt.fetchPool("ethereum", CA);
      assert.strictEqual(
        hosts.filter((h) => h.includes("geckoterminal")).length,
        1,
        "no further GeckoTerminal requests while the cooldown is armed",
      );
      // DexScreener is a different host with its own limit, so the fallback is
      // still allowed to run — cooling off GT must not take the whole resolver
      // offline for chains DexScreener can answer for.
      assert.ok(hosts.some((h) => h.includes("dexscreener")));
      assert.ok(gt.inCooldown());
    },
  );
});

test("a 404 does NOT arm the cooldown — one dead pool must not blind every group", async () => {
  await withFetch(async () => jsonRes({}, 404), async () => {
    await trades.fetchPoolBuys("eth", "0xpool", CA);
    assert.strictEqual(gt.inCooldown(), false);
  });
});

test("a 5xx or a timeout does NOT arm the cooldown either — only 429 does", async () => {
  // Both are per-request. Arming a process-wide backoff for them would stop
  // every group's buy bot AND swap its real alerts for estimates, on one bad
  // moment for one pool.
  await withFetch(async () => jsonRes({}, 503), async () => {
    assert.strictEqual(await trades.fetchPoolBuys("eth", "0xpool", CA), null);
    assert.strictEqual(gt.inCooldown(), false);
  });
  await withFetch(async () => { throw new Error("timeout"); }, async () => {
    assert.strictEqual(await trades.fetchPoolBuys("eth", "0xpool", CA), null);
    assert.strictEqual(gt.inCooldown(), false);
  });
});
