// The raid state machine: start → poll → finish, plus the boot sweep.
//
// finishRaid() IS THE ONLY EXIT DOOR. Completed, expired, stopped and
// boot-recovery all go through it, because it is the function that unlocks the
// chat. A second place that sets `status` without unlocking is exactly how a
// group stays shut after its raid ends.
const {
  RAID_POLL_SEC,
  RAID_MAX_MINUTES,
  RAID_BUMP_MINUTES,
  RAID_MOVE_BUMP_SEC,
} = require("../config/constants");
const store = require("./store");
const xMetrics = require("./xMetrics");
const lock = require("./lock");
const card = require("./card");
const tpl = require("../templates");
const { payloadArgs } = require("../helpers/message");
const { isFatalChatError } = require("../group/fatalChatError");
const log = require("../helpers/logger");

// Hot path: this is consulted on EVERY group message in EVERY group the bot is
// in, so it must be a Set lookup and never a disk read. Rebuilt from the store
// on each tick, so a raid that outlived a restart starts enrolling again
// without anyone pressing anything.
const activeGroups = new Set();
const chatterSinceBump = new Map(); // chatId → messages since the card last moved
const pinnedByUs = new Set(); // `${chatId}:${messageId}` — see handlePinned
const cantDelete = new Set(); // chatIds we've already warned about once
const cantPin = new Set(); // ditto, for the pin right — see pinCard
const starting = new Set(); // chatIds mid-launch — see the note in startRaid

const isRaidActive = (chatId) => activeGroups.has(String(chatId));

function markActive(chatId, active) {
  const k = String(chatId);
  if (active) activeGroups.add(k);
  else {
    activeGroups.delete(k);
    chatterSinceBump.delete(k);
  }
}

function noteChatter(chatId) {
  const k = String(chatId);
  if (!activeGroups.has(k)) return;
  chatterSinceBump.set(k, (chatterSinceBump.get(k) || 0) + 1);
}

/**
 * What the numbers were when the card last moved. Persisted, so a restart
 * mid-raid can't fabricate a bump out of the first poll after boot.
 *
 * Covers only the metrics the card DRAWS, for the same reason signature() does:
 * an untracked metric climbing would otherwise make "the numbers moved" true
 * and delete-and-repost a card whose visible content had not changed — up to a
 * dozen times an hour, each one leaving a pin notice behind.
 */
const countsMark = (raid) => {
  const c = raid.current || {};
  const active = card.activeMetrics(raid).map((m) => `${m.key}:${c[m.key] || 0}`).join("|");
  return `${active}|crew:${(raid.crew || []).length}`;
};

// ── Starting ─────────────────────────────────────────────────────────────────

/**
 * Launch a raid. Returns { ok, error, warning } and NEVER throws — it is called
 * straight from a button tap.
 */
async function startRaid(telegram, g, { startedBy = "", tweetUrl = "" } = {}) {
  const s = g.settings || {};
  if (g.raid && g.raid.status === "running") {
    // Guarded HERE and not only in the panel: a second raid would overwrite the
    // first one's permission snapshot, and the group could then never be
    // restored to how it was before the FIRST lock.
    //
    // `retryable`: the auto-raid watcher re-queues on this rather than burning
    // the post — the group really will be free in a few minutes.
    return { ok: false, error: tpl.t("raid_already_running"), retryable: true };
  }
  // ...and the status check alone is not enough. `g.raid` is not assigned until
  // several awaits later (the X read, then the permission snapshot), and
  // Telegraf handles a batch of updates CONCURRENTLY — so a double-tap on
  // Launch gets two callers through the check above. The second one then
  // snapshots a chat the first has already LOCKED, records "everything muted"
  // as prevPermissions, and the eventual restore hands that back: the group is
  // silenced permanently while every log line says the unlock succeeded.
  //
  // This claim is synchronous, before any await, which is what closes the
  // window. Released in the finally at the end.
  const gid = String(g.chatId);
  if (starting.has(gid)) return { ok: false, error: tpl.t("raid_already_launching") };
  starting.add(gid);
  try {
    return await launch(telegram, g, s, startedBy, tweetUrl);
  } finally {
    starting.delete(gid);
  }
}

async function launch(telegram, g, s, startedBy, tweetUrl) {
  // An EXPLICIT post wins over the panel's saved target, and never writes back
  // to it. Auto-raid, a pasted link and "raid the latest post" each raid THEIR
  // post; `settings.postUrl` stays whatever the admin chose, because a field the
  // bot writes on an admin's behalf is one they cannot explain or remove.
  const postId = xMetrics.parseTweetId(tweetUrl || s.postUrl);
  if (!postId) return { ok: false, error: tpl.t("raid_bad_post") };

  const wantsX = (s.likes || 0) > 0 || (s.replies || 0) > 0 || (s.reposts || 0) > 0;
  const crewTarget = (s.crew || 0) > 0 ? s.crew : 0;
  if (!wantsX && !crewTarget) return { ok: false, error: tpl.t("raid_no_goals") };

  let baseline = { likes: 0, replies: 0, reposts: 0 };
  let target = { likes: 0, replies: 0, reposts: 0 };
  let postText = "";
  let crewOnly = !wantsX; // a crew-only raid never calls X at all
  let xUnavailable = false;
  let pendingX = { likes: 0, replies: 0, reposts: 0 };
  let warning = "";

  if (wantsX) {
    // force: the baseline defines what "+15 likes" MEANS for the whole raid, so
    // it must never come from a cached reading.
    const m = await xMetrics.fetchTweetMetrics(postId, { force: true });
    if (m.ok) {
      // null, not 0: the answering source cannot SEE reposts.
      const seesReposts = m.retweets != null;
      baseline = { likes: m.likes, replies: m.replies, reposts: seesReposts ? m.retweets : 0 };
      target = {
        likes: s.likes > 0 ? baseline.likes + s.likes : baseline.likes,
        replies: s.replies > 0 ? baseline.replies + s.replies : baseline.replies,
        reposts: s.reposts > 0 && seesReposts ? baseline.reposts + s.reposts : baseline.reposts,
      };
      postText = m.text || "";
      if (s.reposts > 0 && !seesReposts) {
        // Do NOT bury this goal. The source that answered cannot see reposts,
        // but a stronger one may answer the very next poll — the paid key is
        // often just behind a 120s cooldown that another group armed. Parking
        // the delta in pendingX (and flagging the raid degraded) is what lets
        // tryRearmX pick it up; without it the goal is dead for the whole hour
        // and the admin is told they need a paid key they may already have.
        pendingX = { ...pendingX, reposts: s.reposts };
        xUnavailable = true;
        warning =
          "⚠️ Reposts can't be counted by the source that answered, so that goal is on hold. " +
          "It joins in automatically if a source that can see reposts answers during the raid.";
        log.warn(`[raid] ${g.chatId} parked the repost goal — the answering source can't see reposts`);
      }
      const measurable =
        target.likes > baseline.likes || target.replies > baseline.replies || target.reposts > baseline.reposts;
      if (!measurable && !crewTarget) {
        return {
          ok: false,
          error: tpl.t("raid_reposts_only"),
        };
      }
      if (!measurable) crewOnly = true;
    } else if (crewTarget > 0) {
      // DEGRADE rather than refuse — the crew goal never needed X.
      crewOnly = true;
      xUnavailable = true;
      // Stored as raw DELTAS, not absolute targets: a baseline resolved at
      // minute 10 must mean "fifteen more than minute 10 had", or the group is
      // handed the likes that arrived while we were blind.
      pendingX = { likes: s.likes || 0, replies: s.replies || 0, reposts: s.reposts || 0 };
      warning =
        `⚠️ Launched, but the X counts aren't available yet — ${m.error}.` +
        (m.advice ? `\n${m.advice}` : "") +
        "\n\nThe 🤝 Crew goal is running normally, and the X goals will join in automatically if X starts answering.";
      log.warn(`[raid] ${g.chatId} starting in CREW-ONLY mode: ${m.error}`);
    } else {
      return {
        ok: false,
        error:
          `Can't read that post's numbers — ${m.error}.` +
          (m.advice ? `\n\n${m.advice}` : "") +
          "\n\nYou can still run this raid: set a 🤝 Crew goal and launch without the X counts.",
      };
    }
  }

  const now = Date.now();
  const raid = {
    status: "running",
    seq: (g.stats.started || 0) + 1,
    postId,
    postUrl: xMetrics.tweetUrl(postId),
    postText,
    messageId: 0,
    startedBy: String(startedBy || ""),
    crew: [],
    crewTarget,
    crewOnly,
    xUnavailable,
    pendingX,
    baseline,
    target,
    current: { ...baseline },
    startedAt: now,
    lastPolledAt: now,
    // The DURABLE deadline. The in-memory poll timer dies with the process; a
    // locked group must not.
    expiresAt: now + RAID_MAX_MINUTES * 60000,
    finishedAt: null,
    lastError: "",
    lastBumpAt: now,
    lastBumpMark: "",
    locked: false,
    prevPermissions: null,
  };
  raid.lastBumpMark = countsMark(raid);

  // RECORD BEFORE ACT. The snapshot is taken and written BEFORE the chat is
  // touched, so a crash in between can only leave a record claiming a lock that
  // was never applied — whose eventual "restore" is a no-op. The other ordering
  // leaves a locked group with no record, which no sweep can ever find.
  if (s.lockChat) {
    raid.prevPermissions = await lock.snapshot(telegram, g.chatId);
    raid.locked = true;
  }
  g.raid = raid;
  g.stats.started = (g.stats.started || 0) + 1;
  const recorded = await store.save();
  if (raid.locked && !recorded) {
    // The record did NOT reach disk (full or read-only DATA_DIR). Locking now
    // would silence the group with nothing on disk for any sweep to find — the
    // exact state RECORD BEFORE ACT exists to prevent — so run without the lock
    // instead. The raid is the product; the lock is a mode.
    g.raid.locked = false;
    g.raid.prevPermissions = null;
    log.error(`[raid] running ${g.chatId} WITHOUT the chat lock — the raid record could not be persisted`);
  }

  if (g.raid.locked) {
    const res = await lock.applyLock(telegram, g.chatId);
    if (!res.ok) {
      // The raid is the product; the lock is a mode. Run without it — and clear
      // the flag so the finish path doesn't "restore" a lock that never was.
      g.raid.locked = false;
      g.raid.prevPermissions = null;
      await store.save();
      log.warn(`[raid] running ${g.chatId} WITHOUT the chat lock: ${res.error}`);
    }
  }

  const rendered = card.renderCard(g.raid, { now, status: "running" });
  try {
    const sent = await telegram.sendMessage(g.chatId, rendered.text, rendered.extra);
    g.raid.messageId = (sent && sent.message_id) || 0;
    await pinCard(telegram, g.chatId, g.raid.messageId);
    await store.save();
  } catch (e) {
    // A locked group with no card is a silenced chat with no visible reason.
    log.error(`[raid] couldn't post the card in ${g.chatId}: ${e && e.message}`);
    let unlocked = true;
    if (g.raid.locked) {
      const res = await lock.unlock(telegram, g.chatId, g.raid.prevPermissions);
      unlocked = res.ok;
    }
    if (unlocked) {
      g.raid = { status: "idle" };
    } else {
      // Do NOT wipe the record: that is the "locked group with no record, which
      // no sweep can ever find" state this function's own ordering exists to
      // avoid. Keep it, cancelled but still flagged locked, so stillLocked()
      // finds it and the boot sweep retries the unlock.
      g.raid.status = "cancelled";
      g.raid.finishedAt = Date.now();
      reportStranded(g.chatId, "the card could not be posted and the rollback unlock failed");
    }
    await store.save();
    // A 429 or a Telegram blip should be tried again on the next tick; a group
    // that removed the bot should not. Judged HERE, at the source of truth,
    // rather than by string-matching the message at the caller — and delegated
    // to fatalChatError, which is the single owner of that list.
    return { ok: false, error: `Couldn't post the raid card — ${e && e.message}`, retryable: !isFatalChatError(e) };
  }

  markActive(g.chatId, true);
  log.info(
    `[raid] started group=${g.chatId} post=${postId} targets=${JSON.stringify(target)} crew=${crewTarget} locked=${g.raid.locked}`,
  );
  return { ok: true, error: null, warning };
}

// ── Card upkeep ──────────────────────────────────────────────────────────────

async function pinCard(telegram, chatId, messageId) {
  if (!messageId) return false;
  try {
    await telegram.pinChatMessage(chatId, messageId, { disable_notification: true });
    pinnedByUs.add(`${chatId}:${messageId}`);
    cantPin.delete(String(chatId));
    return true;
  } catch (e) {
    // Pinning is still a nicety — it must never fail a raid. But a SILENT nicety
    // is indistinguishable from one that was never built: the card is meant to
    // sit at the top of the chat for the whole raid, and when it doesn't, there
    // was nothing anywhere saying the bot simply lacks the right. Warned once
    // per chat per outage, not once per bump, because a bump happens every poll.
    if (!cantPin.has(String(chatId))) {
      cantPin.add(String(chatId));
      log.warn(
        `[raid] can't pin the card in ${chatId} (${e && e.message}) — ` +
          'give the bot "Pin messages" so the live card stays at the top of the chat',
      );
    }
    return false;
  }
}

/**
 * Take OUR pin off one specific message. Never throws.
 *
 * The id is passed EXPLICITLY. `unpinChatMessage` with no message id removes the
 * chat's most recent pin, which in a group where an admin has pinned their own
 * announcement is somebody else's message — a raid must never touch that.
 */
async function unpinCard(telegram, chatId, messageId) {
  if (!messageId) return;
  pinnedByUs.delete(`${chatId}:${messageId}`);
  try {
    await telegram.unpinChatMessage(chatId, messageId);
  } catch {
    /* usually because the message is already gone, taking its pin with it */
  }
}

/**
 * Telegram posts a "X pinned a message" service message on every pin, and
 * because a bump deletes the previous card each notice decays into "pinned
 * Deleted message". An hour-long raid can leave 30 of them.
 *
 * Deletes ONLY ids we pinned ourselves — an admin's own pinned announcement is
 * never touched.
 */
async function handlePinned(ctx) {
  const svc = ctx.message && ctx.message.pinned_message;
  if (!svc || !ctx.chat) return false;
  if (!pinnedByUs.has(`${ctx.chat.id}:${svc.message_id}`)) return false;
  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
    return true;
  } catch (e) {
    if (!cantDelete.has(String(ctx.chat.id))) {
      cantDelete.add(String(ctx.chat.id));
      log.warn(
        `[raid] can't tidy the pin notice in ${ctx.chat.id} (${e && e.message}) — ` +
          'give the bot "Delete messages" to keep the chat clean',
      );
    }
    return false;
  }
}

/** Edit the card in place. Swallows "not modified", which is not an error. */
async function editCard(telegram, g, status) {
  if (!g.raid.messageId) return;
  const rendered = card.renderCard(g.raid, { status });
  try {
    await telegram.editMessageText(g.chatId, g.raid.messageId, undefined, rendered.text, rendered.extra);
  } catch (e) {
    if (!/not modified/i.test((e && e.message) || "")) {
      log.debug(`[raid] edit failed in ${g.chatId}: ${e && e.message}`);
    }
  }
}

/**
 * Delete the card and re-send it at the bottom of the chat.
 *
 * THE ORDER IS THE DESIGN, and each step is one failure that has already been
 * paid for somewhere:
 *
 *   1. SEND the new card. The reverse leaves the group with no card at all if
 *      the send fails — losing the raid's only surface to save one message.
 *   2. PIN it, before releasing the old one. Unpinning first opens a window with
 *      no pinned card, and leaves the group with none at all if the pin then
 *      fails. Two pins for a moment is the cheaper mistake.
 *   3. UNPIN the old one EXPLICITLY, rather than trusting the delete to take the
 *      pin with it. Telegram refuses to delete a message older than 48h, and a
 *      bot without "Delete messages" cannot delete at all — in both cases the
 *      old card stays, and without this it stays PINNED beside the new one. Over
 *      an hour-long raid that is one stranded pin per bump.
 *   4. DELETE it.
 */
async function bumpCard(telegram, g) {
  const rendered = card.renderCard(g.raid, { status: "running" });
  let sent;
  try {
    sent = await telegram.sendMessage(g.chatId, rendered.text, rendered.extra);
  } catch (e) {
    log.debug(`[raid] bump send failed in ${g.chatId}: ${e && e.message}`);
    return false;
  }
  const old = g.raid.messageId;
  g.raid.messageId = (sent && sent.message_id) || old;
  g.raid.lastBumpAt = Date.now();
  g.raid.lastBumpMark = countsMark(g.raid);
  chatterSinceBump.set(String(g.chatId), 0);
  await store.save();
  await pinCard(telegram, g.chatId, g.raid.messageId);
  if (old && old !== g.raid.messageId) {
    await unpinCard(telegram, g.chatId, old);
    await telegram.deleteMessage(g.chatId, old).catch(() => {});
  }
  log.debug(`[raid] bumped card in ${g.chatId}`);
  return true;
}

// ── Finishing ────────────────────────────────────────────────────────────────

/**
 * A group we believe is still muted by us. This is the ONE failure in the
 * feature that a customer feels and nobody else notices — the chat just goes
 * quiet — so it goes to the ops channel, not only to pm2.
 */
function reportStranded(chatId, why) {
  log.alert(
    `🔇 <b>Raid: a group may still be locked</b>\n\n` +
      `Chat <code>${chatId}</code> — ${why}.\n\n` +
      `<i>The boot sweep retries automatically. If it stays muted, restore the group's permissions by hand ` +
      `(Telegram → group → Permissions) and check the bot is still an admin there.</i>`,
  );
}

/** The ONLY exit door. status ∈ completed | expired | cancelled. */
async function finishRaid(telegram, g, status) {
  const raid = g.raid;
  if (!raid || raid.status !== "running") return; // idempotent: double-calls are no-ops

  // UNLOCK FIRST, before any status write. A crash in between leaves
  // status:"running" with locked:false — the next sweep re-finishes, and the
  // unlock is idempotent. The other order can strand a locked group.
  if (raid.locked) {
    const res = await lock.unlock(telegram, g.chatId, raid.prevPermissions);
    if (res.ok) {
      raid.locked = false;
      raid.prevPermissions = null;
    } else {
      // `locked` and the snapshot deliberately survive. The status write below
      // moves this record out of running(), so the sweep finds it through
      // stillLocked() instead — which is the whole reason that selector exists.
      reportStranded(g.chatId, `the unlock failed (${res.error})`);
    }
  }

  markActive(g.chatId, false);
  raid.status = status;
  raid.finishedAt = Date.now();
  if (status === "completed") {
    g.stats.completed = (g.stats.completed || 0) + 1;
    g.stats.lastCompletedAt = Date.now();
  } else if (status === "expired") {
    g.stats.expired = (g.stats.expired || 0) + 1;
  }
  await store.save();

  // A finished raid KEEPS its numbers on screen — the card is the record.
  await editCard(telegram, g, status);

  if (status === "completed") {
    try {
      const payload = tpl.render("raid_complete_note", {
        crew: String((raid.crew || []).length),
        url: raid.postUrl || "",
      });
      const { text, extra } = payloadArgs(payload, false);
      await telegram.sendMessage(g.chatId, text, {
        ...extra,
        ...(raid.messageId ? { reply_to_message_id: raid.messageId } : {}),
      });
    } catch (e) {
      log.debug(`[raid] completion note failed in ${g.chatId}: ${e && e.message}`);
    }
  }
  // Through the same helper as a bump, so the finished card's pin is released
  // and its bookkeeping entry cleared in one place rather than two.
  await unpinCard(telegram, g.chatId, raid.messageId);
  log.info(`[raid] ${status} group=${g.chatId} post=${raid.postId}`);
}

// ── Polling ──────────────────────────────────────────────────────────────────

/**
 * A raid degraded at launch re-arms itself.
 *
 * `xUnavailable` used to be a one-way latch in the design this is modelled on:
 * if X was unreadable at second zero — including because a DIFFERENT group's
 * rate limit armed the process-wide cooldown — the whole raid ran crew-only,
 * and a real like arriving ten minutes later could never appear, with nothing
 * anywhere saying why.
 */
async function tryRearmX(g) {
  const raid = g.raid;
  const p = raid.pendingX || {};
  if (!(p.likes > 0 || p.replies > 0 || p.reposts > 0)) return false;
  const m = await xMetrics.fetchTweetMetrics(raid.postId);
  if (!m.ok) {
    // A dead post clears the pending goals but does NOT end the raid — the crew
    // goal never depended on the post.
    if (m.gone) {
      raid.pendingX = { likes: 0, replies: 0, reposts: 0 };
      await store.save();
    }
    return false;
  }
  // Resolve ONLY the metrics that are still pending. A raid can be partly
  // tracked — likes counting fine while reposts wait for a source that can see
  // them — and re-baselining everything would reset the likes goal to the
  // current count, silently erasing the progress the group has already made.
  const reading = { likes: m.likes, replies: m.replies, reposts: m.retweets };
  const pending = { ...p };
  let armed = 0;
  for (const key of ["likes", "replies", "reposts"]) {
    if (!(pending[key] > 0)) continue;
    // null means this source cannot SEE the metric — leave it pending.
    if (reading[key] == null) continue;
    raid.baseline[key] = reading[key];
    raid.target[key] = reading[key] + pending[key];
    raid.current[key] = reading[key];
    pending[key] = 0;
    armed++;
  }
  if (!armed) return false;

  raid.pendingX = pending;
  raid.postText = m.text || raid.postText;
  // Still degraded while anything is waiting for a stronger source.
  raid.xUnavailable = pending.likes > 0 || pending.replies > 0 || pending.reposts > 0;
  if (card.activeMetrics({ ...raid, crewOnly: false }).length) raid.crewOnly = false;
  await store.save();
  log.info(`[raid] X came back for ${g.chatId} — ${armed} goal(s) re-armed from the current counts`);
  return true;
}

async function tickOne(telegram, g) {
  const raid = g.raid;
  if (!raid || raid.status !== "running") return;

  // The deadline is checked BEFORE the metrics call, so an X outage can never
  // hold a group's chat shut past its expiry.
  if (raid.expiresAt && Date.now() >= raid.expiresAt) {
    return finishRaid(telegram, g, "expired");
  }

  const before = card.signature(raid, "running");

  // Gated on xUnavailable ALONE. It used to also require crewOnly, which meant
  // a PARTLY degraded raid — likes counting, reposts parked — never re-armed at
  // all, because crewOnly is false the moment any one metric is measurable.
  if (raid.xUnavailable) await tryRearmX(g);

  if (!raid.crewOnly && raid.postId) {
    const m = await xMetrics.fetchTweetMetrics(raid.postId);
    if (m.ok) {
      raid.current = {
        likes: m.likes,
        replies: m.replies,
        // A null must never make a live repost count fall to zero mid-raid.
        reposts: m.retweets != null ? m.retweets : (raid.current && raid.current.reposts) || 0,
      };
      if (m.text) raid.postText = m.text;
      raid.lastError = "";
    } else if (m.gone) {
      log.warn(`[raid] post for ${g.chatId} is gone — stopping the raid`);
      return finishRaid(telegram, g, "cancelled");
    } else {
      // Keep the previous numbers and SAY they are stale. A tracker that
      // silently freezes is worse than one that admits it.
      raid.lastError = m.error || "unavailable";
    }
  }
  raid.lastPolledAt = Date.now();

  // The X read above can await for seconds, and an admin can tap 🛑 Stop in
  // that window (or a crew join can complete the raid). finishRaid is
  // idempotent, but everything BELOW here is not: it would write counts, repaint
  // the card as live — countdown, "Count me in" button and all — and then never
  // repaint it again, because a finished raid is no longer in store.running().
  // The chat would already be unlocked, showing a raid that never ends.
  if (g.raid !== raid || raid.status !== "running") return;

  if (card.isComplete(raid)) {
    await store.save();
    return finishRaid(telegram, g, "completed");
  }

  // A raid with no bump mark yet seeds one instead of claiming progress.
  if (!raid.lastBumpMark) raid.lastBumpMark = countsMark(raid);
  await store.save();

  const after = card.signature(raid, "running");
  const sinceBump = Date.now() - (raid.lastBumpAt || 0);
  const bumpDue = sinceBump >= RAID_BUMP_MINUTES * 60000;
  // A MOVE gets its own, much shorter floor. Waiting five minutes to announce a
  // like that already landed is how a live raid reads as a finished one: the
  // in-place edit changes the number and notifies nobody, so from anywhere in
  // the chat except directly on the card, progress and silence look identical.
  // Chatter is only about visibility and keeps the full RAID_BUMP_MINUTES.
  const moveDue = sinceBump >= RAID_MOVE_BUMP_SEC * 1000;
  const chattered = (chatterSinceBump.get(String(g.chatId)) || 0) > 0;
  // TWO independent reasons to re-post, and they are not the same thing:
  //  • the group has been talking, so the card has scrolled away and the raid
  //    is dying of invisibility;
  //  • the numbers moved — an in-place edit updates the count and NOTIFIES
  //    NOBODY, so the group never learns the raid is progressing, which is the
  //    one thing a raid exists to broadcast.
  const movedSinceBump = countsMark(raid) !== raid.lastBumpMark;

  if ((movedSinceBump && moveDue) || (chattered && bumpDue)) {
    // A bump REPLACES this poll's edit rather than adding a second call —
    // unless it fails, in which case the card must still be updated in place.
    // Returning here regardless left the card frozen for the rest of the raid
    // AND retried the failing send on every poll, because lastBumpAt was never
    // moved: a flood-wait was met with more sends, not fewer.
    if (await bumpCard(telegram, g)) return;
    raid.lastBumpAt = Date.now();
    await store.save();
  }
  if (after !== before) await editCard(telegram, g, "running");
}

// ── Boot recovery ────────────────────────────────────────────────────────────

/**
 * Release every raid whose deadline has passed — this, not the in-memory
 * interval, is what frees a group whose process was killed mid-raid. A raid
 * with NO deadline at all is also released, because nothing else ever will.
 */
async function recoverOnBoot(telegram, { forceExpire = false } = {}) {
  let released = 0;
  let resumed = 0;
  for (const g of store.running()) {
    const deadline = g.raid.expiresAt || 0;
    // forceExpire is for the FEATURE-OFF sweep. Resuming a raid there marks it
    // active for a poll loop that will never be armed, so it can never reach
    // its own deadline — the group stays locked until somebody restarts the bot
    // again after the deadline has passed. If raids are off, every raid ends.
    if (forceExpire || !deadline || Date.now() >= deadline) {
      log.info(`[raid] boot recovery: releasing stale raid in ${g.chatId}`);
      await finishRaid(telegram, g, "expired").catch((e) => log.warn(`[raid] boot release failed for ${g.chatId}: ${e && e.message}`));
      released++;
    } else {
      markActive(g.chatId, true);
      resumed++;
      log.info(`[raid] boot recovery: resuming raid in ${g.chatId}, ${Math.round((deadline - Date.now()) / 60000)}min left`);
    }
  }

  // SECOND PASS — groups whose raid has already ENDED but whose unlock failed.
  // finishRaid writes the end status before this sweep ever sees the record, so
  // running() cannot contain them; without this pass, "the next boot sweep
  // retries" was simply untrue and one transient 502 muted a customer's group
  // permanently. Cheap: one API call per still-locked group per boot, and it
  // restores the chat the moment the bot can reach it again.
  let retried = 0;
  for (const g of store.stillLocked()) {
    if (g.raid.status === "running") continue; // handled above
    const res = await lock.unlock(telegram, g.chatId, g.raid.prevPermissions);
    if (res.ok) {
      g.raid.locked = false;
      g.raid.prevPermissions = null;
      retried++;
      log.info(`[raid] boot recovery: unlocked ${g.chatId} on retry`);
    } else {
      reportStranded(g.chatId, `still locked after a retry (${res.error})`);
    }
  }
  if (released || resumed || retried) {
    await store.save();
    log.info(`[raid] boot sweep: ${released} released, ${resumed} resumed, ${retried} unlocked on retry`);
  }
  return { released, resumed, retried };
}

function start(bot) {
  const telegram = (bot && bot.telegram) || bot;
  let timer = null;
  let busy = false;

  const tick = async () => {
    if (busy) return; // a slow tick must not stack a second on top of itself
    busy = true;
    try {
      const live = store.running();
      activeGroups.clear();
      for (const g of live) markActive(g.chatId, true);
      for (const g of live) {
        await tickOne(telegram, g).catch((e) => log.warn(`[raid] tick failed for ${g.chatId}: ${e && e.message}`));
      }
    } catch (e) {
      log.warn(`[raid] tick error: ${e && e.message}`);
    } finally {
      busy = false;
    }
  };

  // The boot sweep runs BEFORE the poll timer is armed — it is the only thing
  // that unlocks a group whose raid died with the process, so it must not wait
  // in line behind a poll.
  recoverOnBoot(telegram)
    .catch((e) => log.warn(`[raid] boot recovery failed: ${e && e.message}`))
    .finally(() => {
      timer = setInterval(tick, RAID_POLL_SEC * 1000);
      log.info(`[raid] runner started — poll ${RAID_POLL_SEC}s, max raid ${RAID_MAX_MINUTES}min, bump ${RAID_BUMP_MINUTES}min`);
    });

  return { stop: () => timer && clearInterval(timer) };
}

module.exports = {
  start,
  startRaid,
  finishRaid,
  tickOne,
  tryRearmX,
  recoverOnBoot,
  editCard,
  bumpCard,
  pinCard,
  unpinCard,
  handlePinned,
  isRaidActive,
  markActive,
  noteChatter,
  countsMark,
  isFatalChatError,
  _activeGroups: activeGroups,
  _chatterSinceBump: chatterSinceBump,
  _pinnedByUs: pinnedByUs,
};
