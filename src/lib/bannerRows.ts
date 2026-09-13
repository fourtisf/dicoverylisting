// How live banner bookings are laid out in the homepage ad row.
//
// Kept out of the component and pure because this decides WHICH paying
// advertisers are on screen: the first version rendered banners[0] only, so a
// second concurrent booking was invisible for its whole paid run. /advertise
// sells "Rotating homepage banner slots" — this is the code that has to keep
// that promise.
//
// THE GRID IS 4 UNITS WIDE:
//   Wide Banner     2 units — the big one, always on the LEFT
//   Standard Banner 1 unit  — the smaller ones, to its right
//   house banner    4 units — the operator's own, spans everything
// A 2-unit grid was tried first and it forced a Standard to half the row, which
// made it far too tall for its shape. Four units is the layout the rest of the
// market uses (one big + two small), and it is why the sold sizes are 2.5:1 for
// a Standard and 5:1 for a Wide — both land ~145px tall on the real grid.

export interface BannerLike {
  slot: string;
}

/** Columns in one ad row. */
export const ROW_UNITS = 4;

const isStandard = (slot: string) => /standard/i.test(slot || "");
const isWide = (slot: string) => /wide/i.test(slot || "");

/** Columns this booking occupies. An unknown slot spans the full row — the
 *  harmless failure, vs. a mystery banner squeezed into a quarter. */
export function unitsOf(b: BannerLike): number {
  const slot = b.slot || "";
  if (isStandard(slot)) return 1;
  if (isWide(slot)) return 2;
  return ROW_UNITS;
}

/**
 * Aspect ratio the TILE is drawn at — taken from the size that was SOLD
 * ("600 × 240"), not from whatever the advertiser happened to upload. Two
 * advertisers uploading different shapes would otherwise produce a ragged row
 * of mismatched heights; keyed off the spec, every booking of the same slot
 * lines up, and an off-spec upload is cropped to fit rather than deciding the
 * layout. Falls back to the slot's own spec when the string is unusable.
 */
export function aspectOf(size: string, slot: string): number {
  const m = String(size || "").match(/(\d+)\s*[×x]\s*(\d+)/);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w > 0 && h > 0) return w / h;
  }
  const u = unitsOf({ slot });
  return u === 1 ? 600 / 240 : u === 2 ? 1200 / 240 : 1440 / 240;
}

/** Short public label for a slot: "Wide" / "Standard", or "" for the operator's
 *  own homepage banner (which isn't sold inventory, so it gets a plain "Ad"). */
export function slotLabel(slot: string): string {
  if (isWide(slot)) return "Wide";
  if (isStandard(slot)) return "Standard";
  return "";
}

/**
 * Pack bookings into rows of ROW_UNITS. Widest first, so a Wide always sits on
 * the LEFT of the Standards sharing its row — the arrangement the operator
 * asked for and the one every comparable site runs. Sort is stable, so within
 * the same width the store's order (newest first) is preserved.
 *
 * Rows past the first are paged through on a timer, so every booking is shown
 * regardless of how many are live at once.
 */
export function packBannerRows<T extends BannerLike>(list: T[], unitsPerRow = ROW_UNITS): T[][] {
  const ordered = [...list].sort((a, b) => unitsOf(b) - unitsOf(a));
  const rows: T[][] = [];
  let row: T[] = [];
  let used = 0;
  for (const b of ordered) {
    const u = Math.min(unitsOf(b), unitsPerRow);
    if (used + u > unitsPerRow) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(b);
    used += u;
  }
  if (row.length) rows.push(row);
  return rows;
}

