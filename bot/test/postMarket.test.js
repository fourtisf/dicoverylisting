// "Market cap: TBA · Price: TBA" — on a paid Xpress listing, to 12,528
// subscribers, over a token dexvra.io was pricing at $0.001004 on a $950.2K cap
// in the same minute.
//
// Nothing was down. `fetchMarket` is GT-FIRST, `fetchGT` waits on
// `gtSlot(PRIO_BACKGROUND)` — the shared GeckoTerminal queue, no deadline of
// its own, behind every timer job on the box at ~5 releases a minute — and
// fulfilment's MARKET_BUDGET_MS bound then fired with DexScreener NEVER ASKED.
// The listing form paid for this exact shape one module over; this is the same
// defect on the surface a customer screenshots.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-postmarket-"));

const test = require("node:test");
const assert = require("node:assert");
const market = require("../src/marketdata");

const dsBody = (pairs) => JSON.stringify({ pairs });
const HACHIKO = {
  chainId: "bsc",
  priceUsd: "0.001004",
  marketCap: 950200,
  liquidity: { usd: 131200 },
  volume: { h24: 34200 },
  priceChange: { h24: -1.1 },
  pairAddress: "0xpair",
  baseToken: { name: "Hachiko Inu", symbol: "HACHIKO" },
};

/** Records which hosts were asked, in order. */
function stubFetch(router) {
  const orig = global.fetch;
  const asked = [];
  global.fetch = async (url) => {
    const u = String(url);
    asked.push(u.includes("geckoterminal") ? "gt" : u.includes("dexscreener") ? "ds" : "other");
    const body = router(u);
    if (body === null) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  };
  return { asked, restore: () => (global.fetch = orig) };
}

// The three figures `coinVars` renders on a channel post. Named here rather
// than imported so the test states the contract it is guarding: change the
// post's market fields and this list has to change with them.
const POST_NEED = ["priceUsd", "mcap", "liq"];

test("a post's market read asks DexScreener FIRST and stops there", async () => {
  const { asked, restore } = stubFetch((url) => (url.includes("dexscreener") ? dsBody([HACHIKO]) : null));
  try {
    const m = await market.fetchMarket("bsc", "0xf1c599e9a5fbdea408a7409c0176a2fe42c64444", {
      cheap: true,
      need: POST_NEED,
    });
    assert.ok(m, "DexScreener had all three — the read must not come back null");
    assert.strictEqual(m.priceUsd, 0.001004);
    assert.strictEqual(m.mcap, 950200);
    assert.strictEqual(m.liq, 131200);
    // ⚠️ THE WHOLE POINT. GeckoTerminal is where the 8s budget was being spent
    // queueing; a read that reaches it at all can still time out and post TBA.
    assert.ok(!asked.includes("gt"), `GeckoTerminal must not be asked: ${asked.join(", ")}`);
  } finally {
    restore();
  }
});

test("…and it is an ORDER, not a second reader — a DS miss still falls to GT", async () => {
  // The fail-safe direction: DexScreener that cannot answer must cost the post
  // nothing beyond the old behaviour.
  const gtBody = JSON.stringify({
    data: { attributes: { price_usd: "0.5", market_cap_usd: "1000", total_reserve_in_usd: "2000" }, relationships: {} },
    included: [],
  });
  const { asked, restore } = stubFetch((url) => (url.includes("geckoterminal") ? gtBody : null));
  try {
    const m = await market.fetchMarket("bsc", "0xabc", { cheap: true, need: POST_NEED });
    assert.ok(m && m.priceUsd === 0.5, "GT still answers when DexScreener cannot");
    assert.ok(asked.includes("ds") && asked.includes("gt"));
    assert.ok(asked.indexOf("ds") < asked.indexOf("gt"), "…but DexScreener is asked first");
  } finally {
    restore();
  }
});

test("⚠️ a DexScreener answer MISSING one of the post's fields is not enough", async () => {
  // The `need` list is the guard: a record with no liquidity would render
  // "Liquidity: —" on the post, so it must fall through rather than win.
  const noLiq = { ...HACHIKO, liquidity: {} };
  const { asked, restore } = stubFetch((url) => (url.includes("dexscreener") ? dsBody([noLiq]) : null));
  try {
    await market.fetchMarket("bsc", "0xabc", { cheap: true, need: POST_NEED });
    assert.ok(asked.includes("gt"), "an incomplete DexScreener answer must still reach GT");
  } finally {
    restore();
  }
});

// A behavioural test on `fetchMarket` proves the mechanism; it cannot prove the
// POST uses it. Both call sites, comment-stripped — a comment quoting the fix
// is not the fix, which is this repo's own rule for a source scan.
test("both channel-post market reads go through POST_MARKET", () => {
  const raw = fss.readFileSync(require.resolve("../src/fulfillment.js"), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // ⚠️ THIS GUARD USED TO COUNT CALL SITES — `calls.length >= 2` — so it went
  // red the day the two identical reads were merged into ONE owner
  // (`readPostMarket`, which also captures WHY a read could not answer, for the
  // figure watch). That is this repo's own recurring defect: a guard pinned to
  // a spelling rather than to the rule, red over code that keeps it perfectly.
  // The rule is that EVERY market read a channel post makes is the cheap
  // DexScreener-first one, and that BOTH posts go through it.
  const calls = code.match(/market\.fetchMarket\([^)]*\)/g) || [];
  assert.ok(calls.length >= 1, "fulfilment no longer reads the market at all");
  for (const c of calls) {
    assert.match(c, /POST_MARKET/, `a channel post read that is still GT-first: ${c}`);
  }
  assert.equal((code.match(/readPostMarket\(/g) || []).length, 3, "one definition, and both posts calling it");
  // …and the constant has to name the fields the post actually renders.
  assert.match(code, /POST_MARKET\s*=\s*\{\s*cheap:\s*true,\s*need:\s*\["priceUsd",\s*"mcap",\s*"liq"\]/);
});
