'use strict';
/*
 * walletReceipt.test.js — one wallet, one receipt.
 *
 * The complaint, with a screenshot of a competitor attached: a multi-wallet
 * trade produced a SINGLE message, and only after `Promise.allSettled` had
 * resolved every wallet, with the wallets reduced to bullet points inside it.
 * Two things wrong with that, and the user named both:
 *
 *   1. Nothing arrives until the SLOWEST wallet settles. Four fills in two
 *      seconds and a fifth that takes twenty means twenty seconds of empty chat
 *      and then the whole batch at once — a bot that is genuinely fast reading
 *      as one that had hung.
 *   2. A bullet is not a receipt. It cannot carry the token, the amount in
 *      token units, the market cap and a transaction button, and checking ONE
 *      wallet is the first thing anyone does after a trade.
 *
 * receipts.test.js still holds the COMBINED receipt (now opt-in) to its
 * contract. This file holds the per-wallet receipts to the SAME standard — a
 * transaction on every wallet that traded, none on one that did not, readable
 * amounts, a dollar figure, and never a confident $0.00 — plus the two things
 * only this mode can get wrong: arriving late, and arriving out of order.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walletreceipt-'));
process.env.WALLET_SECRET = 'w'.repeat(48);
process.env.TRADEBOT_TOKEN = 'x:y';
process.env.ENABLED_CHAINS = 'robinhood';

const core = require('./core');
const tg = require('./telegram');
const receipt = require('./receipt');
const i18n = require('./i18n');

const CA = '0x39dBED3a2bd333467115dE45665cC57F813C4571';
const CHAIN = 'robinhood';
const CHAT = 11;
// The name is deliberately NOT just the ticker in different case: header()
// drops a name that only repeats the ticker (see the test for that below), so
// "Pons"/"PONS" would silently exercise the wrong branch here.
const SNAP = { sym: 'PONS', name: 'Pons Finance', priceEth: 0.00001453, mcapUsd: 27_200_000 };

/** Run a real multi-wallet trade and return EVERY message the user was sent. */
async function trade(side, {
  wallets = 4, rate = 1858, snap = SNAP, style = 'per_wallet',
  firstFails = false, delayLast = 0, sellFn, buyFn,
} = {}) {
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.wallets = Array.from({ length: wallets }, (_, i) => ({ id: 'w' + (i + 1), name: 'robin' + (i + 1), address: '0x' + String(i + 1).repeat(40), positions: {}, orders: [], history: [] }));
  u.activeWalletId = 'w1';
  core.setTradeAll(CHAT, true);
  core.setReceiptStyle(CHAT, style);
  const real = { snap: core.tokenSnapshot, meta: core.tokenMeta, sell: core.sell, buy: core.buy, fetch: global.fetch };
  let n = 0;
  core.tokenSnapshot = async () => snap;
  core.tokenMeta = async () => ({ sym: 'PONS', decimals: 18, name: 'Pons Finance' });
  core.sell = sellFn || (async (cid, ca, pct) => {
    const i = ++n;
    if (firstFails && i === 1) throw new Error('token balance is 0');
    if (delayLast && i === wallets) await new Promise((r) => setTimeout(r, delayLast));
    return { chain: CHAIN, native: 'ETH', ca, hash: '0x' + String(i).repeat(64), soldPct: pct, soldTokens: 10279471.9312, proceedsEth: 0.0951, netEth: 0.0950, feeEth: 0.000008, sym: 'PONS', realizedEth: 0.042 };
  });
  core.buy = buyFn || (async (cid, ca, amt) => {
    const i = ++n;
    if (firstFails && i === 1) throw new Error('insufficient funds for gas');
    if (delayLast && i === wallets) await new Promise((r) => setTimeout(r, delayLast));
    return { chain: CHAIN, native: 'ETH', ca, hash: '0x' + String(i).repeat(64), spentEth: Number(amt), feeEth: 0.000008, gotTokens: 14406162.5, sym: 'PONS' };
  });
  tg._test.PRICES.ETH = rate;
  const sent = [];
  global.fetch = async (url, opt) => {
    try {
      const b = JSON.parse(opt.body);
      if (/sendMessage|editMessageText/.test(String(url))) sent.push({ text: b.text, kb: b.reply_markup, at: Date.now() });
    } catch (_) {}
    return { json: async () => ({ ok: true, result: { message_id: sent.length + 1 } }) };
  };
  try {
    if (side === 'sell') await tg._test.doSell(CHAT, CA, 100, CHAIN, 'w1');
    else await tg._test.doBuy(CHAT, CA, '0.01', CHAIN, 'w1');
    // The per-wallet receipts are posted from a `.then` tap and chained through
    // queuedSend, so the last of them can still be in flight when doBuy/doSell
    // returns. Wait for the chat's send chain to actually empty rather than
    // sleeping a guessed number of milliseconds — a fixed sleep let one trade's
    // receipts land inside the NEXT trade's captured output, which is a test
    // that fails for a reason that has nothing to do with the code.
    for (let i = 0; i < 200 && tg._test._sendQ.get(CHAT); i++) await tg._test._sendQ.get(CHAT);
    return sent;
  } finally {
    core.tokenSnapshot = real.snap; core.tokenMeta = real.meta; core.sell = real.sell; core.buy = real.buy; global.fetch = real.fetch;
    // A buy opens a live monitor, and the monitor is a self-rescheduling
    // setTimeout chain — with the stubs still in place long enough for it to
    // arm, it keeps the event loop alive forever and `node --test` never exits.
    // Nothing here is testing the monitor; stop every one this trade started.
    for (const [k, st] of tg._test._monitors) { st.stopped = true; if (st.timer) clearTimeout(st.timer); tg._test._monitors.delete(k); }
  }
}

const plain = (t) => String(t).replace(/<a href="[^"]*">([^<]*)<\/a>/g, '$1').replace(/<[^>]+>/g, '');
/** Messages that are a per-wallet receipt.
 *  Matched on the action line, not on the 💳 alone: a buy also opens a live
 *  monitor, and that card carries a wallet chip too. */
const walletMsgs = (sent) => sent.filter((m) => /(succeeded|failed|Nothing to sell|berhasil|gagal|Tidak ada posisi) · 💳/.test(plain(m.text)));

// ── one message per wallet ───────────────────────────────────────────────────

test('four wallets produce four receipts, not one message with four bullets', async () => {
  for (const side of ['buy', 'sell']) {
    const sent = await trade(side);
    const per = walletMsgs(sent);
    assert.equal(per.length, 4, `${side}: ${per.length} per-wallet receipts for 4 wallets`);
    // Each one names its OWN wallet, and no wallet is reported twice.
    const named = per.map((m) => (plain(m.text).match(/💳 (\w+)/) || [])[1]);
    assert.deepEqual([...named].sort(), ['robin1', 'robin2', 'robin3', 'robin4']);
    // And the bullet list is gone — the same information twice is noise, and it
    // is what the user asked not to get.
    assert.ok(!sent.some((m) => /^• /m.test(plain(m.text))), `${side}: the combined bullet list is still being sent`);
  }
});

test('combined mode still exists and still combines', async () => {
  const sent = await trade('buy', { style: 'combined' });
  assert.equal(walletMsgs(sent).length, 0, 'combined mode sent per-wallet receipts');
  assert.ok(/^• /m.test(plain(sent[sent.length - 1].text)), 'combined mode lost its per-wallet lines');
});

// ── the reason this was rewritten: they arrive as they land ─────────────────

test('a fast wallet is reported without waiting for a slow one', async () => {
  // The whole complaint. Three wallets fill immediately and the fourth takes
  // 250ms; the first three receipts must already be out before it finishes.
  const marks = [];
  const sent = await trade('buy', {
    delayLast: 250,
    buyFn: async (cid, ca, amt) => {
      const i = marks.push('start');
      if (i === 4) { await new Promise((r) => setTimeout(r, 250)); marks.push('slow-done'); }
      return { chain: CHAIN, native: 'ETH', ca, hash: '0x' + String(i).repeat(64), spentEth: Number(amt), feeEth: 0, gotTokens: 100 + i, sym: 'PONS' };
    },
  });
  const per = walletMsgs(sent);
  assert.equal(per.length, 4);
  const slowAt = sent.findIndex((m) => /💳 robin4/.test(plain(m.text)));
  const fastCount = walletMsgs(sent.slice(0, slowAt)).length;
  assert.equal(fastCount, 3, 'the three fast wallets were held behind the slow one');
});

test('receipts go out one at a time, so a burst cannot be throttled away', () => {
  // Telegram flood-limits a chat. Five receipts fired concurrently is exactly
  // the shape that provokes it, and a 429 used to be returned to a caller that
  // does not check `ok` — i.e. the receipt was simply gone. A trade the user
  // cannot see is worse than a slow one.
  const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  assert.match(SRC, /queuedSend\(chatId, \(\) => _postWalletReceipt/, 'receipts are not queued per chat');
  const tgFn = SRC.slice(SRC.indexOf('async function tg(method, body)'), SRC.indexOf('function send(chatId'));
  assert.match(tgFn, /error_code === 429/, 'a 429 is still treated as a plain failure');
  assert.match(tgFn, /retry_after/, "Telegram's own retry_after is ignored");
  assert.match(tgFn, /RETRY_429_MAX/, 'the retry is unbounded');
});

// ── the same standard the combined receipt is held to ────────────────────────

test('every wallet that traded carries the transaction that proves it', async () => {
  for (const side of ['buy', 'sell']) {
    const per = walletMsgs(await trade(side));
    const urls = per.map((m) => {
      const row = (m.kb && m.kb.inline_keyboard && m.kb.inline_keyboard[0]) || [];
      return (row.find((b) => b.url) || {}).url;
    });
    assert.equal(urls.filter(Boolean).length, 4, `${side}: a wallet's receipt has no transaction button`);
    assert.equal(new Set(urls).size, 4, `${side}: the same hash was printed on more than one wallet`);
  }
});

test('a wallet that did NOT trade gets no transaction link', async () => {
  // A link on a receipt for something that did not happen is worse than none.
  const per = walletMsgs(await trade('buy', { firstFails: true }));
  const failed = per.find((m) => /failed/i.test(plain(m.text)));
  assert.ok(failed, 'the failed wallet got no receipt at all');
  const urls = (failed.kb.inline_keyboard[0] || []).filter((b) => b.url);
  assert.equal(urls.length, 0, 'a failed wallet was given a transaction button');
  assert.match(plain(failed.text), /💳 robin1/, 'the failed receipt does not say which wallet');
});

test('nothing to sell is not a failure', async () => {
  // A wallet holding nothing did exactly the right thing when asked to sell
  // 100% of nothing. A red ❌ next to it sends people hunting for a fault.
  const per = walletMsgs(await trade('sell', { firstFails: true }));
  const empty = per.find((m) => /robin1/.test(plain(m.text)));
  assert.match(empty.text, /⚪️/, 'an empty wallet was reported as a failure');
  assert.ok(!/❌/.test(empty.text));
});

test('amounts are rounded to something a person can read', async () => {
  for (const side of ['buy', 'sell']) {
    for (const m of walletMsgs(await trade(side))) {
      const nat = plain(m.text).match(/(\d[\d,]*\.\d+) ETH/);
      if (nat) assert.ok(nat[1].split('.')[1].length <= 5, `raw float precision survived: ${nat[0]}`);
    }
  }
});

test('every receipt says what it was worth in dollars', async () => {
  for (const side of ['buy', 'sell']) {
    for (const m of walletMsgs(await trade(side))) {
      assert.match(plain(m.text), /≈ \$\d/, `no dollar figure on:\n${plain(m.text)}`);
    }
  }
});

test('no USD feed means no dollar figure — never a confident $0.00', async () => {
  for (const side of ['buy', 'sell']) {
    for (const m of walletMsgs(await trade(side, { rate: 0 }))) {
      assert.ok(!/\$0\.00/.test(plain(m.text)), `a zero dollar value was printed:\n${plain(m.text)}`);
    }
  }
});

test('the receipt says which token, at what market cap', async () => {
  for (const side of ['buy', 'sell']) {
    const t = plain(walletMsgs(await trade(side))[0].text);
    assert.match(t, /Pons Finance \(\$PONS\)/, `${side}: the token is not named`);
    assert.match(t, new RegExp(CA), `${side}: the contract is missing from the record`);
    // Price and cap on one line — both known, so both are stated.
    assert.match(t, side === 'sell' ? /Exit \$[\d.]+ · MC \$27\.20M/ : /Entry \$[\d.]+ · MC \$27\.20M/, `${side}: no fill price or market cap`);
  }
});

test('an unreadable market leaves the line out rather than printing zeros', async () => {
  const t = plain(walletMsgs(await trade('buy', { snap: null }))[0].text);
  assert.ok(!/MC/.test(t), `a failed read rendered as a market cap:\n${t}`);
  // The fill price is derived from the trade, not from the indexer, so it
  // survives a dead one — that is the point of deriving it.
  assert.match(t, /Entry \$/, 'the fill price went missing with the indexer');
  assert.match(t, /succeeded/, 'the receipt itself must survive a failed market read');
});

// ── what the sell receipt could never say before ─────────────────────────────

test('a sell states how many tokens left the wallet', async () => {
  // No sell result carried the token amount, so a receipt could say "Sold 100%"
  // and never "Sold 10,279,471.93 $PONS" — the units the user thinks in, and
  // the line every other bot leads with.
  const t = plain(walletMsgs(await trade('sell'))[0].text);
  assert.match(t, /10,279,471\.93 \$PONS/, `the sold amount is missing or unreadable:\n${t}`);
  // "Received", not "You gained": a sell at a loss still has proceeds.
  assert.match(t, /Received .*0\.09500 ETH/);
  assert.ok(!/gained/i.test(t), 'proceeds are still being called a gain');
  assert.match(t, /P\/L .*\+0\.04200 ETH/, 'the realised profit is missing');
  // proceeds 0.0950 − pnl 0.0420 = 0.0530 basis → +79.2%
  assert.match(t, /\+79\.2%/, 'the P/L percentage is missing');
});

test('no message tells the user they received the gross', async () => {
  // `proceedsEth` is the GROSS: the bot's cut is a separate transfer broadcast
  // after the wallet delta is measured, so a line that says "Received" and
  // prints it claims the user kept more than they did. Only the Solana sell
  // returned `netEth`; the EVM one did not, so every EVM sell overstated.
  const SRC = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
  const results = [...SRC.matchAll(/const res = \{ chain: chainKey,[^\n]*soldPct[^\n]*\}/g)].map((m) => m[0]);
  assert.equal(results.length, 2, `expected the Solana and EVM sell results, found ${results.length}`);
  for (const r of results) assert.match(r, /netEth:/, `a sell result reports no net proceeds:\n${r}`);
  // And nothing user-facing interpolates the gross directly. `${r.proceedsEth}`
  // also printed a raw 18-decimal float on two of these paths.
  for (const f of ['telegram.js', 'watchers.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const bad = src.split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))   // a comment quoting the old code is not the old code
      .filter((l) => /\$\{[^}]*\br\.proceedsEth\b[^}]*\}/.test(l) && !/netEth/.test(l));
    assert.deepEqual(bad, [], `${f} prints gross proceeds to the user:\n${bad.join('\n')}`);
  }
});

test('a receipt reports the amount that SOLD, not the amount requested', () => {
  // The curve path shaves the last dust off `amount` to get a full exit past
  // the reserve boundary, so the two differ on exactly the trade a user is most
  // likely to check against the explorer — a 100% exit.
  const SRC = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
  assert.match(SRC, /filledRaw = sellAmt;/, 'the shaved amount is not recorded');
  assert.match(SRC, /soldTokens: Number\(ethers\.formatUnits\(filledRaw, dec\)\)/, 'the receipt still reports the requested amount');
});

test('both sell paths return soldTokens, or the line above is a lie', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
  const results = [...SRC.matchAll(/const res = \{ chain: chainKey,[^\n]*soldPct[^\n]*\}/g)].map((m) => m[0]);
  assert.equal(results.length, 2, `expected the Solana and EVM sell results, found ${results.length}`);
  for (const r of results) assert.match(r, /soldTokens:/, `a sell result has no token amount:\n${r}`);
});

// ── the renderer, directly ───────────────────────────────────────────────────

const T = (k, v) => i18n.t('en', k, v);

test('a quantity is grouped, not compressed to 10.28M', () => {
  // fmt() is right for a market cap and wrong here: "Sell of 10.28M RUIN" is
  // not the number in the wallet.
  assert.equal(receipt.qty(10279471.9312), '10,279,471.93');
  assert.equal(receipt.qty(0.00001453), '0.00001453');
  assert.equal(receipt.qty(0), '0');
  assert.equal(receipt.qty(NaN), '0');
});

test('P/L is omitted when it is not known, never printed as zero', () => {
  const base = { side: 'sell', ok: true, sym: 'PONS', ca: '0xabc', wallet: 'w', tokens: 5, amount: 1, native: 'ETH', rate: 100, mcUsd: 0 };
  // A position opened outside this bot has no cost basis; "P/L 0.00000" on a
  // profitable exit is a stated fact that happens to be false.
  assert.ok(!/P\/L/.test(receipt.walletReceipt(T, { ...base, pnl: null })));
  assert.ok(!/P\/L/.test(receipt.walletReceipt(T, { ...base, pnl: 0 })));
  assert.match(receipt.walletReceipt(T, { ...base, pnl: -0.5 }), /📉 P\/L .*−0\.50000 ETH.*\(−\$50\.00\)/);
  // A bag with no cost basis has no return to state — "+∞%" is not a number.
  assert.ok(!/%/.test(receipt.walletReceipt(T, { ...base, amount: 1, pnl: 1 })), 'a zero basis produced a percentage');
});

test("the fill's share of supply is on the receipt — and only when it is known", () => {
  // "harus ada berapa % dari supply" — the ok line carries the share when the
  // supply could be read, and nothing at all when it could not: an unknown
  // supply printed as "0% of supply" would be a stated fact that is false.
  const base = { side: 'buy', ok: true, sym: 'T', ca: 'x', wallet: 'w', tokens: 100, amount: 1, native: 'ETH', rate: 0, mcUsd: 0 };
  assert.match(receipt.walletReceipt(T, { ...base, supplyPct: 2 }), /2\.00%<\/b> of supply/);
  assert.match(receipt.walletReceipt(T, { ...base, side: 'sell', supplyPct: 0.0004 }), /&lt;0\.01%<\/b> of supply/);
  assert.ok(!/of supply/.test(receipt.walletReceipt(T, { ...base, supplyPct: null })), 'an unknown supply rendered as a share');
  assert.ok(!/\{sup\}/.test(receipt.walletReceipt(T, base)), 'the {sup} slot leaked into the copy');
});

test('the renderer adds no escaping — the caller owns that', () => {
  // Same contract as i18n.js. If this module escaped too, the <b> tags the
  // callers pass in would render as literal markup.
  const out = receipt.walletReceipt(T, { side: 'buy', ok: true, sym: 'A&B', ca: 'x', wallet: 'w', tokens: 1, amount: 1, native: 'ETH', rate: 0, mcUsd: 0 });
  assert.ok(out.includes('$A&B'), 'the renderer escaped a value the caller had already escaped');
});

test('the token name is dropped when it only repeats the ticker', () => {
  const h = receipt.header({ name: 'PONS', sym: 'PONS', ca: '0xabc', chainName: 'Base', chainEmoji: '🔵' });
  assert.ok(!/PONS \(\$PONS\)/.test(h), 'the header reads "PONS ($PONS)"');
  assert.match(h, /<b>\$PONS<\/b> · 🔵 Base/);
});

test('both languages carry every receipt string', () => {
  for (const key of Object.keys(i18n._strings).filter((k) => k.startsWith('wallet.receipt.'))) {
    for (const lang of i18n.LANGS) {
      assert.ok(i18n._strings[key][lang], `${key} has no ${lang}`);
    }
    assert.notStrictEqual(i18n._strings[key].en, i18n._strings[key].id, `${key} was never translated`);
  }
});
