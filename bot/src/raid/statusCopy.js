// The wording AND the icons of the 🤖 auto-raid block, admin-editable.
//
// It was the last generated user-facing string in this feature: every emoji in
// it — 🤖 👤 ⏱ 👀 🚫 ⏸ 🔗 — was a literal in panel.js, so it appeared in no
// template, which means the emoji-swap screen could not see it and no premium
// emoji could ever reach it. "Where do I edit 👤 and 🤖" had no answer.
//
// LABELLED LINES, not raid_style's pipes. There are thirteen fields and WHICH
// ones appear depends on the state, so counting separators to reach one would be
// unusable and a stray pipe would shift every field after it.
//
//     ok: ⏱ the bot is running, checked {when}
//     ready: 👀 ready — only posts made from now on start a raid
//
// Three rules that make it safe to edit:
//
//  • PER-FIELD FALLBACK. An omitted key keeps its built-in line, so a one-line
//    edit is a one-line change rather than a rewrite of the whole block.
//  • ONLY KNOWN KEYS ARE CONSUMED. Values legitimately contain a colon, so
//    pasting the rendered block back in must change nothing.
//  • `-` HIDES a line. An operator who wants a shorter block should not have to
//    fight the parser for it.
//
// Read through tpl.markup(), NOT tpl.t(): t() resolves to clean text, and a
// premium 👤 would arrive as its bare fallback char — the exact bug raidStyle
// documents. The fragment travels intact and the panel's own render parses it.
const tpl = require("../templates");

const DEFAULTS = {
  // No account named yet.
  off_none: "🤖 Auto-raid: off — no X account set.",
  off_hint: "👤 X account names one, and then every new post starts a raid here by itself.",
  // An account is saved but the watching is switched off.
  off_saved: "🤖 Auto-raid: off — @{handle} is saved but not being watched.",
  off_link: "🔗 An admin can still paste a post link here to raid it — that always works.",
  // Watching.
  on: "🤖 Auto-raid: on — watching @{handle}",
  ok: "⏱ the bot is running, checked {when}",
  blind: "🚫 the bot hasn't been able to see X for {min}min — new posts will NOT be spotted",
  stalled: "⚠️ last check {when} — the bot may have stopped",
  ready: "👀 ready — only posts made from now on start a raid, older ones never will",
  notready: "⏳ not ready yet — it starts watching at the next check",
  starting: "⏳ starting up — it begins watching at the next check",
  pending: "⏸ 1 post is waiting — it starts when this raid finishes",
  outcome: "⚠️ last outcome ({when}): {reason}",
  link: "🔗 An admin pasting a post link here raids it immediately",
  link_only: "🔗 ADMIN: paste the post link here to raid it — this always works",
};

const KEYS = new Set(Object.keys(DEFAULTS));

/**
 * The admin's lines merged over the built-in ones.
 *
 * Never throws: a template layer that is down costs the wording, never the
 * block — the panel still has to say whether auto-raid is alive.
 */
function lines() {
  let raw = "";
  try {
    raw = String(tpl.markup("raid_status") || "");
  } catch {
    return { ...DEFAULTS };
  }
  const out = { ...DEFAULTS };
  for (const line of raw.split("\n")) {
    const at = line.indexOf(":");
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    // Unknown keys are IGNORED rather than stored: values contain colons, so a
    // pasted-back block would otherwise invent fields out of its own prose.
    if (!KEYS.has(key)) continue;
    out[key] = line.slice(at + 1).trim();
  }
  return out;
}

/** One line, with its placeholders filled. "" when the admin hid it with `-`. */
function line(key, vars = {}) {
  const s = lines()[key];
  if (!s || s === "-") return "";
  // An unsupplied placeholder renders EMPTY, never a literal {name} — a raw
  // brace on a panel a whole group reads is the tell of a broken template.
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
}

module.exports = { line, lines, DEFAULTS, KEYS };
