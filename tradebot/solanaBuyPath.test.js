'use strict';
/*
 * solanaBuyPath.test.js — the Solana buy actually RUNS.
 *
 * THE FAILURE THIS EXISTS FOR
 * A user's card, five wallets, five identical red crosses:
 *
 *     ❌ Nothing bought · 0 of 5 wallets
 *     The buy didn't go through. Please try again in a moment.
 *
 * and in the server log, once per-wallet failures were finally being written:
 *
 *     buy failed [Wallet 1] solana Ge87…Tpump: withTmo is not defined
 *
 * A ReferenceError. `_buySol` had called `withTmo` since the quote-divergence
 * guard was written, and the only definition in the repo lived in telegram.js —
 * a different module, never imported. Node does not complain about a free
 * variable until the line runs, so this was a hard crash on the money path that
 * shipped, sat green for two days, and survived two code audits.
 *
 * It survived because NOTHING IN THE SUITE EVER EXECUTED IT. Every existing
 * test of a Solana trade replaces `core.buy` wholesale to assert what the
 * receipts say. That is the right way to test receipts and it means the engine
 * underneath them had no execution coverage at all.
 *
 * So this file stubs the OUTSIDE — the RPC, the aggregator, the price feeds —
 * and lets the real `_buySol` run. It asserts nothing about a good trade: only
 * that the code path reaches the aggregator and comes back with the
 * aggregator's own error rather than dying on the way there. Any
 * ReferenceError, TypeError or missing import along that path fails this test.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'solbuy-'));
process.env.WALLET_SECRET = 's'.repeat(48);
process.env.TRADEBOT_TOKEN = 'x:y';
process.env.ENABLED_CHAINS = 'solana';
process.env.SOLANA_RPC = 'http://127.0.0.1:1';   // never reached: every read below is stubbed
process.env.LAUNCHPADS = '0';                    // the pre-migration pads are a different test's job

const core = require('./core');
const solana = require('./solana');
const lp = require('./launchpads');

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const CHAT = 41;

/** A user holding a REAL, decryptable Solana wallet — `_signer` derives a
 *  keypair from it, and a hand-built object literal cannot do that. */
function fundedUser() {
  core.DB.users = {};
  core.ensureUser(CHAT);
  const w = core.addWallet(CHAT);
  return w;
}

/** Run a real core.buy on Solana with only the OUTSIDE world stubbed.
 *  `swap` throws by default, because what this asserts is how far we got. */
async function buy({ swap, solBalance = 5_000_000_000n, snapshot } = {}) {
  const real = {
    solBalance: solana.solBalance, splBalance: solana.splBalance, splMeta: solana.splMeta,
    swap: solana.swap, sendSol: solana.sendSol, ds: solana.dexScreener,
  };
  const calls = { swap: 0 };
  solana.solBalance = async () => solBalance;
  solana.splBalance = async () => ({ raw: 0n, decimals: 6 });
  solana.splMeta = async () => ({ name: 'Bonk', sym: 'BONK', decimals: 6 });
  solana.sendSol = async () => ({ sig: 'feesig', confirmed: Promise.resolve('feesig') });
  // STUBBED ON THE MODULE, NOT ON THE EXPORT.
  //
  // `_buySol` reaches its reference price through the module-local
  // `tokenSnapshot`, so assigning `core.tokenSnapshot` replaces what OTHER
  // modules see and changes nothing inside core.js itself. The first cut of
  // this file did exactly that, the real snapshot ran against a dead RPC,
  // returned null, and the divergence guard skipped — a test that passed for a
  // reason unrelated to what it asserted. `solana.dexScreener` is the seam that
  // actually works: tokenSnapshot calls it module-qualified.
  solana.dexScreener = async () => (snapshot === undefined ? { priceUsd: 0.00019, priceNative: 0.000001, liquidityUsd: 5e5, volH24Usd: 1e5, mcapUsd: 7e6, name: 'Bonk', symbol: 'BONK' } : snapshot);
  const refuse = async () => { throw new Error('Jupiter swap-build failed (500) — Invalid request'); };
  const inner = swap || refuse;
  solana.swap = async (...a) => { calls.swap++; return inner(...a); };
  try {
    const r = await core.buy(CHAT, MINT, '0.01', 'solana');
    return { ok: true, r, calls };
  } catch (e) {
    return { ok: false, err: e, calls };
  } finally {
    Object.assign(solana, { solBalance: real.solBalance, splBalance: real.splBalance, splMeta: real.splMeta, swap: real.swap, sendSol: real.sendSol, dexScreener: real.ds });
  }
}

// ── the regression ───────────────────────────────────────────────────────────

test('a Solana buy reaches the aggregator instead of crashing on the way', async () => {
  fundedUser();
  const { ok, err, calls } = await buy();
  assert.equal(ok, false, 'the stub was supposed to refuse the swap');
  // THE ASSERTION. A ReferenceError here means an identifier used on the buy
  // path is not defined in the module that uses it — exactly the defect that
  // killed every Solana buy for two days while the suite stayed green.
  assert.ok(!(err instanceof ReferenceError), `the buy path crashed before trading: ${err && err.message}`);
  assert.ok(!/is not defined|is not a function|cannot read propert/i.test(String(err && err.message)),
    `the buy path crashed before trading: ${err && err.message}`);
  assert.equal(calls.swap, 1, 'the aggregator was never asked');
  assert.match(String(err.message), /swap-build failed/, 'a different error than the stub threw');
});

test('the divergence guard runs, and does not need telegram.js to do it', async () => {
  fundedUser();
  // `withTmo` lived only in telegram.js. This is the line that used the free
  // variable, so it is the line worth executing on purpose.
  const CORE = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
  assert.match(CORE, /^const withTmo = /m, 'core.js uses withTmo without defining it');
  assert.match(CORE, /const refP = withTmo\(tokenSnapshot\(ca, chainKey\)/, 'the divergence guard moved — re-point this test');
  // …and with a reference price present, a wildly worse quote is refused
  // BEFORE anything is signed.
  const { ok, err } = await buy({
    swap: async (conn, kp, o) => {
      // 0.01 SOL for 10 tokens = 0.001 SOL/token, a thousand times the reference.
      await o.onQuote({ outAmount: 10_000_000n, inAmount: 10_000_000n });
      throw new Error('should never get here');
    },
  });
  assert.equal(ok, false);
  assert.match(String(err.message), /worse than the price shown/, `the guard did not fire: ${err && err.message}`);
});

test('an unreadable reference price does not block the trade', async () => {
  fundedUser();
  // "No reference is not a reason to block a trade" — a dead indexer must not
  // become a trading outage.
  const { err, calls } = await buy({
    snapshot: null,   // no indexed market at all
    swap: async (conn, kp, o) => { await o.onQuote({ outAmount: 1n, inAmount: 10_000_000n }); throw new Error('Jupiter swap-build failed (500)'); },
  });
  assert.equal(calls.swap, 1);
  assert.match(String(err.message), /swap-build failed/, 'a missing reference price blocked the buy');
});

test('an empty wallet is refused before the aggregator is called', async () => {
  fundedUser();
  const { ok, err, calls } = await buy({ solBalance: 1000n });
  assert.equal(ok, false);
  assert.equal(calls.swap, 0, 'it asked for a quote it could never pay for');
  assert.match(String(err.message), /insufficient SOL/);
});

// ── the gap that let it ship ─────────────────────────────────────────────────

test('the Solana engine is executed by the suite, not only stubbed over', () => {
  // Every other Solana test replaces core.buy wholesale, which is correct for
  // testing receipts and is why the engine had no coverage at all. If this file
  // ever stops calling the real core.buy, the hole reopens.
  const SELF = fs.readFileSync(__filename, 'utf8');
  assert.match(SELF, /await core\.buy\(CHAT, MINT/, 'this file no longer exercises the real buy');
  assert.ok(!/core\.buy = /.test(SELF), 'this file now stubs the very thing it exists to run');
});

// ── decimals are read, never assumed ─────────────────────────────────────────

test('a 6-decimal mint is not decoded as 9 — the −99.90% card', async () => {
  // A real buy, five wallets: each receipt said "Buy of 1,075.29 $Ge87…pump
  // succeeded", and the position card pinned above them read
  //
  //     You hold: 5.38 across 5 wallets
  //     Profit/Loss: −99.90% (−$37.20)
  //
  // minutes after the buy, on a token that had not moved. 1075.29 ÷ 1.08 is
  // 1000, and 10^(9−6) is 1000: the receipts used the mint's real 6 decimals
  // and the card used a hardcoded 9. tokenSnapshot's Solana branch carried
  // `decimals: 9` as a literal — DexScreener does not report decimals, nine is
  // what a Solana example uses, and every pump.fun token is six. monitorPayload
  // prefers the snapshot's value over every other source, so the guess beat the
  // figure the buy had actually read.
  fundedUser();
  const realDs = solana.dexScreener;
  const realDec = solana.splDecimalsOrNull;
  solana.dexScreener = async () => ({ priceUsd: 0.00692, priceNative: 0.0000364, liquidityUsd: 5e5, volH24Usd: 1e5, mcapUsd: 6.92e6, name: 'Jimothy', symbol: 'Jimothy' });
  solana.splDecimalsOrNull = async () => 6;   // what the mint account actually says
  try {
    const snap = await core.tokenSnapshot(MINT, 'solana');
    assert.equal(snap.decimals, 6, 'the snapshot is still asserting 9 decimals');
  } finally { solana.dexScreener = realDs; solana.splDecimalsOrNull = realDec; }
});

test('an unreadable mint omits decimals rather than guessing', async () => {
  // Absent, the caller falls through to the value recorded at buy time — which
  // was read from the chain. A guess of 9 OVERRIDES that correct value, because
  // the snapshot sits first in monitorPayload's chain. Wrong beats missing here.
  fundedUser();
  const realDs = solana.dexScreener;
  const realDec = solana.splDecimalsOrNull;
  solana.dexScreener = async () => ({ priceUsd: 0.00692, priceNative: 0.0000364, liquidityUsd: 1, volH24Usd: 1, mcapUsd: 1, name: 'X', symbol: 'X' });
  solana.splDecimalsOrNull = async () => null;
  try {
    const snap = await core.tokenSnapshot(MINT, 'solana');
    assert.ok(!('decimals' in snap), `the snapshot invented decimals: ${snap.decimals}`);
  } finally { solana.dexScreener = realDs; solana.splDecimalsOrNull = realDec; }
});

test('the mint outranks the token registry on decimals', () => {
  // The mint account's `decimals` field IS the definition of the token's units.
  // splMeta preferred Jupiter's copy of it, which inverts the only thing here
  // that is not a matter of opinion — name and symbol are metadata and the
  // registry is the better source; decimals are arithmetic.
  const SRC = fs.readFileSync(path.join(__dirname, 'solana.js'), 'utf8');
  const start = SRC.indexOf('async function splMeta(');
  assert.ok(start > 0, 'splMeta is gone');
  const fn = SRC.slice(start, SRC.indexOf('\n}', start));
  assert.match(fn, /decimals: Number\.isFinite\(dec\) \? dec :/, 'the registry still outranks the mint');
  assert.match(fn, /splDecimalsOrNull\(conn, mint\)/, 'splMeta cannot tell a failed read from a real 9');
});

test('a failed Solana balance read is not reported as an empty bag', async () => {
  // splBalance swallows its errors and answers 0n, so tokenBalanceOrNull — the
  // function that exists so a caller can tell "no bag" from "the RPC did not
  // answer" — could never do it on Solana. The monitor reads a zero as
  // "position closed" and retires a pinned card on a live position.
  const conn = { getParsedTokenAccountsByOwner: async () => { throw new Error('rpc down'); } };
  assert.equal(await solana.splBalanceOrNull(conn, '11111111111111111111111111111111', MINT), null);
  const empty = { getParsedTokenAccountsByOwner: async () => ({ value: [] }) };
  assert.equal(await solana.splBalanceOrNull(empty, '11111111111111111111111111111111', MINT), 0n, 'a genuinely empty wallet must still read 0');
});

// ── the card must not wait on a badge ────────────────────────────────────────

test('a slow launchpad does not hold up a price DexScreener already gave', async () => {
  // The pads were awaited together with the price, so four concurrent HTTP
  // calls sat in front of every card render and the caller waited for the
  // slowest. When DexScreener answers, the pads contribute a badge and nothing
  // else — and a badge may not hold the price hostage. Measured end to end: a
  // card with one slow pad went 8.4s → 2.9s.
  fundedUser();
  const real = { ds: solana.dexScreener, dec: solana.splDecimalsOrNull, lpRec: lp.record, lpCov: lp.covers };
  const wait = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
  solana.dexScreener = async () => wait(50, { priceUsd: 0.00692, priceNative: 0.0000364, liquidityUsd: 5e5, volH24Usd: 1e5, mcapUsd: 6.9e6, name: 'J', symbol: 'J' });
  solana.splDecimalsOrNull = async () => wait(50, 6);
  lp.covers = () => true;
  lp.record = async () => wait(4000, null);   // a pad that is effectively hung
  try {
    const t0 = Date.now();
    const snap = await core.tokenSnapshot(MINT, 'solana');
    const ms = Date.now() - t0;
    assert.ok(snap && snap.priceUsd > 0, 'the snapshot lost its price');
    assert.ok(ms < 2000, `the price waited ${ms}ms on a launchpad badge`);
  } finally { Object.assign(solana, { dexScreener: real.ds, splDecimalsOrNull: real.dec }); lp.record = real.lpRec; lp.covers = real.lpCov; }
});

test('…but WAITS for it when the launchpad is the only source of a price', async () => {
  // The whole point of the pads: a token still on a bonding curve has no pool
  // for DexScreener to index. Here the pad IS the answer, so racing it away
  // would put back the "❌ Couldn't price it" this feature exists to remove.
  fundedUser();
  const real = { ds: solana.dexScreener, dec: solana.splDecimalsOrNull, lpRec: lp.record, lpCov: lp.covers };
  const wait = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
  solana.dexScreener = async () => null;                       // not indexed at all
  solana.splDecimalsOrNull = async () => 6;
  lp.covers = () => true;
  lp.record = async () => wait(1200, { priceUsd: 0.00004, mcapUsd: 40000, symbol: 'NEW', name: 'New', onCurve: true, progressPct: 36, progressSource: 'derived', graduated: false });
  try {
    const snap = await core.tokenSnapshot(MINT, 'solana');
    assert.ok(snap, 'a curve-only token lost its card again');
    assert.equal(snap.dex, false);
    assert.equal(snap.progressPct, 36);
  } finally { Object.assign(solana, { dexScreener: real.ds, splDecimalsOrNull: real.dec }); lp.record = real.lpRec; lp.covers = real.lpCov; }
});
