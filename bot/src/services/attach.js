// Wires the background services onto the bot. Called by setupMonitoring().
//
// EVERY SERVICE IS ISOLATED FROM EVERY OTHER ONE. This used to be a straight
// run of `services.push(require("./x").start(tg))` inside one try/catch up in
// monitoring.js, which meant a single service that failed to load took out every
// service DECLARED AFTER IT — and the catch there swallowed MODULE_NOT_FOUND
// without a word. The auto-lister sits fourth in this list, so a missing
// dependency in the trending poster was enough to stop free listings for days
// while pm2 showed the process online and the admin panel showed Auto Listing
// "🟢 ON" (that switch reads a config file; it never knew whether the loop
// behind it was running).
//
// So: each service starts inside its own guard, a failure is reported BY NAME at
// error level, and the ones after it still start. The boot summary then names
// what is running and what is not, because "9 background service(s) started" is
// only meaningful to someone who already knows it should have been 13.
const { PUMP_ENABLED, UPSELL_ENABLED, RANKUP_ENABLED } = require("../config/constants");
const log = require("../helpers/logger");

/**
 * Start one service. Returns true when it is running.
 *
 * `require` is INSIDE the guard on purpose: a service whose module throws at
 * load time — a missing npm package, a syntax error, a bad env read at module
 * scope — is exactly the failure this isolates, and it happens on require, not
 * on start().
 */
function startOne(name, services, fn) {
  try {
    const svc = fn();
    if (svc) services.push(svc);
    return true;
  } catch (e) {
    // Loud, and to the ops channel. A background service that silently never
    // started is indistinguishable from one that is running and finding nothing
    // to do — which is how two days pass before anyone asks.
    log.error(`[monitoring] service "${name}" failed to start: ${e && e.message}`);
    return false;
  }
}

function attachServices(bot, services) {
  const tg = bot.telegram;
  const failed = [];
  const add = (name, fn) => {
    if (!startOne(name, services, fn)) failed.push(name);
  };

  add("trendingSweeper", () => require("./trendingSweeper").start());
  add("trendingPoster", () => require("./trendingPoster").start(tg));
  add("autoTrend", () => require("./autoTrend").start()); // auto-fill trending between paid slots
  add("autoLister", () => require("./autoLister").start(tg)); // free listings for projects crossing ~$1M (off by default)
  if (PUMP_ENABLED) add("pumpChecker", () => require("./pumpChecker").start(tg));
  if (RANKUP_ENABLED) add("rankUpChecker", () => require("./rankUpChecker").start(tg));
  if (UPSELL_ENABLED) add("trendingUpsell", () => require("./trendingUpsell").start(tg));
  add("sweepRetry", () => require("./sweepRetry").start()); // recovers funds a failed sweep left in temp wallets
  add("forcePostRunner", () => require("./forcePostRunner").start()); // publishes adminbot's force-post requests
  add("gainersPoster", () => require("./gainersPoster").start()); // publishes adminbot's Top-Gainers banners + the daily one
  add("broadcastSender", () => require("../broadcast/sender").start(tg)); // admin broadcast delivery
  if (require("../config/constants").MASS_DM_ENABLED) {
    add("massDmSender", () => require("../massdm/sender").start(tg)); // paid Mass DM delivery (approved jobs only)
  }
  if (require("../config/constants").GROUP_BUYBOT_ENABLED) {
    add("groupBuyMonitor", () => require("../group/buyMonitor").start(tg)); // group buy alerts
  }
  // The raid runner's boot sweep is the ONLY thing that unlocks a group whose
  // raid died with the process, so this service failing to start is not
  // cosmetic — it can leave a customer's chat silenced. startOne() reports it
  // by name, which is what makes that visible.
  if (require("../config/constants").RAID_ENABLED) {
    add("raidRunner", () => require("../raid/runner").start(bot));
    // A SEPARATE timer from the runner's, on purpose: this one polls X for new
    // POSTS by a watched account, the runner polls one post's numbers. They fail
    // for different reasons and at different cadences, and sharing a tick would
    // make a blocked timeline read delay every live raid's counts.
    add("raidAutoWatcher", () => require("../raid/autoRaid").start(bot));
  } else {
    // The sweep runs EVEN WITH THE FEATURE OFF, and that is the point. The
    // obvious response to a raid misbehaving in a customer's group is
    // RAID_ENABLED=0 plus a restart — which, without this, would also remove
    // the boot sweep and the /raid panel's Stop button, leaving every currently
    // locked group muted with no remaining path to an unlock. Turning a feature
    // off must not strand the chats it was holding.
    add("raidUnlockSweep", () => {
      // forceExpire: with no poll loop running, a raid still inside its
      // deadline would be "resumed" and then never finish, so its group would
      // stay locked until a restart after the deadline had passed.
      require("../raid/runner")
        .recoverOnBoot(bot.telegram, { forceExpire: true })
        .catch((e) => log.warn(`[raid] disabled-mode unlock sweep failed: ${e && e.message}`));
      return { stop: () => {} };
    });
  }

  // Is any of the above actually working? Nothing answered that until now: a
  // wedged poller, a vanished Mongo, or an order that took money and stalled
  // were all invisible until a customer complained.
  add("healthMonitor", () => require("./healthMonitor").start(tg));

  // Boot recovery (re-fulfil paid orders) + a RECURRING late-payment scan.
  // Boot-only was not enough: sessions are in-memory, so a restart drops the
  // buyer's pendingPayment and a payment that lands afterwards is credited by
  // nobody until the next restart.
  add("recovery", () => require("./recovery").start(tg));

  if (failed.length) {
    log.alert(
      `🚨 <b>${failed.length} background service(s) did not start</b>\n\n` +
        `<code>${failed.join(", ")}</code>\n\n` +
        `<i>Everything else is running. The real error is in the [monitoring] lines in pm2 logs.</i>`,
    );
  }
  return { failed };
}

module.exports = { attachServices };
