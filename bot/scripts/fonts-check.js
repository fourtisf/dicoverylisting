#!/usr/bin/env node
'use strict';
/*
 * fonts:check — which scripts THIS box can actually draw on a banner.
 *
 * A token listed as 牛来 ($牛来) went to 12,607 subscribers as "$???", twice:
 * once on the listing card and again on the pump alert. Nothing failed and
 * nothing logged, because a missing glyph does not throw — it draws a box or a
 * question mark and ships.
 *
 * Whether a glyph can be drawn is a property of the FONTS ON THIS MACHINE, not
 * of the code, exactly like `raid:check` and `launchpads:check` before it. So it
 * has to be measured on the box, and this is the command that does it.
 *
 * It also writes a real PNG, because a width comparison proves a font was
 * matched and a human eye is what confirms the result is legible.
 *
 * ⚠️ AND IT MEASURES THE RENDERERS, NOT ONLY THE BOX (2026-08-18). This script
 * printed nine green ticks on a production server whose animated banner was
 * publishing `$老昊` as `$□□` — both true at once, because the fonts were
 * installed and `bannerTemplate` drew with private Latin-only families that
 * could not reach them. A green check over a broken banner is worse than no
 * check: the operator had a screenshot of boxes and a terminal saying
 * everything renders, and stopped looking. So the second half of this report
 * RUNS every surface and reads back the fonts it actually set, and the exit
 * code follows THAT.
 */
// .env before anything reaches config/constants — `loadEnv()` is the one owner
// of that (repo root, bot/, cwd). A diagnostic that reads a different
// configuration from the bot's is a diagnostic about nothing.
require("../src/config/loadEnv").loadEnv();

const path = require('node:path');
const fs = require('node:fs');
const kit = require('../src/helpers/canvasKit');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';

const cov = kit.coverage();
if (!cov.available) {
  console.log(`${R}✗ @napi-rs/canvas is not loadable on this box — every banner is falling back to a static image.${X}`);
  console.log('  Nothing below can be measured until that is fixed.');
  process.exit(1);
}

// WHICH COMMIT AM I MEASURING? A check is read as a statement about the fix
// that was just deployed, and the most common reason a fix "did not work" in
// this repo is that it never reached the box (see CLAUDE.md, step 5). Printing
// the sha costs one line and settles it before anything else is discussed.
console.log(`\nFont coverage for banner rendering   ${D}build ${require('../src/helpers/build').stamp()}${X}\n`);
// The chain, in the order canvas walks it. A script that shows ✗ below is either
// a face this list never found or a face that is present and lacks the glyph —
// and only seeing the resolved paths tells the two apart.
if (cov.faces && cov.faces.length) {
  console.log(`  ${D}fallback chain, in order:${X}`);
  for (const f of cov.faces) console.log(`    ${G}${f.family.replace('DexCover ', '').padEnd(7)}${X} ${D}${f.path}${X}`);
} else {
  console.log(`  ${R}no coverage faces registered at all — every non-Latin name draws boxes${X}`);
}
console.log('');

const LABEL = {
  latin: 'Latin        (Ab)', greek: 'Greek        (Ωπ)', cyrillic: 'Cyrillic     (Дж)',
  chinese: 'Chinese      (牛来)', japanese: 'Japanese     (あア)', korean: 'Korean       (한글)',
  thai: 'Thai         (ไทย)', arabic: 'Arabic       (عربي)', emoji: 'Emoji        (🚀)',
};
let missing = 0;
for (const [k, ok] of Object.entries(cov.scripts)) {
  if (!ok) missing++;
  console.log(`  ${ok ? G + '✓' : R + '✗'}${X} ${LABEL[k] || k}`);
}

// A PICTURE, not just a table. The widths above prove a font was matched; only
// looking at it proves the result is readable at banner size.
try {
  const CV = kit.canvasLib();
  const c = CV.createCanvas(900, 420), ctx = c.getContext('2d');
  ctx.fillStyle = '#0B1620'; ctx.fillRect(0, 0, 900, 420);
  ctx.fillStyle = '#F4F9F8';
  let y = 60;
  for (const [k, sample] of [
    ['brand face', 'Dexvra 0123'], ['chinese', '牛来 ($牛来)'], ['japanese', 'あア 日本語'],
    ['korean', '한글 토큰'], ['cyrillic', 'Дж Токен'], ['thai', 'ไทย'], ['arabic', 'عربي'], ['emoji', '🚀 📈 💎'],
  ]) {
    ctx.font = `28px ${kit.F.r}`;
    ctx.fillStyle = '#7E9AA6'; ctx.fillText(k, 40, y);
    ctx.font = `44px ${kit.F.x}`;
    ctx.fillStyle = '#F4F9F8'; ctx.fillText(sample, 260, y);
    y += 46;
  }
  const out = path.join(__dirname, '..', 'fonts-check.png');
  fs.writeFileSync(out, c.toBuffer('image/png'));
  console.log(`\n  ${D}sample written to${X} ${out}`);
} catch (e) {
  console.log(`\n  ${Y}could not write the sample image: ${e.message}${X}`);
}

// THE PACKAGE, not a count.
//
// This printed "1 script(s) above are still uncovered" on the production box,
// which is a diagnostic and not an instruction — and the script it meant was
// emoji, whose font lives in fonts-noto-color-emoji, a package that NEITHER
// fonts-noto-cjk NOR fonts-noto-core pulls in. The install line given from
// memory left it out, so the operator did everything asked and still had a gap.
// The mapping is in canvasKit now, so the answer is computed rather than recalled.
const gaps = Object.entries(cov.scripts).filter(([, ok]) => !ok).map(([k]) => k);
if (!gaps.length) {
  console.log(`\n${G}Every script sampled here renders.${X}`);
} else {
  const pkgs = kit.packagesFor(gaps);
  // Say what the USER loses, not which file is absent — the rule the upstream
  // probes already follow.
  console.log(`\n${R}Names using ${gaps.join(', ')} draw boxes on every banner they appear on.${X}`);
  // A MISSING BUNDLED FACE IS A DIFFERENT PROBLEM, and it gets a different
  // sentence. Every text face ships in bot/assets/fonts and arrives with the
  // deploy, so one that is absent means the checkout is incomplete — apt would
  // paper over it and leave the repo still wrong.
  const lost = (kit.BUNDLED || []).filter((f) => !fs.existsSync(path.join(kit.FONTS_DIR, f)));
  if (lost.length) {
    console.log(`\n${Y}bot/assets/fonts is missing ${lost.join(', ')} — these are git-tracked and ship with the deploy.${X}`);
    console.log(`  ${G}cd /opt/dexvra && git pull origin main${X}   ${D}(this checkout is incomplete)${X}`);
  }
  if (pkgs.length) {
    console.log('\nFix it on this box:');
    console.log(`  ${G}apt-get install -y ${pkgs.join(' ')}${X}`);
    console.log(`  ${D}then: cd bot && pm2 restart ecosystem.config.js --update-env && npm run fonts:check${X}`);
  }
  console.log(`\n  ${D}…or drop the face into bot/assets/fonts/ — that path is tried first, so it always wins.${X}`);
}

// ── THE SURFACES, MEASURED BY RUNNING THEM ──────────────────────────────────
//
// Everything above is about this BOX. This part is about the BANNERS, and it is
// the half that was missing when a green run of this script sat next to a
// screenshot of `$□□`: the fonts were installed and the overlay renderer could
// not reach them, because it drew with three private Latin-only families.
//
// Nothing here is inferred from source. Each surface is rendered with a Chinese
// name and the fonts it actually set are read back off the canvas context.
const surfaces = require('../src/bannerSurfaces');

(async () => {
  console.log(`\nWhat each BANNER can draw ${D}(measured by rendering "${surfaces.SAMPLE.symbol}")${X}\n`);
  const results = await surfaces.probeAll();
  for (const r of results) {
    const bad = Object.entries(r.scripts).filter(([, ok]) => !ok).map(([k]) => k);
    if (r.error) {
      console.log(`  ${R}✗${X} ${r.what.padEnd(42)} ${R}${r.error}${X}`);
    } else if (bad.length) {
      console.log(`  ${R}✗${X} ${r.what.padEnd(42)} ${R}${bad.join(', ')} draw BOXES here${X}`);
      // The font string is the evidence and the diagnosis at once: a stack with
      // no "DexCover" family in it is a renderer outside the chain, which is a
      // CODE fix, not a font one. Printing it is what turns "still broken" into
      // a file name.
      const worst = r.fonts.find((f) => !/DexCover/.test(f)) || r.fonts[0];
      console.log(`    ${D}${r.module} drew with:${X} ${worst}`);
    } else {
      console.log(`  ${G}✓${X} ${r.what.padEnd(42)} ${D}${Object.keys(r.scripts).join(' ')} · ${r.fonts.length} font stacks${X}`);
    }
  }

  const broken = surfaces.brokenSurfaces(results);
  if (broken.length) {
    console.log(`\n${R}${broken.length} surface(s) would publish boxes even though the fonts above are fine.${X}`);
    console.log(`  ${D}A renderer that registers families of its own is outside the fallback chain.`);
    console.log(`  Every renderer must draw with canvasKit's F.* — see bannerSurfaces.js.${X}`);
    console.log('');
    process.exit(1);          // green must mean "the banners are safe"
  }
  if (!gaps.length) console.log(`\n${G}Every surface draws every script sampled here.${X}`);
  console.log('');
})();
