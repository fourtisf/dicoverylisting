'use strict';
// pools.trade — the launchpad record behind a Robinhood Chain token's card.
//
// The property this file exists to protect is the one in poolstrade.js's
// header: THIS SOURCE NEVER TOUCHES THE MONEY PATH. An HTTP source whose schema
// we do not control is allowed to make a card show a stale market cap; it must
// never be able to change what a trade does. So alongside the ordinary parsing
// tests there are two structural ones at the bottom asserting that the trade
// engine does not import this module and does not read its graduation flag.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ps = require('./poolstrade');
const { normalize, extractList, toMs, safeUrl, socialUrl, buildBody } = ps._test;

const ADDR = '0x1234567890abcdef1234567890ABCDEF12345678';

test('normalize: produces the record shape the card reads', () => {
  // telegram.js reads api.name, api.symbol, api.createdAt, api.marketCapUsd,
  // api.volume.h24Usd and api.links.{website,twitter,telegram} by those names.
  const r = normalize({
    address: ADDR,
    name: 'Nine Hood',
    symbol: 'NINEHOOD',
    marketCapUsd: 1_200_000,
    volume24hUsd: 300_000,
    createdAt: 1_800_000_000_000,
    links: { website: 'https://ninehood.io', twitter: '@ninehood' },
  });
  assert.equal(r.address, ADDR);
  assert.equal(r.name, 'Nine Hood');
  assert.equal(r.symbol, 'NINEHOOD');
  assert.equal(r.marketCapUsd, 1_200_000);
  assert.equal(r.volume.h24Usd, 300_000);
  assert.equal(r.createdAt, 1_800_000_000_000);
  assert.equal(r.links.website, 'https://ninehood.io');
  assert.equal(r.links.twitter, 'https://x.com/ninehood');
  assert.equal(r.links.telegram, null);
});

test('normalize: `volume` is always an object, so api.volume.h24Usd never throws', () => {
  // telegram.js reaches straight through api.volume.h24Usd. A record missing
  // `volume` entirely would throw while rendering a card — inside the live
  // monitor's refresh loop.
  const r = normalize({ address: ADDR });
  assert.equal(typeof r.volume, 'object');
  assert.equal(r.volume.h24Usd, null);
  assert.equal(r.volume.totalUsd, null);
});

test('normalize: `links` is always an object, so api.links never throws', () => {
  const r = normalize({ address: ADDR });
  assert.equal(typeof r.links, 'object');
  assert.equal(r.links.website, null);
});

test('normalize: reads nested spellings and string numbers', () => {
  const r = normalize({
    token: { address: ADDR, name: 'Nine Hood', symbol: 'NINEHOOD' },
    market_cap_usd: '1200000',
    volume: { h24: '300000' },
  });
  assert.equal(r.address, ADDR);
  assert.equal(r.name, 'Nine Hood');
  assert.equal(r.marketCapUsd, 1_200_000);
  assert.equal(r.volume.h24Usd, 300_000);
});

test('normalize: no address, no record', () => {
  assert.equal(normalize({ name: 'nameless' }), null);
  assert.equal(normalize({ address: '0xdead' }), null);
  assert.equal(normalize(null), null);
});

test('normalize: an unparseable figure is null, never NaN', () => {
  // A NaN market cap renders as "$NaN" on a card the user is about to trade on.
  const r = normalize({ address: ADDR, marketCapUsd: 'unknown' });
  assert.equal(r.marketCapUsd, null);
  assert.ok(!Number.isNaN(r.marketCapUsd));
});

test('safeUrl: only http(s) reaches a Telegram href', () => {
  // A malformed href makes Telegram reject the whole message, which would take
  // the live monitor down over a field a stranger controls.
  assert.equal(safeUrl('https://pools.trade'), 'https://pools.trade');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,x'), null);
  assert.equal(safeUrl('nonsense'), null);
});

test('socialUrl: bare handles become links, junk is dropped', () => {
  assert.equal(socialUrl('@ninehood', 'https://t.me'), 'https://t.me/ninehood');
  assert.equal(socialUrl('javascript:x', 'https://t.me'), null);
});

test('toMs: seconds, milliseconds and ISO agree', () => {
  assert.equal(toMs(1_800_000_000), 1_800_000_000_000);
  assert.equal(toMs(1_800_000_000_000), 1_800_000_000_000);
  assert.equal(toMs('bad'), null);
});

test('extractList: tolerates an unfamiliar envelope', () => {
  const row = { address: ADDR };
  assert.deepEqual(extractList({ launches: [row] }), [row]);
  assert.deepEqual(extractList([row]), [row]);
  assert.deepEqual(extractList({ unseenKey: [row] }), [row]);
  assert.deepEqual(extractList({ n: 1 }), []);
});

test('buildBody: default targets the launchpad chain', () => {
  assert.equal(buildBody(null).chainId, 4663);
  assert.equal(buildBody('cur').cursor, 'cur');
});

test('tokenRecord: never answers for another chain', async () => {
  assert.equal(await ps.tokenRecord(ADDR, 'ethereum'), null);
  assert.equal(await ps.tokenRecord(ADDR, 'base'), null);
  assert.equal(await ps.tokenRecord('not-an-address', 'robinhood'), null);
});

// ── the structural guards ────────────────────────────────────────────────────

test('the trade engine does not import pools.trade', () => {
  // core.js prices, routes and signs every trade. If it ever requires this
  // module, an HTTP source we do not control has entered the money path — which
  // is exactly what poolstrade.js's header forbids. Delete this test only
  // alongside a deliberate decision to change that.
  const core = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
  assert.equal(/require\(['"]\.\/poolstrade['"]\)/.test(core), false,
    'core.js must decide venue and price from chain state, never from the launchpad API');
});

test('the launchpad graduation flag is display-only', () => {
  // tokeninfo.enrich puts the launchpad record on info.api. core.js decides the
  // real venue with an on-chain graduated() call. Trusting api.graduated instead
  // would route a sell at the wrong venue whenever the API lagged a graduation.
  const core = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
  assert.ok(/graduated\(\)/.test(core), 'core.js must still read graduation from the contract');
  assert.equal(/api\.graduated/.test(core), false, 'core.js must not read the launchpad flag');
});

test('normalize: a foreign-chain record is dropped rather than shown on a Robinhood card', () => {
  // The card this feeds sits directly above live Buy buttons. Another chain's name,
  // socials and market cap on a Robinhood token is a trade the user did not intend.
  assert.equal(normalize({ address: ADDR, chainId: 1 }), null);
  assert.equal(normalize({ address: ADDR, chain_id: '8453' }), null);
  assert.ok(normalize({ address: ADDR, chainId: 4663 }), 'the configured chain is kept');
  assert.ok(normalize({ address: ADDR }), 'an unstamped record is ours by request filter');
});
