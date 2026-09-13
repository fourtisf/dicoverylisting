// Top-Gainers banners — six layouts drawn in the dexvra.io design language.
//
// The operator picks a layout in @dexvraadminbot, the live top movers
// (gainers.js) are burned into it, and the finished PNG goes to a channel.
// Everything is procedural (@napi-rs/canvas), so a layout works the moment the
// code ships and adapts to however many real gainers exist right now.
//
// DESIGN. The reference is the product, not a poster: the site's surfaces
// (#090C12 page under mint+violet blooms, #101624 panels, hairline borders),
// its typefaces (Space Grotesk display / JetBrains Mono for every number and
// wide-tracked micro-label), the real logo mark, the board's `.chg.up` change
// pill, its `.btn-primary` gradient CTA, and — ported line-for-line from
// src/lib/visual.ts — the SAME deterministic sparkline and jewel-tone monogram
// gradients the site renders for a token. The table layouts are ONE panel with
// hairline-separated rows and a `.row.head` column strip, because that is what
// the Dexvra board actually looks like; a film-grain pass keeps the big dark
// fields from banding. No glowing titles, no medallions, no sparkles.
//
// THE CONTRACT (same shape as the per-token cards in bannerRender.js):
//   • render() NEVER throws and never rejects — any failure resolves null, and
//     null means the caller posts nothing rather than posting something wrong.
//   • The layout is driven by coins.length, never by the template's nominal
//     size. Three live gainers on the "Top 5" layout draws three rows, titled
//     "Top 3 Gainers" — never two empty slots.
//   • No number is invented here. A coin with no market cap simply doesn't get
//     that cell; the % comes from gainers.js, which drops unpriced tokens. The
//     sparkline is the site's own synthetic trend (decorative, deterministic
//     per symbol, direction taken from the REAL 24h change) — identical to the
//     curve dexvra.io draws for the same token.
//
// Coordinates are written in a 1600×900 reference space and multiplied by S, so
// a template can change output size without a re-layout.
const fss = require("node:fs");
const { toSendBuffer } = require("./helpers/encodeImage");
const {
  canvasLib,
  F,
  SITE,
  rankColor,
  medalOf,
  metalGrad,
  sparkle,
  trackedCenter,
  hexA,
  radial,
  roundRect,
  drawBrandMark,
  fitText,
} = require("./helpers/canvasKit");
const { fmtCap, fmtPrice, fmtPct } = require("./helpers/format");
const log = require("./helpers/logger");

const REF_W = 1600;
const REF_H = 900;
// One margin everywhere; content band shared by every layout so the six banners
// keep one horizon line.
const PAD = 72;
const BAND_TOP = 276;
const BAND_BOTTOM = 794;
const BAND_H = BAND_BOTTOM - BAND_TOP;

// ── Templates ───────────────────────────────────────────────────────────────
const TEMPLATES = {
  hero1: {
    id: "hero1",
    label: "👑 #1 Spotlight",
    blurb: "One hero card for the single biggest 24h mover.",
    n: 1,
    layout: "hero",
    mood: "dawn",
    accent: SITE.mint,
    title: () => "Top Gainer",
  },
  duel2: {
    id: "duel2",
    label: "⚔️ Top 2 Duel",
    blurb: "Two premium cards head-to-head — the day's winner against its runner-up.",
    n: 2,
    layout: "duel",
    mood: "clash",
    accent: SITE.gold,
    title: (n) => (n >= 2 ? "Top 2 Gainers" : "Top Gainer"),
  },
  podium: {
    id: "podium",
    label: "🏆 Top 3 Podium",
    blurb: "Three tall cards, the winner raised — the classic winners' shot.",
    n: 3,
    layout: "podium",
    mood: "stage",
    accent: SITE.gold,
    title: (n) => (n >= 3 ? "Top 3 Gainers" : `Top ${n} Gainer${n > 1 ? "s" : ""}`),
  },
  cards4: {
    id: "cards4",
    label: "🃏 Top 4 Cards",
    blurb: "Four product cards, 2×2 — the move as each card's headline.",
    n: 4,
    layout: "cards",
    mood: "quad",
    accent: SITE.cyan,
    title: (n) => `Top ${n} Gainers`,
  },
  list5: {
    id: "list5",
    label: "📋 Top 5 List",
    blurb: "The Dexvra board itself — one panel, real columns, sparklines.",
    n: 5,
    layout: "list",
    mood: "boardroom",
    accent: SITE.mint,
    title: (n) => `Top ${n} Gainers`,
  },
  tier6: {
    id: "tier6",
    label: "🏛 Top 6 Tiers",
    blurb: "The podium as three crowned cards, ranks 4–6 on a board beneath — two tiers, one poster.",
    n: 6,
    layout: "tiers",
    mood: "strata",
    accent: SITE.gold,
    title: (n) => (n > 1 ? `Top ${n} Gainers` : "Top Gainer"),
  },
  crown7: {
    id: "crown7",
    label: "👑 Top 7 Crown",
    blurb: "A full-width champion band over two boards of three — the day's winner literally on top.",
    n: 7,
    layout: "crown",
    mood: "regal",
    accent: SITE.gold,
    title: (n) => (n > 1 ? `Top ${n} Gainers` : "Top Gainer"),
  },
  rail8: {
    id: "rail8",
    label: "🎞 Top 8 Rail",
    blurb: "Two board panels of four — the Top-8 shape, Dexvra styling.",
    n: 8,
    layout: "rail",
    mood: "beams",
    accent: SITE.cyan,
    title: (n) => `Top ${n} Gainers`,
  },
  mosaic9: {
    id: "mosaic9",
    label: "🧩 Top 9 Mosaic",
    blurb: "Nine compact tiles, three by three — every mover as its own small card.",
    n: 9,
    layout: "mosaic",
    mood: "nebula",
    accent: SITE.violet,
    title: (n) => (n > 1 ? `Top ${n} Gainers` : "Top Gainer"),
  },
  grid10: {
    id: "grid10",
    label: "🔟 Top 10 Grid",
    blurb: "The full top ten, two compact board panels of five.",
    n: 10,
    layout: "grid",
    mood: "terminal",
    accent: SITE.violet,
    title: (n) => `Top ${n} Gainers`,
  },
  spot10: {
    id: "spot10",
    label: "💠 Top 10 Spotlight",
    blurb: "The champion as a full hero card, the chasing nine on one board — the premium Top-10.",
    n: 10,
    layout: "spotlight",
    mood: "laurel",
    accent: SITE.gold,
    title: (n) => (n > 1 ? `Top ${n} Gainers` : "Top Gainer"),
  },
};
const TEMPLATE_IDS = Object.keys(TEMPLATES);
const DEFAULT_TEMPLATE = "list5";

const specOf = (id) => TEMPLATES[id] || TEMPLATES[DEFAULT_TEMPLATE];
const countOf = (id) => specOf(id).n;
const labelOf = (id) => specOf(id).label;
const isTemplate = (id) => Object.prototype.hasOwnProperty.call(TEMPLATES, id);
const templateList = () => TEMPLATE_IDS.map((id) => ({ ...TEMPLATES[id] }));

/** Resolve a template choice. `"random"` (or anything unknown) picks from
 *  `pool` — the admin's rotation, or every template when that is empty. */
function pickTemplate(id, { pool = [], rng = Math.random } = {}) {
  if (isTemplate(id)) return id;
  const from = (pool || []).filter(isTemplate);
  const list = from.length ? from : TEMPLATE_IDS;
  return list[Math.floor(rng() * list.length) % list.length];
}

// ── the site's own token visuals, ported from src/lib/visual.ts ─────────────
// Same hash, same gradients, same trend construction — so a token's monogram
// colour and sparkline on the banner match what dexvra.io shows for it.
function hashStr(s) {
  let h = 0;
  for (const c of String(s || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
const JEWEL_GRADIENTS = [
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
const jewelFor = (sym) => JEWEL_GRADIENTS[(hashStr(sym) >>> 4) % JEWEL_GRADIENTS.length];
/** "$RISE" → "RI" — the site's monogram rule (2 chars, not 3). */
function monogramOf(sym) {
  const s = String(sym || "").replace(/^\$+/, "").replace(/[^A-Za-z0-9]/g, "");
  return s ? s.slice(0, 2).toUpperCase() : "•";
}
/** The site's synthetic sparkline: deterministic per symbol, drift from the
 *  REAL 24h sign, last point pinned to the high on a gainer. */
function syntheticTrend(sym, chg24h) {
  const i = hashStr(sym) % 23;
  const pts = [];
  let v = 50;
  const drift = (Number(chg24h) || 0) >= 0 ? 0.9 : -0.9;
  for (let k = 0; k < 26; k++) {
    v += drift + Math.sin(i * 3.7 + k * 1.3) * 4 + (((k * i) % 5) - 2);
    v = Math.max(8, Math.min(92, v));
    pts.push(v);
  }
  if ((Number(chg24h) || 0) >= 0) pts[pts.length - 1] = Math.max(...pts);
  return pts;
}

/** The banner's variant of the same construction, with the drift turned up so
 *  the REAL direction dominates the per-symbol wobble. Needed because scale
 *  changes the reading: at the site's 60px a sparkline is texture, but on a
 *  banner it is a hero element — and a "Top Gainers" board whose #1 carries a
 *  visibly descending curve looks broken, even when the wobble is decorative.
 *  Still deterministic per symbol, still direction-true, same clamp/pin. */
function bannerTrend(sym, chg24h) {
  const i = hashStr(sym) % 23;
  const pts = [];
  let v = 50;
  const up = (Number(chg24h) || 0) >= 0;
  // Slope tracks the SIZE of the real move (log-scaled) and the wobble varies
  // per symbol — five rows of one cloned waveform is placeholder art, and a
  // +204% should visibly out-climb a +27%.
  const a = Math.abs(Number(chg24h) || 0);
  const slope = 0.8 + Math.min(2.4, Math.log10(1 + a) * 1.05);
  const drift = (up ? 1 : -1) * slope;
  // Wobble varies per symbol but is CAPPED against the slope — a seed whose
  // amplitude out-muscles the drift renders a sideways heart-monitor line, and
  // one flat row in a column of risers reads as broken data.
  const amp = Math.min(2.0 + (i % 5) * 0.55, slope * 1.1);
  const jag = Math.min(0.5 + ((i >> 2) % 3) * 0.35, slope * 0.4);
  for (let k = 0; k < 26; k++) {
    v += drift + Math.sin(i * 3.7 + k * (1.05 + (i % 4) * 0.16)) * amp + (((k * i) % 5) - 2) * jag;
    v = Math.max(6, Math.min(94, v));
    pts.push(v);
  }
  if (up) pts[pts.length - 1] = Math.max(...pts);
  return pts;
}

// ── primitives ──────────────────────────────────────────────────────────────
/** Cover-fit an image into a box (the CSS `object-fit: cover` maths). */
function drawCover(ctx, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  const iw = img.width * s;
  const ih = img.height * s;
  ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
}

/** Uppercase micro-label: JetBrains Mono, wide tracking — the site's
 *  `.nav-label` / `.row.head` / `.fld label` voice. */
function microLabel(ctx, x, y, text, { size = 11, color = SITE.faint, track = 0.22, align = "left", weight = 700 } = {}) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${weight >= 800 ? F.m8 : weight >= 700 ? F.m7 : F.m6}`;
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";
  const t = String(text).toUpperCase();
  const spacing = size * track;
  const chars = [...t];
  const total = chars.reduce((a, c) => a + ctx.measureText(c).width, 0) + spacing * Math.max(0, chars.length - 1);
  let cx = align === "right" ? x - total : align === "center" ? x - total / 2 : x;
  ctx.textAlign = "left";
  for (const c of chars) {
    ctx.fillText(c, cx, y);
    cx += ctx.measureText(c).width + spacing;
  }
  ctx.restore();
  return total;
}

/** Display text in Space Grotesk with the slight negative tracking every
 *  startup wordmark carries at large sizes. */
function displayText(ctx, x, y, text, size, { weight = 700, color = SITE.text, align = "left" } = {}) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${weight >= 700 ? F.d7 : weight >= 600 ? F.d6 : F.d5}`;
  if (size >= 30) ctx.letterSpacing = `${(-0.018 * size).toFixed(1)}px`;
  ctx.fillStyle = color;
  ctx.textAlign = align === "center" ? "center" : align === "right" ? "right" : "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x, y);
  const w = ctx.measureText(text).width;
  ctx.letterSpacing = "0px";
  ctx.restore();
  return w;
}

/** A surface: the site's `--card` fill, hairline border, soft shadow, and a
 *  1px top light — the "lit from above" edge every polished dark UI has. */
function surface(ctx, x, y, w, h, r, { accent = null, S = 1, lift = 1, fill = SITE.card } = {}) {
  // coloured halo behind an accented card — the neon seat
  if (accent) {
    ctx.save();
    roundRect(ctx, x, y, w, h, r);
    ctx.shadowColor = hexA(accent, 0.4);
    ctx.shadowBlur = 40 * S * lift;
    ctx.fillStyle = hexA(accent, 0.05);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.5)";
  ctx.shadowBlur = 36 * S * lift;
  ctx.shadowOffsetY = 14 * S * lift;
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
  // glass coat: a white gradient wash over the dark base
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  const gl = ctx.createLinearGradient(x, y, x, y + h);
  gl.addColorStop(0, "rgba(255,255,255,.075)");
  gl.addColorStop(1, "rgba(255,255,255,.015)");
  ctx.fillStyle = gl;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
  if (accent) {
    ctx.save();
    roundRect(ctx, x, y, w, h, r);
    ctx.clip();
    const g = ctx.createLinearGradient(x, y, x + w * 0.9, y + h);
    g.addColorStop(0, hexA(accent, 0.12));
    g.addColorStop(0.55, hexA(accent, 0.025));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
  // border: slightly brighter on top, dimmer at the bottom (top-lit)
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  const b = ctx.createLinearGradient(0, y, 0, y + h);
  b.addColorStop(0, accent ? hexA(accent, 0.42) : "rgba(255,255,255,.2)");
  b.addColorStop(1, accent ? hexA(accent, 0.14) : "rgba(255,255,255,.08)");
  ctx.lineWidth = Math.max(1, 1.2 * S);
  ctx.strokeStyle = b;
  ctx.stroke();
  // inner top light
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  ctx.fillStyle = "rgba(255,255,255,.06)";
  ctx.fillRect(x + r * 0.5, y + 1, w - r, Math.max(1, 1.1 * S));
  ctx.restore();
}

/** The board's 24h change pill — `.chg.up` / `.chg.dn` from globals.css, with a
 *  drawn direction triangle. Dark ink on the bright gain gradient. */
function pctChip(ctx, x, y, text, size, S, { align = "c" } = {}) {
  if (!text) return 0;
  const up = !String(text).startsWith("-");
  const t = String(text).replace(/^[+-]/, "");
  ctx.save();
  ctx.font = `800 ${size}px ${F.m8}`;
  const tw = ctx.measureText(t).width;
  const tri = size * 0.5;
  const gap = size * 0.32;
  const padX = size * 0.66;
  const padY = size * 0.5;
  const w = padX * 2 + tri + gap + tw;
  const h = size + padY * 2;
  const left = align === "l" ? x : align === "r" ? x - w : x - w / 2;
  const top = y - h / 2;
  roundRect(ctx, left, top, w, h, h * 0.36);
  const g = ctx.createLinearGradient(left, top + h, left + w, top);
  g.addColorStop(0, up ? SITE.upTo : SITE.downTo);
  g.addColorStop(1, up ? SITE.upFrom : SITE.downFrom);
  ctx.shadowColor = hexA(up ? SITE.mint : SITE.red, 0.3);
  ctx.shadowBlur = 22 * S;
  ctx.shadowOffsetY = 5 * S;
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  const ink = up ? SITE.upInk : SITE.downInk;
  // direction triangle
  const tx = left + padX;
  const ty = y + size * 0.04;
  ctx.fillStyle = ink;
  ctx.beginPath();
  if (up) {
    ctx.moveTo(tx + tri / 2, ty - tri * 0.62);
    ctx.lineTo(tx + tri, ty + tri * 0.38);
    ctx.lineTo(tx, ty + tri * 0.38);
  } else {
    ctx.moveTo(tx + tri / 2, ty + tri * 0.62);
    ctx.lineTo(tx + tri, ty - tri * 0.38);
    ctx.lineTo(tx, ty - tri * 0.38);
  }
  ctx.closePath();
  ctx.fill();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(t, tx + tri + gap, ty);
  ctx.restore();
  return w;
}

/** The move as TYPE — a large gradient mono figure with a direction triangle.
 *  Used where the % is a card's headline rather than a table cell. */
function bigPct(ctx, x, y, text, size, S, { align = "left" } = {}) {
  if (!text) return 0;
  const up = !String(text).startsWith("-");
  const t = String(text).replace(/^[+-]/, "");
  ctx.save();
  ctx.font = `800 ${size}px ${F.m8}`;
  ctx.letterSpacing = `${(-0.02 * size).toFixed(1)}px`;
  const tw = ctx.measureText(t).width;
  const tri = size * 0.44;
  const gap = size * 0.2;
  const total = tri + gap + tw;
  const left = align === "center" ? x - total / 2 : align === "right" ? x - total : x;
  const g = ctx.createLinearGradient(0, y - size * 0.9, 0, y + size * 0.1);
  g.addColorStop(0, up ? SITE.upFrom : SITE.downFrom);
  g.addColorStop(1, up ? SITE.mintDeep : SITE.downTo);
  ctx.fillStyle = g;
  ctx.shadowColor = hexA(up ? SITE.mint : SITE.red, 0.25);
  ctx.shadowBlur = 24 * S;
  ctx.beginPath();
  const tcy = y - size * 0.32;
  if (up) {
    ctx.moveTo(left + tri / 2, tcy - tri * 0.55);
    ctx.lineTo(left + tri, tcy + tri * 0.45);
    ctx.lineTo(left, tcy + tri * 0.45);
  } else {
    ctx.moveTo(left + tri / 2, tcy + tri * 0.55);
    ctx.lineTo(left + tri, tcy - tri * 0.45);
    ctx.lineTo(left, tcy - tri * 0.45);
  }
  ctx.closePath();
  ctx.fill();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(t, left + tri + gap, y);
  ctx.letterSpacing = "0px";
  ctx.restore();
  return total;
}

/** A bordered mono chip — the site's `.ichip` / `.age-chip`. */
function chip(ctx, x, y, text, size, S, { color = SITE.muted, border = SITE.line2, bg = "rgba(255,255,255,.03)", align = "left", track = 0.12 } = {}) {
  ctx.save();
  ctx.font = `700 ${size}px ${F.m7}`;
  const t = String(text).toUpperCase();
  const spacing = size * track;
  const tw = [...t].reduce((a, c) => a + ctx.measureText(c).width, 0) + spacing * Math.max(0, t.length - 1);
  const padX = size * 0.85;
  const padY = size * 0.58;
  const w = tw + padX * 2;
  const h = size + padY * 2;
  const left = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
  roundRect(ctx, left, y - h / 2, w, h, h * 0.34);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = Math.max(1, 1.1 * S);
  ctx.strokeStyle = border;
  ctx.stroke();
  ctx.restore();
  microLabel(ctx, left + padX, y + size * 0.36, t, { size, color, track, weight: 700 });
  return w;
}

/** Token avatar: circle-clipped logo, or the site's jewel-gradient monogram
 *  (visual.ts) when no logo decoded — never an empty disc. Neutral rim for
 *  everyone; rank is carried by the number, not a coloured ring. */
function avatar(ctx, img, cx, cy, d, symbol, S) {
  const r = d / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = "#0A0E16";
  ctx.fillRect(cx - r, cy - r, d, d);
  if (img) {
    drawCover(ctx, img, cx - r, cy - r, d, d);
  } else {
    // FLAT disc — a soft vertical ramp within the jewel's mid/deep tones and a
    // white monogram. The radial-with-hotspot version read as a glossy Web-2.0
    // orb against the flat panels, which is exactly the "programmer art" tell.
    const [, c1, c2] = jewelFor(symbol);
    const g = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
    g.addColorStop(0, c1);
    g.addColorStop(1, c2);
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, d, d);
    ctx.fillStyle = "rgba(241,245,251,.95)";
    ctx.font = `700 ${Math.round(d * 0.36)}px ${F.d7}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(monogramOf(symbol), cx, cy + d * 0.02);
  }
  ctx.restore();
  // ambient seat for the big feature avatars so the disc sits IN the card
  if (d >= 100 * S) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.shadowColor = "rgba(0,0,0,.45)";
    ctx.shadowBlur = 30 * S;
    ctx.shadowOffsetY = 10 * S;
    ctx.strokeStyle = "rgba(0,0,0,.01)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1.5, 2 * S);
  ctx.strokeStyle = "rgba(255,255,255,.14)";
  ctx.stroke();
}

/** The avatar's metal ring — gold/silver/bronze for the podium ranks, drawn
 *  OVER the neutral rim so table rows can opt in per rank. */
function metalRing(ctx, cx, cy, d, rank, S) {
  if (rank > 3) return;
  const r = d / 2;
  const m = medalOf(rank);
  radial(ctx, cx, cy, r * 1.55, m.glow, 0.28);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r + Math.max(1.5, d * 0.03), 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, d * 0.06);
  ctx.strokeStyle = metalGrad(ctx, cx, cy, r, m);
  ctx.shadowColor = hexA(m.glow, 0.5);
  ctx.shadowBlur = 14 * S;
  ctx.stroke();
  ctx.restore();
}

/** Podium medallion — metallic gold/silver/bronze ring, dark glass face, the
 *  rank numeral, a sparkle on the champion. The bold system's rank voice. */
function medal(ctx, cx, cy, r, rank, S) {
  const m = medalOf(rank);
  radial(ctx, cx, cy, r * 2, m.glow, 0.3);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#080F16";
  ctx.shadowColor = "rgba(0,0,0,.6)";
  ctx.shadowBlur = 14 * S;
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, r * 0.24);
  ctx.strokeStyle = metalGrad(ctx, cx, cy, r, m);
  ctx.stroke();
  // top sheen on the ring
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI * 1.1, Math.PI * 1.6);
  ctx.lineWidth = Math.max(2, r * 0.24);
  ctx.strokeStyle = "rgba(255,255,255,.5)";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.font = `800 ${Math.round(r * 1.02)}px ${F.m8}`;
  const g = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
  g.addColorStop(0, "#FFFFFF");
  g.addColorStop(1, m.light);
  ctx.fillStyle = g;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(rank), cx, cy + r * 0.06);
  ctx.restore();
  if (rank === 1 && r >= 16 * S) sparkle(ctx, cx + r * 0.9, cy - r * 0.85, r * 0.32, m.light);
}

/** Rank as an editorial two-digit numeral — "01", faint, mono. */
function rankNum(ctx, x, y, rank, size, { align = "right", pad = true } = {}) {
  ctx.save();
  ctx.font = `700 ${size}px ${F.m7}`;
  ctx.fillStyle = rank <= 3 ? rankColor(rank) : SITE.faint;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(pad ? String(rank).padStart(2, "0") : String(rank), x, y);
  ctx.restore();
}

/** The site's sparkline for a token: smooth area chart, mint on gains, red on
 *  losses, with a lit end-point. Pure decoration at low weight — no axes. */
function sparkline(ctx, x, y, w, h, sym, pct, S, { alpha = 1 } = {}) {
  const pts = bannerTrend(sym, pct);
  const up = (Number(pct) || 0) >= 0;
  const col = up ? SITE.mint : SITE.red;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = Math.max(1, max - min);
  const px = (k) => x + (k / (pts.length - 1)) * w;
  const py = (v) => y + h - ((v - min) / span) * h;
  ctx.save();
  ctx.globalAlpha = alpha;
  // Area fill on an OFFSCREEN tile so its trailing edge can be faded out with
  // destination-out — closed in place, the fill ended in a hard vertical wall
  // under the endpoint ("flag pole"), the tell of an unclipped polygon.
  try {
    const kit = require("./helpers/canvasKit");
    const cv2 = kit.canvasLib();
    const off = cv2.createCanvas(Math.max(2, Math.ceil(w + 2)), Math.max(2, Math.ceil(h + 2)));
    const o = off.getContext("2d");
    const opx = (k) => (k / (pts.length - 1)) * w;
    const opy = (v) => h - ((v - min) / span) * h;
    o.beginPath();
    o.moveTo(opx(0), h);
    o.lineTo(opx(0), opy(pts[0]));
    for (let k = 0; k < pts.length - 1; k++) {
      const mx = (opx(k) + opx(k + 1)) / 2;
      const my = (opy(pts[k]) + opy(pts[k + 1])) / 2;
      o.quadraticCurveTo(opx(k), opy(pts[k]), mx, my);
    }
    o.lineTo(opx(pts.length - 1), opy(pts[pts.length - 1]));
    o.lineTo(opx(pts.length - 1), h);
    o.closePath();
    const fg = o.createLinearGradient(0, 0, 0, h);
    fg.addColorStop(0, hexA(col, 0.2));
    fg.addColorStop(1, hexA(col, 0));
    o.fillStyle = fg;
    o.fill();
    o.globalCompositeOperation = "destination-out";
    const fade = o.createLinearGradient(Math.max(0, w - 40), 0, w, 0);
    fade.addColorStop(0, "rgba(0,0,0,0)");
    fade.addColorStop(1, "rgba(0,0,0,1)");
    o.fillStyle = fade;
    o.fillRect(Math.max(0, w - 40), 0, 42, h + 2);
    ctx.drawImage(off, x, y);
  } catch {
    /* fill is a finish, never a failure — the stroke below still draws */
  }
  // line
  ctx.beginPath();
  ctx.moveTo(px(0), py(pts[0]));
  for (let k = 0; k < pts.length - 1; k++) {
    const mx = (px(k) + px(k + 1)) / 2;
    const my = (py(pts[k]) + py(pts[k + 1])) / 2;
    ctx.quadraticCurveTo(px(k), py(pts[k]), mx, my);
  }
  ctx.lineTo(px(pts.length - 1), py(pts[pts.length - 1]));
  ctx.lineWidth = Math.max(1.5, 2 * S);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = hexA(col, 0.85);
  ctx.stroke();
  // end dot
  const ex = px(pts.length - 1);
  const ey = py(pts[pts.length - 1]);
  radial(ctx, ex, ey, 9 * S, col, 0.5);
  ctx.beginPath();
  ctx.arc(ex, ey, 2.6 * S, 0, Math.PI * 2);
  ctx.fillStyle = col;
  ctx.fill();
  ctx.restore();
}

// The chain chips/stats were REMOVED from every banner surface on the
// operator's call ("chain ini hapus aja tidak ada teks chain", 2026-08-21,
// looking at the first live grid10): the caption under the post already names
// the chain and links the token, so on the artwork the tag was noise beside
// the name. The caption's chain label lives in gainers.js — this file no
// longer draws one anywhere; do not add a per-row chip back without that call
// being reversed.

// ── page chrome ─────────────────────────────────────────────────────────────
/** Deterministic film grain, tiled — keeps the near-black gradients from
 *  banding and gives the dark field the "printed" finish flat canvas lacks. */
function grain(cv, ctx, W, H, S) {
  try {
    const t = 128;
    const tile = cv.createCanvas(t, t);
    const tctx = tile.getContext("2d");
    const img = tctx.createImageData(t, t);
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed / 0xffffffff;
    };
    for (let i = 0; i < img.data.length; i += 4) {
      const v = rnd() < 0.5 ? 255 : 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = Math.floor(rnd() * 11); // ≤ 4% alpha
    }
    tctx.putImageData(img, 0, 0);
    const pat = ctx.createPattern(tile, "repeat");
    if (pat) {
      ctx.save();
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  } catch {
    /* grain is a finish, never a failure */
  }
}

/** Per-template backdrop MOODS — "backgroundnya juga beda-beda" (2026-08-21).
 *
 *  Every template used to sit on the identical aurora, so a channel posting a
 *  different layout each day still read as the same poster recoloured. Each
 *  mood repositions and recolours the bloom set — and only that: the scrim,
 *  dot grid, vignette, frame and keyline stay shared, because THOSE are the
 *  design system and varying them would make eleven banners from eleven
 *  brands. Every colour is a SITE token; a mood may add soft vertical beams
 *  where the composition has columns to seat.
 *
 *  Blooms are [x/W, y/H, r/W, token, alpha]; beams are [x/W, w/W, token, alpha].
 */
/** Each mood = blooms + a PATTERN — visible geometry of its own, because bloom
 *  positions alone were re-read as "the same background" ("saya ingin semua
 *  banner backgroundnya berbeda-beda tidak sama", after the first moods pass).
 *  Light positions are mood; a sunburst versus stage cones versus CRT
 *  scanlines is unmistakably a different field. Every pattern is deterministic
 *  (no Math.random — a re-render must be byte-stable) and painted UNDER the
 *  vignette so it recedes at the corners like everything else. */
const MOODS = {
  // hero1 — dawn: a mint sunrise with RAYS radiating from the champion's crown
  dawn: { blooms: [[0.5, -0.3, 0.85, "mint", 0.28], [0.5, 1.15, 0.55, "cyan", 0.12]], pattern: "rays" },
  // duel2 — clash: gold and cyan corners, opposing DIAGONAL BEAMS meeting mid
  clash: { blooms: [[0.12, 0.06, 0.5, "gold", 0.19], [0.88, 0.1, 0.5, "cyan", 0.2], [0.5, 1.1, 0.5, "violetDeep", 0.12]], pattern: "clashBeams" },
  // podium — stage: SPOTLIGHT CONES falling from above onto the three cards
  stage: { blooms: [[0.5, -0.18, 0.62, "gold", 0.19], [0.06, 0.75, 0.4, "violetDeep", 0.14], [0.94, 0.75, 0.4, "violetDeep", 0.14]], pattern: "cones" },
  // cards4 — quad: cyan/violet diagonal with 45° STRIPES across the field
  quad: { blooms: [[0.16, 0.12, 0.5, "cyan", 0.19], [0.86, 0.92, 0.55, "violet", 0.17], [0.9, 0.05, 0.35, "mint", 0.11]], pattern: "stripes" },
  // list5 — boardroom: the site aurora over a mint HORIZON band
  boardroom: { blooms: [[0.5, -0.22, 0.72, "mint", 0.23], [0.94, 1.04, 0.5, "cyan", 0.15], [-0.08, 0.55, 0.4, "violetDeep", 0.12]], pattern: "horizon" },
  // tier6 — strata: literal horizontal STRATA BANDS, gold tier over cyan tier
  strata: { blooms: [[0.28, 0.16, 0.55, "gold", 0.16], [0.75, 0.95, 0.6, "cyan", 0.18], [1.02, 0.3, 0.35, "violetDeep", 0.12]], pattern: "strataBands" },
  // crown7 — regal: a gold HALO arcing over the champion band
  regal: { blooms: [[0.5, -0.14, 0.8, "gold", 0.18], [0.5, 1.2, 0.7, "violetDeep", 0.19], [0.04, 0.4, 0.3, "mint", 0.1]], pattern: "halo" },
  // rail8 — beams: vertical light BEAMS seated behind the two strips
  beams: { blooms: [[0.5, -0.25, 0.6, "cyan", 0.17], [0.5, 1.15, 0.55, "mint", 0.11]], beams: [[0.27, 0.2, "cyan", 0.08], [0.73, 0.2, "violet", 0.08]], pattern: "beamsV" },
  // mosaic9 — nebula: violet field under a deterministic STARFIELD
  nebula: { blooms: [[0.2, 0.05, 0.5, "violet", 0.19], [0.85, 0.85, 0.55, "violetDeep", 0.21], [0.7, 0.1, 0.3, "mint", 0.12], [0.1, 0.9, 0.3, "cyan", 0.12]], pattern: "stars" },
  // grid10 — terminal: the coldest field, under CRT SCANLINES
  terminal: { blooms: [[0.5, -0.28, 0.7, "cyan", 0.19], [0.05, 1.05, 0.45, "violetDeep", 0.16], [0.95, 1.05, 0.45, "violetDeep", 0.16]], pattern: "scanlines" },
  // spot10 — laurel: concentric RINGS radiating from the champion's column
  laurel: { blooms: [[0.16, 0.3, 0.5, "gold", 0.17], [0.75, -0.15, 0.6, "mint", 0.19], [0.85, 1.1, 0.45, "cyan", 0.13]], pattern: "rings" },
};

/** The pattern painters. All deterministic, all SITE-token colours, all quiet
 *  enough that panels stay legible over them — the pattern is the field's
 *  signature, never a competitor to the data. */
const PATTERNS = {
  rays(ctx, W, H, S) {
    ctx.save();
    // apex ABOVE the frame — with it on-canvas the nine wedges stack into one
    // hot spike behind the keyline (seen on the first render)
    ctx.translate(W / 2, -H * 0.08);
    for (let i = 0; i < 9; i++) {
      const a = -Math.PI / 2 - 0.9 + i * 0.225;
      ctx.save();
      ctx.rotate(a + Math.PI / 2);
      const g = ctx.createLinearGradient(0, 0, 0, H * 1.1);
      g.addColorStop(0, hexA(SITE.mint, 0.055));
      g.addColorStop(1, hexA(SITE.mint, 0));
      ctx.fillStyle = g;
      ctx.fillRect(-26 * S, 0, 52 * S, H * 1.1);
      ctx.restore();
    }
    ctx.restore();
  },
  clashBeams(ctx, W, H, S) {
    const beam = (x0, rot, tok) => {
      ctx.save();
      ctx.translate(x0, -H * 0.15);
      ctx.rotate(rot);
      const g = ctx.createLinearGradient(0, 0, 240 * S, 0);
      g.addColorStop(0, hexA(SITE[tok], 0));
      g.addColorStop(0.5, hexA(SITE[tok], 0.07));
      g.addColorStop(1, hexA(SITE[tok], 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 240 * S, H * 1.7);
      ctx.restore();
    };
    beam(W * 0.02, 0.32, "gold");
    beam(W * 0.2, 0.32, "gold");
    beam(W * 0.62, -0.32, "cyan");
    beam(W * 0.82, -0.32, "cyan");
  },
  cones(ctx, W, H, S) {
    for (const fx of [0.19, 0.5, 0.81]) {
      const cx = W * fx;
      const g = ctx.createLinearGradient(0, 0, 0, H * 0.95);
      g.addColorStop(0, hexA(SITE.gold, fx === 0.5 ? 0.11 : 0.07));
      g.addColorStop(1, hexA(SITE.gold, 0));
      ctx.beginPath();
      ctx.moveTo(cx - 30 * S, 0);
      ctx.lineTo(cx + 30 * S, 0);
      ctx.lineTo(cx + W * 0.13, H * 0.95);
      ctx.lineTo(cx - W * 0.13, H * 0.95);
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
    }
  },
  stripes(ctx, W, H, S) {
    ctx.save();
    ctx.rotate(-Math.PI / 4);
    for (let x = -H; x < W + H; x += 150 * S) {
      ctx.fillStyle = "rgba(255,255,255,.022)";
      ctx.fillRect(x, -W, 56 * S, W * 2 + H * 2);
    }
    ctx.restore();
  },
  horizon(ctx, W, H, S) {
    const y = H * 0.305;
    const g = ctx.createLinearGradient(0, y - 60 * S, 0, y + 60 * S);
    g.addColorStop(0, hexA(SITE.mint, 0));
    g.addColorStop(0.5, hexA(SITE.mint, 0.08));
    g.addColorStop(1, hexA(SITE.mint, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, y - 60 * S, W, 120 * S);
    ctx.fillStyle = hexA(SITE.mint, 0.24);
    ctx.fillRect(0, y, W, Math.max(1, 1.2 * S));
  },
  strataBands(ctx, W, H, S) {
    void S;
    for (const [y0, y1, tok, a] of [[0.285, 0.3, "gold", 0.16], [0.3, 0.62, "gold", 0.035], [0.66, 0.675, "cyan", 0.16], [0.675, 0.9, "cyan", 0.035]]) {
      ctx.fillStyle = hexA(SITE[tok], a);
      ctx.fillRect(0, H * y0, W, H * (y1 - y0));
    }
  },
  halo(ctx, W, H, S) {
    ctx.save();
    for (const [r, a, lw] of [[0.34, 0.12, 30], [0.4, 0.07, 18], [0.46, 0.04, 10]]) {
      ctx.beginPath();
      ctx.arc(W / 2, H * 0.02, W * r, 0.15, Math.PI - 0.15);
      ctx.lineWidth = lw * S;
      ctx.strokeStyle = hexA(SITE.gold, a);
      ctx.stroke();
    }
    ctx.restore();
  },
  beamsV(ctx, W, H, S) {
    void S;
    // the mood's own beams already paint the verticals; add faint counter-rails
    for (const fx of [0.06, 0.5, 0.94]) {
      ctx.fillStyle = "rgba(255,255,255,.035)";
      ctx.fillRect(W * fx - 1, 0, 2, H);
    }
  },
  stars(ctx, W, H, S) {
    for (let i = 0; i < 46; i++) {
      const h = (i * 2654435761) >>> 0;
      const x = ((h % 997) / 997) * W;
      const y = (((h >> 10) % 883) / 883) * H;
      const r = (0.8 + ((h >> 20) % 5) * 0.42) * S;
      const tok = i % 4 === 0 ? SITE.mint : i % 7 === 0 ? SITE.cyan : SITE.violet;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = hexA(tok, 0.1 + ((h >> 8) % 4) * 0.045);
      ctx.fill();
    }
  },
  scanlines(ctx, W, H, S) {
    ctx.fillStyle = "rgba(150,215,238,.028)";
    for (let y = 0; y < H; y += 6 * S) ctx.fillRect(0, y, W, Math.max(1, 1.1 * S));
  },
  rings(ctx, W, H, S) {
    const cx = W * 0.16;
    const cy = H * 0.55;
    for (let i = 1; i <= 5; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, i * 130 * S, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1, 1.4 * S);
      ctx.strokeStyle = hexA(SITE.gold, 0.09 - i * 0.012);
      ctx.stroke();
    }
  },
};

/** The site's page: #090C12 under the template's own bloom mood, a whisper
 *  grid, film grain, and a mint→cyan keyline across the very top. */
function backdrop(cv, ctx, S, spec, bg) {
  const W = REF_W * S;
  const H = REF_H * S;
  if (bg) {
    drawCover(ctx, bg, 0, 0, W, H);
    const scrim = ctx.createLinearGradient(0, 0, 0, H);
    scrim.addColorStop(0, "rgba(9,12,18,.82)");
    scrim.addColorStop(0.5, "rgba(9,12,18,.68)");
    scrim.addColorStop(1, "rgba(9,12,18,.88)");
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = SITE.bg;
    ctx.fillRect(0, 0, W, H);
    const mood = MOODS[spec.mood] || MOODS.boardroom;
    for (const [bx, by, br, tok, a] of mood.blooms) radial(ctx, W * bx, H * by, W * br, SITE[tok] || SITE.mint, a);
    for (const [bx, bw, tok, a] of mood.beams || []) {
      const g = ctx.createLinearGradient(W * (bx - bw / 2), 0, W * (bx + bw / 2), 0);
      g.addColorStop(0, hexA(SITE[tok] || SITE.cyan, 0));
      g.addColorStop(0.5, hexA(SITE[tok] || SITE.cyan, a));
      g.addColorStop(1, hexA(SITE[tok] || SITE.cyan, 0));
      ctx.fillStyle = g;
      ctx.fillRect(W * (bx - bw / 2), 0, W * bw, H);
    }
    if (mood.pattern && PATTERNS[mood.pattern]) {
      ctx.save();
      PATTERNS[mood.pattern](ctx, W, H, S);
      ctx.restore();
    }
    // one diagonal catch-light across the whole card
    ctx.save();
    ctx.translate(W * 0.64, -H * 0.1);
    ctx.rotate(0.42);
    const ray = ctx.createLinearGradient(0, 0, 340 * S, 0);
    ray.addColorStop(0, "rgba(150,245,225,0)");
    ray.addColorStop(0.5, "rgba(150,245,225,.05)");
    ray.addColorStop(1, "rgba(150,245,225,0)");
    ctx.fillStyle = ray;
    ctx.fillRect(0, 0, 340 * S, H * 1.6);
    ctx.restore();
  }
  // fine dot grid — trading-terminal texture, kept whisper-quiet
  ctx.save();
  ctx.fillStyle = "rgba(150,195,200,.05)";
  const step = 38 * S;
  for (let gy = step; gy < H; gy += step) {
    for (let gx = step; gx < W; gx += step) {
      ctx.beginPath();
      ctx.arc(gx, gy, Math.max(0.8, S), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
  // vignette so the corners fall away
  const vg = ctx.createRadialGradient(W / 2, H * 0.44, H * 0.5, W / 2, H / 2, H * 1.12);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,.46)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
  // inner hairline frame with a mint→cyan sweep — the poster's edge
  roundRect(ctx, 20 * S, 20 * S, W - 40 * S, H - 40 * S, 30 * S);
  const fr = ctx.createLinearGradient(0, 0, W, H);
  fr.addColorStop(0, hexA(SITE.mint, 0.3));
  fr.addColorStop(0.5, "rgba(255,255,255,.05)");
  fr.addColorStop(1, hexA(SITE.cyan, 0.26));
  ctx.lineWidth = Math.max(1, 1.5 * S);
  ctx.strokeStyle = fr;
  ctx.stroke();
  // mint→cyan keyline across the very top
  const kl = ctx.createLinearGradient(0, 0, W, 0);
  kl.addColorStop(0, "rgba(61,245,159,0)");
  kl.addColorStop(0.2, hexA(SITE.mint, 0.85));
  kl.addColorStop(0.6, hexA(SITE.cyan, 0.85));
  kl.addColorStop(1, "rgba(34,211,238,0)");
  ctx.fillStyle = kl;
  ctx.fillRect(0, 0, W, Math.max(2, 3 * S));
}

/** Brand lockup top-left, live/date chips top-right, then the POSTER title:
 *  centred caps in a metallic white→mint gradient with a single-pass glow —
 *  the bold voice, carried by the type itself. */
function header(ctx, S, spec, { n, dateText }) {
  const W = REF_W * S;
  const x = PAD * S;
  const right = W - PAD * S;

  // brand lockup
  drawBrandMark(ctx, x, 46 * S, 56 * S);
  displayText(ctx, x + 72 * S, 82 * S, "Dexvra", 32 * S, { weight: 700 });
  microLabel(ctx, x + 74 * S, 104 * S, "Discovery", { size: 10.5 * S, color: SITE.mint, track: 0.3 });

  // top-right: LIVE pill + date chip on one row
  let rx = right;
  if (dateText) rx -= chip(ctx, rx, 74 * S, dateText, 12.5 * S, S, { align: "right", color: SITE.muted }) + 14 * S;
  const liveW = chip(ctx, rx, 74 * S, "   Live · 24H", 12.5 * S, S, {
    align: "right",
    color: SITE.mint,
    border: hexA(SITE.mint, 0.35),
    bg: hexA(SITE.mint, 0.08),
  });
  const dotX = rx - liveW + 17 * S;
  radial(ctx, dotX, 71.5 * S, 12 * S, SITE.mint, 0.55);
  ctx.beginPath();
  ctx.arc(dotX, 71.5 * S, 3.4 * S, 0, Math.PI * 2);
  ctx.fillStyle = SITE.mint;
  ctx.fill();

  // centred kicker
  const cx = W / 2;
  microLabel(ctx, cx, 156 * S, "Ranked by 24h change · live from dexvra.io", { size: 12 * S, color: SITE.mint, track: 0.26, align: "center" });

  // centred metallic caps title
  const title = String(spec.title(n) || "").toUpperCase();
  let size = 76 * S;
  const track = () => 5 * S;
  ctx.font = `700 ${size}px ${F.d7}`;
  const runW = () => {
    ctx.font = `700 ${size}px ${F.d7}`;
    return ctx.measureText(title).width + track() * Math.max(0, title.length - 1);
  };
  while (size > 40 * S && runW() > W - 2 * PAD * S - 60 * S) size -= 2 * S;
  const baseline = 236 * S;
  ctx.save();
  ctx.font = `700 ${size}px ${F.d7}`;
  ctx.textBaseline = "alphabetic";
  // depth shadow first, then ONE gradient pass carrying its own glow — the
  // per-glyph glow accumulation of the very first build is what made narrow
  // letters bloom into detached bars.
  ctx.fillStyle = "rgba(0,0,0,.5)";
  trackedCenter(ctx, cx + 2 * S, baseline + 3 * S, title, track());
  const tg = ctx.createLinearGradient(0, baseline - size * 0.86, 0, baseline + size * 0.2);
  tg.addColorStop(0, "#FFFFFF");
  tg.addColorStop(0.55, "#EAF7F4");
  tg.addColorStop(1, SITE.mint);
  ctx.fillStyle = tg;
  ctx.shadowColor = hexA(SITE.mint, 0.5);
  ctx.shadowBlur = 30 * S;
  const tw = trackedCenter(ctx, cx, baseline, title, track());
  ctx.restore();

  // centred underline fading both ways
  const uw = Math.min(tw, W * 0.4);
  const ug = ctx.createLinearGradient(cx - uw / 2, 0, cx + uw / 2, 0);
  ug.addColorStop(0, hexA(spec.accent, 0));
  ug.addColorStop(0.5, hexA(spec.accent, 0.95));
  ug.addColorStop(1, hexA(spec.accent, 0));
  ctx.fillStyle = ug;
  roundRect(ctx, cx - uw / 2, 254 * S, uw, Math.max(2, 3 * S), 2 * S);
  ctx.fill();
}

/** Footer: tagline left, the site's `.btn-primary` gradient CTA right.
 *
 *  The whole strip is laid out around ONE centreline so the left text and the
 *  CTA pill are optically level — and the pill stays INSIDE the inner frame:
 *  it used to run 46px tall from y+16, putting its bottom at 882 on an 880px
 *  frame edge, with an 8px-offset glow smearing across the hairline. */
function footer(ctx, S) {
  const W = REF_W * S;
  const x = PAD * S;
  const y = 820 * S;
  // frame bottom edge sits at H-20 (backdrop); keep everything clear of it
  const frameBottom = (REF_H - 20) * S;
  ctx.fillStyle = SITE.line;
  ctx.fillRect(x, y, W - 2 * PAD * S, 1);

  // one centreline for the whole strip, centred between rule and frame
  const midY = (y + frameBottom) / 2;

  // ONE voice, ONE baseline. The tagline used to be 16px mixed-case display
  // set on a `middle` baseline beside a 12px tracked uppercase microlabel on an
  // `alphabetic` one — a different size, case, face and vertical line in a
  // chrome strip whose whole job is uniformity ("teks find the next moonshot
  // fontnya benerin ukuran dan penyesuaian yang pas", 2026-08-21, off a live
  // rail8). Both halves are the microlabel voice now, split by tone: brand
  // faint, tagline muted — same baseline, same size, same tracking.
  const bw0 = microLabel(ctx, x, midY + 4.5 * S, "Dexvra · Discovery", { size: 12 * S, color: SITE.faint, track: 0.2 });
  microLabel(ctx, x + bw0 + 24 * S, midY + 4.5 * S, "Find the next Moonshot", { size: 12 * S, color: SITE.muted, track: 0.2 });

  // CTA — the site's primary button: mint→cyan gradient, dark ink, top inset
  // light. Sized to clear the frame with visible air on both sides, glow kept
  // tight so it can't bleed over the hairline below.
  const label = "dexvra.io";
  ctx.save();
  ctx.font = `700 ${16 * S}px ${F.d7}`;
  const tw = ctx.measureText(label).width;
  const bh = 40 * S;
  const bw = tw + 48 * S;
  const bx = W - PAD * S - bw;
  const by = midY - bh / 2;
  roundRect(ctx, bx, by, bw, bh, bh / 2);
  const g = ctx.createLinearGradient(bx, by, bx + bw, by + bh);
  g.addColorStop(0, SITE.mint);
  g.addColorStop(1, SITE.cyan);
  ctx.shadowColor = "rgba(61,245,159,.3)";
  ctx.shadowBlur = 14 * S;
  ctx.shadowOffsetY = 3 * S;
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  // inset top light
  ctx.save();
  roundRect(ctx, bx, by, bw, bh, bh / 2);
  ctx.clip();
  ctx.fillStyle = "rgba(255,255,255,.5)";
  ctx.fillRect(bx + bh / 3, by + 1, bw - bh / 1.5, Math.max(1, 1.3 * S));
  ctx.restore();
  ctx.fillStyle = "#03150B";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, bx + bw / 2, by + bh / 2 + 1 * S);
  ctx.restore();
}

// ── board panels (list / rail / grid) ───────────────────────────────────────
/** One board panel: surface + the `.row.head` strip. Returns the rows' geometry
 *  and clips to the panel while `draw` runs, so row washes/accents stay inside
 *  the rounded corners. */
function boardPanel(ctx, S, { x, y, w, h, head, accent }, draw) {
  surface(ctx, x, y, w, h, 22 * S, { S, accent: null });
  const headH = 46 * S;
  ctx.save();
  roundRect(ctx, x, y, w, h, 22 * S);
  ctx.clip();
  // header strip — rgba(255,255,255,.03) with a hairline under it
  ctx.fillStyle = "rgba(255,255,255,.03)";
  ctx.fillRect(x, y, w, headH);
  ctx.fillStyle = SITE.line;
  ctx.fillRect(x, y + headH, w, 1);
  for (const c of head) microLabel(ctx, c.x, y + headH / 2 + 4 * S, c.label, { size: 10.5 * S, track: 0.16, align: c.align || "left" });
  draw({ top: y + headH + 1, height: h - headH - 1 });
  ctx.restore();
  void accent;
}

/** A row's furniture: hairline above (not the first), and the site's row-hover
 *  treatment on the leader — mint wash + 3px left accent bar. */
function rowBase(ctx, S, { x, w, y, h, first, leader, accent }) {
  if (!first) {
    ctx.fillStyle = SITE.line;
    ctx.fillRect(x, y, w, 1);
  }
  if (leader) {
    const g = ctx.createLinearGradient(x, 0, x + w * 0.75, 0);
    g.addColorStop(0, hexA(accent, 0.1));
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x, y + 1, w, h - 1);
    ctx.fillStyle = accent;
    ctx.fillRect(x, y + 1, 3 * S, h - 1);
  }
}

/** list5 — the Dexvra board: one panel, real columns, sparklines. */
function layoutList(ctx, S, spec, coins) {
  const showPct = spec.showPct !== false;
  const x = PAD * S;
  const w = (REF_W - 2 * PAD) * S;
  const n = coins.length;
  // THE GAIN IS DRAWN, not only printed (2026-08-21 rebuild): each row carries
  // a horizontal bar scaled to its 24h move against the day's best, so the
  // board reads as a chart before a single number is read. The bar is HONEST —
  // length ∝ the real pct, never eased — and the widest bar always belongs to
  // rank 1 because gainers.js sorts by the same number.
  const cChg = x + w - 28 * S;
  // With the figure column gone the cap takes the edge, or the table reads as
  // two columns with a hole where a third used to be.
  const cMcap = showPct ? x + w - 268 * S : cChg;
  const barL = x + 620 * S;
  const barR = cMcap - 176 * S;
  const maxPct = Math.max(...coins.map((c) => Math.abs(Number(c.pct) || 0)), 1e-9);
  boardPanel(
    ctx,
    S,
    {
      x,
      y: BAND_TOP * S,
      w,
      h: BAND_H * S,
      accent: spec.accent,
      // With the percentage OFF the "24h gain" bar column and the "24h" figure
      // column are not drawn, so their headings go too — a heading over an
      // empty column is a table with a hole in it, not a table with a column
      // hidden. The bar IS the percentage, drawn as length: keeping it while
      // hiding the number would publish the figure by another route.
      head: [
        { x: x + 52 * S, label: "#", align: "right" },
        { x: x + 78 * S, label: "Token" },
        ...(showPct ? [{ x: (barL + barR) / 2, label: "24h gain", align: "center" }] : []),
        { x: cMcap, label: "Market cap", align: "right" },
        ...(showPct ? [{ x: cChg, label: "24h", align: "right" }] : []),
      ],
    },
    ({ top, height }) => {
      const rowH = height / n;
      coins.forEach((c, i) => {
        const rank = i + 1;
        const y = top + i * rowH;
        const cy = y + rowH / 2;
        rowBase(ctx, S, { x, w, y, h: rowH, first: i === 0, leader: rank === 1, accent: spec.accent });

        if (rank <= 3) medal(ctx, x + 38 * S, cy, 15 * S, rank, S);
        else rankNum(ctx, x + 52 * S, cy, rank, 17 * S);
        const d = Math.min(54 * S, rowH * 0.62);
        avatar(ctx, c.img, x + 78 * S + d / 2, cy, d, c.symbol, S);
        metalRing(ctx, x + 78 * S + d / 2, cy, d, rank, S);

        const tx = x + 78 * S + d + 20 * S;
        const tw = barL - 40 * S - tx;
        ctx.save();
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = SITE.text;
        const sym = fitText(ctx, `$${c.symbol}`, tw - 70 * S, { weight: 700, size: 25 * S, min: 15 * S, family: F.d7 });
        ctx.fillText(sym, tx, cy - 3 * S);
        const symW = ctx.measureText(sym).width;
        ctx.fillStyle = SITE.muted;
        ctx.fillText(fitText(ctx, c.name || "", tw, { weight: 500, size: 14.5 * S, min: 11 * S, family: F.d5 }), tx, cy + 22 * S);
        ctx.restore();
        // chain chip beside the ticker, like the site's tier tag

        // the gain bar: a faint full-length track, the real value over it —
        // drawn only while the percentage is shown (see `head` above).
        if (showPct) {
          const zoneW = barR - barL;
          const bh = 14 * S;
          const up = (Number(c.pct) || 0) >= 0;
          roundRect(ctx, barL, cy - bh / 2, zoneW, bh, bh / 2);
          ctx.fillStyle = "rgba(255,255,255,.05)";
          ctx.fill();
          const frac = Math.max(0.035, Math.min(1, Math.abs(Number(c.pct) || 0) / maxPct));
          const bw = zoneW * frac;
          roundRect(ctx, barL, cy - bh / 2, bw, bh, bh / 2);
          const bg2 = ctx.createLinearGradient(barL, 0, barL + bw, 0);
          bg2.addColorStop(0, up ? SITE.mintDeep : SITE.downTo);
          bg2.addColorStop(1, up ? SITE.upFrom : SITE.downFrom);
          ctx.save();
          ctx.shadowColor = hexA(up ? SITE.mint : SITE.red, 0.35);
          ctx.shadowBlur = 12 * S;
          ctx.fillStyle = bg2;
          ctx.fill();
          ctx.restore();
          // lit end-point, the sparkline's own grammar
          ctx.beginPath();
          ctx.arc(barL + bw, cy, 3.4 * S, 0, Math.PI * 2);
          ctx.fillStyle = "#EAFFF5";
          ctx.fill();
        }

        const mono = (val, cxx, color, size = 19 * S) => {
          ctx.save();
          ctx.font = `700 ${size}px ${F.m7}`;
          ctx.fillStyle = color;
          ctx.textAlign = "right";
          ctx.textBaseline = "middle";
          ctx.fillText(val, cxx, cy + 1 * S);
          ctx.restore();
        };
        mono(c.mcap ? fmtCap(c.mcap) : "—", cMcap, c.mcap ? SITE.text : SITE.faint);
        pctChip(ctx, cChg, cy, c.pctLabel, 20 * S, S, { align: "r" });
      });
    },
  );
}


/** rail8 / grid10 — two board panels side by side, rank order DOWN each panel. */
/** rail8 — a literal film RAIL: two strips of four portrait mini-cards. Every
 *  mover is its own frame — avatar over ticker over figure — which no other
 *  board shape does (the tables are rows, mosaic9's tiles are landscape).
 *  2026-08-21 rebuild; the two-panels-of-four table it replaced was grid10 at
 *  a different row count, which is exactly what "every banner distinct" ends. */
function layoutRail(ctx, S, spec, coins) {
  const n = coins.length;
  if (!n) return;
  if (n === 1) return layoutHero(ctx, S, spec, coins);
  if (n === 2) return layoutDuel(ctx, S, spec, coins);
  if (n === 3) return layoutPodium(ctx, S, spec, coins);
  const cols = 4;
  const rows = Math.ceil(n / cols);
  const gap = 20 * S;
  const innerW = (REF_W - 2 * PAD) * S;
  const cw = (innerW - gap * (cols - 1)) / cols;
  const ch = (BAND_H * S - gap * (rows - 1)) / rows;
  coins.forEach((c, i) => {
    const rank = i + 1;
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const rowW = inRow * cw + (inRow - 1) * gap;
    const x = PAD * S + (innerW - rowW) / 2 + (i % cols) * (cw + gap);
    const y = BAND_TOP * S + row * (ch + gap);
    const cx = x + cw / 2;
    surface(ctx, x, y, cw, ch, 18 * S, { S, accent: rank === 1 ? spec.accent : null });
    if (rank > 3) rankNum(ctx, x + cw - 18 * S, y + 30 * S, rank, 14.5 * S);
    const d = Math.min(62 * S, ch * 0.28);
    const ly = y + 34 * S + d / 2;
    avatar(ctx, c.img, cx, ly, d, c.symbol, S);
    metalRing(ctx, cx, ly, d, rank, S);
    if (rank <= 3) medal(ctx, cx + d * 0.42, ly + d * 0.38, 12.5 * S, rank, S);
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = SITE.text;
    ctx.fillText(fitText(ctx, `$${c.symbol}`, cw - 44 * S, { weight: 700, size: 20 * S, min: 12.5 * S, family: F.d7 }), cx, ly + d / 2 + 30 * S);
    ctx.fillStyle = SITE.muted;
    ctx.fillText(fitText(ctx, c.name || "", cw - 48 * S, { weight: 500, size: 11.5 * S, min: 9.5 * S, family: F.d5 }), cx, ly + d / 2 + 50 * S);
    ctx.restore();
    bigPct(ctx, cx, y + ch - 52 * S, c.pctLabel, 27 * S, S, { align: "center" });
    microLabel(ctx, cx, y + ch - 22 * S, `${c.mcap ? `MC ${fmtCap(c.mcap)}` : c.price ? fmtPrice(c.price) : ""}`, { size: 9.5 * S, track: 0.14, color: SITE.muted, align: "center" });
  });
}

/** grid10 — the dense TERMINAL readout: one full-width board, ten single-line
 *  rows. Every other board sets the name under the ticker; this one runs the
 *  whole identity on one baseline, which is what makes ten rows fit a single
 *  panel — and makes the shape unmistakably its own. */
function layoutGridDense(ctx, S, spec, coins) {
  const n = coins.length;
  if (!n) return;
  const x = PAD * S;
  const w = (REF_W - 2 * PAD) * S;
  const cChg = x + w - 26 * S;
  const cMcap = spec.showPct !== false ? x + w - 170 * S : cChg;
  boardPanel(
    ctx,
    S,
    {
      x,
      y: BAND_TOP * S,
      w,
      h: BAND_H * S,
      accent: spec.accent,
      head: [
        { x: x + 50 * S, label: "#", align: "right" },
        { x: x + 74 * S, label: "Token" },
        { x: cMcap, label: "MCap", align: "right" },
        // no heading over a column that is not drawn (see layoutList)
        ...(spec.showPct !== false ? [{ x: cChg, label: "24h", align: "right" }] : []),
      ],
    },
    ({ top, height }) => {
      const rowH = height / n;
      coins.forEach((c, i) => {
        const rank = i + 1;
        const y = top + i * rowH;
        const cy = y + rowH / 2;
        rowBase(ctx, S, { x, w, y, h: rowH, first: i === 0, leader: rank === 1, accent: spec.accent });
        if (rank <= 3) medal(ctx, x + 36 * S, cy, 11.5 * S, rank, S);
        else rankNum(ctx, x + 50 * S, cy, rank, 14 * S);
        const d = Math.min(30 * S, rowH * 0.68);
        avatar(ctx, c.img, x + 74 * S + d / 2, cy, d, c.symbol, S);
        metalRing(ctx, x + 74 * S + d / 2, cy, d, rank, S);
        // ONE BASELINE: ticker, then the name inline after it, then the chain
        // chip — the row's whole identity on a single line.
        const tx = x + 74 * S + d + 14 * S;
        const tw = cMcap - 90 * S - tx;
        ctx.save();
        ctx.textBaseline = "middle";
        ctx.fillStyle = SITE.text;
        const sym = fitText(ctx, `$${c.symbol}`, tw * 0.5, { weight: 700, size: 17.5 * S, min: 12 * S, family: F.d7 });
        ctx.fillText(sym, tx, cy + 1 * S);
        const symW = ctx.measureText(sym).width;
        ctx.fillStyle = SITE.faint;
        const nm = fitText(ctx, c.name || "", tw - symW - 30 * S, { weight: 500, size: 12.5 * S, min: 9.5 * S, family: F.d5 });
        ctx.fillText(nm, tx + symW + 12 * S, cy + 1.5 * S);
        ctx.restore();
        if (c.mcap) {
          ctx.save();
          ctx.font = `700 ${14 * S}px ${F.m7}`;
          ctx.fillStyle = SITE.muted;
          ctx.textAlign = "right";
          ctx.textBaseline = "middle";
          ctx.fillText(fmtCap(c.mcap), cMcap, cy + 1 * S);
          ctx.restore();
        }
        pctChip(ctx, cChg, cy, c.pctLabel, 13.5 * S, S, { align: "r" });
      });
    },
  );
}


/** One board panel of ranked rows at ARBITRARY geometry — the shared engine
 *  under tier6's lower tier and crown7's two boards. layoutColumns owns the
 *  full-band table shapes; this owns a panel that shares its banner with other
 *  components. Same row grammar as every other board, so the mixed layouts and
 *  the pure tables read as one system. `rank0` is the first row's rank. */
function rankedPanel(ctx, S, spec, coins, { x, y, w, h, rank0, cap = 128 }) {
  if (!coins.length) return;
  const cChg = x + w - 22 * S;
  const cMcap = spec.showPct !== false ? x + w - 158 * S : cChg;
  boardPanel(
    ctx,
    S,
    {
      x, y, w, h,
      accent: spec.accent,
      head: [
        { x: x + 46 * S, label: "#", align: "right" },
        { x: x + 70 * S, label: "Token" },
        { x: cMcap, label: "MCap", align: "right" },
        // no heading over a column that is not drawn (see layoutList)
        ...(spec.showPct !== false ? [{ x: cChg, label: "24h", align: "right" }] : []),
      ],
    },
    ({ top, height }) => {
      const rowH = Math.min(height / coins.length, cap * S);
      const y0 = top + (height - rowH * coins.length) / 2;
      coins.forEach((c, i) => {
        const rank = rank0 + i;
        const ry = y0 + i * rowH;
        const cy = ry + rowH / 2;
        rowBase(ctx, S, { x, w, y: ry, h: rowH, first: i === 0, leader: false, accent: spec.accent });
        if (rank <= 3) medal(ctx, x + 34 * S, cy, 12.5 * S, rank, S);
        else rankNum(ctx, x + 46 * S, cy, rank, 14.5 * S);
        const d = Math.min(40 * S, rowH * 0.62);
        avatar(ctx, c.img, x + 70 * S + d / 2, cy, d, c.symbol, S);
        metalRing(ctx, x + 70 * S + d / 2, cy, d, rank, S);
        const tx = x + 70 * S + d + 14 * S;
        const tw = cMcap - 84 * S - tx;
        ctx.save();
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = SITE.text;
        const symTxt = fitText(ctx, `$${c.symbol}`, tw - 54 * S, { weight: 700, size: 18.5 * S, min: 12 * S, family: F.d7 });
        ctx.fillText(symTxt, tx, cy - 3 * S);
        const symW = ctx.measureText(symTxt).width;
        ctx.fillStyle = SITE.muted;
        ctx.fillText(fitText(ctx, c.name || "", tw, { weight: 500, size: 11.5 * S, min: 9.5 * S, family: F.d5 }), tx, cy + 15.5 * S);
        ctx.restore();
        if (c.mcap) {
          ctx.save();
          ctx.font = `700 ${14.5 * S}px ${F.m7}`;
          ctx.fillStyle = SITE.muted;
          ctx.textAlign = "right";
          ctx.textBaseline = "middle";
          ctx.fillText(fmtCap(c.mcap), cMcap, cy + 1 * S);
          ctx.restore();
        }
        pctChip(ctx, cChg, cy, c.pctLabel, 14.5 * S, S, { align: "r" });
      });
    },
  );
}

/** tier6 — two tiers: the podium as three crowned mini-cards above, ranks 4–6
 *  as one board beneath. The podium tier keeps the podium's grammar (metal
 *  ring, medal, rank chip, the figure as the card's headline); the lower tier
 *  is the board grammar — the point of the composition is that the two read
 *  as prize-winners OVER a leaderboard, not as six equal cells. */
function layoutTiers(ctx, S, spec, coins) {
  const n = coins.length;
  if (!n) return;
  if (n === 1) return layoutHero(ctx, S, spec, coins);
  if (n === 2) return layoutDuel(ctx, S, spec, coins);
  if (n === 3) return layoutPodium(ctx, S, spec, coins);

  const gap = 24 * S;
  const innerW = (REF_W - 2 * PAD) * S;
  const topH = BAND_H * S * 0.56;
  const botY = BAND_TOP * S + topH + gap;
  const botH = BAND_BOTTOM * S - botY;

  const podium = coins.slice(0, 3);
  const cardW = (innerW - gap * 2) / 3;
  podium.forEach((c, i) => {
    const rank = i + 1;
    const rc = rankColor(rank);
    const winner = rank === 1;
    const x = PAD * S + i * (cardW + gap);
    const y = BAND_TOP * S;
    surface(ctx, x, y, cardW, topH, 22 * S, { S, accent: rc, lift: winner ? 1.4 : 1 });
    const d = (winner ? 76 : 68) * S;
    const lx = x + 34 * S + d / 2;
    const ly = y + 36 * S + d / 2;
    if (winner) radial(ctx, lx, ly, d * 1.3, SITE.gold, 0.12);
    avatar(ctx, c.img, lx, ly, d, c.symbol, S);
    metalRing(ctx, lx, ly, d, rank, S);
    medal(ctx, lx + d * 0.42, ly + d * 0.38, 15 * S, rank, S);
    chip(ctx, x + cardW - 26 * S, y + 44 * S, `#${rank}`, 12 * S, S, { align: "right", color: rc, border: hexA(rc, 0.4), bg: hexA(rc, 0.1) });
    // identity right of the avatar — ONE ticker size across the three cards
    const tx = lx + d / 2 + 18 * S;
    const tw = x + cardW - 30 * S - tx;
    ctx.save();
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = SITE.text;
    ctx.fillText(fitText(ctx, `$${c.symbol}`, tw, { weight: 700, size: 24 * S, min: 14 * S, family: F.d7 }), tx, ly - 2 * S);
    ctx.fillStyle = SITE.muted;
    ctx.fillText(fitText(ctx, c.name || "", tw, { weight: 500, size: 13 * S, min: 10 * S, family: F.d5 }), tx, ly + 22 * S);
    ctx.restore();
    // the figure is the card's headline; the winner's outranks the sides
    bigPct(ctx, x + 34 * S, y + topH - 64 * S, c.pctLabel, (winner ? 44 : 34) * S, S);
    ctx.save();
    roundRect(ctx, x, y, cardW, topH, 22 * S);
    ctx.clip();
    sparkline(ctx, x + cardW - 176 * S, y + topH - 96 * S, 148 * S, 40 * S, c.symbol, c.pct, S, { alpha: 0.8 });
    ctx.restore();
    microLabel(ctx, x + 34 * S, y + topH - 26 * S, `${c.mcap ? `MC ${fmtCap(c.mcap)}` : c.price ? fmtPrice(c.price) : ""}`, { size: 10.5 * S, track: 0.14, color: SITE.muted });
  });

  rankedPanel(ctx, S, spec, coins.slice(3), { x: PAD * S, y: botY, w: innerW, h: botH, rank0: 4, cap: 96 });
}

/** crown7 — the champion as a full-width BAND across the top (the hero card
 *  turned landscape), ranks 2–7 as two boards of three beneath. The band is
 *  what makes it read "the winner on top of everyone" rather than "a big row". */
function layoutCrown(ctx, S, spec, coins) {
  const n = coins.length;
  if (!n) return;
  if (n === 1) return layoutHero(ctx, S, spec, coins);
  if (n === 2) return layoutDuel(ctx, S, spec, coins);
  if (n === 3) return layoutPodium(ctx, S, spec, coins);

  const gap = 24 * S;
  const innerW = (REF_W - 2 * PAD) * S;
  const bandH = 178 * S;
  const x = PAD * S;
  const y = BAND_TOP * S;

  const c1 = coins[0];
  const rc = rankColor(1);
  surface(ctx, x, y, innerW, bandH, 24 * S, { S, accent: rc, lift: 1.4 });
  const d = 108 * S;
  const lx = x + 44 * S + d / 2;
  const ly = y + bandH / 2;
  radial(ctx, lx, ly, d * 1.3, SITE.gold, 0.12);
  avatar(ctx, c1.img, lx, ly, d, c1.symbol, S);
  metalRing(ctx, lx, ly, d, 1, S);
  medal(ctx, lx + d * 0.42, ly + d * 0.38, 18 * S, 1, S);
  const tx = lx + d / 2 + 26 * S;
  const figW = 320 * S;
  const tw = x + innerW - figW - 60 * S - tx;
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = SITE.text;
  ctx.font = `700 ${34 * S}px ${F.d7}`;
  ctx.letterSpacing = `${(-0.68 * S).toFixed(1)}px`;
  ctx.fillText(fitText(ctx, `$${c1.symbol}`, tw - 120 * S, { weight: 700, size: 34 * S, min: 18 * S, family: F.d7 }), tx, ly - 6 * S);
  const symW = ctx.measureText(fitText(ctx, `$${c1.symbol}`, tw - 120 * S, { weight: 700, size: 34 * S, min: 18 * S, family: F.d7 })).width;
  ctx.letterSpacing = "0px";
  ctx.fillStyle = SITE.muted;
  ctx.fillText(fitText(ctx, c1.name || "", tw, { weight: 500, size: 15 * S, min: 11 * S, family: F.d5 }), tx, ly + 22 * S);
  ctx.restore();
  chip(ctx, tx + symW + 14 * S, ly - 15 * S, "#1 · Top gainer", 11.5 * S, S, { color: rc, border: hexA(rc, 0.4), bg: hexA(rc, 0.1) });
  microLabel(ctx, tx, ly + 48 * S, `${c1.mcap ? `MC ${fmtCap(c1.mcap)}` : c1.price ? fmtPrice(c1.price) : ""}`, { size: 10.5 * S, track: 0.14, color: SITE.muted });
  // the figure owns the band's right end, its trend sweeping under it
  ctx.save();
  roundRect(ctx, x, y, innerW, bandH, 24 * S);
  ctx.clip();
  sparkline(ctx, x + innerW - figW - 30 * S, y + bandH - 62 * S, figW, 44 * S, c1.symbol, c1.pct, S, { alpha: 0.65 });
  ctx.restore();
  bigPct(ctx, x + innerW - 44 * S, ly + 18 * S, c1.pctLabel, 62 * S, S, { align: "right" });

  // two boards of three under the band
  const rest = coins.slice(1);
  const py = y + bandH + gap;
  const ph = BAND_BOTTOM * S - py;
  const half = Math.ceil(rest.length / 2);
  const pw = (innerW - gap) / 2;
  rankedPanel(ctx, S, spec, rest.slice(0, half), { x, y: py, w: pw, h: ph, rank0: 2, cap: 110 });
  if (rest.length > half) rankedPanel(ctx, S, spec, rest.slice(half), { x: x + pw + gap, y: py, w: pw, h: ph, rank0: 2 + half, cap: 110 });
}

/** mosaic9 — nine compact tiles, 3×3: every mover as its own small card. The
 *  tile is the cards4 card COMPRESSED — identity row, the move as the only
 *  figure, no sparkline (no height for one to read cleanly; grid10's rule). */
function layoutMosaic(ctx, S, spec, coins) {
  const n = coins.length;
  if (!n) return;
  if (n === 1) return layoutHero(ctx, S, spec, coins);
  if (n === 2) return layoutDuel(ctx, S, spec, coins);
  if (n === 3) return layoutPodium(ctx, S, spec, coins);

  const cols = 3;
  const rows = Math.ceil(n / cols);
  const gap = 20 * S;
  const innerW = (REF_W - 2 * PAD) * S;
  const tileW = (innerW - gap * (cols - 1)) / cols;
  const tileH = (BAND_H * S - gap * (rows - 1)) / rows;
  // A last row shorter than the grid is CENTRED, so seven or eight coins read
  // as a finished mosaic rather than a broken one.
  coins.forEach((c, i) => {
    const rank = i + 1;
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const rowW = inRow * tileW + (inRow - 1) * gap;
    const x = PAD * S + (innerW - rowW) / 2 + (i % cols) * (tileW + gap);
    const y = BAND_TOP * S + row * (tileH + gap);
    surface(ctx, x, y, tileW, tileH, 18 * S, { S, accent: rank === 1 ? spec.accent : null });
    const d = Math.min(52 * S, tileH * 0.42);
    const lx = x + 24 * S + d / 2;
    const ly = y + tileH * 0.36;
    avatar(ctx, c.img, lx, ly, d, c.symbol, S);
    metalRing(ctx, lx, ly, d, rank, S);
    if (rank <= 3) medal(ctx, lx + d * 0.42, ly + d * 0.38, 12 * S, rank, S);
    else rankNum(ctx, x + tileW - 24 * S, y + 34 * S, rank, 15 * S);
    const tx = lx + d / 2 + 14 * S;
    const tw = x + tileW - 26 * S - tx;
    ctx.save();
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = SITE.text;
    const symTxt = fitText(ctx, `$${c.symbol}`, tw - 52 * S, { weight: 700, size: 21 * S, min: 13 * S, family: F.d7 });
    ctx.fillText(symTxt, tx, ly - 1 * S);
    const symW = ctx.measureText(symTxt).width;
    ctx.fillStyle = SITE.muted;
    ctx.fillText(fitText(ctx, c.name || "", tw, { weight: 500, size: 12 * S, min: 9.5 * S, family: F.d5 }), tx, ly + 19 * S);
    ctx.restore();
    bigPct(ctx, x + 24 * S, y + tileH - 26 * S, c.pctLabel, 30 * S, S);
    if (c.mcap) {
      ctx.save();
      ctx.font = `700 ${13 * S}px ${F.m7}`;
      ctx.fillStyle = SITE.muted;
      ctx.textAlign = "right";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(fmtCap(c.mcap), x + tileW - 24 * S, y + tileH - 26 * S);
      ctx.restore();
    }
  });
}

/** spot10 — the premium Top-10: the champion as a full hero card on the left
 *  (the podium/duel card grammar — gold ring, radial seat, the move as the
 *  headline figure, sparkline strip, hairline-split stats), and ranks 2–10 as
 *  ONE board panel beside it. grid10 answers "show me all ten"; this answers
 *  "crown the winner AND show me all ten" — the composition every exchange's
 *  weekly-winners poster uses, and the reason it reads premium rather than
 *  tabular.
 *
 *  IDENTITY RULE, scoped the way the podium scoped it: every ROW ticker is one
 *  size, because the nine rows are one component at one width. The hero's
 *  bigger name is not a ranking signal inside that set — it is a different
 *  component class four rows tall, the same relationship list5's title has to
 *  its rows. What must stay equal is equals; the hero is not an equal.
 */
function layoutSpotlight(ctx, S, spec, coins) {
  const n = coins.length;
  if (!n) return;
  // A thin day renders on the layout DESIGNED for that count, not on this one
  // drawn mostly empty: one coin is the hero card, two are the duel, three are
  // the podium. A champion card beside a board carrying a single floating row
  // reads as a rendering fault, not a short day — and the ladder already owns
  // the right shape for each of those counts. Spotlight proper starts at four.
  if (n === 1) return layoutHero(ctx, S, spec, coins);
  if (n === 2) return layoutDuel(ctx, S, spec, coins);
  if (n === 3) return layoutPodium(ctx, S, spec, coins);

  const gapX = 28 * S;
  const innerW = (REF_W - 2 * PAD) * S;
  const heroW = innerW * 0.36;
  const panelW = innerW - heroW - gapX;
  const hx = PAD * S;
  const hy = BAND_TOP * S;
  const hh = BAND_H * S;

  // ── the champion ──
  const c1 = coins[0];
  const rc = rankColor(1);
  surface(ctx, hx, hy, heroW, hh, 24 * S, { S, accent: rc, lift: 1.5 });
  const hcx = hx + heroW / 2;
  chip(ctx, hcx, hy + 42 * S, "#1 · Top gainer", 12.5 * S, S, {
    align: "center", color: rc, border: hexA(rc, 0.4), bg: hexA(rc, 0.1),
  });
  const d = 118 * S;
  const lcy = hy + hh * 0.285;
  radial(ctx, hcx, lcy, d * 1.35, SITE.gold, 0.13);
  avatar(ctx, c1.img, hcx, lcy, d, c1.symbol, S);
  metalRing(ctx, hcx, lcy, d, 1, S);
  medal(ctx, hcx + d * 0.42, lcy + d * 0.38, 21 * S, 1, S);

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = SITE.text;
  const tickerY = lcy + d / 2 + 46 * S;
  ctx.font = `700 ${32 * S}px ${F.d7}`;
  ctx.letterSpacing = `${(-0.64 * S).toFixed(1)}px`;
  ctx.fillText(fitText(ctx, `$${c1.symbol}`, heroW - 56 * S, { weight: 700, size: 32 * S, min: 18 * S, family: F.d7 }), hcx, tickerY);
  ctx.letterSpacing = "0px";
  ctx.fillStyle = SITE.muted;
  ctx.fillText(fitText(ctx, c1.name || "", heroW - 60 * S, { weight: 500, size: 15.5 * S, min: 11 * S, family: F.d5 }), hcx, tickerY + 27 * S);
  ctx.restore();

  // the hero figure — positioned off the name (the podium's collision lesson)
  bigPct(ctx, hcx, tickerY + 27 * S + 88 * S, c1.pctLabel, 62 * S, S, { align: "center" });

  // trend strip in its own clipped band above the stats
  ctx.save();
  roundRect(ctx, hx, hy, heroW, hh, 24 * S);
  ctx.clip();
  sparkline(ctx, hcx - (heroW - 120 * S) / 2, hy + hh - 84 * S - 54 * S, heroW - 120 * S, 40 * S, c1.symbol, c1.pct, S, { alpha: 0.8 });
  ctx.restore();

  // footer stats split by a hairline — the podium/duel grammar
  ctx.fillStyle = SITE.line;
  ctx.fillRect(hx + 30 * S, hy + hh - 84 * S, heroW - 60 * S, 1);
  const stat = (label, value, sx, align) => {
    microLabel(ctx, sx, hy + hh - 54 * S, label, { size: 10 * S, track: 0.2, align, color: SITE.faint });
    ctx.save();
    ctx.font = `700 ${17 * S}px ${F.m7}`;
    ctx.fillStyle = SITE.text;
    ctx.textAlign = align === "right" ? "right" : "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(value, sx, hy + hh - 26 * S);
    ctx.restore();
  };
  if (c1.price) stat("Price", fmtPrice(c1.price), hx + 30 * S, "left");
  if (c1.mcap) stat("Mkt cap", fmtCap(c1.mcap), hx + heroW - 30 * S, "right");

  // ── the chasing pack, ranks 2..n, one board panel ──
  const rest = coins.slice(1);
  const px = hx + heroW + gapX;
  const cChg = px + panelW - 22 * S;
  const cMcap = spec.showPct !== false ? px + panelW - 158 * S : cChg;
  boardPanel(
    ctx,
    S,
    {
      x: px,
      y: hy,
      w: panelW,
      h: hh,
      accent: spec.accent,
      head: [
        { x: px + 46 * S, label: "#", align: "right" },
        { x: px + 70 * S, label: "Token" },
        { x: cMcap, label: "MCap", align: "right" },
        // no heading over a column that is not drawn (see layoutList)
        ...(spec.showPct !== false ? [{ x: cChg, label: "24h", align: "right" }] : []),
      ],
    },
    ({ top, height }) => {
      // Nine rows is this panel's design case; fewer must not stretch into
      // billboards. Cap the row and centre the run — the leaderboard just ends.
      // (128 only ever bites at three rows: the n≤3 counts were delegated above,
      // and from five rows up height/rows is already below it.)
      const rowH = Math.min(height / rest.length, 128 * S);
      const y0 = top + (height - rowH * rest.length) / 2;
      rest.forEach((c, i) => {
        const rank = i + 2;
        const y = y0 + i * rowH;
        const cy = y + rowH / 2;
        rowBase(ctx, S, { x: px, w: panelW, y, h: rowH, first: i === 0, leader: false, accent: spec.accent });

        if (rank <= 3) medal(ctx, px + 34 * S, cy, 12.5 * S, rank, S);
        else rankNum(ctx, px + 46 * S, cy, rank, 14.5 * S);
        const d2 = Math.min(40 * S, rowH * 0.62);
        avatar(ctx, c.img, px + 70 * S + d2 / 2, cy, d2, c.symbol, S);
        metalRing(ctx, px + 70 * S + d2 / 2, cy, d2, rank, S);

        // Same information architecture as the other boards — ticker + chain
        // chip, name muted underneath — so the panels read as one system.
        const tx = px + 70 * S + d2 + 14 * S;
        const tw = cMcap - 84 * S - tx;
        ctx.save();
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = SITE.text;
        const symTxt = fitText(ctx, `$${c.symbol}`, tw - 54 * S, { weight: 700, size: 18.5 * S, min: 12 * S, family: F.d7 });
        ctx.fillText(symTxt, tx, cy - 3 * S);
        const symW = ctx.measureText(symTxt).width;
        ctx.fillStyle = SITE.muted;
        ctx.fillText(fitText(ctx, c.name || "", tw, { weight: 500, size: 11.5 * S, min: 9.5 * S, family: F.d5 }), tx, cy + 15.5 * S);
        ctx.restore();

        if (c.mcap) {
          ctx.save();
          ctx.font = `700 ${14.5 * S}px ${F.m7}`;
          ctx.fillStyle = SITE.muted;
          ctx.textAlign = "right";
          ctx.textBaseline = "middle";
          ctx.fillText(fmtCap(c.mcap), cMcap, cy + 1 * S);
          ctx.restore();
        }
        pctChip(ctx, cChg, cy, c.pctLabel, 14.5 * S, S, { align: "r" });
      });
    },
  );
}

/** cards4 — four product cards; each card's headline is the MOVE, with the
 *  site's sparkline under it and an editorial faint rank numeral. */
function layoutCards(ctx, S, spec, coins) {
  // PORTRAIT, one row (2026-08-21 rebuild) — four trading-cards standing side
  // by side, each a centred column: avatar, identity, the move, the trend, the
  // facts. The 2×2 landscape grid it replaces sat too close to the board
  // shapes; a row of standing cards shares a silhouette with nothing else in
  // the ladder.
  const n = coins.length;
  const cols = Math.min(4, Math.max(1, n));
  const gap = 24 * S;
  const innerW = (REF_W - 2 * PAD) * S;
  const cw = (innerW - gap * (cols - 1)) / cols;
  const ch = BAND_H * S;
  const rowW = cols * cw + (cols - 1) * gap;
  coins.slice(0, 4).forEach((c, i) => {
    const rank = i + 1;
    const x = PAD * S + (innerW - rowW) / 2 + i * (cw + gap);
    const y = BAND_TOP * S;
    const cx = x + cw / 2;
    surface(ctx, x, y, cw, ch, 22 * S, { S, accent: rank === 1 ? spec.accent : null });

    // Medallion top-corner — the bold system's rank voice (the ghost numerals
    // belonged to the flat pass and read as low-opacity smears here).
    medal(ctx, x + cw - 42 * S, y + 44 * S, 17 * S, rank, S);

    const d = 86 * S;
    const ly = y + 62 * S + d / 2;
    if (rank === 1) radial(ctx, cx, ly, d * 1.2, spec.accent, 0.12);
    avatar(ctx, c.img, cx, ly, d, c.symbol, S);
    metalRing(ctx, cx, ly, d, rank, S);

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = SITE.text;
    ctx.fillText(fitText(ctx, `$${c.symbol}`, cw - 48 * S, { weight: 700, size: 25 * S, min: 15 * S, family: F.d7 }), cx, ly + d / 2 + 40 * S);
    ctx.fillStyle = SITE.muted;
    ctx.fillText(fitText(ctx, c.name || "", cw - 52 * S, { weight: 500, size: 13.5 * S, min: 10.5 * S, family: F.d5 }), cx, ly + d / 2 + 64 * S);
    ctx.restore();

    // the move — the card's headline — with the trend beneath it
    bigPct(ctx, cx, y + ch - 138 * S, c.pctLabel, 40 * S, S, { align: "center" });
    ctx.save();
    roundRect(ctx, x, y, cw, ch, 22 * S);
    ctx.clip();
    sparkline(ctx, x + 34 * S, y + ch - 118 * S, cw - 68 * S, 40 * S, c.symbol, c.pct, S, { alpha: 0.8 });
    ctx.restore();

    // footer facts under a hairline
    ctx.fillStyle = SITE.line;
    ctx.fillRect(x + 26 * S, y + ch - 62 * S, cw - 52 * S, 1);
    // muted, not faint: this line carries DATA, and at social-feed scale the
    // faint tone fell below comfortable legibility.
    microLabel(ctx, cx, y + ch - 30 * S, `${c.price ? `${fmtPrice(c.price)}  ·  ` : ""}${c.mcap ? `MC ${fmtCap(c.mcap)}` : ""}`, {
      size: 11 * S,
      track: 0.14,
      color: SITE.muted,
      align: "center",
    });
  });
}


/** podium — three tall cards, winner raised; the % is each card's hero figure,
 *  a low-alpha trend area breathes across the card's lower half. */
function layoutPodium(ctx, S, spec, coins) {
  const n = coins.length;
  const order = n >= 3 ? [1, 0, 2] : n === 2 ? [1, 0] : [0];
  const slots = order.filter((i) => coins[i]);
  const gapX = 24 * S;
  const colW = ((REF_W - 2 * PAD) * S - gapX * (slots.length - 1)) / slots.length;
  const bottom = BAND_BOTTOM * S;

  slots.forEach((idx, col) => {
    const c = coins[idx];
    const rank = idx + 1;
    const rc = rankColor(rank);
    const winner = rank === 1;
    // The cards STAND ON PLINTHS now (2026-08-21 rebuild) — a literal stepped
    // pedestal under each, tallest for gold, so the silhouette is a podium
    // before a single glyph is read. Elevation is still the first rank signal:
    // the winner's card is taller AND stands higher.
    const plinthH = (rank === 1 ? 64 : rank === 2 ? 46 : 32) * S;
    const h = (winner ? BAND_H : BAND_H - 40) * S - 70 * S;
    const x = PAD * S + col * (colW + gapX);
    const y = bottom - plinthH - h;
    const cx = x + colW / 2;

    // plinth first, so the card's shadow falls onto it. FULL card width — the
    // inset version read as a button under the card, not a pedestal under a
    // statue (found by looking at the render).
    const m = medalOf(rank);
    roundRect(ctx, x, bottom - plinthH, colW, plinthH, 10 * S);
    ctx.fillStyle = "rgba(13,17,25,.92)";
    ctx.fill();
    roundRect(ctx, x, bottom - plinthH, colW, plinthH, 10 * S);
    ctx.lineWidth = Math.max(1, 1.2 * S);
    ctx.strokeStyle = hexA(rc, 0.45);
    ctx.stroke();
    ctx.save();
    roundRect(ctx, x, bottom - plinthH, colW, plinthH, 10 * S);
    ctx.clip();
    ctx.fillStyle = hexA(rc, 0.55);
    ctx.fillRect(x, bottom - plinthH, colW, Math.max(1.5, 2 * S));
    // faint metal wash so the pedestal carries its rank's temperature
    const pg = ctx.createLinearGradient(x, bottom - plinthH, x, bottom);
    pg.addColorStop(0, hexA(rc, 0.1));
    pg.addColorStop(1, hexA(rc, 0.02));
    ctx.fillStyle = pg;
    ctx.fillRect(x, bottom - plinthH, colW, plinthH);
    ctx.font = `800 ${Math.round(plinthH * 0.64)}px ${F.m8}`;
    ctx.fillStyle = metalGrad(ctx, cx, bottom - plinthH / 2, plinthH / 2, m);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(rank), cx, bottom - plinthH / 2 + 1 * S);
    ctx.restore();
    if (rank === 1) sparkle(ctx, cx + 46 * S, bottom - plinthH + 14 * S, 7 * S, m.light);

    surface(ctx, x, y, colW, h, 24 * S, { S, accent: rc, lift: winner ? 1.5 : 1 });

    chip(ctx, cx, y + 42 * S, winner ? "#1 · Top gainer" : `#${rank}`, 12.5 * S, S, {
      align: "center",
      color: rc,
      border: hexA(rc, 0.4),
      bg: hexA(rc, 0.1),
    });

    const d = (winner ? 108 : 96) * S;
    const lcy = y + h * 0.3;
    if (winner) radial(ctx, cx, lcy, d * 1.35, SITE.mint, 0.14);
    avatar(ctx, c.img, cx, lcy, d, c.symbol, S);
    metalRing(ctx, cx, lcy, d, rank, S);
    medal(ctx, cx + d * 0.42, lcy + d * 0.38, (winner ? 21 : 18) * S, rank, S);

    // Winner's FIGURE must outrank the sides (≥1.4×), or the three metric blocks
    // read as equals and the podium is carried only by elevation.
    //
    // THE TICKER IS NOT PART OF THAT. It used to scale with the figure — 44
    // against 31 — and a project asked why its name was drawn smaller than the
    // one above it. Fair: all three columns are the SAME WIDTH (colW is one
    // value), only the height differs, so a bigger name buys no legibility and
    // costs the card set its typographic consistency. Rank is already carried by
    // the elevation, the "#1 · Top gainer" chip, the gold ring, the medal, the
    // larger avatar and the figure itself — six signals. The name is an IDENTITY,
    // and three identities at three sizes just reads as three different designs.
    const tickSize = 31;
    const pctSize = winner ? 68 : 44;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = SITE.text;
    ctx.font = `700 ${tickSize * S}px ${F.d7}`;
    ctx.letterSpacing = `${(-0.02 * tickSize * S).toFixed(1)}px`;
    const tickerY = lcy + d / 2 + 42 * S;
    ctx.fillText(fitText(ctx, `$${c.symbol}`, colW - 56 * S, { weight: 700, size: tickSize * S, min: 18 * S, family: F.d7 }), cx, tickerY);
    ctx.letterSpacing = "0px";
    ctx.fillStyle = SITE.muted;
    ctx.fillText(fitText(ctx, c.name || "", colW - 60 * S, { weight: 500, size: 16 * S, min: 11 * S, family: F.d5 }), cx, tickerY + 28 * S);
    ctx.restore();

    // the trend as an UNDERLAY, first, so the figure prints over it. The cards
    // are 70px shorter since the plinths took that height, and the old discrete
    // strip no longer has a band of its own — drawn at strip weight it sliced
    // straight through the figure on the side cards (found by LOOKING at the
    // render, the drawGem rule). At 0.3 alpha across the lower half it reads as
    // the card's texture, exactly like the hero's midfield curve.
    ctx.save();
    roundRect(ctx, x, y, colW, h, 24 * S);
    ctx.clip();
    sparkline(ctx, x + 24 * S, y + h - 84 * S - 64 * S, colW - 48 * S, 52 * S, c.symbol, c.pct, S, { alpha: 0.3 });
    ctx.restore();

    // the hero figure — positioned OFF the name, so no fixed fraction can ever
    // collide with the identity block above it. No "24H CHANGE" label here: the
    // header kicker already says it, and a label was what collided last time.
    bigPct(ctx, cx, tickerY + 28 * S + (winner ? 88 : 70) * S, c.pctLabel, pctSize * S, S, { align: "center" });

    // footer stats split by a hairline
    ctx.fillStyle = SITE.line;
    ctx.fillRect(x + 30 * S, y + h - 84 * S, colW - 60 * S, 1);
    const stat = (label, value, sx, align) => {
      microLabel(ctx, sx, y + h - 54 * S, label, { size: 10 * S, track: 0.2, align, color: SITE.faint });
      ctx.save();
      ctx.font = `700 ${17 * S}px ${F.m7}`;
      ctx.fillStyle = SITE.muted;
      ctx.textAlign = align === "right" ? "right" : "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(value, sx, y + h - 26 * S);
      ctx.restore();
    };
    if (c.price) stat("Price", fmtPrice(c.price), x + 30 * S, "left");
    if (c.mcap) stat("Mkt cap", fmtCap(c.mcap), x + colW - 30 * S, "right");
  });
}

/** hero1 — the biggest mover as a product-launch card: kicker, giant figures,
 *  stat tiles, a big trend area, and an editorial "01" watermark. */
/** duel — two wide cards head-to-head; the winner carries the gold ring and a
 *  slightly taller card, the runner-up silver. Both tickers are ONE size: the
 *  podium's lesson — a name is an identity, not a ranking signal — applies
 *  before a third card exists to prove it on. The figure is what scales. */
function layoutDuel(ctx, S, spec, coins) {
  const slots = coins.slice(0, 2);
  if (!slots.length) return;
  const gapX = 28 * S;
  const innerW = (REF_W - 2 * PAD) * S;
  // ASYMMETRIC on purpose (2026-08-21 rebuild): equal halves read as a diptych,
  // not a duel. The winner takes ~57% of the width, and a VS medallion sits on
  // the seam — drawn after both cards so it rides above their shadows.
  const wWide = slots.length > 1 ? innerW * 0.57 : innerW;
  const widths = slots.length > 1 ? [wWide, innerW - wWide - gapX] : [innerW];
  const bottom = BAND_BOTTOM * S;

  slots.forEach((c, idx) => {
    const rank = idx + 1;
    const rc = rankColor(rank);
    const winner = rank === 1;
    const colW = widths[idx];
    const h = winner ? BAND_H * S : (BAND_H - 34) * S;
    const x = PAD * S + (idx === 0 ? 0 : widths[0] + gapX);
    const y = bottom - h;
    surface(ctx, x, y, colW, h, 24 * S, { S, accent: rc, lift: winner ? 1.5 : 1 });
    // rank-coloured keyline along the card's top edge — the site's tier accent,
    // and the crispest way the two cards state gold-vs-silver at a glance
    ctx.save();
    roundRect(ctx, x, y, colW, h, 24 * S);
    ctx.clip();
    const kl = ctx.createLinearGradient(x, 0, x + colW, 0);
    kl.addColorStop(0, hexA(rc, 0));
    kl.addColorStop(0.5, hexA(rc, 0.75));
    kl.addColorStop(1, hexA(rc, 0));
    ctx.fillStyle = kl;
    ctx.fillRect(x, y, colW, Math.max(2, 2.4 * S));
    ctx.restore();

    // identity row: avatar LEFT, name beside it — a two-column card is wide
    // enough to read horizontally, and stacking (the podium's shape) would
    // leave its midfield hollow at this width.
    const d = (winner ? 108 : 100) * S;
    const lx = x + 54 * S + d / 2;
    const ly = y + 64 * S + d / 2;
    if (winner) radial(ctx, lx, ly, d * 1.3, SITE.gold, 0.12);
    avatar(ctx, c.img, lx, ly, d, c.symbol, S);
    metalRing(ctx, lx, ly, d, rank, S);
    medal(ctx, lx + d * 0.42, ly + d * 0.38, (winner ? 20 : 18) * S, rank, S);

    chip(ctx, x + colW - 40 * S, y + 44 * S, winner ? "#1 · Top gainer" : "#2 · Runner-up", 12.5 * S, S, {
      align: "right",
      color: rc,
      border: hexA(rc, 0.4),
      bg: hexA(rc, 0.1),
    });

    const tx = lx + d / 2 + 30 * S;
    const textW = x + colW - 44 * S - tx;
    ctx.save();
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = SITE.text;
    ctx.font = `700 ${34 * S}px ${F.d7}`;
    ctx.letterSpacing = `${(-0.7 * S).toFixed(1)}px`;
    ctx.fillText(fitText(ctx, `$${c.symbol}`, textW, { weight: 700, size: 34 * S, min: 18 * S, family: F.d7 }), tx, ly - 2 * S);
    ctx.letterSpacing = "0px";
    ctx.fillStyle = SITE.muted;
    ctx.fillText(fitText(ctx, c.name || "", textW, { weight: 500, size: 16 * S, min: 11 * S, family: F.d5 }), tx, ly + 26 * S);
    ctx.restore();

    // the hero figure — winner's outranks the runner-up's ≥1.4×, same contract
    // as the podium, or two equal cards are just a list drawn expensively.
    bigPct(ctx, x + 54 * S, y + h - 168 * S, c.pctLabel, (winner ? 84 : 56) * S, S);

    // trend strip in its own clipped band above the footer
    ctx.save();
    roundRect(ctx, x, y, colW, h, 24 * S);
    ctx.clip();
    sparkline(ctx, x + 54 * S, y + h - 148 * S, colW - 108 * S, 44 * S, c.symbol, c.pct, S, { alpha: 0.75 });
    ctx.restore();

    // footer stats split by a hairline — same grammar as the podium's
    ctx.fillStyle = SITE.line;
    ctx.fillRect(x + 30 * S, y + h - 84 * S, colW - 60 * S, 1);
    const stat = (label, value, sx, align) => {
      microLabel(ctx, sx, y + h - 54 * S, label, { size: 10 * S, track: 0.2, align, color: SITE.faint });
      ctx.save();
      ctx.font = `700 ${17 * S}px ${F.m7}`;
      ctx.fillStyle = SITE.text;
      ctx.textAlign = align;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(value, sx, y + h - 28 * S);
      ctx.restore();
    };
    if (c.price) stat("Price", fmtPrice(c.price), x + 30 * S, "left");
    if (c.mcap) stat("Mkt cap", fmtCap(c.mcap), x + colW - 30 * S, "right");
  });

  // the VS medallion on the seam — only when there IS a duel
  if (slots.length > 1) {
    const sx = PAD * S + widths[0] + gapX / 2;
    const sy = bottom - BAND_H * S * 0.56;
    const r = 33 * S;
    ctx.save();
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#080F16";
    ctx.shadowColor = "rgba(0,0,0,.6)";
    ctx.shadowBlur = 18 * S;
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    const rg = ctx.createLinearGradient(sx - r, sy, sx + r, sy);
    rg.addColorStop(0, SITE.gold);
    rg.addColorStop(1, rankColor(2));
    ctx.lineWidth = Math.max(2.5, 5 * S);
    ctx.strokeStyle = rg;
    ctx.stroke();
    ctx.font = `800 ${24 * S}px ${F.m8}`;
    ctx.fillStyle = SITE.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("VS", sx, sy + 1 * S);
    ctx.restore();
  }
}

function layoutHero(ctx, S, spec, coins) {
  const c = coins[0];
  if (!c) return;
  const x = PAD * S;
  const w = (REF_W - 2 * PAD) * S;
  const y = BAND_TOP * S;
  const h = BAND_H * S;
  const cx = x + w / 2;
  surface(ctx, x, y, w, h, 26 * S, { S, accent: SITE.gold, lift: 1.5 });

  // THE MONUMENT — symmetric about the centreline. The first composition was
  // an editorial split (text stack left, avatar at 0.70w, "01" watermark) and
  // the 2026-08-21 pass rebuilt every layout to be tellable apart at a glance;
  // a lone champion reads strongest as a shrine, not a magazine spread. The
  // ghost numerals flank the monument, and the trend breathes across the
  // card's lower half UNDER the stat tiles.
  ctx.save();
  roundRect(ctx, x, y, w, h, 26 * S);
  ctx.clip();
  ctx.font = `800 ${252 * S}px ${F.m8}`;
  ctx.fillStyle = "rgba(255,255,255,.035)";
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText("0", x + 36 * S, y + 262 * S);
  ctx.textAlign = "right";
  ctx.fillText("1", x + w - 36 * S, y + 262 * S);
  sparkline(ctx, x + 60 * S, y + h * 0.5, w - 120 * S, h * 0.4, c.symbol, c.pct, S, { alpha: 0.28 });
  ctx.restore();

  chip(ctx, cx, y + 44 * S, "#1 · Top gainer", 13 * S, S, {
    align: "center",
    color: SITE.gold,
    border: hexA(SITE.gold, 0.4),
    bg: hexA(SITE.gold, 0.12),
  });

  const d = 134 * S;
  const lcy = y + 64 * S + d / 2;
  radial(ctx, cx, lcy, d * 1.2, SITE.gold, 0.15);
  avatar(ctx, c.img, cx, lcy, d, c.symbol, S);
  metalRing(ctx, cx, lcy, d, 1, S);
  medal(ctx, cx + d * 0.42, lcy + d * 0.38, 22 * S, 1, S);

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = SITE.text;
  ctx.font = `700 ${58 * S}px ${F.d7}`;
  ctx.letterSpacing = `${(-1.2 * S).toFixed(1)}px`;
  ctx.fillText(fitText(ctx, `$${c.symbol}`, w - 320 * S, { weight: 700, size: 58 * S, min: 26 * S, family: F.d7 }), cx, lcy + d / 2 + 58 * S);
  ctx.letterSpacing = "0px";
  ctx.fillStyle = SITE.muted;
  ctx.fillText(fitText(ctx, c.name || "", w - 360 * S, { weight: 500, size: 19 * S, min: 12 * S, family: F.d5 }), cx, lcy + d / 2 + 90 * S);
  ctx.restore();

  bigPct(ctx, cx, y + 384 * S, c.pctLabel, 102 * S, S, { align: "center" });

  // stat tiles — a centred row, same tile grammar as before
  const tiles = [
    ...(c.price ? [{ l: "Price", v: fmtPrice(c.price) }] : []),
    ...(c.mcap ? [{ l: "Market cap", v: fmtCap(c.mcap) }] : []),
  ].slice(0, 3);
  const tileW = 206 * S;
  const tileH = 84 * S;
  const rowW = tiles.length * tileW + (tiles.length - 1) * 16 * S;
  tiles.forEach((t, i) => {
    const tx = cx - rowW / 2 + i * (tileW + 16 * S);
    const ty = y + h - 40 * S - tileH;
    roundRect(ctx, tx, ty, tileW, tileH, 14 * S);
    // Opaque surface: a trend line showing through a stat chip reads as noise
    // inside the data, not depth.
    ctx.fillStyle = "rgba(13,17,25,.92)";
    ctx.fill();
    roundRect(ctx, tx, ty, tileW, tileH, 14 * S);
    ctx.fillStyle = "rgba(255,255,255,.04)";
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1.1 * S);
    ctx.strokeStyle = SITE.line;
    ctx.stroke();
    microLabel(ctx, tx + 18 * S, ty + 29 * S, t.l, { size: 10.5 * S, track: 0.2 });
    ctx.save();
    ctx.font = `700 ${20 * S}px ${F.m7}`;
    ctx.fillStyle = SITE.text;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(fitText(ctx, t.v, tileW - 36 * S, { weight: 700, size: 20 * S, min: 13 * S, family: F.m7 }), tx + 18 * S, ty + 60 * S);
    ctx.restore();
  });
}


const LAYOUTS = {
  duel: layoutDuel,
  hero: layoutHero,
  spotlight: layoutSpotlight,
  tiers: layoutTiers,
  crown: layoutCrown,
  mosaic: layoutMosaic,
  podium: layoutPodium,
  cards: layoutCards,
  list: layoutList,
  rail: layoutRail,
  grid: layoutGridDense,
};

// ── render ──────────────────────────────────────────────────────────────────
/** Decode a coin's logo bytes once (async), attaching `img`. Never throws. */
async function decodeLogos(cv, coins) {
  await Promise.all(
    coins.map(async (c) => {
      if (!c.logo) return;
      try {
        c.img = await cv.loadImage(c.logo);
      } catch {
        c.img = null; // undecodable → the site's jewel monogram
      }
    }),
  );
  return coins;
}

/** Optional admin background artwork. A missing/broken file is ignored — the
 *  procedural backdrop is always available underneath. */
async function loadBackground(cv, bgPath) {
  if (!bgPath) return null;
  try {
    if (!fss.existsSync(bgPath)) return null;
    return await cv.loadImage(fss.readFileSync(bgPath));
  } catch (e) {
    log.debug(`[gainers] background ${bgPath}: ${e.message}`);
    return null;
  }
}

/**
 * Render a gainers banner.
 *
 * @param {object} o
 * @param {string} o.template   template id (see TEMPLATE_IDS)
 * @param {Array}  o.coins      gainers.js coins (each may carry a `logo` Buffer)
 * @param {string} o.dateText   date line, or "" to hide it
 * @param {boolean} o.showPct   false → no percentage figure anywhere on the artwork
 * @param {string} o.bgPath     optional admin-uploaded background artwork
 * @param {number} o.scale      output scale (1 = 1600×900)
 * @returns {Promise<Buffer|null>} PNG/JPEG buffer, or null on ANY failure
 */
async function render({ template = DEFAULT_TEMPLATE, coins = [], dateText = "", showPct = true, bgPath = "", scale = 1 } = {}) {
  const cv = canvasLib();
  if (!cv) return null;
  // A COPY, carrying the switch: the shipped spec objects are shared by every
  // render, and two posts rendering concurrently with different settings
  // must not see each other's flag. Every layout and every board helper
  // already receives `spec`, so this is the one place the toggle is decided.
  const spec = { ...specOf(template), showPct: showPct !== false };
  const list = (coins || []).filter(Boolean).slice(0, spec.n);
  if (!list.length) return null; // nothing real to show → the caller posts nothing
  try {
    const S = Math.max(0.5, Math.min(2, Number(scale) || 1));
    const W = Math.round(REF_W * S);
    const H = Math.round(REF_H * S);
    const canvas = cv.createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";

    // One formatter for the % on the artwork AND in the caption (helpers/format),
    // so a banner can never print a different number than the text beside it.
    //
    // And ONE owner of whether it is drawn at all: every layout reads the
    // figure off `c.pctLabel`, and bigPct/pctChip draw nothing for "", so the
    // admin's toggle is decided here once rather than in seventeen call sites —
    // a layout added later cannot forget it. The sparklines stay: they are
    // normalised to their own span and carry direction only, never the number.
    for (const c of list) c.pctLabel = spec.showPct ? fmtPct(c.pct) : "";
    await decodeLogos(cv, list);
    const bg = await loadBackground(cv, bgPath);

    backdrop(cv, ctx, S, spec, bg);
    header(ctx, S, spec, { n: list.length, dateText });
    (LAYOUTS[spec.layout] || layoutList)(ctx, S, spec, list);
    footer(ctx, S);

    return toSendBuffer(canvas);
  } catch (e) {
    log.warn(`[gainers] ${template} render failed: ${e.message}`);
    return null;
  }
}

module.exports = {
  TEMPLATES,
  TEMPLATE_IDS,
  DEFAULT_TEMPLATE,
  REF_W,
  REF_H,
  templateList,
  specOf,
  countOf,
  labelOf,
  isTemplate,
  pickTemplate,
  render,
  available: () => !!canvasLib(),
  // exposed for tests / the preview script
  _internals: { LAYOUTS, syntheticTrend, bannerTrend, jewelFor, monogramOf },
};
