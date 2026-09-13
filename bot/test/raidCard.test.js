// The raid card is a pure function — these call it directly.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-card-"));

const test = require("node:test");
const assert = require("node:assert");
const card = require("../src/raid/card");
const tpl = require("../src/templates");

const NOW = Date.parse("2026-08-08T12:33:57Z");

const raidOf = (over = {}) => ({
  status: "running",
  seq: 3,
  crewTarget: 10,
  crewOnly: false,
  baseline: { likes: 200, replies: 10, reposts: 0 },
  target: { likes: 215, replies: 15, reposts: 0 },
  current: { likes: 209, replies: 14, reposts: 0 },
  crew: [{ name: "@ana" }, { name: "@bo" }, { name: "cy" }],
  postText: "gm — like + reply 🚀",
  postUrl: "https://x.com/i/status/20",
  expiresAt: NOW + 42 * 60000,
  ...over,
});

// ── Progress is measured baseline → target ───────────────────────────────────

test("progress runs from the BASELINE, not from zero", () => {
  // A post that already had 200 likes must start the raid with an EMPTY bar.
  // Measuring from zero shows a full bar the instant a raid launches.
  assert.strictEqual(card.progress(200, 200, 215), 0);
  assert.strictEqual(card.progress(215, 200, 215), 1);
  assert.ok(Math.abs(card.progress(209, 200, 215) - 9 / 15) < 1e-9);
});

test("un-liking clamps to zero instead of throwing", () => {
  // A negative fraction would make String.repeat() throw and take the card down.
  assert.strictEqual(card.progress(190, 200, 215), 0);
  assert.doesNotThrow(() => card.bar(-1, card.STYLE_DEFAULT));
});

// ── The row has to survive a phone ───────────────────────────────────────────

test("a metric row keeps its count on the SAME line as the bar", () => {
  // Reported from a live card: ten bar cells pushed the row past the width of a
  // phone, and Telegram wraps at a space — the last one being the gap before the
  // count. So "0/5" and "0/10" landed on lines of their own UNDER the bar, and
  // the numbers, the only part anyone reads, ended up furthest from the label.
  //
  // The row cannot be measured in pixels from here, so this pins the two things
  // that made it overflow: one line per goal, and a budget on its length.
  const raid = {
    crewOnly: false,
    baseline: { likes: 0, replies: 0, reposts: 0 },
    target: { likes: 16, replies: 5, reposts: 0 },
    current: { likes: 1, replies: 0, reposts: 0 },
    crewTarget: 10,
    crew: [],
  };
  const rows = card.buildProgressBlock(raid).split("\n").filter(Boolean);
  assert.strictEqual(rows.length, 3, "likes, replies, crew — one line each, nothing wrapped onto its own");
  for (const r of rows) {
    assert.ok(/\d+\/\d+$/.test(r), `the count ends the row: ${r}`);
    assert.ok(r.length <= 26, `row is ${r.length} chars, too wide for a phone: ${r}`);
  }
});

test("the default bar is short, and stays tunable without a deploy", () => {
  // The wrap point depends on the reader's font, language and device — none of
  // which this process can see — so an operator who still sees a wrap lowers it
  // in .env. Clamped at both ends: 0 cells is not a bar, and a wide one is the
  // bug this came from.
  const { RAID_BAR_WIDTH } = require("../src/config/constants");
  assert.ok(RAID_BAR_WIDTH <= 8, `a bar of ${RAID_BAR_WIDTH} cells is what pushed the count onto its own line`);
  assert.strictEqual(card.bar(1, card.STYLE_DEFAULT).length, RAID_BAR_WIDTH);
});

test("ANY progress lights a cell; exactly zero lights none", () => {
  // 1/16 is 6.25%, which rounds to zero cells on a short bar — and an all-empty
  // bar beside "1/16" says nothing happened when something did. Rounding down to
  // nothing gets easier the fewer cells there are, so the floor arrived with the
  // narrower bar.
  const [, , , , FILLED] = card.STYLE_DEFAULT;
  assert.ok(card.bar(1 / 16, card.STYLE_DEFAULT).startsWith(FILLED), "one like is visible");
  assert.ok(!card.bar(0, card.STYLE_DEFAULT).includes(FILLED), "…but nothing yet is still nothing");
  assert.strictEqual(card.bar(1, card.STYLE_DEFAULT).includes(card.STYLE_DEFAULT[5]), false, "a met goal is full");
});

test("an untracked metric is invisible — target equal to baseline IS 'off'", () => {
  const raid = raidOf();
  assert.deepStrictEqual(card.activeMetrics(raid).map((m) => m.key), ["likes", "replies"]);
  assert.ok(!card.buildProgressBlock(raid).includes("Reposts"));
});

test("a crew-only raid shows no X rows at all", () => {
  const raid = raidOf({ crewOnly: true });
  assert.deepStrictEqual(card.activeMetrics(raid), []);
  const block = card.buildProgressBlock(raid);
  assert.ok(block.includes("Crew"));
  assert.ok(!block.includes("Likes"));
});

test("a raid with no goals whatsoever is never 'complete'", () => {
  const empty = raidOf({ crewTarget: 0, target: { likes: 200, replies: 10, reposts: 0 } });
  assert.strictEqual(card.isComplete(empty), false);
});

test("completion needs EVERY tracked goal, crew included", () => {
  const hitX = raidOf({ current: { likes: 215, replies: 15, reposts: 0 } });
  assert.strictEqual(card.isComplete(hitX), false, "crew is 3/10");
  hitX.crew = Array.from({ length: 10 }, (_, i) => ({ name: `u${i}` }));
  assert.strictEqual(card.isComplete(hitX), true);
});

// ── The signature ────────────────────────────────────────────────────────────

test("the signature ignores the clock, so a poll with no change never edits", () => {
  const raid = raidOf();
  assert.strictEqual(card.signature(raid, "running"), card.signature(raid, "running"));
  // Telegram answers "message is not modified" and the group's edit rate limit
  // gets spent on a redrawn timestamp.
  const later = { ...raid, expiresAt: raid.expiresAt - 60000 };
  assert.strictEqual(card.signature(later, "running"), card.signature(raid, "running"));
});

test("a crew join changes the signature, so the roster repaints", () => {
  const raid = raidOf();
  const before = card.signature(raid, "running");
  raid.crew.push({ name: "@new" });
  assert.notStrictEqual(card.signature(raid, "running"), before);
});

test("the error FLAG is in the signature, its wording is not", () => {
  const raid = raidOf();
  const ok = card.signature(raid, "running");
  raid.lastError = "X rate limit reached";
  const err = card.signature(raid, "running");
  assert.notStrictEqual(err, ok, "the transition itself is worth exactly one edit");
  raid.lastError = "something else entirely";
  assert.strictEqual(card.signature(raid, "running"), err, "a reworded error must not repaint");
});

// ── Style ────────────────────────────────────────────────────────────────────

test("raid_style falls back FIELD BY FIELD, so a typo can never break the card", () => {
  // markup(), not t(): these six glyphs are VARS spliced into raid_card and
  // parsed there, so a premium one has to arrive still wearing its markup.
  const real = tpl.markup;
  try {
    // An admin who types "🟩|⬛" meaning filled|empty gets odd metric icons —
    // and still gets a card.
    tpl.markup = (k) => (k === "raid_style" ? "🟩|⬛" : real(k));
    const s = card.raidStyle();
    assert.deepStrictEqual(s, ["🟩", "⬛", "🔁", "🤝", "▰", "▱"]);
    tpl.markup = () => "   |||||   ";
    assert.deepStrictEqual(card.raidStyle(), card.STYLE_DEFAULT);
    tpl.markup = () => { throw new Error("template layer down"); };
    assert.deepStrictEqual(card.raidStyle(), card.STYLE_DEFAULT);
  } finally {
    tpl.markup = real;
  }
});

test("the progress block carries no HTML and no bold — only the icons may be markup", () => {
  // It is spliced into raid_card and parsed THERE, so a premium-emoji fragment
  // in it is intended and resolves. Anything else is not: an HTML tag or a **
  // run would reach the group as literal characters, or worse, swallow the
  // markup that follows it.
  const block = card.buildProgressBlock(raidOf());
  assert.ok(!/[<>]/.test(block));
  assert.ok(!block.includes("**"));
});

// ── Rendering ────────────────────────────────────────────────────────────────

test("the live card shows the goals, the crew and the post", () => {
  const c = card.renderCard(raidOf(), { now: NOW });
  assert.match(c.text, /DEXVRA RAID #3/);
  assert.match(c.text, /57% complete/);
  assert.match(c.text, /209\/215/);
  assert.match(c.text, /Crew: 3/);
  assert.match(c.text, /@ana, @bo, cy/);
  assert.match(c.text, /12:33:57 UTC/);
});

test("only a LIVE card offers the join button", () => {
  const live = card.renderCard(raidOf(), { now: NOW });
  const labels = (r) => r.extra.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(labels(live).includes("🙋 Count me in"));
  const done = card.renderCard(raidOf(), { now: NOW, status: "completed" });
  assert.ok(!labels(done).includes("🙋 Count me in"), "a finished card must not invite taps");
  assert.ok(labels(done).some((l) => l.includes("Open the post")));
});

test("each end state renders its own card, and all of them keep the numbers", () => {
  for (const [status, re] of [
    ["completed", /TARGETS HIT/],
    ["expired", /TIME'S UP/],
    ["cancelled", /STOPPED/],
  ]) {
    const c = card.renderCard(raidOf(), { now: NOW, status });
    assert.match(c.text, re);
    assert.match(c.text, /209\/215/, `${status} keeps its numbers — the card is the record`);
  }
});

test("a stale read is LABELLED stale rather than silently frozen", () => {
  const c = card.renderCard(raidOf({ lastError: "X rate limit reached" }), { now: NOW });
  assert.match(c.text, /unavailable/i);
});

test("an X post's text can NEVER inject a link into the card", () => {
  // The post text is whatever anyone chose to tweet, and the card is premium
  // MARKUP — so an un-neutralised "[click me](url)" would become a real,
  // clickable link inside a paying project's pinned card. A scammer needs only
  // to write the tweet.
  const c = card.renderCard(
    raidOf({ postText: "gm **bold** [click me](https://evil.test) `code`" }),
    { now: NOW },
  );
  const links = (c.extra.entities || []).filter((e) => e.type === "text_link");
  assert.deepStrictEqual(links, [], "no link entity may come from the post text");
  assert.ok(!c.text.includes("[click me]"));
});

test("a crew member's display name can NEVER inject a link either", () => {
  // Worse than the post text: anyone can join any raid, and a Telegram display
  // name is free-form.
  const c = card.renderCard(
    raidOf({ crew: [{ name: "[free airdrop](https://evil.test)" }] }),
    { now: NOW },
  );
  const links = (c.extra.entities || []).filter((e) => e.type === "text_link");
  assert.deepStrictEqual(links, []);
});

test("a BARE url in a display name is neutralised too — Telegram auto-links those", () => {
  // sanitizeVar only stops markup delimiters. A member setting their name to
  // "🎁 t.me/DexvraDrop" and saying one word in the chat would otherwise get a
  // tappable link into a paying project's PINNED card, re-posted on every bump.
  const c = card.renderCard(raidOf({ crew: [{ name: "🎁 t.me/DexvraDrop" }] }), { now: NOW });
  assert.ok(!c.text.includes("t.me/"));
  assert.match(c.text, /🔗/);
});

test("a bare url in the raided post's text is neutralised as well", () => {
  const c = card.renderCard(raidOf({ postText: "claim now at https://evil.test/x" }), { now: NOW });
  assert.ok(!c.text.includes("evil.test"), "the card only renders links it built itself");
});

test("ordinary punctuation in a post still reads normally", () => {
  // The sanitiser must neutralise delimiters without mangling real text.
  const c = card.renderCard(raidOf({ postText: "gm! we're at 90% — let's go (finally)" }), { now: NOW });
  assert.match(c.text, /gm! we're at 90% — let's go \(finally\)/);
});

test("a long post is clipped by CODE POINT, so an emoji is never split", () => {
  const clipped = card.clip("🚀".repeat(200));
  assert.strictEqual(Array.from(clipped).length, 141); // 140 + the ellipsis
  assert.ok(!clipped.includes("�"));
});

test("the roster names at most six people, then counts the rest", () => {
  const raid = raidOf({ crew: Array.from({ length: 9 }, (_, i) => ({ name: `u${i}` })) });
  assert.match(card.rosterOf(raid), /\+3 more$/);
});

test("time left reads in minutes, then hours, and never goes negative", () => {
  assert.strictEqual(card.timeLeft({ expiresAt: NOW + 42 * 60000 }, NOW), "42m");
  assert.strictEqual(card.timeLeft({ expiresAt: NOW + 125 * 60000 }, NOW), "2h 05m");
  assert.strictEqual(card.timeLeft({ expiresAt: NOW - 1 }, NOW), "0m");
});

test("a PREMIUM metric icon reaches the live raid card", async () => {
  // raidStyle() read raid_style through t(), which resolves to CLEAN text —
  // exactly the wrong call for six glyphs that travel as a VAR into raid_card
  // and get parsed there. So an operator who set a premium ❤️ / 💬 / 🤝 saw
  // every other icon on the card animate while the metric rows stayed bare
  // fallback chars, with nothing to say why. The same bug buyBarStyle had.
  const tpl = require("../src/templates");
  const card = require("../src/raid/card");
  await tpl.replaceEmojiAt("raid_style", 0, "[❤️](emoji/111)"); // likes
  await tpl.replaceEmojiAt("raid_style", 3, "[🤝](emoji/444)"); // crew
  try {
    const raid = {
      seq: 7,
      status: "running",
      postUrl: "https://x.com/a/1",
      postText: "gm",
      crew: ["a", "b"],
      target: { likes: 215 },
      baseline: { likes: 0 },
      current: { likes: 209 },
      crewTarget: 20,
      deadline: Date.now() + 38 * 60000,
      createdAt: Date.now(),
    };
    const out = card.renderCard(raid);
    const prem = (out.extra.entities || []).filter((e) => e.type === "custom_emoji");
    const byId = Object.fromEntries(prem.map((e) => [e.custom_emoji_id, out.text.substr(e.offset, e.length)]));
    assert.strictEqual(byId["111"], "❤️", "the likes row carries its premium entity");
    assert.strictEqual(byId["444"], "🤝", "and so does the crew row");
    // The rows still read correctly — a premium swap must not disturb the bar.
    assert.match(out.text, /❤️ Likes\s+[▰▱]+\s+209\/215/);
  } finally {
    await tpl.resetTemplate("raid_style");
  }
});
