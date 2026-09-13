'use strict';
/*
 * Robinhood Chain preflight — a READ-ONLY check of every address and interface the
 * launchpad (snipe + curve trading) path depends on. Spends nothing, signs nothing.
 *
 *   cd tradebot && node scripts/robinhood-preflight.js
 *   cd tradebot && node scripts/robinhood-preflight.js --token 0x<a token you launched>
 *       …probes curveOf() AND (4t) names the contract + event that announced
 *       that token, which is the two .env lines the Pons scan needs. This is
 *       the probe that settles a launchpad integration: a configured factory
 *       that is live-but-WRONG reports "0 events", exactly like a quiet pad.
 *   cd tradebot && node scripts/robinhood-preflight.js --discover
 *   cd tradebot && node scripts/robinhood-preflight.js --tx 0xTHE_REAL_HASH
 *
 * NOTE the placeholder style: `0x<hash>` pasted into bash is a REDIRECT, and the
 * shell dies with "syntax error near unexpected token" before node ever runs.
 *
 * WHY THIS EXISTS
 * The bot discovers launches exactly one way: it filters the launchpad factory for a
 * TokenCreated event whose 12-field signature is a compile-time constant (core.js
 * FACTORY_ABI), decoded against one hard-coded address (chains.js `factory`). Both were
 * inherited from the robinfun.io launchpad this bot was originally built against.
 *
 * If pools.trade — which is built on Uniswap's launchpad contracts — emits a different
 * event, or lives at a different address, then `queryFilter` matches nothing. eth_getLogs
 * returns an EMPTY ARRAY for a topic nothing emits; it does not error. So the snipe loop
 * runs forever, reports healthy, and never fires. That failure is invisible from inside
 * the process, which is exactly why it needs a script that looks from the outside.
 *
 * THE DECISIVE QUESTION is `--tx`: take one real pools.trade launch transaction, and this
 * prints the topic0 of every log it emitted next to the topic0 the bot filters for. If
 * they differ, no environment variable can fix the snipe and the launchpad interface has
 * to be taught the new event. If only the ADDRESS differs, FACTORY_ADDR alone fixes it.
 *
 * Exits non-zero if any check fails, so it can gate a deploy.
 */
const path = require('path');
const { ethers } = require('ethers');

// Load .env the way the bot does, so this checks the REAL configuration and not the
// defaults — a preflight that tests something other than what runs is worse than none.
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) { /* dotenv optional */ }

const core = require(path.join(__dirname, '..', 'core'));

const CHAIN = 'robinhood';
const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? (argv[i + 1] || '') : ''; };
const TOKEN = argOf('--token').trim();
const TX = argOf('--tx').trim();
const SPAN = Math.max(100, Number(argOf('--blocks') || 5000));
const DISCOVER = argv.includes('--discover');
const EXPLORER = argOf('--explorer').trim().replace(/\/+$/, '');

let failures = 0;
let warnings = 0;
const ok = (name, info) => console.log(`  ✅ ${name}${info ? '  · ' + info : ''}`);
const bad = (name, info) => { failures++; console.log(`  ❌ ${name}${info ? '  · ' + info : ''}`); };
const warn = (name, info) => { warnings++; console.log(`  ⚠️  ${name}${info ? '  · ' + info : ''}`); };
const note = (s) => console.log(`     ${s}`);

function _ponsCfgSafe() {
  try { return require('../watchers')._test._ponsCfg(); } catch (_) { return { factories: [] }; }
}

async function main() {
  const chain = core.chainOf(CHAIN);
  if (!chain) { console.error('No `robinhood` entry in chains.js'); process.exit(1); }

  // The exact topic the snipe loop filters for, derived from the ABI the bot actually
  // ships rather than a hash pasted into a comment — if someone edits FACTORY_ABI, this
  // number moves with it.
  const iface = new ethers.Interface(core.FACTORY_ABI);
  const ev = iface.getEvent('TokenCreated');
  const TOPIC0 = ev.topicHash;

  console.log('\nRobinhood Chain preflight');
  console.log('═'.repeat(72));
  console.log(`  rpc        ${chain.rpc}`);
  console.log(`  chainId    ${chain.chainId} (expected)`);
  console.log(`  factory    ${chain.factory}      ← launchpad: snipe + curveOf`);
  console.log(`  router     ${chain.router}      ← V2-style DEX`);
  console.log(`  weth       ${chain.weth}`);
  console.log(`  v3         ${chain.v3 && chain.v3.router ? chain.v3.router : '(unset — V3 routing OFF)'}`);
  console.log(`  explorer   ${chain.explorer}`);
  console.log('─'.repeat(72));
  console.log(`  TokenCreated topic0 the bot filters for:`);
  console.log(`  ${TOPIC0}`);
  console.log(`  ${ev.format('full')}`);
  console.log('═'.repeat(72));

  const prov = core.providerFor(CHAIN);

  // ── 1. the node ───────────────────────────────────────────────────────────
  console.log('\n1. Node');
  let head = null;
  try {
    // eth_chainId over the wire, NOT provider.getNetwork(): chains.js builds the
    // provider with `staticNetwork`, so getNetwork() returns the CONFIGURED chainId
    // without ever asking the node — it would print a green check for a claim it
    // never tested, which is the exact failure mode this script exists to catch.
    const raw = await prov.send('eth_chainId', []);
    const nodeId = Number(BigInt(raw));
    if (nodeId === Number(chain.chainId)) ok(`chainId ${nodeId}`, 'confirmed by the node');
    else bad('chainId MISMATCH', `node says ${nodeId}, chains.js says ${chain.chainId} — set CHAIN_ID or RPC`);
    head = await prov.getBlockNumber();
    ok(`head block ${head}`);
  } catch (e) {
    bad('RPC unreachable', (e && e.message) || String(e));
    console.log('\nCannot continue without the node. Fix RPC first.\n');
    process.exit(1);
  }

  // ── 2. the addresses are contracts ────────────────────────────────────────
  // A dead address is the cheapest possible explanation for "nothing ever works",
  // and nothing in the running bot ever checks it.
  console.log('\n2. Addresses have code');
  const codeOf = async (label, addr, fatal) => {
    if (!addr || !/^0x[a-fA-F0-9]{40}$/.test(addr)) { warn(`${label} not set`, String(addr || '(empty)')); return false; }
    try {
      const code = await prov.getCode(addr);
      if (!code || code === '0x') {
        const msg = `${addr} has NO CODE on chain ${chain.chainId} — this address is dead here`;
        if (fatal) bad(label, msg); else warn(label, msg);
        return false;
      }
      ok(label, `${addr} (${(code.length - 2) / 2} bytes)`);
      return true;
    } catch (e) { bad(label, (e && e.message) || String(e)); return false; }
  };
  const factoryLive = await codeOf('factory', chain.factory, true);
  await codeOf('router', chain.router, true);
  await codeOf('weth', chain.weth, true);
  if (chain.v3 && chain.v3.router) await codeOf('v3 router', chain.v3.router, false);

  // ── 3. does the factory speak the launchpad interface? ────────────────────
  // curveOf() is the single function the whole curve path hangs on: resolveCurve()
  // calls it, and a revert there is collapsed into '' — the same value that means
  // "this token genuinely has no curve" — so the bot routes to the DEX instead.
  console.log('\n3. Launchpad interface (curveOf)');
  if (!factoryLive) {
    warn('skipped', 'factory has no code');
  } else if (!TOKEN) {
    note('Pass --token 0x<a known pools.trade token> to probe curveOf().');
  } else if (!/^0x[a-fA-F0-9]{40}$/.test(TOKEN)) {
    bad('--token is not an address', TOKEN);
  } else {
    const fc = new ethers.Contract(chain.factory, core.FACTORY_ABI, prov);
    try {
      const curve = await fc.curveOf(TOKEN);
      if (!curve || curve === ethers.ZeroAddress) {
        warn('curveOf returned the ZERO address', 'the factory knows this interface but not this token');
        note('→ Either the token did not launch on THIS launchpad, or it already graduated.');
        note('  The bot reads this as "no curve" and trades it on the DEX.');
      } else {
        ok('curveOf', `${TOKEN} → curve ${curve}`);
        const cc = new ethers.Contract(curve, core.CURVE_ABI, prov);
        try { ok('curve.graduated()', String(await cc.graduated())); }
        catch (e) { bad('curve.graduated() REVERTED', 'the curve does not expose the ABI the bot encodes buys against'); note(`  ${(e && e.shortMessage) || (e && e.message) || e}`); }
        try { const [c, t] = await cc.graduationProgress(); ok('curve.graduationProgress()', `${ethers.formatEther(c)} / ${ethers.formatEther(t)}`); }
        catch (_) { warn('curve.graduationProgress() reverted', 'progress % will not render'); }
      }
    } catch (e) {
      bad('curveOf REVERTED / not present', `the contract at ${chain.factory} is not this launchpad`);
      note(`  ${(e && e.shortMessage) || (e && e.message) || e}`);
      note('→ This is the decisive symptom: every curve buy/sell on this chain silently');
      note('  falls through to DEX routing, and the token card says "no pool/curve found".');
    }
  }

  // ── 4. is anything emitting the event the snipe waits for? ────────────────
  // The whole point: an empty result here is NOT an error, and inside the bot it is
  // indistinguishable from a quiet market.
  console.log(`\n4. Launch feed — scanning the last ${SPAN} blocks for TokenCreated`);
  if (!factoryLive) {
    warn('skipped', 'factory has no code');
  } else {
    const from = Math.max(0, head - SPAN);
    try {
      const logs = await prov.getLogs({ address: chain.factory, topics: [TOPIC0], fromBlock: from, toBlock: head });
      if (logs.length) {
        ok(`${logs.length} launch event(s)`, `blocks ${from}–${head}`);
        for (const l of logs.slice(-3)) {
          try { const p = iface.parseLog(l); note(`latest: ${p.args.symbol || '?'} — ${p.args.token} (block ${l.blockNumber})`); }
          catch (_) { note(`log at block ${l.blockNumber} did not decode against FACTORY_ABI`); }
        }
        note('→ The snipe trigger is alive for THIS launchpad.');
      } else {
        bad('ZERO launch events', `nothing emitted ${TOPIC0.slice(0, 18)}… from ${chain.factory} in ${SPAN} blocks`);
        note('→ This is what a dead sniper looks like. Either this launchpad is idle, or');
        note('  (far more likely) pools.trade launches emit a DIFFERENT event, from a');
        note('  DIFFERENT address. Run this again with --tx <a real launch tx> to find out.');
      }
    } catch (e) {
      bad('getLogs failed', (e && e.message) || String(e));
      note('→ If this says the block range is too wide, retry with --blocks 500.');
    }

    // Same window, ignoring the topic: is the factory doing ANYTHING at all? This
    // separates "wrong event signature" from "wrong address entirely".
    try {
      const any = await prov.getLogs({ address: chain.factory, fromBlock: from, toBlock: head });
      if (any.length) {
        const topics = [...new Set(any.map((l) => (l.topics && l.topics[0]) || '(none)'))];
        note(`factory emitted ${any.length} log(s) of ${topics.length} distinct type(s) in this window:`);
        for (const t of topics.slice(0, 8)) note(`   ${t}${t === TOPIC0 ? '   ← the one the bot filters for' : ''}`);
        if (!topics.includes(TOPIC0)) note('→ The address is live but emits none of the events the bot understands.');
      } else {
        note('factory emitted NO logs of any kind in this window — it looks idle or unused.');
      }
    } catch (_) { /* best-effort */ }
  }

  // ── 4p. Pons — the SECOND launchpad this chain's snipe watches ────────────
  // Discovery for Pons is on-chain (watchers._ponsScan). The FIRST defaults
  // came from public docs and were both wrong — no code at either address, and
  // a documented signature hashing to a topic0 this chain never emits — so what
  // ships now is what THIS script read off the chain, and what it still cannot
  // read is the ABI behind that topic0. This is the one command that says
  // whether the trigger is alive on the box, and it drives the bot's own
  // config and its own resolver rather than a second copy of either.
  console.log('\n4p. Pons launchpad (on-chain scan)');
  try {
    const ponsT = require('../watchers')._test;
    const pons = ponsT._ponsCfg();
    if (!pons.on) {
      note('LAUNCHPAD_PONS=0 — the Pons scan is OFF, nothing to probe.');
    } else if (!pons.topic0) {
      bad('PONS_EVENT is neither a topic0 nor a signature', 'set a 32-byte 0x… topic or an "event Foo(...)" line in tradebot/.env');
    } else {
      // topic-only is the SHIPPED state: the launch topic is known, its ABI is
      // not. Decoding lights up by itself if PONS_EVENT ever carries a real
      // signature (or a topic0 whose spelling PONS_KNOWN_SIGS holds).
      const piface = pons.decodable ? new ethers.Interface([pons.eventSig]) : null;
      const ptopic = pons.topic0;
      note(`factories ${(pons.factories || [pons.factory]).join(', ')}`);
      note(piface ? `event   ${piface.getEvent(pons.name).format('full')}`
        : `event   topic0 ${ptopic} — ABI unknown, so a launch is resolved by MEASUREMENT (named by the log AND minted in its own transaction)`);
      const flist = pons.factories && pons.factories.length ? pons.factories : [pons.factory];
      const codes = await Promise.all(flist.map((f) => prov.getCode(f).catch(() => null)));
      const liveF = flist.filter((f, i) => codes[i] && codes[i] !== '0x');
      for (let i = 0; i < flist.length; i++) {
        if (codes[i] == null) warn(`getCode failed for ${flist[i]}`, 'the node did not answer — rerun');
        else if (codes[i] === '0x') note(`${flist[i]} — no code (a retired deployment reads like this; harmless while another answers)`);
        else ok(`${flist[i]} has code`, `${(codes[i].length - 2) / 2} bytes`);
      }
      if (!liveF.length) bad('no PONS_FACTORY has code', 'set the real one in tradebot/.env');
      else {
        const pfrom = Math.max(0, head - SPAN);
        const plogs = (await Promise.all(liveF.map((f) => prov.getLogs({ address: f, topics: [ptopic], fromBlock: pfrom, toBlock: head }).catch(() => null))))
          .reduce((acc, r) => (r == null || acc == null ? null : acc.concat(r)), []);
        if (plogs == null) bad('getLogs failed', 'retry with --blocks 500');
        else if (plogs.length) {
          ok(`${plogs.length} Pons launch(es)`, `blocks ${pfrom}–${head}`);
          // ⚠️ Matching a log is HALF the trigger. The scan still has to name
          // the token, and in topic-only mode that is a measurement that can
          // legitimately refuse — a probe reporting "alive" off the log count
          // alone would print green over a scan that buys nothing, which is
          // this repo's most expensive recurring shape. So resolve each one
          // THROUGH THE BOT'S OWN RESOLVER and report what it actually got.
          let resolved = 0, refused = null;
          for (const l of plogs.slice(-3)) {
            if (piface) {
              try { const d = piface.parseLog(l); resolved++; note(`latest: ${d.args.token} by ${d.args.deployer} (block ${l.blockNumber})`); continue; }
              catch (_) { note(`log at block ${l.blockNumber} matched topic0 but did not fully decode — PONS_EVENT is close but not exact`); }
            }
            const r = await ponsT._ponsResolve(prov, l, liveF).catch((e) => ({ why: (e && e.message) || String(e) }));
            if (r && r.token) { resolved++; note(`latest: ${r.token} by ${r.deployer || '(sender unreadable)'} (block ${l.blockNumber}, resolved from the launch transaction)`); }
            else { refused = refused || (r && r.why); note(`block ${l.blockNumber}: NOT resolvable — ${r && r.why}`); }
          }
          if (resolved) ok('the Pons snipe trigger is alive', `${resolved} launch(es) resolved to a token`);
          else bad('Pons launches are seen but none resolves to a token', refused || 'set PONS_EVENT to the real signature in tradebot/.env');
        } else {
          // Zero decoded: let the chain say whether that is a quiet pad or a
          // stale signature — the same computed diagnosis the running bot makes.
          const praw = (await Promise.all(liveF.map((f) => prov.getLogs({ address: f, fromBlock: pfrom, toBlock: head }).catch(() => [])))).flat();
          if (praw.length) {
            const pt = [...new Set(praw.map((l) => (l.topics && l.topics[0]) || '(none)'))];
            warn('factory is LIVE but our event never matched', `${praw.length} log(s), ${pt.length} type(s) in this window`);
            for (const t of pt.slice(0, 6)) note(`   ${t}`);
            note('→ One of those topics IS the launch. PONS_EVENT takes it verbatim — no signature to hunt for:');
            note(`     PONS_EVENT=${pt[0]}`);
          } else {
            note(`no Pons activity in this window — the pad may simply be quiet, or these are not the factories it launches from.`);
            note(`→ SETTLE IT: rerun with --token <a token you launched on Pons> and this script will name the contract that announced it.`);
          }
        }
      }
    }
  } catch (e) { warn('Pons probe failed', (e && e.message) || String(e)); }

  // ── 4x. HOW is this token actually bought?  (--token) ─────────────────────
  /*
   * The launchpad's buy interface, read off a real trade, with NOTHING for the
   * operator to paste but the token address they already have.
   *
   * Asking for a transaction hash was the wrong shape twice over: it is a hunt
   * through an explorer, and the instruction that carried it was written with a
   * `<placeholder>` in it — which bash reads as a redirect, so the command
   * failed with `syntax error near unexpected token 'newline'` before it ran.
   * This file's own first rule: a command an operator can paste must contain
   * only real values, or it must not be a command.
   *
   * So the chain is asked instead. Every buy on a bonding curve moves the token
   * OUT of the curve contract, which emits a Transfer — and a Transfer log
   * carries its transaction hash. From there the call itself is one read away:
   * the contract that was called, the value, and the 4-byte selector. That is
   * exactly what a curve route has to be built from.
   */
  if (TOKEN && /^0x[a-fA-F0-9]{40}$/.test(TOKEN)) {
    console.log(`\n4x. How is ${TOKEN} bought?  (--token, last ${SPAN} blocks)`);
    const XFER = ethers.id('Transfer(address,address,uint256)');
    let tlogs = [];
    try {
      tlogs = await prov.getLogs({ address: TOKEN, topics: [XFER], fromBlock: Math.max(0, head - SPAN), toBlock: head });
    } catch (_) {
      // A range-capped node: walk the tail in steps — ON A REQUEST BUDGET. The
      // step is sized off the window so a wide --blocks does not turn into
      // hundreds of round trips; a probe that hangs is worse than one that says
      // it could not answer, which is what the unfiltered first cut of 4t was.
      const STEP = Math.max(200, Math.ceil(SPAN / 40));
      let spent = 0;
      for (let to = head; to > head - SPAN && tlogs.length < 40 && spent < 40; to -= STEP) {
        spent++;
        try { tlogs.push(...await prov.getLogs({ address: TOKEN, topics: [XFER], fromBlock: Math.max(0, to - STEP + 1), toBlock: to })); }
        catch (_) { /* one bad range must not abandon the walk */ }
      }
    }
    if (!tlogs.length) {
      warn('no transfers of this token in the window', `nobody has traded it in ${SPAN} blocks — rerun with --blocks ${SPAN * 10}`);
    } else {
      ok(`${tlogs.length} transfer(s)`, 'reading the calls behind the newest few');
      const seen = new Map();   // `${to}|${selector}` → { n, hash, value, args }
      const newest = tlogs.slice(-12).reverse();
      for (const lg of newest) {
        if (seen.size >= 6) break;
        let txo = null;
        try { txo = await prov.getTransaction(lg.transactionHash); } catch (_) { continue; }
        if (!txo || !txo.to || !txo.data || txo.data.length < 10) continue;
        const k = `${String(txo.to).toLowerCase()}|${txo.data.slice(0, 10)}`;
        if (seen.has(k)) { seen.get(k).n++; continue; }
        const body = txo.data.slice(10);
        const args = [];
        for (let i = 0; i < Math.min(8, body.length / 64); i++) args.push(body.slice(i * 64, i * 64 + 64));
        seen.set(k, { n: 1, hash: lg.transactionHash, value: txo.value || 0n, args });
      }
      if (!seen.size) { warn('no decodable calls behind those transfers', 'they may all be plain wallet-to-wallet sends'); }
      // The one that MOVES VALUE is the buy: a sell or a plain transfer carries
      // no ETH. Ranked so the operator does not have to work out which row is
      // the one that matters.
      const rows = [...seen.entries()].sort((a, b) => (b[1].value > a[1].value ? 1 : b[1].value < a[1].value ? -1 : b[1].n - a[1].n));
      for (const [k, v] of rows) {
        const [to, sel] = k.split('|');
        const paid = v.value > 0n;
        console.log('');
        note(`${paid ? '💰 ' : '   '}to ${to}`);
        note(`      selector ${sel}   value ${ethers.formatEther(v.value)} ${chain.native}   ×${v.n}`);
        note(`      tx ${v.hash}`);
        for (let i = 0; i < v.args.length; i++) {
          const w = v.args[i];
          const isAddr = /^0{24}[0-9a-f]{40}$/i.test(w) && !/^0+$/.test(w.slice(24));
          if (isAddr) {
            const a = ethers.getAddress('0x' + w.slice(24));
            note(`      arg[${i}] = ${a}${a.toLowerCase() === TOKEN.toLowerCase() ? '   ← the token' : ''}`);
          } else {
            let n = ''; try { n = BigInt('0x' + w).toString(); } catch (_) {}
            note(`      arg[${i}] = ${n.length > 30 ? '0x' + w : n}`);
          }
        }
      }
      const buy = rows.find(([, v]) => v.value > 0n);
      console.log('');
      if (buy) {
        note(`→ THE BUY: contract ${buy[0].split('|')[0]}, selector ${buy[0].split('|')[1]}.`);
        note('  That pair is the launchpad curve route. Send these lines back and the buy');
        note('  path can be built from a real trade instead of a guessed ABI.');
      } else {
        note('→ None of these calls carried value, so none of them is a BUY.');
        note('  Make one small buy on the pad\'s website, then rerun this same command.');
      }
    }
  }

  // ── 4t. WHO launched THIS token?  (--token) ───────────────────────────────
  /*
   * The probe that settles a launchpad integration: 4p can only report what the
   * CONFIGURED factory emitted, so a factory that is live-but-WRONG reports
   * "0 events" — identical to a quiet pad. This asks the opposite question:
   * here is a token that was definitely launched, WHICH contract announced it?
   *
   * ⚠️ FILTERED BY TOPIC, never an unfiltered walk. The first cut asked for
   * every log in 200-block steps and matched the token by substring; over a
   * 50,000-block window that is 250 requests each pulling the whole chain's
   * logs, and it did not finish — the operator watched a probe hang. An indexed
   * argument IS a topic, so three filters (topic1/2/3) cover every ABI that
   * indexes the token, in three requests over the whole range. A launchpad that
   * packs the token into the DATA is out of reach here and is covered by 4x
   * above, which reads the token's own Transfer logs — address-filtered, and
   * cheaper still.
   */
  if (TOKEN && /^0x[a-fA-F0-9]{40}$/.test(TOKEN)) {
    console.log(`\n4t. Who announced ${TOKEN}?  (--token, last ${SPAN} blocks)`);
    const asTopic = ethers.zeroPadValue(ethers.getAddress(TOKEN), 32);
    const tFrom = Math.max(0, head - SPAN);
    const hits = new Map();   // `${address}|${topic0}` → { n, blocks:[] }
    let asked = 0, refused = 0;
    for (const topics of [[null, asTopic], [null, null, asTopic], [null, null, null, asTopic]]) {
      asked++;
      try {
        for (const lg of await prov.getLogs({ topics, fromBlock: tFrom, toBlock: head })) {
          const k = `${String(lg.address).toLowerCase()}|${(lg.topics && lg.topics[0]) || '(none)'}`;
          const cur = hits.get(k) || { n: 0, blocks: [] };
          cur.n++; if (cur.blocks.length < 3) cur.blocks.push(lg.blockNumber);
          hits.set(k, cur);
        }
      } catch (_) { refused++; }
    }
    if (refused === asked) {
      warn('the node refused a topic-filtered range that wide', `rerun with --blocks ${Math.max(500, Math.floor(SPAN / 10))}`);
    } else if (!hits.size) {
      warn(`no log in ${SPAN} blocks names this token as an indexed argument`,
        'it launched longer ago than the window, or its launchpad packs the token into the DATA — 4x above reads the trade itself');
    } else {
      ok(`${hits.size} contract/event pair(s) name it`, `over ${SPAN} blocks`);
      const rows = [...hits.entries()].sort((a, b) => Math.min(...a[1].blocks) - Math.min(...b[1].blocks));
      for (const [k, v] of rows.slice(0, 10)) {
        const [addr, topic] = k.split('|');
        const cfg = addr === String(chain.factory).toLowerCase() ? '   ← the configured pools.trade factory'
          : (_ponsCfgSafe().factories || []).some((f) => f.toLowerCase() === addr) ? '   ← a configured PONS_FACTORY' : '';
        note(`${addr}${cfg}`);
        note(`   topic0 ${topic}  ×${v.n}  (block ${v.blocks.join(', ')})`);
      }
      // The EARLIEST mention is the creation, and its emitter is the launchpad.
      const [eAddr, eTopic] = rows[0][0].split('|');
      note('');
      note(`→ Earliest mention: ${eAddr} (topic0 ${eTopic}).`);
      note('  If that is not a PONS_FACTORY above, it is the launchpad this bot should watch.');
      note('  Both lines are complete — paste them into tradebot/.env and restart with --update-env:');
      note(`     PONS_FACTORY=${eAddr}`);
      note(`     PONS_EVENT=${eTopic}`);
      // ⚠️ It used to say "PONS_EVENT must be the signature whose keccak
      // matches that topic0" — which is a research task, not an instruction.
      // 1050 candidate `name(argtypes)` spellings were hashed against the topic
      // this very probe found, and none matched; an operator has no better
      // chance. So PONS_EVENT takes the TOPIC ITSELF, and the scan resolves the
      // token by measurement instead of by an ABI nobody has.
      note('  (a bare topic0 is enough — the scan then resolves the token from the launch transaction itself)');
    }
  }

  // ── 4b. find the launchpad without needing a tx hash ──────────────────────
  // `--tx` settles it, but it asks the operator to go and find a launch
  // transaction by hand first. This asks the chain instead: scan recent blocks
  // for EVERY log, tally by (address, event), and print the busiest. On a chain
  // this size the launchpad is near the top, so the address the bot SHOULD be
  // watching usually falls out of the list.
  if (DISCOVER) {
    console.log(`\n4b. Who is actually emitting events  (--discover, last ${SPAN} blocks)`);
    const tally = new Map();   // `${address}|${topic0}` → count
    let scanned = 0, refused = 0;
    const STEP = 200;          // small window: an unfiltered getLogs is what most RPCs cap
    try {
      const head = await prov.getBlockNumber();
      for (let to = head; to > head - SPAN; to -= STEP) {
        const from = Math.max(head - SPAN + 1, to - STEP + 1);
        try {
          for (const lg of await prov.getLogs({ fromBlock: from, toBlock: to })) {
            const k = `${(lg.address || '').toLowerCase()}|${(lg.topics && lg.topics[0]) || ''}`;
            const cur = tally.get(k);
            // Keep the FIRST hash seen for a pair. The scan walks from the head
            // downwards, so first-seen is the most RECENT — which is the one
            // worth handing to --tx: a launch from an hour ago decodes the same
            // as one from last week and is likelier to still be reachable on a
            // pruning node. One 66-char string per distinct (address, event)
            // pair, which is tens of entries, not thousands.
            if (cur) cur.n++;
            else tally.set(k, { n: 1, tx: lg.transactionHash || '' });
          }
          scanned += to - from + 1;
        } catch (_) { refused++; }   // rate limit / range cap — keep going, report at the end
      }
    } catch (e) { bad('could not read the head block', (e && e.message) || String(e)); }

    if (refused) note(`${refused} block range(s) refused by the RPC — the counts below are a sample, not a census`);
    if (!tally.size) {
      bad('no logs at all in that window', `${scanned} block(s) scanned`);
      note('Either the chain is idle, or this RPC will not serve unfiltered getLogs.');
    } else {
      const rows = [...tally.entries()].map(([k, v]) => { const [addr, t0] = k.split('|'); return { addr, t0, n: v.n, tx: v.tx }; })
        .sort((a, b) => b.n - a.n).slice(0, 10);
      const cfg = String(chain.factory || '').toLowerCase();

      // A topic0 is a keccak hash: unreadable, and not reversible. But a
      // VERIFIED contract publishes its ABI, so the explorer can name the event
      // for us. Without this the operator is handed ten rows of hex and asked
      // to recognise a launchpad in it — which is the manual step this mode
      // exists to remove. Best-effort throughout: an unverified contract, a
      // rate limit or an explorer that speaks a different API just leaves the
      // hash unnamed.
      // Explorers do not agree on how to serve an ABI. Blockscout's newer REST
      // API answers /api/v2/smart-contracts/{addr} with { abi: [...] }; the
      // older Etherscan-compatible one answers /api?module=contract&action=
      // getabi with the ABI as a JSON *string* in `result`. Try both, and keep
      // WHY each attempt failed — the first cut swallowed everything and
      // printed one line that blamed the contracts for not being verified,
      // which is only one of three possible causes and not the likeliest. This
      // repo has TWO different explorer hosts configured for this same chain
      // (tradebot/chains.js vs bot/src/config/chains.js), so "wrong host" was
      // always on the table and the output could not say it.
      const names = new Map();   // topic0 → "EventName"
      const why = [];            // one line per address we could not name
      const base = String(EXPLORER || chain.explorer || '').replace(/\/+$/, '');
      const abiOf = async (addr) => {
        const tries = [
          { url: `${base}/api/v2/smart-contracts/${addr}`, pick: (j) => (Array.isArray(j && j.abi) ? j.abi : null),
            unverified: (j) => j && j.is_verified === false },
          { url: `${base}/api?module=contract&action=getabi&address=${addr}`,
            pick: (j) => (j && j.status === '1' && typeof j.result === 'string' ? JSON.parse(j.result) : null),
            unverified: (j) => j && j.status === '0' && /not verified/i.test(String(j.result || '')) },
        ];
        let last = 'no explorer configured';
        if (!base) return { abi: null, why: last };
        for (const t of tries) {
          try {
            const res = await fetch(t.url, { signal: AbortSignal.timeout(8000) });
            if (!res.ok) { last = `HTTP ${res.status}`; continue; }
            const body = await res.text();
            let j = null;
            try { j = JSON.parse(body); } catch (_) { last = `not JSON (${body.slice(0, 40).replace(/\s+/g, ' ')}…)`; continue; }
            if (t.unverified(j)) return { abi: null, why: 'not verified on this explorer' };
            const abi = t.pick(j);
            if (abi) return { abi, why: '' };
            last = 'answered, but no ABI in the response';
          } catch (e) { last = (e && e.name === 'TimeoutError') ? 'timed out' : ((e && e.message) || String(e)).slice(0, 60); }
        }
        return { abi: null, why: last };
      };
      for (const addr of [...new Set(rows.map((r) => r.addr))]) {
        const { abi, why: w } = await abiOf(addr);
        if (!abi) { why.push(`${addr.slice(0, 10)}… ${w}`); continue; }
        try { new ethers.Interface(abi).forEachEvent((ev) => names.set(ev.topicHash.toLowerCase(), ev.name)); }
        catch (e) { why.push(`${addr.slice(0, 10)}… ABI did not parse`); }
      }

      console.log('');
      for (const r of rows) {
        const mine = r.addr === cfg ? '  ← the factory the bot watches' : '';
        const nm = names.get(r.t0.toLowerCase());
        console.log(`     ${String(r.n).padStart(5)}×  ${r.addr}  ${nm ? nm.padEnd(20) : r.t0.slice(0, 18) + '…'}${mine}`);
        // The whole point of printing this: --tx needs a transaction and the
        // instruction used to be "go to pools.trade and find one". Every log
        // already carries the hash of the transaction that emitted it, so the
        // next command is right here, ready to paste.
        if (r.tx) console.log(`            --tx ${r.tx}`);
      }
      if (!names.size && why.length) {
        note(`no event names from ${base || '(no explorer set)'} —`);
        for (const w of why.slice(0, 4)) note(`  ${w}`);
        note('If that reads like a wrong host rather than unverified contracts, try');
        note('  --explorer https://robinhoodchain.blockscout.com   (the other host this repo configures)');
        note('Either way the --tx lines below settle it without any explorer.');
      }
      console.log('');
      if (!rows.some((r) => r.addr === cfg)) {
        note(`FACTORY_ADDR (${chain.factory}) emitted nothing in this window.`);
        note('If a launchpad is in that list, that address is what FACTORY_ADDR should be —');
        note('confirm with --tx on one of its transactions before changing anything.');
      }
    }
  } else {
    console.log('\n4b. Who is actually emitting events');
    note('Re-run with --discover to scan recent blocks and see which contracts are live.');
  }

  // ── 5. the decisive check ─────────────────────────────────────────────────
  // Everything above can only say "the thing we look for is not there". Only a real
  // launch transaction can say what IS there.
  console.log('\n5. What a real launch actually emits  (--tx)');
  if (!TX) {
    note('Pass --tx followed by a transaction hash to settle this. TWO kinds are useful:');
    note('  • a LAUNCH tx  → names the factory + event the snipe must watch');
    note('  • a BUY tx of yours, made on the pad\'s own website → names the contract');
    note('    and the 4-byte selector a buy goes through, which is what a curve route');
    note('    has to be built from. Open your own buy on the explorer and copy its hash.');
  } else if (!/^0x[a-fA-F0-9]{64}$/.test(TX)) {
    bad('--tx is not a transaction hash', TX);
  } else {
    try {
      const rc = await prov.getTransactionReceipt(TX);
      if (!rc) { bad('transaction not found', TX); }
      else {
        ok('receipt', `block ${rc.blockNumber}, ${rc.logs.length} log(s)`);
        // THE CALL ITSELF, not only its logs. For a LAUNCH the logs answer the
        // question; for a BUY they do not — what the bot needs in order to
        // route through a launchpad's curve is the contract that was called and
        // the 4-byte selector it was called with, and both are sitting in the
        // transaction the operator already made by hand on the pad's website.
        // A launchpad integration that cannot be read out of a real trade is a
        // launchpad integration built on guesses.
        try {
          const txo = await prov.getTransaction(TX);
          if (txo) {
            const sel = (txo.data || '0x').slice(0, 10);
            const words = Math.max(0, ((txo.data || '0x').length - 10) / 64);
            console.log('');
            note(`the CALL: to ${txo.to}`);
            note(`   value    ${ethers.formatEther(txo.value || 0n)} ${chain.native}`);
            note(`   selector ${sel}   (${words} argument word(s))`);
            // Every 32-byte word that looks like an address, named — the token,
            // the recipient and the curve all arrive this way, and seeing them
            // is what turns a selector into a signature.
            const body = (txo.data || '0x').slice(10);
            for (let i = 0; i < words && i < 8; i++) {
              const w = body.slice(i * 64, i * 64 + 64);
              const asAddr = '0x' + w.slice(24);
              const looksAddr = /^0{24}[0-9a-f]{40}$/i.test(w) && !/^0+$/.test(w.slice(24));
              let v = '';
              try { v = BigInt('0x' + w).toString(); } catch (_) { v = ''; }
              note(`   arg[${i}]   0x${w}`);
              if (looksAddr) note(`             = address ${ethers.getAddress(asAddr)}${asAddr.toLowerCase() === String(TOKEN || '').toLowerCase() ? '   ← the token' : ''}`);
              else if (v && v.length < 30) note(`             = ${v}`);
            }
            note('');
            note('→ THIS is what a Pons buy looks like. Send the `to`, the selector and the');
            note('  argument list back, and the curve route can be built from a real trade');
            note('  rather than from a guessed ABI.');
          }
        } catch (_) { /* the logs above are the primary answer; this is a bonus */ }
        console.log('');
        const byAddr = new Map();
        for (const l of rc.logs) {
          const a = String(l.address).toLowerCase();
          if (!byAddr.has(a)) byAddr.set(a, []);
          byAddr.get(a).push(l);
        }
        for (const [addr, logs] of byAddr) {
          const isCfg = addr === String(chain.factory).toLowerCase();
          console.log(`     ${addr}${isCfg ? '   ← chains.js factory' : ''}`);
          for (const l of logs) {
            const t0 = (l.topics && l.topics[0]) || '(anonymous)';
            const match = t0 === TOPIC0;
            console.log(`       topic0 ${t0}${match ? '   ✅ MATCHES the bot' : ''}`);
            console.log(`              ${l.topics.length - 1} indexed arg(s), ${(l.data.length - 2) / 2} bytes of data`);
          }
        }
        console.log('');
        const anyMatch = rc.logs.some((l) => l.topics && l.topics[0] === TOPIC0);
        const fromCfg = rc.logs.some((l) => String(l.address).toLowerCase() === String(chain.factory).toLowerCase());
        if (anyMatch && fromCfg) {
          ok('VERDICT: this launch is fully compatible', 'the bot can snipe it as configured');
        } else if (anyMatch && !fromCfg) {
          const emitter = rc.logs.find((l) => l.topics && l.topics[0] === TOPIC0).address;
          warn('VERDICT: right event, WRONG ADDRESS', 'config-only fix');
          note(`→ Set FACTORY_ADDR=${emitter} in tradebot/.env and restart.`);
        } else {
          bad('VERDICT: this launch emits nothing the bot understands', 'code change required');
          note('→ No environment variable fixes this. The launchpad interface (core.js');
          note('  FACTORY_ABI / CURVE_ABI) is hard-wired to a different launchpad, and must');
          note('  learn this event signature before a snipe can ever fire.');
          note('  Give the topic0 above, plus the launch contract\'s verified ABI, to whoever');
          note('  implements it — those two facts are the whole blocker.');
        }
      }
    } catch (e) { bad('receipt lookup failed', (e && e.message) || String(e)); }
  }

  // ── 6. DEX side, for graduated tokens ─────────────────────────────────────
  console.log('\n6. DEX routing (graduated tokens)');
  try {
    const r = new ethers.Contract(chain.router, ['function factory() view returns (address)'], prov);
    const f = await r.factory();
    if (!f || f === ethers.ZeroAddress) bad('router.factory()', 'returned the zero address');
    else {
      ok('router.factory()', f);
      if (TOKEN && /^0x[a-fA-F0-9]{40}$/.test(TOKEN)) {
        try {
          const fc = new ethers.Contract(f, ['function getPair(address,address) view returns (address)'], prov);
          const pair = await fc.getPair(TOKEN, chain.weth);
          if (!pair || pair === ethers.ZeroAddress) warn('getPair', 'no V2 pair for this token/WETH — it is pre-graduation, or it lives in a V3 pool');
          else ok('getPair', pair);
        } catch (e) { warn('getPair failed', (e && e.shortMessage) || (e && e.message) || e); }
      }
    }
  } catch (e) {
    bad('router does not expose factory()', `${chain.router} is not a V2-style router here`);
    note(`  ${(e && e.shortMessage) || (e && e.message) || e}`);
  }
  if (!(chain.v3 && chain.v3.factory && chain.v3.router)) {
    note('V3 routing is OFF (ROBINHOOD_V3_FACTORY / ROBINHOOD_V3_ROUTER unset).');
    note('Pons V1 launches straight into a Uniswap V3 pool, so those tokens are');
    note('untradeable until these are set — scripts/v3-discover.js <poolAddress> robinhood.');
  } else {
    // The addresses now ship as defaults, taken from Uniswap's own deployment
    // record for chainId 4663. That makes them a citation rather than a guess —
    // and this round has already been taught, twice, that a citation is not a
    // measurement. So the preflight VERIFIES them here rather than assuming, and
    // says which it is looking at: an operator's own value or the shipped one.
    const src = (k) => ((process.env[k] || '').trim() ? 'from .env' : 'shipped default');
    for (const [name, addr, key] of [
      ['V3 factory', chain.v3.factory, 'ROBINHOOD_V3_FACTORY'],
      ['V3 router', chain.v3.router, 'ROBINHOOD_V3_ROUTER'],
    ]) {
      try {
        const code = await prov.getCode(addr);
        if (!code || code === '0x') {
          bad(`${name} has NO CODE`, `${addr} (${src(key)})`);
          note(`  Nothing routes through V3 here. Set ${key}= in tradebot/.env after running`);
          note('  scripts/v3-discover.js <a real V3 pool address> robinhood.');
        } else ok(`${name} (${src(key)})`, addr);
      } catch (e) {
        warn(`${name} could not be read`, `${addr} — ${(e && e.shortMessage) || (e && e.message) || e}`);
      }
    }
  }

  // ── summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(72));
  if (failures) {
    console.log(`  ${failures} check(s) FAILED, ${warnings} warning(s).`);
    console.log('  The launchpad path is not working as configured. Read the → notes above.');
  } else if (warnings) {
    console.log(`  All checks passed with ${warnings} warning(s).`);
  } else {
    console.log('  All checks passed.');
  }
  console.log('═'.repeat(72) + '\n');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('\npreflight crashed:', (e && e.stack) || e); process.exit(1); });
