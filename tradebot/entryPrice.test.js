'use strict';
/*
 * entryPrice.test.js — "ini baru beli lgsung minus 10%".
 *
 * A live Solana buy, 2026-08-16. Mint 92vgKci7…pump, one wallet, 0.1 SOL.
 *
 *   ✅ Bought $92vg…pump
 *   Spent: 0.099000 SOL ($7.46)
 *   Got:   129.16K $92vg…pump ($6.77)
 *   Entry: $0.0000524 · MC $50.07K
 *
 * and the Monitor that opens straight after it:
 *
 *   Invested:    0.09900 SOL ($7.46)
 *   Now worth:   0.08961 SOL ($6.75)
 *   Profit/Loss: −9.48%
 *   Price: $0.0000523 · Market cap: $49.91K
 *
 * NOTHING HERE IS ARITHMETICALLY WRONG, and that is the point. The Monitor's
 * P/L is correct: 0.099 SOL bought a bag worth 0.0896 SOL at mid. The token had
 * not moved — $0.0000524 to $0.0000523, 0.2%. The whole −9.48% is the cost of
 * the fill.
 *
 * What was wrong is that the receipt printed the CARD price under the label
 * "Entry". $0.0000524 is a price nobody paid; the fill was 0.099 / 129160 =
 * $0.0000578, 10.4% higher. So the two messages the bot sends back to back said:
 *
 *   • you entered at 0.0000524          (receipt, false)
 *   • price is 0.0000523, you are −9.48% (monitor, true)
 *
 * — which cannot both hold, and from inside Telegram reads as a bot that cannot
 * count rather than as a trade that cost 10% to open.
 *
 * The three fixes, each asserted below:
 *   1. "Entry" is spent ÷ received. The price the trade filled at.
 *   2. The gap is NAMED, with the −% the position will therefore open at.
 *   3. The Monitor prints the entry beside the price, so its own percentage is
 *      checkable on the card that states it.
 *
 * No network, no RPC.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const receipt = require('./receipt');
const i18n = require('./i18n');
const TG = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
const CORE = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');

// The trade as it actually happened.
const SOLUSD = 75.35;
const SPENT = 0.099, TOKENS = 129160, CARD_PX_SOL = 0.0000524 / SOLUSD;

// ── fillStats: the arithmetic, directly ──────────────────────────────────────

test('the realised entry is spent ÷ received, not the price on the card', () => {
  const f = receipt.fillStats({ spent: SPENT, tokens: TOKENS, refPxNative: CARD_PX_SOL, rate: SOLUSD });
  assert.ok(Math.abs(f.realPx - 0.0000578) < 1e-7, `realised entry ${f.realPx}, expected ~0.0000578`);
  assert.ok(Math.abs(f.refPx - 0.0000524) < 1e-7, `card price ${f.refPx}`);
  assert.notStrictEqual(f.realPx, f.refPx, 'the two prices are the same number — nothing was measured');
});

test('the fill was 10.4% above the card and the position therefore opens at −9.4%', () => {
  const f = receipt.fillStats({ spent: SPENT, tokens: TOKENS, refPxNative: CARD_PX_SOL, rate: SOLUSD });
  assert.ok(Math.abs(f.overPct - 10.4) < 0.3, `over by ${f.overPct.toFixed(2)}%`);
  assert.ok(Math.abs(f.downPct - 9.4) < 0.3, `opens at −${f.downPct.toFixed(2)}%`);
  // The reported Monitor read −9.48%, from cost 0.099 against a bag worth
  // 129160 × the current price. The card's own number reproduces from downPct,
  // which is what makes the receipt line an explanation rather than a guess.
  const worthNow = TOKENS * (0.0000523 / SOLUSD);
  assert.ok(Math.abs(((worthNow - SPENT) / SPENT) * 100 + 9.48) < 0.15, 'the reported P/L does not reproduce');
  // over and down are DIFFERENT numbers. Printing one as the other is the same
  // contradiction this file exists for, one level down.
  assert.ok(f.overPct > f.downPct);
});

test('a fill AT the card price is not flagged, and neither is ordinary pool fee', () => {
  const flat = receipt.fillStats({ spent: SPENT, tokens: SPENT / CARD_PX_SOL, refPxNative: CARD_PX_SOL, rate: SOLUSD });
  assert.ok(Math.abs(flat.offBy - 1) < 1e-9);
  assert.ok(!(flat.offBy > 1.02), 'an exact fill would print a warning');
  // 0.25% Raydium + a little impact: quiet.
  const ordinary = receipt.fillStats({ spent: SPENT, tokens: (SPENT / CARD_PX_SOL) / 1.004, refPxNative: CARD_PX_SOL, rate: SOLUSD });
  assert.ok(!(ordinary.offBy > 1.02), `0.4% over the card trips the note (${ordinary.offBy})`);
});

test('the ratio survives a dead USD feed — the prices do not pretend to', () => {
  // PRICES.SOL is 0 until the first Coinbase call lands and stays 0 while it
  // keeps failing. The warning must still fire: it is the one line on the
  // receipt that must not depend on an exchange being up.
  const f = receipt.fillStats({ spent: SPENT, tokens: TOKENS, refPxNative: CARD_PX_SOL, rate: 0 });
  assert.ok(Math.abs(f.offBy - 1.104) < 0.01, `offBy lost with no rate: ${f.offBy}`);
  // ...and a confident "$0.00" beside a real trade is worse than a blank.
  assert.strictEqual(f.realPx, null);
  assert.strictEqual(f.refPx, null);
});

test('no reference, no comparison — and no invented one', () => {
  const f = receipt.fillStats({ spent: SPENT, tokens: TOKENS, refPxNative: 0, rate: SOLUSD });
  assert.strictEqual(f.offBy, 0, 'a token the indexer has never seen gets a fabricated ratio');
  assert.strictEqual(f.overPct, 0);
  assert.ok(f.realPx > 0, 'the price we DO know was dropped along with the one we do not');
  // A trade that did not happen has no fill price at all.
  const none = receipt.fillStats({});
  assert.strictEqual(none.realPx, null);
  assert.strictEqual(none.offBy, 0);
});

// ── The receipt ──────────────────────────────────────────────────────────────

const SINGLE = TG.slice(TG.indexOf("const spent = Number(r.spentEth) || 0"), TG.indexOf("const exp2 = core.chainOf(r.chain);"));

test('the single-wallet receipt states what the trade filled at', () => {
  assert.ok(SINGLE.length > 200, 'the single-wallet receipt block moved — this test is asserting nothing');
  assert.match(SINGLE, /receipt\.fillStats\(\{ spent, tokens: got, refPxNative: snap && snap\.priceEth, rate: usdRate \}\)/);
  assert.match(SINGLE, /'buy\.receipt\.entry', \{ px: fstat\.realPx \}/);
  // The defect itself: the card price under the "Entry" label. It must not come
  // back — this is the exact expression that shipped.
  assert.ok(!/'buy\.receipt\.entry', \{ px: pxUsd\.toPrecision\(3\) \}/.test(SINGLE),
    'Entry is the card price again — the number nobody paid');
});

test('the gap is named on the receipt, with the loss it will open at', () => {
  assert.match(SINGLE, /fstat\.offBy > 1\.02 && fstat\.refPx != null/);
  assert.match(SINGLE, /'buy\.receipt\.vs_card', \{[\s\S]*?shown: fstat\.refPx, pct: fstat\.overPct\.toFixed\(1\), down: fstat\.downPct\.toFixed\(1\)/);
  // The same 1.15x escalation the multi-wallet path already used, so the two
  // receipts cannot disagree about when a fill is alarming.
  assert.match(SINGLE, /fstat\.offBy > 1\.15 \? ' ' \+ T\(chatId, 'buy\.receipt\.worse_than_shown'/);
});

test('the bot fee is on the receipt, because it left the wallet', () => {
  // 0.1 SOL in, 0.099 to the pool. The 1% was real money with nothing on any
  // card to account for it — and the difference is a tenth of the loss the user
  // was asking about.
  assert.match(SINGLE, /Number\(r\.feeEth\) > 0/);
  assert.match(SINGLE, /'buy\.receipt\.fee', \{[\s\S]*?native: r\.native/);
});

test('price impact and quote shortfall reach the user, not just the log', () => {
  assert.match(SINGLE, /Number\(r\.impactPct\) >= 1.*'buy\.receipt\.impact'/);
  assert.match(SINGLE, /Number\(r\.shortfall\) > 0\.01.*'buy\.receipt\.shortfall'/);
  // impactPct is a PERCENT here and a FRACTION at Jupiter. One conversion, in
  // core, or every screen re-guesses it.
  assert.match(CORE, /Math\.abs\(Number\(quote\.priceImpactPct\)\) \* 100 : 0;/);
  assert.match(CORE, /impactPct,/, 'the impact never reaches the caller');
});

test('both receipt paths use the same owner of the comparison', () => {
  // Two ideas of "how much worse than the card" is how the single-wallet path
  // ended up with none at all.
  const uses = TG.match(/receipt\.fillStats\(/g) || [];
  assert.ok(uses.length >= 2, `only ${uses.length} caller(s) — one path is re-deriving it`);
  assert.ok(!/\(totSpent \/ totTok\) \* mUsd/.test(TG), 'the multi-wallet path kept its own arithmetic');
});

// ── The Monitor ──────────────────────────────────────────────────────────────

test('the Monitor prints the entry beside the price it is measured against', () => {
  const mon = TG.slice(TG.indexOf('async function monitorPayload('), TG.indexOf('const _monitorByToken'));
  assert.match(mon, /const entryUsd = \(!closed && cost > 0 && pricedTokens > 0 && usdRate > 0\) \? \(cost \/ pricedTokens\) \* usdRate : 0;/);
  assert.match(mon, /📈 \$\{entryStr\}<b>Price:<\/b>/);
  // pricedTokens, never the whole bag: dividing a cost basis by a balance that
  // includes airdropped tokens invents an entry price nobody paid — the same
  // defect the P/L line's own split exists to prevent.
  assert.ok(!/cost \/ balNow/.test(mon), 'the entry is derived from the full balance again');
});

test('the entry price reproduces the reported card', () => {
  // cost 0.099 SOL over 129.16K costed tokens, at $75.35/SOL.
  const entry = (SPENT / TOKENS) * SOLUSD;
  assert.ok(Math.abs(entry - 0.0000578) < 1e-7);
  // Which is what makes "Entry $0.0000578 · Price $0.0000523" read as a −9.5%
  // position instead of as a bug.
  assert.ok(Math.abs(((0.0000523 / entry) - 1) * 100 + 9.5) < 0.3);
});

// ── Copy ─────────────────────────────────────────────────────────────────────

test('every new line is translated and carries its numbers', () => {
  for (const key of ['buy.receipt.vs_card', 'buy.receipt.fee', 'buy.receipt.impact', 'buy.receipt.shortfall']) {
    assert.ok(i18n._strings[key], `${key} missing`);
    assert.notStrictEqual(i18n._strings[key].en, i18n._strings[key].id, `${key} untranslated`);
  }
  const s = i18n.t('en', 'buy.receipt.vs_card', { shown: '0.0000524', pct: '10.4', down: '9.4' });
  assert.match(s, /0\.0000524/);
  assert.match(s, /10\.4% above/);
  assert.match(s, /−9\.4%/, 'the line does not say what the position will open at');
  // The minus sign is the typographic one, matching every other P/L line in the
  // bot — an ASCII hyphen beside a "−9.48%" is two glyphs disagreeing about
  // which part of one number is negative.
  assert.ok(!/-9\.4%/.test(s), 'ASCII hyphen in a signed figure');
  for (const lang of i18n.LANGS) {
    assert.match(i18n.t(lang, 'buy.receipt.fee', { amt: '0.001000', native: 'SOL', pct: '1' }), /0\.001000/);
  }
});
