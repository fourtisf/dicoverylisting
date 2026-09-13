// Once-only delivery for group alerts, on JSON persistence instead of Redis.
//
// THE BUG THIS EXISTS TO PREVENT
// The obvious implementation marks a transaction "alerted" and then sends it.
// One 429, one dropped socket, and the alert never posts AND the transaction
// can never alert again — silently, in a healthy paying group. fourtis shipped
// that three separate times (the pump latch, the portal invite, and the buy
// alert) before writing the rule down: NEVER SPEND THE DEDUPE BUDGET BEFORE
// THE MESSAGE EXISTS.
//
// So delivery is two-phase:
//
//   claim()    a short NX-style hold, so two overlapping polls that both see
//              the same transaction cannot both send it.
//   commit()   the long latch, written ONLY once Telegram has returned a
//              message_id. This is the "never again" mark.
//   release()  the claim is dropped and the next poll retries — for a
//              TRANSIENT failure, where the alert is still wanted.
//
// A FATAL chat error commits instead of releasing: a group that removed the bot
// must not be retried on every poll forever, because those retries come out of
// the same GeckoTerminal / Telegram budget every healthy group shares.
//
// WHY NOT REDIS
// Dexvra has no Redis. It has one bot process and a JSON store that already
// mirrors to Mongo (helpers/persist.js), so the atomicity Redis' NX buys across
// processes is bought here by doing check-and-set synchronously in memory
// BEFORE the await. The file write is the durable copy, not the lock.
const { loadJSONSync, saveJSON } = require("../helpers/persist");

const FILE = "buyLatch.json";

// How long a claim survives without being committed. Long enough to cover a
// slow send (Telegram's own timeout is 120s in this bot), short enough that a
// process killed mid-send re-alerts on the next poll instead of losing the
// transaction. Deliberately NOT the 1h latch: a crash must cost one duplicate
// at worst, never a permanent hole.
const CLAIM_MS = 120 * 1000;
// How long a delivered transaction stays un-repeatable.
//
// THIS MUST OUTLIVE THE FEED'S OWN WINDOW, and that is the entire reason for
// the number. GeckoTerminal serves the last 24 HOURS of trades, and the block
// cursor compares `>=` (trades share blocks), so a quiet pool re-reads its
// newest buy on every single poll. At one hour this latch expired while that
// buy was still being handed to us, `claim()` succeeded again, and the group
// got the SAME alert re-posted — roughly once an hour, up to twenty-odd times,
// until the trade finally aged out of the feed.
//
// The comment here used to say the cursor bounded this and the cursor's comment
// said the latch did. Neither did. 26h clears 24h with room for clock skew.
const LATCH_MS = 26 * 60 * 60 * 1000;
// Bound the file. Entries expire on their own, but a sweep only runs on write,
// so a burst of groups going quiet at once should not leave megabytes behind.
const MAX_ENTRIES = 20000;

const CLAIMED = "i";
const DONE = "d";
const FAILED = "f";

// "Transient" cannot mean "retry forever". Some failures are permanent for the
// MESSAGE while saying nothing about the chat — an admin saving an empty
// template, or one whose HTML will not parse — so fatalChatError rightly calls
// them transient and the retry never succeeds. Left unbounded that is a doomed
// send every poll, and (because an undelivered buy holds the pool cursor back)
// the group stops receiving anything at all.
const MAX_ATTEMPTS = 5;
// How long a failure record survives so the attempts can be counted across
// polls. Comfortably longer than a few poll intervals, far shorter than the
// latch.
const FAIL_KEEP_MS = 30 * 60 * 1000;
// A chat that answered with a fatal error is skipped wholesale for this long.
// Long enough to stop burning the shared rate budget on a group that removed
// the bot; short enough that re-adding it resumes alerts the same session.
const CHAT_MUTE_MS = 6 * 60 * 60 * 1000;

const chatKey = (chatId) => `chat:${chatId}`;

let marks = loadJSONSync(FILE, {}) || {};
let dirty = false;

const now = () => Date.now();
const keyOf = (chatId, txHash) => `${chatId}:${txHash}`;

/** Drop everything already expired. Cheap — this map is small in practice. */
function sweep(at = now()) {
  let removed = 0;
  for (const [k, v] of Object.entries(marks)) {
    if (!v || !(Number(v.u) > at)) {
      delete marks[k];
      removed++;
    }
  }
  // Pathological case: more live entries than we ever want to hold. Evict the
  // soonest-to-expire first — they are the claims, and losing a claim costs at
  // most a duplicate alert, while losing a latch costs a repeat of every
  // transaction in the group.
  const keys = Object.keys(marks);
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => Number(marks[a].u) - Number(marks[b].u))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => {
        delete marks[k];
        removed++;
      });
  }
  if (removed) dirty = true;
  return removed;
}

/** Persist. Never throws — a failed write costs a duplicate alert after a
 *  restart, which is strictly better than failing the send that follows it. */
async function flush() {
  if (!dirty) return;
  dirty = false;
  await saveJSON(FILE, marks).catch(() => {});
}

/**
 * Try to take the right to send this transaction's alert.
 * Returns true when the caller owns it and MUST follow up with commit() or
 * release(). Returns false when it is already claimed or already delivered.
 *
 * The check and the write are synchronous on purpose: `await` between them is
 * exactly the window in which two polls both see "free".
 */
function claim(chatId, txHash, at = now()) {
  if (!chatId || !txHash) return false;
  const k = keyOf(chatId, txHash);
  const cur = marks[k];
  // Delivered, or another poll is mid-send.
  if (cur && (cur.s === DONE || cur.s === CLAIMED) && Number(cur.u) > at) return false;
  const attempts = (cur && Number(cur.a)) || 0;
  if (attempts >= MAX_ATTEMPTS) {
    // Give up rather than retry a doomed send forever. Latching also frees the
    // pool cursor, which an undelivered buy would otherwise pin — taking the
    // whole group's alerts down with it.
    marks[k] = { s: DONE, u: at + LATCH_MS, a: attempts };
    dirty = true;
    flush();
    return false;
  }
  marks[k] = { s: CLAIMED, u: at + CLAIM_MS, a: attempts };
  dirty = true;
  sweep(at);
  flush();
  return true;
}

/** The alert posted. Latch it for good (well — for LATCH_MS). */
async function commit(chatId, txHash, at = now()) {
  const cur = marks[keyOf(chatId, txHash)];
  marks[keyOf(chatId, txHash)] = { s: DONE, u: at + LATCH_MS, a: (cur && cur.a) || 0 };
  dirty = true;
  await flush();
}

/**
 * The send failed in a way that should be retried. Hand the claim back and
 * count the attempt. Returns how many times this alert has now failed, so the
 * caller can say something once it stops trying.
 */
async function release(chatId, txHash, at = now()) {
  const k = keyOf(chatId, txHash);
  const attempts = ((marks[k] && Number(marks[k].a)) || 0) + 1;
  // u is a RETENTION deadline here, not a lock: claim() only blocks on DONE and
  // CLAIMED, so the next poll can take this immediately — it just arrives
  // knowing how many times we have already tried.
  marks[k] = { s: FAILED, u: at + FAIL_KEEP_MS, a: attempts };
  dirty = true;
  await flush();
  return attempts;
}

/**
 * Stop trying this chat for a while.
 *
 * The per-transaction latch cannot cover the ESTIMATED path — an estimate has
 * no transaction, so every latch call there was a no-op and a group that had
 * removed the bot was retried on every poll, forever, spending the Telegram and
 * GeckoTerminal budget shared with every healthy group.
 */
async function muteChat(chatId, at = now()) {
  marks[chatKey(chatId)] = { s: DONE, u: at + CHAT_MUTE_MS };
  dirty = true;
  await flush();
}

const isChatMuted = (chatId, at = now()) => {
  const v = marks[chatKey(chatId)];
  return !!(v && Number(v.u) > at);
};

/** Has this transaction already been delivered here? (Diagnostics/tests.) */
function isDelivered(chatId, txHash, at = now()) {
  const v = marks[keyOf(chatId, txHash)];
  return !!(v && v.s === DONE && Number(v.u) > at);
}

/** Test seam — forget everything without touching the operator's file. */
function _reset() {
  marks = {};
  dirty = false;
}

module.exports = {
  claim,
  commit,
  release,
  muteChat,
  isChatMuted,
  isDelivered,
  sweep,
  flush,
  _reset,
  FILE,
  CLAIM_MS,
  LATCH_MS,
  MAX_ATTEMPTS,
  CHAT_MUTE_MS,
};
