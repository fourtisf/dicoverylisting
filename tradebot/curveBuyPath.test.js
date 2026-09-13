'use strict';
/*
 * A BONDING-CURVE TOKEN CAN NOW ACTUALLY BE BOUGHT — driven through the REAL
 * core.buy, against a stubbed chain.
 *
 * WHY THIS FILE HAS TO ASSERT A POSITIVE
 * Every other test on this path asserts a refusal, and refusals are the easy
 * half: a wiring that does nothing refuses beautifully. The two ways this
 * feature ships INERT both pass a refusal-only suite —
 *
 *   · `curveTrade.prepareBuy(chain, …)` handed core's `chain` (the config
 *     record from `chainOf`) instead of `providerFor(chainKey)`. It does not
 *     throw. It answers "could not read the chain head
 *     (chain.getBlockNumber is not a function)" and the buy falls back to the
 *     old dead-end sentence, with no error anywhere;
 *   · `sane()` handed an `expectedTokens` that is null for exactly the tokens
 *     this exists to trade, so every buy refuses at the last gate after paying
 *     a dozen RPC reads.
 *
 * Both look like a careful bot from Telegram. This repo treats an inert feature
 * as costing what a wrong fill costs, because they are indistinguishable to the
 * person pressing Buy — so the assertion that matters is that a transaction was
 * SIGNED, that it carried OUR calldata, and that the position was booked.
 *
 * It runs `SKIP_DOTENV=1` like the rest of the suite; every knob is set before
 * core is required, because core reads env at module-eval time.
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
const SENT_HASH = '0x' + 'ab'.repeat(32);

const w64 = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
const num = (n) => w64(BigInt(n).toString(16));
const addrWord = (a) => w64(String(a).slice(2));
const topic = (a) => '0x' + addrWord(a);

process.env.SKIP_DOTENV = '1';
process.env.WALLET_SECRET = 'c'.repeat(48);
process.env.DATA_DIR = path.join(os.tmpdir(), 'dexvra-curvebuy-' + process.pid);
process.env.TRADEBOT_TOKEN = 'x';
process.env.ENABLED_CHAINS = 'base';
process.env.BOT_FEE_BPS = '0';          // so `spend` is exactly what was asked for
process.env.BASE_RPC = 'http://127.0.0.1:1';
const core = require('./core');

// ── the wallet the engine will sign with ──────────────────────────────────
const CHAT = 991001;
let WALLET;
test.before(async () => {
  await core.ensureUser(CHAT);
  WALLET = core.getUser(CHAT).wallets[0].address;
});

/*
 * A chain that has: no V2 pair, no V3 pool, no v4 pool — and two real buys
 * through a curve. The ONLY market this token has is its launchpad curve, which
 * is the whole case under test.
 *
 * The observed buy is `0xaabbccdd(token, recipient, minTokensOut)`:
 *   0.1 native → 1000 tokens        (ratio 10,000 tokens per native)
 *   0.2 native → 2000 tokens
 */
function stubChain(over = {}) {
  const logs = [
    { transactionHash: '0xb1', blockNumber: 10, topics: [TRANSFER, topic(CURVE), topic(WALLET)], data: '0x' + num(1000n * E18) },
    { transactionHash: '0xb2', blockNumber: 11, topics: [TRANSFER, topic(CURVE), topic(WALLET)], data: '0x' + num(2000n * E18) },
  ];
  const txs = {
    '0xb1': { to: CURVE, from: WALLET, value: E17, data: '0xaabbccdd' + addrWord(TOKEN) + addrWord(WALLET) + num(1000n * E18) },
    '0xb2': { to: CURVE, from: WALLET, value: 2n * E17, data: '0xaabbccdd' + addrWord(TOKEN) + addrWord(WALLET) + num(2000n * E18) },
  };
  const state = { balanceOf: 0n, tokenBal: 0n, quoteBal: 0n, allow: 0n, calls: [], sent: [] };
  const answer = (tx) => {
    const sel = String(tx.data || '').slice(0, 10);
    state.calls.push(sel);
    if (sel === '0x70a08231') return '0x' + num(state.balanceOf);          // balanceOf
    if (sel === '0x313ce567') return '0x' + num(18n);                       // decimals
    if (sel === '0x18160ddd') return '0x' + num(1_000_000_000n * E18);      // totalSupply
    if (sel === '0xe6a43905') return '0x' + addrWord(ethers.ZeroAddress);   // getPair → none
    if (String(tx.to).toLowerCase() === CURVE.toLowerCase()) return '0x' + num(1000n * E18);  // the curve executes
    throw new Error('no data');                                            // name/symbol etc.
  };
  return {
    state,
    async getBlockNumber() { return 5000; },
    async getLogs(f) { return String(f && f.address).toLowerCase() === TOKEN.toLowerCase() ? logs : []; },
    async getTransaction(h) { return txs[h] || null; },
    async call(tx) { return answer(tx); },
    async estimateGas() { return 210000n; },
    async getBalance() { return 5n * E18; },
    async getFeeData() { return { gasPrice: ethers.parseUnits('0.02', 'gwei'), maxFeePerGas: null, maxPriorityFeePerGas: null }; },
    async getTransactionCount() { return 3; },
    async waitForTransaction() { return { status: 1, hash: SENT_HASH }; },
    // gasOverrides reads the head block's baseFeePerGas on a 1559 chain.
    async getBlock() { return { number: 5000, baseFeePerGas: ethers.parseUnits('0.01', 'gwei') }; },
    async broadcastTransaction() { return { hash: SENT_HASH }; },
    getNetwork: async () => ({ chainId: 8453n }),
    _detectNetwork: async () => ({ chainId: 8453n }),
    resolveName: (n) => n,
    ...over,
  };
}

/** Install every seam core.buy reaches outside the chain, and restore after. */
function withStubs(chain, { padPrice = 0.2, padOk = true } = {}) {
  const realProv = core._deps.providerFor;
  const realFetch = global.fetch;
  const lp = require('./launchpads');
  const realRec = lp.record;
  const realPool = core.v4.bestPool;

  core._deps.providerFor = () => chain;
  core.v4.bestPool = async () => null;                       // no v4 pool either
  lp.record = async () => (padOk
    ? { record: { priceUsd: padPrice, launchpad: 'Pons' }, ok: true, why: null, tried: [] }
    : { record: null, ok: false, why: 'pons: ENOTFOUND', tried: [] });
  global.fetch = async (url, init) => {
    if (String(url).includes('coinbase')) return { ok: true, async json() { return { data: { amount: '2000' } }; } };
    // ⚠️ ONLY a broadcast counts. `marketOf` asks DexScreener and GeckoTerminal
    // over this same stub, and counting those as sends made the assertion
    // "nothing was broadcast" fail on a refusal that broadcast nothing — a test
    // measuring its own fake, which this repo has paid for twice.
    let body = null; try { body = init && init.body ? JSON.parse(init.body) : null; } catch (_) {}
    if (body && body.method === 'eth_sendRawTransaction') chain.state.sent.push(body.params[0]);
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

test('⚠️ a token whose ONLY market is a launchpad curve is BOUGHT — not politely refused', async () => {
  const chain = stubChain();
  const restore = withStubs(chain);
  try {
    // The curve pays out on the way back, so the post-buy balance read shows
    // the tokens that arrived.
    const realCall = chain.call.bind(chain);
    let bought = false;
    chain.call = async (tx) => {
      if (String(tx.data || '').startsWith('0x70a08231') && bought) return '0x' + num(1000n * E18);
      return realCall(tx);
    };
    const origWait = chain.waitForTransaction.bind(chain);
    chain.waitForTransaction = async (...a) => { bought = true; return origWait(...a); };

    const r = await core.buy(CHAT, TOKEN, 0.1, 'base');
    assert.equal(r.venue, 'curve·obs', 'the buy filled through the discovered curve');
    assert.equal(r.hash, SENT_HASH);
    assert.ok(r.gotTokens > 0, 'and tokens actually arrived');
    // ⚠️ THE RECEIPT SAYS WHICH PRICE CHECKED IT. A gate nobody can read is the
    // same as no gate — and a strong check and a weak one are different
    // assurances the user is owed the difference between.
    assert.ok(r.curveVia, 'the receipt carries what checked this trade');
    assert.match(r.curveVia.source, /Pons price/);
    assert.equal(r.curveVia.weak, false);
    assert.equal(r.curveVia.bound, true, 'an independent price is also the on-chain floor');
    assert.equal(String(r.curveVia.curve).toLowerCase(), CURVE);
  } finally { restore(); }
});

test('the signed calldata carries OUR wallet and OUR bound, never the stranger\'s', async () => {
  const chain = stubChain();
  const restore = withStubs(chain);
  const signed = [];
  try {
    const real = global.fetch;
    global.fetch = async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      if (body && body.method === 'eth_sendRawTransaction') {
        signed.push(ethers.Transaction.from(body.params[0]));
      }
      return real(url, init);
    };
    let bought = false;
    const realCall = chain.call.bind(chain);
    chain.call = async (tx) => (String(tx.data || '').startsWith('0x70a08231') && bought ? '0x' + num(1000n * E18) : realCall(tx));
    const origWait = chain.waitForTransaction.bind(chain);
    chain.waitForTransaction = async (...a) => { bought = true; return origWait(...a); };

    await core.buy(CHAT, TOKEN, 0.1, 'base');
    const tx = signed.find((t) => String(t.to).toLowerCase() === CURVE.toLowerCase());
    assert.ok(tx, 'a transaction was signed against the discovered curve');
    const body = tx.data.slice(10);
    assert.equal(body.slice(0, 64), addrWord(TOKEN), 'the token slot carries OUR token');
    assert.equal(body.slice(64, 128), addrWord(WALLET).toLowerCase(), 'the recipient slot carries OUR wallet, not the observed buyer');
    // 0.1 native at the pad's $0.20 with ETH at $2000 is 1000 tokens; the user's
    // default slippage is cut off that, and the number that lands must be OUR
    // floor rather than a stranger's minimum-out stretched to our size.
    const bound = BigInt('0x' + body.slice(128, 192));
    assert.ok(bound > 0n && bound < 1000n * E18, 'a real floor, below the expectation');
    assert.equal(tx.value, E17, 'the whole spend goes to the curve');
  } finally { restore(); }
});

test('⚠️ an unreachable launchpad does NOT make the feature inert — the fills do', async () => {
  // The pad host being unreachable is the operator's own reported state
  // ("✗ pons — can't reach api.pons.fun"). If that killed the trade, the route
  // would be inert on exactly the box it was built for. The rate recent fills
  // PAID is a different field from the argument the interface is read from, so
  // it is a real check — a weaker one, which is why it says so.
  const chain = stubChain();
  const restore = withStubs(chain, { padOk: false });
  try {
    let bought = false;
    const realCall = chain.call.bind(chain);
    chain.call = async (tx) => (String(tx.data || '').startsWith('0x70a08231') && bought ? '0x' + num(1000n * E18) : realCall(tx));
    const origWait = chain.waitForTransaction.bind(chain);
    chain.waitForTransaction = async (...a) => { bought = true; return origWait(...a); };

    const r = await core.buy(CHAT, TOKEN, 0.1, 'base');
    assert.equal(r.venue, 'curve·obs');
    assert.equal(r.curveVia.weak, true, 'and it SAYS the check was the weak one');
    assert.match(r.curveVia.source, /recent fills/);
    assert.equal(r.curveVia.bound, false, 'a weak price may check the interface but not become the on-chain floor');
  } finally { restore(); }
});

test('⚠️ with NO price at all, it refuses — and names which nothing', async () => {
  // The alternative is pricing a curve against itself. A missed trade is a
  // shrug; a wrong fill is not.
  const chain = stubChain();
  // Fills that paid nothing readable leave tier 3 with nothing either.
  for (const lg of await chain.getLogs({ address: TOKEN })) lg.data = '0x' + num(0n);
  const restore = withStubs(chain, { padOk: false });
  try {
    await assert.rejects(() => core.buy(CHAT, TOKEN, 0.1, 'base'), (e) => {
      assert.match(e.message, /launchpad curve/);
      assert.match(e.message, /could not be reached from this server/, "ours, not the token's");
      assert.match(e.message, /nothing was sent/);
      return true;
    });
    assert.equal(chain.state.sent.length, 0, 'nothing may be broadcast when the gate refuses');
  } finally { restore(); }
});

test('CURVE_ROUTE=0 puts the old dead end back, exactly', async () => {
  // A kill switch that half-works is worse than none: an operator turning this
  // off must get the behaviour they had before it shipped.
  const chain = stubChain();
  const restore = withStubs(chain);
  const real = process.env.CURVE_ROUTE;
  process.env.CURVE_ROUTE = '0';
  try {
    // The flag is read at module-eval time, so re-require in a clean registry.
    delete require.cache[require.resolve('./core')];
    delete require.cache[require.resolve('./curveTrade')];
    const c2 = require('./core');
    c2._deps.providerFor = () => chain;
    c2.v4.bestPool = async () => null;
    await c2.ensureUser(CHAT);
    await assert.rejects(() => c2.buy(CHAT, TOKEN, 0.1, 'base'), (e) => {
      // ⚠️ The OLD sentence, not a new one about a feature they switched off.
      assert.match(e.message, /can't route through yet|could not quote this buy/);
      assert.doesNotMatch(e.message, /CURVE_ROUTE/);
      return true;
    });
    assert.equal(chain.state.sent.length, 0);
  } finally {
    if (real === undefined) delete process.env.CURVE_ROUTE; else process.env.CURVE_ROUTE = real;
    delete require.cache[require.resolve('./core')];
    delete require.cache[require.resolve('./curveTrade')];
    require('./core');
    restore();
  }
});

test('⚠️ canTradeNow answers YES once the curve is known, or every snipe stays inert', async () => {
  // The dev snipe, the CA snipe, _fireLaunch's gate and the launch retry ring
  // all poll this predicate. Without a curve leg the user watches a manual buy
  // succeed while an armed snipe never fires — worse than before, because the
  // bot has told them in writing it would buy at graduation.
  const chain = stubChain();
  const restore = withStubs(chain);
  try {
    core.curveTrade._reset();
    // Cold: "we have not looked" is NOT "this token cannot be traded", and the
    // probe may not pay a dozen RPC reads on a timer.
    assert.equal(await core.canTradeNow(TOKEN, 'base'), false);
    await core.curveTrade.ifaceFor(chain, 'base', TOKEN);
    assert.equal(await core.canTradeNow(TOKEN, 'base'), true, 'a warm interface is a cheap yes');
  } finally { restore(); }
});

test('⚠️ the CARD offers a Buy button, or none of the above is reachable', async () => {
  // `core.buy` filling a curve changes nothing if the only surface a user can
  // press it from never offers the tap. The EVM branch of tokenSnapshot used to
  // `return null` for a token with no pool and no indexer — "❌ Couldn't price
  // it", no Buy button — about a token trading fine on its pad. telegram.js
  // gates the whole card on `routable`.
  const chain = stubChain();
  const restore = withStubs(chain, { padOk: false });   // the pad is unreachable, as on the box
  try {
    const snap = await core.tokenSnapshot(TOKEN, 'base');
    assert.ok(snap, 'a readable curve is not "no market"');
    assert.equal(snap.routable, true, 'and routable is MEASURED, not inferred from having a price');
    assert.ok(snap.priceEth > 0, 'priced from the token\'s own fills, with no third party at all');
    assert.equal(snap.onCurve, true);
    assert.equal(snap.liquidityUsd, null, 'a curve has no pool depth, and 0 on a card reads as a rug');
  } finally { restore(); }
});

test('…and a contract with no curve, no pool and no pad is still honestly nothing', async () => {
  const chain = stubChain({ async getLogs() { return []; } });
  const restore = withStubs(chain, { padOk: false });
  try {
    assert.equal(await core.tokenSnapshot(TOKEN, 'base'), null);
  } finally { restore(); }
});


// ────────────────────────────────────────────────────────────────────────────
// A PAD THAT CHARGES IN ITS OWN TOKEN — the Virtuals-class shape.
//
// "walaupun token launch di launchpad manapun" means both kinds. A pad priced
// in an ERC-20 pays no `msg.value`, so which token it takes is in neither the
// calldata nor this token's own logs: it is in the transaction's OTHER Transfer
// logs, where the trader paid the curve.
const QUOTE = '0x4444444444444444444444444444444444444444';
const V3POOL = '0x5555555555555555555555555555555555555555';
const WETH = '0x4200000000000000000000000000000000000006';   // Base's, from chains.js

function quoteChain() {
  const c = stubChain();
  const logs = [
    { transactionHash: '0xq1', blockNumber: 10, topics: [TRANSFER, topic(CURVE), topic(WALLET)], data: '0x' + num(1000n * E18) },
    { transactionHash: '0xq2', blockNumber: 11, topics: [TRANSFER, topic(CURVE), topic(WALLET)], data: '0x' + num(2000n * E18) },
  ];
  const txs = {
    '0xq1': { to: CURVE, from: WALLET, value: 0n, data: '0xaabbccdd' + addrWord(TOKEN) + addrWord(WALLET) + num(1000n * E18) },
    '0xq2': { to: CURVE, from: WALLET, value: 0n, data: '0xaabbccdd' + addrWord(TOKEN) + addrWord(WALLET) + num(2000n * E18) },
  };
  const paid = { '0xq1': E17, '0xq2': 2n * E17 };   // 1:1 with native, so the value maths stays readable
  c.state.quoteBal = 0n;
  c.getLogs = async (f) => (String(f && f.address).toLowerCase() === TOKEN.toLowerCase() ? logs : []);
  c.getTransaction = async (h) => txs[h] || null;
  c.getTransactionReceipt = async (h) => ({ logs: [{ address: QUOTE, topics: [TRANSFER, topic(WALLET), topic(CURVE)], data: '0x' + num(paid[h] || 0n) }] });
  c.call = async (tx) => {
    const sel = String(tx.data || '').slice(0, 10);
    const to = String(tx.to || '').toLowerCase();
    if (sel === '0x70a08231') {
      const who = '0x' + String(tx.data).slice(-40).toLowerCase();
      // v3BestPool asks WETH how much the POOL holds — that reserve is what
      // makes a venue fillable, and without it the swap leg has nowhere to go.
      if (to === WETH) return '0x' + num(who === V3POOL ? 50n * E18 : 0n);
      if (to === QUOTE) return '0x' + num(who === V3POOL ? 50n * E18 : c.state.quoteBal);
      return '0x' + num(c.state.tokenBal || 0n);
    }
    if (sel === '0x313ce567') return '0x' + num(18n);
    if (sel === '0x18160ddd') return '0x' + num(1_000_000_000n * E18);
    if (sel === '0xdd62ed3e') return '0x' + num(c.state.allow || 0n);
    // The V3 factory names a pool for the QUOTE token so the swap leg has a
    // venue; our token has none, which is the whole premise.
    if (sel === '0x1698ee82') return '0x' + addrWord(String(tx.data).toLowerCase().includes(QUOTE.slice(2).toLowerCase()) ? V3POOL : ethers.ZeroAddress);
    if (sel === '0xe6a43905') return '0x' + addrWord(ethers.ZeroAddress);
    if (to === V3POOL && sel === '0x3850c7bd') {            // slot0
      return '0x' + num(2n ** 96n) + num(0n) + num(0n) + num(0n) + num(0n) + num(0n) + num(1n);
    }
    if (to === V3POOL && sel === '0x0dfe1681') return '0x' + addrWord(QUOTE);   // token0
    if (to === CURVE.toLowerCase()) return '0x' + num(1000n * E18);
    throw new Error('no data');
  };
  return c;
}

test('⚠️ a pad that charges in ITS OWN TOKEN is bought in two legs, and the receipt says so', async () => {
  const chain = quoteChain();
  const restore = withStubs(chain, { padOk: false });
  try {
    const real = global.fetch;
    global.fetch = async (url, init) => {
      let body = null; try { body = init && init.body ? JSON.parse(init.body) : null; } catch (_) {}
      if (body && body.method === 'eth_sendRawTransaction') {
        const tx = ethers.Transaction.from(body.params[0]);
        // Leg one lands the quote token; the approval records itself; the curve
        // call pays out our token.
        if (tx.value > 0n && String(tx.to).toLowerCase() !== CURVE.toLowerCase()) chain.state.quoteBal += tx.value;
        if (tx.data.startsWith('0x095ea7b3')) chain.state.allow = BigInt('0x' + tx.data.slice(74, 138));
        if (String(tx.to).toLowerCase() === CURVE.toLowerCase()) chain.state.tokenBal = 1000n * E18;
      }
      return real(url, init);
    };
    const r = await core.buy(CHAT, TOKEN, 0.1, 'base');
    assert.equal(r.venue, 'curve·obs');
    assert.ok(r.gotTokens > 0, 'the tokens arrived');
    // ⚠️ TWO TRANSACTIONS FOR ONE TAP is a fact the receipt has to carry.
    assert.ok(r.curveVia.quote, 'the leg that got us there is on the receipt');
    assert.equal(String(r.curveVia.quote.token).toLowerCase(), QUOTE);
    assert.ok(r.curveVia.quote.raw > 0n);
  } finally { restore(); }
});

test("⚠️ …and the quote token is READ off the chain, never guessed", async () => {
  // A pad whose samples disagree about what it charges in is a pad we do not
  // understand — two pads behind one selector, or a router in the middle.
  // Picking the commonest would put a guessed token address on a money path.
  const chain = quoteChain();
  let n = 0;
  chain.getTransactionReceipt = async () => ({ logs: [{
    address: (n++ % 2) ? QUOTE : '0x7777777777777777777777777777777777777777',
    topics: [TRANSFER, topic(WALLET), topic(CURVE)], data: '0x' + num(E17),
  }] });
  const restore = withStubs(chain, { padOk: false });
  try {
    await assert.rejects(() => core.buy(CHAT, TOKEN, 0.1, 'base'), /launchpad curve|nothing was sent/);
  } finally { restore(); }
});

/*
 * ⚠️ A REFUSAL THE OPERATOR CANNOT READ IS THE SAME AS NO REFUSAL.
 *
 * The CARD path has logged `[curve] card … unroutable: <why>` since it was
 * written; the TRADE path — the one that renders "Stage that refused: …" to the
 * person who pressed Buy — logged nothing. Four rounds of "masih sama aja" each
 * began from a screenshot of a Telegram message and nothing else.
 *
 * ⚠️ THE FIRST CUT PUT THE LOG INSIDE `_curveIface`, AND THIS TEST IS WHY IT
 * MOVED. `why` is set by the interface read, then possibly REPLACED by the price
 * gate and again by the build — so a log at the interface covered only the stage
 * that happens to be reported today, and the refusal below (the price gate, on a
 * perfectly readable interface) produced no line at all. The log belongs at the
 * convergence, which is the single throw both stages reach.
 *
 * ELAPSED is what is asserted, not the wording: ~12000ms is the bound tripping —
 * something walked — and a few hundred is a real refusal with a real reason.
 */
function capture() {
  const real = console.log;
  const lines = [];
  console.log = (...a) => { lines.push(a.join(' ')); };
  return { lines, restore: () => { console.log = real; } };
}

test('⚠️ a curve refusal reaches pm2 with its reason AND how long it took', async () => {
  const chain = stubChain();
  for (const lg of await chain.getLogs({ address: TOKEN })) lg.data = '0x' + num(0n);
  const restore = withStubs(chain, { padOk: false });
  const cap = capture();
  try {
    await core.buy(CHAT, TOKEN, 0.1, 'base').catch(() => {});
  } finally { cap.restore(); restore(); }

  // The interface here reads FINE — it is the price gate that refuses. A log
  // wired to the interface stage alone finds nothing.
  const line = cap.lines.find((l) => l.startsWith('[curve] buy '));
  assert.ok(line, `the buy refusal must land in the log — got:\n${cap.lines.join('\n')}`);
  assert.match(line, /base\/0x[0-9a-f]{8}… refused after \d+ms: /, 'chain, token, and the elapsed that names the stage');
  assert.match(line, /could not be reached from this server/, 'and the reason itself, not a shrug');
});

test('…and a discovery that WORKED writes nothing, or the line that matters scrolls away', async () => {
  // This runs on every paste and every warm, into a log the snipe loop is
  // already filling — the exact way the card path's own line got lost.
  const chain = stubChain();
  const restore = withStubs(chain);
  const cap = capture();
  try {
    const realCall = chain.call.bind(chain);
    let bought = false;
    chain.call = async (tx) => {
      if (String(tx.data || '').startsWith('0x70a08231') && bought) return '0x' + num(1000n * E18);
      return realCall(tx);
    };
    const origWait = chain.waitForTransaction.bind(chain);
    chain.waitForTransaction = async (...a) => { bought = true; return origWait(...a); };
    const r = await core.buy(CHAT, TOKEN, 0.1, 'base');
    assert.equal(r.venue, 'curve·obs', 'precondition: this buy actually filled');
  } finally { cap.restore(); restore(); }

  assert.equal(cap.lines.filter((l) => l.startsWith('[curve] buy ')).length, 0);
});
