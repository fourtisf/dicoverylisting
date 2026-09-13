// The DATA rules behind the Top-Gainers banner. The one that matters most is the
// last group: the site board serves demo listings with frozen figures when its
// market provider is down, and those must never reach a channel post.
const test = require("node:test");
const assert = require("node:assert");
const gainers = require("../src/gainers");
const { normSymbol, xHandle, logoCandidates, parseTokenRef } = gainers._internals;

test("normSymbol strips the $ and normalises case/length", () => {
  assert.strictEqual(normSymbol("$bullcat"), "BULLCAT");
  assert.strictEqual(normSymbol("  hoodrat "), "HOODRAT");
  assert.strictEqual(normSymbol("$$X"), "X");
  assert.strictEqual(normSymbol(null), "");
  assert.strictEqual(normSymbol("A".repeat(40)).length, 14, "capped so a joke ticker can't blow up a layout");
});

test("normSymbol disarms a ticker built to smuggle a link into the caption", () => {
  // Telegram auto-links bare URLs in message text regardless of entities, so
  // stripping the markup characters is not enough on its own.
  const s = normSymbol("](https://scam.example)[");
  assert.ok(!/[[\]()]/.test(s), s);
  assert.ok(!s.includes("//") && !s.includes(":"), s);
  assert.strictEqual(normSymbol("*BOLD*"), "BOLD");
  assert.strictEqual(normSymbol("ПЁС"), "ПЁС", "a non-Latin ticker is kept, not erased");
});

test("xHandle takes real handles and rejects x.com paths that aren't handles", () => {
  assert.strictEqual(xHandle("https://x.com/hoodrat_coin"), "hoodrat_coin");
  assert.strictEqual(xHandle("https://twitter.com/@KomaBNB"), "KomaBNB");
  assert.strictEqual(xHandle("https://x.com/i/status/123"), null);
  assert.strictEqual(xHandle("https://x.com/intent/tweet?text=hi"), null);
  assert.strictEqual(xHandle("https://t.me/somechannel"), null);
  assert.strictEqual(xHandle(""), null);
});

test("logoCandidates: stored logo first, then live, then the DexScreener CDN", () => {
  const urls = logoCandidates({
    logoUrl: "/api/media/abc.png",
    liveLogoUrl: "https://gecko/img.png",
    chain: "solana",
    address: "So1",
  });
  assert.match(urls[0], /^https:\/\/.+\/api\/media\/abc\.png$/, "a store path becomes a public URL");
  assert.strictEqual(urls[1], "https://gecko/img.png");
  assert.match(urls[2], /dd\.dexscreener\.com\/ds-data\/tokens\/solana\/So1\.png/);
});

test("logoCandidates dedupes and survives a token with no logo at all", () => {
  assert.deepStrictEqual(logoCandidates({ chain: "nosuchchain", address: "x" }), []);
  const same = logoCandidates({ logoUrl: "https://a/b.png", liveLogoUrl: "https://a/b.png", chain: "nosuchchain" });
  assert.deepStrictEqual(same, ["https://a/b.png"]);
});

test("parseTokenRef reads dexvra links, dexscreener links, pairs and bare addresses", () => {
  assert.deepStrictEqual(parseTokenRef("https://dexvra.io/token/solana/So1abc"), { chain: "solana", address: "So1abc" });
  assert.deepStrictEqual(parseTokenRef("https://dexscreener.com/bsc/0x" + "a".repeat(40)), {
    chain: "bsc",
    address: "0x" + "a".repeat(40),
  });
  assert.deepStrictEqual(parseTokenRef("base 0x" + "b".repeat(40)), { chain: "base", address: "0x" + "b".repeat(40) });
  const bare = parseTokenRef("0x" + "c".repeat(40));
  assert.strictEqual(bare.chain, null, "a bare address doesn't claim a chain");
  assert.strictEqual(bare.address, "0x" + "c".repeat(40));
  assert.deepStrictEqual(parseTokenRef("hello world"), { chain: null, address: null });
});

test("rank(): positive, sane, sorted, capped — never padded", () => {
  const coins = [
    { symbol: "A", address: "a", pct: 12, liq: 100 },
    { symbol: "B", address: "b", pct: 204, liq: 100 },
    { symbol: "C", address: "c", pct: -8, liq: 100 }, // a loser is not a gainer
    { symbol: "D", address: "d", pct: 999999, liq: 100 }, // broken pool data
    { symbol: "E", address: "e", pct: null, liq: 100 }, // unpriced
    { symbol: "F", address: "f", pct: 40, liq: 1 }, // too thin
  ];
  const out = gainers.rank(coins, { limit: 5, minGainPct: 1, minLiqUsd: 50 });
  assert.deepStrictEqual(out.map((c) => c.symbol), ["B", "A"]);
  assert.strictEqual(gainers.rank(coins, { limit: 1, minGainPct: 1 })[0].symbol, "B");
  assert.strictEqual(gainers.rank(coins, { limit: 99 }).length, 3, "limit is capped at MAX_SLOTS' worth of real gainers");
});

test("pctLabel: ONE precision rule (integer ≥100, one decimal below), sign always shown", () => {
  assert.strictEqual(gainers.pctLabel(204.44), "+204%");
  assert.strictEqual(gainers.pctLabel(27.72), "+27.7%");
  // One decimal below 100 — never two. "+8.20%" beside "+22.1%" in an aligned
  // mono column is the formatting tell a design review flags.
  assert.strictEqual(gainers.pctLabel(4.567), "+4.6%");
  assert.strictEqual(gainers.pctLabel(-3.4), "-3.4%");
  assert.strictEqual(gainers.pctLabel(null), "");
  assert.strictEqual(gainers.pctLabel("nonsense"), "");
});

test("dateText carries no comma (tracking makes it a floating speck) and falls back to UTC", () => {
  const d = new Date("2026-07-30T04:00:00Z");
  const jkt = gainers.dateText("Asia/Jakarta", d);
  assert.ok(!jkt.includes(","), jkt);
  assert.match(jkt, /Thursday · July 30 · 2026/);
  // A hand-edited config can hold a bogus zone; it must not throw mid-render.
  assert.match(gainers.dateText("Mars/Olympus_Mons", d), /July 2?9|July 30/);
  assert.strictEqual(gainers.validTz("Asia/Jakarta"), true);
  assert.strictEqual(gainers.validTz("Nope/Nope"), false);
});

test("listMarkup links every token and neutralises a markup-injecting ticker", () => {
  const md = gainers.listMarkup([
    { symbol: "HOODRAT", pct: 204, url: "https://dexvra.io/token/solana/So1", x: "hoodrat_coin" },
    { symbol: "PLAIN", pct: 10, url: "https://dexvra.io/token/bsc/0x2" },
  ]);
  const [l1, l2] = md.split("\n");
  assert.match(l1, /\[#HOODRAT\]\(https:\/\/dexvra\.io\/token\/solana\/So1\)/);
  assert.match(l1, /\[@hoodrat_coin\]\(https:\/\/x\.com\/hoodrat_coin\)/);
  assert.match(l1, /\*\*\+204%\*\*/);
  assert.ok(!l2.includes("@"), "a token with no X handle gets no handle segment");

  // A hostile ticker must be able to produce neither a markup link nor a bare
  // URL Telegram would auto-link. normSymbol is where that is enforced; this
  // asserts the caption path actually goes through it.
  const evil = gainers.listMarkup([
    { symbol: gainers._internals.normSymbol("](https://scam.example)["), pct: 5, url: "https://dexvra.io/x" },
  ]);
  assert.ok(!evil.includes("//scam.example"), `injected link survived: ${evil}`);
  assert.strictEqual((evil.match(/\]\(/g) || []).length, 2, `exactly the badge + token links: ${evil}`);
});

test("captionPayload renders the template into {text, entities} with real links", () => {
  const p = gainers.captionPayload([
    { symbol: "HOODRAT", pct: 204, url: "https://dexvra.io/token/solana/So1", x: "hoodrat_coin", mcap: 12_400_000 },
    { symbol: "KOMA", pct: 96.8, url: "https://dexvra.io/token/bsc/0x2" },
  ]);
  assert.ok(p.text.includes("#HOODRAT") && p.text.includes("+204%"), p.text);
  assert.ok(!p.text.includes("["), "markup is consumed into entities, not left as text");
  const links = p.entities.filter((e) => e.type === "text_link").map((e) => e.url);
  assert.ok(links.includes("https://dexvra.io/token/solana/So1"));
  assert.ok(links.includes("https://x.com/hoodrat_coin"));
  // Every entity must land inside the text, or Telegram rejects the whole send.
  for (const e of p.entities) assert.ok(e.offset + e.length <= p.text.length, JSON.stringify(e));
});

test("captionPayload can add market cap without disturbing the entity offsets", () => {
  const coins = [{ symbol: "HOODRAT", pct: 204, url: "https://dexvra.io/x", mcap: 12_400_000 }];
  const p = gainers.captionPayload(coins, { showMcap: true });
  assert.ok(p.text.includes("$12.40M"), p.text);
  for (const e of p.entities) assert.ok(e.offset + e.length <= p.text.length, JSON.stringify(e));
});

// ── the board source ────────────────────────────────────────────────────────
function withFetch(impl, fn) {
  const real = global.fetch;
  global.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = real;
    });
}
const boardRes = (payload) => ({
  ok: true,
  status: 200,
  json: async () => payload,
  headers: { get: () => "application/json" },
});
const tok = (o) => ({
  chain: "solana",
  address: o.address || "So" + o.symbol,
  symbol: o.symbol,
  name: o.symbol,
  logoUrl: null,
  links: {},
  priceUsd: 1,
  mcap: 1e6,
  liq: 1e5,
  vol: { "24h": 1e5 },
  chg: { "24h": o.chg },
  source: o.source || "live",
  tier: "DIAMOND",
});

test("topGainers uses the site board and NEVER publishes its seed rows", async () => {
  await withFetch(
    async (url) => {
      assert.match(String(url), /\/api\/tokens$/);
      return boardRes({
        live: true,
        tokens: [
          tok({ symbol: "SEEDY", chg: 900, source: "seed" }), // frozen demo figures
          tok({ symbol: "REAL1", chg: 120 }),
          tok({ symbol: "REAL2", chg: 40 }),
          tok({ symbol: "DOWN", chg: -10 }),
        ],
      });
    },
    async () => {
      const res = await gainers.topGainers({ limit: 5, logos: false });
      assert.strictEqual(res.source, "board");
      assert.deepStrictEqual(res.coins.map((c) => c.symbol), ["REAL1", "REAL2"]);
      assert.ok(!res.coins.some((c) => c.symbol === "SEEDY"), "a seed row reached the banner");
      assert.strictEqual(res.pool, 3, "pool counts live-priced candidates only");
    },
  );
});

test("topGainers reports WHY it has nothing instead of inventing a board", async () => {
  await withFetch(
    async () => boardRes({ live: false, tokens: [tok({ symbol: "SEEDY", chg: 900, source: "seed" })] }),
    async () => {
      // No live board rows, and the listings fallback has no API token in tests →
      // both paths fail, and the caller gets an explanation rather than data.
      const res = await gainers.topGainers({ limit: 5, logos: false });
      assert.deepStrictEqual(res.coins, []);
      assert.strictEqual(res.source, "none");
      assert.ok(res.notes.length, "a failure must be explainable to the operator");
      assert.ok(/LIVE rows/i.test(res.notes.join(" ")), res.notes.join(" "));
    },
  );
});

test("topGainers survives a board that is down or reshaped", async () => {
  await withFetch(
    async () => ({ ok: false, status: 502, json: async () => ({}), headers: { get: () => "text/html" } }),
    async () => {
      const res = await gainers.topGainers({ limit: 3, logos: false });
      assert.deepStrictEqual(res.coins, []);
      assert.ok(/unreachable/i.test(res.notes.join(" ")), res.notes.join(" "));
    },
  );
  await withFetch(
    async () => boardRes({ nope: true }),
    async () => {
      const res = await gainers.topGainers({ limit: 3, logos: false });
      assert.deepStrictEqual(res.coins, []);
    },
  );
});

test("the minimum-gain filter is applied to the board, not just the fallback", async () => {
  await withFetch(
    async () => boardRes({ live: true, tokens: [tok({ symbol: "TINY", chg: 0.4 }), tok({ symbol: "BIG", chg: 60 })] }),
    async () => {
      const res = await gainers.topGainers({ limit: 5, minGainPct: 5, logos: false });
      assert.deepStrictEqual(res.coins.map((c) => c.symbol), ["BIG"]);
    },
  );
});
