/**
 * IS THIS THE MONEY, OR IS IT A PROJECT?
 *
 * `$WTRX · $M21NT · $LGNS · $SHIB · $BTCB · $PUMP · $USDG` — the Top Coins
 * board, opened on Wrapped TRX and carrying Global Dollar. Reported as
 * "hapus stable coin".
 *
 * The bot has answered this question since the market filler was written
 * (`bot/src/services/bigCoins.js`): GeckoTerminal ranks POOLS, so the top of
 * any chain is WETH, USDC, wstETH, cbBTC, and a board whose Ethereum section
 * reads `WETH · USDC · USDT` is worse than one with three rows. **The site
 * never had the rule at all** — so the filler refuses to LIST them while the
 * site happily ranked the ones listed before that rule existed.
 *
 * ⚠️ THIS IS A PORT, AND A PORT IS A SECOND OWNER. The bot is a separate
 * CommonJS package this build cannot import, so `notAProject.test.ts` reads
 * `bigCoins.js` and asserts the two lists are EQUAL — the same guard
 * `market:check`'s ported chain map carries, and for the same reason: a rule
 * that drifts between two copies is worse than a rule in one place only,
 * because both look right.
 *
 * Every scar below is the bot's, kept verbatim rather than re-earned.
 */

/** Kept in the bot's own order and grouping so a diff between them is readable. */
export const NOT_A_PROJECT = new Set([
  // stables
  "USDT", "USDC", "DAI", "BUSD", "TUSD", "FDUSD", "USDE", "SUSDE", "USDS", "USDBC", "USDT0",
  "PYUSD", "LUSD", "GUSD", "USDD", "FRAX", "CRVUSD", "GHO", "USD1", "EURC", "EURS", "USDG",
  // natives + their wrappers
  "ETH", "WETH", "BTC", "WBTC", "CBBTC", "TBTC", "BTCB", "BNB", "WBNB", "SOL", "WSOL", "MSOL",
  "MATIC", "WMATIC", "POL", "AVAX", "WAVAX", "TRX", "WTRX", "TON", "WTON", "SUI", "WSUI", "XPL", "WXPL",
  // liquid staking / restaking receipts
  "STETH", "WSTETH", "RETH", "CBETH", "WEETH", "EETH", "EZETH", "RSETH", "METH", "SFRXETH", "FRXETH",
  "JITOSOL", "BSOL", "JUPSOL", "INF", "SLISBNB", "ASBNB", "BNBX",
]);

const WRAPPER_NAME = /^(wrapped|staked|bridged|rebasing|liquid staked|restaked)\b/i;

/**
 * ⚠️ THE CURRENCY GLYPHS ARE TRANSLITERATED, NOT STRIPPED.
 *
 * `$USDT` and `$USDC` reached the bot's public board at $185B and $76B. The
 * filter was right and never saw them: Tether's omnichain token is branded
 * **USD₮0** — U+20AE, not a T — so `NOT_A_PROJECT.has("USD₮0")` is false, and
 * the site then rendered it as `$USDT` because the ticker sanitiser strips the
 * ₮ on the way in. The symbol JUDGED and the symbol PUBLISHED were different
 * strings, which is why nothing looked wrong at either end.
 *
 * The bot's first cut deleted every non-alphanumeric, so `USD₮0` folded to
 * `USD0` — still not `USDT`, still not refused, and it would have shipped
 * looking like it worked. ₮ IS a T.
 */
const CONFUSABLE: Record<string, string> = {
  "₮": "T", "₿": "B", "Ξ": "E", "₳": "A", "＄": "S", "$": "S", "€": "E", "£": "L",
};

export const fold = (sym: string | null | undefined): string =>
  String(sym || "")
    .replace(/[₮₿Ξ₳＄$€£]/g, (c) => CONFUSABLE[c] || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

/**
 * A stable/wrapper ISSUER, not a word that might appear in a memecoin's name.
 *
 * ⚠️ Anchored and deliberately blunt: `^tether\b` catches every spelling Tether
 * ships, and it also catches a memecoin called "Tether Killer". That is the
 * trade, taken knowingly — the cost of a false positive is one auto-listing
 * nobody misses, and the cost of a false negative is a $185B stablecoin sitting
 * on a public board being sold as a find. A PAID listing is never judged by it
 * (see `hideFromBoard`), so the blunt edge cannot cost anybody their money.
 */
const MONEY_NAME =
  /^(tether|usd coin|circle|binance[- ]peg|bridged|wrapped|staked|rebasing|liquid staked|restaked|first digital|paypal usd|ethena usde|sky dollar|dai stablecoin|global dollar)\b/i;

/** Is this the money rather than the project? */
export function notAProject(sym: string | null | undefined, name?: string | null): boolean {
  const s = fold(sym);
  if (NOT_A_PROJECT.has(s)) return true;
  // USD₮0 folds to USDT0, USDC.e to USDCE — a bridged or versioned wrapper of
  // something already refused is refused too. Bounded to a trailing digit or an
  // `E`/`B` suffix so a real ticker like USDX is untouched.
  const base = s.replace(/(\d+|E|B)$/, "");
  if (base !== s && NOT_A_PROJECT.has(base)) return true;
  const n = String(name || "");
  return WRAPPER_NAME.test(n) || MONEY_NAME.test(n);
}

/**
 * ⚠️ ONLY AN AUTO-LISTING MAY BE HIDDEN, and that is the whole safety of this.
 *
 * `FREE` is the tier the bot's own filler books when it lists a big token off
 * the market — it is deliberately absent from the pricing UI, so it can never
 * be bought. Everything else on this board is somebody's money, and a listing
 * that vanished from the site would be a refund conversation: the rule this
 * repo already states about demoting rather than hiding a quiet pool, on a
 * category rather than on a bad afternoon.
 *
 * So a project that pays to list a stablecoin gets exactly what it paid for.
 */
/**
 * ⚠️ `BoardToken.symbol` IS THE DISPLAY FORM, AND IT CARRIES A `$`.
 *
 * The very scar this module inherited, reintroduced one field over. `fold`
 * transliterates currency glyphs rather than stripping them — `₮` IS a T, and
 * `$` is an S — which is right for a ticker a brand writes in a glyph, and
 * catastrophic for a `$` this app prepends for display: `"$WTRX"` folds to
 * `"SWTRX"`, which is in no set, so **every symbol rule was inert**.
 *
 * It shipped looking like it worked. The log said `2 auto-listed
 * stablecoin/wrapper row(s) kept off the board` — because "Wrapped TRX" and
 * "Global Dollar" were caught by the NAME rules — while `$BTCB` ("BTCB Token",
 * which matches no name rule) sailed onto the board. Two out of three reads as
 * a working filter.
 *
 * So the display prefix is removed HERE, at the one boundary that knows the
 * convention, and `fold` stays byte-identical to the bot's.
 */
const raw = (displaySymbol: string): string => displaySymbol.replace(/^\$+/, "");

export const hideFromBoard = (t: { symbol: string; name: string; tier: string }): boolean =>
  t.tier === "FREE" && notAProject(raw(t.symbol), t.name);

/**
 * ⚠️ THE FILTER'S OWN LINE WAS THE FLOOD IT WAS PRINTED NEXT TO.
 *
 * `[market] 2 auto-listed stablecoin/wrapper row(s) kept off the board`, once
 * per 60s cycle, for ever — added in the same change that made the last-known
 * line report on the transition only. A lesson applied to the line beside it
 * and not to the one being written; the trade bot's refusal path learnt the
 * same thing about its own if/else.
 *
 * And a COUNT was the wrong payload anyway. "2" over three visible offenders is
 * the ambiguity that hid a dead symbol rule for a whole deploy: a number cannot
 * tell you WHICH two. It names them.
 *
 * Reported when the SET changes, never on a cadence — this is a fact about the
 * roster, not about the cycle, so it is silent for as long as the roster holds.
 */
/**
 * ⚠️ THE BOOT STATE IS THE EMPTY ROSTER, NOT "UNKNOWN". A clean board is the
 * normal state and must not announce itself on every restart — the recovery
 * line only means something after something was actually hidden.
 *
 * ⚠️ AND IT IS ONE CONSTANT, shared with the test seam. Written as two
 * literals, `_resetHiddenReport()` set the state the test wanted rather than
 * the state the process boots into, so a mutation of the INITIALISER was
 * invisible to every test — the reset seam quietly answering for the thing
 * under test. Found by mutation testing, not by reading.
 */
const CLEAN_ROSTER = "";
let lastHidden = CLEAN_ROSTER;

export function hiddenReport(symbols: readonly string[]): string | null {
  const sig = [...symbols].sort().join(",");
  if (sig === lastHidden) return null;
  lastHidden = sig;
  if (!symbols.length) return "no auto-listed stablecoin or wrapper rows left on the board";
  return `${symbols.length} auto-listed stablecoin/wrapper row(s) kept off the board: ${[...symbols].sort().join(" ")}`;
}

/** Test seam — module state outliving one test is how the next one lies. */
export const _resetHiddenReport = (): void => {
  lastHidden = CLEAN_ROSTER;
};
