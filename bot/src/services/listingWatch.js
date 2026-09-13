'use strict';
/*
 * IS AUTO-LISTING ACTUALLY PUBLISHING — and if not, for how long, and why?
 *
 * WHY THIS EXISTS. "free listing di admin bot tidak bekerja, sebelumnya
 * bekerja" (2026-08-28), and there was no way to answer it from anywhere: the
 * panel read 🟢 ON, the scan line read `40 candidates · 40 priced · 0 listed`,
 * and that sentence is what BOTH a quiet market and a site refusing every
 * single create look like. The blocked-scan watchdog in `autoLister.fileReport`
 * is deliberately narrow — it fires only when a scan could not RUN — so the
 * whole class of "it ran perfectly and could never have listed anything" was
 * outside every alarm the service had.
 *
 * The causes will keep changing (this is the same shape as the trending board's
 * three-round "minimal harus 5" saga, one service over), so what is watched is
 * the SYMPTOM, which is the promise the operator set when they switched it on:
 *
 *     while Auto-Listing is ON, free listings actually go out.
 *
 * Rules, borrowed from `trendingWatch.js`, which borrowed them from
 * `upstreams.js`, which had to learn them the hard way:
 *   • alert on the TRANSITION, after a long grace — a quiet afternoon is not an
 *     incident, and an alert every scan is a channel nobody reads by the second
 *     hour;
 *   • a RECOVERY is an alert too, or a fixed feed and a forgotten one are
 *     indistinguishable;
 *   • it REPEATS while it stays quiet — one message on day one is scrolled past
 *     by day three;
 *   • the message names WHICH of the causes it is, and says when the answer is
 *     "nothing is wrong, the market had nothing" — a monitor that cries fault at
 *     a quiet market is a monitor that gets muted, which is how the trade bot's
 *     "possible rug" alert had to be deleted rather than tuned.
 *
 * PURE. The caller owns persistence and sending, so a test can walk the service
 * through days of scans in milliseconds.
 */

/** How long the feed may be silent before it is worth a word. Deliberately long:
 *  the shipped pace is one listing every 2–3h, and a market that hands us
 *  nothing for an afternoon is ordinary. */
const GRACE_MS = Math.max(60 * 60_000, Number(process.env.LISTING_QUIET_GRACE_MS) || 12 * 60 * 60_000);
/** …and how often to say it again while it stays quiet. */
const REPEAT_MS = Math.max(GRACE_MS, Number(process.env.LISTING_QUIET_REPEAT_MS) || 24 * 60 * 60_000);

/** The dominant entry of a `{text: count}` tally, or null. */
function top(tally) {
  const rows = Object.entries(tally || {});
  if (!rows.length) return null;
  rows.sort((a, b) => b[1] - a[1]);
  return { text: rows[0][0], n: rows[0][1] };
}

/**
 * Why has nothing been listed, in the operator's terms — and what fixes it.
 *
 * Read off the LAST SCAN REPORT rather than re-derived: the scan already
 * answered this question at the moment it happened, and a watch that asked it a
 * second way would eventually disagree with the panel line printed right above
 * it — which is exactly how `fonts:check` came to print nine green ticks over a
 * banner publishing boxes.
 *
 * `fault` separates "something is wrong" from "the service is working and the
 * market had nothing". Both are worth telling an operator who switched this on
 * and is watching an empty feed; only one is a bug.
 */
function diagnose(scan) {
  if (!scan) {
    return {
      code: 'no_scan',
      fault: true,
      text:
        'the scanner has never filed a report — the loop is not running. ' +
        'Check the [monitoring] lines in pm2 logs for a service that failed to start.',
    };
  }
  // The blocked-scan watchdog owns this one and has already paged with the
  // exact error. Naming it here as well would be two alerts for one fault.
  if (scan.blocker) {
    return { code: 'blocked', fault: true, text: `the last scan could not run: ${scan.blocker}`, ownedElsewhere: true };
  }
  if (scan.refused) {
    const t = top(scan.refusals);
    return {
      code: 'refused',
      fault: true,
      text:
        `the site turned down ${scan.refused} listing(s) that had already qualified` +
        (t ? ` — ${t.text}` : '') +
        '. That is not the market: check DEXVRA_API_BASE + INTERNAL_API_TOKEN, then 🔎 Test scan.',
    };
  }
  // ⚠️ ABOVE the market-rejection branch: "we could not ask" outranks "nothing
  // qualified", and reading the second over the top of the first is exactly
  // what sent an operator hunting for a quiet market while a host refused the
  // box. The filler's-own-reason rule from `trendingWatch.diagnose`.
  if (scan.unpriced && scan.unpriced === scan.priced && scan.priced > 0) {
    const t = top(scan.unpricedWhy);
    return {
      code: 'unpriceable',
      fault: true,
      text:
        `not one candidate could be priced (${scan.unpriced} of ${scan.priced})` +
        (t ? ` — ${t.text}` : '') +
        '. That is the pricing source, not the market — `npm run listing:check` measures it on this box.',
    };
  }
  if (scan.capped) {
    return {
      code: 'capped',
      fault: false,
      text: `the daily cap (${scan.capped}) is what stopped the last scan — raise 🔢 /day if you want more.`,
    };
  }
  if (scan.unsupported && !scan.priced) {
    return {
      code: 'unsupported_chain',
      fault: true,
      text:
        `every candidate the last scan saw was on a chain it could not resolve (${scan.unsupported}). ` +
        'That is the DexScreener slug map, not the market — run `npm run listing:check`.',
    };
  }
  if (scan.offChain && !scan.priced) {
    return {
      code: 'off_chain',
      fault: false,
      text:
        `every candidate was outside your 🌐 chain scope (${scan.offChain} skipped). ` +
        'Widen the scope, or accept that this chain publishes rarely.',
    };
  }
  if (scan.known && !scan.priced) {
    return {
      code: 'all_known',
      fault: false,
      text:
        `every candidate is already on the site or in the never-relist ledger (${scan.known}). ` +
        'Nothing new has appeared in the feeds — 🧹 Clear history only if you have also wiped the site.',
    };
  }
  const why = top(scan.reasons);
  if (why) {
    return {
      code: 'nothing_qualified',
      fault: false,
      text:
        `the last scan priced ${scan.priced} and none qualified — mostly "${why.text}" (×${why.n}). ` +
        'Nothing is broken; lower 🎯/💧/📊 if the bar is higher than this market reaches.',
    };
  }
  // Paced is checked LAST on purpose: the pace is a legitimate reason for a
  // scan to list nothing and never a reason for a whole grace period of
  // silence, so reaching here means the wait is not the explanation.
  if (scan.paced) {
    return {
      code: 'paced_but_quiet',
      fault: true,
      text:
        'the pace clock says a listing is not due — but it has been quiet far longer than the band allows. ' +
        'Check ⏳ Pace on the panel; `npm run listing:check` reads the same clock.',
    };
  }
  return {
    code: 'unknown',
    fault: true,
    text: `the last scan saw ${scan.candidates} candidate(s), priced ${scan.priced} and listed none, with no reason recorded.`,
  };
}

/**
 * Fold one scan into the watch state and return the alerts to send.
 *
 * @param {object} snap
 *   enabled     — is the service switched on
 *   lastListAt  — ms of the last free listing this service published, or null
 *   scan        — the report just filed (autoLister.blank() shape)
 * @param {object} prev  state.watch from the store
 */
function evaluate(snap, prev = {}, { now = Date.now(), graceMs = GRACE_MS, repeatMs = REPEAT_MS } = {}) {
  const was = prev && (prev.since || prev.alertedAt) ? prev : null;
  // Switched off is not a symptom — it is the operator's own decision, and
  // alerting on it would be the panel telling somebody what they just did. The
  // state is dropped so that switching back on starts a fresh clock rather than
  // paging instantly for the hours it spent off.
  if (!snap.enabled) return { state: {}, alerts: [] };

  // A listing since the last look. Announce the recovery only if we complained
  // — a feed that healed before anyone was told says nothing at all.
  const listedSince = snap.lastListAt != null && was && was.since != null && snap.lastListAt >= was.since;
  if (listedSince) {
    return {
      state: {},
      alerts: was.alertedAt ? [{ kind: 'listing_ok', text: '✅ <b>Auto-Listing is publishing again</b> — a free listing just went out.' }] : [],
    };
  }

  // ⚠️ THE ANCHOR IS "when did we last KNOW a listing happened", and on every
  // install that upgrades `lastListAt` is null — so falling back to `now` on the
  // first look is what stops this paging about the hours before it existed.
  const since = was && was.since != null ? was.since : snap.lastListAt != null ? snap.lastListAt : now;
  const quietFor = now - since;
  const entry = { since };
  if (quietFor < graceMs) return { state: entry, alerts: [] };

  const why = diagnose(snap.scan);
  // The blocked-scan watchdog already paged with the verbatim error. Keep the
  // clock running (so the recovery still fires) and stay quiet.
  if (why.ownedElsewhere) return { state: { ...entry, alertedAt: was && was.alertedAt }, alerts: [] };

  const alertedAt = was && was.alertedAt;
  if (alertedAt && now - alertedAt < repeatMs) return { state: { ...entry, alertedAt }, alerts: [] };

  const hours = Math.round(quietFor / 3_600_000);
  return {
    state: { ...entry, alertedAt: now },
    alerts: [
      {
        kind: why.fault ? 'listing_stuck' : 'listing_quiet',
        code: why.code,
        text:
          (why.fault
            ? `⚠️ <b>Auto-Listing is ON and has published nothing for ${hours}h</b>\n`
            : `ℹ️ <b>Auto-Listing has published nothing for ${hours}h</b>\n`) +
          `${why.text}` +
          (why.fault ? '' : '\n<i>The service is running correctly — this is what it found.</i>'),
      },
    ],
  };
}

module.exports = { evaluate, diagnose, GRACE_MS, REPEAT_MS };
