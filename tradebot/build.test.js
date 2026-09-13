'use strict';
/*
 * build.test.js — the boot stamp that says which commit is actually running.
 *
 * The stamp exists because a pull that never reached the server and a change
 * that did not work are indistinguishable from Telegram (see build.js, and the
 * release-flow section of CLAUDE.md). `+dirty` is the loudest thing it can say:
 * the operator is told to stop and investigate before believing anything.
 *
 * Which is why it firing on nothing is a real defect. A production box printed
 *
 *     [boot] build 81efa21+dirty
 *
 * while `git diff --stat` was empty and `git status --short` showed exactly one
 * line: `?? discovery-listing@0.1.0` — an untracked directory beside the code,
 * touching nothing the process loads. `git status --porcelain` counts `??`
 * lines, so debris anywhere in the repo stamped the trade bot as diverged from
 * `main` when it was byte-identical to it. A warning that fires when nothing is
 * wrong is one the operator learns to scroll past.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SRC = fs.readFileSync(path.join(__dirname, 'build.js'), 'utf8');

test('the two states are read with different commands', () => {
  // A bare `git status --porcelain` cannot tell them apart — that is the bug.
  assert.match(SRC, /'status', '--porcelain', '--untracked-files=no'/,
    'the tracked check counts untracked files again');
  assert.match(SRC, /'ls-files', '--others', '--exclude-standard'/,
    'untracked files are no longer detected at all');
  assert.ok(!/run\(\['status', '--porcelain'\]\)/.test(SRC), 'the bare porcelain call is back');
});

test('+dirty means a TRACKED file changed, and nothing else', () => {
  assert.match(SRC, /function dirty\(\) \{ return status\(\)\.tracked; \}/);
  assert.match(SRC, /s\.tracked \? '\+dirty' : ''/);
});

test('an untracked file is still reported — just not as the same alarm', () => {
  // Not silence: a file the code requires but git has never seen WOULD diverge
  // from main. It is a different fact, so it gets a different word.
  assert.match(SRC, /s\.untracked \? '\+untracked' : ''/);
});

// ── Driven against real git repositories ─────────────────────────────────────

/** A throwaway repo with one commit, and build.js copied in so its `cwd:
 *  __dirname` resolves inside it. */
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexvra-build-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'tracked.js'), 'module.exports = 1;\n');
  fs.copyFileSync(path.join(__dirname, 'build.js'), path.join(dir, 'build.js'));
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { dir, git, load: () => { delete require.cache[require.resolve(path.join(dir, 'build.js'))]; return require(path.join(dir, 'build.js')); } };
}

test('a clean checkout stamps the bare sha', () => {
  const { dir, load } = repo();
  const b = load();
  assert.strictEqual(b.dirty(), false);
  assert.match(b.stamp(), /^[0-9a-f]{7,}$/, `expected a bare sha, got ${b.stamp()}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an untracked file alone does NOT say +dirty', () => {
  // The reported case, reproduced: one stray directory, nothing else.
  const { dir, load } = repo();
  fs.mkdirSync(path.join(dir, 'discovery-listing@0.1.0'));
  fs.writeFileSync(path.join(dir, 'discovery-listing@0.1.0', 'package.json'), '{}');
  const b = load();
  assert.strictEqual(b.dirty(), false, 'a stray untracked directory still reads as a modified checkout');
  assert.strictEqual(b.status().untracked, true, 'the stray is not reported at all');
  assert.ok(!b.stamp().includes('+dirty'), `stamp was ${b.stamp()}`);
  assert.match(b.stamp(), /\+untracked$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an edited tracked file DOES say +dirty', () => {
  // The case the stamp exists for must keep working.
  const { dir, load } = repo();
  fs.writeFileSync(path.join(dir, 'tracked.js'), 'module.exports = 2;   // edited on the server\n');
  const b = load();
  assert.strictEqual(b.dirty(), true, 'a real local edit is no longer flagged — the stamp is now useless');
  assert.match(b.stamp(), /\+dirty$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a deleted tracked file counts as dirty too', () => {
  const { dir, load } = repo();
  fs.unlinkSync(path.join(dir, 'tracked.js'));
  const b = load();
  assert.strictEqual(b.dirty(), true, 'a file deleted on the server is not flagged');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('both at once says both', () => {
  const { dir, load } = repo();
  fs.writeFileSync(path.join(dir, 'tracked.js'), 'module.exports = 3;\n');
  fs.writeFileSync(path.join(dir, 'stray.log'), 'noise\n');
  const b = load();
  assert.match(b.stamp(), /\+dirty\+untracked$/, `stamp was ${b.stamp()}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('outside a git checkout the stamp degrades instead of throwing', () => {
  // A tarball deploy or a container copy is not an error, just a stamp we
  // cannot produce — and it must never be able to crash a boot.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexvra-nogit-'));
  fs.copyFileSync(path.join(__dirname, 'build.js'), path.join(dir, 'build.js'));
  const b = require(path.join(dir, 'build.js'));
  assert.doesNotThrow(() => b.stamp());
  assert.strictEqual(b.dirty(), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
