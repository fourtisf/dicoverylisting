'use strict';
/*
 * What the background cycles are allowed to skip, and what they are allowed to
 * spend.
 *
 * Both watchers here are bounded on purpose — an unbounded price poll would melt
 * the RPC, and an unbounded DCA would drain a wallet. Bounds are fine. What is
 * not fine is a bound that costs the SAME users the feature every time, or one
 * that is enforced a moment too late to matter.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wbudget-'));
process.env.WALLET_SECRET = 'w'.repeat(48);
process.env.TRADEBOT_TOKEN = 'x:y';
process.env.ENABLED_CHAINS = 'robinhood';
process.env.ORDER_MAX_READS = '20';       // a small budget makes the starvation visible

const core = require('./core');
const watchers = require('./watchers');

const wallet = () => [{ id: 'w1', name: 'W', address: '0x' + '11'.repeat(20), positions: {}, orders: [], history: [] }];

// ---------------------------------------------------------------- read budget
test('the price-read budget does not starve the same orders for ever', async () => {
  // ordersCycle prices each order's token, capped at ORDER_MAX_READS distinct
  // reads per cycle. Users are iterated in insertion order and that order never
  // changes, so once there were more tokens than budget it was always the same
  // tail that went unpriced — the same stop-losses, every cycle, silently.
  //
  // Measured on the previous commit: 20 of 60 tokens were EVER priced across
  // five cycles. Forty stop-losses that the owner believed were armed had not
  // been looked at once.
  core.DB.users = {};
  const priced = new Set();
  const realSnap = core.tokenSnapshot;
  core.tokenSnapshot = async (ca) => { priced.add(String(ca).toLowerCase()); return { priceEth: 1, mcapEth: 1 }; };
  for (let i = 0; i < 60; i++) {
    const u = core.ensureUser(1000 + i);
    u.wallets = wallet(); u.activeWalletId = 'w1';
    u.wallets[0].orders = [{ id: 'o' + i, type: 'sl', chain: 'robinhood', sym: 'T' + i,
      ca: '0x' + String(i).padStart(2, '0').repeat(20), targetPriceEth: 0 }];   // target 0 → never fires, we are measuring COVERAGE
  }
  try { for (let c = 0; c < 5; c++) await watchers._test.ordersCycle(); }
  finally { core.tokenSnapshot = realSnap; }
  assert.equal(priced.size, 60, `only ${priced.size}/60 orders were ever evaluated — the rest are permanently starved`);
});

test('rotation covers everything within ceil(total / budget) cycles', async () => {
  // The bound still holds per cycle — this is about fairness, not about lifting
  // the cap. 60 tokens on a 20-read budget must take three cycles, not one.
  core.DB.users = {};
  const perCycle = [];
  const realSnap = core.tokenSnapshot;
  core.tokenSnapshot = async (ca) => { perCycle[perCycle.length - 1].add(String(ca).toLowerCase()); return { priceEth: 1, mcapEth: 1 }; };
  for (let i = 0; i < 60; i++) {
    const u = core.ensureUser(2000 + i);
    u.wallets = wallet(); u.activeWalletId = 'w1';
    u.wallets[0].orders = [{ id: 'o' + i, type: 'sl', chain: 'robinhood', sym: 'T' + i,
      ca: '0x' + String(i).padStart(2, '0').repeat(20), targetPriceEth: 0 }];
  }
  try { for (let c = 0; c < 3; c++) { perCycle.push(new Set()); await watchers._test.ordersCycle(); } }
  finally { core.tokenSnapshot = realSnap; }
  for (const s of perCycle) assert.ok(s.size <= 20, `a cycle read ${s.size} tokens on a 20-read budget`);
  const all = new Set(perCycle.flatMap((s) => [...s]));
  assert.equal(all.size, 60, 'three cycles at 20 reads must cover all 60 exactly once');
});

test('held positions rotate too — auto-protect is not optional for the tail', async () => {
  // positionsCycle shares the reader, and it carries the rug guard. A position
  // that is never priced is a position the guard never sees.
  core.DB.users = {};
  const priced = new Set();
  const realSnap = core.tokenSnapshot;
  core.tokenSnapshot = async (ca) => { priced.add(String(ca).toLowerCase()); return { priceEth: 1, mcapEth: 1 }; };
  for (let i = 0; i < 50; i++) {
    const u = core.ensureUser(3000 + i);
    u.wallets = wallet(); u.activeWalletId = 'w1';
    u.settings = { ...(u.settings || {}), autoProtect: true, notify: { alerts: true, snipe: true, copy: true } };
    const ca = '0x' + String(i).padStart(2, '0').repeat(20);
    u.wallets[0].positions[core.posKey('robinhood', ca)] =
      { chain: 'robinhood', ca, sym: 'T' + i, dec: 18, ethIn: 1, ethOut: 0, costEth: 1, tokens: '1000000000000000000' };
  }
  try { for (let c = 0; c < 3; c++) await watchers._test.positionsCycle(); }
  finally { core.tokenSnapshot = realSnap; }
  assert.equal(priced.size, 50, `${50 - priced.size} guarded positions were never priced`);
});

// ---------------------------------------------------------------- DCA budget
test('DCA treats its budget as a ceiling, not as a suggestion', async () => {
  // The plan checked whether it was FINISHED after this round, then sent the
  // round at full size anyway: a 0.1 budget with 0.03 clips spent 0.12. The last
  // round now buys what is left of the budget.
  core.DB.users = {};
  const u = core.ensureUser(77);
  u.wallets = wallet(); u.activeWalletId = 'w1';
  u.dca = [{ id: 'd1', ca: '0x' + 'ab'.repeat(20), sym: 'T', chain: 'robinhood', walletId: 'w1',
    amount: '0.03', intervalMin: 0, roundsLeft: 10, rounds: 10, budget: 0.1, spent: 0, nextAt: 0 }];
  let total = 0;
  const realBuy = core.buy;
  core.buy = async (chatId, ca, amt) => { total += Number(amt); return { sym: 'T', gotTokens: 1, spentEth: Number(amt), native: 'ETH', hash: '0x' + '1'.repeat(64) }; };
  try { for (let c = 0; c < 8; c++) await watchers._test.dcaCycle(); }
  finally { core.buy = realBuy; }
  assert.ok(total <= 0.1 + 1e-9, `DCA spent ${total} against a 0.1 budget`);
  assert.ok(total > 0.099, `DCA stopped short at ${total} — the budget is a ceiling, not a target to undershoot`);
});

test('a round-limited plan still runs exactly its rounds', async () => {
  // The budget guard must not quietly shorten a plan that has no budget set.
  core.DB.users = {};
  const u = core.ensureUser(78);
  u.wallets = wallet(); u.activeWalletId = 'w1';
  u.dca = [{ id: 'd2', ca: '0x' + 'cd'.repeat(20), sym: 'T', chain: 'robinhood', walletId: 'w1',
    amount: '0.02', intervalMin: 0, roundsLeft: 4, rounds: 4, budget: 0, spent: 0, nextAt: 0 }];
  let rounds = 0;
  const realBuy = core.buy;
  core.buy = async (chatId, ca, amt) => { rounds++; return { sym: 'T', gotTokens: 1, spentEth: Number(amt), native: 'ETH', hash: '0x' + '1'.repeat(64) }; };
  try { for (let c = 0; c < 8; c++) await watchers._test.dcaCycle(); }
  finally { core.buy = realBuy; }
  assert.equal(rounds, 4, 'an unbudgeted plan must run its full round count');
  assert.equal((u.dca || []).length, 0, 'a finished plan must be removed');
});
