'use strict';
/*
 * routerError.test.js — "⚠️ Something glitched handling that".
 *
 * A user tapped something in the bot and got that line back. The server log,
 * asked afterwards, had exactly this to say:
 *
 *     7|dexvra-t | handleUpdate fetch failed
 *     7|dexvra-t | handleUpdate fetch failed
 *     7|dexvra-t | handleUpdate fetch failed
 *
 * Two words. Not which host, not which syscall, not what the user had done.
 * `fetch failed` is undici's message for EVERY transport failure — a dead RPC,
 * a blocked egress, a withdrawn host and a TLS failure are one string — and
 * solana.js `netErr()` exists precisely because reading `e.message` and stopping
 * there had already cost a round of guessing once.
 *
 * WHERE IT CAME FROM. `tg()` retried the wrong failure. It honours Telegram's
 * 429 — an HTTP answer, from a host that is plainly there and talking — and let
 * a bare transport error out to its caller, where nothing catches it: it unwinds
 * through send()/edit()/answer(), out of onMessage/onCallback, and lands in
 * handleUpdate's catch, which turns any error at all into that one sentence.
 *
 * So a momentary blip on the way to api.telegram.org cost the user their action
 * and told the operator nothing. The three fixes:
 *
 *   1. tg() retries a transport error — but ONLY on codes that prove the
 *      request never reached Telegram. A connection that broke after being
 *      established may have delivered the message, and a duplicate receipt is
 *      its own bug.
 *   2. The router's catch names the path, the syscall and the stack — and must
 *      never name the message TEXT, because the import-wallet step takes a
 *      private key as a plain chat message.
 *   3. "Something glitched" is a claim about the bot. On an upstream outage it
 *      is the wrong claim, and it invites an instant retry into the same dead
 *      host.
 *
 * No network.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const i18n = require('./i18n');
const solana = require('./solana');
const TG = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');

const TGFN = TG.slice(TG.indexOf('async function tg(method, body)'), TG.indexOf('/**\n * Send in ORDER'));
const _R0 = TG.indexOf('async function handleUpdate(up)');
const ROUTER = TG.slice(_R0, TG.indexOf('\nasync function ', _R0 + 10));
/**
 * Comment lines stripped.
 *
 * The leak assertions below are about CODE. Asserting over the raw slice made
 * them fire on the very comment that documents the hazard — a test that fails
 * when you explain the bug you fixed is a test that will be deleted rather than
 * read. Only whole-line comments go; a `//` inside a string or a URL survives.
 */
const code = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '');

// ── tg(): the transport error is the one worth retrying ──────────────────────

test('a transport failure is retried; an HTTP answer is not treated as one', () => {
  assert.ok(TGFN.length > 400, 'tg() moved — this test is asserting nothing');
  assert.match(TGFN, /netTries < TG_NET_RETRIES && TG_NEVER_SENT\.has\(String\(err\.code \|\| ''\)\)/);
  // The 429 path is untouched: it is an ANSWER, and its own counter must not be
  // spent by network retries sharing the loop variable.
  assert.match(TGFN, /http429 >= RETRY_429_MAX - 1/);
  assert.match(TGFN, /for \(let http429 = 0, netTries = 0; ; \)/, 'the two retry budgets share one counter again');
});

test('only codes that prove the request never left are retried', () => {
  const set = TG.slice(TG.indexOf('const TG_NEVER_SENT'), TG.indexOf('const TG_NET_RETRIES'));
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT']) {
    assert.match(set, new RegExp(`'${code}'`), `${code} is not retried`);
  }
  // A connection that was ESTABLISHED and then broke may already have delivered
  // the message. Retrying it duplicates a receipt, which is its own bug — and a
  // duplicate buy confirmation is worse than a missing one.
  for (const code of ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']) {
    assert.ok(!new RegExp(`'${code}'`).test(set), `${code} is retried — a delivered message may be sent twice`);
  }
});

test('the error carries the reason, and never the bot token', () => {
  // netErr, not a fourth private idea of failure. It is the module that already
  // knows undici hides the syscall in err.cause.
  assert.match(TGFN, /solana\.netErr\(e, TG_HOST\)/);
  // THE TOKEN. `API` ends in it, and netErr falls back to the WHOLE url when it
  // cannot parse one — which would put the bot token into an Error message, into
  // pm2's log, and very nearly into a chat.
  assert.match(TG, /const TG_HOST = 'https:\/\/api\.telegram\.org';/);
  assert.ok(!/netErr\(e, `\$\{API\}/.test(TG), 'the tokenful base is handed to an error formatter');
  const err = solana.netErr(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), 'https://api.telegram.org');
  assert.match(err.message, /api\.telegram\.org/);
  assert.match(err.message, /does not resolve/, 'the syscall is still thrown away');
  assert.strictEqual(err.offline, true);
  assert.strictEqual(err.code, 'ENOTFOUND');
});

test('a non-JSON body reports its status instead of masquerading as a dead host', () => {
  // A proxy's HTML 502 is not a transport failure. The status is the useful
  // fact and it is exactly what undici's message throws away.
  assert.match(TGFN, /Telegram returned a non-JSON \$\{r\.status\} response/);
});

// ── The router's catch ───────────────────────────────────────────────────────

test('the log names the path, the syscall and the stack', () => {
  assert.ok(ROUTER.length > 400, 'handleUpdate moved — this test is asserting nothing');
  assert.match(ROUTER, /handleUpdate \[\$\{what\}\] chat=/);
  assert.match(ROUTER, /e\.code \|\| \(e\.cause && \(e\.cause\.code \|\| e\.cause\.errno\)\)/);
  assert.match(ROUTER, /\(e && e\.stack\) \|\| ''/);
  // The whole of the old line. Two words and nothing else.
  assert.ok(!/console\.error\('handleUpdate', e && \(e\.message \|\| e\)\);/.test(ROUTER),
    'the bare log is back — `handleUpdate fetch failed` and nothing more');
});

test('the path is named from the bot\'s own state, NEVER from message text', () => {
  // ⚠️ The import-wallet step takes a private key as a plain chat message. Even
  // a truncated `up.message.text` puts key material into pm2's log for anyone
  // with shell access to the box.
  assert.match(ROUTER, /msg:\$\{\(p && p\.action\) \|\| 'command'\}/);
  const logged = code(ROUTER).slice(code(ROUTER).indexOf('catch (e)'));
  assert.ok(!/up\.message\.text/.test(logged), 'message text reaches the log — that is a private key on the wallet-import step');
  assert.ok(!/up\.message\.caption/.test(logged));
  // Callback data is bot-generated ("tok:solana:0:<ca>") and carries nothing the
  // user typed, so it is the one identifier that is safe AND specific.
  assert.match(ROUTER, /cb:\$\{String\(up\.callback_query\.data \|\| '\?'\)\.slice\(0, 48\)\}/);
});

test('an upstream outage does not read as a bug in the bot', () => {
  assert.match(ROUTER, /T\(chat\.id, e && e\.offline \? 'err\.glitch_net' : 'err\.glitch'\)/);
  // It was one hardcoded English string on a bot that ships EN/ID everywhere.
  assert.ok(!/Something glitched handling that — please try again in a moment\.'\)/.test(ROUTER),
    'the copy is hardcoded in the router again');
  for (const key of ['err.glitch', 'err.glitch_net']) {
    assert.ok(i18n._strings[key], `${key} missing`);
    assert.notStrictEqual(i18n._strings[key].en, i18n._strings[key].id, `${key} untranslated`);
  }
  const net = i18n.t('en', 'err.glitch_net');
  assert.match(net, /nothing was spent/i, 'the line does not say the money is untouched');
  assert.match(net, /connection problem/i);
  // "Glitched" is a claim about the bot and must not be made about an outage.
  assert.ok(!/glitch/i.test(net), 'an upstream outage still calls itself a glitch');
});

test('undici\'s bare message classifies as an outage, so the right line is picked', () => {
  // The flag is what the router branches on, but the classifier has to agree or
  // a trade error and a router error would describe one failure two ways.
  assert.strictEqual(i18n.errorKey('fetch failed'), 'err.offline');
  assert.strictEqual(i18n.errorKey("can't reach api.telegram.org — the name does not resolve from this server"), 'err.offline');
});

// ── The poll loop ────────────────────────────────────────────────────────────

test('a poll that threw is not a poll that worked', () => {
  const loop = TG.slice(TG.indexOf('let pollDown = 0;'), TG.indexOf('module.exports = { start'));
  // It slept two seconds and said nothing, so a bot that could not reach
  // Telegram for an hour looked exactly like a quiet hour.
  assert.match(loop, /\[poll\] cannot reach Telegram/);
  // On the TRANSITION: at one attempt every two seconds a per-failure line
  // writes the same sentence 1,800 times an hour and buries the first one.
  assert.match(loop, /if \(!pollDown\) console\.error\('\[poll\] cannot reach Telegram/);
  // And the RECOVERY is an alert too, or the log cannot distinguish a fixed
  // outage from an ongoing one — the same rule upstreams.js already follows.
  assert.match(loop, /\[poll\] Telegram reachable again/);
  assert.match(loop, /if \(pollDown\) \{ console\.log/);
});
