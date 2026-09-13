// The raid lifecycle. The tests that matter most here are the ones about the
// chat lock: a lock that outlives its raid silences a paying customer's group
// with no error anywhere.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-raid-"));
process.env.RAID_MAX_MINUTES = "60";

const test = require("node:test");
const assert = require("node:assert");
const store = require("../src/raid/store");
const runner = require("../src/raid/runner");
const xMetrics = require("../src/raid/xMetrics");
const lock = require("../src/raid/lock");

const POST = "https://x.com/dexvraio/status/2084979178378498146";
const CHAT = "-1001";

/** A Telegram double that records what it was asked to do. */
function fakeTg(over = {}) {
  const calls = { sent: [], edited: [], pinned: [], unpinned: [], deleted: [], perms: [] };
  return {
    calls,
    sendMessage: async (chatId, text, extra) => {
      calls.sent.push({ chatId, text, extra });
      return { message_id: 100 + calls.sent.length };
    },
    editMessageText: async (chatId, mid, _i, text) => calls.edited.push({ chatId, mid, text }),
    pinChatMessage: async (chatId, mid) => calls.pinned.push({ chatId, mid }),
    unpinChatMessage: async (chatId, mid) => calls.unpinned.push({ chatId, mid }),
    deleteMessage: async (chatId, mid) => calls.deleted.push({ chatId, mid }),
    setChatPermissions: async (chatId, perms, extra) => calls.perms.push({ chatId, perms, extra }),
    getChat: async () => ({ permissions: { can_send_messages: true, can_send_polls: false, can_manage_topics: true } }),
    getMe: async () => ({ id: 7 }),
    getChatMember: async () => ({ status: "administrator", can_restrict_members: true }),
    ...over,
  };
}

const metricsOk = (over = {}) => async () => ({ ok: true, likes: 200, replies: 10, retweets: 5, text: "gm", source: "api", ...over });
const metricsFail = (over = {}) => async () => ({ ok: false, error: "X rate limit reached", advice: "wait", ...over });

let realFetch;
test.beforeEach(() => {
  store._reset();
  runner._activeGroups.clear();
  realFetch = xMetrics.fetchTweetMetrics;
});
test.afterEach(() => {
  xMetrics.fetchTweetMetrics = realFetch;
});

function group(settings = {}) {
  const g = store.getOrCreate(CHAT, "Test Group");
  Object.assign(g.settings, { postUrl: POST, likes: 15, replies: 5, reposts: 0, crew: 10, lockChat: false }, settings);
  return g;
}

// ── Launch ───────────────────────────────────────────────────────────────────

test("targets are baseline + delta — a raid measures the lift, not the total", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group();
  const res = await runner.startRaid(fakeTg(), g);
  assert.strictEqual(res.ok, true, res.error);
  assert.deepStrictEqual(g.raid.baseline, { likes: 200, replies: 10, reposts: 5 });
  assert.deepStrictEqual(g.raid.target, { likes: 215, replies: 15, reposts: 5 });
  assert.deepStrictEqual(g.raid.current, g.raid.baseline);
  assert.strictEqual(g.raid.status, "running");
  assert.ok(g.raid.expiresAt > Date.now(), "a deadline is written at launch, on disk");
});

test("a second raid is refused — it would overwrite the first one's lock snapshot", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group();
  await runner.startRaid(fakeTg(), g);
  const res = await runner.startRaid(fakeTg(), g);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /already running/i);
});

test("a link that isn't an X post, and a raid with no goals, are both refused", async () => {
  // Compared against the templates themselves — these refusals are
  // admin-editable copy now, so matching a phrase would tie the test to wording
  // the operator is invited to change. Which refusal fired is the behaviour.
  const tpl = require("../src/templates");
  const bad = await runner.startRaid(fakeTg(), group({ postUrl: "https://dexvra.io" }));
  assert.strictEqual(bad.error, tpl.t("raid_bad_post"));
  store._reset();
  const none = await runner.startRaid(fakeTg(), group({ likes: 0, replies: 0, reposts: 0, crew: 0 }));
  assert.strictEqual(none.error, tpl.t("raid_no_goals"));
});

test("X unreadable + a crew goal DEGRADES rather than refusing", async () => {
  xMetrics.fetchTweetMetrics = metricsFail();
  const g = group();
  const res = await runner.startRaid(fakeTg(), g);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(g.raid.crewOnly, true);
  assert.strictEqual(g.raid.xUnavailable, true);
  // Stored as raw DELTAS, so a baseline resolved later means "15 more than
  // THEN", not a gift of everything that arrived while we were blind.
  assert.deepStrictEqual(g.raid.pendingX, { likes: 15, replies: 5, reposts: 0 });
  assert.match(res.warning, /Crew goal is running normally/);
});

test("X unreadable with NO crew goal is refused, and the message says how to proceed", async () => {
  xMetrics.fetchTweetMetrics = metricsFail();
  const res = await runner.startRaid(fakeTg(), group({ crew: 0 }));
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /Crew goal/);
});

test("a repost goal the answering source can't see is PARKED, not buried", async () => {
  // null, not 0 — 0 would read as "nobody has reposted yet" and leave the goal
  // sitting at 0/5 for the whole raid. And the goal must stay recoverable: the
  // paid key is often just behind a cooldown another group armed.
  xMetrics.fetchTweetMetrics = metricsOk({ retweets: null });
  const g = group({ reposts: 5 });
  const res = await runner.startRaid(fakeTg(), g);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(g.raid.target.reposts, g.raid.baseline.reposts, "not drawn on the card yet");
  assert.strictEqual(g.raid.pendingX.reposts, 5, "but held for a source that can see it");
  assert.strictEqual(g.raid.xUnavailable, true, "which is what makes tickOne try to re-arm it");
  assert.match(res.warning, /on hold/i);
});

test("a PARTLY degraded raid re-arms without resetting the goals already running", async () => {
  // The re-arm gate used to require crewOnly, so a raid with likes counting and
  // reposts parked never re-armed at all. And re-baselining everything would
  // reset the likes goal to the current count, erasing the group's progress.
  xMetrics.fetchTweetMetrics = metricsOk({ retweets: null });
  const g = group({ likes: 15, replies: 0, reposts: 5, crew: 0 });
  await runner.startRaid(fakeTg(), g);
  assert.strictEqual(g.raid.target.likes, 215);
  assert.strictEqual(g.raid.crewOnly, false);

  // Likes climb, then a source that CAN see reposts answers.
  xMetrics.fetchTweetMetrics = metricsOk({ likes: 208, retweets: 40 });
  await runner.tickOne(fakeTg(), g);
  assert.strictEqual(g.raid.target.likes, 215, "the likes goal is untouched — progress survives");
  assert.strictEqual(g.raid.baseline.reposts, 40);
  assert.strictEqual(g.raid.target.reposts, 45, "the parked goal resolves from TODAY's count");
  assert.strictEqual(g.raid.xUnavailable, false);
  assert.strictEqual(g.raid.pendingX.reposts, 0);
});

test("an untracked metric moving does NOT repaint or re-post the card", async () => {
  // The card draws only metrics with a goal, so hashing all three raw counts
  // bought an edit — and eventually a delete-and-repost — that rendered a
  // byte-identical card, out of the group's rate limit.
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ likes: 15, replies: 0, reposts: 0, crew: 0 });
  const tg = fakeTg();
  await runner.startRaid(tg, g);
  const beforeEdits = tg.calls.edited.length;
  const beforeSends = tg.calls.sent.length;
  g.raid.lastBumpAt = 0; // a bump is due
  // Replies and reposts climb; likes (the only goal) do not.
  xMetrics.fetchTweetMetrics = metricsOk({ replies: 999, retweets: 999 });
  await runner.tickOne(tg, g);
  assert.strictEqual(tg.calls.edited.length, beforeEdits, "no edit");
  assert.strictEqual(tg.calls.sent.length, beforeSends, "and no re-post");
});

test("a failing bump still updates the card, and still respects its rate limit", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ crew: 0 });
  const tg = fakeTg();
  await runner.startRaid(tg, g);
  g.raid.lastBumpAt = 0;
  tg.sendMessage = async () => { throw new Error("429: Too Many Requests: retry after 60"); };
  xMetrics.fetchTweetMetrics = metricsOk({ likes: 205 });
  await runner.tickOne(tg, g);
  assert.ok(tg.calls.edited.length > 0, "the card is edited in place instead of being left frozen");
  assert.ok(g.raid.lastBumpAt > 0, "and the bump clock moved, so a flood-wait isn't met with more sends");
});

test("a raid stopped mid-poll is not repainted as live", async () => {
  // The X read can await for seconds, and an admin can tap Stop in that window.
  // finishRaid is idempotent; the tail of tickOne is not.
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ lockChat: true });
  const tg = fakeTg();
  await runner.startRaid(tg, g);
  const editsAfterStart = tg.calls.edited.length;
  xMetrics.fetchTweetMetrics = async () => {
    await runner.finishRaid(tg, g, "cancelled"); // the admin taps Stop mid-read
    return { ok: true, likes: 201, replies: 11, retweets: 5, text: "gm" };
  };
  await runner.tickOne(tg, g);
  assert.strictEqual(g.raid.status, "cancelled");
  // finishRaid paints the cancelled card; nothing may paint over it afterwards.
  assert.strictEqual(tg.calls.edited.length, editsAfterStart + 1);
});

test("reposts as the ONLY goal, with no way to count them, is refused", async () => {
  xMetrics.fetchTweetMetrics = metricsOk({ retweets: null });
  const res = await runner.startRaid(fakeTg(), group({ likes: 0, replies: 0, reposts: 5, crew: 0 }));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, require("../src/templates").t("raid_reposts_only"));
});

// ── The chat lock ────────────────────────────────────────────────────────────

test("the permission snapshot is taken and RECORDED before the chat is touched", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ lockChat: true });
  const tg = fakeTg();
  await runner.startRaid(tg, g);
  assert.strictEqual(g.raid.locked, true);
  // Verbatim, including keys this codebase never mentions — handing back a
  // hand-written default would rewrite the customer's group rules.
  assert.deepStrictEqual(g.raid.prevPermissions, {
    can_send_messages: true,
    can_send_polls: false,
    can_manage_topics: true,
  });
  assert.strictEqual(tg.calls.perms[0].perms.can_send_messages, false);
  assert.strictEqual(tg.calls.perms[0].perms.can_invite_users, true, "inviting was never ours to take");
});

test("finishing restores EXACTLY what was taken", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ lockChat: true });
  const tg = fakeTg();
  await runner.startRaid(tg, g);
  await runner.finishRaid(tg, g, "cancelled");
  assert.deepStrictEqual(tg.calls.perms.at(-1).perms, {
    can_send_messages: true,
    can_send_polls: false,
    can_manage_topics: true,
  });
  assert.strictEqual(g.raid.locked, false);
  assert.strictEqual(g.raid.status, "cancelled");
});

test("a FAILED unlock leaves locked:true so the next boot sweep retries", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ lockChat: true });
  let calls = 0;
  const tg = fakeTg({
    setChatPermissions: async () => {
      calls++;
      if (calls > 1) throw new Error("Bad Gateway");
    },
  });
  await runner.startRaid(tg, g);
  await runner.finishRaid(tg, g, "expired");
  assert.strictEqual(g.raid.locked, true, "clearing this would mark the group free while it is still silenced");
  assert.ok(g.raid.prevPermissions, "the snapshot survives for the retry");
});

test("a chat we were kicked from KEEPS the lock flag and the snapshot", async () => {
  // The reasoning that works for a failed message send does not transfer:
  // setChatPermissions mutates the group's DEFAULT permissions, and those
  // outlive the bot being kicked. The group is still there and still muted, so
  // treating this as success would clear the flag and discard the only record
  // of what its rules were.
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ lockChat: true });
  let calls = 0;
  const tg = fakeTg({
    setChatPermissions: async () => {
      calls++;
      if (calls > 1) throw new Error("Forbidden: bot was kicked from the supergroup chat");
    },
  });
  await runner.startRaid(tg, g);
  await runner.finishRaid(tg, g, "expired");
  assert.strictEqual(g.raid.locked, true);
  assert.ok(g.raid.prevPermissions, "the snapshot survives, so a re-added bot can still restore the chat");
});

test("the boot sweep RETRIES a raid whose unlock failed, even though it has ended", async () => {
  // finishRaid writes the end status before any sweep sees the record, so
  // running() can never contain it. Without a second pass over stillLocked(),
  // "the next boot sweep retries" was simply untrue, and one transient 502
  // muted a customer's group permanently.
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ lockChat: true });
  let calls = 0;
  const tg = fakeTg({
    setChatPermissions: async (chatId, perms, extra) => {
      calls++;
      if (calls === 2) throw new Error("Bad Gateway"); // the unlock at finish
      tg.calls.perms.push({ chatId, perms, extra });
    },
  });
  await runner.startRaid(tg, g);
  await runner.finishRaid(tg, g, "expired");
  assert.strictEqual(g.raid.locked, true);
  assert.strictEqual(store.running().length, 0, "it is no longer a running raid");
  assert.strictEqual(store.stillLocked().length, 1, "but it IS still locked");

  const res = await runner.recoverOnBoot(tg);
  assert.strictEqual(res.retried, 1);
  assert.strictEqual(g.raid.locked, false);
  assert.strictEqual(tg.calls.perms.at(-1).perms.can_send_messages, true);
});

test("a double-tapped Launch cannot snapshot the chat it just locked", async () => {
  // The status guard alone is not enough: g.raid is not assigned until several
  // awaits later, and Telegraf handles a batch of updates concurrently. The
  // second caller would snapshot the LOCKED chat and the eventual restore would
  // hand back "everything muted" while logging success.
  xMetrics.fetchTweetMetrics = async () => {
    await new Promise((r) => setTimeout(r, 15));
    return { ok: true, likes: 200, replies: 10, retweets: 5, text: "gm", source: "api" };
  };
  const g = group({ lockChat: true });
  const tg = fakeTg();
  const [a, b] = await Promise.all([runner.startRaid(tg, g), runner.startRaid(tg, g)]);
  const okCount = [a, b].filter((r) => r.ok).length;
  assert.strictEqual(okCount, 1, "exactly one launch wins");
  assert.strictEqual(g.raid.prevPermissions.can_send_messages, true, "the snapshot is the UNLOCKED chat");
});

test("a raid record that could not be persisted runs WITHOUT the lock", async () => {
  // Locking with nothing on disk is the "locked group with no record" state
  // that no sweep can find — the exact thing RECORD BEFORE ACT exists to stop.
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ lockChat: true });
  const tg = fakeTg();
  const realSave = store.save;
  store.save = async () => false; // a full or read-only DATA_DIR
  try {
    const res = await runner.startRaid(tg, g);
    assert.strictEqual(res.ok, true, "the raid is the product; the lock is a mode");
    assert.strictEqual(g.raid.locked, false);
    assert.strictEqual(tg.calls.perms.length, 0, "the chat was never touched");
  } finally {
    store.save = realSave;
  }
});

test("a lock that cannot be applied runs the raid WITHOUT it, rather than failing", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ lockChat: true });
  const tg = fakeTg({ setChatPermissions: async () => { throw new Error("not enough rights"); } });
  const res = await runner.startRaid(tg, g);
  assert.strictEqual(res.ok, true, "the raid is the product; the lock is a mode");
  assert.strictEqual(g.raid.locked, false, "so the finish path can't 'restore' a lock that never was");
});

test("a card that cannot be posted rolls the lock back and leaves no raid behind", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ lockChat: true });
  const tg = fakeTg({ sendMessage: async () => { throw new Error("Bad Request: chat not found"); } });
  const res = await runner.startRaid(tg, g);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(g.raid.status, "idle");
  // A locked group with no card is a silenced chat with no visible reason.
  assert.strictEqual(tg.calls.perms.length, 2, "locked, then unlocked again");
  assert.strictEqual(tg.calls.perms.at(-1).perms.can_send_messages, true);
});

test("if that rollback's unlock ALSO fails, the record is kept for the sweep", async () => {
  // Wiping it here would produce the one state this whole ordering exists to
  // avoid: a locked group with no record, which no sweep can ever find.
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ lockChat: true });
  let perms = 0;
  const tg = fakeTg({
    sendMessage: async () => { throw new Error("Forbidden: bot is not a member of the supergroup chat"); },
    setChatPermissions: async () => {
      perms++;
      if (perms > 1) throw new Error("Forbidden: bot is not a member of the supergroup chat");
    },
  });
  const res = await runner.startRaid(tg, g);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(g.raid.status, "cancelled");
  assert.strictEqual(g.raid.locked, true);
  assert.strictEqual(store.stillLocked().length, 1, "the sweep can find it");
});

// ── Polling ──────────────────────────────────────────────────────────────────

test("the deadline is checked BEFORE X, so an outage can't hold a chat shut", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ lockChat: true });
  const tg = fakeTg();
  await runner.startRaid(tg, g);
  let asked = 0;
  xMetrics.fetchTweetMetrics = async () => { asked++; return { ok: false, error: "down" }; };
  g.raid.expiresAt = Date.now() - 1;
  await runner.tickOne(tg, g);
  assert.strictEqual(g.raid.status, "expired");
  assert.strictEqual(asked, 0, "no metrics call stands between a deadline and an unlock");
  assert.strictEqual(tg.calls.perms.at(-1).perms.can_send_messages, true);
});

test("an unreadable poll keeps the last numbers and flags them stale", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group();
  await runner.startRaid(fakeTg(), g);
  g.raid.current = { likes: 205, replies: 12, reposts: 5 };
  xMetrics.fetchTweetMetrics = metricsFail();
  await runner.tickOne(fakeTg(), g);
  assert.deepStrictEqual(g.raid.current, { likes: 205, replies: 12, reposts: 5 });
  assert.ok(g.raid.lastError, "the card will say the counts are stale rather than freezing silently");
});

test("a null repost count never drags a live count down to zero", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ reposts: 3 });
  await runner.startRaid(fakeTg(), g);
  g.raid.current.reposts = 9;
  xMetrics.fetchTweetMetrics = metricsOk({ retweets: null, likes: 201, replies: 11 });
  await runner.tickOne(fakeTg(), g);
  assert.strictEqual(g.raid.current.reposts, 9);
});

test("a deleted post stops the raid and unlocks the chat", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ lockChat: true });
  const tg = fakeTg();
  await runner.startRaid(tg, g);
  xMetrics.fetchTweetMetrics = async () => ({ ok: false, error: "post not found", gone: true });
  await runner.tickOne(tg, g);
  assert.strictEqual(g.raid.status, "cancelled");
  assert.strictEqual(tg.calls.perms.at(-1).perms.can_send_messages, true);
});

test("a raid degraded at launch re-arms itself when X comes back", async () => {
  xMetrics.fetchTweetMetrics = metricsFail();
  const g = group();
  await runner.startRaid(fakeTg(), g);
  assert.strictEqual(g.raid.crewOnly, true);
  // The re-armed baseline is TODAY's reading, so "+15" still means fifteen more
  // from here — not a gift of everything that landed while we were blind.
  xMetrics.fetchTweetMetrics = metricsOk({ likes: 400, replies: 40, retweets: 2 });
  await runner.tickOne(fakeTg(), g);
  assert.strictEqual(g.raid.crewOnly, false);
  assert.strictEqual(g.raid.xUnavailable, false);
  assert.strictEqual(g.raid.baseline.likes, 400);
  assert.strictEqual(g.raid.target.likes, 415);
  assert.deepStrictEqual(g.raid.pendingX, { likes: 0, replies: 0, reposts: 0 });
});

test("hitting every goal completes the raid and posts the shout", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ crew: 0 });
  const tg = fakeTg();
  await runner.startRaid(tg, g);
  xMetrics.fetchTweetMetrics = metricsOk({ likes: 999, replies: 999 });
  await runner.tickOne(tg, g);
  assert.strictEqual(g.raid.status, "completed");
  assert.strictEqual(g.stats.completed, 1);
  assert.ok(tg.calls.sent.length >= 2, "the completion note is a reply to the card");
  assert.match(tg.calls.sent.at(-1).text, /Raid cleared/i);
});

test("finishRaid is idempotent — a boot sweep racing a live tick is a no-op", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ lockChat: true });
  const tg = fakeTg();
  await runner.startRaid(tg, g);
  await runner.finishRaid(tg, g, "expired");
  const perms = tg.calls.perms.length;
  await runner.finishRaid(tg, g, "cancelled");
  assert.strictEqual(g.raid.status, "expired", "the first exit wins");
  assert.strictEqual(tg.calls.perms.length, perms);
});

// ── Boot recovery ────────────────────────────────────────────────────────────

test("reload() picks up a raids file that appeared after this module loaded", async () => {
  // The store reads its file at MODULE LOAD, which happens through
  // handlers/registry when src/bot.js is required — BEFORE startBot() awaits
  // persist.hydrate(). On a fresh container, where the Mongo mirror is the only
  // copy, the store would otherwise come up empty and a raid that was live when
  // the container was replaced would be invisible to the boot sweep, leaving
  // its group locked.
  const fsp = require("node:fs/promises");
  const file = path.join(process.env.BOT_DATA_DIR, "raids.json");
  await fsp.writeFile(
    file,
    JSON.stringify({
      "-5005": {
        chatId: "-5005",
        settings: {},
        stats: { started: 1 },
        raid: { status: "running", locked: true, expiresAt: Date.now() - 1000, crew: [] },
      },
    }),
  );
  store._reset();
  assert.strictEqual(store.running().length, 0, "empty before the reload, as on a fresh container");
  const n = store.reload();
  assert.strictEqual(n, 1);
  assert.strictEqual(store.running().length, 1);

  // And the sweep can now actually free that group.
  const tg = fakeTg();
  const res = await runner.recoverOnBoot(tg);
  assert.strictEqual(res.released, 1);
  assert.strictEqual(tg.calls.perms.at(-1).perms.can_send_messages, true);
  store._reset();
  await fsp.rm(file, { force: true });
});

test("the boot sweep releases a raid whose process died, and resumes a live one", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const stale = group({ lockChat: true });
  const tg = fakeTg();
  await runner.startRaid(tg, stale);
  stale.raid.expiresAt = Date.now() - 1000; // the timer died with the process
  runner._activeGroups.clear();

  const res = await runner.recoverOnBoot(tg);
  assert.strictEqual(res.released, 1);
  assert.strictEqual(stale.raid.status, "expired");
  assert.strictEqual(tg.calls.perms.at(-1).perms.can_send_messages, true, "THIS is what frees a stranded group");
});

test("a raid with NO deadline is released too — nothing else ever would", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group();
  await runner.startRaid(fakeTg(), g);
  delete g.raid.expiresAt;
  const tg = fakeTg();
  const res = await runner.recoverOnBoot(tg);
  assert.strictEqual(res.released, 1);
  assert.strictEqual(g.raid.status, "expired");
});

test("with the feature OFF, even a live raid is ended so its group is freed", async () => {
  // Resuming it there marks it active for a poll loop that will never be armed,
  // so it can never reach its own deadline: the group stays locked until
  // somebody restarts the bot again after the deadline has passed.
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ lockChat: true });
  const tg = fakeTg();
  await runner.startRaid(tg, g);
  assert.ok(g.raid.expiresAt > Date.now(), "still well inside its deadline");
  const res = await runner.recoverOnBoot(tg, { forceExpire: true });
  assert.strictEqual(res.released, 1);
  assert.strictEqual(res.resumed, 0);
  assert.strictEqual(tg.calls.perms.at(-1).perms.can_send_messages, true);
});

test("a still-live raid is resumed, and starts enrolling again", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group();
  await runner.startRaid(fakeTg(), g);
  runner._activeGroups.clear();
  const res = await runner.recoverOnBoot(fakeTg());
  assert.strictEqual(res.resumed, 1);
  assert.strictEqual(g.raid.status, "running");
  assert.strictEqual(runner.isRaidActive(CHAT), true);
});

// ── Bumping ──────────────────────────────────────────────────────────────────

test("the new card is sent BEFORE the old one is deleted", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group();
  const tg = fakeTg();
  await runner.startRaid(tg, g);
  const first = g.raid.messageId;
  await runner.bumpCard(tg, g);
  assert.notStrictEqual(g.raid.messageId, first);
  // The reverse ordering leaves the group with no card at all if the send fails.
  assert.deepStrictEqual(tg.calls.deleted.at(-1), { chatId: CHAT, mid: first });
  assert.strictEqual(g.raid.lastBumpMark, runner.countsMark(g.raid));
});

test("a bump pins the NEW card and releases the old one's pin", async () => {
  // What a group sees: the live card sits at the top of the chat, and there is
  // exactly ONE of them there. Every step below is a pin that would otherwise
  // strand.
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group();
  const tg = fakeTg();
  await runner.startRaid(tg, g);
  const first = g.raid.messageId;
  await runner.bumpCard(tg, g);
  const next = g.raid.messageId;

  assert.deepStrictEqual(tg.calls.pinned.at(-1), { chatId: CHAT, mid: next }, "the new card is pinned");
  assert.deepStrictEqual(tg.calls.unpinned.at(-1), { chatId: CHAT, mid: first }, "and the old pin is released");
  assert.deepStrictEqual(tg.calls.deleted.at(-1), { chatId: CHAT, mid: first }, "and the old card deleted");
});

test("the new card is PINNED before the old pin is released", async () => {
  // Unpinning first opens a window with no pinned card at all — and leaves the
  // group with none if the pin then fails. Two pins for a moment is the cheaper
  // mistake, so the order is load-bearing rather than incidental.
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group();
  const order = [];
  const tg = fakeTg({
    pinChatMessage: async (_c, mid) => order.push(`pin:${mid}`),
    unpinChatMessage: async (_c, mid) => order.push(`unpin:${mid}`),
  });
  await runner.startRaid(tg, g);
  const first = g.raid.messageId;
  order.length = 0;
  await runner.bumpCard(tg, g);
  assert.deepStrictEqual(order, [`pin:${g.raid.messageId}`, `unpin:${first}`]);
});

test("the old pin is released even when the old card CANNOT be deleted", async () => {
  // Telegram refuses to delete a message older than 48h, and a bot without
  // "Delete messages" cannot delete at all. Relying on the delete to carry the
  // pin away leaves the old card pinned beside the new one — one stranded pin
  // per bump, for the length of the raid.
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group();
  const tg = fakeTg({
    deleteMessage: async () => {
      throw new Error("Bad Request: message can't be deleted");
    },
  });
  await runner.startRaid(tg, g);
  const first = g.raid.messageId;
  assert.strictEqual(await runner.bumpCard(tg, g), true, "a stuck delete must not fail the bump");
  assert.deepStrictEqual(tg.calls.unpinned.at(-1), { chatId: CHAT, mid: first });
  assert.deepStrictEqual(tg.calls.pinned.at(-1), { chatId: CHAT, mid: g.raid.messageId });
});

test("an unpin always names its message — never the chat's latest pin", async () => {
  // `unpinChatMessage` with no message id removes the chat's MOST RECENT pin,
  // which in a group where an admin pinned their own announcement is somebody
  // else's message. A raid may never touch that.
  const tg = fakeTg();
  await runner.unpinCard(tg, CHAT, 4242);
  assert.deepStrictEqual(tg.calls.unpinned, [{ chatId: CHAT, mid: 4242 }]);
  await runner.unpinCard(tg, CHAT, 0);
  assert.strictEqual(tg.calls.unpinned.length, 1, "nothing to unpin, nothing called");
});

test("a group that will not let the bot pin still gets its raid", async () => {
  // Pinning is a nicety and must never fail a raid — but a silent nicety is
  // indistinguishable from one that was never built, so the refusal is logged
  // once per chat rather than swallowed.
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group();
  const tg = fakeTg({
    pinChatMessage: async () => {
      throw new Error("Bad Request: not enough rights to pin a message");
    },
  });
  const res = await runner.startRaid(tg, g);
  assert.strictEqual(res.ok, true, "the raid launched anyway");
  assert.strictEqual(await runner.bumpCard(tg, g), true, "and it keeps bumping");
});

test("a failed bump keeps the existing card rather than losing it", async () => {
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group();
  const tg = fakeTg();
  await runner.startRaid(tg, g);
  const first = g.raid.messageId;
  tg.sendMessage = async () => { throw new Error("Bad Gateway"); };
  assert.strictEqual(await runner.bumpCard(tg, g), false);
  assert.strictEqual(g.raid.messageId, first);
});

test("only cards WE pinned get their service notice tidied", async () => {
  const ctx = {
    chat: { id: CHAT },
    message: { message_id: 555, pinned_message: { message_id: 999 } },
    telegram: { deleteMessage: async () => {} },
  };
  // An admin's own pinned announcement must never be touched.
  assert.strictEqual(await runner.handlePinned(ctx), false);
  runner._pinnedByUs.add(`${CHAT}:999`);
  assert.strictEqual(await runner.handlePinned(ctx), true);
});

test("a granular restore is applied INDEPENDENTLY, so it cannot widen", async () => {
  // Without the flag, can_send_other_messages implies can_send_messages and all
  // six media permissions — so restoring a text-only group's snapshot would
  // turn photos back on. The snapshot exists to give back exactly what we took.
  const tg = fakeTg({
    getChat: async () => ({
      permissions: { can_send_messages: true, can_send_photos: false, can_send_other_messages: true },
    }),
  });
  const snap = await lock.snapshot(tg, CHAT);
  await lock.unlock(tg, CHAT, snap);
  const [, perms, extra] = [null, tg.calls.perms.at(-1).perms, tg.calls.perms.at(-1).extra];
  assert.strictEqual(perms.can_send_photos, false);
  assert.strictEqual(extra.use_independent_chat_permissions, true);
});

test("a snapshot with no granular keys restores under LEGACY semantics", async () => {
  // Absent keys would otherwise read as false and leave the group partly muted,
  // which is the worse direction to fail in.
  assert.deepStrictEqual(lock.independentOpts({ can_send_messages: true }), {});
  assert.deepStrictEqual(lock.independentOpts(null), {});
});

test("canLock refuses a basic group, where the toggle would be a silent no-op", async () => {
  const res = await lock.canLock(fakeTg(), CHAT, "group");
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /supergroup/i);
  assert.strictEqual((await lock.canLock(fakeTg(), CHAT, "supergroup")).ok, true);
});

test("canLock names the missing permission instead of just failing", async () => {
  const tg = fakeTg({ getChatMember: async () => ({ status: "administrator", can_restrict_members: false }) });
  const res = await lock.canLock(tg, CHAT, "supergroup");
  assert.match(res.reason, /Ban users/);
});

test("a MOVED count re-posts on the very next poll — that is what 'realtime' means here", async () => {
  // The two reasons to re-post are not the same event and do not share a
  // cooldown. A like that already landed is the raid's news, and an in-place
  // edit notifies NOBODY — so from anywhere in the chat except directly on the
  // card, progress and silence look identical. Chatter is only about
  // visibility and keeps its full wait.
  //
  // DRIVEN, not grepped. The previous version asserted that the source still
  // contained the gate and that the constant sat between 20 and 120 seconds —
  // both of which stayed true while the floor was still long enough to hide a
  // like for a full minute. A source pattern cannot tell you when the group
  // actually hears about it; only running the tick can.
  const c = require("../src/config/constants");
  assert.strictEqual(c.RAID_MOVE_BUMP_SEC, 0, "a move waits for nothing but the poll itself");
  assert.ok(c.RAID_BUMP_MINUTES * 60 > c.RAID_MOVE_BUMP_SEC, "chatter waits strictly longer than a move");

  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ likes: 15, replies: 0, reposts: 0, crew: 0 });
  const tg = fakeTg();
  await runner.startRaid(tg, g);
  const sentAfterStart = tg.calls.sent.length;
  // One like lands a second into the raid — exactly the case the old floor hid.
  xMetrics.fetchTweetMetrics = metricsOk({ likes: 201 });
  await runner.tickOne(tg, g);
  assert.strictEqual(tg.calls.sent.length, sentAfterStart + 1, "the group is told, with a fresh card that notifies");
});

test("a poll with NO movement posts nothing — which is why a zero floor is safe", async () => {
  // The flood bound is the poll cadence itself: a bump can only happen inside a
  // tick, and a tick that saw nothing move sends nothing. Without this, cutting
  // the floor to zero would be a card per RAID_POLL_SEC forever.
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group({ likes: 15, replies: 0, reposts: 0, crew: 0 });
  const tg = fakeTg();
  await runner.startRaid(tg, g);
  const sentAfterStart = tg.calls.sent.length;
  await runner.tickOne(tg, g);
  await runner.tickOne(tg, g);
  assert.strictEqual(tg.calls.sent.length, sentAfterStart, "two quiet polls, no cards");
});

test("the two re-post reasons are still gated separately", () => {
  // Kept as a source check on purpose: it pins the SHAPE of the gate, which the
  // behavioural tests above cannot distinguish from a single shared cooldown
  // that happens to be short.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "raid", "runner.js"), "utf8");
  assert.match(src, /\(movedSinceBump && moveDue\) \|\| \(chattered && bumpDue\)/, "the two reasons are gated separately");
  assert.match(src, /moveDue = sinceBump >= RAID_MOVE_BUMP_SEC \* 1000/, "moves use their own floor");
});

test("a bump that cannot SEND touches neither the old card nor its pin", async () => {
  // The old card is the raid's only surface. Deleting or unpinning it before the
  // replacement exists trades a working card for nothing at all — which is why
  // the send comes first and why every later step is conditional on it.
  //
  // This used to be a source check on the ORDER of three calls inside bumpCard.
  // It passed for the wrong reason the moment the order legitimately changed:
  // pinning now happens before the old pin is released, on purpose.
  xMetrics.fetchTweetMetrics = metricsOk();
  const g = group();
  const tg = fakeTg();
  await runner.startRaid(tg, g);
  const first = g.raid.messageId;
  const pinsAfterStart = tg.calls.pinned.length;
  tg.sendMessage = async () => {
    throw new Error("Bad Gateway");
  };
  assert.strictEqual(await runner.bumpCard(tg, g), false);
  assert.strictEqual(g.raid.messageId, first, "the group keeps the card it has");
  assert.strictEqual(tg.calls.deleted.length, 0, "nothing was deleted");
  assert.strictEqual(tg.calls.unpinned.length, 0, "and its pin was left alone");
  assert.strictEqual(tg.calls.pinned.length, pinsAfterStart, "no pin was moved either");
});
