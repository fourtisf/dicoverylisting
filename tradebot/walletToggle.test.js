'use strict';
/*
 * walletToggle.test.js — "pilih wallet tidak working fixkan dan pilih wallet
 * harus cpt".
 *
 * The multi-wallet picker on the token card redrew the WHOLE card on every tap,
 * and a full render is the price/liquidity/safety scan, a token-meta read and a
 * balance PAIR for every wallet the user has — ~22 network calls to change one
 * bit. With ten wallets on a public RPC each tap took seconds, and because the
 * poll loop does not await handleUpdate, a run of taps ran CONCURRENTLY: the
 * slowest render landed last and repainted a selection older than the tap that
 * produced it. The wallet just lit went dark again, which is indistinguishable
 * from a toggle that does not work — and is how it was reported.
 *
 * Two rules hold it:
 *   • a toggle redraws from the last FULL render (opts.reuse) — no network;
 *   • the newest tap owns the message (redrawTicket) — a stale render is
 *     dropped rather than painted.
 *
 * …and the reuse must never outlive the truth it caches: a fresh open, a chain
 * switch and 🔄 Refresh always read live, and a trade drops the entry.
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');

test('a wallet toggle redraws from the last full render, not from the network', () => {
  const h = SRC.slice(SRC.indexOf("if (k === 'wex1' || k === 'wex0'"), SRC.indexOf("if (k === 'wtg')"));
  assert.ok(h.length > 200, 'the picker handler moved — this test is asserting nothing');
  assert.match(h, /tokenCard\(chatId, mca, chainK, wid, \{ multi: k !== 'wex0', reuse: true \}\)/,
    'a toggle pays the full scan again');
});

test('only the toggle path reuses — a fresh look is always live', () => {
  // A stale price is acceptable only when the user did not ask to look again.
  const sites = SRC.split('\n').filter((l) => /await tokenCard\(/.test(l));
  assert.ok(sites.length >= 2, 'expected several tokenCard call sites');
  const reusing = sites.filter((l) => /reuse: true/.test(l));
  assert.strictEqual(reusing.length, 1, `only the wallet picker may reuse, found ${reusing.length}:\n${reusing.join('\n')}`);
  // …and the render only seeds the cache on a LIVE pass, so reuse cannot chain
  // off reuse and hold a price past its window.
  assert.match(SRC, /if \(!reuse && CARD_REUSE_MS > 0\) \{\s*\n\s*_cardReuse\.set\(/);
});

test('a trade drops the cached render — no toggle may repaint the old bag', () => {
  assert.match(SRC, /async function doBuy\(chatId, ca, amt, chain, walletId\) \{\s*\n\s*invalidateCard\(chatId, ca, chain\)/);
  assert.match(SRC, /async function doSell\(chatId, ca, pct, chain, walletId\) \{\s*\n\s*invalidateCard\(chatId, ca, chain\)/);
  // The monitor opens right after a fill — the other side of the same window.
  assert.match(SRC, /function startMonitor\(chatId, ca, chainKey, wid, opts\) \{[\s\S]{0,400}invalidateCard\(chatId, ca, chainKey\)/);
});

test('the newest tap owns the card — a slower render is dropped, not painted', () => {
  const h = SRC.slice(SRC.indexOf("if (k === 'wex1' || k === 'wex0'"), SRC.indexOf("if (k === 'wtg')"));
  assert.match(h, /const isLatest = redrawTicket\(chatId, mid\)/);
  assert.match(h, /if \(!isLatest\(\)\) return;/, 'a stale render can still repaint an older selection');
  // The live monitor's picker is the same shape and needs the same guard.
  const m = SRC.slice(SRC.indexOf("if (k === 'mw' || k === 'mwa' || k === 'mwn')"), SRC.indexOf("if (k === 'wex1' || k === 'wex0'"));
  assert.match(m, /redrawTicket\(chatId, mid\)/);
  assert.match(m, /if \(!isLatestM\(\)\) return;/);
});

test('the ticket is per MESSAGE, and the map cannot grow without bound', () => {
  const fn = SRC.slice(SRC.indexOf('function redrawTicket('), SRC.indexOf('function redrawTicket(') + 500);
  // Keyed by chat AND message: two cards in one chat must not cancel each other.
  assert.match(fn, /const key = chatId \+ ':' \+ mid;/);
  assert.match(fn, /_redrawSeq\.size > 2000/, 'a long-lived process would grow this for ever');
});

test('the reuse window is bounded and can be switched off', () => {
  assert.match(SRC, /const CARD_REUSE_MS = Math\.max\(0, Number\(process\.env\.CARD_REUSE_MS \|\| 20000\)\)/);
  // 0 disables it: an operator who suspects staleness can take it out without a
  // deploy, the same escape hatch the other caches keep.
  assert.match(SRC, /opts\.reuse && CARD_REUSE_MS > 0/);
});
