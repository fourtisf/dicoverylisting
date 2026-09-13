// Boot-wiring smoke test: require every module and build a bot with all
// middleware + handlers applied, WITHOUT launching (no network). Catches
// missing exports, bad requires, and registration errors. `npm run check`.
process.env.BOT_TOKEN = process.env.BOT_TOKEN || "123456:TEST_TOKEN_SMOKE";
process.env.ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "123456:TEST_ADMIN_SMOKE";
process.env.INTERNAL_API_TOKEN =
  process.env.INTERNAL_API_TOKEN || "smoke_smoke_smoke_smoke_smoke_1234";

const { Telegraf } = require("telegraf");

const modules = [
  "../src/config/chains",
  "../src/config/constants",
  "../src/config/packages",
  "../src/premium",
  "../src/gramjs",
  "../src/templates",
  "../src/admin/adminBot",
  "../src/broadcast/store",
  "../src/broadcast/sender",
  "../src/api/dexvra",
  "../src/marketdata",
  "../src/dexscreener",
  "../src/nativeprice",
  "../src/fulfillment",
  "../src/assets",
  "../src/bannerRender",
  "../src/bannerTemplate",
  "../src/helpers/canvasKit",
  "../src/gainers",
  "../src/gainersBanner",
  "../src/gainerspost/store",
  "../src/services/gainersConfig",
  "../src/services/gainersPoster",
  "../src/admin/gainersMenu",
  "../src/twitter",
  "../src/helpers/format",
  "../src/helpers/message",
  "../src/helpers/logger",
  "../src/helpers/persist",
  "../src/state",
  "../src/channels/post",
  "../src/channels/format",
  "../src/channels/postids",
  "../src/handlers/menu",
  "../src/handlers/start",
  "../src/handlers/registry",
  "../src/handlers/listing",
  "../src/handlers/trending",
  "../src/handlers/banner",
  "../src/handlers/text",
  "../src/handlers/pay",
  "../src/payments/payment",
  "../src/payments/units",
  "../src/payments/wallets",
  "../src/payments/verify",
  "../src/payments/orders",
  "../src/payments/chains/evm",
  "../src/payments/chains/solana",
  "../src/payments/chains/tron",
  "../src/payments/chains/ton",
  "../src/services/monitoring",
  "../src/services/attach",
  "../src/services/trendingPoster",
  "../src/services/trendingSweeper",
  "../src/services/pumpChecker",
  "../src/services/recovery",
];

let failed = 0;
for (const m of modules) {
  try {
    require(m);
  } catch (e) {
    failed++;
    console.error(`FAIL require ${m}: ${e.message}`);
  }
}

try {
  const { applyMiddleware } = require("../src/bot");
  const bot = new Telegraf(process.env.BOT_TOKEN);
  applyMiddleware(bot);
  console.log("OK  bot middleware + handlers applied");
} catch (e) {
  failed++;
  console.error(`FAIL applyMiddleware: ${e.stack || e.message}`);
}

try {
  require("../src/admin/adminBot").build();
  console.log("OK  admin bot built");
} catch (e) {
  failed++;
  console.error(`FAIL adminBot.build: ${e.stack || e.message}`);
}

if (failed) {
  console.error(`\nSMOKE FAILED (${failed} error${failed > 1 ? "s" : ""})`);
  process.exit(1);
}
console.log("\nSMOKE OK");
// A middleware store (rate-limit) may hold the loop open; this is a boot check,
// so exit deterministically.
process.exit(0);
