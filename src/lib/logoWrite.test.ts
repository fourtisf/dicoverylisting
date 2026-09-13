// The one write the background logo sweep may make to the public listing store.
//
// Driven for real rather than scanned: "never overwrites" is a MUTATION rule,
// and a source scan cannot tell a guard from a comment about one.
import test from "node:test";
import assert from "node:assert/strict";
import { applyLostUpload, applyResolvedLogo, type LogoRow } from "./logoWrite.ts";

const SHIB = "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce";
const rows = (): LogoRow[] => [
  { chain: "ethereum", address: SHIB },
  { chain: "ethereum", address: "0x1111111111111111111111111111111111111111", logoUrl: "https://img.example/theirs.png" },
  { chain: "base", address: SHIB },
];
const OURS = "https://img.example/ours.png";

test("a resolved logo fills a row that had none", () => {
  const out = applyResolvedLogo(rows(), "ethereum", SHIB, OURS);
  assert.equal(out.wrote, true);
  assert.equal(out.rows[0].logoUrl, OURS);
});

test("⚠️ it NEVER overwrites a logo somebody chose", () => {
  // An admin-set logo and a project's own upload are decisions; a resolved one
  // is the site filling a blank. That asymmetry is what makes this safe to call
  // from a background sweep nobody is watching.
  const out = applyResolvedLogo(rows(), "ethereum", "0x1111111111111111111111111111111111111111", OURS);
  assert.equal(out.wrote, false);
  assert.equal(out.rows[1].logoUrl, "https://img.example/theirs.png");
});

test("the address matches case-insensitively, the chain exactly", () => {
  // A checksummed address from a market provider and a lowercased one in the
  // store are the same token; the same address on two chains is two tokens.
  const upper = applyResolvedLogo(rows(), "ethereum", SHIB.toUpperCase(), OURS);
  assert.equal(upper.wrote, true);
  assert.equal(upper.rows[0].logoUrl, OURS);
  assert.equal(upper.rows[2].logoUrl, undefined, "the base row with the same address is untouched");

  const onBase = applyResolvedLogo(rows(), "base", SHIB, OURS);
  assert.equal(onBase.rows[0].logoUrl, undefined);
  assert.equal(onBase.rows[2].logoUrl, OURS);
});

test("only one row is written, even if the store somehow holds a duplicate", () => {
  const dupes: LogoRow[] = [
    { chain: "ethereum", address: SHIB },
    { chain: "ethereum", address: SHIB },
  ];
  const out = applyResolvedLogo(dupes, "ethereum", SHIB, OURS);
  assert.equal(out.rows.filter((r) => r.logoUrl).length, 1);
});

test("a url that is not an https image url is refused", () => {
  // The value lands on a public board and in the bot's channel posts.
  for (const bad of ["", "   ", "javascript:alert(1)", "http://img.example/x.png", "/api/media/x.png", "https://a b/c.png"]) {
    const out = applyResolvedLogo(rows(), "ethereum", SHIB, bad);
    assert.equal(out.wrote, false, `refused: ${bad || "(blank)"}`);
  }
});

test("a token that is not listed changes nothing at all", () => {
  const before = rows();
  const out = applyResolvedLogo(before, "ethereum", "0x9999999999999999999999999999999999999999", OURS);
  assert.equal(out.wrote, false);
  assert.equal(out.rows, before, "the same array back — nothing to persist");
});

// ── the one write that turns something into nothing ─────────────────────────

const UPLOAD = "/api/media/aaaaaaaaaaaaaaaaaaaaaaaa.png";

test("a lost upload is cleared, so the resolver's write has somewhere to land", () => {
  // While the row holds it, applyResolvedLogo stops at `r.logoUrl` and the
  // replacement can never be persisted. Two correct guards holding a dead URL
  // between them is exactly the permanent monogram this pair exists to break.
  const rows = [{ chain: "solana", address: "MiNt", logoUrl: UPLOAD }];
  const out = applyLostUpload(rows, "solana", "mint");
  assert.equal(out.wrote, true);
  assert.equal(out.rows[0].logoUrl, undefined);
  // …and now the resolver may write.
  const then = applyResolvedLogo(out.rows, "solana", "mint", "https://cdn.example/found.png");
  assert.equal(then.wrote, true);
  assert.equal(then.rows[0].logoUrl, "https://cdn.example/found.png");
});

test("⚠️ it can ONLY clear an upload — never an external logo", () => {
  // A CDN blip, a hotlink block or a rate limit are not facts about the token,
  // and none of them is knowable from this server. Clearing one would delete a
  // project's artwork over a bad minute.
  const rows = [{ chain: "solana", address: "mint", logoUrl: "https://cdn.example/real.png" }];
  const out = applyLostUpload(rows, "solana", "mint");
  assert.equal(out.wrote, false);
  assert.equal(out.rows[0].logoUrl, "https://cdn.example/real.png");
});

test("it touches one row, on the right chain, and nothing else", () => {
  const rows = [
    { chain: "ethereum", address: "0xabc", logoUrl: UPLOAD },
    { chain: "solana", address: "0xabc", logoUrl: UPLOAD },
    { chain: "solana", address: "other", logoUrl: UPLOAD },
  ];
  const out = applyLostUpload(rows, "solana", "0xABC");
  assert.equal(out.rows[0].logoUrl, UPLOAD, "same address, different chain, different token");
  assert.equal(out.rows[1].logoUrl, undefined);
  assert.equal(out.rows[2].logoUrl, UPLOAD);
});

test("a row with no logo at all is not a write", () => {
  const rows = [{ chain: "solana", address: "mint" }];
  assert.equal(applyLostUpload(rows, "solana", "mint").wrote, false);
});

test("a missing chain or address writes nothing", () => {
  const rows = [{ chain: "solana", address: "mint", logoUrl: UPLOAD }];
  assert.equal(applyLostUpload(rows, "", "mint").wrote, false);
  assert.equal(applyLostUpload(rows, "solana", "").wrote, false);
});

test("the rows array is not mutated", () => {
  const rows = [{ chain: "solana", address: "mint", logoUrl: UPLOAD }];
  applyLostUpload(rows, "solana", "mint");
  assert.equal(rows[0].logoUrl, UPLOAD);
});

// ── applyPinnedLogo: a COMPARE-AND-SWAP, never an overwrite ─────────────────
import { applyPinnedLogo } from "./logoWrite.ts";

const PIN_FROM = "https://ipfs.io/ipfs/bafybeibk74wtpsgccfehq4zatxgorv5pwfmtpy7qo7hj6kbvko5nmvokba";
const PIN_TO = "/api/media/0123456789abcdef01234567.png";
const pinRow = (logoUrl?: string, address = "BzAtM6svpCCHxjH7ZzNqBiPSm2D2v7K257damascpump") =>
  ({ chain: "solana", address, logoUrl }) as never;

test("pins when the row still holds exactly fromUrl", () => {
  const out = applyPinnedLogo([pinRow(PIN_FROM)], "solana", "BzAtM6svpCCHxjH7ZzNqBiPSm2D2v7K257damascpump", PIN_FROM, PIN_TO);
  assert.equal(out.wrote, true);
  assert.equal((out.rows[0] as { logoUrl?: string }).logoUrl, PIN_TO);
});

test("⚠️ refuses a row that now holds a DIFFERENT logo — the admin-changed race", () => {
  const rows = [pinRow("https://cdn.example/new.png")];
  const out = applyPinnedLogo(rows, "solana", "BzAtM6svpCCHxjH7ZzNqBiPSm2D2v7K257damascpump", PIN_FROM, PIN_TO);
  assert.equal(out.wrote, false);
  assert.equal(out.rows, rows, "the same array back — nothing written");
  assert.equal((rows[0] as { logoUrl?: string }).logoUrl, "https://cdn.example/new.png");
});

test("⚠️ a pin is not a FILL — a blank row is left blank", () => {
  // A blank may have been cleared on purpose; filling is applyResolvedLogo's job.
  const out = applyPinnedLogo([pinRow(undefined)], "solana", "BzAtM6svpCCHxjH7ZzNqBiPSm2D2v7K257damascpump", PIN_FROM, PIN_TO);
  assert.equal(out.wrote, false);
});

test("⚠️ toUrl must be OUR upload shape — this path may only ever point a row at our disk", () => {
  const out = applyPinnedLogo([pinRow(PIN_FROM)], "solana", "BzAtM6svpCCHxjH7ZzNqBiPSm2D2v7K257damascpump", PIN_FROM, "https://other.example/x.png");
  assert.equal(out.wrote, false);
});

test("fromUrl must be external — an upload is never re-pinned", () => {
  const out = applyPinnedLogo([pinRow(PIN_TO)], "solana", "BzAtM6svpCCHxjH7ZzNqBiPSm2D2v7K257damascpump", PIN_TO, PIN_TO);
  assert.equal(out.wrote, false);
});

test("touches only chain+address — address case-insensitive, chain exact", () => {
  const rows = [pinRow(PIN_FROM, "bzatm6svpcchxjh7zznqbipsm2d2v7k257damascpump"), pinRow(PIN_FROM, "OTHER")];
  const out = applyPinnedLogo(rows, "solana", "BzAtM6svpCCHxjH7ZzNqBiPSm2D2v7K257damascpump", PIN_FROM, PIN_TO);
  assert.equal(out.wrote, true);
  assert.equal((out.rows[0] as { logoUrl?: string }).logoUrl, PIN_TO);
  assert.equal((out.rows[1] as { logoUrl?: string }).logoUrl, PIN_FROM, "a different address is untouched");
  const wrongChain = applyPinnedLogo([pinRow(PIN_FROM)], "bsc", "BzAtM6svpCCHxjH7ZzNqBiPSm2D2v7K257damascpump", PIN_FROM, PIN_TO);
  assert.equal(wrongChain.wrote, false);
});
