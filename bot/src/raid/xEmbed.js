// Keyless likes + replies, from the endpoint behind X's embedded-tweet widget.
//
// SHIPS ON since the raid could otherwise read nothing at all (see
// sourceFlag.js for that reversal). `RAID_FREE_METRICS=0` turns it off, and
// there are three concrete reasons an operator might want to — none of them
// squeamishness, and all three are still true:
//
//  1. It IP-blocks datacenter ranges hardest, and a VPS is exactly that
//     profile. When it goes it takes every group's raid at once, with no error
//     we own and nothing to appeal to.
//  2. `conversation_count` is the size of the WHOLE conversation — replies to
//     replies included — not X's `reply_count`. So the card can show a number
//     that DISAGREES with the one X prints on the post itself. For a scoreboard
//     a paying group is staring at, that alone disqualifies it as the default.
//  3. It is an undocumented internal endpoint with no contract, and it returns
//     HTTP 200 with an empty body intermittently. Read naively that is
//     `favorite_count → 0`, which paints a live raid at zero.
//
// It also CANNOT see reposts — the field is not withheld, it is not sent — so
// `retweets` is null, never 0. The caller uses exactly that to drop a repost
// goal it could never measure instead of running a raid that can only expire.
//
// It is tried AFTER xGuest.js, which answers the question this one cannot
// (reposts) and reports the true reply count rather than the conversation size.
const log = require("../helpers/logger");
const { sourceEnabled } = require("./sourceFlag");

const HOST = "https://cdn.syndication.twimg.com";
const TIMEOUT_MS = 8000;
const COOLDOWN_MS = 120 * 1000;
// A bare node/undici User-Agent is the first thing edge protection drops.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let cooldownUntil = 0;
let cooldownReason = "";

const isOnCooldown = (at = Date.now()) => at < cooldownUntil;

function armCooldown(reason, at = Date.now()) {
  cooldownUntil = at + COOLDOWN_MS;
  cooldownReason = reason;
}

/**
 * X's own widget checksum. Without a matching token the endpoint 404s.
 *
 * The float division loses precision on a 19-digit id — that imprecision is
 * part of the algorithm on BOTH sides, so it must be reproduced, not "fixed"
 * with BigInt. `6 ** 2` is 36 (base-36); the replace strips the decimal point
 * and every zero, not just leading ones.
 */
function widgetToken(tweetId) {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(6 ** 2).replace(/(0+|\.)/g, "");
}

// Deliberately LOOSER than the resolver's URL parser. Copying the strict
// {5,25} rule down here rejected real early-Twitter ids — id 20 is Jack
// Dorsey's first tweet and is exactly what a diagnostic probes with.
const looksLikeId = (id) => /^\d{1,25}$/.test(String(id || ""));

/**
 * Read likes + replies for one post. Never throws.
 *   { ok:true, likes, replies, retweets:null, quotes:null, text, unsupported:["retweets"], source:"embed" }
 *   { ok:false, error, cooldown?, gone? }
 */
async function fetchEmbedMetrics(tweetId, { timeoutMs = TIMEOUT_MS } = {}) {
  if (!looksLikeId(tweetId)) return { ok: false, error: "no post id" };
  if (isOnCooldown()) return { ok: false, error: cooldownReason, cooldown: true };

  const qs = new URLSearchParams({ id: String(tweetId), token: widgetToken(tweetId), lang: "en" });
  let res;
  try {
    res = await fetch(`${HOST}/tweet-result?${qs}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    armCooldown("X's public post data is unreachable");
    log.warn(`[raid] embed read failed (network): ${e && e.message}`);
    return { ok: false, error: cooldownReason, cooldown: true };
  }

  if (res.status === 404) {
    // A real 404 here IS authoritative — this endpoint answers for any live
    // public post, so a miss means the post is genuinely gone or private.
    return { ok: false, error: "post not found (deleted or private)", gone: true };
  }
  if (res.status !== 200) {
    armCooldown(res.status === 429 ? "X is rate limiting the public post data" : "X's public post data is unreachable");
    log.warn(`[raid] embed read failed (HTTP ${res.status})`);
    return { ok: false, error: cooldownReason, cooldown: true };
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  // HTTP 200 with an empty body, an HTML bot-check interstitial served as 200,
  // or a JSON OBJECT that carries no counts — X's TweetTombstone shape, or a
  // bare {}. All three are unreadable, and reading the last one as
  // `favorite_count → 0` is the exact "partial object paints a live raid at
  // zero" collapse this module exists to prevent: a raid would launch from a
  // baseline of 0, then complete on its next poll the moment the endpoint
  // answered properly, having generated no engagement at all.
  //
  // The presence of the FIELD is the test, not its truthiness — a genuinely
  // unliked post reports favorite_count: 0, which is a real reading.
  if (!body || typeof body !== "object" || !Number.isFinite(Number(body.favorite_count))) {
    armCooldown("X's public post data is unreadable");
    return { ok: false, error: cooldownReason, cooldown: true };
  }

  return {
    ok: true,
    likes: Number(body.favorite_count) || 0,
    // NOT reply_count — see the header. It is the only number available here.
    replies: Number(body.conversation_count) || 0,
    retweets: null, // not withheld: not sent
    quotes: null,
    text: String(body.text || ""),
    unsupported: ["retweets"],
    source: "embed",
  };
}

const isEnabled = () => sourceEnabled("RAID_FREE_METRICS");

/** Test seam. */
function _reset() {
  cooldownUntil = 0;
  cooldownReason = "";
}

module.exports = { fetchEmbedMetrics, widgetToken, isEnabled, isOnCooldown, _reset, COOLDOWN_MS };
