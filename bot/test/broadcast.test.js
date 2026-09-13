const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const store = require("../src/broadcast/store");
const sender = require("../src/broadcast/sender");

const rm = (p) => {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
};

test("broadcast delivers, retries 429, counts blocked as failed", async () => {
  const sent = [];
  let flagged = false;
  const tg = {
    async sendMessage(uid) {
      if (uid === "retry" && !flagged) {
        flagged = true;
        const e = new Error("429");
        e.response = { parameters: { retry_after: 0 } };
        throw e;
      }
      if (uid === "blocked") {
        const e = new Error("403");
        e.response = { error_code: 403 };
        throw e;
      }
      sent.push(uid);
    },
  };
  const job = await store.createJob({ text: "hi", createdBy: "t", targets: ["a", "retry", "blocked", "b"] });
  await sender.runJob(tg, job);
  const d = store.loadJob(job.id);
  assert.strictEqual(d.status, "completed");
  assert.strictEqual(d.sent, 3); // a, retry (after 429), b
  assert.strictEqual(d.failed, 1); // blocked
  rm(path.join(store.BC_DIR, `${job.id}.json`));
});

test("broadcast uploads media once, reuses the file_id", async () => {
  let uploads = 0;
  let reuse = 0;
  const tg = {
    async sendPhoto(uid, media) {
      if (media && media.source) uploads++;
      else reuse++;
      return { photo: [{ file_id: "MAINBOT_FID" }] };
    },
    async sendMessage() {
      throw new Error("media job must not send text");
    },
  };
  fs.mkdirSync(store.BC_DIR, { recursive: true });
  const img = path.join(store.BC_DIR, "unit-test.png");
  fs.writeFileSync(img, Buffer.from("89504e470d0a1a0a", "hex"));
  const job = await store.createJob({ text: "cap", mediaPath: img, createdBy: "t", targets: ["a", "b", "c"] });
  await sender.runJob(tg, job);
  assert.strictEqual(uploads, 1);
  assert.strictEqual(reuse, 2);
  rm(path.join(store.BC_DIR, `${job.id}.json`));
  rm(img);
});
