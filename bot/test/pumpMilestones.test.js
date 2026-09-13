// The pump-alert milestone ladder.
//
// A pump alert used to fire exactly ONCE per token, at whatever the raw gain
// happened to be on the poll that caught it — which is why a token up 282%
// announced "+282%". Not a threshold anybody picked, just the number a 30-second
// poll landed on. And a token that then ran to 10x said nothing more about it.
//
// It now announces ROUND steps — +100%, +200%, +300% … up to the ceiling — one
// alert per step. These tests pin the two things that decide whether that reads
// as information or as spam: which step a gain maps to, and which steps a single
// price move is allowed to consume.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-ms-"));

const test = require("node:test");
const assert = require("node:assert");
const { milestoneFor, stepKeys, MILESTONE_STEP } = require("../src/services/pumpChecker");
const pumpConfig = require("../src/services/pumpConfig");

const MIN = pumpConfig.DEFAULT_MIN; // 100
const MAX = pumpConfig.DEFAULT_MAX; // 2000
const ms = (pct) => milestoneFor(pct, MIN, MAX);

// ---------------------------------------------------------------- the ask
test("the number announced is always a round step, never the raw gain", () => {
  // The screenshot that started this: +282% should read as +200%.
  assert.equal(ms(282.4), 200);
  for (const pct of [137, 282.4, 599.99, 1050, 1999]) {
    const m = ms(pct);
    assert.equal(m % MILESTONE_STEP, 0, `${pct}% mapped to ${m}%, which is not a round step`);
  }
});

test("the ladder runs 100 to 2000, exactly as configured", () => {
  assert.equal(ms(100), 100, "the floor itself must announce");
  assert.equal(ms(2000), 2000, "the ceiling itself must announce");
  const reachable = [];
  for (let p = MIN; p <= MAX; p += 1) { const m = ms(p); if (m != null && !reachable.includes(m)) reachable.push(m); }
  assert.deepEqual(reachable, [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
    1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000]);
});

test("a step is only ever announced once it has actually been reached", () => {
  // Flooring, not rounding: +299% is not "+300%". Announcing a step a token has
  // not reached is the one thing that would make the number a lie.
  assert.equal(ms(299.9), 200);
  assert.equal(ms(300), 300);
  assert.equal(ms(199.9), 100);
});

test("below the floor there is no alert at all", () => {
  assert.equal(ms(0), null);
  assert.equal(ms(99.9), null);
  assert.equal(ms(-50), null, "a token DOWN from its baseline never alerts");
});

// ---------------------------------------------------------------- anti-spam
test("a token that jumps several steps at once announces ONE of them", () => {
  // 90% straight to 450% between two polls is one price move. Four alerts in one
  // second for one move is spam, so the skipped steps are consumed, not posted.
  const key = "bsc:0xabc";
  const consumed = stepKeys(key, ms(450), MIN, MAX);
  assert.deepEqual(consumed, [`${key}@100`, `${key}@200`, `${key}@300`, `${key}@400`]);
  // …and the step it announced is among them, so it can never repeat.
  assert.ok(consumed.includes(`${key}@400`));
});

test("consuming a step never consumes one above it — the climb continues", () => {
  // The whole point of the ladder: after announcing +400%, the token must still
  // be able to announce +500%.
  const key = "bsc:0xabc";
  const consumed = stepKeys(key, 400, MIN, MAX);
  for (const higher of [500, 900, 2000]) {
    assert.ok(!consumed.includes(`${key}@${higher}`), `+${higher}% was wrongly consumed at +400%`);
  }
});

test("latch keys are per token AND per step", () => {
  // Two tokens at the same step, and one token at two steps, must never collide.
  assert.notDeepEqual(stepKeys("bsc:0xaaa", 200, MIN, MAX), stepKeys("bsc:0xbbb", 200, MIN, MAX));
  assert.deepEqual(stepKeys("bsc:0xaaa", 100, MIN, MAX), ["bsc:0xaaa@100"]);
  assert.deepEqual(stepKeys("bsc:0xaaa", 200, MIN, MAX), ["bsc:0xaaa@100", "bsc:0xaaa@200"]);
});

// ---------------------------------------------------------------- admin window
test("a raised floor moves the ladder with it", () => {
  // The window is admin-configurable from @dexvraadminbot. If the operator sets
  // a 500% floor, nothing below 500% may announce — including step 400.
  assert.equal(milestoneFor(480, 500, 2000), null, "480% announced despite a 500% floor");
  assert.equal(milestoneFor(560, 500, 2000), 500);
  assert.deepEqual(stepKeys("k", 700, 500, 2000), ["k@500", "k@600", "k@700"]);
});

test("a lowered ceiling caps the ladder", () => {
  assert.equal(milestoneFor(640, 100, 600), 600, "600 is the last reachable step");
  assert.deepEqual(stepKeys("k", 600, 100, 600), ["k@100", "k@200", "k@300", "k@400", "k@500", "k@600"]);
});

test("a floor that is not a round step still yields round steps", () => {
  // An operator can type 150. The steps stay on the 100 grid; the first one that
  // clears the floor is 200.
  assert.equal(milestoneFor(180, 150, 2000), null, "100 is below the operator's floor");
  assert.equal(milestoneFor(210, 150, 2000), 200);
  assert.deepEqual(stepKeys("k", 300, 150, 2000), ["k@200", "k@300"]);
});

// ---------------------------------------------------------------- the card
test("the text card's multiple lands on a whole number, because it comes from the step", () => {
  // The default post_pump template leads with the multiple: "🚀 3.8× since
  // listing" in the screenshot that started this. A round step makes it a round
  // multiple — +200% is 3×, and never 3.8×.
  const fmt = require("../src/channels/format");
  const coin = { name: "Spy", symbol: "SPYB", chain: "bsc", address: "0x" + "a".repeat(40),
    tier: "diamond", price: 0.00816, mcap: 8_200_000, links: {}, siteUrl: "https://dexvra.io/x" };
  for (const [step, mult] of [[100, "2×"], [200, "3×"], [900, "10×"], [2000, "21×"]]) {
    const { text } = fmt.pumpPost(coin, step, 2_100_000, 8_200_000);
    assert.ok(text.includes(mult), `+${step}% should read as ${mult}, card was:\n${text}`);
    assert.ok(!/\d\.\d×/.test(text), `a step must never produce a fractional multiple:\n${text}`);
  }
  // The raw gain is exactly what used to produce the fractional one.
  assert.match(fmt.pumpPost(coin, 282.4, 2_100_000, 8_200_000).text, /3\.8×/);
});

test("the banner overlay carries the step too, not the raw gain", () => {
  // "+282%" in the screenshot came from the IMAGE overlay, not the text card —
  // pumpMedia composites `change: +N%` onto the admin's clip. Routing the step
  // to the card while leaving the picture on the raw gain would put two
  // different numbers in one alert.
  const src = fss.readFileSync(require.resolve("../src/services/pumpChecker.js"), "utf8");
  assert.match(src, /pumpMedia\(r, base, m, milestone\)/, "the overlay still gets the raw percentage");
  assert.match(src, /fmt\.pumpPost\(coin, milestone,/, "the text card still gets the raw percentage");
  assert.match(src, /x\.postPump\(coin, milestone,/, "the tweet still gets the raw percentage");
});

// ---------------------------------------------------------------- deploy safety
test("a pre-ladder token is retired on the very next poll, whatever step it sits on", async () => {
  // THE SECOND BUG, and the reason this test drives behaviour instead of grepping
  // source. The step latch used to be checked BEFORE the legacy marker. A token
  // whose CURRENT step was already consumed therefore answered "skip" on every
  // poll, so the marker survived — and it only came up again once the token
  // reached a NEW step, which the retire branch then ate as well (retiring never
  // posts). $SPYB sat at +300% with @300 already consumed and its marker intact,
  // so nothing moved for six minutes and +400% would have been swallowed too.
  const { DedupSet } = require("../src/helpers/persist");
  const { decide, absorbLegacy } = require("../src/services/pumpChecker");
  const latch = new DedupSet(`pumplatch-order-${process.pid}.json`);
  const key = "bsc:0xspyb";

  // Exactly the production state: legacy marker + steps already consumed.
  await latch.add(key);
  await latch.addAll([`${key}@100`, `${key}@200`, `${key}@300`]);

  // Standing at +300%, whose step key it already holds.
  assert.equal(decide(latch, key, 300), "retire", "the token would stall instead of retiring");

  await absorbLegacy(latch, key, 300, MIN, MAX);
  assert.ok(!latch.has(key), "the legacy marker survived retirement");

  // From here on it behaves like any other token: the step it stands on is done,
  // and the NEXT step posts rather than being absorbed.
  assert.equal(decide(latch, key, 300), "skip");
  assert.equal(decide(latch, key, 400), "post", "+400% would have been swallowed too");
});

test("the three outcomes are decided in the right order", async () => {
  const { DedupSet } = require("../src/helpers/persist");
  const { decide } = require("../src/services/pumpChecker");
  const latch = new DedupSet(`pumplatch-decide-${process.pid}.json`);

  assert.equal(decide(latch, "k:new", 100), "post", "a fresh token must announce");

  await latch.add("k:done@200");
  assert.equal(decide(latch, "k:done", 200), "skip", "an announced step must not repeat");
  assert.equal(decide(latch, "k:done", 300), "post", "the next step must still announce");

  // The legacy marker OUTRANKS the step latch — that is the whole ordering fix.
  await latch.add("k:old");
  await latch.add("k:old@200");
  assert.equal(decide(latch, "k:old", 200), "retire", "the legacy marker must win over the step latch");
});

test("retiring never posts, and posting never retires", async () => {
  // The two silent-failure modes, stated as one property: a token is retired at
  // most once, and after that every decision is either skip or post.
  const { DedupSet } = require("../src/helpers/persist");
  const { decide, absorbLegacy } = require("../src/services/pumpChecker");
  const latch = new DedupSet(`pumplatch-once-${process.pid}.json`);
  const key = "bsc:0xonce";
  await latch.add(key);

  const seen = [];
  for (const step of [200, 300, 400, 500]) {
    const a = decide(latch, key, step);
    seen.push(a);
    if (a === "retire") await absorbLegacy(latch, key, step, MIN, MAX);
  }
  assert.deepEqual(seen, ["retire", "post", "post", "post"],
    "a token must retire exactly once and announce every step after it");
});
