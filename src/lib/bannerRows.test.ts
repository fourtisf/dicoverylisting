// Every live booking must reach the screen — that's what the advertiser paid
// for, and what /advertise promises ("Rotating homepage banner slots") — and a
// Wide must sit to the LEFT of the Standards sharing its row.
import test from "node:test";
import assert from "node:assert";
import { packBannerRows, unitsOf, slotLabel, aspectOf, ROW_UNITS } from "./bannerRows.ts";

const std = (id: string) => ({ slot: "Standard Banner", id });
const wide = (id: string) => ({ slot: "Wide Banner", id });
const house = (id: string) => ({ slot: "Homepage Banner", id }); // admin panel
const ids = (rows: { id: string }[][]) => rows.map((r) => r.map((b) => b.id));

test("column spans: Standard 1, Wide 2, anything else the whole row", () => {
  assert.strictEqual(ROW_UNITS, 4);
  assert.strictEqual(unitsOf(std("a")), 1);
  assert.strictEqual(unitsOf(wide("a")), 2);
  assert.strictEqual(unitsOf({ slot: "standard banner" }), 1, "case-insensitive — the string comes from the bot");
  // An unknown slot spans the row: the harmless failure, vs. a mystery banner
  // squeezed into a quarter column.
  for (const slot of ["Homepage Banner", "Takeover 2026", ""]) {
    assert.strictEqual(unitsOf({ slot }), ROW_UNITS, `${slot || "(empty)"} spans the row`);
  }
});

test("a Wide sits on the LEFT of the Standards sharing its row", () => {
  // Booking order is newest-first; the layout must still put the big one first.
  assert.deepStrictEqual(ids(packBannerRows([std("a"), std("b"), wide("w")])), [["w", "a", "b"]]);
  assert.deepStrictEqual(ids(packBannerRows([std("a"), wide("w")])), [["w", "a"]]);
});

test("order within the same width is preserved (newest first)", () => {
  assert.deepStrictEqual(ids(packBannerRows([std("a"), std("b"), std("c"), std("d")])), [["a", "b", "c", "d"]]);
  assert.deepStrictEqual(ids(packBannerRows([wide("w1"), wide("w2")])), [["w1", "w2"]]);
});

test("one Wide + two Standards fills a row exactly", () => {
  assert.deepStrictEqual(ids(packBannerRows([wide("w"), std("a"), std("b")])), [["w", "a", "b"]]);
});

test("an under-filled row still holds only what was booked", () => {
  // Units are flex WEIGHTS — the CSS stretches these to the full width, so a
  // lone booking runs full-bleed. Nothing is padded in here to fill the gap.
  assert.deepStrictEqual(ids(packBannerRows([std("a")])), [["a"]]);
  assert.deepStrictEqual(ids(packBannerRows([wide("w")])), [["w"]]);
});

test("nobody is dropped, whatever the mix", () => {
  for (const list of [
    [std("a")],
    [std("a"), std("b"), std("c"), std("d"), std("e")],
    [wide("w1"), wide("w2"), wide("w3")],
    [house("h"), std("a"), wide("w")],
  ]) {
    const flat = packBannerRows(list).flat();
    assert.strictEqual(flat.length, list.length, "every paid booking is laid out");
    for (const b of list) assert.ok(flat.includes(b), `${b.id} kept`);
  }
});

test("a full-row banner never shares its row", () => {
  assert.deepStrictEqual(ids(packBannerRows([house("h"), std("a")])), [["h"], ["a"]]);
});

test("no bookings → no rows (the strip renders nothing)", () => {
  assert.deepStrictEqual(packBannerRows([]), []);
});

test("a Wide can't overflow a narrower row (mobile: 1 column)", () => {
  assert.deepStrictEqual(ids(packBannerRows([wide("w"), std("a")], 1)), [["w"], ["a"]]);
});

test("slot tag names the package a visitor is looking at", () => {
  assert.strictEqual(slotLabel("Wide Banner"), "Wide");
  assert.strictEqual(slotLabel("Standard Banner"), "Standard");
  // The operator's own homepage banner isn't sold inventory — plain "Ad".
  assert.strictEqual(slotLabel("Homepage Banner"), "");
  assert.strictEqual(slotLabel(""), "");
});

test("tile ratio comes from the SOLD size, not the upload", () => {
  assert.strictEqual(aspectOf("600 × 240", "Standard Banner"), 2.5);
  assert.strictEqual(aspectOf("1200 × 240", "Wide Banner"), 5);
  assert.strictEqual(aspectOf("600x240", "Standard Banner"), 2.5, "plain x works too");
  // A legacy booking keeps the spec IT was sold at — 728 × 90 stayed a strip.
  assert.ok(Math.abs(aspectOf("728 × 90", "Standard Banner") - 728 / 90) < 1e-9);
  // Unusable size → fall back to the slot's own spec, never NaN (which would
  // collapse the tile to nothing).
  assert.strictEqual(aspectOf("", "Standard Banner"), 2.5);
  assert.strictEqual(aspectOf("carousel", "Wide Banner"), 5);
  assert.strictEqual(aspectOf("0 × 0", "Standard Banner"), 2.5);
  assert.ok(Number.isFinite(aspectOf("", "")), "an unknown slot still gets a real ratio");
});
