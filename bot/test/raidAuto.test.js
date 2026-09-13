// Auto-raid: the watcher, the cursor, and the pasted link.
//
// Most of these pin a way a raid fires on the WRONG post, or twice, or spends a
// post it never raided — the failures that are invisible from inside a group,
// because a watcher that works and a watcher that doesn't both look like silence.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-auto-"));

const test = require("node:test");
const assert = require("node:assert");
const store = require("../src/raid/store");
const runner = require("../src/raid/runner");
const panel = require("../src/raid/panel");
const autoRaid = require("../src/raid/autoRaid");
const xTimeline = require("../src/raid/xTimeline");

const CHAT = "-1009";
const HANDLE = "dexvraio";

function fakeTg(over = {}) {
  const calls = { sent: [] };
  return {
    calls,
    sendMessage: async (chatId, text) => {
      calls.sent.push({ chatId, text });
      return { message_id: 1 };
    },
    getChatMember: async () => ({ status: "administrator" }),
    ...over,
  };
}

/** A group already watching HANDLE, with a cursor unless told otherwise. */
function watching(over = {}) {
  const g = store.getOrCreate(CHAT, "T");
  Object.assign(g.autoRaid, { handle: HANDLE, on: true, lastSeenTweetId: "2000000000000000100", ...over });
  return g;
}
const posts = (...ids) => ({
  ok: true,
  source: "test",
  raw: ids.length,
  posts: ids.map((id) => ({ id: String(id), text: "gm", createdAt: Date.now() })),
});

let realStart;
test.beforeEach(() => {
  store._reset();
  autoRaid._reset();
  runner._activeGroups.clear();
  realStart = runner.startRaid;
});
test.afterEach(() => {
  runner.startRaid = realStart;
});

// ── Parsing ──────────────────────────────────────────────────────────────────

test("every shape an admin might paste resolves to the same handle", () => {
  for (const s of ["@dexvraio", "dexvraio", "https://x.com/dexvraio", "twitter.com/dexvraio/", "https://x.com/dexvraio/status/123?s=20"]) {
    assert.strictEqual(xTimeline.parseHandle(s), "dexvraio", s);
  }
  // Reserved paths that LOOK like handles. `i` is the one that matters: the
  // author-less x.com/i/status/<id> form is what this bot builds itself, and
  // reading it as an account would watch a user called "i".
  for (const s of ["https://x.com/i/status/123", "x.com/home", "", "not a handle!", "@waytoolongtobeahandle"]) {
    assert.strictEqual(xTimeline.parseHandle(s), null, s);
  }
});

test("snowflake ids are compared as BigInt, never as Number", () => {
  // These two differ in the last digit and are equal as float64. A Number
  // compare would call a NEW post old — and skip a raid for good, silently.
  const a = "1750000000000000001";
  const b = "1750000000000000000";
  assert.strictEqual(Number(a) === Number(b), true, "…which is exactly the trap");
  assert.strictEqual(xTimeline.newerThan(a, b), true);
  assert.strictEqual(xTimeline.newerThan(b, a), false);
  assert.strictEqual(xTimeline.newerThan("junk", b), false, "garbage is never newer");
});

// ── The cursor ───────────────────────────────────────────────────────────────

test("the FIRST look only seeds — it never raids the post it finds", async () => {
  // Otherwise naming an account raids whatever it happens to be sitting on,
  // which could be days old and is nobody's decision.
  const g = watching({ lastSeenTweetId: "" });
  let started = 0;
  runner.startRaid = async () => {
    started++;
    return { ok: true };
  };
  await autoRaid.tickOne(fakeTg(), g, new Map([[HANDLE, posts("2000000000000000900")]]));
  assert.strictEqual(started, 0, "nothing was raided");
  assert.strictEqual(g.autoRaid.lastSeenTweetId, "2000000000000000900", "but the cursor is armed");
});

test("a post no newer than the cursor is not a new post", async () => {
  const g = watching({ lastSeenTweetId: "2000000000000000900" });
  let started = 0;
  runner.startRaid = async () => {
    started++;
    return { ok: true };
  };
  await autoRaid.tickOne(fakeTg(), g, new Map([[HANDLE, posts("2000000000000000900")]]));
  assert.strictEqual(started, 0);
});

test("the cursor advances BEFORE the raid starts", async () => {
  // A crash between "saw the post" and "card posted" must not double-raid on
  // restart: a missed auto-raid is a shrug, a double raid is the group spammed.
  const g = watching();
  let cursorAtStart = null;
  runner.startRaid = async () => {
    cursorAtStart = g.autoRaid.lastSeenTweetId;
    return { ok: true };
  };
  await autoRaid.tickOne(fakeTg(), g, new Map([[HANDLE, posts("2000000000000000901")]]));
  assert.strictEqual(cursorAtStart, "2000000000000000901", "already spent by the time the raid is attempted");
});

test("a post past the freshness gate is spent, never raided", async () => {
  // Bounds every cursor bug to "one raid on a recent post" instead of "raid the
  // archive" in a customer's group.
  const g = watching();
  let started = 0;
  runner.startRaid = async () => {
    started++;
    return { ok: true };
  };
  const old = { ok: true, raw: 1, posts: [{ id: "2000000000000000999", text: "old", createdAt: Date.now() - 60 * 60000 }] };
  await autoRaid.tickOne(fakeTg(), g, new Map([[HANDLE, old]]));
  assert.strictEqual(started, 0);
  assert.strictEqual(g.autoRaid.lastSeenTweetId, "2000000000000000999", "spent, so it cannot come back tomorrow");
  assert.match(g.autoRaid.lastError, /older than/);
});

test("a post found mid-raid is QUEUED, never dropped and never a second raid", async () => {
  // Killing the live raid would strand its lock snapshot — the thing that
  // reopens a muted chat. Dropping the post reads as "the bot didn't detect it".
  const g = watching();
  g.raid = { status: "running" };
  let started = 0;
  runner.startRaid = async () => {
    started++;
    return { ok: true };
  };
  await autoRaid.tickOne(fakeTg(), g, new Map([[HANDLE, posts("2000000000000000901")]]));
  assert.strictEqual(started, 0);
  assert.strictEqual(g.autoRaid.pendingPostId, "2000000000000000901");
  assert.strictEqual(g.autoRaid.lastSeenTweetId, "2000000000000000901", "and it is spent, so the next tick is not a duplicate");
});

test("the queued post fires once the group is free, and is cleared BEFORE it starts", async () => {
  const g = watching({ pendingPostId: "2000000000000000901", pendingAt: Date.now() });
  g.raid = { status: "idle" };
  let pendingAtStart = null;
  runner.startRaid = async () => {
    pendingAtStart = g.autoRaid.pendingPostId;
    return { ok: true };
  };
  assert.strictEqual(await autoRaid.firePending(fakeTg(), g), true);
  assert.strictEqual(pendingAtStart, "", "cleared first — the same no-double rule as the cursor");
});

// ── Saying what happened ─────────────────────────────────────────────────────

test("a tick is stamped whether or not X answered — a read is stamped separately", async () => {
  // lastCheckedAt alone was the green light: it is written on every tick BY
  // DESIGN, so a stale value means the bot stopped rather than X being down.
  // With only that, a bot blind for hours still rendered a healthy tick.
  const g = watching();
  await autoRaid.tickOne(fakeTg(), g, new Map([[HANDLE, { ok: false, error: "X refused" }]]));
  assert.ok(g.autoRaid.lastCheckedAt > 0, "the tick happened");
  assert.strictEqual(g.autoRaid.lastOkAt, 0, "…and X still has not answered once");
  assert.strictEqual(g.autoRaid.lastError, "X refused");
});

test("an unparsable handle records a reason instead of looking dead", async () => {
  // It used to record nothing, so the panel said "waiting for the first check"
  // for a watcher running perfectly with junk to watch.
  const g = watching({ handle: "not a handle!" });
  await autoRaid.tickOne(fakeTg(), g, new Map());
  assert.ok(g.autoRaid.lastCheckedAt > 0);
  assert.match(g.autoRaid.lastError, /doesn't look like an X account/);
});

test("an empty timeline is told apart from an account that only reposts", async () => {
  // Same visible outcome, completely different causes — and only one of them is
  // something an admin can do anything about.
  const g = watching();
  await autoRaid.tickOne(fakeTg(), g, new Map([[HANDLE, { ok: true, raw: 0, posts: [] }]]));
  assert.match(g.autoRaid.lastError, /empty timeline/);
  await autoRaid.tickOne(fakeTg(), g, new Map([[HANDLE, { ok: true, raw: 7, posts: [] }]]));
  assert.match(g.autoRaid.lastError, /only reposts/);
});

test("a started raid is the ONLY thing that clears the last reason", async () => {
  const g = watching({ lastError: "X refused", lastErrorAt: Date.now() });
  runner.startRaid = async () => ({ ok: true });
  await autoRaid.tickOne(fakeTg(), g, new Map([[HANDLE, posts("2000000000000000901")]]));
  assert.strictEqual(g.autoRaid.lastError, "");
});

test("a retryable refusal re-queues; a permanent one tells the group ONCE", async () => {
  const g = watching();
  runner.startRaid = async () => ({ ok: false, error: "Mongo blipped", retryable: true });
  await autoRaid.startOn(fakeTg(), g, "2000000000000000901");
  assert.strictEqual(g.autoRaid.pendingPostId, "2000000000000000901", "a blip does not burn the post");

  const g2 = watching({ lastSeenTweetId: "2000000000000000100", pendingPostId: "" });
  runner.startRaid = async () => ({ ok: false, error: "No goals set", retryable: false });
  const tg = fakeTg();
  await autoRaid.startOn(tg, g2, "2000000000000000902");
  assert.strictEqual(g2.autoRaid.pendingPostId, "", "a permanent refusal is not retried forever");
  assert.strictEqual(tg.calls.sent.length, 1, "the group is told, with the link");
  assert.match(tg.calls.sent[0].text, /2000000000000000902/);
  await autoRaid.startOn(tg, g2, "2000000000000000903");
  assert.strictEqual(tg.calls.sent.length, 1, "…and told once, not once per tick");
});

// ── The pasted link ──────────────────────────────────────────────────────────

const linkCtx = (text, over = {}) => ({
  chat: { id: CHAT, type: "supergroup" },
  from: { id: 5 },
  message: { text },
  telegram: { getChatMember: async () => ({ status: "administrator" }) },
  ...over,
});

test("an admin pasting the watched account's post starts a raid", async () => {
  const g = watching();
  let url = "";
  runner.startRaid = async (_tg, _g, opts) => {
    url = opts.tweetUrl;
    return { ok: true };
  };
  const ok = await autoRaid.startFromLink(linkCtx(`gm https://x.com/${HANDLE}/status/2000000000000000901 go`), `gm https://x.com/${HANDLE}/status/2000000000000000901 go`);
  assert.strictEqual(ok, true);
  assert.match(url, /901/);
});

test("a link to ANY OTHER account is ignored", async () => {
  // Or an admin could point a paying group's raid at a stranger's post.
  watching();
  let started = 0;
  runner.startRaid = async () => {
    started++;
    return { ok: true };
  };
  const t = "https://x.com/someoneelse/status/2000000000000000901";
  assert.strictEqual(await autoRaid.startFromLink(linkCtx(t), t), false);
  assert.strictEqual(started, 0);
});

test("a MEMBER's paste is ignored, and silently", async () => {
  // Pasting the project's tweet is normal group behaviour, not something to
  // scold — and an answer would tell the room exactly which link fires a raid.
  watching();
  let started = 0;
  runner.startRaid = async () => {
    started++;
    return { ok: true };
  };
  const t = `https://x.com/${HANDLE}/status/2000000000000000901`;
  const ctx = linkCtx(t, { telegram: { getChatMember: async () => ({ status: "member" }) } });
  assert.strictEqual(await autoRaid.startFromLink(ctx, t), false);
  assert.strictEqual(started, 0);
});

test("an ordinary message never reaches the admin lookup", async () => {
  // This runs on EVERY text message in every group, so the order is the design:
  // regex on text already in memory first, the network round trip LAST.
  watching();
  let adminChecks = 0;
  const ctx = linkCtx("gm everyone", {
    telegram: {
      getChatMember: async () => {
        adminChecks++;
        return { status: "administrator" };
      },
    },
  });
  await autoRaid.startFromLink(ctx, "gm everyone");
  assert.strictEqual(adminChecks, 0);
});

test("one regex reads BOTH the author and the id, mobile links included", () => {
  // Handing the url to two parsers looks tidier and is wrong: they disagree
  // about `mobile.`, so a mobile link produced an id with no author and the
  // trigger did nothing, silently.
  const m = autoRaid.LINK_RE.exec("https://mobile.twitter.com/dexvraio/status/2000000000000000901");
  assert.ok(m);
  assert.strictEqual(m[1], "dexvraio");
  assert.strictEqual(m[2], "2000000000000000901");
});

test("two admins pasting the same link is one raid, not two", async () => {
  const g = watching();
  let started = 0;
  runner.startRaid = async () => {
    started++;
    return { ok: true };
  };
  const t = `https://x.com/${HANDLE}/status/2000000000000000901`;
  await autoRaid.startFromLink(linkCtx(t), t);
  await autoRaid.startFromLink(linkCtx(t), t);
  assert.strictEqual(started, 1, "the cursor makes the second paste a no-op");
  assert.ok(g.autoRaid.lastSeenTweetId === "2000000000000000901");
});

// ── Removing and switching accounts ──────────────────────────────────────────

test("the clear-words are matched BEFORE the handle is parsed", async () => {
  // `none`, `off`, `clear`, `stop` and `remove` are all VALID X handles, so
  // parsing first starts watching @none — with the account the admin was
  // deleting replaced by a stranger's.
  for (const word of ["-", "none", "off", "stop", "remove", "hapus"]) {
    const g = watching();
    panel.armStep(CHAT, 5, "handle");
    const replies = [];
    await panel.handleWatchText(
      { chat: { id: CHAT, type: "supergroup" }, from: { id: 5 }, reply: async (t) => replies.push(t) },
      word,
    );
    assert.strictEqual(g.autoRaid.handle, "", word);
    assert.strictEqual(g.autoRaid.on, false, word);
  }
});

test("switching accounts forgets everything said about the old one", () => {
  // Every field here is a statement ABOUT one handle. A recorded outcome about
  // @a rendered under @b is the panel confidently explaining a problem the group
  // does not have — and the CURSOR would instantly "detect" half of @b's history
  // as new, because snowflakes are one global sequence.
  const a = {
    handle: "old",
    on: true,
    lastSeenTweetId: "2000000000000000999",
    lastOkAt: 5,
    lastError: "was about @old",
    lastErrorAt: 5,
    pendingPostId: "5",
    lastCheckedAt: 1234,
  };
  panel.clearWatchedAccount(a);
  assert.deepStrictEqual(
    { c: a.lastSeenTweetId, e: a.lastError, p: a.pendingPostId, h: a.handle },
    { c: "", e: "", p: "", h: "" },
  );
  assert.strictEqual(a.lastCheckedAt, 1234, "…but WHEN the bot last ran is a fact about the bot, not the account");
});

// ── The panel's status block ─────────────────────────────────────────────────

const statusOf = (over) => panel.autoRaidStatus({ autoRaid: { handle: HANDLE, on: true, ...over } });

test("a blind bot never prints the promise that the next post will raid", () => {
  // The green-light-over-a-broken-state this feature keeps producing: "can't see
  // X" and "the next post starts a raid" two lines apart. Both cannot be true,
  // and the false one is the reassuring one.
  const line = statusOf({ lastCheckedAt: Date.now(), lastOkAt: Date.now() - 40 * 60000, lastSeenTweetId: "9" });
  assert.match(line, /hasn't been able to see X/);
  assert.doesNotMatch(line, /ready —/);
  assert.match(line, /always works/, "and the route that DOES work is named");
});

test("a stalled bot drops the promise too", () => {
  // The blind fix covered X refusing and missed the loop simply not running.
  const line = statusOf({ lastCheckedAt: Date.now() - 45 * 60000, lastOkAt: Date.now() - 45 * 60000, lastSeenTweetId: "9" });
  assert.match(line, /may have stopped/);
  assert.doesNotMatch(line, /ready —/);
});

test("a healthy watcher says what it will and will not raid", () => {
  const line = statusOf({ lastCheckedAt: Date.now(), lastOkAt: Date.now(), lastSeenTweetId: "9" });
  assert.match(line, /ready/);
  assert.match(line, /only posts made from now on/, "the thing that generated three reports");
});

test("the block never uses this module's own vocabulary", () => {
  // "armed", "watcher", "cursor", "timeline read" are words this file invented.
  // A status line that has to be explained is not reporting status.
  const states = [
    {},
    { on: false },
    { handle: "" },
    { lastCheckedAt: Date.now(), lastOkAt: Date.now(), lastSeenTweetId: "9" },
    { lastCheckedAt: Date.now(), lastOkAt: Date.now() - 40 * 60000, lastSeenTweetId: "9" },
    { lastCheckedAt: Date.now() - 45 * 60000, lastSeenTweetId: "9" },
    { lastCheckedAt: Date.now(), lastOkAt: Date.now(), pendingPostId: "9" },
  ];
  for (const s of states) {
    const line = statusOf(s);
    for (const word of ["armed", "cursor", "timeline read", "watcher"]) {
      assert.ok(!line.toLowerCase().includes(word), `"${word}" leaked into: ${line}`);
    }
    assert.doesNotMatch(line, /<\/?[a-z]/i, "a template VALUE carries no markup");
  }
});

// ── The block is admin-editable, icons included ──────────────────────────────

test("the status lines come from a TEMPLATE, so the emoji screen can see them", () => {
  // The question this answers: "where do I edit 👤 and 🤖?" They were literals
  // in panel.js, so no template contained them, so the emoji-swap screen had
  // nothing to show and no premium emoji could ever reach them.
  const tpl = require("../src/templates");
  const raw = String(tpl.markup("raid_status") || "");
  for (const glyph of ["🤖", "👤", "⏱", "👀", "🚫", "⏸", "🔗"]) {
    assert.ok(raw.includes(glyph), `${glyph} must live in the template, not in code`);
  }
  assert.strictEqual(tpl.meta("raid_status").group, "Dexvra Raid", "…and in the group the emoji screen sweeps");
});

test("an admin can reword ONE line without losing the other fourteen", () => {
  const tpl = require("../src/templates");
  const copy = require("../src/raid/statusCopy");
  const real = tpl.markup;
  try {
    tpl.markup = (k) => (k === "raid_status" ? "ready: 🔥 SIAP — post baru langsung raid" : real(k));
    assert.strictEqual(copy.line("ready"), "🔥 SIAP — post baru langsung raid");
    assert.strictEqual(copy.line("on", { handle: "x" }), copy.DEFAULTS.on.replace("{handle}", "x"), "untouched keys keep their built-in line");
  } finally {
    tpl.markup = real;
  }
});

test("a line hidden with `-` disappears WITHOUT leaving an indent behind", () => {
  const tpl = require("../src/templates");
  const real = tpl.markup;
  try {
    tpl.markup = (k) => (k === "raid_status" ? "off_hint: -" : real(k));
    const block = panel.autoRaidStatus({ autoRaid: { handle: "" } });
    assert.doesNotMatch(block, /\n\s+$/, "no orphaned indent where the line was");
    assert.strictEqual(block.split("\n").length, 1);
  } finally {
    tpl.markup = real;
  }
});

test("pasting the rendered block back in changes nothing", () => {
  // Values legitimately contain a colon, so only KNOWN keys are consumed —
  // otherwise a pasted-back block invents fields out of its own prose.
  const tpl = require("../src/templates");
  const copy = require("../src/raid/statusCopy");
  const real = tpl.markup;
  try {
    tpl.markup = (k) => (k === "raid_status" ? "🤖 Auto-raid: on — watching @x\n⏱ the bot is running, checked just now" : real(k));
    assert.deepStrictEqual(copy.lines(), copy.DEFAULTS);
  } finally {
    tpl.markup = real;
  }
});

test("an unsupplied placeholder renders empty, never a literal {name}", () => {
  // A raw brace on a panel a whole group reads is the tell of a broken template.
  const copy = require("../src/raid/statusCopy");
  assert.doesNotMatch(copy.line("outcome", {}), /[{}]/);
  assert.doesNotMatch(panel.autoRaidStatus({ autoRaid: { handle: "x", on: true } }), /[{}]/);
});
