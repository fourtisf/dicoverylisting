// Which chains the trending board may use.
//
// "yang untuk di show trending chain sol bsc eth robinhood base dan tron" —
// Tron was missing from the shipped list entirely, so it could never reach the
// board however many tokens were listed on it, and from the channel that is
// indistinguishable from a chain with nothing worth trending.
const test = require("node:test");
const assert = require("node:assert");
const fss = require("node:fs");
const path = require("node:path");
const autoTrend = require("../src/services/autoTrend");
const { chainOf } = require("../src/config/chains");

const WANTED = ["solana", "bsc", "ethereum", "base", "robinhood", "tron"];

test("all six named chains are on the shipped list, and every one is real", () => {
  const chains = autoTrend.get().chains || [];
  for (const c of WANTED) {
    assert.ok(chains.includes(c), `${c} cannot reach the board`);
    // A typo here is silent: `filterChains` drops an unknown id, so the list
    // would simply be shorter than it reads.
    assert.ok(chainOf(c), `${c} is not a chain this site supports`);
  }
});

test("⚠️ a STORED list beats the shipped one — the script is the only way to see that", () => {
  // Mongoose-shaped trap, third time in this project: `set()` persists
  // `chains`, so a box where ⚙️ Auto-Trend has ever been touched keeps its own
  // list and a code change reaches it never. That reads exactly like a failed
  // deploy from Telegram.
  const src = fss.readFileSync(require.resolve("../src/services/autoTrend.js"), "utf8");
  assert.match(src, /A STORED VALUE BEATS THIS/, "the trap must be named where the default lives");

  const script = path.join(__dirname, "..", "scripts", "trending-chains.js");
  assert.ok(fss.existsSync(script), "there must be a way to read the LIVE value");
  const s = fss.readFileSync(script, "utf8");
  assert.match(s, /autoTrend\.get\(\)/, "it must read the live value, not re-derive it");
  assert.match(s, /--apply/, "and writing must be deliberate");
  // A ✅ over a write that did not take is the exact defect this script exists
  // to expose; it may not reproduce it.
  assert.match(s, /NOT saved/, "the write must be read back and reported honestly");
});

test("the seeder's --trending reads the LIVE chain list, never a second copy", () => {
  // Two lists would drift, and the seeder would fill chains the board cannot
  // promote — which is what `--all` did: TON and Arbitrum gained 15 and 14
  // while BSC gained five.
  const s = fss.readFileSync(path.join(__dirname, "..", "scripts", "seed-chain.js"), "utf8");
  assert.match(s, /flags\.includes\('--trending'\)/);
  assert.match(s, /autoTrend\.get\(\)\.chains/);
});

test("an empty list is the OFF switch and must be typed, never arrived at", () => {
  const s = fss.readFileSync(path.join(__dirname, "..", "scripts", "trending-chains.js"), "utf8");
  assert.match(s, /turn auto-trending OFF entirely/, "a trailing comma must not silently disable the feature");
});
