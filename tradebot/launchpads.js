'use strict';
/*
 * launchpads.js — the trade bot's view of a token that has not migrated yet.
 *
 * A thin shim over ../shared/launchpads. The registry, the hosts, the failover
 * and the parsing live there because bot/ needs exactly the same answers and
 * this repo has already paid for two processes disagreeing about which
 * pump.fun host was current. What lives HERE is only the reshaping into what
 * the trade bot's own callers already read:
 *
 *   apiRecord()     → the `info.api` shape tokeninfo/telegram render
 *   curveSnapshot() → the `tokenSnapshot` shape, for a token whose only market
 *                     is a bonding curve no indexer covers
 *
 * SAME WARNING AS poolstrade.js, AND IT MATTERS MORE HERE. Nothing this module
 * returns may price, route or authorise a swap. A buy is quoted by the
 * aggregator and signed against chain state; a launchpad that is wrong, stale
 * or hostile may only ever make a card show a stale market cap. In particular
 * `curveSnapshot` deliberately returns `routable: false` — see below.
 */
const lp = require('../shared/launchpads');
const { safeUrl } = require('../shared/launchpads/normalize');

/**
 * Chain keys this bot uses → the registry's.
 *
 * DERIVED FROM THE REGISTRY, never listed here. This was a hand-written map of
 * three chains (`solana`, `bsc`, `base`), and the moment a pad was added to the
 * table for a fourth it was dropped on the floor RIGHT HERE: `chainFor` answered
 * null, `covers()` said no, `record()` returned "chain not covered", and the new
 * pad's feed was never asked anything. Nothing threw and nothing logged — the
 * chain simply read as one no launchpad knows, which is indistinguishable from a
 * pad that is down and from a chain nobody launches on. Two lists of the same
 * fact, and the one further from the table is the one that goes stale.
 *
 * RENAMES is the only reason a map is needed at all, and it is deliberately
 * EMPTY: both sides agree on every key today. A future rename is one entry here
 * instead of a silent no-op.
 */
const RENAMES = {};   // our chain key → the registry's, wherever they ever differ
function chainFor(chainKey) {
  const k = RENAMES[chainKey] || chainKey;
  return (k && lp.padsFor(k).length > 0) ? k : null;
}

/** Does any enabled pad cover this chain? Callers skip the whole leg otherwise
 *  rather than paying a lookup that can only return null. */
function covers(chainKey) {
  return !!chainFor(chainKey);
}

/**
 * The merged launchpad record, or null. Never throws.
 * `opts.diag` returns the full `{ record, ok, why, tried }` instead — the check
 * script and the health screen need to tell "no pad knows it" from "no pad
 * answered", which a bare null cannot express.
 */
async function record(chainKey, ca, opts) {
  const c = chainFor(chainKey);
  if (!c) return (opts && opts.diag) ? { record: null, ok: true, why: 'chain not covered', tried: [] } : null;
  try {
    const r = await lp.tokenRecord(c, ca, opts);
    return (opts && opts.diag) ? r : r.record;
  } catch (_) {
    return (opts && opts.diag) ? { record: null, ok: false, why: 'launchpad lookup failed', tried: [] } : null;
  }
}

/**
 * A launchpad record in the `info.api` shape — the same shape poolstrade.js
 * returns, so telegram.js's card reads `api.name`, `api.marketCapUsd`,
 * `api.volume.h24Usd` and `api.links` without knowing which source filled them.
 */
function toApi(rec) {
  if (!rec) return null;
  return {
    address: rec.address,
    name: rec.name,
    symbol: rec.symbol,
    marketCapUsd: rec.mcapUsd,
    priceUsd: rec.priceUsd,
    volume: { h24Usd: rec.vol24Usd, totalUsd: null },
    createdAt: rec.createdAt,
    holders: rec.holders,
    // DISPLAY ONLY. core.js decides the real venue from the chain and from the
    // aggregator's quote, and must keep doing so.
    graduated: rec.graduated,
    progressPct: rec.progressPct,
    links: { website: rec.website, twitter: rec.twitter, telegram: rec.telegram },
    launchUrl: rec.launchUrl,
    launchpad: rec.launchpad,
    source: rec.source,
  };
}

const apiRecord = async (ca, chainKey) => toApi(await record(chainKey, ca));

/**
 * A `tokenSnapshot`-shaped object for a token whose ONLY market is a bonding
 * curve — the case where DexScreener and GeckoTerminal both come back empty and
 * the card used to say "❌ Couldn't price it" about a token that is trading
 * fine on its launchpad.
 *
 * `routable: false`, ALWAYS, and this is the important line in the file.
 * Knowing a price and being able to FILL a swap at it are different
 * capabilities — the exact distinction v4.js draws between `price()` and
 * `canSwapLive()`. This module read a number off an HTTP API; it has not
 * checked that the aggregator can route the token, and quoting a price the
 * engine cannot honour is the one failure mode worse than saying "not supported
 * yet". telegram.js renders these through `unroutableCard`, which shows the
 * market and explains itself instead of offering a Buy button that would fail
 * after the tap.
 *
 * The caller passes `nativeUsd` so this module never fetches a price of its own.
 * Returns null unless there is a real USD price to show.
 */
function curveSnapshot(ca, chainKey, rec, nativeUsd) {
  if (!rec || !(rec.priceUsd > 0)) return null;
  const usd = Number(nativeUsd) > 0 ? Number(nativeUsd) : 0;
  const pad = rec.launchpad || rec.padLabel || 'a launchpad';
  return {
    ca,
    curve: '',
    // NO `decimals` FIELD. A launchpad record does not carry the mint's
    // decimals, and inventing 9 here would be authoritative downstream:
    // monitorPayload prefers the snapshot's value over the one recorded at buy
    // time, so a guess of 9 on a 6-decimal mint renders a real bag a thousand
    // times too small and a fresh buy as −99.90%. Absent, the caller falls
    // through to a value that was actually read.
    priceUsd: rec.priceUsd,
    priceEth: usd > 0 ? rec.priceUsd / usd : 0,
    mcapUsd: rec.mcapUsd || 0,
    mcapEth: usd > 0 && rec.mcapUsd ? rec.mcapUsd / usd : 0,
    // NULL, not 0, when the pad did not report liquidity. `0` is a claim — the
    // card renders "💧 Liquidity 0.000 SOL", which reads as a rug — where null
    // means "not known here" and lets the card fall through to the line that
    // actually fits a bonding token: "🚀 Raised 30 / 85 SOL · 35% to graduation".
    liquidityUsd: rec.liqUsd || null,
    liquiditySol: usd > 0 && rec.liqUsd ? rec.liqUsd / usd : null,
    volH24Usd: rec.vol24Usd != null ? rec.vol24Usd : null,
    name: rec.name || '',
    sym: rec.symbol || '',
    // `dex: false` is what makes the card print "◈ Bonding curve · NN%" instead
    // of "◆ DEX". It was hardcoded true for every Solana token, which is how a
    // token at 12% of its curve came to be labelled as trading on a DEX.
    dex: false,
    graduated: rec.graduated === true,
    progressPct: rec.progressPct != null ? rec.progressPct : 0,
    progressSource: rec.progressSource || null,
    // "Raised X / Y SOL" — a fact the pad reported, where the percentage above
    // may be an estimate. tokeninfo.enrich copies these onto info.raised/target.
    raised: rec.raisedNative,
    target: rec.targetNative,
    launchpad: rec.launchpad || null,
    dexVenue: 'curve',
    extVenue: `the ${pad} bonding curve`,
    routable: false,
  };
}

/** Curve state to overlay on a snapshot that already has a price from an
 *  indexer. Returns only the fields worth overwriting, so a caller can spread
 *  it without clobbering the numbers it trusts more. */
function curveOverlay(rec) {
  if (!rec) return null;
  // A pad that knows the token but not its phase must not change the card. Two
  // pads that disagree are settled in the registry's merge, not here.
  if (rec.onCurve !== true) return null;
  return {
    dex: false,
    graduated: false,
    progressPct: rec.progressPct != null ? rec.progressPct : 0,
    progressSource: rec.progressSource || null,
    raised: rec.raisedNative,
    target: rec.targetNative,
    launchpad: rec.launchpad || null,
  };
}

/**
 * Socials in the shape tokeninfo.socials caches and the card renders.
 *
 * Re-checked here even though the registry already sanitised them on the way
 * in. These strings are written by whoever deployed the token and they end up
 * inside an href in a Telegram message: a `javascript:` or `data:` URL has no
 * business there, and a malformed one makes Telegram reject the whole message —
 * taking the live monitor down over a field a stranger controls. tokeninfo.js
 * and poolstrade.js already keep their own copy of this check for the same
 * reason; a link that reaches a card should have passed it at every hop, not
 * only at the first.
 */
function socialsOf(rec) {
  if (!rec) return null;
  const v = { website: safeUrl(rec.website) || '', twitter: safeUrl(rec.twitter) || '', telegram: safeUrl(rec.telegram) || '' };
  return (v.website || v.twitter || v.telegram) ? v : null;
}

module.exports = {
  covers, record, apiRecord, toApi, curveSnapshot, curveOverlay, socialsOf, chainFor,
  // Straight through, so callers need only one require.
  newLaunches: lp.newLaunches, probes: lp.probes, padsFor: lp.padsFor,
  enabled: lp.enabled, all: lp.all, padBase: lp.padBase, basesOf: lp.basesOf, reload: lp.reload,
};
