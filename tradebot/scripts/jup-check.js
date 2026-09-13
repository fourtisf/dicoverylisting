#!/usr/bin/env node
'use strict';
/*
 * jup:check — IS THE JUPITER KEY LIVE, AND IS IT ACCEPTED?
 *
 * WHY THIS EXISTS
 *
 * The boot line says which tier this process is on, and an operator was told to
 * read it with `pm2 logs --lines 40 | grep '[jup'`. It came back EMPTY on a box
 * where the key had just been set correctly — because the snipe loop writes
 * several lines a second, so a line printed at boot has scrolled past forty
 * within seconds.
 *
 * ⚠️ THAT IS THIS REPO'S OWN RECORDED DEFECT, REPEATED. The `[curve]` refusal
 * line was added for exactly this reason and cost four rounds of investigation
 * because `grep` came back empty on a box that was producing it: "a diagnostic
 * that exists and cannot be retrieved is a value nobody can read, which is the
 * same as no value". A fact that lives ONLY in a log line is not retrievable.
 *
 * So the fact is askable on demand. And it does not merely report what is
 * CONFIGURED — a key that is set and REFUSED looks identical from the config
 * (that is why `_noteKeyRefused` exists), so this makes one real request and
 * reports what Jupiter said.
 *
 * ⚠️ IT NEVER PRINTS THE KEY, not even a fragment. This output is read off a
 * terminal that gets screenshotted; "set, 68 chars, starts with jup_" answers
 * the question without putting live credentials on screen. Same rule the boot
 * line follows for the RPC url.
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// ⚠️ ORDER IS THE RULE, NOT PRESENCE. `core.js` loads tradebot/.env into
// process.env, and `solana.js` reads JUP_API_KEY at MODULE-EVAL time — so
// requiring solana first would read an empty environment and report the
// operator's own correctly-set key as missing. A diagnostic that reads a
// different configuration from the bot's is a diagnostic about nothing; this
// repo has already paid for that once in `trending:check`.
require(path.join(__dirname, '..', 'core'));
const solana = require(path.join(__dirname, '..', 'solana'));

const ENV_FILE = path.join(__dirname, '..', '.env');
let bad = 0;
const ok = (s) => console.log('  ✓ ' + s);
const no = (s) => { bad++; console.log('  ✗ ' + s); };
const note = (s) => console.log('    ' + s);

function build() {
  // The same stamp every check script in this repo prints, for the same reason:
  // every round of this has begun with somebody reading a check as a statement
  // about the fix they just deployed.
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain', { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return sha + (dirty ? '+dirty' : '');
  } catch (_) { return 'unknown'; }
}

(async () => {
  console.log('\nJupiter — build ' + build() + '\n');

  // ── 1. What this process actually read ────────────────────────────────────
  console.log('1 · Configuration');
  // NAME THE FILE. "not set" over a path that exists is a missing line in that
  // file; "not set" over a path that does not is an .env written somewhere else
  // — and /opt/dexvra/.env instead of /opt/dexvra/tradebot/.env is a mistake
  // this repo has recorded being made. One line separates the two.
  if (fs.existsSync(ENV_FILE)) ok('read ' + ENV_FILE);
  else no('no .env at ' + ENV_FILE + ' — the trade bot reads its OWN .env, not the repo root\'s');

  const key = String(process.env.JUP_API_KEY || '').trim();
  if (key) ok(`JUP_API_KEY is set (${key.length} chars, starts with "${key.slice(0, 4)}")`);
  else {
    ok('JUP_API_KEY is not set — running on the keyless tier');
    note('That is supported and is the shipped default. Jupiter meters it at ~0.5 req/s');
    note('(30/min) per IP, which a multi-wallet buy can exhaust in one millisecond.');
  }
  note('bases, in order:');
  solana.JUP_BASES.forEach((b, i) => note(`  ${i + 1}. ${b}${/lite-api/.test(b) && key ? '   ← keyless fallback' : ''}`));
  note(`pacing ${solana.JUP_MIN_GAP_MS}ms between requests · ${solana.JUP_RETRIES} retry(ies) on 429/5xx`);

  // ── 2. Does Jupiter accept it? ────────────────────────────────────────────
  //
  // The half a config dump cannot answer. A key that is set and REFUSED reads
  // identically from the configuration, and the fallback is deliberately
  // fail-safe — buys keep working at the keyless ceiling — so "the key works"
  // and "the key is being ignored" are one observation until something asks.
  console.log('\n2 · Does Jupiter accept it?');
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  try {
    const q = await solana.getQuote({ inputMint: solana.WSOL_MINT, outputMint: USDC, amountRaw: 10000000n, slippageBps: 100 });
    const answered = solana.jupBase() || '?';
    if (!(q.outAmount > 0n)) no('a quote came back with no output — not a key problem, but not a working route either');
    else if (key && /lite-api/.test(answered)) {
      no(`the KEY was refused — ${answered} answered, which is the keyless fallback`);
      note('Buys still work, at the free ceiling. Check the key at portal.jup.ag, or');
      note('pin the right host with JUP_BASE in tradebot/.env.');
    } else if (key) ok(`${answered} answered — the key is accepted`);
    else ok(`${answered} answered — keyless, as configured`);
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/rate-limiting|429/.test(m)) no('rate limited right now: ' + m.slice(0, 160));
    else if (/can't reach/.test(m)) no('this box cannot reach Jupiter at all: ' + m.slice(0, 160));
    else no(m.slice(0, 200));
  }

  // ── 3. Where the live numbers are ─────────────────────────────────────────
  //
  // ⚠️ DELIBERATELY NOT PRINTED HERE. The counters live in the RUNNING BOT's
  // process; this is a different one and its own are all zero. Printing them
  // would be a diagnostic reporting its own state as the server's — the exact
  // defect `trending:check` was caught by. /health is where they are.
  console.log('\n3 · How many trades the budget has refused');
  note('This is a separate process, so its counters are not the bot\'s.');
  note('Ask the running bot: /health in @dexvraadminbot → "Jupiter budget".');
  note('`refused` is the only number that means a trade was lost.');

  console.log('\n' + (bad ? '✗ ' + bad + ' problem(s) above.' : '✓ Jupiter is reachable and configured as intended.') + '\n');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('jup:check crashed:', (e && e.stack) || e); process.exit(1); });
