'use strict';
/*
 * A tapped button has to say something back.
 *
 * onCallback pre-acks every query it does not recognise as answering itself,
 * because that clears the button's spinner without waiting on a round trip. But
 * a Telegram callback query can be answered EXACTLY ONCE — so pre-acking a
 * handler that ends in `answer(q.id, 'some text')` throws that text away.
 * Telegram rejects the second call and the user gets nothing.
 *
 * Three keys were on the exempt list. Five more text answers had been added
 * since and every one of them was mute:
 *
 *   setlang  — the language switch, whose entire job is to confirm it took
 *   gasset   — gas priority
 *   monn     — "Monitor started"
 *   monx     — "Monitor stopped"
 *   cpsell   — the exit mirror, which arms an automatic 100% sell
 *
 * The user tapped 📍 on a token from /monitor and reported that the bot did not
 * respond at all. It hadn't: no toast, and — for a token whose card was already
 * pinned somewhere up the scrollback — no visible change either.
 *
 * This test reads the source because the bug IS in the source's structure: a
 * hand-maintained list that has to agree with a set of call sites scattered
 * across a 2500-line file. Anything that watches only behaviour would need one
 * case per key and would miss the next one added.
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');

/** Every `answer(q.id, <something>)` call site — i.e. every handler that means
 *  to put text in front of the user — paired with the callback key it sits
 *  under. */
function textAnswerSites() {
  const lines = SRC.split('\n');
  const out = [];
  let keys = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // Track the most recent callback-key guard. Handlers are a flat `if` chain,
    // so the nearest one above a call site is the one that owns it.
    //
    // A guard can name SEVERAL keys — `if (k === 'mw' || k === 'mwa' || ...)`.
    // Reading only the first one made this test report the others as exempt
    // keys that answer nothing, which is the opposite of the truth: every key
    // in the condition can reach the answer inside it. That imprecision is not
    // cosmetic, it would have pushed someone to "fix" it by dropping a key from
    // the exempt list and muting a live button.
    if (/if \((?:k|data) === '/.test(l)) {
      const found = [...l.matchAll(/(?:k|data) === '([a-zA-Z]+)'/g)].map((m) => m[1]);
      if (found.length) keys = found;
    }
    if (/\banswer\(q\.id,\s*\S/.test(l)) for (const key of keys) out.push({ line: i + 1, key, text: l.trim().slice(0, 80) });
  }
  return out;
}

function exemptSet() {
  const m = SRC.match(/const ANSWERS_ITSELF = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'ANSWERS_ITSELF is gone — the pre-ack has no exempt list at all');
  return new Set(m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean));
}

test('the pre-ack is driven by the exempt set, not by a hand-written condition', () => {
  // The original was `if (k !== 'oc' && k !== 'al' && k !== 'wtc')`. A condition
  // like that cannot be checked against the call sites, which is how it drifted
  // five keys out of date.
  assert.match(SRC, /if \(!ANSWERS_ITSELF\.has\(k\)\) answer\(q\.id\)/,
    'the pre-ack no longer consults ANSWERS_ITSELF');
  assert.ok(!/k !== 'oc' && k !== 'al'/.test(SRC), 'the hand-written condition is back');
});

test('every handler that answers with text is exempt from the pre-ack', () => {
  const exempt = exemptSet();
  const sites = textAnswerSites();
  assert.ok(sites.length >= 8, `expected the known text answers, found ${sites.length}`);
  const mute = sites.filter((s) => s.key && !exempt.has(s.key));
  assert.deepEqual(mute, [],
    'these handlers answer with text but are pre-acked, so their message never reaches the user:\n' +
      mute.map((s) => `  telegram.js:${s.line}  key '${s.key}'  ${s.text}`).join('\n'));
});

test('the five keys that were mute are named, so a revert is loud', () => {
  const exempt = exemptSet();
  for (const k of ['setlang', 'gasset', 'monn', 'monx', 'cpsell']) {
    assert.ok(exempt.has(k), `'${k}' answers with text and would be silent again`);
  }
  for (const k of ['oc', 'al', 'wtc']) assert.ok(exempt.has(k), `'${k}' was already exempt and must stay`);
});

test('the exempt list carries no key that does not answer with text', () => {
  // A key listed here but not answering leaves the button's spinner turning
  // until the handler finishes — the opposite failure, and just as invisible.
  const exempt = exemptSet();
  const answering = new Set(textAnswerSites().map((s) => s.key));
  const stale = [...exempt].filter((k) => !answering.has(k));
  assert.deepEqual(stale, [], `exempt keys with no text answer: ${stale.join(', ')}`);
});

// ---------------------------------------------------------------- surfacing
test('tapping 📍 on a token that already has a card SURFACES it', () => {
  // The other half of "the bot did not respond". With a monitor already pinned
  // for that token, the reuse path edited it in place — hundreds of messages up
  // the scrollback, where the user could not see anything happen.
  assert.match(SRC, /startMonitor\(chatId, tca, ch, wid, \{ surface: true \}\)/,
    'the 📍 button no longer asks for the card to be surfaced');
  assert.match(SRC, /if \(existing && surface\) \{[\s\S]{0,400}deleteMessage/,
    'surfacing must retire the old card, not silently edit it');
});

test('a BUY surfaces the card too — REVERSED, deliberately', () => {
  // This test used to assert the opposite: "a repeat BUY still reuses its card
  // in place", on the reasoning that churning the pinned message on every fill
  // would be worse than leaving it.
  //
  // That was wrong in the one case it mattered, and a user reported it:
  // "harusnya ada monitor lgsung". Receipts are always posted AFTER the fill —
  // a five-wallet buy pushes five messages on top of the card — so after a buy
  // the card is ALWAYS buried, and the moment a person most wants to see what
  // they now hold is the moment the numbers just changed. What they got instead
  // was five receipts, each with a 📍 button, and a live card somewhere above
  // the scroll.
  //
  // The churn this guarded against does not materialise: it is one surface per
  // BUY, not per wallet, and the pin is silent — the same frequency as the
  // receipt itself.
  // The BUY call sites only. Unfiltered this also matched startMonitor's own
  // declaration and the `_startMonitor(chatId, ca, …)` it forwards to inside —
  // neither of which carries an option to assert about, so a passing fix failed
  // the test on its own plumbing.
  const buySites = SRC.split('\n').filter((l) =>
    /startMonitor\(chatId, ca,/.test(l) && !/^\s*function /.test(l) && !/_startMonitor\(/.test(l));
  assert.ok(buySites.length >= 2, 'expected the post-buy start sites');
  for (const l of buySites) {
    assert.ok(/surface: true/.test(l), `a buy-path monitor is buried again: ${l.trim()}`);
  }
  // The in-place reuse path still exists — it is what a REFRESH uses, and what
  // an adopted card after a restart needs. Only the buy stopped taking it.
  assert.match(SRC, /\} else if \(existing\) \{/, 'the in-place reuse path is gone');
});
