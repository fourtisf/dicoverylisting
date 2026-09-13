'use strict';
/*
 * The launchpad table.
 *
 * WHAT A LAUNCHPAD IS FOR HERE
 * A token that has not migrated yet trades on a bonding curve, not on a pool.
 * DexScreener and GeckoTerminal index POOLS, so for the entire pre-migration
 * life of a token — the part where somebody actually wants to know about it —
 * both bots were blind: the trade card said "❌ Couldn't price it" and the
 * listing form autofilled nothing. The launchpad's own API is the only source
 * that knows a token during that window.
 *
 * WHAT IT IS NOT FOR — READ BEFORE EXTENDING
 * Nothing in this file may reach the money path. A buy is priced, routed and
 * signed from chain state and from the aggregator's own quote; everything here
 * is DISPLAY METADATA and every field is optional to every caller. An HTTP
 * source that is wrong, stale or hostile can put a stale market cap on a card;
 * it must never be able to change what a trade does or where the tokens go.
 * bot/src/poolstrade.js carries the same warning for the same reason.
 *
 * EVERY PAD IS ENV-OVERRIDABLE, AND THAT IS THE POINT
 * These request shapes are not published contracts — three outages in two days
 * came from third parties moving, and the fix each time was a deploy. So:
 *
 *   LAUNCHPADS=0                     kill the whole registry
 *   LAUNCHPAD_<KEY>=0                disable one pad (blank/absent = ON)
 *   LAUNCHPAD_<KEY>_API=<base>       pin ONE base and skip the base list
 *   LAUNCHPAD_<KEY>_TOKEN_PATH=…     override the per-token path ({id} placeholder)
 *   LAUNCHPAD_<KEY>_FEED_PATH=…      override the new-launches path ({n} placeholder)
 *
 * A pad whose guessed path is wrong therefore costs a config line, not an
 * outage and not a deploy — and `npm run launchpads:check` on the box says
 * which ones answered and what they returned.
 *
 * `verified: false` marks a pad whose request shape has NOT been exercised
 * against the live API from inside this repo. It is not a warning that the pad
 * is broken; it is an honest label so the check script can tell an operator
 * where to look first. A pad that 404s contributes nothing and every other pad
 * still answers — that is the whole reason this is a table and not a chain of
 * fallbacks.
 */
const N = require('./normalize');
const { pick, str, num, pnum, bool, toMs, pct, safeUrl, logoUri, socialUrl, description } = N;

const env = (k) => String(process.env[k] == null ? '' : process.env[k]).trim();

/** Blank or absent means ON. Only an explicit 0/false/off/no disables a pad.
 *  Same deliberate "blank ≠ false" rule as bot/src/raid/sourceFlag.js: a `.env`
 *  carrying a bare `LAUNCHPAD_MOONSHOT=` is "never decided", not "refused". */
function padOn(key) {
  const v = env('LAUNCHPAD_' + key.toUpperCase()).toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * ⚠️ AN UNFILLED PLACEHOLDER IS NOT A VALUE, AND BASH WILL ACCEPT IT SILENTLY.
 *
 * This file's own first rule in CLAUDE.md is that a command an operator can
 * paste must contain only real values — and it keeps being broken, because the
 * failure is so quiet. An angle-bracket placeholder at least dies with a shell
 * syntax error. `LAUNCHPAD_PONS_TOKEN_PATH=/api/…/{id}` does not: `VAR=value`
 * is a legal assignment whatever the value is, so the operator gets a clean
 * prompt back and every lookup afterwards requests `/api/%E2%80%A6/0x…` and
 * 404s for ever. From `launchpads:check` that is indistinguishable from a
 * launchpad that moved — which is the very thing the override exists to fix.
 *
 * So the value is REFUSED rather than used, and the refusal is LOUD: an
 * operator who set something and is being ignored must be told, or "the
 * override did not work" and "the override was never read" look identical.
 *
 * `{id}` and `{n}` are the legitimate fillers and are untouched — the markers
 * below are ones no real URL path or host can contain.
 */
const PLACEHOLDER = /…|\.\.\.|[<>]|\s/;
const _warned = new Set();
function realValue(name, v) {
  if (!v || !PLACEHOLDER.test(v)) return v;
  if (!_warned.has(name)) {
    _warned.add(name);
    console.warn(`[launchpads] ignoring ${name}: "${v}" still contains a placeholder (… or <>) or a space — using the built-in value instead. Paste the real path, not the example.`);
  }
  return '';
}

/** The base list for a pad: an explicit `<PAD>_API` pins one host AND skips the
 *  list — the same override-and-skip contract `<CHAIN>_V4_POOLMANAGER` has.
 *  `aliases` lets a pad honour an env var that already exists in this repo, so
 *  an operator who set PUMPFUN_API is not silently overruled by a second one. */
function basesFor(key, defaults, aliases) {
  for (const name of ['LAUNCHPAD_' + key.toUpperCase() + '_API', ...(aliases || [])]) {
    const v = realValue(name, env(name).replace(/\/+$/, ''));
    if (v) return [v];
  }
  return defaults.slice();
}

const path = (key, which, fallback) => {
  const name = `LAUNCHPAD_${key.toUpperCase()}_${which}_PATH`;
  return realValue(name, env(name)) || fallback;
};

/**
 * The per-token path LIST — several plausible spellings of ONE endpoint, tried
 * in order and ONLY on a 404 (`index.js` padToken).
 *
 * ⚠️ A BASE LIST IS NOT INSURANCE AGAINST A WRONG PATH, and this is the half it
 * never covered. Failover between BASES is transport-only, on the standing rule
 * that a status means the host answered and the same request gets the same
 * status everywhere else — true of a host, and false of a PATH: a 404 says
 * "that spelling is not here", which is exactly when another spelling on the
 * same host is worth trying. Same distinction `dsChart.ts` already draws, one
 * upstream over.
 *
 * So a pad whose API shape we cannot verify from here gets more than one shot,
 * and the cost is bounded: only a 404 advances, the answer is cached, and a pad
 * whose first spelling is right pays nothing at all.
 *
 * `LAUNCHPAD_<KEY>_TOKEN_PATH` still REPLACES the whole list — an operator who
 * has read the real path out of their browser's network tab wants that one
 * asked, not four guesses in front of it. The pin-and-skip contract
 * `<PAD>_API` already has.
 */
const pathList = (key, which, fallback) => {
  const pinned = path(key, which, '');
  return pinned ? [pinned] : fallback.filter(Boolean);
};
const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : encodeURIComponent(String(vars[k]))));

// ── shared field vocabularies ────────────────────────────────────────────────
// Read once here rather than repeated per pad: every launchpad reinvents these
// names and the union is the same union each time.
const P_NAME = ['name', 'tokenName', 'token.name', 'baseToken.name', 'metadata.name', 'data.name'];
const P_SYMBOL = ['symbol', 'ticker', 'tokenSymbol', 'token.symbol', 'baseToken.symbol', 'metadata.symbol'];
const P_DESC = ['description', 'desc', 'about', 'metadata.description', 'profile.description', 'profile.decription'];
const P_LOGO = ['image_uri', 'imageUri', 'imageUrl', 'image', 'icon', 'logo', 'logoUrl', 'imgUrl', 'profile.icon', 'metadata.image'];
const P_WEBSITE = ['website', 'links.website', 'metadata.website', 'socials.website', 'homepage', 'url'];
const P_TWITTER = ['twitter', 'links.twitter', 'x', 'links.x', 'metadata.twitter', 'socials.twitter', 'twitterUrl', 'twitterHandle'];
const P_TELEGRAM = ['telegram', 'links.telegram', 'metadata.telegram', 'socials.telegram', 'telegramUrl', 'telegramHandle'];
const P_PRICE = ['priceUsd', 'price_usd', 'usdPrice', 'price.usd', 'priceInUsd'];
const P_MCAP = ['usd_market_cap', 'usdMarketCap', 'marketCapUsd', 'market_cap_usd', 'mcap', 'marketCap', 'market_cap', 'fdv', 'fdvUsd'];
const P_LIQ = ['liquidity', 'liquidityUsd', 'liquidity.usd', 'liquidity_usd', 'reserveUsd', 'reserve_in_usd'];
const P_HOLDERS = ['holderCount', 'holders', 'holder_count', 'holdersCount', 'stats.holders'];
const P_CREATOR = ['creator', 'creator_address', 'creatorAddress', 'dev', 'deployer', 'owner'];
const P_CREATED = ['created_timestamp', 'createdAt', 'created_at', 'createAt', 'launchedAt', 'launchTime', 'firstPool.createdAt', 'blockTimestamp', 'timestamp'];

/** Volume over 24h, including the sources that report buys and sells apart. */
function vol24(raw) {
  const direct = pnum(pick(raw, ['volume24hUsd', 'volume_24h_usd', 'volume24h', 'volume.h24', 'volumeUsd24h', 'stats24h.volume', 'v24hUSD']));
  if (direct != null) return direct;
  const b = num(pick(raw, ['stats24h.buyVolume', 'buyVolume24h', 'volume.buy.h24']));
  const s = num(pick(raw, ['stats24h.sellVolume', 'sellVolume24h', 'volume.sell.h24']));
  if (b == null && s == null) return null;
  const t = (b || 0) + (s || 0);
  return t > 0 ? t : null;
}

/**
 * An empty canonical record, so every pad returns the SAME keys.
 *
 * A pad that simply omits a field it does not know would make every consumer
 * write `rec.progressPct !== undefined` in one place and `!= null` in another,
 * and one of those two spellings is wrong for `null`. Fixed keys, null for
 * "this source did not say".
 */
function blank(pad, chain, address) {
  return {
    pad: pad.key, padLabel: pad.label, chain, address,
    name: null, symbol: null, description: null, logoUrl: null,
    website: null, twitter: null, telegram: null,
    priceUsd: null, mcapUsd: null, liqUsd: null, vol24Usd: null, holders: null, creator: null,
    createdAt: null,
    // The point of the whole module. `null` is "this source did not say" and is
    // NOT the same as false — a caller that renders "◆ Graduated" on a null has
    // invented a fact.
    onCurve: null, graduated: null, progressPct: null, progressSource: null,
    raisedNative: null, targetNative: null, nativeSym: null,
    migratedPool: null, launchpad: null, launchUrl: null,
    source: 'launchpad:' + pad.key,
  };
}

/** The fields every pad shares, filled the same way for all of them. */
function common(rec, raw, now) {
  rec.name = str(pick(raw, P_NAME), 60) || rec.name;
  rec.symbol = str(pick(raw, P_SYMBOL), 20) || rec.symbol;
  rec.description = description(pick(raw, P_DESC)) || rec.description;
  rec.logoUrl = logoUri(pick(raw, P_LOGO)) || rec.logoUrl;
  rec.website = safeUrl(pick(raw, P_WEBSITE)) || rec.website;
  rec.twitter = socialUrl(pick(raw, P_TWITTER), 'https://x.com') || rec.twitter;
  rec.telegram = socialUrl(pick(raw, P_TELEGRAM), 'https://t.me') || rec.telegram;
  rec.priceUsd = pnum(pick(raw, P_PRICE)) ?? rec.priceUsd;
  rec.mcapUsd = pnum(pick(raw, P_MCAP)) ?? rec.mcapUsd;
  rec.liqUsd = pnum(pick(raw, P_LIQ)) ?? rec.liqUsd;
  rec.vol24Usd = vol24(raw) ?? rec.vol24Usd;
  rec.holders = pnum(pick(raw, P_HOLDERS)) ?? rec.holders;
  rec.creator = str(pick(raw, P_CREATOR), 64) || rec.creator;
  rec.createdAt = toMs(pick(raw, P_CREATED), now) ?? rec.createdAt;
  return rec;
}

/**
 * Settle the curve state from whatever the pad said, and record WHERE the
 * number came from.
 *
 * `progressSource` is not decoration. A percentage the API stated and a
 * percentage we divided out of two reserve figures have different
 * trustworthiness, and when a launchpad quietly changes its curve constants the
 * derived one drifts while the stated one stays right. Without the label there
 * is no way to tell a drifting estimate from a moving market.
 */
function curveState(rec, { graduated, progressApi, progressDerived, migratedPool }) {
  if (migratedPool) rec.migratedPool = migratedPool;
  if (graduated != null) rec.graduated = graduated;
  else if (migratedPool) rec.graduated = true;   // it has a pool to have migrated into
  if (rec.graduated === true) {
    rec.onCurve = false;
    rec.progressPct = 100;
    rec.progressSource = 'graduated';
    return rec;
  }
  const api = pct(progressApi);
  if (api != null) { rec.progressPct = api; rec.progressSource = 'api'; }
  else {
    const d = pct(progressDerived);
    if (d != null) { rec.progressPct = d; rec.progressSource = 'derived'; }
  }
  // Only now can onCurve be stated. A pad that said nothing about graduation
  // and nothing about progress knows the token but not its phase, and guessing
  // "still bonding" would put a bonding-curve badge on a token that migrated
  // last week.
  if (rec.graduated === false) rec.onCurve = true;
  else if (rec.progressPct != null) { rec.onCurve = rec.progressPct < 100; rec.graduated = rec.progressPct >= 100; }
  return rec;
}

/** Pull the first plausible array out of a response of unknown shape. */
function rows(json, keys) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  for (const k of keys) { const v = N.at(json, k); if (Array.isArray(v)) return v; }
  for (const v of Object.values(json)) { if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v; }
  return [];
}
const LIST_KEYS = ['data.rows', 'data.items', 'data.list', 'data.tokens', 'data', 'rows', 'items', 'coins', 'tokens', 'results', 'records', 'pools', 'launches'];

/**
 * The one record for `address` out of a response whose shape we do not control:
 * a bare object, a wrapped object, a list, or a wrapped list.
 *
 * LISTS ARE SCANNED FIRST, and that ordering is the bug fix, not a style
 * choice. Unwrapping `data` first turns `{ data: { rows: [ …the token… ] } }`
 * into "the token is the object `{ rows: [...] }`", which parses to a record
 * with no address, no name and no price — a launchpad that answered correctly,
 * read as one that knows nothing.
 *
 * An object with NO id field at all is accepted only when it carries something
 * token-shaped, for the same reason: a pagination wrapper must not be mistaken
 * for the token just because it failed to mention an address.
 */
function one(json, chain, address, keys) {
  for (const r of rows(json, LIST_KEYS)) {
    if (r && typeof r === 'object' && N.sameAddress(chain, pick(r, keys), address)) return r;
  }
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const cands = [];
    for (const k of ['data', 'result', 'token', 'coin', 'pool']) {
      const v = N.at(json, k);
      if (v && typeof v === 'object' && !Array.isArray(v)) cands.push(v);
    }
    cands.push(json);
    for (const v of cands) {
      const idIn = pick(v, keys);
      if (idIn !== undefined) { if (N.sameAddress(chain, idIn, address)) return v; continue; }
      if (pick(v, ['name', 'symbol', 'ticker', 'priceUsd', 'usdPrice', 'marketCap', 'mcap', 'usd_market_cap']) !== undefined) return v;
    }
  }
  return null;
}

const ID_KEYS = ['mint', 'address', 'id', 'tokenAddress', 'token_address', 'contractAddress', 'baseToken.address', 'mintA.address', 'token.address'];

// ── pump.fun ─────────────────────────────────────────────────────────────────
// The only pad in this table whose host family is already proven in this repo:
// bot/src/marketdata.js reads descriptions from it and tradebot/solana.js reads
// the new-coins feed from it. Those two used to carry SEPARATE ideas of which
// host was current — one on the retired frontend-api, one on v3 — which is
// exactly the "one repo, two answers" defect CLAUDE.md names. This table is now
// the single owner of that answer and both of them read it from here.
//
// The bases include `/coins` because PUMPFUN_API has always been set that way
// in this repo; honouring the alias means an operator's existing override keeps
// working instead of being silently outvoted.
const PUMP_CURVE_TOKENS = Number(env('LAUNCHPAD_PUMPFUN_CURVE_TOKENS') || 793100000000000);   // initial real_token_reserves (793.1M @ 6dp)
const PUMP_TARGET_SOL = Number(env('LAUNCHPAD_PUMPFUN_TARGET_SOL') || 85);                    // SOL raised at graduation
const LAMPORTS = 1e9;

function pumpfunParse(pad, chain, raw, now) {
  const rec = common(blank(pad, chain, str(pick(raw, ['mint', 'address']), 64)), raw, now);
  rec.launchpad = 'pump.fun';
  if (rec.address) rec.launchUrl = 'https://pump.fun/coin/' + rec.address;

  // pump.fun reports market cap twice — in SOL (`market_cap`) and in dollars
  // (`usd_market_cap`). `common` already preferred the USD one; nothing here
  // may fall back to the SOL figure, because a card that prints 42 SOL under a
  // "$" is off by two orders of magnitude and looks entirely plausible.
  const complete = bool(pick(raw, ['complete', 'is_complete', 'graduated']));
  const pool = str(pick(raw, ['raydium_pool', 'raydiumPool', 'pump_swap_pool', 'pumpSwapPool', 'migratedPool']), 64);

  // Progress, DERIVED, and labelled as such. pump.fun does not publish a
  // percentage; its own frontend divides the curve's remaining token reserves
  // by the amount it started with. Both constants are env-tunable because they
  // are the launchpad's parameters, not ours, and they have moved before.
  let derived = null;
  const left = num(pick(raw, ['real_token_reserves', 'realTokenReserves']));
  if (left != null && PUMP_CURVE_TOKENS > 0 && left >= 0 && left <= PUMP_CURVE_TOKENS) {
    derived = (1 - left / PUMP_CURVE_TOKENS) * 100;
  }
  // "Raised X / Y SOL" is a FACT where the percentage is an estimate, and the
  // trade card already has a row for it (`info.raised` / `info.target`).
  const solRaw = num(pick(raw, ['real_sol_reserves', 'realSolReserves']));
  if (solRaw != null && solRaw >= 0) {
    const sol = solRaw / LAMPORTS;
    if (sol <= PUMP_TARGET_SOL * 3) { rec.raisedNative = sol; rec.targetNative = PUMP_TARGET_SOL; rec.nativeSym = 'SOL'; }
  }
  return curveState(rec, { graduated: complete, progressApi: null, progressDerived: derived, migratedPool: pool });
}

// ── Jupiter Token API v2 ─────────────────────────────────────────────────────
// The reason this pad is first for Solana: it is ONE call that covers many
// launchpads at once — it names the pad a token came from (`launchpad`) and
// carries the curve percentage (`bondingCurve`) for pump.fun, bonk.fun,
// Believe, Boop, Moonit, Raydium LaunchLab, Meteora DBC and Jupiter Studio
// alike. Asking six launchpads one question each is six ways to be wrong about
// a schema; asking the aggregator first means the specific pads only have to
// fill in what it lacks (pump.fun's description and socials, mostly).
function jupiterParse(pad, chain, raw, now) {
  const rec = common(blank(pad, chain, str(pick(raw, ['id', 'address', 'mint']), 64)), raw, now);
  rec.launchpad = str(pick(raw, ['launchpad', 'launchPad', 'platform', 'platformInfo.name']), 40);
  const pool = str(pick(raw, ['graduatedPool', 'graduated_pool']), 64);
  const gradAt = toMs(pick(raw, ['graduatedAt', 'graduated_at']), now);
  const bc = pick(raw, ['bondingCurve', 'bonding_curve', 'bondingCurvePct']);
  return curveState(rec, {
    // A graduation TIMESTAMP is a graduation. Reading only the pool address
    // would leave a token that graduated into a venue this source does not name
    // sitting at "still bonding" forever.
    graduated: gradAt != null ? true : bool(pick(raw, ['graduated', 'isGraduated'])),
    progressApi: bc,
    progressDerived: null,
    migratedPool: pool,
  });
}

// ── the table ────────────────────────────────────────────────────────────────
// `chains` are OUR chain keys (bot/src/config/chains.js and tradebot/chains.js
// agree on these three), so a pad is never asked about a chain it cannot know.
function build() {
  const defs = [
    {
      key: 'jupiter',
      label: 'Jupiter Token API',
      chains: ['solana'],
      verified: false,
      covers: 'pump.fun, bonk.fun, Believe, Boop, Moonit, Raydium LaunchLab, Meteora DBC, Jupiter Studio',
      bases: ['https://lite-api.jup.ag/tokens/v2', 'https://api.jup.ag/tokens/v2'],
      tokenPath: '/search?query={id}',
      feedPath: '/recent?limit={n}',
      idKeys: ['id', 'address', 'mint'],
      parse: jupiterParse,
    },
    {
      key: 'pumpfun',
      label: 'pump.fun',
      chains: ['solana'],
      verified: true,
      covers: 'pump.fun',
      bases: ['https://frontend-api-v3.pump.fun/coins', 'https://frontend-api.pump.fun/coins'],
      aliases: ['PUMPFUN_API'],
      tokenPath: '/{id}',
      feedPath: '?offset=0&limit={n}&sort=created_timestamp&order=DESC&includeNsfw=true',
      idKeys: ['mint', 'address'],
      parse: pumpfunParse,
    },
    {
      key: 'letsbonk',
      label: 'LetsBonk (Raydium LaunchLab)',
      chains: ['solana'],
      verified: false,
      covers: 'letsbonk.fun and other Raydium LaunchLab pads',
      bases: ['https://launch-mint-v1.raydium.io'],
      tokenPath: '/get/by/mints?ids={id}',
      feedPath: '/get/list?sort=new&size={n}&includeNsfw=false',
      idKeys: ['mint', 'mintA.address', 'address'],
      parse: (pad, chain, raw, now) => {
        const rec = common(blank(pad, chain, str(pick(raw, ['mint', 'mintA.address', 'address']), 64)), raw, now);
        rec.launchpad = str(pick(raw, ['platformInfo.name', 'platform', 'launchpad']), 40) || 'LetsBonk';
        if (rec.address) rec.launchUrl = 'https://letsbonk.fun/token/' + rec.address;
        return curveState(rec, {
          graduated: bool(pick(raw, ['migrated', 'isMigrated', 'graduated', 'finished'])),
          progressApi: pick(raw, ['finishingRate', 'progress', 'progressPct', 'bondingCurveProgress']),
          progressDerived: null,
          migratedPool: str(pick(raw, ['poolId', 'ammId', 'migratedPool']), 64),
        });
      },
    },
    {
      key: 'moonshot',
      label: 'Moonshot',
      chains: ['solana'],
      verified: false,
      covers: 'Moonshot (DEX Screener)',
      bases: ['https://api.moonshot.cc'],
      tokenPath: '/token/v1/solana/{id}',
      feedPath: '/tokens/v1/new/solana?limit={n}',
      idKeys: ['tokenAddress', 'baseToken.address', 'address', 'mint'],
      parse: (pad, chain, raw, now) => {
        const rec = common(blank(pad, chain, str(pick(raw, ['tokenAddress', 'baseToken.address', 'address']), 64)), raw, now);
        rec.launchpad = 'Moonshot';
        rec.launchUrl = safeUrl(pick(raw, ['url', 'profile.url']));
        rec.creator = str(pick(raw, ['moonshot.creator', 'creator']), 64) || rec.creator;
        return curveState(rec, {
          graduated: bool(pick(raw, ['moonshot.graduated', 'graduated', 'migrated'])),
          progressApi: pick(raw, ['moonshot.progress', 'progress', 'curvePosition']),
          progressDerived: null,
          migratedPool: str(pick(raw, ['pairAddress', 'moonshot.pairAddress']), 64),
        });
      },
    },
    {
      key: 'fourmeme',
      label: 'four.meme',
      chains: ['bsc'],
      verified: false,
      covers: 'four.meme (BNB Chain)',
      bases: ['https://four.meme'],
      tokenPath: '/meme-api/v1/private/token/get/v2?address={id}',
      feedPath: '/meme-api/v1/private/token/query?orderBy=New&pageIndex=1&pageSize={n}',
      idKeys: ['address', 'tokenAddress', 'contractAddress'],
      parse: (pad, chain, raw, now) => {
        const rec = common(blank(pad, chain, str(pick(raw, ['address', 'tokenAddress', 'contractAddress']), 64)), raw, now);
        rec.launchpad = 'four.meme';
        if (rec.address) rec.launchUrl = 'https://four.meme/token/' + rec.address;
        return curveState(rec, {
          graduated: bool(pick(raw, ['isCompleted', 'completed', 'migrated', 'graduated', 'status.completed'])),
          progressApi: pick(raw, ['progress', 'bondingProgress', 'progressPct']),
          progressDerived: null,
          migratedPool: str(pick(raw, ['pairAddress', 'poolAddress', 'lpAddress']), 64),
        });
      },
    },
    {
      key: 'virtuals',
      label: 'Virtuals Protocol',
      chains: ['base'],
      verified: false,
      covers: 'Virtuals Protocol agent launches (Base)',
      bases: ['https://api.virtuals.io'],
      tokenPath: '/api/virtuals?filters[preToken]={id}',
      feedPath: '/api/virtuals?sort[0]=createdAt%3Adesc&pagination[pageSize]={n}',
      idKeys: ['preToken', 'tokenAddress', 'address', 'attributes.preToken', 'attributes.tokenAddress'],
      parse: (pad, chain, raw, now) => {
        // Strapi-shaped: the fields live under `attributes`, and the id at the
        // top. Flatten before reading so the shared vocabularies still apply.
        const a = (raw && typeof raw.attributes === 'object' && raw.attributes) ? { ...raw.attributes, ...raw } : raw;
        const rec = common(blank(pad, chain, str(pick(a, ['preToken', 'tokenAddress', 'address']), 64)), a, now);
        rec.launchpad = 'Virtuals';
        const slug = str(pick(a, ['slug', 'symbol']), 60);
        if (slug) rec.launchUrl = 'https://app.virtuals.io/prototypes/' + slug;
        return curveState(rec, {
          graduated: bool(pick(a, ['graduated', 'isGraduated'])) ?? (str(pick(a, ['status']), 20) === 'AVAILABLE' ? true : null),
          progressApi: pick(a, ['progress', 'bondingProgress', 'virtualTokenValue']),
          progressDerived: null,
          migratedPool: str(pick(a, ['lpAddress', 'poolAddress']), 64),
        });
      },
    },
    {
      key: 'pons',
      label: 'Pons',
      chains: ['robinhood'],
      verified: false,
      covers: 'pons.fun (Robinhood Chain)',
      // WHY A ROBINHOOD PAD EXISTS AT ALL, when that chain already has an
      // on-chain launch signal.
      //
      // The Robinhood snipe discovers launches by filtering ONE factory address
      // (chains.js `factory`) for ONE `TokenCreated` signature. That is precise
      // and fast — and it is also blind to every launch that goes through a
      // DIFFERENT launchpad contract on the same chain. eth_getLogs answers an
      // unknown topic with an EMPTY ARRAY, so a second launchpad appearing on
      // Robinhood does not look like a missing feature: it looks like a quiet
      // chain, behind a green /health, which is exactly how this repo lost days
      // of Solana discovery once already.
      //
      // So the pad is a SECOND, INDEPENDENT way in — an HTTP feed that names the
      // token and its creator without knowing which contract minted it. It does
      // not replace the factory scan (that one is faster and needs no third
      // party); it covers what the factory scan cannot see.
      // ⚠️ THE HOST WAS A GUESS AND THE GUESS WAS WRONG. `pons.fun` and
      // `api.pons.fun` were invented from the pad's name; the launchpad is
      // actually served from **ponsfamily.com** (`/launchpad/<token>`), which
      // an operator's own screenshot settled after the first check reported
      // "can't reach api.pons.fun". The real host leads the list, the invented
      // ones stay behind it costing nothing — a base LIST is exactly so a
      // wrong first guess is a reorder, not a deploy.
      bases: ['https://www.ponsfamily.com/api', 'https://ponsfamily.com/api', 'https://api.ponsfamily.com', 'https://pons.fun/api'],
      // ⚠️ THE PATH IS STILL A GUESS, and the base list never covered that —
      // see `pathList` above. `ponsfamily.com/launchpad/<token>` is the PAGE an
      // operator screenshotted; what the page fetches behind it is not
      // published anywhere this session can reach (the host refuses this
      // sandbox's egress outright), so the spellings below are the plausible
      // ones for that page, tried in order and only on a 404. Whichever answers
      // is the one to pin with LAUNCHPAD_PONS_TOKEN_PATH — `launchpads:check`
      // on the box is the measurement, and it is a line in .env, not a deploy.
      tokenPaths: ['/launchpad/{id}', '/token/{id}', '/tokens/{id}', '/launchpad/token/{id}'],
      feedPath: '/launchpad/tokens?sort=created&order=desc&limit={n}',
      idKeys: ['address', 'tokenAddress', 'contractAddress', 'token.address', 'id'],
      parse: (pad, chain, raw, now) => {
        const rec = common(blank(pad, chain, str(pick(raw, ['address', 'tokenAddress', 'contractAddress', 'token.address']), 64)), raw, now);
        rec.launchpad = 'Pons';
        if (rec.address) rec.launchUrl = 'https://www.ponsfamily.com/launchpad/' + rec.address;
        return curveState(rec, {
          graduated: bool(pick(raw, ['graduated', 'isGraduated', 'migrated', 'completed', 'isCompleted', 'listed'])),
          progressApi: pick(raw, ['progress', 'progressPct', 'bondingProgress', 'curveProgress', 'bondingCurveProgress']),
          progressDerived: null,
          migratedPool: str(pick(raw, ['poolAddress', 'pairAddress', 'lpAddress', 'migratedPool']), 64),
        });
      },
    },
    {
      key: 'flap',
      label: 'Flap',
      chains: ['robinhood'],
      verified: false,
      covers: 'flap.sh / FlapLaunch (Robinhood Chain)',
      // The SECOND launchpad on Robinhood Chain, and it is here for the reason
      // the Pons row above is: the factory scan filters ONE address for ONE
      // signature, and `eth_getLogs` answers an unknown one with an EMPTY ARRAY.
      // So a launch on a pad nothing here knows about does not look like a
      // missing feature — it looks like a quiet chain, behind a green /health.
      // A token reported on this pad ($MACROHARD, 0x4e51…7777) rendered a live
      // price and a real market cap while the bot could say nothing at all
      // about its bonding curve.
      //
      // ⚠️ THE HOSTS AND BOTH PATHS ARE GUESSES, AND THE BASE LIST IS NOT
      // INSURANCE AGAINST THEM. Failover between bases is TRANSPORT-only — an
      // HTTP status means the host answered, and the same request gets the same
      // status everywhere else — so if `api.flap.sh` resolves and 404s we stop
      // there and never try the others. The list covers only a host that does
      // not resolve or does not connect. What makes a wrong guess cheap is the
      // env overrides: LAUNCHPAD_FLAP_API pins a base AND skips the list, and
      // LAUNCHPAD_FLAP_TOKEN_PATH / _FEED_PATH replace the paths, so a renamed
      // segment costs a line in .env rather than a deploy.
      //
      // This is exactly the state the Pons row was in — and there the researched
      // host WAS wrong, with `launchpads:check` on the box the thing that
      // settled it. `verified: false` says so out loud.
      bases: ['https://api.flap.sh', 'https://flap.sh/api', 'https://www.flap.sh/api'],
      tokenPath: '/token/{id}',
      // ⚠️ A DEFAULT IS REQUIRED, not optional: the builder below applies
      // LAUNCHPAD_<KEY>_FEED_PATH only to a pad that already HAS one
      // (`d.feedPath ? path(...) : null`). Shipping without a default would make
      // the env override silently do nothing, and turning the feed on later
      // would need a deploy — the whole thing these overrides exist to avoid.
      // It is also what puts this pad into the snipe's launch discovery and
      // into the watchdog's probe list.
      feedPath: '/tokens?sort=created&order=desc&limit={n}',
      idKeys: ['address', 'tokenAddress', 'contractAddress', 'token.address', 'id'],
      parse: (pad, chain, raw, now) => {
        const rec = common(blank(pad, chain, str(pick(raw, ['address', 'tokenAddress', 'contractAddress', 'token.address']), 64)), raw, now);
        rec.launchpad = 'Flap';
        if (rec.address) rec.launchUrl = 'https://flap.sh/token/' + rec.address;
        return curveState(rec, {
          graduated: bool(pick(raw, ['graduated', 'isGraduated', 'migrated', 'completed', 'isCompleted', 'listed'])),
          progressApi: pick(raw, ['progress', 'progressPct', 'bondingProgress', 'curveProgress', 'bondingCurveProgress']),
          progressDerived: null,
          // ⚠️ NEVER `migratedPool` FROM A GUESSED FIELD NAME ON A PAD THAT ALSO
          // REPORTS PROGRESS: `curveState` turns any non-empty value here into
          // `graduated: true`, which forces progressPct to 100, sets onCurve
          // false, outranks every other pad in the merge, and makes the snipe
          // skip the launch outright. A bonding token silently reclassified as
          // migrated is worse than one with no pool field at all, so only the
          // two unambiguous spellings are read.
          migratedPool: str(pick(raw, ['poolAddress', 'migratedPool']), 64),
        });
      },
    },
  ];

  return defs.map((d) => ({
    ...d,
    enabled: padOn(d.key),
    bases: basesFor(d.key, d.bases, d.aliases),
    // `tokenPaths` is what padToken walks; `tokenPath` stays the FIRST of them
    // so every existing reader (launchpads:check, the guard tests) keeps
    // reading the spelling that is actually tried first.
    tokenPaths: pathList(d.key, 'TOKEN', d.tokenPaths || [d.tokenPath]),
    tokenPath: pathList(d.key, 'TOKEN', d.tokenPaths || [d.tokenPath])[0],
    feedPath: d.feedPath ? path(d.key, 'FEED', d.feedPath) : null,
  }));
}

module.exports = {
  build, blank, common, curveState, rows, one, fill, padOn, basesFor, vol24,
  LIST_KEYS, ID_KEYS,
  _parsers: { pumpfunParse, jupiterParse },
};
