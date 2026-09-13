#!/usr/bin/env node
'use strict';
/*
 * listings:fix — DOUBLE ROWS and MISSING LOGOS on the public board.
 *
 * "hapus token double dan setiap token harus punya logo … cari dri banyak
 * sumber dan jika tidak ada logo hapus aja tokenya." The board was showing
 * $FLOKI twice, both drawing the site's `FL` monogram — which is the right
 * fallback and the wrong thing to have to draw on a row nobody will ever come
 * and fix.
 *
 * Two passes, in this order, because deduping first means the logo pass does
 * not spend four network reads on a row that is about to be removed anyway:
 *
 *   1. DUPLICATES — same chain, same ticker, keep ONE.
 *   2. LOGOS      — resolve from four sources; delete what has none.
 *
 * ⚠️ THIS DELETES PUBLIC ROWS, so it inherits every guard `unseed:chain` has:
 * DRY RUN by default, and only `source: "bot"` + FREE tier + no trending slot
 * can be touched — enforced by the SITE, not by this script. A paid listing
 * with no logo is a customer to email, never a row to delete.
 */
// ⚠️ .env FIRST, before anything requires config/constants.
require("../src/config/loadEnv").loadEnv();

// ⚠️ A SECOND PROCESS ON THE SAME IP AS THE RUNNING BOT. GeckoTerminal's free
// ceiling is per IP while the pacing budget is per PROCESS, so walking hundreds
// of rows at the default rate arms a 429 the BOT also pays for. Set before the
// first repo require — `gtPairs` freezes the rate at require time — and never
// over an operator's own value.
if (!process.env.GT_MAX_RPM) process.env.GT_MAX_RPM = "10";

const api = require('../src/api/dexvra');
const { resolveLogo } = require('../src/services/tokenLogo');
const { notAProject } = require('../src/services/bigCoins');
const build = require('../src/helpers/build');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Only rows an auto-listing run could have created. The site re-checks. */
const removable = (r) =>
  r.source === 'bot' &&
  String(r.tier || '').toUpperCase() === 'FREE' &&
  r.trendingRank == null &&
  !r.trendExp;

const hasLogo = (r) => /^https:\/\/\S+$/.test(String(r.logoUrl || ''));
const key = (r) => `${r.chain}:${String(r.sym || '').trim().toUpperCase()}`;

/**
 * Which of a duplicate set to KEEP. PURE, so the choice that removes public
 * rows is testable without a network.
 *
 * A logo beats no logo, then the bigger market cap, then the older listing —
 * the last one only so the answer is stable across runs rather than depending
 * on the order the API happened to return.
 */
function pickKeeper(rows) {
  return [...rows].sort((a, b) => {
    if (hasLogo(a) !== hasLogo(b)) return hasLogo(a) ? -1 : 1;
    const m = (Number(b.mcap) || 0) - (Number(a.mcap) || 0);
    if (m) return m;
    return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
  })[0];
}

/**
 * The duplicate rows to drop, keyed on chain + TICKER.
 *
 * ⚠️ Two different real tokens CAN share a ticker — that is ordinary in crypto,
 * and on a paid board it would be wrong to touch either. It is safe here only
 * because the set is narrowed to rows this bot auto-listed for free on the SAME
 * chain: that is not two projects, it is one seeding run finding the same token
 * through two pools or two addresses.
 */
function duplicates(rows) {
  const groups = new Map();
  for (const r of rows.filter(removable)) {
    if (!r.sym) continue;
    const k = key(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const drop = [];
  for (const [, set] of groups) {
    if (set.length < 2) continue;
    const keep = pickKeeper(set);
    for (const r of set) if (r.id !== keep.id) drop.push({ row: r, keptSym: keep.sym, keptId: keep.id });
  }
  return drop;
}

(async () => {
  const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const apply = flags.includes('--apply');
  // ⚠️ FILL THE LOGOS, DELETE NOTHING.
  //
  // "tambahkan logo project nya cari di beberapa sumber dan download" — the ask
  // was to GIVE rows artwork, and the only tool that resolves artwork also
  // removes every row it could not find any for. `--logos-only` does not change
  // that: it skips the dedupe pass, not the deletions. So an operator who wanted
  // logos filled had no way to run this without also losing tokens.
  //
  // The delete is not a bug and stays the default — it answers an earlier
  // request in this script's own header ("jika tidak ada logo hapus aja
  // tokenya"), and quietly reversing that would surprise whoever relies on it.
  // This is the opt-out, and it is total: nothing is removed, anywhere, and the
  // rows that end with no artwork are NAMED so they can be handled by hand.
  const keep = flags.includes('--keep');
  const doDupes = !flags.includes('--logos-only');
  const doLogos = !flags.includes('--dupes-only');

  if (flags.includes('--help')) {
    console.log(`
${B}listings:fix${X} — remove double rows, and give every row a logo

  npm run listings:fix                     # dry run, every chain
  npm run listings:fix -- --apply
  npm run listings:fix -- bsc solana --apply
  npm run listings:fix -- --dupes-only --apply
  npm run listings:fix -- --logos-only --apply
  npm run listings:fix -- --logos-only --keep --apply   # fill logos, delete NOTHING

Logos are resolved from DexScreener, GeckoTerminal, the token's launchpad,
CoinGecko, Trust Wallet, pools.trade and DexScreener's image CDN — every
candidate is FETCHED before it is stored, so a 404 never becomes a broken image.
Only rows the bot auto-listed for free are ever touched.

${B}--keep${X} deletes nothing at all: duplicates stay, rows with no artwork stay, and
every row still missing a logo is listed at the end with its address so you can
set one by hand. Without it, a row with no logo on any source is REMOVED.
`);
    process.exit(0);
  }

  let rows;
  try {
    rows = (await api.getListings()) || [];
  } catch (e) {
    console.error(`\n${R}✗${X} could not read the listings API: ${e.message}\n`);
    process.exit(1);
  }
  if (only.length) rows = rows.filter((r) => only.includes(r.chain));

  console.log(`\n${B}Cleaning ${rows.length} listing(s)${only.length ? ` on ${only.join(', ')}` : ''}${X}   ${D}build ${build.stamp()}${X}`);
  console.log(
    apply
      ? keep
        ? `${Y}APPLY${X} ${G}--keep${X} — logos are filled in; ${B}nothing is deleted${X}.\n`
        : `${Y}APPLY — rows will be changed and removed.${X}\n`
      : `${D}DRY RUN — nothing is written. Add --apply.${X}${keep ? ` ${G}--keep${X}${D} is on: nothing would be deleted.${X}` : ''}\n`,
  );

  let removedDupes = 0;
  let fixed = 0;
  let removedNoLogo = 0;
  let undecided = 0;
  let refused = 0;
  // Under --keep: the rows that finish with no artwork, named. A count alone
  // sends the operator back to the board to work out WHICH — the diagnosis
  // with no hands attached this repo keeps paying for.
  const kept = [];
  let waited = 0;
  const retry = [];
  const heldBack = new Set(); // a row may be held back ONCE, never in a loop
  // The whole run may sleep this long in total waiting out rate limits. A
  // maintenance pass can afford minutes; it may not afford an afternoon.
  const MAX_WAIT_MS = 10 * 60 * 1000;
  // Long enough for a free-tier window to roll, short enough that eighty
  // rows do not become an evening. The per-source pacing is what keeps this
  // rare; this is the net under it.
  const BACKOFF_MS = 20 * 1000;
  const bySource = {};
  const dropped = new Set();

  // ── 1. duplicates ─────────────────────────────────────────────────────────
  if (doDupes && keep) {
    // --keep means nothing is removed ANYWHERE. A flag that spared the logo
    // pass and quietly deleted duplicates would be the reassuring reading of
    // its own name, which is the shape this repo keeps paying for.
    const dupes = duplicates(rows);
    console.log(`${B}Duplicates${X}  ${dupes.length} row(s) — left alone (--keep)\n`);
  } else if (doDupes) {
    const dupes = duplicates(rows);
    console.log(`${B}Duplicates${X}  ${dupes.length} row(s) to drop`);
    for (const { row } of dupes) {
      console.log(`  ${D}− $${row.sym} on ${row.chain} ${row.address.slice(0, 10)}…${X}`);
      if (!apply) continue;
      try {
        await api.deleteListing(row.id);
        dropped.add(row.id);
        removedDupes++;
      } catch (e) {
        refused++;
        console.log(`  ${Y}⚠ $${row.sym}: ${e.message}${X}`);
      }
      await sleep(120);
    }
    console.log('');
  }

  // ── 2. logos ──────────────────────────────────────────────────────────────
  if (doLogos) {
    const missing = rows.filter((r) => !dropped.has(r.id) && removable(r) && !hasLogo(r));
    // ⚠️ THIS IS THE INPUT COUNT, AND IT MUST NOT READ AS THE ANSWER. It said
    // "83 row(s) with no logo", which is what the run was HANDED — and since
    // the same board hands it the same number every time, an operator reading
    // a screenshot of it reasonably concluded the fix had changed nothing.
    // The outcome is the summary at the bottom; this line says what is about
    // to be attempted, in the future tense, so the two cannot be confused.
    console.log(`${B}Logos${X}  resolving ${missing.length} row(s) that have no logo yet…`);
    // A row parked behind a cooldown goes round once more rather than being
    // called undecided; only the SECOND pass may conclude anything.
    const queue = [...missing];
    for (let i = 0; i < queue.length; i++) {
      const r = queue[i];
      if (i === missing.length && retry.length) console.log(`\n${D}  second pass — ${retry.length} row(s) held back by the rate limit${X}`);
      // A stablecoin that slipped in earlier should go, not be given artwork.
      if (notAProject(r.sym, r.name)) {
        if (keep) {
          // Still not worth a lookup — a stablecoin's "artwork" is not the
          // problem — but under --keep it is reported, never removed.
          console.log(`  ${D}· $${r.sym} (${r.chain}) — not a project, left alone${X}`);
          kept.push({ ...r, why: 'not a project' });
          continue;
        }
        console.log(`  ${D}− $${r.sym} (${r.chain}) — not a project${X}`);
        if (apply) {
          try {
            await api.deleteListing(r.id);
            removedNoLogo++;
          } catch (e) {
            refused++;
            console.log(`  ${Y}⚠ ${e.message}${X}`);
          }
        }
        continue;
      }
      const hit = await resolveLogo(r.chain, r.address);
      if (hit.url) {
        bySource[hit.source] = (bySource[hit.source] || 0) + 1;
        console.log(`  ${G}+${X} $${r.sym} (${r.chain}) ${D}← ${hit.source}${X}`);
        if (apply) {
          try {
            await api.updateListing(r.id, { logoUrl: hit.url });
            fixed++;
          } catch (e) {
            refused++;
            console.log(`  ${Y}⚠ $${r.sym}: ${e.message}${X}`);
          }
        }
      } else if (!hit.ok && waited < MAX_WAIT_MS && !heldBack.has(r.id)) {
        // ⚠️ BACK OFF ON WHAT IS ACTUALLY BLOCKING, not on a clock next to it.
        //
        // This used to sleep for `gt.cooldownRemaining()`. Once GeckoTerminal
        // stopped blocking anything, the source that DID block was CoinGecko —
        // and the run sat out 120 seconds of GeckoTerminal's limit for it, then
        // resumed into a CoinGecko limit that was never waited on at all. Two
        // services, two limits, one wait keyed to the wrong one.
        //
        // So the backoff is short and generic, the blocker is NAMED, and the
        // row goes round exactly once — `heldBack` is what makes "once" true
        // rather than hopeful.
        const left = Math.min(BACKOFF_MS, MAX_WAIT_MS - waited);
        console.log(`  ${D}… ${hit.blocking.join(', ')} — backing off ${Math.round(left / 1000)}s${X}`);
        await sleep(left);
        waited += left;
        heldBack.add(r.id);
        retry.push(r); // decided on the second pass, not guessed at on the first
      } else if (!hit.ok) {
        // ⚠️ A SOURCE THAT COULD NOT BE ASKED HAS NOT SAID NO.
        //
        // GeckoTerminal's 429 arms a process-wide cooldown, and the first live
        // run tripped it on its very first lookup — so source two answered
        // nothing for all eighty-three rows and this script called that "no
        // logo anywhere" and was one --apply away from deleting them on it.
        // Deleting a public row is the one action in here that cannot be
        // undone, so it requires every source to have actually ANSWERED.
        undecided++;
        console.log(`  ${Y}?${X} $${r.sym} (${r.chain}) ${D}— undecided: ${hit.unreachable.join(', ')}${X}`);
      } else {
        // Name what was skipped and WHY it was safe to skip — a bare "no
        // artwork on any source" over a source that was never asked is the
        // claim this whole guard exists to stop making.
        const skipped = (hit.unreachable || []).length
          ? ` ${D}(${hit.unreachable.join(', ')} — covered by CoinGecko on this chain)${X}`
          : '';
        if (keep) {
          console.log(`  ${Y}·${X} $${r.sym} (${r.chain}) ${D}— no artwork on any source, left alone${X}${skipped}`);
          kept.push({ ...r, why: 'no artwork on any source' });
          continue;
        }
        console.log(`  ${D}− $${r.sym} (${r.chain}) — no artwork on any source${X}${skipped}`);
        if (apply) {
          try {
            await api.deleteListing(r.id);
            removedNoLogo++;
          } catch (e) {
            refused++;
            console.log(`  ${Y}⚠ $${r.sym}: ${e.message}${X}`);
          }
        }
      }
      await sleep(120);
      // Fold the held-back rows onto the end of the queue exactly once.
      if (i === queue.length - 1 && retry.length) {
        queue.push(...retry.splice(0, retry.length));
      }
    }
  }

  // ⚠️ THE STAMP IS REPEATED HERE, not only in the header. This run walks
  // hundreds of rows, so by the time the verdict prints the header is far off
  // the top of the scrollback — and a verdict whose revision cannot be read is
  // how a stale checkout and a fix that did not work stay indistinguishable.
  // Same reason `fonts:check` and `trending:check` print it; they are one
  // screen, this is not.
  const sources = Object.entries(bySource).map(([s, n]) => `${n} ${s}`).join(', ');
  console.log(`\n${D}build ${build.stamp()}${X}`);
  if (apply && !keep) {
    console.log(
      `\n${G}${fixed}${X} logo(s) added${sources ? ` ${D}(${sources})${X}` : ''}` +
        ` · ${G}${removedDupes}${X} duplicate(s) and ${G}${removedNoLogo}${X} logo-less row(s) removed` +
        `${refused ? ` · ${Y}${refused}${X} refused` : ''}. ${D}Nothing was announced.${X}`,
    );
  } else if (!keep) {
    console.log(`\n${D}Would add ${fixed || Object.values(bySource).reduce((a, b) => a + b, 0)} logo(s)${sources ? ` (${sources})` : ''}. Re-run with --apply.${X}`);
  }
  if (keep) {
    console.log(
      `\n${G}${fixed || Object.values(bySource).reduce((a, b) => a + b, 0)}${X} logo(s) ${apply ? 'added' : 'would be added'}` +
        `${sources ? ` ${D}(${sources})${X}` : ''} · ${B}nothing was deleted${X}.`,
    );
    if (kept.length) {
      // NAMED, with the address. "12 rows still have no logo" sends the
      // operator back to the board to work out which twelve — a diagnosis with
      // no hands attached is a bug report the code files against its owner.
      console.log(
        `\n${Y}${kept.length} row(s) still have no artwork anywhere${X} ${D}— no source has one, so there is` +
          ` nothing to download. Set one by hand on the listing, or leave the monogram:${X}`,
      );
      for (const r of kept) console.log(`  ${D}·${X} $${r.sym} ${D}${r.chain}  ${r.address}  (${r.why})${X}`);
    }
  }
  if (undecided) {
    console.log(
      `${Y}${undecided} row(s) UNDECIDED${X} — a source could not be reached, so they were left alone.\n` +
        `${D}Nothing is deleted on a source that never answered. Re-run in a few minutes;` +
        ` a GECKOTERMINAL_API_KEY removes the rate limit that causes most of these.${X}`,
    );
  }
  console.log('');
  // Undecided rows are unfinished work, not a failure — but the run did not do
  // what it was asked, so it must not exit clean and read as done.
  process.exit(refused || undecided ? 1 : 0);
})().catch((e) => {
  console.error(`\n${R}✗${X} ${e.stack || e.message}\n`);
  process.exit(1);
});
