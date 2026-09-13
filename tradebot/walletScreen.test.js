'use strict';
/*
 * walletScreen.test.js — the /wallet screen's layout invariants.
 *
 * The screen the user complained about rendered the ACTIVE wallet twice: once
 * as a detail block at the top under 🌐, once again in the list below under ✅,
 * with the same total rounded two different ways ("≈ $1.01K" vs "native
 * $999.62 · tokens $8.18"). Read top to bottom it looks like the bot listed a
 * wallet it had already listed and disagreed with itself about the number.
 *
 * These tests pin the layout rules rather than the wording, so the copy can be
 * edited (it lives in i18n.js) without the structure quietly regressing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
const walletFn = SRC.slice(SRC.indexOf('async function walletScreen('), SRC.indexOf('async function depositScreen('));

// ── Structure ────────────────────────────────────────────────────────────────

test('a wallet is rendered once — the active one is not also listed below', () => {
  // The list loop must SKIP the active wallet, because the detail block above
  // already is that wallet. Anything else double-prints it.
  const activeAt = walletFn.indexOf('if (!active) {');
  const othersAt = walletFn.indexOf('others +=');
  assert.ok(activeAt > -1, 'the list loop no longer skips the active wallet');
  assert.ok(othersAt > activeAt, 'the "other wallets" line is written outside the !active branch');
  assert.ok(!/body \+=/.test(walletFn), 'the old per-wallet body block is back');
});

test('one glyph per meaning: ✅ is the active wallet, ▫️ is every other', () => {
  // The old screen used 🌐 for the active wallet in the detail block and ✅ for
  // the same wallet in the list — two icons, one thing.
  assert.ok(!/🌐 <b>\$\{esc\(core\.walletLabel/.test(walletFn), 'the 🌐 wallet heading is back');
  assert.match(walletFn, /✅ <b>\$\{activeLabel\}/);
  assert.match(walletFn, /▫️ <b>\$\{esc\(label\)\}/);
});

test('money on this screen uses ONE formatter', () => {
  // fmt() switches to "K" at $1,000; usdX() does not. Mixing them is what
  // produced "≈ $1.01K" directly above "native $999.62 · tokens $8.18".
  const money = walletFn.match(/\$\$\{fmt\(/g) || [];
  assert.deepStrictEqual(money, [], 'fmt() is being used for a dollar figure on the wallet screen — use usdX()');
});

// ── Address safety ───────────────────────────────────────────────────────────

test('a shortened address is never tappable-to-copy', () => {
  // <code> makes Telegram copy the text on tap. A truncated address copied into
  // a withdraw field is funds sent nowhere, so short() must never appear inside
  // a <code> span. Full addresses are shown for the active wallet; every other
  // wallet's address comes from its 📥 button, which sends the real thing.
  assert.ok(!/<code>\$\{short\(/.test(walletFn), 'a shortened address is inside <code>');
  assert.match(walletFn, /<code>\$\{wAddr\(list\[awIdx\]/, 'the active wallet lost its full copyable address');
});

test('every wallet still has a way to get its own address', () => {
  assert.match(walletFn, /btn\('📥', 'qrw:' \+ w\.id\)/, 'the per-wallet deposit button is gone');
});

// ── Zero balances ────────────────────────────────────────────────────────────

test('chains holding nothing are summarised, not listed one per line', () => {
  assert.match(walletFn, /emptyChains\.push\(c\.name\)/);
  assert.match(walletFn, /wal\.empty_on/);
});

test("'empty' and 'we could not read it' stay different facts", () => {
  // A null is an RPC that did not answer, which means the total above is
  // understated. Folding it in with the genuine zeros hides that.
  assert.match(walletFn, /if \(b == null\) \{ unreadChains\.push\(c\.name\); continue; \}/);
  assert.match(walletFn, /wal\.unread_on/);
  // …and the same rule on the header's active-chain figure, which is the one
  // line a user reads to decide whether their deposit arrived.
  assert.match(walletFn, /const acUnread = acIdx < 0 \|\| matrix\.some\(\(row\) => row\[acIdx\] == null\)/);
  assert.match(walletFn, /wal\.on_chain_unread/);
});

test('a zero balance on the ACTIVE chain becomes a warning', () => {
  // The one zero worth a sentence: you cannot buy or pay gas on the chain you
  // are trading on. It was previously just another "Base: 0 ETH" row.
  assert.match(walletFn, /activeChainNative === 0/);
  assert.match(walletFn, /wal\.no_gas/);
});

// ── The active chain is not the total ────────────────────────────────────────
// The complaint this block exists for: switched to Solana, screen said
// "🟣 Solana" then "$1,322.54", and there was 0 SOL — the money was on
// Robinhood Chain. Every number was individually right and the layout still
// answered a question nobody asked.

test('the active chain has its own figure, summed over every wallet', () => {
  assert.match(walletFn, /const activeChainUsd = list\.reduce\(/);
  assert.match(walletFn, /b\.chain === ch\.key \? b\.usd : 0/, 'bags on the active chain are not counted into it');
  assert.match(walletFn, /wal\.on_chain/);
});

test('the all-chains total says so, and is only merged with the chain badge when they are equal', () => {
  assert.match(walletFn, /const oneChainOnly = !acUnread && Math\.abs\(activeChainUsd - grandUsd\) < 0\.005/);
  assert.match(walletFn, /wal\.total_all/);
  // The old unconditional "title · chain badge" header is what made the
  // all-chains total read as a per-chain one. It may only appear on the
  // collapsed branch, where the two numbers are the same number.
  const badge = walletFn.match(/wal\.title'\)\} · \$\{ch\.emoji\}/g) || [];
  assert.strictEqual(badge.length, 1, 'the chain badge is back on the header unconditionally');
});

test('the active chain is rendered first and never folded into the empty list', () => {
  // Rendering in registry order put the chain being traded on wherever it
  // landed — for Solana, dead last, under "Nothing yet on … · Solana", one line
  // above a warning saying the same thing.
  assert.match(walletFn, /cells\.filter\(\(x\) => x\.c\.key === ch\.key\), \.\.\.cells\.filter\(\(x\) => x\.c\.key !== ch\.key\)/);
  assert.match(walletFn, /if \(!\(amt > 0\)\) \{ if \(!isActive\) emptyChains\.push\(c\.name\); continue; \}/);
  assert.match(walletFn, /chainBlock = activeChainLine \+ chainBlock/);
});

test('the deposit address for the chain you are on comes first', () => {
  assert.match(walletFn, /const addrBlock = core\.chains\.isSvm\(ch\.key\) \? solAddrBlock \+ evmAddrBlock : evmAddrBlock \+ solAddrBlock/);
});

// ── Length ───────────────────────────────────────────────────────────────────

test('the screen cannot outgrow a Telegram message', () => {
  // sendMessage caps at 4096 and tg() does not check the response, so an
  // oversized wallet screen fails with no error anywhere — the user taps
  // /wallet and nothing happens. The old layout spent ~340 chars per wallet
  // (two full addresses each) and fitted 10 with ~150 chars to spare, so
  // raising MAX_WALLETS_PER_USER — which core.js allows up to 99 — broke it.
  //
  // Only the ACTIVE wallet is detailed now, so growth is one short line per
  // extra wallet. This reproduces that arithmetic against the real cap.
  const NAME = 24; // core.renameWallet caps a custom name at 24 chars
  const fixed = 900; // head + chain rows + both addresses + roll-up + hint, generously
  const budget = Number(/OTHERS_MAX_CHARS = (\d+)/.exec(walletFn)[1]);
  const perExtraWallet = `▫️ <b>${'W'.repeat(NAME)}</b> · $1,234,567.89 · 99 open\n`.length;
  for (const cap of [10, 25, 50, 99]) {
    // The list stops at the budget; the rest becomes one roll-up line.
    const listed = Math.min(cap - 1, Math.ceil(budget / perExtraWallet));
    const total = fixed + perExtraWallet * listed;
    assert.ok(total < 4096, `at MAX_WALLETS_PER_USER=${cap} the screen renders ~${total} chars (limit 4096)`);
  }
});

test('wallets dropped from the list are announced, not hidden', () => {
  assert.match(walletFn, /rolledUp\+\+/);
  assert.match(walletFn, /wal\.more/);
  // …and they keep their button, which is the ONLY reason dropping a row from
  // the text is acceptable. So the button must be built unconditionally —
  // outside the `if (!active)` branch that the roll-up lives in.
  const loop = walletFn.slice(walletFn.indexOf('list.forEach'), walletFn.indexOf('if (list.length < core.WALLET_CAP)'));
  const activeAt = loop.indexOf('if (!active) {');
  const branchEnd = loop.indexOf('\n    }', activeAt);
  const rowAt = loop.indexOf('const row = [btn(');
  assert.ok(activeAt > -1 && branchEnd > -1, 'the !active branch moved — re-check this test');
  assert.ok(rowAt > branchEnd, 'the per-wallet button is inside the !active branch — rolled-up wallets would lose it');
  assert.match(loop, /kbRows\.push\(row\)/);
});

// ── Copy ─────────────────────────────────────────────────────────────────────

test('the wallet copy is translated, not hardcoded English', () => {
  // A large share of this bot's users trade in Indonesian (see i18n.js). The
  // wallet screen was one of the biggest remaining blocks of English literals.
  const i18n = require('./i18n');
  // 'wal.total' is exempt: it is now "💰 Total: {usd}" and "Total" is the same
  // word in both languages — demanding a difference would manufacture a fake
  // translation just to satisfy this loop.
  for (const key of ['wal.title', 'wal.total_all', 'wal.on_chain', 'wal.on_chain_unread',
    'wal.split', 'wal.active_head', 'wal.others_head', 'wal.empty_on', 'wal.unread_on', 'wal.no_gas',
    'wal.gas_elsewhere', 'wal.hint', 'wal.first_steps']) {
    assert.ok(i18n._strings[key], `${key} missing`);
    assert.notStrictEqual(i18n._strings[key].en, i18n._strings[key].id, `${key} was not actually translated`);
  }
});

test('the jargon is gone', () => {
  assert.ok(!/Tokens \(bags\)/.test(SRC), '"Tokens (bags)" is back — it is our word, not the reader\'s');
});

// ── The tokens screen ────────────────────────────────────────────────────────
// "You hold $24.87 in tokens" with no way to find out WHICH tokens, on WHICH
// chain. /portfolio could not answer it: core.portfolioAll skips every position
// whose chain is not the active one, so a bag on any other chain had no screen.

const tokensFn = SRC.slice(SRC.indexOf('async function tokensScreen('), SRC.indexOf('// Maestro-style deposit'));

test('the tokens screen covers every enabled chain, not just the active one', () => {
  assert.match(tokensFn, /core\.chains\.enabledChains\(\)/);
  assert.match(tokensFn, /new Set\(allChains\.map\(\(c\) => c\.key\)\)/,
    'the token list is being scoped to one chain — that is the gap this screen exists to close');
});

test('the total here and the total on the wallet screen come from one computation', () => {
  // Two screens deriving "how much in tokens" separately is how they end up
  // disagreeing, and a user who sees two numbers trusts neither.
  assert.match(tokensFn, /await walletTokenUsd\(list,/);
  assert.match(walletFn, /await walletTokenUsd\(list,/);
  assert.match(walletFn, /bagsToUsd\(tokenBags\)/);
});

test('an unreadable price is never rendered as $0.00', () => {
  // It is not zero, and printing zero both understates the total and tells the
  // holder of 900K tokens that they have nothing.
  assert.match(tokensFn, /r\.unpriced && !\(r\.usd > 0\) \? T\(chatId, 'tok\.no_price'\)/);
  assert.match(tokensFn, /blind === items\.length \? T\(chatId, 'tok\.no_price'\)/,
    'a chain whose every bag is unpriced still heads its section with a dollar figure');
  assert.match(tokensFn, /const tag = r\.unpriced && !\(r\.usd > 0\) \? fmt\(r\.tokens\)/,
    'the button label still claims a price for an unpriced bag');
});

test('a token row says which chain and which wallet', () => {
  // The whole question being answered: what do I hold, and where.
  assert.match(tokensFn, /c\.emoji.*esc\(c\.name\)/);
  assert.match(tokensFn, /r\.holders\.join/);
});

test('tapping a token opens the card callback that already exists', () => {
  // A second parser for the same action is a second thing to keep in sync.
  assert.match(tokensFn, /`tok:\$\{r\.chain\}::\$\{r\.ca\}`/);
  assert.ok(/if \(data === 'toks'\)/.test(SRC), 'the refresh callback is not registered');
  assert.ok(/text === '\/tokens'/.test(SRC), 'the /tokens command is not registered');
});

test('the screen admits what it cannot see', () => {
  // Positions are what the bot BOUGHT. A token transferred in from another
  // wallet was never recorded, and silently omitting it invites the conclusion
  // that the bot lost it.
  const i18n = require('./i18n');
  assert.match(i18n._strings['tok.note'].en, /sent in from another wallet is not tracked/);
  assert.match(i18n._strings['tok.note'].id, /kiriman dari wallet lain/);
});

// ── each OTHER wallet shows what it holds, not just what it is worth ────────
//
// "copy writing so bad untuk tampilan wallet berikan yang detail masing2 …
// tapi tidak spam, clean" — the rows under "Your other wallets" read
// "Wallet 2 · $671.62", which answers none of the questions the screen is
// opened with: which chain the money sits on, coins or bags, can it pay gas.
// The matrix already read every wallet × every chain for the totals, so the
// breakdown costs nothing extra.
const SRC2 = require('node:fs').readFileSync(require('node:path').join(__dirname, 'telegram.js'), 'utf8');
const OTHERS = SRC2.slice(SRC2.indexOf('// WHAT the wallet holds'), SRC2.indexOf('else { rolledUp++;'));

test('other wallets carry a one-line per-chain breakdown', () => {
  assert.ok(OTHERS.length > 300, 'the breakdown block moved — this test is asserting nothing');
  // Built from the SAME matrix as the totals — a second read would be a second
  // chance to disagree with the number above it.
  assert.match(OTHERS, /\(matrix\[i\] \|\| \[\]\)\.forEach/);
  assert.match(OTHERS, /bits\.push\(`\$\{allChains\[ci\]\.emoji\} \$\{\+amt\.toFixed\(4\)\} \$\{allChains\[ci\]\.native\}`\)/);
  // Clean: zero chains get NO segment (the active block already established
  // zeros are noise), and an empty wallet gets no breakdown line at all.
  assert.match(OTHERS, /if \(!\(amt > 0\)\) return;/);
  assert.match(OTHERS, /bits\.length \? `└ \$\{bits\.join\(' · '\)\}\\n` : ''/);
});

test('bags collapse to one figure and unread chains are counted, not hidden', () => {
  // A wallet whose reads all failed must not render as empty — "empty" and "we
  // could not look" are different facts, the rule the active block already keeps.
  // ⚠️ THE RULE, NOT THE SPELLING. This pinned `unread++` and `{ n: unread }`,
  // so it went red the day the row started NAMING the chain — which is what the
  // count could never do, and why "masih 1 chain unread" had to be reported with
  // a screenshot. The property is that a null is neither dropped nor rendered as
  // a zero; WHICH chain reaches the row is driven in walletRender.test.js.
  assert.match(OTHERS, /if \(b == null\) \{ [A-Za-z]+\.push\(allChains\[ci\]\.name\); return; \}/,
    'an unread cell is collected by NAME, never skipped and never counted as 0');
  assert.match(OTHERS, /bits\.push\(T\(chatId, 'wal\.row_unread'/, '…and reaches the row');
  assert.match(OTHERS, /tokenUsdArr\[i\] \|\| 0\) > 0\.05/);
  const i18n = require('./i18n');
  for (const lang of i18n.LANGS) {
    assert.match(i18n.t(lang, 'wal.row_unread', { chains: 'Solana' }), /Solana/, `${lang} drops the chain name`);
  }
});

test('the breakdown respects the character budget — rolled-up wallets stay rolled up', () => {
  // The whole block sits inside the `others.length < OTHERS_MAX_CHARS` branch,
  // so a 99-wallet account still fits under Telegram's 4096 and the overflow
  // still rolls into the "…and N more" line instead of silently truncating.
  const branch = SRC2.slice(SRC2.indexOf('if (others.length < OTHERS_MAX_CHARS) {'), SRC2.indexOf('else { rolledUp++;'));
  assert.ok(branch.includes('└'), 'the breakdown escaped the budgeted branch');
});
