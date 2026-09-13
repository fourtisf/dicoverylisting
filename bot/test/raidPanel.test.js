// The /raid panel: the admin gate, the scoped URL step, and crew enrolment.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-panel-"));

const test = require("node:test");
const assert = require("node:assert");
const panel = require("../src/raid/panel");
const store = require("../src/raid/store");
const runner = require("../src/raid/runner");

const CHAT = "-1002";
const POST = "https://x.com/dexvraio/status/2084979178378498146";

test.beforeEach(() => {
  store._reset();
  runner._activeGroups.clear();
  // The armed step is module-level state now, so it leaks between cases.
  panel.clearUrlStep(CHAT, 5);
  panel.clearUrlStep(CHAT, 99);
});

function ctxOf(over = {}) {
  const replies = [];
  const answers = [];
  return {
    replies,
    answers,
    chat: { id: CHAT, type: "supergroup", title: "Test" },
    from: { id: 5, username: "admin" },
    session: {},
    message: { text: "" },
    callbackQuery: { data: "" },
    reply: async (t, e) => replies.push({ t, e }),
    answerCbQuery: async (t, e) => answers.push({ t, e }),
    editMessageText: async () => {},
    deleteMessage: async () => {},
    telegram: {
      getChatMember: async () => ({ status: "administrator", can_restrict_members: true }),
      getMe: async () => ({ id: 7 }),
    },
    ...over,
  };
}

// ── Settings ─────────────────────────────────────────────────────────────────

test("a goal cycles through its ladder and wraps", () => {
  assert.strictEqual(panel.nextInCycle(panel.LIKE_STEPS, 5), 10);
  assert.strictEqual(panel.nextInCycle(panel.LIKE_STEPS, 0), 5, "0 (off) wraps back to the first step");
  // A value that isn't in the ladder — an old config, a hand-edited file —
  // yields -1 from indexOf and must wrap cleanly rather than land on undefined.
  assert.strictEqual(panel.nextInCycle(panel.LIKE_STEPS, 999), panel.LIKE_STEPS[0]);
});

test("0 renders as 'off', not as '+0'", () => {
  assert.strictEqual(panel.fmtTarget(0), "off");
  assert.strictEqual(panel.fmtTarget(15), "+15");
});

test("the panel says up front what this install can actually measure", () => {
  // Nobody should set a likes goal and discover at launch that nothing can read
  // it. Asserted as "which sources template got rendered", not against its
  // prose: that copy is admin-editable, so matching a phrase would tie this
  // test to wording the operator is invited to change.
  //
  // All three states, because the warning is only useful if it is ABSENT when
  // things work. It used to fire on a stock install — the keyless sources were
  // opt-in, so a bot with no token really could measure nothing — and that is
  // the state src/raid/sourceFlag.js removed.
  const tpl = require("../src/templates");
  const g = store.getOrCreate(CHAT);
  const render = () => panel.renderPanel(g).text;
  const saved = { free: process.env.RAID_FREE_METRICS, guest: process.env.RAID_GUEST_METRICS };

  try {
    // 1. Stock: no token, both keyless sources on by default → nothing to warn about.
    delete process.env.RAID_FREE_METRICS;
    delete process.env.RAID_GUEST_METRICS;
    let text = render();
    assert.ok(!text.includes(tpl.t("raid_sources_none")), "a stock install can read a post, so no warning");
    assert.ok(!text.includes(tpl.t("raid_sources_partial")), "and reposts are measurable via the guest source");

    // 2. Only the embed source: likes and replies, but reposts are unmeasurable.
    process.env.RAID_GUEST_METRICS = "0";
    process.env.RAID_FREE_METRICS = "1";
    text = render();
    assert.ok(text.includes(tpl.t("raid_sources_partial")), "the reposts-need-a-key line is on the panel");
    assert.ok(!text.includes(tpl.t("raid_sources_none")));

    // 3. An operator who turned both off, with no token — the original state.
    process.env.RAID_FREE_METRICS = "0";
    text = render();
    assert.ok(text.includes(tpl.t("raid_sources_none")), "the no-X-source line is on the panel");
    assert.ok(!text.includes(tpl.t("raid_sources_partial")), "and not the paid-key one");
  } finally {
    // Restored explicitly: these are process-wide and every later case in this
    // file renders the same panel.
    if (saved.free === undefined) delete process.env.RAID_FREE_METRICS;
    else process.env.RAID_FREE_METRICS = saved.free;
    if (saved.guest === undefined) delete process.env.RAID_GUEST_METRICS;
    else process.env.RAID_GUEST_METRICS = saved.guest;
  }
});

test("a live raid replaces the whole keyboard with Stop", () => {
  const g = store.getOrCreate(CHAT);
  g.raid = { status: "running" };
  const labels = panel.renderPanel(g).extra.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels.some((l) => l.includes("Stop raid")));
  assert.ok(!labels.some((l) => l.includes("Launch")), "you cannot launch a second raid over a live one");
});

// ── The admin gate ───────────────────────────────────────────────────────────

test("a non-admin is refused on every button except the crew join", async () => {
  const ctx = ctxOf({
    telegram: { getChatMember: async () => ({ status: "member" }), getMe: async () => ({ id: 7 }) },
    callbackQuery: { data: "dr_likes" },
  });
  await panel.handleCallback(ctx);
  assert.match(ctx.answers[0].t, /Admins only/);
});

test("the crew join skips the admin gate — it is the members' button", async () => {
  const g = store.getOrCreate(CHAT);
  g.raid = { status: "running", crew: [], crewTarget: 10, baseline: {}, target: {}, current: {} };
  const ctx = ctxOf({
    telegram: { getChatMember: async () => ({ status: "member" }), getMe: async () => ({ id: 7 }) },
    callbackQuery: { data: "dr_join" },
    from: { id: 42, username: "member" },
  });
  await panel.handleCallback(ctx);
  assert.match(ctx.answers[0].t, /You're in/);
  assert.strictEqual(g.raid.crew.length, 1);
});

test("tapping join twice counts you once", async () => {
  const g = store.getOrCreate(CHAT);
  g.raid = { status: "running", crew: [], crewTarget: 10, baseline: {}, target: {}, current: {} };
  const ctx = ctxOf({ callbackQuery: { data: "dr_join" }, from: { id: 42, username: "m" } });
  await panel.handleCallback(ctx);
  await panel.handleCallback(ctx);
  assert.strictEqual(g.raid.crew.length, 1);
  assert.match(ctx.answers[1].t, /already counted/i);
});

test("twenty people tapping in the same instant are all counted", () => {
  const g = store.getOrCreate(CHAT);
  g.raid = { status: "running", crew: [], crewTarget: 50 };
  // The check and the push are synchronous, before any await — a
  // read-await-write would drop most of these.
  for (let i = 0; i < 20; i++) store.joinCrew(CHAT, i, `u${i}`);
  assert.strictEqual(g.raid.crew.length, 20);
});

test("joining a finished raid says so instead of failing silently", async () => {
  const g = store.getOrCreate(CHAT);
  g.raid = { status: "expired", crew: [] };
  const ctx = ctxOf({ callbackQuery: { data: "dr_join" } });
  await panel.handleCallback(ctx);
  assert.match(ctx.answers[0].t, /finished/i);
});

// ── The post-URL step ────────────────────────────────────────────────────────

test("the URL step is scoped to the admin, the chat AND a deadline", async () => {
  panel.armUrlStep(CHAT, 5);

  // Right admin, right chat, in time → consumed.
  const ok = ctxOf({ message: { text: POST } });
  assert.strictEqual(await panel.handleText(ok), true);
  assert.strictEqual(store.getOrCreate(CHAT).settings.postUrl, "https://x.com/i/status/2084979178378498146");

  // A DIFFERENT member in the same chat → not consumed. This rides a global
  // text handler; anything looser eats an unrelated member's message.
  panel.armUrlStep(CHAT, 5);
  const someoneElse = ctxOf({ from: { id: 99, username: "member" }, message: { text: POST } });
  assert.strictEqual(await panel.handleText(someoneElse), false);

  // Same admin, DIFFERENT chat → not consumed.
  const elsewhere = ctxOf({ chat: { id: "-999", type: "supergroup" }, message: { text: POST } });
  assert.strictEqual(await panel.handleText(elsewhere), false);

  // Armed too long ago → not consumed.
  panel.armUrlStep(CHAT, 5, Date.now() - panel.STEP_TTL_MS - 1);
  assert.strictEqual(await panel.handleText(ctxOf({ message: { text: POST } })), false);
});

test("an armed step NEVER swallows another command", async () => {
  // This handler is registered before every other command in the bot, so
  // consuming here stops next() and the command simply never runs — for the
  // full ten minutes, on /settoken, /start, /help and /buybot alike.
  panel.armUrlStep(CHAT, 5);
  const ctx = ctxOf({ message: { text: "/buybot off" } });
  assert.strictEqual(await panel.handleText(ctx), false);
  assert.strictEqual(ctx.replies.length, 0, "and it does not answer either");
  assert.strictEqual(panel.urlStepArmed(CHAT, 5), true, "the admin can still paste a link");
});

test("closing the panel ends the wait", async () => {
  panel.armUrlStep(CHAT, 5);
  await panel.handleCallback(ctxOf({ callbackQuery: { data: "dr_close" } }));
  assert.strictEqual(panel.urlStepArmed(CHAT, 5), false);
});

test("the step never touches ctx.session", async () => {
  // Reading session marks the context dirty, and Telegraf's memory store never
  // evicts — so one read here would mint a permanent entry for every member who
  // ever speaks in any group the bot is in.
  const ctx = ctxOf({ session: undefined, message: { text: "gm" } });
  assert.strictEqual(await panel.handleText(ctx), false);
  assert.strictEqual(ctx.session, undefined);
});

test("a message that isn't a post link keeps the step armed and says why", async () => {
  panel.armUrlStep(CHAT, 5);
  const ctx = ctxOf({ message: { text: "https://dexvra.io" } });
  assert.strictEqual(await panel.handleText(ctx), true);
  assert.match(ctx.replies[0].t, /\/status\//);
  assert.strictEqual(panel.urlStepArmed(CHAT, 5), true, "the admin is still in this step");
});

test("an ordinary message is never consumed", async () => {
  const ctx = ctxOf({ message: { text: "gm everyone" } });
  assert.strictEqual(await panel.handleText(ctx), false);
});

// ── Auto-enrolment ───────────────────────────────────────────────────────────

test("talking during a live raid counts you, once", () => {
  const g = store.getOrCreate(CHAT);
  g.raid = { status: "running", crew: [], crewTarget: 10 };
  runner.markActive(CHAT, true);
  const ctx = ctxOf({ message: { text: "lfg" }, from: { id: 77, username: "chatty" } });
  panel.maybeAutoEnroll(ctx);
  panel.maybeAutoEnroll(ctx);
  assert.strictEqual(g.raid.crew.length, 1);
  assert.strictEqual(g.raid.crew[0].name, "@chatty");
});

test("bots and slash commands never pad the roster", () => {
  const g = store.getOrCreate(CHAT);
  g.raid = { status: "running", crew: [], crewTarget: 10 };
  runner.markActive(CHAT, true);
  panel.maybeAutoEnroll(ctxOf({ message: { text: "hi" }, from: { id: 1, is_bot: true } }));
  panel.maybeAutoEnroll(ctxOf({ message: { text: "/raid" }, from: { id: 2, username: "admin" } }));
  assert.strictEqual(g.raid.crew.length, 0);
});

test("a slash command still counts as CHATTER, so the card can be bumped", () => {
  const g = store.getOrCreate(CHAT);
  g.raid = { status: "running", crew: [], crewTarget: 10 };
  runner.markActive(CHAT, true);
  runner._chatterSinceBump.delete(CHAT);
  panel.maybeAutoEnroll(ctxOf({ message: { text: "/raid" }, from: { id: 2, username: "admin" } }));
  assert.strictEqual(runner._chatterSinceBump.get(CHAT), 1);
});

test("with no raid running, enrolment is a Set lookup and nothing else", () => {
  const g = store.getOrCreate(CHAT);
  g.raid = { status: "idle" };
  runner.markActive(CHAT, false);
  panel.maybeAutoEnroll(ctxOf({ message: { text: "hi" }, from: { id: 9 } }));
  assert.ok(!g.raid.crew);
});

test("a display name is clipped by CODE POINT, so an emoji is never split", () => {
  const name = panel.displayName({ first_name: "🚀".repeat(40) });
  assert.strictEqual(Array.from(name).length, 24);
  assert.ok(!name.includes("�"));
  assert.strictEqual(panel.displayName({}), "anon");
  assert.strictEqual(panel.displayName({ username: "abc" }), "@abc");
});

test("the no-X-key line reads as a design, not as a bot somebody forgot to finish", () => {
  // It is read by a project's own members, in their own group. It used to open
  // "No X key on this bot", which reads as an incomplete setup — while the
  // welcome card sells the opposite as the feature: "No X key needed — 🤝 Crew
  // counts whoever shows up". A raid runs on Crew alone by design.
  const tpl = require("../src/templates");
  const line = tpl.t("raid_sources_none");
  assert.doesNotMatch(line, /^⚡?\s*No X key/i, "it does not open by naming a missing key");
  assert.match(line, /no X account needed/i, "it states the design");
  // …and still names the constraint: an admin who sets a Likes target that can
  // never move has been misled by a friendlier silence.
  assert.match(line, /Likes/, "the metrics that cannot move are named");
});
