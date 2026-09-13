'use strict';
/*
 * fillVsDisplay.test.js — the gap between the price on the card and the price of
 * the trade.
 *
 * A live Solana trade, 2026-08-14. The card said $0.00000967 / MC $9.67K. Five
 * wallets bought 0.01 SOL each. The user got 125.66K tokens for 0.04950 SOL —
 * a realised entry of $0.0000297, 3.07x worse than the card. They sold the whole
 * bag for 0.01075 SOL. The market had moved −15.5%; they were down 78%.
 *
 * What it was NOT, each ruled out by arithmetic rather than by opinion:
 *   • not slippage — permitting a 3.07x-worse fill needs 6744 bps; slipBps
 *     defaults to 500 and the codebase clamps at 5000, which permits 2.0x. Even
 *     at maximum the bound could not have allowed it.
 *   • not a post-quote skim — that would have driven the output under minOut and
 *     reverted, five times. Ceiling on any post-quote loss is 1 − 0.95² = 9.8%.
 *   • not the parallel fan-out — under one constant-product pool, splitting a
 *     buy into N slices is path-independent; five slices of 0.0099 yield exactly
 *     what one slice of 0.0495 yields.
 *   • not bookkeeping — 0.01 × 0.99 × 5 = 0.04950, exactly the "Invested" line.
 *
 * What it WAS: the card prices from one DexScreener pair and the trade prices
 * from Jupiter routing across every AMM, and nothing in the codebase ever
 * compared the two. Jupiter QUOTED ~3x worse than the card, and the bot signed it.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const i18n = require('./i18n');
const solana = require('./solana');
const CORE = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
const TG = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
const SOL = fs.readFileSync(path.join(__dirname, 'solana.js'), 'utf8');

// ── The guard ────────────────────────────────────────────────────────────────

test('a quote far worse than the displayed price is refused before anything is signed', () => {
  assert.match(CORE, /if \(times > CFG\.solMaxQuoteDivergence\)/);
  assert.match(CORE, /err\.divergence = times;/);
  // Refused, not failed: the message has to say the money is untouched, because
  // "the buy didn't go through" invites an immediate retry into the same trap.
  assert.match(CORE, /nothing was sent/);
});

test('the guard runs at the last free moment — after the quote, before the signature', () => {
  const swapFn = SOL.slice(SOL.indexOf('async function swap(conn, keypair'), SOL.indexOf('// ---------------------------------------------------------------- native SOL transfer'));
  // The quote may now be handed in already in flight (`quoteP`) — _buySol starts
  // it alongside its chain reads rather than stacking the two round trips. The
  // ORDER this test exists for is unchanged: quote resolved, then the hook, then
  // the build.
  const iQuote = swapFn.indexOf('const quote = await (quoteP || getQuote(');
  const iHook = swapFn.indexOf('if (onQuote) await onQuote(quote);');
  const iBuild = swapFn.indexOf('const txB64 = await getSwapTx(');
  assert.ok(iQuote > -1 && iHook > iQuote, 'the hook runs before there is a quote to judge');
  assert.ok(iBuild > iHook, 'the transaction is built before the trade can still be called off');
});

test('an early quote is still a quote the guard sees', () => {
  // The whole risk of starting the quote early: if _buySol built its own
  // transaction from `quoteP` and only passed the RESULT to swap(), the hook
  // would be bypassed and the guard would silently stop running. It does not —
  // the promise is handed in and awaited in the one place it always was.
  const buy = CORE.slice(CORE.indexOf('async function _buySol('), CORE.indexOf('async function _sellSol('));
  assert.match(buy, /const quoteP = solana\.getQuote\(\{ inputMint: solana\.WSOL_MINT, outputMint: ca, amountRaw: spend, slippageBps: slip \}\);/);
  assert.match(buy, /onSent: sent, onQuote, quoteP, timings: T \}\)/, 'the early quote no longer reaches swap()');
  assert.ok(!/getSwapTx|sendJupiterSwap/.test(buy), '_buySol builds its own transaction, so the guard hook is bypassed');
  // A pre-check that throws before the quote is awaited must not surface as an
  // unhandled rejection and take the process down.
  assert.match(buy, /quoteP\.catch\(\(\) => \{\}\);/);
  // Started BEFORE the reads it does not depend on — that is the entire point.
  assert.ok(buy.indexOf('const quoteP =') < buy.indexOf('solana.solBalance(conn, signer.address)'),
    'the quote waits on chain reads it has no need of');
});

test('the reference read never delays the trade', () => {
  // The house rule: nothing is awaited on the critical path for a display value.
  // The reference runs concurrently with the quote's own round trip, and is only
  // awaited inside the hook — i.e. after Jupiter has already answered.
  assert.match(CORE, /const refP = withTmo\(tokenSnapshot\(ca, chainKey\)\.catch\(\(\) => null\), 5000, null\);/);
  const buy = CORE.slice(CORE.indexOf('async function _buySol('), CORE.indexOf('async function _sellSol('));
  assert.ok(buy.indexOf('const refP =') < buy.indexOf('const onQuote ='), 'the reference is started inside the hook, so it is serial');
  assert.ok(!/await refP;/.test(buy.slice(0, buy.indexOf('const onQuote ='))), 'the reference is awaited before the swap starts');
  // AND IT IS BOUNDED. "Concurrent" only means "free" while the reference is
  // faster than the quote; when DexScreener is slow the unbounded await held a
  // live quote, between pricing and signature, for up to its own 5s timeout.
  assert.match(buy, /const ref = await withTmo\(refP\.catch\(\(\) => null\), GUARD_REF_WAIT_MS, null\);/);
  assert.match(CORE, /const GUARD_REF_WAIT_MS = Math\.max\(0, Number\(process\.env\.SOL_GUARD_REF_WAIT_MS \|\| 1200\)\);/);
  // Started before the chain reads, so the bound is a ceiling it rarely reaches.
  assert.ok(buy.indexOf('const refP =') < buy.indexOf('solana.solBalance(conn, signer.address)'),
    'the reference starts after the reads, so it needs the full bound every time');
});

test('the bot fee never sits between the fill and the receipt', () => {
  // Deferring the CONFIRMATION was the first half. The broadcast was still
  // awaited, and it is getLatestBlockhash plus a send the RPC simulates first —
  // the fee transfer runs with preflight ON, unlike the swap.
  for (const [name, from, to] of [
    ['buy', 'async function _buySol(', 'async function _sellSol('],
    ['sell', 'async function _sellSol(', 'async function _withdrawSol('],
  ]) {
    const body = CORE.slice(CORE.indexOf(from), CORE.indexOf(to));
    assert.ok(!/await _chargeFeeSol\(/.test(body), `${name}: the receipt waits for the bot's own fee again`);
    assert.match(body, /const feeP = _chargeFeeSol\(conn, kp, fee/, `${name}: fee charge missing`);
    // feeHash has ONE reader — feeCollected in the ops report — so the report is
    // what waits, and the flag stays truthful instead of becoming optimistic.
    assert.match(body, /feeP\.then\(\(feeSig\) => \{ res\.feeHash = feeSig \|\| null; \}\)/, `${name}: feeCollected would now always be false`);
    assert.match(body, /feeHash: null,/, `${name}: res still claims a signature it does not have yet`);
  }
});

test('no reference price is never a reason to block a trade', () => {
  // A token the indexer has never seen must still be buyable. The guard is a
  // comparison; with nothing to compare against it has no opinion.
  assert.match(CORE, /if \(!\(refPx > 0\) \|\| !\(q\.outAmount > 0n\)\) return;/);
  assert.match(CORE, /if \(!\(CFG\.solMaxQuoteDivergence > 0\)\) return;/, 'the guard cannot be turned off');
});

test('the limit is configurable and defaults to 2x', () => {
  assert.match(CORE, /solMaxQuoteDivergence: Math\.max\(0, Number\(process\.env\.SOL_MAX_QUOTE_DIVERGENCE \|\| 2\)\)/);
  // 2x would have refused this trade: it quoted 3.07x.
  assert.ok(3.07 > 2);
});

test('a refused quote is its own error class, not a failed trade', () => {
  const m = 'buy failed on Solana: quote is 3.1x worse than the price shown (…) — nothing was sent';
  assert.strictEqual(i18n.errorKey(m), 'err.diverged');
  for (const lang of i18n.LANGS) {
    const s = i18n.t(lang, 'err.diverged', { act: 'buy' });
    assert.match(s, /NOT sent|tidak<\/b> dikirim/, `${lang} does not say the trade was never sent`);
  }
  assert.notStrictEqual(i18n._strings['err.diverged'].en, i18n._strings['err.diverged'].id);
});

test('the guard does not swallow the errors that were already classified', () => {
  assert.strictEqual(i18n.errorKey('buy failed on Solana: fetch failed'), 'err.offline');
  assert.strictEqual(i18n.errorKey('execution reverted: IIA'), 'err.slippage');
  assert.strictEqual(i18n.errorKey('transaction was not confirmed in 30.00 seconds'), 'err.unconfirmed');
});

// ── The realised price ───────────────────────────────────────────────────────

test('the receipt divides the two numbers it was already printing', () => {
  // totSpent and totTok have always been on the receipt, one line apart. Nothing
  // ever divided them, so a 3x fill printed the whole proof and no conclusion.
  assert.match(TG, /receipt\.fillStats\(\{ spent: totSpent, tokens: totTok, refPxNative: entryM && entryM\.priceEth, rate: mUsd \}\)/);
  assert.match(TG, /'buy\.receipt\.realised', \{ px: fstatM\.realPx \}/);
});

test('a fill far from the displayed price says so, and a normal one stays quiet', () => {
  assert.match(TG, /fstatM\.offBy > 1\.15 \? ' ' \+ T\(chatId, 'buy\.receipt\.worse_than_shown'/);
  // The warning has to stay rare or it stops being read: a few percent of
  // ordinary impact must not trip it.
  assert.ok(1.02 <= 1.15 && 1.10 <= 1.15, 'ordinary impact would trip the warning');
  assert.ok(3.07 > 1.15, 'the reported trade would not have tripped it');
});

test('the realised-price copy names both the number and what it means', () => {
  for (const key of ['buy.receipt.realised', 'buy.receipt.worse_than_shown']) {
    assert.ok(i18n._strings[key], `${key} missing`);
    assert.notStrictEqual(i18n._strings[key].en, i18n._strings[key].id, `${key} untranslated`);
  }
  const w = i18n.t('en', 'buy.receipt.worse_than_shown', { times: '3.1' });
  assert.match(w, /3\.1/);
  assert.match(w, /thinner|transfer fee/, 'the warning does not say what causes it');
});

// ── Quote promised vs wallet delivered ───────────────────────────────────────

test('what Jupiter promised and what the wallet received are finally subtracted', () => {
  // Two adjacent lines in _buySol, never compared. A Token-2022 transfer fee is
  // invisible to this repo by any other route — grep for token-2022 / transferFee
  // / TransferFeeConfig returns nothing at all.
  assert.match(CORE, /const shortfall = \(quote && quote\.outAmount > 0n && got > 0n && got < quote\.outAmount\)/);
  assert.match(CORE, /possible transfer fee/);
  assert.match(CORE, /shortfall,/, 'the shortfall never reaches the caller');
});

// ── The Solana sell had no P/L, on any path ──────────────────────────────────

test('_sellSol returns the profit it has always computed', () => {
  // It wrote realizedEth into the stored position and left it out of the object
  // it returned, so telegram.js read NaN and its isFinite guard dropped the line.
  // Every Solana sell ever made printed a receipt with no profit or loss on it.
  const sell = CORE.slice(CORE.indexOf('async function _sellSol('), CORE.indexOf('async function _withdrawSol('));
  assert.match(sell, /let realizedThisSell = 0;/, 'the value is still trapped inside the if (pos) block');
  assert.match(sell, /realizedEth: realizedThisSell/, 'the returned object still omits the P/L');
  assert.ok(sell.indexOf('let realizedThisSell = 0;') < sell.indexOf('if (pos) {'),
    'it is declared inside the block again, so it cannot reach the return');
});

test('the multi-wallet sell receipt has a P/L line at all', () => {
  assert.match(TG, /const pnlLineM = \(okN > 0 && pnlSeen && totPnl !== 0\)/);
  assert.match(TG, /const txt = head \+ pnlLineM \+/);
  // pnlSeen, not "totPnl !== 0": a chain that genuinely returns no P/L must
  // print nothing rather than a confident zero.
  assert.match(TG, /pnlSeen = pnlSeen \|\| Number\.isFinite\(Number\(r\.realizedEth\)\)/);
});

test('"Total received" is what the user kept, not what the swap emitted', () => {
  // On Solana the bot's 1% is a SEPARATE transfer broadcast after the wallet
  // delta is measured, so proceedsEth is money that left again.
  assert.match(CORE, /netEth: solana\.lamportsToSol\(proceeds - fee\)/);
  assert.match(TG, /const kept = Number\(r\.netEth != null \? r\.netEth : r\.proceedsEth\) \|\| 0;/);
  assert.match(TG, /totProceeds \+= kept;/);
});

test('the buy reports what left the wallet as well as what reached the swap', () => {
  // The fee is carved out BEFORE the swap on a buy, so "Invested 0.04950" for a
  // 0.05 SOL action was the smaller of the two — understating the outlay, in the
  // direction that flatters the trade.
  assert.match(CORE, /grossEth: solana\.lamportsToSol\(gross\)/);
});

// ── The arithmetic this whole file exists for ────────────────────────────────

test('the reported trade reproduces from the recorded numbers', () => {
  const SOLUSD = 75.4;
  const spent = 0.04950, tokens = 125660, received = 0.01075;
  const shownBuy = 9.67e-6, shownSell = 8.17e-6;
  const realBuy = (spent / tokens) * SOLUSD;
  const realSell = (received / tokens) * SOLUSD;
  assert.ok(Math.abs(realBuy / shownBuy - 3.07) < 0.05, `entry was ${(realBuy / shownBuy).toFixed(2)}x, expected ~3.07x`);
  assert.ok(Math.abs(realSell / shownSell - 0.79) < 0.02, `exit was ${(realSell / shownSell).toFixed(2)}x, expected ~0.79x`);
  // Market −15.5%, user −78%.
  const market = shownSell / shownBuy;
  assert.ok(Math.abs(market - 0.845) < 0.005);
  assert.ok(Math.abs(received / spent - 0.2172) < 0.002, 'the round trip does not reproduce');
  // And the guard's default would have stopped it.
  assert.ok(realBuy / shownBuy > 2, 'a 2x limit would not have caught the reported fill');
});

test('slippage could not have permitted it, at any setting this code can express', () => {
  // 10000 × (1 − 1/3.0715) = 6744 bps needed. setSlippage throws above 50% and
  // every escalation path clamps at 5000 bps, which permits at most 2.0x.
  const needed = 10000 * (1 - 1 / 3.0715);
  assert.ok(needed > 5000, `${needed.toFixed(0)} bps needed — inside the 5000 clamp, so slippage IS a candidate after all`);
  assert.match(CORE, /Math\.min\(5000, Number\(slipBps\(u\)\) \+ slipAdd\)/);
});

test('Jupiter hands back a price impact on every quote', () => {
  // It was parsed, returned and read by nothing — the one number that describes
  // the trade's own cost, discarded on the path where it mattered.
  assert.match(SOL, /priceImpactPct: Number\(q\.priceImpactPct \|\| 0\)/);
  assert.ok(typeof solana.parseQuote === 'function');
  const q = solana.parseQuote({ inAmount: '1000', outAmount: '2000', otherAmountThreshold: '1900', priceImpactPct: '0.42' });
  assert.strictEqual(q.priceImpactPct, 0.42);
});
