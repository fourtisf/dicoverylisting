'use strict';
/*
 * pnlImage.js — the PnL card as a PICTURE.
 *
 * WHY AN IMAGE AT ALL
 * A PnL card is a thing traders SHARE. The text card answers the question; a
 * screenshot of a wall of numbers is not what anybody posts. This draws the
 * same figures — from the same `pnl.pnlStats()` — as a card with one number on
 * it big enough to read at thumbnail size.
 *
 * WHY IT DRAWS THROUGH bot/src/helpers/canvasKit
 * That module already owns the brand palette, the primitives, and — the part
 * that matters — the FONT FALLBACK CHAIN and `warnBoxes()`. A token called 牛来
 * went out to 12,607 subscribers as "$???" because a face without the glyph
 * draws a box instead of throwing; the fix lives there and every renderer in
 * this repo is required to go through it. A second copy of the font logic in
 * tradebot would be the same outage waiting on a second process.
 *
 * IT IS OPTIONAL, AND FAILURE IS FREE
 * The native canvas binary lives in bot/node_modules. If it is missing, or the
 * kit cannot be reached, or a draw throws, `render()` returns null and the
 * caller sends the text card it already had. A picture is an upgrade; it may
 * never be the reason a user cannot see their PnL.
 */
const path = require('node:path');
const pnl = require('./pnl');

let KIT = null;   // null = not tried, undefined = tried and unavailable
function kit() {
  if (KIT !== null) return KIT;
  try {
    const k = require(path.join(__dirname, '..', 'bot', 'src', 'helpers', 'canvasKit'));
    KIT = (k && typeof k.available === 'function' && k.available()) ? k : undefined;
  } catch (_) { KIT = undefined; }
  return KIT;
}
/** Is the picture available at all? Callers use it only to decide whether to
 *  bother; `render()` is still allowed to return null. */
function available() { return !!kit(); }

const W = 1200, H = 675;
const BAR = 118;               // the brand strip along the foot
const ART = 470;               // the artwork column on the left

/** A short, human amount for a stat row. */
function short(v, native, d) {
  const n = Math.abs(Number(v) || 0);
  // No zero-padding: to an Indonesian reader "1.200" IS 1,200 — the dot is
  // their thousands separator — so a padded 1.2 SOL reads as a thousand-SOL
  // buy on the card's headline surface. "1.2" cannot be misread.
  if (n >= 1000) return `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${native}`;
  // `d` is the PANEL's decimal count — two rows of one table share their
  // decimal geometry ("0.80 / 4.10", never "0.8 / 4.100").
  if (d != null) return `${n.toFixed(d)} ${native}`;
  const s = (n >= 1 ? n.toFixed(3) : n.toFixed(4)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return `${s} ${native}`;
}
/** Decimals a value NEEDS after trailing-zero trim — feeds the shared count. */
function decOf(v) {
  const n = Math.abs(Number(v) || 0);
  if (n >= 1000) return 0;
  const fr = ((n >= 1 ? n.toFixed(3) : n.toFixed(4)).replace(/0+$/, '').split('.')[1]) || '';
  return fr.length;
}
const usdShort = (v, abbr) => {
  const n = Math.abs(Number(v) || 0);
  if (!(n > 0)) return '';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  // `abbr` is decided per PANEL: "$240.00" beside "$1.0K" in one column reads
  // as two data sources, so if either row abbreviates, both do.
  if (n >= 1e4 || (abbr && n >= 100)) return '$' + (n / 1e3).toFixed(1) + 'K';
  if (n >= 1) return '$' + Math.round(n).toLocaleString('en-US');
  return '$' + n.toFixed(4);
};
/** Deterministic PRNG + seed — the background's ghost tape is unique per
 *  token but STABLE: the same card rendered twice must be the same picture. */
function lcg(seed) { let s = (seed >>> 0) || 1; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
function seedOf(str) { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

/** "0d 0h 13m", the way a trading bot states a hold. */
function heldFor(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(d + 'd');
  if (h) parts.push(h + 'h');
  if (m && !d) parts.push(m + 'm');
  return parts.length ? parts.join(' ') : '<1m';
}

/**
 * Fetch bytes for a picture we want to draw INTO the card.
 *
 * Bounded and best-effort in every direction: a short timeout, a size cap (a
 * card must not be held up by somebody's 8 MB PNG), and null on anything at
 * all. The card is drawn either way — the logo is decoration, and decoration
 * may never be the reason a PnL is late or missing.
 */
const _bytes = new Map();
const BYTES_TTL_MS = 6 * 3600 * 1000;
const BYTES_MAX = 4 * 1024 * 1024;
async function fetchBytes(url, ms = 4000) {
  if (!url) return null;
  const hit = _bytes.get(url);
  if (hit && Date.now() - hit.at < BYTES_TTL_MS) return hit.buf;
  let buf = null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (r.ok) {
      const len = Number(r.headers.get('content-length') || 0);
      if (!len || len <= BYTES_MAX) {
        const ab = await r.arrayBuffer();
        if (ab.byteLength <= BYTES_MAX) buf = Buffer.from(ab);
      }
    }
  } catch (_) { buf = null; }
  if (_bytes.size >= 200) _bytes.delete(_bytes.keys().next().value);
  _bytes.set(url, { at: Date.now(), buf });
  return buf;
}

/** Draw `img` cropped to a circle at (cx,cy,r) — a token logo is any aspect
 *  ratio and a squashed one looks like a bug in the card. */
function circleImage(ctx, img, cx, cy, r) {
  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, sx, sy, side, side, cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
}

/**
 * Draw the card. `p` is core.tokenPnl()'s return — RAW, not HTML-escaped: this
 * draws glyphs, and `&amp;` on a canvas is four characters of nonsense.
 *
 * Returns a PNG Buffer, or null when there is nothing honest to draw (no
 * canvas, or a total we could not compute — an image is a claim, and an image
 * of an unknown is a claim nobody can qualify).
 */
async function render(p, { native = 'ETH', rate = 0, chainName = '', logoUrl = '', refLink = '', qrApi = '', botUser = '' } = {}) {
  const K = kit();
  if (!K) return null;
  const s = pnl.pnlStats(p);
  // A picture cannot carry "we could not read it just now" the way a sentence
  // can — it would be a branded card stating a number that is not known. Those
  // fall back to the text card, which says so in words.
  if (s.unknown || s.status === 'none' || !(s.ethIn > 0)) return null;
  const C = K.canvasLib();
  if (!C) return null;
  // The glyph guard every renderer in this repo is required to call. It warns
  // and draws anyway: a card with a box in it still beats no card.
  try { K.warnBoxes('pnl card', { symbol: p.sym, name: p.name }); } catch (_) {}

  // The two pictures, fetched TOGETHER and never awaited one after the other —
  // and both are allowed to fail.
  const [logoBuf, qrBuf] = await Promise.all([
    fetchBytes(logoUrl, 4000),
    refLink && qrApi ? fetchBytes(`${qrApi}/?size=76x76&margin=0&data=${encodeURIComponent(refLink)}`, 4000) : Promise.resolve(null),
  ]);
  let logo = null, qr = null;
  try { if (logoBuf) logo = await C.loadImage(logoBuf); } catch (_) { logo = null; }
  try { if (qrBuf) qr = await C.loadImage(qrBuf); } catch (_) { qr = null; }

  const cv = C.createCanvas(W, H);
  const ctx = cv.getContext('2d');
  const win = s.pnl > 0;
  const flat = s.pnl === 0;
  const ACC = win ? K.SITE.upFrom : flat ? K.MUTE : K.SITE.downTo;
  const ACC2 = win ? K.SITE.upTo : flat ? K.FAINT : K.SITE.downFrom;

  // ── ground ────────────────────────────────────────────────────────────────
  // Deep diagonal wash, three glows, a dot grid, one light sweep, a vignette.
  // The first cut ruled a 60px line grid over the whole card and it read as
  // graph paper; dots recede, which is what a ground is for.
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0A0E1A');
  bg.addColorStop(0.55, win ? '#0B1524' : '#140B1C');
  bg.addColorStop(1, win ? '#07131C' : '#1B0C1A');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  K.radial(ctx, ART * 0.52, (H - BAR) * 0.46, 430, ACC, win ? 0.22 : 0.17);
  K.radial(ctx, W * 0.88, 80, 400, K.CYAN, 0.10);
  K.radial(ctx, W * 0.60, H - BAR, 300, ACC2, 0.06);
  // The third hue of the mesh — a violet floor glow, so the ground is a
  // colour field and not two spotlights on black.
  K.radial(ctx, W * 0.32, H * 0.94, 420, K.SITE.violet, 0.09);
  // The ghost tape: a price line only this token draws — seeded by its
  // symbol so it is unique per card and stable per token, RISING on a win
  // and falling on a loss. Texture, not data: it stays under 0.2 alpha.
  // The panel's geometry, needed HERE because the tape must clip around it
  // and again below where the panel is drawn — one owner, two readers.
  const PANEL = { x: ART + 18, y: 366, w: W - 40 - (ART + 18), h: 156 };
  ctx.save();
  // Contained: inside the frame's inner rounded-rect (an element cut off by
  // the canvas edge reads as escaping the card), above the strip, and with
  // the stats panel PUNCHED OUT — the seeded path kept landing exactly on
  // the money rows, which reads as a collision and not a design.
  K.roundRect(ctx, 16, 16, W - 32, H - 32, 20);
  ctx.clip();
  ctx.beginPath(); ctx.rect(0, 0, W, H - BAR); ctx.clip();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(PANEL.x - 8, PANEL.y - 8, PANEL.w + 16, PANEL.h + 16);
  ctx.clip('evenodd');
  const rnd = lcg(seedOf(p.sym || p.ca || 'dexvra'));
  const tapePts = [];
  for (let i = 0; i <= 9; i++) {
    const tx = (W / 9) * i;
    const ty = win || flat
      ? H * 0.80 - H * 0.44 * (i / 9) - (flat ? H * 0.12 : 0)
      : H * 0.34 + H * 0.44 * (i / 9);
    tapePts.push([tx, ty + (rnd() - 0.5) * 96]);
  }
  ctx.beginPath();
  ctx.moveTo(tapePts[0][0], tapePts[0][1]);
  for (let i = 1; i < tapePts.length; i++) {
    const [ax, ay2] = tapePts[i - 1], [bx2, by2] = tapePts[i];
    ctx.quadraticCurveTo(ax, ay2, (ax + bx2) / 2, (ay2 + by2) / 2);
  }
  ctx.lineTo(tapePts[9][0], tapePts[9][1]);
  ctx.save();
  const tapeStroke = ctx.createLinearGradient(0, 0, W, 0);
  tapeStroke.addColorStop(0, K.hexA(ACC, 0));
  tapeStroke.addColorStop(0.08, K.hexA(ACC, 0.16));
  tapeStroke.addColorStop(0.9, K.hexA(ACC, 0.16));
  tapeStroke.addColorStop(1, K.hexA(ACC, 0));
  ctx.strokeStyle = tapeStroke;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.shadowColor = K.hexA(ACC, 0.35);
  ctx.shadowBlur = 16;
  ctx.stroke();
  ctx.restore();
  ctx.lineTo(W, H - BAR); ctx.lineTo(0, H - BAR); ctx.closePath();
  const tf = ctx.createLinearGradient(0, H * 0.30, 0, H - BAR);
  tf.addColorStop(0, K.hexA(ACC, 0.07));
  tf.addColorStop(1, K.hexA(ACC, 0));
  ctx.fillStyle = tf;
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = K.hexA('#FFFFFF', 0.05);
  for (let gx = 46; gx < W - 20; gx += 46)
    for (let gy = 44; gy < H - BAR - 10; gy += 46) {
      ctx.beginPath(); ctx.arc(gx, gy, 1.1, 0, Math.PI * 2); ctx.fill();
    }
  // One soft diagonal beam — the sheen a flat fill never has.
  ctx.save();
  ctx.translate(W * 0.30, 0);
  ctx.rotate(0.42);
  const beam = ctx.createLinearGradient(0, 0, 300, 0);
  beam.addColorStop(0, K.hexA('#FFFFFF', 0));
  beam.addColorStop(0.5, K.hexA('#FFFFFF', 0.035));
  beam.addColorStop(1, K.hexA('#FFFFFF', 0));
  ctx.fillStyle = beam;
  ctx.fillRect(-90, -220, 360, H + 520);
  ctx.restore();
  // Grain — ~1400 seeded specks. A flat digital gradient bands; grain is
  // what makes it read as material instead of a fill.
  const gr = lcg(0xD3C5A);
  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle = K.hexA('#FFFFFF', gr() < 0.12 ? 0.06 : 0.025);
    ctx.fillRect(Math.floor(gr() * W), Math.floor(gr() * H), 1, 1);
  }
  // Vignette — the edges fall away so the coin and the number come forward.
  const vg = ctx.createRadialGradient(W * 0.45, H * 0.42, H * 0.42, W * 0.45, H * 0.42, W * 0.74);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  // ── the artwork: the token's own face, or the Dexvra gem wearing its ticker
  const cx = ART * 0.52, cy = (H - BAR) * 0.515, R = 156;
  // Orbit arcs with rounded caps, and a lit dot riding the outer one — the
  // "in motion" figure, in the accent so a win and a loss differ at a glance.
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = K.hexA(ACC, 0.5);
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(cx, cy, R + 36, -0.9, 1.4); ctx.stroke();
  ctx.strokeStyle = win || flat ? K.hexA(K.CYAN, 0.28) : K.hexA(K.SITE.violet, 0.3);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, R + 58, 1.9, 3.7); ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.shadowColor = K.hexA(ACC, 0.9);
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.arc(cx + Math.cos(1.4) * (R + 36), cy + Math.sin(1.4) * (R + 36), 5, 0, Math.PI * 2);
  ctx.fillStyle = ACC;
  ctx.fill();
  ctx.restore();
  // Halo → coin face (a shallow radial, so the disc is a surface and not a
  // hole) → the art → gloss → seat → gradient rim. The order is the depth.
  ctx.save();
  ctx.shadowColor = K.hexA(ACC, 0.7);
  ctx.shadowBlur = 70;
  ctx.beginPath(); ctx.arc(cx, cy, R + 5, 0, Math.PI * 2);
  ctx.fillStyle = K.hexA(ACC, 0.14);
  ctx.fill();
  ctx.restore();
  const face = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.2, cx, cy, R);
  face.addColorStop(0, K.SITE.card);
  face.addColorStop(1, '#0A0E17');
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = face;
  ctx.fill();
  if (logo) {
    circleImage(ctx, logo, cx, cy, R - 12);
  } else {
    // NO LOGO IS THE COMMON CASE for a launch this bot snipes, so the
    // fallback is the design and not an apology — and it is the DEXVRA MARK
    // ITSELF, alone and centred, the owner's call ("kalo project ga punya
    // logo pake logo dexvra sendiri", then "name ticker di logo hapus aja").
    // The token's identity lives in the $TICKER headline, not on the coin.
    // ⚠️ drawBrandMark's (x,y) is the TOP-LEFT of a 48-unit box, not the
    // centre — the same contract that already cost drawGem half a diameter.
    const MS = 176;
    try { K.drawBrandMark(ctx, cx - MS / 2, cy - MS / 2, MS); } catch (_) {}
  }
  // Gloss — a specular wash across the upper-left, over logo and gem alike, so
  // either reads as one struck coin rather than a picture in a circle.
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
  const gloss = ctx.createLinearGradient(cx - R, cy - R, cx + R * 0.4, cy + R * 0.4);
  gloss.addColorStop(0, K.hexA('#FFFFFF', 0.13));
  gloss.addColorStop(0.45, K.hexA('#FFFFFF', 0.02));
  gloss.addColorStop(1, K.hexA('#FFFFFF', 0));
  ctx.fillStyle = gloss;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  ctx.restore();
  // The coin's edge: a bezel between art and rim. Over a fetched logo it is
  // the face colour in one clean band (a flat black circle there read as a
  // default-canvas stroke); the monogram face keeps the subtle seat.
  if (logo) {
    ctx.beginPath(); ctx.arc(cx, cy, R - 6, 0, Math.PI * 2);
    ctx.strokeStyle = '#0A0E17';
    ctx.lineWidth = 12;
    ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(cx, cy, R - 4, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  const rg = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  rg.addColorStop(0, ACC);
  rg.addColorStop(1, ACC2);
  ctx.strokeStyle = rg;
  ctx.lineWidth = 6;
  ctx.shadowColor = K.hexA(ACC, 0.5);
  ctx.shadowBlur = 22;
  ctx.stroke();
  ctx.restore();
  // Glints — on a WIN only. A sparkle on a red card congratulates a loss.
  if (win) {
    try {
      K.sparkle(ctx, cx + R * 0.74, cy - R * 0.80, 13, K.hexA('#FFFFFF', 0.9));
      K.sparkle(ctx, cx - R * 0.98, cy + R * 0.52, 8, K.hexA(ACC, 0.8));
    } catch (_) {}
  }

  // ── the stats column ──────────────────────────────────────────────────────
  const RX = ART + 44;                       // left edge of the stats
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  // $TICKER + the multiple badge, on one line — the badge is the headline the
  // eye lands on second, so it sits beside the name and not under it.
  const tick = '$' + String(p.sym || '').toUpperCase().slice(0, 12);
  ctx.fillStyle = K.INK;
  const tickTxt = K.fitText(ctx, tick, 300, { weight: 800, size: 58, min: 26, family: K.F.x });
  ctx.fillText(tickTxt, RX, 138);
  const tickW = ctx.measureText(tickTxt).width;
  // fitText leaves its chosen font set — read the fitted size back out. The
  // badge scales WITH it: a full-size 44px "124X" beside a shrunk 33px ticker
  // outweighs the name it qualifies.
  const tsm = /(\d+(?:\.\d+)?)px/.exec(ctx.font);
  const tickSize = tsm ? Number(tsm[1]) : 58;
  const bScale = Math.max(30 / 44, tickSize / 58);
  const bf = Math.round(44 * bScale);
  const bh = Math.round(58 * bScale);
  const bBase = 138;                              // shared baseline with the ticker
  const bcy = bBase - Math.round(bf * 0.36);      // capsule centres on its digits
  const by0 = Math.round(bcy - bh / 2);
  const multTxt = s.mult == null ? '—' : `${s.mult >= 100 ? Math.round(s.mult) : s.mult.toFixed(2)}X`;
  ctx.font = `800 ${bf}px ${K.F.d7}`;
  const badgeW = ctx.measureText(multTxt).width + Math.round(96 * bScale);
  const bx = Math.min(RX + tickW + 26, W - 62 - badgeW);
  ctx.save();
  K.roundRect(ctx, bx, by0, badgeW, bh, bh / 2);
  const bgd = ctx.createLinearGradient(bx, 0, bx + badgeW, 0);
  bgd.addColorStop(0, ACC);
  bgd.addColorStop(1, ACC2);
  ctx.fillStyle = bgd;
  ctx.shadowColor = K.hexA(ACC, 0.45);
  ctx.shadowBlur = 26;
  ctx.fill();
  ctx.shadowBlur = 0;
  // A top-edge highlight inside the capsule — the difference between a pill
  // that is lit and a rectangle that is filled.
  ctx.clip();
  const bhl = ctx.createLinearGradient(0, by0, 0, by0 + bh / 2);
  bhl.addColorStop(0, 'rgba(255,255,255,0.30)');
  bhl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = bhl;
  ctx.fillRect(bx, by0, badgeW, bh / 2);
  ctx.restore();
  ctx.font = `800 ${bf}px ${K.F.d7}`;
  ctx.fillStyle = win ? K.SITE.upInk : '#FFFFFF';
  ctx.fillText(multTxt, bx + Math.round(24 * bScale), bBase);
  // The arrow — the one mark that says up or down without a number.
  const ax = bx + badgeW - Math.round(46 * bScale), ay = bcy;
  const A = (n) => Math.round(n * bScale);
  ctx.save();
  ctx.strokeStyle = win ? K.SITE.upInk : '#FFFFFF';
  ctx.fillStyle = win ? K.SITE.upInk : '#FFFFFF';
  ctx.lineWidth = Math.max(5, A(7));
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(ax, ay - A(win ? 16 : 18));
  ctx.lineTo(ax, ay + A(win ? 18 : 16));
  ctx.stroke();
  ctx.beginPath();
  if (win) { ctx.moveTo(ax - A(15), ay - A(4)); ctx.lineTo(ax, ay - A(22)); ctx.lineTo(ax + A(15), ay - A(4)); }
  else { ctx.moveTo(ax - A(15), ay + A(4)); ctx.lineTo(ax, ay + A(22)); ctx.lineTo(ax + A(15), ay + A(4)); }
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Held for — and the state, because a card that says nothing about whether
  // this is over reads as though it is.
  ctx.fillStyle = K.MUTE;
  const held = (p.trades && p.trades.firstAt) ? `Hold ${heldFor(Date.now() - p.trades.firstAt)}` : '';
  const state = s.status === 'closed' ? 'Closed' : s.status === 'partial' ? 'Partly sold' : 'Still holding';
  const meta = [chainName, held, state].filter(Boolean).join('  ·  ');
  // Fitted, never clipped: "Solana · Hold 1d 2h · Still holding" is
  // already wider than the column, and a longer chain name would cross the
  // frame stroke — which reads as a cropped card.
  ctx.fillText(K.fitText(ctx, meta, W - 62 - RX, { weight: 600, size: 24, min: 17, family: K.F.m6 }), RX, 180);

  // The word above the number — hand-tracked, in the accent. It is what makes
  // the % a verdict rather than a figure.
  ctx.fillStyle = K.hexA(ACC, 0.95);
  ctx.font = `800 21px ${K.F.m7}`;
  ctx.fillText((win ? 'PROFIT' : flat ? 'BREAK-EVEN' : 'LOSS').split('').join(' '), RX + 4, 226);

  // THE NUMBER. Nothing on the card competes with it.
  const pctTxt = s.pct == null ? '—' : `${s.pct > 0 ? '+' : s.pct < 0 ? '-' : ''}${Math.abs(s.pct) >= 1000 ? Math.round(Math.abs(s.pct)).toLocaleString('en-US') : Math.abs(s.pct).toFixed(0)}%`;
  ctx.save();
  ctx.shadowColor = K.hexA(ACC, 0.6);
  ctx.shadowBlur = 46;
  const pg = ctx.createLinearGradient(RX, 230, RX + 520, 340);
  pg.addColorStop(0, ACC);
  pg.addColorStop(1, ACC2);
  ctx.fillStyle = pg;
  const pTxt = K.fitText(ctx, pctTxt, W - RX - 92, { weight: 800, size: 132, min: 56, family: K.F.x });
  ctx.fillText(pTxt, RX, 336);
  ctx.restore();

  // INVESTED / PAYOUT in a glass panel — Maestro's two rows, which is all a
  // shared card needs: what went in, what came back. "Payout" is what is
  // realised on a closed trade and what the bag is worth on an open one, and
  // the label says which.
  const outAmt = s.status === 'closed' ? s.ethOut : s.ethOut + s.value;
  const dmax = Math.max(decOf(s.ethIn), decOf(outAmt));
  const pd = dmax <= 2 ? dmax : null;      // share geometry only while tidy
  const abbr = rate > 0 && Math.max(s.ethIn, outAmt) * rate >= 1e4;
  const rows = [
    ['INVESTED', short(s.ethIn, native, pd), rate > 0 ? usdShort(s.ethIn * rate, abbr) : ''],
    [s.status === 'closed' ? 'PAYOUT' : 'VALUE NOW', short(outAmt, native, pd), rate > 0 ? usdShort(outAmt * rate, abbr) : ''],
  ];
  const px0 = PANEL.x, pw = PANEL.w, py0 = PANEL.y, ph = PANEL.h;
  ctx.save();
  K.roundRect(ctx, px0, py0, pw, ph, 20);
  ctx.fillStyle = K.hexA('#FFFFFF', 0.045);
  ctx.fill();
  ctx.strokeStyle = K.hexA('#FFFFFF', 0.10);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = K.hexA('#FFFFFF', 0.08);
  ctx.fillRect(px0 + 24, py0 + ph / 2, pw - 48, 1);
  const xR = px0 + pw - 28;
  // The USD annex sits in a FIXED slot: measured per row it varies in width,
  // and the two SOL figures staircase instead of reading as one column.
  const usdSlot = rows.some(([, , sub]) => sub) ? 128 : 0;
  let by = py0 + 48;
  for (const [label, val, sub] of rows) {
    ctx.fillStyle = K.FAINT;
    ctx.font = `700 20px ${K.F.m7}`;
    ctx.fillText(label.split('').join(' '), px0 + 28, by);
    if (sub) {
      // Left-aligned inside the fixed slot: right-aligned at the box edge the
      // GAP between SOL and USD varied with the USD's width, which is the
      // staircase one column over.
      ctx.fillStyle = K.MUTE;
      ctx.font = `600 22px ${K.F.m6}`;
      ctx.fillText(sub, xR - usdSlot + 26, by);
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = K.INK;
    const vt = K.fitText(ctx, val, 330, { weight: 700, size: 36, min: 18, family: K.F.d7 });
    ctx.fillText(vt, xR - usdSlot, by);
    ctx.textAlign = 'left';
    by += ph / 2;
  }

  // ── the brand strip ───────────────────────────────────────────────────────
  ctx.save();
  const strip = ctx.createLinearGradient(0, H - BAR, 0, H);
  strip.addColorStop(0, 'rgba(0,0,0,0.40)');
  strip.addColorStop(1, 'rgba(0,0,0,0.66)');
  ctx.fillStyle = strip;
  ctx.fillRect(0, H - BAR, W, BAR);
  const line = ctx.createLinearGradient(0, 0, W, 0);
  line.addColorStop(0, K.hexA(ACC, 0));
  line.addColorStop(0.35, K.hexA(ACC, 0.8));
  line.addColorStop(1, K.hexA(K.CYAN, 0));
  ctx.fillStyle = line;
  ctx.fillRect(0, H - BAR, W, 2);
  ctx.restore();
  K.drawBrandMark(ctx, 54, H - BAR + 30, 58);
  ctx.textAlign = 'left';
  ctx.fillStyle = K.INK;
  ctx.font = `800 36px ${K.F.d7}`;
  ctx.fillText('DEXVRA', 130, H - BAR + 60);
  const wmW = ctx.measureText('DEXVRA').width;   // measured in the wordmark's OWN font
  if (botUser) {
    // The bot's own @username, beside the wordmark — a shared card must say
    // WHERE to go. It is the handle getMe() answered with, never a literal.
    // Optically CENTRED on the wordmark's caps (36px caps centre ≈ baseline
    // −13; 21px caps centre ≈ baseline −8), not hung off its baseline.
    ctx.fillStyle = K.SITE.mint;
    ctx.font = `600 21px ${K.F.m6}`;
    ctx.fillText('@' + botUser, 130 + wmW + 20, H - BAR + 55);
  }
  ctx.fillStyle = K.MUTE;
  ctx.font = `600 17px ${K.F.m6}`;
  ctx.fillText('TRADE  ·  SNIPE  ·  COPY', 132, H - BAR + 88);
  // The referral, and its QR — the reason a shared card is worth sharing.
  if (qr) {
    // Centred between the strip's hairline and the FRAME's bottom edge — the
    // frame is at H-14, and an 84px tile put its foot on the stroke.
    const q = 76, qx = W - 54 - q, qy = H - BAR + 2 + (H - 14 - (H - BAR + 2) - q) / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 16;
    K.roundRect(ctx, qx - 7, qy - 7, q + 14, q + 14, 14);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.restore();
    // 1:1, no resampling — a scaled QR is a blurred QR.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(qr, qx, qy, q, q);
    ctx.imageSmoothingEnabled = true;
    ctx.textAlign = 'right';
    ctx.fillStyle = K.SOFT;
    ctx.font = `600 19px ${K.F.m6}`;
    ctx.fillText('Scan to trade with Dexvra', qx - 26, H - BAR + 52);
    ctx.fillStyle = K.FAINT;
    ctx.font = `600 17px ${K.F.m6}`;
    ctx.fillText('and earn from every referral', qx - 26, H - BAR + 78);
  } else {
    ctx.textAlign = 'right';
    ctx.fillStyle = K.SOFT;
    ctx.font = `700 22px ${K.F.m7}`;
    ctx.fillText('dexvra.io', W - 54, H - BAR + 66);
  }

  // ── the frame — one gradient hairline, inset, that finishes the card the
  // way a border finishes a ticket. Drawn LAST so it sits crisp over the
  // vignette and encloses the strip.
  ctx.save();
  K.roundRect(ctx, 14, 14, W - 28, H - 28, 22);
  const fg = ctx.createLinearGradient(0, 0, W, H);
  fg.addColorStop(0, K.hexA(ACC, 0.55));
  fg.addColorStop(0.5, K.hexA('#FFFFFF', 0.10));
  fg.addColorStop(1, K.hexA(K.CYAN, 0.35));
  ctx.strokeStyle = fg;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.restore();

  try { return cv.toBuffer('image/png'); } catch (_) { return null; }
}

module.exports = { render, available, W, H };
