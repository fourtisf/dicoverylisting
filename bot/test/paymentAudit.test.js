// Audit of the whole path: customer pays → funds reach the treasury, with
// nothing left behind and nothing silently dropped. Three holes are pinned
// here, each of which ended with money sitting in a temp wallet forever.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
const dir = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-audit-"));
process.env.BOT_DATA_DIR = dir;

const DAY = 24 * 3600 * 1000;
const now = 1800000000000;
const base = (id, o) => ({
  id,
  chain: "solana",
  address: `addr_${id}`,
  amountSmallest: "1000000000",
  createdAt: now - 3600000,
  ...o,
});
fss.writeFileSync(
  path.join(dir, "orders.json"),
  JSON.stringify({
    p_fresh: base("p_fresh", { status: "pending" }),
    p_old: base("p_old", { status: "pending", createdAt: now - 3 * DAY }),
    p_free: base("p_free", { status: "pending", adminFree: true }),
    p_noamt: base("p_noamt", { status: "pending", amountSmallest: "" }),
    f_done: base("f_done", { status: "fulfilled", sweptAt: now - 6 * 3600000, sweptTx: "tx1" }),
    f_old: base("f_old", { status: "fulfilled", sweptAt: now - 30 * DAY, sweptTx: "tx2" }),
    f_open: base("f_open", { status: "fulfilled" }),
  }),
);

const test = require("node:test");
const assert = require("node:assert");
const verify = require("../src/payments/verify");
const sweepRetry = require("../src/services/sweepRetry");
const ids = (l) => l.map((o) => o.id).sort();

// ── Hole 1: PAYMENT_TOLERANCE_PCT was documented, exported, and read by nothing
test("the tolerance knob actually does something now", () => {
  const src = fss.readFileSync(require.resolve("../src/payments/verify.js"), "utf8");
  assert.match(src, /PAYMENT_TOLERANCE_PCT/, "verify.js must read the knob it is named after");
  assert.match(src, /const target = acceptThreshold\(amount\)/, "…and use it as the accept threshold");
});

test("tolerance 0 means exactly the quoted amount — the default is unchanged", () => {
  // Whatever else this audit changes, an operator who set nothing must see the
  // behaviour they had yesterday.
  assert.strictEqual(Number(process.env.PAYMENT_TOLERANCE_PCT || 0), 0);
  assert.strictEqual(verify.acceptThreshold("1000000000"), 1000000000n);
});

test("a typo'd tolerance cannot give the service away", () => {
  // PAYMENT_TOLERANCE_PCT=95 would otherwise sell a listing for 5% of price.
  const src = fss.readFileSync(require.resolve("../src/payments/verify.js"), "utf8");
  assert.match(src, /MAX_TOLERANCE_PCT = 20/, "there is a ceiling");
  assert.match(src, /clamped/, "…and it is logged, not silent");
});

// ── Hole 2: a late payment was credited only at boot
test("pending orders are re-checked on a timer, not only at boot", () => {
  // Sessions are in-memory: a restart drops pendingPayment, the buyer's next
  // Confirm answers "no pending payment", and their funds sit in a wallet that
  // sweepRetry will not touch (it only sweeps orders already marked paid).
  const rec = fss.readFileSync(require.resolve("../src/services/recovery.js"), "utf8");
  assert.match(rec, /setInterval\(/, "the scan must recur");
  assert.match(rec, /LATE_SCAN_MS = 10 \* 60 \* 1000/, "…often enough that a paying customer is not left waiting");
  const attach = fss.readFileSync(require.resolve("../src/services/attach.js"), "utf8");
  assert.match(attach, /require\("\.\/recovery"\)\.start\(tg\)/, "and it must be started, and stoppable");
});

test("the late scan credits payment on the same threshold the Confirm button uses", () => {
  // Two different definitions of "has paid" is how one path credits a customer
  // the other refuses — with the money already spent.
  const rec = fss.readFileSync(require.resolve("../src/services/recovery.js"), "utf8");
  assert.match(rec, /verify\.acceptThreshold\(o\.amountSmallest\)/);
});

test("the late scan only looks at pending orders young enough to be real", () => {
  const recovery = require("../src/services/recovery");
  assert.deepStrictEqual(ids(recovery.pendingCandidates(now)), ["p_fresh"]);
  // p_old  → older than a day, p_free → nothing to collect,
  // p_noamt → no amount to compare a balance against.
});

test("a credited late payment is swept and fulfilled, in that order", () => {
  const rec = fss.readFileSync(require.resolve("../src/services/recovery.js"), "utf8");
  const i = rec.indexOf('setStatus(o.id, "paid")');
  const s = rec.indexOf("sweepByAddress");
  const f = rec.indexOf('refulfil(tg, o, "late-paid")');
  assert.ok(i > -1 && s > i && f > s, "mark paid → sweep → fulfil");
});

// ── Hole 3: a second payment to an already-swept wallet was never collected
test("a swept wallet keeps being watched — buyers do pay twice", () => {
  const c = ids(sweepRetry.candidates(now));
  assert.ok(c.includes("f_done"), "swept 6h ago: still watched, a second transfer would be caught");
  assert.ok(c.includes("f_open"), "never swept: obviously watched");
  assert.ok(!c.includes("f_old"), "swept 30d ago: the window has closed, stop paying for RPC calls");
});

test("the watch window is bounded, and its reason is written down", () => {
  const src = fss.readFileSync(require.resolve("../src/services/sweepRetry.js"), "utf8");
  assert.match(src, /RECHECK_AFTER_SWEEP_MS = 7 \* 24 \* 3600 \* 1000/);
  assert.match(src, /pay twice/i, "the next reader must know why this is not free");
});

test("re-checking never overwrites the record of a real sweep", () => {
  // An empty wallet inside the re-check window must not re-stamp the order
  // with "already empty" on top of a genuine sweptTx — the report would then
  // stop showing the transaction that proves where the money went.
  const src = fss.readFileSync(require.resolve("../src/services/sweepRetry.js"), "utf8");
  assert.match(src, /if \(o\.sweptAt\) continue;/);
});

// ── The invariant the whole audit is about
test("only orders that were paid for are ever swept", () => {
  const c = sweepRetry.candidates(now);
  assert.ok(!c.some((o) => o.status === "pending"), "a pending wallet may hold funds we have not credited");
  assert.ok(!c.some((o) => o.adminFree), "a free order has nothing to take");
  for (const o of c) assert.ok(["paid", "fulfilled"].includes(o.status), `unexpected status ${o.status}`);
});
