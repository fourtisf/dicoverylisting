'use strict';
/*
 * statusBatch.test.js — five wallets, one status read.
 *
 * Measured on the production box, 2026-08-16, five wallets buying ONE token in
 * ONE block through ONE route:
 *
 *     [buy] sol Ge87Etsj reads=160ms swap=541ms  prio=0
 *     [buy] sol Ge87Etsj reads=161ms swap=527ms  prio=0
 *     [buy] sol Ge87Etsj reads=143ms swap=522ms  prio=0
 *     [buy] sol Ge87Etsj reads=256ms swap=1297ms prio=0
 *     [buy] sol Ge87Etsj reads=202ms swap=2289ms prio=0
 *
 * A 4.4x spread across trades that are identical in every way that should
 * matter. That is not the route and it is not Jupiter — it is the RPC running
 * out of patience. `confirmSignature` polls every 200ms, and the "~5 status
 * reads per trade" it is documented as costing is per TRADE: five concurrent
 * confirmations is ~25 requests a second, arriving at the same moment as five
 * sends and fifteen balance reads, at an endpoint that serves one IP far less
 * than that. The throttling lands on the confirmations because they are what is
 * still running.
 *
 * `getSignatureStatuses` takes an ARRAY and always did. Coalescing the polls
 * that fall in one short window turns N concurrent confirmations into ONE
 * request per tick.
 *
 * These tests drive the real confirmSignature against a fake connection that
 * COUNTS calls — the batching either happens or it does not, and a source-regex
 * could not tell the difference.
 *
 * No network.
 */
const test = require('node:test');
const assert = require('node:assert');

const solana = require('./solana');

/** A connection that records every getSignatureStatuses call. */
function fakeConn(statusFor) {
  const calls = [];
  return {
    calls,
    async getSignatureStatuses(list) {
      calls.push([...list]);
      return { value: list.map((s) => statusFor(s, calls.length)) };
    },
  };
}
const landed = { err: null, confirmationStatus: 'confirmed' };

test('five confirmations in flight cost ONE status read per round', async () => {
  // Answer on the second round so there is a first round with all five in it.
  const conn = fakeConn((_s, round) => (round >= 2 ? landed : null));
  const sigs = ['sigA', 'sigB', 'sigC', 'sigD', 'sigE'];
  const out = await Promise.all(sigs.map((s) => solana.confirmSignature(conn, s)));
  assert.deepStrictEqual(out, sigs, 'a batched confirmation must still resolve with its OWN signature');
  // Unbatched this is 5 signatures × 2 rounds = 10 calls.
  assert.ok(conn.calls.length <= 3, `${conn.calls.length} status calls for 5 confirmations — they are not being batched`);
  const first = conn.calls[0];
  assert.ok(first.length > 1, 'the first call carried one signature — nothing was coalesced');
});

test('each waiter gets ITS OWN status, not the first one in the batch', async () => {
  // The failure this guards: index the response array wrong and every wallet
  // reads wallet 1's result — four trades reported on one trade's outcome.
  const conn = fakeConn((s) => (s === 'good' ? landed : { err: { InstructionError: [0, 'x'] }, confirmationStatus: 'confirmed' }));
  const okP = solana.confirmSignature(conn, 'good');
  const badP = solana.confirmSignature(conn, 'bad');
  assert.strictEqual(await okP, 'good');
  await assert.rejects(badP, /transaction failed on-chain/, 'the failing signature resolved as the healthy one');
  assert.ok(conn.calls.some((c) => c.length === 2), 'the two were never in one call');
});

test('an RPC failure keeps polling — it does not fail five confirmations at once', async () => {
  // A batch that REJECTED would turn one blip into every in-flight trade
  // reporting "not confirmed". confirmSignature has always treated a transient
  // failure as "keep polling"; batching must not change that.
  let round = 0;
  const conn = {
    calls: [],
    async getSignatureStatuses(list) {
      conn.calls.push([...list]);
      if (++round === 1) throw new Error('429 Too Many Requests');
      return { value: list.map(() => landed) };
    },
  };
  const out = await Promise.all(['s1', 's2'].map((s) => solana.confirmSignature(conn, s)));
  assert.deepStrictEqual(out, ['s1', 's2']);
  assert.ok(round >= 2, 'it gave up after the first failure');
});

test('a signature nobody asked about is never answered for', async () => {
  // A late arrival must land in the NEXT batch, not be resolved with a read that
  // was already in flight before it started waiting.
  const conn = fakeConn(() => landed);
  await solana.confirmSignature(conn, 'first');
  const before = conn.calls.length;
  await solana.confirmSignature(conn, 'second');
  assert.ok(conn.calls.length > before, 'the second confirmation reused a status read that predates it');
  assert.ok(!conn.calls[0].includes('second'), 'a signature appeared in a batch issued before it existed');
});

test('the per-connection queue is dropped once nothing is waiting', async () => {
  // The first cut tested the pending map immediately after replacing it with an
  // empty one, so the cleanup could never fire. One connection is the normal
  // case and nothing leaked — but a line that cannot run is worse than no line,
  // because the next reader believes it does.
  const conn = fakeConn(() => landed);
  await solana.confirmSignature(conn, 'done');
  assert.strictEqual(solana._statusQ.size, 0, 'the queue kept an entry for a connection with nothing in flight');
  // …and it comes back cleanly for the next trade on the same connection.
  assert.strictEqual(await solana.confirmSignature(conn, 'again'), 'again');
});

test('an on-chain revert still throws, batched or not', async () => {
  const conn = fakeConn(() => ({ err: { InstructionError: [3, { Custom: 6001 }] }, confirmationStatus: 'confirmed' }));
  await assert.rejects(solana.confirmSignature(conn, 'reverted'), (e) => {
    assert.match(e.message, /transaction failed on-chain/);
    assert.ok(e.onChainError, 'the reason was dropped — callers branch on this to tell a revert from a timeout');
    return true;
  });
});

test('the timeout is still a timeout, and still says so', async () => {
  const conn = fakeConn(() => null);   // never lands
  await assert.rejects(solana.confirmSignature(conn, 'lost', { timeoutMs: 120, pollMs: 20 }), (e) => {
    assert.ok(e.timedOut, 'a timeout must stay distinguishable from a revert — one is ambiguous, the other is not');
    return true;
  });
});

test('batching can be turned off without changing behaviour', async () => {
  // The escape hatch, for an operator who finds the coalescing window costs more
  // than it saves on a fast private RPC.
  const prev = process.env.SOL_STATUS_BATCH_MS;
  process.env.SOL_STATUS_BATCH_MS = '0';
  delete require.cache[require.resolve('./solana')];
  const fresh = require('./solana');
  try {
    const conn = fakeConn(() => landed);
    assert.strictEqual(await fresh.confirmSignature(conn, 'x'), 'x');
    assert.deepStrictEqual(conn.calls[0], ['x'], 'with batching off the call shape changed');
  } finally {
    if (prev === undefined) delete process.env.SOL_STATUS_BATCH_MS; else process.env.SOL_STATUS_BATCH_MS = prev;
    delete require.cache[require.resolve('./solana')];
    require('./solana');
  }
});

// ── The phase timings ────────────────────────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');
const SOL = fs.readFileSync(path.join(__dirname, 'solana.js'), 'utf8');
const CORE = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');

test('every phase of a swap is measured, in order', () => {
  const fn = SOL.slice(SOL.indexOf('async function swap(conn, keypair'), SOL.indexOf('// ------------------------------- native SOL transfer'));
  for (const k of ['quote', 'guard', 'build']) assert.match(fn, new RegExp(`T\\.${k} = Date\\.now\\(\\) - t`), `${k} unmeasured`);
  const send = SOL.slice(SOL.indexOf('async function sendJupiterSwap('));
  assert.match(send, /T\.send = Date\.now\(\) - t;/);
  // In a FINALLY: a trade that gave up waiting is the one whose confirm time
  // most needs reading, and it reaches this through a throw.
  assert.match(send, /\} finally \{[\s\S]{0,220}T\.confirm = Date\.now\(\) - t;/);
});

test('a phase that never ran is not printed as 0ms', () => {
  // A zero that means "did not happen" reads as a finding. Only phases that
  // actually recorded a number appear.
  assert.match(CORE, /const _phases = \(T\) => \['quote', 'guard', 'build', 'send', 'confirm'\]/);
  assert.match(CORE, /\.filter\(\(k\) => Number\.isFinite\(T\[k\]\)\)/);
  const buy = CORE.slice(CORE.indexOf('async function _buySol('), CORE.indexOf('async function _sellSol('));
  // Logged on the failure path too — see above.
  assert.match(buy, /FAILED reads=\$\{tSwap - tStart\}ms \$\{_phases\(T\)\}/);
  assert.match(buy, /\[buy\] sol \$\{ca\.slice\(0, 8\)\} reads=\$\{tSwap - tStart\}ms \$\{_phases\(T\)\}/);
});

// ── The knobs an operator cannot otherwise verify ────────────────────────────

test('boot names both Solana execution knobs, and never the RPC url', () => {
  const TG = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  const boot = TG.slice(TG.indexOf("console.log(`[boot] chains enabled:"), TG.indexOf('// Which optional venues'));
  // Both default to something slow and both live only in tradebot/.env, so
  // without this the only way to learn whether either was picked up is to spend
  // real money and read `prio=` off a buy. An operator who edits the wrong file
  // gets no signal at all: the bot boots clean, trades fine, and stays slow.
  // ⚠️ THE RULE, NOT THE SPELLING. This used to pin the ternary verbatim, so it
  // went red the day "custom" started being asked of the hosts that SURVIVED
  // rather than of whether the variable was set — and would have passed on a
  // line that claimed "custom" over a list of refused placeholders. The
  // property is that the line reports the tier and that the verdict has one
  // owner (solana.rpcIsCustom), which is tested by being CALLED in
  // solBalanceBatch.test.js.
  assert.match(boot, /rpc \$\{sol[A-Za-z]*ustom \? 'custom' : 'PUBLIC default \(rate-limited\)'\}/);
  assert.match(boot, /solana\.rpcIsCustom\(/, 'the verdict is asked of the one owner');
  // ⚠️ The COUNT is the read walk, not the configured list. The read path
  // appends SOL_READ_FALLBACKS, so counting rpcUrls would print
  // "1 host (no failover)" on a box that has three — a claim that sends an
  // operator to add hosts it already has, on the line they check after an
  // outage. `custom` above still asks rpcUrls: the fallbacks are not an
  // override, and reporting them as one is the reassuring reading.
  assert.match(boot, /const solHosts = solana\.readUrls\(/, 'the host count is what a READ walks');
  assert.ok(!/const solHosts = solana\.rpcUrls\(/.test(boot), '…never the configured list alone');
  assert.match(boot, /priority fee \$\{prio > 0 \?/);
  assert.match(boot, /OFF — transactions queue behind every paying one/);
  // THE SECRET. A paid RPC carries its API key in the path, and this line goes
  // to pm2's log. Whether one is set is the fact; which one it is, is not.
  assert.ok(!/\$\{process\.env\.SOLANA_RPC\}/.test(boot), 'the RPC url — API key and all — is printed to the log');
  assert.ok(!/\$\{core\.CFG\.solanaRpc\}|\$\{CFG\.solanaRpc\}/.test(boot));
});
