'use strict';
/*
 * Tolerant extraction for launchpad responses.
 *
 * NONE of these schemas are ours and none of them are published contracts. A
 * launchpad renames `usd_market_cap` to `marketCapUsd` on a Tuesday and every
 * card that read it by one hard-coded name goes blank — with no error anywhere,
 * because a missing field is not an error. bot/src/poolstrade.js already learned
 * this against the Uniswap launches API; this file is the same idea, factored
 * out so six launchpads share one answer instead of inventing six.
 *
 * The rule: every field is read through `pick()` with a LIST of plausible
 * names. A rename then costs one entry in a list, not an outage, and the
 * unknown-shape case degrades to null — which every caller already treats as
 * "no extra metadata".
 */

/** Walk a dotted path. Returns undefined for anything missing. */
function at(obj, path) {
  let cur = obj;
  for (const seg of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** First path that yields something real. Empty string counts as nothing. */
function pick(obj, paths) {
  for (const p of paths) {
    const v = at(obj, p);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * A short single-LINE string, from a field a stranger wrote.
 *
 * THE WHITESPACE COLLAPSE IS A SECURITY FIX, not tidiness. A token's name and
 * symbol are chosen by whoever deployed it and land in a trade receipt — the
 * message a user reads to decide what just happened to their money. Escaping
 * makes `<b>` inert; it does nothing whatsoever to a NEWLINE. So a token named
 *
 *     Nice Coin\n\n🟢 Buy of 999,999 $SOL succeeded · 💳 robin1
 *
 * renders as extra lines inside a real receipt, in the bot's own voice, and
 * there is no way for the reader to tell them from the ones the bot wrote.
 * Found because a live feed returned a token whose symbol was "READ TWEET" —
 * a space is harmless and was the thread worth pulling.
 *
 * Sliced by code point so the cap never splits an emoji's surrogate pair.
 */
const str = (v, max = 200) => {
  const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return Array.from(s).slice(0, max).join('');
};

const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[, _]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** A number that must be positive to mean anything (price, mcap, liquidity).
 *  Zero is returned as null on purpose: "$0 market cap" on a card is worse than
 *  a blank row, and every caller here treats null as "this source didn't say". */
const pnum = (v) => { const n = num(v); return n != null && n > 0 ? n : null; };

const bool = (v) => {
  if (v === undefined || v === null || v === '') return null;   // "didn't say" ≠ false
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return null;
};

/**
 * ms epoch / s epoch / ISO-8601 → ms, or null.
 *
 * The future clamp is load-bearing, not defensive dressing. The Solana snipe
 * loop advances a cursor to the newest launch it has seen; one launch stamped
 * with a bogus far-future timestamp would push that cursor past every real
 * launch and the snipe would never fire again — silently, because a cursor
 * ahead of the feed looks exactly like a quiet launchpad. A timestamp that has
 * not happened yet is not a timestamp.
 */
const FUTURE_SLACK_MS = 60 * 1000;   // clock skew between us and a launchpad, not a real launch
function toMs(v, now) {
  if (v == null || v === '') return null;
  let ms;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v).trim())) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    ms = n < 1e11 ? Math.round(n * 1000) : Math.round(n);   // 1e11 ms is the year 5138, so below it is seconds
  } else {
    const t = Date.parse(String(v));
    if (!Number.isFinite(t)) return null;
    ms = t;
  }
  const ceiling = (Number.isFinite(now) ? now : Date.now()) + FUTURE_SLACK_MS;
  return ms > ceiling ? null : ms;
}

/**
 * A percentage in 0..100, whatever the source called it.
 *
 * Sources disagree about the unit: some send 0.42, some 42, some "42%". A
 * fraction and a percentage are indistinguishable in the 0..1 overlap, so the
 * rule is the one poolstrade.js already uses — a value in (0,1] is read as a
 * fraction. That misreads a genuine 0.5% as 50%, which is a rounding-scale
 * error on a display-only field, versus reading every fraction as ~0% which
 * would blank the progress bar for every token below full.
 */
function pct(v) {
  let n = num(typeof v === 'string' ? String(v).replace(/%\s*$/, '') : v);
  if (n == null) return null;
  if (n > 0 && n <= 1) n *= 100;
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

/**
 * http(s) only, and short.
 *
 * These strings are written by whoever deployed the token and they end up
 * inside an href on a Telegram card. A `javascript:` or `data:` URL has no
 * business there, and a malformed one makes Telegram reject the whole message —
 * which would take a card down over a field a stranger controls. Mirrors
 * tradebot/tokeninfo.js `_safeUrl` and bot/src/poolstrade.js `safeUrl`
 * deliberately: three places, one rule.
 */
function safeUrl(v) {
  const s = v == null ? '' : String(v).trim();
  if (!s || s.length > 300) return null;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? s : null;
  } catch (_) { return null; }
}

/**
 * A LOGO may also be an `ipfs://` URI, and `safeUrl` refuses it.
 *
 * ⚠️ EVERY LAUNCHPAD LOGO PINNED ON IPFS WAS NULLED HERE, silently, for as long
 * as this registry has existed — `rec.logoUrl = safeUrl(...)`, and a launchpad
 * pins its artwork on IPFS, which is the one scheme that filter refuses. It is
 * the identical defect the site's Pons reader already carries a scar for
 * (`readCurvesAndMeta` kept a logo only if it matched `/^https?:\/\//`), one
 * layer down and never fixed here: pump.fun happens to publish an https pinata
 * url, so nothing looked wrong, and a pad that publishes the URI lost its
 * picture with nothing anywhere saying so.
 *
 * It stays an ALLOWLIST — `logo` is free text written by whoever deployed the
 * token — and it allows exactly what the consumers can RENDER: the site's
 * `/api/logo` rewrites `ipfs://` to a gateway with failover, and the bot's
 * `httpsLogo` does the same. `ar://` is deliberately absent for the reason the
 * site's `tokenLogo` states: no consumer has that rewrite, so publishing it
 * would turn "no logo" into a broken image.
 */
function logoUri(v) {
  const s = v == null ? '' : String(v).trim();
  if (!s || s.length > 300) return null;
  if (/^ipfs:\/\/\S+$/i.test(s)) return s;
  return safeUrl(s);
}

/** A social that may arrive as a full URL or as a bare handle. */
function socialUrl(v, base) {
  const s = v == null ? '' : String(v).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return safeUrl(s);
  const h = s.replace(/^@/, '');
  return /^[A-Za-z0-9_.]{1,40}$/.test(h) ? `${base}/${h}` : null;
}

/** One collapsed paragraph, or null — the shape bot/src/marketdata.js wants for
 *  the listing overview. Short strings are dropped: a six-character
 *  "description" is a placeholder, not a project intro. */
function description(v) {
  if (!v || typeof v !== 'string') return null;
  const clean = v.replace(/\s+/g, ' ').trim();
  return clean.length >= 20 ? Array.from(clean).slice(0, 500).join('') : null;
}

const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;   // base58, no 0/O/I/l
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/** Is `id` a plausible token address on `chain`? Used to drop feed rows whose
 *  address field moved, rather than passing junk to a pricing call. */
function isAddress(chain, id) {
  const s = String(id || '').trim();
  if (!s) return false;
  return chain === 'solana' ? SOL_ADDRESS.test(s) : EVM_ADDRESS.test(s);
}

/** Compare two addresses the way their chain does. Solana mints are base58 and
 *  CASE-SIGNIFICANT — lowercasing one destroys it. EVM addresses are not. */
function sameAddress(chain, a, b) {
  const x = String(a || '').trim(), y = String(b || '').trim();
  if (!x || !y) return false;
  return chain === 'solana' ? x === y : x.toLowerCase() === y.toLowerCase();
}

/** The cache/lookup key for an address on a chain — same case rule as above. */
const addrKey = (chain, a) => (chain === 'solana' ? String(a || '').trim() : String(a || '').trim().toLowerCase());

module.exports = {
  at, pick, str, num, pnum, bool, toMs, pct, safeUrl, socialUrl, description,
  isAddress, sameAddress, addrKey, SOL_ADDRESS, EVM_ADDRESS, FUTURE_SLACK_MS, logoUri,
};
