// Real "Top Gainers" data — the feed behind the @dexvraadminbot banner generator.
//
// The banner is a PUBLIC leaderboard with percentages on it, so the one rule this
// module enforces is: every number comes from a live source, or the token is not
// on the board. There is no seed data, no "last known" figure and no synthesised
// percentage anywhere in here — a token whose 24h change cannot be read is
// dropped, and if nothing can be read the caller is told to post nothing.
//
// Two sources, in order:
//
//   1. THE SITE BOARD (`GET {DEXVRA_API_BASE}/api/tokens`) — literally the rows
//      dexvra.io renders, already merged with live market data and cached ~30s
//      by the web process. Rows carry `source: "live" | "seed"`; only "live" is
//      accepted here, which is what keeps the site's fallback demo listings
//      (SEED_ROWS in src/lib/listings.ts — real addresses, FROZEN figures) from
//      ever reaching a channel post.
//
//   2. BOT-SIDE (internal listings API + marketdata.fetchMarket) — used when the
//      web process is unreachable or its board has nothing live. Slower (one
//      market lookup per listing, rate-limited) but it depends on nothing but
//      the same GeckoTerminal/DexScreener sources the rest of the bot uses.
//
// Nothing here throws at the caller: a dead source yields an empty list plus a
// `notes` array explaining why, which the admin panel shows verbatim.
const { DEXVRA_API_BASE, SITE_URL } = require("./config/constants");
const api = require("./api/dexvra");
const market = require("./marketdata");
const dexscreener = require("./dexscreener");
const { CHAINS, chainOf, isValidAddress } = require("./config/chains");
const { fmtCap, fmtPct } = require("./helpers/format");
const log = require("./helpers/logger");

const UA = "Mozilla/5.0 (compatible; DexvraGainers/1.0)";
const BOARD_TIMEOUT_MS = 12000;
const LOGO_TIMEOUT_MS = 10000;
// How many approved listings the bot-side path is willing to price in one build,
// and how many of those lookups run at once. Both bounded on purpose: this runs
// on an admin tap and on a daily timer, and GeckoTerminal's free API rate-limits.
const PROBE_CAP = 60;
const PROBE_CONCURRENCY = 4;
// A 24h change beyond this is broken pool data, not a market move (a pool created
// hours ago compares against a near-zero opening tick). marketdata already drops
// these on its own path; the board path needs the same floor.
const SANE_PCT = market.SANE_CHANGE_PCT;
const MAX_SLOTS = 10; // the widest template; also the caption's rank-badge range

// ── small utilities ─────────────────────────────────────────────────────────
const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const pos = (x) => {
  const n = num(x);
  return n != null && n > 0 ? n : null;
};

// Characters a ticker may never carry into a caption. Two separate hazards:
//   • markup — []()`* would open a link/bold span inside the rendered template;
//   • bare URLs — Telegram AUTO-LINKS "https://x" in message text no matter what
//     entities we send, so ":" and "/" have to go too. A token whose symbol is
//     "](https://scam)[" is a real thing a scammer can deploy, and premium.js'
//     sanitizeVar alone only stops the markup half.
// Deliberately a strip-list, not an allow-list: a Cyrillic or CJK ticker is
// legitimate, and an allow-list would erase it and drop the token entirely.
const SYMBOL_UNSAFE = /[[\]()<>`*|:/\\\s]/g;

/** "$BULLCAT" / "bullcat" → "BULLCAT" (the banner draws its own "$"). */
function normSymbol(s) {
  return String(s == null ? "" : s)
    .replace(/^\$+/, "")
    .replace(SYMBOL_UNSAFE, "")
    .trim()
    .toUpperCase()
    .slice(0, 14);
}

/** The @handle out of any x.com / twitter.com URL, or null. */
const NOT_A_HANDLE = /^(i|home|intent|share|search|hashtag|communities|none|null|na|n\/a|tbа|tba|soon)$/i;
function xHandle(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  let h = null;
  const m = /(?:x\.com|twitter\.com)\/(@?[A-Za-z0-9_]{1,30})/i.exec(raw);
  if (m) h = m[1];
  // A BARE HANDLE IS ALSO A HANDLE. The listing form takes free text, so a
  // project that typed "@velvet_capital" instead of the full URL had its X
  // dropped and reached the leaderboard with no attribution at all — the one
  // thing a gainer wants from being on the board.
  else if (/^@?[A-Za-z0-9_]{1,30}$/.test(raw)) h = raw;
  if (!h) return null;
  h = h.replace(/^@/, "");
  // Not handles: x.com/i/status/…, /home, /intent/tweet, /share — and the
  // placeholder words a listing form collects instead of a blank.
  return NOT_A_HANDLE.test(h) ? null : h;
}

/**
 * Fill in the X handle the BOARD does not carry.
 *
 * The two sources are not equivalent: `listingCoins` reads `row.twitter` — what
 * the project typed on its listing form — while `boardCoin` reads
 * `t.links.twitter` from the website's own row. When the site has no link the
 * board coin has no handle, so the caption printed "#巨兽BEHEMOTH +4336%" with
 * nothing to click, on a token whose socials the bot already had on file.
 *
 * Only for coins that are MISSING one: the board's own value always wins, and
 * this must never rewrite an attribution the site is asserting. One request, and
 * only when it can change something. Never throws — a missing handle is a
 * cosmetic gap, not a reason to lose the banner.
 *
 * AND IT REPORTS WHAT IT DID. The first cut swallowed the answer in a log.debug,
 * so when the caption came back with no @handles the only honest thing anyone
 * could say was "it did not work" — three tokens with no X on file, a listing
 * lookup that failed, and a chain key that did not match all look identical from
 * Telegram. `{ filled, noHandle, notListed, failed }` is the difference between a
 * shrug and an answer.
 */
async function enrichHandles(coins) {
  const out = { filled: [], noHandle: [], notListed: [], failed: null };
  const missing = coins.filter((c) => c && !c.x);
  if (!missing.length) return out;
  try {
    const rows = (await api.getListings()) || [];
    const byKey = new Map();
    for (const r of rows) {
      if (r && r.chain && r.address) byKey.set(`${r.chain}|${String(r.address).toLowerCase()}`, r);
    }
    for (const c of missing) {
      const r = byKey.get(`${c.chain}|${String(c.address).toLowerCase()}`);
      if (!r) { out.notListed.push(c.symbol); continue; }
      const h = xHandle(r.twitter);
      if (!h) { out.noHandle.push(c.symbol); continue; }
      c.x = h;
      c.links = { ...(c.links || {}), twitter: (c.links && c.links.twitter) || r.twitter };
      out.filled.push(c.symbol);
    }
  } catch (e) {
    out.failed = e.message;
  }
  // INFO, not debug: this is the line that answers "why is there no @handle",
  // and a level nobody prints is the same as no line at all.
  const bits = [
    out.filled.length ? `filled ${out.filled.length}` : null,
    out.noHandle.length ? `no X on file: ${out.noHandle.join(", ")}` : null,
    out.notListed.length ? `not in the listing store: ${out.notListed.join(", ")}` : null,
    out.failed ? `lookup FAILED (${out.failed})` : null,
  ].filter(Boolean);
  if (bits.length) log.info(`[gainers] handles · ${bits.join(" · ")}`);
  return out;
}

const tokenUrl = (chain, address) => `${SITE_URL}/token/${chain}/${address}`;

/** Every logo URL worth trying, best first. The renderer draws a $SYMBOL
 *  monogram if they all fail, so a missing logo is a cosmetic downgrade and
 *  never a blank circle (the fourtis lesson — see their CLAUDE.md gotcha 17). */
function logoCandidates(coin) {
  const out = [];
  const push = (u) => {
    const s = String(u || "").trim();
    if (!s) return;
    // A store logo is a relative /api/media/… path; make it publicly fetchable.
    const abs = /^https?:\/\//i.test(s) ? s : `${SITE_URL}${s.startsWith("/") ? "" : "/"}${s}`;
    if (!out.includes(abs)) out.push(abs);
  };
  push(coin.logoUrl);
  push(coin.liveLogoUrl);
  const ds = dexscreener.DS_CHAIN[coin.chain];
  if (ds && coin.address) push(`https://dd.dexscreener.com/ds-data/tokens/${ds}/${coin.address}.png?size=lg`);
  return out;
}

/** Bounded-concurrency map that never rejects: a failed item resolves to null. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch {
        out[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

// ── logo download (decode-verified, cached) ─────────────────────────────────
// Verified by DECODING, not by HTTP 200: launchpad and CDN logos are routinely
// webp/avif bytes served under a .png name, or a bot-protection HTML page with an
// image content-type. A candidate that canvas can't rasterise is not a logo, and
// the next candidate gets its turn.
const LOGO_TTL_MS = 20 * 60 * 1000;
const LOGO_CACHE_MAX = 240;
const _logoCache = new Map(); // url → { buf: Buffer|null, at: number }

async function downloadLogo(url) {
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, accept: "image/*,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(LOGO_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (/^text\/|application\/(json|xml|xhtml)/i.test(ct)) return null; // interstitial, not an image
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 5 * 1024 * 1024) return null;
    return buf;
  } catch {
    return null;
  }
}

async function decodes(buf) {
  const kit = require("./helpers/canvasKit");
  const cv = kit.canvasLib();
  if (!cv) return true; // no canvas → nothing renders anyway; don't reject bytes here
  try {
    await cv.loadImage(buf);
    return true;
  } catch {
    return false;
  }
}

/** First candidate URL that downloads AND decodes, else null. Cached per URL
 *  (negatives too — a 404'd CDN path stays 404 for the next 20 minutes, and a
 *  banner rebuild after a slot edit must not re-fetch nine logos). */
async function resolveLogo(coin) {
  const now = Date.now();
  if (_logoCache.size > LOGO_CACHE_MAX) _logoCache.clear();
  for (const url of logoCandidates(coin)) {
    const hit = _logoCache.get(url);
    if (hit && now - hit.at < LOGO_TTL_MS) {
      if (hit.buf) return hit.buf;
      continue;
    }
    const buf = await downloadLogo(url);
    const ok = buf && (await decodes(buf));
    _logoCache.set(url, { buf: ok ? buf : null, at: now });
    if (ok) return buf;
    if (buf) log.debug(`[gainers] logo not decodable, trying next: ${url}`);
  }
  return null;
}

/** Attach a `logo` Buffer (or null) to every coin. Never throws. */
async function loadLogos(coins) {
  await mapLimit(coins, 5, async (c) => {
    c.logo = await resolveLogo(c).catch(() => null);
    return true;
  });
  return coins;
}

// ── source 1: the site board ────────────────────────────────────────────────
async function fetchBoard() {
  const r = await fetch(`${DEXVRA_API_BASE}/api/tokens`, {
    headers: { accept: "application/json", "user-agent": UA },
    signal: AbortSignal.timeout(BOARD_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j || !Array.isArray(j.tokens)) throw new Error("unexpected payload (no tokens[])");
  return j;
}

function boardCoin(t) {
  return {
    chain: t.chain,
    address: t.address,
    symbol: normSymbol(t.symbol),
    name: String(t.name || "").trim(),
    pct: num(t.chg && t.chg["24h"]),
    price: pos(t.priceUsd),
    mcap: pos(t.mcap),
    liq: pos(t.liq),
    vol24h: pos(t.vol && t.vol["24h"]),
    logoUrl: t.logoUrl || "",
    links: t.links || {},
    x: xHandle(t.links && t.links.twitter),
    tier: t.tier || null,
    url: tokenUrl(t.chain, t.address),
    src: "board",
  };
}

// ── source 2: bot-side (internal listings + market lookups) ─────────────────
async function listingCoins() {
  const rows = (await api.getListings()) || [];
  // Newest first, so a cap on the number of lookups keeps the CURRENT listings
  // rather than whatever happens to sit at the top of the file.
  const approved = rows
    .filter((r) => r && r.status === "approved" && r.chain && r.address)
    .sort((a, b) => (b.listedAt || 0) - (a.listedAt || 0))
    .slice(0, PROBE_CAP);
  const priced = await mapLimit(approved, PROBE_CONCURRENCY, async (row) => {
    const m = await market.fetchMarket(row.chain, row.address).catch(() => null);
    if (!m || !Number.isFinite(m.change24h)) return null; // unpriced → not on the board
    return {
      chain: row.chain,
      address: row.address,
      symbol: normSymbol(row.sym || row.symbol || m.symbol),
      name: String(row.name || m.name || "").trim(),
      pct: num(m.change24h),
      price: pos(m.priceUsd),
      mcap: pos(m.mcap),
      liq: pos(m.liq),
      vol24h: null,
      logoUrl: row.logoUrl || "",
      liveLogoUrl: m.logoUrl || "",
      links: { website: row.website || null, twitter: row.twitter || null, telegram: row.telegram || null },
      x: xHandle(row.twitter),
      tier: row.tier || null,
      url: tokenUrl(row.chain, row.address),
      src: "listings",
    };
  });
  return { coins: priced.filter(Boolean), scanned: approved.length };
}

// ── selection ───────────────────────────────────────────────────────────────
/** Sane, positive, liquid-enough movers, biggest gain first. */
function rank(coins, { limit = MAX_SLOTS, minGainPct = 0, minLiqUsd = 0, minMcapUsd = 0 } = {}) {
  return coins
    .filter((c) => c && c.symbol && c.address)
    .filter((c) => c.pct != null && c.pct >= minGainPct && Math.abs(c.pct) <= SANE_PCT)
    .filter((c) => !minLiqUsd || (c.liq || 0) >= minLiqUsd)
    // A token whose cap we could not read cannot be SHOWN to clear the floor,
    // so it is left off — same rule as an unreadable 24h change. `|| 0` is what
    // makes that true, and it is the same shape as the liquidity filter above.
    .filter((c) => !minMcapUsd || (c.mcap || 0) >= minMcapUsd)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, Math.max(1, Math.min(MAX_SLOTS, limit)));
}

/**
 * The live top gainers.
 *
 * @param {object} opts
 * @param {number} opts.limit       how many slots the template needs (≤ 10)
 * @param {number} opts.minGainPct  floor; 0 keeps every token that is up at all
 * @param {number} opts.minLiqUsd   liquidity floor (0 = off)
 * @param {number} opts.minMcapUsd  market-cap floor (0 = off); defaults ON at $1M in config
 * @param {string} opts.source      "auto" | "board" | "listings"
 * @param {boolean} opts.logos      download logos (false for a fast data-only check)
 * @returns {Promise<{coins:Array, source:string, pool:number, notes:string[]}>}
 *          `coins` may be SHORTER than `limit`, or empty — never padded.
 */
async function topGainers({ limit = 5, minGainPct = 0, minLiqUsd = 0, minMcapUsd = 0, source = "auto", logos = true } = {}) {
  const notes = [];
  let coins = [];
  let used = "none";
  let pool = 0;

  if (source !== "listings") {
    try {
      const board = await fetchBoard();
      const live = board.tokens.filter((t) => t && t.source === "live");
      pool = live.length;
      if (!board.live || !live.length) {
        notes.push("Site board has no LIVE rows right now (its market provider is down or nothing is listed).");
      }
      coins = rank(live.map(boardCoin), { limit, minGainPct, minLiqUsd, minMcapUsd });
      if (coins.length) used = "board";
    } catch (e) {
      notes.push(`Site board unreachable (${e.message}) — priced the listings directly instead.`);
      log.warn(`[gainers] board fetch failed: ${e.message}`);
    }
  }

  if (!coins.length && source !== "board") {
    try {
      const { coins: c, scanned } = await listingCoins();
      pool = Math.max(pool, c.length);
      if (!scanned) notes.push("No approved listings in the store yet.");
      else if (!c.length) notes.push(`Priced ${scanned} listing(s) — none returned a live 24h change.`);
      coins = rank(c, { limit, minGainPct, minLiqUsd, minMcapUsd });
      if (coins.length) used = "listings";
    } catch (e) {
      notes.push(`Listings API failed (${e.message}).`);
      log.warn(`[gainers] listings fetch failed: ${e.message}`);
    }
  }

  if (!coins.length && !notes.length) {
    notes.push(minGainPct > 0 ? `No token is up ≥ +${minGainPct}% in the last 24h.` : "No token is up in the last 24h.");
  }
  // After the ranking is settled, so at most MAX_SLOTS coins are looked up and
  // never the whole pool.
  const handles = coins.length ? await enrichHandles(coins) : null;
  if (coins.length && logos) await loadLogos(coins);
  return { coins, source: used, pool, notes, handles };
}

// ── slot override (swap one token by link / contract address) ────────────────
/** Pull (chain, address) out of a dexvra link, a DexScreener link, a
 *  "chain address" pair, or a bare contract address. chain may be null. */
function parseTokenRef(input) {
  const s = String(input || "").trim();
  if (!s) return { chain: null, address: null };
  // https://dexvra.io/token/<chain>/<address>
  let m = /\/token\/([a-z0-9-]+)\/([^/?#\s]+)/i.exec(s);
  if (m && CHAINS[m[1].toLowerCase()]) return { chain: m[1].toLowerCase(), address: m[2] };
  // https://dexscreener.com/<dsChain>/<address>
  m = /dexscreener\.com\/([a-z0-9-]+)\/([^/?#\s]+)/i.exec(s);
  if (m) {
    const ours = Object.entries(dexscreener.DS_CHAIN).find(([, ds]) => ds === m[1].toLowerCase());
    if (ours) return { chain: ours[0], address: m[2] };
  }
  // "solana <address>" / "bsc:0x…"
  m = /^([a-z0-9-]+)[\s:]+(\S+)$/i.exec(s);
  if (m && CHAINS[m[1].toLowerCase()]) return { chain: m[1].toLowerCase(), address: m[2] };
  // bare address
  m = /(0x[0-9a-fA-F]{40}|T[1-9A-HJ-NP-Za-km-z]{33}|[1-9A-HJ-NP-Za-km-z]{32,44})/.exec(s);
  return { chain: null, address: m ? m[1] : null };
}

/** Chains a bare address could plausibly live on, cheapest guess first. */
function candidateChains(address) {
  return Object.keys(CHAINS).filter((id) => isValidAddress(id, address));
}

/**
 * Resolve one token for a manual slot swap. Live 24h change is REQUIRED: a slot
 * on a gainers banner with no percentage would either print a blank or invite a
 * made-up one, so this throws instead and the admin is told which link failed.
 */
async function resolveToken(input) {
  const { chain, address } = parseTokenRef(input);
  if (!address) throw new Error("couldn't find a contract address in that (send a CA or a dexvra.io / dexscreener link)");
  const tries = chain ? [chain] : candidateChains(address);
  if (!tries.length) throw new Error(`"${address}" doesn't look like an address on any supported chain`);

  let best = null;
  for (const id of tries) {
    // DexScreener first: it carries the socials + logo a caption/banner wants.
    const ds = await dexscreener.fetchTokenInfo(id, address).catch(() => null);
    const m = await market.fetchMarket(id, address).catch(() => null);
    if (!ds && !m) continue;
    const pct = num(m && m.change24h) ?? num(ds && ds.change24h);
    const liq = pos(m && m.liq) ?? pos(ds && ds.liq);
    const cand = {
      chain: id,
      address,
      symbol: normSymbol((ds && ds.symbol) || (m && m.symbol)),
      name: String((ds && ds.name) || (m && m.name) || "").trim(),
      pct,
      price: pos(m && m.priceUsd) ?? pos(ds && ds.priceUsd),
      mcap: pos(m && m.mcap) ?? pos(ds && ds.mcap),
      liq,
      vol24h: pos(ds && ds.vol24),
      logoUrl: (ds && ds.logoUrl) || "",
      liveLogoUrl: (m && m.logoUrl) || "",
      links: { website: (ds && ds.website) || null, twitter: (ds && ds.twitter) || null, telegram: (ds && ds.telegram) || null },
      x: xHandle(ds && ds.twitter),
      tier: null,
      url: tokenUrl(id, address),
      src: "manual",
    };
    // With no chain given, believe the deepest pool — a same-address deploy on
    // another EVM chain is common and would otherwise supply a wrong price.
    if (!best || (cand.liq || 0) > (best.liq || 0)) best = cand;
    if (chain) break;
  }
  if (!best) throw new Error("no market data for that token on any supported chain");
  if (best.pct == null) throw new Error(`${best.symbol || "that token"} has no live 24h change — can't put it on a gainers banner`);
  if (Math.abs(best.pct) > SANE_PCT) throw new Error(`${best.symbol}'s 24h change reads ${Math.round(best.pct)}% — that's broken pool data, not a move`);
  best.logo = await resolveLogo(best).catch(() => null);
  return best;
}

// ── presentation helpers (shared by the banner and the caption) ──────────────
/** "+204%" / "+27.7%" / "-3.42%" — helpers/format.js owns the rules so the
 *  banner and the caption can never print the same move differently. */
const pctLabel = fmtPct;

const chainLabel = (id) => (chainOf(id) ? chainOf(id).label : String(id || "").toUpperCase());

/** Local date line, e.g. "Thursday · July 30 · 2026".
 *
 *  Assembled from parts rather than formatted, for one reason: the banner draws
 *  this line letter-spaced, and a comma with tracking either side reads as a
 *  floating speck ("JULY 30 , 2026"). "·" separators survive tracking and read
 *  the same in the caption. An invalid timezone (a hand-edited config) falls
 *  back to UTC instead of throwing mid-render. */
function dateText(tz = "Asia/Jakarta", now = new Date()) {
  const build = (zone) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).formatToParts(now);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
    return `${get("weekday")} · ${get("month")} ${get("day")} · ${get("year")}`;
  };
  try {
    return build(tz);
  } catch {
    return build("UTC");
  }
}

/** Is this a timezone Intl actually knows? The admin panel validates input with
 *  it so a typo is rejected at save time, not silently fallen back at render. */
function validTz(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: String(tz) });
    return true;
  } catch {
    return false;
  }
}

// ── caption ─────────────────────────────────────────────────────────────────
// Built as premium-emoji MARKUP and handed to templates.js, so the ranked list
// renders identically whether the admin left the default template alone or
// pasted their own with real premium emoji in it. User-supplied values
// (symbol/name/handle/url) go through premium.sanitize* — a token called
// "[click](https://scam)" must never inject a link into a channel post.
function listMarkup(coins, { showPct = true, showMcap = false } = {}) {
  const premium = require("./premium");
  const board = require("./services/trendingBoard");
  const lines = [];
  coins.slice(0, MAX_SLOTS).forEach((c, i) => {
    const badge = board.rankBadge(i + 1); // admin-editable, premium when set
    const sym = premium.sanitizeVar(`#${c.symbol}`);
    const parts = [`${badge} [${sym}](${premium.sanitizeUrl(c.url)})`];
    if (c.x) parts.push(`[@${premium.sanitizeVar(c.x)}](https://x.com/${premium.sanitizeVar(c.x)})`);
    let line = parts.join(" · ");
    if (showPct && c.pct != null) line += `  **${pctLabel(c.pct)}**`;
    if (showMcap && c.mcap) line += `  ${fmtCap(c.mcap)}`;
    lines.push(line);
  });
  return lines.join("\n");
}

/** The send-ready caption payload ({text, entities}) for a gainers banner.
 *  `xUrl` is the board's own tweet when it has one; dropEmpty then removes the
 *  "Announce On X" line (and its blank separator) on the runs that have none —
 *  a dead label under a leaderboard is worse than no line. */
function captionPayload(coins, { tz = "Asia/Jakarta", showMcap = false, showPct = true, xUrl = "" } = {}) {
  const tpl = require("./templates");
  const { channelLinks } = require("./channels/format");
  return tpl.render(
    "post_gainers",
    {
      date: dateText(tz),
      count: String(coins.length),
      list: listMarkup(coins, { showMcap, showPct }),
      xUrl: xUrl || "",
      ...channelLinks(),
    },
    { dropEmpty: true },
  );
}

/** The same ranked board as PLAIN text, for the tweet. X has no markdown, no
 *  custom emoji and no link labels, so the Telegram markup can't be reused: a
 *  `[#SYM](url)` would publish its brackets verbatim. Rank is a plain number,
 *  the project's @handle is a real mention (the whole reason a gainer wants to
 *  be on the board), and no per-token url — 10 urls at 23 characters each would
 *  blow the 280-char limit on their own. */
function listText(coins, { showPct = true, showMcap = false, limit = MAX_SLOTS } = {}) {
  return coins
    .slice(0, Math.min(MAX_SLOTS, limit))
    .map((c, i) => {
      let line = `${i + 1}. $${c.symbol}`;
      if (c.x) line += ` @${c.x}`;
      if (showPct && c.pct != null) line += `  ${pctLabel(c.pct)}`;
      if (showMcap && c.mcap) line += `  ${fmtCap(c.mcap)}`;
      return line;
    })
    .join("\n");
}

/** One-line summary for the admin panel / logs: "5 gainers · board · +204% top". */
function summary(res) {
  if (!res.coins.length) return "no live gainers";
  return `${res.coins.length} gainer(s) · ${res.source} · top ${res.coins[0].symbol} ${pctLabel(res.coins[0].pct)}`;
}

module.exports = {
  MAX_SLOTS,
  topGainers,
  // Test seam. The filters decide what a PUBLIC leaderboard claims, and
  // asserting them through topGainers means asserting them through the
  // network. This is a pure function of its arguments; let it be called.
  _rank: rank,
  resolveToken,
  loadLogos,
  rank,
  pctLabel,
  chainLabel,
  dateText,
  validTz,
  listMarkup,
  listText,
  captionPayload,
  summary,
  // exposed for tests
  _internals: { normSymbol, xHandle, enrichHandles, logoCandidates, parseTokenRef, candidateChains, boardCoin, mapLimit },
};
