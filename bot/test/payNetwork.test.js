// "bisa bayar pake ethereum eth dan eth robinhood" — a CHOICE OF NETWORK on
// every package.
//
// Every package here is priced by CURRENCY, not by chain
// (`price: { BNB: 1.5, SOL: 5, ETH: 0.26, … }`), and the pay chain used to be
// locked to whatever chain the buyer's TOKEN lives on — so ETH, which every
// table already prices, was unreachable unless the token happened to live on an
// ETH chain. payOptionsFor() is the one owner of what may be offered, and
// pay.js asks whenever there is more than one answer.
//
// ⚠️ THE TWO ETH NETWORKS COST THE SAME. `payNativeOf("ethereum") === "ETH" ===
// payNativeOf("robinhood")`, so both read one row of one table: this is a
// choice of rail, never of price, and a test that let them differ would be
// describing a feature nobody asked for.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-paynet-"));

const test = require("node:test");
const assert = require("node:assert");

// ⚠️ ORDER MATTERS, and it is the loadEnv scar one package over: banner.js
// DESTRUCTURES `usdToNative` at require time, so a stub installed after it is
// loaded is never seen. Stubbed here so the picker can be driven with no egress.
const nativeprice = require("../src/nativeprice");
nativeprice.usdToNative = async (chain) => {
  const px = { SOL: 200, ETH: 4000, BNB: 900, TRX: 0.3, TON: 5 }[require("../src/config/chains").nativeOf(chain)];
  if (!px) return null;
  const a = 200 / px;
  return { amount: a, human: a >= 100 ? String(Math.ceil(a)) : a.toFixed(4), native: require("../src/config/chains").nativeOf(chain) };
};

const { payOptionsFor, optionFor, networkLabel } = require("../src/config/payOptions");
const banner = require("../src/handlers/banner");
const { TIER_MAP, trendingPrices } = require("../src/config/packages");
// ⚠️ Read, never retyped: what the two payFor() cases below pin is the CHAIN
// MAPPING (a Tron token pays BNB on BSC), and a literal price there expires
// silently the next time the price moves — which it just did.
const { MASS_DM_PRICE } = require("../src/config/constants");
const { startPayment, netPick, ensureNetwork } = require("../src/handlers/pay");
const tpl = require("../src/templates");

const XPRESS = TIER_MAP.XPRESS.price; // { ETH: 0.06, SOL: 1, BNB: 0.25, … }

const mkCtx = () => {
  const sent = [];
  return {
    sent,
    from: { id: 7, username: "buyer" },
    chat: { id: 7 },
    session: {},
    answerCbQuery: async () => true,
    reply: async (text, extra) => {
      sent.push({ text: String(text), extra: extra || {} });
      return { message_id: sent.length };
    },
  };
};
const buttons = (ctx) => {
  const last = ctx.sent[ctx.sent.length - 1] || {};
  const rows = (last.extra.reply_markup || {}).inline_keyboard || [];
  return rows.flat().map((b) => ({ text: b.text, data: b.callback_data }));
};
// ⚠️ A ROBINHOOD order, because Robinhood is the ONE chain with a choice. The
// first cut of this file built a Solana order and drove the picker with it —
// which was the defect: "kalo solana ya solana, eth ya eth — khusus chain
// robinhood aja". A Solana project pays SOL and is never asked.
const order = (over = {}) => ({
  kind: "xpress_listing",
  chain: "robinhood",
  native: "ETH",
  humanAmount: 0.06,
  prices: XPRESS,
  label: "Xpress Listing — $ORCH",
  payload: { listingInput: { chain: "robinhood", address: "0x36B44a8034Fe0eEddb8819dA82128bD6959161A6", sym: "ORCH", name: "Orch" } },
  ...over,
});
const solOrder = (over = {}) =>
  order({
    chain: "solana",
    native: "SOL",
    humanAmount: 1,
    label: "Xpress Listing — $ACAI",
    payload: { listingInput: { chain: "solana", address: "So1111", sym: "ACAI", name: "Acai" } },
    ...over,
  });

// ── what may be offered ─────────────────────────────────────────────────────

test("a ROBINHOOD order is offered ETH on Robinhood Chain AND on Ethereum, own chain first", () => {
  const opts = payOptionsFor(order());
  assert.deepStrictEqual(
    opts.map((o) => `${o.amount} ${o.native} ${o.chain}`),
    ["0.06 ETH robinhood", "0.06 ETH ethereum"],
    "the token's own chain stays FIRST — an existing buyer's flow must not move under them",
  );
});

// ⚠️ "kalo solana ya solana, eth ya eth". Only Robinhood has a choice of rail;
// every other chain pays in its own coin on its own network and is never asked.
test("⚠️ every OTHER chain is offered exactly its own network — no picker", () => {
  const own = (chain) => payOptionsFor(order({ chain })).map((o) => `${o.chain}/${o.amount} ${o.native}`);
  assert.deepStrictEqual(own("solana"), ["solana/1 SOL"]);
  assert.deepStrictEqual(own("ethereum"), ["ethereum/0.06 ETH"], "an Ethereum project is not offered Robinhood");
  assert.deepStrictEqual(own("base"), ["base/0.06 ETH"]);
  assert.deepStrictEqual(own("bsc"), ["bsc/0.25 BNB"]);
  assert.deepStrictEqual(own("tron"), ["tron/900 TRX"]);
  assert.deepStrictEqual(own("ton"), ["ton/40 TON"]);
});

test("the two ETH networks are the same price — a choice of rail, not of price", () => {
  const [eth, robinhood] = payOptionsFor(order()).filter((o) => o.native === "ETH");
  assert.strictEqual(eth.amount, robinhood.amount);
});

test("a token already on an ETH chain is not offered twice", () => {
  const chains = payOptionsFor(order({ chain: "robinhood", native: "ETH" })).map((o) => o.chain);
  assert.deepStrictEqual(chains, ["robinhood", "ethereum"], `deduped, own chain first: ${chains}`);
});

test("a payVia chain is offered on the chain it actually bills on", () => {
  // Sui is listed here and billed in BNB on BSC — arming "sui" would generate a
  // key no adapter can sweep.
  const chains = payOptionsFor(order({ chain: "sui" })).map((o) => o.chain);
  assert.ok(!chains.includes("sui"), `never the display chain: ${chains}`);
  assert.strictEqual(chains[0], "bsc");
});

test("⚠️ a duration a currency cannot price is NOT offered", () => {
  // The ETH trending table has no 3H row. Offering it would arm `undefined`.
  // (A Robinhood buyer never sees 3H — trendingForChain hands them the ETH
  // rows — but the table must refuse it on its own, not by luck of the menu.)
  const three = payOptionsFor({ chain: "robinhood", prices: trendingPrices("3H") }).map((o) => o.chain);
  assert.deepStrictEqual(three, [], `3H prices no ETH rail, got ${three}`);
  const day = payOptionsFor({ chain: "robinhood", prices: trendingPrices("24H") }).map((o) => o.chain);
  assert.deepStrictEqual(day, ["robinhood", "ethereum"], `24H must offer both rails, got ${day}`);
});

test("the renewal discount applies in every currency alike", () => {
  const full = trendingPrices("24H");
  const cut = trendingPrices("24H", 20);
  for (const sym of Object.keys(full)) {
    assert.ok(cut[sym] < full[sym], `${sym} renewal must be discounted too`);
  }
});

// ── the picker, driven ──────────────────────────────────────────────────────

test("a Robinhood order asks FIRST and arms nothing", async () => {
  const ctx = mkCtx();
  await startPayment(ctx, order());
  assert.ok(!ctx.session.pendingPayment, "nothing may be armed before the buyer picks");
  assert.deepStrictEqual(
    buttons(ctx).filter((b) => b.data).map((b) => b.data),
    ["paynet_robinhood", "paynet_ethereum", "home"],
  );
  assert.deepStrictEqual(
    buttons(ctx).filter((b) => b.data && b.data !== "home").map((b) => b.text),
    ["0.06 ETH · Robinhood Chain", "0.06 ETH · Ethereum"],
    "each button carries its own amount and names its network",
  );
});

test("⚠️ a Solana order is armed STRAIGHT AWAY in SOL — no picker, nothing moved", async () => {
  const ctx = mkCtx();
  await startPayment(ctx, solOrder());
  const pp = ctx.session.pendingPayment;
  assert.ok(pp, "armed on the first call, exactly as before the picker existed");
  assert.strictEqual(pp.order.chain, "solana");
  assert.strictEqual(pp.order.native, "SOL");
  assert.strictEqual(pp.order.humanAmount, 1);
  assert.ok(!ctx.session.payPick, "no choice was stashed");
  assert.deepStrictEqual(rails(ctx), [], "no network buttons were ever shown");
  const card = ctx.sent[ctx.sent.length - 1].text;
  assert.match(card, /Send SOL to this wallet/);
  assert.match(card, /Network: Solana/, "the card still names the network it settles on");
});

test("picking Robinhood arms the order on Robinhood, in ETH, at the TABLE price", async () => {
  const ctx = mkCtx();
  await startPayment(ctx, order());
  ctx.match = [null, "robinhood"];
  await netPick(ctx);

  const pp = ctx.session.pendingPayment;
  assert.ok(pp, "the order is armed");
  assert.strictEqual(pp.order.chain, "robinhood");
  assert.strictEqual(pp.order.native, "ETH");
  // ⚠️ NOT the 1 SOL the order arrived with, and not anything from the tap.
  assert.strictEqual(pp.order.humanAmount, 0.06, "the amount is re-read from the price table");
  assert.match(pp.address, /^0x[a-fA-F0-9]{40}$/, "an EVM wallet, not the Solana one");
});

test("picking Ethereum arms mainnet at the same amount", async () => {
  const ctx = mkCtx();
  await startPayment(ctx, order());
  ctx.match = [null, "ethereum"];
  await netPick(ctx);
  assert.strictEqual(ctx.session.pendingPayment.order.chain, "ethereum");
  assert.strictEqual(ctx.session.pendingPayment.order.humanAmount, 0.06);
});

// ── the guards ──────────────────────────────────────────────────────────────

test("⚠️ a CRAFTED network is refused, never armed", async () => {
  // paynet_<chain> is callback data the user controls. TRX is a real payable
  // chain and 900 is a real Xpress price — but this order was never offered it.
  const ctx = mkCtx();
  await startPayment(ctx, order());
  ctx.match = [null, "tron"];
  await netPick(ctx);
  assert.ok(!ctx.session.pendingPayment, "an un-offered chain must arm nothing");
  assert.strictEqual(optionFor(order(), "tron"), null);
});

test("⚠️ a crafted network is refused on the ARMING path too", async () => {
  // Every caller that pins `payChain` takes it from callback data in the end —
  // the banner flow does. So the refusal cannot live only in the picker.
  const ctx = mkCtx();
  await startPayment(ctx, order({ payChain: "tron" }));
  assert.ok(!ctx.session.pendingPayment, "an un-offered chain must arm nothing");
});

test("⚠️ a stray tap refuses WITHOUT spending the buyer's pending choice", async () => {
  const ctx = mkCtx();
  await startPayment(ctx, order());
  ctx.match = [null, "tron"]; // a stale card, or a crafted one
  await netPick(ctx);
  assert.ok(!ctx.session.pendingPayment, "nothing armed");
  assert.ok(ctx.session.payPick, "…and the choice they were making survives");
  ctx.match = [null, "robinhood"];
  await netPick(ctx);
  assert.strictEqual(ctx.session.pendingPayment.order.chain, "robinhood", "so they can still pay");
});

test("⚠️ a second tap cannot re-arm the order", async () => {
  const ctx = mkCtx();
  await startPayment(ctx, order());
  ctx.match = [null, "robinhood"];
  await netPick(ctx);
  const first = ctx.session.pendingPayment.order.id;
  await netPick(ctx); // same tap again
  assert.strictEqual(ctx.session.pendingPayment.order.id, first, "the stash is spent");
});

test("a caller that supplies no prices arms exactly as it did before", async () => {
  // The banner flow has a USD picker of its own; nothing about it may change.
  const ctx = mkCtx();
  await startPayment(ctx, { kind: "banner", chain: "bsc", native: "BNB", humanAmount: 0.4, label: "Banner", payload: {} });
  assert.ok(ctx.session.pendingPayment, "armed straight away — no picker");
  assert.strictEqual(ctx.session.pendingPayment.order.chain, "bsc");
});

test("a flow that picked its own network arms the amount it quoted, unchanged", async () => {
  // The banner flow quotes USD → native as a STRING ("0.0801") and pins its own
  // network. Routing it through the option list must not re-type that amount.
  const ctx = mkCtx();
  await startPayment(ctx, {
    kind: "banner", chain: "robinhood", native: "ETH", humanAmount: "0.0801",
    payChain: "robinhood", prices: { ETH: "0.0801" }, label: "Banner", payload: {},
  });
  const armed = ctx.session.pendingPayment.order;
  assert.strictEqual(armed.humanAmount, "0.0801", "byte-identical to what the flow quoted");
  assert.strictEqual(armed.chain, "robinhood");
  assert.match(ctx.sent[ctx.sent.length - 1].text, /Robinhood Chain/, "…and the card still names it");
});

// ── every flow hands over its price table ───────────────────────────────────
//
// ⚠️ THE TESTS ABOVE BUILD THEIR ORDERS BY HAND, so they prove the machinery
// and say nothing about whether any real flow uses it. A mutation run said so:
// deleting `prices:` from the listing flow left all of them green, and the
// buyer would simply never be offered ETH again — the feature gone, silently,
// with a full suite behind it. `prices` is what turns the choice on, so no call
// site may omit it.

const HANDLERS = path.join(__dirname, "..", "src", "handlers");
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

/** Every `startPayment(ctx, { … })` literal in the handlers, comment-stripped. */
function payCallSites() {
  const out = [];
  // pay.js OWNS startPayment and re-enters it with the buyer's pick already
  // spread in (`{ ...order, payChain }`) — it is the machinery, not a flow, and
  // requiring a price table of it would be requiring it of itself.
  const flows = fss.readdirSync(HANDLERS).filter((n) => n.endsWith(".js") && n !== "pay.js");
  for (const f of flows) {
    const src = stripComments(fss.readFileSync(path.join(HANDLERS, f), "utf8"));
    let i = src.indexOf("startPayment(ctx, {");
    while (i !== -1) {
      // Walk to the matching brace so a nested payload cannot end the literal.
      let depth = 0;
      let j = src.indexOf("{", i);
      const from = j;
      for (; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}" && --depth === 0) break;
      }
      out.push({ file: f, body: src.slice(from, j + 1) });
      i = src.indexOf("startPayment(ctx, {", j);
    }
  }
  return out;
}

test("⚠️ every purchase flow hands its price table to the picker", () => {
  const sites = payCallSites();
  // Vacuity: a scan that finds nothing passes for the wrong reason, and this
  // one walks braces — one bad index and it silently matches zero.
  assert.ok(sites.length >= 5, `expected every flow, found ${sites.length}`);
  const naked = sites.filter((s) => !/\bprices:/.test(s.body)).map((s) => s.file);
  assert.deepStrictEqual(
    naked,
    [],
    `these flows would never offer ETH: ${naked.join(", ")}`,
  );
});

// ── the pay card names the network ──────────────────────────────────────────

test("the pay card NAMES the network the buyer must send on", async () => {
  const ctx = mkCtx();
  await startPayment(ctx, order());
  ctx.match = [null, "robinhood"];
  await netPick(ctx);
  const card = ctx.sent[ctx.sent.length - 1].text;
  assert.match(card, /Robinhood Chain/, `two ETH networks share one address shape:\n${card}`);
});

test("⚠️ …and startPayment ACTUALLY calls it — an operator's saved card still names the network", async (t) => {
  // The shipped pay_card carries {network}, so a unit test of ensureNetwork
  // alone leaves the WIRING unproved — the call could be deleted and every
  // assertion stay green. data/templates.json wins over the code default for
  // ever, so this drives the real handler over a card saved before this shipped.
  const orig = tpl.render;
  t.after(() => (tpl.render = orig));
  tpl.render = (key, vars) =>
    key === "pay_card"
      ? { text: `Send ${vars.native} to ${vars.address} — ${vars.amount}`, entities: [] }
      : orig(key, vars);

  const ctx = mkCtx();
  await startPayment(ctx, order());
  ctx.match = [null, "robinhood"];
  await netPick(ctx);
  const card = ctx.sent[ctx.sent.length - 1].text;
  assert.match(card, /Robinhood Chain/, `the network is enforced, not trusted:\n${card}`);
});

test("⚠️ …even when an operator's saved template has no network line", () => {
  // data/templates.json wins over the code default for ever, so a card saved
  // before this shipped renders no network at all — on the one line whose
  // absence costs a buyer their money.
  const stale = tpl.render("pay_card_admin", { label: "Xpress Listing" });
  const fixed = ensureNetwork(stale, "Robinhood Chain");
  assert.match(fixed.text, /Robinhood Chain/, "the line is enforced, not trusted to the template");
  const bold = (fixed.entities || []).find((e) => e.type === "bold" && e.offset >= stale.text.length);
  assert.ok(bold, "and it is bolded");
  assert.strictEqual(
    fixed.text.slice(bold.offset, bold.offset + bold.length),
    "Network: Robinhood Chain",
    "the entity offset must land on the words, not near them",
  );
});

// ⚠️ THE OLD RULE HERE WAS "don't repeat yourself" AND IT WAS THE WRONG TRADE.
// It matched a bare mention of the network's NAME, which a card can carry for
// reasons that name no network for THIS order — "we accept Ethereum, Solana and
// BNB" suppressed the enforced line completely, on the one line whose absence
// costs a buyer their money. A duplicate line costs a reader two seconds; a
// missing one costs an uncreditable transfer. So the test is the rendered
// PHRASE, which is exactly what the template emits and the only thing that
// proves the line is on the card.
test("a card that renders the network line is not given a second one", () => {
  const payload = { text: "👜 Send ETH\n\n🔗 Network: Robinhood Chain — send on this network only.", entities: [] };
  assert.strictEqual(ensureNetwork(payload, "Robinhood Chain"), payload);
  const html = { html: "🔗 <b>Network: Ethereum</b> — send on this network only." };
  assert.strictEqual(ensureNetwork(html, "Ethereum"), html);
});

test("a card that merely MENTIONS the name still gets the line", () => {
  // The shape an operator card saved before this shipped can easily have.
  const generic = { text: "Send ETH. We accept Ethereum, Solana and BNB.", entities: [] };
  const out = ensureNetwork(generic, "Ethereum");
  assert.notStrictEqual(out, generic, "a generic mention is not a network line");
  assert.match(out.text, /Network: Ethereum — send on this network only\./);
  const bold = (out.entities || []).find((e) => e.type === "bold");
  assert.strictEqual(
    out.text.slice(bold.offset, bold.offset + bold.length),
    "Network: Ethereum",
    "the entity offset must land on the words, not near them",
  );
});

// A caller with no price table has nothing to PICK, and `""` rendered the pay
// card's one load-bearing line as "🔗 Network:  — send on this network only." —
// a blank where the network goes. Every flow passes a table today; the sixth one
// added later is what this pins.
test("a card armed with no price table still names its network", async () => {
  const ctx = mkCtx();
  await startPayment(ctx, {
    kind: "banner",
    chain: "robinhood",
    native: "ETH",
    humanAmount: "0.05",
    label: "Hero banner",
    payload: {},
  });
  const card = ctx.sent[ctx.sent.length - 1].text;
  assert.match(card, /Network: Robinhood Chain/, "named from the chain being armed");
  assert.doesNotMatch(card, /Network: {2}/, "never a blank where the network goes");
});


// ── the banner flow's own picker ────────────────────────────────────────────
//
// ⚠️ Banner ads are USD-priced and quoted per chain, so THAT list is this
// flow's network picker and `payChain` pins whatever is tapped. Adding
// Robinhood put a second `0.0500 ETH` row directly under the first,
// byte-identical: two buttons, one arming Ethereum mainnet and one arming
// Robinhood Chain, on the one screen that decides which network settles the
// order. The mistake they invite is mainnet ETH sent to a Robinhood address,
// which nothing can credit.
async function bannerRows() {
  const ctx = mkCtx();
  ctx.session = {
    type: "banner",
    awaitingField: "banner_socials",
    bannerForm: { slot: "Hero", size: "1500x500", duration: "24h", usd: 200 },
  };
  ctx.message = { text: "/skip" };
  await banner.handleText(ctx);
  return buttons(ctx).filter((b) => String(b.data).startsWith("bpay_"));
}

test("every banner pay row names its network", async () => {
  const rows = await bannerRows();
  assert.ok(rows.length >= 2, "the picker rendered rows");
  const texts = rows.map((r) => r.text);
  assert.strictEqual(new Set(texts).size, texts.length, `two rows are indistinguishable: ${texts.join(" | ")}`);
  for (const r of rows) {
    const chain = String(r.data).slice("bpay_".length);
    assert.ok(
      r.text.includes(networkLabel(chain)),
      `${r.data} reads "${r.text}" and never names ${networkLabel(chain)}`,
    );
  }
});

test("the two ETH banner rows differ ONLY by network, never by price", async () => {
  const rows = await bannerRows();
  const eth = rows.filter((r) => r.data === "bpay_ethereum" || r.data === "bpay_robinhood");
  assert.strictEqual(eth.length, 2, "both ETH rails are offered");
  const amounts = eth.map((r) => r.text.split(" \u00b7 ")[0]);
  assert.strictEqual(amounts[0], amounts[1], "a choice of rail, never of price");
  assert.notStrictEqual(eth[0].text, eth[1].text, "and the rails are told apart");
});


// ── a ROBINHOOD project, driven through the real flows ───────────────────────
//
// "pastikan yang book listing or trending chain robinhood bisa bayar pake eth
// dan eth robinhood". The unit tests above prove the option table; these drive
// the HANDLERS a Robinhood buyer actually taps — approve → tier → duration —
// and read the picker they are shown. A table that is right and a flow that
// never hands it over look identical from the table's tests (the
// `curveBuyPath` scar: a wiring that does nothing refuses beautifully).
const listing = require("../src/handlers/listing");
const trending = require("../src/handlers/trending");
const listed = require("../src/helpers/listedGuard");
const { RANKED_TIERS, tierPrice, trendingForChain } = require("../src/config/packages");

const RH_TOKEN = "0x36B44a8034Fe0eEddb8819dA82128bD6959161A6"; // $ORCHFLOWS, a real Robinhood listing
const rails = (ctx) => buttons(ctx).filter((b) => String(b.data).startsWith("paynet_"));
const rhForm = () => ({ chain: "robinhood", address: RH_TOKEN, name: "Orchflows", sym: "ORCHFLOWS" });

test("a Robinhood token booking Xpress Listing is offered ETH on Robinhood Chain AND on Ethereum", async (t) => {
  // approve() re-checks the site for a duplicate before money moves; the site
  // is not here, and "not listed yet" is the answer that reaches the picker.
  const orig = listed.existingListing;
  listed.existingListing = async () => null;
  t.after(() => {
    listed.existingListing = orig;
  });
  const ctx = mkCtx();
  ctx.session = { type: "xpress_listing", form: rhForm() };
  await listing.approve(ctx);
  assert.deepStrictEqual(
    rails(ctx).map((b) => `${b.text} → ${b.data}`),
    ["0.06 ETH · Robinhood Chain → paynet_robinhood", "0.06 ETH · Ethereum → paynet_ethereum"],
    "its own chain first, mainnet beside it, one price",
  );
});

test("…and every Listing & Trending tier, at that tier's ETH price", async () => {
  for (const tier of RANKED_TIERS) {
    const ctx = mkCtx();
    ctx.session = { type: "tiered_listing", form: rhForm() };
    ctx.match = [null, tier.key];
    await listing.tierPick(ctx);
    const price = tierPrice(tier.key, "robinhood");
    assert.deepStrictEqual(
      rails(ctx).map((b) => b.text),
      [`${price} ETH · Robinhood Chain`, `${price} ETH · Ethereum`],
      `${tier.key} must offer both ETH rails at ${price} ETH`,
    );
  }
});

test("…and every Trending duration for a Robinhood token", async () => {
  const rows = trendingForChain("robinhood");
  assert.ok(rows.length >= 5, "the ETH trending table is what a Robinhood token sees");
  for (let i = 0; i < rows.length; i++) {
    const ctx = mkCtx();
    ctx.session = { coin: { chain: "robinhood", address: RH_TOKEN, sym: "ORCHFLOWS", name: "Orchflows" } };
    ctx.match = [null, String(i)];
    await trending.durationPick(ctx);
    assert.deepStrictEqual(
      rails(ctx).map((b) => b.text),
      [`${rows[i].price} ETH · Robinhood Chain`, `${rows[i].price} ETH · Ethereum`],
      `${rows[i].duration} must offer both ETH rails`,
    );
  }
});

// ⚠️ THE PAY CHAIN MOVES; THE TOKEN'S CHAIN MUST NOT. A Robinhood project that
// settles on Ethereum mainnet is still a Robinhood listing — fulfilment reads
// the token's chain off the payload, and an order whose payload followed the
// rail would list the token on the wrong network.
test("a Robinhood listing paid on Ethereum mainnet is still LISTED on Robinhood", async () => {
  const ctx = mkCtx();
  ctx.session = { type: "tiered_listing", form: rhForm() };
  ctx.match = [null, "DIAMOND"];
  await listing.tierPick(ctx);
  assert.ok(ctx.session.payPick, "the picker stashed the order");
  ctx.match = [null, "ethereum"];
  await netPick(ctx);
  const pp = ctx.session.pendingPayment;
  assert.ok(pp, "armed after the pick");
  assert.strictEqual(pp.order.chain, "ethereum", "settles on the rail that was picked");
  assert.strictEqual(pp.order.native, "ETH");
  assert.strictEqual(pp.order.humanAmount, tierPrice("DIAMOND", "robinhood"));
  assert.strictEqual(pp.order.payload.listingInput.chain, "robinhood", "the TOKEN stays on Robinhood");
  const card = ctx.sent[ctx.sent.length - 1].text;
  assert.match(card, /Network: Ethereum/, "and the card names the rail, not the token's chain");
});


// ── Mass DM, the one package that had its OWN idea of the pay chain ──────────
//
// A private map — solana → SOL, ethereum/base → ETH, everything else → BNB on
// BSC — written before Robinhood existed here. So a Robinhood project buying
// Mass DM saw "💳 Pay 0.15 BNB" and a picker with BSC first, while the listing
// it had just bought was billed in ETH on its own chain: two packages, two
// answers to one question. payChainOf/payNativeOf are the one owner now.
const massdm = require("../src/handlers/massdm");

test("a Robinhood project's Mass DM is billed in ETH on Robinhood Chain, like its listing", () => {
  assert.deepStrictEqual(massdm.payFor("robinhood"), { currency: "ETH", payChain: "robinhood", native: "ETH", price: MASS_DM_PRICE.ETH });
  assert.deepStrictEqual(massdm.payFor("solana"), { currency: "SOL", payChain: "solana", native: "SOL", price: MASS_DM_PRICE.SOL });
  // A coin the Mass DM table does not price still settles in BNB on BSC — what
  // those buyers have always been offered, and the picker adds ETH beside it.
  assert.deepStrictEqual(massdm.payFor("tron"), { currency: "BNB", payChain: "bsc", native: "BNB", price: MASS_DM_PRICE.BNB });
  assert.strictEqual(massdm.payFor("sui").payChain, "bsc", "a payVia chain bills where it always did");
});

test("…and its picker offers both ETH rails, own chain first", async () => {
  const ctx = mkCtx();
  ctx.session = {
    type: "massdm",
    massForm: { ca: RH_TOKEN, chain: "robinhood", pay: massdm.payFor("robinhood"), text: "gm", entities: [], mediaFileId: null },
  };
  await massdm.payPick(ctx);
  // Built from the price table, not retyped: what this pins is the two RAILS
  // and their order, and a literal fee here expires silently the next time the
  // price moves — which it just did when the launch discount was withdrawn.
  const eth = MASS_DM_PRICE.ETH;
  assert.deepStrictEqual(
    rails(ctx).map((b) => b.text),
    [`${eth} ETH · Robinhood Chain`, `${eth} ETH · Ethereum`],
  );
});
