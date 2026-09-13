// postMedia end-to-end — pins the bug that shipped raw-logo channel posts for
// days: POST_BANNERS was defined in constants but never EXPORTED, so
// fulfillment's `const { POST_BANNERS } = require(constants)` was undefined and
// the whole banner pipeline silently never ran (no .env value could fix it).
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-pm-"));
// leave BANNER_BUNDLED_DIR unset — the committed bundled artwork must resolve

const test = require("node:test");
const assert = require("node:assert");

test("constants EXPORTS POST_BANNERS (regression: defined but not exported)", () => {
  const constants = require("../src/config/constants");
  assert.ok(
    Object.prototype.hasOwnProperty.call(constants, "POST_BANNERS"),
    "POST_BANNERS missing from module.exports — banner pipeline silently disables",
  );
  assert.strictEqual(typeof constants.POST_BANNERS, "boolean");
});

test("postingEnabled defaults true and postMedia returns TEMPLATE ARTWORK", async () => {
  const bt = require("../src/bannerTemplate");
  assert.strictEqual(bt.postingEnabled(), true, "banners must default ON");

  const { postMedia } = require("../src/fulfillment");
  const cv = require("@napi-rs/canvas");
  const c = cv.createCanvas(256, 256);
  const g = c.getContext("2d");
  g.fillStyle = "#f59e0b";
  g.fillRect(0, 0, 256, 256);
  const logo = c.toBuffer("image/png");

  const media = await postMedia(
    "listing",
    { symbol: "TEST", name: "Test Token", chain: "SOLANA", price: "$0.01", mcap: "$1M" },
    logo,
    null,
    null,
    "Xpress Listing",
  );
  assert.ok(media && media.source && Buffer.isBuffer(media.source), "expected composed artwork Buffer, got raw-logo fallback");
  // Compositor produced the artwork, not a passthrough logo. The encoder emits
  // PNG normally but re-encodes oversized banners to JPEG (Telegram size guard),
  // so accept either PNG or JPEG magic.
  const magic = media.source.readUInt32BE(0);
  const isPng = magic === 0x89504e47;
  const isJpeg = (magic & 0xffffff00) >>> 0 === 0xffd8ff00;
  assert.ok(isPng || isJpeg, `expected PNG or JPEG artwork, got magic 0x${magic.toString(16)}`);
});

test("admin toggle OFF really disables the banner pipeline", async () => {
  const bt = require("../src/bannerTemplate");
  const { postMedia } = require("../src/fulfillment");
  await bt.setPostingEnabled(false);
  try {
    const media = await postMedia("listing", { symbol: "T" }, null, "file123", null, null);
    assert.strictEqual(media, "file123", "OFF must fall through to the raw logo file_id");
  } finally {
    await bt.setPostingEnabled(true);
  }
});
