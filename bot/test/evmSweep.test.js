// EVM sweep audit. Same class of defect as the Solana one that stranded a real
// payment: the adapter guessed what to hold back for gas instead of asking, and
// the guess was double the real cost — so every order left a full extra
// transaction's worth of ETH/BNB in a temp wallet, permanently.
//
// Two further findings pinned here: a hardcoded 21,000 gas silently fails when
// the treasury is a contract (Safe/multisig), and an unknown chain used to fall
// back to the Ethereum RPC — reporting "empty" while the funds sat on the real
// chain.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-evm-"));

const test = require("node:test");
const assert = require("node:assert");

const GWEI = 1000000000n;
const state = {
  balance: 0n,
  feeData: { maxFeePerGas: 20n * GWEI, maxPriorityFeePerGas: 1n * GWEI, gasPrice: 15n * GWEI },
  gasEstimate: 21000n,
  baseFee: 10n * GWEI,
  blockThrows: false,
  estimateThrows: false,
  balanceFailures: 0,
  // OP-stack only. "0x" is "this chain has no GasPriceOracle predeploy", which is
  // the true answer for Ethereum, BSC and Robinhood (Nitro folds the L1 cost into
  // the gas units) — so every pre-existing test below runs the same arithmetic it
  // always did, and that is the point: the L1 term must be a no-op where it must.
  oracleCode: "0x",
  oracleThrows: false,
  l1Fee: 0n,
  l1Calls: 0,
  sendThrows: null,
  waitThrows: null,
  sent: [],
  lastEstimateArgs: null,
};

class JsonRpcProvider {
  constructor(url) {
    this.url = url;
  }
  async getBalance() {
    if (state.balanceFailures > 0) {
      state.balanceFailures--;
      throw new Error("SERVER_ERROR 429");
    }
    return state.balance;
  }
  async getFeeData() {
    return state.feeData;
  }
  async getBlock() {
    if (state.blockThrows) throw new Error("no block");
    return { baseFeePerGas: state.baseFee };
  }
  async estimateGas(tx) {
    state.lastEstimateArgs = tx;
    if (state.estimateThrows) throw new Error("execution reverted");
    return state.gasEstimate;
  }
  async getCode() {
    if (state.oracleThrows) throw new Error("SERVER_ERROR 403");
    return state.oracleCode;
  }
}
class Contract {
  constructor(address) {
    this.target = address;
  }
  async getL1Fee() {
    state.l1Calls += 1;
    return state.l1Fee;
  }
}
const Transaction = {
  from: (req) => ({ unsignedSerialized: "0x" + "ab".repeat(90), req }),
};
class Wallet {
  constructor(pk, provider) {
    this.privateKey = pk;
    this.provider = provider;
    this.address = "0xTEMPWALLET";
  }
  static createRandom() {
    return { address: "0xNEW", privateKey: "0xKEY" };
  }
  async sendTransaction(tx) {
    if (state.sendThrows) throw new Error(state.sendThrows);
    state.sent.push(tx);
    return {
      hash: "0xHASH",
      async wait() {
        if (state.waitThrows) throw new Error(state.waitThrows);
        return { status: 1 };
      },
    };
  }
}

const ethersPath = require.resolve("ethers");
require.cache[ethersPath] = {
  id: ethersPath,
  filename: ethersPath,
  loaded: true,
  exports: { ethers: { JsonRpcProvider, Wallet, Contract, Transaction } },
};

const evm = require("../src/payments/chains/evm");
const WALLET = { address: "0xTEMPWALLET", privateKey: "0xKEY" };
const TREASURY = "0xTREASURY";
function reset(balance) {
  state.balance = balance;
  state.feeData = { maxFeePerGas: 20n * GWEI, maxPriorityFeePerGas: 1n * GWEI, gasPrice: 15n * GWEI };
  state.gasEstimate = 21000n;
  state.baseFee = 10n * GWEI;
  state.blockThrows = false;
  state.estimateThrows = false;
  state.balanceFailures = 0;
  state.oracleCode = "0x";
  state.oracleThrows = false;
  state.l1Fee = 0n;
  state.l1Calls = 0;
  state.sendThrows = null;
  state.waitThrows = null;
  state.sent = [];
  evm._test_forgetL1Oracle();
}

test("the fee cap is 1.5× base fee + tip, not the RPC's generous 2×", async () => {
  // Whatever cap is signed, the node RESERVES gasLimit × cap and charges only
  // gasLimit × (base + tip); the refund lands back in the temp wallet as dust
  // worth less than the gas to collect it. So the cap is money left behind on
  // every order, and halving the headroom halves it.
  reset(1000000000000000000n); // 1 ETH, base 10 gwei, tip 1 gwei
  const r = await evm.sweep("ethereum", WALLET, TREASURY);
  assert.ok(r.ok, r.error);
  const cap = 16n * GWEI; // 10 × 1.5 + 1
  assert.strictEqual(state.sent[0].maxFeePerGas, cap, "signed with the tightened cap");
  assert.strictEqual(state.sent[0].value, 1000000000000000000n - 21000n * cap, "…and reserves exactly that");
  // The value must still clear the node's own check: value + gas × cap ≤ balance.
  assert.ok(state.sent[0].value + 21000n * cap <= state.balance);
  // What is actually left: gas × (cap − base − tip) = 21,000 × 5 gwei.
  const leftBehind = 21000n * (cap - 11n * GWEI);
  assert.strictEqual(leftBehind, 105000000000000n, "0.000105 ETH — half of what the RPC quote would strand");
});

test("the cap still covers a base fee that rises while the tx waits", async () => {
  // The protocol caps the rise at 12.5% per block, so 1.5× survives ~3 blocks
  // of worst case. Pinned as a number so nobody tightens it into a stuck sweep.
  reset(1000000000000000000n);
  await evm.sweep("ethereum", WALLET, TREASURY);
  const cap = Number(state.sent[0].maxFeePerGas) / 1e9;
  let base = 10;
  for (let block = 0; block < 3; block++) base *= 1.125;
  assert.ok(cap >= base, `cap ${cap} gwei must outlast 3 blocks of max increase (${base.toFixed(2)} gwei)`);
});

test("if the base fee cannot be read, the RPC's own cap is used — never a guess", async () => {
  reset(1000000000000000000n);
  state.blockThrows = true;
  const r = await evm.sweep("ethereum", WALLET, TREASURY);
  assert.ok(r.ok, r.error);
  assert.strictEqual(state.sent[0].maxFeePerGas, 20n * GWEI, "falls back to getFeeData's quote");
});

test("a legacy-gas chain sweeps clean, with nothing left behind", async () => {
  // No EIP-1559 fields → the price charged IS the price reserved, so the wallet
  // ends at exactly zero.
  reset(500000000000000000n);
  state.feeData = { maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: 3n * GWEI };
  const r = await evm.sweep("bsc", WALLET, TREASURY);
  assert.ok(r.ok, r.error);
  const cost = 21000n * 3n * GWEI;
  assert.strictEqual(state.sent[0].value, 500000000000000000n - cost);
  assert.strictEqual(state.sent[0].gasPrice, 3n * GWEI);
  assert.strictEqual(state.sent[0].maxFeePerGas, undefined, "no 1559 fields on a legacy chain");
});

test("a contract treasury gets the gas it needs, not a hardcoded 21000", async () => {
  // Sending to a Safe/multisig runs code on receive. 21,000 is the intrinsic
  // cost of an EOA send — with a contract recipient it reverts out of gas and
  // burns the fee, every single time, delivering nothing.
  reset(1000000000000000000n);
  state.gasEstimate = 55000n;
  const r = await evm.sweep("ethereum", WALLET, TREASURY);
  assert.ok(r.ok, r.error);
  assert.strictEqual(state.sent[0].gasLimit, (55000n * 12n) / 10n, "estimate + 20% headroom");
  assert.strictEqual(state.lastEstimateArgs.to, TREASURY, "estimated against the real recipient");
});

// ⚠️ THE PREMISE HERE CHANGED, AND 21,000 WAS THE DEFECT.
//
// "Still goes out" is right; "at the plain-transfer cost" was a guess, and on a
// Nitro/Orbit chain it is the wrong one — Robinhood Chain charges the L1 poster
// cost in GAS UNITS, so 21,000 is below the floor there and the transfer runs
// OUT OF GAS, burning the gas without delivering, on every sweepRetry pass
// forever. Robinhood's node is already documented in this repo as answering
// eth_estimateGas with a non-standard envelope, which is exactly the input that
// reaches this branch. The errors are not symmetric: unused gas is refunded, so
// an over-reserve is dust, and an under-reserve is unrecoverable.
test("an un-estimatable send goes out on a limit that lands, not the bare 21,000", async () => {
  reset(1000000000000000000n);
  state.estimateThrows = true;
  const r = await evm.sweep("robinhood", WALLET, TREASURY);
  assert.ok(r.ok, r.error);
  assert.strictEqual(state.sent[0].gasLimit, evm.UNMEASURED_GAS);
  assert.ok(evm.UNMEASURED_GAS > 21000n, "…and that limit clears a Nitro chain's own floor");
  // Still a sweep, not a refusal: the value is everything the limit leaves.
  assert.strictEqual(state.sent[0].value, state.balance - evm.UNMEASURED_GAS * state.sent[0].maxFeePerGas);
});

// ── the third term in an OP-stack node's balance check ──────────────────────
//
// op-geth checks `value + gas × gasFeeCap + l1Cost`. Reserving only the first
// two and setting `value = bal − gas × cap` leaves EXACTLY ZERO slack, so any
// non-zero l1Cost rejects the sweep — deterministically, on every Base order.
const OP_ORACLE_CODE = "0x60806040";

test("an OP-stack sweep reserves the L1 data fee as well", async () => {
  reset(1000000000000000000n);
  state.oracleCode = OP_ORACLE_CODE;
  state.l1Fee = 700000000000000n; // 0.0007 ETH
  const r = await evm.sweep("base", WALLET, TREASURY);
  assert.ok(r.ok, r.error);
  const cap = state.sent[0].maxFeePerGas;
  const l2 = 21000n * cap;
  assert.strictEqual(state.sent[0].value, state.balance - l2 - state.l1Fee - state.l1Fee / 4n);
  // The node's own check, with all THREE terms — which is what used to fail.
  assert.ok(state.sent[0].value + l2 + state.l1Fee <= state.balance, "clears value + gas×cap + l1Cost");
});

test("a chain with no oracle predeploy is left exactly as it was", async () => {
  reset(1000000000000000000n);
  state.l1Fee = 700000000000000n; // would be charged if it were ever asked for
  const r = await evm.sweep("ethereum", WALLET, TREASURY);
  assert.ok(r.ok, r.error);
  assert.strictEqual(state.l1Calls, 0, "the oracle is never called where there is none");
  assert.strictEqual(state.sent[0].value, state.balance - 21000n * state.sent[0].maxFeePerGas);
});

// ⚠️ "The node did not answer" and "this chain has no oracle" are different
// facts, and caching the second for the first would disable L1 accounting on
// Base for the life of the process after one transient 403 — silently, on the
// path where being short by the L1 fee means the sweep does not send.
test("a failed oracle probe is not remembered as a chain without one", async () => {
  reset(1000000000000000000n);
  state.oracleThrows = true;
  const first = await evm.l1DataFee("base", new JsonRpcProvider("u"), {});
  assert.strictEqual(first.ok, false, "reported as unread, never as zero");
  state.oracleThrows = false;
  state.oracleCode = OP_ORACLE_CODE;
  state.l1Fee = 5n;
  const second = await evm.l1DataFee("base", new JsonRpcProvider("u"), {});
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.fee, 5n, "the next read is made, and it answers");
});

test("an L1 fee we could not read stands in at the L2 cost, never at zero", async () => {
  reset(1000000000000000000n);
  state.oracleCode = OP_ORACLE_CODE;
  state.oracleThrows = false;
  // Probe succeeds, the CALL fails: this chain has an oracle and we got no number.
  const p = new JsonRpcProvider("u");
  await evm.l1DataFee("base", p, {}); // caches has=true
  const orig = Contract.prototype.getL1Fee;
  Contract.prototype.getL1Fee = async () => {
    throw new Error("call reverted");
  };
  try {
    const r = await evm.sweep("base", WALLET, TREASURY);
    assert.ok(r.ok, r.error);
    const l2 = 21000n * state.sent[0].maxFeePerGas;
    assert.strictEqual(state.sent[0].value, state.balance - l2 - l2 - l2 / 4n, "the L2 cost stands in");
  } finally {
    Contract.prototype.getL1Fee = orig;
  }
});

test("a balance below its own gas cost is dust, not a failure to retry forever", async () => {
  reset(1000n);
  const r = await evm.sweep("ethereum", WALLET, TREASURY);
  assert.ok(!r.ok);
  assert.strictEqual(r.dust, true, "flagged so sweepRetry stops re-checking it");
  assert.strictEqual(state.sent.length, 0);
});

test("an unknown chain fails loudly instead of sweeping on Ethereum", async () => {
  // The old fallback read the Ethereum balance for an unconfigured chain,
  // reported "empty", and left the real funds untouched and unmentioned.
  reset(1000000000000000000n);
  const r = await evm.sweep("some-new-l2", WALLET, TREASURY);
  assert.ok(!r.ok);
  assert.match(r.error, /no RPC configured/i);
  assert.strictEqual(state.sent.length, 0);
  await assert.rejects(() => evm.getBalance("some-new-l2", "0x1"), /no RPC configured/i);
});

test("a rate-limited RPC is retried before giving up", async () => {
  reset(1000000000000000000n);
  state.balanceFailures = 2;
  const r = await evm.sweep("base", WALLET, TREASURY);
  assert.ok(r.ok, `gave up too early: ${r.error}`);
});

test("a broadcast that does not confirm is never retried, and never claimed", async () => {
  // Retrying past a broadcast reuses the nonce and fights its own pending tx.
  // Claiming success would stop the retry pass from ever re-checking, so it
  // reports not-ok WITH the hash and lets the balance be the judge.
  reset(1000000000000000000n);
  state.waitThrows = "timeout";
  const r = await evm.sweep("ethereum", WALLET, TREASURY);
  assert.ok(!r.ok);
  assert.strictEqual(r.txid, "0xHASH", "the hash is still reported so it can be traced");
  assert.strictEqual(state.sent.length, 1, "exactly one broadcast");
});

test("an empty wallet is a no-op", async () => {
  reset(0n);
  const r = await evm.sweep("ethereum", WALLET, TREASURY);
  assert.ok(!r.ok);
  assert.strictEqual(r.error, "empty");
});
