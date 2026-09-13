// Turns Pons launch state into the app's normalised market shape.
//
// Two price regimes, one token: while a launch is on its bonding curve the
// price is the curve's marginal price (quote reserve / token reserve, phantom
// reserve included); once it graduates, price comes from the locked Uniswap V4
// pool's sqrtPriceX96. Launches quoted in an ERC-20 rather than native ETH are
// reported without USD figures — we have no reference price for an arbitrary
// quote asset, and a wrong number is worse than none.
import { cached, within } from "@/lib/cache";
import { fromUnits } from "@/lib/evm/abi";
import { PONS, ponsExplorerUrl, ponsTokenUrl, type GraduationPhase } from "@/config/pons";
import { PERIOD_KEYS, type PeriodKey, type Trade, type TxSplit } from "@/lib/types";
import { readNativeUsd, type QuoteUsdSource } from "./quoteUsd";
import type { LiveMarket } from "../market";
import {
  readCurveTokenDecimals,
  readLaunchSnapshotsX,
  readTokenProfile,
  sortCurrencies,
  type LaunchSnapshot,
  type TokenSocials,
} from "./contracts";
import { readCurveHistories, type CurveHistory, type PonsTrade } from "./trades";

const NATIVE_USD_TTL = 60_000;
/** Ceiling on the launch record's SIDE reads (histories, profile) — see fetchPonsLaunch. */
export const SIDE_MS = 3000;
const PERIOD_MINUTES: Record<PeriodKey, number> = { "5m": 5, "1h": 60, "6h": 360, "24h": 1440 };
const Q96 = 2 ** 96;

/**
 * USD price of the chain's native quote asset (ETH), with WHICH source answered
 * and — when none did — every refusal, so a curve token's TBA can name its
 * cause instead of reading as a token nobody prices.
 *
 * ⚠️ THIS WAS GECKOTERMINAL ALONE. The one metered source on the box, and the
 * one the site's charts are starving on: a 429 anywhere arms a process-wide
 * cooldown, this read then threw, and `describe()` nulled priceUsd, mcapUsd
 * AND priceQuote — so every Pons v2 token on the site, and every paid post the
 * bot builds through /api/pons, read TBA over a spot price the curve had just
 * answered. The ladder (quoteUsd.ts) asks the free sources first.
 *
 * Only an ANSWER is cached (`cached()` rethrows a cold miss): a null written
 * into the cache would be served stale for the life of the process.
 */
const NATIVE_USD_KEY = "pons:native-usd";
let quoteUsdSource: QuoteUsdSource | null = null;
// Test seam: `cached()` serves a stale copy while it refreshes, so a suite that
// walks the ladder through three outcomes needs a fresh key per outcome.
let nativeUsdGen = 0;
export const __resetNativeUsd = (): void => {
  nativeUsdGen++;
  quoteUsdSource = null;
};

export interface NativeUsdRead {
  usd: number | null;
  source: QuoteUsdSource | null;
  /** Null when `usd` is a number; otherwise every rung's refusal, joined. */
  why: string | null;
}

export async function nativeUsdX(): Promise<NativeUsdRead> {
  try {
    const usd = await cached(`${NATIVE_USD_KEY}#${nativeUsdGen}`, NATIVE_USD_TTL, async () => {
      const r = await readNativeUsd();
      if (r.usd == null) throw new Error(r.why.join("; ") || "no source answered");
      quoteUsdSource = r.source;
      return r.usd;
    });
    return { usd, source: quoteUsdSource, why: null };
  } catch (e) {
    return {
      usd: null,
      source: null,
      why: `no USD reference for ${PONS.nativeSymbol} — ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** The long-standing shape: the number, or a throw naming every refusal. */
export const nativeUsd = async (): Promise<number> => {
  const r = await nativeUsdX();
  if (r.usd == null) throw new Error(r.why ?? "no USD reference");
  return r.usd;
};

const tokenDecimals = (snapshot: LaunchSnapshot): number => snapshot.meta?.decimals ?? 18;

/** Effective AMM-side price of a trade, in quote per token. */
const tradePrice = (trade: PonsTrade, decimals: number): number => {
  const tokens = fromUnits(trade.tokens, decimals);
  return tokens > 0 ? fromUnits(trade.quote, PONS.nativeDecimals) / tokens : 0;
};

/** Marginal price of the bonding curve, in quote per token. */
function curveSpot(snapshot: LaunchSnapshot): number | null {
  const curve = snapshot.curve;
  if (!curve || curve.graduated || curve.tokenReserve <= 0n) return null;
  const tokens = fromUnits(curve.tokenReserve, tokenDecimals(snapshot));
  if (tokens <= 0) return null;
  return fromUnits(curve.quoteReserve, PONS.nativeDecimals) / tokens;
}

/**
 * Price and quote-side depth of the graduated Uniswap V4 pool. The position is
 * full-range and permanently locked, so `amount = L / sqrtP` (and `L * sqrtP`)
 * describes it to within the negligible tick-bound terms.
 */
function poolSpot(snapshot: LaunchSnapshot): { price: number; quoteAmount: number } | null {
  const pool = snapshot.pool;
  if (!pool || pool.sqrtPriceX96 <= 0n) return null;

  const decimals = tokenDecimals(snapshot);
  const [currency0] = sortCurrencies(snapshot.launch.pairToken, snapshot.launch.token);
  const quoteIsCurrency0 = currency0.toLowerCase() === snapshot.launch.pairToken.toLowerCase();
  const [decimals0, decimals1] = quoteIsCurrency0
    ? [PONS.nativeDecimals, decimals]
    : [decimals, PONS.nativeDecimals];

  const sqrtP = Number(pool.sqrtPriceX96) / Q96;
  if (!Number.isFinite(sqrtP) || sqrtP <= 0) return null;

  // price of currency1 per currency0, corrected for the decimal difference
  const price1Per0 = sqrtP * sqrtP * 10 ** (decimals0 - decimals1);
  if (!Number.isFinite(price1Per0) || price1Per0 <= 0) return null;

  const liquidity = Number(pool.liquidity);
  const amount0 = liquidity > 0 ? liquidity / sqrtP / 10 ** decimals0 : 0;
  const amount1 = liquidity > 0 ? liquidity * sqrtP / 10 ** decimals1 : 0;

  return quoteIsCurrency0
    ? { price: 1 / price1Per0, quoteAmount: amount0 }
    : { price: price1Per0, quoteAmount: amount1 };
}

interface PeriodStats {
  chg: Record<PeriodKey, number>;
  vol: Record<PeriodKey, number>;
  txns: Record<PeriodKey, TxSplit>;
}

const emptyStats = (): PeriodStats => ({
  chg: { "5m": 0, "1h": 0, "6h": 0, "24h": 0 },
  vol: { "5m": 0, "1h": 0, "6h": 0, "24h": 0 },
  txns: {
    "5m": { buys: 0, sells: 0 },
    "1h": { buys: 0, sells: 0 },
    "6h": { buys: 0, sells: 0 },
    "24h": { buys: 0, sells: 0 },
  },
});

/** Per-period volume, txn split and price change from the curve's trade log. */
function periodStats(
  trades: PonsTrade[],
  decimals: number,
  spotQuote: number,
  quoteUsd: number,
  nowSeconds: number,
): PeriodStats {
  const stats = emptyStats();
  for (const period of PERIOD_KEYS) {
    const since = nowSeconds - PERIOD_MINUTES[period] * 60;
    const window = trades.filter((trade) => trade.ts >= since);
    if (window.length === 0) continue;

    let volumeQuote = 0;
    let buys = 0;
    let sells = 0;
    for (const trade of window) {
      volumeQuote += fromUnits(trade.quote, PONS.nativeDecimals);
      if (trade.kind === "buy") buys++;
      else sells++;
    }
    stats.vol[period] = volumeQuote * quoteUsd;
    stats.txns[period] = { buys, sells };

    const opening = tradePrice(window[0], decimals);
    if (opening > 0 && spotQuote > 0) {
      stats.chg[period] = ((spotQuote - opening) / opening) * 100;
    }
  }
  return stats;
}

/** The marginal price in QUOTE units (ETH per token) — the pool's after
 *  graduation, the curve's before it, the last fill as a last resort. A fact
 *  about the CHAIN, so it must never depend on a USD reference: `describe()`
 *  used to null it with the USD figures, which threw away the one number the
 *  chain had answered. */
function spotQuoteOf(snapshot: LaunchSnapshot, history: CurveHistory | undefined): number | null {
  const decimals = tokenDecimals(snapshot);
  const trades = history?.trades ?? [];
  const pool = poolSpot(snapshot);
  const last = trades.length ? tradePrice(trades[trades.length - 1], decimals) : 0;
  const spot = pool?.price ?? curveSpot(snapshot) ?? (last > 0 ? last : null);
  return spot != null && spot > 0 ? spot : null;
}

function buildMarket(
  snapshot: LaunchSnapshot,
  history: CurveHistory | undefined,
  quoteUsd: number,
  nowSeconds: number,
): LiveMarket | null {
  // No USD reference for an ERC-20-quoted launch — skip rather than guess.
  if (!snapshot.launch.nativeQuote) return null;

  const decimals = tokenDecimals(snapshot);
  const trades = history?.trades ?? [];
  const pool = poolSpot(snapshot);
  const spotQuote = spotQuoteOf(snapshot, history);
  if (spotQuote == null) return null;

  const priceUsd = spotQuote * quoteUsd;
  const supply = snapshot.meta ? fromUnits(snapshot.meta.totalSupply, decimals) : 0;

  // On the curve, the honest depth number is the quote actually backing it;
  // after graduation it's the locked pool, counted both sides as usual.
  const liquidityQuote = pool
    ? pool.quoteAmount * 2
    : snapshot.curve && !snapshot.curve.graduated
      ? fromUnits(snapshot.curve.realQuoteReserve, PONS.nativeDecimals)
      // Swept but not yet seeded (or rescued): the curve is drained, so the
      // reserves pulled into the factory are what is actually behind the token.
      : fromUnits(snapshot.launch.sweptQuote, PONS.nativeDecimals);

  const stats = periodStats(trades, decimals, spotQuote, quoteUsd, nowSeconds);

  return {
    priceUsd,
    mcap: supply > 0 ? supply * priceUsd : null,
    liq: liquidityQuote > 0 ? liquidityQuote * quoteUsd : null,
    chg: stats.chg,
    vol: stats.vol,
    txns: stats.txns,
    ageMinutes: null, // Pons keeps no launch timestamp on chain; the listing's own age stands
    logoUrl: snapshot.meta?.logo ?? null,
    // The curve is this launch's "pool" — /api/trades reads its logs.
    poolAddress: snapshot.launch.curve,
    statsCoverageMinutes: history?.coverageMinutes ?? 0,
  };
}

/**
 * Live market data for specific listed addresses on Robinhood Chain, keyed by
 * lowercased address — same contract as the GeckoTerminal provider. Throws on
 * a total failure so the caller can fall back to its own figures.
 */
export async function fetchPonsMarket(addresses: string[]): Promise<Map<string, LiveMarket>> {
  const out = new Map<string, LiveMarket>();
  if (addresses.length === 0) return out;

  const { snapshots, failed } = await readLaunchSnapshotsX(addresses.slice(0, 30));
  // ⚠️ A ROW WE COULD NOT READ IS NOT A ROW WITH NO MARKET. The board drops a
  // missing address onto its last-known reading and prints nothing, so a node
  // refusing half a cycle looked exactly like half the chain being quiet.
  if (failed.size > 0) {
    console.warn(
      `[market] ${PONS.chain}: ${failed.size} launch record(s) could not be READ this cycle — ` +
        `${[...failed.values()][0]} (this is the node, not the tokens)`,
    );
  }
  if (snapshots.size === 0) return out;

  const [quote, histories] = await Promise.all([
    nativeUsdX(),
    readCurveHistories([...snapshots.values()].map((s) => s.launch.curve)).catch(
      () => new Map<string, CurveHistory>(),
    ),
  ]);
  // ⚠️ A USD reference that failed is NOT a chain that failed. This used to
  // `await nativeUsd()` uncaught, so a ladder with no rung standing THREW —
  // and the board's fallback (pons/index.ts) reads a throw as "this box cannot
  // reach the chain" and parks the whole on-chain reader for five minutes,
  // over snapshots it had just read perfectly well. The park exists for a dead
  // RPC. With no dollar figure there is no LiveMarket row to publish, so the
  // honest answer is an empty map and the reason, and the next cycle asks
  // again — the ladder's own cache makes that one bounded read, not a walk.
  if (quote.usd == null) {
    console.warn(`[market] ${PONS.chain}: ${quote.why} — ${snapshots.size} curve token(s) go unpriced this cycle`);
    return out;
  }

  const now = Math.floor(Date.now() / 1000);
  for (const [address, snapshot] of snapshots) {
    const market = buildMarket(snapshot, histories.get(snapshot.launch.curve.toLowerCase()), quote.usd, now);
    if (market) out.set(address, market);
  }
  return out;
}

/**
 * "We read this launch's price in ETH and could not turn it into dollars" — a
 * hole that is OURS (the ETH/USD ladder), never the token's. Decided from the
 * record's own fields, not from a sentence: a native-quoted launch whose
 * `priceQuote` was read but whose `priceUsd` is null. An ERC-20-quoted launch
 * (no `quoteSymbol`) publishes no USD figure by design and is not this.
 *
 * `/api/pons` uses it to shorten the cache on such a record: a launch cached
 * for the full TTL with `priceUsd: null` is the ladder's worst minute served to
 * every reader — the bot on its 5s clock included — for twenty seconds after
 * the ladder has recovered.
 */
export function unpricedByUs(
  launch: Pick<PonsLaunchInfo, "priceUsd" | "priceQuote" | "quoteSymbol"> & { readWhy?: string | null } | null,
): boolean {
  if (!launch) return false;
  // A record whose curve or metadata the node would not READ is ours too —
  // the RPC's worst minute, not the token's — and must not be served for the
  // full TTL any more than a ladder failure is.
  if (launch.readWhy) return true;
  return launch.priceUsd == null && launch.priceQuote != null && launch.quoteSymbol != null;
}

export interface LaunchSummary {
  priceUsd: number | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  progressPct: number | null;
}

/** Price, size and curve progress for one snapshot, without a trade window.
 *  Used by the launch feed, which reads many launches and can't afford a log
 *  scan per curve. */
export function summarise(snapshot: LaunchSnapshot, quoteUsd: number | null): LaunchSummary {
  const market = quoteUsd ? buildMarket(snapshot, undefined, quoteUsd, Math.floor(Date.now() / 1000)) : null;
  const threshold = fromUnits(snapshot.launch.graduationThreshold, PONS.nativeDecimals);
  const raised =
    snapshot.curve && !snapshot.curve.graduated
      ? fromUnits(snapshot.curve.realQuoteReserve, PONS.nativeDecimals)
      : fromUnits(snapshot.launch.sweptQuote, PONS.nativeDecimals);
  return {
    priceUsd: market?.priceUsd ?? null,
    mcapUsd: market?.mcap ?? null,
    liquidityUsd: market?.liq ?? null,
    progressPct: threshold > 0 ? Math.min(100, (raised / threshold) * 100) : null,
  };
}

// ── Launch detail (the /api/pons surface) ─────────────────────────────────
export interface PonsLaunchInfo {
  address: string;
  curve: string;
  deployer: string;
  creatorFeeRecipient: string;
  pairToken: string;
  quoteSymbol: string | null;
  phase: GraduationPhase;
  graduated: boolean;
  name: string | null;
  symbol: string | null;
  logo: string | null;
  decimals: number | null;
  totalSupply: string | null;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  /** Curve progress towards graduation, 0–100. */
  progressPct: number | null;
  graduationThresholdQuote: number | null;
  raisedQuote: number | null;
  /** ETH per token — a chain fact, present whenever the curve or pool answered,
   *  with or without a USD reference. */
  priceQuote: number | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  /** Which rung of the ETH/USD ladder priced this, or null when none did. */
  quoteUsdSource: QuoteUsdSource | null;
  /** Why the USD figures are missing — every rung's refusal, or "quoted in an
   *  ERC-20". Null when they are present. "We could not price it" and "nobody
   *  prices it" are different facts, and the bot's post watch prints this one. */
  marketWhy: string | null;
  /** The node's reason when the curve or the token metadata could not be READ
   *  — name, symbol, logo and price missing for OUR reason (the RPC refused
   *  or failed), never the creator's. Null when the reads answered. */
  readWhy: string | null;
  liquidityLocked: boolean;
  /** What the creator set at launch — the listing form autofills from these. */
  socials: TokenSocials | null;
  description: string | null;
  poolFee: number;
  tickSpacing: number;
  explorerUrl: string;
  ponsUrl: string;
}

function describe(
  snapshot: LaunchSnapshot,
  market: LiveMarket | null,
  quote: NativeUsdRead,
  history: CurveHistory | undefined,
  profile: { socials: TokenSocials; description: string | null } | null,
): PonsLaunchInfo {
  const quoteUsd = quote.usd;
  const spotQuote = spotQuoteOf(snapshot, history);
  // Three different holes, three sentences — and the middle one had two
  // causes under one sentence: "the curve and the pool answered no price" was
  // printed for a curve the node REFUSED to read (HTTP 429), which sent the
  // check, the alert and the operator to the ETH/USD ladder over a node that
  // was rate-limiting the box.
  const marketWhy = market
    ? null
    : !snapshot.launch.nativeQuote
      ? "quoted in an ERC-20, not ETH — no USD reference for an arbitrary quote asset"
      : spotQuote == null
        ? snapshot.readWhy
          ? `could not read the curve — ${snapshot.readWhy}`
          : "the curve and the pool answered no price"
        : quote.why ?? "no USD reference";
  const { launch, curve, meta } = snapshot;
  const threshold = fromUnits(launch.graduationThreshold, PONS.nativeDecimals);
  const raised = curve && !curve.graduated
    ? fromUnits(curve.realQuoteReserve, PONS.nativeDecimals)
    : fromUnits(launch.sweptQuote, PONS.nativeDecimals);
  const graduated = launch.phase !== "NotGraduated";

  return {
    address: launch.token,
    curve: launch.curve,
    deployer: launch.deployer,
    creatorFeeRecipient: launch.creatorFeeRecipient,
    pairToken: launch.pairToken,
    quoteSymbol: launch.nativeQuote ? PONS.nativeSymbol : null,
    phase: launch.phase,
    graduated,
    name: meta?.name || null,
    symbol: meta?.symbol || null,
    logo: meta?.logo ?? null,
    decimals: meta?.decimals ?? null,
    totalSupply: meta ? meta.totalSupply.toString() : null,
    creatorTaxBps: launch.creatorTaxBps,
    buybackEnabled: launch.buybackEnabled,
    progressPct: threshold > 0 ? Math.min(100, (raised / threshold) * 100) : null,
    graduationThresholdQuote: threshold,
    raisedQuote: raised,
    priceQuote: spotQuote,
    priceUsd: market?.priceUsd ?? null,
    mcapUsd: market?.mcap ?? null,
    liquidityUsd: market?.liq ?? null,
    quoteUsdSource: market && quoteUsd ? quote.source : null,
    marketWhy,
    readWhy: snapshot.readWhy,
    // Graduation locks the V4 position permanently — the locker exposes no
    // withdrawal path at all (PonsV2LaunchLocker).
    liquidityLocked: launch.phase === "PoolCreated",
    socials: profile?.socials ?? null,
    description: profile?.description ?? null,
    poolFee: launch.poolFee,
    tickSpacing: launch.tickSpacing,
    explorerUrl: ponsExplorerUrl(launch.token),
    ponsUrl: ponsTokenUrl(launch.token),
  };
}

/** Full launch detail for one token, or null when Pons never launched it. */
export async function fetchPonsLaunch(address: string): Promise<PonsLaunchInfo | null> {
  const { snapshots, failed } = await readLaunchSnapshotsX([address]);
  const snapshot = snapshots.get(address.toLowerCase());
  // ⚠️ "Could not read the launch record" is NOT "not a Pons launch". A null
  // here becomes a 404 on /api/pons, and the bot memos a 404 as "Pons never
  // launched this" for the life of its process — so a refused read that
  // reached here as null would mark a live curve token as never launched,
  // permanently, over a rate limit. A throw is a 503, which parks the bot's
  // reader and is asked again. For ONE address the all-fail throw inside
  // `readLaunchRecordsX` fires first; this keeps the rule true if this read
  // is ever batched, and it is the rule rather than a comment about one.
  if (!snapshot) {
    const why = failed.get(address.toLowerCase());
    if (why) throw new Error(`Pons RPC: ${why}`);
    return null;
  }

  // ⚠️ THE SIDE READS ARE BOUNDED, because the bot reads this route on a 5s
  // clock (PONS_CHAIN_MS) for a paid post's figures. The histories feed only
  // the period stats and the volume; the profile feeds the socials. Neither
  // is the PRICE, and a slow public RPC walking six log chunks used to hold
  // the whole record past the bot's deadline — a TBA by a longer road. Past
  // SIDE_MS the read is left RUNNING (its result lands in its own cache for
  // the next reader) and the record goes out without that half.
  const [quote, hist, prof] = await Promise.all([
    nativeUsdX(),
    within(readCurveHistories([snapshot.launch.curve]), SIDE_MS),
    // Best-effort: a token whose creator set nothing, and a read that failed,
    // both leave the form asking — neither may cost the rest of the record.
    within(readTokenProfile(snapshot.launch.token), SIDE_MS),
  ]);
  const histories = hist.ok ? hist.value : new Map<string, CurveHistory>();
  const profile = prof.ok ? prof.value : null;
  const history = histories.get(snapshot.launch.curve.toLowerCase());
  const market = quote.usd ? buildMarket(snapshot, history, quote.usd, Math.floor(Date.now() / 1000)) : null;
  return describe(snapshot, market, quote, history, profile);
}

/** Recent trades on a launch's curve, newest first, in the app's Trade shape. */
export async function fetchPonsTrades(curve: string): Promise<Trade[]> {
  const [quoteUsd, decimals, histories] = await Promise.all([
    nativeUsd().catch(() => 0),
    readCurveTokenDecimals(curve).catch(() => 18),
    readCurveHistories([curve]),
  ]);
  const history = histories.get(curve.toLowerCase());
  if (!history) return [];

  return history.trades
    .slice(-60)
    .reverse()
    .map((trade) => {
      const price = tradePrice(trade, decimals);
      return {
        ts: trade.ts,
        kind: trade.kind,
        usd: fromUnits(trade.quote, PONS.nativeDecimals) * quoteUsd,
        amount: fromUnits(trade.tokens, decimals),
        price: price * quoteUsd,
        trader: trade.trader,
      };
    });
}
