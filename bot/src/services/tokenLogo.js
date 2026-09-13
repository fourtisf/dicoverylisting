'use strict';
/*
 * A LOGO FOR EVERY LISTING, from whichever source has one.
 *
 * "setiap token harus punya logo anda cari sumber logo entah dri dexscrener
 * pumpfun atau apalah cri dri banyak sumber dan jika tidak ada logo hapus aja
 * tokenya." The board was rendering `FL` initials for $FLOKI — the site's
 * monogram fallback, which is the right thing to draw and the wrong thing to
 * have to draw on a row nobody will ever come and fix.
 *
 * Seven sources, in the order of how much they KNOW about the token:
 *
 *   1. DexScreener pair info    — what the project itself uploaded
 *   2. GeckoTerminal token      — a second index, different submissions
 *   3. The launchpad            — pump.fun and friends have artwork from the
 *                                 first minute, long before either index
 *   4. CoinGecko by contract    — curated, and the only one of these that a
 *                                 human at the index has actually looked at
 *   5. Trust Wallet assets      — a community repo of token artwork, which is
 *                                 where a wallet gets its icons from
 *   6. pools.trade              — the Robinhood Chain launchpad. DexScreener
 *                                 does not index that chain and CoinGecko has
 *                                 no platform id for it, so for a Robinhood
 *                                 token this is one of only two places the
 *                                 artwork can be.
 *   7. DexScreener's CDN path   — a convention, not an answer; see below
 *
 * ⚠️ AND WHEN ALL SEVEN HAVE NOTHING, THAT IS INFORMATION. "ga mungkin kalo
 * project g punya logo" is right about projects and the tokens it was said
 * about were not projects: `$SAFE`, `$BONK`, `$CAT`, `$WOJAK`, `$MEME` — one
 * per search TERM the seeder uses, on three chains, none with artwork. A real
 * project is on at least one of seven indexes within a day of launching.
 * Seven empty answers is the cheapest junk filter this repo has.
 *
 * ⚠️ EVERY CANDIDATE IS FETCHED BEFORE IT IS BELIEVED. Source 7 is a URL
 * TEMPLATE — `dd.dexscreener.com/ds-data/tokens/<chain>/<addr>.png` — so it can
 * always be constructed and is very often a 404. Storing one unverified turns
 * "no logo" into "broken image", which is worse: the monogram at least looks
 * deliberate. The check also catches an HTML error page served with a 200,
 * which is what a CDN does when it does not want to admit a miss.
 */
const dexscreener = require('../dexscreener');
const gt = require('../group/gtPairs');
const launchpads = require('../launchpads');
const poolstrade = require('../poolstrade');
const { DS_CHAIN } = require('../dexscreener');
const log = require('../helpers/logger');

const TIMEOUT_MS = 8000;
const httpsUrl = (u) => (/^https:\/\/\S+$/.test(String(u || '')) ? String(u) : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Does this url actually serve an image? Never throws.
 *
 * HEAD first because it costs no bytes, then GET — some CDNs answer HEAD with
 * 405 while serving the file perfectly well, and treating that as a miss would
 * discard a good logo.
 */
async function isImage(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, { method, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 405 || res.status === 501) continue; // HEAD refused — try GET
      if (!res.ok) return false;
      const type = String(res.headers.get('content-type') || '').toLowerCase();
      // A 200 carrying HTML is a CDN's error page, not a logo.
      if (type.startsWith('image/')) return true;
      if (type) return false;
      // No content-type at all: accept only if something came back.
      return method === 'GET';
    } catch {
      return false; // a source we cannot reach is a source we cannot use
    }
  }
  return false;
}

/** DexScreener's token-image CDN path. A CONVENTION we construct, which is why
 *  it is last and why it is verified like everything else. */
function cdnGuess(chain, address) {
  const slug = DS_CHAIN[chain];
  return slug && address ? `https://dd.dexscreener.com/ds-data/tokens/${slug}/${address}.png` : null;
}

// CoinGecko's own platform ids. Not our chain ids and not DexScreener's — a
// third spelling of the same set, which is exactly the kind of table that goes
// stale silently, so a chain missing here costs one source and never a throw.
const CG_PLATFORM = {
  ethereum: 'ethereum',
  bsc: 'binance-smart-chain',
  base: 'base',
  solana: 'solana',
  polygon: 'polygon-pos',
  arbitrum: 'arbitrum-one',
  optimism: 'optimistic-ethereum',
  avalanche: 'avalanche',
  tron: 'tron',
  ton: 'the-open-network',
  sui: 'sui',
  aptos: 'aptos',
  sei: 'sei-v2',
  blast: 'blast',
  berachain: 'berachain',
  sonic: 'sonic',
  unichain: 'unichain',
};

/** Trust Wallet's assets repo — a fourth spelling again, and EVM only: the
 *  path is keyed on the EIP-55 CHECKSUMMED address, so a lowercase one 404s. */
const TW_CHAIN = {
  ethereum: 'ethereum',
  bsc: 'smartchain',
  base: 'base',
  polygon: 'polygon',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  avalanche: 'avalanchec',
};

/**
 * GeckoTerminal's own token record — ONE light call for `image_url`.
 *
 * ⚠️ It used to ask `marketdata.fetchMarket`, which is the heavy read: pools,
 * candles, a price, a market cap. Eighty-three rows × several GT requests each
 * is a rate limit we arm OURSELVES, and the first cleanup run did exactly that
 * — one 429 on row one, then eighty-two rows reported `undecided` because the
 * cooldown it caused never lifted inside the run. A logo needs one endpoint.
 *
 * Through `gtGet`, so it shares the paced queue and the cooldown rather than
 * being a private client with its own idea of the quota.
 */
async function gtLogo(chain, address) {
  const net = gt.networkOf(chain);
  if (!net || !address) return { ok: true, url: null }; // nothing to ask
  const res = await gt.gtGet(`/networks/${net}/tokens/${encodeURIComponent(address)}`);
  if (!res.ok) {
    // A 404 is an answer — GT does not index this token. Anything else means
    // it never looked.
    if (res.status === 404) return { ok: true, url: null };
    return { ok: false, why: res.reason || `HTTP ${res.status}` };
  }
  const attr = (res.body && res.body.data && res.body.data.attributes) || {};
  return { ok: true, url: httpsUrl(attr.image_url) };
}

/*
 * ⚠️ COINGECKO IS PACED, and it is the source that actually finds things.
 *
 * A cleanup walks a row every 120ms and asked CoinGecko once per row with no
 * gap at all. Its free tier is a handful of calls a minute, so it started
 * refusing — and because a refusal is `ok:false`, the run then blocked on it
 * while SLEEPING ON GECKOTERMINAL'S CLOCK, which had nothing to do with the
 * limit that was actually stopping it. Two different services' rate limits,
 * one wait, keyed to the wrong one.
 *
 * So: one call at a time, a minimum gap between them, and `Retry-After`
 * honoured once. Slower than an unpaced run, and an unpaced run does not
 * finish.
 */
// Read per call, not frozen at require: a test that cannot turn the gap off
// spends 2.5 seconds per case, and a slow test is one that gets deleted.
const cgGapMs = () => {
  const n = Number(String(process.env.CG_MIN_GAP_MS || '').trim());
  return Number.isFinite(n) && n >= 0 ? n : 2500;
};
let cgNextAt = 0;
let cgChain = Promise.resolve();

/** Serialise CoinGecko calls and space them. Concurrent callers queue rather
 *  than all firing at once, which is what a per-row `Promise.all` would do. */
function cgSlot() {
  const wait = cgChain.then(async () => {
    const now = Date.now();
    const delay = Math.max(0, cgNextAt - now);
    if (delay) await sleep(delay);
    cgNextAt = Math.max(now, cgNextAt) + cgGapMs();
  });
  cgChain = wait.catch(() => {});
  return wait;
}

const retryAfterMs = (res) => {
  const h = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
  // Their number, used to park ours — bounded, and never negative.
  return Number.isFinite(h) && h > 0 ? Math.min(h * 1000, 60_000) : 0;
};

async function coingecko(chain, address, { retried = false } = {}) {
  const plat = CG_PLATFORM[chain];
  // A chain CoinGecko has no id for is ANSWERED — there is nothing to ask.
  if (!plat || !address) return { ok: true, url: null };
  await cgSlot();
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${plat}/contract/${encodeURIComponent(address)}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (res.status === 429 && !retried) {
      // Once. A second refusal means the budget is genuinely spent and the
      // caller should be told, not held.
      await sleep(retryAfterMs(res) || cgGapMs() * 4);
      return coingecko(chain, address, { retried: true });
    }
    // 404 is the ordinary answer here — CoinGecko is curated, so most tokens a
    // seeding run finds are simply not in it. A 429 or a 5xx is the opposite:
    // the index never looked, and reporting that as "not in CoinGecko" is how
    // a rate limit becomes a deleted listing.
    if (res.status === 404) return { ok: true, url: null };
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const j = await res.json();
    const img = j && j.image;
    return { ok: true, url: httpsUrl((img && (img.large || img.small || img.thumb)) || null) };
  } catch (e) {
    return { ok: false, why: (e && e.message) || 'request failed' };
  }
}

function trustWallet(chain, address) {
  const slug = TW_CHAIN[chain];
  if (!slug || !/^0x[0-9a-fA-F]{40}$/.test(String(address || ''))) return null;
  let checksummed;
  try {
    checksummed = require('ethers').getAddress(String(address));
  } catch {
    return null; // not a valid address — nothing to build a path from
  }
  return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${slug}/assets/${checksummed}/logo.png`;
}

/**
 * The best logo url for a token, or `null` when no source has one.
 *
 * `{ url, source }` so a cleanup run can report WHERE each logo came from —
 * "42 from the launchpad" is the difference between a working chain of sources
 * and one source quietly carrying all of it.
 */
async function resolveLogo(chain, address, { deps = {} } = {}) {
  const dsInfo = deps.dsInfo || dexscreener.fetchTokenInfo;
  const gtInfo = deps.gtInfo || gtLogo;
  const padInfo = deps.padInfo || launchpads.fetchTokenInfo;
  const ptInfo = deps.ptInfo || poolstrade.fetchTokenInfo;
  const cgInfo = deps.cgInfo || coingecko;
  const gtDown = deps.gtInCooldown || gt.inCooldown;
  const verify = deps.isImage || isImage;

  const tried = [];
  const unreachable = [];

  /** Ask one source. A THROW means we could not ask; `null` means it answered
   *  and has nothing. Those are different facts and this is where they part. */
  const ask = (name, fn) =>
    Promise.resolve()
      .then(fn)
      .catch((e) => {
        unreachable.push(`${name}: ${(e && e.message) || 'failed'}`);
        return null;
      });

  /** Try candidates in order; the first that FETCHES as a real image wins. */
  const firstImage = async (cands) => {
    for (const [source, url] of cands) {
      if (!url) continue;
      tried.push(source);
      if (await verify(url)) return { ok: true, url, source, tried, unreachable };
    }
    return null;
  };

  // ── WAVE 1 — the sources that cost NOTHING ────────────────────────────────
  //
  // ⚠️ THE METERED SOURCES ARE NOT IN HERE, AND THAT IS THE WHOLE POINT.
  //
  // This used to ask all five concurrently for EVERY row, GeckoTerminal
  // included — so a token whose logo DexScreener already had still spent a GT
  // request. Across 463 listings that is 463 requests into a ~30/min per-IP
  // ceiling shared with the running bot, and the operator watched their own
  // buy alerts stop: "GeckoTerminal backing off for 120s — Buy alerts are
  // paused process-wide", over and over, while a cleanup script ate the
  // quota. The website's resolver has always deferred GT for exactly this
  // reason (src/lib/providers/tokenLogo.ts); the bot's never learnt it.
  //
  // DexScreener has no tight limit, the launchpad (pump.fun and friends) is
  // free and has artwork from the token's first minute, pools.trade is free,
  // and Trust Wallet is a GitHub CDN path we construct. Most rows are answered
  // here and never reach wave 2 at all.
  const [ds, pad, pt] = await Promise.all([
    ask('dexscreener', () => dsInfo(chain, address)),
    ask('launchpad', () => (padInfo ? padInfo(chain, address) : null)),
    ask('poolstrade', () => (ptInfo ? ptInfo(chain, address) : null)),
  ]);
  const free = await firstImage([
    ['dexscreener', httpsUrl(ds && ds.logoUrl)],
    ['launchpad', httpsUrl(pad && pad.logoUrl)],
    ['poolstrade', httpsUrl(pt && pt.logoUrl)],
    ['trustwallet', httpsUrl(trustWallet(chain, address))],
  ]);
  if (free) return free;

  // ── WAVE 2 — the METERED ones, only for what wave 1 could not answer ──────
  //
  // GeckoTerminal cannot simply be dropped, however much it costs: on
  // ROBINHOOD it is one of only two places the artwork can be (see the
  // gtRedundant rule below), so never asking it would turn "we did not look"
  // into a permanent `undecided` for that whole chain. Asking it LAST is the
  // fix; not asking it is a different bug.
  const [gt2, cg] = await Promise.all([
    // ⚠️ GeckoTerminal's 429 arms a PROCESS-WIDE cooldown, after which every
    // read returns instantly with nothing. Calling it anyway and reading that
    // as "GT has no logo" is exactly how one rate limit deleted eighty-three
    // rows' worth of evidence.
    gtDown() ? Promise.resolve(unreachable.push('geckoterminal: cooldown') && null) : ask('geckoterminal', () => gtInfo(chain, address)),
    ask('coingecko', () => cgInfo(chain, address)),
  ]);
  if (cg && cg.ok === false) unreachable.push(`coingecko: ${cg.why}`);
  if (gt2 && gt2.ok === false) unreachable.push(`geckoterminal: ${gt2.why}`);
  const metered = await firstImage([
    // `.url` from gtLogo; `.logoUrl` is the shape a caller's own stub may use.
    ['geckoterminal', httpsUrl(gt2 && (gt2.url || gt2.logoUrl))],
    ['coingecko', httpsUrl(cg && cg.url)],
  ]);
  if (metered) return metered;

  // ── WAVE 3 — a CONVENTION, never an answer ────────────────────────────────
  // A path we construct rather than one anybody gave us, so it stays last: a
  // guess must always lose to an answer.
  const guessed = await firstImage([['dexscreener-cdn', httpsUrl(cdnGuess(chain, address))]]);
  if (guessed) return guessed;

  // ⚠️ `ok` is the whole point of this return shape. `ok:true, url:null` means
  // the sources that MATTER answered and none had artwork — the only state in
  // which a caller may delete the listing. `ok:false` means one could not be
  // asked, and the honest answer is "not yet known".
  //
  // ⚠️ GeckoTerminal is redundant ONLY WHERE COINGECKO COVERS THE CHAIN, and
  // the first cut of this rule got that wrong in the way that matters. GT is
  // CoinGecko's and shares its catalogue — true on Ethereum, BSC, Base. On
  // ROBINHOOD it is the opposite: DexScreener does not index that chain,
  // CoinGecko has no platform id for it, and GT is one of only two places the
  // artwork can be. Skipping it there turned "we did not look" into "no
  // artwork on any source" for every Robinhood row on the board.
  //
  // So it is a bonus where something else covers the same ground, and required
  // where nothing does.
  const gtRedundant = !!CG_PLATFORM[chain];
  const blocking = unreachable.filter((u) => !(gtRedundant && u.startsWith('geckoterminal:')));
  const ok = blocking.length === 0;
  if (!ok) log.debug(`[tokenlogo] ${chain}/${address}: undecided — ${blocking.join(', ')}`);
  // `unreachable` still carries GT so a caller can SAY it was skipped; `ok`
  // simply does not hang on it.
  return { ok, url: null, source: null, tried, unreachable, blocking };
}

module.exports = { resolveLogo, isImage, cdnGuess, trustWallet, coingecko, gtLogo, CG_PLATFORM, TW_CHAIN, _httpsUrl: httpsUrl };
