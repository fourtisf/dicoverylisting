// Stranded-funds recovery.
//
// The sweep is deliberately fire-and-forget (verify.js): fulfilment must never
// wait on, or be gated by, a chain confirmation. The cost of that choice is
// that a failed sweep is a warning in the log and nothing else — the buyer's
// SOL/ETH/TRX sits in a temp wallet forever, and nobody notices until someone
// opens an explorer. A broken Solana sweep stranded real money exactly this
// way.
//
// So the sweep gets a retry loop. The safety rule is the whole design: only
// wallets belonging to an order that is already `paid` or `fulfilled` are
// touched. That money is earned. A `pending` order's wallet is never swept
// here — the buyer may have sent funds we haven't credited yet, and taking
// those without delivering is the one unrecoverable mistake available.
const orders = require("../payments/orders");
const wallets = require("../payments/wallets");
const log = require("../helpers/logger");

const EVERY_MS = 6 * 3600 * 1000; // a stranded balance is not urgent, just permanent
const BOOT_DELAY_MS = 90 * 1000; // let the bot finish starting first
const MAX_PER_PASS = 25; // bounded RPC work per pass
const GAP_MS = 1500; // public RPC endpoints rate-limit hard
const MAX_AGE_MS = 90 * 24 * 3600 * 1000;
const ALERT_AFTER_TRIES = 4; // ~a day of 6h passes — past a transient RPC blip
// A swept wallet is NOT retired immediately. Buyers do pay twice — a "did it
// go through?" re-send, an exchange splitting a withdrawal — and the second
// transfer lands on an address we already emptied. Retiring on the first
// success meant that money was never looked at again. Keep re-checking for a
// week after the sweep, which costs one balance call per pass.
const RECHECK_AFTER_SWEEP_MS = 7 * 24 * 3600 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Orders whose wallet may still hold funds: earned, unswept, not ancient. */
function candidates(now = Date.now()) {
  return orders
    .allOrders()
    .filter(
      (o) =>
        (o.status === "paid" || o.status === "fulfilled") &&
        !o.adminFree &&
        o.chain &&
        o.address &&
        (!o.sweptAt || now - o.sweptAt < RECHECK_AFTER_SWEEP_MS) &&
        now - (o.createdAt || 0) < MAX_AGE_MS,
    )
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** One pass. Never throws — a bad RPC must not take the bot down. */
async function runOnce() {
  const due = candidates();
  if (!due.length) return { checked: 0, swept: 0 };
  let checked = 0;
  let swept = 0;
  let empty = 0;
  let stuck = 0;
  let unreadable = 0;
  for (const o of due.slice(0, MAX_PER_PASS)) {
    try {
      // BigInt() because ethers returns its own bigint-ish type per version.
      const bal = BigInt(await wallets.getBalance(o.chain, o.address));
      checked++;
      if (bal === 0n) {
        empty++;
        if (o.sweptAt) continue; // already accounted for; the re-check window runs out on its own
        // Emptied, but not by us — there is no transaction to point at. Marked
        // done so it stops being re-checked forever, with the reason recorded
        // so the report never calls it "swept".
        await orders.setStatus(o.id, o.status, { sweptAt: Date.now(), sweptNote: "already empty" });
        log.info(`[sweepretry] ${o.chain} order ${o.id} wallet is empty — nothing to recover`);
        continue;
      }
      log.warn(`[sweepretry] ${o.chain}/${o.address} still holds ${bal} (order ${o.id}) — sweeping`);
      const r = await wallets.sweepByAddress(o.chain, o.address);
      if (r && r.ok) {
        swept++;
        await orders.setStatus(o.id, o.status, { sweptAt: Date.now(), sweptTx: r.txid || "" });
        log.info(`[sweepretry] recovered ${o.chain} order ${o.id} (tx=${r.txid})`);
      } else if (r && r.dust) {
        // Worth less than the gas to move it. Retrying forever would spend
        // more on RPC calls than the balance is worth.
        await orders.setStatus(o.id, o.status, { sweptAt: Date.now(), sweptNote: `dust: ${r.error}` });
        log.info(`[sweepretry] ${o.chain} order ${o.id} left as dust (${r.error})`);
      } else {
        // Left unmarked on purpose: the next pass tries again.
        stuck++;
        const tries = (o.sweepTries || 0) + 1;
        await orders.setStatus(o.id, o.status, { sweepTries: tries });
        log.warn(`[sweepretry] ${o.chain} order ${o.id} still stuck (try ${tries}): ${(r && r.error) || "unknown"}`);
        // A wallet that survives a full day of retries is not a blip. Say so
        // where a human will see it — silence is how the SOL sweep stayed
        // broken through every order.
        if (tries === ALERT_AFTER_TRIES) {
          log.report(
            `⚠️ <b>Sweep stuck</b>\n` +
              `<b>Chain:</b> ${String(o.chain).toUpperCase()}\n` +
              `<b>Wallet:</b> <code>${o.address}</code>\n` +
              `<b>Balance:</b> <code>${bal}</code> (smallest units)\n` +
              `<b>Order:</b> <code>${o.id}</code>\n` +
              `<b>Last error:</b> ${(r && r.error) || "unknown"}\n` +
              `The key is stored — funds are recoverable, but they are NOT in the treasury.`,
          );
        }
      }
    } catch (e) {
      // A balance we couldn't even READ is not "nothing to do" — say so at
      // warn, or a dead RPC looks identical to a clean pass.
      unreadable++;
      log.warn(`[sweepretry] ${o.chain} order ${o.id}: could not read balance — ${e.message}`);
    }
    await sleep(GAP_MS);
  }
  // "checked 1, recovered 0" is ambiguous on its own — it reads the same
  // whether the wallet was already empty or a sweep is failing. Break it out.
  log.info(
    `[sweepretry] pass: ${due.length} candidate(s), checked ${checked}, recovered ${swept}, ` +
      `already empty ${empty}, still stuck ${stuck}, unreadable ${unreadable}`,
  );
  return { checked, swept, empty, stuck, unreadable };
}

function start() {
  const boot = setTimeout(() => {
    runOnce().catch((e) => log.warn(`[sweepretry] ${e.message}`));
  }, BOOT_DELAY_MS);
  const iv = setInterval(() => {
    runOnce().catch((e) => log.warn(`[sweepretry] ${e.message}`));
  }, EVERY_MS);
  if (boot.unref) boot.unref();
  if (iv.unref) iv.unref();
  log.info(`[sweepretry] started — retrying failed sweeps every ${EVERY_MS / 3600000}h`);
  return {
    stop() {
      clearTimeout(boot);
      clearInterval(iv);
    },
    runOnce,
  };
}

module.exports = { start, runOnce, candidates };
