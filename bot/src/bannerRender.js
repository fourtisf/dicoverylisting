// Dynamic per-token banners (like fourtis' listing card, but Dexvra-branded):
// the token's logo + $SYMBOL + name + glass metric cards (chain / price / mcap)
// + real social icons, composited onto a premium aurora background — rendered
// with @napi-rs/canvas (prebuilt, no Chromium at runtime). Returns a PNG Buffer.
// Never throws (caller falls back to a static banner, then the token logo).
const { toSendBuffer } = require("./helpers/encodeImage");
const log = require("./helpers/logger");
// Canvas plumbing, the brand palette and the shared primitives (gem, glow,
// rounded rect, brand sweep, podium metals) live in helpers/canvasKit.js so this
// module and the Top-Gainers banners cannot drift apart visually.
const {
  canvasLib,
  warnBoxes,
  F,
  MINT,
  CYAN,
  DEEP,
  INK,
  SOFT,
  MUTE,
  FAINT,
  MEDAL,
  medalOf,
  hexA,
  radial,
  roundRect,
  brandGrad,
  metalGrad,
  drawGem,
  sparkle,
} = require("./helpers/canvasKit");

const W = 1200,
  H = 628;

// ── Social icons (drawn, not text) ───────────────────────────────────────────
const ICON = {
  x: "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z",
  telegram:
    "M23.91 3.79L20.3 20.84c-.25 1.21-.98 1.5-2 .94l-5.5-4.07-2.66 2.57c-.3.3-.55.56-1.1.56-.72 0-.6-.27-.84-.95L6.3 13.7l-5.45-1.7c-1.18-.36-1.19-1.16.26-1.75l21.26-8.2c.97-.36 1.9.23 1.53 1.73z",
};
function drawIconPath(cv, ctx, key, x, y, size, color) {
  const p = new cv.Path2D(ICON[key]);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = color;
  ctx.fill(p);
  ctx.restore();
}
function drawGlobe(ctx, x, y, size, color) {
  const r = size / 2;
  const cx = x + r,
    cy = y + r;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, size * 0.07);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(cx, cy, r * 0.48, r, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx - r * 0.86, cy - r * 0.5);
  ctx.lineTo(cx + r * 0.86, cy - r * 0.5);
  ctx.moveTo(cx - r * 0.86, cy + r * 0.5);
  ctx.lineTo(cx + r * 0.86, cy + r * 0.5);
  ctx.stroke();
  ctx.restore();
}
/** A rounded glass chip with a centered icon + label. Returns advance (x step). */
function socialChip(cv, ctx, x, y, kind, label) {
  const h = 52;
  ctx.font = `600 19px ${F.s}`;
  const tw = ctx.measureText(label).width;
  const w = 30 + 22 + 10 + tw + 22;
  roundRect(ctx, x, y, w, h, h / 2);
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, "rgba(255,255,255,.08)");
  g.addColorStop(1, "rgba(255,255,255,.03)");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = "rgba(120,220,210,.26)";
  ctx.stroke();
  const is = 22;
  const ix = x + 22;
  const iy = y + (h - is) / 2;
  if (kind === "website") drawGlobe(ctx, ix, iy, is, "#DCEDE9");
  else drawIconPath(cv, ctx, kind === "twitter" ? "x" : "telegram", ix, iy, is, "#DCEDE9");
  ctx.fillStyle = SOFT;
  ctx.textBaseline = "middle";
  ctx.fillText(label, ix + is + 12, y + h / 2 + 1);
  ctx.textBaseline = "alphabetic";
  return w + 14;
}

// ── Status pill (top-right) ──────────────────────────────────────────────────
function statusPill(ctx, rightX, y, label, color) {
  ctx.font = `700 20px ${F.b}`;
  ctx.letterSpacing = "1px";
  const tw = ctx.measureText(label).width;
  ctx.letterSpacing = "0px";
  const dot = 10,
    padL = 20,
    padR = 24,
    gap = 13,
    h = 44;
  const w = padL + dot + gap + tw + padR;
  const x = rightX - w;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = hexA(color, 0.12);
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = hexA(color, 0.5);
  ctx.stroke();
  radial(ctx, x + padL + dot / 2, y + h / 2, 15, color, 0.55);
  ctx.beginPath();
  ctx.arc(x + padL + dot / 2, y + h / 2, dot / 2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.letterSpacing = "1px";
  ctx.fillText(label, x + padL + dot + gap, y + h / 2 + 1);
  ctx.letterSpacing = "0px";
  ctx.textBaseline = "alphabetic";
}

// ── Glass metric card ────────────────────────────────────────────────────────
function metricCard(ctx, x, y, w, h, label, value, accent) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.35)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 8;
  roundRect(ctx, x, y, w, h, 18);
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, "rgba(255,255,255,.09)");
  g.addColorStop(1, "rgba(255,255,255,.028)");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = "rgba(255,255,255,.12)";
  roundRect(ctx, x, y, w, h, 18);
  ctx.stroke();
  // top accent glow bar
  ctx.save();
  roundRect(ctx, x, y, w, h, 18);
  ctx.clip();
  const bar = ctx.createLinearGradient(x, y, x + w, y);
  bar.addColorStop(0, hexA(accent, 0));
  bar.addColorStop(0.5, hexA(accent, 0.9));
  bar.addColorStop(1, hexA(accent, 0));
  ctx.fillStyle = bar;
  ctx.fillRect(x, y, w, 3);
  ctx.restore();
  // label
  ctx.fillStyle = MUTE;
  ctx.font = `700 13px ${F.b}`;
  ctx.letterSpacing = "1.5px";
  ctx.fillText(label, x + 20, y + 32);
  ctx.letterSpacing = "0px";
  // value — shrink to fit (keeps full prices/caps readable) before truncating
  ctx.fillStyle = INK;
  const v = String(value);
  const maxW = w - 38;
  let vs = 26;
  ctx.font = `700 ${vs}px ${F.b}`;
  while (ctx.measureText(v).width > maxW && vs > 17) {
    vs -= 1;
    ctx.font = `700 ${vs}px ${F.b}`;
  }
  let out = v;
  while (ctx.measureText(out).width > maxW && out.length > 4) out = out.slice(0, -2);
  if (out !== v) out += "…";
  ctx.fillText(out, x + 20, y + 68);
}

// ── Token logo (right hero) with glow ring + verified badge ───────────────────
async function drawLogo(cv, ctx, buf, cx, cy, R, sym) {
  radial(ctx, cx, cy, R + 130, CYAN, 0.2);
  // gradient ring
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R + 15, 0, Math.PI * 2);
  ctx.lineWidth = 9;
  ctx.strokeStyle = brandGrad(ctx, cx - R, cy - R, cx + R, cy + R);
  ctx.shadowColor = hexA(CYAN, 0.5);
  ctx.shadowBlur = 26;
  ctx.stroke();
  ctx.restore();
  // decorative dashed arc
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R + 34, -Math.PI * 0.18, Math.PI * 0.5);
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.setLineDash([2, 15]);
  ctx.strokeStyle = hexA(MINT, 0.65);
  ctx.stroke();
  ctx.restore();
  // clipped logo
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = "#0B141C";
  ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
  let drawn = false;
  if (buf) {
    try {
      const img = await cv.loadImage(buf);
      const s = Math.max((2 * R) / img.width, (2 * R) / img.height);
      const w = img.width * s,
        h = img.height * s;
      ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
      drawn = true;
    } catch {
      /* placeholder below */
    }
  }
  if (!drawn) {
    ctx.fillStyle = brandGrad(ctx, cx - R, cy - R, cx + R, cy + R);
    ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    ctx.fillStyle = "#08121A";
    ctx.font = `800 ${Math.round(R * 0.82)}px ${F.x}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(sym || "$").replace(/^\$/, "").slice(0, 2).toUpperCase(), cx, cy + 4);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }
  ctx.restore();
  // inner rim highlight
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,.16)";
  ctx.stroke();
  // verified badge (bottom-right)
  const bx = cx + R * 0.72,
    by = cy + R * 0.72,
    br = 26;
  ctx.beginPath();
  ctx.arc(bx, by, br, 0, Math.PI * 2);
  ctx.fillStyle = "#0A1219";
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = brandGrad(ctx, bx - br, by - br, bx + br, by + br);
  ctx.stroke();
  ctx.strokeStyle = MINT;
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(bx - 9, by);
  ctx.lineTo(bx - 2, by + 8);
  ctx.lineTo(bx + 11, by - 8);
  ctx.stroke();
}

// ── Background ───────────────────────────────────────────────────────────────
function drawBackground(ctx) {
  const bg = ctx.createLinearGradient(0, 0, W * 0.6, H);
  bg.addColorStop(0, "#0B141D");
  bg.addColorStop(0.55, "#080F16");
  bg.addColorStop(1, "#05090E");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  // aurora blobs
  radial(ctx, 60, 10, 640, MINT, 0.14);
  radial(ctx, W - 40, H + 60, 680, CYAN, 0.17);
  radial(ctx, W - 250, 130, 440, DEEP, 0.1);
  // diagonal light ray
  ctx.save();
  ctx.translate(W * 0.62, -40);
  ctx.rotate(0.5);
  const ray = ctx.createLinearGradient(0, 0, 260, 0);
  ray.addColorStop(0, "rgba(120,240,220,0)");
  ray.addColorStop(0.5, "rgba(120,240,220,.05)");
  ray.addColorStop(1, "rgba(120,240,220,0)");
  ctx.fillStyle = ray;
  ctx.fillRect(0, 0, 260, 900);
  ctx.restore();
  // fine dot grid (very subtle)
  ctx.save();
  ctx.fillStyle = "rgba(150,195,200,.045)";
  for (let y = 52; y < H; y += 36) {
    for (let x = 52; x < W; x += 36) {
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
  // vignette
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.34, W / 2, H / 2, H);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,.5)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
  // inner frame with gradient hairline
  roundRect(ctx, 18, 18, W - 36, H - 36, 32);
  const fr = ctx.createLinearGradient(0, 0, W, H);
  fr.addColorStop(0, "rgba(120,240,210,.28)");
  fr.addColorStop(0.5, "rgba(120,240,210,.06)");
  fr.addColorStop(1, "rgba(80,200,230,.24)");
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = fr;
  ctx.stroke();
}

function brandBar(ctx, X0) {
  drawGem(ctx, X0, 38, 44);
  ctx.fillStyle = INK;
  ctx.font = `800 30px ${F.x}`;
  ctx.letterSpacing = "2px";
  ctx.fillText("DEXVRA", X0 + 58, 72);
  ctx.letterSpacing = "0px";
  ctx.fillStyle = FAINT;
  ctx.font = `600 14px ${F.s}`;
  ctx.letterSpacing = "2px";
  ctx.fillText("LISTING · TRENDING · ADS", X0 + 59, 94);
  ctx.letterSpacing = "0px";
}

async function render(coin, logoBuffer, opts) {
  const cv = canvasLib();
  if (!cv) return null;
  warnBoxes(opts && opts.pill === "TRENDING NOW" ? "trending" : "listing", coin);
  try {
    const canvas = cv.createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.textBaseline = "alphabetic";
    drawBackground(ctx);
    const X0 = 66;

    brandBar(ctx, X0);
    statusPill(ctx, W - 66, 42, opts.pill, opts.accent);

    // $SYMBOL
    const sym = "$" + String(coin.symbol || "").replace(/^\$+/, "").toUpperCase().slice(0, 12);
    let symSize = 104;
    ctx.font = `800 ${symSize}px ${F.x}`;
    while (ctx.measureText(sym).width > 620 && symSize > 52) {
      symSize -= 4;
      ctx.font = `800 ${symSize}px ${F.x}`;
    }
    const symY = 236;
    ctx.save();
    ctx.shadowColor = hexA(opts.accent, 0.4);
    ctx.shadowBlur = 30;
    ctx.fillStyle = brandGrad(ctx, X0, symY - symSize, X0 + 560, symY);
    ctx.fillText(sym, X0, symY);
    ctx.restore();
    // accent underline
    const symW = Math.min(ctx.measureText(sym).width, 560);
    const ug = ctx.createLinearGradient(X0, 0, X0 + symW, 0);
    ug.addColorStop(0, hexA(opts.accent, 0.95));
    ug.addColorStop(1, hexA(opts.accent, 0));
    ctx.fillStyle = ug;
    roundRect(ctx, X0, symY + 16, Math.max(120, symW * 0.6), 5, 2.5);
    ctx.fill();

    // name
    ctx.fillStyle = SOFT;
    ctx.font = `500 36px ${F.m}`;
    ctx.fillText(String(coin.name || "").slice(0, 28), X0, symY + 66);

    // metric cards
    const cards = [{ l: "CHAIN", v: coin.chain || "—" }];
    if (coin.price) cards.push({ l: "PRICE", v: coin.price });
    if (coin.mcap) cards.push({ l: "MARKET CAP", v: coin.mcap });
    const cyc = symY + 100;
    const cw = 216,
      ch = 92,
      gap = 18;
    cards.slice(0, 3).forEach((c, i) => metricCard(ctx, X0 + i * (cw + gap), cyc, cw, ch, c.l, c.v, opts.accent));

    // social chips
    const links = coin.links || {};
    const socials = [
      ["website", links.website, "Website"],
      ["twitter", links.twitter, "X"],
      ["telegram", links.telegram, "Telegram"],
    ].filter(([, v]) => v);
    let sx = X0;
    const sy = cyc + ch + 26;
    for (const [kind, , label] of socials) sx += socialChip(cv, ctx, sx, sy, kind, label);

    // footer
    ctx.fillStyle = MINT;
    ctx.font = `700 22px ${F.b}`;
    const fW = ctx.measureText("dexvra.io").width;
    ctx.fillText("dexvra.io", X0, H - 40);
    ctx.fillStyle = FAINT;
    ctx.font = `500 20px ${F.m}`;
    ctx.fillText("—  Buy & track on Dexvra", X0 + fW + 16, H - 40);

    // token logo (right hero)
    await drawLogo(cv, ctx, logoBuffer, 980, 292, 152, coin.symbol);

    return toSendBuffer(canvas);
  } catch (e) {
    log.warn(`[banner] render failed: ${e.message}`);
    return null;
  }
}

const renderListingBanner = (coin, logo) => render(coin, logo, { pill: "NEW LISTING", accent: MINT });
const renderTrendingBanner = (coin, logo) => render(coin, logo, { pill: "TRENDING NOW", accent: CYAN });

// ── Rank-up ("trending up") banner ───────────────────────────────────────────
// A DELIBERATELY different composition from the listing/trending cards so a
// "climbed to #N" alert doesn't look like every other post: a rising area chart
// sweeps the whole width, the hero is the GAIN (big green ▲ +N%), and the token
// logo carries a rank medallion. Dynamic rank + % is why this is procedural
// (the static-artwork compositor can only paste a logo + fixed text).
// RISE (gain green) and the podium metals live in helpers/canvasKit.js — the
// gainers leaderboard uses the same green and the same gold/silver/bronze.
const { RISE } = require("./helpers/canvasKit");

/** Smooth rising chart (bezier) with faint gridlines + a glowing pulse tip. */
function drawRisingChart(ctx, accent) {
  const base = H - 150;
  const pts = [
    [40, base - 4],
    [200, base - 44],
    [360, base - 26],
    [520, base - 84],
    [690, base - 62],
    [860, base - 134],
    [1030, base - 158],
    [1180, base - 224],
  ];
  // faint vertical gridlines (trading-chart texture)
  ctx.save();
  ctx.strokeStyle = "rgba(150,195,200,.05)";
  ctx.lineWidth = 1;
  for (let x = 120; x < W; x += 150) {
    ctx.beginPath();
    ctx.moveTo(x, base - 236);
    ctx.lineTo(x, H - 20);
    ctx.stroke();
  }
  ctx.restore();
  // build a smooth path through the points (midpoint quadratic smoothing)
  const path = new Path2DLine(ctx, pts);
  ctx.save();
  // area fill under the smooth line
  ctx.beginPath();
  ctx.moveTo(pts[0][0], H);
  path.trace();
  ctx.lineTo(pts[pts.length - 1][0], H);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, base - 230, 0, H);
  fill.addColorStop(0, hexA(accent, 0.24));
  fill.addColorStop(1, hexA(accent, 0));
  ctx.fillStyle = fill;
  ctx.fill();
  // gradient stroke (mint→cyan) for a jewel-line feel
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  path.trace();
  const stroke = ctx.createLinearGradient(0, 0, W, 0);
  stroke.addColorStop(0, hexA(accent, 0.7));
  stroke.addColorStop(0.7, accent);
  stroke.addColorStop(1, CYAN);
  ctx.lineWidth = 6;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = stroke;
  ctx.shadowColor = hexA(accent, 0.5);
  ctx.shadowBlur = 24;
  ctx.stroke();
  ctx.restore();
  // faint node dots at each data point (trading-chart polish)
  ctx.save();
  for (let i = 1; i < pts.length - 1; i++) {
    ctx.beginPath();
    ctx.arc(pts[i][0], pts[i][1], 4, 0, Math.PI * 2);
    ctx.fillStyle = hexA(accent, 0.5);
    ctx.fill();
  }
  ctx.restore();
  // glowing pulse tip
  const tip = pts[pts.length - 1];
  radial(ctx, tip[0], tip[1], 54, accent, 0.55);
  ctx.beginPath();
  ctx.arc(tip[0], tip[1], 18, 0, Math.PI * 2);
  ctx.strokeStyle = hexA(accent, 0.55);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(tip[0], tip[1], 8, 0, Math.PI * 2);
  ctx.fillStyle = "#EAFFF6";
  ctx.shadowColor = accent;
  ctx.shadowBlur = 18;
  ctx.fill();
  ctx.shadowBlur = 0;
}

// tiny helper: trace a smooth polyline via midpoint quadratic curves
class Path2DLine {
  constructor(ctx, pts) {
    this.ctx = ctx;
    this.pts = pts;
  }
  trace() {
    const { ctx, pts } = this;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      if (i === 0) ctx.lineTo(x0, y0);
      ctx.quadraticCurveTo(x0, y0, mx, my);
      if (i === pts.length - 2) ctx.lineTo(x1, y1);
    }
  }
}

/** Frosted glass panel — soft drop shadow, hairline border, top sheen. Groups
 *  the hero copy so it reads as a designed card, not text floating on noise. */
function glassPanel(ctx, x, y, w, h, r, accent) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.5)";
  ctx.shadowBlur = 44;
  ctx.shadowOffsetY = 20;
  roundRect(ctx, x, y, w, h, r);
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, "rgba(24,40,44,.72)");
  g.addColorStop(1, "rgba(10,18,22,.62)");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
  // hairline border with a faint accent→cyan sweep
  roundRect(ctx, x, y, w, h, r);
  const b = ctx.createLinearGradient(x, y, x + w, y + h);
  b.addColorStop(0, hexA(accent, 0.45));
  b.addColorStop(0.5, "rgba(255,255,255,.1)");
  b.addColorStop(1, hexA(CYAN, 0.32));
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = b;
  ctx.stroke();
  // top sheen
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  const s = ctx.createLinearGradient(x, y, x, y + h * 0.42);
  s.addColorStop(0, "rgba(255,255,255,.10)");
  s.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = s;
  ctx.fillRect(x, y, w, h * 0.42);
  ctx.restore();
}

/** Soft radial spotlight (tinted by the podium metal) behind the hero. */
function heroSpotlight(ctx, cx, cy, metal) {
  radial(ctx, cx, cy, 520, metal.glow, 0.14);
  radial(ctx, cx, cy, 300, metal.glow, 0.1);
}

/** A single diagonal gloss band across the whole card — the "glass" catch-light
 *  that reads as premium. Very subtle so it never washes out the content. */
function glossSheen(ctx) {
  ctx.save();
  ctx.translate(W * 0.2, 0);
  ctx.rotate(0.32);
  const g = ctx.createLinearGradient(0, 0, 520, 0);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.5, "rgba(255,255,255,.045)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(-200, -200, 520, H + 600);
  ctx.restore();
}

/** Premium podium medallion — metallic per-rank ring + beveled disc + "#N". */
function rankMedallion(ctx, cx, cy, r, rank) {
  const m = medalOf(rank);
  radial(ctx, cx, cy, r + 70, m.glow, 0.4);
  // gold ray-burst behind the champion
  if (rank === 1) {
    ctx.save();
    ctx.translate(cx, cy);
    for (let i = 0; i < 12; i++) {
      ctx.rotate((Math.PI * 2) / 12);
      const ray = ctx.createLinearGradient(0, -r - 8, 0, -r - 78);
      ray.addColorStop(0, hexA(m.glow, 0.5));
      ray.addColorStop(1, hexA(m.glow, 0));
      ctx.fillStyle = ray;
      ctx.beginPath();
      ctx.moveTo(-10, -r - 8);
      ctx.lineTo(10, -r - 8);
      ctx.lineTo(0, -r - 82);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  // drop shadow / bevel base
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy + 4, r + 8, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,.5)";
  ctx.shadowColor = "rgba(0,0,0,.6)";
  ctx.shadowBlur = 24;
  ctx.fill();
  ctx.restore();
  // metallic outer ring
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = 14;
  ctx.strokeStyle = metalGrad(ctx, cx, cy, r, m);
  ctx.stroke();
  ctx.restore();
  // diamond-stud bezel — tiny bright studs set into the ring (jewellery)
  ctx.save();
  for (let i = 0; i < 32; i++) {
    const a = ((Math.PI * 2) / 32) * i;
    const sx = cx + Math.cos(a) * r;
    const sy = cy + Math.sin(a) * r;
    ctx.beginPath();
    ctx.arc(sx, sy, 2.1, 0, Math.PI * 2);
    ctx.fillStyle = i % 2 ? hexA(m.light, 0.9) : hexA(m.dark, 0.7);
    ctx.fill();
  }
  ctx.restore();
  // dark glass face
  ctx.beginPath();
  ctx.arc(cx, cy, r - 9, 0, Math.PI * 2);
  const face = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.4, r * 0.1, cx, cy, r);
  face.addColorStop(0, "#172833");
  face.addColorStop(1, "#060C12");
  ctx.fillStyle = face;
  ctx.fill();
  // inner rim shadow for depth
  ctx.beginPath();
  ctx.arc(cx, cy, r - 9, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,.5)";
  ctx.stroke();
  // top sheen highlight on the ring
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI * 1.08, Math.PI * 1.62);
  ctx.lineWidth = 14;
  ctx.strokeStyle = "rgba(255,255,255,.55)";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();
  // "RANK" eyebrow + "#N"
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.round(r * 0.3)}px ${F.b}`;
  ctx.letterSpacing = "3px";
  ctx.fillStyle = m.mid;
  ctx.fillText("RANK", cx, cy - r * 0.44);
  ctx.letterSpacing = "0px";
  const num = `#${rank}`;
  ctx.font = `800 ${Math.round(r * 0.96)}px ${F.x}`;
  const ng = ctx.createLinearGradient(cx, cy - r * 0.4, cx, cy + r * 0.6);
  ng.addColorStop(0, "#FFFFFF");
  ng.addColorStop(1, m.light);
  ctx.fillStyle = ng;
  ctx.shadowColor = hexA(m.dark.length ? m.mid : m.mid, 0.6);
  ctx.shadowBlur = 14;
  ctx.fillText(num, cx, cy + r * 0.18);
  ctx.shadowBlur = 0;
  // sparkles for the gold #1
  if (rank === 1) {
    sparkle(ctx, cx + r * 0.72, cy - r * 0.66, 12, m.light);
    sparkle(ctx, cx - r * 0.8, cy + r * 0.2, 8, m.light);
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

async function renderRankUpBanner(coin, logoBuffer, opts = {}) {
  const cv = canvasLib();
  if (!cv) return null;
  warnBoxes("rank-up", coin);
  const rank = Number(opts.rank) || 1;
  const change = Number(opts.change) || 0;
  try {
    const canvas = cv.createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.textBaseline = "alphabetic";
    const metal = medalOf(rank);
    drawBackground(ctx);
    heroSpotlight(ctx, 980, 296, metal); // warm the podium
    drawRisingChart(ctx, RISE);
    glossSheen(ctx); // glass catch-light over everything
    // frosted hero panel grouping the left copy (chart rises out of its edge)
    glassPanel(ctx, 40, 112, 648, 350, 30, RISE);
    const X0 = 92;
    brandBar(ctx, X0 - 26);
    statusPill(ctx, W - 66, 42, "TRENDING UP", RISE);

    // $SYMBOL
    const sym = "$" + String(coin.symbol || "").replace(/^\$+/, "").toUpperCase().slice(0, 12);
    let symSize = 92;
    ctx.font = `800 ${symSize}px ${F.x}`;
    while (ctx.measureText(sym).width > 540 && symSize > 46) {
      symSize -= 4;
      ctx.font = `800 ${symSize}px ${F.x}`;
    }
    const symY = 212;
    ctx.save();
    ctx.shadowColor = hexA(RISE, 0.4);
    ctx.shadowBlur = 30;
    ctx.fillStyle = brandGrad(ctx, X0, symY - symSize, X0 + 520, symY);
    ctx.fillText(sym, X0, symY);
    ctx.restore();
    // name
    ctx.fillStyle = SOFT;
    ctx.font = `500 34px ${F.m}`;
    ctx.fillText(String(coin.name || "").slice(0, 28), X0, symY + 52);

    // HERO: big green gain ▲ +N%
    const pct = `${change >= 0 ? "+" : ""}${change >= 100 ? Math.round(change) : change.toFixed(1)}%`;
    const gy = symY + 190;
    ctx.save();
    ctx.shadowColor = hexA(RISE, 0.45);
    ctx.shadowBlur = 34;
    // up-triangle
    ctx.fillStyle = RISE;
    const t = X0 + 6,
      ts = 58;
    ctx.beginPath();
    ctx.moveTo(t + ts / 2, gy - ts);
    ctx.lineTo(t + ts, gy);
    ctx.lineTo(t, gy);
    ctx.closePath();
    ctx.fill();
    ctx.font = `800 118px ${F.x}`;
    const gg = ctx.createLinearGradient(0, gy - 110, 0, gy + 10);
    gg.addColorStop(0, "#8CF7C8");
    gg.addColorStop(0.55, RISE);
    gg.addColorStop(1, "#12B87A");
    ctx.fillStyle = gg;
    ctx.fillText(pct, t + ts + 26, gy + 6);
    ctx.restore();
    // small "24h" tag sitting above the gain figure, clear of the chart line
    ctx.fillStyle = MUTE;
    ctx.font = `600 24px ${F.s}`;
    ctx.fillText("PAST 24H", t + ts + 30, gy - 96);

    // metric cards (chain / price / mcap)
    const cards = [{ l: "CHAIN", v: coin.chain || "—" }];
    if (coin.price) cards.push({ l: "PRICE", v: coin.price });
    if (coin.mcap) cards.push({ l: "MARKET CAP", v: coin.mcap });
    const cyc = H - 150;
    const cw = 210,
      ch = 88,
      gap = 16;
    cards.slice(0, 3).forEach((c, i) => metricCard(ctx, X0 + i * (cw + gap), cyc, cw, ch, c.l, c.v, RISE));

    // footer
    ctx.fillStyle = RISE;
    ctx.font = `700 22px ${F.b}`;
    const fW = ctx.measureText("dexvra.io").width;
    ctx.fillText("dexvra.io", X0, H - 34);
    ctx.fillStyle = FAINT;
    ctx.font = `500 20px ${F.m}`;
    ctx.fillText("—  Track the movers on Dexvra", X0 + fW + 16, H - 34);

    // token logo hero + rank medallion overlapping its lower-left
    await drawLogo(cv, ctx, logoBuffer, 980, 262, 140, coin.symbol);
    rankMedallion(ctx, 862, 374, 94, rank);

    return toSendBuffer(canvas);
  } catch (e) {
    log.warn(`[banner] rankup render failed: ${e.message}`);
    return null;
  }
}

// ── Static / generic banners (welcome + fallbacks, no specific token) ─────────
function drawEmblem(ctx, cx, cy, R) {
  radial(ctx, cx, cy, R + 140, CYAN, 0.2);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(10,20,28,.5)";
  ctx.fill();
  ctx.lineWidth = 9;
  ctx.strokeStyle = brandGrad(ctx, cx - R, cy - R, cx + R, cy + R);
  ctx.shadowColor = hexA(CYAN, 0.5);
  ctx.shadowBlur = 26;
  ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R + 26, -Math.PI * 0.18, Math.PI * 0.5);
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.setLineDash([2, 15]);
  ctx.strokeStyle = hexA(MINT, 0.65);
  ctx.stroke();
  ctx.restore();
  drawGem(ctx, cx - R * 0.6, cy - R * 0.64, R * 1.2);
}

function renderStatic(opts) {
  const cv = canvasLib();
  if (!cv) return null;
  try {
    const canvas = cv.createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    ctx.textBaseline = "alphabetic";
    drawBackground(ctx);
    const X0 = 66;
    brandBar(ctx, X0);
    if (opts.pill) statusPill(ctx, W - 66, 42, opts.pill, opts.accent);

    ctx.save();
    ctx.shadowColor = hexA(opts.accent, 0.4);
    ctx.shadowBlur = 30;
    ctx.fillStyle = brandGrad(ctx, X0, 150, X0 + 560, 250);
    ctx.font = `800 92px ${F.x}`;
    ctx.fillText(opts.title, X0, 246);
    ctx.restore();
    const tw = Math.min(ctx.measureText(opts.title).width, 560);
    const ug = ctx.createLinearGradient(X0, 0, X0 + tw, 0);
    ug.addColorStop(0, hexA(opts.accent, 0.95));
    ug.addColorStop(1, hexA(opts.accent, 0));
    ctx.fillStyle = ug;
    roundRect(ctx, X0, 264, Math.max(120, tw * 0.6), 5, 2.5);
    ctx.fill();

    ctx.fillStyle = SOFT;
    ctx.font = `500 34px ${F.m}`;
    ctx.fillText(opts.sub, X0, 322);

    ctx.font = `700 20px ${F.b}`;
    let cx = X0;
    for (const label of opts.chips || []) {
      ctx.letterSpacing = "1px";
      const w = ctx.measureText(label).width + 40;
      roundRect(ctx, cx, 366, w, 50, 14);
      ctx.fillStyle = "rgba(255,255,255,.05)";
      ctx.fill();
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = hexA(opts.accent, 0.4);
      ctx.stroke();
      ctx.fillStyle = "#DCEAE6";
      ctx.fillText(label, cx + 20, 397);
      ctx.letterSpacing = "0px";
      cx += w + 16;
      ctx.font = `700 20px ${F.b}`;
    }

    ctx.fillStyle = MINT;
    ctx.font = `700 22px ${F.b}`;
    const fW = ctx.measureText("dexvra.io").width;
    ctx.fillText("dexvra.io", X0, H - 40);
    ctx.fillStyle = FAINT;
    ctx.font = `500 20px ${F.m}`;
    ctx.fillText("—  List · Trend · Advertise", X0 + fW + 16, H - 40);

    drawEmblem(ctx, 980, 300, 150);
    return toSendBuffer(canvas);
  } catch (e) {
    log.warn(`[banner] static render failed: ${e.message}`);
    return null;
  }
}

const renderMainBanner = () =>
  renderStatic({ title: "DEXVRA", sub: "List, trend & advertise your token", chips: ["LISTING", "TRENDING", "BANNER ADS"], accent: MINT });
const renderStaticListing = () =>
  renderStatic({ pill: "NEW LISTING", accent: MINT, title: "New Listing", sub: "A new token just went live on Dexvra", chips: ["FRESH", "VERIFIED", "TRACKED"] });
const renderStaticTrending = () =>
  renderStatic({ pill: "TRENDING NOW", accent: CYAN, title: "Trending Now", sub: "Hot tokens climbing on Dexvra", chips: ["MOMENTUM", "VOLUME", "HYPE"] });

module.exports = {
  renderListingBanner,
  renderTrendingBanner,
  renderRankUpBanner,
  renderMainBanner,
  renderStaticListing,
  renderStaticTrending,
  available: () => !!canvasLib(),
};
