// Which warnings are worth interrupting the operator for.
//
// The log channel carried these, as ⚠️, next to failed sweeps and missing keys:
//
//   ⚠️ [market] GT solana/89RA…pump: ignoring absurd 24h change 10317.77%
//      (pool data is broken)
//   ⚠️ [autotrend] board below target on ethereum — list more tokens…
//   ⚠️ [x] Crypto addresses are prohibited for the first 7 days…
//
// Every one of them describes the bot meeting a condition and handling it
// correctly by itself. The rejected pool data was already rejected; the X rule
// expires on its own and the tweet already went out without the contract line;
// the board is short because the market is short.
//
// The cost is not the volume. It is that a channel where most ⚠️ needs no
// action trains its reader to skim the ones that do — and a failed sweep is a
// wallet with somebody's money still in it.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-noise-"));

const test = require("node:test");
const assert = require("node:assert");
const log = require("../src/helpers/logger");

/** Capture what the logger would send to Telegram. */
function channel(fn, { verbose = false } = {}) {
  const sent = [];
  const bot = { telegram: { sendMessage: async (to, body) => { sent.push(body); } } };
  const prevVerbose = process.env.OPS_VERBOSE;
  if (verbose) process.env.OPS_VERBOSE = "1"; else delete process.env.OPS_VERBOSE;
  const realErr = console.error, realLog = console.log;
  console.error = () => {}; console.log = () => {};
  try {
    log.attach(bot, "-100999", "-100999");
    fn();
  } finally {
    console.error = realErr; console.log = realLog;
    if (prevVerbose === undefined) delete process.env.OPS_VERBOSE; else process.env.OPS_VERBOSE = prevVerbose;
  }
  return sent;
}

test("a warning the operator cannot act on never reaches the channel", async () => {
  const sent = channel(() => log.noise(`[market] GT solana/89RA${Date.now()}: ignoring absurd 24h change 10317.77% (pool data is broken)`));
  assert.deepEqual(sent, [], `an unactionable warning was sent: ${sent[0]}`);
});

test("…but it is still in the console, so pm2 logs keep it", async () => {
  const lines = [];
  const realErr = console.error;
  console.error = (l) => lines.push(String(l));
  try { log.noise("[market] something the bot already handled"); }
  finally { console.error = realErr; }
  assert.ok(lines.some((l) => /WARN .*already handled/.test(l)), "the line vanished entirely — that is not the goal");
});

test("a warning that DOES need action still reaches the channel", async () => {
  // The whole point of muting the others.
  const sent = channel(() => log.warn(`[wallets] no treasury for base — sweep skipped, funds remain in 0xabc${Date.now()}`));
  assert.equal(sent.length, 1, "a real problem was muted along with the noise");
  assert.match(sent[0], /sweep skipped/);
});

test("OPS_VERBOSE=1 puts the muted lines back, for when you are chasing something", async () => {
  // Nothing is deleted; it is reclassified. A switch matters because the day you
  // need these is the day something is behaving oddly.
  const sent = channel(() => log.noise(`[market] pool data is broken ${Date.now()}`), { verbose: true });
  assert.equal(sent.length, 1, "OPS_VERBOSE did not restore the muted warnings");
});

test("the three the operator complained about are all reclassified", async () => {
  const src = (f) => fss.readFileSync(require.resolve(f), "utf8");
  assert.match(src("../src/marketdata.js"), /log\.noise\(`\[market\] GT \$\{chain\}\/\$\{address\}: ignoring absurd/,
    "the broken-pool warning still pages the operator");
  assert.match(src("../src/services/autoTrend.js"), /log\.noise\(line\)/,
    "the autotrend board advice still pages the operator");
  assert.match(src("../src/twitter.js"), /log\.noise\(`\[x\] \$\{c\.message\}`\)/,
    "X's new-app rule still pages the operator");
});

test("nothing about money, keys or sweeps was quietened", async () => {
  // The line between the two classes: if a human has to go and do something,
  // it stays a warn. Reclassifying one of these would be the actual damage.
  const files = ["../src/services/fulfil.js", "../src/services/sweepRetry.js", "../src/wallets.js"];
  for (const f of files) {
    let src = "";
    try { src = fss.readFileSync(require.resolve(f), "utf8"); } catch (_) { continue; }
    assert.ok(!/log\.noise\(/.test(src), `${f} muted a warning about funds`);
  }
});

test("the pump alert itself is untouched — it is the product, not a warning", async () => {
  // "📈 Pump: $TIKTOK +100% since listing" sat in the same screenshot. It is
  // what the channel exists for.
  const src = fss.readFileSync(require.resolve("../src/services/pumpChecker.js"), "utf8");
  assert.ok(!/log\.noise\(.*Pump:/.test(src), "the pump alert was muted along with the noise");
});
