'use strict';
/*
 * THE BIGGEST TOKENS ON A CHAIN, from DexScreener.
 *
 * "add pakai api dexscrener aja" — GeckoTerminal's free ceiling is ~30 req/min
 * for the whole IP and the running bot is already on it, so `seed:chain` spent
 * twelve minutes on BSC page 4 waiting out one 429 after another. DexScreener
 * needs no key and publishes a far higher ceiling, so the seeding read stops
 * competing with the buy bot for the one quota that pauses buy alerts.
 *
 * ⚠️ IT CANNOT BE ASKED THE SAME QUESTION. `dexscreener.js` says so at the top
 * and it is still true: there is no "every token above $X market cap on chain
 * Y" endpoint, and no pool listing to paginate the way GT's
 * /networks/{net}/pools does. So this asks two questions it CAN answer and
 * merges the answers:
 *
 *   1. SEARCH for the chain's own quote tokens (`?q=WBNB`). Nearly every pair
 *      on a chain is quoted in its native wrapper or a major stable, so the
 *      search results are that chain's deepest pairs — and the BASE side of a
 *      deep pair is the project. Each hit already carries price, market cap,
 *      liquidity, volume, the logo and the socials, so enumerating costs one
 *      request per query and pricing costs nothing.
 *   2. The DISCOVERY FEEDS this repo already reads (token profiles, boosted),
 *      filtered to the chain and priced 30 addresses at a time — /tokens/
 *      takes a comma-separated batch, which is the cheapest pricing this API
 *      offers.
 *
 * Search is the bulk and the feeds are the top-up, because a search result is
 * ranked by the thing we actually want (depth) while a boost is ranked by who
 * paid.
 *
 * SAME CONTRACT AS `bigCoins.topByMcap`: `{ ok, why, items }`, never throws,
 * and **`ok:false` is not an empty chain**. Same item shape too, so
 * `chainSeed` can be pointed at either source without knowing which.
 */
const { CHAINS } = require('../config/chains');
const { DS_CHAIN, DISCOVERY_FEEDS } = require('../dexscreener');
const { notAProject } = require('./bigCoins');
const log = require('../helpers/logger');

const SEARCH = 'https://api.dexscreener.com/latest/dex/search';
const TOKENS = 'https://api.dexscreener.com/latest/dex/tokens/';
const TIMEOUT_MS = 10_000;
// DexScreener publishes a far higher ceiling than GeckoTerminal and needs no
// key. A small gap anyway: this is a bulk read on somebody else's free API,
// and the whole reason we are here is that the last one was pushed too hard.
const GAP_MS = 250;
// /latest/dex/tokens/ takes a comma-separated batch. Thirty is the documented
// maximum; asking for more silently truncates, which would look like tokens
// that cannot be priced.
const BATCH = 30;

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const snum = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * WHAT TO SEARCH FOR, per chain.
 *
 * A TABLE, and every entry is env-overridable (`DS_SEED_QUERIES_BSC=...`) —
 * the same contract the launchpad registry has, and for the same reason: these
 * are not published request shapes, they are guesses about which ticker sits
 * on the other side of most pairs. A chain whose guess is poor costs a line in
 * .env, not a deploy.
 */
const QUERIES = {
  bsc: ['WBNB', 'USDT', 'BUSD', 'CAKE'],
  base: ['WETH', 'USDC', 'cbBTC', 'AERO'],
  ethereum: ['WETH', 'USDT', 'USDC', 'DAI'],
  solana: ['SOL', 'USDC', 'USDT'],
  // ⚠️ TRON needed its OWN entry, and it is the reason `PER_CHAIN` below
  // exists. It came back "only 0 of the 150 needed are new — 9 already
  // listed", because the shared vocabulary is English memecoin naming (PEPE,
  // WOJAK, FLOKI) and Tron's ecosystem is not that: it is SUN, JST, BTT, WIN,
  // SUNDOG, APENFT. A net woven for one chain's culture catches nothing on
  // another's, and the failure looks identical to a chain with no tokens.
  tron: ['WTRX', 'TRX', 'USDT', 'USDD', 'SUN', 'JST', 'BTT', 'WIN', 'NFT'],
  polygon: ['WMATIC', 'WPOL', 'USDC', 'WETH'],
  arbitrum: ['WETH', 'USDC', 'ARB'],
  optimism: ['WETH', 'USDC', 'OP'],
  avalanche: ['WAVAX', 'USDC', 'USDT'],
};

/** Vocabulary that only makes sense on ONE chain, appended after the shared
 *  list. Same reasoning as the quote tokens: what a chain's tokens are NAMED
 *  after is a property of that chain, not of crypto. */
const PER_CHAIN_VOCAB = {
  tron: ['SUNDOG', 'SUNCAT', 'SUNWUKONG', 'TRON', 'JUSTIN', 'APENFT', 'STARK'],
  solana: ['BONK', 'PUMP', 'JUP', 'RAY', 'FART'],
  base: ['DEGEN', 'BRETT', 'TOSHI', 'CLANKER', 'HIGHER'],
  bsc: ['BNB', 'FOUR', 'BROCCOLI', 'MUBARAK', 'PALU'],
  robinhood: ['ROBIN', 'HOOD', 'PONS'],
};

/*
 * …AND A SHARED VOCABULARY, because quote tokens alone are not an enumeration.
 *
 * The first live run listed 82 tokens across 22 chains and BSC gained five.
 * Four quote-token queries return the same few dozen deep pairs on a chain, and
 * on a chain with listings already those are exactly the ones we HAVE. The
 * search endpoint matches names and symbols, so a wider vocabulary reaches
 * different tokens rather than the same ones ranked differently.
 *
 * Deliberately generic and chain-agnostic — this is a net, not a curated list,
 * and a term that matches nothing costs one request out of a 300/min budget.
 * The `$1M` floor and the stables-and-wrappers filter still decide what is
 * actually listable, so a silly term cannot put junk on the site.
 */
const VOCAB = [
  'PEPE', 'DOGE', 'SHIB', 'INU', 'CAT', 'BONK', 'WIF', 'MOON', 'BABY', 'ELON',
  'TRUMP', 'FLOKI', 'CHAD', 'WOJAK', 'GROK', 'APE', 'FROG', 'BULL', 'MEME',
];
/*
 * ⚠️ DICTIONARY WORDS WERE REMOVED FROM THIS LIST, and the reason is on the
 * board: the first `--apply` run listed `$SAFE`, `$AI`, `$SWAP`, `$DAO`,
 * `$GOLD`, `$KING`, `$ROCKET` — one per term, across three chains, none with a
 * logo anywhere. Searching a generic English word returns whatever junk was
 * named after it, because that is what a scam names itself.
 *
 * What survives names something REAL — a memecoin lineage a copycat is imitating
 * rather than a word a copycat picked. Copycats still come back on those terms;
 * the logo requirement is what removes them, and it removes these too. This
 * list is about not paying for the requests.
 */

/** The queries for a chain: env first, then quote tokens + the shared
 *  vocabulary, then a generic guess built from the chain's own native symbol —
 *  never nothing, because a chain with no entry would be silently unseedable.
 *
 *  Quote tokens come FIRST: they return the chain's deepest pairs, which is
 *  what a "biggest tokens" read is actually asking for. The vocabulary is the
 *  long tail behind them, and `topByMcap` stops early once it has enough. */
function queriesFor(chain, { vocab = true } = {}) {
  const env = String(process.env[`DS_SEED_QUERIES_${String(chain).toUpperCase()}`] || '').trim();
  if (env) return env.split(',').map((q) => q.trim()).filter(Boolean);
  const native = (CHAINS[chain] && CHAINS[chain].native) || '';
  const quotes = QUERIES[chain] || [...new Set([native && `W${native}`, native, 'USDT', 'USDC'].filter(Boolean))];
  return vocab ? [...new Set([...quotes, ...VOCAB, ...(PER_CHAIN_VOCAB[chain] || [])])] : quotes;
}

async function getJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    // 429 here is a per-request answer, not a process-wide verdict: unlike
    // GeckoTerminal there is no shared cooldown to arm, and the next query is
    // worth trying. Reported, never thrown.
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (e) {
    return { ok: false, why: (e && e.message) || 'request failed' };
  }
}

/** One DexScreener pair → the candidate shape `chainSeed` lists from. */
function itemOf(chain, p) {
  const base = (p && p.baseToken) || {};
  if (!base.address || !base.symbol) return null;
  const info = (p && p.info) || {};
  const socials = info.socials || [];
  const tw = socials.find((s) => /twitter|^x$/i.test(s.type || ''));
  const tg = socials.find((s) => /telegram/i.test(s.type || ''));
  const web = Array.isArray(info.websites) && info.websites.length ? info.websites[0] : null;
  return {
    chain,
    address: base.address,
    symbol: base.symbol,
    name: base.name || base.symbol,
    logoUrl: info.imageUrl || null,
    // `marketCap` is DexScreener's own; `fdv` is the documented stand-in, and
    // is what the rest of this repo already falls back to.
    mcap: num(p.marketCap) || num(p.fdv),
    liq: num(p.liquidity && p.liquidity.usd) || 0,
    vol24: num(p.volume && p.volume.h24) || 0,
    change24h: snum(p.priceChange && p.priceChange.h24),
    priceUsd: num(p.priceUsd),
    website: (web && web.url) || null,
    twitter: (tw && tw.url) || null,
    telegram: (tg && tg.url) || null,
    // A pair that already carried a logo AND a link needs no second lookup —
    // the enrichment call would ask DexScreener the same question again, once
    // per token.
    enriched: !!(info.imageUrl && (tw || web)),
  };
}

/** Merge one pair into the by-token map, keeping the DEEPEST pool for each
 *  token. A real token seen through a thin pool reads as illiquid, which is
 *  the rule `bigCoins` follows one source over. */
function absorbPair(best, chain, p) {
  const it = itemOf(chain, p);
  if (!it) return;
  const k = it.address.toLowerCase();
  const prev = best.get(k);
  if (!prev || (it.liq || 0) > (prev.liq || 0)) best.set(k, it);
}

/**
 * The chain's biggest tokens, market cap first.
 *
 * `minLiq` defaults to 0 on purpose here — "min mc 1 juta gada vol dll". A cap
 * with no depth behind it is a real hazard (a $1M "market cap" printed on $300
 * of liquidity is a thing this repo has warned about since the auto-lister was
 * written), so the caller can still set a floor; it is simply not imposed.
 */
async function topByMcap(chain, { limit = 60, minMcap = 1_000_000, minLiq = 0, feeds = true, vocab = true, probe = null } = {}) {
  const dsChain = DS_CHAIN[chain];
  // A chain DexScreener does not index cannot be asked at all, and saying so
  // is the difference between "nothing qualifies" and "we never looked".
  if (!dsChain) return { ok: false, why: `no DexScreener chain id for ${chain}`, items: [] };

  const best = new Map(); // address (lower) → the deepest pair we have for it
  const wanted = new Map(); // address (lower) → address, awaiting a price
  let asked = 0;
  let why = null;
  const step = (name, n) => probe && probe({ chain, step: name, count: n });

  // ── Phase 1: ENUMERATE ────────────────────────────────────────────────────
  //
  // ⚠️ BOTH SIDES OF EVERY PAIR, and this is the whole reason the first cut
  // found almost nothing (bsc 1, base 1, ethereum 0). Searching `q=WETH`
  // returns pairs OF WETH, and DexScreener puts the searched token on the BASE
  // side — so every result was WETH/USDC-shaped, `notAProject` correctly
  // dropped the base, and the project sitting on the QUOTE side was thrown
  // away with it. The base side is free data when it is a project; the quote
  // side is an ADDRESS worth pricing.
  for (const q of queriesFor(chain, { vocab: vocab !== false })) {
    // Stop once there is plainly enough to work with. The vocabulary is a long
    // tail behind the quote tokens, and a chain that filled from the first few
    // queries should not spend thirty requests proving it.
    if (best.size + wanted.size >= limit * 3) break;
    const res = await getJson(`${SEARCH}?q=${encodeURIComponent(q)}`);
    if (!res.ok) {
      why = res.why;
      continue; // one bad query must not cost the others
    }
    asked++;
    for (const p of (res.body && res.body.pairs) || []) {
      if (!p || p.chainId !== dsChain) continue; // search answers across ALL chains
      absorbPair(best, chain, p);
      for (const side of [p.baseToken, p.quoteToken]) {
        const a = side && side.address;
        if (!a || notAProject(side.symbol, side.name)) continue;
        const k = a.toLowerCase();
        if (!best.has(k)) wanted.set(k, a);
      }
    }
    await sleep(GAP_MS);
  }
  step('search', best.size + wanted.size);

  // The discovery feeds this repo already reads. Ranked by who PAID for a
  // boost rather than by depth, so they top up rather than lead.
  if (feeds) {
    for (const a of await feedAddresses(chain)) {
      const k = a.toLowerCase();
      if (!best.has(k)) wanted.set(k, a);
    }
    step('feeds', wanted.size);
  }

  // ── Phase 2: PRICE ────────────────────────────────────────────────────────
  //
  // /tokens/ takes a comma-separated BATCH and answers with each token on the
  // base side, which is the only way a quote-side address gets a market cap of
  // its own — the pair it was found in reports the cap of the OTHER token.
  const todo = [...wanted.values()];
  for (let i = 0; i < todo.length; i += BATCH) {
    const res = await getJson(TOKENS + todo.slice(i, i + BATCH).map(encodeURIComponent).join(','));
    if (!res.ok) {
      why = res.why;
      break;
    }
    asked++;
    for (const p of (res.body && res.body.pairs) || []) {
      if (p && p.chainId === dsChain) absorbPair(best, chain, p);
    }
    await sleep(GAP_MS);
  }
  step('priced', best.size);

  const items = [...best.values()]
    .filter((t) => t.mcap)
    // The pool's other side wearing a market cap — WETH, USDC, a staking
    // receipt. One owner for that judgement, shared with the GT source.
    .filter((t) => !notAProject(t.symbol, t.name))
    .filter((t) => t.mcap >= minMcap && (t.liq || 0) >= minLiq)
    .sort((a, b) => b.mcap - a.mcap)
    .slice(0, limit);
  step('qualified', items.length);

  if (why) log.debug(`[dsbigcoins] ${chain}: ${asked} read(s), last failure — ${why}`);
  // ok is "something answered", never "everything answered" — a chain read
  // through three of four queries is a real answer, and the fourth's failure
  // is carried in `why` rather than thrown away.
  return { ok: asked > 0, why, items, pagesRead: asked, nextPage: null };
}

/** Addresses on this chain from the discovery feeds the repo already reads. */
async function feedAddresses(chain) {
  const dsChain = DS_CHAIN[chain];
  const out = [];
  const seen = new Set();
  for (const url of DISCOVERY_FEEDS) {
    const res = await getJson(url);
    if (!res.ok) continue;
    for (const it of Array.isArray(res.body) ? res.body : []) {
      const a = String((it && it.tokenAddress) || '').trim();
      if (!a || String(it.chainId) !== dsChain || seen.has(a.toLowerCase())) continue;
      seen.add(a.toLowerCase());
      out.push(a);
    }
    await sleep(GAP_MS);
  }
  return out;
}

module.exports = { topByMcap, queriesFor, QUERIES, VOCAB, PER_CHAIN_VOCAB, _itemOf: itemOf };
