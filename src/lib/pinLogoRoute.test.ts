import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The route cannot be loaded by node:test (Next), so its contract is a
// comment-stripped scan: it gates on internalAuthorized, it writes through the
// CAS (store.pinLogo → applyPinnedLogo), and it never reaches for
// updateListing — which writes unconditionally and would re-fill a logo an
// admin had just cleared.
const src = readFileSync(new URL("../app/api/internal/listings/pin-logo/route.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

test("pin-logo is authenticated and writes only through the CAS", () => {
  assert.match(src, /internalAuthorized\(req\)/);
  assert.match(src, /unauthorizedInternal\(\)/);
  assert.match(src, /pinLogo\(chain, address, fromUrl, toUrl\)/);
  assert.ok(!/updateListing/.test(src), "never the unconditional PATCH write");
  assert.ok(!/setResolvedLogo/.test(src), "and not the fill either — a pin is not a fill");
});

test("store.pinLogo runs the CAS inside mutate, the shape of setResolvedLogo", () => {
  const store = readFileSync(new URL("./store.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const body = store.slice(store.indexOf("export async function pinLogo("), store.indexOf("export async function setResolvedLogo("));
  assert.match(body, /await mutate\(/, "one atomic edit against the live rows and the mirror");
  assert.match(body, /applyPinnedLogo\(rows, chain, address, fromUrl, toUrl\)/);
});
