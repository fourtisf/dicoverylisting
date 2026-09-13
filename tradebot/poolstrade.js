'use strict';
/*
 * pools.trade — the launchpad record for Robinhood Chain tokens.
 *
 * WHAT THIS IS FOR
 * tokeninfo.js has always had a "launchpad API" leg: on a curve chain it asks
 * the launchpad for the things no generic indexer knows — the project's socials,
 * its total volume, when it launched. That leg pointed at robinfun.io, the
 * launchpad this bot was originally built against. pools.trade is where
 * Robinhood Chain tokens actually launch now, so this module is that source.
 *
 * WHAT THIS IS NOT FOR — READ BEFORE EXTENDING
 * Nothing here ever touches the money path. A buy or a sell is priced, routed
 * and signed entirely from chain state in core.js: the bonding-curve contract
 * while a token is on the curve, the V2/V3 router once it has graduated. This
 * module supplies DISPLAY METADATA and nothing else, and every field it returns
 * is optional to every caller.
 *
 * That split is deliberate and it is the reason this file can afford to be
 * relaxed about an API whose schema we do not control. An HTTP source that is
 * wrong, stale or hostile can make a card show a stale market cap; it must
 * never be able to change what a trade does, how much it spends, or where the
 * tokens go. If you are ever tempted to read a price, a route, a slippage bound
 * or a graduation flag from here and act on it, don't — read it from the chain.
 * (`graduated` below is carried for the CARD only; core.js decides the real
 * venue with an on-chain `graduated()` call, and must keep doing so.)
 *
 * Fail-open like everything else in tokeninfo.js: every export swallows its own
 * errors and returns null. A pools.trade outage costs a socials row on a card.
 */
const env = (k, d) => { const v = (process.env[k] || '').trim(); return v || d; };

// Connect-RPC style: POST <BASE>/<PATH> with a JSON body. The defaults target
// the Uniswap launches API that pools.trade itself indexes. Every part is an
// env var because that request shape is not a published stable contract —
// run `npm run poolstrade:check` in bot/ to see what the live API returns and
// which of these (if any) need setting for your deployment.
const BASE = env('POOLS_TRADE_API', 'https://interface.gateway.uniswap.org/v2').replace(/\/+$/, '');
const LIST_PATH = env('POOLS_TRADE_LIST_PATH', 'data.v2.DataApiService/ListLaunches').replace(/^\/+/, '');
const CHAIN_ID = Number(env('POOLS_TRADE_CHAIN_ID', '4663'));
const CONTRACTS = env('POOLS_TRADE_CONTRACTS', 'uniswap-cca,uniswap-bonding-curve')
  .split(',').map((s) => s.trim()).filter(Boolean);
const PAGE_SIZE = Math.min(500, Math.max(1, Number(env('POOLS_TRADE_PAGE_SIZE', '100')) || 100));
const MAX_PAGES = Math.min(20, Math.max(1, Number(env('POOLS_TRADE_MAX_PAGES', '3')) || 3));
const TIMEOUT_MS = Math.max(2000, Number(env('POOLS_TRADE_TIMEOUT_MS', '6000')) || 6000);
const SITE = env('POOLS_TRADE_SITE', 'https://pools.trade').replace(/\/+$/, '');
const ENABLED = env('POOLS_TRADE_ENABLED', '1') !== '0';

// Which of our chain keys pools.trade covers. Only tokens on this chain are
// ever looked up here.
const OUR_CHAIN = env('POOLS_TRADE_OUR_CHAIN', 'robinhood');

// ── tolerant extraction ──────────────────────────────────────────────────────
// Same reasoning as bot/src/poolstrade.js: the schema is not ours, so no field
// is read by a single hard-coded name.
function at(obj, path) {
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}
function pick(obj, paths) {
  for (const p of paths) { const v = at(obj, p); if (v !== undefined && v !== null && v !== '') return v; }
  return undefined;
}
const str = (v) => { const s = v == null ? '' : String(v).trim(); return s || null; };
const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[, _]/g, ''));
  return Number.isFinite(n) ? n : null;
};
// ms epoch / s epoch / ISO-8601. Below 1e11 is seconds (1e11 ms is the year 5138).
function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v).trim())) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

// These strings end up inside an href in a Telegram message. A javascript: or
// data: URL has no business there, and a malformed one makes Telegram reject
// the whole message — which would take the live monitor down over a field a
// stranger controls. Mirrors tokeninfo._safeUrl deliberately.
function safeUrl(v) {
  const s = str(v);
  if (!s || s.length > 300) return null;
  try { const u = new URL(s); return (u.protocol === 'http:' || u.protocol === 'https:') ? s : null; }
  catch (_) { return null; }
}
function socialUrl(v, base) {
  const s = str(v);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return safeUrl(s);
  const h = s.replace(/^@/, '');
  return /^[A-Za-z0-9_.]{1,40}$/.test(h) ? `${base}/${h}` : null;
}

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/** One raw launch → the record shape tokeninfo/telegram read (`info.api`). */
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const address = str(pick(raw, [
    'address', 'tokenAddress', 'token_address', 'contractAddress', 'contract_address',
    'token.address', 'token.id', 'asset.address', 'id',
  ]));
  if (!address || !ADDRESS.test(address)) return null;

  // A record that names a chain other than the one we asked for is not ours. The trade
  // bot only ever looks this up for OUR_CHAIN, so a mislabelled foreign token would put
  // another chain's name, socials and market cap on a Robinhood token's trade card —
  // right above live Buy buttons. Drop it rather than display it. (See the same guard in
  // bot/src/poolstrade.js for why the request's own filter is not enough.)
  const declared = num(pick(raw, ['chainId', 'chain_id', 'chainID', 'chain.id', 'network.chainId', 'token.chainId']));
  if (declared != null && declared !== CHAIN_ID) return null;

  const website = safeUrl(pick(raw, ['links.website', 'website', 'metadata.website', 'socials.website', 'url']));
  const twitter = socialUrl(pick(raw, ['links.twitter', 'twitter', 'links.x', 'metadata.twitter', 'socials.twitter', 'twitterHandle']), 'https://x.com');
  const telegram = socialUrl(pick(raw, ['links.telegram', 'telegram', 'metadata.telegram', 'socials.telegram', 'telegramHandle']), 'https://t.me');

  const gradRaw = pick(raw, ['graduated', 'isGraduated', 'hasGraduated', 'curve.graduated', 'bondingCurve.graduated']);
  let progressPct = num(pick(raw, ['progressPct', 'graduationProgress', 'bondingCurveProgress', 'curve.progressPct', 'progress']));
  if (progressPct != null && progressPct > 0 && progressPct <= 1) progressPct *= 100;
  if (progressPct != null) progressPct = Math.max(0, Math.min(100, progressPct));

  return {
    address,
    name: str(pick(raw, ['name', 'token.name', 'metadata.name', 'tokenName'])),
    symbol: str(pick(raw, ['symbol', 'ticker', 'token.symbol', 'metadata.symbol', 'tokenSymbol'])),
    marketCapUsd: num(pick(raw, ['marketCapUsd', 'market_cap_usd', 'marketCap', 'market_cap', 'marketCap.usd', 'fdvUsd', 'fdv_usd', 'fdv'])),
    priceUsd: num(pick(raw, ['priceUsd', 'price_usd', 'price.usd', 'usdPrice'])),
    volume: {
      h24Usd: num(pick(raw, ['volume24hUsd', 'volume_24h_usd', 'volume24h', 'volume.h24', 'volumeUsd24h', 'stats.volume24h'])),
      totalUsd: num(pick(raw, ['volumeTotalUsd', 'totalVolumeUsd', 'volume.total', 'volumeAllTime', 'stats.volumeTotal'])),
    },
    createdAt: toMs(pick(raw, ['createdAt', 'created_at', 'launchedAt', 'launch_time', 'createdAtTimestamp', 'timestamp', 'blockTimestamp'])),
    holders: num(pick(raw, ['holders', 'holderCount', 'holder_count', 'stats.holders'])),
    // DISPLAY ONLY — see the file header. core.js decides the venue on-chain.
    graduated: gradRaw === undefined ? null : Boolean(gradRaw),
    progressPct,
    links: { website, twitter, telegram },
    launchUrl: `${SITE}/token/${address}`,
    source: 'poolstrade',
  };
}

const LIST_KEYS = env('POOLS_TRADE_LIST_KEY', 'launches,tokens,items,data,results,pools,records')
  .split(',').map((s) => s.trim()).filter(Boolean);

function extractList(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  for (const k of LIST_KEYS) { const v = at(json, k); if (Array.isArray(v) && v.length) return v; }
  for (const v of Object.values(json)) { if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v; }
  return [];
}
const nextCursor = (json) => str(pick(json || {}, ['nextCursor', 'next_cursor', 'cursor', 'page.nextCursor', 'pageInfo.endCursor', 'nextPageToken']));

function buildBody(cursor) {
  const custom = env('POOLS_TRADE_BODY', '');
  let body = null;
  if (custom) { try { body = JSON.parse(custom); } catch (_) { body = null; } }
  if (!body || typeof body !== 'object') body = { chainId: CHAIN_ID, contracts: CONTRACTS, pageSize: PAGE_SIZE };
  return cursor ? { ...body, cursor } : body;
}

async function fetchPage(cursor) {
  const res = await fetch(`${BASE}/${LIST_PATH}`, {
    method: env('POOLS_TRADE_METHOD', 'POST'),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(buildBody(cursor)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Every launch pools.trade knows, normalized. Never throws — [] on failure. */
async function fetchLaunches() {
  if (!ENABLED) return [];
  const out = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let json;
    try { json = await fetchPage(cursor); } catch (_) { break; }
    const rows = extractList(json);
    if (!rows.length) break;
    for (const raw of rows) {
      const rec = normalize(raw);
      if (!rec) continue;
      const k = rec.address.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(rec);
    }
    cursor = nextCursor(json);
    if (!cursor) break;
  }
  return out;
}

// The live monitor re-renders a card on a timer, so an uncached lookup here
// would be paid on every refresh of every open card — the same reasoning that
// put a cache in front of tokeninfo.socials. Launch metadata barely changes.
const CACHE_TTL_MS = Math.max(0, Number(env('POOLS_TRADE_CACHE_MS', '60000')) || 60000);
let _cache = { at: 0, rows: null };

async function cachedLaunches() {
  if (_cache.rows && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.rows;
  const rows = await fetchLaunches();
  // A transient failure must not blind every caller for the whole TTL, so only
  // a non-empty result refreshes the cache.
  if (rows.length) _cache = { at: Date.now(), rows };
  else if (!_cache.rows) _cache = { at: Date.now(), rows: [] };
  return rows.length ? rows : (_cache.rows || []);
}

/**
 * The launchpad record for one contract, or null if pools.trade does not know
 * it (a Robinhood token deployed outside the launchpad, or the API being down).
 * Callers must treat null as "no extra metadata", never as "bad token".
 */
async function tokenRecord(ca, chainKey) {
  if (chainKey !== undefined && chainKey !== OUR_CHAIN) return null;
  const want = String(ca || '').toLowerCase();
  if (!ADDRESS.test(want)) return null;
  try {
    const rows = await cachedLaunches();
    return rows.find((r) => r.address.toLowerCase() === want) || null;
  } catch (_) { return null; }
}

module.exports = {
  fetchLaunches, tokenRecord, OUR_CHAIN, ENABLED, SITE,
  _test: { normalize, extractList, buildBody, toMs, safeUrl, socialUrl, pick },
};
