// Once-only delivery: the dedupe budget must never be spent before the message
// exists, and a dead group must stop being retried.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-latch-"));

const test = require("node:test");
const assert = require("node:assert");
const latch = require("../src/group/alertLatch");
const { isFatalChatError, describeChatError } = require("../src/group/fatalChatError");
const mon = require("../src/group/buyMonitor");

const CHAT = "-1001";
const TX = "0xdeadbeef";

const payload = { text: "buy!", entities: [] };

test.beforeEach(() => latch._reset());

// ── fatal vs transient ───────────────────────────────────────────────────────

test("a removed / muted bot is FATAL", () => {
  for (const m of [
    "Bad Request: chat not found",
    "Forbidden: bot was kicked from the supergroup chat",
    "Forbidden: bot was blocked by the user",
    "Bad Request: not enough rights to send text messages to the chat",
    "Bad Request: CHAT_WRITE_FORBIDDEN",
    "Bad Request: group chat was upgraded to a supergroup chat",
  ]) {
    assert.strictEqual(isFatalChatError(new Error(m)), true, m);
  }
  assert.strictEqual(isFatalChatError({ code: 403, message: "Forbidden" }), true);
});

test("a bad moment is TRANSIENT — and when in doubt we retry rather than drop", () => {
  for (const m of [
    "429: Too Many Requests: retry after 12",
    "socket hang up",
    "ETIMEDOUT",
    "Bad Gateway",
    "500 Internal Server Error",
    "some error nobody has seen before",
  ]) {
    assert.strictEqual(isFatalChatError(new Error(m)), false, m);
  }
  assert.strictEqual(isFatalChatError({ code: 429 }), false);
  assert.strictEqual(isFatalChatError(null), false);
});

test("a 429 whose text happens to contain a fatal phrase is still transient", () => {
  // Order matters in the matcher: transient wins, because a wrong latch loses a
  // real alert while a wrong retry only costs a request.
  assert.strictEqual(isFatalChatError(new Error("Too Many Requests — chat not found in cache")), false);
});

test("describeChatError names the reason for the log line", () => {
  assert.match(describeChatError(new Error("Bad Request: chat not found")), /chat not found/);
});

// ── claim / commit / release ─────────────────────────────────────────────────

test("a claim is exclusive, and a committed tx can never alert again", async () => {
  assert.strictEqual(latch.claim(CHAT, TX), true);
  assert.strictEqual(latch.claim(CHAT, TX), false, "a second poll cannot claim the same tx");
  await latch.commit(CHAT, TX);
  assert.strictEqual(latch.claim(CHAT, TX), false);
  assert.strictEqual(latch.isDelivered(CHAT, TX), true);
});

test("releasing hands the claim back so the next poll retries", async () => {
  assert.strictEqual(latch.claim(CHAT, TX), true);
  await latch.release(CHAT, TX);
  assert.strictEqual(latch.claim(CHAT, TX), true);
  assert.strictEqual(latch.isDelivered(CHAT, TX), false);
});

test("the same tx in two different groups is two independent alerts", () => {
  assert.strictEqual(latch.claim("-100A", TX), true);
  assert.strictEqual(latch.claim("-100B", TX), true);
});

test("an expired claim is reclaimable — a crash mid-send costs a duplicate, never a hole", () => {
  assert.strictEqual(latch.claim(CHAT, TX, 1000), true);
  assert.strictEqual(latch.claim(CHAT, TX, 1000 + latch.CLAIM_MS - 1), false);
  assert.strictEqual(latch.claim(CHAT, TX, 1000 + latch.CLAIM_MS + 1), true);
});

// ── deliver() ────────────────────────────────────────────────────────────────

const tgOk = (calls) => ({
  sendMessage: async (chatId, text) => {
    calls.push(chatId);
    void text;
    return { message_id: 42 };
  },
});

test("a delivered alert latches", async () => {
  const calls = [];
  assert.strictEqual(await mon.deliver(tgOk(calls), CHAT, payload, TX), true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(latch.isDelivered(CHAT, TX), true);
});

test("a 429 does NOT latch — the alert is still wanted, and the next poll sends it", async () => {
  let attempts = 0;
  const flaky = {
    sendMessage: async () => {
      attempts++;
      if (attempts === 1) throw new Error("429: Too Many Requests: retry after 3");
      return { message_id: 7 };
    },
  };
  assert.strictEqual(await mon.deliver(flaky, CHAT, payload, TX), false);
  assert.strictEqual(latch.isDelivered(CHAT, TX), false, "spending the budget here loses the alert silently");
  assert.strictEqual(await mon.deliver(flaky, CHAT, payload, TX), true);
  assert.strictEqual(attempts, 2);
});

test("Telegram answering without a message_id does not latch either", async () => {
  const empty = { sendMessage: async () => undefined };
  assert.strictEqual(await mon.deliver(empty, CHAT, payload, TX), false);
  assert.strictEqual(latch.isDelivered(CHAT, TX), false);
});

test("a dead group DOES latch — retrying it forever burns everyone's rate budget", async () => {
  let attempts = 0;
  const dead = {
    sendMessage: async () => {
      attempts++;
      throw new Error("Forbidden: bot was kicked from the supergroup chat");
    },
  };
  assert.strictEqual(await mon.deliver(dead, CHAT, payload, TX), false);
  assert.strictEqual(latch.isDelivered(CHAT, TX), true);
  assert.strictEqual(await mon.deliver(dead, CHAT, payload, TX), false);
  assert.strictEqual(attempts, 1, "the second call never reached Telegram");
});

test("two overlapping polls send exactly one message for one transaction", async () => {
  let sends = 0;
  const slow = {
    sendMessage: async () => {
      sends++;
      await new Promise((r) => setTimeout(r, 20));
      return { message_id: 1 };
    },
  };
  const [a, b] = await Promise.all([
    mon.deliver(slow, CHAT, payload, TX),
    mon.deliver(slow, CHAT, payload, TX),
  ]);
  assert.strictEqual(sends, 1);
  assert.deepStrictEqual([a, b].sort(), [false, true]);
});

test("the alert is not RENDERED for a transaction already delivered", async () => {
  // With a `>=` block cursor a quiet pool re-reads its newest block on every
  // poll, so an already-delivered buy would otherwise be re-rendered for every
  // group every 25 seconds, forever.
  let renders = 0;
  const build = () => {
    renders++;
    return payload;
  };
  const calls = [];
  await mon.deliver(tgOk(calls), CHAT, build, TX);
  await mon.deliver(tgOk(calls), CHAT, build, TX);
  assert.strictEqual(renders, 1);
  assert.strictEqual(calls.length, 1);
});

test("a transiently-failed alert IS re-rendered and re-sent next poll", async () => {
  // The regression this guards: an in-memory 'already seen' set in front of the
  // latch skipped exactly this retry, so a 429 lost the alert entirely.
  let renders = 0;
  let attempts = 0;
  const flaky = {
    sendMessage: async () => {
      attempts++;
      if (attempts === 1) throw new Error("Bad Gateway");
      return { message_id: 3 };
    },
  };
  const build = () => {
    renders++;
    return payload;
  };
  assert.strictEqual(await mon.deliver(flaky, CHAT, build, TX), false);
  assert.strictEqual(await mon.deliver(flaky, CHAT, build, TX), true);
  assert.strictEqual(renders, 2);
});

test("a doomed send is retried a bounded number of times, then given up on", async () => {
  // Permanent for the MESSAGE but not for the chat — an admin saving an empty
  // template, or one whose HTML will not parse. fatalChatError rightly calls it
  // transient, so without a cap it is a doomed send every poll forever; and
  // because an undelivered buy holds the pool cursor back, the group would stop
  // receiving anything at all.
  let attempts = 0;
  const broken = {
    sendMessage: async () => {
      attempts++;
      throw new Error("400: Bad Request: can't parse entities");
    },
  };
  for (let i = 0; i < latch.MAX_ATTEMPTS + 3; i++) await mon.deliver(broken, CHAT, payload, TX);
  assert.strictEqual(attempts, latch.MAX_ATTEMPTS);
  assert.strictEqual(latch.isDelivered(CHAT, TX), true, "latched so the cursor is freed");
});

test("a removed bot mutes the whole chat, so the ESTIMATED path stops too", async () => {
  // deliver(..., null) skips every per-transaction latch call by design, so
  // without a chat-level mute a kicked group was retried on every poll forever
  // whenever the feed happened to be down.
  let sends = 0;
  const dead = {
    sendMessage: async () => {
      sends++;
      throw new Error("Forbidden: bot was kicked from the supergroup chat");
    },
  };
  assert.strictEqual(await mon.deliver(dead, CHAT, payload, null), false);
  assert.strictEqual(latch.isChatMuted(CHAT), true);
  for (let i = 0; i < 5; i++) await mon.deliver(dead, CHAT, payload, null);
  assert.strictEqual(sends, 1, "no further attempts on the estimated path either");
  // And the real path is suppressed for that chat as well.
  assert.strictEqual(await mon.deliver(dead, CHAT, payload, "0xanother"), false);
  assert.strictEqual(sends, 1);
});

test("muting one chat never silences another", async () => {
  const calls = [];
  await latch.muteChat("-100DEAD");
  assert.strictEqual(await mon.deliver(tgOk(calls), "-100DEAD", payload, null), false);
  assert.strictEqual(await mon.deliver(tgOk(calls), "-100LIVE", payload, null), true);
  assert.strictEqual(calls.length, 1);
});

test("the estimated path claims nothing — a made-up key would fake deduplication", async () => {
  const calls = [];
  assert.strictEqual(await mon.deliver(tgOk(calls), CHAT, payload, null), true);
  assert.strictEqual(await mon.deliver(tgOk(calls), CHAT, payload, null), true);
  assert.strictEqual(calls.length, 2);
});
