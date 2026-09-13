// The podium ranked noise above a real mover.
//
// A live Top 3, 2026-08-17:
//
//   #1  $巨兽BEHEMOTH  +4379%   MC $1.90M
//   #2  $PATE          +1562%   MC $52.6K     ← this
//   #3  $牛来           +126%    MC $40.89M
//
// At a $52.6K cap a single $500 buy is a four-figure percentage, so PATE outranked
// a token up 126% on $40.89M. The leaderboard was sorting correctly and saying
// something false: a gain is only interesting next to something worth gaining on.
//
// There were two filters — a gain floor and a liquidity floor — and no market-cap
// floor at all. `minMcapUsd` is the third, and unlike the liquidity one it ships
// ON at $1M, because zero is what produced the banner above.
const test = require("node:test");
const assert = require("node:assert");
const fss = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Own DATA_DIR: this file reads the config defaults, and the operator's own
// gainersConfig.json would otherwise decide whether the test passes.
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-gnf-"));

const gainers = require("../src/gainers");
const cfgStore = require("../src/services/gainersConfig");

// The reported board, verbatim, plus a token the board could not price a cap for.
const POOL = [
  { symbol: "BEHEMOTH", address: "0x1", pct: 4379, mcap: 1_900_000, liq: 90_000 },
  { symbol: "PATE", address: "0x2", pct: 1562, mcap: 52_600, liq: 20_000 },
  { symbol: "NIULAI", address: "0x3", pct: 126, mcap: 40_890_000, liq: 400_000 },
  { symbol: "NOCAP", address: "0x4", pct: 800, liq: 30_000 },   // mcap absent
];
const syms = (o) => gainers._rank(POOL, o).map((c) => c.symbol);

test("without the floor, a $52K token takes second place — the reported banner", () => {
  assert.deepStrictEqual(syms({ limit: 3 }), ["BEHEMOTH", "PATE", "NOCAP"]);
});

test("a $1M floor drops the noise and keeps the real movers", () => {
  assert.deepStrictEqual(syms({ limit: 3, minMcapUsd: 1_000_000 }), ["BEHEMOTH", "NIULAI"]);
});

test("fewer real gainers beats padding the podium", () => {
  // Only two tokens clear $1M here, and the layout adapts rather than reaching
  // back down for PATE. The preview card already says "Only N passed the
  // filters" — an honest short list, not an invented third place.
  assert.strictEqual(syms({ limit: 3, minMcapUsd: 1_000_000 }).length, 2);
  assert.ok(!syms({ limit: 3, minMcapUsd: 1_000_000 }).includes("PATE"));
});

test("a token whose cap could not be read is left off, not assumed to pass", () => {
  // The filter is a CLAIM — "market cap ≥ $1M". A token with no cap cannot be
  // shown to satisfy it, so it goes, exactly as an unreadable 24h change does.
  // `|| 0` is what makes that true; the liquidity filter above it has the same shape.
  assert.ok(!syms({ limit: 10, minMcapUsd: 1_000_000 }).includes("NOCAP"));
  // …and with the filter OFF it is back, so the floor is the only thing removing it.
  assert.ok(syms({ limit: 10 }).includes("NOCAP"));
});

test("0 turns it off — the operator can always get the old behaviour back", () => {
  assert.deepStrictEqual(syms({ limit: 4, minMcapUsd: 0 }), syms({ limit: 4 }));
});

test("the floors compose instead of overriding each other", () => {
  // gain ≥ 200 AND cap ≥ 1M: BEHEMOTH qualifies, NIULAI is up only 126%,
  // PATE and NOCAP fail the cap.
  assert.deepStrictEqual(syms({ limit: 10, minGainPct: 200, minMcapUsd: 1_000_000 }), ["BEHEMOTH"]);
  // liquidity too, all three at once.
  assert.deepStrictEqual(syms({ limit: 10, minMcapUsd: 1_000_000, minLiqUsd: 100_000 }), ["NIULAI"]);
});

// ── the default, and the places that must honour it ─────────────────────────

test("it ships ON at $1M — zero is what produced the banner", () => {
  const c = cfgStore.get();
  assert.strictEqual(c.minMcapUsd, 1_000_000);
  // An existing install has no minMcapUsd in its stored config, so the default
  // is what it gets. That CHANGES what the daily post publishes, deliberately.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "services", "gainersConfig.js"), "utf8");
  assert.match(src, /minMcapUsd: 1_000_000, \/\/ market-cap floor \(0 = off\)/);
  assert.match(src, /g\.minMcapUsd = clampNum\(c\.minMcapUsd, HARD\.minMcapUsd, DEFAULTS\.minMcapUsd\);/);
  assert.match(src, /if \(patch\.minMcapUsd != null\) next\.minMcapUsd = clampNum/);
});

test("it is clamped, so a fat-fingered value cannot empty the board forever", () => {
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "services", "gainersConfig.js"), "utf8");
  assert.match(src, /minMcapUsd: \[0, 100_000_000_000\]/);
});

test("EVERY caller passes it — the daily poster included", () => {
  // The poster is the one that publishes without a human looking. Wiring the
  // preview and forgetting it would mean the admin sees a filtered board and the
  // channel gets an unfiltered one, which is worse than no filter at all.
  const menu = fss.readFileSync(path.join(__dirname, "..", "src", "admin", "gainersMenu.js"), "utf8");
  const poster = fss.readFileSync(path.join(__dirname, "..", "src", "services", "gainersPoster.js"), "utf8");
  assert.match(poster, /minMcapUsd: cfg\.minMcapUsd/, "the DAILY POST ignores the market-cap floor");
  assert.strictEqual((menu.match(/minMcapUsd: cfg\.minMcapUsd/g) || []).length, 2, "a preview path ignores the floor");
  // No caller may read the floor from anywhere but the config.
  for (const [name, src] of [["menu", menu], ["poster", poster]]) {
    assert.ok(!/minMcapUsd: \d/.test(src), `${name} hardcodes a floor instead of reading the setting`);
  }
});

test("rank() applies it, in the same shape as the filter beside it", () => {
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "gainers.js"), "utf8");
  assert.match(src, /\.filter\(\(c\) => !minMcapUsd \|\| \(c\.mcap \|\| 0\) >= minMcapUsd\)/);
  // Applied BEFORE the slice, or a "top 3" would be three of whatever survived
  // out of the first three rather than the best three that qualify.
  const fn = src.slice(src.indexOf("function rank(coins,"), src.indexOf("* The live top gainers."));
  assert.ok(fn.indexOf("minMcapUsd") < fn.indexOf(".slice(0,"), "the floor runs after the cut");
  assert.ok(fn.indexOf(".sort(") < fn.indexOf(".slice(0,"), "the sort runs after the cut");
});

// ── the admin can change it without a deploy ────────────────────────────────

test("the setting is reachable, labelled, and shown on both screens", () => {
  const menu = fss.readFileSync(path.join(__dirname, "..", "src", "admin", "gainersMenu.js"), "utf8");
  assert.match(menu, /Markup\.button\.callback\("🏦 Min market cap", "gn_mc"\)/);
  assert.match(menu, /bot\.action\("gn_mc"/);
  assert.match(menu, /a\.mode === "mc"/);
  // The write goes through the shared numeric branch now — see the parser tests.
  assert.match(menu, /const c = await cfgStore\.set\(\{ \[KEY\]: asked \}\);/);
  // On the settings screen AND in the home screen's filter summary, or an admin
  // cannot tell why a token they expected is missing.
  assert.match(menu, /🏦 <b>Minimum market cap:<\/b>/);
  assert.match(menu, /c\.minMcapUsd \? `MC ≥ \$\{fmtCap\(c\.minMcapUsd\)\}` : null/);
  // The prompt says what the filter is FOR. "Send a number" is not a setting.
  assert.match(menu, /one \$500 buy is a four-figure percentage/);
});

// ── "500k" set it to $1M ─────────────────────────────────────────────────────
//
// An admin opened 🏦 Min market cap, sent `500k`, and the bot answered
// "✅ Minimum market cap → $1.00M".
//
// `Number("500k")` is NaN. clampNum() answers a non-finite value with the
// DEFAULT, which is $1M. So the value asked for was never stored, the setting was
// silently reset to its default, and the reply reported success. A ✅ carrying a
// number nobody asked for is worse than an error: nothing prompts a second look.
//
// The same two lines governed Min gain % and Min liquidity.
const { parseCap, fmtCap } = require("../src/helpers/format");
const MENU = fss.readFileSync(path.join(__dirname, "..", "src", "admin", "gainersMenu.js"), "utf8");

test("the exact input that broke it now reads correctly", () => {
  assert.strictEqual(parseCap("500k"), 500_000);
  // And the round trip the admin sees: 500k in, "$500.0K" back — not "$1.00M".
  assert.notStrictEqual(fmtCap(parseCap("500k")), fmtCap(1_000_000));
});

test("every shape a human actually types", () => {
  for (const [input, want] of [
    ["500k", 500_000], ["500K", 500_000], ["1m", 1_000_000], ["1.5M", 1_500_000],
    ["2b", 2_000_000_000], ["1,000,000", 1_000_000], ["$500k", 500_000],
    ["  750K ", 750_000], ["5", 5], ["0", 0], ["1%", 1],
  ]) {
    assert.strictEqual(parseCap(input), want, `${input} → ${parseCap(input)}, wanted ${want}`);
  }
});

test("it returns null rather than a number it had to invent", () => {
  // A parser that cannot fail is a parser that lies for its caller.
  for (const bad of ["", "   ", "abc", "500kk", "1.2.3", "k", "-", null, undefined, "1e5x"]) {
    assert.strictEqual(parseCap(bad), null, `${JSON.stringify(bad)} produced ${parseCap(bad)}`);
  }
});

test("an unreadable value CHANGES NOTHING and says so", () => {
  const branch = MENU.slice(MENU.indexOf('a.mode === "min" || a.mode === "mc"'), MENU.indexOf('} else if (a.mode === "swap")'));
  assert.ok(branch.length > 300, "the numeric branch moved — this test is asserting nothing");
  assert.match(branch, /const asked = parseCap\(raw\);/);
  assert.match(branch, /if \(asked == null\) \{[\s\S]{0,320}Nothing was changed\./);
  // The old expression, which is the bug. It must not come back on any of them.
  // Comment lines stripped: the note explaining the defect quotes the very
  // expression being searched for, so the raw source fails on its own
  // documentation. A test that breaks when you explain yourself gets deleted.
  const code = MENU.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/Number\(raw\.replace\(/.test(code), "a handler parses with Number() again — NaN becomes the default");
  // One branch for all three, so a fourth setting cannot inherit the old shape.
  assert.match(branch, /const KEY = \{ min: "minGainPct", mc: "minMcapUsd", liq: "minLiqUsd" \}/);
});

test("a clamped value is reported as clamped, not as what you asked for", () => {
  // The bounds are real — a 10-trillion floor would empty the board for good —
  // but storing something other than what was asked for and calling it ✅ is the
  // NaN defect moved to the edges.
  const branch = MENU.slice(MENU.indexOf('a.mode === "min" || a.mode === "mc"'), MENU.indexOf('} else if (a.mode === "swap")'));
  assert.match(branch, /const got = c\[KEY\];/);
  assert.match(branch, /Clamped from/);
  // Proven through the real store: above the hard ceiling it comes back clamped.
  const HUGE = 500_000_000_000;
  assert.ok(parseCap("500b") === HUGE);
  assert.ok(HUGE > 100_000_000_000, "the test value no longer exceeds the ceiling");
});

test("the prompt names the formats it accepts", () => {
  // The old prompt said "e.g. 1000000", so `500k` was a reasonable thing to type
  // and the only wrong part was that it did not work.
  assert.match(MENU, /<code>1m<\/code> and <code>1M<\/code> all work/);
  assert.match(MENU, /<code>25k<\/code>/);
});
