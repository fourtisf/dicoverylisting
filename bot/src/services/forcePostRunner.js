// Runs in the MAIN bot process: picks up force-post requests queued by
// @dexvraadminbot and publishes them. This process is the one that can actually
// do it — channels/post is attached here and the GramJS premium session lives
// here (see forcepost/store.js for why the admin bot can't just post itself).
const store = require("../forcepost/store");
const { forcePost } = require("../admin/forcePost");
const log = require("../helpers/logger");

const POLL_MS = Math.max(1000, Number(process.env.FORCEPOST_POLL_MS) || 3000);

async function tick() {
  await store.expireStale().catch(() => {});
  for (const job of store.pending()) {
    // claim() flips pending → running BEFORE publishing, so a crash mid-post
    // can't make the next tick publish the same thing again.
    if (!(await store.claim(job.id))) continue;
    try {
      const results = await forcePost(job.kind, { by: job.by });
      await store.finish(job.id, { ok: results.some((r) => r.ok), results });
    } catch (e) {
      log.warn(`[forcepost] ${job.kind} requested by ${job.by} failed: ${e.message}`);
      await store.finish(job.id, { ok: false, error: e.message });
    }
  }
}

function start() {
  let stopped = false;
  const loop = async () => {
    if (stopped) return;
    await tick().catch((e) => log.debug(`[forcepost] runner: ${e.message}`));
    if (!stopped) timer = setTimeout(loop, POLL_MS);
  };
  let timer = setTimeout(loop, 2000);
  const pruner = setInterval(() => store.prune().catch(() => {}), 60 * 60 * 1000);
  log.info(`[forcepost] runner ready (polling every ${POLL_MS / 1000}s)`);
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(pruner);
    },
  };
}

module.exports = { start, _tick: tick };
