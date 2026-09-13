// TON adapter (@ton/*). Native TON, 9 decimals (nanoton). The @ton libs are
// lazy-loaded so their weight/ESM-ish surface never affects boot. This is the
// least battle-tested chain (per the build plan); detection (getBalance) is
// solid, sweep is best-effort (a fresh wallet deploys on its first send).
const { TON_API_KEY } = require("../../config/constants");
const { rpcRead, rpcUrls } = require("../../config/rpc");
const log = require("../../helpers/logger");

let _libs = null;
function libs() {
  if (_libs) return _libs;
  const core = require("@ton/core");
  const ton = require("@ton/ton");
  const crypto = require("@ton/crypto");
  _libs = { core, ton, crypto };
  return _libs;
}

function makeClient(ton, url) {
  const endpoint = url || rpcUrls("ton")[0];
  if (!endpoint) throw new Error("no RPC configured for ton");
  return new ton.TonClient({ endpoint, apiKey: TON_API_KEY || undefined });
}

async function generate() {
  const { ton, crypto } = libs();
  const mnemonic = await crypto.mnemonicNew(); // 24 words
  const key = await crypto.mnemonicToPrivateKey(mnemonic);
  const wallet = ton.WalletContractV4.create({ workchain: 0, publicKey: key.publicKey });
  // Non-bounceable (UQ…) so a plain wallet-to-wallet send doesn't bounce.
  const address = wallet.address.toString({ urlSafe: true, bounceable: false, testOnly: false });
  return { address, privateKey: mnemonic.join(" ") }; // store the mnemonic to re-derive
}

/** Balance in nanoton. Walks every configured endpoint — this read decides
 *  whether a customer has paid, and a dead node must surface as an ERROR, never
 *  as a zero balance. */
async function getBalance(_chain, address) {
  const { ton, core } = libs();
  const parsed = core.Address.parse(address);
  const { value } = await rpcRead("ton", (url) => makeClient(ton, url).getBalance(parsed));
  return BigInt(value);
}

const ATTEMPTS = 2; // toncenter's public endpoint rate-limits aggressively

async function sweepOnce(wallet, treasury, url) {
  const { ton, core, crypto } = libs();
  const client = makeClient(ton, url);
  const mnemonic = String(wallet.privateKey).trim().split(/\s+/);
  const key = await crypto.mnemonicToPrivateKey(mnemonic);
  const w = ton.WalletContractV4.create({ workchain: 0, publicKey: key.publicKey });
  const balance = await client.getBalance(w.address);
  if (balance <= 0n) return { ok: false, error: "empty" };

  const contract = client.open(w);
  let seqno = 0;
  try {
    seqno = await contract.getSeqno();
  } catch {
    seqno = 0; // not deployed yet → first transfer deploys it
  }
  const internal = ton.internal || core.internal;
  await contract.sendTransfer({
    secretKey: key.secretKey,
    seqno,
    sendMode: 128, // CARRY_ALL_REMAINING_BALANCE — sweep everything
    messages: [internal({ to: core.Address.parse(treasury), value: 0n, bounce: false, body: "Dexvra sweep" })],
  });
  log.info(`[ton] swept ${balance} nanoton → ${treasury} (seqno ${seqno})`);
  // sendMode 128 carries the whole remaining balance, so there is nothing left
  // to reserve — but the send is only BROADCAST here, never confirmed. The
  // retry pass re-checks the balance, which is the only real proof.
  return { ok: true, txid: `seqno:${seqno}` };
}

async function sweep(_chain, wallet, treasury) {
  // ONE node for the whole sweep, chosen ONCE by a read that has to answer
  // before anything is signed. See the send rule in config/rpc.js — and note
  // that TON has no confirmation here at all (`sendTransfer` only broadcasts),
  // so a retry from a node that never saw the first transfer would have nothing
  // to check it against.
  let url;
  try {
    const opened = await rpcRead("ton", async (u) => {
      const { ton, core } = libs();
      await makeClient(ton, u).getBalance(core.Address.parse(wallet.address));
      return u;
    });
    url = opened.url;
  } catch (e) {
    return { ok: false, error: e.message }; // unreadable is UNKNOWN, not empty
  }

  let last = "unknown";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await sweepOnce(wallet, treasury, url);
    } catch (e) {
      last = e.message;
      log.debug(`[ton] sweep attempt ${attempt}/${ATTEMPTS}: ${e.message}`);
    }
  }
  return { ok: false, error: last };
}

module.exports = { family: "ton", generate, getBalance, sweep };
