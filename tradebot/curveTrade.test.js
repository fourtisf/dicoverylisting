'use strict';
/*
 * The gate between "we read an interface" and "we sign a transaction".
 * Every case is a way a discovered route could move money it should not.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { TRANSFER_TOPIC } = require('./curveIface.js');
const ct = require('./curveTrade.js');

const TOKEN = '0x3f8c5ac4c9b9391c99f4796e56228852a6796ddf';
const CURVE = '0xc0000000000000000000000000000000000000c0';
const WALLET = '0xa0000000000000000000000000000000000000a0';
const E17 = 10n ** 17n;
const word = (a) => '0'.repeat(24) + a.slice(2);
const topic = (a) => '0x' + '0'.repeat(24) + a.slice(2);
const num = (n) => BigInt(n).toString(16).padStart(64, '0');
const xfer = (from, to, hash, amt = 0n) => ({ topics: [TRANSFER_TOPIC, topic(from), topic(to)], data: '0x' + num(amt), transactionHash: hash });

/** Two buys of different sizes: enough for every slot to be explained. */
function chainWithBuys({ gas = async () => 210000n, sell = false } = {}) {
  const logs = [xfer(CURVE, WALLET, '0xb1'), xfer(CURVE, WALLET, '0xb2')];
  const txs = {
    '0xb1': { to: CURVE, from: WALLET, value: E17, data: '0xaabbccdd' + word(TOKEN) + num(1000n) },
    '0xb2': { to: CURVE, from: WALLET, value: 2n * E17, data: '0xaabbccdd' + word(TOKEN) + num(2000n) },
  };
  if (sell) {
    // Two sells of DIFFERENT size — the only thing that can explain a sell's
    // arguments, since msg.value is zero on both.
    logs.push(xfer(WALLET, CURVE, '0xs1', 1000n), xfer(WALLET, CURVE, '0xs2', 2000n));
    txs['0xs1'] = { to: CURVE, from: WALLET, value: 0n, data: '0x5e115e11' + word(TOKEN) + num(10n) };
    txs['0xs2'] = { to: CURVE, from: WALLET, value: 0n, data: '0x5e115e11' + word(TOKEN) + num(20n) };
  }
  return {
    async getBlockNumber() { return 9000; },
    async getLogs() { return logs; },
    async getTransaction(h) { return txs[h] || null; },
    estimateGas: gas,
  };
}

test.beforeEach(() => ct._reset());

test('a curve buy is prepared, simulated and price-checked before it can be signed', async () => {
  const chain = chainWithBuys();
  const r = await ct.prepareBuy(chain, 'robinhood', TOKEN, {
    wallet: WALLET, valueWei: E17, slippageBps: 500, expectedTokens: 1000n,
  });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.call.to, CURVE);
  assert.ok(r.call.data.startsWith('0xaabbccdd'));
  assert.equal(r.call.value, E17);
  assert.equal(r.gas, 210000n);
});

test('⚠️ a call the chain would revert is NEVER signed, and the reason travels', async () => {
  const chain = chainWithBuys({ gas: async () => { throw new Error('execution reverted: NotOpen'); } });
  const r = await ct.prepareBuy(chain, 'robinhood', TOKEN, { wallet: WALLET, valueWei: E17, expectedTokens: 1000n });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'simulate');
  assert.match(r.why, /NotOpen/);
});

const QUOTE = '0x9999999999999999999999999999999999999999';

/** A pad priced in an ERC-20: no msg.value, and the payment visible only in the
 *  transaction's OTHER Transfer logs. */
function quoteChain({ quoteToken = QUOTE, agree = true } = {}) {
  const logs = [xfer(CURVE, WALLET, '0xq1'), xfer(CURVE, WALLET, '0xq2')];
  const txs = {
    '0xq1': { to: CURVE, from: WALLET, value: 0n, data: '0xaabbccdd' + word(TOKEN) + num(900n) },
    '0xq2': { to: CURVE, from: WALLET, value: 0n, data: '0xaabbccdd' + word(TOKEN) + num(1800n) },
  };
  const paid = { '0xq1': 1000n, '0xq2': 2000n };
  const other = { '0xq1': quoteToken, '0xq2': agree ? quoteToken : '0x8888888888888888888888888888888888888888' };
  return {
    async getBlockNumber() { return 9000; },
    async getLogs() { return logs; },
    async getTransaction(h) { return txs[h]; },
    async getTransactionReceipt(h) {
      return { logs: [{ address: other[h], topics: [TRANSFER_TOPIC, topic(WALLET), topic(CURVE)], data: '0x' + num(paid[h]) }] };
    },
    async estimateGas() { return 210000n; },
  };
}

test('⚠️ a quote-token curve is never sent a value it never asked for — and the token is READ, not guessed', async () => {
  // Its buy carries no native value, so sending ours would lose it to a
  // function that takes payment in an ERC-20. Which ERC-20 is in neither the
  // calldata nor this token's own logs — it is in the transaction's other
  // Transfer logs, where the trader paid the curve.
  const r = await ct.prepareBuy(quoteChain(), 'robinhood', TOKEN, { wallet: WALLET, valueWei: E17, expectedTokens: 900n });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'quote', 'a caller that can swap into it needs to know that, not just "no"');
  assert.equal(r.quoteToken, QUOTE);
  assert.match(r.why, /priced in/);
});

test('…and WITH the quote already in hand it builds, carrying no value at all', async () => {
  const r = await ct.prepareBuy(quoteChain(), 'robinhood', TOKEN, {
    // ⚠️ A NATIVE AMOUNT IS PASSED TOO, deliberately. The caller that swapped
    // into the quote token still knows what it spent, and a build that carried
    // that number into `value` would hand it to a function which never asked
    // for it — simply gone. Mutation-tested: without the native/quote branch
    // this assertion is the only thing that fails.
    wallet: WALLET, valueWei: E17, quoteRaw: 1000n, expectedTokens: 900n, slippageBps: 500,
  });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.call.value, 0n, 'a value here would simply be lost');
  assert.equal(r.quoteToken, QUOTE);
  // Sized by the QUOTE paid, not by a native value that is zero by construction
  // — without which every slot correlates against zero and the pad reads as
  // broken rather than different.
  assert.equal(BigInt('0x' + r.call.data.slice(74, 138)), 855n);   // 900 less 5%
});

test('⚠️ samples that disagree about the quote token refuse — one token or none', async () => {
  // Two pads behind one selector, a router in the middle, or a read that went
  // wrong. Picking the commonest would put a guessed token address on a money
  // path.
  const r = await ct.prepareBuy(quoteChain({ agree: false }), 'robinhood', TOKEN, {
    wallet: WALLET, quoteRaw: 1000n, expectedTokens: 900n,
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /do not show what it IS paid in/);
});

test('a payable pad still refuses when no native amount is given', async () => {
  const r = await ct.prepareBuy(chainWithBuys(), 'robinhood', TOKEN, {
    wallet: WALLET, quoteRaw: 1000n, expectedTokens: 1000n,
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /paid in the native coin/);
});

test('⚠️ a quote that disagrees with the indexer refuses — gas estimating is not agreeing', async () => {
  const chain = chainWithBuys();
  const r = await ct.prepareBuy(chain, 'robinhood', TOKEN, {
    wallet: WALLET, valueWei: E17, slippageBps: 0, expectedTokens: 1n,   // indexer says 1, curve says ~1000
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'sane');
  assert.match(r.why, /away from the indexed price/);
});

test('no independent price is a refusal — there would be nothing left to catch a misread slot', async () => {
  const r = await ct.prepareBuy(chainWithBuys(), 'robinhood', TOKEN, { wallet: WALLET, valueWei: E17 });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'sane');
});

test('⚠️ selling refuses without an allowance, and names the step rather than the symptom', async () => {
  const chain = chainWithBuys({ sell: true });
  const r = await ct.prepareSell(chain, 'robinhood', TOKEN, { wallet: WALLET, amountRaw: 1000n, expectedNative: 10n, allowance: 0n });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'approve');
  assert.equal(r.needsApprove.spender, CURVE);
  // "the sell reverted" would send somebody hunting through slippage settings
  // for a step that was never taken.
  assert.match(r.why, /allowance/);
});

test('a curve nobody has sold on says so, and says what teaches it', async () => {
  const r = await ct.prepareSell(chainWithBuys(), 'robinhood', TOKEN, { wallet: WALLET, amountRaw: 1n, expectedNative: 1n, allowance: 10n ** 30n });
  assert.equal(r.ok, false);
  assert.match(r.why, /no SELL has been seen/);
});

test('with an allowance and a seen sell, the call is built against the curve', async () => {
  const chain = chainWithBuys({ sell: true });
  const r = await ct.prepareSell(chain, 'robinhood', TOKEN, {
    wallet: WALLET, amountRaw: 1000n, slippageBps: 500, expectedNative: 10n, allowance: 10n ** 30n,
  });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.call.to, CURVE);
  assert.ok(r.call.data.startsWith('0x5e115e11'));
  assert.equal(r.call.value, 0n);
});

test('⚠️ an RPC outage is never cached as a fact about the token', async () => {
  let head = 0;
  const dead = { async getBlockNumber() { head++; throw new Error('ETIMEDOUT'); }, async getLogs() { return []; }, async getTransaction() { return null; }, async estimateGas() { return 1n; } };
  await ct.ifaceFor(dead, 'robinhood', TOKEN);
  await ct.ifaceFor(dead, 'robinhood', TOKEN);
  assert.equal(head, 2, 'a failed read must be retried, not remembered');
});

test('a successful discovery is remembered — rediscovery is a dozen RPC reads', async () => {
  const chain = chainWithBuys();
  let reads = 0;
  const counting = { ...chain, async getLogs() { reads++; return chain.getLogs(); } };
  await ct.ifaceFor(counting, 'robinhood', TOKEN);
  await ct.ifaceFor(counting, 'robinhood', TOKEN);
  assert.equal(reads, 1);
});

test('⚠️ the price gate must be able to FAIL — it once compared a number with itself', async () => {
  // `sane(built.expected ?? expectedTokens, expectedTokens)` with `expected`
  // never set compared the indexer's own figure against itself, so it passed
  // everything. A gate that cannot fail reads as protection in every review of
  // the code and stops nothing. Both outcomes go through the real path here, so
  // a regression to self-comparison fails this test.
  const chain = chainWithBuys();
  const agree = await ct.prepareBuy(chain, 'robinhood', TOKEN, { wallet: WALLET, valueWei: E17, slippageBps: 0, expectedTokens: 1000n });
  assert.equal(agree.ok, true, agree.why);
  ct._reset();
  const disagree = await ct.prepareBuy(chain, 'robinhood', TOKEN, { wallet: WALLET, valueWei: E17, slippageBps: 0, expectedTokens: 100000n });
  assert.equal(disagree.ok, false);
  assert.equal(disagree.stage, 'sane');
});

test('a buy with no amount-scaled argument is refused — nothing could check the interface', async () => {
  // No minimum-out slot means the pad offers no on-chain bound of its own AND
  // leaves us no curve-side number to compare against the indexer.
  const logs = [xfer(CURVE, WALLET, '0xb1', 1n), xfer(CURVE, WALLET, '0xb2', 2n)];
  const txs = {
    '0xb1': { to: CURVE, from: WALLET, value: E17, data: '0xaabbccdd' + word(TOKEN) },
    '0xb2': { to: CURVE, from: WALLET, value: 2n * E17, data: '0xaabbccdd' + word(TOKEN) },
  };
  const chain = { async getBlockNumber() { return 9000; }, async getLogs() { return logs; }, async getTransaction(h) { return txs[h]; }, async estimateGas() { return 1n; } };
  const r = await ct.prepareBuy(chain, 'robinhood', TOKEN, { wallet: WALLET, valueWei: E17, expectedTokens: 1000n });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'sane');
});

test('⚠️ the allowance gate runs LAST, so nothing is approved for a sell that then refuses', async () => {
  // It used to run first — above build, above the price check — so a
  // stage:'approve' refusal said nothing about whether the call was buildable.
  // The caller granted an allowance to a log-scored address, re-called, and
  // could still be refused at 'build'. The approval stayed granted for ever,
  // for a sell that never happened.
  const chain = chainWithBuys({ sell: true });
  const r = await ct.prepareSell(chain, 'robinhood', TOKEN, {
    wallet: WALLET, amountRaw: 1000n, slippageBps: 500,
    expectedNative: 1n, allowance: 0n,        // nothing approved
  });
  assert.equal(r.ok, false);
  assert.notEqual(r.stage, 'approve', 'a call that cannot be built must refuse before asking for an allowance');
});

test("⚠️ a discovered spender is approved for THIS SELL and nothing more", async () => {
  // The sell leg's own ratio is 10 native per 1000 tokens, so 2000 tokens is
  // 20 — a price the gate agrees with, which is what lets it reach 'approve'.
  const chain = chainWithBuys({ sell: true });
  const r = await ct.prepareSell(chain, 'robinhood', TOKEN, {
    wallet: WALLET, amountRaw: 2000n, slippageBps: 500, expectedNative: 20n, allowance: 0n,
  });
  assert.equal(r.stage, 'approve', r.why);
  // v4.js already draws this line for a discovered router. An unlimited grant
  // to an address inferred from log scoring is the only unbounded loss in this
  // design, and it outlives the trade.
  assert.equal(r.needsApprove.amountRaw, 2000n);
  assert.equal(r.needsApprove.exact, true);
});

test('a curve that rejects our call is FORGOTTEN, so a redeploy heals itself', async () => {
  // The cache holds the discovered ADDRESS for half an hour. Without eviction,
  // every buy in that window aims at an abandoned contract and there is no path
  // back except waiting — a stuck state indistinguishable from a broken bot.
  const chain = chainWithBuys({ gas: async () => { throw new Error('execution reverted'); } });
  const before = await ct.prepareBuy(chain, 'robinhood', TOKEN, {
    wallet: WALLET, valueWei: 4n * 10n ** 17n, slippageBps: 500, expectedTokens: 4000n,
  });
  assert.equal(before.stage, 'simulate', before.why);
  assert.equal(ct.cached('robinhood', TOKEN), null, 'the rejected interface must not be served again');
});

test('cached() is a cheap yes and never a no', () => {
  // canTradeNow polls on a timer, so it may not pay a dozen RPC reads per
  // probe. The absence of a cached interface is "we have not looked", which the
  // caller must not render as "this token cannot be traded".
  ct._reset();
  assert.equal(ct.cached('robinhood', TOKEN), null);
});

const TRADE_LOGS = [xfer(CURVE, WALLET, '0xb1'), xfer(CURVE, WALLET, '0xb2')];
const TRADE_TXS = {
  '0xb1': { to: CURVE, from: WALLET, value: E17, data: '0xaabbccdd' + word(TOKEN) + num(1000n) },
  '0xb2': { to: CURVE, from: WALLET, value: 2n * E17, data: '0xaabbccdd' + word(TOKEN) + num(2000n) },
};

test('⚠️ the whole history is read in ONE request — the ladder was the 12s refusal', async () => {
  /*
   * This replaces an assertion that the first look was 5000 blocks, on the
   * reasoning that "widening the FIRST look would make every lookup pay for the
   * slowest pad". That reasoning was about widening the LADDER — three windows,
   * each paying a wide call plus a coarse AND a fine stepped walk, which is tens
   * of SERIAL round trips on a chain exempt from JSON-RPC batching, and is
   * exactly what the operator kept seeing as "reading this curve's interface
   * took longer than 12s".
   *
   * It does not apply to ONE topic-narrow `fromBlock: 0` request, which costs a
   * single round trip whatever the span. `v4.js:180` already issues exactly this
   * on this chain. The ladder underneath is unchanged and still pinned below.
   */
  const seen = [];
  const chain = {
    async getBlockNumber() { return 500000; },
    // The trades are OLD — far outside the cheap 5000-block window, which is the
    // case that used to cost the whole ladder and time the buy out.
    async getLogs(f) { seen.push(Number(f.fromBlock)); return TRADE_LOGS; },
    async getTransaction(h) { return TRADE_TXS[h]; },
    async estimateGas() { return 210000n; },
  };
  const r = await ct.ifaceFor(chain, 'robinhood', TOKEN);
  assert.equal(r.ok, true, r.why);
  assert.equal(seen.length, 1, 'ONE getLogs — the ladder is what the 12s ceiling was spent on');
  assert.equal(seen[0], 0, 'and it asked for the whole chain, so a quiet pad is not mistaken for an untraded token');
});

test('⚠️ the window still ESCALATES for a node that refuses the whole history', async () => {
  // A node that caps ranges throws on `fromBlock: 0`. The ladder underneath is
  // what covers it, and it must still widen: 5000 blocks is under three hours on
  // a two-second chain, so a pad whose tokens trade a few times a day reads as
  // "no trades found" there — a statement about the WINDOW reported as a fact
  // about the TOKEN.
  const logs = TRADE_LOGS;
  const txs = TRADE_TXS;
  const seen = [];
  const chain = {
    async getBlockNumber() { return 500000; },
    async getLogs(f) {
      const span = 500000 - Number(f.fromBlock);
      if (span >= 500000) throw new Error('query returned more than 10000 results');   // a RANGE cap, not a refusal
      seen.push(span);
      return span >= 60000 ? logs : [];        // the trades are older than three hours
    },
    async getTransaction(h) { return txs[h]; },
    async estimateGas() { return 210000n; },
  };
  const r = await ct.ifaceFor(chain, 'robinhood', TOKEN);
  assert.equal(r.ok, true, r.why);
  assert.ok(Math.max(...seen) >= 60000, 'it looked further than the cheap first window');
  assert.equal(seen[0], 5000, 'and the ladder still STARTS cheap once the wide look is off the table');
});

test('⚠️ the indexer\'s trade list seeds discovery when every getLogs is silently emptied', async () => {
  // The live shape one node quirk further than the range cap: past some age,
  // EVERY range big enough to reach a trade within the step budget is silently
  // answered [] — so the walk reads "no trades found" for ever about a token
  // the indexer is pricing on the same card. The indexer also publishes the
  // trades' tx hashes; they are pointers only, and everything decoded below
  // still comes off the chain's own receipts.
  const txs = {
    '0xb1': { to: CURVE, from: WALLET, value: E17, data: '0xaabbccdd' + word(TOKEN) + num(1000n) },
    '0xb2': { to: CURVE, from: WALLET, value: 2n * E17, data: '0xaabbccdd' + word(TOKEN) + num(2000n) },
  };
  const receipts = {
    '0xb1': { logs: [{ address: TOKEN, topics: [TRANSFER_TOPIC, topic(CURVE), topic(WALLET)], data: '0x' + num(1000n) }] },
    '0xb2': { logs: [{ address: TOKEN, topics: [TRANSFER_TOPIC, topic(CURVE), topic(WALLET)], data: '0x' + num(2000n) }] },
  };
  const chain = {
    async getBlockNumber() { return 500000; },
    async getLogs() { return []; },                    // the silent cap, everywhere
    async getTransaction(h) { return txs[h] || null; },
    async getTransactionReceipt(h) { return receipts[h] || null; },
    async estimateGas() { return 210000n; },
  };
  let asked = 0;
  const r = await ct.ifaceFor(chain, 'robinhood', TOKEN, {
    tradeHashes: async () => { asked++; return ['0xb2', '0xb1']; },   // newest first, as an indexer answers
  });
  assert.equal(r.ok, true, `the seed did not rescue a blind walk: ${r.why}`);
  assert.equal(r.curve, CURVE);
  assert.equal(r.buy.selector, '0xaabbccdd');
  assert.equal(asked, 1, 'the indexer is asked once, not per window');
  assert.ok(ct.cached('robinhood', TOKEN), 'a seeded read is a read — it caches like one');
});

/*
 * ⚠️ PREMISE CHANGED, NOT RULE. This test used to assert "the seed is not asked
 * while the walk can answer" — the seed was tried only after a window came back
 * empty, so an indexer request the cheap window made unnecessary was never
 * spent.
 *
 * That reasoning holds only while the walk is CHEAP, and on the node this
 * feature exists for it is not: the walk spent the entire CURVE_DISCOVER_MS
 * budget, so "seed last" meant SEED NEVER on exactly the tokens the seed
 * answers in three requests. The seed now starts CONCURRENTLY with the
 * whole-chain look, so it costs no latency where that look succeeds.
 *
 * What survives is the part that was always the point: ONE request, never one
 * per window — and a caller that PINNED a window is asking about that window
 * and must not spend an indexer request at all.
 */
test('the seed is spent ONCE, and never by a caller that pinned a window', async () => {
  const chain = chainWithBuys();
  let asked = 0;
  const r = await ct.ifaceFor(chain, 'robinhood', TOKEN, { tradeHashes: async () => { asked++; return []; } });
  assert.equal(r.ok, true, r.why);
  assert.equal(asked, 1, 'one indexer request per discovery, not one per window');

  ct.forget('robinhood', TOKEN);
  let pinned = 0;
  const r2 = await ct.ifaceFor(chain, 'robinhood', TOKEN, {
    blocks: 5000,
    tradeHashes: async () => { pinned++; return []; },
  });
  assert.equal(r2.ok, true, r2.why);
  assert.equal(pinned, 0, 'a pinned window asks about that window — it may not reach for the indexer');
});

test('a dead indexer costs the seed and nothing else — the ladder still climbs', async () => {
  // Same capped node as the ladder test below, with the seed source throwing:
  // the fallback failing must never make the primary worse.
  const logs = [xfer(CURVE, WALLET, '0xb1'), xfer(CURVE, WALLET, '0xb2')];
  const txs = {
    '0xb1': { to: CURVE, from: WALLET, value: E17, data: '0xaabbccdd' + word(TOKEN) + num(1000n) },
    '0xb2': { to: CURVE, from: WALLET, value: 2n * E17, data: '0xaabbccdd' + word(TOKEN) + num(2000n) },
  };
  const TRADE_AT = 405000;
  const chain = {
    async getBlockNumber() { return 500000; },
    async getLogs(f) {
      const from = Number(f.fromBlock), to = Number(f.toBlock);
      if (to - from > 20000) throw new Error('block range too large');
      return from <= TRADE_AT && TRADE_AT <= to ? logs : [];
    },
    async getTransaction(h) { return txs[h]; },
    async estimateGas() { return 210000n; },
  };
  const r = await ct.ifaceFor(chain, 'robinhood', TOKEN, { tradeHashes: async () => { throw new Error('indexer down'); } });
  assert.equal(r.ok, true, `a failed seed broke the ladder: ${r.why}`);
});

test('⚠️ the ladder still climbs on a node that REJECTS wide ranges', async () => {
  // The live shape on Robinhood's public RPC: the wide ask for windows 2 and 3
  // errors with a range cap while every step inside them answers fine. Before
  // stepErrs, window 2's clean-but-empty stepped walk was misreported as
  // "could not read" — so the ladder stopped exactly one rung short of the
  // window a quiet pad's trades are in, on every attempt, with nothing cached.
  const logs = [xfer(CURVE, WALLET, '0xb1'), xfer(CURVE, WALLET, '0xb2')];
  const txs = {
    '0xb1': { to: CURVE, from: WALLET, value: E17, data: '0xaabbccdd' + word(TOKEN) + num(1000n) },
    '0xb2': { to: CURVE, from: WALLET, value: 2n * E17, data: '0xaabbccdd' + word(TOKEN) + num(2000n) },
  };
  const TRADE_AT = 405000;   // ~95k blocks back: only window 3 can see it
  const chain = {
    async getBlockNumber() { return 500000; },
    async getLogs(f) {
      const from = Number(f.fromBlock), to = Number(f.toBlock);
      if (to - from > 20000) throw new Error('block range too large');   // the cap
      return from <= TRADE_AT && TRADE_AT <= to ? logs : [];
    },
    async getTransaction(h) { return txs[h]; },
    async estimateGas() { return 210000n; },
  };
  ct._reset();
  const r = await ct.ifaceFor(chain, 'robinhood', TOKEN);
  assert.equal(r.ok, true, `the capped node's trades were never reached: ${r.why}`);
  assert.equal(r.curve, CURVE);
});

test('…but a dead node is not widened — three tries is three times the same silence', async () => {
  let asked = 0;
  const chain = {
    async getBlockNumber() { return 500000; },
    async getLogs() { asked++; throw new Error('ETIMEDOUT'); },
    async getTransaction() { return null; },
  };
  const r = await ct.ifaceFor(chain, 'robinhood', TOKEN);
  assert.equal(r.ok, false);
  assert.match(r.why, /could not read/);
  // The stepped walk inside one window is expected; what must not happen is the
  // whole window ladder being climbed for an outage.
  assert.ok(asked < 30, `a transport failure escalated the window (${asked} reads)`);
  assert.equal(ct.cached('robinhood', TOKEN), null, 'and an outage is never remembered');
});

test('⚠️ ONE observed trade is `ok` and UNBUILDABLE — it takes the short TTL, not thirty minutes', async () => {
  /*
   * `curveIface` sets `ok` from having decoded a leg; `classifySlots` refuses to
   * infer an argument's meaning below minSamples (2). So a curve with a single
   * observed trade is both at once — and it was remembered for OK_TTL_MS while
   * the MISS TTL beside it exists, in its own words, for "not enough trades yet,
   * which the next trade fixes". That is the state of a token at 0.05% of its
   * curve, which is the token this whole feature is for, and the card now reads
   * this cache directly.
   *
   * Mutation test: restore `hit.res.ok ? OK_TTL_MS : MISS_TTL_MS` and this fails.
   */
  ct._reset();
  const one = { ok: true, curve: CURVE, buy: { selector: '0xaabbccdd', seen: 1, args: [] } };
  const two = { ok: true, curve: CURVE, buy: { selector: '0xaabbccdd', seen: 2, args: [] } };
  const k = 'robinhood:' + TOKEN.toLowerCase();
  const aged = Date.now() - 100_000;    // past the 90s miss TTL, far inside the 30-minute one

  ct._cache.set(k, { res: one, ts: aged });
  assert.equal(ct.cached('robinhood', TOKEN), null, 'a single-sample read expires on the SHORT clock');

  ct._cache.set(k, { res: two, ts: aged });
  assert.ok(ct.cached('robinhood', TOKEN), 'a buildable read still keeps the long one');
});

test('⚠️ one pasted CA is ONE discovery, however many callers ask at once', async () => {
  // The cache stores results, not promises, so nothing is written until a walk
  // FINISHES and a second caller mid-walk starts its own. The card consults
  // this on every render of an indexed curve token, so it stops being "a user
  // tapped twice" and becomes "everyone who pasted this CA" — concurrent
  // bursts against a chain deliberately exempt from JSON-RPC batching.
  ct._reset();
  let heads = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const chain = {
    async getBlockNumber() { heads++; await gate; return 500000; },
    async getLogs() { return [xfer(CURVE, WALLET, '0xc1')]; },
    async getTransaction() { return { to: CURVE, from: WALLET, value: E17, data: '0xaabbccdd' + word(TOKEN) + num(1000n) }; },
  };
  const all = Promise.all([1, 2, 3, 4, 5].map(() => ct.ifaceFor(chain, 'robinhood', TOKEN)));
  release();
  const rs = await all;
  assert.equal(heads, 1, 'five callers, one discovery');
  assert.ok(rs.every((r) => r === rs[0]), 'and they all got the same answer object');
});

test('⚠️ …but a SEEDED caller is never handed the seedless answer', async () => {
  // A call that can seed from the indexer's trade list, or teach from a
  // sibling, can succeed exactly where a bare one fails — that is why those
  // seams were added. Coalescing across them would quietly discard the seed on
  // whichever caller happened to arrive second, which is the quiet-token case
  // the seeding exists for.
  ct._reset();
  let bare = 0, seeded = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const chain = {
    async getBlockNumber() { await gate; return 500000; },
    async getLogs() { return []; },
    async getTransaction() { return null; },
  };
  const p1 = ct.ifaceFor(chain, 'robinhood', TOKEN);
  const p2 = ct.ifaceFor(chain, 'robinhood', TOKEN, { tradeHashes: async () => { seeded++; return []; } });
  bare = 1;
  release();
  await Promise.all([p1, p2]);
  assert.equal(bare, 1);
  assert.equal(seeded, 1, 'the seeded caller was answered by a discovery that never used its seed');
});

test('⚠️ a node that CAPS BY ANSWERING [] still reaches the ladder — an empty wide answer is not a verdict', async () => {
  /*
   * `curveIface`'s own header records, from a live-box measurement, that some
   * public RPCs cap `eth_getLogs` by ANSWERING `[]` rather than by throwing —
   * "that empty array is about the CAP, not about the token". A first cut of
   * the one-request look returned "no trades found at all" on exactly that
   * answer with no `retry`, so `_discover` skipped the ladder, cached the
   * sentence, and the card lost its Buy button while the snipe went inert. One
   * request and a false verdict, where the ladder finds the trades.
   *
   * `fromBlock: 0` is the WIDEST range a capping node can be handed, so it is
   * the request MOST likely to come back silently empty — which is why the
   * reassuring reading ("the whole chain cannot be too narrow") is the wrong
   * objection.
   *
   * Driven through `ifaceFor`, the door the bot uses — the existing range-cap
   * test calls `decodeCurveIface` directly and never passes `full`, so it
   * cannot see this.
   */
  ct._reset();
  let asked = 0;
  const CAP = 20000;
  const chain = {
    async getBlockNumber() { return 500000; },
    async getLogs(f) {
      asked++;
      const span = 500000 - Number(f.fromBlock);
      if (span > CAP) return [];            // silently capped — NOT a throw
      return Number(f.toBlock) >= 460000 ? TRADE_LOGS : [];
    },
    async getTransaction(h) { return TRADE_TXS[h]; },
    async estimateGas() { return 210000n; },
  };
  const r = await ct.ifaceFor(chain, 'robinhood', TOKEN);
  assert.equal(r.ok, true, `the capped node's empty answer was believed: ${r.why}`);
  assert.equal(r.curve, CURVE);
  assert.ok(asked > 1, 'it stopped after the wide look instead of paying for the ladder');
});

/*
 * ⚠️ THE REGRESSION THIS FILE EXISTS TO PIN: A SLOW NODE, NOT A BROKEN ONE.
 *
 * The whole-chain look was added to END the "reading this curve's interface took
 * longer than 12s" refusal, and it REPRODUCED it. It had no timeout of its own —
 * ethers' default is 300s — so on a node that merely takes its time over
 * `fromBlock: 0` across ~49M blocks, that ONE request consumed the entire
 * CURVE_DISCOVER_MS budget and nothing underneath it ever ran: not the ladder,
 * not the seed, not the learned shape. Same sentence, different cause, which is
 * precisely why it read as "masih sama aja".
 *
 * Every other test here uses a node that answers instantly or throws, and both
 * of those are fine on the broken code. SLOWNESS is the shape that catches it.
 */
test('⚠️ a whole-chain look that is SLOW does not eat the ladder, the seed, or the shape', async () => {
  process.env.CURVE_STAGE_MS = '500';   // the floor; the stub below sleeps past it
  delete require.cache[require.resolve('./curveTrade.js')];
  const ct2 = require('./curveTrade.js');
  try {
    const logs = [xfer(CURVE, WALLET, '0xb1'), xfer(CURVE, WALLET, '0xb2')];
    const txs = {
      '0xb1': { to: CURVE, from: WALLET, value: E17, data: '0xaabbccdd' + word(TOKEN) + num(1000n) },
      '0xb2': { to: CURVE, from: WALLET, value: 2n * E17, data: '0xaabbccdd' + word(TOKEN) + num(2000n) },
    };
    let wideCalls = 0;
    const chain = {
      async getBlockNumber() { return 500000; },
      async getLogs(f) {
        // `fromBlock: 0` is the whole-chain look. It ANSWERS — eventually — and
        // "eventually" is the entire defect.
        if (Number(f.fromBlock) === 0) {
          wideCalls++;
          await new Promise((r) => setTimeout(r, 1200));
          return logs;
        }
        const from = Number(f.fromBlock), to = Number(f.toBlock);
        return from <= 405000 && 405000 <= to ? logs : [];
      },
      async getTransaction(h) { return txs[h]; },
      async estimateGas() { return 210000n; },
    };

    const t0 = Date.now();
    const r = await ct2.ifaceFor(chain, 'robinhood', TOKEN, {});
    const took = Date.now() - t0;

    assert.equal(wideCalls, 1, 'precondition: the slow whole-chain look was actually attempted');
    assert.equal(r.ok, true, `the slow look starved everything below it: ${r.why}`);
    assert.equal(r.buy.selector, '0xaabbccdd', 'and the ladder underneath still read the interface');
    // The bound is what makes this possible at all: unbounded, the answer could
    // not arrive before the slow request did.
    assert.ok(took < 900, `discovery must not wait out the slow stage — took ${took}ms`);
  } finally {
    delete process.env.CURVE_STAGE_MS;
    delete require.cache[require.resolve('./curveTrade.js')];
  }
});

/*
 * ⚠️ THE SEED MUST BE SPENT BEFORE THE LADDER, NOT AFTER IT — and this is the
 * test that makes that an assertion rather than an argument.
 *
 * A mutation run said so: moving the seed back to "after a window came back
 * empty" passed every other test in this file, because they all use a node whose
 * walk is instantaneous. In production it is not — the walk is up to ~96 serial
 * `getLogs` on a chain deliberately exempt from JSON-RPC batching — so a seed
 * that runs last runs after the 12s budget is already gone. Seed-last is
 * seed-never on exactly the tokens the seed answers in three requests.
 *
 * So the shape is: a node that ANSWERS every walk, slowly, with nothing (the
 * silent range cap this whole ladder exists for), and an indexer that knows the
 * trades. Only the ordering separates a fast answer from a slow one.
 */
test('⚠️ the seed answers BEFORE the ladder is walked, not after', async () => {
  const txs = {
    '0xb1': { to: CURVE, from: WALLET, value: E17, data: '0xaabbccdd' + word(TOKEN) + num(1000n) },
    '0xb2': { to: CURVE, from: WALLET, value: 2n * E17, data: '0xaabbccdd' + word(TOKEN) + num(2000n) },
  };
  const rcpt = (h, amt) => ({
    logs: [{ address: TOKEN, topics: [TRANSFER_TOPIC, topic(CURVE), topic(WALLET)], data: '0x' + num(amt), blockNumber: 405000 }],
    transactionHash: h,
  });
  let walked = 0;
  const chain = {
    async getBlockNumber() { return 500000; },
    // Every range answers — emptily, and never quickly. This is the node the
    // ladder was written for, and the one it cannot finish against in time.
    async getLogs() { walked++; await new Promise((r) => setTimeout(r, 30)); return []; },
    async getTransaction(h) { return txs[h]; },
    async getTransactionReceipt(h) { return h === '0xb1' ? rcpt(h, 1000n) : rcpt(h, 2000n); },
    async estimateGas() { return 210000n; },
  };

  const t0 = Date.now();
  const r = await ct.ifaceFor(chain, 'robinhood', TOKEN, { tradeHashes: async () => ['0xb2', '0xb1'] });
  const took = Date.now() - t0;

  assert.equal(r.ok, true, `the seed never got its turn: ${r.why}`);
  assert.equal(r.buy.selector, '0xaabbccdd');
  // The ladder is ~96 stepped reads per window. Reaching the answer without
  // paying for them is the entire point; a handful of probes is the wide look
  // and the first window, not a walk.
  assert.ok(walked <= 4, `the ladder was walked before the seed was spent — ${walked} getLogs`);
  assert.ok(took < 400, `discovery paid for the walk it did not need — took ${took}ms`);
});
