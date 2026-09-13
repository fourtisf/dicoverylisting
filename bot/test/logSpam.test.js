// The log channel filled with the same warning every three minutes:
//   ⚠️ [market] GT bsc/0x71451a…: ignoring absurd 24h change 39594.71%
// The guard was right — the pool really is broken — but the condition is
// permanent and the check runs on a polling loop, so it complained forever and
// buried every real alert underneath.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-logspam-"));

const test = require("node:test");
const assert = require("node:assert");
const log = require("../src/helpers/logger");

// A fake bot that records what the log channel would receive.
function attachRecorder() {
  const sent = [];
  log._resetDedupe();
  log.attach({ telegram: { sendMessage: async (_c, text) => sent.push(text) } }, "@logs");
  return sent;
}

test("a warning that repeats with drifting numbers is sent once, not once per poll", () => {
  const sent = attachRecorder();
  // The exact percentages differ every poll — which is precisely why plain
  // string matching would not have caught this.
  for (const pct of [39594.71, 39393.73, 36939.24, 34298.19, 33758.24, 34265.85]) {
    log.warn(`[market] GT bsc/0x71451a88dF975ea74a686448AE0aAfCe9128a68c: ignoring absurd 24h change ${pct}% (pool data is broken)`);
  }
  assert.strictEqual(sent.length, 1, `six polls must produce one channel message, got:\n${sent.join("\n")}`);
  assert.match(sent[0], /39594\.71/, "and it is the FIRST one, with a real reading");
});

test("two different tokens are two different problems", () => {
  // Collapsing numbers must not collapse addresses — otherwise one broken pool
  // silences the report of every other one.
  const sent = attachRecorder();
  log.warn("[market] GT bsc/0x71451a88dF975ea74a686448AE0aAfCe9128a68c: ignoring absurd 24h change 39594.71%");
  log.warn("[market] GT bsc/0x9999999999999999999999999999999999999999: ignoring absurd 24h change 12345.00%");
  assert.strictEqual(sent.length, 2, "each address reports on its own");
});

test("unrelated warnings are never swallowed by a noisy one", () => {
  const sent = attachRecorder();
  log.warn("[market] GT bsc/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: ignoring absurd 24h change 1.00%");
  log.warn("[wallets] sweep solana failed: Simulation failed");
  log.error("[pay] confirm/fulfil failed order=abc123");
  assert.strictEqual(sent.length, 3);
});

test("nothing is lost — the fold count is reported when the window reopens", (t) => {
  // Suppressed is not deleted. The next send says how many were folded in, so
  // "this happened 40 times" is still visible.
  const sent = attachRecorder();
  const realNow = Date.now;
  let clock = realNow();
  t.after(() => (Date.now = realNow));
  Date.now = () => clock;
  log.warn("[market] pool broken for 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb change 100%");
  for (let i = 0; i < 40; i++) log.warn(`[market] pool broken for 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb change ${i}%`);
  assert.strictEqual(sent.length, 1, "all folded into the first");
  clock += 16 * 60 * 1000; // past the window
  log.warn("[market] pool broken for 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb change 999%");
  assert.strictEqual(sent.length, 2);
  assert.match(sent[1], /\+40 more like this/, `the count must survive: ${sent[1]}`);
});

test("a condition that PERSISTS pages less and less — the window widens", (t) => {
  // A GeckoTerminal rate limit that held for nine hours paged every fifteen
  // minutes, all day — thirty-odd copies of a message whose content never
  // changed. The window doubles (15m → 30m → 60m → 2h cap) while the same key
  // keeps folding, and one quiet window resets the ladder.
  const sent = attachRecorder();
  const realNow = Date.now;
  let clock = realNow();
  t.after(() => (Date.now = realNow));
  Date.now = () => clock;
  const nag = () => log.warn("[buybot] GeckoTerminal backing off for 120s — HTTP 429 (rate limited)");
  nag();
  assert.strictEqual(sent.length, 1);
  for (let i = 0; i < 5; i++) {
    clock += 3 * 60 * 1000;
    nag(); // all inside the first 15m window — folded
  }
  clock += 60 * 1000; // 16m after the first send: window closed WITH folds
  nag();
  assert.strictEqual(sent.length, 2, "the reopen sends, and widens the window");
  clock += 16 * 60 * 1000; // 16m later — would have sent under a fixed 15m window
  nag();
  assert.strictEqual(sent.length, 2, "…but the widened 30m window still holds it");
  clock += 15 * 60 * 1000; // 31m after send #2
  nag();
  assert.strictEqual(sent.length, 3, "the 30m window reopens");
  clock += 61 * 60 * 1000; // a QUIET hour — the condition cleared
  nag();
  assert.strictEqual(sent.length, 4, "a fresh hit after quiet pages promptly");
  clock += 16 * 60 * 1000;
  nag();
  assert.strictEqual(sent.length, 5, "and the ladder is back at 15m, not stuck wide");
});

test("purchase reports are never de-duplicated", () => {
  // Two identical-looking purchase lines are two real sales. Folding them would
  // hide revenue, which is a far worse failure than a noisy channel.
  const sent = attachRecorder();
  const card = "💸 <b>Service Purchased</b>\n<b>Amount:</b> 1 SOL";
  log.report(card);
  log.report(card);
  assert.strictEqual(sent.length, 2);
});

test("the market guard also quiets itself at the source", () => {
  // Belt and braces: the logger dedupe protects the channel, but the console
  // (pm2 logs) would still scroll past a line every three minutes forever.
  const src = fss.readFileSync(require.resolve("../src/marketdata.js"), "utf8");
  assert.match(src, /noteBrokenPool\(chain, address\)/, "the warn is gated");
  assert.match(src, /BROKEN_POOL_QUIET_MS = 60 \* 60 \* 1000/, "one complaint per token per hour");
  // The rejection itself must NOT become conditional — a broken number must
  // never reach the board just because we already complained about it.
  const i = src.indexOf("if (noteBrokenPool(chain, address))"); // the CALL, not the definition
  assert.ok(i > -1, "the gate must wrap only the log line");
  assert.match(src.slice(i, i + 400), /change24h = null;/, "the value is still discarded every time");
});

test("errors can be routed away from the visitor feed", () => {
  // The visitor channel is a business feed — every /start, every purchase — and
  // crash traces mixed into it bury the thing it exists to show. Splitting them
  // is one env var; unset, nothing changes.
  const errors = [];
  const feed = [];
  log._resetDedupe();
  log.attach(
    { telegram: { sendMessage: async (chat, text) => (chat === "@errors" ? errors : feed).push(text) } },
    "@visitors",
    "@errors",
  );
  log.report("💸 <b>Service Purchased</b>");
  log.warn("[market] pool broken 0xabcdefabcdef");
  log.error("[pay] fulfil failed order=xyz");
  assert.deepStrictEqual(feed.length, 1, "the purchase stays in the visitor feed");
  assert.strictEqual(errors.length, 2, "the warn and the error go elsewhere");
  assert.match(feed[0], /Service Purchased/);
});

test("with no second channel set, everything lands where it always did", () => {
  const all = [];
  log._resetDedupe();
  log.attach({ telegram: { sendMessage: async (_c, text) => all.push(text) } }, "@visitors");
  log.report("💸 purchase");
  log.warn("[market] something 0xabcdefabcdef");
  assert.strictEqual(all.length, 2, "unset ERROR_CHANNEL must change nothing");
});

test("the split is wired from config, not left as a helper nobody calls", () => {
  const bot = fss.readFileSync(require.resolve("../src/bot.js"), "utf8");
  assert.match(bot, /log\.attach\(bot, LOG_CHANNEL, ERROR_CHANNEL\)/);
  const consts = fss.readFileSync(require.resolve("../src/config/constants.js"), "utf8");
  assert.match(consts, /const ERROR_CHANNEL = env\.ERROR_CHANNEL \|\| LOG_CHANNEL;/, "defaults to the same channel");
});
