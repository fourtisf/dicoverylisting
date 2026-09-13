'use strict';
/*
 * Gas priority, and the transaction type it produces.
 *
 * Two defects lived here, both invisible because they failed by doing NOTHING:
 *
 *   1. gasOverrides() returned `{}` for every chain except Robinhood, so the
 *      user's ⛽ Gas priority (Fast / Turbo) changed not one wei of what got
 *      signed on Ethereum, Base, BNB or Arbitrum — and neither did the sell
 *      retry escalation, which exists precisely to get a stuck exit out. A sell
 *      that failed BECAUSE the gas was too low retried twice more at exactly
 *      the same gas.
 *
 *   2. rawSend forced `type: 0` with gasPrice = the node's current suggestion,
 *      i.e. zero headroom. A legacy transaction's gasPrice IS its max fee, so a
 *      base fee that ticked up between signing and inclusion left the trade
 *      sitting in the mempool. On Ethereum that is the difference between one
 *      block and several minutes.
 *
 * Everything here runs against a mock node so the fee arithmetic is checked
 * exactly, not approximately.
 */
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert');
const { ethers } = require('ethers');

const BASE_FEE = ethers.parseUnits('30', 'gwei');    // a busy-but-normal Ethereum block
const NODE_TIP = ethers.parseUnits('1.5', 'gwei');   // what the node suggests
const hex = (v) => '0x' + BigInt(v).toString(16);

let server, core;
test.before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const one = (r) => {
        const ok = (result) => ({ jsonrpc: '2.0', id: r.id, result });
        switch (r.method) {
          case 'eth_chainId': return ok('0x1');
          case 'eth_blockNumber': return ok('0x1');
          case 'eth_gasPrice': return ok(hex(BASE_FEE + NODE_TIP));
          case 'eth_maxPriorityFeePerGas': return ok(hex(NODE_TIP));
          case 'eth_getTransactionCount': return ok('0x7');
          case 'eth_sendRawTransaction': return ok('0x' + '11'.repeat(32));
          case 'eth_getBlockByNumber': return ok({
            number: '0x1', hash: '0x' + '22'.repeat(32), parentHash: '0x' + '33'.repeat(32),
            timestamp: '0x1', baseFeePerGas: hex(BASE_FEE), gasLimit: '0x1c9c380', gasUsed: '0x0',
            miner: '0x' + '44'.repeat(20), extraData: '0x', transactions: [],
            // ethers rejects a block without these — omit them and getBlock throws,
            // which silently routes the code under test down its fallback path.
            difficulty: '0x0', nonce: '0x0000000000000000',
          });
          default: return ok(null);
        }
      };
      const parsed = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;
  // Point every chain at the mock BEFORE core.js reads env at module-eval time.
  for (const k of ['ETHEREUM_RPC', 'BASE_RPC', 'BSC_RPC', 'ARBITRUM_RPC', 'RPC']) process.env[k] = url;
  process.env.GAS_CACHE_MS = '0';           // no caching across assertions
  process.env.WALLET_SECRET = 'w'.repeat(48);
  process.env.DATA_DIR = require('node:path').join(require('node:os').tmpdir(), 'gasprio-test');
  core = require('./core');
});
test.after(() => server && server.close());

// ---------------------------------------------------------------- the no-op bug
test('gas priority is never silently discarded, on any chain', async () => {
  for (const chain of ['robinhood', 'ethereum', 'base', 'bsc', 'arbitrum']) {
    const g = await core.gasOverrides(chain, 1);
    assert.ok(Object.keys(g).length > 0, `${chain} returned {} — the boost has nothing to apply to`);
    assert.ok(g.gasPrice || g.maxFeePerGas, `${chain} named no fee at all`);
  }
});

test('Fast and Turbo actually cost more than Normal, on every chain', async () => {
  // The setting is sold as "confirms quicker". If the numbers do not move, the
  // bot is charging the user's attention for a placebo.
  for (const chain of ['robinhood', 'ethereum', 'base', 'bsc', 'arbitrum']) {
    const bid = async (m) => { const g = await core.gasOverrides(chain, m); return g.maxPriorityFeePerGas != null ? g.maxPriorityFeePerGas : g.gasPrice; };
    const [normal, fast, turbo] = [await bid(1), await bid(2), await bid(3)];
    assert.ok(fast > normal, `${chain}: Fast is not above Normal`);
    assert.ok(turbo > fast, `${chain}: Turbo is not above Fast`);
  }
});

test('the sell retry escalation genuinely escalates', async () => {
  // SELL_ESCALATION in telegram.js is [{}, {gasMult:2}, {gasMult:4}]. If those
  // multipliers do not reach the signed transaction, a sell stuck on low gas
  // just fails three times instead of once.
  for (const chain of ['ethereum', 'base', 'arbitrum']) {
    const bid = async (m) => { const g = await core.gasOverrides(chain, m); return g.maxPriorityFeePerGas != null ? g.maxPriorityFeePerGas : g.gasPrice; };
    const [try1, try2, try3] = [await bid(1), await bid(2), await bid(4)];
    assert.ok(try2 > try1 && try3 > try2, `${chain}: retries re-send at the same fee`);
    assert.equal(try3, try1 * 4n, `${chain}: the 4x retry is not 4x`);
  }
});

// ---------------------------------------------------------------- EIP-1559
test('an EIP-1559 chain gets 1559 fees, with headroom over the base fee', async () => {
  const g = await core.gasOverrides('ethereum', 1);
  assert.ok(g.maxFeePerGas, 'Ethereum still gets a legacy gasPrice');
  assert.equal(g.maxPriorityFeePerGas, NODE_TIP, 'the node’s tip suggestion is not being used');
  // 2x base-fee headroom is what stops a rising base fee from stranding the tx.
  assert.equal(g.maxFeePerGas, BASE_FEE * 2n + NODE_TIP);
  assert.ok(g.maxFeePerGas > BASE_FEE * 2n, 'no headroom — a base-fee tick would strand this');
});

test('the boost raises the tip, not the headroom — you still only pay base+tip', async () => {
  const n = await core.gasOverrides('ethereum', 1);
  const t = await core.gasOverrides('ethereum', 3);
  assert.equal(t.maxPriorityFeePerGas, n.maxPriorityFeePerGas * 3n, 'Turbo did not treble the competitive bid');
  // maxFeePerGas is a ceiling, never a charge: it rises only by the extra tip.
  assert.equal(t.maxFeePerGas - n.maxFeePerGas, t.maxPriorityFeePerGas - n.maxPriorityFeePerGas);
});

test('Robinhood keeps the legacy fee its node is known to accept', async () => {
  const g = await core.gasOverrides('robinhood', 1);
  assert.ok(g.gasPrice, 'Robinhood must keep a legacy gasPrice');
  assert.equal(g.maxFeePerGas, undefined, 'Robinhood must not be switched to type-2');
});

// ---------------------------------------------------------------- signed type
test('rawSend signs type-2 on Ethereum and type-0 on Robinhood', async () => {
  // Decode what actually goes on the wire — the fee object is only useful if the
  // signature carries it.
  const wallet = new ethers.Wallet('0x' + '11'.repeat(32), core.providerFor('ethereum'));
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    if (b.method === 'eth_sendRawTransaction') seen.push(ethers.Transaction.from(b.params[0]));
    return realFetch(url, opts);
  };
  try {
    await core.rawSend(wallet, 'ethereum', '0x' + '55'.repeat(20), '0x', 21000n, 1n, 1);
    await core.rawSend(wallet, 'robinhood', '0x' + '55'.repeat(20), '0x', 21000n, 1n, 1);
  } finally { global.fetch = realFetch; }

  assert.equal(seen.length, 2, 'both sends did not reach the node');
  const [eth, rh] = seen;
  assert.equal(eth.type, 2, 'Ethereum transaction is still legacy — the mempool-stall bug is back');
  assert.ok(eth.maxFeePerGas > eth.maxPriorityFeePerGas, 'no base-fee headroom on the signed tx');
  assert.equal(rh.type, 0, 'Robinhood must keep signing type-0');
});

test('a caller-supplied fee is the fee that gets signed', async () => {
  // The preflight quotes a fee and hands it to rawSend; if rawSend re-derived it,
  // the user could be quoted one number and charged another.
  const wallet = new ethers.Wallet('0x' + '11'.repeat(32), core.providerFor('ethereum'));
  const fee = { maxFeePerGas: ethers.parseUnits('99', 'gwei'), maxPriorityFeePerGas: ethers.parseUnits('7', 'gwei') };
  let signed = null;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    if (b.method === 'eth_sendRawTransaction') signed = ethers.Transaction.from(b.params[0]);
    return realFetch(url, opts);
  };
  try { await core.rawSend(wallet, 'ethereum', '0x' + '55'.repeat(20), '0x', 21000n, 0n, 1, { fee }); }
  finally { global.fetch = realFetch; }
  assert.equal(signed.maxFeePerGas, fee.maxFeePerGas);
  assert.equal(signed.maxPriorityFeePerGas, fee.maxPriorityFeePerGas);
});
