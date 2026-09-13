#!/usr/bin/env node
'use strict';
/*
 * venue:check — WHAT KIND OF MARKET IS THIS TOKEN'S, AND CAN WE ROUTE IT?
 *
 * WHY THIS EXISTS
 * A token can be indexed, priced, and still unroutable, and the card says only
 * that: "liquidity is on <X>, which Dexvra can't route through yet". Three
 * completely different venues produce that one sentence — a bonding curve whose
 * interface we could not read, a Uniswap-v4-style router, or an AMM whose
 * factory we do not know — and they need three different fixes.
 *
 * `abi:check --curve` answers a NEIGHBOURING question by scanning up to 200,000
 * blocks for the token's own transfers. On the node this matters for that is
 * slow enough to be abandoned, and it was. This asks the shorter question in
 * about five requests, because the indexer already knows the pair address and a
 * pair contract will say what it is if you ask it.
 *
 * ⚠️ NOTHING HERE IS A ROUTING DECISION. It reads and it prints. Every address
 * it reports came from the chain or from the indexer, and the bot still proves
 * a venue for itself before it will sign anything — the rule the whole curve
 * and v4-calldata work is built on.
 */
const { ethers } = require('ethers');
const { chainOf, enabledChains } = require('../chains.js');
const { steppedLogs } = require('../curveIface.js');
const build = require('../build.js');

/*
 * ⚠️ A PORT OF core.js's `DS_CHAIN_KEY`, AND A PORT IS A SECOND OWNER.
 *
 * The real map is a private const in core.js, and requiring core from a script
 * boots the whole trade bot — pollers, monitors and all. So it is copied, and
 * `venueCheck.test.js` asserts the copy EQUALS the original by reading core.js's
 * source: a stale slug here makes this check report "no pair" for a token the
 * bot prices perfectly well, which is a diagnostic lying in the reassuring
 * direction. Same guard `market:check`'s ported chain map carries, for the same
 * reason.
 */
const DS_SLUG = { ethereum: 'ethereum', base: 'base', bsc: 'bsc', arbitrum: 'arbitrum', solana: 'solana', robinhood: 'robinhood' };

const argv = process.argv.slice(2);
const optOf = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] || '') : ''; };
const token = argv.find((a) => /^0x[a-fA-F0-9]{40}$/.test(a)) || '';

const C = '\x1b[36m', G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';
const ok = (m) => console.log(`   ${G}✓${X} ${m}`);
const bad = (m) => console.log(`   ${R}✗${X} ${m}`);
const warn = (m) => console.log(`   ${Y}⚠${X} ${m}`);
const note = (m) => console.log(`     ${D}${m}${X}`);

/*
 * ⚠️ NO PASTEABLE COMMAND WITH A PLACEHOLDER IN IT — this repo's first rule, and
 * one it has now been bitten by four times. Only the operator knows which token
 * they mean, so the argument is DESCRIBED and no command is printed at all.
 * `<...>` in a shell dies as a redirect before the script even runs.
 */
function usage() {
  console.log(`\n${C}venue:check${X} — what kind of market does a token have, and can Dexvra route it?\n`);
  console.log('Run it with the token contract address as the argument, and');
  console.log('optionally --chain <key> (default: the first enabled chain).');
  console.log(`\nEnabled chains: ${enabledChains().map((c) => c.key).join(', ')}\n`);
}

const IFACE = new ethers.Interface([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function factory() view returns (address)',
  'function fee() view returns (uint24)',
  'function swapFee() view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

/** One eth_call, decoded, or null. A revert here is an ANSWER: the contract does
 *  not have that function, which is exactly what we are testing for. */
async function callOr(prov, to, fn, args = []) {
  try {
    const data = IFACE.encodeFunctionData(fn, args);
    const raw = await prov.call({ to, data });
    if (!raw || raw === '0x') return null;
    const out = IFACE.decodeFunctionResult(fn, raw);
    return out.length === 1 ? out[0] : out;
  } catch (_) { return null; }
}


/** The indexer's pair for this token on this chain — one HTTP request. */
async function dsPair(chainKey, ca) {
  const slug = DS_SLUG[chainKey] || chainKey;
  const url = `https://api.dexscreener.com/latest/dex/tokens/${ca}`;
  let r;
  try { r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } }); }
  catch (e) { return { ok: false, why: `could not reach DexScreener (${(e && e.message) || e})` }; }
  if (!r.ok) return { ok: false, why: `DexScreener answered HTTP ${r.status}` };
  const j = await r.json().catch(() => null);
  const pairs = ((j && j.pairs) || []).filter((p) => String(p.chainId).toLowerCase() === slug);
  if (!pairs.length) return { ok: true, pair: null, why: `DexScreener has no ${slug} pair for this token` };
  // Deepest first — a token seen through a thin pool reads as a different asset.
  pairs.sort((a, b) => Number((b.liquidity || {}).usd || 0) - Number((a.liquidity || {}).usd || 0));
  return { ok: true, pair: pairs[0], why: null };
}

async function main() {
  const chainKey = optOf('chain') || (enabledChains()[0] || {}).key;
  const chain = chainOf(chainKey);
  if (!chain) { bad(`unknown chain "${chainKey}"`); process.exit(2); }

  console.log(`\n${C}What kind of market does ${token} have?${X}`);
  console.log(`   ${D}checkout ${build.stamp()} · chain ${chainKey}${X}\n`);

  const prov = new ethers.JsonRpcProvider(chain.rpc, undefined, { staticNetwork: true, batchMaxCount: 1 });

  // ── 1. what does the indexer say? ────────────────────────────────────────
  console.log(`${C}1. What the indexer sees${X}`);
  const ds = await dsPair(chainKey, token);
  if (!ds.ok) { bad(ds.why); note('this run says nothing about the token — it is about reaching DexScreener'); }
  else if (!ds.pair) { warn(ds.why); }
  else {
    const p = ds.pair;
    ok(`${p.baseToken && p.baseToken.symbol} · dex "${p.dexId}" · liquidity $${Number((p.liquidity || {}).usd || 0).toLocaleString()}`);
    note(`pair address ${p.pairAddress}`);
  }

  const pair = ds.ok && ds.pair ? String(ds.pair.pairAddress) : '';
  if (!pair) {
    console.log(`\n${R}No pair address to probe.${X} Without one there is nothing on-chain to ask.\n`);
    process.exit(1);
  }

  // ── 2. is that pair a Uniswap-V2-style contract? ─────────────────────────
  console.log(`\n${C}2. Is that a Uniswap-V2-style pair? ${D}(one eth_call each)${X}`);
  const [t0, t1, res, fac] = await Promise.all([
    callOr(prov, pair, 'token0'),
    callOr(prov, pair, 'token1'),
    callOr(prov, pair, 'getReserves'),
    callOr(prov, pair, 'factory'),
  ]);
  const lc = (s) => String(s || '').toLowerCase();
  const isV2 = !!(t0 && t1 && res);
  let quoteTok = '';
  if (isV2) {
    const mine = lc(t0) === lc(token) || lc(t1) === lc(token);
    ok(`token0 ${t0}`);
    ok(`token1 ${t1}`);
    ok(`reserves ${res[0]} / ${res[1]}`);
    if (fac) ok(`factory ${fac}`); else warn('no factory() — a fork that does not expose it');
    if (!mine) {
      bad('…but neither side is the token asked about — this pair is somebody else\'s');
    } else {
      const quote = lc(t0) === lc(token) ? t1 : t0;
      quoteTok = quote;
      const [qs, fee, sfee] = await Promise.all([
        callOr(prov, quote, 'symbol'),
        callOr(prov, pair, 'fee'),
        callOr(prov, pair, 'swapFee'),
      ]);
      console.log(`\n${G}VERDICT: a Uniswap-V2-style pair, quoted in ${qs || quote}.${X}`);
      note(`quote token ${quote}`);
      note(fee != null ? `pool fee() = ${fee}` : (sfee != null ? `pool swapFee() = ${sfee}` : 'no fee()/swapFee() — the fork does not publish it'));
      if (fac && lc(fac) === lc(chain.factory || '')) note('and its factory is the one Dexvra already routes through');
      else note(`Dexvra's configured V2 factory is ${chain.factory || '(none)'} — this pair is from a different one`);
    }
  } else {
    warn('not a V2-style pair — token0()/token1()/getReserves() did not all answer');
    note('so it is a v4-style singleton, a bonding curve, or a custom AMM');
  }

  /*
   * ── 2b. WHOSE factory is it? ─────────────────────────────────────────────
   *
   * ⚠️ THIS IS THE CHEAP, DECISIVE QUESTION, and the first cut of this script
   * did not ask it — it went hunting for the router in the pair's trades, which
   * fails outright on a pair that has not traded lately (this one: 80 steps,
   * 39,999 blocks, zero logs).
   *
   * A `PairCreated` log is emitted BY THE FACTORY, and its two tokens are
   * INDEXED — so one topic-filtered query over the whole chain finds it, and the
   * log's own `address` IS the factory. No scan, no guessing. This node empties
   * a wide ADDRESS-filtered ask and has answered wide TOPIC-filtered ones (the
   * rule `curveTrade`'s seed is built on), which is exactly the shape this is.
   *
   * The transaction that emitted it is the one that CREATED the pair, and its
   * `to` is whatever added the first liquidity — the router, or the launchpad
   * contract that calls it. A candidate either way, proved below by getAmountsOut.
   */
  let head = 0;
  try { head = Number(await prov.getBlockNumber()); } catch (e) { bad(`could not read the chain head (${(e && e.message) || e})`); }

  const PAIR_CREATED = '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9';
  let factory = '', creator = '';
  if (isV2 && head) {
    console.log(`\n${C}2b. Whose factory created this pair? ${D}(one topic-filtered query — no scan)${X}`);
    const padded = '0x' + '0'.repeat(24) + token.slice(2).toLowerCase();
    let found = null, asked = 0, failed = null;
    for (const topics of [[PAIR_CREATED, padded], [PAIR_CREATED, null, padded]]) {
      if (found) break;
      asked++;
      try {
        const got = await prov.getLogs({ topics, fromBlock: 0, toBlock: head });
        if (Array.isArray(got) && got.length) found = got[0];
      } catch (e) { failed = e; }
    }
    if (found) {
      factory = ethers.getAddress(found.address);
      ok(`factory ${factory}  ${D}(block ${Number(found.blockNumber)})${X}`);
      // ⚠️ PROVED, not assumed: the factory must resolve THIS pair back.
      const fAbi = new ethers.Interface(['function getPair(address,address) view returns (address)']);
      try {
        const raw = await prov.call({ to: factory, data: fAbi.encodeFunctionData('getPair', [t0, t1]) });
        const back = raw && raw !== '0x' ? fAbi.decodeFunctionResult('getPair', raw)[0] : null;
        if (back && lc(back) === lc(pair)) ok('…and getPair() resolves back to this exact pair — proved');
        else warn(`getPair() answered ${back} — that is NOT this pair, so this factory is not the one`);
      } catch (_) { warn('the factory does not expose getPair() — unusual for a V2 fork'); }
      const ctx = await prov.getTransaction(found.transactionHash).catch(() => null);
      if (ctx && ctx.to) {
        creator = ethers.getAddress(ctx.to);
        ok(`created by a call to ${creator}  ${D}selector ${String(ctx.data).slice(0, 10)}${X}`);
        note('that is the router or the launchpad contract that calls it — proved below');
      }
      console.log(`\n${G}   → Dexvra can route this venue once it knows that factory and a router.${X}`);
    } else if (failed) {
      bad(`the node refused the topic query (${(failed && (failed.shortMessage || failed.message)) || failed})`);
      note('so this run says nothing about the factory — it is about the node, not the pair');
    } else {
      warn(`no PairCreated log names this token in ${asked} topic-filtered quer(ies)`);
      note('either this node empties whole-chain queries too, or the fork renamed the event');
    }
  }

  // ── 3. what does a real trade actually call? ─────────────────────────────
  console.log(`\n${C}3. What does a real trade call? ${D}(the pair's own logs — narrow, not a scan)${X}`);
  let logs = [];
  const SPAN = Math.max(200, Number(optOf('blocks') || 40000));
  if (head) {
    /*
     * ⚠️ THE BOT'S OWN STEPPED WALK, NOT A SINGLE WIDE `getLogs`.
     *
     * The first cut of this section asked one 20,000-block range and reported
     * "no logs from the pair" for a pair doing $6,069 of volume a day. This node
     * SILENTLY ANSWERS `[]` when a range is too wide — the defect `steppedLogs`
     * exists for, documented at its own definition — so the wide ask reported a
     * busy pair as a dead one, and the check said the opposite of the truth on
     * the one line that matters. Driving the bot's walk is also the rule: a
     * check that asks its own way is how fonts:check printed nine green ticks
     * over a banner drawing boxes.
     */
    /*
     * ⚠️ THE BUDGET HAS TO FOLLOW THE SPAN, or `--blocks` is decoration.
     * `steppedLogs` defaults to 48 steps of 500, so it reaches 24,000 blocks
     * whatever span it is handed — a run asking for 40,000 quietly searched
     * 24,000 and reported the shortfall as "no logs from the pair", which is the
     * refusal quoting a range it never walked. Capped, because this is a
     * diagnostic making one request per step.
     */
    const STEP = 500;
    const budget = Math.min(240, Math.ceil(SPAN / STEP));
    const w = await steppedLogs(prov, { address: pair }, { head, span: SPAN, step: STEP, budget, want: 40 });
    logs = w.logs;
    if (!logs.length && w.errs) warn(`every range refused (${(w.lastErr && (w.lastErr.shortMessage || w.lastErr.message)) || w.lastErr})`);
    note(`walked ${w.walked} block(s) in ${w.stepped} step(s) — ${logs.length} log(s)`);
  }
  if (!logs.length) {
    warn('no logs from the pair in the blocks actually walked');
    note('rerun with --blocks and a larger number if the pair trades rarely');
  }

  /*
   * ⚠️ THE ROUTER PROBE RUNS WHETHER OR NOT THE PAIR HAS TRADED LATELY, and the
   * first cut did not — it lived inside `if (logs.length)`, so a pair with no
   * recent trades (this one: 80 steps, 39,999 blocks, zero logs) produced no
   * candidates at all and the check simply gave up. 2b names a candidate from
   * the pair's CREATION, which cannot go stale, so there is always something to
   * prove or rule out.
   */
  {
    const seen = new Map();
    for (let i = logs.length - 1; i >= 0 && seen.size < 4; i--) {
      const h = logs[i].transactionHash;
      if (h && !seen.has(h)) seen.set(h, true);
    }
    const routers = new Set();
    if (creator) routers.add(creator);   // the pair's own creator is a candidate too
    for (const h of seen.keys()) {
      const tx = await prov.getTransaction(h).catch(() => null);
      if (!tx || !tx.data) continue;
      const sel = String(tx.data).slice(0, 10);
      const words = Math.floor((String(tx.data).length - 10) / 64);
      ok(`to ${tx.to}  selector ${sel}  ${words} word(s)  value ${ethers.formatEther(tx.value || 0n)}`);
      note(`tx ${h}`);
      if (tx.to && lc(tx.to) !== lc(pair)) routers.add(ethers.getAddress(tx.to));
    }

    /*
     * ⚠️ THE `to` OF A TRADE IS A CANDIDATE, NOT A ROUTER. It can be an
     * aggregator, a multicall, someone's own contract, or the pair itself. What
     * PROVES a router routes this pair is that it will quote it — `getAmountsOut`
     * is a view function on every V2 router, and a non-zero answer for
     * [quote, token] means that router's own factory resolves to THIS pair.
     * That is a fact read off the chain, and it is exactly the probe the buy
     * path would have to make before it could sign anything.
     */
    if (routers.size && quoteTok) {
      console.log(`\n${C}   …and does any of them QUOTE this pair? ${D}(getAmountsOut — one eth_call each)${X}`);
      const rAbi = new ethers.Interface(['function getAmountsOut(uint256,address[]) view returns (uint256[])']);
      const ONE = 10n ** 18n;
      for (const r of routers) {
        for (const [label, path] of [
          ['quote → token', [quoteTok, token]],
          [`W${chain.native} → quote → token`, [chain.weth, quoteTok, token]],
        ]) {
          if (!path.every((a) => /^0x[a-fA-F0-9]{40}$/.test(String(a || '')))) continue;
          let out = null;
          try {
            const raw = await prov.call({ to: r, data: rAbi.encodeFunctionData('getAmountsOut', [ONE, path]) });
            if (raw && raw !== '0x') out = rAbi.decodeFunctionResult('getAmountsOut', raw)[0];
          } catch (_) { /* a router that cannot quote this path says so by reverting */ }
          const last = out && out.length ? out[out.length - 1] : 0n;
          if (last > 0n) ok(`${r} quotes ${label} — 1.0 in → ${ethers.formatUnits(last, 18)} out`);
          else note(`${r} does not quote ${label}`);
        }
      }
      console.log(`\n   ${D}A router that QUOTES the path is one Dexvra could route through.${X}`);
      console.log(`   ${D}None quoting it means the trades go through something that is not a V2 router.${X}`);
    }
  }

  /*
   * ── 4. the question the verdict raises ──────────────────────────────────
   *
   * A pair quoted in a token that is neither the native coin nor WETH cannot be
   * bought in one leg. `core.buy` already has the two-leg shape (`_acquireQuote`
   * → swap → `_dumpQuote`) for exactly this, and it is only routable if the
   * FIRST leg is: native → the quote token. So the honest question is not "is
   * this pair tradable" but "can we reach its quote token", and this answers it
   * with the same two probes the bot would make.
   */
  if (isV2 && quoteTok) {
    console.log(`\n${C}4. Can the FIRST leg be routed — ${chain.native} → the quote token?${X}`);
    const facAbi = new ethers.Interface(['function getPair(address,address) view returns (address)']);
    let ours = null;
    if (chain.factory && chain.weth) {
      try {
        const raw = await prov.call({ to: chain.factory, data: facAbi.encodeFunctionData('getPair', [quoteTok, chain.weth]) });
        const a = raw && raw !== '0x' ? facAbi.decodeFunctionResult('getPair', raw)[0] : null;
        if (a && a !== ethers.ZeroAddress) ours = a;
      } catch (_) { /* a factory that will not answer is the same as no pair */ }
    }
    if (ours) {
      const r = await callOr(prov, ours, 'getReserves');
      if (r && (r[0] > 0n || r[1] > 0n)) {
        ok(`Dexvra's own V2 factory has a ${chain.native}/quote pair: ${ours}`);
        note(`reserves ${r[0]} / ${r[1]} — leg one is routable through the configured router`);
      } else { warn(`a pair exists at ${ours} but holds no reserves`); }
    } else {
      warn(`Dexvra's V2 factory has no W${chain.native}/quote pair for ${quoteTok}`);
      const q = await dsPair(chainKey, quoteTok);
      if (q.ok && q.pair) {
        note(`the indexer does have one: dex "${q.pair.dexId}" · pair ${q.pair.pairAddress}`);
        note(`quoted against ${q.pair.quoteToken && q.pair.quoteToken.symbol} · liquidity $${Number((q.pair.liquidity || {}).usd || 0).toLocaleString()}`);
        note('so leg one needs the same foreign-pair route as leg two');
      } else {
        note(q.ok ? 'and the indexer has no pair for it either' : q.why);
      }
    }
  }

  console.log('');
  return 0;
}

/*
 * ⚠️ THE CLI AND THE FUNCTION ARE SEPARATE, so a test can DRIVE this rather than
 * read it. The first version of the walk fix was "verified" by `node --check`,
 * which proves nothing about a runtime shape — and the defect it replaced (a
 * single wide `getLogs` silently answered `[]`) is precisely a runtime shape.
 */
module.exports = { DS_SLUG, main };

if (require.main === module) {
  if (!token) { usage(); process.exit(2); }
  main().then((c) => process.exit(c || 0))
    .catch((e) => { bad(`venue:check failed (${(e && e.stack) || e})`); process.exit(1); });
}
