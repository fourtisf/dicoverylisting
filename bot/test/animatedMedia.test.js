// A GIF/clip must reach the channel as an INLINE, playing animation — not as a
// "banner-media-rankup.gif · 783 KB" file card. Telegram decides that from
// DocumentAttributeAnimated, which GramJS never adds on its own, so the media
// TYPE has to survive all the way from the poster down to sendFile().
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-anim-"));

const test = require("node:test");
const assert = require("node:assert");

const gramjs = require("../src/gramjs");
const post = require("../src/channels/post");

const PAYLOAD = { text: "hello", entities: [{ type: "bold", offset: 0, length: 5 }] };

function harness() {
  const botCalls = [];
  post.attach({
    sendMessage: async () => ({ message_id: 1 }),
    sendPhoto: async () => ({ message_id: 2 }),
    sendAnimation: async (chat, input, extra) => {
      botCalls.push({ method: "sendAnimation", input, extra });
      return { message_id: 3 };
    },
    sendVideo: async (chat, input, extra) => {
      botCalls.push({ method: "sendVideo", input, extra });
      return { message_id: 4 };
    },
    pinChatMessage: async () => true,
  });
  return botCalls;
}

test("an animation keeps its type down to gramjs (so it can be marked animated)", async () => {
  harness();
  const seen = [];
  const realAvail = gramjs.available;
  const realSend = gramjs.sendToChannel;
  gramjs.available = () => true;
  gramjs.sendToChannel = async (chan, opts) => {
    seen.push(opts);
    return { message_id: 9 };
  };
  try {
    await post.sendMedia("@c", { type: "animation", source: "/tmp/clip.gif" }, PAYLOAD);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].mediaType, "animation", "gramjs is told this is an animation");
    await post.sendMedia("@c", { type: "video", source: "/tmp/clip.mp4" }, PAYLOAD);
    assert.strictEqual(seen[1].mediaType, "video");
    await post.sendMedia("@c", { type: "photo", source: Buffer.from("x") }, PAYLOAD);
    assert.strictEqual(seen[2].mediaType, "photo", "photos are typed too — never left undefined");
  } finally {
    gramjs.available = realAvail;
    gramjs.sendToChannel = realSend;
  }
});

test("only an animation gets DocumentAttributeAnimated", () => {
  // The real Api classes — if GramJS ever renames this, the test fails here
  // rather than silently in production as a file card.
  const { Api } = require("telegram");
  const anim = gramjs._fileAttributes("animation", Api);
  assert.ok(Array.isArray(anim) && anim.length === 1, "one attribute for an animation");
  assert.ok(anim[0] instanceof Api.DocumentAttributeAnimated, "…and it is DocumentAttributeAnimated");
  // Everything else keeps whatever GramJS derived from the file itself.
  for (const t of ["photo", "video", undefined, null, "document"]) {
    assert.strictEqual(gramjs._fileAttributes(t, Api), undefined, `${t} must not be marked animated`);
  }
});

test("bot-api fallback uses sendAnimation (never sendDocument)", async () => {
  const botCalls = harness();
  const realAvail = gramjs.available;
  gramjs.available = () => false; // force the Bot API path
  try {
    await post.sendMedia("@c", { type: "animation", source: Buffer.from("gif") }, PAYLOAD);
    assert.strictEqual(botCalls[0].method, "sendAnimation", "Telegram marks these animated server-side");
    await post.sendMedia("@c", { type: "video", source: Buffer.from("mp4") }, PAYLOAD);
    assert.strictEqual(botCalls[1].method, "sendVideo");
  } finally {
    gramjs.available = realAvail;
  }
});

// ── GIF → MP4 ───────────────────────────────────────────────────────────────
// DocumentAttributeAnimated (above) is necessary but NOT sufficient. Telegram
// autoplays a clip only when it is an MP4 — the official clients convert GIF →
// MP4 before uploading and the server never does it for us. A raw .gif sent
// over MTProto is a file card, which is what the rank-up alert looked like
// ("banner-media-rankup.gif · 783 KB") while the trending post played fine:
// trending clips go through composeOntoClip, which already outputs MP4.
const bannerTemplate = require("../src/bannerTemplate");
const { postMedia } = require("../src/fulfillment");

const ffmpegOk = (() => {
  try {
    require("fluent-ffmpeg");
    require("@ffmpeg-installer/ffmpeg");
    return true;
  } catch {
    return false;
  }
})();

// A real, tiny GIF with ODD dimensions — 321×241 would make an MP4 encoder fail
// without the even-dimension scale filter, which is a genuine way this breaks.
async function makeGif(dir) {
  const ffmpeg = require("fluent-ffmpeg");
  ffmpeg.setFfmpegPath(require("@ffmpeg-installer/ffmpeg").path);
  const out = path.join(dir, "banner-media-rankup.gif");
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input("testsrc=size=321x241:rate=10:duration=1")
      .inputFormat("lavfi")
      .outputOptions(["-t", "1"])
      .save(out)
      .on("end", resolve)
      .on("error", reject);
  });
  return out;
}

test("a .gif clip is converted to MP4 so it plays inline", async (t) => {
  if (!ffmpegOk) return t.skip("ffmpeg not installed");
  // require() succeeding doesn't mean the bundled binary RUNS — a server with a
  // different libc fails here, and that is a toolchain problem, not a red test.
  let src;
  try {
    src = await makeGif(process.env.BOT_DATA_DIR);
  } catch (e) {
    return t.skip(`ffmpeg cannot run here: ${e.message}`);
  }
  const out = await bannerTemplate.toInlineClip({ type: "animation", source: src });
  assert.match(out.source, /\.mp4$/, "the container has to change, not just the attribute");
  assert.strictEqual(out.type, "animation", "still an animation — autoplay, no player controls");
  const head = fss.readFileSync(out.source).subarray(0, 12).toString("latin1");
  assert.ok(head.includes("ftyp"), "a real MP4, not a renamed GIF");
  // Re-encoding on every alert would be wasteful; the cache is keyed on mtime.
  const again = await bannerTemplate.toInlineClip({ type: "animation", source: src });
  assert.strictEqual(again.source, out.source, "converted once, reused after");
});

test("an .mp4 clip is converted too — a video card is not a GIF", async (t) => {
  // The container was only half the problem. An upload that arrived as .mp4 was
  // sent with sendVideo, which renders a player with a play button: the viewer
  // has to tap it and it never loops. That is what "the banner ad is still a
  // file" meant. Telegram's distinction is the AUDIO TRACK, not the extension —
  // strip it, mark the document animated, and the same MP4 autoplays silently.
  if (!ffmpegOk) return t.skip("ffmpeg not installed");
  const ffmpeg = require("fluent-ffmpeg");
  ffmpeg.setFfmpegPath(require("@ffmpeg-installer/ffmpeg").path);
  const src = path.join(process.env.BOT_DATA_DIR, "banner-media-banner.mp4");
  try {
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input("testsrc=size=320x240:rate=10:duration=1")
        .inputFormat("lavfi")
        .input("sine=frequency=440:duration=1") // WITH audio — the thing to strip
        .inputFormat("lavfi")
        .outputOptions(["-t", "1", "-pix_fmt", "yuv420p"])
        .save(src)
        .on("end", resolve)
        .on("error", reject);
    });
  } catch (e) {
    return t.skip(`ffmpeg cannot run here: ${e.message}`);
  }
  const out = await bannerTemplate.toInlineClip({ type: "video", source: src });
  assert.strictEqual(out.type, "animation", "sent as an animation, not a video with controls");
  assert.notStrictEqual(out.source, src, "it must be re-encoded, not passed through");
  assert.match(out.source, /\.mp4$/);
  assert.ok(fss.readFileSync(out.source).subarray(0, 12).toString("latin1").includes("ftyp"), "a real MP4");
  // The audio strip is what makes Telegram treat it as an animation at all.
  const code = fss.readFileSync(require.resolve("../src/bannerTemplate.js"), "utf8");
  assert.ok(code.includes('"-an"'), "-an must stay in the encode options");
});

test("what cannot be converted is left exactly as it was", async () => {
  const other = { type: "photo", source: "/tmp/whatever.png" };
  assert.strictEqual(await bannerTemplate.toInlineClip(other), other, "not a clip at all");
  const missing = { type: "video", source: "/tmp/does-not-exist-xyz.mp4" };
  assert.strictEqual(await bannerTemplate.toInlineClip(missing), missing, "no file → nothing to re-encode");
  const buf = { type: "animation", source: Buffer.from("gif") };
  assert.strictEqual(await bannerTemplate.toInlineClip(buf), buf, "a Buffer has no path to convert");
  assert.strictEqual(await bannerTemplate.toInlineClip(null), null);
});

test("the Banner Ads clip carries the advertiser's creative, not just decoration", () => {
  // A banner clip used to play bare: the buyer's artwork was composited only
  // into the STILL template, so an operator who uploaded an animated frame
  // published an ad with no ad in it.
  const src = fss.readFileSync(require.resolve("../src/fulfillment.js"), "utf8");
  const i = src.indexOf('mediaOverride("banner")');
  assert.ok(i > -1, "fulfillBanner must look for an uploaded clip");
  const around = src.slice(i, i + 500);
  assert.match(around, /composeOntoClip\("banner", clip, creative/, "…and composite the creative onto it");
  assert.match(around, /falling back to the still frame/, "…with the still frame as the fallback, never a bare clip");
  // The admin preview must show the same thing, or the slot is tuned blind.
  const admin = fss.readFileSync(require.resolve("../src/admin/adminBot.js"), "utf8");
  assert.match(admin, /BT_CLIP_FILL_KINDS = new Set\(\[\.\.\.BT_FILL_KINDS, "banner"\]\)/);
});

test("the rank-up poster sends the CONVERTED clip (the actual regression)", async (t) => {
  if (!ffmpegOk) return t.skip("ffmpeg not installed");
  try {
    await makeGif(process.env.BOT_DATA_DIR); // admin-uploaded rank-up clip
  } catch (e) {
    return t.skip(`ffmpeg cannot run here: ${e.message}`);
  }
  const coin = { symbol: "$BONK", name: "Bonk", chain: "SOLANA", price: "$0.000002", mcap: "$257M" };
  const media = await postMedia("rankup", coin, null, null, "", null, { rank: 1, change: 42 });
  assert.match(media.source, /\.mp4$/, `rank-up must not post the raw .gif: ${media.source}`);
  assert.strictEqual(media.type, "animation");
});
