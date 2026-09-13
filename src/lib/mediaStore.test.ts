import test from "node:test";
import assert from "node:assert/strict";
import { MEDIA_MAX_BYTES, saveMedia, sniffImage } from "./mediaStore.ts";

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const jpg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const gif = () => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
const webp = () => new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const bytes = (s: string) => new TextEncoder().encode(s.padEnd(16, " "));

test("the type is read from the BYTES, never from a declared one", () => {
  assert.equal(sniffImage(png()), "png");
  assert.equal(sniffImage(jpg()), "jpg");
  assert.equal(sniffImage(gif()), "gif");
  assert.equal(sniffImage(webp()), "webp");
});

test("⚠️ an SVG is refused — opened directly it is a DOCUMENT and can carry script", () => {
  assert.equal(sniffImage(bytes('<svg xmlns="http://www.w3.org/2000/svg">')), null);
  assert.equal(sniffImage(bytes("<!DOCTYPE html><html>")), null, "an HTML error page is not artwork");
  assert.equal(sniffImage(bytes("not an image at all")), null);
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50])), null, "too short to identify");
});

test("nothing that is not an image is ever written", async () => {
  assert.equal(await saveMedia(bytes("<svg/>")), null);
  assert.equal(await saveMedia(new Uint8Array(0)), null);
  // The bound is real: this file is served back to every visitor.
  assert.equal(await saveMedia(new Uint8Array(MEDIA_MAX_BYTES + 1)), null);
});
