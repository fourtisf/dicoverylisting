'use strict';
/*
 * decimalComma.test.js — a comma is a decimal point to most of this bot's users.
 *
 * parseUsd stripped every comma as a thousands separator, so "1,5" parsed as
 * FIFTEEN. That number becomes an order trigger: a stop-loss typed as "0,5" on
 * a token trading at $2 became a target of $5, and the watcher fires a stop
 * when price <= target — so the bot sold the user's entire bag the moment the
 * order was created. i18n.js says plainly that a large share of these users
 * trade in Indonesian, where the comma IS the decimal separator.
 */
const test = require('node:test');
const assert = require('node:assert');
const M = require('node:module');
const orig = M.prototype.require;
M.prototype.require = function (p) {
  if (p === './core') return { CFG: { tgToken: 't' }, chains: { enabledChains: () => [], isSvm: () => false }, getLang: () => 'en' };
  return orig.apply(this, arguments);
};
const t = require('./telegram.js')._test;
M.prototype.require = orig;

test('a comma decimal is read as a decimal, not as grouping', () => {
  assert.strictEqual(t.parseUsd('1,5'), 1.5);
  assert.strictEqual(t.parseUsd('0,5'), 0.5, 'this one sold a user’s whole bag');
  assert.strictEqual(t.parseUsd('1,50'), 1.5);
  assert.strictEqual(t.parseUsd('1,2345'), 1.2345);
});

test('real grouped thousands still work', () => {
  assert.strictEqual(t.parseUsd('1,234,567'), 1234567);
  assert.strictEqual(t.parseUsd('1500'), 1500);
  assert.strictEqual(t.parseUsd('$2k'), 2000);
  assert.strictEqual(t.parseUsd('1.5'), 1.5);
});

test('when both separators appear, the last one is the decimal', () => {
  assert.strictEqual(t.parseUsd('1.234,56'), 1234.56);
  assert.strictEqual(t.parseUsd('1,234.56'), 1234.56);
});

test('"1,500" reads as grouping — the two trailing zeros are the tell', () => {
  // It is the one form both conventions can produce. Somebody meaning
  // one-and-a-half types "1,5"; nobody pads it to "1,500".
  assert.strictEqual(t.parseUsd('1,500'), 1500);
  assert.strictEqual(t.parseUsd('250,000'), 250000);
});

test('a leading zero is never a thousands group', () => {
  // "0,001" is a price, not one thousand. No convention writes a leading group
  // as "0", which is exactly what separates it from "250,000".
  assert.strictEqual(t.parseUsd('0,001'), 0.001);
  assert.strictEqual(t.parseUsd('0,0025'), 0.0025);
});

test('a comma pattern that is neither shape is refused, not guessed', () => {
  const info = {};
  assert.strictEqual(t.parseUsd('1,23,4', info), null);
  assert.strictEqual(info.ambiguous || t.parseUsd('1,23,4') === null, true);
});

test('the amount field reads a comma the same way the price field does', () => {
  // Same input, same meaning, everywhere — this is the field that decides how
  // much gets SPENT.
  assert.deepStrictEqual(t.parseAmt('0,05'), { amt: '0.05' });
  assert.deepStrictEqual(t.parseAmt('0.05'), { amt: '0.05' });
  assert.deepStrictEqual(t.parseAmt('1,500'), { amt: '1500' });
});

test('nonsense is still nonsense', () => {
  for (const bad of ['', 'abc', '-1', '0', 'NaN', 'Infinity', '1.2.3', '5%', '1e400']) {
    assert.strictEqual(t.parseUsd(bad), null, `parseUsd(${JSON.stringify(bad)})`);
  }
});
