// Number / price / text formatting. fmt* ported 1:1 from the website's
// src/lib/format.ts; formatNumber + fmtPrice mirror the fourtis card style so
// channel posts read the same. HTML-safe helpers for parse_mode:"HTML".

/** Adaptive price string, e.g. $1.23, $0.004500, $0.00000119. */
function fmtPrice(p) {
  const n = Number(p);
  if (!(n > 0)) return "$0";
  if (n >= 1) return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 0.01) return "$" + n.toFixed(4);
  if (n >= 0.0001) return "$" + n.toFixed(6);
  // Sub-$0.0001: keep ~4 significant figures. The old toFixed(8) rounded any
  // price below ~1e-8 to "0.00000000" → the trailing-zero strip left "$0.".
  const decimals = Math.min(18, Math.max(8, -Math.floor(Math.log10(n)) + 3));
  const s = n.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
  return "$" + (s && s !== "0" ? s : n.toExponential(2));
}

/** Compact market-cap / big-number string: $1.72B, $138.0M, $24.0K. */
function fmtCap(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
  // ⚠️ NEVER ROUND A REAL NUMBER DOWN TO "$0" — see src/lib/format.ts, which
  // this is a 1:1 port of. The board printed "$0" volume beside "13 txns" for
  // a token that had traded $0.06. A printed zero is a claim nobody measured.
  // A TRUE zero still prints "$0"; that one is a fact.
  //
  // No "<" in any branch: this string reaches Telegram with parse_mode HTML,
  // where one bare "<" makes it reject the whole message.
  if (v === 0) return "$0";
  if (v > 0 && v < 1) {
    const places = Math.min(8, Math.max(2, -Math.floor(Math.log10(v))));
    return "$" + v.toFixed(places);
  }
  return "$" + Math.round(v);
}


/** Compact plain number (no $): 1.2M, 840.0K, 42. */
/**
 * "500k" → 500000. The INVERSE of fmtCap, and it lives beside it for that reason.
 *
 * Returns null on anything it cannot read — never a number, and never a default.
 * That is the whole point: an admin sent `500k` to the market-cap floor, and the
 * handler did `Number("500k")` → NaN → clampNum swapped in the $1M default →
 * the bot answered "✅ Minimum market cap → $1.00M". The value asked for was
 * never stored and the reply claimed success. A parser that cannot fail is a
 * parser that lies for its caller.
 *
 * Accepts a bare number, thousands separators, a leading $, a trailing % or +,
 * and a k/m/b/t suffix in either case. Rejects everything else, including
 * "1.2.3", "12kk" and "abc".
 */
function parseCap(s) {
  const t = String(s == null ? "" : s).trim().replace(/[$,\s%+]/g, "").toLowerCase();
  if (!t) return null;
  const m = /^(\d+(?:\.\d+)?)([kmbt])?$/.exec(t);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2]] || 1;
  const n = Number(m[1]) * mult;
  return Number.isFinite(n) ? n : null;
}

function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}

/** fourtis-style compact (guards non-numbers instead of throwing). */
function formatNumber(num) {
  const v = Number(num);
  if (!Number.isFinite(v)) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (abs >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (abs >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  if (abs < 0.01 && abs > 0) return v.toFixed(4);
  if (abs < 1) return v.toFixed(3);
  if (abs < 100) return v.toFixed(2);
  return String(Math.floor(v));
}

/** Signed 24h-change label: "+204%", "+27.7%", "+4.6%", "" when there is no
 *  number. ONE precision rule — integers at triple digits, one decimal below —
 *  because these labels sit in an aligned mono column: a "+8.20%" beside a
 *  "+22.1%" reads as untuned formatting, the kind of tell a design review
 *  catches instantly. Shared by the gainers banner and its caption so the two
 *  can never disagree about what the same token moved. */
function fmtPct(n) {
  // Absence has to be checked BEFORE the parse: Number(null) is 0 and 0 is
  // finite, so a token with no 24h change read back as a flat "0.0%" — a number
  // nobody measured, printed on a public banner as though it had been.
  if (n === null || n === undefined || n === "") return "";
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const s = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1);
  return `${v > 0 ? "+" : ""}${s}%`;
}

function fmtAge(m) {
  if (m == null || !Number.isFinite(Number(m))) return "—";
  const v = Number(m);
  if (v < 60) return Math.max(0, Math.round(v)) + "m";
  if (v < 1440) return Math.round(v / 60) + "h";
  return Math.round(v / 1440) + "d";
}

function shortAddr(a) {
  const s = String(a || "");
  if (s.length <= 16) return s;
  return s.slice(0, 8) + "…" + s.slice(-6);
}

/** Escape for Telegram parse_mode:"HTML" (only & < > need escaping). */
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Trim a float for display: 0.5→"0.5", 5→"5". */
function trimAmount(n) {
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(8)));
}

/**
 * A ticker with EXACTLY ONE `$`.
 *
 * ⚠️ `post:check` printed `$$ORCHFLOWS` on the one line whose job is naming the
 * token, and the paid-post alert did the same — both wrote `` `$${sym}` `` over
 * a stored `sym` that already carries the `$` (the listing store's convention:
 * `sym: "$BONK"`). It is not always there, which is why six other places in
 * this repo already write `$` + `replace(/^\$/, "")` by hand; those are all
 * correct and deliberately left alone. What may not happen again is a NEW
 * operator-facing surface spelling it a seventh time and getting it wrong.
 */
const ticker = (sym) => {
  const s = String(sym == null ? "" : sym).trim().replace(/^\$+/, "");
  return s ? `$${s}` : "$?";
};

module.exports = {
  parseCap, fmtPrice, fmtCap, fmtNum, fmtPct, formatNumber, fmtAge, shortAddr, escapeHtml, trimAmount, ticker };
