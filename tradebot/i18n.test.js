'use strict';
/*
 * The bot's copy, in both languages.
 *
 * `user.lang` and getLang()/setLang() sat in core.js unused for the whole life of
 * this bot: the schema said the bot could answer in Indonesian and every single
 * reply was a hardcoded English literal. These tests exist so that cannot happen
 * again quietly — a key added in English and forgotten in Indonesian fails here,
 * and so does a translation that loses one of the numbers a trader is reading.
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const i18n = require('./i18n');
const TG = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');

// ---------------------------------------------------------------- completeness
test('every string exists in every supported language', () => {
  const missing = [];
  for (const [key, entry] of Object.entries(i18n._strings)) {
    for (const lang of i18n.LANGS) if (!entry[lang]) missing.push(`${key} (${lang})`);
  }
  assert.deepEqual(missing, [], 'untranslated keys — an English-only key ships as English to everyone');
});

test('no translation silently drops a placeholder the English copy fills', () => {
  // The real hazard of a hand-written locale: "Bought {sym}" translated without
  // {sym}, so a receipt renders with a blank where the token should be.
  const slots = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort();
  const bad = [];
  for (const [key, entry] of Object.entries(i18n._strings)) {
    const want = slots(entry.en);
    for (const lang of i18n.LANGS) {
      if (lang === 'en') continue;
      if (String(slots(entry[lang])) !== String(want)) bad.push(`${key} (${lang}): ${slots(entry[lang])} != ${want}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the two languages are genuinely different copy, not a copy-paste', () => {
  // A locale file that was filled in by duplicating English is worse than none:
  // it reports as complete and reads as broken. Allow the handful of strings
  // that legitimately match (bare labels, trading jargon kept in English).
  let same = 0, total = 0;
  for (const entry of Object.values(i18n._strings)) { total++; if (entry.en === entry.id) same++; }
  assert.ok(same / total < 0.25, `${same}/${total} Indonesian strings are identical to English`);
});

// ---------------------------------------------------------------- rendering
test('placeholders are substituted, and a missing one leaves no "{name}" on screen', () => {
  assert.equal(i18n.t('en', 'buy.progress', { amt: '0.05', native: 'ETH', atMc: '' }), '⏳ <b>Buying 0.05 ETH</b>…');
  assert.equal(i18n.t('id', 'buy.progress', { amt: '0.05', native: 'ETH', atMc: '' }), '⏳ <b>Beli 0.05 ETH</b>…');
  // A var the caller forgot renders as nothing — never as literal braces.
  assert.ok(!i18n.t('id', 'buy.progress', { amt: '1' }).includes('{'));
});

test('an unknown language falls back to English rather than blank', () => {
  assert.equal(i18n.t('fr', 'common.cancelled'), i18n.t('en', 'common.cancelled'));
  assert.equal(i18n.t(undefined, 'common.cancelled'), i18n.t('en', 'common.cancelled'));
});

test('an unknown key returns the key — visibly wrong beats invisibly empty', () => {
  assert.equal(i18n.t('en', 'no.such.key'), 'no.such.key');
});

// ---------------------------------------------------------------- errors
test('each failure class maps to its own message, in both languages', () => {
  const cases = [
    ['token balance is 0', 'err.no_bag'],
    ['insufficient ETH — need ~0.016, have 0.01499', 'err.insufficient'],
    ['max fee per gas less than block base fee', 'err.gas_moved'],
    ['execution reverted', 'err.slippage'],
    ['trade sent but not confirmed', 'err.unconfirmed'],
    ['could not price this buy on Base V3 (pool read failed)', 'err.no_price'],
    ['no route / no liquidity for this token on Jupiter', 'err.no_route'],
    ['NotAllowed: private beta', 'err.restricted'],
    ['something nobody has seen before', 'err.generic'],
  ];
  for (const [raw, key] of cases) {
    assert.equal(i18n.errorKey(new Error(raw)), key, `"${raw}" classified wrong`);
    for (const lang of i18n.LANGS) {
      const msg = i18n.errorText(lang, new Error(raw), 'buy');
      assert.ok(msg && msg.length > 10, `${lang}/${key} rendered empty`);
      assert.ok(!msg.includes('{'), `${lang}/${key} left an unsubstituted placeholder`);
    }
  }
});

test('an error message never leaks the raw chain/RPC text to the user', () => {
  // "could not coalesce error", a revert selector, a nonce dump: all real
  // strings this engine produces, none of them something a trader can act on.
  for (const lang of i18n.LANGS) {
    const msg = i18n.errorText(lang, new Error('could not coalesce error (payload=0x08c379a0…)'), 'sell');
    assert.ok(!/coalesce|0x08c379a0|payload/i.test(msg), `${lang} passed the raw error through`);
  }
});

test('a per-wallet failure reaches the SERVER LOG, not only the card', () => {
  // `grep 'buy failed'` came back empty on a trade that had just failed five
  // times. The catch at the bottom of doBuy was the only thing that ever wrote
  // one, and it fires only when the whole block throws — a per-wallet rejection
  // lands in Promise.allSettled, becomes a friendly sentence, and left nothing
  // on the server, which is the one place the real reason could still be read.
  const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  assert.match(SRC, /console\.error\(`buy failed \[\$\{t\.label\}\]/, 'a per-wallet buy failure is still silent server-side');
  assert.match(SRC, /console\.error\(`sell failed \[\$\{t\.label\}\]/, 'a per-wallet sell failure is still silent server-side');
});

test("the engine's own errors do not fall through to the generic sentence", () => {
  // Enumerated from the strings solana.js actually throws, not guessed. Each
  // was reaching the user as "didn't go through, try again in a moment" — the
  // sentence that says nothing and is indistinguishable from every other cause.
  const cases = {
    'buy failed on Solana: Jupiter swap-build failed (500) — Invalid request': 'err.build_failed',
    'buy failed on Solana: Jupiter returned no swap transaction': 'err.build_failed',
    'buy failed on Solana: transaction failed on-chain: {"InstructionError":[3,{"Custom":6001}]}': 'err.slippage',
  };
  for (const [msg, key] of Object.entries(cases)) {
    assert.equal(i18n.errorKey(msg), key, `"${msg.slice(0, 50)}…" is still unclassified`);
  }
  // The build failure must say the two things that decide what the user does
  // next: nothing was spent, and it is worth retrying.
  for (const lang of i18n.LANGS) {
    const out = i18n.errorText(lang, new Error('Jupiter swap-build failed (500)'), 'buy');
    assert.match(out, /nothing was sent|tidak ada yang dikirim/i, `${lang} does not say the money is safe`);
  }
});

test('the gas-moved message names the button to press, not a verb', () => {
  assert.match(i18n.errorText('en', new Error('nonce too low'), 'buy'), /tap Buy again/i);
  assert.match(i18n.errorText('id', new Error('nonce too low'), 'sell'), /Sell/);
});

// ---------------------------------------------------------------- reachability
test('a user can actually reach the language setting', () => {
  // The whole failure this fixes: the setting existed and nothing could change
  // it. A picker nobody can open is the same bug wearing a different hat.
  assert.match(TG, /text === '\/language'/, 'no /language command');
  assert.match(TG, /data === 'lang'/, 'Settings has no route to the picker');
  assert.match(TG, /k === 'setlang'/, 'no handler applies the choice');
  assert.match(TG, /core\.setLang\(chatId, ca\)/, 'the choice is never persisted');
  assert.match(TG, /btn\(i18n\.t\(core\.getLang\(chatId\), 'lang\.button'\)/, 'Settings shows no Language button');
});

test('the bot reads the stored language instead of assuming English', () => {
  // core.getLang existed and was exported for the bot's whole life without a
  // single caller. If this count goes back to zero, the feature is dead again.
  const reads = (TG.match(/core\.getLang\(/g) || []).length;
  assert.ok(reads > 0, 'nothing in the UI reads the user language');
});

test('⚠️ "no route" is a fact about the TOKEN and never reads as a hiccup', () => {
  // It used to match the err.no_price rule and come out as "Couldn't read live
  // pricing … please try again in a moment", under a 🔄 Try again button — so a
  // user whose token has no tradable pool was told to keep retrying, and did.
  for (const raw of [
    'no route / no liquidity for this token on Jupiter',
    'no liquidity / zero quote for this token on Base',
    'no liquidity / zero quote for this sell on Base',
  ]) {
    assert.equal(i18n.errorKey(new Error(raw)), 'err.no_route', raw);
    for (const lang of i18n.LANGS) {
      const msg = i18n.errorText(lang, new Error(raw), 'buy');
      assert.ok(msg.length > 20, `${lang} rendered empty`);
      // Never invite a retry that cannot succeed…
      assert.ok(!/try again in a moment|coba lagi sebentar/i.test(msg), `${lang} still says "try again in a moment": ${msg}`);
      // …and always say the money is untouched, which is the first thing
      // somebody asks when a buy fails on two wallets at once.
      assert.ok(/nothing was spent|tidak ada dana keluar/i.test(msg), `${lang} does not say nothing was spent`);
    }
  }
});

test('a pool READ that failed is still ours, and still worth retrying', () => {
  // The neighbouring string differs by two words and means the opposite: we
  // could not look, rather than there is nothing to look at.
  for (const raw of [
    'could not quote this buy on Base V3 (no pool? try again): boom',
    'could not price this buy on Base V3 (pool read failed)',
  ]) {
    assert.equal(i18n.errorKey(new Error(raw)), 'err.no_price', raw);
  }
});

test('a transport failure still outranks both — nothing was ever sent', () => {
  // Ordered first on purpose: "fetch failed" carries no words about routes, but
  // a host that never answered must not be reported as a token with no pool.
  for (const raw of ['fetch failed', "can't reach lite-api.jup.ag", 'getaddrinfo ENOTFOUND']) {
    assert.equal(i18n.errorKey(new Error(raw)), 'err.offline', raw);
  }
});
