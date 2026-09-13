'use strict';
/*
 * WHEN A CHAIN HAS NOTHING LEFT TO PROMOTE, LIST THE BIGGEST TOKENS ON IT.
 *
 * Reported from the live board: `ETHEREUM - Trending` with three rows and
 * `BASE - Trending` with two, against a per-chain target of five. Nothing was
 * broken — auto-trend promotes what is LISTED on a chain, and those two chains
 * had three and two listings in total. It already said so every cycle:
 *
 *   [autotrend] board below target on ethereum (needs 2, none eligible), base…
 *               — list more tokens on those chains, or lower the per-chain target
 *
 * …to an operator who cannot list a token from Telegram. A diagnosis with no
 * hands attached is where this feature had been sitting for weeks, which is why
 * the answer was "fixkan, dan jika kurang coin maka listingkan coin2 besar mc
 * gede": fill the gap with the chain's real large caps.
 *
 * WHAT IT IS NOT: a second auto-lister. `autoLister` hunts projects crossing
 * ~$1M for the first time and refuses anything over `maxMcapHard` — by design,
 * it can never produce a PEPE or a BRETT. This asks the opposite question ("who
 * is big on this chain right now"), runs only when a chain is SHORT, and lists
 * exactly the shortfall. The listing itself goes through
 * `autoLister.createFromInfo`, so there is still one owner of what an auto
 * listing is.
 */
const bigCoins = require('./bigCoins');
const autoLister = require('./autoLister');
const dsBigCoins = require('./dsBigCoins');
const discovery = require('../discovery');
const api = require('../api/dexvra');
const { chainOf } = require('../config/chains');
const log = require('../helpers/logger');
const { fmtCap } = require('../helpers/format');

const keyOf = (chain, address) => `${chain}:${String(address || '').toLowerCase()}`;

/**
 * Fill up to `need` slots on one chain. Never throws.
 *
 * Returns `{ listed, tried, why }` — `listed` is what reached the site, `why`
 * is why it is short of `need` when it is. A filler that quietly returns fewer
 * than asked is the reported bug one level up: the board stays short and the
 * only trace is a number nobody compares.
 */
async function fillChain(chain, need, { cfg = {}, now = Date.now(), deps = {}, maxDropPct } = {}) {
  const out = { chain, need, listed: [], tried: 0, why: null };
  if (!(need > 0)) return out;
  if (!chainOf(chain)) {
    out.why = `unknown chain ${chain}`;
    return out;
  }
  const top = deps.topByMcap || bigCoins.topByMcap;
  const info = deps.fetchTokenInfo || discovery.fetchTokenInfo;
  const create = deps.createFromInfo || autoLister.createFromInfo;
  const listings = deps.getListings || api.getListings;
  const everListed = deps.wasEverListed || autoLister.wasEverListed;

  // Ask for more than we need: the ones already on the site are the ones most
  // likely to be at the top of a by-cap list, so a limit of exactly `need`
  // would routinely come back fully consumed by tokens we already have.
  const ask = (fn) => fn(chain, {
    limit: Math.max(need * 5, 10),
    minMcap: Number(cfg.fillMinMcap) || 5_000_000,
    minLiq: Number(cfg.fillMinLiq) || 100_000,
    // The free-trending volume floor, applied at the QUERY so a quiet page of
    // pools never becomes candidates at all. `fillMinMcap` ($5M) already sits
    // far above the cap floor, so the cap needs nothing here — the volume floor
    // had no equivalent anywhere in this path.
    minVol24: Number(cfg.minVol24hUsd) || 0,
  }).catch((e) => ({ ok: false, why: e.message, items: [] }));

  // ⚠️ A SECOND SOURCE FOR THE SAME QUESTION. `bigCoins` reads GeckoTerminal,
  // whose free tier is ~30 req/min counted PER IP and shared with the website —
  // so on a busy minute this returns `ok:false` and the chain simply stays
  // short, which is the reported symptom. `dsBigCoins` asks DexScreener the
  // same question and returns the SAME shape (`{ok, why, items}` with
  // `address`/`symbol`/`mcap`/`vol24`/`change24h`), so it is a drop-in.
  //
  // GT stays FIRST: it ranks by pool depth across a whole network, which is the
  // better answer when it is available. DexScreener is asked only when GT could
  // not be — never when GT answered with nothing, because that is a fact about
  // the chain, not about us. Both reasons are kept, or "GT was rate-limited"
  // would be replaced by whatever the fallback then said.
  let res = await ask(top);
  if (!res.ok && !res.items.length) {
    const alt = (deps && deps.topByMcapAlt) || dsBigCoins.topByMcap;
    const second = await ask(alt).catch((e) => ({ ok: false, why: e.message, items: [] }));
    if (second.items.length) {
      log.info(`[trendfill] ${chain}: GeckoTerminal could not answer (${res.why || "unknown"}) — DexScreener found ${second.items.length}`);
      res = second;
    } else {
      res = { ...second, why: `GeckoTerminal: ${res.why || "unknown"} · DexScreener: ${second.why || "nothing"}` };
    }
  }
  if (!res.ok && !res.items.length) {
    // "GT is rate-limited" and "this chain has no big tokens" need different
    // answers from whoever reads the log, and only one of them is worth
    // re-trying in ten minutes.
    out.why = `could not read the market for ${chain}: ${res.why || 'unknown'}`;
    return out;
  }
  if (!res.items.length) {
    out.why = `no token on ${chain} clears the floor (mcap ≥ $${(Number(cfg.fillMinMcap) || 5_000_000).toLocaleString('en-US')})`;
    return out;
  }

  let known;
  try {
    const rows = (await listings()) || [];
    known = new Set(rows.map((r) => keyOf(r.chain, r.address)));
  } catch (e) {
    // Without the site's list we cannot tell a new token from one already
    // listed, and listing a duplicate is worse than staying short for a cycle.
    out.why = `site API unreachable: ${e.message}`;
    return out;
  }

  // ⚠️ THE FREE-FALL BOUND APPLIES TO THIS DOOR TOO.
  //
  // The promoter refuses to put a listed token below −15% on the board, because
  // a slot filled by something in free-fall is worse than a short board. A
  // filler that then LISTS a big-cap down 40% to fill the same slot makes that
  // rule decorative — and on a red day it would do it on every chain, every
  // cycle. `autoTrend` owns the number and passes it in; the lazy require is
  // only for a direct caller, so there is still exactly one value.
  const maxDrop = Number.isFinite(Number(maxDropPct))
    ? Number(maxDropPct)
    : require('./autoTrend').FLOOR_FILL_MAX_DROP;

  // ⚠️ AND THE PERCENTAGE RULE BINDS THIS DOOR TOO.
  //
  // A filled listing books its board slot directly (the `trending` package
  // below), so a candidate with no 24h reading is a blank row put on the board
  // by the very code meant to keep it healthy — the free-fall bound learnt this
  // exact lesson one field over. The exemption is the promoter's, unchanged and
  // just as narrow: only where NOTHING on this chain has a reading do the
  // unreadable go on, or a chain no indexer covers could never be filled.
  const anyReading = res.items.some((c) => Number.isFinite(c.change24h));
  // ⚠️ AND THE QUALITY FLOORS BIND THIS DOOR TOO — the third time this exact
  // sentence has had to be written in this file, which is the argument for it
  // being ONE function rather than three.
  //
  // The floors already sit above `topByMcap` as `minMcap`/`minVol24`, so most
  // of what would fail here never arrives. This is the belt: `topByMcap` is a
  // MARKET read that can be stubbed, widened, or answered by a second source
  // (`dsBigCoins` asks the same question a different way), and a filled listing
  // books its board slot at creation — so a candidate that slipped past the
  // query would be published with nothing left to refuse it.
  const refusal = (deps && deps.floorRefusal) || require('./autoTrend').floorRefusal;
  // One counter per refusal, and each candidate increments exactly one — the
  // `why` ladder below reports the DOMINANT one, which only works while they
  // partition the refusals rather than overlapping.
  let inFreeFall = 0;
  let noReading = 0;
  let belowFloor = 0;
  let lastFloorWhy = null;
  for (const c of res.items) {
    if (out.listed.length >= need) break;
    const bad = refusal({ mcap: c.mcap, vol24: c.vol24 }, cfg);
    if (bad) {
      belowFloor++;
      lastFloorWhy = bad.why;
      continue;
    }
    // An UNREADABLE change is not a fall — same exemption the promoter makes,
    // and for the same reason: Robinhood has no indexer, so judging by a number
    // nobody can read would mean never filling that chain at all.
    if (Number.isFinite(c.change24h) && c.change24h < -maxDrop) {
      inFreeFall++;
      continue;
    }
    if (anyReading && !Number.isFinite(c.change24h)) {
      noReading++;
      continue;
    }
    if (known.has(keyOf(c.chain, c.address))) continue;
    // Listed once and gone means the operator removed it, or somebody paid for
    // it and it lapsed. Either way it must not come back free — the rule the
    // scan already follows via the same memo.
    if (everListed(c.chain, c.address)) continue;
    out.tried++;
    // Enrich from the source every other listing uses, so a filled listing
    // carries the same logo and socials a scanned one does. It is an UPGRADE:
    // GT already gave us a name, a symbol, a cap and an image, so a failed
    // lookup must not cost the fill.
    let full = null;
    try {
      full = await info(c.chain, c.address);
    } catch (e) {
      log.debug(`[trendfill] token info ${c.chain}/${c.address}: ${e.message}`);
    }
    const merged = {
      ...(full || {}),
      name: (full && full.name) || c.name,
      symbol: (full && full.symbol) || c.symbol,
      logoUrl: (full && full.logoUrl) || c.logoUrl,
      mcap: (full && full.mcap) || c.mcap,
      priceUsd: (full && full.priceUsd) || c.priceUsd,
      liq: (full && full.liq) || c.liq,
      vol24: (full && full.vol24) || c.vol24,
      change24h: full && Number.isFinite(full.change24h) ? full.change24h : c.change24h,
    };
    if (!merged.symbol || !merged.name) continue; // a nameless row on a public board
    try {
      // The "trending" package: it lists AND books a board slot, so the chain
      // that was short is full on this pass rather than the next one. Anything
      // else would leave the board short for another auto-trend cycle — up to
      // two hours — which is the state being fixed.
      const made = await create(c.chain, c.address, merged, { now, pkgKey: 'trending' });
      if (!made) continue;
      out.listed.push({ chain: c.chain, address: c.address, sym: made.input.sym, mcap: c.mcap, tier: made.input.tier });
      log.info(
        `[trendfill] listed ${made.input.sym} on ${c.chain} at $${Math.round(c.mcap).toLocaleString('en-US')} ` +
          `to fill the board (${out.listed.length}/${need})`,
      );
    } catch (e) {
      // One refusal must not end the fill — the next candidate is a different
      // token and usually fine.
      log.warn(`[trendfill] createListing ${c.symbol} (${c.chain}): ${e.message}`);
    }
  }
  if (out.listed.length < need && !out.why) {
    // Each counter is a DIFFERENT answer for whoever reads it, which is why
    // this is a ladder rather than one "nothing qualified": free-fall clears
    // itself in a day, a floor is a SETTING the operator can change, and
    // "already listed" is neither and needs no action at all. A counter that
    // did not join this ladder would report as "already listed" — the defect
    // boardPercent.test.js already pins one field over.
    //
    // ⚠️ The DOMINANT one wins, not the first one written down. Every branch
    // here says "every", and with three mutually exclusive counters (each
    // candidate increments exactly one) that is only true of the counter that
    // accounts for all of them — so a chain with one dead token and twenty in
    // free-fall must not be reported as a floor problem, and vice versa. The
    // count is printed whenever it is not the whole story.
    const worst = [
      { n: belowFloor, text:
        // `autoTrend.floorsPhrase`, never a local format: `fmtCap(0)` is "$0",
        // and a floor the operator switched OFF must not be named as one that
        // refused something.
        `big token(s) on ${chain} below the free-trending floors ` +
        `(${require('./autoTrend').floorsPhrase(cfg)}) — the last was ${lastFloorWhy}` },
      { n: inFreeFall, text: `big token(s) on ${chain} down more than ${maxDrop}% — a short board beats one in free-fall` },
      { n: noReading, text: `big token(s) on ${chain} with no 24h reading — a trending row without a percentage is not a trending row` },
    ].sort((a, b) => b.n - a.n)[0];
    const refusedTotal = belowFloor + inFreeFall + noReading;
    out.why =
      out.tried === 0
        ? worst.n > 0
          ? `${worst.n === refusedTotal ? "every one of the" : `${worst.n} of ${refusedTotal}`} ${worst.text}`
          : `every big token on ${chain} is already listed`
        : `only ${out.listed.length}/${need} could be listed`;
  }
  return out;
}

module.exports = { fillChain };
