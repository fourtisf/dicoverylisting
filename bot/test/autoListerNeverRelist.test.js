// "free listing bot tidak boleh free listing otomatis token yang sudah listing
// sebelumnya."
//
// The auto-lister already skipped two things: its own past picks
// (`state.listed`) and whatever is on the site right now (`getListings()`).
// Both have a hole, and it is the same hole: DELETE the listing and the token
// is a fresh candidate again. So a project that PAID for a listing, whose row
// was later removed, gets handed the same token back as a FREE auto listing.
//
// The fix is a permanent ledger of every contract that has ever been on the
// site, folded in at the top of each scan and written directly by the paid
// path. Only the operator's explicit "🧹 Clear history" may wipe it.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-relist-"));

const test = require("node:test");
const assert = require("node:assert");

const autoLister = require("../src/services/autoLister");
const api = require("../src/api/dexvra");

const read = (p) => fss.readFileSync(require.resolve(`../src/${p}`), "utf8");
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const CA = "0xe934e36A439C94017B64a3FecE66AF12099aBF50";
const CHAIN = "base";

/** A token that passes every quality gate, so the ONLY thing that can stop it
 *  being listed is the never-re-list rule under test. */
const GOOD = {
  name: "Hoppy",
  symbol: "HOPPY",
  mcap: 40_000_000, // way past any per-token trigger in the band
  liq: 5_000_000,
  vol24: 5_000_000,
  pairCreatedAt: 0, // ancient
};

/** Run one scan against a fixed candidate and a controllable site. */
function scan({ siteRows = [], created = [] } = {}) {
  api.getListings = async () => siteRows;
  api.createListing = async (input) => {
    created.push(input);
    return { id: `l_${created.length}`, ...input };
  };
  return autoLister.runOnce({
    now: Date.now(),
    deps: {
      fetchDiscovery: async () => [{ chain: CHAIN, address: CA }],
      fetchTokenInfo: async () => GOOD,
    },
  });
}

test.beforeEach(async () => {
  await autoLister.reset();
  await autoLister.resetState();
  await autoLister.set({
    enabled: true,
    minMcap: 1_000_000,
    maxMcap: 1_500_000,
    maxMcapHard: 1_000_000_000,
    minLiq: 0,
    minVol24: 0,
    minAgeHours: 0,
    postChannel: false,
  });
});

test("the setup really does list an unknown token — otherwise nothing below proves anything", async () => {
  const created = [];
  assert.strictEqual(await scan({ siteRows: [], created }), 1);
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].address, CA);
});

test("a token listed before and SINCE DELETED is never listed again", async () => {
  // The whole bug. Scan 1 sees it on the site and remembers it; the row is then
  // deleted, so scan 2's `known` set is empty — and it used to sail through.
  await scan({ siteRows: [{ chain: CHAIN, address: CA, sym: "HOPPY" }] });
  const created = [];
  assert.strictEqual(await scan({ siteRows: [], created }), 0, "it came back as a free listing");
  assert.strictEqual(created.length, 0);
});

test("a PAID listing is remembered the moment it goes live, not at the next scan", async () => {
  // A token bought and deleted before the next scan would never reach the
  // ledger through the scan-time fold alone.
  await autoLister.rememberListed([{ chain: CHAIN, address: CA }]);
  const created = [];
  assert.strictEqual(await scan({ siteRows: [], created }), 0);
  assert.match(code("fulfillment.js"), /rememberListed\(\[\{ chain: input\.chain, address: input\.address \}\]\)/,
    "the paid path must write to the ledger itself");
});

test("a ledger write can never fail a paid order", () => {
  const fn = code("fulfillment.js");
  const i = fn.indexOf("rememberListed([{ chain: input.chain");
  const around = fn.slice(i - 200, i + 300);
  assert.match(around, /try \{/, "wrapped");
  assert.match(around, /catch \(e\) \{/);
  assert.match(around, /log\.warn\(`\[fulfil\] ledger note/);
});

test("the ledger survives a restart", async () => {
  await scan({ siteRows: [{ chain: CHAIN, address: CA }] });
  delete require.cache[require.resolve("../src/services/autoLister")];
  const fresh = require("../src/services/autoLister");
  assert.strictEqual(fresh.stats().everListed, 1, "it is on disk, not in a Map");
});

test("the address is matched case-insensitively, per chain", async () => {
  await autoLister.rememberListed([{ chain: CHAIN, address: CA.toLowerCase() }]);
  const created = [];
  assert.strictEqual(await scan({ siteRows: [], created }), 0, "checksum vs lowercase is one contract");

  // …but the same address on ANOTHER chain is a different token, and must not
  // be blocked by this.
  await autoLister.resetState();
  await autoLister.rememberListed([{ chain: "bsc", address: CA }]);
  assert.strictEqual(await scan({ siteRows: [], created: [] }), 1);
});

test("only the operator's explicit Clear history re-opens it", async () => {
  await autoLister.rememberListed([{ chain: CHAIN, address: CA }]);
  assert.strictEqual(await scan({ siteRows: [] }), 0);
  await autoLister.resetState();
  assert.strictEqual(await scan({ siteRows: [] }), 1, "the escape hatch still works");

  const admin = code("admin/adminBot.js");
  assert.strictEqual((admin.match(/autoLister\.resetState\(\)/g) || []).length, 1,
    "exactly one caller — nothing else may wipe the ledger");
  assert.match(admin, /previously listed tokens can be auto-listed again/,
    "and the confirmation says what it really does");
});

test("a scan that cannot read the site lists nothing at all", async () => {
  // Guessing here would double-list a paying customer's token.
  api.getListings = async () => { throw new Error("site down"); };
  const created = [];
  api.createListing = async (i) => { created.push(i); return { id: "x" }; };
  const n = await autoLister.runOnce({
    deps: { fetchDiscovery: async () => [{ chain: CHAIN, address: CA }], fetchTokenInfo: async () => GOOD },
  });
  assert.strictEqual(n, 0);
  assert.strictEqual(created.length, 0);
});

test("the skip is checked before any of the work, and names all three reasons", () => {
  const src = code("services/autoLister.js");
  // All three reasons in ONE condition: dropping any of them re-opens a hole
  // (state.listed forgets nothing this service did; known covers the live site;
  // everListed is the only one that survives a row being deleted).
  assert.match(src, /if \(state\.listed\[key\] \|\| known\.has\(key\) \|\| state\.everListed\[key\]\) \{/);
  const i = src.indexOf("state.everListed[key])");
  assert.ok(i > 0 && i < src.indexOf("lookups++"), "before the market-data lookup it would otherwise pay for");
  // …and before the rejection memo, which is a cost optimisation and must never
  // be what decides whether a paid contract can be handed out for free.
  assert.ok(i < src.indexOf("state.cool[key] > now"), "the never-relist rule must outrank the cool-off");
});

test("the panel tells the operator the rule is on", () => {
  const admin = code("admin/adminBot.js");
  assert.match(admin, /Never re-listed:<\/b> \$\{s\.everListed\}/);
  assert.ok(autoLister.stats().everListed >= 0, "stats exposes the count it renders");
});
