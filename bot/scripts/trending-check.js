#!/usr/bin/env node
'use strict';
/*
 * trending:check — is every chain at its minimum RIGHT NOW, and if not, why?
 *
 * "Trending base dan ethereum sangat sedikit" was reported three times, each
 * time with a different cause underneath, and every time the operator was the
 * one who noticed by counting rows in the channel. The running bot pages about
 * it now (trendingWatch.js); this is the same question asked on demand, because
 * "wait up to two hours for the next cycle and read pm2" is not an answer when
 * somebody is looking at a short board.
 *
 * Exits non-zero when any configured chain is under its floor, so it is usable
 * straight after a deploy or from a cron.
 */
// ⚠️ .env FIRST, before anything requires config/constants.
//
// The first live run of this script reported "INTERNAL_API_TOKEN is not set" on
// a server where it IS set: `main.js` loads the env before requiring anything
// and a standalone script gets none of that, so the check read as a broken
// server rather than a broken script.
//
// `loadEnv()` is the one owner of "which .env does this process read" — repo
// root, then bot/, then the cwd, with override. A bare
// `require("dotenv").config()` here would be a fourth private idea of it, and
// it would resolve against the CWD alone, which is the exact failure that
// module was written for.
require("../src/config/loadEnv").loadEnv();

const autoTrend = require('../src/services/autoTrend');
const watch = require('../src/services/trendingWatch');
const api = require('../src/api/dexvra');
const { chainOf } = require('../src/config/chains');
const build = require('../src/helpers/build');
const { fmtCap } = require('../src/helpers/format');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';

(async () => {
  const cfg = autoTrend.get();
  console.log(`\nTrending board vs the minimum you set   ${D}build ${build.stamp()}${X}\n`);
  if (!cfg.enabled) {
    console.log(`  ${Y}⚠ Auto Trending is OFF${X} — nothing tops the board up. @dexvraadminbot → 🤖 Auto Trending → ▶️ Enable.\n`);
  }

  let rows;
  try {
    rows = (await api.getListings()) || [];
  } catch (e) {
    console.log(`${R}✗ could not read the listings API: ${e.message}${X}`);
    if (/INTERNAL_API_TOKEN/.test(e.message)) {
      // Naming the files that WERE read is the whole diagnosis: "not set" over a
      // list containing bot/.env is a missing line in that file, and "not set"
      // over an empty list is a script that read no .env at all — which is what
      // this very check shipped doing.
      const envFiles = require('../src/config/loadEnv').loadEnv();
      console.log(`  ${D}.env read: ${envFiles.length ? envFiles.join(', ') : 'NONE — no .env at the repo root, in bot/, or in this directory'}`);
      console.log(`  That value lives in .env on the server and nowhere in this repo. If the bot is`);
      console.log(`  listing and trending normally it IS set — add it to one of the files above.${X}`);
    }
    console.log('  Nothing below can be measured until that answers.\n');
    process.exit(1);
  }

  const now = Date.now();
  const isFeatured = (r) => r.status === 'approved' && r.trendingRank != null && (!r.trendExp || r.trendExp > now);
  const on = (r, id) => String(r.chain).toLowerCase() === String(id).toLowerCase();

  const target = cfg.perChainMax > cfg.perChainMin ? `${cfg.perChainMin}–${cfg.perChainMax}` : `${cfg.perChainMin}`;
  // The free-trending floors are printed HERE, on the config line, because from
  // a short board they are indistinguishable from a chain with no listings —
  // and unlike everything else on this line they refuse candidates silently
  // unless somebody is reading pm2. `OFF` for a 0 is the whole point: a floor
  // nobody set must not read as a floor that refused something.
  // ⚠️ Through the bot's own phrase. The OR gate here used to drag the other
  // floor's `$0` onto the line the moment one of the two was switched off, so
  // `min cap $0 · min 24h vol $10.0K` told an operator their tokens were being
  // refused by a floor of nothing.
  const floors = cfg.minMcapUsd > 0 || cfg.minVol24hUsd > 0 ? autoTrend.floorsPhrase(cfg) : 'quality floors OFF';
  console.log(`  ${D}target ${target} per chain · gain floor +${cfg.minGainPct}% · ${floors} · fill from market ${cfg.fillFromMarket ? 'ON' : 'OFF'}${X}\n`);

  // ── --floors: how many spares the quality floors would refuse ──────────────
  //
  // ⚠️ MEASURED WITH THE PRODUCTION FUNCTIONS, never re-derived. `byGain` is
  // what annotates a candidate and `floorRefusal` is what judges one, so this
  // asks the same two questions the promoter asks, in the same order, and
  // cannot answer differently from the running bot. A second copy of "is this
  // token big enough" is how `fonts:check` printed nine green ticks over a
  // banner drawing boxes.
  //
  // Behind a FLAG because it prices spares at GeckoTerminal's politeness pace —
  // 250ms each, up to PROBE_CAP a chain — which is most of a minute on a busy
  // install, and the default run has to stay usable from a cron. Without it the
  // floors still appear on the config line above, so the operator knows this
  // flag is the next thing to try.
  const measureFloors = process.argv.includes('--floors');
  const refusedByChain = new Map();
  const unreadByChain = new Map();
  const consideredByChain = new Map();
  const freeFallByChain = new Map();
  const noReadingByChain = new Map();
  // ⚠️ NOT GATED ON THE FLOORS BEING ON ANY MORE. This pass measures three
  // things now — how many rows the window opened, how many the floors refused,
  // how many could not be read — and only the middle one is about the floors.
  // With both floors at 0 the old gate priced nothing, so every short chain
  // reported "this run did not price them" and the fix it names (`--floors`)
  // was the flag the operator had just used.
  if (measureFloors) {
    console.log(`  ${D}pricing spares against the floors — a bounded, rotating window per chain, this takes a moment${X}\n`);
    for (const id of cfg.chains) {
      const spares = rows.filter((r) => r.status === 'approved' && !isFeatured(r) && on(r, id));
      if (!spares.length) continue;
      // ⚠️ THE BOT'S OWN WINDOW, READ AND NOT ADVANCED. `probeStamps` is what
      // decides which slice the next cycle opens, so handing it over measures
      // the rows the bot is about to judge rather than a prefix of this
      // script's own. It is deliberately NOT saved back: a diagnostic that
      // moved the rotation on would change the thing it is measuring, showing
      // the operator one window while the bot then opened the next.
      const ranked = await autoTrend
        .byGain(spares, undefined, { probes: autoTrend.probeStamps() })
        .catch(() => []);
      // ⚠️ THE BOT'S OWN PREDICATE, not a copy of it — the rule the refusal
      // count two lines down already carries a scar for. `_change !== undefined`
      // spelled out here is a second owner of "did we open this row", and the
      // day one of them learns about a new annotation the check reports a
      // window the bot never had.
      consideredByChain.set(id, autoTrend.countOpened(ranked));
      // The two gates BELOW the floors, over the rows that CLEARED them — the
      // same sets the cycle counts, so the check cannot name a different cause
      // from the bot. Without them a chain whose spares cleared every floor and
      // still did not go on printed as a floor problem.
      const cleared = ranked.filter((r) => autoTrend.opened(r) && !autoTrend.floorRefusal({ mcap: r._mcap, vol24: r._vol24 }, cfg));
      freeFallByChain.set(id, cleared.filter((r) => Number.isFinite(r._change) && r._change < autoTrend.FLOOR_FILL_MAX_DROP * -1).length);
      noReadingByChain.set(id, cleared.filter((r) => !Number.isFinite(r._change)).length);
      // ⚠️ THE BOT'S OWN COUNTER, not a copy of it. This line used to filter on
      // `floorRefusal` alone and so counted the tail `byGain` never priced: on
      // a chain with 44 spares it reported 44 refusals where the running bot
      // reports 25, and the check and the thing it mirrors disagreed about the
      // one number an operator would act on. `fonts:check` printed nine green
      // ticks over a banner drawing boxes for exactly this reason.
      refusedByChain.set(id, autoTrend.countFloorRefusals(ranked, cfg));
      // ⚠️ AND HOW MANY COULD NOT BE READ AT ALL. A shared-429 leaves a null
      // cap, a null cap cannot satisfy a floor, and the whole chain then reads
      // as "your tokens are too small" — an upstream reported as a setting.
      // Measured with the bot's own annotation, not a second idea of it.
      unreadByChain.set(id, ranked.filter((r) => r._unread).length);
    }
  }

  const short = [];
  for (const id of cfg.chains) {
    const featured = rows.filter((r) => isFeatured(r) && on(r, id)).length;
    const eligible = rows.filter((r) => r.status === 'approved' && !isFeatured(r) && on(r, id)).length;
    const label = (chainOf(id) && chainOf(id).label) || id;
    const why = watch.diagnose({
      featured,
      floor: cfg.perChainMin,
      eligible,
      gainFloor: cfg.minGainPct,
      // Only ever passed when it was actually MEASURED. Handing diagnose a 0
      // it did not measure would silently pick the "−15%" branch over a chain
      // whose spares are dead, which is the wrong sentence and the one the
      // operator would act on.
      floorRefused: refusedByChain.get(id) || 0,
      unread: unreadByChain.get(id) || 0,
      // Only ever the MEASURED window, for the same reason the two counts
      // above are: a chain this run did not price has no window to report, and
      // inventing one would put "N not opened yet" on a line nobody measured.
      considered: consideredByChain.has(id) ? consideredByChain.get(id) : null,
      freeFall: freeFallByChain.get(id) || 0,
      noReading: noReadingByChain.get(id) || 0,
      // ⚠️ THE PHRASE, which is the only thing `diagnose` reads. This passed
      // `minMcapUsd`/`minVol24hUsd` — two fields that function has never looked
      // at — so the floors fell back to the placeholder and the check printed
      // "(see ⚙️ Auto-Trend)" where the BOT prints "(cap $100.0K, 24h vol
      // $10.0K)". Two surfaces describing one rule differently, and the check
      // dropped the two numbers the operator would act on. A parameter that
      // looks meaningful and binds nothing is the row the engine ignores.
      floorsText: autoTrend.floorsPhrase(cfg),
    });
    const unread = unreadByChain.get(id) || 0;
    // ⚠️ "N below the floors" OUT OF HOW MANY WERE OPENED, never out of how
    // many exist. The probe window is bounded and it rotates, so a bare count
    // reads as a verdict on every listing the chain has — and that is the
    // sentence five rounds of a short board were mis-diagnosed from.
    const seen = consideredByChain.get(id) || 0;
    const floorNote = refusedByChain.has(id)
      ? ` ${D}· ${refusedByChain.get(id)} of ${seen} opened are below the floors${X}` +
        // ⚠️ AND WHAT REFUSED THE REST. Printing only the floor count over a
        // chain where most of the opened rows CLEARED the floors is the line
        // that sent this investigation to the wrong setting twice.
        ((freeFallByChain.get(id) || 0) ? ` ${D}· ${freeFallByChain.get(id)} below −15%${X}` : '') +
        ((noReadingByChain.get(id) || 0) ? ` ${D}· ${noReadingByChain.get(id)} with no 24h reading${X}` : '') +
        (unread ? ` ${Y}· ${unread} could not be priced${X}` : '') +
        (eligible > seen ? ` ${D}· ${eligible - seen} not opened yet${X}` : '')
      : '';
    if (why) {
      short.push({ id, featured, why });
      console.log(`  ${R}✗${X} ${String(label).padEnd(12)} ${R}${featured}/${cfg.perChainMin}${X} ${D}· ${eligible} spare listing(s)${X}${floorNote}`);
      console.log(`      ${Y}${why.text}${X}`);
    } else {
      console.log(`  ${G}✓${X} ${String(label).padEnd(12)} ${featured}/${cfg.perChainMin} ${D}· ${eligible} spare listing(s)${X}${floorNote}`);
    }
  }
  // Printed whatever the floors are set to: without this flag nothing here was
  // priced, so every short chain above could only say it does not know why.
  if (!measureFloors && short.length) {
    console.log(`\n  ${D}re-run with --floors to price this cycle's window — how many rows it opened, how many the floors refuse, how many could not be read${X}`);
  }

  // ── "ADA BEBERAPA TOKEN TIDAK ADA PERSENAN TOKENYA WHY?" ───────────────────
  //
  // Rows on the public board carry a market cap and no percentage. The board
  // itself must not explain that — it is read by 10,593 subscribers and an
  // operator diagnostic on it would be chrome — so the answer lives here, and
  // it is MEASURED with the very call the board makes, on this box, rather than
  // reasoned about from the code.
  //
  // Behind a flag because it prices every featured token at GT's politeness
  // pace: ~30 rows is most of a minute, and the count check above is what an
  // operator usually came for.
  let blankRows = 0;
  if (process.argv.includes('--rows')) {
    // ⚠️ THIS DRIVES THE REAL RENDERER. It used to ask `fetchMarket` itself,
    // which is a SECOND copy of the board's question — and a check that
    // measures a stack the renderer does not use is how `fonts:check` printed
    // nine green ticks over a banner publishing boxes. `buildText()` is the one
    // function the pinned board goes through; whatever it drew, this reports.
    const poster = require('../src/services/trendingPoster');
    console.log(`\n  ${D}What the board itself just rendered (buildText, the same call the poster makes)${X}`);
    const text = await poster.buildText();
    const rec = poster.lastRender();
    // A surface that renders NOTHING is an error, never a quiet ✓ — an empty
    // measurement measured nothing, and reporting that as a pass is the whole
    // defect in miniature.
    if (!text || !rec || !rec.rows) {
      console.log(`  ${R}✗${X} the board rendered no rows at all — nothing is featured, or buildText failed`);
      blankRows = -1;
    } else {
      blankRows = rec.blank.length;
      for (const b of rec.blank) {
        console.log(`  ${Y}·${X} ${String('$' + b.sym).padEnd(13)} ${D}${b.chain}${X}  ${b.why || 'no reason recorded'}`);
      }
      if (!blankRows) console.log(`  ${G}✓${X} all ${rec.rows} row(s) on the board carry a 24h percentage`);
      else
        console.log(
          `  ${D}${blankRows}/${rec.rows} row(s) publish "—" instead of a percentage. That mark is deliberate:\n` +
            `  an unreadable change is not a 0%, and printing one on a public board would be a\n` +
            `  claim nobody measured. Auto-promotion and the market filler both refuse a token\n` +
            `  with no reading, so a row here is a slot somebody PAID for — or a reading that\n` +
            `  went away after the slot was booked, which resolves when it expires.${X}`,
        );
    }
  } else {
    console.log(`  ${D}A row showing "—" instead of a %? npm run trending:check -- --rows says which and why.${X}`);
  }

  if (!short.length && blankRows <= 0) {
    console.log(`\n${G}Every chain is at or above its minimum.${X}\n`);
    return;
  }
  // A board full of dashes is a FAILING board, so green has to mean "the board
  // is safe" rather than "the counts add up" — `fonts:check` had to learn the
  // same thing after printing nine green ticks over a broken banner. Only ever
  // when --rows was asked: without it nothing here measured the percentages,
  // and a check must not fail on a question it did not put.
  if (blankRows !== 0) {
    console.log(
      blankRows < 0
        ? `\n${R}The board rendered nothing.${X}`
        : `\n${R}${blankRows} row(s) on the board carry no percentage.${X}`,
    );
    console.log(`  ${D}The bot pages the ops channel when that lasts ${Math.round(watch.GRACE_MS / 60000)} min.${X}`);
  }
  if (!short.length) {
    console.log('');
    process.exit(1);
  }
  console.log(`\n${R}${short.length} chain(s) below the minimum of ${cfg.perChainMin}.${X}`);
  // The running bot says the same thing in the ops channel after
  // TREND_SHORT_GRACE_MS — this is only the same answer, sooner.
  console.log(`  ${D}The bot pages the ops channel when a chain stays short for ${Math.round(watch.GRACE_MS / 60000)} min.${X}`);
  console.log(`  ${D}⚡ Run now on @dexvraadminbot → 🤖 Auto Trending fills one chain immediately.${X}\n`);
  process.exit(1);
})().catch((e) => {
  console.error(`trending:check failed: ${e.stack || e.message}`);
  process.exit(1);
});
