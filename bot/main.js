// Entry point. Loads .env, installs non-fatal process guards (a stray RPC/HTTP
// rejection must never crash the bot), then boots.
const envFiles = require("./src/config/loadEnv").loadEnv();

const log = require("./src/helpers/logger");
// Named out loud: "which .env is this process actually reading" is the first
// question behind every setting that appears not to apply.
// Commit FIRST. "Is my fix even running?" has cost more rounds in this repo
// than any actual bug — a pull that did not reach the server and a change
// that did not work look identical from Telegram.
log.info(`[boot] build ${require("./src/helpers/build").stamp()}`);
log.info(envFiles.length ? `[env] loaded ${envFiles.join(", ")}` : "[env] no .env found — using process env only");
// Which GeckoTerminal tier and budget this process runs on. The free ceiling is
// counted per IP and the website shares it, so "the charts are empty" and "the
// buy bot is quiet" can both be this one number — and it is invisible from
// Telegram. Printed AFTER loadEnv, because the budget freezes at require time.
require("./src/group/gtPairs").gtBanner();
require("./src/helpers/net").preferIPv4(); // before any socket opens

const NON_FATAL = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network|timeout/i;

process.on("unhandledRejection", (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  if (NON_FATAL.test(msg)) log.warn(`unhandledRejection (non-fatal): ${msg}`);
  else log.error(`unhandledRejection: ${msg}`);
});

process.on("uncaughtException", (err) => {
  const msg = err && err.message ? err.message : String(err);
  if (NON_FATAL.test(msg)) log.warn(`uncaughtException (non-fatal): ${msg}`);
  else log.error(`uncaughtException: ${msg}`);
});

const { startBot } = require("./src/bot");

startBot().catch((e) => {
  log.error(`fatal boot error: ${e && e.message}`);
  process.exitCode = 1;
});
