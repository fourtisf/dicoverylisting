'use strict';
/*
 * v3-discover — find the Uniswap V3 addresses for a chain from a KNOWN V3 pool.
 *
 * Usage (run on the VPS, inside tradebot/):
 *   node scripts/v3-discover.js <v3-pool-address> [chainKey]
 *
 * Get the pool address from the token's DexScreener URL — the /robinhood/0x… part
 * IS the pool address of the pair shown (make sure the pair is labeled "v3").
 *
 * Read-only, spends nothing. It:
 *   1. reads pool.factory()                        → the V3 FACTORY (authoritative)
 *   2. reads fee()/token0/token1/liquidity         → sanity info
 *   3. scans recent Swap events and reports the most common `sender`
 *      → the ROUTER real users trade through (authoritative from real swaps)
 *   4. probes canonical QuoterV2 addresses for code → QUOTER candidate
 *
 * A clean ENV block is printed at the very BOTTOM so nothing scrolls away.
 */
const { ethers } = require('ethers');
const chains = require('../chains');

const POOL_ABI = [
  'function factory() view returns (address)',
  'function fee() view returns (uint24)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 obsIdx, uint16 obsCard, uint16 obsCardNext, uint8 feeProtocol, bool unlocked)',
];
const QUOTER_ABI = ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'];
const SWAP_TOPIC = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const QUOTER_CANDIDATES = [
  '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',   // QuoterV2 — mainnet/arbitrum/…
  '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',   // QuoterV2 — base
  '0x78D78E420Da98ad378D7799bE8f4AF69033EB077',   // QuoterV2 — bsc
];
const short = (a) => a ? a.slice(0, 8) + '…' + a.slice(-6) : '?';

// Most-common Swap `sender` over recent blocks = the router users actually use.
async function findRouter(prov, pool) {
  const latest = await prov.getBlockNumber();
  const spans = [3000, 20000, 120000];   // widen if a narrow window is empty
  for (const span of spans) {
    const from = Math.max(0, latest - span);
    let logs = null;
    try { logs = await prov.getLogs({ address: pool, topics: [SWAP_TOPIC], fromBlock: from, toBlock: latest }); }
    catch (_) {
      // RPC capped the range — try in ~1000-block chunks, newest first.
      logs = [];
      for (let hi = latest; hi > from; hi -= 1000) {
        try { const part = await prov.getLogs({ address: pool, topics: [SWAP_TOPIC], fromBlock: Math.max(from, hi - 1000), toBlock: hi }); logs.push(...part); if (logs.length > 50) break; } catch (_) { break; }
      }
    }
    if (logs && logs.length) {
      const tally = new Map();
      for (const l of logs) { const sender = '0x' + l.topics[1].slice(26); tally.set(sender, (tally.get(sender) || 0) + 1); }
      const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
      return { ranked, sampled: logs.length, span };
    }
  }
  return { ranked: [], sampled: 0, span: spans[spans.length - 1] };
}

(async () => {
  const pool = String(process.argv[2] || '').trim();
  const chainKey = String(process.argv[3] || 'robinhood').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(pool)) {
    // Described rather than offered: a bracketed placeholder in a `node …`
    // line is a redirect to bash and dies before the script starts.
    console.error('This takes the v3 POOL address (0x + 40 hex) as its first argument,');
    console.error('and optionally a chain key as its second. The pool address is the');
    console.error("/robinhood/0x… part of the token's DexScreener URL, for a pair");
    console.error('labelled "v3". Run it from tradebot/.');
    process.exit(1);
  }
  const ch = chains.chainOf(chainKey);
  if (!ch) { console.error('unknown chain key: ' + chainKey); process.exit(1); }
  const prov = new ethers.JsonRpcProvider(ch.rpc);
  const pc = new ethers.Contract(pool, POOL_ABI, prov);

  console.log(`\nV3 discovery on ${ch.name}\npool: ${pool}\n`);
  const factory = await pc.factory();
  const [fee, t0, t1, liq] = await Promise.all([
    pc.fee().catch(() => null), pc.token0().catch(() => null), pc.token1().catch(() => null), pc.liquidity().catch(() => null),
  ]);
  console.log(`fee tier: ${fee} · token0 ${short(t0)} · token1 ${short(t1)} · in-range liq ${liq}`);

  console.log('\nScanning recent Swap events for the router…');
  const { ranked, sampled, span } = await findRouter(prov, pool);
  let router = null;
  if (ranked.length) {
    console.log(`  ${sampled} swaps over ~${span} blocks. Senders (router = the top one):`);
    for (const [addr, n] of ranked.slice(0, 4)) {
      let hasCode = false; try { const c = await prov.getCode(addr); hasCode = c && c !== '0x'; } catch (_) {}
      console.log(`    ${n}×  ${addr}  ${hasCode ? '(has code ✓)' : '(EOA — skip)'}`);
    }
    router = ranked.find(([a]) => a)[0];
    // Prefer the top sender that actually has contract code.
    for (const [addr] of ranked) { try { const c = await prov.getCode(addr); if (c && c !== '0x') { router = addr; break; } } catch (_) {} }
  } else {
    console.log('  no Swap events found in the scanned window — do a real swap on DexScreener, then re-run.');
  }

  // ── PRICE FROM slot0 (no quoter needed) ────────────────────────────────
  // The bot prices/routes V3 off the pool's slot0 spot, so no QuoterV2 is
  // required. Compute the token price here so you can eyeball it against
  // DexScreener before enabling — if it matches, factory+router are good to go.
  console.log('\nPricing from slot0 (this is exactly how the bot will price V3)…');
  let priceOK = false;
  try {
    const s0 = await pc.slot0();
    const P = (Number(s0[0]) / 2 ** 96) ** 2;   // token1_raw per token0_raw
    const [d0, d1] = await Promise.all([
      new ethers.Contract(t0, ['function decimals() view returns (uint8)'], prov).decimals().then(Number).catch(() => 18),
      new ethers.Contract(t1, ['function decimals() view returns (uint8)'], prov).decimals().then(Number).catch(() => 18),
    ]);
    const wethIsT0 = t0.toLowerCase() === String(ch.weth).toLowerCase();
    // priceEth = native per whole NON-weth token
    const priceEth = wethIsT0 ? (10 ** (d1 - d0)) / P : P * (10 ** (d0 - d1));
    console.log(`  token0 ${short(t0)} (dec ${d0}) · token1 ${short(t1)} (dec ${d1}) · WETH is token${wethIsT0 ? 0 : 1}`);
    console.log(`  ➜ price ≈ ${priceEth.toExponential(4)} ${ch.native} per token`);
    console.log('    Compare this to DexScreener\'s "PRICE …WETH" — if they match, you\'re good.');
    priceOK = isFinite(priceEth) && priceEth > 0;
  } catch (e) { console.log('  ❌ slot0 price read failed: ' + (e.message || e)); }

  console.log('\n────────────────────────────────────────────────────────');
  if (priceOK && router) {
    console.log('✅ READY (no quoter needed). Add these to /opt/dexvra/tradebot/.env:\n');
    console.log(`${chainKey.toUpperCase()}_V3_FACTORY=${factory}`);
    console.log(`${chainKey.toUpperCase()}_V3_ROUTER=${router}`);
    console.log('\nThen: pm2 restart dexvra-tradebot --update-env');
    console.log('⚠️ ROUTER is inferred from real swaps. First confirm the price above matches');
    console.log('   DexScreener, then do ONE tiny test buy ($2) before trading larger.');
  } else {
    console.log('❌ NOT ready — paste this whole output back.');
    console.log(`   factory: ${factory}`);
    console.log(`   router : ${router || '(not found — do a swap on DexScreener then re-run)'}`);
  }
  console.log('────────────────────────────────────────────────────────\n');
})().catch((e) => { console.error('discover failed:', (e && e.message) || e); process.exit(1); });
