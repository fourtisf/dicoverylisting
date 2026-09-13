// Tron sweep audit. The adapter reserved a flat 1.5 TRX on every sweep, but a
// TRX transfer is normally FREE — every account gets ~600 free bandwidth a day
// and a transfer costs ~268 of it. So ~1.5 TRX was stranded in every temp
// wallet on every order, permanently, for a fee that was never charged.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-tron-"));

const test = require("node:test");
const assert = require("node:assert");

const TRX = 1000000n; // sun
// minReserve = the smallest reserve this fake cluster will accept, i.e. what
// the network would really charge. 0 models the free-bandwidth case.
const state = { balance: 0n, minReserve: 0n, sent: [], balanceFailures: 0 };

class TronWeb {
  constructor() {
    this.trx = {
      getBalance: async () => {
        if (state.balanceFailures > 0) {
          state.balanceFailures--;
          throw new Error("503 from trongrid");
        }
        return Number(state.balance);
      },
      sendTransaction: async (to, amount) => {
        const reserve = state.balance - BigInt(amount);
        if (reserve < state.minReserve) return { result: false, code: "balance is not sufficient" };
        state.sent.push({ to, amount: BigInt(amount), reserve });
        return { result: true, txid: "TXID" };
      },
    };
  }
  async createAccount() {
    return { address: { base58: "TFake" }, privateKey: "aa" };
  }
}
TronWeb.utils = { accounts: { generateAccount: () => ({ address: { base58: "TFake" }, privateKey: "aa" }) } };

const tronPath = require.resolve("tronweb");
require.cache[tronPath] = { id: tronPath, filename: tronPath, loaded: true, exports: { TronWeb } };

const tron = require("../src/payments/chains/tron");
const WALLET = { address: "TTemp", privateKey: "aa" };
const TREASURY = "TTreasury";
const reset = (balance, minReserve = 0n) => {
  state.balance = balance;
  state.minReserve = minReserve;
  state.sent = [];
  state.balanceFailures = 0;
};

test("the normal case sweeps everything — free bandwidth means no fee", async () => {
  reset(100n * TRX);
  const r = await tron.sweep("tron", WALLET, TREASURY);
  assert.ok(r.ok, r.error);
  assert.strictEqual(state.sent.length, 1);
  assert.strictEqual(state.sent[0].amount, 100n * TRX, "the whole balance, not balance − 1.5 TRX");
  assert.strictEqual(state.sent[0].reserve, 0n);
});

test("when bandwidth is exhausted it steps up to the burn cost, not past it", async () => {
  reset(100n * TRX, 300000n); // 0.3 TRX burn
  const r = await tron.sweep("tron", WALLET, TREASURY);
  assert.ok(r.ok, r.error);
  assert.strictEqual(state.sent.length, 1, "the free rung is refused before broadcast — it costs nothing");
  assert.strictEqual(state.sent[0].reserve, 400000n, "0.4 TRX rung, not the old flat 1.5");
});

test("an unactivated treasury still gets swept, via the top rung", async () => {
  reset(100n * TRX, 1100000n); // 1 TRX account-creation fee + bandwidth
  const r = await tron.sweep("tron", WALLET, TREASURY);
  assert.ok(r.ok, r.error);
  assert.strictEqual(state.sent[0].reserve, 1500000n);
});

test("a rung that costs more than the wallet holds is skipped, not sent", async () => {
  reset(200000n, 0n); // 0.2 TRX total
  const r = await tron.sweep("tron", WALLET, TREASURY);
  assert.ok(r.ok, r.error);
  assert.strictEqual(state.sent[0].amount, 200000n, "swept on the free rung");
});

test("a balance smaller than any possible fee is dust", async () => {
  reset(100000n, 200000n); // 0.1 TRX, fee 0.2 TRX
  const r = await tron.sweep("tron", WALLET, TREASURY);
  assert.ok(!r.ok);
  assert.strictEqual(r.dust, true);
  assert.strictEqual(state.sent.length, 0);
});

test("an empty wallet is a no-op", async () => {
  reset(0n);
  const r = await tron.sweep("tron", WALLET, TREASURY);
  assert.ok(!r.ok);
  assert.strictEqual(r.error, "empty");
});

test("a flaky node is retried", async () => {
  reset(50n * TRX);
  state.balanceFailures = 1;
  const r = await tron.sweep("tron", WALLET, TREASURY);
  assert.ok(r.ok, `gave up too early: ${r.error}`);
});
