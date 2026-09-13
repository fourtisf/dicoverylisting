'use strict';
/*
 * v4-discover — find a chain's Uniswap V4 PoolManager, from a token that trades
 * on one of its pools.
 *
 * Usage (run on the VPS, inside tradebot/):
 *   node scripts/v4-discover.js <token-address> [chainKey] [--blocks 200000]
 *
 * Why this exists: v4 has no factory and no pair contract. Every pool lives
 * inside ONE PoolManager, so there is nothing to look up and no address to
 * derive — it has to be observed. The PoolManager emits Initialize(...) when a
 * pool is created, and that log carries the WHOLE PoolKey: both currencies, the
 * fee, the tick spacing and the hooks. So: scan back for an Initialize whose
 * currency0/currency1 is this token, and whatever contract emitted it IS the
 * PoolManager for this deployment.
 *
 * Read-only. Spends nothing, signs nothing.
 *
 * It prints a ready-to-paste ENV block at the BOTTOM, and verifies the address
 * it found by reading the pool back through the same path the bot will use — so
 * a PASS here means the bot will price the token, not just that a log matched.
 */
const { ethers } = require('ethers');
const chains = require('../chains');
const v4 = require('../v4');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const token = (args[0] || '').trim();
const chainKey = (args[1] || chains.DEFAULT_CHAIN).trim();
const BLOCKS = Math.max(1, Number(flag('blocks', 200000)));
// Public RPCs cap eth_getLogs ranges; 10k is the common ceiling.
const STEP = Math.max(1, Number(flag('step', 9000)));

if (!ethers.isAddress(token)) {
  // Described rather than offered: a bracketed placeholder in a `node …` line
  // is a redirect to bash and dies before the script starts.
  console.error('This takes the TOKEN address (0x + 40 hex) as its first argument, and');
  console.error('optionally a chain key as its second. --blocks and --step each take a');
  console.error('number and bound how far back the Initialize scan walks.');
  process.exit(1);
}
const chain = chains.chainOf(chainKey);
if (!chain) { console.error(`unknown chain "${chainKey}" — one of: ${chains.ENABLED.join(', ')}`); process.exit(1); }

// Both the filter and the parser come from v4.js — ONE definition. They were
// two here, and the parser's copy was missing the `indexed` keywords: topic0
// still hashed correctly so the filter matched, then every matched log failed to
// parse and was swallowed by a `continue`. The script announced a hit and then
// printed nothing whatsoever.
const INIT_TOPIC = v4.INITIALIZE_TOPIC;
const asTopic = (addr) => ethers.zeroPadValue(ethers.getAddress(addr), 32);

(async function main() {
  const prov = chains.providerFor(chainKey);
  const head = await prov.getBlockNumber();
  const from = Math.max(0, head - BLOCKS);
  console.log(`🔎 ${chain.name} · token ${token}`);
  console.log(`   scanning blocks ${from} → ${head} for a v4 Initialize log (step ${STEP})\n`);

  // The token is currency0 OR currency1 — both indexed, so it takes two filters.
  const found = [];
  // ⚠️ A PROBE THAT PRINTS NOTHING FOR TWO MINUTES READS AS HUNG, and this one
  // printed only on an error or a hit — so a clean scan that is simply working
  // its way back looks identical to a wedged process. That is this repo's own
  // rule ("a probe that hangs is worse than one that says it cannot answer"),
  // and the arithmetic makes it easy to hit: 200k blocks in 9k steps is ~23
  // iterations x 2 topic filters = up to 46 SERIAL requests, on a chain
  // deliberately exempt from JSON-RPC batching.
  const steps = Math.ceil((head - from) / STEP);
  let done = 0;
  for (let lo = head; lo > from && !found.length; lo -= STEP) {
    const hi = lo;
    const start = Math.max(from, lo - STEP + 1);
    done++;
    // One line, rewritten in place, so the operator can see it moving without
    // 23 lines of noise above the answer.
    if (process.stdout.isTTY) process.stdout.write(`\r   … ${done}/${steps} windows searched (back to block ${start})   `);
    else if (done === 1 || done % 10 === 0) console.log(`   … ${done}/${steps} windows searched`);
    for (const topics of [[INIT_TOPIC, null, asTopic(token)], [INIT_TOPIC, null, null, asTopic(token)]]) {
      let logs = [];
      try { logs = await prov.getLogs({ fromBlock: start, toBlock: hi, topics }); }
      catch (e) { console.log(`   … blocks ${start}-${hi}: ${(e && (e.shortMessage || e.message)) || e}`); continue; }
      for (const l of logs) found.push(l);
    }
    if (found.length) { if (process.stdout.isTTY) process.stdout.write('\r'.padEnd(60) + '\r'); console.log(`   ✔ hit in blocks ${start}-${hi}`); }
  }
  if (!found.length && process.stdout.isTTY) process.stdout.write('\r'.padEnd(60) + '\r');

  if (!found.length) {
    console.log('❌ No v4 Initialize log for this token in the scanned range.');
    console.log('   Widen it (--blocks 1000000), or the pool may predate the range / be on another chain.');
    process.exit(2);
  }

  console.log(`\n📄 ${found.length} Initialize log${found.length === 1 ? '' : 's'} matched.`);
  const iface = new ethers.Interface([v4.INITIALIZE_EVENT]);
  const seen = new Map();   // poolManager → [pool keys]
  const unparsed = [];
  for (const l of found) {
    let d;
    try { d = iface.parseLog(l); } catch (e) { unparsed.push({ l, why: (e && (e.shortMessage || e.message)) || String(e) }); continue; }
    if (!d) { unparsed.push({ l, why: 'parseLog returned null' }); continue; }
    const pm = ethers.getAddress(l.address);
    if (!seen.has(pm)) seen.set(pm, []);
    seen.get(pm).push({
      id: d.args[0], currency0: d.args[1], currency1: d.args[2],
      fee: Number(d.args[3]), tickSpacing: Number(d.args[4]), hooks: d.args[5], block: l.blockNumber,
    });
  }
  // A log that matched the filter but could not be decoded is a REPORT, never a
  // silent skip. The first version swallowed these with a bare `continue`, and a
  // run that found the pool printed "hit" and then nothing at all — the worst
  // possible output, because it looks like the script finished.
  if (unparsed.length) {
    console.log(`\n⚠️ ${unparsed.length} matched log(s) could not be decoded with the Initialize ABI:`);
    for (const u of unparsed.slice(0, 3)) {
      console.log(`   emitter ${u.l.address} · block ${u.l.blockNumber} · ${u.l.topics.length} topics`);
      console.log(`   ${u.why}`);
    }
    console.log('   → this deployment\'s Initialize event differs from Uniswap\'s. The raw topics above');
    console.log('     are the evidence; topic[1] is the poolId, topic[2]/[3] the two currencies.');
  }
  if (!seen.size) {
    console.log('\n❌ Nothing decodable. Not enough to configure the bot — do not guess an address from the above.');
    process.exit(3);
  }

  let best = null;
  for (const [pm, keys] of seen) {
    console.log(`\n📦 PoolManager candidate: ${pm}   (${keys.length} pool${keys.length === 1 ? '' : 's'})`);
    for (const k of keys) {
      const hooked = k.hooks !== ethers.ZeroAddress;
      console.log(`   · fee ${k.fee} · tickSpacing ${k.tickSpacing} · hooks ${hooked ? k.hooks + ' ⚠️' : 'none'}`);
      console.log(`     currency0 ${k.currency0}${k.currency0 === ethers.ZeroAddress ? '  (native ETH)' : ''}`);
      console.log(`     currency1 ${k.currency1}`);
      console.log(`     poolId ${k.id} · block ${k.block}`);
      // The id in the log is authoritative. If our own poolId() reproduces it,
      // the key encoding matches this deployment — if it does not, the bot would
      // compute the wrong id and find nothing however correct the address is.
      const mine = v4.poolId(String(k.currency0).toLowerCase(), String(k.currency1).toLowerCase(), k.fee, k.tickSpacing, k.hooks);
      console.log(`     poolId check: ${mine.toLowerCase() === String(k.id).toLowerCase() ? '✅ matches' : '❌ MISMATCH — ' + mine}`);
      if (!best && !hooked) best = { pm, k };
      if (hooked) console.log('     ⚠️ hooked pool — this bot only sweeps hookless keys, so it will not find this one');
    }
    if (!best && keys.length) best = { pm, k: keys[0] };
  }

  if (!best) {
    console.log('\n❌ Decoded logs, but none usable as a pool key. Nothing to configure.');
    process.exit(4);
  }
  // Verify end to end: set the env the bot reads, then ask the bot's own reader.
  {
    const P = chainKey.toUpperCase();
    process.env[`${P}_V4_POOLMANAGER`] = best.pm;
    const dec = await new ethers.Contract(token, ['function decimals() view returns (uint8)'], prov).decimals().catch(() => 18);
    const px = await v4.price(token, chainKey, Number(dec), { chainOf: chains.chainOf, providerFor: chains.providerFor }).catch((e) => ({ err: e }));
    console.log('\n──────── verification (the bot\'s own reader) ────────');
    if (px && px.priceEth > 0) {
      console.log(`✅ priced: ${px.priceEth} ${chain.native} per token · fee ${px.fee} · tickSpacing ${px.tickSpacing}`);
      console.log(`   quote currency: ${px.quote === v4.NATIVE ? 'native ETH' : px.quote}`);
    } else {
      console.log('❌ the reader could not price it with this PoolManager.');
      console.log(`   If the poolId check above MATCHED, the storage slot is the likely culprit — try ${P}_V4_POOLS_SLOT=<n>,`);
      console.log('   or deploy/point at a StateView with ' + P + '_V4_STATEVIEW=<address>.');
      if (px && px.err) console.log('   ' + ((px.err.shortMessage || px.err.message) || px.err));
    }
    console.log('\n──────── paste into tradebot/.env ────────');
    console.log(`${P}_V4_POOLMANAGER=${best.pm}`);
    // Pricing is half the job. Without the router the card shows the market and
    // says it cannot fill a swap — which is honest, but not what you want.
    console.log(`# Buy/Sell also needs the Universal Router (and Permit2 to sell):`);
    console.log(`# ${P}_V4_UNIVERSAL_ROUTER=0x…`);
    console.log(`# ${P}_V4_PERMIT2=0x…`);
    console.log(`# Every swap is simulated before it is signed, so a wrong address here`);
    console.log(`# refuses the trade rather than sending one.`);
    if (best.k.fee && !v4.DEFAULT_TIERS.some(([f, t]) => f === best.k.fee && t === best.k.tickSpacing)) {
      console.log(`${P}_V4_FEE_TIERS=${v4.DEFAULT_TIERS.map(([f, t]) => `${f}:${t}`).join(',')},${best.k.fee}:${best.k.tickSpacing}`);
      console.log(`# ↑ this pool's fee/tickSpacing is not one of the four the sweep tries by default`);
    }
    console.log('\nThen: pm2 restart dexvra-tradebot --update-env');
  }
})().catch((e) => { console.error('failed:', (e && (e.stack || e.message)) || e); process.exit(1); });
