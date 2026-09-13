// Test runner: `npm test`.
//
// Its only job is to make sure the suite NEVER reads the operator's live data/
// directory. The bot persists admin-saved templates, trending-board emoji and
// service config there, so a template the operator edited in @dexvraadminbot
// makes every template-rendering test compare against THEIR copy instead of the
// shipped default. On the VPS that turned `npm test` red for a reason that had
// nothing to do with the code (2026-07-25) — and it would have gone red on any
// server whose operator had ever saved a channel post.
//
// Individual test files still mkdtemp their own BOT_DATA_DIR where they need to
// write; this only guarantees nothing falls through to the real one.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-test-"));
// The file list is built here rather than left to `node --test`'s discovery,
// for two reasons: discovery treats ANY file named test.js as a test file (so a
// runner at scripts/test.js finds and re-spawns itself), and `node --test test/`
// is not a directory scan in this Node version — it tries to LOAD "test" as a
// module and dies with MODULE_NOT_FOUND.
const args = process.argv.slice(2);
const files = args.length
  ? args
  : fs
      .readdirSync(path.join(__dirname, "..", "test"))
      .filter((f) => f.endsWith(".test.js"))
      .sort()
      .map((f) => path.join("test", f));
const res = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: {
    ...process.env,
    BOT_DATA_DIR: dir,
    // The GeckoTerminal limiter paces against a REMOTE quota, and there is no
    // remote here — every test stubs global.fetch. Left at the production
    // default it makes the suite wait 2.4s per stubbed request. Raised, not
    // disabled, so the queue and the priority ordering are still exercised.
    GT_MAX_RPM: process.env.GT_MAX_RPM || "100000",
  },
});
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  /* best-effort cleanup */
}
process.exit(res.status == null ? 1 : res.status);
