// "harusnya ada fitur add broadcast setelah dpt address kaya fourtisbot" — the
// broadcast add-on sits on the PAY CARD, beside Confirm Payment, on the card
// that already carries the deposit address.
//
// ⚠️ WHICH MAKES THE ADDRESS THE WHOLE DESIGN CONSTRAINT. generateWallet()
// mints a fresh keypair on every call, so re-arming the order would hand the
// buyer a SECOND address — and a buyer who had already sent to the first would
// have paid into a wallet this order no longer verifies against. The order is
// edited in place instead: same address, new total, and verifyPayment compares
// the BALANCE there against it, so what was already sent still counts.
//
// "no need approve … intinya automatic broadcastnya dan kalo listing ya
// template listing itu" — so it is ONE TAP (nothing to compose), the content is
// the LISTING CARD, and it sends itself. The three rules that survive from the
// first cut: the fee is MASS_DM_PRICE itself (one table, two products), it is
// charged in the order's OWN currency (`order.native` — by the pay card a
// Robinhood buyer may have picked either ETH rail), and a currency the add-on
// cannot price is never offered the button.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-bcaddon-"));

const test = require("node:test");
const assert = require("node:assert");

const { addAmount, subAmount, toSmallest } = require("../src/payments/units");
const addon = require("../src/config/broadcastAddon");
const { TIER_MAP } = require("../src/config/packages");
const { MASS_DM_PRICE } = require("../src/config/constants");
const pay = require("../src/handlers/pay");
const wallets = require("../src/payments/wallets");
const orders = require("../src/payments/orders");
const tpl = require("../src/templates");

const XPRESS = TIER_MAP.XPRESS.price;

// ── the money arithmetic ────────────────────────────────────────────────────

test("⚠️ two package prices add EXACTLY, not in float", () => {
  // The case that produced addAmount: Platinum on BSC (1.15) + a 0.15 fee.
  assert.strictEqual(1.15 + 0.15, 1.2999999999999998, "if this ever stops being true, delete addAmount");
  assert.strictEqual(addAmount(1.15, 0.15), 1.3);
  assert.strictEqual(addAmount(0.06, 0.05), 0.11);
  assert.strictEqual(addAmount(2.8, 0.15), 2.95);
  assert.strictEqual(addAmount(1, 2), 3);
  assert.strictEqual(addAmount(900, 0.15), 900.15);
});

// ⚠️ THE TOGGLE IS WHY THIS EXISTS. Removing the add-on has to land back on the
// package's own listed price to the digit, and `1.3 - 0.15` is
// 1.1500000000000001 — a number in no price table, on the card that takes the
// money.
test("⚠️ …and taking the add-on back off lands on the listed price EXACTLY", () => {
  assert.strictEqual(1.3 - 0.15, 1.1500000000000001, "if this ever stops being true, delete subAmount");
  assert.strictEqual(subAmount(1.3, 0.15), 1.15);
  for (const [base, fee] of [[1.15, 0.15], [0.06, 0.1], [1, 2], [5, 2], [0.26, 0.1], [900, 0.15]]) {
    assert.strictEqual(subAmount(addAmount(base, fee), fee), base, `${base} + ${fee} - ${fee}`);
  }
});

// ⚠️ The SHIPPED DEFAULT, read out of the SOURCE rather than off the resolved
// constant: an operator's bot/.env beats the code default, so asserting the
// resolved value would go red on their box for a reason that has nothing to do
// with the code. And a price is a business fact — moving it should be a
// deliberate line in a diff.
test("the shipped fee is the FULL Mass DM price — the launch discount is gone", () => {
  const src = fss.readFileSync(require.resolve("../src/config/constants.js"), "utf8");
  const block = src.slice(src.indexOf("const MASS_DM_PRICE"), src.indexOf("MASS_DM_REVIEW_CHAT_ID"));
  assert.ok(block.length > 50, "MASS_DM_PRICE not found — this scan proves nothing");
  assert.match(block, /MASS_DM_PRICE_SOL\) \|\| 2/, "SOL: 2");
  assert.match(block, /MASS_DM_PRICE_BNB\) \|\| 0\.3/, "BNB: 0.3");
  assert.match(block, /MASS_DM_PRICE_ETH\) \|\| 0\.1/, "ETH: 0.1");
});

// ⚠️ THE PRICE WAS GUARDED AND THE SENTENCE ABOUT THE PRICE WAS NOT, so the
// test above passed for the whole deploy while the Mass DM card advertised
// "Flat price — 50% off" over the FULL price: the three figures beside it are
// placeholders fed from MASS_DM_PRICE and therefore live, and the words were
// frozen. A discount is a CLAIM about a number, so it belongs where the number
// comes from — a placeholder — never typed into copy that cannot move with it.
// Scans the DEFAULT VALUES rather than the source, so a comment recording the
// withdrawn discount (constants.js says so at MASS_DM_PRICE) is not caught.
test("no template default freezes a discount claim in its copy", () => {
  const keys = Object.keys(tpl.DEFAULTS);
  assert.ok(keys.length > 100, `only ${keys.length} defaults scanned — this proves nothing`);
  // A LITERAL percentage beside a discount word, in either order. The figure is
  // what has to be able to move, so `{discount}% renewal discount` in
  // upsell_expiry is fine and MUST stay fine — its number is a placeholder, fed
  // from the code that applies it. That is the whole rule, and the first cut of
  // this scan matched the WORD and flagged it, which would have taught the next
  // reader that a computed discount is the thing being forbidden.
  const W = "(off|discount|diskon)";
  const N = "\\d[\\d.]*\\s*%";
  const frozen = new RegExp(`${N}[^\n]{0,16}\\b${W}\\b|\\b${W}\\b[^\n]{0,16}${N}`, "i");
  const bad = keys.filter((k) => frozen.test(tpl.DEFAULTS[k]));
  assert.deepStrictEqual(bad, [], `these assert a discount the code cannot move: ${bad.join(", ")}`);
  // …and the scan can see the real one, while leaving the computed one alone.
  assert.ok(frozen.test("**Flat price — 50% off** (charged in your token's chain)"), "blind to the reported defect");
  assert.ok(!frozen.test("a **{discount}% renewal discount** is already applied below:"), "a computed discount is not frozen");
});

test("the fee IS the Mass DM price, never a second table", () => {
  assert.strictEqual(addon.addonPriceForNative("SOL"), MASS_DM_PRICE.SOL);
  assert.strictEqual(addon.addonPriceForNative("BNB"), MASS_DM_PRICE.BNB);
  assert.strictEqual(addon.addonPriceForNative("ETH"), MASS_DM_PRICE.ETH);
  const src = fss.readFileSync(require.resolve("../src/config/broadcastAddon.js"), "utf8");
  assert.match(src, /MASS_DM_PRICE/, "the add-on must read the Mass DM price");
  assert.ok(
    !/=\s*\{\s*SOL\s*:\s*[\d.]/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")),
    "a private price table here would be a second price for one product",
  );
});

test("⚠️ a currency the add-on cannot price gets no fee at all", () => {
  // MASS_DM_PRICE has SOL, BNB and ETH only. A Tron order settles in TRX and a
  // TON order in TON, so there is nothing to charge in the coin those orders
  // actually pay in — and a second coin is what this payment path forbids.
  assert.strictEqual(addon.addonPriceForNative("TRX"), null);
  assert.strictEqual(addon.addonPriceForNative("TON"), null);
  assert.strictEqual(addon.addonPriceForNative(undefined), null);
});

// ── the pay card, driven ────────────────────────────────────────────────────

const ADDR = "GETjVBRPYtssumNhU9zBvqtNtLWMSCPu8rzVyvqcWfPk";

// ⚠️ ADMIN_IDS is resolved at REQUIRE time, so `process.env.ADMIN_IDS = "9"`
// inside a test does nothing at all — an "admin" order armed that way is an
// ordinary one, and every assertion about the free card would be measuring the
// paid card. A BUILT-IN owner id is admin by the time this file loads, so the
// identity is what makes the order free, driven through the real isAdminUser.
const ADMIN_FROM = { id: 1322401802, username: "owner" };

const mkCtx = (from = { id: 9, username: "buyer" }) => {
  const sent = [];
  return {
    sent,
    from,
    chat: { id: from.id, type: "private" },
    session: {},
    answerCbQuery: async () => true,
    reply: async (text, extra) => {
      sent.push({ text: String(typeof text === "object" ? text.text || text.html : text), extra: extra || {} });
      return { message_id: sent.length };
    },
    telegram: { deleteMessage: async () => {} },
  };
};
const buttons = (ctx) => {
  const last = ctx.sent[ctx.sent.length - 1] || {};
  const rows = (last.extra.reply_markup || {}).inline_keyboard || [];
  return rows.flat().map((b) => b.text);
};
const lastText = (ctx) => (ctx.sent[ctx.sent.length - 1] || {}).text || "";

const order = (over = {}) => ({
  kind: "xpress_listing",
  chain: "solana",
  native: "SOL",
  humanAmount: XPRESS.SOL,
  prices: XPRESS,
  label: "Xpress Listing — $HOLYFROG on Solana",
  payload: { listingInput: { chain: "solana", address: "So1111", sym: "HOLYFROG", name: "Holy Frog" }, trendHours: 0 },
  ...over,
});

/** Arm an order for real, with the wallet and the store stubbed out. */
async function arm(o, { admin = false } = {}) {
  const ctx = mkCtx(admin ? ADMIN_FROM : undefined);
  const realW = wallets.generateWallet;
  const realS = orders.saveOrder;
  let wallets_made = 0;
  wallets.generateWallet = async () => {
    wallets_made += 1;
    return { address: ADDR };
  };
  orders.saveOrder = async () => {};
  try {
    await pay.startPayment(ctx, o);
  } finally {
    wallets.generateWallet = realW;
    orders.saveOrder = realS;
  }
  return {
    ctx,
    walletsMade: () => wallets_made,
    restubWallet: () => {
      wallets.generateWallet = async () => {
        wallets_made += 1;
        return { address: "SECOND_ADDRESS" };
      };
      return () => (wallets.generateWallet = realW);
    },
  };
}

test("the pay card offers the add-on, with its fee on the button", async () => {
  const { ctx } = await arm(order());
  const row = buttons(ctx).find((t) => /Broadcast/.test(t));
  assert.ok(row, "a SOL order must be offered the add-on");
  assert.ok(row.includes(`${MASS_DM_PRICE.SOL} SOL`), `the fee is on the button: ${row}`);
  assert.ok(buttons(ctx).some((t) => /Confirm/.test(t)), "…beside Confirm, not instead of it");
  assert.match(lastText(ctx), new RegExp(String(XPRESS.SOL)), "the card still quotes the listing price alone");
  assert.ok(!/Includes a Mass DM Broadcast/.test(lastText(ctx)), "…and claims nothing it has not added");
});

test("⚠️ a Tron order's card carries NO such button", async () => {
  const { ctx } = await arm(order({ chain: "tron", native: "TRX", humanAmount: XPRESS.TRX }));
  assert.ok(!buttons(ctx).some((t) => /Broadcast/.test(t)), "a button whose only outcome is a refusal is not a button");
});

test("⚠️ adding it does NOT change the deposit address", async () => {
  const a = await arm(order());
  const { ctx } = a;
  const before = ctx.session.pendingPayment.address;
  const undo = a.restubWallet(); // any re-arm from here would mint SECOND_ADDRESS
  try {
    await pay.broadcastToggle(ctx);
  } finally {
    undo();
  }
  assert.strictEqual(ctx.session.pendingPayment.address, before, "the address a buyer may already have sent to");
  assert.strictEqual(before, ADDR);
  assert.strictEqual(a.walletsMade(), 1, "exactly one wallet was ever minted for this order");
});

test("…and the total, the smallest-unit amount and the card all move together", async () => {
  const { ctx } = await arm(order());
  await pay.broadcastToggle(ctx);
  const o = ctx.session.pendingPayment.order;
  const total = addAmount(XPRESS.SOL, MASS_DM_PRICE.SOL);
  assert.strictEqual(o.humanAmount, total);
  assert.strictEqual(o.amountSmallest, toSmallest("solana", total).toString(), "what verifyPayment compares against");
  assert.strictEqual(o.payload.broadcast, true, "a marker — the CONTENT is built at fulfilment from the listing");
  assert.match(lastText(ctx), new RegExp(String(total)), "the redrawn card quotes the new total");
});

// ⚠️ The buyer is about to send a number they did not pick off a price list. The
// card has to say why it is bigger than the tier they chose — and `pay_card` is
// editable in @dexvraadminbot, so it is appended rather than trusted.
test("⚠️ the card SAYS the broadcast is in the price", async () => {
  const { ctx } = await arm(order());
  await pay.broadcastToggle(ctx);
  assert.match(lastText(ctx), /Includes a Mass DM Broadcast to all users \(\+2 SOL\)/);
});

test("⚠️ …even over an operator's own saved card, which carries no such line", () => {
  const saved = pay.ensureBroadcastLine(
    { text: "Pay me 3 SOL", entities: [] },
    require("../src/templates").render("pay_card_broadcast", { fee: "2 SOL" }),
  );
  assert.match(saved.text, /Includes a Mass DM Broadcast to all users \(\+2 SOL\)/);
  const bold = saved.entities.find((e) => e.type === "bold");
  assert.ok(bold, "the line is bolded so it reads as part of the price");
  assert.strictEqual(
    saved.text.slice(bold.offset, bold.offset + bold.length),
    "Includes a Mass DM Broadcast to all users (+2 SOL)",
    "⚠️ an entity offset that lands off the words is markup on the wrong run",
  );
  assert.strictEqual(pay.ensureBroadcastLine({ text: "x", entities: [] }, null).text, "x", "nothing added when nothing is attached");
});

// "saya tidak [ada] bot message tentang broadcast" — an operator went looking
// through 📝 Templates for the sentence they can see on their own pay card and
// it was not there: it was a string inside pay.js, so it belonged to no group,
// could not be edited, and could not carry a premium emoji. Both halves are
// pinned here — that the editor LISTS them, and that the card renders THEM
// rather than a sentence of its own.
test("⚠️ the broadcast line is a TEMPLATE an operator can find and edit", async () => {
  const tplMod = require("../src/templates");
  for (const key of ["pay_card_broadcast", "pay_card_broadcast_admin"]) {
    assert.ok(tplMod.keys().includes(key), `${key} is not in the editor at all`);
    assert.notStrictEqual(tplMod.meta(key).label, key, `${key} shows its raw key in the editor`);
    assert.strictEqual(tplMod.meta(key).group, "Bot Messages", `${key} is filed away from the pay card`);
  }

  // Driven, not asserted about: a template nothing renders is a template the
  // operator edits and never sees change — the curveBuyPath scar.
  await tplMod.setTemplate("pay_card_broadcast", "📣 Operator wording, {fee} included.");
  try {
    const { ctx } = await arm(order());
    await pay.broadcastToggle(ctx);
    assert.match(lastText(ctx), /Operator wording, 2 SOL included\./, "the card ignores the operator's copy");
  } finally {
    await tplMod.resetTemplate("pay_card_broadcast");
  }
});

// ⚠️ …AND A PREMIUM EMOJI PASTED INTO IT SURVIVES. A custom_emoji lives in the
// ENTITIES, so a line built from a plain string flattens it to its fallback
// glyph — which is exactly what the old code did, silently, on the card that
// takes the money.
test("⚠️ a premium emoji pasted into the broadcast line reaches the card", async () => {
  const tplMod = require("../src/templates");
  await tplMod.setTemplate("pay_card_broadcast", {
    text: "⚡ Broadcast included — {fee}.",
    entities: [{ type: "custom_emoji", offset: 0, length: 1, custom_emoji_id: "5771234567890123456" }],
  });
  try {
    const { ctx } = await arm(order());
    await pay.broadcastToggle(ctx);
    const sent = ctx.sent[ctx.sent.length - 1];
    const ents = (sent && sent.extra && sent.extra.entities) || [];
    const em = ents.find((e) => e.type === "custom_emoji");
    assert.ok(em, "the premium emoji was flattened to its fallback glyph");
    assert.strictEqual(
      sent.text.slice(em.offset, em.offset + em.length),
      "⚡",
      "⚠️ an entity offset that lands off the glyph is markup on the wrong run",
    );
  } finally {
    await tplMod.resetTemplate("pay_card_broadcast");
  }
});

test("the button says it is attached, and offers the way back", async () => {
  const { ctx } = await arm(order());
  await pay.broadcastToggle(ctx);
  const row = buttons(ctx).find((t) => /Broadcast/.test(t));
  assert.match(row, /tap to remove/, "the card has no other exit that leaves the order armed");
  assert.ok(!/Add Broadcast/.test(row), "nothing may be charged for twice");
});

test("⚠️ a second tap takes it back off, exactly", async () => {
  const a = await arm(order());
  const { ctx } = a;
  await pay.broadcastToggle(ctx);
  const undo = a.restubWallet();
  try {
    await pay.broadcastToggle(ctx);
  } finally {
    undo();
  }
  const o = ctx.session.pendingPayment.order;
  assert.strictEqual(o.humanAmount, XPRESS.SOL, "back to the package's own listed price");
  assert.strictEqual(o.amountSmallest, toSmallest("solana", XPRESS.SOL).toString());
  assert.ok(!o.payload.broadcast, "and nothing is queued for it");
  assert.strictEqual(ctx.session.pendingPayment.address, ADDR, "…still the same deposit address");
  assert.strictEqual(a.walletsMade(), 1);
  assert.ok(!/Includes a Mass DM Broadcast/.test(lastText(ctx)), "the card stops claiming it");
  assert.ok(buttons(ctx).some((t) => /Add Broadcast/.test(t)), "…and offers it again");
});

// ── the FREE card: "aturan walaupun 0 juga ada fitur add broadcast" ─────────
//
// The admin branch of renderPayCard used to return early, so an order armed at
// 0 was the one card in the bot offering fewer features than the card it stands
// in for. And an admin order is not a dry run — the same fulfilment creates the
// real site row, posts to the real @dexvraio and sends the real tweet, with the
// CHARGE waived and nothing else — so a feature missing from it is a feature
// that cannot be exercised end to end, which is what that card is for.

test("⚠️ the FREE admin card offers the add-on too — the ask", async () => {
  const { ctx } = await arm(order(), { admin: true });
  assert.strictEqual(ctx.session.pendingPayment.adminFree, true, "this test proves nothing on a paid card");
  assert.strictEqual(ctx.session.pendingPayment.order.amountSmallest, "0");
  const row = buttons(ctx).find((t) => /Broadcast/.test(t));
  assert.ok(row, `the free card must carry the button too: ${JSON.stringify(buttons(ctx))}`);
  assert.ok(buttons(ctx).some((t) => /Confirm/.test(t)), "…beside Confirm, as on the paid card");
});

// ⚠️ The fee is named only where there is one to pay. "(+2 SOL)" on a button
// under "No payment needed" is a label contradicting its own sign.
test("⚠️ …with NO fee on it, because that card quotes no price at all", async () => {
  const { ctx } = await arm(order(), { admin: true });
  const row = buttons(ctx).find((t) => /Broadcast/.test(t));
  assert.ok(!/\+/.test(row), `a price on a free card: ${row}`);
  assert.ok(!row.includes(String(MASS_DM_PRICE.SOL)), row);
  assert.ok(!lastText(ctx).includes(String(XPRESS.SOL)), "…and the card itself still quotes nothing");
});

// ⚠️ THE GATE IS THE SAME ONE. addonFee() is still what decides, so
// MASS_DM_ENABLED=0 and a currency the add-on cannot price remove the button
// here exactly as they do on a paid card — never a second idea of it.
test("⚠️ a Tron admin order still gets no button", async () => {
  const { ctx } = await arm(order({ chain: "tron", native: "TRX", humanAmount: XPRESS.TRX }), { admin: true });
  assert.strictEqual(ctx.session.pendingPayment.adminFree, true);
  assert.ok(!buttons(ctx).some((t) => /Broadcast/.test(t)));
});

test("⚠️ the free card's tap attaches it, and the order stays free", async () => {
  const a = await arm(order(), { admin: true });
  const { ctx } = a;
  const undo = a.restubWallet(); // any re-arm from here would mint SECOND_ADDRESS
  try {
    await pay.broadcastToggle(ctx);
  } finally {
    undo();
  }
  const o = ctx.session.pendingPayment.order;
  assert.strictEqual(o.payload.broadcast, true, "the marker fulfilment reads");
  // ⚠️ Re-deriving the smallest unit from the new total would put a real price
  // on a card that says "no payment needed", and confirmPayHandler verifies
  // against exactly this field.
  assert.strictEqual(o.amountSmallest, "0", "the admin card still takes nothing");
  assert.strictEqual(ctx.session.pendingPayment.address, ADDR, "…and the deposit address never moved");
  assert.strictEqual(a.walletsMade(), 1);
  assert.match(buttons(ctx).find((t) => /Broadcast/.test(t)), /tap to remove/, "…and offers the way back");
});

// ⚠️ WITH NO FEE ON THE BUTTON, NOTHING ELSE WOULD SAY THIS DM IS REAL. The
// add-on queues a job against the whole /start audience with autoSend (no
// review) — it is not the 🧪 Test send, which goes to the admins alone — and
// "Admin Test Order" directly above it invites exactly the wrong reading.
test("⚠️ …and the free card SAYS the broadcast really goes out", async () => {
  const { ctx } = await arm(order(), { admin: true });
  await pay.broadcastToggle(ctx);
  const text = lastText(ctx);
  assert.match(text, /Includes a Mass DM Broadcast/);
  assert.match(text, /every bot user/, `the audience is the warning here: ${text}`);
  assert.match(text, /not a test send/);
});

test("⚠️ a second tap takes it off the free card too, and it says so", async () => {
  const { ctx } = await arm(order(), { admin: true });
  await pay.broadcastToggle(ctx);
  await pay.broadcastToggle(ctx);
  const o = ctx.session.pendingPayment.order;
  assert.ok(!o.payload.broadcast, "nothing is queued for it");
  assert.strictEqual(o.humanAmount, XPRESS.SOL, "back to the package's own listed price");
  assert.strictEqual(o.amountSmallest, "0");
  assert.ok(!/Includes a Mass DM Broadcast/.test(lastText(ctx)), "the card stops claiming it");
  assert.ok(buttons(ctx).some((t) => /Add Broadcast/.test(t)), "…and offers it again");
});

test("⚠️ the tap is re-checked, not trusted to the card that offered it", async () => {
  // A pay card left open in the chat outlives a restart that turned the product
  // off — and a fee that is gone must not be charged, or refunded, off a stale
  // button.
  const { ctx } = await arm(order());
  const real = addon.addonPriceForNative;
  addon.addonPriceForNative = () => null;
  try {
    await pay.broadcastToggle(ctx);
  } finally {
    addon.addonPriceForNative = real;
  }
  const o = ctx.session.pendingPayment.order;
  assert.strictEqual(o.humanAmount, XPRESS.SOL, "nothing added");
  assert.ok(!o.payload.broadcast);
});

test("⚠️ with no pending payment it says so rather than doing nothing", async () => {
  const ctx = mkCtx();
  await pay.broadcastToggle(ctx);
  assert.ok(ctx.sent.length, "a tap that goes nowhere is a dead button");
});

// ⚠️ THE COMPOSE STEP IS GONE, and this is the behavioural proof rather than a
// scan for its absence: the routers used to swallow the next message in the chat
// while a pay card was open. A buyer typing anything at all must now reach the
// ordinary handling instead.
test("⚠️ an armed pay card no longer swallows the next message", async () => {
  const text = require("../src/handlers/text");
  const { ctx } = await arm(order());
  assert.ok(!ctx.session.type, "an armed pay card carries no flow type of its own");
  ctx.message = { text: "gm", entities: [] };
  await text.textRouter(ctx);
  assert.ok(!ctx.session.pendingPayment.order.payload.broadcast, "nothing attaches itself from a chat message");
  ctx.message = { photo: [{ file_id: "P9" }], caption: "gm", caption_entities: [] };
  await text.mediaRouter(ctx);
  assert.ok(!ctx.session.pendingPayment.order.payload.broadcast);
});

// ⚠️ `tpl.meta()` SYNTHESISES `{group:"Other"}` for any key at all, so it can
// never answer this — the assertion it was first written with was vacuous in
// BOTH directions. `keys()` is what the admin bot's template editor lists.
test("templates render and are editable in the admin bot", () => {
  const listed = new Set(tpl.keys());
  for (const k of ["broadcast_addon_sending", "broadcast_addon_queued", "broadcast_addon_failed"]) {
    assert.ok(listed.has(k), `${k} must be a real template or no admin can edit it`);
    assert.strictEqual(tpl.meta(k).group, "Mass DM", `${k} must be grouped, or it is unfindable in the editor`);
  }
  assert.match(tpl.render("broadcast_addon_sending", { ref: "MD-7" }).text, /MD-7/);
  // The compose step is gone; a template for a step that no longer exists is a
  // row the engine ignores, still editable by an operator who will never see it.
  for (const k of ["broadcast_addon_prompt", "broadcast_addon_attached", "broadcast_addon_unavailable"]) {
    assert.ok(!listed.has(k), `${k} belongs to the compose step that was deleted`);
  }
});

// ── the content: the listing card itself ────────────────────────────────────

const fulfilment = require("../src/fulfillment");
const fmt = require("../src/channels/format");

const coin = () => ({
  symbol: "ACAI",
  name: "Acai",
  chain: "solana",
  address: "So11111111111111111111111111111111111111112",
  price: 1,
  mcap: 1000,
  siteUrl: "https://dexvra.io/token/solana/So1111",
});

test("⚠️ the broadcast IS the listing post, not a second wording of it", () => {
  const c = coin();
  const b = fulfilment._listingBroadcast(c, null);
  const { payloadArgs } = require("../src/helpers/message");
  const { text } = payloadArgs(fmt.listingPost(c), false);
  assert.strictEqual(b.text, text, "one owner of the wording — the listing template");
  assert.ok(b.text.length, "…and it rendered something");
});

// ⚠️ Telegram caps a media caption at 1024 UTF-16 units and THROWS past it,
// which would drop the whole DM rather than the picture.
test("⚠️ …trimmed to a caption when it rides artwork, and only then", () => {
  const c = { ...coin(), name: "A".repeat(1400) };
  const withArt = fulfilment._listingBroadcast(c, { source: Buffer.from("x") });
  const plain = fulfilment._listingBroadcast(c, null);
  assert.ok(withArt.text.length <= 1024, `caption is ${withArt.text.length}`);
  assert.ok(plain.text.length > 1024, "a text-only broadcast keeps the full 4096");
  const post = require("../src/channels/post");
  assert.strictEqual(typeof post.fitCaption, "function", "the one owner of that cut");
});

// ⚠️ postMedia returns a composited still, an admin GIF/MP4 clip, a bare file_id
// or a URL — and a clip pushed through sendPhoto is an error, not a still.
test("⚠️ the media TYPE travels with the media", () => {
  const m = fulfilment._broadcastMedia;
  assert.deepStrictEqual(m(null, "o1"), {});
  assert.deepStrictEqual(m("AgACfileid", "o1"), { mediaFileId: "AgACfileid", mediaType: "photo" });
  assert.deepStrictEqual(m({ source: "/tmp/clip.mp4", type: "animation" }, "o1"), {
    mediaPath: "/tmp/clip.mp4",
    mediaType: "animation",
  });
  assert.deepStrictEqual(m({ source: "/tmp/b.png" }, "o1"), { mediaPath: "/tmp/b.png", mediaType: "photo" });
  const buf = m({ source: Buffer.from("PNGBYTES"), type: "photo" }, "o-buf");
  assert.strictEqual(buf.mediaType, "photo");
  assert.strictEqual(fss.readFileSync(buf.mediaPath, "utf8"), "PNGBYTES", "a Buffer is written out — the job is persisted");
});

test("⚠️ …and the sender picks the method from it", () => {
  const sender = require("../src/massdm/sender");
  assert.strictEqual(sender._sendMethod({ mediaType: "animation" }), "sendAnimation");
  assert.strictEqual(sender._sendMethod({ mediaType: "video" }), "sendVideo");
  assert.strictEqual(sender._sendMethod({ mediaType: "photo" }), "sendPhoto");
  assert.strictEqual(sender._sendMethod({}), "sendPhoto", "every job before this one was a photo");
  assert.strictEqual(sender._fileIdOf({ animation: { file_id: "A1" } }, "animation"), "A1");
  assert.strictEqual(sender._fileIdOf({ video: { file_id: "V1" } }, "video"), "V1");
  assert.strictEqual(sender._fileIdOf({ photo: [{ file_id: "P0" }, { file_id: "P1" }] }, "photo"), "P1");
});

// ── the queue, DRIVEN ───────────────────────────────────────────────────────

const massStore = require("../src/massdm/store");

function stubStore(onCreate) {
  const realCreate = massStore.createJob;
  const realAud = massStore.audience;
  massStore.createJob = async (job) => {
    if (onCreate) onCreate(job);
    return { id: "job1", total: (job.targets || []).length };
  };
  massStore.audience = () => [1, 2, 3];
  return () => {
    massStore.createJob = realCreate;
    massStore.audience = realAud;
  };
}
const queueCtx = () => ({
  from: { id: 9 },
  chat: { id: 9 },
  session: {},
  telegram: { sendMessage: async () => ({}) },
  reply: async () => ({ message_id: 1 }),
});

test("a broadcast becomes a job for the whole audience", async () => {
  let seen = null;
  const restore = stubStore((j) => (seen = j));
  let r;
  try {
    r = await fulfilment.queueBroadcast(
      queueCtx(),
      { id: "ord1", buyerId: 9 },
      { text: "gm", entities: [{ type: "bold", offset: 0, length: 2 }], mediaFileId: null },
    );
  } finally {
    restore();
  }
  assert.strictEqual(r.ok, true);
  assert.ok(r.ref, "the buyer is given a ref to quote");
  assert.strictEqual(seen.text, "gm");
  assert.strictEqual(seen.test, false, "never an admin test run — this one was paid for");
  assert.deepStrictEqual(seen.targets, [1, 2, 3], "the same audience the standalone product reaches");
});

// ⚠️ THE FREE CARD'S ADD-ON REACHES THE SAME AUDIENCE, and that is the claim
// the card now makes out loud — measured here rather than asserted there. It is
// NOT the 🧪 Test send (admins alone, `test: true`): an admin order is a real
// order with the charge waived, so its broadcast is a real broadcast.
//
// ⚠️ And "included with listing package" alone would be a claim nobody measured
// on an order that paid nothing — the one line an operator reads to know what a
// DM to 12,000 inboxes cost. A source scan cannot see this: the expression still
// mentions adminFree in its OTHER branch, so it survived the mutation.
test("⚠️ an admin order's add-on is real, and reports that it was not paid for", async () => {
  const seen = [];
  const restore = stubStore((j) => seen.push(j));
  try {
    await fulfilment.queueBroadcast(queueCtx(), { id: "ordA", buyerId: 9, adminFree: true, humanAmount: 1, native: "SOL" }, { text: "gm" }, { autoSend: true });
    await fulfilment.queueBroadcast(queueCtx(), { id: "ordB", buyerId: 9, adminFree: false, humanAmount: 1, native: "SOL" }, { text: "gm" }, { autoSend: true });
  } finally {
    restore();
  }
  assert.deepStrictEqual(seen[0].targets, [1, 2, 3], "every bot user, exactly as a paid one");
  assert.strictEqual(seen[0].test, false, "not the admins-only verification run");
  assert.match(seen[0].paid, /admin/i, `an admin add-on must not read as a purchase: ${seen[0].paid}`);
  assert.ok(!/admin/i.test(seen[1].paid), `…and a real one must not read as free: ${seen[1].paid}`);
});

// ⚠️ THE BOUNDARY. `autoSend` says the BOT wrote this, and nothing wider.
test("⚠️ the standalone /massdm product still waits for a human", async () => {
  let seen = null;
  const restore = stubStore((j) => (seen = j));
  try {
    await fulfilment.fulfillMassDm(queueCtx(), { id: "ord2", buyerId: 9, payload: { text: "buy my coin", entities: [] } });
  } finally {
    restore();
  }
  assert.strictEqual(seen.autoSend, false, "free text a stranger typed, at 12,000 inboxes");
  assert.strictEqual(massStore.createJob.length >= 0, true);
});

test("⚠️ …and the store really keeps it out of the sender until then", async () => {
  // The sender polls in_progress and nothing else, so the STATUS is the gate.
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-mdstatus-"));
  const real = massStore.saveJob;
  massStore.saveJob = async () => {};
  try {
    const reviewed = await massStore.createJob({ text: "x", targets: [1] });
    const auto = await massStore.createJob({ text: "x", targets: [1], autoSend: true });
    const admin = await massStore.createJob({ text: "x", targets: [1], test: true });
    assert.strictEqual(reviewed.status, "pending_review");
    assert.strictEqual(auto.status, "in_progress");
    assert.strictEqual(auto.test, false, "an auto job is NOT an admin test — it gets its receipt");
    assert.strictEqual(admin.status, "in_progress");
  } finally {
    massStore.saveJob = real;
    fss.rmSync(dir, { recursive: true, force: true });
  }
});

test("⚠️ a queue that will not take it comes back ok:false — it never throws", async () => {
  const realCreate = massStore.createJob;
  massStore.createJob = async () => {
    throw new Error("disk full");
  };
  let r;
  try {
    r = await fulfilment.queueBroadcast(queueCtx(), { id: "ord3", buyerId: 9 }, { text: "gm" });
  } finally {
    massStore.createJob = realCreate;
  }
  // The listing is already live and the funds already swept by this point: a
  // throw here would report a delivered listing as a failed order.
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /disk full/);
  assert.ok(r.ref, "the buyer still gets a ref to quote at support");
});

// ⚠️ A POSITIVE test, because a wiring that does nothing refuses beautifully.
// An earlier cut pinned this call site with a SOURCE SCAN, and a mutation run
// walked straight past it: `if (false) {` leaves every string the scan looks
// for exactly where it was. So fulfillListing is DRIVEN.
function stubListingWorld() {
  const api = require("../src/api/dexvra");
  const post = require("../src/channels/post");
  const market = require("../src/marketdata");
  const x = require("../src/twitter");
  const br = require("../src/bannerRender");
  const bt = require("../src/bannerTemplate");
  const postids = require("../src/channels/postids");
  const te = require("../src/tokenEmoji");
  const saved = { api: { ...api }, post: { ...post }, market: { ...market }, x: { ...x } };
  const more = { br: br.renderListingBanner, bt: bt.compose, ids: postids.set, te: te.forToken };
  api.createListing = async () => ({ id: "L1", ok: true });
  api.getListings = async () => [];
  market.fetchMarket = async () => ({ priceUsd: 1, mcap: 1000, liq: 100, vol24: 10 });
  x.postTweet = async () => null;
  x.tweetListing = async () => null;
  post.sendMedia = async () => ({ message_id: 1 });
  post.send = async () => ({ message_id: 1 });
  br.renderListingBanner = async () => null;
  bt.compose = async () => null;
  postids.set = async () => {};
  te.forToken = async () => "🪙";
  return () => {
    Object.assign(api, saved.api);
    Object.assign(post, saved.post);
    Object.assign(market, saved.market);
    Object.assign(x, saved.x);
    br.renderListingBanner = more.br;
    bt.compose = more.bt;
    postids.set = more.ids;
    te.forToken = more.te;
  };
}

async function fulfilWith(broadcast) {
  const unstub = stubListingWorld();
  let queued = null;
  const restore = stubStore((j) => (queued = j));
  try {
    await fulfilment.fulfillOrder(queueCtx(), {
      id: `o${Math.random().toString(36).slice(2)}`,
      kind: "xpress_listing",
      buyerId: 9,
      chain: "solana",
      native: "SOL",
      humanAmount: broadcast ? 3 : 1,
      payload: {
        listingInput: {
          chain: "solana",
          address: "So11111111111111111111111111111111111111112",
          sym: "ACAI",
          name: "Acai",
          tier: "XPRESS",
        },
        logoFileId: null,
        trendHours: 0,
        broadcast: broadcast || null,
      },
    });
  } finally {
    restore();
    unstub();
  }
  return queued;
}

test("⚠️ a listing PAID for with a broadcast really queues one — and it SENDS", async () => {
  const q = await fulfilWith(true);
  assert.ok(q, "the buyer paid for a broadcast — it has to reach the queue");
  assert.match(q.text, /ACAI/, "the listing card, not a message anybody typed");
  assert.strictEqual(q.autoSend, true, "the bot wrote it; the channel is already showing it");
  assert.strictEqual(q.test, false, "…which is not the same thing as an admin test run");
  assert.deepStrictEqual(q.targets, [1, 2, 3]);
});

// recovery.js re-checks pending orders for a day, so an order armed before the
// add-on became one tap can still be paid across this deploy. It carries the
// buyer's own words, and those go through the review it was sold under.
test("⚠️ …but an order composed under the OLD flow keeps its review", async () => {
  const q = await fulfilWith({ text: "gm from Acai", entities: [], mediaFileId: null });
  assert.strictEqual(q.text, "gm from Acai", "what the buyer actually wrote");
  assert.strictEqual(q.autoSend, false, "a stranger's free text never sends itself");
});

test("…and a listing without one queues nothing at all", async () => {
  assert.strictEqual(await fulfilWith(null), null, "no add-on, no job");
});
