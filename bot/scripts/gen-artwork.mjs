// Generate the bundled Dexvra channel-banner ARTWORK (illustration-grade, via
// Chromium/CSS: real gaussian blur, glass, specular light — things raw canvas
// can't do). Output: assets/banner-artwork-{listing,trending,banner}.png at
// 2560×1280 (2x of 1280×640). The bannerTemplate compositor pastes each
// token's logo into the glowing ring (listing/trending) or the advertiser's
// creative into the glass frame (banner) — see bannerTemplate DEFAULTS.
//   cd /home/user/dexvra && node bot/scripts/gen-artwork.mjs
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "assets");
const FONTS = path.join(OUT, "fonts");

const page_html = (KIND) => {
  const isTrend = KIND === "trending";
  const isAd = KIND === "banner";
  const ACC = isTrend ? "#38D8F0" : isAd ? "#5BB8FF" : "#4EE6A8";
  const ACC2 = isTrend ? "#0E9BD6" : isAd ? "#2E7FE0" : "#22D3EE";
  const LABEL = isTrend ? "TRENDING NOW" : isAd ? "FEATURED" : "NEW LISTING";
  const TG = isTrend ? "@dexvratrending" : isAd ? "@dexvraio" : "@dexvralisting";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family:'Sora'; font-weight:800; src:url('file://${FONTS}/Sora-800.ttf'); }
  @font-face { font-family:'Sora'; font-weight:700; src:url('file://${FONTS}/Sora-700.ttf'); }
  @font-face { font-family:'Sora'; font-weight:600; src:url('file://${FONTS}/Sora-600.ttf'); }
  @font-face { font-family:'Sora'; font-weight:500; src:url('file://${FONTS}/Sora-500.ttf'); }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:1280px; height:640px; overflow:hidden; font-family:'Sora',sans-serif; position:relative; background:#04080c; }

  /* ── smoky depth background — all blurred layers live on an oversized bleed
        canvas so their rectangular bounds never show inside the frame ── */
  .bg { position:absolute; left:-200px; top:-200px; width:1680px; height:1040px; }
  .bg > div { position:absolute; border-radius:50%; }
  .wash { left:0; top:0; width:1680px; height:1040px; border-radius:0 !important;
    background:linear-gradient(118deg, #081613 0%, #050b10 34%, #04121a 72%, #061d24 100%); }
  .blob1 { width:980px; height:820px; left:-140px; top:-160px; filter:blur(110px);
    background:radial-gradient(circle, ${ACC}1a 0%, transparent 52%); }
  .blob2 { width:1240px; height:1020px; right:-220px; bottom:-260px; filter:blur(120px);
    background:radial-gradient(circle, ${ACC2}1f 0%, transparent 52%); }
  .ringSmoke1 { width:880px; height:880px; left:-80px; top:260px; filter:blur(46px);
    background:radial-gradient(circle, transparent 52%, rgba(120,220,205,.05) 62%, transparent 73%); }
  .ringSmoke2 { width:1060px; height:1060px; right:-180px; top:-300px; filter:blur(50px);
    background:radial-gradient(circle, transparent 52%, rgba(90,210,230,.05) 62%, transparent 74%); }
  .indigo { width:760px; height:640px; left:520px; top:-260px; filter:blur(110px);
    background:radial-gradient(circle, rgba(99,102,241,.10) 0%, transparent 55%); }
  .beam { position:absolute; left:640px; top:-260px; width:340px; height:1560px; border-radius:0 !important;
    transform:rotate(24deg); filter:blur(48px);
    background:linear-gradient(90deg, transparent, rgba(150,240,225,.05) 45%, rgba(150,240,225,.07) 55%, transparent); }
  .vig { position:absolute; inset:0; background:radial-gradient(125% 125% at 50% 44%, transparent 56%, rgba(0,0,0,.5)); }
  .cardFrame { position:absolute; left:16px; top:16px; right:16px; bottom:16px; border-radius:26px; pointer-events:none;
    border:1.2px solid transparent;
    background:linear-gradient(135deg, rgba(140,235,215,.22), rgba(140,235,215,.04) 40%, rgba(90,205,235,.2)) border-box;
    -webkit-mask:linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite:xor; mask-composite:exclude; }

  /* floating bokeh particles */
  .bokeh { position:absolute; border-radius:50%; }

  /* glass panel behind the composited $TICKER + name */
  .textPanel { position:absolute; left:64px; top:248px; width:640px; height:186px; border-radius:24px;
    background:linear-gradient(135deg, rgba(255,255,255,.035), rgba(255,255,255,.012) 60%);
    border:1.2px solid rgba(140,230,215,.13);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.06), 0 18px 40px rgba(0,0,0,.35); }
  .textPanel::before { content:''; position:absolute; left:0; top:16px; width:4px; height:154px; border-radius:2px;
    background:linear-gradient(180deg, transparent, ${ACC}99 30%, ${ACC}99 70%, transparent);
    box-shadow:0 0 14px ${ACC}66; }

  /* faint market grid + rising line, tucked above the socials row */
  .chart { position:absolute; left:64px; bottom:104px; opacity:.35; }

  /* ── brand ── */
  .brand { position:absolute; left:56px; top:44px; display:flex; align-items:center; gap:16px; }
  .brand svg { filter:drop-shadow(0 4px 14px ${ACC2}66); }
  .brand .word { font-weight:800; font-size:40px; color:#F2FAF8; letter-spacing:1px; }
  .brand .sub { font-weight:600; font-size:13px; letter-spacing:3.5px; color:#5E7A7C; margin-top:4px; }

  /* ── glossy status pill ── */
  .pill { position:absolute; left:64px; top:150px; padding:3px; border-radius:40px;
    background:linear-gradient(135deg, ${ACC}cc, ${ACC2}55 45%, ${ACC}cc);
    box-shadow:0 0 44px ${ACC}52, 0 10px 30px rgba(0,0,0,.5); }
  .pill .in { border-radius:37px; padding:13px 40px; position:relative; overflow:hidden;
    background:linear-gradient(180deg, #142c26, #0a1613 70%, #0d1f1c);
    display:flex; align-items:center; gap:14px; }
  .pill .in::after { content:''; position:absolute; left:8%; top:2px; width:84%; height:46%;
    border-radius:30px; background:linear-gradient(180deg, rgba(255,255,255,.2), rgba(255,255,255,0)); }
  .pill .dot { width:12px; height:12px; border-radius:50%; background:${ACC};
    box-shadow:0 0 16px ${ACC}, 0 0 34px ${ACC}aa; }
  .pill .txt { font-weight:800; font-size:28px; letter-spacing:3px; color:#ECFFF7;
    text-shadow:0 0 22px ${ACC}88; }

  /* ── socials row ── */
  .socials { position:absolute; left:60px; bottom:44px; display:flex; gap:44px; }
  .soc { display:flex; align-items:center; gap:13px; }
  .soc .ic { width:46px; height:46px; border-radius:50%;
    background:linear-gradient(160deg, ${ACC}2b, #0d1a17 70%);
    border:1.5px solid ${ACC}59; display:flex; align-items:center; justify-content:center;
    box-shadow:0 6px 18px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.14); }
  .soc .lab { font-weight:500; font-size:17px; color:#8FA7A4; line-height:1.25; }
  .soc .val { font-weight:700; font-size:20px; color:#EAF6F2; line-height:1.25; }

  ${isAd ? adHeroCss(ACC, ACC2) : ringHeroCss(ACC, ACC2, isTrend)}

  /* shared hero props */
  .coin { position:absolute; border-radius:50%; display:flex; align-items:center; justify-content:center;
    background:radial-gradient(circle at 34% 28%, #1b3a37, #0a1a1c 72%);
    border:1.6px solid ${ACC}66; box-shadow:0 10px 24px rgba(0,0,0,.5), inset 0 2px 6px rgba(255,255,255,.14), 0 0 26px ${ACC}33; }
  .spark { position:absolute; color:#EAFFF7; text-shadow:0 0 14px ${ACC}; font-size:26px; }
  .grain { position:absolute; inset:0; opacity:.05; }
  </style></head><body>
  <div class="bg"><div class="wash"></div><div class="blob1"></div><div class="blob2"></div><div class="indigo"></div><div class="ringSmoke1"></div><div class="ringSmoke2"></div><div class="beam"></div></div>

  ${[
    [120, 70, 6, 2.2, 0.45], [560, 96, 8, 3, 0.3], [880, 80, 6, 2.4, 0.4],
    [1150, 140, 7, 3, 0.3], [1216, 430, 6, 2.4, 0.38], [740, 540, 5, 2.4, 0.28],
    [980, 580, 5, 2, 0.35], [300, 560, 4, 1.8, 0.3],
  ]
    .map(
      ([x, y, s, b, o]) =>
        `<div class="bokeh" style="left:${x}px;top:${y}px;width:${s}px;height:${s}px;filter:blur(${b}px);opacity:${o};background:radial-gradient(circle at 35% 30%, #DFFFF2, ${ACC});"></div>`,
    )
    .join("")}

  ${isAd ? "" : `<div class="textPanel"></div>`}

  <svg class="chart" width="380" height="96" viewBox="0 0 380 96">
    <defs><linearGradient id="cl" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${ACC}" stop-opacity=".0"/><stop offset=".6" stop-color="${ACC}" stop-opacity=".3"/><stop offset="1" stop-color="${ACC}" stop-opacity=".6"/>
    </linearGradient></defs>
    ${[0, 1, 2].map((i) => `<line x1="0" y1="${16 + i * 30}" x2="380" y2="${16 + i * 30}" stroke="rgba(140,200,195,.05)" stroke-width="1"/>`).join("")}
    <path d="M0 84 C 50 80, 80 66, 120 68 S 190 50, 235 44 S 320 26, 372 10" fill="none" stroke="url(#cl)" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="372" cy="10" r="3.5" fill="${ACC}"/>
    <circle cx="372" cy="10" r="9" fill="${ACC}" opacity=".22"/>
  </svg>

  ${isAd ? adHeroHtml() : ringHeroHtml(isTrend)}

  <div class="vig"></div>
  <div class="cardFrame"></div>

  <div class="brand">${gemSvg(52)}<div><div class="word">Dexvra</div><div class="sub">TOKEN VISIBILITY</div></div></div>

  <div class="pill"><div class="in"><div class="dot"></div><div class="txt">${LABEL}</div></div></div>

  <div class="socials">
    <div class="soc"><div class="ic">${globeSvg(22)}</div><div><div class="lab">Website:</div><div class="val">dexvra.io</div></div></div>
    <div class="soc"><div class="ic">${tgSvg(22)}</div><div><div class="lab">Telegram:</div><div class="val">${TG}</div></div></div>
    <div class="soc"><div class="ic">${xSvg(19)}</div><div><div class="lab">X:</div><div class="val">@dexvra</div></div></div>
  </div>

  <svg class="grain"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>
  </body></html>`;
};

// ── hero: glowing diamond ring (listing / trending) ──────────────────────────
function ringHeroCss(ACC, ACC2, isTrend) {
  return `
  .hero { position:absolute; right:0; top:0; width:520px; height:640px; }
  .halo { position:absolute; right:-90px; top:50px; width:600px; height:600px; border-radius:50%;
    background:radial-gradient(circle, ${ACC2}${isTrend ? "38" : "2e"}, transparent 60%); filter:blur(46px); }
  .ring { position:absolute; left:158px; top:178px; width:264px; height:264px; border-radius:50%;
    background:conic-gradient(from 140deg, ${ACC2}, ${ACC} 20%, ${isTrend ? "#E4FAFF" : "#E8FFF4"} 38%, ${ACC} 54%, ${ACC2} 74%, ${ACC} 88%, ${ACC2});
    box-shadow:0 0 80px ${ACC}66, 0 0 170px ${ACC2}40, 0 26px 54px rgba(0,0,0,.6);
    display:flex; align-items:center; justify-content:center; z-index:1; }
  .ring .band { width:238px; height:238px; border-radius:50%; display:flex; align-items:center; justify-content:center;
    background:conic-gradient(from 320deg, #10333a, #17454e 28%, #10333a 58%, #1b525c 80%, #10333a);
    box-shadow:inset 0 2px 6px rgba(255,255,255,.2), inset 0 -4px 10px rgba(0,0,0,.45); }
  /* trending only: ascending momentum chevrons climbing toward the ring */
  .chev { position:absolute; width:38px; height:38px; border-left:5px solid ${ACC}; border-top:5px solid ${ACC};
    transform:rotate(45deg); border-radius:3px;
    filter:drop-shadow(0 0 12px ${ACC}aa); }
  .ch1 { left:64px; top:400px; opacity:.3; transform:rotate(45deg) scale(.65); }
  .ch2 { left:88px; top:316px; opacity:.55; transform:rotate(45deg) scale(.82); }
  .ch3 { left:114px; top:228px; opacity:.9; }
  .ring .hole { width:212px; height:212px; border-radius:50%; position:relative;
    background:radial-gradient(circle at 38% 30%, #0f1c21, #060c10 75%);
    box-shadow:inset 0 10px 30px rgba(0,0,0,.9), inset 0 -2px 12px rgba(255,255,255,.05); }
  .ring .hole::after { content:''; position:absolute; inset:0; border-radius:50%;
    border:1.5px solid rgba(255,255,255,.15); }
  .ring::after { content:''; position:absolute; inset:-24px; border-radius:50%;
    border:2px dashed ${ACC}40; }
  .ringShine { position:absolute; left:158px; top:178px; width:264px; height:264px; border-radius:50%; z-index:2;
    background:conic-gradient(from 295deg, transparent 0 10%, rgba(255,255,255,.7) 19%, transparent 30% 100%);
    -webkit-mask:radial-gradient(circle, transparent 0 104px, #000 106px 132px, transparent 134px);
    filter:blur(1.2px); }
  .stud { position:absolute; z-index:2; width:16px; height:16px; border-radius:50%;
    background:radial-gradient(circle at 35% 30%, #fff, ${ACC} 60%, ${ACC2});
    box-shadow:0 0 12px ${ACC}; }
  .st1 { left:196px; top:412px; } .st2 { left:372px; top:376px; width:12px; height:12px; }
  .gem { position:absolute; left:210px; top:26px; z-index:0;
    filter:drop-shadow(0 16px 30px rgba(0,0,0,.6)) drop-shadow(0 0 34px ${ACC2}88); }
  .gemGlow { position:absolute; left:176px; top:2px; width:240px; height:200px; border-radius:50%;
    background:radial-gradient(circle, ${ACC}38, transparent 66%); filter:blur(26px); }
  .flare { position:absolute; z-index:1; width:3px; height:52px; border-radius:2px;
    background:linear-gradient(180deg, transparent, #EAFFF7, transparent); filter:blur(.6px); opacity:.9; }
  .fl1 { left:288px; top:8px; } .fl2 { left:288px; top:8px; transform:rotate(90deg); height:44px; }
  .ped { position:absolute; left:150px; top:474px; width:280px; height:120px; }
  .ped .slab { position:absolute; left:14px; top:14px; width:252px; height:26px; border-radius:13px;
    background:linear-gradient(90deg, ${ACC2}22, ${ACC}44 50%, ${ACC2}22);
    border:1.4px solid ${ACC}55;
    box-shadow:0 0 36px ${ACC2}40, inset 0 2px 5px rgba(255,255,255,.22), inset 0 -6px 12px rgba(0,0,0,.35); }
  .ped .pool { position:absolute; left:0; top:34px; width:280px; height:42px; border-radius:50%;
    background:radial-gradient(ellipse, ${ACC2}38, transparent 68%); filter:blur(14px); }
  .c1 { width:74px; height:74px; left:62px;  top:150px; transform:rotate(-14deg); }
  .c2 { width:56px; height:56px; left:452px; top:128px; transform:rotate(12deg);  filter:blur(1px); }
  .c3 { width:64px; height:64px; left:52px;  top:390px; transform:rotate(10deg);  filter:blur(.6px); }
  .c4 { width:46px; height:46px; left:462px; top:372px; transform:rotate(-18deg); filter:blur(1.6px); }
  .c5 { width:38px; height:38px; left:118px; top:14px;  transform:rotate(20deg);  filter:blur(2.2px); }`;
}
function ringHeroHtml(isTrend) {
  return `<div class="hero">
    <div class="halo"></div>
    <div class="gemGlow"></div>
    <div class="gem">${gemSvg(160)}</div>
    <div class="flare fl1"></div><div class="flare fl2"></div>
    <div class="ped"><div class="pool"></div><div class="slab"></div></div>
    <div class="ring"><div class="band"><div class="hole"></div></div></div>
    <div class="ringShine"></div>
    <div class="stud st1"></div><div class="stud st2"></div>
    ${isTrend ? `<div class="chev ch1"></div><div class="chev ch2"></div><div class="chev ch3"></div>` : `<div class="coin c3">${gemSvg(32)}</div>`}
    <div class="coin c1">${gemSvg(38)}</div>
    <div class="coin c2">${gemSvg(28)}</div>
    <div class="coin c4">${gemSvg(22)}</div>
    <div class="coin c5">${gemSvg(18)}</div>
    <div class="spark" style="left:452px; top:296px;">✦</div>
    <div class="spark" style="left:96px; top:296px; font-size:18px; opacity:.8;">✦</div>
  </div>`;
}

// ── hero: glass creative frame (banner ads) — advertiser creative goes inside ─
function adHeroCss(ACC, ACC2) {
  return `
  .frameWrap { position:absolute; left:410px; top:140px; width:790px; height:396px; }
  .fhalo { position:absolute; left:-90px; top:-90px; width:970px; height:576px; border-radius:80px;
    background:radial-gradient(ellipse, ${ACC2}3a, transparent 62%); filter:blur(46px); }
  .frame { position:absolute; left:0; top:0; width:790px; height:396px; border-radius:28px; padding:6px;
    background:conic-gradient(from 130deg at 50% 50%, ${ACC2}, ${ACC} 22%, #E9F6FF 36%, ${ACC} 50%, ${ACC2} 72%, ${ACC} 88%, ${ACC2});
    box-shadow:0 0 80px ${ACC}59, 0 0 160px ${ACC2}38, 0 26px 60px rgba(0,0,0,.55); }
  .frame .inner { width:100%; height:100%; border-radius:23px; position:relative; overflow:hidden;
    background:linear-gradient(160deg, #0b161c, #071017 70%);
    box-shadow:inset 0 8px 30px rgba(0,0,0,.7), inset 0 -2px 10px rgba(255,255,255,.05); }
  .frame .inner::after { content:''; position:absolute; left:4%; top:0; width:92%; height:36%;
    background:linear-gradient(180deg, rgba(255,255,255,.09), transparent); border-radius:24px 24px 50% 50%; }
  .frame .tag { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
    font-weight:700; font-size:24px; letter-spacing:4px; color:#3D585F; }
  .corner { position:absolute; width:40px; height:40px; border:5px solid ${ACC}; z-index:2;
    filter:drop-shadow(0 0 10px ${ACC}aa); }
  .cTL { left:-20px; top:-20px; border-right:none; border-bottom:none; border-radius:12px 0 0 0; }
  .cTR { right:-20px; top:-20px; border-left:none; border-bottom:none; border-radius:0 12px 0 0; }
  .cBL { left:-20px; bottom:-20px; border-right:none; border-top:none; border-radius:0 0 0 12px; }
  .cBR { right:-20px; bottom:-20px; border-left:none; border-top:none; border-radius:0 0 12px 0; }
  .gemDock { position:absolute; right:56px; top:-64px; z-index:3;
    filter:drop-shadow(0 10px 22px rgba(0,0,0,.6)) drop-shadow(0 0 30px ${ACC2}99); }
  .gemDockGlow { position:absolute; right:18px; top:-104px; width:180px; height:170px; border-radius:50%;
    background:radial-gradient(circle, ${ACC}33, transparent 64%); filter:blur(18px); z-index:2; }
  .fpool { position:absolute; left:90px; bottom:-46px; width:610px; height:56px; border-radius:50%;
    background:radial-gradient(ellipse, ${ACC2}40, transparent 68%); filter:blur(18px); }
  .ac1 { width:64px; height:64px; left:-96px; top:44px;  transform:rotate(-12deg); }
  .ac2 { width:44px; height:44px; left:-64px; top:330px; transform:rotate(14deg);  filter:blur(1px); }
  .ac3 { width:52px; height:52px; right:-90px; top:150px; transform:rotate(10deg); filter:blur(.6px); }
  .ac4 { width:36px; height:36px; right:-58px; top:352px; transform:rotate(-16deg); filter:blur(1.8px); }`;
}
function adHeroHtml() {
  return `<div class="frameWrap">
    <div class="fhalo"></div>
    <div class="fpool"></div>
    <div class="frame"><div class="inner"><div class="tag">YOUR BANNER HERE</div></div>
      <div class="corner cTL"></div><div class="corner cTR"></div><div class="corner cBL"></div><div class="corner cBR"></div>
      <div class="gemDockGlow"></div>
      <div class="gemDock">${gemSvg(96)}</div>
    </div>
    <div class="coin ac1">${gemSvg(34)}</div>
    <div class="coin ac2">${gemSvg(24)}</div>
    <div class="coin ac3">${gemSvg(28)}</div>
    <div class="coin ac4">${gemSvg(18)}</div>
    <div class="spark" style="left:-40px; top:216px;">✦</div>
    <div class="spark" style="right:-36px; bottom:-20px; font-size:18px; opacity:.8;">✦</div>
    <div class="spark" style="left:220px; top:-34px; font-size:16px; opacity:.7;">✦</div>
  </div>`;
}

// Faceted Dexvra gem (brand mark) with per-facet gradients + specular hints.
function gemSvg(size) {
  const id = Math.random().toString(36).slice(2, 7);
  return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="ga${id}" x1="9" y1="12" x2="39" y2="37" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#7CFFC8"/><stop offset=".5" stop-color="#38D8F0"/><stop offset="1" stop-color="#0E9BD6"/>
    </linearGradient>
    <linearGradient id="gb${id}" x1="24" y1="19" x2="24" y2="37" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#4EE6A8"/><stop offset="1" stop-color="#0B86BE"/>
    </linearGradient>
  </defs>
  <polygon points="15,12 33,12 39,19 24,37 9,19" fill="url(#ga${id})"/>
  <polygon points="20,19 28,19 24,37" fill="url(#gb${id})"/>
  <polygon points="15,12 20,19 9,19" fill="#8FFAD2" opacity=".85"/>
  <polygon points="33,12 39,19 28,19" fill="#2CC4E8" opacity=".9"/>
  <polygon points="15,12 33,12 28,19 20,19" fill="#B7FFE3" opacity=".75"/>
  <polygon points="9,19 20,19 24,37" fill="#1FB5DE" opacity=".85"/>
  <polygon points="16,13 20,13 18.4,15.4" fill="#fff" opacity=".8"/>
  <path d="M9 19 L39 19" stroke="rgba(6,14,18,.4)" stroke-width="1"/>
  <path d="M20 19 L24 37 L28 19" stroke="rgba(6,14,18,.35)" stroke-width="1" fill="none"/>
</svg>`;
}
const globeSvg = (s) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="#CFF3E8" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M4.6 7h14.8M4.6 17h14.8"/></svg>`;
const tgSvg = (s) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="#CFF3E8"><path d="M23.91 3.79L20.3 20.84c-.25 1.21-.98 1.5-2 .94l-5.5-4.07-2.66 2.57c-.3.3-.55.56-1.1.56-.72 0-.6-.27-.84-.95L6.3 13.7l-5.45-1.7c-1.18-.36-1.19-1.16.26-1.75l21.26-8.2c.97-.36 1.9.23 1.53 1.73z"/></svg>`;
const xSvg = (s) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="#CFF3E8"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
for (const kind of ["listing", "trending", "banner"]) {
  await page.setContent(page_html(kind), { waitUntil: "networkidle" });
  await page.waitForTimeout(250);
  const out = path.join(OUT, `banner-artwork-${kind}.png`);
  await page.screenshot({ path: out });
  console.log("wrote", out);
}
await browser.close();
