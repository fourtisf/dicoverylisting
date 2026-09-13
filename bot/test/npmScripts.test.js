// package.json's `scripts` block, checked against the files it names.
//
// This exists because a script was overwritten by a new one that reused its
// name: `mongo:check` (does this MONGO_URI connect?) was clobbered by a backup
// checker, and package.json ended up with the key TWICE. JSON.parse keeps the
// last one silently, so nothing anywhere complained — the operator just got a
// different program than the docs described.
const test = require("node:test");
const assert = require("node:assert");
const fss = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const RAW = fss.readFileSync(path.join(ROOT, "package.json"), "utf8");
const PKG = JSON.parse(RAW);

test("no npm script is declared twice", () => {
  // Against the RAW text, not the parsed object: JSON.parse resolves duplicates
  // by keeping the last, which is exactly what hides the bug.
  const block = RAW.slice(RAW.indexOf('"scripts"'), RAW.indexOf("}", RAW.indexOf('"scripts"')));
  const names = [...block.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]).slice(1);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepStrictEqual([...new Set(dupes)], [], "duplicate script name(s)");
});

test("every npm script points at a file that exists", () => {
  const missing = [];
  for (const [name, cmd] of Object.entries(PKG.scripts || {})) {
    const m = String(cmd).match(/\bnode\s+(scripts\/[\w.-]+\.js)/);
    if (m && !fss.existsSync(path.join(ROOT, m[1]))) missing.push(`${name} → ${m[1]}`);
  }
  assert.deepStrictEqual(missing, [], "script(s) naming a file that is not there");
});

test("the two Mongo checks stay two different questions", () => {
  // They are one letter apart in the docs and answer opposite halves of "is my
  // state safe": one tests the connection before you commit to a URI, the other
  // assumes the connection and audits what actually crossed. Collapsing them
  // again would lose whichever half got overwritten.
  assert.strictEqual(PKG.scripts["mongo:check"], "node scripts/mongo-check.js");
  assert.strictEqual(PKG.scripts["backup:check"], "node scripts/backup-check.js");
  const conn = fss.readFileSync(path.join(ROOT, "scripts", "mongo-check.js"), "utf8");
  const backup = fss.readFileSync(path.join(ROOT, "scripts", "backup-check.js"), "utf8");
  assert.match(conn, /MONGO_URI is valid/, "mongo:check still validates a URI");
  assert.match(conn, /backup:check/, "and points at the other one");
  assert.match(backup, /Premium emoji/, "backup:check still audits what is mirrored");
  assert.match(backup, /mongo:check/, "and points back");
});
