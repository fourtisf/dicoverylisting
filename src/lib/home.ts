// What the homepage SHOWS — the selection rules, kept pure and out of the
// components so they can be tested by execution rather than by reading JSX.
//
// Every rule below is a claim the page makes to somebody deciding where to put
// money, so each one is a statement that has to be true:
//
//   · a "Top Loser" that is UP is a false statement, not a thin day;
//   · a market-cap ranking that includes a token whose cap could not be read
//     puts it at the bottom claiming to be worth nothing;
//   · a list that is cut to ten rows and does not say so reads as "that is all
//     there is".
//
// The board pages (/trending, /new-listings) stay the full, uncapped views —
// the home lists are a doorway to them, which is why every cap carries its
// total and every section carries a way through.
import { CHAIN_IDS } from "../config/chains.ts";
import type { BoardToken, PeriodKey } from "./types.ts";

/**
 * The largest 24h/period change the board will SHOW or RANK as a real reading.
 *
 * ⚠️ GeckoTerminal handed the board +5,191,162% for $MONA — an $8-volume,
 * $0-liquidity pool whose "price" is measured from a near-zero opening tick —
 * and, unbounded, that raw number crowned a dead token #1 with a five-million-
 * percent gain. The bot's `marketdata.js` refuses the identical figure over the
 * identical bound. Above it the change is UNREADABLE: a dash, never a number,
 * and the sort sinks it rather than ranking it. Doctrine, twice over: an
 * unreadable change is not a printed 0%, and it is certainly not a record gain.
 */
export const SANE_CHANGE_PCT = 5000;

/** Chains offered on the home filter before "+N more". Six fits one row on a
 *  laptop; the rest are one tap away. The wall of 23 wrapped pills the page
 *  used to open with is what "jangan terlalu banyak chain" was about. */
export const HOME_CHAIN_LIMIT = 6;

/** Rows the home board opens on, before the expander. */
export const HOME_BOARD_ROWS = 10;

/** …and the most it will ever grow to in place.
 *
 *  Past this the page stops being a doorway and becomes the /trending board
 *  with worse chrome, so anything beyond 15 keeps its "View all" link — the
 *  expander is a convenience, never a replacement for the full board. */
export const HOME_TRENDING_MAX = 15;

/** Rows a mover card holds. The card is short and scrolls inside itself, so
 *  this is how much there is to scroll — not how much fits on screen. */
export const MOVER_ROWS = 10;

export interface ChainCount {
  id: string;
  count: number;
}

/**
 * The chains that actually have listings, most-populated first.
 *
 * ⚠️ The tie-break is the registry order, never the insertion order of a Map
 * built from a freshly-fetched array. `/api/tokens` is re-polled every 30s and
 * a plain count sort leaves equal-count chains in whatever order that poll
 * happened to return — so the pill under the cursor moves as you reach for it.
 * A filter row that reshuffles itself is indistinguishable from a misclick.
 */
export function chainCounts(tokens: readonly BoardToken[]): ChainCount[] {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t.chain, (counts.get(t.chain) ?? 0) + 1);
  const rank = (id: string) => {
    const i = CHAIN_IDS.indexOf(id);
    return i === -1 ? CHAIN_IDS.length : i; // an unregistered chain sorts last
  };
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/** The chain row, split into what is shown and what "+N more" reveals.
 *
 *  The row leads with the chains that HAVE listings; "+N more" then reveals
 *  EVERY registered chain, the empty ones included, each carrying its count —
 *  a `0` states before the tap why the board will be empty. Hiding the empty
 *  chains entirely (the first cut) read as "Dexvra only supports five chains",
 *  which is the opposite of what the registry says; a tapped empty chain lands
 *  on an honest "nothing listed here yet", which is an invitation, not a
 *  failure. */
export function splitChains(
  counts: readonly ChainCount[],
  limit = HOME_CHAIN_LIMIT,
): { shown: ChainCount[]; hidden: ChainCount[] } {
  const populated = new Set(counts.map((c) => c.id));
  const empty = CHAIN_IDS.filter((id) => !populated.has(id)).map((id) => ({ id, count: 0 }));
  return { shown: counts.slice(0, limit), hidden: [...counts.slice(limit), ...empty] };
}

/** A chain filter that survives its chain losing every listing mid-session.
 *  Any REGISTERED chain is a legal selection — its pill is always on the row
 *  now, so the board shows the honest empty state with the control still on
 *  screen. Only an id the registry has never heard of falls back to "all". */
export function resolveChain(chain: string, _counts: readonly ChainCount[]): string {
  if (chain === "all") return "all";
  return CHAIN_IDS.includes(chain) ? chain : "all";
}

export const inChain = (chain: string) => (t: BoardToken) => chain === "all" || t.chain === chain;

export type MoverKind = "gainers" | "losers" | "fresh";

/**
 * A mover list.
 *
 * ⚠️ `gainers` keeps only tokens that are actually UP and `losers` only those
 * actually DOWN. Sorting by change and slicing looks equivalent and is not: on
 * a green day it fills "Top Losers" with the three least-green tokens, every
 * one of them wearing a red-flavoured slot while printing a plus sign. An
 * empty card saying "nothing is down on this timeframe" is the honest answer,
 * and it is also the more useful one.
 *
 * A change of exactly zero belongs to neither list.
 */
export function movers(
  tokens: readonly BoardToken[],
  kind: MoverKind,
  frame: PeriodKey,
  limit = MOVER_ROWS,
): BoardToken[] {
  if (kind === "fresh") {
    // "New" means newly LISTED on Dexvra, not a new pair on chain — the
    // product is paid listings, and ageMinutes would rank a week-old pair
    // that listed an hour ago below a launch nobody has paid for.
    return [...tokens].sort((a, b) => a.listedMinutesAgo - b.listedMinutesAgo).slice(0, limit);
  }
  const up = kind === "gainers";
  // Ranked by the READING, not the raw field: a "Top Gainer" measured through
  // the sane bound, so a near-dead pool's absurd figure never leads the list.
  //
  // …and through `tradedEnough`, which is the same rule at the other end of the
  // scale. "Top Gainer" is a CLAIM, and a token that traded five cents in a day
  // cannot support it at +465% any more than at +5,000,000%. Here the quiet
  // token is left OUT rather than demoted: this is a curated ten, not a board a
  // reader scrolls, and there is no honest place in a top-ten for a row whose
  // number means nothing. (On the full board it is demoted instead — see
  // `changeRank`, and note that -Infinity would otherwise top the LOSERS.)
  return tokens
    .filter(tradedEnough)
    .map((t) => ({ t, r: changeReading(t, frame) }))
    .filter((x): x is { t: BoardToken; r: number } => x.r != null && (up ? x.r > 0 : x.r < 0))
    .sort((a, b) => (up ? b.r - a.r : a.r - b.r))
    .map((x) => x.t)
    .slice(0, limit);
}

export type CoinSort = "mcap" | "vol" | "score";

export interface TopCoins {
  rows: BoardToken[];
  /** How many were left out for having no readable market cap. */
  unpriced: number;
}

/**
 * The Top Coins ranking.
 *
 * ⚠️ A token whose market cap could not be read is LEFT OUT of a market-cap
 * ranking, never coerced to 0. `mcap ?? 0` sorts it to the bottom of the list,
 * where it reads as the smallest project on the board rather than as one we
 * could not price — the same lie the trending board printed for months as a
 * fabricated 0%. It is counted and the count is rendered, because a row that
 * silently disappears is worse than one that says why.
 *
 * The volume and score rankings have no such exclusion: both figures are always
 * present, and a genuinely idle token belongs at the bottom of a volume list.
 */
export function topCoins(
  tokens: readonly BoardToken[],
  sort: CoinSort,
  period: PeriodKey = "24h",
  limit = HOME_BOARD_ROWS,
): TopCoins {
  const priced = sort === "mcap" ? tokens.filter((t) => t.mcap != null) : [...tokens];
  // ⚠️ A MARKET CAP IS A CLAIM, AND A DEAD POOL CANNOT SUPPORT ONE.
  //
  // The board was reported opening on `$AI Barking Puppy $2.41B`, two copies of
  // `$BONK`, and `$TRUMP OFFER TRUTH $1.84B` — whose token page reads
  // `VOL·24H $5 · TXNS·24H 2 · HOLDERS 0`. A cap is price × supply, and on a
  // token nobody trades the price is whatever the last five dollars said, so
  // the number is arbitrarily large and completely unearned.
  //
  // This is the `$MRNA +465% on $0.05 of volume` defect exactly, one COLUMN
  // over: `changeRank` grew `tradedEnough` for the percentage ranking and
  // stopped there, on the reasoning that "on VOLUME or SCORE an idle token
  // sinks by itself". True of those two — and market cap is a third ranking
  // where an idle token FLOATS, for the same reason a change ranking does.
  //
  // ⚠️ IT DEMOTES, IT NEVER HIDES — `changeRank`'s rule, and the same reason:
  // these boards carry paying customers, and a listing that vanished because
  // its pool was quiet today is a refund conversation. The row keeps its real
  // cap in its own column; it just cannot lead a board it has not earned.
  const quiet = sort === "mcap" ? (t: BoardToken) => !tradedEnough(t) : () => false;
  const val = (t: BoardToken): number =>
    sort === "mcap" ? (t.mcap ?? 0) : sort === "vol" ? t.vol[period] : t.score;
  const rank = (t: BoardToken): number => (quiet(t) ? -Infinity : val(t));
  const sorted = [...priced].sort(
    (a, b) =>
      // ⚠️ `-Infinity - -Infinity` is NaN, and a NaN comparator scrambles the
      // whole list rather than tying — so the demoted rows are separated first
      // and only then compared on their real value. The unrankable comparator
      // one function up has this exact scar.
      Number(quiet(a)) - Number(quiet(b)) || rank(b) - rank(a) || val(b) - val(a) ||
      a.symbol.localeCompare(b.symbol),
  );
  // ⚠️ `limit` of 0 means NO CAP — the same contract `capped()` states, because
  // "Show all" passes 0. `slice(0, 0)` is the empty array, so the unconditional
  // slice this replaces answered an expanded table with zero rows and the
  // "nothing here has a readable market cap" empty state. Caught by clicking
  // the button, not by reading the code.
  const rows = limit > 0 ? sorted.slice(0, limit) : sorted;
  return { rows, unpriced: sort === "mcap" ? tokens.length - priced.length : 0 };
}

export interface Capped<T> {
  rows: T[];
  total: number;
  hidden: number;
}

/** Cut a list to `limit` and carry what was cut. Never a silent cap: the
 *  caller renders "Showing N of M", so a short list reads as a short list and
 *  a cut one reads as a doorway. */
export function capped<T>(list: readonly T[], limit: number): Capped<T> {
  const rows = limit > 0 ? list.slice(0, limit) : [...list];
  return { rows, total: list.length, hidden: Math.max(0, list.length - rows.length) };
}

/** "12s ago" for the live stamp. `updatedAt` is a server clock and a client
 *  whose clock is behind would otherwise render a negative age. */
export function freshness(updatedAt: number | undefined, now = Date.now()): string {
  if (!updatedAt) return "…";
  const s = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/**
 * What the board's footer says and does.
 *
 * `reveal` is what the button PROMISES — the row count it will actually show —
 * so a board of 40 listings offers "Show all 15" and not "Show all 40" it
 * cannot deliver. `beyond` is what even the expanded board leaves out, and it
 * is what keeps the "View all" link honest: the cap moved, it did not vanish.
 */
export function expander(total: number, base: number, max: number) {
  const open = Math.min(total, max > 0 ? max : total);
  return {
    /** rows to render when collapsed / expanded */
    collapsed: Math.min(total, base),
    expanded: open,
    /** is there anything to expand at all? */
    canExpand: open > Math.min(total, base),
    /** the number the button names */
    reveal: open,
    /** still not shown once expanded — the full board is the only home for it */
    beyond: Math.max(0, total - open),
    /** ⚠️ Does the expander really show EVERYTHING? On 40 listings it does not,
     *  and "Show all 15" would then be the silent cap with a label on it —
     *  the exact thing the footer exists to prevent. The word "all" is a
     *  claim, so it is only made when it is true. */
    showsAll: total - open <= 0,
  };
}

/**
 * The change a renderer may PRINT for a token on a frame — or null.
 *
 * A fallback row (source "seed") carries chg 0 not because anything was
 * measured flat but because nothing was measured at all, and "▲ 0.0%" on a
 * one-hour-old listing is a fabricated reading — the bot repo's "an unreadable
 * change is not a 0%" rule, on the web surface. Null tells the renderer to
 * draw a dash.
 *
 * A LIVE token at exactly 0 keeps its zero: that is a measured flat, and
 * refusing to print it would hide a real reading. A seed token with a nonzero
 * captured change also prints — the demo board is built from those.
 */
/**
 * The MONEY figure a renderer may print for a token — or null.
 *
 * `changeReading`'s rule, one column over, and it exists because of a board of
 * Robinhood listings rendering `$0` price · `$0` MCAP · `$0` VOL on every row:
 * those zeros were the store's captured-at-listing defaults on rows no
 * provider had priced this cycle, and `$0` on a public board is a claim nobody
 * measured — the "vol 0 padahal ada transaksi" defect, one field over. A LIVE
 * zero stays a zero (a measured quiet day is a fact); a zero from a row whose
 * source never measured anything is a dash.
 */
export function figureReading(t: Pick<BoardToken, "source">, v: number | null): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v === 0 && t.source !== "live") return null;
  return v;
}

export function changeReading(t: BoardToken, frame: PeriodKey): number | null {
  const v = t.chg[frame];
  if (!Number.isFinite(v)) return null;
  // An absurd figure off a near-dead pool is unreadable, not a gain — the one
  // gate every renderer AND the sort go through, so a five-million-percent
  // reading can neither be printed nor crowned #1. See SANE_CHANGE_PCT.
  if (Math.abs(v) > SANE_CHANGE_PCT) return null;
  if (v === 0 && t.source !== "live") return null;
  return v;
}

/**
 * How much 24h volume a percentage needs behind it before it may RANK a board.
 *
 * ⚠️ THE SANE BOUND CAUGHT THE ABSURD FIGURES AND MISSED THE QUIET ONES.
 * `SANE_CHANGE_PCT` exists because "an absurd figure off a near-dead pool is
 * unreadable, not a gain". The pool being near-dead is the actual defect;
 * 5,000% was only the symptom that happened to get reported first. The home
 * board opens sorted by 24h change, and it published this:
 *
 *   #1  $MRNA   +465.0%   MCAP $157.7K   VOL $0.05   10 txns
 *   #2  $GOOGL  +164.0%   MCAP  $66.4K   VOL $0.04    8 txns
 *
 * Five cents of trading in a day, crowning the board over real markets. Both
 * readings are under the sane bound, both are legal, and neither means
 * anything: a percentage is a claim about a market, and there was no market.
 *
 * `home.ts` already argued the other half of this and stopped one step short —
 * idle tokens are deliberately not excluded from the VOLUME or SCORE rankings,
 * which is right, because on those an idle token sinks by itself. On a CHANGE
 * ranking it floats to the top instead, and that is the case this covers.
 *
 * $1,000 is deliberately far below anything a reader would call busy — the
 * rows this was reported for are three to five ORDERS of magnitude under it —
 * because this is a ranking floor, not an eligibility one.
 */
export const RANK_MIN_VOL_USD = 1_000;

/**
 * Did enough trading happen for this token's percentage to mean anything?
 *
 * Judged on 24h volume whatever frame is being ranked, on purpose: a token with
 * five cents of trading in a DAY has no meaningful five-minute move either, and
 * a per-period floor would need a per-period number nobody could defend.
 *
 * ⚠️ AN UNREADABLE VOLUME IS NOT A SMALL ONE. A token whose volume nobody
 * published answers `true` — demoting it would silently sink every listing on a
 * chain no indexer covers, which is the exemption the bot's trending floors
 * make one process over, for the same reason and in the same words. This one is
 * a RANKING rule with no operator behind it, so it fails open; the bot's is a
 * floor an operator explicitly set, so that one fails closed.
 *
 * ⚠️ …AND ON TODAY'S DATA THAT BRANCH IS A SAFETY NET, NOT A LIVE PATH, because
 * the producers destroy the distinction before it gets here: `BoardToken.vol` is
 * `Record<PeriodKey, number>` with no room for a null, so `poolstrade.ts`
 * (`l.vol24h ?? 0`) turns a launchpad that published no volume into a measured
 * zero. Said out loud rather than left as a comment describing a state that
 * cannot occur — the reader after this one would otherwise trust an exemption
 * that never fires. What it costs today: a Robinhood bonding-curve launch whose
 * pad publishes a 24h CHANGE and no 24h VOLUME ranks as quiet. It still renders,
 * with its own percentage; it just cannot lead a board. Making that honest means
 * widening the type, which is a change to every producer and every consumer of
 * `vol`, and it is not what was reported.
 */
export function tradedEnough(t: BoardToken): boolean {
  const vol24 = t.vol["24h"];
  return !Number.isFinite(vol24) || vol24 >= RANK_MIN_VOL_USD;
}

/**
 * The change a full BOARD SORT may use, as opposed to the one a cell prints.
 *
 * ⚠️ IT DEMOTES, IT NEVER HIDES. A row under the floor keeps its real
 * percentage in its own column — `changeReading` is untouched and is still the
 * one owner of what is printed — and simply cannot outrank a token that
 * actually traded. Dropping the row would be a different and worse product:
 * these boards carry paying customers, and a listing that vanishes from the
 * site because its pool was quiet today is a refund conversation. `-Infinity`
 * is what this sort already uses for an unreadable change, so a demoted row
 * lands in exactly the company it belongs in.
 *
 * ⚠️ NOT FOR THE GAINERS/LOSERS RAILS. `-Infinity` is less than zero, so a
 * demoted row fed to a "Top Losers" filter would be CROWNED by it — the fix
 * producing a worse version of the bug it fixes, on the surface next door.
 * Those rails are a curated ten, not a full board, so there the right move is
 * to leave a quiet token out entirely: `movers` filters on `tradedEnough`.
 */
export function changeRank(t: BoardToken, frame: PeriodKey): number {
  const r = changeReading(t, frame);
  if (r == null) return -Infinity;
  return tradedEnough(t) ? r : -Infinity;
}

/**
 * A whole list ranked by change, biggest first (`dir` -1) or smallest first
 * (`dir` 1) — the /trending "Top Gainers / Top Losers" board.
 *
 * ⚠️ IT EXISTS BECAUSE THAT PAGE HAD ITS OWN COPY, and the copy read the RAW
 * field: `b.chg[frame] - a.chg[frame]`. So the page whose entire heading is
 * "Top Gainers" was the one surface that went through NEITHER gate — a
 * five-million-percent figure off a near-dead pool could lead it, which
 * `SANE_CHANGE_PCT` was written to stop everywhere else, and `$MRNA +465%` on
 * five cents took its 🥇 medal. Three private copies of "which change may rank
 * this" is how the trending board's fabricated-percentage saga went three
 * rounds; this is the second copy, deleted.
 *
 * An unrankable row sinks in BOTH directions — `-Infinity` is less than
 * everything, so on the LOSERS tab it would otherwise be crowned, which is the
 * fix producing a worse version of the bug it fixes. Same rule as the board's
 * comparator, and the same reason `movers` excludes rather than demotes.
 */
export function byChange(tokens: readonly BoardToken[], frame: PeriodKey, dir: 1 | -1): BoardToken[] {
  return [...tokens].sort((a, b) => {
    const va = changeRank(a, frame);
    const vb = changeRank(b, frame);
    const ua = !Number.isFinite(va);
    const ub = !Number.isFinite(vb);
    if (ua || ub) return ua && ub ? 0 : ua ? 1 : -1;
    return (vb - va) * -dir;
  });
}
