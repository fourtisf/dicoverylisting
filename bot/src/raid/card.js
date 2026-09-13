// The live raid card: PURE rendering, plus the signature that decides whether
// it is worth editing. No Telegram calls, no disk, no network — so it can be
// unit-tested by calling it.
//
// TWO RULES THAT LOOK COSMETIC AND ARE NOT
//
//  1. PROGRESS IS MEASURED BASELINE → TARGET, never zero → target. "+15 likes"
//     on a post that already had 200 means 215, and the bar must start empty.
//     Measuring from zero shows a full bar the instant a raid starts on any
//     post with existing engagement, which makes the whole card a lie.
//
//  2. signature() DELIBERATELY EXCLUDES THE CLOCK. The card is edited only when
//     the signature changes. Include the clock and every poll edits, Telegram
//     answers "message is not modified" or spends the group's edit rate limit
//     on a redrawn timestamp, and the real updates start getting throttled.
const tpl = require("../templates");
const premium = require("../premium");
const { escapeHtml } = require("../helpers/format");
const { RAID_BAR_WIDTH } = require("../config/constants");

// Sized so a metric row survives a phone — see the reasoning on RAID_BAR_WIDTH.
// A row one glyph too wide does not shrink; Telegram drops the count onto its
// own line under the bar, which is where the numbers stop being readable.
const BAR_WIDTH = RAID_BAR_WIDTH;
const ROSTER_SHOWN = 6;
const POST_CLIP = 140;

// likes | replies | reposts | crew | bar-filled | bar-empty
const STYLE_DEFAULT = ["❤️", "💬", "🔁", "🤝", "▰", "▱"];

const TEMPLATE_KEYS = {
  running: "raid_card",
  completed: "raid_complete",
  expired: "raid_expired",
  cancelled: "raid_cancelled",
};

/**
 * The six style fields, falling back POSITION BY POSITION.
 *
 * An admin who types "🟩|⬛" meaning "filled|empty" gets a card with odd metric
 * icons rather than no card at all — which is the right failure for a cosmetic
 * setting on a live product.
 */
function raidStyle() {
  let raw = "";
  try {
    // markup(), NOT t(). These six glyphs are VARS spliced into raid_card and
    // parsed there, so they have to arrive still wearing their markup — t()
    // resolves to clean text, which meant a premium ❤️ / 💬 / 🤝 arrived as its
    // bare fallback char and the metric rows were the one part of the card a 💎
    // swap silently could not reach. Exactly the bug buyBarStyle had.
    raw = String(tpl.markup("raid_style") || "");
  } catch {
    return STYLE_DEFAULT.slice();
  }
  const parts = raw.split("|").map((s) => s.trim());
  return STYLE_DEFAULT.map((fallback, i) => parts[i] || fallback);
}

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Fraction of the way from baseline to target. 1 when there is no span (an
 *  untracked metric), 0 when the count went DOWN — people do un-like posts, and
 *  a negative would make repeat() throw. */
function progress(cur, base, tgt) {
  const span = (tgt || 0) - (base || 0);
  if (span <= 0) return 1;
  return clamp01(((cur || 0) - (base || 0)) / span);
}

function bar(fraction, style) {
  const f = clamp01(fraction);
  // ANY progress fills at least one cell. A narrower bar rounds a real 1/16 down
  // to zero, and an all-empty bar sitting next to "1/16" says nothing happened
  // when something did — the same failure buySizeBar guards against, and it gets
  // easier to hit the fewer cells there are. Exactly zero still renders empty:
  // that one IS "nothing yet".
  const filled = f > 0 ? Math.max(1, Math.round(f * BAR_WIDTH)) : 0;
  return style[4].repeat(filled) + style[5].repeat(BAR_WIDTH - filled);
}

/**
 * The X metrics this raid is actually tracking, in a fixed order.
 *
 * `target[k] > baseline[k]` IS the encoding of "tracked": a goal of 0 leaves
 * target equal to baseline, so the metric is invisible on the card, excluded
 * from the percentage and excluded from completion. A crew-only raid returns
 * nothing here and never touches X.
 */
function activeMetrics(raid) {
  if (!raid || raid.crewOnly) return [];
  const base = raid.baseline || {};
  const tgt = raid.target || {};
  return [
    { key: "likes", label: "Likes", icon: 0 },
    { key: "replies", label: "Replies", icon: 1 },
    { key: "reposts", label: "Reposts", icon: 2 },
  ].filter((m) => (tgt[m.key] || 0) > (base[m.key] || 0));
}

/** Every goal met? A raid with no goals at all is not complete — it is broken,
 *  and returning true would make it "clear" on its first poll. */
function isComplete(raid) {
  if (!raid) return false;
  const metrics = activeMetrics(raid);
  const cur = raid.current || {};
  const base = raid.baseline || {};
  const tgt = raid.target || {};
  const crewTarget = raid.crewTarget || 0;
  if (!metrics.length && !crewTarget) return false;
  for (const m of metrics) {
    if ((cur[m.key] || 0) < (tgt[m.key] || 0)) return false;
  }
  if (crewTarget && (raid.crew || []).length < crewTarget) return false;
  void base;
  return true;
}

/** Overall completion across every tracked goal, 0-100. */
function overallPercent(raid) {
  const parts = [];
  const cur = raid.current || {};
  const base = raid.baseline || {};
  const tgt = raid.target || {};
  for (const m of activeMetrics(raid)) parts.push(progress(cur[m.key], base[m.key], tgt[m.key]));
  if (raid.crewTarget > 0) parts.push(clamp01((raid.crew || []).length / raid.crewTarget));
  if (!parts.length) return 0;
  return Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100);
}

/**
 * The goal rows. PLAIN TEXT, no markup, no entities — it is inserted into an
 * admin-editable template as a plain value, and a plain insertion cannot carry
 * custom_emoji entities. A <tg-emoji> tag here would reach the group as literal
 * angle brackets. (Premium emoji work fine everywhere else on the card, because
 * those characters ARE the template and travel in its own entity array.)
 */
function buildProgressBlock(raid) {
  const style = raidStyle();
  const cur = raid.current || {};
  const base = raid.baseline || {};
  const tgt = raid.target || {};
  const rows = [];
  for (const m of activeMetrics(raid)) {
    const c = cur[m.key] || 0;
    const t = tgt[m.key] || 0;
    const done = c >= t ? " ✅" : "";
    rows.push(`${style[m.icon]} ${m.label.padEnd(7)} ${bar(progress(c, base[m.key], t), style)}  ${c}/${t}${done}`);
  }
  if (raid.crewTarget > 0) {
    const have = (raid.crew || []).length;
    const done = have >= raid.crewTarget ? " ✅" : "";
    rows.push(
      `${style[3]} ${"Crew".padEnd(7)} ${bar(clamp01(have / raid.crewTarget), style)}  ${have}/${raid.crewTarget}${done}`,
    );
  }
  return rows.length ? rows.join("\n") : "No goals set.";
}

// Telegram's clients auto-linkify bare URLs and t.me/@handles in PLAIN message
// text — no markup and no entity required. sanitizeVar only neutralises markup
// delimiters, so it stops `[text](url)` and does nothing about `t.me/scam`.
//
// That gap is reachable by anyone: a member sets their Telegram first name to
// "🎁 t.me/DexvraDrop", says one word in the chat, and their "name" is rendered
// as a tappable link inside a paying project's PINNED card — re-posted at the
// bottom of the group on every bump.
//
// The card should only ever render links it built itself, so anything
// link-shaped in a value is replaced by a marker. The 🔗 "Open the post" button
// is the sanctioned way out of the card.
const LINKISH = /\b(?:(?:https?:\/\/|www\.)\S+|(?:t\.me|telegram\.me|telegram\.dog)\/\S*|[\w-]+\.[a-z]{2,24}(?:\/\S*)?)/gi;
const stripLinks = (s) => String(s == null ? "" : s).replace(LINKISH, "🔗");

const clip = (s, n = POST_CLIP) => {
  const a = Array.from(String(s || ""));
  return a.length <= n ? a.join("") : a.slice(0, n).join("") + "…";
};

function rosterOf(raid) {
  const names = (raid.crew || []).map((p) => p.name).filter(Boolean);
  if (!names.length) return "";
  const shown = names.slice(0, ROSTER_SHOWN).join(", ");
  const rest = names.length - ROSTER_SHOWN;
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

function timeLeft(raid, now) {
  const ms = (raid.expiresAt || 0) - now;
  if (ms <= 0) return "0m";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

const utcClock = (ms) => new Date(ms).toISOString().slice(11, 19);

/**
 * What changed that is worth an edit?
 *
 * IN: status, the three current counts, the crew SIZE, and whether the last
 * read failed. OUT: the clock, the percentage and the time remaining (all
 * derived), the TEXT of the error (only its presence matters), and the crew
 * NAMES. Crew size is in there precisely so the roster repaints when someone
 * joins.
 */
function signature(raid, status) {
  const c = raid.current || {};
  // Only the metrics the card actually DRAWS. Hashing all three raw counts
  // meant an untracked metric moving — replies climbing on a likes-only raid —
  // changed the signature and bought an editMessageText that rendered a
  // byte-identical card, every poll, out of the group's edit rate limit.
  //
  // Listing the active KEYS as well as their values is what makes the
  // crew-only → X-armed transition visible: tryRearmX can add goal rows without
  // moving any number, and the card has to repaint for that.
  const active = activeMetrics(raid).map((m) => `${m.key}=${c[m.key] || 0}`).join(",");
  return [status || raid.status, active, (raid.crew || []).length, raid.lastError ? "err" : "ok"].join(":");
}

/**
 * Render the card for a raid in `status`.
 * Returns { text, extra, templated } — no side effects of any kind.
 *
 * The two send paths have OPPOSITE escaping rules, which is why they are built
 * in one place:
 *   saved template → `entities`, and values inserted as PLAIN text
 *   code fallback  → `parse_mode:"HTML"`, and values HTML-ESCAPED
 * They are mutually exclusive in the Bot API: send both and Telegram ignores
 * the entities, so an admin's premium emoji degrade to plain unicode with no
 * error anywhere.
 */
function renderCard(raid, { now = Date.now(), status = null } = {}) {
  const st = status || raid.status || "running";
  const pct = overallPercent(raid);
  const left = timeLeft(raid, now);
  const progressBlock = buildProgressBlock(raid);
  const roster = rosterOf(raid);
  const crew = String((raid.crew || []).length);
  const seq = raid.seq ? `#${raid.seq}` : "";
  const updated = utcClock(now);
  const note = raid.lastError
    ? "⚠️ Live counts unavailable right now — showing the last numbers we read."
    : raid.crewOnly && raid.xUnavailable
      ? "⚠️ X counts aren't answering — the 🤝 Crew goal is running normally."
      : "";

  const vars = {
    seq,
    percent: String(pct),
    left,
    crew,
    // BOTH OF THESE ARE ATTACKER-SUPPLIED, and the template they land in is
    // premium MARKUP — so an un-neutralised "[click me](https://evil.test)"
    // becomes a real, clickable link inside a paying project's pinned card.
    // The post text is whatever anyone chose to tweet; the roster is whatever
    // people set as their Telegram display name, and ANYONE can join a raid.
    // sanitizeVar breaks the delimiters without mangling ordinary text.
    roster: premium.sanitizeVar(stripLinks(roster)),
    post: premium.sanitizeVar(stripLinks(clip(raid.postText))),
    // Generated by us, not by a user — safe, and it must stay raw or the bar
    // characters would be rewritten.
    progress: progressBlock,
    url: raid.postUrl || "",
    updated,
    note,
  };

  const key = TEMPLATE_KEYS[st] || TEMPLATE_KEYS.running;
  const payload = tpl.render(key, vars);
  const text = payload && payload.html != null ? payload.html : payload.text || "";
  const extra = { link_preview_options: { is_disabled: true } };
  if (payload && payload.html != null) {
    extra.parse_mode = "HTML";
  } else if (payload && payload.entities && payload.entities.length) {
    extra.entities = payload.entities;
  }

  const rows = [];
  // The join button exists only while the raid is live — a finished card that
  // still invites taps is a card that answers "That raid has ended."
  if (st === "running") rows.push([{ text: "🙋 Count me in", callback_data: "dr_join" }]);
  if (raid.postUrl) rows.push([{ text: "𝕏 Open the post", url: raid.postUrl }]);
  if (rows.length) extra.reply_markup = { inline_keyboard: rows };

  return { text, extra, templated: !(payload && payload.html != null) };
}

module.exports = {
  renderCard,
  signature,
  buildProgressBlock,
  activeMetrics,
  isComplete,
  overallPercent,
  progress,
  bar,
  raidStyle,
  rosterOf,
  timeLeft,
  clip,
  stripLinks,
  escapeHtml,
  STYLE_DEFAULT,
  TEMPLATE_KEYS,
  BAR_WIDTH,
  ROSTER_SHOWN,
};
