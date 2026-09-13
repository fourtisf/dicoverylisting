'use strict';
/*
 * What the portfolio card is allowed to say.
 *
 * The card that shipped printed one line:
 *
 *     Value $6.17 · 0.0033 ETH · 2.13× (+113%)
 *
 * The value was what the user held THAT MOMENT. The multiple was every trade
 * they had EVER made, closed positions included. Both live positions were down
 * (−2% and −67%), and the header read as "up 113%". Below it, a token sold out
 * months ago rendered as
 *
 *     $CDLR · $0.0000 · 3.99× (+299%)
 *       0.0000 · in 0.0891 → now 0.0000 ETH · PnL +0.0000
 *
 * — a gain, a zero and a zero, all true of different things, none labelled.
 *
 * These tests are about MEANING, not layout: a number on this card must be
 * unambiguous about what it measures, and never sit next to one that measures
 * something else without saying so.
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pf-test-'));
process.env.WALLET_SECRET = 'w'.repeat(48);
process.env.TRADEBOT_TOKEN = 'x:y';

const core = require('./core');
const tg = require('./telegram');
const TG_SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
const CORE_SRC = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');

// The real shape from the user's own screenshot: two losing open positions and
// three closed ones that between them made a lot of money.
const FIXTURE = {
  chain: { emoji: '🪶', name: 'Robinhood Chain', key: 'robinhood' }, native: 'ETH',
  totalValueEth: 0.0034, totalCostEth: 0.0037, totalUnrealEth: -0.0005, totalRealizedEth: 0.5897,
  rows: [
    { ca: '0x' + 'a'.repeat(40), sym: 'PONS', open: true, tokens: 225.09, valueEth: 0.0032,
      ethIn: 0.0032, ethOut: 0, costEth: 0.0032, realizedEth: 0, unrealizedEth: -0.0001,
      holders: [{ label: 'Wallet 2', tokens: 75.03 }, { label: 'Wallet 3', tokens: 75.03 }] },
    { ca: '0x' + 'c'.repeat(40), sym: 'CDLR', open: false, tokens: 0, valueEth: 0,
      ethIn: 0.0891, ethOut: 0.3555, costEth: 0, realizedEth: 0.2664, unrealizedEth: 0, holders: [] },
  ],
};
const render = async (pf = FIXTURE, rate = 1870) => {
  const real = core.portfolioAll;
  core.portfolioAll = async () => pf;
  tg._test.PRICES.ETH = rate;
  try { return (await tg._test.portfolioScreen('7')).text.replace(/<[^>]+>/g, ''); }
  finally { core.portfolioAll = real; }
};

// ---------------------------------------------------------------- the headline
test('the headline never puts a lifetime multiple beside what you hold now', async () => {
  const t = await render();
  const head = t.slice(0, t.indexOf('── Open ──'));
  assert.ok(/Holding now:/.test(head), 'the card must say what is held right now');
  assert.ok(!/2\.13×/.test(head) && !/\+113%/.test(head), 'the old blended figure is back');
  // The specific shape that caused it: a × on the same line as the value.
  const valueLine = head.split('\n').find((l) => l.includes('Holding now'));
  assert.ok(!valueLine.includes('×'), `a multiple sits on the value line: ${valueLine}`);
});

test('realized and unrealized are separate, labelled, and say which is which', async () => {
  const t = await render();
  assert.match(t, /Unrealized:.*on what you still hold/, 'unrealized must name its base');
  assert.match(t, /Realized:.*banked from closed trades/, 'realized must name its source');
  // A losing book must not be able to read as a winning one.
  assert.match(t, /🔴 Unrealized: −0\.0005 ETH/);
  assert.match(t, /🟢 Realized: \+0\.5897 ETH/);
});

test('a portfolio whose live positions are ALL down never shows a gain up top', async () => {
  // The exact complaint. Realized profit is real and stays on the card — it just
  // may not be spent describing positions that are losing money.
  const t = await render();
  const unreal = t.split('\n').find((l) => l.includes('Unrealized'));
  assert.ok(unreal.includes('🔴'), `a losing book showed as a gain: ${unreal}`);
});

// ---------------------------------------------------------------- units
test('every native figure carries its USD twin', async () => {
  // "PnL -0.0001" is not a number anyone can act on.
  const t = await render();
  for (const line of t.split('\n')) {
    if (!/\bETH\b/.test(line) || /tokens ·/.test(line) === false && /cost /.test(line) === false && !/ETH/.test(line)) continue;
    if (/× on /.test(line)) continue;                 // "3.99× on 0.0891 ETH" is a ratio's base
    if (/^\s*0x/.test(line)) continue;
    assert.match(line, /\$\d/, `a native figure with no USD beside it: ${line}`);
  }
});

test('one minus sign, not two different ones', async () => {
  // toFixed() emits an ASCII hyphen; the money formatter uses U+2212. Mixing put
  // "−0.0005 ETH" and "-13.5%" on the same line.
  const t = await render();
  const neg = t.split('\n').filter((l) => l.includes('−') || /[^\w]-\d/.test(l));
  for (const l of neg) assert.ok(!/[^\w]-\d/.test(l), `ASCII hyphen mixed with − on: ${l}`);
});

// ---------------------------------------------------------------- closed rows
test('a sold-out position shows what it banked, and nothing that implies it is live', async () => {
  const t = await render();
  const closed = t.slice(t.indexOf('── Closed'));
  assert.match(closed, /\$CDLR/);
  assert.match(closed, /\+0\.2664 ETH/, 'the realized result must be stated');
  assert.ok(!/now 0\.0000/.test(closed), 'a closed row must not report a live value');
  assert.ok(!/PnL \+0\.0000/.test(closed), 'a closed row must not report an unrealized PnL of zero');
});

test('open and closed live in separate sections', async () => {
  const t = await render();
  const iOpen = t.indexOf('── Open ──');
  const iClosed = t.indexOf('── Closed');
  assert.ok(iOpen > -1 && iClosed > iOpen, 'the two kinds of row must not be interleaved');
  assert.ok(t.slice(iOpen, iClosed).includes('$PONS'), 'the held token belongs under Open');
  assert.ok(!t.slice(iOpen, iClosed).includes('$CDLR'), 'a sold-out token must not sit under Open');
});

// ---------------------------------------------------------------- engine
test('realized profit comes from the position ledger, not from proceeds minus cost', async () => {
  // ethOut - ethIn is not profit: on a PARTIAL exit, proceeds are cash out, so a
  // token sold halfway would read as a loss until it was fully closed. sell()
  // books realizedEth per position; that is the number.
  assert.match(CORE_SRC, /agg\.realizedEth \+= Number\(p\.realizedEth\) \|\| 0;/);
  assert.match(CORE_SRC, /const totalRealizedEth = rows\.reduce\(/);
});

test('a closed row costs no network call — there is no live price to fetch', async () => {
  assert.match(CORE_SRC, /const snap = open \? await tokenSnapshot\(/,
    'closed rows must skip the snapshot; on a long history that is most of the list');
});

test('unrealized is zero on a closed row by construction, not by luck', async () => {
  assert.match(CORE_SRC, /unrealizedEth: !open \? 0 : \(priced \? valueEth - agg\.costEth : null\)/);
});

test('a price we could not read is null, never a 100% loss', async () => {
  // `snap ? snap.priceEth : 0` made a failed lookup set valueEth to 0, so
  // unrealized became MINUS THE WHOLE COST BASIS and got summed into the
  // header. One API hiccup and the user's book read as wiped out — a number we
  // invented, not one the market produced.
  assert.ok(!/const priceEth = snap \? snap\.priceEth : 0/.test(CORE_SRC),
    'the unpriced-is-zero fallback is back');
  assert.match(CORE_SRC, /const priceEth = \(snap && snap\.priceEth > 0\) \? snap\.priceEth : 0/);
  assert.match(CORE_SRC, /const priced = !open \|\| priceEth > 0/);
});

test('the unrealized total and the cost it is measured against cover the same rows', async () => {
  // Leaving an unpriced row's cost in the denominator while its gain is absent
  // from the numerator prints a percentage against money the numerator never
  // saw — a smaller, quieter version of the same invented loss.
  assert.match(CORE_SRC, /const priced = rows\.filter\(\(r\) => r\.priced\)/);
  assert.match(CORE_SRC, /const totalCostEth = priced\.reduce/);
  assert.match(CORE_SRC, /const totalUnrealEth = priced\.reduce/);
  assert.match(CORE_SRC, /const unpriced = rows\.filter\(\(r\) => !r\.priced\)\.length/,
    'the count is not returned, so the screen cannot admit the total is partial');
});

// ---------------------------------------------------------------- /monitor
test('/monitor exists — as a handler AND in the blue command menu', async () => {
  // It was neither. Typing it fell through to "I didn't recognise that", and the
  // live tracker was reachable only from a button on a token card — which is not
  // where someone who has already bought is looking.
  assert.match(TG_SRC, /text === '\/monitor' \|\| text === '\/track'/, 'no /monitor handler');
  assert.match(TG_SRC, /\{ command: 'monitor',/, "/monitor is not in setMyCommands");
  assert.match(TG_SRC, /data === 'monlist'/, 'the 📍 Monitor button has no route');
});

test('the monitor picker lists what you hold, with a button per position', async () => {
  const real = core.portfolioAll;
  core.portfolioAll = async () => FIXTURE;
  tg._test.PRICES.ETH = 1870;
  try {
    const s = await tg._test.monitorListScreen('7');
    assert.match(s.text.replace(/<[^>]+>/g, ''), /\$PONS/, 'the held position is missing');
    assert.ok(!s.text.includes('$CDLR'), 'a sold-out token has nothing to track');
    const btns = s.kb.inline_keyboard.flat();
    assert.ok(btns.some((b) => (b.callback_data || '').startsWith('monn:')), 'no button opens a tracker');
  } finally { core.portfolioAll = real; }
});

test('holding nothing says so plainly instead of rendering an empty list', async () => {
  const real = core.portfolioAll;
  core.portfolioAll = async () => ({ ...FIXTURE, rows: [] });
  try {
    const s = await tg._test.monitorListScreen('7');
    assert.match(s.text.replace(/<[^>]+>/g, ''), /nothing to track/i);
  } finally { core.portfolioAll = real; }
});
