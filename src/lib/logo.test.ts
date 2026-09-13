import test from "node:test";
import assert from "node:assert/strict";
import { logoSrc } from "./logo.ts";

test("same-origin and inline sources are left alone", () => {
  assert.equal(logoSrc("/api/media/x.png"), "/api/media/x.png");
  assert.equal(logoSrc("data:image/png;base64,AAA"), "data:image/png;base64,AAA");
});

test("nothing in, nothing out — never the string 'null'", () => {
  assert.equal(logoSrc(null), undefined);
  assert.equal(logoSrc(undefined), undefined);
  assert.equal(logoSrc("   "), undefined);
});

test("an external image goes through our proxy", () => {
  assert.equal(logoSrc("https://dd.dexscreener.com/a.png"), "/api/logo?u=https%3A%2F%2Fdd.dexscreener.com%2Fa.png");
});

test("⚠️ an ipfs:// URI goes to the proxy too, instead of to a browser that cannot load it", () => {
  // A launchpad's on-chain metadata gives exactly this, and no <img> anywhere
  // loads the scheme — so a token whose artwork we HAD still drew a monogram.
  assert.equal(logoSrc("ipfs://bafyabc/logo.png"), "/api/logo?u=ipfs%3A%2F%2Fbafyabc%2Flogo.png");
});

test("⚠️ a protocol-relative //host/x.png is a stranger's server, not ours", () => {
  // It starts with a slash, so the "same-origin" branch used to hand it
  // straight to the browser — the one shape that looks local and is not.
  assert.equal(logoSrc("//cdn.example/x.png"), "/api/logo?u=https%3A%2F%2Fcdn.example%2Fx.png");
});

test("⚠️ our OWN upload in its absolute spelling is same-origin, never proxied", () => {
  // Sent to the proxy it 400s (non-https, host not allowlisted) and the row
  // draws a monogram over a file on this disk. See mediaPath.
  const rel = "/api/media/0123456789abcdef01234567.png";
  assert.equal(logoSrc(`http://127.0.0.1:3005${rel}`), rel);
  assert.equal(logoSrc(`https://dexvra.io${rel}`), rel);
  // …while a stranger's server that merely copies our path shape still is.
  assert.equal(
    logoSrc(`https://evil.example${rel}`),
    `/api/logo?u=${encodeURIComponent(`https://evil.example${rel}`)}`,
  );
});
