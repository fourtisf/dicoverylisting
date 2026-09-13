// GeckoTerminal paths are case-sensitive for every chain that is not hex.
//
// THE BUG THIS EXISTS FOR: the trades feed built its URL with
// `String(pool).toLowerCase()`. On Solana a pool address is base58 — "5P…" and
// "5p…" are different addresses — so every Solana group asked GT for a pool
// that does not exist, got a 404, and had its feed reported as UNAVAILABLE.
//
// That is why those groups were served volume estimates they should never have
// needed, and why, the moment the estimator was retired, they went completely
// silent while other bots on the same token kept posting. One call to
// toLowerCase, and it looked like the whole buy bot was broken on Solana.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-gtcase-"));

const test = require("node:test");
const assert = require("node:assert");
const gt = require("../src/group/gtPairs");
const trades = require("../src/group/gtTrades");

const SOL_POOL = "5PxwBpNRLo1n8kUt3yZxYrgHtNiFvKeGyrGWJjVUmVWS";
const SOL_TOKEN = "8XtRWb4uAAJFMP4QQhoYYCWR6XXb7ybcCdiqPwz9s5WS";
const EVM_POOL = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";

test("a base58 address survives the path builder untouched", () => {
  assert.strictEqual(gt.gtAddr(SOL_POOL), SOL_POOL, "Solana");
  assert.strictEqual(gt.gtAddr("EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"), "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", "TON");
  assert.strictEqual(gt.gtAddr("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"), "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "Tron");
});

test("hex is still folded — it is case-insensitive, so this costs nothing", () => {
  assert.strictEqual(gt.gtAddr(EVM_POOL), EVM_POOL.toLowerCase());
});

test("the trades feed asks GT for the pool it was actually given", async () => {
  // The assertion that would have caught the original bug: the URL, not the
  // return value. A 404 here is indistinguishable from a quiet pool at the
  // caller, which is precisely why it went unnoticed for so long.
  //
  // Stubbed at global.fetch, not at gt.gtGet: gtTrades destructures gtGet at
  // require time, so reassigning the module property would not be seen.
  const real = global.fetch;
  let seen = "";
  try {
    global.fetch = async (url) => {
      seen = String(url);
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    };
    await trades.fetchPoolBuys("solana", SOL_POOL, SOL_TOKEN, { minUsd: 0 });
  } finally {
    global.fetch = real;
  }
  assert.ok(seen.includes(`/pools/${SOL_POOL}/trades`), `case was destroyed: ${seen}`);
  assert.ok(!seen.includes(SOL_POOL.toLowerCase()), "and not the lowercased form");
});

test("no GeckoTerminal path is built with a bare toLowerCase", () => {
  // The rule, pinned at the source level: an address entering a GT path goes
  // through gtAddr or it is a bug waiting for the next non-hex chain.
  for (const f of ["gtTrades.js", "gtPairs.js"]) {
    const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", f), "utf8");
    for (const line of src.split("\n")) {
      if (!/gtGet\(`/.test(line)) continue;
      assert.ok(!/toLowerCase\(\)/.test(line), `${f}: ${line.trim()}`);
    }
  }
});
