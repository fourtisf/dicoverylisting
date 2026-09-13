'use strict';
/*
 * solBalanceBatch.test.js — "liat ini skrg trading bot mengapa tidak baca saldo
 * solana": /wallet reporting `Couldn't reach Solana` on all five wallets while
 * every EVM chain answered.
 *
 * Not flakiness — arithmetic. The dashboard reads wallets × chains at once, so
 * five separate `getBalance` calls landed on the public Solana endpoint in the
 * same millisecond, it rate-limited the burst, and web3.js retried past the
 * screen's 2.5s bound. `getSignatureStatuses` was batched for exactly this
 * reason ("five wallets were throttling each other") and `getMultipleAccounts`
 * takes an array too — a lesson applied to one of two siblings.
 *
 * These tests DRIVE the real reader against a stub Connection that COUNTS
 * requests and refuses a burst, because "it makes fewer requests" is a property
 * no source scan can see.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sol = require('./solana');

// Real base58 pubkeys — PublicKey parses these, so nothing here is measuring a
// rejected address instead of a request.
const ADDRS = [
  'HrX1QdULJEgitbNohZTh36cQTSCAiZSjWVw3DMUCmVSD',
  '11111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ComputeBudget111111111111111111111111111111',
];

/** A node that serves batches and REFUSES anything past `limit` requests —
 *  the behaviour of the public endpoint this whole fix is about. */
function stubConn({ limit = Infinity, lamports = 1_000_000n, fail = null, hang = false } = {}) {
  const c = { calls: 0, batched: [] };
  c.getMultipleAccountsInfo = async (keys) => {
    c.calls += 1;
    c.batched.push(keys.length);
    // A host that never answers — NOT the same as one that refuses. No timer,
    // so this leaks nothing; the read's own slice is what has to end it.
    if (hang) return new Promise(() => {});
    if (fail) throw fail;
    if (c.calls > limit) throw new Error('429 Too Many Requests');
    return keys.map(() => ({ lamports: Number(lamports) }));
  };
  return c;
}

test('every wallet is ONE request, not one per wallet', async () => {
  const c = stubConn();
  const r = await sol.solBalancesX(c, ADDRS);
  assert.equal(r.ok, true);
  assert.equal(c.calls, 1, 'five wallets must cost one request — this is the reported bug');
  assert.deepEqual(c.batched, [5]);
  assert.deepEqual(r.bals, ADDRS.map(() => 1_000_000n));
});

test('…so a node that refuses a BURST still answers the wallet screen', async () => {
  // The reported state: the endpoint serves one request and rate-limits the
  // rest of the wave. Per-wallet reads lose four of five cells; batched, none.
  const c = stubConn({ limit: 1 });
  const r = await sol.solBalancesX(c, ADDRS);
  assert.equal(r.ok, true, 'the batch fits inside the one request the node allows');
  assert.ok(r.bals.every((b) => b === 1_000_000n));

  // The same node, asked the old way, loses everything after the first.
  const c2 = stubConn({ limit: 1 });
  const one = await Promise.all(ADDRS.map((a) => sol.solBalancesX(c2, [a])));
  assert.equal(one.filter((x) => x.ok).length, 1, 'the shape that produced the screenshot');
});

test('a NULL account is a real zero, never an unread cell', async () => {
  // Solana answers null for an address nobody has funded — which is what a
  // fresh wallet is. Reading that as "could not ask" would park every new
  // wallet in the unread column for ever.
  const c = { calls: 0, getMultipleAccountsInfo: async (k) => { c.calls++; return k.map(() => null); } };
  const r = await sol.solBalancesX(c, ADDRS.slice(0, 2));
  assert.equal(r.ok, true);
  assert.deepEqual(r.bals, [0n, 0n]);
});

test('⚠️ the reason travels — a 429, a refusal and a timeout are three sentences', async () => {
  const cases = [
    ['429 Too Many Requests', /rate-limiting/],
    ['403 Forbidden', /refused this server/],
    ['fetch failed', /could not reach/],
  ];
  for (const [msg, re] of cases) {
    const r = await sol.solBalancesX(stubConn({ fail: new Error(msg) }), ADDRS);
    assert.equal(r.ok, false);
    assert.match(r.why, re, `"${msg}" must not collapse into the same shrug`);
  }
});

test('a refusal fails over to the NEXT host — a bucket is per host', async () => {
  // The standing base rule is transport-only, and a 429 is the documented
  // exception: it is a fact about the bucket on THAT host.
  const dead = stubConn({ fail: new Error('429 Too Many Requests') });
  const live = stubConn();
  const r = await sol.solBalancesX(dead, ADDRS, { conns: [dead, live] });
  assert.equal(r.ok, true, 'the second host was never asked');
  assert.equal(live.calls, 1);
});

test('…and the reason reported is the FIRST host\'s, not the last', async () => {
  const a = stubConn({ fail: new Error('429 Too Many Requests') });
  const b = stubConn({ fail: new Error('fetch failed') });
  const r = await sol.solBalancesX(a, ADDRS, { conns: [a, b] });
  assert.equal(r.ok, false);
  assert.match(r.why, /rate-limiting/, 'the later host\'s dead socket must not bury the rate limit that started it');
});

test('SOLANA_RPC is a LIST, and blank still resolves to the shipped default', () => {
  assert.deepEqual(sol.rpcUrls('https://a.example , https://b.example'), ['https://a.example', 'https://b.example']);
  assert.equal(sol.rpcUrls('https://one.example').length, 1);
  assert.equal(sol.rpcUrls('  ').length, 1, 'a blank override may not leave us with no host at all');
  assert.equal(sol.rpcUrls('').length, 1);
});

test('the single-address read still answers null on failure (its old contract)', async () => {
  assert.equal(await sol.solBalanceOrNull(stubConn({ fail: new Error('boom') }), ADDRS[0]), null);
  assert.equal(await sol.solBalanceOrNull(stubConn(), ADDRS[0]), 1_000_000n);
});

test('an unparseable address is ITS OWN answer, never the host\'s', async () => {
  const c = stubConn();
  const r = await sol.solBalancesX(c, [ADDRS[0], 'not-a-pubkey']);
  assert.equal(r.ok, true, 'one bad address must not mark the whole column unread');
  assert.equal(r.bals[0], 1_000_000n);
  assert.equal(r.bals[1], null);
  assert.deepEqual(c.batched, [1], 'and it is not sent to the node');
});

// ── the wiring, because a batch nothing calls is a batch that never helps ────

const src = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('⚠️ the screens read a COLUMN — a per-wallet read is the defect', () => {
  const t = src('telegram.js');
  assert.match(t, /async function readNativeColumn\(/);
  assert.match(t, /core\.nativeBalances\(c\.key, addrs\)/, 'and through core, not by reaching into solana.js');
  // The dashboard matrix and the sweep picker are the two screens that list
  // wallets; either one asking per wallet puts the burst straight back.
  assert.match(t, /readNativeColumn\(list, c\)/, 'the /wallet matrix');
  assert.match(t, /readNativeColumn\(list, ch\)/, 'the sweep picker');
  const wave = t.slice(t.indexOf('const colsP'), t.indexOf('const tokenBagsP'));
  assert.doesNotMatch(wave, /readNative\(w, c\)/, 'the per-cell read must not come back');
});

test('core.nativeBalances batches on svm and keeps EVM per-address', () => {
  const c = src('core.js');
  const fn = c.slice(c.indexOf('async function nativeBalances('), c.indexOf('\n}', c.indexOf('async function nativeBalances(')) + 2);
  assert.match(fn, /solana\.solBalancesX\(/, 'one request on Solana');
  assert.match(fn, /conns: solana\.readConnections\(/, 'with the host list');
  assert.match(fn, /p\.getBalance\(a\)/, 'EVM is unchanged — those endpoints are not the ones refusing us');
});

test('⚠️ the reason a chain went unread has ONE owner on the screen', () => {
  // This guard used to pin the reason to a POSITION — inside the active
  // wallet's block — and so went red over code that keeps its rule on more
  // surfaces through one owner, while passing on the code that broke it. That
  // is this repo's own recurring defect (the four-way pool TTL, the
  // `{ ok: true,` build stamp), and it is what let the reported screen say the
  // 429 once at the top and `⚠️ 1 chain(s) unread` on four rows underneath.
  //
  // The rule is ONE WRITE, ONE READ: a second reader is how one of them loses
  // it. The proof that the sentence reaches the reader is DRIVEN, in
  // walletRender.test.js — a source scan cannot tell a line that renders from
  // one that is merely written down.
  const t = src('telegram.js');
  assert.match(t, /chainWhy\[c\.key\] = cols\[ci\]\.why/, 'the reason is captured per chain');
  assert.equal((t.match(/chainWhy\[/g) || []).length, 2, 'one write, one read');
  assert.match(t, /byWhy/, 'grouped by REASON, so one dead host behind two chains is one line');
});

test("⚠️ the READ connections switch web3.js's 429 retry OFF", () => {
  // Measured in node_modules, not assumed: web3.js answers a 429 by retrying
  // five times with 500ms → 1s → 2s → 4s of backoff — 7.5 SECONDS before it
  // returns an error. The wallet screen waits 2500ms, so one 429 could never
  // finish inside the window, and the retries kept hitting the endpoint long
  // after the screen gave up. The SIGNING connection keeps the retry.
  const c = src('solana.js');
  const rc = c.slice(c.indexOf('function readConnections('), c.indexOf('async function solBalance('));
  assert.match(rc, /disableRetryOnRateLimit: true/);
  const gc = c.slice(c.indexOf('function getConnection('), c.indexOf('function rpcUrls('));
  assert.doesNotMatch(gc, /disableRetryOnRateLimit/, 'a confirmation that waits out a 429 is doing its job');
  // ⚠️ …AND THEY MUST BE SEPARATE OBJECTS, which no source scan can see: alias
  // the read cache to the signing one and `disableRetryOnRateLimit` is decided
  // by whichever call happened to construct the url first. Driven.
  const url = 'https://sol-read-vs-sign.example';
  assert.notStrictEqual(sol.readConnections(url)[0], sol.getConnection(url),
    'the read connection IS the signing connection — the retry-off is a coin toss');
  assert.strictEqual(sol.readConnections(url)[0], sol.readConnections(url)[0], 'and still cached');
});

test('every Solana read goes through ONE door in core', () => {
  const c = src('core.js');
  const eb = c.slice(c.indexOf('async function ethBalanceOrNull('));
  assert.match(eb.slice(0, eb.indexOf('\n}') + 2), /nativeBalances\(chainKey, \[addr\]\)/);
  const br = c.slice(c.indexOf('async function _balanceResilient('), c.indexOf('async function walletFunds('));
  assert.match(br, /nativeBalances\(chainKey, \[addr\]\)/, 'the removal survey too — two doors is how two screens disagree');
});

// ── The placeholder that was pasted into a live shell ─────────────────────────
// `SOLANA_RPC=https://endpoint-berbayar-anda,…` — "your paid endpoint" — handed
// over as a pasteable line and pasted verbatim. This repo's first rule, and the
// fix it prescribes is that the CODE refuses a value that cannot be right.

test('a placeholder host is refused, and a real one beside it survives', () => {
  const out = sol.rpcUrls('https://endpoint-berbayar-anda,https://api.mainnet-beta.solana.com');
  assert.deepEqual(out, ['https://api.mainnet-beta.solana.com']);
});

test('a list of nothing but placeholders falls back to the built-in host', () => {
  // Never leave no host at all: a bad paste degrades to today's behaviour.
  assert.deepEqual(sol.rpcUrls('https://endpoint-berbayar-anda'), ['https://api.mainnet-beta.solana.com']);
});

test('the dot is the test — a scheme check sees nothing wrong with the paste', () => {
  assert.equal(sol.rpcUsable('https://endpoint-berbayar-anda'), false, 'parses fine, resolves nowhere');
  assert.equal(sol.rpcUsable('https://your-endpoint-here'), false);
  assert.equal(sol.rpcUsable('https://…'), false);
  // …and everything an operator might legitimately set still passes.
  assert.equal(sol.rpcUsable('https://mainnet.helius-rpc.com/?api-key=abc'), true);
  assert.equal(sol.rpcUsable('https://api.mainnet-beta.solana.com'), true);
  assert.equal(sol.rpcUsable('http://localhost:8899'), true, 'the one legitimate dotless host');
});

test('a refused entry is WARNED about, and the warning never prints the path', () => {
  const seen = [];
  const w = console.warn; console.warn = (m) => seen.push(String(m));
  try { sol.rpcUrls('https://endpoint-berbayar-anda/secret-key-in-the-path'); }
  finally { console.warn = w; }
  assert.equal(seen.length, 1, 'being ignored silently is how "it did not work" and "it was never read" become one observation');
  assert.match(seen[0], /SOLANA_RPC/, 'name the variable');
  assert.match(seen[0], /endpoint-berbayar-anda/, 'name the host so it can be found');
  assert.doesNotMatch(seen[0], /secret-key-in-the-path/, 'a paid endpoint carries its key in the path, and this goes to pm2');
});

// ── A host that just refused us is not asked again ───────────────────────────

/** A stub that reports an endpoint, so the park has something to key on. */
function stubAt(url, opts) { return Object.assign(stubConn(opts), { rpcEndpoint: url }); }

test('a 429 parks the host — the next read spends no request at all', async () => {
  sol._rpcUnpark();
  const c = stubAt('https://one.example/rpc', { limit: 0 });
  const a = await sol.solBalancesX(c, ADDRS, { conns: [c] });
  assert.equal(a.ok, false);
  assert.equal(c.calls, 1);
  assert.match(a.why, /rate-limiting/);

  const b = await sol.solBalancesX(c, ADDRS, { conns: [c] });
  assert.equal(c.calls, 1, 'every /wallet render must not re-prove a refusal we already have');
  assert.equal(b.ok, false);
  assert.match(b.why, /rate-limiting/, 'and the screen still says the same true sentence');
  sol._rpcUnpark();
});

test('a TIMEOUT does not park — that says nothing about a quota', async () => {
  sol._rpcUnpark();
  const c = stubAt('https://slow.example/rpc', { fail: new Error('request timed out') });
  await sol.solBalancesX(c, ADDRS, { conns: [c] });
  await sol.solBalancesX(c, ADDRS, { conns: [c] });
  assert.equal(c.calls, 2, 'a host that is merely slow is still asked');
  sol._rpcUnpark();
});

test('a parked host does not stop the next one from answering', async () => {
  sol._rpcUnpark();
  const bad = stubAt('https://bad.example/rpc', { limit: 0 });
  const good = stubAt('https://good.example/rpc');
  const a = await sol.solBalancesX(bad, ADDRS, { conns: [bad, good] });
  assert.equal(a.ok, true, 'failover still runs on the first pass');

  const b = await sol.solBalancesX(bad, ADDRS, { conns: [bad, good] });
  assert.equal(b.ok, true);
  assert.equal(bad.calls, 1, 'the refused host is skipped');
  assert.equal(good.calls, 2, 'and the one that works takes the calls');
  sol._rpcUnpark();
});

test('a connection reporting no endpoint is never parked', async () => {
  // An `undefined` key would park under one entry and skip EVERY host at once.
  sol._rpcUnpark();
  const c = stubConn({ limit: 0 });
  await sol.solBalancesX(c, ADDRS, { conns: [c] });
  const other = stubConn();
  const r = await sol.solBalancesX(other, ADDRS, { conns: [other] });
  assert.equal(r.ok, true, 'an unrelated connection must not inherit that park');
  assert.equal(other.calls, 1);
  sol._rpcUnpark();
});

test('"custom" is a claim about what SURVIVED, not about what was typed', () => {
  // The boot line is what an operator reads after setting SOLANA_RPC. Reporting
  // a list of refused placeholders as "custom" tells them their override is
  // live while every read still goes to the public default.
  assert.equal(sol.rpcIsCustom('https://endpoint-berbayar-anda'), false, 'nothing survived — this box is on the default');
  assert.equal(sol.rpcIsCustom('https://api.mainnet-beta.solana.com'), false);
  assert.equal(sol.rpcIsCustom('https://endpoint-berbayar-anda,https://api.mainnet-beta.solana.com'), false);
  assert.equal(sol.rpcIsCustom('https://mainnet.helius-rpc.com/?api-key=abc'), true);
  assert.equal(sol.rpcIsCustom('https://mine.example/rpc,https://api.mainnet-beta.solana.com'), true, 'a real host beside the default IS custom');
});

/* ────────────────────────────────────────────────────────────────────────────
 * "solana masih unread", a fourth time — and the failover shipped INERT.
 *
 * SOL_DEFAULT_RPC is ONE host, so on a box nobody has configured `rpcUrls`
 * returns a single entry and there is nowhere to fail over TO: the machinery
 * landed, the screen still said `Couldn't reach Solana`, and "a fallback that
 * cannot fire reads exactly like one that never helps" is this repo's own name
 * for it. The two hosts appended are not guesses — `bot/src/config/rpc.js` has
 * shipped exactly them on this same box since it was written.
 * ──────────────────────────────────────────────────────────────────────────── */

const FB = ['https://solana-rpc.publicnode.com', 'https://solana.drpc.org'];

test('a default box has somewhere to fail over TO — the reported defect', () => {
  const read = sol.readUrls(null);
  assert.ok(read.length > 1, 'one host is no failover, which is what `Couldn\'t reach Solana` was');
  assert.equal(read[0], 'https://api.mainnet-beta.solana.com', 'the shipped default still leads');
  for (const u of FB) assert.ok(read.includes(u), `${u} must be reachable from a read`);
});

test("an operator's own host is never displaced by a public fallback", () => {
  const read = sol.readUrls('https://mine.example/rpc');
  assert.equal(read[0], 'https://mine.example/rpc', 'a paid endpoint leads, always');
  assert.deepEqual(read.slice(1), FB, 'the fallbacks sit BEHIND it');
});

test('a fallback the operator already named is not asked twice', () => {
  const read = sol.readUrls('https://solana.drpc.org,https://mine.example/rpc');
  assert.equal(read.filter((u) => u === 'https://solana.drpc.org').length, 1);
});

test('SOL_READ_FALLBACK=0 removes them, and BLANK is ON', () => {
  // Blank ≠ false — the `raid/sourceFlag.js` rule. A bare `SOL_READ_FALLBACK=`
  // in .env must not silently switch the failover back off.
  const keep = process.env.SOL_READ_FALLBACK;
  try {
    process.env.SOL_READ_FALLBACK = '0';
    assert.deepEqual(sol.readUrls(null), ['https://api.mainnet-beta.solana.com']);
    process.env.SOL_READ_FALLBACK = '';
    assert.ok(sol.readUrls(null).length > 1, 'blank is ON');
    delete process.env.SOL_READ_FALLBACK;
    assert.ok(sol.readUrls(null).length > 1, 'absent is ON');
  } finally {
    if (keep === undefined) delete process.env.SOL_READ_FALLBACK;
    else process.env.SOL_READ_FALLBACK = keep;
  }
});

test('⚠️ SIGNING does not move — the fallbacks are APPENDED, never prepended', () => {
  // The standing rule refuses a guessed endpoint "on the chain that signs
  // trades". Reads may walk; a swap is built, signed and confirmed against one
  // node's view of the chain.
  //
  // ⚠️ What enforces that is the append ORDER, which the two tests above
  // mutation-test. `getConnection` reading readUrls[0] instead of rpcUrls[0] is
  // behaviour-neutral — rpcUrls never returns empty, so the first entry is the
  // same host either way — and this says so rather than claiming cover it does
  // not provide.
  assert.equal(sol.getConnection('https://mine.example/rpc').rpcEndpoint, 'https://mine.example/rpc');
  assert.equal(sol.getConnection(null).rpcEndpoint, 'https://api.mainnet-beta.solana.com',
    'a default box signs on the default host, not on a fallback');
  assert.deepEqual(sol.rpcUrls(null), ['https://api.mainnet-beta.solana.com'],
    'rpcUrls stays the CONFIGURED list — it is what signing and rpcIsCustom read');
});

test('⚠️ a default box is still not "custom" — the fallbacks are not an override', () => {
  // rpcIsCustom asks rpcUrls. Asking readUrls would print "custom" on the boot
  // line of every box on the public endpoint — the reassuring reading, on the
  // one line an operator checks after setting SOLANA_RPC.
  assert.equal(sol.rpcIsCustom(null), false);
  assert.equal(sol.rpcIsCustom('https://mine.example/rpc'), true);
});

test('readConnections walks the READ list, not the configured one', () => {
  const conns = sol.readConnections(null);
  assert.deepEqual(conns.map((c) => c.rpcEndpoint), sol.readUrls(null));
});

test('⚠️ a HANGING host does not consume the whole read — the next one answers', async () => {
  // Without a per-host slice the wallet column's 2500ms budget is eaten by host
  // 1 and hosts 2 and 3 are never asked, on every render, for ever: the
  // fallback above defeated by the failure it is for. curveTrade's STAGE_MS
  // rule, on the read the screen waits for.
  sol._rpcUnpark();
  const dead = stubAt('https://hangs.example/rpc', { hang: true });
  const good = stubAt('https://good.example/rpc');
  const t0 = Date.now();
  const r = await sol.solBalancesX(dead, ADDRS, { conns: [dead, good] });
  const ms = Date.now() - t0;
  assert.equal(r.ok, true, 'the walk must reach the host that answers');
  assert.equal(good.calls, 1);
  assert.ok(ms < 2500, `the read must finish inside the screen's window, took ${ms}ms`);
  sol._rpcUnpark();
});

test('…and a slice that ran out does NOT park — a timeout is no fact about a quota', async () => {
  sol._rpcUnpark();
  const dead = stubAt('https://hangs2.example/rpc', { hang: true });
  await sol.solBalancesX(dead, ADDRS, { conns: [dead] });
  await sol.solBalancesX(dead, ADDRS, { conns: [dead] });
  assert.equal(dead.calls, 2, 'a host that is merely slow is still asked — the gt.ts line');
  sol._rpcUnpark();
});

test('SOL_HOST_MS is a knob, and it is clamped', () => {
  const src = fs.readFileSync(path.join(__dirname, 'solana.js'), 'utf8');
  const expr = (src.match(/const SOL_HOST_MS = (.*);/) || [])[1];
  assert.ok(expr, 'SOL_HOST_MS must still be one declaration');
  const at = (v) => eval(expr.replace('process.env.SOL_HOST_MS', JSON.stringify(v)));
  assert.equal(at(undefined), 1200, 'unset is the shipped default');
  assert.equal(at(''), 1200, "blank is ABSENT — Number('') is 0, and a 0 slice reads every host as dead");
  assert.equal(at('400'), 400);
  assert.equal(at('1'), 200, 'never a slice too short for a healthy round trip');
  assert.equal(at('999999'), 10000, 'never one that can outlast the screen many times over');
});

test('⚠️ the slice timer is CLEARED — a fast answer does not hold the loop open', async () => {
  // Not unref'd (a read is being awaited, and an unref'd timer lets a process
  // with nothing else pending exit with the caller hung) — so it has to be
  // cleared, or every read holds the event loop for the full slice after a
  // 50ms answer. Third time this scar is written in this repo; MEASURED with
  // getActiveResourcesInfo rather than reasoned about.
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const before = timers();
  const c = stubConn();
  const r = await sol.solBalancesX(c, ADDRS, { conns: [c] });
  assert.equal(r.ok, true);
  assert.equal(timers(), before, 'the slice timer outlived the read it was bounding');
});
