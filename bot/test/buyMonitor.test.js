// The monitor's own logic: the block cursor, pool fan-in, tiers and rendering.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-mon-"));

const test = require("node:test");
const assert = require("node:assert");
const mon = require("../src/group/buyMonitor");

const buy = (block, tsMinutesAgo, tx) => ({
  txHash: tx || `0x${block}`,
  buyer: "0xb",
  usd: 100,
  tokenAmount: 10,
  blockNumber: block,
  blockTimeMs: Date.now() - tsMinutesAgo * 60000,
});

// ── The cursor ───────────────────────────────────────────────────────────────

test("first sight alerts only the last two minutes, never the 24h backlog", () => {
  // GT hands back a full day of trades. Replaying that into a group is hundreds
  // of alerts for buys that happened yesterday.
  const fresh = mon.selectFresh(null, [buy(1, 360), buy(2, 60), buy(3, 0.5)]);
  assert.strictEqual(fresh.length, 1);
  assert.strictEqual(fresh[0].blockNumber, 3);
});

test("first sight is capped even when everything is recent", () => {
  const many = Array.from({ length: 12 }, (_, i) => buy(i + 1, 0.2, `0x${i}`));
  const fresh = mon.selectFresh(null, many);
  assert.strictEqual(fresh.length, mon.FIRST_SIGHT_MAX);
  assert.strictEqual(fresh.at(-1).blockNumber, 12, "it keeps the NEWEST ones");
});

test("the block comparison is >=, so same-block siblings are not dropped", () => {
  // Several trades share a block. A strict > would silently drop every sibling
  // of the last one posted; the per-tx latch is what prevents actual repeats.
  const fresh = mon.selectFresh({ b: 100, t: 0 }, [buy(99, 1, "a"), buy(100, 1, "b"), buy(100, 1, "c"), buy(101, 1, "d")]);
  assert.deepStrictEqual(fresh.map((f) => f.txHash), ["b", "c", "d"]);
});

test("a cursor seeded on an empty feed judges by time, so no backlog replays later", () => {
  const seededAt = Date.now() - 10 * 60000;
  const fresh = mon.selectFresh({ b: 0, t: seededAt }, [buy(1, 60), buy(2, 1)]);
  assert.deepStrictEqual(fresh.map((f) => f.blockNumber), [2]);
});

test("a backlog after downtime is NOT replayed as if it just happened", () => {
  // The cursor only advances on a SUCCESSFUL poll, so it sits still through an
  // outage or a restart. On the first poll that works, the feed still returns
  // its full 24h — and without an age bound all of it posts back-to-back.
  const now = Date.now();
  const many = Array.from({ length: 250 }, (_, i) => ({
    txHash: `0x${i}`,
    usd: 100,
    blockNumber: 1001 + i,
    blockTimeMs: now - (360 - i) * 60000, // 6h of history
  }));
  const fresh = mon.selectFresh({ b: 1000, t: 0 }, many, now);
  assert.ok(fresh.length <= 8, `capped, got ${fresh.length}`);
  for (const b of fresh) {
    assert.ok(now - b.blockTimeMs <= 30 * 60000, "nothing older than the age bound is announced");
  }
});

test("a genuine burst is PACED, not dropped — the cursor stops at the last one sent", () => {
  const now = Date.now();
  const burst = Array.from({ length: 20 }, (_, i) => ({
    txHash: `0x${i}`,
    usd: 100,
    blockNumber: 500 + i,
    blockTimeMs: now - 30_000, // all recent
  }));
  const fresh = mon.selectFresh({ b: 500, t: 0 }, burst, now);
  assert.strictEqual(fresh.length, 8);
  assert.strictEqual(fresh[0].blockNumber, 500, "oldest first, so they arrive in order");
  assert.strictEqual(fresh.at(-1).blockNumber, 507);
});

test("an outage does not cost the group its alerts — they arrive late and real", () => {
  // This is the whole reason the volume estimator could be deleted. The cursor
  // only advances on a poll that WORKED, so buys that happened while the feed
  // was unreadable are still selected when it comes back — individually, each
  // with its hash, rather than summarised into one unverifiable "≈ $340".
  const now = Date.now();
  const duringOutage = [
    { txHash: "0xa", usd: 100, blockNumber: 5001, blockTimeMs: now - 8 * 60000 },
    { txHash: "0xb", usd: 100, blockNumber: 5002, blockTimeMs: now - 60_000 },
  ];
  const fresh = mon.selectFresh({ b: 5000, t: 0 }, duringOutage, now);
  assert.deepStrictEqual(fresh.map((b) => b.txHash), ["0xa", "0xb"], "both, not just the one after");
});

test("half an hour is the honest limit on how late a buy may arrive", () => {
  // Past it a buy is not news and is dropped rather than announced as if it had
  // just happened. That bound is what makes silence-during-an-outage a bounded
  // promise instead of an open one, so it is stated here as a fact.
  const now = Date.now();
  const old = [{ txHash: "0xold", usd: 100, blockNumber: 6000, blockTimeMs: now - 31 * 60000 }];
  assert.deepStrictEqual(mon.selectFresh({ b: 5000, t: 0 }, old, now), [], "too old to post");
  const recent = [{ txHash: "0xok", usd: 100, blockNumber: 6000, blockTimeMs: now - 29 * 60000 }];
  assert.strictEqual(mon.selectFresh({ b: 5000, t: 0 }, recent, now).length, 1, "still inside the window");
});

test("the dedupe latch outlives the feed's own 24h window", () => {
  // The cursor compares >=, so a quiet pool re-reads its newest buy on every
  // poll. A latch shorter than the feed's retention expires while that buy is
  // still being served, and the identical alert posts again — hourly, for a day.
  const latch = require("../src/group/alertLatch");
  assert.ok(latch.LATCH_MS > 24 * 60 * 60 * 1000, "must clear GeckoTerminal's 24h trade window");
});

// ── Pool fan-in ──────────────────────────────────────────────────────────────

test("groups watching the same token share ONE pool read", () => {
  const entries = mon.groupByPool([
    { chatId: "-1", chain: "bsc", address: "0xCA", pairAddress: "0xPOOL", minBuyUsd: 0 },
    { chatId: "-2", chain: "bsc", address: "0xCA", pairAddress: "0xpool", minBuyUsd: 50 },
    { chatId: "-3", chain: "base", address: "0xCA", pairAddress: "0xPOOL", minBuyUsd: 0 },
  ]);
  assert.strictEqual(entries.length, 2, "same chain+pool folds together; a different chain does not");
  const bsc = entries.find((e) => e.chain === "bsc");
  assert.strictEqual(bsc.groups.length, 2);
});

test("a group with no resolved pool keys on its contract, so it can self-heal", () => {
  const [entry] = mon.groupByPool([{ chatId: "-1", chain: "bsc", address: "0xCA", pairAddress: null, minBuyUsd: 0 }]);
  assert.strictEqual(entry.pool, null);
  assert.strictEqual(entry.key, "bsc:0xca");
});

// ── The cursor must not outrun a failed delivery ─────────────────────────────

test("the cursor holds at the OLDEST undelivered buy, not at the newest seen", async () => {
  // A 429 on an older buy while a newer one succeeds must not advance the
  // cursor past the failure — the retry alertLatch.release() allows would then
  // never be selected again, and the alert is lost silently in a healthy group.
  const latch = require("../src/group/alertLatch");
  const gt = require("../src/group/gtPairs");
  const trades = require("../src/group/gtTrades");
  const holdings = require("../src/group/walletHoldings");
  latch._reset();
  // Stubbed, or the whale check inside the emit loop reaches a real RPC — which
  // in a sandbox hangs the whole suite on an open socket.
  const realHolding = holdings.holdingOf;
  holdings.holdingOf = async () => null;

  const CA = "0x" + "a".repeat(40);
  // Distinguished by AMOUNT, because the alert renders the dollar figure into
  // the text while the tx hash only ever appears inside a link entity.
  const feed = [
    { txHash: "0xOLD", buyer: "0xb", usd: 111, tokenAmount: 10, blockNumber: 100, blockTimeMs: Date.now() },
    { txHash: "0xNEW", buyer: "0xb", usd: 222, tokenAmount: 10, blockNumber: 105, blockTimeMs: Date.now() },
  ];
  const realFetch = trades.fetchPoolBuys;
  const realPool = gt.fetchPoolCached;
  trades.fetchPoolBuys = async () => feed;
  gt.fetchPoolCached = async () => ({ priceUsd: 1, mcap: 1e6, liquidity: 1e5, change24h: 0, poolAddress: "0xpool" });

  const tg = {
    sendMessage: async (_chat, text) => {
      if (String(text).includes("$111")) throw new Error("429: Too Many Requests"); // the OLDER buy
      return { message_id: 1 };
    },
  };

  try {
    const entry = { key: "bsc:0xpool", chain: "bsc", address: CA, pool: "0xpool", groups: [{ chatId: "-1", chain: "bsc", address: CA, sym: "DEX", minBuyUsd: 0 }] };
    // Seed a cursor so we are past first-sight.
    mon._state.cursors[entry.key] = { b: 90, t: Date.now() };
    await mon._pollTrades(tg, entry);
    assert.strictEqual(mon._state.cursors[entry.key].b, 100, "held at the failed buy's block, not 105");
    assert.strictEqual(latch.isDelivered("-1", "0xNEW"), true);
    assert.strictEqual(latch.isDelivered("-1", "0xOLD"), false);
  } finally {
    trades.fetchPoolBuys = realFetch;
    gt.fetchPoolCached = realPool;
    holdings.holdingOf = realHolding;
  }
});

// ── Two groups, one pool, different whale bars ───────────────────────────────

test("groups sharing a pool each get their OWN verdict on one shared lookup", async () => {
  // The holding is a property of the WALLET, so it is read once. The bar is a
  // property of the GROUP, so the verdict is not: resolving it once for
  // everyone handed the second group the first group's answer.
  const latch = require("../src/group/alertLatch");
  const gt = require("../src/group/gtPairs");
  const trades = require("../src/group/gtTrades");
  const holdings = require("../src/group/walletHoldings");
  latch._reset();

  const CA = "0x" + "c".repeat(40);
  const realFetch = trades.fetchPoolBuys;
  const realPool = gt.fetchPoolCached;
  const realHolding = holdings.holdingOf;
  let lookups = 0;
  holdings.holdingOf = async () => {
    lookups++;
    return 10_000; // × $1 = $10,000 held
  };
  trades.fetchPoolBuys = async () => [{ txHash: "0xSHARED", buyer: "0xb", usd: 500, tokenAmount: 100, blockNumber: 200, blockTimeMs: Date.now() }];
  gt.fetchPoolCached = async () => ({ priceUsd: 1, mcap: 1e6, liquidity: 1e5, change24h: 0, poolAddress: "0xpool" });

  const sent = {};
  const tg = {
    sendMessage: async (chat, text) => {
      sent[chat] = text;
      return { message_id: 1 };
    },
    pinChatMessage: async () => {},
    unpinChatMessage: async () => {},
  };

  try {
    const base = { chain: "bsc", address: CA, sym: "DEX", minBuyUsd: 0 };
    const entry = {
      key: "bsc:0xpool",
      chain: "bsc",
      address: CA,
      pool: "0xpool",
      groups: [
        { ...base, chatId: "-1", whaleWalletUsd: 25000 }, // $10k held is NOT a whale here
        { ...base, chatId: "-2", whaleWalletUsd: 5000 }, //  $10k held IS a whale here
        { ...base, chatId: "-3", whales: false }, //          opted out entirely
      ],
    };
    mon._state.cursors[entry.key] = { b: 190, t: Date.now() };
    await mon._pollTrades(tg, entry);

    assert.strictEqual(lookups, 1, "one RPC call served all three groups");
    assert.match(sent["-1"], /\$DEX BUY!/, "the $25k group sees an ordinary buy");
    assert.match(sent["-1"], /^✅ Position: 10,000 \$DEX · \$10,000/m, "…still carrying the position row");
    assert.match(sent["-2"], /WHALE WALLET/, "the $5k group sees a whale");
    assert.ok(!/Position:/.test(sent["-3"]), "the opted-out group gets neither card nor row");
  } finally {
    trades.fetchPoolBuys = realFetch;
    gt.fetchPoolCached = realPool;
    holdings.holdingOf = realHolding;
  }
});

// ── Tiers and rendering ──────────────────────────────────────────────────────

test("tier labels fall back field by field, so a half-typed override still renders", () => {
  const tpl = require("../src/templates");
  const real = tpl.t;
  try {
    tpl.t = (k) => (k === "group_buy_tiers" ? "Nibble||" : real(k));
    assert.deepStrictEqual(mon.buyTiers(), ["Nibble", "WHALE BUY", "MEGA BUY"]);
    tpl.t = () => "";
    assert.deepStrictEqual(mon.buyTiers(), ["NEW BUY", "WHALE BUY", "MEGA BUY"]);
  } finally {
    tpl.t = real;
  }
});

test("no links are invented on a chain we have no explorer for", () => {
  // A bare hash rendered as a relative URL is worse than no link at all — but
  // the buyer's address is still worth showing as plain text.
  const row = mon.verifyRow("nosuchchain", { txHash: "0xabc", buyer: "0xdefdefdefdefdefdef" });
  assert.ok(!row.includes("]("), "no link markup");
  assert.match(row, /👤 0xdefd/);
  const linked = mon.verifyRow("bsc", { txHash: "0xabc", buyer: "0xdef" });
  assert.match(linked, /bscscan\.com\/tx\/0xabc/);
  assert.match(linked, /bscscan\.com\/address\/0xdef/);
});

test("the whole row vanishes when there is nothing to show", () => {
  // The label lives inside the row, so an empty one leaves nothing behind.
  assert.strictEqual(mon.verifyRow("nosuchchain", { txHash: "", buyer: "" }), "");
  const out = mon.renderRealAlert(
    { chatId: "-1", chain: "nosuchchain", address: "a", sym: "X", minBuyUsd: 0 },
    { txHash: "", buyer: "", usd: 10, tokenAmount: 5 },
    { priceUsd: 2, mcap: 100 },
  ).text;
  assert.ok(!/Buyer:/.test(out));
});

test("a buy with no buyer address still links the transaction", () => {
  const row = mon.verifyRow("solana", { txHash: "5xyz", buyer: "" });
  assert.match(row, /solscan\.io\/tx\/5xyz/);
  assert.ok(!row.includes("account"));
});

test("the pool resolver reports the TRACKED token's ticker, whichever side it is on", () => {
  // Nothing else in the bot ever learns a group's ticker, so without this every
  // alert reads "$TOKEN" — the renderer's placeholder. And reading the wrong
  // half of GT's "BASE / QUOTE" name labels every buy with the counterparty's
  // ticker (WETH, SOL) instead of the customer's.
  const gt = require("../src/group/gtPairs");
  const HOPPY = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const WETH = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const base = { attributes: { name: "HOPPY / WETH" }, relationships: { quote_token: { data: { id: `eth_${WETH}` } } } };
  assert.strictEqual(gt.symbolFromGtPool(base, HOPPY), "HOPPY");
  // GT mixes checksummed and lowercased forms in one payload, so the side test
  // has to match hex case-insensitively or it silently picks the wrong half.
  const quote = { attributes: { name: "WETH / HOPPY" }, relationships: { quote_token: { data: { id: `eth_${HOPPY.toLowerCase()}` } } } };
  assert.strictEqual(gt.symbolFromGtPool(quote, HOPPY), "HOPPY");
  assert.strictEqual(gt.symbolFromGtPool({ attributes: { name: "SOLO" } }, HOPPY), "", "a name with no pair is no answer");
});

test("the alert renders the reference layout", () => {
  const g = { chatId: "-1", chain: "solana", address: "So1", sym: "RUSS", name: "The Nietzschean Dog", minBuyUsd: 0 };
  const pool = { priceUsd: 0.00004823, mcap: 46550, counterSymbol: "SOL", counterAddress: "SoNATIVE" };
  const buy = {
    txHash: "5xTx", buyer: "AFqu1MaaaaaaaaaaaaaaaaaaaaaaaaaaajcBb",
    usd: 48.97, tokenAmount: 926311.94, spentAmount: 0.6646, spentToken: "SoNATIVE",
  };
  const out = mon.renderRealAlert(g, buy, pool).text;
  assert.match(out, /The Nietzschean Dog/);
  // Cents survive: "$49" above a link to the transaction that says $48.97 reads
  // as a rounded guess.
  assert.match(out, /\$48\.97 \(0\.6646 SOL\)/);
  // The full token amount, not a compacted "926.3K".
  assert.match(out, /926,311\.94 \$RUSS/);
  assert.match(out, /👤 AFqu1M…jcBb · Txn/);
  // The icon column: one emoji per row at the left edge, value straight after.
  // The header names the token and then says what happened to it.
  // ONE opening line: banner, token, event, byline. Three stacked blocks pushed
  // the numbers people came for off the first screen on a phone.
  assert.match(out, /^🚨 NEW BUY ALERT The Nietzschean Dog BUY! \| Powered by @\w+$/m, "the whole opening line");
  // The token row leads with the NETWORK's own glyph — 🟣 for Solana, from the
  // shared chain_emojis map — not a fixed 📃 that made every chain look alike.
  assert.match(out, /^🟣 The Nietzschean Dog \$RUSS$/m);
  assert.match(out, /^💲 \$48\.97 \(0\.6646 SOL\)$/m);
  assert.match(out, /^🪙 926,311\.94 \$RUSS$/m);
  assert.match(out, /^📊 .+ · MC .+$/m);
  // The labels the icons replaced must be gone, or the card carries both.
  assert.ok(!/\bSpent:/.test(out) && !/\bToken:/.test(out), "no bold labels left over");
});

test("the native amount comes from the trade, never derived from USD", () => {
  const g = { chatId: "-1", chain: "solana", address: "So1", sym: "RUSS", minBuyUsd: 0 };
  const pool = { priceUsd: 1, mcap: 1, counterSymbol: "SOL", counterAddress: "SoNATIVE" };
  const base = { txHash: "t", buyer: "b", usd: 48.97, tokenAmount: 100 };
  // Paid in the pool's other side → shown.
  assert.strictEqual(mon.spentNative({ ...base, spentAmount: 0.6646, spentToken: "SoNATIVE" }, pool), " (0.6646 SOL)");
  // Paid in something else (a USDC pair, or a routed swap whose legs disagree)
  // → omitted rather than mislabelled as the native coin.
  assert.strictEqual(mon.spentNative({ ...base, spentAmount: 50, spentToken: "SoUSDC" }, pool), "");
  assert.strictEqual(mon.spentNative({ ...base, spentAmount: 0, spentToken: "" }, pool), "");
});

test("price and market cap both come from the pool, so they cannot contradict", () => {
  const g = { chatId: "-1", chain: "solana", address: "So1", sym: "RUSS", minBuyUsd: 0 };
  // An effective trade price differs from the pool price by fees and slippage;
  // showing it beside the pool's market cap makes the card disagree with itself.
  const out = mon.renderRealAlert(g, { txHash: "t", buyer: "b", usd: 100, tokenAmount: 1e6 }, { priceUsd: 0.00004823, mcap: 46550 }).text;
  assert.match(out, /\$0\.0000482/);
});

test("the real alert carries the links that prove it", () => {
  const g = { chatId: "-1", chain: "bsc", address: "0x" + "a".repeat(40), sym: "DEX", minBuyUsd: 0 };
  const pool = { priceUsd: 0.0125, mcap: 2.4e6, liquidity: 1.8e5, change24h: 42.3 };
  const real = mon.renderRealAlert(g, { txHash: "0xt", buyer: "0xb", usd: 1234.5, tokenAmount: 98765 }, pool).text;
  assert.match(real, /WHALE BUY/);
  assert.match(real, /\$1,235/, "a buy amount is exact to the dollar, not '$1.2K'");
  // .text is the PARSED text — markup has become entities by now, so the link
  // shows as its label. buyCta.test.js is where the URLs themselves are checked.
  assert.match(real, /👤 0xb · Txn/);
  assert.ok(!/[_*]{1,2}Live transaction/.test(real), "no raw markup leaks — the parser only knows **bold**, [links] and `code`");
});

test("the size row only ever GROWS — it is never rendered mostly empty", () => {
  // A fill-meter shows what is MISSING, so a real buy comes out as
  // "▰▱▱▱▱▱▱▱▱▱" and reads like something failed rather than like something
  // good happened. A buy alert must never look like that.
  // Space-separated icons (premium tiles are wide; a crammed row wrapped on
  // phones) — count icons, not code units.
  const glyphs = (s) => s.split(" ").filter(Boolean).length;
  assert.strictEqual(glyphs(mon.buyEmojiRow(500)), 8); // one per $50, capped at 8
  assert.strictEqual(glyphs(mon.buyEmojiRow(0)), 3, "floored, never empty");
  assert.strictEqual(glyphs(mon.buyEmojiRow(1e9)), 8, "capped, never a wall — one line even as art tiles");
  assert.ok(!mon.buyEmojiRow(50).includes("▱"), "no empty cells anywhere");
});

test("a MEGA BUY wears the whale icon — the label and the artwork are ONE claim", () => {
  // The live card that produced this: a header reading "MEGA BUY" with eight
  // ORDINARY icons under it and the ordinary "new buy" clip. tierFor() read the
  // buy's size for the label; the icon and the clip asked a different question
  // (is the BUYER a whale by holdings?) and answered it about a $14,922 wallet.
  // So the card contradicted its own headline, in two places at once.
  const tpl = require("../src/templates");
  const real = tpl.markup;
  try {
    tpl.markup = (k) => (k === "group_buy_style" ? "🟢|🐋" : real(k));
    assert.strictEqual(mon.buyIconFor(50), "🟢", "an ordinary buy keeps the ordinary icon");
    assert.strictEqual(mon.buyIconFor(1500), "🐋", "a WHALE BUY by size");
    assert.strictEqual(mon.buyIconFor(14922), "🐋", "and the $14,922 MEGA BUY that was reported");
    assert.ok(mon.buyEmojiRow(14922).includes("🐋"), "the whole row, not just the first icon");
    assert.ok(!mon.buyEmojiRow(14922).includes("🟢"));
    assert.ok(mon.buyEmojiRow(50).includes("🟢"), "and an ordinary buy is untouched");
  } finally {
    tpl.markup = real;
  }
});

test("the tier KEY survives an admin renaming the labels", () => {
  // The artwork keys on tierKey(), never on tierFor()'s text. An operator who
  // renames "MEGA BUY" — or translates the three labels — must not silently
  // take the whale icon and the whale clip away with them, which is exactly
  // what keying off the rendered label would have done.
  const tpl = require("../src/templates");
  const realT = tpl.t;
  try {
    tpl.t = (k, ...a) => (k === "group_buy_tiers" ? "BELI|PAUS|PAUS RAKSASA" : realT(k, ...a));
    assert.strictEqual(mon.tierFor(14922), "PAUS RAKSASA", "the label follows the admin");
    assert.strictEqual(mon.tierKey(14922), "mega", "the key does not");
    assert.strictEqual(mon.isBigBuy(14922), true, "so the artwork still knows this is big");
    assert.strictEqual(mon.tierKey(50), "buy");
    assert.strictEqual(mon.isBigBuy(50), false);
  } finally {
    tpl.t = realT;
  }
});

test("the whale CLIP follows a mega buy, while PINNING deliberately does not", () => {
  // A shape check, for the same reason as the bump-ordering one below: the
  // decision itself is pinned behaviourally by isBigBuy above, but which of the
  // two verdicts each option reads is a wiring fact that happens deep inside the
  // poll loop, past a live feed and a Telegram client.
  //
  // Pinning writes to somebody else's group. Widening it to every mega buy would
  // start pinning in every existing customer's chat without them asking, so it
  // stays tied to the whale-by-WALLET verdict it has always meant.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "buyMonitor.js"), "utf8");
  const opts = src.slice(src.indexOf("const opts = {"), src.indexOf("if (await deliver("));
  assert.match(opts, /kind: isWhale \|\| isBigBuy\(buy\.usd\) \? "whale" : "buy"/, "a mega buy plays the whale clip");
  assert.match(opts, /pin: isWhale &&/, "pinning stays on the wallet verdict");
});

test("the row icons are admin-editable, falling back per position", () => {
  // markup(), not t(): the icons travel as VARS into the card template and are
  // parsed there, so a premium icon has to arrive still wearing its markup.
  const tpl = require("../src/templates");
  const real = tpl.markup;
  try {
    tpl.markup = (k) => (k === "group_buy_style" ? "🔥|🐳" : real(k));
    assert.strictEqual(mon.buyEmojiRow(50), "🔥 🔥 🔥");
    assert.strictEqual(mon.buyBarStyle()[1], "🐳", "whales get their own icon");
    tpl.markup = () => "🚀|"; // half typed
    assert.deepStrictEqual(mon.buyBarStyle(), ["🚀", "🐋"], "the missing half keeps its default");
    tpl.markup = () => { throw new Error("template layer down"); };
    assert.deepStrictEqual(mon.buyBarStyle(), ["🟢", "🐋"]);
  } finally {
    tpl.markup = real;
  }
});

test("a PREMIUM size icon reaches the card — one entity per repeated glyph", async () => {
  // The size row was the one part of the card a 💎 swap silently did not
  // reach: buyBarStyle read the template through t(), which strips markup, so
  // the operator's premium 🟢 arrived as its bare fallback char on every alert.
  const tpl = require("../src/templates");
  const g = { chatId: "-1", chain: "solana", address: "So1", sym: "RUSS", minBuyUsd: 0 };
  const pool = { priceUsd: 1, mcap: 1e6, liquidity: 1e5, counterSymbol: "SOL", counterAddress: "SoNATIVE" };
  const b = { txHash: "t", buyer: "b", usd: 400, tokenAmount: 400 };
  const styleSlots = tpl.listEmojis("group_buy_style");
  await tpl.replaceEmojiAt("group_buy_style", 0, "[🟢](emoji/888)");
  await tpl.replaceEmojiAt("group_buy_style", 1, "[🐋](emoji/999)");
  try {
    const p = mon.renderRealAlert(g, b, pool, { held: 1, holdsUsd: 1, position: "+1%" });
    const prem = p.entities.filter((e) => e.type === "custom_emoji" && e.custom_emoji_id === "888");
    assert.strictEqual(prem.length, 8, "every repeated glyph carries its own entity"); // $400 → 8 icons
    for (const e of prem) assert.strictEqual(p.text.substr(e.offset, e.length), "🟢", "over the right character");
    const w = mon.renderWhaleAlert(g, b, pool, { held: 9e8, holdsUsd: 5e4, position: "+2%", threshold: 5e4 });
    assert.ok(w.entities.some((e) => e.custom_emoji_id === "999"), "the whale row uses the WHALE icon's id");
    assert.ok(!w.entities.some((e) => e.custom_emoji_id === "888"), "…never the buy icon's");
  } finally {
    await tpl.resetTemplate("group_buy_style");
    assert.strictEqual(tpl.listEmojis("group_buy_style").length, styleSlots.length, "reset restored the shipped icons");
  }
});

test("the two cards are the SAME card — only the banner line differs", () => {
  // Row for row, placeholder for placeholder. The Position row used to sit above
  // the price on the whale card, which is defensible in isolation (the holding
  // IS the news there) and indefensible next to the other card: two layouts in
  // one feed, minutes apart, and a reader re-learning where the price sits reads
  // that as a bug rather than as emphasis.
  const tpl = require("../src/templates");
  const buy = String(tpl.DEFAULTS.group_buy_alert).split("\n");
  const whale = String(tpl.DEFAULTS.group_whale_alert).split("\n");
  assert.strictEqual(whale.length, buy.length, "same number of rows");
  assert.deepStrictEqual(whale.slice(1), buy.slice(1), "every row below the banner is identical");
  // The banner line is the ONE difference, and it is a real one.
  assert.match(buy[0], /\{intro\}.*\{tier\}/);
  assert.match(whale[0], /\{introWhale\}.*WHALE WALLET/);
});

test("both buy cards speak ONE grammar", () => {
  // A feed that mixes two layouts reads as a bug in the bot rather than as a
  // choice, and these land in the same chat minutes apart. So: every card opens
  // "<mark> | <token> <EVENT>!", and every data row starts with its icon.
  const g = { chatId: "-1", chain: "bsc", address: "0x" + "a".repeat(40), sym: "DEX", name: "Dexvra Token", minBuyUsd: 0 };
  const pool = { priceUsd: 0.0125, mcap: 2.4e6, liquidity: 1.8e5, change24h: 42.3 };
  const buy = { txHash: "0xt", buyer: "0xb", usd: 1234.5, tokenAmount: 98765 };
  const pos = { held: 5e6, holdsUsd: 62500, position: "+3.1%" };
  const cards = {
    buy: mon.renderRealAlert(g, { ...buy, usd: 40 }, pool, pos).text,
    whale: mon.renderWhaleAlert(g, buy, pool, { ...pos, threshold: 5e4 }).text,
  };
  for (const [which, text] of Object.entries(cards)) {
    const lines = text.split("\n").filter(Boolean);
    // The token's name FIRST — no Dexvra mark and no separator in front of it.
    // That position is the most valuable one on the card and it belongs to the
    // project, not to us.
    // Banner, token, event and byline share the opening line; the size row is
    // the next one, with no blank line between them.
    // "ALERT" is not required: the whale intro is just the mark now (its tier
    // already says WHALE WALLET, and saying whale twice read as clutter).
    assert.match(lines[0], /Dexvra Token .+!( \| Powered by @\w+)?$/, `${which}: the whole opening line`);
    assert.match(lines[1], /^[🟢🐋 ]+$/u, `${which}: the size row follows it directly`);
    // 🟡 is BSC's mark, from chain_emojis — the token row leads with its own
    // network on both cards, not a fixed icon on either.
    assert.match(text, /^🟡 Dexvra Token \$DEX$/m, `${which}: the token names itself the same way`);
    // Every row carrying a NUMBER leads with an icon. The bold labels these
    // replaced ("**Spent:**", "**MCap:**") must not survive on any card —
    // half-converted is worse than either layout on its own.
    assert.ok(!/^\*\*\w+:\*\*/m.test(text), `${which}: no bold-label rows left`);
    for (const l of lines.slice(2)) {
      if (/^[⚡⚠️🟢🐋]/u.test(l) || l.startsWith("Trade")) continue;
      assert.match(l, /^\p{Extended_Pictographic}/u, `${which}: "${l}" should lead with its icon`);
    }
  }
  // And the ticker-only fallback does not print the same word twice.
  const noName = mon.renderRealAlert({ ...g, name: "" }, buy, pool, null).text;
  assert.match(noName, /^🟡 \$DEX$/m, "no name → just the ticker, not '$DEX $DEX'");
});

test("every placeholder a default template uses is offered in the editor", () => {
  // The adminbot shows admins this list when they edit a template. A
  // placeholder the DEFAULT already uses but the list omits is invisible: an
  // admin who rewrites the card cannot discover it, and drops the row.
  const tpl = require("../src/templates");
  for (const key of ["group_buy_alert", "group_whale_alert"]) {
    const used = new Set([...tpl.DEFAULTS[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
    const offered = new Set(tpl.meta(key).ph);
    const missing = [...used].filter((p) => !offered.has(p));
    assert.deepStrictEqual(missing, [], `${key}: ${missing.join(", ")} used but not offered`);
  }
});

test("clearing the banner or the byline removes the row, not just its text", () => {
  // Both are WHOLE rows. An operator who empties one in @dexvraadminbot means
  // "drop this", and a blank line where it was is a rendering bug, not an
  // absence.
  const tpl = require("../src/templates");
  const realMarkup = tpl.markup;
  const g = { chatId: "-1", chain: "bsc", address: "0x" + "a".repeat(40), sym: "DEX", name: "Dexvra Token", minBuyUsd: 0 };
  const pool = { priceUsd: 0.0125, mcap: 2.4e6, liquidity: 1.8e5, change24h: 4 };
  const buy = { txHash: "0xt", buyer: "0xb", usd: 40, tokenAmount: 100 };
  try {
    // markup(), not t(): that is what these rows are built with, precisely so
    // their bold and links survive into the card.
    tpl.markup = (k, v) => (k === "group_buy_intro" || k === "group_powered_by" ? "   " : realMarkup(k, v));
    const out = mon.renderRealAlert(g, buy, pool, null).text;
    assert.ok(!/^\s*$/m.test(out.split("\n").slice(0, 1).join("")), "no blank first line");
    assert.ok(!/\n\n\n/.test(out), "and no hole where either row was");
    assert.match(out.split("\n")[0], /Dexvra Token .+!/, "the header is now the first line");
  } finally {
    tpl.markup = realMarkup;
  }
});

test("the byline names the channel from config, never a literal", () => {
  // Change LISTING_CHANNEL in .env and the byline follows, instead of quietly
  // advertising a channel that moved.
  const tpl = require("../src/templates");
  const { CHANNELS } = require("../src/config/constants");
  assert.match(tpl.DEFAULTS.group_powered_by, /\{listingChannel\}/, "it is a placeholder");
  const g = { chatId: "-1", chain: "bsc", address: "0x" + "a".repeat(40), sym: "DEX", minBuyUsd: 0 };
  const out = mon.renderRealAlert(g, { txHash: "0xt", buyer: "0xb", usd: 40, tokenAmount: 1 }, { priceUsd: 1, mcap: 1 }, null).text;
  assert.ok(out.includes(CHANNELS.listing), `the byline should name ${CHANNELS.listing}`);
  // A bare @handle, never a link target: an @handle inside [text](url) is what
  // made an earlier card fail to send at all ("400: Wrong HTTP URL").
  assert.ok(!new RegExp(`\\]\\(${CHANNELS.listing}`).test(tpl.DEFAULTS.group_powered_by), "not used as a URL");
});

test("the Position row is editable on BOTH cards, from one template", () => {
  // It used to be built in code for the ordinary card and spelled out in the
  // template for the whale one — the same row under two rules, and the
  // difference invisible until somebody went looking for it.
  const tpl = require("../src/templates");
  const realMk = tpl.markup;
  try {
    // Substitute like the real markup() does — a stub that returns the raw
    // template tests the stub, not the code.
    tpl.markup = (k, v) =>
      k === "group_position_row"
        ? "BAG {holds} {symbol}".replace(/\{(\w+)\}/g, (_, n) => (v && v[n] != null ? v[n] : ""))
        : realMk(k, v);
    const g = { chatId: "-1", chain: "bsc", address: "0x" + "a".repeat(40), sym: "DEX", minBuyUsd: 0 };
    const row = mon.positionRow(g, { held: 1000, holdsUsd: 50, position: "+1%" });
    assert.strictEqual(row, "BAG 1,000 $DEX", "the ordinary card renders the template");
  } finally {
    tpl.markup = realMk;
  }
  assert.ok(tpl.meta("group_position_row").ph.includes("holds"), "and the editor offers its placeholders");
});

test("every emoji on the buy card is reachable from the editor", () => {
  // 📃 and 👤 were written into buyMonitor.js, so they were the only two icons
  // an operator swapping the rest could not change — and nothing said why.
  //
  // chain_emojis belongs in this list for the same reason: the network glyph
  // leading the token row is picked by the bot, so the ONE place an operator can
  // change it is that map. Leave it out and the card's first character is once
  // again an icon the editor cannot reach.
  const tpl = require("../src/templates");
  const swappable = new Set(
    ["group_buy_alert", "group_whale_alert", "group_buy_intro", "group_whale_intro",
     "group_name_row", "group_buyer_row", "group_position_row", "group_buy_style", "chain_emojis"]
      .flatMap((k) => tpl.listEmojis(k).map((e) => e.char)),
  );
  const g = { chatId: "-1", chain: "solana", address: "So1", sym: "ALON", name: "alon", minBuyUsd: 0 };
  const card = mon.renderRealAlert(
    g,
    { txHash: "t", buyer: "GDAtwgaaaaaaaaaaaaaaaaaaaaaaaaZ7tX", usd: 40, tokenAmount: 100 },
    { priceUsd: 1, mcap: 1, liquidity: 1, change24h: 1 },
    { held: 100, holdsUsd: 100, position: "+1%" },
  ).text;
  const onCard = [...new Set((card.match(/\p{Extended_Pictographic}/gu) || []))];
  const stranded = onCard.filter((c) => !swappable.has(c));
  assert.deepStrictEqual(stranded, [], `emoji on the card that no template owns: ${stranded.join(" ")}`);
});

test("the editor warns where a premium emoji can and cannot light up", () => {
  // A swap that is accepted, saved and then invisible is the worst way for a
  // setting to fail, so the screen says so before somebody pastes one.
  //
  // ⚠️ THIS USED TO PIN THE SPELLING `isGroupPosted(key) ? GROUP_PREMIUM_NOTE`,
  // twice — so it went RED over code that keeps its rule on MORE screens
  // through one owner, and would have passed on a premiumNoteFor() that always
  // returned "". The rule is "every prompt carries it", and it is asserted by
  // CALLING the owner; premiumAnywhere.test.js counts the prompts.
  // Required HERE rather than at the top: this file is about the buy monitor,
  // and pulling the admin bot in at module scope for one assertion would boot
  // it for every test in it.
  const { premiumNoteFor } = require("../src/admin/adminBot")._premium;
  assert.match(premiumNoteFor("group_buy_alert"), /PEMILIK bot/, "a group card names the one account that lights it");
  assert.match(premiumNoteFor("buybot_intro"), /PEMILIK bot/);
  // …and the surfaces the prefix test could never speak for.
  assert.match(premiumNoteFor("pay_card"), /PEMILIK bot/, "a DM card is the same Telegram rule");
  assert.match(premiumNoteFor("x_trending"), /tidak punya custom emoji/, "a tweet can never animate one");
});

test("dust never spends a pacing slot — a real buy behind it must not wait hours", () => {
  // The reported failure: a pool with a busy sub-dollar tail handed the pacer
  // eight dust trades per poll, posted none, advanced the cursor by eight and
  // logged "paced — more buys queued for the next poll" every single time. The
  // group's genuine $112 buy sat behind that queue while the bot worked
  // perfectly and produced nothing.
  const t = Date.now();
  const dust = Array.from({ length: 200 }, (_, i) => ({
    txHash: `d${i}`, usd: 0.4, blockNumber: 1000 + i, blockTimeMs: t - 60_000,
  }));
  const real = { txHash: "REAL", usd: 112.9, blockNumber: 1300, blockTimeMs: t - 60_000 };
  const cursor = { b: 1000, t };
  const paced = mon.selectFresh(cursor, [...dust, real], t, 10);
  assert.ok(paced.some((b) => b.txHash === "REAL"), "the postable buy is reachable on THIS poll");
  assert.ok(!paced.some((b) => b.usd < 10), "and no sub-floor trade took a slot");
  // Without a floor nothing is dropped — the chain reader has no dollars yet
  // at this point, and discarding those would discard every chain-read buy.
  const unpriced = [{ txHash: "x", tokenAmount: 5, blockNumber: 1000, blockTimeMs: t - 60_000 }];
  assert.strictEqual(mon.selectFresh(cursor, unpriced, t, 10).length, 1, "unpriced buys survive the filter");
});
