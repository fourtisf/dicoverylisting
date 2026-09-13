// "bisakah anda buat fitur kaya presentase kenaikan bisa di on ofin" — the
// percentage on the Top-Gainers post is ONE switch for THREE surfaces: the
// artwork, the Telegram caption and the tweet. Decided in three places it
// would eventually disagree — a banner shouting +2163% under a caption that
// prints nothing — so `showPct` is one config boolean, read by the poster
// and the panel and handed to every renderer.
//
// The artwork half is MEASURED by running the renderer with the 2D context's
// fillText and fillStyle wrapped: a source scan cannot tell "the figure is not
// drawn" from a comment saying so, and bigPct/pctChip drawing nothing for an
// empty label is exactly the kind of property that survives a refactor only
// while somebody is looking.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-gainers-pct-"));
process.env.BOT_DATA_DIR = DIR;

const cfg = require("../src/services/gainersConfig");
const gainers = require("../src/gainers");
const gb = require("../src/gainersBanner");
const kit = require("../src/helpers/canvasKit");

const write = (obj) => fs.writeFileSync(path.join(DIR, cfg.FILE), JSON.stringify(obj));
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

// ── config ──────────────────────────────────────────────────────────────────

test("showPct ships ON — a gainers board with no gains printed is a list of tickers", () => {
  fs.rmSync(path.join(DIR, cfg.FILE), { force: true });
  assert.strictEqual(cfg.get().showPct, true);
});

test("a hand-edited non-boolean is ignored, set() persists, reset() restores", async () => {
  write({ showPct: "no" });
  assert.strictEqual(cfg.get().showPct, true, "a string is not a decision");
  await cfg.set({ showPct: false });
  assert.strictEqual(cfg.get().showPct, false);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(DIR, cfg.FILE), "utf8")).showPct, false, "it is on DISK — the poster is another process");
  await cfg.reset();
  assert.strictEqual(cfg.get().showPct, true);
});

// ── caption + tweet ─────────────────────────────────────────────────────────

test("the caption drops the figure when the switch is off, and keeps every entity inside the text", () => {
  const coins = [coin("HOODRAT", 204, { x: "hoodrat_coin" }), coin("KOMA", 96.8)];
  const on = gainers.captionPayload(coins);
  assert.ok(on.text.includes("+204%") && on.text.includes("+96.8%"), on.text);
  const off = gainers.captionPayload(coins, { showPct: false });
  assert.ok(!off.text.includes("+204%") && !off.text.includes("+96.8%"), off.text);
  assert.ok(off.text.includes("#HOODRAT") && off.text.includes("#KOMA"), "the ranking itself stays");
  for (const e of off.entities) assert.ok(e.offset + e.length <= off.text.length, JSON.stringify(e));
});

test("the tweet's plain-text board honours the same switch", () => {
  const coins = [coin("HOODRAT", 204, { x: "hoodrat_coin" })];
  assert.match(gainers.listText(coins), /\+204%/);
  assert.doesNotMatch(gainers.listText(coins, { showPct: false }), /%/);
  assert.match(gainers.listText(coins, { showPct: false }), /1\. \$HOODRAT @hoodrat_coin/);
});

// ── artwork ─────────────────────────────────────────────────────────────────
//
// Wraps the context PROTOTYPE, the way bannerFonts.test.js observes the font
// stack: @napi-rs/canvas hands every canvas a context sharing one prototype,
// so a wrapped setter sees every draw the renderer makes.
async function drawn(fn) {
  const CV = kit.canvasLib();
  const proto = Object.getPrototypeOf(CV.createCanvas(4, 4).getContext("2d"));
  const fillDesc = Object.getOwnPropertyDescriptor(proto, "fillStyle");
  const realFillText = proto.fillText;
  const texts = [];
  const fills = [];
  Object.defineProperty(proto, "fillStyle", {
    ...fillDesc,
    set(v) { fills.push(String(v)); fillDesc.set.call(this, v); },
  });
  proto.fillText = function (t, ...rest) { texts.push(String(t)); return realFillText.call(this, t, ...rest); };
  try {
    await fn();
  } finally {
    Object.defineProperty(proto, "fillStyle", fillDesc);
    proto.fillText = realFillText;
  }
  return { texts, fills };
}
// bigPct/pctChip strip the sign and draw "204%" / "27.7%" in ONE fillText.
const isFigure = (t) => /^\d[\d.,]*%$/.test(t.trim());
// ⚠️ A HEADING IS NOT ONE fillText. microLabel tracks its letters by hand —
// one fillText PER GLYPH — so "24H" arrives as "2", "4", "H", and a predicate
// on whole strings matched nothing and passed vacuously on the first cut.
// Single-glyph draws are re-joined into runs (a multi-glyph draw breaks the
// run) and the heading is counted as a substring of those runs. The header
// strip legitimately says "LIVE · 24H" and "RANKED BY 24H CHANGE" on every
// template, so the OFF assertion is against hero1's count — the layout with
// no board and therefore no heading — rather than against zero.
const runs = (texts) => {
  const out = [];
  let cur = "";
  for (const t of texts) {
    if ([...t].length === 1) cur += t;
    else {
      if (cur) out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
};
const mentions = (texts, s) => runs(texts).reduce((a, r) => a + r.split(s).length - 1, 0);
// The layouts that draw a board with a "24h" column heading over the figure.
const BOARDS = ["list5", "grid10", "tier6", "crown7", "spot10"];
// list5's gain-bar TRACK — the one fillStyle string that only the bar sets, so
// a bar drawn with the figure hidden (the percentage published as a length)
// is caught here rather than argued about.
const BAR_TRACK = "rgba(255,255,255,.05)";

test("⚠️ with the switch OFF no template draws a percentage, a 24h heading, or the gain bar — and ON every one draws the figure", async () => {
  if (!gb.available()) return;
  // hero1 has no board, so with the switch off its "24H" mentions are the
  // header strip's alone — the baseline every other template must match.
  const base = mentions((await drawn(() => gb.render({ template: "hero1", coins: many(1), dateText: "", showPct: false }))).texts, "24H");
  assert.ok(base > 0, "the header strip drew no 24H at all — the run reconstruction is not seeing microLabel");
  for (const id of gb.TEMPLATE_IDS) {
    const n = gb.countOf(id);
    const off = await drawn(async () => {
      assert.ok(Buffer.isBuffer(await gb.render({ template: id, coins: many(n), dateText: "Thursday · July 30 · 2026", showPct: false })), `${id} did not render`);
    });
    // A probe that recorded nothing proves nothing.
    assert.ok(off.texts.length > 3, `${id}: the wrap saw no text at all`);
    assert.deepStrictEqual(off.texts.filter(isFigure), [], `${id} drew a percentage with showPct:false`);
    assert.strictEqual(mentions(off.texts, "24H"), base, `${id} drew a 24h heading over a column it did not draw`);
    assert.ok(!off.fills.includes(BAR_TRACK), `${id} drew the gain bar with the figure hidden`);

    const on = await drawn(async () => {
      assert.ok(Buffer.isBuffer(await gb.render({ template: id, coins: many(n), dateText: "Thursday · July 30 · 2026", showPct: true })));
    });
    assert.ok(on.texts.some(isFigure), `${id}: the positive control drew no percentage — the OFF assertion above is vacuous`);
    if (BOARDS.includes(id)) assert.ok(mentions(on.texts, "24H") > base, `${id}: the positive control drew no 24h heading — the heading assertion is vacuous`);
    if (id === "list5") assert.ok(on.fills.includes(BAR_TRACK), "list5's bar track was not observed ON — the bar assertion is vacuous");
  }
});

test("an omitted showPct draws the figure — the switch may not default to hidden", async () => {
  if (!gb.available()) return;
  const on = await drawn(async () => {
    await gb.render({ template: "list5", coins: many(5), dateText: "" });
  });
  assert.ok(on.texts.some(isFigure));
});

// ── every site, both processes ──────────────────────────────────────────────
//
// The admin bot renders the preview and the queued post; the main bot renders
// the daily one and builds the tweet. A fix applied to one of two siblings is
// a fix half-made (fulfillment's own scar), so every render, caption and tweet
// site in BOTH files has to carry the switch — counted, over comment-stripped
// source, because a site added later forgets in exactly the same way.
test("every gb.render / captionPayload / listText site in the panel AND the poster passes showPct", () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const expect = {
    "src/admin/gainersMenu.js": { render: 2, caption: 2, list: 1 },
    "src/services/gainersPoster.js": { render: 1, caption: 1, list: 1 },
  };
  for (const [file, want] of Object.entries(expect)) {
    const src = strip(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
    const renders = src.split("gb.render({").slice(1).map((c) => c.split("});")[0]);
    assert.strictEqual(renders.length, want.render, `${file}: gb.render sites moved — re-count, and make sure each carries the switch`);
    for (const r of renders) assert.match(r, /showPct: cfg\.showPct/, `${file}: a gb.render site without showPct`);
    const captions = src.split("gainers.captionPayload(").slice(1).map((c) => c.split(")")[0]);
    assert.strictEqual(captions.length, want.caption, `${file}: captionPayload sites moved`);
    for (const c of captions) assert.match(c, /showPct: cfg\.showPct/, `${file}: a captionPayload site without showPct`);
    const lists = src.split("gainers.listText(").slice(1).map((c) => c.split(")")[0]);
    assert.strictEqual(lists.length, want.list, `${file}: listText sites moved`);
    for (const l of lists) assert.match(l, /showPct: cfg\.showPct/, `${file}: a listText site without showPct`);
  }
});

test("⚠️ two renders in flight with different settings do not share the switch", async () => {
  // The shipped spec objects are shared by every render. Stamping the flag
  // onto one of them instead of onto a copy is invisible to every sequential
  // test above and shows the moment two posts render at once: the preview
  // and the daily post, or two admins. list5 is the probe because its bar
  // and headings are drawn AFTER the first await, off the spec.
  if (!gb.available()) return;
  const n = 5;
  const alone = async (showPct) => drawn(() => gb.render({ template: "list5", coins: many(n), dateText: "", showPct }));
  const offAlone = await alone(false);
  const onAlone = await alone(true);
  const both = await drawn(async () => {
    await Promise.all([
      gb.render({ template: "list5", coins: many(n), dateText: "", showPct: false }),
      gb.render({ template: "list5", coins: many(n), dateText: "", showPct: true }),
    ]);
  });
  const bars = both.fills.filter((f) => f === BAR_TRACK).length;
  assert.strictEqual(bars, n, `expected ${n} bar tracks (the ON render's rows only), saw ${bars} — the OFF render drew bars off a flag it did not set`);
  const want = mentions(offAlone.texts, "24H") + mentions(onAlone.texts, "24H");
  const got = mentions(both.texts, "24H");
  assert.strictEqual(got, want, `expected ${want} 24H mentions (each render's own), saw ${got} — the OFF render drew headings off a flag it did not set`);
});
