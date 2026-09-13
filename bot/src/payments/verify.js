// Payment verification: a t=0 balance check, then a poll up to the timeout. On
// success the sweep is fired (not awaited) so onSuccess/fulfilment is never
// blocked by — or gated on — the sweep landing.
//
// ⚠️ BOTH HALVES ARE OPTIONAL TO THE CALLER, and that is not tidiness. A caller
// running inside a Telegraf handler cannot afford either of them unbounded:
// the polling loop does not fetch the next batch of updates until every handler
// has settled, so waiting here is the whole bot going deaf (see
// PAYMENT_CONFIRM_MS). `opts.timeout: 0` asks one question and answers it;
// `opts.firstReadMs` bounds the RPC read that answers it. The background scans
// (recovery.js) pass neither and behave exactly as they always have.
const { PAYMENT_POLL_MS, PAYMENT_TIMEOUT_MS, PAYMENT_TOLERANCE_PCT } = require("../config/constants");
const wallets = require("./wallets");
const { bounded } = require("../helpers/bounded");
const log = require("../helpers/logger");

// Ceiling on the tolerance knob. A typo (PAYMENT_TOLERANCE_PCT=95) must not
// quietly hand out paid services for 5% of the price.
const MAX_TOLERANCE_PCT = 20;

/** The amount actually accepted as payment.
 *
 *  A customer withdrawing straight from an exchange routinely lands a hair
 *  short — the exchange takes its fee off the top — and with an exact-match
 *  check that payment is never credited: they get nothing, and their funds sit
 *  in a temp wallet that no sweep will ever touch (only paid orders are swept).
 *  PAYMENT_TOLERANCE_PCT was documented in .env.example and exported from
 *  constants, but read by no code at all; setting it did nothing. 0 keeps the
 *  exact-amount behaviour, so this changes nothing until an operator opts in. */
function acceptThreshold(amount) {
  const target = BigInt(amount);
  let pct = Math.floor(Number(PAYMENT_TOLERANCE_PCT) || 0);
  if (pct <= 0) return target;
  if (pct > MAX_TOLERANCE_PCT) {
    log.warn(`[verify] PAYMENT_TOLERANCE_PCT=${pct} is above the ${MAX_TOLERANCE_PCT}% ceiling — clamped`);
    pct = MAX_TOLERANCE_PCT;
  }
  return target - (target * BigInt(pct)) / 100n;
}

/** Resolve true once balance ≥ target, or false at timeout. Never rejects. */
function pollBalance(chain, address, target, timeout = PAYMENT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(async () => {
      try {
        const bal = await wallets.getBalance(chain, address);
        if (bal >= target) {
          clearInterval(iv);
          return resolve(true);
        }
      } catch (e) {
        log.debug(`[verify] poll ${chain} err: ${e.message}`);
      }
      if (Date.now() - start >= timeout) {
        clearInterval(iv);
        return resolve(false);
      }
    }, PAYMENT_POLL_MS);
  });
}

/** Record a landed sweep on the order so sweepRetry stops re-checking that
 *  wallet. A failure is left unmarked on purpose — that is the retry's cue. */
async function noteSwept(chain, address, txid) {
  try {
    const orders = require("./orders");
    const o = orders.allOrders().find((x) => x.address === address && x.chain === chain);
    if (o) await orders.setStatus(o.id, o.status, { sweptAt: Date.now(), sweptTx: txid || "" });
  } catch (e) {
    log.debug(`[verify] noteSwept: ${e.message}`);
  }
}

/** The t=0 read, BOUNDED.
 *
 *  `wallets.getBalance` is an RPC call with no deadline of its own, and this one
 *  runs on the Confirm tap — where a wedged public node does not cost one slow
 *  answer, it parks Telegraf's polling loop and the bot answers nobody (see
 *  PAYMENT_CONFIRM_MS). A read we could not finish is reported as `null`, never
 *  as a zero balance: "we could not ask" and "the money is not there" are
 *  different facts, and only the second one is about the buyer. Both are handled
 *  the same way by the caller — hand it to the watcher — but the log line has to
 *  be able to tell them apart, because one of them is our RPC.
 */
async function balanceNow(chain, address, ms) {
  const MISS = Symbol("timeout");
  const r = await bounded(
    wallets.getBalance(chain, address).catch((e) => {
      log.debug(`[verify] t0 ${chain}: ${e.message}`);
      return null;
    }),
    ms,
    () => MISS,
  );
  if (r === MISS) {
    log.warn(`[verify] t0 ${chain} did not answer in ${ms}ms — handing off to the watcher`);
    return null;
  }
  return r;
}

/** Confirm `amount` (smallest-unit string/BigInt) has landed at `address`.
 *
 *  `opts.timeout` is how long to KEEP LOOKING after the first read comes up
 *  short. 0 means "look once and answer" — which is what the Confirm tap uses,
 *  because anything longer runs inside Telegraf's polling loop. The full poll
 *  still happens; it happens detached.
 *
 *  `opts.firstReadMs` bounds that first read. Absent, the read is unbounded,
 *  which is right for the background scans (recovery.js) and wrong for a tap.
 */
async function verifyPayment(chain, address, amount, opts = {}) {
  if (BigInt(amount) <= 0n) return { paid: true, free: true };
  const target = acceptThreshold(amount);
  const timeout = opts.timeout == null ? PAYMENT_TIMEOUT_MS : Math.max(0, Number(opts.timeout) || 0);

  let bal = null;
  if (opts.firstReadMs > 0) {
    bal = await balanceNow(chain, address, opts.firstReadMs);
  } else {
    try {
      bal = await wallets.getBalance(chain, address);
    } catch (e) {
      log.debug(`[verify] t0 ${chain}: ${e.message}`);
    }
  }
  let paid = bal != null && bal >= target;
  // `timeout > 0` and not merely truthy: a caller asking for no wait must not
  // buy one interval tick's worth of it, and pollBalance's own floor would give
  // it one.
  if (!paid && timeout > 0) paid = await pollBalance(chain, address, target, timeout);

  if (paid) {
    // Sweep BEFORE the caller runs fulfilment — but don't block on confirmation.
    // A failure here is not fatal and not final: sweepRetry picks it up.
    wallets
      .sweepByAddress(chain, address)
      .then((r) => {
        if (r && r.ok) return noteSwept(chain, address, r.txid);
        log.warn(`[verify] sweep ${chain} did not land: ${(r && r.error) || "unknown"} — sweepRetry will retry`);
      })
      .catch((e) => log.warn(`[verify] sweep threw ${chain}: ${e.message}`));
  }
  return { paid };
}

module.exports = { verifyPayment, pollBalance, acceptThreshold, balanceNow };
