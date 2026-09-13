// Web-side management of the Telegram bot's CHANNEL-POST banner templates — the
// still artwork + GIF/video clips the bot composites onto listing / trending /
// pump / rank-up / banner-ad posts. These files live in the BOT's data dir and
// the bot reads them FRESH on every post, so a change here takes effect on the
// next post with no bot restart.
//
// The web app and the bot must share this directory on the server. It defaults
// to <cwd>/bot/data — correct for a repo-root deploy where the bot uses its
// default DATA_DIR (bot/data). If the bot runs with BOT_DATA_DIR pointing
// elsewhere, set BANNER_TEMPLATE_DIR on the web app to the same absolute path.
import { promises as fs } from "node:fs";
import * as fss from "node:fs";
import path from "node:path";

export const CHANNEL_KINDS = ["listing", "trending", "banner", "pump", "rankup"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
// Still-artwork compositing exists only for these; the rest are clip-only.
export const ARTWORK_KINDS = new Set<string>(["listing", "trending", "banner"]);
// Kinds where the bot draws the token's logo + $ticker/name/chips onto the clip
// (auto-fill). For these the text overlay can be toggled off (logo only) when a
// designed clip already carries its own text. Pump auto-fills too, but with its
// OWN layout (▲ +N% · old→new price · MCAP pill).
export const FILL_KINDS = new Set<string>(["listing", "trending", "pump"]);
// Must match the bot's LAYOUT_VERSION (bannerTemplate.js) or saved tweaks are
// ignored as "tuned for an older artwork".
const LAYOUT_VERSION = 6;

const MEDIA_EXT: Record<string, "animation" | "video"> = {
  gif: "animation", mp4: "video", webm: "video", mov: "video",
};
const CONFIG_FILE = "bannerTemplate.json";

const KIND_LABEL: Record<ChannelKind, string> = {
  listing: "Listing", trending: "Trending", banner: "Banner Ads", pump: "Pump alert", rankup: "Rank up",
};
const KIND_NOTE: Record<ChannelKind, string> = {
  listing: "Empty animated template — the bot draws each token's logo, $ticker, name & price/MC onto it.",
  trending: "Empty animated template — the bot draws the token's logo, $ticker, name & price/MC onto it.",
  banner: "Advertiser creative — played as-is (no token data drawn on).",
  pump: "Empty animated template — the bot draws ▲ +N%, old→new price, MCAP & the token logo/$ticker onto it (its own pump layout).",
  rankup: "Overrides the auto rank-up banner and plays above every rank-up post.",
};

export function bannerDir(): string {
  return process.env.BANNER_TEMPLATE_DIR || path.join(process.cwd(), "bot", "data");
}
const artworkPath = (kind: string) => path.join(bannerDir(), `banner-template-${kind}.png`);
const mediaPath = (kind: string, ext: string) => path.join(bannerDir(), `banner-media-${kind}.${ext}`);
const configPath = () => path.join(bannerDir(), CONFIG_FILE);

function existsNonEmpty(p: string): boolean {
  try {
    return fss.existsSync(p) && fss.statSync(p).size > 0;
  } catch {
    return false;
  }
}

/** The kind's uploaded clip (most-recently-modified among extensions), or null. */
export function clipOf(kind: string): { type: "animation" | "video"; ext: string; bytes: number; mtime: number } | null {
  let best: { type: "animation" | "video"; ext: string; bytes: number; mtime: number } | null = null;
  for (const [ext, type] of Object.entries(MEDIA_EXT)) {
    try {
      const st = fss.statSync(mediaPath(kind, ext));
      if (st.size > 0 && (!best || st.mtimeMs > best.mtime)) best = { type, ext, bytes: st.size, mtime: st.mtimeMs };
    } catch {
      /* not present */
    }
  }
  return best;
}

function loadConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fss.readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

export function postingEnabled(): boolean {
  const g = (loadConfig()._global as { enabled?: boolean } | undefined) || {};
  return typeof g.enabled === "boolean" ? g.enabled : true;
}

// Per-kind saved layout, but only when it was tuned against the current artwork
// version (else the bot ignores it — mirror that here).
function savedLayoutOf(cfg: Record<string, unknown>, kind: string): Record<string, unknown> {
  const s = cfg[kind] as Record<string, unknown> | undefined;
  return s && s.layoutVersion === LAYOUT_VERSION ? s : {};
}
/** Whether the bot draws the token $ticker/name/chips onto the clip (default on). */
export function textOverlayEnabled(kind: string): boolean {
  return savedLayoutOf(loadConfig(), kind).showText !== false;
}
export async function setTextOverlay(kind: string, on: boolean): Promise<boolean> {
  return (await setLayout(kind, { showText: !!on })).showText;
}

// ── Layout (positions the bot composites at) ────────────────────────────────
// Reference canvas the bot draws on; every coordinate is in this space.
export const REF_W = 2560;
export const REF_H = 1280;

export interface Layout {
  logoSize: number;
  logoX: number | "center";
  logoY: number | "center";
  showText: boolean;
  showChain: boolean;
  showPrice: boolean;
  showMcap: boolean;
  tickerFontSize: number;
  tickerX: number | "center";
  tickerY: number;
  tickerColor: string;
  nameFontSize: number;
  nameOffsetY: number;
  nameColor: string;
  metaFontSize: number;
  metaX: number | "center";
  metaY: number;
  // Pump-only overlay elements (▲ +N% headline · old→new price line). Optional:
  // only pump carries them; listing/trending leave them undefined.
  pctX?: number | "center";
  pctY?: number;
  pctFontSize?: number;
  priceX?: number | "center";
  priceY?: number;
  priceFontSize?: number;
}
// Mirrors bannerTemplate.js BASE_DEFAULTS (the subset the editor drives).
const BASE_LAYOUT: Layout = {
  logoSize: 420,
  logoX: 1890,
  logoY: 410,
  showText: true,
  showChain: true,
  showPrice: true,
  showMcap: true,
  tickerFontSize: 96,
  tickerX: 210,
  tickerY: 618,
  tickerColor: "#FFFFFF",
  nameFontSize: 48,
  nameOffsetY: 96,
  nameColor: "#B8CCC8",
  metaFontSize: 34,
  metaX: 210,
  metaY: 772,
};
// Persisted keys = the base layout PLUS the pump-only overlay keys (which aren't
// in BASE_LAYOUT, so only pump's saved layout carries them).
const LAYOUT_KEYS = [
  ...Object.keys(BASE_LAYOUT),
  "pctX", "pctY", "pctFontSize", "priceX", "priceY", "priceFontSize",
] as (keyof Layout)[];
// Per-kind default overrides — MUST match bannerTemplate.js KIND_DEFAULTS so the
// editor's starting positions equal what the bot actually composites.
const KIND_LAYOUT: Record<string, Partial<Layout>> = {
  trending: {
    logoX: 1890,
    logoY: 350,
    logoSize: 430,
    tickerX: 1720,
    tickerY: 920,
    tickerFontSize: 80,
    tickerColor: "#33E5C9",
    nameFontSize: 44,
    nameOffsetY: 105,
    nameColor: "#EAF6F2",
    showPrice: false,
    showMcap: false,
    metaX: 1160,
    metaY: 1120,
    metaFontSize: 34,
  },
  // Pump's own layout — mirror of bannerTemplate.js KIND_DEFAULTS.pump. The web
  // editor drives every handle: logo ring + cyan $ticker on the right, the MCAP
  // pill (metaX/Y) plus the ▲% headline (pctX/Y) and old→new price (priceX/Y) on
  // the left. showMcap stays ON so the editor shows a draggable MCAP handle;
  // chain/price chips are off (pump draws its own ▲%/price line instead).
  pump: {
    logoX: 1880,
    logoY: 360,
    logoSize: 420,
    tickerX: 1720,
    tickerY: 900,
    tickerFontSize: 84,
    tickerColor: "#33E5C9",
    nameFontSize: 44,
    nameOffsetY: 102,
    nameColor: "#EAF6F2",
    showChain: false,
    showPrice: false,
    showMcap: true,
    metaX: 262,
    metaY: 902,
    metaFontSize: 44,
    // pump-only overlay handles (mirror bannerTemplate.js KIND_DEFAULTS.pump)
    pctX: 250,
    pctY: 545,
    pctFontSize: 172,
    priceX: 262,
    priceY: 762,
    priceFontSize: 78,
  },
};

export function getLayout(kind: string): Layout {
  const saved = savedLayoutOf(loadConfig(), kind);
  const out = { ...BASE_LAYOUT, ...(KIND_LAYOUT[kind] || {}) };
  for (const k of LAYOUT_KEYS) {
    if (saved[k] !== undefined) (out as Record<string, unknown>)[k] = saved[k];
  }
  return out;
}
export async function setLayout(kind: string, patch: Partial<Layout>): Promise<Layout> {
  await ensureDir();
  const cfg = loadConfig();
  // Keep any non-position saved keys (tickerColor, glow, …); overwrite only the
  // patched position keys, and stamp the current version so the bot honours it.
  const next: Record<string, unknown> = { ...savedLayoutOf(cfg, kind) };
  for (const k of LAYOUT_KEYS) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  next.layoutVersion = LAYOUT_VERSION;
  cfg[kind] = next;
  const p = configPath();
  const tmp = `${p}.web.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
  await fs.rename(tmp, p);
  return getLayout(kind);
}

export interface ChannelBannerStatus {
  kind: ChannelKind;
  label: string;
  note: string;
  artworkable: boolean;
  fillable: boolean; // bot draws logo + $ticker/name/chips (listing/trending)
  textOverlay: boolean; // when fillable: is the auto-text drawn (vs logo-only)?
  layout: Layout; // positions the bot composites at (for the visual editor)
  hasArtwork: boolean;
  artworkMtime: number | null;
  // preview: how a browser should render the clip — a real GIF is an <img>, an
  // MP4/webm (incl. a Telegram .gif that is actually MP4) is a <video>.
  clip: { type: string; ext: string; bytes: number; mtime: number; preview: "image" | "video" } | null;
}

/** Cheap head-read to decide how the browser previews a clip. */
function clipPreviewKind(kind: string, ext: string): "image" | "video" {
  try {
    const fd = fss.openSync(mediaPath(kind, ext), "r");
    const head = Buffer.alloc(12);
    fss.readSync(fd, head, 0, 12, 0);
    fss.closeSync(fd);
    if (head.toString("ascii", 0, 4) === "GIF8") return "image";
    return "video";
  } catch {
    return ext === "gif" ? "image" : "video";
  }
}

export function statusAll(): {
  dir: string;
  writable: boolean;
  postingEnabled: boolean;
  kinds: ChannelBannerStatus[];
} {
  const dir = bannerDir();
  let writable = false;
  try {
    fss.mkdirSync(dir, { recursive: true });
    fss.accessSync(dir, fss.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  const kinds = CHANNEL_KINDS.map((kind): ChannelBannerStatus => {
    const ap = artworkPath(kind);
    let artworkMtime: number | null = null;
    try {
      const st = fss.statSync(ap);
      if (st.size > 0) artworkMtime = st.mtimeMs;
    } catch {
      /* none */
    }
    const clip = clipOf(kind);
    return {
      kind,
      label: KIND_LABEL[kind],
      note: KIND_NOTE[kind],
      artworkable: ARTWORK_KINDS.has(kind),
      fillable: FILL_KINDS.has(kind),
      textOverlay: textOverlayEnabled(kind),
      layout: getLayout(kind),
      hasArtwork: existsNonEmpty(ap),
      artworkMtime,
      clip: clip ? { ...clip, preview: clipPreviewKind(kind, clip.ext) } : null,
    };
  });
  return { dir, writable, postingEnabled: postingEnabled(), kinds };
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(bannerDir(), { recursive: true });
}

export async function saveArtwork(kind: string, buf: Buffer): Promise<void> {
  await ensureDir();
  const out = artworkPath(kind);
  const tmp = `${out}.web.${process.pid}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, out); // atomic same-name overwrite
}
export async function removeArtwork(kind: string): Promise<void> {
  await fs.unlink(artworkPath(kind)).catch(() => {});
}

export async function saveClip(kind: string, buf: Buffer, ext: string): Promise<{ type: string; ext: string; bytes: number }> {
  const e = String(ext || "mp4").toLowerCase();
  if (!MEDIA_EXT[e]) throw new Error(`unsupported media type .${e} (use gif/mp4/webm/mov)`);
  await ensureDir();
  const out = mediaPath(kind, e);
  const tmp = `${out}.web.${process.pid}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, out);
  // Exactly ONE clip per kind — drop every other-extension sibling AFTER the
  // write (mirrors the bot's hardened saveMedia so a stale ext can't win).
  for (const other of Object.keys(MEDIA_EXT)) {
    if (other === e) continue;
    await fs.unlink(mediaPath(kind, other)).catch(() => {});
  }
  return { type: MEDIA_EXT[e], ext: e, bytes: buf.length };
}
export async function removeClip(kind: string): Promise<void> {
  for (const ext of Object.keys(MEDIA_EXT)) {
    await fs.unlink(mediaPath(kind, ext)).catch(() => {});
  }
}

export async function setPostingEnabled(on: boolean): Promise<boolean> {
  await ensureDir();
  const cfg = loadConfig();
  cfg._global = { ...((cfg._global as object) || {}), enabled: !!on };
  const p = configPath();
  const tmp = `${p}.web.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
  await fs.rename(tmp, p);
  return !!on;
}

/** Sniff a clip's real container so a Telegram-sourced .gif (which actually
 *  holds MP4 bytes) still previews correctly in a browser. */
function sniffContentType(buf: Buffer, ext: string): string {
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "video/webm";
  return ext === "gif" ? "image/gif" : ext === "webm" ? "video/webm" : ext === "mov" ? "video/quicktime" : "video/mp4";
}

/** Read a kind's artwork or clip bytes for preview streaming, or null. */
export function readAsset(kind: string, type: "artwork" | "clip"): { buf: Buffer; contentType: string } | null {
  try {
    if (type === "artwork") {
      const p = artworkPath(kind);
      if (!existsNonEmpty(p)) return null;
      return { buf: fss.readFileSync(p), contentType: "image/png" };
    }
    const clip = clipOf(kind);
    if (!clip) return null;
    const buf = fss.readFileSync(mediaPath(kind, clip.ext));
    return { buf, contentType: sniffContentType(buf, clip.ext) };
  } catch {
    return null;
  }
}
