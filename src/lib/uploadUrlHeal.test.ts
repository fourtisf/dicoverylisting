import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { healUploadUrls } from "./logoWrite.ts";

// A data/listings.json written by the old bot keeps its absolute-localhost
// upload urls for ever; reading is the one place every row passes through, so
// that is where they are healed — beside healSeedLogos, at BOTH load sites.
const HEX = "0123456789abcdef01234567";
const row = (logoUrl: string | undefined) =>
  ({ id: "x", chain: "solana", address: "A", name: "A", sym: "A", logoUrl }) as never;

test("heal-on-read rewrites the old absolute spelling to the relative one, and counts", () => {
  const rows = [
    row(`http://127.0.0.1:3005/api/media/${HEX}.png`),
    row(`/api/media/${HEX}.png`),
    row("https://ipfs.io/ipfs/bafk"),
    row(undefined),
  ];
  const n = healUploadUrls(rows);
  assert.equal(n, 1, "only the row stored the old way is touched");
  assert.equal((rows[0] as { logoUrl?: string }).logoUrl, `/api/media/${HEX}.png`);
  assert.equal((rows[1] as { logoUrl?: string }).logoUrl, `/api/media/${HEX}.png`, "already right — untouched");
  assert.equal((rows[2] as { logoUrl?: string }).logoUrl, "https://ipfs.io/ipfs/bafk", "an external logo is never rewritten");
  assert.equal((rows[3] as { logoUrl?: string }).logoUrl, undefined);
});

test("⚠️ it runs at BOTH load sites, beside healSeedLogos", () => {
  // The seed heal has two call sites for a reason (a fresh load and a Mongo
  // restore); a heal wired to one of them leaves the other path unhealed.
  const src = readFileSync(new URL("./store.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const seed = (src.match(/healSeedLogos\(cache\);/g) ?? []).length;
  const heal = (src.match(/healUploadUrls\(cache\);/g) ?? []).length;
  assert.equal(seed, 2, "precondition: the precedent has two load sites");
  assert.equal(heal, seed, "the upload heal runs everywhere the seed heal does");
});
