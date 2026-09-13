'use strict';
/*
 * jupiterHost.test.js — the Solana buy path's transport.
 *
 * A live buy card, 2026-08-14: five wallets, five red crosses, every one of them
 * reading "buy failed on Solana: fetch failed" — and above them a green
 * "✅ Bought $ · 0/5 wallets · spent 0.00000 ETH ($0.00)". Three separate
 * defects met on one screen:
 *
 *   1. The Jupiter base was the retired `quote-api.jup.ag/v6`. A withdrawn host
 *      does not answer with a status you can read — DNS stops resolving and
 *      undici throws, so no amount of HTTP-level error handling sees it.
 *   2. `fetch failed` is undici's message for EVERY transport failure; the only
 *      useful part is in `err.cause`, and it was being dropped. Blocked egress,
 *      a dead host, a TLS failure and a timeout all printed the same two words.
 *   3. The receipt claimed success anyway, in the wrong currency.
 *
 * These tests are offline: `global.fetch` is replaced, so they pin the failover
 * and the message WITHOUT depending on which host Jupiter is serving today.
 */
const test = require('node:test');
const assert = require('node:assert');

const solana = require('./solana');
const i18n = require('./i18n');

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

/** A fetch that fails at the transport for `deadHosts` and answers for the rest,
 *  the way undici does: TypeError('fetch failed') with the real reason in cause. */
function fakeFetch(deadHosts, body) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (deadHosts.some((h) => String(url).includes(h))) {
      const e = new TypeError('fetch failed');
      e.cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      throw e;
    }
    return { ok: true, status: 200, json: async () => body };
  };
  return calls;
}

const QUOTE = { inAmount: '10000000', outAmount: '2500000', otherAmountThreshold: '2475000' };
const ARGS = { inputMint: solana.WSOL_MINT, outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amountRaw: 10000000n };

// ── The base is resolved, not assumed ────────────────────────────────────────

test('both known Jupiter bases are configured, current one first', () => {
  // Keeping the legacy host means a rollover in EITHER direction needs no
  // deploy — which is the whole point, since which one is live is a fact about
  // Jupiter today and not about this code.
  assert.ok(solana.JUP_BASES.length >= 2, 'a single base is a single point of failure again');
  assert.match(solana.JUP_BASES[0], /lite-api\.jup\.ag\/swap\/v1/);
  assert.ok(solana.JUP_BASES.some((b) => /quote-api\.jup\.ag\/v6/.test(b)), 'the legacy base was dropped');
});

test('a dead base fails over to the live one instead of failing the buy', async () => {
  const calls = fakeFetch(['lite-api.jup.ag'], QUOTE);
  const q = await solana.getQuote(ARGS);
  assert.strictEqual(q.outAmount, 2500000n);
  assert.ok(calls.some((u) => u.includes('quote-api.jup.ag')), 'the second base was never tried');
});

test('the base that answered is reused, so a dead host is not paid for twice', async () => {
  const calls = fakeFetch(['lite-api.jup.ag'], QUOTE);
  await solana.getQuote(ARGS);
  const n = calls.length;
  await solana.getQuote(ARGS);
  assert.strictEqual(calls.length - n, 1, 'the known-dead base is being probed again on every trade');
});

test('every base down produces a reason, not "fetch failed"', async () => {
  fakeFetch(['jup.ag'], QUOTE);
  await assert.rejects(() => solana.getQuote(ARGS), (e) => {
    assert.ok(!/^fetch failed$/.test(e.message), 'undici\'s bare message reached the caller');
    assert.match(e.message, /can't reach .*jup\.ag/, 'the message does not name the host');
    assert.match(e.message, /does not resolve/, 'the syscall code in err.cause was dropped');
    assert.strictEqual(e.offline, true, 'callers cannot classify this without re-matching the text');
    return true;
  });
});

test('an HTTP status does NOT fail over — the host answered', async () => {
  // A 400 from the right host would be a 400 from every other one too. Retrying
  // it elsewhere only doubles the latency of a request that was always going to
  // fail, on the path where latency is the product.
  const calls = [];
  global.fetch = async (url) => { calls.push(String(url)); return { ok: false, status: 400, json: async () => ({}) }; };
  await assert.rejects(() => solana.getQuote(ARGS), /Jupiter quote failed \(400\)/);
  assert.strictEqual(calls.length, 1, 'a bad request was replayed against the other base');
});

test('JUP_BASE pins one host and is never overruled', () => {
  // The escape hatch. Same contract as <CHAIN>_V4_POOLMANAGER: an override AND a
  // discovery skip, so an operator can pin a host this code has not heard of.
  //
  // ⚠️ THIS USED TO BE A SOURCE SCAN FOR A LITERAL LINE, and it therefore failed
  // on an edit that left the rule perfectly intact (the base list gained a keyed
  // tier). A test about formatting is not a test about behaviour — it is the
  // `POOL_TTL` guard's defect, one repo over. It re-requires the module with the
  // env set and reads what it actually resolved.
  const path = require.resolve('./solana');
  const keep = { b: process.env.JUP_BASE, t: process.env.JUP_TOKEN_BASE, k: process.env.JUP_API_KEY };
  try {
    process.env.JUP_BASE = 'https://my-own-jup.example/v1';
    process.env.JUP_TOKEN_BASE = 'https://my-own-tokens.example';
    process.env.JUP_API_KEY = 'not-a-real-key';   // a pin outranks even the keyed tier
    delete require.cache[path];
    const fresh = require('./solana');
    assert.deepEqual(fresh.JUP_BASES, ['https://my-own-jup.example/v1'], 'a pinned base is a SKIP as well as an override');
    assert.deepEqual(fresh.JUP_TOKEN_BASES, ['https://my-own-tokens.example']);
  } finally {
    for (const [k, v] of [['JUP_BASE', keep.b], ['JUP_TOKEN_BASE', keep.t], ['JUP_API_KEY', keep.k]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    delete require.cache[path];
    require('./solana');
  }
});

// ── netErr ───────────────────────────────────────────────────────────────────

test('each transport failure gets its own sentence', () => {
  const of = (cause, name) => {
    const e = new TypeError('fetch failed'); e.cause = cause; if (name) e.name = name;
    return solana.netErr(e, 'https://lite-api.jup.ag/swap/v1/quote').message;
  };
  assert.match(of({ code: 'ENOTFOUND' }), /does not resolve/);
  assert.match(of({ code: 'ECONNREFUSED' }), /refused/);
  assert.match(of({ code: 'ETIMEDOUT' }), /timed out/);
  assert.match(of({ code: 'CERT_HAS_EXPIRED' }), /TLS failed/);
  assert.match(of({}, 'TimeoutError'), /before the timeout/);
  // …and all of them name the host, which is the operator's half of the answer.
  assert.match(of({ code: 'ENOTFOUND' }), /lite-api\.jup\.ag/);
});

test('the token registry fails over the same way', async () => {
  const calls = fakeFetch(['lite-api.jup.ag'], { symbol: 'BONK', name: 'Bonk', decimals: 5 });
  const meta = await solana.jupTokenMeta('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
  assert.strictEqual(meta.sym, 'BONK');
  assert.ok(calls.some((u) => u.includes('tokens.jup.ag')), 'the legacy registry base was never tried');
});

test('an unreachable registry never throws — a trade still records', async () => {
  // splMeta falls back to a shortened mint. A missing ticker must not be able to
  // fail a buy that otherwise worked.
  fakeFetch(['jup.ag'], {});
  assert.strictEqual(await solana.jupTokenMeta('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'), null);
});

// ── Classification ───────────────────────────────────────────────────────────

test('a transport failure is its own error class, not "try again in a moment"', () => {
  for (const m of ['buy failed on Solana: fetch failed',
    "can't reach lite-api.jup.ag — the name does not resolve from this server",
    'getaddrinfo ENOTFOUND quote-api.jup.ag', 'connect ECONNREFUSED 1.2.3.4:443']) {
    assert.strictEqual(i18n.errorKey(m), 'err.offline', m);
  }
});

test('"nothing was sent" is the load-bearing half of that sentence', () => {
  // The old classification was err.unconfirmed — "your buy may still complete,
  // check your wallet before trying again" — which is the opposite of true and
  // sends someone hunting for a transaction that was never broadcast.
  assert.match(i18n._strings['err.offline'].en, /never sent|nothing was spent/i);
  assert.match(i18n._strings['err.offline'].id, /tidak pernah dikirim|tidak ada dana/i);
  assert.notStrictEqual(i18n._strings['err.offline'].en, i18n._strings['err.offline'].id);
});

test('a real on-chain failure is not swallowed by the offline rule', () => {
  // The offline rule runs FIRST, so it has to be narrow enough not to catch the
  // trade errors whose wording overlaps ("timeout", "not confirmed").
  assert.strictEqual(i18n.errorKey('transaction was not confirmed in 30.00 seconds'), 'err.unconfirmed');
  assert.strictEqual(i18n.errorKey('insufficient funds for gas'), 'err.insufficient');
  // err.no_ROUTE since the two were split: this line's point is that the offline
  // rule does not swallow it, and that still holds. The split exists because
  // "no route" was rendering as "couldn't read pricing, try again in a moment"
  // under a 🔄 Try again button, so a token with no tradable pool had users
  // retrying it forever — see i18n.test.js.
  assert.strictEqual(i18n.errorKey('no route / no liquidity for this token on Jupiter'), 'err.no_route');
  assert.notStrictEqual(i18n.errorKey('no route / no liquidity for this token on Jupiter'), 'err.offline');
  assert.strictEqual(i18n.errorKey('execution reverted: IIA'), 'err.slippage');
});

test('a sell does not escalate gas against an unreachable host', () => {
  // sellWithRetry raises gas and slippage twice more on a "retriable" error.
  // None of that can make a name resolve, and each round tells the user it is
  // "raising gas & slippage to complete the sell" — three lies for one outage.
  const src = require('node:fs').readFileSync(require.resolve('./telegram.js'), 'utf8');
  const line = /const _retriable = \(m\) => i18n\.errorKey\(m\) !== 'err\.offline'/;
  assert.match(src, line, 'a transport failure is retriable again');
});

// ── The lesson the host failover did not carry ───────────────────────────────
// Moving a base is not the same as moving an API. Measured on the production box
// after the failover shipped: /quote answered on lite-api.jup.ag and /swap on the
// SAME base returned 500 — because the POST body was still v6-shaped.

test("the swap body never sends v6's 'auto' priority string", () => {
  // SOL_PRIORITY_LAMPORTS defaults to 0, so this was sent on EVERY trade from a
  // stock box. The current /swap/v1 endpoint rejects it; omitting the field asks
  // for the same thing and is accepted by both APIs.
  const body = solana.swapBody({ q: 1 }, 'SomePubkey', {});
  assert.ok(!('prioritizationFeeLamports' in body), "the field is present with no priority set — it used to be 'auto'");
  assert.ok(!JSON.stringify(body).includes('auto'), "'auto' is back in the swap body");
});

test('an explicit priority is still sent, as a number', () => {
  const body = solana.swapBody({ q: 1 }, 'SomePubkey', { priorityLamports: 50000 });
  assert.strictEqual(body.prioritizationFeeLamports, 50000);
  assert.strictEqual(typeof body.prioritizationFeeLamports, 'number');
});

test('a refusal carries what Jupiter actually said, not just a status', () => {
  // "Jupiter swap-build failed (500)" was true, useless, and cost a round of
  // guessing about which field the newer API disliked — while the answer was in
  // the response body being discarded one line later. Same defect as undici's
  // bare "fetch failed".
  global.fetch = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: 'Invalid prioritizationFeeLamports' }) });
  return assert.rejects(() => solana.getQuote(ARGS), (e) => {
    assert.match(e.message, /500/);
    assert.match(e.message, /Invalid prioritizationFeeLamports/, 'the response body was dropped');
    return true;
  });
});

// ── pump.fun: the same host migration, the same failover ─────────────────────

test('pump.fun has a base list too, v3 first', () => {
  assert.ok(solana.PUMPFUN_BASES.length >= 2, 'a single hardcoded host is back');
  assert.match(solana.PUMPFUN_BASES[0], /frontend-api-v3\.pump\.fun/);
  assert.ok(solana.PUMPFUN_BASES.some((b) => /frontend-api\.pump\.fun/.test(b)), 'the legacy host was dropped');
});

test('a dead pump.fun host fails over instead of reporting a quiet launchpad', () => {
  const calls = fakeFetch(['frontend-api-v3.pump.fun'], [
    { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', name: 'Bonk', symbol: 'BONK', created_timestamp: 1 },
  ]);
  return solana.pumpfunNewX(5).then((r) => {
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.coins.length, 1);
    assert.ok(calls.some((u) => u.includes('frontend-api.pump.fun')), 'the legacy base was never tried');
  });
});

test('"the feed is gone" and "nothing launched" stop being the same answer', () => {
  // The snipe loop's `if (!coins.length) return` counted as a SUCCESSFUL tick, so
  // /health showed a green solSnipe while discovery had been blind for days.
  fakeFetch(['pump.fun'], []);
  return solana.pumpfunNewX(5).then((r) => {
    assert.strictEqual(r.ok, false, 'an unreachable feed still reports ok');
    assert.match(r.why, /can't reach|unreachable/, 'the reason is empty');
    assert.deepStrictEqual(r.coins, []);
  });
});

test('an HTTP status from pump.fun is reported as an answer, not as silence', () => {
  global.fetch = async () => ({ ok: false, status: 429, json: async () => [] });
  return solana.pumpfunNewX(5).then((r) => {
    assert.strictEqual(r.ok, false);
    assert.match(r.why, /429/, 'a rate-limit is indistinguishable from an empty launchpad');
  });
});

test('the old array-returning signature still works for existing callers', () => {
  fakeFetch([], [{ mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', name: 'Bonk', symbol: 'BONK' }]);
  return solana.pumpfunNew(5).then((a) => {
    assert.ok(Array.isArray(a), 'pumpfunNew stopped returning an array — watchers.js indexes it');
    assert.strictEqual(a.length, 1);
  });
});

test('the swap-build probe never reuses the derivation anchor address', () => {
  // MN is the standard BIP39 test-vector mnemonic, so MN_SOL is a heavily-used
  // public address whose accounts carry whatever strangers have done to them.
  // A real run failed with "Token account Hpjz… is owned by usdc8UkQ… instead of
  // the user" — a fact about that address, reported to the operator as a reason
  // not to trade. The anchor keeps its own job; the probe gets a fresh key.
  const pf = require('node:fs').readFileSync(require.resolve('./scripts/solana-preflight.js'), 'utf8');
  const build = pf.slice(pf.indexOf("await check('Jupiter swap-build"), pf.indexOf("await check('DexScreener"));
  assert.ok(!/getSwapTx\(q\.raw, MN_SOL/.test(build), 'the probe is back on the shared test address');
  assert.match(build, /const probe = Keypair\.generate\(\)\.publicKey\.toBase58\(\)/);
  assert.match(build, /getSwapTx\(q\.raw, probe/);
  // …and the anchor check must still use the mnemonic, or the regression guard
  // it exists to be is gone.
  assert.match(pf, /const a = solana\.deriveKeypair\(MN\)\.publicKey\.toBase58\(\)/);
  assert.match(pf, /if \(a !== MN_SOL\) throw new Error\('derivation changed!/);
});
