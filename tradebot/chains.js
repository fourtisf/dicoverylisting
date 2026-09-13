'use strict';
/*
 * Multi-chain registry for the Dexvra Trade Bot.
 *
 * Every chain here is EVM and exposes a Uniswap-V2-style router (we always use the
 * SupportingFeeOnTransfer swap variants so fee-on-transfer tokens work). A user's
 * single custodial key is the SAME address on all of these, so switching chains
 * needs no new wallet.
 *
 * `curve:true` marks a chain where launchpad bonding curves exist (Robinhood Chain);
 * everywhere else the bot trades tokens directly on that chain's DEX.
 *
 * RPCs, routers and wrapped-native addresses are ALL overridable via env — verify
 * them for your deployment before going live (a wrong router/RPC = failed trades).
 * Solana / non-EVM is intentionally out of scope here (separate module).
 */
const { ethers } = require('ethers');
const env = (k, d) => { const v = (process.env[k] || '').trim(); return v || d; };

const CHAINS = {
  robinhood: {
    key: 'robinhood', name: 'Robinhood Chain', emoji: '🪶', chainId: Number(env('CHAIN_ID', '4663')), native: 'ETH', curve: true,
    rpc: env('RPC', 'https://rpc.mainnet.chain.robinhood.com'),
    // Uniswap V3 on Robinhood Chain.
    //
    // These are NOT guesses, and they are NOT the canonical addresses copied off
    // another chain — that is what put a wrong quoter here once, and it is still
    // banned. They are the deployment record the previous comment here told the
    // next person to go and read, quoted rather than recalled:
    //
    //     github.com/Uniswap/contracts → deployments/json/4663.json
    //
    // AND IT CROSS-CHECKS. That file's `UniswapV2Router02` is byte-for-byte the
    // `DEX_ROUTER` default two lines below, which this repo has been trading
    // through since it was written — so the record and this file are describing
    // the same deployment, and a record that ever stops matching is a record of
    // some other chain. `robinhoodRouting.test.js` pins that equality for
    // exactly that reason.
    //
    // WHY IT MATTERS: `v3Cfg()` needs factory AND router, so blank meant the V3
    // leg was disabled outright — and a Pons V1 launch goes STRAIGHT INTO A
    // UNISWAP V3 POOL (the section on the Pons scan says so). So every Pons V1
    // token reached `bestDexVenue` with no V2 pair and no V3 config, and the
    // card answered "Dexvra can't route through that yet" about an ordinary
    // Uniswap pool it was simply not configured to look in. `preflight:robinhood`
    // has been printing "they are untradeable until these are set" ever since;
    // this is that instruction, carried out.
    //
    // ⚠️ STILL WORTH MEASURING ON THE BOX, and the round that produced the Pons
    // scan is why: two researched Pons values both turned out wrong, and only
    // `preflight:robinhood` settled it. A wrong value here FAILS SAFE — a factory
    // with no code makes `getPool` throw and `v3BestPool` returns null, and a
    // wrong router cannot pass the `estimateGas` the V3 buy does before it signs
    // — but "fails safe" is not "is correct":
    //     node scripts/v3-discover.js <a real Pons pool address> robinhood
    // The QUOTER is deliberately never read (pricing is off the pool's own
    // slot0); it is carried so the record is complete and `v3-discover` has
    // something to compare against.
    v3: { factory: env('ROBINHOOD_V3_FACTORY', '0x1f7d7550b1b028f7571e69a784071f0205fd2efa'),
          router: env('ROBINHOOD_V3_ROUTER', '0xcaf681a66d020601342297493863e78c959e5cb2'),
          quoter: env('ROBINHOOD_V3_QUOTER', '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7') },
    factory: env('FACTORY_ADDR', '0xf0a093bc6ab5bb408ca1f084ec2161d879edaa57'),
    router: env('DEX_ROUTER', '0x89e5db8b5aa49aa85ac63f691524311aeb649eba'),
    weth: env('WETH', '0x0bd7d308f8e1639fab988df18a8011f41eacad73'),
    explorer: env('EXPLORER', 'https://explorer.mainnet.chain.robinhood.com').replace(/\/+$/, ''),
  },
  ethereum: {
    key: 'ethereum', name: 'Ethereum', emoji: '⟠', chainId: 1, native: 'ETH', curve: false,
    rpc: env('ETHEREUM_RPC', 'https://ethereum-rpc.publicnode.com'),   // llamarpc default was flaky → balances silently read 0
    router: env('ETHEREUM_ROUTER', '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'),   // Uniswap V2
    weth: env('ETHEREUM_WETH', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
    // Uniswap V3 (canonical mainnet deployment: factory / SwapRouter02 / QuoterV2).
    // When all three are set the engine can route to whichever pool is deeper.
    v3: { factory: env('ETHEREUM_V3_FACTORY', '0x1F98431c8aD98523631AE4a59f267346ea31F984'),
          router: env('ETHEREUM_V3_ROUTER', '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'),
          quoter: env('ETHEREUM_V3_QUOTER', '0x61fFE014bA17989E743c5F6cB21bF9697530B21e') },
    explorer: 'https://etherscan.io',
  },
  base: {
    key: 'base', name: 'Base', emoji: '🔵', chainId: 8453, native: 'ETH', curve: false,
    rpc: env('BASE_RPC', 'https://mainnet.base.org'),
    router: env('BASE_ROUTER', '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24'),        // Uniswap V2 (Base)
    weth: env('BASE_WETH', '0x4200000000000000000000000000000000000006'),
    v3: { factory: env('BASE_V3_FACTORY', '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'),
          router: env('BASE_V3_ROUTER', '0x2626664c2603336E57B271c5C0b26F421741e481'),
          quoter: env('BASE_V3_QUOTER', '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a') },
    explorer: 'https://basescan.org',
  },
  bsc: {
    key: 'bsc', name: 'BNB Chain', emoji: '🟡', chainId: 56, native: 'BNB', curve: false,
    rpc: env('BSC_RPC', 'https://bsc-dataseed.binance.org'),
    router: env('BSC_ROUTER', '0x10ED43C718714eb63d5aA57B78B54704E256024E'),         // PancakeSwap V2
    weth: env('BSC_WBNB', '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'),             // WBNB
    v3: { factory: env('BSC_V3_FACTORY', '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7'),   // Uniswap V3 on BNB
          router: env('BSC_V3_ROUTER', '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2'),
          quoter: env('BSC_V3_QUOTER', '0x78D78E420Da98ad378D7799bE8f4AF69033EB077') },
    explorer: 'https://bscscan.com',
  },
  arbitrum: {
    key: 'arbitrum', name: 'Arbitrum', emoji: '🔷', chainId: 42161, native: 'ETH', curve: false,
    rpc: env('ARBITRUM_RPC', 'https://arb1.arbitrum.io/rpc'),
    router: env('ARBITRUM_ROUTER', '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24'),    // Uniswap V2 (Arbitrum)
    weth: env('ARBITRUM_WETH', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'),
    v3: { factory: env('ARBITRUM_V3_FACTORY', '0x1F98431c8aD98523631AE4a59f267346ea31F984'),
          router: env('ARBITRUM_V3_ROUTER', '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'),
          quoter: env('ARBITRUM_V3_QUOTER', '0x61fFE014bA17989E743c5F6cB21bF9697530B21e') },
    explorer: 'https://arbiscan.io',
  },
  // Solana — NON-EVM (kind:'svm'). No chainId/router/weth/factory; swaps route through
  // the Jupiter aggregator, wrapped-native is the WSOL mint, decimals are 9 (lamports).
  // All Solana logic lives in solana.js; EVM code must branch on `kind === 'svm'` and
  // never build an ethers provider/contract for it. Kept OUT of the default enabled set
  // until the core/telegram Solana branches land (see ENABLED_CHAINS below).
  solana: {
    key: 'solana', name: 'Solana', emoji: '🟣', kind: 'svm', native: 'SOL', decimals: 9, curve: false,
    rpc: env('SOLANA_RPC', 'https://api.mainnet-beta.solana.com'),
    weth: 'So11111111111111111111111111111111111111112',   // WSOL mint (the "wrapped native")
    // solana.js OWNS the Jupiter base: it resolves one from JUP_BASES at request
    // time and fails over when a host has been withdrawn. A literal default here
    // would be a second, silently stale answer to the same question — which is
    // how this chain ended up pointed at a retired host in the first place.
    jupBase: env('JUP_BASE', ''),
    explorer: 'https://solscan.io',
  },
};

// Enabled set (default all). Operators can limit with ENABLED_CHAINS=robinhood,base
const ENABLED = env('ENABLED_CHAINS', 'robinhood,ethereum,base,bsc,arbitrum')
  .split(',').map((s) => s.trim()).filter((k) => CHAINS[k]);
const DEFAULT_CHAIN = ENABLED.includes('robinhood') ? 'robinhood' : (ENABLED[0] || 'robinhood');

const kindOf = (key) => (CHAINS[key] && CHAINS[key].kind) || 'evm';
const isSvm = (key) => kindOf(key) === 'svm';

// ---------------------------------------------------------------- provider tuning
//
// EXECUTION LATENCY LIVES HERE. Two ethers defaults dominated how long a trade
// took, and neither has anything to do with the chain:
//
//  1. pollingInterval (ethers default 4000ms) is how often the provider looks for
//     a new block, and therefore how late `tx.wait()` / `waitForTransaction()`
//     notice the receipt. On a sub-second L2 the tx was confirmed for up to FOUR
//     SECONDS before the bot found out — and a buy pays that twice (the swap, then
//     the bot-fee transfer), so ~8s of a fill was the bot sleeping on a timer.
//     Blocks here are 0.25-12s depending on the chain, so the interval is per
//     chain: no point polling Ethereum at 250ms, no excuse for polling an Orbit
//     L2 at 4000ms.
//
//  2. batchMaxCount:1 sends every single eth_call as its own HTTP request. Every
//     Promise.all in this codebase (venue probing, balances across wallets, token
//     metadata) therefore paid N round trips instead of one. Batching folds them
//     back into one request.
//
// The Robinhood node is deliberately EXEMPT from batching: it already returns a
// non-standard JSON-RPC error envelope on single calls (see rawSend in core.js),
// and a node that gets single-call framing wrong is not one to hand an array to.
// It keeps batchMaxCount:1 and gains only the faster polling.
//
// Both are overridable per chain (`<CHAIN>_RPC_POLL_MS`, `<CHAIN>_RPC_BATCH`) and
// globally (`RPC_POLL_MS`, `RPC_BATCH`) so an operator on a rate-limited public
// endpoint can dial them back without a code change.
const DEFAULT_POLL_MS = { robinhood: 250, arbitrum: 250, base: 400, bsc: 400, ethereum: 1000 };
const DEFAULT_BATCH = { robinhood: 1 };   // see above — everything else batches
function pollMsFor(key) {
  const v = Number(env(key.toUpperCase() + '_RPC_POLL_MS', env('RPC_POLL_MS', String(DEFAULT_POLL_MS[key] || 500))));
  return Math.min(10000, Math.max(100, v || 500));
}
function batchFor(key) {
  const v = Number(env(key.toUpperCase() + '_RPC_BATCH', env('RPC_BATCH', String(DEFAULT_BATCH[key] || 10))));
  return Math.min(100, Math.max(1, v || 1));
}

const _providers = {};
function providerFor(key) {
  const ch = CHAINS[key];
  if (!ch) throw new Error('unknown chain: ' + key);
  if (!_providers[key]) {
    if (ch.kind === 'svm') {
      // Solana: a @solana/web3.js Connection, NOT an ethers provider. Lazy-require so
      // the EVM path never loads the Solana deps.
      _providers[key] = require('./solana').getConnection(ch.rpc);
    } else {
      const net = new ethers.Network(ch.name, ch.chainId);
      const p = new ethers.JsonRpcProvider(ch.rpc, net, {
        batchMaxCount: batchFor(key),
        staticNetwork: net,
        pollingInterval: pollMsFor(key),
      });
      // Also set the property: the receipt poller reads provider.pollingInterval
      // directly, and only the constructor option would leave it at the default
      // if a future ethers changes how the option is threaded through.
      p.pollingInterval = pollMsFor(key);
      _providers[key] = p;
    }
  }
  return _providers[key];
}
function chainOf(key) { return CHAINS[key] || null; }
function isEnabled(key) { return ENABLED.includes(key); }
function enabledChains() { return ENABLED.map((k) => CHAINS[k]); }

module.exports = { CHAINS, ENABLED, DEFAULT_CHAIN, providerFor, chainOf, isEnabled, enabledChains, kindOf, isSvm, pollMsFor, batchFor };
