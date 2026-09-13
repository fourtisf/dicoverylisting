// ⚠️ THE DETECTOR THAT COULD NOT DETECT.
//
// Telegraf's long-polling loop is, verbatim (telegraf 4.16.3,
// lib/core/network/polling.js):
//
//     for await (const updates of this)
//       await Promise.all(updates.map(handleUpdate));
//
// It does not ask Telegram for the next batch of updates until every handler in
// the current one has settled. So a handler that hangs is not one slow tap — it
// is the whole bot going deaf, for every user in every chat.
//
// bot.js had a slow-handler warning for this, and it logged from the `finally`
// — so it said NOTHING until the handler finished, and the one shape worth
// catching is precisely the one that does not. Through the reported outage on
// 2026-09-11 (a Confirm tap parked on a five-minute payment poll; three /start
// messages unanswered) pm2 carried not one line about it. A stuck symptom
// reading as no symptom is the state that looks most like a healthy one.
process.env.SLOW_HANDLER_MS = "1000"; // frozen at require time, and at its floor

const test = require("node:test");
const assert = require("node:assert");

const log = require("../src/helpers/logger");
// timingMiddleware is exported on its own for the reason onHandlerError is:
// applyMiddleware boots every background service and its timers, and the test
// process would never exit.
const { timingMiddleware, SLOW_HANDLER_MS } = require("../src/bot");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = () => ({ updateType: "callback_query", chat: { id: 1 }, from: { id: 1 }, callbackQuery: { data: "confirm_pay" } });

function capture(t) {
  const orig = log.warn;
  t.after(() => (log.warn = orig));
  const warns = [];
  log.warn = (m) => warns.push(String(m));
  return warns;
}

test("the stall is reported WHILE the handler is still stuck, not after it ends", async (t) => {
  const warns = capture(t);
  let release;
  const stuck = new Promise((r) => (release = r));

  const run = timingMiddleware(ctx(), () => stuck);
  await sleep(SLOW_HANDLER_MS + 400);

  // On the old code this is empty: nothing is logged until the handler returns,
  // which in the real incident was two minutes later — or never.
  assert.strictEqual(warns.length, 1, `expected a warning while stuck, got:\n${warns.join("\n")}`);
  assert.match(warns[0], /STILL RUNNING/, warns[0]);
  // The wording IS the diagnosis. "one tap is slow" sends the reader to that
  // handler; the truth is that nobody is being answered at all.
  assert.match(warns[0], /not answering ANY chat/i, warns[0]);
  // Which tap — bot-generated callback data only, never message text.
  assert.match(warns[0], /confirm_pay/, warns[0]);

  release();
  await run;
  assert.strictEqual(warns.length, 2, "a stall that ended must be sized, or nobody can tell how long it lasted");
  assert.match(warns[1], /released after/, warns[1]);
});

test("a healthy handler is silent", async (t) => {
  const warns = capture(t);
  await timingMiddleware(ctx(), async () => "done");
  assert.deepStrictEqual(warns, [], "a fast tap must not write a line per update");
  // …and it must not warn LATER either: a timer left running would report a
  // handler that finished in milliseconds as a stall.
  await sleep(SLOW_HANDLER_MS + 300);
  assert.deepStrictEqual(warns, [], `the timer must be cleared on the way out:\n${warns.join("\n")}`);
});

test("a handler that THREW is still released, and still reported", async (t) => {
  const warns = capture(t);
  let release;
  const stuck = new Promise((_, rej) => (release = rej));
  const run = timingMiddleware(ctx(), () => stuck).catch(() => "threw");
  await sleep(SLOW_HANDLER_MS + 300);
  assert.strictEqual(warns.length, 1, "the stall is reported regardless of how it ends");
  release(new Error("boom"));
  assert.strictEqual(await run, "threw", "the error still reaches bot.catch");
  assert.match(warns[1] || "", /released after/, "and the release line still lands");
});
