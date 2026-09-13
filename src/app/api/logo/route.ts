import { NextRequest, NextResponse } from "next/server";
import { IPFS_GATEWAYS, ipfsPath } from "@/lib/ipfsGateways";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server-side image proxy for external token logos. The browser can't reliably
// hotlink dexscreener / GeckoTerminal / CoinGecko CDNs (Referer + CORS +
// rate-limit), so those <img> loads intermittently failed and every token fell
// back to the gradient placeholder. We fetch server-side (no cross-origin
// Referer) and serve the bytes from our own domain, cached hard. A failure
// returns 404 so the <Coin> component's onError → emoji fallback still fires.
// SSRF-guarded by an image-host allowlist + https-only.
//
// ⚠️ THE ALLOWLIST IS PART OF "every token has a logo", NOT JUST SECURITY.
// A host that is missing here is a real, working logo url that renders as a
// monogram — refused by us, silently, with nothing in the UI to say so. That
// is how a token whose artwork lives on pump.fun's own IPFS gateway looked
// exactly like a token with no artwork at all. So the list carries the places
// token images actually live: the two indexes, the curated ones, the wallets'
// asset repos, and the IPFS gateways every launchpad mints through.
const ALLOW = [
  // indexes + curators
  "dexscreener.com",
  "geckoterminal.com",
  "coingecko.com",
  "coinmarketcap.com",
  "dextools.io",
  // wallets / token lists / DEX front-ends that host their own icon sets
  "githubusercontent.com",
  "trustwallet.com",
  "jup.ag",
  "raydium.io",
  "pancakeswap.finance",
  "1inch.io",
  // generic CDNs the above hand off to. ⚠️ Kept NARROW on purpose: a bare
  // `cloudfront.net` would make this an image proxy for every AWS customer
  // alive, which is somebody else's bandwidth and somebody else's content
  // served from our domain.
  "imagedelivery.net",
  // IPFS / Arweave — where a launchpad's metadata points. pump.fun's own
  // gateway (pump.mypinata.cloud) is under mypinata.cloud.
  "ipfs.io",
  "cloudflare-ipfs.com",
  "mypinata.cloud",
  "pinata.cloud",
  "nftstorage.link",
  "w3s.link",
  "dweb.link",
  "cf-ipfs.com",
  "arweave.net",
  "irys.xyz",
  // socials, for a project whose only artwork is its avatar
  "twimg.com",
  "cryptologos.cc",
];

/**
 * IPFS gateways, in order — a LIST, never one host.
 *
 * ⚠️ THIS WAS `const IPFS_GATEWAY = "https://ipfs.io/ipfs/"`, AND IT COST A
 * PAID LISTING ITS LOGO. `$BREAKING` stored
 * `https://ipfs.io/ipfs/<cid>`; ipfs.io answered **404**, the proxy gave up,
 * and the token drew its `BR` monogram on a page people open to decide whether
 * to buy. Nothing was wrong with the url, the CID, or the allowlist — one
 * gateway could not find the content.
 *
 * "Never one hardcoded host" is this repo's own rule, learned when Jupiter
 * retired `quote-api.jup.ag/v6` and every Solana buy died. `JUP_BASES` is the
 * reference; this is the same shape one service over.
 *
 * ⚠️ AND IT FAILS OVER ON AN HTTP STATUS, WHICH THAT RULE NORMALLY FORBIDS.
 * The reason the rule says transport-only is that "an HTTP status means the
 * host is there and answered, and the same request gets the same status
 * everywhere else". THAT IS NOT TRUE OF A CONTENT-ADDRESSED FETCH. A CID is
 * the hash of the bytes: a 404 from one gateway means *this gateway cannot
 * find them*, and another gateway serving the same CID serves byte-identical
 * content. So a 404 here is a fact about the gateway, not about the token —
 * exactly the distinction `logoFill` draws between "nothing there" and "could
 * not ask".
 *
 * Env-overridable (`IPFS_GATEWAYS`, comma-separated) so a gateway going dark
 * costs a line in `.env` rather than a deploy — the `pads.js` contract. Every
 * entry still has to pass the allowlist below; the env cannot widen it.
 */
// The ladder itself lives in lib/ipfsGateways.ts — ONE owner, shared with the
// site's logo resolver, which verifies a Pons token's contract-published CID
// against the same gateways. Two lists would drift.

/** How many gateways one request may try, and how long each gets. A logo is an
 *  `<img>` and does not block the page, but a request that can hang for half a
 *  minute is a socket held open per token on a board of two hundred. */
// ⚠️ THE CALLER'S OWN URL COUNTS AS TRY ONE. A stored `https://ipfs.io/ipfs/<cid>`
// therefore left room for only TWO fallbacks, and adding a gateway to the list
// above would have pushed one out rather than widened the ladder. Four keeps
// three real fallbacks behind the caller's url; TOTAL_MS still caps the wall
// clock, and `left()` shrinks every later try to fit inside it.
const IPFS_MAX_TRIES = 4;
const IPFS_TRY_MS = 5000;
const ONE_TRY_MS = 8000;
/**
 * The whole request's ceiling, redirects and gateway failover included.
 *
 * ⚠️ IT IS A CONTRACT WITH THE CALLER, not a local politeness knob. The bot
 * fetches its banner artwork through here on the path between a buyer's payment
 * and their post, with a timeout of its own; if this can outlast that timeout,
 * a working proxy is indistinguishable from a dead one and the caller falls
 * back to exactly the single-gateway fetch this route replaces. Any change here
 * has to move `LOGO_PROXY_MS` in bot/src/fulfillment.js with it — a test in the
 * bot asserts its timeout is the larger of the two.
 */
const TOTAL_MS = 12_000;

/** How many redirects to follow. IPFS gateways bounce to a per-CID subdomain,
 *  and CDNs bounce to their edge, so refusing redirects outright would lose
 *  real logos. */
const MAX_HOPS = 3;

function allowed(u: URL): boolean {
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  return ALLOW.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Anything a provider can hand us → an https URL, or null. */
function normalize(raw: string): URL | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    // ipfs://<cid>/<path…> and the older ipfs://ipfs/<cid> spelling. No <img>
    // on earth loads that scheme, so a token whose artwork we HAD still drew a
    // monogram until this rewrote it.
    const cid = /^ipfs:\/\//i.test(s) ? ipfsPath(s) : null;
    if (/^ipfs:\/\//i.test(s)) return cid ? new URL(IPFS_GATEWAYS[0] + cid) : null;
    return new URL(s);
  } catch {
    return null;
  }
}

/**
 * Every url worth trying for one request, in order.
 *
 * For anything but IPFS that is the one url we were given — a 404 from
 * dexscreener's CDN IS an answer about the token. For an IPFS url it is the
 * gateway the caller named FIRST (a working one must not be demoted), then the
 * others with the same CID.
 */
function candidates(url: URL): URL[] {
  const cid = ipfsPath(url.toString());
  if (!cid) return [url];
  const out = [url];
  for (const gw of IPFS_GATEWAYS) {
    if (out.length >= IPFS_MAX_TRIES) break;
    try {
      const u = new URL(gw + cid);
      if (u.toString() !== url.toString() && allowed(u)) out.push(u);
    } catch {
      /* a malformed gateway in .env costs that entry, never the request */
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("u");
  if (!raw) return new NextResponse(null, { status: 400 });
  const first = normalize(raw);
  if (!first || !allowed(first)) return new NextResponse(null, { status: 400 });

  // One url for an ordinary CDN, several gateways for an IPFS CID — see
  // IPFS_GATEWAYS for why a 404 is a fact about the gateway there and an answer
  // about the token everywhere else.
  const tries = candidates(first);
  const perTry = tries.length > 1 ? IPFS_TRY_MS : ONE_TRY_MS;
  const deadline = Date.now() + TOTAL_MS;
  // ⚠️ EVERY FETCH IS CAPPED BY WHAT IS LEFT OF THE TOTAL, not by `perTry`
  // alone. The deadline below only ever gated STARTING another gateway, so the
  // real worst case was three gateways x IPFS_TRY_MS — and up to MAX_HOPS
  // redirects inside each, every hop a fresh AbortSignal — which is 15s with no
  // redirects and far more with them, against a documented 12s budget.
  //
  // That is not merely slow: the BOT calls this with a timeout of its own, so a
  // proxy grinding through failover exactly as designed read to its caller as
  // UNREACHABLE, which sent the banner back to a raw single-gateway fetch — the
  // one thing routing through here exists to replace.
  const left = () => Math.max(250, deadline - Date.now());

  // ⚠️ NEVER DISCARD THE REASON — this route's 404 is the LAST place the per
  // gateway outcome exists. `logos:check` pulls artwork through here, so a row
  // that fails reported only `HTTP 404`, which cannot tell an operator whether
  // the CID is unpinned everywhere (nothing to fix — the artwork is gone) or
  // whether every gateway served something that is not an image (a dag-pb CID
  // that resolves to a DIRECTORY listing answers `text/html`, deterministically,
  // however well pinned it is). Those need different answers and got one shrug.
  const why: string[] = [];

  for (let i = 0; i < tries.length; i++) {
    // Only START another attempt while there is time for it. Without this the
    // worst case is every gateway's full timeout end to end, on a board asking
    // for two hundred logos.
    if (i > 0 && Date.now() > deadline) break;
    let url = tries[i];
    // Elapsed per gateway rides on the reason: "ipfs.io: no answer after 5000ms"
    // and "gateway.pinata.cloud: HTTP 429 after 310ms" send an operator to
    // different places, and a bare status could not tell them apart.
    const t0 = Date.now();
    const ms = () => `${Date.now() - t0}ms`;
    let res: Response | null = null;
    try {
      // ⚠️ REDIRECTS ARE FOLLOWED BY HAND, and every hop is re-checked against
      // the allowlist. `redirect: "follow"` hands the guard's whole job to the
      // upstream: an allowed host answering `302 http://169.254.169.254/…`
      // would have this server fetch its own cloud metadata and serve the bytes
      // back.
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        res = await fetch(url.toString(), {
          headers: { "user-agent": "Mozilla/5.0 (compatible; DexvraLogo/1.0)", accept: "image/*,*/*" },
          signal: AbortSignal.timeout(Math.min(perTry, left())),
          redirect: "manual",
          cache: "no-store",
        });
        if (res.status < 300 || res.status >= 400) break;
        const loc = res.headers.get("location");
        if (!loc) break;
        // A redirect's body is never read; release it or the socket stays busy
        // until the GC gets round to it, on a server doing this per token.
        void res.body?.cancel().catch(() => {});
        const next = normalize(new URL(loc, url).toString());
        // ⚠️ A REDIRECT SOMEWHERE WE DO NOT ALLOW ENDS THE WHOLE REQUEST, and
        // does not fall through to the next gateway: it is the one failure that
        // is about US being pointed at something, not about the content being
        // unavailable, and quietly trying elsewhere would bury it.
        if (!next || !allowed(next)) return new NextResponse(null, { status: 400 });
        url = next;
        res = null;
      }
    } catch {
      res = null; // transport failure — the next gateway may still have it
    }

    if (!res || !res.ok) {
      why.push(`${url.hostname}: ${res ? `HTTP ${res.status}` : "no answer"} after ${ms()}`);
      void res?.body?.cancel().catch(() => {});
      continue;
    }
    const ct = res.headers.get("content-type") || "image/png";
    if (!/^image\//i.test(ct)) {
      // A gateway that answers 200 with an HTML "not found" page is a miss, not
      // an image — the same thing a CDN does when it will not admit one. It is
      // ALSO what a directory CID looks like, which is why the type is recorded.
      why.push(`${url.hostname}: served ${ct.split(";")[0]} after ${ms()}`);
      void res.body?.cancel().catch(() => {});
      continue;
    }
    // Refuse a body we would only throw away — the size check below happens
    // after the download, and a declared 50MB image is not worth fetching.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > 3_000_000) {
      void res.body?.cancel().catch(() => {});
      return new NextResponse(null, { status: 404 });
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(await res.arrayBuffer());
    } catch {
      // The body died mid-download; another gateway may finish. RECORDED —
      // this case used to push nothing, and reported as a bare 404.
      why.push(`${url.hostname}: body died after ${ms()}`);
      continue;
    }
    if (!buf.length || buf.length > 3_000_000) return new NextResponse(null, { status: 404 });
    return new NextResponse(buf, {
      status: 200,
      headers: {
        // Which gateway answered, and how fast — the fact that makes "loaded on
        // run 3, failed on run 4" READABLE after the fact.
        "x-logo-via": `${url.hostname} ${ms()}`,
        "content-type": ct,
        "cache-control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
        // An SVG logo is a DOCUMENT when opened directly, and a document served
        // from our own origin can carry script. Refusing SVGs would drop real
        // logos, so they are served inert instead: no sniffing, and a CSP that
        // allows the file to reference nothing at all.
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  }

  // Every candidate refused it. 404 rather than 502 because <Coin>'s onError
  // listens for a failed load, not for a status — the monogram is the designed
  // fallback and it must still fire.
  //
  // The reason rides on a HEADER, never in a body: a browser <img> reads only
  // the status, so this costs the page nothing and gives `logos:check` the one
  // fact that separates "unpinned" from "not an image". Bounded, because it is
  // built from upstream hostnames and content types.
  return new NextResponse(null, {
    status: 404,
    headers: why.length ? { "x-logo-why": why.join("; ").slice(0, 300) } : undefined,
  });
}
