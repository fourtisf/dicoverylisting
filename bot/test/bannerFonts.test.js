// The banner drew "$???" in front of 12,607 subscribers.
//
// A token listed as 牛来 ($牛来) came out on the listing card as "$???" and again
// on the pump alert as "??". Nothing failed and nothing logged: a font that
// lacks a glyph does not throw, it draws a box or a question mark and ships.
//
// EVERY brand face in this repo is Latin-only — Sora, Space Grotesk, JetBrains
// Mono, Liberation Sans — so every Chinese, Japanese, Korean, Thai or Arabic
// ticker the bot has ever rendered came out the same way.
//
// The fix is a FALLBACK CHAIN, not a second font for Chinese. Canvas resolves a
// comma-separated family list per GLYPH, so "牛来 Finance" keeps the brand face
// for the Latin word and reaches the coverage face only for the Han characters.
// Swapping the whole face on a mixed name would put brand type on one half of a
// title and a system face on the other.
//
// Whether a given glyph can be drawn is a property of the FONTS ON THIS BOX, not
// of the code — the same shape as `raid:check` and `launchpads:check` — so what
// is asserted here is the MECHANISM: that a chain is built, that the brand face
// leads it, and that the report tells the truth about what is missing. Coverage
// itself is `npm run fonts:check`, on the machine that renders.
const test = require("node:test");
const assert = require("node:assert");
const fss = require("node:fs");
const path = require("node:path");

const kit = require("../src/helpers/canvasKit");
const SRC = fss.readFileSync(path.join(__dirname, "..", "src", "helpers", "canvasKit.js"), "utf8");

test("every family carries the coverage chain, so no renderer has to opt in", () => {
  if (!kit.available()) return;   // no native canvas on this box: nothing to assert
  const cov = kit.coverage();
  if (!cov.cjk) return;           // no CJK font installed here — fonts:check says so
  // A renderer that had to ask for the fallback is a renderer that will forget
  // to, on the one card that needed it.
  for (const key of Object.keys(kit.F)) {
    assert.match(kit.F[key], /"DexCover CJK"/, `${key} would still draw boxes for a Chinese name`);
  }
});

test("the brand face LEADS the chain — the fallback never takes over a Latin name", () => {
  if (!kit.available()) return;
  const cov = kit.coverage();
  if (!cov.cjk) return;
  for (const key of Object.keys(kit.F)) {
    assert.ok(!/^"DexCover/.test(kit.F[key]), `${key} resolves Latin text with the coverage font, not the brand face`);
  }
});

test("the 800 display weight is Sora, not Liberation — it silently was not", () => {
  // reg() assigns unconditionally, and the two Liberation "fallback" calls ran
  // AFTER their Sora counterparts, so Liberation won the keys it touched. `x` is
  // the big token title on every card, and it had been off-brand for as long as
  // the brand fonts have been in the repo. Nothing failed; the artwork was just
  // quietly wrong on its most prominent line.
  assert.match(SRC, /const regFb = \(file, fam, key\) => \{ if \(F\[key\] === "sans-serif"\) reg\(file, fam, key\); \};/);
  assert.match(SRC, /regFb\("LiberationSans-Bold\.ttf", "DexBold", "x"\);/);
  assert.match(SRC, /regFb\("LiberationSans-Regular\.ttf", "DexReg", "m"\);/);
  assert.ok(!/\breg\("LiberationSans/.test(SRC), "the unconditional overwrite is back");
  if (!kit.available()) return;
  const fontsDir = path.join(__dirname, "..", "assets", "fonts");
  if (fss.existsSync(path.join(fontsDir, "Sora-800.ttf"))) {
    assert.match(kit.F.x, /^"Sora XBold"/, "the display weight is Liberation again");
    assert.match(kit.F.m, /^"Sora Med"/);
  }
});

test("the coverage font is DISCOVERED across a list, never one hardcoded path", () => {
  // Same rule as the launchpad hosts: a box that keeps its fonts somewhere else,
  // or an operator who drops one into assets/, must not need a code change.
  assert.match(SRC, /const CJK_CANDIDATES = \[/);
  const list = SRC.slice(SRC.indexOf("const CJK_CANDIDATES = ["), SRC.indexOf("const EMOJI_CANDIDATES"));
  assert.ok((list.match(/\n/g) || []).length > 4, "the candidate list collapsed to a single path");
  // The repo's own assets are tried FIRST, so dropping a file in wins over
  // whatever the distro happens to ship.
  assert.ok(list.indexOf('"..", "assets", "fonts"') < list.indexOf("/usr/share/fonts"),
    "a system font outranks one the operator deliberately placed");
  // An unreadable font must not take the process down with it.
  assert.match(SRC, /catch \(_\) \{ \/\* unreadable font is not a reason to fail boot \*\/ \}/);
});

test("extra scripts need a package, never a deploy", () => {
  // Thai/Arabic/Devanagari/Hebrew are in the chain the moment fonts-noto-core
  // exists. Listing them up front is what makes installing the package the whole
  // fix — the contract the launchpad hosts already have.
  for (const fam of ["DexCover Thai", "DexCover Arabic", "DexCover Deva", "DexCover Hebrew"]) {
    assert.ok(SRC.includes(fam), `${fam} is not in the candidate list`);
  }
  // Emoji goes LAST: a colour-emoji face claims some text codepoints, and a
  // ticker's letters must not resolve to it ahead of a real text font.
  const build = SRC.slice(SRC.indexOf("COVER.faces = [];"), SRC.indexOf("const tail ="));
  assert.ok(build.indexOf("EXTRA_CANDIDATES") < build.indexOf("COVER.emoji"),
    "emoji is ahead of the text faces in the chain");
});

test("BOLD is preferred — a regular-weight Thai word beside a heavy Latin one is two titles", () => {
  // These faces sit next to the 700/800 display weights. Taking whichever
  // variant the distro happened to install first is the same defect as swapping
  // the face on a mixed name, one level down.
  assert.match(SRC, /const script = \(family, bold, reg, extra = \[\]\) => \[family, \[\s*asset\(bold\), asset\(reg\), \.\.\.sysNoto\(bold\), \.\.\.sysNoto\(reg\)/);
  assert.match(SRC, /script\("DexCover Thai", "NotoSansThai-Bold\.ttf", "NotoSansThai-Regular\.ttf"/);
  assert.match(SRC, /script\("DexCover Arabic", "NotoSansArabic-Bold\.ttf", "NotoSansArabic-Regular\.ttf"/);
  if (!kit.available()) return;
  for (const f of kit.coverage().faces || []) {
    if (/Regular/.test(f.path) && fss.existsSync(f.path.replace("Regular", "Bold"))) {
      assert.fail(`${f.family} took the Regular weight while a Bold sits beside it: ${f.path}`);
    }
  }
});

test("the missing-font warning names EVERY uncovered script, not just Chinese", () => {
  // The first cut warned about CJK alone, which would have let the next Thai or
  // Arabic ticker reach the channel as boxes in exactly the same silence. A
  // warning that covers one instance of a general failure is how the general
  // failure survives being fixed.
  const load = SRC.slice(SRC.indexOf("const gaps ="), SRC.indexOf("} catch (e) {"));
  assert.match(load, /Object\.entries\(coverage\(\)\.scripts\)\.filter\(\(\[, ok\]\) => !ok\)/);
  assert.match(load, /no font covers \$\{gaps\.join\(", "\)\}/);
  assert.match(load, /draws boxes on every card/);
  assert.ok(!/no CJK font found/.test(SRC), "the CJK-only warning is back");
});

test("the check prints the resolved chain, so ✗ is an instruction not a puzzle", () => {
  // "thai ✗" is either a face this list never looked for or a face that is
  // installed and lacks the glyph. Only the resolved paths separate the two.
  if (!kit.available()) return;
  const cov = kit.coverage();
  assert.ok(Array.isArray(cov.faces), "coverage() no longer reports the chain");
  for (const f of cov.faces) {
    assert.ok(f.family && f.path, "a chain entry has no family or no path");
    assert.ok(fss.existsSync(f.path), `${f.family} points at a file that is not there: ${f.path}`);
  }
});

test("a missing font is SAID, not discovered from a customer screenshot", () => {
  // What the USER loses and what to run — not which file happens to be absent.
  // "lite-api ENOTFOUND" does not tell an operator whether to act; "a token
  // named in one of those draws boxes on every card" does.
  assert.match(SRC, /a token named in one of those draws boxes/);
  assert.match(SRC, /fonts-noto-cjk and fonts-noto-core/);
  assert.match(SRC, /npm run fonts:check/);
});

test("coverage() measures instead of assuming", () => {
  if (!kit.available()) return;
  const cov = kit.coverage();
  assert.strictEqual(cov.available, true);
  assert.strictEqual(cov.scripts.latin, true, "the control sample failed — the probe itself is broken");
  for (const k of ["chinese", "japanese", "korean", "emoji", "thai", "arabic"]) {
    assert.strictEqual(typeof cov.scripts[k], "boolean", `${k} is not reported at all`);
  }
  // The comparison is against the BARE first family, so a chain that silently
  // lost its tail reports false rather than inheriting a stale true.
  assert.match(SRC, /const bare = F\.r\.split\(","\)\[0\]\.trim\(\);/);
});

test("fonts:check is wired up, because it can only be answered on the box", () => {
  const pkg = JSON.parse(fss.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.strictEqual(pkg.scripts["fonts:check"], "node scripts/fonts-check.js");
  assert.ok(fss.existsSync(path.join(__dirname, "..", "scripts", "fonts-check.js")));
});

// ── The general guard: never ship boxes unnoticed again ──────────────────────

test("unrenderable() answers about the STRING, not about a list of scripts", () => {
  if (!kit.available()) return;
  const cov = kit.coverage();
  // The nine scripts coverage() samples are exactly as blind as the next name is
  // unusual. On a box with a full Noto install it reported all green while
  // Armenian, Bengali, Tamil and Georgian still drew boxes — which is the same
  // silence that shipped "$???", one script family over.
  if (cov.scripts.chinese) assert.deepStrictEqual(kit.unrenderable("牛来"), [], "a covered script is being flagged");
  if (cov.scripts.thai) assert.deepStrictEqual(kit.unrenderable("ไทยบาท"), []);
  if (cov.scripts.arabic) assert.deepStrictEqual(kit.unrenderable("عملة"), []);
  // Latin, digits, punctuation and emoji must never be flagged: a warning that
  // fires on ordinary tickers is a warning that gets muted.
  for (const s of ["PEPE", "Dexvra 0123", "$ABC-1", "🚀 Moon", "Ω Alpha", "Дж"]) {
    assert.deepStrictEqual(kit.unrenderable(s), [], `false positive on ${s}`);
  }
  // And it must actually catch something this box cannot draw.
  const armenian = kit.unrenderable("Ամանոր");
  if (!cov.scripts.latin) return;
  assert.ok(Array.isArray(armenian), "unrenderable did not return a list");
});

test("the check is per CODEPOINT, so an emoji is one glyph and not two halves", () => {
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "helpers", "canvasKit.js"), "utf8");
  const fn = src.slice(src.indexOf("function unrenderable(text)"), src.indexOf("function warnBoxes("));
  assert.match(fn, /for \(const ch of s\)/, "iterating by UTF-16 unit would split every surrogate pair");
  assert.match(fn, /if \(cp < 0x0100\) continue;/, "ASCII is measured on every render for nothing");
  assert.match(fn, /_tofuCache/, "every banner re-measures the same codepoints");
  // The probe is a Private Use codepoint: in no real font, so its advance IS the
  // notdef box this face draws.
  assert.match(fn, /ctx\.measureText\("\u{E000}"\)\.width/u, "the notdef probe is gone — the comparison has no reference");
});

test("EVERY renderer entry calls the guard — a per-renderer guard is one a new renderer will not have", () => {
  const BR = fss.readFileSync(path.join(__dirname, "..", "src", "bannerRender.js"), "utf8");
  const BT = fss.readFileSync(path.join(__dirname, "..", "src", "bannerTemplate.js"), "utf8");
  // The listing/trending card, the rank-up card, and compose() — which is the
  // ONE function every template overlay goes through, the pump alert included.
  assert.match(BR, /warnBoxes\(opts && opts\.pill === "TRENDING NOW" \? "trending" : "listing", coin\);/);
  assert.match(BR, /async function renderRankUpBanner\(coin, logoBuffer, opts = \{\}\) \{[\s\S]{0,160}warnBoxes\("rank-up", coin\);/);
  assert.match(BT, /warnBoxes\(kind, \{ symbol, name \}\);/);
  // It is imported, never re-implemented: two copies would drift, and the pump
  // overlay lives in a different module from the cards.
  for (const [name, src] of [["bannerRender", BR], ["bannerTemplate", BT]]) {
    assert.match(src, /warnBoxes/, `${name} does not use the guard at all`);
    assert.ok(!/function warnBoxes\(/.test(src), `${name} grew its own copy of the guard`);
  }
});

test("the guard warns and renders anyway", async () => {
  if (!kit.available()) return;
  const log = require("../src/helpers/logger");
  const br = require("../src/bannerRender");
  const alerts = [];
  const real = log.alert;
  log.alert = (h) => alerts.push(String(h).replace(/<[^>]+>/g, ""));
  try {
    // A name this box cannot draw must still produce artwork: the project is
    // owed its listing, and a render that refused would turn a blemish into an
    // outage.
    const buf = await br.renderListingBanner({ symbol: "Ամանոր", name: "Ամանոր Token", chain: "BSC" }, null);
    assert.ok(buf && buf.length > 1000, "a token with missing glyphs produced no banner at all");
    if (kit.unrenderable("Ամանոր").length) {
      assert.ok(alerts.some((a) => /Banner glyphs missing/.test(a)), "it shipped boxes in silence — the whole defect");
      assert.ok(alerts.some((a) => /It still went out/.test(a)), "the alert does not say the artwork was published");
    }
    // A renderable name must stay quiet, or the alert becomes noise.
    alerts.length = 0;
    if (kit.coverage().scripts.chinese) {
      await br.renderListingBanner({ symbol: "牛来", name: "牛来 Finance", chain: "BSC" }, null);
      assert.deepStrictEqual(alerts, [], "a perfectly renderable name raised an alert");
    }
  } finally {
    log.alert = real;
  }
});

test("the fix is a PACKAGE NAME, computed — not one recalled from memory", () => {
  // The install line handed to the operator was fonts-noto-cjk + fonts-noto-core,
  // and emoji lives in fonts-noto-color-emoji, which NEITHER of those pulls in.
  // So the operator did exactly what was asked and still had a gap — reported
  // back as "✗ Emoji". Naming the fix from memory is the mistake; the mapping is
  // in code so it cannot be made again.
  assert.deepStrictEqual(kit.packagesFor(["emoji"]), ["fonts-noto-color-emoji"]);
  assert.deepStrictEqual(kit.packagesFor(["chinese", "japanese", "korean"]), ["fonts-noto-cjk"]);
  assert.deepStrictEqual(kit.packagesFor(["thai", "arabic"]), ["fonts-noto-core"]);
  // Deduplicated, and every sampled script maps to something: a gap the mapping
  // does not know about prints a count again, which is what this replaced.
  const all = kit.packagesFor(["chinese", "korean", "thai", "emoji"]);
  assert.deepStrictEqual(all, ["fonts-noto-cjk", "fonts-noto-core", "fonts-noto-color-emoji"]);
  if (!kit.available()) return;
  for (const s of Object.keys(kit.coverage().scripts)) {
    if (s === "latin") continue;   // no package needed; it is the control sample
    assert.ok(kit.packagesFor([s]).length === 1, `${s} is sampled but maps to no package`);
  }
});

test("the emoji face is looked for where each distro actually puts it", () => {
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "helpers", "canvasKit.js"), "utf8");
  const list = src.slice(src.indexOf("const EMOJI_CANDIDATES = ["), src.indexOf("const PKG_FOR"));
  // Debian/Ubuntu is where the production box is, and it was the ONE path that
  // happened to be right — a single-path list would have been luck, not design.
  assert.match(list, /\/usr\/share\/fonts\/truetype\/noto\/NotoColorEmoji\.ttf/);
  assert.match(list, /google-noto-emoji/, "Fedora/RHEL layout is not searched");
  assert.ok((list.match(/NotoColorEmoji|Apple Color Emoji/g) || []).length >= 5, "the candidate list is too narrow to be a list");
  assert.ok(list.indexOf('"..", "assets", "fonts"') < list.indexOf("/usr/share/fonts"),
    "a system font outranks one the operator deliberately placed");
});

// ── The renderer must draw with the chain the GUARD measures ─────────────────
//
// "$老昊" shipped as "$□□" on the GIF banner MONTHS after the chain above was
// built, and every test in this file passed while it did. The chain was only
// ever appended to `F`, and bannerTemplate.js — the one function every animated
// overlay goes through, the pump alert included — did not use `F`: it registered
// Sora-800/600/500 under three private families of its own and drew with
// `TplBold, sans-serif`. Latin-only, so outside the chain rather than last in it.
//
// The silence is the part worth naming. warnBoxes()/unrenderable() measure
// against F.r, so the guard was answering "no missing glyphs" about a font stack
// that renderer did not use — the exact failure this file exists to prevent,
// asked of the wrong fonts.
//
// So the assertions below EXECUTE the renderers and read back the font strings
// they actually set. A source scan would have passed on the broken revision too.

test("the fonts are BUNDLED — a deploy is the whole fix, not an SSH session", () => {
  // The first fix shipped as an instruction (`apt-get install fonts-noto-cjk`),
  // and an instruction is one forgotten step from being no fix at all: the box
  // never got the package, so a paid listing published with boxes in it and
  // nothing anywhere errored. The server deploys with `git pull`, so the only
  // kind of fix that cannot be skipped is a tracked file.
  for (const f of kit.BUNDLED) {
    const p = path.join(kit.FONTS_DIR, f);
    assert.ok(fss.existsSync(p), `${f} is not in bot/assets/fonts — the deploy no longer carries the glyphs`);
    assert.ok(fss.statSync(p).size > 20000, `${f} is too small to be a real font file`);
  }
  // …and the chain must actually LOOK for what the repo ships. A bundled file
  // no candidate names is a 10MB file that does nothing.
  for (const f of kit.BUNDLED) assert.ok(SRC.includes(f), `${f} ships but no candidate list names it`);
});

test("the bundled face is what gets used, and every TEXT script renders on a bare box", () => {
  if (!kit.available()) return;
  const cov = kit.coverage();
  // Not "if a font happens to be installed" any more — the repo carries them, so
  // this is now a property of the CHECKOUT and can be asserted anywhere.
  assert.ok(cov.cjk && cov.cjk.startsWith(kit.FONTS_DIR),
    `the CJK face came from ${cov.cjk} — the repo's own assets must win, or a box's font decides our typography`);
  for (const s of ["chinese", "japanese", "korean", "thai", "arabic"]) {
    assert.strictEqual(cov.scripts[s], true, `${s} draws boxes on a checkout that ships a face for it`);
  }
  // Emoji is deliberately NOT bundled (a ~10MB colour-bitmap face for the one
  // script where the package is reliably installed), so it is not asserted here
  // — the boot warning and fonts:check still name it.
});

test("Korean is its own face and sits AFTER the Han one", () => {
  // Noto Sans SC has Han and kana and NO hangul — measured, not assumed. And a
  // Korean face carries hanja of its own, so ahead of the Han face it would draw
  // a Chinese token in Korean glyph shapes.
  assert.match(SRC, /script\("DexCover Korean", "NotoSansKR-Bold\.ttf", "NotoSansKR-Regular\.ttf"\)/);
  if (!kit.available()) return;
  const fams = (kit.coverage().faces || []).map((f) => f.family);
  if (!fams.includes("DexCover Korean") || !fams.includes("DexCover CJK")) return;
  assert.ok(fams.indexOf("DexCover CJK") < fams.indexOf("DexCover Korean"),
    "the Korean face outranks the Han face — Chinese would be drawn in Korean shapes");
});

test("EVERY renderer draws through the shared chain — measured by running them", async () => {
  if (!kit.available()) return;
  const cov = kit.coverage();
  const tail = (cov.faces || []).map((f) => `"${f.family}"`);
  const CV = kit.canvasLib();
  const proto = Object.getPrototypeOf(CV.createCanvas(4, 4).getContext("2d"));
  const desc = Object.getOwnPropertyDescriptor(proto, "font");
  const seen = [];
  Object.defineProperty(proto, "font", {
    ...desc,
    set(v) { seen.push(String(v)); desc.set.call(this, v); },
  });
  try {
    const coin = { symbol: "牛来", name: "牛来 Finance", chain: "BSC", price: 0.002111, mcap: 2111501 };
    // compose() is the ONE choke point for the animated GIF/MP4 overlay — the
    // surface that shipped the boxes — and the still cards are the other entry.
    await require("../src/bannerTemplate").compose("listing", null, coin, { transparent: true });
    await require("../src/bannerRender").renderListingBanner(coin, null);
  } finally {
    Object.defineProperty(proto, "font", desc);
  }
  // A probe that recorded nothing proves nothing.
  assert.ok(seen.length > 3, "no renderer set a font at all — this test is not measuring anything");
  if (!tail.length) return;
  for (const font of new Set(seen)) {
    for (const fam of tail) {
      assert.ok(font.includes(fam),
        `a renderer drew with \`${font}\`, which cannot reach ${fam} — a Chinese name in it draws boxes, and warnBoxes (which measures F.r) would not notice`);
    }
  }
});

test("no renderer registers fonts of its own — one chain, one owner", () => {
  // bannerTemplate had `GlobalFonts.registerFromPath(Sora-800, "TplBold")`, and
  // that private family is how it ended up outside the chain. canvasKit is the
  // only module allowed to register a face.
  for (const f of ["bannerTemplate.js", "bannerRender.js", "gainersBanner.js"]) {
    const src = fss.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
    assert.ok(!/GlobalFonts\.registerFromPath/.test(src), `${f} registers its own fonts again`);
    // Every font it sets must come from F, never a literal family name.
    for (const line of src.match(/\.font = `[^`]*`/g) || []) {
      assert.match(line, /\bF\.[a-z][a-z0-9]*/, `${f} draws with a hardcoded family: ${line}`);
    }
  }
});

// ── "fonts:check was green and the banner was broken" ────────────────────────
//
// The check answered the question it was asked — does this BOX have the glyphs
// — and that question had stopped being the one that mattered. src/bannerSurfaces.js
// asks the other one, per surface, by running it. These tests pin the mechanism,
// because a probe that silently stops measuring is the failure it exists to catch.

test("the surface list covers every renderer that calls the guard", () => {
  // A renderer nobody probes is exactly how the overlay shipped boxes for six
  // days. warnBoxes() is the marker: a module that draws token text calls it.
  const { SURFACES } = require("../src/bannerSurfaces");
  const listed = new Set(SURFACES.map((s) => s.module));
  const dir = path.join(__dirname, "..", "src");
  for (const f of fss.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const src = fss.readFileSync(path.join(dir, f), "utf8");
    // The call, not the word: these files discuss warnBoxes in their comments.
    if (!/\bwarnBoxes\([^)]/.test(src.replace(/^\s*(\/\/|\*).*$/gm, ""))) continue;
    assert.ok(listed.has(f), `${f} draws token text but no surface in bannerSurfaces.js probes it`);
  }
  // …and every listed surface must name a module that exists, or the list drifts
  // into fiction the first time a file is renamed.
  for (const s of SURFACES) {
    assert.ok(fss.existsSync(path.join(dir, s.module)), `${s.key} points at a module that is not there: ${s.module}`);
  }
});

test("the probe MEASURES a surface rather than believing it", async () => {
  if (!kit.available()) return;
  kit.canvasLib();                       // F is "sans-serif" until this has run
  const surfaces = require("../src/bannerSurfaces");
  const draw = (font) => () => {
    const ctx = kit.canvasLib().createCanvas(64, 64).getContext("2d");
    ctx.font = font;
    ctx.fillText("老昊", 4, 40);
  };
  // A renderer inside the chain.
  const good = await surfaces.probeSurface({ key: "t", what: "t", module: "x", run: draw(`800 40px ${kit.F.x}`) });
  // …and one with a private Latin-only family, which is what bannerTemplate was.
  const bad = await surfaces.probeSurface({ key: "t", what: "t", module: "x", run: draw('800 40px "Sora XBold", sans-serif') });
  if (kit.coverage().scripts.chinese) {
    assert.strictEqual(good.scripts.chinese, true, "a renderer drawing through F was reported as broken");
    assert.strictEqual(bad.scripts.chinese, false, "a Latin-only stack was reported as able to draw Chinese — the probe measures nothing");
    assert.deepStrictEqual(surfaces.brokenSurfaces([good]), []);
    assert.strictEqual(surfaces.brokenSurfaces([bad]).length, 1, "a broken surface does not reach the exit code");
  }
});

test("a surface that cannot render is an ERROR, never silent coverage", async () => {
  if (!kit.available()) return;
  const surfaces = require("../src/bannerSurfaces");
  const threw = await surfaces.probeSurface({ key: "t", what: "t", module: "x", run: () => { throw new Error("boom"); } });
  assert.match(threw.error || "", /boom/);
  assert.ok(surfaces.brokenSurfaces([threw]).length === 1, "a renderer that throws passes the check");
  // Drawing nothing is not passing either: an empty recording measured nothing,
  // and reporting that as ✓ is the green-over-broken defect in miniature.
  const silent = await surfaces.probeSurface({ key: "t", what: "t", module: "x", run: () => {} });
  assert.match(silent.error || "", /no text/);
});

test("every REAL surface draws every script the repo ships a face for", async () => {
  if (!kit.available()) return;
  kit.canvasLib();
  const surfaces = require("../src/bannerSurfaces");
  const results = await surfaces.probeAll();
  assert.strictEqual(results.length, surfaces.SURFACES.length);
  const broken = surfaces.brokenSurfaces(results).map((r) => `${r.what}: ${r.error || Object.entries(r.scripts).filter(([, ok]) => !ok).map(([k]) => k).join(", ")}`);
  assert.deepStrictEqual(broken, [], `these surfaces would publish boxes:\n  ${broken.join("\n  ")}`);
});

test("fonts:check follows the SURFACES for its exit code, not the box", () => {
  // The script is prose an operator acts on, and prose that never executes is
  // how a wrong instruction survives a release. The exit-code wiring is what
  // makes a green run mean "the banners are safe", so it is asserted here; the
  // measurement itself is executed by the tests above.
  const src = fss.readFileSync(path.join(__dirname, "..", "scripts", "fonts-check.js"), "utf8");
  assert.match(src, /require\('\.\.\/src\/bannerSurfaces'\)/, "the check no longer measures the renderers at all");
  assert.match(src, /brokenSurfaces/);
  assert.match(src, /process\.exit\(1\);\s*\/\/ green must mean/);
  // And it prints WHICH COMMIT it measured: the most common reason a fix "did
  // not work" here is that it never reached the box.
  assert.match(src, /build'\)\.stamp\(\)/, "a green check on a stale checkout is indistinguishable from a green check on the fix");
});

test("no renderer hardcodes a family — including the one in tradebot", () => {
  const files = [
    path.join(__dirname, "..", "src", "bannerTemplate.js"),
    path.join(__dirname, "..", "src", "bannerRender.js"),
    path.join(__dirname, "..", "src", "gainersBanner.js"),
    // Different package, same chain, same rule: pnlImage draws with K.F.*, and
    // that is the whole reason it needed no fix when the overlay did.
    path.join(__dirname, "..", "..", "tradebot", "pnlImage.js"),
  ];
  for (const f of files) {
    if (!fss.existsSync(f)) continue;
    const src = fss.readFileSync(f, "utf8");
    for (const line of src.match(/\.font = `[^`]*`/g) || []) {
      assert.match(line, /\bK?\.?F\.[a-z][a-z0-9]*/, `${path.basename(f)} draws with a hardcoded family: ${line}`);
    }
  }
});
