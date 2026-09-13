'use strict';
/*
 * v3-diagnose — show EXACTLY why the engine does (or doesn't) route a token to
 * V3. Run on the VPS:  node scripts/v3-diagnose.js <tokenCA> [chainKey]
 * Prints: the V3 addresses the bot actually resolved, per-fee-tier getPool
 * results, the V2 vs V3 WETH depth, and which venue bestDexVenue picks + why.
 */
const { ethers } = require('ethers');
const core = require('../core');

const FACTORY_ABI = ['function getPool(address,address,uint24) view returns (address)'];
const V3_FEES = [100, 500, 3000, 10000];

(async () => {
  const ca = String(process.argv[2] || '').trim();
  const chainKey = String(process.argv[3] || 'robinhood').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) {
    // ⚠️ DESCRIBED, NEVER OFFERED AS A COMMAND. A `<tokenCA>` in a line that
    // starts with `node` dies in bash — `<` is a redirect — before this script
    // runs at all, which reads as a broken tool rather than an unfilled blank.
    // There is no real value to print here: only the operator knows which
    // token they are asking about.
    console.error('This takes the TOKEN address (0x + 40 hex) as its first argument,');
    console.error('and optionally a chain key as its second. Run it from tradebot/.');
    process.exit(1);
  }
  const chain = core.chainOf(chainKey);
  console.log(`\n=== V3 diagnose · ${chain.name} · token ${ca} ===\n`);

  // 1. What the bot actually loaded (reflects pm2's live env if run inside it,
  //    else the .env file).
  console.log('Resolved chain.v3 (what the engine sees):');
  console.log('  factory:', chain.v3 && chain.v3.factory || '(empty)');
  console.log('  router :', chain.v3 && chain.v3.router || '(empty)');
  const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || '').trim());
  const v3on = chain.v3 && isAddr(chain.v3.factory) && isAddr(chain.v3.router);
  console.log('  → V3 enabled for this chain:', v3on ? 'YES' : 'NO (factory/router missing or malformed — bot will use V2)');
  console.log('  weth used for pool lookup:', chain.weth, '\n');
  if (!v3on) { console.log('FIX: the addresses above are not valid — see the summary at the end.\n'); }

  // 2. Probe the factory for the token↔WETH pool at each fee tier.
  const prov = core.providerFor(chainKey);
  if (v3on) {
    console.log('factory.getPool(token, WETH, fee) per tier:');
    const f = new ethers.Contract(chain.v3.factory, FACTORY_ABI, prov);
    const weth = new ethers.Contract(chain.weth, ['function balanceOf(address) view returns (uint256)'], prov);
    for (const fee of V3_FEES) {
      try {
        const pool = await f.getPool(ca, chain.weth, fee);
        if (!pool || pool === ethers.ZeroAddress) { console.log(`  fee ${fee}: no pool`); continue; }
        let bal = 0n; try { bal = await weth.balanceOf(pool); } catch (e) { console.log(`  fee ${fee}: pool ${pool} — balanceOf FAILED: ${e.shortMessage || e.message}`); continue; }
        console.log(`  fee ${fee}: pool ${pool} — WETH depth ${Number(ethers.formatEther(bal)).toFixed(4)} ${chain.native}`);
      } catch (e) { console.log(`  fee ${fee}: getPool FAILED — ${e.shortMessage || e.message} (custom factory signature?)`); }
    }
    console.log('');
  }

  // 3. Let the engine decide, and show the verdict.
  try {
    const pick = await core.bestDexVenue(ca, chainKey);
    console.log('bestDexVenue verdict:');
    console.log('  kind :', pick.kind, pick.kind === 'v3' ? '✅ (will trade the V3 pool)' : '⚠️ (still using the shallow V2 pair)');
    console.log('  depth:', pick.wethBal != null ? Number(ethers.formatEther(pick.wethBal)).toFixed(4) + ' ' + chain.native : '?');
    if (pick.kind === 'v3') console.log('  pool :', pick.pool, '· fee', pick.feeTier);
  } catch (e) { console.log('bestDexVenue threw:', e.message); }

  console.log('\n=== summary ===');
  if (!v3on) {
    console.log('V3 is OFF because the engine did not load valid factory/router. If .env HAS them,');
    console.log('pm2 is holding a STALE/empty value that overrides .env. Fix with a CLEAN restart:');
    console.log('  pm2 delete dexvra-tradebot');
    console.log('  cd /opt/dexvra/tradebot && pm2 start index.js --name dexvra-tradebot --update-env && pm2 save');
  } else {
    console.log('V3 is enabled. If a pool with real WETH depth showed above but bestDexVenue still');
    console.log('picked v2, paste this whole output back. If getPool FAILED for every tier, the');
    console.log('custom factory uses a non-standard getPool — paste the output and we adapt it.');
  }
  console.log('');
})().catch((e) => { console.error('diagnose crashed:', e.message); process.exit(1); });
