'use strict';
/*
 * EVERY SURFACE THAT BURNS TOKEN TEXT INTO AN IMAGE — the list, in one place,
 * and a probe that answers "would this one draw 老昊, or boxes?" by RUNNING it.
 *
 * WHY THIS FILE EXISTS (2026-08-18). `npm run fonts:check` printed nine green
 * ticks on the production box while the animated banner was publishing `$老昊`
 * as `$□□` to the channel. Neither half was lying:
 *
 *   • the fonts really were installed — that is all coverage() ever measured;
 *   • `bannerTemplate` drew with three private Latin-only families of its own,
 *     so it could not reach them.
 *
 * A green check over a broken banner is worse than no check, because it ends
 * the investigation — the operator had a screenshot of boxes and a terminal
 * saying everything renders, and those two facts cannot both be acted on.
 *
 * So the question this module asks is not "does the box have the glyphs?" but
 * "does each SURFACE draw with them?", and the only honest way to answer that
 * is to run the renderer and read back the fonts it actually set.
 *
 * THE LIST IS THE POINT. A renderer that is not in it is not measured, which is
 * precisely how the overlay went unnoticed for six days — so
 * `bannerFonts.test.js` fails the build if a module that calls `warnBoxes()` is
 * missing here. Adding a new card means adding a line below; that is the whole
 * cost, and it is smaller than another screenshot.
 */
const kit = require('./helpers/canvasKit');

/** The name that started this. Mixed on purpose: Han + Latin in one string is
 *  what the per-glyph chain exists for, and a renderer that swapped the whole
 *  face would still pass a Han-only sample. */
const SAMPLE = {
  symbol: '老昊',
  name: '老昊 Finance',
  chain: 'BSC',
  price: 0.002111,
  mcap: 2111501,
};

/** The scripts a ticker has actually turned up in, plus the ones a listing form
 *  will eventually be handed. Latin is deliberately absent — it is drawn by the
 *  brand face and tells us nothing about the chain. */
const SCRIPTS = [
  ['chinese', '老昊'], ['japanese', 'あア'], ['korean', '한글'],
  ['thai', 'ไทย'], ['arabic', 'عربي'],
];

/*
 * Each entry names the surface in the terms an operator sees it in — "the GIF
 * under a listing post", not "compose(kind, …, { transparent: true })". A check
 * whose output has to be translated into what the channel shows is one nobody
 * reads twice.
 *
 * Requires are INSIDE `run` so that listing a surface costs nothing until it is
 * probed, and so this module stays requirable when @napi-rs/canvas is absent.
 */
const SURFACES = [
  {
    key: 'listing',
    what: 'listing card (still PNG)',
    module: 'bannerRender.js',
    run: (coin) => require('./bannerRender').renderListingBanner(coin, null),
  },
  {
    key: 'trending',
    what: 'trending card (still PNG)',
    module: 'bannerRender.js',
    run: (coin) => require('./bannerRender').renderTrendingBanner(coin, null),
  },
  {
    key: 'rankup',
    what: 'rank-up card (still PNG)',
    module: 'bannerRender.js',
    run: (coin) => require('./bannerRender').renderRankUpBanner(coin, null, { rank: 3, prevRank: 7 }),
  },
  {
    // THE ONE THAT SHIPPED THE BOXES. Every animated overlay goes through
    // compose() — the listing GIF, the trending clip, the pump alert — so a
    // single probe covers all of them, and `transparent: true` is that same
    // path with the artwork left out (it needs no template file to exist).
    key: 'overlay',
    what: 'animated GIF/MP4 overlay — listing clip, pump alert',
    module: 'bannerTemplate.js',
    run: (coin) => require('./bannerTemplate').compose('listing', null, coin, { transparent: true }),
  },
  {
    key: 'gainers',
    what: 'Top Gainers board',
    module: 'gainersBanner.js',
    run: (coin) => require('./gainersBanner').render({
      coins: [{ ...coin, symbol: coin.symbol, name: coin.name, changePct: 42, mcapUsd: coin.mcap }],
      dateText: '',
    }),
  },
];

/*
 * NOT PROBED HERE, and deliberately: `tradebot/pnlImage.js`.
 *
 * It draws through this same canvasKit — `K.F.d7` / `K.F.m7` and so on — which
 * is the entire reason that rule exists, and `bannerFonts.test.js` scans it for
 * a hardcoded family alongside the modules above. What it cannot take is a
 * COIN: its input is a computed PnL snapshot, and the card refuses to draw when
 * anything in one is unknown (a branded card is a claim). A fabricated snapshot
 * renders nothing, so a probe here would report "drew no text at all" on a
 * perfectly healthy renderer — a false red, which trains the reader to ignore
 * the red that matters. `cd tradebot && node --test pnlCard.test.js` is where
 * that surface is exercised.
 */

/**
 * Run one surface and report which scripts it can draw.
 *
 * A render that THROWS is reported as an error rather than as coverage: a
 * surface that cannot draw at all is a different problem from one that draws
 * boxes, and reporting the first as the second sends an operator to apt.
 */
async function probeSurface(surface, coin = SAMPLE) {
  const out = { key: surface.key, what: surface.what, module: surface.module, fonts: [], scripts: {}, error: null };
  let fonts = [];
  try {
    fonts = await kit.recordFonts(() => surface.run(coin));
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
    return out;
  }
  out.fonts = [...new Set(fonts)];
  if (!out.fonts.length) {
    // Nothing was drawn — usually @napi-rs/canvas missing, sometimes a renderer
    // that returned early. Either way the probe measured nothing, and saying so
    // beats reporting an empty pass.
    out.error = 'drew no text at all';
    return out;
  }
  // A surface is only as good as its WORST font string: one heading drawn with
  // a Latin-only stack is the whole defect, however many other lines are fine.
  for (const [name, sample] of SCRIPTS) {
    out.scripts[name] = out.fonts.every((f) => kit.reachesCoverage(f, sample) === true);
  }
  return out;
}

/** Every surface, in order. Serial on purpose — these share one canvas library
 *  and the font-setter wrap is process-wide, so two at once would record each
 *  other's fonts and blame the wrong surface. */
async function probeAll(coin = SAMPLE) {
  const out = [];
  for (const s of SURFACES) out.push(await probeSurface(s, coin));
  return out;
}

/** The scripts NO surface should be failing. Used for the exit code, so a green
 *  run means "the banners are safe", not "the box has fonts". */
const brokenSurfaces = (results) =>
  results.filter((r) => r.error || Object.values(r.scripts).some((ok) => !ok));

module.exports = { SURFACES, SAMPLE, SCRIPTS, probeSurface, probeAll, brokenSurfaces };
