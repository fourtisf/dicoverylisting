import test from "node:test";
import assert from "node:assert/strict";
import { readWhy, safeAddress } from "./gtPool.ts";

test("⚠️ an undici transport failure says WHICH syscall failed", () => {
  // `fetch failed` is two words: it names neither the host nor what went wrong.
  // undici hides the code in err.cause, and this repo has already paid a round
  // of guessing for unwrapping it too late (netErr() in the trade bot).
  const err = Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
  assert.equal(readWhy(err), "fetch failed: ENOTFOUND");
});

test("an HTTP status already explains itself and is not doubled up", () => {
  assert.equal(readWhy(new Error("GeckoTerminal 429")), "GeckoTerminal 429");
  const dup = Object.assign(new Error("GeckoTerminal 429"), { cause: { code: "429" } });
  assert.equal(readWhy(dup), "GeckoTerminal 429", "the same fact twice reads as two faults");
});

test("a timeout keeps its name", () => {
  assert.equal(readWhy(new Error("The operation was aborted due to timeout")), "The operation was aborted due to timeout");
});

test("nothing useful in, something honest out — never 'undefined'", () => {
  assert.equal(readWhy(null), "failed");
  assert.equal(readWhy(undefined), "failed");
  assert.equal(readWhy({}), "failed");
});

test("an address that goes into an upstream path is bounded and restricted", () => {
  assert.equal(safeAddress("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"), true);
  assert.equal(safeAddress("0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce"), true);
  assert.equal(safeAddress("0x1::coin::TYPE"), true, "Sui/Aptos coin types are addresses too");
  assert.equal(safeAddress(""), false);
  assert.equal(safeAddress("../../etc/passwd"), false);
  assert.equal(safeAddress("a?b=c"), false);
  assert.equal(safeAddress("x".repeat(91)), false);
});
