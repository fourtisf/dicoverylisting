// Resilient Telegram file download: retry on transient "fetch failed", a clear
// message for the 20 MB Bot API ceiling, and the real transport cause surfaced.
const test = require("node:test");
const assert = require("node:assert");

// adminBot needs a token to build the bot, but we only touch the exported helper.
process.env.ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "test:token";
const { fetchTelegramFileBuffer } = require("../src/admin/adminBot")._net;

const tg = { getFileLink: async () => ({ href: "https://api.telegram.org/file/botX/clip.gif" }) };

function withFetch(fn, body) {
  const orig = global.fetch;
  global.fetch = fn;
  return Promise.resolve()
    .then(body)
    .finally(() => { global.fetch = orig; });
}

test("retries a transient 'fetch failed' then succeeds", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      if (calls < 3) {
        const e = new TypeError("fetch failed");
        e.cause = { code: "ECONNRESET" };
        throw e;
      }
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode("CLIP").buffer };
    },
    async () => {
      const buf = await fetchTelegramFileBuffer(tg, "fid", { timeoutMs: 500, tries: 3 });
      assert.strictEqual(buf.toString(), "CLIP");
      assert.strictEqual(calls, 3, "should have retried twice before succeeding");
    },
  );
});

test("gives up after N tries and surfaces the real transport cause", async () => {
  await withFetch(
    async () => {
      const e = new TypeError("fetch failed");
      e.cause = { code: "ENOTFOUND" };
      throw e;
    },
    async () => {
      await assert.rejects(
        () => fetchTelegramFileBuffer(tg, "fid", { timeoutMs: 300, tries: 2 }),
        (e) => /ENOTFOUND/.test(e.message) && /2 tries/.test(e.message),
      );
    },
  );
});

test("a too-big file yields a clear 20 MB message (not a bare error)", async () => {
  const tgBig = { getFileLink: async () => { throw new Error("400: Bad Request: file is too big"); } };
  await assert.rejects(
    () => fetchTelegramFileBuffer(tgBig, "fid", { tries: 1 }),
    (e) => /20 MB/.test(e.message),
  );
});

test("an HTTP error status is retried and reported", async () => {
  await withFetch(
    async () => ({ ok: false, status: 504 }),
    async () => {
      await assert.rejects(
        () => fetchTelegramFileBuffer(tg, "fid", { timeoutMs: 300, tries: 2 }),
        (e) => /HTTP 504/.test(e.message),
      );
    },
  );
});
