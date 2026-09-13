// A watched account's latest posts, via X's internal GraphQL on an anonymous
// guest token. Source #1 of the timeline reader — see xTimeline.js.
//
// It shares xGuest's TOKEN and NOT its cooldown, and both halves matter:
//
//  • the token, because activation is itself rate limited — minting a second
//    one per process gets the host blocked faster than the reads would;
//  • not the cooldown, because a stale TIMELINE hash must never freeze the LIKE
//    counts. They are different operations behind different hashes, and X
//    rotates them independently.
//
// TWO OPERATIONS: a handle has to be resolved to a numeric id first, and that id
// never changes, so it is cached for the life of the process — a watched account
// then costs ONE request per read rather than two.
//
// THE PARSER IS A BOUNDED WALK, not a path expression. X nests this timeline
// differently across builds (`timeline_v2` vs `timeline`, entries vs modules vs
// the pinned entry), and a hard-coded path turns every rename into a silent
// empty timeline — which the watcher reads as "no new posts, cursor fine". The
// walk finds quoted and retweeted tweets too, so THE AUTHOR CHECK is what makes
// it safe: a node whose author cannot be proved is dropped, because "probably
// theirs" points a paying group's raid at a stranger's post.
const log = require("../helpers/logger");
const { sourceEnabled } = require("./sourceFlag");
const xGuest = require("./xGuest");
const bundle = require("./xBundle");

const TIMEOUT_MS = Math.min(60000, Math.max(3000, Number(process.env.X_TIMELINE_TIMEOUT_MS) || 15000));
const COOLDOWN_MS = 120 * 1000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const WEB_BEARER =
  process.env.X_GUEST_BEARER ||
  "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const OP_USER = "UserByScreenName";
const OP_TWEETS = "UserTweets";
// EXPECTED TO BE STALE — the last resort, never the source of truth. Do not
// "fix" a 404 by editing these; discovery publishes the rotation's own fix.
const SEED_USER_QID = "G3KGOASz96M-Qu0nwmGXNg";
const SEED_TWEETS_QID = "V7H0Ap3_Hh2FyS75OCDO3Q";

const FEATURES = {
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  rweb_tipjar_consumption_enabled: true,
  hidden_profile_likes_enabled: true,
  hidden_profile_subscriptions_enabled: true,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
};

let cooldownUntil = 0;
let cooldownReason = "";
const userIds = new Map(); // handle(lowercase) → rest_id

const isEnabled = () => sourceEnabled("RAID_GUEST_METRICS");
const isOnCooldown = (at = Date.now()) => at < cooldownUntil;

function armCooldown(reason, at = Date.now()) {
  cooldownUntil = at + COOLDOWN_MS;
  cooldownReason = reason;
  return reason;
}

/** env → discovered → seed, read PER CALL so an operator's pin always wins. */
function queryIds() {
  const envUser = String(process.env.X_GUEST_USER_QUERY_ID || "").trim();
  const envTweets = String(process.env.X_GUEST_USER_TWEETS_QUERY_ID || "").trim();
  return {
    user: envUser || bundle.cached(OP_USER) || SEED_USER_QID,
    tweets: envTweets || bundle.cached(OP_TWEETS) || SEED_TWEETS_QID,
    userPinned: !!envUser,
    tweetsPinned: !!envTweets,
  };
}

async function gql(queryId, operation, variables, token) {
  const qs = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(FEATURES),
  });
  return fetch(`https://api.x.com/graphql/${queryId}/${operation}?${qs}`, {
    headers: {
      Authorization: WEB_BEARER,
      "x-guest-token": token,
      "User-Agent": UA,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/**
 * Walk the payload for tweet nodes. Bounded in DEPTH rather than trusting a
 * path — see the header. Collects every `{ __typename: "Tweet" }` it meets.
 */
function collectTweets(node, out = [], depth = 0) {
  if (!node || typeof node !== "object" || depth > 14 || out.length > 200) return out;
  if (Array.isArray(node)) {
    for (const v of node) collectTweets(v, out, depth + 1);
    return out;
  }
  if (node.__typename === "Tweet" && node.legacy) out.push(node);
  for (const k of Object.keys(node)) collectTweets(node[k], out, depth + 1);
  return out;
}

/**
 * A node → an ORIGINAL post by `handle`, or null.
 *
 * The author is read from the node's own user_results. A node with no provable
 * author is dropped: the walk finds quoted and retweeted tweets too, and a raid
 * pointed at a stranger's post is worse than a raid that did not start.
 */
function normalize(node, handle) {
  const legacy = node && node.legacy;
  if (!legacy) return null;
  const id = String(legacy.id_str || (node.rest_id ?? ""));
  if (!/^\d{5,25}$/.test(id)) return null;
  if (legacy.retweeted_status_result || legacy.retweeted_status_id_str) return null;
  if (legacy.in_reply_to_status_id_str || legacy.in_reply_to_screen_name) return null;
  const author =
    node.core &&
    node.core.user_results &&
    node.core.user_results.result &&
    node.core.user_results.result.legacy &&
    node.core.user_results.result.legacy.screen_name;
  if (!author) return null; // unprovable → never ours
  if (String(author).toLowerCase() !== String(handle).toLowerCase()) return null;
  const createdAt = legacy.created_at ? new Date(legacy.created_at).getTime() : 0;
  return {
    id,
    text: String(legacy.full_text || legacy.text || ""),
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
  };
}

/** handle → rest_id, cached forever (an id never changes). */
async function resolveUserId(handle, token, { rediscovered = false } = {}) {
  const key = handle.toLowerCase();
  const hit = userIds.get(key);
  if (hit) return { ok: true, id: hit };

  const ids = queryIds();
  const res = await gql(ids.user, OP_USER, { screen_name: handle, withSafetyModeUserFields: true }, token);
  if (res.status === 404) {
    // AMBIGUOUS on this endpoint: the handle may be gone, or OUR queryId may be
    // stale. Ask the bundle once before believing the account does not exist —
    // calling it `gone` would tell an admin to change a perfectly good account.
    if (!rediscovered && !ids.userPinned) {
      const fresh = await bundle.discoverQueryIds([OP_USER]);
      if (fresh[OP_USER] && fresh[OP_USER] !== ids.user) {
        return resolveUserId(handle, token, { rediscovered: true });
      }
    }
    return { ok: false, error: "X's anonymous read endpoint moved (queryId may be stale)" };
  }
  if (res.status !== 200) {
    return { ok: false, error: armCooldown(res.status === 429 ? "X is rate limiting anonymous reads" : "X refused the anonymous read") };
  }
  const body = await res.json().catch(() => null);
  const result = body && body.data && body.data.user && body.data.user.result;
  if (!result || result.__typename === "UserUnavailable") {
    return { ok: false, error: `@${handle} is not available to logged-out readers`, gone: true };
  }
  const id = String(result.rest_id || "");
  if (!id) return { ok: false, error: armCooldown("X's anonymous read returned nothing usable") };
  userIds.set(key, id);
  return { ok: true, id };
}

/**
 * The account's latest original posts, newest first. Never throws.
 *   { ok:true, source:"guest", posts, raw }
 *   { ok:false, error, cooldown?, gone? }
 */
async function fetchUserPosts(handle, { rediscovered = false } = {}) {
  if (!isEnabled()) return { ok: false, error: "the anonymous source is switched off" };
  if (isOnCooldown()) return { ok: false, error: cooldownReason, cooldown: true };

  let token;
  try {
    token = await xGuest.guestToken();
  } catch (e) {
    return { ok: false, error: armCooldown("X's anonymous read endpoint is unreachable"), cooldown: true };
  }

  const who = await resolveUserId(handle, token).catch((e) => ({ ok: false, error: (e && e.message) || "user lookup failed" }));
  if (!who.ok) return { ok: false, error: who.error, gone: who.gone, cooldown: isOnCooldown() };

  const ids = queryIds();
  let res;
  try {
    res = await gql(
      ids.tweets,
      OP_TWEETS,
      {
        userId: who.id,
        count: 20,
        includePromotedContent: false,
        withQuickPromoteEligibilityTweetFields: false,
        withVoice: false,
        withV2Timeline: true,
      },
      token,
    );
  } catch (e) {
    log.warn(`[raid] guest timeline read failed for @${handle} (net): ${e && e.message}`);
    return { ok: false, error: armCooldown("X's anonymous read endpoint is unreachable"), cooldown: true };
  }

  if (res.status === 404) {
    // NEVER `gone`. The user id already resolved, so the account exists — this
    // is our hash, not their account. Calling it gone would cancel live raids on
    // healthy accounts the first time X rotates.
    if (!rediscovered && !ids.tweetsPinned) {
      const fresh = await bundle.discoverQueryIds([OP_TWEETS]);
      if (fresh[OP_TWEETS] && fresh[OP_TWEETS] !== ids.tweets) {
        return fetchUserPosts(handle, { rediscovered: true });
      }
    }
    log.warn(
      `[raid] guest timeline 404 for @${handle} with queryId ${ids.tweets}` +
        (ids.tweetsPinned ? " — the X_GUEST_USER_TWEETS_QUERY_ID pinned in .env is stale; clear it to self-heal" : ""),
    );
    return { ok: false, error: "X's anonymous timeline endpoint returned nothing" };
  }
  if (res.status !== 200) {
    return {
      ok: false,
      error: armCooldown(res.status === 429 ? "X is rate limiting anonymous reads" : "X refused the anonymous read"),
      cooldown: true,
    };
  }

  const body = await res.json().catch(() => null);
  if (body && Array.isArray(body.errors) && body.errors.length) {
    const msg = body.errors.map((e) => e && e.message).filter(Boolean).join("; ");
    // Logged VERBATIM: a missing-feature error names the exact key, so the
    // message IS the fix.
    log.warn(`[raid] guest timeline rejected: ${msg}`);
    return { ok: false, error: armCooldown("X rejected the anonymous timeline read"), cooldown: true };
  }
  const nodes = body ? collectTweets(body) : [];
  if (!body || !nodes.length) {
    // EMPTY IS NOT QUIET. An account that genuinely only retweets still puts
    // nodes in the payload — none at all means we could not read the shape, and
    // reporting that as "no new posts" is the one wrong answer that looks right.
    return { ok: false, error: armCooldown("X's anonymous timeline was unreadable"), cooldown: true };
  }

  const posts = nodes
    .map((n) => normalize(n, handle))
    .filter(Boolean)
    .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1));
  cooldownUntil = 0;
  cooldownReason = "";
  return { ok: true, source: "guest", posts, raw: nodes.length };
}

/** Test seam. */
function _reset() {
  cooldownUntil = 0;
  cooldownReason = "";
  userIds.clear();
}

module.exports = {
  fetchUserPosts,
  isEnabled,
  isOnCooldown,
  queryIds,
  collectTweets,
  normalize,
  _reset,
  SEED_USER_QID,
  SEED_TWEETS_QID,
  COOLDOWN_MS,
};
