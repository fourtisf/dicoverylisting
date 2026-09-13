// A deposit address is 44 characters that must be transcribed perfectly or the
// buyer's money is gone. Copying it is therefore not a nicety, and it must not
// depend on either (a) the operator leaving the template's backticks alone or
// (b) the buyer knowing that tapping monospace text copies it.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-copy-"));

const test = require("node:test");
const assert = require("node:assert");
const premium = require("../src/premium");
const menu = require("../src/handlers/menu");
const tpl = require("../src/templates");

const ADDR = "HrwXpSHP3bm4Wbar8roHvycpfPAjQx68PJ6BDuc6bBjk";
const codeEnts = (p) => (p.entities || []).filter((e) => e.type === "code");

test("the built-in pay card already marks the address copyable", () => {
  const r = tpl.render("pay_card", { label: "Xpress Listing", amount: "1", native: "SOL", address: ADDR });
  const hit = codeEnts(r).find((e) => r.text.substr(e.offset, e.length) === ADDR);
  assert.ok(hit, `no code entity over the address:\n${JSON.stringify(r, null, 1)}`);
});

test("an operator who re-saves the card as plain text does not break copy", () => {
  // This is the real failure seen in production: the admin bot stores what was
  // pasted, the backticks are gone, and the address ships as ordinary text.
  const plain = { text: `Send SOL to this wallet:\n${ADDR}\n\nAmount: 1 SOL`, entities: [] };
  const fixed = premium.ensureCode(plain, ADDR);
  const hit = codeEnts(fixed).find((e) => fixed.text.substr(e.offset, e.length) === ADDR);
  assert.ok(hit, "ensureCode must add the entity the template lost");
  assert.strictEqual(fixed.text, plain.text, "the text itself is untouched");
});

test("ensureCode is idempotent — it never double-marks an address", () => {
  const once = premium.ensureCode(
    tpl.render("pay_card", { label: "L", amount: "1", native: "SOL", address: ADDR }),
    ADDR,
  );
  const twice = premium.ensureCode(once, ADDR);
  assert.strictEqual(codeEnts(twice).length, codeEnts(once).length, "a second pass adds nothing");
});

test("ensureCode marks every occurrence, and offsets are UTF-16 code units", () => {
  // Emoji above the BMP count as 2 units — an entity measured in characters
  // would land mid-address and Telegram would reject or mis-highlight it.
  const text = `🚀 ${ADDR} … again: ${ADDR}`;
  const p = premium.ensureCode({ text, entities: [] }, ADDR);
  assert.strictEqual(codeEnts(p).length, 2, "both occurrences");
  for (const e of codeEnts(p)) assert.strictEqual(p.text.substr(e.offset, e.length), ADDR);
});

test("ensureCode leaves a range an operator already formatted alone", () => {
  // Telegram rejects code nested in bold, so an authored bold run wins; the
  // Copy button is the fallback for that case.
  const bolded = { text: `Wallet: ${ADDR}`, entities: [{ type: "bold", offset: 8, length: ADDR.length }] };
  const p = premium.ensureCode(bolded, ADDR);
  assert.strictEqual(codeEnts(p).length, 0, "no overlapping entity is injected");
});

test("ensureCode handles the legacy HTML payload shape too", () => {
  const p = premium.ensureCode({ html: `Send to ${ADDR} now` }, ADDR);
  assert.ok(p.html.includes(`<code>${ADDR}</code>`), p.html);
  assert.strictEqual(premium.ensureCode(p, ADDR).html, p.html, "idempotent");
});

test("the pay card carries a one-tap Copy Address button", () => {
  const kb = menu.confirmPayment(ADDR).reply_markup.inline_keyboard;
  const copy = kb.flat().find((b) => b.copy_text);
  assert.ok(copy, `no copy_text button:\n${JSON.stringify(kb)}`);
  assert.strictEqual(copy.copy_text.text, ADDR, "it copies the address verbatim — no label, no prefix");
  assert.match(copy.text, /copy/i);
  // Copy sits ABOVE Confirm: the buyer copies, pays, then confirms.
  assert.ok(JSON.stringify(kb).indexOf("copy_text") < JSON.stringify(kb).indexOf("confirm_pay"));
  assert.ok(kb.flat().some((b) => b.callback_data === "confirm_pay"), "Confirm is still there");
});

test("the FREE admin card has no address, so it grows no copy button", () => {
  const kb = menu.confirmPayment().reply_markup.inline_keyboard;
  assert.ok(!kb.flat().some((b) => b.copy_text), "nothing to copy on a free order");
  assert.ok(kb.flat().some((b) => b.callback_data === "confirm_pay"));
});

test("every package pays through the one card that was fixed", async () => {
  // listing / trending / banner / mass DM all call startPayment — so wiring the
  // copy affordance there covers all of them, and must keep doing so.
  const src = fss.readFileSync(require.resolve("../src/handlers/pay.js"), "utf8");
  assert.match(src, /premium\.ensureCode\(/, "the address is force-marked copyable");
  for (const f of ["listing", "trending", "banner", "massdm"]) {
    const h = fss.readFileSync(require.resolve(`../src/handlers/${f}.js`), "utf8");
    assert.match(h, /startPayment\(/, `${f} must not hand-roll its own pay card`);
  }

  // ⚠️ The Copy button carries the REAL address — asserted by RENDERING the
  // card, not by matching `menu.confirmPayment(r.address)` in the source. That
  // spelling is what this test used to pin, and it went red the day the card
  // grew a second argument for the broadcast add-on row — over code that keeps
  // the rule perfectly. A guard on a spelling is a guard on nothing; this repo
  // has now paid for that three times (the four-way pool TTL, the `{ ok: true,`
  // build stamp, and here).
  const wallets = require("../src/payments/wallets");
  const orders = require("../src/payments/orders");
  const { startPayment } = require("../src/handlers/pay");
  const ADDR = "So11111111111111111111111111111111111111112";
  const realW = wallets.generateWallet;
  const realS = orders.saveOrder;
  wallets.generateWallet = async () => ({ address: ADDR });
  orders.saveOrder = async () => {};
  const sent = [];
  const ctx = {
    from: { id: 1 },
    chat: { id: 1, type: "private" },
    session: {},
    answerCbQuery: async () => true,
    reply: async (t, extra) => {
      sent.push({ t, extra: extra || {} });
      return { message_id: sent.length };
    },
    telegram: { deleteMessage: async () => {} },
  };
  try {
    await startPayment(ctx, {
      kind: "xpress_listing",
      chain: "solana",
      native: "SOL",
      humanAmount: 1,
      prices: { SOL: 1 },
      label: "Xpress Listing — $X",
      payload: {},
    });
  } finally {
    wallets.generateWallet = realW;
    orders.saveOrder = realS;
  }
  const kb = ((sent[sent.length - 1].extra.reply_markup || {}).inline_keyboard || []).flat();
  const copy = kb.find((b) => b.copy_text);
  assert.ok(copy, "the pay card must carry a Copy Address button");
  assert.strictEqual(copy.copy_text.text, ADDR, "…and it must copy the address that was actually armed");
});

test("the payment-not-detected nudge repeats the address, still copyable", () => {
  const src = fss.readFileSync(require.resolve("../src/payments/payment.js"), "utf8");
  const i = src.indexOf("payment_not_detected");
  assert.ok(i > -1);
  const around = src.slice(Math.max(0, i - 400), i + 400);
  assert.match(around, /premium\.ensureCode\(/, "the repeated address is marked copyable");
  assert.match(around, /menu\.copyAddress\(address\)/, "…and gets its own Copy button");
});
