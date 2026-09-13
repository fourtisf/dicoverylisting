// chart:preview — DRIVE the candlestick chart and look at what it draws.
//
// The chart panel is judged by LOOKING at it: the defects this script was
// written alongside were a time label clipped to a WRONG time ("3:46" for
// 23:46, because a CSS `text-anchor` silently beat the renderer's own), a price
// label sitting underneath the last-price tag, and 160 candles smeared into
// 1.6px bodies on a phone. Every one of them passed the unit tests and passed a
// source scan.
//
// It stubs the upstreams IN THE BROWSER, so it runs on a box with no egress and
// its output does not depend on what a memecoin did this afternoon. What it
// cannot check is whether GeckoTerminal answers — `npm run trending:check` in
// the bot is the model for that, and it has to be measured on the server.
//
//   npm run build && npm start &
//   npm run chart:preview                    # → chart-shots/*.png
//   BASE_URL=http://localhost:3000 SHOT_DIR=/tmp/shots npm run chart:preview
//
// Exits non-zero if any state fails to render, so "it looked fine" is not the
// only thing standing between a broken chart and a deploy.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.SHOT_DIR ?? "chart-shots";
mkdirSync(SHOT_DIR, { recursive: true });

const CHAIN = "solana";
const ADDR = "3jiVL4dKjVBSVsnGTCd28PaYiXXynaJa2JZTLxDLq9x4";
const POOL = "PooLaddr1111111111111111111111111111111111";

const results = [];
const check = (name, ok, extra = "") => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  return ok;
};

/**
 * A state section that FAILS rather than ABORTING THE RUN.
 *
 * ⚠️ ONE STALE WAIT USED TO UN-PROBE EVERY SURFACE BELOW IT. The `.ck-empty`
 * wait for the "chart unavailable" state stopped matching the moment that
 * state began rendering DexScreener's embed instead of an apology — and
 * because a `waitForSelector` THROWS, the harness caught it, printed one
 * `FAIL harness` line, and never ran the native-fallback chip, the unlisted
 * page or the ENTIRE phone context. Thirty checks silenced by one changed
 * panel, which is this script's own subject: a renderer nobody probes is
 * exactly how a banner shipped boxes for six days.
 *
 * Only the STATE sections get this. The interactive sequence above them shares
 * one page and one accumulated chart state — a throw part-way through a drag
 * genuinely does invalidate what follows — while each of these reloads the
 * page and stands alone, so a throw in one must not answer for the others.
 */
const section = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    check(name, false, String(e.message).split("\n")[0]);
  }
};

/** A deterministic random walk. Oldest-first, which is what /api/ohlcv returns
 *  after normalizeCandles — the client is entitled to that and does not re-sort. */
function candles(n, step) {
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  let p = 0.0009;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let i = n - 1; i >= 0; i--) {
    const o = p;
    const c = Math.max(0.00001, o * (1 + (rnd() - 0.46) * 0.09));
    out.push({
      t: now - i * step,
      o,
      h: Math.max(o, c) * (1 + rnd() * 0.03),
      l: Math.min(o, c) * (1 - rnd() * 0.03),
      c,
      v: Math.round(500 + rnd() * 9000),
    });
    p = c;
  }
  return out;
}

/** THE SHAPE THAT WAS REPORTED: $0.000803 → $0.0281 in two days, i.e. a 35x.
 *  On a LINEAR axis the whole of the early history is a line on the floor and
 *  only the last spike is readable — which is the picture the price-scale
 *  control exists for, so it is the picture this script has to render. A steady
 *  compounding climb with a little noise, deterministic. */
function ramp(n, step) {
  const now = Math.floor(Date.now() / 1000);
  const lo = 0.000803;
  const hi = 0.0281;
  const g = (hi / lo) ** (1 / (n - 1));
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = lo * g ** i;
    const c = o * g * (1 + (rnd() - 0.5) * 0.04);
    out.push({
      t: now - (n - 1 - i) * step,
      o, c,
      h: Math.max(o, c) * (1 + rnd() * 0.02),
      l: Math.min(o, c) * (1 - rnd() * 0.02),
      v: Math.round(500 + rnd() * 9000),
    });
  }
  return out;
}

const TOKEN = {
  key: `${CHAIN}:${ADDR}`, chain: CHAIN, address: ADDR, symbol: "$FLOKI", name: "Floki",
  logoUrl: null, emoji: "🐶", gradient: ["#7BE8C2", "#22C39A", "#0B6E52"],
  priceUsd: 0.001186, mcap: 1190000, liq: 445,
  chg: { "5m": 1.2, "1h": -3.4, "6h": 12.5, "24h": 923 },
  vol: { "5m": 120, "1h": 900, "6h": 4200, "24h": 8300 },
  txns: { "5m": { buys: 3, sells: 1 }, "1h": { buys: 20, sells: 9 }, "6h": { buys: 90, sells: 40 }, "24h": { buys: 201, sells: 100 } },
  holders: 0, taxPct: 0, ageMinutes: 300, trend: [1, 2, 3, 4, 5], verified: true, source: "live",
  tier: "GOLD", trendingRank: null, listedMinutesAgo: 120, score: 70, poolAddress: POOL,
  links: { website: null, twitter: null, telegram: null }, overview: null,
};

const STEP = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

/** `mode` is read at request time so a test can change what the upstream says
 *  between two page loads. */
const stub = async (page, mode) => {
  await page.route("**/api/tokens", (r) =>
    r.fulfill({ json: { tokens: [TOKEN], heat: [], signals: [], wire: [], trackedVol24h: 8300, live: true, updatedAt: Date.now() } }));
  await page.route("**/api/feargreed", (r) =>
    r.fulfill({ json: { value: 55, label: "Neutral", updatedMinutesAgo: 3, source: "live" } }));
  await page.route("**/api/trades**", (r) => r.fulfill({ json: { trades: [], live: false } }));
  // ⚠️ THE EMBED IS A THIRD-PARTY IFRAME, and this script's contract is that
  // it runs on a box with no egress and does not depend on what dexscreener.com
  // did this afternoon. Stubbed, so what is measured is OUR panel — is the
  // embed there, are the inert controls gone, is there room for it — and
  // nothing at all about whether their widget draws. That is the honest
  // boundary: their chart is not ours to test.
  await page.route("https://dexscreener.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: '<!doctype html><title>ds</title><body style="margin:0;background:#0b0d12">' }));
  await page.route("**/api/token-preview**", (r) =>
    r.fulfill({ json: { chain: CHAIN, token: { name: "Floki", symbol: "FLOKI", priceUsd: 0.001186, mcap: 1190000, logoUrl: null, poolAddress: POOL, source: "dexscreener" } } }));
  await page.route("**/api/ohlcv**", (r) => {
    const tf = new URL(r.request().url()).searchParams.get("tf") ?? "15m";
    const m = mode();
    if (m === "none")
      return r.fulfill({ json: { ok: false, network: CHAIN, pool: null, tf, candles: [], why: "No pool indexed for this token yet — nothing to chart." } });
    if (m === "error")
      return r.fulfill({ json: { ok: false, network: CHAIN, pool: null, tf, candles: [], why: "Couldn't read the chart just now (GeckoTerminal 429 (rate limited); DexScreener 403)." } });
    // The FALLBACK, drawn. With GeckoTerminal healthy this state never occurs
    // in a preview run, and it is the one state where the panel says something
    // extra — so it has to be looked at deliberately or the chip ships unseen.
    // The 35x climb the price-scale control was reported for.
    if (m === "ramp")
      return r.fulfill({ json: { ok: true, network: CHAIN, pool: POOL, tf, candles: ramp(160, STEP[tf] ?? 900), why: null, source: "geckoterminal", sourceUrl: `https://www.geckoterminal.com/${CHAIN}/pools/${POOL}` } });
    if (m === "dexscreener")
      return r.fulfill({
        json: {
          ok: true, network: CHAIN, pool: null, tf, candles: candles(160, STEP[tf] ?? 900), why: null,
          source: "dexscreener", sourceUrl: `https://dexscreener.com/${CHAIN}/${POOL}`,
        },
      });
    return r.fulfill({ json: { ok: true, network: CHAIN, pool: POOL, tf, candles: candles(160, STEP[tf] ?? 900), why: null, source: "geckoterminal", sourceUrl: `https://www.geckoterminal.com/${CHAIN}/pools/${POOL}` } });
  });
};

let browser;
let failed = false;
try {
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  // ⚠️ The site registers a service worker, and a SW-served request never
  // reaches page.route — the stubs above would be bypassed on the second load
  // and the chart would quietly show whatever the real server said.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));

  let mode = "ok";
  await stub(page, () => mode);

  // ── the drawn chart ──────────────────────────────────────────────────────
  await page.goto(`${BASE}/token/${CHAIN}/${ADDR}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".ck-svg", { timeout: 20000 });
  const drawn = await page.locator(".ck-c").count();
  check("candles are drawn", drawn > 20, `${drawn} candles`);
  check("volume bars match the candles", (await page.locator(".ck-vol").count()) === drawn);
  check("the window change is labelled with the span it covers", /over \d+[hdmo]/.test(await page.locator(".ck-chg").innerText()));
  await page.screenshot({ path: `${SHOT_DIR}/token-page.png` });
  await page.locator(".tp-chart-wrap").screenshot({ path: `${SHOT_DIR}/chart.png` });

  // ⚠️ Every axis stamp must be a WHOLE time. A centred label on the first
  // candle hangs half of itself off the plot, and "23:46" shipped as "3:46".
  // textContent, not innerText: an SVG <text> has no innerText and every stamp
  // would come back blank — a check that passes on an empty string is no check.
  const stamps = await page.evaluate(() => [...document.querySelectorAll(".ck-axis-x")].map((t) => t.textContent ?? ""));
  check("no time stamp is clipped to a wrong time", stamps.every((s) => /^\d{2}:\d{2}$|^\d{1,2} \w{3}$/.test(s)), stamps.join(" · "));
  const inside = await page.evaluate(() => {
    const svg = document.querySelector(".ck-svg").getBoundingClientRect();
    return [...document.querySelectorAll(".ck-axis-x")].every((t) => {
      const r = t.getBoundingClientRect();
      return r.left >= svg.left - 0.5 && r.right <= svg.right + 0.5;
    });
  });
  check("every axis stamp is inside the plot", inside);

  // ── the readout ──────────────────────────────────────────────────────────
  const box = await page.locator(".ck-plot").boundingBox();
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.4);
  await page.waitForTimeout(200);
  check("the crosshair follows the pointer", (await page.locator(".ck-cross").count()) === 1);
  const tip = await page.locator(".ck-tip").innerText();
  check("the readout carries O/H/L/C and volume", /O /.test(tip) && /H /.test(tip) && /L /.test(tip) && /C /.test(tip) && /Vol /.test(tip), tip.replace(/\n/g, " "));
  await page.locator(".tp-chart-wrap").screenshot({ path: `${SHOT_DIR}/chart-hover.png` });

  // ── the timeframes ───────────────────────────────────────────────────────
  for (const tf of ["5m", "1h", "1d"]) {
    // EXACT: `hasText: "5m"` also matches the 15m tab.
    await page.getByRole("tab", { name: tf, exact: true }).click();
    await page.waitForTimeout(700);
    // Scoped to the tablist: the LIN/LOG pair wears the same `.ck-tf` pill.
    check(`the ${tf} tab draws its own candles`, (await page.locator(".ck-c").count()) > 20 && (await page.locator('[role="tablist"] .ck-tf.on').innerText()) === tf);
  }
  await page.locator(".tp-chart-wrap").screenshot({ path: `${SHOT_DIR}/chart-1d.png` });

  // ── the reader's vertical ────────────────────────────────────────────────
  // Judged by LOOKING at it, on the shape that was reported: a 35x climb whose
  // whole history is flat on the floor of a linear panel. Four shots, because
  // "the control exists" and "the control changes the picture" are different
  // claims and only the second one is the feature.
  mode = "ramp";
  await page.getByRole("tab", { name: "15m", exact: true }).click();
  await page.waitForTimeout(900);
  await page.mouse.move(10, 10); // drop the crosshair so the shots are clean
  await page.waitForTimeout(120);
  const plot = await page.locator(".ck-plot").boundingBox();
  /** Where the MIDDLE of the move sits, as a fraction up the PRICE area — the
   *  price at which the token had done half its multiple belongs somewhere near
   *  the middle of a chart of that move. Measured against the price grid rather
   *  than the whole svg: the volume band and the time axis are not part of the
   *  scale, and counting them would flatter a linear chart by a fifth. */
  const halfwayUp = () =>
    page.evaluate(() => {
      // The first five .ck-grid lines are the price grid, drawn before the
      // volume baseline — so they ARE the price area, exactly.
      const grid = [...document.querySelectorAll(".ck-grid")].slice(0, 5).map((g) => g.getBoundingClientRect().top);
      const bodies = [...document.querySelectorAll(".ck-c .ck-body")];
      if (grid.length < 5 || !bodies.length) return null;
      const top = Math.min(...grid);
      const bottom = Math.max(...grid);
      const mid = bodies[Math.floor(bodies.length / 2)].getBoundingClientRect().top;
      return 1 - (mid - top) / (bottom - top);
    });

  const linUp = await halfwayUp();
  await page.locator(".tp-chart-wrap").screenshot({ path: `${SHOT_DIR}/scale-lin.png` });
  check("LIN: a 35x move flattens its own history — the reported picture", linUp != null && linUp < 0.25, `half the move sits ${(linUp * 100).toFixed(0)}% up the price area`);

  await page.getByRole("button", { name: "LOG", exact: true }).click();
  await page.waitForTimeout(400);
  const logUp = await halfwayUp();
  await page.locator(".tp-chart-wrap").screenshot({ path: `${SHOT_DIR}/scale-log.png` });
  check("LOG: the same history is readable across the panel", logUp != null && logUp > 0.4 && logUp < 0.6, `half the move sits ${(logUp * 100).toFixed(0)}% up the price area`);
  check("…and the panel says which axis it is on", (await page.locator('[aria-label="Price scale"] .ck-tf.on').innerText()) === "LOG");

  // Drag the price gutter — the control the reader asked for by name.
  await page.getByRole("button", { name: "LIN", exact: true }).click();
  await page.waitForTimeout(300);
  const spanOf = () =>
    page.evaluate(() => {
      const ys = [...document.querySelectorAll(".ck-c .ck-body")].map((b) => b.getBoundingClientRect());
      if (!ys.length) return null;
      return Math.max(...ys.map((r) => r.bottom)) - Math.min(...ys.map((r) => r.top));
    });
  const before = await spanOf();
  const gutter = await page.locator(".ck-yaxis").boundingBox();
  await page.mouse.move(gutter.x + gutter.width / 2, plot.y + plot.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(gutter.x + gutter.width / 2, plot.y + plot.height * 0.2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await spanOf();
  check("dragging the price axis UP stretches the chart", after > before * 1.4, `${Math.round(before)}px → ${Math.round(after)}px`);
  check("…and the panel offers the way back", (await page.locator(".ck-auto").count()) === 1);
  await page.locator(".tp-chart-wrap").screenshot({ path: `${SHOT_DIR}/scale-stretched.png` });

  // Drag the chart body — content follows the finger.
  const topBefore = await page.evaluate(() =>
    Math.min(...[...document.querySelectorAll(".ck-c .ck-body")].map((b) => b.getBoundingClientRect().top)));
  await page.mouse.move(plot.x + plot.width * 0.4, plot.y + plot.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(plot.x + plot.width * 0.4, plot.y + plot.height * 0.4 + 60, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const topAfter = await page.evaluate(() =>
    Math.min(...[...document.querySelectorAll(".ck-c .ck-body")].map((b) => b.getBoundingClientRect().top)));
  // ⚠️ BY THE DRAG DISTANCE, not merely "downwards". `>20px` passed happily on
  // a build where a pointermove over the gutter ran the handler twice — once
  // for the gutter and again as it bubbled to the plot — so every drag applied
  // its zoom TWICE and the scale ran away exponentially under the hand. It
  // measured as a working control and read as an uncontrollable one.
  const moved = topAfter - topBefore;
  check("dragging the chart moves it BY the drag — content follows the finger", Math.abs(moved - 60) < 8, `60px drag moved it ${Math.round(moved)}px`);

  // ⚠️ THE CLIP. Unclipped, a stretched chart draws its wicks straight through
  // the volume histogram and the time stamps.
  //
  // ⚠️ AND THE ZONE IT MATTERS IN IS ONLY ~120px TALL — between the floor of
  // the price area and the bottom of the svg, which clips everything past it
  // by itself. Push the chart harder than that and the candles sail straight
  // out of the zone, and the probe truthfully reports nothing to clip. A 260px
  // shove was tried here and did exactly that; the vacuity guard below said so
  // rather than letting the clip check pass on an empty region.
  //
  // Measured by HIT-TESTING, and MUTATION-TESTED in the page: the clip is
  // pulled off, the same points are probed again, and it is put back. Two
  // cheaper checks were tried first and both were worthless — bounding boxes
  // on clipped SVG come back collapsed or stale, and a run where nothing
  // overflows makes any "nothing spilled" assertion true of a chart with no
  // clip at all. This one fails if the clip stops working AND fails if the
  // probe stops being able to see a spill.
  const clip = await page.evaluate(() => {
    const grid = [...document.querySelectorAll(".ck-grid")].slice(0, 5).map((g) => g.getBoundingClientRect().top);
    const svg = document.querySelector(".ck-svg").getBoundingClientRect();
    const below = Math.max(...grid); // the floor of the price area
    const g = document.querySelector(".ck-svg g[clip-path]");
    // A SCAN, not three sample points. The first cut probed y = below+14,
    // below+34 and svg.bottom-8, and a hard enough drag pushes the candles past
    // all three — so the probe reported "nothing down here" about a chart that
    // was drawing everywhere. x stops at 80% because the price gutter is an
    // overlay and would answer every hit test in the last 7%.
    const probe = () => {
      for (let f = 0.12; f <= 0.8; f += 0.04) {
        const x = svg.left + svg.width * f;
        for (let y = below + 6; y <= svg.bottom - 2; y += 6) {
          const el = document.elementFromPoint(x, y);
          if (el && (el.classList.contains("ck-body") || el.classList.contains("ck-wick"))) return true;
        }
      }
      return false;
    };
    const withClip = probe();
    const attr = g?.getAttribute("clip-path") ?? null;
    g?.removeAttribute("clip-path");
    const without = probe();
    if (attr) g?.setAttribute("clip-path", attr);
    return { attr, withClip, without };
  });
  check("the candles are drawn inside a clip at all", Boolean(clip.attr), String(clip.attr));
  check("a stretch really does push candles past the price area", clip.without, "…so the check below is not vacuous");
  check("…and the clip keeps them off the volume band and the time axis", !clip.withClip);
  // …and the one number the reader came for is still on screen.
  const tagOn = await page.evaluate(() => {
    const svg = document.querySelector(".ck-svg").getBoundingClientRect();
    const t = document.querySelector(".ck-lasttx");
    if (!t) return false;
    const r = t.getBoundingClientRect();
    return r.top >= svg.top - 1 && r.bottom <= svg.bottom + 1;
  });
  check("the last-price tag is pinned into the panel, never dragged off it", tagOn);

  // ── travelling through time ──────────────────────────────────────────────
  // "bisa di geser ke kanan ke kiri chartnya". A chart you cannot move through
  // time is a picture, so this drives the real gestures and measures that the
  // WINDOW changed, not merely that something happened.
  await page.locator(".ck-auto").click();
  await page.waitForTimeout(300);
  const firstStamp = () => page.evaluate(() => document.querySelector(".ck-axis-x")?.textContent ?? "");
  const nCandles = () => page.locator(".ck-c").count();
  const before0 = await nCandles();

  // Wheel = zoom the time axis, anchored at the pointer. Zoomed in hard on
  // purpose: with the whole fetched history already on screen there is nowhere
  // to travel TO, and a pan check would pass or fail on the clamp instead of on
  // the pan. (The first cut compared a stamp taken BEFORE this zoom, and the
  // window had been clamped back to the same first candle — it reported the
  // drag as broken when the drag was fine.)
  await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.5);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(300);
  const zoomed = await nCandles();
  check("the wheel zooms the time axis", zoomed > 0 && zoomed < before0 * 0.75, `${before0} → ${zoomed} candles`);
  check("…and the page did not scroll away underneath it", (await page.evaluate(() => window.scrollY)) === 0);

  // Drag sideways = travel. Right = back in time.
  const t0 = await firstStamp();
  await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(plot.x + plot.width * 0.5 + 220, plot.y + plot.height * 0.5, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  const t1 = await firstStamp();
  check("dragging right travels BACK in time", t1 !== "" && t1 !== t0, `${t0} → ${t1}`);
  check("…and the same number of candles is still drawn", Math.abs((await nCandles()) - zoomed) <= 1, "a pan moves the window, it does not resize it");
  check("…and the panel stops claiming the candles are live", (await page.locator(".ck-live").count()) === 0);
  check("…and says it is showing history instead", (await page.locator(".ck-src").innerText()) === "HISTORY");
  await page.locator(".tp-chart-wrap").screenshot({ path: `${SHOT_DIR}/time-scrolled.png` });

  // A drag cannot run off the end of the data.
  await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(plot.x + plot.width * 0.5 - 4000, plot.y + plot.height * 0.5, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  check("a drag past the newest candle stops at the live edge", (await page.locator(".ck-live").count()) === 1);
  check("…with a chart still drawn", (await nCandles()) > 5);

  // …and the way back.
  await page.locator(".ck-auto").click();
  await page.waitForTimeout(300);
  check("⤢ Auto hands the axis back to the data", (await page.locator(".ck-auto").count()) === 0);
  const reset = await spanOf();
  check("…and the chart is where it started", Math.abs(reset - before) < 6, `${Math.round(before)}px → ${Math.round(reset)}px`);
  mode = "ok";

  // ── the state with nothing to draw ───────────────────────────────────────
  // "none" is a fact about the TOKEN — no pool has traded yet — so it gets the
  // apology and deliberately NOT the embed: DexScreener's chart would be just
  // as empty while implying the failure was ours.
  await section("the empty state", async () => {
    mode = "none";
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".ck-empty", { timeout: 20000 });
    const text = await page.locator(".ck-empty").innerText();
    check('the "none" state says it is about the token', /No candles yet/.test(text), text.split("\n")[0]);
    check("…and nothing is framed over it", (await page.locator(".ck iframe").count()) === 0);
    await page.locator(".tp-chart-wrap").screenshot({ path: `${SHOT_DIR}/chart-empty.png` });
  });

  // ── the DexScreener EMBED: what a reader gets when NEITHER source drew ────
  //
  // ⚠️ THIS SURFACE HAD NO PROBE AT ALL, and it shipped with TWO TOOLBARS
  // STACKED ON A PHONE — ours (LIN/LOG, the timeframes, ⤢ Auto) sitting above
  // DexScreener's own, over their widget squeezed into what was left of a
  // 360px panel. Every control in our row is INERT over a third-party iframe:
  // they drive the native renderer, and "a row the engine ignores" is this
  // repo's own name for what that costs. It was reported from a screenshot,
  // which is the thing this script exists to make unnecessary — and it was
  // reported because the one state a busy GeckoTerminal produces was the one
  // state nothing here rendered.
  await section("the DexScreener embed", async () => {
    mode = "error";
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".ck--embed iframe", { timeout: 20000 });
    const src = String(await page.locator(".ck--embed iframe").getAttribute("src"));
    check("a chart neither source could draw frames DexScreener's own", src.includes(`dexscreener.com/${CHAIN}/`), src.slice(0, 64));
    check("…and our chart controls are DROPPED, not left inert above it", (await page.locator(".ck-ctl").count()) === 0);
    check("…and the apology it replaces is gone", (await page.locator(".ck-empty").count()) === 0);
    await page.locator(".tp-chart-wrap").screenshot({ path: `${SHOT_DIR}/chart-embed.png` });
  });
  mode = "ok";

  // ── the DexScreener fallback, drawn ──────────────────────────────────────
  //
  // A chart drawn from the second source and one drawn from GeckoTerminal are
  // identical from outside, so "the fallback works" and "the fallback never
  // fires" are the same picture — which is the reassuring reading this repo
  // keeps paying for. The chip is the only tell, and an unseen chip is how it
  // ships mispositioned, mis-cased or over the live dot.
  await section("the DexScreener fallback", async () => {
    mode = "dexscreener";
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".ck-svg", { timeout: 20000 });
    check("the fallback still draws a full chart", (await page.locator(".ck-c").count()) > 20);
    check("…and SAYS it came from DexScreener", (await page.locator(".ck-src").count()) === 1,
      (await page.locator(".ck-src").count()) ? await page.locator(".ck-src").innerText() : "no chip");
    // The chip sits in the header row beside the ticker; if it wrapped or
    // overflowed, the header is taller than the tab strip it shares a line with.
    const fits = await page.evaluate(() => {
      const chip = document.querySelector(".ck-src");
      const head = document.querySelector(".ck-head");
      if (!chip || !head) return false;
      const c = chip.getBoundingClientRect();
      const h = head.getBoundingClientRect();
      return c.top >= h.top - 0.5 && c.bottom <= h.bottom + 0.5 && c.width > 20;
    });
    check("the source chip sits inside the header row", fits);
    await page.locator(".tp-chart-wrap").screenshot({ path: `${SHOT_DIR}/chart-dexscreener.png` });
  });
  mode = "ok";

  // ── the unlisted page: NO chart, and never an embed ──────────────────────
  //
  // ⚠️ THIS CHECK WAS STALE, AND IT HAD MADE THE WHOLE SCRIPT USELESS AS A GATE.
  // It waited for `.unlisted-chart .ck-svg` and asserted "an unlisted token gets
  // the chart too" — written when it did. The chart was then deliberately
  // REMOVED on the owner's call ("Kalo token belum listing hapus chartnya"):
  // this page is reachable by pasting any contract at all, every buy-bot alert
  // links here, and each visit polled /api/ohlcv for a token nobody listed —
  // a listed customer's chart competing for GeckoTerminal's ceiling with an
  // unlisted stranger's. Charting is what a listing buys.
  //
  // So the assertion has been failing on every run since, which means this
  // script exited non-zero every time and nobody could use it to gate anything.
  // A check that asserts a deleted feature is worse than no check: it trains
  // the reader to ignore the red. It asserts the DECISION now, and
  // `unlisted.test.ts` pins the same thing from the other side.
  await section("the unlisted page", async () => {
    await page.goto(`${BASE}/token/${CHAIN}/9unknown11111111111111111111111111111111111`, { waitUntil: "networkidle" });
    await page.waitForSelector(".unlisted-wrap, .unlisted", { timeout: 20000 }).catch(() => {});
    check("an unlisted token gets NO chart — charting is what a listing buys", (await page.locator(".ck-svg").count()) === 0);
    check("…but it still shows the price it got free with the preview", /\$/.test(await page.locator("body").innerText()));
    check("and no iframe anywhere on it", (await page.locator("iframe").count()) === 0);
    await page.screenshot({ path: `${SHOT_DIR}/unlisted.png`, fullPage: true });
  });

  // ── a phone ──────────────────────────────────────────────────────────────
  // `hasTouch` is not decoration: a phone dispatches POINTER events with
  // `pointerType: "touch"`, and the chart's drag rules turn on exactly that
  // value. A narrow viewport driven by a mouse would exercise the desktop path
  // and report it as the phone's.
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  const m = await mctx.newPage();
  m.on("pageerror", (e) => errs.push(`(phone) ${e.message}`));
  // ⚠️ MUTABLE, like the desktop's. Pinned to "ok", the phone could only ever
  // be shown the healthy chart — and the panel that was actually reported is
  // the one a busy GeckoTerminal produces.
  let mmode = "ok";
  await stub(m, () => mmode);
  let nativeH = 0;
  await section("the phone", async () => {
    await m.goto(`${BASE}/token/${CHAIN}/${ADDR}`, { waitUntil: "networkidle" });
    await m.waitForSelector(".ck-svg", { timeout: 20000 });
    const phone = await m.locator(".ck-c").count();
    nativeH = (await m.locator(".tp-chart-wrap").boundingBox()).height;
    // ⚠️ 160 candles across a 330px plot is a 1.6px body — a smear you cannot
    // read one bar out of. The window narrows to what fits.
    check("the phone window narrows to candles you can actually see", phone > 20 && phone < drawn, `${phone} of ${drawn}`);
    check("the page does not scroll sideways", !(await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
    // ⚠️ A PHONE TOUCHES THE CHART, and on touch the body drag is deliberately
    // NOT taken (the page scroller keeps it) — which means the pointerdown
    // handler returns before it ever captures the pointer, and the pointerup /
    // pointercancel that follow must cope with that. Every touch-scroll across
    // the chart goes down this path, so anything thrown here is thrown constantly
    // and on the one surface most of this token's readers are using.
    const mplot = await m.locator(".ck-plot").boundingBox();
    await m.touchscreen.tap(mplot.x + mplot.width * 0.5, mplot.y + mplot.height * 0.5);
    await m.waitForTimeout(150);
    const beforeScroll = await m.evaluate(() => window.scrollY);
    await m.evaluate(() => window.scrollBy(0, 120));
    await m.waitForTimeout(200);
    check("a tap on the chart is harmless", errs.length === 0, errs.join(" | "));
    check("…and the page still scrolls past it", (await m.evaluate(() => window.scrollY)) > beforeScroll);
    await m.screenshot({ path: `${SHOT_DIR}/phone.png` });
  });

  // ── the embed, ON THE PHONE — the reported picture ────────────────────────
  //
  // The panel is sized for OUR chart, which draws one compact axis; their
  // widget stacks a toolbar, a TradingView plot, a volume pane, a time axis and
  // a "Tracked by DEXSCREENER" strip into the same box. Measured against the
  // native panel rather than a magic number, so a design change moves both and
  // the rule survives it.
  await section("the embed on a phone", async () => {
    mmode = "error";
    await m.reload({ waitUntil: "networkidle" });
    await m.waitForSelector(".ck--embed iframe", { timeout: 20000 });
    const embedH = (await m.locator(".tp-chart-wrap").boundingBox()).height;
    const frameH = (await m.locator(".ck--embed iframe").boundingBox()).height;
    check("the embed gets a taller panel than our own chart needs", embedH > nativeH + 40, `${Math.round(nativeH)}px → ${Math.round(embedH)}px`);
    check("…and their widget gets nearly all of it", frameH > embedH * 0.85, `${Math.round(frameH)}px of ${Math.round(embedH)}px`);
    check("…with our inert control row gone from the header", (await m.locator(".ck-ctl").count()) === 0);
    check("…and the page still does not scroll sideways", !(await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
    await m.screenshot({ path: `${SHOT_DIR}/phone-embed.png` });
  });

  check("no page errors", errs.length === 0, errs.join(" | "));
} catch (err) {
  results.push(`FAIL harness — ${err.message}`);
} finally {
  await browser?.close();
}

for (const line of results) {
  if (line.startsWith("FAIL")) failed = true;
  console.log(line);
}
console.log(`\n${results.filter((r) => r.startsWith("PASS")).length}/${results.length} checks · shots in ${SHOT_DIR}/`);
process.exit(failed ? 1 : 0);
