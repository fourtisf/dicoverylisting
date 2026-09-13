// Two failure modes that showed up in the live pm2 log and left the USER with
// nothing to go on:
//   WARN  [start] setMyCommands failed: connect ETIMEDOUT …:443
//   ERROR [telegraf] message handler error: Promise timed out after 120000 ms
// The first used to run once, so a blip meant no command menu until the next
// restart. The second was logged and nothing else — the person who tapped the
// button just saw silence.
const test = require("node:test");
const assert = require("node:assert");
// onHandlerError is exported on its own so this can be tested WITHOUT calling
// applyMiddleware — that boots the background services and their timers, and
// the test process would never exit.
const { setCommandsWithRetry, onHandlerError } = require("../src/bot");

test("setMyCommands is retried, and reports success after a transient failure", async () => {
  let calls = 0;
  const bot = {
    telegram: {
      setMyCommands: async () => {
        calls++;
        if (calls < 3) throw new Error("connect ETIMEDOUT 2001:67c:4e8:f004::9:443");
        return true;
      },
    },
  };
  assert.strictEqual(await setCommandsWithRetry(bot, 4, 1), true);
  assert.strictEqual(calls, 3, "kept trying instead of giving up on the first blip");
});

test("setMyCommands gives up quietly rather than blocking the boot", async () => {
  let calls = 0;
  const bot = {
    telegram: {
      setMyCommands: async () => {
        calls++;
        throw new Error("connect ETIMEDOUT");
      },
    },
  };
  assert.strictEqual(await setCommandsWithRetry(bot, 3, 1), false);
  assert.strictEqual(calls, 3, "bounded — a dead network can't loop forever");
});

test("a failed handler tells the user something went wrong", async () => {
  const replies = [];
  let answered = null;
  const ctx = {
    updateType: "callback_query",
    chat: { id: 1 },
    callbackQuery: { id: "q" },
    answerCbQuery: async (text) => {
      answered = text;
    },
    reply: async (text) => {
      replies.push(text);
      return { message_id: 1 };
    },
  };
  await onHandlerError(new Error("Promise timed out after 120000 milliseconds"), ctx);
  assert.ok(answered, "the spinner on the button is cleared");
  assert.strictEqual(replies.length, 1, `exactly one notice, got ${replies.length}`);
  assert.match(replies[0], /went wrong/i);
  assert.match(replies[0], /nothing was charged/i, "money is the first thing a buyer worries about");
});

test("the error notice never throws a second time", async () => {
  const ctx = {
    updateType: "message",
    chat: { id: 1 },
    reply: async () => {
      throw new Error("Bad Request: chat not found");
    },
  };
  await assert.doesNotReject(() => onHandlerError(new Error("boom"), ctx));
});
