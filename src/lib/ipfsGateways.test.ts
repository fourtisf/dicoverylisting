import test from "node:test";
import assert from "node:assert/strict";
import { IPFS_GATEWAYS, ipfsCandidates, ipfsPath } from "./ipfsGateways.ts";

const CID = "bafybeibk74wtpsgccfehq4zatxgorv5pwfmtpy7qo7hj6kbvko5nmvokba";

test("ipfsPath reads both spellings and nothing else", () => {
  assert.equal(ipfsPath(`ipfs://${CID}`), CID);
  assert.equal(ipfsPath(`ipfs://ipfs/${CID}/logo.png`), `${CID}/logo.png`);
  assert.equal(ipfsPath(`https://ipfs.io/ipfs/${CID}`), CID);
  assert.equal(ipfsPath("https://dd.dexscreener.com/ds-data/tokens/solana/x.png"), null);
  assert.equal(ipfsPath(""), null);
});

test("⚠️ pump.fun's own pin is in the DEFAULT ladder, first or second", () => {
  // The caller's url is slot one at the proxy, so the pin has to be within the
  // first entries that differ from it — the $GG flip was this list without it.
  const idx = IPFS_GATEWAYS.indexOf("https://pump.mypinata.cloud/ipfs/");
  assert.ok(idx >= 0 && idx <= 1, `found at ${idx}: ${IPFS_GATEWAYS.join(", ")}`);
});

test("candidates: the caller's own gateway first, then the ladder, no duplicates, bounded", () => {
  const own = `https://dweb.link/ipfs/${CID}`;
  const c = ipfsCandidates(own);
  assert.equal(c[0], own, "a working gateway must not be demoted by the list");
  assert.equal(new Set(c).size, c.length, "dweb.link appears once — it is in the ladder too");
  assert.deepEqual(ipfsCandidates(`ipfs://${CID}`, 2), IPFS_GATEWAYS.slice(0, 2).map((g) => g + CID));
  for (const u of ipfsCandidates(`ipfs://${CID}`)) assert.match(u, /^https:\/\/[^/]+\/ipfs\//);
});

test("a non-IPFS url has NO ladder — a CDN 404 is an answer about the token", () => {
  assert.deepEqual(ipfsCandidates("https://dd.dexscreener.com/ds-data/tokens/solana/x.png"), []);
  assert.deepEqual(ipfsCandidates("not a url"), []);
});
