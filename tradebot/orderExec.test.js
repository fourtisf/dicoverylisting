'use strict';
/*
 * What a triggered order is allowed to spend to actually LAND.
 *
 * A stop-loss fires at exactly the moment the price is falling and every other
 * holder is trying to leave — the worst conditions for the default gas price and
 * the default slippage there are. The auto-protect guard has escalated since it
 * was written (gasMult 2, slipAddBps 1500). The stop-loss the user set BY HAND,
 * the one they are relying on, went out with no escalation at all:
 *
 *     const r = await core.sell(u.chatId, o.ca, o.sellPct || 100, chain, w.id);
 *
 * A stop-loss that does not fill is not a stop-loss. It is a notification that
 * you lost the money anyway.
 *
 * These tests pin three things: that the escalation reaches the trade, that it
 * is chosen by the order's INTENT rather than one setting for all four types,
 * and that the user is told what it will cost.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordexec-'));
process.env.WALLET_SECRET = 'w'.repeat(48);
process.env.TRADEBOT_TOKEN = 'x:y';
process.env.ENABLED_CHAINS = 'robinhood';

const core = require('./core');
const watchers = require('./watchers');
const tg = require('./telegram');

const CA = '0x' + 'ab'.repeat(20);
const CHAT = 7;

function seed(orders) {
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.wallets = [{ id: 'w1', name: 'Wallet 1', address: '0x' + '11'.repeat(20), positions: {}, orders: [], history: [] }];
  u.activeWalletId = 'w1';
  for (const o of orders) watchers.addOrder(CHAT, { ca: CA, sym: 'PONS', chain: 'robinhood', ...o }, 'w1');
  return u;
}

/** Run one orders cycle at a price that trips everything, and capture the opts
 *  each trade was given. */
async function fire(orders, priceEth = 0.000001) {
  seed(orders);
  const calls = [];
  const realSnap = core.tokenSnapshot, realSell = core.sell, realBuy = core.buy;
  core.tokenSnapshot = async () => ({ sym: 'PONS', priceEth, mcapEth: priceEth * 1e9 });
  core.sell = async (chatId, ca, pct, chain, wid, opts) => {
    calls.push({ side: 'sell', pct, opts });
    return { sym: 'PONS', soldPct: pct, proceedsEth: 0.01, native: 'ETH', hash: '0x' + '1'.repeat(64) };
  };
  core.buy = async (chatId, ca, amt, chain, wid, opts) => {
    calls.push({ side: 'buy', amt, opts });
    return { sym: 'PONS', gotTokens: 1, spentEth: Number(amt), native: 'ETH', hash: '0x' + '1'.repeat(64) };
  };
  try { await watchers._test.ordersCycle(); }
  finally { core.tokenSnapshot = realSnap; core.sell = realSell; core.buy = realBuy; }
  return calls;
}

// ---------------------------------------------------------------- it reaches the trade
test('a stop-loss executes with escalated gas AND slippage', async () => {
  // The whole point. This used to be `core.sell(..., w.id)` with no sixth
  // argument at all.
  const calls = await fire([{ type: 'sl', targetPriceEth: 0.001, sellPct: 100 }]);
  assert.equal(calls.length, 1, 'the stop-loss did not fire');
  const o = calls[0].opts;
  assert.ok(o, 'the sell was given no execution options at all');
  assert.ok(o.gasMult > 1, `a stop-loss went out at ordinary gas (gasMult ${o.gasMult})`);
  assert.ok(o.slipAddBps > 0, `a stop-loss went out at ordinary slippage (slipAddBps ${o.slipAddBps})`);
});

test('a trailing stop is a stop, and is executed like one', async () => {
  const calls = await fire([{ type: 'trail', trailPct: 10, sellPct: 100, peakEth: 1 }]);
  assert.equal(calls.length, 1, 'the trailing stop did not fire');
  assert.deepEqual(calls[0].opts, watchers.ORDER_SPEED.turbo);
});

test('a limit BUY carries its options too — buy() ignored them entirely', async () => {
  // sell() has taken opts.gasMult since the retry work; buy() did not, so a
  // triggered limit buy could not be escalated even if the watcher asked.
  const calls = await fire([{ type: 'limitbuy', targetPriceEth: 0.001, ethAmount: '0.05' }]);
  assert.equal(calls.length, 1, 'the limit buy did not fire');
  assert.ok(calls[0].opts && calls[0].opts.gasMult > 1, 'the limit buy went out at ordinary gas');
  const CORE = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
  assert.match(CORE, /const gasBoost = Math\.max\(userGasBoost\(u\), \(opts && opts\.gasMult\) \|\| 1\);/,
    'core.buy still ignores opts.gasMult');
  assert.match(CORE, /const slipAdd = BigInt\(Math\.max\(0, Math\.round\(\(opts && opts\.slipAddBps\) \|\| 0\)\)\);[\s\S]{0,200}slipBps\(u,[^)]*\) \+ slipAdd/,
    'core.buy still ignores opts.slipAddBps');
  // The two slippage knobs answer different questions and must stay separate:
  // `slipBps` REPLACES the user's setting (a CA snipe fills through a pool one
  // block old and needs its own bound), `slipAddBps` ADDS to whichever applies
  // (the retry escalation). Folding them together would make an escalated snipe
  // silently authorise more than the user set.
  assert.match(CORE, /function slipBps\(u, overrideBps\)/, 'slippage has no absolute override');
  assert.match(CORE, /if \(Number\.isFinite\(o\) && o > 0\) return BigInt\(Math\.min\(5000, Math\.round\(o\)\)\);/,
    'the override is not capped at 50%');
});

// ---------------------------------------------------------------- chosen by intent
test('getting OUT is urgent; taking profit is not', async () => {
  // One setting for all four types would either overpay on every take-profit or
  // underpay on every stop. They are different trades.
  assert.equal(watchers.orderSpeed({ type: 'sl' }), 'turbo');
  assert.equal(watchers.orderSpeed({ type: 'trail' }), 'turbo');
  assert.equal(watchers.orderSpeed({ type: 'tp' }), 'fast');
  assert.equal(watchers.orderSpeed({ type: 'limitbuy' }), 'fast');
  assert.ok(watchers.ORDER_SPEED.turbo.gasMult > watchers.ORDER_SPEED.fast.gasMult);
  assert.ok(watchers.ORDER_SPEED.fast.gasMult > watchers.ORDER_SPEED.normal.gasMult);
  assert.equal(watchers.ORDER_SPEED.normal.slipAddBps, 0, 'Normal must mean the user\'s own settings, untouched');
});

test('the user can override the default, and the override is what executes', async () => {
  const calls = await fire([{ type: 'sl', targetPriceEth: 0.001, sellPct: 100, speed: 'normal' }]);
  assert.deepEqual(calls[0].opts, watchers.ORDER_SPEED.normal,
    'an order set to Normal was still escalated — the setting does nothing');
});

test('an unknown speed falls back to the type default, it does not crash or go quiet', async () => {
  assert.equal(watchers.orderSpeed({ type: 'sl', speed: 'ludicrous' }), 'turbo');
  assert.equal(watchers.orderSpeed({ type: 'sl', speed: null }), 'turbo');
  assert.equal(watchers.orderSpeed({}), 'fast', 'an order with no type must still execute');
});

test('escalation only ever RAISES the user\'s own gas priority', async () => {
  // core.sell takes max(userGasBoost, opts.gasMult). Someone who runs Turbo
  // globally must not be quietly slowed down by an order set to Normal.
  const CORE = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
  assert.match(CORE, /Math\.max\(userGasBoost\(u\), \(opts && opts\.gasMult\) \|\| 1\)/g);
  assert.equal((CORE.match(/Math\.max\(userGasBoost\(u\), \(opts && opts\.gasMult\) \|\| 1\)/g) || []).length, 2,
    'both buy and sell must take the user setting as the floor');
});

// ---------------------------------------------------------------- the user is told
test('every order says how hard it will try to land', async () => {
  seed([
    { type: 'sl', targetPriceEth: 0.001, sellPct: 100 },
    { type: 'tp', targetPriceEth: 9, sellPct: 100 },
  ]);
  tg._test.PRICES.ETH = 1870;
  const t = tg._test.ordersScreen(CHAT).text.replace(/<[^>]+>/g, '');
  assert.match(t, /Turbo/, 'the stop-loss never says it will pay 3× gas');
  assert.match(t, /Fast/, 'the take-profit never says what it will pay');
  assert.match(t, /3× gas/, 'the cost of Turbo is not stated');
  assert.match(t, /slippage/, 'the slippage cost is not stated');
});

test('every order has a button to change its speed', async () => {
  seed([{ type: 'sl', targetPriceEth: 0.001, sellPct: 100 }]);
  const kb = tg._test.ordersScreen(CHAT).kb.inline_keyboard.flat();
  const b = kb.find((x) => (x.callback_data || '').startsWith('ospd:'));
  assert.ok(b, 'a default nobody can change is a default nobody can disagree with');
  assert.match(b.text, /Turbo/, 'the button must say where the setting stands now');
  assert.ok(kb.some((x) => (x.callback_data || '').startsWith('oc:')), 'cancel must survive alongside it');
});

// ---------------------------------------------------------------- market vs limit
test('the sell screen offers a limit and a stop, not only market presets', async () => {
  // "🎯 TP" lived on the token card. Someone who has decided to sell is on THIS
  // screen, and it gave them nothing but orders that fill immediately.
  seed([]);
  const realMeta = core.tokenMeta, realBal = core.tokenBalance, realSnap = core.tokenSnapshot;
  core.tokenMeta = async () => ({ sym: 'PONS', decimals: 18, name: 'Pons' });
  core.tokenBalance = async () => 75030000000000000000n;
  core.tokenSnapshot = async () => ({ sym: 'PONS', priceEth: 0.00001 });
  try {
    const s = await tg._test.sellMenu(CHAT, CA, 'robinhood', 'w1');
    const kb = s.kb.inline_keyboard.flat();
    assert.ok(kb.some((b) => (b.callback_data || '').startsWith('tp:')), 'no limit sell on the sell screen');
    assert.ok(kb.some((b) => (b.callback_data || '').startsWith('sl:')), 'no stop-loss on the sell screen');
    assert.ok(kb.some((b) => (b.callback_data || '').startsWith('s:')), 'the market presets must stay');
    // …and the two kinds are named, so a preset is not mistaken for a limit.
    const t = s.text.replace(/<[^>]+>/g, '');
    assert.match(t, /Market/, 'the presets are never identified as market orders');
    assert.match(t, /sell \*{0,2}now\*{0,2}|sell now/i, 'market is not explained as "fills immediately"');
    assert.match(t, /Limit/, 'the limit alternative is not named');
  } finally { core.tokenMeta = realMeta; core.tokenBalance = realBal; core.tokenSnapshot = realSnap; }
});

test('"Limit" on the token card says which side it is', async () => {
  // It set a limit BUY, and was labelled "⏳ Limit" next to four Sell buttons.
  const TG = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  assert.match(TG, /btn\('⏳ Limit buy', `lb:/);
});

// ---------------------------------------------------------------- typing a target
//
// A market-cap target is six or seven digits, and it had to be typed out in
// full: "mc 1000000". One wrong zero sets the order ten times away from what was
// meant, on a screen whose whole job is to fire without asking again.

const { parseUsd } = tg._test;

test('a market cap can be typed the way people say it', () => {
  assert.equal(parseUsd('2k'), 2_000);
  assert.equal(parseUsd('10K'), 10_000);
  assert.equal(parseUsd('101k'), 101_000);
  assert.equal(parseUsd('1.5m'), 1_500_000);
  assert.equal(parseUsd('2B'), 2_000_000_000);
});

test('the dollar sign, commas and spacing are all forgiven', () => {
  assert.equal(parseUsd('$2k'), 2_000);
  assert.equal(parseUsd('2k$'), 2_000);
  assert.equal(parseUsd('250,000'), 250_000);
  assert.equal(parseUsd('  50k  '), 50_000);
  assert.equal(parseUsd('2 k'), 2_000, 'a space before the suffix is still a suffix');
  assert.equal(parseUsd('10usd'), 10);
});

test('a plain token price still parses as itself', () => {
  // The same box takes a price. Suffix handling must not disturb it.
  assert.equal(parseUsd('0.0025'), 0.0025);
  assert.equal(parseUsd('$0.0008'), 0.0008);
  assert.equal(parseUsd('1'), 1);
});

test('anything it cannot read returns null, never a guess', () => {
  // This number decides when a position is sold. A wrong reading is worse than
  // a refusal, which costs one retyped message.
  for (const bad of ['', '  ', 'abc', 'k', '-5', '0', '2kk', 'k2', '1e9', null, undefined, {}, 'mc 2k']) {
    assert.equal(parseUsd(bad), null, `${JSON.stringify(bad)} was accepted as a target`);
  }
});

test('the order handlers use the parser, not Number()', () => {
  // Number('2k') is NaN, so the shorthand would be rejected with "send a
  // positive USD price" — the exact wall this removes.
  const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  assert.match(SRC, /const usdVal = parseUsd\(raw\.replace\(\/\^mc\\s\*\/i, ''\), info\)/, 'TP/SL still parse with Number()');
  assert.match(SRC, /const usdPrice = parseUsd\(pxStr, info\)/, 'limit buy still parses with Number()');
  assert.match(SRC, /const usdPrice = parseUsd\(t, info\);/, 'price alerts still parse with Number()');
  assert.ok(!/const usdVal = Number\(raw\.replace/.test(SRC), 'the old numeric parse is back');
});

test('the prompts teach the shorthand — an input nobody knows about is not an input', async () => {
  // Checked on the RENDERED prompt, not on source. These assertions used to grep
  // for literal example strings, which broke the moment the examples started
  // being computed from the live price — a test watching the wrong layer.
  for (const kind of ['tp', 'sl']) {
    const t = await prompt(kind);
    assert.match(t, /mc [\d.]+[kmb]/, `the ${kind} prompt shows no market-cap shorthand`);
    assert.match(t, /k = thousand · m = million · b = billion/, 'the suffixes are never explained');
  }
  // Comments stripped: the phrase survives in the doc block that explains why it
  // was removed, and a test that cannot tell code from prose would force that
  // explanation to be deleted along with the bug.
  const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/mc 1000000/.test(SRC), 'the seven-digit example is back');
});

test('the stop-loss prompt says how hard it will try to land', async () => {
  // It defaults to Turbo. Someone setting a stop is choosing what happens in a
  // crash; the cost of that is worth one line at the moment they choose it.
  assert.match(await prompt('sl'), /Turbo/, 'the stop-loss prompt never mentions its execution speed');
  assert.ok(!/Turbo/.test(await prompt('tp')), 'a limit sell claims a speed it does not use');
});

// ---------------------------------------------------------------- the prompt
//
// The examples were constants — "0.0025", "mc 2k". Someone holding $PONS at
// $0.0272 with a $27M cap reads those and still has to work out what to type for
// their OWN position, which is the entire question they opened the box with.

const { orderPrompt, usdShort } = tg._test;
const PROMPT_CA = '0x' + 'ab'.repeat(20);
async function promptRaw(kind, snap = { sym: 'PONS', priceEth: 0.00001455, mcapUsd: 27_440_000 }) {
  const real = core.tokenSnapshot;
  core.tokenSnapshot = async () => snap;
  tg._test.PRICES.ETH = 1870;
  try { return await orderPrompt(PROMPT_CA, 'robinhood', kind); }
  finally { core.tokenSnapshot = real; }
}
const prompt = async (...a) => (await promptRaw(...a)).replace(/<[^>]+>/g, '');
/** Every value the prompt presents as typeable — i.e. every <code> span. Keyed
 *  on the markup rather than on the layout, so restructuring the copy cannot
 *  quietly narrow what this checks. */
const typeables = (raw) => [...raw.matchAll(/<code>([^<]+)<\/code>/g)].map((m) => m[1].trim())
  .filter((v) => !/^mc$/i.test(v));   // the bare word, shown inline in "put mc in front"

test('the prompt asks the question in words', async () => {
  for (const k of ['tp', 'sl']) {
    assert.match(await prompt(k), /What price or market cap do you want to sell at\?/,
      `the ${k} prompt never actually asks`);
  }
});

test('it shows where the token is NOW, so a target has something to be relative to', async () => {
  const t = await prompt('tp');
  assert.match(t, /Now: \$0\.0272/, `the current price is missing:\n${t}`);
  assert.match(t, /market cap \$27\.44M/, 'the current market cap is missing');
});

test('EVERY value the prompt presents as typeable actually parses', async () => {
  // The one thing that must not be wrong here: showing someone a number and
  // then rejecting it when they type it back.
  for (const kind of ['tp', 'sl']) {
    const vals = typeables(await promptRaw(kind));
    assert.ok(vals.length >= 4, `the ${kind} prompt offers ${vals.length} typeable values`);
    for (const ex of vals) {
      const v = parseUsd(ex.replace(/^mc\s*/i, ''));
      assert.ok(v > 0, `the prompt shows "${ex}" but its own parser rejects it`);
    }
  }
});

test('the two ways to answer are stated before any example', async () => {
  // "Reply with one of these:" over a list of four numbers reads as a menu —
  // pick one — rather than as two ways of answering with any number you like.
  // The question people were left with was not "which of these four" but "what
  // am I supposed to type".
  for (const kind of ['tp', 'sl']) {
    const t = await prompt(kind);
    assert.match(t, /Reply with EITHER/i, `the ${kind} prompt never states the two formats`);
    assert.match(t, /A price — just the number/, 'the price format is not spelled out');
    assert.match(t, /A market cap — put mc in front/, 'the mc prefix is not spelled out');
    assert.match(t, /Any number you want/, 'the examples still read as the only allowed answers');
    // …and the formats come BEFORE the reference multiples.
    assert.ok(t.indexOf('Reply with EITHER') < t.indexOf('For reference'), 'examples precede the instruction');
  }
});

test('the examples point the way the order actually watches', async () => {
  // A limit sell that suggested a target BELOW the current price would fire the
  // instant it was set; a stop-loss suggesting one above would do the same.
  const up = await prompt('tp');
  assert.match(up, /2× →/);
  assert.ok(!/−\d+% →/.test(up), 'a limit sell suggested a target below the price');

  const down = await prompt('sl');
  assert.match(down, /−30% →/);
  assert.ok(!/\d× →/.test(down), 'a stop-loss suggested a target above the price');
});

test('the suggested numbers are arithmetically what they claim', async () => {
  const t = await prompt('tp');
  const line = t.split('\n').find((l) => /2× →/.test(l)) || '';
  const price2x = Number((line.match(/→ ([\d.]+)/) || [])[1]);
  assert.ok(Math.abs(price2x - 0.0272 * 2) / (0.0272 * 2) < 0.02, `"2×" was ${price2x}, not ~0.0544`);
  const mc2x = (line.match(/mc ([\d.]+[kmb]?)/) || [])[1];
  assert.ok(Math.abs(parseUsd(mc2x) - 27_440_000 * 2) / (27_440_000 * 2) < 0.02, `"2×" mcap was ${mc2x}`);
});

test('an unreadable price says so instead of inventing examples for it', async () => {
  const t = await prompt('tp', null);
  assert.match(t, /could not read this token's price/i, 'a failed read rendered as confident advice');
  assert.ok(!/2× →/.test(t), 'a multiple was offered with no price to multiply');
  assert.match(t, /0\.0025/, 'the generic fallback examples are gone too');
  assert.match(t, /Reply with EITHER/i, 'the instruction must survive a failed price read');
});

test('usdShort is the inverse of parseUsd', async () => {
  // The prompt writes with one and the box reads with the other; a mismatch
  // would show an example that cannot be typed.
  for (const v of [2_000, 101_000, 1_500_000, 27_440_000, 2e9, 999, 0.0025]) {
    const round = parseUsd(usdShort(v));
    assert.ok(round > 0, `usdShort(${v}) = "${usdShort(v)}" does not parse back`);
    assert.ok(Math.abs(round - v) / v < 0.05, `usdShort(${v}) round-tripped to ${round}`);
  }
});
