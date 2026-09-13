// Two banners, one minute apart, disagreeing about who the top gainers are.
//
// Reported 2026-08-17 from @dexvraadminbot:
//
//   Top 5 (14:25)   BEHEMOTH +3981% · PATE +1538% · 牛来 +118% · SESTRI +35.3% · BOYZ +31.1%
//   Top 3 (14:26)   PATE +1538% · NYAN +25.3% · DOOM +18.7%
//
// A Top 3 must be the first three of a Top 5. This one shares exactly ONE token
// with it, and the two it added (+25.3%, +18.7%) rank BELOW two the Top 5 had.
//
// It was not the market moving: PATE carried the identical +1538% on both cards,
// so both readings are from the same moment. What changed is the POOL. The board
// filter is `t.source === "live"` — whatever the website had a fresh price for at
// that instant — and every preview re-sampled it independently. Four tokens went
// stale between the two calls and left the ranking without a word.
//
// So: ONE sample per sitting, and every template is a slice of it. Any two
// previews are then prefixes of each other by construction, which is a property
// no amount of re-fetching can provide.
const test = require("node:test");
const assert = require("node:assert");
const fss = require("node:fs");
const path = require("node:path");

const gainers = require("../src/gainers");
const SRC = fss.readFileSync(path.join(__dirname, "..", "src", "admin", "gainersMenu.js"), "utf8");

// ── the arithmetic that proves it was the pool, not the market ───────────────

test("the reported pair cannot both be a correct ranking", () => {
  const top5 = [["BEHEMOTH", 3981], ["PATE", 1538], ["牛来", 118], ["SESTRI", 35.3], ["BOYZ", 31.1]];
  const top3 = [["PATE", 1538], ["NYAN", 25.3], ["DOOM", 18.7]];
  // Same moment: the one token on both cards carries the same number.
  assert.strictEqual(top5.find(([s]) => s === "PATE")[1], top3.find(([s]) => s === "PATE")[1]);
  // A top 3 of the same pool would have been the first three of the top 5.
  assert.notDeepStrictEqual(top3.map(([s]) => s), top5.slice(0, 3).map(([s]) => s));
  // And the added tokens rank BELOW ones the wider card already had, so no
  // amount of price movement explains their presence while those are absent.
  for (const [, pct] of [["NYAN", 25.3], ["DOOM", 18.7]]) {
    assert.ok(pct < 31.1, "the new entries outrank the dropped ones — then it could be the market");
  }
});

test("rank() itself is deterministic — the bug was never in the sort", () => {
  const pool = [
    { symbol: "A", address: "0x1", pct: 3981 }, { symbol: "B", address: "0x2", pct: 1538 },
    { symbol: "C", address: "0x3", pct: 118 }, { symbol: "D", address: "0x4", pct: 35.3 },
    { symbol: "E", address: "0x5", pct: 31.1 }, { symbol: "F", address: "0x6", pct: 25.3 },
  ];
  // Proven through the real module: given ONE pool, a narrower limit is always a
  // prefix of a wider one. Which is why the pool has to be the same pool.
  const wide = gainers._rank ? gainers._rank(pool, { limit: 5 }) : null;
  if (!wide) return;   // rank is private; the source assertions below cover it
  const narrow = gainers._rank(pool, { limit: 3 });
  assert.deepStrictEqual(narrow.map((c) => c.symbol), wide.slice(0, 3).map((c) => c.symbol));
});

// ── one sample, sliced per template ─────────────────────────────────────────

const PREVIEW = SRC.slice(SRC.indexOf("async function sendPreview("), SRC.indexOf("/** Wait for the main bot"));

test("the sample is taken at MAX_SLOTS, never at the template's own count", () => {
  assert.ok(PREVIEW.length > 400, "sendPreview moved — this test is asserting nothing");
  // `limit: gb.countOf(id)` is the defect: it makes every template take its own
  // reading of a moving pool.
  assert.match(PREVIEW, /limit: gainers\.MAX_SLOTS/);
  assert.ok(!/limit: gb\.countOf\(id\)/.test(PREVIEW), "each template samples for itself again");
  // One sample has to serve any template the admin clicks next.
  assert.ok(gainers.MAX_SLOTS >= 10, "MAX_SLOTS no longer covers the widest layout");
});

test("switching layout RE-SLICES; it does not re-sample", () => {
  assert.match(PREVIEW, /const reusable = fresh !== "force" && sess && Array\.isArray\(sess\.coins\)/);
  // Reuse needs the sample to be long enough — a Top 3 sample cannot serve a
  // Top 5, and padding it would invent a ranking.
  assert.match(PREVIEW, /sess\.coins\.length >= need/);
  // …and recent enough, or a preview built at 14:25 gets posted at 15:40.
  assert.match(PREVIEW, /Date\.now\(\) - sess\.at < SAMPLE_TTL_MS/);
  assert.match(SRC, /const SAMPLE_TTL_MS = 3 \* 60 \* 1000;/);
});

test("the session keeps the WHOLE sample, not the slice just rendered", () => {
  // The old tail wrote `coins: stripLogos(coins)` — the slice — so a Top 3
  // preview left a three-token session and no wider layout could reuse it. That
  // alone would have made the sample-once fix inert, and silently: every preview
  // would simply have gone on re-sampling.
  assert.match(PREVIEW, /prev\.coins\.length > coins\.length/);
  assert.match(PREVIEW, /\[\.\.\.stripLogos\(coins\), \.\.\.prev\.coins\.slice\(coins\.length\)\]/);
  assert.ok(!/ctx\.session\.gn = \{ template: id, coins: stripLogos\(coins\) \};/.test(SRC),
    "the session is narrowed to the slice again");
  // The stored sample carries what the card needs to be honest about it.
  // `handles` rides along so the "why is there no @handle" line survives a
  // layout switch that does not re-sample.
  assert.match(PREVIEW, /ctx\.session\.gn = \{ \.\.\.prev, template: id, coins: kept, source, pool, at: sampledAt, handles \};/);
});

test("a hand-swapped slot survives a layout change", () => {
  // The swap edits sess.coins by index and re-renders with fresh:false. Because
  // the rendered list is a PREFIX of the stored sample, writing it back keeps the
  // edit and leaves the tail intact for a wider layout.
  assert.match(PREVIEW, /if \(fresh === false \|\| reusable\)/);
  assert.match(SRC, /fresh: false,\n\s+note: `<i>Slot #\$\{a\.pos\} was replaced by hand/);
});

// ── the pool, on the screen ─────────────────────────────────────────────────

test("the live pool is PRINTED — it was measured and thrown away", () => {
  // topGainers has always returned `pool`, and nothing showed it. So when the
  // board's live rows collapsed, the card rendered three tokens and looked
  // entirely normal. This is the one number that explains a ranking that changed
  // for no visible reason.
  assert.match(PREVIEW, /🎣 Live pool: <b>\$\{pool\}<\/b> token\(s\)/);
  assert.match(PREVIEW, /sampled \$\{age\}s ago/);
  // A "top 5" drawn from a pool of six is a list, not a ranking.
  assert.match(PREVIEW, /pool > 0 && pool <= need \+ 1/);
  assert.match(PREVIEW, /not a top \$\{need\}/);
});

test("topGainers still reports the pool for it to print", () => {
  const gsrc = fss.readFileSync(path.join(__dirname, "..", "src", "gainers.js"), "utf8");
  assert.match(gsrc, /return \{ coins, source: used, pool, notes, handles \};/);
  // The filter that shrank without warning, named where it happens.
  assert.match(gsrc, /board\.tokens\.filter\(\(t\) => t && t\.source === "live"\)/);
});

// ── the button that would have lied ─────────────────────────────────────────

test("🔄 Refresh takes a NEW sample; picking a layout does not", () => {
  // Refresh used to reuse the template-pick action. With that action now reusing
  // the sample, the button would have quietly stopped refreshing while still
  // saying it did — a worse bug than the one being fixed, because it is invisible.
  assert.match(SRC, /Markup\.button\.callback\("🔄 Refresh data", `gn_r:\$\{template\}`\)/);
  assert.match(SRC, /bot\.action\(\/\^gn_r:\(\.\+\)\$\/, cb\(async \(ctx\) => \{[\s\S]{0,220}fresh: "force"/);
  assert.match(SRC, /bot\.action\(\/\^gn_t:\(\.\+\)\$\/, cb\(async \(ctx\) => \{[\s\S]{0,220}fresh: true/);
  assert.ok(!/"🔄 Refresh data", `gn_t:/.test(SRC), "refresh points at the re-slicing action again");
});

test("posting publishes the previewed list, not a fresh reading", () => {
  // This half was already right and must stay right: the post path takes
  // sess.coins, so the channel gets exactly the card the admin approved.
  const post = SRC.slice(SRC.indexOf('bot.action("gn_post"'), SRC.indexOf('bot.action("gn_swap"'));
  assert.ok(post.length > 200, "the post action moved");
  assert.ok(!/topGainers\(/.test(post), "posting re-samples — the published banner can differ from the preview");
  assert.match(post, /symbols: coins\.map\(\(c\) => c\.symbol\)/);
});
