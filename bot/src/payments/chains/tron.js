// Tron adapter (tronweb v6). Native TRX, 6 decimals (sun).
const TronPkg = require("tronweb");
const TronWeb = TronPkg.TronWeb || TronPkg.default || TronPkg;
const { rpcRead, rpcUrls } = require("../../config/rpc");
const log = require("../../helpers/logger");

// Reserve ladder, in sun (1 TRX = 1,000,000 sun). Tried in order, cheapest
// first, because Tron's fee is usually ZERO: every account gets ~600 free
// bandwidth per day and a TRX transfer costs ~268 of it, so a fresh temp
// wallet's first send is free. The old flat 1.5 TRX reserve therefore stranded
// roughly 1.5 TRX in every temp wallet on every order — permanently.
//
// A rejected Tron transaction is refused before broadcast ("balance is not
// sufficient"), so a failed rung costs nothing and the next one is tried:
//   0        → free bandwidth covers it (the normal case)
//   0.4 TRX  → bandwidth exhausted, burn at ~1,000 sun/byte
//   1.5 TRX  → treasury address not yet activated (1 TRX creation fee)
const RESERVE_LADDER = [0n, 400000n, 1500000n];
const ATTEMPTS = 2; // network flakiness, per rung

function client(privateKey, url) {
  const endpoint = url || rpcUrls("tron")[0];
  if (!endpoint) throw new Error("no RPC configured for tron");
  const opts = { fullHost: endpoint };
  if (privateKey) opts.privateKey = privateKey.replace(/^0x/, "");
  return new TronWeb(opts);
}

async function generate() {
  // createAccount() generates locally (no network). Instance method in v5/v6.
  try {
    const acc = await client().createAccount();
    return { address: acc.address.base58, privateKey: acc.privateKey };
  } catch (e) {
    log.debug(`[tron] createAccount fell back: ${e.message}`);
    const acc = TronWeb.utils.accounts.generateAccount();
    return { address: acc.address.base58, privateKey: String(acc.privateKey).replace(/^0x/, "") };
  }
}

/** Balance in sun. Walks every configured endpoint — this read decides whether
 *  a customer has paid, and a dead node must surface as an ERROR, never as a
 *  zero balance. */
async function getBalance(_chain, address) {
  const { value } = await rpcRead("tron", (url) => client(null, url).trx.getBalance(address));
  return BigInt(value);
}

async function sweep(_chain, wallet, treasury) {
  // ONE node for the whole sweep, chosen ONCE by the opening balance read —
  // outside the retry loop. See the send rule in config/rpc.js: a broadcast is
  // never re-sent to a second node, so re-resolving per attempt would let
  // attempt 2 broadcast from a node that never saw attempt 1.
  let tw;
  let bal;
  try {
    const { value: opened } = await rpcRead("tron", async (url) => {
      const c = client(wallet.privateKey, url);
      return { c, bal: BigInt(await c.trx.getBalance(wallet.address)) };
    });
    tw = opened.c;
    bal = opened.bal;
  } catch (e) {
    return { ok: false, error: e.message }; // unreadable is UNKNOWN, not empty
  }

  let last = "unknown";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) bal = BigInt(await tw.trx.getBalance(wallet.address));
      if (bal <= 0n) return { ok: false, error: "empty" };

      for (const reserve of RESERVE_LADDER) {
        const value = bal - reserve;
        if (value <= 0n) continue; // this rung costs more than the wallet holds
        try {
          const res = await tw.trx.sendTransaction(treasury, Number(value));
          if (res && (res.result === true || res.txid)) {
            const txid = res.txid || (res.transaction && res.transaction.txID);
            log.info(`[tron] swept ${value} sun (reserve ${reserve}) → ${treasury} tx=${txid}`);
            return { ok: true, txid, value };
          }
          last = (res && (res.code || res.message)) || "tx rejected";
        } catch (e) {
          last = e.message;
        }
        log.debug(`[tron] reserve ${reserve} rejected (${last}) — trying the next rung`);
      }
      // Every rung refused and the balance is smaller than the cheapest fee.
      return { ok: false, dust: bal < RESERVE_LADDER[1], error: last };
    } catch (e) {
      last = e.message;
      log.debug(`[tron] sweep attempt ${attempt}/${ATTEMPTS}: ${e.message}`);
    }
  }
  return { ok: false, error: last };
}

module.exports = { family: "tron", generate, getBalance, sweep };
