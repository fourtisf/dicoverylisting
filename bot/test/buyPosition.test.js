// The 💼 Position row reports a wallet's balance AFTER a specific trade — so the
// one wallet whose cached balance is certainly stale is the one that just made
// the trade, by exactly the amount the row is about to report.
//
// This drives the REAL holdingOf, cache and all. Stubbing holdingOf itself (what
// the other buy-bot suites do, correctly, for their own subjects) would skip the
// only thing under test here.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-pos-"));

const test = require("node:test");
const assert = require("node:assert");

// The RPC layer is replaced BEFORE walletHoldings destructures it at require
// time — `const { rpcRead } = require(...)` captures the binding, so a later
// reassignment of the export would not be seen. The stub never invokes the
// callback, so no provider is built, no contract is constructed and nothing
// touches the network: only the caching around it is exercised.
const rpcPath = require.resolve("../src/config/rpc");
let reads = 0;
let answer = { value: 1000 };
require.cache[rpcPath] = {
  id: rpcPath,
  filename: rpcPath,
  loaded: true,
  exports: {
    rpcRead: async () => {
      reads++;
      return answer;
    },
  },
};

const holdings = require("../src/group/walletHoldings");

const CHAIN = "bsc"; // an EVM chain, so ethersLib() is the only real dependency
const TOKEN = `0x${"a".repeat(40)}`;
const WALLET = `0x${"b".repeat(40)}`;

test.beforeEach(() => {
  holdings._reset();
  reads = 0;
  answer = { value: 1000 };
});

test("a repeat buyer's balance is RE-READ, not served from the cache", async () => {
  // The bug this pins: a wallet that buys twice inside the two-minute window got
  // its FIRST balance printed under the second buy. The row then disagreed with
  // any explorer the group cared to check — and the Position row is the one
  // number on the card a reader can go and verify.
  assert.strictEqual(await holdings.holdingOf(CHAIN, TOKEN, WALLET, { fresh: true }), 1000);
  answer = { value: 1500 }; // they bought 500 more, seconds later
  assert.strictEqual(await holdings.holdingOf(CHAIN, TOKEN, WALLET, { fresh: true }), 1500);
  assert.strictEqual(reads, 2, "both buys asked the chain");
});

test("without `fresh`, the cache still works exactly as it did", async () => {
  // The flag is opt-in: nothing else in the codebase loses the cache, and this
  // is what a future caller that only wants "roughly how big is this holder"
  // still gets for free.
  assert.strictEqual(await holdings.holdingOf(CHAIN, TOKEN, WALLET), 1000);
  answer = { value: 1500 };
  assert.strictEqual(await holdings.holdingOf(CHAIN, TOKEN, WALLET), 1000, "served from cache");
  assert.strictEqual(reads, 1);
});

test("a cached MISS short-circuits even a fresh read — a dead RPC is paid for once", async () => {
  // The failure cache is the half worth keeping: it exists so an unreachable
  // endpoint costs one six-second timeout rather than one per qualifying buy,
  // and that cost is the same whoever is asking.
  answer = { value: null };
  assert.strictEqual(await holdings.holdingOf(CHAIN, TOKEN, WALLET, { fresh: true }), null);
  assert.strictEqual(await holdings.holdingOf(CHAIN, TOKEN, WALLET, { fresh: true }), null);
  assert.strictEqual(reads, 1, "the second buy did not re-pay for the same dead endpoint");
});

test("the buy monitor asks for a fresh read", () => {
  // A source check, deliberately: the call happens inside buyerPosition behind a
  // whale-config gate and an RPC, and what matters is that this ONE call site
  // never quietly loses the flag — which is how the stale number got published.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "buyMonitor.js"), "utf8");
  assert.match(
    src,
    /holdings\.holdingOf\(g\.chain, g\.address, buy\.buyer, \{ fresh: true \}\)/,
    "the Position row must never be built from a cached balance",
  );
});
