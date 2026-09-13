// Telegram media captions cap at 1024 chars — a longer caption made
// sendPhoto/sendVideo throw and silently dropped the banner to a text-only
// post (live incident). fitCaption() trims to fit so the image always survives.
const test = require("node:test");
const assert = require("node:assert");
const post = require("../src/channels/post");
const { fitCaption: _fitCaption } = post;

test("sendMedia passes a Buffer to Telegram as {source} (regression: banner dropped to text)", async () => {
  let captured = null;
  post.attach({
    sendPhoto: async (_c, photo) => ((captured = photo), { message_id: 1 }),
    sendMessage: async () => ({ message_id: 2 }),
    pinChatMessage: async () => {},
  });
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  await post.sendMedia("@c", { source: buf }, { text: "hi", entities: [] });
  assert.ok(captured && captured.source && Buffer.isBuffer(captured.source), "Buffer must reach Telegraf wrapped in {source}, not raw");
  // a bare file_id / URL string must still pass straight through
  captured = null;
  await post.sendMedia("@c", "file_id_123", { text: "hi", entities: [] });
  assert.strictEqual(captured, "file_id_123", "string media passes through untouched");
});

test("short captions pass through unchanged", () => {
  const p = { text: "🚀 New Listing", entities: [{ type: "bold", offset: 3, length: 11 }] };
  assert.deepStrictEqual(_fitCaption(p), p);
});

test("over-long captions are trimmed to <= 1024 with entities kept in bounds", () => {
  const long = "word ".repeat(300); // 1500 chars
  const p = {
    text: long,
    entities: [
      { type: "bold", offset: 0, length: 4 },
      { type: "code", offset: 1200, length: 4 }, // past the cut → must be dropped
    ],
  };
  const r = _fitCaption(p);
  assert.ok(r.text.length <= 1024, `trimmed length ${r.text.length}`);
  assert.ok(r.text.endsWith("…"));
  assert.ok(!r.text.match(/[\uD800-\uDBFF]$/), "never ends on a split surrogate");
  for (const e of r.entities) assert.ok(e.offset + e.length <= r.text.length, "entity in bounds");
  assert.ok(r.entities.some((e) => e.type === "bold"), "leading entity kept");
  assert.ok(!r.entities.some((e) => e.offset === 1200), "out-of-range entity dropped");
});

test("html payloads are left untouched (no entities to trim)", () => {
  const p = { text: "x".repeat(2000), html: "x".repeat(2000) };
  const r = _fitCaption(p);
  // html mode has no entities; trimming still keeps it <= 1024
  assert.ok(r.text.length <= 1024);
});
