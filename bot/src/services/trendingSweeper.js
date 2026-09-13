// Periodically clears ended Trending slots in the store (the public board already
// hides them at render time; this keeps the store + admin panel truthful).
const { TRENDING_SWEEP_MS } = require("../config/constants");
const api = require("../api/dexvra");
const log = require("../helpers/logger");

function start() {
  const run = async () => {
    try {
      const n = await api.expireTrending();
      if (n) log.info(`[sweeper] cleared ${n} expired trending slot(s)`);
    } catch (e) {
      log.debug(`[sweeper] ${e.message}`);
    }
  };
  const iv = setInterval(run, TRENDING_SWEEP_MS);
  const kick = setTimeout(run, 5000);
  return {
    stop: () => {
      clearInterval(iv);
      clearTimeout(kick);
    },
  };
}

module.exports = { start };
