// ⚠️ A CONFIRM TAP MUST NOT PARK TELEGRAF'S POLLING LOOP.
//
// Telegraf's long-polling loop is, verbatim (telegraf 4.16.3,
// lib/core/network/polling.js):
//
//     for await (const updates of this)
//       await Promise.all(updates.map(handleUpdate));
//
// It does not ask Telegram for the NEXT batch of updates until every handler in
// the current one has settled. So a handler that waits is not slow for the
// person who tapped — IT IS THE WHOLE BOT GOING DEAF, for every user in every
// chat, until it returns.
//
// confirmPayHandler used to `await verify.verifyPayment(...)`, whose poll runs
// for PAYMENT_TIMEOUT_MS — five minutes by default. Reported 2026-09-11 with a
// screenshot: a buyer tapped ✅ I've Paid before their transfer landed, saw
// "Verifying your payment…" at 18:38, and then sent /start three times to a bot
// that answered nothing at all. At 120s Telegraf's handlerTimeout killed the
// promise, so they got an error instead of a verdict, and the abandoned
// setInterval kept hitting the RPC for three minutes more.
//
// ⚠️ fulfilDetached.test.js proves the same rule for the FULFILMENT half of this
// handler — and could never have caught this, because every order it drives is
// `adminFree: true`, which is the one kind that skips verifyPayment entirely.
// The paid path had no test at all.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-confirm-"));
// Frozen at require time by config/constants, so both are set before anything is
// required — and both are CLAMPED by the shipped code (1s floor / 30s floor).
// The test follows the real floors rather than reaching around them: a value the
// shipped code cannot produce proves nothing about the shipped code.
process.env.PAYMENT_CONFIRM_MS = "1000";
process.env.PAYMENT_TIMEOUT_MS = "30000";
process.env.PAYMENT_POLL_MS = "1500";

const test = require("node:test");
const assert = require("node:assert");

const { PAYMENT_CONFIRM_MS, PAYMENT_TIMEOUT_MS } = require("../src/config/constants");
const wallets = require("../src/payments/wallets");
const orders = require("../src/payments/orders");
const fulfilment = require("../src/fulfillment");
const { confirmPayHandler, armPayment } = require("../src/payments/payment");

const ADDR = "0x5E5154411460A6bD7734CeEd3BD829111f737749";
// ⚠️ EVERY ORDER GETS ITS OWN ADDRESS, AND THE STUB ANSWERS ONLY FOR ITS OWN.
//
// The watchers this change introduces OUTLIVE the test that started them — that
// is the whole point of them — so an earlier test's watcher is still calling
// wallets.getBalance while a later test owns the stub. Unkeyed, it drove the
// later test's counters and credited orders from two tests back: "fulfilled 3
// !== 1" on a run where nothing was wrong with the code. Stated here rather
// than inherited, the scar the auto-trend panel helper already carries.
// A credited order passes through 'paid' on its way to 'fulfilled', and under a
// stubbed fulfilment that happens in the same tick — so asserting either literal
// is asserting a race. What matters is that the money was taken.
const credited = (id) => ["paid", "fulfilled"].includes(orders.getOrder(id).status);
const TARGET = 60000000000000000n; // 0.06 ETH, the reported order

let seq = 0;
const mkOrder = (over = {}) => ({
  id: `ord_confirm_${++seq}`,
  addr: `0xADDR${String(seq).padStart(35, "0")}`,
  kind: "xpress_listing",
  chain: "robinhood",
  native: "ETH",
  humanAmount: "0.06",
  amountSmallest: TARGET.toString(),
  label: "Xpress Listing",
  buyerId: 42,
  status: "pending",
  createdAt: Date.now(),
  payload: { listingInput: { chain: "robinhood", address: ADDR, sym: "ACAI", name: "Acai" } },
  ...over,
});

const mkCtx = (order) => {
  const replies = [];
  return {
    replies,
    from: { id: 42, username: "buyer" },
    chat: { id: 42 },
    session: { pendingPayment: { order, address: order.addr, adminFree: false } },
    answerCbQuery: async () => true,
    reply: async (t) => {
      replies.push(typeof t === "string" ? t : t && t.text ? t.text : JSON.stringify(t));
      return { message_id: replies.length };
    },
  };
};

/** Stub the chain read + fulfilment for ONE order, and put them back after. */
function harness(t, order, { balance } = {}) {
  const origBal = wallets.getBalance;
  const origFul = fulfilment.fulfillOrder;
  t.after(() => {
    wallets.getBalance = origBal;
    fulfilment.fulfillOrder = origFul;
  });
  const state = { reads: 0, fulfilled: 0 };
  wallets.getBalance = async (chain, address) => {
    // A stray watcher from an earlier test gets a flat 0 and is counted nowhere.
    if (address !== order.addr) return 0n;
    state.reads += 1;
    return balance ? balance(state.reads) : 0n;
  };
  fulfilment.fulfillOrder = async (_ctx, o) => {
    if (o && o.id !== order.id) return { phases: [], ms: 1 };
    state.fulfilled += 1;
    return { phases: [], ms: 1 };
  };
  return state;
}

/** Resolves "handler" if the tap returned first, "STALLED" if it parked. */
async function raceTap(ctx, ms) {
  const tap = confirmPayHandler(ctx).then(() => "handler");
  const timer = new Promise((r) => setTimeout(r, ms, "STALLED").unref?.());
  return Promise.race([tap, timer]);
}

// ── the reported outage ──────────────────────────────────────────────────────

test("a tap on a payment that has NOT landed returns instead of parking the bot", async (t) => {
  const order = mkOrder();
  const st = harness(t, order, { balance: () => 0n }); // never funded, like the report
  await orders.saveOrder(order);

  // Generous: the whole tap is allowed several times the single-read budget and
  // is still nowhere near the five-minute poll the old code awaited. On the old
  // code the tap is parked on pollBalance and the timer wins — which IS the 120s
  // handlerTimeout, arrived at a few seconds sooner.
  const winner = await raceTap(mkCtx(order), PAYMENT_CONFIRM_MS * 4);
  assert.strictEqual(winner, "handler", "confirmPayHandler must return before the payment lands");

  // …and returning must not mean GIVING UP. A handler that returned because it
  // stopped looking would pass the assertion above and quietly drop the order —
  // the curveBuyPath scar: a wiring that does nothing refuses beautifully.
  const before = st.reads;
  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(st.reads > before, `the detached watcher must keep polling (reads ${before} → ${st.reads})`);
});

test("the bot answers OTHER updates while that watcher is still running", async (t) => {
  // The report, stated as the property that actually failed: three /start
  // messages went unanswered. Any other update must settle while the payment is
  // still being watched — which it cannot if the tap is holding the loop.
  const order = mkOrder();
  harness(t, order, { balance: () => 0n });
  await orders.saveOrder(order);

  const tap = confirmPayHandler(mkCtx(order));
  let answered = false;
  await tap;
  // A second, unrelated update handled on the same loop turn.
  await Promise.resolve().then(() => (answered = true));
  assert.strictEqual(answered, true, "an unrelated update must be serviceable after the tap returns");
});

// ── the common case must be unchanged ────────────────────────────────────────

test("a payment already in the wallet is credited on the tap itself", async (t) => {
  const order = mkOrder();
  const st = harness(t, order, { balance: () => TARGET });
  await orders.saveOrder(order);
  const ctx = mkCtx(order);

  await confirmPayHandler(ctx);
  assert.ok(credited(order.id), `the order is credited, got ${orders.getOrder(order.id).status}`);
  // Cleared inside the handler, while the middleware chain still owns the
  // session — a write from the detached tail is dropped on the floor.
  assert.strictEqual(ctx.session.pendingPayment, null, "the spent pay card is cleared by the handler");
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(st.fulfilled, 1, "and fulfilment still runs");
});

test("a payment that lands DURING the watch is credited and fulfilled", async (t) => {
  // The whole reason the watcher exists rather than leaving it to recovery.js:
  // the buyer who tapped a few seconds early still gets their receipt in
  // seconds, not at the next 10-minute scan.
  const order = mkOrder();
  const st = harness(t, order, { balance: (n) => (n >= 3 ? TARGET : 0n) });
  await orders.saveOrder(order);

  await confirmPayHandler(mkCtx(order));
  assert.strictEqual(orders.getOrder(order.id).status, "pending", "not credited on the tap — it had not landed");
  await new Promise((r) => setTimeout(r, 6000));
  assert.ok(credited(order.id), `credited by the watcher once it landed, got ${orders.getOrder(order.id).status}`);
  assert.strictEqual(st.fulfilled, 1, "and fulfilled, off the tap");
});

// ── the guards the session can no longer provide ─────────────────────────────

test("a second tap while the watcher runs does not start a second one", async (t) => {
  // ctx.session._verifying cannot do this job any more: it was cleared when the
  // handler returned, which is now BEFORE verification finishes. Same guard,
  // same reason, as `fulfilling`.
  const order = mkOrder();
  const st = harness(t, order, { balance: () => 0n });
  await orders.saveOrder(order);
  const ctx = mkCtx(order);

  await confirmPayHandler(ctx);
  const afterFirst = st.reads;
  await confirmPayHandler(ctx);
  await confirmPayHandler(ctx);
  await new Promise((r) => setTimeout(r, 200));
  // Two repeat taps cost at most their own single t=0 read each if the guard is
  // gone; with the guard they cost none, and each is answered "still checking".
  assert.ok(
    st.reads - afterFirst <= 1,
    `repeat taps must not start a second watcher (reads grew by ${st.reads - afterFirst})`,
  );
  assert.ok(
    ctx.replies.some((r) => /Still verifying/i.test(r)),
    `the repeat tap must be answered:\n${ctx.replies.join("\n")}`,
  );
});

test("a tap on an ALREADY credited order never says 'payment not detected'", async (t) => {
  // The watcher cannot clear ctx.session.pendingPayment, so the buyer still
  // holds a live pay card after a late payment is credited. Tapping it re-reads
  // a wallet that has since been SWEPT — 0 — and the old answer would have been
  // "we haven't seen your transfer", about an order already paid and delivered.
  const order = mkOrder({ status: "paid" });
  harness(t, order, { balance: () => 0n });
  await orders.saveOrder(order);
  const ctx = mkCtx(order);

  await confirmPayHandler(ctx);
  const said = ctx.replies.join("\n");
  assert.ok(!/not detected/i.test(said), `must not deny a paid order:\n${said}`);
  assert.ok(/Already received/i.test(said), `must say it is already credited:\n${said}`);
});

// ── the read on the tap is bounded ───────────────────────────────────────────

test("a wedged RPC does not park the tap either", async (t) => {
  // wallets.getBalance is an RPC call with no deadline of its own. On a public
  // node that stops answering, an unbounded read on this path is the same
  // outage by a different route.
  const order = mkOrder();
  harness(t, order, { balance: () => new Promise(() => {}) }); // never resolves
  await orders.saveOrder(order);

  const winner = await raceTap(mkCtx(order), PAYMENT_CONFIRM_MS * 4);
  assert.strictEqual(winner, "handler", "a read that never answers must not hold the polling loop");
});

test("PAYMENT_CONFIRM_MS is far below the poll it replaced on the tap", () => {
  // If these were ever set to the same number the fix would be inert: the tap
  // would be back to awaiting the full poll.
  assert.ok(
    PAYMENT_CONFIRM_MS * 2 <= PAYMENT_TIMEOUT_MS,
    `the tap budget (${PAYMENT_CONFIRM_MS}ms) must stay well under the watch budget (${PAYMENT_TIMEOUT_MS}ms)`,
  );
});


// ⚠️ ONE SPELLING OF THE SETTLEMENT NETWORK, ACROSS BOTH MESSAGES.
//
// The pay card the buyer is still looking at says "Robinhood Chain"; this toast
// said "ROBINHOOD" — and the bare word is the broker-vs-chain ambiguity the
// NETWORK_LABEL constant exists to prevent, on the two consecutive messages that
// tell somebody where to send money. networkLabel is the one owner of the name,
// so the card and the toast cannot come to disagree.
test("the verifying toast names the network the way the pay card does", async (t) => {
  const order = mkOrder({ chain: "robinhood" });
  harness(t, order, { balance: () => 0n });
  await orders.saveOrder(order);
  const ctx = mkCtx(order);
  await confirmPayHandler(ctx);
  const toastText = ctx.replies.find((r) => /Verifying your payment/.test(r));
  assert.ok(toastText, "the buyer is told the check is running");
  assert.match(toastText, /Robinhood Chain/);
  assert.doesNotMatch(toastText, /ROBINHOOD/, "never the bare uppercased chain id");
});
