import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { UPLOADS_DIR } from "./uploadsDir.ts";

/**
 * THE ONE OWNER OF "these bytes become a file we serve".
 *
 * The magic-byte sniff, the 3 MB bound, the random name and the write were
 * BYTE-IDENTICAL in `/api/admin/upload` and `/api/internal/upload`, each with
 * its own comment saying so. Two copies of a rule that decides what this server
 * will store and hand back as an image is one copy too many — and the logo pin
 * below needed a third, which is what finally made it one.
 *
 * ⚠️ NEVER TRUST A DECLARED CONTENT TYPE. The type is read from the bytes, and
 * SVG is refused outright: an SVG opened directly is a DOCUMENT and can carry
 * script. `/api/logo` serves foreign SVGs inert instead, which is a different
 * trade — there, refusing would drop real artwork; here, we are choosing what
 * to keep for ever.
 */
export const MEDIA_MAX_BYTES = 3 * 1024 * 1024;

/** The real image type, from magic bytes — or null for anything else. */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return "webp";
  return null;
}

/**
 * Write bytes into the uploads directory and return the url that serves them,
 * or null when they are not an image we keep.
 *
 * The url is RELATIVE (`/api/media/<24hex>.<ext>`) and that is load-bearing:
 * an absolute `http://127.0.0.1:3005/...` was stored on public listings for a
 * month, and every consumer that recognises "one of our own uploads" matches
 * the path — see `mediaFile.ts`.
 */
export async function saveMedia(bytes: Uint8Array): Promise<{ url: string; name: string } | null> {
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MEDIA_MAX_BYTES) return null;
  const ext = sniffImage(bytes);
  if (!ext) return null;
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  const name = `${randomBytes(12).toString("hex")}.${ext}`;
  await fs.writeFile(path.join(UPLOADS_DIR, name), bytes);
  return { url: `/api/media/${name}`, name };
}
