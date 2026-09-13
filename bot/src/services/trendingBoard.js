// Admin-editable look of the pinned "Dexvra Trending" board: the per-chain logo
// emoji and the rank badges 1–10. Persisted so the operator tunes them from
// @dexvraadminbot with no redeploy; trendingPoster reads get() fresh each cycle.
//
// PREMIUM EMOJI: the built-in defaults are premium-emoji MARKUP
// ("[1️⃣](emoji/<id>)", see config/premiumEmoji.js) wherever a verified id
// exists, so the board looks premium out of the box — no per-slot admin setup,
// the same way fourtis' board does it. Slots with no verified id (rank 10, most
// L2s) stay plain unicode and remain fully settable from the admin bot.
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const { CHAIN_ORDER, chainOf } = require("../config/chains");
const pe = require("../config/premiumEmoji");

const FILE = "trendingBoard.json";

// Rank badges 1..10 (index 0 = rank 1) — the board shows up to 10 tokens per
// chain, so every slot has an editable badge. Ranks 11+ fall back to "11." etc.
const DEFAULT_RANK_EMOJIS = pe.RANK_CHARS.map((_, i) => pe.rankDefault(i + 1));
const RANK_SLOTS = DEFAULT_RANK_EMOJIS.length; // 10 editable slots

// Per-chain logo emoji. A chain with a verified premium id (premiumEmoji.js)
// defaults to that; the rest keep a sensible brand-ish unicode default. Any
// chain not listed at all falls back to 🔹.
const DEFAULT_CHAIN_LOGOS = {
  solana: "🟣",
  bsc: "🟡",
  ethereum: "🔷",
  base: "🔵",
  robinhood: "🟢",
  tron: "🔻",
  ton: "💎",
  sui: "🌊",
  plasma: "⚡",
  polygon: "🟪",
  arbitrum: "🔵",
  optimism: "🔴",
  avalanche: "🔺",
  berachain: "🐻",
  sonic: "💨",
  hyperevm: "🟩",
  abstract: "🟢",
  apechain: "🐵",
  blast: "🟡",
  sei: "🔴",
  aptos: "⚪",
  unichain: "🦄",
};
const FALLBACK_LOGO = "🔹";

// The emoji at the head of the board's TITLE line ("🔥 Dexvra Trending — live
// featured slots"). Plain unicode by default: no verified premium id exists for
// a fire, and a GUESSED id makes Telegram reject the whole message with
// EMOJI_INVALID — i.e. no board at all. The operator sets their own premium fire
// from @dexvraadminbot, which stores it as "[🔥](emoji/<id>)" like every other
// slot.
const DEFAULT_TITLE_EMOJI = "🔥";
// Marks a token whose trend slot STARTED recently. A board that is edited in
// place looks the same at 09:00 and 15:00 unless something says what changed,
// and "what just entered" is the only thing a returning reader is looking for.
// Settable (premium included) from @dexvraadminbot, same as the title.
const DEFAULT_NEW_EMOJI = "🌩";
const DEFAULT_NEW_HOURS = 3; // Fourtis uses 3h; short enough that the mark means "now"
const NEW_HOURS_MIN = 1;
const NEW_HOURS_MAX = 48;

/** The built-in badge for a rank: premium markup when we have an id for it. */
function defaultRank(pos) {
  return DEFAULT_RANK_EMOJIS[pos - 1] || "";
}
/** The built-in logo for a chain: premium markup → unicode default → 🔹. */
function defaultChainLogo(chain) {
  return pe.chainDefault(chain) || DEFAULT_CHAIN_LOGOS[chain] || FALLBACK_LOGO;
}

// Values that are NOT operator intent — they're a built-in default this code
// once shipped, so they must not shadow a newer (premium) default. Covers the
// resolved-array save shape of setRankEmoji(): setting rank 1 also writes the
// then-current defaults into ranks 2–10, and those plain chars would otherwise
// look like 10 deliberate overrides forever.
const LEGACY_RANK_DEFAULTS = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
function isBuiltinRank(pos, value) {
  const v = String(value || "").trim();
  if (!v) return true;
  const d = defaultRank(pos);
  return v === d || v === pe.charOf(d) || v === LEGACY_RANK_DEFAULTS[pos - 1];
}
function isBuiltinNewEmoji(value) {
  return String(value || "").trim() === DEFAULT_NEW_EMOJI;
}
function isBuiltinTitleEmoji(value) {
  const v = String(value || "").trim();
  return !v || v === DEFAULT_TITLE_EMOJI || v === pe.charOf(DEFAULT_TITLE_EMOJI);
}
function isBuiltinChainLogo(chain, value) {
  const v = String(value || "").trim();
  if (!v) return true;
  const d = defaultChainLogo(chain);
  return v === d || v === pe.charOf(d) || v === DEFAULT_CHAIN_LOGOS[chain];
}

function load() {
  const c = loadJSONSync(FILE, {}) || {};
  const raw = Array.isArray(c.rankEmojis) ? c.rankEmojis : [];
  // Keep ONLY slots that differ from a built-in default as real overrides (empty
  // otherwise). This is what drives the ✅/▫️ marker — and it migrates older
  // saves that stored the whole RESOLVED set (defaults baked in), which would
  // otherwise light up every slot as "custom" AND block the premium defaults.
  const rankEmojis = raw.map((v, i) => {
    const s = v == null ? "" : String(v).trim();
    return s && !isBuiltinRank(i + 1, s) ? s : null;
  });
  const savedLogos = c.chainLogos && typeof c.chainLogos === "object" ? c.chainLogos : {};
  const chainLogos = {};
  for (const [chain, v] of Object.entries(savedLogos)) {
    const s = v == null ? "" : String(v).trim();
    if (s && !isBuiltinChainLogo(chain, s)) chainLogos[chain] = s;
  }
  const t = c.titleEmoji == null ? "" : String(c.titleEmoji).trim();
  const titleEmoji = t && !isBuiltinTitleEmoji(t) ? t : null;
  const n = c.newEmoji == null ? "" : String(c.newEmoji).trim();
  const newEmoji = n && !isBuiltinNewEmoji(n) ? n : null;
  // Number(null) is 0, and 0 is finite — so a stored null read back as "clamp to
  // the minimum", silently turning a 3h window into 1h. Absence has to be
  // checked before the value is parsed, not after.
  const h = c.newHours == null ? NaN : Math.round(Number(c.newHours));
  const newHours = Number.isFinite(h) ? Math.max(NEW_HOURS_MIN, Math.min(NEW_HOURS_MAX, h)) : null;
  return { chainLogos, rankEmojis, titleEmoji, newEmoji, newHours };
}

// A badge/logo may be stored as PLAIN emoji ("🥇") or as premium-emoji MARKUP
// ("[🥇](emoji/5440539497383087970)") — the latter renders as a real premium
// emoji on the board (via GramJS). rankBadge()/chainLogo() return the stored
// fragment (fed straight into the board's markup); displayEmoji() strips it back
// to the plain fallback char for the admin editor's buttons/preview.
function displayEmoji(frag) {
  return String(frag == null ? "" : frag).replace(/\[([^\]]+)\]\(emoji\/\d+\)/g, "$1");
}

// These values are spliced VERBATIM into the board's markup, so anything that
// isn't a premium-emoji fragment gets its markup characters stripped — otherwise
// a stored "[tap](https://…)" would render as a link where a rank badge belongs.
// Enforced on write AND on read (a legacy or hand-edited data file must not be
// able to inject markup into a public channel post).
const PREMIUM_FRAG_RE = /^\[[^\]\n]+\]\(emoji\/\d+\)$/;
function sanitizeFragment(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s || PREMIUM_FRAG_RE.test(s)) return s;
  return s.replace(/[[\]()`*]/g, "").trim();
}

// Resolution against an ALREADY-loaded config, so a caller that needs many
// slots (the editor keyboards, premiumCoverage) reads the store once instead of
// once per slot. A saved PLAIN emoji is promoted to its premium twin when one is
// known, so an operator who typed 1️⃣ before premium defaults existed still gets
// the animated badge without re-setting anything.
function resolveRank(cfg, pos) {
  const v = sanitizeFragment(cfg.rankEmojis[pos - 1]);
  return v ? pe.promote(v) : defaultRank(pos);
}
function resolveChainLogo(cfg, chain) {
  const v = sanitizeFragment(cfg.chainLogos[chain]);
  return v ? pe.promoteChain(chain, v) : defaultChainLogo(chain);
}

function resolveNew(cfg) {
  const v = sanitizeFragment(cfg.newEmoji);
  return v ? pe.promote(v) : DEFAULT_NEW_EMOJI;
}
function resolveTitle(cfg) {
  const v = sanitizeFragment(cfg.titleEmoji);
  return v ? pe.promote(v) : DEFAULT_TITLE_EMOJI;
}

/** The emoji that opens the board's title line. */
function titleEmoji() {
  return resolveTitle(load());
}
/** Has the admin set their own title emoji (vs the built-in 🔥)? */
function isTitleCustom() {
  return !!load().titleEmoji;
}
/** Will the title emoji render as a real (animated) premium emoji? */
function isTitlePremium() {
  return pe.isPremium(titleEmoji());
}

async function setTitleEmoji(emoji) {
  const c = load();
  const v = sanitizeFragment(emoji);
  c.titleEmoji = !v || isBuiltinTitleEmoji(v) ? null : v;
  await saveJSON(FILE, c);
  return c.titleEmoji;
}

/** The marker put in front of a token that entered trending recently, and the
 *  window that counts as "recently". Both settable from @dexvraadminbot. */
function newEmoji() {
  return resolveNew(load());
}
function newHours() {
  return load().newHours ?? DEFAULT_NEW_HOURS;
}
/** Has the admin set their own MARKER (vs the built-in 🌩)? Deliberately about
 *  the emoji only: it drives the ✅/▫️ beside the emoji button, and the window
 *  has its own button showing its own value. */
function isNewCustom() {
  return !!load().newEmoji;
}
function isNewPremium() {
  return pe.isPremium(newEmoji());
}
async function setNewEmoji(emoji) {
  const c = load();
  const v = sanitizeFragment(emoji);
  c.newEmoji = !v || isBuiltinNewEmoji(v) ? null : v;
  await saveJSON(FILE, c);
  return c.newEmoji;
}
async function setNewHours(h) {
  const c = load();
  const n = Math.round(Number(h));
  const clamped = Number.isFinite(n) ? Math.max(NEW_HOURS_MIN, Math.min(NEW_HOURS_MAX, n)) : DEFAULT_NEW_HOURS;
  // Store nothing when it matches the default — same rule as every other slot
  // here, and it keeps "is this customised" answerable from the file alone.
  c.newHours = clamped === DEFAULT_NEW_HOURS ? null : clamped;
  await saveJSON(FILE, c);
  return clamped;
}
/** True when this listing's trend slot started inside the window. Written as a
 *  predicate rather than inline so the board and its legend can never disagree
 *  about what the mark means. */
function isNewlyTrending(row, now = Date.now()) {
  const start = Number(row && row.trendStart);
  if (!Number.isFinite(start) || start <= 0) return false;
  return now - start < newHours() * 3600 * 1000;
}

/** The rank badge for a 1-based position (1..). 1–10 are configurable; 11+ are "N.". */
function rankBadge(pos) {
  if (pos > RANK_SLOTS) return `${pos}.`;
  return resolveRank(load(), pos);
}

/** The full 1..10 rank-badge array (saved overrides on top of defaults). */
function rankEmojis() {
  const cfg = load();
  return DEFAULT_RANK_EMOJIS.map((_, i) => resolveRank(cfg, i + 1));
}

/** The logo emoji for a chain id (saved override → default → fallback). */
function chainLogo(chain) {
  return resolveChainLogo(load(), chain);
}

/** Has the admin set a custom badge for this rank (vs the built-in default)?
 *  Drives the ✅/▫️ marker in the editor so the operator sees what's done. */
function isRankCustom(pos) {
  const v = load().rankEmojis[pos - 1];
  return !!(v && String(v).trim());
}
/** Has the admin set a custom logo for this chain (vs the built-in default)? */
function isChainCustom(chain) {
  const v = load().chainLogos[chain];
  return !!(v && String(v).trim());
}
/** Will this rank badge render as a real (animated) premium emoji? */
function isRankPremium(pos) {
  return pe.isPremium(rankBadge(pos));
}
/** Will this chain logo render as a real (animated) premium emoji? */
function isChainPremium(chain) {
  return pe.isPremium(chainLogo(chain));
}

/** How many board slots currently carry a premium emoji (for the editor's
 *  readiness line): { premium, total } across ranks 1–10 + every chain. */
function premiumCoverage() {
  const cfg = load();
  const chains = CHAIN_ORDER.filter((id) => chainOf(id));
  const ranks = DEFAULT_RANK_EMOJIS.map((_, i) => pe.isPremium(resolveRank(cfg, i + 1)));
  const logos = chains.map((id) => pe.isPremium(resolveChainLogo(cfg, id)));
  const title = pe.isPremium(resolveTitle(cfg));
  return {
    premium: [...ranks, ...logos, title].filter(Boolean).length,
    total: ranks.length + logos.length + 1,
    titlePremium: title,
    ranksPremium: ranks.filter(Boolean).length,
    ranksTotal: ranks.length,
    chainsPremium: logos.filter(Boolean).length,
    chainsTotal: logos.length,
  };
}

/** Chains in board order, each with its current logo + label + whether the
 *  operator has customised it (for the editor's ✅/▫️ marker) and whether it
 *  renders premium (💎). */
function chainList() {
  const cfg = load();
  return CHAIN_ORDER.filter((id) => chainOf(id)).map((id) => {
    const logo = resolveChainLogo(cfg, id);
    return {
      id,
      label: chainOf(id).label,
      logo,
      custom: Boolean(cfg.chainLogos[id]),
      premium: pe.isPremium(logo),
    };
  });
}

async function setRankEmoji(pos, emoji) {
  if (pos < 1 || pos > RANK_SLOTS) throw new Error(`rank must be 1–${RANK_SLOTS}`);
  const c = load();
  // Store ONLY real overrides (a slot left on its default stays null) so a
  // future premium default reaches every untouched slot. The old shape wrote the
  // whole resolved array and froze the defaults of the day into the file.
  const arr = Array.from({ length: RANK_SLOTS }, (_, i) => c.rankEmojis[i] || null);
  const v = sanitizeFragment(emoji);
  arr[pos - 1] = !v || isBuiltinRank(pos, v) ? null : v;
  c.rankEmojis = arr;
  await saveJSON(FILE, c);
  return c.rankEmojis;
}

async function setChainLogo(chain, emoji) {
  const c = load();
  const v = sanitizeFragment(emoji);
  const next = { ...c.chainLogos };
  if (!v || isBuiltinChainLogo(chain, v)) delete next[chain];
  else next[chain] = v;
  c.chainLogos = next;
  await saveJSON(FILE, c);
  return c.chainLogos;
}

/** Clear every override — the board falls back to the built-in (premium) look. */
async function reset() {
  await saveJSON(FILE, { chainLogos: {}, rankEmojis: [], titleEmoji: null });
}

module.exports = {
  RANK_SLOTS,
  rankBadge,
  rankEmojis,
  chainLogo,
  chainList,
  displayEmoji,
  isRankCustom,
  isChainCustom,
  isRankPremium,
  isChainPremium,
  premiumCoverage,
  setRankEmoji,
  setChainLogo,
  titleEmoji,
  setTitleEmoji,
  isTitleCustom,
  isTitlePremium,
  newEmoji,
  setNewEmoji,
  newHours,
  setNewHours,
  isNewCustom,
  isNewPremium,
  isNewlyTrending,
  NEW_HOURS_MIN,
  NEW_HOURS_MAX,
  reset,
  DEFAULT_RANK_EMOJIS,
  DEFAULT_TITLE_EMOJI,
  DEFAULT_NEW_EMOJI,
  DEFAULT_NEW_HOURS,
};
