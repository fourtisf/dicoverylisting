// WHERE AN UPLOADED LOGO LIVES — one owner, because three files declared it.
//
// `/api/admin/upload`, `/api/internal/upload` and `/api/media/[name]` each held
// their own `path.join(process.cwd(), "data", "uploads")`. Three copies of one
// path is how a write lands somewhere a read does not look, and it matters more
// now: the board asks "is this uploaded logo still on disk?" and answers a row
// with no artwork when it is not. A reader pointed at the wrong directory would
// report EVERY paid listing's logo as lost.
//
// ⚠️ IT DOES NOT HONOUR `DATA_DIR`, DELIBERATELY. `store.ts` does
// (`process.env.DATA_DIR || cwd/data`), so on a box that sets it the listings
// and the uploads already live apart — and they have since uploads existed.
// Teaching this path about DATA_DIR would move where the app LOOKS without
// moving the files, which turns every existing upload on such a box into a 404
// in one deploy. Moving them is a migration with an operator behind it, not a
// side effect of a logo fix.
import path from "node:path";
import { promises as fs } from "node:fs";

export const UPLOADS_DIR = path.join(process.cwd(), "data", "uploads");

/** The file names currently in the uploads directory.
 *
 *  ⚠️ THROWS when the directory cannot be read, and that is the contract: an
 *  unmounted volume and an empty directory answer very differently, and
 *  `lostUploads` needs the difference — "could not look" must never render as
 *  "everything has been deleted". A missing directory (ENOENT) IS an empty
 *  one: nothing has ever been uploaded on this box. */
export async function listUploads(): Promise<string[]> {
  try {
    return await fs.readdir(UPLOADS_DIR);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw e;
  }
}
