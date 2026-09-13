// Verified Telegram PREMIUM (custom) emoji ids — the built-in look of the
// trending board's rank numbers and per-chain logos.
//
// WHY THIS FILE EXISTS
// The board already spoke premium-emoji markup ("[1️⃣](emoji/<id>)") end to end
// — admin capture → trendingBoard store → premium.parse() → GramJS entities —
// but every built-in DEFAULT was plain unicode, so a board only ever looked
// premium if an operator hand-set all 10 ranks and every chain. fourtis ships
// the ids in code instead (complementary/TrendPoster.js `numberEmojis`/`emojis`)
// and its board is premium out of the box. These are those same ids: public
// packs, proven rendering in @fourtistrending production.
//
// HOW A CUSTOM EMOJI ACTUALLY RENDERS
//   • The id is a global Telegram document id — any account may send any id, the
//     pack does NOT need to be installed.
//   • Only a Telegram PREMIUM *user* account (GramJS/MTProto) can send them. A
//     regular bot gets the entity silently stripped → the viewer sees the plain
//     fallback char, which is why every id below is paired with a look-alike.
//   • Non-premium VIEWERS always see the fallback char. That is normal and is
//     exactly what fourtis' channel does.
//
// ADDING AN ID: send the emoji to @dexvraadminbot in the trending-board editor —
// it stores "[char](emoji/id)" for you. Only promote an id into this file once
// it has actually rendered in a channel.

const { _env } = require("./constants");

// ── Rank badges 1–10 ────────────────────────────────────────────────────────
// One coherent number pack (fourtis' board uses 1️⃣–9️⃣ from it). No verified id
// exists for 🔟, so rank 10 stays plain unicode — a missing id must degrade to
// its char, never to a guessed id (a bad id makes Telegram reject the whole
// message with EMOJI_INVALID).
const RANK_IDS = {
  1: "5458739215141455499",
  2: "5458789504913522898",
  3: "5458512668501492883",
  4: "5458640203260381665",
  5: "5460691702979250077",
  6: "5458600672381387499",
  7: "5458450103712891950",
  8: "5458625024845956434",
  9: "5458463886262946724",
  10: null, // no verified id — renders as 🔟
};
const RANK_CHARS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

// ── Per-chain logo emoji ────────────────────────────────────────────────────
// `char` is the fallback shown to non-premium viewers (keep the fourtis pairing:
// the premium art IS that chain's logo). `aliases` are plain emoji an operator
// may already have saved for this chain — they promote to the premium logo so
// nobody has to re-set 20 slots by hand. Aliases are scoped PER CHAIN so a rank
// badge set to 🟡 never turns into a BNB logo.
const CHAIN_EMOJI = {
  solana: { id: "5382023248034677414", char: "🧂", aliases: ["🟣", "🟪", "◎", "💜"] },
  bsc: { id: "5381847463613186611", char: "🔶", aliases: ["🟡", "🟨", "💛"] },
  ethereum: { id: "5384367256501238350", char: "🔷", aliases: ["🔹", "💠"] },
  base: { id: "5445293570913222719", char: "🟦", aliases: ["🔵", "🅱️"] },
  tron: { id: "5359702818393446840", char: "🟥", aliases: ["🔻", "🔴"] },
  plasma: { id: "5330311820316010065", char: "🦔", aliases: ["⚡", "⚡️"] },
  sui: { id: "5384177187018519962", char: "💧", aliases: ["🌊", "💦"] },
  // Chains below have no verified premium id yet — they keep the plain unicode
  // default from trendingBoard.js and stay fully admin-settable.
};

// Canonical char → id, for promoting a plain emoji an admin already saved into
// its premium twin (identical artwork, now animated). Chain aliases are NOT in
// here — they resolve per chain via promoteChain().
const CANONICAL_BY_CHAR = new Map();
RANK_CHARS.forEach((ch, i) => {
  const id = RANK_IDS[i + 1];
  if (id) CANONICAL_BY_CHAR.set(ch, id);
});
for (const c of Object.values(CHAIN_EMOJI)) CANONICAL_BY_CHAR.set(c.char, c.id);

// Escape hatch: PREMIUM_EMOJI_PROMOTE=0 keeps whatever the operator literally
// saved (no plain → premium upgrade).
const PROMOTE_ENABLED = _env.bool(process.env.PREMIUM_EMOJI_PROMOTE, true);

const MARKUP_RE = /^\[([^\]]+)\]\(emoji\/(\d+)\)$/;

/** Build premium-emoji markup, or the bare char when there's no id. */
function markup(char, id) {
  return id ? `[${char}](emoji/${id})` : String(char || "");
}
/** Is this fragment premium-emoji markup (i.e. will render animated)? */
function isPremium(frag) {
  return MARKUP_RE.test(String(frag || "").trim());
}
/** The custom-emoji id inside a fragment, or null for a plain char. */
function idOf(frag) {
  const m = MARKUP_RE.exec(String(frag || "").trim());
  return m ? m[2] : null;
}
/** The plain fallback char of a fragment (markup → its char; plain → itself). */
function charOf(frag) {
  const s = String(frag == null ? "" : frag).trim();
  const m = MARKUP_RE.exec(s);
  return m ? m[1] : s;
}

/** Built-in badge for a 1-based rank (premium markup where an id exists). */
function rankDefault(pos) {
  const i = pos - 1;
  if (i < 0 || i >= RANK_CHARS.length) return "";
  return markup(RANK_CHARS[i], RANK_IDS[pos]);
}
/** Built-in logo for a chain id, or null when we have no verified id for it. */
function chainDefault(chain) {
  const c = CHAIN_EMOJI[chain];
  return c ? markup(c.char, c.id) : null;
}

/** Upgrade a PLAIN emoji to its premium twin when we know the id. Markup passes
 *  through untouched — an operator's explicit choice always wins. */
function promote(frag) {
  const s = String(frag == null ? "" : frag).trim();
  if (!s || !PROMOTE_ENABLED || isPremium(s)) return s;
  const id = CANONICAL_BY_CHAR.get(s);
  return id ? markup(s, id) : s;
}

/** Same, in a chain's context: also accepts that chain's brand aliases (a 🟣
 *  saved for Solana becomes the Solana logo, but a 🟣 rank badge does not). */
function promoteChain(chain, frag) {
  const s = String(frag == null ? "" : frag).trim();
  if (!s || !PROMOTE_ENABLED || isPremium(s)) return s;
  const c = CHAIN_EMOJI[chain];
  if (c && (s === c.char || c.aliases.includes(s))) return markup(s, c.id);
  return promote(s);
}

module.exports = {
  RANK_IDS,
  RANK_CHARS,
  CHAIN_EMOJI,
  PROMOTE_ENABLED,
  markup,
  isPremium,
  idOf,
  charOf,
  rankDefault,
  chainDefault,
  promote,
  promoteChain,
};
