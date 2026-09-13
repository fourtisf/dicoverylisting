import test from "node:test";
import assert from "node:assert";

import { isUploadFile } from "./upload.ts";

// Production runs Node 18.19.1, where `File` is not a global — it became one in
// Node 20. `file instanceof File` there does not evaluate to false, it throws
// `ReferenceError: File is not defined`, so every upload route 500'd before it
// could validate anything: the admin logo uploader, the channel-banner uploader,
// and /api/internal/upload, which is how the listing bot pushes token logos to
// the site. These tests pin the shape check that replaced it.

// What `req.formData()` hands back for a file part — on Node 18 this is undici's
// own File class, which is NOT the global even when one exists.
const fileLike = (over: Record<string, unknown> = {}) => ({
  size: 1024,
  type: "image/png",
  name: "logo.png",
  arrayBuffer: async () => new ArrayBuffer(1024),
  ...over,
});

test("accepts a file-like multipart entry", () => {
  assert.equal(isUploadFile(fileLike()), true);
});

test("accepts an entry that is not an instance of the global File", () => {
  // The whole point: identity with a global class is never consulted, so a
  // different-realm or undici File still passes.
  class SomeOtherFile {
    size = 10;
    type = "image/png";
    name = "x.png";
    async arrayBuffer() {
      return new ArrayBuffer(10);
    }
  }
  assert.equal(isUploadFile(new SomeOtherFile()), true);
});

test("rejects a plain form field", () => {
  // FormData.get() returns a string for ordinary fields — the arrayBuffer check
  // is what separates a file part from a text part.
  assert.equal(isUploadFile("just-a-string"), false);
  assert.equal(isUploadFile(""), false);
});

test("rejects null and undefined", () => {
  // form.get() returns null when the field is absent entirely.
  assert.equal(isUploadFile(null), false);
  assert.equal(isUploadFile(undefined), false);
});

test("rejects an object that only looks file-ish", () => {
  assert.equal(isUploadFile({ size: 10, type: "image/png", name: "x.png" }), false, "no arrayBuffer");
  assert.equal(isUploadFile({ arrayBuffer: async () => new ArrayBuffer(0) }), false, "no size");
});

test("rejects a non-finite size", () => {
  // size gates the max-upload limit on the very next line. A NaN compares false
  // against every bound, so it would sail past the 3 MB cap.
  assert.equal(isUploadFile(fileLike({ size: NaN })), false);
  assert.equal(isUploadFile(fileLike({ size: Infinity })), false);
  assert.equal(isUploadFile(fileLike({ size: "1024" })), false, "a string size is not a size");
});

test("a zero-byte file still passes the guard", () => {
  // Empty is a real upload, rejected by the routes' own explicit size === 0
  // check with a clearer message. The guard must not pre-empt that.
  assert.equal(isUploadFile(fileLike({ size: 0 })), true);
});

test("no upload route reaches for the File global any more", async () => {
  // The regression that actually matters: reintroducing `instanceof File`
  // anywhere in the API surface breaks production again, silently, because the
  // sandbox and CI both run Node 20+ where it works fine.
  const { readFile, readdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.join(process.cwd(), "src", "app", "api");

  const walk = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(p)));
      else if (e.name.endsWith(".ts")) out.push(p);
    }
    return out;
  };

  const offenders: string[] = [];
  for (const f of await walk(root)) {
    if (/instanceof\s+File\b/.test(await readFile(f, "utf8"))) offenders.push(path.relative(process.cwd(), f));
  }
  assert.deepEqual(offenders, [], "use isUploadFile() — `File` is not a global on Node 18");
});
