'use strict';
/*
 * solCheck.test.js — sol:check is DRIVEN, not read.
 *
 * `node --check` proves syntax and every defect this repo has had in a check
 * script was a runtime shape: a probe that hung, a scan that reported a busy
 * pair as dead, a verdict that named the wrong layer. So the script is RUN.
 *
 * The property that matters most cannot be asserted any other way: a paid RPC
 * endpoint carries its API key in the path or the query, and this output is
 * read off a terminal that gets screenshotted.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { execFileSync, execFile } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'scripts', 'sol-check.js');
const SECRET = 'SUPERSECRETKEY123';

/**
 * ⚠️ STDOUT AND STDERR ARE KEPT APART, and the first cut of this file did not.
 *
 * `solana.rpcUrls` warns on stderr about a refused entry with wording close to
 * the check's own, so a test asserting on the concatenation passed while the
 * check printed nothing at all — it was measuring the module's warning, not the
 * report an operator reads. A mutation run said so.
 *
 * `out` is the REPORT. `both` is for the one question that spans them: a key
 * leaked to stderr is still leaked.
 */
function run(env) {
  const opts = {
    env: { ...process.env, SKIP_DOTENV: '1', ...env },
    encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'],
  };
  try {
    const out = execFileSync(process.execPath, [SCRIPT], opts);
    return { out, both: out };
  } catch (e) {
    // Non-zero is the ORDINARY outcome here: this sandbox has no egress, so
    // every host refuses. The output is the subject, not the exit code.
    const out = String((e && e.stdout) || '');
    return { out, both: out + String((e && e.stderr) || '') };
  }
}

test('⚠️ it never prints a url — only a hostname', () => {
  const { out, both } = run({ SOLANA_RPC: `https://paid.example/rpc/?api-key=${SECRET}` });
  assert.ok(out.includes('paid.example'), 'the host has to be named, or the check answers nothing');
  // BOTH streams: a key on stderr is on the same terminal.
  assert.ok(!both.includes(SECRET), 'the API KEY reached a terminal that gets screenshotted');
  assert.ok(!both.includes('/rpc/'), 'the path carries the key on some providers');
});

test('a placeholder entry is NAMED as ignored, not silently dropped', () => {
  const { out } = run({ SOLANA_RPC: 'https://endpoint-berbayar-anda,https://api.mainnet-beta.solana.com' });
  assert.match(out, /endpoint-berbayar-anda.*not a reachable host/,
    'a "fix" that changed nothing at all is what this line exists to end');
  assert.match(out, /api\.mainnet-beta\.solana\.com/, 'and the survivor is still listed');
});

test('it says WHICH host refused, which the wallet screen cannot', () => {
  const { out } = run({ SOLANA_RPC: 'https://nope.example/rpc' });
  // The screen says "the Solana RPC is rate-limiting this server (429)" and
  // stops one word short: with a failover list, "the paid host is refusing us"
  // and "the paid host never arrived" wear the same sentence.
  assert.match(out, /nope\.example —/, 'the verdict is per host');
});

test('it reaches its verdict even when nothing answers', () => {
  const { out } = run({ SOLANA_RPC: 'https://nope.example/rpc' });
  assert.match(out, /What \/wallet would show/, 'a probe that hangs is worse than one that says it cannot answer');
  assert.match(out, /every host refused/);
});

test('⚠️ core is required BEFORE solana — order, not presence', () => {
  // core.js loads tradebot/.env into process.env and solana.js reads
  // SOLANA_RPC at module-eval time, so the other order reports a correctly-set
  // endpoint as missing — a diagnostic about nothing. The same rule
  // loadEnv.test.js had to learn after matching the call anywhere in the file.
  const src = fs.readFileSync(SCRIPT, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const c = src.indexOf("require(path.join(__dirname, '..', 'core'))");
  const s = src.indexOf("require(path.join(__dirname, '..', 'solana'))");
  assert.ok(c > -1 && s > -1, 'both requires must still be there');
  assert.ok(c < s, 'solana.js reads the env at module-eval — core must load it first');
});

/**
 * ⚠️ `execFileSync` BLOCKS THIS PROCESS'S EVENT LOOP, so a stub server living
 * here could never answer the child while it ran. The two tests below stand up
 * real local nodes, so they need the async form.
 */
function runAsync(env) {
  return new Promise((res) => {
    execFile(process.execPath, [SCRIPT], {
      env: { ...process.env, SKIP_DOTENV: '1', ...env },
      encoding: 'utf8', timeout: 90000,
    }, (_e, out, err) => res({ out: String(out || ''), both: String(out || '') + String(err || '') }));
  });
}

/**
 * A local node that answers `getMultipleAccounts` — or refuses with a 429.
 *
 * Hermetic on purpose: "does the exit code follow the SCREEN" cannot be asked
 * of a sandbox with no egress, where every host refuses and the two branches
 * are indistinguishable.
 */
function stubNode({ refuse = false } = {}) {
  const srv = http.createServer((req, r) => {
    if (refuse) { r.writeHead(429, { 'content-type': 'text/plain' }); r.end('Too Many Requests'); return; }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let n = 1; let id = 1;
      try {
        const j = JSON.parse(body);
        id = j.id;
        n = (j.params && j.params[0] && j.params[0].length) || 1;
      } catch (_) { /* answer one */ }
      const value = Array.from({ length: n }, () => ({
        data: ['', 'base64'], executable: false, lamports: 123,
        owner: '11111111111111111111111111111111', rentEpoch: 0, space: 0,
      }));
      r.writeHead(200, { 'content-type': 'application/json' });
      r.end(JSON.stringify({ jsonrpc: '2.0', id, result: { context: { apiVersion: '1.18.0', slot: 1 }, value } }));
    });
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({
    url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close(),
  })));
}

test('⚠️ a host that refuses while another answers is NOT a failure', async () => {
  // The exit code follows the SCREEN, not the host tally. Marking a refused
  // host ✗ while the walk falls through leaves this check permanently red on a
  // box whose /wallet is fine — the state `chart:preview` sat in for weeks,
  // which teaches its reader to ignore the red.
  const good = await stubNode();
  const bad = await stubNode({ refuse: true });
  try {
    const { out } = await runAsync({
      SOLANA_RPC: `${good.url},${bad.url}`,
      SOL_READ_FALLBACK: '0',   // measure exactly these two, not the public pair
    });
    assert.match(out, /1 of 2 hosts answered/, 'the walk falling through is the feature working');
    // The PROPERTY, not the global verdict: section 1 also counts (this sandbox
    // has no tradebot/.env), so asserting the exit line would measure the
    // environment rather than the rule under test.
    assert.doesNotMatch(out, /✗ .*rate-limiting/, 'a refused host is ⚠ while another answers, never ✗');
    assert.match(out, /⚠ .*rate-limiting/, 'it is still REPORTED — that host is worth fixing at its provider');
  } finally { good.close(); bad.close(); }
});

test('…and EVERY host refusing still is', async () => {
  const bad = await stubNode({ refuse: true });
  try {
    const { out } = await runAsync({ SOLANA_RPC: bad.url, SOL_READ_FALLBACK: '0' });
    assert.match(out, /every host refused/);
    assert.match(out, /problem\(s\) above/, 'green must mean the screen is safe');
  } finally { bad.close(); }
});

test('it lists the hosts a READ actually walks, fallbacks included', async () => {
  // A check that listed only the configured hosts would report "no failover" on
  // a box that has two, then probe neither — measuring a stack the screen does
  // not use, which is `fonts:check`'s nine green ticks over a broken banner.
  const good = await stubNode();
  try {
    const { out } = await runAsync({ SOLANA_RPC: good.url });
    assert.match(out, /solana-rpc\.publicnode\.com.*read-only fallback/,
      'the read-path fallbacks have to be visible, or nobody knows a read can land there');
    assert.match(out, /solana\.drpc\.org/);
    assert.match(out, /signed and confirmed on 127\.0\.0\.1/,
      'and the one host that does NOT fail over must be named — that is where money moves');
  } finally { good.close(); }
});
