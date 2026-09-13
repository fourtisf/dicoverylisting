// Per-group raid state (data/raids.json), keyed by Telegram chat id.
//
// One record per group holds BOTH the panel's settings and the live raid.
// Two fields in here are not bookkeeping — they are the only things standing
// between a customer and a permanently silenced chat:
//
//   raid.expiresAt        the DURABLE deadline. A raid whose process is killed
//                         mid-run leaves a locked group behind, and the
//                         in-memory poll timer dies with it. The boot sweep
//                         reads this, not the timer.
//   raid.prevPermissions  the chat's permissions EXACTLY as they were before
//                         we locked it, stored verbatim — including keys this
//                         codebase has never heard of. Telegram keeps adding
//                         them, and handing back a hand-written "unlocked"
//                         default would silently rewrite a customer's group
//                         rules (re-enabling media in a text-only chat, say).
//
// Both live on disk rather than in memory so ANY process after ANY restart can
// finish the unlock.
const { loadJSONSync, saveJSON } = require("../helpers/persist");

const FILE = "raids.json";
const groups = loadJSONSync(FILE, {});

/**
 * Re-read the file into the live object.
 *
 * MUST be called after persist.hydrate(). This module is required through
 * handlers/registry.js at `require("./src/bot")` time — before startBot() awaits
 * hydrate() — so on a fresh container, where the Mongo mirror is the only copy
 * of raids.json, the read above sees no file and this store comes up EMPTY.
 * A raid that was running when the container was replaced would then be
 * invisible to recoverOnBoot, and its group would stay locked with nothing
 * anywhere to notice: exactly the failure the durable expiresAt exists to
 * prevent, reached from the other end.
 *
 * Mutates the existing object rather than rebinding it, because callers hold
 * references into it (getOrCreate returns the live record).
 */
function reload() {
  const fresh = loadJSONSync(FILE, {});
  for (const k of Object.keys(groups)) delete groups[k];
  Object.assign(groups, fresh);
  return Object.keys(groups).length;
}

const key = (chatId) => String(chatId);

// Panel defaults. These are DELTAS ("+15 likes"), never absolute counts, and
// they are COPIED into the raid at launch — so editing the panel mid-raid
// cannot move a running raid's goalposts. 0 means "not tracked", and an
// untracked metric never appears on the card at all.
const DEFAULT_SETTINGS = {
  likes: 15,
  replies: 5,
  reposts: 0,
  crew: 10,
  lockChat: false,
  postUrl: "",
};

/**
 * The auto-raid watcher's state, per group.
 *
 * `lastCheckedAt` and `lastOkAt` are BOTH here on purpose, and the pair is the
 * whole point: the first is written on every tick whether or not X answered, so
 * a stale value means the WATCHER is down; the second only on a successful read,
 * so a fresh check with a stale ok means X is refusing us. With only the first,
 * a watcher blind for hours still rendered a green tick — the state that looks
 * most like a healthy one, because the timer really is alive.
 */
const DEFAULT_AUTORAID = {
  handle: "", // the watched account, bare, no @
  on: false,
  lastSeenTweetId: "", // "" means NEVER LOOKED — the first read only seeds
  lastCheckedAt: 0,
  lastOkAt: 0,
  lastError: "",
  lastErrorAt: 0,
  pendingPostId: "", // detected mid-raid, fires when the group is free
  pendingAt: 0,
  pendingTries: 0,
};

const blankRaid = () => ({ status: "idle" });

function get(chatId) {
  return groups[key(chatId)] || null;
}

/** The record, created on first touch. Always has `settings` and `raid`. */
function getOrCreate(chatId, title = "") {
  const k = key(chatId);
  if (!groups[k]) {
    groups[k] = {
      chatId: k,
      title,
      settings: { ...DEFAULT_SETTINGS },
      raid: blankRaid(),
      stats: { started: 0, completed: 0, expired: 0 },
      createdAt: Date.now(),
    };
  }
  const g = groups[k];
  g.settings = { ...DEFAULT_SETTINGS, ...(g.settings || {}) };
  // Merged rather than assigned, so a record written before auto-raid existed
  // gains the new fields on first touch instead of reading as `undefined`
  // everywhere downstream.
  g.autoRaid = { ...DEFAULT_AUTORAID, ...(g.autoRaid || {}) };
  if (!g.raid) g.raid = blankRaid();
  if (!g.stats) g.stats = { started: 0, completed: 0, expired: 0 };
  if (title && g.title !== title) g.title = title;
  return g;
}

const all = () => Object.values(groups);

/** Every group with a live raid — the runner's per-tick query. */
const running = () => all().filter((g) => g && g.raid && g.raid.status === "running");

/**
 * Every group we still believe is LOCKED BY US, whatever the raid's status.
 *
 * Separate from running() on purpose. A raid whose unlock failed keeps
 * `locked: true` but its status has already moved to expired/cancelled, so
 * running() can never see it again — which made "the next boot sweep retries"
 * false for the one case it was written for. This is what the sweep reads.
 */
const stillLocked = () => all().filter((g) => g && g.raid && g.raid.locked);

/**
 * Persist. Never throws — a failed write must not take down the poll loop —
 * but it DOES report, and it returns whether the write landed.
 *
 * The silent version was worse than it looked: the whole recovery design rests
 * on the raid record reaching disk before the chat is touched, and a full or
 * read-only DATA_DIR made that a no-op with no log line anywhere.
 */
async function save() {
  try {
    await saveJSON(FILE, groups);
    return true;
  } catch (e) {
    require("../helpers/logger").error(`[raid] could not persist ${FILE}: ${e && e.message}`);
    return false;
  }
}

async function setSettings(chatId, patch) {
  const g = getOrCreate(chatId);
  g.settings = { ...g.settings, ...patch };
  await save();
  return g;
}

async function setRaid(chatId, raid) {
  const g = getOrCreate(chatId);
  g.raid = raid;
  await save();
  return g;
}

async function patchRaid(chatId, patch) {
  const g = getOrCreate(chatId);
  g.raid = { ...(g.raid || blankRaid()), ...patch };
  await save();
  return g;
}

/**
 * Add someone to the crew, exactly once.
 *
 * The check and the push are SYNCHRONOUS, before any await. A raid card is
 * precisely the moment twenty people tap in the same second, and a
 * read-await-write would drop most of them. Returns true when this call is the
 * one that added them.
 */
function joinCrew(chatId, userId, name) {
  const g = get(chatId);
  if (!g || !g.raid || g.raid.status !== "running") return false;
  const uid = String(userId);
  if (!Array.isArray(g.raid.crew)) g.raid.crew = [];
  if (g.raid.crew.some((p) => p.userId === uid)) return false;
  g.raid.crew.push({ userId: uid, name: String(name || ""), at: Date.now() });
  save();
  return true;
}

async function remove(chatId) {
  delete groups[key(chatId)];
  await save();
}

/** Test seam — drop everything without touching the operator's file. */
function _reset() {
  for (const k of Object.keys(groups)) delete groups[k];
}

module.exports = {
  get,
  getOrCreate,
  all,
  running,
  stillLocked,
  save,
  setSettings,
  setRaid,
  patchRaid,
  joinCrew,
  remove,
  reload,
  _reset,
  DEFAULT_SETTINGS,
  DEFAULT_AUTORAID,
  FILE,
};
