'use strict';
/*
 * AN INDEXED TOKEN CAN STILL BE ON A BONDING CURVE — the card path.
 *
 * The live report (2026-08-28): the operator pasted a Pons token on Robinhood
 * and the card showed DexScreener's own numbers ($4.2K cap, $4.3K liquidity)
 * over "This token's liquidity is on Pons v2, which Dexvra can't route through
 * yet" — with no Buy button. `core.buy` could fill it: its curve leg runs for
 * any token with no AMM route, indexed or not. The CARD was the gate that never
 * asked — `tokenSnapshot`'s indexed branch returned `routable: false`
 * unconditionally, so the one surface a user can press Buy from was the one
 * place the curve reader was never consulted. Being indexed made a token LESS
 * buyable than being invisible, because DexScreener started indexing these
 * pads' curves as ordinary pairs.
 *
 * The assertion that matters is a POSITIVE (this file's sibling,
 * curveBuyPath.test.js, states why: a wiring that does nothing refuses
 * beautifully, and a refusal-only suite passes on it).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { ethers } = require('ethers');

const CURVE = '0xc0000000000000000000000000000000000000c0';
const E17 = 10n ** 17n;
const E18 = 10n ** 18n;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BUYER = '0x00000000000000000000000000000000000b0b0b';

const w64 = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
const num = (n) => w64(BigInt(n).toString(16));
const addrWord = (a) => w64(String(a).slice(2));
const topic = (a) => '0x' + addrWord(a);

process.env.SKIP_DOTENV = '1';
process.env.WALLET_SECRET = 'c'.repeat(48);
process.env.DATA_DIR = path.join(os.tmpdir(), 'dexvra-curvecard-' + process.pid);
process.env.TRADEBOT_TOKEN = 'x';
process.env.ENABLED_CHAINS = 'base,robinhood';   // robinhood too: the pad-factory sibling source is keyed on it
process.env.BASE_RPC = 'http://127.0.0.1:1';
// The background warm's pace floor is 30s; the pace map is per token, so each
// test below uses its own token address rather than fighting the floor.
const core = require('./core');
const curveTrade = require('./curveTrade');

// Full-width hashes: core's _curveTradeHashes refuses anything that is not a
// real 32-byte transaction hash, exactly so an indexer cannot hand it junk.
const H1 = '0x' + '11'.repeat(32);
const H2 = '0x' + '22'.repeat(32);
// The pad's curve bytecode — shared across its launches, which is what the
// learned-shape transfer verifies before it applies.
const PAD_CODE = '0x60806040cafebabe' + 'cd'.repeat(64);

/** A chain where the token's ONLY market is its curve: no V2 pair, no V3 pool,
 *  two real buys through the curve — none when `quiet`, and none VISIBLE TO an
 *  ADDRESS-filtered getLogs when `capped` (the node silently empties every
 *  range, the live Robinhood shape — the trades exist only behind their
 *  receipts). `topicLogs` makes topic-only asks answer, the measured quirk of
 *  that same node: it served the preflight's topic-filtered sweeps while
 *  emptying the address-filtered ones. */
function stubChain(token, { quiet = false, capped = false, topicLogs = false } = {}) {
  const logs = quiet ? [] : [
    { transactionHash: H1, blockNumber: 10, topics: [TRANSFER, topic(CURVE), topic(BUYER)], data: '0x' + num(1000n * E18) },
    { transactionHash: H2, blockNumber: 11, topics: [TRANSFER, topic(CURVE), topic(BUYER)], data: '0x' + num(2000n * E18) },
  ];
  const txs = {
    [H1]: { to: CURVE, from: BUYER, value: E17, data: '0xaabbccdd' + addrWord(token) + addrWord(BUYER) + num(1000n * E18) },
    [H2]: { to: CURVE, from: BUYER, value: 2n * E17, data: '0xaabbccdd' + addrWord(token) + addrWord(BUYER) + num(2000n * E18) },
  };
  const receipts = {
    [H1]: { logs: [{ address: token, topics: [TRANSFER, topic(CURVE), topic(BUYER)], data: '0x' + num(1000n * E18) }] },
    [H2]: { logs: [{ address: token, topics: [TRANSFER, topic(CURVE), topic(BUYER)], data: '0x' + num(2000n * E18) }] },
  };
  const state = { getLogsCalls: 0 };
  return {
    state,
    async getBlockNumber() { return 5000; },
    async getLogs(f) {
      state.getLogsCalls++;
      if (quiet) return [];
      if (f && f.address) {
        if (capped) return [];   // answered, empty — never an error
        return String(f.address).toLowerCase() === token.toLowerCase() ? logs : [];
      }
      // A topic-only ask — the seed's shape. Served only when the stub models
      // the node quirk, and only for the curve's own topic.
      if (topicLogs && JSON.stringify((f && f.topics) || []).toLowerCase().includes(addrWord(CURVE).toLowerCase())) return logs;
      return [];
    },
    async getTransaction(h) { return txs[h] || null; },
    async getTransactionReceipt(h) { return receipts[h] || null; },
    async getCode(a) { return String(a).toLowerCase() === CURVE.toLowerCase() ? PAD_CODE : '0x'; },
    async call(tx) {
      const sel = String(tx.data || '').slice(0, 10);
      if (sel === '0x70a08231') return '0x' + num(0n);                        // balanceOf
      if (sel === '0x313ce567') return '0x' + num(18n);                       // decimals
      if (sel === '0x18160ddd') return '0x' + num(1_000_000_000n * E18);      // totalSupply
      if (sel === '0xe6a43905') return '0x' + addrWord(ethers.ZeroAddress);   // getPair → none
      throw new Error('no data');
    },
    async estimateGas() { return 210000n; },
    async getBalance() { return 5n * E18; },
    async getFeeData() { return { gasPrice: ethers.parseUnits('0.02', 'gwei'), maxFeePerGas: null, maxPriorityFeePerGas: null }; },
    async getBlock() { return { number: 5000, baseFeePerGas: ethers.parseUnits('0.01', 'gwei') }; },
    getNetwork: async () => ({ chainId: 8453n }),
    _detectNetwork: async () => ({ chainId: 8453n }),
    resolveName: (n) => n,
  };
}

/** Stub every seam tokenSnapshot reaches: the chain, the v4 probes, and — for
 *  the "indexed" half of the report — DexScreener answering with a pair, plus
 *  GeckoTerminal's trades endpoint when `gtTrades` names the hashes. */
function withStubs(chain, { indexed = true, gtTrades = null, dsChain = 'base' } = {}) {
  const realProv = core._deps.providerFor;
  const realFetch = global.fetch;
  const realPrice = core.v4.price;
  const realLive = core.v4.canSwapLive;
  const realPool = core.v4.bestPool;
  const lp = require('./launchpads');
  const realRec = lp.record;

  core._deps.providerFor = () => chain;
  core.v4.price = async () => null;
  core.v4.canSwapLive = async () => false;
  core.v4.bestPool = async () => null;
  lp.record = async () => ({ record: null, ok: false, why: 'pons: ENOTFOUND', tried: [] });
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.dexscreener.com/latest/dex/tokens/')) {
      const pairs = indexed ? [{
        chainId: dsChain, priceUsd: '0.0000421', marketCap: 4209,
        liquidity: { usd: 4370 }, volume: { h24: 320 },
        dexId: 'pons', labels: ['v2'], pairAddress: CURVE,
        baseToken: { name: 'Test', symbol: 'TEST' },
      }] : [];
      return { ok: true, async json() { return { pairs }; } };
    }
    if (u.includes('geckoterminal.com') && u.includes('/trades')) {
      const data = (gtTrades || []).map((h) => ({ attributes: { tx_hash: h } }));
      return { ok: true, async json() { return { data }; } };
    }
    if (u.includes('coinbase')) return { ok: true, async json() { return { data: { amount: '2000' } }; } };
    return { ok: true, async json() { return {}; } };
  };
  core._clearReadCaches();
  curveTrade._reset();
  curveTrade._resetShapes();
  return () => {
    core._deps.providerFor = realProv;
    core.v4.price = realPrice;
    core.v4.canSwapLive = realLive;
    core.v4.bestPool = realPool;
    lp.record = realRec;
    global.fetch = realFetch;
    core._clearReadCaches();
    curveTrade._reset();
    curveTrade._resetShapes();
  };
}

test('⚠️ an INDEXED bonding-curve token gets a routable snapshot — the Buy button exists', async () => {
  const token = '0x3f8c5ac4c9b9391c99f4796e56228852a6796ddf';
  const chain = stubChain(token);
  const restore = withStubs(chain, { indexed: true });
  try {
    const snap = await core.tokenSnapshot(token, 'base');
    assert.ok(snap, 'the token snapshots');
    // THE POSITIVE: telegram.js gates every Buy button on exactly this field
    // (`info.routable === false` → unroutableCard, no Buy). false here is the
    // reported card, verbatim.
    assert.equal(snap.routable, true, 'a readable curve must make the card offer Buy');
    assert.equal(snap.dexVenue, 'curve');
    assert.equal(snap.onCurve, true);
    assert.equal(String(snap.curve).toLowerCase(), CURVE);
    assert.equal(snap.graduated, false, 'a curve token is not "◆ DEX"');
    // The indexer's numbers are facts and ride along — the card the operator
    // screenshotted showed them, and the fix must not trade them for the route.
    assert.equal(snap.priceUsd, 0.0000421);
    assert.equal(snap.mcapUsd, 4209);
    assert.equal(snap.liquidityUsd, 4370);
    assert.equal(snap.sym, 'TEST');
  } finally { restore(); }
});

test('⚠️ the reported state end-to-end: the node silently caps every getLogs, the indexer seeds the route', async () => {
  // $TEST at 17:14, 2026-08-28: DexScreener pricing the token on the very card
  // that said "can't route through yet". Its last trades were hours old — past
  // every window the range-capped node will serve — so the walk read "no
  // trades found" for ever. The indexer's trade list is the way in: hashes
  // only, receipts from the chain itself.
  const token = '0x4444444444444444444444444444444444444444';
  const chain = stubChain(token, { capped: true });
  const restore = withStubs(chain, { indexed: true, gtTrades: [H2, H1] });
  try {
    const snap = await core.tokenSnapshot(token, 'base');
    assert.ok(snap, 'the token snapshots');
    assert.equal(snap.routable, true, 'the seeded discovery must light the Buy button');
    assert.equal(snap.dexVenue, 'curve');
    assert.equal(String(snap.curve).toLowerCase(), CURVE);
    assert.equal(snap.priceUsd, 0.0000421, "the indexer's numbers still ride along");
  } finally { restore(); }
});

test('⚠️ …and with NO GeckoTerminal at all, the CHAIN itself seeds: the curve\'s topic-filtered legs', async () => {
  // The box's measured quirk: wide ADDRESS-filtered getLogs silently empty,
  // while topic-filtered asks answer (it is how the preflight found the real
  // Pons factory). The seed's first source rides that — the curve address the
  // indexer names, as a Transfer topic — so the route lights up with GT
  // knowing nothing about the pool.
  const token = '0x5555555555555555555555555555555555555555';
  const chain = stubChain(token, { capped: true, topicLogs: true });
  const restore = withStubs(chain, { indexed: true, gtTrades: [] });
  try {
    const snap = await core.tokenSnapshot(token, 'base');
    assert.ok(snap, 'the token snapshots');
    assert.equal(snap.routable, true, 'the chain-native seed must light the Buy button without GT');
    assert.equal(snap.dexVenue, 'curve');
    assert.equal(String(snap.curve).toLowerCase(), CURVE);
  } finally { restore(); }
});

test('⚠️ "ini token kan belum bonding" — a FRESH launch with zero history gets a Buy button off a taught sibling', async () => {
  // The reported state, end to end: a token minutes old, 0% to graduation,
  // nothing to decode anywhere — and the pad was already taught by any traded
  // sibling. Byte-identity carries the interface over; the card lights up for
  // the FIRST buyer, which is what a launch snipe is.
  const fresh = '0x1f94e478675d37f15704a48756b5fdf969e39845';
  const sib = '0x6666666666666666666666666666666666666666';
  const chain = stubChain(fresh, { quiet: true });           // the fresh token: nothing, anywhere
  const restore = withStubs(chain, { indexed: true, gtTrades: [] });
  try {
    // Any traded sibling teaches the pad — the same discovery the sibling's own
    // card/buy already runs.
    const sibLogs = [
      { transactionHash: H1, blockNumber: 10, topics: [TRANSFER, topic(CURVE), topic(BUYER)], data: '0x' + num(1000n * E18) },
      { transactionHash: H2, blockNumber: 11, topics: [TRANSFER, topic(CURVE), topic(BUYER)], data: '0x' + num(2000n * E18) },
    ];
    const sibTxs = {
      [H1]: { to: CURVE, from: BUYER, value: E17, data: '0xaabbccdd' + addrWord(sib) + addrWord(BUYER) + num(1000n * E18) },
      [H2]: { to: CURVE, from: BUYER, value: 2n * E17, data: '0xaabbccdd' + addrWord(sib) + addrWord(BUYER) + num(2000n * E18) },
    };
    const sibChain = {
      async getBlockNumber() { return 5000; },
      async getLogs(f) { return String(f && f.address || '').toLowerCase() === sib ? sibLogs : []; },
      async getTransaction(h) { return sibTxs[h] || null; },
      async getCode(a) { return String(a).toLowerCase() === CURVE.toLowerCase() ? PAD_CODE : '0x'; },
    };
    const taught = await curveTrade.ifaceFor(sibChain, 'base', sib);
    assert.equal(taught.ok, true, taught.why);

    const snap = await core.tokenSnapshot(fresh, 'base');
    assert.ok(snap, 'the fresh token snapshots');
    assert.equal(snap.routable, true, 'the taught shape must light the Buy button for the FIRST buyer');
    assert.equal(snap.dexVenue, 'curve');
    assert.equal(String(snap.curve).toLowerCase(), CURVE);
  } finally { restore(); }
});

test('⚠️ the 18:09 card, end to end: nothing taught, GT carries no pad — the FACTORY\'s launches teach it', async () => {
  /*
   * The reported state verbatim: "Stage that refused: no trades found for this
   * token in the last 400000 blocks … nothing to read its interface from yet".
   * The self-teach had asked GeckoTerminal for the pad's other pools, and GT
   * need not carry the pad at all — so nothing had taught it and nothing could,
   * while the bot's own snipe loop had already seen 227 launches from the
   * factory. Bytecode identity picks the sibling curve out of a launch log
   * whose ABI is unknown; the sibling's own legs name its token.
   */
  const fresh = '0x1f94e478675d37f15704a48756b5fdf969e39845';
  const sibTok = '0x7777777777777777777777777777777777777777';
  const SIBCURVE = '0xc7000000000000000000000000000000000000c7';
  const FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';   // the measured Pons deployment
  const TOPIC0 = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';
  const SH1 = '0x' + '33'.repeat(32);
  const SH2 = '0x' + '44'.repeat(32);
  const w = (a) => '0x' + '0'.repeat(24) + String(a).slice(2);
  const sibLegs = [
    { transactionHash: SH1, blockNumber: 20, address: sibTok, topics: [TRANSFER, topic(SIBCURVE), topic(BUYER)], data: '0x' + num(1000n * E18) },
    { transactionHash: SH2, blockNumber: 21, address: sibTok, topics: [TRANSFER, topic(SIBCURVE), topic(BUYER)], data: '0x' + num(2000n * E18) },
  ];
  const sibTxs = {
    [SH1]: { to: SIBCURVE, from: BUYER, value: E17, data: '0xaabbccdd' + addrWord(sibTok) + addrWord(BUYER) + num(1000n * E18) },
    [SH2]: { to: SIBCURVE, from: BUYER, value: 2n * E17, data: '0xaabbccdd' + addrWord(sibTok) + addrWord(BUYER) + num(2000n * E18) },
  };
  const chain = {
    async getBlockNumber() { return 5000; },
    async getLogs(f) {
      // The factory's launch announcement — an ABI nobody has, naming several
      // addresses; only bytecode tells which one is the curve.
      if (String(f && f.address || '').toLowerCase() === FACTORY) {
        return [{ address: FACTORY, blockNumber: 19, topics: [TOPIC0, w(sibTok)], data: (w(BUYER) + w(SIBCURVE).slice(2)).replace('0x0x', '0x') }];
      }
      if (f && f.address) return [];                    // the fresh token: nothing, anywhere
      const t = JSON.stringify((f && f.topics) || []).toLowerCase();
      if (t.includes(addrWord(SIBCURVE).toLowerCase())) return sibLegs;   // the sibling curve's own legs
      return [];
    },
    async getTransaction(h) { return sibTxs[h] || null; },
    async getTransactionReceipt(h) { return sibTxs[h] ? { logs: sibLegs.filter((l) => l.transactionHash === h) } : null; },
    async getCode(a) {
      const x = String(a).toLowerCase();
      if (x === CURVE.toLowerCase() || x === SIBCURVE) return PAD_CODE;   // same pad → same code
      if (x === FACTORY) return '0x6080';
      return '0x';
    },
    async call() { throw new Error('no data'); },
    async estimateGas() { return 210000n; },
    async getBalance() { return 5n * E18; },
    async getFeeData() { return { gasPrice: ethers.parseUnits('0.02', 'gwei'), maxFeePerGas: null, maxPriorityFeePerGas: null }; },
    async getBlock() { return { number: 5000, baseFeePerGas: ethers.parseUnits('0.01', 'gwei') }; },
    getNetwork: async () => ({ chainId: 8453n }),
    _detectNetwork: async () => ({ chainId: 8453n }),
    resolveName: (n) => n,
  };
  // The chain must be robinhood for the factory list to apply — that is where
  // the pad lives, and announcersFor is keyed on it.
  const restore = withStubs(chain, { indexed: true, gtTrades: [], dsChain: 'robinhood' });
  try {
    const snap = await core.tokenSnapshot(fresh, 'robinhood');
    assert.ok(snap, 'the fresh token snapshots');
    assert.equal(snap.routable, true, `the factory's own launches must teach the pad: ${snap.curveWhy || ''}`);
    assert.equal(snap.dexVenue, 'curve');
    assert.equal(String(snap.curve).toLowerCase(), CURVE, "and the route aims at OUR token's curve");
  } finally { restore(); }
});

test('an indexed token whose curve cannot be read keeps the honest old card, exactly', async () => {
  const token = '0x1111111111111111111111111111111111111111';
  const chain = stubChain(token, { quiet: true });   // no trades → nothing to read an interface from
  const restore = withStubs(chain, { indexed: true });
  try {
    const snap = await core.tokenSnapshot(token, 'base');
    assert.ok(snap);
    assert.equal(snap.routable, false, 'no readable route may not claim one');
    assert.equal(snap.dexVenue, 'ext');
    assert.equal(snap.graduated, true);
    assert.match(String(snap.extVenue), /Pons v2/i, 'the venue is still named for the warning');
    assert.equal(snap.priceUsd, 0.0000421);
  } finally { restore(); }
});

test('⚠️ canTradeNow WARMS the curve cache in the background — a snipe fires without a manual first buy', async () => {
  const token = '0x2222222222222222222222222222222222222222';
  const chain = stubChain(token);
  const restore = withStubs(chain, { indexed: false });
  try {
    // The probe itself answers from the cache — cold, so false, and it must
    // answer NOW: the callers are the CA snipe and the retry ring on a timer.
    assert.equal(await core.canTradeNow(token, 'base'), false, 'a cold cache is "we have not looked"');
    // …but the probe kicked a bounded discovery off its own latency path. Once
    // that lands, the NEXT poll answers yes — which is what turns "bought at
    // graduation" into "bought within a poll of the first observed trade".
    let hit = null;
    for (let i = 0; i < 200 && !hit; i++) {
      await new Promise((r) => setTimeout(r, 10));
      hit = curveTrade.cached('base', token);
    }
    assert.ok(hit && hit.ok && hit.buy, 'the background warm filled the cache');
    assert.equal(await core.canTradeNow(token, 'base'), true, 'the next poll fires the snipe');
  } finally { restore(); }
});

test('the warm is PACED — a second cold poll inside the window costs no second discovery', async () => {
  const token = '0x3333333333333333333333333333333333333333';
  const chain = stubChain(token, { quiet: true });   // discovery finds nothing → the cache records a miss
  const restore = withStubs(chain, { indexed: false });
  try {
    assert.equal(await core.canTradeNow(token, 'base'), false);
    let miss = null;
    for (let i = 0; i < 200 && !miss; i++) {
      await new Promise((r) => setTimeout(r, 10));
      miss = curveTrade.cached('base', token);
    }
    assert.ok(miss && !miss.ok, 'the miss is remembered');
    const calls = chain.state.getLogsCalls;
    // The ring polls every few seconds; each poll may not buy a discovery.
    await core.canTradeNow(token, 'base');
    await core.canTradeNow(token, 'base');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(chain.state.getLogsCalls, calls, 'polls inside the pace window spend no RPC on rediscovery');
  } finally { restore(); }
});
