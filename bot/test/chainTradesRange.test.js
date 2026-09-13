// A quiet EVM pool used to destroy itself, permanently.
//
// buyMonitor only advances the cursor when a poll finds buys. So on a pool
// nobody is trading, `fromBlock` stays put while the chain head runs away, and
// the eth_getLogs window grows by one poll interval, every poll, forever —
// until it passes what the node allows (5000 blocks on the public BSC
// dataseeds) and the node refuses it. That refusal is not a transport error, so
// rpcRead rethrows on the FIRST endpoint, fetchPoolBuys returns null, and the
// pool drops onto the rate-limited indexer. Cursors are persisted, so the stuck
// state survives every restart.
//
// Own file: it replaces `ethers` in require.cache, which must not leak into the
// other chainTrades tests (run-tests.js forks node --test per file).
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-ctrange-"));
// One endpoint, so a walk is visible as a repeat rather than hidden as variety.
process.env.RPC_BSC_URLS = "https://node-a.test";

const test = require("node:test");
const assert = require("node:assert");
const realEthers = require("ethers").ethers;

const TOKEN = "0x" + "aa".repeat(20);
const POOL = "0x" + "cc".repeat(20);

const state = {
  head: 0,
  calls: [], // every getLogs window asked for, in order
  throwTimes: 0, // how many leading getLogs calls throw
  throwWith: "",
  logs: [],
};

class FakeProvider {
  constructor(url) {
    this.url = url;
  }
  async getBlockNumber() {
    return state.head;
  }
  async getLogs({ fromBlock, toBlock }) {
    state.calls.push({ from: fromBlock, to: toBlock, span: toBlock - fromBlock, url: this.url });
    if (state.calls.length <= state.throwTimes) throw new Error(state.throwWith);
    return state.logs;
  }
  async getBlock() {
    return { timestamp: Math.floor(Date.now() / 1000) };
  }
  destroy() {}
}
// token0() / decimals() answer instantly so the test is only ever about getLogs.
class FakeContract {
  async token0() {
    return TOKEN; // the tracked token is token0
  }
  async decimals() {
    return 18;
  }
}
// Real ethers everywhere else — id(), Interface and formatUnits must stay
// genuine or the decoder under test is not the one that ships.
const ethersPath = require.resolve("ethers");
require.cache[ethersPath] = {
  id: ethersPath,
  filename: ethersPath,
  loaded: true,
  exports: { ethers: { ...realEthers, JsonRpcProvider: FakeProvider, Contract: FakeContract } },
};

const ct = require("../src/group/chainTrades");
const MAX_RANGE = 3000; // the shipped default; asserted against source below

function reset() {
  state.calls = [];
  state.throwTimes = 0;
  state.throwWith = "";
  state.logs = [];
  ct._reset();
}

const read = (sinceBlock) => ct.fetchPoolBuys("bsc", POOL, TOKEN, { sinceBlock });

test("the window is clamped — a pool quiet for a million blocks still asks something answerable", async () => {
  reset();
  state.head = 1_200_000;
  const out = await read(1_000_000); // 200k blocks behind: no node answers this
  assert.notStrictEqual(out, null, "a clamped read is a successful read");
  const [call] = state.calls;
  assert.strictEqual(call.to, state.head, "still reads up to the head");
  assert.ok(call.span <= MAX_RANGE, `span ${call.span} must be clamped to ${MAX_RANGE}`);
});

test("the clamp NARROWS only — a first sight keeps its own small window", async () => {
  // Math.max, not a plain assignment: widening a first sight to the cap would
  // make every newly-tracked pool read 3000 blocks of history it must not post.
  reset();
  state.head = 1_200_000;
  await read(0);
  assert.strictEqual(state.calls[0].span, 500, "FIRST_SIGHT_BLOCKS, not the cap");
});

test("a refused window is re-asked NARROWER, on the same node — never walked to the next", async () => {
  // The refusal is not a transport error. Asking three more endpoints the same
  // oversized question fails four times and spends the budget.
  reset();
  state.head = 1_200_000;
  state.throwTimes = 1;
  state.throwWith = "query returned more than 10000 results";
  const out = await read(1_000_000);
  assert.notStrictEqual(out, null, "the shrink-retry recovered the read");
  assert.strictEqual(state.calls.length, 2, "one refusal, one retry");
  assert.ok(state.calls[1].span < state.calls[0].span, "the retry is strictly narrower");
  assert.deepStrictEqual([...new Set(state.calls.map((c) => c.url))], ["https://node-a.test"], "same node");
});

test("a refusal that never clears gives up instead of retrying forever", async () => {
  // Bounded, because this runs inside rpcRead's per-endpoint timeout — and a
  // timeout DOES match TRANSPORT_RE, which would then walk every endpoint.
  reset();
  state.head = 1_200_000;
  state.throwTimes = 99;
  state.throwWith = "exceeds maximum block range";
  const out = await read(1_000_000);
  assert.strictEqual(out, null, "unreadable, so the caller falls back to the indexer");
  assert.ok(state.calls.length <= 3, `at most three attempts, got ${state.calls.length}`);
});

test("a NON-range error is not retried — it would fail identically every time", async () => {
  reset();
  state.head = 1_200_000;
  state.throwTimes = 99;
  state.throwWith = "execution reverted";
  const out = await read(1_000_000);
  assert.strictEqual(out, null);
  assert.strictEqual(state.calls.length, 1, "asked once, believed the answer");
});

test("the cap is configurable, because block times differ by an order of magnitude", () => {
  // 3000 blocks is 37min on BSC and 10h on Ethereum. It has to outlast
  // buyMonitor's MAX_ALERT_AGE_MS (30min) on the FASTEST chain, which is the
  // constraint the default is chosen against.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "chainTrades.js"), "utf8");
  assert.match(src, /CHAINTRADES_MAX_LOG_RANGE/, "an operator can raise it without a deploy");
  assert.match(src, /MAX_LOG_RANGE\s*=\s*Math\.max\(200,/, "and can never set it uselessly small");
});
