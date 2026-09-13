// "Which .env is this process actually reading" is the first question behind
// every setting that appears not to apply. dotenv resolves ".env" against
// process.cwd(), and under PM2 the cwd is whatever the process was FIRST
// started with — not where you stood when you ran `pm2 restart`. A .env one
// directory off then looks correct and is read by nobody.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-env-"));

const test = require("node:test");
const assert = require("node:assert");
const { loadEnv, BOT_DIR, REPO_DIR } = require("../src/config/loadEnv");

test("both the repo root and bot/ are searched, not just the cwd", () => {
  // The two places an operator plausibly puts it. Only checking one is how a
  // treasury address gets set and never picked up.
  assert.strictEqual(path.basename(BOT_DIR), "bot");
  assert.strictEqual(REPO_DIR, path.join(BOT_DIR, ".."));
  const src = fss.readFileSync(require.resolve("../src/config/loadEnv.js"), "utf8");
  assert.match(src, /REPO_DIR, "\.env"/);
  assert.match(src, /BOT_DIR, "\.env"/);
  assert.match(src, /process\.cwd\(\), "\.env"/);
});

test("loadEnv returns the files it actually read, so boot can name them", () => {
  const loaded = loadEnv();
  assert.ok(Array.isArray(loaded));
  for (const f of loaded) {
    assert.ok(path.isAbsolute(f), `${f} must be absolute — a relative path names nothing useful`);
    assert.ok(fss.existsSync(f), `${f} was reported but does not exist`);
  }
  assert.strictEqual(new Set(loaded).size, loaded.length, "no file is loaded twice");
});

test("a missing .env is not an error — env vars may come from the shell", () => {
  assert.doesNotThrow(() => loadEnv());
});

test("both entry points load env this way and say which file won", () => {
  for (const entry of ["../main.js", "../adminbot.js"]) {
    const src = fss.readFileSync(require.resolve(entry), "utf8");
    assert.match(src, /require\("\.\/src\/config\/loadEnv"\)\.loadEnv\(\)/, `${entry} must use loadEnv`);
    assert.match(src, /\[env\] loaded/, `${entry} must log which .env it read`);
    assert.ok(!/require\("dotenv"\)\.config\(/.test(src), `${entry} must not also call dotenv directly`);
  }
});

test("the override that beats PM2's stale env snapshot is still there", () => {
  // PM2 re-injects the env it captured at the FIRST `pm2 start` on every
  // restart; --update-env only overlays the current shell. Without override a
  // stale snapshot silently wins over an edited .env (live incident:
  // POST_BANNERS=0 survived every restart).
  const src = fss.readFileSync(require.resolve("../src/config/loadEnv.js"), "utf8");
  assert.match(src, /override: true/);
});

// ── The guard the trending:check outage should have had ──────────────────────
//
// `npm run trending:check` was shipped without loading any .env and reported
// "INTERNAL_API_TOKEN is not set" on a server where it is set — i.e. a
// diagnostic accusing the box of the script's own defect. Every other script
// here got it right, which is exactly why nobody looked. `launchpads-check.js`
// had the subtler half of it: `require("../src/config/loadEnv")` with no CALL,
// which loads nothing and reads like it does.
//
// So the rule is checked rather than remembered: if a script can reach
// config/constants, it must load the env first. Walked STATICALLY — these
// scripts talk to Telegram, Mongo and the site on require, so a test may not
// execute them.
// Reaching config/constants is the loudest case (it freezes every token at
// require time), but not the only one: `shared/launchpads` and `helpers/logger`
// read process.env too, and a script that misses those reports a different
// configuration from the bot's just as silently.
const READS_ENV = /process\.env\.[A-Z]/;

/** Does `file` reach any repo module that reads the environment? Walked through
 *  plain relative requires only — good enough, and it needs no execution. */
function reachesEnvReader(file) {
  const seen = new Set([file]);
  const queue = [file];
  while (queue.length) {
    const cur = queue.shift();
    let src = "";
    try {
      src = fss.readFileSync(cur, "utf8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(/require\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      let p = path.resolve(path.dirname(cur), m[1]);
      if (fss.existsSync(p) && fss.statSync(p).isDirectory()) p = path.join(p, "index.js");
      else if (!p.endsWith(".js")) p += ".js";
      if (!fss.existsSync(p) || seen.has(p)) continue;
      seen.add(p);
      queue.push(p);
      try {
        if (READS_ENV.test(fss.readFileSync(p, "utf8"))) return true;
      } catch {
        /* unreadable — nothing to claim about it */
      }
    }
  }
  return false;
}

// smoke.js is the one script that must NOT read the box's configuration: it
// fabricates its own tokens so `npm run check` behaves identically on a laptop
// with no .env and on the server. loadEnv uses override:true, so loading one
// there would make the wiring check depend on whatever the box happens to hold.
// Asserted, not declared — an exemption that outlives its reason is a hole.
const NO_ENV_BY_DESIGN = new Set(["smoke.js"]);

test("every script loads the env through loadEnv(), before it requires repo code", () => {
  const dir = path.join(BOT_DIR, "scripts");
  const scripts = fss.readdirSync(dir).filter((f) => f.endsWith(".js"));
  assert.ok(scripts.length > 10, "the scripts directory moved — this guard is measuring nothing");
  let checked = 0;
  for (const name of scripts) {
    const file = path.join(dir, name);
    const src = fss.readFileSync(file, "utf8");
    if (NO_ENV_BY_DESIGN.has(name)) {
      assert.match(src, /process\.env\.\w+\s*=\s*process\.env\.\w+\s*\|\|/, `${name} is exempt because it sets its own env — it no longer does`);
      continue;
    }
    // Nine scripts once carried four different spellings of this — plain
    // `config()`, `{path: bot/.env}`, `{override: true}` — so which .env counted
    // depended on which script you ran. Banned outright, reachable or not.
    assert.ok(!/^\s*require\(["']dotenv["']\)\.config\(/m.test(src), `scripts/${name} must load env through loadEnv(), not its own dotenv call`);
    if (!reachesEnvReader(file)) continue;
    checked++;
    // ORDER is the rule, not presence — and the first cut of this guard got that
    // wrong. `constants.js` reads process.env at require time, so a loadEnv()
    // call further down the file (this very script has one inside its error
    // path) changes nothing and still matches a bare /loadEnv\(\)/. Deleting the
    // real call at the top left the guard green, which is the defect it exists
    // to catch, in the guard itself.
    //
    // It is also the CALL and not the require: `require(".../loadEnv")` on its
    // own loads no file at all, and reads exactly like it does.
    const call = src.search(/require\(["']\.\.\/src\/config\/loadEnv["']\)\.loadEnv\(\)/);
    assert.notStrictEqual(call, -1, `scripts/${name} reaches code that reads process.env but never calls loadEnv() — it will report unset values on a configured server`);
    const firstRepoRequire = src.search(/require\(["']\.\.\/(?!src\/config\/loadEnv)[^"']+["']\)|require\(["']\.\.\/\.\.\/[^"']+["']\)/);
    assert.ok(
      firstRepoRequire === -1 || call < firstRepoRequire,
      `scripts/${name} calls loadEnv() only AFTER requiring repo code — config/constants reads the env as it loads, so the values are already fixed by then`,
    );
  }
  assert.ok(checked >= 10, `only ${checked} script(s) were checked — the require walk is not resolving`);
});
