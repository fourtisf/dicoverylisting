// Inventory rules for the homepage ad row. Two promises are being kept here:
// a house banner must never hold a slot a paying advertiser could use, and a
// paid order must never be REJECTED when the row is full — it gets scheduled.
import test from "node:test";
import assert from "node:assert";
import { slotUnits, ROW_CAPACITY, earliestStartIn, pickForDisplay, type Booked } from "./bannerSchedule.ts";

test("slot units match the layout (bannerRows.ts must agree)", () => {
  assert.strictEqual(ROW_CAPACITY, 4);
  assert.strictEqual(slotUnits("Standard Banner"), 1);
  assert.strictEqual(slotUnits("Wide Banner"), 2);
  assert.strictEqual(slotUnits("standard banner"), 1, "case-insensitive");
  // Anything else takes the row: the harmless failure for an unknown slot.
  assert.strictEqual(slotUnits("Homepage Banner"), ROW_CAPACITY);
  assert.strictEqual(slotUnits(""), ROW_CAPACITY);
});

test("a full row is exactly one Wide plus two Standards", () => {
  const used = slotUnits("Wide Banner") + slotUnits("Standard Banner") + slotUnits("Standard Banner");
  assert.strictEqual(used, ROW_CAPACITY);
});

const HOUR = 3_600_000;
const now = 1_700_000_000_000;
const paid = (slot: string, startsAt: number, endsAt: number): Booked => ({ slot, startsAt, endsAt });

test("scheduling: starts now while capacity is free", () => {
  // A Wide (2 units) is running; 2 units are free.
  const live = [paid("Wide Banner", now - HOUR, now + 3 * HOUR)];
  assert.strictEqual(earliestStartIn(live, 1, HOUR, now), now, "a Standard fits alongside it");
  assert.strictEqual(earliestStartIn(live, 2, HOUR, now), now, "so does another Wide — 2 + 2 = 4");
});

test("scheduling: a full row queues the order instead of rejecting it", () => {
  const live = [paid("Wide Banner", now - HOUR, now + 3 * HOUR)];
  // 4 units can't fit beside a live Wide — wait for it to end.
  assert.strictEqual(earliestStartIn(live, 4, HOUR, now), now + 3 * HOUR);
});

test("scheduling: waits for the FIRST slot to free, not the longest run", () => {
  const live = [
    paid("Wide Banner", now, now + 168 * HOUR), // a week
    paid("Standard Banner", now, now + 24 * HOUR),
    paid("Standard Banner", now, now + 48 * HOUR),
  ];
  const start = earliestStartIn(live, 1, HOUR, now);
  assert.strictEqual(start, now + 24 * HOUR, "the first Standard ends first");
  assert.ok(Number.isFinite(start), "always answers with a time — a paid order is never turned away");
});

test("scheduling: a booking that only fits AFTER an overlap is pushed past it", () => {
  // Free now, but a Wide starts in an hour — a 3h Standard booked now would
  // collide, so it has to wait rather than be cut short.
  const live = [paid("Wide Banner", now + HOUR, now + 5 * HOUR), paid("Wide Banner", now + HOUR, now + 5 * HOUR)];
  assert.strictEqual(earliestStartIn(live, 1, 3 * HOUR, now), now + 5 * HOUR);
});

test("display: a house banner yields the moment paid ads fill the row", () => {
  const house = { slot: "Homepage Banner", source: "admin", id: "h" };
  const wide = { slot: "Wide Banner", source: "bot", id: "w" };
  const std = { slot: "Standard Banner", source: "bot", id: "s" };
  // Nothing sold → the house banner shows.
  assert.deepStrictEqual(pickForDisplay([house]).map((b) => b.id), ["h"]);
  // A Wide is sold: the house banner needs all 4 columns, so it steps aside.
  assert.deepStrictEqual(pickForDisplay([wide, house]).map((b) => b.id), ["w"]);
  // Paid ads always come first in the list.
  assert.deepStrictEqual(pickForDisplay([house, wide, std]).map((b) => b.id), ["w", "s"]);
});

test("display: paid bookings are never dropped", () => {
  const rows = [
    { slot: "Wide Banner", source: "bot", id: "w" },
    { slot: "Standard Banner", source: "bot", id: "a" },
    { slot: "Standard Banner", source: "bot", id: "b" },
  ];
  assert.deepStrictEqual(pickForDisplay(rows).map((b) => b.id), ["w", "a", "b"]);
});
