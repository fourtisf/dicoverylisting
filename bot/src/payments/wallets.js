// Temp-wallet lifecycle: generate → persist key (encrypted at rest) → balance →
// sweep. A key is ALWAYS persisted before the address is returned, so we never
// hand out an address whose funds we couldn't later recover/sweep. Keys live
// only on disk under .keys/ (never dumped to a channel).
const path = require("node:path");
const fss = require("node:fs");
const { promises: fs } = require("node:fs");
const crypto = require("node:crypto");
const { WALLETS_DIR, WALLET_ENC_KEY, TREASURY, BOT_TOKEN, PK_CHANNEL } = require("../config/constants");
const { familyOf } = require("../config/chains");
const log = require("../helpers/logger");

// Optional private-key backup to a PRIVATE channel (like fourtis) so funds in a
// temp wallet whose sweep failed are always recoverable. Fire-and-forget; the
// key is ALSO stored (encrypted) on disk. The channel MUST be private.
function backupKeyToChannel(chain, wallet, meta) {
  if (!PK_CHANNEL || !BOT_TOKEN) return;
  const m = meta || {};
  const buyer = m.buyerId
    ? `${m.buyerUsername ? "@" + m.buyerUsername + " " : ""}(<code>${m.buyerId}</code>)`
    : "-";
  const text =
    `🔑 <b>New Payment Wallet</b>\n` +
    (m.service ? `<b>Service:</b> ${m.service}\n` : "") +
    (m.plan ? `<b>Plan:</b> ${m.plan}\n` : "") +
    `<b>Chain:</b> ${String(chain).toUpperCase()}\n` +
    (m.amountHuman ? `<b>Amount:</b> ${m.amountHuman}\n` : "") +
    `<b>Buyer:</b> ${buyer}\n` +
    `<b>Address:</b> <code>${wallet.address}</code>\n` +
    `<b>Private Key:</b>\n<code>${wallet.privateKey}</code>\n` +
    `<b>Order:</b> <code>${m.orderId || "-"}</code>\n` +
    `<b>Date:</b> ${new Date().toISOString()}`;
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: PK_CHANNEL, text, parse_mode: "HTML" }),
    signal: AbortSignal.timeout(10000),
  }).catch((e) => log.debug(`[wallets] PK channel post: ${e.message}`));
}

const ADAPTERS = {
  evm: require("./chains/evm"),
  solana: require("./chains/solana"),
  tron: require("./chains/tron"),
  ton: require("./chains/ton"),
};

function adapterFor(chain) {
  const a = ADAPTERS[familyOf(chain)];
  if (!a) throw new Error(`unsupported payment chain: ${chain}`);
  return a;
}

// ── At-rest encryption (AES-256-GCM) ─────────────────────────────────────────
function encKey() {
  if (!WALLET_ENC_KEY) return null;
  try {
    const b = Buffer.from(WALLET_ENC_KEY, "hex");
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}
function encrypt(text) {
  const key = encKey();
  if (!key) return { enc: false, data: text };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return { enc: true, data: Buffer.concat([iv, tag, ct]).toString("base64") };
}
function decrypt(rec) {
  if (!rec.enc) return rec.data;
  const key = encKey();
  if (!key) throw new Error("WALLET_ENC_KEY missing/invalid — cannot decrypt stored key");
  const buf = Buffer.from(rec.data, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

// ── Key persistence ──────────────────────────────────────────────────────────
function keyFile(chain, address) {
  return path.join(WALLETS_DIR, chain, `${address}.json`);
}
async function persistKey(chain, wallet, meta) {
  const dir = path.join(WALLETS_DIR, chain);
  await fs.mkdir(dir, { recursive: true });
  const rec = {
    chain,
    address: wallet.address,
    key: encrypt(wallet.privateKey),
    meta: meta || {},
    createdAt: Date.now(),
  };
  const file = keyFile(chain, wallet.address);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  try {
    fss.chmodSync(file, 0o600);
  } catch {
    /* best-effort perms */
  }
}

/** Generate a fresh receiving wallet for `chain`, persist its key, return it. */
async function generateWallet(chain, meta) {
  const wallet = await adapterFor(chain).generate();
  if (!wallet || !wallet.address || !wallet.privateKey) {
    throw new Error(`wallet generation failed for ${chain}`);
  }
  await persistKey(chain, wallet, meta); // MUST succeed before we hand out the address
  if (!encKey()) {
    log.warn(`[wallets] WALLET_ENC_KEY not set — ${chain} key stored in PLAINTEXT under .keys/`);
  }
  backupKeyToChannel(chain, wallet, meta); // optional private-channel backup
  return wallet;
}

/** Load a previously generated wallet (with private key) from disk, or null. */
async function loadWallet(chain, address) {
  try {
    const rec = JSON.parse(await fs.readFile(keyFile(chain, address), "utf8"));
    return { address: rec.address, privateKey: decrypt(rec.key) };
  } catch (e) {
    log.debug(`[wallets] loadWallet ${chain}/${address}: ${e.message}`);
    return null;
  }
}

async function getBalance(chain, address) {
  return adapterFor(chain).getBalance(chain, address);
}

function treasuryFor(chain) {
  const fam = familyOf(chain);
  if (fam === "evm") return TREASURY.evm;
  if (fam === "solana") return TREASURY.solana;
  if (fam === "tron") return TREASURY.tron;
  if (fam === "ton") return TREASURY.ton;
  return "";
}

async function sweep(chain, wallet) {
  const dest = treasuryFor(chain);
  if (!dest) {
    log.warn(`[wallets] no treasury for ${chain} — sweep skipped, funds remain in ${wallet.address}`);
    return { ok: false, skipped: true };
  }
  const r = await adapterFor(chain).sweep(chain, wallet, dest);
  if (r.ok) log.info(`[wallets] swept ${chain} → ${dest} (tx=${r.txid})`);
  else if (!r.skipped) log.warn(`[wallets] sweep ${chain} failed: ${r.error}`);
  return r;
}

/** Load the key by address, then sweep. Used post-payment (key not in memory). */
async function sweepByAddress(chain, address) {
  const wallet = await loadWallet(chain, address);
  if (!wallet) {
    log.warn(`[wallets] no stored key for ${chain}/${address} — cannot sweep`);
    return { ok: false, error: "no key" };
  }
  return sweep(chain, wallet);
}

module.exports = {
  adapterFor,
  generateWallet,
  loadWallet,
  getBalance,
  treasuryFor,
  sweep,
  sweepByAddress,
};
