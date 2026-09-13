'use strict';
/*
 * jupiterQuota.test.js — why five wallets could not buy one token.
 *
 * A live buy card, 2026-09-01: `$E5iD…pump`, wallets 2, 4 and 5, all at 23:03,
 * every one of them reading
 *
 *     ❌ Buy failed · Wallet 4
 *     Couldn't read live pricing for this token right now. Please try again in
 *     a moment.
 *
 * Nothing about that sentence is true of what happened, and the retry it invites
 * makes it worse. A five-wallet buy fired, in one millisecond: five BYTE-IDENTICAL
 * `/quote` GETs (the path is built from the mints, the amount and the slippage —
 * nothing about who is buying), five `/tokens` reads for the same mint, and five
 * `/swap` builds. Fifteen requests into `lite-api.jup.ag`, which is metered per
 * SOURCE ADDRESS. The overflow came back 429; `getQuote` threw
 * `Jupiter quote failed (429)`; and i18n's `/quote/` rule — written for a pool
 * read that failed — rendered our own spent request budget as a fact about the
 * token.
 *
 * These tests are offline: `global.fetch` is replaced, so they pin the budget,
 * the coalescing and the sentences WITHOUT depending on what Jupiter is doing
 * today.
 */
const test = require('node:test');
const assert = require('node:assert');

const solana = require('./solana');
const i18n = require('./i18n');

const realFetch = global.fetch;
// ⚠️ THE REQUEST BUDGET IS PROCESS STATE. A test that trips a 429 leaves a hold
// behind, and the next test then reads a rate limit it never caused — which
// looks exactly like a regression in the code under test. Stated, never
// inherited.
test.beforeEach(() => { solana._resetBudget(); });
test.afterEach(() => { global.fetch = realFetch; solana._resetBudget(); });

const QUOTE = { inAmount: '10000000', outAmount: '2500000', otherAmountThreshold: '2475000', priceImpactPct: '0.001' };
const MINT = 'E5iDD4kt9gDxTaAeoCNeN3CcZAWB7FvbPXwqJuuHpump';
const ARGS = { inputMint: solana.WSOL_MINT, outputMint: MINT, amountRaw: 10000000n, slippageBps: 100 };

/** A fetch that answers `plan[n]` for the n-th call and then repeats the last
 *  entry. Each entry is a status, optionally with a body and headers. */
function scripted(plan) {
  const calls = [];
  let i = 0;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const step = plan[Math.min(i++, plan.length - 1)];
    const status = step.status || 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => (step.headers || {})[String(k).toLowerCase()] || null },
      json: async () => (step.body === undefined ? QUOTE : step.body),
      text: async () => (typeof step.body === 'string' ? step.body : JSON.stringify(step.body === undefined ? QUOTE : step.body)),
      body: null,
    };
  };
  return calls;
}

// ── 1. Five wallets ask ONE question ─────────────────────────────────────────

test('identical in-flight quotes are coalesced into one request', async () => {
  // The five wallets of the reported buy. Same mints, same amount, same
  // slippage — so it is one question asked five times, and four of those five
  // requests bought nothing but a step towards the rate limit.
  const calls = scripted([{ status: 200 }]);
  const five = await Promise.all([0, 1, 2, 3, 4].map(() => solana.getQuote(ARGS)));
  assert.equal(calls.length, 1, 'five identical concurrent quotes must cost ONE request');
  for (const q of five) assert.equal(q.outAmount, 2500000n, 'every wallet still gets the quote');
});

test('a different amount is a different question and is NOT shared', async () => {
  // The coalescing key is the request path, so anything that changes the price
  // — the amount, the slippage, the mint — is its own request. A shared quote
  // across different sizes would authorise a trade at somebody else's price.
  const calls = scripted([{ status: 200 }]);
  await Promise.all([
    solana.getQuote(ARGS),
    solana.getQuote(Object.assign({}, ARGS, { amountRaw: 20000000n })),
    solana.getQuote(Object.assign({}, ARGS, { slippageBps: 300 })),
  ]);
  assert.equal(calls.length, 3);
});

test('it is NOT a cache — a later buy pays for a fresh price', async () => {
  // The whole safety argument. A quote is the only executable price on this
  // path, so a REMEMBERED one would be a stale price authorising a trade. Only
  // a request that has not yet answered is shared.
  const calls = scripted([{ status: 200 }]);
  await solana.getQuote(ARGS);
  await solana.getQuote(ARGS);
  assert.equal(calls.length, 2, 'a settled quote must never be replayed');
});

test('each caller gets its own quote object, not a shared one', async () => {
  scripted([{ status: 200 }]);
  const [a, b] = await Promise.all([solana.getQuote(ARGS), solana.getQuote(ARGS)]);
  assert.notStrictEqual(a, b, 'one wallet annotating its quote must not rewrite the other four');
  a.minOut = 1n;
  assert.equal(b.minOut, 2475000n);
});

test('a coalesced quote that FAILS fails every joiner, and the next buy re-asks', async () => {
  // A shared failure must not become a stuck entry: the map is cleared on
  // rejection too, or one bad second would blind the mint for the process.
  const calls = scripted([{ status: 400, body: { errorCode: 'COULD_NOT_FIND_ANY_ROUTE' } }, { status: 200 }]);
  const rs = await Promise.allSettled([solana.getQuote(ARGS), solana.getQuote(ARGS)]);
  assert.equal(rs[0].status, 'rejected');
  assert.equal(rs[1].status, 'rejected');
  assert.equal(calls.length, 1);
  const q = await solana.getQuote(ARGS);
  assert.equal(q.outAmount, 2500000n, 'the failure must not stick to the mint');
});

// ── 2. A 429 is waited out once, not paid five times ─────────────────────────

test('a 429 is retried on the same base and the buy goes through', async () => {
  // The reported failure, end to end: the first attempt is refused by our own
  // per-IP budget and the second one fills. This is the difference between a red
  // cross and a trade.
  const calls = scripted([{ status: 429, headers: { 'retry-after': '1' } }, { status: 200 }]);
  const q = await solana.getQuote(ARGS);
  assert.equal(q.outAmount, 2500000n);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /lite-api\.jup\.ag/, 'a 429 is re-asked on the SAME host, not failed over');
});

test('a 429 is recorded process-wide so the next request waits instead of spending its own', async () => {
  // `benched`, adapted for a user's trade: the four requests queued behind the
  // one that hit the limit must not each buy their own 429. For a TRADE the
  // answer is a pace, never a refusal — but a wait longer than a fill can afford
  // is reported rather than obeyed (a buy that sits for 30s then fills at a
  // half-minute-old price is worse than the red cross it replaced).
  //
  // The legacy base is scripted DEAD, which is what it really is — the point of
  // the test is that its transport failure must not overwrite the rate limit as
  // the reported reason.
  const hit = [];
  global.fetch = async (url) => {
    hit.push(String(url));
    if (String(url).includes('quote-api.jup.ag')) { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error('x'), { code: 'ENOTFOUND' }); throw e; }
    return { ok: false, status: 429, headers: { get: (k) => (String(k).toLowerCase() === 'retry-after' ? '30' : null) }, json: async () => ({}), text: async () => 'Too many requests', body: null };
  };
  await assert.rejects(() => solana.getQuote(ARGS), /rate-limiting/);
  const held = solana._budgets.get('lite-api.jup.ag');
  assert.ok(held && held.holdUntil > Date.now() + 20000, 'Retry-After must be honoured, not guessed');
  const onLite = hit.filter((u) => u.includes('lite-api')).length;
  // A second, DIFFERENT request now arrives while the hold stands.
  await assert.rejects(() => solana.getQuote(Object.assign({}, ARGS, { amountRaw: 999n })), /rate-limiting/);
  assert.equal(hit.filter((u) => u.includes('lite-api')).length, onLite,
    'a request made during the hold is a 429 we paid for twice');
});

test('a 429 reaches the OTHER base, because a bucket is not the request', async () => {
  // ⚠️ The failover rule's own stated reason — "the same request gets the same
  // status everywhere else" — is FALSE of a rate limit: 429 is a fact about the
  // bucket on THAT host, and a keyed base and the keyless one have different
  // ones. The same exception the IPFS gateway list carries for a 404. The first
  // cut of the retry returned the 429 without ever trying the second base,
  // which threw away the one fallback that could still have filled the trade.
  const seen = [];
  global.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes('lite-api')) {
      return { ok: false, status: 429, headers: { get: (k) => (String(k).toLowerCase() === 'retry-after' ? '600' : null) }, json: async () => ({}), text: async () => 'slow down', body: null };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => QUOTE, text: async () => '', body: null };
  };
  const q = await solana.getQuote(ARGS);
  assert.equal(q.outAmount, 2500000n, 'a throttled base must not fail a buy another base can fill');
  assert.ok(seen.some((u) => u.includes('quote-api.jup.ag')));
  assert.equal(solana.jupStats().refused, 0, 'nobody was refused — the trade filled');
});

test('…and also when the RETRIES are what ran out, not the patience', async () => {
  // ⚠️ THE TEST ABOVE PASSED FOR THE WRONG REASON AND THE MUTATION PROVED IT. A
  // `Retry-After: 600` leaves through the "longer than a trade can wait" branch,
  // so removing the failover from the EXHAUSTED-ATTEMPTS branch broke nothing
  // any test could see. Two branches reach the next base and both have to be
  // driven; a 429 with no Retry-After is the one that retries until it runs out.
  solana._resetBudget();
  const seen = [];
  global.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes('lite-api')) {
      return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}), text: async () => 'slow down', body: null };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => QUOTE, text: async () => '', body: null };
  };
  const q = await solana.getQuote(ARGS);
  assert.equal(q.outAmount, 2500000n);
  assert.equal(seen.filter((u) => u.includes('lite-api')).length, solana.JUP_RETRIES + 1, 'every attempt should have been spent before moving on');
  assert.ok(seen.some((u) => u.includes('quote-api.jup.ag')), 'out of retries is not out of options');
  assert.equal(solana.jupStats().refused, 0);
});

test('a 400 is never retried — the same request gets the same status everywhere', async () => {
  // The base-failover rule, unweakened: only 429 and 5xx mean "ask again".
  const calls = scripted([{ status: 400, body: { errorCode: 'COULD_NOT_FIND_ANY_ROUTE' } }]);
  await assert.rejects(() => solana.getQuote(ARGS));
  assert.equal(calls.length, 1, 'retrying a deterministic refusal only doubles the latency');
});

test('a 5xx is retried, because it is not an answer about the request', async () => {
  const calls = scripted([{ status: 503 }, { status: 200 }]);
  const q = await solana.getQuote(ARGS);
  assert.equal(q.outAmount, 2500000n);
  assert.equal(calls.length, 2);
});

test('a transport failure still fails OVER to the next base', async () => {
  // The standing rule, which the retry must not have replaced: a host that does
  // not answer at all is a host to leave, and that is how the retired
  // quote-api.jup.ag outage was survived.
  const seen = [];
  global.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes('lite-api')) { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error('x'), { code: 'ENOTFOUND' }); throw e; }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => QUOTE, text: async () => '', body: null };
  };
  const q = await solana.getQuote(ARGS);
  assert.equal(q.outAmount, 2500000n);
  assert.ok(seen.some((u) => u.includes('quote-api.jup.ag')), 'a dead host must not fail the buy');
});

// ── 3. The burst is paced ────────────────────────────────────────────────────

test('requests to one host are paced, so a fan-out is a queue and not a spike', async () => {
  // `lite-api.jup.ag` serves the quote, the swap-build AND the token registry,
  // so keying the pacer on the HOST is what makes those three share one budget
  // without any caller having to know that they do.
  assert.ok(solana.JUP_MIN_GAP_MS > 0, 'a default of 0 would make the fix depend on config');
  scripted([{ status: 200 }]);
  const t0 = Date.now();
  // Three DIFFERENT requests (coalescing cannot help here) — the case a
  // multi-wallet /swap fan-out actually is.
  await Promise.all([1, 2, 3].map((n) => solana.getQuote(Object.assign({}, ARGS, { amountRaw: BigInt(n * 1000) }))));
  assert.ok(Date.now() - t0 >= solana.JUP_MIN_GAP_MS * 2 - 20, 'three requests went out as one spike');
});

// ── 4. Three facts stopped being one sentence ────────────────────────────────

test('a rate limit is reported as OUR budget, not as the token having no price', async () => {
  // The reported message, and why it was the wrong one: it sent the user to look
  // at their token while the answer was the number of wallets they had selected.
  const key = i18n.errorKey('buy failed on Solana: Jupiter is rate-limiting this server (429) — Too many requests');
  assert.equal(key, 'err.rate_limited');
  const en = i18n.errorText('en', 'buy failed on Solana: Jupiter is rate-limiting this server (429)', 'buy');
  assert.match(en, /rate-limit/i);
  assert.match(en, /nothing was spent/i, 'after five red crosses, "did I pay?" is the first question');
  assert.match(en, /fewer wallets/i, 'a diagnosis with no hands attached is a bug report filed against the owner');
  assert.notEqual(en, i18n.errorText('id', 'Jupiter is rate-limiting this server (429)', 'buy'), 'both languages, like every other error here');
});

test("Jupiter's own refusal codes are reported as no route, not as 'try again in a moment'", () => {
  // The `err.no_route` comment already describes this defect for the
  // parsed-empty-quote door. This is the SAME fact arriving through the HTTP
  // status, which is the door that was left open: a user whose token simply has
  // no pool was told to keep retrying, and did.
  for (const raw of [
    'buy failed on Solana: Jupiter quote failed (400) — COULD_NOT_FIND_ANY_ROUTE',
    'buy failed on Solana: Jupiter quote failed (400) — The mint is not tradable',
    'buy failed on Solana: Jupiter quote failed (422) — no routes found for the requested pair',
  ]) assert.equal(i18n.errorKey(raw), 'err.no_route', raw);
  assert.doesNotMatch(i18n.errorText('en', 'Jupiter quote failed (400) — COULD_NOT_FIND_ANY_ROUTE', 'buy'), /try again in a moment/i);
});

test('a 5xx is reported as the router being down — theirs, not ours and not the token', () => {
  assert.equal(i18n.errorKey('buy failed on Solana: Jupiter quote is unavailable (503) — upstream'), 'err.upstream_down');
  assert.match(i18n.errorText('en', 'Jupiter swap-build is unavailable (502)', 'buy'), /nothing was spent/i);
});

test('a real pool-read failure still reports as no_price', () => {
  // The rule that was over-matching must still cover what it was written for.
  assert.equal(i18n.errorKey('could not read pool'), 'err.no_price');
  assert.equal(i18n.errorKey('pool read failed'), 'err.no_price');
});

test('a transport failure is still offline, never a rate limit', () => {
  // These are checked FIRST for a reason — "no answer before the timeout" is not
  // a budget problem, and the operator's next step is completely different.
  assert.equal(i18n.errorKey("can't reach lite-api.jup.ag — the name does not resolve from this server"), 'err.offline');
  assert.equal(i18n.errorKey('buy failed on Solana: fetch failed'), 'err.offline');
});

// ── 5. The operator stops being the detector ─────────────────────────────────

test('a refusal is counted; a 429 the retry got past is NOT', async () => {
  // ⚠️ THESE MUST NOT BE ONE NUMBER. A 429 the retry absorbed cost LATENCY; one
  // that reached the caller cost a TRADE. Alerting on the first is a channel
  // nobody reads by the second hour; not alerting on the second is exactly how
  // five red crosses went unseen until a person counted them in Telegram.
  scripted([{ status: 429, headers: { 'retry-after': '1' } }, { status: 200 }]);
  await solana.getQuote(ARGS);
  const a = solana.jupStats();
  assert.equal(a.absorbed, 1, 'a rate limit the retry got past is not a lost trade');
  assert.equal(a.refused, 0);
  assert.equal(a.r429, 1, '…but it still happened, and the count is the early warning');
  assert.ok(a.sinceOkMs != null);

  solana._resetBudget();
  scripted([{ status: 429, headers: { 'retry-after': '600' } }]);
  await assert.rejects(() => solana.getQuote(ARGS));
  const b = solana.jupStats();
  assert.equal(b.refused, 1, 'a rate limit that reached the caller IS a lost trade');
  assert.ok(b.sinceRefusedMs < 5000);
  assert.match(b.lastRefusedWhy, /429/);
});

test('a request held on one base and served by the next is NOT a refusal', async () => {
  // Booking that as a lost trade would make the alert fire on a budget that is
  // working — the counter has to mean what the alert claims it means.
  let n = 0;
  global.fetch = async (url) => {
    n++;
    // The first host refuses hard; the legacy base answers.
    if (String(url).includes('lite-api')) {
      return { ok: false, status: 429, headers: { get: (k) => (String(k).toLowerCase() === 'retry-after' ? '600' : null) }, json: async () => ({}), text: async () => 'slow down', body: null };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => QUOTE, text: async () => '', body: null };
  };
  // First call: lite refuses (counted), quote-api serves it.
  const q = await solana.getQuote(ARGS);
  assert.equal(q.outAmount, 2500000n);
  const before = solana.jupStats().refused;
  // Second, different call: lite is now HELD, so it is skipped entirely and
  // quote-api serves it. Nothing was refused to anybody.
  await solana.getQuote(Object.assign({}, ARGS, { amountRaw: 777n }));
  assert.equal(solana.jupStats().refused, before, 'a hold that another base absorbed is not a lost trade');
});

test('the watchdog probes the BUDGET, and does so without spending it', async () => {
  // ⚠️ `jupiter.quote` asks ONE question and the failed buy asked fifteen — a
  // single probe request is exactly what a spent budget still has room for, so
  // that probe can print 🟢 straight through this outage. And the fix is NOT to
  // probe harder: a watchdog firing five concurrent quotes every sweep would be
  // spending the budget it monitors.
  const upstreams = require('./upstreams');
  const p = upstreams.PROBES.find((x) => x.key === 'jupiter.budget');
  assert.ok(p, 'the budget has no probe — the watchdog is back to measuring only reachability');
  assert.equal(p.critical, true, 'a budget refusing buys is users unable to trade');
  assert.match(p.costs, /red cross|wallet/i, 'costs must say what the USER loses, not which host is down');

  let calls = 0;
  global.fetch = async () => { calls++; throw new Error('a budget probe must not make a request'); };
  const green = await p.run();
  assert.equal(calls, 0);
  assert.equal(green.ok, true, 'a clean box is green');

  // …and it goes red on a refusal, naming the knob rather than the host.
  scripted([{ status: 429, headers: { 'retry-after': '600' } }]);
  await assert.rejects(() => solana.getQuote(ARGS));
  const red = await p.run();
  assert.equal(red.ok, false);
  assert.match(red.detail, /JUP_API_KEY/, 'a diagnosis with no hands attached is a bug report filed against the owner');
  assert.match(red.detail, /fewer wallets/);
});

// ── 6. The fact is retrievable, not only printed once ────────────────────────

test('jup:check requires core BEFORE solana, or it reads an empty environment', () => {
  // ⚠️ ORDER IS THE RULE, NOT PRESENCE, and this repo has already shipped the
  // wrong version of this guard once: `loadEnv`'s first cut matched the call
  // ANYWHERE in the file, so deleting the real one at the top left it green.
  // `core.js` loads tradebot/.env into process.env and `solana.js` reads
  // JUP_API_KEY at MODULE-EVAL time — so requiring solana first reports an
  // operator's correctly-set key as missing, which is a diagnostic about
  // nothing. The assertion compares POSITIONS.
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('./scripts/jup-check.js'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const core = src.indexOf("'..', 'core'");
  const sol = src.indexOf("'..', 'solana'");
  assert.ok(core > 0 && sol > 0, 'the check no longer requires both — it cannot be reading the bot\'s own config');
  assert.ok(core < sol, 'solana is required before core, so JUP_API_KEY is read from an environment that has not been loaded yet');
});

test('jup:check never prints the key, not even a fragment', () => {
  // This output is read off a terminal that gets screenshotted. "set, 68 chars,
  // starts with jup_" answers the question without putting live credentials on
  // screen — the same rule the boot line follows for the RPC url, which carries
  // its own key in the path.
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('./scripts/jup-check.js'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Only the LENGTH and the leading 4 characters (which are the literal scheme
  // prefix every Jupiter key shares) may be printed.
  const slices = [...src.matchAll(/key\.slice\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(slices, ['0, 4'], 'a slice of the key beyond its 4-char prefix reached the screen');
  assert.doesNotMatch(src, /console\.log\([^)]*\bkey\b[^)]*\)/, 'the raw key must never be interpolated into output');
});

// ── 7. The key is the only thing that raises the ceiling ─────────────────────

test('JUP_API_KEY rides jup.ag requests and nothing else', () => {
  // A header applied BY HOST, so an operator's key is never posted to a base it
  // does not belong to. It is deliberately absent from every log line for the
  // reason the RPC url is: those go to pm2's log.
  const h = solana.jupHeaders('https://lite-api.jup.ag/swap/v1/quote', { accept: 'application/json' });
  assert.equal(h.accept, 'application/json');
  assert.equal(h['x-api-key'], undefined, 'no key configured in this environment');
  assert.equal(solana.jupKeyed(), false);
  assert.equal(solana.jupHeaders('https://frontend-api-v3.pump.fun/coins')['x-api-key'], undefined);
});

test('JUP_API_KEY moves the bases to the keyed host and sends the header', () => {
  // The only thing that RAISES the ceiling rather than dividing it — the
  // `GECKOTERMINAL_API_KEY` rule, one API over. Driven, not source-scanned:
  // a scan cannot tell a key that is configured from one that is sent.
  const path = require.resolve('./solana');
  const before = process.env.JUP_API_KEY;
  try {
    process.env.JUP_API_KEY = 'test-key-abc';
    delete require.cache[path];
    const fresh = require('./solana');
    assert.equal(fresh.jupKeyed(), true);
    assert.match(fresh.JUP_BASES[0], /^https:\/\/api\.jup\.ag/, 'the keyed host must lead');
    // Both spellings Jupiter's docs use, because a key on the wrong one is a
    // 401 and a 401 does not fail over on the standing rule.
    assert.ok(fresh.JUP_BASES.some((b) => /pro-api\.jup\.ag/.test(b)), 'the other documented paid host was dropped');
    assert.match(fresh.JUP_BASES[fresh.JUP_BASES.length - 1], /lite-api/, 'the free tier must be LAST — the safety net under a refused key');
    assert.equal(fresh.jupHeaders('https://api.jup.ag/swap/v1/quote')['x-api-key'], 'test-key-abc');
    // …and NOWHERE ELSE. A key posted to a host it does not belong to is a
    // leaked credential; this is a header applied by HOST for that reason.
    assert.equal(fresh.jupHeaders('https://frontend-api-v3.pump.fun/coins')['x-api-key'], undefined);
    assert.equal(fresh.jupHeaders('https://api.dexscreener.com/x')['x-api-key'], undefined);
    assert.equal(fresh.jupHeaders('https://jup.ag.evil.example/quote')['x-api-key'], undefined,
      'the host check must be an anchored suffix, or a lookalike domain harvests the key');
  } finally {
    if (before === undefined) delete process.env.JUP_API_KEY; else process.env.JUP_API_KEY = before;
    delete require.cache[path];
    require('./solana');
  }
});

test('a REFUSED key degrades to the keyless tier instead of breaking every buy', async () => {
  // ⚠️ THE HAZARD THE KEY ITSELF INTRODUCES. Jupiter's docs name the paid host
  // as both `api.jup.ag` and `pro-api.jup.ag`; a key sent to the wrong one
  // answers 401, and a 401 is NOT a transport error — so without this, setting
  // JUP_API_KEY would turn a rate limit into a total outage, i.e. the fix being
  // strictly worse than the bug. "You are not allowed here" is a fact about the
  // host+credential pairing, never about the request — the same exception the
  // 429 gets, for the same reason.
  const path = require.resolve('./solana');
  const before = process.env.JUP_API_KEY;
  const warns = [];
  const realWarn = console.warn;
  try {
    process.env.JUP_API_KEY = 'wrong-key';
    delete require.cache[path];
    const fresh = require('./solana');
    fresh._resetBudget();
    console.warn = (...a) => warns.push(a.join(' '));
    const seen = [];
    global.fetch = async (url) => {
      seen.push(String(url));
      if (!String(url).includes('lite-api')) {
        return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}), text: async () => 'invalid api key', body: null };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => QUOTE, text: async () => '', body: null };
    };
    const q = await fresh.getQuote(ARGS);
    assert.equal(q.outAmount, 2500000n, 'a bad key must not be able to stop a buy the free tier can serve');
    assert.ok(seen.some((u) => u.includes('lite-api')), 'the keyless tier must sit LAST in the keyed list as the safety net');
    // ⚠️ …and it may not be silent: "the key works" and "the key is being
    // ignored" would otherwise be one observation, which is this repo's most
    // expensive recurring shape.
    assert.equal(warns.length, 1, 'a refused key must be said exactly once — not per request, not never');
    assert.match(warns[0], /JUP_API_KEY/);
    assert.match(warns[0], /still work/i, 'it must say the buys are fine, or it reads as an outage');
  } finally {
    console.warn = realWarn;
    if (before === undefined) delete process.env.JUP_API_KEY; else process.env.JUP_API_KEY = before;
    delete require.cache[path];
    require('./solana');
  }
});

test('the budget knobs read a BLANK env as absent, not as zero', () => {
  // ⚠️ `Number('')` is 0 and 0 is FINITE. A bare `JUP_MIN_GAP_MS=` in .env would
  // otherwise mean no pacing at all and `JUP_RETRIES=` would mean never retry —
  // which is exactly the state this file exists to end, arrived at silently.
  // Third time this repo has been bitten by a falsy-but-valid number.
  const path = require.resolve('./solana');
  const before = process.env.JUP_MIN_GAP_MS;
  try {
    process.env.JUP_MIN_GAP_MS = '';
    delete require.cache[path];
    const fresh = require('./solana');
    assert.ok(fresh.JUP_MIN_GAP_MS > 0, 'a blank env var switched the pacer off');
    process.env.JUP_MIN_GAP_MS = '0';
    delete require.cache[path];
    assert.equal(require('./solana').JUP_MIN_GAP_MS, 0, 'an explicit 0 is a real, honoured 0');
  } finally {
    if (before === undefined) delete process.env.JUP_MIN_GAP_MS; else process.env.JUP_MIN_GAP_MS = before;
    delete require.cache[path];
    require('./solana');
  }
});
