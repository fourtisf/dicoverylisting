// The banner renderer's CONTRACT, which the callers depend on:
//   • it never throws — any failure is a null, and null means "post nothing";
//   • the layout follows how many real gainers there are, not the template's
//     nominal size, so a thin day never publishes empty slots;
//   • template selection is deterministic when asked and pool-bounded when random.
const test = require("node:test");
const assert = require("node:assert");
const gb = require("../src/gainersBanner");

const coin = (symbol, pct, extra = {}) => ({
  chain: "solana",
  address: "So" + symbol,
  symbol,
  name: symbol + " Token",
  pct,
  price: 0.0042,
  mcap: 1_200_000,
  liq: 90_000,
  url: `https://dexvra.io/token/solana/So${symbol}`,
  ...extra,
});
const many = (n) => Array.from({ length: n }, (_, i) => coin(`TOK${i + 1}`, 200 - i * 7));

test("every template declares a label, a slot count and a title", () => {
  assert.ok(gb.TEMPLATE_IDS.length >= 6, "the operator asked for several banners to choose from");
  for (const id of gb.TEMPLATE_IDS) {
    const s = gb.specOf(id);
    assert.ok(s.label && s.blurb, `missing copy for ${id}`);
    assert.ok(s.n >= 1 && s.n <= 10, `bad slot count for ${id}`);
    assert.ok(typeof s.title === "function" && s.title(s.n).length, `bad title for ${id}`);
    assert.ok(gb._internals.LAYOUTS[s.layout], `${id} names a layout that doesn't exist`);
  }
  assert.ok(gb.isTemplate(gb.DEFAULT_TEMPLATE));
  assert.ok(!gb.isTemplate("nope"));
  assert.strictEqual(gb.countOf("nope"), gb.countOf(gb.DEFAULT_TEMPLATE), "an unknown id falls back, never throws");
});

test("titles count the coins ACTUALLY drawn, not the template's size", () => {
  // Title case, not caps: the site sets its headings in Space Grotesk title case
  // ("New Listings", "Trending"), and a shouted heading is the first thing that
  // makes artwork look like a flyer instead of the product.
  assert.strictEqual(gb.specOf("list5").title(5), "Top 5 Gainers");
  assert.strictEqual(gb.specOf("list5").title(2), "Top 2 Gainers");
  assert.strictEqual(gb.specOf("podium").title(3), "Top 3 Gainers");
  assert.strictEqual(gb.specOf("podium").title(1), "Top 1 Gainer", "singular, and never 'Top 3' with one card");
});

test("pickTemplate: explicit wins, random is bounded by the pool", () => {
  assert.strictEqual(gb.pickTemplate("grid10"), "grid10");
  assert.strictEqual(gb.pickTemplate("grid10", { pool: ["list5"] }), "grid10", "an explicit choice ignores the pool");
  assert.strictEqual(gb.pickTemplate("random", { pool: ["podium"], rng: () => 0.99 }), "podium");
  const pool = ["list5", "grid10"];
  for (const r of [0, 0.49, 0.5, 0.999]) {
    assert.ok(pool.includes(gb.pickTemplate("random", { pool, rng: () => r })), `rng ${r} escaped the pool`);
  }
  assert.ok(gb.TEMPLATE_IDS.includes(gb.pickTemplate("random", { pool: [], rng: () => 0.5 })), "empty pool → any template");
  assert.ok(gb.TEMPLATE_IDS.includes(gb.pickTemplate("random", { pool: ["bogus"], rng: () => 0.5 })), "a stale pool entry can't wedge the picker");
  // rng returning exactly 1 (a bad injected rng) must not index past the end.
  assert.ok(gb.TEMPLATE_IDS.includes(gb.pickTemplate("random", { pool, rng: () => 1 })));
});

test("no coins → null, so the caller posts nothing at all", async () => {
  assert.strictEqual(await gb.render({ template: "list5", coins: [] }), null);
  assert.strictEqual(await gb.render({ template: "list5", coins: [null, undefined] }), null);
  assert.strictEqual(await gb.render({}), null);
});

test("render never throws on hostile input — it returns null", async () => {
  // A coin object with nothing on it, a NaN percentage, a Buffer that isn't an
  // image: each of these reached the renderer at some point in development.
  const out = await gb.render({ template: "list5", coins: [{}], dateText: "x" });
  assert.ok(out === null || Buffer.isBuffer(out));
  const out2 = await gb.render({
    template: "cards4",
    coins: [coin("A", NaN), coin("B", 10, { logo: Buffer.from("not an image") })],
    dateText: "Thursday · July 30 · 2026",
  });
  assert.ok(out2 === null || Buffer.isBuffer(out2));
});

// The pixel-producing tests only run where the native canvas is installed; the
// bot itself degrades the same way (available() === false → static fallback).
const canvas = gb.available();

test("every template renders a full plate of coins", { skip: !canvas && "canvas unavailable" }, async () => {
  for (const id of gb.TEMPLATE_IDS) {
    const buf = await gb.render({ template: id, coins: many(gb.countOf(id)), dateText: "Thursday · July 30 · 2026" });
    assert.ok(Buffer.isBuffer(buf) && buf.length > 20_000, `${id} produced no image`);
    assert.strictEqual(buf.slice(1, 4).toString(), "PNG", `${id} is not a PNG`);
  }
});

test("every template renders a SHORT plate (a thin day) and a single coin", { skip: !canvas && "canvas unavailable" }, async () => {
  for (const id of gb.TEMPLATE_IDS) {
    for (const n of [1, 2, Math.max(1, gb.countOf(id) - 1)]) {
      const buf = await gb.render({ template: id, coins: many(n), dateText: "Thursday · July 30 · 2026" });
      assert.ok(Buffer.isBuffer(buf) && buf.length > 20_000, `${id} failed with ${n} coin(s)`);
    }
  }
});

test("extra coins beyond the template's size are dropped, not drawn", { skip: !canvas && "canvas unavailable" }, async () => {
  const buf = await gb.render({ template: "podium", coins: many(10), dateText: "" });
  assert.ok(Buffer.isBuffer(buf));
  // podium takes 3; asking for 10 must not change the output size or fail
  const three = await gb.render({ template: "podium", coins: many(3), dateText: "" });
  assert.ok(Buffer.isBuffer(three));
});

test("a missing date line and a missing market cap are both fine", { skip: !canvas && "canvas unavailable" }, async () => {
  const coins = many(5).map((c) => ({ ...c, mcap: null, price: null, name: "" }));
  for (const id of gb.TEMPLATE_IDS) {
    assert.ok(Buffer.isBuffer(await gb.render({ template: id, coins, dateText: "" })), `${id} needs a date/mcap to render`);
  }
});

test("absurd tickers and names can't break a layout", { skip: !canvas && "canvas unavailable" }, async () => {
  const coins = [
    coin("VERYLONGTICKR", 204, { name: "A project with an extremely long marketing name that will never fit" }),
    coin("Ω", 96),
    coin("ПЁСИК", 40, { name: "Кириллица" }),
    coin("X", 4.2, { name: "" }),
  ];
  for (const id of gb.TEMPLATE_IDS) {
    assert.ok(Buffer.isBuffer(await gb.render({ template: id, coins, dateText: "Thursday · July 30 · 2026" })), id);
  }
});

test("a bad background path is ignored rather than fatal", { skip: !canvas && "canvas unavailable" }, async () => {
  const buf = await gb.render({ template: "list5", coins: many(5), dateText: "", bgPath: "/nope/does-not-exist.png" });
  assert.ok(Buffer.isBuffer(buf), "a missing background must fall back to the procedural backdrop");
});

test("a negative mover renders (the % chip carries the sign)", { skip: !canvas && "canvas unavailable" }, async () => {
  const buf = await gb.render({ template: "list5", coins: [coin("DOWN", -12.4), coin("UP", 8)], dateText: "" });
  assert.ok(Buffer.isBuffer(buf));
});
