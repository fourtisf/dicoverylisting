// Entry for @dexvraadminbot (template editor). Separate process from the main
// bot; shares the same code + data/ dir. Started by PM2 as `dexvra-adminbot`.
const envFiles = require("./src/config/loadEnv").loadEnv();

const log = require("./src/helpers/logger");
log.info(`[boot] build ${require("./src/helpers/build").stamp()}`);   // same reason as main.js
log.info(envFiles.length ? `[env] loaded ${envFiles.join(", ")}` : "[env] no .env found — using process env only");
require("./src/helpers/net").preferIPv4(); // same flaky-IPv6 workaround as main.js

process.on("unhandledRejection", (r) => log.warn(`[adminbot] unhandledRejection: ${r && r.message ? r.message : r}`));
process.on("uncaughtException", (e) => log.warn(`[adminbot] uncaughtException: ${e && e.message}`));

const { startAdminBot } = require("./src/admin/adminBot");

startAdminBot()
  .then((started) => {
    if (started) return;
    // ADMIN_BOT_TOKEN is unset — the admin bot is OFF, which is a legitimate
    // free-tier configuration, not a failure. But this process is started by
    // PM2 with autorestart, so simply returning here exits 0, PM2 restarts it,
    // it exits again — 50 times in a couple of minutes, then `errored`. An
    // operator who deliberately skipped the second BotFather token gets a red
    // process and a wall of restarts telling them something is broken.
    //
    // So: stay parked. PM2 shows `online`, the log line above says why, and a
    // later `pm2 restart dexvra-adminbot --update-env` picks the token up.
    log.warn("[adminbot] idling — set ADMIN_BOT_TOKEN in bot/.env and restart to enable the editor");
    setInterval(() => {}, 1 << 30);
  })
  .catch((e) => {
    log.error(`[adminbot] fatal boot error: ${e && e.message}`);
    process.exitCode = 1;
  });
