// pools.trade — the Robinhood Chain launchpad, as a discovery + autofill source.
//
// WHY THIS EXISTS
// Discovery for the auto-lister runs on DexScreener (dexscreener.js), and
// DexScreener does not index Robinhood Chain. Robinhood is a fully supported
// chain everywhere else in this repo — it has a listing package, a chain entry,
// a trade-bot engine and a bonding-curve path — but it could never be
// auto-discovered, because the one feed discovery reads has no Robinhood
// tokens in it. pools.trade is where Robinhood Chain launches actually happen,
// so it is the feed that closes that hole.
//
// Everything here is BEST-EFFORT and FAIL-OPEN. A pools.trade outage, a schema
// change, or an operator who never sets the env vars must degrade to "no
// Robinhood candidates this scan" — never to a thrown error that takes the
// whole auto-lister down with it. Every exported function swallows its own
// failures and returns [] / null, exactly like dexscreener.js does.
//
// THE ENDPOINT IS CONFIGURABLE ON PURPOSE
// pools.trade indexes through Uniswap's launches API, and that request shape is
// not published as a stable public contract. Rather than bake a guess into a
// code path the operator cannot fix without a deploy, every part of the request
// — base URL, RPC path, request body, and the response envelope's list key —
// is an env var, and the response parser accepts every plausible spelling of
// each field it needs. Run `npm run poolstrade:check` against the live API to
// see what actually comes back and which vars (if any) need setting.
const log = require("./helpers/logger");

const env = (k, d) => {
  const v = (process.env[k] || "").trim();
  return v || d;
};

// Connect-RPC style: POST <BASE>/<PATH> with a JSON body. Defaults target the
// Uniswap launches API that pools.trade itself reads.
const BASE = env("POOLS_TRADE_API", "https://interface.gateway.uniswap.org/v2").replace(/\/+$/, "");
const LIST_PATH = env("POOLS_TRADE_LIST_PATH", "data.v2.DataApiService/ListLaunches").replace(/^\/+/, "");
const CHAIN_ID = Number(env("POOLS_TRADE_CHAIN_ID", "4663"));
const CONTRACTS = env("POOLS_TRADE_CONTRACTS", "uniswap-cca,uniswap-bonding-curve")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const PAGE_SIZE = Math.min(500, Math.max(1, Number(env("POOLS_TRADE_PAGE_SIZE", "100")) || 100));
const MAX_PAGES = Math.min(20, Math.max(1, Number(env("POOLS_TRADE_MAX_PAGES", "3")) || 3));
const TIMEOUT_MS = Math.max(2000, Number(env("POOLS_TRADE_TIMEOUT_MS", "10000")) || 10000);

// Our chain id for everything pools.trade returns. It is a single-chain
// launchpad; if that ever changes, this becomes a map keyed on the response's
// chainId rather than a constant.
const OUR_CHAIN = env("POOLS_TRADE_OUR_CHAIN", "robinhood");

// Off only if the operator explicitly disables it. Unlike a money path, a
// read-only metadata feed that fails closed costs nothing but the tokens it
// would have found, so the safe default here is ON.
const ENABLED = env("POOLS_TRADE_ENABLED", "1") !== "0";

// The site, for the human-facing launch link on a listing card.
const SITE = env("POOLS_TRADE_SITE", "https://pools.trade").replace(/\/+$/, "");

// ── tolerant field extraction ────────────────────────────────────────────────
// The response schema is not a contract we control, so nothing below indexes a
// field by a single hard-coded name. `pick` walks a list of candidate paths and
// takes the first that resolves — which means a field renamed upstream, or
// nested one level deeper than expected, costs a one-line addition here instead
// of a silent null on every token.
function at(obj, path) {
  let cur = obj;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}

function pick(obj, paths) {
  for (const p of paths) {
    const v = at(obj, p);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

const str = (v) => {
  const s = v == null ? "" : String(v).trim();
  return s || null;
};

// Numbers arrive as numbers, as decimal strings, and (for on-chain amounts) as
// stringified integers. Only the first two are meaningful without knowing the
// decimals, so anything non-finite becomes null rather than NaN leaking into a
// market-cap comparison.
const num = (v) => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[, _]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// created-at shows up as ms epoch, as seconds epoch, and as ISO-8601. Seconds
// vs milliseconds is guessed by magnitude: anything below 1e11 is seconds
// (1e11 ms is the year 5138, 1e11 s is far past any plausible launch date).
function toMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d+$/.test(String(v).trim())) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

// A link set by whoever deployed the token ends up in an href on a public
// listing card and in a Telegram message. Only plain web links survive; a
// javascript:/data: URL is dropped, and so is anything Telegram would reject.
function safeUrl(v) {
  const s = str(v);
  if (!s || s.length > 300) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

// A bare handle ("@someproject") is common in launchpad metadata and is not a
// URL; turn it into one rather than dropping the only social a token has.
function socialUrl(v, base) {
  const s = str(v);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return safeUrl(s);
  const handle = s.replace(/^@/, "");
  return /^[A-Za-z0-9_.]{1,40}$/.test(handle) ? `${base}/${handle}` : null;
}

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/**
 * One raw launch record → the normalized shape the rest of the bot reads.
 * Returns null when the record has no usable contract address, which is the
 * only field nothing downstream can work without.
 */
function normalizeLaunch(raw) {
  if (!raw || typeof raw !== "object") return null;
  const address = str(
    pick(raw, [
      "address",
      "tokenAddress",
      "token_address",
      "contractAddress",
      "contract_address",
      "token.address",
      "token.id",
      "asset.address",
      "id",
    ]),
  );
  if (!address || !ADDRESS.test(address)) return null;

  // BELIEVE THE RECORD OVER OUR ASSUMPTION. Every launch is stamped `chain: OUR_CHAIN`
  // because the request asks for exactly one chain (CHAIN_ID) — but nothing guarantees
  // the API honours that filter, and POOLS_TRADE_BODY lets an operator replace the whole
  // request body, silently widening it. A token from another chain labelled `robinhood`
  // is not a cosmetic error: the auto-lister would publish it with Robinhood's explorer
  // and buy links, and the trade bot would look for it on a chain it does not exist on.
  // When the record says which chain it is on and that contradicts us, drop it.
  const declared = num(pick(raw, ["chainId", "chain_id", "chainID", "chain.id", "network.chainId", "token.chainId"]));
  if (declared != null && declared !== CHAIN_ID) return null;

  const priceUsd = num(pick(raw, ["priceUsd", "price_usd", "price.usd", "token.priceUsd", "usdPrice"]));
  const mcap = num(
    pick(raw, [
      "marketCapUsd",
      "market_cap_usd",
      "marketCap",
      "market_cap",
      "marketCap.usd",
      "fdvUsd",
      "fdv_usd",
      "fdv",
      "token.marketCap",
    ]),
  );
  const liq = num(
    pick(raw, ["liquidityUsd", "liquidity_usd", "liquidity.usd", "liquidity", "reserveUsd", "totalValueLockedUsd", "tvlUsd"]),
  );
  const vol24 = num(
    pick(raw, [
      "volume24hUsd",
      "volume_24h_usd",
      "volume24h",
      "volume.h24",
      "volume.usd24h",
      "volumeUsd24h",
      "stats.volume24h",
      "volume",
    ]),
  );
  const chg24 = num(pick(raw, ["priceChange24h", "price_change_24h", "priceChange.h24", "change24h", "stats.priceChange24h"]));
  const holders = num(pick(raw, ["holders", "holderCount", "holder_count", "stats.holders"]));

  // Bonding-curve state. `graduated` decides which venue the trade bot uses, so
  // an ambiguous answer must stay null (unknown) rather than default to false.
  const gradRaw = pick(raw, ["graduated", "isGraduated", "hasGraduated", "curve.graduated", "bondingCurve.graduated"]);
  const graduated = gradRaw === undefined ? null : Boolean(gradRaw);
  let progressPct = num(
    pick(raw, ["progressPct", "graduationProgress", "bondingCurveProgress", "curve.progressPct", "progress"]),
  );
  // A 0..1 fraction and a 0..100 percentage are both common spellings.
  if (progressPct != null && progressPct > 0 && progressPct <= 1) progressPct *= 100;
  if (progressPct != null) progressPct = Math.max(0, Math.min(100, progressPct));

  const website = safeUrl(pick(raw, ["links.website", "website", "metadata.website", "socials.website", "url"]));
  const twitter =
    socialUrl(pick(raw, ["links.twitter", "twitter", "links.x", "metadata.twitter", "socials.twitter", "twitterHandle"]), "https://x.com");
  const telegram =
    socialUrl(pick(raw, ["links.telegram", "telegram", "metadata.telegram", "socials.telegram", "telegramHandle"]), "https://t.me");

  return {
    source: "poolstrade",
    chain: OUR_CHAIN,
    address,
    name: str(pick(raw, ["name", "token.name", "metadata.name", "tokenName"])),
    symbol: str(pick(raw, ["symbol", "ticker", "token.symbol", "metadata.symbol", "tokenSymbol"])),
    logoUrl: safeUrl(pick(raw, ["logoUrl", "logo", "imageUrl", "image", "icon", "token.logoUrl", "metadata.image"])),
    priceUsd,
    mcap,
    liq,
    vol24,
    chg24,
    holders,
    createdAt: toMs(pick(raw, ["createdAt", "created_at", "launchedAt", "launch_time", "createdAtTimestamp", "timestamp", "blockTimestamp"])),
    graduated,
    progressPct,
    curve: str(pick(raw, ["curve", "curveAddress", "bondingCurve", "bondingCurveAddress", "pool", "poolAddress"])),
    website,
    twitter,
    telegram,
    launchUrl: `${SITE}/token/${address}`,
  };
}

// The list can sit at any of several keys depending on how the envelope is
// shaped; take the first key that holds a non-empty array, and accept a bare
// top-level array too.
const LIST_KEYS = env("POOLS_TRADE_LIST_KEY", "launches,tokens,items,data,results,pools,records")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function extractList(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== "object") return [];
  for (const k of LIST_KEYS) {
    const v = at(json, k);
    if (Array.isArray(v) && v.length) return v;
  }
  // Nothing matched by name — fall back to the first array-of-objects value at
  // the top level, which covers an envelope key we simply have not seen.
  for (const v of Object.values(json)) {
    if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
  }
  return [];
}

// The cursor for the next page, if the envelope carries one.
const nextCursor = (json) =>
  str(pick(json || {}, ["nextCursor", "next_cursor", "cursor", "page.nextCursor", "pageInfo.endCursor", "nextPageToken"]));

/**
 * Request body for one page. Overridable wholesale via POOLS_TRADE_BODY (JSON)
 * for the case where the real contract differs from the default below — the
 * cursor is then merged in under whichever key the response used.
 */
function buildBody(cursor) {
  const custom = env("POOLS_TRADE_BODY", "");
  let body;
  if (custom) {
    try {
      body = JSON.parse(custom);
    } catch (e) {
      log.warn(`[poolstrade] POOLS_TRADE_BODY is not valid JSON (${e.message}) — using the default body`);
      body = null;
    }
  }
  if (!body || typeof body !== "object") {
    body = { chainId: CHAIN_ID, contracts: CONTRACTS, pageSize: PAGE_SIZE };
  }
  return cursor ? { ...body, cursor } : body;
}

async function fetchPage(cursor) {
  const res = await fetch(`${BASE}/${LIST_PATH}`, {
    method: env("POOLS_TRADE_METHOD", "POST"),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(buildBody(cursor)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // ⚠️ CARRY THE BODY. This repo's own rule — "an HTTP error puts the
    // explanation in the response body" — and a bare `HTTP 409` is exactly the
    // shape it was written against: true, useless, and hiding whatever the
    // gateway actually objected to. Uniswap's is a private Connect-RPC gateway,
    // so its refusals name the header or field it wanted; that sentence is the
    // difference between one line in .env and another round of guessing.
    // Flattened and bounded — an HTML error page is not a message for a reader.
    const hint = await res
      .text()
      .then((t) => String(t).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160))
      .catch(() => "");
    throw new Error(`HTTP ${res.status}${hint ? `: ${hint}` : ""}`);
  }
  return res.json();
}

/**
 * Every launch pools.trade knows about, normalized and de-duplicated by
 * address. Paginates up to POOLS_TRADE_MAX_PAGES; stops early when a page
 * returns no cursor or no rows.
 *
 * Never throws — an unreachable API is an empty list.
 * @returns {Promise<Array<object>>}
 */
async function fetchLaunches(status = {}) {
  // ⚠️ `status` carries WHY there are no rows, because "it answered with
  // nothing" and "it did not answer" are different facts and this function
  // returned the same `[]` for both — at debug level, which production does not
  // print. On the operator's own box `listing:check` printed
  // `⚠ pools.trade → 0 candidate(s)`, and nothing anywhere could say whether
  // that was a quiet launchpad, a retired host, or POOLS_TRADE_ENABLED=0. Same
  // rule the DexScreener feeds had to learn one module over; `discovery.js` even
  // asserted in a comment that this one could only fail by THROWING, which was
  // simply untrue — the catch is right here.
  status.ok = true;
  status.why = null;
  if (!ENABLED) {
    status.ok = false;
    status.why = "POOLS_TRADE_ENABLED=0 — the launchpad feed is switched off";
    return [];
  }
  const out = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let json;
    try {
      json = await fetchPage(cursor);
    } catch (e) {
      // A first-page failure is the whole feed being down; a later-page failure
      // still leaves the rows we already have, which are worth keeping.
      const why = `${e.message}${e.cause && e.cause.code ? ` (${e.cause.code})` : ""}`;
      log.debug(`[poolstrade] page ${page + 1}: ${why}`);
      // Only the FIRST page failing means we learned nothing. Losing page three
      // is a shorter list, not an outage.
      if (page === 0) {
        status.ok = false;
        status.why = why;
      }
      break;
    }
    const rows = extractList(json);
    if (!rows.length) break;
    for (const raw of rows) {
      const rec = normalizeLaunch(raw);
      if (!rec) continue;
      const key = rec.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rec);
    }
    cursor = nextCursor(json);
    if (!cursor) break;
  }
  return out;
}

// Launch records are reused within a scan (discovery, then per-token autofill),
// and the whole point of a short TTL here is that one auto-lister cycle costs
// one round trip instead of one per candidate.
const CACHE_TTL_MS = Math.max(0, Number(env("POOLS_TRADE_CACHE_MS", "60000")) || 60000);
let _cache = { at: 0, rows: null };

async function cachedLaunches(status = {}) {
  if (_cache.rows && Date.now() - _cache.at < CACHE_TTL_MS) {
    status.ok = true;
    status.why = null;
    return _cache.rows;
  }
  const rows = await fetchLaunches(status);
  // Only a non-empty result refreshes the cache: caching an empty list after a
  // transient failure would blind every caller for the whole TTL.
  if (rows.length) _cache = { at: Date.now(), rows };
  else if (!_cache.rows) _cache = { at: Date.now(), rows: [] };
  return rows.length ? rows : _cache.rows || [];
}

/**
 * Discovery candidates in the shape dexscreener.fetchDiscovery returns, so the
 * auto-lister can merge the two feeds without knowing where a candidate came
 * from.
 * @returns {Promise<Array<{chain: string, address: string}>>}
 */
async function fetchDiscovery() {
  return (await fetchDiscoveryX()).items;
}

/** The same list, with the reason when it is empty. See fetchLaunches. */
async function fetchDiscoveryX() {
  const status = {};
  const rows = await cachedLaunches(status);
  return {
    items: rows.map((r) => ({ chain: r.chain, address: r.address })),
    ok: status.ok !== false,
    why: status.why || null,
  };
}

/**
 * Token record in the shape dexscreener.fetchTokenInfo returns, so listing
 * autofill and the auto-lister's pricing step work on a pools.trade token
 * unchanged. Returns null for any chain other than ours, or any address the
 * launchpad does not know — both of which let the caller fall through to
 * DexScreener/GeckoTerminal.
 */
async function fetchTokenInfo(chain, address) {
  if (chain !== OUR_CHAIN) return null;
  const want = String(address || "").toLowerCase();
  if (!want) return null;
  const rows = await cachedLaunches();
  const r = rows.find((x) => x.address.toLowerCase() === want);
  if (!r) return null;
  // Field names and zero-vs-null conventions match dexscreener.fetchTokenInfo
  // exactly — autoLister.rejectReason reads `liq`, `vol24` and `pairCreatedAt`
  // by those names and treats 0 as "no data", so a null here would read as a
  // passing score on a gate the operator set.
  return {
    name: r.name,
    symbol: r.symbol,
    priceUsd: r.priceUsd,
    mcap: r.mcap,
    logoUrl: r.logoUrl,
    website: r.website,
    twitter: r.twitter,
    telegram: r.telegram,
    liq: Number(r.liq) || 0,
    vol24: Number(r.vol24) || 0,
    change24h: Number(r.chg24) || 0,
    pairCreatedAt: Number(r.createdAt) || 0,
    pairCount: 1,
    // pools.trade-only extras; ignored by callers that do not know them.
    graduated: r.graduated,
    progressPct: r.progressPct,
    holders: r.holders,
    launchUrl: r.launchUrl,
    source: "poolstrade",
  };
}

module.exports = {
  fetchLaunches,
  fetchDiscovery,
  fetchDiscoveryX,
  fetchTokenInfo,
  OUR_CHAIN,
  ENABLED,
  _test: { normalizeLaunch, extractList, buildBody, toMs, safeUrl, socialUrl, num, pick },
};
