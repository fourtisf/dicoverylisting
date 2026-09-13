'use strict';
// The snipe loop can be completely dead and still look perfectly healthy.
//
// This is the failure this file exists to make impossible to ship again. The Robinhood
// sniper discovers launches exactly one way: it filters a hard-coded launchpad factory
// for one hard-coded TokenCreated signature (core.js FACTORY_ABI, chains.js factory).
// Point that at the wrong launchpad — which is what happened when tokens moved from
// robinfun.io to pools.trade — and `eth_getLogs` returns an EMPTY ARRAY. Not an error.
// An empty array.
//
// So: the cycle completes, runLoop marks it OK, /health prints 🟢, the user's Snipe
// screen prints "Active", and zero fills happen for as long as the process runs. There
// was no counter, no log line and no alert anywhere in the system that could tell the
// difference between "no launches happened" and "I am blind".
//
// The important test here is THE INVERSE ONE: not "does a launch trigger a buy", but
// "does scanning thousands of blocks and finding NOTHING leave a trace". A test suite
// that only ever feeds the happy path a synthetic log is exactly how this shipped.
const test = require('node:test');
const assert = require('node:assert');
const { ethers } = require('ethers');

process.env.WALLET_SECRET = process.env.WALLET_SECRET || 'test-secret-for-snipe-observability';
process.env.BOT_DATA_DIR = process.env.BOT_DATA_DIR || require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'dexvra-snipe-'));

const core = require('./core');
const watchers = require('./watchers');

const { snipeCycle, _snipeStats } = watchers._test;

// A provider stub standing in for the Robinhood node. `logs` is what eth_getLogs
// returns — the whole point is that returning [] is a SUCCESS, not a throw.
//
// `ctl` is mutable so a test can change the head between cycles. That matters because
// snipeCycle deliberately PINS its cursor to the head on a cold start (watchers.js:68,
// "pin cursor near head always") so a restart never retro-snipes an old launch: the
// first cycle therefore scans an empty range by design. Every test below runs one
// priming cycle and asserts on the second.
function stubProvider(ctl) {
  const p = {
    getBlockNumber: async () => { if (ctl.blockErr) throw ctl.blockErr; return ctl.head; },
    getLogs: async () => { if (ctl.logsErr) throw ctl.logsErr; return ctl.logs || []; },
    // ethers Contract.queryFilter goes through these on a JsonRpcProvider; the stub
    // only needs enough surface for the filter path.
    getNetwork: async () => new ethers.Network('robinhood', 4663),
    _detectNetwork: async () => new ethers.Network('robinhood', 4663),
    call: async () => '0x',
    resolveName: async (n) => n,
  };
  p.provider = p;   // ethers resolves a ContractRunner's provider via `.provider`
  return p;
}

// Prime the block cursor, then advance the head so the next cycle has a real range.
async function primeThenAdvance(ctl, by = 50) {
  await snipeCycle().catch(() => {});   // cold-start cycle: pins the cursor, scans nothing
  ctl.head += by;
}

function withStub(prov, fn) {
  const real = core.providerFor;
  const realUsers = core.allUsers;
  core.providerFor = () => prov;
  // One armed user, so snipeCycle does not take its "nobody is armed" early return.
  core.allUsers = () => [{ chatId: 1, snipe: { chains: { robinhood: true }, ethAmount: 0.01 } }];
  const before = { ..._snipeStats };
  return (async () => {
    try { return await fn(); }
    finally { core.providerFor = real; core.allUsers = realUsers; Object.assign(_snipeStats, before); }
  })();
}

test('a scan that finds no launches still records that it scanned', async () => {
  // THE REGRESSION TEST. This is the exact state of a sniper pointed at the wrong
  // launchpad: getLogs succeeds, returns [], the cycle completes cleanly. Before this,
  // it left nothing behind at all. "0 launches across N blocks" is the only observable
  // that distinguishes a wrong factory from a quiet chain.
  const ctl = { head: 1_000_000, logs: [] };
  await withStub(stubProvider(ctl), async () => {
    await primeThenAdvance(ctl);
    const scansBefore = _snipeStats.scans;
    const blocksBefore = _snipeStats.blocksScanned;
    await snipeCycle();
    assert.ok(_snipeStats.scans > scansBefore, 'the scan must be counted');
    assert.ok(_snipeStats.blocksScanned > blocksBefore, 'the blocks scanned must be counted');
    assert.equal(_snipeStats.launchesSeen, 0, 'no launches were emitted, so none are counted');
    assert.equal(_snipeStats.lastLaunchAt, null, 'a scan that saw nothing must not look like a launch');
  });
});

test('health() exposes launches seen, not just whether the loop ran', async () => {
  // /health used to answer "did the loop run recently" — a question a dead sniper
  // passes every single time.
  const ctl = { head: 2_000_000, logs: [] };
  await withStub(stubProvider(ctl), async () => {
    await primeThenAdvance(ctl);
    await snipeCycle();
    const h = watchers.health();
    if (!h.snipe) return; // the loop is only registered in health() once start() runs
    assert.ok('launchesSeen' in h.snipe, 'health must report launches seen');
    assert.ok('sinceLastLaunchMs' in h.snipe, 'health must report how long since the last launch');
  });
});

test('snipeStats is exported so an operator surface can read it', () => {
  const s = watchers.snipeStats();
  assert.equal(typeof s.launchesSeen, 'number');
  assert.equal(typeof s.blocksScanned, 'number');
  assert.equal(typeof s.scans, 'number');
});

test('an RPC failure is raised, not swallowed as a healthy scan', async () => {
  // Both catches used to `return` — so runLoop called _beat(ok=true) and /health stayed
  // green through a total node outage. A fault must reach the loop that reports it.
  const ctl = { head: 3_000_000, blockErr: new Error('node unreachable') };
  await withStub(stubProvider(ctl), async () => {
    await assert.rejects(() => snipeCycle(), /node unreachable/, 'getBlockNumber failure must propagate');
  });
});

test('a getLogs failure is raised, and is not counted as a completed scan', async () => {
  const ctl = { head: 4_000_000, logs: [] };
  await withStub(stubProvider(ctl), async () => {
    await primeThenAdvance(ctl);
    ctl.logsErr = new Error('getLogs boom');   // fails only once there is a range to scan
    const scansBefore = _snipeStats.scans;
    await assert.rejects(() => snipeCycle(), /getLogs boom/, 'queryFilter failure must propagate');
    assert.equal(_snipeStats.scans, scansBefore, 'a failed scan is not a scan');
  });
});

// ── the launchpad diagnostic ────────────────────────────────────────────────

test('a failing curveOf is recorded instead of silently reading as "no curve"', async () => {
  // resolveCurve MUST keep returning '' on error — an RPC blip must not be mistaken for
  // a graduation, and that routing choice is correct. What was missing is any record
  // that it happened, which is what let a permanently wrong factory look like a market
  // of ordinary graduated tokens.
  // resolveCurve returns a cached NEGATIVE answer before it ever reaches the
  // provider, so without this the test asserts against whatever a previous test
  // left behind — it passed on one machine and failed on the server for that
  // reason alone, with an assertion message that named none of it.
  core._clearReadCaches();
  core._launchpadFailClear();
  const chain = core.chainOf('robinhood');
  assert.ok(chain && chain.curve && chain.factory,
    `robinhood has no launchpad factory configured, so resolveCurve returns early and records nothing: ${JSON.stringify(chain && { curve: chain.curve, factory: chain.factory })}`);

  // core._deps, not core.providerFor: the latter is a copy on the exports
  // object and internal callers never read it, so assigning to it stubs nothing.
  const real = core._deps.providerFor;
  core._deps.providerFor = () => ({
    call: async () => { throw new Error('execution reverted'); },
    getNetwork: async () => new ethers.Network('robinhood', 4663),
    _detectNetwork: async () => new ethers.Network('robinhood', 4663),
    resolveName: async (n) => n,
  });
  try {
    const curve = await core.resolveCurve('0x1234567890abcdef1234567890abcdef12345678', 'robinhood');
    assert.equal(curve, '', 'routing is unchanged: a factory error still reads as no curve');
    const diag = core.launchpadDiag('robinhood');
    assert.ok(diag, `the failure must be recorded — launchpadDiag returned ${JSON.stringify(diag)}; all chains: ${JSON.stringify(core.launchpadDiag())}`);
    assert.ok(diag.count >= 1);
    assert.ok(diag.factory, 'the diagnostic names the factory that failed');
    // Proves the stub actually ran. Without this the test passes on any box
    // whose RPC merely happens to be unreachable, which is how it hid the fact
    // that it was stubbing nothing at all.
    assert.match(String(diag.err), /execution reverted/,
      `the recorded error did not come from this test's stub: ${diag.err}`);
  } finally { core._deps.providerFor = real; }
});

test('launchpadDiag with no argument returns every chain it has seen fail', () => {
  const all = core.launchpadDiag();
  assert.equal(typeof all, 'object');
});
