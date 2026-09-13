'use strict';
/*
 * THE EXIT. Driven through the real core.sell, against a stubbed chain.
 *
 * WHY IT MATTERS AS MUCH AS THE BUY
 * Wiring the buy without the sell is a position the bot can OPEN and cannot
 * CLOSE — the stop-loss-the-user-believes-exists, one field over, and there is
 * no `resolveCurve` for these tokens so nothing else in core.sell can reach
 * them.
 *
 * ⚠️ AND THE APPROVAL IS THE ONLY UNBOUNDED LOSS IN THE WHOLE DESIGN. Every
 * other risk on this path is capped by one trade. An unlimited allowance to a
 * contract the bot picked out of Transfer logs by a popularity score is capped
 * by the whole bag, for ever, and it outlives the trade that asked for it. Two
 * of the tests here exist only for that.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { ethers } = require('ethers');

const TOKEN = '0x3f8c5ac4c9b9391c99f4796e56228852a6796ddf';
const CURVE = '0xc0000000000000000000000000000000000000c0';
const E17 = 10n ** 17n;
const E18 = 10n ** 18n;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SENT_HASH = '0x' + 'cd'.repeat(32);

const w64 = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
const num = (n) => w64(BigInt(n).toString(16));
const addrWord = (a) => w64(String(a).slice(2));
const topic = (a) => '0x' + addrWord(a);

process.env.SKIP_DOTENV = '1';
process.env.WALLET_SECRET = 'd'.repeat(48);
process.env.DATA_DIR = path.join(os.tmpdir(), 'dexvra-curvesell-' + process.pid);
process.env.TRADEBOT_TOKEN = 'x';
process.env.ENABLED_CHAINS = 'base';
process.env.BOT_FEE_BPS = '0';
process.env.BASE_RPC = 'http://127.0.0.1:1';
const core = require('./core');

const CHAT = 991002;
const BAG = 1000n * E18;
let WALLET;
test.before(async () => {
  await core.ensureUser(CHAT);
  WALLET = core.getUser(CHAT).wallets[0].address;
});

/*
 * Two real SELLS through the curve: 1000 and 2000 tokens handed over, with the
 * call carrying `sell(token, minNativeOut)` where the bound tracks the size.
 *   1000 tokens → 0.1 native      (0.0001 native a token)
 *   2000 tokens → 0.2 native
 */
function stubChain(over = {}) {
  const logs = [
    { transactionHash: '0xs1', blockNumber: 10, topics: [TRANSFER, topic(WALLET), topic(CURVE)], data: '0x' + num(1000n * E18) },
    { transactionHash: '0xs2', blockNumber: 11, topics: [TRANSFER, topic(WALLET), topic(CURVE)], data: '0x' + num(2000n * E18) },
  ];
  const txs = {
    '0xs1': { to: CURVE, from: WALLET, value: 0n, data: '0x5e115e11' + addrWord(TOKEN) + num(E17) },
    '0xs2': { to: CURVE, from: WALLET, value: 0n, data: '0x5e115e11' + addrWord(TOKEN) + num(2n * E17) },
  };
  const state = { bag: BAG, allowance: 0n, native: 5n * E18, sent: [], approvals: [], short: false };
  return {
    state,
    async getBlockNumber() { return 5000; },
    async getLogs(f) { return String(f && f.address).toLowerCase() === TOKEN.toLowerCase() ? logs : []; },
    async getTransaction(h) { return txs[h] || null; },
    async call(tx) {
      const sel = String(tx.data || '').slice(0, 10);
      if (sel === '0x70a08231') return '0x' + num(state.bag);            // balanceOf
      if (sel === '0xdd62ed3e') return '0x' + num(state.allowance);       // allowance
      if (sel === '0x313ce567') return '0x' + num(18n);                   // decimals
      if (sel === '0x18160ddd') return '0x' + num(1_000_000_000n * E18);  // totalSupply
      if (sel === '0xe6a43905') return '0x' + addrWord(ethers.ZeroAddress);
      if (String(tx.to).toLowerCase() === CURVE.toLowerCase()) return '0x' + num(E17);
      throw new Error('no data');
    },
    async estimateGas() { return 210000n; },
    async getBalance() { return state.native; },
    async getFeeData() { return { gasPrice: ethers.parseUnits('0.02', 'gwei') }; },
    async getBlock() { return { number: 5000, baseFeePerGas: ethers.parseUnits('0.01', 'gwei') }; },
    async getTransactionCount() { return 3; },
    async waitForTransaction() { return { status: 1, hash: SENT_HASH }; },
    async broadcastTransaction() { return { hash: SENT_HASH }; },
    getNetwork: async () => ({ chainId: 8453n }),
    _detectNetwork: async () => ({ chainId: 8453n }),
    resolveName: (n) => n,
    ...over,
  };
}

function withStubs(chain, { padPrice = 0.2, padOk = true } = {}) {
  const realProv = core._deps.providerFor;
  const realFetch = global.fetch;
  const lp = require('./launchpads');
  const realRec = lp.record;
  const realPool = core.v4.bestPool;

  core._deps.providerFor = () => chain;
  core.v4.bestPool = async () => null;
  lp.record = async () => (padOk
    ? { record: { priceUsd: padPrice, launchpad: 'Pons' }, ok: true, why: null, tried: [] }
    : { record: null, ok: false, why: 'pons: ENOTFOUND', tried: [] });
  global.fetch = async (url, init) => {
    if (String(url).includes('coinbase')) return { ok: true, async json() { return { data: { amount: '2000' } }; } };
    let body = null; try { body = init && init.body ? JSON.parse(init.body) : null; } catch (_) {}
    if (body && body.method === 'eth_sendRawTransaction') {
      const tx = ethers.Transaction.from(body.params[0]);
      chain.state.sent.push(tx);
      // An approve() to the token address moves the allowance the engine then
      // re-reads — the module refuses to ASSUME what a non-standard approve did.
      if (String(tx.to).toLowerCase() === TOKEN.toLowerCase() && tx.data.startsWith('0x095ea7b3')) {
        chain.state.approvals.push(tx);
        chain.state.allowance = BigInt('0x' + tx.data.slice(74, 138));
      }
      // The sell itself: tokens leave, native arrives.
      if (String(tx.to).toLowerCase() === CURVE.toLowerCase()) {
        // ⚠️ A SHORT FILL, deliberately. A curve can hand back less than was
        // asked for — a transfer fee, a partial fill, a rounding floor — and
        // `filledRaw` defaults to the ASK. With a fixture that always fills
        // exactly, the assertion "the receipt states what actually left the
        // wallet" is true whatever the code does: mutation-tested, deleting the
        // measurement left all five tests green.
        chain.state.bag = chain.state.short ? BAG / 20n : 0n;
        chain.state.native += E17;
      }
    }
    return { ok: true, async json() { return { jsonrpc: '2.0', id: 1, result: SENT_HASH }; } };
  };
  core._clearReadCaches();
  return () => {
    core._deps.providerFor = realProv;
    core.v4.bestPool = realPool;
    lp.record = realRec;
    global.fetch = realFetch;
    core._clearReadCaches();
  };
}

test('⚠️ a bag whose only market is a curve CAN BE SOLD', async () => {
  const chain = stubChain();
  const restore = withStubs(chain);
  try {
    const r = await core.sell(CHAT, TOKEN, 100, 'base');
    assert.equal(r.venue, 'curve·obs', 'the sell went out through the discovered curve');
    assert.equal(r.hash, SENT_HASH);
    // ⚠️ MEASURED, not assumed: `filledRaw` defaults to what we ASKED to sell,
    // and a discovered call can hand over less — a receipt printing the ask
    // will not reconcile against the explorer.
    assert.equal(r.soldTokens, 1000, 'the receipt states what actually left the wallet');
    assert.ok(r.proceedsEth > 0, 'and the native that arrived is booked');
    assert.ok(r.curveVia, 'the receipt says what checked this trade');
  } finally { restore(); }
});

test('⚠️ a SHORT fill is reported as what sold, and does not book the bag closed', async () => {
  // `filledRaw` defaults to the amount ASKED for. A curve that hands back less
  // — a transfer fee, a partial fill — then produces a receipt that will not
  // reconcile against the explorer, a cost basis pro-rated by the wrong
  // fraction, and a position marked closed with 5% of it still in the wallet,
  // whose later re-buy inherits a zeroed basis.
  const chain = stubChain();
  chain.state.short = true;
  const restore = withStubs(chain);
  try {
    const r = await core.sell(CHAT, TOKEN, 100, 'base');
    assert.equal(r.soldTokens, 950, 'measured from the balance delta, not from the ask');
    const pos = core.getUser(CHAT).wallets[0].positions['base:' + TOKEN.toLowerCase()];
    if (pos) assert.ok(!pos.closed, 'a bag with 5% left in it is not a closed position');
  } finally { restore(); }
});

test('⚠️ the allowance granted is EXACTLY the sell, never unlimited', async () => {
  // v4.js already draws this line for a discovered router: "an operator-set
  // router gets a standing allowance; a discovered one gets this sell and
  // nothing more." An unlimited grant to an address inferred from log scoring
  // is bounded by the whole bag, for ever.
  const chain = stubChain();
  const restore = withStubs(chain);
  try {
    await core.sell(CHAT, TOKEN, 100, 'base');
    assert.equal(chain.state.approvals.length, 1, 'one approval, for this sell');
    const a = chain.state.approvals[0];
    const spender = '0x' + a.data.slice(34, 74);
    const amount = BigInt('0x' + a.data.slice(74, 138));
    assert.equal(spender.toLowerCase(), CURVE, 'granted to the curve the trades name');
    assert.equal(amount, BAG, 'exactly the amount being sold');
    assert.notEqual(amount, ethers.MaxUint256);
  } finally { restore(); }
});

test('⚠️ nothing is approved when the sell cannot be built', async () => {
  // The allowance check used to run FIRST — above build, above the price check
  // — so an approval was granted to a log-scored address and the call could
  // still be refused afterwards, leaving the grant standing for a sell that
  // never happened.
  const chain = stubChain();
  const restore = withStubs(chain, { padPrice: 999 });   // a price nothing agrees with
  try {
    await assert.rejects(() => core.sell(CHAT, TOKEN, 100, 'base'), /launchpad curve|nothing was sold/);
    assert.equal(chain.state.approvals.length, 0, 'a refusal that costs an allowance is worse than the refusal');
    assert.equal(chain.state.sent.length, 0);
  } finally { restore(); }
});

test('⚠️ a token with nowhere to sell is not approved to the V2 router either', async () => {
  // This one predates the curve route: a bonding-curve bag used to be granted
  // an UNLIMITED allowance to the V2 router for a pair that does not exist,
  // and then fail at getAmountsOut — an approval for a route that can never
  // run, on every attempt.
  const chain = stubChain({ async getLogs() { return []; } });   // no curve readable
  const restore = withStubs(chain);
  try {
    await assert.rejects(() => core.sell(CHAT, TOKEN, 100, 'base'), /launchpad curve|nothing was sold/);
    assert.equal(chain.state.approvals.length, 0);
  } finally { restore(); }
});

test('the refusal names the curve, so it is not retried three times with more gas', async () => {
  // telegram.js's sell ladder re-runs anything matching /try again/ with rising
  // gas. "could not quote this sell (no pool? try again)" sent a user through
  // three full attempts for a condition gas cannot fix.
  const chain = stubChain({ async getLogs() { return []; } });
  const restore = withStubs(chain);
  try {
    await assert.rejects(() => core.sell(CHAT, TOKEN, 100, 'base'), (e) => {
      assert.match(e.message, /nothing was sold/);
      assert.doesNotMatch(e.message, /try again/);
      assert.equal(require('./i18n.js').errorKey(e), 'err.curve_refused');
      return true;
    });
  } finally { restore(); }
});
