// A background service that never started must not look like one that is
// running and finding nothing to do.
//
// The operator's report (2026-08-06): free listings stopped for two days while
// pm2 showed dexvra-bot online and the admin panel showed Auto Listing "🟢 ON".
// Both were telling the truth about what they knew — pm2 knew the PROCESS was
// up, and the panel switch reads a CONFIG FILE. Neither knew whether the scan
// loop behind the switch existed.
//
// It could not have existed: attachServices wired thirteen services in one
// sequential run inside a single try/catch in monitoring.js, whose catch was
//
//     if (e.code !== "MODULE_NOT_FOUND") log.warn(...)
//
// so a module-load failure in ANY service aborted every service declared after
// it and printed nothing at all. autoLister is the fourth of the thirteen.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-iso-"));

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

const log = require("../src/helpers/logger");

/** Capture every log level that reaches the operator. */
function capture(t) {
  const real = { error: log.error, warn: log.warn, info: log.info, alert: log.alert };
  const seen = { error: [], warn: [], info: [], alert: [] };
  for (const k of Object.keys(real)) log[k] = (...a) => seen[k].push(a.map(String).join(" "));
  t.after(() => Object.assign(log, real));
  return seen;
}

/**
 * Make one module id throw on require, the way a missing npm package does.
 * Restored after the test.
 */
function breakModule(t, needle, code = "MODULE_NOT_FOUND") {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request.includes(needle)) {
      const e = new Error(`Cannot find module '${request}'`);
      e.code = code;
      throw e;
    }
    return realLoad.apply(this, arguments);
  };
  t.after(() => (Module._load = realLoad));
}

/** A bot stub — attachServices only ever touches bot.telegram. */
const fakeBot = () => ({ telegram: { getMe: async () => ({ username: "t" }) } });

/** Attach once, returning what started and what did not. */
function attachFresh(t) {
  delete require.cache[require.resolve("../src/services/attach")];
  const attach = require("../src/services/attach");
  const services = [];
  const { failed } = attach.attachServices(fakeBot(), services);
  t.after(() => services.forEach((s) => s && s.stop && s.stop()));
  return { services, failed };
}

/**
 * Services that fail to load in THIS environment for reasons of their own.
 * node_modules is not installed in CI here, so several genuinely cannot load —
 * which is itself a live demonstration that the isolation works. Every
 * assertion below is therefore about the DELTA a deliberately broken module
 * makes, never an absolute count.
 */
let BASELINE = null;
test("baseline: what a boot starts in this environment", (t) => {
  capture(t);
  const { services, failed } = attachFresh(t);
  BASELINE = new Set(failed);
  assert.ok(services.length > 0, "nothing started at all — the wiring itself is broken");
  // The one this whole file is about must never be in the baseline.
  assert.ok(!BASELINE.has("autoLister"), `autoLister failed to start: ${failed.join(", ")}`);
});

test("one broken service does not stop the services declared after it", (t) => {
  capture(t);
  // trendingPoster is SECOND; autoLister is FOURTH. Under the old wiring this
  // killed the auto-lister and everything below it.
  breakModule(t, "trendingPoster");
  delete require.cache[require.resolve("../src/services/attach")];
  const attach = require("../src/services/attach");

  const services = [];
  const { failed } = attach.attachServices(fakeBot(), services);
  t.after(() => services.forEach((s) => s && s.stop && s.stop()));

  assert.ok(failed.includes("trendingPoster"), "the broken one must be named");
  assert.ok(!failed.includes("autoLister"), `autoLister was taken down with it: ${failed.join(", ")}`);
  assert.ok(services.length > 5, `only ${services.length} services started — the chain still aborts`);
});

test("a service that fails to load is reported BY NAME, at error level", (t) => {
  const seen = capture(t);
  breakModule(t, "autoLister");
  const { failed } = attachFresh(t);

  // Exactly one name is added by breaking exactly one module.
  const added = failed.filter((n) => !BASELINE.has(n));
  assert.deepStrictEqual(added, ["autoLister"]);
  // The whole defect was silence. MODULE_NOT_FOUND used to be exempted from
  // even a warn.
  const said = seen.error.join("\n");
  assert.match(said, /autoLister/, "the failure never reached the log");
  assert.match(said, /failed to start/);
  // …and the operator is paged, not left to read pm2 logs they have no reason
  // to open.
  assert.match(seen.alert.join("\n"), /did not start/);
});

test("MODULE_NOT_FOUND from a SERVICE is never swallowed", (t) => {
  const seen = capture(t);
  breakModule(t, "autoLister", "MODULE_NOT_FOUND");
  delete require.cache[require.resolve("../src/services/attach")];
  delete require.cache[require.resolve("../src/services/monitoring")];
  const { setupMonitoring } = require("../src/services/monitoring");

  const { services, cleanup } = setupMonitoring(fakeBot());
  t.after(cleanup);

  // The exemption exists for attach.js itself being absent — not for a service
  // four levels down raising the same code.
  assert.match(seen.error.join("\n"), /autoLister/, "MODULE_NOT_FOUND is still being swallowed");
  assert.ok(services.length > 0, "the other services must still be running");
});

test("the boot summary names what failed — a count alone means nothing", (t) => {
  const seen = capture(t);
  breakModule(t, "gainersPoster");
  delete require.cache[require.resolve("../src/services/attach")];
  delete require.cache[require.resolve("../src/services/monitoring")];
  const { setupMonitoring } = require("../src/services/monitoring");
  const { cleanup } = setupMonitoring(fakeBot());
  t.after(cleanup);

  const summary = seen.info.filter((l) => l.includes("[monitoring]")).join("\n");
  assert.match(summary, /background service\(s\) started/);
  // "12 services started" does not tell anyone 13 were expected.
  assert.match(summary, /FAILED:/);
  assert.match(summary, /gainersPoster/, "the broken service is not named in the summary");
});

test("the summary never claims a failure when there is none to claim", (t) => {
  const seen = capture(t);
  delete require.cache[require.resolve("../src/services/attach")];
  delete require.cache[require.resolve("../src/services/monitoring")];
  const { setupMonitoring } = require("../src/services/monitoring");
  const { services, cleanup } = setupMonitoring(fakeBot());
  t.after(cleanup);

  const summary = seen.info.filter((l) => l.includes("[monitoring]")).join("\n");
  assert.match(summary, /background service\(s\) started/, "the boot summary must always be emitted");
  // In an environment where nothing is broken there is no FAILED clause and no
  // page. Where something IS broken (this one: node_modules is absent), the two
  // must agree with each other rather than one of them staying quiet.
  const hasFailures = /FAILED:/.test(summary);
  assert.strictEqual(
    seen.alert.length > 0,
    hasFailures,
    "the boot summary and the page disagree about whether anything failed",
  );
  assert.ok(!/FAILED:[^\n]*autoLister/.test(summary), "autoLister must start wherever the rest can");
  assert.ok(services.length > 0);
});

// ⚠️ …AND THE PAGE HAS TO BE DELIVERABLE WHEN IT FIRES.
//
// `attachServices` reports a failed service through `log.alert`, and that is the
// ONE alarm for a dead auto-lister loop: the admin panel reads a config file and
// has never known whether the loop behind its 🟢 ON switch is running. `bot.js`
// used to call `applyMiddleware(bot)` — which is what runs `setupMonitoring` and
// therefore this whole report — BEFORE `log.attach(bot, …)`. So the page went to
// a logger with no bot attached, landed in pm2's stdout, and the ops channel got
// nothing. The failure was real; only its delivery was lost, which is the worse
// half: the operator's only remaining tell was a stale-scan line pointing at logs
// they have no reason to open.
//
// A source scan, because running the real boot needs a Telegram token — and it
// reads the CODE, since the comment above that line quotes the ordering it fixes.
test("bot.js attaches the alert channel BEFORE it starts the background services", () => {
  const fss = require("node:fs");
  const raw = fss.readFileSync(require.resolve("../src/bot.js"), "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const attach = src.search(/log\.attach\(\s*bot\b/);
  const middleware = src.search(/^\s*applyMiddleware\(bot\);/m);
  assert.notStrictEqual(attach, -1, "log.attach(bot, …) is gone — nothing can page the ops channel");
  assert.notStrictEqual(middleware, -1, "applyMiddleware(bot) is gone — this guard is describing nothing");
  assert.ok(
    attach < middleware,
    "applyMiddleware runs setupMonitoring, which pages when a service fails to start — attaching the logger afterwards drops that page",
  );
});
