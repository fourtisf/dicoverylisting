// Pins the Telegram banner size-guard (413 "Request Entity Too Large" incident
// 2026-07-20): a heavy composited banner must never be sent as an oversized PNG.
const test = require("node:test");
const assert = require("node:assert");
const cv = require("@napi-rs/canvas");

// Re-require encodeImage with specific env (it reads its thresholds at load).
function fresh(env = {}) {
  const p = require.resolve("../src/helpers/encodeImage");
  delete require.cache[p];
  for (const k of Object.keys(env)) process.env[k] = env[k];
  const mod = require(p);
  for (const k of Object.keys(env)) delete process.env[k];
  return mod;
}
const isPng = (b) => b.readUInt32BE(0) === 0x89504e47;
const isJpeg = (b) => ((b.readUInt32BE(0) & 0xffffff00) >>> 0) === 0xffd8ff00;

test("small banner stays crisp PNG", () => {
  const { toSendBuffer } = fresh();
  const c = cv.createCanvas(240, 240);
  const g = c.getContext("2d");
  g.fillStyle = "#0af";
  g.fillRect(0, 0, 240, 240);
  assert.ok(isPng(toSendBuffer(c)), "small banner should remain PNG");
});

test("oversized banner re-encodes to JPEG under the Telegram ceiling", () => {
  // Force the PNG path over the limit with a tiny threshold.
  const { toSendBuffer } = fresh({ BANNER_PNG_MAX_BYTES: "128", BANNER_MAX_BYTES: "10485760" });
  const c = cv.createCanvas(320, 320);
  const g = c.getContext("2d");
  g.fillStyle = "#123456";
  g.fillRect(0, 0, 320, 320);
  const out = toSendBuffer(c);
  assert.ok(isJpeg(out), "oversized banner should convert to JPEG");
  assert.ok(out.length < 10 * 1024 * 1024, "must be under Telegram's 10 MB sendPhoto limit");
});
