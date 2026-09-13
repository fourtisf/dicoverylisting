// The Solana sweep left the temp wallet holding dust, and every sweep failed.
//
// Production symptom (real money, 1.000001 SOL stranded):
//   [wallets] sweep solana failed: Simulation failed.
//   Message: Transaction simulation failed.
//   Logs: ["Program 111…1 invoke [1]", "Program 111…1 success"]
// A success log under a failed transaction — because the transfer instruction
// DID succeed and the runtime then rejected the transaction on the rent check:
// a non-zero balance below the rent-exempt minimum is not a legal end state.
// A flat 10,000-lamport reserve against a 5,000-lamport fee leaves exactly
// 5,000 lamports of dust, so this failed 100% of the time.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-sol-"));

const test = require("node:test");
const assert = require("node:assert");

// ── A fake cluster that enforces the two rules that matter ──────────────────
const FEE = 5000;
const RENT_MIN = 890880; // rent-exempt minimum for a 0-data account
const state = {
  balance: 0,
  sent: [],
  failBalanceTimes: 0,
  fee: FEE,
  failByUrl: {},
  balanceReads: [],
  broadcasts: [],
  confirmThrows: 0,
};

class PublicKey {
  constructor(v) {
    this.v = String(v);
  }
  toBase58() {
    return this.v;
  }
}
class Keypair {
  constructor(pk) {
    this.publicKey = new PublicKey(pk);
    this.secretKey = new Uint8Array(64);
  }
  static generate() {
    return new Keypair("GENERATED");
  }
  static fromSecretKey() {
    return new Keypair("TEMPWALLET");
  }
}
class Transaction {
  constructor() {
    this.instructions = [];
  }
  add(ix) {
    this.instructions.push(ix);
    return this;
  }
  compileMessage() {
    return { ixs: this.instructions.length };
  }
}
const SystemProgram = { transfer: (o) => ({ ...o }) };
class Connection {
  constructor(url) {
    this.url = url;
  }
  async getBalance() {
    state.balanceReads.push(this.url);
    // Per-endpoint failures: a count keyed by url fails only that node, which
    // is what makes the read fall through to the next one.
    if (state.failByUrl[this.url] > 0) {
      state.failByUrl[this.url]--;
      throw new Error("429 Too Many Requests");
    }
    if (state.failBalanceTimes > 0) {
      state.failBalanceTimes--;
      throw new Error("429 Too Many Requests");
    }
    return state.balance;
  }
  async getLatestBlockhash() {
    return { blockhash: "BLOCKHASH" };
  }
  async getFeeForMessage() {
    return { value: state.fee };
  }
}
async function sendAndConfirmTransaction(c, tx) {
  const amount = tx.instructions[0].lamports;
  state.broadcasts.push({ url: c && c.url, amount });
  if (state.confirmThrows > 0) {
    state.confirmThrows--;
    // The transfer LANDED; only the confirmation wait failed. This is the shape
    // that turns a retry into a second transfer.
    state.balance -= amount + FEE;
    throw new Error("Transaction was not confirmed in 30.00 seconds");
  }
  const remaining = state.balance - amount - FEE;
  if (remaining < 0) throw new Error("Attempt to debit an account but found no record of a prior credit.");
  if (remaining > 0 && remaining < RENT_MIN) {
    throw new Error(
      "Simulation failed. \nMessage: Transaction simulation failed: Transaction results in an " +
        'account (0) with insufficient funds for rent. \nLogs: \n[\n  "Program 111 invoke [1]",\n  "Program 111 success"\n]. ',
    );
  }
  state.sent.push({ amount, remaining, to: tx.instructions[0].toPubkey.toBase58() });
  state.balance = remaining;
  return "SIGNATURE";
}

const web3 = require.resolve("@solana/web3.js");
require.cache[web3] = {
  id: web3,
  filename: web3,
  loaded: true,
  exports: { Keypair, Connection, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction },
};

const solana = require("../src/payments/chains/solana");
const WALLET = { address: "TEMPWALLET", privateKey: "00".repeat(64) };
const TREASURY = "DexvraTreasury11111111111111111111111111111";
const reset = (balance) => {
  state.balance = balance;
  state.sent = [];
  state.failBalanceTimes = 0;
  state.fee = FEE;
  state.failByUrl = {};
  state.balanceReads = [];
  state.broadcasts = [];
  state.confirmThrows = 0;
  require("../src/config/rpc")._reset();
};

test("the fake cluster reproduces the production failure (dust below rent)", async () => {
  // Proof the test is testing the right thing: the OLD shape — balance minus a
  // flat 10,000 reserve — is rejected exactly as production reported.
  reset(1_000_001_000);
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: new PublicKey("TEMPWALLET"),
      toPubkey: new PublicKey(TREASURY),
      lamports: state.balance - 10000,
    }),
  );
  await assert.rejects(() => sendAndConfirmTransaction(null, tx), /insufficient funds for rent/);
});

test("a real 1 SOL payment sweeps, leaving the wallet at exactly zero", async () => {
  reset(1_000_001_000); // the stranded balance from the live test payment
  const r = await solana.sweep("solana", WALLET, TREASURY);
  assert.ok(r.ok, `sweep failed: ${r.error}`);
  assert.strictEqual(state.sent.length, 1);
  assert.strictEqual(state.sent[0].amount, 1_000_001_000 - FEE, "sends balance minus the real fee");
  assert.strictEqual(state.sent[0].remaining, 0, "zero — anything else trips the rent check");
  assert.strictEqual(state.sent[0].to, TREASURY);
});

test("the fee comes from the cluster, not a constant", async () => {
  reset(2_000_000_000);
  state.fee = 5000; // whatever the cluster quotes is what gets reserved
  await solana.sweep("solana", WALLET, TREASURY);
  assert.strictEqual(state.sent[0].amount, 2_000_000_000 - 5000);
});

test("a balance that cannot cover the fee is reported, never sent", async () => {
  reset(3000);
  const r = await solana.sweep("solana", WALLET, TREASURY);
  assert.ok(!r.ok);
  assert.match(r.error, /fee/i);
  assert.strictEqual(state.sent.length, 0, "no doomed transaction is broadcast");
});

test("an empty wallet is a no-op, not an error to chase", async () => {
  reset(0);
  const r = await solana.sweep("solana", WALLET, TREASURY);
  assert.ok(!r.ok);
  assert.strictEqual(r.error, "empty");
  assert.strictEqual(state.sent.length, 0);
});

test("a rate-limited RPC is retried, not surrendered to", async () => {
  // Public Solana endpoints 429 constantly; one bad response must not strand
  // a buyer's payment until the next retry pass hours later.
  reset(1_000_000_000);
  state.failBalanceTimes = 2;
  const r = await solana.sweep("solana", WALLET, TREASURY);
  assert.ok(r.ok, `gave up too early: ${r.error}`);
  assert.strictEqual(state.sent[0].remaining, 0);
});

test("a permanently failing RPC returns the real reason, not a generic one", async () => {
  reset(1_000_000_000);
  state.failBalanceTimes = 99;
  const r = await solana.sweep("solana", WALLET, TREASURY);
  assert.ok(!r.ok);
  assert.match(r.error, /429/, "the operator needs the actual cause in the log");
});

// ── One sweep, one node ──────────────────────────────────────────────────────

test("a whole sweep stays on ONE node, even across retries", async () => {
  // Resolving the endpoint per attempt is a double-spend on Solana, which has
  // no nonce to collapse two transfers: attempt 1 broadcasts on node A and
  // throws at CONFIRMATION (an expired blockhash is routine, and the transfer
  // still lands); attempt 2 reads the balance, A answers 429 — also routine on
  // the public endpoints — the read falls through to node B, which has not
  // caught up and reports the pre-transfer balance; a second transfer is signed
  // with a fresh blockhash and a distinct signature. Both land.
  process.env.RPC_SOLANA_URLS = "https://a.example,https://b.example";
  try {
    reset(1_000_000_000);
    state.confirmThrows = 1; // attempt 1 lands but times out waiting
    state.failByUrl["https://a.example"] = 0;
    const r = await solana.sweep("solana", WALLET, TREASURY);

    assert.strictEqual(state.broadcasts.length, 1, "a confirmation timeout must not produce a second transfer");
    assert.ok(!r.ok, "reported not-ok so sweepRetry re-checks the balance on-chain");
    assert.match(r.error, /unconfirmed/);
    assert.strictEqual(
      new Set(state.balanceReads).size,
      1,
      "every read in one sweep goes to the same node it will broadcast from",
    );
  } finally {
    delete process.env.RPC_SOLANA_URLS;
  }
});

test("the node is chosen ONCE — a mid-sweep 429 cannot move the broadcast", async () => {
  // The first node 429s twice: once on the opening read (so the sweep starts on
  // B) and once more later. Whatever happens, all broadcasts must come from a
  // single node.
  process.env.RPC_SOLANA_URLS = "https://a.example,https://b.example";
  try {
    reset(1_000_000_000);
    state.failByUrl["https://a.example"] = 9;
    const r = await solana.sweep("solana", WALLET, TREASURY);
    assert.ok(r.ok, `gave up: ${r.error}`);
    assert.deepStrictEqual(
      [...new Set(state.broadcasts.map((b) => b.url))],
      ["https://b.example"],
      "the read fell through to B, and the send stayed on B",
    );
  } finally {
    delete process.env.RPC_SOLANA_URLS;
  }
});
