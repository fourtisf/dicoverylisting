// Auto-raid: the project posts on X, and the raid starts itself.
//
// An admin names their account on the panel (👤 X account), which turns the
// watcher ON and seeds the cursor immediately — nobody names an account to
// watch and then wants it not watched; 🤖 is the OFF switch.
//
// TWO WAYS IN, and the cheap one is the one that always works:
//
//  • THE WATCHER polls each watched handle and starts a raid on a new original
//    post. It costs a timeline read per handle per tick and depends on X being
//    willing to serve that account to a logged-out reader — which it decides
//    PER ACCOUNT. From one IP, some accounts answer and others come back empty.
//  • A PASTED LINK. The bot already reads every group message (that is how crew
//    enrolment counts people), so when an admin pastes the project's post, the
//    MESSAGE is the signal. Zero X requests to detect it, and it is the only
//    route that works on an account X hides, because it never asks X anything.
//
// RULES THAT KEEP IT FROM MISFIRING — each one is a way a raid points at the
// wrong post, or fires twice, or spends a post it never raided:
//
//  • THE FIRST LOOK ONLY SEEDS. An empty cursor means "never looked"; the first
//    read records the newest post WITHOUT raiding it. Changing the watched
//    account resets the cursor for the same reason — snowflakes are one global
//    sequence, so a stale cursor would instantly "detect" half the new account's
//    history as new.
//  • THE CURSOR ADVANCES BEFORE THE RAID STARTS. A crash between "saw it" and
//    "card posted" must not double-raid on restart: a missed auto-raid is a
//    shrug, a double raid is the group spammed. A cursor that cannot be SAVED
//    does not raid at all.
//  • FRESHNESS GATE. A post older than AUTORAID_MAX_AGE_MIN never auto-raids
//    even when newer than the cursor, which bounds every cursor bug to "one raid
//    on a recent post" instead of "raid the archive".
//  • ONE RAID PER GROUP, but a mid-raid post QUEUES rather than vanishing.
//    Killing the live raid would strand its lock snapshot, and dropping the post
//    reads as "the bot didn't detect it".
//  • EVERY NO-RAID OUTCOME IS RECORDED. `lastError` is what the panel renders;
//    without it, detection working and detection failing produce the same
//    observable state — a green panel and silence.
const { RAID_ENABLED } = require("../config/constants");
const store = require("./store");
const runner = require("./runner");
const xTimeline = require("./xTimeline");
const xMetrics = require("./xMetrics");
const tpl = require("../templates");
const { payloadArgs } = require("../helpers/message");
const log = require("../helpers/logger");

const POLL_SEC = Math.max(30, Number(process.env.AUTORAID_POLL_SEC) || 60);
const MAX_AGE_MIN = Math.max(1, Number(process.env.AUTORAID_MAX_AGE_MIN) || 10);
const PENDING_TTL_MIN = 30;
const MAX_PENDING_TRIES = 3;
const NOTICE_THROTTLE_MS = 60 * 60 * 1000;

// `${chatId}:${reason}` → when we last told that group. A dead route fails on
// EVERY tick, and a group is not a log file.
const noticed = new Map();

/**
 * The group's auto-raid state, with any missing field filled in.
 *
 * MUTATES IN PLACE and returns the SAME object every time. The spread version of
 * this — `g.autoRaid = { ...DEFAULT, ...g.autoRaid }` — replaced the object on
 * every call, so a reference taken at the top of a function silently stopped
 * pointing at the record the moment any nested call re-derived it: the cursor
 * was written, the write went to a discarded object, and the next tick raided
 * the same post again. Held references are the whole reason this is in place.
 */
const auto = (g) => {
  if (!g.autoRaid || typeof g.autoRaid !== "object") g.autoRaid = { ...store.DEFAULT_AUTORAID };
  else {
    for (const [k, v] of Object.entries(store.DEFAULT_AUTORAID)) {
      if (g.autoRaid[k] === undefined) g.autoRaid[k] = v;
    }
  }
  return g.autoRaid;
};

/** Groups the watcher should look at. */
const watched = () =>
  store.all().filter((g) => g && g.autoRaid && g.autoRaid.on && g.autoRaid.handle);

/**
 * Record why a tick produced no raid.
 *
 * PERSISTED, and only a raid actually starting clears it. Clearing on the next
 * successful READ would put the green light back sixty seconds after a failure,
 * and an admin opens the panel minutes later. That makes it routinely older than
 * the check above it on the panel, which is why the panel renders its age.
 */
async function noteOutcome(g, reason, { ok = false } = {}) {
  const a = auto(g);
  a.lastCheckedAt = Date.now();
  if (ok) a.lastOkAt = Date.now();
  if (reason) {
    a.lastError = String(reason);
    a.lastErrorAt = Date.now();
  }
  await store.save();
}

/**
 * Tell the GROUP that a post was detected and could not be raided.
 *
 * These land in a customer's community chat, in front of members who did not ask
 * and cannot act — so they say what happened and what the ADMIN does, and
 * nothing about our infrastructure or anyone's billing.
 */
async function notifyGroup(telegram, g, key, vars) {
  const throttleKey = `${g.chatId}:${key}`;
  const last = noticed.get(throttleKey) || 0;
  if (Date.now() - last < NOTICE_THROTTLE_MS) return;
  noticed.set(throttleKey, Date.now());
  try {
    const { text, extra } = payloadArgs(tpl.render(key, vars), false);
    await telegram.sendMessage(g.chatId, text, { ...extra, disable_web_page_preview: true });
  } catch (e) {
    log.debug(`[raid] couldn't notify ${g.chatId}: ${e && e.message}`);
  }
}

/**
 * Raid one specific post in one group. Shared by the watcher, the pasted link
 * and 🤖 "Raid latest post now", so the cursor rules live in ONE place.
 *
 * The cursor is advanced and SAVED before the raid is attempted — see the header.
 */
async function startOn(telegram, g, postId, { via = "auto" } = {}) {
  const a = auto(g);
  const url = xMetrics.tweetUrl(postId);

  // Mid-raid: queue rather than kill the live raid (its lock snapshot is what
  // reopens the chat) and rather than drop the post (which reads as "the bot
  // didn't detect it").
  if (g.raid && g.raid.status === "running") {
    a.pendingPostId = String(postId); // newest wins
    a.pendingAt = Date.now();
    a.lastSeenTweetId = String(postId);
    await store.save();
    log.info(`[raid] ${via}: ${g.chatId} is mid-raid — queued post ${postId}`);
    return { ok: false, queued: true };
  }

  a.lastSeenTweetId = String(postId);
  const saved = await store.save();
  if (!saved) {
    // A cursor that cannot be persisted must not raid: a restart would see the
    // post as new and raid it again, in a customer's group.
    await noteOutcome(g, "couldn't save progress — will try again");
    return { ok: false, retryable: true };
  }

  const res = await runner.startRaid(telegram, g, { tweetUrl: url, startedBy: via });
  if (res.ok) {
    a.lastError = "";
    a.lastErrorAt = 0;
    a.pendingPostId = "";
    a.pendingTries = 0;
    await store.save();
    log.info(`[raid] ${via}: started in ${g.chatId} on post ${postId}`);
    return { ok: true };
  }

  await noteOutcome(g, res.error || "the raid could not start");
  if (res.retryable) {
    a.pendingPostId = String(postId);
    a.pendingAt = Date.now();
    await store.save();
  } else {
    // Not retryable: the same thing happens again in sixty seconds. Tell the
    // group ONCE, with the link, so an admin can act on it — most of startRaid's
    // refusals return before anything is saved, so the link is all they have.
    await notifyGroup(telegram, g, "raid_notice_failed", { reason: res.error || "", url });
  }
  log.warn(`[raid] ${via}: could not start in ${g.chatId}: ${res.error}`);
  return { ok: false, retryable: !!res.retryable };
}

/** The queued post, once the group is free again. */
async function firePending(telegram, g) {
  const a = auto(g);
  if (!a.pendingPostId) return false;
  if (g.raid && g.raid.status === "running") return false;
  if (Date.now() - (a.pendingAt || 0) > PENDING_TTL_MIN * 60000) {
    a.pendingPostId = "";
    a.pendingTries = 0;
    await store.save();
    log.info(`[raid] dropped an orphaned queued post in ${g.chatId}`);
    return false;
  }
  if ((a.pendingTries || 0) >= MAX_PENDING_TRIES) {
    a.pendingPostId = "";
    a.pendingTries = 0;
    await noteOutcome(g, "gave up on a queued post after several tries");
    return false;
  }
  const postId = a.pendingPostId;
  // CLEARED BEFORE THE START, like the cursor and for the same reason.
  a.pendingPostId = "";
  a.pendingTries = (a.pendingTries || 0) + 1;
  await store.save();
  const res = await startOn(telegram, g, postId, { via: "queued" });
  return res.ok;
}

/** One watched group, one tick. Never throws. */
async function tickOne(telegram, g, postsByHandle) {
  const a = auto(g);
  const handle = xTimeline.parseHandle(a.handle);
  if (!handle) {
    // An unparsable handle used to record NOTHING, so the panel said "waiting
    // for the first check" and the watcher looked dead — for a watcher running
    // perfectly with junk to watch.
    await noteOutcome(g, `"${a.handle}" doesn't look like an X account`);
    return;
  }
  if (await firePending(telegram, g)) return;

  const res = postsByHandle.get(handle.toLowerCase());
  a.lastCheckedAt = Date.now(); // EVERY tick, read or no read — see the panel
  if (!res || !res.ok) {
    await noteOutcome(g, (res && res.error) || "couldn't read X");
    return;
  }
  a.lastOkAt = Date.now();

  const posts = res.posts || [];
  if (!posts.length) {
    // A readable answer with nothing in it. Distinguished from a failed read on
    // purpose: `raw` tells "the account only retweets" from "X served nothing".
    await noteOutcome(g, res.raw > 0 ? "no original posts yet — only reposts" : "X served an empty timeline", { ok: true });
    return;
  }

  const newest = posts[0];
  if (!a.lastSeenTweetId) {
    // FIRST LOOK SEEDS ONLY.
    a.lastSeenTweetId = String(newest.id);
    await noteOutcome(g, "", { ok: true });
    log.info(`[raid] auto-raid armed for ${g.chatId} @${handle} at post ${newest.id}`);
    return;
  }
  if (!xTimeline.newerThan(newest.id, a.lastSeenTweetId)) {
    await noteOutcome(g, "", { ok: true });
    return;
  }
  const ageMin = newest.createdAt ? (Date.now() - newest.createdAt) / 60000 : 0;
  if (newest.createdAt && ageMin > MAX_AGE_MIN) {
    a.lastSeenTweetId = String(newest.id); // spend it, but never raid it
    await noteOutcome(g, `skipped a post older than ${MAX_AGE_MIN} min`, { ok: true });
    log.info(`[raid] skipping stale post ${newest.id} for ${g.chatId} (${Math.round(ageMin)}min old)`);
    return;
  }
  await startOn(telegram, g, newest.id, { via: "auto-raid" });
}

/**
 * One pass over every watched group.
 *
 * Reads are SHARED PER HANDLE: two groups watching the same project cost one
 * timeline read, not two — and on the paid path that is the whole bill.
 */
async function runOnce(telegram) {
  const groups = watched();
  if (!groups.length) return { checked: 0 };
  const handles = new Map();
  for (const g of groups) {
    const h = xTimeline.parseHandle(g.autoRaid.handle);
    if (h) handles.set(h.toLowerCase(), h);
  }
  const postsByHandle = new Map();
  for (const [lower, handle] of handles) {
    // eslint-disable-next-line no-await-in-loop
    const res = await xTimeline.fetchLatestPosts(handle).catch((e) => ({ ok: false, error: (e && e.message) || "read failed" }));
    postsByHandle.set(lower, res);
    if (!res.ok) log.debug(`[raid] can't read @${handle}: ${res.error}`);
  }
  for (const g of groups) {
    // eslint-disable-next-line no-await-in-loop
    await tickOne(telegram, g, postsByHandle).catch((e) => log.warn(`[raid] auto-raid tick failed for ${g.chatId}: ${e && e.message}`));
  }
  return { checked: groups.length };
}

// ── The pasted link ──────────────────────────────────────────────────────────

// ONE regex captures BOTH the author and the id. Handing the url to two separate
// parsers looks tidier and is wrong: they disagree about which hosts they accept
// (a `mobile.` link parses as an id with no author), and the trigger then does
// nothing, silently.
const LINK_RE = /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/i;

/**
 * An admin pasted a link in the group. Returns true only when a raid was started
 * or queued — the caller NEVER consumes the message either way: a pasted link is
 * an observation, and the group's own flows still have to see it.
 *
 * THE CHECK ORDER IS THE DESIGN. This runs on every text message in every group,
 * so it walks free → expensive and bails at the first no: regex on text already
 * in memory → the group's config → is it the watched account? → is the sender an
 * admin, LAST. That last one is a network round trip, and hoisting it puts one on
 * every chat message in every group.
 */
async function startFromLink(ctx, text) {
  if (!RAID_ENABLED || !ctx.chat || !ctx.from) return false;
  const m = LINK_RE.exec(String(text || ""));
  if (!m) return false;
  const [, author, postId] = m;

  const g = store.get(ctx.chat.id);
  if (!g) return false;
  const a = auto(g);
  const handle = xTimeline.parseHandle(a.handle);
  // Only the WATCHED account's post. Without this an admin could point a paying
  // group's raid at a stranger's post by pasting any link.
  if (!handle || handle.toLowerCase() !== author.toLowerCase()) return false;

  // A member's paste is ignored SILENTLY. Pasting the project's tweet is normal
  // group behaviour, not something to scold — and an answer would also tell the
  // room exactly which link fires a raid.
  const { isGroupAdmin } = require("./panel");
  if (!(await isGroupAdmin(ctx))) {
    log.debug(`[raid] 🔗 link raid: post link from non-admin in ${ctx.chat.id}`);
    return false;
  }

  // A post no newer than the cursor is a duplicate — which is what makes two
  // admins pasting the same link a no-op instead of two raids.
  if (a.lastSeenTweetId && !xTimeline.newerThan(postId, a.lastSeenTweetId)) return false;

  // NO FRESHNESS GATE HERE. That gate bounds cursor bugs on the watcher's blind
  // path, where nobody chose the post. An admin pasting a link is explicit
  // intent about a specific post, like tapping 🚀 Launch raid.
  log.info(`[raid] 🔗 link raid: starting in ${ctx.chat.id} on post ${postId}`);
  const res = await startOn(ctx.telegram, g, postId, { via: "link" });
  return res.ok || !!res.queued;
}

// ── The loop ─────────────────────────────────────────────────────────────────

function start(bot) {
  const telegram = (bot && bot.telegram) || bot;
  let timer = null;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runOnce(telegram);
    } catch (e) {
      log.warn(`[raid] auto-raid pass failed: ${e && e.message}`);
    } finally {
      busy = false;
    }
  };
  timer = setInterval(tick, POLL_SEC * 1000);
  if (timer.unref) timer.unref();
  log.info(`[raid] auto-raid watcher started — every ${POLL_SEC}s, freshness gate ${MAX_AGE_MIN}min`);
  return { stop: () => timer && clearInterval(timer) };
}

/** Test seam. */
function _reset() {
  noticed.clear();
}

module.exports = {
  start,
  runOnce,
  tickOne,
  startOn,
  startFromLink,
  firePending,
  notifyGroup,
  noteOutcome,
  watched,
  _reset,
  LINK_RE,
  POLL_SEC,
  MAX_AGE_MIN,
  PENDING_TTL_MIN,
  MAX_PENDING_TRIES,
};
