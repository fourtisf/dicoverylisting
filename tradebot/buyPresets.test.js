'use strict';
/*
 * buyPresets.test.js — the quick-buy amounts on a token card.
 *
 * Two defects, one request. A user on Solana was offered 0.01 / 0.05 / 0.1 SOL —
 * under a dollar at the top end — because the defaults were a single global set
 * denominated in nobody's coin in particular. And the count was frozen at three
 * by THREE independent places that all had to agree:
 *
 *   _presetsOk        (getter)   a.length === 3
 *   the store migration          s.buyPresets.length !== 3  → overwrite AND saveStore
 *   setBuyPresets     (setter)   toks.length !== 3
 *
 * The migration is the one that made it unfixable from the outside: it did not
 * merely reject a five-amount array, it replaced it with the default and
 * persisted that, so a longer set could not survive its owner's next touch.
 *
 * The card was the fourth place: it wrote bp[0], bp[1], bp[2] out by hand.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const core = require('./core');
const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');

const user = (over) => ({ settings: Object.assign({
  slippage: 0, buyPresets: [0.01, 0.05, 0.1], presetsByChain: {},
}, over || {}) });

// ── Chain-aware defaults ─────────────────────────────────────────────────────

test('Solana gets SOL-sized defaults, not an ETH-sized global', () => {
  assert.deepStrictEqual(core.buyPresets(user(), 'solana'), [0.1, 0.2, 0.5, 1, 2]);
});

test('a chain with no entry of its own keeps the global default', () => {
  assert.deepStrictEqual(core.buyPresets(user(), 'robinhood'), [0.01, 0.05, 0.1]);
  assert.deepStrictEqual(core.buyPresets(user(), 'ethereum'), [0.01, 0.05, 0.1]);
});

test("a user's own per-chain amounts outrank the chain default", () => {
  assert.deepStrictEqual(core.buyPresets(user({ presetsByChain: { solana: [0.3, 0.7] } }), 'solana'), [0.3, 0.7]);
});

test('an explicit GLOBAL choice outranks the chain default; the seeded one does not', () => {
  // Every user is seeded with settings.buyPresets = the global default, and
  // setBuyPresets can only reach the global when the chain is disabled — so
  // "does it differ from the default" would be false for essentially everyone
  // and the chain default would never apply. The flag is what separates a
  // choice from a seed.
  assert.deepStrictEqual(core.buyPresets(user({ buyPresets: [5, 10, 20] }), 'solana'), [0.1, 0.2, 0.5, 1, 2],
    'an unflagged global (i.e. the seed) suppressed the chain default');
  assert.deepStrictEqual(core.buyPresets(user({ buyPresets: [5, 10, 20], buyPresetsSet: true }), 'solana'), [5, 10, 20],
    "a user's explicit global choice was overridden by a default");
});

// ── The count is a range, in all three owners ────────────────────────────────

test('every place that used to demand exactly three now agrees on the range', () => {
  const csrc = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
  assert.ok(!/length !== 3|length === 3|toks\.length !== 3/.test(csrc), 'an exact-3 check survived somewhere');
  const uses = csrc.match(/PRESETS_MIN|PRESETS_MAX/g) || [];
  assert.ok(uses.length >= 6, `the range constants are used ${uses.length} times — expected the getter, the migration and the setter`);
});

test('the migration keeps a five-amount set instead of overwriting and saving over it', () => {
  // This is the one that made the feature impossible to configure: the old line
  // set ch = true, which reaches saveStore() and PERSISTS the rollback.
  const csrc = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
  const line = csrc.split('\n').find((l) => l.includes('s.buyPresets = DEFAULT_BUY_PRESETS.slice()'));
  assert.ok(line, 'the migration line moved — re-check this test');
  assert.match(line, /s\.buyPresets\.length < PRESETS_MIN \|\| s\.buyPresets\.length > PRESETS_MAX/);
});

test('the getter accepts the requested five and still rejects nonsense', () => {
  const ok = (a) => core.buyPresets(user({ presetsByChain: { solana: a } }), 'solana');
  assert.deepStrictEqual(ok([0.1, 0.2, 0.5, 1, 2]), [0.1, 0.2, 0.5, 1, 2]);
  // Out of range, and each falls back rather than rendering a broken card.
  assert.notDeepStrictEqual(ok([1]), [1], 'a single preset was accepted');
  assert.notDeepStrictEqual(ok([1, 2, 3, 4, 5, 6, 7]), [1, 2, 3, 4, 5, 6, 7], 'seven presets were accepted');
  // The render constraints that keep a callback under 64 bytes are unchanged.
  assert.notDeepStrictEqual(ok([0.1, 1e-7]), [0.1, 1e-7], 'an exponential amount was accepted');
  assert.notDeepStrictEqual(ok([0.1, 101]), [0.1, 101], 'an amount over 100 was accepted');
  assert.notDeepStrictEqual(ok([0.1, 0.123456789]), [0.1, 0.123456789], 'a long amount was accepted');
});

// ── The card ─────────────────────────────────────────────────────────────────

test('the buy row is built from the list, not from bp[0] bp[1] bp[2]', () => {
  assert.ok(!/bp\[0\]|bp\[1\]|bp\[2\]/.test(SRC), 'the card still indexes three presets by hand');
  assert.match(SRC, /const buyBtns = bp\.map\(\(a\) => btn\(`Buy \$\{a\}`, `b:\$\{chainKey\}:\$\{wi\}:\$\{ca\}:\$\{a\}`\)\)/);
  assert.match(SRC, /for \(let i = 0; i < buyBtns\.length; i \+= 4\) ikb\.push\(buyBtns\.slice\(i, i \+ 4\)\)/);
});

test('the custom-amount button survives every preset count', () => {
  // It is pushed onto the list BEFORE chunking, so it is always in a row —
  // never the one that falls off the end.
  const at = SRC.indexOf("buyBtns.push(btn('✏️ Buy custom'");
  const chunk = SRC.indexOf('for (let i = 0; i < buyBtns.length; i += 4)');
  assert.ok(at > -1 && chunk > at, 'the custom button is added after the chunking, or not at all');
  assert.match(SRC, /bx:\$\{chainKey\}:\$\{wi\}:\$\{ca\}/, 'the custom-amount callback is gone');
});

test('"Buy X" is not a label a user can identify', () => {
  assert.ok(!/btn\('Buy X'/.test(SRC), 'the old ambiguous label is back — it reads as a preset called X');
});

// ── The 64-byte callback budget, at the real worst case ──────────────────────

test('the longest possible buy callback still fits Telegram 64 bytes', () => {
  // tokenCard.test.js checks this at 61 bytes (robinhood, single-digit wallet
  // index, 4-char preset, 42-char EVM address). None of those is the worst case,
  // and btn() does no length check — an overflow does not disable one button, it
  // makes Telegram reject the whole sendMessage, so the card never renders.
  const worst = (chain, caLen, amt) => `b:${chain}:99:${'x'.repeat(caLen)}:${amt}`.length;
  const cases = [
    ['robinhood', 42, '0.0001'],   // longest chain key, longest EVM address, 6-char preset
    ['solana', 44, '0.0001'],      // Solana mints are 44 chars, two longer than EVM
    ['solana', 44, '2'],           // the amounts this change actually ships
    ['robinhood', 42, '0.1'],
  ];
  for (const [chain, caLen, amt] of cases) {
    const n = worst(chain, caLen, amt);
    assert.ok(n <= 64, `b:${chain}:99:<${caLen}-char ca>:${amt} is ${n} bytes`);
  }
  // And the shipped Solana amounts leave real headroom, which the 6-char ceiling
  // in setBuyPresets is what protects.
  assert.ok(worst('solana', 44, '0.5') <= 62);
});

test('the presets editor names the range and this chain, not a hardcoded three', () => {
  assert.ok(!/Send <b>3 quick-buy amounts<\/b>/.test(SRC), 'the prompt still says 3');
  assert.match(SRC, /core\.PRESETS_MIN\}–\$\{core\.PRESETS_MAX\} quick-buy amounts/);
  // …and shows what they are NOW, so the example is never denominated in a coin
  // the user is not holding.
  assert.match(SRC, /const cur = core\.buyPresets\(core\.ensureUser\(chatId\), ck\)\.join\(' '\)/);
});
