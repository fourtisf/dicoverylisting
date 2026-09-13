import test from "node:test";
import assert from "node:assert/strict";
import { pinResolvedLogo, pinnable } from "./logoPin.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const OURS = "/api/media/aabbccddeeff001122334455.png";

test("only an EXTERNAL http(s) url is worth pinning", () => {
  assert.equal(pinnable("https://gateway.pinata.cloud/ipfs/bafk"), true);
  assert.equal(pinnable("http://img.example/a.png"), true);
  // ⚠️ Already ours, in EITHER spelling — the relative form and the absolute
  // localhost one that was stored on public listings for a month. `mediaPath`
  // is the one owner of that question.
  assert.equal(pinnable(OURS), false);
  assert.equal(pinnable("http://127.0.0.1:3005/api/media/aabbccddeeff001122334455.png"), false);
  // Nothing to fetch.
  assert.equal(pinnable(""), false);
  assert.equal(pinnable("ipfs://bafk"), false, "an unrewritten URI is not a url we can fetch");
});

test("a resolved logo becomes a file on our own disk", async () => {
  const seen: string[] = [];
  const out = await pinResolvedLogo("robinhood", "0xabc", "https://gateway.pinata.cloud/ipfs/bafk", {
    fetchBytes: async (u) => { seen.push(u); return PNG; },
    save: async () => ({ url: OURS }),
    commit: async (c, a, from, to) => {
      assert.equal(from, "https://gateway.pinata.cloud/ipfs/bafk", "the CAS must name the url the row still holds");
      assert.equal(to, OURS);
      return true;
    },
  });
  assert.equal(out, OURS);
  assert.deepEqual(seen, ["https://gateway.pinata.cloud/ipfs/bafk"]);
});

test("⚠️ a pin that could not be made is NEVER an error and never touches the row", async () => {
  // The row already holds a url that loaded a moment ago. Every failure here
  // leaves exactly the behaviour that shipped before the pin existed.
  let committed = 0;
  const commit = async () => { committed++; return true; };

  assert.equal(await pinResolvedLogo("x", "y", "https://a/b.png", { fetchBytes: async () => null, commit }), null);
  assert.equal(committed, 0, "a fetch that failed still reached the store");

  assert.equal(
    await pinResolvedLogo("x", "y", "https://a/b.png", { fetchBytes: async () => PNG, save: async () => null, commit }),
    null,
  );
  assert.equal(committed, 0, "bytes we refused to store were still written onto the row");
});

test("⚠️ THE CAS DECIDES. A row that moved on keeps what it moved to", async () => {
  // An admin who set a different logo between the resolve and here wins,
  // silently — that asymmetry is what makes a write nobody is watching safe.
  const out = await pinResolvedLogo("x", "y", "https://a/b.png", {
    fetchBytes: async () => PNG,
    save: async () => ({ url: OURS }),
    commit: async () => false,
  });
  assert.equal(out, null, "a refused CAS was reported as a pin");
});

test("…and a caller with no commit claims nothing", async () => {
  let saved = 0;
  const out = await pinResolvedLogo("x", "y", "https://a/b.png", {
    fetchBytes: async () => PNG,
    save: async () => { saved++; return { url: OURS }; },
  });
  assert.equal(out, null);
  assert.equal(saved, 1, "the shape is a decision the CAS makes, not one this function skips");
});

test("a url that is already ours costs nothing at all", async () => {
  let asked = 0;
  const out = await pinResolvedLogo("x", "y", OURS, {
    fetchBytes: async () => { asked++; return PNG; },
    save: async () => ({ url: OURS }),
    commit: async () => true,
  });
  assert.equal(out, null);
  assert.equal(asked, 0, "an upload was fetched and re-saved on every sweep");
});
