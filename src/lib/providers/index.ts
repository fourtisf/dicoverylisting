import { CHAINS } from "@/config/chains";
import { cache, cached, within } from "@/lib/cache";
import { hiddenReport, hideFromBoard } from "@/lib/notAProject";
import {
  SEED_ROWS,
  rowToBoardToken,
  rowsToAddressesByChain,
  rowsToBoardTokens,
  type ListingRow,
} from "@/lib/listings";
import { approvedRows } from "@/lib/store";
import { dexvraScore } from "@/lib/score";
import { syntheticTrend, visualFor } from "@/lib/visual";
import { SANE_CHANGE_PCT, tradedEnough } from "@/lib/home";
import type {
  BoardToken,
  ChainHeat,
  FearGreed,
  Signal,
  TokensPayload,
  WireItem,
} from "@/lib/types";
import { fmtCap } from "@/lib/format";
import { SEED_FEAR_GREED, fetchFearGreed } from "./feargreed";
import { type LiveMarket } from "./geckoterminal";
import { POOLS_TRADE_CHAIN, fetchLaunchMarket } from "./poolstrade";
import { fetchPonsFallbackMarket, fetchPonsLaunch } from "./pons";
import { fetchIndexedMarket } from "./indexedMarket";
import { partitionByFallback } from "./dexscreener";
import { fillFromLastGood, shouldReport } from "./lastGood";
import { pickLogo, resolveLogo } from "./tokenLogo";
import { rememberPool } from "./poolCache";
import { backfillLogos, knownLogo, rememberLogo, shouldLookUp } from "./logoFill";
import { forgetLostUploads, pinLogo, setResolvedLogo } from "@/lib/store";
import { pinResolvedLogo } from "./logoPin";
import { isLostUpload, lostUploads } from "@/lib/mediaFile";
import { listUploads } from "@/lib/uploadsDir";

// 60s, not 30: at 173 listings a refresh is ~8 chunked GT requests, and the
// bot suite shares this server's IP and GT quota (~30 req/min, its own docs).
// The web app must be the polite tenant — `cached` serves stale on a failed
// refresh, so a missed minute costs staleness, never a DEMO board.
const PRICE_TTL = 60_000;
/** The one owner of the board's cache key: `getTokensPayload` writes through it
 *  and then reads `cache.storedAt` off it to date the payload, and two spellings
 *  would date a payload built from some other entry. */
const BOARD_KEY = "listings:market";
const FNG_KEY = "fng";
/**
 * ⚠️ HOW LONG A COLD START MAY HOLD THE PAGE — and only a cold start.
 *
 * `cached()` serves an expired board instantly, so the only visitor who can
 * still wait on the loader is the first one after a restart, when there is
 * genuinely nothing to serve. That visitor exists on every deploy, and this box
 * is redeployed constantly: ~19 GeckoTerminal chunks against a 15/min budget is
 * a minute or more on a rate-limited afternoon, and a page that hangs that long
 * reads as broken rather than slow. Past this the captured-at-listing board
 * goes out under its own `demo data` pill — real names, honest dashes, and the
 * real board on the next 30s poll, because the load is left RUNNING and its
 * result still lands in the cache.
 *
 * Generous on purpose: a healthy cold load is a few seconds, and tripping this
 * on a good box would trade a short skeleton for a demo pill nobody needed.
 */
const COLD_WAIT_MS = 8_000;
/** Matches the TTL /api/pool, /api/ohlcv and /api/trades read that key with —
 *  one number, or the board would plant an entry they expire differently. */
const FNG_TTL = 10 * 60_000;
/** Stamped onto the payload so a diagnostic can tell "the fix is deployed" from
 *  "the fix is on a branch the server never pulled" — the same line
 *  `/api/ohlcv` carries and the same reason. */
const BUILD = process.env.NEXT_PUBLIC_BUILD ?? "unknown";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Approved paid listings from the admin store; falls back to the seed if the
 *  store can't be read. */
async function loadRows(): Promise<ListingRow[]> {
  try {
    const rows = await approvedRows();
    return expireTrending(rows.length ? rows : SEED_ROWS);
  } catch {
    return SEED_ROWS;
  }
}

/** A paid Trending slot only features a token until `trendExp`. Past it, drop
 *  the featured rank at render time so the board stops featuring it even before
 *  the bot's sweeper clears it in the store. Purely non-mutating. */
function expireTrending(rows: ListingRow[]): ListingRow[] {
  const now = Date.now();
  return rows.map((r) =>
    r.trendExp && r.trendExp < now && r.trendingRank != null
      ? { ...r, trendingRank: undefined }
      : r,
  );
}

/** Live market data for one chain's listings, from every provider that covers
 *  that chain.
 *
 *  GeckoTerminal is the primary everywhere and wins wherever it answers — it
 *  carries the per-period stats and the pool address the chart embed needs. On
 *  the pools.trade chain it is not the whole story: a launch still on its
 *  bonding curve has no liquidity pool, so GT knows nothing about it and the
 *  listing rendered with the figures captured when it was listed. The launchpad
 *  does know it, so it fills those gaps and only those.
 *
 *  Throws only when NO provider for the chain answered, which keeps the
 *  caller's "everything is down → seed data" fallback intact. */
async function fetchChainMarket(chain: string, addrs: string[]): Promise<Map<string, LiveMarket>> {
  if (chain !== POOLS_TRADE_CHAIN) return fetchIndexedMarket(chain, addrs);

  // ⚠️ THE INDEXED PAIR IS `fetchIndexedMarket`, NOT `fetchListedMarket`.
  //
  // This branch existed to ADD the launchpad to the pools.trade chain, and it
  // did that by replacing the indexed path wholesale — so robinhood was the one
  // chain that never got the GT→DexScreener gap-fill, invisibly, because DS did
  // not carry the chain when this was written. The moment it did, giving
  // robinhood a `dexscreener` slug took its GT-only PRIORITY away (it now
  // "has a fallback") while this branch still never asked DexScreener for it:
  // 62/66 priced went to 0/66. A registry saying a source exists and a code
  // path that cannot reach it is worse than either alone.
  // THIRD SOURCE, AND IT IS THE ONE THAT CANNOT MOVE. The two above are HTTP:
  // an indexer that may not carry a pre-migration token, and a launchpad API
  // this repo has already had to chase across three outages in two days. The
  // launchpad's CONTRACTS are neither — the bonding curve's reserves and the
  // graduated V4 pool's slot0 are on chain and answer whatever a vendor does.
  // It sits at the BOTTOM anyway: an indexed pool is still the better reading,
  // and this must only ever fill what nothing else priced. It never rejects and
  // never outlives its own deadline, so adding it cannot slow or fail a cycle.
  const [indexed, launch] = await Promise.allSettled([
    fetchIndexedMarket(chain, addrs),
    fetchLaunchMarket(chain, addrs),
  ]);
  const primary = indexed.status === "fulfilled" ? indexed.value : null;
  const secondary = launch.status === "fulfilled" ? launch.value : null;
  const onChain = primary?.size && secondary?.size ? null : await fetchPonsFallbackMarket(chain, addrs);
  // Every source down for this chain is the one case the caller must see as a
  // failure — reporting an empty map would read as "listed, but no activity".
  if (!primary && !secondary && !onChain?.size)
    throw indexed.status === "rejected" ? indexed.reason : new Error(`no market data (${chain})`);

  const out = new Map(onChain ?? []);
  for (const [addr, m] of secondary ?? []) out.set(addr, m); // an HTTP launchpad reading wins over the raw curve
  for (const [addr, m] of primary ?? []) out.set(addr, m); // an indexed pool wins over both
  return out;
}

/** Merge live market data onto the paid listings. Any listing without live
 *  data keeps its fallback figures, so the board always renders. */
async function loadListedTokens(): Promise<BoardToken[]> {
  const rows = await loadRows();
  const byChain = rowsToAddressesByChain(rows);
  const fallback = rowsToBoardTokens(rows);

  const fetchOne = async ([chain, addrs]: [string, string[]]) => {
      try {
        return { chain, map: await fetchChainMarket(chain, addrs) };
      } catch (err) {
        // SAID, per chain, per cycle — before this, a chain whose every
        // provider failed simply fell out of the allSettled results and its
        // rows rendered their captured-at-listing zeros with nothing anywhere
        // naming a cause: seven Robinhood listings sat on a public board as
        // "$0 · $0 · $0" for however long it took a person to count them. One
        // greppable line per failing chain per cycle is the price of never
        // diagnosing that from a screenshot again.
        console.warn(`[market] ${chain}: every provider failed this cycle — ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
  };
  // GT-ONLY CHAINS DRAW FROM THE BUDGET FIRST. The site's own demand can
  // exceed its GT budget in one cycle, and whichever chunks queue last lose —
  // survivable for every chain DexScreener also covers (they fall back and
  // still price), fatal for the one it does not: Robinhood rendered 0/66
  // priced, every cycle, while Solana rendered 162/192, because seven Solana
  // chunks that had a fallback were spending the budget three Robinhood chunks
  // needed. The chains that cannot recover go first and are AWAITED before the
  // rest start; the covered chains then compete among themselves, losers
  // landing on DexScreener as designed. Costs the covered chains ~a second of
  // start latency inside a 60s cycle.
  const [gtOnly, covered] = partitionByFallback(Object.entries(byChain));
  const marketResults = [
    ...(await Promise.allSettled(gtOnly.map(fetchOne))),
    ...(await Promise.allSettled(covered.map(fetchOne))),
  ];
  const anyLive = marketResults.some((r) => r.status === "fulfilled" && r.value.map.size > 0);
  if (!anyLive) throw new Error("no live market data for any listing");

  const live = new Map<string, Map<string, LiveMarket>>();
  for (const r of marketResults) if (r.status === "fulfilled") live.set(r.value.chain, r.value.map);

  // A token the providers priced an hour ago and miss THIS cycle must not
  // collapse to its captured-at-listing figures — that is how a priced row
  // renders a dash for one bad chunk. Memory fills only what the cycle
  // missed; a fresh reading always wins (see lastGood.ts).
  for (const [chain, addrs] of Object.entries(byChain)) {
    const map = live.get(chain) ?? new Map<string, LiveMarket>();
    const filled = fillFromLastGood(chain, map, addrs);
    // Transition only — see lastGood.ts. At WARN every cycle this was six lines
    // a minute describing the ordinary state of this box, and it buried
    // everything else in pm2.
    const say = shouldReport(chain, filled.length);
    if (say === "recovered")
      console.log(`[market] ${chain}: every token priced again — the last-known stand-in is no longer needed`);
    else if (say)
      console.warn(
        `[market] ${chain}: serving the last-known reading for ${filled.length} token(s) the providers missed` +
          `${say === "still" ? " (still)" : ""} — a lost GeckoTerminal chunk, not a dead chain`,
      );
    if (!live.has(chain) && map.size > 0) live.set(chain, map);
  }

  // The listing row behind each board token, so the logo ladder reads the
  // STORED value rather than the one `rowToBoardToken` already filled with the
  // CDN convention — that guess outranking a real image_url is the whole bug
  // (see pickLogo). Keyed rather than zipped by index: the mapping is 1:1 today
  // and an index that silently drifts would hand one token another's artwork.
  const rowOf = new Map(rows.map((r) => [`${r.chain}:${r.address.toLowerCase()}`, r]));
  // ⚠️ AN UPLOAD WHOSE FILE IS GONE IS NOT A STORED LOGO. `data/listings.json`
  // is mirrored to Mongo and restored from it; `data/uploads/` is not — so a
  // box that loses its disk comes back with every row still asserting
  // `/api/media/<hex>.png` and not one of those files behind it. Left alone the
  // row is monogrammed FOR EVER: `pickLogo` calls it "stored", so the resolver
  // never queues it, and `setResolvedLogo` refuses to write over a row that has
  // a logoUrl at all. One directory listing per rebuild answers it for every
  // row at once, and reports nothing missing when it cannot look (mediaFile.ts).
  const lost = await lostUploads(rows.map((r) => r.logoUrl), { list: listUploads });
  // Candidates for the logo sweep, with what it takes to RANK them — the sweep
  // only looks up a handful per pass, so which handful matters.
  const needLogo: { chain: string; address: string; featured: boolean; vol: number }[] = [];

  const tokens = fallback.map((t) => {
    const m = live.get(t.chain)?.get(t.address.toLowerCase());
    // A logo a provider asserted is worth remembering even though we did not
    // have to resolve it: GT drops `image_url` on the odd cycle, and without
    // this the row would flicker back to a monogram whenever it does.
    if (m?.logoUrl) rememberLogo(t.chain, t.address, m.logoUrl);
    const row = rowOf.get(`${t.chain}:${t.address.toLowerCase()}`);
    // The row's own logo — unless it is an upload we no longer hold, in which
    // case it is a 404 wearing the shape of a decision and must lose to every
    // answer below it. Cleared in the store too (fire-and-forget, below), or
    // the resolver's write can never land.
    const storedLogo = row?.logoUrl && !isLostUpload(lost, row.logoUrl) ? row.logoUrl : undefined;
    const logo = pickLogo({
      stored: storedLogo,
      live: m?.logoUrl,
      resolved: knownLogo(t.chain, t.address),
      chain: t.chain,
      address: t.address,
    });
    // "convention" and "none" both mean nobody has actually given this token a
    // logo — the row is drawing a monogram or a guess, and it is exactly what
    // the resolver is for.
    if ((logo.kind === "convention" || logo.kind === "none") && shouldLookUp(t.chain, t.address))
      needLogo.push({
        chain: t.chain,
        address: t.address,
        featured: t.trendingRank != null,
        vol: m?.vol["24h"] ?? t.vol["24h"],
      });

    // ⚠️ THE POOL WE ALREADY HAVE. GeckoTerminal hands the top pool back with
    // every board refresh, and /api/ohlcv and /api/trades were each paying a
    // separate lookup for the same answer the moment a visitor opened the page.
    // Planting it in the cache they already read costs nothing and removes an
    // upstream request per token page — on a quota counted per IP, that is the
    // cheapest saving available anywhere in this app.
    if (m?.poolAddress) {
      const net = CHAINS[t.chain]?.geckoNetwork;
      if (net) rememberPool(net, t.address, m.poolAddress);
    }

    if (!m) return { ...t, logoUrl: logo.url }; // keep fallback figures for this listing
    const score = dexvraScore({ chg: m.chg, liq: m.liq, taxPct: t.taxPct, txns: m.txns, holders: t.holders });
    const v = visualFor(t.symbol);
    return {
      ...t,
      logoUrl: logo.url,
      priceUsd: m.priceUsd,
      mcap: m.mcap ?? t.mcap,
      liq: m.liq ?? t.liq,
      chg: m.chg,
      vol: m.vol,
      txns: m.txns,
      gradient: v.gradient,
      trend: syntheticTrend(t.symbol, m.chg["24h"]),
      score,
      source: "live" as const,
      ageMinutes: m.ageMinutes ?? t.ageMinutes,
      listedMinutesAgo: t.listedMinutesAgo,
      poolAddress: m.poolAddress,
    };
  });

  // FIRE AND FORGET, deliberately. Resolving a logo means up to three
  // rate-limited APIs and a verification fetch — a board render must never wait
  // on that. The sweep is bounded and one-at-a-time (logoFill.ts); what it
  // finds lands in the listing store, so the row is fixed for good rather than
  // for this process's lifetime.
  // RANKED, because a sweep does 8 rows and a board can be short by 80: a
  // featured row and a row nobody scrolls to are not worth the same lookup.
  // (The sweep's own comment says the caller hands them over ranked — this is
  // where that becomes true, rather than a comment describing nothing.)
  needLogo.sort((a, b) => Number(b.featured) - Number(a.featured) || b.vol - a.vol);
  backfillLogos(needLogo, {
    queued: needLogo.length,
    // The token contract's own logo, for a Pons-chain row. The resolver asks
    // it only on a launchpad chain; a curve token's artwork lives nowhere
    // else, and this is how a row whose form autofill missed it heals.
    resolve: (c, a) => resolveLogo(c, a, { pons: ponsContractLogo }),
    persist: setResolvedLogo,
    // …and then off the public gateways for good. Best-effort: the CAS in
    // `pinLogo` is what decides, and a row that moved on keeps what it moved to.
    pin: (chain, address, url) =>
      pinResolvedLogo(chain, address, url, { commit: pinLogo }),
    log: (msg) => console.log(msg),
  });

  // Forget the dead uploads in the store, so the sweep's answer has somewhere
  // to land. Best-effort and off the render path: a failed write costs one more
  // rebuild, never the board. Said out loud ONCE — the write is what makes it
  // once, since a cleared row no longer matches on the next cycle. Artwork
  // disappearing off a paid listing is a fact an operator is owed even when the
  // site heals it by itself.
  const dead = rows.filter((r) => isLostUpload(lost, r.logoUrl));
  if (dead.length > 0)
    void forgetLostUploads(dead.map((r) => ({ chain: r.chain, address: r.address })))
      .then((cleared) => {
        for (const c of cleared) {
          const r = rowOf.get(`${c.chain}:${c.address.toLowerCase()}`);
          console.warn(
            `[logos] ${r?.sym ?? c.address} (${c.chain}): the uploaded logo ${r?.logoUrl ?? ""} is no longer on disk — cleared, the resolver will look for a replacement`,
          );
        }
      })
      .catch(() => {});

  return tokens;
}

/** The `logo()` a Pons token's own contract publishes (`ipfs://…` or https),
 *  read through the launch record the site already caches for 20s. Null for a
 *  token Pons never launched, and on any failure — the resolver records the
 *  source as unreachable rather than as "no artwork". */
async function ponsContractLogo(_chain: string, address: string): Promise<string | null> {
  const launch = await fetchPonsLaunch(address);
  return launch?.logo ?? null;
}

function buildHeat(tokens: BoardToken[]): ChainHeat[] {
  const byChain = new Map<string, { vol: number; chg: number; n: number }>();
  for (const t of tokens) {
    const e = byChain.get(t.chain) ?? { vol: 0, chg: 0, n: 0 };
    e.vol += t.vol["24h"];
    // An absurd change is unreadable, not heat — bound it so one dead pool
    // does not swing a whole chain's average (see SANE_CHANGE_PCT).
    e.chg += Math.abs(t.chg["24h"]) <= SANE_CHANGE_PCT ? t.chg["24h"] : 0;
    e.n++;
    byChain.set(t.chain, e);
  }
  return [...byChain.entries()]
    .map(([chain, e]) => ({
      chain,
      temp: Math.max(5, Math.min(45, Math.round(Math.log10(Math.max(e.vol, 1)) * 4 + e.chg / e.n / 8))),
      vol24h: e.vol,
    }))
    .sort((a, b) => b.vol24h - a.vol24h)
    .slice(0, 3);
}

// Algorithmic Signal Feed — derived from on-chain data, NOT human votes.
function buildSignals(tokens: BoardToken[]): Signal[] {
  const sig: Signal[] = [];
  const byScore = [...tokens].sort((a, b) => b.score - a.score);
  const top = byScore[0];
  if (top)
    sig.push({ kind: "score", color: "#3DDC97", symbol: top.symbol, chain: top.chain, text: `hits a Dexvra Score of <b>${top.score}</b> — strongest signal right now`, minutesAgo: 2 });

  const whale = [...tokens].sort((a, b) => b.vol["1h"] - a.vol["1h"])[0];
  if (whale)
    sig.push({ kind: "whale", color: "#7CE0B0", symbol: whale.symbol, chain: whale.chain, text: `whale inflow — <b>${fmtCap(whale.vol["1h"])}</b> volume in the last hour`, minutesAgo: 7 });

  // A "momentum spike" leads with the biggest 1h gain that is actually
  // measurable — a five-million-percent reading off a near-dead pool is noise,
  // not momentum.
  // …and with TRADING behind it. The sane bound catches the absurd readings and
  // misses the quiet ones: `+79.0% in 1h` on a token that traded five cents all
  // day is the same noise at a legal magnitude, and the home page would publish
  // it as a headline while the board directly underneath ranked that token last
  // for exactly the same reason. One screen, two claims.
  const mover = [...tokens]
    .filter((t) => tradedEnough(t) && Math.abs(t.chg["1h"]) <= SANE_CHANGE_PCT)
    .sort((a, b) => b.chg["1h"] - a.chg["1h"])[0];
  if (mover && mover.chg["1h"] > 0)
    sig.push({ kind: "volume", color: "#E7C77A", symbol: mover.symbol, chain: mover.chain, text: `momentum spike <b>+${mover.chg["1h"].toFixed(1)}%</b> in 1h`, minutesAgo: 11 });

  const fresh = [...tokens].sort((a, b) => a.listedMinutesAgo - b.listedMinutesAgo)[0];
  if (fresh)
    sig.push({ kind: "listing", color: "#B79CFF", symbol: fresh.symbol, chain: fresh.chain, text: `new paid listing on <b>${CHAINS[fresh.chain]?.label ?? fresh.chain}</b>`, minutesAgo: fresh.listedMinutesAgo });

  const safe = [...tokens].filter((t) => t.taxPct === 0 && (t.liq ?? 0) > 3e6).sort((a, b) => (b.liq ?? 0) - (a.liq ?? 0))[0];
  if (safe)
    sig.push({ kind: "lock", color: "#3DDC97", symbol: safe.symbol, chain: safe.chain, text: `deep liquidity <b>${fmtCap(safe.liq)}</b>, 0% tax`, minutesAgo: 19 });

  return sig;
}

function buildWire(signals: Signal[]): WireItem[] {
  return signals.slice(0, 3).map((s) => ({
    color: s.color,
    html: `<b>${esc(s.symbol)}</b> ${s.text}`,
    time: s.minutesAgo < 60 ? `${s.minutesAgo}m` : `${Math.round(s.minutesAgo / 60)}h`,
  }));
}

export async function getTokensPayload(): Promise<TokensPayload> {
  let tokens: BoardToken[];
  let live = true;
  // `within` absorbs the load's own rejection, so the two failure modes this
  // has — down, and too slow to wait for — reach the same fallback and neither
  // can surface as an unhandled rejection once nobody is awaiting the load.
  const board = await within(cached(BOARD_KEY, PRICE_TTL, loadListedTokens), COLD_WAIT_MS);
  if (board.ok) {
    tokens = board.value;
  } else {
    tokens = rowsToBoardTokens(await loadRows());
    live = false;
  }
  // ⚠️ THE MONEY IS NOT A PROJECT — filtered ONCE, here, and therefore true of
  // every surface at the same time: the trending board, Top Coins, the movers,
  // the heat map, the wire, the chain counts and the tracked-volume figure.
  // Patching it into each component instead is how the board and the ticker end
  // up disagreeing about what is on the board, which this file has already paid
  // for once. Only auto-listings are touched (see hideFromBoard): somebody's
  // paid listing is somebody's money.
  const hidden = tokens.filter(hideFromBoard);
  if (hidden.length) tokens = tokens.filter((t) => !hideFromBoard(t));
  // Said, not silent — but on the TRANSITION and by NAME. A count printed every
  // cycle is the flood this line was written next to a fix for, and "2" over
  // three visible offenders is exactly the ambiguity that hid a dead symbol
  // rule for a whole deploy.
  const say = hiddenReport(hidden.map((t) => t.symbol));
  if (say) console.log(`[market] ${say}`);
  const signals = buildSignals(tokens);
  return {
    build: BUILD,
    tokens,
    heat: buildHeat(tokens),
    signals,
    wire: buildWire(signals),
    trackedVol24h: tokens.reduce((s, t) => s + t.vol["24h"], 0),
    live,
    // ⚠️ WHEN THE DATA WAS READ, NEVER WHEN THE RESPONSE WAS BUILT. An expired
    // board is served instantly now, so `Date.now()` here would stamp a reading
    // from an hour ago as a reading from this second — and `freshness()` prints
    // that stamp under the board as "3s ago". A staleness the reader cannot see
    // is the reassuring reading of a state that is not.
    updatedAt: (live ? cache.storedAt(BOARD_KEY) : undefined) ?? Date.now(),
  };
}

export async function getFearGreed(): Promise<FearGreed> {
  try {
    const v = await cached(FNG_KEY, FNG_TTL, fetchFearGreed);
    // `updatedMinutesAgo` is alternative.me's OWN reading age, measured when we
    // fetched it — so a value served from the cache has to carry the time it
    // has since spent sitting there, or a provider we have not reached for
    // three hours goes on reporting the age it had when we last did.
    const at = cache.storedAt(FNG_KEY);
    if (!at) return v;
    const held = Math.max(0, Math.round((Date.now() - at) / 60_000));
    return held ? { ...v, updatedMinutesAgo: v.updatedMinutesAgo + held } : v;
  } catch {
    return SEED_FEAR_GREED;
  }
}
