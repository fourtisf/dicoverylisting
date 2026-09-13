// REAL per-transaction buy detection, from GeckoTerminal's pool trades feed.
//
// WHY THIS REPLACED THE VOLUME ESTIMATOR
// The buy bot used to diff `volume_usd.h24` between polls and apportion the
// delta by the buy/sell tx split. That is not a lagging approximation of the
// truth — it is a different number, and it is wrong in four ways at once:
//
//  1. h24 is a ROLLING window. A pool doing $40k/24h sheds ~$11.6 every 25s, so
//     any buy smaller than the volume ageing out of the window never satisfies
//     `volume > lastVolume`. Invisible forever, not merely late.
//  2. `delta * buyShare` turns a $5,000 SELL at a 0.6 buy ratio into a $3,000
//     "buy" alert. The group is told someone bought when someone sold.
//  3. Several buys inside one poll window collapse into a single number that
//     matches no transaction anyone can look up.
//  4. With no tx hash there is nothing to deduplicate on, so the dedupe key
//     degrades to something time-based and stops being a dedupe key at all.
//
// GeckoTerminal publishes `/networks/{net}/pools/{pool}/trades` — the last 300
// trades of the past 24h, each with a tx hash, the sender, both token addresses
// and amounts, the USD volume, and a block number. That is a real feed, so the
// alerts become real: a verifiable transaction, a clickable buyer, an amount
// that matches the block explorer.
//
// The estimator is still in buyMonitor.js and still runs — but only when THIS
// module says the feed is unavailable. See the null-vs-[] rule on fetchPoolBuys.
const { gtGet, sameToken, inCooldown, gtAddr, PRIO_REALTIME } = require("./gtPairs");
const log = require("../helpers/logger");

// GT returns at most 300 trades (newest first, last 24h) and pages are not
// stable under a live feed, so there is no pagination here: at a 25s cadence,
// 300 trades is minutes of even a very hot pool.
const PAGE_MAX = 300;

// The server-side volume filter is set to a FRACTION of the group's threshold,
// never the threshold itself. An aggregator splits one user swap into legs that
// are each below the threshold but whose SUM is alertable; filtering at the
// exact threshold would drop those legs before mergeByTx could reassemble them,
// and the buy would silently never post. Each group's real threshold is
// re-applied after the merge.
const FETCH_FLOOR_RATIO = 0.2;

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

// poolKey → last time we said this pool's feed was unreadable.
const unavailLog = new Map();
const UNAVAIL_LOG_MS = 10 * 60 * 1000;
function noteUnavailable(key, reason) {
  const last = unavailLog.get(key) || 0;
  if (Date.now() - last < UNAVAIL_LOG_MS) return;
  unavailLog.set(key, Date.now());
  const why = reason === "cooldown"
    ? "the shared GeckoTerminal cooldown is armed (rate limited)"
    : reason;
  // noise: self-handled (the pool resumes on the first poll that works), and
  // during a rate-limit spell one copy per pool per 10min flooded the channel.
  log.noise(
    `[buybot] ${key}: trades feed unreadable — ${why}. No alert is posted without its ` +
      "transaction, so this pool stays quiet until the feed answers; buys inside the last " +
      "30 minutes still post, with their hashes, on the first poll that works.",
  );
}

/**
 * Was the tracked token BOUGHT in this trade?
 *   true  — yes, it was received by the trader
 *   false — no, it was sold
 *   null  — cannot tell; the caller must SKIP, never guess
 *
 * DIRECTION COMES FROM THE TOKEN ADDRESSES, NEVER FROM `kind`.
 * GT's `kind` is relative to the pool's BASE token. On a pool where the tracked
 * token is the QUOTE side, `kind: "buy"` means our token was SOLD — so trusting
 * it posts a green buy alert on every dump, which is the single most damaging
 * thing a buy bot can do to a project's chat.
 *
 * `kind` is consulted in exactly one case: the payload carried NO address
 * fields at all AND the caller has independently established that our token is
 * the pool's base token, which is the only situation in which `kind` means what
 * it appears to mean.
 */
function tradeIsBuyOfToken(attrs, tokenAddress, { tokenIsBase = null } = {}) {
  if (!attrs || !tokenAddress) return null;
  const to = attrs.to_token_address;
  const from = attrs.from_token_address;
  if (sameToken(to, tokenAddress)) return true;
  if (sameToken(from, tokenAddress)) return false;
  if (to || from) return null; // a trade in this pool, but not of our token
  if (tokenIsBase === true && attrs.kind) return String(attrs.kind).toLowerCase() === "buy";
  return null;
}

/**
 * Normalise one GT trade row into the shape the alert renderer needs.
 * Returns null for anything that is not a usable buy of our token.
 */
function toTrade(row, tokenAddress, opts) {
  const a = (row && row.attributes) || null;
  if (!a) return null;
  if (tradeIsBuyOfToken(a, tokenAddress, opts) !== true) return null;

  const txHash = String(a.tx_hash || "").trim();
  if (!txHash) return null; // without a hash there is nothing to dedupe on

  // The tracked token was RECEIVED, so its amount is the `to` side.
  const tokenAmount = num(a.to_token_amount);
  // GT's own figure wins — it is what the chart shows, so the alert and the
  // chart agree. The product is only a fallback for rows GT left unpriced.
  let usd = num(a.volume_in_usd);
  if (usd <= 0 && tokenAmount > 0) usd = tokenAmount * num(a.price_to_in_usd);
  if (!(usd > 0)) return null; // an unpriced buy is not something we can post

  const ts = a.block_timestamp ? Date.parse(a.block_timestamp) : 0;
  return {
    txHash,
    buyer: String(a.tx_from_address || "").trim(),
    usd,
    tokenAmount,
    spentAmount: num(a.from_token_amount),
    // What the buyer actually PAID WITH. Only meaningful when it is the pool's
    // other side; kept so the alert can print a real "(0.6646 SOL)" instead of
    // deriving one from USD, which is invented precision.
    spentToken: String(a.from_token_address || "").trim(),
    priceUsd: num(a.price_to_in_usd),
    blockNumber: num(a.block_number),
    blockTimeMs: Number.isFinite(ts) ? ts : 0,
  };
}

/**
 * Merge the legs of one multi-hop swap into a single buy.
 *
 * A router that goes USDC → WETH → TOKEN emits several trade rows sharing one
 * tx hash (GT even ids them `{tx_hash}_{index}`). Un-merged, a $120 routed buy
 * posts as "$40" and its other legs vanish — swallowed by the per-tx dedupe,
 * because the first leg already claimed the hash. So merge BEFORE the latch
 * sees it, not after.
 *
 * Amounts SUM. Block and timestamp take the EARLIEST non-zero value so ordering
 * stays stable. Buyer takes the first non-empty. Unit price is recomputed from
 * the merged totals — one leg's price is not the price of the whole trade.
 */
function mergeByTx(trades) {
  const byTx = new Map();
  for (const t of trades) {
    const prev = byTx.get(t.txHash);
    if (!prev) {
      byTx.set(t.txHash, { ...t, legs: 1 });
      continue;
    }
    prev.usd += t.usd;
    prev.tokenAmount += t.tokenAmount;
    // A routed swap can pay with a DIFFERENT token on each leg, and summing
    // those into one figure would print a number in no currency at all. When
    // the legs disagree, the spend is reported as unknown rather than wrong.
    if (prev.spentToken !== t.spentToken) {
      prev.spentToken = "";
      prev.spentAmount = 0;
    } else {
      prev.spentAmount += t.spentAmount;
    }
    prev.legs += 1;
    if (t.blockNumber && (!prev.blockNumber || t.blockNumber < prev.blockNumber)) prev.blockNumber = t.blockNumber;
    if (t.blockTimeMs && (!prev.blockTimeMs || t.blockTimeMs < prev.blockTimeMs)) prev.blockTimeMs = t.blockTimeMs;
    if (!prev.buyer && t.buyer) prev.buyer = t.buyer;
    if (prev.tokenAmount > 0) prev.priceUsd = prev.usd / prev.tokenAmount;
  }
  return [...byTx.values()];
}

/**
 * Fetch the buys of `tokenAddress` in `pool` on GT network `net`.
 *
 * RETURN CONTRACT — the `null` vs `[]` distinction is the whole design:
 *
 *   null  the feed is UNAVAILABLE (network error, non-200, 404, or the shared
 *         429 cooldown is armed). The caller must fall back to the volume
 *         estimator, because "we cannot see" is not "nothing happened".
 *   []    the feed ANSWERED and this pool is quiet. The caller must stay
 *         silent, and must NOT run the estimator.
 *
 * Conflating them breaks in one of two directions, and fourtis hit both: treat
 * an outage as silence and the bot goes quiet for hours without a word; treat
 * silence as an outage and every buy posts twice, once real and once estimated.
 *
 * Result is sorted OLDEST FIRST so alerts post in the order the buys happened.
 */
async function fetchPoolBuys(net, pool, tokenAddress, { minUsd = 0, tokenIsBase = null } = {}) {
  if (!net || !pool || !tokenAddress) return null;
  const floor = minUsd > 0 ? minUsd * FETCH_FLOOR_RATIO : 0;
  // gtAddr, NOT toLowerCase(). See gtPairs.gtAddr — a lowercased Solana pool is
  // a different address, GT 404s it, and this function then reports the feed as
  // unavailable for a pool that is trading perfectly well.
  // REALTIME priority. This is the only read in the process whose lateness a
  // group actually sees; everything else runs on a timer and can wait.
  const res = await gtGet(
    `/networks/${net}/pools/${gtAddr(pool)}/trades`,
    { trade_volume_in_usd_greater_than: floor > 0 ? floor.toFixed(6) : 0 },
    PRIO_REALTIME,
  );
  if (!res || !res.ok) {
    // Unavailable — NOT "no buys". Nothing will be posted for this pool until it
    // reads again, so the reason has to reach the log: silence with no
    // explanation is the one failure an operator cannot act on. Throttled per
    // pool, because a process-wide cooldown hits every pool at once and would
    // otherwise print the same line for each of them every poll.
    noteUnavailable(`${net}/${pool}`, (res && res.reason) || "request failed");
    return null;
  }

  const rows = (res.body && res.body.data) || [];
  if (!Array.isArray(rows)) return null; // unexpected payload — do not read it as silence

  const opts = { tokenIsBase };
  const buys = [];
  let unrelated = 0;
  for (const row of rows.slice(0, PAGE_MAX)) {
    const t = toTrade(row, tokenAddress, opts);
    if (t) buys.push(t);
    else if (tradeIsBuyOfToken(row && row.attributes, tokenAddress, opts) === null) unrelated++;
  }
  // A busy pool where NOTHING involves our token is a resolver problem — the
  // wrong pool, the wrong chain, or an address form we failed to match (TON and
  // Sui compare exactly, since only hex is case-normalised). That is US BEING
  // BLIND, not the pool being quiet, so it must resolve `null`: returning `[]`
  // would assert authoritative silence, suppress the estimator, and leave the
  // group with no alerts at all and nothing above debug to say why.
  if (rows.length && unrelated === rows.length) {
    log.warn(
      `[buybot] ${net}/${pool}: ${rows.length} trades and none involve ${tokenAddress} — ` +
        "the pool is probably wrong for this token. Re-run /settoken (or /setchain) in the group.",
    );
    return null;
  }
  return mergeByTx(buys).sort((a, b) => a.blockNumber - b.blockNumber || a.blockTimeMs - b.blockTimeMs);
}

module.exports = {
  fetchPoolBuys,
  tradeIsBuyOfToken,
  mergeByTx,
  toTrade,
  sameToken,
  FETCH_FLOOR_RATIO,
  PAGE_MAX,
};
