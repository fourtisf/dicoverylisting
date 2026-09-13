// The boot stamp has to be trustworthy, or it is worse than nothing.
//
// Every deploy here looks identical from the outside: pull, restart, paste the
// contract, get the same card. The stamp is the only thing that separates "the
// change did not work" from "the change never reached the server" — several
// evenings went into debugging the first when it was the second.
//
// So a FALSE '+dirty' is not cosmetic. It fired on every boot of a perfectly
// clean checkout, because `git status --porcelain` counts untracked files and a
// production box always has some: data.bak-2026-08-03/, .env.bak,
// session.txt.bak, a stray FETCH_HEAD. An operator who sees '+dirty' on a clean
// tree learns to ignore it, and then it is not there on the day it is true.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fss = require("node:fs");
const { execFileSync } = require("node:child_process");
const os = require("node:os");

const SRC = path.join(__dirname, "..", "src", "helpers", "build.js");

/** A throwaway repo with one commit, so the flag is tested against real git. */
function repo() {
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-build-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  // The module reads git from ITS OWN directory, so it has to be copied in.
  fss.mkdirSync(path.join(dir, "src", "helpers"), { recursive: true });
  fss.copyFileSync(SRC, path.join(dir, "src", "helpers", "build.js"));
  git("add", "-A");
  git("commit", "-qm", "one");
  return { dir, git, load: () => require(path.join(dir, "src", "helpers", "build.js")) };
}

test("an untracked backup does NOT make the deploy dirty", () => {
  const r = repo();
  // Exactly what the server carries: a backup directory and a .bak file.
  fss.mkdirSync(path.join(r.dir, "data.bak-2026-08-03"));
  fss.writeFileSync(path.join(r.dir, "data.bak-2026-08-03", "orders.json"), "{}");
  fss.writeFileSync(path.join(r.dir, ".env.bak"), "TOKEN=x");
  fss.writeFileSync(path.join(r.dir, "FETCH_HEAD"), "");
  assert.strictEqual(r.load().dirty(), false, "backups on the box are not a code change");
});

test("a tracked file edited on the server DOES make it dirty", () => {
  const r = repo();
  // The case the flag exists for: somebody edited code in place, so the process
  // is not running what `main` says it is.
  fss.appendFileSync(path.join(r.dir, "src", "helpers", "build.js"), "\n// hotfix\n");
  assert.strictEqual(r.load().dirty(), true);
});

test("the stamp is the sha alone on a clean tree", () => {
  const r = repo();
  const b = r.load();
  assert.strictEqual(b.stamp(), b.sha());
  assert.doesNotMatch(b.stamp(), /\+dirty/);
});

test("outside a git checkout the stamp degrades, it does not throw", () => {
  // A tarball deploy or a container copy has no git. That is not an error and
  // must never take the boot down with it.
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-nogit-"));
  fss.mkdirSync(path.join(dir, "src", "helpers"), { recursive: true });
  fss.copyFileSync(SRC, path.join(dir, "src", "helpers", "build.js"));
  const b = require(path.join(dir, "src", "helpers", "build.js"));
  assert.strictEqual(b.sha(), "unknown");
  assert.strictEqual(b.dirty(), false);
});

test("the server's own backups are gitignored, so git status stays readable", () => {
  // A real modified package-lock.json sat unnoticed among eight lines of
  // untracked noise. The noise is the bug.
  const ig = fss.readFileSync(path.join(__dirname, "..", "..", ".gitignore"), "utf8");
  for (const pat of ["*.bak", "data.bak-*/"]) {
    assert.ok(ig.includes(pat), `.gitignore must cover ${pat}`);
  }
});
