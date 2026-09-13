// Whale WALLET alerts: keyed on what the buyer HOLDS, not on what they spent,
// and pinned in the group.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-whale-"));

const test = require("node:test");
const assert = require("node:assert");
const mon = require("../src/group/buyMonitor");
const holdings = require("../src/group/walletHoldings");
const latch = require("../src/group/alertLatch");
const whaleCfg = require("../src/services/whaleConfig");

const g = () => ({ chatId: "-100", chain: "solana", address: "So1", sym: "RUSS", name: "The Nietzschean Dog", minBuyUsd: 0 });
const pool = { priceUsd: 0.05, mcap: 15511897, counterSymbol: "SOL", counterAddress: "SoNATIVE" };
const buy = { txHash: "5xTx", buyer: "AFqu1Maaaaaaaaaaaaaaaaaaaaaaajail", usd: 804.72, tokenAmount: 51874.15, spentAmount: 10.7568, spentToken: "SoNATIVE" };

let realHolding;
test.beforeEach(() => {
  realHolding = holdings.holdingOf;
  holdings._reset();
  latch._reset();
});
test.afterEach(async () => {
  holdings.holdingOf = realHolding;
  await whaleCfg.reset(); // no test may leave a bar behind for the next one
});

// ── Detection ────────────────────────────────────────────────────────────────

test("a big HOLDER is a whale even on a small buy", async () => {
  // The whole point of the separate class: a $200 top-up from someone sitting
  // on $80k is news in a way a $200 buy from a fresh wallet is not.
  holdings.holdingOf = async () => 2_000_000; // × $0.05 = $100k
  const whale = await mon.whaleCheck(g(), { ...buy, usd: 200, tokenAmount: 4000 }, pool);
  assert.ok(whale);
  assert.strictEqual(Math.round(whale.holdsUsd), 100000);
});

test("a big BUY from a small wallet is not a whale wallet", async () => {
  holdings.holdingOf = async () => 1000; // × $0.05 = $50
  assert.strictEqual(await mon.whaleCheck(g(), { ...buy, usd: 9000 }, pool), null);
});

test("the group's own threshold beats the global default", async () => {
  holdings.holdingOf = async () => 200_000; // $10,000 held
  assert.strictEqual(await mon.whaleCheck(g(), buy, pool), null, "under the $50k default");
  const whale = await mon.whaleCheck({ ...g(), whaleWalletUsd: 5000 }, buy, pool);
  assert.ok(whale, "over this group's own $5k bar");
});

// ── The Position row ─────────────────────────────────────────────────────────

test("a first-ever buy reads 'new position' even when the two sources disagree", async () => {
  // The live card this comes from:
  //   "Position: 23,507,098.11 $Plumber · $14,922 (+6913050524503.39%)"
  // and the buy row directly above it printed the SAME token amount. The whole
  // bag came from that one trade, so there was no previous position at all.
  //
  // `held` is an on-chain balance read and `tokenAmount` is parsed out of the
  // swap. They agree to about eleven significant digits and disagree after that,
  // so the subtraction leaves a residue instead of zero — and dividing 23.5
  // million by 0.00034 is a thirteen-digit percentage.
  const held = 23_507_098.11;
  holdings.holdingOf = async () => held;
  const pos = await mon.buyerPosition(g(), { ...buy, usd: 14922, tokenAmount: held - 0.00034 }, pool);
  assert.strictEqual(pos.position, "new position");
  assert.strictEqual(pos.held, held, "the holding itself is untouched — only the percentage was fiction");
});

test("an exact first buy still reads 'new position'", async () => {
  // The case that always worked, kept so the floor cannot regress it.
  holdings.holdingOf = async () => 5000;
  const pos = await mon.buyerPosition(g(), { ...buy, usd: 5000, tokenAmount: 5000 }, pool);
  assert.strictEqual(pos.position, "new position");
});

test("a balance read that lands after a later SELL cannot invent a position", async () => {
  // held < bought, so `before` is negative rather than merely tiny.
  holdings.holdingOf = async () => 100;
  const pos = await mon.buyerPosition(g(), { ...buy, usd: 5000, tokenAmount: 500 }, pool);
  assert.strictEqual(pos.position, "new position");
});

test("a real previous position still prints its real percentage", async () => {
  holdings.holdingOf = async () => 2000; // held 1000 before, doubled it
  const pos = await mon.buyerPosition(g(), { ...buy, usd: 5000, tokenAmount: 1000 }, pool);
  assert.strictEqual(pos.position, "+100.00%");
});

test("the floor is PRECISION, not a cap on large numbers", async () => {
  // Deliberately not capped: a genuinely tiny prior position produces a
  // genuinely huge percentage, and extreme-but-true is a different thing from
  // fabricated. Only the residue of two sources disagreeing is suppressed —
  // here the previous bag is 1e-4 of the holding, a hundred times the floor.
  holdings.holdingOf = async () => 1_000_000;
  const pos = await mon.buyerPosition(g(), { ...buy, usd: 5000, tokenAmount: 999_900 }, pool);
  assert.strictEqual(pos.position, "+999900.00%");
});

// ── The admin-set global bar ─────────────────────────────────────────────────

test("the bar ships at $50,000, and nothing overrides it out of the box", async () => {
  // Compared against defaults() rather than the literal, because a live box's
  // .env may legitimately move it — the assertion that must hold everywhere is
  // that get() resolves to whatever is configured, and that the SHIPPED value
  // (no .env, which is how this suite runs) is $50,000.
  const shipped = whaleCfg.defaults().walletUsd;
  if (!process.env.BUYBOT_WHALE_WALLET_USD) assert.strictEqual(shipped, 50000);
  assert.strictEqual(whaleCfg.get().walletUsd, shipped, "no admin override yet");
  // pool.priceUsd is $0.05, so the holding either side of the bar is bar/0.05.
  holdings.holdingOf = async () => (shipped / pool.priceUsd) * 0.999;
  assert.strictEqual(await mon.whaleCheck(g(), buy, pool), null, "a hair under");
  holdings.holdingOf = async () => (shipped / pool.priceUsd) * 1.001;
  assert.ok(await mon.whaleCheck(g(), buy, pool), "a hair over");
});

test("moving the bar in the admin bot lands on the very NEXT buy", async () => {
  // It is read fresh per check precisely because the admin bot is a separate
  // process: a cache here would never see the operator's change at all.
  holdings.holdingOf = async () => 200_000; // $10,000 held
  await whaleCfg.set({ walletUsd: 25000 });
  assert.strictEqual(await mon.whaleCheck(g(), buy, pool), null, "under the operator's $25k bar");
  await whaleCfg.set({ walletUsd: 8000 });
  assert.ok(await mon.whaleCheck(g(), buy, pool), "over their new $8k one");
});

test("a group's own /setwhale still beats the admin bar", async () => {
  // Three layers, most specific first: the group, the admin bot, then .env.
  holdings.holdingOf = async () => 200_000; // $10,000 held
  await whaleCfg.set({ walletUsd: 5000 });
  assert.strictEqual(await mon.whaleCheck({ ...g(), whaleWalletUsd: 25000 }, buy, pool), null, "this group wants a higher bar");
  assert.ok(await mon.whaleCheck(g(), buy, pool), "a group with no preference takes the admin's");
});

test("turning whales off in the admin bot silences every group at once", async () => {
  let calls = 0;
  holdings.holdingOf = async () => {
    calls++;
    return 9e9;
  };
  await whaleCfg.set({ enabled: false });
  assert.strictEqual(await mon.whaleCheck(g(), buy, pool), null);
  assert.strictEqual(await mon.whaleCheck({ ...g(), whaleWalletUsd: 1 }, buy, pool), null, "not even a group that asked for it");
  assert.strictEqual(calls, 0, "and no RPC call is spent finding that out");
});

test("a fat-finger cannot make every buy a whale, or silence them forever", async () => {
  // The rails are the difference between a typo costing a wrong screen and a
  // typo costing every group a pinned alert on every $5 buy.
  assert.strictEqual((await whaleCfg.set({ walletUsd: 5 })).walletUsd, whaleCfg.HARD_MIN_WALLET_USD);
  assert.strictEqual((await whaleCfg.set({ walletUsd: 5e12 })).walletUsd, whaleCfg.HARD_MAX_WALLET_USD);
  assert.strictEqual((await whaleCfg.set({ walletUsd: "not a number" })).walletUsd, whaleCfg.HARD_MAX_WALLET_USD, "kept the last good value");
});

test("reset drops the override and the shipped $50,000 comes back", async () => {
  await whaleCfg.set({ walletUsd: 1234, minBuyUsd: 0, enabled: false });
  const back = await whaleCfg.reset();
  assert.deepStrictEqual(back, whaleCfg.defaults());
  if (!process.env.BUYBOT_WHALE_WALLET_USD) assert.strictEqual(back.walletUsd, 50000);
});

test("the dust floor is admin-set too, and still costs no RPC call", async () => {
  let calls = 0;
  holdings.holdingOf = async () => {
    calls++;
    return 9e9;
  };
  await whaleCfg.set({ minBuyUsd: 2000 });
  assert.strictEqual(await mon.whaleCheck(g(), { ...buy, usd: 900 }, pool), null);
  assert.strictEqual(calls, 0);
  assert.ok(await mon.whaleCheck(g(), { ...buy, usd: 2500 }, pool));
  assert.strictEqual(calls, 1);
});

test("dust never orders an RPC call", async () => {
  let calls = 0;
  holdings.holdingOf = async () => {
    calls++;
    return 2_000_000;
  };
  assert.strictEqual(await mon.whaleCheck(g(), { ...buy, usd: 5 }, pool), null);
  assert.strictEqual(calls, 0);
});

test("a group that turned whales off is never checked", async () => {
  let calls = 0;
  holdings.holdingOf = async () => {
    calls++;
    return 2_000_000;
  };
  assert.strictEqual(await mon.whaleCheck({ ...g(), whales: false }, buy, pool), null);
  assert.strictEqual(calls, 0);
});

test("an unreadable holding is not a whale — and must not withhold the buy", async () => {
  // Not knowing how big a holder someone is is no reason to swallow the alert;
  // the caller falls back to the ordinary card.
  holdings.holdingOf = async () => null;
  assert.strictEqual(await mon.whaleCheck(g(), buy, pool), null);
});

test("with no price there is nothing to value a holding against", async () => {
  holdings.holdingOf = async () => 2_000_000;
  assert.strictEqual(await mon.whaleCheck(g(), buy, { ...pool, priceUsd: 0 }), null);
});

test("a chain whose holdings we cannot read is skipped, not guessed at", async () => {
  assert.strictEqual(holdings.supports("ton"), false);
  assert.strictEqual(holdings.supports("solana"), true);
  assert.strictEqual(holdings.supports("bsc"), true);
  let calls = 0;
  holdings.holdingOf = async () => {
    calls++;
    return 9e9;
  };
  assert.strictEqual(await mon.whaleCheck({ ...g(), chain: "ton" }, buy, pool), null);
  assert.strictEqual(calls, 0);
});

// ── Position ─────────────────────────────────────────────────────────────────

test("position is how much this buy GREW the bag", async () => {
  // The holding is read AFTER the trade, so the position before it is
  // held - bought.
  holdings.holdingOf = async () => 1_051_874.15;
  const whale = await mon.whaleCheck(g(), { ...buy, tokenAmount: 51_874.15 }, pool);
  assert.strictEqual(whale.position, "+5.19%");
});

test("a first-ever buy says so rather than inventing +100% or +∞", async () => {
  holdings.holdingOf = async () => 51_874.15; // exactly what they just bought
  const whale = await mon.whaleCheck({ ...g(), whaleWalletUsd: 1 }, { ...buy, tokenAmount: 51_874.15 }, pool);
  assert.strictEqual(whale.position, "new position");
});

// ── The card ─────────────────────────────────────────────────────────────────

test("the whale card labels the figure HOLDS, not 'wallet balance'", () => {
  // It is the buyer's balance of THIS token at the pool price. This bot has no
  // portfolio API, and printing a single-token figure under a label promising a
  // total would be a wrong number presented as a right one.
  const out = mon.renderWhaleAlert(g(), buy, pool, { held: 1_980_000, holdsUsd: 95_523, position: "+3.82%" }).text;
  assert.match(out, /WHALE WALLET/);
  assert.match(out, /🐋 🐋/, "the row carries the whale icon, not the plain buy one");
  assert.match(out, /Position: 1,980,000 \$RUSS · \$95,523/);
  assert.match(out, /\(\+3\.82%\)/, "and how much this buy grew it, on the same row");
  assert.ok(!/wallet balance/i.test(out));
});

test("the default card does not leak the operator's own threshold", async () => {
  // {whaleBar} was a default ROW and should never have been: the bar is the
  // operator's setting, and a reader in the group has no use for it. It explains
  // the bot's mechanism where the card's job is to report the event.
  holdings.holdingOf = async () => 200_000; // $10,000 held
  const whale = await mon.whaleCheck({ ...g(), whaleWalletUsd: 7500 }, buy, pool);
  const out = mon.renderWhaleAlert(g(), buy, pool, whale).text;
  assert.ok(!/whale bar/i.test(out), "not on the card by default");
  assert.ok(!/7,500/.test(out), "and the number is nowhere on it either");
});

test("{whaleBar} still resolves for an operator who DOES want it", async () => {
  // Dropping it from the default must not drop the capability — it stays a
  // placeholder, carrying the bar this wallet actually cleared.
  const tplMod = require("../src/templates");
  const saved = tplMod.getRawValue("group_whale_alert");
  try {
    await tplMod.setTemplate("group_whale_alert", "bar={whaleBar}");
    holdings.holdingOf = async () => 200_000; // $10,000 held
    const whale = await mon.whaleCheck({ ...g(), whaleWalletUsd: 7500 }, buy, pool);
    assert.strictEqual(whale.threshold, 7500, "the group's own bar, not the global one");
    assert.strictEqual(mon.renderWhaleAlert(g(), buy, pool, whale).text, "bar=$7,500");
  } finally {
    if (saved == null) await tplMod.resetTemplate("group_whale_alert");
    else await tplMod.setTemplate("group_whale_alert", saved);
  }
});

test("no alert template hardcodes a threshold", async () => {
  // The group's /setwhale and the admin bot can both move it, so a literal
  // "$50,000" in the copy states an entry condition that may not be true.
  const tplSrc = fss.readFileSync(path.join(__dirname, "..", "src", "templates.js"), "utf8");
  const card = tplSrc.slice(tplSrc.indexOf("group_whale_alert:"), tplSrc.indexOf("group_buy_style:"));
  assert.ok(!/\$\s?50,?000/.test(card), "the default template hardcodes no threshold");
});

// ── Position on the ORDINARY buy card ────────────────────────────────────────

test("an ordinary buy carries the buyer's position, under the buyer", async () => {
  holdings.holdingOf = async () => 1_980_000; // × $0.05 = $99,000 — under the $50k? no, over
  const pos = await mon.buyerPosition(g(), { ...buy, tokenAmount: 51_874.15 }, pool);
  const out = mon.renderRealAlert(g(), buy, pool, pos).text;
  const lines = out.split("\n").filter(Boolean);
  const buyerAt = lines.findIndex((l) => l.startsWith("👤 "));
  assert.ok(buyerAt >= 0, "the buyer row is still there");
  assert.strictEqual(lines[buyerAt + 1], "✅ Position: 1,980,000 $RUSS · $99,000 (+2.69%) · Wallet", "and the position sits right under it");
});

test("a first-ever buyer says so on the ordinary card too", async () => {
  holdings.holdingOf = async () => 51_874.15; // exactly what they just bought
  const pos = await mon.buyerPosition(g(), { ...buy, tokenAmount: 51_874.15 }, pool);
  assert.match(mon.renderRealAlert(g(), buy, pool, pos).text, /^✅ Position: 51,874\.15 \$RUSS · \$2,594 \(new position\) · Wallet$/m);
});

test("an unreadable holding removes the WHOLE row, not just its value", async () => {
  // A dangling "Position:" with nothing after it is not a row, it is a
  // rendering bug — and the buy is worth alerting either way.
  const out = mon.renderRealAlert(g(), buy, pool, null).text;
  assert.ok(!/Position/.test(out), "no label left behind");
  assert.ok(!/^✅/m.test(out), "and no empty row left in its place");
  assert.match(out, /^👤 [^\n]*\n\n⚡ Trade/m, "the buyer row runs straight into the CTA");
  assert.strictEqual(mon.positionRow(g(), null), "");
});

test("every reason a holding is unreadable ends in no row, never a broken one", async () => {
  const cases = {
    "unsupported chain": [{ ...g(), chain: "ton" }, buy, pool],
    "buy under the dust floor": [g(), { ...buy, usd: 5 }, pool],
    "no buyer address": [g(), { ...buy, buyer: null }, pool],
    "no price to value it at": [g(), buy, { ...pool, priceUsd: 0 }],
    "group turned holdings off": [{ ...g(), whales: false }, buy, pool],
  };
  holdings.holdingOf = async () => 2_000_000;
  for (const [why, args] of Object.entries(cases)) {
    assert.strictEqual(await mon.buyerPosition(...args), null, why);
    assert.ok(!/Position/.test(mon.renderRealAlert(args[0], args[1], args[2], null).text), `${why}: no dangling row`);
  }
});

test("the position row is read ONCE and serves both cards", async () => {
  // The holding is a property of the wallet; only the verdict on it differs.
  let calls = 0;
  holdings.holdingOf = async () => {
    calls++;
    return 2_000_000; // $100,000
  };
  const pos = await mon.buyerPosition(g(), buy, pool);
  assert.strictEqual(calls, 1);
  assert.match(mon.renderRealAlert(g(), buy, pool, pos).text, /^✅ Position: 2,000,000 \$RUSS · \$100,000/m);
  assert.match(mon.renderWhaleAlert(g(), buy, pool, { ...pos, threshold: 50000 }).text, /^✅ Position: 2,000,000 \$RUSS · \$100,000/m);
  assert.strictEqual(calls, 1, "and the whale card did not order a second lookup");
});

// ── Two groups, one pool ─────────────────────────────────────────────────────

test("each group judges the SAME holding against its OWN bar", async () => {
  // A shared pool used to hand group two whatever verdict group one got.
  const pos = { held: 200_000, holdsUsd: 10_000, position: "+1.00%" };
  assert.strictEqual(mon.whaleBarFor({ whaleWalletUsd: 25000 }), 25000);
  assert.strictEqual(mon.whaleBarFor({ whaleWalletUsd: 5000 }), 5000);
  assert.strictEqual(mon.whaleBarFor({}), whaleCfg.get().walletUsd, "no preference → the global bar");
  // $10,000 held: a whale to the $5k group, an ordinary buy to the $25k one.
  assert.ok(pos.holdsUsd >= mon.whaleBarFor({ whaleWalletUsd: 5000 }));
  assert.ok(pos.holdsUsd < mon.whaleBarFor({ whaleWalletUsd: 25000 }));
});

// ── Pinning ──────────────────────────────────────────────────────────────────

function tgSpy(over = {}) {
  const calls = { sent: [], pinned: [], unpinned: [] };
  return {
    calls,
    sendMessage: async () => {
      calls.sent.push(1);
      return { message_id: 100 + calls.sent.length };
    },
    pinChatMessage: async (c, m, e) => calls.pinned.push({ c, m, e }),
    unpinChatMessage: async (c, m) => calls.unpinned.push({ c, m }),
    ...over,
  };
}

test("a whale alert is pinned, and replaces the previous pin", async () => {
  // Without the unpin, every whale of the day accumulates and a pin that is one
  // of thirty is not a pin.
  const tg = tgSpy();
  assert.strictEqual(await mon.deliver(tg, "-100", { text: "a", entities: [] }, "0xa", { pin: true }), true);
  assert.strictEqual(tg.calls.pinned.length, 1);
  assert.strictEqual(tg.calls.unpinned.length, 0, "nothing to replace yet");
  assert.strictEqual(await mon.deliver(tg, "-100", { text: "b", entities: [] }, "0xb", { pin: true }), true);
  assert.strictEqual(tg.calls.unpinned[0].m, tg.calls.pinned[0].m, "the previous one is unpinned");
});

test("an ordinary buy is never pinned", async () => {
  const tg = tgSpy();
  await mon.deliver(tg, "-100", { text: "a", entities: [] }, "0xc");
  assert.strictEqual(tg.calls.pinned.length, 0);
});

test("a group that never granted 'Pin messages' still gets its alerts", async () => {
  const tg = tgSpy({
    pinChatMessage: async () => {
      throw new Error("Bad Request: not enough rights to pin a message");
    },
  });
  // The alert is the product; the pin is a nicety.
  assert.strictEqual(await mon.deliver(tg, "-100", { text: "a", entities: [] }, "0xd", { pin: true }), true);
  assert.strictEqual(tg.calls.sent.length, 1);
});

test("the whale clip is its OWN — it never borrows the ordinary buy one", () => {
  // The two slots exist so a whale LOOKS different scrolling past. Falling back
  // would give both alerts identical artwork with only the wording changed.
  const bt = require("../src/bannerTemplate");
  const real = bt.mediaOverride;
  try {
    bt.mediaOverride = (k) => (k === "buy" ? { type: "animation", source: "/tmp/buy.gif" } : null);
    assert.strictEqual(mon.buyClip("whale"), null, "no whale clip uploaded → no clip, not the buy one");
    assert.strictEqual(mon.buyClip("buy").source, "/tmp/buy.gif");
    bt.mediaOverride = (k) => ({ type: "animation", source: `/tmp/${k}.gif` });
    assert.strictEqual(mon.buyClip("whale").source, "/tmp/whale.gif");
    assert.strictEqual(mon.buyClip("buy").source, "/tmp/buy.gif");
  } finally {
    bt.mediaOverride = real;
  }
});

test("a dead RPC is remembered, so it cannot cost a timeout on every buy", async () => {
  // Without a negative cache, an unreachable node means a six-second wait per
  // qualifying buy for as long as it stays down.
  holdings._reset();
  let calls = 0;
  const realEvm = process.env.RPC_BSC;
  process.env.RPC_BSC = "http://127.0.0.1:1"; // nothing listening
  try {
    const wrapped = holdings.holdingOf;
    // Count real attempts by watching how often the miss is recomputed.
    const t0 = Date.now();
    await wrapped("solana", "So1", "Wallet1");
    calls++;
    await wrapped("solana", "So1", "Wallet1");
    calls++;
    // The second call must come back from cache, not from the network.
    assert.ok(Date.now() - t0 < 20000, "the second lookup did not repeat the wait");
    assert.strictEqual(calls, 2);
  } finally {
    if (realEvm === undefined) delete process.env.RPC_BSC;
    else process.env.RPC_BSC = realEvm;
    holdings._reset();
    holdings._resetProviders();
  }
});

test("both cards render the SAME Position row, from one template", async () => {
  // They drifted once already: the ordinary card gained a linked "· Wallet" and
  // the whale card — the one where the holding IS the news — silently did not,
  // because it spelled the row out inline instead of using {wallet}.
  const tplMod = require("../src/templates");
  assert.match(tplMod.DEFAULTS.group_whale_alert, /\{wallet\}/, "the whale card uses the shared row");
  assert.ok(
    !/Position: \{holds\}/.test(tplMod.DEFAULTS.group_whale_alert),
    "and does not keep a second copy of it",
  );
  holdings.holdingOf = async () => 2_000_000;
  const pos = await mon.buyerPosition(g(), buy, pool);
  const ordinary = mon.renderRealAlert(g(), buy, pool, pos).text;
  const whale = mon.renderWhaleAlert(g(), buy, pool, { ...pos, threshold: 50000 }).text;
  const rowOf = (t) => (t.split("\n").find((l) => l.startsWith("✅ Position:")) || "");
  assert.ok(rowOf(ordinary), "the ordinary card has the row");
  assert.strictEqual(rowOf(whale), rowOf(ordinary), "and the whale card renders it identically");
});
