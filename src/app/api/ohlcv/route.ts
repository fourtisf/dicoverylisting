import { NextRequest, NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { gtCooldownLeftMs, gtGet, gtInCooldown } from "@/lib/providers/gt";
import { networkOf, readWhy, safeAddress, topPoolAddress } from "@/lib/providers/gtPool";
import { cachedPool } from "@/lib/providers/poolCache";
import { publicNote } from "@/lib/publicNote";
import { dsCandles, dsChartCovers, dsPairUrl, type DsCandles } from "@/lib/providers/dsChart";
import { TF, chartPrefOf, normalizeCandles, tfOf, type ChartPref, type Candle, type Timeframe } from "@/lib/ohlcv";

export const dynamic = "force-dynamic";

/**
 * Candles for one token, from the pool it actually trades on.
 *
 * The token page used to embed GeckoTerminal's own chart in an iframe when it
 * happened to know a pool address, and draw a hash-generated squiggle when it
 * did not. This serves the numbers instead, so the page can draw a real
 * candlestick chart in the site's own type and colour — and so "we could not
 * read the chart" stops being indistinguishable from "this token has no
 * history", which is the shape of every reporting bug in this repo.
 */


export interface OhlcvResponse {
  ok: boolean;
  /**
   * WHICH BUILD ANSWERED. Not decoration: a chart that fails and a chart whose
   * fix was never deployed are indistinguishable from the outside, and working
   * that out has now cost a round trip on this very endpoint — the server had
   * merged a stale ref, so the answer came from the old code and said so
   * nowhere. `/api/token-preview` carries the same stamp for the same reason.
   */
  build: string;
  /** GeckoTerminal network id — the client builds its "open on GT" link from
   *  this plus `pool`, so it never has to re-derive either. */
  network: string | null;
  pool: string | null;
  tf: Timeframe;
  candles: Candle[];
  /** Why there are no candles. Populated ONLY when `ok` is false, and written
   *  for a person reading a chart panel, not for a log. */
  why: string | null;
  /**
   * WHICH SOURCE DREW THIS. Not decoration, and not a debug flag.
   *
   * The two sources resolve their own pools independently — GeckoTerminal's
   * deepest pool and DexScreener's deepest PAIR are usually the same market and
   * are not guaranteed to be — so a reader comparing two screenshots taken an
   * hour apart needs to be able to see that the underlying pool changed. It is
   * also the only way to tell, from outside, that the fallback is working at
   * all: a chart that draws from DexScreener and one that draws from GT look
   * identical, and "the fix is deployed" and "the fix never fires" are exactly
   * the pair of readings this repo keeps paying for.
   */
  source: "geckoterminal" | "dexscreener" | null;
  /**
   * "Open it at the source", built HERE rather than by the client.
   *
   * ⚠️ `pool` is a GECKOTERMINAL pool id and the client used to build a
   * geckoterminal.com link out of it. A DexScreener PAIR address in that field
   * would produce a link that 404s — the rule `dexscreener.ts` states at its
   * own `poolAddress: null`, and which /api/pool and /api/trades also depend
   * on. So `pool` still only ever carries a GT pool, the DS pair never touches
   * it, and the link the panel shows is computed by whoever knows which source
   * answered.
   */
  sourceUrl: string | null;
}

const BUILD = process.env.NEXT_PUBLIC_BUILD ?? "unknown";

const fail = (tf: Timeframe, why: string, network: string | null = null, pool: string | null = null): OhlcvResponse => ({
  ok: false,
  build: BUILD,
  network,
  pool,
  tf,
  candles: [],
  why,
  source: null,
  sourceUrl: null,
});

/** A GT read that ANSWERED with nothing (404 / 4xx) versus one that never
 *  happened. Only the first may be cached — caching a 429 would let a two
 *  minute backoff blank every chart on the site for the TTL, which is the
 *  bot's `changeFromCandles` lesson, one surface over. */
class Unreadable extends Error {}

async function fetchCandles(network: string, pool: string, token: string, tf: Timeframe): Promise<Candle[] | null> {
  const spec = TF[tf];
  const res = await gtGet<{ data?: { attributes?: { ohlcv_list?: unknown } } }>(`/networks/${network}/pools/${pool}/ohlcv/${spec.path}`, {
    aggregate: spec.aggregate,
    limit: spec.limit,
    currency: "usd",
    // ⚠️ OUR token, never the pool's base side. GT's OHLCV defaults to `base`,
    // which is our token only by luck: in a WETH/OURTOKEN pool it is WETH, and
    // the page would draw Ethereum's chart under a memecoin's ticker. That is a
    // WRONG number rather than a missing one — the worse of the two — and the
    // bot repo names the same address for the same reason.
    token,
  });
  // 404: GT does not index this pool — an answer about the pool, cacheable, and
  // the signal the caller uses to go and resolve a pool it does know.
  if (res.status === 404) return null;
  if (!res.ok) throw new Unreadable(res.reason ?? "GeckoTerminal failed");
  return normalizeCandles(res.body?.data?.attributes?.ohlcv_list);
}

/** What GeckoTerminal had to say. `candles: null` means it could not be asked
 *  or does not index a pool; an empty array means it answered and this pool has
 *  no history on this timeframe. Those two must not collapse — one is a reason
 *  to go and ask somebody else, and the other is an answer about the token. */
interface GtOut {
  candles: Candle[] | null;
  pool: string | null;
  why: string | null;
  /** Did GeckoTerminal ANSWER — including answering "I have no pool for this"?
   *  `candles: null` covers both that and "could not be asked", and the two
   *  need different sentences: one is a fact about the token, the other about
   *  us, and the panel only fast-retries the second. */
  answered: boolean;
}

async function fromGeckoTerminal(network: string, address: string, tf: Timeframe, hint: string | null): Promise<GtOut> {
  // A caller-supplied pool is a HINT, not an authority: the token page passes
  // the pool GeckoTerminal named, but a preview built from DexScreener carries
  // a PAIR address GT has never indexed. So a 404 on the hint is not the end of
  // the lookup — it is the reason to ask GT which pool it knows.
  let pool = hint;
  let candles: Candle[] | null = null;
  try {
    if (pool) candles = await fetchCandles(network, pool, address, tf);

    // ⚠️ An EMPTY list from the hint is also a reason to go and ask, not only a
    // 404. A DexScreener pair address can be a real-but-thin GT pool that has
    // never traded on this timeframe, and reporting "no candles" for it hides the
    // deep pool that has a year of them. Costs one extra request, in the one case
    // where we were about to draw nothing anyway.
    if (candles == null || candles.length === 0) {
      const resolved = await cachedPool(network, address, () => topPoolAddress(network, address));
      if (!resolved)
        return {
          candles,
          pool,
          answered: true,
          why: pool
            ? "GeckoTerminal doesn't index a pool for this token yet."
            : "No pool indexed for this token yet — nothing to chart.",
        };
      if (resolved !== pool) {
        const deeper = await fetchCandles(network, resolved, address, tf);
        // Only take the deeper pool's answer if it is actually better: a 404 or an
        // empty list there must not throw away candles the hint already gave us.
        if (deeper && (deeper.length > 0 || candles == null)) {
          pool = resolved;
          candles = deeper;
        }
      }
      if (candles == null)
        return { candles: null, pool, answered: true, why: "GeckoTerminal doesn't index a pool for this token yet." };
    }
    return { candles, pool, answered: true, why: null };
  } catch (err) {
    // A 429, a dead socket, a 5xx. NOT an answer about the token, and the
    // reason is carried out rather than dropped: "rate limited" and "no pool"
    // send a reader — and this function's caller — to different places.
    return { candles: null, pool, answered: false, why: readWhy(err) };
  }
}

/**
 * Which sources a request may use. `null` is the normal answer — both, GT
 * first — and the other two exist so `npm run chart:check` can measure ONE of
 * them from outside.
 *
 * ⚠️ WHY A PUBLIC ROUTE CARRIES A DIAGNOSTIC KNOB AT ALL. Whether an upstream
 * answers is a property of the server's egress, so it has to be measured on the
 * box — and with GeckoTerminal healthy the DexScreener path never runs, so a
 * check that only asked normally would report a green chart and say nothing
 * about whether the FALLBACK works. That is `fonts:check` printing nine green
 * ticks over a banner drawing boxes: a guard is only honest while it measures
 * the stack it claims to. `launchpads:check` passes `force: true` past the
 * local breaker for the same reason.
 *
 * It selects an upstream to READ and nothing else — no write, no secret, no
 * wider data — which is why it needs no guard. It is part of the cache key, or
 * a forced single-source answer would be served to an ordinary visitor.
 */
export type SourcePin = "geckoterminal" | "dexscreener" | null;
const pinOf = (raw: string | null): SourcePin =>
  raw === "geckoterminal" || raw === "dexscreener" ? raw : null;

// Which source goes first — see `chartPrefOf` in lib/ohlcv.ts for why this is
// an ORDER and never a deletion.
const PREF: ChartPref = chartPrefOf(process.env.CHART_SOURCE);

async function load(chain: string, address: string, tf: Timeframe, hint: string | null, pin: SourcePin = null): Promise<OhlcvResponse> {
  const network = networkOf(chain);
  // A `?source=` pin is the check script's seam and outranks the operator's
  // standing preference; `CHART_SOURCE=geckoterminal` drops the guess entirely.
  const dsAvailable = dsChartCovers(chain) && pin !== "geckoterminal" && !(pin === null && PREF === "geckoterminal");
  if (!network && !dsAvailable) return fail(tf, `We don't have a chart source for ${chain} yet.`);
  // DexScreener goes first when the operator has asked for it — or when the
  // caller pinned it. Everything below reads this one boolean, so the two
  // sources cannot drift into two ideas of who is primary.
  const dsFirst = pin === "dexscreener" || (pin === null && PREF === "dexscreener" && dsAvailable);

  // ⚠️ WHILE THE GT COOLDOWN HOLDS, GECKOTERMINAL IS NOT ASKED AT ALL.
  //
  // `gtGet` would answer without making a request, so skipping costs nothing
  // upstream — but it also cannot succeed, and answering during exactly that
  // window is the entire reason a second source exists. This is the state the
  // report was taken in: every chart on the site reading "GeckoTerminal 429
  // (rate limited)" because one 429 anywhere arms a process-wide 120s silence.
  //
  // GT stays FIRST whenever it can answer. It is the documented source, its
  // pool ids are what `pool` means to every other route, and DexScreener's
  // candle shape is a guess about somebody else's private API (see dsChart.ts).
  // A guess must always lose to an answer — the rule `pickLogo` states one
  // pipeline over.
  // ⚠️ A `?source=` PIN MEANS "ONLY THAT ONE" — it is the check script's seam,
  // and it exists so `chart:check` can measure each source separately (with GT
  // healthy the DexScreener path never runs, and a check that only asked
  // normally would report a green chart while saying nothing about the
  // fallback). `CHART_SOURCE` is a different thing: an ORDER, with the other
  // source still behind it.
  const askGt = Boolean(network) && pin !== "dexscreener";

  let gt: GtOut = {
    candles: null,
    pool: null,
    answered: false, // not asked at all — never an answer about the token
    why: !askGt
      ? network
        ? "GeckoTerminal was not asked (source=dexscreener)"
        : `GeckoTerminal has no network id for ${chain}`
      : `GeckoTerminal is rate limited — cooling down for ${Math.ceil(gtCooldownLeftMs() / 1000)}s`,
  };
  let ds: DsCandles | null = null;

  // ⚠️ ASSIGNED IN THE MAIN FLOW, not inside a thunk. A `let` written only from
  // a closure keeps its initializer's narrowing, and TypeScript then reads `ds`
  // as `never` at every use below — which compiles to a runtime that works and
  // a type-check that does not, i.e. the guard rail off.
  const askDs = async (): Promise<DsCandles | null> =>
    dsAvailable ? await dsCandles(chain, address, tf) : null;
  const askGtNow = async (): Promise<GtOut | null> =>
    askGt && !gtInCooldown() ? await fromGeckoTerminal(network!, address, tf, hint) : null;

  // ⚠️ A PLAIN BOOLEAN, NOT A TYPE PREDICATE. `x is DsCandles` also narrows the
  // FALSE branch — to `null` — so every use of `ds` after these blocks read as
  // `never`, and the "which kind of nothing" logic below stopped type-checking
  // while still compiling. A guard rail that is off is worse than none.
  const drewDs = (x: DsCandles | null): boolean => Boolean(x && x.ok && x.candles.length > 0);
  const drewGt = (x: GtOut): boolean => Boolean(x.candles && x.candles.length > 0);

  // Annotated rather than `as const`, so the response literals keep the plain
  // `ok: true,` spelling the build-stamp guard counts — a builder the guard
  // cannot see is exactly the unstamped response it exists to catch.
  const gtOut = (): OhlcvResponse => ({
    ok: true,
    build: BUILD,
    network,
    pool: gt.pool,
    tf,
    candles: gt.candles!,
    why: null,
    source: "geckoterminal",
    sourceUrl: gt.pool && network ? `https://www.geckoterminal.com/${network}/pools/${gt.pool}` : null,
  });
  const dsOut = (x: DsCandles): OhlcvResponse => ({
    ok: true,
    build: BUILD,
    network,
    pool: gt.pool,
    tf,
    candles: x.candles,
    why: null,
    source: "dexscreener",
    sourceUrl: x.pair ? dsPairUrl(x.pair) : null,
  });

  // Each source is asked at most ONCE, and the second only when the first came
  // back with nothing to draw — a healthy chart never pays for the other one.
  if (dsFirst) {
    ds = await askDs();
    if (drewDs(ds)) return dsOut(ds!);
    const g = await askGtNow();
    if (g) gt = g;
    if (drewGt(gt)) return gtOut();
  } else {
    const g = await askGtNow();
    if (g) gt = g;
    if (drewGt(gt)) return gtOut();
    ds = await askDs();
    if (drewDs(ds)) return dsOut(ds!);
  }

  // ── Nothing to draw, so say WHICH kind of nothing ────────────────────────
  //
  // An empty list from a source that ANSWERED is a fact about the pool — this
  // token is too new to have traded a full candle. A source that could not be
  // asked is a fact about us. The panel reacts differently to the two (it
  // fast-retries only the second), so collapsing them would leave a rate limit
  // looking like a token with no history, for ever.
  //
  // ⚠️ EVERY SOURCE THAT COULD HAVE ANSWERED MUST HAVE ANSWERED, not just one
  // of them. With GeckoTerminal cooling down and DexScreener replying "no pair
  // for this token", one source answered — and reporting that as the settled
  // answer publishes "No candles yet" about a token GT indexes perfectly well,
  // on the panel state that never fast-retries, so it stays wrong until the
  // reader reloads. A source that was not applicable at all (no DS coverage
  // for this chain, or a `?source=` pin) is not an unanswered source.
  const dsAnswered = Boolean(ds && ds.ok);
  const gtSilent = askGt && !gt.answered;
  const dsSilent = dsAvailable && !dsAnswered;
  if (!gtSilent && !dsSilent && (gt.answered || dsAnswered))
    return {
      ok: false,
      build: BUILD,
      network,
      pool: gt.pool,
      tf,
      candles: [],
      // ⚠️ THE SPECIFIC REASON, NOT A HOUSE SENTENCE. This branch used to
      // hardcode "This pool has no candles on this timeframe yet" for every way
      // a source can answer with nothing — so a token NEITHER index has a pair
      // for was told its pool had no candles, which asserts a pool that does not
      // exist. GT's own sentence is preferred when GT looked (its pool ids are
      // what the rest of the page means by "pool"); DexScreener's is the answer
      // when GT was never asked. The generic line is the last resort, and it is
      // now only reached when a source really did find a pool and it really is
      // empty.
      why:
        (gt.answered ? gt.why : null) ??
        (dsAnswered ? ds!.why : null) ??
        "This pool has no candles on this timeframe yet.",
      source: null,
      sourceUrl: null,
    };

  // ⚠️ THROWN, NOT RETURNED — because `load()` IS THE CACHED LOADER.
  //
  // This branch is "a source could not be asked", and the rule this file has
  // stated since it was written is that only an ANSWER may be cached: caching
  // a 429 lets a two-minute backoff blank every chart on the site for the TTL,
  // which is up to fifteen minutes on the 1d timeframe — longer than the
  // cooldown it is reporting. It used to reach the GET catch by throwing
  // `Unreadable` out of `fetchCandles`; wrapping GeckoTerminal in a try/catch
  // so DexScreener could be tried afterwards quietly turned that throw into a
  // RETURN, and a returned failure goes straight into the cache. The second
  // source was the whole reason for the try/catch, so the throw moves here.
  //
  // BOTH reasons travel: "GeckoTerminal 429" alone, with a second source
  // silently unreachable behind it, is the shrug this endpoint has already been
  // fixed for once.
  // ⚠️ THE ATTEMPTED URL ONLY UNDER THE `?source=` PIN. That pin is the check
  // script's seam and nothing else sets it, so an operator running
  // `chart:check` sees the exact request that failed — and a visitor never sees
  // a raw upstream URL in the panel. A guessed request shape nobody can read is
  // a shape nobody can fix.
  const dsWhy = dsSilent ? (ds?.why ?? "DexScreener was not asked") + (pin && ds?.url ? ` [tried ${ds.url}]` : "") : null;
  const reasons = [gtSilent ? gt.why : null, dsWhy].filter(Boolean).join("; ");
  throw new Unreadable(reasons || "no source answered");
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const chain = (q.get("chain") ?? "").trim();
  const address = (q.get("address") ?? "").trim();
  const hint = (q.get("pool") ?? "").trim();
  const tf = tfOf(q.get("tf"));

  if (!safeAddress(address)) return NextResponse.json(fail(tf, "That contract address isn't one we can chart."));
  // ⚠️ CHECKED BEFORE THE CACHE KEY IS BUILT, not inside the loader. The key is
  // `ohlcv:<chain>:…`, and an unvalidated chain is an unbounded set of keys in
  // a process-lifetime cache — a memory leak anybody could drive from a query
  // string, for answers nobody could use.
  const network = networkOf(chain);
  if (!network) return NextResponse.json(fail(tf, "We don't have a chart source for that chain yet."));
  const pool = safeAddress(hint) ? hint : null;
  // Anything unrecognised is `null` — the normal both-sources answer. This
  // value reaches a cache key, so it can never be free text.
  const pin = pinOf(q.get("source"));

  try {
    // Keyed on the POOL HINT as well as the token: two callers asking for the
    // same token with different hints must not be served each other's answer.
    // …and on the SOURCE PIN, or a `chart:check` run forcing one upstream
    // would leave its answer in the cache for every ordinary visitor.
    const key = `ohlcv:${chain}:${address}:${pool ?? "-"}:${tf}:${pin ?? "auto"}`;
    const out = await cached(key, TF[tf].ttlMs, () => load(chain, address, tf, pool, pin));
    return NextResponse.json(out);
  } catch (err) {
    // Never cached, so the next poll re-asks: this is "GeckoTerminal did not
    // answer", which is about the upstream and not about the token.
    //
    // ⚠️ THE REASON IS NEVER DROPPED. This branch used to print a bare
    // "Couldn't read the chart just now." for everything that was not an
    // `Unreadable`, and the pool lookup throws a plain Error — so the first
    // live failure on the server said nothing at all about whether GeckoTerminal
    // had rate-limited us, 404'd, or was unreachable from that box. Three
    // different problems, one shrug, and the operator left to guess.
    // The visitor gets a sentence; the operator gets the reason. The note this
    // replaced carried the upstream's own Cloudflare probe
    // (window.__CF$cv$params={r:'…'}) onto a public token page.
    console.warn(`[chart] ${chain}/${pool ?? "-"}: ${readWhy(err)}`);
    return NextResponse.json(fail(tf, publicNote("the chart", err), networkOf(chain), pool));
  }
}
