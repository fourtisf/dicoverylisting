// Telegram's own rate limit, which is a different thing from the indexer's.
//
// THE FAILURE: "buy clip failed for -100… (429: Too Many Requests: retry after
// 99)". A poll posting eight buys re-uploaded the SAME clip file eight times,
// to the same group, inside a second — `{ source }` is a fresh multipart upload
// every call. Telegram answered 429, and for those 99 seconds the group got
// nothing while buys were plainly landing on the chart.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
const dir = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-flood-"));
process.env.BOT_DATA_DIR = dir;

const test = require("node:test");
const assert = require("node:assert");
const mon = require("../src/group/buyMonitor");
const bt = require("../src/bannerTemplate");
const latch = require("../src/group/alertLatch");

const CLIP = path.join(dir, "clip.mp4");
fss.writeFileSync(CLIP, "not really an mp4, but it has an mtime");

function withClip(fn) {
  const realOverride = bt.mediaOverride;
  const realInline = bt.toInlineClip;
  bt.mediaOverride = () => ({ type: "animation", source: CLIP });
  bt.toInlineClip = async (m) => m;
  return Promise.resolve(fn()).finally(() => {
    bt.mediaOverride = realOverride;
    bt.toInlineClip = realInline;
  });
}

test("the clip file crosses the wire ONCE, then it is a file_id", async () => {
  await withClip(async () => {
    const seen = [];
    const tg = {
      sendAnimation: async (_chat, media) => {
        seen.push(media);
        return { message_id: 1, animation: { file_id: "AgADdexvra123" } };
      },
      sendMessage: async () => ({ message_id: 1 }),
    };
    for (let i = 0; i < 4; i++) await mon.sendAlert(tg, -1001, "buy", {}, "buy");
    assert.strictEqual(seen.length, 4, "four alerts went out");
    assert.ok(seen[0] && seen[0].source, "the first one uploads the file");
    for (const m of seen.slice(1)) {
      assert.strictEqual(m, "AgADdexvra123", "every one after it is the file_id");
    }
  });
});

test("a stale file_id is forgotten so the next alert re-uploads", async () => {
  // Telegram expires them, and a re-upload changes them. Caching one for good
  // would fail every alert forever on a reference to something that is gone.
  await withClip(async () => {
    let calls = 0;
    const tg = {
      sendAnimation: async (_chat, media) => {
        calls++;
        if (typeof media === "string") throw new Error("400: wrong file identifier");
        return { message_id: 1, animation: { file_id: "AgADfresh" } };
      },
      sendMessage: async () => ({ message_id: 9 }),
    };
    await mon.sendAlert(tg, -1002, "buy", {}, "buy"); // uploads, caches
    await mon.sendAlert(tg, -1002, "buy", {}, "buy"); // file_id → rejected, forgotten
    const before = calls;
    await mon.sendAlert(tg, -1002, "buy", {}, "buy"); // uploads again
    assert.ok(calls > before, "it tried the media path again rather than giving up on artwork");
  });
});

test("a 429 is honoured for exactly as long as Telegram asks", async () => {
  // Retrying inside the window does not merely fail, it RESETS the window — so
  // a bot that retries every poll can stay locked out while every buy it was
  // holding ages out and is dropped.
  latch._reset && latch._reset();
  let sends = 0;
  const flood = Object.assign(new Error("429: Too Many Requests: retry after 60"), {
    parameters: { retry_after: 60 },
  });
  const tg = {
    sendMessage: async () => {
      sends++;
      throw flood;
    },
  };
  const first = await mon.deliver(tg, -1003, "buy", "0xtx1");
  assert.strictEqual(first, false, "not delivered");
  assert.strictEqual(sends, 1);
  // A DIFFERENT buy, same chat, straight after: it must not even be attempted.
  const second = await mon.deliver(tg, -1003, "buy", "0xtx2");
  assert.strictEqual(second, false);
  assert.strictEqual(sends, 1, "the second alert never reached Telegram");
});

test("a rate-limited buy stays wanted — the latch does not swallow it", async () => {
  // If the claim were left standing, the retry would be deduped against a
  // message that was never sent, and the buy would be lost silently.
  latch._reset && latch._reset();
  const flood = Object.assign(new Error("429"), { parameters: { retry_after: 1 } });
  let attempts = 0;
  const tg = {
    sendMessage: async () => {
      attempts++;
      if (attempts === 1) throw flood;
      return { message_id: 5 };
    },
  };
  assert.strictEqual(await mon.deliver(tg, -1004, "buy", "0xtxA"), false);
  await new Promise((r) => setTimeout(r, 1100)); // the window Telegram asked for
  assert.strictEqual(await mon.deliver(tg, -1004, "buy", "0xtxA"), true, "the same buy is still deliverable");
});
