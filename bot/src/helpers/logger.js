// Minimal leveled console logger with timestamps. Optionally mirrors warn/error
// to a Telegram log channel once a bot instance is attached (attach()).
let botRef = null;
let logChannel = ""; // business feed: /start, purchases — what the operator reads
let errorChannel = ""; // warn/error; same channel unless ERROR_CHANNEL is set

const ts = () => new Date().toISOString().replace("T", " ").replace(/\..+/, "");

function out(level, args) {
  const line = `[${ts()}] ${level} ${args.map(String).join(" ")}`;
  if (level === "ERROR" || level === "WARN") console.error(line);
  else console.log(line);
}

// ── Channel de-duplication ───────────────────────────────────────────────────
// A warn inside a polling loop repeats for as long as the condition holds, and
// the condition is usually permanent: one BSC token with a broken GeckoTerminal
// pool posted "ignoring absurd 24h change 39594.71%" every three minutes,
// forever, burying every real alert in the log channel.
//
// The numbers drift each poll (39594.71 → 39393.73 → 36939.24), so exact-string
// matching would not catch it. The key therefore collapses every number to #,
// which makes "same problem, new reading" one event instead of hundreds.
//
// Nothing is thrown away: the first occurrence goes out immediately, and when
// the window closes a single line reports how many were folded into it. The
// console still gets every line — that is what pm2 logs are for.
const DEDUPE_MS = 15 * 60 * 1000;
// A condition still firing when its window closes gets a LONGER window next
// time — 15m → 30m → 60m → 2h. A GeckoTerminal rate limit that holds for nine
// hours used to page every fifteen minutes, all day: thirty-odd copies of a
// message whose content never changed, burying real alerts exactly the way the
// dedupe was built to prevent. One quiet window resets the ladder, so a
// problem that comes BACK after going away pages promptly again.
const DEDUPE_MAX_MS = 2 * 60 * 60 * 1000;
const MAX_KEYS = 500; // bounded: a runaway loop must not also leak memory
const recent = new Map(); // key → { last: ms, suppressed: n, windowMs }

const dedupeKey = (text) =>
  String(text)
    .replace(/\d+(?:[.,]\d+)?/g, "#") // 39594.71% and 39393.73% are the same event
    .replace(/0x[0-9a-fA-F]{6,}/g, "0x#") // …but keep addresses distinct from each other
    .slice(0, 300);

function evictOldest() {
  if (recent.size <= MAX_KEYS) return;
  const oldest = [...recent.entries()].sort((a, b) => a[1].last - b[1].last).slice(0, recent.size - MAX_KEYS);
  for (const [k] of oldest) recent.delete(k);
}

/** true when this text should be sent now; false when it is a repeat inside the
 *  window (counted, and summarised on the next send). */
function admit(text, now) {
  const key = dedupeKey(text);
  const hit = recent.get(key);
  const windowMs = (hit && hit.windowMs) || DEDUPE_MS;
  if (hit && now - hit.last < windowMs) {
    hit.suppressed++;
    return { send: false };
  }
  const folded = hit ? hit.suppressed : 0;
  // Folds in the window just closed → the condition persists → widen. A window
  // that passed quietly means it cleared, and the next hit starts fresh.
  const nextWindow = folded > 0 ? Math.min(windowMs * 2, DEDUPE_MAX_MS) : DEDUPE_MS;
  const sinceMin = hit ? Math.max(1, Math.round((now - hit.last) / 60000)) : 0;
  recent.set(key, { last: now, suppressed: 0, windowMs: nextWindow });
  evictOldest();
  return { send: true, folded, sinceMin };
}

function forward(text, channel) {
  const to = channel || logChannel;
  if (!botRef || !to) return;
  const { send, folded, sinceMin } = admit(text, Date.now());
  if (!send) return;
  const body = folded > 0 ? `${text}\n(+${folded} more like this in the last ${sinceMin} min)` : text;
  botRef.telegram
    .sendMessage(to, body.slice(0, 3800), { disable_web_page_preview: true })
    .catch(() => {});
}

const log = {
  attach(bot, channel, errors) {
    botRef = bot;
    logChannel = channel || "";
    errorChannel = errors || channel || "";
  },
  info: (...a) => out("INFO", a),
  warn: (...a) => {
    out("WARN", a);
    forward(`⚠️ ${a.map(String).join(" ")}`, errorChannel);
  },
  // A warning the operator cannot act on: the bot met a condition, handled it
  // correctly by itself, and is only saying so for the record. Broken pool data
  // it already rejected; an X rule that expires on its own; a board that is
  // short because the market is short.
  //
  // These went to the channel as ⚠️ alongside failed sweeps and missing keys,
  // which is the real cost — not the volume, but that a reader stops
  // distinguishing the two. pm2 logs keep every line; set OPS_VERBOSE=1 to put
  // them back in the channel while chasing something.
  noise: (...a) => {
    out("WARN", a);
    if (process.env.OPS_VERBOSE === "1") forward(`⚠️ ${a.map(String).join(" ")}`, errorChannel);
  },
  error: (...a) => {
    out("ERROR", a);
    forward(`🚨 ${a.map(String).join(" ")}`, errorChannel);
  },
  debug: (...a) => {
    if (process.env.DEBUG) out("DEBUG", a);
  },
  event: (text) => {
    out("EVENT", [text]);
    forward(text);
  },
  // Operational page to the ERROR channel: something is broken, or something
  // that was broken has recovered. NOT de-duplicated — the health monitor owns
  // its own "have I already said this" state machine, and folding an alert into
  // a 15-minute window would swallow a second, genuinely new outage inside it.
  // Console keeps it at WARN: an alert is a thing to look at, not a stack trace.
  alert: (html) => {
    out("ALERT", [String(html).replace(/<[^>]+>/g, "").replace(/\n/g, " | ")]);
    const to = errorChannel || logChannel;
    if (!botRef || !to) return;
    botRef.telegram
      .sendMessage(to, String(html).slice(0, 3800), { parse_mode: "HTML", disable_web_page_preview: true })
      .catch(() => {});
  },
  // Rich HTML report to the log channel (visitor / purchase reports). Console
  // gets a tag-stripped line. NOT de-duplicated: these are business events
  // (a purchase, a new visitor) where two identical-looking lines are two real
  // things that happened, and collapsing them would hide revenue.
  report: (html) => {
    out("REPORT", [String(html).replace(/<[^>]+>/g, "").replace(/\n/g, " | ")]);
    if (botRef && logChannel) {
      botRef.telegram
        .sendMessage(logChannel, String(html).slice(0, 3800), {
          parse_mode: "HTML",
          disable_web_page_preview: true,
        })
        .catch(() => {});
    }
  },
  // Test seam: the dedupe state is process-local and would otherwise leak
  // between cases.
  _resetDedupe: () => recent.clear(),
  _dedupeKey: dedupeKey,
};

module.exports = log;
