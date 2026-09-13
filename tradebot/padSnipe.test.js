'use strict';
/*
 * padSnipe.test.js — the launchpad snipe loop and the launch retry ring, offline.
 *
 * The defect this file pins: the snipe could see a launch and still never buy
 * it, in two independent ways.
 *
 *   1. Discovery was one launchpad per chain. A token born on any pad the event
 *      scans do not cover was invisible until it migrated — hours after the
 *      window anybody snipes in. padSnipeCycle closes that with the registry's
 *      feeds, for every chain any pad covers.
 *   2. A launch seen BEFORE its market opened was dropped for ever. The buy
 *      failed with "no route", the cursor had already advanced, the seen-set had
 *      already marked it — and a comment claimed it would be "retried while it's
 *      fresh" over code that could not. That is precisely the dev-wallet snipe's
 *      normal case: it sees the mint before the dev opens the pool, so the
 *      feature "worked" and never bought anything. The retry ring is the fix,
 *      and the tests here drive a launch through TOO-EARLY → RING → FILLED.
 *
 * Everything runs against stubbed core/safety/launchpads — no network, no RPC.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.LAUNCH_RETRY_MS = process.env.LAUNCH_RETRY_MS || '180000';
// A small per-cycle budget so the overflow paths are exercisable with a
// handful of launches (the constant is read once, at require time).
process.env.DEX_SNIPE_MAX_TOKENS = '3';

// ---- stubs injected before watchers.js requires them ----
const USERS = [];
let BUY = async () => ({ sym: 'PAD', gotTokens: 100, spentEth: 0.05, native: 'ETH', hash: '0xhash', gotRaw: '100' });
let CAN_TRADE = async () => true;
let BAL_OR_NULL = async () => 10n ** 20n;   // plenty; a test sets null for "could not read"
let SAFETY = null;   // set to an async fn to make the safety gate real for one test
let FEEDS = {};   // chainKey -> { byPad: { key: {ok, why, items} }, ok, why }
const buys = [];
const notes = [];

// The CA-snipe hand-off an unbuyable dev launch takes. Recorded rather than
// mocked away: the point of the test is that the launch is FOLLOWED, and a stub
// that silently accepted anything would pass on code that queued nothing.
const caArmed = [];
const coreStub = {
  addSnipeTarget: (chatId, spec) => { caArmed.push({ chatId, ...spec }); return spec; },
  armedSnipeTargets: () => caArmed,
  CFG: { gasBufferEth: '0.001', solGasBuffer: '0.01' },
  chains: {
    isSvm: (k) => k === 'solana',
    isEnabled: () => true,
    enabledChains: () => [{ key: 'robinhood' }, { key: 'bsc' }, { key: 'solana' }],
  },
  chainOf: (k) => ({ key: k, name: k, emoji: '◆', native: k === 'solana' ? 'SOL' : 'ETH', explorer: 'https://x' }),
  allUsers: () => USERS,
  walletList: (u) => u.wallets || [],
  activeWallet: (u) => (u.wallets || [])[0] || null,
  activeAddress: () => '0xME',
  walletAddress: () => 'SoMeAddr',
  ethBalance: async () => 10n ** 20n,   // plenty
  ethBalanceOrNull: async (...a) => BAL_OR_NULL(...a),   // what _canAfford actually reads
  gasBufferWei: () => 10n ** 15n,
  saveStoreNow: () => {},
  saveStore: () => {},
  copyHoldingAdd: () => {},
  canTradeNow: async (ca, chain) => CAN_TRADE(ca, chain),
  buy: async (chatId, token, amt, chain, wid, opts) => { const r = await BUY(chatId, token, amt, chain, wid, opts); buys.push({ chatId, token, amt, chain, wid }); return r; },
};
let SAFE = { supported: false, level: 'ok' };
const safetyStub = {
  supported: () => SAFE.supported || !!SAFETY,
  tokenSecurity: async (...a) => (SAFETY ? SAFETY(...a) : {}),
  verdict: () => ({ level: SAFE.level || 'ok' }),
};
const solanaStub = { isSolAddress: () => true, WSOL_MINT: 'W', solToLamports: (n) => BigInt(Math.round(Number(n) * 1e9)), pumpfunNewX: async () => ({ ok: true, coins: [] }) };
const lpStub = {
  probes: () => [],   // upstreams.js reads the probe list at require time
  enabled: () => [],
  covers: (k) => k !== 'nowhere',
  padsFor: (chain) => {
    // Two pads with feeds on Robinhood (pons + a second), one on bsc, and on
    // Solana both pump.fun (which the loop must SKIP — it has its own poller)
    // and a second pad it must poll.
    if (chain === 'robinhood') return [{ key: 'pons', feedPath: '/f' }, { key: 'other', feedPath: '/f' }];
    if (chain === 'bsc') return [{ key: 'fourmeme', feedPath: '/f' }];
    if (chain === 'solana') return [{ key: 'pumpfun', feedPath: '/f' }, { key: 'letsbonk', feedPath: '/f' }];
    return [];
  },
  newLaunches: async (chain, n, opts) => {
    const r = FEEDS[chain] || { byPad: {}, ok: false, why: 'no stub feed' };
    // The loop must ask ONLY for the pads it filtered to — echo that back so a
    // test can assert pump.fun was never requested.
    r._asked = (opts && opts.only) || [];
    return r;
  },
};
const dir = __dirname;
const inject = (rel, exp) => { const p = require.resolve(path.join(dir, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
inject('core', coreStub);
inject('safety', safetyStub);
inject('goplus', {});
inject('solana', solanaStub);
inject('launchpads', lpStub);

const w = require(path.join(dir, 'watchers'));
w.setNotifier((chatId, text, kb, kind) => notes.push({ chatId, text, kind }));
const T = w._test;
T._caArmed = caArmed;

let _uid = 0;   // NOT USERS.length: two users built before either is pushed would share an id
const armUser = (chain, amt = 0.05) => ({ chatId: 100 + _uid++, snipe: { chains: { [chain]: true }, ethAmount: amt }, wallets: [{ id: 'w1', address: '0xME' }] });
const devUser = (chain, dev) => ({ chatId: 100 + _uid++, wallets: [{ id: 'w1', address: '0xME' }], copy: { on: true, targets: [{ id: 'cp' + _uid, address: dev, chain, mode: 'launches', buyEth: '0.02', maxEth: '1', spentEth: 0, bought: {} }] } });

function reset() {
  USERS.length = 0; buys.length = 0; notes.length = 0;
  BUY = async () => ({ sym: 'PAD', gotTokens: 100, spentEth: 0.05, native: 'ETH', hash: '0xhash', gotRaw: '100' });
  CAN_TRADE = async () => true;
  BAL_OR_NULL = async () => 10n ** 20n;
  SAFETY = null;
  FEEDS = {};
  T._launchRetry.clear();
  T._padCursors.clear();
  // The feed-bench map and the per-pad stats persist across tests by design
  // (they are process state in the bot) — and a bench or a fail-count left
  // behind by the backoff test reads as "the pad loop is broken" in every
  // later test. Stated here, not inherited.
  T._padFeedFail.clear();
  // …and the Pons raw-mismatch probe, for the same reason: it is rate-limited
  // to one look per 10 min, so a test that consumed it leaves the next reading
  // a null ponsErr — which looks exactly like the diagnosis being broken.
  T._ponsResetProbe();
  caArmed.length = 0;
  for (const k of Object.keys(T._padSnipeStats.pads)) delete T._padSnipeStats.pads[k];
  T._padSnipeStats.lastErr = null; T._padSnipeStats.lastErrAt = null;
}
const feedOk = (items) => ({ ok: true, why: '', items });
const item = (addr, over) => Object.assign({ address: addr, symbol: 'PAD', name: 'Pad Token', creator: '', createdAt: Date.now(), graduated: false, pad: 'pons' }, over);

// ── discovery ────────────────────────────────────────────────────────────────

test('a launch on a NON-default launchpad is seen and bought', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  const t0 = Date.now() - 5000;
  // First look seeds only — the auto-raid cursor's rule.
  FEEDS.robinhood = { ok: true, byPad: { pons: feedOk([item('0xAAA1', { createdAt: t0 })]), other: feedOk([]) } };
  await T.padSnipeCycle();
  assert.equal(buys.length, 0, 'the first look must seed, not snipe');
  // Second look: a NEW launch past the cursor fires.
  FEEDS.robinhood = { ok: true, byPad: { pons: feedOk([item('0xAAA2', { createdAt: t0 + 1000 }), item('0xAAA1', { createdAt: t0 })]), other: feedOk([]) } };
  await T.padSnipeCycle();
  assert.equal(buys.length, 1, 'the new launch was not bought');
  assert.equal(buys[0].token, '0xAAA2');
  assert.equal(buys[0].chain, 'robinhood');
  assert.match(notes[0].text, /Auto-Snipe bought/);
});

test('pump.fun is NEVER polled from the pad loop — it has its own poller and cursor', async () => {
  reset();
  USERS.push(armUser('solana'));
  FEEDS.solana = { ok: true, byPad: { letsbonk: feedOk([]) } };
  await T.padSnipeCycle();
  assert.ok(FEEDS.solana._asked.includes('letsbonk'));
  assert.ok(!FEEDS.solana._asked.includes('pumpfun'), 'two pollers, two cursors, one feed — the exact "one repo, two answers" defect');
});

test('nobody armed and nobody following → no feed request at all', async () => {
  reset();
  let asked = 0;
  FEEDS.robinhood = { ok: true, byPad: { pons: feedOk([]) } };
  const realNL = lpStub.newLaunches;
  lpStub.newLaunches = async (...a) => { asked++; return realNL(...a); };
  try { await T.padSnipeCycle(); } finally { lpStub.newLaunches = realNL; }
  assert.equal(asked, 0, 'an idle bot polls launchpad hosts for nobody');
});

test('a launch that already GRADUATED is not sniped from a pad feed', async () => {
  reset();
  USERS.push(armUser('bsc'));
  const t0 = Date.now() - 5000;
  FEEDS.bsc = { ok: true, byPad: { fourmeme: feedOk([item('0xB1', { createdAt: t0, pad: 'fourmeme' })]) } };
  await T.padSnipeCycle();   // seed
  FEEDS.bsc = { ok: true, byPad: { fourmeme: feedOk([item('0xB2', { createdAt: t0 + 1000, graduated: true, pad: 'fourmeme' })]) } };
  await T.padSnipeCycle();
  assert.equal(buys.length, 0, 'a migrated token is the DEX scan\'s job, not a launch');
});

test('one pad\'s bad clock cannot silence another pad — cursors are per pad', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  const t0 = Date.now() - 60000;
  // Seed both pads; `other` reports a timestamp far in the future of `pons`.
  FEEDS.robinhood = { ok: true, byPad: {
    pons: feedOk([item('0xC1', { createdAt: t0 })]),
    other: feedOk([item('0xC2', { createdAt: t0 + 50000, pad: 'other' })]),
  } };
  await T.padSnipeCycle();
  // pons launches something newer than ITS cursor but older than other's.
  FEEDS.robinhood = { ok: true, byPad: {
    pons: feedOk([item('0xC3', { createdAt: t0 + 2000 })]),
    other: feedOk([item('0xC2', { createdAt: t0 + 50000, pad: 'other' })]),
  } };
  await T.padSnipeCycle();
  assert.equal(buys.length, 1, 'the shared-cursor defect is back: a pad with a fast clock silenced its neighbour');
  assert.equal(buys[0].token, '0xC3');
});

test('a feed that answered and a feed that did not stay different facts', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  FEEDS.robinhood = { ok: true, byPad: {
    pons: feedOk([]),
    other: { ok: false, why: 'other: answered 500', items: [] },
  } };
  await T.padSnipeCycle();
  const stats = T._padSnipeStats;
  assert.ok(stats.pads['robinhood:pons'].ok >= 1, 'an answered-empty feed must count as OK');
  assert.equal(stats.pads['robinhood:pons'].why, null);
  assert.ok(stats.pads['robinhood:other'].fail >= 1);
  assert.match(stats.pads['robinhood:other'].why, /500/);
});

test('a feed path that keeps erroring is backed off, and the reason is kept', async () => {
  reset();
  USERS.push(armUser('bsc'));
  FEEDS.bsc = { ok: true, byPad: { fourmeme: { ok: false, why: 'four.meme: answered 404', items: [] } } };
  for (let i = 0; i < 3; i++) await T.padSnipeCycle();
  // Benched now: the next cycle must not ask for it.
  FEEDS.bsc = { ok: true, byPad: { fourmeme: feedOk([]) } };
  await T.padSnipeCycle();
  assert.ok(!FEEDS.bsc._asked || !FEEDS.bsc._asked.includes('fourmeme'), 'a 404ing feed path is re-asked every tick for ever');
  assert.match(T._padSnipeStats.pads['bsc:fourmeme'].why, /404/, 'the bench reason was thrown away');
});

// ── the retry ring: too early is not missed ──────────────────────────────────

test('a launch seen before its market opens is parked, then bought when it opens', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  CAN_TRADE = async () => false;   // pad-discovered launches are gated
  const t0 = Date.now() - 5000;
  FEEDS.robinhood = { ok: true, byPad: { pons: feedOk([item('0xD1', { createdAt: t0 })]), other: feedOk([]) } };
  await T.padSnipeCycle();   // seed
  FEEDS.robinhood = { ok: true, byPad: { pons: feedOk([item('0xD2', { createdAt: t0 + 1000 })]), other: feedOk([]) } };
  await T.padSnipeCycle();
  assert.equal(buys.length, 0, 'a gated launch must not be bought before it is tradeable');
  assert.equal(T._launchRetry.size, 1, 'the too-early launch was dropped instead of parked');
  // Market still closed: the ring probes, buys nothing, keeps the entry.
  await T.launchRetryCycle();
  assert.equal(buys.length, 0);
  assert.equal(T._launchRetry.size, 1);
  // Market opens: the ring fires the buy.
  CAN_TRADE = async () => true;
  await T.launchRetryCycle();
  assert.equal(buys.length, 1, 'the launch was never retried — the "retried while fresh" comment over code that could not');
  assert.equal(buys[0].token, '0xD2');
  assert.equal(T._launchRetry.size, 0, 'a fired entry must leave the ring');
});

test('an event-scan buy that fails with "no route" lands in the ring — not in a DM, not on the floor', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  BUY = async () => { throw new Error('no route / no liquidity for this token on Jupiter'); };
  await T._fireLaunch('robinhood', { token: '0xE1', sym: 'E', creator: '', at: Date.now() }, { armed: USERS, devFollowers: [] });
  assert.equal(T._launchRetry.size, 1, 'a too-early failure was dropped');
  assert.equal(notes.filter((n) => /failed/i.test(n.text)).length, 0, 'the normal first answer for a fresh token was reported as a failure');
  // And a REAL failure is still a real failure.
  BUY = async () => { throw new Error('insufficient output amount'); };
  await T._fireLaunch('robinhood', { token: '0xE2', sym: 'E', creator: '', at: Date.now() }, { armed: USERS, devFollowers: [] });
  assert.equal(notes.filter((n) => /failed/i.test(n.text)).length, 1, 'a real failure must still be told');
});

test('a user who already bought is never re-offered the launch by the ring', async () => {
  reset();
  const u1 = armUser('robinhood'); const u2 = armUser('robinhood');
  USERS.push(u1, u2);
  // u1 fills, u2 is too early.
  BUY = async (chatId) => {
    if (chatId === u2.chatId) throw new Error('no pool');
    return { sym: 'PAD', gotTokens: 100, spentEth: 0.05, native: 'ETH', hash: '0xhash' };
  };
  await T._fireLaunch('robinhood', { token: '0xF1', sym: 'F', creator: '', at: Date.now() }, { armed: USERS, devFollowers: [] });
  assert.equal(buys.filter((b) => b.chatId === u1.chatId).length, 1);
  assert.equal(T._launchRetry.size, 1);
  BUY = async () => ({ sym: 'PAD', gotTokens: 100, spentEth: 0.05, native: 'ETH', hash: '0xhash' });
  await T.launchRetryCycle();
  // u2 got its fill; u1 must NOT have been bought twice.
  assert.equal(buys.filter((b) => b.chatId === u1.chatId).length, 1, 'the ring re-bought for a user who already held — a double spend');
  assert.equal(buys.filter((b) => b.chatId === u2.chatId).length, 1);
});

test('an expired entry leaves the ring unbought', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  T._launchRetry.set('robinhood:0xg1', { chainKey: 'robinhood', L: { token: '0xG1', at: Date.now() - 10 * 60 * 1000 }, done: new Set(), tries: 0 });
  await T.launchRetryCycle();
  assert.equal(T._launchRetry.size, 0, 'a stale launch polls for ever');
  assert.equal(buys.length, 0, 'an expired launch was bought anyway');
});

test('an entry whose audience disarmed is dropped without a probe', async () => {
  reset();   // no users at all
  let probed = 0;
  CAN_TRADE = async () => { probed++; return true; };
  T._launchRetry.set('robinhood:0xh1', { chainKey: 'robinhood', L: { token: '0xH1', at: Date.now() }, done: new Set(), tries: 0 });
  await T.launchRetryCycle();
  assert.equal(T._launchRetry.size, 0);
  assert.equal(probed, 0, 'a launch with no audience still spends probes');
});

// ── the dev-wallet snipe actually buys ───────────────────────────────────────

test('a dev launch from a PAD FEED is bought for the follower — pads carry the creator', async () => {
  reset();
  const dev = '0xDEADDEV';
  USERS.push(devUser('robinhood', dev));
  const t0 = Date.now() - 5000;
  FEEDS.robinhood = { ok: true, byPad: { pons: feedOk([item('0xI0', { createdAt: t0 })]), other: feedOk([]) } };
  await T.padSnipeCycle();   // seed
  FEEDS.robinhood = { ok: true, byPad: { pons: feedOk([item('0xI1', { createdAt: t0 + 1000, creator: dev })]), other: feedOk([]) } };
  await T.padSnipeCycle();
  assert.equal(buys.length, 1, 'the followed dev\'s pad launch was not bought');
  assert.equal(buys[0].token, '0xI1');
  assert.match(notes[0].text, /Dev snipe/);
});

test('a dev snipe that arrives before the pool opens is retried, and FILLS', async () => {
  reset();
  const dev = '0xDEADDEV';
  USERS.push(devUser('robinhood', dev));
  // The dev's launch is seen instantly — before the pool. The buy says so.
  BUY = async () => { throw new Error('no liquidity / zero quote for this token on robinhood'); };
  await T._fireLaunch('robinhood', { token: '0xJ1', sym: 'J', creator: dev, at: Date.now() }, { armed: [], devFollowers: USERS });
  assert.equal(T._launchRetry.size, 1, 'THE dev-snipe case: seen too early must mean parked, not dropped');
  assert.equal(notes.filter((n) => /Dev-snipe .* failed/i.test(n.text)).length, 0, 'too-early reported as a failed snipe');
  // The dev opens the pool; the ring fires and the follower is filled.
  BUY = async () => ({ sym: 'J', gotTokens: 50, spentEth: 0.02, native: 'ETH', hash: '0xhash', gotRaw: '50' });
  await T.launchRetryCycle();
  assert.equal(buys.length, 1, 'the dev snipe never bought — the feature reported working while unable to fill');
  assert.match(notes.at(-1).text, /Dev snipe/);
  // Idempotent: the target's own dedup refuses a second buy of the same launch.
  await T._fireLaunch('robinhood', { token: '0xJ1', sym: 'J', creator: dev, at: Date.now() }, { armed: [], devFollowers: USERS });
  assert.equal(buys.length, 1, 'a re-offered launch was bought twice');
});

test('a dev-sniped launch is not ALSO snipe-all bought for the same user', async () => {
  reset();
  const dev = '0xDEADDEV';
  const u = devUser('robinhood', dev);
  u.snipe = { chains: { robinhood: true }, ethAmount: 0.05 };   // both features armed
  USERS.push(u);
  await T._fireLaunch('robinhood', { token: '0xK1', sym: 'K', creator: dev, at: Date.now() }, { armed: [u], devFollowers: [u] });
  assert.equal(buys.length, 1, 'one launch, one user, two buys');
});

// ── dedup is chain-aware ─────────────────────────────────────────────────────

test('Solana mints are deduped case-SENSITIVELY — base58 is not EVM', () => {
  const a = 'So1anaMintAAAA';
  const b = 'so1anamintaaaa';   // a DIFFERENT mint on Solana
  assert.equal(T._snipeMark('solana', a), true);
  assert.equal(T._snipeMark('solana', b), true, 'two different mints folded onto one key — the second launch is silently dropped');
  assert.equal(T._snipeMark('solana', a), false);
  // EVM stays case-insensitive: 0xAbc and 0xABC are the same contract.
  assert.equal(T._snipeMark('bsc', '0xAbCd'), true);
  assert.equal(T._snipeMark('bsc', '0xABCD'), false);
});

test('a BROADCAST buy is never re-offered by the ring — it may still land', async () => {
  reset();
  const u1 = armUser('robinhood'); const u2 = armUser('robinhood');
  USERS.push(u1, u2);
  // u1's buy broadcasts and dies unconfirmed; u2 is too early. The launch
  // requeues for u2 — and u1 must be in the ring's done-set, because their
  // transaction may still confirm and a second buy is a double spend.
  BUY = async (chatId) => {
    if (chatId === u1.chatId) { const e = new Error('broadcast, not confirmed'); e.broadcast = true; throw e; }
    throw new Error('no pool');
  };
  await T._fireLaunch('robinhood', { token: '0xL1', sym: 'L', creator: '', at: Date.now() }, { armed: USERS, devFollowers: [] });
  assert.equal(T._launchRetry.size, 1, 'u2 was dropped instead of parked');
  BUY = async () => ({ sym: 'L', gotTokens: 10, spentEth: 0.05, native: 'ETH', hash: '0xhash' });
  await T.launchRetryCycle();
  assert.equal(buys.filter((b) => b.chatId === u1.chatId).length, 0, 'a broadcast buy was re-offered — a double spend if the first tx lands');
  assert.equal(buys.filter((b) => b.chatId === u2.chatId).length, 1, 'the waiting user never got their fill');
});

test('a launch past the per-cycle budget is queued for the ring, never silently dropped', async () => {
  reset();
  USERS.push(armUser('solana'));
  CAN_TRADE = async () => true;
  const t0 = Date.now() - 5000;
  FEEDS.solana = { ok: true, byPad: { letsbonk: feedOk([item('SeedMint111', { createdAt: t0, pad: 'letsbonk' })]) } };
  await T.padSnipeCycle();   // seed
  // Ten fresh launches against the Solana per-tick budget of 5: the pad cursor
  // advances past ALL of them, so anything not fired now must be in the ring or
  // it is gone for ever.
  const many = Array.from({ length: 10 }, (_, i) => item('FreshMint' + i, { createdAt: t0 + 1000 + i, pad: 'letsbonk' }));
  FEEDS.solana = { ok: true, byPad: { letsbonk: feedOk(many) } };
  await T.padSnipeCycle();
  assert.equal(buys.length + T._launchRetry.size, 10, `${buys.length} bought + ${T._launchRetry.size} queued — the rest vanished past an advanced cursor`);
  assert.ok(buys.length <= 5, 'the Solana per-tick budget is not being applied');
  // …and the queued ones fill from the ring.
  await T.launchRetryCycle(); await T.launchRetryCycle();
  assert.ok(buys.length > 5, 'the queued overflow was never fired');
});

test('a pad replaying stale history after a bench does not buy ten-minute-old launches', async () => {
  reset();
  USERS.push(armUser('bsc'));
  const t0 = Date.now() - 30 * 60 * 1000;   // half an hour ago
  FEEDS.bsc = { ok: true, byPad: { fourmeme: feedOk([item('0xOld0', { createdAt: t0, pad: 'fourmeme' })]) } };
  await T.padSnipeCycle();   // seed at the stale head
  FEEDS.bsc = { ok: true, byPad: { fourmeme: feedOk([
    item('0xOld1', { createdAt: t0 + 60000, pad: 'fourmeme' }),          // newer than the cursor, still 29 min old
    item('0xNew1', { createdAt: Date.now() - 5000, pad: 'fourmeme' }),   // actually fresh
  ]) } };
  await T.padSnipeCycle();
  assert.equal(buys.length, 1, 'a stale launch was sniped — that is buying somebody\'s exit');
  assert.equal(buys[0].token, '0xNew1');
});

// ── the audit round: five defects the first cut of this feature shipped ──────

test('a launch the ring gave up on unblocks its own graduation buy', async () => {
  reset();
  USERS.push(armUser('bsc'));
  // A four.meme curve token: seen by the pad feed, gated (no market), parked.
  CAN_TRADE = async () => false;
  const t0 = Date.now() - 5000;
  FEEDS.bsc = { ok: true, byPad: { fourmeme: feedOk([item('0xM0', { createdAt: t0, pad: 'fourmeme' })]) } };
  await T.padSnipeCycle();   // seed
  FEEDS.bsc = { ok: true, byPad: { fourmeme: feedOk([item('0xM1', { createdAt: t0 + 1000, pad: 'fourmeme' })]) } };
  await T.padSnipeCycle();
  assert.equal(T._launchRetry.size, 1);
  // The ring expires it — a curve lives minutes-to-days, far past the window.
  const k = [...T._launchRetry.keys()][0];
  T._launchRetry.get(k).L.at = Date.now() - 10 * 60 * 1000;
  await T.launchRetryCycle();
  assert.equal(T._launchRetry.size, 0);
  // NOBODY was served, so the mark must be gone: the graduation PairCreated
  // event — where these tokens were ALWAYS bought before the pad loop existed —
  // has to be able to offer it. A mark left behind here made the launchpad
  // integration silently disable the one path that already worked.
  assert.equal(T._snipeMark('bsc', '0xM1'), true, 'the expired launch stayed marked — the graduation snipe is permanently suppressed');
});

test('…but a launch SOMEBODY holds stays marked — their graduation re-buy is the double spend', async () => {
  reset();
  const u1 = armUser('robinhood'); const u2 = armUser('robinhood');
  USERS.push(u1, u2);
  // u1 fills; u2 is too early → the launch requeues carrying u1 in done.
  BUY = async (chatId) => {
    if (chatId === u1.chatId) return { sym: 'N', gotTokens: 10, spentEth: 0.05, native: 'ETH', hash: '0xhash' };
    throw new Error('no pool');
  };
  await T._fireLaunch('robinhood', { token: '0xN1', sym: 'N', creator: '', at: Date.now() }, { armed: USERS, devFollowers: [] });
  assert.equal(T._launchRetry.size, 1);
  // Expire it with u2 still unfilled: u1 HOLDS the token, so the mark must stay.
  const k = [...T._launchRetry.keys()][0];
  T._launchRetry.get(k).L.at = Date.now() - 10 * 60 * 1000;
  T._snipeMark('robinhood', '0xN1');   // the discoverer marked it (as the scans do)
  await T.launchRetryCycle();
  assert.equal(T._snipeMark('robinhood', '0xN1'), false, 'a launch somebody holds was unmarked — its graduation event now buys it twice for them');
});

test('a COPY-TRADES budget cannot be spent past its cap by two concurrent buys', () => {
  // The check-then-claim spans a network await (the safety gate), and the retry
  // ring made concurrent _followerBuy calls on one target possible: both could
  // read a stale spentEth, both pass, both claim — real money past the cap.
  // ⚠️ Asserted on 'trades', because the DEV snipe no longer has a cap at all
  // (the budget feature was removed on the owner's call); the race is still
  // live for copy-trades, which kept its budget, and the re-check that fixes it
  // is shared by both modes.
  const SRC = require('node:fs').readFileSync(require('node:path').join(__dirname, 'watchers.js'), 'utf8');
  const fn = SRC.slice(SRC.indexOf('async function _followerBuy('), SRC.indexOf('const _armedOn ='));
  const gate = fn.indexOf('safety.tokenSecurity');
  const claim = fn.indexOf('t.bought[key] = true;');
  assert.ok(gate > 0 && claim > gate, 'the safety await and the claim moved — this test is asserting nothing');
  const between = fn.slice(gate, claim);
  assert.match(between, /if \(t\.bought\[key\]\) return false;/, 'the dedup is no longer re-checked after the await');
  assert.match(between, /if \(capped && Number\(t\.spentEth\) \+ fanOutEth > Number\(t\.maxEth\)/, 'the budget is no longer re-checked after the await');
});


test('a user who arms AFTER a launch is queued is not bought into it', async () => {
  reset();
  const u1 = armUser('robinhood');
  USERS.push(u1);
  BUY = async () => { throw new Error('no pool'); };
  await T._fireLaunch('robinhood', { token: '0xQ1', sym: 'Q', creator: '', at: Date.now() }, { armed: [u1], devFollowers: [] });
  assert.equal(T._launchRetry.size, 1);
  // u2 arms a minute later — the launch predates their consent to spend.
  const u2 = armUser('robinhood');
  USERS.push(u2);
  BUY = async () => ({ sym: 'Q', gotTokens: 10, spentEth: 0.05, native: 'ETH', hash: '0xhash' });
  await T.launchRetryCycle();
  assert.equal(buys.filter((b) => b.chatId === u1.chatId).length, 1, 'the user who was armed at queue time never got their fill');
  assert.equal(buys.filter((b) => b.chatId === u2.chatId).length, 0, 'the ring retro-sniped for a user who armed after the launch');
});

test('a re-scan requeue remembers the users served in the FIRST pass', async () => {
  reset();
  const dev = '0xDEADDEV';
  const uA = armUser('robinhood');
  const uD = devUser('robinhood', dev);
  USERS.push(uA, uD);
  // First pass: uA fills through snipe-all.
  await T._fireLaunch('robinhood', { token: '0xR1', sym: 'R', creator: '', at: Date.now() }, { armed: [uA], devFollowers: [] });
  assert.equal(buys.filter((b) => b.chatId === uA.chatId).length, 1);
  // Re-scan (cursor regression): armed is emptied AND rides as skip — the
  // dev buy is too early, so the launch requeues. Without the skip, `done`
  // is built only from THIS invocation and uA is exposed to a ring re-buy.
  BUY = async () => { throw new Error('no pool'); };
  await T._fireLaunch('robinhood', { token: '0xR1', sym: 'R', creator: dev, at: Date.now() },
    { armed: [], devFollowers: [uD], skip: new Set([uA.chatId]) });
  assert.equal(T._launchRetry.size, 1);
  BUY = async () => ({ sym: 'R', gotTokens: 10, spentEth: 0.05, native: 'ETH', hash: '0xhash', gotRaw: '10' });
  await T.launchRetryCycle();
  assert.equal(buys.filter((b) => b.chatId === uA.chatId).length, 1, 'the ring re-bought a launch for a user who filled it in the first pass — a double spend');
  assert.equal(buys.filter((b) => b.chatId === uD.chatId).length, 1, 'the waiting dev follower never filled');
});

test('a registry-breaker SKIP is "we did not ask", never a feed failure', async () => {
  reset();
  USERS.push(armUser('bsc'));
  FEEDS.bsc = { ok: true, byPad: { fourmeme: { ok: false, skipped: true, why: 'four.meme: skipped, 3 failures in a row (unreachable) — retrying in 240s', items: [] } } };
  for (let i = 0; i < 4; i++) await T.padSnipeCycle();
  const stat = T._padSnipeStats.pads['bsc:fourmeme'];
  assert.equal(stat.fail, 0, 'a skip we issued ourselves was counted as the host failing');
  assert.equal(T._padFeedFail.size, 0, 'the local bench fed on the registry bench — a double-bench that outlives the outage');
  assert.match(stat.why, /skipped/, 'the reason must still be visible');
});

test('a feed whose items carry no createdAt says so, instead of seeding for ever', async () => {
  reset();
  USERS.push(armUser('bsc'));
  const rows = [item('0xS1', { createdAt: null, pad: 'fourmeme' }), item('0xS2', { createdAt: null, pad: 'fourmeme' })];
  FEEDS.bsc = { ok: true, byPad: { fourmeme: feedOk(rows) } };
  await T.padSnipeCycle();
  await T.padSnipeCycle();
  assert.equal(buys.length, 0);
  const stat = T._padSnipeStats.pads['bsc:fourmeme'];
  assert.ok(stat.lastOkAt, 'the host answered — that fact stays recorded');
  assert.match(String(stat.why), /createdAt|cursor/, 'a pad that can never fire reads as a healthy quiet one');
});

test('an unreadable balance is a silent skip, never a "wallet has 0.00000" notice', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  BAL_OR_NULL = async () => null;   // dead RPC — the read FAILED, the wallet is fine
  await T._fireLaunch('robinhood', { token: '0xT1', sym: 'T', creator: '', at: Date.now() }, { armed: USERS, devFollowers: [] });
  assert.equal(buys.length, 0);
  assert.equal(notes.length, 0, 'a dead RPC was reported to a funded user as an empty wallet — and the told-once flag latched on it');
});

test('pump.fun overflow past the per-cycle budget queues for the ring', async () => {
  reset();
  USERS.push(armUser('solana'));
  const t0 = Date.now() - 5000;
  const coin = (i) => ({ mint: 'PumpMint' + i, symbol: 'P' + i, creator: '', createdTs: t0 + i * 10 });
  solanaStub.pumpfunNewX = async () => ({ ok: true, coins: [coin(0)] });
  await T.solSnipeCycle();   // seeds the pump cursor
  solanaStub.pumpfunNewX = async () => ({ ok: true, coins: Array.from({ length: 6 }, (_, i) => coin(i + 1)) });
  await T.solSnipeCycle();
  assert.equal(buys.length + T._launchRetry.size, 6, `${buys.length} bought + ${T._launchRetry.size} queued — the overflow vanished past the cursor`);
  assert.ok(T._launchRetry.size > 0, 'nothing was queued — the budget cap is not being exercised (raise the launch count)');
  await T.launchRetryCycle();
  assert.equal(buys.length, 6, 'the queued pump.fun overflow was never fired');
});

test('_notYetTradeable separates "no market yet" from every real failure', () => {
  const yes = ['no route / no liquidity for this token on Jupiter', 'no V3 liquidity / zero quote for this token on Ethereum', 'could not quote this buy on Base (no pool? try again): CALL_EXCEPTION', 'not tradable'];
  const no = ['insufficient ETH — need ~0.016, have 0.0149', 'transaction reverted', "this token's liquidity is on ston.fi, which Dexvra can't route through yet — no swap to sign", 'rate limited (429)'];
  for (const m of yes) assert.equal(T._notYetTradeable(new Error(m)), true, `should retry: ${m}`);
  for (const m of no) assert.equal(T._notYetTradeable(new Error(m)), false, `must not retry: ${m}`);
});

// ── Pons: the second Robinhood launchpad, read from the chain itself ─────────
//
// The HTTP pad for Pons cannot answer from anywhere this repo runs (the box
// times out, the sandbox is egress-blocked), so discovery is the factory's own
// TokenLaunched log. These tests drive _ponsScan with a stub provider serving
// REAL encoded logs — the decode path is the part a guessed ABI gets wrong.
//
// ⚠️ AND THE FIRST SHIPPED DEFAULTS WERE BOTH WRONG. The factory addresses came
// from Pons's docs and had no contract code on the chain; the documented
// `TokenLaunched(...)` signature hashes to 0xdb51ea…, while the launchpad that
// really announces a launch emits 0x8d4aad… — so the filter could never have
// matched a log even with the right address. Both defaults are what the
// preflight READ OFF THE BOX, and the ABI behind that topic0 is genuinely
// unknown (1050 candidate spellings hashed, none matched), so the scan has to
// work from a bare topic0 — which is what most of these tests drive.
const PONS_SIG = 'TokenLaunched(address,address,address,address,address,uint256,uint256,uint256,uint256,uint256)';
const PONS_SIG_FULL = 'event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)';
const PONS_TOPIC0 = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';
const PONS_FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
const pad32 = (a) => ethers.zeroPadValue(ethers.getAddress(a), 32);
const unpad = (w) => ('0x' + String(w).slice(26)).toLowerCase();
/** An ERC-20 mint — `Transfer` out of the zero address, THREE topics (a v3
 *  position NFT mints with four, and is minted in these very transactions). */
const mintLog = (token, to) => ({
  address: token,
  topics: [ethers.id('Transfer(address,address,uint256)'), '0x' + '0'.repeat(64), pad32(to)],
  data: ethers.zeroPadValue('0x0de0b6b3a7640000', 32),
});
function ponsLog(token, deployer, blockNumber, over = {}) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return {
    address: PONS_FACTORY,
    topics: [PONS_TOPIC0, pad32(token), pad32(deployer), pad32('0x' + '3'.repeat(40))],
    // The pool and the quote token are named by the log too — which is exactly
    // why "an address in the log" is not enough to identify the launched token.
    data: coder.encode(['address', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
      ['0x' + '4'.repeat(40), '0x' + '5'.repeat(40), 1n, 1n, 7n, 0n, 0n]),
    blockNumber, blockHash: '0x' + 'b'.repeat(64), transactionHash: ethers.id(token + ':' + blockNumber),
    index: 0, transactionIndex: 0, removed: false,
    ...over,
  };
}
function ponsProvider(ctl) {
  ctl.receiptReads = 0;
  const p = {
    getCode: async () => ctl.code ?? '0xdeadbeef',
    getLogs: async (f) => {
      // The scan filters by topic0; the raw-mismatch probe does not. Serving
      // them apart is what lets a test present "the factory emits logs our
      // filter does not match".
      if (f && f.topics && f.topics.length) return (ctl.logs || []).filter((l) => l.topics[0] === f.topics[0]);
      return (ctl.raw || ctl.logs || []);
    },
    // The launch transaction: by default it mints exactly the token the log
    // names, from the deployer's own wallet — the ordinary case. A test that
    // wants the ambiguous or empty case supplies `ctl.receipts`.
    getTransactionReceipt: async (h) => {
      ctl.receiptReads++;
      if (ctl.receipts) return ctl.receipts[h] || null;
      const l = (ctl.logs || []).find((x) => x.transactionHash === h);
      if (!l) return null;
      return { from: unpad(l.topics[2]), logs: [mintLog(unpad(l.topics[1]), '0x' + '9'.repeat(40))] };
    },
    getNetwork: async () => new ethers.Network('robinhood', 4663),
    _detectNetwork: async () => new ethers.Network('robinhood', 4663),
    // token0() — a pair answers with a word, an ERC-20 reverts or returns '0x'.
    call: async (tx) => (ctl.callBy || {})[String(tx && tx.to).toLowerCase()] || '0x',
    resolveName: async (n) => n,
  };
  p.provider = p;
  return p;
}
const { ethers } = require('ethers');

test('a Pons TokenLaunched log is sniped, and its deployer IS the dev wallet', async () => {
  reset();
  const dev = '0x' + 'd'.repeat(40);
  const uA = armUser('robinhood');
  const uD = devUser('robinhood', dev);
  USERS.push(uA, uD);
  const ctl = { logs: [] };
  const prov = ponsProvider(ctl);
  await T._ponsScan(prov, 10000, [uA], [uD]);   // first look seeds only
  assert.equal(buys.length, 0, 'the seeding pass bought');
  ctl.logs = [ponsLog('0x' + 'a1'.repeat(20), dev, 10050)];
  await T._ponsScan(prov, 10100, [uA], [uD]);
  assert.equal(buys.filter((b) => b.chatId === uA.chatId).length, 1, 'the armed user missed a Pons launch');
  assert.equal(buys.filter((b) => b.chatId === uD.chatId).length, 1, 'the dev follower missed their dev\'s Pons launch');
  assert.match(notes.map((n) => n.text).join('\n'), /Dev snipe/);
  assert.ok(T._snipeStats.ponsSeen >= 1);
  assert.equal(T._snipeStats.ponsErr, null);
});

test('a Pons launch is never double-served on a re-scan, and dev followers still pass', async () => {
  reset();
  const uA = armUser('robinhood');
  USERS.push(uA);
  const ctl = { logs: [ponsLog('0x' + 'a2'.repeat(20), '0x' + 'e'.repeat(40), 10150)] };
  const prov = ponsProvider(ctl);
  await T._ponsScan(prov, 10200, [uA], []);
  assert.equal(buys.length, 1);
  // The same log range replayed (a lagging RPC head): marked → snipe-all skipped.
  await T._ponsScan(prov, 10200, [uA], []);   // head < cursor pins, no re-buy
  await T._ponsScan(prov, 10250, [uA], []);
  assert.equal(buys.length, 1, 'a re-scan re-bought a Pons launch');
});

test('a factory that emits logs our filter does not match names the SIGNATURE as the problem', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  const alien = ponsLog('0x' + 'a3'.repeat(20), '0x' + 'e'.repeat(40), 10350);
  alien.topics[0] = ethers.id('SomethingElse(address)');   // rotated ABI
  const ctl = { logs: [alien] };
  const prov = ponsProvider(ctl);
  await T._ponsScan(prov, 10400, USERS, []);
  assert.equal(buys.length, 0);
  assert.match(String(T._snipeStats.ponsErr), /PONS_EVENT/, 'a stale signature reads as a quiet launchpad');
});

test('LAUNCHPAD_PONS=0 kills the chain scan too — one feature, one switch', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  process.env.LAUNCHPAD_PONS = '0';
  try {
    const ctl = { logs: [ponsLog('0x' + 'a4'.repeat(20), '0x' + 'e'.repeat(40), 10450)] };
    await T._ponsScan(ponsProvider(ctl), 10500, USERS, []);
    assert.equal(buys.length, 0, 'the kill switch does not reach the on-chain scan');
  } finally { delete process.env.LAUNCHPAD_PONS; }
  assert.equal(T._ponsCfg().on, true, 'blank must mean ON — the pads-table rule');
});

test('a PONS_FACTORY with no contract behind it is a sentence, not an eternal empty scan', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  // The code verdict is cached per FACTORY for an hour — a different address
  // (the operator's .env override) gets a fresh look, which is also what lets
  // this test run after the ones that proved the default factory good.
  process.env.PONS_FACTORY = '0x' + 'f'.repeat(40);
  try {
    const prov = ponsProvider({ code: '0x', logs: [ponsLog('0x' + 'a5'.repeat(20), '0x' + 'e'.repeat(40), 10550)] });
    await T._ponsScan(prov, 10600, USERS, []);
    assert.equal(buys.length, 0);
    const why = String(T._snipeStats.ponsErr);
    assert.match(why, /contract code/, 'a wrong factory address reads as a quiet chain');
    assert.match(why, /PONS_FACTORY/, 'the sentence must name the knob that fixes it');
    assert.match(why, /0xffff/i, 'the sentence must name the address it judged');
  } finally { delete process.env.PONS_FACTORY; }
});

// ── the ABI is unknown, and the scan may not guess one ───────────────────────

test('the shipped defaults are what the BOX measured, not what the docs said', () => {
  const cfg = T._ponsCfg();
  assert.equal(cfg.topic0, PONS_TOPIC0, 'the default filter must be the topic0 read off the chain');
  assert.notEqual(ethers.id(PONS_SIG), PONS_TOPIC0,
    'the documented TokenLaunched signature is NOT what this chain emits — that mismatch is why the first scan could never match a log');
  assert.equal(cfg.decodable, false, 'no ABI is known for that topic0, so the scan must not claim it can decode one');
  assert.ok(cfg.factories.includes(PONS_FACTORY), 'the measured factory must ship as a default');
  assert.equal(cfg.factories.length, 2, 'both factories that announced the measured launch are watched');
});

test('with no ABI the token is resolved by MEASUREMENT — minted in its own launch transaction', async () => {
  reset();
  const uA = armUser('robinhood');
  USERS.push(uA);
  const token = '0x' + 'b1'.repeat(20);
  const ctl = { logs: [ponsLog(token, '0x' + 'd'.repeat(40), 10650)] };
  const prov = ponsProvider(ctl);
  await T._ponsScan(prov, 10700, [uA], []);
  assert.equal(buys.length, 1, 'a launch whose ABI we do not have was not sniped');
  assert.equal(String(buys[0].token).toLowerCase(), token, 'the wrong address was bought');
  // The log NAMES the pool and the quote token too — being named is not enough.
  assert.ok(ctl.receiptReads > 0, 'the resolve must ask the chain, not read an argument position');
});

test('two candidates is a REFUSAL, not a coin toss', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  const token = '0x' + 'b2'.repeat(20);
  const log = ponsLog(token, '0x' + 'd'.repeat(40), 10750);
  const ctl = {
    logs: [log],
    // Both the token and the pool named by the log minted here, and neither
    // answers token0() — nothing on the chain separates them.
    receipts: { [log.transactionHash]: { from: '0x' + 'd'.repeat(40), logs: [mintLog(token, '0x' + '9'.repeat(40)), mintLog('0x' + '4'.repeat(40), '0x' + '9'.repeat(40))] } },
  };
  await T._ponsScan(ponsProvider(ctl), 10800, USERS, []);
  assert.equal(buys.length, 0, 'an ambiguous launch was fired at anyway — that spends money on a guess');
  const why = String(T._snipeStats.ponsErr);
  assert.match(why, /could not be resolved/, 'a refused launch must not read as a quiet launchpad');
  assert.match(why, /PONS_EVENT/, 'the sentence must name the knob that resolves it');
});

test('…and a PAIR among the candidates is eliminated by asking the chain, never by position', async () => {
  reset();
  const uA = armUser('robinhood');
  USERS.push(uA);
  const token = '0x' + 'b3'.repeat(20);
  const pair = '0x' + '4'.repeat(40);
  const log = ponsLog(token, '0x' + 'd'.repeat(40), 10850);
  const ctl = {
    logs: [log],
    receipts: { [log.transactionHash]: { from: '0x' + 'd'.repeat(40), logs: [mintLog(token, '0x' + '9'.repeat(40)), mintLog(pair, '0x' + '9'.repeat(40))] } },
    callBy: { [pair]: ethers.zeroPadValue('0x01', 32) },   // it answers token0() — it is the LP, not the launch
  };
  await T._ponsScan(ponsProvider(ctl), 10900, [uA], []);
  assert.equal(buys.length, 1, 'a v2-style launch that mints its LP token must still resolve');
  assert.equal(String(buys[0].token).toLowerCase(), token, 'the LP token was bought instead of the launch');
});

test('a launch whose transaction minted nothing is refused and REPORTED', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  const log = ponsLog('0x' + 'b4'.repeat(20), '0x' + 'd'.repeat(40), 10950);
  const ctl = { logs: [log], receipts: { [log.transactionHash]: { from: '0x' + 'd'.repeat(40), logs: [] } } };
  await T._ponsScan(ponsProvider(ctl), 11000, USERS, []);
  assert.equal(buys.length, 0);
  assert.match(String(T._snipeStats.ponsErr), /minted/, 'the reason must say what was looked for');
});

test('PONS_EVENT takes a full signature, and then costs no receipt read at all', async () => {
  reset();
  const dev = '0x' + 'd'.repeat(40);
  const uA = armUser('robinhood');
  const uD = devUser('robinhood', dev);
  USERS.push(uA, uD);
  process.env.PONS_EVENT = PONS_SIG_FULL;
  try {
    assert.equal(T._ponsCfg().decodable, true);
    const token = '0x' + 'b5'.repeat(20);
    const log = ponsLog(token, dev, 11050, { topics: [ethers.id(PONS_SIG), pad32(token), pad32(dev), pad32('0x' + '3'.repeat(40))] });
    const ctl = { logs: [log] };
    await T._ponsScan(ponsProvider(ctl), 11100, [uA], [uD]);
    assert.equal(String(buys[0] && buys[0].token).toLowerCase(), token, 'a decodable event must read the token off the log');
    assert.equal(ctl.receiptReads, 0, 'a known ABI must not pay for the measured resolve');
    assert.equal(buys.filter((b) => b.chatId === uD.chatId).length, 1, "the event's own deployer must still reach dev followers");
  } finally { delete process.env.PONS_EVENT; }
});

test('a topic0 whose spelling we DO know decodes by name — PONS_KNOWN_SIGS is that bridge', async () => {
  reset();
  const uA = armUser('robinhood');
  USERS.push(uA);
  // An operator pastes a topic0 off an explorer. If it happens to be one we
  // know the signature for, the named decode lights up by itself.
  process.env.PONS_EVENT = ethers.id(PONS_SIG);
  try {
    const cfg = T._ponsCfg();
    assert.equal(cfg.decodable, true, 'a known topic0 must resolve to its signature');
    assert.match(String(cfg.eventSig), /TokenLaunched/);
    const token = '0x' + 'b6'.repeat(20);
    const log = ponsLog(token, '0x' + 'd'.repeat(40), 11150, { topics: [ethers.id(PONS_SIG), pad32(token), pad32('0x' + 'd'.repeat(40)), pad32('0x' + '3'.repeat(40))] });
    const ctl = { logs: [log] };
    await T._ponsScan(ponsProvider(ctl), 11200, [uA], []);
    assert.equal(ctl.receiptReads, 0);
    assert.equal(String(buys[0] && buys[0].token).toLowerCase(), token);
  } finally { delete process.env.PONS_EVENT; }
});

test('an unmatched topic0 names the topics the factory DID emit — one of them is the answer', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  const alien = ponsLog('0x' + 'b7'.repeat(20), '0x' + 'd'.repeat(40), 11250);
  alien.topics[0] = ethers.id('SomeOtherLaunch(address,address)');
  await T._ponsScan(ponsProvider({ logs: [alien] }), 11300, USERS, []);
  assert.equal(buys.length, 0);
  const why = String(T._snipeStats.ponsErr);
  assert.match(why, /PONS_EVENT/, 'the sentence must name the knob');
  assert.ok(why.includes(ethers.id('SomeOtherLaunch(address,address)')),
    'a diagnosis that withholds the topic it saw sends the operator back to the explorer');
});

test('PONS_EVENT that is neither shape is refused up front, not scanned against for ever', async () => {
  reset();
  USERS.push(armUser('robinhood'));
  process.env.PONS_EVENT = 'TokenLaunched';   // a name is not a signature and not a topic
  try {
    assert.equal(T._ponsCfg().topic0, null);
    await T._ponsScan(ponsProvider({ logs: [ponsLog('0x' + 'b8'.repeat(20), '0x' + 'd'.repeat(40), 11350)] }), 11400, USERS, []);
    assert.equal(buys.length, 0);
    assert.match(String(T._snipeStats.ponsErr), /topic0|signature/, 'it must say which two spellings it takes');
  } finally { delete process.env.PONS_EVENT; }
});

test('_logAddrs takes every address the log NAMES, order-independent', () => {
  const token = '0x' + 'b9'.repeat(20);
  const dev = '0x' + 'd'.repeat(40);
  const got = T._logAddrs(ponsLog(token, dev, 1));
  for (const a of [token, dev, '0x' + '3'.repeat(40), '0x' + '4'.repeat(40), '0x' + '5'.repeat(40)])
    assert.ok(got.has(a.toLowerCase()), `the log names ${a} and _logAddrs missed it`);
  assert.equal(got.has('0x' + '0'.repeat(40)), false, 'the zero address is not a candidate');
});

// ── "BOT MALA DIAM TIDAK ADA EKSEKUSI — MINIMAL KALO GAGAL HARUS ADA PESANYA" ─
//
// A watched dev launched a token onto a Pons bonding curve. canTradeNow said
// no (this engine has no route through one), _notYetTradeable deliberately
// excludes "can't route through" from the retry ring, and the whole chain ended
// in SILENCE. Every step was individually correct; the sum was a sniper that
// watched a launch go by without a word.

test('a dev launch the bot cannot buy is REPORTED, never silent', async () => {
  reset();
  const dev = '0x' + 'd'.repeat(40);
  const u = devUser('robinhood', dev);
  USERS.push(u);
  BUY = async () => { throw new Error("this token's liquidity is on Pons v2, which Dexvra can't route through yet — no swap to sign"); };
  await T._fireLaunch('robinhood', { token: '0xPONS1', sym: 'TEST', creator: dev, at: Date.now() }, { armed: [], devFollowers: [u] });
  const texts = notes.map((n) => n.text).join('\n');
  assert.match(texts, /NOT bought/i, 'the launch went by in silence — the reported defect');
  assert.match(texts, /Pons v2|route through/i, 'the notice must carry the REASON, not a shrug');
  assert.match(texts, /<code>0xPONS1<\/code>/, 'the notice must name the token');
});

test('…and an unroutable launch is followed until it becomes tradeable', async () => {
  reset();
  const dev = '0x' + 'd'.repeat(40);
  const u = devUser('robinhood', dev);
  USERS.push(u);
  BUY = async () => { throw new Error("liquidity is on Pons v2, which Dexvra can't route through yet"); };
  await T._fireLaunch('robinhood', { token: '0xPONS2', sym: 'TEST', creator: dev, at: Date.now() }, { armed: [], devFollowers: [u] });
  // A bonding curve becomes buyable when it graduates into a pool. The CA snipe
  // already polls canTradeNow for its whole TTL and fires on the first tick it
  // can fill — so the launch is handed to it rather than dropped.
  const armed = T._caArmed;
  assert.equal(armed.length, 1, 'the unbuyable launch was dropped instead of being followed to graduation');
  assert.equal(String(armed[0].ca).toLowerCase(), '0xpons2');
  assert.match(notes.map((n) => n.text).join('\n'), /contract snipe/i, 'the follow-up was silent — a queue the user does not know about is no queue');
});

test('a honeypot skip is the gate WORKING, and is still said out loud', async () => {
  reset();
  const dev = '0x' + 'd'.repeat(40);
  const u = devUser('robinhood', dev);
  USERS.push(u);
  SAFE = { supported: true, level: 'danger' };
  try {
    await T._fireLaunch('robinhood', { token: '0xRUG', sym: 'RUG', creator: dev, at: Date.now() }, { armed: [], devFollowers: [u] });
    const texts = notes.map((n) => n.text).join('\n');
    assert.match(texts, /NOT bought/i, 'the bot stayed out of a honeypot and never said so');
    assert.match(texts, /DANGER|honeypot/i, 'the notice must say it was a deliberate skip, not a failure');
  } finally { SAFE = { supported: false, level: 'ok' }; }
});

test('one notice per launch, not one per tick', async () => {
  reset();
  const dev = '0x' + 'd'.repeat(40);
  const u = devUser('robinhood', dev);
  USERS.push(u);
  BUY = async () => { throw new Error("can't route through yet"); };
  const L = { token: '0xNOISE', sym: 'N', creator: dev, at: Date.now() };
  await T._fireLaunch('robinhood', L, { armed: [], devFollowers: [u] });
  await T._fireLaunch('robinhood', L, { armed: [], devFollowers: [u] });
  await T._fireLaunch('robinhood', L, { armed: [], devFollowers: [u] });
  const hits = notes.filter((n) => /NOT bought/i.test(n.text)).length;
  assert.equal(hits, 1, `${hits} notices for one launch — a warning per tick is a warning nobody reads`);
});
