// The bot carries a 1:1 port of the website's fmtCap, and carried its bug too.
// See src/lib/format.test.ts for the report this comes from: the board printed
// "$0" volume beside "13 txns" for a token that had traded $0.06.
//
// Two copies of one function is the shape this repo warns about everywhere, so
// the test that matters most is the LAST one: the two must agree exactly, or a
// figure reads one way on the site and another in a channel post.
const test = require("node:test");
const assert = require("node:assert");
const { fmtCap } = require("../src/helpers/format");
const fss = require("node:fs");
const path = require("node:path");

test("a real figure under a dollar is never rendered as $0", () => {
  assert.strictEqual(fmtCap(0.06), "$0.06");
  assert.strictEqual(fmtCap(0.04), "$0.04");
  assert.strictEqual(fmtCap(0.31), "$0.31");
  assert.strictEqual(fmtCap(0.004), "$0.004");
});

test("a TRUE zero still prints $0, and an unreadable value still prints —", () => {
  assert.strictEqual(fmtCap(0), "$0");
  assert.strictEqual(fmtCap(null), "—");
  assert.strictEqual(fmtCap(undefined), "—");
  assert.strictEqual(fmtCap("abc"), "—");
});

test("⚠️ no branch emits a bare '<' — this string reaches parse_mode HTML", () => {
  // A single "<" makes Telegram reject the WHOLE message, and the send is a
  // 400, which queuedSend does not retry — the post simply vanishes.
  for (const v of [0, 1e-9, 0.004, 0.06, 0.99, 1, 999, 1e6, 1e9])
    assert.ok(!String(fmtCap(v)).includes("<"), `fmtCap(${v}) = ${fmtCap(v)}`);
});

test("nothing above a dollar changed", () => {
  assert.strictEqual(fmtCap(13), "$13");
  assert.strictEqual(fmtCap(4707.61), "$4.7K");
  assert.strictEqual(fmtCap(1.5e6), "$1.50M");
  assert.strictEqual(fmtCap(2.3e9), "$2.30B");
});

test("⚠️ the two copies agree on a NON-FINITE value too", () => {
  // The one input the agreement test never tried, and the one the two copies
  // had drifted on: the bot guards `!Number.isFinite` and the website did not,
  // so a NaN printed `—` in a channel post and `$NaN` on the board. An
  // unreadable figure is a dash everywhere else in this repo.
  const web = fss.readFileSync(path.join(__dirname, "..", "..", "src", "lib", "format.ts"), "utf8");
  assert.match(web, /!Number\.isFinite\(n\)\) return "—"/, "the website copy dropped the non-finite guard");
  for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
    assert.strictEqual(fmtCap(v), "—", `fmtCap(${v})`);
  assert.strictEqual(fmtCap(null), "—");
  assert.strictEqual(fmtCap(0), "$0", "…and a REAL zero is still a fact");
});
