'use strict';
/*
 * Ops reporting to a private Telegram channel (admin visibility).
 *
 * SECURITY: this module sends ONLY public / non-secret information — usernames,
 * wallet ADDRESSES, trade volume and fees. It NEVER sends private keys or seed
 * phrases anywhere. (Key recovery for support is a separate, on-demand, admin-only
 * DM path — never a channel broadcast.)
 *
 * Fire-and-forget: every function swallows errors and never throws, so a channel
 * hiccup can't affect a user's trade. Configure REPORT_CHANNEL_ID (the channel the
 * bot is an admin of); empty disables all reporting.
 */
// Read config LAZILY (at call time), not at module load — this module is required from
// inside core.js BEFORE core's .env loader runs, so capturing env at load time would
// read an empty token and silently disable all reporting.
const _token = () => (process.env.TRADEBOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();

// A Telegram chat id is `-100` + digits (supergroup/channel), a bare signed
// integer, or an @username. Anything else cannot be a destination.
//
// This exists because a documented EXAMPLE was pasted into a live .env verbatim:
// `REPORT_CHANNEL_ID=-100xxxxxxxxxx`. An env var that is set but nonsense is
// worse than one that is unset — it silently overrode the working default, and
// post() swallows its own failures by design, so every report simply stopped
// arriving with nothing anywhere saying why. CLAUDE.md already carries this
// lesson for filesystem paths; it is the same mistake with a different value.
const _looksLikeChatId = (s) => /^-?\d{5,}$/.test(s) || /^@[A-Za-z]\w{3,}$/.test(s);
const CHANNEL_FALLBACK = '-1003885406672';
let _warnedChannel = false;
const _channel = () => {
  const raw = (process.env.REPORT_CHANNEL_ID || '').trim();
  if (!raw) return CHANNEL_FALLBACK;
  if (_looksLikeChatId(raw)) return raw;
  if (!_warnedChannel) {
    _warnedChannel = true;
    console.error(`[report] REPORT_CHANNEL_ID=${JSON.stringify(raw)} is not a chat id — it must be -100… digits or @name. ` +
      `Ignoring it and using the built-in channel; fix or remove the line in .env.`);
  }
  return CHANNEL_FALLBACK;   // a placeholder must never be able to silence reporting
};

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const who = (u) => (u && u.username) ? '@' + esc(u.username) : ('id ' + (u && u.chatId != null ? u.chatId : '?'));
const money = (native, amt, usd) => `<b>${amt} ${esc(native)}</b>${(usd != null && usd > 0) ? ` ($${usd >= 1 ? usd.toFixed(2) : usd.toFixed(4)})` : ''}`;

function enabled() { return !!(_token() && _channel()); }
async function post(text) {
  const token = _token(), channel = _channel();
  if (!token || !channel) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: channel, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => null);
    if (j && j.ok === false) console.error('report post failed:', j.description, '(is the bot an admin of the channel with Post Messages?)');
  } catch (_) { /* never let a report failure touch the trade path */ }
}

const totalLine = (total) => (total != null ? `\n👥 Total users: <b>${total}</b>` : '');
// A user pressed /start.
function onStart(u, isNew, refBy, total) {
  return post(`👋 <b>${isNew ? 'NEW user' : 'Returning user'}</b> · ${who(u)}${u && u.firstName ? ' · ' + esc(u.firstName) : ''}` + (refBy ? `\nReferred by code <code>${esc(refBy)}</code>` : '') + totalLine(total));
}
// A user generated or imported a wallet. ADDRESS ONLY — never the key/seed.
function onWallet(u, action, address, index, total) {
  return post(`👛 <b>Wallet ${action}</b> · ${who(u)}\nWallet #${index} · <code>${esc(address)}</code>${totalLine(total)}`);
}
// A trade happened (manual, snipe, copy or order fill). `usdRate` is native→USD or 0.
function onTrade(d) {
  const volUsd = d.usdRate > 0 ? d.volEth * d.usdRate : null;
  const feeUsd = d.usdRate > 0 ? d.feeEth * d.usdRate : null;
  // feeCollected reflects whether the fee transfer actually confirmed on-chain
  // (feeHash present). "pending" means it will be reflected once it lands / is
  // retried — so the operator can tell real revenue from a not-yet-collected fee.
  const feeLine = d.feeCollected
    ? `Fee collected ✅: ${money(d.native, Number(d.feeEth).toFixed(6), feeUsd)}`
    : `Fee (pending ⏳): ${money(d.native, Number(d.feeEth).toFixed(6), feeUsd)}`;
  return post(
    `${d.side === 'buy' ? '🟢 <b>BUY</b>' : '🔴 <b>SELL</b>'} · $${esc(d.sym || '?')} · ${esc(d.chainName)}\n` +
    `by ${who(d)}\n` +
    `Volume: ${money(d.native, Number(d.volEth).toFixed(6), volUsd)}\n` +
    `${feeLine}\n` +
    `<code>${esc(d.ca)}</code>`
  );
}
// (Periodic recap is rendered by telegram.statsText — which has the live price feed —
// and sent via post(), so it isn't duplicated here.)
// Audit trail when an admin recovers a user's key (the KEY itself is NOT included).
function onKeyRecovery(adminId, target) {
  return post(`🔐 <b>Key recovery</b> (audit)\nAdmin <code>${esc(adminId)}</code> recovered wallet key(s) for ${who(target)}.`);
}

// A third party started or stopped answering.
//
// Written for someone who is NOT at a terminal: it names what the user loses,
// not only which host is unreachable, because "lite-api.jup.ag ENOTFOUND" does
// not tell an operator whether to stop the bot or finish their dinner.
//
// Only transitions reach here (see watchers.upstreamCycle) — a broken upstream
// posting every sweep is a channel nobody reads by the second hour.
function upstreamChange(broke, fixed) {
  const lines = [];
  if (broke.length) {
    lines.push(`🔴 <b>Upstream down</b>`);
    for (const r of broke) lines.push(`• <b>${esc(r.label)}</b>${r.critical ? ' ⛔' : ''} — ${esc(r.costs)}\n  <i>${esc(r.detail)}</i>`);
    if (broke.some((r) => r.critical)) lines.push(`\n⛔ marks a break that stops users trading. Check <code>npm run preflight:solana</code> on the box.`);
  }
  if (fixed.length) {
    if (lines.length) lines.push('');
    lines.push(`🟢 <b>Upstream recovered</b>`);
    for (const r of fixed) lines.push(`• <b>${esc(r.label)}</b> — ${esc(r.detail)}`);
  }
  return post(lines.join('\n'));
}

module.exports = { enabled, post, esc, onStart, onWallet, onTrade, onKeyRecovery, upstreamChange };
