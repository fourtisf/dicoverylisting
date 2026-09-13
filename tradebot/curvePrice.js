'use strict';
/*
 * WHAT SHOULD THIS BUY GET? — the one owner of the number that authorises a
 * curve trade.
 *
 * WHY IT HAS TO EXIST AT ALL
 * `curveRoute.sane()` is the last gate before a discovered call is signed, and
 * it works by comparing TWO numbers: what the curve's own arguments say we
 * should receive, and what an independent source says the token is worth. Its
 * whole job is to catch an interface read the RIGHT SHAPE and the WRONG
 * MEANING — a slot taken for a minimum-out that is really a fee tier estimates
 * gas perfectly cleanly and reverts nothing.
 *
 * ⚠️ AND THE OBVIOUS SOURCE FOR THAT SECOND NUMBER CANNOT WORK HERE. `marketOf`
 * asks DexScreener and GeckoTerminal, and both index POOLS. A token still on a
 * bonding curve has no pool — that is the entire premise of the feature — so
 * `marketOf` returns null for exactly the tokens this exists to trade, `sane()`
 * refuses every one of them at the last stage, and the whole route ships INERT:
 * wired, tested, green, and never once firing. From Telegram that is
 * indistinguishable from a broken bot, which this repo treats as costing as
 * much as a wrong fill.
 *
 * So the sources are ranked by how independent they actually are, and the
 * weakest one says so out loud rather than passing unremarked:
 *
 *   1. the LAUNCHPAD's own USD price × the native's USD price
 *        Two third parties (the pad's API, Coinbase spot), neither of which
 *        touches the curve contract or the argument slots being tested.
 *   2. the launchpad's MARKET CAP ÷ the chain's own totalSupply()
 *        The pad vocabulary for a cap is much wider than for a price, so this
 *        is often the tier that answers. One extra eth_call.
 *   3. the OBSERVED FILL RATE — what the curve actually PAID OUT, per wei
 *        A different FIELD from the one `ratioE18` is computed from (the
 *        contract's payout, versus an argument the trader chose), so it does
 *        catch a slot that is not denominated in the output token. It is NOT
 *        independent of the sample window, so it gets a wider tolerance and a
 *        `weak` flag, and the receipt says which check actually ran.
 *   —. nothing → REFUSE, naming WHICH nothing.
 *
 * ⚠️ NOTHING HERE MAY BE ANSWERED BY THE CURVE ITSELF. That is the thing under
 * test; a gate answered by its own subject is the `built.expected ??
 * expectedTokens` defect that `curveRoute.js` already carries a scar from.
 * `curveQuote()` below is deliberately kept apart for exactly that reason: it
 * is the curve quoting itself, which is right for a MINIMUM-OUT FLOOR and
 * disqualified from `sane()`.
 */
const E18 = 10n ** 18n;

/**
 * Tokens per wei, from what the curve ACTUALLY PAID OUT.
 *
 * ⚠️ NEWEST FIRST AND CAPPED. A bonding curve's price rises monotonically with
 * supply sold, so a rate from the far end of the window is a DIFFERENT number,
 * not a stale reading of the same one.
 *
 * ⚠️ AND ONLY SAMPLES THAT PAID THE TRADER. `curveIface` marks a sample
 * `exact: false` when the curve paid somebody who was not the trader — which is
 * what a recipient ARGUMENT looks like from outside, and whose `amount` may be
 * a fee rather than the fill. Averaging one in prices the trade at its fee.
 *
 * The MEDIAN, never the mean: one outlier is one outlier.
 */
function observedRate(leg, max = 3) {
  const rates = [];
  for (const s of (leg && leg.samples) || []) {
    if (s.exact === false) continue;
    /*
     * ⚠️ THE SAMPLE'S OWN `size`, NOT `value`.
     *
     * A pad that charges in its own ERC-20 pays no `msg.value`, so dividing by
     * it gave nothing at all — this whole tier was DEAD on exactly the pads
     * whose HTTP host is most likely to be the unreachable one, i.e. where the
     * fallback is the only thing left. `curveIface` decides `size` where the
     * direction is known: native paid, or quote paid, or tokens handed over.
     *
     * The rate is then "tokens per unit of whatever this pad charges", which is
     * the same denomination `ratioE18` is in — so the cross-check still compares
     * the contract's PAYOUT against an ARGUMENT the trader chose, which is the
     * whole point of the tier.
     */
    const v = s.size != null ? BigInt(s.size) : s.value;
    const a = s.amount;
    if (!(v > 0n) || !(a > 0n)) continue;
    rates.push((a * E18) / v);
    if (rates.length >= max) break;
  }
  if (!rates.length) return null;
  rates.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return { rateE18: rates[(rates.length - 1) >> 1], n: rates.length };
}

/**
 * How many raw token units `valueWei` should buy — or a refusal that says which
 * kind of nothing it is.
 *
 * `deps` are injected (`record`, `nativeUsd`, `decimals`, `totalSupply`) so this
 * is provable without a node or an HTTP host, which is the only way it CAN be
 * proved from a sandbox with no egress.
 *
 * @returns {Promise<{ok:boolean, raw?:bigint, source?:string, tolPct?:number,
 *                    weak?:boolean, why?:string}>}
 */
async function priceWeiPerToken(chainKey, ca, deps = {}, opts = {}) {
  const { record, nativeUsd, decimals, totalSupply, iface } = deps;

  /*
   * ⚠️ NEVER core.js's `tokenDecimals` HERE. It answers 18 for a read that
   * FAILED, and this is the one number that scales the answer by a power of
   * ten: on a 6- or 9-decimal token a throttled RPC would inflate the estimate
   * by 10^12 or 10^9, `sane()` would refuse, and the refusal would read as "the
   * curve disagrees with the market" — a wrong diagnosis pointing at the token.
   * The Solana side already learnt this; `splDecimalsOrNull` exists for it.
   */
  const dec = decimals ? await decimals(ca, chainKey).catch(() => null) : null;
  if (dec == null || !Number.isFinite(Number(dec))) {
    return { ok: false, why: "could not read this token's decimals, and guessing them would be wrong by a power of ten" };
  }
  const unit = 10n ** BigInt(Math.max(0, Math.min(36, Number(dec))));

  const lp = record ? await record(chainKey, ca, { diag: true }).catch(() => null) : null;
  const rec = lp && lp.record;
  const nat = nativeUsd ? await nativeUsd(chainKey).catch(() => 0) : 0;

  // ── 1 · the pad's own price ────────────────────────────────────────────────
  let usdPerTok = rec && rec.priceUsd > 0 ? Number(rec.priceUsd) : null;
  let source = rec && rec.launchpad ? `${rec.launchpad} price` : 'launchpad price';

  // ── 2 · …or its cap over the chain's own supply ───────────────────────────
  if (usdPerTok == null && rec && rec.mcapUsd > 0 && totalSupply) {
    const ts = await totalSupply(ca, chainKey).catch(() => null);
    if (ts && ts > 0n) {
      const supply = Number(ts) / Number(unit);
      if (supply > 0) {
        usdPerTok = Number(rec.mcapUsd) / supply;
        source = `${(rec.launchpad) || 'launchpad'} market cap ÷ on-chain supply`;
      }
    }
  }

  // ── 2b · the INDEXER's cap over the chain's own supply ────────────────────
  //
  // DexScreener indexes several pads' curves as ordinary pairs and publishes a
  // market cap for them — and on the operator's box, where the pad's HTTP host
  // is unreachable, this is frequently the ONLY strong source there is: a
  // fresh launch has no fills for tier 3 to read either, so without this the
  // route refused exactly the tokens it exists for. Same independence class as
  // tiers 1–2: a third party's number over an eth_call, touching neither the
  // curve contract nor the argument slots under test.
  if (usdPerTok == null && deps.indexerMcapUsd && totalSupply) {
    const mc = await deps.indexerMcapUsd(ca, chainKey).catch(() => null);
    if (Number(mc) > 0) {
      const ts = await totalSupply(ca, chainKey).catch(() => null);
      if (ts && ts > 0n) {
        const supply = Number(ts) / Number(unit);
        if (supply > 0) {
          usdPerTok = Number(mc) / supply;
          source = 'indexer market cap ÷ on-chain supply';
        }
      }
    }
  }

  if (usdPerTok > 0 && nat > 0) {
    const weiPerTok = BigInt(Math.round((usdPerTok / nat) * 1e18));
    if (weiPerTok > 0n) return { ok: true, weiPerTok, unit, source, tolPct: 35, weak: false };
  }

  // ── 3 · LAST RESORT — what the curve actually paid, per unit it charges ────
  const obs = observedRate(iface && iface.buy);
  if (obs && obs.rateE18 > 0n) {
    // rateE18 is raw-token-units per unit of what the pad charges. Inverted,
    // that is charge-units per whole token — wei on a native pad, and the pad's
    // own token elsewhere, which is why `sizeRaw` below has to be denominated
    // the same way.
    const weiPerTok = (unit * E18) / obs.rateE18;
    if (weiPerTok > 0n) {
      return {
        ok: true, weiPerTok, unit,
        source: `the rate recent fills paid (${obs.n})`,
        // Wider, because this is NOT independent of the sample window: both it
        // and `ratioE18` are read out of the same transactions. It catches a
        // slot that is not denominated in the output token, and nothing about
        // staleness, curve movement, or a history somebody wrote on purpose.
        tolPct: 60, weak: true,
      };
    }
  }

  // ── nothing. WHICH nothing is the whole diagnosis ─────────────────────────
  if (lp && lp.ok === false) {
    // "Could not ask" and "nothing there" are different facts, and they send an
    // operator to different places: the first is a line in .env, the second is
    // a statement about the token.
    return { ok: false, why: `no independent price to check the curve against — the launchpad could not be reached from this server (${lp.why}). That is our side, not the token's.` };
  }
  return { ok: false, why: 'no independent price to check the curve against — no launchpad or indexer publishes a cap for it, and its own trades show no fill rate. Refusing to price a curve against itself.' };
}

/**
 * How many raw token units `valueWei` should buy — or a refusal naming which
 * kind of nothing it is.
 */
async function expectedTokensFor(chainKey, ca, valueWei, deps = {}, opts = {}) {
  const spend = (() => { try { return BigInt(valueWei); } catch (_) { return 0n; } })();
  /*
   * ⚠️ `sizeRaw` IS THE PAD'S OWN DENOMINATION, and it is used by the observed
   * tier ONLY.
   *
   * Tiers 1 and 2 price a token in USD, so the native spend is the right size
   * for them whatever the pad charges — leg one converts at market. The
   * observed tier is a rate per unit of what the pad CHARGES, so on a
   * quote-token pad it must be multiplied by the quote we actually hold. Mixing
   * the two is a comparison in two different currencies that passes or fails on
   * an exchange rate nobody intended to test.
   */
  const size = (() => { try { return opts.sizeRaw == null ? null : BigInt(opts.sizeRaw); } catch (_) { return null; } })();
  if (!(spend > 0n) && !(size > 0n)) return { ok: false, why: 'no amount to price' };
  const px = await priceWeiPerToken(chainKey, ca, deps);
  if (!px.ok) return px;
  const basis = px.weak && size > 0n ? size : spend;
  if (!(basis > 0n)) return { ok: false, why: 'no amount to price' };
  return { ok: true, raw: (basis * px.unit) / px.weiPerTok, source: px.source, tolPct: px.tolPct, weak: px.weak };
}

/**
 * What `amountRaw` tokens should fetch in wei — the sell side of the same
 * price, so a sell is gated by exactly the number a buy is gated by.
 */
async function expectedNativeFor(chainKey, ca, amountRaw, deps = {}) {
  const amt = (() => { try { return BigInt(amountRaw); } catch (_) { return 0n; } })();
  if (!(amt > 0n)) return { ok: false, why: 'no amount to price' };
  const px = await priceWeiPerToken(chainKey, ca, deps);
  if (!px.ok) return px;
  return { ok: true, raw: (amt * px.weiPerTok) / px.unit, source: px.source, tolPct: px.tolPct, weak: px.weak };
}

/**
 * The curve's own quote at OUR size, for the MINIMUM-OUT FLOOR only.
 *
 * ⚠️ DISQUALIFIED FROM `sane()`, and for exactly the reason it is right here:
 * it is the thing under test. As a FLOOR it is strictly better than
 * extrapolating a stranger's bound, because a bonding curve is convex and their
 * ratio was measured at their size.
 *
 * ⚠️ AND THE RETURN TYPE IS UNKNOWN. The pools.trade `staticCall` works because
 * its ABI DECLARES `payable returns (uint256)`; a discovered selector declares
 * nothing. A returned `bool true` is the word 1 — a plausible-looking uint and
 * an absurd token amount. So anything that is not exactly one word of plausible
 * magnitude is "could not ask" and answers null, NEVER a failing check.
 */
async function curveQuote(chain, call, from) {
  if (!chain || typeof chain.call !== 'function') return null;
  let ret;
  try { ret = await chain.call({ from, to: call.to, data: call.data, value: call.value }); }
  catch (_) { return null; }
  const hex = String(ret || '0x');
  if (hex.length !== 66) return null;           // not one 32-byte word
  let n; try { n = BigInt(hex); } catch (_) { return null; }
  return n > 1000n ? n : null;                  // 0 and 1 are a bool, not a quote
}

module.exports = { expectedTokensFor, expectedNativeFor, priceWeiPerToken, curveQuote, observedRate, _observedRate: observedRate };
