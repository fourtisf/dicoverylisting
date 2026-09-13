#!/usr/bin/env node
'use strict';
/*
 * seed:chain — bring a chain UP TO N listings from its own biggest tokens.
 *
 * "tambahkan token chain bsc base eth 50 token top nya memecoin atau apa bebas
 * tidak perlu di announce cukup tambahkan aja tokennya" — the chain chips read
 * BSC 23 · Base 10 · Ethereum 9 and needed filling out. This lists them on the
 * site and posts NOTHING to any channel: `services/chainSeed.js` lists with the
 * `free` package through `autoLister.createFromInfo`, which has no announce
 * path at all (only the scan loop announces, and only with a `tg` this script
 * never constructs).
 *
 * ⚠️ DRY RUN by default. It creates real, public rows on dexvra.io, so the
 * shape of the run is readable before it is irreversible — `--apply` writes.
 */
// ⚠️ .env FIRST, before anything requires config/constants.
//
// `config/constants.js` freezes every value at require time, so a standalone
// script that requires repo code first reads an EMPTY environment and then
// reports that as a fact about the server — "INTERNAL_API_TOKEN is not set" on
// a box where it plainly is. `loadEnv()` is the one owner of which .env this
// process reads; a bare `require("dotenv").config()` here would be a private
// fourth idea of it, resolved against the CWD alone.
require("../src/config/loadEnv").loadEnv();

// ⚠️ THIS SCRIPT IS A SECOND PROCESS ON THE SAME IP AS THE RUNNING BOT.
//
// GeckoTerminal's free ceiling (~30 req/min) is per IP; `gtPairs`'s pacing
// budget is per PROCESS. So the bot pacing itself at 25 rpm and this script
// pacing itself at 25 rpm is ~50 rpm at the ceiling — which is exactly how the
// first live run 429'd on its second page, and a 429 the BOT catches pauses
// every group's buy alerts for two minutes. Halving our own budget leaves the
// live path its room. Set AFTER loadEnv (which uses override:true) and only
// when the operator has not chosen a number themselves, and BEFORE the first
// require of repo code — `gtPairs` freezes the rate at require time.
if (!process.env.GT_MAX_RPM) process.env.GT_MAX_RPM = "10";

const seeder = require('../src/services/chainSeed');
const gt = require('../src/group/gtPairs');
const { DS_CHAIN } = require('../src/dexscreener');
const { CHAINS } = require('../src/config/chains');
const autoTrend = require('../src/services/autoTrend');
// A 120-second wait that prints nothing is indistinguishable from a hang, and
// the first live run was reported as exactly that. The renderer is a leaf
// module so its countdown can be driven by a test.
const { createProgress, mmss } = require('../src/helpers/cliProgress');
const { chainOf } = require('../src/config/chains');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

// The operator types what the chips say. `chainOf` is an exact match on the
// registry id, so `eth` would bounce as "unknown chain" for a chain the site
// carries — the wrong-chain dead end, in a CLI.
const ALIAS = { eth: 'ethereum', ether: 'ethereum', bnb: 'bsc', binance: 'bsc', avax: 'avalanche', sol: 'solana', matic: 'polygon', arb: 'arbitrum', op: 'optimism' };
const resolve = (s) => {
  const k = String(s || '').trim().toLowerCase();
  return ALIAS[k] || k;
};

const num = (s, dflt) => {
  const n = Number(String(s).replace(/[_,$]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

function usage() {
  console.log(`
${B}seed:chain${X} — list a chain's biggest tokens until it reaches a target count

  npm run seed:chain -- bsc base ethereum
  npm run seed:chain -- bsc base ethereum --apply

Options
  --target=N      how many listings the chain should END UP with (default ${seeder.DEFAULTS.target})
  --min-mcap=N    floor on market cap  (default ${seeder.DEFAULTS.minMcap.toLocaleString('en-US')})
  --min-liq=N     floor on liquidity   (default ${seeder.DEFAULTS.minLiq.toLocaleString('en-US')}, i.e. none)
  --source=       auto (default: DexScreener, then GeckoTerminal for whatever
                  it could not find), dexscreener, or gecko
  --trending      the chains the trending board may use (npm run trending:chains)
  --all           every chain the site supports that DexScreener indexes
  --same          pin every chain to --target instead of giving each its own
  --target-min=N  the floor of the per-chain spread (default 70% of --target)
  --gt-wait=N     seconds the GeckoTerminal top-up may wait out a rate limit
                  (default 0 — take what it answers now, re-run for the rest)
  --apply         actually create the listings (without it, nothing is written)

The target is UP TO, not add-N: a chain already at the target lists nothing, so
re-running after a half-finished pass is safe. Nothing is posted to any channel.
`);
}

(async () => {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(argv.length ? 0 : 1);
  }

  const flags = argv.filter((a) => a.startsWith('--'));
  const chains = argv.filter((a) => !a.startsWith('--')).map(resolve);
  const flag = (name) => {
    const hit = flags.find((f) => f.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const apply = flags.includes('--apply');
  const source = (flag('source') || seeder.DEFAULTS.source).toLowerCase();
  if (!['auto', 'dexscreener', 'gecko'].includes(source)) {
    console.error(`\n${R}✗${X} --source must be auto, dexscreener or gecko\n`);
    process.exit(2);
  }
  const opts = {
    target: num(flag('target'), seeder.DEFAULTS.target),
    minMcap: num(flag('min-mcap'), seeder.DEFAULTS.minMcap),
    minLiq: num(flag('min-liq'), seeder.DEFAULTS.minLiq),
    source,
    apply,
    // The number typed is a CEILING; each chain gets its own inside it, so a
    // site does not read as generated. `--same` pins every chain to it.
    spread: !flags.includes('--same'),
    gtWaitMs: num(flag('gt-wait'), 0) * 1000,
    targetMin: flag('target-min') ? num(flag('target-min'), undefined) : undefined,
  };

  if (flags.includes('--trending')) {
    // The chains the board may actually use. Seeding the other sixteen fills
    // the site with rows that can never be promoted, which is what `--all`
    // spent most of its listings on: TON and Arbitrum gained 15 and 14 while
    // BSC gained five. Read from the LIVE config, never a second copy of the
    // list, or the seeder and the board would disagree about which chains
    // matter.
    for (const c of autoTrend.get().chains || []) if (!chains.includes(c)) chains.push(c);
  }
  if (flags.includes('--all')) {
    // Every chain the site supports that DexScreener also indexes. A chain
    // neither index can be asked about would report "no chain id" forever,
    // which is noise rather than a finding.
    for (const c of Object.keys(CHAINS)) if (DS_CHAIN[c] && !chains.includes(c)) chains.push(c);
  }
  if (!chains.length) {
    console.error(`\n${R}✗${X} name at least one chain, or pass --trending / --all\n`);
    process.exit(2);
  }
  const bad = chains.filter((c) => !chainOf(c));
  if (bad.length) {
    console.error(`\n${R}✗${X} unknown chain: ${bad.join(', ')}\n`);
    process.exit(2);
  }

  console.log(
    `\n${B}Seeding ${chains.length} chain(s) to ${opts.spread ? 'up to ' : ''}${opts.target} listings${X}  ` +
      `${D}via ${source} · mcap ≥ $${opts.minMcap.toLocaleString('en-US')}` +
      `${opts.minLiq ? ` · liq ≥ $${opts.minLiq.toLocaleString('en-US')}` : ' · no liquidity floor'}${X}`,
  );
  if (opts.spread) {
    // Say the numbers out loud BEFORE the run. "up to 100" over a chain that
    // stops at 74 reads as a failure otherwise — the same reason the trending
    // panel prints every count against its range rather than against a target.
    console.log(
      `${D}Each chain gets its own total so the site does not read as generated: ` +
        chains.map((c) => `${c} ${seeder.targetFor(c, opts.target, opts.targetMin)}`).join(' · ') +
        `${X}${D}  (stable per chain — re-running lists nothing twice). --same pins them all.${X}`,
    );
  }
  console.log(
    apply
      ? `${Y}APPLY — real listings will be created on the site. Nothing is posted to any channel.${X}`
      : `${D}DRY RUN — nothing is written. Add --apply to create the listings.${X}`,
  );
  // GeckoTerminal's ceiling is per IP and the running bot is on it too, so say
  // what this costs and what removes the cost. A run that has to wait is not
  // broken; a run that LOOKS broken because it waited silently is.
  if (source === 'auto') {
    console.log(
      `${D}DexScreener leads (no key, no waiting, does not pause the bot's buy alerts); GeckoTerminal is` +
        ` asked ONLY for the shortfall it leaves, because its ~30/min ceiling is the one the running bot` +
        ` is also on. A chain DexScreener can fill never touches that quota.${X}\n`,
    );
  } else if (source === 'gecko') {
    console.log(
      gt.hasApiKey()
        ? `${D}GECKOTERMINAL_API_KEY is set — the read runs at the raised limit.${X}\n`
        : `${D}No GECKOTERMINAL_API_KEY: shares the free ~30/min ceiling with the running bot, so this` +
          ` paces slowly and waits out any rate limit. It can take a few minutes per chain.${X}\n`,
    );
  } else {
    console.log(
      `${D}DexScreener needs no key and does not share GeckoTerminal's ceiling, so this does not wait` +
        ` and does not pause the bot's buy alerts. It enumerates by searching the chain's own quote` +
        ` tokens, so it finds fewer than a full pool ranking would — ${X}${D}--source=gecko${X}${D} is` +
        ` the deeper read when you have a GECKOTERMINAL_API_KEY.${X}\n`,
    );
  }

  let unreadable = 0;
  let truncated = 0;
  let toppable = 0;
  let created = 0;
  const started = Date.now();
  const progress = createProgress({ colors: { Y, D, X } });
  for (const chain of chains) {
    const r = await seeder.seedChain(chain, { ...opts, onProgress: progress.handle });
    progress.clear();
    // ⚠️ "the market could not be read" and "there was nothing to add" are
    // different facts, and reporting the first as the second is how a rate
    // limit reads as "this chain is full".
    if (!r.ok) {
      unreadable++;
      console.log(`${R}✗${X} ${B}${chain}${X} — ${r.why}`);
      continue;
    }
    const head = `${chain}  ${r.current} → ${r.current + r.listed.length}/${r.target}`;
    const waited = r.waitedMs ? `  ${D}(waited ${Math.round(r.waitedMs / 1000)}s on the rate limit)${X}` : '';
    const via = r.source && r.source !== source ? `  ${D}[${r.source}]${X}` : '';
    if (!apply) {
      console.log(`${G}•${X} ${B}${head}${X}  ${D}(would list ${r.planned})${X}${via}${waited}`);
    } else {
      created += r.listed.length;
      console.log(`${G}✓${X} ${B}${head}${X}  ${D}(+${r.listed.length}${r.failed ? `, ${r.failed} refused` : ''})${X}${via}${waited}`);
    }
    // ⚠️ A read cut short is OUR quota, not a thin chain, and the two need
    // opposite responses — re-run, versus lower the floor. It is yellow and it
    // makes the whole run exit non-zero, because the chain is NOT settled.
    if (r.truncated) {
      truncated++;
      console.log(`  ${Y}⚠${X} ${r.why}`);
    } else if (r.why) {
      console.log(`  ${D}${r.why}${X}`);
    }
    // Expected, recoverable, and NOT a warning: GeckoTerminal is rate limited
    // on nearly every request while the bot is on the same ceiling. Re-running
    // lists nothing twice, so the way to finish is another pass, not a wait.
    if (r.topUp) {
      toppable++;
      console.log(`  ${D}↻ can be topped up — GeckoTerminal was rate limited${X}`);
    }
    for (const t of (apply ? r.listed : []).slice(0, 60)) {
      console.log(`  ${D}·${X} $${t.sym}  ${D}$${Math.round(t.mcap || 0).toLocaleString('en-US')}${X}`);
    }
  }

  const took = mmss(Date.now() - started);
  if (apply) console.log(`\n${G}${created}${X} listing(s) created in ${took}. ${D}Nothing was announced.${X}`);
  else console.log(`\n${D}Done in ${took}. Re-run with --apply to create them.${X}`);
  if (toppable) {
    console.log(
      `${D}${toppable} chain(s) can be topped up: GeckoTerminal is rate limited by the running bot's own` +
        ` traffic, so this took what DexScreener could see and moved on rather than waiting 2 minutes per` +
        ` chain. Re-run in a few minutes to add more — nothing is ever listed twice.${X}`,
    );
  }
  if (truncated) {
    console.log(
      `${Y}${truncated} chain(s) did not finish reading the market.${X} Re-running continues where it stopped — ` +
        `it lists nothing twice. ${D}A GECKOTERMINAL_API_KEY removes the wait entirely.${X}`,
    );
  }
  console.log('');

  // Non-zero when a chain could not be READ, or was only read in part — a cron
  // or an operator scrolling back must not take either for a settled chain.
  process.exit(unreadable || truncated ? 1 : 0);
})().catch((e) => {
  console.error(`\n${R}✗${X} ${e.stack || e.message}\n`);
  process.exit(1);
});
