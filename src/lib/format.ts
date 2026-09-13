// Number formatting ported 1:1 from the prototype (fmtPrice etc.) — the
// handoff calls these out as canonical.
export function fmtPrice(p: number | null): string {
  // null is "not known here" and prints the same dash every other formatter
  // prints for it — a price of $0 is a claim, and no market prices at zero.
  if (p == null || !Number.isFinite(p)) return "—";
  // guard: without this, the trailing-zero strip below turns 0 into "$0."
  if (!(p > 0)) return "$0";
  if (p >= 1)
    return (
      "$" +
      p.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  if (p >= 0.01) return "$" + p.toFixed(4);
  if (p >= 0.0001) return "$" + p.toFixed(6);
  // Sub-$0.0001: keep ~4 significant figures. The old toFixed(8) rounded any
  // price below ~1e-8 down to "0.00000000", and the trailing-zero strip then
  // left a bare "$0." (looked broken for tiny memecoin prices).
  const decimals = Math.min(18, Math.max(8, -Math.floor(Math.log10(p)) + 3));
  const s = p.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
  return "$" + (s && s !== "0" ? s : p.toExponential(2));
}

export function fmtCap(n: number | null): string {
  // ⚠️ AND A NON-FINITE VALUE IS "—", NOT "$NaN".
  //
  // The two copies of this function had drifted on exactly one input: the bot's
  // port guards `!Number.isFinite(Number(n))` and this one did not, so a NaN
  // reaching a board cell printed `$NaN` on the site and `—` in a channel post
  // — the divergence the "they must agree exactly" test exists to prevent, on
  // the one case that test never tried. `$NaN` is never a wanted output for any
  // caller, and an unreadable figure is a dash everywhere else in this repo.
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  // ⚠️ NEVER ROUND A REAL NUMBER DOWN TO "$0".
  //
  // `Math.round` alone printed $0 for every value under half a dollar, and the
  // board showed it beside its own transaction count: "$0" volume next to "13
  // txns · 6 buys / 7 sells". Measured on the live board — $MRNA traded $0.06,
  // $GOOGL $0.04, $AMZN $0.31 — so the row asserted no trading happened over
  // data proving it did. A printed zero is a claim, and this repo refuses the
  // same shape for an unreadable 24h change; it had never been applied here.
  //
  // A TRUE zero still prints "$0" — the row with 0 buys and 0 sells is the one
  // state in which that is a fact.
  if (n === 0) return "$0";
  if (n > 0 && n < 1) {
    // Enough decimals that the value cannot render as zero, and no more.
    // 0.31 → $0.31 · 0.06 → $0.06 · 0.004 → $0.004
    const places = Math.min(8, Math.max(2, -Math.floor(Math.log10(n))));
    return "$" + n.toFixed(places);
  }
  return "$" + Math.round(n);
}

export function fmtNum(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

export function fmtAge(m: number | null): string {
  if (m == null) return "—";
  if (m < 60) return Math.max(0, Math.round(m)) + "m";
  if (m < 1440) return Math.round(m / 60) + "h";
  return Math.round(m / 1440) + "d";
}

export function pathFrom(pts: number[], w: number, h: number, pad = 3): string {
  const mx = Math.max(...pts),
    mn = Math.min(...pts),
    step = w / (pts.length - 1);
  const ys = pts.map((v) => h - pad - ((v - mn) / (mx - mn || 1)) * (h - pad * 2));
  let d = "M0," + ys[0].toFixed(1);
  ys.forEach((y, i) => {
    if (i) d += " L" + (i * step).toFixed(1) + "," + y.toFixed(1);
  });
  return d;
}

export function shortAddr(a: string): string {
  if (a.length <= 16) return a;
  return a.slice(0, 8) + "…" + a.slice(-6);
}
