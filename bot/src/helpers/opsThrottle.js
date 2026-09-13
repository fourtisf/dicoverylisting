// "Say this at most once every N" — PERSISTED, so a restart does not re-arm it.
//
// Every in-memory throttle in a long-running service shares one failure: a
// deploy afternoon is a dozen restarts, and each one lets the message through
// again. The autotrend "board below target" advice reached the operator's
// channel five times in ninety minutes that way, despite carrying an hourly
// guard AND sitting behind the logger's 15-minute de-duplication — both of
// which live in process memory and both of which a restart clears.
//
// Same shape as the trade bot's core.opsDue/markOps, deliberately: the operator
// already reads one of these files.
const { loadJSONSync, saveJSON } = require("./persist");

const FILE = "opsMarks.json";

const marks = () => loadJSONSync(FILE, {}) || {};

/** Has `gapMs` passed since this key was last marked? Unknown key → yes. */
function due(key, gapMs) {
  const last = Number(marks()[key] || 0);
  if (!(last > 0)) return true;
  return Date.now() - last >= Math.max(0, Number(gapMs) || 0);
}

/** Record "it happened now". Written through — the whole point is to survive the
 *  restart that may come at any moment. */
async function mark(key, now = Date.now()) {
  const m = marks();
  m[key] = now;
  await saveJSON(FILE, m);
  return now;
}

/** Test seam / operator reset: forget a key so the next check passes. */
async function clear(key) {
  const m = marks();
  if (m[key] === undefined) return;
  delete m[key];
  await saveJSON(FILE, m);
}

module.exports = { due, mark, clear, FILE };
