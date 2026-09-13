// Central handler registration. Regex actions keep the callback-data scheme
// compact (see menu.js) and avoid per-chain/per-plan enumeration. The free-text
// + photo routers are registered LAST so specific actions always win first.
const start = require("./start");
const listing = require("./listing");
const trending = require("./trending");
const banner = require("./banner");
const massdm = require("./massdm");
const groupSetup = require("../group/setup");
const text = require("./text");
const payment = require("../payments/payment");
const pay = require("./pay");
const { registerRaidHandlers } = require("../raid");
const { RAID_ENABLED } = require("../config/constants");
const log = require("../helpers/logger");

function registerHandlers(bot) {
  // ── Dexvra Raid (FIRST) ───────────────────────────────────────────────────
  // Must be registered before the terminal `bot.on("text")` / media routers at
  // the bottom of this function, which would otherwise eat the raid panel's
  // answers and starve auto-enrolment. Every raid handler calls next() unless
  // it actually consumed the update.
  if (RAID_ENABLED) registerRaidHandlers(bot);

  // Added to a group → ask for the permissions the bot actually uses. Placed
  // before the command handlers so it is obvious this rides a DIFFERENT update
  // type (my_chat_member) and cannot be starved by the text routers below.
  bot.on("my_chat_member", (ctx, next) => {
    start.botAddedToGroup(ctx).catch((e) => log.debug(`[group] add greeting: ${e && e.message}`));
    return next(); // other pipelines still need this update
  });

  // ── Commands ──────────────────────────────────────────────────────────────
  bot.start(start.startHandler);
  bot.command("home", start.homeHandler);
  bot.command("menu", start.homeHandler);
  bot.help((ctx) => {
    if (ctx.chat && ctx.chat.type !== "private") return start.groupStart(ctx); // group → buy-bot setup
    return ctx.reply("Send /start to open the menu. List your token, book Trending, or run a Banner Ad.");
  });

  // ── Group buy bot (run inside a project's group chat) ──────────────────────
  bot.command("settoken", groupSetup.settoken);
  bot.command("setchain", groupSetup.setchain);
  bot.command("setminbuy", groupSetup.setminbuy);
  bot.command("setwhale", groupSetup.setwhale);
  bot.command("buybot", groupSetup.buybot);
  // "What's the contract?" — the most-asked question in any token group, and
  // NOT admin-gated: the people asking are holders, not the admin who already
  // knows. A bare "ca" is caught by groupTokenReply below.
  bot.command("ca", groupSetup.ca);
  bot.command("contract", groupSetup.ca);
  bot.action(/^mb_(\d+)$/, groupSetup.minBuyPick); // /setminbuy preset picker
  bot.action(/^wb_(\d+|off)$/, groupSetup.whalePick); // /setwhale preset picker
  bot.action(/^bs_([a-z]+)$/, groupSetup.settingsTap); // /buybot settings hub
  // Registered separately from bs_<word>: these carry a sequence number, so a
  // card left open in chat history cannot arm whatever was pasted since.
  bot.action(/^bs_(?:act|actno):\d+$/, groupSetup.activateTap); // pasted-CA confirm
  // 🚀 Raid, from the group welcome card. Wired here rather than inside
  // groupSetup so the buy-bot setup module keeps no dependency on the raid one.
  // showPanel does its own group + admin check, so this adds no gate of its own.
  bot.action("gs_raid", (ctx) => require("../raid/panel").showPanel(ctx));

  // ── Main menu ─────────────────────────────────────────────────────────────
  bot.action("home", start.homeHandler);
  bot.action("submit_coin", listing.entryXpress);
  bot.action("listing_trend_coin", listing.entryListingTrending);
  bot.action("trend_coin", trending.entryTrending);
  bot.action("ad_banner", banner.entryBanner);

  // ── Listing flow ──────────────────────────────────────────────────────────
  bot.action(/^lc_(.+)$/, listing.chainPick);
  bot.action(/^lt_(.+)$/, listing.tierPick);
  bot.action(/^edit_([a-z_]+)$/, listing.editField);
  bot.action("approve_listing", listing.approve);
  bot.action("discard_listing", listing.discard);

  // ── Trending flow ─────────────────────────────────────────────────────────
  bot.action(/^td_(\d+)$/, trending.durationPick);
  bot.action(/^xtd_([a-f0-9]+)_(\d+H)$/, trending.extendPick); // slot-expiry renewal

  // ── Banner flow ───────────────────────────────────────────────────────────
  bot.action(/^bt_(standard|wide)$/, banner.typePick);
  bot.action(/^bd_(\d+)$/, banner.durationPick);
  bot.action(/^bpay_(.+)$/, banner.payPick);
  bot.action(/^yn_([a-z]+)_(yes|no)$/, banner.yesNo);

  // ── Mass DM flow ──────────────────────────────────────────────────────────
  bot.action("ad_massdm", massdm.entryMassDm);
  bot.action("md_pay", massdm.payPick);
  bot.action("md_test", massdm.testSend);
  // The photo is optional and settable AFTER the text: md_media asks for one,
  // md_back is the stated skip ("keep it text-only" / "keep it"), md_nomedia is
  // the explicit removal — which only ever exists while something is attached.
  bot.action("md_media", massdm.mediaAsk);
  bot.action("md_back", massdm.mediaBack);
  bot.action("md_nomedia", massdm.mediaClear);
  // ✏️ Edit re-opens the compose step with the token, the chain and any photo
  // intact — ad_massdm restarts at "paste your CA" and is the 📣 menu entry.
  bot.action("md_edit", massdm.mdEdit);
  bot.action("buybot_help", start.buyBotHelp);

  // ── Payment ───────────────────────────────────────────────────────────────
  // The buyer picks which network settles the order (ETH on Ethereum vs on
  // Robinhood Chain). Registered beside confirm_pay because it is the step
  // directly before it.
  bot.action(/^paynet_(.+)$/, pay.netPick);
  bot.action("confirm_pay", payment.confirmPayHandler);
  // The broadcast add-on lives on the PAY CARD, beside Confirm — every package
  // ends there, so one pair of actions serves all of them.
  bot.action("bcpay", (ctx) => require("./pay").broadcastToggle(ctx)); // add / remove, on the pay card

  // ── Free-text + media routers (LAST) ──────────────────────────────────────
  // The group one first, and it calls next() for anything that is not a reply
  // to its own force_reply prompt — textRouter ignores groups entirely, so a
  // pasted contract address in a group had nowhere to land.
  bot.on("text", groupSetup.groupTokenReply);
  bot.on("text", text.textRouter);
  bot.on(["photo", "document", "video", "animation"], text.mediaRouter);

  log.info("[registry] handlers registered");
  return bot;
}

module.exports = { registerHandlers };
