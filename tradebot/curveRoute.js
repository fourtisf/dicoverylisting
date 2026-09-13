'use strict';
/*
 * BUILD A BUY/SELL ON A LAUNCHPAD CURVE — from an interface that was OBSERVED,
 * never one that was researched.
 *
 * `curveIface.js` reads the call shape off real trades and `classifySlots`
 * works out what each argument means. This turns that into OUR call, and its
 * whole job is to be strict about the one thing that matters:
 *
 *     A SLOT NOBODY CAN EXPLAIN STOPS THE TRADE.
 *
 * Not defaults to zero, not reuses the stranger's value, not "probably a
 * deadline". Pons shipped a researched factory AND a researched event
 * signature; the box measured both and both were wrong. Those failures made
 * the bot go quiet. This one would move money.
 *
 * ⚠️ AND CALLDATA IS STILL NOT PERMISSION. Nothing here signs. `simulate()` has
 * to accept the built call, and the caller has to cross-check what it would
 * receive against an independent price, before any of this reaches a wallet.
 * Knowing an interface and being allowed to fill a swap are different things —
 * the line v4.js already draws between price() and canSwapLive().
 */
const { classifySlots } = require('./curveIface.js');

/**
 * ⚠️ EVERY AMOUNT THAT CROSSES THIS BOUNDARY IS NORMALISED, and `null` refuses.
 *
 * core.js works in Numbers for every price (`Number(ethers.formatEther(…))`),
 * and everything in here is BigInt. The natural wiring — an expected-token
 * count computed from a float price — reaches `hi - lo` in `sane()` and throws
 * `TypeError: Cannot mix BigInt and other types` straight out of core.buy, where
 * the router turns it into "Something glitched handling that". The gate that
 * exists to refuse would CRASH instead, and the user would never learn a
 * refusal happened.
 */
const big = (x) => {
  if (typeof x === 'bigint') return x;
  if (x === null || x === undefined || x === '') return null;
  try { const v = BigInt(typeof x === 'number' ? Math.trunc(x) : x); return v; } catch (_) { return null; }
};

const HEX = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => '0'.repeat(24) + String(a).slice(2).toLowerCase();
const E18 = 10n ** 18n;
/** How far our trade size may sit from the sampled ones before a stranger's
 *  bound stops meaning anything. 4× either way: wide enough that an ordinary
 *  buy is not refused, narrow enough that a curve's convexity over the gap is
 *  bounded by the user's own slippage in most cases. */
const SIZE_BAND = 4n;

/**
 * Our own call on the curve.
 *
 * `valueWei` is what WE are spending (a buy) and `amountRaw` what we are
 * selling. `slippageBps` is applied to every slot that scales with the trade —
 * those are minimum-out bounds, and ours must be computed for OUR size.
 */
function buildCurveCall(leg, opts) {
  const o = opts || {};
  const { token, wallet, slippageBps = 500, minSamples } = o;
  const valueWei = big(o.valueWei) ?? 0n;
  const amountRaw = big(o.amountRaw) ?? 0n;
  // An independent minimum-out, when the caller has one. See the note at the
  // `scales` slot: extrapolating a stranger's bound is the weaker of the two.
  const minOutRaw = big(o.minOutRaw);
  const slipBps = Number(slippageBps);
  if (!Number.isFinite(slipBps)) return { ok: false, why: 'slippage is not a number' };
  if (!leg || !leg.selector) return { ok: false, why: 'no observed call to build from' };
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(token || ''))) return { ok: false, why: 'not an EVM token address' };
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(wallet || ''))) return { ok: false, why: 'no wallet to build for' };
  // ⚠️ A CALL WE ONLY HALF-READ IS A CALL WE CANNOT REBUILD. `argsOf` stops at
  // 8 words; this emits exactly the classified slots, so a wider observed call
  // would be silently TRUNCATED into malformed calldata. `simulate` usually
  // catches it — by luck, not by rule, and a dynamic trailing argument can
  // decode as empty and go straight through.
  if (leg.wide) return { ok: false, why: 'this curve takes more arguments than Dexvra reads, so the call cannot be rebuilt faithfully' };

  const cls = classifySlots(leg, token, { minSamples });
  if (!cls.ok) return { ok: false, why: cls.why, slots: cls.slots, needsMoreTrades: /only \d+ sample/.test(cls.why || '') };

  /*
   * ⚠️ EXACTLY ONE ARGUMENT MAY SCALE WITH THE TRADE.
   *
   * `expected` below is a single variable, reassigned by every scaling slot, so
   * with two of them whichever comes LAST becomes the number `sane()` checks —
   * and on a `sell(uint256 tokensIn, uint256 minEthOut)` that is a comparison of
   * a token quantity against a wei quantity, which passes or fails on a
   * magnitude coincidence rather than on price. Worse, the slippage cut is
   * written into BOTH, so the tokensIn slot hands over 95% of what was asked
   * for: a 100% sell that sells 95% and still books the position closed.
   *
   * There is no defensible reason to slippage-cut two arguments, and guessing
   * which of them is the bound is exactly what this module refuses to do.
   */
  const scaled = cls.slots.filter((s) => s.role === 'scales');
  if (scaled.length > 1) {
    return { ok: false, slots: cls.slots, why: `arguments ${scaled.map((s) => s.i).join(' and ')} both track the trade size — only one of them can be a minimum-out, and picking which is not something this may do` };
  }

  /*
   * The size OUR call is denominated in: what we pay on a buy, what we hand
   * over on a sell. A scaling slot is a bound on the other side of that.
   *
   * `sizeRaw` is the QUOTE-TOKEN case — a pad priced in an ERC-20 rather than
   * the native coin, where `valueWei` is 0 by construction and the amount paid
   * lives in an allowance instead. Without it every slot on such a pad
   * correlates against zero and the call reads as unexplained: the pad looks
   * broken rather than different.
   */
  const sizeRaw = big(o.sizeRaw);
  const size = sizeRaw != null && sizeRaw > 0n ? sizeRaw : (valueWei > 0n ? valueWei : amountRaw);

  /*
   * ⚠️ A BONDING CURVE IS CONVEX, AND `ratioE18` WAS MEASURED AT SOMEBODY
   * ELSE'S SIZE.
   *
   * Extrapolating it linearly to ours is either an always-revert (we buy bigger
   * than the samples, so the bound is above what the curve will actually pay)
   * or no bound at all (we buy smaller, so it sits far below the true output).
   * And `sane()` cannot tell: both sides of its comparison are linear in `size`,
   * so `size` cancels and the verdict is identical for a 0.001 and a 100 ETH
   * buy.
   *
   * When the caller supplies an independent `minOutRaw` this does not apply —
   * that bound is ours and correctly sized. Without one, refuse outside a
   * narrow band rather than sign a bound nobody computed for this trade.
   */
  if (minOutRaw == null && scaled.length && size > 0n) {
    // ⚠️ THE SAMPLE'S OWN `size`, which is the ONLY reading that is in the same
    // denomination as ours. Falling back to `amount` on a quote-token pad
    // compares the tokens a trade RECEIVED against the quote we are about to
    // PAY — two different currencies — and every such buy is refused as "a very
    // different size", which reads as a rule working when it is a unit bug.
    // The value/amount fallback keeps hand-built legs in the unit tests working.
    const sizes = (leg.samples || [])
      .map((sm) => {
        if (sm.size != null) { const z = big(sm.size); if (z != null) return z; }
        const v = big(sm.value) ?? 0n;
        return v > 0n ? v : (big(sm.amount) ?? 0n);
      })
      .filter((v) => v > 0n);
    const near = sizes.some((v) => v * SIZE_BAND >= size && size * SIZE_BAND >= v);
    if (sizes.length && !near) {
      return { ok: false, slots: cls.slots, why: "the trades on file are a very different size from yours, and a curve's own bound cannot be stretched that far — try an amount closer to what others are trading" };
    }
  }

  const words = [];
  let usedOverride = false;
  // What the CURVE's own arguments say we should receive, before slippage. This
  // is the only number the built call itself asserts, and it is what `sane()`
  // has to compare against an independent price — see the note at the return.
  let expected = null;
  for (const s of cls.slots) {
    if (s.role === 'token') { words.push(addrWord(token)); continue; }
    if (s.role === 'sender') { words.push(addrWord(wallet)); continue; }
    if (s.role === 'constant') { words.push(s.value); continue; }
    if (s.role === 'scales') {
      if (size <= 0n) return { ok: false, why: 'this call has an amount-scaled argument but no amount was given' };
      // ⚠️ RECOMPUTED FOR OUR SIZE, then cut by slippage. Reusing the observed
      // number would carry somebody else's bound: too high and every buy
      // reverts, too low and it is a free option for anyone watching.
      //
      // `expected` stays the RATIO's reading whatever we end up sending, because
      // it is what `sane()` tests. Answering that gate with the caller's own
      // independent number would be the gate checking itself — the
      // `built.expected ?? expectedTokens` defect this module already carries a
      // scar from.
      expected = (s.ratioE18 * size) / E18;
      const floor = minOutRaw != null ? minOutRaw : expected;
      const bounded = (floor * BigInt(10000 - Math.max(0, Math.min(9000, Math.round(slipBps))))) / 10000n;
      words.push(HEX(bounded > 0n ? bounded : 1n));
      usedOverride = minOutRaw != null;
      continue;
    }
    return { ok: false, why: `argument ${s.i} is not understood — refusing to build a call around it` };
  }

  return {
    ok: true,
    why: null,
    data: leg.selector + words.join(''),
    value: valueWei,
    slots: cls.slots,
    samples: cls.samples,
    /** Was the on-chain floor OUR independently-priced one, or a stranger's
     *  bound stretched to our size? The receipt is owed the difference. */
    boundedByIndependentPrice: usedOverride,
    /**
     * ⚠️ THE CALL'S OWN EXPECTATION, and `null` when it has none.
     *
     * `sane()` exists to catch an interface read the right shape and the wrong
     * meaning, and it can only do that by comparing TWO independent numbers.
     * The caller passed `built.expected ?? expectedTokens` for a while, which
     * — with `expected` never set — compared the indexer's number against
     * itself and therefore passed everything. A gate that cannot fail is worse
     * than no gate: it reads as protection in every review of the code.
     *
     * `null` is honest and is a REFUSAL upstream: a pad whose buy carries no
     * amount-scaled argument gives us nothing to check the interface against,
     * and offers no on-chain slippage bound of its own either.
     */
    expected,
  };
}

/**
 * Would the chain accept this call?
 *
 * `estimateGas` reverts exactly when the transaction would, so it is the
 * cheapest honest answer to "is this really the buy function" — and it costs
 * nothing and moves nothing. It is a gate, never a promise: gas estimating is
 * not the same as receiving what we expect, which is why the caller still has
 * to compare the outcome against an independent price.
 */
async function simulate(chain, call, from) {
  const req = { from, to: call.to, data: call.data, value: call.value };
  const say = (e) => {
    const m = (e && (e.shortMessage || e.message)) || String(e);
    return { ok: false, gas: 0n, why: `the curve rejected this call (${m})` };
  };

  /*
   * ⚠️ eth_call IS THE GATE, NOT eth_estimateGas — and that is a decision about
   * ONE CHAIN, written down because the rest of core.js already made it.
   *
   * core.js says, twice, that the Robinhood node returns a non-standard
   * JSON-RPC error envelope and STRIPS revert data on `eth_estimateGas`, so
   * ethers throws an opaque "could not coalesce error" / "missing revert data"
   * there — which is why `v3SwapGas` swallows an estimate failure and defaults,
   * and why the existing pools.trade curve branch quotes with a `staticCall`
   * and sends a flat limit rather than estimating at all.
   *
   * Robinhood Chain is where Pons lives, i.e. the chain this whole feature is
   * aimed at. Gating on estimateGas there turns a node quirk into a permanent
   * refusal to trade, reported to the user as the CURVE rejecting them — and
   * with the revert data stripped, "never discard the reason" is defeated too:
   * the message diagnoses nothing.
   *
   * So a call that EXECUTES is the gate (eth_call reverts exactly when the
   * transaction would), and the estimate is best-effort, for the limit only.
   */
  if (typeof chain.call === 'function') {
    try { await chain.call(req); } catch (e) { return say(e); }
    let gas = 0n;
    try { gas = BigInt(await chain.estimateGas(req)); } catch (_) { gas = 0n; }   // a limit, not a verdict
    return { ok: true, gas, why: null };
  }

  // No eth_call available (a stub, an exotic transport): estimateGas is the
  // only gate left. It is the weaker one, and it is still better than none.
  try { return { ok: true, gas: BigInt(await chain.estimateGas(req)), why: null }; }
  catch (e) { return say(e); }
}

/**
 * The last gate: does what we would receive agree with what the indexer says
 * the token is worth?
 *
 * An observed interface can be right about the SHAPE and wrong about the
 * meaning — a slot read as a minimum-out that is really a fee tier still
 * estimates gas cleanly. So the built call's own expectation is compared with
 * an independent price, and a wide disagreement refuses the trade. This is the
 * check that makes a discovered route safe to sign rather than merely likely.
 */
function sane(expectedTokens, indexerTokens, tolPct = 35) {
  // Normalised, because core.js's price side is Numbers and everything here is
  // BigInt — an un-normalised float reaches `hi - lo` and throws a raw
  // TypeError out of the buy, which the router renders as "Something glitched".
  const a = big(expectedTokens), b = big(indexerTokens);
  if (!(a > 0n) || !(b > 0n)) {
    return { ok: false, why: 'no independent price to check the curve quote against' };
  }
  const hi = a > b ? a : b;
  const lo = a > b ? b : a;
  const offPct = Number(((hi - lo) * 100n) / hi);
  if (offPct > tolPct) {
    return { ok: false, offPct, why: `the curve would give ${offPct}% away from the indexed price — refusing rather than guessing which is right` };
  }
  return { ok: true, offPct, why: null };
}

/*
 * BUILD FROM A TRANSFERRED SHAPE — the same launchpad's interface, learned on a
 * SIBLING token and applied to a fresh one.
 *
 * WHY THIS MAY EXIST AT ALL. The observed route needs two trades of different
 * sizes on the token itself, so the FIRST buyer of a fresh launch can never
 * use it — and the first buy is the entire point of a launch snipe. What makes
 * a transfer sound rather than a guess is BYTE-IDENTITY: the caller has proved
 * (getCode) that this token's curve carries exactly the bytecode of the curve
 * the shape was learned on. Identical deployed code — immutables included, they
 * live in the code — executes identically; only storage differs, and the
 * storage question ("is this really MY token's curve?") is answered by
 * simulate(), because a curve bound to a different token reverts our call.
 *
 * ⚠️ WHAT REPLACES `sane()` HERE, because there is nothing to feed it: the
 * shape's meaning was sane()-checkable when it was LEARNED (real samples), the
 * bytecode identity carries that meaning over, and the on-chain floor is OURS —
 * `minOutRaw` from a STRONG independent price is REQUIRED, never optional and
 * never a weak tier. A wrong slot reading puts a huge floor into a slot that
 * cannot hold one, and simulate/the chain refuses; the bounded cost is gas.
 */
function buildFromShape(shapeLeg, opts) {
  const o = opts || {};
  const { token, wallet, slippageBps = 500 } = o;
  const valueWei = big(o.valueWei) ?? 0n;
  const minOutRaw = big(o.minOutRaw);
  const slipBps = Number(slippageBps);
  if (!shapeLeg || !shapeLeg.selector || !Array.isArray(shapeLeg.slots)) return { ok: false, why: 'no transferred shape to build from' };
  if (!Number.isFinite(slipBps)) return { ok: false, why: 'slippage is not a number' };
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(token || ''))) return { ok: false, why: 'not an EVM token address' };
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(wallet || ''))) return { ok: false, why: 'no wallet to build for' };
  // Native-paid legs only: a quote-token pad needs the acquire/approve legs,
  // and stretching the transfer that far multiplies what can be wrong.
  if (!shapeLeg.native) return { ok: false, why: "this pad's buy is not paid in the native coin — a transferred shape covers native-paid pads only" };

  const scaled = shapeLeg.slots.filter((s) => s.role === 'scales');
  if (scaled.length > 1) return { ok: false, why: 'the learned shape has two amount-tracking slots — only one can be a minimum-out, and picking is not allowed' };
  // A shape with no minimum-out slot leaves nothing on-chain protecting the
  // fill, and sane() is not run on a transfer — with both gone the trade would
  // be gated by gas alone, which is no gate.
  if (!scaled.length) return { ok: false, why: 'the learned shape carries no minimum-out slot, so nothing on-chain would protect the fill — refusing' };
  // ⚠️ THE FLOOR IS MANDATORY AND MUST BE OURS. Without our own strong price
  // there is no protection left on a shape this token's own trades never
  // checked — refusing here is what keeps the transfer honest.
  if (!(minOutRaw > 0n)) {
    return { ok: false, why: 'a transferred shape may only be signed with an independent minimum-out from a strong price — none was available' };
  }

  const words = [];
  for (const s of shapeLeg.slots) {
    if (s.role === 'token') { words.push(addrWord(token)); continue; }
    if (s.role === 'sender') { words.push(addrWord(wallet)); continue; }
    if (s.role === 'scales') {
      const bounded = (minOutRaw * BigInt(10000 - Math.max(0, Math.min(9000, Math.round(slipBps))))) / 10000n;
      words.push(HEX(bounded > 0n ? bounded : 1n));
      continue;
    }
    if (s.role === 'constant') {
      const w = String(s.value || '');
      // The sibling's classify already refused a stranger's constant address;
      // re-checked here because the shape crossed a persistence boundary and a
      // stored file is not a proof.
      if (/^0{24}[0-9a-fA-F]{40}$/.test(w) && !/^0+$/.test(w) && !/^0{8}/.test(w.slice(24))) {
        return { ok: false, why: 'the learned shape carries a constant address that is neither the token nor the trader — refusing to replay it' };
      }
      if (!/^[0-9a-fA-F]{64}$/.test(w)) return { ok: false, why: 'the learned shape holds a malformed constant' };
      words.push(w.toLowerCase());
      continue;
    }
    return { ok: false, why: `the learned shape cannot explain argument ${s.i} (${s.role}) — refusing to build around it` };
  }

  return {
    ok: true, why: null,
    data: shapeLeg.selector + words.join(''),
    value: valueWei,
    slots: shapeLeg.slots,
    expected: null,                    // nothing observed on THIS token — see the header
    boundedByIndependentPrice: scaled.length > 0,
    transferred: true,
  };
}

module.exports = { buildCurveCall, buildFromShape, simulate, sane, SIZE_BAND, _addrWord: addrWord, _HEX: HEX, _big: big };
