'use strict';
/*
 * stalePeak.test.js — the "Possible rug / dump" alert, and why it is gone.
 *
 * A live report, 2026-08-16. Five wallets bought $Ge87…pump at 22:41 — 0.01312
 * SOL each, entry $0.00724, MC $7.25M. One minute later, at 22:42, the bot sent
 * this four times over:
 *
 *     ⚠️ Possible rug / dump: $Ge87…pump
 *     Value fell to ≈ 0.0131 SOL from a peak of ≈ 0.1004. Check the chart /
 *     your safety.
 *
 * Nothing had dumped. 0.0131 is one wallet's brand-new bag, priced at the price
 * it was just bought at. 0.1004 was a holding in the SAME wallet that had
 * already been sold — a position record survives being sold to zero, because it
 * is what carries the lifetime ethIn/ethOut, and the peak rode along with it.
 * With POS_RUG_DROP at 0.15 the alert was arithmetically certain, not unlucky.
 *
 * THE ALERT IS REMOVED, on the owner's call, and this file now guards the
 * removal instead of the fix. The reasoning is worth keeping: a PEAK is not a
 * fact about the token, it is the highest number this bot happened to observe.
 * That made the alert wrong in both directions — it fired on a token that had
 * merely retraced from a spike, it fired on a fresh bag whenever a peak outlived
 * a previous holding, and it stayed silent on a token that rugged before it ever
 * had a peak worth measuring. A warning that cries wolf trains the reader to
 * swipe the next one away.
 *
 * WHAT MUST SURVIVE, and the real point of this file: 🛡 Auto-protect. It is the
 * guard that actually saves money — it SELLS — it measures against YOUR ENTRY
 * rather than a high-water mark, and it must not be collateral damage in the
 * deletion of a message.
 *
 * No network, no RPC.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
const WATCH = fs.readFileSync(path.join(__dirname, 'watchers.js'), 'utf8');
/**
 * Comment lines stripped.
 *
 * "It is gone" is a claim about CODE, and the note explaining the removal quotes
 * the very phrase being searched for — so asserting over the raw source failed
 * on the documentation of the fix. A test that breaks when you explain yourself
 * is a test that gets deleted rather than read.
 */
const code = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '');

// ── Why it had to go ─────────────────────────────────────────────────────────

test('the reported alert could not have failed to fire', () => {
  const RUG_DROP = 0.15;          // POS_RUG_DROP, as it then defaulted
  const RUG_MIN_PEAK = 0.01;      // the stale peak cleared this by 10x
  const value = 0.0131, peak = 0.1004;
  assert.ok(peak >= RUG_MIN_PEAK, 'the stale peak was too small to arm the alert');
  assert.ok(value <= peak * RUG_DROP, `${value} > ${(peak * RUG_DROP).toFixed(5)} — the numbers do not reproduce`);
});

// ── It is gone, and stays gone ───────────────────────────────────────────────

test('nothing sends a rug/dump message any more', () => {
  assert.ok(!/Possible rug \/ dump/.test(code(WATCH)), 'the alert is back');
  assert.ok(!/notified\.rug = true/.test(code(WATCH)), 'the alert is back in another wording');
  // Grepping the whole bot, not just this file: the alert must not reappear
  // somewhere else wearing a different name.
  for (const f of ['telegram.js', 'core.js']) {
    assert.ok(!/Possible rug/.test(code(fs.readFileSync(path.join(__dirname, f), 'utf8'))), `${f} sends it now`);
  }
});

test('the peak is no longer written on every cycle', () => {
  // Its only reader was the alert. Left in, it is disk churn for nobody plus a
  // field the next person has to work out is dead.
  assert.ok(!/p\.peakValueEth = valueEth/.test(WATCH), 'the store is still being written for a value nothing reads');
  assert.ok(!/RUG_DROP/.test(WATCH), 'the threshold constant outlived the thing it thresholded');
});

test('the removal says WHY, where the code used to be', () => {
  // A deleted feature with no trace reads as an oversight, and the next person
  // to notice positions have no dump warning will simply add one back.
  const cycle = WATCH.slice(WATCH.indexOf('async function positionsCycle'), WATCH.indexOf('snapOf.report();', WATCH.indexOf('async function positionsCycle')));
  assert.match(cycle, /"Possible rug \/ dump" ALERT IS GONE/);
  assert.match(cycle, /Auto-protect above is\s*\n\s*\/\/ the real guard/);
});

// ── What must NOT have gone with it ──────────────────────────────────────────

const PROTECT = WATCH.slice(WATCH.indexOf('if (wantProtect) {'), WATCH.indexOf('"Possible rug / dump" ALERT IS GONE'));

test('auto-protect survived intact — it is the guard that actually sells', () => {
  assert.ok(PROTECT.length > 400, 'the auto-protect block moved or went with the alert');
  // Measured against COST, never a peak: a winner that merely retraces from its
  // high must never be force-sold.
  assert.match(PROTECT, /const lossFrac = cost > 0 \? 1 - \(valueEth \/ cost\) : 0;/);
  assert.match(PROTECT, /lossFrac >= AUTO_PROTECT_DROP/);
  assert.ok(!/peakValueEth/.test(PROTECT), 'auto-protect grew a dependency on the peak that was just deleted');
  // The honeypot leg, and the sell itself.
  assert.match(PROTECT, /sec\.honeypot === true \|\| Number\(sec\.sellTaxPct\) >= 50/);
  assert.match(PROTECT, /core\.sell\(u\.chatId, p\.ca, 100, p\.chain, w\.id/);
  // Its DM is never muted by the 🔔 alerts toggle — the bot sold something.
  assert.match(PROTECT, /_notify\(u\.chatId, `🛡 <b>Auto-protect sold/);
});

test('the dust floor auto-protect depends on is still defined', () => {
  // Shared with the deleted alert, so it was the easiest thing to remove by
  // accident — and without it the bot force-sells dust positions.
  assert.match(WATCH, /const RUG_MIN_PEAK = Math\.max\(0, Number\(process\.env\.POS_RUG_MIN_PEAK \|\| 0\.01\)\)/);
  assert.match(PROTECT, /if \(cost >= RUG_MIN_PEAK\)/);
});

test('profit milestones survived too', () => {
  const cycle = WATCH.slice(WATCH.indexOf('async function positionsCycle'));
  assert.match(cycle, /is up \$\{hi\}×<\/b> on your entry/);
  assert.match(WATCH, /const POS_MILESTONES = \[2, 5, 10, 25, 50, 100\];/);
});

// ── The reset that outlived the alert ────────────────────────────────────────

test('a fresh bag still forgets the last one\'s auto-protect cooldown', () => {
  // THIS is why _resetRiskIfFresh survives the deletion. A stale `protectAt`
  // SUPPRESSES a real rescue on the new position — the same defect as the false
  // alarm, with the loss reversed and far more expensive.
  const fn = CORE.slice(CORE.indexOf('function _resetRiskIfFresh(p)'), CORE.indexOf('function _resetRiskIfFresh(p)') + 700);
  assert.match(fn, /delete p\.notified\.protectAt;/);
  assert.match(fn, /delete p\.notified\.protectCheckAt;/);
  // Adding to a LIVE bag keeps its history: a cooldown exists to stop a retry
  // loop, and averaging down must not reset it.
  assert.match(fn, /if \(!\(p\.closed \|\| prevHeld <= 0n\)\) return;/);
  // Legacy fields cleared, not left as dead weight on records written before
  // the alert was removed.
  assert.match(fn, /delete p\.peakValueEth;/);
  assert.match(fn, /delete p\.notified\.rug;/);
});

test('every buy path calls it — the EVM one did, the Solana one did not', () => {
  const calls = CORE.match(/_resetRiskIfFresh\(p\);/g) || [];
  assert.strictEqual(calls.length, 2, `${calls.length} call site(s) — a buy path is not resetting the cooldown`);
  for (const [name, from, to] of [
    ['sol', 'async function _buySol(', 'async function _sellSol('],
    ['evm', 'async function buy(chatId,', 'async function sell(chatId,'],
  ]) {
    const body = CORE.slice(CORE.indexOf(from), CORE.indexOf(to));
    const iReset = body.indexOf('_resetRiskIfFresh(p);');
    const iWrite = body.indexOf('p.tokens =');
    assert.ok(iReset > -1, `${name}: the buy path does not reset — this is how the bug existed`);
    // After `p.tokens = …` it would inspect the NEW bag and never fire, which is
    // the same as not being there.
    assert.ok(iReset < iWrite, `${name}: the reset reads the bag it was meant to test`);
  }
});
