// Keyless likes + replies + REPOSTS, via X's internal GraphQL and an anonymous
// guest token — the session x.com mints for a logged-out visitor.
//
// SHIPS ON (`RAID_GUEST_METRICS=0` turns it off — see sourceFlag.js for why the
// default flipped). It is the only free route that returns a repost count, and
// it is also the least sanctioned thing in this repo. What makes it defensible:
//
//  • NO ACCOUNT IS ATTACHED. That is the entire reason it uses a guest token
//    rather than a session cookie. The exposure is an IP being throttled, not
//    the @listingdexvra account the listing, trending and pump pipelines post
//    from. Do not "improve" this into cookie auth.
//  • X rotates the GraphQL operation hash on its own schedule. The id is
//    resolved in THREE tiers — `X_GUEST_QUERY_ID` in .env, then one discovered
//    from x.com's own JavaScript bundle, then the built-in seed — so a rotation
//    publishes its own fix and costs neither a deploy nor an operator who
//    happens to be awake. TREAT THE SEED AS EXPECTED-TO-BE-STALE: do not
//    "fix" a 404 by editing it.
//  • When a feature flag is missing, X answers with a message naming the exact
//    key. That message IS the fix, so it is logged verbatim.
//
// AND THE HONEST CAVEAT: this and xEmbed.js are NOT independent fallbacks.
// Both are gated by X's IP reputation, so a datacenter block takes them out
// together. Turning both on buys coverage of different METRICS, not
// redundancy. The only genuinely independent paths are the paid token
// (metered per app, not per IP) and the Crew goal, which makes zero X requests.
const log = require("../helpers/logger");
const { sourceEnabled } = require("./sourceFlag");
// The bundle sweep is SHARED with the timeline reader — see xBundle.js. Two
// sweeps would download the same megabytes twice and get the host blocked twice
// as fast, for ids that live in the same files.
const bundle = require("./xBundle");

const TIMEOUT_MS = 8000;
const COOLDOWN_MS = 120 * 1000;
const GUEST_TTL_MS = 60 * 60 * 1000;
const DISCOVERY_TTL_MS = bundle.TTL_MS;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Not a secret and not ours: this is the constant x.com ships in its own JS
// bundle for anonymous visitors, and it is what the activation endpoint
// expects. Env-overridable because X has rotated it before.
const WEB_BEARER =
  process.env.X_GUEST_BEARER ||
  "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const OPERATION = "TweetResultByRestId";
// EXPECTED TO BE STALE. It is the last resort, not the source of truth — X
// rotates this hash on its own schedule and every rotation 404s every post.
const SEED_QUERY_ID = "0hWvDhmW8YQ-S_ib3azIrw";

// Not a set of choices — a compatibility shim. X rejects the WHOLE request when
// a flag it expects is absent, and the rejection names the missing key.
const DEFAULT_FEATURES = {
  creator_subscriptions_tweet_preview_api_enabled: true,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

let cooldownUntil = 0;
let cooldownReason = "";
let guest = null; // { token, at }
let discovered = null; // { at, id }
let discoveryTried = 0;

const isOnCooldown = (at = Date.now()) => at < cooldownUntil;

/**
 * The operation id to use right now, and where it came from.
 *
 * Read PER CALL. An operator's `X_GUEST_QUERY_ID` ALWAYS wins — discovery must
 * never overrule a value a human set deliberately, or the documented escape
 * hatch stops working exactly when they reach for it.
 */
function queryId() {
  const env = String(process.env.X_GUEST_QUERY_ID || "").trim();
  if (env) return { id: env, from: "env" };
  if (discovered && Date.now() - discovered.at < DISCOVERY_TTL_MS) {
    return { id: discovered.id, from: "discovered" };
  }
  return { id: SEED_QUERY_ID, from: "seed" };
}

function armCooldown(reason, at = Date.now()) {
  cooldownUntil = at + COOLDOWN_MS;
  cooldownReason = reason;
}

/** Read PER CALL so an operator's fix applies without a restart. A bad override
 *  must never take the source down — it falls back to the built-in set. */
function features() {
  const raw = process.env.X_GUEST_FEATURES;
  if (!raw) return DEFAULT_FEATURES;
  try {
    return JSON.parse(raw);
  } catch (e) {
    log.warn(`[raid] X_GUEST_FEATURES is not valid JSON (${e.message}) — using the built-in set`);
    return DEFAULT_FEATURES;
  }
}

/**
 * Ask x.com's own bundle for a live id for THIS operation.
 *
 * Delegated to xBundle, which owns the sweep and its throttle: the timeline
 * reader needs ids out of the same megabytes, and two sweeps would download
 * them twice and get the host blocked twice as fast.
 *
 * @returns {Promise<string>} the discovered id, or "" when nothing was found.
 */
async function discoverQueryId() {
  const cachedId = bundle.cached(OPERATION);
  if (cachedId) {
    discovered = { at: Date.now(), id: cachedId };
    return cachedId;
  }
  const ids = await bundle.discoverQueryIds([OPERATION]);
  const id = ids[OPERATION] || "";
  if (id) discovered = { at: Date.now(), id };
  return id;
}

/**
 * Mint (or reuse) an anonymous guest token.
 *
 * Cached for an hour: real guest tokens last hours, and ACTIVATION IS ITSELF
 * RATE LIMITED — minting one per poll would get the host blocked faster than
 * the reads would.
 */
async function guestToken({ force = false } = {}) {
  const now = Date.now();
  if (!force && guest && now - guest.at < GUEST_TTL_MS) return guest.token;
  const res = await fetch("https://api.x.com/1.1/guest/activate.json", {
    method: "POST",
    headers: { Authorization: WEB_BEARER, "User-Agent": UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => null);
  const token = body && body.guest_token;
  if (!token) throw new Error("guest activation returned no token");
  guest = { token, at: now };
  return token;
}

/**
 * Read likes + replies + reposts for one post. Never throws.
 *   { ok:true, likes, replies, retweets, quotes, bookmarks, text, source:"guest" }
 *   { ok:false, error, cooldown?, gone? }
 */
async function fetchGuestMetrics(tweetId, { retried = false, rediscovered = false } = {}) {
  if (!tweetId) return { ok: false, error: "no post id" };
  if (isOnCooldown()) return { ok: false, error: cooldownReason, cooldown: true };

  let res;
  let token;
  // Resolved ONCE per attempt and carried into the 404 branch, which has to
  // know which id was actually refused to decide whether a retry is anything
  // more than a second identical request.
  const qid = queryId();
  try {
    token = await guestToken();
    const qs = new URLSearchParams({
      variables: JSON.stringify({
        tweetId: String(tweetId),
        withCommunity: false,
        includePromotedContent: false,
        withVoice: false,
      }),
      features: JSON.stringify(features()),
    });
    res = await fetch(`https://api.x.com/graphql/${qid.id}/${OPERATION}?${qs}`, {
      headers: {
        Authorization: WEB_BEARER,
        "x-guest-token": token,
        "User-Agent": UA,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // Activation failures land here too, deliberately — the caller only needs
    // to know the anonymous path is unavailable, not which half of it failed.
    armCooldown("X's anonymous read endpoint is unreachable");
    log.warn(`[raid] guest read failed (network): ${e && e.message}`);
    return { ok: false, error: cooldownReason, cooldown: true };
  }

  if (res.status === 403) {
    // A stale guest token is routine and a fresh one is cheap, so this is the
    // one failure worth retrying immediately. Retrying forever is not.
    if (!retried) {
      guest = null;
      // `rediscovered` is carried through: the two retries are bounded
      // independently, but neither may reset the other's budget.
      return fetchGuestMetrics(tweetId, { retried: true, rediscovered });
    }
    armCooldown("X refused the anonymous session");
    return { ok: false, error: cooldownReason, cooldown: true };
  }

  if (res.status === 404) {
    // AMBIGUOUS: either the post is gone, or OUR queryId went stale because X
    // rotated its operation hash. Reporting `gone` would cancel every live raid
    // on healthy posts the first time that happens, so this is a plain source
    // failure and the embed endpoint — which CAN tell those apart — decides.
    //
    // It does NOT arm the process-wide cooldown, for the same reason the paid
    // path's 404 does not: one deleted post must not blind every other group's
    // live raid. And it is worse here, because this source never reports `gone`
    // — so the raid on the dead post keeps polling for its full hour, re-arming
    // the backoff every time it lapsed and freezing every other group's counts
    // for the duration.
    // A stale hash is the half we can repair without anyone's help, so ask
    // x.com's own bundle for the current id and retry ONCE — but only when
    // discovery came back with a DIFFERENT one. Retrying the id that was just
    // refused is a guaranteed second 404: one more request against a host that
    // has already said no, and one more chance to look like progress.
    //
    // An operator-pinned X_GUEST_QUERY_ID is never overruled. It is the
    // documented escape hatch, and a hatch that quietly ignores the value you
    // put in it is worse than none — so their id is named in the log instead.
    if (!rediscovered && qid.from !== "env") {
      const fresh = await discoverQueryId();
      if (fresh && fresh !== qid.id) {
        return fetchGuestMetrics(tweetId, { retried, rediscovered: true });
      }
    }
    log.warn(
      `[raid] guest read 404 for post ${tweetId} with queryId ${qid.id} (${qid.from}) — ` +
        (qid.from === "env"
          ? "if EVERY post 404s, the X_GUEST_QUERY_ID you pinned in .env is stale: clear it to let the bot rediscover one."
          : "if EVERY post 404s, X rotated the hash and rediscovery could not reach x.com. Run: npm run raid:check"),
    );
    return { ok: false, error: "X's anonymous read endpoint returned nothing for this post" };
  }

  if (res.status !== 200) {
    armCooldown(res.status === 429 ? "X is rate limiting anonymous reads" : "X's anonymous read endpoint is unreachable");
    return { ok: false, error: cooldownReason, cooldown: true };
  }

  const body = await res.json().catch(() => null);
  if (body && Array.isArray(body.errors) && body.errors.length) {
    const msg = body.errors.map((e) => e && e.message).filter(Boolean).join("; ");
    armCooldown("X rejected the anonymous read");
    // Logged VERBATIM: a missing-feature error names the exact key, so this
    // message is the fix.
    log.warn(`[raid] guest read rejected: ${msg} — set X_GUEST_FEATURES to match`);
    return { ok: false, error: cooldownReason, cooldown: true };
  }

  const result = body && body.data && body.data.tweetResult && body.data.tweetResult.result;
  if (!result) {
    armCooldown("X's anonymous read returned nothing usable");
    return { ok: false, error: cooldownReason, cooldown: true };
  }
  const legacy = result.legacy || (result.tweet && result.tweet.legacy);
  if (!legacy) {
    // The only `gone` this module emits: X answered about this post and said
    // there is nothing to show.
    return { ok: false, error: "post not available (deleted or restricted)", gone: true };
  }

  return {
    ok: true,
    likes: Number(legacy.favorite_count) || 0,
    replies: Number(legacy.reply_count) || 0, // the REAL reply count, unlike the embed source
    retweets: Number(legacy.retweet_count) || 0,
    quotes: Number(legacy.quote_count) || 0,
    bookmarks: legacy.bookmark_count == null ? null : Number(legacy.bookmark_count),
    text: String(legacy.full_text || legacy.text || ""),
    source: "guest",
  };
}

const isEnabled = () => sourceEnabled("RAID_GUEST_METRICS");

/** Test seam. */
function _reset() {
  cooldownUntil = 0;
  cooldownReason = "";
  guest = null;
  // Without these a discovered id — or a spent discovery budget — leaks into
  // the next test, which is the kind of cross-test coupling that reads as a
  // flake months later. The shared sweep is cleared too: it now outlives this
  // module, so resetting only the local copy would leave the next case looking
  // at an id this one discovered.
  discovered = null;
  discoveryTried = 0;
  bundle._reset();
}

module.exports = {
  fetchGuestMetrics,
  guestToken,
  features,
  isEnabled,
  isOnCooldown,
  queryId,
  discoverQueryId,
  // Re-exported from its new owner so callers (and tests) that reach for it here
  // keep working — the sweep moved, the contract did not.
  findQueryId: bundle.findQueryId,
  _reset,
  SEED_QUERY_ID,
  DEFAULT_FEATURES,
  COOLDOWN_MS,
  DISCOVERY_TTL_MS,
};
