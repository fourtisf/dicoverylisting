// Reading buys straight from the chain, with no indexer in front.
//
// GeckoTerminal refuses this server at the IP level — 429 on the second call
// from a fresh process, tracking one pool, needing 2.4 requests a minute
// against a 25/minute budget. No pacing argues with that. The chain cannot rate
// limit us out of our own product.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-ct-"));

const test = require("node:test");
const assert = require("node:assert");
const { ethers } = require("ethers");
const ct = require("../src/group/chainTrades");

const TOKEN = "0x" + "aa".repeat(20);
const WETH = "0x" + "bb".repeat(20);

const topicAddr = (a) => ethers.zeroPadValue(a, 32);
const coder = ethers.AbiCoder.defaultAbiCoder();

const v2Log = (a0In, a1In, a0Out, a1Out) => ({
  topics: [ethers.id(ct.V2_SWAP), topicAddr(WETH), topicAddr(WETH)],
  data: coder.encode(["uint256", "uint256", "uint256", "uint256"], [a0In, a1In, a0Out, a1Out]),
});
const v3Log = (a0, a1) => ({
  topics: [ethers.id(ct.V3_SWAP), topicAddr(WETH), topicAddr(WETH)],
  data: coder.encode(["int256", "int256", "uint160", "uint128", "int24"], [a0, a1, 0, 0, 0]),
});

test("a V2 buy is read as a buy, either way round the pool sits", () => {
  // token is token0: it leaves the pool as amount0Out, paid for with amount1In.
  const asZero = ct.decodeEvmSwap(ethers, v2Log(0n, 10n ** 18n, 500n, 0n), true);
  assert.strictEqual(asZero.tokenOut, 500n);
  assert.strictEqual(asZero.spent, 10n ** 18n);
  // token is token1: the sides swap. A pool is free to be created either way
  // round, and guessing from address ordering costs a reversed alert.
  const asOne = ct.decodeEvmSwap(ethers, v2Log(10n ** 18n, 0n, 0n, 500n), false);
  assert.strictEqual(asOne.tokenOut, 500n);
  assert.strictEqual(asOne.spent, 10n ** 18n);
});

test("a V2 SELL is not reported as a buy", () => {
  // The token went INTO the pool. Posting this as a green buy alert is the
  // single most damaging thing a buy bot can do to a project's chat.
  assert.strictEqual(ct.decodeEvmSwap(ethers, v2Log(500n, 0n, 0n, 10n ** 18n), true), null);
});

test("V3's SIGNED amounts are read as signed, not as V2's unsigned ones", () => {
  // This is the failure that does not announce itself: reading a V3 log with
  // V2's shape does not throw, it reports the wrong direction. Negative means
  // the amount left the pool — i.e. the trader received it.
  const buy = ct.decodeEvmSwap(ethers, v3Log(-500n, 10n ** 18n), true);
  assert.strictEqual(buy.tokenOut, 500n, "our token came out");
  assert.strictEqual(buy.spent, 10n ** 18n, "and the other side went in");
  // Positive on our side = our token went IN = a sell.
  assert.strictEqual(ct.decodeEvmSwap(ethers, v3Log(500n, -(10n ** 18n)), true), null);
});

test("a log that is neither shape is skipped, not guessed at", () => {
  const alien = { topics: [ethers.id("Mint(address,uint256,uint256)")], data: "0x" };
  assert.strictEqual(ct.decodeEvmSwap(ethers, alien, true), null);
});

// ── The two shapes that were invisible ───────────────────────────────────────
//
// PancakeSwap V3 is the dominant DEX on BSC and Aerodrome is the dominant DEX
// on Base, and NEITHER matched the old two-topic filter. Their pools did not
// error and did not fall back to the indexer: getLogs returned nothing, so the
// pool read as one nobody trades — permanently, on the busiest venue of each
// chain.

const pcsV3Log = (a0, a1) => ({
  topics: [ethers.id(ct.PCS_V3_SWAP), topicAddr(WETH), topicAddr(WETH)],
  // Uniswap V3's payload plus the two protocol-fee words.
  data: coder.encode(
    ["int256", "int256", "uint160", "uint128", "int24", "uint128", "uint128"],
    [a0, a1, 0, 0, 0, 0, 0],
  ),
});
// `to` is INDEXED here, so it leaves the data — and pushes the amounts one slot
// right in parseLog's args.
const solidlyLog = (a0In, a1In, a0Out, a1Out) => ({
  topics: [ethers.id(ct.SOLIDLY_SWAP), topicAddr(WETH), topicAddr("0x" + "22".repeat(20))],
  data: coder.encode(["uint256", "uint256", "uint256", "uint256"], [a0In, a1In, a0Out, a1Out]),
});

test("a PancakeSwap V3 buy decodes — BSC's busiest DEX was reading as a dead pool", () => {
  const asZero = ct.decodeEvmSwap(ethers, pcsV3Log(-500n, 10n ** 18n), true);
  assert.strictEqual(asZero.tokenOut, 500n);
  assert.strictEqual(asZero.spent, 10n ** 18n);
  const asOne = ct.decodeEvmSwap(ethers, pcsV3Log(10n ** 18n, -500n), false);
  assert.strictEqual(asOne.tokenOut, 500n, "and either way round the pool sits");
  assert.strictEqual(ct.decodeEvmSwap(ethers, pcsV3Log(500n, -(10n ** 18n)), true), null, "a sell is still a sell");
});

test("an Aerodrome buy decodes, and its shifted amounts are read at the RIGHT offsets", () => {
  const asZero = ct.decodeEvmSwap(ethers, solidlyLog(0n, 10n ** 18n, 500n, 0n), true);
  assert.strictEqual(asZero.tokenOut, 500n);
  assert.strictEqual(asZero.spent, 10n ** 18n);
  const asOne = ct.decodeEvmSwap(ethers, solidlyLog(10n ** 18n, 0n, 0n, 500n), false);
  assert.strictEqual(asOne.tokenOut, 500n);
  assert.strictEqual(ct.decodeEvmSwap(ethers, solidlyLog(500n, 0n, 0n, 10n ** 18n), true), null, "a sell is still a sell");
});

test("reading Solidly at Uniswap's offsets would REVERSE the trade, so the offset is per-shape", () => {
  // The regression that justifies the shape table. Solidly indexes `to` as well
  // as `sender`, so its amounts sit at args[2..5]. Reading them at args[1..4]
  // does not throw — args[1] is an address string and BigInt("0x2222…") is a
  // perfectly good number — it reports the wrong direction, which on a buy bot
  // means a green alert on somebody's dump.
  const buy = ct.decodeEvmSwap(ethers, solidlyLog(0n, 10n ** 18n, 500n, 0n), true);
  assert.strictEqual(buy.tokenOut, 500n, "the amount out, not the `to` address read as a number");
  assert.ok(buy.tokenOut < 10n ** 30n, "a token address misread as an amount is astronomically large");
});

test("the getLogs filter is DERIVED from the decode table — the two cannot drift", () => {
  // They already had. The filter named two topics while four shapes exist in
  // the wild, and nothing in the code connected the two lists.
  const topics = [...ct.swapShapes(ethers).keys()];
  assert.strictEqual(topics.length, ct.SWAP_SHAPES.length);
  assert.deepStrictEqual(new Set(topics), new Set(ct.SWAP_SHAPES.map((s) => ethers.id(s.sig))));
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "chainTrades.js"), "utf8");
  assert.match(src, /topics:\s*\[wantTopics\]/, "the filter comes from the table, not a literal");
});

test("a flash swap is not a buy — nobody paid for it", () => {
  // Borrow and repay the same token in one log: our token comes OUT, and the
  // other side never went in. Arb bots do this routinely, and it used to post
  // as a full green alert priced at whatever the tokens were worth.
  assert.strictEqual(ct.decodeEvmSwap(ethers, v2Log(0n, 0n, 500n, 0n), true), null);
  assert.strictEqual(ct.decodeEvmSwap(ethers, solidlyLog(0n, 0n, 500n, 0n), true), null);
  assert.strictEqual(ct.decodeEvmSwap(ethers, v3Log(-500n, 0n), true), null);
});

test("unreadable resolves to null, which is not the same as no buys", async () => {
  // The whole fallback rests on this distinction: null sends the caller to the
  // indexer, [] tells it the pool is quiet and to advance its cursor.
  assert.strictEqual(await ct.fetchPoolBuys("ethereum", null, TOKEN, {}), null, "no pool");
  assert.strictEqual(await ct.fetchPoolBuys("ethereum", "0xpool", null, {}), null, "no token");
  assert.strictEqual(await ct.fetchPoolBuys("nosuchchain", "0xpool", TOKEN, {}), null, "no reader");
});

test("every chain the buy bot runs on has a reader", () => {
  // A chain with no reader falls back to the indexer that is refusing us, which
  // is the state this whole module exists to get out of.
  for (const c of ["ethereum", "bsc", "base", "solana"]) {
    assert.ok(ct.supports(c), `${c} has no chain reader`);
  }
});

test("the buy bot tries the chain BEFORE the indexer, and falls back", () => {
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "buyMonitor.js"), "utf8");
  const fn = src.slice(src.indexOf("async function pollTrades"));
  const body = fn.slice(0, fn.indexOf("\nasync function"));
  // Matched with a regex, not indexOf: the call is wrapped across lines, and a
  // substring check on "chainTrades.fetchPoolBuys" quietly reports the reader as
  // absent rather than as differently formatted.
  const chainAt = body.search(/chainTrades\s*\.\s*fetchPoolBuys/);
  const gtAt = body.search(/\btrades\s*\.\s*fetchPoolBuys/);
  assert.ok(chainAt > -1, "the chain reader is used");
  assert.ok(gtAt > -1, "and the indexer is still there as a fallback");
  assert.ok(chainAt < gtAt, "chain first");
  assert.match(body, /buys === null && net/, "the indexer runs only when the chain could not be read");
});

test("a Solana cursor carries the signature, not just the slot", () => {
  // getSignaturesForAddress walks BACK until it recognises a signature; there is
  // no "read from slot N". And slots alone cannot stand in for it — several
  // transactions share a slot, so a slot cursor re-reads or skips.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "buyMonitor.js"), "utf8");
  assert.match(src, /sig: newestSig/, "the cursor stores it");
  assert.match(src, /sinceSig: \(cursorNow && cursorNow\.sig\)/, "and the next read uses it");
});

// ── Not being slower than the thing it replaced ──────────────────────────────
//
// The first cut of this reader fetched up to forty transactions ONE AT A TIME
// from a public Solana node. A poll that should take 25 seconds took SIX
// MINUTES, and then fell back to the indexer anyway — so the group was served a
// growing backlog, eight stale alerts at a time, and the logs read as if it
// were working. A reader that makes the bot slower than the feed it replaced is
// worse than no reader.

test("the whole read is bounded by one wall-clock deadline", () => {
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "chainTrades.js"), "utf8");
  assert.match(src, /const DEADLINE_MS =/, "there is a ceiling");
  assert.match(src, /const deadline = Date\.now\(\) \+ DEADLINE_MS/, "set once for the whole read");
  // Both chain paths must receive it, or the one that does not is unbounded.
  assert.match(src, /solanaBuys\(chain, pool, token, \{[^}]*deadline/, "solana");
  assert.match(src, /evmBuys\(chain, pool, token, \{[^}]*deadline/, "evm");
});

test("transactions are fetched concurrently, never in a bare sequential loop", () => {
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "chainTrades.js"), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // getTransaction is the expensive call. Every one of them goes through the
  // bounded mapper; a `for` loop awaiting one is what cost the six minutes.
  const seq = code.match(/for \([^)]*\) \{[^}]*await [^}]*getTransaction/s);
  assert.strictEqual(seq, null, "a sequential getTransaction loop is back");
  assert.match(code, /mapBounded\(/, "the bounded mapper is used");
  assert.match(code, /const CONCURRENCY =/, "with a ceiling on how many at once");
});

test("stale signatures are dropped BEFORE a transaction is fetched for them", () => {
  // The listing already carries slot, blockTime and err. Spending a
  // getTransaction on a buy that buyMonitor will drop for being 40 minutes old
  // is the whole cost, and it is avoidable for free.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "chainTrades.js"), "utf8");
  const fn = src.slice(src.indexOf("async function solanaBuys"));
  // CODE ONLY. The comment explaining the filter names getTransaction, and
  // matching it makes the test trip over its own explanation — which is how a
  // red test stops meaning anything.
  const body = fn
    .slice(0, fn.indexOf("\n/**"))
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  const filterAt = body.indexOf("blockTime * 1000 >= cutoff");
  const fetchAt = body.indexOf("getTransaction");
  assert.ok(filterAt > -1, "the age filter exists");
  assert.ok(fetchAt > -1 && filterAt < fetchAt, "and it runs first");
  assert.match(body, /\.filter\(\(x\) => !x\.err\)/, "a failed transaction is not fetched either");
});

test("the log says which source served the poll, and how long it took", () => {
  // Six minutes of latency looked identical to a quiet pool. Both facts have to
  // be in the line, or the next time this happens it is guesswork again.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "buyMonitor.js"), "utf8");
  assert.match(src, /via \$\{source\}/, "chain or indexer");
  assert.match(src, /\$\{Date\.now\(\) - startedAt\}ms/, "and the duration");
  assert.match(src, /alerts will run late/, "and it warns when it outruns the interval");
  assert.match(src, /took > BUYBOT_POOL_MIN_MS/, "measured against the poll interval, not a magic number");
});

test("a GeckoTerminal cooldown cannot silence a pool the chain can read", () => {
  // THE FAILURE, from the server: the chain reader was working — "via chain in
  // 1525ms" — and minutes later the same pool logged "trades feed unreadable —
  // the shared GeckoTerminal cooldown is armed" and posted nothing. The chain
  // read had been gated on fetchPoolCached returning a PRICE, which put the
  // indexer back on the trade path through the back door: GT cooled down, the
  // snapshot went away, and the chain reader was never even called.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "buyMonitor.js"), "utf8");
  const fn = src.slice(src.indexOf("async function pollTrades"));
  const body = fn.slice(0, fn.indexOf("\nasync function"));
  const chainAt = body.search(/chainTrades\s*\.\s*fetchPoolBuys/);
  const priceAt = body.search(/gt\s*\.\s*fetchPoolCached/);
  assert.ok(chainAt > -1 && priceAt > -1);
  assert.ok(chainAt < priceAt, "the chain is read BEFORE any price lookup");
  // And the reader must not be handed a price at all — taking one is what
  // invites the gate back.
  assert.doesNotMatch(body.slice(chainAt, priceAt), /priceUsd/, "the chain read asks for no price");
});

test("the chain reader returns amounts, never dollars", () => {
  // Dollars are not on the chain. Computing them here would mean asking an
  // indexer for a price before knowing whether anything traded at all.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "chainTrades.js"), "utf8");
  const fn = src.slice(src.indexOf("async function fetchPoolBuys"));
  const body = fn.slice(0, fn.indexOf("\nmodule.exports"));
  assert.doesNotMatch(body, /minUsd/, "no floor applied without a price to apply it to");
  assert.doesNotMatch(body, /usd:/, "and no usd field invented");
});

test("buys that cannot be priced are HELD, not dropped", () => {
  // They are real. Advancing the cursor past them would lose them for good,
  // where holding costs one poll.
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "buyMonitor.js"), "utf8");
  const at = src.indexOf("no price this cycle");
  assert.ok(at > -1, "the hold exists");
  // `return true` — handled, nothing posted — and crucially NOT a cursor write.
  const around = src.slice(at - 400, at + 200);
  assert.doesNotMatch(around, /state\.cursors\[entry\.key\] =/, "the cursor must not advance past a held buy");
});

// ── "kita sudah pakai helius dan limit" ───────────────────────────────────────
// Measured before this became a knob: one tracked Solana pool costs
// `1 + MAX_TX` requests every BUYBOT_POOL_MIN_MS — ~142,000 a DAY at the
// shipped 40 and 25s, against a whole trade bot that spends ~1,500. The bill is
// dominated by this number, so it has to be reachable without a deploy.
test("BUYBOT_MAX_TX is a knob, and it is clamped", () => {
  const src = fss.readFileSync(path.join(__dirname, "..", "src", "group", "chainTrades.js"), "utf8");
  const expr = (src.match(/const MAX_TX = (.*);/) || [])[1];
  assert.ok(expr, "MAX_TX must still be one declaration");
  const at = (v) => eval(expr.replace("process.env.BUYBOT_MAX_TX", JSON.stringify(v)));
  assert.equal(at(undefined), 40, "unset is the shipped default");
  assert.equal(at(""), 40, "blank is ABSENT, not zero — Number('') is 0 and 0 here is a dead reader");
  assert.equal(at("10"), 10, "an operator paying the bill can lower it");
  assert.equal(at("1"), 4, "…but never to a reader that cannot see a burst");
  assert.equal(at("9999"), 200, "…and never to one that empties a key on one poll");
});
