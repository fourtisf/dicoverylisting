// One rate limiter for every GeckoTerminal request in the process.
//
// THE FAILURE THIS EXISTS FOR: the free tier is ~30 req/min for the whole IP,
// and the bot discovered that ceiling the only way it could — by being punished.
// A 429 arms a 120-second PROCESS-WIDE cooldown during which no group gets a
// buy alert at all. Meanwhile nine background pipelines priced tokens through
// marketdata.js, which reached GeckoTerminal with its own fetch and so was
// invisible to both the cooldown and any budget. Jobs nobody watches in real
// time were spending the quota, and the buy bot took the punishment.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-gtrl-"));
process.env.GT_MAX_RPM = "600"; // overrides the runner default on purpose // 100ms apart — fast enough to test, still paced

const test = require("node:test");
const assert = require("node:assert");
const gt = require("../src/group/gtPairs");

test("requests are paced instead of fired all at once", async () => {
  // Pacing is strictly better than backing off: one request too many costs two
  // minutes of silence for every group, delaying it costs nobody anything.
  const t0 = Date.now();
  await Promise.all([gt.gtSlot(), gt.gtSlot(), gt.gtSlot()]);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 150, `three slots should span at least two gaps, took ${elapsed}ms`);
});

test("the buy bot's feed jumps the queue ahead of background work", async () => {
  // Priority matters as much as the pacing: the trades feed is the only GT read
  // whose lateness a group actually sees.
  const order = [];
  const bg = [];
  for (let i = 0; i < 5; i++) bg.push(gt.gtSlot(gt.PRIO_BACKGROUND).then(() => order.push("bg")));
  // Queued LAST, and behind five background requests.
  const realtime = gt.gtSlot(gt.PRIO_REALTIME).then(() => order.push("rt"));
  await Promise.all([...bg, realtime]);
  assert.ok(order.indexOf("rt") <= 1, `realtime should go near-first, got ${order.join(",")}`);
});

test("a saturated queue is refused, not queued forever", async () => {
  // An unbounded queue turns a rate limit into a memory leak, and a buy alert
  // that arrives ten minutes late is not a buy alert.
  const held = [];
  for (let i = 0; i < 250; i++) held.push(gt.gtSlot(gt.PRIO_BACKGROUND).catch(() => "refused"));
  const results = await Promise.all(held);
  assert.ok(results.includes("refused"), "the queue has a ceiling");
});

test("the background client goes through the same gate as the buy bot", () => {
  // marketdata.js used to call GeckoTerminal with a bare fetch, so its requests
  // counted against nothing and ignored the cooldown entirely.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "marketdata.js"), "utf8");
  assert.match(src, /gtGate\.gtSlot/, "it waits for a slot");
  assert.match(src, /gtGate\.inCooldown/, "and honours the shared cooldown");
  // Every GT fetch in the file must sit behind a gtTurn() check. Counted over
  // CODE ONLY: the comment explaining why the second gate is a condition rather
  // than an early return contains the call too, and a test that trips over its
  // own explanation is one nobody trusts the next time it goes red.
  const code = src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  const gtFetches = (code.match(/fetch\(`\$\{GT\}/g) || []).length;
  const gates = (code.match(/await gtTurn\(\)/g) || []).length;
  assert.ok(gtFetches > 0, "there are GT fetches to gate");
  assert.strictEqual(gates, gtFetches, `${gtFetches} GT fetches but ${gates} gates`);
});

test("a rate-limited GT still lets a token fall through to its launchpad", () => {
  // The gate must not become an early return: that would make every description
  // on Solana vanish for the length of a cooldown, replacing a rate limit with
  // a data outage.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "marketdata.js"), "utf8");
  const fn = src.slice(src.indexOf("async function fetchTokenDescription"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /if \(net && \(await gtTurn\(\)\)\)/, "gated as a condition, not a return");
  assert.match(body, /fetchLaunchpadDescription/, "and the fallback is still reachable");
  // Not `chain === "solana"` any more: four.meme on BNB Chain and Virtuals on
  // Base have the identical gap, and a hardcoded chain meant they could never
  // be asked.
  assert.match(body, /launchpads\.covers\(chain\)/, "the fallback is gated on coverage, not on one chain name");
});
