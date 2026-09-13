'use strict';
/*
 * ⚠️ NEVER LIST THE MONEY — at the ONE door, not at one of the three.
 *
 * "jangan pernah listing stable coin jika sudah terlanjur hapus smua stable
 * coin yang listing."
 *
 * `bigCoins.topByMcap` has filtered stablecoins and wrappers out of the board
 * FILLER's candidates since it was written, so the rule looked covered. It was
 * one door of three: the scan loop lists from the DISCOVERY feeds (DexScreener
 * profiles and boosts, pools.trade), which are not ranked by pool depth and had
 * no such filter at all, and `chainSeed` is a third. `createFromInfo` is the
 * documented one owner of "turn a priced token into a listing", so the gate
 * belongs on it — including for the fourth door somebody adds later.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'nostables-'));
const autoLister = require('../src/services/autoLister');
const api = require('../src/api/dexvra');

/** Stand in for the site's create, recording what reached it. */
function withCreate(fn) {
  const real = api.createListing;
  const seen = [];
  api.createListing = async (input) => {
    seen.push(input);
    return { id: 'x' + seen.length, ...input };
  };
  return Promise.resolve(fn(seen)).finally(() => {
    api.createListing = real;
  });
}

const info = (symbol, name) => ({
  symbol,
  name,
  priceUsd: 1,
  mcap: 5e9,
  liq: 1e7,
  vol24: 1e6,
  logoUrl: null,
});

test('a stablecoin never reaches the site, whichever door it came through', async () => {
  await withCreate(async (seen) => {
    for (const [sym, name] of [
      ['USDT', 'Tether USD'],
      ['USDG', 'Global Dollar'],
      ['BTCB', 'BTCB Token'],
      ['WTRX', 'Wrapped TRX'],
      ['USD₮0', 'Tether USD₮0'],
    ]) {
      const made = await autoLister.createFromInfo('bsc', '0x' + '1'.repeat(40), info(sym, name));
      assert.equal(made, null, `${sym} was listed`);
    }
    assert.deepEqual(seen, [], 'the site was asked to create one of them');
  });
});

test('…and a real project still lists', async () => {
  await withCreate(async (seen) => {
    const made = await autoLister.createFromInfo('bsc', '0x' + '2'.repeat(40), info('SHIB', 'Shiba Inu'));
    assert.ok(made, 'a project must still be listable');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].sym, 'SHIB');
  });
});

test('⚠️ the refusal happens BEFORE the site is called, not after', async () => {
  // A gate that lets the create through and then undoes it would leave the row
  // on a public site for however long the second call takes — and `everListed`
  // written for a token we do not want remembered.
  await withCreate(async (seen) => {
    await autoLister.createFromInfo('bsc', '0x' + '3'.repeat(40), info('USDC', 'USD Coin'));
    assert.equal(seen.length, 0);
    assert.equal(autoLister.wasEverListed('bsc', '0x' + '3'.repeat(40)), false,
      'a refused token must not be written into the never-relist ledger');
  });
});

test('the gate is on the ONE owner — not copied into a caller', () => {
  // A rule the second caller has to remember is one the third forgets, which is
  // exactly how the discovery feeds ended up with no filter at all.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const src = strip(fs.readFileSync(path.join(__dirname, '../src/services/autoLister.js'), 'utf8'));
  const uses = src.match(/notAProject\(/g) || [];
  assert.equal(uses.length, 1, `notAProject is called ${uses.length} times in autoLister.js`);
  const gate = src.indexOf('notAProject(info.symbol, info.name)');
  const create = src.indexOf('await api.createListing(input)');
  assert.ok(gate > 0 && create > 0 && gate < create, 'the gate must sit above the create');

  const fill = strip(fs.readFileSync(path.join(__dirname, '../src/services/trendFill.js'), 'utf8'));
  assert.doesNotMatch(fill, /notAProject/, 'trendFill is growing its own copy');
});
