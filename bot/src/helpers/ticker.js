// The ticker rule, mirrored from the SITE (src/lib/adminValidate.ts → buildRow).
//
// It lives here so the bot can enforce it WHILE THE USER IS TYPING. Without it
// the first thing that checks a ticker is POST /api/internal/listings, which
// answers "400: Invalid ticker" — at fulfilment, when the buyer has already
// paid and the order is left 'paid' with nothing delivered (incident
// 2026-07-23, order mrxqsrvz_5c44391a). Autofilled symbols make this likelier
// than it sounds: DexScreener/GeckoTerminal happily return "SAFE MOON" or a
// symbol with an emoji in it, and the bot stored those without a word.
//
// Valid: 1–24 characters of Unicode letters/digits plus . _ - , with any
// leading "$" stripped and the rest uppercased. Rejected: whitespace, emoji,
// markup (< > &) and control/format characters (zero-width, bidi) — the site
// renders tickers into escaped HTML and pushes them down the signal wire, so
// those genuinely break things.
//
// Keep IN SYNC with adminValidate.ts. The site is the authority; this is a
// courtesy copy, so it must never be MORE permissive than the site's regex.

const MAX_TICKER = 24;
const VALID = /^[\p{L}\p{N}._-]+$/u;
const INVALID_CHARS = /[^\p{L}\p{N}._-]/gu;

/** The site's own normalisation: "  $pepe " → "PEPE". Deliberately does NOT
 *  truncate — the site rejects an over-long ticker rather than shortening it,
 *  and silently publishing "SUPERLONGTICKERNAME12345" when someone typed one
 *  character more would be editing their brand behind their back. */
function normalizeTicker(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/^\$+/, "")
    .toUpperCase();
}

/** True when the site would accept this ticker (after normalisation). */
function isValidTicker(raw) {
  const s = normalizeTicker(raw);
  return s.length > 0 && s.length <= MAX_TICKER && VALID.test(s);
}

/**
 * Best-effort repair, for tickers the bot did NOT get from a human: an
 * autofilled market-data symbol, or a paid order about to be rejected. Drops
 * the offending characters rather than the sale. Returns "" when nothing usable
 * survives (an emoji-only ticker), so the caller can ask a person instead of
 * inventing one.
 */
function sanitizeTicker(raw) {
  return normalizeTicker(String(raw ?? "").replace(INVALID_CHARS, "")).slice(0, MAX_TICKER);
}

module.exports = { normalizeTicker, isValidTicker, sanitizeTicker, MAX_TICKER };
