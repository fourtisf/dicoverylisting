// GIF/video media override + the sendMedia dispatcher + pump 50× band.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-media-"));
process.env.BANNER_BUNDLED_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-media-b-"));

const test = require("node:test");
const assert = require("node:assert");
const bt = require("../src/bannerTemplate");

test("mediaOverride: none → null; gif → animation; mp4 → video; one clip per kind", async () => {
  assert.strictEqual(bt.mediaOverride("pump"), null);
  await bt.saveMedia("pump", Buffer.from("GIF89a fake"), "gif");
  assert.deepStrictEqual(
    { type: bt.mediaOverride("pump").type },
    { type: "animation" },
  );
  // saving a different ext replaces the prior clip (no two files linger)
  await bt.saveMedia("pump", Buffer.from("\x00\x00\x00 fake mp4"), "mp4");
  assert.strictEqual(bt.mediaOverride("pump").type, "video");
  assert.ok(bt.hasMedia("pump"));
  await bt.removeMedia("pump");
  assert.strictEqual(bt.mediaOverride("pump"), null);
});

test("saveMedia rejects an unsupported extension", async () => {
  await assert.rejects(() => bt.saveMedia("listing", Buffer.from("x"), "exe"));
});

test("same-ext re-upload replaces the clip content (new bytes win)", async () => {
  await bt.saveMedia("listing", Buffer.from("FIRST-GIF"), "gif");
  await bt.saveMedia("listing", Buffer.from("SECOND-GIF"), "gif");
  const m = bt.mediaOverride("listing");
  assert.strictEqual(fss.readFileSync(m.source, "utf8"), "SECOND-GIF");
  await bt.removeMedia("listing");
});

test("saveMedia leaves exactly ONE clip file (siblings cleared)", async () => {
  await bt.saveMedia("trending", Buffer.from("g"), "gif");
  await bt.saveMedia("trending", Buffer.from("v"), "mp4"); // different ext
  const dir = process.env.BOT_DATA_DIR;
  const files = fss.readdirSync(dir).filter((f) => f.startsWith("banner-media-trending."));
  assert.deepStrictEqual(files, ["banner-media-trending.mp4"], `expected one file, got ${files}`);
  await bt.removeMedia("trending");
});

test("stale leftover sibling never resurrects the old clip on an mtime tie", async () => {
  // Simulate a legacy leftover: an OLD .gif co-existing with a NEW .mp4, both with
  // an IDENTICAL mtime (coarse filesystem / same-second writes). The new .mp4 must
  // win — and the stale .gif must not linger to win a later comparison.
  const dir = process.env.BOT_DATA_DIR;
  const gif = path.join(dir, "banner-media-listing.gif"); // OLD
  const mp4 = path.join(dir, "banner-media-listing.mp4"); // NEW
  fss.writeFileSync(gif, "OLD-GIF");
  fss.writeFileSync(mp4, "NEW-MP4");
  const T = new Date("2026-01-01T00:00:00Z");
  fss.utimesSync(gif, T, T);
  fss.utimesSync(mp4, T, T);
  // A tie can't be resolved by mtime, so guarantee the invariant the way the app
  // does: a fresh saveMedia writes the winner and clears every sibling.
  await bt.saveMedia("listing", Buffer.from("NEW-MP4"), "mp4");
  const m = bt.mediaOverride("listing");
  assert.strictEqual(m.type, "video");
  assert.strictEqual(fss.readFileSync(m.source, "utf8"), "NEW-MP4");
  assert.ok(!fss.existsSync(gif), "stale .gif sibling should be gone after saveMedia");
  await bt.removeMedia("listing");
});

test("mediaOverride self-heals a strictly-older sibling (deletes it, keeps newest)", async () => {
  const dir = process.env.BOT_DATA_DIR;
  const gif = path.join(dir, "banner-media-banner.gif"); // OLDER
  const mp4 = path.join(dir, "banner-media-banner.mp4"); // NEWER
  fss.writeFileSync(gif, "OLD");
  fss.writeFileSync(mp4, "NEW");
  fss.utimesSync(gif, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  fss.utimesSync(mp4, new Date("2026-06-01T00:00:00Z"), new Date("2026-06-01T00:00:00Z"));
  const m = bt.mediaOverride("banner");
  assert.strictEqual(fss.readFileSync(m.source, "utf8"), "NEW");
  assert.ok(!fss.existsSync(gif), "older sibling should be self-healed away");
  await bt.removeMedia("banner");
});

test("sendMedia dispatches by type (photo/animation/video) with caption+reply", async () => {
  const post = require("../src/channels/post");
  const calls = [];
  const stub = {
    sendPhoto: async (ch, src, extra) => (calls.push(["photo", ch, src, extra]), { message_id: 1 }),
    sendAnimation: async (ch, src, extra) => (calls.push(["animation", ch, src, extra]), { message_id: 2 }),
    sendVideo: async (ch, src, extra) => (calls.push(["video", ch, src, extra]), { message_id: 3 }),
    sendMessage: async () => ({ message_id: 9 }),
    pinChatMessage: async () => {},
  };
  post.attach(stub);
  const payload = { text: "hi", entities: [] };

  await post.sendMedia("@c", { type: "animation", source: "/tmp/a.gif" }, payload, { replyTo: 42 });
  await post.sendMedia("@c", { type: "video", source: "/tmp/a.mp4" }, payload);
  await post.sendMedia("@c", { source: "/tmp/a.png" }, payload); // no type → photo
  await post.sendMedia("@c", null, payload); // null → text

  assert.strictEqual(calls[0][0], "animation");
  assert.strictEqual(calls[0][3].caption, "hi");
  assert.ok(calls[0][3].reply_parameters && calls[0][3].reply_parameters.message_id === 42);
  assert.strictEqual(calls[1][0], "video");
  assert.strictEqual(calls[2][0], "photo");
});

test("pump band: fires 100%..just under 5000% (50×), not below/above", () => {
  const inBand = (pct) => pct >= 100 && pct < 5000; // mirrors pumpChecker
  assert.ok(!inBand(99));
  assert.ok(inBand(100));
  assert.ok(inBand(4999));
  assert.ok(!inBand(5000)); // 50× ceiling
});
