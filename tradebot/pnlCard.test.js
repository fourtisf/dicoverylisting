'use strict';
/*
 * pnlCard.test.js — "/pnl … kasih pnl stlh udh dijual atau blm dijual".
 *
 * The question /portfolio cannot answer: a bag that has been SOLD leaves that
 * screen entirely, so the bot could tell you what you are exposed to and never
 * what you made. pnl.js is a pure renderer, so these call the arithmetic
 * directly instead of reading telegram.js with a regex.
 *
 * The rules, each one a way a PnL card lies:
 *   • a price we could not read is UNKNOWN, never zero — reporting it as zero
 *     prints a 100% loss that did not happen, on the one card people screenshot;
 *   • a half-sold bag is neither "holding" nor "closed";
 *   • a token never traded here gets "no trades on file", not a zero;
 *   • the book leaves an unpriced row OUT of the total rather than summing it
 *     as zero, and says how many it left out.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const pnl = require('./pnl');

const plain = (s) => s.replace(/<[^>]+>/g, '');
/** core.tokenPnl()-shaped. */
const P = (o = {}) => ({
  ca: '0xabc', chain: 'robinhood', sym: 'PONS', name: 'Pons', dec: 18, traded: true,
  open: false, tokens: 0, holders: [], priced: true, priceEth: 0, valueEth: 0,
  ethIn: 0, ethOut: 0, costEth: 0, realizedEth: 0, unrealizedEth: 0,
  trades: { buys: 1, sells: 0, firstAt: Date.now() - 3600000, lastAt: Date.now(), capped: true },
  ...o,
});

// ── the three states ─────────────────────────────────────────────────────────

test('a CLOSED trade still reports what it made', () => {
  // 1 in, 3 back, nothing held: +2, 3.00x. The position record survives being
  // sold to zero precisely so this can be answered.
  const s = pnl.pnlStats(P({ ethIn: 1, ethOut: 3, realizedEth: 2 }));
  assert.equal(s.status, 'closed');
  assert.equal(s.pnl, 2);
  assert.equal(s.mult, 3);
  assert.ok(Math.abs(s.pct - 200) < 1e-9);
  const txt = plain(pnl.pnlText(P({ ethIn: 1, ethOut: 3, realizedEth: 2 }), { native: 'SOL', rate: 200 }));
  assert.match(txt, /CLOSED/);
  assert.match(txt, /\+200\.00%/);
  assert.match(txt, /3\.00×/);
  assert.match(txt, /\+2\.0000 SOL/);
  assert.match(txt, /\$400/, 'the USD value of the profit is missing');
});

test('a HOLDING bag reports the open profit, not a realized one', () => {
  // 1 in, nothing out, bag worth 1.5 → +0.5 unrealized.
  const p = P({ open: true, tokens: 1000, priceEth: 0.0015, valueEth: 1.5, ethIn: 1, costEth: 1, unrealizedEth: 0.5 });
  const s = pnl.pnlStats(p);
  assert.equal(s.status, 'holding');
  assert.ok(Math.abs(s.pnl - 0.5) < 1e-12);
  const txt = plain(pnl.pnlText(p, { native: 'SOL', rate: 200 }));
  assert.match(txt, /HOLDING/);
  assert.match(txt, /Still holding/);
  assert.match(txt, /1,000/, 'the bag is not stated in token units');
  assert.ok(!/Taken out/.test(txt), 'a bag that was never sold claims proceeds');
});

test('a PARTLY SOLD bag is neither holding nor closed, and shows both halves', () => {
  const p = P({ open: true, tokens: 500, priceEth: 0.002, valueEth: 1, ethIn: 1, ethOut: 0.8,
    costEth: 0.5, realizedEth: 0.3, unrealizedEth: 0.5 });
  const s = pnl.pnlStats(p);
  assert.equal(s.status, 'partial');
  // Money view: 0.8 back + 1 held − 1 in = +0.8.
  assert.ok(Math.abs(s.pnl - 0.8) < 1e-12);
  const txt = plain(pnl.pnlText(p, { native: 'SOL', rate: 0 }));
  assert.match(txt, /PARTLY SOLD/);
  assert.match(txt, /booked \+0\.3000 SOL/, 'the realized half is missing');
  assert.match(txt, /open \+0\.5000 SOL/, 'the unrealized half is missing');
  // `$PONS` is the ticker; a USD figure is a $ followed by a digit. With no
  // price feed the card must state native only — never a confident $0.
  assert.ok(!/\$\d/.test(txt), 'a card with no USD feed invented dollar figures');
});

// ── the lies it must not tell ────────────────────────────────────────────────

test('an unreadable price is UNKNOWN — never a 100% loss', () => {
  // The /portfolio lesson: `priced:false` used to mean valueEth 0, which made
  // unrealized = minus the entire cost basis on a network blip.
  const p = P({ open: true, tokens: 1000, priced: false, priceEth: 0, valueEth: 0, ethIn: 1, costEth: 1, unrealizedEth: null });
  const s = pnl.pnlStats(p);
  assert.strictEqual(s.pnl, null, 'an unknown price produced a total anyway');
  assert.strictEqual(s.pct, null);
  assert.strictEqual(s.mult, null);
  const txt = plain(pnl.pnlText(p, { native: 'SOL', rate: 200 }));
  assert.match(txt, /Couldn't price it just now/);
  assert.ok(!/-100|−100/.test(txt), 'an unpriced bag printed a 100% loss');
  assert.ok(!/%/.test(txt.split('Invested')[0].replace(/Couldn't[^\n]*/, '')), 'a percentage was printed against an unknown value');
});

test('the share of supply prints only when the supply is known', () => {
  // "harus ada berapa % dari supply". null supply = no phrase — never "0.00%".
  const held = P({ open: true, tokens: 500, priced: true, priceEth: 0.001, valueEth: 0.5, ethIn: 1, costEth: 1, unrealizedEth: -0.5, supplyPct: 0.05 });
  const txt = plain(pnl.pnlText(held, { native: 'SOL', rate: 0 }));
  assert.match(txt, /0\.050% of supply/);
  const noSup = P({ open: true, tokens: 500, priced: true, priceEth: 0.001, valueEth: 0.5, ethIn: 1, costEth: 1, unrealizedEth: -0.5 });
  assert.ok(!/of supply/.test(plain(pnl.pnlText(noSup, { native: 'SOL', rate: 0 }))), 'an unknown supply rendered as a share');
  // The formatter's edges: precision scales down, and below it the string
  // says "<" instead of rounding a real position to nothing.
  assert.equal(pnl.share(12.3456), '12.35%');
  assert.equal(pnl.share(0.034), '0.034%');
  assert.equal(pnl.share(0.0001), '&lt;0.01%');
  assert.equal(pnl.share(null), '');
  assert.equal(pnl.share(0), '');
});

test('the card is valid HTML for Telegram — no bare < outside a tag', () => {
  // A raw '<' that does not open a supported tag makes Telegram reject the
  // WHOLE message (400 "can't parse entities"), and a 400 is an answer, not a
  // transport error — queuedSend does not retry it, so the card is simply
  // gone. `share()` returned a literal '<0.01%' and would have deleted the
  // receipt, the monitor card and the PnL card for any ordinary buy on a
  // large-supply token. Strip every real tag, then nothing may be left.
  const TAG = /<\/?(?:b|i|u|s|code|pre|a|tg-spoiler|blockquote)(?:\s[^>]*)?>/g;
  for (const p of [
    P({ open: true, tokens: 500, priced: true, priceEth: 0.001, valueEth: 0.5, ethIn: 1, costEth: 1, unrealizedEth: -0.5, supplyPct: 0.0001 }),
    P({ open: true, tokens: 5, priced: true, priceEth: 1, valueEth: 5, ethIn: 1, costEth: 1, unrealizedEth: 4, supplyPct: 12.5 }),
    P({ ethIn: 1, ethOut: 3, realizedEth: 2 }),
  ]) {
    const out = pnl.pnlText(p, { native: 'SOL', rate: 200, chainLabel: 'Solana' });
    assert.ok(!out.replace(TAG, '').includes('<'), 'a bare < survived — Telegram would 400 the whole card');
  }
});

test('a token never traded here says so, and does not invent a zero', () => {
  const txt = plain(pnl.pnlText(P({ traded: false, ethIn: 0 }), { native: 'SOL', rate: 200 }));
  assert.match(txt, /No trades on file/);
  assert.ok(!/0\.00%/.test(txt), 'a never-traded token was reported as a 0% trade');
  // …but a bag held anyway (sent in, or bought elsewhere) is stated, with the
  // reason there is nothing to measure against.
  const held = plain(pnl.pnlText(P({ traded: false, open: true, tokens: 42, priceEth: 0.01, priced: true }), { native: 'SOL', rate: 200 }));
  assert.match(held, /You hold/);
  assert.match(held, /no cost basis/i);
});

test('a losing trade is signed, and never reads as a win', () => {
  const s = pnl.pnlStats(P({ ethIn: 1, ethOut: 0.25, realizedEth: -0.75 }));
  assert.equal(s.win, false);
  const txt = plain(pnl.pnlText(P({ ethIn: 1, ethOut: 0.25, realizedEth: -0.75 }), { native: 'SOL', rate: 200 }));
  assert.match(txt, /−75\.00%/);
  assert.match(txt, /−0\.7500 SOL/);
  assert.match(txt, /🔴/, 'a loss is not marked as one');
});

// ── the book ─────────────────────────────────────────────────────────────────

test('the book totals only what it could price, and says what it left out', () => {
  const rows = [
    P({ sym: 'WIN', ethIn: 1, ethOut: 3 }),
    P({ sym: 'LOSS', ethIn: 1, ethOut: 0.2 }),
    P({ sym: 'DARK', open: true, tokens: 5, priced: false, ethIn: 2, costEth: 2, unrealizedEth: null }),
  ];
  const txt = plain(pnl.pnlBook(rows, { native: 'SOL', rate: 0 }));
  // +2 and −0.8 → +1.2 net, from the two priced rows only.
  assert.match(txt, /\+1\.2000 SOL/, 'the net is wrong or the unpriced row was summed as zero');
  assert.match(txt, /1W \/ 1L/);
  assert.match(txt, /price unavailable/);
  assert.match(txt, /1 position\(s\) left out/);
  assert.match(txt, /\$WIN/); assert.match(txt, /\$DARK/);
});

test('an empty book invites the first trade instead of printing zeros', () => {
  const txt = plain(pnl.pnlBook([], { native: 'SOL' }));
  assert.match(txt, /No positions/);
  assert.ok(!/0\.00%/.test(txt));
});

// ── formatting rules this repo already paid for ──────────────────────────────

test('token amounts are GROUPED, not compressed like a market cap', () => {
  // "10.28M" is right for a market cap and wrong for the number in a wallet.
  assert.equal(pnl.qty(10279471.93), '10,279,471.93');
  assert.ok(!/M$/.test(pnl.qty(10279471.93)));
});

test('the sign is always explicit', () => {
  assert.match(pnl.sgn(1.5), /^\+/);
  assert.match(pnl.sgn(-1.5), /^−/);
  assert.equal(pnl.sgn(0).startsWith('+'), false);
});

// ── the engine, against a real store ─────────────────────────────────────────
// The renderer above is pure; these drive core.tokenPnl itself, because the
// defect this section exists for was in the READ, not in the words.

const os = require('node:os');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pnlcard-'));
process.env.WALLET_SECRET = 'w'.repeat(48);
process.env.TRADEBOT_TOKEN = 'x:y';
process.env.ENABLED_CHAINS = 'robinhood,solana';
const core = require('./core');
const CHAT = 8801, CH = 'robinhood';
const TOK = '0x' + 'b'.repeat(40);
function seed() {
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.wallets = [{ id: 'w1', name: '', address: '0x' + '1'.repeat(40), positions: {}, orders: [], history: [] }];
  u.activeWalletId = 'w1'; u.activeChain = CH;
  u.wallets[0].positions[core.posKey(CH, TOK)] = {
    chain: CH, ca: TOK, name: 'Bag Token', sym: 'BAG', dec: 18,
    ethIn: 2, ethOut: 0, realizedEth: 0, tokens: (1000n * 10n ** 18n).toString(), costEth: 2,
  };
  return u;
}

test('an unreadable BALANCE never renders as a closed position', async () => {
  // The defect this pins, caught by rendering a real card: the balance read was
  // `.catch(() => 0n)`, so one RPC blip made a bag the user still fully holds
  // report "🏁 CLOSED" and "−100%" — the /portfolio price lesson, one field
  // over, and worse here because this is the card people screenshot.
  seed();
  const realBal = core.tokenBalanceOrNull, realSnap = core.tokenSnapshot;
  core.tokenBalanceOrNull = async () => null;          // RPC down
  core.tokenSnapshot = async () => ({ priceEth: 0.003 });
  let p;
  try { p = await core.tokenPnl(CHAT, TOK, CH); }
  finally { core.tokenBalanceOrNull = realBal; core.tokenSnapshot = realSnap; }
  assert.equal(p.balUnknown, true);
  assert.equal(p.open, true, 'an unreadable balance was reported as sold');
  assert.equal(p.priced, false, 'a total was derived from a balance we could not read');
  assert.strictEqual(p.pnlEth, null);
  const txt = plain(pnl.pnlText(p, { native: 'ETH', rate: 2000 }));
  assert.ok(!/CLOSED/.test(txt), 'a live bag was reported as closed');
  assert.ok(!/−100/.test(txt), 'a 100% loss was invented from a failed read');
  // …and it names WHICH read failed: sending the user to look at the pool when
  // the RPC was the problem is a different answer to a different question.
  assert.match(txt, /read your balance/i);
});

test('a live bag reads as HOLDING, and a sold one keeps its history', async () => {
  const u = seed();
  const realBal = core.tokenBalanceOrNull, realSnap = core.tokenSnapshot;
  core.tokenBalanceOrNull = async () => 1000n * 10n ** 18n;
  core.tokenSnapshot = async () => ({ priceEth: 0.003 });
  try {
    const held = await core.tokenPnl(CHAT, TOK, CH);
    assert.equal(held.open, true);
    assert.equal(pnl.pnlStats(held).status, 'holding');
    assert.ok(Math.abs(pnl.pnlStats(held).pnl - 1) < 1e-9, '2 in, 3 held → +1');
    // Now sell it all: the position record SURVIVES, which is what makes a
    // closed trade answerable at all.
    const pos = u.wallets[0].positions[core.posKey(CH, TOK)];
    pos.tokens = '0'; pos.costEth = 0; pos.closed = true; pos.ethOut = 3.5; pos.realizedEth = 1.5;
    core.tokenBalanceOrNull = async () => 0n;
    const sold = await core.tokenPnl(CHAT, TOK, CH);
    assert.equal(sold.open, false);
    assert.equal(sold.traded, true, 'a sold position stopped being reportable');
    assert.ok(Math.abs(pnl.pnlStats(sold).pnl - 1.5) < 1e-9, '2 in, 3.5 out → +1.5');
    assert.match(plain(pnl.pnlText(sold, { native: 'ETH', rate: 0 })), /CLOSED/);
  } finally { core.tokenBalanceOrNull = realBal; core.tokenSnapshot = realSnap; }
});

test('a token this bot never traded is "no trades", not a zero trade', async () => {
  seed();
  const realBal = core.tokenBalanceOrNull, realMeta = core.tokenMeta;
  core.tokenBalanceOrNull = async () => 0n;
  core.tokenMeta = async () => ({ sym: 'NEW', name: 'New', decimals: 18 });
  try {
    const p = await core.tokenPnl(CHAT, '0x' + 'e'.repeat(40), CH);
    assert.equal(p.traded, false);
    assert.match(plain(pnl.pnlText(p, { native: 'ETH', rate: 0 })), /No trades on file/);
  } finally { core.tokenBalanceOrNull = realBal; core.tokenMeta = realMeta; }
});

// ── the picture ──────────────────────────────────────────────────────────────
// The image is an UPGRADE: where it cannot be drawn the text card is sent
// instead, so every one of these is about it refusing honestly rather than
// drawing something it cannot stand behind.

const img = require('./pnlImage');

test('the image refuses to state what it cannot know', async () => {
  // A branded card is a CLAIM. "we could not read your balance just now" is a
  // sentence; there is no way to draw it as a 4.25× without lying, so those
  // fall back to the text card, which says so in words.
  const unpriced = P({ open: true, tokens: 5, priced: false, balUnknown: true, ethIn: 1, costEth: 1, unrealizedEth: null });
  assert.strictEqual(await img.render(unpriced, { native: 'SOL' }), null, 'an unknown was drawn as a number');
  assert.strictEqual(await img.render(P({ traded: false, ethIn: 0 }), { native: 'SOL' }), null, 'a never-traded token got a PnL card');
  // Nothing invested = no multiple to draw.
  assert.strictEqual(await img.render(P({ ethIn: 0, ethOut: 0 }), { native: 'SOL' }), null);
});

test('a card is drawn for a win, a loss and a bag still held', async (t) => {
  if (!img.available()) return t.skip('canvas not installed in this checkout');
  const cases = {
    win: P({ ethIn: 1.2, ethOut: 5.1, realizedEth: 3.9 }),
    loss: P({ ethIn: 2, ethOut: 0.42, realizedEth: -1.58 }),
    held: P({ open: true, tokens: 1000, priceEth: 0.003, valueEth: 3, ethIn: 2, costEth: 2, unrealizedEth: 1, entryEth: 0.002 }),
  };
  for (const [k, p] of Object.entries(cases)) {
    const buf = await img.render(p, { native: 'SOL', rate: 200, chainName: 'Solana' });
    assert.ok(Buffer.isBuffer(buf) && buf.length > 5000, `${k} produced no card`);
    // A PNG, and one Telegram will accept as a photo.
    assert.equal(buf.slice(1, 4).toString('ascii'), 'PNG');
    assert.ok(buf.length < 10 * 1024 * 1024, `${k} is too large to send`);
  }
});

test('no logo and no QR is the DESIGN, not a degraded card', async (t) => {
  if (!img.available()) return t.skip('canvas not installed in this checkout');
  // A token this bot snipes at launch has no art at any index yet, and a card
  // that looked broken without one would be broken most of the time it matters.
  const buf = await img.render(P({ ethIn: 1, ethOut: 2.5, realizedEth: 1.5 }), { native: 'SOL', rate: 200, chainName: 'Solana' });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 5000, 'the card needs a logo to draw at all');
  // …and an unreachable image host must not take the card with it.
  const withDead = await img.render(P({ ethIn: 1, ethOut: 2.5, realizedEth: 1.5 }),
    { native: 'SOL', rate: 200, logoUrl: 'http://127.0.0.1:9/nope.png', refLink: 'https://t.me/x?start=y', qrApi: 'http://127.0.0.1:9' });
  assert.ok(Buffer.isBuffer(withDead) && withDead.length > 5000, 'a dead image host took the whole card down');
});

test('the image is optional — a box without canvas still answers', () => {
  // `available()` is the only thing callers may branch on, and the caller sends
  // the text card when it is false. Pinned because a require() that throws at
  // load time would take the whole bot down instead of the picture.
  assert.equal(typeof img.available(), 'boolean');
  const TG = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  const fn = TG.slice(TG.indexOf('async function sendPnlCard('), TG.indexOf('async function pnlBookScreen('));
  assert.match(fn, /pnlImage\.available\(\)/);
  assert.match(fn, /return send\(chatId, s\.text, s\.kb\)/, 'there is no text fallback');
  // A failed upload must fall through too, not leave the user with nothing.
  assert.match(fn, /if \(buf && await sendPhotoBuffer\(/);
  assert.match(fn, /catch \(e\) \{ console\.error\('\[pnl\] render failed/, 'a throwing draw takes the reply with it');
});

test('the card draws through canvasKit, so the font guard is not re-implemented', () => {
  // A token called 牛来 went out as "$???" because a face without the glyph draws
  // a box instead of throwing. warnBoxes() is the guard, it lives in canvasKit,
  // and every renderer in this repo is required to call it — a second copy of
  // the font logic in tradebot would be that outage waiting on a second process.
  const SRC = fs.readFileSync(path.join(__dirname, 'pnlImage.js'), 'utf8');
  assert.match(SRC, /canvasKit/, 'the card grew its own canvas plumbing');
  assert.match(SRC, /K\.warnBoxes\('pnl card'/, 'the missing-glyph guard is not called');
  assert.ok(!/registerFont|GlobalFonts/.test(SRC), 'the card registers its own fonts — canvasKit owns that');
  // …and the brand comes from the kit too, not from hex codes typed again here.
  assert.ok(!/#4EE6A8|#38D8F0/.test(SRC), 'brand colours were copied instead of imported');
});

// ── reachability ─────────────────────────────────────────────────────────────

test('a user can actually reach it: command, menu, paste and the token card', () => {
  const TG = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  assert.match(TG, /text === '\/pnl' \|\| text\.startsWith\('\/pnl '\)/, 'no /pnl command');
  assert.match(TG, /\{ command: 'pnl',/, "/pnl is not in Telegram's command menu");
  assert.match(TG, /btn\('📊 PnL', 'pnl'\)/, 'the main menu has no PnL entry');
  assert.match(TG, /btn\('📊 PnL', `pnlt:\$\{chainKey\}:\$\{ca\}`\)/, 'the token card has no PnL button — pasting a CA is the way in');
  assert.match(TG, /if \(p\.action === 'pnl_ca'\)/, 'pasting a contract into the PnL flow does nothing');
  // The chain is DETECTED from the pasted address, never assumed: a Solana mint
  // answered against the active EVM chain would report "no trades on file" —
  // a false statement about the user's own money.
  const branch = TG.slice(TG.indexOf("if (p.action === 'pnl_ca')"), TG.indexOf("if (p.action === 'snw_dev')"));
  assert.match(branch, /await detectChain\(chatId, raw\)/);
});
