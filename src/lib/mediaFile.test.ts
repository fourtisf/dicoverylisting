import test from "node:test";
import assert from "node:assert/strict";
import { isLostUpload, lostUploads, mediaName } from "./mediaFile.ts";

const A = "/api/media/aaaaaaaaaaaaaaaaaaaaaaaa.png";
const B = "/api/media/bbbbbbbbbbbbbbbbbbbbbbbb.webp";
const EXTERNAL = "https://dd.dexscreener.com/ds-data/tokens/solana/x.png";

const reader = (names: string[]) => ({ list: async () => names });
const broken = { list: async (): Promise<string[]> => { throw new Error("EACCES"); } };

test("mediaName reads our own upload shape and nothing else", () => {
  assert.equal(mediaName(A), "aaaaaaaaaaaaaaaaaaaaaaaa.png");
  assert.equal(mediaName(EXTERNAL), null);
  assert.equal(mediaName("data:image/png;base64,x"), null);
  assert.equal(mediaName(""), null);
  assert.equal(mediaName(null), null);
  // Traversal, a wrong length, an unknown extension — the media route would
  // 404 all three, so treating one as an upload we own would be a false claim.
  assert.equal(mediaName("/api/media/../../etc/passwd"), null);
  assert.equal(mediaName("/api/media/abc.png"), null);
  assert.equal(mediaName("/api/media/aaaaaaaaaaaaaaaaaaaaaaaa.svg"), null);
});

test("an upload whose file is gone is reported lost", async () => {
  const lost = await lostUploads([A, B], reader(["bbbbbbbbbbbbbbbbbbbbbbbb.webp"]));
  assert.equal(isLostUpload(lost, A), true);
  assert.equal(isLostUpload(lost, B), false);
});

test("an upload that is still there is not", async () => {
  const lost = await lostUploads([A], reader(["aaaaaaaaaaaaaaaaaaaaaaaa.png"]));
  assert.equal(isLostUpload(lost, A), false);
});

test("an EXTERNAL logo is never reported lost", async () => {
  // Whether a CDN answers is not knowable from this server, and a bad minute
  // must never delete a project's artwork. Only our own disk is a local fact.
  const lost = await lostUploads([EXTERNAL, "ipfs://cid/logo.png", "", A], reader([]));
  assert.equal(isLostUpload(lost, EXTERNAL), false);
  assert.equal(isLostUpload(lost, "ipfs://cid/logo.png"), false);
  assert.equal(isLostUpload(lost, A), true, "…while the upload beside them still is");
});

test("⚠️ a directory that cannot be READ reports nothing missing", async () => {
  // An unmounted volume, a permissions change, a container mid-restore: all
  // answer identically, and reading that as "every uploaded logo was deleted"
  // would strip the artwork off every paid listing on the site in one sweep.
  const lost = await lostUploads([A, B], broken);
  assert.equal(isLostUpload(lost, A), false, "could not look is not everything is gone");
  assert.equal(isLostUpload(lost, B), false);
});

test("…but an EMPTY directory does report them, which is the case being healed", async () => {
  // A box restored from the Mongo mirror has every row and no uploads. That is
  // the state the whole module exists for, so it must not be confused with the
  // unreadable one above.
  const lost = await lostUploads([A, B], reader([]));
  assert.equal(isLostUpload(lost, A), true);
  assert.equal(isLostUpload(lost, B), true);
});

test("it asks the directory ONCE, however many rows there are", async () => {
  let calls = 0;
  const counting = { list: async () => { calls++; return []; } };
  await lostUploads(Array.from({ length: 200 }, (_, i) => `/api/media/${String(i).padStart(24, "0").replace(/[^0-9]/g, "0")}.png`), counting);
  assert.equal(calls, 1, "one readdir, not one stat per row");
});

test("no upload in the list means no syscall at all", async () => {
  let calls = 0;
  const counting = { list: async () => { calls++; return []; } };
  const lost = await lostUploads([EXTERNAL, undefined, null], counting);
  assert.equal(calls, 0);
  assert.equal(lost.size, 0);
});

test("⚠️ ONE normaliser, so a caller cannot miss a row by asking differently", async () => {
  // The first cut returned trimmed URLs and the caller asked with the raw store
  // value: `lost.has(row.logoUrl)` was false for exactly the rows this module
  // exists to find, and the test written for it asserted the mismatch rather
  // than catching it. Both sides go through `mediaName` now, so spacing, case
  // and the caller's spelling cannot separate them.
  const lost = await lostUploads([`  ${A}  `], reader([]));
  assert.equal(isLostUpload(lost, A), true);
  assert.equal(isLostUpload(lost, `  ${A}  `), true);
  assert.equal(isLostUpload(lost, A.toUpperCase().replace("/API/MEDIA/", "/api/media/")), true);
});

// ── TWO SPELLINGS OF ONE UPLOAD ──────────────────────────────────────────────
//
// The bot's api.uploadImage returned `${DEXVRA_API_BASE}${url}` — an ABSOLUTE
// `http://127.0.0.1:3005/api/media/<hex>.png` — while its call site's comment
// said "relative", and the row was stored that way for a month. Nothing here
// recognised it: logoSrc proxied it, /api/logo refused the host, the browser
// drew a monogram over artwork on this disk, and isLostUpload could never heal
// it. `mediaPath` is the one owner that reads both.
import { mediaPath } from "./mediaFile.ts";

const HEX = "0123456789abcdef01234567";
const REL = `/api/media/${HEX}.png`;

test("⚠️ an own-origin ABSOLUTE upload url is ours, in every spelling this box produces", () => {
  assert.equal(mediaPath(`http://127.0.0.1:3005${REL}`), REL, "what the old uploader stored");
  assert.equal(mediaPath(`http://localhost:3005${REL}`), REL);
  assert.equal(mediaPath(`https://dexvra.io${REL}`), REL, "the public origin");
  assert.equal(mediaPath(`https://www.dexvra.io${REL}`), REL);
  assert.equal(mediaPath(`http://127.0.0.1${REL}`), REL, "port is not part of the identity");
  // …and mediaName reads through it, so isLostUpload heals those rows too.
  assert.equal(mediaName(`http://127.0.0.1:3005${REL}`), `${HEX}.png`);
});

test("⚠️ a FOREIGN host with our path is NOT an upload — it must keep going to the proxy", () => {
  // Recognising the path alone would let anyone hand the site a "same-origin"
  // url that is nothing of the kind.
  assert.equal(mediaPath(`https://evil.example${REL}`), null);
  assert.equal(mediaPath(`https://dd.dexscreener.com${REL}`), null);
  assert.equal(mediaPath(`//dexvra.io${REL}`), null, "protocol-relative is a stranger's server");
  assert.equal(mediaName(`https://evil.example${REL}`), null);
});

test("the relative form is unchanged and case-folded to what the media route serves", () => {
  assert.equal(mediaPath(REL), REL);
  assert.equal(mediaPath(`/api/media/${HEX.toUpperCase()}.PNG`), REL);
  assert.equal(mediaPath(`https://ipfs.io/ipfs/bafk`), null, "an external logo is never an upload");
  assert.equal(mediaPath(""), null);
  assert.equal(mediaPath(null), null);
});
