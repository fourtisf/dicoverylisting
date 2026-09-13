// Background service orchestrator. Real services (trending poster, trending
// sweeper, pump checker) are wired in Phase F; this keeps the boot contract.
const log = require("../helpers/logger");

function setupMonitoring(bot) {
  const services = [];
  let failed = [];
  // The MODULE_NOT_FOUND exemption below covers ONE thing: attach.js itself not
  // existing, which was the boot contract while the services were still being
  // written. It must not extend past that require.
  //
  // It used to: `attachServices` ran inside this same try, so a MODULE_NOT_FOUND
  // raised by any service's own require — a missing npm package four services
  // deep — was swallowed here without a single log line, and every service
  // declared after the broken one never started. The auto-lister is fourth in
  // that list. That is how free listings stopped for two days with pm2 showing
  // the process online and the panel showing "🟢 ON": the switch reads a config
  // file and never knew the loop behind it was not running.
  //
  // attachServices now guards each service on its own and never throws, so
  // anything escaping it is a genuine fault and is reported.
  let attach = null;
  try {
    attach = require("./attach");
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") log.error(`[monitoring] cannot load service wiring: ${e.message}`);
  }
  if (attach) {
    try {
      ({ failed = [] } = attach.attachServices(bot, services) || {});
    } catch (e) {
      log.error(`[monitoring] service wiring crashed: ${e && e.message}`);
    }
  }
  // Names, not just a count: "9 background service(s) started" only means
  // something to a reader who already knows it should have been 13.
  log.info(
    `[monitoring] ${services.length} background service(s) started` +
      (failed.length ? ` — ${failed.length} FAILED: ${failed.join(", ")}` : ""),
  );
  const cleanup = () => services.forEach((s) => s.stop && s.stop());
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  return { services, cleanup };
}

module.exports = { setupMonitoring };
