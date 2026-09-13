// EVERY BACKGROUND SERVICE MODULE MUST LOAD.
//
// `services/attach.js` starts each service inside its own guard and reports a
// failure BY NAME — which is exactly the right thing to do at runtime, and is
// also why this class of break is so quiet: a module that throws on `require`
// (a missing npm package, a syntax error, a file that was never committed)
// costs one ERROR line in pm2 while the admin panel goes on reading 🟢 ON,
// because that switch reads a config file and has never known whether the loop
// behind it is running. attach.js's own header records what that cost: "the
// auto-lister sits fourth in this list … a missing dependency was enough to
// stop free listings for days".
//
// The concrete near-miss this file exists for: `autoLister.js` requires
// `./listingWatch`, and a commit that took the modified file without the new
// one would have shipped a bot whose free-listing service could not start —
// with the panel showing "the scanner has gone quiet", i.e. the same symptom as
// the bug being fixed. A test that only imports what it tests cannot see that;
// this one imports EVERYTHING attach.js can reach.
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert");

const SERVICES = path.join(__dirname, "..", "src", "services");

test("every module in src/services loads — a require that throws is a service that never starts", () => {
  const files = fs.readdirSync(SERVICES).filter((f) => f.endsWith(".js"));
  assert.ok(files.length > 5, `expected the services directory, found ${files.length} files`);
  const broken = [];
  for (const f of files) {
    try {
      require(path.join(SERVICES, f));
    } catch (e) {
      broken.push(`${f}: ${e.message}`);
    }
  }
  assert.deepStrictEqual(broken, [], `these modules cannot be required:\n  ${broken.join("\n  ")}`);
});

test("every module attach.js names can be required — the list and the tree agree", () => {
  const raw = fs.readFileSync(path.join(SERVICES, "attach.js"), "utf8");
  // ⚠️ COMMENTS STRIPPED FIRST. attach.js's header quotes the very line it was
  // written about — `require("./x").start(tg)` — and a scan that reads the prose
  // would fail on a module that was never meant to exist. The repo's own rule:
  // a source scan has to read the CODE, because comments quote the defect they
  // guard against.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  // The paths attach.js actually requires, read out of the source rather than
  // by running it (starting the real services would open timers and sockets).
  const paths = [...src.matchAll(/require\(["'](\.[^"']+|\.\.\/[^"']+)["']\)/g)].map((m) => m[1]);
  assert.ok(paths.length > 8, `expected attach.js to name its services, found ${paths.length}`);
  const broken = [];
  for (const rel of new Set(paths)) {
    try {
      require(path.join(SERVICES, rel));
    } catch (e) {
      // A missing OPTIONAL dependency is still a service that will not start.
      broken.push(`${rel}: ${e.message}`);
    }
  }
  assert.deepStrictEqual(broken, [], `attach.js names modules that cannot be required:\n  ${broken.join("\n  ")}`);
});

test("⚠️ the attach.js scan reads the CODE — the header quotes a require that must not be followed", () => {
  const raw = fs.readFileSync(path.join(SERVICES, "attach.js"), "utf8");
  assert.match(raw, /require\(["']\.\/x["']\)/, "the header no longer quotes it — this guard is describing nothing");
});

test("⚠️ and the guard is not vacuous — a module that throws on require is caught", () => {
  const tmp = path.join(SERVICES, "__guardProbe.tmp.js");
  fs.writeFileSync(tmp, 'require("this-package-does-not-exist");\n');
  try {
    let caught = null;
    try {
      require(tmp);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "the probe module loaded, so the scan above proves nothing");
    assert.match(String(caught.message), /Cannot find module/);
  } finally {
    fs.unlinkSync(tmp);
  }
});
