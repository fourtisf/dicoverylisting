'use strict';
/*
 * What a multi-wallet receipt owes the person who just spent money.
 *
 * The one that shipped:
 *
 *     ✅ Sold 100% · 3/4 wallets (1 had no bag)
 *     Total received: 0.00241 ETH ($4.46)
 *     • Wallet 1: — no bag
 *     • Wallet 2: 0.000801724630395044 ETH
 *     • Wallet 3: 0.000801728292853948 ETH
 *     • Wallet 4: 0.000801725671494925 ETH
 *
 * Eighteen decimals of noise where five carry the information. No dollar figure
 * on any line. No price, no market cap. And — on a bot whose whole job is to
 * move somebody's money — no transaction hash on a single row, so nothing here
 * could be checked against the chain. The hash was in hand the entire time; it
 * just was not being printed.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-'));
process.env.WALLET_SECRET = 'w'.repeat(48);
process.env.TRADEBOT_TOKEN = 'x:y';
process.env.ENABLED_CHAINS = 'robinhood';

const core = require('./core');
const tg = require('./telegram');

const CA = '0x39dBED3a2bd333467115dE45665cC57F813C4571';
const CHAIN = 'robinhood';
const CHAT = 7;

/** Run a real multi-wallet trade and return the receipt the user is sent. */
async function receipt(side, { rate = 1858, snap = { sym: 'PONS', priceEth: 0.00001453, mcapUsd: 27_200_000 }, firstFails = false } = {}) {
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.wallets = [1, 2, 3, 4].map((i) => ({ id: 'w' + i, name: 'Wallet ' + i, address: '0x' + String(i).repeat(40), positions: {}, orders: [], history: [] }));
  u.activeWalletId = 'w4';
  core.setTradeAll(CHAT, true);
  // THIS FILE IS ABOUT THE COMBINED RECEIPT, which is no longer the default.
  // A multi-wallet trade now posts one message PER WALLET as each one settles
  // (walletReceipt.test.js holds those to the identical standard: a transaction
  // on every wallet that traded, none on one that did not, readable amounts, a
  // dollar figure, and never a confident $0.00). `combined` is still a
  // supported choice in ⚙️ Settings, so the contract below still has to hold —
  // it just has to be asked for explicitly now.
  core.setReceiptStyle(CHAT, 'combined');
  const real = { snap: core.tokenSnapshot, meta: core.tokenMeta, sell: core.sell, buy: core.buy, fetch: global.fetch };
  let n = 0;
  core.tokenSnapshot = async () => snap;
  core.tokenMeta = async () => ({ sym: 'PONS', decimals: 18, name: 'Pons' });
  core.sell = async (cid, ca, pct) => {
    n++;
    if (firstFails && n === 1) throw new Error('token balance is 0');
    return { chain: CHAIN, native: 'ETH', ca, hash: '0x' + String(n).repeat(64), soldPct: pct, proceedsEth: 0.000801724630395044, feeEth: 0.000008, sym: 'PONS', realizedEth: 0.0001 };
  };
  core.buy = async (cid, ca, amt) => {
    n++;
    return { chain: CHAIN, native: 'ETH', ca, hash: '0x' + String(n).repeat(64), spentEth: Number(amt), feeEth: 0.000008, gotTokens: 56.27, sym: 'PONS' };
  };
  tg._test.PRICES.ETH = rate;
  const sent = [];
  global.fetch = async (url, opt) => {
    try { const b = JSON.parse(opt.body); if (/sendMessage|editMessageText/.test(String(url))) sent.push(b.text); } catch (_) {}
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  try {
    if (side === 'sell') await tg._test.doSell(CHAT, CA, 100, CHAIN, 'w4');
    else await tg._test.doBuy(CHAT, CA, '0.01', CHAIN, 'w4');
    return sent[sent.length - 1] || '';
  } finally { core.tokenSnapshot = real.snap; core.tokenMeta = real.meta; core.sell = real.sell; core.buy = real.buy; global.fetch = real.fetch; }
}
const plain = (t) => t.replace(/<a href="[^"]*">([^<]*)<\/a>/g, '$1').replace(/<[^>]+>/g, '');
const walletRows = (t) => plain(t).split('\n').filter((l) => /^• /.test(l));

// ---------------------------------------------------------------- proof
test('every wallet that traded carries the transaction that proves it', async () => {
  for (const side of ['sell', 'buy']) {
    const t = await receipt(side);
    const links = [...t.matchAll(/<a href="([^"]+\/tx\/0x[0-9a-f]+)"/g)].map((m) => m[1]);
    assert.equal(links.length, 4, `${side}: ${links.length} of 4 wallets carry a tx link`);
    assert.equal(new Set(links).size, 4, `${side}: the same hash was printed on more than one wallet`);
  }
});

test('a wallet that did NOT trade gets no transaction link', async () => {
  // A link on a row that never traded is worse than no link: it is a receipt for
  // something that did not happen.
  const t = await receipt('sell', { firstFails: true });
  const noBag = walletRows(t).find((l) => /no bag/i.test(l));
  assert.ok(noBag, 'the skipped wallet is missing from the list entirely');
  assert.ok(!/tx ↗/.test(noBag), `a skipped wallet was given a transaction: ${noBag}`);
});

// ---------------------------------------------------------------- readable
test('amounts are rounded to something a person can read', async () => {
  // "0.000801724630395044 ETH" is eighteen decimals of noise.
  for (const side of ['sell', 'buy']) {
    for (const line of walletRows(await receipt(side))) {
      const m = line.match(/(\d+\.\d+) ETH/);
      if (!m) continue;
      assert.ok(m[1].split('.')[1].length <= 5, `raw float precision survived: ${line}`);
    }
  }
});

test('every wallet line says what it was worth in dollars', async () => {
  for (const side of ['sell', 'buy']) {
    const rows = walletRows(await receipt(side)).filter((l) => /ETH/.test(l));
    assert.ok(rows.length >= 3, `${side}: expected wallet rows`);
    for (const line of rows) assert.match(line, /\(\$\d/, `no dollar figure on: ${line}`);
  }
});

test('no USD feed means no dollar figure — never a confident $0.00', async () => {
  for (const side of ['sell', 'buy']) {
    for (const line of walletRows(await receipt(side, { rate: 0 }))) {
      assert.ok(!/\$0\.00/.test(line), `a zero dollar value was printed on: ${line}`);
    }
  }
});

// ---------------------------------------------------------------- the market
test('the receipt says what the token is worth and what it is capped at', async () => {
  // "mc berapa" — the question a receipt leaves behind.
  for (const side of ['sell', 'buy']) {
    const t = plain(await receipt(side));
    assert.match(t, /Price: \$0\.027/, `${side}: no price on the receipt`);
    assert.match(t, /market cap \$27\.20M/, `${side}: no market cap on the receipt`);
  }
});

test('an unreadable market leaves the line out rather than printing zeros', async () => {
  const t = plain(await receipt('sell', { snap: null }));
  assert.ok(!/market cap/.test(t), `a failed read rendered as a market cap:\n${t}`);
  assert.ok(!/Price: \$0\b/.test(t), 'a zero price was printed');
  assert.match(t, /Total received/, 'the receipt itself must survive a failed market read');
});

test('the market read happens AFTER the trade, never before it', async () => {
  // A receipt is not worth a round trip on the path where the money moves.
  const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  // The fan-outs are now named bindings (`raw` / `rawSells`) rather than being
  // written inline inside the allSettled, because each trade carries a `.then`
  // tap that posts that wallet's own receipt as it settles. Their POSITION
  // relative to the market read is what this test is about, and that is what
  // the match still finds.
  const fans = [...SRC.matchAll(/const raw(?:Sells)? = targets\.map/g)].map((m) => m.index);
  // The buy path guards the read on something having filled — a price line
  // under "❌ Nothing bought" reads as the price it filled at — so the read is
  // no longer unconditional. Its ORDER relative to the fan-out is what this
  // test is about, and that is unchanged.
  const reads = [...SRC.matchAll(/const mkt = (?:okN > 0 \? )?await marketLine/g)].map((m) => m.index);
  assert.equal(fans.length, 2, `expected the buy and sell fan-outs, found ${fans.length}`);
  assert.equal(reads.length, 2, `expected a market read on each receipt, found ${reads.length}`);
  // Pairwise: each receipt's read must come after its own fan-out. Matching on
  // "await Promise.allSettled" would have missed the buy path, which assigns the
  // promise and awaits it further down — a test too literal about the shape of
  // the thing it is checking the order of.
  for (let i = 0; i < 2; i++) {
    assert.ok(reads[i] > fans[i], `receipt ${i} reads the market before its trades are dispatched`);
  }
});

// ---------------------------------------------------------------- both sides
test('buy and sell are held to the same standard', async () => {
  // "ini bukan hanya sale tapi beli juga" — a buy receipt that omits what a sell
  // receipt shows is the same gap, just quieter.
  const [sell, buy] = [plain(await receipt('sell')), plain(await receipt('buy'))];
  for (const t of [sell, buy]) {
    assert.match(t, /Price:/);
    assert.match(t, /market cap/);
    assert.ok(walletRows(t).some((l) => /tx ↗/.test(l)), 'a side has no per-wallet transaction');
    assert.ok(walletRows(t).some((l) => /\(\$/.test(l)), 'a side has no per-wallet dollar figure');
  }
  assert.match(buy, /\$PONS/, 'the buy receipt must still name what was bought');
});
