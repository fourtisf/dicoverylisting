// Finding a token's pool straight from the chain.
//
// THE FAILURE: /settoken could only find a pool by asking GeckoTerminal, with a
// DexScreener second opinion that does not cover every chain. A real pool with
// $415 of liquidity on Robinhood Chain is invisible to both, so the group was
// told "No live pool on that CA" about a pool that plainly exists. The token
// was not missing — the INDEXER's knowledge of it was, and that is a business
// decision about which tokens are worth indexing, taken by somebody else, about
// our customers.
//
// Own file: it replaces `ethers` in require.cache.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-cpool-"));
process.env.RPC_ROBINHOOD_URLS = "https://node-a.test";

const test = require("node:test");
const assert = require("node:assert");
const realEthers = require("ethers").ethers;

const TOKEN = "0x" + "3e".repeat(20);
const WETH = "0x" + "bb".repeat(20);
const PAIR_BIG = "0x" + "11".repeat(20);
const PAIR_DUST = "0x" + "22".repeat(20);
const coder = realEthers.AbiCoder.defaultAbiCoder();
const topicAddr = (a) => realEthers.zeroPadValue(String(a).toLowerCase(), 32);

const state = { logQueries: [], logs: [], balances: {}, reserves: null, calls: [], decimals: {} };

class FakeProvider {
  constructor(url) {
    this.url = url;
  }
  async getBlockNumber() {
    return 5_000_000;
  }
  async getLogs(f) {
    state.logQueries.push(f.topics);
    // Answer only the query whose topic layout actually matches a stored log.
    return state.logs.filter((l) =>
      f.topics.every((want, i) => {
        if (want == null) return true;
        const got = l.topics[i];
        return Array.isArray(want) ? want.includes(got) : want === got;
      }),
    );
  }
  destroy() {}
}
class FakeContract {
  constructor(address) {
    this.address = String(address).toLowerCase();
  }
  async token0() {
    return TOKEN; // the tracked token is always token0 in these fixtures
  }
  async token1() {
    return WETH;
  }
  async balanceOf(pool) {
    state.calls.push(["balanceOf", pool]);
    return state.balances[String(pool).toLowerCase()] ?? 0n;
  }
  async getReserves() {
    if (!state.reserves) throw new Error("execution reverted"); // i.e. a V3 pool
    return state.reserves;
  }
  async decimals() {
    return state.decimals[this.address] ?? 18;
  }
  async symbol() {
    return this.address === WETH.toLowerCase() ? "WETH" : "RUIN";
  }
  async name() {
    return this.address === WETH.toLowerCase() ? "Wrapped Ether" : "Ruinhood";
  }
  async totalSupply() {
    return 1_000_000n * 10n ** 18n;
  }
}
const ethersPath = require.resolve("ethers");
require.cache[ethersPath] = {
  id: ethersPath,
  filename: ethersPath,
  loaded: true,
  exports: { ethers: { ...realEthers, JsonRpcProvider: FakeProvider, Contract: FakeContract } },
};

const cp = require("../src/group/chainPools");
// The USD anchor for a wrapped-native counter. Stubbed, or every price test
// reaches CoinGecko — which in a sandbox means the suite hangs on a socket and
// in CI means a flake nobody can reproduce.
const nativeprice = require("../src/nativeprice");
nativeprice.usdPrices = async () => ({ ETH: 3000, BNB: 600, SOL: 200 });

const pairCreatedLog = (pair) => ({
  topics: [realEthers.id(cp.V2_CREATED), topicAddr(TOKEN), topicAddr(WETH)],
  data: coder.encode(["address", "uint256"], [pair, 1]),
  blockNumber: 100,
});
const initializeLog = () => ({
  topics: [realEthers.id(cp.V4_INIT), realEthers.zeroPadValue("0xdead", 32), topicAddr(TOKEN), topicAddr(WETH)],
  data: coder.encode(
    ["uint24", "int24", "address", "uint160", "int24"],
    [3000, 60, "0x" + "00".repeat(20), 79228162514264337593543950336n, 0],
  ),
  blockNumber: 100,
});

function reset() {
  state.logQueries = [];
  state.logs = [];
  state.balances = {};
  state.reserves = null;
  state.calls = [];
  state.decimals = {};
  cp._reset();
}

test("a pool the indexers have never heard of is found from the chain's own logs", async () => {
  reset();
  state.logs = [pairCreatedLog(PAIR_BIG)];
  const found = await cp.findPool("robinhood", TOKEN);
  assert.ok(found, "the pool exists on chain, so it must be findable");
  assert.strictEqual(String(found.poolAddress).toLowerCase(), PAIR_BIG.toLowerCase());
  assert.strictEqual(String(found.counterAddress).toLowerCase(), WETH.toLowerCase());
  assert.strictEqual(found.viaChain, true, "the caller can tell this did not come from an indexer");
});

test("the search names no factory — that is what makes it work on any fork", async () => {
  // A factory registry would need an entry per DEX per chain, researched and
  // maintained by hand, and every gap in it would look exactly like the bug
  // this replaces. Filtering on the token's own topic needs no such list.
  reset();
  state.logs = [pairCreatedLog(PAIR_BIG)];
  await cp.findPool("robinhood", TOKEN);
  for (const q of state.logQueries) {
    assert.ok(Array.isArray(q), "every query is topic-shaped");
  }
  // The claim, stated as the thing that would falsify it: no factory address is
  // baked in anywhere, so there is no registry to go stale or to have a gap.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "chainPools.js"), "utf8");
  const addressLiterals = (src.match(/0x[0-9a-fA-F]{40}/g) || []).filter((a) => !/^0x0+$/.test(a));
  assert.deepStrictEqual(addressLiterals, [], "no factory (or any) address is hardcoded");
});

test("the token is found in EITHER pool position — pools are created both ways round", async () => {
  reset();
  // token as token1 this time: the creation log's topics are the other way up.
  state.logs = [
    {
      topics: [realEthers.id(cp.V2_CREATED), topicAddr(WETH), topicAddr(TOKEN)],
      data: coder.encode(["address", "uint256"], [PAIR_BIG, 1]),
      blockNumber: 100,
    },
  ];
  const found = await cp.findPool("robinhood", TOKEN);
  assert.ok(found, "a pool created the other way round is still this token's pool");
  assert.strictEqual(String(found.counterAddress).toLowerCase(), WETH.toLowerCase(), "and the counter side is read correctly");
});

test("of several pools, the one actually holding the token wins", async () => {
  // A token routinely has a real pool and a dust pool somebody opened once.
  // Picking the first the node returned is arbitrary; picking the newest lets a
  // fresh dust pool beat the real one.
  reset();
  state.logs = [pairCreatedLog(PAIR_DUST), pairCreatedLog(PAIR_BIG)];
  state.balances = { [PAIR_DUST.toLowerCase()]: 5n, [PAIR_BIG.toLowerCase()]: 900_000n * 10n ** 18n };
  const found = await cp.findPool("robinhood", TOKEN);
  assert.strictEqual(String(found.poolAddress).toLowerCase(), PAIR_BIG.toLowerCase());
});

test("a v4-only token is REFUSED, not configured with something unwatchable", async () => {
  // A v4 pool is a mapping entry inside one PoolManager, identified by a
  // bytes32. chainTrades reads swaps with getLogs({address: pool}) — handing it
  // a bytes32 would configure a group whose alerts could never arrive, which is
  // worse than saying we could not place the token.
  reset();
  state.logs = [initializeLog()];
  assert.strictEqual(await cp.findPool("robinhood", TOKEN), null);
});

test("a chain with no pool for the token answers null, and remembers it briefly", async () => {
  reset();
  const first = await cp.findPool("robinhood", TOKEN);
  assert.strictEqual(first, null);
  const queries = state.logQueries.length;
  await cp.findPool("robinhood", TOKEN);
  assert.strictEqual(state.logQueries.length, queries, "the miss is cached — a sweep is the priciest read here");
});

// ── Pricing, without which the whole rescue is silent ────────────────────────

test("a rescued pool is PRICED from its own reserves", async () => {
  // buyMonitor holds any buy it cannot price. Finding the pool but not pricing
  // it turns "No live pool on that CA" into a group that configures cleanly,
  // reads every buy, and never posts one.
  reset();
  state.reserves = [1_000_000n * 10n ** 18n, 500n * 10n ** 18n, 0]; // 1M token / 500 WETH
  const px = await cp.readPool("robinhood", PAIR_BIG, TOKEN);
  assert.ok(px, "the pool knows what the token is worth");
  // Exact, not "> 0": 500 WETH at $3000 against 1,000,000 tokens is $1.50, and
  // a price that is merely positive is exactly how an off-by-a-decimal ships.
  assert.strictEqual(px.priceUsd, 1.5);
  assert.strictEqual(px.liquidity, 3_000_000, "both sides of a constant-product pool are worth the same");
  assert.strictEqual(px.mcap, 1_500_000, "supply × price");
  assert.strictEqual(px.viaChain, true);
  assert.strictEqual(px.change24h, null, "the chain has no 24h answer, so it does not invent a confident 0%");
});

test("a 6-decimal counter token does not misprice by a factor of a trillion", async () => {
  // The classic. USDC has 6 decimals and the token has 18; treating both as 18
  // lands on a number that is wrong by 10^12 and still looks like a price.
  reset();
  state.decimals = { [WETH.toLowerCase()]: 6 };
  state.reserves = [1_000_000n * 10n ** 18n, 1_500_000n * 10n ** 6n, 0]; // 1M token / 1.5M USDC
  const realSymbol = FakeContract.prototype.symbol;
  FakeContract.prototype.symbol = async function () {
    return this.address === WETH.toLowerCase() ? "USDC" : "RUIN";
  };
  try {
    const px = await cp.readPool("robinhood", PAIR_BIG, TOKEN);
    assert.strictEqual(px.priceUsd, 1.5, "1.5M USDC against 1M tokens is $1.50");
  } finally {
    FakeContract.prototype.symbol = realSymbol;
  }
});

test("a counter token with no USD anchor is priced as UNKNOWN, never guessed", async () => {
  // A token/token pool. A guess here misprices every alert the group receives,
  // which is worse than falling back to the indexer.
  reset();
  state.reserves = [1000n * 10n ** 18n, 1000n * 10n ** 18n, 0];
  const realSymbol = FakeContract.prototype.symbol;
  FakeContract.prototype.symbol = async function () {
    return this.address === WETH.toLowerCase() ? "SOMETOKEN" : "RUIN";
  };
  try {
    assert.strictEqual(await cp.readPool("robinhood", PAIR_BIG, TOKEN), null);
  } finally {
    FakeContract.prototype.symbol = realSymbol;
  }
});

test("the USD anchor accepts the chain's native coin wrapped or bare, and any stablecoin", async () => {
  assert.strictEqual(await cp.counterUsd("robinhood", "USDC"), 1);
  assert.strictEqual(await cp.counterUsd("robinhood", "usdt"), 1);
  // robinhood's native is ETH, so WETH and ETH both anchor…
  assert.strictEqual(await cp.counterUsd("robinhood", "WETH"), 3000);
  assert.strictEqual(await cp.counterUsd("robinhood", "ETH"), 3000);
  // …and BSC's is BNB, so the SAME counter ticker anchors differently there.
  assert.strictEqual(await cp.counterUsd("bsc", "WBNB"), 600);
  assert.strictEqual(await cp.counterUsd("bsc", "WETH"), null, "WETH is not BSC's native — no accidental anchor");
  // An unrelated ticker never anchors.
  assert.strictEqual(await cp.counterUsd("robinhood", "DOGE"), null);
});
