// Tokens whose liquidity sits on a venue the engine cannot route through —
// Uniswap v4 above all.
//
// v4 keeps every pool inside ONE PoolManager singleton, keyed by a hash of the
// PoolKey. There is no pair contract and no per-pool contract, so V2's getPair
// and V3's getPool both come back empty and bestDexVenue finds nothing. The bot
// answered such a token with "❌ Couldn't price <ca> on <chain>. This usually
// means it hasn't got a pool yet… or it trades on another chain" — neither of
// which is true, and both of which read as a broken bot.
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert");
const core = require("./core");

const CA = "0x10472b42E3b22A5B98D0820A55cc6Fd9034f4663";

/** A DexScreener response: one Uniswap v4 pool on Ethereum. */
function dsResponse(pairs) {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ pairs }) });
  return () => { global.fetch = realFetch; };
}

const V4_PAIR = {
  chainId: "ethereum",
  dexId: "uniswap",
  labels: ["v4"],
  priceUsd: "0.0042",
  marketCap: 4200000,
  liquidity: { usd: 310000 },
  volume: { h24: 88000 },
  baseToken: { name: "Sample Token", symbol: "SMPL" },
};

test("a Uniswap v4 market is found, and named as v4", async () => {
  const restore = dsResponse([V4_PAIR]);
  try {
    core._clearReadCaches();
    const m = await core.dsMarket(CA, "ethereum");
    assert.ok(m, "the market is visible to the indexer even with no pair contract");
    assert.strictEqual(m.priceUsd, 0.0042);
    assert.strictEqual(m.liqUsd, 310000);
    // DexScreener reports v4 as dexId "uniswap" + a "v4" LABEL. Reading only the
    // dexId would tell the user "Uniswap", which is a venue the bot DOES route
    // through — the exact wrong impression.
    assert.strictEqual(core.dsVenueLabel(m), "Uniswap v4");
  } finally { restore(); }
});

test("the deepest market decides which chain a pasted CA belongs to", async () => {
  const restore = dsResponse([
    { ...V4_PAIR, chainId: "base", liquidity: { usd: 10 } },
    { ...V4_PAIR, chainId: "ethereum", liquidity: { usd: 999999 } },
  ]);
  try {
    core._clearReadCaches();
    const chains = await core.dsChainsOf(CA);
    assert.strictEqual(chains[0], "ethereum", "deepest first");
    assert.ok(chains.includes("base"));
  } finally { restore(); }
});

test("a chain with no market on it is never returned", async () => {
  const restore = dsResponse([{ ...V4_PAIR, priceUsd: "0" }]);
  try {
    core._clearReadCaches();
    assert.deepStrictEqual(await core.dsChainsOf(CA), []);
    assert.strictEqual(await core.dsMarket(CA, "ethereum"), null);
  } finally { restore(); }
});

test("an indexer that is down changes nothing", async () => {
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error("ENOTFOUND"); };
  try {
    core._clearReadCaches();
    assert.deepStrictEqual(await core.dsChainsOf(CA), []);
    assert.strictEqual(await core.dsMarket(CA, "ethereum"), null);
  } finally { global.fetch = realFetch; }
});

// ── The card and the buy path ────────────────────────────────────────────────
const TG = fs.readFileSync(path.join(__dirname, "telegram.js"), "utf8");
const CORE = fs.readFileSync(path.join(__dirname, "core.js"), "utf8");

test("an unroutable token gets a card with NO buy button", () => {
  // The whole point of the separate card: every Buy/Sell control on the normal
  // one would build a swap that cannot be filled. A trade screen that quotes a
  // price it can't honour is worse than one that says it can't.
  const start = TG.indexOf("function unroutableCard(");
  assert.ok(start > -1, "the unroutable card still exists");
  const body = TG.slice(start, TG.indexOf("\n}", start));
  assert.ok(!/\bbuy[:_]/i.test(body), "no buy callback is offered");
  assert.match(body, /extVenue/, "it names the venue it cannot route through");
  assert.match(body, /Chart/, "and still gives somewhere to go");
});

test("the card is reached before the buy controls are built", () => {
  const guard = TG.indexOf("if (info.routable === false) return unroutableCard(");
  const meta = TG.indexOf("const meta = await core.tokenMeta(ca, chainKey);");
  assert.ok(guard > -1 && meta > guard, "the guard sits ahead of the tradeable card");
});

test("the buy path routes v4 first, and names the venue when it cannot", () => {
  // The old message ("no pool? try again") told the user to retry a buy that
  // could never fill, however many times they pressed it.
  const i = CORE.indexOf("if (pick.kind === 'v2' && !_v2Fillable(pick)) {");
  assert.ok(i > -1, "the no-fillable-pair branch is still in the buy path");
  const body = CORE.slice(i, CORE.indexOf("if (!hash) {", i));
  assert.match(body, /v4\.bestPool\(/, "a v4 pool is tried before giving up");
  assert.match(body, /v4\.prepareSwap\(/, "and simulated before anything is signed");
  assert.match(body, /dsVenueLabel\(m\)/, "the venue is named when there is nothing to route");
  // The order matters: naming the venue is the FALLBACK, not the first answer.
  assert.ok(body.indexOf("v4.bestPool") < body.indexOf("dsVenueLabel"), "v4 is tried first");
  // And the pool lookup must NOT be gated on the router being configured. It
  // was, and an operator who had not pasted a Universal Router into .env was
  // indistinguishable — to the person pressing Buy — from a token that does not
  // trade anywhere. Discovery is the whole point; a canSwap() gate defeats it.
  // Matching the CALL, not the name: the comment above the branch says why the
  // gate was removed, and a test that trips over its own explanation is a test
  // nobody trusts the next time it goes red.
  assert.doesNotMatch(body, /v4\.canSwap\([^)]*\)\s*(\?|&&)/, "the pool lookup is not gated on env config");
});

test("a v4 buy pays the currency the POOL takes, not always native", () => {
  // v4 pairs against ETH directly (address(0)) OR against WETH. Paying every
  // pool in native made zeroForOne come out backwards on a WETH-quoted one,
  // which builds a SELL while the user is buying.
  const i = CORE.indexOf("if (pick.kind === 'v2' && !_v2Fillable(pick)) {");
  const body = CORE.slice(i, CORE.indexOf("if (!hash) {", i));
  assert.match(body, /payWith = String\(p4\.quote\)/, "the pool's own quote currency decides");
  assert.match(body, /tokenIn: payWith/, "and that is what the swap is built with");
  assert.match(body, /encodeFunctionData\('deposit'/, "a WETH-quoted pool gets its native wrapped first");
});

test("a v4 sell out of a WETH-quoted pool books the WETH, not a zero", () => {
  // Native-balance accounting on a pool that pays WETH books a confirmed,
  // profitable exit as zero proceeds — no fee, a total loss in the PnL — and
  // leaves the WETH sitting in the wallet with nothing to unwrap it.
  const i = CORE.indexOf("if (p4Sell) {");
  assert.ok(i > -1, "the v4 sell branch is still there");
  const body = CORE.slice(i, CORE.indexOf("} else if (onCurve) {", i));
  assert.match(body, /v4QuoteToken/, "the payout currency is tracked");
  assert.match(body, /v3ProceedsWei = gained/, "and the WETH delta is what the accounting reads");
  assert.match(body, /encodeFunctionData\('withdraw'/, "the proceeds are unwrapped back to native");
});

test("routable is set on BOTH snapshot returns, not just the new one", () => {
  // A missing flag on the normal path reads as undefined, which is not === false
  // — so it would still trade, but the field would silently mean nothing.
  const rets = CORE.match(/routable: (true|false)/g) || [];
  assert.ok(rets.includes("routable: true") && rets.includes("routable: false"));
});

// ── Two indexers, and a failure card that says what it checked ───────────────

test("GeckoTerminal answers when DexScreener does not", async () => {
  // One indexer is a single point of failure the operator cannot see past:
  // DexScreener throttles datacenter IPs, and an empty response from a throttled
  // request is indistinguishable from "this token has no market".
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("dexscreener")) return { ok: true, json: async () => ({ pairs: [] }) };
    return { ok: true, json: async () => ({ data: [{
      attributes: { base_token_price_usd: "0.0042", reserve_in_usd: "310000", fdv_usd: "4200000", name: "SMPL / WETH" },
      relationships: { dex: { data: { id: "uniswap-v4" } } },
    }] }) };
  };
  try {
    core._clearReadCaches();
    const m = await core.marketOf(CA, "ethereum");
    assert.ok(m, "the second opinion found it");
    assert.strictEqual(core.dsVenueLabel(m), "Uniswap v4", "and names the venue whole");
    // The probe asks the chain the user is ON first, and stops there — one
    // request per paste instead of one per enabled chain, which is what got the
    // free index answering 429.
    const probe = await core.marketProbe(CA, "ethereum");
    assert.deepStrictEqual(probe.chains, ["ethereum"]);
    assert.strictEqual(probe.source, "geckoterminal");
    assert.strictEqual(probe.degraded, false);
  } finally { global.fetch = realFetch; }
});

test("the probe reports what it checked when nothing is found", async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => ({ ok: true, json: async () => (String(url).includes("dexscreener") ? { pairs: [] } : { data: [] }) });
  try {
    core._clearReadCaches();
    const probe = await core.marketProbe(CA);
    assert.deepStrictEqual(probe.chains, []);
    assert.ok(probe.checked.length > 1, "it names every chain it looked on");
    assert.strictEqual(probe.source, "none");
    assert.strictEqual(probe.degraded, false, "the indexes answered — they just had nothing");
  } finally { global.fetch = realFetch; }
});

test("an EVM address is lowercased for the indexers, a Solana mint is not", async () => {
  // A CA pasted from a block explorer is EIP-55 checksummed. Base58 is
  // case-SIGNIFICANT, so the same treatment would destroy a Solana mint.
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => { seen.push(String(url)); return { ok: true, json: async () => ({ pairs: [] }) }; };
  try {
    core._clearReadCaches();
    await core.dsMarket(CA, "ethereum");
    assert.ok(seen.some((u) => u.includes(CA.toLowerCase())), "checksummed EVM address went out lowercased");
    seen.length = 0;
    core._clearReadCaches();
    const mint = "G9j8WWDeJXZdvwQgP82ooDuHmpc3Gy8NCSins71Lpump";
    await core.dsMarket(mint, "solana");
    assert.ok(seen.some((u) => u.includes(mint)), "the base58 mint went out untouched");
  } finally { global.fetch = realFetch; }
});

test("the dead-end card points at the chain that has the market", () => {
  const i = TG.indexOf("const probe = await core.marketProbe(ca,");
  assert.ok(i > -1, "the failure path still probes for a market");
  const body = TG.slice(i, i + 2400);
  assert.match(body, /Open on \$\{c\.name\}/, "it offers to open the card on the right chain");
  assert.match(body, /tok:\$\{c\.key\}::\$\{ca\}/, "wired to the real card callback");
  assert.match(body, /DexScreener, GeckoTerminal/, "and names what it consulted when it finds nothing");
  assert.match(body, /probe\.degraded/, "a throttled index is not reported as 'no market'");
});

test("a throttled index is reported as 'nobody answered', not 'no market'", async () => {
  // A 429 and an empty result used to arrive identically, and the card then
  // stated as fact that the token trades nowhere — about a token it had priced
  // twenty minutes earlier. That is the difference between a fact and a guess.
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  try {
    core._clearReadCaches();
    const probe = await core.marketProbe(CA, "robinhood");
    assert.deepStrictEqual(probe.chains, []);
    assert.strictEqual(probe.degraded, true);
  } finally { global.fetch = realFetch; }
});

test("a throttled answer is never cached", async () => {
  // Caching one rate-limited second for 30s spreads it across every paste in
  // the next half minute.
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 429, json: async () => ({}) }; };
  try {
    core._clearReadCaches();
    await core.dsMarket(CA, "ethereum");
    await core.dsMarket(CA, "ethereum");
    assert.strictEqual(calls, 2, "it asked again rather than replaying the failure");
  } finally { global.fetch = realFetch; }
});

test("an empty V2 pair is not a market, and does not block the v4 route", () => {
  // A pair CONTRACT existing is not liquidity. A token whose V2 pair was
  // deployed and never funded — or drained when the liquidity moved to v4 —
  // sent every buy down the V2 leg, where getAmountsOut returns nothing and the
  // trade died on "no liquidity / zero quote" with a funded v4 pool right there.
  const i = CORE.indexOf("const _v2Fillable =");
  assert.ok(i > -1, "the fillability check exists");
  assert.match(CORE.slice(i, i + 200), /pick\.pair && pick\.wethBal > 0n/, "a pair with no reserve is not fillable");
  // And both money paths gate on it, not on the address alone.
  assert.ok(!/pick\.kind === 'v2' && !pick\.pair/.test(CORE), "no caller still gates on the bare address");
  // ⚠️ COUNTED BY SITE, and the count is what makes this a guard rather than a
  // grep: it fails when a gate DISAPPEARS as loudly as when an unreviewed one
  // appears. The four are the buy's routing decision, the sell's (`noAmm`), and
  // the two quote-token swap legs, which route into and out of the token a
  // launchpad curve charges in and are subject to the same rule — a pair
  // CONTRACT existing is not liquidity.
  assert.strictEqual((CORE.match(/!_v2Fillable\(pick\)/g) || []).length, 3, "buy, sell, and the quote-token swap-back");
  assert.strictEqual((CORE.match(/\} else if \(_v2Fillable\(pick\)\)/g) || []).length, 1, "and the quote-token buy leg, positively");
});

// ── a pool quoted in a THIRD token ───────────────────────────────────────────
//
// `bestPool` finds a pool of ANY pairing — `discoverPoolKeys` reads the whole
// PoolKey off the Initialize log and takes whichever currency is not ours,
// verified by recomputing the poolId. The PAYMENT side did not keep up: it read
// "not native ⇒ WETH", so a pool quoted in a third token wrapped the user's
// native into WETH, approved WETH, and then tried to swap a token it did not
// hold. That is why a Pons token on Robinhood Chain would not trade — $CD's
// pool is quoted in NVDA. The venue was found and the payment was built in the
// wrong currency.

test("⚠️ the v4 buy pays in the pool's OWN quote, not 'native or else WETH'", () => {
  const i = CORE.indexOf("if (pick.kind === 'v2' && !_v2Fillable(pick)) {");
  const body = CORE.slice(i, CORE.indexOf("if (!hash) {", i));
  // WETH is now recognised as ITSELF, not as "anything that is not native".
  assert.match(body, /const wrapping = !!wethAddr && payWith === wethAddr;/, "the WETH branch still claims every non-native quote");
  assert.match(body, /const foreign = payWith !== v4\.NATIVE && !wrapping;/, "a third currency is not distinguished at all");
  // …and a third currency is ACQUIRED, through the two legs that already exist
  // rather than a second private idea of the same thing.
  assert.match(body, /if \(foreign\) \{\s*\n\s*const leg = await _acquireQuote\(/, "a foreign-quoted pool is never bought into");
  // The swap must be SIZED in what was acquired. Quoting a foreign-quoted pool
  // with the native amount prices the trade in the wrong unit entirely.
  assert.match(body, /v4\.quoteExactIn\(p4, payAmt, payWith\)/, "the quote is still sized in native");
  assert.match(body, /amountIn: payAmt/, "the swap is still built with the native amount");
  assert.ok(!/amountIn: spend/.test(body), "a native amount still reaches the v4 swap");
});

test("⚠️ …and every failure after leg one SAYS what the wallet is holding", () => {
  // Money that moved and did not arrive where the user expected is a fact they
  // are owed immediately, not one they find in a block explorer — the precedent
  // the WETH branch set with "Your ETH is safe as WETH in the wallet".
  const i = CORE.indexOf("if (pick.kind === 'v2' && !_v2Fillable(pick)) {");
  const body = CORE.slice(i, CORE.indexOf("if (!hash) {", i));
  assert.match(body, /const safe = foreign/, "there is no held-funds sentence for the foreign leg");
  for (const site of [/did not price — try again\.\$\{safe\}/, /zero quote from the v4 pool for this token\.\$\{safe\}/, /would revert \(\$\{prep\.err\}\) — nothing was sent\.\$\{safe\}/]) {
    assert.match(body, site, `a failure path after leg one says nothing about the funds: ${site}`);
  }
});

test("⚠️ the v4 SELL tracks the payout currency it will actually receive", () => {
  // The same wrong reading with a worse ending: watching the WETH balance on a
  // pool that pays a third token sees no change, books gained = 0 — a confirmed,
  // profitable exit recorded as a total loss — and then calls withdraw() on a
  // contract that has no such function, stranding the proceeds.
  const i = CORE.indexOf("if (p4Sell) {");
  const body = CORE.slice(i, CORE.indexOf("} else if (onCurve) {", i));
  assert.match(body, /v4QuoteToken = p4Quote === v4\.NATIVE \? null : p4Quote;/, "the sell still assumes a non-native payout is WETH");
  assert.ok(!/v4QuoteToken = String\(p4Sell\.quote\)\.toLowerCase\(\) === v4\.NATIVE \? null : chain\.weth/.test(body), "the old assumption is back");
  // withdraw() is for WETH ONLY; a third currency is swapped back instead.
  assert.match(body, /if \(wethOut\) \{/, "unwrapping is not gated on the payout actually BEING WETH");
  assert.match(body, /_dumpQuote\(wallet, chainKey, v4QuoteToken, gained/, "a foreign payout is never returned to native");
});

test("⚠️ a foreign-quoted pool does not PRICE the card — that would be a wrong number", () => {
  // `priceEth` comes straight off sqrtPriceX96, so on a pool paired against a
  // third token it is a price in THAT token. Printing it as native is a wrong
  // number rather than a missing one, and it feeds mcapEth and the USD cap too.
  assert.match(CORE, /const p4Native = !!p4 && \(p4Quote === v4\.NATIVE \|\| \(_isAddr\(chain\.weth\) && p4Quote === String\(chain\.weth\)\.toLowerCase\(\)\)\);/);
  assert.match(CORE, /const v4Alt = p4 && !p4Native \? p4 : null;/);
  assert.match(CORE, /if \(p4 && p4Native\) \{/, "the v4 branch still prices any pool it finds");
  // …but the ROUTE it proves still reaches the card, or the fix would take the
  // Buy button away from exactly the tokens it exists to make buyable.
  assert.match(CORE, /if \(v4Alt && await v4\.canSwapLive\(/, "a foreign-quoted pool loses its Buy button");
  assert.match(CORE, /dexVenue: 'v4', v4: v4Alt, routable: true/);
});

/*
 * ⚠️ `poolId` IS HAND-ENCODED, so its equivalence to the coder is a TEST, not a
 * comment. It was rewritten because `AbiCoder.encode` costs ~156µs and
 * `v4Calldata` hashes thousands of candidate assignments to find a pool in a
 * router's calldata — 20,000 of those is 3.1s through the coder and 0.45s
 * through this. A hand-rolled encoder is exactly the kind of thing that agrees
 * on the easy cases, so the cases here are the ones that break one: a NEGATIVE
 * tickSpacing (two's complement), both int boundaries, and a zero fee.
 */
test('poolId is byte-identical to abi.encode — including negative ticks and the boundaries', () => {
  const { ethers } = require('ethers');
  const v4 = require('./v4.js');
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const ref = (a, b, f, t, h) => ethers.keccak256(coder.encode(
    ['address', 'address', 'uint24', 'int24', 'address'], [a, b, f, t, h]));
  const A = '0x1111111111111111111111111111111111111111';
  const B = '0xe29c005941845f7e5ec2009f86c4478746d33b2c';
  const Z = '0x0000000000000000000000000000000000000000';
  const cases = [
    [A, B, 3000, 60, Z],
    [A, B, 0, -120, A],                 // negative tickSpacing
    [A, B, 16777215, 8388607, B],       // uint24 max, int24 max
    [A, B, 100, -8388608, A],           // int24 min
    [B, A, 500, 1, Z],
  ];
  for (const c of cases) assert.equal(v4.poolId(...c), ref(...c), `poolId disagrees for ${JSON.stringify(c)}`);
  // The default hooks argument must still be the zero address.
  assert.equal(v4.poolId(A, B, 3000, 60), ref(A, B, 3000, 60, Z));
});
