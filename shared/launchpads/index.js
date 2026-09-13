'use strict';
/*
 * shared/launchpads — what both bots know about a token BEFORE it migrates.
 *
 * THE HOLE THIS FILLS
 * DexScreener and GeckoTerminal index pools. A token on a bonding curve has no
 * pool, so for its entire pre-migration life — minutes to days, and the window
 * in which somebody actually asks about it — both processes in this repo were
 * blind in the same way:
 *
 *   • the trade bot answered "❌ Couldn't price it" and offered a chain picker,
 *     about a token that was trading perfectly well on its launchpad;
 *   • the trade card hardcoded `graduated: true, progressPct: 100` for EVERY
 *     Solana token, so even the ones DexScreener did index were labelled
 *     "◆ DEX" while they sat at 12% of a bonding curve;
 *   • the listing form autofilled nothing — no name, no ticker, no logo, no
 *     socials — so listing a token before it migrated meant typing all of it.
 *
 * WHY ONE MODULE FOR TWO PROCESSES
 * Because this repo has already paid for the alternative. tradebot/solana.js
 * and bot/src/marketdata.js each carried their own idea of which pump.fun host
 * was current; one was on the retired one, and Solana snipe discovery was blind
 * for days while /health printed green. Two copies of "where is pump.fun today"
 * WILL diverge. So there is one table (pads.js), one failover (http.js), and
 * both processes require it — bot/src/launchpads.js and tradebot/launchpads.js
 * are thin shims that reshape the output for their own callers, nothing more.
 *
 * Zero dependencies, deliberately: this is required by an npm package that has
 * @solana/web3.js and by one that must never load it. Node 18 global fetch only.
 *
 * CONTRACTS EVERY EXPORT KEEPS
 *   • Never throws. A launchpad outage costs a row on a card, never a trade.
 *   • "It answered with nothing" and "it did not answer" stay DIFFERENT facts —
 *     every result carries { ok, why } and a per-pad breakdown.
 *   • Display metadata only. Nothing here may price, route or authorise a swap.
 */
const http = require('./http');
const P = require('./pads');
const N = require('./normalize');

const env = (k) => String(process.env[k] == null ? '' : process.env[k]).trim();
/**
 * A numeric setting, with its default intact when the variable is not set.
 *
 * The blank check is the whole function. `Number('')` is 0 — finite, and
 * non-negative — so the obvious spelling silently replaces EVERY default with
 * zero on a box where nobody set these: the cache TTLs become 0 (no caching at
 * all, one HTTP burst per card refresh) and the breaker trips after 0 failures
 * for 0ms (never). Nothing errors and nothing logs; the module just quietly
 * stops doing the two things that keep it cheap.
 */
const int = (k, d, min) => {
  const raw = env(k);
  if (raw === '') return d;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.max(min, n) : d;
};

/** Absent or blank means ON — the whole registry, killable in one line. */
const REGISTRY_ON = () => {
  const v = env('LAUNCHPADS').toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
};

const TIMEOUT_MS = () => int('LAUNCHPAD_TIMEOUT_MS', 6000, 1000);
// A found record is cached briefly — the live monitor re-renders a card on a
// timer, and an uncached lookup here would be paid on every refresh of every
// open card. Same reasoning that put a cache in front of tokeninfo.socials.
const HIT_MS = () => int('LAUNCHPAD_CACHE_MS', 30000, 0);
// An ANSWERED "I don't know this token" is cached longer than a hit and much
// shorter than it deserves: most tokens are not on most pads, so this is the
// common case and caching it saves the bulk of the requests — but a brand-new
// mint is often 404 for the first few seconds and then known, and that is the
// exact token somebody is staring at a card for.
const MISS_MS = () => int('LAUNCHPAD_MISS_CACHE_MS', 45000, 0);
const CACHE_MAX = 3000;

// ── the breaker ──────────────────────────────────────────────────────────────
/*
 * A pad that is DOWN must cost nothing, and without this it costs the timeout
 * on every single lookup.
 *
 * The pads for a chain are asked concurrently and the caller waits for all of
 * them, so one unreachable host adds its full timeout to every card render,
 * every listing autofill and every live-monitor refresh — six seconds of dead
 * wait, for a source that has answered nothing for an hour. That is a far worse
 * outcome than the missing data itself, and it is the predictable steady state
 * for any pad whose request shape turns out to be wrong.
 *
 * So: after BREAKER_TRIPS consecutive TRANSPORT failures a pad is skipped
 * outright for BREAKER_MS, then one request is let through to see if it came
 * back. Only transport failures count — an HTTP status means the host is there
 * and answering, which is the same line `_overBases` draws for failover.
 *
 * A skipped pad is reported in `tried` with `skipped: true`, never silently
 * dropped: a source that has quietly stopped being consulted is exactly the
 * kind of thing that stays broken for months.
 */
const BREAKER_TRIPS = () => int('LAUNCHPAD_BREAKER_TRIPS', 3, 1);
const BREAKER_MS = () => int('LAUNCHPAD_BREAKER_MS', 300000, 0);

// ── state ────────────────────────────────────────────────────────────────────
let PADS = [];
let CLIENTS = new Map();   // pad key → http client (holds the sticky base)
let _fails = new Map();    // pad key → { n, until, why }
const _cache = new Map();  // 'pad:chain:addr' → { at, rec, ok, why, status }

function reload() {
  PADS = P.build();
  CLIENTS = new Map(PADS.map((p) => [p.key, http.client(p.bases, p.label)]));
  _fails = new Map();
  _cache.clear();
  return PADS;
}
reload();

/** Is this pad currently benched, and why? */
function benched(key, now) {
  const f = _fails.get(key);
  if (!f || !f.until || now >= f.until) return null;
  return f;
}
function noteFail(key, why, now) {
  const f = _fails.get(key) || { n: 0, until: 0, why: '' };
  f.n += 1;
  f.why = why;
  if (f.n >= BREAKER_TRIPS()) f.until = now + BREAKER_MS();
  _fails.set(key, f);
}
function noteOk(key) { if (_fails.has(key)) _fails.delete(key); }

const all = () => PADS;
const enabled = () => (REGISTRY_ON() ? PADS.filter((p) => p.enabled) : []);
/** Pads that can know a token on `chain`, in the order they are asked. */
const padsFor = (chain) => enabled().filter((p) => p.chains.includes(chain));
/** Which chains any enabled pad covers — callers skip the whole leg otherwise. */
const chains = () => [...new Set(enabled().flatMap((p) => p.chains))];
const padBase = (key) => { const c = CLIENTS.get(key); return c ? c.base() : null; };

/** pump.fun's base list, so tradebot/solana.js has no second copy of it.
 *  Exported by key rather than hardcoded here: a pad that gets renamed or
 *  disabled must not silently hand back an empty list to the snipe feed. */
function basesOf(key) {
  const p = PADS.find((x) => x.key === key);
  return p ? p.bases.slice() : [];
}

function _cacheGet(k, now) {
  const hit = _cache.get(k);
  if (!hit) return null;
  const ttl = hit.rec ? HIT_MS() : MISS_MS();
  return (now - hit.at < ttl) ? hit : null;
}
function _cacheSet(k, v) {
  if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
  _cache.set(k, v);
}

// ── one pad, one token ───────────────────────────────────────────────────────
/**
 * Ask a single pad about a single token.
 *
 * Returns `{ pad, ok, why, status, rec }` and NEVER throws. The three outcomes
 * are kept apart on purpose:
 *   ok:true,  rec:<record>  — it knows the token
 *   ok:true,  rec:null      — it answered and does not know it (incl. a 404)
 *   ok:false, rec:null      — it did not answer; `why` says what happened
 * A caller that collapses the second and third has thrown away the difference
 * between "not a launchpad token" and "the launchpad is down", which is the
 * defect this whole repo keeps re-learning.
 */
async function padToken(pad, chain, address, now) {
  const key = pad.key + ':' + chain + ':' + N.addrKey(chain, address);
  const cached = _cacheGet(key, now);
  if (cached) return { pad: pad.key, ok: cached.ok, why: cached.why, status: cached.status, rec: cached.rec, cached: true };

  const c = CLIENTS.get(pad.key);
  const out = { pad: pad.key, ok: false, why: '', status: 0, rec: null, cached: false };
  if (!c) { out.why = 'pad not built'; return out; }

  const bench = benched(pad.key, now);
  if (bench) {
    out.skipped = true;
    out.why = `${pad.label}: skipped, ${bench.n} failures in a row (${bench.why}) — retrying in ${Math.round((bench.until - now) / 1000)}s`;
    return out;
  }

  // ⚠️ A 404 IS ABOUT THIS SPELLING, NOT ABOUT THE HOST — so it tries the next
  // path rather than ending the lookup. That is the one place the standing
  // transport-only failover rule does not apply, and for its own stated reason:
  // "the same request gets the same status everywhere else" is true of moving
  // to another HOST and false of asking the same host for a different
  // RESOURCE. Every other status stops here, exactly as before: a 429 or a 500
  // says nothing about which spelling is right, and retrying three more would
  // spend three more requests proving the same refusal.
  //
  // A pad with one path behaves identically to before; `pads.js pathList` is
  // where a list comes from, and an operator's pin replaces it.
  const paths = Array.isArray(pad.tokenPaths) && pad.tokenPaths.length ? pad.tokenPaths : [pad.tokenPath];
  let r = null;
  for (const tpl of paths) {
    r = await http.getJson(c, P.fill(tpl, { id: address }), { timeoutMs: TIMEOUT_MS() });
    if (r.ok || r.status !== 404) break;
  }
  out.status = r.status;
  if (!r.ok) {
    // Every spelling answered 404: the launchpad has never heard of this token
    // — a fact about the token, not about the host.
    if (r.status === 404) {
      noteOk(pad.key);
      out.ok = true;
      _cacheSet(key, { at: now, rec: null, ok: true, why: '', status: 404 });
      return out;
    }
    out.why = `${pad.label}: ${r.why}`;
    // Only a TRANSPORT failure benches a pad. A 429 or a 500 means the host is
    // there; benching on those would take a rate-limited source out for five
    // minutes over one bad second.
    if (r.status === 0) noteFail(pad.key, r.why, now); else noteOk(pad.key);
    return out;   // NOT cached: caching a throttled miss spreads one bad second across the next minute
  }
  noteOk(pad.key);
  out.ok = true;
  let raw = null;
  try { raw = P.one(r.json, chain, address, pad.idKeys || P.ID_KEYS); } catch (_) { raw = null; }
  if (raw) {
    try {
      const rec = pad.parse(pad, chain, raw, now);
      // A record that NAMES a different token is somebody else's. A pad that
      // ignores its own filter would otherwise put a stranger's name, socials
      // and market cap on this token's card, directly above live Buy buttons —
      // the same guard, for the same reason, as poolstrade.js.
      //
      // A record that names NO token is kept: `one()` already matched this
      // response to the address we asked for, and dropping it would discard a
      // correct answer from any pad that simply does not echo the mint back.
      const named = rec && rec.address;
      out.rec = (rec && (!named || N.sameAddress(chain, rec.address, address))) ? { ...rec, address } : null;
    } catch (e) { out.rec = null; out.why = `${pad.label}: unreadable response (${(e && e.message) || 'parse failed'})`; }
  }
  _cacheSet(key, { at: now, rec: out.rec, ok: true, why: out.why, status: r.status });
  return out;
}

// ── merge ────────────────────────────────────────────────────────────────────
// Scalar fields: first pad in table order that has a real value. The order is
// the table's, so it is reviewable in one place rather than emerging from
// whichever request happened to finish first.
const SCALARS = [
  'name', 'symbol', 'description', 'logoUrl', 'website', 'twitter', 'telegram',
  'priceUsd', 'mcapUsd', 'liqUsd', 'vol24Usd', 'holders', 'creator', 'createdAt',
  'raisedNative', 'targetNative', 'nativeSym', 'launchUrl',
];

/** How much a pad's curve answer is worth. Facts outrank estimates. */
function curveRank(r) {
  if (!r) return 0;
  // A migration POOL is evidence; a percentage is a reading. A token that has
  // demonstrably migrated must never render a bonding badge just because
  // another pad still has a stale 42% on file.
  if (r.migratedPool && r.graduated === true) return 4;
  if (r.progressSource === 'graduated') return 3;
  if (r.progressSource === 'api') return 2;
  if (r.progressSource === 'derived') return 1;
  return r.graduated != null ? 1 : 0;
}

/**
 * One record from several pads.
 *
 * Curve state is chosen WHOLE from the best-ranked pad rather than assembled
 * field by field: `graduated`, `progressPct` and `onCurve` have to agree with
 * each other, and taking "graduated" from one source and "42%" from another
 * produces a card that contradicts itself in two places at once — which is
 * exactly the bug the buy card's two ideas of "whale" already cost this repo.
 */
function merge(recs) {
  const list = recs.filter(Boolean);
  if (!list.length) return null;
  const out = { ...P.blank({ key: list[0].pad, label: list[0].padLabel }, list[0].chain, list[0].address) };
  out.pads = list.map((r) => r.pad);
  out.source = 'launchpad:' + list.map((r) => r.pad).join('+');
  for (const f of SCALARS) {
    for (const r of list) { if (r[f] !== null && r[f] !== undefined) { out[f] = r[f]; break; } }
  }
  // The launchpad NAME: prefer one that names an actual pad over a pad naming
  // itself. Jupiter reporting `launchpad: "bonk.fun"` is more informative than
  // the letsbonk adapter reporting "LetsBonk", and far more informative than
  // nothing when neither specific pad answered.
  for (const r of list) { if (r.launchpad) { out.launchpad = r.launchpad; break; } }

  const best = list.slice().sort((a, b) => curveRank(b) - curveRank(a))[0];
  if (curveRank(best) > 0) {
    out.onCurve = best.onCurve;
    out.graduated = best.graduated;
    out.progressPct = best.progressPct;
    out.progressSource = best.progressSource;
    out.migratedPool = best.migratedPool;
    out.curvePad = best.pad;
  }
  // Pads that disagreed, so a check script or an operator can see it. Silence
  // about a contradiction is how a wrong number survives for months.
  const seen = list.filter((r) => curveRank(r) > 0 && r.progressPct != null);
  if (seen.length > 1) {
    const spread = Math.max(...seen.map((r) => r.progressPct)) - Math.min(...seen.map((r) => r.progressPct));
    if (spread > 5) out.progressDisagreement = seen.map((r) => `${r.pad}=${r.progressPct.toFixed(0)}%`).join(' ');
  }
  return out;
}

// ── public: one token ────────────────────────────────────────────────────────
/**
 * Everything the launchpads know about `address` on `chain`.
 *
 * @returns {Promise<{record: object|null, ok: boolean, why: string, tried: Array}>}
 *   record — merged, or null when no pad knows it
 *   ok     — at least one pad ANSWERED (whether or not it knew the token)
 *   why    — why nobody answered, when nobody did
 *   tried  — per-pad outcome, for the check script and the watchdog
 */
async function tokenRecord(chain, address, opts) {
  const now = (opts && Number.isFinite(opts.now)) ? opts.now : Date.now();
  const pads = padsFor(chain).filter((p) => !(opts && opts.only) || opts.only.includes(p.key));
  const out = { record: null, ok: false, why: '', tried: [] };
  if (!pads.length) { out.ok = true; out.why = 'no launchpad covers ' + chain; return out; }
  if (!N.isAddress(chain, address)) { out.ok = true; out.why = 'not a ' + chain + ' address'; return out; }

  const results = await Promise.all(pads.map((p) => padToken(p, chain, address, now).catch((e) => ({
    // padToken is written not to throw; this is the belt to its braces, because
    // a monitor or a card that can be crashed by a launchpad is worse than one
    // that shows a blank row.
    pad: p.key, ok: false, why: `${p.label}: ${(e && e.message) || 'failed'}`, status: 0, rec: null,
  }))));
  out.tried = results.map((r) => ({ pad: r.pad, ok: r.ok, why: r.why, status: r.status, found: !!r.rec, cached: !!r.cached, skipped: !!r.skipped }));
  out.ok = results.some((r) => r.ok);
  if (!out.ok) out.why = results.map((r) => r.why).filter(Boolean).join('; ') || 'no launchpad answered';
  out.record = merge(results.map((r) => r.rec));
  return out;
}

/** The merged record, or null. For callers that only want the data. */
async function record(chain, address, opts) {
  try { return (await tokenRecord(chain, address, opts)).record; } catch (_) { return null; }
}

// ── public: new launches ─────────────────────────────────────────────────────
/**
 * Recently-created tokens, newest first, from every pad on `chain` that has a
 * feed.
 *
 * `byPad` is returned alongside the merged list because the Solana snipe keeps
 * a cursor PER PAD. One shared cursor over a merged feed means a single pad
 * emitting a bad timestamp advances the cursor past every real launch from
 * every other pad, and the snipe then goes quiet forever — indistinguishable,
 * from outside, from a slow day on the launchpads. (normalize.toMs already
 * refuses a future timestamp; the per-pad cursor is the second line.)
 */
async function newLaunches(chain, limit, opts) {
  const now = (opts && Number.isFinite(opts.now)) ? opts.now : Date.now();
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const pads = padsFor(chain).filter((p) => p.feedPath && (!(opts && opts.only) || opts.only.includes(p.key)));
  const out = { items: [], byPad: {}, ok: false, why: '' };
  if (!pads.length) { out.why = 'no launchpad feed for ' + chain; return out; }

  const results = await Promise.all(pads.map(async (pad) => {
    const c = CLIENTS.get(pad.key);
    if (!c) return { pad: pad.key, ok: false, why: 'pad not built', items: [] };
    // `force` bypasses the breaker: the watchdog's job is to measure the HOST,
    // and reporting our own local circuit state back as "the launchpad is down"
    // would make the alert self-fulfilling and unrecoverable.
    const bench = (opts && opts.force) ? null : benched(pad.key, now);
    if (bench) return { pad: pad.key, ok: false, skipped: true, items: [], why: `${pad.label}: skipped, ${bench.n} failures in a row (${bench.why}) — retrying in ${Math.round((bench.until - now) / 1000)}s` };
    const r = await http.getJson(c, P.fill(pad.feedPath, { n }), { timeoutMs: TIMEOUT_MS() }).catch((e) => ({
      ok: false, status: 0, json: null, why: (e && e.message) || 'unreachable',
    }));
    if (!r.ok) {
      if (r.status === 0) noteFail(pad.key, r.why, now); else noteOk(pad.key);
      return { pad: pad.key, ok: false, why: `${pad.label}: ${r.why}`, items: [] };
    }
    noteOk(pad.key);
    let items = [];
    try {
      items = P.rows(r.json, P.LIST_KEYS)
        .map((raw) => { try { return pad.parse(pad, chain, raw, now); } catch (_) { return null; } })
        .filter((rec) => rec && N.isAddress(chain, rec.address));
    } catch (_) { items = []; }
    return { pad: pad.key, ok: true, why: '', items };
  }));

  for (const r of results) out.byPad[r.pad] = r;
  out.ok = results.some((r) => r.ok);
  if (!out.ok) out.why = results.map((r) => r.why).filter(Boolean).join('; ') || 'no launchpad feed answered';

  // Merged view: newest first, one entry per address. A token on two pads keeps
  // the first pad's record in table order rather than the newer timestamp —
  // "which pad do we trust" is a decision that belongs in the table, not to a
  // race between two HTTP responses.
  const seen = new Set();
  for (const pad of pads) {
    const r = out.byPad[pad.key];
    for (const it of (r ? r.items : [])) {
      const k = N.addrKey(chain, it.address);
      if (seen.has(k)) continue;
      seen.add(k);
      out.items.push(it);
    }
  }
  out.items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

// ── public: watchdog probes ──────────────────────────────────────────────────
/**
 * Probe specs for tradebot/upstreams.js.
 *
 * `costs` says what the USER loses, not which host is down: "lite-api.jup.ag
 * ENOTFOUND" does not tell an operator whether to stop the bot or finish
 * dinner. None of these is `critical` — a dead launchpad costs pre-migration
 * DATA, and an alert where everything is critical has no priority in it. A
 * trade still prices and routes through the aggregator with every pad down.
 *
 * `run` throws on failure and returns a one-line detail on success; the caller
 * wraps it in its own timeout guard.
 */
function probes() {
  return enabled().filter((p) => p.feedPath).map((pad) => ({
    key: 'launchpad.' + pad.key,
    label: pad.label + ' launches',
    critical: false,
    // The consequence, with NO host and no pad name in it — `label` above is
    // where the identity belongs. tradebot/upstreams.test.js enforces the split
    // ("every probe says what the USER loses"), and interpolating a pad called
    // "pump.fun" or "four.meme" here would smuggle a hostname back into the one
    // line that exists to avoid one.
    costs: 'tokens launched on this pad show no price, no bonding progress and no socials until they migrate',
    run: async () => {
      const r = await newLaunches(pad.chains[0], 5, { only: [pad.key], force: true });
      const mine = r.byPad[pad.key];
      if (!mine || !mine.ok) throw new Error((mine && mine.why) || r.why || 'feed unreachable');
      if (!mine.items.length) throw new Error('feed answered but returned nothing — check the response shape, not the network');
      return `${mine.items.length} launches via ${padBase(pad.key) || '?'}`;
    },
  }));
}

module.exports = {
  tokenRecord, record, newLaunches, probes,
  all, enabled, padsFor, chains, padBase, basesOf, reload,
  _test: { merge, curveRank, padToken, SCALARS },
};
