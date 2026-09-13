'use strict';
/*
 * One HTTP request across a LIST of bases, and an error that says why.
 *
 * This is a faithful copy of tradebot/solana.js `netErr` + `_overBases`, and
 * the copy is deliberate: CLAUDE.md's rule is "copy it, do not write a fourth
 * private idea of failure". solana.js cannot be required from bot/ (it pulls in
 * @solana/web3.js and a keypair stack that the listing bot has no business
 * loading), so the SHAPE travels instead of the module, with the contract kept
 * identical — `err.offline`, `err.host`, `err.code`.
 *
 * The two rules that matter, both of them outages that already happened here:
 *
 *   • FAIL OVER ON A TRANSPORT ERROR ONLY. An HTTP status means the host is
 *     there and answered; the same request gets the same status from every
 *     other base, so retrying it elsewhere just doubles the latency of a
 *     request that was always going to fail.
 *   • NEVER DISCARD THE REASON. undici throws `TypeError: fetch failed` for
 *     every transport failure and puts the only useful part — the syscall code —
 *     in `err.cause`. "fetch failed" reached a user's buy card five times
 *     because someone read `e.message` and stopped there.
 */

const _fetch = (...a) => (global.fetch ? global.fetch(...a) : Promise.reject(new Error('fetch unavailable')));

/** A transport failure, explained. Carries `.offline` so callers classify on
 *  the flag instead of matching this text again somewhere else. */
function netErr(e, url) {
  let host = url;
  try { host = new URL(url).host; } catch (_) {}
  const c = (e && e.cause) || {};
  const code = c.code || c.errno || (e && e.code) || '';
  const why = (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? 'no answer before the timeout'
    : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'the name does not resolve from this server'
      : code === 'ECONNREFUSED' ? 'connection refused'
        : code === 'ECONNRESET' ? 'connection reset'
          : code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' ? 'connection timed out'
            : /CERT|SSL|TLS/i.test(String(code)) ? 'TLS failed (' + code + ')'
              : code || (c.message || (e && e.message) || 'unknown');
  const err = new Error(`can't reach ${host} — ${why}`);
  err.offline = true;
  err.host = host;
  err.code = code || undefined;
  return err;
}

/**
 * A tiny stateful client over a base list. `sticky` remembers which base last
 * answered so the healthy host is tried first, rather than paying the dead
 * one's connect timeout on every single request.
 */
function client(bases, label) {
  const list = (Array.isArray(bases) ? bases : []).filter(Boolean);
  let sticky = null;
  return {
    bases: list,
    /** Which base actually answered, for the check script and the watchdog. */
    base: () => sticky,
    /** Raw Response, or throw. Transport-only failover; see the header. */
    async fetch(path, init) {
      if (!list.length) throw new Error(`no ${label} base configured`);
      const order = sticky ? [sticky, ...list.filter((b) => b !== sticky)] : list;
      let last = null;
      for (const base of order) {
        const url = base + path;
        try {
          const r = await _fetch(url, init);
          sticky = base;
          return r;
        } catch (e) {
          if (sticky === base) sticky = null;
          last = netErr(e, url);
        }
      }
      throw last || new Error(`no ${label} base configured`);
    },
  };
}

/**
 * What the host actually SAID when it refused.
 *
 * A bare status is the same defect as undici's bare "fetch failed":
 * "swap-build failed (500)" was true, useless, and hiding "Token account … is
 * owned by … instead of the user". Bounded, because a launchpad returning an
 * HTML error page must not paste a kilobyte of markup into an ops alert.
 */
async function why(r) {
  try {
    const t = (await r.text()).slice(0, 300).replace(/\s+/g, ' ').trim();
    if (!t) return '';
    try { const j = JSON.parse(t); return ' — ' + (j.error || j.message || j.msg || j.errorCode || t); }
    catch (_) { return ' — ' + t; }
  } catch (_) { return ''; }
}

/**
 * GET JSON with the `{ ok, why }` contract this repo settled on.
 *
 * "It answered with nothing" and "it did not answer" are DIFFERENT FACTS, and
 * collapsing them into one empty array is what let pump.fun discovery sit blind
 * for days behind a green health tick. `ok` is whether the host answered at
 * all; the body is separate; `why` is filled on every failure and never on
 * success. `status` is 0 for a transport failure — there was no status.
 */
async function getJson(c, path, { timeoutMs = 6000, headers } = {}) {
  let r;
  try {
    r = await c.fetch(path, {
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
      headers: { accept: 'application/json', ...(headers || {}) },
    });
  } catch (e) {
    return { ok: false, status: 0, json: null, why: (e && e.message) || 'unreachable', base: c.base() };
  }
  if (!r.ok) {
    // A 404 is an ANSWER: this launchpad does not know this token. Every other
    // status is the host having a problem. Callers need to tell those apart —
    // one is a fact about the token, the other a fact about the server — so the
    // status rides along rather than being folded into a boolean.
    return { ok: false, status: r.status, json: null, why: `answered ${r.status}${await why(r)}`, base: c.base() };
  }
  try {
    return { ok: true, status: r.status, json: await r.json(), why: '', base: c.base() };
  } catch (e) {
    return { ok: false, status: r.status, json: null, why: 'answered 200 with a body that is not JSON', base: c.base() };
  }
}

module.exports = { client, getJson, netErr, why, _fetch };
