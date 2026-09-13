// Uniswap V4 reader.
//
// $TLNCH on Robinhood Chain is what this is for: a live v4 pool with real
// liquidity that this bot answered with "❌ Couldn't price it" while Maestro
// showed the price. v4 has no pair contract and no per-pool contract — every
// pool is a mapping entry inside ONE PoolManager — so V2's getPair and V3's
// getPool both return nothing and there is no address to look up.
//
// The price math is the part that must not be wrong: a price out by 10^n is far
// worse than no price at all, so every conversion is checked against a hand
// worked value here.
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert");
const { ethers } = require("ethers");
const v4 = require("./v4");

const Q96 = 1n << 96n;
const TOKEN = "0x10472b42e3b22a5b98d0820a55cc6fd9034f4663";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

// AWAITS an async body before restoring. `try { return fn() } finally {}` runs
// the finally the moment fn() hands back its PROMISE — so every await inside an
// async test ran with the env already put back, and a value read after the first
// await was whatever the previous test happened to leave behind. It looked fine
// only because the assertions that noticed came later.
const withEnv = (vars, fn) => {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const k of Object.keys(old)) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; } };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === "function") return out.then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
  restore();
  return out;
};

test("price: a 1:1 raw pool is 1 native per token at 18 decimals, either way round", () => {
  assert.strictEqual(v4.priceNativeFromSqrt(Q96, 18, true), 1);
  assert.strictEqual(v4.priceNativeFromSqrt(Q96, 18, false), 1);
});

test("price: decimals are undone, not ignored", () => {
  // 1 raw token == 1 wei, and the token has 6 decimals → one WHOLE token is
  // 1e6 wei = 1e-12 ETH. Getting this wrong is the 10^n class of error.
  assert.strictEqual(v4.priceNativeFromSqrt(Q96, 6, true), 1e-12);
});

test("price: the currency ordering is undone too", () => {
  // sqrtPriceX96 = 2 * 2^96 → P = 4 (raw currency1 per raw currency0).
  const sqrt = 2n * Q96;
  assert.strictEqual(v4.priceNativeFromSqrt(sqrt, 18, true), 4, "token is currency0 → 4 native per token");
  assert.strictEqual(v4.priceNativeFromSqrt(sqrt, 18, false), 0.25, "token is currency1 → the price inverts");
});

test("price: an uninitialised pool prices at zero, never at NaN", () => {
  assert.strictEqual(v4.priceNativeFromSqrt(0n, 18, true), 0);
});

test("currencies sort as v4 requires, and native is always currency0", () => {
  // v4 rejects a PoolKey whose currencies are not ascending, so a key built the
  // other way round is an id for a pool that cannot exist.
  const nat = v4.orderCurrencies(TOKEN, v4.NATIVE);
  assert.strictEqual(nat.currency0, v4.NATIVE, "address(0) sorts below everything");
  assert.strictEqual(nat.tokenIsZero, false);
  const w = v4.orderCurrencies(TOKEN, WETH);
  assert.ok(w.currency0 < w.currency1, "ascending");
  assert.strictEqual(w.tokenIsZero, w.currency0 === TOKEN);
});

test("poolId is keccak(abi.encode(PoolKey)) — the exact preimage v4 uses", () => {
  const id = v4.poolId(v4.NATIVE, TOKEN, 3000, 60);
  const expect = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "uint24", "int24", "address"],
    [v4.NATIVE, TOKEN, 3000, 60, v4.NATIVE],
  ));
  assert.strictEqual(id, expect);
  // Any field change is a different pool.
  assert.notStrictEqual(v4.poolId(v4.NATIVE, TOKEN, 500, 10), id);
});

test("v4 stays OFF until a PoolManager is configured", () => {
  // Same rule as the V3 block next to it: a guessed address on a money path is
  // worse than a disabled feature, so there is no baked default.
  withEnv({ ROBINHOOD_V4_POOLMANAGER: undefined }, () => {
    assert.strictEqual(v4.cfg("robinhood"), null);
    assert.strictEqual(v4.enabled("robinhood"), false);
  });
  withEnv({ ROBINHOOD_V4_POOLMANAGER: "0x" + "ab".repeat(20) }, () => {
    const c = v4.cfg("robinhood");
    assert.ok(c);
    assert.strictEqual(c.poolsSlot, v4.DEFAULT_POOLS_SLOT);
    assert.deepStrictEqual(c.tiers, v4.DEFAULT_TIERS);
  });
});

test("a malformed PoolManager address disables v4 rather than half-enabling it", () => {
  withEnv({ ROBINHOOD_V4_POOLMANAGER: "0xnope" }, () => assert.strictEqual(v4.cfg("robinhood"), null));
  withEnv({ ROBINHOOD_V4_POOLMANAGER: ethers.ZeroAddress }, () => assert.strictEqual(v4.cfg("robinhood"), null));
});

test("fee tiers and the storage slot are overridable per chain", () => {
  // A fork is free to lay its storage out differently, and a wrong slot reads
  // zeros — indistinguishable from "no pool" unless it can be corrected.
  withEnv({ ROBINHOOD_V4_POOLMANAGER: "0x" + "ab".repeat(20), ROBINHOOD_V4_POOLS_SLOT: "9", ROBINHOOD_V4_FEE_TIERS: "400:8,3000:60" }, () => {
    const c = v4.cfg("robinhood");
    assert.strictEqual(c.poolsSlot, 9);
    assert.deepStrictEqual(c.tiers, [[400, 8], [3000, 60]]);
  });
});

test("bestPool sweeps native AND wrapped native, over every tier", async () => {
  // Native first is the point: v4 takes ETH directly as address(0), which is what
  // a v4-era launch pairs against. Checking only WETH would miss the common case.
  const asked = [];
  const deps = {
    chainOf: () => ({ key: "robinhood", weth: WETH, native: "ETH" }),
    providerFor: () => ({}),
    poolState: async (_p, _c, id) => { asked.push(id); return null; },
  };
  await withEnv({ ROBINHOOD_V4_POOLMANAGER: "0x" + "ab".repeat(20) }, async () => {
    const res = await v4.bestPool(TOKEN, "robinhood", deps);
    assert.strictEqual(res, null, "nothing found → null, not a throw");
  });
  assert.strictEqual(new Set(asked).size, v4.DEFAULT_TIERS.length * 2, "4 tiers × { native, WETH }");
});

test("the deepest pool wins when several tiers exist", async () => {
  const o = v4.orderCurrencies(TOKEN, v4.NATIVE);
  const deep = v4.poolId(o.currency0, o.currency1, 10000, 200);
  const deps = {
    chainOf: () => ({ key: "robinhood", weth: WETH }),
    providerFor: () => ({}),
    poolState: async (_p, _c, id) => ({ sqrtPriceX96: Q96, liquidity: id === deep ? 999n : 1n }),
  };
  await withEnv({ ROBINHOOD_V4_POOLMANAGER: "0x" + "ab".repeat(20) }, async () => {
    const best = await v4.bestPool(TOKEN, "robinhood", deps);
    assert.strictEqual(best.liquidity, 999n);
    assert.strictEqual(best.fee, 10000);
  });
});

// ── Swapping ────────────────────────────────────────────────────────────────

const PM = "0x" + "ab".repeat(20);
const UR = "0x" + "cd".repeat(20);
const P2 = "0x" + "ef".repeat(20);
const POOL = { currency0: v4.NATIVE, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: v4.NATIVE };

test("reading and swapping are configured separately", () => {
  // A chain can price v4 without being able to fill a v4 swap. Conflating them
  // would put a Buy button on a card that cannot sign anything.
  withEnv({ ROBINHOOD_V4_POOLMANAGER: PM, ROBINHOOD_V4_UNIVERSAL_ROUTER: undefined }, () => {
    assert.strictEqual(v4.enabled("robinhood"), true, "prices");
    assert.strictEqual(v4.canSwap("robinhood"), false, "but cannot swap");
    assert.strictEqual(v4.swapCalldata("robinhood", POOL, { tokenIn: v4.NATIVE, amountIn: 1n, minOut: 1n, deadline: 1 }), null);
  });
});

test("a buy goes to the Universal Router, carrying the native amount as value", () => {
  withEnv({ ROBINHOOD_V4_POOLMANAGER: PM, ROBINHOOD_V4_UNIVERSAL_ROUTER: UR }, () => {
    const c = v4.swapCalldata("robinhood", POOL, { tokenIn: v4.NATIVE, amountIn: 10n ** 16n, minOut: 123n, deadline: 1770000000 });
    assert.strictEqual(c.to, UR);
    assert.strictEqual(c.value, 10n ** 16n, "native in is paid as msg.value");
    assert.strictEqual(c.zeroForOne, true, "native is currency0, so the swap is 0→1");
    // execute(bytes,bytes[],uint256) — the Universal Router's only entry point.
    assert.strictEqual(c.data.slice(0, 10), "0x3593564c");
  });
});

test("a sell sends no value — the token is pulled through Permit2", () => {
  withEnv({ ROBINHOOD_V4_POOLMANAGER: PM, ROBINHOOD_V4_UNIVERSAL_ROUTER: UR }, () => {
    const c = v4.swapCalldata("robinhood", POOL, { tokenIn: TOKEN, amountIn: 5n, minOut: 1n, deadline: 1 });
    assert.strictEqual(c.value, 0n, "an ERC20 in must not carry msg.value");
    assert.strictEqual(c.zeroForOne, false);
    assert.strictEqual(c.currencyOut, v4.NATIVE, "and it takes native out");
  });
});

test("the command and the action bytes are overridable per chain", () => {
  // Uniswap's published values, but this bot has already been burned by a
  // canonical address that did not match a fork. An action byte a deployment
  // numbers differently would build a transaction that does something other
  // than what it says.
  withEnv({ ROBINHOOD_V4_POOLMANAGER: PM, ROBINHOOD_V4_UNIVERSAL_ROUTER: UR }, () => {
    assert.strictEqual(v4.routerCfg("robinhood").command, v4.CMD_V4_SWAP);
    assert.strictEqual(v4.routerCfg("robinhood").swap, "06");
  });
  withEnv({ ROBINHOOD_V4_POOLMANAGER: PM, ROBINHOOD_V4_UNIVERSAL_ROUTER: UR, ROBINHOOD_V4_COMMAND: "0x11", ROBINHOOD_V4_ACTIONS: "07,0d,10" }, () => {
    const rc = v4.routerCfg("robinhood");
    assert.deepStrictEqual([rc.command, rc.swap, rc.settle, rc.take], ["0x11", "07", "0d", "10"]);
  });
});

test("simulate() turns a bad encoding into a refusal, not a sent transaction", async () => {
  const reverting = { call: async () => { throw new Error("execution reverted"); } };
  const r = await v4.simulate(reverting, "0x" + "11".repeat(20), { to: UR, data: "0x", value: 0n });
  assert.strictEqual(r.ok, false);
  assert.match(r.err, /revert/);
  const fine = { call: async () => "0x" };
  assert.strictEqual((await v4.simulate(fine, "0x" + "11".repeat(20), { to: UR, data: "0x", value: 0n })).ok, true);
});

test("selling refuses outright when Permit2 cannot be confirmed", async () => {
  // Returning "no approvals needed" here would send a swap the router cannot
  // fund, which reverts after paying gas. The address now defaults to the
  // canonical deterministic one, so the question is no longer "did an operator
  // set it" but "is there a contract there" — and a provider that cannot even
  // be asked is still a no.
  await withEnv({ ROBINHOOD_V4_POOLMANAGER: PM, ROBINHOOD_V4_UNIVERSAL_ROUTER: UR, ROBINHOOD_V4_PERMIT2: undefined }, async () => {
    assert.strictEqual(await v4.permit2Calls({}, "robinhood", TOKEN, "0x" + "11".repeat(20), 1n), null);
  });
});

// ── The Initialize event ────────────────────────────────────────────────────

test("the Initialize ABI declares its three indexed params", async () => {
  // The bug this exists for: a copy of the event WITHOUT `indexed` hashes to the
  // same topic0 (indexed does not affect the signature), so getLogs matches and
  // every matched log then fails to parse. v4-discover announced "hit in blocks
  // …" and printed nothing else — right filter, unreadable result.
  const iface = new ethers.Interface([v4.INITIALIZE_EVENT]);
  const frag = iface.getEvent("Initialize");
  assert.strictEqual(frag.inputs.filter((i) => i.indexed).length, 3, "id, currency0, currency1 are topics");
  assert.strictEqual(frag.topicHash, v4.INITIALIZE_TOPIC, "and the filter topic matches the parser");
});

test("a real-shaped Initialize log decodes to the whole PoolKey", () => {
  // Built the way a node emits one — three topics plus packed data — so this
  // fails if the ABI and the on-wire layout ever drift apart again.
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const id = v4.poolId(v4.NATIVE, TOKEN, 3000, 60);
  const log = {
    address: PM,
    topics: [
      v4.INITIALIZE_TOPIC,
      id,
      ethers.zeroPadValue(v4.NATIVE, 32),
      ethers.zeroPadValue(TOKEN, 32),
    ],
    data: coder.encode(["uint24", "int24", "address", "uint160", "int24"], [3000, 60, v4.NATIVE, Q96, 0]),
  };
  const d = new ethers.Interface([v4.INITIALIZE_EVENT]).parseLog(log);
  assert.ok(d, "it parses at all — this is what silently returned nothing before");
  assert.strictEqual(d.args[0], id);
  assert.strictEqual(String(d.args[1]).toLowerCase(), v4.NATIVE);
  assert.strictEqual(String(d.args[2]).toLowerCase(), TOKEN);
  assert.strictEqual(Number(d.args[3]), 3000);
  assert.strictEqual(Number(d.args[4]), 60);
  // And the id in the log is reproducible from the key we just read out of it —
  // the check v4-discover prints, which is what proves the encoding matches.
  assert.strictEqual(
    v4.poolId(String(d.args[1]).toLowerCase(), String(d.args[2]).toLowerCase(), Number(d.args[3]), Number(d.args[4]), d.args[5]),
    id,
  );
});

test("v4-discover uses the shared event, not a second copy of it", () => {
  // Two definitions is how the first one drifted. There must be exactly one.
  const src = fs.readFileSync(path.join(__dirname, "scripts", "v4-discover.js"), "utf8");
  assert.match(src, /v4\.INITIALIZE_EVENT/, "the parser comes from v4.js");
  assert.match(src, /v4\.INITIALIZE_TOPIC/, "and so does the filter");
  assert.ok(!/event Initialize\(/.test(src), "no local re-declaration of the event");
  // And it must never end without saying something.
  assert.match(src, /could not be decoded/, "undecodable logs are reported, not skipped");
  assert.match(src, /process\.exit\(3\)/, "and a run that decodes nothing exits non-zero");
});

// ── Depth-aware quoting ─────────────────────────────────────────────────────
//
// minOut used to come off the SPOT price, which charges no fee and has no depth
// term. On a $2k pool a $20 buy is 1% of the book, so spot said one thing, the
// pool paid another, and the gap came out of the user's slippage before their
// slippage had protected anything.

test("a quote charges the pool's fee — spot does not, and that was the bug", () => {
  // A 1:1 pool, deep enough that impact rounds away, so what is LEFT is the fee.
  const pool = { currency0: v4.NATIVE, currency1: TOKEN, fee: 3000, liquidity: 10n ** 24n, sqrtPriceX96: Q96 };
  const oneEth = 10n ** 18n;
  const out = v4.quoteExactIn(pool, oneEth, v4.NATIVE);
  // 0.30% off the top, and the remainder is what the curve actually pays.
  assert.ok(out < (oneEth * 9970n) / 10000n, "the fee is taken");
  assert.ok(out > (oneEth * 9960n) / 10000n, "and only the fee, on a pool this deep");
});

test("a quote prices DEPTH — the same buy pays less out of a thinner pool", () => {
  const deep = { currency0: v4.NATIVE, currency1: TOKEN, fee: 3000, liquidity: 10n ** 24n, sqrtPriceX96: Q96 };
  const thin = { ...deep, liquidity: 10n ** 19n };
  const spend = 10n ** 18n;
  assert.ok(v4.quoteExactIn(thin, spend, v4.NATIVE) < v4.quoteExactIn(deep, spend, v4.NATIVE),
    "impact is priced, which is the whole difference from a spot quote");
});

test("a quote knows which way round the swap goes", () => {
  // sqrtPriceX96 = 2·2^96 → currency0 is worth 4 of currency1. Selling
  // currency1 for currency0 must therefore pay out roughly a quarter as much,
  // not the same — a direction-blind quote sets minOut four times too high and
  // every trade reverts.
  const pool = { currency0: v4.NATIVE, currency1: TOKEN, fee: 0, liquidity: 10n ** 24n, sqrtPriceX96: 2n * Q96 };
  const amt = 10n ** 18n;
  const outOfZero = v4.quoteExactIn(pool, amt, v4.NATIVE);   // 0 → 1, pays ~4×
  const outOfOne = v4.quoteExactIn(pool, amt, TOKEN);        // 1 → 0, pays ~0.25×
  assert.ok(outOfZero > amt * 3n && outOfZero < amt * 5n, `0→1 pays about 4× (got ${outOfZero})`);
  assert.ok(outOfOne > amt / 5n && outOfOne < amt / 3n, `1→0 pays about a quarter (got ${outOfOne})`);
});

test("an unquotable pool returns 0, which is not a zero-value fill", () => {
  const base = { currency0: v4.NATIVE, currency1: TOKEN, fee: 3000, liquidity: 10n ** 24n, sqrtPriceX96: Q96 };
  assert.strictEqual(v4.quoteExactIn({ ...base, liquidity: 0n }, 10n ** 18n, v4.NATIVE), 0n, "no in-range liquidity");
  assert.strictEqual(v4.quoteExactIn({ ...base, sqrtPriceX96: 0n }, 10n ** 18n, v4.NATIVE), 0n, "uninitialised");
  assert.strictEqual(v4.quoteExactIn(base, 0n, v4.NATIVE), 0n, "nothing in, nothing out");
});

// ── Discovery ───────────────────────────────────────────────────────────────

const coder = ethers.AbiCoder.defaultAbiCoder();
const HOOK = "0x" + "99".repeat(20);

/** An Initialize log the way a node emits one: three topics, packed data. */
function initLog(emitter, currency0, currency1, fee, tickSpacing, hooks) {
  const id = v4.poolId(currency0, currency1, fee, tickSpacing, hooks);
  return {
    address: emitter,
    topics: [v4.INITIALIZE_TOPIC, id, ethers.zeroPadValue(currency0, 32), ethers.zeroPadValue(currency1, 32)],
    data: coder.encode(["uint24", "int24", "address", "uint160", "int24"], [fee, tickSpacing, hooks, Q96, 0]),
    blockNumber: 100,
  };
}
const swapLog = (emitter, sender) => ({
  address: emitter,
  topics: [v4.SWAP_TOPIC, "0x" + "00".repeat(32), ethers.zeroPadValue(sender, 32)],
  data: "0x",
  blockNumber: 101,
});

const fakeProvider = (logs) => ({
  getLogs: async ({ topics, address }) => logs.filter((l) => {
    if (address && String(address).toLowerCase() !== String(l.address).toLowerCase()) return false;
    return (topics || []).every((t, i) => t == null || (Array.isArray(l.topics) && String(l.topics[i]).toLowerCase() === String(t).toLowerCase()));
  }),
  getBlockNumber: async () => 200,
});
const depsWith = (provider) => ({
  chainOf: () => ({ key: "robinhood", weth: WETH, native: "ETH" }),
  providerFor: () => provider,
});

test("a HOOKED pool is found — the tier sweep can never construct its id", () => {
  // This is the difference between finding the token and not finding it. The
  // sweep can only try keys it can build, which means hookless ones at four
  // canonical fee tiers; a launchpad graduation is almost always into a hooked
  // pool, whose poolId the sweep therefore cannot reproduce at any tier.
  const o = v4.orderCurrencies(TOKEN, v4.NATIVE);
  const hooked = v4.poolId(o.currency0, o.currency1, 3000, 60, HOOK);
  const swept = new Set();
  for (const [fee, ts] of v4.DEFAULT_TIERS) swept.add(v4.poolId(o.currency0, o.currency1, fee, ts));
  assert.ok(!swept.has(hooked), "no hookless key can ever hash to a hooked pool's id");
});

test("discovery reads the whole PoolKey off the chain, hooks included", async () => {
  v4._resetDiscovery();
  const o = v4.orderCurrencies(TOKEN, v4.NATIVE);
  const provider = fakeProvider([initLog(PM, o.currency0, o.currency1, 3000, 60, HOOK)]);
  await withEnv({ ROBINHOOD_V4_POOLMANAGER: PM }, async () => {
    const keys = await v4.discoverPoolKeys(TOKEN, "robinhood", v4.cfg("robinhood"), depsWith(provider));
    assert.strictEqual(keys.length, 1);
    assert.strictEqual(keys[0].hooks, HOOK.toLowerCase(), "the hook travels with the key");
    assert.strictEqual(keys[0].id, v4.poolId(o.currency0, o.currency1, 3000, 60, HOOK).toLowerCase());
  });
});

test("bestPool reads the hooked pool the sweep missed, and swaps THAT key", async () => {
  v4._resetDiscovery();
  const o = v4.orderCurrencies(TOKEN, v4.NATIVE);
  const hookedId = v4.poolId(o.currency0, o.currency1, 3000, 60, HOOK).toLowerCase();
  const provider = fakeProvider([initLog(PM, o.currency0, o.currency1, 3000, 60, HOOK)]);
  const deps = {
    ...depsWith(provider),
    // ONLY the hooked pool exists on chain — every swept key reads as nothing.
    poolState: async (_p, _c, id) => (String(id).toLowerCase() === hookedId ? { sqrtPriceX96: Q96, liquidity: 42n } : null),
  };
  await withEnv({ ROBINHOOD_V4_POOLMANAGER: PM, ROBINHOOD_V4_UNIVERSAL_ROUTER: UR }, async () => {
    const best = await v4.bestPool(TOKEN, "robinhood", deps);
    assert.ok(best, "found — this returned null before, and the token read as untradeable");
    assert.strictEqual(best.hooks, HOOK.toLowerCase());
    // And the swap must be built from the key that was FOUND, not rebuilt
    // hookless: a hooked pool read at one id and swapped at another is a
    // transaction that does something other than what the card said.
    const call = v4.swapCalldata("robinhood", best, { tokenIn: v4.NATIVE, amountIn: 1n, minOut: 1n, deadline: 1 });
    assert.ok(call.data.toLowerCase().includes(HOOK.toLowerCase().slice(2)), "the hook is in the PoolKey we sign");
  });
});

test("the PoolManager is observed from the log that created the pool", async () => {
  v4._resetDiscovery();
  const o = v4.orderCurrencies(TOKEN, v4.NATIVE);
  const provider = fakeProvider([initLog(PM, o.currency0, o.currency1, 3000, 60, v4.NATIVE)]);
  await withEnv({ ROBINHOOD_V4_POOLMANAGER: undefined }, async () => {
    assert.strictEqual(v4.cfg("robinhood"), null, "nothing in .env");
    const found = await v4.discoverPoolManager("robinhood", TOKEN, depsWith(provider));
    assert.strictEqual(found, ethers.getAddress(PM), "whatever emitted Initialize IS the PoolManager");
    const live = await v4.cfgLive("robinhood", TOKEN, depsWith(provider));
    assert.ok(live && live.poolManager === ethers.getAddress(PM), "and the config builds off it");
  });
});

test("autodiscovery has an off switch, and off means off", async () => {
  v4._resetDiscovery();
  const o = v4.orderCurrencies(TOKEN, v4.NATIVE);
  const provider = fakeProvider([initLog(PM, o.currency0, o.currency1, 3000, 60, v4.NATIVE)]);
  await withEnv({ ROBINHOOD_V4_POOLMANAGER: undefined, ROBINHOOD_V4_AUTODISCOVER: "0" }, async () => {
    assert.strictEqual(await v4.discoverPoolManager("robinhood", TOKEN, depsWith(provider)), null);
    assert.strictEqual(await v4.cfgLive("robinhood", TOKEN, depsWith(provider)), null);
  });
});

test("a pool quoted in something we cannot value is not a quote", async () => {
  // Reading the price of a token against, say, USDC and then treating that
  // number as native is the 10^n class of error the whole price path is built
  // to avoid. Only native and wrapped native count.
  v4._resetDiscovery();
  const USDC = "0x" + "77".repeat(20);
  const o = v4.orderCurrencies(TOKEN, USDC);
  const provider = fakeProvider([initLog(PM, o.currency0, o.currency1, 3000, 60, v4.NATIVE)]);
  await withEnv({ ROBINHOOD_V4_POOLMANAGER: PM }, async () => {
    const keys = await v4.discoverPoolKeys(TOKEN, "robinhood", v4.cfg("robinhood"), depsWith(provider));
    assert.deepStrictEqual(keys, [], "dropped rather than priced in the wrong unit");
  });
});

test("the router is observed from the sender of a swap on this PoolManager", async () => {
  v4._resetDiscovery();
  const OTHER = "0x" + "22".repeat(20);
  const provider = fakeProvider([
    swapLog(PM, UR), swapLog(PM, UR), swapLog(PM, OTHER),
    swapLog("0x" + "33".repeat(20), "0x" + "44".repeat(20)),   // another contract's Swap — not ours
  ]);
  await withEnv({ ROBINHOOD_V4_POOLMANAGER: PM, ROBINHOOD_V4_UNIVERSAL_ROUTER: undefined }, async () => {
    const cands = await v4.routerCandidates("robinhood", v4.cfg("robinhood"), depsWith(provider));
    assert.deepStrictEqual(cands.map((a) => a.toLowerCase()), [UR, OTHER], "busiest first, and only this manager's");
  });
});

test("a candidate that cannot fill the swap never gets sent one", async () => {
  // The safety rail the discovery half rests on: an address is elected by
  // executing the exact calldata for free, not by looking plausible.
  v4._resetDiscovery();
  const BAD = "0x" + "22".repeat(20);
  const provider = {
    ...fakeProvider([swapLog(PM, BAD), swapLog(PM, BAD), swapLog(PM, UR)]),
    call: async ({ to }) => {
      if (String(to).toLowerCase() === BAD.toLowerCase()) throw new Error("execution reverted");
      return "0x";
    },
  };
  await withEnv({ ROBINHOOD_V4_POOLMANAGER: PM, ROBINHOOD_V4_UNIVERSAL_ROUTER: undefined }, async () => {
    const pool = { ...POOL, tokenIsZero: false };
    const opts = { tokenIn: v4.NATIVE, amountIn: 1n, minOut: 1n, deadline: 1 };
    const r = await v4.prepareSwap(provider, "robinhood", pool, "0x" + "11".repeat(20), opts, depsWith(provider));
    assert.ok(r.call, "the one that simulates wins");
    assert.strictEqual(r.router.toLowerCase(), UR, "even though it was the LESS busy candidate");
    assert.strictEqual(r.call.to.toLowerCase(), UR);
  });
});

test("when nothing can fill it, prepareSwap refuses instead of guessing", async () => {
  v4._resetDiscovery();
  const provider = {
    ...fakeProvider([swapLog(PM, UR)]),
    call: async () => { throw new Error("execution reverted: bad actions"); },
  };
  await withEnv({ ROBINHOOD_V4_POOLMANAGER: PM, ROBINHOOD_V4_UNIVERSAL_ROUTER: undefined }, async () => {
    const r = await v4.prepareSwap(provider, "robinhood", { ...POOL, tokenIsZero: false },
      "0x" + "11".repeat(20), { tokenIn: v4.NATIVE, amountIn: 1n, minOut: 1n, deadline: 1 }, depsWith(provider));
    assert.ok(!r.call, "no call");
    assert.match(r.err, /bad actions/, "and the node's own reason, not a shrug");
  });
});

test("a demoted router goes to the back of the queue", async () => {
  // A SELL has to approve before it can simulate, so a wrong top candidate
  // cannot just be skipped mid-trade — the next has no allowance either. Without
  // demotion the retry approves the same wrong address and fails identically.
  v4._resetDiscovery();
  const OTHER = "0x" + "22".repeat(20);
  const provider = fakeProvider([swapLog(PM, UR), swapLog(PM, UR), swapLog(PM, OTHER)]);
  await withEnv({ ROBINHOOD_V4_POOLMANAGER: PM, ROBINHOOD_V4_UNIVERSAL_ROUTER: undefined }, async () => {
    const deps = depsWith(provider);
    assert.strictEqual((await v4.routerCandidates("robinhood", v4.cfg("robinhood"), deps))[0].toLowerCase(), UR);
    v4.demoteRouter("robinhood", UR);
    assert.strictEqual((await v4.routerCandidates("robinhood", v4.cfg("robinhood"), deps))[0].toLowerCase(), OTHER,
      "the retry tries somebody else");
  });
});

// ── Permit2 ─────────────────────────────────────────────────────────────────

test("Permit2 defaults to its deterministic address, but only where it exists", async () => {
  // Same address on every chain deployed through the CREATE2 factory — a derived
  // constant, not a guess. "Most chains" is still not "this chain", so approving
  // a token to an address with no code there would burn a transaction and leave
  // the sell to revert anyway.
  v4._resetDiscovery();
  const OWNER = "0x" + "11".repeat(20);
  await withEnv({ ROBINHOOD_V4_POOLMANAGER: PM, ROBINHOOD_V4_UNIVERSAL_ROUTER: UR, ROBINHOOD_V4_PERMIT2: undefined }, async () => {
    assert.strictEqual(v4.routerCfg("robinhood").permit2, v4.CANONICAL_PERMIT2, "defaulted");
    const empty = { getCode: async () => "0x" };
    assert.strictEqual(await v4.permit2Calls(empty, "robinhood", TOKEN, OWNER, 1n), null, "no code → refuse the sell");
    const unreachable = { getCode: async () => { throw new Error("rpc down"); } };
    assert.strictEqual(await v4.permit2Calls(unreachable, "robinhood", TOKEN, OWNER, 1n), null,
      "and an unverifiable spender on the exit path is also a no");
  });
});

test("a discovered router gets THIS sell's allowance, not a standing one", async () => {
  // The swap is protected by simulation and by minOut, but a Permit2 allowance
  // outlives the trade — it is a standing right to move the token out of the
  // wallet. An address nobody vouched for does not get one.
  v4._resetDiscovery();
  const OWNER = "0x" + "11".repeat(20);
  const AMOUNT = 123456789n;
  // Enough of a provider for ethers to read allowances back as zero.
  const provider = { getCode: async () => "0x60006000", call: async () => "0x" + "00".repeat(32), getBlockNumber: async () => 1 };
  const amountHex = AMOUNT.toString(16).padStart(64, "0");
  await withEnv({ ROBINHOOD_V4_POOLMANAGER: PM, ROBINHOOD_V4_UNIVERSAL_ROUTER: UR, ROBINHOOD_V4_PERMIT2: P2 }, async () => {
    const configured = await v4.permit2Calls(provider, "robinhood", TOKEN, OWNER, AMOUNT);
    const p2call = configured.find((c) => c.to.toLowerCase() === P2.toLowerCase());
    assert.ok(p2call.data.includes("f".repeat(40)), "an operator-set router gets the standing max allowance");
    const observed = await v4.permit2Calls(provider, "robinhood", TOKEN, OWNER, AMOUNT, "0x" + "aa".repeat(20));
    const p2obs = observed.find((c) => c.to.toLowerCase() === P2.toLowerCase());
    assert.ok(p2obs.data.includes(amountHex), "a discovered one gets exactly this sell and nothing more");
    assert.ok(!p2obs.data.includes("f".repeat(40)), "and never the max");
  });
});
