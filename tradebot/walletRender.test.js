'use strict';
/*
 * walletRender.test.js — renders /wallet and /tokens for real.
 *
 * walletScreen.test.js reads the SOURCE and asserts on its shape, which is
 * useful for pinning layout rules but cannot catch a runtime fault. It did not:
 * `walletTokenUsd` early-returns when a user holds no tokens at all, and that
 * branch still returned a per-wallet NUMBER after the main path had been
 * changed to return a per-wallet ARRAY of bags. Every source assertion passed
 * while the screen threw `wb.reduce is not a function` for the single most
 * common user there is — a new one, who has bought nothing yet.
 *
 * So these tests drive the real functions against a fake chain/core.
 */
const test = require('node:test');
const assert = require('node:assert');
const M = require('node:module');

const CH = [
  { key: 'robinhood', name: 'Robinhood Chain', native: 'ETH', emoji: '🚀', explorer: 'https://e' },
  { key: 'ethereum', name: 'Ethereum', native: 'ETH', emoji: '♦', explorer: 'https://e' },
  { key: 'bsc', name: 'BNB Chain', native: 'BNB', emoji: '🟡', explorer: 'https://e' },
  { key: 'solana', name: 'Solana', native: 'SOL', emoji: '🟣', explorer: 'https://e' },
];
const idx = (k) => CH.findIndex((c) => c.key === k);
const E = (n) => BigInt(Math.round(n * 1e18));
const pos = (chain, ca, sym, tok, dec) =>
  ({ chain, ca, sym, dec, tokens: BigInt(Math.round(tok * 10 ** dec)).toString(), closed: false });

// Rebuilt per test so one test's wallets cannot leak into the next.
let WALLETS = [];
let BAL = [];
let PRICE = {};
let ACTIVE = 'robinhood';   // the chain the user picked with 🌐 Chain
// What the RPC says when a cell is marked 'fail' — so a render test can assert
// the screen PRINTS the reason rather than one shrug for every silence.
let FAIL_WHY = {};

const core = {
  CFG: { tgToken: 'test' },
  ensureUser: () => ({ activeWalletId: WALLETS[0] && WALLETS[0].id, wallets: WALLETS }),
  chainOf: (k) => CH[idx(k)] || CH[0],
  userChain: () => ACTIVE,
  walletList: () => WALLETS,
  walletLabel: (w, i) => w.name || 'Wallet ' + i,
  WALLET_CAP: 10,
  getLang: () => 'en',
  walletAddress: (w, k) => (k === 'solana' ? w.sol : w.address),
  chains: { enabledChains: () => CH, isSvm: (k) => k === 'solana' },
  providerFor: (k) => ({ getBalance: async (a) => bal(a, k) }),
  ethBalance: async (a, k) => bal(a, k),
  // The screen reads balances through this now: 0n and "we could not read it"
  // are different facts, and on Solana `ethBalance` could not tell them apart.
  ethBalanceOrNull: async (a, k) => { try { return bal(a, k); } catch (_) { return null; } },
  // The screens read a per-chain COLUMN now, because five separate Solana reads
  // in one wave is what the public endpoint rate-limits. The fake answers the
  // same per-cell `bal()`, so every assertion below still means what it meant —
  // and a chain that fails carries its REASON, which the screen prints.
  nativeBalances: async (k, addrs) => {
    let why = null;
    const bals = addrs.map((a) => {
      try { return bal(a, k); } catch (e) { if (!why) why = String(e.message); return null; }
    });
    return { bals, why };
  },
  tokenSnapshot: async (ca) => ({ priceEth: PRICE[ca] || 0 }),
};
function bal(addr, k) {
  // Indexed by wallet POSITION, not id: ids are made unique per test (see W).
  const wi = WALLETS.findIndex((x) => x.address === addr || x.sol === addr);
  const row = BAL[wi] || [];
  const v = row[idx(k)];
  if (v === 'fail') throw new Error(FAIL_WHY[k] || 'RPC down');
  return v == null ? 0n : v;
}

const orig = M.prototype.require;
M.prototype.require = function (p) { return p === './core' ? core : orig.apply(this, arguments); };
const tgm = require('./telegram.js');
M.prototype.require = orig;
const t = tgm._test;
t.PRICES.ETH = 2000; t.PRICES.BNB = 600; t.PRICES.SOL = 200;

// Unique per test. telegram.js keeps a module-level last-known-good balance
// cache (10 min) so a chain whose RPC blips does not silently drop out of the
// totals — which is correct, and means a wallet id reused across tests carries
// the previous test's balances into this one. That leak masked a genuine
// failure here: an unreadable chain read back as a cached 0, i.e. "empty".
let _uid = 0;
const W = (id, name) => { const u = id + '_' + (++_uid); return { id: u, name: name || '', orders: [], positions: {},
  address: '0x' + u.padEnd(40, '0'), sol: 'So' + u.padEnd(42, '1') }; };
const plain = (s) => s.replace(/<[^>]+>/g, '');

test.beforeEach(() => { WALLETS = []; BAL = []; PRICE = {}; ACTIVE = 'robinhood'; FAIL_WHY = {}; });

// ── The path the source tests could not see ──────────────────────────────────

test('a brand-new user with nothing at all gets a screen, not a crash', async () => {
  WALLETS = [W('w1')];
  const r = await t.walletScreen(1);
  assert.ok(r.text.length > 0);
  assert.match(plain(r.text), /Three steps to your first trade/);
});

test('a user with coins but no tokens renders', async () => {
  WALLETS = [W('w1')];
  BAL = [[E(0.5), 0n, 0n, 0n]];
  const r = await t.walletScreen(1);
  assert.match(plain(r.text), /0\.5000 ETH/);
  assert.match(plain(r.text), /\$1,000\.00/);
});

// ── Layout ───────────────────────────────────────────────────────────────────

test('each wallet appears exactly once', async () => {
  WALLETS = [W('w1'), W('w2'), W('w3')];
  BAL = [[E(1), 0n, 0n, 0n], [E(2), 0n, 0n, 0n], [E(3), 0n, 0n, 0n]];
  const txt = plain((await t.walletScreen(1)).text);
  for (const name of ['Wallet 1', 'Wallet 2', 'Wallet 3']) {
    const hits = txt.split(name).length - 1;
    assert.strictEqual(hits, 1, `${name} appears ${hits} times`);
  }
});

test('one wallet, one dollar figure — no two roundings of the same number', async () => {
  // The original complaint: "≈ $1.01K" above "native $999.62 · tokens $8.18".
  WALLETS = [W('w1')];
  BAL = [[E(0.5046), E(0.0149), 0n, 0n]];
  const txt = plain((await t.walletScreen(1)).text);
  assert.ok(!/\$[\d.]+K/.test(txt), `a K-rounded figure is back: ${txt.match(/\$[\d.]+K/)}`);
});

test('chains with nothing on them take one line between them', async () => {
  WALLETS = [W('w1')];
  BAL = [[E(1), 0n, 0n, 0n]];
  const txt = plain((await t.walletScreen(1)).text);
  assert.match(txt, /Nothing yet on Ethereum · BNB Chain · Solana/);
  assert.ok(!/Ethereum — 0/.test(txt), 'a zero row is back');
});

test('an RPC that did not answer is reported separately from a real zero', async () => {
  WALLETS = [W('w1')];
  BAL = [[E(1), 'fail', 0n, 0n]];
  const txt = plain((await t.walletScreen(1)).text);
  assert.match(txt, /Couldn't reach Ethereum/);
  assert.ok(!/Nothing yet on[^\n]*Ethereum/.test(txt), 'an unreadable chain was counted as empty');
});

test('no gas on the chain you are trading on is a warning, not a row', async () => {
  WALLETS = [W('w1')];
  BAL = [[0n, E(1), 0n, 0n]];
  const txt = plain((await t.walletScreen(1)).text);
  assert.match(txt, /⚠️ 0 ETH on Robinhood Chain/);
});

test('only the active wallet prints its addresses', async () => {
  WALLETS = [W('w1'), W('w2'), W('w3')];
  BAL = [[E(1), 0n, 0n, 0n], [E(1), 0n, 0n, 0n], [E(1), 0n, 0n, 0n]];
  const r = await t.walletScreen(1);
  assert.strictEqual((r.text.match(/<code>/g) || []).length, 2, 'expected exactly the active wallet EVM + Solana address');
  assert.ok(r.text.includes(WALLETS[0].address));
  assert.ok(!r.text.includes(WALLETS[1].address), "an inactive wallet's address is on screen");
  // …but it still has a button to get it.
  assert.ok(JSON.stringify(r.kb).includes('qrw:' + WALLETS[1].id));
});

// ── The active chain is not the total ────────────────────────────────────────
// Reported from a live screen: the user switched to Solana and read
//
//   💼 Your wallets · 🟣 Solana
//   $1,322.54 across 5 of 10 wallets
//
// with 0 SOL. The $1,322.54 was on Robinhood Chain. Both numbers were right;
// the layout put the all-chains one directly under a Solana badge, which is as
// plainly as a layout can claim it is a Solana balance.

test('picking a chain with nothing on it does not print the all-chains total under its badge', async () => {
  ACTIVE = 'solana';
  WALLETS = [W('w1')];
  BAL = [[E(0.66), 0n, 0n, 0n]];   // $1,320 — all of it on Robinhood Chain
  const txt = plain((await t.walletScreen(1)).text);
  // Header rework ("sangat membingungkan"): Total leads, the chain share sits
  // under it with an explicit label, and the slot cap is off the line entirely.
  assert.match(txt, /🟣 On Solana: \$0\.00/, 'the chain the user picked has no figure of its own');
  assert.match(txt, /💰 Total: \$1,320\.00 — every wallet, every chain/);
  // The killer: the grand total must not be the line under the chain badge.
  assert.ok(!/🟣 Solana\n\$1,320\.00/.test(txt), 'the all-chains total is still sitting under the chain badge');
  assert.ok(!/of 10 wallets/.test(txt), 'the slot cap is back on the total line — it reads as "only N counted"');
});

test('the chain you are trading on is never listed among the empty ones', async () => {
  // It used to be: "Nothing yet on Ethereum · BNB Chain · Solana" one line above
  // "⚠️ 0 SOL on Solana" — the same fact twice, contradicting the badge above it.
  ACTIVE = 'solana';
  WALLETS = [W('w1')];
  BAL = [[E(0.66), 0n, 0n, 0n]];
  const txt = plain((await t.walletScreen(1)).text);
  assert.ok(!/Nothing yet on[^\n]*Solana/.test(txt), 'the active chain is in the empty roll-up as well');
  assert.strictEqual(txt.split('Solana').length - 1 - (txt.split('Deposit on Solana').length - 1), 2,
    'Solana is named more times than the chain line + the gas warning');
});

test('the active chain leads the breakdown, whatever the registry order', async () => {
  ACTIVE = 'bsc';
  WALLETS = [W('w1')];
  BAL = [[E(1), 0n, BigInt(2e18), 0n]];   // Robinhood first in CH, BNB third
  const txt = plain((await t.walletScreen(1)).text);
  assert.ok(txt.indexOf('BNB Chain — 2.0000 BNB') < txt.indexOf('Robinhood Chain — 1.0000 ETH'),
    'the chain being traded on is below one that is merely funded');
});

test('no gas here, but another wallet has some — say which one', async () => {
  // Otherwise "🟣 Solana — $200.00 here" (all wallets) and "⚠️ 0 SOL" (this
  // wallet) read as the screen contradicting itself.
  ACTIVE = 'solana';
  WALLETS = [W('w1'), W('w2', 'Sniper')];
  BAL = [[E(1), 0n, 0n, 0n], [0n, 0n, 0n, BigInt(1e9)]];   // 1 SOL, in wallet 2
  const txt = plain((await t.walletScreen(1)).text);
  assert.match(txt, /⚠️ 0 SOL on Solana/);
  assert.match(txt, /Sniper has 1\.0000 SOL here — tap it below to switch/);
});

test('the deposit address for the chain you picked comes first', async () => {
  ACTIVE = 'solana';
  WALLETS = [W('w1')];
  BAL = [[E(1), 0n, 0n, 0n]];
  const r = await t.walletScreen(1);
  assert.ok(r.text.indexOf(WALLETS[0].sol) < r.text.indexOf(WALLETS[0].address),
    'a user on Solana has to scroll past the EVM address to reach the one that can receive SOL');
});

test('one chain in play means one number, not the same number twice', async () => {
  // The fix must not become its own clutter: when everything IS on the active
  // chain, the per-chain line and the all-chains line are the same figure.
  WALLETS = [W('w1')];
  BAL = [[E(1), 0n, 0n, 0n]];
  const txt = plain((await t.walletScreen(1)).text);
  assert.match(txt, /💼 Your wallets · 🚀 Robinhood Chain\n💰 Total: \$2,000\.00\n/);
  assert.ok(!/every chain/.test(txt), 'a second, identical total line was added');
  assert.ok(!/On Robinhood Chain:/.test(txt), 'the chain share line restates the only number there is');
});

test('the chain header carries the coin amount, and the total names its coins', async () => {
  // "harus ada jumlah solananya brp dan total itu total dalam token apa aja":
  // the On-<chain> line shows the native amount beside the USD, and the Total
  // is decomposed into coins grouped by symbol.
  ACTIVE = 'solana';
  const L = (n) => BigInt(Math.round(n * 1e9));   // lamports — Solana is 9 decimals
  WALLETS = [W('w1'), W('w2')];
  BAL = [[E(1), 0n, 0n, L(1.9402)], [0n, 0n, 0n, L(1.4475)]];
  const txt = plain((await t.walletScreen(1)).text);
  // 3.3877 SOL × $200 = $677.54, summed over BOTH wallets.
  assert.match(txt, /On Solana: \$677\.54 · 3\.3877 SOL/, 'the SOL amount is not on the chain header');
  assert.match(txt, /Coins: 1 ETH · 3\.3877 SOL/, 'the Total does not name the coins behind it');
});

test('a chain we could not reach never reads as $0.00 on it', async () => {
  // "$0.00 here" is the sentence that sends someone to check whether their
  // deposit arrived. An RPC timeout must not produce it.
  ACTIVE = 'solana';
  WALLETS = [W('w1')];
  BAL = [[E(1), 0n, 0n, 'fail']];
  const txt = plain((await t.walletScreen(1)).text);
  assert.match(txt, /🟣 On Solana: couldn't read it just now/);
  assert.ok(!/On Solana: \$0\.00/.test(txt), 'an unreadable balance was rendered as zero');
});

test('a trivial token bag does not spend a line restating the total', async () => {
  // "$1,322.22 in coins · $0.33 in tokens" — a whole line to say the total is
  // still the total. The 🪙 route to the detail screen stays either way.
  WALLETS = [W('w1')];
  // A CA of its own: telegram.js caches prices per chain:ca for 30s, so reusing
  // one across two tests with two prices reads the first test's number.
  WALLETS[0].positions = { a: pos('robinhood', '0xDUST', 'HOPPY', 100, 18) };
  PRICE = { '0xDUST': 0.0000001 };   // $0.02 against $2,000 of ETH
  BAL = [[E(1), 0n, 0n, 0n]];
  const r = await t.walletScreen(1);
  assert.ok(!/in coins ·/.test(plain(r.text)), 'the split line is back for a rounding-error bag');
});

test('a token bag worth reading still gets the split line', async () => {
  WALLETS = [W('w1')];
  WALLETS[0].positions = { a: pos('robinhood', '0xBAG', 'HOPPY', 100000, 18) };
  PRICE = { '0xBAG': 0.000005 };   // $1,000 against $2,000 of ETH
  BAL = [[E(1), 0n, 0n, 0n]];
  // ONE number now: "…in coins · …in tokens" restated the Total as a sum the
  // reader was invited to check — the exact line reported as confusing.
  const txt246 = plain((await t.walletScreen(1)).text);
  assert.match(txt246, /incl\. \$1,000\.00 in tokens/);
  assert.ok(!/in coins ·/.test(txt246), 'the two-number split is back');
});

test('the screen fits in a Telegram message at the wallet cap', async () => {
  WALLETS = Array.from({ length: 10 }, (_, i) => W('w' + (i + 1), 'W'.repeat(24)));
  BAL = WALLETS.map(() => [E(1234.5678), E(1), E(1), 0n]);
  const r = await t.walletScreen(1);
  assert.ok(r.text.length < 4096, `${r.text.length} chars — sendMessage would 400 and the user would see nothing`);
});

// ── The tokens screen ────────────────────────────────────────────────────────

test('tokens are grouped by chain, and every chain is covered', async () => {
  WALLETS = [W('w1'), W('w2')];
  WALLETS[0].positions = { a: pos('robinhood', '0xA', 'HOPPY', 100000, 18) };
  WALLETS[1].positions = { b: pos('bsc', '0xB', 'CAKE', 4, 18), c: pos('solana', 'SoC', 'BONK', 1e6, 5) };
  PRICE = { '0xA': 0.000005, '0xB': 0.003, SoC: 0.0000001 };
  const txt = plain((await t.tokensScreen(1)).text);
  assert.match(txt, /🚀 Robinhood Chain[\s\S]*\$HOPPY/);
  assert.match(txt, /🟡 BNB Chain[\s\S]*\$CAKE/);
  assert.match(txt, /🟣 Solana[\s\S]*\$BONK/);
  // …and it says WHICH wallet holds each.
  assert.match(txt, /\$CAKE[^\n]*Wallet 2/);
});

test('the tokens total equals the wallet screen total', async () => {
  // Two screens computing "how much in tokens" separately is how they drift.
  WALLETS = [W('w1')];
  WALLETS[0].positions = { a: pos('robinhood', '0xA', 'HOPPY', 100000, 18), b: pos('bsc', '0xB', 'CAKE', 4, 18) };
  PRICE = { '0xA': 0.000005, '0xB': 0.003 };
  const wal = plain((await t.walletScreen(1)).text);
  const tok = plain((await t.tokensScreen(1)).text);
  const from = (s, re) => (re.exec(s) || [])[1];
  assert.strictEqual(from(wal, /🪙 Tokens — (\$[\d,.]+)/), from(tok, /(\$[\d,.]+) in tokens/));
});

test('a token we could not price is never shown as $0.00', async () => {
  WALLETS = [W('w1')];
  WALLETS[0].positions = { a: pos('ethereum', '0xDEAD', 'GHOST', 900000, 18) };
  PRICE = {}; // no price for anything
  const r = await t.tokensScreen(1);
  const txt = plain(r.text);
  assert.match(txt, /\$GHOST · price unavailable/);
  assert.match(txt, /♦ Ethereum · price unavailable/, 'the chain subtotal claimed $0.00');
  assert.ok(!/\$GHOST · \$0\.00/.test(JSON.stringify(r.kb)), 'the button claimed $0.00');
});

test('holding nothing says so instead of rendering an empty list', async () => {
  WALLETS = [W('w1')];
  const txt = plain((await t.tokensScreen(1)).text);
  assert.match(txt, /No tokens yet/);
});

test('the same token in two wallets is one row naming both', async () => {
  WALLETS = [W('w1'), W('w2')];
  WALLETS[0].positions = { a: pos('robinhood', '0xA', 'HOPPY', 100000, 18) };
  WALLETS[1].positions = { b: pos('robinhood', '0xA', 'HOPPY', 40000, 18) };
  PRICE = { '0xA': 0.000005 };
  const txt = plain((await t.tokensScreen(1)).text);
  assert.strictEqual(txt.split('$HOPPY').length - 1, 1, 'the token is listed twice instead of merged');
  assert.match(txt, /Wallet 1, Wallet 2/);
  assert.match(txt, /140\.00K \$HOPPY/, 'the merged amount is wrong');
});

// ── /portfolio: an unreadable price is not a loss ─────────────────────────────
// The same defect the tokens screen was built to avoid, in the older screen and
// worse: `snap ? snap.priceEth : 0` made a failed lookup set value to 0, so
// unrealized became minus the entire cost basis. The row read −100% and it was
// summed into the header, so one API blip wiped out the user's whole book.

// portfolioAll's own arithmetic is pinned at the source in portfolio.test.js —
// its internal calls are closure-bound, so monkeypatching the module's exports
// cannot reach them. What IS worth driving here is the renderer, because the
// "-100%" was printed there, and the fake core above can hand it any shape.

const PF = (over) => ({ chain: CH[0], native: 'ETH', rows: [], totalValueEth: 0,
  totalCostEth: 0, totalUnrealEth: 0, totalRealizedEth: 0, unpriced: 0, ...over });

test('an unpriced position prints "price unavailable", never a loss', async () => {
  core.portfolioAll = async () => PF({
    unpriced: 1,
    rows: [{ ca: '0xA', sym: 'HOPPY', open: true, tokens: 100000, valueEth: 0, priced: false,
      ethIn: 1, ethOut: 0, costEth: 1, realizedEth: 0, unrealizedEth: null, holders: [] }],
  });
  const txt = plain((await t.portfolioScreen(1)).text);
  assert.match(txt, /\$HOPPY · price unavailable/);
  assert.ok(!/−100\.0%|-100\.0%/.test(txt), `a fabricated total loss is on screen:\n${txt}`);
  assert.match(txt, /1 position\(s\) left out/, 'the header claims a complete total');
  delete core.portfolioAll;
});

test('a priced position still shows its PnL', async () => {
  core.portfolioAll = async () => PF({
    totalValueEth: 2, totalCostEth: 1, totalUnrealEth: 1,
    rows: [{ ca: '0xA', sym: 'HOPPY', open: true, tokens: 100000, valueEth: 2, priced: true,
      ethIn: 1, ethOut: 0, costEth: 1, realizedEth: 0, unrealizedEth: 1, holders: [] }],
  });
  const txt = plain((await t.portfolioScreen(1)).text);
  assert.match(txt, /\+100\.0%/);
  assert.ok(!/left out/.test(txt), 'a complete total is being hedged');
  delete core.portfolioAll;
});

test('"nothing on this chain" does not read as "you hold nothing"', async () => {
  // portfolioAll skips every position on any other chain, so the flat sentence
  // was false for anyone with a bag elsewhere. /tokens is the screen that can
  // answer it.
  core.portfolioAll = async () => PF({});
  const r = await t.portfolioScreen(1);
  assert.match(plain(r.text), /one chain at a time/);
  assert.ok(JSON.stringify(r.kb).includes('toks'), 'no route to the screen that covers every chain');
  delete core.portfolioAll;
});

// ── "mengapa tidak baca saldo solana" — the reason has to reach the screen ────

test("⚠️ an unread chain SAYS why, on the screen, not only in a variable", async () => {
  // The reported render: `Couldn't reach Solana — those are not counted above`
  // and nothing else. A 429, a host refusing this server and our own 2.5s bound
  // were one sentence, which is why this had to be diagnosed from a screenshot.
  WALLETS = [W('w1')];
  BAL = [[E(1), 0n, 0n, 'fail']];
  FAIL_WHY = { solana: 'the Solana RPC is rate-limiting this server (429)' };
  const txt = plain((await t.walletScreen(1)).text);
  assert.match(txt, /Couldn't reach Solana/);
  assert.match(txt, /rate-limiting this server \(429\)/, 'the reason never reached the reader');
});

test("…and two chains behind one dead host are ONE sentence", async () => {
  WALLETS = [W('w1')];
  BAL = [[E(1), 'fail', 'fail', 0n]];
  FAIL_WHY = { ethereum: 'node is down', bsc: 'node is down' };
  const txt = plain((await t.walletScreen(1)).text);
  assert.strictEqual(txt.split('node is down').length - 1, 1, 'a repeated reason is a wall, not an answer');
});

test('a chain that answered says nothing about a reason', async () => {
  WALLETS = [W('w1')];
  BAL = [[E(1), 0n, 0n, E(0)]];
  const txt = plain((await t.walletScreen(1)).text);
  assert.doesNotMatch(txt, /Couldn't reach/);
});

// ── "masih 1 chain unread ini chain solana yang tidak bisa di read" ───────────
// The reported screen said `the Solana RPC is rate-limiting this server (429)`
// on the active wallet and `⚠️ 1 chain(s) unread` on the four below it — the
// same fact, rendered once with an answer and four times without one.

test('a non-active wallet NAMES the chain it could not read', async () => {
  WALLETS = [W('w1'), W('w2')];
  BAL = [[E(1), 0n, 0n, E(2)], [E(1), 0n, 0n, 'fail']];
  FAIL_WHY = { solana: 'the Solana RPC is rate-limiting this server (429)' };
  const txt = plain((await t.walletScreen(1)).text);
  // A count cannot say WHICH, and at n=1 it says nothing at all.
  assert.doesNotMatch(txt, /1 chain\(s\) unread/);
  assert.match(txt, /Solana unread/);
});

test('the reason prints when ONLY a non-active wallet is unread', async () => {
  // The hole the old placement could not cover: the reason lived inside the
  // ACTIVE wallet's block, and here that wallet read Solana perfectly well.
  WALLETS = [W('w1'), W('w2')];
  BAL = [[E(1), 0n, 0n, E(2)], [E(1), 0n, 0n, 'fail']];
  FAIL_WHY = { solana: 'the Solana RPC is rate-limiting this server (429)' };
  const txt = plain((await t.walletScreen(1)).text);
  assert.doesNotMatch(txt, /Couldn't reach Solana/, 'the active wallet read it — it has no unread line');
  assert.match(txt, /rate-limiting this server \(429\)/, 'and the screen still says why');
  assert.match(txt, /Solana — the Solana RPC is rate-limiting/, 'named, so the line stands alone');
});

test('one reason covers the screen, however many wallets hit it', async () => {
  WALLETS = [W('w1'), W('w2'), W('w3'), W('w4')];
  BAL = [0, 1, 2, 3].map(() => [E(1), 0n, 0n, 'fail']);
  FAIL_WHY = { solana: 'the Solana RPC is rate-limiting this server (429)' };
  const txt = plain((await t.walletScreen(1)).text);
  assert.strictEqual(txt.split('rate-limiting this server').length - 1, 1,
    'four wallets behind one refused host is one sentence, not four');
  // …and every row still says which chain, because that is per row.
  assert.strictEqual(txt.split('Solana unread').length - 1, 3, 'the three non-active rows name it');
});
