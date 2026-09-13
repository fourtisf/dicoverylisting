'use strict';
/*
 * The number that decides whether a curve trade may be signed — and, just as
 * importantly, whether the feature fires at all.
 *
 * Every case here is a way the gate ends up answering itself, or refusing
 * everything it exists to allow. Both are failures; the repo treats an inert
 * feature as costing what a wrong fill costs, because from Telegram they look
 * the same.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('./curvePrice.js');

const CA = '0x3f8c5ac4c9b9391c99f4796e56228852a6796ddf';
const E18 = 10n ** 18n;

const deps = (over = {}) => ({
  record: async () => ({ record: null, ok: true, why: 'no pad knows it', tried: [] }),
  nativeUsd: async () => 2000,
  decimals: async () => 18,
  totalSupply: async () => 1_000_000_000n * E18,
  iface: null,
  ...over,
});

test("the launchpad's own price is the strongest source, and it is two third parties", async () => {
  // The pad's API and Coinbase spot. Neither touches the curve contract or the
  // argument slots sane() is testing, which is the whole property being bought.
  const r = await cp.expectedTokensFor('robinhood', CA, E18, deps({
    record: async () => ({ record: { priceUsd: 0.002, launchpad: 'Pons' }, ok: true }),
  }));
  assert.equal(r.ok, true, r.why);
  // $2000 of native / $0.002 a token = 1,000,000 tokens.
  assert.equal(r.raw / E18, 1_000_000n);
  assert.match(r.source, /Pons price/);
  assert.equal(r.tolPct, 35);
  assert.ok(!r.weak);
});

test('a pad that publishes a CAP and no price still answers, via the chain\'s own supply', async () => {
  // P_MCAP carries nine spellings to P_PRICE's five, so this is often the tier
  // that is actually populated.
  const r = await cp.expectedTokensFor('robinhood', CA, E18, deps({
    record: async () => ({ record: { mcapUsd: 2_000_000, launchpad: 'Pons' }, ok: true }),
  }));
  assert.equal(r.ok, true, r.why);
  // $2M cap / 1B supply = $0.002 a token; $2000 buys 1,000,000.
  assert.equal(r.raw / E18, 1_000_000n);
  assert.match(r.source, /market cap ÷ on-chain supply/);
});

test('⚠️ decimals are never GUESSED — a failed read refuses, it does not answer 18', async () => {
  // core.js's tokenDecimals answers 18 for a read that failed. This is the one
  // number that scales the answer by a power of ten: on a 9-decimal token that
  // guess inflates it 10^9×, sane() refuses, and the refusal reads as "the
  // curve disagrees with the market" — a wrong diagnosis pointing at the token.
  const r = await cp.expectedTokensFor('robinhood', CA, E18, deps({
    decimals: async () => { throw new Error('RPC 429'); },
    record: async () => ({ record: { priceUsd: 0.002 }, ok: true }),
  }));
  assert.equal(r.ok, false);
  assert.match(r.why, /decimals/);
  assert.match(r.why, /power of ten/);
});

test('a 6-decimal token is priced in ITS units, not in 18', async () => {
  const r = await cp.expectedTokensFor('robinhood', CA, E18, deps({
    decimals: async () => 6,
    record: async () => ({ record: { priceUsd: 0.002 }, ok: true }),
  }));
  assert.equal(r.ok, true, r.why);
  assert.equal(r.raw, 1_000_000n * 10n ** 6n);
});

test('⚠️ the observed fill rate is the LAST tier, and it says it is weak', async () => {
  // It is a DIFFERENT FIELD from the one ratioE18 comes from — what the
  // contract paid out, versus an argument the trader chose — so it catches a
  // slot that is not denominated in the output token. It is NOT independent of
  // the sample window, and pretending otherwise is how a gate stops being one.
  const iface = { buy: { samples: [
    { value: E18, amount: 900_000n * E18, exact: true },
    { value: 2n * E18, amount: 1_800_000n * E18, exact: true },
  ] } };
  const r = await cp.expectedTokensFor('robinhood', CA, E18, deps({ iface }));
  assert.equal(r.ok, true, r.why);
  assert.equal(r.raw / E18, 900_000n);
  assert.equal(r.weak, true, 'the receipt is owed the difference between the checks');
  assert.equal(r.tolPct, 60, 'a weaker check gets a wider band, not a free pass');
  assert.match(r.source, /recent fills/);
});

test('⚠️ a payout that did not go to the TRADER is not a fill rate', async () => {
  // curveIface marks those `exact:false`. It is what a recipient ARGUMENT looks
  // like from outside, and its `amount` may be a fee rather than the fill —
  // averaging one in prices the trade at its own fee.
  const iface = { buy: { samples: [
    { value: E18, amount: 5n * E18, exact: false },      // a fee transfer
    { value: E18, amount: 900_000n * E18, exact: true },
  ] } };
  const r = await cp.expectedTokensFor('robinhood', CA, E18, deps({ iface }));
  assert.equal(r.raw / E18, 900_000n, 'the fee log must not become the price');
});

test('⚠️ "could not ask" and "nothing there" are different refusals', async () => {
  // One is a line in .env, the other is a statement about the token. Collapsing
  // them sends an operator to the wrong place.
  const unreachable = await cp.expectedTokensFor('robinhood', CA, E18, deps({
    record: async () => ({ record: null, ok: false, why: 'pons: ENOTFOUND' }),
  }));
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.why, /could not be reached from this server/);
  assert.match(unreachable.why, /our side, not the token's/);

  const unknown = await cp.expectedTokensFor('robinhood', CA, E18, deps());
  assert.equal(unknown.ok, false);
  assert.match(unknown.why, /no launchpad or indexer publishes a cap/);
  assert.notEqual(unreachable.why, unknown.why);
});

test('⚠️ nothing here is ever answered BY THE CURVE', async () => {
  // A gate answered by its own subject is not a gate. curveQuote is kept apart
  // for exactly that reason, and expectedTokensFor is handed no `chain` at all
  // — it cannot call one even by mistake.
  const src = require('node:fs').readFileSync(require.resolve('./curvePrice.js'), 'utf8');
  const body = src.slice(src.indexOf('async function priceWeiPerToken'), src.indexOf('async function curveQuote'));
  assert.doesNotMatch(body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), /chain\.call|estimateGas/,
    'the independent price may never come from the contract being tested');
});

test('curveQuote answers null for anything that is not one plausible word', async () => {
  const call = { to: CA, data: '0xaabbccdd', value: 1n };
  const q = (ret) => cp.curveQuote({ call: async () => ret }, call, CA);
  assert.equal(await q('0x' + (12345n).toString(16).padStart(64, '0')), 12345n);
  // ⚠️ A returned `bool true` is the word 1 — a plausible-looking uint and an
  // absurd token amount. The pools.trade staticCall works only because its ABI
  // DECLARES a return type; a discovered selector declares nothing.
  assert.equal(await q('0x' + (1n).toString(16).padStart(64, '0')), null);
  assert.equal(await q('0x'), null);
  assert.equal(await q('0x' + '00'.repeat(64)), null, 'two words is not a uint256 return');
  assert.equal(await cp.curveQuote({ call: async () => { throw new Error('reverted'); } }, call, CA), null);
  assert.equal(await cp.curveQuote({}, call, CA), null, 'a chain with no eth_call is "could not ask"');
});

test('the SELL side is gated by exactly the number the buy side is gated by', async () => {
  // Two prices for one token is two verdicts, and the one that disagrees is the
  // one nobody looks at. Both sides read priceWeiPerToken.
  const d = deps({ record: async () => ({ record: { priceUsd: 0.002, launchpad: 'Pons' }, ok: true }) });
  const buy = await cp.expectedTokensFor('robinhood', CA, E18, d);
  const sell = await cp.expectedNativeFor('robinhood', CA, buy.raw, d);
  assert.equal(sell.ok, true, sell.why);
  assert.equal(sell.raw, E18, 'a round trip at the same price returns the same wei');
  assert.equal(sell.source, buy.source);
});
