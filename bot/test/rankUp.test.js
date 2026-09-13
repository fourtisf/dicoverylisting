// Rank-up alerts — marketdata 24h-change extraction + the climb/dedup logic
// and the post_rankup template.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-rankup-"));

const test = require("node:test");
const assert = require("node:assert");
const market = require("../src/marketdata");
const fmt = require("../src/channels/format");

function stubFetch(router) {
  const orig = global.fetch;
  global.fetch = async (url) => {
    const body = router(String(url));
    if (body === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  };
  return () => (global.fetch = orig);
}

test("fetchMarket surfaces the top pool's 24h change (GT)", async () => {
  const restore = stubFetch((url) => {
    if (!url.includes("geckoterminal")) return null;
    return JSON.stringify({
      data: {
        attributes: { price_usd: "0.01", market_cap_usd: "500000" },
        relationships: { top_pools: { data: [{ id: "solana_POOL1" }] } },
      },
      included: [
        { id: "solana_POOL1", attributes: { address: "POOL1", price_change_percentage: { h24: "42.5" } } },
      ],
    });
  });
  try {
    const m = await market.fetchMarket("solana", "AAA");
    assert.ok(m);
    assert.strictEqual(m.change24h, 42.5);
  } finally {
    restore();
  }
});

test("fetchMarket 24h change falls back to DexScreener when GT lacks price/mcap", async () => {
  const restore = stubFetch((url) => {
    if (url.includes("geckoterminal")) return null; // GT unindexed
    if (url.includes("dexscreener"))
      return JSON.stringify({
        pairs: [
          { chainId: "solana", priceUsd: "0.02", marketCap: 900000, liquidity: { usd: 40000 }, pairAddress: "p", priceChange: { h24: -8.3 } },
        ],
      });
    return null;
  });
  try {
    const m = await market.fetchMarket("solana", "AAA");
    assert.ok(m);
    assert.strictEqual(m.change24h, -8.3);
  } finally {
    restore();
  }
});

test("post_rankup is a short ticker post: token, rank, link, CA", () => {
  const coin = { name: "Pepe", symbol: "$PEPE", chain: "ethereum", address: "0xabc", links: {}, siteUrl: "https://dexvra.io/t" };
  const card = fmt.rankupPost(coin, 2, 137.6);
  assert.ok(card.text.includes("$PEPE"), card.text);
  assert.ok(card.text.includes("#2"), card.text);
  assert.ok(card.text.includes("📈"), "chart-up emoji present (unicode fallback)");
  assert.ok(card.text.includes("0xabc"), "the contract address is in the post");
  assert.ok(card.text.includes("🔷"), "chain emoji leads the line");
  // The clip carries the hype — the caption stays a ticker, not an article.
  assert.ok(card.text.length < 400, `caption should stay short, got ${card.text.length}`);
  assert.ok(!/just climbed to|top gainers/.test(card.text), "no long-form copy");
  // Links that must survive: the token page and the channel footer.
  const links = card.entities.filter((e) => e.type === "text_link").map((e) => e.url);
  assert.ok(links.some((u) => u.includes("dexvra.io/t")), `token page linked: ${links}`);
  // Being short is no reason to link fewer places — site AND all three channels.
  const ch = fmt.channelLinks();
  for (const name of ["site", "listing", "trending", "announce"]) {
    assert.ok(links.includes(ch[name]), `${name} (${ch[name]}) missing from the rank-up post: ${links}`);
  }
  assert.ok(card.entities.some((e) => e.type === "code"), "CA is copyable (code entity)");
  assert.ok(!/\*\*|\]\(/.test(card.text), "no raw markup leaks into the post");
});

test("rank-up gain/change vars: clamped, and dropped when not positive", async () => {
  // {gain} (compact) and {change} (sentence) stay available for admins who want
  // the number back — with the same guards, so a low-liquidity +490,749% print
  // never reaches the channel.
  const tpl = require("../src/templates");
  const coin = { name: "Pepe", symbol: "$PEPE", chain: "ethereum", address: "0xabc", links: {}, siteUrl: "https://dexvra.io/t" };
  await tpl.setTemplate("post_rankup", "{symbol} #{rank} [{gain}]{change}");
  try {
    assert.ok(fmt.rankupPost(coin, 2, 137.6).text.includes("+138%"), "compact gain rounds");
    assert.ok(/over the last 24h/.test(fmt.rankupPost(coin, 2, 137.6).text), "sentence form still works");
    const neg = fmt.rankupPost(coin, 1, -0.4).text;
    assert.ok(!neg.includes("%"), `no % at all when the token isn't up: ${neg}`);
    const absurd = fmt.rankupPost(coin, 2, 490749).text;
    assert.ok(!absurd.includes("490"), "absurd % not shown");
    assert.ok(/Momentum/.test(absurd), "…replaced by a momentum line");
  } finally {
    await tpl.resetTemplate("post_rankup");
  }
});

// The climb logic, unit-tested in isolation (mirrors rankUpChecker's rule).
test("climb rule: alert only on improvement INTO the top band", () => {
  const RANKUP_TOP = 3;
  const climbed = (prev, rank) => rank <= RANKUP_TOP && (prev == null || prev > rank);
  assert.ok(climbed(undefined, 1)); // new entrant at #1
  assert.ok(climbed(5, 2)); // 5 → 2 climb into band
  assert.ok(!climbed(2, 3)); // 2 → 3 is a DROP
  assert.ok(!climbed(1, 1)); // unchanged
  assert.ok(!climbed(6, 4)); // climbed but still outside top 3
});
