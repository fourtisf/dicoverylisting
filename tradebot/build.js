'use strict';
/*
 * What commit is this process actually running?
 *
 * Every deploy in this repo has looked identical from the outside: pull,
 * restart, paste the contract, get the same card. There was no way to tell a
 * change that did not work from a change that never reached the server, and
 * several rounds were spent debugging the first when it was the second.
 *
 * So both bot processes print their commit at boot, and it is one grep to check:
 *
 *     pm2 logs dexvra-tradebot --lines 50 | grep '\[boot\] build'
 *
 * Read from git at startup, not baked in at build time: there is no build step
 * here, and a stamp that needs one is a stamp that goes stale.
 */
const { execFileSync } = require('node:child_process');

let _cached = null;

/** Short commit sha of the checkout this file lives in, or 'unknown'. */
function sha() {
  if (_cached) return _cached;
  try {
    _cached = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'unknown';
  } catch (_) {
    // Not a git checkout (a tarball deploy, a container copy) — not an error,
    // just a stamp we cannot produce.
    _cached = 'unknown';
  }
  return _cached;
}

/** Uncommitted state, as TWO facts rather than one.
 *
 *  `tracked` — a file git knows about has been edited, staged or deleted. THIS
 *  is what `+dirty` means and what CLAUDE.md tells the operator to stop and
 *  investigate: the code running is not the code `main` describes.
 *
 *  `untracked` — a file exists that git has never seen. On a real box this is
 *  almost always debris beside the code (a stray npm directory, an editor
 *  scratch file, a log), and it changes nothing about what runs.
 *
 *  They were one flag, computed with a bare `git status --porcelain`, which
 *  counts `??` lines. So a single stray directory at the repo root stamped the
 *  trade bot `+dirty` while its checkout was byte-identical to `main` — and a
 *  warning that fires when nothing is wrong is a warning the operator learns to
 *  scroll past, which is exactly the failure this stamp exists to prevent.
 *
 *  An untracked file is still worth SAYING, because one that the code actually
 *  requires would genuinely diverge from `main` — it is just not the same alarm.
 */
function status() {
  const run = (args) => execFileSync('git', args, {
    cwd: __dirname, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  try {
    return {
      tracked: run(['status', '--porcelain', '--untracked-files=no']).length > 0,
      untracked: run(['ls-files', '--others', '--exclude-standard']).length > 0,
    };
  } catch (_) { return { tracked: false, untracked: false }; }
}

/** True when a TRACKED file has uncommitted changes — a deploy that is not what
 *  `main` says it is, which is worth knowing before debugging anything. */
function dirty() { return status().tracked; }

const stamp = () => {
  const s = status();
  return `${sha()}${s.tracked ? '+dirty' : ''}${s.untracked ? '+untracked' : ''}`;
};

module.exports = { sha, dirty, status, stamp };
