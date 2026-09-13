// Is a Telegram send failure PERMANENT for this chat, or just a bad moment?
//
// ONE implementation, deliberately. Every pipeline that posts into a group —
// buy alerts, raid cards, raid completion — has to answer the same question,
// and the fourtis bot learned the hard way what happens when each of them
// answers it separately: four copies of this list existed there, they drifted,
// and one pipeline retried forever against a chat another had already given up
// on. Import this; do not re-derive it.
//
// The distinction is load-bearing in both directions:
//
//   FATAL     → the bot has been removed, blocked, or muted. Retrying costs a
//               request every poll, forever, out of a rate-limit budget shared
//               with every healthy group. Latch it and move on.
//   TRANSIENT → a 429, a 502, a dropped socket. The message is still wanted.
//               Latching here silently drops a real alert from a paying group,
//               which is the failure nobody notices because the symptom is
//               silence.
//
// When in doubt we return TRANSIENT. A retry wastes a request; a wrong latch
// loses an alert.

// Matched against the error message, case-insensitively. Telegram's wording is
// not a stable API, so these are substrings of the phrases it actually sends
// rather than equality checks.
const FATAL_PATTERNS = [
  // The chat is gone, or we are.
  "chat not found",
  "chat_id is empty",
  "bot was kicked",
  "bot is not a member",
  "bot was blocked by the user",
  "user is deactivated",
  "group chat was deactivated",
  "group chat was upgraded", // the id changed; the old one never works again
  "chat was deleted",
  "peer_id_invalid",
  // We are still in the chat but may not speak in it.
  "not enough rights",
  "have no rights to send",
  "chat_write_forbidden",
  "chat_send_plain_forbidden",
  "chat restricted",
  "topic_closed",
  "message thread not found",
];

// Explicitly transient even though they arrive as a 4xx/5xx. Checked FIRST so a
// phrase that happens to contain a fatal substring cannot be misread.
const TRANSIENT_PATTERNS = [
  "too many requests",
  "retry after",
  "flood",
  "timeout",
  "timed out",
  "econnreset",
  "econnrefused",
  "etimedout",
  "eai_again",
  "socket hang up",
  "fetch failed",
  "bad gateway",
  "gateway timeout",
  "service unavailable",
  "internal server error",
];

const text = (err) => {
  if (!err) return "";
  const parts = [
    err.message,
    err.description,
    err.response && err.response.description,
    typeof err === "string" ? err : "",
  ];
  return parts.filter(Boolean).join(" ").toLowerCase();
};

const codeOf = (err) => {
  const c = err && (err.code ?? (err.response && err.response.error_code));
  const n = Number(c);
  return Number.isFinite(n) ? n : null;
};

/**
 * True when this chat will keep rejecting us until a human intervenes
 * (re-adds the bot, unblocks it, restores its send permission).
 *
 * 403 is treated as fatal on its own: Telegram returns it for "kicked",
 * "blocked" and "no rights to send", which is exactly the set above. 400 is
 * NOT — it covers both "chat not found" and a dozen malformed-payload errors
 * that say nothing about the chat's health, so it is decided by the phrase.
 */
function isFatalChatError(err) {
  const msg = text(err);
  if (TRANSIENT_PATTERNS.some((p) => msg.includes(p))) return false;
  const code = codeOf(err);
  if (code === 429 || (code >= 500 && code < 600)) return false;
  if (code === 403) return true;
  return FATAL_PATTERNS.some((p) => msg.includes(p));
}

/** Convenience inverse — reads better at a retry site. */
const isTransientChatError = (err) => !isFatalChatError(err);

/** One short clause naming why a chat was given up on, for the log line. */
function describeChatError(err) {
  const msg = text(err);
  const hit = FATAL_PATTERNS.find((p) => msg.includes(p));
  if (hit) return hit;
  if (codeOf(err) === 403) return "forbidden (403)";
  return (err && err.message) || "unknown error";
}

module.exports = {
  isFatalChatError,
  isTransientChatError,
  describeChatError,
  FATAL_PATTERNS,
  TRANSIENT_PATTERNS,
};
