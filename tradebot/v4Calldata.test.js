'use strict';
/*
 * Reading a launchpad router's calldata for the POOL it names.
 *
 * The reported token trades through a router whose arguments are a dynamic path
 * array, so `curveIface` — which classifies flat 32-byte words — sees ABI
 * offsets (0xa0, 0x60, 0x1c0) instead of values and refuses, correctly. A
 * competitor trades it because it hand-writes an integration per launchpad.
 *
 * These tests are about the three things that make reading it here SAFER than
 * hand-writing one: the selector must hash, the re-encode must be byte-
 * identical, and the PoolKey must be proved by its own id.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const cd = require('./v4Calldata.js');
const v4 = require('./v4.js');

const SIG = cd.DEFAULT_SIGS[0];
const IFACE = new ethers.Interface([`function ${SIG}`]);

const TOKEN = '0xe29c005941845f7e5ec2009f86c4478746d33b2c';
const QUOTE = '0x1111111111111111111111111111111111111111';   // the pool's other side
const HOOKS = '0x0000000000000000000000000000000000000000';
const TRADER = '0xa0000000000000000000000000000000000000a0';
const FEE = 3000;
const TICK = 60;

const [C0, C1] = TOKEN < QUOTE ? [TOKEN, QUOTE] : [QUOTE, TOKEN];
const ID = v4.poolId(C0, C1, FEE, TICK, HOOKS);

/** A real-shaped router call: one hop, carrying the pool's own id. */
function callData({ id = ID, c0 = C0, c1 = C1, fee = FEE, tick = TICK, hooks = HOOKS } = {}) {
  const hop = [1, c0, c1, TRADER, fee, tick, hooks, '0x', TRADER, id];
  return IFACE.encodeFunctionData('swap', [[hop], TRADER, 10n ** 17n, 0n, 9999999999n]);
}

test('the shipped signature is the one the real trades carried', () => {
  // Not a guess: `abi:check` found selector 0x4d819a2a in six real trades on the
  // box, and this signature hashes to exactly that. A hash match is a fact.
  assert.equal(cd.selectorOf(SIG), '0x4d819a2a');
});

test('⚠️ a signature that does not ROUND-TRIP is refused, selector match or not', () => {
  // Proof 2, and it is the load-bearing half. A selector match says a name
  // hashed the same way; it says nothing about the argument layout. Two
  // signatures can collide on four bytes and describe different calls — and a
  // call decoded under the wrong layout yields plausible-looking rubbish.
  const good = callData();
  assert.ok(cd.decodeVerified(good), 'a genuine call was refused');

  // ⚠️ TRAILING GARBAGE, not truncation. A truncated call makes `decodeFunctionData`
  // THROW, so the try/catch catches it and the round-trip is never exercised —
  // the first version of this test asserted the guard and proved the catch,
  // and a mutation run is what said so. Extra bytes on the end DECODE cleanly
  // (ethers ignores them) and only the re-encode notices.
  const padded = good + 'deadbeef';
  assert.ok(cd.decodeVerified(padded) === null, 'calldata that cannot round-trip was accepted');

  /*
   * ⚠️ PREMISE CHANGED, NOT RULE. This used to also assert "…and it must not
   * yield a pool either", on the reasoning that a call we cannot decode is a
   * call we may not read a pool out of.
   *
   * That reasoning was the feature's own ceiling: it meant a router whose
   * signature nobody had written down was unreadable — hand-writing an
   * integration per launchpad, the exact thing this module exists to beat. A pad
   * we had not met (flap.sh) decoded to nothing and its token read as
   * unroutable.
   *
   * Decoding is no longer how the pool is found. The raw 32-byte WORDS are, and
   * ABI encoding puts everything in words, so it is strictly more complete. The
   * safety is unchanged and lives entirely in proof 3: the assignment survives
   * only if the chain's own poolId hash of it equals a word the calldata already
   * carried, which no misreading can fake. Proof 2 still governs `decodeVerified`
   * above, which is what stops a bad layout being TRUSTED as a decode.
   */
  const keys = cd.poolKeysFrom(padded, TOKEN, v4.poolId);
  assert.equal(keys.length, 1, 'the words are still there, so the pool is still provable');
  assert.equal(keys[0].id, ID.toLowerCase());
});

test('⚠️ a router NOBODY has a signature for still yields its pool', () => {
  // The whole point. `0xdeadbeef` is in no candidate list and never will be, so
  // this is a call we cannot decode at all — and the words are the same words.
  const unknown = '0xdeadbeef' + callData().slice(10);
  assert.equal(cd.decodeVerified(unknown), null, 'precondition: this call is genuinely undecodable');
  const keys = cd.poolKeysFrom(unknown, TOKEN, v4.poolId);
  assert.equal(keys.length, 1, 'a pad we have never met must not read as unroutable');
  assert.equal(keys[0].id, ID.toLowerCase());
  assert.equal(keys[0].quote, QUOTE);
});

test('⚠️ …and a call carrying no matching poolId still yields NOTHING', () => {
  // Reading raw words widens what can be READ; it may not widen what is
  // BELIEVED. Strip the id word and the proof has nothing to land on.
  const stripped = callData().split(ID.toLowerCase().slice(2)).join('11'.repeat(32));
  assert.deepEqual(cd.poolKeysFrom(stripped, TOKEN, v4.poolId), []);
});

test('⚠️ a selector that no candidate hashes to is refused outright', () => {
  // Proof 1. Nothing here may be applied to a call it was not shown to describe.
  const foreign = '0xdeadbeef' + '00'.repeat(64);
  assert.equal(cd.decodeVerified(foreign), null);
});

test('the PoolKey is read out of a real router call', () => {
  const keys = cd.poolKeysFrom(callData(), TOKEN, v4.poolId);
  assert.equal(keys.length, 1, 'exactly one pool is proved');
  const k = keys[0];
  assert.equal(k.id, ID.toLowerCase());
  assert.equal(k.currency0, C0);
  assert.equal(k.currency1, C1);
  assert.equal(k.fee, FEE);
  assert.equal(k.tickSpacing, TICK);
  assert.equal(k.quote, QUOTE, 'the OTHER side is what a buy has to be paid in');
  assert.equal(k.tokenIsZero, C0 === TOKEN);
});

test('⚠️ the tuple is never read BY POSITION — the id is what proves the assignment', () => {
  /*
   * Proof 3, and the reason it matters: the tuple is
   * (uint8, address, address, address, uint24, int24, address, bytes, address,
   * bytes32) and NOTHING published says which address is a currency, which is
   * the hooks contract and which is a recipient. Reading them by position is
   * exactly the plausible-looking mistake that puts a wrong address on a money
   * path.
   *
   * So every assignment is hashed and kept only if the result is a bytes32 the
   * call already carried. Here the currencies sit in the FIRST two address
   * slots; below they are moved and the answer is unchanged, because position
   * was never consulted.
   */
  const hop = [1, TRADER, HOOKS, C0, FEE, TICK, C1, '0x', TRADER, ID];   // shuffled
  const data = IFACE.encodeFunctionData('swap', [[hop], TRADER, 10n ** 17n, 0n, 9999999999n]);
  const keys = cd.poolKeysFrom(data, TOKEN, v4.poolId);
  assert.equal(keys.length, 1, 'the pool was not found once its fields moved');
  assert.equal(keys[0].id, ID.toLowerCase());
  assert.equal(keys[0].currency0, C0);
  assert.equal(keys[0].currency1, C1);
});

test('⚠️ a call whose id matches NOTHING proves nothing, and is dropped', () => {
  // A wrong assignment would have to produce a keccak collision. Give the call
  // an unrelated bytes32 and no assignment can be proved — so none is offered,
  // rather than the closest-looking one being handed to a buy.
  const data = callData({ id: ethers.id('not this pool') });
  assert.deepEqual(cd.poolKeysFrom(data, TOKEN, v4.poolId), []);
});

test('⚠️ a pool that does not contain OUR token is somebody else\'s pair', () => {
  /*
   * A router path names every hop. Taking one that does not include this token
   * would price and trade a stranger's pair under our token's ticker.
   *
   * ⚠️ WHICH LINE ACTUALLY GUARANTEES THIS, stated precisely because the first
   * version of this test credited the wrong one: the `h.addrs.has(tok)` early
   * return is an OPTIMISATION, and removing it changes no outcome. The real
   * guarantee is STRUCTURAL — the candidate pair is always built as (our token,
   * some other address), so a pool without our token can never be assembled to
   * hash against. This asserts the property, so it fails if that pairing is ever
   * generalised to arbitrary address pairs.
   */
  const other = '0x2222222222222222222222222222222222222222';
  const [a, b] = QUOTE < other ? [QUOTE, other] : [other, QUOTE];
  const id2 = v4.poolId(a, b, FEE, TICK, HOOKS);
  const hop = [1, a, b, TRADER, FEE, TICK, HOOKS, '0x', TRADER, id2];
  const data = IFACE.encodeFunctionData('swap', [[hop], TRADER, 10n ** 17n, 0n, 9999999999n]);
  assert.deepEqual(cd.poolKeysFrom(data, TOKEN, v4.poolId), [], 'a stranger\'s pool was offered for our token');

  // And the property itself, over a call that carries BOTH pools: every key
  // offered names our token, whatever else the path mentions.
  const ours = [1, C0, C1, TRADER, FEE, TICK, HOOKS, '0x', TRADER, ID];
  const both = IFACE.encodeFunctionData('swap', [[hop, ours], TRADER, 10n ** 17n, 0n, 9999999999n]);
  const keys = cd.poolKeysFrom(both, TOKEN, v4.poolId);
  assert.ok(keys.length > 0);
  for (const k of keys) {
    assert.ok(k.currency0 === TOKEN || k.currency1 === TOKEN, `a pool without our token was offered: ${k.id}`);
  }
});

test('a multi-hop path offers only the hops that name our token', () => {
  const other = '0x2222222222222222222222222222222222222222';
  const [a, b] = QUOTE < other ? [QUOTE, other] : [other, QUOTE];
  const foreignId = v4.poolId(a, b, FEE, TICK, HOOKS);
  const ours = [1, C0, C1, TRADER, FEE, TICK, HOOKS, '0x', TRADER, ID];
  const theirs = [1, a, b, TRADER, FEE, TICK, HOOKS, '0x', TRADER, foreignId];
  const data = IFACE.encodeFunctionData('swap', [[theirs, ours], TRADER, 10n ** 17n, 0n, 9999999999n]);
  const keys = cd.poolKeysFrom(data, TOKEN, v4.poolId);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].id, ID.toLowerCase());
});

test('a NEGATIVE tick spacing is still proved', () => {
  // int24 arrives as a large two's-complement value. Offering only the unsigned
  // reading would silently fail to prove a perfectly ordinary pool.
  const id = v4.poolId(C0, C1, FEE, -120, HOOKS);
  const hop = [1, C0, C1, TRADER, FEE, -120, HOOKS, '0x', TRADER, id];
  const data = IFACE.encodeFunctionData('swap', [[hop], TRADER, 10n ** 17n, 0n, 9999999999n]);
  const keys = cd.poolKeysFrom(data, TOKEN, v4.poolId);
  assert.equal(keys.length, 1, 'a negative tickSpacing was not offered as a candidate');
  assert.equal(keys[0].tickSpacing, -120);
});

test('a hooked pool is proved with its hooks contract, not with address(0)', () => {
  const hooks = '0x3333333333333333333333333333333333333333';
  const id = v4.poolId(C0, C1, FEE, TICK, hooks);
  const hop = [1, C0, C1, TRADER, FEE, TICK, hooks, '0x', TRADER, id];
  const data = IFACE.encodeFunctionData('swap', [[hop], TRADER, 10n ** 17n, 0n, 9999999999n]);
  const keys = cd.poolKeysFrom(data, TOKEN, v4.poolId);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].hooks, hooks);
});

test('the signature list is env-overridable, and the operator\'s entry leads', () => {
  // The `pads.js` contract: a launchpad that redeploys with a different router
  // costs a line in .env, not a deploy. Being on the list buys a candidate
  // nothing — it still has to pass all three proofs.
  process.env.V4_ROUTER_SIGS = 'foo(uint256)|bar(address)';
  try {
    const l = cd.sigs();
    assert.equal(l[0], 'foo(uint256)');
    assert.ok(l.includes(cd.DEFAULT_SIGS[0]), 'an override must not drop the shipped signature');
  } finally { delete process.env.V4_ROUTER_SIGS; }
});

test('garbage in is an empty answer, never a throw', () => {
  // This runs on the card path. A malformed trade must cost nothing.
  for (const bad of [null, undefined, '', '0x', 'nonsense', '0x1234']) {
    assert.equal(cd.decodeVerified(bad), null);
    assert.deepEqual(cd.poolKeysFrom(bad, TOKEN, v4.poolId), []);
  }
  assert.deepEqual(cd.poolKeysFrom(callData(), 'not-an-address', v4.poolId), []);
});

// ── end to end, through bestPool ─────────────────────────────────────────────

test('⚠️ a pool BOTH existing sources miss is found from the token\'s own trades', async () => {
  /*
   * The reported case, end to end. The constructed sweep guesses native/WETH
   * pairings, so a pool quoted in a third token is not in it; the Initialize
   * scan is one log in the whole history and a range-capped node hides it. The
   * token meanwhile trades every few minutes, and each trade NAMES its pool.
   *
   * Mutation test: drop the `tradePoolKeys` merge in `bestPool` and this fails.
   */
  const hop = [1, C0, C1, TRADER, FEE, TICK, HOOKS, '0x', TRADER, ID];
  const data = IFACE.encodeFunctionData('swap', [[hop], TRADER, 10n ** 17n, 0n, 9999999999n]);
  const MGR = '0x4444444444444444444444444444444444444444';

  const provider = {
    // No Initialize log anywhere — the capped node, or a pool created outside
    // any window we would scan.
    async getLogs(f) {
      const t0 = f && f.topics && f.topics[0];
      if (t0 === require('./curveIface.js').TRANSFER_TOPIC) {
        return [{ transactionHash: '0xtrade', blockNumber: 10, address: TOKEN }];
      }
      return [];
    },
    async getTransaction(h) { return h === '0xtrade' ? { to: '0x9999999999999999999999999999999999999999', data } : null; },
    async getBlockNumber() { return 100; },
  };

  const deps = {
    chainOf: () => ({ key: 'robinhood', name: 'Robinhood Chain', weth: '0x5555555555555555555555555555555555555555', v4: { poolManager: MGR } }),
    providerFor: () => provider,
    // The pool EXISTS on chain and holds liquidity — the state read is the final
    // arbiter, so a proved-but-absent pool would still be dropped here.
    poolState: async (_p, _c, id) => (String(id).toLowerCase() === ID.toLowerCase()
      ? { sqrtPriceX96: 79228162514264337593543950336n, liquidity: 10n ** 18n }
      : null),
  };

  process.env.ROBINHOOD_V4_POOLMANAGER = MGR;
  try {
    const p = await v4.bestPool(TOKEN, 'robinhood', deps);
    assert.ok(p, 'the pool its own trades name was never found');
    assert.equal(String(p.id).toLowerCase(), ID.toLowerCase());
    assert.equal(p.quote, QUOTE, 'and the currency a buy must be paid in came with it');
  } finally { delete process.env.ROBINHOOD_V4_POOLMANAGER; }
});

/*
 * ⚠️ A CAP THAT IS PER-CALL IS NOT THE CAP IT CLAIMS TO BE.
 *
 * `tradePoolKeys` reads up to six transactions. With the budget owned by
 * `poolKeysFrom`, "capped at 20,000 hashes" was really 120,000 — ~2.8s of pure
 * CPU on the card's critical path and on `canTradeNow`, which every snipe polls
 * on a timer. That is the same shape as the unbounded stage that cost this
 * feature three rounds, moved one module over.
 */
test('⚠️ several calls SHARE one hash budget', () => {
  const good = callData();
  let hashes = 0;
  const counting = (...a) => { hashes++; return v4.poolId(...a); };

  // Spent budget: the second call must not get a fresh allowance.
  const budget = { left: 3 };
  cd.poolKeysFrom(good, TOKEN, counting, { budget });
  const afterFirst = hashes;
  cd.poolKeysFrom(good, TOKEN, counting, { budget });
  assert.ok(afterFirst <= 4, `the first call overran a budget of 3 — ${afterFirst} hashes`);
  assert.ok(hashes - afterFirst <= 1, 'the second call was handed a fresh budget');

  // …and with no budget passed, one call still has a ceiling of its own.
  let solo = 0;
  cd.poolKeysFrom(good, TOKEN, (...a) => { solo++; return v4.poolId(...a); });
  assert.ok(solo > 0 && solo <= cd.MAX_HASHES, 'an unbudgeted call is still capped');
});
