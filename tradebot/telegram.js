'use strict';
/*
 * Dexvra Trade Bot — Telegram UI (long-polling, HTML, inline keyboards).
 * Multi-chain: pick a chain, paste a token contract, one-tap buy/sell. Manage a
 * custodial wallet (generate/import/export/withdraw), portfolio, snipes,
 * limit/TP-SL orders and referrals. Trading logic is in core.js; watchers.js runs
 * snipe + order fills. DMs only (custodial wallet must not be shared in a group).
 */
const { ethers } = require('ethers');
const { AsyncLocalStorage } = require('async_hooks');
const core = require('./core');
const watchers = require('./watchers');
const report = require('./report');   // ops reporting to admin channel (never sends secrets)
// Carries the user's message id through a text-message handler so every reply THREADS
// (Telegram "reply to") that message — set once in onMessage, read in send(). Safe under
// concurrency (per-invocation store, not a global). Callback (button) handlers have no
// store, so button responses don't reply-to-nothing.
const _replyCtx = new AsyncLocalStorage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goplus = require('./goplus');
const i18n = require('./i18n');       // EN/ID copy — see i18n.js for why this exists
const receipt = require('./receipt'); // one wallet, one receipt — pure renderer, no I/O
const pnl = require('./pnl');         // the PnL card — pure renderer, no I/O
const pnlImage = require('./pnlImage'); // …and the same card as a shareable PNG (optional)
const safety = require('./safety');   // chain-aware token safety (GoPlus on EVM, RugCheck on Solana)
const tokeninfo = require('./tokeninfo');
const solana = require('./solana');   // base58 address validation + SVM helpers
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const API = `https://api.telegram.org/bot${core.CFG.tgToken}`;
const pending = new Map();      // chatId -> { action, ..., ts }
const PENDING_TTL = 5 * 60 * 1000;
const PRICES = { ETH: 0, BNB: 0, SOL: 0 };
let BOT_USERNAME = '';
// Last-known native balance per `${walletId}:${chainKey}` → { raw, at }. Used so a
// single flaky/slow RPC (a timed-out read) can't silently drop a chain from the wallet
// totals — the total stays stable instead of jumping down then back on refresh.
const _balCache = new Map();
// One owner of "what does this wallet hold natively on this chain". The wallet
// dashboard and the multi-wallet withdraw picker both read it; two private
// copies is how two screens end up disagreeing about the same number.
// STRICT on purpose: it throws rather than answering 0, so a caller can tell an
// unread balance from an empty wallet.
const readNative = async (w, c) => {
  // ⚠️ ethBalanceOrNull, NOT ethBalance. On svm the latter resolves 0n for a
  // dead RPC, so an unreadable balance rendered as an empty wallet on every
  // screen that shows one — the dashboard, the sweep picker, and the removal
  // guard's one-tap ✅ Remove. The comment here used to claim "svm errors
  // already bubble"; they did not, and had not since the read was written.
  // Throwing on null keeps this function's existing contract: callers already
  // wrap it in `.catch(() => null)` and render the miss.
  const v = await core.ethBalanceOrNull(wAddr(w, c.key), c.key);
  if (v == null) throw new Error('balance unreadable');
  return v;
};
/**
 * Every wallet's native balance on ONE chain, in as few requests as the chain
 * allows — the shape both screens that list wallets actually want.
 *
 * ⚠️ THE DASHBOARD WAS ASKING PER WALLET, AND ON SOLANA THAT IS WHAT BROKE IT.
 * `readNative` is a single-cell read, so wallets × chains meant five separate
 * `getBalance` calls hitting the public Solana endpoint at once — it rate-limits
 * the burst, web3.js retries past the 2.5s bound, and all five cells came back
 * null: `Couldn't reach Solana` on a screen where every EVM chain answered.
 * `core.nativeBalances` is one `getMultipleAccounts` there and unchanged on EVM.
 *
 * ⚠️ THE TIMEOUT IS PER COLUMN, NOT PER CELL, and that is not a regression: the
 * five Solana cells were always one concurrent wave sharing one wall clock, so
 * the screen waited the same 2.5s for all of them. What changed is that they now
 * share one REQUEST, which is the thing the endpoint was counting.
 *
 * `why` is the upstream's own sentence, kept so the screen can say WHICH silence
 * this was — a 429, a refusal, or our own bound — instead of one shrug for all
 * three.
 */
async function readNativeColumn(list, c, tmo = 2500) {
  const addrs = list.map((w) => wAddr(w, c.key));
  const r = await withTmo(
    core.nativeBalances(c.key, addrs).catch((e) => ({ bals: addrs.map(() => null), why: String((e && e.message) || e).slice(0, 160) })),
    tmo,
    { bals: addrs.map(() => null), why: `no answer within ${tmo}ms` },
  );
  return r;
}
// Short-lived token price cache `${chain}:${caLower}` → { priceEth, at } so the wallet
// screen can include TOKEN holdings in each wallet's total without re-pricing every render.
const _priceCache = new Map();

/**
 * The last FULL token-card render, per chat+chain+token.
 *
 * A wallet toggle on the card redraws it, and a full render is ~20 network
 * calls: the price/liquidity/safety scan, a token-meta read, and a balance PAIR
 * for every wallet the user has. None of it is what a toggle changed — the
 * market did not move and no trade happened, only which wallets are lit — so
 * ten wallets turned a one-bit change into seconds of RPC, on the one screen
 * where a run of taps is normal ("pilih wallet tidak working... harus cpt").
 *
 * Only the toggle path passes `reuse`. A fresh open, a chain switch and 🔄
 * Refresh always read live: a stale price is acceptable only when the user did
 * not ask to look again.
 */
const _cardReuse = new Map();
const CARD_REUSE_MS = Math.max(0, Number(process.env.CARD_REUSE_MS || 20000));
// Past this, a card render says where its time went. `0` silences it.
const CARD_SLOW_MS = Math.max(0, Number(process.env.CARD_SLOW_MS || 1200));
/**
 * Last tap wins.
 *
 * The poll loop does not await handleUpdate, so a run of taps on one card is a
 * run of CONCURRENT handlers all editing the same message. Whichever render
 * finishes last paints the card — and that is not necessarily the newest tap,
 * so the wallet just lit goes dark again a second later. Indistinguishable from
 * a toggle that does not work, which is exactly how it was reported.
 */
/** Drop a token's cached render — called whenever a trade moves the balances
 *  the card states. Without it a toggle within the reuse window would redraw
 *  the pre-trade bag, which is the one number a user checks right after a buy. */
function invalidateCard(chatId, ca, chainKey) {
  if (!ca) return;
  const suffix = ':' + String(ca).toLowerCase();
  const prefix = chatId + ':';
  for (const k of _cardReuse.keys()) {
    if (k.startsWith(prefix) && k.endsWith(suffix)) _cardReuse.delete(k);
  }
}
const _redrawSeq = new Map();
function redrawTicket(chatId, mid) {
  const key = chatId + ':' + mid;
  const n = (_redrawSeq.get(key) || 0) + 1;
  _redrawSeq.set(key, n);
  if (_redrawSeq.size > 2000) { const first = _redrawSeq.keys().next().value; _redrawSeq.delete(first); }
  return () => _redrawSeq.get(key) === n;
}

// ------------------------------------------------------------ telegram api
/**
 * One Telegram API call, with the ONE retry Telegram actually asks for.
 *
 * A 429 from Telegram is not a failure — it is the server telling you exactly
 * how long to wait, in `parameters.retry_after`, and promising the call will
 * work after that. This ignored it and returned the error object to callers
 * that overwhelmingly do not check `ok`, so a throttled message was simply
 * gone.
 *
 * That was survivable while a multi-wallet trade produced ONE message. It stops
 * being survivable the moment it produces one per wallet: five receipts land in
 * the same second, Telegram throttles the tail of the burst, and the trades
 * with no receipt are the ones nobody can prove happened. A trade the user
 * cannot see is worse than a slow one.
 *
 * Bounded hard: at most RETRY_429_MAX waits, and never longer than
 * RETRY_429_CAP_MS each. A retry_after of two minutes means the chat is
 * genuinely flooded, and sleeping a whole worker on it would be worse than
 * dropping the message.
 */
const RETRY_429_MAX = 3;
const RETRY_429_CAP_MS = 10000;
/**
 * The host, WITHOUT the token.
 *
 * `API` ends in the bot token. netErr() falls back to the whole URL when it
 * cannot parse one, and that string goes straight into an Error message, into
 * pm2's log and — on the router's catch — very nearly into a chat. Never hand
 * the tokenful base to anything that formats an error.
 */
const TG_HOST = 'https://api.telegram.org';
/**
 * Codes that PROVE the request never reached Telegram.
 *
 * A connection that was established and then broke (ECONNRESET, a socket hang
 * up mid-response) may well have delivered the message, and a duplicate receipt
 * is its own bug — so those are reported, never retried. This is the same
 * transport-only rule the Jupiter client follows, applied to the one client
 * that did not have it.
 */
const TG_NEVER_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']);
const TG_NET_RETRIES = 2;
const TG_NET_BACKOFF_MS = 400;

/**
 * One Telegram API call.
 *
 * IT RETRIED THE WRONG FAILURE. `tg()` honours Telegram's 429 — an HTTP answer,
 * from a host that is plainly there and talking — and let a bare transport error
 * out to the caller, where nothing catches it: it unwinds through
 * send()/edit()/answer(), out of onMessage/onCallback, and lands in
 * handleUpdate's catch as the whole of "⚠️ Something glitched handling that".
 * The server log showed three of them, logged as the two words `fetch failed`,
 * with no host, no syscall, and no clue what the user had tapped.
 *
 * A blip on the way to api.telegram.org is not a glitch in the bot and must not
 * cost the user their action.
 */
async function tg(method, body) {
  for (let http429 = 0, netTries = 0; ; ) {
    let r;
    try {
      r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    } catch (e) {
      // netErr, not a fourth private idea of failure: it is the module that
      // already knows undici hides the syscall code in `err.cause`, and it sets
      // `.offline` so callers classify on the flag instead of matching text.
      const err = solana.netErr(e, TG_HOST);
      if (netTries < TG_NET_RETRIES && TG_NEVER_SENT.has(String(err.code || ''))) {
        netTries++;
        await sleep(TG_NET_BACKOFF_MS * netTries);
        continue;
      }
      throw err;
    }
    let j;
    // A proxy's HTML 502 is not a transport failure and must not be reported as
    // one — the status is the useful fact and it is the thing undici's message
    // throws away.
    try { j = await r.json(); }
    catch (_) { const err = new Error(`Telegram returned a non-JSON ${r.status} response`); err.offline = true; err.host = 'api.telegram.org'; throw err; }
    if (j && j.ok) return j;
    const wait = (j && j.error_code === 429 && j.parameters && Number(j.parameters.retry_after) > 0)
      ? Math.min(RETRY_429_CAP_MS, Math.ceil(Number(j.parameters.retry_after) * 1000))
      : 0;
    // Every other error is returned exactly as before: "message is not
    // modified", "message to edit not found" and a blocked bot are all answers,
    // and callers already read them.
    if (!wait || http429 >= RETRY_429_MAX - 1) return j;
    http429++;
    await sleep(wait);
  }
}

/**
 * Send in ORDER, one at a time, per chat.
 *
 * Firing five receipts concurrently is what provokes the flood limit in the
 * first place, and it also delivers them in whatever order the Telegram
 * frontend happens to finish — so the wallet that filled first is not
 * necessarily the receipt that appears first. Chaining them costs nothing (the
 * trades already happened in parallel; only the telling is serial) and makes
 * the chat read as a ledger.
 *
 * A failure in one link never breaks the chain: the next receipt still goes.
 */
const _sendQ = new Map();   // chatId → tail of that chat's send chain
function queuedSend(chatId, fn) {
  const prev = _sendQ.get(chatId) || Promise.resolve();
  const next = prev.then(fn, fn).catch(() => {});
  _sendQ.set(chatId, next);
  // Drop the chain once it is idle, so a long-lived process does not keep a
  // resolved promise per chat it has ever answered.
  next.then(() => { if (_sendQ.get(chatId) === next) _sendQ.delete(chatId); });
  return next;
}
function send(chatId, text, kb) { const rt = _replyCtx.getStore(); return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: kb } : {}), ...(rt ? { reply_to_message_id: rt, allow_sending_without_reply: true } : {}) }); }
function edit(chatId, mid, text, kb) { return tg('editMessageText', { chat_id: chatId, message_id: mid, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: kb } : {}) }); }
function answer(id, text) { return tg('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }); }
// Callback keys whose handler answers the query with its OWN text. These must
// NOT be pre-acked — see the comment at the top of onCallback. Keep in sync with
// every `answer(q.id, <text>)` call site; callbackAck.test.js enforces it.
const ANSWERS_ITSELF = new Set(['oc', 'al', 'wtc', 'setlang', 'gasset', 'monn', 'monx', 'cpsell', 'ospd', 'mw', 'mwa', 'mwn', 'wdaGo']);
function del(chatId, mid) { return tg('deleteMessage', { chat_id: chatId, message_id: mid }).catch(() => {}); }
/**
 * Send a PNG we rendered ourselves.
 *
 * `sendPhoto` below posts JSON, so its `photo` can only be a URL or a file_id —
 * bytes need multipart, the same shape the store backup already uses. Returns
 * false on any failure so the caller can fall back to the text card: a picture
 * is an upgrade and must never be the reason a user cannot see their PnL.
 */
async function sendPhotoBuffer(chatId, buf, caption, kb) {
  try {
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    if (caption) { fd.append('caption', caption); fd.append('parse_mode', 'HTML'); }
    if (kb) fd.append('reply_markup', JSON.stringify(kb));
    fd.append('photo', new Blob([buf], { type: 'image/png' }), 'pnl.png');
    const r = await fetch(`${API}/sendPhoto`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => null);
    if (!j || j.ok !== true) { console.error('[pnl] sendPhoto failed:', (j && j.description) || r.status); return false; }
    return true;
  } catch (e) { console.error('[pnl] sendPhoto failed:', (e && e.message) || e); return false; }
}
function sendPhoto(chatId, photo, caption, kb) { return tg('sendPhoto', { chat_id: chatId, photo, ...(caption ? { caption, parse_mode: 'HTML' } : {}), ...(kb ? { reply_markup: kb } : {}) }); }
// Deposit QR image (Telegram fetches the URL server-side; the address is public, so no
// secret leaves the bot). Configurable / disable-able via QR_API. Returns '' if disabled.
const QR_API = (process.env.QR_API === undefined ? 'https://api.qrserver.com/v1/create-qr-code' : process.env.QR_API).replace(/\/+$/, '');
const qrUrl = (data) => QR_API ? `${QR_API}/?size=320x320&margin=10&data=${encodeURIComponent(data)}` : '';
const rows = (...r) => ({ inline_keyboard: r });
const btn = (text, data) => ({ text, callback_data: data });
// Localized copy for a chat. core.getLang() has existed (and been exported) since
// the schema was written; until now nothing called it and every user got English
// regardless of what their record said. Values passed in `vars` must already be
// escaped/formatted by the caller — i18n adds no escaping (see i18n.js).
const T = (chatId, key, vars) => i18n.t(core.getLang(chatId), key, vars);

// ------------------------------------------------------------ helpers
// Escape ALL five HTML-sensitive chars — including " and ' — so a creator-set
// value (e.g. a token's website URL) can't break out of an href="..." attribute.
// &quot; and &#39; are both valid Telegram-HTML entities and render as the literal
// quote in text, so this is safe everywhere esc() is used.
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
// True when a quantity still shows as non-zero after fmt() rounds it. Guards
// every "we left something out" notice: a threshold below the display's own
// resolution announces amounts the reader sees as 0.0000.
const fmtNZ = (n) => Number(fmt(n).replace(/[KM]$/, '')) > 0;
const fmt = (n) => { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K'; return n.toFixed(n < 1 ? 4 : 2); };
// Money, for screens where the exact figure is the point.
//
// fmt() switches to K at $1,000, which is right for a market cap and wrong for
// a balance: the wallet screen showed one wallet as "≈ $1.01K" on one line and
// broke the SAME number down as "native $999.62 · tokens $8.18" two lines
// below. Both were correct and the pair reads as a bug. Thousands separators
// stay legible to about a million, and above that K/M is genuinely easier.
const usdX = (n) => {
  n = Number(n) || 0;
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  // A memecoin price is routinely 0.0000026, and two decimal places rendered
  // that as "$0.00" — the one number on the card the reader is there for, shown
  // as zero. Below a cent, switch to the subscript form every chart uses:
  // $0.0₅26 means five zeros then 26.
  if (n > 0 && n < 0.01) return '$' + subZeros(n);
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const SUB = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];
const subDigits = (k) => String(k).split('').map((d) => SUB[Number(d)]).join('');
/** 0.0000026 → "0.0₅26". Four significant digits, which is what a price needs to
 *  be compared against the last one you looked at. */
function subZeros(n) {
  const exp = Math.floor(Math.log10(n));           // -6 for 2.6e-6
  const zeros = -exp - 1;                          // leading zeros after "0."
  const digits = Number(n.toPrecision(4)) / Math.pow(10, exp);
  const sig = digits.toFixed(3).replace('.', '').replace(/0+$/, '') || '0';
  // Two or fewer zeros reads fine written out; the subscript is for the rest.
  if (zeros <= 2) return Number(n.toPrecision(4)).toFixed(zeros + 4).replace(/0+$/, '');
  return `0.0${subDigits(zeros)}${sig}`;
}
// A "contract" the user can paste: a 0x EVM address OR a base58 Solana mint. Both
// map to a token card (scoped to the active chain), and a withdraw destination.
const isEvmCa = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || '').trim());
const isCa = (s) => isEvmCa(s) || solana.isSolAddress(s);
const nativeUsd = (native) => PRICES[native] || 0;
const usd = (amount, native) => nativeUsd(native) > 0 ? '$' + fmt(Number(amount) * nativeUsd(native)) : '—';
const txLink = (chainKey, h) => { const c = core.chainOf(chainKey); return (h && c) ? `<a href="${c.explorer}/tx/${h}">tx ↗</a>` : ''; };
// Native decimals: SOL is 9 (lamports), EVM is 18 (wei). Format a raw balance for a chain.
const natDec = (chainKey) => core.chains.isSvm(chainKey) ? 9 : 18;
const fmtEth = (wei) => { try { return Number(ethers.formatEther(wei)).toFixed(5); } catch (_) { return '0'; } };
const fmtNat = (raw, chainKey) => { try { return Number(ethers.formatUnits(BigInt(raw || 0), natDec(chainKey))).toFixed(5); } catch (_) { return '0'; } };
// The address a wallet uses on a chain (base58 on Solana, 0x elsewhere).
const wAddr = (w, chainKey) => core.walletAddress(w, chainKey);
// A valid destination FOR a specific chain (base58 on Solana, 0x on EVM).
const isAddrFor = (s, chainKey) => core.chains.isSvm(chainKey) ? solana.isSolAddress(s) : isEvmCa(s);
/**
 * How to ASK a user for a destination address on a chain — the one owner, so
 * five prompts cannot describe the same thing five ways.
 *
 * ⚠️ These prompts used to say "paste the base58 address", and it was read back
 * as *"mengapa ada bacaan paste base 88 ini kan sol wallet"*. `base58` is the
 * name of an ENCODING; it is not a thing anybody sees, and it tells the user
 * nothing about whether what they just pasted is the right thing. "0x address"
 * works on EVM for the opposite reason — the user can literally SEE the `0x`.
 * The Solana equivalent is the chain's own name plus where the address comes
 * from.
 *
 * ⚠️ And NO EXAMPLE ADDRESS, ever, on a withdraw prompt. This repo has already
 * paid for a placeholder pasted literally into a live shell; here the same
 * mistake is an irreversible transfer to a stranger.
 */
function destHint(chainKey) {
  return core.chains.isSvm(chainKey)
    ? { what: '<b>Solana address</b>', note: '<i>The one Phantom, Solflare or your exchange shows for SOL — it does not start with <code>0x</code>.</i>' }
    : { what: '<b>0x address</b>', note: '' };
}
const taxStr = (t) => (t == null ? '?' : (Math.round(t * 10) / 10) + '%');
function fmtAge(ms) { const s = Math.max(0, Math.floor((Date.now() - ms) / 1000)); if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd'; }
function setPending(chatId, obj) { obj.ts = Date.now(); pending.set(chatId, obj); }
function activeChain(chatId) { return core.chainOf(core.userChain(core.ensureUser(chatId))); }
// Which wallet a withdrawal will spend from. Printed only when the user has
// more than one — on a single-wallet account it is noise, and on a multi-wallet
// one it is the fact a sweep most needs stated before it is irreversible.
function wdWalletLine(chatId, walletId) {
  try {
    const u = core.ensureUser(chatId);
    const list = core.walletList(u);
    if (list.length < 2) return '';
    const w = walletId ? core.walletById(u, walletId) : core.activeWallet(u);
    if (!w) return '';
    return ' · <b>' + esc(core.walletLabel(w, list.findIndex((x) => x.id === w.id) + 1)) + '</b>';
  } catch (_) { return ''; }
}
// Cost basis of the tokens a position currently HOLDS (drained proportionally on
// sells in core). Falls back to the legacy net-cash figure for old positions.
const posCost = (pos) => (pos && pos.costEth != null) ? pos.costEth : Math.max(0, ((pos && pos.ethIn) || 0) - ((pos && pos.ethOut) || 0));
const withTmo = (p, ms, fb) => Promise.race([p, new Promise((r) => setTimeout(() => r(fb), ms))]);
// Chart + explorer URL buttons for the token card. DexScreener covers the big
// chains by slug; anything else (e.g. Robinhood Chain) falls back to search.
// Buy amounts accept native units ('0.05') or USD ('$10', '10$', '10usd') —
// USD converts to native at the live price-feed rate at parse time.
function parseAmt(input, native, info) {
  const raw = String(input == null ? '' : input).trim().toLowerCase();
  // Same comma rules as parseUsd — this is the field that decides how much is
  // SPENT, so it must not read "0,05" differently from the price fields. It
  // previously rejected any comma outright, which was safe but meant a user
  // typing their own decimal separator was told their amount was invalid.
  const norm = normalizeDecimal(raw);
  if (!norm.ok) { if (info && norm.ambiguous) info.ambiguous = true; return null; }
  const s = norm.text;
  const m = s.match(/^\$?([0-9]*\.?[0-9]+)(\$|usd)?$/);
  if (!m) return null;
  const n = Number(m[1]); if (!(n > 0)) return null;
  if (!(s.startsWith('$') || m[2])) return { amt: String(n) };
  const px = nativeUsd(native);
  if (!(px > 0)) return { err: `price feed unavailable — send a ${native} amount instead (e.g. 0.01)` };
  return { amt: String(Number((n / px).toFixed(6))), usdVal: n };
}
// DexScreener indexes Robinhood Chain — the chain filter and /robinhood/<addr>
// pages are live. The map predates that, so robinhood was the ONE enabled chain
// falling through to `search?q=<address>`, which lands on the trending list
// rather than the token: a 📈 Chart button that shows somebody else's coins.
/** "What did it fill at, and what is this thing worth?" — the two questions a
 *  receipt leaves behind. Read once, AFTER the trade, so it never sits on the
 *  critical path; an empty string when the read fails, because a receipt is not
 *  the place to explain an indexer being down. */
async function marketLine(ca, chainKey) {
  const snap = await withTmo(core.tokenSnapshot(ca, chainKey).catch(() => null), 4000, null);
  if (!snap) return '';
  const rate = nativeUsd((core.chainOf(chainKey) || {}).native);
  const pxUsd = (snap.priceEth || 0) * rate;
  const mcUsd = snap.mcapUsd || ((snap.mcapEth || 0) * rate);
  const bits = [];
  if (pxUsd > 0) bits.push(`<b>$${Number(pxUsd.toPrecision(3))}</b>`);
  else if (snap.priceEth > 0) bits.push(`<b>${Number(snap.priceEth.toPrecision(3))} ${esc((core.chainOf(chainKey) || {}).native || '')}</b>`);
  if (mcUsd > 0) bits.push(`market cap <b>$${fmt(mcUsd)}</b>`);
  return bits.length ? `📈 Price: ${bits.join(' · ')}` : '';
}

/** The token's ticker, best-effort, for a receipt that has no fill to read it
 *  off. A failed multi-wallet buy printed "Bought $" with nothing after the
 *  dollar sign, because the only source of the symbol was a wallet that filled.
 *  Never throws and never blocks a receipt: an empty string, and the caller
 *  falls back to a shortened contract address. */
async function tokenSym(ca, chainKey) {
  const meta = await withTmo(core.tokenMeta(ca, chainKey).catch(() => null), 3000, null);
  return (meta && meta.sym) || '';
}

/** One wallet's line on a multi-wallet receipt.
 *
 *  It used to print the raw float — "0.000801724630395044 ETH" — with no dollar
 *  figure and no transaction. Eighteen decimals of noise where five carry the
 *  information, no way to tell what it was worth, and no proof it happened. The
 *  hash was in hand the whole time; it just was not being shown.
 */
function walletLine(label, chainKey, r, rate, extra) {
  const nat = r.native || '';
  const amt = Number(extra && extra.amount != null ? extra.amount : 0);
  const usd = rate > 0 ? ` <i>($${(amt * rate).toFixed(2)})</i>` : '';
  const what = extra && extra.tokens ? `${extra.tokens} · ` : '';
  const link = txLink(chainKey || r.chain, r.hash);
  return `• <b>${esc(label)}</b> · ${what}${amt.toFixed(5)} ${esc(nat)}${usd}${link ? ' · ' + link : ''}`;
}

/** Which side of the card someone is on, remembered per token.
 *
 *  Defaults to what they are most likely here for — SELL when they already hold
 *  a bag, BUY when they do not — so the common case costs no taps at all. An
 *  explicit choice sticks, because someone who taps Buy while holding means it.
 *
 *  Deliberately in memory: it is a view preference, and losing it on a restart
 *  just returns everyone to the sensible default. */
const _cardSide = new Map();
const CARD_SIDE_MAX = 5000;
function cardSide(chatId, ca, want, holding) {
  const k = chatId + ':' + String(ca).toLowerCase();
  if (want === 'buy' || want === 'sell') {
    if (_cardSide.size >= CARD_SIDE_MAX) _cardSide.delete(_cardSide.keys().next().value);
    _cardSide.set(k, want);
    return want;
  }
  const seen = _cardSide.get(k);
  // A remembered SELL is dropped once the bag is gone. The choice was made about
  // a position that no longer exists, and a Sell side with nothing to sell is a
  // screen of buttons that can only fail. A remembered BUY always stands —
  // wanting to buy more of something you hold is ordinary.
  if (seen === 'sell' && !holding) return 'buy';
  return seen || (holding ? 'sell' : 'buy');
}

/** A dollar figure as a person would type it: 2k, 101K, 1.5m, $250,000, 0.0025.
 *
 *  A market-cap target is six or seven digits and was being typed out in full —
 *  "mc 1000000" — where one wrong zero sets the order ten times away from what
 *  was meant, on a screen whose whole job is to fire without asking again.
 *
 *  Returns null on anything it cannot read, never a guess: this number decides
 *  when a position is sold. */
/**
 * A comma in a number means different things to different people, and getting
 * it wrong here costs money.
 *
 * parseUsd used to strip every comma as a thousands separator, so "1,5" — how
 * most of this bot's users write one-and-a-half, see the note at the top of
 * i18n.js — parsed as FIFTEEN. That figure becomes an order trigger. A user
 * setting a stop-loss at "0,5" on a token trading at $2 got a target of $5, and
 * the watcher fires a stop when price <= target: 2 <= 5, so the bot sold their
 * entire bag the moment the order was created. Ten times off in the other
 * direction is a take-profit that simply never fires.
 *
 * Rules, in order:
 *   both separators   → the LAST one is the decimal ("1.234,56" and "1,234.56"
 *                       both mean 1234.56). Unambiguous, accepted.
 *   grouped thousands → "250,000", "1,234,567". Groups are exactly 3 digits and
 *                       the leading group cannot start with 0, which is what
 *                       separates "250,000" (grouping) from "0,001" (a decimal
 *                       — nobody writes a thousands group as "0").
 *   comma otherwise   → decimal ("1,5" → 1.5, "0,0025" → 0.0025).
 *
 * "1,500" therefore reads as 1500. It is the one form both conventions can
 * produce, and grouping wins because somebody meaning one-and-a-half types
 * "1,5" — the two trailing zeros are the tell. Anything that fits neither shape
 * ("1,23,4") is refused rather than guessed at, and the caller says why.
 */
function normalizeDecimal(raw) {
  const s = String(raw == null ? '' : raw);
  const commas = (s.match(/,/g) || []).length;
  if (!commas) return { ok: true, text: s };
  const dots = (s.match(/\./g) || []).length;
  if (dots) {
    // Whichever appears last is the decimal point; the other is grouping.
    const dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    const other = dec === ',' ? /\./g : /,/g;
    return { ok: true, text: s.replace(other, '').replace(dec, '.') };
  }
  // Grouped thousands: 3-digit groups, leading group 1-999 and never starting
  // with 0. "0,001" fails that on purpose — a thousands group is never "0".
  if (/^[1-9]\d{0,2}(,\d{3})+$/.test(s)) return { ok: true, text: s.replace(/,/g, '') };
  if (commas >= 2) return { ok: false }; // several commas that are not grouping
  return { ok: true, text: s.replace(',', '.') };
}

const AMBIGUOUS_COMMA = '\n\n<i>A comma can mean a decimal point or a thousands separator, and here the two differ by 1000×. Write it with a period (<code>1.5</code>) or with no separator at all (<code>1500</code>).</i>';

/** `info` is optional; when passed, `info.ambiguous` tells the caller the input
 *  was refused for the comma reason above rather than for being nonsense. */
function parseUsd(input, info) {
  let s = String(input == null ? '' : input).trim().toLowerCase();
  s = s.replace(/^\$/, '').replace(/(\$|usd)$/, '').trim();
  const norm = normalizeDecimal(s);
  if (!norm.ok) { if (info && norm.ambiguous) info.ambiguous = true; return null; }
  s = norm.text.trim();
  const m = s.match(/^([0-9]*\.?[0-9]+)\s*([kmb])?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || !(n > 0)) return null;
  const mult = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1;
  const v = n * mult;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** The inverse of parseUsd: a dollar figure written the way we ask people to
 *  type it, so an example can be copied straight back into the box. */
const usdShort = (v) => {
  if (!(v > 0)) return '0';
  const cut = (n, suf) => String(Number(n.toFixed(n >= 100 ? 0 : 1))) + suf;
  if (v >= 1e9) return cut(v / 1e9, 'b');
  if (v >= 1e6) return cut(v / 1e6, 'm');
  if (v >= 1e3) return cut(v / 1e3, 'k');
  return String(Number(v.toPrecision(3)));
};

/** The "what target do you want" prompt, with examples computed from where the
 *  token ACTUALLY is.
 *
 *  The examples used to be constants — "0.0025", "mc 2k". Someone holding $PONS
 *  at $0.0272 with a $27M cap reads those and still has to work out what to type
 *  for their own position, which is the entire question they came here with. A
 *  target is a multiple of the price in front of them, so the prompt does that
 *  arithmetic. */
async function orderPrompt(ca, chainKey, kind) {
  const ch = core.chainOf(chainKey) || {};
  const snap = await withTmo(core.tokenSnapshot(ca, chainKey).catch(() => null), 4000, null);
  const rate = nativeUsd(ch.native);
  const px = snap && snap.priceEth > 0 && rate > 0 ? snap.priceEth * rate : 0;
  const mc = snap ? (snap.mcapUsd || ((snap.mcapEth || 0) * rate)) : 0;
  const sym = (snap && snap.sym) || '';
  const up = kind === 'tp';
  const head = up
    ? `🎯 <b>Limit sell${sym ? ' $' + esc(sym) : ''}</b> — sells 100% automatically when the price goes <b>UP</b>`
    : `🛑 <b>Stop-loss${sym ? ' $' + esc(sym) : ''}</b> — sells 100% automatically when the price goes <b>DOWN</b>`;
  const L = [head, ''];
  if (px > 0) L.push(`📈 <b>Now:</b> $${Number(px.toPrecision(3))}${mc > 0 ? ` · market cap $${fmt(mc)}` : ''}`, '');
  L.push('❓ <b>What price or market cap do you want to sell at?</b>', '');

  // FORMAT FIRST, examples second. "Reply with one of these:" over a list of
  // four numbers reads as a menu — pick one — rather than as two ways of
  // answering with any number you like. The question people were left with was
  // not "which of these four" but "what am I supposed to type".
  const pxEg = px > 0 ? Number((px * (up ? 2 : 0.7)).toPrecision(3)) : 0.0025;
  const mcEg = mc > 0 ? usdShort(mc * (up ? 2 : 0.7)) : (up ? '101k' : '250k');
  L.push('📝 <b>Reply with EITHER of these two:</b>');
  L.push(`  <b>1. A price</b> — just the number  →  <code>${pxEg}</code>`);
  L.push(`  <b>2. A market cap</b> — put <code>mc</code> in front  →  <code>mc ${mcEg}</code>`);
  L.push('');

  // Two multiples in the direction this order watches. Round numbers a holder
  // actually thinks in — double and 5× on the way up, a third and a half off on
  // the way down.
  const ms = up ? [[2, '2×'], [5, '5×']] : [[0.7, '−30%'], [0.5, '−50%']];
  if (px > 0) {
    L.push('💡 <b>Any number you want.</b> For reference, from where it is now:');
    for (const [k, why] of ms) {
      const priceCol = `<code>${Number((px * k).toPrecision(3))}</code>`;
      L.push(mc > 0 ? `  <b>${why}</b> → ${priceCol}  or  <code>mc ${usdShort(mc * k)}</code>` : `  <b>${why}</b> → ${priceCol}`);
    }
  } else {
    // No price read. Say so rather than printing invented multiples next to a
    // token whose value we could not fetch.
    L.push('<i>💡 Any number you want. I could not read this token\'s price just now, so the two above are generic examples rather than multiples of it.</i>');
  }
  L.push('', '<i>k = thousand · m = million · b = billion · $ and commas are fine.</i>');
  if (!up) L.push('<i>Fires at 🚀 Turbo gas so it lands during a dump — change it under 📋 Orders.</i>');
  return L.join('\n');
}

const DS_SLUG = { robinhood: 'robinhood', ethereum: 'ethereum', base: 'base', bsc: 'bsc', arbitrum: 'arbitrum', solana: 'solana' };
const chartUrl = (chainKey, ca) => DS_SLUG[chainKey] ? `https://dexscreener.com/${DS_SLUG[chainKey]}/${ca}` : `https://dexscreener.com/search?q=${ca}`;
const expTokenUrl = (chainKey, ca) => { const c = core.chainOf(chainKey); return c ? `${c.explorer}/token/${ca}` : ''; };

// Maestro-style chain auto-detect: figure out which enabled chain a pasted CA
// lives on so the user never has to switch chains to trade. base58 → Solana;
// 0x → probe every enabled EVM chain for contract code in parallel (bounded).
// Prefers the ACTIVE chain when the same address is a contract on several
// chains (common for multi-chain deployments). Returns { chain } on a unique
// hit, { choices } when ambiguous, {} when nothing was found (caller falls
// back to the active chain, which keeps the old behavior for edge cases).
async function detectChain(chatId, ca) {
  if (!isEvmCa(ca)) {
    const sol = core.chains.enabledChains().find((c) => core.chains.isSvm(c.key));
    return sol ? { chain: sol.key } : {};
  }
  const evm = core.chains.enabledChains().filter((c) => !core.chains.isSvm(c.key));
  // Bytecode presence and traded-ness, in one wave — the indexer call is the
  // same 6s budget as the code probes, so this costs no extra wall clock.
  const [hits, traded] = await Promise.all([
    Promise.all(evm.map(async (c) => {
      const code = await withTmo(core.providerFor(c.key).getCode(ca).catch(() => null), 4000, null);
      return (code && code !== '0x') ? c.key : null;
    })).then((r) => r.filter(Boolean)),
    core.dsChainsOf(ca).catch(() => []),
  ]);
  const active = core.userChain(core.ensureUser(chatId));
  // WHERE IT TRADES BEATS WHERE IT EXISTS. Bytecode says only that somebody
  // deployed something at that address — routine for multichain deployments, and
  // it was enough to pin a paste onto whatever chain the user happened to have
  // selected. That is how an Ethereum token got answered with "couldn't price it
  // on Robinhood Chain": the active chain won a tie it should never have been in.
  if (traded.length) {
    if (traded.includes(active)) return { chain: active };
    if (traded.length === 1) return { chain: traded[0] };
    return { choices: traded };
  }
  if (hits.includes(active)) return { chain: active };
  if (hits.length === 1) return { chain: hits[0] };
  if (hits.length > 1) return { choices: hits };
  return {};
}

// ------------------------------------------------------------ screens
function mainMenu() {
  return rows(
    [btn('💼 Wallets', 'wal'), btn('📊 Portfolio', 'pos'), btn('🧾 History', 'hist')],
    [btn('🌐 Chain', 'chain'), btn('🎯 Snipe', 'snipe'), btn('📋 Orders', 'orders')],
    [btn('📊 PnL', 'pnl'), btn('🔔 Alerts', 'alerts'), btn('👥 Copy', 'copy')],
    [btn('🎁 Referrals', 'ref'), btn('🧾 History', 'hist'), btn('🔁 DCA', 'dcas')],
    [btn('⚙️ Settings', 'set'), btn('❔ Help', 'help')],
  );
}
// The Wallet menu is an ALL-WALLETS dashboard (Maestro-style): every wallet with its
// name, live balance and full address on one screen — tap a name to switch, ✏️ rename,
// 📥 deposit QR, 🗑 remove. Export/Withdraw act on the ✅ active wallet.
// USD value of each wallet's TOKEN holdings (bags), so the wallet total reflects the full
// portfolio, not just native coin. Uses the bot-tracked bag size (p.tokens — no per-token
// RPC) and prices each distinct token ONCE (deduped, cached 30s, bounded + timed out), so
// it stays fast. Returns a per-wallet USD array aligned to `list`.
async function walletTokenUsd(list, enabledKeys) {
  const distinct = new Map();               // 'chain:caLower' -> { chain, ca }
  const bags = list.map(() => []);          // per wallet: [{ ck, tokens, native, chain, ca, sym }]
  list.forEach((w, wi) => {
    for (const key of Object.keys(w.positions || {})) {
      const p = w.positions[key];
      if (!p || p.closed || !enabledKeys.has(p.chain)) continue;
      let raw = 0n; try { raw = BigInt(p.tokens || '0'); } catch (_) { continue; }
      if (raw <= 0n) continue;
      const tokens = Number(ethers.formatUnits(raw, p.dec || 18));
      if (!(tokens > 0)) continue;
      const ck = p.chain + ':' + String(p.ca).toLowerCase();
      distinct.set(ck, { chain: p.chain, ca: p.ca });
      bags[wi].push({ ck, tokens, native: (core.chainOf(p.chain) || {}).native || 'ETH', chain: p.chain, ca: p.ca, sym: p.sym || '' });
    }
  });
  // Same shape as the fully-priced return below — an empty BAG list per wallet,
  // never a 0. This used to return numbers while the main path returned arrays,
  // which is exactly the sort of split that only shows up on the one code path
  // nobody renders in a test: a user with no positions at all.
  if (!distinct.size) return list.map(() => []);
  const now = Date.now();
  const stale = [...distinct.entries()].filter(([ck]) => { const h = _priceCache.get(ck); return !(h && now - h.at < 30000); });
  await Promise.all(stale.map(([ck, { chain, ca }]) =>
    withTmo(core.tokenSnapshot(ca, chain).catch(() => null), 4000, null)
      .then((snap) => { _priceCache.set(ck, { priceEth: (snap && snap.priceEth > 0) ? snap.priceEth : 0, at: Date.now() }); })));
  if (_priceCache.size > 5000) { const first = _priceCache.keys().next().value; _priceCache.delete(first); }
  // Priced bags per wallet. The USD TOTAL on the wallet screen and the per-token
  // BREAKDOWN on the tokens screen are both derived from this one array, so the
  // two can never disagree — a screen that says "$24.87 in tokens" next to a
  // list that adds up to something else is the kind of contradiction that makes
  // a user distrust every other number on the page.
  return bags.map((wb) => wb.map((b) => {
    const h = _priceCache.get(b.ck); const priceEth = h ? h.priceEth : 0;
    return { chain: b.chain, ca: b.ca, sym: b.sym, tokens: b.tokens, usd: b.tokens * priceEth * nativeUsd(b.native), priced: priceEth > 0 };
  }));
}
/** Per-wallet USD totals — the shape walletScreen wants. */
const bagsToUsd = (bags) => bags.map((wb) => wb.reduce((s, b) => s + b.usd, 0));
async function walletScreen(chatId) {
  const u = core.ensureUser(chatId);
  const ch = core.chainOf(core.userChain(u));
  const list = core.walletList(u);
  // Maestro-style: EVERY wallet × EVERY enabled chain, fetched in parallel (one
  // EVM key = same 0x address everywhere, Solana has its own), so a deposit on
  // ANY chain shows up in the totals — never just the active chain. A chain
  // whose RPC doesn't answer in time is null → '—', not a misleading 0.
  const allChains = core.chains.enabledChains();
  const awIdx = Math.max(0, list.findIndex((w) => w.id === u.activeWalletId));
  // STRICT reads: core.ethBalance swallows EVM RPC errors into 0n, which made a
  // dead RPC render as "0 ETH" (looked like an untracked deposit). Read the
  // provider directly with one retry; a chain that still fails is null → '—'.
  // 2.5s per read, not 6 ("mengapa bot masih lama merespon??"). This wave is
  // wallets × chains requests to mostly public RPCs and the SCREEN waits for
  // the slowest one, so a single throttled endpoint held the whole dashboard
  // for its full timeout on every open. A read that misses the window falls
  // back to the ≤10-min last-known cache below — exactly what that cache is
  // for — and a chain that is genuinely down reads "couldn't reach" either way.
  // Read a COLUMN per chain, not a cell per wallet — see readNativeColumn. The
  // wave is still every chain at once; what changed is that Solana's five cells
  // are one request instead of five racing each other into a 429.
  const colsP = Promise.all(allChains.map((c) => readNativeColumn(list, c)));
  // Token pricing needs nothing from the balance matrix; the two waves used to
  // run in SERIES, so every /wallet paid both latencies end to end.
  const tokenBagsP = walletTokenUsd(list, new Set(allChains.map((c) => c.key)));
  const [cols, tokenBags] = await Promise.all([colsP, tokenBagsP]);
  const rawMatrix = list.map((_w, wi) => allChains.map((_c, ci) => cols[ci].bals[wi]));
  // Why each chain went unread, by chain key. "Couldn't reach Solana" with no
  // reason is what made this take a screenshot to diagnose: a 429, a refusal and
  // our own 2.5s bound were one sentence.
  const chainWhy = {};
  allChains.forEach((c, ci) => { if (cols[ci].why) chainWhy[c.key] = cols[ci].why; });
  // Resolve each cell: a successful read (incl. a real 0) updates the last-known cache; a
  // FAILED read (null, e.g. RPC timeout) falls back to the last-known balance (≤10 min) so
  // the grand total stays stable and accurate instead of silently undercounting.
  const nowMs = Date.now();
  const matrix = list.map((w, wi) => allChains.map((c, ci) => {
    const key = w.id + ':' + c.key;
    const live = rawMatrix[wi][ci];
    if (live != null) { _balCache.set(key, { raw: live, at: nowMs }); return live; }
    const hit = _balCache.get(key);
    return (hit && (nowMs - hit.at) < 600000) ? hit.raw : null;
  }));
  if (_balCache.size > 5000) { const first = _balCache.keys().next().value; _balCache.delete(first); }
  // Per-wallet USD total across chains + the grand total over all wallets.
  const usdOfRow = (row) => row.reduce((sum, b, i) => {
    if (b == null) return sum;
    return sum + Number(fmtNat(b, allChains[i].key)) * nativeUsd(allChains[i].native);
  }, 0);
  const nativeUsdArr = matrix.map(usdOfRow);
  // TOKEN holdings (fetched above, concurrently) so each wallet's total is the
  // full portfolio value, not just native coin.
  const tokenUsdArr = bagsToUsd(tokenBags);
  const walletUsd = nativeUsdArr.map((v, i) => v + (tokenUsdArr[i] || 0));
  const grandUsd = walletUsd.reduce((a, b) => a + b, 0);
  const grandNative = nativeUsdArr.reduce((a, b) => a + b, 0);
  const grandToken = tokenUsdArr.reduce((a, b) => a + b, 0);
  const anyFunds = grandToken > 0.05 || matrix.some((row) => row.some((b, i) => b != null && Number(fmtNat(b, allChains[i].key)) > 0));
  // What is on the chain the user actually PICKED — coins plus the bags that
  // live there — summed over every wallet, so it is directly comparable with
  // grandUsd on the line below it.
  //
  // This number is the whole point of this block. The screen used to print the
  // chain badge on the title line and the ALL-CHAINS total immediately under
  // it, which is as plainly as a layout can say "this is what you have on
  // Solana". A user switched to Solana, read "$1,322.54", and had 0 SOL — the
  // money was on Robinhood Chain. Neither number was wrong; the screen simply
  // never printed the one being asked for.
  const acIdx = allChains.findIndex((c) => c.key === ch.key);
  const acNativeAmt = (wi) => {
    const b = acIdx < 0 ? null : (matrix[wi] || [])[acIdx];
    return b == null ? null : Number(fmtNat(b, ch.key));
  };
  const activeChainUsd = list.reduce((sum, _w, wi) => {
    const amt = acNativeAmt(wi);
    const bags = (tokenBags[wi] || []).reduce((s, b) => s + (b.chain === ch.key ? b.usd : 0), 0);
    return sum + (amt == null ? 0 : amt * nativeUsd(ch.native)) + bags;
  }, 0);
  // One wallet we could not read makes that sum understated, and "$0.00 here" is
  // the most damaging way to be wrong on this line — it is the sentence that
  // sends someone to check whether their deposit arrived. Same rule as the
  // per-chain rows below: empty and unreadable are different facts.
  const acUnread = acIdx < 0 || matrix.some((row) => row[acIdx] == null);
  // Active wallet's per-chain breakdown.
  //
  // The ACTIVE chain's row comes FIRST, whatever it holds. Everything else is
  // ordered behind it, and only chains that HOLD something get a row: the
  // version before that printed every enabled chain in registry order, so a
  // normal wallet spent three of its seven lines saying "Base: 0 ETH ·
  // Arbitrum: 0 ETH · Solana: 0 SOL" and the chain being traded on could land
  // anywhere in the list — or, at zero, nowhere. The zeros are summarised in
  // one line instead, and the ONE case where a zero is worth a sentence — no
  // gas on the chain you are actually trading on — becomes a warning that
  // REPLACES the row rather than following it, so "0 SOL" is said once.
  //
  // A null (RPC did not answer) is NOT folded in with the zeros: "empty" and
  // "we could not look" are different facts, and the second one means the total
  // above is understated. That distinction is why readNative is strict.
  let activeChainLine = '';
  let chainBlock = '';
  const emptyChains = [];
  const unreadChains = [];
  let activeChainNative = null;
  const cells = allChains.map((c, i) => ({ c, i }));
  for (const { c, i } of [...cells.filter((x) => x.c.key === ch.key), ...cells.filter((x) => x.c.key !== ch.key)]) {
    const isActive = c.key === ch.key;
    const b = (matrix[awIdx] || [])[i];
    if (b == null) { unreadChains.push(c.name); continue; }
    const amt = Number(fmtNat(b, c.key));
    if (isActive) activeChainNative = amt;
    if (!(amt > 0)) { if (!isActive) emptyChains.push(c.name); continue; }
    const usdV = nativeUsd(c.native) * amt;
    const row = `${c.emoji} ${esc(c.name)} — <b>${amt.toFixed(4)} ${c.native}</b>${usdV > 0.005 ? ` · ${usdX(usdV)}` : ''}\n`;
    if (isActive) activeChainLine = row; else chainBlock += row;
  }
  // The only zero worth a sentence: no gas on the chain they are trading on.
  // When ANOTHER wallet does have some, say which — otherwise the chain line
  // above ("🟣 Solana — $700.00") and this warning ("0 SOL") read as the screen
  // contradicting itself, when in fact they are about different wallets.
  if (activeChainNative === 0) {
    activeChainLine = T(chatId, 'wal.no_gas', { native: esc(ch.native), chain: esc(ch.name) }) + '\n';
    const alt = list.map((w, i) => ({ i, w, amt: acNativeAmt(i) })).find((x) => x.i !== awIdx && x.amt > 0);
    if (alt) {
      activeChainLine += T(chatId, 'wal.gas_elsewhere', {
        wallet: `<b>${esc(core.walletLabel(alt.w, alt.i + 1))}</b>`,
        amt: alt.amt.toFixed(4),
        native: esc(ch.native),
      }) + '\n';
    }
  }
  chainBlock = activeChainLine + chainBlock;
  if ((tokenUsdArr[awIdx] || 0) > 0.05) chainBlock += `${T(chatId, 'wal.tokens_row')} — <b>${usdX(tokenUsdArr[awIdx])}</b>\n`;
  if (emptyChains.length) chainBlock += T(chatId, 'wal.empty_on', { chains: esc(emptyChains.join(' · ')) }) + '\n';
  if (unreadChains.length) {
    chainBlock += T(chatId, 'wal.unread_on', { chains: esc(unreadChains.join(' · ')) }) + '\n';
  }
  // ⚠️ AND WHY — ONCE, FOR THE WHOLE SCREEN, because it is a fact about the
  // CHAIN and not about a wallet.
  //
  // It used to live inside the active wallet's block, which is how the reported
  // screen came to say "the Solana RPC is rate-limiting this server (429)" at
  // the top and `⚠️ 1 chain(s) unread` on four rows underneath with nothing at
  // all. Printing it in both places would be two owners of one sentence, and
  // the active wallet is not even reliably one of them: the ≤10-min last-known
  // cache can carry ITS cell while another wallet's stays null, so the block
  // that held the reason renders no unread line to hang it on.
  const unreadAnywhere = allChains.filter((c, ci) => matrix.some((row) => row[ci] == null));
  const byWhy = new Map();   // reason -> [chain names], so one dead host is one line
  unreadAnywhere.forEach((c) => {
    const w = chainWhy[c.key];
    if (w) byWhy.set(w, [...(byWhy.get(w) || []), c.name]);
  });
  const whyBlock = [...byWhy.entries()]
    .map(([w, names]) => `<i>${esc(names.join(' · '))} — ${esc(w)}</i>`)
    .join('\n');
  // One EVM key = one 0x address shared by every EVM chain; Solana has its own key.
  // Show BOTH addresses per wallet so it's obvious where to deposit each — but
  // the ACTIVE chain's goes first. Depositing is the reason someone reads this
  // block, and a user on Solana had to skip a five-chain EVM label and a 42-char
  // 0x address to reach the only one that could receive their SOL.
  const evmChain = allChains.find((c) => !core.chains.isSvm(c.key)) || allChains[0];
  const solChain = allChains.find((c) => core.chains.isSvm(c.key));
  const evmNames = allChains.filter((c) => !core.chains.isSvm(c.key)).map((c) => c.name).join(' · ');
  const evmAddrBlock = `<i>${T(chatId, 'wal.addr_evm', { chains: esc(evmNames) })}</i>\n<code>${wAddr(list[awIdx], evmChain.key)}</code>\n`;
  const solAddrBlock = solChain
    ? `<i>${T(chatId, 'wal.addr_sol', { chain: esc(solChain.name) })}</i>\n<code>${wAddr(list[awIdx], solChain.key)}</code>\n`
    : '';
  const addrBlock = core.chains.isSvm(ch.key) ? solAddrBlock + evmAddrBlock : evmAddrBlock + solAddrBlock;
  // ONE block per wallet. The old layout rendered the active wallet twice — a
  // detail block above and a row in the list below — under two different
  // glyphs (🌐 then ✅) and two different roundings of the same number
  // ($1.01K vs "native $999.62 · tokens $8.18"). Read from the top it looks
  // like the bot listed a wallet it had already listed, and got it wrong.
  //
  // Addresses: full and copyable for the ACTIVE wallet only. Printing both a
  // 42-char EVM and a 44-char Solana address for all ten wallets was ~2,500
  // characters of the message, and every one of them wraps on a phone. 📥 on
  // any row still gives that wallet's address and QR, which is also the only
  // safe way to hand over an address — a shortened one must never be tappable
  // to copy, because a copied 0x2d14…6B8 is a withdrawal into nowhere.
  // Character budget for the "other wallets" list, sized so the whole screen
  // stays under Telegram's 4096 with room for the header, the active wallet's
  // chain rows, both of its addresses, the roll-up line and the hint.
  const OTHERS_MAX_CHARS = 2600;
  let others = '';
  let rolledUp = 0;
  let rolledUpUsd = 0;
  const kbRows = [];
  list.forEach((w, i) => {
    const active = i === awIdx;
    const label = core.walletLabel(w, i + 1);
    const nOrders = (w.orders && w.orders.length) || 0;
    const orders = nOrders ? ` · ${T(chatId, 'wal.orders', { n: nOrders })}` : '';
    if (!active) {
      // sendMessage caps at 4096 characters and tg() never inspects the
      // response, so an oversized screen is not an error the user can see —
      // /wallet simply does nothing. core.js lets MAX_WALLETS_PER_USER go to
      // 99, which no layout of one line each can fit. The overflow is rolled
      // into a line that SAYS how many and what they hold: this codebase's rule
      // is that a card dropping wallets reads as a card that lost them. Every
      // rolled-up wallet still has its own button below.
      if (others.length < OTHERS_MAX_CHARS) {
        // WHAT the wallet holds, not just what it is worth. "Wallet 2 · $671.62"
        // answers none of the questions a person opens this screen with — which
        // chain the money sits on, whether it is coins or bags, whether it can
        // pay its own gas. The matrix already read every wallet × every chain
        // for the totals above, so the breakdown costs nothing extra.
        //
        // CLEAN over complete: only chains that HOLD something get a segment
        // (the active wallet's block already established that zeros are noise),
        // token bags collapse to one 🪙 figure, and a wallet whose reads all
        // failed says so instead of rendering as empty — "empty" and "we could
        // not look" stay different facts, same rule as the block above.
        const bits = [];
        const rowUnread = [];
        (matrix[i] || []).forEach((b, ci) => {
          // ⚠️ NAME THE CHAIN. This row said `⚠️ 1 chain(s) unread` and nothing
          // else — not which chain, not why — while the active wallet's block
          // three lines up said both. A lesson applied to one of two surfaces,
          // and it is why "masih 1 chain unread" had to be reported with a
          // screenshot: the count is meaningless at one and unhelpful at two.
          if (b == null) { rowUnread.push(allChains[ci].name); return; }
          const amt = Number(fmtNat(b, allChains[ci].key));
          if (!(amt > 0)) return;
          bits.push(`${allChains[ci].emoji} ${+amt.toFixed(4)} ${allChains[ci].native}`);
        });
        if ((tokenUsdArr[i] || 0) > 0.05) bits.push(`🪙 ${usdX(tokenUsdArr[i])}`);
        if (rowUnread.length) bits.push(T(chatId, 'wal.row_unread', { chains: esc(rowUnread.join(' · ')) }));
        others += `▫️ <b>${esc(label)}</b> · ${usdX(walletUsd[i])}${orders}\n`
          + (bits.length ? `└ ${bits.join(' · ')}\n` : '');
      }
      else { rolledUp++; rolledUpUsd += walletUsd[i]; }
    }
    const row = [btn(`${active ? '✓ ' : '⚪ '}${label}`.slice(0, 26), active ? 'wal' : 'sw:' + w.id), btn('✏️', 'rnw:' + w.id), btn('📥', 'qrw:' + w.id)];
    if (list.length > 1) row.push(btn('🗑', 'rmw:' + w.id));
    kbRows.push(row);
  });
  if (list.length < core.WALLET_CAP) kbRows.push([btn(`➕ Generate wallet (${list.length}/${core.WALLET_CAP})`, 'neww'), btn('📩 Import', 'imp')]);
  // ONE withdraw button. It opens chain → wallets, and the wallet step is where
  // "one or all of them" is answered — a second button for the same screen was
  // the same confusion as the second command.
  kbRows.push([btn('🔑 Export (active)', 'exp'), btn('📤 Withdraw', 'wd')]);
  // "…in tokens" is a number with no answer to "which ones?" unless this button
  // exists: /portfolio is scoped to the ACTIVE chain, so a bag on any other
  // chain had no screen at all. Only offered when there is something to show.
  if (grandToken > 0.05) kbRows.push([btn('🪙 My tokens', 'toks'), btn('📊 Portfolio', 'pos')]);
  kbRows.push([btn('🌐 Chain', 'chain'), btn('🔄 Refresh', 'wal'), btn('« Menu', 'menu')]);

  const activeLabel = esc(core.walletLabel(list[awIdx], awIdx + 1));
  const orders = ((list[awIdx] && list[awIdx].orders) || []).length;
  // TWO numbers, never one wearing a chain badge. When the active chain holds
  // everything there IS only one number, and printing it twice is the same
  // clutter from the other side — so that case collapses back to the old
  // single line, chain badge and all.
  const oneChainOnly = !acUnread && Math.abs(activeChainUsd - grandUsd) < 0.005;
  // TOTAL FIRST — it is the headline, and it is the only bold dollar figure in
  // the header so nothing competes with it. The active chain's share sits under
  // it with an explicit "On <chain>:" label; two labelled scopes cannot be
  // misread as the screen disagreeing with itself, which is what "…$508.02
  // here" stacked against "…every chain" was. The wallet-slot cap ("5 of 10")
  // is gone from this line — it read as "only 5 of your 10 wallets were
  // counted" — and lives on the ➕ Generate button, where capacity is decided.
  // "harus ada jumlah solananya brp": the chain header carries the NATIVE
  // amount beside the USD — the coin count is the number a depositor checks
  // against their own wallet, and USD alone made them do the division.
  const acNativeTotal = list.reduce((s, _w, wi) => s + (acNativeAmt(wi) || 0), 0);
  const totals = oneChainOnly
    ? `${T(chatId, 'wal.title')} · ${ch.emoji} ${esc(ch.name)}\n`
      + `${T(chatId, 'wal.total', { usd: usdX(grandUsd) })}\n`
    : `${T(chatId, 'wal.title')}\n`
      + `${T(chatId, 'wal.total_all', { usd: usdX(grandUsd) })}\n`
      + `${T(chatId, acUnread ? 'wal.on_chain_unread' : 'wal.on_chain', {
        emoji: ch.emoji, chain: esc(ch.name), usd: usdX(activeChainUsd),
        amt: String(+acNativeTotal.toFixed(4)), native: esc(ch.native) })}\n`;
  // "…dan total itu total dalam token apa aja": the Total is decomposed into
  // the COINS behind it, grouped by symbol (ETH held on four chains is one ETH
  // figure — same value wherever it sits); the token share keeps its own line
  // below, and 🪙 My tokens has the per-token detail.
  const bySym = new Map();
  matrix.forEach((row) => row.forEach((b, ci) => {
    if (b == null) return;
    const amt = Number(fmtNat(b, allChains[ci].key));
    if (amt > 0) bySym.set(allChains[ci].native, (bySym.get(allChains[ci].native) || 0) + amt);
  }));
  const coinBits = [...bySym.entries()].map(([sym, amt]) => `<b>${+amt.toFixed(4)} ${sym}</b>`);
  const assetsLine = coinBits.length ? T(chatId, 'wal.assets', { list: coinBits.join(' · ') }) + '\n' : '';
  // The coins/tokens split earns its line only when both halves are worth
  // reading. "$1,322.22 in coins · $0.33 in tokens" spends a line restating the
  // total; 🪙 My tokens is still offered, because a route to detail is not the
  // same as a claim about the balance.
  const showSplit = grandToken > 0.05 && grandToken > grandUsd * 0.01 && grandNative > grandUsd * 0.01;
  const head = totals
    + assetsLine
    + (showSplit ? `${T(chatId, 'wal.split', { tokens: usdX(grandToken) })}\n` : '')
    + `\n${T(chatId, 'wal.active_head')}\n`
    + `✅ <b>${activeLabel}</b> · <b>${usdX(walletUsd[awIdx])}</b>${orders ? ` · ${T(chatId, 'wal.orders', { n: orders })}` : ''}\n`
    + chainBlock
    + addrBlock
    + (others ? `\n${T(chatId, 'wal.others_head')}\n${others}` : '')
    + (rolledUp ? `<i>${T(chatId, 'wal.more', { n: rolledUp, usd: usdX(rolledUpUsd) })}</i>\n` : '')
    + (whyBlock ? `\n${whyBlock}\n` : '');
  const guide = !anyFunds
    ? `\n${T(chatId, 'wal.first_steps', { native: esc(ch.native) })}\n\n${T(chatId, 'wal.keys_note')}`
    : `\n${T(chatId, 'wal.hint')}`;
  return { text: head + guide, kb: { inline_keyboard: kbRows } };
}
/**
 * Every token you hold, on every chain, grouped by chain.
 *
 * WHY THIS EXISTS SEPARATELY FROM /portfolio
 * `core.portfolioAll` skips any position whose `p.chain !== chainKey`, so the
 * portfolio only ever shows the ACTIVE chain — and it has to, because it reports
 * PnL denominated in that chain's native coin, and ETH-denominated profit cannot
 * be added to BNB-denominated profit. Meanwhile the wallet screen's "in tokens"
 * figure counts EVERY enabled chain. So the bot could tell you that you held
 * $24.87 of tokens and then offer no screen that showed you what they were: the
 * ones on a chain you were not currently switched to were invisible.
 *
 * USD is what makes a cross-chain list possible at all, so that is the unit
 * here. Per-token PnL stays on /portfolio where the native denomination is
 * meaningful — this screen answers "what do I hold, and where", nothing else.
 *
 * HONEST LIMIT: positions are what the bot BOUGHT. A token sent in from an
 * outside wallet was never recorded, so it is not here and is not in the wallet
 * screen's total either — the two agree, and the note says so rather than
 * letting a user conclude their balance vanished.
 */
async function tokensScreen(chatId) {
  const u = core.ensureUser(chatId);
  const list = core.walletList(u);
  const allChains = core.chains.enabledChains();
  const bags = await walletTokenUsd(list, new Set(allChains.map((c) => c.key)));

  // chainKey -> caLower -> { sym, ca, chain, tokens, usd, holders:[label], unpriced }
  const byChain = new Map();
  let grand = 0;
  bags.forEach((wb, wi) => {
    const label = core.walletLabel(list[wi], wi + 1);
    for (const b of wb) {
      const per = byChain.get(b.chain) || new Map();
      const k = String(b.ca).toLowerCase();
      const row = per.get(k) || { sym: b.sym, ca: b.ca, chain: b.chain, tokens: 0, usd: 0, holders: [], unpriced: false };
      row.tokens += b.tokens; row.usd += b.usd;
      if (!b.priced) row.unpriced = true;
      if (!row.holders.includes(label)) row.holders.push(label);
      per.set(k, row); byChain.set(b.chain, per);
      grand += b.usd;
    }
  });

  if (!byChain.size) {
    return { text: `${T(chatId, 'tok.title')}\n\n${T(chatId, 'tok.empty')}`,
      kb: rows([btn('💼 Wallets', 'wal'), btn('« Menu', 'menu')]) };
  }

  const L = [`${T(chatId, 'tok.title')}`, `${T(chatId, 'tok.total', { usd: `<b>${usdX(grand)}</b>` })}`];
  const kbRows = [];
  let anyUnpriced = false;
  // Chains in the order the picker shows them, so this screen and /chain agree.
  for (const c of allChains) {
    const per = byChain.get(c.key);
    if (!per) continue;
    const items = [...per.values()].sort((a, b) => b.usd - a.usd);
    const chainUsd = items.reduce((s, r) => s + r.usd, 0);
    // A price we could not read is NOT zero. A chain whose only bag is unpriced
    // must not head its section with "$0.00" — that reads as "you hold nothing
    // here" about a wallet holding 900K of something. Where some bags priced and
    // others did not, the subtotal is real but incomplete, and says so.
    const blind = items.filter((r) => r.unpriced && !(r.usd > 0)).length;
    anyUnpriced = anyUnpriced || blind > 0;
    const chainVal = blind === items.length ? T(chatId, 'tok.no_price')
      : blind ? `${usdX(chainUsd)} ${T(chatId, 'tok.plus_unknown')}` : usdX(chainUsd);
    L.push(`\n${c.emoji} <b>${esc(c.name)}</b> · ${chainVal}`);
    for (const r of items) {
      const val = r.unpriced && !(r.usd > 0) ? T(chatId, 'tok.no_price') : usdX(r.usd);
      const where = list.length > 1 ? ` · <i>${esc(r.holders.join(', '))}</i>` : '';
      // Name it by its CONTRACT when it has no symbol on record — the same
      // rule the live-position card follows. "$?" tells a holder the bot cannot
      // even name what they own.
      const label = r.sym ? `<b>$${esc(r.sym)}</b>` : `<code>${esc(short(r.ca))}</code>`;
      L.push(`${fmt(r.tokens)} ${label} · ${val}${where}`);
      // Reuses the existing token-card callback (tok:<chain>:<walletIdx>:<ca>)
      // rather than a new one — an empty wallet index means "the active wallet",
      // which is what the card already falls back to. Bounded at 12 buttons:
      // Telegram's callback_data is 64 bytes and a wall of them is unreadable;
      // the text list above is complete either way.
      // tok:<chain>:<walletIdx>:<ca> — the card callback that already exists. An
      // empty wallet index is the documented "fall back to the active wallet"
      // path at the parser. Bounded at 12: a wall of buttons is unreadable and
      // the text list above is complete either way.
      if (kbRows.length < 12) {
        // "$PEPE · $0.00" on a button is the same lie the row above refuses to
        // tell, so an unpriced bag shows its amount instead of a price.
        const tag = r.unpriced && !(r.usd > 0) ? fmt(r.tokens) : usdX(r.usd);
        kbRows.push([btn(`${(r.sym ? '$' + r.sym : 'token').slice(0, 14)} · ${tag}`.slice(0, 30), `tok:${r.chain}::${r.ca}`)]);
      }
    }
  }
  if (anyUnpriced) L.push(`\n${T(chatId, 'tok.unpriced_note')}`);
  L.push(`\n${T(chatId, 'tok.note')}`);
  kbRows.push([btn('🔄 Refresh', 'toks'), btn('📊 Portfolio', 'pos')]);
  kbRows.push([btn('💼 Wallets', 'wal'), btn('« Menu', 'menu')]);
  return { text: L.join('\n'), kb: { inline_keyboard: kbRows } };
}
// Maestro-style deposit: a QR of the address + the address text. Works for any wallet
// (not just the active one). Degrades to a plain text address if QR is disabled/fails.
async function depositScreen(chatId, w) {
  const u = core.ensureUser(chatId);
  const ch = core.chainOf(core.userChain(u));
  const idx = core.walletList(u).findIndex((x) => x.id === w.id) + 1;
  const label = core.walletLabel(w, idx);
  const addr = wAddr(w, ch.key);
  const sameNote = core.chains.isSvm(ch.key) ? 'This is your Solana address (different from your EVM one).' : 'Shared across every EVM chain.';
  const caption = `📥 <b>Deposit ${ch.native}</b> · ${esc(label)}\n${ch.emoji} <b>${esc(ch.name)}</b>\n\n<code>${addr}</code>\n\nScan the QR or copy the address. ${sameNote} Switch with 🌐 to deposit elsewhere. Then paste a token contract to buy.`;
  const kb = rows(
    // 📤 here spends THIS wallet on THIS chain. The list's "Withdraw (active)"
    // spends the active one, so emptying any other wallet used to mean
    // switching to it first — a step nothing on either screen mentioned.
    [btn(`📤 Withdraw ${ch.native}`.slice(0, 24), `wdw:${w.id}:${ch.key}`), btn('🔄 Refresh balance', 'wal')],
    [btn('🌐 Chain', 'chain'), btn('👛 Wallets', 'wallets'), btn('« Menu', 'menu')]);
  const url = qrUrl(addr);
  if (url) { const r = await sendPhoto(chatId, url, caption, kb).catch(() => null); if (r && r.ok) return r; }
  return send(chatId, caption, kb);   // QR disabled/failed → text address (still fully usable)
}
// 'Wallets' and 'Wallet' now open the SAME all-wallets dashboard.
async function walletsScreen(chatId) { return walletScreen(chatId); }

/**
 * The remove-wallet confirmation, and the answer to the question the old one
 * kept provoking.
 *
 * "saya ingin delete wallet evm tpi tidak bisa karena ada saldo solana … karena
 * privatekey kan beda2" — the keys ARE different, and the row is still one row.
 * A wallet here is an EVM keypair and a Solana keypair travelling together under
 * one label, so removing "the EVM wallet" removes the Solana one with it, which
 * is why a SOL balance blocks it. The old screen said none of that: it claimed
 * the wallet "must be empty of native on every chain", the guard then named
 * whichever chain it tripped on, and there was no way from either message to do
 * anything about it — withdraw was active-wallet-and-active-chain only.
 *
 * So this screen MEASURES (core.walletFunds, one concurrent sweep shared with
 * the guard, so the two can never disagree), prints both addresses, and puts a
 * withdraw button on every chain that actually holds something. An unreadable
 * chain says so rather than rendering as a zero — it does not block removal, but
 * "we could not look" and "it is empty" stay different facts.
 */
/**
 * "harus ada command withdraw di sini dan bisa withdraw semua wallet tapi
 * dipilih dulu chainnya apa" (2026-08-21).
 *
 * 📤 Withdraw (active) only ever spent the ACTIVE wallet on the ACTIVE chain, so
 * emptying ten wallets meant twenty screen switches. This is the same withdrawal
 * over a SELECTION, and it asks WHICH CHAIN FIRST — the rule the snipe panel had
 * to be rescued into: a flow bound to whatever chain happened to be active is how
 * a Solana address pasted on an EVM screen bounces as "not a valid address" with
 * the fix two screens away.
 *
 * ⚠️ The selection lives in the PENDING STEP, never in `core.tradeSelection`.
 * That one is persisted and drives which wallets every future Buy and Sell act
 * on — a withdraw picker writing to it would silently re-aim the user's trading
 * as a side effect of emptying a wallet.
 */
function wdSweepChainScreen(chatId) {
  const list = core.chains.enabledChains();
  const rows2 = [];
  for (let i = 0; i < list.length; i += 2) {
    rows2.push(list.slice(i, i + 2).map((c) => btn(`${c.emoji} ${c.name} · ${c.native}`.slice(0, 28), `wdac:${c.key}`)));
  }
  rows2.push([btn('✖ Cancel', 'wallets')]);
  return {
    text: `📤 <b>Withdraw</b>\n\n<b>Which chain?</b> A withdrawal moves that chain's native coin, and each chain has its own address — so this is the first question, not the last.\n\n<i>You pick the wallets next — one, several, or all of them.</i>`,
    kb: { inline_keyboard: rows2 },
  };
}

/** The wallet multi-select for a sweep, showing each wallet's balance ON THAT
 *  CHAIN — picking blind is how you sweep nine empty wallets and miss the one
 *  that had the money. An unreadable balance renders `?`, never `0`. */
async function wdSweepPickScreen(chatId, p) {
  const u = core.ensureUser(chatId);
  const ch = core.chainOf(p.chain);
  const list = core.walletList(u);
  const picked = new Set(p.ids || []);
  // ONE column read, bounded: this screen is tapped repeatedly and it is ten
  // wallets on ONE chain — exactly the shape that put five concurrent
  // `getBalance` calls on the public Solana endpoint and got every one of them
  // rate-limited. `readNativeColumn` makes that one request there.
  const col = await readNativeColumn(list, ch);
  const bals = col.bals;
  const kbRows = [];
  let selTotal = 0, unread = 0, selRead = 0;
  list.forEach((w, i) => {
    const b = bals[i];
    if (b == null) unread++;
    const amt = b == null ? '?' : +Number(fmtNat(b, p.chain)).toFixed(4);
    if (b != null && picked.has(w.id)) { selTotal += Number(fmtNat(b, p.chain)); selRead++; }
    kbRows.push([btn(`${picked.has(w.id) ? '✅' : '⬜'} ${core.walletLabel(w, i + 1)} · ${amt} ${ch.native}`.slice(0, 40), `wdat:${i + 1}`)]);
  });
  kbRows.push([btn(picked.size === list.length ? '✅ All selected' : '☑️ Select all', 'wdaA'), btn('⬜ Clear', 'wdaN')]);
  kbRows.push([btn(picked.size ? `➡️ Next (${picked.size} wallet${picked.size > 1 ? 's' : ''})` : '➡️ Next', 'wdaGo'), btn('🌐 Chain', 'wdall')]);
  kbRows.push([btn('✖ Cancel', 'wallets')]);
  let text = `📤 <b>Withdraw</b> · ${ch.emoji} <b>${esc(ch.name)}</b>\n\n<b>Which wallets?</b> Tap to select — they all send to the SAME address.\n\n`;
  // ⚠️ A total of the balances we could NOT read is 0, and printing "holding 0
  // SOL" over a selection whose every balance failed is the same lie the `?`
  // above exists to avoid — one line up from itself.
  text += !picked.size ? `<i>Nothing selected yet.</i>`
    : selRead === 0 ? `Selected: <b>${picked.size}</b> · <i>balances couldn't be read just now</i>`
    : `Selected: <b>${picked.size}</b> · holding <b>${+selTotal.toFixed(5)} ${esc(ch.native)}</b>${selRead < picked.size ? ` <i>(${picked.size - selRead} unread)</i>` : ''}`;
  if (unread) text += `\n\n⚠️ <code>?</code> means the balance couldn't be read just now — that's a node problem, not a zero. Those wallets can still be swept.${col.why ? `\n<i>${esc(col.why)}</i>` : ''}`;
  return { text, kb: { inline_keyboard: kbRows } };
}

/** What a finished sweep looks like. ⚪️ for a wallet that held nothing — it did
 *  exactly the right thing when asked to sweep an empty wallet, and ❌ there
 *  sends people hunting for a fault. */
function wdSweepResultText(chatId, chainKey, to, rows) {
  const ch = core.chainOf(chainKey) || {};
  const sent = rows.filter((r) => r.ok);
  const empty = rows.filter((r) => !r.ok && r.empty);
  const failed = rows.filter((r) => !r.ok && !r.empty);
  const total = sent.reduce((a, r) => a + Number(r.sentEth || 0), 0);
  const L = [`📤 <b>Withdrawal — ${ch.emoji || ''} ${esc(ch.name || chainKey)}</b>`, `to <code>${esc(to)}</code>`, ''];
  for (const r of rows) {
    if (r.ok) L.push(`🟢 <b>${esc(r.label)}</b> — ${r.sentEth} ${esc(r.native)} · ${txLink(chainKey, r.hash)}`);
    else if (r.empty) L.push(`⚪️ <b>${esc(r.label)}</b> — nothing to send`);
    else L.push(`❌ <b>${esc(r.label)}</b> — ${esc(r.error)}`);
  }
  L.push('');
  L.push(`<b>Sent ${+total.toFixed(6)} ${esc(ch.native || '')}</b> from ${sent.length}/${rows.length} wallet${rows.length > 1 ? 's' : ''}`
    + (empty.length ? ` · ${empty.length} empty` : '') + (failed.length ? ` · ${failed.length} failed` : ''));
  return L.join('\n');
}

async function removeWalletScreen(chatId, walletId) {
  const u = core.ensureUser(chatId);
  const w = core.walletById(u, walletId);
  if (!w) return walletsScreen(chatId);
  const i = core.walletList(u).findIndex((x) => x.id === walletId) + 1;
  const label = core.walletLabel(w, i);
  // ⚠️ A SURVEY THAT DID NOT HAPPEN IS NOT AN EMPTY WALLET. The first cut
  // swallowed a thrown walletFunds into `funds = []`, which rendered the
  // "empty on every chain I could read" branch and a one-tap ✅ Remove — a
  // claim about the balances built out of the fact that nothing was read. The
  // same rule as `ok:false` one field over, and easier to get wrong because the
  // empty array reads as a legitimate answer.
  let funds = null;
  try { funds = await core.walletFunds(chatId, walletId); } catch (_) { funds = null; }
  const surveyed = Array.isArray(funds) && funds.length > 0;
  const holding = surveyed ? funds.filter((f) => f.holds) : [];
  const unread = surveyed ? funds.filter((f) => !f.ok) : [];

  const svmChain = core.chains.enabledChains().find((c) => core.chains.isSvm(c.key));
  let body = `🗑 <b>Remove ${esc(label)}?</b>\n\n`
    + `EVM address (all EVM chains):\n<code>${esc(w.address)}</code>\n`;
  if (svmChain) body += `Solana address:\n<code>${esc(core.walletAddress(w, svmChain.key))}</code>\n`;
  body += `\n`;

  if (holding.length) {
    body += `<b>This wallet still holds:</b>\n`
      + holding.map((f) => `• <b>${esc(f.human)} ${esc(f.native)}</b> on ${f.emoji} ${esc(f.name)}`).join('\n')
      + `\n\n`;
    if (svmChain) {
      // The sentence the whole report was about. It is printed whenever the row
      // has two sides, not only when the blocking balance happens to be SOL —
      // a user blocked by an ETH balance is owed the same explanation.
      body += `<i>One wallet here is <b>two keypairs</b> — an EVM key and a Solana key — under one name. They are different private keys, but they are removed together, so anything on either side has to be dealt with first.</i>\n\n`;
    }
    body += `Empty it below, or remove it anyway and I'll hand you its keys first.`;
  } else if (!surveyed) {
    body += `⚠️ I couldn't check any chain's balance just now, so I can't tell you whether this wallet is empty. <b>🔑 Export the keys first</b>, then remove it — or try again in a moment.`;
  } else {
    body += `It looks <b>empty of native</b> on every chain I could read. I can't see ERC20 or SPL bags — <b>🔑 export the keys first</b> if it holds tokens. Any <b>pending orders</b> on this wallet are cancelled.`;
  }
  if (unread.length) body += `\n\n⚠️ Couldn't read ${unread.map((f) => esc(f.name)).join(', ')} just now — that's a node problem, not a zero. Removal isn't blocked by it.`;

  const kb = [];
  for (const f of holding) kb.push([btn(`📤 Withdraw ${f.native} · ${f.name}`.slice(0, 30), `wdw:${walletId}:${f.chain}`)]);
  kb.push([btn('🔑 Export keys', 'expw:' + walletId)]);
  // An unsurveyed wallet keeps the second confirmation rather than the one-tap
  // remove: the guard in core will not block it (an unreadable chain never
  // does), so the screen is the only thing left standing between "we don't know"
  // and a wallet gone with money in it.
  kb.push((holding.length || !surveyed)
    ? [btn(surveyed ? '🗑 Remove anyway' : '🗑 Remove without checking', 'rmwf:' + walletId), btn('✖ Cancel', 'wallets')]
    : [btn('✅ Remove', 'rmwok:' + walletId), btn('✖ Cancel', 'wallets')]);
  return { text: body, kb: { inline_keyboard: kb } };
}
function chainScreen(chatId) {
  const cur = core.userChain(core.ensureUser(chatId));
  const list = core.chains.enabledChains();
  const kb = list.map((c) => [btn(`${c.emoji} ${c.name}${c.key === cur ? '  ✓' : ''}`, 'setch:' + c.key)]);
  kb.push([btn('« Menu', 'menu')]);
  return { text: `🌐 <b>Select chain</b>\n\nYour wallet is the same address on all of them, and pasting a CA <b>auto-detects its chain</b> — this only sets the default for deposits, snipes and quick commands:`, kb: { inline_keyboard: kb } };
}
/**
 * A token that trades on a venue this bot cannot route through.
 *
 * Uniswap v4 is the case this exists for: its pools live inside one PoolManager
 * singleton keyed by a PoolKey hash, so there is no pair or pool contract for
 * the V2/V3 factory lookups to return, and the token was previously answered
 * with "❌ Couldn't price it" — indistinguishable, to the person reading it,
 * from a dead token or a broken bot.
 *
 * So: show the market, name the venue, and say plainly that a swap can't be
 * filled here yet. No Buy button — see the caller.
 */
function unroutableCard(ca, chainKey, info) {
  const ch = core.chainOf(chainKey);
  const L = [`🔎 <b>${esc(info.sym ? '$' + info.sym : 'Token')}</b>${info.name ? ' · ' + esc(info.name) : ''}`, `${ch.emoji} <b>${esc(ch.name)}</b> · <code>${short(ca)}</code>`, ''];
  L.push(`<b>Price:</b> ${usdX(info.priceUsd)}`);
  if (info.mcapUsd > 0) L.push(`<b>MCap:</b> ${usdX(info.mcapUsd)}`);
  if (info.liquidityUsd > 0) L.push(`<b>Liquidity:</b> ${usdX(info.liquidityUsd)}`);
  if (info.volH24Usd > 0) L.push(`<b>24h volume:</b> ${usdX(info.volH24Usd)}`);
  L.push('', `⚠️ This token's liquidity is on <b>${esc(info.extVenue)}</b>, which Dexvra can't route through yet — so there's nothing to quote and no swap to sign. Price above is live from the indexer.`);
  /*
   * ⚠️ THE REASON, ON THE CARD — because pm2 was not answerable.
   *
   * The card path logs why it refused, and the operator's `grep '[curve]'`
   * came back EMPTY on a box rendering this exact card: the tradebot's snipe
   * loop writes several lines a second, so the one line that mattered had
   * scrolled past `--lines 200` before it could be read. A diagnostic that
   * exists and cannot be retrieved is the "value nobody can read is the same
   * as no value" rule, and it cost four rounds of this report.
   *
   * One short line, only when the engine actually recorded a reason — never a
   * blank row on a card for a token that simply has no route.
   */
  if (info.curveWhy) L.push(`<i>Stage that refused: ${esc(String(info.curveWhy).slice(0, 160))}</i>`);
  return {
    text: L.join('\n'),
    kb: rows(
      [{ text: '📈 Chart', url: chartUrl(chainKey, ca) }, { text: '🔎 Explorer', url: expTokenUrl(chainKey, ca) }],
      [btn('🌐 Switch chain', 'chain'), btn('« Menu', 'menu')],
    ),
  };
}

// `opts.multi` opens the wallet toggles INLINE on the card (Maestro's 🟢 Multi
// panel) instead of pushing the user to a separate screen — the price, liquidity
// and per-wallet bags stay on screen while you choose which wallets to trade.
async function tokenCard(chatId, ca, chainKey, walletId, opts) {
  const u = core.ensureUser(chatId);
  const multiOpen = !!(opts && opts.multi);
  chainKey = (chainKey && core.chainOf(chainKey)) ? chainKey : core.userChain(u);
  const ch = core.chainOf(chainKey);
  const list = core.walletList(u);
  const explicit = (walletId && core.walletById(u, walletId)) || null;
  // Rich scan: on-chain price/mcap + liquidity + launchpad API (vol/socials) + GoPlus
  // (tax/honeypot/holders/LP) — all best-effort, never throws (tokeninfo swallows).
  // Started WITH the scan, not after it. `tokenMeta` is an RPC read plus a
  // registry fetch and it does not depend on anything `enrich` produces, so
  // awaiting it afterwards simply added its latency to the card. On the one
  // screen a user stares at after pasting an address, two independent waits in
  // series is the difference between "fast" and "did it hear me".
  // Redraw from the last full render when the caller says nothing it depends on
  // can have changed (a wallet toggle) — see _cardReuse.
  const rKey = chatId + ':' + chainKey + ':' + String(ca).toLowerCase();
  const rHit = (opts && opts.reuse && CARD_REUSE_MS > 0) ? _cardReuse.get(rKey) : null;
  const reuse = (rHit && Date.now() - rHit.at < CARD_REUSE_MS) ? rHit : null;
  const metaP = reuse ? Promise.resolve(reuse.meta) : core.tokenMeta(ca, chainKey).catch(() => null);
  /*
   * ⚠️ THE BALANCES START NOW, NOT AFTER `enrich`.
   *
   * They need one thing — the token's decimals — and `tokenMeta` above is
   * already fetching it. Awaiting them AFTER the scan put a SECOND full wave
   * of RPC (a totalSupply plus two balance reads per wallet, five wallets
   * here) in series behind a wave that takes seconds, on the one screen a user
   * stares at after pasting an address. Same lesson the header already states
   * about `tokenMeta` itself, one wave further down; the two do not know about
   * each other, and the only reason they were serial is the order they were
   * written in.
   *
   * `.catch` at CREATION, not at the await: every early return below (no
   * price, an unroutable card) leaves this promise in flight, and an
   * unhandled rejection would take the process down for a balance read.
   */
  const acrossP = reuse
    ? Promise.resolve(reuse.across)
    : metaP.then((m) => core.tokenAcrossWallets(chatId, ca, chainKey, (m || {}).decimals)).catch(() => null);
  const tCard = Date.now();
  const info = reuse ? reuse.info : await tokeninfo.enrich(ca, chainKey).catch(() => null);
  const tEnrich = Date.now();
  if (!info) {
    // "Switch chain" was the ONLY thing this card ever said, and on a curve chain it is
    // usually the wrong advice: the token is right here, but the launchpad factory could
    // not be consulted, so the bot fell through to DEX routing and found no pool. Naming
    // the leg that actually failed turns an unexplained dead end into something the
    // operator can act on — and stops sending users to a chain picker for no reason.
    const diag = core.launchpadDiag ? core.launchpadDiag(chainKey) : null;
    const stale = diag && Date.now() - diag.at < 120000;
    // "It trades on another chain" was a GUESS, printed whether or not it was
    // true, with a chain picker attached and no hint of which entry to pick. Ask
    // the indexers where the market actually is — and if it is on a chain we
    // support, take the user straight there instead of describing the problem.
    const probe = await core.marketProbe(ca, chainKey).catch(() => ({ chains: [], checked: [], source: 'none', degraded: true }));
    const elsewhere = probe.chains.filter((k) => k !== chainKey);
    if (elsewhere.length) {
      const list = elsewhere.map((k) => core.chainOf(k)).filter(Boolean);
      return {
        text: `🔎 <code>${short(ca)}</code> has no market on ${ch.emoji} ${esc(ch.name)} — it trades on <b>${list.map((c) => esc(c.name)).join(', ')}</b>.`,
        kb: rows(...list.slice(0, 3).map((c) => [btn(`${c.emoji} Open on ${c.name}`, `tok:${c.key}::${ca}`)]), [btn('« Menu', 'menu')]),
      };
    }
    const why = stale
      ? `\n\n⚠️ The <b>launchpad factory</b> (<code>${short(diag.factory)}</code>) isn't answering on this chain — so this token can't be recognised as a bonding-curve launch and was looked up on the DEX instead, where it has no pool yet.\n\n<i>Operator: run <code>node scripts/robinhood-preflight.js --token ${esc(ca)}</code> — the factory address is likely wrong for this launchpad.</i>`
      // Name what was consulted. A token on a chain whose RPC is being throttled
      // used to look exactly like one that does not exist, and neither the user
      // nor the operator could tell the two apart from this message.
      // A rate-limited index and a token with no market used to produce the same
      // sentence. They are a guess and a fact, and this card must not state the
      // guess as the fact — the same token priced fine twenty minutes earlier.
      : probe.degraded
        ? `\n\nNo pool on ${esc(ch.name)}, and <b>the price indexes didn't answer</b> just now (rate-limited or down), so whether it trades elsewhere is unknown. Try again in a minute.`
        : `\n\nNo pool on ${esc(ch.name)}, and no market on ${probe.checked.length ? probe.checked.map((k) => esc((core.chainOf(k) || {}).name || k)).join(', ') : 'any chain'} at either index (DexScreener, GeckoTerminal).\n\nUsually that means it is brand new, still on a launchpad bonding curve, or trading somewhere neither index covers.`
        // A v4 pool is invisible to V2/V3 AND to both indexes on a chain they
        // don't cover — which is every way of looking this bot has, unless the
        // PoolManager is configured. Name the one thing that would fix it.
        + (core.v4.enabled(chainKey) ? '' : `\n\n<i>Operator: Uniswap v4 is not configured on ${esc(ch.name)}. A v4 pool has no pair contract, so nothing here can see one. Run <code>node scripts/v4-discover.js ${esc(ca)} ${esc(chainKey)}</code>.</i>`);
    return {
      text: `❌ Couldn't price <code>${short(ca)}</code> on ${ch.emoji} ${esc(ch.name)}.${why}`,
      kb: rows([{ text: '📈 Chart', url: chartUrl(chainKey, ca) }], [btn('🌐 Switch chain', 'chain'), btn('« Menu', 'menu')]),
    };
  }
  // Priced by the indexer, not by the router — Uniswap v4 and anything else the
  // engine has no path to. Its own card: the market is real and worth showing,
  // but every Buy/Sell button on the normal card would build a swap that cannot
  // be filled, and a trade screen that quotes a price it can't honour is worse
  // than one that says so.
  if (info.routable === false) return unroutableCard(ca, chainKey, info);
  const meta = (await metaP) || await core.tokenMeta(ca, chainKey);
  // Maestro-style: this token's balance across EVERY wallet (live on-chain). Bind the
  // card to the wallet that actually HOLDS the token so Buy/Sell act on the right one —
  // this is what fixes "Sell failed: token balance is 0" when the bag sits on another
  // wallet than the active one. Explicitly-opened cards keep their wallet.
  // Started before `enrich` (see acrossP) — this is where it is collected, and
  // on a warm RPC it is usually already resolved. A read that failed falls back
  // to the ordinary path rather than rendering an empty wallet list.
  const across = (await acrossP) || await core.tokenAcrossWallets(chatId, ca, chainKey, meta.decimals);
  /*
   * WHERE THE TIME WENT, on the screen the whole product is judged by.
   *
   * "respon sangat lambat" is measured, not argued — the rule `[ui] slow cb:`
   * already states one level up. That line reports the WHOLE handler; this one
   * splits the card itself, because "the paste is slow" and "the wallet reads
   * are slow" send an operator to different places (a scan timeout versus the
   * RPC). Only printed past a threshold: a fast card must not write a line per
   * paste into a log the snipe loop is already filling.
   */
  const tAll = Date.now() - tCard;
  if (tAll >= CARD_SLOW_MS) {
    console.log(`[ui] card ${String(ca).slice(0, 10)}… ${chainKey} total=${tAll}ms enrich=${tEnrich - tCard}ms rest=${Date.now() - tEnrich}ms wallets=${(across && across.rows ? across.rows.length : 0)}${reuse ? ' (reused)' : ''}`);
  }
  // Only a LIVE render seeds the cache, so reuse can never chain off reuse and
  // hold a price past its window.
  if (!reuse && CARD_REUSE_MS > 0) {
    _cardReuse.set(rKey, { at: Date.now(), info, meta, across });
    if (_cardReuse.size > 500) { const f = _cardReuse.keys().next().value; _cardReuse.delete(f); }
  }
  const w = explicit || (across.holderId && core.walletById(u, across.holderId)) || core.activeWallet(u);
  const wi = list.findIndex((x) => x.id === w.id) + 1;   // 1-based wallet index, encoded in every action
  const myRow = across.rows.find((r) => r.id === w.id);
  const autoSwitched = !explicit && !!myRow && !myRow.active && (myRow.tokens > 1e-9);
  const balRaw = myRow ? myRow.raw : await core.tokenBalance(ca, wAddr(w, chainKey), chainKey);
  const bal = myRow ? myRow.tokens : Number(ethers.formatUnits(balRaw, meta.decimals));
  const pos = (w.positions || {})[core.posKey(chainKey, ca)];
  const nat = ch.native;
  const api = info.api, sec = info.security;
  const px = info.priceEth || 0;
  const priceUsd = px * nativeUsd(nat);
  const name = (api && api.name) || meta.name;
  const sym = (api && api.symbol) || meta.sym;

  const L = [];
  // A blank line between blocks, not a drawn rule. Rules add a line of noise per
  // section; whitespace does the same grouping and lets the eye land on the
  // numbers. Nothing in the card may run more than four lines without a break.
  const gap = () => { if (L.length && L[L.length - 1] !== '') L.push(''); };
  // ── Header: name · symbol, then chain · venue · age, then the contract ──
  // Age sits here rather than buried in a stats line: "6 minutes old" changes how
  // you read every number under it, so it belongs beside the name.
  const mkt = info.market;
  const created = (api && api.createdAt) || (mkt && mkt.createdAt);
  const statusBadge = info.dex ? `◆ DEX${info.dexVenue === 'v3' ? ' · V3 pool' : ''}` : (info.graduated ? '◆ Graduated' : `◈ Bonding curve · ${(info.progressPct || 0).toFixed(0)}%`);
  // WHERE THE TOKEN CAME FROM. Only a launchpad knows this, and it is the first
  // thing anyone wants after the ticker: a pump.fun graduate and a token that
  // appeared straight on Raydium are different propositions at the same market
  // cap. Shown for a graduated token too — "◆ DEX · 🚀 pump.fun" says both that
  // it trades on a pool now and that it came off a curve to get there.
  const padName = (info.launchpad) || (api && api.launchpad) || '';
  const padBadge = padName ? `  ·  🚀 ${esc(String(padName).slice(0, 24))}` : '';
  L.push(`<b>${esc(name)}</b> · <b>$${esc(sym)}</b>`);
  L.push(`${ch.emoji} ${esc(ch.name)}  ·  ${statusBadge}${padBadge}${created ? `  ·  ${fmtAge(created)} old` : ''}`);
  L.push(`<code>${ca}</code>`);
  // SILENCE IS NOT A CLEAN BILL OF HEALTH.
  //
  // This printed a line only for `danger` and `warn`, so a token that PASSED the
  // check and a token whose check FAILED — a GoPlus/RugCheck timeout, an
  // unindexed mint, a rate limit; `tokeninfo.js` catches all of them to null —
  // rendered identically: nothing at all. A user who has learned that this bot
  // warns about honeypots reads that absence as "checked, fine" and taps Buy.
  // The one place the difference matters most is the one screen that never
  // stated it. All four states now say which one they are, in one line.
  if (sec) {
    const v = safety.verdict(chainKey, sec);
    if (v.level === 'danger') L.push(`🚨 <b>HIGH RISK</b> — ${esc(v.red.join(', '))}`);
    else if (v.level === 'warn') L.push(`⚠️ <b>Caution</b> — ${esc(v.warn.join(', '))}`);
    else L.push(T(chatId, 'sec.clean'));
  } else if (safety.supported(chainKey)) {
    L.push(T(chatId, 'sec.unchecked'));
  } else {
    L.push(T(chatId, 'sec.unsupported', { chain: esc(ch.name) }));
  }
  // ── Market ─────────────────────────────────────────────────────────────────
  // Every value is labelled and every line leads with what it is. The old card
  // printed bare fragments — "LP burned" alone on a line, "Liq 0.02 ETH" with
  // nothing to compare it against — and silently DROPPED whole lines when a
  // source returned nothing, so a chain with no indexer rendered three lines and
  // read like a broken card rather than a thin token.
  gap();
  const mcapUsd = (api && api.marketCapUsd) || (info.mcapEth * nativeUsd(nat));
  const priceStr = priceUsd > 0 ? '$' + priceUsd.toPrecision(3) : px.toExponential(2) + ' ' + nat;
  const mcapStr = mcapUsd > 0 ? '$' + fmt(mcapUsd) : usd(info.mcapEth, nat);
  L.push(`💵 <b>Price</b> ${priceStr}   ·   🌍 <b>Mcap</b> ${mcapStr}`);
  // Liquidity carries the number that actually answers "can I get out again":
  // how it compares to the market cap. $36 of liquidity under a $2.59K cap is the
  // whole story of a token, and the card used to leave the reader to divide it.
  if (info.liquidityNative != null) {
    const liqUsd = info.liquidityNative * nativeUsd(nat);
    const pctOfCap = mcapUsd > 0 && liqUsd > 0 ? (liqUsd / mcapUsd) * 100 : 0;
    const share = pctOfCap > 0 ? `   ·   <b>${pctOfCap < 0.1 ? '<0.1' : pctOfCap.toFixed(1)}%</b> of mcap` : '';
    // Decimals that match the magnitude: 0.020 ETH and 210.4 ETH both want to be
    // read at a glance, and one fixed precision cannot do both.
    const q = info.liquidityNative;
    const qStr = q < 1 ? q.toFixed(3) : q < 100 ? q.toFixed(2) : q.toFixed(1);
    L.push(`💧 <b>Liquidity</b> ${qStr} ${nat} (${usd(info.liquidityNative, nat)})${share}`);
  } else if (info.raised != null) {
    const pct = info.target > 0 ? (info.raised / info.target) * 100 : 0;
    L.push(`🚀 <b>Raised</b> ${info.raised.toFixed(2)} / ${(info.target || 0).toFixed(1)} ${nat}   ·   <b>${pct.toFixed(0)}%</b> to graduation`);
  }
  // Thin-pool warning: indexer sees far deeper liquidity than the pool the bot can trade.
  if (info.liquidityNative != null && mkt && mkt.liqUsd > 0) {
    const poolUsd = info.liquidityNative * nativeUsd(nat);
    // Its own block: a warning buried between two stat lines is read as a stat.
    if (mkt.liqUsd > Math.max(poolUsd, 1) * 5) { gap(); L.push(`⚠️ <b>Thin tradeable pool</b> — the market's <b>$${fmt(mkt.liqUsd)}</b> sits on a pool this bot can't reach. Buys here move the price hard.`); gap(); }
  }
  if (mkt) {
    const chg = (v) => (v == null ? null : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`);
    const c1 = chg(mkt.chgH1), c24 = chg(mkt.chgH24);
    // An arrow makes the direction readable before the number is: a wall of
    // percentages is what people skim past.
    const arrow = (v) => (v == null ? '' : (v >= 0 ? '🟢 ' : '🔴 '));
    const parts = [];
    if (c1 != null) parts.push(`1h ${arrow(mkt.chgH1)}${c1}`);
    if (c24 != null) parts.push(`24h ${arrow(mkt.chgH24)}${c24}`);
    if (parts.length) L.push(`📈 <b>Change</b> ${parts.join('   ·   ')}`);
  }
  const vol24 = (api && api.volume && api.volume.h24Usd != null) ? api.volume.h24Usd : (mkt && mkt.volH24Usd != null ? mkt.volH24Usd : null);
  const volParts = [];
  if (vol24 != null) volParts.push(`$${fmt(vol24)}`);
  if (mkt && (mkt.buysH24 != null || mkt.sellsH24 != null)) volParts.push(`${mkt.buysH24 || 0} buys / ${mkt.sellsH24 || 0} sells`);
  if (volParts.length) L.push(`🔄 <b>Vol 24h</b> ${volParts.join('   ·   ')}`);
  // Safety, in its own block: holders and LP on one line, tax and flags on the
  // next. Three long labels joined on a single line wrap on a phone, and a
  // wrapped line reads as two lines that lost their bullet.
  const holdLp = [];
  if (sec && sec.holders != null) holdLp.push(`👥 ${sec.holders} holders`);
  if (sec && sec.lpLockedPct != null) holdLp.push(`🔒 LP ${Math.round(sec.lpLockedPct)}% locked`);
  else if (ch.curve && info.graduated) holdLp.push('🔒 LP burned');
  const flags = [];
  if (sec) flags.push(`⚖️ Tax ${taxStr(sec.buyTaxPct)} buy / ${taxStr(sec.sellTaxPct)} sell`);
  else if (ch.curve) flags.push('⚖️ Fair launch · 0% tax');   // launchpad tokens can't set a tax
  if (sec && sec.honeypot) flags.push('🚨 HONEYPOT');
  if (sec && sec.openSource === false) flags.push('⚠️ closed-source');
  if (holdLp.length || flags.length) gap();
  if (holdLp.length) L.push(holdLp.join('   ·   '));
  if (flags.length) L.push(flags.join('   ·   '));
  // What a trade costs, which the card could never answer. On a cheap L2 "about
  // four cents" is often what decides whether a small buy is worth making.
  if (info.gas && info.gas.gwei > 0) {
    const feeUsd = info.gas.feeNative * nativeUsd(nat);
    const feeStr = feeUsd > 0 ? ` · ≈<b>$${feeUsd < 0.01 ? feeUsd.toFixed(4) : feeUsd.toFixed(2)}</b> per trade` : '';
    L.push(`⛽ <b>Gas</b> ${info.gas.gwei < 1 ? info.gas.gwei.toFixed(3) : info.gas.gwei.toFixed(1)} gwei${feeStr}`);
  }
  // Say what is missing instead of just omitting the lines. A card that shrinks
  // to three lines on a chain with no indexer looks broken; saying so once tells
  // the reader the numbers above are still real, and read straight from chain.
  gap();
  const gaps = [];
  // WHAT WAS RENDERED, not what one source returned.
  //
  // This keyed 'volume' off `mkt` alone — and `info.market` is only ever filled
  // on the EVM path, so on Solana it is always absent. The card printed
  // "🔄 Vol 24h $855.56K" from `api.volume` and then, four lines later, said
  // volume was unavailable. One card, two code paths, contradicting each other
  // about a number visible in both — the same defect as the buy card's two
  // ideas of "whale".
  if (vol24 == null) gaps.push('volume');
  if (!mkt) gaps.push('price change');
  if (!sec) { gaps.push('holder count'); if (!ch.curve) gaps.push('tax'); }
  if (gaps.length) {
    const listed = gaps.length > 1 ? `${gaps.slice(0, -1).join(', ')} and ${gaps[gaps.length - 1]}` : gaps[0];
    // "No indexer covers this chain" and "this token is missing a field" are
    // different facts, and the first one is false the moment ANY indexed number
    // reached the card. Claiming a chain is uncovered while showing its live
    // volume tells the reader the numbers above cannot be trusted, which is the
    // opposite of what this line exists to say.
    const indexed = !!mkt || vol24 != null;
    L.push(indexed
      ? `ℹ️ <i>Not available for this token: ${listed}.</i>`
      : `ℹ️ <i>No indexer covers ${esc(ch.name)} yet — ${listed} unavailable. The prices above are read straight from the chain.</i>`);
  }
  // Maestro's own card shows a timestamp because its numbers can be minutes old.
  // Ours are fetched on render — saying so is what makes a stale-looking price
  // trustworthy, and points at the button that refetches it.
  L.push(`🕐 <i>Updated ${new Date().toISOString().slice(11, 19)} UTC · tap 🔄 Refresh for a new read</i>`);
  if (api && api.links) { const lk = []; if (api.links.website) lk.push(`<a href="${esc(api.links.website)}">Web</a>`); if (api.links.twitter) lk.push(`<a href="${esc(api.links.twitter)}">X</a>`); if (api.links.telegram) lk.push(`<a href="${esc(api.links.telegram)}">TG</a>`); if (lk.length) L.push(`🔗 ${lk.join(' · ')}`); }
  const valueEth = bal * px;
  const sel = core.tradeSelection(chatId);
  const selIds = new Set(core.tradeWalletIds(chatId));
  const selN = selIds.size;
  const usdOf = (tokens) => (priceUsd > 0 ? '$' + fmt(tokens * priceUsd) : '—');   // USD worth of a token bag
  if (list.length > 1) {
    // Per-wallet balance table (Maestro "Balance" panel): ✅ marks the wallet(s) a
    // Buy/Sell will act on (single, a selected subset, or ALL). Shows each bag's USD worth.
    gap();
    L.push(`👛 <b>Balance across wallets</b> (${esc(sym)} · USD · ${nat})`);
    const held = across.rows.filter((r) => r.tokens > 1e-9 || r.eth > 1e-5);
    const show = (held.length ? held : across.rows).slice(0, 10);
    for (const r of show) {
      const on = selN ? selIds.has(r.id) : (r.id === w.id);
      const mark = on ? '✅' : (r.active ? '▫️' : '▪️');
      const pctStr = r.pctSupply >= 0.01 ? ` (${r.pctSupply.toFixed(2)}%)` : '';
      L.push(`${mark} ${esc(r.label)} · <b>${fmt(r.tokens)}</b>${pctStr} · <b>${usdOf(r.tokens)}</b> · ${r.eth.toFixed(4)} ${nat}`);
    }
    const totTok = across.rows.reduce((s, r) => s + r.tokens, 0);
    const totEth = across.rows.reduce((s, r) => s + r.eth, 0);
    if (totTok > 1e-9) L.push(`Σ <b>${fmt(totTok)} $${esc(sym)}</b> ≈ <b>${usdOf(totTok)}</b> · ${totEth.toFixed(4)} ${nat} across ${across.rows.length} wallets`);
    if (pos && posCost(pos) > 0 && !selN) { const cb = posCost(pos); const unreal = valueEth - cb; const pct = cb > 0 ? (unreal / cb) * 100 : 0; L.push(`PnL (${esc(core.walletLabel(w, wi))}): <b>${unreal >= 0 ? '+' : ''}${unreal.toFixed(4)} ${nat}</b> · ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`); }
    gap();
    if (sel.all) L.push(`<i>Trading all ${list.length} wallets — every Buy runs on each one.</i>`);
    else if (selN >= 1) L.push(`<i>Trading ${selN} selected wallet${selN > 1 ? 's' : ''} — every Buy runs on each one.</i>`);
    else L.push(`<i>Trading ${esc(core.walletLabel(w, wi))}${autoSwitched ? ' (holds this token)' : ''} — tap 🔴 Multi to use several at once.</i>`);
  } else {
    // Single wallet: ALWAYS show the bag (even "none") and the wallet's native
    // balance, so the card answers "what do I hold and what can I spend" at a glance.
    gap();
    if (pos && posCost(pos) > 0) { const cb = posCost(pos); const unreal = valueEth - cb; const pct = cb > 0 ? (unreal / cb) * 100 : 0; L.push(`Your bag: <b>${fmt(bal)} $${esc(sym)}</b> · ${usd(valueEth, nat)} · PnL <b>${unreal >= 0 ? '+' : ''}${unreal.toFixed(4)} ${nat}</b> (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`); }
    else if (bal > 0) L.push(`Your bag: <b>${fmt(bal)} $${esc(sym)}</b> · ${usd(valueEth, nat)}`);
    else L.push(`Your bag: <i>none yet</i>`);
    if (myRow && myRow.eth != null) L.push(`Wallet ${esc(core.walletLabel(w, wi))}: <b>${myRow.eth.toFixed(4)} ${nat}</b> available (${usd(myRow.eth, nat)})`);
  }
  const text = L.join('\n');
  // Encode the card's chain AND wallet index in every action, so a tap on a stale
  // card trades on the chain+wallet it was rendered for — never on whatever chain
  // or wallet merely happens to be active now.
  const bp = core.buyPresets(u, chainKey);   // per-chain (or global) quick-buy amounts (Settings)
  // NOTE: the buy callback below `b:${chainKey}:${wi}:${ca}:${amt}` must stay ≤64 bytes
  // (Telegram limit). Worst case ≈ 64 with chain "robinhood", wi≤99, 42-char ca, and a
  // 6-char preset (capped in setBuyPresets). Keep those caps if you touch this.
  const lastRow = [btn('🔔 Alert', `alt:${chainKey}:${wi}:${ca}`), btn('🔄 Refresh', `tok:${chainKey}:${wi}:${ca}`), btn('« Menu', 'menu')];   // 🔁 DCA moved onto the Buy side
  if (safety.supported(chainKey)) lastRow.unshift(btn('🛡 Safety', `sec:${chainKey}:${ca}`));   // GoPlus (EVM) / RugCheck (Solana)
  // Multi-wallet: one row when closed, the toggle grid below it when open.
  // NOTE the 64-byte callback limit again — worst case here is
  // `wtc:robinhood:99:<42-char ca>:10` = 62 bytes. Adding a field overflows it.
  const selLabel = sel.all ? `👛 Trading: ALL ${list.length} wallets` : (selN >= 1 ? `👛 Trading: ${selN} wallet${selN > 1 ? 's' : ''}` : `👛 Trade from: ${core.walletLabel(w, wi)}`);
  const walletRow = [];
  if (list.length > 1) {
    const multiLabel = selN > 1 ? `🟢 Multi | ${sel.all ? 'ALL' : selN}` : '🔴 Multi';
    walletRow.push([btn(selLabel, `wsel:${chainKey}:${ca}`), btn(multiLabel, `${multiOpen ? 'wex0' : 'wex1'}:${chainKey}:${wi}:${ca}`)]);
    if (multiOpen) {
      // Two per row: the dot is what a wallet DOES on the next Buy/Sell, so in
      // single mode the card's own wallet is already lit — it is the one trading.
      for (let i = 0; i < list.length; i += 2) {
        walletRow.push(list.slice(i, i + 2).map((wobj, j) => {
          const n = i + j + 1;
          const on = selN ? selIds.has(wobj.id) : wobj.id === w.id;
          return btn(`${on ? '🟢' : '🔴'} ${core.walletLabel(wobj, n)}`, `wtc:${chainKey}:${wi}:${ca}:${n}`);
        }));
      }
      walletRow.push([btn('🟢 All ON', `wtcA:${chainKey}:${wi}:${ca}`), btn('🔴 All OFF', `wtcN:${chainKey}:${wi}:${ca}`)]);
    }
  }
  // ONE SIDE AT A TIME.
  //
  // This card carried twenty-two buttons across eight rows: three Buy rows and
  // four Sell rows interleaved, plus wallets, plus links. Someone arriving to do
  // one thing had to find it in a wall — and a Buy sitting one row above a Sell
  // 100% is not only confusing, it is a misfire waiting to happen.
  //
  // The side is chosen explicitly and remembered per token, defaulting to what
  // the user is most likely here for: SELL when they already hold a bag, BUY
  // when they do not.
  const side = cardSide(chatId, ca, opts && opts.side, bal > 1e-9);
  const buying = side === 'buy';
  // ONE button, and it names where you are GOING — not two tabs naming where you
  // are. Which side you are on is already obvious from the buttons underneath;
  // a lit tab spends a slot restating it, and two buttons where one will do is
  // how a card gets to twenty-two.
  const ikb = [
    [btn(buying ? '↔️ Go to Sell' : '↔️ Go to Buy', `tok:${chainKey}:${wi}:${ca}:${buying ? 's' : 'b'}`)],
    ...walletRow,
  ];
  if (buying) {
    // The preset count is no longer fixed at three, so the row is BUILT rather
    // than written out — indexing the first three by hand is what made three a
    // structural fact of the card as much as of the validators. Chunked four to
    // a row because tokenCard.test.js caps a row at 4 buttons; the custom-amount
    // button rides at the end of the last row when there is space and gets its
    // own row when there is not, so it is never the button that drops.
    //
    // ✏️ names it: "Buy X" reads as a preset called X — the one button that
    // answers "I want a different size" was the one nobody could identify.
    const buyBtns = bp.map((a) => btn(`Buy ${a}`, `b:${chainKey}:${wi}:${ca}:${a}`));
    buyBtns.push(btn('✏️ Buy custom', `bx:${chainKey}:${wi}:${ca}`));
    for (let i = 0; i < buyBtns.length; i += 4) ikb.push(buyBtns.slice(i, i + 4));
    ikb.push([btn('⏳ Limit buy', `lb:${chainKey}:${wi}:${ca}`), btn('🔁 DCA', `dca:${chainKey}:${wi}:${ca}`)]);
  } else {
    ikb.push([btn('Sell 25%', `s:${chainKey}:${wi}:${ca}:25`), btn('Sell 50%', `s:${chainKey}:${wi}:${ca}:50`), btn('Sell 75%', `s:${chainKey}:${wi}:${ca}:75`), btn('Sell 100%', `s:${chainKey}:${wi}:${ca}:100`)]);
    // "TP" and "SL" are what a trading desk calls these. Someone looking for the
    // feature they read about as a stop-loss does not scan a cramped row and
    // recognise "🛑 SL" as it.
    ikb.push([btn('🎯 Limit sell', `tp:${chainKey}:${wi}:${ca}`), btn('🛑 Stop-loss', `sl:${chainKey}:${wi}:${ca}`), btn('📉 Trailing', `trl:${chainKey}:${wi}:${ca}`)]);
    const other = [btn('🔻 Sell other %', `sx:${chainKey}:${wi}:${ca}`)];
    // Offer "send this token out" only when the bound wallet actually holds a bag.
    if (bal > 1e-9) other.push(btn(`📤 Send $${esc(sym)}`, `wt:${chainKey}:${wi}:${ca}`));
    ikb.push(other);
  }
  ikb.push([{ text: '📈 Chart', url: chartUrl(chainKey, ca) }, btn('📍 Monitor', `monn:${chainKey}:${wi}:${ca}`), btn('📊 PnL', `pnlt:${chainKey}:${ca}`)]);
  ikb.push([{ text: '🔎 Explorer', url: expTokenUrl(chainKey, ca) }]);
  ikb.push(lastRow);
  return { text, kb: { inline_keyboard: ikb } };
}
// Multi-wallet trade picker (Maestro style): choose one / several / ALL wallets that
// every Buy / Sell tap acts on. Shows each wallet's live balance of THIS token so the
// choice is informed. Opened from the 👛 row on a token card.
async function walletPickScreen(chatId, ca, chainKey) {
  const u = core.ensureUser(chatId);
  chainKey = (chainKey && core.chainOf(chainKey)) ? chainKey : core.userChain(u);
  const ch = core.chainOf(chainKey);
  const list = core.walletList(u);
  const across = await core.tokenAcrossWallets(chatId, ca, chainKey, 18).catch(() => ({ rows: [] }));
  const sel = core.tradeSelection(chatId);
  const selIds = new Set(core.tradeWalletIds(chatId));
  const kbRows = [];
  list.forEach((wobj, i) => {
    const r = (across.rows || []).find((x) => x.id === wobj.id) || { tokens: 0, eth: 0 };
    const on = selIds.size ? selIds.has(wobj.id) : false;   // default (none selected) = single card wallet
    kbRows.push([btn(`${on ? '✅' : '⬜'} ${core.walletLabel(wobj, i + 1)} · ${fmt(r.tokens)} · ${(r.eth || 0).toFixed(3)} ${ch.native}`, `wtg:${chainKey}:${i + 1}:${ca}`)]);
  });
  kbRows.push([btn(sel.all ? '✅ ALL wallets ON' : '☑️ Select ALL', `wtgA:${chainKey}:${ca}`), btn('⬜ Clear', `wtgN:${chainKey}:${ca}`)]);
  kbRows.push([btn('✔ Done', `tok:${chainKey}::${ca}`)]);   // empty wi → card auto-binds to the holder
  const mode = sel.all ? `ALL ${list.length} wallets` : (selIds.size ? `${selIds.size} wallet${selIds.size > 1 ? 's' : ''}` : 'single (the card wallet)');
  return {
    text: `👛 <b>Trade wallets</b> · ${ch.emoji} ${esc(ch.name)}\n\nPick which wallets every <b>Buy / Sell</b> acts on. Now: <b>${mode}</b>.\n\n<i>Buy spends the amount on EACH selected wallet (total = amount × wallets). Sell sells that % of each wallet's own bag; wallets with no bag are skipped.</i>`,
    kb: { inline_keyboard: kbRows },
  };
}
/** The 📍 Monitor picker. /monitor used to be nothing at all — not a registered
 *  command and not a handler — so typing it fell through to "I didn't recognise
 *  that". The live tracker existed but was reachable only from a button on a
 *  token card, which is exactly where someone who already bought is NOT looking.
 *  This lists what you actually hold and opens a tracker on any of it. */
async function monitorListScreen(chatId) {
  const pf = await core.portfolioAll(chatId);
  const nat = pf.native || 'ETH';
  const open = pf.rows.filter((r) => r.open);
  const wi = walletIndex(chatId);
  if (!open.length) {
    return { text: `📍 <b>Live monitor</b> · ${pf.chain ? pf.chain.emoji + ' ' + esc(pf.chain.name) : ''}\n\nYou hold nothing on this chain right now, so there is nothing to track. Buy a token and the monitor opens itself.`,
      kb: rows([btn('📊 Portfolio', 'pos'), btn('🌐 Chain', 'chain'), btn('« Menu', 'menu')]) };
  }
  const rate = nativeUsd(nat);
  const L = [`📍 <b>Live monitor</b> · ${pf.chain.emoji} ${esc(pf.chain.name)}\n`,
    'Pick a position to track. The card pins itself and refreshes on its own, across every wallet holding it.\n'];
  const kb = [];
  for (const r of open.slice(0, MON_LIST_ROWS)) {
    const usdStr = rate > 0 ? ` ($${(r.valueEth * rate).toFixed(2)})` : '';
    const n = (r.holders || []).length;
    L.push(`<b>$${esc(r.sym)}</b> · ${r.valueEth.toFixed(4)} ${nat}${usdStr}${n > 1 ? ` · ${n} wallets` : ''}`);
    kb.push([btn(`📍 ${r.sym}`, `monn:${pf.chain.key}:${wi}:${r.ca}`)]);
  }
  if (open.length > MON_LIST_ROWS) L.push(`<i>…and ${open.length - MON_LIST_ROWS} more — see 📊 Portfolio</i>`);
  kb.push([btn('📊 Portfolio', 'pos'), btn('« Menu', 'menu')]);
  return { text: L.join('\n'), kb: { inline_keyboard: kb } };
}

async function portfolioScreen(chatId) {
  const pf = await core.portfolioAll(chatId);   // aggregated across ALL wallets (Maestro style)
  const nat = pf.native || 'ETH';
  const rate = nativeUsd(nat);
  // Every native figure gets its USD twin. "PnL -0.0001" is not a number anyone
  // can act on; "-0.0001 ETH (-$0.19)" is.
  const both = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(4)} ${nat}${rate > 0 ? ` (${v >= 0 ? '+' : '−'}$${Math.abs(v * rate).toFixed(2)})` : ''}`;
  const money = (v) => `${v.toFixed(4)} ${nat}${rate > 0 ? ` ($${(v * rate).toFixed(2)})` : ''}`;
  // Same minus sign as both() — toFixed() emits an ASCII hyphen, so mixing the
  // two put "−0.0005 ETH" and "-13.5%" on one line.
  const pctStr = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;
  const dot = (v) => (v >= 0 ? '🟢' : '🔴');
  if (!pf.rows.length) {
    // "No holdings" is true only of THIS chain — portfolioAll skips every
    // position on any other one. Said flatly it reads as "you hold nothing",
    // which for a user with a bag on another chain is simply false. /tokens is
    // the screen that can answer it, so point at it instead of leaving them to
    // switch chains one at a time to find out.
    return { text: `📊 <b>Portfolio</b> · ${pf.chain ? pf.chain.emoji + ' ' + esc(pf.chain.name) : ''}\n\n${T(chatId, 'pf.empty_chain')}`,
      kb: rows([btn('🪙 My tokens', 'toks'), btn('🌐 Chain', 'chain')], [btn('« Menu', 'menu')]) };
  }

  const open = pf.rows.filter((r) => r.open);
  const closed = pf.rows.filter((r) => !r.open);

  // ── Header ────────────────────────────────────────────────────────────────
  // Three SEPARATE lines, because they are three different questions and the old
  // card answered them on one. It printed
  //   Value $6.17 · 0.0033 ETH · 2.13× (+113%)
  // where the value was what you hold NOW and the multiple was every trade you
  // have EVER made, closed ones included. A portfolio whose live positions were
  // −2% and −67% read as "up 113%".
  const L = [`📊 <b>Portfolio</b> · ${pf.chain.emoji} ${esc(pf.chain.name)} · all wallets\n`];
  L.push(`💰 <b>Holding now:</b> ${money(pf.totalValueEth)}`);
  if (pf.totalCostEth > 0) {
    const pct = (pf.totalUnrealEth / pf.totalCostEth) * 100;
    L.push(`${dot(pf.totalUnrealEth)} <b>Unrealized:</b> ${both(pf.totalUnrealEth)} · ${pctStr(pct)} <i>on what you still hold</i>`);
  }
  if (Math.abs(pf.totalRealizedEth) > 1e-9) {
    L.push(`${dot(pf.totalRealizedEth)} <b>Realized:</b> ${both(pf.totalRealizedEth)} <i>banked from closed trades</i>`);
  }
  // A total that quietly omits rows is a total presented as complete when it is
  // not. Naming the count is the difference between a figure a user can act on
  // and one they later discover was wrong.
  if (pf.unpriced > 0) L.push(T(chatId, 'pf.unpriced', { n: String(pf.unpriced) }));

  // ── Open positions ────────────────────────────────────────────────────────
  if (open.length) {
    L.push(`\n<b>── Open ──</b>`);
    for (const r of open) {
      // unrealizedEth === null means the price could not be read. Printing a
      // PnL there would be inventing one, and the shape it invents is always
      // "-100%", because value 0 minus cost is the whole cost.
      const known = r.unrealizedEth != null;
      const pct = known && r.costEth > 0 ? (r.unrealizedEth / r.costEth) * 100 : null;
      const who = (r.holders && r.holders.length)
        ? r.holders.map((h) => `${esc(h.label)} ${fmt(h.tokens)}`).join(' · ')
        : '—';
      L.push(`\n<b>$${esc(r.sym)}</b> · ${known ? money(r.valueEth) : T(chatId, 'tok.no_price')}`);
      L.push(`   ${fmt(r.tokens)} tokens · cost ${money(r.costEth)}`);
      if (pct != null) L.push(`   ${dot(r.unrealizedEth)} ${both(r.unrealizedEth)} · ${pctStr(pct)}`);
      L.push(`   held: ${who}`);
      L.push(`   <code>${r.ca}</code>`);
    }
  }

  // ── Closed ────────────────────────────────────────────────────────────────
  // Their own section, showing ONLY what is true of them: what was banked. The
  // old card gave a closed token a live-looking row — "$0.0000 · 3.99× (+299%)"
  // above "now 0.0000 ETH · PnL +0.0000" — three numbers that each mean
  // something different and contradict each other at a glance.
  if (closed.length) {
    L.push(`\n<b>── Closed</b> <i>(sold out)</i> <b>──</b>`);
    for (const r of closed.slice(0, PF_CLOSED_ROWS)) {
      const mult = r.ethIn > 0 ? r.ethOut / r.ethIn : 0;
      L.push(`<b>$${esc(r.sym)}</b> · ${dot(r.realizedEth)} ${both(r.realizedEth)}${mult > 0 ? ` · <b>${mult.toFixed(2)}×</b> on ${r.ethIn.toFixed(4)} ${nat}` : ''}`);
    }
    if (closed.length > PF_CLOSED_ROWS) L.push(`<i>…and ${closed.length - PF_CLOSED_ROWS} more — see 🧾 History</i>`);
  }

  return {
    text: L.join('\n'),
    kb: rows([btn('🔄 Refresh', 'pos'), btn('📍 Monitor', 'monlist')], [btn('🧾 History', 'hist'), btn('🌐 Chain', 'chain'), btn('« Menu', 'menu')]),
  };
}

function historyScreen(chatId) {
  const u = core.ensureUser(chatId);
  const wal = core.activeWallet(u);
  const wi = core.walletList(u).findIndex((x) => x.id === wal.id) + 1;
  const ch = core.chainOf(core.userChain(u));
  const h = core.getHistory(chatId);               // active wallet, newest first
  const realized = core.realizedEth(wal, ch.key);  // active chain only (out − in; net of cost still held)
  const rp = (realized >= 0 ? '+' : '') + realized.toFixed(4);
  if (!h.length) return { text: `🧾 <b>History</b> · Wallet ${wi}\n\nNo trades yet. Paste a token contract and buy to start.`, kb: rows([btn('🔄 Refresh', 'hist'), btn('« Menu', 'menu')]) };
  let body = '';
  for (const t of h.slice(0, 20)) {
    const c = core.chainOf(t.chain || 'robinhood') || { native: 'ETH' };
    const when = t.ts ? fmtAge(t.ts) : '?';
    body += t.side === 'buy'
      ? `🟢 <b>BUY</b> $${esc(t.sym || '')} · ${Number(t.ethAmount || 0).toFixed(4)} ${c.native} · ${when} ago\n`
      : `🔴 <b>SELL</b> $${esc(t.sym || '')} ${t.pct || 100}% · ${Number(t.ethAmount || 0).toFixed(4)} ${c.native} · ${when} ago\n`;
  }
  return { text: `🧾 <b>History</b> · Wallet ${wi} · ${ch.emoji} ${esc(ch.name)}\n\nNet PnL (this chain): <b>${rp} ${ch.native}</b>\n<i>proceeds − total cost; a partly-sold bag reads low until fully exited</i>\n\n${body}`, kb: rows([btn('🔄 Refresh', 'hist'), btn('📊 Portfolio', 'pos'), btn('« Menu', 'menu')]) };
}
/**
 * Snipe by CA — the armed list, and the way to add one.
 *
 * Kept apart from the launch snipe because they answer different questions and
 * fail differently: that one watches a feed for tokens nobody has named yet and
 * goes quiet when the feed dies; this one watches named contracts for a pool and
 * goes quiet when the chain does. One screen for both would have to explain
 * which half was broken.
 */
function caSnipeScreen(chatId) {
  const u = core.ensureUser(chatId);
  const now = Date.now();
  const armed = core.armedSnipeTargets(u, now);
  const recent = core.snipeTargets(u).filter((t) => t.status !== 'armed').slice(-4).reverse();
  const ch = activeChain(chatId);
  const L = [T(chatId, 'snipe.ca.title'), '', T(chatId, 'snipe.ca.blurb'), ''];
  // Mass mode's armed state, ON THE HOME. The user who reported "buy ngasal"
  // had this armed and could not see it from where they were; a feature that
  // spends money on every launch must be visible from the sniper's front door.
  const massOn = core.chains.enabledChains().filter((c) => (u.snipe.chains || {})[c.key]);
  if (massOn.length) {
    L.push(T(chatId, 'snipe.ca.mass_note', {
      list: massOn.map((c) => `${c.emoji} ${esc(c.name)}`).join(', '),
      amt: esc(u.snipe.ethAmount),
    }), '');
  }

  if (armed.length) {
    L.push(T(chatId, 'snipe.ca.armed_head', { n: armed.length }));
    for (const t of armed) {
      const c = core.chainOf(t.chain) || { emoji: '', name: t.chain, native: '' };
      const left = t.expiresAt ? Math.max(0, Math.round((t.expiresAt - now) / 3600000)) : null;
      // ×N, or this row understates the spend by the whole multiplier the
      // armed message was careful to state.
      const nW = core.copyFanOut(u, t);
      L.push(`${c.emoji} <code>${short(t.ca)}</code> · <b>${esc(t.amount)} ${esc(c.native)}</b>${nW > 1 ? ` <b>× ${nW}</b>` : ''}`
        + (t.slipBps > 0 ? ` · ${t.slipBps / 100}%` : '')
        + (t.tpPct > 0 || t.slPct > 0 ? ` · ${[t.tpPct > 0 ? `TP +${t.tpPct}%` : '', t.slPct > 0 ? `SL −${t.slPct}%` : ''].filter(Boolean).join('/')}` : '')
        + (left != null ? ` · <i>${left}h left</i>` : ''));
    }
    L.push('');
  } else {
    L.push(T(chatId, 'snipe.ca.none'), '');
  }
  if (recent.length) {
    L.push(T(chatId, 'snipe.ca.recent_head'));
    for (const t of recent) {
      const icon = t.status === 'done' ? '✅' : t.status === 'expired' ? '⌛' : '❌';
      L.push(`${icon} <code>${short(t.ca)}</code>${t.status !== 'done' && t.lastErr ? ` · <i>${esc(String(t.lastErr).slice(0, 60))}</i>` : ''}`);
    }
    L.push('');
  }
  L.push(T(chatId, 'snipe.ca.how', { native: esc(ch.native) }));

  // Two ways in, panel first ("ada setingan lengkap, buat semudah mungkin"):
  // the 🎛 panel is every setting as a tappable row; ⌨️ is the same target in
  // one typed line for whoever is racing a launch. Both end at addSnipeTarget.
  const kbRows = [[btn(T(chatId, 'snipe.panel.open_btn'), 'snw:open')], [btn(T(chatId, 'snipe.ca.add_btn'), 'csnadd')]];
  // One row per armed target, so removing one is a single tap and never a typed
  // id. Bounded: past eight rows a keyboard stops being a keyboard.
  for (const t of armed.slice(0, 8)) {
    const c = core.chainOf(t.chain) || { emoji: '' };
    kbRows.push([btn(`🗑 ${c.emoji} ${short(t.ca)}`, `csnx:${t.id}`)]);
  }
  // Mass mode is a labelled CHOICE, never the front door — and its button
  // carries the live armed state, so what the bot is doing with real money is
  // on the button itself, not two screens away.
  const massBtn = massOn.length
    ? T(chatId, 'snipe.ca.mass_armed', { what: massOn.length === 1 ? `${massOn[0].name} · ${u.snipe.ethAmount} ${massOn[0].native}` : `${massOn.length} chains` })
    : T(chatId, 'snipe.ca.launch_btn');
  kbRows.push([btn(massBtn, 'snmass')]);
  // Straight into the dev-snipe wizard's chain pick — not a stop at the Copy
  // screen first. Managing/removing followed wallets stays on 👥 Copy.
  kbRows.push([btn(T(chatId, 'snipe.ca.dev_btn'), 'cpaddd')]);
  kbRows.push([btn('« Menu', 'menu')]);
  return { text: L.join('\n'), kb: { inline_keyboard: kbRows } };
}

/*
 * 🎛 Snipe Setup — the Sol-Trading-Bot-style panel over the SAME target store
 * as the one-line arm ("saya ingin fitur snipe sama seperti sol trading bot ada
 * setingan lengkap buat semudah mungkin", 2026-08-17).
 *
 * Every row is a button and every value is picked, not typed; the draft lives
 * in core (persisted), so a half-configured panel survives a restart the way
 * the reference bot's "Waiting for setup" does. Only settings the engine
 * honours get a row — an Anti-MEV or Max-block row the backend ignores would
 * be the stop-loss-the-user-believes-exists, as a whole screen.
 */
const SNW_SLIP_PRESETS = [10, 25, 50];
const SNW_TPSL_PRESETS = [[50, 25], [100, 50], [200, 50]];
const SNW_TTL_PRESETS = [6, 12, 24, 48, 168];
const trimNum = (n) => String(Number(Number(n).toFixed(6)));

/** `W2 nama` — the label the wallet screens already use, bounded for a button. */
function snwWalletLabel(u, walletId) {
  const wl = core.walletList(u);
  const i = wl.findIndex((w) => w.id === walletId);
  if (i < 0) return null;
  const name = String(wl[i].name || '').slice(0, 16);
  return `W${i + 1}${name ? ' ' + name : ''}`;
}

function snipeSetupScreen(chatId, note) {
  const u = core.ensureUser(chatId);
  // Rendering may mint the draft: every path that can show the panel must show
  // the SAME panel, and a "no draft yet" special case would be a second screen.
  const d = core.snipeDraft(u) || core.newSnipeDraft(chatId);
  const dev = (d.kind === 'dev');
  const ch = core.chainOf(d.chain) || { emoji: '', name: d.chain, native: '' };
  const wl = core.walletList(u);
  // The wallet SELECTION: '*' (all, resolved at fire time), or a set of ids —
  // deleted wallets dropped from the count so the multiplier stays honest.
  const selArr = d.walletIds === '*' ? null : (Array.isArray(d.walletIds) ? d.walletIds.filter((id) => wl.some((w) => w.id === id)) : []);
  const selCount = selArr === null ? wl.length : selArr.length;
  const wLab = selArr === null
    ? T(chatId, 'snipe.panel.wallet_all', { n: wl.length })
    : selArr.length === 0 ? null
      : selArr.length === 1 ? snwWalletLabel(u, selArr[0])
        : T(chatId, 'snipe.panel.wallet_n', { k: selArr.length, n: wl.length });
  const tpslOn = d.tpPct > 0 || d.slPct > 0;
  const tpslLab = tpslOn
    ? [d.tpPct > 0 ? `TP +${d.tpPct}%` : '', d.slPct > 0 ? `SL −${d.slPct}%` : ''].filter(Boolean).join(' · ')
    : T(chatId, 'snipe.panel.off');
  const slipLab = d.slipPct > 0 ? `${d.slipPct}%` : T(chatId, 'snipe.ca.slip_default');
  // The amount is PER WALLET; with several selected the total is the honest
  // number to put next to it — real money must never hide behind a multiplier.
  const amtLine = d.amount ? `${esc(d.amount)} ${esc(ch.native)}${selCount > 1 ? ` × ${selCount} = ${esc(trimNum(Number(d.amount) * selCount))} ${esc(ch.native)}` : ''}` : null;
  const tKind = dev ? '🧑‍💻' : '📍';
  // ✅/⏳ per required row — the reference panel's STATUS column, inline.
  const need = (ok) => (ok ? '✅' : '⏳');
  const L = [
    T(chatId, 'snipe.panel.title', { chain: `${ch.emoji} ${esc(ch.name)}` }), '',
    T(chatId, 'snipe.panel.blurb'), '',
  ];
  if (note) L.push(`⚠️ <i>${esc(note)}</i>`, '');
  L.push(
    T(chatId, 'snipe.panel.required'),
    `${need(true)} 🌐 ${T(chatId, 'snipe.panel.chain')}: <b>${ch.emoji} ${esc(ch.name)}</b>`,
    `${need(!!d.ca)} 🎯 ${T(chatId, 'snipe.panel.target')}: ${d.ca ? `${tKind} <code>${esc(d.ca)}</code>` : `<i>${T(chatId, 'snipe.panel.waiting')}</i>`}`,
  );
  L.push(`${need(!!wLab)} 💳 ${T(chatId, 'snipe.panel.wallet')}: <b>${esc(wLab || '—')}</b>`);
  L.push(`${need(!!d.amount)} 💵 ${T(chatId, dev ? 'snipe.panel.amount_dev' : 'snipe.panel.amount')}: ${amtLine ? `<b>${amtLine}</b>` : `<i>${T(chatId, 'snipe.panel.pick')}</i>`}`);
  // NO BUDGET ROW. The dev-snipe cap was removed outright on the owner's call
  // ("hapus fitur budget jdi budget fiturnya tidak ada"), so there is nothing
  // to set — and a row for a setting the engine no longer reads would be the
  // stop-loss-the-user-believes-exists, which is the one thing this panel has
  // always refused to grow. What replaces it is the sentence below: an uncapped
  // watch says so, every time, on the panel and on the confirmation.
  L.push(
    '',
    T(chatId, 'snipe.panel.optional'),
    `▫️ 📉 ${T(chatId, 'snipe.panel.slip')}: <b>${slipLab}</b>`,
    `▫️ 📊 ${T(chatId, 'snipe.panel.tpsl')}: <b>${tpslLab}</b>`,
    dev
      ? `⚠️ <i>${T(chatId, 'snipe.panel.nocap', { per: esc(Number(d.amount) > 0 ? trimNum(Number(d.amount) * selCount) : '—'), native: esc(ch.native) })}</i>`
      : `▫️ 🕒 ${T(chatId, 'snipe.panel.ttl')}: <b>${d.ttlH}h</b>`,
    '',
    T(chatId, dev ? 'snipe.panel.dev_foot' : 'snipe.panel.foot'),
  );
  // READY, said out loud. Every required row can read ✅ and the screen still
  // never states that the thing is not armed yet — "dmn ada teks snipe atau
  // confirm??" is what a panel that looks finished but has not fired asks of
  // its reader. Nothing here spends until ⚡ is tapped, so say both halves.
  //
  // ⚠️ AND A REFUSED PANEL DROPS IT, never keeps it beside the refusal. "⚡ ARM
  // SNIPE was tapped and refused" over "tap ⚡ ARM SNIPE below to start
  // watching" is two lines contradicting each other with the reassuring one
  // LAST, directly above the button — so the reader taps again, gets the same
  // silence, and reports the button as dead. The auto-raid panel already had to
  // learn to DROP its ready line rather than reword it; this is the same rule,
  // on the panel that spends money.
  const ready = !!d.ca && !!d.amount && selCount > 0;
  // ALREADY WATCHING THIS EXACT TARGET? Then ⚡ can only ever be refused, and a
  // panel that shows every row ✅ over a live ARM button is indistinguishable
  // from one that has never been armed — which is precisely how an operator
  // ends up tapping it, being refused, and asking why. `armedTargetFor` is the
  // one owner of that question; the two arming sites already refuse a
  // duplicate, and this is the same fact read one screen earlier, where it can
  // still be acted on.
  const armed = d.ca ? core.armedTargetFor(chatId, { kind: dev ? 'dev' : 'ca', chain: d.chain, ca: d.ca }) : null;
  if (note) L.push('', T(chatId, 'snipe.panel.refused'));
  else if (armed) L.push('', T(chatId, dev ? 'snipe.panel.already_dev' : 'snipe.panel.already_ca', {
    spent: esc(Number(armed.spentEth || 0).toFixed(3)), native: esc(ch.native),
  }));
  else L.push('', T(chatId, ready ? 'snipe.panel.ready' : 'snipe.panel.not_ready'));
  // Label + value, two buttons a row — the reference's two-column table. Both
  // open the same editor, so there is no wrong half to tap.
  const kbRows = [
    [btn(`🌐 ${T(chatId, 'snipe.panel.chain')}`, 'snw:chain'), btn(`${ch.emoji} ${ch.name}`, 'snw:chain')],
    [btn(`🎯 ${T(chatId, 'snipe.panel.target')}`, 'snw:ca'), btn(d.ca ? `✅ ${tKind} ${short(d.ca)}` : `⏳ ${T(chatId, 'snipe.panel.set_btn')}`, 'snw:ca')],
    [btn(`💳 ${T(chatId, 'snipe.panel.wallet')}`, 'snw:wal'), btn(wLab ? `✅ ${wLab}` : '⏳', 'snw:wal')],
    [btn(`💵 ${T(chatId, dev ? 'snipe.panel.amount_dev' : 'snipe.panel.amount')}`, 'snw:amt'), btn(d.amount ? `✅ ${d.amount} ${ch.native}` : `⏳ ${T(chatId, 'snipe.panel.pick_btn')}`, 'snw:amt')],
    [btn(`📉 ${T(chatId, 'snipe.panel.slip')}`, 'snw:slip'), btn(d.slipPct > 0 ? `${d.slipPct}%` : T(chatId, 'snipe.ca.slip_default'), 'snw:slip')],
    [btn(`📊 ${T(chatId, 'snipe.panel.tpsl')}`, 'snw:tpsl'), btn(tpslOn ? tpslLab : T(chatId, 'snipe.panel.off'), 'snw:tpsl')],
  ];
  if (dev) {
  } else {
    kbRows.push([btn(`🕒 ${T(chatId, 'snipe.panel.ttl')}`, 'snw:ttl'), btn(`${d.ttlH}h`, 'snw:ttl')]);
  }
  // The ⚡ row is REPLACED, not merely relabelled, when this target is already
  // watching: the tap can only be refused, so the row becomes the one thing
  // the reader actually wants next — the list it is already on.
  // ⚡ UPDATES an already-watching target rather than refusing it: tapping it on
  // a panel showing new settings has one possible meaning. The label says which
  // of the two it will do, because "armed" and "re-termed" are different events
  // to someone whose budget has already been partly spent.
  kbRows.push([btn(T(chatId, armed ? 'snipe.panel.update_btn' : 'snipe.panel.arm_btn'), 'snw:arm')]);
  if (armed) kbRows.push([btn(T(chatId, dev ? 'snipe.panel.see_dev_btn' : 'snipe.panel.see_ca_btn'), dev ? 'copy' : 'csn')]);
  kbRows.push(dev
    ? [btn(T(chatId, 'snipe.panel.discard_btn'), 'snw:cancel')]
    : [btn(T(chatId, 'snipe.panel.oneline_btn'), 'csnadd'), btn(T(chatId, 'snipe.panel.discard_btn'), 'snw:cancel')]);
  kbRows.push([btn('« Back', 'csn')]);
  return { text: L.join('\n'), kb: { inline_keyboard: kbRows } };
}
// The per-row editors. Each edits the panel message in place and returns to it.
function snwChainScreen(chatId) {
  const u = core.ensureUser(chatId);
  const d = core.snipeDraft(u) || core.newSnipeDraft(chatId);
  const en = core.chains.enabledChains();
  const kbR = [];
  for (let i = 0; i < en.length; i += 2) kbR.push(en.slice(i, i + 2).map((c) => btn(`${c.key === d.chain ? '✓ ' : ''}${c.emoji} ${c.name}`, `snwch:${c.key}`)));
  kbR.push([btn('« Back', 'snw:open')]);
  return { text: T(chatId, 'snipe.ca.pick_chain'), kb: { inline_keyboard: kbR } };
}
function snwWalletScreen(chatId) {
  const u = core.ensureUser(chatId);
  const d = core.snipeDraft(u) || core.newSnipeDraft(chatId);
  const wl = core.walletList(u);
  // MULTI-SELECT, the same model as the buy/sell wallet picker ("bisa pilih
  // multi wallet, all on atau all off, sama kaya beli"): tap a wallet to
  // toggle it; ✅/⬜ set the lot. '*' keeps its meaning — EVERY wallet,
  // resolved at fire time, so a wallet added after arming still snipes. The
  // dev path honours the selection too: each fill records its own exit-mirror
  // leg, so every wallet's slice is sold from the wallet that bought it.
  const sel = d.walletIds === '*' ? new Set(wl.map((w) => w.id)) : new Set(Array.isArray(d.walletIds) ? d.walletIds : []);
  const kbR = [];
  if (wl.length > 1) kbR.push([
    btn(T(chatId, 'snipe.panel.wallet_all_btn', { n: wl.length }), 'snww:*'),
    btn(T(chatId, 'snipe.panel.wallet_none_btn'), 'snw:waln'),
  ]);
  wl.forEach((w, i) => {
    const name = String(w.name || '').slice(0, 16);
    kbR.push([btn(`${sel.has(w.id) ? '✅' : '⬜️'} W${i + 1}${name ? ' ' + name : ''} · ${short(w.address)}`, `snwwt:${w.id}`)]);
  });
  kbR.push([btn(T(chatId, 'snipe.panel.done_btn'), 'snw:open')]);
  return { text: T(chatId, 'snipe.panel.wal_pick'), kb: { inline_keyboard: kbR } };
}
function snwAmountScreen(chatId) {
  const u = core.ensureUser(chatId);
  const d = core.snipeDraft(u) || core.newSnipeDraft(chatId);
  const ch = core.chainOf(d.chain) || { native: '' };
  // The chain's own quick-buy presets — 0.01 of one coin is not 0.01 of another.
  const QUICK = core.buyPresets(u, d.chain).map(String);
  const kbR = [];
  for (let i = 0; i < QUICK.length; i += 3) {
    kbR.push(QUICK.slice(i, i + 3).map((p) => btn(`${d.amount === p ? '✓ ' : ''}${p} ${ch.native}`, `snwa:${p}`)));
  }
  kbR.push([btn(T(chatId, 'snipe.panel.custom_btn'), 'snw:amtc')]);
  kbR.push([btn('« Back', 'snw:open')]);
  return { text: T(chatId, 'snipe.panel.amt_pick', { native: esc(ch.native) }), kb: { inline_keyboard: kbR } };
}
function snwSlipScreen(chatId) {
  const u = core.ensureUser(chatId);
  const d = core.snipeDraft(u) || core.newSnipeDraft(chatId);
  const kbR = [[btn(`${!(d.slipPct > 0) ? '✓ ' : ''}${T(chatId, 'snipe.ca.slip_default')}`, 'snws:0'),
    ...SNW_SLIP_PRESETS.map((p) => btn(`${d.slipPct === p ? '✓ ' : ''}${p}%`, `snws:${p}`))]];
  kbR.push([btn(T(chatId, 'snipe.panel.custom_btn'), 'snw:slipc')]);
  kbR.push([btn('« Back', 'snw:open')]);
  return { text: T(chatId, 'snipe.panel.slip_pick'), kb: { inline_keyboard: kbR } };
}
function snwTpslScreen(chatId) {
  const u = core.ensureUser(chatId);
  const d = core.snipeDraft(u) || core.newSnipeDraft(chatId);
  const on = d.tpPct > 0 || d.slPct > 0;
  const kbR = [[btn(`${on ? '' : '✓ '}${T(chatId, 'snipe.panel.off')}`, 'snwt:off'),
    ...SNW_TPSL_PRESETS.map(([tp, sl]) => btn(`${d.tpPct === tp && d.slPct === sl ? '✓ ' : ''}+${tp}% / −${sl}%`, `snwt:${tp}/${sl}`))]];
  kbR.push([btn(T(chatId, 'snipe.panel.custom_btn'), 'snw:tpslc')]);
  kbR.push([btn('« Back', 'snw:open')]);
  return { text: T(chatId, 'snipe.panel.tpsl_pick'), kb: { inline_keyboard: kbR } };
}
function snwTtlScreen(chatId) {
  const u = core.ensureUser(chatId);
  const d = core.snipeDraft(u) || core.newSnipeDraft(chatId);
  const kbR = [SNW_TTL_PRESETS.map((h) => btn(`${d.ttlH === h ? '✓ ' : ''}${h}h`, `snwx:${h}`))];
  kbR.push([btn(T(chatId, 'snipe.panel.custom_btn'), 'snw:ttlc')]);
  kbR.push([btn('« Back', 'snw:open')]);
  return { text: T(chatId, 'snipe.panel.ttl_pick'), kb: { inline_keyboard: kbR } };
}
/** The armed confirmation, shared by the panel's ⚡ and the one-line arm — one
 *  message shape however the target was configured. */
function snipeArmedText(chatId, tgt) {
  const ch = core.chainOf(tgt.chain) || { emoji: '', name: tgt.chain, native: '' };
  const exitParts = [tgt.tpPct > 0 ? `TP +${tgt.tpPct}%` : '', tgt.slPct > 0 ? `SL −${tgt.slPct}%` : ''].filter(Boolean).join(' · ');
  let out = T(chatId, 'snipe.ca.armed', {
    chain: `${ch.emoji} ${esc(ch.name)}`,
    ca: esc(tgt.ca),
    amt: esc(tgt.amount),
    native: esc(ch.native),
    slip: tgt.slipBps > 0 ? `${tgt.slipBps / 100}%` : T(chatId, 'snipe.ca.slip_default'),
    exits: exitParts ? T(chatId, 'snipe.ca.exits', { parts: exitParts }) : '',
    hours: Math.round((tgt.expiresAt - tgt.createdAt) / 3600000),
  });
  // Multi-wallet: the multiplied total is real money and must be ON the
  // confirmation, not discovered on the receipts. A CA snipe fires ONCE, so it
  // gets the one-shot sentence (see walletScopeLine).
  return out + walletScopeLine(chatId, tgt, tgt.amount, ch.native, 'snipe.panel.armed_wallets');
}
/** "👥 On every wallet (6) — 0.1 SOL each, …" — the wallet scope and the
 *  multiplied total, in the cadence of the feature that is arming. Empty when
 *  only one wallet is involved, because there is no multiplier to state. */
function walletScopeLine(chatId, tgt, amount, native, key) {
  const all = tgt.walletId === '*';
  const n = all ? core.walletList(core.ensureUser(chatId)).length : (Array.isArray(tgt.walletIds) ? tgt.walletIds.length : 1);
  if (!(n > 1)) return '';
  return '\n' + T(chatId, key, {
    scope: T(chatId, all ? 'snipe.panel.scope_all' : 'snipe.panel.scope_n', { n }),
    n, amt: esc(amount), native: esc(native), total: esc(trimNum(Number(amount) * n)),
  });
}

/**
 * The PnL card for ONE token — held, sold, or half of each.
 *
 * The chain comes from the CALLER (a pasted address is chain-detected first),
 * never from whatever chain happens to be active: a Solana mint answered
 * against Ethereum reads as "no trades on file", which is a false statement
 * about the user's own money and the exact bounce the snipe flow already had
 * to be rescued from.
 */
async function pnlCardScreen(chatId, ca, chainKey) {
  const ch = core.chainOf(chainKey) || activeChain(chatId);
  const p = await core.tokenPnl(chatId, ca, ch.key);
  if (!p) return { text: '📊 <b>PnL</b>\n\nNothing to report yet.', kb: rows([btn('« Menu', 'menu')]) };
  const text = pnl.pnlText(
    { ...p, sym: esc(p.sym || ''), name: esc(p.name || '') },
    { native: ch.native, rate: nativeUsd(ch.native), chainLabel: `${ch.emoji} ${esc(ch.name)}` },
  );
  const wi = walletIndex(chatId);
  const kb = { inline_keyboard: [
    [btn('🔄 Refresh', `pnlt:${ch.key}:${ca}`), btn('🔎 Open card', `tok:${ch.key}:${wi}:${ca}`)],
    [{ text: '📈 Chart', url: chartUrl(ch.key, ca) }, btn('📊 All PnL', 'pnl')],
    [btn('« Menu', 'menu')],
  ] };
  return { text, kb, p, ch };
}
/**
 * The PnL card as a PICTURE where one can be drawn, and as the text card where
 * it cannot.
 *
 * A photo cannot be EDITED into a text message, so this always SENDS. Every
 * failure — no canvas on the box, a figure the image refuses to state (an
 * unreadable balance is not a number to put on a branded card), a Telegram
 * upload error — falls through to the text the user would have had anyway.
 */
async function sendPnlCard(chatId, ca, chainKey) {
  const s = await pnlCardScreen(chatId, ca, chainKey);
  if (s.p && pnlImage.available()) {
    // RAW values, not the escaped ones: this draws glyphs, and `&amp;` on a
    // canvas is four characters of nonsense.
    let buf = null;
    try {
      const u = core.ensureUser(chatId);
      // The token's own art and the user's referral QR. BOTH are bounded and
      // BOTH may fail: the card falls back to the brand gem wearing the
      // ticker, and to a plain dexvra.io line. A picture that waited on an
      // image host would be the wallet-dashboard mistake on a share card.
      const logoUrl = await withTmo(core.tokenLogoUrl(ca, s.ch.key).catch(() => null), 2500, null);
      buf = await pnlImage.render(s.p, {
        native: s.ch.native, rate: nativeUsd(s.ch.native), chainName: s.ch.name,
        logoUrl: logoUrl || '',
        refLink: BOT_USERNAME && u.refCode ? `https://t.me/${BOT_USERNAME}?start=${u.refCode}` : '',
        qrApi: QR_API,
        botUser: BOT_USERNAME || '',
      });
    } catch (e) { console.error('[pnl] render failed:', (e && e.message) || e); }
    // The caption carries the exact figures the card rounds — a shareable
    // picture and a checkable number are different jobs.
    if (buf && await sendPhotoBuffer(chatId, buf, s.text.slice(0, 1024), s.kb)) return;
  }
  return send(chatId, s.text, s.kb);
}
/**
 * The book: every token this chain has a position in, won or lost.
 *
 * Closed trades stay on it. A PnL screen that only lists what you still hold
 * answers "what am I exposed to" — which /portfolio already does — and cannot
 * answer "did I make money", which is the question this command was asked for.
 */
async function pnlBookScreen(chatId) {
  const u = core.ensureUser(chatId);
  const chainKey = core.userChain(u);
  const ch = core.chainOf(chainKey);
  // Every CA with a position on this chain, across every wallet — the same
  // union portfolioAll builds, but kept here because that one drops closed rows
  // from its value ranking and this screen is mostly closed rows.
  const seen = new Map();
  for (const wal of core.walletList(u)) {
    for (const key of Object.keys(wal.positions || {})) {
      const pos = wal.positions[key];
      if (!pos || pos.chain !== chainKey) continue;
      const k = core.chains.isSvm(chainKey) ? String(pos.ca) : String(pos.ca).toLowerCase();
      if (!seen.has(k)) seen.set(k, pos.ca);
    }
  }
  // Bounded and CONCURRENT: each row is a balance read per wallet plus a price,
  // and a book of thirty tokens read serially is the wallet-dashboard mistake
  // over again.
  const cas = [...seen.values()].slice(0, PNL_BOOK_MAX);
  const rows0 = (await Promise.all(cas.map((ca) => core.tokenPnl(chatId, ca, chainKey).catch(() => null)))).filter(Boolean);
  const text = pnl.pnlBook(
    rows0.map((r) => ({ ...r, sym: esc(r.sym || ''), name: esc(r.name || '') })),
    { native: ch.native, rate: nativeUsd(ch.native), chainLabel: `${ch.emoji} ${esc(ch.name)}` },
  );
  const kbRows = [];
  // One button per token, best first, so the card for any of them is one tap.
  const top = rows0.slice().sort((a, b) => (Number(b.pnlEth) || 0) - (Number(a.pnlEth) || 0)).slice(0, 6);
  for (let i = 0; i < top.length; i += 2) {
    kbRows.push(top.slice(i, i + 2).map((r) => btn(`📊 $${(r.sym || short(r.ca)).slice(0, 10)}`, `pnlt:${chainKey}:${r.ca}`)));
  }
  kbRows.push([btn('🔎 Paste a contract', 'pnlask'), btn('🔄 Refresh', 'pnl')]);
  kbRows.push([btn('📊 Portfolio', 'pos'), btn('🧾 History', 'hist'), btn('« Menu', 'menu')]);
  return { text, kb: { inline_keyboard: kbRows } };
}
// A book is a balance read per wallet PER TOKEN plus a price each; past this
// many the screen costs more than it says. The rest are still reachable by
// pasting the contract.
const PNL_BOOK_MAX = Math.max(1, Number(process.env.PNL_BOOK_MAX || 24));

function snipeScreen(chatId) {
  const u = core.ensureUser(chatId);
  const chains = u.snipe.chains || {};
  const enabled = core.chains.enabledChains();
  const onList = enabled.filter((c) => chains[c.key]);
  const amt = esc(u.snipe.ethAmount);
  const live = onList.length > 0;
  // Friendly means SHORT ("setingan snipe bener-bener dibuat bingung, tidak
  // friendly"): one line of what it does, the live status, a two-step how-to,
  // one warning. The amount lives in ONE place — Step 2 of arming. The old
  // ✏️ editor row kept a second copy of it on this screen, so "✓ 0.05" on
  // the amount step and "0.1" here could be on screen at the same time,
  // reading as the bot disagreeing with itself.
  const status = live
    ? onList.map((c) => `🟢 Sniping <b>${c.emoji} ${esc(c.name)}</b> — <b>${amt} ${esc(c.native)}</b> per launch`).join('\n')
    : `⚪ Not sniping yet.`;
  const text =
    `🎯 <b>Auto-Snipe</b>\n\n` +
    `I buy <b>every brand-new launch</b> on the chains you turn on — automatically, the second trading opens.\n\n` +
    `${status}\n\n` +
    `1️⃣ Tap a chain\n` +
    `2️⃣ Pick how much to spend per launch\n` +
    `That's it. Tap the chain again anytime to stop.\n\n` +
    `⚠️ <i>New launches are high-risk — keep the amount small. Honeypots are filtered out automatically.</i>\n\n` +
    `<i>Already have the contract? Use 📍. Following one developer? Use 🎯.</i>`;
  const kbRows = [];
  // The button says the ACTION, not a state — "⚪ OFF" read as a broken
  // switch; "tap to snipe" says what the tap will do. An armed row carries
  // the live spend, so what the bot is doing with real money is on the
  // button itself, not two screens away.
  enabled.forEach((c) => kbRows.push([btn(
    chains[c.key] ? `🟢 ${c.emoji} ${c.name} · ${amt} ${c.native} — tap to stop` : `${c.emoji} ${c.name} — tap to snipe`,
    `sntog:${c.key}`)]));
  kbRows.push([btn('📍 Snipe one contract', 'csn')]);
  kbRows.push([btn('🎯 Snipe a specific developer', 'copy')]);
  kbRows.push([btn('« Back', 'snipe')]);
  return { text, kb: { inline_keyboard: kbRows } };
}
// Step 2 of arming auto-snipe: the chain is chosen, now the spend. Rendered as
// its own screen so arming ALWAYS passes through an explicit amount choice —
// the "buy ngasal" incident was an amount set once, weeks earlier, on a
// different screen, silently reused.
function snipeAmountScreen(chatId, chainKey) {
  const u = core.ensureUser(chatId);
  const c = core.chainOf(chainKey);
  const cur = String(u.snipe.ethAmount);
  const QUICK = ['0.01', '0.05', '0.1', '0.5'];
  const text =
    `🎯 <b>Auto-Snipe on ${c.emoji} ${esc(c.name)}</b>\n\n` +
    `2️⃣ <b>How much per launch?</b>\n` +
    `Pick an amount — sniping starts as soon as you do.\n\n` +
    `<i>Keep it small — this buys EVERY launch, good and bad alike.</i>`;
  const kbRows = [];
  // Two per row so "0.05 SOL" never truncates to a bare number on a phone —
  // the unit is the part that makes the button mean something.
  for (let i = 0; i < QUICK.length; i += 2) {
    kbRows.push(QUICK.slice(i, i + 2).map((p) => btn(`${cur === p ? '✓ ' : ''}${p} ${c.native}`, `snarm:${chainKey}:${p}`)));
  }
  kbRows.push([btn('✏️ Type my own amount', `snarmc:${chainKey}`)]);
  kbRows.push([btn('« Back', 'snmass')]);
  return { text, kb: { inline_keyboard: kbRows } };
}
// The ONE site that arms auto-snipe. Amount and chain are committed together,
// so arming can never silently reuse an amount set weeks earlier on another
// screen — the half of the "buy ngasal" incident that consent alone did not
// fix. ARMING IS SAID OUT LOUD: the warning states the blast radius and the
// spend it was just given; disarming stays silent because OFF needs no warning.
async function armAutoSnipe(chatId, chainKey, amt, mid) {
  try { core.setSnipeAmount(chatId, amt); } catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
  let armedNow = false;
  try { const chains = core.setSnipeChain(chatId, chainKey, true); armedNow = !!chains[chainKey]; } catch (_) {}
  const u = core.ensureUser(chatId);
  const s = snipeScreen(chatId);
  if (mid) await edit(chatId, mid, s.text, s.kb); else await send(chatId, s.text, s.kb);
  if (armedNow) {
    const chG = core.chainOf(chainKey);
    await send(chatId, `⚠️ <b>Auto-Snipe is now ARMED on ${chG ? esc(chG.name) : esc(chainKey)}.</b>\nThe bot will buy <b>every new launch</b> it sees on this chain — no target list, no confirmation per buy — spending <b>${esc(String(u.snipe.ethAmount))} ${chG ? chG.native : ''}</b> each time until you turn it off here or run out of balance.\n<i>This is separate from CA snipe and dev-wallet snipe, which only ever buy their own targets.</i>`);
  }
}
// Execution speed, in the user's terms. "gasMult 3, slipAddBps 1500" is the
// implementation; what a trader needs to know is what it buys them and what it
// costs.
const SPEED_NAME = { normal: 'Normal', fast: 'Fast', turbo: 'Turbo' };
const SPEED_ICON = { normal: '🐢', fast: '⚡', turbo: '🚀' };
const SPEED_LABEL = {
  normal: '🐢 Normal — ordinary gas and slippage. Cheapest; may miss a fast move.',
  fast: '⚡ Fast — 2× gas, +5% slippage. Lands through normal traffic.',
  turbo: '🚀 Turbo — 3× gas, +15% slippage. Built to land during a dump; costs the most.',
};
const SPEED_ORDER = ['normal', 'fast', 'turbo'];
/** One line telling the user how hard this order will try to land, and where to
 *  change it. A stop-loss defaults to Turbo precisely because it fires when the
 *  pool is busiest — but a default nobody is told about is a default nobody can
 *  disagree with. */
const speedNote = (o) => `${SPEED_LABEL[watchers.orderSpeed(o)]}\n<i>Tap 📋 Orders to change this.</i>`;

function ordersScreen(chatId) {
  const u = core.ensureUser(chatId);
  const wl = core.walletList(u);
  const multi = wl.length > 1;
  const list = [];
  wl.forEach((w, i) => { for (const o of (w.orders || [])) list.push({ o, wi: i + 1 }); });
  if (!list.length) return { text: '📋 <b>Orders</b>\n\nNo active orders. Open a token card and set a TP / SL / Limit buy.', kb: rows([btn('« Menu', 'menu')]) };
  let body = ''; const kbRows = [];
  for (const { o, wi } of list) {
    const c = core.chainOf(o.chain || 'robinhood');
    const label = o.type === 'tp' ? 'TP' : o.type === 'sl' ? 'SL' : o.type === 'trail' ? 'Trail' : 'Limit buy';
    const wtag = multi ? ` · <i>W${wi}</i>` : '';
    let tgt;
    if (o.type === 'trail') tgt = `−${Number(o.trailPct) || 0}% from peak`;
    else if (o.metric === 'mcap') tgt = nativeUsd(c.native) > 0 ? ('MC $' + fmt(o.targetPriceEth * nativeUsd(c.native))) : ('MC ' + o.targetPriceEth.toPrecision(3) + ' ' + c.native);
    else tgt = nativeUsd(c.native) > 0 ? ('$' + (o.targetPriceEth * nativeUsd(c.native)).toPrecision(3)) : (o.targetPriceEth.toExponential(2) + ' ' + c.native);
    const tail = o.type === 'limitbuy' ? ' · ' + o.ethAmount + ' ' + c.native : ' · sell ' + (o.sellPct || 100) + '%';
    // How hard this order will try to LAND, spelled out. A stop-loss fires while
    // the price is falling and everyone else is leaving; at ordinary gas and
    // ordinary slippage it is a stop-loss that misses. The number was decided
    // for the user and never shown to them.
    const sp = watchers.orderSpeed(o);
    body += `${c.emoji} <b>${label}</b> $${esc(o.sym || '')} @ ${tgt}${tail}${wtag}\n`;
    body += `    <i>${SPEED_LABEL[sp]}</i>\n`;
    kbRows.push([
      btn(`${SPEED_ICON[sp]} ${SPEED_NAME[sp]}`, `ospd:${o.id}`),
      btn(`✖ Cancel ${label} $${o.sym || ''}${multi ? ' (W' + wi + ')' : ''}`, `oc:${o.id}`),
    ]);
  }
  kbRows.push([btn('« Menu', 'menu')]);
  return { text: `📋 <b>Active orders</b>\n\n${body}`, kb: { inline_keyboard: kbRows } };
}
function dcaScreen(chatId) {
  const u = core.ensureUser(chatId);
  const list = u.dca || [];
  if (!list.length) return { text: '🔁 <b>DCA — scheduled buys</b>\n\nNo active plans. Open a token card and tap 🔁 DCA to buy a fixed amount on a repeating schedule.', kb: rows([btn('« Menu', 'menu')]) };
  let body = ''; const kbRows = [];
  const wl = core.walletList(u);
  for (const p of list) {
    const c = core.chainOf(p.chain) || { emoji: '', native: '' };
    const wi = (wl.findIndex((w) => w.id === p.walletId) + 1) || 1;
    body += `${c.emoji} <b>$${esc(p.sym || '')}</b> · ${esc(p.amount)} ${c.native} every ${p.intervalMin}m · <b>${p.roundsLeft}/${p.rounds}</b> left${wl.length > 1 ? ' · W' + wi : ''}\n`;
    kbRows.push([btn(`✖ Cancel $${p.sym || ''} DCA`, `dcac:${p.id}`)]);
  }
  kbRows.push([btn('« Menu', 'menu')]);
  return { text: `🔁 <b>Active DCA plans</b>\n\n${body}`, kb: { inline_keyboard: kbRows } };
}
function alertsScreen(chatId) {
  const u = core.ensureUser(chatId);
  const list = u.alerts || [];
  if (!list.length) return { text: '🔔 <b>Price alerts</b>\n\nNo alerts. Open a token card and tap 🔔 Alert to get pinged when a token crosses a target price. (Notify-only — no trade.)', kb: rows([btn('« Menu', 'menu')]) };
  let body = ''; const kbRows = [];
  for (const a of list) {
    const c = core.chainOf(a.chain || 'robinhood') || { emoji: '' };
    body += `${c.emoji} $${esc(a.sym || '')} ${a.dir === 'above' ? '↑' : '↓'} $${esc(String(a.targetUsd != null ? a.targetUsd : a.targetPriceEth))}\n`;
    kbRows.push([btn(`✖ Cancel $${a.sym || ''} ${a.dir === 'above' ? '↑' : '↓'}`, `al:${a.id}`)]);
  }
  kbRows.push([btn('« Menu', 'menu')]);
  return { text: `🔔 <b>Active alerts</b>\n\n${body}`, kb: { inline_keyboard: kbRows } };
}
function copyScreen(chatId) {
  const u = core.ensureUser(chatId);
  const c = u.copy || { on: false, targets: [] };
  const list = c.targets || [];
  const ach = activeChain(chatId);
  let body = `👥 <b>Copy &amp; Dev Snipe</b> (beta)\n\n` +
    `Follow any wallet and act on it automatically. Two modes:\n` +
    `• <b>Copy trades</b> — when it <b>buys</b> a token, you buy it too.\n` +
    `• <b>Dev snipe</b> 🎯 — when it <b>launches a new token</b> on the launchpad, you buy the launch instantly (like a pump.fun dev sniper).\n\n` +
    `Each followed wallet also has an <b>exit mirror</b> 🔻: the moment that wallet starts selling a token you copy-bought from it, you sell <b>100%</b> of yours. Tokens you bought yourself are never touched.\n\n` +
    `Master switch: <b>${c.on ? '🟢 ON' : '⚪ OFF'}</b>\n\n`;
  const kbRows = [[btn(c.on ? '🔴 Turn OFF' : '🟢 Turn ON', 'cptog')]];
  if (!list.length) body += '<i>No wallets followed yet — add one below.</i>\n';
  else {
    body += '<b>Following:</b>\n';
    for (const t of list) {
      const ch = core.chainOf(t.chain) || { emoji: '' };
      const badge = (t.mode === 'launches') ? '🎯 dev snipe' : '👥 copy trades';
      const spent = Number(t.spentEth).toFixed(3), max = esc(t.maxEth);
      // A dev snipe has no cap, so it has no "/max" to print — a denominator
      // there would be a limit that does not exist. The running TOTAL stays:
      // it is the only number that says what an uncapped watch has spent.
      const spend = (t.mode === 'launches')
        ? T(chatId, 'copy.spent_uncapped', { spent })
        : `used ${spent}/${max}`;
      const held = Object.keys(t.holding || {}).length;
      // ×N on the per-buy figure: a 3-wallet target spends 3× this on every
      // launch, and a row that hides the multiplier is the one screen where a
      // user checks what the bot is committed to spending.
      const nW = core.copyFanOut(u, t);
      body += `${ch.emoji} <code>${short(t.address)}</code> · <b>${badge}</b>\n    ${esc(t.buyEth)}/buy${nW > 1 ? ` × <b>${nW}</b> wallets` : ''} · ${spend} ${ch.native || ''}\n` +
        `    🔻 Exit mirror: <b>${t.copySell ? '🟢 ON' : '⚪ OFF'}</b>${held ? ` · watching <b>${held}</b> position${held > 1 ? 's' : ''}` : ''}\n`;
      kbRows.push([
        btn(t.copySell ? '🔻 Exit mirror OFF' : '🔻 Exit mirror ON', `cpsell:${t.id}`),
        btn(`✖ Remove ${short(t.address)}`, `cprm:${t.id}`),
      ]);
    }
  }
  if (list.length < core.MAX_COPY_TARGETS) {
    kbRows.push([btn('➕ Copy trades', 'cpadd')]);
    // Dev snipe is only offered when the active chain is a launchpad chain.
    if (core.canDevSnipe(ach.key)) kbRows.push([btn('🎯 Snipe a dev wallet', 'cpaddd')]);
  }
  // Cross-link, not a mode: this screen's own button says "Snipe", so anyone
  // hunting for the CA snipe lands here — and used to be stuck ("cuman seperti
  // ini"). Outside the target-cap gate above, because navigation must not
  // disappear when the follow list is full.
  kbRows.push([btn('📍 Snipe one contract', 'csn')]);
  kbRows.push([btn('« Menu', 'menu')]);
  body += `\n<i>Both modes skip honeypots. Copy trades is capped by its budget; 🎯 dev snipe has NO cap — it buys every launch until you turn it off or remove it. Turn the master switch ON to start. ⚠️ High risk — DYOR.</i>`;
  body += `\n<i>The exit mirror only ever sells what copy bought from that wallet, and only positions opened after you enabled it — it will not reach back into bags you already held.</i>`;
  if (!core.canDevSnipe(ach.key)) body += `\n<i>🎯 Dev snipe is available on Robinhood Chain &amp; Solana — switch chain (🌐) to add one.</i>`;
  return { text: body, kb: { inline_keyboard: kbRows } };
}
function referralScreen(chatId) {
  const u = core.ensureUser(chatId);
  const link = `https://t.me/${BOT_USERNAME}?start=${u.refCode}`;
  const owed = u.refOwed || {};
  const earned = Object.keys(owed).length
    ? Object.entries(owed).map(([ck, wei]) => { const c = core.chainOf(ck) || { native: 'ETH' }; return `${fmtNat(wei || '0', ck)} ${c.native}`; }).join(' · ')
    : '0';
  return {
    text: `🎁 <b>Referrals</b>\n\nShare your link — you earn <b>${(core.CFG.refShareBps / 100).toFixed(0)}%</b> of the bot fee on every trade your referrals make.\n\n<code>${link}</code>\n\nEarned so far: <b>${earned}</b>\n<i>${core.feePayoutEnabled() ? 'Auto-paid to your active wallet once it clears the minimum.' : 'Settled manually by the team.'}</i>`,
    kb: rows([btn('« Menu', 'menu')]),
  };
}

function settingsScreen(chatId) {
  const u = core.ensureUser(chatId);
  const s = u.settings;
  const ch = core.chainOf(core.userChain(u));
  const slip = s.slippage > 0 ? s.slippage + '%' : 'default (5%)';
  const bp = core.buyPresets(u, ch.key).join(' · ');
  const perChain = core.hasChainPresets(u, ch.key) ? ' <i>(set for this chain)</i>' : '';
  const onoff = (b) => b ? '🟢 ON' : '⚪ OFF';
  const gasName = gasLabel(core.userGasBoost(u));
  return {
    text: `⚙️ <b>Settings</b>\n\n` +
      `<b>Trading</b>\n` +
      `Active chain: <b>${ch.emoji} ${esc(ch.name)}</b>\n` +
      `Slippage: <b>${esc(String(slip))}</b>\n` +
      `Gas priority: <b>${esc(gasName)}</b>\n` +
      `Quick-buy (${esc(ch.name)}): <b>${esc(bp)} ${ch.native}</b>${perChain}\n\n` +
      `<b>How buys behave</b>\n` +
      `Confirm before buy: <b>${onoff(s.confirmBuy)}</b>\n` +
      `Fast mode: <b>${onoff(s.expert)}</b>\n` +
      `Auto-buy on paste: <b>${s.autoBuy ? '🟢 ON · ' + esc(s.autoBuyAmount) + ' ' + ch.native : '⚪ OFF'}</b>\n` +
      `Receipts: <b>${core.perWalletReceipts(u) ? '📩 One per wallet' : '📋 One combined'}</b>\n\n` +
      `<b>Automatic exits</b>\n` +
      `Auto-exit after buy: <b>${(s.autoTpPct > 0 || s.autoSlPct > 0) ? [(s.autoTpPct > 0 ? 'TP +' + s.autoTpPct + '%' : ''), (s.autoSlPct > 0 ? 'SL −' + s.autoSlPct + '%' : '')].filter(Boolean).join(' · ') : '⚪ OFF'}</b>\n` +
      `🛡 Auto-protect (rug guard): <b>${onoff(s.autoProtect)}</b>\n\n` +
      `<i>Quick-buy amounts are per-chain. Fast mode skips the "buying…" message. Auto-buy buys instantly on paste. Auto-protect auto-sells only on a ~60% loss vs entry or a honeypot — never a profitable dip.</i>\n` +
      `<i>Receipts: one per wallet posts each fill the moment it lands — combined waits for the slowest wallet and sends one message.</i>`,
    kb: rows(
      [btn('🌐 Chain', 'chain'), btn('📉 Slippage', 'setslip'), btn('⛽ Gas', 'setgas')],
      [btn(`⚡ Buy amounts`, 'setbp')],
      [btn(`${s.confirmBuy ? '🔴 Confirm buy OFF' : '🟢 Confirm buy ON'}`, 'cbtog'), btn(`${s.expert ? '🔴 Fast mode OFF' : '🟢 Fast mode ON'}`, 'extog')],
      [btn(s.autoBuy ? '🔴 Auto-buy OFF' : '🟢 Auto-buy ON', 'abtog'), btn('✏️ Auto-buy amount', 'abamt')],
      [btn(core.perWalletReceipts(u) ? '📋 Receipts: combined' : '📩 Receipts: per wallet', 'rstog')],
      [btn('🎯 Auto-exit (TP/SL)', 'aex'), btn(`${s.autoProtect ? '🔴 Rug guard OFF' : '🛡 Rug guard ON'}`, 'aptog')],
      [btn('🔐 Security', 'usec'), btn('🔔 Notifications', 'ntf')],
      [btn(i18n.t(core.getLang(chatId), 'lang.button') + ` · ${i18n.LANG_LABEL[core.getLang(chatId)]}`, 'lang')],
      [btn('❔ Help', 'help'), btn('« Menu', 'menu')],
    ),
  };
}
// Language picker. The setting itself has always been in the store — this is the
// screen that finally lets a user reach it.
function langScreen(chatId) {
  const cur = core.getLang(chatId);
  return {
    text: T(chatId, 'lang.screen', { current: i18n.LANG_LABEL[cur] || cur }),
    kb: rows(
      ...i18n.LANGS.map((l) => [btn((l === cur ? '✅ ' : '') + i18n.LANG_LABEL[l], 'setlang:' + l)]),
      [btn(T(chatId, 'lang.back'), 'set')],
    ),
  };
}
// Gas priority: a small multiplier on the gas price the bot pays. Higher = faster
// confirmations, marginally higher network fee (tiny on the Robinhood L2).
function gasLabel(n) { return n >= 3 ? 'Turbo (≈3× gas)' : (n === 2 ? 'Fast (≈2× gas)' : 'Normal'); }
function gasScreen(chatId) {
  const u = core.ensureUser(chatId);
  const g = core.userGasBoost(u);
  const mark = (n) => (g === n ? '✅ ' : '');
  return {
    text: `⛽ <b>Gas priority</b>\n\n` +
      `This sets how much gas the bot pays to get your <b>buys and sells mined</b>. Higher priority confirms faster when the chain is busy — the extra fee is tiny on Robinhood Chain.\n\n` +
      `Current: <b>${esc(gasLabel(g))}</b>\n\n` +
      `🟢 <b>Normal</b> — standard speed, lowest fee. Best for calm markets.\n` +
      `⚡ <b>Fast</b> — about 2× gas. Gets you in quicker during busy moments.\n` +
      `🚀 <b>Turbo</b> — about 3× gas. For fast-moving launches where every second counts.\n\n` +
      `<i>You don't have to touch this — if a sell ever fails on gas, the bot already auto-retries with higher gas and wider slippage. This just sets your starting level.</i>`,
    kb: rows(
      [btn(`${mark(1)}🟢 Normal`, 'gasset:1'), btn(`${mark(2)}⚡ Fast`, 'gasset:2'), btn(`${mark(3)}🚀 Turbo`, 'gasset:3')],
      [btn('« Settings', 'set')],
    ),
  };
}
// Withdrawal protections: vault lock, per-chain whitelist, rate limit. Guards a hijacked
// Telegram account from instantly draining funds.
function securityScreen(chatId) {
  const u = core.ensureUser(chatId);
  const sec = core.getSecurity(chatId);
  const ch = core.chainOf(core.userChain(u));
  const wl = (sec.whitelist || []);
  const wlChain = wl.filter((w) => w.chain === ch.key);
  let body = `🔐 <b>Security</b>\n\n` +
    `Withdraw vault lock: <b>${sec.withdrawLock ? '🔒 ON (all withdrawals blocked)' : '🔓 OFF'}</b>\n` +
    `Withdraw rate limit: <b>${core.MAX_WD_PER_HOUR}/hour</b>\n\n` +
    `<b>Withdraw whitelist</b> · ${ch.emoji} ${esc(ch.name)}\n`;
  if (!wl.length) body += `<i>Empty — withdrawals are allowed to ANY address. Add addresses to restrict withdrawals to only them.</i>\n`;
  else if (!wlChain.length) body += `<i>None for ${esc(ch.name)} yet (you have ${wl.length} on other chains). With none set here, withdrawals on ${esc(ch.name)} go to any address.</i>\n`;
  else { body += wlChain.map((w) => `• <code>${esc(w.address)}</code>`).join('\n') + `\n<i>Only these addresses can receive ${esc(ch.name)} withdrawals.</i>\n`; }
  const kbRows = [
    [btn(sec.withdrawLock ? '🔓 Unlock withdrawals' : '🔒 Lock withdrawals (vault)', 'usectog')],
    [btn('➕ Add whitelist address', 'uwladd')],
  ];
  for (const w of wlChain) kbRows.push([btn('🗑 ' + short(w.address), 'uwlrm:' + w.id)]);
  kbRows.push([btn('🌐 Chain', 'chain'), btn('« Settings', 'set')]);
  return { text: body + `\n<i>Whitelist is per chain — switch with 🌐 to manage another chain. The bot NEVER shares keys; withdrawals always need your explicit action.</i>`, kb: { inline_keyboard: kbRows } };
}
function notifyScreen(chatId) {
  const u = core.ensureUser(chatId);
  const n = (u.settings && u.settings.notify) || {};
  const on = (t) => (n[t] === undefined ? true : !!n[t]);
  const row = (t, label) => [btn(`${on(t) ? '🟢' : '⚪'} ${label}`, `ntftog:${t}`)];
  return {
    text: `🔔 <b>Notifications</b>\n\nChoose which automatic DMs you get. Your own limit/TP/SL order fills always notify.`,
    kb: {
      inline_keyboard: [
        row('snipe', 'Snipe fills'),
        row('copy', 'Copy-trade fills'),
        row('alerts', 'Price alerts'),
        [btn('« Settings', 'set'), btn('« Menu', 'menu')],
      ],
    },
  };
}
async function safetyScreen(chatId, ca, chainKey) {
  const ch = core.chainOf(chainKey) || core.chainOf(core.userChain(core.ensureUser(chatId)));
  const back = rows([btn('« Menu', 'menu')]);
  if (!safety.supported(chainKey)) {
    return { text: `🛡 <b>Token safety</b> — not available on ${ch.emoji} ${esc(ch.name)}.\n\nLaunchpad tokens on Robinhood Chain are fair-launch by design: fixed supply, no tax, and LP is 100% burned at graduation.`, kb: back };
  }
  const s = await safety.tokenSecurity(chainKey, ca).catch(() => null);
  if (!s) return { text: `🛡 <b>Token safety</b>\n\nCouldn't fetch security data right now (or the token isn't indexed yet). Trade carefully.`, kb: rows([btn('🔄 Retry', `sec:${chainKey}:${ca}`), btn('« Menu', 'menu')]) };
  const v = safety.verdict(chainKey, s);
  const banner = v.level === 'danger' ? '🚨 <b>HIGH RISK</b>' : v.level === 'warn' ? '⚠️ <b>CAUTION</b>' : '✅ <b>No major red flags</b>';
  const yn = (bad) => (bad ? '🔴' : '🟢');
  const svm = core.chains.isSvm(chainKey);
  let body, src;
  if (svm) {
    // RugCheck (Solana): authorities, LP lock, holder concentration, "rugged".
    src = 'RugCheck';
    body =
      `${yn(s.freezeAuthorityEnabled)} Freeze authority: <b>${s.freezeAuthorityEnabled ? 'ACTIVE 🚩' : 'revoked'}</b>\n` +
      `${yn(s.mintAuthorityEnabled)} Mint authority: <b>${s.mintAuthorityEnabled ? 'active' : 'revoked'}</b>\n` +
      `${yn(s.rugged)} Rugged flag: <b>${s.rugged ? 'YES' : 'no'}</b>\n`;
    if (s.lpLockedPct != null) body += `${yn(s.lpLockedPct < 50)} LP locked/burned: <b>${Math.round(s.lpLockedPct)}%</b>\n`;
    if (s.topHolderPct != null) body += `${yn(s.topHolderPct >= 20)} Top holder: <b>${s.topHolderPct.toFixed(1)}%</b>${s.top10Pct != null ? ` · top-10 <b>${s.top10Pct.toFixed(0)}%</b>` : ''}\n`;
    if (s.totalHolders != null) body += `Holders: <b>${s.totalHolders}</b>\n`;
    if (s.liquidityUsd != null) body += `Liquidity: <b>$${fmt(s.liquidityUsd)}</b>\n`;
    if (s.scoreNorm != null) body += `RugCheck score: <b>${Math.round(s.scoreNorm)}/100</b> <i>(lower is safer)</i>\n`;
  } else {
    // GoPlus (EVM): tax, honeypot, mintable, owner footguns, LP lock.
    src = 'GoPlus';
    const tax = (t) => (t == null ? '?' : (Math.round(t * 10) / 10) + '%');
    body =
      `${yn((s.buyTaxPct || 0) > 10)} Buy tax: <b>${tax(s.buyTaxPct)}</b>  ·  ${yn((s.sellTaxPct || 0) > 10)} Sell tax: <b>${tax(s.sellTaxPct)}</b>\n` +
      `${yn(s.honeypot)} Honeypot: <b>${s.honeypot ? 'YES' : 'no'}</b>  ·  ${yn(s.cannotSellAll)} Can sell all: <b>${s.cannotSellAll ? 'NO' : 'yes'}</b>\n` +
      `${yn(s.mintable)} Mintable: <b>${s.mintable ? 'yes' : 'no'}</b>  ·  ${yn(s.ownerChangeBalance)} Owner edits balances: <b>${s.ownerChangeBalance ? 'yes' : 'no'}</b>\n` +
      `${yn(s.openSource === false)} Open-source: <b>${s.openSource === false ? 'no' : 'yes'}</b>  ·  ${yn(s.proxy)} Proxy: <b>${s.proxy ? 'yes' : 'no'}</b>\n`;
    if (s.lpLockedPct != null) body += `${yn(s.lpLockedPct < 50)} LP locked/burned: <b>${Math.round(s.lpLockedPct)}%</b>\n`;
    if (s.holders != null) body += `Holders: <b>${s.holders}</b>\n`;
  }
  if (v.red.length) body += `\n🔴 <b>${esc(v.red.join(', '))}</b>`;
  else if (v.warn.length) body += `\n⚠️ ${esc(v.warn.join(', '))}`;
  return {
    text: `🛡 <b>Token safety</b> · ${ch.emoji} ${esc(ch.name)}  ${s.symbol ? '· $' + esc(s.symbol) : ''}\n${banner}\n\n${body}\n\n<i>Source: ${src}. Not financial advice — always DYOR.</i>`,
    kb: rows([btn('🔄 Recheck', `sec:${chainKey}:${ca}`), btn('« Menu', 'menu')]),
  };
}

// ------------------------------------------------------------ actions
// 1-based index of a wallet (default active) — used to re-encode the card action.
function walletIndex(chatId, walletId) {
  const u = core.getUser(chatId); if (!u) return 1;
  const id = walletId || (core.activeWallet(u) || {}).id;
  const i = core.walletList(u).findIndex((w) => w.id === id);
  return i >= 0 ? i + 1 : 1;
}
// Human label for the wallet a trade will use (e.g. "Wallet 1") — in-memory, no network.
function walletLabelFor(chatId, walletId) {
  try { const u = core.getUser(chatId) || core.ensureUser(chatId); const w = (walletId && core.walletById(u, walletId)) || core.activeWallet(u); return core.walletLabel(w, walletIndex(chatId, w && w.id)); }
  catch (_) { return 'your wallet'; }
}
// The token's symbol from the user's stored position, if any — instant (no RPC), so the
// "selling…" progress note can name the coin without adding latency to the trade.
function quickSym(chatId, ca, chainKey, walletId) {
  try { const u = core.getUser(chatId); const w = (walletId && core.walletById(u, walletId)) || core.activeWallet(u); const p = w && (w.positions || {})[core.posKey(chainKey || core.userChain(u), ca)]; return (p && p.sym) || ''; }
  catch (_) { return ''; }
}
// Which wallets a Buy/Sell tap acts on: the explicit multi-selection if the user set
// one (👛 picker on the card), otherwise the card's single bound wallet. Returns
// [{id,index,label}] in wallet order.
function tradeTargets(chatId, cardWalletId) {
  const u = core.ensureUser(chatId);
  const list = core.walletList(u);
  const ids = core.tradeWalletIds(chatId);
  const pick = ids.length ? ids : [cardWalletId || (core.activeWallet(u) || {}).id].filter(Boolean);
  return pick.map((id) => { const i = list.findIndex((w) => w.id === id); return i >= 0 ? { id, index: i + 1, label: core.walletLabel(list[i], i + 1) } : null; }).filter(Boolean);
}
// Entry point for a buy from a tap/command. If the user enabled "Confirm before buy",
// show a Yes/No confirmation first; otherwise execute immediately. (Auto-buy-on-paste
// is deliberately instant and bypasses this.)
let _confirmSeq = 0;
async function requestBuy(chatId, ca, amt, chain, walletId) {
  const u = core.ensureUser(chatId);
  if (u.settings && u.settings.confirmBuy) {
    const ch = core.chainOf(chain) || core.chainOf(core.userChain(u));
    const targets = tradeTargets(chatId, walletId);
    // Bind the confirm to a fresh id so tapping a STALE confirm card (whose pending
    // was overwritten by a newer buy) can't execute the wrong token/amount/wallet.
    const cid = (_confirmSeq = (_confirmSeq + 1) % 1000000).toString(36);
    setPending(chatId, { action: 'confirm_buy', ca, amt: String(amt), chain, walletId, confirmId: cid });
    const who = targets.length > 1
      ? `on <b>${targets.length} wallets</b> (${targets.map((t) => esc(t.label)).join(', ')}) — total <b>${esc(String(+(Number(amt) * targets.length).toFixed(6)))} ${ch.native}</b>`
      : `with <b>${esc(targets[0] ? targets[0].label : 'your wallet')}</b>`;
    return send(chatId, `🟢 <b>Confirm buy</b>\n\nBuy <b>${esc(String(amt))} ${ch.native}</b> of <code>${short(ca)}</code> ${who}?`, rows([btn('✅ Confirm', 'bcok:' + cid), btn('✖ Cancel', 'bccancel:' + cid)]));
  }
  return doBuy(chatId, ca, amt, chain, walletId);
}
// Blocks a CONCURRENT buy of the SAME (user, chain, token) — a rapid double-tap (or
// double-paste) fires two handlers; the second sees the key in-flight and is dropped,
// so one intended tap can't spend twice. A deliberate second buy after the first lands
// is fine (the key is released on completion).
const _inflightBuy = new Set();
// After a buy, auto-place the user's take-profit / stop-loss (⚙️ Settings) relative to
// the entry price, on the wallet that just bought. Best-effort — never breaks the buy.
// Places the user's auto TP/SL (⚙️ Settings) on the wallet that just bought, and RETURNS
// a short line to fold into the buy receipt (so it isn't a separate message). Best-effort.
async function _placeAutoExit(chatId, r, walletId) {
  try {
    const u = core.getUser(chatId); const s = u && u.settings;
    if (!s || (!(s.autoTpPct > 0) && !(s.autoSlPct > 0))) return '';
    const got = Number(r.gotTokens) || 0, spent = Number(r.spentEth) || 0;
    if (!(got > 0) || !(spent > 0)) return '';
    const entry = spent / got;   // native price per token at entry
    const msgs = [];
    if (s.autoTpPct > 0) { watchers.addOrder(chatId, { type: 'tp', ca: r.ca, sym: r.sym, chain: r.chain, targetPriceEth: entry * (1 + s.autoTpPct / 100), sellPct: 100, auto: true }, walletId); msgs.push(`TP +${s.autoTpPct}%`); }
    if (s.autoSlPct > 0) { watchers.addOrder(chatId, { type: 'sl', ca: r.ca, sym: r.sym, chain: r.chain, targetPriceEth: entry * (1 - s.autoSlPct / 100), sellPct: 100, auto: true }, walletId); msgs.push(`SL −${s.autoSlPct}%`); }
    return msgs.length ? `\nAuto-exit: <b>${msgs.join(' · ')}</b>` : '';
  } catch (_) { return ''; }   /* order cap reached or unpriceable — skip silently */
}
// Price impact for the size being bought — INFORMATION, never a gate (operator
// rule: the user must always be able to buy). Returns "" when it cannot be
// measured, and it is never awaited ahead of the trade.
//
// V2 only: a V2 pair's WETH balance IS its depth, so spend/(reserve+spend) is
// the real impact. A V3 pool's balance is NOT — its liquidity is concentrated,
// so a pool holding 0.8 ETH can fill a 0.05 ETH buy at almost no impact.
// Running the constant-product formula over one invented an 11% figure and
// refused a trade Maestro filled.
// How long the "Buying…" line waits for a market cap before going out without
// one. The trade is already in flight by then, so this is never execution
// latency — only how long the user stares at a message with a blank in it.
const ENTRY_MC_WAIT_MS = 1200;
// The same idea for a per-wallet receipt, but tighter: the trade is not only in
// flight by then, it has FINISHED, and the user is waiting on the one message
// that says so. Long enough to catch a read that is nearly home, short enough
// that a dead indexer is never felt.
const RECEIPT_MC_WAIT_MS = 600;

async function impactNote(ca, chG, amt) {
  if (core.chains.isSvm(chG.key)) return '';
  try {
    const pick = await withTmo(core.bestDexVenue(ca, chG.key).catch(() => null), 6000, null);
    if (!pick || pick.kind === 'v3' || pick.wethBal == null) return '';
    const reserve = Number(ethers.formatEther(pick.wethBal));
    const amtN = Number(amt) || 0;
    const impact = reserve > 0 ? (amtN / (reserve + amtN)) * 100 : 0;
    return impact >= 5 ? `\n⚠️ Thin pool — this size moved the price ~<b>${impact.toFixed(0)}%</b>.` : '';
  } catch (_) {
    return '';   // an unreadable pool is not a reason to say anything
  }
}

/**
 * Post ONE wallet's receipt for a multi-wallet trade.
 *
 * Everything user-controlled is escaped HERE, once, so receipt.js stays a pure
 * assembler that adds no escaping — the same contract i18n.js keeps, and the
 * reason a token whose name contains "<b>" cannot break the message.
 *
 * `seen` is read, never awaited: it is a live box that the token-meta and
 * market-snapshot lookups fill in as they arrive. A receipt that waited for
 * them would be a receipt held behind an indexer, which is exactly what the
 * per-wallet rewrite exists to stop.
 *
 * Never throws. A receipt that fails to render must not take down the trade
 * loop that is still reporting the other wallets.
 */
async function _postWalletReceipt(chatId, { side, ca, chainKey, target, r, e, seen }) {
  try {
    const ch = core.chainOf(chainKey) || {};
    // A SHORT wait for the identity and market reads, and in practice only for
    // the FIRST receipt.
    //
    // Both run alongside the trade, so by the time a wallet settles they have
    // normally landed and this resolves instantly. But a fill can beat them on
    // a fast chain, and then the first receipt prints as "$PONS" with no market
    // cap while the other four say "Pons ($PONS) … Entry MC $27.20M" — the same
    // trade reported two ways, which reads as a bug in the numbers rather than
    // as a race. One shared budget for both, so a hung indexer can never hold a
    // receipt longer than this.
    if (seen && (!seen.meta || !seen.entry)) {
      const pend = [seen.metaP, seen.entryP].filter(Boolean).map((p) => p.catch(() => null));
      if (pend.length) await Promise.race([Promise.all(pend), new Promise((res) => setTimeout(res, RECEIPT_MC_WAIT_MS))]);
    }
    const meta = (seen && seen.meta) || null;
    const snap = (seen && seen.entry) || null;
    const sym = (r && r.sym) || (meta && meta.sym) || (snap && snap.sym) || '';
    const native = (r && r.native) || ch.native || '';
    const rate = nativeUsd(native);
    const mcUsd = snap ? (snap.mcapUsd || (snap.mcapEth || 0) * rate) : 0;
    // A sell that found an empty wallet is NOT a failure — see the copy note on
    // 'wallet.receipt.nobag'. The engine says so with this one message, and
    // i18n.errorKey is not involved because there is nothing to explain.
    const noBag = !!e && /token balance is 0/i.test(String((e && (e.message || e)) || ''));
    // The fill's share of total supply — a cached read, BOUNDED so it can
    // never hold a receipt, and null (no line) when the supply is unknown.
    // On an EVM chain with no decimals on file it stays null: a guessed 18
    // would state a share off by orders of magnitude.
    const tokTot = side === 'sell' ? Number(r && r.soldTokens) : Number(r && r.gotTokens);
    // `r.dec` is set by every successful trade result, so the EVM share does
    // not depend on the meta race the receipt is already only WAITING on.
    const supUi = tokTot > 0
      ? await withTmo(core.tokenSupplyUi(ca, chainKey,
        (r && Number.isFinite(r.dec)) ? r.dec : (meta ? meta.decimals : null)).catch(() => null), 1200, null)
      : null;
    const text = receipt.walletReceipt((k, v) => T(chatId, k, v), {
      side,
      ok: !e,
      noBag,
      name: esc((meta && meta.name) || (snap && snap.name) || ''),
      sym: esc(sym),
      ca: esc(ca),
      chainEmoji: ch.emoji || '',
      chainName: esc(ch.name || ''),
      wallet: esc(target.label),
      // On a sell the bot's cut is a separate transfer, so `netEth` is what the
      // user actually kept and `proceedsEth` is not. Same choice the combined
      // receipt makes.
      tokens: tokTot,
      supplyPct: supUi > 0 && tokTot > 0 ? (tokTot / supUi) * 100 : null,
      amount: side === 'sell' ? Number(r && (r.netEth != null ? r.netEth : r.proceedsEth)) : Number(r && r.spentEth),
      native: esc(native),
      rate,
      pnl: side === 'sell' && r ? Number(r.realizedEth) : null,
      mcUsd,
      reason: e ? friendlyError(chatId, e, side) : '',
    });
    const wi = walletIndex(chatId, target.id);
    const explorer = ch.explorer;
    const kb = (!e && r && r.hash && explorer)
      ? rows([{ text: T(chatId, 'wallet.receipt.tx'), url: `${explorer}/tx/${r.hash}` },
        side === 'sell' ? btn('📊 Portfolio', 'pos') : btn('📍 Monitor', `monn:${chainKey}:${wi}:${ca}`)])
      // No transaction, no transaction button. A link on a row that never
      // traded is worse than no link: it is a receipt for something that did
      // not happen.
      : rows([btn('🔄 Card', `tok:${chainKey}:${wi}:${ca}`)]);
    return await send(chatId, text, kb);
  } catch (err) {
    console.error('wallet receipt failed:', err && (err.message || err));
    return null;
  }
}

async function doBuy(chatId, ca, amt, chain, walletId) {
  invalidateCard(chatId, ca, chain);   // the bag is about to move — no toggle may redraw the old one
  const u = core.ensureUser(chatId);
  const chG = core.chainOf(chain) || core.chainOf(core.userChain(u));
  const key = chatId + ':' + (chain || core.userChain(u)) + ':' + String(ca).toLowerCase();
  if (_inflightBuy.has(key)) return send(chatId, T(chatId, 'buy.inflight'));
  _inflightBuy.add(key);
  const expert = u.settings.expert;
  const targets = tradeTargets(chatId, walletId);
  try {
    if (targets.length <= 1) {
      const wid = targets[0] ? targets[0].id : walletId;
      // SPEED: the trade starts on the very first line of this block. Nothing
      // is awaited before it — not the "Buying…" message, not the depth probe.
      //
      // Those two used to run in series ahead of the buy: a bestDexVenue call
      // with a 6s timeout, purely to compute a warning line, and then a
      // Telegram round-trip for the progress message. Up to ~6.5s of the user's
      // latency was spent before a single on-chain call, on a bot competing
      // with one that fills immediately.
      //
      // Now the buy, the progress message and the depth probe are all in
      // flight at once, and the probe's result is folded into the receipt if it
      // arrives in time. Nothing about the trade waits on either of them.
      // The progress message is upgraded to a live explorer link the moment the
      // transaction is broadcast, instead of sitting on "Buying…" until the
      // receipt lands. On Ethereum that wait is a full 12s block; the trade is
      // already irreversible by then, so there is nothing to gain by hiding it.
      let progressId = null, sentSeen = null, settled = false;
      const onSent = (hash) => {
        sentSeen = hash;
        if (!progressId || settled) return;   // no message yet, or the receipt already won
        edit(chatId, progressId, T(chatId, 'buy.sent', { amt: esc(amt), native: chG.native, link: txLink(chain || core.userChain(u), hash) })).catch(() => {});
      };
      const buying = core.buy(chatId, ca, amt, chain, wid, { onSent });
      const impactP = impactNote(ca, chG, amt);
      // Entry snapshot, started WITH the trade. The buy is already in flight, so
      // the short wait below costs execution nothing — it only decides whether
      // the "Buying…" line can name the market cap being entered at. "At what
      // MC did I get in" is the first thing anyone asks, and afterwards it can
      // only be reconstructed.
      const entryP = withTmo(core.tokenSnapshot(ca, chG.key).catch(() => null), 6000, null);
      const entry = await Promise.race([entryP, new Promise((res) => setTimeout(res, ENTRY_MC_WAIT_MS, null))]);
      const eRate = nativeUsd(chG.native);
      const eMc = entry ? (entry.mcapUsd || (entry.mcapEth || 0) * eRate) : 0;
      const atMc = eMc > 0 ? T(chatId, 'buy.at_mc', { mc: fmt(eMc) }) : '';
      const progress = expert ? null : await send(chatId, T(chatId, 'buy.progress', { amt: esc(amt), native: chG.native, atMc }));
      progressId = progress && progress.ok && progress.result && progress.result.message_id;
      // The broadcast can beat the progress message out of the door; if it did,
      // apply the upgrade now rather than losing it.
      if (progressId && sentSeen) onSent(sentSeen);
      const r = await buying;
      // On a 250ms-block chain the fill can land while the "sent" edit is still
      // in flight to Telegram. Without this the late edit would overwrite the
      // receipt and the user would watch a completed buy turn back into
      // "waiting for confirmation".
      settled = true;
      const wi = walletIndex(chatId, wid);
      const usdRate = nativeUsd(r.native);
      const spent = Number(r.spentEth) || 0, got = Number(r.gotTokens) || 0;
      const usd2 = (v) => (usdRate > 0 ? `$${(v * usdRate).toFixed(2)}` : '—');
      const uu = core.getUser(chatId);
      const wl = core.walletLabel((uu && core.walletById(uu, wid)) || core.activeWallet(uu), wi);
      let holdUsd = usdRate > 0 && spent > 0 ? usd2(spent) : '—';
      let statLine = '';
      try {
        // The snapshot started with the trade — reuse it rather than fetching a
        // second time. It is the market REFERENCE for this fill: taken as the buy
        // went out, not seconds after it landed.
        const snap = await entryP;
        // ENTRY IS WHAT YOU PAID. This line printed `snap.priceEth` — the price on
        // the card — under the label "Entry", and then startMonitor opened a card
        // whose P/L is measured against the real basis. A buy that filled 10.4%
        // above mid therefore produced a receipt claiming entry $0.0000524 and,
        // one message later, "Price $0.0000523 · P/L −9.48%". Both numbers true,
        // the pair of them impossible. See receipt.js `fillStats`.
        //
        // The multi-wallet receipt has divided these two figures since the
        // per-wallet rewrite; the SINGLE-wallet path — much the commonest — never
        // did, so the one shape most users see was the one that hid it.
        const fstat = receipt.fillStats({ spent, tokens: got, refPxNative: snap && snap.priceEth, rate: usdRate });
        if (snap && snap.priceEth > 0 && usdRate > 0 && got > 0) holdUsd = `$${(got * snap.priceEth * usdRate).toFixed(2)}`;
        const mcUsd = snap ? (snap.mcapUsd || ((snap.mcapEth || 0) * usdRate)) : 0;
        const mcTail = mcUsd > 0 ? ` · MC <b>$${fmt(mcUsd)}</b>` : '';
        if (fstat.realPx != null) statLine = '\n' + T(chatId, 'buy.receipt.entry', { px: fstat.realPx }) + mcTail;
        else if (mcUsd > 0) statLine = '\n' + T(chatId, 'buy.receipt.entry_mc', { mc: fmt(mcUsd) });
        // The bot's own cut, named. It is taken before the swap, so "Spent
        // 0.099000" for a 0.1 SOL action is the smaller of two true numbers and
        // the difference had nowhere to appear. Only when it is actually charged.
        if (Number(r.feeEth) > 0) {
          statLine += '\n' + T(chatId, 'buy.receipt.fee', {
            amt: Number(r.feeEth).toFixed(6), native: r.native, pct: (core.CFG.feeBps / 100).toFixed(2).replace(/\.?0+$/, ''),
          });
        }
        // Only when the gap is real. Below ~2% it is ordinary pool fee and noise,
        // and a warning on every receipt is a warning nobody reads — the same rule
        // the 1.15x escalation already follows.
        if (fstat.offBy > 1.02 && fstat.refPx != null) {
          statLine += '\n' + T(chatId, 'buy.receipt.vs_card', {
            shown: fstat.refPx, pct: fstat.overPct.toFixed(1), down: fstat.downPct.toFixed(1),
          }) + (fstat.offBy > 1.15 ? ' ' + T(chatId, 'buy.receipt.worse_than_shown', { times: fstat.offBy.toFixed(1) }) : '');
        }
        // WHY the fill cost what it did, when the router told us. Jupiter returns
        // a price impact on every quote and nothing had ever read it, so "thin
        // pool" and "our price feed disagrees with the router" — two problems with
        // different answers — arrived as the same shrug. impactNote() covers the
        // EVM side and cannot see Solana at all.
        if (Number(r.impactPct) >= 1) statLine += '\n' + T(chatId, 'buy.receipt.impact', { pct: Number(r.impactPct).toFixed(1) });
        // Quote promised, wallet received less: the only signal a Token-2022
        // transfer fee ever gives, and it was console.warn'd where no user is.
        if (Number(r.shortfall) > 0.01) statLine += '\n' + T(chatId, 'buy.receipt.shortfall', { pct: (Number(r.shortfall) * 100).toFixed(1) });
      } catch (_) {}
      const exp2 = core.chainOf(r.chain);
      /*
       * ⚠️ A DISCOVERED CURVE IS NOT THE SAME VENUE AS A KNOWN ONE, and the
       * receipt has to say so. The route was read off the pad's own trades and
       * checked against an independent price; a user comparing this fill
       * against an explorer is owed the difference between "we routed through a
       * DEX" and "we read this curve ourselves". The same rule as the site's
       * `via DexScreener` chip.
       *
       * `startsWith('curve')` rather than a third `===`: the two curve venues
       * are the same thing to a reader, and a fourth spelling must not silently
       * fall through to "DEX".
       */
      const venue = String(r.venue || '').startsWith('curve')
        ? (r.curveVia ? `Launchpad curve (read from its own trades, checked against ${r.curveVia.weak ? 'recent fills' : 'the launchpad price'})` : 'Launchpad')
        : (r.venue === 'dex·v3' ? 'DEX (V3)' : 'DEX');
      const autoLine = await _placeAutoExit(chatId, r, wid);
      const receipt =
        T(chatId, 'buy.receipt.title', { sym: esc(r.sym) }) + '\n' +
        T(chatId, 'buy.receipt.spent', { amt: spent.toFixed(6), native: r.native, usd: usd2(spent) }) + '\n' +
        T(chatId, 'buy.receipt.got', { amt: fmt(got), sym: esc(r.sym), usd: holdUsd }) +
        statLine + '\n' +
        T(chatId, 'buy.receipt.wallet', { wallet: esc(wl), venue }) + autoLine;
      const kb = { inline_keyboard: [
        [{ text: '🔍 Tx', url: `${exp2.explorer}/tx/${r.hash}` }, btn('📍 Monitor', `monn:${r.chain}:${wi}:${ca}`)],
        [btn('🔄 Card', `tok:${r.chain}:${wi}:${ca}`), btn('📊 Portfolio', 'pos')],
      ] };
      // The probe ran alongside the trade; whatever it found is a footnote on
      // the receipt now, and never cost the trade a millisecond.
      const note = await impactP.catch(() => '');
      const pid = progress && progress.ok && progress.result && progress.result.message_id;
      if (pid) await edit(chatId, pid, receipt + note, kb); else await send(chatId, receipt + note, kb);
      // Straight into the live position — pinned, refreshing itself, closing on
      // exit. It already existed behind the 📍 button; making someone tap for it
      // after a buy is asking them to do the obvious thing by hand.
      startMonitor(chatId, ca, r.chain, wid, { surface: true }).catch(() => {});
    } else {
      // Same order as the single-wallet path: every buy is in flight before the
      // progress message is awaited.
      const perWallet = core.perWalletReceipts(u);
      // THE TRADES START ON THE FIRST LINE, exactly as on the single-wallet
      // path. The per-wallet reporting is attached a few lines below, after the
      // header has claimed its place in the send queue — attaching a `.then` to
      // a promise that is already running costs nothing and moves nothing.
      const raw = targets.map((t) => core.buy(chatId, ca, amt, chain, t.id));
      // The token's identity and the pre-fill market, read ALONGSIDE the trade.
      // `tokenMeta` answers from cache for any token whose card the user just
      // came from, so in practice both are there before the first fill.
      const seen = { meta: null, entry: null, metaP: null, entryP: null };
      seen.metaP = core.tokenMeta(ca, chG.key).then((m) => { seen.meta = m; return m; }).catch(() => null);
      // …and the entry snapshot too, which this branch simply did not have. The
      // whole ENTRY_MC_WAIT_MS machinery lived inside `if (targets.length <= 1)`,
      // so selecting a second wallet silently removed the market cap from every
      // message: the progress line, and the receipt. "At what MC did I get in"
      // was answerable on one wallet and unanswerable on five — and five wallets
      // is the case where it matters MOST, because the fills move the price and
      // the only cap ever printed was read afterwards, from a market the user's
      // own buys had already pushed.
      //
      // Started AFTER the fan-out and only raced, never blocking it — same rule
      // as the single path, for the same reason (see the latency note above).
      const entryPM = withTmo(core.tokenSnapshot(ca, chG.key).catch(() => null), 6000, null);
      seen.entryP = entryPM;
      entryPM.then((s) => { seen.entry = s; }).catch(() => {});
      const eRateM = nativeUsd(chG.native);
      // THE HEADER CLAIMS THE QUEUE FIRST, and this is the only reason it is
      // enqueued rather than simply awaited. A wallet that fills before
      // Telegram answers would otherwise have its receipt appear ABOVE the
      // "Buying on 4 wallets…" line for its own batch — which happens on a fast
      // chain and reads as a receipt from some earlier trade.
      const progressP = expert ? Promise.resolve(null) : queuedSend(chatId, async () => {
        const e0 = await Promise.race([entryPM, new Promise((res) => setTimeout(res, ENTRY_MC_WAIT_MS, null))]);
        const mc0 = e0 ? (e0.mcapUsd || (e0.mcapEth || 0) * eRateM) : 0;
        return send(chatId, T(chatId, 'buy.progress.multi', { amt: esc(amt), native: chG.native, n: targets.length, atMc: mc0 > 0 ? T(chatId, 'buy.at_mc', { mc: fmt(mc0) }) : '' }));
      });
      // ONE RECEIPT PER WALLET, POSTED AS THAT WALLET SETTLES.
      //
      // `await Promise.allSettled(...)` alone is what made a fast bot feel slow:
      // four wallets fill in two seconds, the fifth takes twenty, and the user
      // watches an empty chat for twenty seconds before the whole batch arrives
      // at once. The trades were always parallel; only the telling was serial.
      //
      // The tap reports each wallet the moment its own promise settles and then
      // re-throws, so allSettled still produces the identical aggregate for the
      // summary below. Queued per chat so five receipts do not race each other
      // into Telegram's flood limit — see queuedSend.
      const buys = Promise.allSettled(raw.map((p, i) => p.then(
        (r) => { if (perWallet) queuedSend(chatId, () => _postWalletReceipt(chatId, { side: 'buy', ca, chainKey: r.chain || chG.key, target: targets[i], r, seen })); return r; },
        (e) => { if (perWallet) queuedSend(chatId, () => _postWalletReceipt(chatId, { side: 'buy', ca, chainKey: chG.key, target: targets[i], e, seen })); throw e; },
      )));
      const [progress, results] = await Promise.all([progressP, buys]);
      // Whatever the pre-fill read produced by now — never awaited again. Every
      // wallet has settled and each receipt already gave it up to
      // RECEIPT_MC_WAIT_MS, so a null here means the indexer genuinely did not
      // answer, and the summary drops the line rather than waiting on it.
      const entryM = seen.entry;
      const eMcM = entryM ? (entryM.mcapUsd || (entryM.mcapEth || 0) * eRateM) : 0;
      let okN = 0, totTok = 0, totSpent = 0, totFee = 0, sym = '', chainKey = chain || core.userChain(u), nat = '', lines = [];
      const fails = [];
      results.forEach((res, i) => {
        const t = targets[i];
        if (res.status === 'fulfilled') { const r = res.value; okN++; totTok += Number(r.gotTokens) || 0; totSpent += Number(r.spentEth) || 0; totFee += Number(r.feeEth) || 0; sym = r.sym || sym; chainKey = r.chain || chainKey; nat = r.native || nat; lines.push(walletLine(t.label, r.chain, r, nativeUsd(r.native), { amount: r.spentEth, tokens: `${fmt(r.gotTokens)} $${esc(r.sym)}` })); _placeAutoExit(chatId, r, t.id).catch(() => {}); }
        else {
          const e = res.reason;
          // LOGGED, not only rendered.
          //
          // The catch at the bottom of doBuy is the ONLY place that ever wrote a
          // buy failure to the log, and it fires only when the whole block
          // throws. A per-wallet rejection lands here instead, gets turned
          // straight into a friendly sentence, and vanished — so a five-wallet
          // total failure left NOTHING on the server, which is the one place the
          // real reason could still be read. `grep 'buy failed'` came back empty
          // on a trade that had just failed five times.
          console.error(`buy failed [${t.label}] ${chG.key} ${ca}:`, (e && (e.message || e)));
          fails.push({ label: t.label, e });
          lines.push(`• <b>${esc(t.label)}</b> · ❌ ${esc(String((e && (e.message || e)) || 'failed').slice(0, 60))}`);
        }
      });
      const wi = walletIndex(chatId, targets[0].id);
      // `sym` and `nat` are only ever written by a wallet that FILLED, so when
      // none did they were '' — and the fallbacks were the literal 'ETH' and an
      // empty symbol. A user's card read "✅ Bought $ · 0/5 wallets · spent
      // 0.00000 ETH" on a Solana buy: wrong coin, no token, and a green tick
      // over five red errors. The chain being traded is known either way.
      const symShown = sym || (await tokenSym(ca, chainKey)) || short(ca);
      const natShown = nat || chG.native || 'ETH';
      const mUsd = nativeUsd(natShown);
      // Three outcomes, three headers. ✅ is a claim about what happened, so it
      // may only appear when every wallet actually filled — the receipt is the
      // only record of this trade the user gets, and a green tick over "0/5" is
      // worse than no receipt at all.
      const headKey = okN === 0 ? 'buy.receipt.multi.none' : okN < targets.length ? 'buy.receipt.multi.some' : 'buy.receipt.multi';
      const head = T(chatId, headKey, { sym: esc(symShown), ok: okN, n: targets.length, tokens: fmt(totTok), spent: totSpent.toFixed(5), native: esc(natShown), usd: mUsd > 0 ? ` ($${(totSpent * mUsd).toFixed(2)})` : '' });
      // Nothing filled → nothing to monitor and no card worth refreshing; what
      // the user needs is the way back to the token to try again.
      const kb = okN === 0
        ? rows([btn('🔄 Try again', `tok:${chainKey}:${wi}:${ca}`), btn('« Menu', 'menu')])
        : rows([btn('📍 Monitor', `monn:${chainKey}:${wi}:${ca}`), btn('🔄 Card', `tok:${chainKey}:${wi}:${ca}`), btn('📊 Portfolio', 'pos')]);
      const pid = progress && progress.ok && progress.result && progress.result.message_id;
      // The two questions a receipt leaves behind — what did it fill at, and
      // what is this worth now. Read after the trade, never before it. A trade
      // that did not happen has neither, and the market line under a failure
      // reads as a fill.
      const mkt = okN > 0 ? await marketLine(ca, chainKey) : '';
      // "Entered at" and "worth now" are DIFFERENT facts, and on five parallel
      // buys into one pool they differ by the user's own price impact — so the
      // post-trade read is wrong in a known direction as an entry. The pre-fill
      // snapshot above is the honest one; print it as its own labelled line
      // rather than letting `mkt` be mistaken for it.
      // Dropped in per-wallet mode: every receipt already carries its own entry
      // price and market cap, and a summary that repeats them is three lines
      // saying what five messages just said. `mkt` stays either way — "what is
      // it worth NOW" is the one question no receipt answers.
      const entryLine = (okN > 0 && eMcM > 0 && !perWallet)
        ? '\n' + T(chatId, 'buy.receipt.entry_mc', { mc: fmt(eMcM) })
        : '';
      // THE REALISED PRICE. `totSpent` and `totTok` have always sat on the same
      // receipt, one line apart, and nothing ever divided them — so a buy that
      // filled at 3x the price on the card printed both halves of the proof and
      // never the quotient. This is the number the user is actually holding.
      //
      // It is shown against the entry MC we read pre-fill, so a fill far from
      // the displayed market is visible AS a gap rather than as a number the
      // reader has to compare by hand.
      //
      // ONE OWNER of "how much worse than the card did this fill". This path and
      // the single-wallet receipt each grew their own arithmetic for it, and the
      // single-wallet one never grew it at all — which is exactly how the common
      // case ended up being the shape that hid the gap. receipt.fillStats is
      // pure and asserted directly; neither path may re-derive it.
      const fstatM = okN > 0
        ? receipt.fillStats({ spent: totSpent, tokens: totTok, refPxNative: entryM && entryM.priceEth, rate: mUsd })
        : receipt.fillStats({});
      const realLine = fstatM.realPx != null
        ? '\n' + T(chatId, 'buy.receipt.realised', { px: fstatM.realPx })
          // Only when it is genuinely off. A fill within a few percent of the
          // displayed price is the normal case and needs no commentary; the
          // warning has to stay rare or it stops being read.
          + (fstatM.offBy > 1.02 && fstatM.refPx != null
            ? '\n' + T(chatId, 'buy.receipt.vs_card', { shown: fstatM.refPx, pct: fstatM.overPct.toFixed(1), down: fstatM.downPct.toFixed(1) })
              + (fstatM.offBy > 1.15 ? ' ' + T(chatId, 'buy.receipt.worse_than_shown', { times: fstatM.offBy.toFixed(1) }) : '')
            : '')
        : '';
      // Every wallet failing the SAME way is ONE fact, not five. Five copies of
      // a raw engine string ("buy failed on Solana: fetch failed") is both the
      // spammiest and the least useful way to say "the aggregator is
      // unreachable" — so when nothing filled and every wallet gave the same
      // reason, it is said once, translated, in a sentence that ends in what to
      // do. Mixed reasons still get the per-wallet list: they are genuinely
      // different facts.
      const oneReason = okN === 0 && fails.length > 1
        && new Set(fails.map((f) => String((f.e && (f.e.message || f.e)) || ''))).size === 1;
      // In per-wallet mode every wallet has already reported itself, in its own
      // message, with its own transaction button. Repeating them as bullets
      // under the totals is the same information twice — so what stays is only
      // what NO single receipt can say: the totals, the average fill, and the
      // one-outage-said-once collapse.
      const body = oneReason
        ? `${friendlyError(chatId, fails[0].e, 'buy')}\n<i>${T(chatId, 'buy.receipt.multi.same', { wallets: esc(fails.map((f) => f.label).join(', ')) })}</i>`
        : (perWallet ? '' : lines.join('\n'));
      const txt = head + realLine + entryLine + (mkt ? '\n' + mkt : '') + (body ? '\n\n' + body : '');
      // Through the same queue as the receipts. With a progress message this is
      // an edit and its POSITION is already fixed at the head of the batch; in
      // fast mode there is no progress message and the summary is a fresh send,
      // which must land after the wallets it is summarising rather than in the
      // middle of them.
      await queuedSend(chatId, () => (pid ? edit(chatId, pid, txt, kb) : send(chatId, txt, kb)));
      // The multi-wallet branch never opened a monitor and its receipt had no 📍
      // button either, so anyone trading more than one wallet got a fill and
      // nothing to watch it with. Bound to the first wallet that actually
      // filled — the monitor is per token, and that is the one holding a bag.
      const filled = results.findIndex((res) => res.status === 'fulfilled');
      if (okN > 0) startMonitor(chatId, ca, chainKey, targets[filled >= 0 ? filled : 0].id, { surface: true }).catch(() => {});
    }
  } catch (e) { console.error('buy failed:', e && (e.message || e)); await send(chatId, `${T(chatId, 'buy.failed')}\n\n${friendlyError(chatId, e, 'buy')}`, rows([btn('🔄 Try again', `tok:${chain || core.userChain(u)}:${walletIndex(chatId, walletId)}:${ca}`), btn('« Menu', 'menu')])); }
  finally { _inflightBuy.delete(key); }
}
// Escalating sell: if a sell fails for a RETRIABLE reason (gas rejected by a
// base-fee tick, a too-tight quote/revert, an unconfirmed timeout), automatically
// re-try with higher gas and wider slippage so the exit still lands. Terminal
// errors (no balance, insufficient funds) are NOT retried. onStep notifies the UI.
const SELL_ESCALATION = [
  {},                                   // 1st: normal
  { gasMult: 2, slipAddBps: 500 },      // 2nd: 2× gas, +5% slippage
  { gasMult: 4, slipAddBps: 1500 },     // 3rd: 4× gas, +15% slippage
];
// A sell escalates gas and slippage and tries again. That only helps a trade the
// chain SAW, so a transport failure is explicitly not retriable: raising gas
// cannot make a name resolve, and the loop spent two extra rounds — each one
// telling the user "raising gas & slippage to complete the sell" — against a
// host that was never going to answer. i18n.errorKey stays the single owner of
// what an error IS; this only decides what to do about it.
const _retriable = (m) => i18n.errorKey(m) !== 'err.offline'
  && /max fee per gas|base fee|reverted|not confirmed|try again|could not (read|price)|coalesce|timeout|replacement|underpriced|nonce/i.test(String(m || ''));
// Turn a raw on-chain / RPC error into one clear sentence a non-technical user
// understands, IN THEIR LANGUAGE. The classification lives in i18n.errorKey so
// the regexes are shared by every locale and testable on their own; the original
// message is still logged server-side for the operator.
function friendlyError(chatId, raw, action) {
  return i18n.errorText(core.getLang(chatId), raw, action);
}
async function sellWithRetry(chatId, ca, pct, chain, wid, onStep, onSent) {
  let lastErr;
  for (let i = 0; i < SELL_ESCALATION.length; i++) {
    try { return await core.sell(chatId, ca, pct, chain, wid, { ...SELL_ESCALATION[i], onSent }); }
    catch (e) {
      lastErr = e; const msg = (e && (e.message || e)) || 'failed';
      if (i === SELL_ESCALATION.length - 1 || !_retriable(msg)) throw e;
      if (onStep) await onStep(i + 1, msg);
    }
  }
  throw lastErr;
}
async function doSell(chatId, ca, pct, chain, walletId) {
  invalidateCard(chatId, ca, chain);   // the bag is about to move — no toggle may redraw the old one
  const expert = core.ensureUser(chatId).settings.expert;
  const targets = tradeTargets(chatId, walletId);
  try {
    if (targets.length <= 1) {
      const wid = targets[0] ? targets[0].id : walletId;
      const sym0 = quickSym(chatId, ca, chain, wid);
      // The sell is in flight before the progress message is awaited — an exit
      // is the one trade where a round-trip of delay is felt most.
      let progress = null, progressId = null, sentSeen = null, settled = false;
      const onSent = (hash) => {
        sentSeen = hash;
        if (!progressId || settled) return;   // see the buy path: the receipt must win
        edit(chatId, progressId, T(chatId, 'sell.sent', { pct, link: txLink(chain || core.userChain(core.ensureUser(chatId)), hash) })).catch(() => {});
      };
      const selling = sellWithRetry(chatId, ca, pct, chain, wid, (n) =>
        (progress && progress.ok && progress.result)
          ? edit(chatId, progress.result.message_id, T(chatId, 'sell.retry', { n })).catch(() => {})
          : null, onSent);
      progress = expert ? null : await send(chatId, T(chatId, 'sell.progress', { pct, what: sym0 ? '$' + esc(sym0) : T(chatId, 'sell.your_token') }));
      progressId = progress && progress.ok && progress.result && progress.result.message_id;
      if (progressId && sentSeen) onSent(sentSeen);
      const r = await selling;
      settled = true;
      const wi = walletIndex(chatId, wid);
      const sUsd = nativeUsd(r.native);
      // NET, not gross. The bot's cut is a separate transfer on both chains, so
      // `proceedsEth` is money that passed through the wallet rather than money
      // the user kept — and this line is labelled "Received". The multi-wallet
      // receipt already made this distinction; the single-wallet one, which is
      // the path most trades take, did not.
      const got2 = Number(r.netEth != null ? r.netEth : r.proceedsEth) || 0;
      const sexp = core.chainOf(r.chain);
      const uu2 = core.getUser(chatId);
      const wl2 = core.walletLabel((uu2 && core.walletById(uu2, wid)) || core.activeWallet(uu2), wi);
      const svenue = String(r.venue || '').startsWith('curve')
        ? (r.curveVia ? `Launchpad curve (read from its own trades, checked against ${r.curveVia.weak ? 'recent fills' : 'the launchpad price'})` : 'Launchpad')
        : (r.venue === 'dex·v3' ? 'DEX (V3)' : 'DEX');
      const pnl = Number(r.realizedEth);   // profit/loss on this sell in native
      const pnlUsd = sUsd > 0 ? pnl * sUsd : null;
      const pnlLine = Number.isFinite(pnl) && pnl !== 0
        ? '\n' + T(chatId, 'sell.receipt.pnl', {
            pnl: `${pnl >= 0 ? '🟢 +' : '🔴 '}${pnl.toFixed(6)} ${r.native}`,
            usd: pnlUsd != null ? ` (${pnl >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)})` : '',
          })
        : '';
      const receipt =
        T(chatId, 'sell.receipt.title', { pct: r.soldPct, sym: esc((r.sym) || sym0 || '') }) + '\n' +
        T(chatId, 'sell.receipt.received', { amt: got2.toFixed(6), native: r.native, usd: sUsd > 0 ? ` ($${(got2 * sUsd).toFixed(2)})` : '' }) +
        pnlLine + '\n' +
        T(chatId, 'buy.receipt.wallet', { wallet: esc(wl2), venue: svenue });
      const kb = { inline_keyboard: [
        [{ text: '🔍 Tx', url: `${sexp.explorer}/tx/${r.hash}` }, btn('🔄 Card', `tok:${r.chain}:${wi}:${ca}`)],
        [btn('📊 Portfolio', 'pos')],
      ] };
      const pid = progress && progress.ok && progress.result && progress.result.message_id;
      if (pid) await edit(chatId, pid, receipt, kb); else await send(chatId, receipt, kb);
    } else {
      const perWallet = core.perWalletReceipts(core.ensureUser(chatId));
      const chS = core.chainOf(chain) || core.chainOf(core.userChain(core.ensureUser(chatId))) || {};
      // EVERY SELL IS IN FLIGHT BEFORE THE PROGRESS MESSAGE IS AWAITED. The buy
      // path was fixed for this long ago and the exit was left behind: the
      // fan-out sat after `await send(…)`, so every multi-wallet exit paid a
      // full Telegram round trip before a single sell was dispatched — on the
      // side where latency is felt most.
      const rawSells = targets.map((t) => sellWithRetry(chatId, ca, pct, chain, t.id));
      // Identity and the market AROUND the exit, read alongside the sells and
      // never awaited on a receipt's path — the same arrangement the buy branch
      // uses. The exit had no market-cap read at all before the fills; the only
      // one on the receipt came from `marketLine` afterwards, i.e. from a market
      // the user's own five sells had just pushed down.
      const seen = { meta: null, entry: null, metaP: null, entryP: null };
      seen.metaP = core.tokenMeta(ca, chS.key).then((m) => { seen.meta = m; return m; }).catch(() => null);
      seen.entryP = withTmo(core.tokenSnapshot(ca, chS.key).catch(() => null), 6000, null);
      seen.entryP.then((s) => { seen.entry = s; }).catch(() => {});
      // Queued before the taps can enqueue, so a wallet that exits before
      // Telegram answers cannot appear above the header for its own batch.
      const progressP = expert ? Promise.resolve(null) : queuedSend(chatId, () => send(chatId, T(chatId, 'sell.progress.multi', { pct, n: targets.length })));
      // One receipt per wallet, posted as that wallet settles. See the buy
      // branch for why the aggregate-only version read as a hang.
      const [progress, results] = await Promise.all([progressP, Promise.allSettled(rawSells.map((p, i) => p.then(
        (r) => { if (perWallet) queuedSend(chatId, () => _postWalletReceipt(chatId, { side: 'sell', ca, chainKey: r.chain || chS.key, target: targets[i], r, seen })); return r; },
        (e) => { if (perWallet) queuedSend(chatId, () => _postWalletReceipt(chatId, { side: 'sell', ca, chainKey: chS.key, target: targets[i], e, seen })); throw e; },
      )))]);
      let okN = 0, skip = 0, totProceeds = 0, totFee = 0, totPnl = 0, pnlSeen = false, chainKey = chain || core.userChain(core.ensureUser(chatId)), nat = '', lines = [];
      results.forEach((res, i) => {
        const t = targets[i];
        // netEth is the proceeds AFTER the bot's cut. On Solana that cut is a
        // separate transfer broadcast after the wallet delta is measured, so
        // proceedsEth — what this used to sum — is money the user never kept.
        if (res.status === 'fulfilled') { const r = res.value; okN++; const kept = Number(r.netEth != null ? r.netEth : r.proceedsEth) || 0; totProceeds += kept; totFee += Number(r.feeEth) || 0; totPnl += Number(r.realizedEth) || 0; pnlSeen = pnlSeen || Number.isFinite(Number(r.realizedEth)); chainKey = r.chain || chainKey; nat = r.native || nat; lines.push(walletLine(t.label, r.chain, r, nativeUsd(r.native), { amount: kept })); }
        else {
          const e = res.reason; const msg = String((e && (e.message || e)) || 'failed');
          if (/token balance is 0/i.test(msg)) { skip++; lines.push(`• <b>${esc(t.label)}</b> · ${T(chatId, 'sell.no_bag')}`); }
          else {
            // Same hole as the buy branch above: an empty wallet is expected and
            // stays quiet, but a real exit failure has to reach the log.
            console.error(`sell failed [${t.label}] ${chainKey} ${ca}:`, msg);
            lines.push(`• <b>${esc(t.label)}</b> · ❌ ${friendlyError(chatId, e, 'sell')}`);
          }
        }
      });
      const wi = walletIndex(chatId, targets[0].id);
      const msUsd = nativeUsd(nat || 'ETH');
      const head = T(chatId, 'sell.receipt.multi', { pct, ok: okN, n: targets.length, skip: skip ? T(chatId, 'sell.receipt.multi.skip', { n: skip }) : '', amt: totProceeds.toFixed(5), native: esc(nat || 'ETH'), usd: msUsd > 0 ? ` ($${(totProceeds * msUsd).toFixed(2)})` : '' });
      // The exit had no profit-or-loss line in ANY code path — not this one,
      // which never had a field for it, and not the single-wallet one, whose
      // r.realizedEth was NaN on Solana because _sellSol computed it, stored it
      // and left it out of what it returned. A user sold five wallets at −78%
      // and the receipt reported only a positive-looking "Total received".
      const pnlLineM = (okN > 0 && pnlSeen && totPnl !== 0)
        ? '\n' + T(chatId, 'sell.receipt.pnl', {
          pnl: `${totPnl > 0 ? '+' : '−'}${Math.abs(totPnl).toFixed(5)} ${esc(nat || 'ETH')}`,
          usd: msUsd > 0 ? ` (${totPnl > 0 ? '+' : '−'}$${Math.abs(totPnl * msUsd).toFixed(2)})` : '',
        })
        : '';
      const kb = rows([btn('🔄 Card', `tok:${chainKey}:${wi}:${ca}`), btn('📊 Portfolio', 'pos')]);
      // The two questions a receipt leaves behind — what did it fill at, and
      // what is this worth now. Read after the trade, never before it.
      const mkt = await marketLine(ca, chainKey);
      // Per-wallet mode: the wallets have already reported themselves, so the
      // summary keeps only the facts no single receipt carries.
      const txt = head + pnlLineM + (mkt ? '\n' + mkt : '') + (perWallet ? '' : '\n\n' + lines.join('\n'));
      const pid = progress && progress.ok && progress.result && progress.result.message_id;
      // Queued, for the same reason as the buy summary: in fast mode there is
      // no progress message to edit, and a fresh send must land after the
      // wallets it summarises.
      await queuedSend(chatId, () => (pid ? edit(chatId, pid, txt, kb) : send(chatId, txt, kb)));
    }
  } catch (e) { console.error('sell failed:', e && (e.message || e)); await send(chatId, `${T(chatId, 'sell.failed')}\n\n${friendlyError(chatId, e, 'sell')}`, rows([btn('🔄 Try again', `tok:${chain || core.userChain(core.ensureUser(chatId))}:${walletIndex(chatId, walletId)}:${ca}`), btn('« Menu', 'menu')])); }
}

// The group notice exists for ONE reader: someone who typed a command at the bot
// in a group. Everything else that arrives as `message` used to trigger it too —
// and in Telegram a member joining IS a message. The group filled with "please
// DM me privately" every time anyone walked in, from a bot nobody had addressed.
//
// So: service messages (joins, leaves, title/photo changes, pins) are silent,
// ordinary chatter is silent, and a command gets ONE answer per group per hour.
// Repeating it to a room that has already been told is the same spam in slow
// motion.
const GROUP_NOTICE_QUIET_MS = 60 * 60 * 1000;
const _groupNoticeAt = new Map();
function _shouldAnswerInGroup(msg, chatId) {
  if (!msg) return false;
  // A service message carries no text and no author intent — it is Telegram
  // narrating the room, not a person talking to the bot.
  const SERVICE = [
    'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo',
    'delete_chat_photo', 'group_chat_created', 'supergroup_chat_created',
    'channel_chat_created', 'message_auto_delete_timer_changed', 'migrate_to_chat_id',
    'migrate_from_chat_id', 'pinned_message', 'video_chat_started', 'video_chat_ended',
    'video_chat_participants_invited', 'video_chat_scheduled', 'forum_topic_created',
    'forum_topic_edited', 'forum_topic_closed', 'forum_topic_reopened', 'users_shared',
    'chat_shared', 'boost_added', 'giveaway_created', 'successful_payment',
  ];
  for (const k of SERVICE) if (msg[k] !== undefined) return false;
  const text = String(msg.text || msg.caption || '').trim();
  if (!text.startsWith('/')) return false;   // chatter is not addressed to us
  const now = Date.now();
  const last = _groupNoticeAt.get(chatId) || 0;
  if (now - last < GROUP_NOTICE_QUIET_MS) return false;
  _groupNoticeAt.set(chatId, now);
  if (_groupNoticeAt.size > 500) {           // bounded: a bot in many groups must not leak
    for (const [k, t] of _groupNoticeAt) if (now - t > GROUP_NOTICE_QUIET_MS) _groupNoticeAt.delete(k);
  }
  return true;
}

// ------------------------------------------------------------ router
async function handleUpdate(up) {
  // "respon sangat lambat" must be MEASURABLE, not argued from reading code.
  // `age` is how old the update already was when we first saw it (high age =
  // the delay happened BEFORE the bot: long-poll gap, restart backlog,
  // Telegram itself); `handle` is our own time. Only slow ones are logged.
  // NEVER log message text here — the import-wallet step is a private key in a
  // plain message; the callback data and the pending step name are bot-made.
  const _t0 = Date.now();
  const _age = up.message && up.message.date ? Math.max(0, _t0 - up.message.date * 1000) : null;
  const _chat0 = (up.message && up.message.chat) || (up.callback_query && up.callback_query.message && up.callback_query.message.chat);
  const _p0 = _chat0 && pending.get(_chat0.id);
  const _what0 = up.callback_query ? `cb:${String(up.callback_query.data || '?').slice(0, 48)}` : up.message ? `msg:${(_p0 && _p0.action) || 'command'}` : 'update';
  try {
  try {
    const chat = (up.message && up.message.chat) || (up.callback_query && up.callback_query.message && up.callback_query.message.chat);
    if (chat && chat.type !== 'private') {
      if (up.callback_query) await answer(up.callback_query.id, 'DM me privately — group use is disabled.');
      else if (_shouldAnswerInGroup(up.message, chat.id)) {
        await send(chat.id, 'This is a custodial trading bot — please DM me privately. Group use is disabled for security.');
      }
      return;
    }
    const from = (up.message && up.message.from) || (up.callback_query && up.callback_query.from);
    if (from) core.noteUser(from.id, from);   // remember @username (no-op until the user exists)
    if (up.message) return await onMessage(up.message);
    if (up.callback_query) return await onCallback(up.callback_query);
  } catch (e) {
    const chat = (up.message && up.message.chat) || (up.callback_query && up.callback_query.message && up.callback_query.message.chat);
    // NAME THE PATH, not just the error.
    //
    // This catch is the source of every "⚠️ Something glitched handling that"
    // the bot has ever sent, and it logged `e.message` alone — for undici that
    // is the two words `fetch failed`, with no host, no syscall and no clue
    // which of the bot's upstreams died or what the user had even done. Three of
    // those in the server log cost a round of guessing only the box could answer.
    //
    // ⚠️ NEVER LOG MESSAGE TEXT to identify the path. The import-wallet step
    // takes a private key as a plain chat message, so `up.message.text` — even
    // truncated — puts key material into pm2's log for anyone with shell access.
    // The bot's own pending action names the step better anyway, and carries
    // nothing the user typed.
    const p = chat && pending.get(chat.id);
    const what = up.callback_query ? `cb:${String(up.callback_query.data || '?').slice(0, 48)}`
      : up.message ? `msg:${(p && p.action) || 'command'}`
      : 'update';
    const code = (e && (e.code || (e.cause && (e.cause.code || e.cause.errno)))) || '';
    console.error(`handleUpdate [${what}] chat=${(chat && chat.id) || '?'}${code ? ` ${code}` : ''}:`, (e && (e.message || e)), (e && e.stack) || '');
    // Last resort: never leave the user staring at nothing on an unhandled
    // error. Best-effort — this send must not itself throw out of the catch.
    //
    // "Something glitched" is a claim about the BOT, and on a transport failure
    // it is the wrong one — it invites an immediate retry into the same dead
    // host and quietly takes the blame for an upstream being down. The two cases
    // now read differently, in the user's own language; the copy was hardcoded
    // English on a bot that ships EN/ID everywhere else.
    try {
      if (chat && chat.type === 'private') await send(chat.id, T(chat.id, e && e.offline ? 'err.glitch_net' : 'err.glitch'));
    } catch (_) { /* ignore */ }
  }
  } finally {
    const _took = Date.now() - _t0;
    if (_took > 1500 || (_age != null && _age > 5000)) {
      console.log(`[ui] slow ${_what0} handle=${_took}ms${_age != null ? ` age=${Math.round(_age / 1000)}s` : ''}`);
    }
  }
}

function onMessage(m) {
  // Thread every reply to the user's message. allow_sending_without_reply keeps it working
  // even for flows that delete the user's message first (e.g. importing a private key).
  return _replyCtx.run(m && m.message_id, () => onMessageImpl(m));
}
/**
 * Normalise the COMMAND WORD of a message, and nothing else.
 *
 * Every command below is matched with `===` against a lowercase literal, and
 * Telegram does not lowercase what the user typed — so `/WITHDRAW` and
 * `/Withdraw` (which is what a phone keyboard's autocapitalise produces) fell
 * through to "🤔 I didn't recognise that" on a bot whose entire command set is
 * lowercase. In a group Telegram also appends the bot's own username —
 * `/withdraw@DexvraTradeBot` — and that failed in exactly the same way, on every
 * one of the 33 commands.
 *
 * ⚠️ ONLY THE FIRST WORD, and only when it starts with `/`. Lowercasing the whole
 * message would be a much worse bug than the one being fixed: this same string is
 * what a user pastes a contract address into, and a base58 Solana mint and a
 * checksummed EVM address are BOTH case-sensitive. Everything after the first
 * space — a /start deep link payload, a referral code, /send's arguments — is
 * passed through untouched for the same reason.
 */
function normalizeCommand(text) {
  if (!text.startsWith('/')) return text;
  const sp = text.search(/\s/);
  const head = sp === -1 ? text : text.slice(0, sp);
  const rest = sp === -1 ? '' : text.slice(sp);
  return head.toLowerCase().split('@')[0] + rest;
}

async function onMessageImpl(m) {
  const chatId = m.chat.id;
  const text = normalizeCommand((m.text || '').trim());
  if (!text) return;

  let p = pending.get(chatId);
  if (p && Date.now() - (p.ts || 0) > PENDING_TTL) { pending.delete(chatId); p = null; }   // expire stale prompts
  if (p && !text.startsWith('/')) { pending.delete(chatId); return await resolvePending(chatId, p, text, m); }
  if (text.startsWith('/')) pending.delete(chatId);   // a command aborts any pending flow
  if (text === '/cancel') return send(chatId, T(chatId, 'common.cancelled'), mainMenu());

  if (text.startsWith('/start')) {
    const payload = text.split(/\s+/)[1] || null;
    // Deep link from a Dexvra listing post's "⚡ Buy / Sell" line:
    //   /start ca_<address>          — legacy, chain is auto-detected
    //   /start ca_<chain>_<address>  — carries the chain, so we skip getCode
    //                                  detection and open the EXACT venue. Vital
    //                                  for Robinhood launchpad / bonding-curve
    //                                  tokens: they have NO code at the address,
    //                                  so getCode-based detection can't see them
    //                                  and the tap used to dead-end. Anything
    //                                  else stays a referral code, as before.
    let deepCa = null, deepChain = null;
    if (payload && payload.startsWith('ca_')) {
      const rest = payload.slice(3);
      const us = rest.indexOf('_');
      if (us > 0 && core.chainOf(rest.slice(0, us)) && isCa(rest.slice(us + 1))) {
        deepChain = rest.slice(0, us);
        deepCa = rest.slice(us + 1);
      } else if (isCa(rest)) {
        deepCa = rest;
      }
    }
    const ref = deepCa ? null : payload;
    const isNew = !core.getUser(chatId);
    core.ensureUser(chatId, ref);
    core.noteUser(chatId, m.from);                 // capture @username now that the user exists
    report.onStart(core.getUser(chatId), isNew, ref, core.allUsers().length);   // → admin channel (fire-and-forget)
    if (deepCa) {
      if (isNew) await send(chatId, T(chatId, 'start.deeplink.new'), mainMenu());
      try {
        let chain = deepChain;   // chain carried by the link → no detection needed
        if (!chain) {
          const det = await detectChain(chatId, deepCa);
          if (det.choices) {
            const kb = det.choices.map((ck) => { const c = core.chainOf(ck); return [btn(`${c.emoji} ${c.name}`, `tok:${ck}:${walletIndex(chatId)}:${deepCa}`)]; });
            kb.push([btn('« Menu', 'menu')]);
            return await send(chatId, `🌐 <code>${short(deepCa)}</code> exists on <b>${det.choices.length} chains</b> — pick where to trade:`, { inline_keyboard: kb });
          }
          chain = det.chain;
        }
        if (!chain) {
          // Detection found nothing (codeless launchpad token, or an RPC was
          // down) → offer a chain picker so the tap is ALWAYS actionable, never
          // a silent dead-end or a wrong-chain "couldn't price". The tok: button
          // loads the card on whichever chain the user picks.
          const kb = core.chains.enabledChains().map((c) => [btn(`${c.emoji} ${c.name}`, `tok:${c.key}:${walletIndex(chatId)}:${deepCa}`)]);
          kb.push([btn('« Menu', 'menu')]);
          return await send(chatId, `🌐 <code>${short(deepCa)}</code> — pick the chain to trade on:`, { inline_keyboard: kb });
        }
        const c = await tokenCard(chatId, deepCa, chain);
        return await send(chatId, c.text, c.kb);
      } catch (e) {
        // A deep-link tap must NEVER go blank. If the card can't load right now
        // (RPC hiccup, a token-meta call reverting), hand the CA straight back —
        // tap-to-copy — so the user pastes it and retries (same card path, which
        // succeeds on a retry). Silence here read as "the button does nothing".
        console.error('deep-link card', e && (e.message || e));
        return send(chatId, `${T(chatId, 'start.deeplink.fail')}\n<code>${esc(deepCa)}</code>`, mainMenu());
      }
    }
    const activeW = core.activeWallet(core.ensureUser(chatId));
    // New users get a single obvious first action (get the deposit address); returning
    // users get the normal menu.
    const welcomeKb = (isNew && activeW)
      ? { inline_keyboard: [[btn('📥 Get my deposit address', 'qrw:' + activeW.id)], [btn('❔ How it works', 'help'), btn('« Menu', 'menu')]] }
      : mainMenu();
    const startNative = core.chainOf(core.userChain(core.ensureUser(chatId))).native;
    await send(chatId,
      T(chatId, 'start.title') + '\n\n' +
      T(chatId, 'start.pitch') + '\n\n' +
      T(chatId, 'start.steps.head') + '\n' +
      T(chatId, 'start.steps.1', { native: startNative }) + '\n' +
      T(chatId, 'start.steps.2') + '\n' +
      T(chatId, 'start.steps.3') + '\n\n' +
      T(chatId, 'start.custody') + '\n\n' +
      T(chatId, isNew ? 'start.new' : 'start.returning'),
      welcomeKb);
    const w = await walletScreen(chatId); return send(chatId, w.text, w.kb);
  }
  if (text === '/wallet') { const w = await walletScreen(chatId); return send(chatId, w.text, w.kb); }
  if (text === '/chain') { const s = chainScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/portfolio' || text === '/positions') { const s = await portfolioScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/pnl' || text.startsWith('/pnl ')) {
    const arg = text.split(/\s+/)[1];
    if (arg && isCa(arg)) {
      // The chain is DETECTED from the address, never assumed from the active
      // chain — see pnlCardScreen.
      const det = await detectChain(chatId, arg);
      return sendPnlCard(chatId, arg, det.chain || core.userChain(core.ensureUser(chatId)));
    }
    if (arg) return send(chatId, T(chatId, 'pnl.bad_ca'));
    const s = await pnlBookScreen(chatId);
    return send(chatId, s.text, s.kb);
  }
  if (text === '/tokens' || text === '/bags') { const s = await tokensScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/monitor' || text === '/track') { const s = await monitorListScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/history') { const s = historyScreen(chatId); return send(chatId, s.text, s.kb); }
  // Both commands open the Sol-Trading-Bot-style sniper home: the 🎛 setup
  // panel first, armed targets listed, mass mode behind its own 🌊 button.
  if (text === '/snipe' || text === '/sniper') { const s = caSnipeScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/orders') { const s = ordersScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/alerts') { const s = alertsScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/copy') { const s = copyScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/dca') { const s = dcaScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/referral' || text === '/refer') { const s = referralScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/settings') { const s = settingsScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/language' || text === '/lang' || text === '/bahasa') { const s = langScreen(chatId); return send(chatId, s.text, s.kb); }
  // ⚠️ /withdraw used to jump STRAIGHT to "paste the address" on whatever chain
  // happened to be active — so a user who wanted to move SOL got a prompt for a
  // 0x address on Robinhood Chain and no way to say otherwise without backing
  // out and hunting for 🌐. Chain first, same as the buttons and the same rule
  // the snipe panel had to be rescued into.
  // ONE command. /withdrawall still answers — it was in the menu for a build and
  // is muscle memory now — but it is the same screen, not a second feature.
  if (text === '/withdraw' || text === '/withdrawall') {
    const sc = wdSweepChainScreen(chatId);
    return send(chatId, sc.text, sc.kb);
  }
  if (text.startsWith('/send')) {
    const [, ca, to, amt] = text.split(/\s+/);
    if (!isCa(ca) || !to || !amt) return send(chatId, 'Usage: <code>/send &lt;token&gt; &lt;destination&gt; &lt;amount|max&gt;</code> — sends a held token out. Or open the token card and tap 📤 Send.');
    try { await send(chatId, T(chatId, 'common.sending')); const r = await core.withdrawToken(chatId, ca, to, amt); return send(chatId, `✅ <b>Sent</b> ${fmt(r.amount)} $${esc(r.sym)}\nto <code>${esc(to)}</code>\n${txLink(r.chain, r.hash)}`); }
    catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
  }
  if (text === '/export') return askExport(chatId);
  if (text === '/id' || text === '/whoami') { const admin = core.CFG.admins.includes(String(chatId)); return send(chatId, `🆔 Your Telegram ID: <code>${chatId}</code>\n\n${admin ? '✅ You are an <b>admin</b>.' : 'To become admin, put this in <code>TRADEBOT_ADMIN_IDS</code> in the bot\'s .env, then restart.'}`); }
  if (text === '/admin') return adminScreen(chatId);
  if (text === '/backup') { if (!core.CFG.admins.includes(String(chatId))) return send(chatId, 'Not authorized.'); const r = core.backupNow(); return send(chatId, `💾 <b>Backup written</b>\n<code>${esc(r.dir)}</code>\nSnapshots kept: <b>${r.count}</b>\n\n<i>These are ON-BOX snapshots (corruption/mistake recovery). For real disaster recovery, rsync <code>data/</code> off the VPS and back up <code>WALLET_SECRET</code> offline.</i>`); }
  if (text === '/health') {
    if (!core.CFG.admins.includes(String(chatId))) return send(chatId, 'Not authorized.');
    const h = watchers.health();
    // ⚠️ NOT A LOOP, AND THIS MAP IS RENDERED AS LOOPS. `jupiter` carries the
    // request-budget counters, and left in `names` it drew a meaningless
    // "🟢 jupiter — ran never" row while showing NONE of the numbers it exists
    // for — a value nobody can read is the same as no value, committed by the
    // very change that added it. Pulled out and rendered on its own below.
    const jup = h.jupiter; delete h.jupiter;
    const names = Object.keys(h);
    const age = (ms) => ms == null ? 'never' : (ms < 60000 ? Math.round(ms / 1000) + 's' : Math.round(ms / 60000) + 'm') + ' ago';
    const lines = names.map((n) => {
      const x = h[n];
      let extra = '';
      // A loop that RAN is not a loop that WORKS. The snipe cycle polls a launchpad
      // factory for one specific event; point it at the wrong launchpad and getLogs
      // returns an empty array every time — healthy, on time, and completely blind.
      // "0 launches seen in 41h" is the only line that shows that.
      if (n === 'snipe' && x.launchesSeen != null) {
        const seen = x.launchesSeen;
        const since = x.sinceLastLaunchMs == null ? 'never' : age(x.sinceLastLaunchMs);
        extra = `\n     └ launches seen: <b>${seen}</b> (last ${since}) · ${x.blocksScanned || 0} blocks scanned`;
        if (!seen && (x.blocksScanned || 0) > 2000) extra += `\n     └ ⚠️ <b>scanned ${x.blocksScanned} blocks and saw no launch</b> — the launchpad factory is probably wrong for this chain. Run <code>node scripts/robinhood-preflight.js</code>`;
      }
      return `${x.stale ? '🔴' : '🟢'} <b>${n}</b> — ran ${age(x.ageMs)}${x.err ? ` · ⚠️ ${esc(x.err.slice(0, 80))}` : ''}${extra}`;
    });
    // THE REQUEST BUDGET, in the one place an operator already looks. `refused`
    // is the only number that means a trade was lost; `absorbed` is a 429 the
    // retry got past, which cost latency and nothing else. Rendering them as one
    // number would make a healthy budget read as a broken one.
    let jupBlock = '';
    if (jup) {
      const bad = jup.sinceRefusedMs != null && jup.sinceRefusedMs < 900000;
      jupBlock = `\n\n${bad ? '🔴' : '🟢'} <b>Jupiter budget</b> — ${esc(jup.tier)}`
        + `\n     └ ${jup.requests} request(s) · ${jup.rateLimited} × 429 · ${jup.absorbedByRetry} absorbed by retry`
        + `\n     └ <b>${jup.refusedTrades}</b> trade(s) refused by our own budget`
        + (jup.sinceRefusedMs != null ? ` (last ${age(jup.sinceRefusedMs)})` : '')
        + (bad ? `\n     └ ⚠️ ${esc(String(jup.lastRefusedWhy || 'rate limited'))} — set <code>JUP_API_KEY</code> in tradebot/.env, or trade fewer wallets at once` : '');
    }
    if (!names.length) return send(chatId, `🩺 <b>Watcher health</b>\n\nNo loops have run yet.${jupBlock}`);
    return send(chatId, `🩺 <b>Watcher health</b>\n\n${lines.join('\n')}${jupBlock}\n\n<i>🔴 = a loop hasn't run in > 3× its interval (likely stuck). Errors show the last failure.</i>`);
  }
  if (text.startsWith('/userkey')) return adminUserKey(chatId, text.split(/\s+/)[1]);
  if (text.startsWith('/stats')) return adminStats(chatId);
  if (text.startsWith('/revenue')) return adminRevenue(chatId);
  if (text === '/menu' || text === '/help') return send(chatId, helpText(chatId), mainMenu());
  if (text.startsWith('/buy')) { const [, ca, amtRaw] = text.split(/\s+/); if (isCa(ca) && amtRaw) { const det = await detectChain(chatId, ca); const cn = core.chainOf(det.chain || core.userChain(core.ensureUser(chatId))); const pa = parseAmt(amtRaw, cn.native); if (!pa) return send(chatId, 'Usage: <code>/buy &lt;contract&gt; &lt;amount|$usd&gt;</code> — e.g. <code>/buy 0x… 0.05</code> or <code>/buy 0x… $10</code>'); if (pa.err) return send(chatId, '❌ ' + esc(pa.err)); return requestBuy(chatId, ca, pa.amt, det.chain); } return send(chatId, 'Usage: <code>/buy &lt;contract&gt; &lt;amount|$usd&gt;</code> — e.g. <code>/buy 0x… 0.05</code> or <code>/buy 0x… $10</code> — or paste a contract address.'); }
  if (text.startsWith('/sell')) { const [, ca, pct] = text.split(/\s+/); if (isCa(ca) && pct) { const det = await detectChain(chatId, ca); return doSell(chatId, ca, Number(pct), det.chain); } return send(chatId, 'Usage: <code>/sell &lt;contract&gt; &lt;pct&gt;</code>'); }

  if (isCa(text)) {
    const u = core.ensureUser(chatId);
    // Detect the token's chain first (Maestro-style) — trading needs no /chain
    // switching. Ambiguous (same contract on several chains) → let the user pick;
    // the card's buttons carry the chain, so the tap trades on the right one.
    const det = await detectChain(chatId, text);
    if (det.choices) {
      const kb = det.choices.map((k) => { const c = core.chainOf(k); return [btn(`${c.emoji} ${c.name}`, `tok:${k}:${walletIndex(chatId)}:${text}`)]; });
      kb.push([btn('« Menu', 'menu')]);
      return send(chatId, `🌐 <code>${short(text)}</code> exists on <b>${det.choices.length} chains</b> — pick where to trade:`, { inline_keyboard: kb });
    }
    // Auto-buy on paste (Settings): buy instantly with the active wallet on the
    // DETECTED chain (falls back to the active chain if detection found nothing).
    if (u.settings && u.settings.autoBuy) {
      const amt = u.settings.autoBuyAmount || '0.01';
      const chainKey = det.chain || core.userChain(u);
      // Safety gate: auto-buy skips the manual 🛡 Safety screen, so on chains we can
      // check (GoPlus on EVM, RugCheck on Solana) refuse a DANGER-flagged token
      // (honeypot / can't-sell / freeze-authority / rugged) before spending funds.
      let safetyNote = '';
      if (safety.supported(chainKey)) {
        const s = await safety.tokenSecurity(chainKey, text).catch(() => null);
        if (s && safety.verdict(chainKey, s).level === 'danger') {
          const why = safety.verdict(chainKey, s).red.join(', ');
          return send(chatId, `🚨 <b>Auto-buy blocked</b> — <code>${short(text)}</code> is <b>HIGH RISK</b>: ${esc(why)}. Open the card and review 🛡 Safety before buying manually.`, rows([btn('🔎 Open card', `tok:${chainKey}:${walletIndex(chatId)}:${text}`), btn('« Menu', 'menu')]));
        }
        // Gate fails OPEN when there's no data (fresh/unindexed token — the riskiest
        // case). Tell the user the check didn't actually run.
        if (!s) safetyNote = '\n⚠️ <i>Safety data unavailable — buying blind on a fresh/unknown token.</i>';
      }
      await send(chatId, `⚡ <b>Auto-buy</b> ${esc(amt)} of <code>${short(text)}</code>… <i>(toggle in ⚙️ Settings)</i>${safetyNote}`);
      return doBuy(chatId, text, amt, chainKey);
    }
    const c = await tokenCard(chatId, text, det.chain); return send(chatId, c.text, c.kb);
  }
  return send(chatId, T(chatId, 'common.unknown_input'), mainMenu());
}

async function onCallback(q) {
  const chatId = q.message.chat.id;
  const mid = q.message.message_id;
  const data = q.data || '';
  const [k, ca, arg] = data.split(':');
  // Fire-and-forget the ack (clears the button's spinner) so the handler proceeds without
  // waiting on a Telegram round-trip — noticeably snappier taps.
  //
  // A callback query can be answered EXACTLY ONCE. Pre-acking a handler that
  // ends in answer(q.id, 'some text') therefore throws that text away: Telegram
  // rejects the second call and the user gets silence. Three keys were listed
  // here; five more had been added since and were all silently mute — including
  // the exit-mirror toggle, which arms an automatic 100% sell, and the language
  // switch, whose entire job is to confirm it took.
  //
  // ANSWERS_ITSELF is checked against the source by callbackAck.test.js, so a
  // new text answer that forgets to register here fails the suite instead of
  // shipping as a dead button.
  if (!ANSWERS_ITSELF.has(k)) answer(q.id).catch(() => {});

  if (k === 'bccancel') { const pp = pending.get(chatId); if (pp && pp.action === 'confirm_buy' && pp.confirmId === ca) pending.delete(chatId); return edit(chatId, mid, 'Buy cancelled.', mainMenu()); }
  if (k === 'bcok') {
    // get→validate→delete is one synchronous block (no await between) so two rapid
    // taps can't both consume it. The confirmId must match the CURRENT pending, so a
    // stale card (superseded by a newer buy) is rejected and can't buy the wrong token.
    const pp = pending.get(chatId);
    if (!pp || pp.action !== 'confirm_buy' || pp.confirmId !== ca || Date.now() - (pp.ts || 0) > PENDING_TTL) return send(chatId, 'That confirmation is no longer valid — tap Buy again.');
    pending.delete(chatId);
    return doBuy(chatId, pp.ca, pp.amt, pp.chain, pp.walletId);
  }
  if (data === 'wdcancel') { pending.delete(chatId); return send(chatId, 'Withdrawal cancelled.', mainMenu()); }
  if (data === 'wdaok') {
    const pp = pending.get(chatId); pending.delete(chatId);
    if (!pp || pp.action !== 'wd_sweep_confirm' || Date.now() - (pp.ts || 0) > PENDING_TTL) return send(chatId, 'Confirmation expired. Start again from 👛 Wallets.');
    const wch = core.chainOf(pp.chain) || {};
    // One progress message, EDITED with the result. A wallet-per-message sweep
    // of ten wallets is ten notifications for one action; the user is looking at
    // this screen already, having just tapped confirm.
    const prog = await send(chatId, `⏳ <b>Withdrawing</b> from ${pp.ids.length} wallet${pp.ids.length > 1 ? 's' : ''} on ${wch.emoji || ''} ${esc(wch.name || pp.chain)}…`);
    const pid = prog && prog.result && prog.result.message_id;
    try {
      const rows2 = await core.withdrawMany(chatId, pp.to, pp.amt, pp.chain, pp.ids);
      const txt = wdSweepResultText(chatId, pp.chain, pp.to, rows2);
      return pid ? edit(chatId, pid, txt) : send(chatId, txt);
    } catch (e) {
      // A throw here is a whole-sweep refusal (locked vault, whitelist, rate
      // limit, bad address) — nothing moved, and saying so is the point.
      const txt = '❌ ' + esc(e.message || String(e)) + '\n\n<i>Nothing was sent.</i>';
      return pid ? edit(chatId, pid, txt) : send(chatId, txt);
    }
  }
  if (data === 'wdok') {
    const pp = pending.get(chatId); pending.delete(chatId);
    if (!pp || pp.action !== 'wd_confirm' || Date.now() - (pp.ts || 0) > PENDING_TTL) return send(chatId, 'Confirmation expired. Start again with /withdraw.');
    try {
      await send(chatId, T(chatId, 'common.sending'));
      const r = await core.withdraw(chatId, pp.to, pp.amt, pp.chain, pp.walletId);
      // A swept wallet is EMPTY, and saying so is the difference between "the
      // withdrawal worked" and "the withdrawal worked and you can now remove
      // this wallet" — which is the errand most sweeps are part of.
      return send(chatId, `✅ Sent <b>${r.sentEth} ${esc(r.native)}</b>\n${txLink(pp.chain, r.hash)}` + (r.swept ? `\n\n<i>This wallet's ${esc(r.native)} balance is now zero.</i>` : ''));
    }
    catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
  }
  if (data === 'menu') return edit(chatId, mid, menuGreeting(chatId), mainMenu());
  if (data === 'help') return edit(chatId, mid, helpText(chatId), mainMenu());
  if (data === 'wal') { const w = await walletScreen(chatId); return edit(chatId, mid, w.text, w.kb); }
  if (data === 'chain') { const s = chainScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'setch') { try { core.setChain(chatId, ca); } catch (_) {} const w = await walletScreen(chatId); return edit(chatId, mid, w.text, w.kb); }
  if (data === 'pos') { const s = await portfolioScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'toks') { const s = await tokensScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'monlist') { const s = await monitorListScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'hist') { const s = historyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  // 🎯 Snipe is the sniper HOME (panel + targets) — the reference bot's shape.
  // The user's word "snipe" means "snipe THIS token", and the menu button used
  // to answer it with the buy-everything screen ("masih sama aja, setinganya
  // bukan yang saya inginkan"). Mass mode is a labelled choice inside, 'snmass'.
  if (data === 'snipe') { const s = caSnipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'snmass') { const s = snipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'pnl') { const s = await pnlBookScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'pnlask') { setPending(chatId, { action: 'pnl_ca' }); return send(chatId, T(chatId, 'pnl.ask')); }
  if (k === 'pnlt') {
    // `pnlt:<chain>:<ca>` — the chain rides the button, so a card opened from
    // the book stays on the chain the book was built for.
    const parts = data.split(':');
    return sendPnlCard(chatId, parts[2], parts[1]);
  }
  if (data === 'orders') { const s = ordersScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'dcas') { const s = dcaScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'dcac') { watchers.cancelDca(chatId, ca); const s = dcaScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'ref') { const s = referralScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'set') { const s = settingsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'lang') { const s = langScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'setlang') {
    try { core.setLang(chatId, ca); } catch (_) {}
    // Confirm IN the language just chosen — the whole point of the setting.
    await answer(q.id, i18n.t(core.getLang(chatId), 'lang.set', { lang: i18n.LANG_LABEL[core.getLang(chatId)] }).replace(/<[^>]+>/g, ''));
    const s = settingsScreen(chatId); return edit(chatId, mid, s.text, s.kb);
  }
  if (data === 'setslip') { setPending(chatId, { action: 'slip_val' }); return send(chatId, 'Send your <b>slippage %</b> (e.g. <code>5</code>). <code>0</code> = default (5%). Max 50.'); }
  if (data === 'setgas') { const s = gasScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'gasset') { const n = Number((data.split(':')[1]) || 1); try { core.setGasBoost(chatId, n); } catch (_) {} const s = gasScreen(chatId); await answer(q.id, `Gas priority: ${gasLabel(core.userGasBoost(core.ensureUser(chatId)))}`); return edit(chatId, mid, s.text, s.kb); }
  // The prompt names the RANGE and shows this chain's own current amounts as the
  // example. It used to hardcode "3" and "0.01 0.05 0.1" — an ETH-denominated
  // example offered to someone on Solana, next to a count the code no longer
  // requires.
  if (data === 'setbp') { const ck = core.userChain(core.ensureUser(chatId)); const cn = core.chainOf(ck); const cur = core.buyPresets(core.ensureUser(chatId), ck).join(' '); setPending(chatId, { action: 'bp_val', chain: ck }); return send(chatId, `Send <b>${core.PRESETS_MIN}–${core.PRESETS_MAX} quick-buy amounts</b> for <b>${cn.emoji} ${esc(cn.name)}</b> (in ${cn.native}), separated by spaces.\n\nNow: <code>${esc(cur)}</code>`); }
  if (data === 'cbtog') { const u = core.ensureUser(chatId); try { core.setConfirmBuy(chatId, !u.settings.confirmBuy); } catch (_) {} const s = settingsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'extog') { const u = core.ensureUser(chatId); try { core.setExpert(chatId, !u.settings.expert); } catch (_) {} const s = settingsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'csn') { const s = caSnipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'csnadd') {
    // Chain FIRST ("snipenya dari awal salah aturan, disuruh pilih chain mana
    // dulu"). The old flow bound the target to whatever chain happened to be
    // active, so a Solana mint pasted while Ethereum was active bounced as
    // "not a valid contract address" — with the fix two screens away on 🌐.
    // Sent as its own message so the armed list above stays visible.
    const act = activeChain(chatId);
    const en = core.chains.enabledChains();
    const kbR = [];
    for (let i = 0; i < en.length; i += 2) kbR.push(en.slice(i, i + 2).map((c) => btn(`${c.key === act.key ? '✓ ' : ''}${c.emoji} ${c.name}`, `csnch:${c.key}`)));
    return send(chatId, T(chatId, 'snipe.ca.pick_chain'), { inline_keyboard: kbR });
  }
  if (k === 'csnch') {
    const ch = core.chainOf(ca);
    if (!ch) return;
    setPending(chatId, { action: 'ca_snipe', chain: ch.key });
    // The example address is chain-shaped: a user copies the shape they see.
    const ex = core.chains.isSvm(ch.key) ? 'Ge87Etsj…' : '0xabc…';
    // Edit the picker into the prompt — choosing is a step, not a message
    // worth keeping.
    return edit(chatId, mid, T(chatId, 'snipe.ca.prompt', { chain: `${ch.emoji} ${esc(ch.name)}`, native: esc(ch.native), ex }));
  }
  if (data.startsWith('csnx:')) {
    core.removeSnipeTarget(chatId, data.slice(5));
    const s = caSnipeScreen(chatId);
    return edit(chatId, mid, s.text, s.kb);
  }
  // ── 🎛 Snipe Setup panel (snw:* = navigate, snwch/snww/snwa/snws/snwt/snwx = set a value)
  if (k === 'snw') {
    if (ca === 'cancel') { core.clearSnipeDraft(chatId); const s = caSnipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
    if (ca === 'chain') { const s = snwChainScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
    if (ca === 'wal') { const s = snwWalletScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
    if (ca === 'waln') { try { core.updateSnipeDraft(chatId, { walletIds: [] }); } catch (_) {} const s = snwWalletScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
    if (ca === 'amt') { setPending(chatId, { action: 'snw_amt' }); const s = snwAmountScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
    if (ca === 'slip') { const s = snwSlipScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
    if (ca === 'tpsl') { const s = snwTpslScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
    if (ca === 'ttl') { const s = snwTtlScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
    if (ca === 'ca') {
      // The Target is a CHOICE of two kinds ("dmn target dev walletnya") — a
      // token contract, or a developer wallet whose every launch is bought.
      // A wallet and a CA share the same address shape on every chain, so no
      // paste can be auto-classified; the user says which they mean.
      return edit(chatId, mid, T(chatId, 'snipe.panel.target_kind'), rows(
        [btn(T(chatId, 'snipe.panel.kind_ca'), 'snw:cat'), btn(T(chatId, 'snipe.panel.kind_dev'), 'snw:cad')],
        [btn('« Back', 'snw:open')],
      ));
    }
    if (ca === 'cat') {
      const u = core.ensureUser(chatId);
      try { core.updateSnipeDraft(chatId, { kind: 'ca' }); } catch (_) {}
      const d = core.snipeDraft(u) || core.newSnipeDraft(chatId);
      const ch = core.chainOf(d.chain) || { emoji: '', name: d.chain };
      setPending(chatId, { action: 'snw_ca' });
      const ex = core.chains.isSvm(d.chain) ? 'Ge87Etsj…' : '0xabc…';
      return edit(chatId, mid, T(chatId, 'snipe.panel.ca_prompt', { chain: `${ch.emoji} ${esc(ch.name)}`, ex }), rows([btn('« Back', 'snw:open')]));
    }
    if (ca === 'cad') {
      const u = core.ensureUser(chatId);
      try { core.updateSnipeDraft(chatId, { kind: 'dev' }); } catch (_) {}
      const d = core.snipeDraft(u) || core.newSnipeDraft(chatId);
      const ch = core.chainOf(d.chain) || { emoji: '', name: d.chain };
      setPending(chatId, { action: 'snw_dev' });
      return edit(chatId, mid, T(chatId, 'snipe.panel.dev_prompt', { chain: `${ch.emoji} ${esc(ch.name)}` }), rows([btn('« Back', 'snw:open')]));
    }
    if (ca === 'amtc') { const u = core.ensureUser(chatId); const d = core.snipeDraft(u) || core.newSnipeDraft(chatId); const ch = core.chainOf(d.chain) || { native: '' }; setPending(chatId, { action: 'snw_amt' }); return send(chatId, T(chatId, 'snipe.panel.amt_prompt', { native: esc(ch.native) })); }
    if (ca === 'slipc') { setPending(chatId, { action: 'snw_slip' }); return send(chatId, T(chatId, 'snipe.panel.slip_prompt')); }
    if (ca === 'tpslc') { setPending(chatId, { action: 'snw_tpsl' }); return send(chatId, T(chatId, 'snipe.panel.tpsl_prompt')); }
    if (ca === 'ttlc') { setPending(chatId, { action: 'snw_ttl' }); return send(chatId, T(chatId, 'snipe.panel.ttl_prompt')); }
    if (ca === 'arm') {
      // No toast on failure — the panel says what is missing, IN the panel,
      // where the row to fix is one tap away. A toast disappears; the row stays.
      try {
        const tgt = core.armSnipeDraft(chatId);
        // THE CONFIRMATION IS A NEW MESSAGE, NOT AN EDIT OF THE PANEL.
        //
        // "dmn ada teks snipe atau confirm??" — it was there, written into the
        // panel message in place. An in-place edit notifies nobody and, after
        // any scrolling, happens off screen: the newest message in the chat was
        // the sniper home, so arming a snipe with real money on it looked like
        // nothing happened. Same lesson the raid card already cost us. The
        // panel is retired where it stands (its buttons must not be re-tappable
        // once its draft is spent) and the confirmation lands at the BOTTOM.
        let text, kb;
        if (tgt.mode === 'launches') {
          // A dev target. The master switch gates the whole feature — arming a
          // watch that silently does nothing is the stop-loss-the-user-
          // believes-exists, so an OFF switch is said with its one-tap fix.
          const chG = core.chainOf(tgt.chain) || activeChain(chatId);
          const u2 = core.ensureUser(chatId);
          const on = !!(u2.copy && u2.copy.on);
          // The wallet fan-out is real money per LAUNCH — on the consent
          // message, never discovered on the receipts. A dev snipe RECURS, so
          // it takes the recurring sentence whatever the selection shape is.
          const multi = walletScopeLine(chatId, tgt, tgt.buyEth, chG.native, 'dev.armed_wallets');
          text = T(chatId, 'dev.armed', {
            addr: esc(short(tgt.address)), chain: `${chG.emoji} ${esc(chG.name)}`,
            perBuy: esc(tgt.buyEth), native: esc(chG.native),
          }) + multi + '\n' + T(chatId, on ? 'dev.live' : 'dev.master_off');
          // ARMED and RE-TERMED are different events to a reader whose budget
          // has already been partly spent — a confirmation saying "armed" over
          // a target mid-spend misstates what just happened.
          if (tgt._updated) {
            text = T(chatId, 'snipe.panel.updated', { spent: esc(Number(tgt._spent || 0).toFixed(3)), native: esc(chG.native) }) + '\n\n' + text;
          }
          kb = { inline_keyboard: [
            ...(on ? [] : [[btn(T(chatId, 'dev.on_btn'), 'cptog')]]),
            [btn(T(chatId, 'snipe.panel.home_btn'), 'csn'), btn('👥 Copy & Snipe', 'copy')],
          ] };
        } else {
          text = snipeArmedText(chatId, tgt);
          if (tgt._updated) text = T(chatId, 'snipe.panel.updated', { spent: '0.000', native: esc((core.chainOf(tgt.chain) || {}).native || '') }) + '\n\n' + text;
          kb = { inline_keyboard: [[btn(T(chatId, 'snipe.panel.home_btn'), 'csn'), btn('« Menu', 'menu')]] };
        }
        await edit(chatId, mid, T(chatId, 'snipe.panel.spent'));
        return send(chatId, text, kb);
      } catch (e) {
        // A REFUSAL IS SENT, NOT ONLY EDITED IN.
        //
        // "pas pilih arm malah tidak mau respon" — it DID respond: the reason
        // was written into the panel, near the TOP of a twenty-line message the
        // reader is scrolled past (the buttons are at the bottom, which is why
        // they are looking there). An in-place edit notifies nobody and happens
        // off screen — the exact lesson the SUCCESS path above already carries,
        // never applied to the failure path beside it. So the panel still shows
        // the reason (the row to fix is one tap away) AND the reason lands at
        // the bottom of the chat, where the tap was made.
        const why = String((e && e.message) || e);
        const s = snipeSetupScreen(chatId, why);
        await edit(chatId, mid, s.text, s.kb);
        return send(chatId, T(chatId, 'snipe.panel.refused_msg', { why: esc(why) }), { inline_keyboard: [
          [btn(T(chatId, 'snipe.panel.home_btn'), 'csn'), btn('👥 Copy & Snipe', 'copy')],
        ] });
      }
    }
    // 'open' and anything unrecognised: (re)draw the panel.
    const s = snipeSetupScreen(chatId);
    return edit(chatId, mid, s.text, s.kb);
  }
  // Wallet picker taps re-render the PICKER, not the panel — toggling five
  // wallets must not cost five round trips through the whole panel. ✔ Done
  // ('snw:open') is the way back.
  if (k === 'snww' || k === 'snwwt') {
    try {
      if (k === 'snww') {
        // '✅ All on' ('*': every wallet, resolved at fire time). A legacy
        // single-id callback from an old message lands here too.
        core.updateSnipeDraft(chatId, ca === '*' ? { walletIds: '*' } : { walletIds: [ca] });
      } else {
        const u = core.ensureUser(chatId);
        const d = core.snipeDraft(u) || core.newSnipeDraft(chatId);
        const wl = core.walletList(u);
        // STALE IDS ARE DROPPED HERE, not carried into the patch. A draft that
        // still names a deleted wallet (removeWallet does not prune drafts, and
        // the pre-multi migration mints one unvalidated) would otherwise make
        // updateSnipeDraft throw on EVERY toggle — including toggles of
        // perfectly good wallets — and the catch below would swallow it into a
        // picker that redraws unchanged: a dead button with no error.
        const cur = (d.walletIds === '*' ? wl.map((w) => w.id) : (Array.isArray(d.walletIds) ? d.walletIds : []))
          .filter((id) => wl.some((w) => w.id === id));
        core.updateSnipeDraft(chatId, { walletIds: cur.includes(ca) ? cur.filter((id) => id !== ca) : [...cur, ca] });
      }
    } catch (_) {}
    const s = snwWalletScreen(chatId);
    return edit(chatId, mid, s.text, s.kb);
  }
  if (k === 'snwch' || k === 'snwa' || k === 'snws' || k === 'snwx' || k === 'snwt') {
    let note = null;
    try {
      if (k === 'snwch') {
        const u = core.ensureUser(chatId);
        const had = (core.snipeDraft(u) || {}).ca;
        const d = core.updateSnipeDraft(chatId, { chain: ca });
        // Say when the chain switch dropped the target, or the ⏳ that reappears
        // reads as the bot losing the address on its own.
        if (had && !d.ca) note = T(chatId, 'snipe.panel.ca_dropped').replace(/<[^>]+>/g, '');
      }
      else if (k === 'snwa') core.updateSnipeDraft(chatId, { amount: ca });
      else if (k === 'snws') core.updateSnipeDraft(chatId, { slipPct: ca });
      else if (k === 'snwx') core.updateSnipeDraft(chatId, { ttlH: ca });
      else {
        const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(ca || '');
        core.updateSnipeDraft(chatId, m ? { tpPct: Number(m[1]), slPct: Number(m[2]) } : { tpPct: 0, slPct: 0 });
      }
    } catch (e) { note = String((e && e.message) || e); }
    const s = snipeSetupScreen(chatId, note);
    return edit(chatId, mid, s.text, s.kb);
  }
  if (data === 'rstog') { const u = core.ensureUser(chatId); try { core.setReceiptStyle(chatId, core.perWalletReceipts(u) ? 'combined' : 'per_wallet'); } catch (_) {} const s = settingsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'ntf') { const s = notifyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'ntftog') { const type = ca; try { core.setNotify(chatId, type, !core.notifyOn(chatId, type)); } catch (_) {} const s = notifyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'abtog') { const u = core.ensureUser(chatId); try { core.setAutoBuy(chatId, !u.settings.autoBuy); } catch (_) {} const s = settingsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'aptog') { const u = core.ensureUser(chatId); let on = false; try { on = core.setAutoProtect(chatId, !u.settings.autoProtect); } catch (_) {} const s = settingsScreen(chatId); await edit(chatId, mid, s.text, s.kb); if (on) await send(chatId, `🛡 <b>Auto-protect ON</b>\n\nThe bot will automatically <b>sell 100%</b> of a token you hold, and DM you the result, if either happens:\n• it falls <b>~60% below your entry</b> (a dump / rug), or\n• it turns into a <b>honeypot</b> — the sell tax spikes or selling gets blocked.\n\n<i>It will NOT sell a position that's still in profit just because it dipped from a high. Best-effort: a genuine honeypot can block any sale.</i>`); return; }
  if (data === 'abamt') { setPending(chatId, { action: 'ab_amt' }); return send(chatId, 'Send the <b>auto-buy amount</b> to spend per paste (e.g. <code>0.02</code>):'); }
  if (data === 'aex') { setPending(chatId, { action: 'ae_val' }); return send(chatId, '🎯 <b>Auto-exit after every buy</b>\n\nSend <b>&lt;take-profit%&gt; &lt;stop-loss%&gt;</b> (0 = off), e.g.\n<code>100 50</code> → sell 100% at +100% (2x) or −50%.\n<code>0 0</code> → turn auto-exit off.\n\n<i>Orders are placed on the buying wallet, one-shot, relative to your entry price.</i>'); }
  if (data === 'usec') { const s = securityScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'usectog') { const cur = core.getSecurity(chatId).withdrawLock; try { core.setWithdrawLock(chatId, !cur); } catch (_) {} const s = securityScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'uwladd') { const ch = activeChain(chatId); setPending(chatId, { action: 'wl_add', chain: ch.key }); const dh = destHint(ch.key); return send(chatId, `➕ <b>Whitelist a withdraw address</b> on ${ch.emoji} ${esc(ch.name)}\n\nSend the ${dh.what}.${dh.note ? '\n' + dh.note : ''}\n\nOnce you have any whitelisted address on a chain, withdrawals on that chain are <b>only</b> allowed to whitelisted addresses.`); }
  if (k === 'uwlrm') { try { core.removeWhitelist(chatId, ca); } catch (_) {} const s = securityScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'sec') { const parts = data.split(':'); const s = await safetyScreen(chatId, parts[2], parts[1]); return edit(chatId, mid, s.text, s.kb); }
  // Multi-wallet trade picker: wsel opens it; wtg toggles one wallet; wtgA all; wtgN clear.
  if (k === 'wsel') { const parts = data.split(':'); const s = await walletPickScreen(chatId, parts[2], parts[1]); return edit(chatId, mid, s.text, s.kb); }
  // ── Inline multi-wallet panel on the token card (🟢 Multi) ──────────────────
  // wex1/wex0 open and close it; wtc/wtcA/wtcN mutate the selection and redraw
  // the SAME card with the panel still open, so a run of taps is one message.
  // The same selection, mutated from the LIVE MONITOR and re-rendering it. The
  // wtc family below always redraws the token card, which would have replaced
  // the pinned monitor with a token card on every toggle.
  if (k === 'mw' || k === 'mwa' || k === 'mwn') {
    const p = data.split(':');
    const chainK = p[1], mca = p[3];
    const list = core.walletList(core.ensureUser(chatId));
    const card = list[Number(p[2]) - 1];
    const wid = card ? card.id : undefined;
    if (k === 'mwa') { try { core.setTradeAll(chatId, true); } catch (_) {} answer(q.id, '🟢 Sell now acts on every wallet').catch(() => {}); }
    else if (k === 'mwn') { try { core.setTradeAll(chatId, false); } catch (_) {} answer(q.id, '🔴 Sell now acts on this card\'s wallet only').catch(() => {}); }
    // Named rather than a bare `else`: all three keys answer with their own text,
    // and each one has to be attributable to the branch that answers it.
    else if (k === 'mw') {
      // Same seed rule as wtc: single mode holds no list, yet the card's own
      // wallet is drawn lit because it IS the one that trades. Without seeding
      // it first, "tap a second wallet" would REPLACE the first rather than add
      // to it — and on a Sell screen that silently halves the exit.
      const target = list[Number(p[4]) - 1];
      const sel = core.tradeSelection(chatId);
      const seed = !sel.all && sel.ids.length === 0;
      if (target && seed && target.id === wid) {
        answer(q.id, 'Already the wallet that sells — tap another to add it.').catch(() => {});
      } else {
        answer(q.id).catch(() => {});
        if (target) {
          try {
            if (seed && wid) core.toggleTradeWallet(chatId, wid);
            core.toggleTradeWallet(chatId, target.id);
          } catch (_) {}
        }
      }
    }
    const isLatestM = redrawTicket(chatId, mid);
    const np = await monitorPayload(chatId, mca, chainK, wid);
    if (!isLatestM()) return;   // same last-tap-wins rule as the card picker
    return edit(chatId, mid, np.text, np.kb);
  }
  if (k === 'wex1' || k === 'wex0' || k === 'wtc' || k === 'wtcA' || k === 'wtcN') {
    const p = data.split(':');
    const chainK = p[1], mca = p[3];
    const list = core.walletList(core.ensureUser(chatId));
    const card = list[Number(p[2]) - 1];               // the wallet this card is bound to
    const wid = card ? card.id : undefined;
    if (k === 'wtcA') { try { core.setTradeAll(chatId, true); } catch (_) {} }
    else if (k === 'wtcN') { try { core.setTradeAll(chatId, false); } catch (_) {} }
    else if (k === 'wtc') {
      // This branch owns the ack (see the top of onCallback) because it is the
      // one that sometimes has something to say.
      const target = list[Number(p[4]) - 1];
      const sel = core.tradeSelection(chatId);
      // Single mode has no selection list, yet the card's wallet was shown lit
      // because it IS the one that trades. Seed it before adding the tapped one,
      // or "tap a second wallet" would silently REPLACE the first.
      const seed = !sel.all && sel.ids.length === 0;
      if (target && seed && target.id === wid) {
        answer(q.id, 'Already the wallet that trades — tap another one to add it.').catch(() => {});
      } else {
        answer(q.id).catch(() => {});
        if (target) {
          try {
            if (seed && wid) core.toggleTradeWallet(chatId, wid);
            core.toggleTradeWallet(chatId, target.id);
          } catch (_) {}
        }
      }
    }
    // A toggle changes which wallets are lit and nothing else, so it redraws
    // from the last full render instead of paying the scan again; opening or
    // closing the panel is the same card, so it reuses too. Only 🔄 Refresh and
    // a fresh open read live.
    const isLatest = redrawTicket(chatId, mid);
    const c = await tokenCard(chatId, mca, chainK, wid, { multi: k !== 'wex0', reuse: true });
    // A newer tap already redrew this card; painting an older selection over it
    // is the "toggle does not work" report.
    if (!isLatest()) return;
    return edit(chatId, mid, c.text, c.kb);
  }
  if (k === 'wtg') { const parts = data.split(':'); const wobj = core.walletList(core.ensureUser(chatId))[Number(parts[2]) - 1]; if (wobj) { try { core.toggleTradeWallet(chatId, wobj.id); } catch (_) {} } const s = await walletPickScreen(chatId, parts[3], parts[1]); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'wtgA') { const parts = data.split(':'); try { core.setTradeAll(chatId, !core.tradeSelection(chatId).all); } catch (_) {} const s = await walletPickScreen(chatId, parts[2], parts[1]); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'wtgN') { const parts = data.split(':'); try { core.setTradeAll(chatId, false); } catch (_) {} const s = await walletPickScreen(chatId, parts[2], parts[1]); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'dep') { const u = core.ensureUser(chatId); return depositScreen(chatId, core.activeWallet(u)); }
  if (k === 'qrw') { const u = core.ensureUser(chatId); const w = core.walletById(u, ca); if (w) return depositScreen(chatId, w); const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'rnw') {
    const u = core.ensureUser(chatId); const w = core.walletById(u, ca); if (!w) { const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
    const i = core.walletList(u).findIndex((x) => x.id === ca) + 1;
    setPending(chatId, { action: 'rename_wallet', id: ca });
    return send(chatId, `✏️ <b>Rename ${esc(core.walletLabel(w, i))}</b>\n\nSend a new name (up to 24 chars), or <code>-</code> to reset to "Wallet ${i}".`);
  }
  if (data === 'wallets') { const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'sw') { try { core.switchWallet(chatId, ca); } catch (_) {} const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'rmw') { const s = await removeWalletScreen(chatId, ca); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'rmwok') {
    try { await core.removeWallet(chatId, ca); }
    catch (e) {
      // A refusal that names a balance and offers no way to move it is a dead
      // end — and the whole reason this screen was rebuilt. Land back on it
      // WITH the withdraw buttons rather than on a bare ❌ the user has to
      // navigate away from.
      if (e && e.holdings) { const s = await removeWalletScreen(chatId, ca); return edit(chatId, mid, s.text, s.kb); }
      await send(chatId, '❌ ' + esc(e.message || String(e)));
    }
    const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb);
  }
  // Second, informed confirmation for removing a wallet that still holds
  // something. It names every amount and both addresses, because the row is two
  // keypairs and removing it removes the pair.
  if (k === 'rmwf') {
    const u = core.ensureUser(chatId); const w = core.walletById(u, ca);
    if (!w) { const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
    const i = core.walletList(u).findIndex((x) => x.id === ca) + 1;
    let funds = null;
    try { funds = await core.walletFunds(chatId, ca); } catch (_) { funds = null; }
    const surveyed = Array.isArray(funds) && funds.length > 0;
    const holding = surveyed ? funds.filter((f) => f.holds) : [];
    // ⚠️ Three cases, and folding the third into the second is an infinite loop:
    // a wallet that turned out to be EMPTY belongs back on the screen (which
    // offers the one-tap ✅ Remove), but a wallet we could not SURVEY lands back
    // on a screen whose only forward button is this handler — so it would bounce
    // between the two for ever, and the user could never remove it.
    if (surveyed && !holding.length) { const s = await removeWalletScreen(chatId, ca); return edit(chatId, mid, s.text, s.kb); }
    const lines = surveyed
      ? holding.map((f) => `• <b>${esc(f.human)} ${esc(f.native)}</b> on ${f.emoji} ${esc(f.name)}`).join('\n')
      : `• <i>unknown — I couldn't read any chain's balance just now</i>`;
    return edit(chatId, mid,
      `⚠️ <b>Remove Wallet ${i} ${surveyed ? 'with funds still in it' : 'without checking it'}?</b>\n\n${lines}\n\n`
      + `Removing it takes the wallet off your list <b>with whatever is inside</b>. `
      + `I'll show you its <b>seed phrase and both private keys</b> in the next message so the funds stay yours — `
      + `save them before they scroll away, because that is the only copy you will be handed.`,
      rows([btn('📤 Withdraw first', 'rmw:' + ca)], [btn(surveyed ? '⚠️ Yes, remove with funds inside' : '⚠️ Yes, remove without checking', 'rmwfy:' + ca)], [btn('✖ Cancel', 'wallets')]));
  }
  if (k === 'rmwfy') {
    // Keys FIRST, removal second, and the removal is gated on the keys having
    // actually ARRIVED.
    //
    // ⚠️ `send` resolves with Telegram's answer and does NOT throw on an
    // error_code — "message is not modified", a blocked bot and a parse failure
    // are all answers, and callers are expected to read `ok`. A try/catch alone
    // would therefore have removed a funded wallet after silently failing to
    // deliver the only copy of its keys.
    let delivered = false, why = '';
    try { const r = await send(chatId, exportKeyMsg(chatId, ca)); delivered = !!(r && r.ok); why = delivered ? '' : ((r && r.description) || 'Telegram rejected the message'); }
    catch (e) { why = e.message || String(e); }
    if (!delivered) {
      // One ❌, carrying the reason — the first cut sent the thrown message and
      // then a second generic line on top of it.
      await send(chatId, `❌ I couldn't send you the keys${why ? ' — ' + esc(why) : ''}, so the wallet was <b>not</b> removed. Try 🔑 Export first.`).catch(() => {});
      const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb);
    }
    try { await core.removeWallet(chatId, ca, { force: true }); await send(chatId, '🗑 <b>Wallet removed.</b> Its keys are in the message above — the funds are still on-chain and still reachable with them.'); }
    catch (e) { await send(chatId, '❌ ' + esc(e.message || String(e))); }
    const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb);
  }
  // ---- multi-wallet sweep: chain → wallets → address → amount → confirm.
  if (data === 'wd' || data === 'wdall') { const sc = wdSweepChainScreen(chatId); return edit(chatId, mid, sc.text, sc.kb); }   // wdall: old buttons still in a scrollback
  if (k === 'wdac') {
    if (!core.chains.isEnabled(ca)) { const sc = wdSweepChainScreen(chatId); return edit(chatId, mid, sc.text, sc.kb); }
    // ⚠️ THERE USED TO BE TWO COMMANDS HERE — `/withdraw` and `/withdrawall` —
    // differing ONLY in which wallets started ticked. They landed on this same
    // screen, which carries ✅ Select all and ⬜ Clear, so the second one bought
    // exactly one tap and cost a second entry in the "/" menu with its own
    // description. Reported as "2 command ini beda … padahal fungsinya sama ini
    // malah bikin bingung", and that is the right reading: a second way in that
    // does not do a second thing is a question the user has to answer before
    // they can start.
    //
    // The ACTIVE wallet is ticked, which is what a plain withdraw has always
    // meant; everything else is one tap on Select all.
    const u = core.ensureUser(chatId);
    const act = core.activeWallet(u);
    const ids = act ? [act.id] : core.walletList(u).slice(0, 1).map((w) => w.id);
    setPending(chatId, { action: 'wd_sweep_pick', chain: ca, ids });
    const sc = await wdSweepPickScreen(chatId, { chain: ca, ids });
    return edit(chatId, mid, sc.text, sc.kb);
  }
  if (k === 'wdat' || data === 'wdaA' || data === 'wdaN') {
    const pp = pending.get(chatId);
    if (!pp || pp.action !== 'wd_sweep_pick') { const sc = wdSweepChainScreen(chatId); return edit(chatId, mid, sc.text, sc.kb); }
    const list = core.walletList(core.ensureUser(chatId));
    let ids = new Set(pp.ids || []);
    if (data === 'wdaA') ids = new Set(list.map((w) => w.id));
    else if (data === 'wdaN') ids = new Set();
    else { const wobj = list[Number(ca) - 1]; if (wobj) { if (ids.has(wobj.id)) ids.delete(wobj.id); else ids.add(wobj.id); } }
    pp.ids = [...ids]; setPending(chatId, pp);
    // The poll loop does not await handleUpdate, so a run of taps is CONCURRENT
    // and whichever render finished last paints the message — not necessarily
    // the newest tap. Same ticket the card's wallet picker needs.
    const isLatest = redrawTicket(chatId, mid);
    const sc = await wdSweepPickScreen(chatId, pp);
    if (!isLatest()) return;
    return edit(chatId, mid, sc.text, sc.kb);
  }
  if (data === 'wdaGo') {
    const pp = pending.get(chatId);
    if (!pp || pp.action !== 'wd_sweep_pick') { const sc = wdSweepChainScreen(chatId); return edit(chatId, mid, sc.text, sc.kb); }
    if (!(pp.ids || []).length) return answer(q.id, 'Pick at least one wallet first.');
    const wch = core.chainOf(pp.chain);
    setPending(chatId, { action: 'wd_sweep_addr', chain: pp.chain, ids: pp.ids });
    const dh = destHint(pp.chain);
    return send(chatId, `📤 <b>Withdraw</b> · ${wch.emoji} ${esc(wch.name)} · <b>${pp.ids.length} wallet${pp.ids.length > 1 ? 's' : ''}</b>\n\nPaste the ${dh.what} they should all send to.${dh.note ? '\n\n' + dh.note : ''}`);
  }

  // Withdraw from a NAMED wallet on a NAMED chain. `wd` (the active wallet) is
  // the same flow with both left blank.
  if (k === 'wdw') {
    const u = core.ensureUser(chatId); const w = core.walletById(u, ca);
    if (!w) { const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
    // isEnabled, not chainOf: `chainOf` answers from the WHOLE table, so a stale
    // button (or a hand-made callback) could open a withdrawal on a chain the
    // operator has turned off. Every other chain-selecting path in this bot
    // validates — core.setChain throws on it — and this one has to as well.
    const wch = (core.chains.isEnabled(arg) && core.chainOf(arg)) || activeChain(chatId);
    setPending(chatId, { action: 'wd_addr', walletId: ca, chain: wch.key });
    const i = core.walletList(u).findIndex((x) => x.id === ca) + 1;
    const dh = destHint(wch.key);
    return send(chatId, `📤 <b>Withdraw ${esc(wch.native)}</b> · ${wch.emoji} ${esc(wch.name)} · <b>Wallet ${i}</b>\n<code>${esc(core.walletAddress(w, wch.key))}</code>\n\nPaste the ${dh.what} you want to send to.${dh.note ? '\n\n' + dh.note : ''}`);
  }
  if (k === 'expw') { const u = core.ensureUser(chatId); const w = core.walletById(u, ca); if (!w) { const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); } const i = core.walletList(u).findIndex((x) => x.id === ca) + 1; return send(chatId, `🔑 <b>Export Wallet ${i}</b>\n<code>${short(w.address)}</code>\n\nThis shows this wallet's <b>seed phrase</b> (if it has one) and <b>both</b> of its private keys — the EVM one and the Solana one. Anyone holding any of them can drain that wallet; the phrase gives away all of it at once. Never share them. Continue?`, rows([btn('Yes, show it', 'expwy:' + ca), btn('Cancel', 'wallets')])); }
  if (k === 'expwy') { try { await send(chatId, exportKeyMsg(chatId, ca)); } catch (e) { await send(chatId, '❌ ' + esc(e.message || String(e))); } return; }
  if (data === 'exp') return askExport(chatId);
  if (data === 'expy') { try { await send(chatId, exportKeyMsg(chatId)); } catch (e) { await send(chatId, '❌ ' + esc(e.message)); } return; }
  if (data === 'imp') { setPending(chatId, { action: 'import_key' }); return send(chatId, `📩 <b>Import a wallet</b>\n\nPaste your <b>private key</b> (64 hex) or <b>seed phrase</b> (12–24 words). It's <b>added</b> to your wallets (up to ${core.WALLET_CAP}) and made active.\n\n⚠️ I'll <b>delete your message immediately</b> after importing. Never share the secret with anyone else.`); }
  if (data === 'neww') { try { const nw = core.addWallet(chatId); report.onWallet(core.getUser(chatId), 'generated', nw.address, nw.index, core.allUsers().length); await send(chatId, `✅ <b>New wallet created</b> — Wallet ${nw.index}\n<code>${nw.address}</code>\n\nIt's now your <b>active</b> wallet. Deposit to start trading.`, rows([btn('💼 Wallet', 'wal'), btn('👛 Wallets', 'wallets')])); } catch (e) { await send(chatId, '❌ ' + esc(e.message || String(e))); } return; }
  if (k === 'sntog') {
    // OFF is immediate — this is also the 🛑 button on every auto-snipe
    // purchase message, and a stop must never grow a second step. Arming is
    // NOT a toggle any more: it routes through the amount screen, so a second
    // tap on an old 🛑 button opens Step 2 instead of silently re-arming
    // (which is what a toggle did).
    const u = core.ensureUser(chatId);
    if (u.snipe.chains && u.snipe.chains[ca]) {
      try { core.setSnipeChain(chatId, ca, false); } catch (_) {}
      const s = snipeScreen(chatId);
      return edit(chatId, mid, s.text, s.kb);
    }
    const s = snipeAmountScreen(chatId, ca);
    return edit(chatId, mid, s.text, s.kb);
  }
  if (k === 'snarm') {
    if (!core.chainOf(ca)) return;
    return armAutoSnipe(chatId, ca, arg, mid);
  }
  if (k === 'snarmc') {
    if (!core.chainOf(ca)) return;
    setPending(chatId, { action: 'snipe_amt', chain: ca });
    return send(chatId, `💵 <b>Amount per launch</b>\n\nSend the amount of <b>${esc(core.chainOf(ca).native)}</b> to spend on each new launch, e.g. <code>0.01</code>. Sniping arms the moment I have it.`);
  }
  if (k === 'snamtq') { try { core.setSnipeAmount(chatId, ca); } catch (_) {} const s = snipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'snamt') { setPending(chatId, { action: 'snipe_amt' }); return send(chatId, '💵 <b>Amount per snipe</b>\n\nEnter the amount to spend on each new launch, in the chain\'s native coin (for example <code>0.01</code>). This exact amount is used for every snipe. A small amount is recommended.'); }

  // Trade actions encode the CARD's chain: k:chain:ca[:arg]
  if (data === 'monx') { stopMonitor(chatId, mid); tg('unpinChatMessage', { chat_id: chatId, message_id: mid }).catch(() => {}); try { await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: mid, reply_markup: { inline_keyboard: [] } }); } catch (_) {} return answer(q.id, 'Monitor stopped'); }
  if (k === 'tok' || k === 'b' || k === 's' || k === 'bx' || k === 'sx' || k === 'sxt' || k === 'tp' || k === 'sl' || k === 'lb' || k === 'alt' || k === 'trl' || k === 'wt' || k === 'dca' || k === 'mon' || k === 'monn') {
    const parts = data.split(':'); const ch = parts[1], wi = parts[2], tca = parts[3], a = parts[4];
    const wobj = core.walletList(core.ensureUser(chatId))[Number(wi) - 1];
    const wid = wobj ? wobj.id : undefined;   // stale/removed index → fall back to the active wallet
    if (k === 'mon') {
      const p2 = await monitorPayload(chatId, tca, ch, wid);
      const er = await edit(chatId, mid, p2.text, p2.kb);
      // A manual refresh on a card nothing is driving (a restart orphaned it, or
      // its window ran out) used to update it exactly once and go quiet again.
      // Adopt it, so tapping 🔄 makes it live rather than static.
      if (er && er.ok && !p2.closed) adoptMonitor(chatId, tca, ch, wid, mid);
      return er;
    }
    if (k === 'monn') {
      // Await it and report what happened. It used to fire-and-forget and then
      // claim "Monitor started" unconditionally — so every failure above this
      // line showed the user a success toast and no monitor.
      const started = await startMonitor(chatId, tca, ch, wid, { surface: true }).catch(() => false);
      return answer(q.id, started ? '📍 Monitor opened below' : '⚠️ Could not open the monitor — try again');
    }
    if (k === 'tok') { const c = await tokenCard(chatId, tca, ch, wid, { side: a === 'b' ? 'buy' : a === 's' ? 'sell' : undefined }); return edit(chatId, mid, c.text, c.kb); }
    if (k === 'b') return requestBuy(chatId, tca, a, ch, wid);
    if (k === 's') return doSell(chatId, tca, Number(a), ch, wid);
    if (k === 'bx') { setPending(chatId, { action: 'buy_amt', ca: tca, chain: ch, walletId: wid }); const cn = core.chainOf(ch); return send(chatId, `💵 <b>How much do you want to spend?</b>\n\nType an amount in <b>${cn ? cn.native : 'native'}</b> (for example <code>0.05</code>) or in dollars (for example <code>$10</code>).`); }
    if (k === 'sx') { const sp = await sellMenu(chatId, tca, ch, wid); return send(chatId, sp.text, sp.kb); }
    if (k === 'sxt') { setPending(chatId, { action: 'sell_pct', ca: tca, chain: ch, walletId: wid }); return send(chatId, `✏️ <b>Custom sell amount</b>\n\nType a percentage of your holdings from <b>1</b> to <b>100</b>.\nExamples: <code>33</code> = sell a third · <code>80</code> = sell most · <code>100</code> = sell everything.`); }
    if (k === 'tp') { setPending(chatId, { action: 'tp_price', ca: tca, chain: ch, walletId: wid }); return send(chatId, await orderPrompt(tca, ch, 'tp')); }
    if (k === 'sl') { setPending(chatId, { action: 'sl_price', ca: tca, chain: ch, walletId: wid }); return send(chatId, await orderPrompt(tca, ch, 'sl')); }
    if (k === 'trl') { setPending(chatId, { action: 'trail_pct', ca: tca, chain: ch, walletId: wid }); return send(chatId, `📉 <b>Trailing stop</b> — send the trail <b>percent</b> (1–99), e.g. <code>20</code>.\n\n<i>The bot tracks the peak price from now and sells 100% if it falls that % below the peak. A rising price only ratchets the peak up.</i>`); }
    if (k === 'lb') { setPending(chatId, { action: 'lb_price', ca: tca, chain: ch, walletId: wid }); return send(chatId, `⏳ <b>Limit buy — buy automatically when the price drops</b>\n\nSend the <b>target price</b> and the <b>amount to spend</b>, separated by a space:\n• <code>0.002 0.05</code> — buy 0.05 when the price reaches $0.002\n• <code>$1.5k 0.1</code> — shorthand works here too\n\n<i>k = thousand, m = million, b = billion.</i>`); }
    if (k === 'alt') { setPending(chatId, { action: 'alert_price', ca: tca, chain: ch }); return send(chatId, `🔔 <b>Price alert</b> — send the target <b>USD price</b> and I'll ping you when <code>${short(tca)}</code> crosses it.\n\n<code>0.0025</code>  ·  <code>$2k</code>  ·  <code>101k</code>`); }
    if (k === 'wt') { setPending(chatId, { action: 'wtok_addr', ca: tca, chain: ch, walletId: wid }); const dh = destHint(ch); return send(chatId, `📤 <b>Send token</b> <code>${short(tca)}</code> out of the bot\n\nPaste the destination ${dh.what} to send to.${dh.note ? '\n\n' + dh.note : ''}`); }
    if (k === 'dca') { setPending(chatId, { action: 'dca_new', ca: tca, chain: ch, walletId: wid }); const cn = core.chainOf(ch) || {}; return send(chatId, `🔁 <b>DCA (scheduled buys)</b> for <code>${short(tca)}</code>\n\nSend <b>&lt;amount&gt; &lt;every_minutes&gt; &lt;rounds&gt;</b> in ${cn.native || ''}, e.g.\n<code>0.05 60 10</code> → buy 0.05 every 60 min, 10 times.\n\n<i>Runs on this wallet; each round is a normal buy (fee applies). Cancel anytime in 🔁 DCA.</i>`); }
  }
  if (k === 'wtokok') {
    const pp = pending.get(chatId);
    if (!pp || pp.action !== 'wtok_confirm' || Date.now() - (pp.ts || 0) > PENDING_TTL) return send(chatId, 'That confirmation expired — start again from the token card.');
    pending.delete(chatId);
    try { await send(chatId, T(chatId, 'common.sending')); const r = await core.withdrawToken(chatId, pp.ca, pp.to, pp.amt, pp.chain, pp.walletId); return send(chatId, `✅ <b>Sent</b> ${fmt(r.amount)} $${esc(r.sym)}\nto <code>${esc(pp.to)}</code>\n${txLink(pp.chain, r.hash)}`); }
    catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
  }
  if (k === 'wtokcancel') { const pp = pending.get(chatId); if (pp && (pp.action || '').startsWith('wtok')) pending.delete(chatId); return edit(chatId, mid, 'Send cancelled.', mainMenu()); }
  if (data === 'alerts') { const s = alertsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'al') { const okc = watchers.cancelAlert(chatId, ca); await answer(q.id, okc ? 'Cancelled' : 'Not found'); const s = alertsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'copy') { const s = copyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'cpsell') {
    let on = false;
    try { on = core.setCopySell(chatId, ca, !(core.ensureUser(chatId).copy.targets.find((t) => t.id === ca) || {}).copySell); } catch (_) {}
    await answer(q.id, on ? '🔻 Exit mirror ON — you sell 100% when they start selling' : '⚪ Exit mirror OFF — you manage the sell');
    const s2 = copyScreen(chatId); return edit(chatId, mid, s2.text, s2.kb);
  }
  if (data === 'cptog') { const u = core.ensureUser(chatId); try { core.setCopyOn(chatId, !(u.copy && u.copy.on)); } catch (_) {} const s = copyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'cpadd') { setPending(chatId, { action: 'copy_add', mode: 'trades' }); const ch = activeChain(chatId); const ex = core.chains.isSvm(ch.key) ? '4Nd1m… 0.05 0.5' : '0xAbc… 0.02 0.2'; return send(chatId, `👥 <b>Copy a wallet's trades</b> on ${ch.emoji} ${esc(ch.name)} (your active chain)\n\nSend: <code>&lt;wallet_address&gt; &lt;perBuy&gt; &lt;totalBudget&gt;</code>\ne.g. <code>${ex}</code>\n\nEvery <b>buy</b> the wallet makes is mirrored with <b>perBuy</b> ${ch.native} from your wallet, until <b>totalBudget</b> is used up.`); }
  if (data === 'cpaddd') {
    // Chain first, same rule as the CA snipe — and only the launchpad chains
    // are offered, so the old "switch chain with 🌐, then try again" dead end
    // (a message that sent the user away instead of asking) is gone.
    const act = activeChain(chatId);
    const pads = core.chains.enabledChains().filter((c) => core.canDevSnipe(c.key));
    if (!pads.length) return send(chatId, `🎯 Dev snipe needs a launchpad chain (<b>Robinhood Chain</b> or <b>Solana</b>) enabled on this bot.`);
    const kbR = pads.map((c) => [btn(`${c.key === act.key ? '✓ ' : ''}${c.emoji} ${c.name}`, `cpdch:${c.key}`)]);
    return send(chatId, `🎯 <b>Snipe a dev wallet</b>\n\nWhich chain does the developer launch on?`, { inline_keyboard: kbR });
  }
  if (k === 'cpdch') {
    const ch = core.chainOf(ca);
    if (!ch || !core.canDevSnipe(ch.key)) return;
    // ONE flow, not a second wizard: the dev entry points converge on the
    // panel's dev-target path ("jadiin 1 aja") — chain and kind land on the
    // draft, the address is asked for, and the panel asks the rest forward.
    try { core.updateSnipeDraft(chatId, { chain: ch.key, kind: 'dev' }); } catch (_) {}
    setPending(chatId, { action: 'snw_dev' });
    return edit(chatId, mid, T(chatId, 'snipe.panel.dev_prompt', { chain: `${ch.emoji} ${esc(ch.name)}` }), rows([btn('« Back', 'snw:open')]));
  }
  if (k === 'cprm') { core.removeCopyTarget(chatId, ca); const s = copyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'ospd') {
    // Cycle Normal → Fast → Turbo. A picker screen for a three-way choice costs
    // more taps than the choice is worth, and the label always states where it
    // now stands.
    const u = core.ensureUser(chatId);
    let found = null;
    for (const w of core.walletList(u)) for (const o of (w.orders || [])) if (o.id === ca) found = o;
    if (!found) { await answer(q.id, 'That order is gone — it filled or was cancelled.'); const s0 = ordersScreen(chatId); return edit(chatId, mid, s0.text, s0.kb); }
    const cur = watchers.orderSpeed(found);
    found.speed = SPEED_ORDER[(SPEED_ORDER.indexOf(cur) + 1) % SPEED_ORDER.length];
    core.saveStoreNow();   // execution terms are money — do not leave them in a debounce window
    await answer(q.id, SPEED_LABEL[found.speed]);
    const s1 = ordersScreen(chatId);
    return edit(chatId, mid, s1.text, s1.kb);
  }
  if (k === 'oc') { const ok = watchers.cancelOrder(chatId, ca); await answer(q.id, ok ? 'Cancelled' : 'Not found'); const s = ordersScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
}

/**
 * One line sets the whole snipe: <ca> <amount> [slip%] [tp/sl] [expiry h].
 *
 * Shared by the ⌨️ one-line arm and the 🎛 panel's Target step, so the two ways
 * in cannot drift into two grammars. Returns { err, vars } (a T() key) or the
 * parsed fields — with `amount` undefined when the line stopped at the address,
 * which the panel accepts and the one-line arm does not.
 *
 * isAddrFor(address, chainKey) — ADDRESS FIRST. Passing the chain first
 * type-checks fine and is always false, which once rejected every single arm
 * attempt with "not a valid contract address".
 *
 * tp/sl is ONE token with a slash — two bare numbers after the slippage would
 * be ambiguous with a fat-fingered second amount.
 */
function parseSnipeLine(text, chainKey) {
  const ch = core.chainOf(chainKey) || { name: chainKey, native: '' };
  const parts = String(text).trim().split(/\s+/);
  const ca = parts[0];
  if (!ca || !isAddrFor(ca, chainKey)) return { err: 'snipe.ca.bad_addr', vars: { chain: esc(ch.name) } };
  const out = { ca, amount: undefined, slipPct: 0, tpPct: 0, slPct: 0, ttlH: 0 };
  if (parts[1] !== undefined) {
    out.amount = Number(parts[1]);
    if (!(out.amount > 0)) return { err: 'snipe.ca.bad_amount', vars: { native: esc(ch.native) } };
  }
  if (parts[2] !== undefined) {
    out.slipPct = Number(String(parts[2]).replace('%', ''));
    if (!Number.isFinite(out.slipPct) || out.slipPct < 0 || out.slipPct > 50) return { err: 'snipe.ca.bad_slip' };
  }
  if (parts[3] !== undefined) {
    const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(String(parts[3]));
    if (!m) return { err: 'snipe.ca.bad_tpsl' };
    out.tpPct = Number(m[1]); out.slPct = Number(m[2]);
    if (!(out.tpPct >= 0) || !(out.slPct >= 0) || out.slPct >= 100) return { err: 'snipe.ca.bad_tpsl' };
  }
  if (parts[4] !== undefined) {
    out.ttlH = Number(parts[4]);
    if (!Number.isFinite(out.ttlH) || out.ttlH < 1 || out.ttlH > 168) return { err: 'snipe.ca.bad_ttl' };
  }
  return out;
}

async function resolvePending(chatId, p, text, m) {
  const t = text.trim();
  try {
    if (p.action === 'import_key') {
      if (m && m.message_id) await del(chatId, m.message_id);   // delete the secret FIRST
      try { const nw = core.addWallet(chatId, t); report.onWallet(core.getUser(chatId), 'imported', nw.address, nw.index, core.allUsers().length); return send(chatId, `✅ <b>Wallet imported</b> — Wallet ${nw.index}\n<code>${nw.address}</code>\n\nIt's now active and your secret message was deleted. Trade as normal.`, rows([btn('💼 Wallet', 'wal'), btn('👛 Wallets', 'wallets')])); }
      catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e)) + '\n\n(Your message was deleted for safety — try Import again.)'); }
    }
    if (p.action === 'rename_wallet') { const raw = String(t).trim(); const name = core.renameWallet(chatId, p.id, raw === '-' ? '' : raw); await send(chatId, name ? `✅ Renamed to <b>${esc(name)}</b>.` : '✅ Name reset to default.'); const s = await walletsScreen(chatId); return send(chatId, s.text, s.kb); }
    if (p.action === 'confirm_buy') { pending.set(chatId, p); return send(chatId, 'Tap ✅ Confirm or ✖ Cancel above, or /cancel.'); }   // confirm is button-driven; keep original ts (don't refresh TTL)
    if (p.action === 'buy_amt') { const cn = core.chainOf(p.chain || core.userChain(core.ensureUser(chatId))); const pa = parseAmt(t, cn.native); if (!pa) return send(chatId, `Send a positive number — in ${cn.native} (<code>0.05</code>) or USD (<code>$10</code>).`); if (pa.err) return send(chatId, '❌ ' + esc(pa.err)); return requestBuy(chatId, p.ca, pa.amt, p.chain, p.walletId); }
    if (p.action === 'sell_pct') { const pct = Number(t); if (!(pct > 0 && pct <= 100)) return send(chatId, 'Send a number 1–100.'); return doSell(chatId, p.ca, pct, p.chain, p.walletId); }
    if (p.action === 'slip_val') { const n = core.setSlippage(chatId, t); const s = settingsScreen(chatId); return send(chatId, `✅ Slippage set to <b>${n > 0 ? n + '%' : 'default (5%)'}</b>.`, s.kb); }
    if (p.action === 'bp_val') { const arr = core.setBuyPresets(chatId, t, p.chain); const cn = core.chainOf(p.chain); return send(chatId, `✅ Quick-buy for <b>${cn ? esc(cn.name) : 'this chain'}</b>: <b>${arr.join(' · ')}${cn ? ' ' + cn.native : ''}</b>.`, settingsScreen(chatId).kb); }
    if (p.action === 'ab_amt') { const r = core.setAutoBuy(chatId, undefined, t); return send(chatId, `✅ Auto-buy amount: <b>${esc(r.autoBuyAmount)}</b>.`, settingsScreen(chatId).kb); }
    if (p.action === 'snipe_amt') {
      if (!(Number(t) > 0)) return send(chatId, 'Send a positive number.');
      // With a chain on the pending step this is Step 2 of ARMING (the ✏️
      // Custom path) — the amount lands and the chain arms in one move.
      // Without one it is the plain amount editor on the snipe screen.
      if (p.chain) return armAutoSnipe(chatId, p.chain, t);
      core.setSnipeAmount(chatId, t);
      const s = snipeScreen(chatId);
      return send(chatId, s.text, s.kb);
    }
    // The chain and the wallet ride the pending step from the button that opened
    // it (📤 on the remove screen names both), and only fall back to the active
    // ones for the plain 📤 Withdraw (active) entry. Re-deriving them from the
    // active chain at each step is how a Solana withdrawal opened from an EVM
    // screen used to bounce as "not a valid Ethereum address".
    if (p.action === 'wd_addr') { const wch = (p.chain && core.chains.isEnabled(p.chain) && core.chainOf(p.chain)) || activeChain(chatId); if (!isAddrFor(t, wch.key)) return send(chatId, `❌ That doesn't look like a valid ${esc(wch.name)} address. Please check it and tap 📤 Withdraw again.`); setPending(chatId, { action: 'wd_amt', to: t, chain: wch.key, walletId: p.walletId }); return send(chatId, `💸 <b>How much do you want to send to</b>\n<code>${short(t)}</code>?\n\nType an amount in ${esc(wch.native)}, or <code>max</code> to empty the wallet (the network fee comes out of it).`); }
    if (p.action === 'wd_amt') {
      if (!(String(t).toLowerCase() === 'max' || Number(t) > 0)) return send(chatId, 'Send a positive amount, or <code>max</code>.');
      const ch = (p.chain && core.chains.isEnabled(p.chain) && core.chainOf(p.chain)) || activeChain(chatId);
      setPending(chatId, { action: 'wd_confirm', to: p.to, amt: t, chain: ch.key, walletId: p.walletId });
      const isMax = String(t).toLowerCase() === 'max';
      const who = wdWalletLine(chatId, p.walletId);
      // A Solana sweep lands the wallet on ZERO, which is the only remainder the
      // chain accepts below the rent floor — and a wallet at zero cannot pay the
      // fee to move an SPL bag afterwards. Say so before the tap, not after: on
      // EVM the gas reserve stays behind and this does not apply.
      const strand = isMax && core.chains.isSvm(ch.key)
        ? `\n\n<i>This empties the wallet completely. If it still holds tokens, send those first — a wallet with no ${esc(ch.native)} can't pay the fee to move them.</i>`
        : '';
      return send(chatId, `⚠️ <b>Confirm withdrawal</b> · ${ch.emoji} ${esc(ch.name)}${who}\n\nSend <b>${isMax ? 'every ' + esc(ch.native) + ' in this wallet' : esc(t) + ' ' + esc(ch.native)}</b> to:\n<code>${esc(p.to)}</code>\n\nThis is <b>irreversible</b>. Double-check the address.${strand}`, rows([btn('✅ Yes, send', 'wdok'), btn('✖ Cancel', 'wdcancel')]));
    }
    if (p.action === 'wd_confirm') { setPending(chatId, p); return send(chatId, 'Please tap ✅ Yes or ✖ Cancel above, or /cancel.'); }
    if (p.action === 'wd_sweep_pick') { setPending(chatId, p); return send(chatId, 'Pick the wallets with the buttons above, then tap ➡️ Next.'); }
    if (p.action === 'wd_sweep_addr') {
      const wch = core.chainOf(p.chain);
      if (!isAddrFor(t, wch.key)) return send(chatId, `❌ That doesn't look like a valid ${esc(wch.name)} address. Please check it and paste again.`);
      setPending(chatId, { action: 'wd_sweep_amt', chain: p.chain, ids: p.ids, to: t });
      return send(chatId, `💸 <b>How much from EACH of the ${p.ids.length} wallet${p.ids.length > 1 ? 's' : ''}?</b>\n\nType an amount in ${esc(wch.native)} — it is taken from <b>every</b> selected wallet — or <code>max</code> to empty them all.`);
    }
    if (p.action === 'wd_sweep_amt') {
      const isMax = String(t).toLowerCase() === 'max';
      if (!(isMax || Number(t) > 0)) return send(chatId, 'Send a positive amount, or <code>max</code>.');
      const wch = core.chainOf(p.chain);
      const n = p.ids.length;
      setPending(chatId, { action: 'wd_sweep_confirm', chain: p.chain, ids: p.ids, to: p.to, amt: t });
      // ⚠️ The amount is PER WALLET, and the confirmation does the arithmetic out
      // loud. "0.1" across ten wallets is one ETH, and a user who read it as a
      // total finds that out only afterwards — irreversibly.
      const what = isMax
        ? `every ${esc(wch.native)} in <b>all ${n} wallet${n > 1 ? 's' : ''}</b>`
        : `<b>${esc(t)} ${esc(wch.native)} from EACH</b> of ${n} wallet${n > 1 ? 's' : ''} — <b>${+(Number(t) * n).toFixed(6)} ${esc(wch.native)}</b> in total`;
      const strand = isMax && core.chains.isSvm(p.chain)
        ? `\n\n<i>This empties those wallets completely. Any that still hold tokens should send those first — a wallet with no ${esc(wch.native)} can't pay the fee to move them.</i>`
        : '';
      return send(chatId, `⚠️ <b>Confirm withdrawal</b> · ${wch.emoji} ${esc(wch.name)}\n\nSend ${what}\n\nto <code>${esc(p.to)}</code>\n\nThis is <b>irreversible</b>. Double-check the address.${strand}`,
        rows([btn('✅ Yes, send', 'wdaok'), btn('✖ Cancel', 'wdcancel')]));
    }
    if (p.action === 'wd_sweep_confirm') { setPending(chatId, p); return send(chatId, 'Please tap ✅ Yes or ✖ Cancel above, or /cancel.'); }
    if (p.action === 'wtok_addr') { const wch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId); if (!isAddrFor(t, wch.key)) return send(chatId, `❌ Not a valid ${esc(wch.name)} address. Start again from the token card.`); setPending(chatId, { action: 'wtok_amt', ca: p.ca, chain: p.chain, walletId: p.walletId, to: t }); return send(chatId, `Amount of the token to send to <code>${short(t)}</code> — a number, or <code>max</code>:`); }
    if (p.action === 'wtok_amt') {
      if (!(String(t).toLowerCase() === 'max' || Number(t) > 0)) return send(chatId, 'Send a positive amount, or <code>max</code>.');
      const wch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId);
      setPending(chatId, { action: 'wtok_confirm', ca: p.ca, chain: p.chain, walletId: p.walletId, to: p.to, amt: t });
      return send(chatId, `⚠️ <b>Confirm token send</b> · ${wch.emoji} ${esc(wch.name)}\n\nSend <b>${esc(t)}</b> of <code>${short(p.ca)}</code>\nto <code>${esc(p.to)}</code>\n\nThis is <b>irreversible</b>. On Solana a new recipient account costs ~0.002 SOL from your wallet.`, rows([btn('✅ Yes, send', 'wtokok'), btn('✖ Cancel', 'wtokcancel')]));
    }
    if (p.action === 'wtok_confirm') { setPending(chatId, p); return send(chatId, 'Please tap ✅ Yes or ✖ Cancel above, or /cancel.'); }
    if (p.action === 'tp_price' || p.action === 'sl_price') {
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId); if (!(nativeUsd(ch.native) > 0)) return send(chatId, 'Price feed unavailable — try again shortly.');
      const raw = String(t).trim();
      const isMcap = /^mc\b/i.test(raw);
      const info = {};
      const usdVal = parseUsd(raw.replace(/^mc\s*/i, ''), info);
      if (!(usdVal > 0)) return send(chatId, `Send a positive ${isMcap ? 'market cap' : 'USD price'} (or prefix with <code>mc</code> for a market-cap target).` + (info.ambiguous ? AMBIGUOUS_COMMA : ''));
      const meta = await core.tokenMeta(p.ca, ch.key);
      const type = p.action === 'tp_price' ? 'tp' : 'sl';
      // Store the target in native units of the chosen metric (price or mcap).
      const order = { type, ca: p.ca, sym: meta.sym, chain: ch.key, targetPriceEth: usdVal / nativeUsd(ch.native), sellPct: 100 };
      if (isMcap) order.metric = 'mcap';
      watchers.addOrder(chatId, order, p.walletId);
      return send(chatId, `✅ ${type === 'tp' ? 'Take-profit' : 'Stop-loss'} set for $${esc(meta.sym)} at ${isMcap ? 'market cap $' + fmt(usdVal) : '$' + usdVal} on ${ch.emoji} ${esc(ch.name)}.\n${speedNote(order)}`, rows([btn('📋 Orders', 'orders')]));
    }
    if (p.action === 'lb_price') {
      const info = {};
      const [pxStr, amtStr] = t.split(/\s+/); const usdPrice = parseUsd(pxStr, info), amount = Number(amtStr);
      if (info.ambiguous) return send(chatId, 'Could not read that price.' + AMBIGUOUS_COMMA);
      if (!(usdPrice > 0) || !(amount > 0)) return send(chatId, 'Format: <code>&lt;usd_price&gt; &lt;amount&gt;</code>');
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId); if (!(nativeUsd(ch.native) > 0)) return send(chatId, 'Price feed unavailable — try again shortly.');
      const meta = await core.tokenMeta(p.ca, ch.key);
      watchers.addOrder(chatId, { type: 'limitbuy', ca: p.ca, sym: meta.sym, chain: ch.key, targetPriceEth: usdPrice / nativeUsd(ch.native), ethAmount: String(amount) }, p.walletId);
      return send(chatId, `✅ Limit buy set: ${amount} ${ch.native} of $${esc(meta.sym)} when price ≤ $${usdPrice}.\n${speedNote({ type: 'limitbuy' })}`, rows([btn('📋 Orders', 'orders')]));
    }
    if (p.action === 'ca_snipe') {
      // ONE line: address, amount, and optionally slippage / tp,sl / expiry.
      // Three prompts would be three round trips for a feature whose whole
      // point is being ready before a pool opens. The grammar lives in
      // parseSnipeLine, shared with the 🎛 panel's Target step.
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId);
      const r = parseSnipeLine(t, ch.key);
      if (r.err) return send(chatId, T(chatId, r.err, r.vars));
      // The one-line arm REQUIRES the amount — an address alone arms nothing
      // here; only the panel, whose Amount row stays ⏳, accepts one.
      if (!(r.amount > 0)) return send(chatId, T(chatId, 'snipe.ca.bad_amount', { native: esc(ch.native) }));
      try {
        const tgt = core.addSnipeTarget(chatId, { ca: r.ca, chain: ch.key, amount: r.amount, slipBps: Math.round(r.slipPct * 100), tpPct: r.tpPct, slPct: r.slPct, ttlMs: r.ttlH > 0 ? r.ttlH * 3600000 : undefined });
        const s = caSnipeScreen(chatId);
        return send(chatId, snipeArmedText(chatId, tgt), s.kb);
      } catch (e) { return send(chatId, `⚠️ ${esc((e && e.message) || 'could not arm that')}`); }
    }
    // ── 🎛 Snipe Setup panel — the typed halves of each row editor.
    if (p.action === 'snw_ca') {
      const u = core.ensureUser(chatId);
      const d = core.snipeDraft(u) || core.newSnipeDraft(chatId);
      const first = String(t).trim().split(/\s+/)[0] || '';
      let chainKey = d.chain, switched = null;
      if (!isAddrFor(first, chainKey)) {
        // The paste knows its chain better than the row does — a base58 mint
        // under an EVM row is the wrong-chain bounce the chain-first rule
        // exists to prevent. Switch when the shape is unambiguous; ask when
        // several enabled chains fit; refuse when none does.
        const fits = core.chains.enabledChains().filter((c) => isAddrFor(first, c.key));
        if (fits.length === 1) { chainKey = fits[0].key; switched = fits[0]; }
        else if (fits.length > 1) return send(chatId, T(chatId, 'snipe.panel.which_chain'));
        else return send(chatId, T(chatId, 'snipe.ca.bad_addr', { chain: esc((core.chainOf(d.chain) || { name: d.chain }).name) }));
      }
      const r = parseSnipeLine(t, chainKey);
      if (r.err) return send(chatId, T(chatId, r.err, r.vars));
      try {
        const patch = { chain: chainKey, ca: r.ca };
        if (r.amount > 0) patch.amount = r.amount;
        if (r.slipPct > 0) patch.slipPct = r.slipPct;
        if (r.tpPct > 0 || r.slPct > 0) { patch.tpPct = r.tpPct; patch.slPct = r.slPct; }
        if (r.ttlH > 0) patch.ttlH = r.ttlH;
        core.updateSnipeDraft(chatId, patch);
      } catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
      const swNote = switched ? T(chatId, 'snipe.panel.switched', { chain: `${switched.emoji} ${switched.name}` }) : null;
      // Flow FORWARD ("jangan pisah2"): the next missing required row is asked
      // for immediately — target, then amount — instead of dropping the user
      // back at the panel to find the next ⏳ themselves. The amount screen's
      // picks return to the panel, so the panel stays the single source of
      // truth about what is set.
      const d2 = core.snipeDraft(core.ensureUser(chatId));
      if (d2 && !d2.amount) {
        const s = snwAmountScreen(chatId);
        return send(chatId, (swNote ? swNote + '\n\n' : '') + T(chatId, 'snipe.panel.target_saved') + '\n\n' + s.text, s.kb);
      }
      const s = snipeSetupScreen(chatId, swNote);
      return send(chatId, s.text, s.kb);
    }
    if (p.action === 'snw_amt') {
      const u = core.ensureUser(chatId);
      const d = core.snipeDraft(u) || core.newSnipeDraft(chatId);
      const ch = core.chainOf(d.chain) || { native: '' };
      // parseAmt, not Number(): it reads "0,05" the way the buy fields do and
      // converts a $usd amount at the live rate — the panel must not be the one
      // place a decimal comma is silently invalid.
      const pa = parseAmt(t, ch.native);
      if (!pa) return send(chatId, T(chatId, 'snipe.panel.amt_prompt', { native: esc(ch.native) }));
      if (pa.err) return send(chatId, '❌ ' + esc(pa.err));
      try { core.updateSnipeDraft(chatId, { amount: pa.amt }); } catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
      const s = snipeSetupScreen(chatId);
      return send(chatId, s.text, s.kb);
    }
    if (p.action === 'snw_slip') {
      const n = Number(String(t).replace('%', '').replace(',', '.'));
      try { core.updateSnipeDraft(chatId, { slipPct: n }); } catch (e) { return send(chatId, T(chatId, 'snipe.ca.bad_slip')); }
      const s = snipeSetupScreen(chatId);
      return send(chatId, s.text, s.kb);
    }
    if (p.action === 'snw_tpsl') {
      const raw = String(t).trim().toLowerCase();
      let tp = 0, sl = 0;
      if (raw !== 'off' && raw !== '0' && raw !== '0/0') {
        const m = /^\+?(\d+(?:[.,]\d+)?)\s*[\/\s]\s*[−-]?(\d+(?:[.,]\d+)?)%?$/.exec(raw.replace(/%/g, ''));
        if (!m) return send(chatId, T(chatId, 'snipe.ca.bad_tpsl'));
        tp = Number(m[1].replace(',', '.')); sl = Number(m[2].replace(',', '.'));
      }
      try { core.updateSnipeDraft(chatId, { tpPct: tp, slPct: sl }); } catch (e) { return send(chatId, T(chatId, 'snipe.ca.bad_tpsl')); }
      const s = snipeSetupScreen(chatId);
      return send(chatId, s.text, s.kb);
    }
    if (p.action === 'snw_ttl') {
      try { core.updateSnipeDraft(chatId, { ttlH: Number(String(t).replace(',', '.')) }); } catch (e) { return send(chatId, T(chatId, 'snipe.ca.bad_ttl')); }
      const s = snipeSetupScreen(chatId);
      return send(chatId, s.text, s.kb);
    }
    if (p.action === 'ae_val') {
      const parts = String(t).trim().split(/\s+/);
      const tp = Number(parts[0]), sl = Number(parts[1]);
      if (!Number.isFinite(tp) || !Number.isFinite(sl)) return send(chatId, 'Send two numbers: <b>&lt;take-profit%&gt; &lt;stop-loss%&gt;</b>, e.g. <code>100 50</code> (or <code>0 0</code> to disable).');
      const r = core.setAutoExit(chatId, tp, sl);
      const desc = (r.autoTpPct > 0 || r.autoSlPct > 0) ? [(r.autoTpPct > 0 ? 'TP +' + r.autoTpPct + '%' : ''), (r.autoSlPct > 0 ? 'SL −' + r.autoSlPct + '%' : '')].filter(Boolean).join(' · ') : 'OFF';
      return send(chatId, `✅ Auto-exit: <b>${desc}</b>.`, settingsScreen(chatId).kb);
    }
    if (p.action === 'dca_new') {
      const parts = String(t).trim().split(/\s+/);
      const amount = Number(parts[0]), interval = Number(parts[1]), rounds = Number(parts[2]);
      if (!(amount > 0) || !(interval >= 1) || !(rounds >= 1)) return send(chatId, 'Send <b>&lt;amount&gt; &lt;every_minutes&gt; &lt;rounds&gt;</b>, e.g. <code>0.05 60 10</code>.');
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId);
      try {
        const meta = await core.tokenMeta(p.ca, ch.key);
        const plan = watchers.addDca(chatId, { ca: p.ca, sym: meta.sym, chain: ch.key, amount, intervalMin: interval, rounds }, p.walletId);
        return send(chatId, `✅ <b>DCA started</b> — buy <b>${esc(String(amount))} ${ch.native}</b> of $${esc(meta.sym)} every <b>${plan.intervalMin} min</b>, <b>${plan.rounds}×</b>.\nFirst buy within a minute. Total ≈ ${(amount * plan.rounds).toPrecision(3)} ${ch.native}.`, rows([btn('🔁 My DCA', 'dcas'), btn('« Menu', 'menu')]));
      } catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
    }
    if (p.action === 'trail_pct') {
      const pct = Number(t);
      if (!(pct > 0 && pct < 100)) return send(chatId, 'Send a trail percent between 1 and 99, e.g. <code>20</code>.');
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId);
      try {
        const meta = await core.tokenMeta(p.ca, ch.key);
        watchers.addOrder(chatId, { type: 'trail', ca: p.ca, sym: meta.sym, chain: ch.key, trailPct: pct, sellPct: 100 }, p.walletId);
        return send(chatId, `✅ <b>Trailing stop set</b> · −${pct}% from the peak on $${esc(meta.sym)}.\n${speedNote({ type: 'trail' })}\n<i>Sells 100% when the price falls ${pct}% below its highest point after now.</i>`, rows([btn('📋 Orders', 'orders')]));
      } catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
    }
    if (p.action === 'wl_add') {
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId);
      try { const e = core.addWhitelist(chatId, t, ch.key); const s = securityScreen(chatId); return send(chatId, `✅ Whitelisted <code>${esc(e.address)}</code> on ${ch.emoji} ${esc(ch.name)}. Withdrawals on this chain are now restricted to your whitelist.`, s.kb); }
      catch (e2) { return send(chatId, '❌ ' + esc(e2.message)); }
    }
    // ── the panel's dev-wallet target: address (+ optional one-line tail).
    if (p.action === 'pnl_ca') {
      const raw = String(t).trim().split(/\s+/)[0];
      if (!isCa(raw)) return send(chatId, T(chatId, 'pnl.bad_ca'));
      const det = await detectChain(chatId, raw);
      return sendPnlCard(chatId, raw, det.chain || core.userChain(core.ensureUser(chatId)));
    }
    if (p.action === 'snw_dev') {
      const u = core.ensureUser(chatId);
      const d = core.snipeDraft(u) || core.newSnipeDraft(chatId);
      const parts = String(t).trim().split(/\s+/).filter(Boolean);
      const addr = parts[0] || '';
      let chainKey = d.chain, switched = null;
      if (!isAddrFor(addr, chainKey)) {
        // Same rule as the CA paste: the paste knows its chain better than the
        // row — switch when the shape is unambiguous, ask when it is not.
        const fits = core.chains.enabledChains().filter((c) => isAddrFor(addr, c.key));
        if (fits.length === 1) { chainKey = fits[0].key; switched = fits[0]; }
        else if (fits.length > 1) return send(chatId, T(chatId, 'snipe.panel.which_chain'));
        else return send(chatId, T(chatId, 'dev.bad_addr', { chain: esc((core.chainOf(d.chain) || { name: d.chain }).name) }));
      }
      const chN = core.chainOf(chainKey) || { native: '' };
      const patch = { chain: chainKey, kind: 'dev', ca: addr };
      // The old one-line (`<wallet> <perBuy>`) still lands in one go: an extra
      // word on the line is the amount question, answered early. A THIRD word
      // used to be the budget and is now ignored rather than refused — an
      // operator with the old grammar in muscle memory must not have their
      // target rejected over a setting that no longer exists.
      if (parts[1] !== undefined) {
        const a = Number(String(parts[1]).replace(',', '.'));
        if (!(a > 0)) return send(chatId, T(chatId, 'dev.bad_amt', { native: esc(chN.native) }));
        patch.amount = a;
      }
      try { core.updateSnipeDraft(chatId, patch); } catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
      const swNote = switched ? T(chatId, 'snipe.panel.switched', { chain: `${switched.emoji} ${switched.name}` }) : null;
      // A plain paste ALWAYS asks the amount next — even when a previous draft
      // had one ("pas udah drop wallet harusnya ada custom amount"): the spend
      // is confirmed per target, the buy-ngasal rule at the wizard level. A
      // line that already carried the amount goes straight to the panel.
      if (parts[1] === undefined) {
        setPending(chatId, { action: 'snw_amt' });
        const s = snwAmountScreen(chatId);
        return send(chatId, (swNote ? swNote + '\n\n' : '') + T(chatId, 'snipe.panel.target_saved') + '\n\n' + s.text, s.kb);
      }
      const s = snipeSetupScreen(chatId, swNote);
      return send(chatId, s.text, s.kb);
    }
    if (p.action === 'copy_add') {
      const parts = t.split(/\s+/).filter(Boolean);
      if (parts.length < 3) return send(chatId, 'Format: <code>&lt;wallet&gt; &lt;perBuy&gt; &lt;totalBudget&gt;</code>, e.g. <code>0xAbc… 0.02 0.2</code>');
      // The chain the user PICKED in the prompt step, when there was one —
      // falling back to the active chain here would silently re-bind a dev
      // snipe to a different chain than the prompt named.
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId);
      const mode = p.mode === 'launches' ? 'launches' : 'trades';
      try {
        const tgt = core.addCopyTarget(chatId, parts[0], ch.key, parts[1], parts[2], mode);
        const u2 = core.ensureUser(chatId);
        const onNote = (u2.copy && u2.copy.on) ? 'The master switch is ON — it is live now.' : 'Turn the master switch ON to start.';
        if (mode === 'launches') return send(chatId, `✅ <b>Dev snipe armed</b> 🎯\nWatching <code>${short(tgt.address)}</code> on ${ch.emoji} ${esc(ch.name)} — when it launches a new token I'll buy <b>${esc(tgt.buyEth)} ${ch.native}</b>.\n⚠️ <i>No spending cap — it buys EVERY launch until you turn it off.</i>\n${onNote}`, rows([btn('👥 Copy & Snipe', 'copy')]));
        return send(chatId, `✅ <b>Copying trades</b> 👥\nFollowing <code>${short(tgt.address)}</code> on ${ch.emoji} ${esc(ch.name)} — ${esc(tgt.buyEth)} ${ch.native}/buy, budget ${esc(tgt.maxEth)}.\n${onNote}`, rows([btn('👥 Copy & Snipe', 'copy')]));
      } catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
    }
    if (p.action === 'alert_price') {
      const info = {};
      const usdPrice = parseUsd(t, info);
      if (!(usdPrice > 0)) return send(chatId, 'Send a positive USD price — <code>0.0025</code>, <code>$2k</code>, <code>101k</code>.' + (info.ambiguous ? AMBIGUOUS_COMMA : ''));
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId); if (!(nativeUsd(ch.native) > 0)) return send(chatId, 'Price feed unavailable — try again shortly.');
      const meta = await core.tokenMeta(p.ca, ch.key);
      const snap = await core.tokenSnapshot(p.ca, ch.key).catch(() => null);   // infer direction from current price
      const curUsd = snap ? snap.priceEth * nativeUsd(ch.native) : null;
      // Don't GUESS the direction — a bad guess fires an immediate wrong-worded alert.
      // For a fresh/illiquid token with no readable price, ask the user to retry.
      if (!(curUsd > 0)) return send(chatId, 'Could not read the current price to set the alert direction — try again in a moment.');
      if (Math.abs(usdPrice - curUsd) <= curUsd * 1e-6) return send(chatId, `That target ($${usdPrice}) is essentially the current price — pick a target clearly above or below it.`);
      const dir = usdPrice < curUsd ? 'below' : 'above';
      watchers.addAlert(chatId, { ca: p.ca, sym: meta.sym, chain: ch.key, targetPriceEth: usdPrice / nativeUsd(ch.native), targetUsd: usdPrice, dir });
      return send(chatId, `✅ Alert set: I'll ping you when $${esc(meta.sym)} goes <b>${dir}</b> $${usdPrice}.`, rows([btn('🔔 Alerts', 'alerts')]));
    }
  } catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
}

// Export message: the key ALWAYS travels with the wallet label and the FULL
// address it controls, so someone saving keys for several wallets can never
// mismatch key ↔ address later. Chain-aware: on Solana the Solana key+address
// are exported (different curve); on EVM the 0x key that is the same address
// on every EVM chain.
function exportKeyMsg(chatId, walletId) {
  const u = core.ensureUser(chatId);
  const w = walletId ? core.walletById(u, walletId) : core.activeWallet(u);
  if (!w) throw new Error('wallet not found');
  const i = core.walletList(u).findIndex((x) => x.id === w.id) + 1;
  const label = core.walletLabel(w, i);
  const sol = core.chains.enabledChains().find((c) => core.chains.isSvm(c.key));
  // BOTH KEYS, ALWAYS — a wallet here is two keypairs, and "export the key
  // first" is the instruction the remove screen gives before the row (and both
  // of them) disappears.
  //
  // THIS USED TO EXPORT WHICHEVER HALF MATCHED THE ACTIVE CHAIN and print a note
  // telling the user to switch 🌐 and come back for the other. Anyone who
  // followed the removal advice from an EVM screen got the EVM key, deleted the
  // wallet, and had nothing at all for the SOL sitting on the other side of the
  // same row. A note is not a safeguard when the next tap is destructive.
  const parts = [];
  try { parts.push(`Address (same on every EVM chain):\n<code>${esc(w.address)}</code>\n\nEVM private key:\n<code>${esc(core.exportKey(chatId, w.id))}</code>`); }
  catch (e) { parts.push(`⚠️ Couldn't read the EVM key: ${esc(e.message || String(e))}`); }
  if (sol) {
    try { parts.push(`Solana address:\n<code>${esc(core.walletAddress(w, sol.key))}</code>\n\nSolana private key — paste this into Phantom or Solflare:\n<code>${esc(core.exportKey(chatId, w.id, sol.key))}</code>`); }
    catch (e) { parts.push(`⚠️ Couldn't read the Solana key: ${esc(e.message || String(e))}`); }
  }
  // A failed read must never pass for "this wallet only had one key".
  if (parts.every((x) => x.startsWith('⚠️'))) throw new Error('could not read this wallet\'s keys — nothing was exported.');

  // The phrase leads, because it is the one thing that restores BOTH sides in a
  // single import — the two keys below need two imports into two different apps.
  // Its ABSENCE is the ordinary case and is stated rather than left blank: every
  // wallet made before the phrase was kept has none, and a wallet imported from a
  // bare private key never had one. Silence there reads as a bot that forgot to
  // print it, which sends people looking for a phrase that does not exist.
  let phrase = null;
  try { phrase = core.exportMnemonic(chatId, w.id); } catch (_) { phrase = null; }
  let out = `🔑 <b>${phrase ? 'Seed phrase &amp; private keys' : 'Private keys'} — ${esc(label)}</b> <i>(delete this message after saving)</i>\n\n`;
  if (phrase) {
    out += `<b>Seed phrase</b> — restores this whole wallet, both sides, in one import:\n<code>${esc(phrase)}</code>\n\n`
      + `<i>⚠️ This is more powerful than the keys below: anyone holding it can derive every address of this wallet on every chain.</i>\n\n`;
  }
  out += parts.join('\n\n');
  if (sol) {
    out += phrase
      ? `\n\n<i>The two keys above are the same wallet, one side each — use them if your app takes keys rather than a phrase.</i>`
      : `\n\n<i>These are two different keys for one wallet — save both. This wallet has <b>no seed phrase</b>: it predates the bot keeping them, or it was imported from a private key. Two imports, one per side, is the only way to restore it.</i>`;
  }
  return out;
}
// ---- live position monitor (Maestro-style) ------------------------------
// After every buy the bot posts a Monitor message for that token and keeps
// EDITING it (every 45s, for 30 min, bounded) so the position report is live:
// initial vs worth, P/L %, tokens, price/MC. Manual 🔄 works anytime; ✖ Stop
// ends the auto-refresh. One interval per message, cleaned up on stop/error.
const _monitors = new Map();   // `${chatId}:${msgId}` → { timer, until, chainKey, wid, closedStreak, stopped }
// "Sell some %" picker — opened from the 🔻 Sell X% button on the card or the
// live Monitor. Shows the live bag + what each preset would sell (in tokens AND
// dollars), so the choice is obvious. Presets fire a normal Sell; ✏️ Custom lets
// the user type any 1–100%. Sent as a NEW message so it never overwrites the
// pinned Monitor or the card it was opened from.
async function sellMenu(chatId, ca, chainKey, wid) {
  const u = core.ensureUser(chatId);
  const ch = core.chainOf(chainKey);
  const w = (wid && core.walletById(u, wid)) || core.activeWallet(u);
  const wi = walletIndex(chatId, w && w.id);
  const nat = ch.native; const usdRate = nativeUsd(nat);
  let sym = '?', balNow = 0, px = 0, dec = 18;
  try { const meta = await core.tokenMeta(ca, chainKey); if (meta) { sym = meta.sym || sym; dec = meta.decimals || 18; } } catch (_) {}
  try { const raw = await withTmo(core.tokenBalance(ca, wAddr(w, chainKey), chainKey).catch(() => null), 5000, null); if (raw != null) balNow = Number(ethers.formatUnits(raw, dec)); } catch (_) {}
  try { const snap = await withTmo(core.tokenSnapshot(ca, chainKey).catch(() => null), 5000, null); if (snap) { if (snap.priceEth > 0) px = snap.priceEth; if (snap.sym) sym = snap.sym; } } catch (_) {}
  const val = balNow * px;
  const worth = (pct) => (px > 0 ? ` → ~${usd((val * pct) / 100, nat)}` : '');
  // Same lie as the monitor card had: this header names ONE wallet, and the
  // buttons below route through tradeTargets() — the multi-wallet selection.
  const selIds = new Set(core.tradeWalletIds(chatId));
  const scopeN = selIds.size || 1;
  const scope = scopeN > 1
    ? `💳 <b>${scopeN} wallets</b> <i>(your trade selection)</i>`
    : `💳 ${esc(core.walletLabel(w, wi))}`;
  const L = [`🔻 <b>Sell $${esc(sym)}</b>`, `${ch.emoji} ${esc(ch.name)} · ${scope}`, ''];
  if (balNow > 1e-9) {
    L.push(`🎒 You hold: <b>${fmt(balNow)} $${esc(sym)}</b>${px > 0 ? ` · ${usd(val, nat)}` : ''}`);
    L.push('');
    L.push('<b>How much do you want to sell?</b>');
    L.push(`• 25% = ${fmt(balNow * 0.25)} $${esc(sym)}${worth(25)}`);
    L.push(`• 50% = ${fmt(balNow * 0.50)} $${esc(sym)}${worth(50)}`);
    L.push(`• 75% = ${fmt(balNow * 0.75)} $${esc(sym)}${worth(75)}`);
    L.push(`• 100% = everything${worth(100)}`);
    L.push('');
    // Say which kind of order the buttons are. Every preset here fills at
    // whatever the market pays the moment it is tapped; the limit and stop
    // options below wait for a price instead. A screen that offers only one of
    // the two and never names it leaves the user to assume the wrong one.
    if (scopeN > 1) {
      // The amounts above are this wallet's bag. The buttons sell that
      // percentage of EACH selected wallet's bag, which is a different number.
      L.push(`⚠️ <i>Multi-wallet is on: a preset sells that % on <b>each of your ${scopeN} selected wallets</b>, not only this one. The amounts above are this wallet's bag.</i>`);
      L.push('');
    }
    L.push('⚡ <b>Market</b> — the presets below sell <b>now</b>, at whatever price the pool gives.');
    L.push('🎯 <b>Limit</b> — sell automatically when the price REACHES a target you set.');
    L.push('🛑 <b>Stop-loss</b> — sell automatically if the price FALLS to a level you set.');
    L.push('');
    L.push('<i>Tap a preset to sell now, or set a limit / stop below.</i>');
  } else {
    L.push(`<i>This wallet holds no $${esc(sym)} to sell right now.</i>`);
  }
  const kb = { inline_keyboard: balNow > 1e-9 ? [
    [btn('Sell 10%', `s:${chainKey}:${wi}:${ca}:10`), btn('Sell 25%', `s:${chainKey}:${wi}:${ca}:25`), btn('Sell 33%', `s:${chainKey}:${wi}:${ca}:33`)],
    [btn('Sell 50%', `s:${chainKey}:${wi}:${ca}:50`), btn('Sell 75%', `s:${chainKey}:${wi}:${ca}:75`), btn('Sell 90%', `s:${chainKey}:${wi}:${ca}:90`)],
    [btn('💯 Sell 100% (all)', `s:${chainKey}:${wi}:${ca}:100`)],
    [btn('✏️ Custom %', `sxt:${chainKey}:${wi}:${ca}`)],
    // The limit sell existed only as "🎯 TP" on the token card. Someone who
    // has decided to sell is in THIS screen, and it offered them nothing but
    // market orders.
    [btn('🎯 Limit sell', `tp:${chainKey}:${wi}:${ca}`), btn('🛑 Stop-loss', `sl:${chainKey}:${wi}:${ca}`)],
    [btn('📉 Trailing stop', `trl:${chainKey}:${wi}:${ca}`)],
    [btn('🔎 Card', `tok:${chainKey}:${wi}:${ca}`), btn('« Menu', 'menu')],
  ] : [
    [btn('🔎 Card', `tok:${chainKey}:${wi}:${ca}`), btn('« Menu', 'menu')],
  ] };
  return { text: L.join('\n'), kb };
}
async function monitorPayload(chatId, ca, chainKey, wid) {
  const u = core.ensureUser(chatId);
  const ch = core.chainOf(chainKey);
  const w = (wid && core.walletById(u, wid)) || core.activeWallet(u);
  const wi = walletIndex(chatId, w && w.id);
  const posKey = core.posKey(chainKey, ca);
  const pos = w && (w.positions || {})[posKey];
  // PARALLEL. These two reads are independent and used to run in series, so a
  // slow chain paid both timeouts back to back — up to 11s per refresh, on a
  // card whose whole job is to feel live.
  //
  // The balance read covers EVERY wallet, not just the one the monitor was
  // opened on. A multi-wallet buy fills three or four wallets at once and the
  // card only ever showed one of them, so the P/L on screen was a fraction of
  // the position the user actually held, with no hint the rest existed.
  //
  // The socials lookup joins them rather than being awaited after: it is cached
  // for half an hour inside tokeninfo, so on a refresh it costs nothing, and on
  // the first render it must not add its own timeout to the card's.
  const [snap, allBals, links] = await Promise.all([
    withTmo(core.tokenSnapshot(ca, chainKey).catch(() => null), SNAP_TMO_MS, null),
    withTmo(core.tokenBalancesAcross(chatId, ca, chainKey).catch(() => []), BAL_TMO_MS, []),
    withTmo(tokeninfo.socials(ca, chainKey).catch(() => null), SNAP_TMO_MS, null),
  ]);
  const nat = ch.native; const usdRate = nativeUsd(nat);
  const inUsd = (v) => (usdRate > 0 ? ` ($${(v * usdRate).toFixed(2)})` : '');
  // A SYMBOL IS A PROPERTY OF THE TOKEN, not of one wallet's position record —
  // exactly the defect the decimals note below describes, one line further on.
  // `pos` is only the BOUND wallet, so a card opened on Wallet 1 while Wallets
  // 2-4 hold the token found no record; and tokenSnapshot carries `sym` only on
  // the Solana/DEX branch (core.js:1101) — the EVM curve snapshot has no such
  // field — so there was nothing to fall back to and the card printed "$?" in
  // its own title, four times over, on a position worth real money.
  //
  // Cheapest source first. The wallet scan is in-memory and resolves the case
  // above without a single request; tokenMeta is a network call and therefore
  // last, reached only when no wallet has ever recorded this token.
  let sym = (pos && pos.sym) || (snap && snap.sym) || '';
  if (!sym) {
    for (const wal of core.walletList(u)) {
      const q = (wal.positions || {})[posKey];
      if (q && q.sym) { sym = q.sym; break; }
    }
  }
  if (!sym) {
    const meta = await withTmo(core.tokenMeta(ca, chainKey).catch(() => null), SNAP_TMO_MS, null);
    sym = (meta && meta.sym) || '';
  }
  // Still nothing: name the token by its CONTRACT rather than by a punctuation
  // mark. "$?" tells the reader their money is in something the bot cannot even
  // name; the short address at least identifies it and can be searched.
  const symTxt = sym ? `$${esc(sym)}` : `<code>${esc(short(ca))}</code>`;
  // DECIMALS ARE A PROPERTY OF THE TOKEN, not of one wallet's position record.
  // This read `(pos && pos.dec) || 18`, where `pos` is only the BOUND wallet's
  // record — so a wallet holding the token with no record of its own (exactly
  // the wallet the uncosted-token handling exists to describe) was decoded with
  // a hardcoded 18. Every Solana SPL is 6 or 9: a real bag of 675 tokens
  // rendered as "0.0000 $PONS · worth $0.00", on the very wallet the Sell
  // buttons act on.
  //
  // The SNAPSHOT already carries them — it is in the batch above and costs
  // nothing extra. Adding a tokenMeta call here would have been a fourth network
  // dependency on a card that re-renders on a timer, for a number the first
  // read already knew.
  const anyRecordedDec = (() => {
    for (const wal of core.walletList(u)) { const p = (wal.positions || {})[posKey]; if (p && Number.isFinite(p.dec)) return p.dec; }
    return null;
  })();
  const dec = (snap && Number.isFinite(snap.decimals) ? snap.decimals : null)
    ?? (pos && Number.isFinite(pos.dec) ? pos.dec : null)
    ?? anyRecordedDec
    ?? (core.chains.isSvm(chainKey) ? 9 : 18);

  // One row per wallet that has any stake in this token — a live bag, or a cost
  // basis on record (which is what a wallet whose read just failed still has).
  //
  // Built from the WALLET LIST and not from the balance read, because the read is
  // the thing that fails. Deriving the rows from it meant a read that threw
  // produced no rows, hence no cost basis, hence "no open position" — the exact
  // failure the null-not-zero handling below exists to prevent, reintroduced one
  // level up.
  const balById = new Map(allBals.map((b) => [b.id, b.raw]));
  const holders = [];
  let blind = 0;   // wallets with a stake we could not read AND have no recorded size for
  core.walletList(u).forEach((wal, i) => {
    const p = (wal.positions || {})[posKey];
    const recordedCost = posCost(p);
    let recorded = 0;   // how many tokens this wallet held at its LAST trade through the bot
    if (p && p.tokens != null) { try { recorded = Number(ethers.formatUnits(BigInt(p.tokens), dec)); } catch (_) { recorded = 0; } }
    const raw = balById.has(wal.id) ? balById.get(wal.id) : null;
    let tokens = 0, known = false, stale = false;
    if (raw != null) {
      tokens = Number(ethers.formatUnits(raw, dec));
      known = true;
    } else if (recorded > 0) {
      // Fall back to what the buy recorded, and SAY so — a failing RPC must not
      // render identically to a live read.
      tokens = recorded; stale = true;
    }
    // RECONCILE the live bag against the recorded one. They are two different
    // measurements and were being divided by each other:
    //
    //   • A balance ABOVE what the last trade recorded arrived from somewhere
    //     the bot never priced — an airdrop, a transfer in, a buy made
    //     elsewhere. Charging it against this wallet's entry price valued 675
    //     donated tokens at the cost of the 75 that were bought, and printed
    //     🟢 +297% on a position that was down 0.64%.
    //   • A balance BELOW it means some of the bag left out of band. Keeping the
    //     whole basis against what remains printed 🔴 −100% on a winner, purely
    //     for moving tokens between the user's own wallets.
    //
    // costed/cost stay in step, so any ratio built from them measures one thing.
    const costed = Math.min(tokens, recorded);
    const cost = recorded > 0 ? recordedCost * (costed / recorded) : 0;
    const uncosted = Math.max(0, tokens - recorded);
    // No live read and nothing on record is NO INFORMATION. Such a wallet used
    // to keep its full cost in the denominator while contributing zero tokens to
    // the numerator, which printed a large confident loss over an RPC blip — and
    // its row asserted "worth $0.00 · 🔴 −100.00%" directly under the word
    // "(unreadable)".
    if (!known && !stale && recordedCost > 0) { blind++; return; }
    if (tokens > 0 || cost > 0) {
      holders.push({ id: wal.id, index: i + 1, label: core.walletLabel(wal, i + 1), tokens, cost, costed, uncosted, known, stale });
    }
  });
  // The wallet the card is bound to leads the list; its buttons are the ones that
  // sell, so it must be the one being read about first.
  holders.sort((a, b2) => (a.id === (w && w.id) ? -1 : b2.id === (w && w.id) ? 1 : b2.tokens - a.tokens));

  const balNow = holders.reduce((t, h) => t + h.tokens, 0);
  const cost = holders.reduce((t, h) => t + h.cost, 0);
  // Tokens the bot has no entry price for — airdropped, sent in from elsewhere,
  // or bought outside the bot. They belong in what you HOLD and in what it is
  // WORTH; they must never reach the profit line.
  //
  // Dividing the value of THREE wallets by the cost of TWO is how a position
  // that is down 0.64% printed "🟢 +49.04%". Same arithmetic, same lie, as the
  // portfolio card's old "2.13× (+113%)" over two losing positions: a ratio
  // whose numerator and denominator are counting different things.
  //
  // Per WALLET was not fine enough. `h.cost > 0 ? h.tokens : 0` priced a costed
  // wallet's ENTIRE live balance, so the split only worked when the uncosted
  // tokens happened to land on a wallet with no position at all. The same 675
  // tokens read +297% or −0.64% depending only on which of the user's own
  // wallets received them. It is per TOKEN now.
  const pricedTokens = holders.reduce((t, h) => t + h.costed, 0);
  const unpricedTokens = holders.reduce((t, h) => t + h.uncosted, 0);
  // Known only if EVERY wallet with a stake answered: a partial read must not be
  // allowed to close a position another wallet may still hold.
  const balKnown = holders.length > 0 && holders.every((h) => h.known);
  const balStale = holders.some((h) => h.stale);
  const multi = holders.length > 1;

  let closed = false;
  // The header names the BOUND wallet, always. The Sell buttons on this card act
  // on that wallet (or the user's trade selection) — never on every wallet in the
  // list — so a header reading "3 wallets" over a "Sell 100%" button is an
  // invitation to sell a third of a position and believe it is all of it. The
  // multi-wallet total lives in the body, where it cannot be mistaken for scope.
  // WHICH WALLETS THE SELL BUTTONS ACTUALLY TOUCH.
  //
  // doSell routes through tradeTargets(), which uses the user's multi-wallet
  // trade SELECTION and only falls back to this card's wallet when there is
  // none. The card marked the BOUND wallet "⬅️ Sell acts here" regardless — so
  // with a selection active it named one wallet while Sell 100% emptied four.
  //
  // That is the wrong direction to be wrong in. The marker was added because a
  // header reading "3 wallets" over a Sell button looked like an invitation to
  // sell a third of a position believing it was all of it; naming one wallet
  // over a button that empties four is the same mistake with the loss reversed.
  const selIds = new Set(core.tradeWalletIds(chatId));
  const selN = selIds.size;
  const inScope = (id) => (selN ? selIds.has(id) : id === (w && w.id));
  const scopeN = selN || 1;
  const scopeHolding = holders.filter((h) => inScope(h.id)).length;
  const more = multi ? ` <i>· +${holders.length - 1} more below</i>` : '';
  const L = [`📍 <b>Live position — ${symTxt}</b>\n${ch.emoji} ${esc(ch.name)} · 💳 ${esc(core.walletLabel(w, wi))}${more}\n`];
  // Reading the LIVE on-chain balance (not pos.tokens) is what stops tokens sent
  // out via 📤 Send from leaving the Monitor showing a phantom bag with fake PnL.
  //
  // A FAILED read is not a zero balance. tokenBalance() collapsed both to 0n, so
  // one flaky RPC right after a buy rendered "No open position", and the next
  // tick then unpinned and killed the monitor for good — on a position that had
  // filled. tokenBalancesAcross() reports null per wallet on failure, and only a
  // real, successful zero is allowed to close anything.
  // Holding the token IS the position. Keyed on cost alone, a bag with no
  // recorded entry — airdropped, sent in, bought elsewhere — rendered "No open
  // position", hid the Sell buttons and let the monitor retire itself, on
  // tokens the user was holding and could have sold from that very card.
  const noPosition = !(cost > 0) && !(balNow > 0);
  if (noPosition || (balKnown && !(balNow > 0))) {
    closed = true;
    L.push('<i>No open position right now — you have sold it, or have not bought yet.</i>');
  } else if (!balKnown && !(balNow > 0)) {
    // We hold a position on record but could not read the chain and have no
    // recorded size. Say so instead of declaring it closed.
    L.push('<i>Balance unavailable right now — retrying.</i>');
  } else {
    const px = snap && snap.priceEth > 0 ? snap.priceEth : 0;
    const val = balNow * px;
    // Say when the bag is the one the BUY recorded rather than one read from the
    // chain just now — otherwise a failing RPC renders identically to a live
    // read, and tokens sent out with 📤 would show as a bag the user still has.
    // The bag's share of supply, from the same cached read the receipts use.
    // Bounded, and absent (never 0%) when the supply cannot be read.
    const supUi = await withTmo(core.tokenSupplyUi(ca, chainKey, dec).catch(() => null), 1200, null);
    const supTxt = pnl.share(supUi > 0 ? (balNow / supUi) * 100 : null);
    L.push(`🎒 <b>You hold:</b> ${fmt(balNow)} ${symTxt}${supTxt ? ` · <b>${supTxt}</b> of supply` : ''}${multi ? ` <i>across ${holders.length} wallets</i>` : ''}${balStale ? ' <i>(last known — chain unreachable)</i>' : ''}`);
    L.push(`💵 <b>Invested:</b> ${cost.toFixed(5)} ${nat}${inUsd(cost)}`);
    L.push(`💰 <b>Now worth:</b> ${px > 0 ? val.toFixed(5) + ' ' + nat + inUsd(val) : '—'}`);
    if (px > 0 && cost > 0) {
      // The sign goes in FRONT of the currency, and there is one minus sign, not
      // two. Built from toFixed() on a negative this printed "$-0.05" beside
      // "-0.76%" — a hyphen, a dollar sign and a minus all disagreeing on one
      // line about which part of the number is negative.
      //
      // Measured against the tokens that HAVE an entry price, never against the
      // whole bag — see pricedTokens.
      const unreal = (pricedTokens * px) - cost; const pct = (unreal / cost) * 100;
      const sg = unreal >= 0 ? '+' : '−';
      const usdPart = usdRate > 0 ? `, ${sg}$${Math.abs(unreal * usdRate).toFixed(2)}` : '';
      L.push(`${unreal >= 0 ? '🟢' : '🔴'} <b>Profit/Loss:</b> ${sg}${Math.abs(pct).toFixed(2)}% (${sg}${Math.abs(unreal).toFixed(5)} ${nat}${usdPart})`);
    }
    // Never silently. A number left out of a total has to be named, or the total
    // reads as covering everything.
    // Gated on what the reader can SEE. At 1e-12 the note fired on dust and
    // announced "ℹ️ 0.0000 $PONS has no entry price on record", which reads as a
    // bug rather than as information.
    if (fmtNZ(unpricedTokens)) {
      L.push(`ℹ️ <i>${fmt(unpricedTokens)} ${symTxt} has no entry price on record (sent in, or bought outside the bot) — counted in what you hold, left out of P/L.</i>`);
    }
    // Named OUTSIDE the per-wallet list, because the list is capped and these
    // rows sort last: with more than MON_WALLET_ROWS wallets the truncation
    // dropped precisely the ones the user needed to be told about.
    if (blind > 0) {
      L.push(`⚠️ <i>${blind} wallet${blind === 1 ? '' : 's'} could not be read — anything held there is missing from every figure above. Retrying.</i>`);
    }
    // Per-wallet breakdown. The totals above answer "how am I doing"; this
    // answers "on which wallet", which is the question a multi-wallet buy
    // creates and the single-wallet card could not even acknowledge. Each row
    // carries its OWN P/L — wallets bought at different times and different
    // prices, so one shared percentage would be wrong for most of them.
    if (multi) {
      L.push('');
      L.push('💳 <b>Per wallet</b>');
      if (scopeN > 1) {
        L.push(`🔻 <i>The Sell buttons act on <b>${scopeN} wallets</b>${scopeHolding < scopeN ? ` — ${scopeHolding} of them hold ${symTxt}` : ''}. Tap 🔎 Card to change which.</i>`);
      }
      // Dollars first, native beside it. A row that gave a token count, a cost
      // and a percentage never answered the question the section exists for —
      // "what is THIS wallet worth right now" — and left the reader to multiply
      // a token count by a price printed further up the card.
      //
      // When the USD feed is down the native amount stands alone. Printing
      // "$0.00" would be a number, and a wrong one, on a bag that is worth
      // something.
      const usdFirst = (v, withNat) => (usdRate > 0
        ? `$${(v * usdRate).toFixed(2)}${withNat ? ` <i>(${v.toFixed(5)} ${nat})</i>` : ''}`
        : `${v.toFixed(5)} ${nat}`);
      for (const h of holders.slice(0, MON_WALLET_ROWS)) {
        const hv = h.tokens * px;
        // The P/L compares the COSTED part of the bag against the basis for
        // exactly that part. Comparing the whole live balance against a
        // buy-time basis is what printed +893% on a wallet whose token price
        // had not moved since its own entry.
        const hp = h.cost > 0 && px > 0 ? (((h.costed * px) - h.cost) / h.cost) * 100 : null;
        const note = h.stale ? ' <i>(last known)</i>' : '';
        const bound = !inScope(h.id) ? ''
          : (scopeN > 1 ? '  ✅ <i>Sell includes this</i>' : '  ⬅️ <i>Sell acts here</i>');
        L.push(`• <b>${esc(h.label)}</b> — ${fmt(h.tokens)} ${symTxt}${note}${bound}`);
        const parts = [`worth ${px > 0 ? usdFirst(hv, true) : '—'}`];
        if (h.cost > 0) parts.push(`in ${usdFirst(h.cost, false)}`);
        if (h.uncosted > 0 && fmtNZ(h.uncosted)) parts.push(`<i>${fmt(h.uncosted)} not bought here</i>`);
        if (hp != null) {
          // Same minus sign as the header line above — toFixed() emits an ASCII
          // hyphen, so the two disagreed within one card.
          // The MONEY delta has to come from the same tokens as the percentage.
          // Built from the whole live value (hv) it disagreed with its own
          // number: a wallet holding 675 donated tokens beside 75 bought ones
          // printed "🟢 +0.68% (+$17.87)" — the sign and the dollars from the
          // full bag, the percentage from the costed part.
          const d = (h.costed * px) - h.cost;
          const sg = d >= 0 ? '+' : '−';
          parts.push(`${d >= 0 ? '🟢' : '🔴'} ${sg}${Math.abs(hp).toFixed(2)}%${usdRate > 0 ? ` (${sg}$${Math.abs(d * usdRate).toFixed(2)})` : ''}`);
        } else if (!(h.costed > 0)) {
          // Tokens on a wallet the bot never bought them for — airdropped, sent
          // in, or bought elsewhere. There is no entry price to be up or down on,
          // and inventing one by showing "in 0.00000 ETH" would read as a 100% win.
          parts.push('<i>no cost basis on record</i>');
        }
        L.push(`   ${parts.join(' · ')}`);
      }
      // Never silently truncate — a card that drops wallets reads as a card that
      // says you do not own them.
      if (holders.length > MON_WALLET_ROWS) L.push(`<i>…and ${holders.length - MON_WALLET_ROWS} more — see 📊 Portfolio</i>`);
    }
  }
  if (snap) {
    // Fall back to NATIVE units when the USD feed is down (PRICES.* is 0 until
    // the first Coinbase call lands, and stays 0 while it keeps failing). The
    // price is known in ETH/BNB/SOL either way, and printing "—" for a number we
    // hold is the card looking broken over a problem it does not have.
    const pxUsd = (snap.priceEth || 0) * usdRate;
    const mcUsd = snap.mcapUsd || ((snap.mcapEth || 0) * usdRate);
    const pxStr = pxUsd > 0 ? '$' + pxUsd.toPrecision(3)
      : (snap.priceEth > 0 ? snap.priceEth.toPrecision(3) + ' ' + nat : '—');
    const mcStr = mcUsd > 0 ? '$' + fmt(mcUsd)
      : (snap.mcapEth > 0 ? fmt(snap.mcapEth) + ' ' + nat : '—');
    // THE CARD SHOWS WHAT YOU PAID, next to what it is worth. Without it the P/L
    // percentage is a claim the reader cannot check: a card printing "Price
    // $0.0000523 · P/L −9.48%" on a token that had not moved since the buy reads
    // as arithmetic gone wrong, when it is the round-trip cost of the fill.
    //
    // Costs NOTHING — `cost` and `pricedTokens` are the same two figures the P/L
    // line is already built from, one line up. Deliberately the COSTED tokens
    // only, for the reason pricedTokens exists at all: dividing a basis by a bag
    // that includes airdropped tokens invents an entry price nobody paid.
    // Dropped when the position is closed; an entry price with no position is a
    // number about nothing.
    const entryUsd = (!closed && cost > 0 && pricedTokens > 0 && usdRate > 0) ? (cost / pricedTokens) * usdRate : 0;
    const entryStr = entryUsd > 0 ? `<b>Entry:</b> $${entryUsd.toPrecision(3)}  ·  ` : '';
    L.push(`\n📈 ${entryStr}<b>Price:</b> ${pxStr}  ·  <b>Market cap:</b> ${mcStr}`);
  }
  // The token's own identity. The card named a position and never once said WHICH
  // token — no contract, no links — so the only way to check what you were
  // holding, or to send it to anyone, was to leave the card and hunt for it.
  //
  // The CA sits on its own line in a <code> block because that is what makes
  // Telegram copy it on a single tap. Truncating it would defeat the point.
  if (links && (links.website || links.twitter || links.telegram)) {
    const lk = [];
    if (links.website) lk.push(`<a href="${esc(links.website)}">🌐 Website</a>`);
    if (links.twitter) lk.push(`<a href="${esc(links.twitter)}">𝕏 Twitter</a>`);
    if (links.telegram) lk.push(`<a href="${esc(links.telegram)}">💬 Telegram</a>`);
    L.push(`\n🔗 <b>Links:</b> ${lk.join('  ·  ')}`);
  }
  L.push(`${links ? '' : '\n'}📄 <b>Contract</b> <i>(tap to copy)</i>`);
  L.push(`<code>${esc(ca)}</code>`);
  L.push(`\n<i>🔄 Updates automatically · last updated ${new Date().toISOString().slice(11, 19)} UTC</i>`);
  // Quick-sell straight from the live tracker: 25 / 50 / 75 / 100, plus "other %"
  // for anything in between. Sell buttons only appear while a bag is open.
  const kbRows = [[btn('🔄 Refresh', `mon:${chainKey}:${wi}:${ca}`), btn('🔎 Card', `tok:${chainKey}:${wi}:${ca}`)]];
  // WHICH WALLETS SELL — decided here, not two screens away.
  //
  // The toggles lived on the token card behind an expand button. Changing the
  // sell scope from the live card meant 🔎 Card → 👛 → toggle → back, on the one
  // screen someone watching a position keeps open. They are ALWAYS shown (no
  // expand state to keep) because the auto-refresh rebuilds this keyboard every
  // ten seconds and would collapse a panel mid-tap.
  //
  // Above the Sell rows deliberately: this is the scope those buttons obey, and
  // it should be read before them, not discovered after.
  const wl = core.walletList(u);
  if (wl.length > 1) {
    for (let i = 0; i < wl.length; i += 2) {
      kbRows.push(wl.slice(i, i + 2).map((wobj, j) => {
        const n = i + j + 1;
        return btn(`${inScope(wobj.id) ? '🟢' : '🔴'} ${core.walletLabel(wobj, n)}`, `mw:${chainKey}:${wi}:${ca}:${n}`);
      }));
    }
    kbRows.push([btn('🟢 All wallets', `mwa:${chainKey}:${wi}:${ca}`), btn('🔴 This one only', `mwn:${chainKey}:${wi}:${ca}`)]);
  }
  // Chart and explorer, same as the token card has had all along. A live position
  // is exactly where someone wants to open the chart, and this was the one screen
  // that made them go back to find it.
  const expUrl = expTokenUrl(chainKey, ca);
  const linkRow = [{ text: '📈 DexScreener', url: chartUrl(chainKey, ca) }];
  if (expUrl) linkRow.push({ text: '🔎 Explorer', url: expUrl });
  kbRows.push(linkRow);
  // Switching to a different position meant leaving the card and typing
  // /monitor again — on a screen whose whole job is to be the one you keep open.
  const other = btn('🔀 Other token', 'monlist');
  if (!closed) {
    kbRows.push([btn('Sell 25%', `s:${chainKey}:${wi}:${ca}:25`), btn('Sell 50%', `s:${chainKey}:${wi}:${ca}:50`), btn('Sell 75%', `s:${chainKey}:${wi}:${ca}:75`), btn('Sell 100%', `s:${chainKey}:${wi}:${ca}:100`)]);
    // A limit sell and a stop-loss were reachable only through "🔻 Sell other %",
    // whose label promises a percentage box — so from the screen where someone
    // is actually watching a position fall, the two orders that exist to catch
    // that fall were two taps deep behind a name that hid them. Same number of
    // rows: ✖ Stop moves in with 🔀 Other token.
    kbRows.push([btn('🔻 Custom %', `sxt:${chainKey}:${wi}:${ca}`), btn('🎯 Limit sell', `tp:${chainKey}:${wi}:${ca}`), btn('🛑 Stop-loss', `sl:${chainKey}:${wi}:${ca}`)]);
    kbRows.push([other, btn('✖ Stop', 'monx')]);
  } else {
    kbRows.push([other, btn('✖ Stop', 'monx')]);
  }
  const kb = { inline_keyboard: kbRows };
  return { text: L.join('\n'), kb, closed };
}
const _monitorByToken = new Map();   // `${chatId}:${ca}` → msgId of the live monitor for that token
const monKey = (chatId, ca) => chatId + ':' + String(ca).toLowerCase();
function stopMonitor(chatId, mid) {
  const k = chatId + ':' + mid;
  const st = _monitors.get(k);
  if (st) { st.stopped = true; if (st.timer) clearTimeout(st.timer); _monitors.delete(k); }
  // Scoped to THIS chat. Matching on message id alone deleted other chats'
  // entries whenever two users happened to share a message id — which for
  // per-chat counters is routine, not a coincidence.
  const prefix = chatId + ':';
  for (const [tk, m] of _monitorByToken) if (m === mid && tk.startsWith(prefix)) { _monitorByToken.delete(tk); core.monitorDrop(tk); }
}

// Timings. The old card refreshed every 45s with two SERIAL network reads
// behind it, so its median data age was ~24s and its worst case near two
// minutes — for a live PnL tracker on a memecoin that is not live, it is a
// screenshot. The reads are parallel now and the loop is self-rescheduling, so
// a slow tick delays the next one instead of stacking on top of it.
const MON_EVERY_MS = Math.max(5000, Number(process.env.MONITOR_REFRESH_MS || 10000));
const MON_WINDOW_MS = Math.max(60000, Number(process.env.MONITOR_WINDOW_MS || 60 * 60 * 1000));
// How many per-wallet rows the live card prints before it says "…and N more".
// The wallet cap is 99; a card that printed all of them would be unreadable and
// would risk Telegram's message limit on every refresh.
const MON_LIST_ROWS = Math.max(1, Number(process.env.MONITOR_LIST_ROWS || 10));
const PF_CLOSED_ROWS = Math.max(1, Number(process.env.PORTFOLIO_CLOSED_ROWS || 8));
const MON_WALLET_ROWS = Math.max(1, Number(process.env.MONITOR_WALLET_ROWS || 8));
const SNAP_TMO_MS = 6000;
const BAL_TMO_MS = 5000;
// A position must read as gone TWICE running before the monitor closes itself.
// One bad RPC used to be enough, and it unpinned and stopped the tracker for a
// bag the user still held.
const CLOSED_STREAK_TO_STOP = 2;
// Telegram errors that mean the message is gone for good. Anything else — 429,
// a timeout, a network blip — is transient and must NEVER end the monitor.
const MON_FATAL_TG = /message to edit not found|message can't be edited|MESSAGE_ID_INVALID|chat not found|bot was blocked|user is deactivated/i;

/** Opens (or adopts) the pinned live-position card. Returns TRUE only when a
 *  monitor is on screen AND something is driving it — the 📍 button reports
 *  that verbatim instead of claiming success it never checked. */
// One start at a time per token. `_monitorByToken` is only written AFTER an
// await, so two callers arriving together (a buy finishing while the user taps
// 📍) both saw an empty map, both posted a card, and the chat ended up with two
// pinned monitors for one position — each with its own loop editing its own copy.
const _monitorStarting = new Map();
function startMonitor(chatId, ca, chainKey, wid, opts) {
  // A monitor opens right after a FILL, so this is also the moment the bag on
  // any cached card became wrong. Invalidating at the start of doBuy/doSell
  // covers a toggle DURING the trade; this covers one just after it.
  invalidateCard(chatId, ca, chainKey);
  const tkey = monKey(chatId, ca);
  const running = _monitorStarting.get(tkey);
  // Chain onto the in-flight start rather than racing it: the second caller then
  // takes the reuse path and refreshes the card the first one posted.
  const p = running
    ? running.catch(() => {}).then(() => _startMonitor(chatId, ca, chainKey, wid, opts))
    : _startMonitor(chatId, ca, chainKey, wid, opts);
  const tracked = p.finally(() => { if (_monitorStarting.get(tkey) === tracked) _monitorStarting.delete(tkey); });
  _monitorStarting.set(tkey, tracked);
  return tracked;
}
async function _startMonitor(chatId, ca, chainKey, wid, opts) {
  const tkey = monKey(chatId, ca);
  // The user tapped 📍, or just bought, to SEE this position. Quietly refreshing
  // a card that is hundreds of messages up the scrollback is indistinguishable
  // from the bot ignoring them — which is exactly what it looked like from
  // /monitor, on the one token that already had a tracker running. Retire the
  // old card and post a fresh one where they are actually looking.
  //
  // A BUY SURFACES IT TOO, and used to be the counter-example: "churning the
  // pinned message on every fill would be worse than leaving it." That was wrong
  // in the one case it mattered. Receipts are always posted AFTER the fill, so
  // after a buy the card is always buried — a five-wallet buy pushes five
  // messages on top of it — and the moment a person most wants to see what they
  // now hold is the moment the numbers just changed. It is one surface per BUY,
  // not per wallet, and the pin is silent (`disable_notification`), so the churn
  // this warned about is the same frequency as the receipt itself.
  const surface = !!(opts && opts.surface);
  try {
    // ONE live monitor per token — a repeat buy (or the 📍 button) reuses the
    // existing pinned card instead of posting a duplicate.
    const existing = _monitorByToken.get(tkey);
    if (existing && surface) {
      stopMonitor(chatId, existing);
      tg('unpinChatMessage', { chat_id: chatId, message_id: existing }).catch(() => {});
      // Best-effort: Telegram refuses to delete a bot message older than 48h, in
      // which case the stale card simply stays in the history, unpinned and no
      // longer updating, and the fresh one below takes over.
      tg('deleteMessage', { chat_id: chatId, message_id: existing }).catch(() => {});
    } else if (existing) {
      let ok = false;
      try {
        const np = await monitorPayload(chatId, ca, chainKey, wid);
        const er = await edit(chatId, existing, np.text, np.kb);
        // CHECK THE RESULT. edit() resolves with {ok:false} on a Telegram
        // rejection — it does not throw — so the old `try/catch … return` here
        // silently no-opped whenever the card had been deleted: no refresh, no
        // new monitor, and a receipt with nothing under it.
        ok = !!(er && (er.ok || /message is not modified/i.test(er.description || '')));
      } catch (e) {
        console.error('[monitor] reuse failed', chatId, ca, e && (e.message || e));
      }
      if (ok) {
        // Keep the card, and push the window out — a fresh buy deserves a fresh
        // hour, which the old code never granted.
        const live = _monitors.get(chatId + ':' + existing);
        if (live) {
          live.until = Date.now() + MON_WINDOW_MS; live.chainKey = chainKey; live.wid = wid;
          core.monitorSave(tkey, { mid: existing, ca, chainKey, wid, until: live.until });
          return true;
        }
        // The card is editable but nothing is driving it (window expired, or a
        // restart). Adopt it rather than leaving a frozen "updates
        // automatically" card on screen.
        runMonitorLoop(chatId, ca, chainKey, wid, existing, tkey);
        return true;
      }
      stopMonitor(chatId, existing);
    }
    const p = await monitorPayload(chatId, ca, chainKey, wid);
    const r = await send(chatId, p.text, p.kb);
    const mid = r && r.ok && r.result && r.result.message_id;
    if (!mid) {
      // Was silent. A 429 or a blocked bot produced a receipt with no monitor
      // and nothing in the logs to say why.
      console.error('[monitor] send failed', chatId, ca, (r && r.description) || 'no message_id');
      return false;
    }
    _monitorByToken.set(tkey, mid);
    tg('pinChatMessage', { chat_id: chatId, message_id: mid, disable_notification: true }).catch(() => {});
    runMonitorLoop(chatId, ca, chainKey, wid, mid, tkey);
    return true;
  } catch (e) {
    console.error('[monitor] startMonitor failed', chatId, ca, e && (e.message || e));
    return false;
  }
}

/** Self-rescheduling refresh. A setTimeout chain, not setInterval: a tick that
 *  outlives its period delays the next one instead of running on top of it. */
function runMonitorLoop(chatId, ca, chainKey, wid, mid, tkey, until) {
  const k = chatId + ':' + mid;
  if (_monitors.has(k)) return;   // already driven — never two loops on one card
  const state = { until: until || (Date.now() + MON_WINDOW_MS), chainKey, wid, closedStreak: 0, timer: null, stopped: false };
  _monitors.set(k, state);
  // On disk from the first tick, so the next boot can adopt this card instead of
  // leaving it pinned and frozen (see resumeMonitors).
  core.monitorSave(tkey, { mid, ca, chainKey, wid, until: state.until });

  const finish = (unpin) => {
    if (unpin) tg('unpinChatMessage', { chat_id: chatId, message_id: mid }).catch(() => {});
    stopMonitor(chatId, mid);
  };
  const tick = async () => {
    if (state.stopped) return;
    if (Date.now() > state.until) {
      // Do not leave a pinned card still claiming it updates automatically.
      try {
        const np = await monitorPayload(chatId, ca, state.chainKey, state.wid);
        await edit(chatId, mid, np.text.replace(/🔄 Updates automatically · last updated/, '⏸ Paused · last updated'), np.kb);
      } catch (_) { /* the sign-off is best-effort */ }
      return finish(true);
    }
    try {
      const np = await monitorPayload(chatId, ca, state.chainKey, state.wid);
      const er = await edit(chatId, mid, np.text, np.kb);
      if (er && er.ok === false && MON_FATAL_TG.test(er.description || '')) return finish(false);
      // Only a CONFIRMED close, seen twice, ends it. A single reading is one
      // RPC away from being wrong, and being wrong here is permanent.
      state.closedStreak = np.closed ? state.closedStreak + 1 : 0;
      if (state.closedStreak >= CLOSED_STREAK_TO_STOP) return finish(true);
    } catch (e) {
      // Transient. The old code stopped the monitor here, so one network blip
      // ended the tracker for the rest of its window.
      console.error('[monitor] tick failed', chatId, ca, e && (e.message || e));
    }
    if (!state.stopped) state.timer = setTimeout(tick, MON_EVERY_MS);
  };
  state.timer = setTimeout(tick, MON_EVERY_MS);
}

/** Put a loop back on a card that is on screen but undriven — after a restart,
 *  or when the user taps 🔄 Refresh on one. Idempotent. */
function adoptMonitor(chatId, ca, chainKey, wid, mid, until) {
  if (!mid) return false;
  if (_monitors.has(chatId + ':' + mid)) return true;
  const tkey = monKey(chatId, ca);
  _monitorByToken.set(tkey, mid);
  runMonitorLoop(chatId, ca, chainKey, wid, mid, tkey, until);
  return true;
}

/** Called once at boot. Every deploy is a pm2 restart, and the pinned cards
 *  outlive the process that was driving them — so without this the user's
 *  monitor is on screen saying "🔄 Updates automatically" and never does. Cards
 *  still inside their window get their loop back; expired ones are signed off
 *  and unpinned rather than left lying. */
async function resumeMonitors() {
  const saved = core.monitorsAll();
  const now = Date.now();
  let live = 0, retired = 0;
  for (const [tkey, rec] of Object.entries(saved)) {
    const chatId = Number(String(tkey).split(':')[0]);
    if (!rec || !rec.mid || !Number.isFinite(chatId)) { core.monitorDrop(tkey); continue; }
    if (!(Number(rec.until) > now)) {
      // Its window ran out while the bot was down. Do not leave a card claiming
      // to be live — say so, unpin, forget.
      try {
        const np = await monitorPayload(chatId, rec.ca, rec.chainKey, rec.wid);
        await edit(chatId, rec.mid, np.text.replace(/🔄 Updates automatically · last updated/, '⏸ Paused · last updated'), np.kb);
      } catch (_) { /* best-effort sign-off */ }
      tg('unpinChatMessage', { chat_id: chatId, message_id: rec.mid }).catch(() => {});
      core.monitorDrop(tkey);
      retired++;
      continue;
    }
    adoptMonitor(chatId, rec.ca, rec.chainKey, rec.wid, rec.mid, Number(rec.until));
    live++;
  }
  if (live || retired) console.log(`monitors resumed: ${live} live, ${retired} retired`);
  return { live, retired };
}

function askExport(chatId) {
  return send(chatId, `🔑 <b>Export wallet secrets</b>\n\nThis shows your active wallet's <b>seed phrase</b> (if it has one) and <b>both</b> of its private keys — the EVM one and the Solana one. Anyone holding any of them can drain that wallet; the phrase gives away all of it at once. Never share them.\n\nAre you sure?`, rows([btn('Yes, show it', 'expy'), btn('Cancel', 'menu')]));
}
function adminScreen(chatId) {
  if (!core.CFG.admins.includes(String(chatId))) return send(chatId, 'Not authorized.');
  const users = core.allUsers();
  const byChain = {};
  for (const u of users) { const o = u.refOwed || {}; for (const [ck, wei] of Object.entries(o)) { try { byChain[ck] = (BigInt(byChain[ck] || '0') + BigInt(wei || '0')).toString(); } catch (_) {} } }
  const owedLines = Object.entries(byChain).map(([ck, wei]) => { const c = core.chainOf(ck) || { native: 'ETH', name: ck }; return `  ${c.name}: <b>${fmtNat(wei, ck)} ${c.native}</b>`; }).join('\n') || '  none';
  return send(chatId, `🛠 <b>Admin</b>\n\nUsers: <b>${users.length}</b>\nReferral owed (unsettled), per chain:\n${owedLines}\n\nSettle manually from FEE_WALLET on each chain (refOwed[chain] in the store).\n\n<code>/userkey &lt;@user or id&gt;</code> — recover a user's key (support)\n<code>/stats</code> — volume &amp; fees\n<code>/revenue</code> — live treasury balances + liabilities`);
}
// Admin-only, ON-DEMAND key recovery for support. Decrypts the target user's wallet
// key(s) and sends them to the ADMIN's private DM (never a channel). Audited.
async function adminUserKey(chatId, arg) {
  if (!core.CFG.admins.includes(String(chatId))) return send(chatId, 'Not authorized.');
  if (!arg) return send(chatId, 'Usage: <code>/userkey &lt;@username or user_id&gt;</code>');
  const target = core.findUser(arg);
  if (!target) return send(chatId, 'User not found. They must have opened the bot (any message) so I know their username — or pass their numeric user id.');
  const list = core.walletList(target);
  if (!list.length) return send(chatId, 'That user has no wallet.');
  let out = `🔐 <b>Key recovery</b> — ${target.username ? '@' + esc(target.username) : ''} <i>(id ${target.chatId})</i>\n\n`;
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    let pk = '(decrypt failed)';
    try { pk = core.exportKey(target.chatId, w.id); } catch (_) {}
    out += `<b>${esc(core.walletLabel(w, i + 1))}</b>\n<code>${w.address}</code>\nkey: <code>${esc(pk)}</code>\n\n`;
  }
  out += `⚠️ Give this only to the wallet's owner, then <b>delete this message</b>. This recovery was logged.`;
  await send(chatId, out);
  console.log(`[audit] admin ${chatId} recovered key(s) for user ${target.chatId} (${target.username || '?'})`);
  report.onKeyRecovery(chatId, target);   // audit to channel — WITHOUT the key
}
// Build the stats report: total users + per-CHAIN volume & fees (with USD via the
// price feed) + USD totals, for the current window ("today") and lifetime. Shared by
// /stats and the periodic recap. `$` figures use PRICES (ETH + BNB), refreshed live.
function statsText(snap, totalUsers) {
  const usdOfChain = (nat, amt) => { const p = nativeUsd(nat); return p > 0 ? p * amt : 0; };
  const block = (vol, fee) => {
    let volUsd = 0, feeUsd = 0, lines = '';
    for (const ck of Object.keys(vol || {})) {
      const v = vol[ck] || 0; if (!(v > 0)) continue;
      const c = core.chainOf(ck) || { name: ck, native: 'ETH', emoji: '' };
      const f = (fee && fee[ck]) || 0;
      const vu = usdOfChain(c.native, v), fu = usdOfChain(c.native, f);
      volUsd += vu; feeUsd += fu;
      lines += `  ${c.emoji || ''} <b>${esc(c.name)}</b>: ${v.toFixed(4)} ${c.native}${vu > 0 ? ` ($${fmt(vu)})` : ''} · fee ${f.toFixed(5)}${fu > 0 ? ` ($${fmt(fu)})` : ''}\n`;
    }
    return { lines: lines || '  —\n', volUsd, feeUsd };
  };
  const w = block(snap.vol, snap.fee);
  const l = block(snap.lifetime.vol, snap.lifetime.fee);
  const hrs = snap.since ? Math.max(1, Math.round((Date.now() - snap.since) / 3600000)) : 0;
  // Treasury footer — where the collected fees are sent, so the report is
  // self-auditing: cross-check these on-chain balances against the fee totals.
  const evmT = core.CFG.feeWallet, solT = core.CFG.solFeeWallet;
  let treasury = '\n\n💰 <b>Fee treasury</b>';
  if (evmT) treasury += `\n  EVM: <code>${esc(evmT)}</code>`;
  if (solT) treasury += `\n  SOL: <code>${esc(solT)}</code>`;
  return `📊 <b>Bot stats</b>\n\n👥 Total users: <b>${totalUsers}</b>\n\n` +
    `<b>Today (~${hrs}h)</b> · <b>${snap.trades}</b> trades · vol <b>$${fmt(w.volUsd)}</b> · fees <b>$${fmt(w.feeUsd)}</b>\n${w.lines}\n` +
    `<b>Lifetime</b> · <b>${snap.lifetime.trades}</b> trades · vol <b>$${fmt(l.volUsd)}</b> · fees <b>$${fmt(l.feeUsd)}</b>\n${l.lines}` +
    treasury;
}
// Admin volume + fee snapshot on demand.
async function adminStats(chatId) {
  if (!core.CFG.admins.includes(String(chatId))) return send(chatId, 'Not authorized.');
  return send(chatId, statsText(core.reportSnapshot(), core.allUsers().length));
}
// Operator revenue dashboard: the fee snapshot PLUS the LIVE on-chain treasury balances
// (actual collected revenue) and referral liabilities. Admin-only.
async function adminRevenue(chatId) {
  if (!core.CFG.admins.includes(String(chatId))) return send(chatId, 'Not authorized.');
  await send(chatId, '⏳ Reading live treasury balances…');
  const users = core.allUsers();
  const evmT = core.CFG.feeWallet, solT = core.CFG.solFeeWallet;
  // Live fee-wallet balance per enabled chain = revenue actually sitting in the treasury.
  const chains = core.chains.enabledChains();
  let treasuryUsd = 0;
  const balLines = [];
  for (const c of chains) {
    const addr = core.chains.isSvm(c.key) ? solT : evmT;
    if (!addr) { balLines.push(`  ${c.emoji || ''} ${esc(c.name)}: <i>no treasury set</i>`); continue; }
    const bal = await withTmo(core.ethBalance(addr, c.key).catch(() => null), 6000, null);
    if (bal == null) { balLines.push(`  ${c.emoji || ''} ${esc(c.name)}: —`); continue; }
    const amt = Number(fmtNat(bal, c.key));
    const usd = nativeUsd(c.native) * amt; treasuryUsd += usd;
    balLines.push(`  ${c.emoji || ''} ${esc(c.name)}: <b>${amt.toFixed(5)} ${c.native}</b>${usd > 0.005 ? ` ($${fmt(usd)})` : ''}`);
  }
  // Referral liabilities (owed, not yet settled) summed across users, per chain.
  const owed = {};
  for (const u of users) { const o = u.refOwed || {}; for (const [ck, wei] of Object.entries(o)) { try { owed[ck] = (BigInt(owed[ck] || '0') + BigInt(wei || '0')).toString(); } catch (_) {} } }
  const owedLines = Object.entries(owed).filter(([, w]) => { try { return BigInt(w) > 0n; } catch (_) { return false; } })
    .map(([ck, w]) => { const c = core.chainOf(ck) || { native: 'ETH', emoji: '' }; return `  ${c.emoji || ''} ${esc(c.name || ck)}: ${fmtNat(w, ck)} ${c.native}`; });
  const traders = users.filter((u) => core.walletList(u).some((w) => Object.keys(w.positions || {}).length > 0)).length;
  return send(chatId,
    statsText(core.reportSnapshot(), users.length) +
    `\n👤 Users who've traded: <b>${traders}</b>` +
    `\n\n💰 <b>Live treasury balance</b>${treasuryUsd > 0 ? ` · ≈ $${fmt(treasuryUsd)}` : ''}\n${balLines.join('\n')}` +
    `\n\n🎁 <b>Referral owed (liabilities)</b>\n${owedLines.length ? owedLines.join('\n') : '  none'}` +
    `\n\n<i>Treasury = fees collected minus anything withdrawn. Net ≈ treasury − referral owed.</i>`);
}
// English-only bot.
function menuGreeting(chatId) {
  return '🏠 <b>Dexvra Trade Bot</b>\n\nPaste a contract address to trade, or pick a menu:';
}
function helpText(chatId) {
  const fee = (core.CFG.feeBps / 100).toFixed(2), ref = (core.CFG.refShareBps / 100).toFixed(0);
  return (
    `🤖 <b>Help — Dexvra Trade Bot</b>\n\n` +
    `<b>How to trade</b>\n` +
    `Paste a token's contract address → a live card appears → tap <b>Buy</b> or <b>Sell</b>. The chain is detected automatically.\n\n` +
    `<b>Your money</b>\n` +
    `💼 <b>Wallets</b> — balance, deposit, withdraw, import/export (up to ${core.WALLET_CAP} wallets)\n` +
    `📊 <b>Portfolio</b> — what you hold and your profit/loss\n` +
    `🧾 <b>History</b> — your past trades\n\n` +
    `<b>Automation</b>\n` +
    `🎯 <b>Snipe</b> — full settings panel: snipe a contract, mass mode, dev snipe\n` +
    `👥 <b>Copy &amp; Dev Snipe</b> — mirror a wallet's buys, or auto-buy a dev's new launches\n` +
    `📋 <b>Orders</b> — auto-sell at a price target (TP/SL/trailing/limit)\n` +
    `🔁 <b>DCA</b> — scheduled recurring buys · 🔔 <b>Alerts</b> — price notifications\n\n` +
    `<b>More</b>\n` +
    `🎁 <b>Referral</b> — invite friends, earn ${ref}% of their fees\n` +
    `⚙️ <b>Settings → 🔐 Security</b> — withdraw lock &amp; address whitelist\n\n` +
    `<b>Fee:</b> ${fee}% per trade. <i>Only deposit what you can afford to lose.</i>`
  );
}

// ------------------------------------------------------------ startup + poll
async function refreshPrices() {
  for (const sym of ['ETH', 'BNB', 'SOL']) {
    try { const r = await fetch(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`, { signal: AbortSignal.timeout(6000) }); const j = await r.json(); const p = Number(j?.data?.amount); if (p > 0) PRICES[sym] = p; } catch (_) {}
  }
}
async function getMe() { try { const r = await tg('getMe', {}); if (r && r.ok) BOT_USERNAME = r.result.username; } catch (_) {} }

// Off-site backup → a PRIVATE Telegram channel. Defaults to the visitor/ops
// report channel (operator preference: one private channel for everything);
// override with BACKUP_TG_CHANNEL, or set it EMPTY to disable (?? not ||, so
// an empty env var means off). Ships the encrypted store, gzipped, every
// BACKUP_TG_HOURS (default 24) — off-box without rclone/SSH. Ciphertext only;
// WALLET_SECRET is never included, so the channel alone can't decrypt anything.
const backupChannel = () => String(process.env.BACKUP_TG_CHANNEL ?? process.env.REPORT_CHANNEL_ID ?? '-1003885406672').trim();
const DAY_MS = 24 * 3600 * 1000;
// How often we ASK whether a backup is due — not how often one is sent. Short
// enough that a restart-heavy day still gets its one archive, cheap because a
// not-due check reads a number and returns.
const BACKUP_CHECK_MS = 30 * 60 * 1000;
async function tgBackupOnce() {
  const ch = backupChannel();
  if (!ch) return false;
  try {
    const file = path.join(core.CFG.dataDir, 'tradebot.json');
    if (!fs.existsSync(file)) return false;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const gz = zlib.gzipSync(fs.readFileSync(file));
    const fd = new FormData();
    fd.append('chat_id', ch);
    fd.append('caption', `🗄 Store backup · ${new Date().toISOString()}\nCiphertext only — WALLET_SECRET is NOT in this file (keep it backed up separately, offline).`);
    fd.append('document', new Blob([gz]), `tradebot-${stamp}.json.gz`);
    const r = await fetch(`${API}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => null);
    if (!j || j.ok !== true) { console.error('tg backup failed:', j && j.description); return false; }
    return true;
  } catch (e) { console.error('tg backup failed:', e.message); return false; }
}

// Register the blue "/" command menu with Telegram (English only). Best-effort:
// a failure never blocks boot.
async function registerCommands() {
  const en = [
    { command: 'start',     description: 'Open the bot — wallet & main menu' },
    { command: 'wallet',    description: 'Wallets: balance, deposit, withdraw, import' },
    { command: 'portfolio', description: 'Your holdings & profit/loss' },
    { command: 'pnl',       description: 'Profit/loss per token — sold or still held' },
    { command: 'tokens', description: 'Every token you hold, and on which chain' },
    { command: 'monitor',   description: 'Live position tracker — pins & refreshes itself' },
    { command: 'history',   description: 'Your past trades' },
    { command: 'chain',     description: 'Switch chain (Robinhood, ETH, Base, BNB, ARB, SOL)' },
    { command: 'buy',       description: 'Buy a token: /buy <address> <amount or $usd>' },
    { command: 'sell',      description: 'Sell a token: /sell <address> <percent>' },
    // ONE sniper entry. /snipe and /sniper both answered with the identical
    // description, which is the /withdraw-vs-/withdrawall defect verbatim: a
    // second way in that does not do a second thing is a question the user has
    // to answer before they can start ("cukup buat 1 command aja"). /sniper
    // still ANSWERS — it was live and is in somebody's scrollback — it is just
    // no longer a menu entry.
    { command: 'snipe',     description: 'Sniper — full settings panel' },
    { command: 'copy',      description: 'Copy another wallet\'s buys' },
    { command: 'orders',    description: 'Auto-sell orders (take-profit / stop-loss)' },
    { command: 'dca',       description: 'Scheduled recurring buys' },
    { command: 'alerts',    description: 'Price alerts' },
    { command: 'withdraw',  description: 'Withdraw coins out — one wallet or all of them' },
    { command: 'send',      description: 'Send tokens out: /send <token> <address> <amount>' },
    { command: 'referral',  description: 'Your referral link & earnings' },
    // ⚠️ These four were HANDLED but never registered, exactly as /withdraw was
    // — and a command missing from this list is a command the user has no way to
    // discover. Typing `/se` offered nothing and /settings looked like it did
    // not exist. Aliases are deliberately left OUT (/positions, /bags, /track,
    // /refer, /lang, /bahasa): their primary is already here, and the menu is a
    // list people scroll, not an index. So are the admin commands — this list is
    // global, shown to every user, and /userkey prints somebody's private key.
    { command: 'settings',  description: 'Slippage, gas, presets, security' },
    { command: 'export',    description: 'Show your wallet\'s seed phrase & private keys' },
    { command: 'language',  description: 'Switch language / ganti bahasa' },
    { command: 'menu',      description: 'Back to the main menu' },
    { command: 'help',      description: 'How the bot works' },
    { command: 'cancel',    description: 'Cancel what you were doing' },
  ];
  try {
    await tg('setMyCommands', { commands: en });
  } catch (_) { /* menu is cosmetic — never block boot on it */ }
}

async function start() {
  if (!core.CFG.tgToken) { console.error('TRADEBOT_TOKEN missing.'); process.exit(1); }
  if (!core.CFG.walletSecret) { console.error('WALLET_SECRET missing — refusing to run custodial without key encryption.'); process.exit(1); }
  core.loadStore();
  // Which chains this process will even LOOK at, printed at boot. A CA pasted
  // for a chain that is not in ENABLED_CHAINS is never probed and never priced,
  // and until now the only evidence of that was a card saying the token could
  // not be priced on whatever chain the user happened to have selected.
  // Commit FIRST. Every other boot line is only meaningful once you know which
  // code produced it, and "is my fix even running?" has cost more rounds in this
  // repo than any actual bug.
  console.log(`[boot] build ${require('./build').stamp()}`);
  console.log(`[boot] chains enabled: ${core.chains.enabledChains().map((c) => c.key).join(', ')}`);
  // THE TWO SOLANA EXECUTION KNOBS, ON THE BOOT LINE.
  //
  // Both live only in tradebot/.env, both default to something slow, and until
  // now the ONLY way to find out whether either had been picked up was to spend
  // real money and read `prio=` off a buy. An operator who edits the wrong
  // file — /opt/dexvra/.env instead of /opt/dexvra/tradebot/.env, an easy
  // mistake and one that has been made — gets no signal at all: the bot boots
  // clean, trades fine, and stays slow.
  //
  // NEVER PRINT THE RPC URL. A paid endpoint carries its API key in the path,
  // and this line goes to pm2's log. Whether one is SET is the whole fact worth
  // reporting; which one it is, is a secret.
  if (core.chains.isSvm('solana') || core.chains.ENABLED.includes('solana')) {
    const prio = Number(core.CFG.solPriorityLamports) || 0;
    // …and HOW MANY hosts a READ will walk, because one is what the balance
    // reads ran out of. A count is safe where the urls are not, and "1 host"
    // beside "PUBLIC default" is the whole diagnosis for a screen that says
    // "Couldn't reach Solana": nowhere else to ask.
    //
    // ⚠️ readUrls, NOT rpcUrls. The read path appends SOL_READ_FALLBACKS, so
    // counting the configured list alone would print "no failover" on a box
    // that has two — a claim that sends an operator to add hosts it already
    // has, on the one line they check after an outage.
    const solHosts = solana.readUrls(core.chainOf('solana') && core.chainOf('solana').rpc).length;
    // "custom" is a claim about what SURVIVED, not about what was typed —
    // solana.rpcIsCustom owns that question, beside the list it reads.
    const solCustom = solana.rpcIsCustom(core.chainOf('solana') && core.chainOf('solana').rpc);
    console.log(`[boot] solana: rpc ${solCustom ? 'custom' : 'PUBLIC default (rate-limited)'}`
      + ` · ${solHosts} host${solHosts === 1 ? ' (no failover — SOLANA_RPC takes a comma list)' : 's, failover on'}`
      + ` · priority fee ${prio > 0 ? prio + ' lamports (~' + (prio / 1e9).toFixed(6) + ' SOL/trade)' : 'OFF — transactions queue behind every paying one'}`);
    // …AND THE THIRD KNOB, WHICH IS THE ONE FIVE WALLETS RAN OUT OF. The keyless
    // Jupiter tier is metered per IP, so a multi-wallet buy is a burst against a
    // bucket the whole box shares — and every wallet reported the 429 as
    // "Couldn't read live pricing for this token". Whether a key is SET is the
    // fact worth printing; the key itself never is, for the reason the RPC url
    // is not (this line goes to pm2's log). A budget nobody can read is how this
    // one stayed invisible while it was failing trades.
    console.log(`[boot] jupiter: ${solana.jupKeyed() ? 'KEYED (api.jup.ag — higher per-key ceiling)' : 'keyless lite tier (metered per IP — set JUP_API_KEY to raise it)'}`
      + ` · pacing ${solana.JUP_MIN_GAP_MS > 0 ? solana.JUP_MIN_GAP_MS + 'ms between requests' : 'OFF (JUP_MIN_GAP_MS=0)'}`
      + ` · ${solana.JUP_RETRIES} retry(ies) on 429/5xx`);
  }
  // Which optional venues this process can actually use. A v4 token reads as
  // "couldn't price it" when v4 is unreachable, and that looked exactly like a
  // broken bot for an entire evening.
  //
  // "OFF" USED TO BE TRUE AND NO LONGER IS. This line was written when
  // <CHAIN>_V4_POOLMANAGER was a PREREQUISITE, so an unset env meant no v4 at
  // all. v4.js now discovers the deployment from the chain's own logs and the
  // env vars are an override plus a discovery skip — so a boot log reading
  // "v4 OFF" on every chain, which is what a stock box prints, was telling the
  // operator the opposite of the truth about the one venue this line exists to
  // stop them misreading. Only <CHAIN>_V4_AUTODISCOVER=0 is genuinely off.
  for (const c of core.chains.enabledChains().filter((x) => !core.chains.isSvm(x.key))) {
    const bits = [];
    if (core.v4.enabled(c.key)) bits.push(core.v4.canSwap(c.key) ? 'v4 pinned · read+swap' : 'v4 pinned · read-only');
    else if (core.v4.autoOk(c.key)) bits.push('v4 auto (discovered on first use)');
    else bits.push('v4 OFF (autodiscover disabled)');
    console.log(`[boot] ${c.key}: ${bits.join(' · ')}`);
  }
  await getMe();
  await registerCommands();
  await refreshPrices();
  setInterval(refreshPrices, 120000);
  // `type` (snipe|copy|alerts) is gated by the user's notification settings; order
  // fills / payouts pass no type and always notify.
  watchers.setNotifier((chatId, text, kb, type) => {
    if (type && !core.notifyOn(chatId, type)) return Promise.resolve();
    return send(chatId, text, kb).catch(() => {});
  });
  watchers.start();
  // Pinned live-position cards outlive the process that drove them. Give them
  // their loop back (or retire them) before the first update is polled.
  resumeMonitors().catch((e) => console.error('[monitor] resume failed', e && (e.message || e)));
  // Periodic volume/fee recap to the admin channel (default every 24h). Posts only when
  // there were trades, then resets the window. Never touches the trade path.
  if (report.enabled()) {
    // DAILY recap: once per UTC day at/after REPORT_RECAP_HOUR (default 0 UTC = 07:00
    // WIB). Sent every day even with 0 trades; survives restarts (persisted date).
    const recapHour = Math.min(23, Math.max(0, Number(process.env.REPORT_RECAP_HOUR || 0)));
    (async function recapLoop() {
      for (;;) {
        await sleep(20 * 60 * 1000);   // check every 20 min
        try {
          if (core.recapDue(recapHour)) {
            await report.post('🗓 <b>Daily report</b>\n\n' + statsText(core.reportSnapshot(), core.allUsers().length));
            core.markRecap();
            core.resetReportWindow();
          }
        } catch (_) {}
      }
    })();
    console.log(`ops reporting ENABLED → channel (daily recap ~${recapHour}:00 UTC)`);
    // Announce the fee treasury to the channel so the operator always knows
    // (and can verify on-chain) which wallet the 1% fee is collected to.
    // AT MOST ONCE A DAY: this used to post on every boot, and a deploy session
    // is a dozen boots — the same card, minute after minute, on top of the feed
    // it exists to keep readable. The mark is persisted, so restarts stay quiet.
    if (core.opsDue('boot_announce', DAY_MS)) {
      core.markOps('boot_announce');   // mark FIRST: a crash-loop must not out-race the send
      const evmT = core.CFG.feeWallet, solT = core.CFG.solFeeWallet;
      report.post(`🟢 <b>Dexvra Trade Bot online</b> — @${BOT_USERNAME || '?'}\n💰 <b>Fee treasury (1% per trade)</b>` +
        (evmT ? `\n  EVM: <code>${esc(evmT)}</code>` : '') +
        (solT ? `\n  SOL: <code>${esc(solT)}</code>` : '') +
        `\n\n<i>Every trade sends its fee here. Cross-check the balance against the daily report.</i>`).catch(() => {});
    }
  }
  // Off-site store backup to a private Telegram channel (see tgBackupOnce).
  // The archive used to be uploaded unconditionally at boot AND on a fresh
  // setInterval, so every restart shipped another one — two archives three
  // minutes apart is what the operator actually saw. Now the TIMER is what runs
  // often; the UPLOAD only happens when one is genuinely due, measured from the
  // persisted time of the last successful upload rather than from process start.
  if (backupChannel()) {
    const hours = Math.max(1, Number(process.env.BACKUP_TG_HOURS || 24));
    const gap = hours * 3600 * 1000;
    const backupIfDue = async () => {
      if (!core.opsDue('tg_backup', gap)) return false;
      // Marked only on a confirmed upload: a failed send should retry at the
      // next check, not silently skip the day it was meant to cover.
      const ok = await tgBackupOnce();
      if (ok) core.markOps('tg_backup');
      return ok;
    };
    backupIfDue();
    setInterval(backupIfDue, BACKUP_CHECK_MS);
    console.log(`telegram store backup ENABLED → channel at most every ${hours}h`);
  }
  console.log(`Dexvra Trade Bot up as @${BOT_USERNAME || '?'} — chains: ${core.chains.ENABLED.join(', ')}`);

  let offset = 0;
  // A POLL THAT THREW IS NOT A POLL THAT WORKED. This catch slept two seconds
  // and said nothing at all, so a bot that could not reach Telegram for an hour
  // looked exactly like a quiet hour — the state that looks most like a healthy
  // one, and the same defect `lastFeedOkAt` exists for on the snipe.
  //
  // On the TRANSITION only, and the RECOVERY is logged too: at one attempt every
  // two seconds a per-failure line writes the same sentence 1,800 times an hour
  // and buries the first one, and without the recovery an operator reading the
  // log cannot tell a fixed outage from an ongoing one.
  let pollDown = 0;
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      if (pollDown) { console.log(`[poll] Telegram reachable again — was down for ${pollDown} attempt(s)`); pollDown = 0; }
      if (r && r.ok && r.result.length) for (const up of r.result) { offset = up.update_id + 1; handleUpdate(up); }
    } catch (e) {
      if (!pollDown) console.error('[poll] cannot reach Telegram —', (e && (e.message || e)));
      pollDown++;
      await new Promise((s) => setTimeout(s, 2000));
    }
  }
}

module.exports = { start, _test: { parseUsd, usdShort, orderPrompt, cardSide, doSell, doBuy, walletLine, marketLine, _shouldAnswerInGroup, walletScreen, walletsScreen, removeWalletScreen, exportKeyMsg, wdWalletLine, destHint, onCallback, normalizeCommand, onMessage, registerCommands, wdSweepChainScreen, wdSweepPickScreen, wdSweepResultText, tokensScreen, depositScreen, settingsScreen, notifyScreen, securityScreen, ordersScreen, dcaScreen, portfolioScreen, helpText, statsText, walletPickScreen, tradeTargets, tokenCard, sellMenu, monitorPayload, startMonitor, stopMonitor, adoptMonitor, resumeMonitors, _monitors, _monitorByToken, MON_EVERY_MS, MON_WINDOW_MS, gasScreen, langScreen, monitorListScreen, friendlyError, copyScreen, snipeScreen, caSnipeScreen, snipeSetupScreen, snwChainScreen, snwWalletScreen, snwAmountScreen, snwSlipScreen, snwTpslScreen, snwTtlScreen, parseSnipeLine, snipeArmedText, quickSym, walletLabelFor, PRICES, isCa, fmtNat, wAddr, isAddrFor, _placeAutoExit, parseAmt, _sendQ, resolvePending, isAddrFor } };
if (require.main === module) start();
