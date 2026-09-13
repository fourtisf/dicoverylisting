'use strict';
/*
 * multiBuyReceipt.test.js — what a multi-wallet buy says when it did not work.
 *
 * The card that prompted this, verbatim from a live chat:
 *
 *     ✅ Bought $ · 0/5 wallets
 *     Total: 0.0000 $ · spent 0.00000 ETH ($0.00)
 *     📈 Price: $0.0000182 · market cap $18.18K
 *     • Wallet 1 · ❌ buy failed on Solana: fetch failed
 *     • Wallet 2 · ❌ buy failed on Solana: fetch failed
 *     • Wallet 3 · ❌ buy failed on Solana: fetch failed
 *     • Wallet 4 · ❌ buy failed on Solana: fetch failed
 *     • Wallet 5 · ❌ buy failed on Solana: fetch failed
 *
 * A green tick over five red crosses; ETH on a Solana trade; an empty ticker;
 * a price line for a fill that never happened; and one outage rendered five
 * times in engine-speak. `sym` and `nat` were only ever written by a wallet
 * that FILLED, so with none filling they fell back to '' and the literal 'ETH'.
 *
 * These read the source rather than driving Telegram, because the receipt is
 * built inline inside doBuy's multi-wallet branch — the same approach
 * walletScreen.test.js takes, and for the same reason: it pins the rules the
 * copy has to obey without pinning the copy, which lives in i18n.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
const i18n = require('./i18n');
// doBuy's multi-wallet branch: from the Promise.allSettled fan-out to the
// monitor that follows the receipt.
const multi = SRC.slice(SRC.indexOf('const buys = Promise.allSettled('), SRC.indexOf('async function sellWithRetry('));

// ── The tick is a claim ──────────────────────────────────────────────────────

test('✅ is reserved for a buy where every wallet filled', () => {
  assert.match(multi, /okN === 0 \? 'buy\.receipt\.multi\.none' : okN < targets\.length \? 'buy\.receipt\.multi\.some' : 'buy\.receipt\.multi'/);
  assert.match(i18n._strings['buy.receipt.multi'].en, /^✅/);
  assert.match(i18n._strings['buy.receipt.multi.some'].en, /^⚠️/);
  assert.match(i18n._strings['buy.receipt.multi.none'].en, /^❌/);
});

test('a receipt for nothing does not print a total, a ticker or a spend', () => {
  // "Total: 0.0000 $ · spent 0.00000 ETH ($0.00)" is a fill report for a trade
  // that never left the building.
  const none = i18n._strings['buy.receipt.multi.none'];
  for (const lang of ['en', 'id']) {
    assert.ok(!/\{tokens\}|\{spent\}|\{usd\}|\{sym\}/.test(none[lang]), `${lang} still renders fill figures`);
  }
  assert.match(none.en, /No \{native\} was spent/);
  assert.notStrictEqual(none.en, none.id);
});

test('the price line is only shown for a buy that happened', () => {
  // Under a failure header it reads as the price it filled at.
  assert.match(multi, /const mkt = okN > 0 \? await marketLine\(ca, chainKey\) : ''/);
});

// ── The right coin, and a ticker at all ──────────────────────────────────────

test("the native coin comes from the chain, never a hardcoded 'ETH'", () => {
  // `nat` is written only by a wallet that filled, so 0/5 on Solana printed ETH.
  assert.match(multi, /const natShown = nat \|\| chG\.native \|\| 'ETH'/);
  assert.match(multi, /nativeUsd\(natShown\)/, 'the USD rate is still taken from the fallback coin');
  assert.ok(!/nativeUsd\(nat \|\| 'ETH'\)/.test(multi), "the old 'ETH' fallback is back on the USD rate");
  assert.ok(!/native: esc\(nat \|\| 'ETH'\)/.test(multi), "the old 'ETH' fallback is back on the header");
});

test('the ticker falls back to the token, then to its address — never to blank', () => {
  assert.match(multi, /const symShown = sym \|\| \(await tokenSym\(ca, chainKey\)\) \|\| short\(ca\)/);
  assert.match(SRC, /async function tokenSym\(ca, chainKey\)/);
  // …and looking it up must never be able to fail the receipt itself.
  const fn = SRC.slice(SRC.indexOf('async function tokenSym('), SRC.indexOf('/** One wallet\'s line'));
  assert.match(fn, /catch\(\(\) => null\)/);
  assert.match(fn, /withTmo\(/);
});

// ── One outage is one fact ───────────────────────────────────────────────────

test('every wallet failing the same way is said once, in the user\'s language', () => {
  assert.match(multi, /const oneReason = okN === 0 && fails\.length > 1/);
  assert.match(multi, /new Set\(fails\.map\(\(f\) => String\(\(f\.e && \(f\.e\.message \|\| f\.e\)\) \|\| ''\)\)\)\.size === 1/);
  assert.match(multi, /friendlyError\(chatId, fails\[0\]\.e, 'buy'\)/,
    'the roll-up still prints the raw engine string');
});

test('mixed failures still get one line each', () => {
  // Two wallets failing for two different reasons are two facts, and collapsing
  // them would hide one.
  assert.match(multi, /: lines\.join\('\\n'\)/);
});

test('the collapsed line names the wallets it covers', () => {
  assert.match(multi, /'buy\.receipt\.multi\.same', \{ wallets:/);
  assert.match(i18n._strings['buy.receipt.multi.same'].en, /\{wallets\}/);
  assert.notStrictEqual(i18n._strings['buy.receipt.multi.same'].en, i18n._strings['buy.receipt.multi.same'].id);
});

// ── The buttons ──────────────────────────────────────────────────────────────

test('a failed buy offers the way back to the token, not a monitor', () => {
  // 📍 Monitor and 📊 Portfolio on a receipt for zero fills point at a position
  // that does not exist.
  assert.match(multi, /okN === 0\n?\s*\? rows\(\[btn\('🔄 Try again'/);
  assert.match(multi, /if \(okN > 0\) startMonitor\(/, 'a monitor is opened for a buy that never filled');
});

// ── Copy ─────────────────────────────────────────────────────────────────────

test('every new receipt string is translated', () => {
  for (const key of ['buy.receipt.multi', 'buy.receipt.multi.some', 'buy.receipt.multi.none', 'buy.receipt.multi.same']) {
    assert.ok(i18n._strings[key], `${key} missing`);
    assert.notStrictEqual(i18n._strings[key].en, i18n._strings[key].id, `${key} was not actually translated`);
  }
});
