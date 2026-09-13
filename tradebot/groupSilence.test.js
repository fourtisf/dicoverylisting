// A member joined the group and the trade bot answered: "This is a custodial
// trading bot — please DM me privately." Nobody had addressed it. In Telegram a
// join arrives as a `message`, and the group guard replied to any message at
// all, so every arrival — and every restart-era rejoin — produced the same line
// in a room the bot was only sitting in.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-groupsilence-"));

const test = require("node:test");
const assert = require("node:assert");

let answer = null;
try {
  answer = require("./telegram")._test._shouldAnswerInGroup;
} catch {
  /* deps not installed in this checkout */
}
const SRC = fs.readFileSync(path.join(__dirname, "telegram.js"), "utf8");

let chatSeq = 0;
const chat = () => -100000 - chatSeq++; // a fresh group per case: the throttle is per chat

test("a member joining is met with silence", (t) => {
  if (!answer) return t.skip("deps not installed in this checkout");
  assert.strictEqual(answer({ new_chat_members: [{ id: 7 }] }, chat()), false);
});

test("every other thing Telegram narrates is silent too", (t) => {
  if (!answer) return t.skip("deps not installed in this checkout");
  // Same shape as a join: a `message` with no author intent behind it. Each one
  // would have produced the notice.
  for (const key of [
    "left_chat_member",
    "new_chat_title",
    "new_chat_photo",
    "pinned_message",
    "video_chat_started",
    "forum_topic_created",
    "boost_added",
    "group_chat_created",
  ]) {
    assert.strictEqual(answer({ [key]: {} }, chat()), false, `${key} must not trigger the notice`);
  }
});

test("ordinary chatter is silent — the bot was never spoken to", (t) => {
  if (!answer) return t.skip("deps not installed in this checkout");
  assert.strictEqual(answer({ text: "gm" }, chat()), false);
  assert.strictEqual(answer({ text: "wen moon" }, chat()), false);
  assert.strictEqual(answer({ caption: "look at this chart" }, chat()), false);
  assert.strictEqual(answer({ photo: [{}] }, chat()), false, "a photo with no caption is not a question");
});

test("a command DOES get an answer — that is who the notice is for", (t) => {
  if (!answer) return t.skip("deps not installed in this checkout");
  assert.strictEqual(answer({ text: "/start" }, chat()), true);
  assert.strictEqual(answer({ text: "/buy 0x123" }, chat()), true);
});

test("…once per group per hour, not once per command", (t) => {
  if (!answer) return t.skip("deps not installed in this checkout");
  // Telling a room that has already been told is the same spam in slow motion.
  const id = chat();
  assert.strictEqual(answer({ text: "/start" }, id), true);
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(answer({ text: "/start" }, id), false, `repeat ${i + 1} must stay quiet`);
  }
});

test("each group is told on its own — one room's notice does not silence another", (t) => {
  if (!answer) return t.skip("deps not installed in this checkout");
  assert.strictEqual(answer({ text: "/start" }, chat()), true);
  assert.strictEqual(answer({ text: "/start" }, chat()), true);
});

test("the guard is what the router actually calls", () => {
  // A predicate nobody consults is a comment.
  assert.match(SRC, /else if \(_shouldAnswerInGroup\(up\.message, chat\.id\)\) \{/);
  // The group is still refused — this is about noise, not about opening the bot
  // up to group use.
  assert.match(SRC, /Group use is disabled for security/);
  assert.match(SRC, /DM me privately — group use is disabled\./, "a tapped button still gets its toast");
});

test("the throttle map cannot grow forever", () => {
  // This bot sits in every group it is ever added to.
  assert.match(SRC, /if \(_groupNoticeAt\.size > 500\)/);
  assert.match(SRC, /_groupNoticeAt\.delete\(k\)/);
});
