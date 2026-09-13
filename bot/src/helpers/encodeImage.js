// Telegram-safe banner encoder. A composited banner over an admin-uploaded
// high-res artwork can produce a PNG bigger than Telegram's sendPhoto limit
// (~10 MB) → the send throws 413 "Request Entity Too Large" and the post
// silently degrades to text-only (no banner). Live incident 2026-07-20.
//
// Channel banners are full-bleed rectangles (no transparency needed), so we can
// safely re-encode heavy ones to JPEG, and downscale as a last resort. Small
// banners stay PNG (crisp text/gradients). Takes a @napi-rs/canvas Canvas.
const log = require("./logger");

// Keep normal composites as crisp PNG; only re-encode the oversized ones so we
// never hit Telegram's ~10 MB sendPhoto ceiling. Bundled composites are ~1.5-2.5
// MB, so PNG_MAX sits well above them and only a heavy admin-uploaded artwork
// (the actual 413 cause) trips the JPEG path.
const PNG_MAX = Number(process.env.BANNER_PNG_MAX_BYTES) || 7 * 1024 * 1024;
const HARD_MAX = Number(process.env.BANNER_MAX_BYTES) || 8 * 1024 * 1024; // « Telegram's 10 MB

const mb = (n) => (n / 1048576).toFixed(2);

/** Encode a canvas to a Telegram-photo-safe Buffer (never throws). */
function toSendBuffer(canvas) {
  let png;
  try {
    png = canvas.toBuffer("image/png");
  } catch (e) {
    log.debug(`[img] png encode failed: ${e.message}`);
    return canvas.toBuffer("image/jpeg", 88);
  }
  if (png.length <= PNG_MAX) return png; // small → keep crisp PNG

  const jpg = canvas.toBuffer("image/jpeg", 88);
  log.warn(`[img] banner ${mb(png.length)}MB PNG → ${mb(jpg.length)}MB JPEG (Telegram size guard)`);
  if (jpg.length <= HARD_MAX) return jpg;

  // Still over the ceiling (huge photographic artwork) → downscale + JPEG.
  try {
    const cv = require("@napi-rs/canvas");
    const scale = Math.min(1, Math.sqrt(HARD_MAX / jpg.length) * 0.92);
    const w = Math.max(720, Math.round(canvas.width * scale));
    const h = Math.round(canvas.height * (w / canvas.width));
    const small = cv.createCanvas(w, h);
    small.getContext("2d").drawImage(canvas, 0, 0, w, h);
    const out = small.toBuffer("image/jpeg", 84);
    log.warn(`[img] downscaled banner to ${w}x${h} → ${mb(out.length)}MB`);
    return out.length < jpg.length ? out : jpg;
  } catch (e) {
    log.debug(`[img] downscale failed: ${e.message}`);
    return jpg;
  }
}

module.exports = { toSendBuffer };
