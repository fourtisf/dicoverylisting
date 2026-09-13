'use strict';
/*
 * receipt.js — ONE WALLET, ONE RECEIPT.
 *
 * WHAT WAS WRONG
 * A multi-wallet trade produced a single message, built only after
 * `Promise.allSettled` had resolved every wallet, with the wallets reduced to
 * bullet points inside it:
 *
 *     ✅ Bought $PONS · 4/4 wallets
 *     Total: 225.08 $PONS · spent 0.04 ETH ($74.32)
 *     • Wallet 1 · 56.27 $PONS · 0.01000 ETH ($18.58) · tx ↗
 *     • Wallet 2 · 56.27 $PONS · 0.01000 ETH ($18.58) · tx ↗
 *     …
 *
 * Two separate problems, and the user named both:
 *
 *   1. NOTHING ARRIVES UNTIL THE SLOWEST WALLET SETTLES. Four wallets fill in
 *      two seconds and the fifth takes twenty; the user sees an empty chat for
 *      twenty seconds and then the whole batch at once. The trades were always
 *      parallel — only the reporting was serial — so a bot that is genuinely
 *      fast read as a bot that had hung.
 *   2. A BULLET IS NOT A RECEIPT. One line per wallet cannot carry the token,
 *      the amount in token units, the market cap, and a transaction button; and
 *      the one thing a person does after a trade is check that ONE wallet.
 *
 * So each wallet now gets its own message, posted the moment that wallet
 * settles, in the shape every other Telegram trading bot uses.
 *
 * WHY THIS IS A MODULE AND NOT MORE INLINE STRING-BUILDING
 * telegram.js is 3,600 lines and every receipt in it was assembled inline,
 * which is why the tests that guard them read the SOURCE with a regex instead
 * of calling anything. This is a pure function of its arguments: no I/O, no
 * core.js, no network. It can be asserted directly.
 *
 * CONVENTIONS, same as i18n.js
 *   • Callers pass values that are ALREADY HTML-escaped. This module adds no
 *     escaping and must not — pre-escaped copy would be double-escaped and
 *     render as markup.
 *   • `t(key, vars)` is the caller's translator, already bound to a chat, so
 *     every string here is translatable and none of it lives in this file.
 */

/**
 * A token quantity the way a person reads it: grouped thousands, and enough
 * decimals to be true without being noise.
 *
 * NOT the `fmt()` used elsewhere in the bot, which compresses to "10.28M". That
 * is right for a market cap and wrong here: "Sell of 10.28M RUIN" is not the
 * number in the wallet, and the whole point of this line is that it states the
 * trade in the units the user thinks in. Sub-unit amounts keep more decimals,
 * because 0.00 is not an amount.
 */
const { share } = require('./pnl');   // one owner for the supply-share format

function qty(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '0';
  const abs = Math.abs(v);
  const dp = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  // Trailing zeros carry no information once the magnitude is clear.
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

/** A native amount: five decimals, which is where ETH/SOL stops being readable
 *  and starts being eighteen digits of noise. */
const nat = (n) => (Number(n) || 0).toFixed(5);

const money2 = (v) => Math.abs(Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * " ≈ $178.16", or NOTHING.
 *
 * An absent price feed must never render as "$0.00": a confident zero next to a
 * real trade is worse than no figure at all, and this bot has printed one
 * before. Only a rate that is actually a rate produces a dollar figure.
 */
function usdTail(amount, rate) {
  if (!(Number(rate) > 0)) return '';
  return ` ≈ $${money2((Number(amount) || 0) * Number(rate))}`;
}

/** " (+$78.04)" / " (−$78.04)", or nothing. Built, not string-surgeried out of
 *  usdTail(): the sign has to survive translation, and a `.replace()` on a
 *  formatted value breaks the moment a locale moves the placeholder. */
function signedUsd(amount, rate) {
  if (!(Number(rate) > 0)) return '';
  return ` (${Number(amount) >= 0 ? '+' : '−'}$${money2(Number(amount) * Number(rate))})`;
}

/**
 * What one token actually cost, in dollars.
 *
 * Derived from the trade itself — spend ÷ tokens — so it is the price the user
 * REALLY got, not the one the card was showing when they tapped. On a thin pool
 * those are different numbers, and the difference is the whole reason to print
 * it. Three significant figures, because a memecoin price is 0.00000129 and a
 * fixed decimal count is either noise or zero.
 */
function unitUsd(amount, tokens, rate) {
  const a = Number(amount), n = Number(tokens), r = Number(rate);
  if (!(a > 0) || !(n > 0) || !(r > 0)) return null;
  const px = (a * r) / n;
  return Number.isFinite(px) && px > 0 ? Number(px.toPrecision(3)) : null;
}

/**
 * THE FILL, MEASURED AGAINST THE CARD.
 *
 * A live Solana buy, 2026-08-16: spent 0.099 SOL, got 129.16K tokens, and the
 * receipt printed "Entry: $0.0000524" — the price on the CARD, which is not a
 * price anyone paid. The fill was $0.0000578, 10.4% above it. Seconds later the
 * Monitor read "−9.48%" on a token whose price had not moved, and from Telegram
 * that is indistinguishable from a bot that cannot count: one card claims an
 * entry of 0.0000524, the next shows a price of 0.0000523 and a double-digit
 * loss.
 *
 * Neither number was wrong on its own. The receipt was answering a different
 * question from the one its label asked, and the round-trip cost of the trade —
 * pool fee, price impact, the gap between DexScreener's single pair and
 * Jupiter's route across every AMM — had nowhere on the receipt to appear, so
 * it appeared on the Monitor instead, as a loss the user had not taken.
 *
 * `offBy` is computed in NATIVE units and is dimensionless, so the warning it
 * drives survives a dead USD feed — the one line on the receipt that must not
 * depend on Coinbase being up. `realPx`/`refPx` are null, never 0, when there is
 * no rate: a confident $0 beside a real trade is worse than a blank.
 */
function fillStats(d) {
  const spent = Number(d && d.spent), tokens = Number(d && d.tokens);
  const rate = Number(d && d.rate) || 0;
  const ref = Number(d && d.refPxNative) || 0;
  const paidNative = spent > 0 && tokens > 0 ? spent / tokens : 0;
  const offBy = paidNative > 0 && ref > 0 ? paidNative / ref : 0;
  const px = (v) => (v > 0 && rate > 0 ? Number((v * rate).toPrecision(3)) : null);
  return {
    paidNative,
    realPx: px(paidNative),
    refPx: px(ref),
    offBy,
    // How far ABOVE the card the fill sat, and how far BELOW the card the
    // position therefore opens. They are not the same number — a fill 10.4%
    // over mid shows as −9.4%, not −10.4% — and printing one as the other is
    // how a receipt gets caught contradicting the Monitor it just opened.
    overPct: offBy > 0 ? (offBy - 1) * 100 : 0,
    downPct: offBy > 0 ? (1 - 1 / offBy) * 100 : 0,
  };
}

/** A market cap, compressed — this one IS a headline figure, so "27.20M" is
 *  the readable form. */
function mcap(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return v.toFixed(2);
}

/**
 * The two header lines: what the token is, and its contract.
 *
 * The contract is on the receipt because a receipt is a record — the message
 * survives in the chat long after the card that produced it is gone, and
 * "which token was that" is unanswerable from a ticker alone when two projects
 * share one. `name` is dropped when it merely repeats the ticker rather than
 * printing "PONS ($PONS)".
 */
function header(d) {
  const sym = d.sym ? `$${d.sym}` : '';
  const nm = d.name && d.name.toUpperCase() !== String(d.sym || '').toUpperCase() ? d.name : '';
  // Name AND ticker → "Pons Finance ($PONS)". Either one alone is still better
  // than the generic word: falling straight to `sym || 'Token'` threw away a
  // name we had, and printed "Token" for a token we could name.
  const title = nm && sym ? `<b>${nm}</b> (${sym})` : `<b>${sym || nm || 'Token'}</b>`;
  const chain = [d.chainEmoji, d.chainName].filter(Boolean).join(' ');
  return `${title}${chain ? ` · ${chain}` : ''}\n<code>${d.ca}</code>`;
}

/**
 * One wallet's receipt.
 *
 * @param {(key: string, vars?: object) => string} t  bound translator
 * @param {object} d
 *   side       'buy' | 'sell'
 *   ok         did this wallet actually trade?
 *   noBag      sell only: it had nothing to sell — not a failure
 *   name/sym/ca/chainEmoji/chainName   already escaped
 *   wallet     wallet label, already escaped
 *   tokens     tokens bought or sold
 *   amount     native spent (buy) or kept (sell)
 *   native     'ETH' | 'SOL' | …, already escaped
 *   rate       native→USD, 0 when the feed is down
 *   pnl        sell only: realised P/L in native, null when unknown
 *   mcUsd      market cap around the trade, 0 when unread
 *   reason     failure text, already escaped and made friendly
 * @returns {string} HTML
 */
function walletReceipt(t, d) {
  const L = [header(d), ''];

  if (d.noBag) {
    // NOT a failure, and it must not look like one. A wallet that holds nothing
    // did exactly what it should when asked to sell 100% of nothing, and a red
    // ❌ next to it sends people looking for a problem that is not there.
    L.push(t('wallet.receipt.nobag', { wallet: d.wallet }));
    return L.join('\n');
  }
  if (!d.ok) {
    L.push(t(d.side === 'sell' ? 'wallet.receipt.sell.fail' : 'wallet.receipt.buy.fail', { wallet: d.wallet }));
    if (d.reason) L.push(d.reason);
    return L.join('\n');
  }

  // 🟢 is SUCCESS, not direction — the same green dot on a buy and on a sell,
  // because the question this line answers is "did it go through". Using red
  // for a sell would put a failure colour on a completed exit.
  // `share()` has ONE owner (pnl.js) so this line, the PnL card and the
  // monitor cannot drift into three formats for the same ratio. The fragment
  // itself goes through t() — "of supply" has an Indonesian spelling too.
  const sup = share(d.supplyPct);
  L.push(t(d.side === 'sell' ? 'wallet.receipt.sell.ok' : 'wallet.receipt.buy.ok', {
    qty: qty(d.tokens),
    sym: d.sym ? `$${d.sym}` : '',
    sup: sup ? t('wallet.receipt.supply', { pct: sup }) : '',
    wallet: d.wallet,
  }));
  L.push('');

  if (d.side === 'sell') {
    // "Received", NOT "You gained". The figure is the proceeds, and a sell at a
    // loss still has proceeds — "you gained 0.095 ETH" above a −78% exit is the
    // receipt telling the user the opposite of what happened. What was gained
    // or lost is the P/L line, and only that line.
    L.push(t('wallet.receipt.received', { amt: nat(d.amount), native: d.native, usd: usdTail(d.amount, d.rate) }));
    // P/L only when it is KNOWN. A position opened outside this bot has no cost
    // basis, so `pnl` is null — and "P/L 0.00000" on a profitable exit is a
    // stated fact that happens to be false.
    if (Number.isFinite(d.pnl) && d.pnl !== 0) {
      const up = d.pnl > 0;
      // The percentage costs nothing to derive and is the number a trader
      // actually reads: `pnl = proceeds − cost`, so the cost is already implied
      // by the two figures we hold. Omitted when the basis works out to zero —
      // a bag that arrived by airdrop or transfer has no entry to be up against,
      // and "+∞%" is not a return.
      const basis = Number(d.amount) - d.pnl;
      const pct = basis > 0 ? ` · <b>${up ? '+' : '−'}${Math.abs((d.pnl / basis) * 100).toFixed(1)}%</b>` : '';
      L.push(t('wallet.receipt.pnl', {
        icon: up ? '📈' : '📉',
        pnl: `${up ? '+' : '−'}${nat(Math.abs(d.pnl))} ${d.native}`,
        usd: signedUsd(d.pnl, d.rate),
        pct,
      }));
    }
  } else {
    L.push(t('wallet.receipt.spent', { amt: nat(d.amount), native: d.native, usd: usdTail(d.amount, d.rate) }));
  }

  // What it filled at, and what the token was capped at — the two questions a
  // receipt leaves behind. Each is dropped independently when it is not known:
  // a "$0" price or cap is a claim about the token, and an unread indexer is
  // not a claim about anything.
  const px = unitUsd(d.amount, d.tokens, d.rate);
  const mc = Number(d.mcUsd) > 0 ? mcap(d.mcUsd) : null;
  const sell = d.side === 'sell';
  if (px != null && mc != null) L.push(t(sell ? 'wallet.receipt.exit_full' : 'wallet.receipt.entry_full', { px, mc }));
  else if (mc != null) L.push(t(sell ? 'wallet.receipt.exit_mc' : 'wallet.receipt.entry_mc', { mc }));
  else if (px != null) L.push(t(sell ? 'wallet.receipt.exit_px' : 'wallet.receipt.entry_px', { px }));
  return L.join('\n');
}

module.exports = { walletReceipt, qty, nat, usdTail, signedUsd, unitUsd, fillStats, mcap, header };
