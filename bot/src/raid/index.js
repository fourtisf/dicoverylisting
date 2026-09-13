// Raid handler registration.
//
// ORDER MATTERS. This runs BEFORE the main handler bundle, because
// handlers/registry.js ends with terminal `bot.on("text")` and media routers
// that would eat the panel's answers. Every handler here calls next() unless it
// actually consumed the update — the raid rides on the group's message stream,
// it does not own it.
const panel = require("./panel");
const runner = require("./runner");
const log = require("../helpers/logger");

function registerRaidHandlers(bot) {
  bot.command("raid", (ctx) => panel.showPanel(ctx));
  bot.action(/^dr_[a-z]+$/, (ctx) => panel.handleCallback(ctx));

  // Pin service notices ("Dexvra pinned a message"). Always passes through:
  // auto-enrolment and every other group pipeline must still see the update.
  bot.on("message", async (ctx, next) => {
    if (ctx.message && ctx.message.pinned_message) {
      await runner.handlePinned(ctx).catch((e) => log.debug(`[raid] pin cleanup: ${e && e.message}`));
    }
    return next();
  });

  bot.on("text", async (ctx, next) => {
    try {
      if (await panel.handleText(ctx)) return; // consumed
    } catch (e) {
      log.debug(`[raid] text handler: ${e && e.message}`);
    }
    return next();
  });

  // Media counts as showing up too — a raid is about who turned out, and a
  // sticker is as much a presence as a sentence.
  bot.on(["photo", "sticker", "animation", "video", "voice", "video_note"], (ctx, next) => {
    panel.maybeAutoEnroll(ctx);
    return next();
  });

  log.info("[raid] handlers registered");
  return bot;
}

module.exports = { registerRaidHandlers };
