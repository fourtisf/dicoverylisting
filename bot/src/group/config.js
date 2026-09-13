// Per-group buy-bot config (data/groups.json), keyed by Telegram chat id. A
// project adds @dexvrabot to their group, runs /settoken <CA> (+ /setchain if
// the auto-guess is wrong), and every on-chain buy of their token posts an
// alert in the group. One config per group chat.
const { loadJSONSync, saveJSON } = require("../helpers/persist");

const FILE = "groups.json";
const groups = loadJSONSync(FILE, {});

/**
 * Re-read the file into the live object. MUST be called after
 * persist.hydrate() — see the identical note in src/raid/store.js. This module
 * is loaded through handlers/registry.js at require("./src/bot") time, which is
 * before startBot() awaits hydrate(), so on a fresh container this store comes
 * up empty and every configured group's buy bot silently monitors nothing until
 * the next restart.
 */
function reload() {
  const fresh = loadJSONSync(FILE, {});
  for (const k of Object.keys(groups)) delete groups[k];
  Object.assign(groups, fresh);
  return Object.keys(groups).length;
}

const key = (chatId) => String(chatId);

/**
 * The lowest buy worth a message, in USD — the default for every group and the
 * bottom of the range /setminbuy accepts.
 *
 * Groups were created with a $0 floor, so a fresh group called every dust trade
 * a bot swept through: a chat full of $0.40 alerts is worth less than no alerts,
 * and it is the project's own token that looks bad. $10 is the level below which
 * a buy tells a reader nothing.
 */
const MIN_BUY_FLOOR_USD = 10;

/**
 * A group's floor, honouring the $10 minimum.
 *
 * Read through this, never off g.minBuyUsd directly: every group that predates
 * MIN_BUY_FLOOR_USD carries the old literal 0, and so does any group whose floor
 * the bare-/setminbuy bug reset. Both mean "never chosen", not "call dust".
 */
function minBuyOf(g) {
  const n = Number(g && g.minBuyUsd);
  return Number.isFinite(n) && n > MIN_BUY_FLOOR_USD ? n : MIN_BUY_FLOOR_USD;
}

function get(chatId) {
  return groups[key(chatId)] || null;
}

function all() {
  return Object.values(groups);
}

/** Active groups: buy-bot on AND a token+pair resolved. */
function active() {
  return all().filter((g) => g.on && g.chain && g.address);
}

async function upsert(chatId, patch) {
  const k = key(chatId);
  groups[k] = {
    ...(groups[k] || { chatId: k, on: false, minBuyUsd: MIN_BUY_FLOOR_USD, createdAt: Date.now() }),
    ...patch,
    chatId: k,
  };
  await saveJSON(FILE, groups).catch(() => {});
  return groups[k];
}

async function remove(chatId) {
  delete groups[key(chatId)];
  await saveJSON(FILE, groups).catch(() => {});
}

module.exports = { get, all, active, upsert, remove, reload, minBuyOf, MIN_BUY_FLOOR_USD };
