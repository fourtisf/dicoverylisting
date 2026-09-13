// Inventory rules for the homepage ad row — pure functions, no I/O, so they can
// be tested directly (lib/banners.ts wires them to the store).
//
// Two promises live here:
//   • a house banner never holds a slot a paying advertiser could use;
//   • a paid order is never REJECTED when the row is full — it is SCHEDULED for
//     the first moment a slot frees. Turning a sale away, or overbooking the row
//     and shrinking what earlier advertisers paid for, are both worse than a
//     start time the buyer is told about up front.

/** Columns in one ad row. Must match ROW_UNITS in lib/bannerRows.ts, which
 *  lays the row out — disagreement would show more ads than were booked. */
export const ROW_CAPACITY = 4;

/** Columns a slot occupies. Mirrors unitsOf() in lib/bannerRows.ts. */
export function slotUnits(slot: string): number {
  const v = String(slot || "");
  if (/standard/i.test(v)) return 1;
  if (/wide/i.test(v)) return 2;
  return ROW_CAPACITY;
}

export interface Booked {
  slot: string;
  startsAt: number;
  endsAt: number;
}

/**
 * Earliest moment ≥ `from` at which `units` fit for `durationMs` without taking
 * the row past ROW_CAPACITY. `live` is the PAID bookings only.
 *
 * Usage only changes when a booking starts or ends, so the answer is always one
 * of those instants: try `from`, then each existing end. The last candidate is
 * the latest end, where nothing overlaps at all — so this always terminates
 * with a real answer rather than failing the sale.
 */
export function earliestStartIn(live: Booked[], units: number, durationMs: number, from: number): number {
  const relevant = live.filter((b) => b.endsAt > from);
  const candidates = [from, ...relevant.map((b) => b.endsAt)].filter((t) => t >= from).sort((a, b) => a - b);
  for (const start of candidates) {
    const end = start + durationMs;
    const overlapping = relevant.filter((b) => b.startsAt < end && b.endsAt > start);
    // Check usage at every instant the picture changes inside [start, end).
    const instants = [start, ...overlapping.map((b) => b.startsAt).filter((t) => t > start && t < end)];
    const fits = instants.every((t) => {
      const used = overlapping
        .filter((b) => b.startsAt <= t && b.endsAt > t)
        .reduce((n, b) => n + slotUnits(b.slot), 0);
      return used + units <= ROW_CAPACITY;
    });
    if (fits) return start;
  }
  return from;
}

/**
 * What the homepage should show, given everything currently live: all the paid
 * bookings, then house banners only while capacity is left over. A house banner
 * is the operator's own filler, so the moment paid ads fill the row it steps
 * aside on its own — nobody has to remember to take it down.
 */
export function pickForDisplay<T extends { slot: string; source?: string }>(live: T[]): T[] {
  const paid = live.filter((b) => b.source !== "admin");
  const out = [...paid];
  let used = paid.reduce((n, b) => n + slotUnits(b.slot), 0);
  for (const h of live.filter((b) => b.source === "admin")) {
    const u = slotUnits(h.slot);
    if (used + u > ROW_CAPACITY) continue;
    out.push(h);
    used += u;
  }
  return out;
}
