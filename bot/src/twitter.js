// X / Twitter posting (twitter-api-v2). Fully built but DISABLED unless the
// listing account's 4 OAuth 1.0a keys are present (X_ENABLED) — see
// config/constants.js for which four and where each comes from in the console.
//
// Two accounts are supported: "listing" (@listingdexvra — every listing,
// trending, rank-up, pump and gainers post) and an OPTIONAL "official" second
// account for banner ads. With X_O_* blank — the normal one-account setup —
// "official" FALLS BACK to the listing account, so a banner ad still gets
// tweeted instead of silently going nowhere.
//
// Media is uploaded when a buffer is provided; otherwise (and on any v1 upload
// 403 — free tier) it falls back to a text-only tweet. Every entry point returns
// the tweet id or null and NEVER throws: a dead X API must not fail a paid order.
const { X, X_ENABLED, X_HANDLE, X_LISTING_HANDLE, SITE_URL, xMissingKeys } = require("./config/constants");
const { fmtPrice, formatNumber } = require("./helpers/format");
const { chainOf } = require("./config/chains");
const tpl = require("./templates");
const log = require("./helpers/logger");

let TwitterApi = null;
function lib() {
  if (!TwitterApi) TwitterApi = require("twitter-api-v2").TwitterApi;
  return TwitterApi;
}

const complete = (cfg) => Boolean(cfg && cfg.appKey && cfg.appSecret && cfg.accessToken && cfg.accessSecret);

/** Credentials for an account, falling back to the listing account when the
 *  optional second one isn't configured. Returns null when neither is set. */
function credsFor(account) {
  if (account === "official" && complete(X.official)) return { cfg: X.official, used: "official" };
  return complete(X.listing) ? { cfg: X.listing, used: "listing" } : null;
}

function clientFor(account) {
  const c = credsFor(account);
  if (!c) return null;
  return {
    used: c.used,
    api: new (lib())({
      appKey: c.cfg.appKey,
      appSecret: c.cfg.appSecret,
      accessToken: c.cfg.accessToken,
      accessSecret: c.cfg.accessSecret,
    }),
  };
}

const symTag = (s) => String(s || "").replace(/^\$+/, "").toUpperCase();
const coinUrl = (coin) => coin.siteUrl || `${SITE_URL}/token/${coin.chain}/${coin.address}`;

const safeJson = (v) => {
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
};

/**
 * Classify a failure. The distinction that matters most is NETWORK vs AUTH: a
 * firewall, a corporate proxy or a sandbox egress allowlist answers with the
 * same 403 status X uses for a read-only token, and telling an operator their
 * keys were rejected when the request never left the building sends them off
 * regenerating credentials that were fine all along.
 *
 * @returns {{kind: string, message: string}} kind ∈ network | newapp-crypto |
 *   permission | suspended | auth | ratelimit | duplicate | unknown
 */
function classify(e) {
  const code = e && (e.code || (e.data && e.data.status));
  // e.data is an OBJECT for a real X error and a plain STRING for anything that
  // answered on X's behalf — a proxy, a gateway, a captive portal. Reading only
  // .detail/.title threw away the one line that said what actually happened
  // ("Host not in allowlist: api.x.com"), which is exactly the case this
  // function exists to catch. Flatten whatever shape arrived.
  const body =
    e && e.data ? (typeof e.data === "string" ? e.data : e.data.detail || e.data.title || safeJson(e.data)) : "";
  const detail = typeof body === "string" ? body : "";
  const raw = `${(e && e.message) || ""} ${detail} ${(e && e.error) || ""}`;
  // Never reached X. Proxy/allowlist rejections and DNS/TCP failures both land
  // here — the giveaway is that the body talks about the HOST, not about auth.
  if (
    /not in allowlist|egress|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|proxy|tunneling|self.signed|unable to verify/i.test(raw)
  ) {
    return { kind: "network", message: `cannot reach api.x.com — ${(e && e.message) || detail}` };
  }
  // X refuses CONTRACT ADDRESSES from a newly authenticated app for its first
  // 7 days — an anti-spam rule aimed at throwaway shill accounts, and it lands
  // as a 403 exactly like a read-only token. Calling it a permissions problem
  // sends the operator off regenerating a token that was never at fault, so it
  // gets its own kind: nothing to fix, the listing card just posts without its
  // CA line until the app ages out (see stripCryptoAddresses).
  if (/crypto address(es)? (are|is) prohibited|prohibited for the first \d+ days/i.test(raw)) {
    return {
      kind: "newapp-crypto",
      message:
        `${detail || e.message} — this is X's new-app rule, NOT a key problem. ` +
        "The tweet is retried without the contract address; the full card returns by itself once the app is 7 days past authentication.",
    };
  }
  // Twitter code 64. X uses ONE status and ONE sentence — "Your account is
  // suspended and is not permitted to access this feature" — for two situations
  // that need opposite actions:
  //
  //   • the account really is suspended → nothing posts at all, and the only
  //     fix is an appeal to X;
  //   • the app's ACCESS TIER does not carry the endpoint. v1.1 media/upload is
  //     not in the Free tier, so a perfectly healthy account gets code 64 on the
  //     MEDIA upload while its tweets keep going out fine.
  //
  // The discriminator is whether the TEXT tweet still lands ("[x] tweeted … id="
  // in the log) — a suspended account cannot tweet either. This branch exists
  // because the blanket 403 below claimed the token was READ-ONLY and told the
  // operator to REGENERATE it: wrong for both causes, and actively harmful
  // inside the 7-day window, where a fresh authorisation restarts the clock on
  // the contract-address rule. THIRD time one 403 has needed pulling apart from
  // the others (network, newapp-crypto, this) and the reason never changes:
  // one status, several causes, opposite actions. Matched on X's SENTENCE
  // rather than on the status, the way newapp-crypto is — a suspension can
  // arrive as 401 too, and the words are what identify it.
  if (/twitter code 64|"code"\s*:\s*64\b|account is suspended|not permitted to access this feature/i.test(raw)) {
    return {
      kind: "suspended",
      message:
        `${e.message}${detail ? ` — ${detail}` : ""} (403/64 — X says this account may not use this endpoint. ` +
        "Either the account is suspended, or this app's access tier does not include it — v1.1 media upload is NOT in the Free tier, " +
        "which refuses the IMAGE while text tweets keep working. Check whether \"[x] tweeted\" still appears in the log before " +
        "touching the keys: regenerating them fixes neither cause.)",
    };
  }
  if (code === 403) {
    return {
      kind: "permission",
      message: `${e.message}${detail ? ` — ${detail}` : ""} (403 — most often the Access Token is READ-ONLY: set the app to "Read and write", then REGENERATE the access token)`,
    };
  }
  if (code === 401) return { kind: "auth", message: `${e.message} (401 — the 4 keys don't match one app, or they were regenerated in the console)` };
  if (code === 429) return { kind: "ratelimit", message: `${e.message} (429 — X post cap reached for this window/tier)` };
  if (/duplicate/i.test(raw)) return { kind: "duplicate", message: `${e.message} (X rejects a repeat of a recent tweet)` };
  return { kind: "unknown", message: `${e.message}${detail ? ` — ${detail}` : ""}` };
}
const explain = (e) => classify(e).message;

// Bare on-chain addresses, by chain shape. Deliberately anchored to whole words
// so a 44-char base58 run inside a URL path is NOT matched — the token page link
// carries the address too, and X shortens every URL to t.co before scanning, so
// the link survives while the bare "CA:" line is what has to go.
const ADDRESS_RE = new RegExp(
  [
    "0x[a-fA-F0-9]{40}", // EVM
    "T[1-9A-HJ-NP-Za-km-z]{33}", // Tron
    "(?:EQ|UQ)[A-Za-z0-9_-]{46}", // TON
    "[1-9A-HJ-NP-Za-km-z]{32,44}", // Solana / base58 (last: broadest)
  ].join("|"),
  "g",
);

/**
 * Remove every LINE that carries a bare contract address, then close the gap.
 *
 * Used only as a fallback when X rejects a tweet under its new-app crypto rule.
 * Whole lines rather than the address alone, because the line is a label ("CA:")
 * whose value has gone — leaving "CA:" hanging reads worse than not saying it.
 * URLs are protected first so the token-page link (which embeds the same
 * address) is never mistaken for a bare address and dropped with its line.
 */
function stripCryptoAddresses(text) {
  const kept = String(text)
    .split("\n")
    .filter((line) => {
      const withoutUrls = line.replace(/https?:\/\/\S+/g, " ");
      ADDRESS_RE.lastIndex = 0;
      return !ADDRESS_RE.test(withoutUrls);
    })
    .join("\n");
  return kept.replace(/\n{3,}/g, "\n\n").trim();
}

// ── Post media ───────────────────────────────────────────────────────────────
// The channel post and the tweet must show the SAME artwork. fulfillment's
// postMedia() picks it (admin GIF/MP4 clip → composited still → dynamic banner →
// static asset → raw logo) and hands back one of several shapes, none of which
// twitter-api-v2 understands directly. Everything funnels through resolveMedia.
//
// Before this, X was handed the raw token LOGO while Telegram got the branded
// banner — the tweet looked like a stock avatar next to a designed channel card.
const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};
// X's per-category ceilings. Over them the upload is refused, and a refusal costs
// a request and drops the tweet to text-only — so it is checked before sending.
const MAX_BYTES = { image: 5 * 1024 * 1024, gif: 15 * 1024 * 1024, video: 512 * 1024 * 1024 };

/** Mime from the first bytes. A composited banner arrives as a bare Buffer with
 *  no name, and guessing PNG for an MP4 makes X reject the whole upload. */
function sniffMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.slice(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (buf.slice(4, 8).toString("latin1") === "ftyp") return "video/mp4";
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "video/webm";
  return null;
}

const categoryOf = (mime) =>
  mime === "image/gif" ? "gif" : String(mime || "").startsWith("video/") ? "video" : "image";

/**
 * Normalise ANY shape fulfillment.postMedia() returns into something
 * v1.uploadMedia accepts: `{ file, mimeType }` where file is a Buffer or an
 * absolute path (the library streams paths and chunk-uploads video for us).
 *
 * Returns null when the media cannot be used on X at all — most importantly a
 * bare Telegram file_id, which only Telegram can resolve. The caller then falls
 * back to the token logo rather than tweeting bare text.
 */
async function resolveMedia(media) {
  if (!media) return null;
  const src = Buffer.isBuffer(media) || typeof media === "string" ? media : media.source;
  if (!src) return null;

  if (Buffer.isBuffer(src)) {
    const mimeType = sniffMime(src) || "image/png";
    return { file: src, mimeType, bytes: src.length };
  }
  if (typeof src !== "string") return null;

  if (/^https?:\/\//i.test(src)) {
    try {
      const r = await fetch(src, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      const mimeType = sniffMime(buf) || (r.headers.get("content-type") || "").split(";")[0] || "image/png";
      return { file: buf, mimeType, bytes: buf.length };
    } catch {
      return null;
    }
  }
  // A path on disk — the animated clips and static assets. Passed through as a
  // PATH so the library streams it instead of us holding a video in memory.
  const ext = require("node:path").extname(src).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) return null; // a Telegram file_id has no extension — not usable here
  try {
    const st = require("node:fs").statSync(src);
    if (!st.isFile()) return null;
    return { file: src, mimeType, bytes: st.size };
  } catch {
    return null; // not a path we can read → almost certainly a file_id
  }
}

// Remembers that X is currently refusing contract addresses, so the window is
// not paid for twice per listing (Pay-Per-Use bills every request, and the
// rejected attempt is a request). Deliberately IN-MEMORY and short-lived:
//
//   • in-memory — the rule ends on its own, and a latch that outlived the
//     process would need a way to be cleared, which is a support ticket waiting
//     to happen. A restart simply costs one probe.
//   • short-lived — expiry is what makes it self-healing. When the 7 days are
//     up the next post after the window probes the FULL card again, it works,
//     the latch clears, and the CA line is back with no restart, no config and
//     nobody watching a calendar.
const CA_BLOCK_TTL_MS = 60 * 60 * 1000; // re-probe at most an hour later
let caBlockedUntil = 0;
const caBlocked = () => Date.now() < caBlockedUntil;

/**
 * @param media    anything fulfillment.postMedia() returns — the SAME artwork the
 *                 channel post uses (admin GIF/MP4 clip, composited banner, …).
 * @param fallback a Buffer to use when `media` can't go to X (a bare Telegram
 *                 file_id), normally the token logo.
 */
async function send(account, text, media, fallback, quoteTweetId, _retriedWithoutCa) {
  if (!X_ENABLED) {
    const missing = xMissingKeys("listing");
    log.debug(`[x] disabled — skipping tweet${missing.length ? ` (missing: ${missing.join(", ")})` : " (X_ENABLED=0)"}`);
    return null;
  }
  const client = clientFor(account);
  if (!client) {
    log.debug(`[x] no keys for account ${account}`);
    return null;
  }
  try {
    let mediaIds;
    const resolved = (await resolveMedia(media)) || (await resolveMedia(fallback));
    if (resolved) {
      const cat = categoryOf(resolved.mimeType);
      if (resolved.bytes > MAX_BYTES[cat]) {
        log.warn(
          `[x] media is ${Math.round(resolved.bytes / 1048576)}MB — over X's ${Math.round(MAX_BYTES[cat] / 1048576)}MB ${cat} limit; tweeting text-only`,
        );
      } else {
        try {
          // A path is streamed and chunk-uploaded by the library; video is also
          // polled until X finishes transcoding, so the id is safe to attach.
          const id = await client.api.v1.uploadMedia(resolved.file, { mimeType: resolved.mimeType, target: "tweet" });
          mediaIds = [id];
          log.debug(`[x] media uploaded (${resolved.mimeType}, ${Math.round(resolved.bytes / 1024)}KB)`);
        } catch (e) {
          log.warn(`[x] media upload failed (${resolved.mimeType}): ${explain(e)} — tweeting text-only`);
        }
      }
    }
    const opts = {};
    if (mediaIds) opts.media = { media_ids: mediaIds };
    if (quoteTweetId) opts.quote_tweet_id = String(quoteTweetId); // quote the listing tweet
    // Inside a known block window, post the CA-less version straight away
    // instead of paying for a rejection first. The latch expires, so the full
    // card is re-probed within the hour and comes back the moment X allows it.
    let body = text;
    if (!_retriedWithoutCa && caBlocked()) {
      const withoutCa = stripCryptoAddresses(text);
      if (withoutCa && withoutCa !== text) {
        log.debug("[x] new-app crypto window still open — posting without the contract address");
        body = withoutCa;
      }
    }
    const res = await client.api.v2.tweet(body, Object.keys(opts).length ? opts : undefined);
    const id = res && res.data && res.data.id;
    // A full card that went through means the window has closed.
    if (body === text && caBlockedUntil) {
      caBlockedUntil = 0;
      log.info("[x] contract addresses are accepted again — full listing cards resumed");
    }
    log.info(
      `[x] tweeted (${account}${client.used !== account ? ` via ${client.used}` : ""}) id=${id}` +
        `${quoteTweetId ? ` (quote of ${quoteTweetId})` : ""}`,
    );
    return id || null;
  } catch (e) {
    const c = classify(e);
    // A brand-new X app may not post contract addresses for 7 days. Rather than
    // lose the announcement — the listing is live, the buyer paid for reach —
    // send it again with the CA line removed. One retry only, and only when
    // dropping the address actually changed the text.
    if (c.kind === "newapp-crypto" && !_retriedWithoutCa) {
      const withoutCa = stripCryptoAddresses(text);
      if (withoutCa && withoutCa !== text) {
        caBlockedUntil = Date.now() + CA_BLOCK_TTL_MS; // don't pay for this rejection again
        // Nothing for the operator to do: the tweet goes out again without the
        // contract line, and the rule expires by itself once the app is seven
        // days past authentication. Console only.
        log.noise(`[x] ${c.message}`);
        log.info("[x] retrying without the contract address…");
        return send(account, withoutCa, media, fallback, quoteTweetId, true);
      }
    }
    log.warn(`[x] tweet failed (${account}): ${c.message}`);
    return null;
  }
}

const chainLabel = (c) => (chainOf(c) ? chainOf(c).label : String(c || ""));
const mcOf = (m) => (m && m > 0 ? "$" + formatNumber(m) : "TBA");

// Tier badge for the tweet — the SAME admin setting the channel post uses,
// flattened to its plain character because X has no custom emoji. A second
// hardcoded map lived here and silently ignored the operator's choice.
const xTierEmoji = (tier) => require("./channels/format").tierBadgeChar(tier) || "💎";
// @mention the project's X account, parsed from the twitter link they submitted.
function xMention(links) {
  const t = links && links.twitter;
  if (!t) return "";
  const m = String(t).match(/(?:x\.com|twitter\.com)\/@?([A-Za-z0-9_]{1,15})/i);
  return m ? ` @${m[1]}` : "";
}

// Editable via @dexvraadminbot → "X Posts". Xpress and Listing & Trending get
// distinct copy (the latter carries the tier line); both keep only the leading
// ⚡ and the tier emoji — no per-line emoji.
function listingText(coin) {
  const tag = symTag(coin.symbol);
  const tier = String(coin.tier || "").toUpperCase();
  const vars = {
    name: coin.name,
    tag,
    mention: xMention(coin.links),
    url: coinUrl(coin),
    address: coin.address,
    price: coin.price ? fmtPrice(coin.price) : "TBA",
    mcap: mcOf(coin.mcap),
    chain: chainLabel(coin.chain),
    handle: `@${X_LISTING_HANDLE}`,
  };
  if (tier && tier !== "XPRESS") {
    return tpl.t("x_listing_tiered", { ...vars, tier, tierEmoji: xTierEmoji(tier) });
  }
  return tpl.t("x_listing", vars);
}

function trendingText(coin) {
  const tag = symTag(coin.symbol);
  return tpl.t("x_trending", {
    symbol: `$${tag}`,
    name: coin.name,
    chain: chainLabel(coin.chain),
    url: coinUrl(coin),
    tag,
    mention: xMention(coin.links),
    handle: `@${X_LISTING_HANDLE}`,
  });
}

function pumpText(coin, percent, firstMc, lastMc) {
  return tpl.t("x_pump", {
    tag: symTag(coin.symbol),
    name: coin.name,
    mention: xMention(coin.links),
    percent: Math.round(percent),
    firstMc: mcOf(firstMc),
    lastMc: mcOf(lastMc),
    url: coinUrl(coin),
    handle: `@${X_LISTING_HANDLE}`,
  });
}

function rankUpText(coin, rank, change) {
  return tpl.t("x_rankup", {
    tag: symTag(coin.symbol),
    name: coin.name,
    mention: xMention(coin.links),
    rank,
    gain: Number.isFinite(Number(change)) ? `+${Math.round(Number(change))}%` : "",
    chain: chainLabel(coin.chain),
    url: coinUrl(coin),
    handle: `@${X_LISTING_HANDLE}`,
  });
}

async function verify(account = "listing") {
  const client = clientFor(account);
  if (!client) {
    const missing = xMissingKeys(account);
    return { ok: false, handle: null, kind: "nokeys", message: `missing: ${missing.join(", ") || "(none)"}` };
  }
  try {
    const me = await client.api.v2.me();
    const handle = (me && me.data && me.data.username) || null;
    return { ok: Boolean(handle), handle, kind: handle ? "ok" : "unknown", message: handle ? `@${handle}` : "X returned no user" };
  } catch (e) {
    const c = classify(e);
    log.debug(`[x] verify (${account}): ${c.message}`);
    return { ok: false, handle: null, kind: c.kind, message: c.message };
  }
}

function bannerText(booking) {
  return tpl.t("x_banner", {
    title: booking.title || "A project",
    slot: booking.slot || "",
    url: booking.linkUrl || SITE_URL,
    site: SITE_URL,
    handle: `@${X_HANDLE}`,
    mention: xMention({ twitter: booking.twitter }),
  });
}

// The daily Top-Gainers board. {list} arrives pre-built by gainers.js as plain
// text (X has no markdown and no custom emoji), so the caller owns its shape.
function gainersText(list, dateText) {
  return tpl.t("x_gainers", {
    list: String(list || "").trim(),
    date: dateText || "",
    site: SITE_URL,
    handle: `@${X_LISTING_HANDLE}`,
  });
}

module.exports = {
  enabled: () => X_ENABLED,
  /** Which of the listing account's keys are still blank — used by the boot
   *  diagnostic and `npm run x:check`. */
  missingKeys: xMissingKeys,
  /** Verify the credentials actually authenticate, and return the handle they
   *  post as. Null when X is off or the call didn't succeed — use verify() when
   *  you need to know WHY. */
  whoami: async (account = "listing") => (await verify(account)).handle,
  /**
   * Credential check with a classified outcome, so a caller can tell "your keys
   * are wrong" apart from "this box can't reach X".
   * @returns {Promise<{ok: boolean, handle: string|null, kind: string, message: string}>}
   *   kind ∈ ok | nokeys | network | permission | auth | ratelimit | unknown
   */
  verify,
  // `media` is whatever fulfillment.postMedia() produced for the SAME event —
  // the admin's GIF/MP4 clip or the composited banner, so the tweet and the
  // channel post carry identical artwork. `logo` is only a fallback for the one
  // shape X cannot use, a bare Telegram file_id.
  postListing: (coin, media, logo) => send("listing", listingText(coin), media, logo),
  postTrending: (coin, media, logo) => send("listing", trendingText(coin), media, logo),
  // Quote the token's original listing tweet when we have its id (the listing
  // card renders below the pump text, like fourtis); standalone tweet otherwise.
  postPump: (coin, percent, firstMc, lastMc, quoteTweetId, media, logo) =>
    send("listing", pumpText(coin, percent, firstMc, lastMc), media, logo, quoteTweetId),
  // Rank-ups quote the listing tweet the same way — the token's own card is the
  // context that makes "climbed to #2" mean something.
  postRankUp: (coin, rank, change, quoteTweetId, media, logo) =>
    send("listing", rankUpText(coin, rank, change), media, logo, quoteTweetId),
  postGainers: (list, dateText, media, logo) => send("listing", gainersText(list, dateText), media, logo),
  postBanner: (booking, media, logo) => send("official", bannerText(booking), media, logo),
  // Exposed for tests + the preview in @dexvraadminbot — building the copy must
  // be checkable without credentials or a network.
  _text: { listingText, trendingText, pumpText, rankUpText, bannerText, gainersText },
  // Error classification is pure and is the thing most worth pinning: it decides
  // what an operator is told to go and fix.
  _diag: { classify, stripCryptoAddresses, resolveMedia, sniffMime, categoryOf, MAX_BYTES, caBlocked: () => caBlocked(), _resetCaLatch: () => (caBlockedUntil = 0) },
};
