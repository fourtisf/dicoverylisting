// The ops channel got three store archives and three identical "Trade Bot
// online" cards inside a few minutes — one set per pm2 restart, and a deploy
// afternoon is a dozen restarts. Neither message is wrong; both were simply
// unconditional at boot, so the process lifecycle set their frequency instead
// of the operator. Requirement: at most once a day, restarts included.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Point the store at a scratch dir BEFORE core.js is loaded — it resolves
// CFG.dataDir at module load and would otherwise write into the real data/.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-opsthrottle-"));

const test = require("node:test");
const assert = require("node:assert");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
/** Source minus comments — the comments here quote the old behaviour on
 *  purpose, so "does the boot path still call X" has to ignore them. */
const code = (f) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

let coreOk = true;
let core = null;
try {
  core = require("./core");
} catch {
  coreOk = false;
}

const DAY = 24 * 3600 * 1000;

test("a restart does not make something 'due' again", (t) => {
  if (!coreOk) return t.skip("deps not installed in this checkout");
  const realNow = Date.now;
  t.after(() => (Date.now = realNow));
  let clock = realNow();
  Date.now = () => clock;

  const key = "test_boot_" + clock;
  assert.strictEqual(core.opsDue(key, DAY), true, "never done → due");
  core.markOps(key);
  assert.strictEqual(core.opsDue(key, DAY), false, "just done → not due");

  // Simulate the deploy afternoon: restart after restart, minutes apart.
  for (let i = 0; i < 12; i++) {
    clock += 3 * 60 * 1000;
    assert.strictEqual(core.opsDue(key, DAY), false, `restart ${i + 1} must stay quiet`);
  }
  clock += DAY;
  assert.strictEqual(core.opsDue(key, DAY), true, "a day later it is due again");
});

test("the mark is on disk, not in memory — that is the whole point", (t) => {
  if (!coreOk) return t.skip("deps not installed in this checkout");
  const key = "test_persist";
  core.markOps(key);
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, "tradebot.json"), "utf8"));
  assert.ok(Number(onDisk.ops[key]) > 0, `ops marks must survive the process: ${JSON.stringify(onDisk.ops)}`);
  // …and come back after a reload, which is exactly what a restart does.
  core.loadStore();
  assert.strictEqual(core.opsDue(key, DAY), false, "reloaded state still remembers");
});

test("markOps writes through — a crash right after must not undo it", () => {
  // saveStore() is debounced by 600ms. A bot that marks, posts, and is killed
  // during a deploy would lose the mark and re-post on the next boot: the exact
  // failure this replaces.
  const src = code("core.js");
  const fn = src.slice(src.indexOf("function markOps("));
  assert.match(fn.slice(0, fn.indexOf("\n")), /saveStoreNow\(\)/, "markOps must not use the debounced write");
});

test("independent marks do not shadow each other", (t) => {
  if (!coreOk) return t.skip("deps not installed in this checkout");
  core.markOps("test_a");
  assert.strictEqual(core.opsDue("test_a", DAY), false);
  assert.strictEqual(core.opsDue("test_b", DAY), true, "the backup and the boot card are separate schedules");
});

test("the boot announcement asks first", () => {
  const tgSrc = code("telegram.js");
  const i = tgSrc.indexOf("Dexvra Trade Bot online");
  assert.ok(i > -1, "the card still exists — this is about frequency, not removal");
  const before = tgSrc.slice(Math.max(0, i - 400), i);
  assert.match(before, /core\.opsDue\('boot_announce', DAY_MS\)/, "posted only when a day has passed");
  assert.match(before, /core\.markOps\('boot_announce'\)/);
  // Marked BEFORE the send: a crash-loop restarting every few seconds must not
  // fire a burst while an await is in flight.
  assert.ok(
    before.indexOf("markOps") < i,
    "the mark has to land before the post, or a crash-loop out-races it",
  );
  assert.match(code("telegram.js"), /const DAY_MS = 24 \* 3600 \* 1000;/);
});

test("the backup timer fires often; the upload does not", () => {
  const tgSrc = code("telegram.js");
  // The old shape — an unconditional upload at boot plus a fresh interval — is
  // what produced two archives three minutes apart.
  assert.ok(!/^\s*tgBackupOnce\(\);\s*$/m.test(tgSrc), "no unconditional upload at boot");
  assert.ok(!/setInterval\(tgBackupOnce,/.test(tgSrc), "the raw uploader must not be the timer callback");
  assert.match(tgSrc, /const backupIfDue = async \(\) => \{/);
  assert.match(tgSrc, /if \(!core\.opsDue\('tg_backup', gap\)\) return false;/);
  assert.match(tgSrc, /setInterval\(backupIfDue, BACKUP_CHECK_MS\)/);
  // The check has to be more frequent than the backup itself, or a box that
  // restarts daily would keep resetting the timer and never reach it.
  assert.match(tgSrc, /const BACKUP_CHECK_MS = 30 \* 60 \* 1000;/);
});

test("a failed upload retries instead of burning the day", () => {
  const tgSrc = code("telegram.js");
  const fn = tgSrc.slice(tgSrc.indexOf("const backupIfDue"));
  const body = fn.slice(0, fn.indexOf("\n    };"));
  assert.match(body, /const ok = await tgBackupOnce\(\);/);
  assert.match(body, /if \(ok\) core\.markOps\('tg_backup'\);/, "marking on failure would skip the archive entirely");
  // tgBackupOnce has to actually report success for that to mean anything.
  const up = tgSrc.slice(tgSrc.indexOf("async function tgBackupOnce("));
  assert.match(up.slice(0, up.indexOf("\n}")), /return true;/);
});

test("daily is the default, and it is still tunable", () => {
  const tgSrc = code("telegram.js");
  assert.match(tgSrc, /Number\(process\.env\.BACKUP_TG_HOURS \|\| 24\)/, "6h was four archives a day for one file that barely changes");
  assert.match(tgSrc, /at most every \$\{hours\}h/, "the log line must not promise a fixed cadence it no longer keeps");
});

test("a trade is reported the moment it confirms — never batched, never throttled", () => {
  // The reason the channel exists. Quieting the boot noise is only safe if the
  // thing the operator is watching FOR still arrives instantly, so this fails
  // the moment a future "less spam" change reaches for onTrade.
  const c = code("core.js");
  const calls = c.match(/_afterTrade\(u, '(buy|sell)', res\)/g) || [];
  assert.strictEqual(calls.length, 4, "EVM buy/sell and Solana buy/sell all report");
  const fn = c.slice(c.indexOf("async function _afterTrade("));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /report\.onTrade\(\{/, "posts the card itself, not a counter");
  assert.ok(!/opsDue|markOps|recapDue|setTimeout|setInterval/.test(body), "no gate, no queue, no timer between the fill and the post");
  // And the report module must not grow one either.
  const r = code("report.js");
  assert.ok(!/opsDue|dedupe|_recent|suppress/i.test(r), "report.js must stay a plain sender");
  assert.match(r, /function onTrade\(d\)/);
  assert.match(r, /🟢 <b>BUY<\/b>/);
  assert.match(r, /🔴 <b>SELL<\/b>/);
});

test("two identical trades are two cards", () => {
  // Same user, same token, same size, twice — that is two real fills and two
  // fees. Collapsing them the way a warning would be collapsed hides revenue.
  const r = code("report.js");
  const fn = r.slice(r.indexOf("function onTrade(d)"));
  assert.match(fn.slice(0, fn.indexOf("\n}")), /return post\(/, "onTrade returns the send directly — nothing sits in front of it");
});

test("the daily trade report is untouched", () => {
  // It is already once a day and it is the message the channel exists for.
  // Quieting the boot noise must not quieten the signal with it.
  const tgSrc = code("telegram.js");
  assert.match(tgSrc, /core\.recapDue\(recapHour\)/);
  assert.match(tgSrc, /Daily report/);
  assert.ok(!/opsDue\('recap/.test(tgSrc), "the recap keeps its own UTC-day gate");
});
