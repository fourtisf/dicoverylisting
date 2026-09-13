'use strict';
/*
 * IS ANY CHAIN UNDER ITS MINIMUM RIGHT NOW — and if so, for how long, and why?
 *
 * WHY THIS EXISTS. "Trending base dan ethereum sangat sedikit" was reported
 * three times in two days, and each time the CAUSE was different:
 *
 *   1. the chain had no listings left to promote        → the market filler
 *   2. the filler fired on a red day and would have      → gate it on listing
 *      listed dozens of tokens                             scarcity only
 *   3. `min +5% 24h` refused every spare, so the board   → the minimum outranks
 *      sat under the floor with nothing able to fix it      the gain floor
 *
 * Three fixes, one symptom — and in all three the OPERATOR was the detector.
 * They read the channel, counted rows, and asked. Nothing in the bot ever said
 * "Ethereum has been under 5 for two hours"; the closest thing was one advisory
 * log line, at noise level, aimed at somebody reading pm2.
 *
 * So this watches the SYMPTOM. Causes will keep changing — a fourth one will
 * turn up — and the thing worth alerting on is the promise the operator set:
 * every configured chain carries at least `perChainMin` tokens.
 *
 * Rules it is built under, all borrowed from `upstreams.js`, which had to learn
 * them the same way:
 *   • alert on the TRANSITION, after a grace period — a chain that is short for
 *     one cycle while a slot rolls over is not an incident, and an alert every
 *     cycle is a channel nobody reads by the second hour;
 *   • a RECOVERY is an alert too, or the operator cannot tell a fixed board
 *     from a forgotten one;
 *   • the message says what the OPERATOR can do, and names which of the causes
 *     it is — "short" alone sends them to the same three-round investigation.
 */

/** How long a chain must stay under its floor before it is worth saying. */
const GRACE_MS = Math.max(60_000, Number(process.env.TREND_SHORT_GRACE_MS) || 45 * 60_000);
/** …and how often to repeat while it stays short. A board short for a week must
 *  not be one alert on day one that everybody has scrolled past. */
const REPEAT_MS = Math.max(GRACE_MS, Number(process.env.TREND_SHORT_REPEAT_MS) || 12 * 60 * 60_000);

/**
 * Why is this chain short, in the operator's terms — and what fixes it.
 *
 * The three causes need three different answers, and telling them apart is
 * exactly what took three rounds. `fill` is what the market filler reported for
 * this chain on the last pass, when it ran.
 */
function diagnose({
  featured,
  floor,
  eligible = 0,
  fillWhy = null,
  gainFloor = 0,
  floorRefused = 0,
  // How many spares this cycle could not price at all — an upstream fact, and
  // deliberately NOT folded into `floorRefused`: they need different answers.
  unread = 0,
  // How many of `eligible` the ranking pass actually OPENED, or null when the
  // caller did not measure it. The probe budget is bounded and its window
  // ROTATES, so on a chain with hundreds of listings a pass judges a SLICE —
  // and every count below was being read against the whole chain. `null` keeps
  // the old wording for a caller that cannot say.
  considered = null,
  // The gates BELOW the floors, counted over the rows that CLEARED them, plus
  // the one that is not a refusal at all — a booking the site declined. See the
  // ladder below for why a bare `floorRefused` was the wrong answer.
  freeFall = 0,
  noReading = 0,
  bookFailed = 0,
  bookWhy = null,
  // ⚠️ THE RENDERED PHRASE, not the two numbers. This branch used to format
  // them itself and printed `min cap $0` for a floor the operator had switched
  // OFF — accusing their tokens of failing a floor of nothing. `fmtCap(0)` is
  // `"$0"`, and `autoTrend.floorsPhrase` is the one place that knows 0 means
  // "not named at all". This module stays pure; the caller hands it the words.
  floorsText = '',
}) {
  if (featured >= floor) return null;
  // The FILLER'S OWN REASON OUTRANKS THE COUNT. It is the most specific fact
  // available, and it is only ever set on a chain the cycle actually tried to
  // fix — reading `eligible` first would answer "there are spares here" over
  // the top of "GT is rate-limited", which is the reading that sends somebody
  // to list tokens by hand.
  if (fillWhy) {
    return {
      code: 'fill_failed',
      text:
        `the market fill could not help: ${fillWhy}` +
        (eligible > 0 ? ` (${eligible} spare listing(s) here, none of them promotable)` : ' (no spare listings here either)'),
    };
  }
  // ⚠️ WHICH REFUSAL, NOT JUST HOW MANY SPARES. This sits ABOVE
  // `spares_unusable` because it is the more specific fact and because that
  // branch's text asserts "−15%" — a sentence that is simply false about a
  // chain whose spares were refused for a $0.05 volume, and it is the sentence
  // an operator would act on. `floorRefused` is counted by the promoter on the
  // pass that refused them, so it can only be non-zero when a cycle has run.
  // ⚠️ ABOVE the floor branch: "we could not read the market" outranks "your
  // tokens are too small", and reporting the second over the first is what
  // sends an operator to change a setting over an upstream that refused us.
  // GT's free tier is ~30 req/min per IP and this box shares it with the
  // website, so a cycle losing most of its reads is ordinary — and the board
  // then carries only as many rows as the read happened to answer for.
  // ⚠️ AGAINST THE WINDOW, NOT AGAINST THE CHAIN. `unread` is counted among the
  // rows this pass OPENED, and comparing it to every spare on the chain made
  // this branch unreachable on exactly the busy chains it matters for: 40
  // opened, 40 unreadable, 200 spares → `40 >= 200` is false, and a total
  // upstream failure was then reported as "your tokens are below the floors".
  const judged = considered != null ? considered : eligible;
  const rest = considered != null && eligible > considered ? eligible - considered : 0;
  const restNote = rest > 0
    ? ` The other ${rest} spare(s) have not been opened yet — the probe window rotates, so the next passes reach them.`
    : '';
  if (unread > 0 && unread >= judged) {
    return {
      code: 'unpriced',
      text:
        `${unread} spare listing(s) opened here could not be PRICED at all — the market read failed, not the tokens. ` +
        `That is the shared GeckoTerminal quota, not your floors: GECKOTERMINAL_API_KEY raises the ceiling ` +
        `(see the [gt] boot line), and \`npm run trending:check\` measures it on the box.` + restNote,
    };
  }
  // ⚠️ A BOOKING THE SITE REFUSED IS NOT A SHORTAGE OF CANDIDATES. It is the
  // most specific fact available and the only one on this list that is not
  // about the tokens at all — the promoter picked a row, called the site, and
  // was told no. It outranks everything below for the same reason the filler's
  // own reason outranks the spare count.
  if (bookFailed > 0) {
    return {
      code: 'book_failed',
      text:
        `${bookFailed} promotion(s) were picked here and the SITE refused the booking` +
        (bookWhy ? `: ${bookWhy}` : '') +
        `. That is not a shortage of candidates and no floor will fix it — check INTERNAL_API_TOKEN and ` +
        `\`pm2 logs dexvra-bot | grep autotrend\` for the refusal.`,
    };
  }
  // ⚠️ THE DOMINANT REFUSAL, AND WHETHER IT ACCOUNTS FOR ALL OF THEM.
  //
  // This used to return `below_floors` the moment `floorRefused` was non-zero,
  // so a live board showed `Ethereum 4/5 · 10 of 18 opened are below the floors`
  // under "they are below the floors, and none went on" — about a chain where
  // EIGHT of the opened spares had CLEARED the floors and something else
  // refused them. A cause that does not account for the shortfall is the wrong
  // cause, and it is the one an operator acts on. `trendFill`'s `why` ladder
  // has reported the dominant counter for exactly this reason since it was
  // written; the promoter never got it.
  const worst = [
    { n: floorRefused, code: 'below_floors', what: `below the free-trending floors (${floorsText || 'see ⚙️ Auto-Trend'})`,
      fix: `That is the filter doing its job: a dead token is not a trending row. The next cycle lists a big-cap to cover the gap while 🧲 Fill from market is ON — or lower 🏦/📊 on ⚙️ Auto-Trend if these floors are too strict for this chain.` },
    { n: freeFall, code: 'free_fall', what: `below −15%, the one thing never auto-promoted`,
      fix: `The next cycle lists a big-cap to cover it while 🧲 Fill from market is ON.` },
    { n: noReading, code: 'no_reading', what: `carrying no 24h reading — a trending row without a percentage is not a trending row`,
      fix: `That is the shared market quota more often than the token: GECKOTERMINAL_API_KEY raises the ceiling.` },
  ].sort((a, b) => b.n - a.n)[0];
  const refusedTotal = floorRefused + freeFall + noReading;
  if (worst.n > 0) {
    return {
      code: worst.code,
      text:
        `${worst.n === refusedTotal ? `${worst.n} spare listing(s) opened here, and none went on — they are` : `${worst.n} of the ${refusedTotal} spare(s) opened here are`} ` +
        `${worst.what}. ${worst.fix}` + restNote,
    };
  }
  if (eligible > 0) {
    // ⚠️ A CAUSE NOBODY MEASURED IS NOT A CAUSE.
    //
    // The branch below asserts "they are below −15%", which is the one reading
    // left once the floors and the upstream have been ruled OUT — and both of
    // those are ruled out by counts a caller has to have MEASURED. A caller
    // that priced nothing hands over `floorRefused: 0, unread: 0` because it
    // never looked, not because it looked and found none, and this then told
    // the operator a confident cause for all of them. The live run said it
    // about 63 Robinhood spares and 75 on another chain, from a `trending:check`
    // that had not opened a single row.
    //
    // `considered == null` is the repo's spelling of "not measured" — the same
    // one `floorRefused` and `unread` already use — and the honest answer is to
    // say so and name the flag that measures it.
    if (considered == null) {
      return {
        code: 'unmeasured',
        text:
          `${eligible} spare listing(s) here and the board is short, but this run did not price any of them — ` +
          `so it cannot say whether they are below the floors, in free-fall, or simply could not be read. ` +
          `\`npm run trending:check -- --floors\` opens this cycle's window and answers it.`,
      };
    }
    // Spare listings exist and none went on. Since the minimum outranks the
    // gain floor, the only survivable readings are that they are all in
    // free-fall — in which case the next cycle asks the filler to cover it —
    // or that no cycle has run since the board went short.
    return {
      code: 'spares_unusable',
      text:
        // ⚠️ …and never MORE than are left. `considered` was measured before
        // this pass promoted anything, `eligible` is counted after — so on a
        // chain that filled part of its gap the window is the larger number,
        // and printing it would claim more spares than the chain still has.
        `${Math.min(judged, eligible)} spare listing(s) here, and none went on — they are below −15%, the one thing never ` +
        `auto-promoted. The next cycle lists a big-cap to cover it while 🧲 Fill from market is ON. ⚡ Run now settles it.` + restNote,
    };
  }
  return {
    code: 'no_listings',
    text:
      `no spare listings on this chain and nothing was filled from the market. ` +
      `Check 🧲 Fill from market is ON and its 🏦 floor is not so high that nothing qualifies` +
      (gainFloor > 0 ? `, then list a token there yourself if it stays this way.` : `.`),
  };
}

/**
 * Fold this cycle's per-chain snapshot into the watch state and return the
 * alerts to send. PURE — the caller owns persistence and the sending, so a test
 * can walk a board through days of cycles in milliseconds.
 *
 * @param {Array<{id, featured, floor, eligible, fillWhy}>} chains
 * @param {object} prev  state.boardWatch from the store
 * @returns {{ state: object, alerts: Array<{chain, kind, text}> }}
 */
function evaluate(chains, prev = {}, { now = Date.now(), graceMs = GRACE_MS, repeatMs = REPEAT_MS } = {}) {
  const state = {};
  const alerts = [];
  for (const c of chains) {
    const was = prev[c.id] || null;
    const why = diagnose(c);
    if (!why) {
      // Back at or above the floor. Only announce it if we complained.
      if (was && was.alertedAt) {
        alerts.push({
          chain: c.id,
          kind: 'recovered',
          text: `✅ <b>${c.id}</b> is back at target — <b>${c.featured}</b> on the board (minimum ${c.floor}).`,
        });
      }
      continue; // no entry: the chain is healthy, and a healthy chain keeps no state
    }
    const since = (was && was.since) || now;
    const shortFor = now - since;
    const entry = { since, why: why.code };
    // Under the floor, but not for long enough to be more than a slot rolling
    // over between cycles.
    if (shortFor < graceMs) {
      state[c.id] = entry;
      continue;
    }
    const alertedAt = was && was.alertedAt;
    if (!alertedAt || now - alertedAt >= repeatMs) {
      alerts.push({
        chain: c.id,
        kind: 'short',
        text:
          `⚠️ <b>Trending board short on ${c.id}</b>\n` +
          `<b>${c.featured}</b> on the board, minimum is <b>${c.floor}</b> — for ${Math.round(shortFor / 60_000)} min.\n` +
          `${why.text}`,
      });
      entry.alertedAt = now;
    } else {
      entry.alertedAt = alertedAt;
    }
    state[c.id] = entry;
  }
  return { state, alerts };
}

/**
 * IS THE BOARD PUBLISHING ROWS WITH NO PERCENTAGE — and for how long?
 *
 * The second symptom on the same surface, and it arrived the same way the first
 * one did: the operator read the pinned channel, saw `$MOONCOIN | 12,220,809$`
 * with nothing beside it, and asked. TWICE, with two different causes
 * underneath:
 *
 *   1. the change was read from the deepest pool alone, so a quiet main pool
 *      lost the percentage a sibling had        → borrow from the sibling
 *   2. Robinhood has no second indexer, so GT's null `h24` was the end of the
 *      fallback chain                           → measure it from the candles
 *
 * Two fixes, one symptom, and nothing in the bot ever said "three rows went out
 * as — this cycle". A third cause will turn up; what is watched is the PROMISE:
 * every row on the board carries a percentage.
 *
 * Board-level, not per-chain: the complaint is about the board, and one alert
 * naming the tokens beats five naming the chains. The rules are `evaluate`'s,
 * for the reasons stated at the top of this file.
 *
 * @param {{rows:number, blank:Array<{chain,sym,why}>}} render  what the poster
 *        actually drew this cycle — never a second lookup of the same question
 * @param {object} prev  state.rowWatch from the store
 */
function evaluateRows(render, prev = {}, { now = Date.now(), graceMs = GRACE_MS, repeatMs = REPEAT_MS } = {}) {
  const blank = (render && render.blank) || [];
  const rows = (render && render.rows) || 0;
  const was = prev && prev.since ? prev : null;
  if (!blank.length) {
    // Only announce a recovery if we complained — a board that fixed itself
    // before anyone was told says nothing at all.
    const alerts = was && was.alertedAt
      ? [{ kind: 'rows_ok', text: `✅ <b>Every trending row carries a percentage again</b> — ${rows} row(s) on the board.` }]
      : [];
    return { state: {}, alerts };
  }
  const since = (was && was.since) || now;
  const shortFor = now - since;
  const entry = { since, count: blank.length };
  // A row can go blank for one cycle while a pool rolls over. An alert every
  // cycle is a channel nobody reads by the second hour — upstreams.js first,
  // then evaluate() above, now this.
  if (shortFor < graceMs) return { state: entry, alerts: [] };
  const alertedAt = was && was.alertedAt;
  if (alertedAt && now - alertedAt < repeatMs) return { state: { ...entry, alertedAt }, alerts: [] };

  // Name the TOKENS and the recorded reason. "Some rows have no percentage"
  // sends the reader back into the same two-round investigation; `changeWhy`
  // already knows whether the pool has not traded, is younger than a day, or
  // does not exist — three different answers.
  const SHOWN = 6;
  const lines = blank
    .slice(0, SHOWN)
    .map((b) => `· <b>${b.chain}</b> $${b.sym}${b.why ? ` — ${b.why}` : ''}`);
  if (blank.length > SHOWN) lines.push(`· …and ${blank.length - SHOWN} more`);
  return {
    state: { ...entry, alertedAt: now },
    alerts: [
      {
        kind: 'rows_blank',
        text:
          `⚠️ <b>Trending board publishing without a percentage</b>\n` +
          `<b>${blank.length}</b> of ${rows} row(s) went out as "—" — for ${Math.round(shortFor / 60_000)} min.\n` +
          `${lines.join('\n')}\n` +
          `Auto-promotion and the market filler both refuse a token with no reading, so these are PAID slots — ` +
          `or readings that went away after the slot was booked. <code>npm run trending:check -- --rows</code>`,
      },
    ],
  };
}

module.exports = { evaluate, evaluateRows, diagnose, GRACE_MS, REPEAT_MS };
