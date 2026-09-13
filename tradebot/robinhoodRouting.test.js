'use strict';
/*
 * "This token's liquidity is on Pons v2, which Dexvra can't route through yet."
 *
 * Said about a token with a live pool and $4.4k of liquidity, and not true in
 * the way it sounded. A Pons V1 launch deploys the token AND ITS UNISWAP V3 POOL
 * in one transaction — but `v3Cfg()` needs a factory and a router, both of which
 * shipped BLANK on robinhood, so the V3 leg was disabled outright. Every Pons
 * token therefore reached `bestDexVenue` with no V2 pair and no V3 config, and
 * got a sentence that sounded like a protocol we cannot support instead of
 * "nobody told me where this chain keeps its pools".
 *
 * `preflight:robinhood` has been printing the instruction for as long as that
 * was true — *"they are untradeable until these are set"*. This is that
 * instruction carried out, and this file is the guard on the one thing that
 * makes the addresses trustworthy rather than researched: the same deployment
 * record also names the V2 router this repo has been trading through since it
 * was written, and the two must agree.
 */
const test = require('node:test');
const assert = require('node:assert');
const { ethers } = require('ethers');

const chains = require('./chains');

const rh = () => chains.chainOf('robinhood');
// ethers.isAddress, NOT a regex. Production gates addresses through checks that
// reject a mixed-case address failing EIP-55, and a laxer predicate here would
// certify a value the code then silently drops — a guard is only honest while it
// measures the same thing the code does.
const isAddr = (a) => { try { return ethers.isAddress(String(a || '')); } catch (_) { return false; } };

test('Uniswap V3 is CONFIGURED on Robinhood Chain — the leg used to be off', () => {
  const c = rh();
  assert.ok(isAddr(c.v3.factory), 'no V3 factory: every Pons V1 token falls through to "can\'t route"');
  assert.ok(isAddr(c.v3.router), 'no V3 router: v3Cfg() returns null and the leg is disabled');
  assert.ok(isAddr(c.v3.quoter));
});

test('the deployment record cross-checks against the router already in production', () => {
  // deployments/json/4663.json → UniswapV2Router02, byte-for-byte the DEX_ROUTER
  // this repo has traded through since it was written. If these ever stop
  // matching, the record being trusted for the V3 addresses is a record of some
  // other chain — which is the only way the citation can quietly go bad.
  assert.equal(String(rh().router).toLowerCase(), '0x89e5db8b5aa49aa85ac63f691524311aeb649eba');
  assert.equal(rh().chainId, 4663);
});

test('every routing address is a real, distinct address', () => {
  const c = rh();
  for (const a of [c.router, c.weth, c.factory, c.v3.factory, c.v3.router, c.v3.quoter]) {
    assert.ok(isAddr(a), `not an address: ${a}`);
    assert.notEqual(String(a).toLowerCase(), ethers.ZeroAddress.toLowerCase());
  }
  const three = [c.v3.factory, c.v3.router, c.v3.quoter].map((a) => String(a).toLowerCase());
  assert.equal(new Set(three).size, 3, 'two V3 roles share one address — a copy/paste slip');
  // …and none of them is the V2 router or the launchpad factory wearing a
  // different hat, which is the other way a paste goes wrong.
  for (const a of three) {
    assert.notEqual(a, String(c.router).toLowerCase());
    assert.notEqual(a, String(c.factory).toLowerCase());
  }
});

test('env still wins over the published default', () => {
  // The override-and-skip contract every third-party address in this repo has:
  // an operator who measured their own with scripts/v3-discover.js is never
  // second-guessed.
  const mine = '0x' + 'ab'.repeat(20);
  const before = process.env.ROBINHOOD_V3_FACTORY;
  process.env.ROBINHOOD_V3_FACTORY = mine;
  try {
    delete require.cache[require.resolve('./chains')];
    assert.equal(require('./chains').chainOf('robinhood').v3.factory, mine);
  } finally {
    if (before === undefined) delete process.env.ROBINHOOD_V3_FACTORY; else process.env.ROBINHOOD_V3_FACTORY = before;
    delete require.cache[require.resolve('./chains')];
    require('./chains');
  }
});

test('a blank env value falls back to the default rather than disabling the leg', () => {
  // `.env` files carry bare `KEY=` lines, and this repo has been bitten by
  // blank-vs-absent before. Blank must mean "not set", not "set to nothing" —
  // the latter would silently switch V3 routing back off.
  const before = process.env.ROBINHOOD_V3_ROUTER;
  process.env.ROBINHOOD_V3_ROUTER = '';
  try {
    delete require.cache[require.resolve('./chains')];
    assert.ok(isAddr(require('./chains').chainOf('robinhood').v3.router));
  } finally {
    if (before === undefined) delete process.env.ROBINHOOD_V3_ROUTER; else process.env.ROBINHOOD_V3_ROUTER = before;
    delete require.cache[require.resolve('./chains')];
    require('./chains');
  }
});
