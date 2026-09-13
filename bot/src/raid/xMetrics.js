// The X metrics resolver — the ONLY entry point the raid uses.
//
// FOUR STATES, NOT TWO. Everything else here serves this distinction:
//
//   ok:true, numbers unchanged   the read SUCCEEDED and nothing happened.
//   ok:false                     we COULD NOT READ. The card must keep its
//                                last numbers under a "counts unavailable"
//                                label — a tracker that silently freezes is
//                                worse than one that admits it.
//   ok:true, retweets: null      the read succeeded but THIS METRIC IS
//                                UNKNOWABLE from the source that answered.
//                                Deliberately not 0, which would read as
//                                "nobody has reposted yet" and leave a goal
//                                sitting at 0/5 for the whole raid.
//   ok:false, gone:true          PERMANENTLY unreadable for this post.
//
// Returning a partial object — a coerced `favorite_count → 0` — collapses the
// first two into each other and paints a live raid at zero. Never do it.
//
// COST, because this is the thing people get wrong about the feature: an X API
// bill is not rent on your own account, it is a toll on READING X's database.
// The token answers "who is asking", never "whose post is being asked about" —
// the post's author pays nothing and is not consulted. Same model as the
// GeckoTerminal and DexScreener reads this bot already makes for tokens it
// does not own. Since X moved to pay-per-use, reads are $0.005 each,
// DEDUPLICATED per post per 24h UTC window, so polling one post 120 times over
// an hour bills as roughly ONE read:
//
//     one 60-minute raid  ≈ $0.005      100 raids/month ≈ $0.50
//
// The binding constraint is therefore the RATE LIMIT, not money. If you run
// enough concurrent raids to hit it, raise RAID_POLL_SEC — you cannot buy past
// an app-level rate limit.
const log = require("../helpers/logger");
const xGuest = require("./xGuest");
const xEmbed = require("./xEmbed");

const CACHE_MS = 20 * 1000;
const COOLDOWN_MS = 120 * 1000;
const TIMEOUT_MS = 8000;

const cache = new Map(); // tweetId → { at, value }
let cooldownUntil = 0;
let cooldownReason = "";
let cooldownAdvice = "";

const isOnCooldown = (at = Date.now()) => at < cooldownUntil;

// ── URL / id parsing ─────────────────────────────────────────────────────────

/** Extract the post id from anything an admin might paste. Null when it isn't
 *  an X post link at all. */
function parseTweetId(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  if (/^\d{5,25}$/.test(s)) return s; // a bare id
  const m = s.match(/(?:twitter\.com|x\.com)\/(?:#!\/)?(?:[A-Za-z0-9_]+|i\/web|i)\/status(?:es)?\/(\d{5,25})/i);
  return m ? m[1] : null;
}

/** The canonical link we store and render, whatever form was pasted. Using
 *  `/i/status/` avoids embedding a handle that may later change. */
const tweetUrl = (id) => `https://x.com/i/status/${id}`;

// ── The paid path ────────────────────────────────────────────────────────────

/**
 * The bearer token, or "" when there is nothing usable.
 *
 * THE PLACEHOLDER TEST IS "NOTHING BUT A'S", NEVER "STARTS WITH A'S" — a real
 * app-only bearer token genuinely begins with a long run of A's (base64 of a
 * leading zero run), so an unanchored check would reject every real token.
 *
 * Why detect it locally at all: `.env.example`'s placeholder sat in fourtis'
 * production for months. Every poll spent a live request discovering it, took
 * a 401, and A 401 ARMS THE PROCESS-WIDE COOLDOWN — so one config typo blinded
 * every group's raid for two minutes at a time, in a loop, forever. The
 * placeholder is recognisable without asking X, so the correct cost is zero
 * requests.
 */
function apiToken() {
  const raw = String(process.env.X_BEARER_TOKEN || "").trim();
  if (!raw) return "";
  if (/^A+$/.test(raw)) return "";
  if (raw.length < 40) return "";
  return raw;
}

const NO_SOURCE_ERROR = "the bot has no X API credentials";
const NO_SOURCE_ADVICE =
  "Set X_BEARER_TOKEN in .env to read likes and replies (about half a cent per raid — reads are billed per post " +
  "per day, not per poll). Or skip X entirely: a 🤝 Crew goal needs no key at all.";
const GUEST_ADVICE =
  "RAID_GUEST_METRICS is on but X refused the anonymous read — usually this server's IP, sometimes a rotated " +
  "X_GUEST_QUERY_ID. Run: npm run raid:check";
const FREE_SOURCE_ADVICE =
  "RAID_FREE_METRICS is on but X refused the keyless read — that endpoint blocks datacenter IPs hardest. " +
  "A paid X_BEARER_TOKEN is the reliable path.";

function armCooldown(reason, advice, at = Date.now()) {
  cooldownUntil = at + COOLDOWN_MS;
  cooldownReason = reason;
  cooldownAdvice = advice || "";
}

/**
 * GET https://api.x.com/2/tweets/:id?tweet.fields=public_metrics,text
 * with app-only bearer auth — a plain public read, no OAuth1 signing.
 */
async function readFromApi(tweetId, token) {
  let res;
  try {
    res = await fetch(`https://api.x.com/2/tweets/${tweetId}?tweet.fields=public_metrics,text`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, error: `X read failed: ${(e && e.message) || "network error"}` };
  }

  if (res.status === 404) {
    // Authoritative: a post that is deleted or private is gone for EVERY
    // source, so say so once instead of asking two more endpoints the same
    // question. And do NOT arm the cooldown — one deleted post must not blind
    // every other group's live raid for two minutes.
    return { ok: false, error: "post not found (deleted or private)", gone: true };
  }
  if (res.status === 401) {
    armCooldown(
      "X rejected the bot's API token",
      "Check X_BEARER_TOKEN in .env, then restart with --update-env so the process actually picks it up.",
    );
    log.warn("[raid] X read 401 — backing off 120s");
    return { ok: false, error: cooldownReason, advice: cooldownAdvice, cooldown: true };
  }
  if (res.status === 403) {
    // Since X went pay-per-use there is no Free tier to be on, so a 403 is
    // nearly always a zero prepaid balance — and credits exhaust SILENTLY
    // mid-raid, which makes this the first thing to check.
    armCooldown(
      "X refused the read — the account is most likely out of credits",
      "X reads are pay-per-use ($0.005 per post per day, however many times you poll it). Top up the prepaid " +
        "balance and set a spend alert.",
    );
    log.warn("[raid] X read 403 (credits) — backing off 120s");
    return { ok: false, error: cooldownReason, advice: cooldownAdvice, cooldown: true };
  }
  if (res.status === 429) {
    armCooldown("X rate limit reached", "Wait a couple of minutes, or raise RAID_POLL_SEC if you run many raids at once.");
    log.warn("[raid] X read 429 — backing off 120s");
    return { ok: false, error: cooldownReason, advice: cooldownAdvice, cooldown: true };
  }
  if (!res.ok) return { ok: false, error: `X read failed (HTTP ${res.status})` };

  const body = await res.json().catch(() => null);
  const d = body && body.data;
  const pm = d && d.public_metrics;
  if (!pm) return { ok: false, error: "X returned no public_metrics" };
  return {
    ok: true,
    likes: Number(pm.like_count) || 0,
    replies: Number(pm.reply_count) || 0,
    retweets: Number(pm.retweet_count) || 0,
    quotes: Number(pm.quote_count) || 0,
    text: String(d.text || ""),
    source: "api",
  };
}

// ── The resolver ─────────────────────────────────────────────────────────────

/**
 * Read one post's engagement. Never throws.
 *
 * `force` bypasses the per-post cache but NOT the cooldown. Used for the
 * baseline read at launch, because the baseline defines what "+15 likes" means
 * for the whole raid and must not come from a 20-second-old reading.
 */
async function fetchTweetMetrics(tweetId, { force = false } = {}) {
  if (!tweetId) return { ok: false, error: "no post id" };
  const id = String(tweetId);
  const now = Date.now();

  // Only SUCCESSES are cached, and the point is not to throttle one group's
  // own polls — it is that N groups raiding the SAME post in one window cost
  // one read between them. Caching a failure would instead hide a recovery.
  const hit = cache.get(id);
  if (!force && hit && now - hit.at < CACHE_MS) return hit.value;

  const token = apiToken();
  let apiError = null;
  let guestError = null;
  let embedError = null;

  if (token) {
    if (isOnCooldown(now)) {
      apiError = { ok: false, error: cooldownReason, advice: cooldownAdvice, cooldown: true };
    } else {
      const res = await readFromApi(id, token);
      if (res.ok) {
        cache.set(id, { at: now, value: res });
        return res;
      }
      if (res.gone) return res; // authoritative — don't ask anyone else
      apiError = res;
    }
  }

  if (xGuest.isEnabled()) {
    const g = await xGuest.fetchGuestMetrics(id);
    if (g.ok) {
      cache.set(id, { at: now, value: g });
      return g;
    }
    // Deliberately NOT returning on g.gone: a 404 from that endpoint is
    // ambiguous between "post deleted" and "our queryId is stale", and the
    // embed endpoint CAN tell those apart. Let it.
    guestError = g;
  }

  if (xEmbed.isEnabled()) {
    const p = await xEmbed.fetchEmbedMetrics(id);
    if (p.ok) {
      cache.set(id, { at: now, value: p });
      return p;
    }
    if (p.gone) return p;
    embedError = p;
  }

  const error = (apiError && apiError.error) || (embedError && embedError.error) || (guestError && guestError.error) || NO_SOURCE_ERROR;
  // Prefer the paid path's advice: it names something an operator can go and
  // fix. A free source failing is weather, not a bug.
  let advice = apiError && apiError.advice;
  if (!advice) {
    if (guestError && embedError) advice = `${GUEST_ADVICE} ${FREE_SOURCE_ADVICE}`;
    else if (guestError) advice = GUEST_ADVICE;
    else if (embedError) advice = FREE_SOURCE_ADVICE;
    else advice = NO_SOURCE_ADVICE;
  }
  return {
    ok: false,
    error,
    advice,
    cooldown: !!((apiError && apiError.cooldown) || (guestError && guestError.cooldown) || (embedError && embedError.cooldown)),
  };
}

/** Is ANY source configured? Used by the panel to explain itself up front. */
function sourcesAvailable() {
  return { api: !!apiToken(), guest: xGuest.isEnabled(), embed: xEmbed.isEnabled() };
}
const anySource = () => Object.values(sourcesAvailable()).some(Boolean);

/** Test seam. */
function _reset() {
  cache.clear();
  cooldownUntil = 0;
  cooldownReason = "";
  cooldownAdvice = "";
}

module.exports = {
  fetchTweetMetrics,
  parseTweetId,
  tweetUrl,
  apiToken,
  sourcesAvailable,
  anySource,
  isOnCooldown,
  _reset,
  CACHE_MS,
  COOLDOWN_MS,
  NO_SOURCE_ERROR,
  NO_SOURCE_ADVICE,
  GUEST_ADVICE,
  FREE_SOURCE_ADVICE,
};
