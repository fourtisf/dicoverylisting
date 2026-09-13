'use strict';
/*
 * Building a call on a curve. Every case is a way a discovered interface can be
 * turned into a transaction that does something other than buy — which is the
 * whole risk of routing an ABI nobody published.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCurveCall, simulate, sane, _addrWord, _HEX } = require('./curveRoute.js');

const TOKEN = '0x3f8c5ac4c9b9391c99f4796e56228852a6796ddf';
const WALLET = '0xa0000000000000000000000000000000000000a0';
const CURVE = '0xc0000000000000000000000000000000000000c0';
const E17 = 10n ** 17n;

const arg = (w) => {
  const addr = /^0{24}[0-9a-fA-F]{40}$/.test(w) && !/^0{8}/.test(w.slice(24)) ? '0x' + w.slice(24).toLowerCase() : null;
  return { word: w, addr, num: BigInt('0x' + w), isToken: addr === TOKEN };
};
const S = (value, words, from) => ({ value: BigInt(value), from, args: words.map(arg) });
const leg = (selector, samples) => ({ selector, args: samples[0].args, samples });

test('a buy is built with OUR token, OUR wallet and a bound recomputed for OUR size', () => {
  const l = leg('0xaabbccdd', [
    S(E17, [_addrWord(TOKEN), _addrWord('0xb0000000000000000000000000000000000000b0'), _HEX(1000n)], '0xb0000000000000000000000000000000000000b0'),
    S(2n * E17, [_addrWord(TOKEN), _addrWord('0xd0000000000000000000000000000000000000d0'), _HEX(2000n)], '0xd0000000000000000000000000000000000000d0'),
  ]);
  const r = buildCurveCall(l, { token: TOKEN, wallet: WALLET, valueWei: 4n * E17, slippageBps: 500 });
  assert.equal(r.ok, true, r.why);
  assert.ok(r.data.startsWith('0xaabbccdd'));
  const body = r.data.slice(10);
  assert.equal(body.slice(0, 64), _addrWord(TOKEN), 'the token slot carries OUR token');
  assert.equal(body.slice(64, 128), _addrWord(WALLET), 'the recipient slot carries OUR wallet, not the observed sender');
  // 4×E17 at the observed ratio is 4000, less 5% slippage.
  assert.equal(BigInt('0x' + body.slice(128, 192)), 3800n);
});

test('⚠️ the amount bound is never the observed one', () => {
  // Reusing a stranger's minimum-out is either an always-reverting buy or a
  // free option for whoever is watching the mempool.
  const l = leg('0x11111111', [S(E17, [_HEX(1000n)], WALLET), S(2n * E17, [_HEX(2000n)], WALLET)]);
  const r = buildCurveCall(l, { token: TOKEN, wallet: WALLET, valueWei: 4n * E17, slippageBps: 0 });
  assert.equal(r.ok, true, r.why);
  assert.equal(BigInt('0x' + r.data.slice(10)), 4000n, 'scaled to our size, not copied');
});

test("⚠️ …but a stranger's bound may not be STRETCHED — a curve is convex", () => {
  // The same leg, 50× the largest trade on file. Extrapolating linearly there
  // is either an always-revert or no bound at all, and sane() cannot tell the
  // difference: both sides of its comparison are linear in size, so size
  // cancels and its verdict is identical for a 0.001 and a 100 ETH buy.
  const l = leg('0x11111111', [S(E17, [_HEX(1000n)], WALLET), S(2n * E17, [_HEX(2000n)], WALLET)]);
  const r = buildCurveCall(l, { token: TOKEN, wallet: WALLET, valueWei: 100n * E17, slippageBps: 0 });
  assert.equal(r.ok, false);
  assert.match(r.why, /very different size/);
  assert.equal(r.data, undefined);
});

test('an INDEPENDENT bound lifts the size band, because that bound is ours', () => {
  // The band exists because a stranger's ratio cannot be stretched. A caller
  // that priced the trade itself is not stretching anything, and its floor is
  // correctly sized by construction.
  const l = leg('0x11111111', [S(E17, [_HEX(1000n)], WALLET), S(2n * E17, [_HEX(2000n)], WALLET)]);
  const r = buildCurveCall(l, { token: TOKEN, wallet: WALLET, valueWei: 100n * E17, slippageBps: 1000, minOutRaw: 90000n });
  assert.equal(r.ok, true, r.why);
  assert.equal(BigInt('0x' + r.data.slice(10)), 81000n, "our own floor, cut by our own slippage");
  assert.equal(r.boundedByIndependentPrice, true, 'the receipt is owed the difference');
  // ⚠️ …and `expected` stays the RATIO's reading, because that is what sane()
  // tests. Answering the gate with the caller's own number is the gate
  // checking itself.
  assert.equal(r.expected, 100000n);
});

test('⚠️ two slots that both scale is a refusal, never a guess', () => {
  // `expected` is one variable, so with two of them the LAST one becomes what
  // sane() checks — on a sell(tokensIn, minEthOut) that compares tokens against
  // wei. And the slippage cut lands in both, so a 100% sell hands over 95%.
  const l = leg('0x44444444', [
    S(E17, [_HEX(1000n), _HEX(500n)], WALLET),
    S(2n * E17, [_HEX(2000n), _HEX(1000n)], WALLET),
  ]);
  const r = buildCurveCall(l, { token: TOKEN, wallet: WALLET, valueWei: E17 });
  assert.equal(r.ok, false);
  assert.match(r.why, /both track the trade size/);
});

test('⚠️ a call wider than we can read is refused, not truncated', () => {
  const l = leg('0x55555555', [S(E17, [_HEX(1000n)], WALLET), S(2n * E17, [_HEX(2000n)], WALLET)]);
  l.wide = true;
  const r = buildCurveCall(l, { token: TOKEN, wallet: WALLET, valueWei: E17 });
  assert.equal(r.ok, false);
  assert.match(r.why, /more arguments than Dexvra reads/);
});

test('⚠️ a float amount is normalised, never thrown at the user', () => {
  // core.js prices in Numbers. An un-normalised float reaches `hi - lo` and
  // throws `Cannot mix BigInt` out of core.buy, which the router renders as
  // "Something glitched handling that" — the gate crashing instead of refusing.
  assert.equal(sane(1000, 1100).ok, true);
  assert.equal(sane(1000n, 3000).ok, false);
  assert.equal(sane('1000', 1100n).ok, true);
  assert.equal(sane(null, 1100n).ok, false);
});

test('⚠️ an unexplained argument refuses the trade — it is never defaulted or copied', () => {
  const l = leg('0x22222222', [S(E17, [_HEX(7n)], WALLET), S(2n * E17, [_HEX(999999n)], WALLET)]);
  const r = buildCurveCall(l, { token: TOKEN, wallet: WALLET, valueWei: E17 });
  assert.equal(r.ok, false);
  assert.match(r.why, /could not be explained|not understood/);
  assert.equal(r.data, undefined, 'no calldata may exist for a call we do not understand');
});

test('one sample is refused, and says that more TRADES are what fixes it', () => {
  const l = leg('0x33333333', [S(E17, [_addrWord(TOKEN), _HEX(5n)], WALLET)]);
  const r = buildCurveCall(l, { token: TOKEN, wallet: WALLET, valueWei: E17 });
  assert.equal(r.ok, false);
  assert.equal(r.needsMoreTrades, true, 'the caller must be able to tell this apart from a bad interface');
});

test('a constant slot is passed through exactly — it is the pad\'s own configuration', () => {
  const l = leg('0x44444444', [S(E17, [_HEX(300n)], WALLET), S(9n * E17, [_HEX(300n)], WALLET)]);
  const r = buildCurveCall(l, { token: TOKEN, wallet: WALLET, valueWei: E17 });
  assert.equal(r.ok, true, r.why);
  assert.equal(BigInt('0x' + r.data.slice(10)), 300n);
});

test('a scaled call with no amount is refused rather than sent with a zero bound', () => {
  const l = leg('0x55555555', [S(E17, [_HEX(10n)], WALLET), S(2n * E17, [_HEX(20n)], WALLET)]);
  const r = buildCurveCall(l, { token: TOKEN, wallet: WALLET, valueWei: 0n, amountRaw: 0n });
  assert.equal(r.ok, false);
  assert.match(r.why, /no amount/);
});

test('a bad wallet or token is refused before any calldata exists', () => {
  const l = leg('0x66666666', [S(E17, [_HEX(1n)], WALLET), S(2n * E17, [_HEX(2n)], WALLET)]);
  assert.equal(buildCurveCall(l, { token: 'nope', wallet: WALLET, valueWei: E17 }).ok, false);
  assert.equal(buildCurveCall(l, { token: TOKEN, wallet: '', valueWei: E17 }).ok, false);
});

test('simulate is a GATE: a revert is a refusal, and it carries the chain\'s reason', async () => {
  const good = { async estimateGas() { return 210000n; } };
  const bad = { async estimateGas() { const e = new Error('execution reverted: SlippageExceeded'); throw e; } };
  const call = { to: CURVE, data: '0xaabbccdd', value: E17 };
  assert.deepEqual(await simulate(good, call, WALLET), { ok: true, gas: 210000n, why: null });
  const r = await simulate(bad, call, WALLET);
  assert.equal(r.ok, false);
  assert.match(r.why, /SlippageExceeded/, 'never discard the reason');
});

test('⚠️ gas estimating is not agreeing with the market — the price cross-check is separate', () => {
  // A slot read as a minimum-out that is really a fee tier still estimates gas
  // cleanly. This is the check that separates "the call is accepted" from "the
  // call does what we think".
  assert.equal(sane(1000n, 1050n).ok, true);
  const off = sane(1000n, 5000n);
  assert.equal(off.ok, false);
  assert.match(off.why, /away from the indexed price/);
  // No independent price is a refusal, not a pass: there is then nothing to
  // catch a misread slot.
  assert.equal(sane(1000n, 0n).ok, false);
  assert.equal(sane(0n, 1000n).ok, false);
});
