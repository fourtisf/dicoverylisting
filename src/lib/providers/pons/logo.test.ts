import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tokenLogo } from "./logo.ts";
import { logoSrc } from "../../logo.ts";

// ⚠️ THE REPORT WAS "ini sudah ada tapi mengapa bot tidak otomatis menambahkan
// logo projectnya punya logo" — a Pons token whose artwork is on its own pad
// page, whose contract publishes it, and whose listing review card read
// `Logo: not set`. The name, the ticker and the X handle autofilled from the
// same record, so the chain reader was plainly wired in; what dropped the logo
// was this module's own https-only test, one layer above everything the bot
// does. A launchpad pins its artwork on IPFS.

test("an ipfs:// logo survives — the reported bug", () => {
  const cid = "ipfs://bafkreif3og7rosylkz34ho7mbgzdkyscslhnastl3qszh6qykfwzg6lk3m";
  assert.equal(tokenLogo(cid), cid);
  assert.equal(tokenLogo("ipfs://ipfs/bafyabc/logo.png"), "ipfs://ipfs/bafyabc/logo.png");
  assert.equal(tokenLogo("IPFS://BAFYABC"), "IPFS://BAFYABC");
});

test("http(s) still survives, and is trimmed", () => {
  assert.equal(tokenLogo("https://arweave.net/abc.png"), "https://arweave.net/abc.png");
  assert.equal(tokenLogo("  https://a/b.png  "), "https://a/b.png");
  assert.equal(tokenLogo("http://a/b.png"), "http://a/b.png");
});

test("nothing said is null, and is not an error", () => {
  assert.equal(tokenLogo(null), null);
  assert.equal(tokenLogo(""), null);
  assert.equal(tokenLogo("   "), null);
});

// `logo()` is free text written by whoever deployed the token, and anyone can
// deploy on a permissionless pad. So it stays an ALLOWLIST.
test("a scheme neither consumer can render is refused", () => {
  for (const hostile of [
    "javascript:alert(1)",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "file:///etc/passwd",
    "vbscript:x",
    "//evil.example/x.png",
    "just some text the creator typed",
    "logo.png",
  ]) {
    assert.equal(tokenLogo(hostile), null, hostile);
  }
});

// ⚠️ A JUDGEMENT, recorded so it is not rediscovered as an oversight: an
// `https://arweave.net/<txid>` logo works today (that host is on the proxy's
// allowlist), but nothing in either consumer rewrites the `ar://` URI, so
// publishing one would turn "no logo" into a broken image.
test("ar:// is refused because no consumer rewrites it", () => {
  assert.equal(tokenLogo("ar://tx"), null);
});

test("an unbounded on-chain string cannot reach a form or a listing row", () => {
  assert.equal(tokenLogo(`https://a/${"x".repeat(4000)}`), null);
  assert.equal(typeof tokenLogo(`https://a/${"x".repeat(2000)}`), "string");
});

// ⚠️ THE PROPERTY THAT MATTERS, and the one the old filter got wrong: what
// this module publishes has to be something the SITE can actually draw. A
// guard that only checked the scheme list would pass on a list nobody renders.
test("everything published reaches the image proxy, never the browser raw", () => {
  for (const raw of [
    "ipfs://bafyabc",
    "ipfs://ipfs/bafyabc/logo.png",
    "https://dd.dexscreener.com/a.png",
    "http://a/b.png",
  ]) {
    const kept = tokenLogo(raw);
    assert.equal(kept, raw);
    const src = logoSrc(kept);
    assert.ok(src?.startsWith("/api/logo?u="), `${raw} → ${src}`);
    assert.equal(decodeURIComponent(src.slice("/api/logo?u=".length)), raw);
  }
});

// One owner. The bug was a second, stricter idea of "is this a logo" sitting
// above the two consumers that already know how to render one; a third would
// put it straight back.
test("tokenLogo is the only place the pons provider judges a logo", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const read = (f: string) => strip(readFileSync(new URL(f, import.meta.url), "utf8"));

  // The reader hands every `logo()` answer to the one owner...
  const contracts = read("contracts.ts");
  assert.match(contracts, /logo:\s*tokenLogo\(/);

  // ...and no module in the provider carries a scheme test of its own. This is
  // the shape that broke: an https-only regex, one layer above everything that
  // knows how to draw an ipfs:// url.
  for (const f of ["contracts.ts", "market.ts", "launches.ts", "index.ts"]) {
    assert.equal(/https\?/.test(read(f)), false, `${f} grew its own logo scheme test`);
  }
});
