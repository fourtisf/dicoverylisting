'use strict';
/*
 * The Pons launch, read off the CHAIN — for the listing form.
 *
 * WHY THIS EXISTS. The autofill has three sources and NONE of them reads the
 * chain: DexScreener and GeckoTerminal index POOLS, and a token still on its
 * bonding curve has none; the launchpad registry asks Pons over HTTP on a host
 * and a path this repo has never verified (`verified: false`, and the
 * operator's own launchpads:check has reported the earlier guess unreachable).
 * So a project pasting a fresh Pons contract was asked to type its own name,
 * ticker, logo and socials by hand — all of which the token contract publishes.
 *
 * WHY IT ASKS THE WEB APP INSTEAD OF READING THE CHAIN ITSELF. The reader
 * already exists, in src/lib/providers/pons, and it is the one owner of what
 * the Pons factory says about a token. This package is CommonJS on Node 18 and
 * cannot import a .ts module, so a local copy would be a SECOND reader — and
 * this repo has already paid for that shape once: tradebot/solana.js and
 * bot/src/marketdata.js each carried their own idea of which pump.fun host was
 * current, they drifted, one was left on the retired host, and Solana snipe
 * discovery was blind for days behind a green /health. Both processes run on
 * the same box, so the site is a localhost request away.
 *
 * ⚠️ DISPLAY METADATA ONLY, the same contract poolstrade.js and the launchpad
 * registry carry. `liq`, `vol24` and `pairCreatedAt` are the fields the
 * auto-lister's gates read, and a curve publishes none of them — they stay 0,
 * which those gates read as "no data", never as a passing score.
 */
const { DEXVRA_API_BASE } = require('./config/constants');
const { padsFor } = require('./launchpads');
const { safeUrl, socialUrl, description: cleanDescription, str } = require('../../shared/launchpads/normalize');
const log = require('./helpers/logger');

// ⚠️ `Number('')` is 0 and 0 is FINITE, so a bare `PONS_CHAIN_MS=` in .env would
// mean no ceiling at all. Blank is ABSENT; an explicit 0 is still honoured.
const envNum = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const TIMEOUT_MS = envNum('PONS_CHAIN_MS', 5000);
const COOLDOWN_MS = envNum('PONS_CHAIN_COOLDOWN_MS', 60_000);
const { httpsLogo } = require('./helpers/httpsLogo');

let coolingUntil = 0;

/**
 * Addresses the Pons factory never launched — a PERMANENT fact, memoed.
 *
 * `fetchPonsLaunch` resolves a launch BY ADDRESS off the factory, not by
 * scanning a window, so a 404 says the factory does not know this token and no
 * amount of waiting changes that. Remembering it is what makes asking the chain
 * CONCURRENTLY with the indexers affordable: without it every graduated
 * Robinhood token would pay a localhost round trip on every poll of nine
 * background pipelines, and the read is only started up front because being
 * fourth in a serial queue is what made the fix inert.
 *
 * ⚠️ ONLY A 404 IS MEMOED. "We could not ask" parks the reader instead (see
 * `coolingUntil`) — writing a transport failure down here would mark a live
 * curve as "never launched" for the life of the process, which is the TBA this
 * whole module exists to end, made permanent.
 *
 * Bounded, and evicted oldest-first: a set that only ever grows is a leak
 * anybody can drive by pasting addresses.
 */
const NOT_PONS_MAX = 5000;
const notPons = new Set();

const memoKey = (chain, address) => `${chain}/${String(address).toLowerCase()}`;

function rememberNotPons(chain, address) {
  const k = memoKey(chain, address);
  if (notPons.has(k)) return;
  if (notPons.size >= NOT_PONS_MAX) {
    // Sets iterate in insertion order, so the first key is the oldest.
    const oldest = notPons.values().next();
    if (!oldest.done) notPons.delete(oldest.value);
  }
  notPons.add(k);
}

/** Chains the Pons pad declares, read from the registry rather than a second
 *  hardcoded list — the rule tradebot/launchpads.js had to learn after its own
 *  hand-written chain map silently dropped a whole pad. */
const covers = (chain) => {
  try {
    return padsFor(chain).some((p) => p && p.key === 'pons');
  } catch (_) {
    return false;
  }
};

// An `ipfs://` logo is real artwork and an unusable URL. The rewrite moved to
// helpers/httpsLogo the day the launchpad registry became a second producer of
// one — two copies of a gateway rewrite is two gateways. Re-exported, because
// this module's own name for it is what every caller already reads.

/** The launch, in the shape discovery.mergeInfo merges. */
function toInfo(launch) {
  const s = launch.socials || {};
  const graduated = launch.graduated === true;
  return {
    name: str(launch.name, 60) || null,
    symbol: str(launch.symbol, 24) || null,
    priceUsd: launch.priceUsd == null ? null : Number(launch.priceUsd),
    mcap: launch.mcapUsd == null ? null : Number(launch.mcapUsd),
    logoUrl: httpsLogo(launch.logo),
    website: safeUrl(s.website),
    twitter: socialUrl(s.twitter, 'https://x.com'),
    telegram: socialUrl(s.telegram, 'https://t.me'),
    // The gates' fields. A curve has no pool, so these are genuinely unknown
    // and 0 is how this repo spells that on these three.
    liq: 0,
    vol24: 0,
    change24h: 0,
    pairCreatedAt: 0,
    pairCount: 1,
    description: cleanDescription(launch.description),
    graduated,
    // Three-valued, like every other pad: true / false / null for "nobody
    // said". The phase always says, so this is never null here.
    onCurve: launch.phase ? launch.phase === 'NotGraduated' : null,
    progressPct: Number.isFinite(launch.progressPct) ? launch.progressPct : null,
    progressSource: 'chain',
    holders: null,
    launchpad: 'Pons',
    launchUrl: safeUrl(launch.ponsUrl),
    source: 'pons-chain',
    // Why the USD figures are missing when they are — the site's ETH/USD
    // ladder names every rung that refused — and which rung priced it when
    // they are not. "We could not price it" and "nobody prices it" are
    // different facts, and the post watch prints this one.
    marketWhy: launch.marketWhy ? str(launch.marketWhy, 240) : null,
    // The node's reason when name/symbol/logo/price are null for OUR reason
    // (the RPC refused or failed) — never the creator's.
    readWhy: launch.readWhy ? str(launch.readWhy, 240) : null,
    quoteUsdSource: launch.quoteUsdSource ? str(launch.quoteUsdSource, 24) : null,
  };
}

/**
 * `{ ok, why, info }` — because "Pons never launched this token" and "we could
 * not ask" are different facts and the caller must not cache the second as the
 * first. The `pumpfunNewX` shape, for the fifth time in this repo.
 */
// THE LAST FAILURE HAS A SURFACE. Every `ok:false` here used to end at
// log.debug in marketdata.fillFromChain — production prints neither — so a
// paid post that published TBA over a parked reader had no sentence anywhere:
// the alert blamed the GT queue or "neither indexer returned anything" about
// a chain read that had answered 503 a minute earlier. `lastWhy()` is what the
// post's read and `post:check` ask. Per address, bounded, and the park reason
// process-wide, because the park is.
const LAST_WHY_MAX = 200;
const LAST_WHY_TTL_MS = 10 * 60_000;
const lastFail = new Map();
let parkedWhy = null;
function park(chain, address, why) {
  coolingUntil = Date.now() + COOLDOWN_MS;
  parkedWhy = why;
  // A transition, not a poll: this fires once per COOLDOWN_MS at most, and a
  // site the bot cannot read is worth a line production actually prints.
  log.warn(`[pons] ${chain}/${address}: ${why} — parking the chain reader for ${Math.round(COOLDOWN_MS / 1000)}s`);
  noteFail(chain, address, why);
}
function noteFail(chain, address, why) {
  const k = memoKey(chain, address);
  lastFail.delete(k);
  lastFail.set(k, { why, at: Date.now() });
  if (lastFail.size > LAST_WHY_MAX) lastFail.delete(lastFail.keys().next().value);
}
/** Why the chain could not be asked about this token, or null. */
function lastWhy(chain, address) {
  if (!covers(chain)) return null;
  const now = Date.now();
  if (now < coolingUntil && parkedWhy) return `parked after a recent failure — ${parkedWhy}`;
  const f = lastFail.get(memoKey(chain, address));
  if (!f || now - f.at > LAST_WHY_TTL_MS) return null;
  return `${f.why} (${Math.round((now - f.at) / 1000)}s ago)`;
}

async function fetchTokenInfoX(chain, address) {
  if (!covers(chain)) return { ok: true, why: null, info: null };
  // An answer we already have. `ok` is true because this IS the answer — Pons
  // never launched it — and the caller must not read it as a source that failed.
  if (notPons.has(memoKey(chain, address))) return { ok: true, why: 'not a Pons launch', info: null };
  if (Date.now() < coolingUntil) {
    return { ok: false, why: `parked after a recent failure${parkedWhy ? ` — ${parkedWhy}` : ''}`, info: null };
  }

  const url = `${DEXVRA_API_BASE}/api/pons?address=${encodeURIComponent(address)}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    // A transport failure is about the SITE, not about the token, so it parks
    // the reader rather than being recorded against this address.
    const why = `could not reach the site (${e && e.message ? e.message : e})`;
    park(chain, address, why);
    return { ok: false, why, info: null };
  }

  // 404 is an ANSWER about the token — Pons did not launch it. Anything else
  // non-2xx is about us, and parks.
  if (res.status === 404) {
    rememberNotPons(chain, address);
    lastFail.delete(memoKey(chain, address));
    return { ok: true, why: 'not a Pons launch', info: null };
  }
  if (!res.ok) {
    // ⚠️ THE SITE'S 503 CARRIES THE NODE'S OWN REASON, and reading only the
    // status throws it away: "site answered 503" sends an operator to look at
    // the web app for a Robinhood RPC that is rate-limiting the box. The body
    // is best-effort — a proxy's own error page has no `error` field — and it
    // is bounded, because it lands in a park sentence, the post alert and a
    // log line.
    let why = `site answered ${res.status}`;
    try {
      const body = await res.json();
      const detail = body && typeof body.error === 'string' ? body.error.trim() : '';
      if (detail) why = `${why} — ${str(detail, 160)}`;
    } catch {}
    park(chain, address, why);
    return { ok: false, why, info: null };
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    noteFail(chain, address, 'unreadable answer');
    return { ok: false, why: 'unreadable answer', info: null };
  }
  const launch = body && body.launch;
  // An answer — either kind — leaves nothing to explain about this address.
  lastFail.delete(memoKey(chain, address));
  if (!launch || !launch.address) {
    rememberNotPons(chain, address);
    return { ok: true, why: 'not a Pons launch', info: null };
  }
  return { ok: true, why: null, info: toInfo(launch) };
}

/** The long-standing shape, for callers that only ever wanted the record. */
async function fetchTokenInfo(chain, address) {
  return (await fetchTokenInfoX(chain, address)).info;
}

/** Test seam: lift the park ONLY — the memo stays, which is what lets a test
 *  prove that a non-404 was not written into it. */
const _unpark = () => {
  coolingUntil = 0;
  parkedWhy = null;
};

/** Test seam. */
const _reset = () => {
  coolingUntil = 0;
  parkedWhy = null;
  lastFail.clear();
  // ⚠️ The memo is persistent by design and the suite shares one process, so a
  // test that left it behind would answer the next test's request without a
  // fetch — the leaked-state scar this repo carries for the probe rotation and
  // the auto-trend panel. Stated here rather than inherited.
  notPons.clear();
};

module.exports = { covers, fetchTokenInfo, fetchTokenInfoX, lastWhy, httpsLogo, toInfo, _reset, _unpark };
