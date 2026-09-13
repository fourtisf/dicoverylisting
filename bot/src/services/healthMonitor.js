// Is the bot actually working right now?
//
// Nothing answered that. PM2 restarts a process that crashes, but the failures
// that cost money are quieter: polling wedges while the process stays "online",
// Mongo goes away, an order takes payment and never finishes fulfilment. Every
// one of those is invisible until a customer complains — which is the worst
// possible monitoring system, because by then the trust is already spent.
//
// Two halves, and the second is the one that matters most:
//
//   FAULTS — checked every CHECK_MS, alerted only when the fault OUTLASTS its
//   grace, and followed by a ✅ when it clears. The grace exists because the
//   sibling bot learned this the expensive way: Atlas reaps idle sockets, so a
//   bare "mongo disconnected" event paged daily for something that healed in
//   seconds. A monitor that cries wolf gets muted, and a muted monitor is worse
//   than none.
//
//   HEARTBEAT — one 💚 line a day. An in-process monitor can never report its
//   own death: if the container is gone, so is the thing that would have told
//   you. So the signal is inverted — the daily line arriving means alive, and
//   the daily line MISSING means look now. That is the only check here that
//   survives the bot being killed outright.
const { CHANNELS } = require("../config/constants");
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const orders = require("../payments/orders");
const mongo = require("../db/mongo");
const log = require("../helpers/logger");

const FILE = "health.json";
const CHECK_MS = 60 * 1000;
const BOOT_DELAY_MS = 60 * 1000; // let boot recovery and the first posts settle

// Grace periods: how long a fault must PERSIST before it is worth waking
// someone. Each is set from how long the thing legitimately takes to heal.
const TELEGRAM_GRACE_MS = 3 * 60 * 1000; // a route flap to Telegram clears in seconds
const MONGO_GRACE_MS = 3 * 60 * 1000; // a reaped idle socket reconnects in seconds
const STUCK_ORDER_MS = 15 * 60 * 1000; // fulfilment posts + tweets, then recovery retries
const CRASH_LOOP_BOOTS = 5; // a deploy is 2-3 restarts; five is a loop
const CRASH_LOOP_WINDOW_MS = 10 * 60 * 1000;
const BOOTS_KEPT = 20;

const DAY_MS = 24 * 3600 * 1000;
const HEARTBEAT_HOUR_UTC = Number(process.env.HEALTH_HEARTBEAT_HOUR_UTC || 1); // 08:00 WIB

// The UTC day OF THE PASS, not of the wall clock. Every other decision in a
// check pass is made against the `now` handed to it; reading the real clock here
// meant one pass could compare "have I already sent today's heartbeat" against a
// different day than the one it was checking — the exact straddle that happens
// once every 24h, at the moment the date rolls over.
const dayOf = (now) => new Date(now).toISOString().slice(0, 10);
const mins = (ms) => Math.round(ms / 60000);

let state = null; // { boots: number[], lastHeartbeatDate: string }
let timer = null;
let startedAt = 0;
// Per-fault: when it was first seen bad, and whether we already paged for it.
const faults = new Map(); // key → { since: ms, paged: boolean }

function load() {
  const s = loadJSONSync(FILE, {});
  return { boots: Array.isArray(s.boots) ? s.boots : [], lastHeartbeatDate: s.lastHeartbeatDate || null };
}
const persist = () => saveJSON(FILE, state).catch(() => {});

/** Record a fault as currently bad; returns true exactly once, when it has been
 *  bad for longer than its grace and has not been paged yet. */
function faultBad(key, graceMs, now) {
  let f = faults.get(key);
  if (!f) faults.set(key, (f = { since: now, paged: false }));
  // Judge on THIS pass, not the next one. Registering and returning false would
  // silently add a whole check interval to every grace — and turn a zero grace
  // ("15 minutes stuck is already the grace") into a minute of extra silence.
  if (f.paged || now - f.since < graceMs) return false;
  f.paged = true;
  return true;
}

/** Record a fault as currently fine; returns the outage duration in ms if we
 *  had paged for it (so the caller can post the ✅), else null. */
function faultOk(key, now) {
  const f = faults.get(key);
  faults.delete(key);
  return f && f.paged ? now - f.since : null;
}

async function checkTelegram(tg, now) {
  let ok = false;
  let why = "";
  try {
    // A real round-trip. `tg` existing proves nothing about the network.
    await Promise.race([
      tg.getMe(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timed out after 10s")), 10000)),
    ]);
    ok = true;
  } catch (e) {
    why = (e && e.message) || String(e);
  }
  if (ok) {
    const down = faultOk("telegram", now);
    if (down != null) log.alert(`✅ <b>Telegram reachable again</b> — after ~${mins(down)} min.`);
    return;
  }
  if (faultBad("telegram", TELEGRAM_GRACE_MS, now)) {
    log.alert(
      `🚨 <b>Cannot reach Telegram</b>\n\n` +
        `getMe has failed for over ${mins(TELEGRAM_GRACE_MS)} min: <code>${String(why).slice(0, 200)}</code>\n\n` +
        `<i>The bot is up but may not be receiving taps. Check the VPS network and IPv6 route.</i>`,
    );
  }
}

async function checkMongo(now) {
  // Only meaningful when Mongo is configured at all — file-only installs are a
  // supported mode, not a fault.
  if (!mongo.configured()) return;
  let ok = mongo.enabled();
  if (!ok) ok = !!(await mongo.connect().catch(() => null)); // one reconnect attempt before judging
  if (ok) {
    const down = faultOk("mongo", now);
    if (down != null) log.alert(`✅ <b>MongoDB reconnected</b> — after ~${mins(down)} min.`);
    return;
  }
  if (faultBad("mongo", MONGO_GRACE_MS, now)) {
    log.alert(
      `🚨 <b>MongoDB unreachable</b>\n\n` +
        `Down for over ${mins(MONGO_GRACE_MS)} min. The bot keeps running on local files, so nothing is lost yet — ` +
        `but the off-box backup of every store has stopped.\n\n` +
        `<i>Check Atlas cluster health and the Network Access IP allowlist.</i>`,
    );
  }
}

/** Orders that took a customer's money and never finished. The one fault here
 *  that is losing money while it goes unnoticed. */
function checkStuckOrders(now) {
  const stuck = orders
    .allOrders()
    .filter((o) => o.status === "paid" && now - (o.updatedAt || o.createdAt || 0) > STUCK_ORDER_MS);
  if (!stuck.length) {
    const down = faultOk("stuck", now);
    if (down != null) log.alert(`✅ <b>All paid orders fulfilled</b> — the backlog cleared after ~${mins(down)} min.`);
    return;
  }
  if (faultBad("stuck", 0, now)) {
    // No grace: 15 minutes IS the grace, and recovery has already had a pass.
    const lines = stuck
      .slice(0, 5)
      .map((o) => `• <code>${o.id}</code> · ${o.kind || "order"} · ${mins(now - (o.updatedAt || o.createdAt || 0))} min`);
    log.alert(
      `🚨 <b>${stuck.length} paid order${stuck.length > 1 ? "s" : ""} not fulfilled</b>\n\n` +
        `${lines.join("\n")}${stuck.length > 5 ? `\n• …and ${stuck.length - 5} more` : ""}\n\n` +
        `<i>These customers have paid and received nothing. Check the last [fulfil] lines in pm2 logs.</i>`,
    );
  }
}

/** A process that dies and is restarted, repeatedly, looks perfectly healthy to
 *  every check above — each new boot passes them all. Only the boot history
 *  shows it. */
function checkCrashLoop(now) {
  const recent = state.boots.filter((t) => now - t < CRASH_LOOP_WINDOW_MS);
  if (recent.length < CRASH_LOOP_BOOTS) return;
  if (!faultBad("crashloop", 0, now)) return;
  log.alert(
    `🚨 <b>The bot is restarting in a loop</b>\n\n` +
      `${recent.length} starts in the last ${mins(CRASH_LOOP_WINDOW_MS)} min.\n\n` +
      `<i>PM2 is masking a crash. Run <code>pm2 logs dexvra-bot --err</code> — the real error is in the first lines after each start.</i>`,
  );
}

/** One 💚 a day. Its ABSENCE is the alert — see the header. */
async function heartbeat(now) {
  if (state.lastHeartbeatDate === dayOf(now)) return;
  if (new Date(now).getUTCHours() < HEARTBEAT_HOUR_UTC) return;
  state.lastHeartbeatDate = dayOf(now);
  await persist();
  const all = orders.allOrders();
  const since = now - DAY_MS;
  const today = all.filter((o) => (o.createdAt || 0) > since);
  const paid = today.filter((o) => o.status === "paid" || o.status === "fulfilled").length;
  const backlog = all.filter((o) => o.status === "paid").length;
  const up = now - startedAt;
  const upStr = up > 3600000 ? `${Math.round(up / 3600000)}h` : `${mins(up)} min`;
  log.alert(
    `💚 <b>Dexvra bot — daily health</b>\n\n` +
      `Uptime <b>${upStr}</b>\n` +
      `Orders 24h: <b>${today.length}</b> · paid <b>${paid}</b>\n` +
      `Awaiting fulfilment: <b>${backlog}</b>\n` +
      `MongoDB: <b>${mongo.configured() ? (mongo.enabled() ? "connected" : "DOWN") : "not configured"}</b>\n` +
      `Channels: ${CHANNELS.listing} · ${CHANNELS.announce} · ${CHANNELS.trending}\n\n` +
      `<i>If this line stops arriving, the bot is down — that is what it is for.</i>`,
  );
}

/** One pass. Never throws: a monitor that can crash the bot it watches is a
 *  liability, not a safeguard. */
async function runOnce(tg, now = Date.now()) {
  try {
    await checkTelegram(tg, now);
    await checkMongo(now);
    checkStuckOrders(now);
    checkCrashLoop(now);
    await heartbeat(now);
  } catch (e) {
    log.warn(`[health] check failed: ${e && e.message}`);
  }
}

function start(tg) {
  startedAt = Date.now();
  state = load();
  state.boots = [...state.boots, startedAt].slice(-BOOTS_KEPT);
  persist();
  const boot = setTimeout(() => {
    runOnce(tg);
    timer = setInterval(() => runOnce(tg), CHECK_MS);
    if (timer.unref) timer.unref();
  }, BOOT_DELAY_MS);
  if (boot.unref) boot.unref();
  log.info(`[health] monitor started — checks every ${CHECK_MS / 1000}s, daily heartbeat at ${HEARTBEAT_HOUR_UTC}:00 UTC`);
  return {
    stop() {
      clearTimeout(boot);
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = {
  start,
  _test: { runOnce, faultBad, faultOk, faults, load, setState: (s) => (state = s), getState: () => state, setStartedAt: (t) => (startedAt = t) },
};
