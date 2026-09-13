import { test } from "node:test";
import assert from "node:assert/strict";
import { ponsTokenUrl, ponsExplorerUrl, PONS } from "./pons.ts";

// ⚠️ EVERY "view on Pons" LINK THIS REPO GENERATED WAS A 404, and nothing said
// so. `ponsTokenUrl` built `/token/<address>`; the pad serves its tokens from
// `/launchpad/<address>`. The path was never measured — it was assumed from the
// shape of `ponsExplorerUrl` directly beside it, which really is `/token/`, and
// that is exactly what made the guess look right.
//
// It was settled by the operator's own screenshot, address bar included:
//   https://www.ponsfamily.com/launchpad/0xfCd4CdEabe055315b1036A189eA54ca627Df390a
//
// A dead link is the quiet kind of wrong: it reaches the listing review card
// and the "🚀 Still bonding" line as ordinary blue text, so a reader who taps
// it concludes the launchpad is broken rather than that we built the url.

const WROTE = "0xfCd4CdEabe055315b1036A189eA54ca627Df390a";

test("a token's Pons page is /launchpad/<address> — the url the operator sent", () => {
  assert.equal(ponsTokenUrl(WROTE), `https://ponsfamily.com/launchpad/${WROTE}`);
});

test("⚠️ the EXPLORER is a different host AND a different path", () => {
  // Collapsing the two is how the wrong guess got here: they look alike and
  // they are not the same service.
  assert.equal(ponsExplorerUrl(WROTE), `https://robinhoodchain.blockscout.com/token/${WROTE}`);
  assert.notEqual(ponsTokenUrl(WROTE), ponsExplorerUrl(WROTE));
});

test("the path is env-overridable, so a move costs a line in .env and not a deploy", () => {
  // The contract every guessed launchpad path in this repo carries. Read at
  // module load, so this asserts the shape rather than re-importing: the value
  // must be a bare segment with no slashes, or the url grows a double slash.
  assert.equal(PONS.tokenPath, "launchpad");
  assert.ok(!PONS.tokenPath.includes("/"), "a stray slash in .env must not reach the url");
  assert.ok(!ponsTokenUrl(WROTE).includes("//launchpad"), ponsTokenUrl(WROTE));
});

test("the address is preserved verbatim — checksum casing included", () => {
  // Pons's own url carries the checksummed spelling; lowercasing it here would
  // still resolve, but a link that does not match what the pad shows is one
  // more thing for the next reader to wonder about.
  assert.ok(ponsTokenUrl(WROTE).endsWith(WROTE));
});
