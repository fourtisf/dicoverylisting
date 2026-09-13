// Deterministic fallback visuals for tokens without a logo image. The old look
// stamped a RANDOM emoji (🥛/⛽/🏹…) on the gradient — it read as cheap and
// unrelated to the token. We now render a clean ticker MONOGRAM (Uniswap /
// GitHub-avatar style) on a refined jewel-tone gradient instead; `emoji` is
// kept only for back-compat callers.
const EMOJIS = ["🐸","🚀","🌕","💎","⚡","🐶","🦉","🍰","🐻","🛰️","🌿","👾","🥛","⛽","🏹","🍙","🍛","🗿","🐈‍⬛","⚔️"];

// Cohesive jewel tones that sit with the mint→cyan brand — no garish
// yellow/pink primaries. Light → mid → deep so a white monogram always reads.
const GRADIENTS: [string, string, string][] = [
  ["#8FD3FF", "#4C82F7", "#1E3A8A"], // sapphire
  ["#7BE8C2", "#22C39A", "#0B6E52"], // emerald (brand)
  ["#C4A6FF", "#8B5CF6", "#5B21B6"], // amethyst
  ["#7FE3F0", "#22D3EE", "#0E7490"], // cyan (brand)
  ["#A7F3D0", "#34D399", "#065F46"], // jade
  ["#BAE6FD", "#38BDF8", "#075985"], // sky
  ["#FBC79E", "#F59E4B", "#B45309"], // amber (rare)
  ["#F5A8C7", "#EC6AA0", "#9D2A63"], // rose (rare)
  ["#9DB4FF", "#6172F3", "#312E81"], // indigo
  ["#8AE7D0", "#2DD4BF", "#0F766E"], // teal
];

/** Ticker monogram: the first 1-2 alphanumerics of the symbol, uppercased.
 *  "$RISE" → "RI", "$W" → "W", "" → "•". Used for the logo-less placeholder. */
export function monogram(sym?: string): string {
  const s = String(sym || "").replace(/^\$+/, "").replace(/[^A-Za-z0-9]/g, "");
  if (!s) return "•";
  return s.slice(0, 2).toUpperCase();
}

export function hashStr(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

export function visualFor(sym: string): { emoji: string; gradient: [string, string, string] } {
  const h = hashStr(sym);
  // `h` is an unsigned 32-bit value, so use the UNSIGNED shift `>>>`. The
  // signed `>>` sign-extends when the high bit is set, making the result
  // negative → a negative modulo → an out-of-range index → undefined gradient
  // → "Cannot read properties of undefined (reading '0')" in coinBg for ~half
  // of all symbols. (Seed tokens dodge this by carrying hardcoded gradients.)
  return {
    emoji: EMOJIS[h % EMOJIS.length],
    gradient: GRADIENTS[(h >>> 4) % GRADIENTS.length],
  };
}

export function coinBg(g?: [string, string, string]): string {
  // defensive fallback so a bad/missing gradient can never blank the page
  const c = g ?? ["#B8FFD0", "#3DF59F", "#0B9E5E"];
  return `radial-gradient(circle at 32% 26%,${c[0]},${c[1]} 45%,${c[2]})`;
}

/** Synthetic sparkline seeded by symbol — same construction as the prototype.
 *  Replaced by real OHLCV in a later phase. */
export function syntheticTrend(sym: string, chg24h: number): number[] {
  const i = hashStr(sym) % 23;
  const pts: number[] = [];
  let v = 50;
  const drift = chg24h >= 0 ? 0.9 : -0.9;
  for (let k = 0; k < 26; k++) {
    v += drift + Math.sin(i * 3.7 + k * 1.3) * 4 + (((k * i) % 5) - 2);
    v = Math.max(8, Math.min(92, v));
    pts.push(v);
  }
  if (chg24h >= 0) pts[pts.length - 1] = Math.max(...pts);
  return pts;
}
