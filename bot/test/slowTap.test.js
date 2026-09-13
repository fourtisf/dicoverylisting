// A 120s handler error that does not say WHICH BUTTON is a diagnostic about
// nothing.
//
// Reported 2026-09-07, three times in an hour:
//
//   🚨 [telegraf] callback_query handler error: Promise timed out after
//      120000 milliseconds
//
// True of all 26 registered callbacks. Every occurrence started a fresh hunt
// across the lot, and two of those hunts were guesses of mine — fulfilment had
// already been detached from that path, so it was never the cause.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-slowtap-"));

const test = require("node:test");
const assert = require("node:assert");

const SRC = fss.readFileSync(require.resolve("../src/bot.js"), "utf8");
const code = SRC.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

test("the handler-error line names the tap and how long it took", () => {
  const fn = code.slice(code.indexOf("async function onHandlerError"), code.indexOf("async function startBot"));
  assert.match(fn, /tap=\$\{tapOf\(ctx\)\}/, "the error must name which button");
  assert.match(fn, /after=/, "…and how long, because 120s means the framework killed it");
});

test("⚠️ the tap is BOT-GENERATED data, never message text", () => {
  // The import-wallet step takes a private key as a plain message. Even a
  // truncated echo of `ctx.message.text` would land in pm2's log — the rule
  // the trade bot's own router already carries a scar for.
  const fn = code.slice(code.indexOf("function tapOf"), code.indexOf("async function onHandlerError"));
  assert.match(fn, /callbackQuery/, "callback data is what identifies a tap");
  assert.ok(!/message\s*&&|\.message\.text|ctx\.message/.test(fn), "message text may never reach the log");
});

// ⚠️ THESE TWO PINNED A SPELLING, AND ONE OF THEM PINNED THE DEFECT.
//
// They used to assert the literal `[ui] slow ${ctx.updateType} tap=` and
// `if (ms >= SLOW_HANDLER_MS)` — i.e. a warning computed in the `finally`, which
// says NOTHING until the handler finishes. That is exactly the shape that left
// the 2026-09-11 outage unlogged (a Confirm tap parked on a five-minute payment
// poll; the bot answered nobody for two minutes; pm2 carried not one line), so
// the guard would have passed on the broken revision and went red over the fix.
// This repo's own recurring defect — the four-way pool-TTL guard, the
// `{ ok: true,` build stamp — on the guard for a stall.
//
// They assert the RULES now. The BEHAVIOUR lives in pollingStall.test.js, which
// drives timingMiddleware instead of reading it: a source scan cannot tell a
// warning that fires from one that is merely written down.
const mwOf = () => code.slice(code.indexOf("async function timingMiddleware"), code.indexOf("function applyMiddleware"));

test("a merely SLOW tap is reported before the framework kills it", () => {
  // Only the taps that reach handlerTimeout were ever reported, and by then
  // the promise is dead and the user has watched a spinner for two minutes.
  const mw = mwOf();
  assert.ok(mw, "the timing middleware must be findable");
  assert.match(mw, /SLOW_HANDLER_MS/, "there must be a threshold");
  assert.match(mw, /tap=\$\{tapOf\(ctx\)\}/, "…and the warning must name the tap too");
  // Silent under the threshold — a fast tap must not write a line per update
  // into a log the background loops already fill. Deliberately NOT asserted
  // here: a scan cannot tell a guarded log call from an unguarded one without a
  // regex fragile enough to go red on a reindent, and this is a MUTATION
  // property. pollingStall.test.js drives it ("a healthy handler is silent",
  // which fails if the timer is never cleared).
});

test("the timer wraps the WHOLE chain, so a hang is still measured", () => {
  // In a `finally`, not after an awaited next(): a handler that throws or is
  // killed must still be released and reported — that is the case this exists
  // for. Measured on the comment-stripped source, so the explanation above it
  // cannot make this pass on its own.
  const mw = mwOf();
  assert.match(mw, /try \{[\s\S]*return await next\(\);[\s\S]*\} finally \{/, mw);
});

test("⚠️ the stall is reported on a TIMER, not from the finally", () => {
  // The `finally` runs when the handler ENDS, and a handler that never ends is
  // the whole failure. Telegraf's polling loop does not fetch the next batch of
  // updates until every handler settles, so an unreported stall is the bot
  // answering nobody with nothing anywhere saying so.
  const mw = mwOf();
  assert.match(mw, /setTimeout\(/, "the warning must be armed before next() is awaited");
  const armed = mw.slice(0, mw.indexOf("return await next();"));
  assert.match(armed, /setTimeout\([\s\S]*SLOW_HANDLER_MS\)/, `armed before the await, not after:\n${armed}`);
  // …and cleared on the way out, or a healthy tap is reported as a stall.
  assert.match(mw.slice(mw.indexOf("} finally {")), /clearTimeout\(/, "the timer must be cleared");
});
