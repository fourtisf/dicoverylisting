// A LOGO FOR EVERY ROW ON THE BOARD, from whichever index has one.
//
// "beberapa token tidak punya logo — cari sumber projectnya dan tambahkan
// logo." The board was drawing `BT`, `SH`, `FL` monograms: the right fallback,
// and the wrong thing to have to draw for a project whose artwork is sitting on
// four public indexes.
//
// WHY THE SITE RESOLVES THIS AT ALL, when bot/src/services/tokenLogo.js exists
// The bot's resolver is richer (it can reach the launchpads and Trust Wallet)
// and it is the same idea — but it runs from `npm run listings:fix`, a manual
// script an operator has to remember. This repo has already learnt what that
// costs: "apt-get install is not a fix, it is a request" cost six days of
// banners publishing boxes. A row listed today gets its logo today, without
// anyone typing anything, or the monogram comes back with the next listing.
// What the site resolves it PERSISTS to the listing store, so the answer is
// found once and then belongs to the bot's board too.
//
// THE ORDER — FREE SOURCES FIRST, because a logo lookup that spends a
// GeckoTerminal request is a chart that does not draw (they share one ~30/min
// per-IP quota):
//   1. DexScreener pair info — what the project itself uploaded; no tight limit
//   2. Trust Wallet assets   — a GitHub CDN icon set, EVM only, free
//   3. GeckoTerminal token   — a second index, but it COSTS the shared quota,
//                              so it is only asked when 1 and 2 came up empty
//   4. CoinGecko by contract — curated; a human has looked at this one; paced
//   5. DexScreener's CDN     — a URL CONVENTION, not an answer (see below)
//
// Relative imports with extensions: node:test resolves this file, and "@/" is
// a Next-only alias.
import { CHAINS } from "../../config/chains.ts";
import { ipfsCandidates, ipfsPath } from "../ipfsGateways.ts";
import { gtGet } from "./gt.ts";

const TIMEOUT_MS = 8000;

export type LogoSource = "pons" | "dexscreener" | "trustwallet" | "geckoterminal" | "coingecko" | "dexscreener-cdn";

export interface LogoResult {
  /**
   * ⚠️ THE WHOLE POINT OF THIS SHAPE. `ok: true, url: null` means every source
   * ANSWERED and none had artwork — the only state in which a caller may
   * remember "this token has no logo". `ok: false` means at least one source
   * could not be asked, and the honest answer is "not known yet": cache that
   * as a miss and one rate-limited minute leaves a token monogrammed for good.
   */
  ok: boolean;
  url: string | null;
  source: LogoSource | null;
  /** Candidates we actually fetched, in order — so a caller can report WHERE a
   *  logo came from. "42 of 50 from CoinGecko" is the difference between a
   *  working chain of sources and one source quietly carrying all of it. */
  tried: LogoSource[];
  /** Sources that could not be asked, with the reason. Never silently dropped:
   *  an outage on our side must not be reported as "the project has no logo". */
  unreachable: string[];
}

/** Only https. An http:// image is a mixed-content block in the browser, and a
 *  data: URI from an upstream is not artwork we want to store in a listing. */
const httpsUrl = (u: unknown): string | null => {
  const s = String(u ?? "").trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : null;
};

/**
 * Three verdicts, because two of them are not the same fact.
 *
 *   image       — it really serves one
 *   not-image   — it ANSWERED and it is not one (a 404, a CDN's HTML error page)
 *   unreachable — we could not get a decision (DNS, a timeout, a 5xx, a refusal)
 *
 * ⚠️ THE THIRD ONE IS THE POINT. `resolveLogo` promises that `ok: true,
 * url: null` means "every source answered and this project has no artwork" —
 * the ONLY state in which a caller may remember a miss for twelve hours. A
 * verification we could not complete used to collapse into `false`, i.e. into
 * "not artwork", so a CDN that timed out was written into the store as a
 * project with no logo. That is the rate-limit-as-an-answer defect this whole
 * module is built around, one function further down the chain.
 */
export type ImageVerdict = "image" | "not-image" | "unreachable";

async function probe(url: string, method: "HEAD" | "GET"): Promise<ImageVerdict> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "user-agent": "Mozilla/5.0 (compatible; DexvraLogo/1.0)", accept: "image/*,*/*" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
      cache: "no-store",
    });
    // ⚠️ A GET's body must be released or the socket stays busy until the GC
    // gets round to it — and this runs on a long-lived server, dozens of
    // candidates at a time. HEAD has no body, so cancelling is a no-op there.
    const done = (v: ImageVerdict) => {
      void res.body?.cancel().catch(() => {});
      return v;
    };
    // A refusal or a 5xx is a fact about the HOST; only a 4xx that is not a
    // refusal is a fact about the file.
    if (!res.ok) return done(res.status >= 500 || REFUSAL.has(res.status) ? "unreachable" : "not-image");
    const type = String(res.headers.get("content-type") ?? "").toLowerCase();
    if (type.startsWith("image/")) return done("image");
    if (type) return done("not-image"); // a 200 carrying HTML is a CDN's error page
    // No content-type at all: a HEAD that says nothing has said nothing, and
    // only a GET — which carried the bytes — is evidence either way.
    return done(method === "GET" ? "image" : "unreachable");
  } catch {
    return "unreachable"; // a candidate we could not reach is not a candidate we refused
  }
}

/**
 * Does this URL actually serve an image? Never throws.
 *
 * ⚠️ HEAD IS AN OPTIMISATION, AND ITS ANSWER IS NOT GET'S ANSWER. This used to
 * fall through to GET on a 405/501 alone and RETURN on everything else — so a
 * CDN answering HEAD with 403, or 404, or `text/html`, or by hanging up, was
 * written off while a plain GET served the file perfectly well. That is
 * precisely what `$MORTY` looked like: artwork visible on DexScreener, a
 * monogram on our board, and `/api/logo/route.ts` — which issues a plain GET,
 * exactly like the browser — able to fetch it the whole time.
 *
 * So the guard now measures the stack the RENDERER uses: any HEAD outcome
 * short of "yes, an image" is retried as GET, and only GET's answer is final.
 *
 * This is not the "fail over on a TRANSPORT error only" rule being broken. That
 * rule's stated reason is that an HTTP status means the host answered and the
 * same request gets the same status everywhere else — and HEAD and GET are
 * DIFFERENT REQUESTS to the same host, which is the one case the reason does
 * not cover. The cost is one extra request per rejected candidate, against
 * unmetered image CDNs, capped by the sweep at eight rows.
 */
export async function checkImage(url: string): Promise<ImageVerdict> {
  const head = await probe(url, "HEAD");
  if (head === "image") return head;
  return probe(url, "GET");
}

/** The boolean question, for callers that only want to know whether to use the
 *  url. Anything that is not a verified image is not one to render. */
export async function isImage(url: string): Promise<boolean> {
  return (await checkImage(url)) === "image";
}

/**
 * DexScreener's token-image CDN path.
 *
 * A CONVENTION we construct rather than an answer we were given, which is why
 * it is LAST and why it is verified like everything else: it can always be
 * built and is very often a 404. Storing one unverified turns "no logo" into
 * "broken image", and the monogram at least looks deliberate.
 */
export function cdnGuess(chain: string, address: string): string | null {
  const slug = CHAINS[chain]?.dexscreener;
  if (!slug || !address) return null;
  // EVM addresses are stored lowercased on that CDN; base58/base64 chains are
  // case-significant and must go verbatim.
  const addr = /^0x[a-fA-F0-9]{40}$/.test(address) ? address.toLowerCase() : address;
  return `https://dd.dexscreener.com/ds-data/tokens/${slug}/${addr}.png?size=lg`;
}

// ── the sources ─────────────────────────────────────────────────────────────
// Each returns a url or null ("asked, nothing there") and THROWS when it could
// not be asked. That distinction is the whole contract above; a source that
// swallowed its own failure would report an outage as an absence of artwork.

async function dsLogo(chain: string, address: string): Promise<string | null> {
  const slug = CHAINS[chain]?.dexscreener;
  if (!slug) return null; // DexScreener does not carry this chain — an answer
  refuseIfBenched("DexScreener");
  const res = await fetch(`https://api.dexscreener.com/tokens/v1/${slug}/${encodeURIComponent(address)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (res.status === 404) return null; // no pairs — an answer about the token
  if (REFUSAL.has(res.status)) {
    bench("DexScreener", DS_COOLDOWN_MS);
    throw new Error(`DexScreener ${res.status} — refusing this server, benched for ${DS_COOLDOWN_MS / 1000}s`);
  }
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  const pairs = (await res.json()) as { baseToken?: { address?: string }; info?: { imageUrl?: string } }[];
  const want = address.toLowerCase();
  for (const p of Array.isArray(pairs) ? pairs : []) {
    // Only pairs where our token is the BASE side: a token also appears as the
    // quote side of someone else's pair, and that pair's image is the OTHER
    // token's — a wrong logo, which is worse than none.
    if ((p.baseToken?.address ?? "").toLowerCase() !== want) continue;
    const u = httpsUrl(p.info?.imageUrl);
    if (u) return u;
  }
  return null;
}

/** Trust Wallet's assets repo — a curated community icon set on GitHub's CDN,
 *  EVM only, and FREE: no key, no rate limit, and — the reason it moves ahead
 *  of GeckoTerminal — it costs nothing from the GeckoTerminal quota the charts
 *  are fighting over. The path is keyed on the EIP-55 CHECKSUMMED address; our
 *  listing store keeps EVM addresses checksummed, and a wrong-case guess simply
 *  fails `isImage` and is skipped, so this only ever adds coverage. */
const TW_CHAIN: Record<string, string> = {
  ethereum: "ethereum",
  bsc: "smartchain",
  base: "base",
  polygon: "polygon",
  arbitrum: "arbitrum",
  optimism: "optimism",
  avalanche: "avalanchec",
};

function twGuess(chain: string, address: string): string | null {
  const slug = TW_CHAIN[chain];
  if (!slug || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${slug}/assets/${address}/logo.png`;
}

async function gtLogo(chain: string, address: string): Promise<string | null> {
  const net = CHAINS[chain]?.geckoNetwork;
  if (!net) return null;
  // Through the shared client, so a 429 the board earned does not turn every
  // logo lookup into "this project has no artwork" — that would be a rate limit
  // written permanently into the listing store.
  const res = await gtGet<{ data?: { attributes?: { image_url?: string | null } } }>(
    `/networks/${net}/tokens/${encodeURIComponent(address)}`,
  );
  if (res.status === 404) return null; // GT does not index it — an answer
  if (!res.ok) throw new Error(res.reason ?? "GeckoTerminal failed");
  const img = res.body?.data?.attributes?.image_url;
  // GT sends the literal string "missing.png" for a token with no artwork.
  return img && !String(img).endsWith("missing.png") ? httpsUrl(img) : null;
}

/*
 * ⚠️ COINGECKO IS PACED, AND IT IS THE SOURCE THAT ACTUALLY FINDS THINGS.
 *
 * Its free tier is a handful of calls a minute PER IP — and the bot suite runs
 * on the same box, against the same ceiling, for the same reason. A backfill
 * that fires one call per row is a 429 by the tenth row, and a 429 is `ok:false`
 * for every row after it. So: one call at a time, with a minimum gap between
 * them. Slower than an unpaced run; an unpaced run does not finish.
 *
 * ⚠️ AND A 429 ARMS A PROCESS-WIDE COOLDOWN. Pacing alone is not enough: with
 * eight rows in a sweep, a rate-limited minute cost sixteen further requests
 * (each row's call plus its retry) into a service that was already refusing —
 * and every one of them came back as "undecided" anyway. The bot's own
 * resolver states the same rule about GeckoTerminal's cooldown, and names what
 * ignoring it cost: "one rate limit deleted eighty-three rows' worth of
 * evidence". While the cooldown holds, CoinGecko is not asked at all and says
 * so, which is `ok:false` — never "this project has no logo".
 */
const cgGapMs = (): number => {
  const n = Number(String(process.env.CG_MIN_GAP_MS ?? "").trim());
  // Number('') is 0 — finite, non-negative, and it would silently delete the
  // pacing this comment exists to describe. The blank check is the whole guard.
  return String(process.env.CG_MIN_GAP_MS ?? "").trim() !== "" && Number.isFinite(n) && n >= 0 ? n : 2500;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cgNextAt = 0;
let cgChain: Promise<void> = Promise.resolve();
/** How long a 429 benches CoinGecko for every caller in this process, when it
 *  did not send a usable `Retry-After`. */
const CG_COOLDOWN_MS = 60_000;

/**
 * ⚠️ A SOURCE THAT HAS REFUSED US IS NOT ASKED AGAIN STRAIGHT AWAY — for EVERY
 * source, not just the one that taught us.
 *
 * CoinGecko got this rule when a 429 on row one cost a request per row for the
 * rest of the sweep. DexScreener never did, and it is the source that matters
 * most here: pump.fun artwork lives there, `resolveLogo` asks it FIRST, and a
 * box whose IP DexScreener refuses would spend one request per row proving the
 * same 403 — eight a sweep, every sweep, for ever, while every one of those
 * rows came back `undecided` and got requeued 30 minutes later.
 *
 * ONE table rather than a variable per source, because this is the third time
 * the same rule has been written in this repo (gt.ts, dsChart.ts, here) and a
 * fourth private copy is how two of them end up disagreeing.
 *
 * A 404 never benches anything: that is an ANSWER about the token ("not in
 * this index"), and treating it as an outage is how a curated miss becomes a
 * permanent monogram.
 */
const benched = new Map<string, number>();
const benchLeftMs = (name: string, at = Date.now()): number => Math.max(0, (benched.get(name) ?? 0) - at);
function bench(name: string, ms: number, at = Date.now()): void {
  const until = at + Math.max(1000, ms);
  if (until > (benched.get(name) ?? 0)) benched.set(name, until);
}
/** Throws WITHOUT a request while the source is benched. A caller reads that as
 *  unreachable, which is exactly what it is. */
function refuseIfBenched(name: string): void {
  const left = benchLeftMs(name);
  if (left > 0) throw new Error(`${name} refused this server — benched for ${Math.ceil(left / 1000)}s`);
}
/** The statuses that mean "the host is refusing US", as opposed to answering
 *  about the token. Kept in one place so a fourth source cannot pick its own. */
const REFUSAL = new Set([401, 403, 429, 451]);
const DS_COOLDOWN_MS = 5 * 60_000;

/** Serialise CoinGecko calls and space them out. Concurrent callers queue
 *  rather than all firing at once, which is what a `Promise.all` would do. */
function cgSlot(): Promise<void> {
  const wait = cgChain.then(async () => {
    const now = Date.now();
    const delay = Math.max(0, cgNextAt - now);
    if (delay) await sleep(delay);
    cgNextAt = Math.max(now, cgNextAt) + cgGapMs();
  });
  cgChain = wait.catch(() => {});
  return wait;
}

async function cgLogo(chain: string, address: string): Promise<string | null> {
  const plat = CHAINS[chain]?.coingecko;
  if (!plat) return null; // no platform id — nothing to ask, and that is an answer
  // Benched: throw WITHOUT a request. A caller reads this as unreachable, which
  // is exactly what it is — the alternative is spending the rest of the sweep's
  // rows proving the same 429 over and over.
  refuseIfBenched("CoinGecko");

  await cgSlot();
  const res = await fetch(`https://api.coingecko.com/api/v3/coins/${plat}/contract/${encodeURIComponent(address)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (res.status === 429) {
    const h = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(h) && h > 0 ? Math.min(h * 1000, 10 * 60_000) : CG_COOLDOWN_MS;
    bench("CoinGecko", wait);
    throw new Error(`CoinGecko 429 — benched for ${Math.round(wait / 1000)}s`);
  }
  // 404 is the ORDINARY answer here — CoinGecko is curated, so most memecoins
  // simply are not in it. A 429 or a 5xx is the opposite: it never looked, and
  // reporting that as "not in CoinGecko" is how a rate limit becomes a
  // permanent monogram.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const j = (await res.json()) as { image?: { large?: string; small?: string; thumb?: string } };
  return httpsUrl(j.image?.large ?? j.image?.small ?? j.image?.thumb ?? null);
}

/** Test seam: the cooldown is process-wide by design, so a test that wants a
 *  live CoinGecko has to be able to clear it. */
export function _resetCgCooldown(): void {
  benched.clear();
}

export interface LogoDeps {
  /** The token CONTRACT's own `logo()` on a Pons chain — `ipfs://<cid>` or an
   *  https url, or null. Injected by the caller that can reach the chain
   *  (providers/index.ts hands in fetchPonsLaunch); this module stays
   *  alias-free so the sweep can be driven by a test. Asked only where
   *  `CHAINS[chain].launchpad === "pons-v2"`. */
  pons?: (chain: string, address: string) => Promise<string | null>;
  ds?: (chain: string, address: string) => Promise<string | null>;
  gt?: (chain: string, address: string) => Promise<string | null>;
  cg?: (chain: string, address: string) => Promise<string | null>;
  /** Trust Wallet is a pure URL guess, but injectable so a test can silence it
   *  and exercise the DS→GT→CG→CDN order without an EVM guess in the way. */
  tw?: (chain: string, address: string) => string | null;
  /** Boolean stubs still work and mean exactly what they used to: `true` is
   *  "an image", `false` is "answered, and not one". A stub that wants to
   *  exercise the third state returns the verdict itself. */
  verify?: (url: string) => Promise<boolean | ImageVerdict>;
}

/**
 * The best logo url for a token, or `null` when no source has one.
 *
 * TWO WAVES, and the split is about CoinGecko's quota rather than speed.
 *
 *  1. DexScreener + GeckoTerminal, CONCURRENTLY — independent services, and a
 *     sweep walks dozens of rows, so serial timeouts per token are the
 *     difference between a sweep and an afternoon.
 *  2. CoinGecko, and ONLY if wave 1 produced nothing that really serves an
 *     image. It is the paced, rate-limited, per-IP one that the bot suite on
 *     the same box is also spending; a call made when we already have the
 *     artwork is a call the next row does not get. The cost is one extra round
 *     trip on the rows where wave 1 was empty — which is a background sweep's
 *     latency, not a reader's.
 *  3. The CDN convention, last, because it is a guess (see cdnGuess).
 *
 * Every candidate is verified before it is believed, in this order, and the
 * first that really serves an image wins.
 */
/** Gateways tried for a contract-published CID before it is called unreachable. */
const PONS_GATEWAY_TRIES = 4;

export async function resolveLogo(chain: string, address: string, deps: LogoDeps = {}): Promise<LogoResult> {
  const ds = deps.ds ?? dsLogo;
  const gt = deps.gt ?? gtLogo;
  const cg = deps.cg ?? cgLogo;
  const tw = deps.tw ?? twGuess;
  const verify = deps.verify ?? checkImage;
  /** Normalise the seam: an old boolean stub keeps its exact meaning. */
  const check = async (url: string): Promise<ImageVerdict> => {
    const v = await verify(url);
    return v === true ? "image" : v === false ? "not-image" : v;
  };

  const unreachable: string[] = [];
  const tried: LogoSource[] = [];
  const ask = (name: string, fn: () => Promise<string | null>): Promise<string | null> =>
    Promise.resolve()
      .then(fn)
      .catch((e: unknown) => {
        unreachable.push(`${name}: ${(e as Error)?.message || "failed"}`);
        return null;
      });

  /**
   * Verify a wave's candidates in order; the first real image ends the walk.
   *
   * ⚠️ A CANDIDATE WE COULD NOT VERIFY IS AN UNREACHABLE SOURCE, not an absence
   * of artwork. This used to read `if (await verify(url))` — so a source that
   * handed us a perfectly good url we then failed to check (a timeout, a 5xx,
   * a CDN refusing this box) fell through to `ok: unreachable.length === 0`,
   * which stayed TRUE. `sweepLogos` wrote that as `kind: "miss"` and would not
   * look again for twelve hours, and the log line said "N with no artwork
   * anywhere" about tokens whose artwork we had been handed and had simply
   * failed to open. That is a failure rendered as a fact, which is the one
   * shape this whole file exists to refuse.
   */
  const pick = async (wave: [LogoSource, string | null][]): Promise<LogoResult | null> => {
    for (const [source, url] of wave) {
      if (!url) continue;
      tried.push(source);
      const verdict = await check(url);
      if (verdict === "image") return { ok: true, url, source, tried, unreachable };
      if (verdict === "unreachable") unreachable.push(`${source}: could not verify ${url}`);
    }
    return null;
  };

  // THE TOKEN'S OWN CLAIM FIRST, on a launchpad chain. A Pons bonding-curve
  // token has no pool, so no index below has ever heard of it — the contract's
  // `logo()` is the ONLY source of its artwork, and until this rung existed the
  // sweep asked four sources that could not know it and wrote "no artwork
  // anywhere" over a picture on the token's own pad page. It is free (one
  // localhost-cached chain read) and it is the creator's own assertion.
  //
  // ⚠️ A CID IS VERIFIED ACROSS THE GATEWAY LADDER, and "no gateway served it"
  // is UNREACHABLE, never a decided miss. A CID is the hash of the bytes, so a
  // gateway 404 is a fact about the gateway; writing it down as "this project
  // has no artwork" (12h) over a cold CID that the next gateway serves is the
  // $GG flip, one consumer over. lib/ipfsGateways is the same ladder /api/logo
  // walks, so what the resolver verifies is what the page can draw.
  if (CHAINS[chain]?.launchpad === "pons-v2" && deps.pons) {
    const raw = await ask("pons", () => deps.pons!(chain, address));
    if (raw) {
      const urls = ipfsPath(raw) ? ipfsCandidates(raw, PONS_GATEWAY_TRIES) : [httpsUrl(raw)].filter((u): u is string => !!u);
      for (const url of urls) {
        tried.push("pons");
        if ((await check(url)) === "image") return { ok: true, url, source: "pons", tried, unreachable };
      }
      if (urls.length) unreachable.push(`pons: no gateway served ${raw}`);
    }
  }

  // ⚠️ THE FREE SOURCES FIRST — and GeckoTerminal is NOT free here. Its quota
  // is the same ~30/min-per-IP the charts are starving on, so a logo lookup
  // that spends a GT request is a chart that does not draw. DexScreener has
  // most memecoin artwork and no tight limit; Trust Wallet is a GitHub CDN.
  // Only when BOTH of those come up empty do we spend a GeckoTerminal call.
  const dsUrl = await ask("dexscreener", () => ds(chain, address));
  const free = await pick([
    ["dexscreener", httpsUrl(dsUrl)],
    ["trustwallet", tw(chain, address)],
  ]);
  if (free) return free;

  const onGt = await pick([["geckoterminal", httpsUrl(await ask("geckoterminal", () => gt(chain, address)))]]);
  if (onGt) return onGt;

  const curated = await pick([["coingecko", httpsUrl(await ask("coingecko", () => cg(chain, address)))]]);
  if (curated) return curated;

  const convention = await pick([["dexscreener-cdn", cdnGuess(chain, address)]]);
  if (convention) return convention;

  return { ok: unreachable.length === 0, url: null, source: null, tried, unreachable };
}

// ── which of the logos we hold does a row actually render? ───────────────────

export type LogoKind = "stored" | "live" | "resolved" | "convention" | "none";

export interface PickedLogo {
  url: string | null;
  kind: LogoKind;
}

/**
 * THE LADDER, and the bug it exists to fix.
 *
 * `rowToBoardToken` filled every row's `logoUrl` with `cdnGuess()` — a URL we
 * CONSTRUCT and that is very often a 404 — and the board pipeline then merged
 * live market data with `t.logoUrl ?? m.logoUrl`. Since the guess is never
 * null on a DexScreener chain, the `??` could never reach the second operand:
 * a made-up path permanently outranked the real `image_url` GeckoTerminal and
 * DexScreener were handing us, and the row drew a monogram while a logo sat
 * one field away. A guess must always lose to an answer.
 *
 *   stored     — the listing's own: an admin set it, or the project uploaded it
 *   live       — what a market provider asserted this cycle
 *   resolved   — what our own multi-source resolver verified
 *   convention — the DexScreener CDN path; unverified, so LAST, and marked
 *
 * `kind` is not decoration: it is how the caller knows the row is still
 * effectively logo-less and belongs in the resolver's queue.
 */
export function pickLogo(x: {
  stored?: string | null;
  live?: string | null;
  resolved?: string | null;
  chain: string;
  address: string;
}): PickedLogo {
  const storedRaw = String(x.stored ?? "").trim();
  const stored = httpsUrl(storedRaw) ?? (storedRaw.startsWith("/") ? storedRaw : null);
  if (stored) return { url: stored, kind: "stored" }; // includes our own /api/media uploads
  const live = httpsUrl(x.live);
  if (live) return { url: live, kind: "live" };
  const resolved = httpsUrl(x.resolved);
  if (resolved) return { url: resolved, kind: "resolved" };
  const guess = cdnGuess(x.chain, x.address);
  // Still worth rendering: the browser 404s quietly and <Coin> falls back to
  // the monogram, so an unverified guess costs nothing and sometimes hits.
  return guess ? { url: guess, kind: "convention" } : { url: null, kind: "none" };
}
