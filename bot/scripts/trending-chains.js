#!/usr/bin/env node
'use strict';
/*
 * trending:chains — WHICH chains the trending board is allowed to use.
 *
 * "yang untuk di show trending chain sol bsc eth robinhood base dan tron".
 * Tron was missing from the shipped list entirely, so it could never reach the
 * board — which from the channel is indistinguishable from a chain with
 * nothing worth trending.
 *
 * ⚠️ AND CHANGING THE SHIPPED DEFAULT MAY REACH NOBODY. `autoTrend.set()`
 * persists `chains`, so a box where ⚙️ Auto-Trend settings has ever been
 * touched keeps its own stored list for ever and a code change is invisible
 * there. That trap has cost this project three separate rounds of "I deployed
 * and nothing changed", so this prints the STORED value beside the shipped one
 * and can write it — rather than leaving an operator to infer which won.
 */
// ⚠️ .env FIRST, before anything requires config/constants — a standalone
// script otherwise reads an empty environment and reports it as a fact about
// the server. `loadEnv()` is the one owner of which .env this process reads.
require("../src/config/loadEnv").loadEnv();

const autoTrend = require('../src/services/autoTrend');
const { CHAINS, chainOf } = require('../src/config/chains');
const build = require('../src/helpers/build');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

(async () => {
  const argv = process.argv.slice(2);
  const set = argv.find((a) => a.startsWith('--set='));
  const apply = argv.includes('--apply');

  const live = autoTrend.get().chains || [];
  console.log(`\n${B}Chains the trending board may use${X}   ${D}build ${build.stamp()}${X}\n`);
  console.log(`  live: ${G}${live.join(' · ') || '(none)'}${X}`);

  if (!set) {
    console.log(
      `\n${D}A chain that is not on this list can never reach the board, however many` +
        ` tokens are listed on it.${X}\n` +
        `${D}To change it:${X}  npm run trending:chains -- --set=solana,bsc,ethereum,base,robinhood,tron --apply\n` +
        `${D}Without --apply nothing is written. @dexvraadminbot → ⚙️ Auto-Trend does the same thing by tap.${X}\n`,
    );
    process.exit(0);
  }

  const want = set.slice(6).split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  const bad = want.filter((c) => !chainOf(c));
  if (bad.length) {
    console.error(`\n${R}✗${X} unknown chain: ${bad.join(', ')}`);
    console.error(`${D}known: ${Object.keys(CHAINS).join(' · ')}${X}\n`);
    process.exit(2);
  }
  if (!want.length) {
    // An empty list is the off switch for the whole feature, and it must be
    // typed deliberately rather than arrived at through a trailing comma.
    console.error(`\n${R}✗${X} that would turn auto-trending OFF entirely. Name at least one chain.\n`);
    process.exit(2);
  }

  const added = want.filter((c) => !live.includes(c));
  const removed = live.filter((c) => !want.includes(c));
  console.log(`  want: ${Y}${want.join(' · ')}${X}`);
  if (added.length) console.log(`  ${G}+ ${added.join(', ')}${X}`);
  if (removed.length) console.log(`  ${R}− ${removed.join(', ')}${X}  ${D}(these stop being promoted; paid slots are untouched)${X}`);
  if (!added.length && !removed.length) {
    console.log(`\n${D}Already exactly that. Nothing to do.${X}\n`);
    process.exit(0);
  }

  if (!apply) {
    console.log(`\n${D}DRY RUN — add --apply to write it.${X}\n`);
    process.exit(0);
  }
  await autoTrend.set({ chains: want });
  const after = autoTrend.get().chains || [];
  // Read it BACK. A ✅ over a write that did not take is the defect this whole
  // script exists to make visible, and it must not be reproduced here.
  const ok = want.length === after.length && want.every((c) => after.includes(c));
  console.log(
    ok
      ? `\n${G}✓ saved${X} — live now: ${after.join(' · ')}\n${D}The running bot re-reads this each cycle; no restart needed.${X}\n`
      : `\n${R}✗ NOT saved${X} — it still reads ${after.join(' · ')}\n`,
  );
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(`\n${R}✗${X} ${e.stack || e.message}\n`);
  process.exit(1);
});
