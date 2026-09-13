'use strict';
/*
 * Rich token "scan" — aggregates everything a Maestro-style card shows, from
 * several sources, all best-effort (a slow/missing source degrades gracefully):
 *
 *   • on-chain snapshot (core.tokenSnapshot): price, mcap, curve/graduation state
 *   • liquidity: DEX pool = WETH reserve × 2 (via router.factory→getPair→reserves);
 *                bonding curve = ETH raised so far / graduation target
 *   • launchpad API (Robinhood-chain tokens): 24h/total volume, socials, created-at
 *   • GoPlus (Ethereum/Base/BNB/Arbitrum): tax, honeypot, holders, LP lock, mint…
 *
 * Everything is wrapped so this NEVER throws to the caller and never blocks a trade.
 */
const { ethers } = require('ethers');
const core = require('./core');
const goplus = require('./goplus');
const safety = require('./safety');   // chain-aware token safety (GoPlus / RugCheck)
const poolstrade = require('./poolstrade');   // pools.trade launchpad (Robinhood Chain)
const launchpads = require('./launchpads');   // pre-migration pads (pump.fun, bonk.fun, four.meme, Virtuals…)

const SITE = (process.env.SITE || 'https://robinfun.io').replace(/\/+$/, '');
const ROUTER_FACTORY_ABI = ['function factory() view returns (address)'];
const FACTORY_V2_ABI = ['function getPair(address,address) view returns (address)'];
const PAIR_ABI = ['function getReserves() view returns (uint112 r0, uint112 r1, uint32 ts)', 'function token0() view returns (address)'];
const CURVE_PROGRESS_ABI = ['function graduationProgress() view returns (uint256 collected, uint256 target)'];

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

// DEX pool liquidity in native units (WETH reserve × 2). null if no pool / error.
async function dexLiquidityNative(ca, chainKey) {
  const chain = core.chainOf(chainKey); if (!chain || !chain.router || !chain.weth) return null;
  try {
    const prov = core.providerFor(chainKey);   // inside try: an unknown chain key would throw
    const factory = await new ethers.Contract(chain.router, ROUTER_FACTORY_ABI, prov).factory();
    if (!factory || factory === ethers.ZeroAddress) return null;
    const pair = await new ethers.Contract(factory, FACTORY_V2_ABI, prov).getPair(ca, chain.weth);
    if (!pair || pair === ethers.ZeroAddress) return null;
    const pc = new ethers.Contract(pair, PAIR_ABI, prov);
    const [r0, r1] = await pc.getReserves();
    const t0 = String(await pc.token0()).toLowerCase();
    const wethReserve = t0 === chain.weth.toLowerCase() ? r0 : r1;
    return Number(ethers.formatEther(wethReserve)) * 2;
  } catch (_) { return null; }
}

// Bonding-curve progress: ETH raised so far and the graduation target.
async function curveRaised(curveAddr, chainKey) {
  try {
    const [col, tgt] = await new ethers.Contract(curveAddr, CURVE_PROGRESS_ABI, core.providerFor(chainKey)).graduationProgress();
    return { raised: Number(ethers.formatEther(col)), target: Number(ethers.formatEther(tgt)) };
  } catch (_) { return null; }
}

// Market stats (24h volume, price change, buy/sell txns, pool age) from public
// indexers: DexScreener for the big EVM chains, GeckoTerminal for Robinhood
// Chain (DexScreener doesn't index it). Best-effort: null on any failure.
const DS_CHAIN = { ethereum: 'ethereum', base: 'base', bsc: 'bsc', arbitrum: 'arbitrum' };
const GT_NETWORK = { robinhood: 'robinhood' };
async function marketStats(ca, chainKey) {
  try {
    if (DS_CHAIN[chainKey]) {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } });
      if (!r.ok) return null;
      const j = await r.json();
      const pairs = (j.pairs || []).filter((p) => p.chainId === DS_CHAIN[chainKey]);
      if (!pairs.length) return null;
      const p = pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
      return {
        volH24Usd: p.volume && p.volume.h24 != null ? Number(p.volume.h24) : null,
        chgH1: p.priceChange && p.priceChange.h1 != null ? Number(p.priceChange.h1) : null,
        chgH24: p.priceChange && p.priceChange.h24 != null ? Number(p.priceChange.h24) : null,
        buysH24: p.txns && p.txns.h24 ? p.txns.h24.buys : null,
        sellsH24: p.txns && p.txns.h24 ? p.txns.h24.sells : null,
        liqUsd: p.liquidity && p.liquidity.usd != null ? Number(p.liquidity.usd) : null,   // market-wide (any pool type)
        createdAt: p.pairCreatedAt || null,
      };
    }
    const net = GT_NETWORK[chainKey]; if (!net) return null;
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/tokens/${ca}/pools?page=1`, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    const a = j.data && j.data[0] && j.data[0].attributes;
    if (!a) return null;
    return {
      volH24Usd: a.volume_usd && a.volume_usd.h24 != null ? Number(a.volume_usd.h24) : null,
      chgH1: a.price_change_percentage && a.price_change_percentage.h1 != null ? Number(a.price_change_percentage.h1) : null,
      chgH24: a.price_change_percentage && a.price_change_percentage.h24 != null ? Number(a.price_change_percentage.h24) : null,
      buysH24: a.transactions && a.transactions.h24 ? a.transactions.h24.buys : null,
      sellsH24: a.transactions && a.transactions.h24 ? a.transactions.h24.sells : null,
      liqUsd: a.reserve_in_usd != null ? Number(a.reserve_in_usd) : null,   // market-wide (any pool type)
      createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
    };
  } catch (_) { return null; }
}

// Live gas price, and what one swap costs at it. "What will this trade cost me"
// is the question the card could not answer at all, and on a cheap L2 the answer
// ("about four cents") is often what decides whether a small buy is worth making.
// The PRICE is read from the chain; the units are a representative swap, so the
// cost is shown with a ≈ and never presented as a quote.
const SWAP_GAS_UNITS = 300000n;
async function gasSnapshot(chainKey) {
  try {
    if (core.chains.isSvm(chainKey)) return null;   // Solana fees are flat, tiny, and not gwei
    const fd = await core.providerFor(chainKey).getFeeData();
    const price = fd.gasPrice || fd.maxFeePerGas;
    if (!price || price <= 0n) return null;
    return { gwei: Number(ethers.formatUnits(price, 'gwei')), feeNative: Number(ethers.formatEther(price * SWAP_GAS_UNITS)) };
  } catch (_) { return null; }
}

// Launchpad public API token record (curve-chain launches only).
//
// TWO LAUNCHPADS, IN ORDER. pools.trade is where Robinhood Chain tokens launch,
// so it is asked first for its own chain. The legacy SITE launchpad
// (robinfun.io by default, the one this bot was built against) stays as the
// fallback: a token that predates pools.trade, or one from a deployment whose
// SITE points somewhere else, still resolves. Either source returning nothing
// is a normal outcome — the caller treats a null as "no extra metadata".
//
// Nothing read here is allowed to influence a trade; see poolstrade.js's header.
async function launchpadApi(ca, chainKey) {
  const rec = await poolstrade.tokenRecord(ca, chainKey).catch(() => null);
  if (rec) return rec;
  try {
    const r = await fetch(`${SITE}/api/v1/tokens/${ca}`, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.address) ? j : null;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------- socials
// A token's own links — website, X, Telegram — from whichever source knows the
// token: the launchpad record on curve chains, DexScreener everywhere else.
//
// CACHED, and that is the point. The live monitor re-renders on a timer, so an
// uncached 6-second HTTP call here would be paid on every single refresh of
// every open card. Links do not change; a hit is held far longer than a miss,
// because a brand-new token usually has no socials indexed for the first few
// minutes and is worth asking about again.
const DS_SOCIAL_CHAIN = { robinhood: 'robinhood', ethereum: 'ethereum', base: 'base', bsc: 'bsc', arbitrum: 'arbitrum', solana: 'solana' };
const _socialCache = new Map();   // 'chain:ca' → { v, at }
const SOCIAL_TTL_HIT = 30 * 60 * 1000;
const SOCIAL_TTL_MISS = 5 * 60 * 1000;
const SOCIAL_CACHE_MAX = 2000;

// http(s) only. These strings are set by whoever deployed the token, and they
// end up inside an href on a card the user is invited to tap. A javascript: or
// data: URL has no business there, and a malformed one makes Telegram reject the
// whole message — which would take the live monitor down over a field a stranger
// controls. Anything that is not a plain web link is dropped, quietly.
function _safeUrl(u) {
  const s = String(u || '').trim();
  if (s.length > 300) return '';
  try { const p = new URL(s); return (p.protocol === 'http:' || p.protocol === 'https:') ? s : ''; }
  catch (_) { return ''; }
}

function _pickSocials(o) {
  if (!o) return null;
  const out = {};
  for (const w of (o.websites || [])) { const u = _safeUrl(w && w.url); if (u && !out.website) out.website = u; }
  for (const s of (o.socials || [])) {
    const t = String((s && s.type) || '').toLowerCase();
    const u = _safeUrl(s && s.url); if (!u) continue;
    if ((t === 'twitter' || t === 'x') && !out.twitter) out.twitter = u;
    else if (t === 'telegram' && !out.telegram) out.telegram = u;
  }
  return (out.website || out.twitter || out.telegram) ? out : null;
}

async function socials(ca, chainKey) {
  const key = chainKey + ':' + (core.chains.isSvm(chainKey) ? String(ca) : String(ca).toLowerCase());
  const hit = _socialCache.get(key);
  if (hit && Date.now() - hit.at < (hit.v ? SOCIAL_TTL_HIT : SOCIAL_TTL_MISS)) return hit.v;
  let v = null;
  try {
    const chain = core.chainOf(chainKey);
    if (chain && chain.curve) {
      const a = await launchpadApi(ca, chainKey);
      const l = (a && a.links) || {};
      const w = _safeUrl(l.website), t = _safeUrl(l.twitter), g = _safeUrl(l.telegram);
      if (w || t || g) v = { website: w, twitter: t, telegram: g };
    }
    // Not an `else`: a curve-chain token that was NOT launched through the
    // launchpad has no record there, and DexScreener indexes the chain. Falling
    // through means such a token gets its links instead of nothing.
    if (!v && DS_SOCIAL_CHAIN[chainKey]) {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } });
      if (r.ok) {
        const j = await r.json();
        const pairs = (j.pairs || []).filter((p) => p.chainId === DS_SOCIAL_CHAIN[chainKey]);
        for (const p of pairs) { v = _pickSocials(p.info); if (v) break; }
      }
    }
    // The pre-migration pads, LAST. A token still on a bonding curve has no
    // pool for DexScreener to hang an `info` block on, so the socials the
    // project set at mint were unreachable for exactly as long as they were the
    // only ones that existed.
    //
    // Last rather than first, deliberately: this runs behind the live monitor's
    // render, and asking every pad on a chain before the one index that usually
    // has the answer would add a round trip to the common case to serve the
    // rare one. When DexScreener knows the token, the pads are never asked.
    if (!v && launchpads.covers(chainKey)) {
      v = launchpads.socialsOf(await launchpads.record(chainKey, ca).catch(() => null));
    }
  } catch (_) { v = null; }   // a lookup that failed is a miss, not an error the card should show
  if (_socialCache.size >= SOCIAL_CACHE_MAX) _socialCache.delete(_socialCache.keys().next().value);
  _socialCache.set(key, { v, at: Date.now() });
  return v;
}

// Aggregate a rich scan. Returns null only if the token can't be priced at all.
async function enrich(ca, chainKey) {
  const chain = core.chainOf(chainKey); if (!chain) return null;
  /*
   * ⚠️ THE TWO LEGS THAT DO NOT NEED THE SNAPSHOT START WITH IT, not after it.
   *
   * `gasSnapshot` reads the chain's fee data and `marketStats` asks the
   * indexers; neither looks at anything `tokenSnapshot` produces. They were in
   * the task list BELOW, so their latency was added to a snapshot that can
   * itself take seconds — on a bonding-curve token the snapshot reads the
   * curve's interface, which is the slowest thing this bot does.
   *
   * `.catch` at CREATION: the `!snap` return below abandons both, and an
   * unhandled rejection must never come out of an enrichment.
   */
  const gasP = gasSnapshot(chainKey).catch(() => null);
  const mktP = marketStats(ca, chainKey).catch(() => null);
  // The launchpad's own record does not read the snapshot either, and on a
  // curve chain it was the LAST wave of the card — two round trips tacked onto
  // the end of a scan that had already finished everything it needed.
  const padP = chain.curve ? launchpadApi(ca, chainKey).catch(() => null) : null;
  const snap = await core.tokenSnapshot(ca, chainKey).catch(() => null);
  if (!snap) return null;
  const info = { ...snap, chainKey, native: chain.native };
  // Solana: the DexScreener snapshot already carries liquidity + volume + identity, so
  // there's no router/curve/GoPlus leg — shape those fields into what the card reads.
  // (Token safety on Solana would come from a RugCheck integration; not wired yet.)
  if (core.chains.isSvm(chainKey)) {
    info.liquidityNative = (snap.liquiditySol != null) ? snap.liquiditySol : null;
    // The launchpad leg, which Solana never had. Everything a curve token's
    // card was missing lives here and nowhere else: the project's socials, its
    // launch time, its holder count, the pad it came from. The lookup is the
    // same one tokenSnapshot just made and the registry caches it, so this is
    // ordinarily a cache hit rather than a second round trip.
    // BOTH LEGS AT ONCE. These were awaited one after the other — the launchpad
    // record, then RugCheck with its own nine-second ceiling — so a Solana card
    // paid the SUM of two independent waits before it could render. They know
    // nothing about each other; the only reason they were serial is the order
    // they were written in.
    const [rec, sec] = await Promise.all([
      // The snapshot already fetched this and carries it — see core.tokenSnapshot.
      // Only asked again when it did not (an older snapshot shape, or a path
      // that skipped the pads).
      snap.lp !== undefined ? Promise.resolve(snap.lp)
        : launchpads.covers(chainKey) ? launchpads.record(chainKey, ca).catch(() => null) : Promise.resolve(null),
      withTimeout(safety.tokenSecurity(chainKey, ca).catch(() => null), Math.max(3000, Number(process.env.SCAN_TIMEOUT_MS || 9000))),
    ]);
    const api = launchpads.toApi(rec) || {};
    // THE SNAPSHOT WINS ON THE NUMBERS, the launchpad fills what it cannot
    // know. Market cap and volume out of an indexed pool are live and
    // pool-derived; a launchpad's copy of them can lag by minutes. For a token
    // with no pool the snapshot's numbers came from this same record anyway, so
    // preferring it costs nothing there.
    info.api = {
      ...api,
      name: snap.name || api.name || null,
      symbol: snap.sym || api.symbol || null,
      marketCapUsd: snap.mcapUsd || api.marketCapUsd || null,
      volume: {
        h24Usd: snap.volH24Usd != null ? snap.volH24Usd : ((api.volume && api.volume.h24Usd) != null ? api.volume.h24Usd : null),
        totalUsd: (api.volume && api.volume.totalUsd) || null,
      },
    };
    // "🚀 Raised 30 / 85 SOL · 35% to graduation" — the curve row the card has
    // always been able to render and has never had the numbers for on Solana.
    if (snap.raised != null) { info.raised = snap.raised; info.target = snap.target; }
    // RugCheck safety (best-effort, bounded) — mint/freeze authority, LP lock,
    // holders. Resolved above, alongside the launchpad rather than after it.
    info.security = sec;
    return info;
  }
  const tasks = [];
  const onCurve = !!(chain.curve && snap.curve && !snap.graduated);
  if (onCurve) tasks.push(curveRaised(snap.curve, chainKey).then((v) => { if (v) { info.raised = v.raised; info.target = v.target; } }));
  // Liquidity of the venue a trade would ACTUALLY use (V2 pair or deepest V3
  // pool — whichever the engine picks), not just the V2 pair.
  else tasks.push(core.bestDexVenue(ca, chainKey).then((p) => {
    info.dexVenue = p && p.kind;
    info.liquidityNative = p && p.wethBal != null ? Number(ethers.formatEther(p.wethBal)) * 2 : null;
  }).catch(() => { info.liquidityNative = null; }));
  if (padP) tasks.push(padP.then((a) => { info.api = a; }));   // STARTED above
  // Both were STARTED above, alongside the snapshot — collected here.
  tasks.push(mktP.then((m) => { if (m) info.market = m; }));
  tasks.push(gasP.then((g) => { info.gas = g; }));
  if (goplus.supported(chainKey)) tasks.push(goplus.tokenSecurity(chainKey, ca).then((s) => { info.security = s; }).catch(() => {}));
  // Each task swallows its own errors, so Promise.all never rejects; the timeout
  // caps total latency and any unfinished task simply leaves its field undefined.
  await withTimeout(Promise.all(tasks), Math.max(3000, Number(process.env.SCAN_TIMEOUT_MS || 9000)));
  return info;
}

module.exports = { enrich, dexLiquidityNative, curveRaised, launchpadApi, marketStats, gasSnapshot, socials, _test: { _pickSocials, _safeUrl } };
