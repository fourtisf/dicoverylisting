// EVM adapter (ethers v6) — covers ethereum / bsc / base / robinhood. One keypair
// is valid on all of them; the chain only selects the RPC + gas market.
const { ethers } = require("ethers");
const { rpcRead, rpcUrls } = require("../../config/rpc");
const log = require("../../helpers/logger");

const PLAIN_TRANSFER_GAS = 21000n; // intrinsic cost of an EOA → EOA send
// ⚠️ WHAT TO SIGN WHEN THE ESTIMATE COULD NOT BE MADE — and 21,000 is not it.
//
// On a Nitro/Orbit chain the L1 poster cost is charged in GAS UNITS, not as a
// separate term, so a plain transfer there costs well above the intrinsic
// 21,000 — which is exactly why the trade bot's own nativeTransferGas falls back
// to 120,000 with the note "covers Orbit L1 gas". Robinhood Chain is one of
// those, and its node is already documented in this repo as answering
// eth_estimateGas with a non-standard envelope. Signing 21,000 there does not
// fail cheaply: the transfer runs OUT OF GAS on-chain, the gas is consumed, and
// the sweep never lands — then sweepRetry comes back and burns it again.
//
// The two errors are not symmetric. Reserving too LITTLE is unrecoverable (gas
// spent, funds still stranded); reserving too MUCH only leaves unused gas in the
// temp wallet, because a node charges for gas USED and refunds the rest. So the
// unmeasured case is generous.
const UNMEASURED_GAS = 120000n;
const ATTEMPTS = 3; // public RPCs rate-limit; a quote can also go stale
const CONFIRM_TIMEOUT_MS = 120000; // never block a sweep pass on a stuck mempool

function provider(chain, url) {
  // No silent fallback to the Ethereum RPC: reading (or sweeping) the wrong
  // chain reports an empty wallet while the funds sit untouched on the real
  // one — a silent loss. A missing RPC is a config error and must say so.
  const endpoint = url || rpcUrls(chain)[0];
  if (!endpoint) throw new Error(`no RPC configured for EVM chain "${chain}"`);
  return new ethers.JsonRpcProvider(endpoint);
}

async function generate() {
  const w = ethers.Wallet.createRandom();
  return { address: w.address, privateKey: w.privateKey };
}

// Every provider built during one call, so they can all be torn down when it
// ends. A JsonRpcProvider pointed at an unreachable node retries network
// detection once a second FOREVER and holds the event loop open doing it — so
// one left behind per failed sweep attempt is a permanent background request
// loop, and a CLI pass (treasury --live, a sweep run) never exits.
function tracked(chain, url, made) {
  const p = provider(chain, url);
  made.set(url, p);
  return p;
}
function dropAll(made) {
  for (const p of made.values()) {
    try {
      p.destroy?.();
    } catch {
      /* best effort */
    }
  }
  made.clear();
}

/** Native balance in wei (BigInt).
 *
 *  This is the read that decides whether a customer has paid, so it walks every
 *  endpoint the chain has. A node that is down must surface as an ERROR — an
 *  unreadable balance is unknown, never zero. Returning 0 here reports a paid
 *  order as unpaid and the buyer is told their payment timed out. */
async function getBalance(chain, address) {
  const made = new Map();
  try {
    const { value } = await rpcRead(chain, (url) => tracked(chain, url, made).getBalance(address));
    return value;
  } finally {
    dropAll(made);
  }
}

/** The fee cap to sign with on an EIP-1559 chain.
 *
 *  Whatever cap is set, the node RESERVES gasLimit × cap and charges only
 *  gasLimit × (baseFee + tip); the difference is refunded — back into the temp
 *  wallet, as dust worth less than the gas it would cost to collect. So the
 *  cap is not free headroom: every gwei of it is money left behind on every
 *  order.
 *
 *  ethers' getFeeData quotes 2×baseFee + tip, which is right for a user's
 *  time-sensitive transaction and wasteful for a sweep. The protocol caps the
 *  base fee rise at 12.5% per block, so 1.5× still covers roughly three blocks
 *  of worst-case increase — and a sweep that does sit pending is not an
 *  incident: the funds are safe where they are and sweepRetry comes back.
 *
 *  Halving the headroom halves the leftover. On a legacy-gas chain (BSC) there
 *  is no refund at all: the price reserved is the price charged, so the wallet
 *  ends at exactly zero. */
const FEE_CAP_TENTHS = 15n; // ×1.5 of base fee, plus the tip

async function feeCap(p, fee) {
  try {
    const blk = await p.getBlock("latest");
    if (blk && blk.baseFeePerGas != null) {
      const tip = BigInt(fee.maxPriorityFeePerGas);
      return (BigInt(blk.baseFeePerGas) * FEE_CAP_TENTHS) / 10n + tip;
    }
  } catch (e) {
    log.debug(`[evm] baseFee lookup failed, using the RPC's own cap: ${e.message}`);
  }
  return BigInt(fee.maxFeePerGas); // safe fallback: the generous quote
}

/** Gas this exact send needs. 21000 is only right for an EOA recipient — a
 *  treasury that is a contract (Safe/multisig, exchange deposit proxy) runs
 *  code on receive, and a hardcoded 21000 burns the gas on an out-of-gas
 *  revert, every time, without ever delivering. */
async function gasFor(p, from, to) {
  try {
    const est = await p.estimateGas({ from, to, value: 1n });
    const e = BigInt(est);
    return e > PLAIN_TRANSFER_GAS ? (e * 12n) / 10n : PLAIN_TRANSFER_GAS;
  } catch (e) {
    log.debug(`[evm] estimateGas fell back to ${UNMEASURED_GAS}: ${e.message}`);
    return UNMEASURED_GAS;
  }
}

/**
 * The L1 data fee an OP-stack chain charges ON TOP of `gasLimit × gasPrice`.
 *
 * ⚠️ op-geth's balance pre-check is `value + gas × gasFeeCap + l1Cost`, and this
 * adapter only ever reserved the first two terms. `value = bal − gasLimit ×
 * priceCap` therefore leaves EXACTLY ZERO slack in that check, so the node
 * rejects the sweep for any l1Cost above zero — deterministically, not on a bad
 * afternoon. Base is a payable chain (and now one of three ETH rails a Base
 * token is offered), so every Base sweep bounces with "insufficient funds for
 * gas * price + value": a message naming the two terms that WERE covered and not
 * the one that was not. The trade bot's withdraw path paid for this lesson
 * already; this is the same fix on the payment sweep.
 *
 * It DISCOVERS whether a chain has the predeploy rather than carrying a list —
 * the rule v4.js follows for the PoolManager — so Ethereum, BSC and Robinhood
 * (Nitro folds L1 into the gas units) answer 0 and behave exactly as they did.
 *
 * ⚠️ A READ THAT FAILED IS NOT A CHAIN WITHOUT AN ORACLE. Caching the second as
 * the first would disable L1 accounting on Base for the life of the process
 * after one transient 403, silently, on the exact path where being short by the
 * L1 fee means the sweep does not send. Only an answer is remembered.
 */
const OP_GAS_ORACLE = "0x420000000000000000000000000000000000000F";
const hasL1Oracle = new Map(); // chain → boolean, ONLY ever set from a read that answered

async function l1DataFee(chain, p, req) {
  let has = hasL1Oracle.get(chain);
  if (has === undefined) {
    let code;
    try {
      code = await p.getCode(OP_GAS_ORACLE);
    } catch (e) {
      log.debug(`[evm] ${chain} L1 oracle probe failed: ${e.message}`);
      return { fee: 0n, ok: false };
    }
    has = !!(code && code !== "0x");
    hasL1Oracle.set(chain, has);
  }
  if (!has) return { fee: 0n, ok: true }; // not an OP-stack chain: 0 is the true answer
  try {
    // The unsigned serialization under-counts by the signature bytes the oracle
    // would see; the caller's headroom covers that, and an over-estimate only
    // ever means a slightly smaller sweep.
    const raw = ethers.Transaction.from(req).unsignedSerialized;
    const oracle = new ethers.Contract(OP_GAS_ORACLE, ["function getL1Fee(bytes) view returns (uint256)"], p);
    const f = await oracle.getL1Fee(raw);
    return { fee: BigInt(f) > 0n ? BigInt(f) : 0n, ok: true };
  } catch (e) {
    log.debug(`[evm] ${chain} getL1Fee failed: ${e.message}`);
    return { fee: 0n, ok: false };
  }
}

/** Sweep the native balance to `treasury`, keeping back only what the node
 *  actually reserves for gas. */
async function sweep(chain, wallet, treasury) {
  // ONE endpoint for the whole sweep, chosen ONCE — OUTSIDE the retry loop.
  //
  // The opening read PICKS THE ENDPOINT, and everything after it — the fee
  // quote, the gas estimate, the broadcast, and every later attempt — stays on
  // that same node. Reading from a healthy backup and then broadcasting to the
  // dead primary only moves where it fails; and re-resolving PER ATTEMPT is
  // worse still, because attempt 2 can then broadcast from a node that never
  // saw attempt 1's transaction. Here the nonce collapses the duplicates (every
  // attempt signs nonce n, only one can be mined) so the cost is wasted
  // broadcasts — on Solana, which has no nonce, the same shape is a real
  // double-spend. Nothing is signed until a node has answered, so choosing the
  // endpoint at this point cannot double-spend.
  const made = new Map();
  let p;
  let bal;
  try {
    const { value: opened } = await rpcRead(chain, async (url) => {
      const prov = tracked(chain, url, made);
      return { prov, bal: BigInt(await prov.getBalance(wallet.address)) };
    });
    p = opened.prov;
    bal = opened.bal;
  } catch (e) {
    dropAll(made);
    // Unreadable is UNKNOWN, not empty. sweepRetry comes back for it.
    return { ok: false, error: e.message };
  }

  let last = "unknown";
  try {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let sent = null;
    try {
      // Re-read on the SAME node: if a previous attempt's transfer landed, that
      // node is the one that knows.
      if (attempt > 1) bal = BigInt(await p.getBalance(wallet.address));
      const signer = new ethers.Wallet(wallet.privateKey, p);
      if (bal <= 0n) return { ok: false, error: "empty" };

      const fee = await p.getFeeData();
      const eip1559 = fee.maxFeePerGas != null && fee.maxPriorityFeePerGas != null;
      // The node's balance check is against the PRICE CAP, not the price it
      // will charge, so that is exactly what has to be held back.
      const priceCap = eip1559 ? await feeCap(p, fee) : fee.gasPrice != null ? BigInt(fee.gasPrice) : null;
      if (!priceCap) return { ok: false, error: "no gas price from RPC" };

      const gasLimit = await gasFor(p, wallet.address, treasury);
      // Reserve gasLimit × cap — no arbitrary multiplier. The old 2× buffer
      // stranded a full extra transaction's worth of native token in every
      // temp wallet, permanently, on every order.
      const l2Reserve = gasLimit * priceCap;
      // …plus the THIRD term an OP-stack node puts in its balance check. Priced
      // against a provisional value, because the L1 fee is a function of the
      // serialized bytes and `value` is a few of them; +25% covers that and the
      // signature bytes the unsigned form omits. A read that could not be made
      // stands in with the L2 cost rather than a zero — the same choice the
      // trade bot makes, and for the same reason: too little is unrecoverable.
      const l1 =
        bal > l2Reserve
          ? await l1DataFee(chain, p, {
              to: treasury,
              value: bal - l2Reserve,
              gasLimit,
              ...(eip1559
                ? { type: 2, maxFeePerGas: priceCap, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
                : { type: 0, gasPrice: fee.gasPrice }),
            })
          : { fee: 0n, ok: true };
      const l1Cost = l1.ok ? l1.fee : l2Reserve;
      const reserve = l2Reserve + l1Cost + l1Cost / 4n;
      const value = bal - reserve;
      if (value <= 0n) {
        // Not a failure to retry forever: the balance cannot pay for its own
        // sweep, so it is dust and stays where it is.
        return { ok: false, dust: true, error: `balance ${bal} below sweep cost ${reserve}` };
      }

      const tx = {
        to: treasury,
        value,
        gasLimit,
        ...(eip1559
          ? { maxFeePerGas: priceCap, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
          : { gasPrice: fee.gasPrice }),
      };
      sent = await signer.sendTransaction(tx);
      // Broadcast: committed. Never loop past this point — a second attempt
      // would reuse the nonce and fight its own pending transaction.
      await sent.wait(1, CONFIRM_TIMEOUT_MS);
      log.info(`[evm] swept ${value} wei (gas ${gasLimit}×${priceCap}) on ${chain} → ${treasury} tx=${sent.hash}`);
      return { ok: true, txid: sent.hash, value };
    } catch (e) {
      last = e.message;
      if (sent) {
        // In the mempool but not confirmed in time. Reported as not-ok so the
        // retry pass re-checks the BALANCE later — the truth is on-chain, and
        // claiming success here would stop anyone ever looking again.
        log.warn(`[evm] ${chain} sweep broadcast but unconfirmed (tx=${sent.hash}): ${e.message}`);
        return { ok: false, txid: sent.hash, error: `unconfirmed: ${e.message}` };
      }
      log.debug(`[evm] sweep ${chain} attempt ${attempt}/${ATTEMPTS}: ${e.message}`);
    }
  }
  return { ok: false, error: last };
  } finally {
    // Wraps the WHOLE loop, not one attempt: the provider is shared across
    // attempts now, so tearing it down after attempt 1 would destroy the node
    // attempt 2 is about to use. Runs after every await above has settled —
    // including `sent.wait()` — so it can never cut off a live broadcast.
    dropAll(made);
  }
}

module.exports = {
  family: "evm",
  generate,
  getBalance,
  sweep,
  gasFor,
  l1DataFee,
  UNMEASURED_GAS,
  // The oracle verdict is remembered per chain for the life of the process,
  // which is right in production and is inherited state in a suite: one test
  // that probes an OP-stack chain answers for every later one. Stated rather
  // than inherited — the scar the auto-trend panel helper already carries.
  _test_forgetL1Oracle: () => hasL1Oracle.clear(),
};
