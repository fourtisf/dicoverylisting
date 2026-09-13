// Token logo → ANIMATED custom emoji (per-token sticker pack) — the fourtis
// tokenEmojiPack pattern ported to dexvra. Every listing's logo becomes a
// 100×100 animated custom emoji living in its own pack titled
// "<SYMBOL> by @dexvralisting"; channel posts drop it inline next to the token
// name via the premium-markup tag `[💎](emoji/<id>)` (GramJS renders it
// animated; the Bot API fallback shows the unicode fallback char).
//
// Pipeline (all best-effort — a failure NEVER blocks a paid listing):
//   1. logo Buffer → 48 PNG frames (@napi-rs/canvas): a seamless Y-axis
//      "card flip" loop (width = 100·|cos φ|), the same animation style
//      Telegram's own premium emoji use.
//   2. frames → 100×100 VP9 WEBM with alpha (fluent-ffmpeg + bundled ffmpeg),
//      stepped down through a bitrate ladder to clear Telegram's 64 KB
//      custom-emoji video cap. Static WEBP fallback if ffmpeg fails.
//   3. uploadStickerFile + createNewStickerSet (sticker_type custom_emoji)
//      under the ADMIN bot (@dexvraadminbot owns the packs; pack title still
//      advertises the listing channel).
//   4. custom_emoji_id persisted in DATA_DIR/tokenemoji.json keyed
//      `${chain}:${address}` — idempotent across restarts and re-posts.
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { loadJSONSync, saveJSON } = require("./helpers/persist");
const { ADMIN_BOT_TOKEN, ADMIN_IDS, CHANNELS } = require("./config/constants");
const log = require("./helpers/logger");

const FILE = "tokenemoji.json";
const store = loadJSONSync(FILE, {});
const keyOf = (chain, address) => `${chain}:${String(address).toLowerCase()}`;

// Telegram custom-emoji video constraints: 100×100 exact, ≤3 s, ≤30 fps,
// VP9 + alpha, and a 64 KB cap (STICKER_VIDEO_BIG past it — the 256 KB
// ceiling people remember is for regular video stickers, not custom emoji).
const ANIM_DURATION_SEC = 2;
const ANIM_FPS = 24;
const BITRATE_LADDER_K = [90, 60, 40, 28];
const MAX_WEBM_BYTES = 64 * 1024;

const PACK_BOT_TOKEN = process.env.TOKEN_PACK_BOT_TOKEN || ADMIN_BOT_TOKEN;
// Bot API requires a user_id that has /start'ed the pack bot on every sticker
// call — ownership still goes to the bot, this is just an anchor.
const PACK_ANCHOR_USER_ID = String(process.env.TOKEN_PACK_USER_ID || ADMIN_IDS[0] || "");
const PACK_TITLE_SUFFIX = process.env.TOKEN_PACK_TITLE_SUFFIX || ` by ${CHANNELS.listing}`;

const available = () => Boolean(PACK_BOT_TOKEN && PACK_ANCHOR_USER_ID);

// ── Bot API (fetch — surfaces Telegram's real error description) ────────────
async function callApi(method, params = {}, fileField = null) {
  const url = `https://api.telegram.org/bot${PACK_BOT_TOKEN}/${method}`;
  let res;
  if (fileField) {
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) {
      form.append(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    form.append(
      fileField.name,
      new Blob([fileField.data], { type: fileField.contentType }),
      fileField.filename,
    );
    res = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
  } else {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(30000),
    });
  }
  const j = await res.json().catch(() => null);
  if (!j || !j.ok) {
    throw new Error(`${method}: ${(j && j.description) || `HTTP ${res.status}`}`);
  }
  return j.result;
}

// ── Lazy image/video toolchain (mirrors bannerTemplate's canvas pattern) ────
let CV = null;
function canvasLib() {
  if (CV === undefined) return null;
  if (CV) return CV;
  try {
    CV = require("@napi-rs/canvas");
  } catch (e) {
    log.warn(`[tokenEmoji] canvas unavailable: ${e.message}`);
    CV = undefined;
    return null;
  }
  return CV;
}

let FF = null;
function ffmpegLib() {
  if (FF === undefined) return null;
  if (FF) return FF;
  try {
    const ffmpeg = require("fluent-ffmpeg");
    ffmpeg.setFfmpegPath(require("@ffmpeg-installer/ffmpeg").path);
    FF = ffmpeg;
  } catch (e) {
    log.warn(`[tokenEmoji] ffmpeg unavailable (static emoji only): ${e.message}`);
    FF = undefined;
    return null;
  }
  return FF;
}

/** Draw the logo contain-fit on a 100×100 transparent canvas, optionally
 *  squeezed to `w` px wide (the flip animation's foreshortening). */
async function drawFrame(cv, img, w) {
  const canvas = cv.createCanvas(100, 100);
  const ctx = canvas.getContext("2d");
  const scale = Math.min(100 / img.width, 100 / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  const squeeze = w / 100;
  const fw = dw * squeeze;
  ctx.drawImage(img, (100 - fw) / 2, (100 - dh) / 2, fw, dh);
  return canvas;
}

async function logoToStaticWebp(logoBuffer) {
  const cv = canvasLib();
  if (!cv) throw new Error("@napi-rs/canvas missing");
  const img = await cv.loadImage(logoBuffer);
  const canvas = await drawFrame(cv, img, 100);
  let buf = await canvas.encode("webp", 85);
  if (buf.length > MAX_WEBM_BYTES) buf = await canvas.encode("webp", 55);
  return buf;
}

async function logoToAnimatedWebm(logoBuffer) {
  const cv = canvasLib();
  const ffmpeg = ffmpegLib();
  if (!cv || !ffmpeg) throw new Error("canvas/ffmpeg missing");
  const img = await cv.loadImage(logoBuffer);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-emoji-"));
  const outPath = path.join(tmpDir, "out.webm");
  try {
    const totalFrames = ANIM_DURATION_SEC * ANIM_FPS;
    for (let i = 0; i < totalFrames; i++) {
      // Y-axis flip: full → edge-on sliver → full; end matches start so the
      // loop is seamless. 4 px floor keeps the encoder happy at the sliver.
      const phase = (i / totalFrames) * Math.PI;
      const w = Math.max(4, Math.round(100 * Math.abs(Math.cos(phase))));
      const canvas = await drawFrame(cv, img, w);
      fs.writeFileSync(path.join(tmpDir, `f${String(i).padStart(3, "0")}.png`), await canvas.encode("png"));
    }
    const encode = (bitrateK) =>
      new Promise((resolve, reject) => {
        ffmpeg()
          .input(path.join(tmpDir, "f%03d.png"))
          .inputFPS(ANIM_FPS)
          .videoCodec("libvpx-vp9")
          .videoBitrate(`${bitrateK}k`)
          .noAudio()
          .outputOptions([
            "-pix_fmt yuva420p",
            "-deadline good",
            "-cpu-used 4",
            "-row-mt 1",
            "-loop 0",
            "-auto-alt-ref 0", // required to preserve the alpha channel
          ])
          .toFormat("webm")
          .on("end", resolve)
          .on("error", reject)
          .save(outPath);
      });
    for (const k of BITRATE_LADDER_K) {
      await encode(k);
      const buf = fs.readFileSync(outPath);
      if (buf.length <= MAX_WEBM_BYTES) return buf;
    }
    throw new Error(`webm > ${MAX_WEBM_BYTES / 1024}KB even at lowest bitrate`);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* tmp cleanup best-effort */
    }
  }
}

// ── Pack naming (Telegram: [a-z0-9_], starts with a letter, ends _by_<bot>) ─
let _botUsername = null;
async function getPackBotUsername() {
  if (_botUsername) return _botUsername;
  const me = await callApi("getMe");
  _botUsername = me.username;
  return _botUsername;
}

function packSlug(symbol, chain, address, botUsername) {
  let sym = String(symbol || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!sym || !/^[a-z]/.test(sym)) sym = `t${sym}`;
  sym = sym.slice(0, 20);
  const id = crypto.createHash("sha1").update(keyOf(chain, address)).digest("hex").slice(0, 6);
  return `${sym}_${id}_by_${botUsername}`;
}

const packTitle = (symbol) => `${String(symbol || "TOKEN").replace(/^\$+/, "").slice(0, 30)}${PACK_TITLE_SUFFIX}`;

// Telegram requires a real unicode emoji as each sticker's fallback — map the
// ticker's first letter to a stock emoji so the alt-render varies per token.
const FALLBACK_MAP = {
  A: "🅰️", B: "🅱️", C: "©️", D: "💠", E: "🎀", F: "🔥", G: "🟢",
  H: "♥️", I: "ℹ️", J: "🔱", K: "🔑", L: "🔶", M: "Ⓜ️", N: "🆕",
  O: "🅾️", P: "🅿️", Q: "🔷", R: "®️", S: "💲", T: "™️", U: "🆙",
  V: "✌️", W: "〰️", X: "❌", Y: "💛", Z: "⚡",
};
function pickFallbackChar(symbol) {
  const s = String(symbol || "").replace(/^\$+/, "").trim().toUpperCase();
  if (!s) return "💎";
  if (/[0-9]/.test(s[0])) return "🔢";
  return FALLBACK_MAP[s[0]] || "💎";
}

// ── Main entry ──────────────────────────────────────────────────────────────
/**
 * Ensure `${chain}:${address}` has a custom emoji built from its logo.
 * Idempotent via the JSON store. Returns { emojiId, pack, created } or null
 * when the feature is unavailable / the build failed (callers always treat
 * this as optional decoration).
 */
async function ensureTokenEmoji({ chain, address, symbol }, logoBuffer, opts = {}) {
  try {
    if (!chain || !address) return null;
    const k = keyOf(chain, address);
    if (!opts.force && store[k] && store[k].emojiId) {
      return { ...store[k], created: false };
    }
    if (!available()) {
      log.warn("[tokenEmoji] disabled — need ADMIN_BOT_TOKEN + ADMIN_IDS (or TOKEN_PACK_USER_ID) in .env");
      return null;
    }
    if (!logoBuffer || !logoBuffer.length) return null;

    // Render: animated preferred, static fallback.
    let upload;
    try {
      upload = { buf: await logoToAnimatedWebm(logoBuffer), format: "video", ext: "webm", contentType: "video/webm" };
    } catch (e) {
      log.warn(`[tokenEmoji] animation failed for ${symbol || address} (${e.message}) — using static`);
      upload = { buf: await logoToStaticWebp(logoBuffer), format: "static", ext: "webp", contentType: "image/webp" };
    }

    const botUsername = await getPackBotUsername();
    const name = packSlug(symbol, chain, address, botUsername);

    // Pack may already exist from a prior run whose store write was lost.
    try {
      const existing = await callApi("getStickerSet", { name });
      const emojiId = existing && existing.stickers && existing.stickers[0] && existing.stickers[0].custom_emoji_id;
      if (emojiId && !opts.force) {
        store[k] = { emojiId, pack: name, format: upload.format };
        await saveJSON(FILE, store).catch(() => {});
        return { emojiId, pack: name, created: false };
      }
      if (opts.force) await callApi("deleteStickerSet", { name }).catch(() => {});
    } catch {
      /* set doesn't exist — the common case */
    }

    const file = await callApi(
      "uploadStickerFile",
      { user_id: PACK_ANCHOR_USER_ID, sticker_format: upload.format },
      { name: "sticker", data: upload.buf, filename: `${String(symbol || "token").replace(/^\$+/, "")}.${upload.ext}`, contentType: upload.contentType },
    );
    await callApi("createNewStickerSet", {
      user_id: PACK_ANCHOR_USER_ID,
      name,
      title: packTitle(symbol),
      sticker_type: "custom_emoji",
      stickers: [{ sticker: file.file_id, format: upload.format, emoji_list: [pickFallbackChar(symbol)] }],
    });
    const fresh = await callApi("getStickerSet", { name });
    const emojiId = fresh && fresh.stickers && fresh.stickers[0] && fresh.stickers[0].custom_emoji_id;
    if (!emojiId) throw new Error("pack created but no custom_emoji_id on readback");

    store[k] = { emojiId, pack: name, format: upload.format };
    await saveJSON(FILE, store).catch(() => {});
    log.info(`[tokenEmoji] created pack ${name} (${symbol}, ${upload.format}, ${upload.buf.length}B)`);
    return { emojiId, pack: name, created: true };
  } catch (e) {
    log.warn(`[tokenEmoji] ensure failed for ${symbol || address}: ${e.message}`);
    return null;
  }
}

/** Stored emoji id for a token (no network). */
function getEmojiId(chain, address) {
  const rec = store[keyOf(chain, address)];
  return (rec && rec.emojiId) || null;
}

/** Premium-markup tag `[💠](emoji/123…)` + trailing space, or "" — safe to
 *  interpolate unconditionally into channel-post templates. */
/**
 * Ensure the pack from a logo URL — for callers that have a URL but no buffer.
 *
 * Every path that PUBLISHES a listing card has to do this before rendering it:
 * emojiTag() reads the store synchronously, so a token whose pack was never
 * created shows the plain fallback char instead of its animated logo. Paid
 * listings did it; force-post and auto-listing did not, which is why their
 * cards came out with a generic emoji where the token's logo belonged.
 *
 * Best-effort in every direction — a missing logo, a dead URL or a Telegram
 * hiccup just means the fallback char, never a failed post.
 */
async function ensureFromUrl({ chain, address, symbol }, logoUrl, opts = {}) {
  if (!chain || !address || !logoUrl) return null;
  if (!opts.force && getEmojiId(chain, address)) return null; // already have it
  let buf = null;
  try {
    const r = await fetch(logoUrl, { signal: AbortSignal.timeout(12000) });
    if (r.ok) buf = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    log.warn(`[tokenEmoji] logo fetch failed for ${symbol || address}: ${e.message}`);
  }
  if (!buf || !buf.length) return null;
  return ensureTokenEmoji({ chain, address, symbol }, buf, opts);
}

function emojiTag(chain, address, symbol) {
  const id = getEmojiId(chain, address);
  // No pack for this token (creation failed, or the pack bot isn't configured)
  // → still fill the slot with the plain fallback char. It is EXACTLY what a
  // non-premium viewer sees for a token that does have a pack, so the header
  // reads the same either way — where returning "" left a visible gap after the
  // tier badge and made the post look half-rendered.
  // No trailing space: every template puts {logoEmoji} at the END of its header
  // line, so one would just leave invisible trailing whitespace in the post.
  if (!id) return pickFallbackChar(symbol);
  return `[${pickFallbackChar(symbol)}](emoji/${id})`;
}

module.exports = {
  ensureTokenEmoji,
  ensureFromUrl,
  getEmojiId,
  emojiTag,
  available,
  // exported for tests
  packSlug,
  packTitle,
  pickFallbackChar,
  logoToStaticWebp,
  logoToAnimatedWebm,
};
