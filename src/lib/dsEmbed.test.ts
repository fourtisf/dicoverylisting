// DexScreener's own chart, as the LAST RESORT — with its watermark on it.
// "kalo misal apikey gecko terminal limit ganti dexscreener gpp ada watermark."
import test from "node:test";
import assert from "node:assert/strict";
import { dsEmbedUrl } from "./dsEmbed.ts";
import { CHAINS } from "../config/chains.ts";

test("a covered chain gets an embeddable URL for the TOKEN, not a pair", () => {
  const url = String(dsEmbedUrl("solana", "5m8k6jHhYFZkiL8FVLFtiu1EEki6HiTbQvLADoUbTJAA"));
  assert.match(url, /^https:\/\/dexscreener\.com\/solana\/5m8k6jHhYFZkiL8FVLFtiu1EEki6HiTbQvLADoUbTJAA\?/);
  // Their nav and header off, so the panel carries a chart and not a whole site.
  assert.match(url, /embed=1/);
  assert.match(url, /info=0/);
  assert.match(url, /trades=0/);
});

test("⚠️ NULL for a chain DexScreener does not index — never a constructed URL", () => {
  // Framing a chain it has never heard of shows DexScreener's own "not found"
  // inside our panel, which reads as OUR page being broken and is worse than
  // the honest apology it replaces.
  assert.equal(dsEmbedUrl("no-such-chain", "0xabc"), null);
  // …and the rule reads the registry rather than a second list that would
  // drift: whatever chain the registry says is uncovered must answer null.
  const uncovered = Object.keys(CHAINS).find((c) => !CHAINS[c].dexscreener);
  if (uncovered) assert.equal(dsEmbedUrl(uncovered, "0xabc"), null, `${uncovered} has no DS slug`);
});

test("a missing address is null, not a URL pointing at the chain's front page", () => {
  assert.equal(dsEmbedUrl("solana", ""), null);
});

test("the address is ENCODED — a token id is not always URL-safe", () => {
  assert.match(String(dsEmbedUrl("solana", "a/b?c")), /\/a%2Fb%3Fc\?/);
});

test("the DS slug is used, not our own chain key", () => {
  // Our key and DexScreener's can differ (`sei` → `seiv2` is the scar that
  // made every Sei token read as "no market data"), so the registry decides.
  for (const [key, c] of Object.entries(CHAINS)) {
    if (!c.dexscreener) continue;
    assert.ok(
      String(dsEmbedUrl(key, "0xabc")).startsWith(`https://dexscreener.com/${c.dexscreener}/`),
      `${key} must embed as ${c.dexscreener}`,
    );
  }
});
