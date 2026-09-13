// Shared "choose a network → arm payment → render the pay card" step used by
// every flow. The pay card text is an editable template (pay_card /
// pay_card_admin); the picker is pay_pick.
const { Markup } = require("telegraf");
const { armPayment } = require("../payments/payment");
const { addAmount, subAmount, toSmallest } = require("../payments/units");
const orders = require("../payments/orders");
const { sendCard, answer, toast } = require("../helpers/message");
const { payOptionsFor, optionFor, networkLabel } = require("../config/payOptions");
const log = require("../helpers/logger");
const menu = require("./menu");
const premium = require("../premium");
const tpl = require("../templates");

/**
 * ⚠️ THE NETWORK LINE IS ENFORCED HERE, NOT TRUSTED TO THE TEMPLATE.
 *
 * Same reason the address and the amount are — "enforced here rather than
 * trusted to the template's backticks, which a re-saved card loses". An
 * operator who edited `pay_card` in @dexvraadminbot keeps THEIR copy for ever
 * (data/templates.json wins over the code default), so a card saved before this
 * shipped would render no network at all — and the two ETH options settle on
 * different chains behind the same `0x` address shape. That is the one line on
 * this card whose absence costs a buyer their money, so it is appended when the
 * rendered text does not already carry it.
 *
 * Appended at the END, which is what makes it safe: Telegram entity offsets are
 * UTF-16 code units counted from the start, so nothing already in the payload
 * moves. The `html` shape is handled separately because entities do not apply.
 *
 * ⚠️ THE "ALREADY THERE" TEST IS THE RENDERED PHRASE, NEVER A BARE MENTION.
 * `text.includes("Ethereum")` is satisfied by an operator card that happens to
 * say "we accept Ethereum, Solana and BNB" — a sentence that names no network
 * for THIS order and suppressed the enforced line completely. `Network: <name>`
 * is what the template emits, so it is the only thing that proves the line is
 * on the card.
 */
function ensureNetwork(payload, network) {
  if (!payload || typeof payload !== "object" || !network) return payload;
  const said = `Network: ${network}`;
  // Bold the "Network: <name>" run so it reads as the instruction it is.
  const block = {
    text: `🔗 ${said} — send on this network only.`,
    html: `🔗 <b>${said}</b> — send on this network only.`,
    entities: [{ type: "bold", offset: "🔗 ".length, length: said.length }],
  };
  return premium.appendBlock(payload, block, { seen: said });
}

/** Render the network picker for an order that can settle on more than one. */
async function askNetwork(ctx, order, options) {
  // Stashed whole: the flow that built this order has moved on by the time the
  // tap lands, and rebuilding it from the form would be a second owner of what
  // the buyer is purchasing. It is plain data — the same shape armPayment
  // persists — so nothing here depends on a closure surviving.
  ctx.session.payPick = order;
  const rows = options.map((o) => [
    Markup.button.callback(`${o.amount} ${o.native} · ${o.label}`, `paynet_${o.chain}`),
  ]);
  await sendCard(
    ctx,
    tpl.render("pay_pick", { label: premium.sanitizeVar(order.label || order.kind) }),
    menu.withHome(rows),
  );
}

/**
 * @param order {{ kind, chain, native, humanAmount, label, payload,
 *                 prices?, payChain? }}
 *   `prices` is the package's own currency-keyed table (TIER_MAP[t].price and
 *   friends). Supplying it is what offers the buyer a choice of network; a
 *   caller that omits it — the banner flow, which has a USD picker of its own —
 *   behaves exactly as it did before this existed.
 *   `payChain` pins the choice and is set ONLY by netPick below.
 */
async function startPayment(ctx, order) {
  const options = payOptionsFor(order);
  if (options.length > 1 && !order.payChain) return askNetwork(ctx, order, options);

  // ⚠️ THE AMOUNT COMES FROM THE TABLE, NEVER FROM THE TAP. `payChain` arrives
  // as callback data the user can craft, so the option is re-derived here and a
  // chain this order may not settle on is refused rather than armed.
  const picked = order.payChain ? optionFor(order, order.payChain) : options[0];
  if (order.payChain && !picked) return toast(ctx, tpl.render("session_expired"));
  const priced = picked
    ? { ...order, chain: picked.chain, native: picked.native, humanAmount: picked.amount }
    : order;
  // ⚠️ NAMED FROM THE CHAIN BEING ARMED, never only from a picked option. With
  // no `prices` table there is nothing to pick, and `""` rendered the card's one
  // load-bearing line as "🔗 Network:  — send on this network only." — a blank
  // where the network goes, on the message that takes the money. Every caller
  // passes a table today (a test scans for it); the sixth flow added later is
  // the one this is for.
  const network = picked ? picked.label : networkLabel(priced.chain);

  const r = await armPayment(ctx, priced);
  return renderPayCard(ctx, priced, r.address, r.adminFree, network);
}

// ── The broadcast add-on, on the card that already has the address ───────────
//
// "harusnya ada fitur add broadcast setelah dpt address kaya fourtisbot" — the
// button belongs BESIDE Confirm Payment, not two screens earlier, which is also
// where the bot this was compared against puts it.
//
// ⚠️ ONE TAP, AND THERE IS NOTHING TO COMPOSE. "kalo listing ya template listing
// itu" — the broadcast IS the listing card, rendered by fulfilment from the same
// template the channel post uses. So the tap attaches it and a second tap takes
// it off; asking the buyer to write a message was a step that bought nothing and
// a whole class of problems (entity offsets on a trimmed string, a text step
// that has to run above every flow router, a /cancel with no card to return to).
//
// ⚠️ THE DEPOSIT ADDRESS MAY NEVER CHANGE. That is the whole design constraint
// and it is why the order is EDITED IN PLACE rather than re-armed:
// generateWallet() mints a fresh keypair every call, so re-arming would hand
// the buyer a second address — and a buyer who had already sent to the first
// one would have paid into a wallet this order no longer verifies against.
// Editing keeps the address, moves the amount, and verifyPayment compares the
// BALANCE at that address against the new total, so anything already sent still
// counts toward it.
const addon = require("../config/broadcastAddon");

/** The fee this ARMED order would pay, or null when it cannot take the add-on. */
const addonFee = (order) => addon.addonPriceForNative(order && order.native);

const hasBroadcast = (order) => Boolean(order && order.payload && order.payload.broadcast);

/**
 * ⚠️ THE INCLUDED LINE IS ENFORCED HERE, NOT TRUSTED TO THE TEMPLATE — the same
 * rule, and the same reason, as ensureNetwork above: `pay_card` is editable in
 * @dexvraadminbot and an operator's saved copy wins for ever. It cannot carry a
 * placeholder for this anyway, because whether the add-on is attached is a fact
 * about the ORDER rather than about the card, so appending is the mechanism and
 * not a fallback.
 *
 * The buyer is about to send a number they did not pick off a price list; the
 * card has to say why it is bigger than the tier they chose.
 *
 * ⚠️ IT TAKES A RENDERED BLOCK, NOT A SENTENCE, AND THAT IS THE FIX ITSELF.
 * "saya tidak [ada] bot message tentang broadcast" — the line used to be a
 * string typed into this file, so it appeared in no template group and an
 * operator could neither edit it nor put a premium emoji in it. It is
 * `pay_card_broadcast` / `pay_card_broadcast_admin` now, rendered whole by the
 * caller and appended whole, because a custom_emoji lives in the ENTITIES and a
 * string carries none — the rule the Mass DM attachment row paid for one
 * handler over. Two templates rather than one, because the two cards carry
 * different facts: see their comments in templates.js.
 *
 * premium.appendBlock owns the APPENDING (the offsets, the html shape, the
 * "already there" test) for all three enforced lines; this wrapper exists so
 * the call sites read as what they are.
 */
function ensureBroadcastLine(payload, block) {
  return premium.appendBlock(payload, block);
}

/**
 * Render (or re-render) the pay card for an order that is already armed.
 *
 * ⚠️ THE ADD-ON ROW IS BUILT ABOVE THE ADMIN BRANCH, NOT INSIDE THE PAID HALF.
 * "aturan walaupun 0 juga ada fitur add broadcast" — the admin card used to
 * return early, so an order armed at 0 was the one card in the bot that offered
 * fewer features than the card it stands in for. And an admin order is not a
 * dry run: the same fulfilment creates the real site row, posts to the real
 * @dexvraio and sends the real tweet, with the CHARGE waived and nothing else.
 * A feature missing from it is a feature that cannot be exercised end to end,
 * which is the one thing that card exists for.
 *
 * ⚠️ THE GATE IS UNCHANGED AND SHARED. addonFee() is still the only thing that
 * decides whether the row exists, so MASS_DM_ENABLED=0 and a currency the
 * add-on cannot price (TRX, TON) remove the button here exactly as they do on a
 * paid card — one owner for "can this order take the add-on", never a second
 * idea of it for the free path.
 */
async function renderPayCard(ctx, order, address, adminFree, network) {
  const label = premium.sanitizeVar(order.label || order.kind);
  const fee = addonFee(order);
  const on = hasBroadcast(order);
  // ⚠️ …AND THE FEE IS NAMED ONLY WHERE THERE IS ONE TO PAY. The admin card
  // quotes no price at all ("No payment needed"), so "(+2 SOL)" on a button
  // sitting under that line is a label contradicting its own sign — the buy
  // card's two ideas of "whale", in miniature. What replaces it is the sentence
  // below: with no fee on the button, nothing else would say this DM is real.
  const feeLabel = fee == null || adminFree ? null : `${fee} ${order.native}`;
  const feeSuffix = feeLabel ? ` (+${feeLabel})` : "";
  const rows =
    fee == null
      ? []
      : [
          [
            Markup.button.callback(
              on ? `✅ Broadcast added${feeSuffix} — tap to remove` : `➕ Add Broadcast to all users${feeSuffix}`,
              "bcpay",
            ),
          ],
        ];
  // ⚠️ THE ADMIN LINE NAMES THE AUDIENCE, because on a free card the fee is not
  // there to do it. The add-on queues a REAL job against the whole `/start`
  // audience with autoSend (no review) — it is not the 🧪 Test send, which goes
  // to the admins alone — and "Admin Test Order" directly above it invites
  // exactly the wrong reading. Nothing here spends silently, and 12,000 inboxes
  // is the loudest thing this bot does.
  const said = !on
    ? null
    : adminFree
      ? tpl.render("pay_card_broadcast_admin")
      : tpl.render("pay_card_broadcast", { fee: feeLabel });

  if (adminFree) {
    await sendCard(
      ctx,
      ensureBroadcastLine(tpl.render("pay_card_admin", { label }), said),
      menu.confirmPayment(null, rows),
    );
    return;
  }
  // The address (and the exact amount) are tap-to-copy: enforced here rather
  // than trusted to the template's backticks, which a re-saved card loses.
  const text = premium.ensureCode(
    ensureBroadcastLine(
      ensureNetwork(
        tpl.render("pay_card", { label, amount: order.humanAmount, native: order.native, address, network }),
        network,
      ),
      said,
    ),
    address,
    order.humanAmount,
  );
  await sendCard(ctx, text, menu.confirmPayment(address, rows));
}

/** Re-render the pending pay card from the session, after an edit. */
function redrawPending(ctx) {
  const pp = ctx.session && ctx.session.pendingPayment;
  if (!pp) return null;
  return renderPayCard(ctx, pp.order, pp.address, pp.adminFree, networkLabel(pp.order.chain));
}

/**
 * The add-on button — attach it, or take it back off, and redraw the card.
 *
 * Toggling rather than a one-way add is fourtis's own affordance ("tap to
 * remove"), and it is the only way back: the card has no other exit that leaves
 * the order armed, and re-arming to undo would mint a second deposit address.
 */
async function broadcastToggle(ctx) {
  await answer(ctx);
  const pp = ctx.session && ctx.session.pendingPayment;
  if (!pp) return toast(ctx, tpl.render("no_pending_payment"));
  const order = pp.order;
  // Re-checked at the TAP: a pay card left open in the chat outlives a restart
  // that switched MASS_DM_ENABLED off under it, and a fee that is gone must not
  // be charged or refunded off a stale button.
  const fee = addonFee(order);
  if (fee == null) return redrawPending(ctx);

  const on = hasBroadcast(order);
  const payload = { ...(order.payload || {}) };
  if (on) delete payload.broadcast;
  else payload.broadcast = true; // the CONTENT is the listing card, built at fulfilment
  order.payload = payload;
  order.humanAmount = on ? subAmount(order.humanAmount, fee) : addAmount(order.humanAmount, fee);
  // ⚠️ An admin test order is FREE and stays free: re-deriving the smallest
  // unit from the new total would put a real price on a card that says "no
  // payment needed", and confirmPayHandler would then verify against it.
  if (!pp.adminFree) order.amountSmallest = toSmallest(order.chain, order.humanAmount).toString();
  await orders.saveOrder(order).catch((e) => log.warn(`[pay] saveOrder (add-on): ${e.message}`));
  return redrawPending(ctx);
}

/** `paynet_<chain>` — the buyer picked a network. */
async function netPick(ctx) {
  await answer(ctx);
  const order = ctx.session && ctx.session.payPick;
  if (!order) return toast(ctx, tpl.render("session_expired"));
  const chain = ctx.match[1];
  // Checked HERE as well as on the arming path, and the difference is what the
  // buyer keeps: refusing before the stash is spent leaves their pending choice
  // intact, so a stale tap on an older picker card costs them nothing. The
  // arming guard below is what makes a crafted chain unspendable; this one is
  // what makes a stray one harmless.
  if (!optionFor(order, chain)) return toast(ctx, tpl.render("session_expired"));
  ctx.session.payPick = null; // spent — a second tap must not re-arm the order
  await startPayment(ctx, { ...order, payChain: chain });
}

module.exports = {
  broadcastToggle,
  renderPayCard,
  startPayment, netPick, ensureNetwork, ensureBroadcastLine };
