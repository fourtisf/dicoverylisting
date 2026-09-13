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
 *     pm2 logs dexvra-bot --lines 50 | grep '\[boot\] build'
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

/** True when TRACKED files differ from the commit — a deploy that is not what
 *  `main` says it is, which is worth knowing before debugging anything.
 *
 *  --untracked-files=no is the whole point. This used to be a bare
 *  `git status --porcelain`, which counts untracked files too, and a production
 *  server is never without them: data.bak-2026-08-03/, .env.bak,
 *  session.txt.bak, a stray FETCH_HEAD. So the stamp read '+dirty' on a
 *  perfectly clean checkout, every boot, forever — and a warning that is always
 *  on is a warning nobody reads. The question this flag answers is "is the CODE
 *  what main says", and an untracked backup directory cannot change that. */
function dirty() {
  try {
    return execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: __dirname, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().length > 0;
  } catch (_) { return false; }
}

const stamp = () => `${sha()}${dirty() ? '+dirty' : ''}`;

module.exports = { sha, dirty, stamp };
