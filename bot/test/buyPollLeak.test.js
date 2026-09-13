// One pool's buys must never become another pool's alert.
//
// THE FAILURE: `buys` and `source` were assigned in pollTrades without ever
// being declared. This file is sloppy-mode CommonJS, so each assignment wrote
// globalThis — and scanOnce walks every pool SEQUENTIALLY in one process, so
// the value outlived the pool that produced it:
//
//   • A chain with no chainTrades reader (polygon, arbitrum, tron, ton, sui —
//     every one of them has a working indexer feed) never entered the chain
//     block, so `buys === null` read the PREVIOUS pool's array. The indexer was
//     skipped, and that other pool's buys, buyers and tx hashes were repriced
//     at this token's price and posted into this group.
//   • The first such pool in a FRESH process had no previous value to read, so
//     it was a ReferenceError — swallowed by scanOnce's .catch(log.debug),
//     which prints nothing unless DEBUG is set.
//
// This lives in its own file because run-tests.js forks node --test per file:
// "fresh process" is only available here, and the first test below depends on
// it. Do not reorder the tests.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-pollleak-"));

const test = require("node:test");
const assert = require("node:assert");
const mon = require("../src/group/buyMonitor");
const chainTrades = require("../src/group/chainTrades");
const trades = require("../src/group/gtTrades");
const gt = require("../src/group/gtPairs");
const latch = require("../src/group/alertLatch");
const holdings = require("../src/group/walletHoldings");

const CA = (c) => "0x" + c.repeat(40);
const priced = async () => ({ priceUsd: 1, mcap: 1e6, liquidity: 1e5, change24h: 0, poolAddress: "0xpool" });

/** Stub every network edge, run `fn`, put them all back. */
async function withStubs(over, fn) {
  const real = {
    chain: chainTrades.fetchPoolBuys,
    indexer: trades.fetchPoolBuys,
    pool: gt.fetchPoolCached,
    holding: holdings.holdingOf,
  };
  chainTrades.fetchPoolBuys = over.chain || (async () => null);
  trades.fetchPoolBuys = over.indexer || (async () => null);
  gt.fetchPoolCached = over.pool || priced;
  holdings.holdingOf = async () => null; // else the whale check opens a real socket
  latch._reset();
  try {
    return await fn();
  } finally {
    chainTrades.fetchPoolBuys = real.chain;
    trades.fetchPoolBuys = real.indexer;
    gt.fetchPoolCached = real.pool;
    holdings.holdingOf = real.holding;
  }
}

const entryFor = (chain, letter, chatId) => ({
  key: `${chain}:pool-${letter}`,
  chain,
  address: CA(letter),
  pool: `pool-${letter}`,
  groups: [{ chatId, chain, address: CA(letter), sym: "DEX", minBuyUsd: 0 }],
});

// MUST BE FIRST: it is the only test that can observe a process in which
// nothing has assigned the leaked globals yet.
test("a chain with no chain reader still asks its indexer — on the very first poll", async () => {
  // tron/ton/sui/polygon/arbitrum all return supports() === false and all have
  // a real gtTrades network. Before the fix this threw ReferenceError reading
  // an undeclared `buys`, and scanOnce swallowed it at debug level — so five
  // chains' worth of groups got nothing, with no line in the log to say why.
  assert.strictEqual(chainTrades.supports("tron"), false, "the premise: tron has no chain reader");
  assert.ok(require("../src/group/gtPairs").networkOf("tron"), "…but it does have an indexer");
  let asked = null;
  const ok = await withStubs({ indexer: async (net) => ((asked = net), []) }, () =>
    mon._pollTrades({ sendMessage: async () => ({ message_id: 1 }) }, entryFor("tron", "d", "-100")),
  );
  assert.strictEqual(ok, true, "the pool was handled, not reported unreadable");
  assert.strictEqual(asked, "tron", "the indexer was actually called");
});

test("one pool's buys never leak into the next pool's group", async () => {
  // The alert-shaped half of the same bug: pool A (a chain WITH a reader) fills
  // the global, pool B (a chain without one) inherits it, skips its indexer,
  // and posts A's transaction into B's chat priced at B's token.
  const sentToB = [];
  await withStubs(
    {
      chain: async (chain) =>
        chain === "bsc"
          ? [{ txHash: "0xBSCONLY", buyer: "0xb", tokenAmount: 10, blockNumber: 500, blockTimeMs: Date.now() }]
          : null,
      indexer: async () => [],
    },
    async () => {
      const a = entryFor("bsc", "a", "-1");
      const b = entryFor("polygon", "b", "-2");
      mon._state.cursors[a.key] = { b: 400, t: Date.now() };
      mon._state.cursors[b.key] = { b: 400, t: Date.now() };
      const tg = {
        sendMessage: async (chat, text) => {
          if (String(chat) === "-2") sentToB.push(String(text));
          return { message_id: 1 };
        },
      };
      await mon._pollTrades(tg, a); // fills the global on the old code
      await mon._pollTrades(tg, b); // …and inherited it
      // The proof the alert never crossed: B's chat saw nothing at all, and B's
      // cursor never learned A's signature. The cursor half is the one that
      // outlives a restart — a poisoned cursor keeps a pool silent for good.
      assert.deepStrictEqual(sentToB, [], `polygon's group must receive nothing: ${sentToB.join(" | ")}`);
      assert.notStrictEqual(mon._state.cursors[b.key].sig, "0xBSCONLY", "polygon's cursor is not bsc's tx");
      assert.strictEqual(latch.isDelivered("-2", "0xBSCONLY"), false, "and it was never delivered there");
    },
  );
});

test("pollTrades leaves no globals behind at all", () => {
  // The direct assertion, so the next edit cannot reintroduce the leak with a
  // third variable and still pass the two tests above.
  for (const name of ["buys", "source"]) {
    assert.ok(!(name in globalThis), `pollTrades must not write globalThis.${name}`);
  }
});
