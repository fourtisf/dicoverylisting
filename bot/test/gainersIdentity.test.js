// How a token is IDENTIFIED on the gainers board: the size of its name, and the
// X handle it is credited with.
//
// Two things reported against a live Top 3, 2026-08-17, both by comparison with
// FourtisRaid's board:
//
//   1. "font projectnya nomor1 terlalu gede tidak sesuai dengan project lain"
//      — $巨兽BEHEMOTH was drawn at 44px against 31px for the two beside it.
//   2. "teks copy writing harusnya ada x nya … ketika d klik itu ke link x"
//      — the caption read "#巨兽BEHEMOTH +4336%" with nothing to click, on a
//      token whose socials the bot already had on file.
const test = require("node:test");
const assert = require("node:assert");
const fss = require("node:fs");
const path = require("node:path");
const os = require("node:os");

process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-gid-"));

const gainers = require("../src/gainers");
const { xHandle, enrichHandles } = gainers._internals;
const api = require("../src/api/dexvra");
const BANNER = fss.readFileSync(path.join(__dirname, "..", "src", "gainersBanner.js"), "utf8");
const GSRC = fss.readFileSync(path.join(__dirname, "..", "src", "gainers.js"), "utf8");

// ── the winner's name is not a ranking signal ───────────────────────────────

test("all three podium tickers are ONE size; only the figure scales", () => {
  // The comment defending the scale-up says "≥1.4× on the FIGURE", and the code
  // applied it to the ticker as well. All three columns are the same width —
  // colW is a single value — so a bigger name buys no legibility and costs the
  // card set its typographic consistency.
  assert.match(BANNER, /const tickSize = 31;/);
  assert.ok(!/const tickSize = winner \?/.test(BANNER), "the winner's name is scaled again");
  // The figure MUST still outrank the sides, or the podium is carried only by
  // elevation — that part of the original reasoning stands.
  assert.match(BANNER, /const pctSize = winner \? 68 : 44;/);
  assert.ok(68 / 44 >= 1.4, "the winner's figure no longer outranks the sides");
});

test("rank is still carried — six ways, none of them the name", () => {
  const fn = BANNER.slice(BANNER.indexOf("function layoutPodium("), BANNER.indexOf("podium: layoutPodium"));
  for (const [what, re] of [
    // The 2026-08-21 rebuild put the cards on stepped PLINTHS: elevation is now
    // card height AND standing height, and the plinth adds a seventh signal.
    ["elevation", /const h = \(winner \? BAND_H : BAND_H - 40\) \* S - 70 \* S/],
    ["the plinth", /const plinthH = \(rank === 1 \? 64 : rank === 2 \? 46 : 32\) \* S/],
    ["the top-gainer chip", /"#1 · Top gainer"/],
    ["the metal ring", /metalRing\(ctx, cx, lcy, d, rank, S\)/],
    ["the medal", /medal\(ctx, cx \+ d \* 0\.42/],
    ["a larger avatar", /const d = \(winner \? 108 : 96\) \* S;/],
    ["the figure", /pctSize = winner \?/],
  ]) {
    assert.match(fn, re, `${what} is gone — the podium now leans on fewer signals`);
  }
});

test("the podium still renders, and the long name still fits", async () => {
  const gb = require("../src/gainersBanner");
  if (!gb.available()) return;
  const coins = [
    { symbol: "巨兽BEHEMOTH", name: "巨兽 Behemoth", pct: 4336, pctLabel: "▲ 4336%", chain: "bsc", mcap: 1_930_000, address: "0x1" },
    { symbol: "牛来", name: "牛来", pct: 109, pctLabel: "▲ 109%", chain: "bsc", mcap: 39_100_000, address: "0x2" },
    { symbol: "WALL", name: "TheCardWall", pct: 26.2, pctLabel: "▲ 26.2%", chain: "robinhood", mcap: 3_190_000, address: "0x3" },
  ];
  const buf = await gb.render({ template: "podium", coins, dateText: "Monday · August 17 · 2026" });
  assert.ok(buf && buf.length > 10_000, "the podium stopped rendering");
  // fitText only shrinks for WIDTH, and the longest of these is the winner's —
  // so a uniform size must still leave it inside its column.
  assert.match(BANNER, /fitText\(ctx, `\$\$\{c\.symbol\}`, colW - 56 \* S/);
});

// ── the X handle ────────────────────────────────────────────────────────────

test("a BARE handle is a handle — the listing form takes free text", () => {
  // A project that typed "@velvet_capital" rather than the full URL had its X
  // dropped, and reached the leaderboard with no attribution at all.
  for (const [input, want] of [
    ["https://x.com/velvet_capital", "velvet_capital"],
    ["https://twitter.com/foo", "foo"],
    ["@velvet_capital", "velvet_capital"],
    ["velvet_capital", "velvet_capital"],
    ["@a_b_1", "a_b_1"],
  ]) {
    assert.strictEqual(xHandle(input), want, `${input} → ${xHandle(input)}`);
  }
});

test("and the words a form collects instead of a blank are not handles", () => {
  // Widening the parser must not turn "TBA" into an @mention on a public post.
  for (const bad of ["", "  ", "-", "none", "None", "n/a", "TBA", "soon", "null",
    "x.com/i/status/123", "https://x.com/home", "https://x.com/intent/tweet", "way too long a handle to be real 12345"]) {
    assert.strictEqual(xHandle(bad), null, `${JSON.stringify(bad)} → ${xHandle(bad)}`);
  }
});

test("the board's missing handle is filled from the listing store", async () => {
  // boardCoin reads t.links.twitter (the website's row); listingCoins reads
  // row.twitter (what the project typed). They are not equivalent, and the board
  // is preferred — so a token the site has no link for lost its credit.
  const real = api.getListings;
  api.getListings = async () => [
    { chain: "bsc", address: "0xAAA", twitter: "https://x.com/behemoth_bsc" },
    { chain: "bsc", address: "0xBBB", twitter: "@niulai" },
    { chain: "robinhood", address: "0xCCC", twitter: "none" },
  ];
  try {
    const coins = [
      { chain: "bsc", address: "0xaaa", x: null, links: {} },
      { chain: "bsc", address: "0xBBB", x: null, links: {} },
      { chain: "robinhood", address: "0xccc", x: null, links: {} },
      { chain: "solana", address: "So1", x: "pateonsol_", links: { twitter: "https://x.com/pateonsol_" } },
    ];
    await enrichHandles(coins);
    // Case-insensitive on the address, both directions.
    assert.strictEqual(coins[0].x, "behemoth_bsc");
    assert.strictEqual(coins[1].x, "niulai", "a bare handle in the store was not accepted");
    assert.strictEqual(coins[2].x, null, '"none" became an @mention');
    // NEVER overrides what the board asserted.
    assert.strictEqual(coins[3].x, "pateonsol_");
    // The link is carried too, so anything reading links.twitter agrees with it.
    assert.strictEqual(coins[0].links.twitter, "https://x.com/behemoth_bsc");
  } finally {
    api.getListings = real;
  }
});

test("it costs nothing when there is nothing to fill", async () => {
  let calls = 0;
  const real = api.getListings;
  api.getListings = async () => { calls++; return []; };
  try {
    await enrichHandles([{ chain: "bsc", address: "0x1", x: "already" }]);
    assert.strictEqual(calls, 0, "the listings API is called even when every coin has a handle");
  } finally {
    api.getListings = real;
  }
});

test("a failing lookup loses the handle, never the banner", async () => {
  const real = api.getListings;
  api.getListings = async () => { throw new Error("internal API down"); };
  try {
    const coins = [{ chain: "bsc", address: "0x1", x: null }];
    await assert.doesNotReject(enrichHandles(coins));
    assert.strictEqual(coins[0].x, null);
  } finally {
    api.getListings = real;
  }
});

test("it runs on the RANKED list, not the whole pool", () => {
  // Ten lookups at most, and only after the filters have cut the board down.
  const fn = GSRC.slice(GSRC.indexOf("async function topGainers("), GSRC.indexOf("// ── slot override"));
  const iEnrich = fn.indexOf("await enrichHandles(coins)");
  assert.ok(iEnrich > -1, "topGainers never enriches");
  assert.ok(iEnrich > fn.indexOf("coins = rank("), "the enrich runs before the ranking cuts the pool down");
  assert.ok(iEnrich < fn.indexOf("await loadLogos(coins)"), "logos load before the handles are known");
});

// ── the caption's link ──────────────────────────────────────────────────────

test("the handle is a LINK to x.com, not a bare @mention", () => {
  // A bare "@handle" in a Telegram message is a TELEGRAM username: tapping it
  // opens Telegram's user search, not X. It has to be an explicit link.
  assert.match(GSRC, /\[@\$\{premium\.sanitizeVar\(c\.x\)\}\]\(https:\/\/x\.com\/\$\{premium\.sanitizeVar\(c\.x\)\}\)/);
  // …and the sanitiser must not break the URL. Handles are [A-Za-z0-9_], and an
  // underscore is a markdown italic marker — "@pateonsol_" would 404 if it were
  // escaped into the href.
  const premium = require("../src/premium");
  assert.strictEqual(premium.sanitizeVar("pateonsol_"), "pateonsol_");
  assert.strictEqual(premium.sanitizeVar("a_b_1"), "a_b_1");
});

test("the tweet text uses a plain mention — X has no link labels", () => {
  // listText is what gets published to X, where "[@x](url)" would print its
  // brackets verbatim.
  const fn = GSRC.slice(GSRC.indexOf("function listText("), GSRC.indexOf("/** One-line summary"));
  assert.match(fn, /if \(c\.x\) line \+= ` @\$\{c\.x\}`;/);
  assert.ok(!/https:\/\/x\.com/.test(fn), "the tweet embeds a link label X cannot render");
});

// ── "masih sama aja" — the report that turns a shrug into an answer ──────────
//
// The caption came back with no @handles after the fallback shipped, and the only
// thing anyone could say was "it did not work". Three tokens with no X on file, a
// listing lookup that failed, and a chain key that did not match all look
// IDENTICAL from Telegram — and the first cut swallowed the difference in a
// log.debug nobody prints.

test("enrichHandles reports which of the three it was", async () => {
  const real = api.getListings;
  api.getListings = async () => [
    { chain: "bsc", address: "0xAAA", twitter: "https://x.com/filled_ok" },
    { chain: "bsc", address: "0xBBB", twitter: "" },            // listed, no X
  ];
  try {
    const coins = [
      { symbol: "FILLED", chain: "bsc", address: "0xaaa", x: null, links: {} },
      { symbol: "NOX", chain: "bsc", address: "0xbbb", x: null, links: {} },
      { symbol: "STRANGER", chain: "solana", address: "So1", x: null, links: {} },
      { symbol: "HAS", chain: "bsc", address: "0xDDD", x: "already", links: {} },
    ];
    const r = await enrichHandles(coins);
    assert.deepStrictEqual(r.filled, ["FILLED"]);
    assert.deepStrictEqual(r.noHandle, ["NOX"], "a listed token with a blank X is not distinguished");
    assert.deepStrictEqual(r.notListed, ["STRANGER"], "a board-only token is not distinguished");
    assert.strictEqual(r.failed, null);
    // A coin that already had one is not reported at all — it is not a gap.
    for (const k of ["filled", "noHandle", "notListed"]) assert.ok(!r[k].includes("HAS"));
  } finally { api.getListings = real; }
});

test("a failed lookup is named as a failure, not as an empty result", async () => {
  const real = api.getListings;
  api.getListings = async () => { throw new Error("internal API 502"); };
  try {
    const r = await enrichHandles([{ symbol: "A", chain: "bsc", address: "0x1", x: null }]);
    assert.match(r.failed, /502/);
    // …and NOT counted as "no X on file", which would blame the project for an
    // outage on our side.
    assert.deepStrictEqual(r.noHandle, []);
    assert.deepStrictEqual(r.notListed, []);
  } finally { api.getListings = real; }
});

test("the outcome is logged at INFO — a level nobody prints is no line at all", () => {
  assert.match(GSRC, /log\.info\(`\[gainers\] handles · \$\{bits\.join\(" · "\)\}`\)/);
  assert.ok(!/log\.debug\(`\[gainers\] handle enrich/.test(GSRC), "it is back to a level that never shows");
});

test("the preview card explains a missing handle, for the shown tokens only", () => {
  const MENU = fss.readFileSync(path.join(__dirname, "..", "src", "admin", "gainersMenu.js"), "utf8");
  assert.match(MENU, /No X on file:/);
  assert.match(MENU, /Not in the listing store:/);
  assert.match(MENU, /Listing lookup failed/);
  // The sample is wider than the layout, so naming a token that is not on this
  // card would send the admin looking for something that is not there.
  assert.match(MENU, /const shownSyms = new Set\(coins\.map\(\(c\) => c\.symbol\)\);/);
  assert.match(MENU, /hOn = \(list\) => \(list \|\| \[\]\)\.filter\(\(sym\) => shownSyms\.has\(sym\)\)/);
  // It survives a layout switch that does not re-sample.
  assert.match(MENU, /let handles = sess && sess\.handles;/);
});

// ── the Top 2 Duel ──────────────────────────────────────────────────────────

test("duel2 fills the gap in the layout ladder", () => {
  const gb = require("../src/gainersBanner");
  // The menu offered 1, 3, 4, 5, 8, 10 — the one head-to-head shape a two-token
  // day needs was the one missing.
  assert.ok(gb.isTemplate("duel2"));
  assert.strictEqual(gb.countOf("duel2"), 2);
  assert.deepStrictEqual(gb.TEMPLATE_IDS.map((id) => gb.countOf(id)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10],
    "the template ladder is out of order — the menu is built from this list");
});

test("the duel keeps the podium's identity rule from day one", () => {
  // One ticker size; only the FIGURE scales (≥1.4×), and rank is carried by the
  // ring, the medal, the chip and the card height — not by the name.
  const fn = BANNER.slice(BANNER.indexOf("function layoutDuel("), BANNER.indexOf("function layoutHero("));
  assert.ok(fn.length > 400, "layoutDuel moved — this test is asserting nothing");
  assert.match(fn, /ctx\.font = `700 \$\{34 \* S\}px/, "the duel ticker scales by rank");
  assert.ok(!/winner \? \d+ : \d+\) \* S\}px \$\{F\.d7\}/.test(fn), "the winner's name is bigger again");
  assert.match(fn, /\(winner \? 84 : 56\) \* S/, "the figure no longer scales");
  assert.ok(84 / 56 >= 1.4);
  for (const re of [/metalRing\(/, /medal\(/, /"#1 · Top gainer"/, /"#2 · Runner-up"/]) assert.match(fn, re);
});

test("a one-token day still renders as a duel of one, never a crash", async () => {
  const gb = require("../src/gainersBanner");
  if (!gb.available()) return;
  const one = await gb.render({ template: "duel2", coins: [
    { symbol: "SOLO", name: "Only Mover", pct: 42, pctLabel: "▲ 42%", chain: "bsc", mcap: 2_000_000, address: "0x1" },
  ], dateText: "" });
  assert.ok(one && one.length > 10_000, "one qualifying token broke the duel");
  const none = await gb.render({ template: "duel2", coins: [], dateText: "" }).catch(() => null);
  assert.ok(none === null || Buffer.isBuffer(none), "an empty board threw instead of degrading");
});

// ── the Top 10 Spotlight ────────────────────────────────────────────────────

test("spot10 joins the ladder without breaking it", () => {
  const gb = require("../src/gainersBanner");
  assert.ok(gb.isTemplate("spot10"));
  assert.strictEqual(gb.countOf("spot10"), 10);
  // Non-decreasing, so the admin menu still reads as a ladder — the count array
  // is pinned in the duel2 test above.
  assert.strictEqual(gb.TEMPLATE_IDS[gb.TEMPLATE_IDS.length - 1], "spot10");
});

test("the spotlight's ROWS keep one ticker size — the identity rule, scoped as the podium scoped it", () => {
  const fn = BANNER.slice(BANNER.indexOf("function layoutSpotlight("), BANNER.indexOf("/** cards4"));
  assert.ok(fn.length > 400, "layoutSpotlight moved — this test is asserting nothing");
  // Every row ticker goes through ONE fitText with one size; only the champion
  // card (a different component class, four rows tall) is bigger.
  const rowTickers = [...fn.matchAll(/fitText\(ctx, `\$\$\{c\.symbol\}`[^)]*size: ([\d.]+) \* S/g)].map((m) => m[1]);
  assert.strictEqual(rowTickers.length, 1, "one row-ticker call site — a second is a second size waiting to drift");
  assert.strictEqual(rowTickers[0], "18.5");
});

test("a thin day renders on the layout designed for that count", () => {
  const fn = BANNER.slice(BANNER.indexOf("function layoutSpotlight("), BANNER.indexOf("/** cards4"));
  // A champion card beside a board carrying one floating row reads as a
  // rendering fault, not a short day — and the ladder already owns the right
  // shape for 1, 2 and 3.
  assert.match(fn, /if \(n === 1\) return layoutHero\(ctx, S, spec, coins\);/);
  assert.match(fn, /if \(n === 2\) return layoutDuel\(ctx, S, spec, coins\);/);
  assert.match(fn, /if \(n === 3\) return layoutPodium\(ctx, S, spec, coins\);/);
  // …and from four up, the pack's rows are capped rather than stretched.
  assert.match(fn, /Math\.min\(height \/ rest\.length, 128 \* S\)/);
});

test("spot10 renders every count from 1 to 10 without failing", async () => {
  const gb = require("../src/gainersBanner");
  if (!gb.available()) return; // no canvas on this box — the render tests skip the same way
  const coin = (i) => ({ chain: "solana", symbol: "TOK" + i, name: "Token " + i, pct: 100 - i * 7, price: 0.01, mcap: 1_000_000 * (11 - i) });
  for (let n = 1; n <= 10; n++) {
    const coins = Array.from({ length: n }, (_, i) => coin(i + 1));
    const buf = await gb.render({ template: "spot10", coins, dateText: "" });
    assert.ok(buf && buf.length > 10_000, `n=${n} produced no banner`);
  }
});


// ── every count 1–10 has a banner, and every banner has its own backdrop ────

test("the ladder is complete: one template for every count from 1 to 10", () => {
  const gb = require("../src/gainersBanner");
  const counts = new Set(gb.TEMPLATE_IDS.map((id) => gb.countOf(id)));
  for (let n = 1; n <= 10; n++) assert.ok(counts.has(n), `no template for Top ${n}`);
});

test("every template carries its OWN backdrop mood — 'backgroundnya juga beda-beda'", () => {
  const gb = require("../src/gainersBanner");
  // The promise is that a channel posting a different layout each day does not
  // read as the same poster recoloured. A mood shared by two templates breaks
  // it silently, which is why uniqueness is pinned rather than trusted.
  const moods = gb.TEMPLATE_IDS.map((id) => gb.specOf(id).mood);
  assert.ok(moods.every(Boolean), "a template with no mood falls back to the shared default");
  assert.strictEqual(new Set(moods).size, moods.length, "two templates share a mood: " + moods.join(", "));
  // …and every named mood exists — a typo would ALSO fall back to the default,
  // with nothing anywhere saying so.
  assert.match(BANNER, /const MOODS = \{/);
  for (const m of moods) assert.ok(BANNER.includes(`\n  ${m}: {`), `mood "${m}" is not defined in MOODS`);
  // …and every mood carries its own PATTERN — bloom positions alone were
  // re-read as "the same background", which is the report this exists to end.
  const patterns = [...BANNER.matchAll(/pattern: "([a-z][A-Za-z]*)"/g)].map((m) => m[1]);
  assert.strictEqual(patterns.length, moods.length, "a mood with no pattern falls back to a bare field");
  assert.strictEqual(new Set(patterns).size, patterns.length, "two moods share a pattern: " + patterns.join(", "));
  for (const pt of patterns) assert.ok(new RegExp(`\\n  ${pt}\\(ctx, W, H, S\\)`).test(BANNER), `pattern "${pt}" has no painter in PATTERNS`);
});

test("the three new layouts delegate thin days like the spotlight does", () => {
  for (const fname of ["layoutTiers", "layoutCrown", "layoutMosaic"]) {
    const fn = BANNER.slice(BANNER.indexOf(`function ${fname}(`), BANNER.indexOf(`function ${fname}(`) + 2400);
    assert.match(fn, /if \(n === 1\) return layoutHero/, fname);
    assert.match(fn, /if \(n === 2\) return layoutDuel/, fname);
    assert.match(fn, /if \(n === 3\) return layoutPodium/, fname);
  }
});

test("tier6, crown7 and mosaic9 render every count from 1 to their size", async () => {
  const gb = require("../src/gainersBanner");
  if (!gb.available()) return;
  const coin = (i) => ({ chain: "solana", symbol: "TOK" + i, name: "Token " + i, pct: 90 - i * 6, price: 0.01, mcap: 1_000_000 * (12 - i) });
  for (const id of ["tier6", "crown7", "mosaic9"]) {
    for (let n = 1; n <= gb.countOf(id); n++) {
      const buf = await gb.render({ template: id, coins: Array.from({ length: n }, (_, i) => coin(i + 1)), dateText: "" });
      assert.ok(buf && buf.length > 10_000, `${id} n=${n} produced no banner`);
    }
  }
});

test("the shared ranked panel keeps ONE row-ticker size — for all three mixed layouts at once", () => {
  const fn = BANNER.slice(BANNER.indexOf("function rankedPanel("), BANNER.indexOf("function layoutTiers("));
  const sizes = [...fn.matchAll(/fitText\(ctx, `\$\$\{c\.symbol\}`[^)]*size: ([\d.]+) \* S/g)].map((m) => m[1]);
  assert.deepStrictEqual(sizes, ["18.5"], "one call site, one size — tier6 and crown7 both draw through it");
});

test("the footer tagline is EXACTLY the brand label's size — the operator's stated rule", () => {
  // "aturan find the next moonshot ukuran fontnya sama kaya dexvra yang di
  // samping" (2026-08-21). The tagline drifted once already — 16px mixed-case
  // display beside a 12px microlabel — so the rule is pinned, not trusted.
  const fn = BANNER.slice(BANNER.indexOf("function footer("), BANNER.indexOf("// ── board panels"));
  const sizes = [...fn.matchAll(/microLabel\(ctx[^)]*?"(?:Dexvra · Discovery|Find the next Moonshot)"[^)]*?size: ([\d.]+) \* S/g)].map((m) => m[1]);
  assert.strictEqual(sizes.length, 2, "both footer labels draw through microLabel — one moved off it");
  assert.strictEqual(sizes[0], sizes[1], `the tagline is ${sizes[1]}px against the brand's ${sizes[0]}px`);
  // …and on one baseline: two different y-expressions is the old defect back.
  const ys = [...fn.matchAll(/microLabel\(ctx, [^,]+, (midY [^,]+),/g)].map((m) => m[1]);
  assert.strictEqual(new Set(ys).size, 1, "the two labels sit on different baselines: " + ys.join(" vs "));
});
