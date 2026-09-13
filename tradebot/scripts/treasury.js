'use strict';
/*
 * treasury — show the fee-treasury balance on every enabled chain, read live
 * from each RPC. Run on the VPS:  node scripts/treasury.js
 * The address comes from the bot's own config (CFG.feeWallet / solFeeWallet),
 * so it always matches where fees are actually sent. Run it before and after a
 * trade — the chain the trade happened on should rise by ~1% of the trade value.
 */
const { ethers } = require('ethers');
const core = require('../core');

(async () => {
  const evm = core.CFG.feeWallet, sol = core.CFG.solFeeWallet;
  console.log('\n=== Fee treasury balances ===');
  console.log('EVM treasury:', evm || '(unset)');
  console.log('SOL treasury:', sol || '(unset)');
  console.log('');
  const chains = core.chains.enabledChains();
  for (const c of chains) {
    const isSol = core.chains.isSvm(c.key);
    const addr = isSol ? sol : evm;
    if (!addr) { console.log(`  ${c.emoji || ''} ${c.name}: no treasury set`); continue; }
    try {
      const bal = await core.ethBalance(addr, c.key);
      const dec = isSol ? 9 : 18;
      const amt = Number(ethers.formatUnits(bal, dec));
      const label = ((c.emoji || '') + ' ' + c.name).padEnd(20);
      console.log(`  ${label} ${amt.toFixed(6)} ${c.native}`);
    } catch (e) { console.log(`  ${c.name}: read failed (${(e && e.message) || e})`); }
  }
  console.log('\nTip: run before AND after a trade. The chain you traded on should');
  console.log('increase by ~1% of the trade size — that is the fee landing.\n');
  process.exit(0);
})().catch((e) => { console.error('treasury check failed:', (e && e.message) || e); process.exit(1); });
