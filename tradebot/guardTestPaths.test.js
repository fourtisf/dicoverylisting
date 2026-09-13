'use strict';
/*
 * guardTestPaths.test.js — two ways a test stops testing this repo.
 *
 * 1. An ABSOLUTE path. A test file written elsewhere and copied in keeps the
 *    author's machine baked into it: `require('/home/user/dexvra/tradebot/...')`
 *    resolves fine there and throws "Cannot find module" on the server, where
 *    the checkout lives at /opt/dexvra. The file's whole suite then never
 *    registers, so the run reports FEWER tests and one opaque failure.
 *
 * 2. The OPERATOR'S .env. core.js fills unset keys from tradebot/.env before
 *    anything reads them, so a knob like MONITOR_REFRESH_MS makes a test assert
 *    against production tuning instead of its own fixture. Twenty tests failed
 *    that way on the live server while passing everywhere else. `npm test` sets
 *    SKIP_DOTENV=1 to stop it.
 *
 * Both were real, both blocked a deploy, and neither is visible from reading
 * the failing test.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js'));

test('no test hardcodes an absolute path into a require', () => {
  // Comments are stripped first — this very file quotes the offending form as
  // its own example, and a guard that trips on its own documentation gets
  // deleted rather than fixed.
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of files) {
    const src = strip(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    const bad = src.match(/require\(['"]\/[^'"]+['"]\)/g) || [];
    assert.deepStrictEqual(bad, [], `${f} requires an absolute path: ${bad.join(', ')}`);
  }
});

test('npm test runs with the operator\'s .env switched off', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /SKIP_DOTENV=1/,
    'without this every test reads whatever the live server happens to be configured with');
});

test('core.js honours SKIP_DOTENV, and only that', () => {
  const src = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
  assert.match(src, /if \(\/\^\(1\|true\|yes\)\$\/i\.test\(String\(process\.env\.SKIP_DOTENV \|\| ''\)\)\) return;/);
  // The env must still win over the file in production — that is what makes
  // `pm2 restart --update-env` and a systemd Environment= line work at all.
  assert.match(src, /if \(key && process\.env\[key\] === undefined\) process\.env\[key\] = val;/);
});

test('a test that needs a newer Node skips, it does not fail', () => {
  // Nineteen tests died on the server with
  //   The "timers" argument must be an instance of Array. Received an instance of Object
  // because mock.timers takes an options object only from Node 20.4. A suite
  // that cannot run on the box it is meant to gate is not a gate.
  const src = fs.readFileSync(path.join(__dirname, 'liveMonitorRuntime.test.js'), 'utf8');
  assert.match(src, /MOCK_TIMERS_OK/, 'the version guard is gone');
  assert.match(src, /skip: SKIP/, '…and the tests no longer route through it');
});

// ── the probe that settles a launchpad integration ──────────────────────────
//
// 4p can only report what the CONFIGURED factory emitted, so a factory that is
// live-but-WRONG reports "0 events" — identical to a quiet pad. That ambiguity
// is what left a Pons integration reading green while a real launch went by
// unseen. 4t asks the chain the opposite question, from a token the operator
// already has in front of them.
test('preflight 4x reads the BUY interface off a real trade, with nothing to paste', () => {
  // Asking for a transaction hash was the wrong shape twice: it is a hunt
  // through an explorer, and the instruction carrying it was written with a
  // <placeholder>, which bash reads as a redirect — the command died with
  // "syntax error near unexpected token" before it ran. This file's own first
  // rule: a command an operator can paste must contain only real values.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'scripts', 'robinhood-preflight.js'), 'utf8');
  assert.match(src, /4x\. How is/, 'the buy-interface probe is gone');
  // A buy moves the token OUT of the curve, and a Transfer log carries its
  // transaction hash — that is the whole trick, and it needs no hash pasted.
  assert.match(src, /Transfer\(address,address,uint256\)/, 'it no longer finds the trade from the token itself');
  assert.match(src, /getTransaction\(lg\.transactionHash\)/, 'it stopped reading the CALL behind the transfer');
  // The one that MOVES VALUE is the buy — ranked, so the operator does not have
  // to work out which row matters.
  assert.match(src, /v\.value > 0n/, 'the buy is no longer told apart from a sell by the value it carries');
  // ⚠️ NO UNFILTERED getLogs WALK. The first cut of the sibling probe asked for
  // every log in 200-block steps and matched by substring; over a 50,000-block
  // window that is 250 requests each pulling the whole chain's logs, and it
  // simply did not finish. A probe that hangs is worse than one that says it
  // cannot answer.
  const t4x = src.slice(src.indexOf('4t. Who announced'), src.indexOf('4b. find the launchpad'));
  assert.match(t4x, /of \[\[null, asTopic\], \[null, null, asTopic\], \[null, null, null, asTopic\]\]/,
    '4t no longer filters by topic — an unfiltered walk over a wide window does not finish');
  assert.ok(!/for \(let to = head/.test(t4x), '4t is walking block ranges again');
  assert.ok(!/hay\.includes\(needle\)/.test(src), 'the substring scan over every log is back');
  // And the cheap, address-filtered probe runs FIRST: it answers the question
  // actually being asked (how a buy is routed) and cannot stall the one after it.
  assert.ok(src.indexOf('4x. How is') < src.indexOf('4t. Who announced'), 'the expensive probe runs before the cheap one again');
});

test('preflight 4t finds the contract that announced a given token', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'scripts', 'robinhood-preflight.js'), 'utf8');
  assert.match(src, /4t\. Who announced/, 'the token-targeted launchpad probe is gone');
  // A launchpad that packs the token into the DATA rather than indexing it is
  // invisible to a topic filter — that half of the problem is DELEGATED to 4x
  // (which reads the token's own Transfer logs), and the warning has to say so,
  // or a reader hits "not found" and concludes the token was never launched.
  const t4 = src.slice(src.indexOf('4t. Who announced'), src.indexOf('4b. find the launchpad'));
  assert.match(t4, /packs the token into the DATA/, 'the topic-only blind spot is no longer named');
  assert.match(t4, /4x/, 'nothing points the reader at the probe that covers it');
  // It must PRINT the .env line, not leave the operator to assemble it: a
  // diagnosis with no hands attached is a bug report the code files against
  // its owner.
  assert.match(src, /PONS_FACTORY=\$\{eAddr\}/, 'the probe stops short of the fix it found');
  // …and 4p must probe EVERY configured factory, or the legacy deployment is
  // exactly the blind spot this whole round was about.
  assert.match(src, /pons\.factories && pons\.factories\.length \? pons\.factories : \[pons\.factory\]/, '4p is back to probing one factory');
});

test('preflight 4p survives a Pons config with no ABI, and does not call a topic match "alive"', () => {
  // The shipped PONS_EVENT is a bare topic0: the launch topic was measured off
  // the chain, the signature behind it was not (1050 candidate spellings hashed,
  // none matched). 4p used to build `new ethers.Interface([pons.eventSig])`
  // unconditionally, so the probe would have crashed on its own default.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'scripts', 'robinhood-preflight.js'), 'utf8');
  const p4 = src.slice(src.indexOf('4p. Pons'), src.indexOf('4x. How is'));
  assert.match(p4, /pons\.decodable \? new ethers\.Interface/, '4p builds an Interface from a signature that may not exist');
  // ⚠️ MATCHING A LOG IS HALF THE TRIGGER. A probe that reported "alive" off the
  // log count alone would print green over a scan that names no token and
  // therefore buys nothing — the fonts:check defect, one feature over. It has
  // to resolve THROUGH THE BOT'S OWN RESOLVER, and fail when none resolves.
  assert.match(p4, /ponsT\._ponsResolve\(prov, l, liveF\)/, '4p no longer measures the stack the scan actually runs');
  assert.match(p4, /bad\('Pons launches are seen but none resolves to a token'/, 'a launch nothing can buy is reported as alive again');
  // The .env lines it prints must be COMPLETE — this file's first rule, and the
  // one that already cost an operator a broken shell this round.
  assert.match(src, /PONS_EVENT=\$\{eTopic\}/, '4t stopped printing a pasteable PONS_EVENT');
  // Comments stripped first: 4t's own comment QUOTES the sentence it replaced,
  // and a guard that trips on its own documentation gets deleted, not fixed.
  // (This repo has shipped that exact mistake in a build-stamp guard.)
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/PONS_EVENT must be the signature whose keccak/.test(code),
    'the probe is telling the operator to go and find a signature nobody can compute');
});
