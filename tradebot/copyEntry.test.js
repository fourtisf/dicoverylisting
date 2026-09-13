'use strict';
/*
 * Does copy-trading actually SEE a followed wallet buy?
 *
 * The exit half has been audited three times and reads balances, so it is route
 * agnostic. The entry half was not:
 *
 *     const pair = await pairOf(t.chain, token);      // getPair(token, WETH)
 *     if (!pair || pair !== fromAddr) continue;
 *
 * That recognised a Uniswap V2 pool and nothing else. A target buying through
 * V3, V4, Aerodrome, 1inch, 0x, CoW or another Telegram bot's router was
 * invisible — which on Ethereum and Base is most of the volume. The bot could
 * already ROUTE through V3; it just could not SEE anyone else do it.
 *
 * On Solana the gate was a SOL balance drop of more than ~0.005, so every
 * stablecoin-funded buy was invisible too.
 *
 * Both are now keyed on the MONEY: the target signed a transaction, tokens
 * arrived, and value left them. That is a buy however it was routed. These
 * tests drive the real cycle against each of those routes.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert');
const { ethers } = require('ethers');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'copyentry-'));
process.env.WALLET_SECRET = 'w'.repeat(48);
process.env.TRADEBOT_TOKEN = 'x:y';
process.env.ENABLED_CHAINS = 'ethereum,solana';

const core = require('./core');
const watchers = require('./watchers');
const solana = require('./solana');

const TARGET = '0x' + 'ab'.repeat(20);
const TOKEN = '0x' + 'de'.repeat(20);
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const V2_PAIR = '0x' + '22'.repeat(20);
const V3_POOL = '0x' + '33'.repeat(20);
const AGGREGATOR = '0x' + '44'.repeat(20);
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const pad = (a) => ethers.zeroPadValue(String(a).toLowerCase(), 32);
const CHAT = 900;

function seed(chain = 'ethereum') {
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.wallets = [{ id: 'w1', name: 'Wallet 1', address: '0x' + '11'.repeat(20), positions: {}, orders: [], history: [] }];
  u.activeWalletId = 'w1';
  u.copy = { on: true, targets: [{ id: 'cp1', address: TARGET, chain, mode: 'trades',
    buyEth: '0.01', maxEth: '1', spentEth: 0, bought: {}, holding: {}, copySell: true, cursor: 100 }] };
  return u;
}

/** Drive one EVM copy cycle where the target received TOKEN in a transaction
 *  routed through `sender`, funded as described. Returns the buys it mirrored. */
async function evmCycle({ sender, txFrom = TARGET, value = 10n ** 17n, paysWith = null } = {}) {
  const u = seed('ethereum');
  const hash = '0x' + 'fe'.repeat(32);
  const buys = [];
  const realProv = core.providerFor, realBuy = core.buy, realBal = core.tokenBalanceOrNull;
  core.providerFor = () => ({
    getBlockNumber: async () => 200,
    getLogs: async () => [{ address: TOKEN, topics: [TRANSFER, pad(sender), pad(TARGET)], transactionHash: hash }],
    getTransaction: async () => ({ from: txFrom, value, hash }),
    getTransactionReceipt: async () => ({ logs: paysWith
      ? [{ address: paysWith, topics: [TRANSFER, pad(TARGET), pad(sender)] }]
      : [{ address: TOKEN, topics: [TRANSFER, pad(sender), pad(TARGET)] }] }),
  });
  core.buy = async (chatId, ca, amt, chain, wid) => {
    buys.push({ ca, amt, chain });
    return { sym: 'DEAD', gotTokens: 1, spentEth: Number(amt), native: 'ETH', hash: '0x' + '1'.repeat(64), chain };
  };
  core.tokenBalanceOrNull = async () => 1000n;
  try { await watchers._test.copyCycle(); }
  finally { core.providerFor = realProv; core.buy = realBuy; core.tokenBalanceOrNull = realBal; }
  return buys;
}

/** Same cycle, but the caller supplies the raw log list — for shapes the
 *  friendly helper above cannot express (NFT topics, several tokens in one
 *  transaction, hundreds of dust transfers). */
async function evmRaw(logs, { onProbe = () => {}, value = 10n ** 17n } = {}) {
  seed('ethereum');
  const buys = [];
  const realProv = core.providerFor, realBuy = core.buy, realBal = core.tokenBalanceOrNull;
  core.providerFor = () => ({
    getBlockNumber: async () => 200,
    getLogs: async () => logs,
    getTransaction: async (h) => { onProbe(h); return { from: TARGET, value, hash: h }; },
    getTransactionReceipt: async () => ({ logs: [] }),
  });
  core.buy = async (chatId, ca, amt, chain) => { buys.push({ ca, amt, chain }); return { sym: 'X', gotTokens: 1, spentEth: Number(amt), native: 'ETH', hash: '0x' + '1'.repeat(64), chain }; };
  core.tokenBalanceOrNull = async () => 1000n;
  try { await watchers._test.copyCycle(); }
  finally { core.providerFor = realProv; core.buy = realBuy; core.tokenBalanceOrNull = realBal; }
  return buys;
}

// ---------------------------------------------------------------- EVM routes
test('a Uniswap V2 buy is mirrored — the one route that always worked', async () => {
  assert.equal((await evmCycle({ sender: V2_PAIR })).length, 1, 'the V2 route stopped working');
});

test('a Uniswap V3 buy is mirrored', async () => {
  // The pool is not getPair(token, WETH), so the old detector never saw it.
  const buys = await evmCycle({ sender: V3_POOL });
  assert.equal(buys.length, 1, 'a V3 buy is still invisible');
  assert.equal(buys[0].ca, TOKEN);
});

test('an aggregator buy is mirrored — 1inch, 0x, CoW, another bot\'s router', async () => {
  // The tokens arrive from a settlement contract that is nobody\'s pool.
  assert.equal((await evmCycle({ sender: AGGREGATOR })).length, 1, 'an aggregator buy is still invisible');
});

test('a buy funded with WETH rather than ETH is mirrored', async () => {
  // tx.value is 0; the money leaves as an ERC-20 Transfer of WETH.
  const buys = await evmCycle({ sender: V3_POOL, value: 0n, paysWith: WETH });
  assert.equal(buys.length, 1, 'a WETH-funded buy is still invisible');
});

test('a buy funded with USDC is mirrored', async () => {
  const buys = await evmCycle({ sender: AGGREGATOR, value: 0n, paysWith: USDC });
  assert.equal(buys.length, 1, 'a stablecoin-funded buy is still invisible');
});

// ---------------------------------------------------------------- not a buy
test('an airdrop is NOT mirrored — nothing left the target', async () => {
  // The failure that costs money: mirroring tokens somebody was simply sent
  // spends real funds on a token nobody bought.
  assert.deepEqual(await evmCycle({ sender: AGGREGATOR, value: 0n }), [],
    'an airdrop was mirrored as a buy');
});

test('a transfer the target did not sign is NOT mirrored', async () => {
  // Tokens arrive, value moved, but somebody else sent the transaction.
  assert.deepEqual(await evmCycle({ sender: V2_PAIR, txFrom: '0x' + '99'.repeat(20) }), [],
    'somebody else\'s transaction was mirrored');
});

test('an unreadable transaction is NOT mirrored', async () => {
  const u = seed('ethereum');
  const buys = [];
  const realProv = core.providerFor, realBuy = core.buy;
  core.providerFor = () => ({
    getBlockNumber: async () => 200,
    getLogs: async () => [{ address: TOKEN, topics: [TRANSFER, pad(V2_PAIR), pad(TARGET)], transactionHash: '0x' + 'fe'.repeat(32) }],
    getTransaction: async () => { throw new Error('rpc down'); },
    getTransactionReceipt: async () => { throw new Error('rpc down'); },
  });
  core.buy = async () => { buys.push(1); return {}; };
  try { await watchers._test.copyCycle(); }
  finally { core.providerFor = realProv; core.buy = realBuy; }
  assert.deepEqual(buys, [], 'a buy fired on a transaction that could not be read');
});

test('the V2-only pair lookup is gone, not merely bypassed', async () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'watchers.js'), 'utf8');
  assert.ok(!/pairOf/.test(SRC), 'pairOf survives — dead code that invites the old gate back');
  assert.ok(!/GET_PAIR_ABI/.test(SRC), 'the getPair ABI is still here');
  assert.match(SRC, /_targetPaid\(t\.chain, t\.address, hash\)/, 'the payment check is not wired in');
});

// ---------------------------------------------------------------- not a token
test('an NFT mint is NOT mirrored, even though the target paid ETH for it', async () => {
  // ERC-721 shares the ERC-20 Transfer signature hash and differs only in
  // indexing the token id as a FOURTH topic. A mint is a Transfer to the target
  // in a transaction they signed and sent value with — indistinguishable from a
  // token buy unless the topic count is checked. Mirroring one calls swap on an
  // NFT contract with real money.
  //
  // The old V2-pair test excluded these by accident: getPair on an NFT contract
  // returns the zero address. Nothing excluded them once that test went.
  const NFT = '0x' + '77'.repeat(20);
  const buys = await evmRaw([{ address: NFT, topics: [TRANSFER, pad(ethers.ZeroAddress), pad(TARGET), ethers.zeroPadValue('0x2a', 32)], transactionHash: '0x' + 'fe'.repeat(32) }]);
  assert.deepEqual(buys, [], 'an NFT mint was mirrored as a token buy');
});

test('a transaction delivering SEVERAL tokens is not guessed at', async () => {
  // Buying X also airdrops Y to the buyer — a marketing and scam pattern.
  // Mirrored blind, the bot buys Y as well, on the strength of somebody else's
  // token contract. We cannot tell which was bought, so we buy neither.
  const OTHER = '0x' + '88'.repeat(20);
  const hash = '0x' + 'fe'.repeat(32);
  const buys = await evmRaw([
    { address: TOKEN, topics: [TRANSFER, pad(V3_POOL), pad(TARGET)], transactionHash: hash },
    { address: OTHER, topics: [TRANSFER, pad(AGGREGATOR), pad(TARGET)], transactionHash: hash },
  ]);
  assert.deepEqual(buys, [], 'a bundled airdrop was mirrored alongside the real buy');
});

test('several Transfers of the SAME token are one buy, and one probe', async () => {
  // A reflection token emits a handful of Transfers per swap. Probing per LOG
  // rather than per TRANSACTION spent an RPC call on each of them.
  const hash = '0x' + 'fe'.repeat(32);
  let probes = 0;
  const buys = await evmRaw([
    { address: TOKEN, topics: [TRANSFER, pad(V3_POOL), pad(TARGET)], transactionHash: hash },
    { address: TOKEN, topics: [TRANSFER, pad(V3_POOL), pad(TARGET)], transactionHash: hash },
    { address: TOKEN, topics: [TRANSFER, pad(V3_POOL), pad(TARGET)], transactionHash: hash },
  ], { onProbe: () => probes++ });
  assert.equal(buys.length, 1, 'a reflection token was mirrored more than once');
  assert.equal(probes, 1, `one transaction cost ${probes} getTransaction calls`);
});

test('probes are bounded, not only buys', async () => {
  // A wallet that collects dust airdrops produces candidate transactions
  // without limit, and every one used to cost a getTransaction whether or not
  // it could become a trade.
  let probes = 0;
  const logs = Array.from({ length: 200 }, (_, i) => ({
    address: '0x' + String(i % 90 + 10).repeat(20), topics: [TRANSFER, pad(AGGREGATOR), pad(TARGET)],
    transactionHash: '0x' + String(i % 90 + 10).repeat(32),
  }));
  await evmRaw(logs, { onProbe: () => probes++, value: 0n });
  assert.ok(probes <= 25, `${probes} transactions were probed in one cycle`);
});

// ---------------------------------------------------------------- Solana
const TARGET_SOL = 'TargetWa11etAddressBase58xxxxxxxxxxxxxxxxxxxx';
const MINT = 'M1ntAddressBase58xxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const LP_RECEIPT = 'LPrece1ptTokenBase58xxxxxxxxxxxxxxxxxxxxxxxx';

/** One parsed Solana transaction. `holds` is what the target had BEFORE (mint →
 *  raw), `gets` what they had AFTER. `signer` says whether the followed wallet
 *  actually signed it. */
function solTx({ holds = {}, gets = {}, solSpent = 0n, signer = true } = {}) {
  const entry = (mint, amount, i) => ({ owner: TARGET_SOL, mint, accountIndex: i + 5,
    uiTokenAmount: { amount: String(amount), decimals: mint === USDC_SOL ? 6 : 6 } });
  return {
    meta: {
      preTokenBalances: Object.entries(holds).map(([m, v], i) => entry(m, v, i)),
      postTokenBalances: Object.entries(gets).map(([m, v], i) => entry(m, v, i)),
      preBalances: [1_000_000_000],
      postBalances: [Number(1_000_000_000n - solSpent)],
    },
    transaction: { message: { accountKeys: [{ pubkey: { toString: () => TARGET_SOL }, signer }] } },
  };
}
const solBought = (tx) => watchers._test._solBuyMintFromTx({ getParsedTransaction: async () => tx }, 'sig1', TARGET_SOL);

test('Solana: a SOL-funded buy is seen — the route that always worked', async () => {
  assert.equal(await solBought(solTx({ gets: { [MINT]: 1000 }, solSpent: 20_000_000n })), MINT);
});

test('Solana: a buy funded with USDC is seen', async () => {
  // The gate was "SOL balance fell by > 0.005", so every stablecoin-funded buy
  // on the chain was invisible.
  const tx = solTx({ holds: { [USDC_SOL]: 50_000_000 }, gets: { [USDC_SOL]: 10_000_000, [MINT]: 1200 }, solSpent: 5000n });
  assert.equal(await solBought(tx), MINT, 'a USDC-funded Solana buy is still invisible');
});

test('Solana: an airdrop is NOT seen — nothing left the target', async () => {
  assert.equal(await solBought(solTx({ gets: { [MINT]: 1000 }, solSpent: 5000n })), null,
    'a Solana airdrop was mirrored as a buy');
});

// ------------------------------------------------- what the audit found
test('Solana: a transaction the target did NOT sign is refused', async () => {
  // getSignaturesForAddress returns every transaction that so much as MENTIONS
  // the address. Without a signer check that hands an attacker the bot's wallet:
  // airdrop a scam mint to a followed wallet, arrange for something of theirs to
  // tick down, and every follower buys it. The EVM side has refused
  // tx.from !== target since the rewrite; Solana had no equivalent at all.
  const tx = solTx({ holds: { [USDC_SOL]: 50_000_000 }, gets: { [USDC_SOL]: 10_000_000, [MINT]: 1200 }, signer: false });
  assert.equal(await solBought(tx), null, 'a stranger\'s transaction was accepted as the target\'s buy');
});

test('Solana: withdrawing an LP position is NOT a buy', async () => {
  // Removing liquidity burns the receipt token and credits the underlying mints,
  // and reclaiming rent means SOL goes UP. "Any token of theirs fell" read the
  // burnt receipt as payment — so the target EXITING a position made the bot BUY.
  const tx = solTx({ holds: { [LP_RECEIPT]: 5_000_000 }, gets: { [MINT]: 120_000_000 }, solSpent: -2_000_000n });
  assert.equal(await solBought(tx), null, 'an LP withdrawal was mirrored as a buy');
});

test('Solana: a closed token account is not read as a payment', async () => {
  // A closed ATA vanishes from postTokenBalances entirely, which the old loop
  // read as a decrease to zero.
  const tx = solTx({ holds: { [LP_RECEIPT]: 5_000_000 }, gets: { [MINT]: 900 }, solSpent: 5000n });
  assert.equal(await solBought(tx), null, 'a closed account counted as payment');
});

test('Solana: dust leaving is not payment — a quote spend has a floor', async () => {
  // One raw unit ticking down was proof of purchase. The SOL leg has had a
  // 0.005 floor all along; the token leg had none.
  const tx = solTx({ holds: { [USDC_SOL]: 50_000_000 }, gets: { [USDC_SOL]: 49_999_999, [MINT]: 1200 }, solSpent: 5000n });
  assert.equal(await solBought(tx), null, 'one raw unit of USDC bought a token');
});

test('Solana: several tokens arriving is refused, not guessed at', async () => {
  // The pick was "largest decimals-normalized increase" — a ranking by unit
  // COUNT, which is supply and not value. A scam mint issuing ten million units
  // outranks a real 1,200-unit acquisition every time. The EVM path refuses this
  // ambiguity; so must this one.
  const SCAM = 'ScamAirdropM1ntBase58xxxxxxxxxxxxxxxxxxxxxxxx';
  const tx = solTx({ holds: { [USDC_SOL]: 500_000_000 },
    gets: { [USDC_SOL]: 0, [MINT]: 1200, [SCAM]: 10_000_000_000 }, solSpent: 2_044_280n });
  assert.equal(await solBought(tx), null, 'the bundled scam airdrop was bought instead of the real trade');
});

test('Solana: one mint spread over two accounts nets out instead of faking a spend', async () => {
  // preMap was keyed by MINT, so the last entry overwrote the first, while the
  // post lookup found the other account — a flat balance read as a spend.
  const tx = {
    meta: {
      preTokenBalances: [
        { owner: TARGET_SOL, mint: USDC_SOL, accountIndex: 5, uiTokenAmount: { amount: '10000000', decimals: 6 } },
        { owner: TARGET_SOL, mint: USDC_SOL, accountIndex: 6, uiTokenAmount: { amount: '0', decimals: 6 } },
      ],
      postTokenBalances: [
        { owner: TARGET_SOL, mint: USDC_SOL, accountIndex: 5, uiTokenAmount: { amount: '0', decimals: 6 } },
        { owner: TARGET_SOL, mint: USDC_SOL, accountIndex: 6, uiTokenAmount: { amount: '10000000', decimals: 6 } },
        { owner: TARGET_SOL, mint: MINT, accountIndex: 7, uiTokenAmount: { amount: '900', decimals: 6 } },
      ],
      preBalances: [1_000_000_000], postBalances: [999_995_000],
    },
    transaction: { message: { accountKeys: [{ pubkey: { toString: () => TARGET_SOL }, signer: true }] } },
  };
  assert.equal(await solBought(tx), null, 'moving USDC between your own accounts counted as buying');
});

test('Solana: another owner\'s balances are never read as the target\'s', async () => {
  const tx = {
    meta: {
      preTokenBalances: [{ owner: 'SomebodyE1seXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', mint: USDC_SOL, accountIndex: 5, uiTokenAmount: { amount: '50000000', decimals: 6 } }],
      postTokenBalances: [
        { owner: 'SomebodyE1seXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', mint: USDC_SOL, accountIndex: 5, uiTokenAmount: { amount: '0', decimals: 6 } },
        { owner: TARGET_SOL, mint: MINT, accountIndex: 7, uiTokenAmount: { amount: '900', decimals: 6 } },
      ],
      preBalances: [1_000_000_000], postBalances: [999_995_000],
    },
    transaction: { message: { accountKeys: [{ pubkey: { toString: () => TARGET_SOL }, signer: true }] } },
  };
  assert.equal(await solBought(tx), null, 'somebody else paying counted as the target paying');
});

// ---------------------------------------------------------------- which ones survive a cap
test('when the cap bites it is the OLDEST candidates that are dropped', async () => {
  // t.cursor is already at head by the time the caps stop the loop, so anything
  // unreached is gone rather than deferred. Walking oldest-first therefore spent
  // the whole budget on the stalest candidates and discarded the freshest: the
  // bot would mirror what the wallet did four minutes ago and silently miss what
  // it did four seconds ago — the exact inversion of what copy-trading is for.
  const probed = [];
  const logs = Array.from({ length: 60 }, (_, i) => ({
    address: '0x' + String(10 + i).repeat(20),
    topics: [TRANSFER, pad(V3_POOL), pad(TARGET)],
    transactionHash: '0x' + String(10 + i).repeat(32),
    blockNumber: 100 + i,
  }));
  await evmRaw(logs, { onProbe: (h) => probed.push(h) });
  assert.ok(probed.length > 0 && probed.length <= 25, `probed ${probed.length}`);
  // The newest candidate must be among them; the oldest must not.
  const newest = logs[logs.length - 1].transactionHash;
  const oldest = logs[0].transactionHash;
  assert.ok(probed.includes(newest), 'the newest transaction was dropped by the cap');
  assert.ok(!probed.includes(oldest), 'the oldest transaction survived while newer ones were dropped');
});

test('a dropped batch is announced, not swallowed', async () => {
  // A cap that discards work reads as "nothing happened" unless it says so.
  const warn = [];
  const real = console.warn;
  console.warn = (...a) => warn.push(a.join(' '));
  try {
    const logs = Array.from({ length: 60 }, (_, i) => ({
      address: '0x' + String(10 + i).repeat(20), topics: [TRANSFER, pad(V3_POOL), pad(TARGET)],
      transactionHash: '0x' + String(10 + i).repeat(32), blockNumber: 100 + i,
    }));
    await evmRaw(logs, { value: 0n });
  } finally { console.warn = real; }
  assert.ok(warn.some((l) => /older candidate tx skipped/.test(l)), `the cap dropped work silently: ${JSON.stringify(warn)}`);
});

test('under the cap, nothing is dropped and order is preserved', async () => {
  const probed = [];
  const logs = Array.from({ length: 4 }, (_, i) => ({
    address: '0x' + String(10 + i).repeat(20), topics: [TRANSFER, pad(V3_POOL), pad(TARGET)],
    transactionHash: '0x' + String(10 + i).repeat(32), blockNumber: 100 + i,
  }));
  await evmRaw(logs, { onProbe: (h) => probed.push(h), value: 0n });
  assert.equal(probed.length, 4, 'a batch under the cap lost candidates');
  // Newest first, which is the same rule the cap follows — one ordering, not two.
  assert.deepEqual(probed, logs.map((l) => l.transactionHash).reverse(),
    'the freshest candidate is not examined first');
});
