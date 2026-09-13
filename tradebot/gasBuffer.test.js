// Two checks of the same thing read two different numbers, and it produced the
// loudest bug in the product: "⚠️ A snipe on Ethereum failed: insufficient ETH
// — need ~0.016 incl. gas, have 0.01499 (muted 5 min)", every new Ethereum
// pair, all day, for a wallet that was simply too small to snipe.
//
// watchers.js pre-checked the balance against CFG.gasBufferEth (0.0004) and
// skipped silently if short. buy() then demanded ETH_GAS_BUFFER (0.006). A
// wallet holding 0.01499 cleared the cheap check, entered buy(), and threw —
// so the silent skip never ran and the loud failure always did.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
/** Source with comments stripped — the comments above these fixes quote the old
 *  constants on purpose, so counting "how many places read X" has to ignore
 *  them or it counts the explanation as a second reader. */
const code = (f) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
let ethersOk = true;
try {
  require("ethers");
} catch {
  ethersOk = false;
}

test("the gas reserve has exactly one definition", () => {
  const core = code("core.js");
  const hits = core.match(/ETH_GAS_BUFFER/g) || [];
  assert.strictEqual(hits.length, 1, "ETH_GAS_BUFFER must be read in one place only");
  assert.match(core, /function gasBufferWei\(chainKey\)/);
  assert.match(core, /module\.exports = \{\n\s*gasBufferWei,/, "and be exported for callers");
});

test("buy() and the snipe pre-check reserve the same amount", () => {
  // The whole defect in one assertion: if these ever read different numbers
  // again, a user gets the failure notice on every pair instead of a skip.
  assert.match(code("core.js"), /const gasBuf = gasBufferWei\(chainKey\);/);
  const w = code("watchers.js");
  // ONE pre-check for every launch source now. This used to be two copies (the
  // Robinhood factory scan and the EVM pair scan) and a fourth source would have
  // made it three — three places for the reserve to drift back apart from
  // buy()'s, which is the defect this whole file exists for. `_canAfford` is the
  // single owner; the EVM branch is the only non-Solana `need` in the file.
  const needs = (w.match(/const need = [^;]+;/g) || []).filter((n) => !/solana\./.test(n));
  assert.strictEqual(needs.length, 1, "the EVM snipe pre-check has more than one definition again");
  for (const n of needs) {
    assert.match(n, /core\.gasBufferWei\(/, `still reading its own buffer: ${n}`);
    assert.ok(!/CFG\.gasBufferEth/.test(n), `must not reserve the L2 default on L1: ${n}`);
  }
  // And every discovery source reaches it through that one owner, rather than
  // reading a balance for itself.
  assert.match(w, /async function _canAfford\(u, chainKey\)/);
  assert.strictEqual((w.match(/await _canAfford\(u, chainKey\)/g) || []).length, 1, "a snipe path grew its own affordability check");
});

test("Solana never had the bug, and keeps its own matching pair", () => {
  // Its pre-check and its buy both read CFG.solGasBuffer. Worth pinning: the
  // fix above would be pointless if the same mistake were sitting on Solana.
  assert.match(code("watchers.js"), /solana\.solToLamports\(core\.CFG\.solGasBuffer\)/);
  assert.match(code("core.js"), /const gasBuf = solana\.solToLamports\(CFG\.solGasBuffer\);/);
});

test("Ethereum reserves far more than the L2 default — that is the point", (t) => {
  if (!ethersOk) return t.skip("ethers not installed in this checkout");
  const { ethers } = require("ethers");
  const core = require("./core");
  const eth = core.gasBufferWei("ethereum");
  const l2 = core.gasBufferWei("base");
  assert.ok(eth > l2, "L1 gas dwarfs L2; the reserve has to follow");
  assert.strictEqual(ethers.formatEther(eth), "0.006");
  // The exact wallet from the incident: 0.01499 ETH, sniping 0.01.
  const bal = ethers.parseEther("0.01499");
  const need = ethers.parseEther("0.01") + eth;
  assert.ok(bal < need, "this wallet cannot afford the snipe…");
  assert.ok(bal > ethers.parseEther("0.01") + l2, "…but it DID clear the old, smaller check");
});

test("a wallet that cannot afford it is told ONCE — not per pair, hour or balance", () => {
  const w = code("watchers.js");
  assert.match(w, /function _affordCheck\(u, chainKey, bal, need\)/);
  // Once means once. A balance drifts constantly (gas spent elsewhere, dust
  // arriving), so keying on it still produced a stream; keying on a clock
  // produces one per window for as long as the wallet stays small, for ever.
  assert.match(w, /if \(!flags\[chainKey\]\) \{/, "the flag is the gate");
  // The function BODY, not the call sites — the buy-failure handler right below
  // one of them legitimately uses a clock.
  const body = w.slice(w.indexOf("function _affordCheck("));
  assert.ok(!body.slice(0, body.indexOf("\n}\n")).includes("Date.now()"), "no timer in the decision itself");
  assert.ok(!/_shortAt/.test(w), "the old balance-keyed map is gone");
  assert.match(w, /Snipe skipped/, "it says what happened");
  assert.match(w, /you will not be told about this again/, "…and promises exactly what it does");
});

test("the notice survives a restart, and re-arms only when the wallet can afford it", () => {
  const w = code("watchers.js");
  // On the user record, not in memory: a restart must not re-announce it.
  assert.match(w, /u\._shortAlert = u\._shortAlert \|\| \{\}/);
  assert.match(w, /core\.saveStoreNow\(\)/, "and is persisted");
  // The one event that clears it is the problem going away.
  assert.match(w, /if \(bal >= need\) \{[\s\S]{0,160}delete flags\[chainKey\]/);
});

test("both worlds route a shortfall through it", () => {
  const w = code("watchers.js");
  // Both branches of `_canAfford` — EVM and Solana. The Solana one used to skip
  // SILENTLY ("can't afford → skip silently"), so a snipe armed on an empty
  // Solana wallet was an armed watch that could never fire and never said why:
  // the inert-watch failure, on the money path.
  const calls = w.match(/!_affordCheck\(u, chainKey, bal, need\)/g) || [];
  assert.strictEqual(calls.length, 2, "the EVM branch and the Solana branch of _canAfford");
  assert.match(w, /if \(!\(await _canAfford\(u, chainKey\)\)\) return;/, "the shared fire path stopped checking");
});
