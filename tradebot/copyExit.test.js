'use strict';
/*
 * Mirroring a followed wallet OUT of a position.
 *
 * The bot could follow a wallet in and never out — you took all of the downside
 * with none of its exit signal. This is the other half.
 *
 * Two decisions are load-bearing and both are the operator's, so they are pinned
 * here rather than left to read off the implementation:
 *
 *   • ANY selling by the target exits us COMPLETELY. They trim 10%, we are out.
 *     Never late, at the cost of leaving some runs early.
 *   • Only positions COPY bought are copy's to sell. A bag the user opened
 *     themselves is never touched, no matter what the followed wallet does with
 *     its own.
 *
 * The watcher reads the target's BALANCE rather than swap logs. The copy-BUY
 * detector matches a Transfer from the V2 pair, so it cannot see a sell through
 * a V3 pool, an aggregator, or a plain transfer out. Missing an entry costs an
 * opportunity; missing an exit costs the position.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'copyexit-'));
process.env.WALLET_SECRET = 'w'.repeat(48);
process.env.TRADEBOT_TOKEN = 'x:y';
process.env.ENABLED_CHAINS = 'robinhood';

const core = require('./core');
const watchers = require('./watchers');

const CHAIN = 'robinhood';
const TOKEN = '0x' + 'de'.repeat(20);
const TARGET = '0x' + 'ab'.repeat(20);
const CHAT = 4242;

/** A user following TARGET, already copy-holding TOKEN, with the target's
 *  balance at that moment recorded as the baseline. */
function seed({ copySell = true, baseline = 1000n, wid = 'wBUY', own = '500' } = {}) {
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.wallets = [
    { id: 'wBUY', name: 'Buyer', address: '0x' + '11'.repeat(20), positions: {}, orders: [], history: [] },
    { id: 'wOTHER', name: 'Other', address: '0x' + '22'.repeat(20), positions: {}, orders: [], history: [] },
  ];
  u.activeWalletId = 'wOTHER';        // the user switched AFTER the copy-buy
  u.copy = { on: true, targets: [{
    id: 'cp1', address: TARGET, chain: CHAIN, mode: 'trades',
    buyEth: '0.01', maxEth: '1', spentEth: 0.01,
    bought: { [TOKEN]: true }, holding: {}, copySell,
  }] };
  const t = u.copy.targets[0];
  if (baseline != null) t.holding[core.copyTokenKey(CHAIN, TOKEN)] = { bal: String(baseline), own, at: Date.now(), wid, tries: 0 };
  return { u, t };
}

/** Drive one exit cycle. `targetBal` is what the followed wallet holds; `holders`
 *  maps our wallet id -> raw balance (null = unreadable). */
async function cycle(targetBal, { holders = { wBUY: 500n, wOTHER: 0n }, sellImpl } = {}) {
  const sells = [];
  const realBal = core.tokenBalanceOrNull;
  const realAcross = core.tokenBalancesAcross;
  const realSell = core.sell;
  core.tokenBalanceOrNull = async () => targetBal;
  core.tokenBalancesAcross = async (chatId) => (core.DB.users[String(chatId)].wallets || [])
    .map((w, i) => ({ id: w.id, index: i + 1, label: w.name, raw: holders[w.id] === undefined ? 0n : holders[w.id] }));
  core.sell = async (chatId, ca, pct, chain, walletId, opts) => {
    sells.push({ chatId, ca, pct, chain, walletId, opts });
    if (sellImpl) return sellImpl();
    return { sym: 'DEAD', proceedsEth: 0.02, native: 'ETH', hash: '0x' + '1'.repeat(64), chain };
  };
  try { await watchers.copyExitCycle(); }
  finally { core.tokenBalanceOrNull = realBal; core.tokenBalancesAcross = realAcross; core.sell = realSell; }
  return sells;
}

// ---------------------------------------------------------------- the trigger
test('any real selling by the target exits us completely', async () => {
  const { t } = seed({ baseline: 1000n });
  const sells = await cycle(600n);              // they cut 40%
  assert.equal(sells.length, 1, 'the exit did not fire');
  assert.equal(sells[0].pct, 100, 'a partial exit must still take us all the way out');
  assert.equal(sells[0].ca, TOKEN);
  assert.equal(Object.keys(t.holding).length, 0, 'the position must leave the ledger');
});

test('a wallet emptying itself exits us too', async () => {
  seed({ baseline: 1000n });
  const sells = await cycle(0n);
  assert.equal(sells.length, 1);
  assert.equal(sells[0].pct, 100);
});

test('dust movement is not an exit', async () => {
  // Rounding, a fee, a tiny transfer — none of that is someone selling.
  seed({ baseline: 1000n });
  assert.deepEqual(await cycle(999n), [], 'a 0.1% change tripped the exit');
  assert.deepEqual(await cycle(950n), [], 'a 5% change tripped a 10% trigger');
});

test('the target buying MORE raises the bar instead of tripping it', async () => {
  // Otherwise the next comparison is against a stale, lower number and a normal
  // trim looks like a full exit.
  const { t } = seed({ baseline: 1000n });
  assert.deepEqual(await cycle(3000n), [], 'buying more must never sell');
  assert.equal(t.holding[core.copyTokenKey(CHAIN, TOKEN)].bal, '3000', 'the peak did not move');
  assert.deepEqual(await cycle(2800n), [], 'a 7% trim off the NEW peak is still not an exit');
  assert.equal((await cycle(2000n)).length, 1, 'a 33% cut off the new peak is');
});

// ---------------------------------------------------------------- safety
test('an unreadable balance is never mistaken for a sale', async () => {
  // The single most expensive confusion available here: a flaky RPC reading as
  // "they sold everything" would dump the user's whole position.
  seed({ baseline: 1000n });
  assert.deepEqual(await cycle(null), [], 'a failed read triggered a sell');
});

test('the exit mirror off means the bot never sells', async () => {
  const { t } = seed({ copySell: false, baseline: 1000n });
  assert.deepEqual(await cycle(0n), [], 'a disabled mirror still sold');
  assert.equal(Object.keys(t.holding).length, 1, '…and it must not forget the position either');
});

test('the master switch off stops exits as well as entries', async () => {
  const { u } = seed({ baseline: 1000n });
  u.copy.on = false;
  assert.deepEqual(await cycle(0n), []);
});

test('only what copy bought is copy’s to sell', async () => {
  // The user's own bags are not on the ledger, so nothing the followed wallet
  // does with its own can reach them.
  const { t } = seed({ baseline: null });     // nothing recorded as copy-bought
  assert.equal(Object.keys(t.holding).length, 0, 'setup');
  assert.deepEqual(await cycle(0n), [], 'copy sold a position it never opened');
});

test('a position leaves the ledger BEFORE the sell, so a crash cannot sell it twice', async () => {
  const { t } = seed({ baseline: 1000n });
  let heldAtSellTime = null;
  await cycle(0n, { sellImpl: () => { heldAtSellTime = Object.keys(t.holding).length; throw new Error('boom'); } });
  assert.equal(heldAtSellTime, 0, 'the ledger still listed it while the sell was in flight');
});

// ---------------------------------------------------------------- the wallet
test('the exit sells from the wallet that BOUGHT, not from whatever is active', async () => {
  // The bug this pins: copy-buy and copy-sell each used the ACTIVE wallet, so a
  // user who switched wallets in between got "token balance is 0" on a bag they
  // were still holding — and the position was dropped from the ledger silently.
  const { u } = seed({ baseline: 1000n, wid: 'wBUY' });
  assert.equal(u.activeWalletId, 'wOTHER', 'setup: the active wallet is NOT the buyer');
  const sells = await cycle(0n, { holders: { wBUY: 500n, wOTHER: 0n } });
  assert.equal(sells.length, 1);
  assert.equal(sells[0].walletId, 'wBUY', 'the sell went to the wrong wallet');
});

test('if the pinned wallet no longer holds it, the exit sells NOTHING', async () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE, and an adversarial audit showed why
  // that was wrong. The exit fell back to whichever wallet held the MOST of the
  // token, for the convenience of a user who had moved their bag. That fallback
  // is how a 0.01 ETH mirror reaches a 20 ETH position the user opened
  // themselves a year earlier — different wallet, same token — and market-sells
  // it. Convenience on one hand, somebody else's money on the other.
  //
  // An empty pinned wallet means the copy slice is already gone. There is
  // nothing for copy to close.
  const { t } = seed({ baseline: 1000n, wid: 'wBUY' });
  const sells = await cycle(600n, { holders: { wBUY: 0n, wOTHER: 9_000_000n } });
  assert.deepEqual(sells, [], 'the exit reached into a wallet this mirror never traded on');
  assert.equal(Object.keys(t.holding).length, 0, 'the finished position must still leave the ledger');
});

test('the exit sells only what the mirror BOUGHT, not the whole bag', async () => {
  // The user holds 9,000,000 of the token on the buying wallet; copy filled 500
  // of them. Selling 100% closed all of it.
  const { t } = seed({ baseline: 1000n, wid: 'wBUY', own: '500' });
  const sells = await cycle(600n, { holders: { wBUY: 9_000_000n, wOTHER: 0n } });
  assert.equal(sells.length, 1, 'the exit did not fire');
  assert.equal(sells[0].opts && sells[0].opts.exactTokens, '500',
    `copy sold ${sells[0].opts ? sells[0].opts.exactTokens : 'the whole bag'} of a 9,000,000 position`);
  assert.equal(sells[0].walletId, 'wBUY');
});

test('a mirror whose fill was never recorded is not guessed at', async () => {
  // A buy that was broadcast but never confirmed leaves no fill to read. We do
  // not know which part of that bag is ours, so we do not sell any of it — and
  // we say so rather than going quiet.
  const { t } = seed({ baseline: 1000n, wid: 'wBUY', own: '' });
  const sells = await cycle(600n, { holders: { wBUY: 9_000_000n, wOTHER: 0n } });
  assert.deepEqual(sells, [], 'an unknown fill was sold as if it were the whole bag');
});

test('nobody holding it means nothing to sell, and no error', async () => {
  seed({ baseline: 1000n });
  assert.deepEqual(await cycle(0n, { holders: { wBUY: 0n, wOTHER: 0n } }), []);
});

// ---------------------------------------------------------------- retry
test('a failed exit is retried, not forgotten', async () => {
  // An exit that vanishes because one sell reverted is the worst outcome here:
  // the user holds a bag the bot promised to close and is told nothing.
  const { t } = seed({ baseline: 1000n });
  await cycle(0n, { sellImpl: () => { throw new Error('execution reverted'); } });
  const rec = t.holding[core.copyTokenKey(CHAIN, TOKEN)];
  assert.ok(rec, 'the position was dropped after a retriable failure');
  assert.equal(rec.tries, 1, 'the attempt was not counted');
  assert.equal(rec.wid, 'wBUY', 'the retry lost the wallet it must sell from');
});

test('a retry does not re-check the trigger — it is already committed to exiting', async () => {
  // Once we have decided to leave, the target's balance no longer matters. A
  // retry that re-ran the drop test would stall forever at a stable balance.
  const { t } = seed({ baseline: 1000n });
  await cycle(0n, { sellImpl: () => { throw new Error('execution reverted'); } });
  t.holding[core.copyTokenKey(CHAIN, TOKEN)].lastTryAt = 0;      // let the backoff pass
  const sells = await cycle(1000n);                              // target's balance back to full
  assert.equal(sells.length, 1, 'the retry did not fire');
});

test('after enough failures it gives up LOUDLY and says the bag is still yours', async () => {
  const { t } = seed({ baseline: 1000n });
  const msgs = [];
  watchers.setNotifier((chatId, text) => msgs.push(String(text)));
  const key = core.copyTokenKey(CHAIN, TOKEN);
  try {
    for (let i = 0; i < 6; i++) {
      if (t.holding[key]) t.holding[key].lastTryAt = 0;
      await cycle(0n, { sellImpl: () => { throw new Error('honeypot: cannot sell') } });
      if (!t.holding[key]) break;
    }
  } finally { watchers.setNotifier(() => {}); }
  assert.ok(!t.holding[key], 'it must stop retrying eventually');
  const gaveUp = msgs.find((m) => /gave up/i.test(m));
  assert.ok(gaveUp, `no give-up message was sent: ${msgs.join(' | ')}`);
  assert.match(gaveUp, /still hold this/i, 'the user must be told the bag is still theirs');
});

// ---------------------------------------------------------------- migration
test('enabling this never reaches back into bags bought under the old rules', async () => {
  // Existing followed wallets get copySell on, but an EMPTY ledger — so the
  // mirror governs only what is copy-bought from here on. Retro-applying it
  // would auto-sell positions the user acquired when copy could only buy.
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.copy = { on: true, targets: [{ id: 'old', address: TARGET, chain: CHAIN, mode: 'trades',
    buyEth: '0.01', maxEth: '1', spentEth: 0.5, bought: { [TOKEN]: true }, cursor: 0 }] };
  delete core.DB.users[String(CHAT)];
  core.DB.users[String(CHAT)] = u;
  const migrated = core.ensureUser(CHAT).copy.targets[0];
  assert.equal(migrated.copySell, true, 'the mirror should be on for a followed wallet');
  assert.deepEqual(migrated.holding, {}, 'but it must start with nothing to sell');
  assert.deepEqual(await cycle(0n), [], 'a pre-existing bag was auto-sold on upgrade');
});

test('an unreadable WALLET set leaves the position on the ledger to retry', async () => {
  // The same class of bug as the target-balance read, one step further along:
  // "we could not check your wallets" and "you hold none of it" are different
  // answers, and collapsing them drops the position for good during a blip.
  const { t } = seed({ baseline: 1000n, wid: null });
  const key = core.copyTokenKey(CHAIN, TOKEN);
  const sells = await cycle(0n, { holders: { wBUY: null, wOTHER: null } });
  assert.deepEqual(sells, [], 'it sold on an unreadable wallet set');
  assert.ok(t.holding[key], 'the position was forgotten instead of retried');
});

test('a PARTIAL wallet read that finds nothing is still not proof', async () => {
  // One wallet answered "zero", the other did not answer at all. The holder may
  // be the one we could not reach.
  const { t } = seed({ baseline: 1000n, wid: null });
  const key = core.copyTokenKey(CHAIN, TOKEN);
  await cycle(0n, { holders: { wBUY: 0n, wOTHER: null } });
  assert.ok(t.holding[key], 'a partial read was treated as a confirmed zero');
});

test('a COMPLETE read showing zero everywhere does drop it — that IS proof', async () => {
  const { t } = seed({ baseline: 1000n, wid: null });
  const key = core.copyTokenKey(CHAIN, TOKEN);
  await cycle(0n, { holders: { wBUY: 0n, wOTHER: 0n } });
  assert.ok(!t.holding[key], 'a confirmed empty position must not linger');
});

// ---------------------------------------------------------------- Solana
//
// The exit path branches on chain kind in two places — reading the target's
// balance (splBalance vs balanceOf) and routing the sell (_sellSol vs the EVM
// path) — and the ledger key is CASE-SENSITIVE on Solana and case-insensitive on
// EVM. Each of those is a place the two chains can silently diverge.
const solana = require('./solana');
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_TARGET = 'So11111111111111111111111111111111111111112';

function seedSol({ baseline = 1000n } = {}) {
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.wallets = [{ id: 'wSOL', name: 'Sol', address: '0x' + '33'.repeat(20), positions: {}, orders: [], history: [] }];
  u.activeWalletId = 'wSOL';
  u.copy = { on: true, targets: [{
    id: 'cps', address: SOL_TARGET, chain: 'solana', mode: 'trades',
    buyEth: '0.5', maxEth: '5', spentEth: 0.5, bought: { [MINT]: true }, holding: {}, copySell: true,
  }] };
  const t = u.copy.targets[0];
  t.holding[core.copyTokenKey('solana', MINT)] = { own: '500', bal: String(baseline), at: Date.now(), wid: 'wSOL', tries: 0 };
  return { u, t };
}

async function solCycle(targetRaw) {
  const sells = [];
  const realSpl = solana.splBalance;
  const realAcross = core.tokenBalancesAcross;
  const realSell = core.sell;
  solana.splBalance = async (conn, owner, mint) => {
    assert.equal(owner, SOL_TARGET, 'splBalance was called with the wrong owner');
    assert.equal(mint, MINT, 'splBalance was called with the wrong mint — the ledger key was mangled');
    return { raw: targetRaw, decimals: 6 };
  };
  core.tokenBalancesAcross = async () => [{ id: 'wSOL', index: 1, label: 'Sol', raw: 900n }];
  core.sell = async (chatId, ca, pct, chain, walletId) => {
    sells.push({ ca, pct, chain, walletId });
    return { sym: 'USDC', proceedsEth: 0.4, native: 'SOL', hash: 'SIGabc', chain };
  };
  try { await watchers.copyExitCycle(); }
  finally { solana.splBalance = realSpl; core.tokenBalancesAcross = realAcross; core.sell = realSell; }
  return sells;
}

test('Solana: the exit reads the SPL balance and routes the sell to the solana chain', async () => {
  seedSol({ baseline: 1000n });
  const sells = await solCycle(0n);
  assert.equal(sells.length, 1, 'the Solana exit did not fire');
  assert.equal(sells[0].chain, 'solana', 'the sell was routed to the wrong chain');
  assert.equal(sells[0].ca, MINT, 'the mint was mangled on the way to the sell');
  assert.equal(sells[0].pct, 100);
  assert.equal(sells[0].walletId, 'wSOL');
});

test('Solana: the mint keeps its case through the ledger', async () => {
  // base58 is case-SENSITIVE. Lowercasing it — which is correct for EVM — would
  // produce a mint that resolves to nothing, and the exit would read a zero
  // balance for every position and try to sell all of them.
  const { t } = seedSol();
  const key = Object.keys(t.holding)[0];
  assert.equal(key, MINT, 'the Solana ledger key was lowercased');
  assert.notEqual(key, MINT.toLowerCase());
  assert.equal(core.copyTokenKey('solana', MINT), MINT);
  assert.equal(core.copyTokenKey('ethereum', '0xAbCd'), '0xabcd', 'EVM keys must still normalise');
});

test('Solana: dust and unreadable balances behave the same as on EVM', async () => {
  seedSol({ baseline: 1000n });
  assert.deepEqual(await solCycle(980n), [], 'a 2% change tripped the Solana exit');
  seedSol({ baseline: 1000n });
  assert.deepEqual(await solCycle(null), [], 'an unreadable SPL balance was read as a sale');
});

// ---------------------------------------------------------------- second audit
//
// Four defects that the twenty-two tests above all passed over. Every one of
// them ends the same way — the user is left holding a bag the bot said it would
// close, and is told nothing — which is the one outcome this feature exists to
// prevent. They are pinned here as behaviour, driven through the real cycle.

test('a target that had ALREADY dumped when we copied it still gets exited', async () => {
  // THE ZERO-BASELINE TRAP. Copy detects the buy, we fill, and by the time we
  // read the target's balance for the baseline they are already out — seconds,
  // on a fast rug. That recorded a baseline of 0, and a 0 baseline read as "no
  // baseline yet, adopt this one" on EVERY cycle: copyHoldingBump refuses to
  // lower a peak, so the baseline stayed 0 and the branch caught it again for
  // ever. The fastest rug there is was the one case that never exited.
  const { t } = seed({ baseline: 0n });
  const sells = await cycle(0n);
  assert.equal(sells.length, 1, 'the position was parked for ever on a zero baseline');
  assert.equal(sells[0].pct, 100);
  assert.equal(Object.keys(t.holding).length, 0);
});

test('a baseline that could never be read does not park the position either', async () => {
  // Same trap through the other door: _targetBalance returned null at buy time,
  // so copyHoldingAdd stored bal:'' — which parses to 0 and lands in the same
  // branch. A followed wallet holding NONE of a token is an exit, and it needs
  // no baseline to be one.
  const { t } = seed({ baseline: null, wid: 'wBUY' });
  t.holding[core.copyTokenKey(CHAIN, TOKEN)] = { bal: '', own: '500', at: Date.now(), wid: 'wBUY', tries: 0 };
  assert.equal((await cycle(0n)).length, 1, 'an unknown baseline parked the position');
});

test('a first positive read still becomes the baseline, and does not sell', async () => {
  // The other half of that branch has to keep working: an unknown baseline plus
  // a target that DOES hold the token is an adoption, never an exit.
  const { t } = seed({ baseline: null, wid: 'wBUY' });
  t.holding[core.copyTokenKey(CHAIN, TOKEN)] = { bal: '', own: '500', at: Date.now(), wid: 'wBUY', tries: 0 };
  assert.deepEqual(await cycle(5000n), [], 'adopting a baseline sold the position');
  assert.equal(t.holding[core.copyTokenKey(CHAIN, TOKEN)].bal, '5000', 'the baseline was not adopted');
});

test('a read that could not see every wallet never retires the position', async () => {
  // "We could not read your wallets" is not the same answer as "you hold none of
  // it", and acting on it is fatal: the sell lands on a wallet the read failed
  // to vouch for, throws "token balance is 0" — which is on the swallow list —
  // and the position leaves the ledger for good while the bag is still there.
  //
  // _exitWalletId knew this and returned known:false. It also handed back the
  // PINNED wallet id, and the caller only skipped when BOTH were empty — so on
  // every position copy ever opened (all of which are pinned) the guard was
  // dead code.
  const { t } = seed({ baseline: 1000n, wid: 'wBUY' });
  const sells = await cycle(600n, {
    holders: { wBUY: 0n, wOTHER: null },        // the tokens were moved; that wallet is unreadable
    sellImpl: () => { throw new Error('token balance is 0'); },
  });
  assert.deepEqual(sells, [], 'sold from a wallet the read said was empty');
  // The position IS retired here, and that is now correct rather than dangerous.
  // This test used to demand it stay, because dropping it led to a sell on
  // whichever wallet held the most — which an audit showed could be a position
  // the user opened themselves. The exit only ever touches the wallet the mirror
  // traded on; that wallet answered "empty", so the copy slice is gone and there
  // is nothing left to retry. The half that mattered — that nothing is SOLD —
  // is asserted above.
  assert.equal(Object.keys(t.holding).length, 0, 'a finished position must not linger for ever');
});

test('a read that failed everywhere leaves the position alone', async () => {
  const { t } = seed({ baseline: 1000n, wid: 'wBUY' });
  const sells = await cycle(600n, { holders: { wBUY: null, wOTHER: null } });
  assert.deepEqual(sells, [], 'sold on a balance read that failed on every wallet');
  assert.equal(Object.keys(t.holding).length, 1, 'the position was retired on a total read failure');
});

test('a read that CAN see every wallet and finds none still retires it', async () => {
  // The counterweight: a complete, readable, empty answer is proof the user got
  // out by hand, and the ledger must not keep the position for ever.
  const { t } = seed({ baseline: 1000n, wid: 'wBUY' });
  assert.deepEqual(await cycle(600n, { holders: { wBUY: 0n, wOTHER: 0n } }), []);
  assert.equal(Object.keys(t.holding).length, 0, 'a hand-sold position stayed on the ledger');
});

test('the target balances are read together, not one round trip at a time', async () => {
  // One serial RPC per held token, per cycle, across every user on the box: at
  // ~400ms a read, twenty positions is the entire 8s loop, and the loop only
  // sleeps after the cycle RETURNS. The exit that matters simply arrives later
  // and later as the bot grows. They are independent reads.
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.wallets = [{ id: 'wBUY', name: 'Buyer', address: '0x' + '11'.repeat(20), positions: {}, orders: [], history: [] }];
  u.activeWalletId = 'wBUY';
  const tokens = Array.from({ length: 12 }, (_, i) => '0x' + String(i).padStart(2, '0').repeat(20));
  u.copy = { on: true, targets: [{ id: 'cp1', address: TARGET, chain: CHAIN, mode: 'trades',
    buyEth: '0.01', maxEth: '1', spentEth: 0.01, bought: {}, holding: {}, copySell: true }] };
  for (const tk of tokens) u.copy.targets[0].holding[core.copyTokenKey(CHAIN, tk)] = { bal: '1000', at: Date.now(), wid: 'wBUY', tries: 0 };

  let inFlight = 0, peak = 0;
  const realBal = core.tokenBalanceOrNull, realAcross = core.tokenBalancesAcross;
  core.tokenBalanceOrNull = async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--; return 1000n;                  // unchanged → no sells, we are timing the reads
  };
  core.tokenBalancesAcross = async () => [{ id: 'wBUY', index: 1, label: 'Buyer', raw: 1000n }];
  try { await watchers.copyExitCycle(); }
  finally { core.tokenBalanceOrNull = realBal; core.tokenBalancesAcross = realAcross; }
  assert.ok(peak > 1, `the balance reads still run one at a time (peak concurrency ${peak})`);
});

test('a buy that was broadcast but never confirmed is still exit-mirrored', async () => {
  // The budget is deliberately NOT refunded when core.buy throws err.broadcast —
  // the tx may still land, and refunding it would let the next cycle spend the
  // same allowance twice. The position was not tracked on those same terms, so a
  // fill we had already paid for became the one bag copy would never watch leave.
  //
  // If the tx really never lands, nothing is stranded: the exit cycle reads a
  // clean zero across every wallet and retires the entry by itself.
  const { u, t } = seed({ baseline: null });
  t.mode = 'launches'; t.holding = {}; t.bought = {};
  const realBuy = core.buy, realBal = core.tokenBalanceOrNull;
  core.buy = async () => { const e = new Error('trade sent but not confirmed'); e.broadcast = true; throw e; };
  core.tokenBalanceOrNull = async () => 7000n;
  try { await watchers._test._followerBuy(u, t, TOKEN, CHAIN); }
  finally { core.buy = realBuy; core.tokenBalanceOrNull = realBal; }

  const h = t.holding[core.copyTokenKey(CHAIN, TOKEN)];
  assert.ok(h, 'an unconfirmed-but-broadcast buy left the position untracked');
  assert.equal(h.bal, '7000', 'the exit baseline was not recorded');
  assert.equal(h.wid, 'wOTHER', 'the exit was not pinned to the buying wallet');
  assert.equal(t.spentEth, 0.02, 'the budget must stay committed — the tx may still land');
});

test('a buy that clearly did not spend leaves no position behind', async () => {
  // The counterweight: a plain failure rolls the budget AND the dedup back, so
  // there is nothing to mirror out of.
  const { u, t } = seed({ baseline: null });
  t.mode = 'launches'; t.holding = {}; t.bought = {};
  const realBuy = core.buy;
  core.buy = async () => { throw new Error('insufficient ETH'); };
  try { await watchers._test._followerBuy(u, t, TOKEN, CHAIN); }
  finally { core.buy = realBuy; }
  assert.equal(Object.keys(t.holding).length, 0, 'a buy that never spent left a phantom position');
  assert.equal(t.spentEth, 0.01, 'the budget was not refunded');
});
