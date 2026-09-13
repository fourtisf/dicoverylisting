'use strict';
/*
 * The curve decoder, driven against a stub chain.
 *
 * Every case is a way the inference can go wrong on somebody's money, and each
 * one is the reason the corresponding line exists. Driven rather than scanned
 * because a source guard cannot tell a correct inference from a plausible one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeCurveIface, describeIface, TRANSFER_TOPIC, _wordAddr } = require('./curveIface.js');

const TOKEN = '0x3f8c5ac4c9b9391c99f4796e56228852a6796ddf';
const CURVE = '0xc0000000000000000000000000000000000000c0';
const ROUTER = '0xd0000000000000000000000000000000000000d0';
const WALLET = '0xa0000000000000000000000000000000000000a0';

const word = (a) => '0'.repeat(24) + a.slice(2);
const topic = (a) => '0x' + '0'.repeat(24) + a.slice(2);
const num = (n) => BigInt(n).toString(16).padStart(64, '0');

/** A chain that answers from a script, and counts what it was asked. */
function stub({ logs = [], txs = {} } = {}) {
  const calls = { getLogs: 0, getTransaction: 0 };
  return {
    calls,
    async getLogs() { calls.getLogs++; return logs; },
    async getTransaction(h) { calls.getTransaction++; return txs[h] || null; },
  };
}
const xfer = (from, to, hash) => ({ topics: [TRANSFER_TOPIC, topic(from), topic(to)], transactionHash: hash });

test('the buy is read off a real trade: contract, selector, args, and the token slot', async () => {
  const chain = stub({
    logs: [xfer(CURVE, WALLET, '0xh1')],                       // curve paid out → a BUY
    txs: { '0xh1': { to: CURVE, value: 10n ** 17n, data: '0xaabbccdd' + word(TOKEN) + num(500) } },
  });
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000 });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.curve, CURVE);
  assert.equal(r.buy.selector, '0xaabbccdd');
  assert.equal(r.buy.native, true);
  assert.equal(r.buy.args[0].isToken, true, 'the token slot is identified, not assumed');
  assert.equal(r.buy.args[1].num, 500n);
});

test('⚠️ the CURVE is the contract the token moves to and from — not whatever was called', async () => {
  // A router in front of the curve is called too, and it appears in the trace
  // exactly like the curve does. Only the curve is on the other end of the
  // token's own Transfer, which is the one property that separates them —
  // and picking the router would send every buy to the wrong contract.
  const chain = stub({
    logs: [xfer(CURVE, WALLET, '0xh1'), xfer(CURVE, WALLET, '0xh2')],
    txs: {
      '0xh1': { to: ROUTER, value: 10n ** 17n, data: '0x11111111' + word(TOKEN) },
      '0xh2': { to: CURVE, value: 10n ** 17n, data: '0x22222222' + word(TOKEN) },
    },
  });
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000 });
  assert.equal(r.curve, CURVE, 'the router must not be mistaken for the curve');
  assert.equal(r.buy.selector, '0x22222222');
});

test('⚠️ direction comes from the Transfer, not from msg.value', async () => {
  // A pad whose buy is priced in a quote token sends no native value, so a
  // classifier reading `value` alone would call every buy a sell — and then
  // build a "buy" out of the sell selector.
  const chain = stub({
    logs: [xfer(CURVE, WALLET, '0xbuy'), xfer(WALLET, CURVE, '0xsell')],
    txs: {
      '0xbuy': { to: CURVE, value: 0n, data: '0xb0b0b0b0' + word(TOKEN) },
      '0xsell': { to: CURVE, value: 0n, data: '0x5e115e11' + word(TOKEN) },
    },
  });
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000 });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.buy.selector, '0xb0b0b0b0', 'the payout leg is the buy');
  assert.equal(r.buy.native, false, 'and it is correctly marked as not payable');
  assert.equal(r.sell.selector, '0x5e115e11');
});

test('the sell is never the same selector as the buy', async () => {
  const chain = stub({
    logs: [xfer(CURVE, WALLET, '0xh1'), xfer(WALLET, CURVE, '0xh2')],
    txs: {
      '0xh1': { to: CURVE, value: 5n, data: '0xdeadbeef' + word(TOKEN) },
      '0xh2': { to: CURVE, value: 0n, data: '0xdeadbeef' + word(TOKEN) },
    },
  });
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000 });
  assert.equal(r.buy.selector, '0xdeadbeef');
  assert.equal(r.sell, null, 'one selector cannot be both legs');
});

test('the largest trade of a shape wins, so one dust buy does not define the route', async () => {
  const chain = stub({
    logs: [xfer(CURVE, WALLET, '0xsmall'), xfer(CURVE, WALLET, '0xbig')],
    txs: {
      '0xsmall': { to: CURVE, value: 1n, data: '0xaaaaaaaa' + word(TOKEN) + num(1) },
      '0xbig': { to: CURVE, value: 10n ** 18n, data: '0xaaaaaaaa' + word(TOKEN) + num(999) },
    },
  });
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000 });
  assert.equal(r.buy.value, 10n ** 18n);
  assert.equal(r.buy.args[1].num, 999n);
  assert.equal(r.buy.seen, 2, 'both sightings still count towards confidence');
});

test('⚠️ "could not look" and "nothing to look at" never collapse — and neither is a verdict on the token', async () => {
  const dead = { async getLogs() { throw new Error('ETIMEDOUT'); }, async getTransaction() { return null; } };
  const a = await decodeCurveIface(dead, TOKEN, { head: 1 });
  assert.equal(a.ok, false);
  assert.match(a.why, /could not read/);

  const quiet = await decodeCurveIface(stub({ logs: [] }), TOKEN, { head: 1 });
  assert.equal(quiet.ok, false);
  // ⚠️ IT NO LONGER SAYS "nobody has traded". A public RPC caps eth_getLogs, and
  // an empty answer to a wide range is about the CAP, not about the token — the
  // live box asserted "nobody has traded this token in the last 50000 blocks"
  // about a token whose own card showed $320 of 24h volume. We report what we
  // FOUND, and name the window.
  assert.match(quiet.why, /no trades found/);
  assert.doesNotMatch(quiet.why, /nobody has traded/, 'that is a claim about the token we cannot support');
  assert.notEqual(a.why, quiet.why, 'an outage must not read as an untraded token');
});

test('⚠️ a sell-only history still ANSWERS — it is the buy that has no answer', async () => {
  // `ok` used to mean "a BUY was observed", and prepareSell gated on it — so a
  // curve whose recent trades are all sells could not be SOLD, which is exactly
  // the market in which somebody wants out. The buy question refuses on its own
  // (curveTrade.prepareBuy), where the sentence can name the fix.
  const chain = stub({
    logs: [xfer(WALLET, CURVE, '0xh1')],
    txs: { '0xh1': { to: CURVE, value: 0n, data: '0x5e115e11' + word(TOKEN) } },
  });
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000 });
  assert.equal(r.ok, true, 'a decoded sell leg is a complete answer to the sell question');
  assert.equal(r.buy, null, 'and no answer at all to the buy question');
  assert.equal(r.sell.selector, '0x5e115e11');
  assert.equal(r.curve, CURVE);
});

test('plain wallet-to-wallet transfers name no curve at all', async () => {
  const chain = stub({
    logs: [xfer(WALLET, ROUTER, '0xh1')],
    txs: { '0xh1': { to: ROUTER, value: 0n, data: '0xa9059cbb' + word(WALLET) } },
  });
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000 });
  // ROUTER is on the receiving end of the Transfer AND is what was called, so
  // it does score — as a sell-shaped leg with no buy. That is honest, and it is
  // why the BUY refusal lives in curveTrade rather than here.
  assert.equal(r.buy, null, 'nothing here shows the contract paying the token out');
  assert.equal(r.curve, ROUTER);
});

test('a bad token address is refused before any request is made', async () => {
  const chain = stub();
  const r = await decodeCurveIface(chain, 'not-an-address', { head: 1 });
  assert.equal(r.ok, false);
  assert.equal(chain.calls.getLogs, 0, 'no network call for input we can reject outright');
});

test('the transaction reads are BOUNDED — a busy token must not cost hundreds of round trips', async () => {
  const logs = Array.from({ length: 200 }, (_, i) => xfer(CURVE, WALLET, '0xh' + i));
  const txs = {};
  for (let i = 0; i < 200; i++) txs['0xh' + i] = { to: CURVE, value: 1n, data: '0xaaaaaaaa' + word(TOKEN) };
  const chain = stub({ logs, txs });
  await decodeCurveIface(chain, TOKEN, { head: 9000, maxTx: 12 });
  assert.ok(chain.calls.getTransaction <= 12, `read ${chain.calls.getTransaction} transactions`);
});

test('describeIface never claims a route, only an observation', () => {
  const line = describeIface({ ok: true, curve: CURVE, buy: { selector: '0xaabbccdd', native: true, args: [{ isToken: true }, { num: 1n }] }, sell: null });
  assert.match(line, /curve 0xc000/);
  assert.match(line, /buy 0xaabbccdd \(payable\)/);
  assert.match(line, /args\[TOKEN,num\]/);
  assert.match(line, /sell not seen/);
  assert.doesNotMatch(line, /routable|can trade|ready/i);
});

test('an ABI address word is only an address when its top 12 bytes are zero', () => {
  assert.equal(_wordAddr('0'.repeat(24) + 'a'.repeat(40)), '0x' + 'a'.repeat(40));
  assert.equal(_wordAddr('1' + '0'.repeat(23) + 'a'.repeat(40)), null, 'a big number is not an address');
  assert.equal(_wordAddr('0'.repeat(64)), null, 'the zero address is not a participant');
});

// ── classifySlots ────────────────────────────────────────────────────────────
// What each argument MEANS. Every case here is a slot that, filled wrongly,
// sends somebody's money into a call that does something other than buy.
const { classifySlots } = require('./curveIface.js');

const S = (value, words, from) => ({ value: BigInt(value), from, args: words.map((w, i) => {
  const addr = /^0{24}[0-9a-fA-F]{40}$/.test(w) && !/^0{8}/.test(w.slice(24)) ? '0x' + w.slice(24).toLowerCase() : null;
  return { i, word: w, addr, num: BigInt('0x' + w), isToken: addr === TOKEN };
}) });
const leg = (samples) => ({ args: samples[0].args, samples });

test('a slot that holds the token in every sample is the token', async () => {
  const r = classifySlots(leg([S(10n ** 17n, [word(TOKEN), num(1)], WALLET), S(2n * 10n ** 17n, [word(TOKEN), num(2)], WALLET)]), TOKEN);
  assert.equal(r.slots[0].role, 'token');
});

test("a slot that holds each sample's own sender is the recipient", async () => {
  const OTHER = '0xb0000000000000000000000000000000000000b0';
  const r = classifySlots(leg([S(1, [word(WALLET)], WALLET), S(2, [word(OTHER)], OTHER)]), TOKEN);
  assert.equal(r.slots[0].role, 'sender', 'it tracks the sender, so it is not a constant');
});

test('⚠️ a slot that tracks the amount is SCALES, never a constant to be frozen', async () => {
  // Freeze it and every buy carries a minimum-out computed for somebody else's
  // trade — too high and it always reverts, too low and it is a free option
  // for whoever is watching the mempool.
  const r = classifySlots(leg([
    S(10n ** 17n, [word(TOKEN), num(1000n)], WALLET),
    S(5n * 10n ** 17n, [word(TOKEN), num(5000n)], WALLET),
    S(10n ** 18n, [word(TOKEN), num(10000n)], WALLET),
  ]), TOKEN);
  assert.equal(r.slots[1].role, 'scales');
  assert.equal(r.ok, true, r.why);
});

test('a curve is not linear, so "tracks" is a band and not an equality', async () => {
  // Real bonding curves give fewer tokens per unit as they fill. A classifier
  // demanding an exact ratio would call every real minimum-out unknown and
  // refuse every trade.
  const r = classifySlots(leg([
    S(10n ** 17n, [num(1000n)], WALLET),
    S(2n * 10n ** 17n, [num(1750n)], WALLET),   // 12.5% below linear
  ]), TOKEN);
  assert.equal(r.slots[0].role, 'scales');
});

test('a slot identical everywhere, while the amounts differ, is a constant', async () => {
  const r = classifySlots(leg([S(10n ** 17n, [num(300n)], WALLET), S(9n * 10n ** 17n, [num(300n)], WALLET)]), TOKEN);
  assert.equal(r.slots[0].role, 'constant');
  assert.equal(r.slots[0].value, num(300n));
});

test('⚠️ a slot nobody can explain REFUSES the whole leg', async () => {
  // The safety line. A deadline, a referrer code or a nonce filled from a
  // stranger's trade is a call that does something other than what we intend.
  const r = classifySlots(leg([S(10n ** 17n, [num(111n)], WALLET), S(2n * 10n ** 17n, [num(999999n)], WALLET)]), TOKEN);
  assert.equal(r.slots[0].role, 'unknown');
  assert.equal(r.ok, false);
  assert.match(r.why, /could not be explained/);
  // …and it is never a claim about the token itself.
  assert.doesNotMatch(r.why, /cannot be traded|no route|not tradable/i);
});

test('⚠️ ONE sample explains nothing, and must not pass as "all constant"', async () => {
  const r = classifySlots(leg([S(10n ** 17n, [word(TOKEN), num(1000n)], WALLET)]), TOKEN);
  assert.equal(r.ok, false);
  assert.match(r.why, /only 1 sample/);
  assert.ok(r.slots.every((s) => s.role === 'unknown'), 'nothing may be inferred from a single trade');
});

test('a call with no arguments at all is completely understood', async () => {
  const r = classifySlots({ args: [], samples: [] }, TOKEN);
  assert.equal(r.ok, true);
  assert.deepEqual(r.slots, []);
});

test('samples of identical size cannot prove a slot scales', async () => {
  // Two buys of the same amount make an amount slot look constant. Without a
  // varied sample the honest answer is "constant", and the builder treats a
  // constant amount as exactly what it is — which is why the varied case above
  // is the one that unlocks `scales`.
  const r = classifySlots(leg([S(10n ** 17n, [num(1000n)], WALLET), S(10n ** 17n, [num(1000n)], WALLET)]), TOKEN);
  assert.equal(r.slots[0].role, 'constant');
});

test('⚠️ a range-capped node is WALKED before its empty answer is believed', async () => {
  // The defect this exists for: the wide query returns [] because the node
  // refuses the range, and the token looks untraded. `robinhood-preflight` §4x
  // already walked the tail in steps; the port carried the logic and dropped
  // the lesson.
  let wide = 0, narrow = 0;
  const CAP = 500;
  const chain = {
    async getLogs({ fromBlock, toBlock }) {
      if (toBlock - fromBlock > CAP) { wide++; return []; }      // silently capped
      narrow++;
      return toBlock >= 8800 ? [xfer(CURVE, WALLET, '0xh1')] : [];
    },
    async getTransaction() { return { to: CURVE, from: WALLET, value: 10n ** 17n, data: '0xaabbccdd' + word(TOKEN) }; },
  };
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000, blocks: 5000 });
  assert.equal(wide, 1, 'the wide query is still tried first — it is one request when it works');
  assert.ok(narrow > 0, 'and the tail is walked when it comes back empty');
  assert.equal(r.curve, CURVE, 'the trade the capped node was hiding is found');
});

test('⚠️ the WALKED path hands back the NEWEST trades, newest-first', async () => {
  /*
   * `found.reverse()` looked right and could not be right. The walk runs newest
   * RANGE first while `getLogs` returns each range oldest-first, so `found` is
   * "chunks descending, items ascending" — sorted in neither direction; its
   * reverse is "chunks ascending, items descending", also not sorted. The
   * caller's `slice(-maxTx).reverse()` then took the OLDEST trades of the
   * newest chunk and called them the newest.
   *
   * Not cosmetic: `curvePrice.observedRate` is the last price tier and the only
   * one that answers when the pad's host is unreachable, and a curve's price
   * rises as supply sells — so the cheapest fills overstate tokens-per-unit on
   * the number that authorises a curve buy.
   *
   * ⚠️ BOTH TRADES SIT IN ONE RANGE, ascending, which is what `getLogs`
   * returns. That is the case `.reverse()` gets wrong: one trade per range
   * cannot tell the two implementations apart, and the first cut of this test
   * made exactly that mistake and passed on the bug.
   *
   * Mutation test: restore `found.reverse()` and this fails.
   */
  const at = (blk, hash) => ({ ...xfer(CURVE, WALLET, hash), blockNumber: blk, logIndex: 0 });
  const asked = [];
  const chain = {
    async getLogs({ fromBlock, toBlock }) {
      if (toBlock - fromBlock > 500) return [];                  // capped → force the walk
      if (fromBlock <= 8700 && toBlock >= 8900) return [at(8700, '0xOLD'), at(8900, '0xNEW')];
      return [];
    },
    async getTransaction(h) {
      asked.push(h);
      return { to: CURVE, from: WALLET, value: 10n ** 17n, data: '0xaabbccdd' + word(TOKEN) };
    },
  };
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000, blocks: 9000 });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(asked, ['0xNEW', '0xOLD'], 'newest trade read first — observedRate documents that requirement');
});

test("⚠️ a node that silently empties anything WIDE is still walked — the step must not scale with the span", async () => {
  /*
   * The 17:57 / 18:09 / 18:19 card, three times identical: "no trades found
   * for this token in the last 400000 blocks (also walked 24 smaller ranges)"
   * about a token whose launch buy is plainly on chain. The walk's step was
   * ceil(span / budget), so the deep window asked in 16,667-block ranges —
   * and this node answers anything that wide with [] rather than an error.
   * Every step of every window past the first was therefore silently empty,
   * and the ladder could never reach an older trade however far it "looked".
   */
  const CAP = 800;                       // what this node will actually serve
  const TRADE_AT = 60_000 - 12_000;      // older than the first window, well inside the last
  let wideAsks = 0;
  const chain = {
    async getLogs({ fromBlock, toBlock }) {
      if (toBlock - fromBlock > CAP) { wideAsks++; return []; }   // silently emptied, never an error
      return fromBlock <= TRADE_AT && TRADE_AT <= toBlock
        ? [{ ...xfer(CURVE, WALLET, '0xh1'), blockNumber: TRADE_AT }]
        : [];
    },
    async getTransaction() { return { to: CURVE, from: WALLET, value: 10n ** 17n, data: '0xaabbccdd' + word(TOKEN) + num(500) }; },
  };
  const r = await decodeCurveIface(chain, TOKEN, { head: 60_000, blocks: 60_000 });
  assert.equal(r.ok, true, `the fine walk never reached the trade: ${r.why}`);
  assert.equal(r.curve, CURVE);
  assert.ok(wideAsks > 0, 'the cheap wide asks are still tried first — they are one request when they work');
});

test("⚠️ a ROUTED buy still names what the pad charges in — the trader is not on the leg", async () => {
  /*
   * The live refusal (19:17): "this pad's buy is not paid in the native coin,
   * and its trades do not show what it IS paid in", about a pad that plainly
   * charges something. Its website routes the buy — user → router → curve — so
   * the payment Transfer runs ROUTER → curve, the trader-to-curve match found
   * nothing, and quoteOf (which needs every sample to carry one) went null.
   * What the curve RECEIVED is the fact; who forwarded it is not.
   */
  const ROUTER2 = '0xe0000000000000000000000000000000000000e0';
  const QUOTE = '0x9900000000000000000000000000000000000099';
  const mk = (h, tokAmt, payAmt) => ({
    logs: [{ topics: [TRANSFER_TOPIC, topic(CURVE), topic(WALLET)], data: '0x' + num(tokAmt), transactionHash: h, address: TOKEN }],
    rcpt: { logs: [
      { address: TOKEN, topics: [TRANSFER_TOPIC, topic(CURVE), topic(WALLET)], data: '0x' + num(tokAmt) },
      // the payment: the ROUTER pays the curve, not the trader
      { address: QUOTE, topics: [TRANSFER_TOPIC, topic(ROUTER2), topic(CURVE)], data: '0x' + num(payAmt) },
    ] },
  });
  const a = mk('0xr1', 1000n, 10n), b = mk('0xr2', 2000n, 20n);
  const chain = {
    async getLogs() { return [...a.logs, ...b.logs]; },
    async getTransaction(h) {
      return { to: CURVE, from: WALLET, value: 0n, data: '0xaabbccdd' + word(TOKEN) + num(h === '0xr1' ? 1000 : 2000) };
    },
    async getTransactionReceipt(h) { return h === '0xr1' ? a.rcpt : b.rcpt; },
  };
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000 });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.buy.native, false, 'it is not a native-paid buy');
  assert.equal(r.buy.quote, QUOTE, "and the pad's own charging token is named, not left null");
});

test('a walk where every step errors is an outage, not an untraded token', async () => {
  const chain = { async getLogs() { throw new Error('range too wide'); }, async getTransaction() { return null; } };
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000, blocks: 5000 });
  assert.match(r.why, /could not read/);
});

test('⚠️ a wide ask that ERRORS over a clean, empty stepped walk is "no trades found" — not an outage', async () => {
  // A range-capped node that REJECTS the wide request (instead of silently
  // truncating it) and then serves every step has answered the question: the
  // span was covered, hole-free, and held nothing. Reporting that as "could
  // not read" blocked both of ifaceFor's follow-ups — it only escalates to the
  // wider windows on "no trades found", and only caches a non-transport
  // verdict — so a quiet token on a capped node was re-walked from scratch
  // for ever and never once looked in the window its trades were actually in.
  const chain = {
    async getLogs({ fromBlock, toBlock }) {
      if (toBlock - fromBlock > 500) throw new Error('query returned more than 10000 results');
      return [];
    },
    async getTransaction() { return null; },
  };
  const r = await decodeCurveIface(chain, TOKEN, { head: 9000, blocks: 5000 });
  assert.match(r.why, /^no trades found/, `an answered span must escalate, got: ${r.why}`);
  assert.doesNotMatch(r.why, /could not read/);
});

test('the walk is BOUNDED — a wide window must not become hundreds of round trips', async () => {
  // Two passes now (coarse over the span, then fine near the head in
  // node-sized asks — see decodeCurveIface), so the ceiling is their two
  // budgets plus the single wide ask. What must never come back is an
  // unbounded walk: 5,000,000 blocks at the fine step alone would be 10,000
  // requests.
  let calls = 0;
  const chain = { async getLogs() { calls++; return []; }, async getTransaction() { return null; } };
  await decodeCurveIface(chain, TOKEN, { head: 10_000_000, blocks: 5_000_000, steps: 24 });
  const ceiling = 1 + 24 + require('./curveIface.js').LOG_STEPS;
  assert.ok(calls <= ceiling, `made ${calls} getLogs calls, ceiling ${ceiling}`);
});

test("⚠️ a CONSTANT ADDRESS is refused — replaying a stranger's is how a buy pays out to somebody else", () => {
  // The token and the sender are handled above this, so an address identical
  // across every sample is a stranger's: a recipient, a referrer, a router, and
  // nothing here can tell which. The recipient reading is the ORDINARY one when
  // the only trades on file are the dev's, from one wallet into another.
  //
  // Nothing downstream can catch it: estimateGas succeeds (the call is
  // perfectly valid) and the price check succeeds (the AMOUNT is right — it is
  // the destination that is wrong), so the buy lands on-chain with the tokens
  // minted to somebody else.
  const STRANGER = '0xf00d000000000000000000000000000000000f00';
  const pad = (a) => '0'.repeat(24) + a.slice(2);
  const E17 = 10n ** 17n;
  const leg = {
    selector: '0x11223344',
    args: [{ i: 0, word: pad(STRANGER), addr: STRANGER, num: 1n, isToken: false }],
    samples: [
      { value: E17, amount: 1n, from: WALLET, args: [{ i: 0, word: pad(STRANGER), addr: STRANGER, num: 1n, isToken: false }] },
      { value: 2n * E17, amount: 2n, from: '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', args: [{ i: 0, word: pad(STRANGER), addr: STRANGER, num: 1n, isToken: false }] },
    ],
  };
  const r = classifySlots(leg, TOKEN);
  assert.equal(r.ok, false, 'unknown is a refusal, and this must be unknown');
  assert.equal(r.slots[0].role, 'unknown');
  assert.match(r.slots[0].why, /neither the token nor the trader/);
});

test('…but the ZERO address is not a stranger — it is the same 32 bytes as the number 0', () => {
  const E17 = 10n ** 17n;
  const leg = {
    selector: '0x11223344',
    args: [{ i: 0, word: '0'.repeat(64), addr: null, num: 0n, isToken: false }],
    samples: [
      { value: E17, amount: 1n, from: WALLET, args: [{ i: 0, word: '0'.repeat(64), addr: null, num: 0n, isToken: false }] },
      { value: 2n * E17, amount: 2n, from: WALLET, args: [{ i: 0, word: '0'.repeat(64), addr: null, num: 0n, isToken: false }] },
    ],
  };
  assert.equal(classifySlots(leg, TOKEN).slots[0].role, 'constant', 'sending to nobody is not sending to a stranger');
});

test('⚠️ a RANGE error still walks — only a refusal stops it', async () => {
  /*
   * The dangerous direction of `_refusal`. The walk exists FOR a node that caps
   * ranges, so misreading "query returned more than 10000 results" as a refusal
   * would switch off the fix for the exact failure it was written for — and
   * silently, because the result is the same honest "could not read" either way.
   *
   * A refusal stops after one request: a 429 is waiting identically on every
   * step of the coarse pass, once per window, and this repo has already paid
   * for that shape with CoinGecko. Everything unrecognised is treated as a
   * range problem, which is fail-safe: at worst it costs requests.
   */
  const run = async (msg) => {
    let n = 0;
    const chain = { async getLogs() { n++; throw new Error(msg); }, async getTransaction() { return null; } };
    const r = await decodeCurveIface(chain, TOKEN, { head: 9000, blocks: 9000 });
    assert.equal(r.ok, false);
    assert.match(r.why, /could not read/, 'either way it is "we could not look", never a verdict on the token');
    return n;
  };
  for (const range of ['query returned more than 10000 results', 'exceed maximum block range: 5000', 'Log response size exceeded', '-32005: query timeout exceeded']) {
    assert.ok(await run(range) > 1, `a range cap stopped the walk that exists for it: ${range}`);
  }
  for (const refusal of ['429 Too Many Requests', 'request failed with status code 403', 'Unauthorized: 401', 'rate limit exceeded']) {
    assert.equal(await run(refusal), 1, `a refusal bought a whole coarse pass: ${refusal}`);
  }
});
