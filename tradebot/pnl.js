'use strict';
/*
 * pnl.js — the PnL card, as a pure function of its inputs.
 *
 * WHAT IT ANSWERS
 * "How did I do on this token?" — for a bag still held, for one already sold,
 * and for the awkward middle (sold half, still holding the rest) that every
 * other screen in this bot gets to avoid.
 *
 * WHY THE MONEY VIEW LEADS
 * The headline is `back − in`: what came back (proceeds + what is still held)
 * minus what went in. It needs no basis accounting to be true, it is exactly
 * profit once the bag is closed, and it is the only figure a user can check
 * against their own wallet. `realizedEth` (booked on each sell) and
 * `unrealizedEth` sit under it as the breakdown — a half-sold bag makes those
 * two views differ, and hiding the difference is how a card ends up printing
 * "3.99x" directly above "PnL +0.0000".
 *
 * THE RULES THIS FILE KEEPS
 *   • A price we could not read is UNKNOWN, never zero. `priced:false` prints
 *     "couldn't price it just now" and suppresses every figure derived from it
 *     — reporting an unknown as a 100% loss is the /portfolio lesson, and it is
 *     worse here because this card is the one a user screenshots.
 *   • A token this bot never traded gets a card that says so. It is not an
 *     error and not a zero: it is "no trades on file", with the balance if the
 *     wallet happens to hold some (sent in from outside, or bought elsewhere).
 *   • The trade counts come from a log capped at 50 entries per wallet, so they
 *     are reported as "on file", never as a claim of completeness. The lifetime
 *     ethIn/ethOut on the position are the authority for money.
 *
 * CONVENTIONS, same as receipt.js and i18n.js
 *   • Callers pass values ALREADY HTML-escaped where they could contain user
 *     or token text (`sym`, `name`). This module adds no escaping and must not.
 *   • No I/O, no core.js, no network — so the tests can call it directly
 *     instead of reading telegram.js with a regex.
 */

/**
 * A native-coin amount at the precision the figure deserves: a 12-SOL profit
 * does not need six decimals and a 0.0004 one is nothing without them.
 *
 * ⚠️ ABSOLUTE VALUE. The sign is `sgn()`'s job — formatting it here too printed
 * "−-0.75000 SOL" on the first loss the tests rendered. And the widths are held
 * to ONE step per magnitude band so a single card cannot mix "1.0000" with
 * "0.80000" on consecutive lines, which reads as two different quantities.
 */
function amt(v) {
  const n = Math.abs(Number(v) || 0);
  if (!Number.isFinite(n)) return '0';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 0.001 || n === 0) return n.toFixed(4);
  return n.toFixed(6);
}
/** Signed, with the sign always shown — a PnL line whose sign is implied by a
 *  colour the terminal does not have is a PnL line that can be misread. */
const sgn = (v) => (Number(v) > 0 ? '+' : Number(v) < 0 ? '−' : '') + amt(v);
const usd = (v) => {
  const n = Math.abs(Number(v) || 0);
  const s = n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : n >= 1 ? n.toFixed(2) : n.toFixed(4);
  return (Number(v) < 0 ? '−$' : '$') + s;
};
/** Token quantities are GROUPED, never compressed: "10,279,471.93" is the
 *  number in the wallet; "10.28M" is a market cap. Same rule as receipt.qty. */
function qty(v) {
  const n = Number(v) || 0;
  if (!Number.isFinite(n)) return '0';
  const d = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d });
}
function px(v) {
  const n = Number(v) || 0;
  if (!(n > 0)) return '0';
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(3);
}
/** A holding as a share of total supply. Empty on null/0 — an UNKNOWN supply
 *  must never print as "0.00% of supply"; below display precision it says so
 *  rather than rounding a real position to nothing. */
function share(v) {
  const n = Number(v) || 0;
  if (!(n > 0)) return '';
  if (n >= 1) return n.toFixed(2) + '%';
  if (n >= 0.01) return n.toFixed(3) + '%';
  // ⚠️ '&lt;', never a raw '<'. This module EMITS HTML (its own <b> tags), and
  // a bare '<' that does not open a supported tag makes Telegram reject the
  // entire message — 400 "can't parse entities" — which queuedSend does not
  // retry, because a 400 is an answer and not a transport error. That would
  // have silently deleted the receipt, the monitor card and the PnL card for
  // any ordinary buy on a large-supply token, which is most of them. The
  // "callers pass pre-escaped values" contract is about caller-supplied text
  // (sym, name); a literal this file generates is this file's to make safe.
  return '&lt;0.01%';
}
/** "3d 4h", "12m" — how long the money has been in this trade. */
function since(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
}

/**
 * The derived numbers, separated from the words.
 *
 * ONE OWNER for every figure the card states, so the text card, the image card
 * and any test read the same arithmetic. When the buy receipt printed the card
 * price under the label "Entry", the cause was two places deriving the same
 * quantity — this file exists so that cannot recur here.
 */
function pnlStats(p) {
  const ethIn = Number(p.ethIn) || 0;
  const ethOut = Number(p.ethOut) || 0;
  const value = Number(p.valueEth) || 0;
  const unknown = !!(p.open && !p.priced);           // held, and we could not price it
  const back = ethOut + (p.open && p.priced ? value : 0);
  const pnl = unknown ? null : back - ethIn;
  const pct = (!unknown && ethIn > 0) ? (back / ethIn - 1) * 100 : null;
  const mult = (!unknown && ethIn > 0) ? back / ethIn : null;
  // Three states, and the middle one is the reason this card exists: a bag that
  // was sold in part is neither "holding" nor "closed", and calling it either
  // misstates what the user is exposed to.
  const status = !p.traded ? 'none' : (!p.open ? 'closed' : (ethOut > 0 ? 'partial' : 'holding'));
  const win = pnl == null ? null : pnl > 0;
  return {
    ethIn, ethOut, back, value, pnl, pct, mult, status, win, unknown,
    realized: Number(p.realizedEth) || 0,
    unrealized: p.unrealizedEth == null ? null : Number(p.unrealizedEth),
    entryEth: p.entryEth == null ? null : Number(p.entryEth),
    priceEth: Number(p.priceEth) || 0,
    tokens: Number(p.tokens) || 0,
  };
}

const BAR_W = 12;
/** A proportional bar for the multiple — 1× is break-even and sits at the
 *  middle, so a card can be read at a glance before any number is. */
function bar(mult) {
  if (!(mult > 0)) return '';
  const half = BAR_W / 2;
  const filled = mult >= 1
    ? half + Math.min(half, Math.round((Math.min(mult, 5) - 1) / 4 * half))
    : Math.max(0, Math.round(mult * half));
  return '█'.repeat(Math.max(0, Math.min(BAR_W, filled))) + '░'.repeat(Math.max(0, BAR_W - filled));
}

/**
 * The card, in HTML for Telegram.
 *
 * `p` is core.tokenPnl()'s return with `sym`/`name` already escaped. `rate` is
 * the native→USD price (0 = no feed: the card then states native only, never a
 * confident $0).
 */
function pnlText(p, { native = 'ETH', rate = 0, chainLabel = '' } = {}) {
  const s = pnlStats(p);
  const L = [];
  const tag = p.sym ? `$${p.sym}` : (p.name || 'this token');
  const dollars = (v) => (rate > 0 ? ` <i>(${usd(v * rate)})</i>` : '');

  if (s.status === 'none') {
    // Never traded here. Not an error, not a zero — and if the wallet holds
    // some anyway (sent in from outside), say that rather than "0".
    L.push(`📊 <b>PnL · ${tag}</b>${chainLabel ? ` · ${chainLabel}` : ''}`, '');
    L.push('<i>No trades on file for this token in this bot.</i>');
    if (p.open) {
      L.push('', `You hold <b>${qty(s.tokens)}</b> ${tag}${s.priceEth > 0 && rate > 0 ? ` · worth <b>${usd(s.tokens * s.priceEth * rate)}</b>` : ''}.`);
      L.push('<i>Bought outside this bot, or sent in from another wallet — there is no cost basis to measure against.</i>');
    }
    return L.join('\n');
  }

  const head = s.status === 'closed' ? '🏁 <b>CLOSED</b>'
    : s.status === 'partial' ? '📤 <b>PARTLY SOLD</b>'
      : '📈 <b>HOLDING</b>';
  const face = s.unknown ? '⚪️' : s.win ? '🟢' : (s.pnl === 0 ? '⚪️' : '🔴');

  // The name rides under the title only when it SAYS something the ticker
  // does not — an unnamed launch has sym and name both set to the short CA,
  // and printing it twice was the first line of the "spam" report.
  // The chain is part of the token's IDENTITY — the same address can exist on
  // two of them — so it belongs beside the ticker, the way the book's header
  // already carries it. Pushed as a footer it was a word floating under a
  // blank line with nothing to attach to, which is how it read.
  L.push(`${face} <b>PnL · ${tag}</b>${chainLabel ? ` · ${chainLabel}` : ''}${p.name && p.sym && p.name !== p.sym ? `\n<i>${p.name}</i>` : ''}`);
  L.push('');
  // THE HEADLINE, and nothing competing with it.
  if (s.unknown) {
    // Name WHICH read failed. "Couldn't price it" while the real failure was the
    // balance sends the user to look at the pool instead of at their RPC, and
    // the two have different answers.
    L.push(p.balUnknown
      ? '⚠️ <b>Couldn\'t read your balance just now</b> — so whether you still hold it is unknown, and no total is shown. <i>Nothing is wrong with the position; try again in a moment.</i>'
      : '⚠️ <b>Couldn\'t price it just now</b> — the profit on the part you still hold is unknown, so no total is shown.');
  } else {
    const pctStr = s.pct == null ? '—' : `${s.pct > 0 ? '+' : s.pct < 0 ? '−' : ''}${Math.abs(s.pct).toFixed(2)}%`;
    L.push(`<b>${pctStr}</b>${s.mult ? `  ·  <b>${s.mult.toFixed(2)}×</b>` : ''}`);
    if (s.mult) L.push(`<code>${bar(s.mult)}</code>`);
    L.push(`<b>${sgn(s.pnl)} ${native}</b>${dollars(s.pnl)}`);
  }
  L.push('');
  // ONE emoji per card body was still too many — "copy writing template kaya
  // terlalu spam" was a card of ten one-emoji-per-line rows. The verdict dot
  // and the status glyph carry the colour; the body is text, and related
  // figures share a line instead of taking one each.
  const tr = p.trades || {};
  // "on file" qualifies the COUNTS — the trade log is capped per wallet, so
  // they are what we still have and never a claim of completeness. It must
  // sit BESIDE them: appended after the duration it read as "hold 2d 4h on
  // file", which is not a sentence. The money figures come from the
  // position's lifetime totals, which are not capped.
  const counts = [];
  if (tr.buys) counts.push(`${tr.buys} buy${tr.buys > 1 ? 's' : ''}`);
  if (tr.sells) counts.push(`${tr.sells} sell${tr.sells > 1 ? 's' : ''}`);
  const trBits = [];
  if (counts.length) trBits.push(`${counts.join(' · ')} on file`);
  if (tr.firstAt) trBits.push(`hold ${since(Date.now() - tr.firstAt)}`);
  L.push(`${head}${trBits.length ? ` · <i>${trBits.join(' · ')}</i>` : ''}`);
  // Blank lines BETWEEN the groups. Dropping the per-line emoji fixed the
  // spam and created the opposite defect in the same breath — five dense
  // lines with nothing separating them ("harus ada spasinya tulisan"). The
  // grouping is what the reader is actually asking of the card: what the
  // position IS, what it COST and holds, and the detail under that.
  L.push('');
  L.push(`Invested <b>${amt(s.ethIn)} ${native}</b>${dollars(s.ethIn)}`
    + (s.ethOut > 0 ? ` → taken out <b>${amt(s.ethOut)} ${native}</b>${dollars(s.ethOut)}` : ''));
  if (p.open) {
    const sup = share(p.supplyPct);
    L.push(`Still holding <b>${qty(s.tokens)}</b> ${tag}`
      + (sup ? ` · <b>${sup}</b> of supply` : '')
      + (s.unknown ? ' · <i>price unavailable</i>' : ` · <b>${amt(s.value)} ${native}</b>${dollars(s.value)}`));
  }
  // Realized vs unrealized, but only where the split says something the money
  // view does not: on a bag that was partly sold, or one still open.
  // The detail group: the split, the prices, and which wallets hold it. Opened
  // by one blank line, and each piece still drops independently.
  const detail = [];
  if (s.status !== 'closed' && (s.realized !== 0 || s.unrealized != null)) {
    const parts = [];
    if (s.realized !== 0) parts.push(`booked <b>${sgn(s.realized)} ${native}</b>`);
    if (s.unrealized != null) parts.push(`open <b>${sgn(s.unrealized)} ${native}</b>`);
    if (parts.length) detail.push(parts.join(' · '));
  }
  if (s.entryEth != null || s.priceEth > 0) {
    const bits = [];
    if (s.entryEth != null) bits.push(`entry <b>${px(s.entryEth)}</b>`);
    if (s.priceEth > 0) bits.push(`now <b>${px(s.priceEth)}</b>`);
    detail.push(`${bits.join(' → ')} ${native}/token`);
  }
  if (p.holders && p.holders.length) {
    const shown = p.holders.slice(0, 4).map((h) => `${h.label} ${qty(h.tokens)}`).join(' · ');
    detail.push(`<i>${shown}${p.holders.length > 4 ? ` +${p.holders.length - 4} more` : ''}</i>`);
  }
  if (detail.length) L.push('', ...detail);
  return L.join('\n');
}

/**
 * The book: every token with a position, ranked by what it made or lost.
 *
 * `rows` are core.tokenPnl()-shaped. A row we could not price is listed with
 * its cost and marked unknown rather than dropped — a book that quietly omits
 * a position is a book that cannot be reconciled — and it is left OUT of the
 * totals, because summing an unknown as zero is the same lie one level up.
 */
function pnlBook(rows, { native = 'ETH', rate = 0, chainLabel = '' } = {}) {
  const stats = rows.map((r) => ({ r, s: pnlStats(r) }));
  const known = stats.filter((x) => !x.s.unknown);
  const totalIn = known.reduce((t, x) => t + x.s.ethIn, 0);
  const totalBack = known.reduce((t, x) => t + x.s.back, 0);
  const net = totalBack - totalIn;
  const wins = known.filter((x) => x.s.pnl > 0).length;
  const losses = known.filter((x) => x.s.pnl < 0).length;
  const dollars = (v) => (rate > 0 ? ` <i>(${usd(v * rate)})</i>` : '');
  const L = [`📊 <b>Your PnL</b>${chainLabel ? ` · ${chainLabel}` : ''}`, ''];
  if (!stats.length) {
    L.push('<i>No positions on this chain yet.</i>', '', 'Paste a token contract to trade one — every buy and sell is tracked here, and a token stays on this list after you sell it.');
    return L.join('\n');
  }
  const pct = totalIn > 0 ? (totalBack / totalIn - 1) * 100 : null;
  L.push(`${net > 0 ? '🟢' : net < 0 ? '🔴' : '⚪️'} <b>${sgn(net)} ${native}</b>${dollars(net)}${pct == null ? '' : `  ·  <b>${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct).toFixed(2)}%</b>`}`);
  L.push(`<i>${known.length} position${known.length === 1 ? '' : 's'} · ${wins}W / ${losses}L · in ${amt(totalIn)} → back ${amt(totalBack)} ${native}</i>`);
  L.push('');
  const sorted = stats.slice().sort((a, b) => {
    if (a.s.unknown !== b.s.unknown) return a.s.unknown ? 1 : -1;
    return (b.s.pnl || 0) - (a.s.pnl || 0);
  });
  for (const { r, s } of sorted.slice(0, 12)) {
    const tag = r.sym ? `$${r.sym}` : (r.name || 'token');
    const mark = s.unknown ? '⚪️' : s.pnl > 0 ? '🟢' : s.pnl < 0 ? '🔴' : '⚪️';
    const state = s.status === 'closed' ? '🏁' : s.status === 'partial' ? '📤' : '📈';
    if (s.unknown) { L.push(`${mark} ${state} <b>${tag}</b> · <i>price unavailable</i> · in ${amt(s.ethIn)}`); continue; }
    L.push(`${mark} ${state} <b>${tag}</b> · <b>${sgn(s.pnl)} ${native}</b>${s.mult ? ` · ${s.mult.toFixed(2)}×` : ''}`);
  }
  if (sorted.length > 12) L.push(`<i>…and ${sorted.length - 12} more</i>`);
  const unknownN = stats.length - known.length;
  if (unknownN) L.push('', `<i>${unknownN} position(s) left out of the total — we could not read a price for them, and counting them as zero would show a loss that did not happen.</i>`);
  return L.join('\n');
}

module.exports = { pnlStats, pnlText, pnlBook, amt, sgn, usd, qty, px, since, bar, share };
