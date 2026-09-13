// Group buy-bot monitor.
//
// ONE PATH: A BUY IS ALERTED WHEN, AND ONLY WHEN, WE HAVE ITS TRANSACTION.
// That link is not decoration on a buy alert, it is the entire claim being made.
//
// THE CHAIN IS THE SOURCE (group/chainTrades.js). It reads the pool's own Swap
// events — or on Solana, the fee payer's token balance delta — so every alert
// carries a hash the reader can open. GeckoTerminal's trades feed is kept as a
// FALLBACK only, because it refuses this server at the IP level: 429 on the
// second call from a fresh process, tracking one pool, needing 2.4 requests a
// minute against a 25/minute budget. Nothing about that is a volume problem and
// no amount of pacing argues with it.
//
// Prices still come from the indexer, which is fine — that path resolves
// through DexScreener when GT is unreachable, and it answered this server the
// whole time the trades feed did not. One cached lookup per pool, not one per
// buy.
//
// THERE USED TO BE A SECOND PATH and it is worth knowing why it is gone. When
// the feed was unreadable, the bot diffed the rolling 24h volume between polls,
// apportioned the delta by the buy/sell split, and posted "≈ $340 across 11
// buys" with a line explaining that there was no transaction to link. The
// reasoning was that "we cannot see" is not "nothing happened", and silence
// would lose the buys.
//
// It did not lose them. The cursor only advances on a poll that WORKED, GT
// serves 24h of trades, and MAX_ALERT_AGE_MS lets a buy post up to half an hour
// late — so any outage shorter than that replays in full, as individual alerts,
// each with its hash, the moment the feed returns. The estimate was not
// covering a gap. It was pre-empting good alerts with a worse version of the
// same news, and then SUPPRESSING them: selectFresh() dropped every real buy an
// estimate had already covered, because an estimate has no hash for the latch
// to dedupe on. A 120-second GT rate-limit cooldown was enough to permanently
// replace a group's verifiable alerts with one unverifiable summary.
//
// So an unreadable feed is now silence plus an hourly operator warning, and the
// buys arrive late and real instead of promptly and unprovable. What remains of
// the old design is the ONE distinction that still matters: fetchPoolBuys()
// returning null (unavailable — stay silent, try again) versus [] (answered,
// pool is quiet — stay silent, advance the cursor).
//
// Lessons carried from fourtis (don't regress):
//  - Direction comes from the TOKEN ADDRESSES, never GT's base-relative `kind`.
//  - Always resolve the pool on the token's OWN chain (gtPairs), never match a
//    pool by address across chains.
//  - Self-heal a MISSING pairAddress; never repoint one an admin resolved.
//  - Never spend the dedupe budget before the message exists (alertLatch.js).
//  - Dead pools log once/hour instead of failing silently.
const {
  GROUP_BUYBOT_CHECK_MS,
  BUYBOT_POOL_MIN_MS,
  BUYBOT_EMOJI_STEP_USD,
  BUYBOT_EMOJI_MIN,
  BUYBOT_EMOJI_MAX,
  BUYBOT_WHALE_USD,
  BUYBOT_MEGA_USD,
  BUYBOT_PIN_WHALES,
  TRADEBOT_USERNAME,
  SITE_URL,
} = require("../config/constants");
const cfg = require("./config");
const whaleCfg = require("../services/whaleConfig");
const gt = require("./gtPairs");
const trades = require("./gtTrades");
const chainTrades = require("./chainTrades");
const chainPools = require("./chainPools");
const holdings = require("./walletHoldings");
const latch = require("./alertLatch");
const { isFatalChatError, describeChatError } = require("./fatalChatError");
const tpl = require("../templates");
const { payloadArgs } = require("../helpers/message");
const { fmtPrice, formatNumber, fmtPct, trimAmount } = require("../helpers/format");
const { chainOf, txUrl, accountUrl, shortAddress, chartUrl } = require("../config/chains");
const { chainEmoji } = require("../channels/format");
const premium = require("../premium");
const { loadJSONSync, saveJSON } = require("../helpers/persist");
const log = require("../helpers/logger");

const STATE_FILE = "buybot.json";
const STATE_VERSION = 2;

// v1 keyed its per-pool bookkeeping by CHAT id; v2 keys it by POOL, because
// several groups can track the same token and a cursor belongs to the pool, not
// to whoever happens to be watching it. A v1 file is discarded rather than
// migrated — worst case is one first-sight window per pool, bounded to five
// buys from the last two minutes, against the risk of misreading a chat id as a
// pool address.
//
// v2 files written before the volume estimator was retired also carry a `pools`
// map of 24h volume baselines. It is simply not read: dropping the field
// without bumping the version keeps every CURSOR, and a cursor is what stops a
// restart replaying a pool's backlog. The stale key disappears on the next save.
function loadState() {
  const raw = loadJSONSync(STATE_FILE, null);
  if (!raw || raw.v !== STATE_VERSION) return { v: STATE_VERSION, cursors: {}, pins: {} };
  return { v: STATE_VERSION, cursors: raw.cursors || {}, pins: raw.pins || {} };
}
const state = loadState();
const saveState = () => saveJSON(STATE_FILE, state).catch(() => {});

const deadLog = {}; // poolKey → last dead-pool log ts (throttle to 1/hour)
const pinWarned = new Set(); // chatIds already told they haven't granted "Pin messages"
const lastPoll = new Map(); // poolKey → ts of the last trades read

// NOTE: there is deliberately no second, pool-level "already seen" set here.
// An earlier cut had one, and it was worse than useless: it skipped a
// transaction whose delivery had FAILED TRANSIENTLY, so the retry that
// alertLatch.release() exists to allow could never happen — the alert was lost
// for the length of that set's TTL. alertLatch is the one gate, it already
// distinguishes "delivered" from "failed, try again", and its lookup is a hash
// hit. Do not add a faster check in front of it.

// Only trades from the last two minutes are alertable the first time we see a
// pool, and at most five of them. GT hands back 24 HOURS of trades — replaying
// that into a group is a wall of hundreds of alerts for buys that happened
// yesterday, which is how a new customer's first impression of the bot becomes
// "mute it".
const FIRST_SIGHT_MS = 120 * 1000;
const FIRST_SIGHT_MAX = 5;

// The same protection, for every poll AFTER the first — because the cursor is
// only advanced by a SUCCESSFUL poll, so it sits still through a GT outage, a
// metadata hold, or the process being down. On the first poll that works again
// the feed still hands back its full 24h, and without these two bounds all of
// it posts back-to-back: hours-old buys announced as if they had just happened,
// which then trips Telegram's flood limit and turns into a retry storm.
//
// A buy older than this is not news, so it is dropped rather than queued.
const MAX_ALERT_AGE_MS = 30 * 60 * 1000;
// A genuine burst is paced instead of dropped: the cursor stops at the last one
// posted, so the rest arrive on the next poll.
const MAX_PER_POLL = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const poolKeyOf = (chain, pool) => `${chain}:${String(pool).toLowerCase()}`;

/**
 * Which of these buys are new, given the stored cursor?
 *
 * The block comparison is `>=`, NOT `>`: several trades share a block, so a
 * strict `>` silently drops every same-block sibling of the last one posted.
 * The cost is that a quiet pool re-reads its newest block every poll — which
 * is exactly what the per-transaction dedupe below is for.
 */
function selectFresh(cursor, buys, at = now(), minUsd = 0) {
  if (!cursor) {
    const cutoff = at - FIRST_SIGHT_MS;
    return buys.filter((b) => b.blockTimeMs && b.blockTimeMs >= cutoff).slice(-FIRST_SIGHT_MAX);
  }
  const after = cursor.b > 0
    ? buys.filter((b) => b.blockNumber >= cursor.b)
    // Seeded on an empty feed: there is no block to compare against, so judge
    // by time. Without this, a pool that was idle when we first saw it would
    // look like first sight forever and replay its backlog the moment it trades.
    : buys.filter((b) => b.blockTimeMs && b.blockTimeMs >= (cursor.t || 0));

  // NO estimate watermark any more. There used to be a `.filter(b =>
  // b.blockTimeMs > cursor.e)` here, dropping every real buy the volume
  // estimator had already summarised during an outage — which is how a
  // two-minute GT cooldown permanently cost a group its verifiable alerts and
  // left it with one "≈ $340 across 11 buys" instead. Nothing summarises buys
  // ahead of this path now, so nothing needs suppressing: the per-tx latch is
  // the only dedupe, and it has a hash to work with.
  return (
    after
      .filter((b) => !b.blockTimeMs || b.blockTimeMs >= at - MAX_ALERT_AGE_MS)
      // A buy under EVERY group's floor cannot be posted by anyone, so it must
      // not spend one of the MAX_PER_POLL slots either.
      //
      // It used to. A token with a busy dust tail — a few hundred sub-dollar
      // trades between two real buys — handed the pacer eight of them per
      // poll, posted none, advanced the cursor by eight and logged "paced —
      // more buys queued for the next poll". Forever. The group's genuine
      // $100 buy sat behind that queue for hours, so a bot that was working
      // perfectly produced no alerts and a wall of pacing lines.
      //
      // Only applied when the amount is KNOWN: the chain reader returns
      // amounts and gets its dollars later in pollTrades, and dropping those
      // here would drop every chain-read buy there is.
      .filter((b) => !(minUsd > 0) || !(Number(b.usd) > 0) || Number(b.usd) >= minUsd)
      .slice(0, MAX_PER_POLL) // oldest first, so a burst is paced in order
  );
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * The size row: one icon per BUYBOT_EMOJI_STEP_USD, floored and capped.
 *
 * It only ever GROWS — that is the whole reason it is a row and not a
 * fill-meter. A meter renders what is missing, so a real buy comes out mostly
 * empty and reads as something failing rather than something good happening.
 *
 * SPACED, and capped low enough to stay ONE line. Premium icons render as
 * square art tiles, wider than unicode emoji: sixteen of them crammed edge to
 * edge wrapped onto a second line, which reads as a glitch rather than a big
 * buy. The cap is BUYBOT_EMOJI_MAX (.env) for an operator who wants it longer
 * anyway.
 */
/**
 * The size tier as a STABLE key — "buy" | "whale" | "mega".
 *
 * Deliberately NOT derived from tierFor(), which returns the admin-editable
 * LABEL: keying artwork off that string would silently stop working the moment
 * an operator renamed "MEGA BUY" to anything else, and nothing would report it.
 * One place owns the thresholds; the label and the artwork both read from here.
 */
const tierKey = (usd) => {
  const n = Number(usd) || 0;
  if (n >= BUYBOT_MEGA_USD) return "mega";
  if (n >= BUYBOT_WHALE_USD) return "whale";
  return "buy";
};

/**
 * Is this buy big BY ITS OWN SIZE? A different question from the whale-by-
 * WALLET verdict in whaleCheck(), which asks about the buyer instead — and
 * conflating them is what put an ordinary icon and the ordinary clip on a card
 * headed MEGA BUY: a $14,922 buy from a wallet holding $14,922 is a mega buy by
 * size and an ordinary buyer by holdings, so the label said one thing and every
 * piece of artwork said the other.
 */
const isBigBuy = (usd) => tierKey(usd) !== "buy";

/**
 * The row's icon for a buy of this size — the whale glyph once the buy is big
 * enough to be LABELLED one. The label and the icon are the same claim about
 * the same buy; they may not disagree.
 */
function buyIconFor(usd) {
  const [normal, whale] = buyBarStyle();
  return isBigBuy(usd) ? whale : normal;
}

function buyEmojiRow(usd, glyph) {
  const icon = glyph || buyIconFor(usd);
  const step = BUYBOT_EMOJI_STEP_USD;
  const n = Math.max(BUYBOT_EMOJI_MIN, Math.min(BUYBOT_EMOJI_MAX, Math.round(usd / step)));
  return Array(n).fill(icon).join(" ");
}

const BAR_WIDTH = 10;
const BAR_DEFAULT = ["🟢", "🐋"];

/** The row's two icons — normal buy | whale — falling back per position so a
 *  half-written override still renders a row rather than nothing.
 *
 *  markup(), not t(), for the same reason as introRow: these icons are VARS
 *  injected into the card template and parsed there. t() resolves to clean
 *  text, so a premium-swapped 🟢 arrived as its bare fallback char and the
 *  size row was the one part of the card a 💎 swap silently did not reach.
 *  A premium icon here is the fragment "[🟢](emoji/id)" — repeat() multiplies
 *  the fragment, and the card's parse turns each copy into its own entity. */
function buyBarStyle() {
  let raw = "";
  try {
    raw = String(tpl.markup("group_buy_style") || "");
  } catch {
    return BAR_DEFAULT.slice();
  }
  const parts = raw.split("|").map((s) => s.trim());
  return BAR_DEFAULT.map((d, i) => parts[i] || d);
}

/**
 * A fill-meter, kept as the optional {bar} placeholder. NOT the default, and
 * that is deliberate: a meter renders the part that is MISSING, so a real buy
 * shows up mostly empty and reads as something failing rather than something
 * good happening. The row above only ever grows. Use this only if you actually
 * want progress-toward-mega semantics.
 */
function buySizeBar(usd) {
  const [on] = buyBarStyle();
  const frac = Math.max(0, Math.min(1, Number(usd) / BUYBOT_MEGA_USD));
  const filled = Math.max(usd > 0 ? 1 : 0, Math.round(frac * BAR_WIDTH));
  return on.repeat(filled) + "▱".repeat(BAR_WIDTH - filled);
}

/**
 * The amount someone actually spent, in dollars they would recognise.
 *
 * NOT formatNumber(): that renders a $1,234 buy as "$1.2K", which is the right
 * call for a market cap and the wrong one here — the reader is about to open
 * the transaction and compare. Exact to the dollar up to seven figures, where
 * compact stops losing information anyone cares about.
 */
function usdAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  // Cents matter at the sizes most buys actually are — "$49" for a $48.97 buy
  // reads as a rounded guess sitting directly above a link to the transaction
  // that says otherwise. Whole dollars only once the cents stop mattering.
  if (abs >= 1000) return "$" + Math.round(n).toLocaleString("en-US");
  return "$" + n.toFixed(2);
}

/**
 * A token amount in full, with separators — "926,311.94".
 *
 * NOT the compact form used for market cap: "926.3K $RUSS" hides how many
 * tokens someone actually received, and this line sits beside a transaction
 * link that shows the exact figure.
 */
function tokenAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e12) return formatNumber(n); // beyond readable — compact it
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : 8 });
}

/** The three tier labels, admin-editable, with FIELD-BY-FIELD fallback so a
 *  half-filled override still renders a card instead of a blank label. */
function buyTiers() {
  const parts = String(tpl.t("group_buy_tiers") || "").split("|");
  const d = ["NEW BUY", "WHALE BUY", "MEGA BUY"];
  return d.map((def, i) => (parts[i] || "").trim() || def);
}

/** The label for a buy of this size. The thresholds live in tierKey() alone, so
 *  the label, the icon and the clip can never drift apart. */
const tierFor = (usd) => {
  const [normal, whale, mega] = buyTiers();
  return { buy: normal, whale, mega }[tierKey(usd)];
};

// Moved to config/chains.js — /ca offers the same link, and two copies of the
// payload shape is one to forget when it changes.
const { tradeDeepLink } = require("../config/chains");

/**
 * The "🔗 Txn · 👤 Buyer" row. Returns "" when the chain has no explorer we
 * know — a missing link must never cost the alert, and a bare hash rendered as
 * a relative URL is worse than no link at all.
 */
/**
 * What the buyer actually SPENT, in the coin they spent it in — "(0.6646 SOL)".
 *
 * Taken from the trade's own from-token amount, NOT derived as usd/nativePrice.
 * A derived figure is invented precision: it disagrees with the explorer the
 * line right below it links to, and it silently absorbs any error in whichever
 * price feed answered. Rendered only when the pool's other side really is what
 * was paid with, and dropped entirely for a routed swap whose legs paid in
 * different tokens.
 */
function spentNative(buy, pool) {
  if (!pool || !buy || !(buy.spentAmount > 0) || !buy.spentToken) return "";
  if (!pool.counterSymbol || !gt.sameToken(buy.spentToken, pool.counterAddress)) return "";
  return ` (${trimAmount(Number(buy.spentAmount.toFixed(6)))} ${pool.counterSymbol})`;
}

function verifyRow(chain, buy) {
  const tx = txUrl(chain, buy.txHash);
  const who = buy.buyer ? accountUrl(chain, buy.buyer) : null;
  const bits = [];
  // The hash and the buyer address come from a THIRD-PARTY feed, and this row
  // is premium markup — so a value containing ")" would close the link early
  // and let the rest inject arbitrary markup into the group's alert. Neither
  // field should ever contain one; that is exactly why it is worth spending a
  // function call on being sure.
  // Buyer first, then the transaction: who, then the proof.
  //
  // The 👤 lives HERE rather than in the template so the whole line can vanish
  // on a chain we have no explorer for and no buyer address — a lone icon with
  // nothing after it is not a row, it is a rendering bug. Same reason the label
  // used to live here; only the label changed.
  if (who) bits.push(`[${premium.sanitizeVar(shortAddress(buy.buyer))}](${premium.sanitizeUrl(who)})`);
  else if (buy.buyer) bits.push(premium.sanitizeVar(shortAddress(buy.buyer)));
  if (!bits.length && !tx) return "";
  // The 👤 and the separator come from `group_buyer_row`, so the editor's emoji
  // swap can reach them. What COLLAPSES stays here: either half can be missing
  // — no buyer address, or a chain with no explorer — and a lone " · " is a
  // rendering bug, not a row.
  return tpl
    .markup("group_buyer_row", {
      buyer: bits.join(""),
      txn: tx ? `${bits.length ? " · " : ""}[Txn](${premium.sanitizeUrl(tx)})` : "",
    })
    .trim();
}

/**
 * The buyer's own position in the token, directly under the buyer's address —
 * "✅ Position: 1,980,000 $RUSS · $95,523 (+3.82%)".
 *
 * Three facts in one row: how much of the token that wallet holds AFTER this
 * trade, what it is worth at the pool price, and how much this buy grew it. A
 * first-ever buy reads "(new position)" rather than an invented +100%.
 *
 * Returns "" — the whole row, emoji and label included — whenever the holding
 * could not be read: an unsupported chain, an RPC that did not answer, a buy
 * under the dust floor, or a group that turned holdings off. Same rule as
 * verifyRow above: a label with a dash after it is not a row, it is a rendering
 * bug, and the buy is worth alerting either way.
 */
function positionRow(g, pos, buy) {
  if (!pos || !(pos.held > 0)) return "";
  const sym = premium.sanitizeVar(`$${String(g.sym || "").replace(/^\$/, "") || "TOKEN"}`);
  // The buyer's wallet on the explorer — the "(Wallet)" every other buy bot
  // carries, and the one link on this row that lets a reader go and check what
  // else that address is holding.
  //
  // A WHOLE SEGMENT, so it vanishes on a chain we have no explorer for rather
  // than rendering "Wallet" as dead text. Same sanitiser as everywhere else:
  // the address comes from a feed, and this ends up inside an href.
  const url = buy && buy.buyer ? accountUrl(g.chain, buy.buyer) : null;
  const walletLink = url ? `[Wallet](${premium.sanitizeUrl(url)})` : "";
  // Rendered from `group_position_row`, not built here. This was the one row on
  // the card an admin could not reword — while the whale card spelled the same
  // row out in its own template and could. Same row, two rules.
  //
  // .trim() because an operator who empties the template means "drop this row",
  // and a row of whitespace is still a row to dropEmptyLines.
  return tpl
    .markup("group_position_row", {
      holds: tokenAmount(pos.held),
      symbol: sym,
      holdsUsd: usdAmount(pos.holdsUsd),
      position: pos.position,
      // Prebuilt so it disappears cleanly; {walletUrl} is the bare URL for an
      // operator who would rather word the link themselves.
      wallet: walletLink ? ` · ${walletLink}` : "",
      walletUrl: url ? premium.sanitizeUrl(url) : "",
    })
    .trim();
}

/** Every value both buy cards share. Split out so the whale card cannot drift
 *  away from the ordinary one — the two are the same event, told differently.
 *  `pos` is the buyer's holding when it could be read, null otherwise. */
/** The banner and the space after it, or nothing at all.
 *
 *  markup(), not t(): these are VARS injected into another template and parsed
 *  there, so they have to arrive carrying their markup. t() resolves to clean
 *  text — it silently dropped the banner's bold and, on the Position row, the
 *  entire [Wallet](url) link, leaving the word sitting there as dead text.
 *
 *  Self-spacing
 *  because dropEmptyLines is opt-in and these cards do not use it: a bare
 *  "{intro}\n" with nothing in it leaves the newline, which reads as a blank
 *  first line rather than as no banner. */
function introRow(key) {
  const t = tpl.markup(key).trim();
  return t ? `${t} ` : "";
}

function alertVars(g, buy, pool, pos) {
  const sym = String(g.sym || "").replace(/^\$/, "") || "TOKEN";
  // From config, never a literal: change LISTING_CHANNEL in .env and the byline
  // follows instead of quietly advertising a channel that moved.
  const { CHANNELS } = require("../config/constants");
  const listingChannel = String((CHANNELS && CHANNELS.listing) || "").trim();
  const dexvraPage = `${SITE_URL}/token/${g.chain}/${g.address}`;
  const chart = chartUrl(g.chain, g.pairAddress || g.address) || dexvraPage;
  const price = (pool && pool.priceUsd) || (buy.tokenAmount > 0 ? buy.usd / buy.tokenAmount : null);
  const impact = pool && pool.liquidity > 0 ? (buy.usd / pool.liquidity) * 100 : null;
  return {
    bar: buySizeBar(buy.usd),
    emoji: buyEmojiRow(buy.usd),
    // The token's own name headlines the card. It is admin-supplied via
    // GeckoTerminal, so it goes through the same sanitiser as every other
    // untrusted value — a token literally named "[click](url)" is not far-fetched.
    name: premium.sanitizeVar(g.name || `$${sym}`),
    // The 📃 row, prebuilt, because most tokens have a name and some do not —
    // and a group whose token never resolved a name would otherwise read
    // "📃 $DEX $DEX", the same word printed twice for no reason. Whole row, like
    // {verify} and {wallet}, so it collapses to just the ticker instead of
    // leaving a gap. {name} and {symbol} stay available to lay out yourself.
    // Same split as the buyer row: the icon is copy and lives in
    // `group_name_row`; which label to print is logic and stays here.
    nameRow: tpl
      .markup("group_name_row", {
        chainEmoji: chainEmoji(g.chain),
        label:
          g.name && g.name !== `$${sym}`
            ? `**${premium.sanitizeVar(g.name)}** ${premium.sanitizeVar(`$${sym}`)}`
            : `**${premium.sanitizeVar(`$${sym}`)}**`,
        name: premium.sanitizeVar(g.name || ""),
        symbol: premium.sanitizeVar(`$${sym}`),
      })
      .trim(),
    // The tier IS the header label — "NEW BUY" / "WHALE BUY" / "MEGA BUY" —
    // rather than a suffix bolted onto a fixed one, which read as two headings
    // fighting for the same line.
    tier: tierFor(buy.usd),
    native: spentNative(buy, pool),
    symbol: premium.sanitizeVar(`$${sym}`),
    usd: usdAmount(buy.usd),
    tokenAmt: tokenAmount(buy.tokenAmount),
    // The POOL's price, not the trade's effective one. They differ by fees and
    // slippage, and this figure sits next to the market cap — the two have to
    // come from the same place or the card contradicts itself.
    price: price ? fmtPrice(price) : "—",
    mcap: pool && pool.mcap ? "$" + formatNumber(pool.mcap) : "—",
    liq: pool && pool.liquidity ? "$" + formatNumber(pool.liquidity) : "—",
    impact: impact != null ? `${impact < 1 ? impact.toFixed(2) : impact.toFixed(1)}%` : "—",
    change: (pool && fmtPct(pool.change24h)) || "—",
    chain: chainOf(g.chain)?.label || g.chain,
    // The network's own glyph, picked from the token's chain with no per-group
    // setup — a Solana buy leads with the Solana mark, a Base buy with Base's.
    // Same `chain_emojis` template the channel posts read, so pasting a PREMIUM
    // custom emoji there lights up every buy card on that network at once.
    chainEmoji: chainEmoji(g.chain),
    verify: verifyRow(g.chain, buy),
    // The prebuilt row, and its three parts on their own so an admin can lay
    // them out differently. All EMPTY rather than "—" when the holding could not
    // be read: a custom row built from them then collapses to nothing, which is
    // what the reader should see, instead of three dashes that look like a
    // wallet holding nothing.
    wallet: positionRow(g, pos, buy),
    // The banner line and the byline. WHOLE ROWS, like {verify} and {wallet}:
    // an operator who clears either template gets the row gone rather than a
    // blank line where it was.
    // Each carries its OWN spacing — see introRow. Both sit on a line with
    // other content, so an empty one leaves nothing behind at all.
    intro: introRow("group_buy_intro"),
    introWhale: introRow("group_whale_intro"),
    poweredBy: (() => {
      const t = tpl.markup("group_powered_by", { listingChannel }).trim();
      return t ? ` ${t}` : "";
    })(),
    listingChannel,
    holds: pos ? tokenAmount(pos.held) : "",
    holdsUsd: pos ? usdAmount(pos.holdsUsd) : "",
    position: pos ? pos.position : "",
    // Opens the trade bot ON THIS TOKEN — ?start=ca_<chain>_<address>, which
    // tradebot/telegram.js reads to skip straight to the scan.
    tradeUrl: premium.sanitizeUrl(tradeDeepLink(g.chain, g.address)),
    // The chart is DEXSCREENER's, on the exact pool this alert is reporting —
    // the pair chart, not a token search. Falls back to the Dexvra page on the
    // one chain DexScreener does not index (Robinhood), so the button never
    // points at a 404.
    chartUrl: premium.sanitizeUrl(chart),
    // Always the Dexvra page, listed or not. It used to be a 404 for an
    // unlisted token — which is most of them, since the buy bot is free and
    // runs on any contract — so the alert hid the link and apologised instead.
    // The SITE answers that now: /token/<chain>/<ca> renders a real page for an
    // unlisted contract, with its live price, its chart and a way to list it.
    // Fixing the destination beat teaching every caller to route around it.
    coinUrl: premium.sanitizeUrl(dexvraPage),
    // The buy bot is free and runs on ANY contract, so most groups using it
    // have never bought a listing — and the Dexvra link was a 404 on every
    // alert. Both of these are WHOLE segments so each vanishes cleanly.
    // `listed` is null when the check could not run, and null is not false: an
    // unreachable API must never tell a paying customer they are not listed.
  };
}

const renderRealAlert = (g, buy, pool, pos) => tpl.render("group_buy_alert", alertVars(g, buy, pool, pos));

/**
 * The bar a group judges a holding against: its own `/setwhale`, else the
 * global one an operator set in @dexvraadminbot, else what .env ships.
 *
 * Read fresh, per group. Two groups can watch the SAME pool with different
 * bars, so this is deliberately not resolved once per buy alongside the holding.
 */
function whaleBarFor(g) {
  const own = Number(g && g.whaleWalletUsd);
  return own > 0 ? own : whaleCfg.get().walletUsd;
}

/**
 * What this buyer ALREADY HOLDS of the token — the enrichment BOTH cards use:
 * the whale verdict below, and the 💼 Position row on every ordinary buy.
 *
 * Returns null when we could not tell, which is never a reason to withhold the
 * buy — the caller renders the card without the row. One RPC call, gated behind
 * the dust floor and cached per wallet upstream.
 *
 * `whales: false` / the global off switch gate this because reading the holding
 * IS the cost of both features: one lever, not two. A group that opted out of
 * whale alerts is not billed an RPC call to decorate its ordinary ones.
 */
// A prior position smaller than this FRACTION of the current holding is read as
// rounding residue between the balance read and the trade amount, not as a bag.
// See the reasoning in buyerPosition — it is a precision floor, not a policy.
const POSITION_NOISE_FLOOR = 1e-6;

async function buyerPosition(g, buy, pool) {
  const wc = whaleCfg.get();
  if (!wc.enabled || g.whales === false) return null;
  if (!buy.buyer || !pool || !(pool.priceUsd > 0)) return null;
  if (buy.usd < wc.minBuyUsd) return null; // dust does not order an RPC call
  if (!holdings.supports(g.chain)) return null;

  // fresh: this wallet's balance moved by exactly the amount this row is about
  // to report, so a cached one is stale by construction — and a Position that
  // disagrees with the explorer is the one number on this card a reader can
  // check. See holdingOf: a cached MISS still applies, so a dead RPC is still
  // only paid for once.
  const held = await holdings.holdingOf(g.chain, g.address, buy.buyer, { fresh: true });
  if (held == null || !(held > 0)) return null;
  // How much this buy GREW the bag. `held` is the balance after the trade, so
  // the position before it is held - bought; a first-ever buy has no "before",
  // and calling that +∞ or +100% would both be inventions.
  //
  // THE SUBTRACTION IS BETWEEN TWO DIFFERENT SOURCES, and that is the whole
  // reason for the floor below. `held` is an on-chain balance read; `bought` is
  // the amount parsed out of the swap (a decimal string from the trade feed, or
  // formatUnits on the transfer) — and both land in a float64. On a 23.5-million
  // token bag they agree to about eleven significant digits and disagree after
  // that, so a first-ever buy does NOT subtract to exactly zero: it leaves a
  // residue around 0.0003. Dividing the whole bag by THAT is what published
  // "+6913050524503.39%" on a live card, under a Position row whose token amount
  // was identical to the buy's — the two numbers on screen were the same number.
  //
  // So the floor is about SOURCE PRECISION, not taste: a "previous position"
  // below a millionth of what the wallet now holds is the residue of that
  // disagreement, not a bag. Observed noise was ~1.4e-11 of the holding, four
  // orders of magnitude under this. A genuine small position still prints its
  // real (large) percentage — extreme but true is not the same as fabricated.
  const bought = buy.tokenAmount || 0;
  const before = held - bought;
  const hadPosition = before > held * POSITION_NOISE_FLOOR;
  const pct = hadPosition ? (bought / before) * 100 : null;
  const position = pct != null && Number.isFinite(pct) ? `+${pct.toFixed(2)}%` : "new position";
  return { held, holdsUsd: held * pool.priceUsd, position };
}

/**
 * Is this buyer a whale — by what they HOLD, not by what they just spent?
 *
 * Returns the enrichment the whale card needs, or null when they are not one /
 * we could not tell. Failing to read a holding is never a reason to withhold
 * the buy: the caller falls back to the ordinary alert.
 */
async function whaleCheck(g, buy, pool) {
  const pos = await buyerPosition(g, buy, pool);
  if (!pos) return null;
  // The bar this wallet actually cleared, carried through to the card. Without
  // it the template can only hardcode a number, which goes stale the moment an
  // operator retunes the threshold or a group sets its own.
  const threshold = whaleBarFor(g);
  return pos.holdsUsd >= threshold ? { ...pos, threshold } : null;
}

function renderWhaleAlert(g, buy, pool, whale) {
  const base = alertVars(g, buy, pool, whale);
  return tpl.render("group_whale_alert", {
    ...base,
    // Its own icon, so a whale reads as a whale at a glance in a scrolling chat.
    emoji: buyEmojiRow(buy.usd, buyBarStyle()[1]),
    holds: tokenAmount(whale.held),
    holdsUsd: usdAmount(whale.holdsUsd),
    position: whale.position,
    // The bar this wallet cleared — the group's own /setwhale, else the global
    // one set in @dexvraadminbot. Never a literal in the copy: it would go stale
    // the moment either is retuned, and a card that states the wrong entry
    // condition is worse than one that states none.
    whaleBar: whale.threshold > 0 ? usdAmount(whale.threshold) : "—",
  });
}

// ── Delivery ─────────────────────────────────────────────────────────────────

/**
 * Send one alert, spending the dedupe budget ONLY if it actually lands.
 *
 * `dedupeId` is the transaction hash. It is always present now that a buy is
 * only ever alerted when we have its transaction — but the null-tolerant branch
 * below stays, because a caller that cannot name what it is deduplicating must
 * be able to say so rather than invent a key that looks like deduplication and
 * deduplicates nothing.
 */
/**
 * The GIF/video an admin uploaded in @dexvraadminbot → 🎨 Gambar Banner Channel.
 * One clip per kind, shared by every group, played above the alert with the
 * transaction details as its caption.
 *
 * Resolved per send rather than cached, because `mediaOverride` is a stat() of
 * one path and an admin swapping the clip has to take effect immediately — the
 * whole point of editing it at runtime. Nothing here can fail the alert: no
 * clip, or a clip Telegram rejects, falls back to the plain text card.
 */
const DEFAULT_CLIP_KIND = "default";

function buyClip(kind = "buy") {
  try {
    const bt = require("../bannerTemplate");
    const own = bt.mediaOverride(kind);
    if (own) return own;
    // The one FALLBACK slot — ⭐ Default GIF in the admin menu — and the only
    // one there is. A kind still never borrows ANOTHER kind's clip: whale does
    // not play the buy clip and buy does not play the whale clip. That rule is
    // what makes two uploads worth making, because the operator uploads them
    // precisely so a whale LOOKS different scrolling past, and cross-borrowing
    // would give both alerts identical artwork with only the wording changed.
    //
    // A shared default is a different thing: it is house artwork the operator
    // chose ONCE for "anything I haven't dressed individually", so an operator
    // who wants one clip everywhere uploads it once instead of twice, and every
    // alert has artwork out of the box. Leave it empty and behaviour is exactly
    // what it was — the alert posts as plain text.
    if (kind === DEFAULT_CLIP_KIND) return null; // already looked; don't ask twice
    return bt.mediaOverride(DEFAULT_CLIP_KIND);
  } catch {
    return null;
  }
}

// Clip → file_id, so the bytes cross the wire ONCE. Keyed on the file's path
// and mtime, so an admin uploading a new clip invalidates it without anything
// having to remember to.
const clipFileIds = new Map();
function clipKeyOf(clip) {
  try {
    const st = require("node:fs").statSync(clip.source);
    return `${clip.type}:${clip.source}:${Math.round(st.mtimeMs)}`;
  } catch {
    return null; // not a local file (already a file_id, or gone) — do not cache
  }
}
/** The id Telegram assigned the clip it just accepted. */
function fileIdOf(msg) {
  if (!msg) return null;
  if (msg.animation) return msg.animation.file_id;
  if (msg.video) return msg.video.file_id;
  if (Array.isArray(msg.photo) && msg.photo.length) return msg.photo[msg.photo.length - 1].file_id;
  if (msg.document) return msg.document.file_id;
  return null;
}

// chatId → when Telegram said we may speak to it again. A 429 carries
// retry_after, and it is the ONE error where the right response is to wait
// exactly as long as we are told: retrying inside the window does not just
// fail, it extends it.
const floodUntil = new Map();
/** The seconds Telegram asked us to wait, from wherever the client put them. */
function retryAfterOf(e) {
  const n =
    (e && e.parameters && e.parameters.retry_after) ||
    (e && e.response && e.response.parameters && e.response.parameters.retry_after) ||
    (e && e.on && e.on.payload && e.on.payload.retry_after) ||
    0;
  return Number(n) > 0 ? Number(n) : 0;
}

async function sendAlert(tg, chatId, text, extra, kind = "buy", onClipError = null) {
  let clip = buyClip(kind);
  // NORMALISE BEFORE SENDING. An admin who uploads an .mp4 gets MEDIA_EXT's
  // "video", which dispatches to sendVideo — and sendVideo renders a PLAYER:
  // a play button the viewer has to tap, no autoplay, no loop. That is a video,
  // and a buy alert's artwork is a decorative loop nobody wants to press play
  // on. Telegram's distinction is not the extension but the AUDIO TRACK, so
  // toInlineClip strips it, rewraps as MP4 and returns type "animation" —
  // exactly what the channel posts already do (bannerTemplate.js explains it in
  // full). The conversion is cached on the source's mtime, so it costs one
  // ffmpeg run per upload, not one per alert.
  //
  // Fails open: no ffmpeg, or a clip it cannot read, returns the original and
  // the alert posts as it did before. Artwork is never worth an alert.
  if (clip) {
    try {
      clip = (await require("../bannerTemplate").toInlineClip(clip)) || clip;
    } catch (e) {
      log.debug(`[buybot] clip normalise failed (${e && e.message}) — sending it as uploaded`);
    }
  }
  if (clip) {
    // caption_entities, not entities — a caption carries its formatting under a
    // different key, and sending the wrong one drops every link silently.
    const caption = { caption: text, ...extra };
    if (extra.entities) {
      caption.caption_entities = extra.entities;
      delete caption.entities;
    }
    const send = clip.type === "video" ? tg.sendVideo : clip.type === "photo" ? tg.sendPhoto : tg.sendAnimation;
    // A file_id if Telegram has already seen this exact clip, the file itself
    // only the first time.
    //
    // `{ source }` is a fresh MULTIPART UPLOAD, and this ran once per alert —
    // so a poll posting eight buys uploaded the same few hundred kilobytes
    // eight times, to the same group, inside a second. Telegram answered what
    // it always answers to that: "429: Too Many Requests: retry after 99", and
    // for those 99 seconds the group got nothing. The bytes never needed to
    // move more than once; every send after the first is a short string.
    const cacheKey = clipKeyOf(clip);
    const known = cacheKey && clipFileIds.get(cacheKey);
    try {
      const sent = await send.call(tg, chatId, known || { source: clip.source }, caption);
      if (cacheKey && !known) {
        const id = fileIdOf(sent);
        if (id) clipFileIds.set(cacheKey, id);
      }
      return sent;
    } catch (e) {
      // A file_id can go stale (Telegram expires them, and a re-upload changes
      // it). Forget it so the next alert re-uploads rather than failing forever
      // on a reference to something that is gone.
      if (cacheKey && known) clipFileIds.delete(cacheKey);
      // A 429 is not the CLIP being rejected — the CHAT is flooded, and the
      // text fallback would hit the same wall: two ops warnings for one event,
      // and a clipless alert where holding off keeps the buy for a retry WITH
      // its artwork. Let it bubble to the flood handler, whose job this is.
      if (retryAfterOf(e)) throw e;
      // A rejected clip must cost the ARTWORK, never the alert. noise: the
      // alert still goes out, and the admin preview reports clip refusals
      // where the operator actually edits the card.
      log.noise(`[buybot] buy clip failed for ${chatId} (${e.message}) — sending the alert as text`);
      // The admin preview passes a reporter here: a clip Telegram refuses (a
      // card too long for a caption, broken entities, a bad file) is invisible
      // from the group — the text fallback looks exactly like "no clip
      // uploaded" — and the preview screen exists to make that visible.
      if (onClipError) await Promise.resolve().then(() => onClipError(e)).catch(() => {});
    }
  }
  return tg.sendMessage(chatId, text, extra);
}

/**
 * Pin a whale alert, replacing the previous one.
 *
 * Unpinning the last one first is what keeps this a HIGHLIGHT: without it every
 * whale of the day accumulates in the group's pinned list, and a pin that is
 * one of thirty is not a pin. Needs "Pin messages"; a group that has not given
 * it is told once, not once per whale.
 */
async function pinAlert(tg, chatId, messageId) {
  const prev = state.pins[String(chatId)];
  try {
    await tg.pinChatMessage(chatId, messageId, { disable_notification: false });
  } catch (e) {
    if (!pinWarned.has(String(chatId))) {
      pinWarned.add(String(chatId));
      log.warn(
        `[buybot] can't pin the whale alert in ${chatId} (${e.message}) — ` +
          `give the bot "Pin messages" there, or turn it off with /buybot pin off`,
      );
    }
    return false;
  }
  if (prev && prev !== messageId) await tg.unpinChatMessage(chatId, prev).catch(() => {});
  state.pins[String(chatId)] = messageId;
  await saveState();
  return true;
}

async function deliver(tg, chatId, payload, dedupeId, opts = {}) {
  // Checked FIRST, and independently of dedupeId: a group that removed the bot
  // must stop costing us Telegram calls even on a path that cannot latch, and
  // the per-transaction claim below only guards repeats of the SAME buy.
  if (latch.isChatMuted(chatId)) return false;
  // Telegram told us to wait. Trying anyway does not merely fail — it RESETS
  // the window, so a bot that retries every poll can stay locked out
  // indefinitely while every buy it was holding ages past MAX_ALERT_AGE_MS and
  // is dropped. That is the shape of "sometimes it posts, sometimes it does
  // not" with buys plainly visible on the chart.
  const until = floodUntil.get(String(chatId)) || 0;
  if (until > now()) return false; // not latched — it is still wanted
  if (dedupeId && !latch.claim(chatId, dedupeId)) return false;
  // Accepts a thunk so the caller can defer rendering until the claim is won.
  // With a `>=` block cursor a quiet pool re-reads its newest block on every
  // poll, so an already-delivered buy would otherwise be re-rendered for every
  // group, every 25 seconds, forever.
  const { text, extra } = payloadArgs(typeof payload === "function" ? payload() : payload, false);
  try {
    const sent = await sendAlert(tg, chatId, text, extra, opts.kind);
    if (!sent || !sent.message_id) {
      // Telegram answered without a message. Not delivered — so do NOT latch,
      // or this buy can never alert again in a group that never saw it.
      if (dedupeId) await latch.release(chatId, dedupeId);
      log.warn(`[buybot] alert to ${chatId} returned no message_id — not latched, will retry`);
      return false;
    }
    if (dedupeId) await latch.commit(chatId, dedupeId);
    // AFTER the latch, never before: a pin that throws must not undo a delivery
    // that succeeded, and the alert is the product — the pin is a nicety.
    if (opts.pin) await pinAlert(tg, chatId, sent.message_id).catch(() => {});
    return true;
  } catch (e) {
    const wait = retryAfterOf(e);
    if (wait) {
      // Release the claim: this buy was NOT delivered, and leaving it claimed
      // would let the latch swallow the retry.
      if (dedupeId) await latch.release(chatId, dedupeId);
      floodUntil.set(String(chatId), now() + wait * 1000);
      // noise: the hold-off IS the handling — waiting exactly as long as
      // Telegram asked — and there is nothing for an operator to do about it.
      log.noise(`[buybot] ${chatId} is rate limited by Telegram — holding off ${wait}s before the next alert`);
      return false;
    }
    if (isFatalChatError(e)) {
      // The bot is not in this chat, or may not speak in it. Mute the whole
      // chat: retrying can never succeed and burns Telegram calls plus the
      // GeckoTerminal budget shared with every healthy group. Muting the CHAT
      // rather than the transaction is what makes one unreachable group cost one
      // mute instead of one failed retry per buy, forever.
      if (dedupeId) await latch.commit(chatId, dedupeId);
      await latch.muteChat(chatId);
      log.warn(
        `[buybot] ${chatId} is unreachable (${describeChatError(e)}) — alerts paused for that group. ` +
          `Re-add the bot there, or run /buybot off.`,
      );
      return false;
    }
    if (dedupeId) {
      const attempts = await latch.release(chatId, dedupeId);
      if (attempts >= latch.MAX_ATTEMPTS) {
        // Permanent for the MESSAGE but not for the chat — an empty saved
        // template, or one whose HTML will not parse. Retrying is doomed, and
        // an undelivered buy holds the pool cursor back, so persisting here
        // would silence the group entirely.
        await latch.commit(chatId, dedupeId);
        log.warn(
          `[buybot] giving up on one alert for ${chatId} after ${attempts} attempts: ${e.message}. ` +
            `If this repeats, check the group_buy_alert template in @dexvraadminbot.`,
        );
        return false;
      }
    }
    log.debug(`[buybot] post to ${chatId} failed (${e.message}) — claim released, will retry`);
    return false;
  }
}

// ── Polling ──────────────────────────────────────────────────────────────────

/** Groups that watch the same token share one pool read. */
function groupByPool(groups) {
  const byPool = new Map();
  for (const g of groups) {
    const key = poolKeyOf(g.chain, g.pairAddress || g.address);
    if (!byPool.has(key)) byPool.set(key, { key, chain: g.chain, address: g.address, pool: g.pairAddress || null, groups: [] });
    const entry = byPool.get(key);
    entry.groups.push(g);
    if (!entry.pool && g.pairAddress) entry.pool = g.pairAddress;
  }
  return [...byPool.values()];
}

function noteDeadPool(entry) {
  const last = deadLog[entry.key] || 0;
  if (now() - last <= 3_600_000) return;
  deadLog[entry.key] = now();
  // gtTrades already logged the specific reason (rate limit / HTTP status /
  // timeout), throttled per pool. This is the once-an-hour reminder that a
  // configured, paying group has been getting nothing for a while, which is a
  // different fact and the one an operator scanning logs needs to see.
  log.warn(
    `[buybot] ${entry.chain}/${entry.address}: no buy alerts this hour — the trades feed has not ` +
      `been readable (${entry.groups.length} group(s) affected)`,
  );
}

/**
 * Returns true when this pool was handled (whether or not anything posted),
 * false when the feed was unreadable — in which case nothing is posted and the
 * cursor stays put, so the buys are still selectable on the next working poll.
 */
async function pollTrades(tg, entry) {
  const net = gt.networkOf(entry.chain);
  if (!entry.pool) return false;

  const minUsd = Math.min(...entry.groups.map((g) => cfg.minBuyOf(g)));
  const cursorNow = state.cursors[entry.key] || null;
  const startedAt = now();
  // DECLARED, because this file is sloppy-mode CommonJS and these two were not.
  // `buys = …` on an undeclared name writes globalThis, and scanOnce walks every
  // pool sequentially in ONE process — so the value survived into the next pool:
  //
  //   • A chain with no chainTrades reader never entered the block below, read
  //     the PREVIOUS pool's array at `buys === null`, and therefore skipped its
  //     only feed — then posted that other pool's buys, buyers and tx hashes
  //     into this group, repriced at this token's price, behind this chain's
  //     explorer link. A wrong alert in a customer's chat, from a token they
  //     do not track.
  //   • On the first such pool in a fresh process there is no previous value at
  //     all, so it was a ReferenceError — swallowed by scanOnce's
  //     .catch(log.debug), which prints nothing without DEBUG. Silent.
  let buys = null;
  let source = null;

  // THE CHAIN FIRST, AND WITHOUT A PRICE.
  //
  // Reading a swap needs no dollar figure — only deciding whether it clears a
  // group's floor does. The first cut gated the chain read on fetchPoolCached
  // returning a price, which put GeckoTerminal back on the trade path through
  // the back door: a GT cooldown made the snapshot unavailable, so the chain
  // reader was never even CALLED, and the pool fell through to the GT trades
  // feed — which was cooled down too. A pool with a perfectly healthy RPC went
  // quiet because an indexer it no longer needs was rate limited.
  //
  // So the trades come off the chain unpriced, and the price is applied below,
  // only once there is something to price.
  if (chainTrades.supports(entry.chain)) {
    buys = await chainTrades
      .fetchPoolBuys(entry.chain, entry.pool, entry.address, {
        sinceBlock: (cursorNow && cursorNow.b) || 0,
        sinceSig: (cursorNow && cursorNow.sig) || null,
      })
      .catch(() => null);
    if (buys !== null) source = "chain";
  }
  // Only when the chain could not be read — a missing library, every endpoint
  // down, a pool shape we do not decode. The indexer stays as the second
  // opinion rather than the only one.
  if (buys === null && net) {
    buys = await trades.fetchPoolBuys(net, entry.pool, entry.address, { minUsd }).catch(() => null);
    if (buys !== null) source = "indexer";
  }
  if (buys === null) return false; // unavailable — degrade

  const cursor = state.cursors[entry.key] || null;
  if (!buys.length) {
    // Still seed a cursor. Without one, an idle pool looks like first sight on
    // every poll and replays its entire backlog the moment it finally trades.
    if (!cursor) {
      state.cursors[entry.key] = { b: 0, t: now() };
      await saveState();
    }
    return true;
  }

  const fresh = selectFresh(cursor, buys, now(), minUsd);
  const newest = buys[buys.length - 1].blockNumber || 0;
  // Solana has no "read from block N" — getSignaturesForAddress walks BACK
  // until it recognises a signature. Carrying the newest one is what stops each
  // poll re-reading the same window, and slots alone cannot do it: several
  // transactions share a slot.
  const newestSig = buys[buys.length - 1].txHash || null;
  if (!fresh.length) {
    // Everything filtered out (too old, or already past). The cursor still
    // advances to the newest block seen, so the next poll does not re-read it.
    state.cursors[entry.key] = { b: newest, t: now(), sig: newestSig };
    await saveState();
    return true;
  }

  // Priced only NOW, and only because there is something to price. A quiet pool
  // never asks an indexer anything.
  let pool = await gt.fetchPoolCached(entry.chain, entry.address);
  // The indexer does not know every token, and a group whose pool was found on
  // the chain has one it has never heard of by definition. Without this the
  // buys read perfectly and are then held forever waiting for a price that is
  // never coming — silence that looks exactly like a broken bot. The pool
  // itself knows what the token is worth.
  if (!pool || !(pool.priceUsd > 0)) {
    pool = await chainPools.readPool(entry.chain, entry.pool, entry.address).catch(() => null);
  }
  if (!pool || !(pool.priceUsd > 0)) {
    // HOLD the buys rather than drop them, and do NOT advance the cursor: they
    // are real, and the next poll can price them.
    log.debug(`[buybot] ${entry.key}: ${fresh.length} new buy(s) held — no price this cycle`);
    return true;
  }
  if (source === "chain") {
    // The chain knows amounts, not dollars. This is the POOL's price, so the
    // USD on the card and the price printed beside it come from one number
    // instead of disagreeing.
    for (const b of fresh) {
      b.priceUsd = pool.priceUsd;
      b.usd = b.tokenAmount * pool.priceUsd;
      // Naming what they paid with lets the card print "(0.34 SOL)" instead of
      // deriving one from USD, which is invented precision.
      if (!b.spentToken) b.spentToken = pool.counterAddress || "";
    }
  }

  let posted = 0;
  // The lowest block still holding an undelivered buy. The cursor must not move
  // past it: a 429 on an OLDER buy while a NEWER one succeeds would otherwise
  // advance the cursor beyond the failure, and the retry that
  // alertLatch.release() exists to allow could never be selected again — the
  // alert is lost, silently, in a healthy group. Re-reading a few delivered
  // blocks costs nothing, because the latch skips them.
  let hold = null;
  for (const buy of fresh) {
    // Resolved ONCE per buy, not per group: the holding is a property of the
    // WALLET and the token, and several groups can track the same token — but
    // it is looked up on behalf of a group that actually wants it, so one group
    // running /setwhale off cannot suppress the lookup for the others sharing
    // this pool.
    const wants = entry.groups.find((x) => x.whales !== false) || entry.groups[0];
    const pos = await buyerPosition(wants, buy, pool).catch(() => null);
    // Once per buy, not per group: whether the TOKEN is on dexvra.io is a
    // property of the token. Cached upstream, so a quiet pool costs nothing.
    for (const g of entry.groups) {
      if (buy.usd < cfg.minBuyOf(g)) continue; // each group's own threshold
      // A group that turned holdings off gets neither the whale card nor the
      // 💼 Position row, even though a neighbour paid for the lookup.
      const gPos = g.whales === false ? null : pos;
      // The BAR is per group. Resolving the verdict once for everyone was
      // wrong the moment two groups on the same pool set different bars: the
      // second group got the first group's answer.
      const whale = gPos && gPos.holdsUsd >= whaleBarFor(g) ? { ...gPos, threshold: whaleBarFor(g) } : null;
      const isWhale = !!whale;
      const render = () => (isWhale ? renderWhaleAlert(g, buy, pool, whale) : renderRealAlert(g, buy, pool, gPos));
      // The CLIP follows the size tier as well as the wallet verdict: a card
      // headed MEGA BUY that plays the ordinary "new buy" artwork contradicts
      // its own headline, and the operator uploaded a whale clip precisely so a
      // big buy looks different scrolling past.
      //
      // PINNING deliberately does NOT move with it. Pinning writes to somebody
      // else's group, and widening it to every mega buy would start pinning in
      // every existing customer's chat without them asking — so it stays tied
      // to the whale-by-WALLET verdict it has always meant.
      const opts = {
        kind: isWhale || isBigBuy(buy.usd) ? "whale" : "buy",
        pin: isWhale && g.pin !== false && BUYBOT_PIN_WHALES,
      };
      if (await deliver(tg, g.chatId, render, buy.txHash, opts)) {
        posted++;
        continue;
      }
      // Not delivered AND not latched → still wanted. (A fatal chat error
      // latches, so a group that removed the bot never holds the cursor back.)
      if (!latch.isDelivered(g.chatId, buy.txHash) && buy.blockNumber) {
        hold = hold === null ? buy.blockNumber : Math.min(hold, buy.blockNumber);
      }
    }
  }
  // Where the cursor lands, in order of precedence:
  //   hold      — an undelivered buy still needs retrying (see above)
  //   lastSent  — the batch was capped, so the rest come next poll
  //   newest    — everything in the feed is accounted for
  const lastSent = fresh[fresh.length - 1].blockNumber || 0;
  const capped = fresh.length === MAX_PER_POLL && lastSent < newest;
  const cursorBlock = hold !== null ? hold : capped ? lastSent : newest;
  state.cursors[entry.key] = { b: cursorBlock, t: now(), sig: newestSig };
  await saveState();
  if (capped) log.info(`[buybot] ${entry.key}: paced — more buys queued for the next poll`);
  // A poll that takes longer than the interval means the group is being served
  // a backlog, not a feed: each alert is staler than the last and the gap only
  // grows. Say so — this is the shape the first chain reader failed in, and it
  // looked identical to "the pool is quiet" from the outside.
  const took = now() - startedAt;
  if (took > BUYBOT_POOL_MIN_MS) {
    log.warn(
      `[buybot] ${entry.key}: poll took ${Math.round(took / 1000)}s, longer than the ${Math.round(BUYBOT_POOL_MIN_MS / 1000)}s ` +
        "interval — alerts will run late. A faster RPC endpoint is the fix (RPC_<CHAIN> in .env).",
    );
  }
  if (posted) {
    log.info(
      `[buybot] verified ${entry.chain} buys via ${source} in ${Date.now() - startedAt}ms: ` +
        `feed=${buys.length} fresh=${fresh.length} posted=${posted} pool=${entry.pool}`,
    );
  }
  return true;
}

async function pollPool(tg, entry) {
  // One read per pool per window, independent of how many groups watch it and
  // of how fast the outer loop runs. GT's free tier is ~30 requests/minute for
  // the whole process, shared with the listing and trending pipelines.
  const last = lastPoll.get(entry.key) || 0;
  if (now() - last < BUYBOT_POOL_MIN_MS) return;
  lastPoll.set(entry.key, now());

  // Self-heal ONLY a MISSING pool address. A transient GT/DS timeout looks
  // identical to a 404, so never repoint a pool an admin resolved just because
  // one poll produced a different (or no) result.
  const needsLabel = entry.groups.some((g) => !g.sym || !g.name);
  if (!entry.pool || needsLabel) {
    const resolved = await gt.fetchPoolCached(entry.chain, entry.address);
    if (resolved && resolved.poolAddress) {
      if (!entry.pool) entry.pool = resolved.poolAddress;
      // The NAME needs its own lookup, so it is only made when something is
      // actually missing — never on the hot path.
      const info = needsLabel ? await gt.fetchTokenInfo(entry.chain, entry.address).catch(() => null) : null;
      for (const g of entry.groups) {
        const patch = {};
        if (!g.pairAddress) patch.pairAddress = resolved.poolAddress;
        // Backfills groups configured before these were captured, which would
        // otherwise be stuck reading "$TOKEN" forever.
        const sym = (info && info.symbol) || resolved.symbol;
        const name = (info && info.name) || resolved.name;
        if (!g.sym && sym) patch.sym = sym;
        if (!g.name && name) patch.name = name;
        if (Object.keys(patch).length) {
          Object.assign(g, patch);
          await cfg.upsert(g.chatId, patch);
        }
      }
      log.info(`[buybot] self-healed ${entry.chain}/${entry.address} → pool ${resolved.poolAddress} ${resolved.symbol || ""}`);
    }
  }

  // The feed could not be read. NOTHING IS POSTED — see the file header. The
  // cursor has not moved, so these buys post for real, with their hashes, on
  // the first poll that works, as long as that lands within MAX_ALERT_AGE_MS.
  // What must not happen is the group being handed a summary it cannot check.
  if (!(await pollTrades(tg, entry))) noteDeadPool(entry);
}

async function scanOnce(tg) {
  for (const entry of groupByPool(cfg.active())) {
    await pollPool(tg, entry).catch((e) => log.debug(`[buybot] ${entry.key}: ${e.message}`));
    await sleep(300); // be polite to GT/DexScreener
  }
}

function start(tg) {
  // A scan that outruns its own interval must not stack: the pool throttle
  // would still bound the requests, but two scans interleaved would double
  // every claim/commit round trip for no benefit.
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await scanOnce(tg);
    } catch (e) {
      log.debug(`[buybot] ${e.message}`);
    } finally {
      busy = false;
    }
  };
  const iv = setInterval(run, GROUP_BUYBOT_CHECK_MS);
  const kick = setTimeout(run, 25_000);
  return {
    stop: () => {
      clearInterval(iv);
      clearTimeout(kick);
    },
  };
}

module.exports = {
  start,
  scanOnce,
  selectFresh,
  buyEmojiRow,
  buySizeBar,
  buyBarStyle,
  buyTiers,
  tierFor,
  tierKey,
  isBigBuy,
  buyIconFor,
  groupByPool,
  verifyRow,
  spentNative,
  pinAlert,
  alertVars,
  positionRow,
  buyerPosition,
  whaleBarFor,
  whaleCheck,
  renderWhaleAlert,
  buyClip,
  DEFAULT_CLIP_KIND,
  sendAlert,
  deliver,
  renderRealAlert,
  _pollTrades: pollTrades,
  FIRST_SIGHT_MS,
  FIRST_SIGHT_MAX,
  _state: state,
};
