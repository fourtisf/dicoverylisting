'use strict';
/*
 * monitorSymbol.test.js — the live-position card must be able to name the token.
 *
 * `const sym = (pos && pos.sym) || (snap && snap.sym) || '?'` — `pos` is only
 * the wallet the card is BOUND to, and tokenSnapshot carries `sym` only on the
 * Solana/DEX branch (core.js:1101); the EVM curve snapshot has no such field.
 * So a card opened on Wallet 1 while Wallets 2-4 held the token had neither
 * source and printed "$?" four times, including in its own title, over a
 * position worth real money.
 *
 * The identical defect for DECIMALS is documented in a comment immediately
 * below the line — found, fixed, and the symbol one line above it left alone.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
const fn = SRC.slice(SRC.indexOf('async function monitorPayload('), SRC.indexOf('function startMonitor('));

test('the card never labels a token "?"', () => {
  assert.ok(!/\|\| '\?'/.test(fn), 'the "?" fallback is back');
  // Every rendering of the symbol must go through symTxt; the only place a raw
  // `esc(sym)` is allowed is symTxt's own definition.
  const withoutDefn = fn.split('\n').filter((l) => !l.includes('const symTxt =')).join('\n');
  assert.ok(!/esc\(sym\)/.test(withoutDefn), 'a raw sym is being interpolated again');
});

test('the symbol is looked for in every wallet, not just the bound one', () => {
  // The in-memory scan is what fixes the reported case, and it costs nothing.
  assert.match(fn, /for \(const wal of core\.walletList\(u\)\)/);
  assert.match(fn, /\(wal\.positions \|\| \{\}\)\[posKey\]/);
});

test('tokenMeta is the last resort, not the first', () => {
  // It is a network call on a card whose whole job is to feel live, so it may
  // only run when no wallet has ever recorded the token.
  const scanAt = fn.indexOf('core.walletList(u)');
  const metaAt = fn.indexOf('core.tokenMeta(');
  assert.ok(scanAt > -1 && metaAt > -1);
  assert.ok(scanAt < metaAt, 'the network call comes before the free in-memory scan');
  assert.match(fn, /if \(!sym\) \{\s*\n\s*const meta = await withTmo\(core\.tokenMeta\(/,
    'tokenMeta runs unconditionally instead of only when the symbol is still unknown');
});

test('an unnameable token is identified by its contract, not by punctuation', () => {
  assert.match(fn, /const symTxt = sym \? `\$\$\{esc\(sym\)\}` : `<code>\$\{esc\(short\(ca\)\)\}<\/code>`/);
});
