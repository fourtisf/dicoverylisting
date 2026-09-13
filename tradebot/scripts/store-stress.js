'use strict';
/* Stress the async/sync store-write path for corruption under interleaved
 * saveStore() (async, debounced) + saveStoreNow() (sync, authoritative) with rapid
 * mutations. Verifies: the on-disk file ALWAYS parses (no torn/corrupt write), and the
 * FINAL authoritative write reflects the latest state. Run: node scripts/store-stress.js */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-store-'));
process.env.WALLET_SECRET = 'stresssecret_0000000000000000000000';
process.env.DATA_DIR = DIR;
process.env.BACKUP_MIN_INTERVAL_MS = '999999999';   // no backup churn during the test

const core = require(path.resolve(__dirname, '..', 'core'));
const STORE = path.join(DIR, 'tradebot.json');   // core always writes <DATA_DIR>/tradebot.json
let pass = 0, fail = 0;
const A = (n, c) => { console.log((c ? '✅' : '❌') + ' ' + n); c ? pass++ : fail++; };

// Reader that hammers the file while writes happen — catches torn/corrupt writes.
let readErrors = 0, reads = 0;
const readerTimer = setInterval(() => {
  try { if (fs.existsSync(STORE)) { JSON.parse(fs.readFileSync(STORE, 'utf8')); reads++; } }
  catch (_) { readErrors++; }
}, 1);

(async () => {
  // 1) Burst: many users each firing debounced saveStore (setSlippage) + periodic
  //    saveStoreNow (addWallet mints a key → write-through).
  for (let i = 0; i < 300; i++) {
    const id = 500000 + i;
    core.ensureUser(id);
    core.setSlippage(id, i % 40);            // → saveStore (async debounced)
    if (i % 7 === 0) core.addWallet(id);     // → saveStoreNow (sync write-through)
  }
  // 2) Interleave more with small awaits so async writes are genuinely in-flight when
  //    sync writes land — this is the ordering hazard we must survive.
  for (let r = 0; r < 40; r++) {
    core.setSlippage(500000, (r % 50));      // async
    const id = 700000 + r; core.ensureUser(id); core.addWallet(id);   // sync, may race an in-flight async
    await new Promise((s) => setImmediate(s));
  }
  // 3) Final authoritative state + flush.
  const FINAL = 33;
  core.setSlippage(500000, FINAL);
  core.saveStoreNow ? null : null;           // (setSlippage already persists)
  await new Promise((s) => setTimeout(s, 1500));   // let any async writes settle

  clearInterval(readerTimer);
  A('reader never saw a corrupt/torn file', readErrors === 0);
  A('reader actually read the file (sanity)', reads > 0);

  let disk = null;
  try { disk = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (e) { console.log('  final parse error:', e.message); }
  A('final store parses', !!disk);
  const u = disk && disk.users && disk.users['500000'];
  A('final authoritative mutation persisted (slippage=' + FINAL + ')', !!u && u.settings && u.settings.slippage === FINAL);
  A('minted keys survived (user 700039 has ≥2 wallets)', !!(disk && disk.users && disk.users['700039'] && (disk.users['700039'].wallets || []).length >= 2));

  console.log(`\n${pass} passed, ${fail} failed · reads=${reads} readErrors=${readErrors}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('stress crashed:', e); try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
