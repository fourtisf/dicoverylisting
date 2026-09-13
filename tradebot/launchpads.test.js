'use strict';
/*
 * launchpads.test.js — the pre-migration data path, offline.
 *
 * WHAT THIS IS ABOUT
 * DexScreener and GeckoTerminal index pools. A token on a bonding curve has no
 * pool, so for its whole pre-migration life the trade card said "❌ Couldn't
 * price it" about a token trading perfectly well on its launchpad — and every
 * Solana token that WAS indexed got `graduated: true, progressPct: 100`
 * hardcoded onto it, so one sitting at 12% of a curve was labelled "◆ DEX".
 *
 * Every test here replaces `global.fetch`, so none of them depends on which
 * host a launchpad is serving today — the point that `launchpads:check` exists
 * to answer, and which a test cannot.
 */
const test = require('node:test');
const assert = require('node:assert');

const lp = require('../shared/launchpads');
const P = require('../shared/launchpads/pads');
const N = require('../shared/launchpads/normalize');
const shim = require('./launchpads');

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const OTHER = 'So11111111111111111111111111111111111111112';

/** Serve canned bodies by host substring. Anything unmatched is a TRANSPORT
 *  failure, shaped exactly like undici's — the failure mode that costs the most
 *  when it is guessed at instead of read. */
function serve(routes, onCall) {
  global.fetch = async (url, init) => {
    if (onCall) onCall(url, init);
    for (const [frag, res] of Object.entries(routes)) {
      if (!String(url).includes(frag)) continue;
      if (typeof res === 'number') return { ok: res >= 200 && res < 300, status: res, text: async () => '', json: async () => ({}) };
      return { ok: true, status: 200, text: async () => JSON.stringify(res), json: async () => res };
    }
    const e = new TypeError('fetch failed');
    e.cause = { code: 'ENOTFOUND' };
    throw e;
  };
}

const pumpBody = (over) => ({
  mint: MINT, name: 'Curve Kid', symbol: 'CURVE',
  description: 'A token that has not migrated yet and still deserves a card with numbers on it.',
  image_uri: 'https://i.example/a.png', twitter: 'curveproj', telegram: 'curvechat', website: 'https://curve.example',
  created_timestamp: 1755300000000, complete: false, usd_market_cap: 23150,
  real_token_reserves: 400000000000000, real_sol_reserves: 30000000000,
  ...over,
});
const jupBody = (over) => [{
  id: MINT, name: 'Curve Kid', symbol: 'CURVE', usdPrice: 0.0000231, mcap: 23150,
  liquidity: 8400, holderCount: 143, launchpad: 'pump.fun', bondingCurve: 49.6,
  stats24h: { buyVolume: 5000, sellVolume: 3000 },
  ...over,
}];

function reset(env) {
  for (const k of Object.keys(process.env)) if (/^LAUNCHPAD/.test(k)) delete process.env[k];
  Object.assign(process.env, env || {});
  lp.reload();
}
test.afterEach(() => { delete global.fetch; reset(); });

// ── the fact this module exists to carry ─────────────────────────────────────

test('a token no indexer has ever seen still produces a full record', async () => {
  reset();
  serve({ 'pump.fun': pumpBody(), 'jup.ag': jupBody() });
  const r = await lp.tokenRecord('solana', MINT);
  assert.ok(r.ok);
  const m = r.record;
  assert.equal(m.symbol, 'CURVE');
  assert.equal(m.onCurve, true, 'a bonding token was not reported as bonding');
  assert.equal(m.graduated, false);
  assert.equal(m.launchpad, 'pump.fun');
  assert.ok(m.mcapUsd > 0 && m.priceUsd > 0);
  assert.equal(m.twitter, 'https://x.com/curveproj', 'a bare handle was not expanded');
  assert.equal(m.telegram, 'https://t.me/curvechat');
  assert.ok(m.description, 'the project description was dropped');
});

test('"nobody answered" and "nobody knows it" stay different facts', async () => {
  reset();
  // Every pad answers, none has the token: that is an ANSWER, and a caller must
  // be able to say "not a launchpad token" rather than "the launchpads are down".
  serve({ 'pump.fun': 404, 'jup.ag': [], 'raydium.io': 404, 'moonshot.cc': 404 });
  const known = await lp.tokenRecord('solana', MINT);
  assert.equal(known.record, null);
  assert.equal(known.ok, true, 'an answered "no" was reported as an outage');

  reset();
  serve({});   // nothing resolves
  const dead = await lp.tokenRecord('solana', MINT);
  assert.equal(dead.record, null);
  assert.equal(dead.ok, false, 'a dead network was reported as "no such token"');
  assert.match(dead.why, /does not resolve/, 'the transport reason was discarded');
});

test('an HTTP status never fails over to the next base', async () => {
  reset();
  let hosts = [];
  serve({ 'frontend-api-v3': 500, 'jup.ag': [], 'raydium.io': 404, 'moonshot.cc': 404 }, (u) => hosts.push(String(u)));
  await lp.tokenRecord('solana', MINT);
  const pumpHosts = hosts.filter((h) => /pump\.fun/.test(h));
  // A 500 means the host is there and answered; the legacy base would answer
  // the same way, so retrying it only doubles the latency of a doomed request.
  assert.equal(pumpHosts.length, 1, `a 500 was retried on ${pumpHosts.length} hosts`);
  assert.ok(/frontend-api-v3/.test(pumpHosts[0]));
});

// ── the path a base list never covered ───────────────────────────────────────
//
// `$ORCHFLOWS` (Pons, Robinhood) went out to 12,514 subscribers drawing the
// Dexvra mark over a token whose logo renders on ponsfamily.com. The pad's HTTP
// shape is a GUESS — the host refuses this repo's egress, so nothing here can
// read the real one — and the base list is not insurance against that: failover
// between bases is transport-only, so the FIRST spelling that resolves and 404s
// used to end the lookup for ever.
const PONS_TOKEN = '0x36B44a8034Fe0eEddb8819dA82128bD6959161A6';
const PONS_BODY = { address: PONS_TOKEN, name: 'orchflows', symbol: 'ORCHFLOWS', image: 'ipfs://bafkorch', usdPrice: 0.000005, marketCap: 4741.81 };

test('⚠️ a 404 tries the NEXT token path — a wrong spelling is not a dead pad', async () => {
  reset({ LAUNCHPAD_FLAP: '0' });
  const seen = [];
  // The third spelling answers; the two in front of it 404, which is the host
  // saying "not that resource" and NOT "not this token".
  serve({ '/tokens/': PONS_BODY, '/launchpad/': 404, '/token/': 404 }, (u) => seen.push(String(u)));
  const r = await lp.tokenRecord('robinhood', PONS_TOKEN);
  assert.ok(r.record, `every spelling was abandoned at the first 404: ${seen.join(', ')}`);
  assert.equal(r.record.symbol, 'ORCHFLOWS');
  assert.equal(r.record.logoUrl, 'ipfs://bafkorch', 'the artwork the whole round is about');
  assert.ok(seen.some((u) => /\/launchpad\/0x36B4/i.test(u)), 'the shipped first guess was not tried first');
  assert.ok(seen.some((u) => /\/tokens\/0x36B4/i.test(u)), 'the answering spelling was never asked');
});

test('…and every OTHER status still stops at the first path', async () => {
  reset({ LAUNCHPAD_FLAP: '0' });
  const seen = [];
  // A 429 or a 500 says the host is there and unhappy. It says nothing about
  // which spelling is right, so three more requests would only prove the same
  // refusal three more times — the CoinGecko-sweep defect, one transport over.
  serve({ '/launchpad/': 500, '/token': PONS_BODY }, (u) => seen.push(String(u)));
  const r = await lp.tokenRecord('robinhood', PONS_TOKEN);
  assert.equal(r.record, null, 'a 500 was treated as "try the next spelling"');
  assert.equal(seen.filter((u) => /ponsfamily/.test(u)).length, 1, `a 500 was retried on ${seen.length} paths`);
});

test("…and an operator's own pin REPLACES the list, never leads it", async () => {
  reset({ LAUNCHPAD_FLAP: '0', LAUNCHPAD_PONS_TOKEN_PATH: '/v2/coin/{id}' });
  const seen = [];
  serve({ '/v2/coin/': PONS_BODY }, (u) => seen.push(String(u)));
  const r = await lp.tokenRecord('robinhood', PONS_TOKEN);
  assert.ok(r.record, 'the pinned path was not used');
  const pons = seen.filter((u) => /ponsfamily/.test(u));
  assert.equal(pons.length, 1, `four guesses were asked in front of the operator's own path: ${pons.join(', ')}`);
  assert.match(pons[0], /\/v2\/coin\/0x36B4/i);

  // ⚠️ AND A PIN THAT 404s STAYS THE ONLY PATH ASKED. Falling through to the
  // built-in guesses behind it would answer from a spelling the operator did
  // not choose — so a wrong pin would read as a working one, which is the one
  // thing a pin exists to make visible. (The list-leading mutant is invisible
  // while the pin ANSWERS: this is the case that sees it.)
  reset({ LAUNCHPAD_FLAP: '0', LAUNCHPAD_PONS_TOKEN_PATH: '/v2/coin/{id}' });
  const after = [];
  serve({ '/v2/coin/': 404, '/launchpad/': PONS_BODY, '/tokens/': PONS_BODY }, (u) => after.push(String(u)));
  const missed = await lp.tokenRecord('robinhood', PONS_TOKEN);
  assert.equal(missed.record, null, 'a built-in guess answered behind the operator\'s own pinned path');
  assert.equal(after.filter((u) => /ponsfamily/.test(u)).length, 1, `the pin was followed by ${after.length - 1} guesses`);
});

test('every 404 IS the pad answering it does not know the token — and that is cached', async () => {
  reset({ LAUNCHPAD_FLAP: '0' });
  let calls = 0;
  serve({ 'ponsfamily': 404 }, () => { calls++; });
  const first = await lp.tokenRecord('robinhood', PONS_TOKEN);
  assert.equal(first.ok, true, 'an answered "no" was reported as an outage');
  assert.equal(first.record, null);
  const spent = calls;
  await lp.tokenRecord('robinhood', PONS_TOKEN);
  assert.equal(calls, spent, 'the all-404 answer was not cached — every card would pay four requests');
});

test('a transport failure DOES fail over, and remembers which base answered', async () => {
  reset();
  const seen = [];
  serve({ 'frontend-api.pump.fun/coins': pumpBody() }, (u) => seen.push(String(u)));   // v3 unreachable, legacy up
  const r = await lp.tokenRecord('solana', MINT);
  assert.ok(r.record, 'the legacy base was never tried');
  assert.ok(seen.some((u) => /frontend-api-v3/.test(u)), 'the current base was not tried first');
});

// ── the cost of a pad being down ─────────────────────────────────────────────

test('a dead pad is benched, so it stops costing a timeout on every card', async () => {
  reset({ LAUNCHPAD_BREAKER_TRIPS: '2' });
  let calls = 0;
  serve({}, () => { calls++; });
  for (let i = 0; i < 4; i++) await lp.tokenRecord('solana', MINT);
  const settled = calls;
  const r = await lp.tokenRecord('solana', MINT);
  assert.equal(calls, settled, 'a benched pad was still being called');
  // Benched, never SILENT: a source that has quietly stopped being consulted is
  // the kind of thing that stays broken for months.
  assert.ok(r.tried.every((t) => t.skipped), 'the bench is invisible to the caller');
  assert.ok(r.tried.every((t) => /failures in a row/.test(t.why)));
});

test('an HTTP status does not bench a pad — only a transport failure does', async () => {
  reset({ LAUNCHPAD_BREAKER_TRIPS: '1' });
  serve({ 'pump.fun': 429, 'jup.ag': 429, 'raydium.io': 429, 'moonshot.cc': 429 });
  for (let i = 0; i < 3; i++) await lp.tokenRecord('solana', MINT);
  const r = await lp.tokenRecord('solana', MINT);
  // Benching on a 429 would take a merely rate-limited source out for five
  // minutes over one bad second.
  assert.ok(r.tried.every((t) => !t.skipped), 'a rate limit benched the pad');
});

test('an answered 404 is cached; a transport failure is not', async () => {
  reset();
  let calls = 0;
  serve({ 'pump.fun': 404, 'jup.ag': 404, 'raydium.io': 404, 'moonshot.cc': 404 }, () => { calls++; });
  await lp.tokenRecord('solana', MINT);
  const afterFirst = calls;
  await lp.tokenRecord('solana', MINT);
  assert.equal(calls, afterFirst, '"never heard of it" was asked twice');

  reset();
  calls = 0;
  serve({}, () => { calls++; });
  await lp.tokenRecord('solana', MINT);
  const afterDead = calls;
  await lp.tokenRecord('solana', MINT);
  // Caching a throttled or transient miss spreads one bad second across the
  // whole TTL — the same rule core.js dsPairsX keeps.
  assert.ok(calls > afterDead, 'a transport failure was cached as an answer');
});

test('a blank env var leaves the default alone', () => {
  // Number('') is 0 — finite and non-negative — so the obvious spelling of this
  // silently replaced EVERY default with zero: no caching at all, and a breaker
  // that trips after 0 failures for 0ms. Nothing errored; the module just
  // stopped doing the two things that keep it cheap.
  reset({ LAUNCHPAD_CACHE_MS: '', LAUNCHPAD_BREAKER_TRIPS: '', LAUNCHPAD_TIMEOUT_MS: '' });
  let calls = 0;
  serve({ 'pump.fun': 404, 'jup.ag': 404, 'raydium.io': 404, 'moonshot.cc': 404 }, () => { calls++; });
  return lp.tokenRecord('solana', MINT).then(async () => {
    const afterFirst = calls;
    await lp.tokenRecord('solana', MINT);
    assert.equal(calls, afterFirst, 'a blank LAUNCHPAD_CACHE_MS disabled the cache');
  });
});

// ── merging several pads ─────────────────────────────────────────────────────

test('curve state is taken WHOLE from one pad, never assembled from two', async () => {
  reset();
  // pump.fun says migrated (with a pool to prove it); Jupiter still carries a
  // stale 49.6%. Taking "graduated" from one and "49.6%" from the other is a
  // card contradicting itself in two places — the same defect as the buy card's
  // two ideas of "whale".
  serve({ 'pump.fun': pumpBody({ complete: true, raydium_pool: 'Poo1Address11111111111111111111111111111111' }), 'jup.ag': jupBody() });
  const m = (await lp.tokenRecord('solana', MINT)).record;
  assert.equal(m.graduated, true);
  assert.equal(m.onCurve, false);
  assert.equal(m.progressPct, 100, 'a graduated token kept a bonding percentage');
  assert.equal(m.curvePad, 'pumpfun', 'evidence lost to a reading');
});

test('a stated percentage beats a derived one, and says which it is', async () => {
  reset();
  serve({ 'pump.fun': pumpBody(), 'jup.ag': jupBody({ bondingCurve: 12 }) });
  const m = (await lp.tokenRecord('solana', MINT)).record;
  assert.equal(m.progressPct, 12);
  assert.equal(m.progressSource, 'api');
  // Two pads far apart is a fact worth keeping — silence about a contradiction
  // is how a wrong number survives for months.
  assert.ok(m.progressDisagreement, 'a 12% vs ~50% disagreement was swallowed');
});

test('a pad that answers about a DIFFERENT token is dropped', async () => {
  reset();
  serve({ 'pump.fun': pumpBody({ mint: OTHER }), 'jup.ag': jupBody() });
  const r = await lp.tokenRecord('solana', MINT);
  assert.equal(r.record.pads.includes('pumpfun'), false, "a stranger's token reached the record");
  assert.equal(r.record.address, MINT);
});

test('a list wrapped in an envelope is scanned before the envelope is unwrapped', () => {
  // `{ data: { rows: [ …the token… ] } }` unwrapped first becomes "the token is
  // `{ rows: [...] }`" — a launchpad that answered correctly, read as one that
  // knows nothing.
  const row = { mint: MINT, name: 'X', symbol: 'X' };
  assert.deepEqual(P.one({ data: { rows: [row] } }, 'solana', MINT, ['mint']), row);
  assert.deepEqual(P.one({ code: 0, data: row }, 'solana', MINT, ['mint']), row);
  assert.deepEqual(P.one([row], 'solana', MINT, ['mint']), row);
  assert.equal(P.one({ data: { rows: [] } }, 'solana', MINT, ['mint']), null);
});

// ── pump.fun's own numbers ───────────────────────────────────────────────────

test('pump.fun raised/target is carried as a fact, the percentage as an estimate', async () => {
  reset({ LAUNCHPAD_JUPITER: '0' });   // pump.fun alone, so nothing else supplies a stated %
  serve({ 'pump.fun': pumpBody() });
  const m = (await lp.tokenRecord('solana', MINT)).record;
  assert.equal(m.raisedNative, 30, 'lamports were not converted to SOL');
  assert.equal(m.targetNative, 85);
  assert.equal(m.progressSource, 'derived', 'a derived number was presented as stated');
  assert.ok(m.progressPct > 45 && m.progressPct < 55);
});

test('nonsense reserves produce no percentage rather than a wrong one', async () => {
  reset({ LAUNCHPAD_JUPITER: '0' });
  serve({ 'pump.fun': pumpBody({ real_token_reserves: 99999999999999999, real_sol_reserves: -5 }) });
  const m = (await lp.tokenRecord('solana', MINT)).record;
  assert.equal(m.progressPct, null, 'an impossible reserve figure became a progress bar');
  assert.equal(m.raisedNative, null);
});

// ── config contracts ─────────────────────────────────────────────────────────

test('<PAD>_API pins one host and skips the base list', () => {
  reset({ LAUNCHPAD_PUMPFUN_API: 'https://mirror.example/coins' });
  assert.deepEqual(lp.basesOf('pumpfun'), ['https://mirror.example/coins']);
});

test('an existing PUMPFUN_API is honoured, not outvoted by a second env var', () => {
  process.env.PUMPFUN_API = 'https://legacy-override.example/coins';
  try {
    reset();
    assert.deepEqual(lp.basesOf('pumpfun'), ['https://legacy-override.example/coins']);
  } finally { delete process.env.PUMPFUN_API; }
});

test('blank is not false — a pad is off only if somebody said so', () => {
  reset({ LAUNCHPAD_MOONSHOT: '' });
  assert.ok(lp.enabled().some((p) => p.key === 'moonshot'), 'a bare "LAUNCHPAD_MOONSHOT=" turned the pad off');
  reset({ LAUNCHPAD_MOONSHOT: '0' });
  assert.ok(!lp.enabled().some((p) => p.key === 'moonshot'));
  reset({ LAUNCHPADS: '0' });
  assert.equal(lp.enabled().length, 0, 'the registry kill switch did nothing');
});

test('a pad is never asked about a chain it cannot know', () => {
  reset();
  assert.deepEqual(lp.padsFor('bsc').map((p) => p.key), ['fourmeme']);
  assert.deepEqual(lp.padsFor('base').map((p) => p.key), ['virtuals']);
  assert.deepEqual(lp.padsFor('ethereum'), []);
});

// ── timestamps ───────────────────────────────────────────────────────────────

test('a timestamp that has not happened yet is not a timestamp', () => {
  const now = 1755300000000;
  assert.equal(N.toMs(now - 1000, now), now - 1000);
  assert.equal(N.toMs(now + 3600000, now), null, 'a far-future stamp was accepted');
  assert.equal(N.toMs(Math.floor(now / 1000), now), now - (now % 1000), 'seconds were not upscaled');
  // The snipe cursor advances to the newest launch it has seen. One bogus
  // future stamp would push it past every real launch and the snipe would go
  // quiet forever — silently, because a cursor ahead of the feed looks exactly
  // like a slow day on the launchpads.
});

// ── the trade bot's own shaping ──────────────────────────────────────────────

test('a curve snapshot is never routable on the strength of having a price', () => {
  const rec = { priceUsd: 0.001, mcapUsd: 20000, liqUsd: null, symbol: 'C', name: 'C', launchpad: 'pump.fun', progressPct: 40, progressSource: 'api', graduated: false, raisedNative: 30, targetNative: 85 };
  const s = shim.curveSnapshot(MINT, 'solana', rec, 190);
  // Reading a number off an HTTP API says nothing about whether a swap can be
  // FILLED — the line v4.js draws between price() and canSwapLive(). core.js
  // upgrades this only after the aggregator has actually quoted the mint.
  assert.equal(s.routable, false);
  assert.equal(s.dex, false, 'a bonding token would render as "◆ DEX"');
  assert.equal(s.graduated, false);
  // NULL, not 0: "💧 Liquidity 0.000 SOL" reads as a rug, and it is what stops
  // the card falling through to "🚀 Raised 30 / 85 SOL".
  assert.equal(s.liquiditySol, null);
  assert.equal(s.liquidityUsd, null);
  assert.equal(s.raised, 30);
});

test('an overlay changes nothing unless a pad SAID the token is on a curve', () => {
  assert.equal(shim.curveOverlay(null), null);
  assert.equal(shim.curveOverlay({ onCurve: null, progressPct: null }), null, 'a pad that knows the token but not its phase moved the card');
  assert.equal(shim.curveOverlay({ onCurve: false }), null);
  const o = shim.curveOverlay({ onCurve: true, progressPct: 40, progressSource: 'api', launchpad: 'bonk.fun' });
  assert.equal(o.dex, false);
  assert.equal(o.graduated, false);
  assert.equal(o.progressPct, 40);
});

test('a token name cannot forge extra lines on a receipt', async () => {
  reset();
  // The name and symbol are chosen by whoever deployed the token and land in
  // the message a user reads to decide what happened to their money. Escaping
  // makes `<b>` inert and does NOTHING to a newline, so without collapsing
  // whitespace a deployer can write lines that read as the bot's own.
  const forged = 'Nice Coin\n\n🟢 Buy of 999,999 $SOL succeeded · 💳 robin1';
  serve({ 'pump.fun': pumpBody({ name: forged, symbol: 'A\nB' }), 'jup.ag': [] });
  const m = (await lp.tokenRecord('solana', MINT)).record;
  assert.ok(!/\n/.test(m.name), `a newline survived into the name: ${JSON.stringify(m.name)}`);
  assert.ok(!/\n/.test(m.symbol), 'a newline survived into the symbol');
  assert.equal(m.symbol, 'A B');
  // A space inside a symbol is fine and must NOT be mangled — a live feed
  // really does return tokens called "READ TWEET".
  assert.equal(N.str('READ TWEET'), 'READ TWEET');
});

test('a URL a stranger wrote never reaches an href', () => {
  const rec = { website: 'javascript:alert(1)', twitter: 'https://x.com/ok', telegram: 'data:text/html,<script>' };
  const v = shim.socialsOf(rec);
  assert.equal(v.website, '', 'a javascript: URL was accepted');
  assert.equal(v.telegram, '', 'a data: URL was accepted');
  assert.equal(v.twitter, 'https://x.com/ok');
  assert.equal(shim.socialsOf({ website: null, twitter: null, telegram: null }), null);
});

// ── the watchdog ─────────────────────────────────────────────────────────────

test('every launchpad probe names a consequence, not a host', () => {
  reset();
  const probes = lp.probes();
  assert.ok(probes.length, 'no launchpad is watched at all');
  for (const p of probes) {
    assert.ok(p.costs && p.costs.length > 15, `${p.key} has no user-facing consequence`);
    // upstreams.test.js enforces this across every probe; asserting it at the
    // source stops a pad called "four.meme" from smuggling a hostname into the
    // one line that exists to avoid one.
    assert.ok(!/http|api\.|\.ag|\.fun|\.io|\.cc/i.test(p.costs), `${p.key} describes a host: ${p.costs}`);
    assert.equal(p.critical, false, 'a launchpad outage was marked critical — trading is unaffected');
  }
});

// ── flap.sh ──────────────────────────────────────────────────────────────────
//
// The second launchpad on Robinhood Chain. Added because the factory scan
// filters ONE address for ONE signature and `eth_getLogs` answers an unknown
// one with an EMPTY ARRAY — so a launch on a pad nothing here knows about reads
// as a quiet chain rather than as a missing feature. $MACROHARD (0x4e51…7777)
// rendered a live price and a real market cap while the bot could say nothing
// at all about its bonding curve.
//
// ⚠️ Its hosts and both paths are GUESSES — there is no egress from the sandbox
// this was written in, so nothing here asserts the pad ANSWERS. What is pinned
// is the contract that makes a wrong guess cost a line in .env rather than a
// deploy, which is the only reason shipping an unverified shape is safe.

const PADS = require('../shared/launchpads/pads.js');
const flapPad = () => PADS.build().find((p) => p.key === 'flap');

test('flap is a robinhood pad, marked unverified, and carries both paths', () => {
  reset();
  const p = flapPad();
  assert.ok(p, 'the flap pad is gone');
  assert.deepEqual(p.chains, ['robinhood']);
  assert.equal(p.verified, false, 'its request shape has never been exercised against the live API');
  assert.ok(p.tokenPath.includes('{id}'), 'the per-token path has no {id} to fill');
  // ⚠️ A DEFAULT feedPath IS LOAD-BEARING: the builder applies
  // LAUNCHPAD_<KEY>_FEED_PATH only to a pad that already has one, so shipping
  // without it would make the env override silently do nothing and turning the
  // feed on later would need a deploy. It is also what puts the pad into the
  // snipe's discovery and the watchdog's probes.
  assert.ok(p.feedPath && p.feedPath.includes('{n}'), 'no default feed path — the env override would be silently ignored');
});

test('every guess about flap is overridable from .env, which is why shipping one is safe', () => {
  reset();
  process.env.LAUNCHPAD_FLAP_API = 'https://example.invalid/v2';
  process.env.LAUNCHPAD_FLAP_TOKEN_PATH = '/t/{id}';
  process.env.LAUNCHPAD_FLAP_FEED_PATH = '/new?take={n}';
  try {
    const p = flapPad();
    assert.deepEqual(p.bases, ['https://example.invalid/v2'], 'a pinned base must also SKIP the list');
    assert.equal(p.tokenPath, '/t/{id}');
    assert.equal(p.feedPath, '/new?take={n}');
  } finally {
    delete process.env.LAUNCHPAD_FLAP_API; delete process.env.LAUNCHPAD_FLAP_TOKEN_PATH; delete process.env.LAUNCHPAD_FLAP_FEED_PATH;
  }
  process.env.LAUNCHPAD_FLAP = '';
  try { assert.equal(flapPad().enabled, true, 'a bare LAUNCHPAD_FLAP= must not read as "refused"'); }
  finally { delete process.env.LAUNCHPAD_FLAP; }
  process.env.LAUNCHPAD_FLAP = '0';
  try { assert.equal(flapPad().enabled, false, 'an explicit 0 must still switch it off'); }
  finally { delete process.env.LAUNCHPAD_FLAP; }
});

test('⚠️ flap never invents a migration from a pair address', () => {
  reset();
  const p = flapPad();
  // `curveState` turns ANY non-empty migratedPool into graduated:true, which
  // forces progressPct to 100, sets onCurve false, outranks every other pad in
  // the merge, and makes the snipe skip the launch outright. A pad reporting a
  // `pairAddress` for its own bonding curve would silently reclassify a live
  // curve token as migrated — invisible, and worse than no pool field at all.
  const r = p.parse(p, 'robinhood', { address: '0x' + '1'.repeat(40), pairAddress: '0x' + '2'.repeat(40), bondingProgress: 5 }, Date.now());
  assert.equal(r.migratedPool, null, 'a pairAddress was read as a migration pool');
  assert.equal(r.graduated, false);
  assert.equal(r.onCurve, true, 'a bonding token was reclassified as migrated');
});

test('flap reads the fields the pad actually shows, and states its phase', () => {
  reset();
  const p = flapPad();
  const r = p.parse(p, 'robinhood', {
    address: '0x4e51c77048ead3d01e2cb1f96dfcad37bf587777', name: 'MACROHARD', symbol: 'MACROHARD',
    marketCapUsd: 3696, priceUsd: 0.000037, liquidityUsd: 138, graduated: false, progressPct: 0.67,
  }, Date.now());
  assert.equal(r.symbol, 'MACROHARD');
  assert.equal(r.mcapUsd, 3696);
  assert.equal(r.launchpad, 'Flap');
  assert.equal(r.onCurve, true, 'a token below its threshold is ON the curve');
  assert.equal(r.graduated, false);
  // A pad that says nothing about its phase leaves all three null rather than
  // guessing — the rule the whole registry is built on.
  const quiet = p.parse(p, 'robinhood', { address: '0x' + '3'.repeat(40), name: 'Q' }, Date.now());
  assert.equal(quiet.onCurve, null);
  assert.equal(quiet.graduated, null);
  assert.equal(quiet.progressPct, null);
});

// ── a pasted placeholder is refused, loudly ──────────────────────────────────
//
// The failure this exists for happened in this repo's own workflow, twice in
// one session. An angle-bracket placeholder at least dies with a shell syntax
// error; `LAUNCHPAD_PONS_TOKEN_PATH=/api/…/{id}` does NOT — `VAR=value` is a
// legal assignment whatever the value is, so the operator gets a clean prompt
// back and every lookup afterwards requests `/api/%E2%80%A6/0x…` and 404s for
// ever. From `launchpads:check` that is indistinguishable from a launchpad that
// moved, which is the very thing the override exists to fix.

test('⚠️ an env override that still holds a placeholder is IGNORED, not used', () => {
  reset();
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    for (const bad of ['/api/…/{id}', '/api/.../{id}', '/api/<path>/{id}', '/api/ /{id}']) {
      process.env.LAUNCHPAD_PONS_TOKEN_PATH = bad;
      const p = PADS.build().find((x) => x.key === 'pons');
      assert.equal(p.tokenPath, '/launchpad/{id}', `a placeholder was used as a real path: ${bad}`);
    }
    // …and the base, which takes the same kind of paste.
    process.env.LAUNCHPAD_PONS_API = '<base>';
    assert.ok(PADS.build().find((x) => x.key === 'pons').bases[0].includes('ponsfamily'), 'a placeholder host replaced the base list');
  } finally {
    delete process.env.LAUNCHPAD_PONS_TOKEN_PATH; delete process.env.LAUNCHPAD_PONS_API;
    console.warn = realWarn;
  }
  // ⚠️ AND IT SAYS SO. Silently falling back is the reassuring reading: an
  // operator who set something and is being ignored must be told, or "the
  // override did not work" and "the override was never read" look identical.
  assert.ok(warned.length, 'the refusal was silent — the operator would think it was applied');
  assert.match(warned[0], /LAUNCHPAD_PONS_TOKEN_PATH/);
});

test('…and a REAL override still wins, including the legitimate {id} / {n} fillers', () => {
  reset();
  process.env.LAUNCHPAD_PONS_TOKEN_PATH = '/api/token/{id}';
  process.env.LAUNCHPAD_PONS_FEED_PATH = '/api/tokens?limit={n}&sort=new';
  process.env.LAUNCHPAD_PONS_API = 'https://api.example.test/v1';
  try {
    const p = PADS.build().find((x) => x.key === 'pons');
    assert.equal(p.tokenPath, '/api/token/{id}', 'the guard ate a perfectly good path');
    assert.equal(p.feedPath, '/api/tokens?limit={n}&sort=new');
    assert.deepEqual(p.bases, ['https://api.example.test/v1']);
  } finally {
    delete process.env.LAUNCHPAD_PONS_TOKEN_PATH; delete process.env.LAUNCHPAD_PONS_FEED_PATH; delete process.env.LAUNCHPAD_PONS_API;
  }
});
