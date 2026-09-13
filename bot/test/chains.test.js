const test = require("node:test");
const assert = require("node:assert");
const { isValidAddress, nativeOf, familyOf, CHAIN_IDS } = require("../src/config/chains");

test("per-chain address validation", () => {
  assert.ok(isValidAddress("ethereum", "0x6982508145454Ce325dDbE47a25d4ec3d2311933"));
  assert.ok(!isValidAddress("ethereum", "0x123")); // too short
  assert.ok(isValidAddress("solana", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"));
  assert.ok(!isValidAddress("solana", "0x6982508145454Ce325dDbE47a25d4ec3d2311933")); // wrong shape
  assert.ok(isValidAddress("tron", "TJbzsH9B6tkZ9VuYJ331DHdhhUi9nRvwy7"));
  assert.ok(isValidAddress("ton", "UQBxxnts7h2SsM123456789012345678901234567890abcd"));
  assert.ok(!isValidAddress("bsc", "not-an-address"));
});

test("native + family mapping", () => {
  assert.strictEqual(nativeOf("solana"), "SOL");
  assert.strictEqual(nativeOf("base"), "ETH");
  assert.strictEqual(nativeOf("bsc"), "BNB");
  assert.strictEqual(nativeOf("tron"), "TRX");
  assert.strictEqual(familyOf("robinhood"), "evm");
  assert.strictEqual(familyOf("ton"), "ton");
});

test("all supported chains present", () => {
  assert.deepStrictEqual(
    [...CHAIN_IDS].sort(),
    [
      "base", "bsc", "ethereum", "plasma", "robinhood", "solana", "sui", "ton", "tron",
      "polygon", "arbitrum", "optimism", "avalanche", "berachain", "sonic", "hyperevm", "abstract",
      "apechain", "blast", "sei", "aptos", "unichain",
    ].sort(),
  );
});

test("added chains settle in BNB (payVia bsc) with a valid price", () => {
  const { payChainOf, payNativeOf, PAYABLE_CHAIN_IDS } = require("../src/config/chains");
  const { tierPrice, trendingForChain } = require("../src/config/packages");
  for (const ch of [
    "polygon", "arbitrum", "optimism", "avalanche", "berachain", "sonic", "hyperevm", "abstract",
    "apechain", "blast", "sei", "aptos", "unichain",
  ]) {
    assert.strictEqual(payChainOf(ch), "bsc", `${ch} pays via bsc`);
    assert.strictEqual(payNativeOf(ch), "BNB", `${ch} pays in BNB`);
    assert.strictEqual(tierPrice("DIAMOND", ch), 1.5, `${ch} Diamond = 1.5 BNB`);
    assert.strictEqual(tierPrice("XPRESS", ch), 0.25, `${ch} Xpress = 0.25 BNB`);
    assert.strictEqual(trendingForChain(ch)[0].price, 0.25, `${ch} trending uses the BNB table`);
    assert.ok(isValidAddress(ch, "0x6982508145454Ce325dDbE47a25d4ec3d2311933"), `${ch} accepts a 0x address`);
    assert.ok(!PAYABLE_CHAIN_IDS.includes(ch), `${ch} is never a RECEIVING chain`);
  }
});

test("payVia chains: Sui pays in BNB on BSC, Plasma pays in ETH on Ethereum", () => {
  const { payChainOf, payNativeOf, PAYABLE_CHAIN_IDS } = require("../src/config/chains");
  assert.strictEqual(payChainOf("sui"), "bsc");
  assert.strictEqual(payNativeOf("sui"), "BNB");
  assert.strictEqual(payChainOf("plasma"), "ethereum");
  assert.strictEqual(payNativeOf("plasma"), "ETH");
  assert.strictEqual(payChainOf("solana"), "solana"); // identity for native-pay chains
  // sui/plasma can never be selected as a RECEIVING chain
  assert.ok(!PAYABLE_CHAIN_IDS.includes("sui"));
  assert.ok(!PAYABLE_CHAIN_IDS.includes("plasma"));
  assert.ok(PAYABLE_CHAIN_IDS.includes("bsc"));
});

test("sui / plasma address validation + payVia pricing", () => {
  assert.ok(
    isValidAddress("sui", "0x2b3d7f2a9d0c8e1f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f::token::TOKEN"),
  );
  assert.ok(isValidAddress("sui", "0xdeadbeef")); // bare object address ok
  assert.ok(!isValidAddress("sui", "So1anaStyleAddress11111111111111111111111"));
  assert.ok(isValidAddress("plasma", "0x6982508145454Ce325dDbE47a25d4ec3d2311933"));
  const { tierPrice, trendingForChain } = require("../src/config/packages");
  assert.strictEqual(tierPrice("DIAMOND", "sui"), 1.5); // BNB price
  assert.strictEqual(tierPrice("DIAMOND", "plasma"), 0.26); // ETH price
  assert.strictEqual(trendingForChain("sui")[0].price, 0.25); // BNB table
});
