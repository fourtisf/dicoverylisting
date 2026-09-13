// "Nothing decoded" and "nothing could be READ" are opposite facts.
//
// THE FAILURE: a public Solana endpoint rate-limits a burst of getTransaction
// calls long before forty of them land. Every fetch failed, the reader returned
// an empty array, and an empty array means "the pool is quiet" — so buyMonitor
// advanced its cursor past buys it had never seen, and the group went silent
// permanently. No error, no fallback to the indexer, nothing in the log. A
// token configured perfectly simply never alerted, which is exactly how it was
// reported: "buy bot sudah di set tapi alert tidak ada".
//
// The distinction has to be drawn on transactions FETCHED, never on buys
// emitted: a window of forty sells reads perfectly and emits nothing, and
// calling that unreadable would put every dumping pool on the indexer.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-solunread-"));
process.env.RPC_SOLANA_URLS = "https://sol-a.test,https://sol-b.test";

const test = require("node:test");
const assert = require("node:assert");

const TOKEN = "So1TokenMint1111111111111111111111111111111";
const POOL = "So1Poo1Address111111111111111111111111111111";
const BUYER = "Buyer1111111111111111111111111111111111111";

const state = { sigs: [], txFor: () => null, getTxCalls: 0 };

class PublicKey {
  constructor(v) {
    this.v = String(v);
  }
  toBase58() {
    return this.v;
  }
}
class Connection {
  constructor(url) {
    this.url = url;
  }
  async getSignaturesForAddress() {
    return state.sigs;
  }
  async getTransaction(sig) {
    state.getTxCalls++;
    const tx = state.txFor(sig, this.url);
    if (tx === "throw") throw new Error("429 Too Many Requests");
    return tx;
  }
}
const solPath = require.resolve("@solana/web3.js");
require.cache[solPath] = {
  id: solPath,
  filename: solPath,
  loaded: true,
  exports: { PublicKey, Connection },
};

const ct = require("../src/group/chainTrades");

const now = Date.now();
const sig = (n) => ({ signature: `SIG${n}`, slot: 1000 + n, blockTime: Math.floor(now / 1000) - 60, err: null });
/** A transaction in which `payer` received `gained` of the token. */
const txWith = (gained) => ({
  meta: {
    fee: 5000,
    preBalances: [2_000_000_000, 0],
    postBalances: [1_000_000_000, 0],
    preTokenBalances: [{ mint: TOKEN, owner: BUYER, accountIndex: 0, uiTokenAmount: { uiAmount: 0 } }],
    postTokenBalances: [{ mint: TOKEN, owner: BUYER, accountIndex: 0, uiTokenAmount: { uiAmount: gained } }],
  },
  transaction: { message: { staticAccountKeys: [new PublicKey(BUYER), new PublicKey(POOL)] } },
});

function reset() {
  state.sigs = [sig(1), sig(2), sig(3)];
  state.getTxCalls = 0;
  ct._reset();
}
const read = () => ct.fetchPoolBuys("solana", POOL, TOKEN, { sinceSig: "OLD", sinceSlot: 1 });

test("an endpoint that refuses every transaction is UNREADABLE, not quiet", async () => {
  // The bug in one assertion. `[]` here tells buyMonitor to advance its cursor
  // past buys nobody has seen; `null` sends it to the indexer instead.
  reset();
  state.txFor = () => "throw";
  assert.strictEqual(await read(), null, "must not report a quiet pool");
});

test("…and it tries the OTHER endpoint before giving up", async () => {
  reset();
  const seen = new Set();
  state.txFor = (_s, url) => {
    seen.add(url);
    return "throw";
  };
  await read();
  assert.ok(seen.size > 1, `a refusing node is worth a second opinion: tried ${[...seen].join(", ")}`);
});

test("a recovering endpoint serves the buys rather than the pool looking dead", async () => {
  reset();
  state.txFor = (_s, url) => (url.includes("sol-a") ? "throw" : txWith(1000));
  const out = await read();
  assert.ok(Array.isArray(out), "the second node answered");
  assert.strictEqual(out.length, 3, "and every buy came through");
  assert.strictEqual(out[0].buyer, BUYER);
});

test("a window of all SELLS is quiet, not unreadable — the distinction that matters", async () => {
  // Counting emitted buys instead of fetched transactions would put every
  // dumping pool on the indexer and fire an hourly dead-pool warning at a
  // reader doing its job perfectly.
  reset();
  state.txFor = () => txWith(0); // fetched fine; nobody bought
  const out = await read();
  assert.deepStrictEqual(out, [], "read fine, nothing to post");
});

test("a partly-readable window keeps what it could read", async () => {
  reset();
  state.txFor = (s) => (s === "SIG2" ? "throw" : txWith(500));
  const out = await read();
  assert.strictEqual(out.length, 2, "one unreadable transaction is not a failed poll");
});
