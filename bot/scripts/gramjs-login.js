#!/usr/bin/env node
// One-time interactive GramJS login — creates the string-session file the bot
// uses to post premium emoji to channels. Run ON THE SERVER with the Telegram
// PREMIUM account you want posting to the channels:
//
//   cd /opt/dexvra/bot && node scripts/gramjs-login.js
//
// Requires API_ID + API_HASH in .env (create at https://my.telegram.org/apps —
// log in with the SAME premium account). The account must be able to post in
// every channel (@dexvraio / @dexvratrending / @dexvralisting).
// One owner for "which .env does this process read" — repo root, then bot/, then
// the cwd, with override. dotenv on its own resolves against the CWD alone, so
// four scripts here quietly disagreed about which file counted.
require("../src/config/loadEnv").loadEnv();
const readline = require("node:readline");
const fs = require("node:fs/promises");
const { API_ID, API_HASH, GRAMJS_SESSION_FILE } = require("../src/config/constants");

function ask(question, { hidden } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (hidden && rl.output) {
      // mask password input
      const onData = () => {
        readline.moveCursor(rl.output, -1, 0);
        rl.output.write("*");
      };
      process.stdin.on("data", onData);
      rl.question(question, (a) => {
        process.stdin.off("data", onData);
        rl.close();
        process.stdout.write("\n");
        resolve(a.trim());
      });
    } else {
      rl.question(question, (a) => {
        rl.close();
        resolve(a.trim());
      });
    }
  });
}

(async () => {
  if (!API_ID || !API_HASH) {
    console.error("✗ API_ID / API_HASH missing. Add them to .env first (https://my.telegram.org/apps).");
    process.exit(1);
  }
  const { TelegramClient } = require("telegram");
  const { StringSession } = require("telegram/sessions");
  const { Logger, LogLevel } = require("telegram/extensions/Logger");
  const quiet = !process.argv.includes("--verbose");
  const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, {
    connectionRetries: 5,
    // baseLogger (not setLogLevel) so even the constructor's version banner is
    // silenced — the whole point is that only OUR prompts reach the terminal.
    ...(quiet ? { baseLogger: new Logger(LogLevel.NONE) } : {}),
  });
  // QUIET BY DEFAULT. GramJS logs every connect/disconnect at INFO and dumps a
  // full stack for its 9s keep-alive ping — and Telegram migrates the login to
  // the account's home DC right after the code is requested, which reliably
  // times out that in-flight ping. The resulting "Error: TIMEOUT" +
  // "AUTH_KEY_UNREGISTERED (caused by users.GetUsers)" wall is HARMLESS mid-login
  // (the session isn't bound to a user yet — that's what the code does), but it
  // buries the "Code you received:" prompt and reads like a crash, so operators
  // ctrl-C a login that was still waiting for input. --verbose brings it back
  // for real connection debugging.
  if (quiet) client.onError = async () => {}; // ping/reconnect churn during the DC switch
  console.log("Logging in to Telegram (use the PREMIUM account that posts to the channels)…");
  console.log("The code arrives as a Telegram MESSAGE to that account (not SMS).\n");
  await client.start({
    phoneNumber: () => ask("Phone number (with country code, e.g. +62…): "),
    phoneCode: () => ask("Code you received: "),
    password: () => ask("2FA password (empty if none): ", { hidden: true }),
    // Sign-in errors (bad/expired code, flood wait) still surface — they're the
    // ones the operator must act on.
    onError: (e) => console.error("  !", e.message),
  });
  const session = client.session.save();
  await fs.writeFile(GRAMJS_SESSION_FILE, session, { mode: 0o600 });
  const me = await client.getMe();
  const who = me.username ? `@${me.username}` : me.firstName;
  console.log(`\n✓ Logged in as ${who}`);
  console.log(`✓ Session saved to ${GRAMJS_SESSION_FILE}`);
  // The one fact that decides whether the trending board animates. Say it
  // plainly — it is NOT fixable in code.
  if (me.premium) {
    console.log("✓ Telegram Premium: YES — the trending board will post real premium emoji.");
  } else {
    console.log("\n⚠️  Telegram Premium: NO.");
    console.log("   Telegram only lets PREMIUM accounts send custom emoji, so the board will");
    console.log("   keep posting the plain fallback emoji. Buy Premium for this account, or");
    console.log("   re-run this script and log in with one that has it.");
  }
  // Back the fresh session up to Mongo immediately (best-effort) so a container
  // reset auto-recovers this login without re-running this script.
  try {
    const mongo = require("../src/db/mongo");
    if (mongo.configured() && (await mongo.connect())) {
      await require("../src/db/mediaMirror").mirrorSession();
      console.log("✓ Session backed up to MongoDB");
    }
    await mongo.close();
  } catch (e) {
    console.warn(`  (session Mongo backup skipped: ${e && e.message})`);
  }
  console.log("\nNext: make sure this account can post in the channels, then restart the bot:");
  console.log("  pm2 restart dexvra-bot");
  await client.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error("\n✗ Login failed:", e.message);
  if (/PHONE_CODE_INVALID|PHONE_CODE_EXPIRED/i.test(e.message || "")) {
    console.error("  The code was wrong or already expired — just run this script again.");
  }
  console.error("  Re-run with --verbose to see the full GramJS connection log.");
  process.exit(1);
});
