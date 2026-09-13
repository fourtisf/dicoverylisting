// ⚠️ A POSITIVE, because a wiring that does nothing refuses beautifully.
// discovery.fetchTokenInfoX is where the autofill's sources are merged, and a
// new source that is imported but never reached passes every refusal test
// there is — the curveBuyPath scar, one package over. So this drives the real
// merge with the two HTTP sources answering nothing, which is the state a fresh
// bonding-curve token is actually in, and asserts the chain filled the form.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-ponsd-"));

const test = require("node:test");
const assert = require("node:assert");

const stub = (request, exports) => {
  const resolved = require.resolve(request);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

// The two HTTP sources know nothing about a token that has no pool.
stub("../src/dexscreener", {
  fetchTokenInfoX: async () => ({ info: null, ok: true, why: null }),
  fetchTokenInfo: async () => null,
  DEX_SLUG: {},
});
stub("../src/poolstrade", { OUR_CHAIN: "robinhood", fetchTokenInfo: async () => null, fetchDiscoveryX: async () => ({ items: [], ok: true, why: null }) });
stub("../src/launchpads", {
  covers: () => true,
  padsFor: () => [{ key: "pons" }],
  fetchTokenInfo: async () => null,
  fetchDescription: async () => null,
});

const LAUNCH = {
  address: "0x1bf09442710ab41d311aaf53e2fa93992d5204a4",
  symbol: "DRIP",
  name: "Drip Potato",
  logo: "ipfs://bafyabc",
  description: "A potato that drips, with a fixed supply and locked liquidity.",
  phase: "NotGraduated",
  graduated: false,
  progressPct: 12.5,
  ponsUrl: "https://ponsfamily.com/token/0x1bf09442710ab41d311aaf53e2fa93992d5204a4",
  socials: { twitter: "ponsdotfamily", telegram: null, discord: null, website: null, farcaster: null },
};

const discovery = require("../src/discovery");
const pons = require("../src/ponsChain");

test("with no indexer and no pad, the chain fills the listing form", async () => {
  pons._reset();
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/pons\?address=/, "it must ask the site's Pons reader");
    return { ok: true, status: 200, json: async () => ({ launch: LAUNCH }) };
  };
  try {
    const out = await discovery.fetchTokenInfoX("robinhood", LAUNCH.address);
    assert.ok(out.info, "the merged record must exist — this is the whole bug");
    assert.strictEqual(out.info.name, "Drip Potato");
    assert.strictEqual(out.info.symbol, "DRIP");
    assert.strictEqual(out.info.twitter, "https://x.com/ponsdotfamily");
    assert.ok(String(out.info.logoUrl).startsWith("https://"), out.info.logoUrl);
    assert.strictEqual(out.info.onCurve, true);
  } finally {
    globalThis.fetch = previous;
  }
});

// ⚠️ `ok` still follows the INDEXER. A launchpad record does not make a refusal
// into an answer on the fields the auto-lister's gates read.
test("a chain record does not make the indexer's verdict into a pass", async () => {
  pons._reset();
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ launch: LAUNCH }) });
  try {
    const out = await discovery.fetchTokenInfoX("robinhood", LAUNCH.address);
    assert.strictEqual(out.ok, true, "the stubbed indexer answered, so ok is its verdict");
    assert.strictEqual(out.info.liq, 0);
    assert.strictEqual(out.info.vol24, 0);
  } finally {
    globalThis.fetch = previous;
  }
});
