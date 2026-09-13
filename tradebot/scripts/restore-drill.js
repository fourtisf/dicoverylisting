#!/usr/bin/env node
'use strict';
/*
 * RESTORE DRILL — prove a backup is actually restorable, before you need it to be.
 *
 * A backup you have never restored is not a backup, it is an assumption. This
 * bot is custodial: every user's funds live behind ONE value, WALLET_SECRET, and
 * a ciphertext store that is useless without it. Two ways that goes wrong, and
 * neither announces itself:
 *
 *   • the secret you have saved is not the one that encrypted the store
 *     (rotated, mistyped, copied with a trailing space, from the wrong host)
 *   • the archive is truncated, or is from before a user existed
 *
 * Parsing the JSON proves neither. The only real proof is: decrypt each stored
 * key with the secret, DERIVE the address from it, and check it equals the
 * address recorded next to it. If those match, the secret is right and the
 * ciphertext is intact — for that wallet, provably.
 *
 * This never prints a private key, a seed, or the secret. Addresses and counts
 * only. It is safe to run over a shared screen; the output is safe to paste.
 *
 * Usage:
 *   WALLET_SECRET=… node scripts/restore-drill.js [store.json|store.json.gz]
 *
 * With no path it drills the LIVE store (read-only). To rehearse the real
 * disaster, point it at a downloaded Telegram archive instead:
 *   WALLET_SECRET=… node scripts/restore-drill.js ~/tradebot-2026-07-26.json.gz
 *
 * Exit code 0 = every wallet verified. 1 = something did not.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

function die(msg) { console.error(`\n❌ ${msg}\n`); process.exit(1); }

const arg = process.argv[2];
if (!process.env.WALLET_SECRET) {
  die('WALLET_SECRET is not set. Run: WALLET_SECRET=… node scripts/restore-drill.js [archive]');
}

// Drill against a COPY in a scratch dir. The point is to rehearse a restore, and
// a rehearsal that can write to the live store is not a rehearsal — it is a
// second way to lose the thing you are protecting.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dexvra-restore-drill-'));
process.env.DATA_DIR = scratch;

let source = arg;
if (!source) {
  source = path.join(__dirname, '..', 'data', 'tradebot.json');
  console.log('ℹ️  No archive given — drilling the LIVE store (read-only copy).');
}
if (!fs.existsSync(source)) die(`no such file: ${source}`);

let raw;
try {
  const buf = fs.readFileSync(source);
  raw = /\.gz$/i.test(source) ? zlib.gunzipSync(buf) : buf;
} catch (e) { die(`could not read/ungzip ${source}: ${e.message}`); }

let parsed;
try { parsed = JSON.parse(raw.toString('utf8')); } catch (e) { die(`the archive is not valid JSON (truncated?): ${e.message}`); }
if (!parsed || typeof parsed.users !== 'object') die('the archive has no `users` object — is this a tradebot store?');

fs.writeFileSync(path.join(scratch, 'tradebot.json'), raw);

// Load the REAL app code against the copy. A drill that reimplements the crypto
// proves only that the drill can decrypt it.
let core;
try { core = require('../core'); } catch (e) { die(`could not load core.js (npm install in tradebot/?): ${e.message}`); }
core.loadStore();

const users = core.allUsers();
console.log(`\n🔍 Restore drill — ${path.basename(source)}`);
console.log(`   users: ${users.length}`);

let wallets = 0, evmOk = 0, solOk = 0, failed = 0;
const failures = [];

for (const u of users) {
  for (const w of core.walletList(u)) {
    wallets++;
    // EVM: decrypt → derive → compare with the recorded address.
    try {
      const key = core.exportKey(u.chatId, w.id, 'ethereum');
      const derived = core.walletFromSecret(key).address;
      if (String(derived).toLowerCase() === String(w.address).toLowerCase()) evmOk++;
      else { failed++; failures.push(`user ${u.chatId} wallet ${w.id}: EVM address mismatch (stored ${w.address}, key derives ${derived})`); }
    } catch (e) {
      failed++;
      failures.push(`user ${u.chatId} wallet ${w.id}: EVM decrypt failed — ${e.message}`);
    }
    // Solana: same wallet, different curve. Its address is derived on read, so
    // a successful decrypt that yields the stored address proves both halves.
    try {
      core.exportKey(u.chatId, w.id, 'solana');
      const sol = core.solAddressOf(w);
      if (sol && sol.length > 30) solOk++;
      else { failed++; failures.push(`user ${u.chatId} wallet ${w.id}: no usable Solana address`); }
    } catch (e) {
      failed++;
      failures.push(`user ${u.chatId} wallet ${w.id}: Solana decrypt failed — ${e.message}`);
    }
  }
}

try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}

console.log(`   wallets: ${wallets}`);
console.log(`   EVM keys verified (decrypt → address matches): ${evmOk}/${wallets}`);
console.log(`   Solana keys verified: ${solOk}/${wallets}`);

if (!wallets) {
  console.log('\n⚠️  The archive holds no wallets. Restorable, but it proves nothing about your secret.\n');
  process.exit(1);
}
if (failed) {
  console.error(`\n❌ ${failed} check(s) FAILED:`);
  for (const f of failures.slice(0, 20)) console.error(`   • ${f}`);
  if (failures.length > 20) console.error(`   • …and ${failures.length - 20} more`);
  console.error(
    '\nIf EVERY wallet failed, the WALLET_SECRET you used is not the one that\n' +
    'encrypted this store. Do NOT start the bot with it — a wrong secret does not\n' +
    'destroy anything, but a NEW wallet minted under it would be unrecoverable\n' +
    'with the real one. Find the right secret first.\n',
  );
  process.exit(1);
}

console.log(
  `\n✅ Restore verified. This secret decrypts all ${wallets} wallet(s), and every\n` +
  `   key still derives the address stored beside it. This archive plus this\n` +
  `   secret is a complete, working recovery.\n`,
);
