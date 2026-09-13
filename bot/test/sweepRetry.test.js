// A failed sweep used to be a log line and nothing else — the buyer's money
// stayed in the temp wallet until a human opened an explorer. sweepRetry closes
// that, and its safety rule is the entire point: it may only touch wallets of
// orders that were already paid for. Sweeping a `pending` wallet would take
// funds for something we never delivered.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
const dir = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-sweepr-"));
process.env.BOT_DATA_DIR = dir;

const DAY = 24 * 3600 * 1000;
const now = 1800000000000;
const order = (id, o) => ({ id, chain: "solana", address: `addr_${id}`, createdAt: now - DAY, ...o });
// Written before the orders module is required — it loads its file at require.
fss.mkdirSync(dir, { recursive: true });
fss.writeFileSync(
  path.join(dir, "orders.json"),
  JSON.stringify({
    fulfilled: order("fulfilled", { status: "fulfilled" }),
    paid: order("paid", { status: "paid" }),
    pending: order("pending", { status: "pending" }),
    expired: order("expired", { status: "expired" }),
    free: order("free", { status: "fulfilled", adminFree: true }),
    justSwept: order("justSwept", { status: "fulfilled", sweptAt: now - 1000 }),
    done: order("done", { status: "fulfilled", sweptAt: now - 30 * DAY }),
    ancient: order("ancient", { status: "fulfilled", createdAt: now - 400 * DAY }),
    noaddr: { id: "noaddr", status: "fulfilled", chain: "solana", createdAt: now - DAY },
  }),
);

const test = require("node:test");
const assert = require("node:assert");
const sweepRetry = require("../src/services/sweepRetry");

const ids = (list) => list.map((o) => o.id).sort();

test("only wallets whose order was actually paid for are candidates", () => {
  // justSwept is in the post-sweep re-check window (buyers do pay twice), so
  // it is watched too — but nothing pending or free ever is.
  assert.deepStrictEqual(ids(sweepRetry.candidates(now)), ["fulfilled", "justSwept", "paid"]);
});

test("a pending order's wallet is never swept", () => {
  // The buyer may have sent funds we haven't credited. Taking those without
  // delivering is the one mistake that cannot be undone.
  assert.ok(!sweepRetry.candidates(now).some((o) => o.status === "pending"));
  assert.ok(!sweepRetry.candidates(now).some((o) => o.status === "expired"));
});

test("a FREE admin test order has no funds to chase", () => {
  assert.ok(!sweepRetry.candidates(now).some((o) => o.adminFree));
});

test("a swept order is re-checked for a while, then retired", () => {
  // Not forever — a wallet emptied a month ago is not going to receive a
  // second payment, and each pass costs a balance call.
  const got = ids(sweepRetry.candidates(now));
  assert.ok(got.includes("justSwept"), "swept seconds ago: still watched");
  assert.ok(!got.includes("done"), "swept 30 days ago: retired");
});

test("orders without an address, or long past recovery, are skipped", () => {
  const got = ids(sweepRetry.candidates(now));
  assert.ok(!got.includes("noaddr"));
  assert.ok(!got.includes("ancient"));
});

test("the newest orders are attempted first", () => {
  // A pass is bounded, so ordering decides what gets recovered this cycle —
  // recent money is the money someone is waiting on.
  const c = sweepRetry.candidates(now);
  for (let i = 1; i < c.length; i++) assert.ok(c[i - 1].createdAt >= c[i].createdAt);
});

test("it is wired into the running bot, not just defined", () => {
  const src = fss.readFileSync(require.resolve("../src/services/attach.js"), "utf8");
  assert.match(src, /require\("\.\/sweepRetry"\)\.start\(\)/, "sweepRetry must actually start");
});

test("dust is retired, a real failure is not", () => {
  // A balance that cannot pay for its own gas would otherwise be re-checked
  // every 6 hours until the order aged out — spending more on RPC calls than
  // the dust is worth. A genuine failure must stay un-marked so it retries.
  const src = fss.readFileSync(require.resolve("../src/services/sweepRetry.js"), "utf8");
  assert.match(src, /r\.dust/, "the adapters' dust flag is honoured");
  const dustBranch = src.slice(src.indexOf("r.dust"), src.indexOf("r.dust") + 400);
  assert.match(dustBranch, /sweptAt: Date\.now\(\)/, "dust is marked done");
  assert.match(src, /Left unmarked on purpose/, "…and a real failure is not");
  for (const chain of ["solana", "evm", "tron"]) {
    const a = fss.readFileSync(require.resolve(`../src/payments/chains/${chain}.js`), "utf8");
    assert.match(a, /dust: (true|bal <)/, `${chain} must report dust distinctly from a failure`);
  }
});

test("a wallet stuck for a full day pages the operator", () => {
  // Silence is exactly how the broken SOL sweep survived every order: a
  // warn-level log nobody reads. After ~a day of failed passes it goes to the
  // log channel with the address and the balance.
  const src = fss.readFileSync(require.resolve("../src/services/sweepRetry.js"), "utf8");
  assert.match(src, /ALERT_AFTER_TRIES/, "there is a threshold");
  assert.match(src, /log\.report\(/, "…and it reaches the log channel, not just the file");
  const alert = src.slice(src.indexOf("log.report("), src.indexOf("log.report(") + 600);
  assert.match(alert, /o\.address/, "the alert names the wallet");
  assert.match(alert, /bal/, "…and the amount at stake");
  assert.match(src, /sweepTries: tries/, "attempts are persisted, so the count survives a restart");
});

test("a successful sweep on the normal path marks the order, a failure does not", () => {
  // The retry pass finds work by the ABSENCE of sweptAt — so marking on failure
  // would silently strand the funds it exists to recover.
  const src = fss.readFileSync(require.resolve("../src/payments/verify.js"), "utf8");
  assert.match(src, /if \(r && r\.ok\) return noteSwept\(/, "marked only when the sweep landed");
  assert.match(src, /sweepRetry will retry/, "and the failure says so out loud");
});
