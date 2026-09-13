// The listing side of pre-migration data.
//
// THE HOLE THIS CLOSES: listing autofill asked DexScreener and GeckoTerminal,
// both of which index POOLS. A token still on a bonding curve has no pool, so
// the form came back empty — no name, no ticker, no logo, no socials, no
// overview — and the project had to type all of it, for a token whose entire
// profile is public on the launchpad it was minted on.
//
// Offline: `global.fetch` is replaced throughout, so nothing here depends on
// which host a launchpad is serving today. That question is `npm run
// launchpads:check`, and it can only be answered on the box.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-lp-"));

const test = require("node:test");
const assert = require("node:assert");

const lp = require("../../shared/launchpads");
const launchpads = require("../src/launchpads");
const discovery = require("../src/discovery");
const marketdata = require("../src/marketdata");

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function serve(routes) {
  global.fetch = async (url) => {
    for (const [frag, res] of Object.entries(routes)) {
      if (!String(url).includes(frag)) continue;
      if (typeof res === "number") return { ok: res >= 200 && res < 300, status: res, text: async () => "", json: async () => ({}) };
      return { ok: true, status: 200, text: async () => JSON.stringify(res), json: async () => res };
    }
    const e = new TypeError("fetch failed");
    e.cause = { code: "ENOTFOUND" };
    throw e;
  };
}

const PUMP = {
  mint: MINT,
  name: "Curve Kid",
  symbol: "CURVE",
  description: "A project that has not migrated yet and still has a website, an X account and a logo.",
  image_uri: "https://i.example/a.png",
  twitter: "curveproj",
  telegram: "curvechat",
  website: "https://curve.example",
  created_timestamp: 1755300000000,
  complete: false,
  usd_market_cap: 23150,
  real_token_reserves: 400000000000000,
  real_sol_reserves: 30000000000,
};
const JUP = [{ id: MINT, name: "Curve Kid", symbol: "CURVE", usdPrice: 0.0000231, mcap: 23150, liquidity: 8400, holderCount: 143, launchpad: "pump.fun", bondingCurve: 49.6 }];

function reset() {
  for (const k of Object.keys(process.env)) if (/^LAUNCHPAD/.test(k)) delete process.env[k];
  lp.reload();
}
test.afterEach(() => { delete global.fetch; reset(); });

// ── autofill ─────────────────────────────────────────────────────────────────

test("a bonding token prefills the whole listing form", async () => {
  reset();
  serve({ "pump.fun": PUMP, "jup.ag": JUP });
  const info = await launchpads.fetchTokenInfo("solana", MINT);
  assert.equal(info.name, "Curve Kid");
  assert.equal(info.symbol, "CURVE");
  assert.equal(info.logoUrl, "https://i.example/a.png");
  assert.equal(info.website, "https://curve.example");
  assert.equal(info.twitter, "https://x.com/curveproj", "a bare handle was not expanded into a URL");
  assert.equal(info.telegram, "https://t.me/curvechat");
  assert.ok(info.description, "the overview would have fallen back to the auto-written intro");
  assert.equal(info.onCurve, true);
});

test("the shape matches dexscreener.fetchTokenInfo, zeros and all", async () => {
  reset();
  // autoLister.rejectReason reads `liq`, `vol24` and `pairCreatedAt` by those
  // names and treats 0 as "no data". A null here would read as a PASSING score
  // on a gate the operator set, and auto-list a token with no liquidity at all.
  serve({ "pump.fun": PUMP, "jup.ag": [{ id: MINT, name: "Curve Kid", symbol: "CURVE" }] });
  const info = await launchpads.fetchTokenInfo("solana", MINT);
  for (const k of ["liq", "vol24", "change24h", "pairCreatedAt", "pairCount"]) {
    assert.equal(typeof info[k], "number", `${k} is not a number — the auto-lister's gates read it as one`);
  }
  assert.equal(info.liq, 0, "an unknown liquidity became something other than 0");
});

test("a token no pad knows returns null, so the caller falls through", async () => {
  reset();
  serve({ "pump.fun": 404, "jup.ag": [], "raydium.io": 404, "moonshot.cc": 404 });
  assert.equal(await launchpads.fetchTokenInfo("solana", MINT), null);
});

// ── merging with the indexers ────────────────────────────────────────────────

test("the indexer wins on numbers, the launchpad fills the holes", () => {
  const ds = { name: "Curve Kid", symbol: "CURVE", priceUsd: 0.000025, mcap: 24000, liq: 9000, vol24: 0, logoUrl: null, website: null, twitter: null, telegram: null, pairCreatedAt: 0, change24h: 0 };
  const lpInfo = { name: "Stale Name", symbol: "OLD", priceUsd: 0.0000231, mcap: 23150, liq: 8400, vol24: 5000, logoUrl: "https://i.example/a.png", website: "https://curve.example", twitter: "https://x.com/curveproj", telegram: null, pairCreatedAt: 1755300000000, change24h: 7, onCurve: true, source: "launchpad:pumpfun" };
  const m = discovery.mergeInfo(ds, lpInfo);
  // A live pool reading beats a launchpad's copy of the same number.
  assert.equal(m.priceUsd, 0.000025);
  assert.equal(m.mcap, 24000);
  assert.equal(m.name, "Curve Kid", "a stale launchpad name overwrote the indexer's");
  // ZERO IS A VALUE, NOT A HOLE — see the auto-lister note above. If a
  // launchpad's 5000 could overwrite DexScreener's real 0, the gate would be
  // scored against a different source than the one it thinks it is reading.
  assert.equal(m.vol24, 0, "a real 0 from the indexer was overwritten");
  assert.equal(m.change24h, 0);
  assert.equal(m.pairCreatedAt, 0);
  // The holes, filled — this is the entire point.
  assert.equal(m.logoUrl, "https://i.example/a.png");
  assert.equal(m.website, "https://curve.example");
  assert.equal(m.twitter, "https://x.com/curveproj");
  assert.equal(m.onCurve, true);
  assert.equal(m.telegram, null, "a field neither source had was invented");
});

test("either source alone still answers", () => {
  assert.deepEqual(discovery.mergeInfo(null, { name: "A" }), { name: "A" });
  assert.equal(discovery.mergeInfo({ name: "A" }, null).name, "A");
  assert.equal(discovery.mergeInfo(null, null), null);
});

test("discovery asks the launchpads even when DexScreener answered", async () => {
  reset();
  // A pump.fun launch usually DOES have a DexScreener pair, and that pair's
  // `info` block is usually empty for the first minutes — so a fallback
  // ("launchpads only when DexScreener has nothing") would never fire on the
  // exact tokens it exists for, and the socials would stay missing.
  serve({
    "dexscreener": { pairs: [{ chainId: "solana", baseToken: { name: "Curve Kid", symbol: "CURVE" }, priceUsd: "0.000025", marketCap: 24000, liquidity: { usd: 9000 }, volume: { h24: 120 }, priceChange: { h24: 3 }, pairCreatedAt: 1755300000000, info: {} }] },
    "pump.fun": PUMP,
    "jup.ag": JUP,
  });
  const info = await discovery.fetchTokenInfo("solana", MINT);
  assert.equal(info.priceUsd, 0.000025, "the indexer's live price was replaced");
  assert.equal(info.twitter, "https://x.com/curveproj", "the launchpad was never asked");
  assert.equal(info.logoUrl, "https://i.example/a.png");
});

test("a launchpad outage costs data, never the autofill", async () => {
  reset();
  serve({ "dexscreener": { pairs: [{ chainId: "solana", baseToken: { name: "Migrated", symbol: "MIG" }, priceUsd: "1", liquidity: { usd: 50000 } }] } });
  const info = await discovery.fetchTokenInfo("solana", MINT);
  assert.equal(info.name, "Migrated", "a dead launchpad took the DexScreener answer down with it");
});

// ── the market poll ──────────────────────────────────────────────────────────

test("fetchMarket falls through to the launchpad only when a number is missing", async () => {
  reset();
  let pumpCalls = 0;
  const routes = {
    geckoterminal: { data: { attributes: { price_usd: "2", market_cap_usd: "999999" }, relationships: { top_pools: { data: [{ id: "solana_pool1" }] } } }, included: [{ id: "solana_pool1", attributes: { address: "pool1", reserve_in_usd: "50000" } }] },
  };
  global.fetch = async (url) => {
    if (/pump\.fun/.test(String(url))) pumpCalls++;
    for (const [frag, res] of Object.entries(routes)) {
      if (String(url).includes(frag)) return { ok: true, status: 200, json: async () => res };
    }
    return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
  };
  const m = await marketdata.fetchMarket("solana", MINT);
  assert.equal(m.priceUsd, 2);
  // Nine background pipelines call this on timers; an indexed token must not
  // pay a launchpad round trip on every poll.
  assert.equal(pumpCalls, 0, "a fully-priced token still paid a launchpad lookup");
});

test("fetchMarket prices a token neither indexer can see", async () => {
  reset();
  serve({ "pump.fun": PUMP, "jup.ag": JUP, geckoterminal: { data: null }, dexscreener: { pairs: [] } });
  const m = await marketdata.fetchMarket("solana", MINT);
  assert.ok(m, 'a bonding token still reported "no market data"');
  assert.equal(m.mcap, 23150);
  assert.equal(m.onCurve, true);
  // A bonding token has no pool: linking to one would send a chart somewhere
  // that 404s.
  assert.equal(m.poolAddress, null);
});

test("the description comes from whichever pad minted the token", async () => {
  reset();
  serve({ "pump.fun": PUMP, "jup.ag": JUP, geckoterminal: 429 });
  const d = await marketdata.fetchTokenDescription("solana", MINT);
  assert.match(d, /has not migrated yet/);
});

// ── what the review card says ────────────────────────────────────────────────

test('"still bonding" appears only when a pad actually said so', () => {
  const { bondingLine } = require("../src/handlers/listing")._test;
  // `onCurve` is three-valued — true, false, or null for "no pad knows". A
  // token nothing happened to index must not be labelled as bonding.
  assert.equal(bondingLine({ bonding: null }), "");
  const line = bondingLine({ bonding: { progressPct: 49.6, launchpad: "pump.fun" } });
  assert.match(line, /Still bonding/);
  assert.match(line, /pump\.fun/);
  assert.match(line, /50%/, "the progress figure did not make it onto the card");
  assert.ok(line.startsWith("\n\n"), "the notice has no gap above it");
  // The placeholder sits at the END of a line that already has content, so a
  // migrated token leaves no blank line where the notice would be.
  const tpl = require("../src/templates");
  assert.match(tpl.DEFAULTS.review_card, /`\{address\}`\{bonding\}/);
});

test("a pad with no progress figure prints no percentage rather than 0%", () => {
  const { bondingLine } = require("../src/handlers/listing")._test;
  const line = bondingLine({ bonding: { progressPct: null, launchpad: null } });
  assert.match(line, /Still bonding/);
  assert.ok(!/%/.test(line), '"0%" was invented and reads as a dead launch');
});

// ── config ───────────────────────────────────────────────────────────────────

test("the kill switch reaches this bot too", async () => {
  process.env.LAUNCHPADS = "0";
  lp.reload();
  assert.equal(launchpads.covers("solana"), false);
  serve({ "pump.fun": PUMP, "jup.ag": JUP });
  assert.equal(await launchpads.fetchTokenInfo("solana", MINT), null);
});

test("both processes read ONE pad table", () => {
  // tradebot/solana.js and bot/src/marketdata.js each used to carry their own
  // idea of which pump.fun host was current. They drifted, one was left on the
  // retired host, and Solana snipe discovery was blind for days behind a green
  // health tick. The guard against a repeat is that neither file names a host.
  reset();
  const bot = fss.readFileSync(path.join(__dirname, "..", "src", "marketdata.js"), "utf8");
  assert.ok(!/pump\.fun\//.test(bot), "marketdata.js has grown its own pump.fun URL again");
  const trade = fss.readFileSync(path.join(__dirname, "..", "..", "tradebot", "solana.js"), "utf8");
  const bases = trade.slice(trade.indexOf("const PUMPFUN_BASES"), trade.indexOf("const PUMPFUN_BASES") + 200);
  assert.match(bases, /shared\/launchpads/, "tradebot/solana.js hardcodes pump.fun hosts again");
  assert.ok(lp.basesOf("pumpfun").length >= 2, "the legacy pump.fun host was dropped");
});
