// The Broadcast Manager — the fourtis adminbot's dashboard over this bot's
// job store. What these pin, each a way the panel could quietly lie:
// stats() counts REAL sends only (a 🧪 test or an ✏️ edit would inflate every
// number the card reports), sent message ids are recorded (without them Edit
// Sent can never exist), an edit job rewrites exactly the delivered messages,
// and "nothing to edit" vs "sent before ids were recorded" stay two answers.
process.env.ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "123:TEST";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const store = require("../src/broadcast/store");
const sender = require("../src/broadcast/sender");
const { _bc } = require("../src/admin/adminBot");

const rm = (p) => {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
};
const rmJob = (j) => j && rm(path.join(store.BC_DIR, `${j.id}.json`));

// stats()/history/csv take the job list as an argument — the fixtures below
// never touch the shared BC_DIR, so a parallel suite's transient job files
// cannot race these assertions.
const J = (over) => ({
  id: over.id || Math.random().toString(36).slice(2),
  status: "completed",
  kind: "send",
  test: false,
  text: "hi",
  sent: 0,
  failed: 0,
  total: 0,
  cursor: 0,
  createdAt: 1,
  ...over,
});

test("stats counts REAL sends only — tests and edits never inflate the card", () => {
  const jobs = [
    J({ id: "a", sent: 700, failed: 300, total: 1000, finishedAt: 10 }),
    J({ id: "b", sent: 29, failed: 1, total: 30, finishedAt: 20 }),
    J({ id: "pending", status: "pending", total: 50 }),
    J({ id: "tst", test: true, sent: 1, failed: 0, total: 1, finishedAt: 30 }),
    J({ id: "ed", kind: "edit", sent: 999, failed: 0, total: 999, finishedAt: 40 }),
  ];
  const s = store.stats(jobs);
  assert.strictEqual(s.broadcasts, 3, "two done + one pending, test/edit excluded");
  assert.strictEqual(s.done, 2);
  assert.strictEqual(s.sent, 729);
  assert.strictEqual(s.failed, 301);
  assert.strictEqual(Math.round(s.successRate * 10) / 10, 70.8);
  assert.strictEqual(s.lastCompleted.id, "b", "newest FINISHED real send");
});

test("no attempts means NO rate — never a fabricated 100%", () => {
  const s = store.stats([J({ id: "p", status: "pending", total: 5 })]);
  assert.strictEqual(s.successRate, null);
  assert.strictEqual(s.lastCompleted, null);
});

test("the manager card renders audience, last-completed and all-time", () => {
  const s = store.stats([J({ id: "a", sent: 729, failed: 358, total: 1087, finishedAt: Date.parse("2026-08-16T12:00:00Z") })]);
  const text = _bc.bcManagerText(s, 1140);
  assert.match(text, /Total users: <b>1140<\/b>/);
  assert.match(text, /16\/08\/2026 · ✅ 729 \/ 1087 · ❌ 358/);
  assert.match(text, /Broadcasts: <b>1<\/b> \(1 done\)/);
  assert.match(text, /Success rate: <b>67\.1%<\/b>/);
  // every manager action is one tap below the card
  const cbs = _bc.bcManagerKb().reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  for (const c of ["bc_new", "bc_status", "bc_edit", "bc_hist", "bc_refresh", "home"]) {
    assert.ok(cbs.includes(c), `${c} missing from the manager keyboard`);
  }
});

test("a send RECORDS each recipient's message id — Edit Sent depends on it", async () => {
  let n = 100;
  const tg = { async sendMessage() { return { message_id: ++n }; } };
  const job = await store.createJob({ text: "hi", createdBy: "t", targets: ["u1", "u2"] });
  try {
    await sender.runJob(tg, job);
    const d = store.loadJob(job.id);
    assert.deepStrictEqual(d.sentIds, { u1: 101, u2: 102 });
  } finally {
    rmJob(job);
  }
});

test("an edit job rewrites exactly the delivered messages, at their own ids", async () => {
  const tgSend = { async sendMessage(uid) { return { message_id: uid === "u1" ? 11 : 22 }; } };
  const src = await store.createJob({ text: "old", createdBy: "t", targets: ["u1", "u2"] });
  let editJob = null;
  try {
    await sender.runJob(tgSend, src);

    const edits = [];
    const tgEdit = {
      async editMessageText(chat, mid, _im, text) { edits.push([chat, mid, text]); },
      async sendMessage() { throw new Error("an edit job must never SEND"); },
    };
    const r = await store.createEditJob({ sourceId: src.id, text: "new", createdBy: "t" });
    editJob = r.job;
    assert.ok(editJob, "edit job created");
    await sender.runJob(tgEdit, editJob);
    edits.sort((a, b) => a[1] - b[1]);
    assert.deepStrictEqual(edits, [["u1", 11, "new"], ["u2", 22, "new"]]);
    const d = store.loadJob(editJob.id);
    assert.strictEqual(d.status, "completed");
    assert.strictEqual(d.sent, 2);
  } finally {
    rmJob(src);
    rmJob(editJob);
  }
});

test("a media send edits the CAPTION; 'not modified' counts as edited, a gone message as failed", async () => {
  const src = await store.createJob({ text: "cap", createdBy: "t", targets: [] });
  src.mediaFileId = "FID";
  src.sentIds = { u1: 1, u2: 2, u3: 3 };
  await store.saveJob(src);
  let editJob = null;
  try {
    const captions = [];
    const tg = {
      async editMessageCaption(chat, mid, _im, caption) {
        if (chat === "u2") throw new Error("Bad Request: message is not modified");
        if (chat === "u3") throw new Error("Bad Request: message to edit not found");
        captions.push([chat, mid, caption]);
      },
      async editMessageText() { throw new Error("a media edit must go to the caption"); },
    };
    const r = await store.createEditJob({ sourceId: src.id, text: "newcap", createdBy: "t" });
    editJob = r.job;
    await sender.runJob(tg, editJob);
    assert.deepStrictEqual(captions, [["u1", 1, "newcap"]]);
    const d = store.loadJob(editJob.id);
    assert.strictEqual(d.sent, 2, "u1 edited + u2's not-modified counts as edited");
    assert.strictEqual(d.failed, 1, "u3's deleted message is the only failure");
  } finally {
    rmJob(src);
    rmJob(editJob);
  }
});

test("a send with no recorded ids answers no_ids — a DIFFERENT fact from not_found", async () => {
  const old = await store.createJob({ text: "pre-feature", createdBy: "t", targets: ["u1"] });
  try {
    assert.strictEqual((await store.createEditJob({ sourceId: old.id, text: "x", createdBy: "t" })).error, "no_ids");
    assert.strictEqual((await store.createEditJob({ sourceId: "nope", text: "x", createdBy: "t" })).error, "not_found");
  } finally {
    rmJob(old);
  }
});

test("history renders newest-first with kind tags, and the CSV carries every job", () => {
  const jobs = [
    J({ id: "new", sent: 5, failed: 1, total: 6, createdAt: 200, finishedAt: 200 }),
    J({ id: "ed", kind: "edit", sent: 3, failed: 0, total: 3, createdAt: 150, finishedAt: 150 }),
    J({ id: "tst", test: true, sent: 1, failed: 0, total: 1, createdAt: 100, finishedAt: 100 }),
    J({ id: "run", status: "in_progress", cursor: 2, total: 9, createdAt: 50 }),
  ];
  const h = _bc.bcHistoryText(jobs);
  assert.match(h, /✅ 5\/6 · ❌ 1/);
  assert.match(h, /✏️ edit/);
  assert.match(h, /🧪 test/);
  assert.match(h, /⏳ in_progress \(2\/9\)/);

  const csv = _bc.bcCsv(jobs);
  const lines = csv.split("\n");
  assert.strictEqual(lines.length, 5, "header + one row per job");
  assert.match(lines[0], /^id,kind,test,status/);
  assert.match(csv, /ed,edit,no,completed/);
  assert.match(csv, /tst,send,yes,completed/);
});

test("an empty store renders an honest empty history, not a broken card", () => {
  assert.match(_bc.bcHistoryText([]), /No broadcasts yet/);
  const s = store.stats([]);
  assert.match(_bc.bcManagerText(s, 0), /— none completed yet/);
  assert.match(_bc.bcManagerText(s, 0), /Success rate: <b>—<\/b>/);
});
