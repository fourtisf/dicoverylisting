// Payment arming + the Confirm-payment handler.
//
// armPayment(): generate a fresh temp wallet, quote the amount, persist a
// restart-recoverable order (with a serializable fulfilment payload), and stash
// it on the session. The calling flow renders the pay card.
//
// confirmPayHandler(): idempotent Confirm button. Verifies the on-chain balance
// (sweep fires inside verify, BEFORE fulfilment), then runs fulfilment. Because
// funds are already captured, fulfilment must be best-effort and never "refund"
// on failure — a failed fulfil leaves the order in `paid` for recovery.
const crypto = require("node:crypto");
const { isAdminUser, FULFIL_SLOW_MS, PAYMENT_CONFIRM_MS, PAYMENT_TIMEOUT_MS } = require("../config/constants");
const { answer, toast } = require("../helpers/message");
const { escapeHtml } = require("../helpers/format");
const { toSmallest, humanWithSymbol } = require("./units");
const { networkLabel } = require("../config/payOptions");
const wallets = require("./wallets");
const verify = require("./verify");
const orders = require("./orders");
const tpl = require("../templates");
const premium = require("../premium");
const log = require("../helpers/logger");

const SERVICE_LABEL = {
  xpress_listing: "Xpress Listing",
  tiered_listing: "Listing & Trending",
  trending: "Trending",
  banner: "Banner Ad",
};
const serviceLabel = (k) => SERVICE_LABEL[k] || k;

function newOrderId() {
  return `${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * @param order {{ kind, chain, native, humanAmount, payload, label? }}
 * @returns {{ address, amount, adminFree, native, humanAmount }}
 */
async function armPayment(ctx, order) {
  const adminFree = isAdminUser(ctx);
  order.id = order.id || newOrderId();
  order.buyerId = ctx.from && ctx.from.id;
  order.buyerUsername = ctx.from && ctx.from.username;
  order.createdAt = Date.now();
  order.status = "pending";

  const wallet = await wallets.generateWallet(order.chain, {
    orderId: order.id,
    service: serviceLabel(order.kind),
    plan: order.label,
    buyerId: order.buyerId,
    buyerUsername: order.buyerUsername,
    amountHuman: adminFree ? "FREE (admin)" : `${order.humanAmount} ${order.native}`,
  });
  const amount = adminFree ? 0n : toSmallest(order.chain, order.humanAmount);
  order.amountSmallest = amount.toString();
  order.address = wallet.address;
  order.adminFree = adminFree;
  await orders.saveOrder(order).catch((e) => log.warn(`[pay] saveOrder: ${e.message}`));

  ctx.session.pendingPayment = { order, address: wallet.address, adminFree };
  return { address: wallet.address, amount, adminFree, native: order.native, humanAmount: order.humanAmount };
}

async function confirmPayHandler(ctx) {
  await answer(ctx);
  const pp = ctx.session && ctx.session.pendingPayment;
  if (!pp) {
    await toast(ctx, tpl.render("no_pending_payment"));
    return;
  }
  const { order, address, adminFree } = pp;

  // ⚠️ THE DURABLE GUARD COMES FIRST, because the session cannot carry this one.
  //
  // watchPayment() below runs after the handler has returned, so it cannot clear
  // ctx.session.pendingPayment — Telegraf writes the session back when the
  // middleware chain exhausts, and an assignment made later is dropped on the
  // floor (the same rule the fulfilment detach already states). So a buyer whose
  // payment was credited by the watcher still holds a live pay card, and tapping
  // it would re-read a wallet that has since been SWEPT and answer "payment not
  // detected" about an order they have already been charged for and delivered.
  // The order file knows better than the session does.
  const live = orders.getOrder(order.id);
  if (live && (live.status === "paid" || live.status === "fulfilled")) {
    await toast(ctx, tpl.render("payment_already_credited", { order: order.id }));
    return;
  }
  // Was ctx.session._verifying. A session flag cannot do this job any more: it is
  // cleared when the handler returns, which is now BEFORE verification finishes,
  // so a second tap would start a second watcher on the same order. Same guard,
  // same reason, as `fulfilling` below.
  if (verifying.has(order.id) || fulfilling.has(order.id)) {
    await toast(ctx, tpl.render("still_checking"));
    return;
  }

  // Immediate on-tap feedback — the buyer must SEE the check is running the
  // moment they tap Confirm (not just a silent spinner). Shown for every tap.
  await toast(
    ctx,
    adminFree
      ? "⏳ Running your order — hang tight…"
      : tpl.render("checking_payment", {
          // networkLabel, not chain.toUpperCase(): the pay card the buyer is
          // looking at says "Robinhood Chain" and this said "ROBINHOOD" — two
          // spellings of the settlement network on two consecutive messages, and
          // the bare one is the broker-vs-chain ambiguity that label exists to
          // prevent. One owner, so they cannot drift.
          chain: networkLabel(order.chain),
          amount: order.humanAmount,
          native: order.native,
        }),
  );

  try {
    let paid = adminFree;
    if (!adminFree) {
      // ⚠️ ONE BALANCE READ, BOUNDED — NOT THE FIVE-MINUTE POLL.
      //
      // Telegraf's polling loop is `for await (const updates of this) await
      // Promise.all(updates.map(handleUpdate))`, so it does not ask Telegram for
      // the next batch of updates until every handler in this one has settled.
      // A handler that waits is therefore not slow for the person who tapped —
      // IT IS THE WHOLE BOT GOING DEAF, for every user in every chat.
      //
      // This used to await verifyPayment's full PAYMENT_TIMEOUT_MS poll. Reported
      // 2026-09-11 with a screenshot: "Verifying your payment…" at 18:38, then
      // three /start messages that were never answered, because no getUpdates
      // call was being made at all. At 120s the handlerTimeout killed the promise
      // — so the buyer got an error rather than a verdict, and the abandoned
      // setInterval kept hitting the RPC for three minutes more.
      //
      // The common case is that the buyer tapped BECAUSE they had already paid,
      // and one read answers that. Everything else is the watcher's.
      const r = await verify.verifyPayment(order.chain, address, order.amountSmallest, {
        timeout: 0,
        firstReadMs: PAYMENT_CONFIRM_MS,
      });
      paid = r.paid;
    }

    if (paid) {
      await orders.setStatus(order.id, "paid").catch(() => {});
      // The payment is confirmed, so the pending card is spent. Cleared HERE,
      // while the middleware chain still owns the session: Telegraf writes
      // ctx.session back after next() resolves, so the same assignment made from
      // the detached runner below would be dropped on the floor.
      ctx.session.pendingPayment = null;
      // ⚠️ FULFILMENT IS DELIBERATELY NOT AWAITED.
      //
      // Telegraf is built with handlerTimeout: 120000, and a tiered listing does
      // not fit in two minutes: an animated custom-emoji build (48 canvas frames
      // + an ffmpeg bitrate ladder), a market read, TWO ffmpeg composites of the
      // admin clip (listing + trending), the X tweet raced to X_POST_TIMEOUT_MS,
      // and three or four video uploads to Telegram — every one of them serial.
      // Hit for real on 2026-09-06: the buyer tapped Confirm at 14:24, saw
      // "Running your order — hang tight…", and at 14:26 the ops channel got
      // "[telegraf] callback_query handler error: Promise timed out after 120000
      // milliseconds". The timeout does NOT cancel the work — the listing still
      // went live — so the only thing it changed was that the buyer got an error
      // instead of the receipt they paid for.
      //
      // This is the atrun lesson on the money path: a callback answer is the one
      // channel with a DEADLINE, so it carries the ACKNOWLEDGEMENT and the RESULT
      // arrives as a message, which has none. The buyer already has the
      // "Running your order" toast above; fulfilment posts its own receipt.
      // .catch is belt-and-braces: runFulfilment already swallows everything,
      // and an unhandled rejection with nobody awaiting it ends the process.
      runFulfilment(ctx, order, adminFree).catch(() => {});
      return;
    }

    // Not there on the first look — which is ORDINARY: the transfer is usually
    // still confirming. The buyer is already holding the checking_payment toast,
    // and its copy has always promised "We'll confirm here automatically". That
    // sentence was true of the intent and false of the implementation, because
    // the waiting happened where it froze the bot. Now it is what actually runs.
    watchPayment(ctx, order, address).catch(() => {});
    return;
  } catch (e) {
    log.error(`[pay] confirm failed order=${order && order.id}: ${e.message}`);
    await toast(ctx, tpl.render("payment_snag", { order: order && order.id }));
  }
}

// Orders whose payment is being WATCHED right now, off the tap. Kept until the
// fulfilment it triggers has finished too, so a tap at any point in the run is
// answered "still checking" rather than starting a second one.
const verifying = new Set();

/**
 * Wait for a payment that had not landed when the buyer tapped, off the polling
 * loop, and carry the order the rest of the way.
 *
 * Bounded by PAYMENT_TIMEOUT_MS, and NOT the last line of defence: recovery.js
 * re-checks every pending order every 10 minutes for a day, so a transfer that
 * arrives after this gives up is still credited, swept and fulfilled. This only
 * decides how fast the buyer hears — not whether they are served.
 *
 * Never throws: it is the detached tail of a handler that has returned, so an
 * exception here has nowhere to go but the process.
 */
async function watchPayment(ctx, order, address) {
  if (verifying.has(order.id)) {
    log.warn(`[pay] order ${order.id} is already being watched — ignoring the repeat`);
    return;
  }
  verifying.add(order.id);
  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
  try {
    const r = await verify.verifyPayment(order.chain, address, order.amountSmallest, {
      timeout: PAYMENT_TIMEOUT_MS,
    });
    if (!r.paid) {
      // Says what it IS — an unfunded order — and not that the buyer did
      // something wrong: recovery.js is still watching this address for a day.
      log.info(`[pay] order ${order.id} still unfunded after ${secs()}s — recovery.js keeps watching`);
      const menu = require("../handlers/menu");
      await toast(
        ctx,
        premium.ensureCode(
          tpl.render("payment_not_detected", {
            amount: order.humanAmount,
            native: order.native,
            address,
            order: order.id,
          }),
          address,
        ),
        menu.copyAddress(address),
      ).catch(() => {});
      return;
    }
    await orders.setStatus(order.id, "paid").catch(() => {});
    log.info(`[pay] order ${order.id} funded after ${secs()}s (watched off the tap)`);
    await runFulfilment(ctx, order, false);
  } catch (e) {
    log.error(`[pay] watch FAILED order=${order && order.id} after ${secs()}s: ${e.message}`);
    await toast(ctx, tpl.render("payment_snag", { order: order && order.id })).catch(() => {});
  } finally {
    verifying.delete(order.id);
  }
}

// Orders being fulfilled right now. The session flag cannot do this job: it is
// cleared when the handler returns, which is now BEFORE fulfilment finishes, so
// a second tap would start a second run of a paid order. Same guard, same
// reason, as atRunBusy on the slow ⚡ Run now button.
const fulfilling = new Set();


/**
 * Tell the operator when a paid order was slow — the detector that did not
 * exist.
 *
 * Detaching fulfilment from the 120s handlerTimeout removed the FAILURE; it
 * also removed the only thing that had ever reported one, because that timeout
 * was what put a line in the ops channel. Every round of "bot lelet merespon"
 * in this repo was detected by a person waiting on a screen and counting, and
 * nothing anywhere ever said "the last order took 148 seconds".
 *
 * It names the PHASES, because a duration alone sends nobody anywhere: the
 * whole point of the [fulfil] timing line is that "media=48s emoji=31s" is
 * actionable and "took 148s" is not. Through log.alert, which de-duplicates —
 * a busy hour of Diamond listings must not become a channel nobody reads.
 *
 * A FAILED order already alerts: log.error reaches ERROR_CHANNEL. This is the
 * other half — the order that worked, slowly, and told nobody.
 */
function slowOrderAlert(order, ms, detail) {
  if (ms < FULFIL_SLOW_MS) return;
  const phases = detail && detail.phases && detail.phases.length ? detail.phases.join(" ") : "";
  log.alert(
    `🐌 <b>Slow order</b> — ${escapeHtml(String(order.kind))} took <b>${(ms / 1000).toFixed(1)}s</b>\n` +
      `<b>Order:</b> <code>${escapeHtml(String(order.id))}</code>\n` +
      (phases ? `<b>Phases:</b> <code>${escapeHtml(phases)}</code>\n` : "") +
      `The buyer waited this long for their receipt. Nothing failed.`,
  );
}

/**
 * Run a paid order to completion, off the callback deadline.
 *
 * Never throws: it is already the detached tail of a handler that has returned,
 * so an exception here has nowhere to go but the process.
 */
async function runFulfilment(ctx, order, adminFree) {
  if (fulfilling.has(order.id)) {
    log.warn(`[pay] order ${order.id} is already being fulfilled — ignoring the repeat`);
    return;
  }
  fulfilling.add(order.id);
  const t0 = Date.now();
  try {
    const { fulfillOrder } = require("../fulfillment");
    const detail = await fulfillOrder(ctx, order);
    await orders.setStatus(order.id, "fulfilled").catch(() => {});
    slowOrderAlert(order, Date.now() - t0, detail);
    const u = ctx.from || {};
    const usernameTag = u.username
      ? `@${u.username}`
      : order.buyerUsername
        ? `@${order.buyerUsername}`
        : "(none)";
    const fullName = `${u.first_name || ""} ${u.last_name || ""}`.trim();
    const amountLine = adminFree
      ? "FREE (admin)"
      : `${order.humanAmount} ${order.native} <i>(${order.amountSmallest} units)</i>`;
    log.report(
      `💸 <b>Service Purchased</b>\n` +
        `<b>User ID:</b> <code>${order.buyerId}</code>\n` +
        `<b>Username:</b> ${escapeHtml(usernameTag)}\n` +
        `<b>Full Name:</b> ${escapeHtml(fullName || "(none)")}\n` +
        `<b>Service:</b> ${escapeHtml(serviceLabel(order.kind))}\n` +
        `<b>Plan:</b> ${escapeHtml(order.label || "-")}\n` +
        `<b>Chain:</b> ${String(order.chain).toUpperCase()}\n` +
        `<b>Amount:</b> ${amountLine}\n` +
        `<b>Order:</b> <code>${order.id}</code>\n` +
        `<b>Date:</b> ${new Date().toISOString()}`,
    );
    log.info(`[fulfil] order ${order.id} (${order.kind}) delivered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    // The buyer has PAID and is holding a "hang tight" toast, so silence here is
    // the worst outcome. Say so, name the order, and leave it 'paid' rather than
    // 'fulfilled' so recovery.js can pick it up.
    log.error(`[pay] fulfil FAILED order=${order && order.id} after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message}`);
    await toast(ctx, tpl.render("payment_snag", { order: order && order.id })).catch(() => {});
  } finally {
    fulfilling.delete(order.id);
  }
}

module.exports = { armPayment, confirmPayHandler, newOrderId, humanWithSymbol };
