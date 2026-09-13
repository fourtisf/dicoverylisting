// "Did this account just post?" — a watched user's latest ORIGINAL posts, from
// whichever source this machine can actually reach.
//
// This is a different question from xMetrics's "how is this post doing?", and it
// fails differently, so it is a separate resolver with its own sources.
//
// FOUR SOURCES, THREE HOSTS, and the order is a money decision:
//
//   1. guest GraphQL   api.x.com                 RAID_GUEST_METRICS   (xGuestTimeline)
//   2. profile widget  syndication.twimg.com     always
//   3. old widget      cdn.syndication.twimg.com always
//   4. X API v2        api.twitter.com           X_BEARER_TOKEN
//
// The paid one is LAST on purpose. A free source that can see the account ends
// the read before any billable request, so the bill scales with how many watched
// accounts are HIDDEN rather than with how many are watched. `X_TIMELINE_PAID_FIRST=1`
// flips it for an operator who would rather pay for freshness — the widget pages
// are CDN-cached and can lag a minute or two.
//
// RULES THAT ARE NOT OPTIONAL, each one a way "four sources" quietly becomes one:
//
//  • COOLDOWNS ARE PER SOURCE. One shared clock is what makes four sources worth
//    nothing — the first blocked host parks the reads that would have worked.
//    isOnCooldown() means "every source that COULD answer is parked", and it
//    skips sources that are switched off: counting a disabled one made it
//    permanently false, i.e. "we are fine" on a blind box.
//  • EMPTY IS NEVER REPORTED AS QUIET. Every parser backs off when it cannot
//    find the structure it expects. A confident empty timeline is read by the
//    watcher as "no new posts, cursor fine" — the one wrong answer that looks
//    exactly like the right one.
//  • THE AUTHOR CHECK IS WHAT MAKES IT SAFE. A timeline carries retweets and
//    replies; a post with no provable author is dropped, because "probably
//    theirs" points a paying group's raid at a stranger's post.
//  • SNOWFLAKES EXCEED Number PRECISION. Every "newer than" goes through
//    newerThan() (BigInt). A Number compare misorders ids differing in the low
//    digits, which is every id posted in the same second.
const log = require("../helpers/logger");
const { sourceEnabled } = require("./sourceFlag");
const guest = require("./xGuestTimeline");

const TIMEOUT_MS = Math.min(60000, Math.max(3000, Number(process.env.X_TIMELINE_TIMEOUT_MS) || 15000));
const COOLDOWN_MS = 120 * 1000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SYNDICATION_HOST = "https://syndication.twimg.com";
const SYNDICATION_CDN = "https://cdn.syndication.twimg.com";

// name → { until, reason }
const cooldowns = new Map();

function cooled(name, now = Date.now()) {
  const c = cooldowns.get(name);
  return !!(c && now < c.until);
}
function armCooldown(name, reason, now = Date.now()) {
  cooldowns.set(name, { until: now + COOLDOWN_MS, reason });
  return reason;
}
function clearCooldown(name) {
  cooldowns.delete(name);
}

/** The sources that COULD answer right now, in the order they will be tried. */
function sourceOrder() {
  const paidFirst = /^(1|true|yes|on)$/i.test(String(process.env.X_TIMELINE_PAID_FIRST || ""));
  const free = [
    ...(guest.isEnabled() ? [{ name: "guest", read: guest.fetchUserPosts }] : []),
    { name: "syndication", read: (h) => readSyndication(h, SYNDICATION_HOST, "syndication") },
    { name: "widget", read: (h) => readSyndication(h, SYNDICATION_CDN, "widget") },
  ];
  const paid = apiToken() ? [{ name: "api", read: readFromApi }] : [];
  return paidFirst ? [...paid, ...free] : [...free, ...paid];
}

/**
 * True only when EVERY source that could answer is parked. Sources that are
 * switched off are skipped rather than counted — counting them made this
 * permanently false, which reads as "we are fine" on a box that can see nothing.
 */
function isOnCooldown(now = Date.now()) {
  const names = sourceOrder().map((s) => s.name);
  return names.length > 0 && names.every((n) => cooled(n, now));
}

/** The app-only bearer token, or "" — including the .env.example placeholder,
 *  which is recognised WITHOUT asking X. Provoking a 401 parks the paid path. */
function apiToken() {
  const raw = String(process.env.X_BEARER_TOKEN || "").trim();
  if (!raw || raw.length < 40) return "";
  if (/^A+$/.test(raw)) return ""; // nothing but A's IS the placeholder
  return raw;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * "Is snowflake `a` newer than `b`?" — BigInt, because a 19-digit id does not
 * survive Number. An unparsable id is NEVER newer: claiming newness on garbage
 * is what would fire a raid on it.
 */
function newerThan(a, b) {
  try {
    return BigInt(String(a)) > BigInt(String(b || 0));
  } catch {
    return false;
  }
}

/**
 * The @handle out of whatever an admin might paste: `@name`, bare `name`, or a
 * profile URL. A STATUS url is accepted too — an admin pasting a post link still
 * unambiguously names the account.
 */
function parseHandle(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const fromUrl = raw.match(
    /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})(?:[/?].*)?$/i,
  );
  if (fromUrl) {
    // Reserved paths that LOOK like a handle in a URL. `i` is the big one:
    // x.com/i/status/123 is the author-less post form this bot builds itself.
    const notHandles = new Set(["i", "home", "search", "explore", "intent", "hashtag", "share", "messages"]);
    if (notHandles.has(fromUrl[1].toLowerCase())) return null;
    return fromUrl[1];
  }
  const bare = raw.match(/^@?([A-Za-z0-9_]{1,15})$/);
  return bare ? bare[1] : null;
}

/** A normalized ORIGINAL post, or null when the entry is not one. */
function normalizePost(t, handle) {
  if (!t || typeof t !== "object") return null;
  const id = String(t.id_str || t.id || "");
  if (!/^\d{5,25}$/.test(id)) return null;
  // Someone else's tweet on this timeline (a retweet), or a reply — neither is
  // the project's own post, so neither is a raid target.
  if (t.retweeted_status || t.retweeted_status_id_str) return null;
  if (t.in_reply_to_status_id_str || t.in_reply_to_screen_name) return null;
  const author = String((t.user && t.user.screen_name) || "").toLowerCase();
  if (author && author !== String(handle).toLowerCase()) return null;
  const createdAt = t.created_at ? new Date(t.created_at).getTime() : 0;
  return { id, text: String(t.full_text || t.text || ""), createdAt: Number.isFinite(createdAt) ? createdAt : 0 };
}

const byNewest = (a, b) => (newerThan(a.id, b.id) ? -1 : 1);

// ── The keyless widget sources ───────────────────────────────────────────────

/**
 * X's profile-widget page. The payload is HTML whose __NEXT_DATA__ script
 * carries the timeline as JSON.
 *
 * A parse failure BACKS OFF rather than reporting an empty timeline: the caller
 * would read that as "no new posts" and advance nothing, which is silent and
 * indistinguishable from a quiet account.
 */
async function readSyndication(handle, host, name) {
  if (cooled(name)) return { ok: false, error: (cooldowns.get(name) || {}).reason, cooldown: true };
  const url = `${host}/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}?showReplies=false`;
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const reason = armCooldown(name, "X's public timeline is unreachable");
    log.warn(`[raid] timeline read failed for @${handle} via ${host} (net): ${e && e.message}`);
    return { ok: false, error: reason, cooldown: true };
  }

  // 404 is an ANSWER — the account does not exist or is suspended — and must
  // not arm a cooldown that would blind reads for every other group.
  if (res.status === 404) return { ok: false, error: `@${handle} not found on X`, gone: true };
  if (res.status !== 200) {
    const reason = armCooldown(
      name,
      res.status === 429 ? "X is rate limiting the public timeline" : "X's public timeline is unreachable",
    );
    return { ok: false, error: reason, cooldown: true };
  }

  const html = await res.text().catch(() => "");
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) {
    const reason = armCooldown(name, "X's public timeline is unreadable");
    log.warn(`[raid] timeline read: no __NEXT_DATA__ for @${handle} via ${host}`);
    return { ok: false, error: reason, cooldown: true };
  }
  let entries = null;
  try {
    const data = JSON.parse(m[1]);
    entries = data && data.props && data.props.pageProps && data.props.pageProps.timeline
      ? data.props.pageProps.timeline.entries
      : null;
  } catch {
    entries = null;
  }
  if (!Array.isArray(entries)) {
    const reason = armCooldown(name, "X's public timeline changed shape");
    log.warn(`[raid] timeline read: no entries for @${handle} via ${host}`);
    return { ok: false, error: reason, cooldown: true };
  }

  const posts = entries
    .map((e) => normalizePost(e && e.content && e.content.tweet, handle))
    .filter(Boolean)
    .sort(byNewest);
  clearCooldown(name);
  // `raw` is what X SENT, before the originals-only filter. Zero posts with raw
  // > 0 means the account has only been retweeting; zero posts with raw 0 means
  // X served an empty timeline — a completely different situation, and one that
  // used to be reported as the first.
  return { ok: true, source: name, posts, raw: entries.length };
}

// ── The paid source ──────────────────────────────────────────────────────────

const userIds = new Map(); // handle → rest_id, for the life of the process

/**
 * X API v2. Costs one billable call per read once the handle→id lookup is
 * cached, which is why the cache is permanent: an id never changes.
 */
async function readFromApi(handle) {
  const name = "api";
  if (cooled(name)) return { ok: false, error: (cooldowns.get(name) || {}).reason, cooldown: true };
  const token = apiToken();
  if (!token) return { ok: false, error: "no X API token" };
  const auth = { Authorization: `Bearer ${token}`, "User-Agent": UA };

  try {
    let id = userIds.get(handle.toLowerCase());
    if (!id) {
      const r = await fetch(`https://api.twitter.com/2/users/by/username/${encodeURIComponent(handle)}`, {
        headers: auth,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (r.status === 404) return { ok: false, error: `@${handle} not found on X`, gone: true };
      if (!r.ok) return { ok: false, error: apiReason(name, r.status), cooldown: true };
      const b = await r.json().catch(() => null);
      id = b && b.data && b.data.id;
      if (!id) return { ok: false, error: `@${handle} not found on X`, gone: true };
      userIds.set(handle.toLowerCase(), id);
    }
    const qs = new URLSearchParams({
      max_results: "10",
      exclude: "retweets,replies", // originals only, at the source
      "tweet.fields": "created_at",
    });
    const r = await fetch(`https://api.twitter.com/2/users/${id}/tweets?${qs}`, {
      headers: auth,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return { ok: false, error: apiReason(name, r.status), cooldown: true };
    const b = await r.json().catch(() => null);
    const list = (b && b.data) || [];
    const posts = list
      .map((t) => ({
        id: String(t.id || ""),
        text: String(t.text || ""),
        createdAt: t.created_at ? new Date(t.created_at).getTime() : 0,
      }))
      .filter((p) => /^\d{5,25}$/.test(p.id))
      .sort(byNewest);
    clearCooldown(name);
    return { ok: true, source: name, posts, raw: list.length };
  } catch (e) {
    const reason = armCooldown(name, "X's API is unreachable");
    log.warn(`[raid] timeline API read failed for @${handle}: ${e && e.message}`);
    return { ok: false, error: reason, cooldown: true };
  }
}

/** 401/403 park the paid path for longer than a 429: spent credits and a bad
 *  token answer identically on the next tick, so re-asking learns nothing. */
function apiReason(name, status) {
  if (status === 401 || status === 403) {
    cooldowns.set(name, { until: Date.now() + 15 * 60000, reason: "X's API refused the token (credits or key)" });
    return "X's API refused the token (credits or key)";
    }
  return armCooldown(name, status === 429 ? "X's API is rate limiting" : `X's API answered ${status}`);
}

// ── The resolver ─────────────────────────────────────────────────────────────

/**
 * The account's latest original posts, newest first. NEVER throws.
 *
 *   { ok:true, source, posts:[{id,text,createdAt}], raw }
 *   { ok:false, error, cooldown?, gone? }
 *
 * A source that fails falls THROUGH to the next: with the paid path last, its
 * 403 leaves a keyless verdict standing rather than turning a readable timeline
 * into "can't read @handle".
 */
async function fetchLatestPosts(handleRaw) {
  const handle = parseHandle(handleRaw);
  if (!handle) return { ok: false, error: "that doesn't look like an X account" };

  const sources = sourceOrder();
  if (!sources.length) return { ok: false, error: "no timeline source is available" };

  let last = { ok: false, error: "no source answered" };
  for (const s of sources) {
    // eslint-disable-next-line no-await-in-loop
    const res = await s.read(handle);
    if (res.ok) return res;
    // `gone` is authoritative — the account does not exist. Trying three more
    // sources to be told the same thing costs a request each and can park them.
    if (res.gone) return res;
    last = res;
  }
  return last;
}

/** Per-source state, for the panel and the diagnostic. */
function sourceStatus(now = Date.now()) {
  return sourceOrder().map((s) => {
    const c = cooldowns.get(s.name);
    return {
      name: s.name,
      cooling: cooled(s.name, now),
      reason: (c && c.reason) || "",
      secondsLeft: c && now < c.until ? Math.ceil((c.until - now) / 1000) : 0,
    };
  });
}

/** Test seam. */
function _reset() {
  cooldowns.clear();
  userIds.clear();
}

module.exports = {
  fetchLatestPosts,
  parseHandle,
  newerThan,
  normalizePost,
  apiToken,
  isOnCooldown,
  sourceStatus,
  sourceOrder,
  _reset,
  COOLDOWN_MS,
  TIMEOUT_MS,
  sourceEnabled,
};
