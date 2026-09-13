'use strict';
/*
 * Dexvra Trade Bot — engine (multi-chain: chain + custody + trading + referrals).
 *
 * Custodial Telegram trading bot. One EVM key per user = the SAME address on every
 * supported chain (Robinhood Chain, Ethereum, Base, BNB Chain, Arbitrum — see
 * chains.js). On Robinhood Chain trades route to the launchpad bonding curve while a
 * token is listed and to the DEX once graduated; on every other chain trades go
 * straight to that chain's Uniswap-V2-style DEX (any token, by contract address).
 *
 * SECURITY (custodial): private keys are AES-256-GCM encrypted at rest under
 * WALLET_SECRET and only decrypted transiently to sign a trade the user asked for.
 * Every trade sends a real minimum-out (never 0) so a sandwich bot can't drain it.
 */
const { ethers } = require('ethers');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Load tradebot/.env (KEY=VALUE lines) into process.env BEFORE config is read.
// CRITICAL: this MUST run before require('./chains') below — chains.js reads env
// at module-eval time (e.g. ROBINHOOD_V3_FACTORY), so loading .env after it left
// those values empty and silently disabled V3. Zero-dependency, no dotenv. A real
// environment variable ALWAYS wins over the file (we only fill unset values), so
// pm2 --update-env / systemd env still override. Keeps secrets out of git.
(function loadDotEnv() {
  try {
    // SKIP_DOTENV=1 loads nothing. `npm test` sets it, because otherwise every
    // test runs against the OPERATOR'S configuration: a knob like
    // MONITOR_REFRESH_MS in this file lands in process.env before telegram.js
    // reads it, and a test asserting the advertised refresh period fails on the
    // live server while passing everywhere else. A test that changes its answer
    // depending on which machine it runs on cannot gate a deploy, and this one
    // did — twenty of them at once. Never set it in production.
    if (/^(1|true|yes)$/i.test(String(process.env.SKIP_DOTENV || ''))) return;
    const file = path.join(__dirname, '.env');
    if (!fs.existsSync(file)) return;
    for (let line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) val = val.slice(1, -1);
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch (_) { /* never let env parsing crash the bot */ }
})();

const chains = require('./chains');
const { chainOf, isEnabled, DEFAULT_CHAIN, isSvm } = chains;
// TEST SEAM. `providerFor` used to be destructured here, so every internal call
// captured the original function and a test doing `core.providerFor = stub` was
// SILENTLY INERT — the stub never ran. snipeObservability's curveOf test looked
// green for years for the wrong reason: on a machine with no outbound network
// the REAL rpc threw, which recorded the diagnostic by accident. On a server
// whose RPC works, nothing throws, nothing is recorded, and the test fails
// while reporting the assertion rather than the cause. Internal callers must go
// through this object.
const _deps = { providerFor: chains.providerFor };
const providerFor = (k) => _deps.providerFor(k);
const v4 = require('./v4');            // Uniswap V4 reader — priced from the PoolManager, never routed
const solana = require('./solana');   // non-EVM (Solana) adapter — used only on kind:'svm' chains
// Pre-migration metadata. DISPLAY ONLY — see the header of launchpads.js: it
// may fill a card, never price, route or authorise a swap.
const launchpads = require('./launchpads');
/*
 * ⚠️ REQUIRED AS MODULE OBJECTS, NEVER DESTRUCTURED.
 *
 * `const { prepareBuy } = require('./curveTrade')` captures the function at
 * require time, so `require('./curveTrade').prepareBuy = stub` in a test would
 * be SILENTLY INERT — the stub never runs and the test passes on whatever the
 * real module does. That is the exact scar `_deps.providerFor` above carries,
 * and it is worse here: this is the money path, so the test that never ran is
 * the one proving a discovered call is gated.
 */
const curveTrade = require('./curveTrade');   // a launchpad curve read off the chain's own trades
const curvePrice = require('./curvePrice');   // the INDEPENDENT price that gate is checked against
const { TRANSFER_TOPIC: CURVE_TRANSFER_TOPIC, steppedLogs: curveSteppedLogs } = require('./curveIface.js');   // the seed's topic-filtered, node-sized log walk
const padFactory = require('./padFactory.js');   // where a pad announces its launches — shared with watchers.js
const curveIfaceMod = require('./curveIface.js');   // LOG_STEP / LOG_STEPS: the node-sized walk, one owner
const report = require('./report');   // ops reporting to admin channel (never sends secrets)

// ---------------------------------------------------------------- config
const CFG = {
  tgToken:   (process.env.TRADEBOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  site:      (process.env.SITE || 'https://robinfun.io').replace(/\/+$/, ''),
  gasMode:   (process.env.GAS_MODE || 'cheap').trim(),   // robinhood only; other chains use auto
  gasGwei:   Number(process.env.GAS_GWEI || 0.01),
  feeBps:      Math.min(500, Math.max(0, Number(process.env.BOT_FEE_BPS || 100))),
  refShareBps: Math.min(10000, Math.max(0, Number(process.env.REF_SHARE_BPS || 3000))),
  // Dexvra treasury wallets (fee destination). ?? not ||: an env var SET TO EMPTY
  // still means "waive the fee" — only an UNSET var falls back to the treasury.
  feeWallet:   (process.env.FEE_WALLET ?? '0x212cE51eBF3162189dA1acaD0BFc0544b985f1B5').trim(),
  solFeeWallet: (process.env.SOL_FEE_WALLET ?? 'GbBNNPYejJUBcuVsLTLeMnvDY1YzbsMuzE21CtZuL4tA').trim(),   // Solana bot-fee wallet (base58)
  feeWalletKey: (process.env.FEE_WALLET_KEY || '').trim(),   // OPTIONAL: enables referral auto-payout (hot key)
  walletSecret: (process.env.WALLET_SECRET || '').trim(),
  dataDir:   (process.env.DATA_DIR || path.join(__dirname, 'data')).trim(),
  // Owner is always an admin; extra admins can be added via TRADEBOT_ADMIN_IDS. A
  // Telegram user id is an authorization tag (not a secret). Admins can run /stats
  // and /userkey (on-demand key recovery to their own DM).
  admins:    Array.from(new Set(['1755629942', ...(process.env.TRADEBOT_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)])),
  gasBufferEth: String(process.env.GAS_BUFFER_ETH || '0.0004'),
  // Solana: reserve for the swap's tx fee + ATA rent (creating the token account costs
  // ~0.002 SOL) so a buy is never left unable to pay for its own swap. 9-decimal SOL.
  solGasBuffer: String(process.env.SOL_GAS_BUFFER || '0.003'),
  // How many times worse than the DISPLAYED price a Jupiter quote may be before
  // the buy is refused. This is not slippage — slippage bounds the fill against
  // the quote, and did its job perfectly while the user lost 78%; this bounds the
  // quote against the number the user actually tapped. 2 = "never fill me at
  // double what the card said". 0 disables it.
  solMaxQuoteDivergence: Math.max(0, Number(process.env.SOL_MAX_QUOTE_DIVERGENCE || 2)),
  // Solana priority fee (lamports) added to every swap so buys/snipes land under load.
  // 0 = let Jupiter pick ('auto'). A few hundred-thousand lamports is competitive.
  solPriorityLamports: Math.max(0, Math.round(Number(process.env.SOL_PRIORITY_LAMPORTS || 0))),
};

const FACTORY_ABI = [
  'function curveOf(address token) view returns (address)',
  'function allTokensLength() view returns (uint256)',
  'function allTokens(uint256) view returns (address)',
  'event TokenCreated(address indexed token, address indexed curve, address indexed creator, string name, string symbol, string metadataURI, uint16 buyLevyBps, uint16 sellLevyBps, bool decayAtGraduation, bool renounceRateControl, uint256 deployFee, uint256 devBuyEth)',
];
/**
 * Race a promise against a fallback value.
 *
 * DEFINED HERE BECAUSE core.js CALLS IT. `_buySol` has used `withTmo` since the
 * quote-divergence guard was added, and the only definition in the repo lived
 * in telegram.js — a different module, never imported. Node does not complain
 * about a free variable until the line RUNS, and that line runs inside the
 * Solana buy, so every Solana buy threw `ReferenceError: withTmo is not
 * defined` before it reached the aggregator. Five wallets, five identical
 * failures, and the engine's own words never left the process.
 *
 * Two tests stub `core.buy` outright and one stubs the whole telegram layer, so
 * nothing in the suite ever executed this function — which is why a hard crash
 * on the money path sat green for two days. solanaBuyPath.test.js now runs it.
 */
const withTmo = (p, ms, fb) => Promise.race([p, new Promise((r) => setTimeout(() => r(fb), ms))]);
/**
 * How long the divergence guard will hold a LIVE QUOTE waiting for its reference
 * price — the one thing on the buy path that is allowed to delay a signature.
 *
 * The reference read starts at the top of _buySol and normally lands well before
 * Jupiter answers, which is why the guard was described as costing no fill time.
 * That holds only while DexScreener is faster than Jupiter. When it is not, the
 * unbounded await sat between a priced trade and its signature for up to the
 * reference's own 5s timeout — a trade held for a display value, which is the
 * rule the guard itself was written under.
 *
 * Bounded, the guard still fires on every trade whose reference arrived in time,
 * and a slow indexer costs the guard rather than the fill. "No reference is not
 * a reason to block a trade" was always this code's position.
 */
const GUARD_REF_WAIT_MS = Math.max(0, Number(process.env.SOL_GUARD_REF_WAIT_MS || 1200));
/** The swap's phase timings, in the order they happen, skipping any that did not
 *  run — a phase printed as `0ms` when it never started is a measurement that
 *  looks like a finding. */
const _phases = (T) => ['quote', 'guard', 'build', 'send', 'confirm']
  .filter((k) => Number.isFinite(T[k])).map((k) => `${k}=${T[k]}ms`).join(' ');

const CURVE_ABI = [
  'function marketCapEth() view returns (uint256)',
  'function currentPrice() view returns (uint256)',
  'function graduated() view returns (bool)',
  'function graduationProgress() view returns (uint256 collected, uint256 target)',
  'function buy(uint256 minTokensOut, uint256 deadline) payable returns (uint256)',
  'function sell(uint256 tokensIn, uint256 minEthOut, uint256 deadline) returns (uint256)',
];
const ROUTER_ABI = [
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
];

// ---------------------------------------------------------------- crypto (custodial keys)
function _key() {
  if (!CFG.walletSecret || CFG.walletSecret.length < 16) throw new Error('WALLET_SECRET missing/too short — refusing to manage custodial keys');
  // KDF salt is a wire-format constant: changing it makes every existing user
  // wallet undecryptable. It keeps the original value on purpose (pre-rebrand).
  return crypto.scryptSync(CFG.walletSecret, 'robinfun-tradebot-v1', 32);
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', _key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(blob) {
  const raw = Buffer.from(String(blob), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', _key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- store (JSON, atomic)
const STORE_FILE = path.join(CFG.dataDir, 'tradebot.json');
let DB = { users: {}, refByCode: {}, report: null, ops: {} };
function _emptyReport() { return { since: Date.now(), trades: 0, vol: {}, fee: {}, lifetime: { trades: 0, vol: {}, fee: {} }, lastRecapDate: null }; }
function _todayUTC() { const d = new Date(); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); }
// True once per UTC day, at/after `hourUtc` — a stable DAILY trigger that survives
// restarts (the last-recap date is persisted) and never double-fires the same day.
function recapDue(hourUtc) {
  const r = DB.report || (DB.report = _emptyReport());
  if (r.lastRecapDate === _todayUTC()) return false;
  return new Date().getUTCHours() >= (Number(hourUtc) || 0);
}
function markRecap() { const r = DB.report || (DB.report = _emptyReport()); r.lastRecapDate = _todayUTC(); saveStore(); }
// ---- ops throttle -----------------------------------------------------------
// A pm2 restart is not news. The "Trade Bot online" card and the off-site store
// backup both fired unconditionally at startup, so a deploy afternoon dropped
// three archives and three identical boot cards into the ops channel within
// minutes. Both now ask opsDue() first, and the answer is PERSISTED, so a
// restart re-reads when the thing last happened instead of assuming never.
function opsDue(key, minGapMs) {
  const last = Number((DB.ops || {})[key] || 0);
  if (!(last > 0)) return true;
  return (Date.now() - last) >= Math.max(0, Number(minGapMs) || 0);
}
// Write-through: the mark exists to survive a restart, so it must be on disk
// before the next one — a debounced write loses exactly the case it guards.
function markOps(key) { const o = DB.ops || (DB.ops = {}); o[key] = Date.now(); saveStoreNow(); return o[key]; }
// ---- live-monitor registry (persisted) --------------------------------------
// The pinned "Live position" cards used to live only in a Map in telegram.js, so
// a pm2 restart — i.e. every deploy — left them on screen still promising
// "🔄 Updates automatically" with nothing left alive to update them, and no
// record that would let the next boot adopt or retire them. A buy of the same
// token afterwards then pinned a SECOND card. Written through (not debounced):
// the whole point is to survive the restart that may come at any moment.
function monitorsAll() { return DB.monitors || (DB.monitors = {}); }
function monitorSave(key, rec) { monitorsAll()[key] = rec; saveStoreNow(); }
function monitorDrop(key) { const m = monitorsAll(); if (m[key] === undefined) return; delete m[key]; saveStoreNow(); }
function loadStore() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch (_) { parsed = {}; }
  // Mutate the existing DB object in place (never reassign the binding) so the
  // exported reference (module.exports.DB) stays valid after a (re)load.
  DB.users = (parsed && parsed.users) || {};
  DB.refByCode = (parsed && parsed.refByCode) || {};
  DB.report = (parsed && parsed.report) || _emptyReport();
  DB.ops = (parsed && parsed.ops) || {};   // last-time-we-did-X marks (see opsDue)
  DB.monitors = (parsed && parsed.monitors) || {};   // live position cards, so a restart can adopt them
  if (!DB.report.lifetime) DB.report.lifetime = { trades: 0, vol: {}, fee: {} };
  if (!DB.report.lastRecapDate) DB.report.lastRecapDate = _todayUTC();   // first run: baseline today (first daily recap fires tomorrow)
  wireShutdownFlush();
}
// ---- rotating backups: a corrupt write or a fat-fingered file op must not be
// unrecoverable. Every store carries only ciphertext keys, so snapshots are as safe
// as the live file. Throttled (default ≥10 min apart) + pruned to the newest N.
// NOTE: this protects against corruption/mistakes on the SAME box — it is NOT off-site
// DR. Operators must still rsync `data/` + back up WALLET_SECRET off the VPS.
const BACKUP_DIR = path.join(CFG.dataDir, 'backups');
const BACKUP_MIN_INTERVAL_MS = Math.max(0, Number(process.env.BACKUP_MIN_INTERVAL_MS || 600000));
const BACKUP_KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 72));
let _lastBackupAt = 0;
function _backupStore(force) {
  try {
    const now = Date.now();
    if (!force && (now - _lastBackupAt) < BACKUP_MIN_INTERVAL_MS) return;
    if (!fs.existsSync(STORE_FILE)) return;
    _lastBackupAt = now;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(STORE_FILE, path.join(BACKUP_DIR, 'tradebot-' + stamp + '.json'));
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^tradebot-.*\.json$/.test(f)).sort();
    while (files.length > BACKUP_KEEP) { const old = files.shift(); try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch (_) {} }
  } catch (e) { console.error('store backup', e.message); }
}
let _saveTimer = null;
let _writing = false, _pending = false, _supersededBySync = false;
// ASYNC debounced write: never blocks the event loop, so hundreds of users' taps are not
// stalled while the store is serialized to disk. Coalesces bursts (one write in flight; a
// request during it re-runs at the end). A concurrent SYNC write (saveStoreNow) is always
// authoritative — this loop is told (`_supersededBySync`) not to rename its older tmp over
// it, and re-runs to capture anything mutated after. Async uses .wtmp, sync uses .stmp, so
// the two never write the same tmp file concurrently.
async function _writeAsync() {
  if (_writing) { _pending = true; return; }
  _writing = true;
  try {
    do {
      _pending = false; _supersededBySync = false;
      const data = JSON.stringify(DB);            // snapshot of the LIVE store
      fs.mkdirSync(CFG.dataDir, { recursive: true });
      const tmp = STORE_FILE + '.wtmp';
      await fs.promises.writeFile(tmp, data);      // the slow part — now off the event loop
      if (_supersededBySync) { try { fs.unlinkSync(tmp); } catch (_) {} _pending = true; continue; }   // a sync write landed newer data
      fs.renameSync(tmp, STORE_FILE);              // atomic replace (fast)
      _backupStore(false);                         // throttled rotating snapshot
    } while (_pending);
  } catch (e) { console.error('store write', e.message); }
  finally { _writing = false; }
}
// SYNCHRONOUS authoritative write — for fund-critical mutations (a minted/imported key, an
// order removed BEFORE its fill, a copy/snipe budget commit BEFORE the buy). Kept sync so a
// crash right after can never lose a key or replay a fill.
function _writeSync() {
  try {
    if (_writing) _supersededBySync = true;        // in-flight async must not overwrite this newer data
    fs.mkdirSync(CFG.dataDir, { recursive: true });
    const tmp = STORE_FILE + '.stmp';
    fs.writeFileSync(tmp, JSON.stringify(DB));
    fs.renameSync(tmp, STORE_FILE);                // atomic replace
    _backupStore(false);
  } catch (e) { console.error('store write', e.message); }
}
// On-demand backup (admin /backup): always writes a fresh snapshot, returns its path.
function backupNow() { saveStoreNow(); _backupStore(true); try { return { dir: BACKUP_DIR, count: fs.readdirSync(BACKUP_DIR).filter((f) => /^tradebot-.*\.json$/.test(f)).length }; } catch (_) { return { dir: BACKUP_DIR, count: 0 }; } }
// Debounced save for high-frequency, non-critical mutations (positions, orders).
function saveStore() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = null; _writeAsync(); }, 600);
}
// WRITE-THROUGH — for fund-critical mutations (a newly minted/imported private
// key, an order removal before a fill). A crash in the debounce window must
// never lose a wallet key or replay a filled order.
function saveStoreNow() { if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; } _writeSync(); }
// Flush any pending debounced write on shutdown/redeploy.
let _shutdownWired = false;
function wireShutdownFlush() {
  if (_shutdownWired) return; _shutdownWired = true;
  const flush = () => { try { saveStoreNow(); _backupStore(true); } catch (_) {} };
  process.on('beforeExit', flush);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });
}

// ---- per-wallet serialization: two txs from one address must not race on the
// same nonce (one would be silently dropped). All sends for an address queue.
const _walletLocks = new Map();
function withWalletLock(address, fn) {
  const key = String(address).toLowerCase();
  const prev = _walletLocks.get(key) || Promise.resolve();
  const run = prev.then(() => fn());          // run after the previous op settles
  _walletLocks.set(key, run.then(() => {}, () => {}));   // tail never rejects → chain continues
  return run;                                  // caller still sees the real result/throw
}
function allUsers() { return Object.values(DB.users); }
function getUser(chatId) { return DB.users[String(chatId)] || null; }
// Remember a user's Telegram username/first name (for reports + /userkey lookup).
function noteUser(chatId, from) {
  const u = getUser(chatId); if (!u || !from) return;
  const uname = from.username ? String(from.username).slice(0, 32) : '';
  const fname = from.first_name ? String(from.first_name).slice(0, 40) : '';
  let ch = false;
  if (uname && u.username !== uname) { u.username = uname; ch = true; }
  if (fname && u.firstName !== fname) { u.firstName = fname; ch = true; }
  if (ch) saveStore();
}
// Resolve a user by @username or numeric chatId (admin support lookup).
function findUser(arg) {
  arg = String(arg || '').trim().replace(/^@/, '');
  if (!arg) return null;
  if (/^\d+$/.test(arg) && DB.users[arg]) return DB.users[arg];
  const low = arg.toLowerCase();
  for (const id of Object.keys(DB.users)) { const u = DB.users[id]; if (u && u.username && u.username.toLowerCase() === low) return u; }
  return null;
}
// ---- ops reporting: volume + fee accounting, bucketed PER CHAIN (each chain's amount
// is in that chain's native; USD is computed at display time from the price feed).
function recordTrade(chainKey, volNative, feeNative) {
  const r = DB.report || (DB.report = _emptyReport());
  const v = Number(volNative) || 0, f = Number(feeNative) || 0;
  r.trades++; r.vol[chainKey] = (r.vol[chainKey] || 0) + v; r.fee[chainKey] = (r.fee[chainKey] || 0) + f;
  r.lifetime.trades++; r.lifetime.vol[chainKey] = (r.lifetime.vol[chainKey] || 0) + v; r.lifetime.fee[chainKey] = (r.lifetime.fee[chainKey] || 0) + f;
  saveStore();
}
function reportSnapshot() { return DB.report || _emptyReport(); }
function resetReportWindow() { const r = DB.report || (DB.report = _emptyReport()); r.since = Date.now(); r.trades = 0; r.vol = {}; r.fee = {}; saveStore(); }
// After a confirmed trade: account it and fire the channel report (fire-and-forget,
// never blocks or throws into the trade path). `side` is 'buy'|'sell'.
async function _afterTrade(u, side, r) {
  try {
    const chain = chainOf(r.chain) || { name: r.chain, native: r.native };
    const volEth = side === 'buy' ? (Number(r.spentEth) + Number(r.feeEth)) : (Number(r.proceedsEth) + Number(r.feeEth));
    recordTrade(r.chain, volEth, Number(r.feeEth));   // bucket by chain (r.chain is the chainKey)
    // Price the report in USD using THIS chain's native (ETH/SOL/BNB) — never the ETH
    // price for a SOL/BNB trade. ethUsd(chainKey) picks the right Coinbase pair.
    let usdRate = 0; if (['ETH', 'SOL', 'BNB'].includes(r.native)) { try { usdRate = await ethUsd(r.chain); } catch (_) {} }
    report.onTrade({ username: u.username, chatId: u.chatId, side, sym: r.sym, ca: r.ca, native: r.native, volEth, feeEth: Number(r.feeEth), feeCollected: !!r.feeHash, usdRate, chainName: chain.name });
  } catch (_) { /* reporting must never affect trading */ }
}
function userChain(u) { return (u && u.activeChain && chainOf(u.activeChain) && isEnabled(u.activeChain)) ? u.activeChain : DEFAULT_CHAIN; }

// ---------------------------------------------------------------- wallet (custodial, MULTI)
// A user holds up to WALLET_CAP wallets, one active at a time. Positions AND orders
// live ON each wallet (they belong to a specific address), so switching the active
// wallet never mixes one wallet's bags/orders with another's. Legacy single-wallet
// records are migrated transparently on first touch (see _migrateLegacy).
// Capped at 99 so a wallet index is always ≤2 digits — keeps every token-card
// callback (which encodes the index) under Telegram's 64-byte limit.
const WALLET_CAP = Math.max(1, Math.min(99, Number(process.env.MAX_WALLETS_PER_USER || 10)));
// Quick-buy amounts on a token card. NOT a fixed count any more: three was baked
// into the getter, the setter AND the store migration, and the migration did not
// merely reject a longer array — it overwrote and SAVED the default over it, so a
// five-amount set could never survive a restart.
const PRESETS_MIN = 2;
const PRESETS_MAX = 6;   // the card's row budget (4 per row) fits 6 presets + Buy X across two rows
const DEFAULT_BUY_PRESETS = [0.01, 0.05, 0.1];
// …and per-chain defaults, because 0.01 of one coin is not 0.01 of another. A user
// on Solana was offered 0.01/0.05/0.1 SOL — under a dollar at the top end — which
// is why every buy on the cards we saw was a dust trade. A chain with no entry here
// falls back to DEFAULT_BUY_PRESETS.
const CHAIN_BUY_PRESETS = {
  solana: [0.1, 0.2, 0.5, 1, 2],
};
const defaultPresetsFor = (chainKey) => (CHAIN_BUY_PRESETS[chainKey] || DEFAULT_BUY_PRESETS).slice();
function _refCode() { let c; do { c = crypto.randomBytes(4).toString('hex'); } while (DB.refByCode[c]); return c; }
function _walletId() { return crypto.randomBytes(5).toString('hex'); }
function walletFromSecret(secret) {
  secret = String(secret || '').trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(secret)) return new ethers.Wallet(secret.startsWith('0x') ? secret : '0x' + secret);
  const words = secret.split(/\s+/).filter(Boolean);
  if ([12, 15, 18, 21, 24].includes(words.length)) return ethers.Wallet.fromPhrase(words.join(' '));
  throw new Error('not a valid private key (64 hex chars) or seed phrase (12–24 words)');
}
function _newWallet(secret) {
  const w = secret ? walletFromSecret(secret) : ethers.Wallet.createRandom();
  // Every wallet is dual-chain: the same secret yields an EVM address AND a Solana
  // address. Prefer the mnemonic (Phantom-compatible m/44'/501'/0'/0') when we have
  // one; otherwise derive Solana from the EVM key (domain-separated), so a wallet
  // always maps to ONE fixed Solana address.
  const words = String(secret || '').trim().split(/\s+/).filter(Boolean);
  const mnemonic = [12, 15, 18, 21, 24].includes(words.length) ? words.join(' ')
    : (!secret && w.mnemonic && w.mnemonic.phrase) ? w.mnemonic.phrase : null;
  const sol = solana.newWallet(mnemonic || w.privateKey);   // { kind, address, plain }
  // THE PHRASE USED TO BE COMPUTED HERE AND THROWN AWAY. Every wallet this bot
  // generates is born from one — `Wallet.createRandom()` has a mnemonic, and it
  // is the thing that derives the Solana key on Phantom's own path — but only
  // `w.privateKey` was persisted. So the bot handed out two unrelated-looking
  // keys for a wallet that had a single phrase behind it, and the phrase was
  // unrecoverable the moment the function returned: a private key cannot be run
  // backwards into the mnemonic it came from.
  //
  // ⚠️ It is STRICTLY MORE DANGEROUS to hold than the keys are. A private key
  // controls one address; a phrase derives an unbounded number of them across
  // many chains, so for an IMPORTED phrase this stores something that may also
  // control wallets this bot has never seen. That is the owner's explicit call
  // (2026-08-21), taken with the trade-off stated. It is why the export screen
  // says so out loud, and why nothing prints a phrase without a confirmation.
  return { id: _walletId(), name: '', address: w.address, enc: encrypt(w.privateKey),
    solAddress: sol.address, solEnc: encrypt(sol.plain),
    ...(mnemonic ? { mnemEnc: encrypt(mnemonic) } : {}),
    createdAt: Date.now(), positions: {}, orders: [], history: [] };
}
/**
 * The wallet's seed phrase, or NULL when it has none.
 *
 * Null is the ordinary answer, not an error: every wallet created before this
 * existed has no stored phrase and never will, and a wallet imported from a bare
 * private key never had one at all. A caller must render the absence as "this
 * wallet has two keys and no phrase" — never as a failure, and never by
 * inventing a phrase from the key, which is not a thing that can be done.
 */
function exportMnemonic(chatId, walletId) {
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  const w = _resolveWallet(u, walletId);
  if (!w.mnemEnc) return null;
  try { return decrypt(w.mnemEnc); } catch (_) { return null; }
}
// Backfill a Solana keypair onto a pre-Solana wallet (derived from its EVM key), so
// every stored wallet gains a fixed Solana address on first use. Idempotent.
function _ensureSol(w) {
  if (w && w.solAddress && w.solEnc) return w;
  const s = solana.newWallet(decrypt(w.enc));   // deriveKeypair(evmPrivKey) → domain-separated Solana key
  w.solAddress = s.address; w.solEnc = encrypt(s.plain); saveStore();
  return w;
}
function solAddressOf(w) { return _ensureSol(w).solAddress; }
function _solKeypair(w) { return solana.keypairFromStored(decrypt(_ensureSol(w).solEnc)); }
// The address a wallet uses ON a given chain: base58 Solana address for svm, else 0x.
function walletAddress(w, chainKey) { return isSvm(chainKey) ? solAddressOf(w) : w.address; }
// Display label for a wallet: its custom name, else "Wallet N" (1-based index).
function walletLabel(w, index) { const n = (w && typeof w.name === 'string') ? w.name.trim() : ''; return n || ('Wallet ' + index); }
// Rename (Maestro-style). Empty/blank clears back to the default "Wallet N".
function renameWallet(chatId, walletId, name) {
  const u = ensureUser(chatId);
  const w = walletById(u, walletId); if (!w) throw new Error('wallet not found');
  const clean2 = String(name == null ? '' : name).replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  w.name = clean2; saveStore();
  return clean2;
}
function walletList(u) { return (u && Array.isArray(u.wallets)) ? u.wallets : []; }
function walletById(u, id) { return walletList(u).find((w) => w.id === id) || null; }
function activeWallet(u) { const list = walletList(u); return list.find((w) => w.id === u.activeWalletId) || list[0] || null; }
function activeAddress(u) { const w = activeWallet(u); return w ? w.address : null; }
function _resolveWallet(u, walletId) { const w = walletId ? walletById(u, walletId) : activeWallet(u); if (!w) throw new Error('no wallet'); return w; }

// Migrate a legacy single-wallet record { address, enc, positions, orders, oldWallets }
// into the multi-wallet shape. The current wallet becomes Wallet 1 (keeps its
// positions+orders); previously-archived oldWallets return as extra selectable
// wallets (empty bags — they were cleared when archived), capped at WALLET_CAP.
function _migrateLegacy(u) {
  if (Array.isArray(u.wallets) && u.wallets.length) return false;
  const wallets = [];
  if (u.address && u.enc) {
    wallets.push({ id: _walletId(), address: u.address, enc: u.enc, createdAt: u.createdAt || Date.now(),
      positions: (u.positions && typeof u.positions === 'object') ? u.positions : {},
      orders: Array.isArray(u.orders) ? u.orders : [] });
  }
  // Bring back archived wallets as selectable ones (up to the cap). Any that don't
  // fit are KEPT in a residual archive — never wholesale-deleted, so no encrypted
  // key is ever destroyed by the migration.
  const leftover = [];
  for (const ow of (Array.isArray(u.oldWallets) ? u.oldWallets : [])) {
    if (!ow || !ow.address || !ow.enc) continue;
    if (wallets.some((w) => w.address.toLowerCase() === ow.address.toLowerCase())) continue;
    if (wallets.length < WALLET_CAP) wallets.push({ id: _walletId(), address: ow.address, enc: ow.enc, createdAt: ow.at || Date.now(), positions: {}, orders: [] });
    else leftover.push(ow);
  }
  if (!wallets.length) return false;
  // Stamp every migrated order with its owning wallet's id, so a pre-upgrade
  // TP/SL/limit always executes on THE WALLET IT BELONGS TO — never on whatever
  // wallet happens to be active after the user adds/switches wallets.
  for (const w of wallets) for (const o of w.orders) if (o && !o.walletId) o.walletId = w.id;
  u.wallets = wallets;
  u.activeWalletId = wallets[0].id;
  delete u.address; delete u.enc; delete u.positions; delete u.orders;
  if (leftover.length) u.oldWallets = leftover; else delete u.oldWallets;
  return true;
}
function ensureUser(chatId, referredBy) {
  const id = String(chatId);
  let u = DB.users[id];
  if (u) {
    // Backfill any field a stored record predates, so screens never crash on a
    // partial/legacy user after a schema change.
    let ch = false, minted = false;
    if (!u.activeChain) { u.activeChain = DEFAULT_CHAIN; ch = true; }
    if (_migrateLegacy(u)) ch = true;
    if (!Array.isArray(u.wallets) || !u.wallets.length) { u.wallets = [_newWallet()]; ch = true; minted = true; }
    for (const w of u.wallets) {
      if (!w.id) { w.id = _walletId(); ch = true; }
      if (!w.positions || typeof w.positions !== 'object') { w.positions = {}; ch = true; }
      if (!Array.isArray(w.orders)) { w.orders = []; ch = true; }
      if (!Array.isArray(w.history)) { w.history = []; ch = true; }                        // per-wallet trade log
      for (const o of w.orders) if (o && !o.walletId) { o.walletId = w.id; ch = true; }   // every order knows its wallet
    }
    if (!u.activeWalletId || !walletById(u, u.activeWalletId)) { u.activeWalletId = u.wallets[0].id; ch = true; }
    if (!u.snipe || typeof u.snipe !== 'object') { u.snipe = { ethAmount: '0.01' }; ch = true; }
    if (!u.snipe.chains || typeof u.snipe.chains !== 'object') { u.snipe.chains = { robinhood: !!u.snipe.on }; delete u.snipe.on; ch = true; }   // migrate on→chains.robinhood
    if (typeof u.snipe.ethAmount !== 'string' || !(Number(u.snipe.ethAmount) > 0)) { u.snipe.ethAmount = '0.01'; ch = true; }
    if (!Array.isArray(u.alerts)) { u.alerts = []; ch = true; }                            // price alerts (notify-only)
    if (!u.copy || typeof u.copy !== 'object') { u.copy = { on: false, targets: [] }; ch = true; }   // copy-trading
    if (!Array.isArray(u.copy.targets)) { u.copy.targets = []; ch = true; }
    for (const t of u.copy.targets) {
      // Mirror the target's EXITS as well as its entries. Default on — following a
      // wallet in and never out is half a strategy — but `holding` starts EMPTY on
      // migration, so this only ever governs positions copy-bought from here on.
      // Retro-applying it would auto-sell bags the user acquired under a
      // buy-only regime and never agreed to hand over.
      if (typeof t.copySell !== 'boolean') { t.copySell = true; ch = true; }
      // The dev-snipe cap was REMOVED. A stale `maxEth` on a 'launches' target
      // is a number no code reads any more, and a field that looks meaningful
      // and binds nothing is exactly what this repo refuses to leave lying
      // around — every screen would go on rendering "used 0.02/0.1" over a
      // watch with no limit at all.
      if (t.mode === 'launches' && t.maxEth !== undefined) { delete t.maxEth; ch = true; }
      if (!t.holding || typeof t.holding !== 'object') { t.holding = {}; ch = true; }
    }
    if (!Array.isArray(u.dca)) { u.dca = []; ch = true; }                                  // scheduled buys (DCA)
    if (!Array.isArray(u.snipeTargets)) { u.snipeTargets = []; ch = true; }                // armed contract snipes (snipe by CA)
    // A target left mid-flight by a crash or a restart is NOT re-armed. The buy
    // may have been broadcast and we cannot tell from here; re-arming would risk
    // buying twice, and the whole point of claiming before the buy is that a
    // missed snipe is the cheaper of the two mistakes.
    for (const t of u.snipeTargets) if (t && t.status === 'firing') { t.status = 'failed'; t.lastErr = 'interrupted by a restart — re-arm it if the launch has not happened'; ch = true; }
    // The Snipe Setup panel's draft. Absent means "no panel open" — that is a
    // state, not a hole, so nothing is minted here; only garbage is normalized.
    if (u.snipeDraft !== undefined && u.snipeDraft !== null && typeof u.snipeDraft !== 'object') { u.snipeDraft = null; ch = true; }
    // Drafts written before the wallet row became a SET carry a single
    // walletId — migrate it so a panel opened across the deploy keeps its pick.
    if (u.snipeDraft && u.snipeDraft.walletIds === undefined) {
      u.snipeDraft.walletIds = u.snipeDraft.walletId === '*' ? '*' : (u.snipeDraft.walletId ? [u.snipeDraft.walletId] : []);
      delete u.snipeDraft.walletId; ch = true;
    }
    if (u.lang !== 'id' && u.lang !== 'en') { u.lang = 'en'; ch = true; }                  // UI language
    if (!u.security || typeof u.security !== 'object') { u.security = { withdrawLock: false, whitelist: [], wdTimes: [] }; ch = true; }
    if (typeof u.security.withdrawLock !== 'boolean') { u.security.withdrawLock = false; ch = true; }
    if (!Array.isArray(u.security.whitelist)) { u.security.whitelist = []; ch = true; }
    if (!Array.isArray(u.security.wdTimes)) { u.security.wdTimes = []; ch = true; }
    if (!u.settings || typeof u.settings !== 'object') { u.settings = {}; ch = true; }
    { const s = u.settings;
      if (typeof s.slippage !== 'number') { s.slippage = 0; ch = true; }                                   // 0 → 5% default
      // Range, not an exact count. This line used to demand exactly 3 and then
      // OVERWRITE anything else with the default and saveStore() it — so a longer
      // set was not ignored, it was destroyed on the owner's next touch and could
      // never be configured at all.
      if (!Array.isArray(s.buyPresets) || s.buyPresets.length < PRESETS_MIN || s.buyPresets.length > PRESETS_MAX || !s.buyPresets.every((x) => x > 0)) { s.buyPresets = DEFAULT_BUY_PRESETS.slice(); ch = true; }
      if (typeof s.autoBuy !== 'boolean') { s.autoBuy = false; ch = true; }
      if (typeof s.autoBuyAmount !== 'string' || !(Number(s.autoBuyAmount) > 0)) { s.autoBuyAmount = '0.01'; ch = true; }
      if (typeof s.confirmBuy !== 'boolean') { s.confirmBuy = false; ch = true; }
      if (typeof s.expert !== 'boolean') { s.expert = false; ch = true; }
      // Multi-wallet receipts: one message PER WALLET (default) or one combined
      // message for the batch. Per-wallet is the default because a combined
      // receipt cannot be sent until the SLOWEST wallet settles — so five
      // parallel buys showed nothing at all until the last one landed, and then
      // dumped the lot in one block. Per-wallet posts each fill the moment it
      // lands, which is both the clearer report and the faster-feeling one.
      if (s.receiptStyle !== 'per_wallet' && s.receiptStyle !== 'combined') { s.receiptStyle = 'per_wallet'; ch = true; }
      if (!s.notify || typeof s.notify !== 'object') { s.notify = { snipe: true, copy: true, alerts: true }; ch = true; }
      if (typeof s.autoTpPct !== 'number') { s.autoTpPct = 0; ch = true; }   // 0 = off; else auto take-profit at +X% on every buy
      if (typeof s.autoSlPct !== 'number') { s.autoSlPct = 0; ch = true; }   // 0 = off; else auto stop-loss at −X%
      if (typeof s.autoProtect !== 'boolean') { s.autoProtect = false; ch = true; }   // rug guard: auto-sell a held bag if it crashes / turns dangerous
      if (typeof s.gasBoost !== 'number' || !(s.gasBoost >= 1)) { s.gasBoost = 1; ch = true; }   // gas priority: 1 Normal · 2 Fast · 3 Turbo
      if (!s.presetsByChain || typeof s.presetsByChain !== 'object') { s.presetsByChain = {}; ch = true; } }
    // Write THROUGH if we just minted a key in the backfill (durability), else debounce.
    if (minted) saveStoreNow(); else if (ch) saveStore();
    return u;
  }
  const w = _newWallet();
  const code = _refCode();
  u = {
    chatId: id, refCode: code,
    referredBy: (referredBy && DB.refByCode[referredBy] && DB.refByCode[referredBy] !== id) ? referredBy : null,
    createdAt: Date.now(),
    activeChain: DEFAULT_CHAIN,
    wallets: [w], activeWalletId: w.id,   // each wallet: { id, address, enc, positions, orders, history }
    snipe: { ethAmount: '0.01', chains: { robinhood: false } },
    alerts: [], copy: { on: false, targets: [] }, dca: [],
    security: { withdrawLock: false, whitelist: [], wdTimes: [] },
    refEarnedEth: 0,
    settings: { slippage: 0, buyPresets: DEFAULT_BUY_PRESETS.slice(), autoBuy: false, autoBuyAmount: '0.01', confirmBuy: false, expert: false, notify: { snipe: true, copy: true, alerts: true }, autoTpPct: 0, autoSlPct: 0, autoProtect: false, presetsByChain: {} },
  };
  DB.users[id] = u; DB.refByCode[code] = id;
  saveStoreNow();   // write-through: the encrypted key must be durable before we return the address
  return u;
}
// A "signer" for a wallet on a chain. EVM → an ethers.Wallet. Solana → a small
// object { svm, address, keypair, connection } (there is no ethers.Wallet on SVM);
// the svm buy/sell/withdraw paths use .keypair + .connection directly.
function _signer(w, chainKey) {
  if (isSvm(chainKey)) {
    const kp = _solKeypair(w);
    return { svm: true, address: kp.publicKey.toBase58(), keypair: kp, connection: providerFor(chainKey) };
  }
  return new ethers.Wallet(decrypt(w.enc), providerFor(chainKey));
}
function signerFor(chatId, chainKey, walletId) {
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  return _signer(_resolveWallet(u, walletId), chainKey || userChain(u));
}

// ---------------------------------------------------------------- withdraw security
// Per-user protections so a hijacked Telegram account can't instantly drain funds:
//   • vault lock   — block ALL withdrawals until the user turns it off;
//   • whitelist    — when set (per chain), only allow withdrawals to those addresses;
//   • rate limit   — cap withdrawals per hour.
const MAX_WD_PER_HOUR = Math.max(1, Number(process.env.MAX_WD_PER_HOUR || 10));
const WHITELIST_MAX = 20;
function _secOf(u) { if (!u.security || typeof u.security !== 'object') u.security = { withdrawLock: false, whitelist: [], wdTimes: [] }; return u.security; }
function _wlNorm(addr, chainKey) { return isSvm(chainKey) ? String(addr).trim() : String(addr).trim().toLowerCase(); }
function getSecurity(chatId) { return _secOf(ensureUser(chatId)); }
function setWithdrawLock(chatId, on) { const s = _secOf(ensureUser(chatId)); s.withdrawLock = !!on; saveStoreNow(); return s.withdrawLock; }
function addWhitelist(chatId, address, chainKey) {
  const u = ensureUser(chatId); const s = _secOf(u);
  chainKey = chainKey || userChain(u);
  address = String(address || '').trim();
  const ok = isSvm(chainKey) ? solana.isSolAddress(address) : /^0x[0-9a-fA-F]{40}$/.test(address);
  if (!ok) throw new Error('invalid address for ' + ((chainOf(chainKey) || {}).name || chainKey));
  s.whitelist = Array.isArray(s.whitelist) ? s.whitelist : [];
  if (s.whitelist.length >= WHITELIST_MAX) throw new Error(`whitelist limit (${WHITELIST_MAX}) reached — remove one first`);
  if (s.whitelist.some((w) => w.chain === chainKey && _wlNorm(w.address, chainKey) === _wlNorm(address, chainKey))) throw new Error('already whitelisted on this chain');
  const entry = { id: 'wl' + crypto.randomBytes(4).toString('hex'), address, chain: chainKey, at: Date.now() };
  s.whitelist.push(entry); saveStoreNow();
  return entry;
}
function removeWhitelist(chatId, id) {
  const s = _secOf(ensureUser(chatId));
  const before = (s.whitelist || []).length;
  s.whitelist = (s.whitelist || []).filter((w) => w.id !== id);
  if (s.whitelist.length !== before) { saveStoreNow(); return true; }
  return false;
}
// Throws if a withdraw to `to` on `chainKey` isn't currently allowed (lock / whitelist
// miss / rate cap). Call BEFORE sending.
function _guardWithdraw(u, to, chainKey) {
  const s = _secOf(u);
  if (s.withdrawLock) throw new Error('withdrawals are 🔒 LOCKED (vault mode). Turn it off in ⚙️ Security first.');
  const wl = Array.isArray(s.whitelist) ? s.whitelist.filter((w) => w.chain === chainKey) : [];
  if (wl.length && !wl.some((w) => _wlNorm(w.address, chainKey) === _wlNorm(to, chainKey))) {
    throw new Error('that address is not in your withdraw whitelist for this chain. Add it in ⚙️ Security first.');
  }
  const now = Date.now();
  s.wdTimes = (Array.isArray(s.wdTimes) ? s.wdTimes : []).filter((t) => now - t < 3600000);
  if (s.wdTimes.length >= MAX_WD_PER_HOUR) throw new Error(`withdraw rate limit reached (${MAX_WD_PER_HOUR}/hour). Try again later.`);
}
function _noteWithdraw(u) { const s = _secOf(u); s.wdTimes = Array.isArray(s.wdTimes) ? s.wdTimes : []; s.wdTimes.push(Date.now()); saveStore(); }
// Export the wallet's secret for a given chain: the Solana base58 secret on svm
// (what Phantom/Solflare import), else the EVM 0x private key. Default (no chainKey)
// stays EVM for backward compatibility.
function exportKey(chatId, walletId, chainKey) {
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  const w = _resolveWallet(u, walletId);
  if (isSvm(chainKey)) return decrypt(_ensureSol(w).solEnc);
  return decrypt(w.enc);
}

// Add a wallet (generate when secret is undefined, else import a key/seed). Adds
// to the list (up to WALLET_CAP) and makes it active. Non-destructive — existing
// wallets are untouched, so nothing can be stranded.
function addWallet(chatId, secret) {
  const u = ensureUser(chatId);
  if (u.wallets.length >= WALLET_CAP) throw new Error(`wallet limit reached (${WALLET_CAP}). Remove one first.`);
  const nw = _newWallet(secret);
  if (u.wallets.some((w) => w.address.toLowerCase() === nw.address.toLowerCase())) throw new Error('that wallet is already in your list');
  u.wallets.push(nw);
  u.activeWalletId = nw.id;
  saveStoreNow();   // write-through: a fresh/imported key must be durable
  return { id: nw.id, address: nw.address, index: u.wallets.length };
}
function switchWallet(chatId, walletId) {
  const u = ensureUser(chatId);
  const w = walletById(u, walletId); if (!w) throw new Error('wallet not found');
  u.activeWalletId = w.id; saveStore();
  return w;
}
// A getBalance that survives a flaky public RPC: short per-call timeout, a couple
// of retries. Resolves { ok, bal } — ok:false means we genuinely couldn't read it
// (node down / rate-limited), NOT that the balance is zero.
async function _balanceResilient(chainKey, addr, tries = 3, timeoutMs = 6000) {
  for (let i = 0; i < tries; i++) {
    try {
      // ⚠️ solBalanceOrNull, NOT solBalance. The latter answers 0n for a dead
      // RPC, a 429 and an empty wallet alike, so the only failure this loop
      // could ever detect on Solana was the 6s TIMEOUT — a node that answered
      // with an error came back as `{ok:true, bal:0}` and the removal guard
      // read a funded wallet as empty. The retry above was decorative there.
      // Through the one owner on svm — the host list and the 429 retry-off live
      // there, and this loop's 6s try is the one web3.js's own 7.5s ladder used
      // to eat whole. EVM keeps the direct read: this loop IS its retry.
      const read = isSvm(chainKey)
        ? nativeBalances(chainKey, [addr]).then((r) => r.bals[0])
        : providerFor(chainKey).getBalance(addr);
      const bal = await Promise.race([
        read,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
      if (bal == null) continue;   // the read failed — retry, then report ok:false
      return { ok: true, bal };
    } catch (_) { /* retry */ }
  }
  return { ok: false, bal: 0n };
}
/**
 * What one wallet ROW holds, chain by chain — the survey both the removal guard
 * and the removal SCREEN read, so the refusal and the screen can never disagree
 * about what is in there.
 *
 * A row is TWO KEYPAIRS: an EVM key (`enc`) and a Solana key (`solEnc`), with
 * two unrelated addresses. That is exactly the thing the UI never said, and the
 * first person to hit the guard asked the obvious question — "the private keys
 * are different, so why does SOL stop me deleting the EVM wallet?". They are
 * different, and they are also one row: removing it removes the pair. Answering
 * that needs the per-chain breakdown, not a sentence naming whichever chain the
 * loop happened to trip on first.
 *
 * Every chain is read CONCURRENTLY. The old loop was serial, so on a box with a
 * throttled public RPC the confirm screen paid one full six-second timeout per
 * chain before it could say anything at all.
 *
 * `ok:false` is "we could not look", never "it is empty" — the distinction this
 * repo keeps having to relearn. An unreadable chain does not block removal (a
 * flaky public RPC must not trap an otherwise-empty wallet for ever) but it IS
 * reported, so a screen can say so instead of rendering it as a zero.
 */
async function walletFunds(chatId, walletId) {
  const u = ensureUser(chatId);
  const w = walletById(u, walletId); if (!w) throw new Error('wallet not found');
  const row = (ch, addr, ok, bal) => ({
    chain: ch.key, name: ch.name, emoji: ch.emoji, native: ch.native, svm: ch.kind === 'svm', address: addr,
    ok, bal,
    // Dust threshold in the chain's smallest unit: ~0.0002 ETH on EVM, 0.002 SOL on
    // Solana (a hair above the rent-exempt minimum, so an empty ATA-only wallet frees).
    holds: ok && bal > (ch.kind === 'svm' ? 2000000n : ethers.parseEther('0.0002')),
    human: ch.kind === 'svm' ? solana.lamportsToSol(bal).toFixed(5) : Number(ethers.formatEther(bal)).toFixed(5),
  });
  // Every chain is its own answer. Resolving the Solana address derives and
  // persists a keypair, and `Promise.all` REJECTS on the first throw — so one
  // wallet the derivation cannot handle used to take the whole survey down and
  // the caller got an exception instead of the per-chain `ok:false` this
  // function promises. A chain that cannot even be addressed is exactly the
  // "we could not look" case, not an exception.
  return Promise.all(chains.enabledChains().map(async (ch) => {
    let addr;
    try { addr = ch.kind === 'svm' ? solAddressOf(w) : w.address; }
    catch (_) { return row(ch, '', false, 0n); }
    const { ok, bal } = await _balanceResilient(ch.key, addr);
    return row(ch, addr, ok, bal);
  }));
}

// Remove a wallet. GUARD: keep at least one; refuse only when we can VERIFY it still
// holds native on some chain (so we never nudge a user into abandoning visible funds).
// A chain whose RPC we can't reach right now does NOT block removal: the encrypted key
// is archived on removal, so nothing is destroyed — a flaky public RPC (e.g. Ethereum)
// must not trap an otherwise-empty wallet forever.
// ERC20 bags can't be auto-detected, hence the "export first" nudge in the confirm UI.
//
// `opts.force` skips the balance refusal, and is reached ONLY from a second,
// informed confirmation that names every amount. The refusal on its own was a
// dead end: it told the user their wallet held SOL and offered no way to move it
// — withdraw was active-wallet-and-active-chain only, so acting on the sentence
// meant switching wallet, switching chain, and finding the button again. A
// diagnosis with no hands attached is a bug report the code files against its
// owner, and this one had been filing it since the guard was written.
//
// The refusal carries `err.holdings` — the survey above — so the screen can put
// those hands on it: one withdraw button per chain that actually holds anything.
async function removeWallet(chatId, walletId, opts) {
  const u = ensureUser(chatId);
  if (u.wallets.length <= 1) throw new Error('you must keep at least one wallet');
  const w = walletById(u, walletId); if (!w) throw new Error('wallet not found');
  if (!(opts && opts.force)) {
    const funds = await walletFunds(chatId, walletId);
    const holding = funds.filter((f) => f.holds);
    if (holding.length) {
      const e = new Error(`this wallet still holds ${holding.map((f) => `${f.human} ${f.native} on ${f.name}`).join(' and ')} — withdraw it (or export the key) first.`);
      e.holdings = holding;
      throw e;
    }
  }
  // Re-validate AFTER the async balance loop (the event loop yielded, so a
  // concurrent removal could have changed the list). This block runs to completion
  // WITHOUT yielding, so the check-and-mutate is atomic — no race can empty wallets.
  if (!walletById(u, w.id)) return u.wallets.length;   // already removed by a concurrent call
  if (u.wallets.length <= 1) throw new Error('you must keep at least one wallet');
  // Archive the encrypted key before dropping the wallet, so a removed wallet's key
  // is NEVER irrecoverable (it may still hold ERC20 bags the native guard can't see).
  u.oldWallets = Array.isArray(u.oldWallets) ? u.oldWallets : [];
  // Archive BOTH keys: a Phantom-path (mnemonic-derived) Solana key can't be rebuilt
  // from the EVM key alone, so keep solEnc/solAddress or it would be irrecoverable.
  // mnemEnc rides along: archiving the keys but dropping the phrase would make
  // "export before you delete" quietly hand back less than the wallet had.
  u.oldWallets.push({ address: w.address, enc: w.enc, solAddress: w.solAddress, solEnc: w.solEnc, mnemEnc: w.mnemEnc, at: Date.now() });
  if (u.oldWallets.length > 20) u.oldWallets = u.oldWallets.slice(-20);
  u.wallets = u.wallets.filter((x) => x.id !== w.id);
  if (u.activeWalletId === w.id) u.activeWalletId = u.wallets[0].id;
  saveStoreNow();
  return u.wallets.length;
}
function listWallets(chatId) {
  const u = ensureUser(chatId);
  return u.wallets.map((w, i) => ({ id: w.id, index: i + 1, name: w.name || '', label: walletLabel(w, i + 1), address: w.address, active: w.id === u.activeWalletId, orders: (w.orders || []).length }));
}
// True only if a VALID custom per-chain preset is set (for accurate UI labels).
function hasChainPresets(u, chainKey) { const s = (u && u.settings) || {}; return !!(chainKey && s.presetsByChain && _presetsOk(s.presetsByChain[chainKey])); }
function setChain(chatId, key) {
  const u = ensureUser(chatId);
  if (!isEnabled(key)) throw new Error('chain not enabled');
  u.activeChain = key; saveStore();
  return chainOf(key);
}
// Per-chain snipe toggle (Robinhood = new launchpad launches; other chains = new DEX pairs).
function setSnipeChain(chatId, key, on) {
  const u = ensureUser(chatId);
  if (!isEnabled(key)) throw new Error('chain not enabled');
  u.snipe.chains = u.snipe.chains || {};
  u.snipe.chains[key] = !!on;
  saveStore();
  return u.snipe.chains;
}
function setSnipeAmount(chatId, amt) {
  const u = ensureUser(chatId);
  const a = Number(amt); if (!(a > 0)) throw new Error('amount must be > 0');
  u.snipe.ethAmount = String(a); saveStore();
  return u.snipe.ethAmount;
}

// ---------------------------------------------------------------- copy-trading
const MAX_COPY_TARGETS = Math.max(1, Number(process.env.MAX_COPY_TARGETS || 5));
/**
 * Chains where a "dev wallet snipe" is possible — i.e. where the wallet behind a
 * launch is knowable without paying for an indexer.
 *
 * THIS USED TO BE ROBINHOOD AND SOLANA ONLY, on the grounds that "EVM DEX chains
 * have no cheap deployer signal". That was true of the DEPLOYER and false of the
 * signal that actually matters: the snipe already scans `PairCreated` on every
 * EVM chain, and the SENDER of that transaction is the wallet that opened the
 * pool. One `getTransaction` per new pair, and only when somebody is following a
 * dev on that chain — so a chain nobody watches pays nothing.
 *
 * Pool-opener, not deployer, and the UI says so: for a memecoin launch they are
 * the same wallet, because the deploy and the `addLiquidityETH` come from one
 * key. When a team splits them, this follows the one that opens trading — which
 * is the one a sniper wants anyway.
 */
function canDevSnipe(chain) { return !!chainOf(chain) && isEnabled(chain); }
/** How many wallets one fire of this selection buys on. '*' is resolved
 *  against the CURRENT wallet list (it is resolved again at fire time, so this
 *  is an estimate for pricing a budget, never a promise). */
function copyFanOut(u, sel) {
  if (!sel) return 1;
  if (sel.walletId === '*' || sel.walletIds === '*') return Math.max(1, walletList(u).length);
  if (Array.isArray(sel.walletIds) && sel.walletIds.length) return sel.walletIds.length;
  return 1;
}
/** A native amount written the way the UI writes it — no float tails in an
 *  error message the user is asked to act on. */
const trimAmt = (n) => String(Number(Number(n).toFixed(6)));
// mode: 'trades' = mirror the wallet's swap-BUYS (classic copy-trade);
//       'launches' = buy tokens the wallet CREATES on a launchpad (dev-wallet snipe).
function addCopyTarget(chatId, address, chain, buyEth, maxEth, mode, opts = {}) {
  const u = ensureUser(chatId);
  address = String(address || '').trim();
  mode = (mode === 'launches') ? 'launches' : 'trades';
  if (!isEnabled(chain)) throw new Error('chain not enabled');
  if (mode === 'launches' && !canDevSnipe(chain)) throw new Error('dev-wallet snipe needs an enabled chain — pick one from the chain list');
  const svm = isSvm(chain);
  // Validate per chain: base58 pubkey on Solana, 0x on EVM. Solana addresses are
  // case-SENSITIVE, so only lowercase EVM addresses for the dup check.
  if (svm) { if (!solana.isSolAddress(address)) throw new Error('invalid Solana wallet address'); }
  else if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('invalid wallet address');
  const norm = (a) => (svm ? a : a.toLowerCase());
  u.copy = u.copy || { on: false, targets: [] };
  u.copy.targets = u.copy.targets || [];
  if (u.copy.targets.length >= MAX_COPY_TARGETS) throw new Error(`copy limit (${MAX_COPY_TARGETS}) reached — remove one first`);
  // Allow following the SAME wallet in BOTH modes (mirror its trades AND snipe its
  // launches), so the dup check keys on address+chain+mode.
  if (u.copy.targets.some((t) => norm(t.address) === norm(address) && t.chain === chain && (t.mode || 'trades') === mode)) throw new Error(mode === 'launches' ? 'already sniping that dev on this chain' : 'already copying that wallet on this chain');
  const be = Number(buyEth);
  if (!(be > 0)) throw new Error('per-buy amount must be > 0');
  // Per-target execution settings, all honoured by _followerBuy: the wallet
  // SELECTION the buys (and their exit-mirror legs) are pinned to — one id,
  // a subset, or '*' for every wallet at fire time — the slippage bound, and
  // TP/SL that become real orders at each fill. Same bounds as addSnipeTarget.
  //
  // RESOLVED BEFORE THE BUDGET, because the budget is measured in LAUNCHES and
  // a launch costs buyEth × the selection size.
  let walletId = null, walletIds;
  if (Array.isArray(opts.walletIds) && opts.walletIds.length) {
    walletIds = [...new Set(opts.walletIds.map(String))];
    for (const id of walletIds) if (!walletById(u, id)) throw new Error('no such wallet');
    walletId = walletIds[0];
    if (walletIds.length === 1) walletIds = undefined;
  } else if (opts.walletId === '*') {
    walletId = '*';
  } else if (opts.walletId) {
    if (!walletById(u, opts.walletId)) throw new Error('no such wallet');
    walletId = opts.walletId;
  }
  // THE BUDGET IS PRICED PER LAUNCH, NOT PER WALLET.
  //
  // `_followerBuy` fits the whole fan-out or skips it, so a budget that covers
  // one wallet but not the selection arms cleanly and then silently never
  // fires — an armed watch that can never fire, which is exactly the
  // inert-watch failure this file refuses everywhere else. The floor and the
  // "ten buys" default are both scaled by the selection, so "budget" means the
  // same thing on one wallet and on five.
  const perLaunch = be * copyFanOut(u, { walletId, walletIds });
  // ⚠️ THE DEV SNIPE HAS NO SPENDING CAP — the owner's explicit call ("hapus
  // fitur budget jdi budget fiturnya tidak ada"), taken after the trade-off was
  // put to them in as many words. It is a real removal, not a hidden default:
  // a 'launches' target buys EVERY launch that developer makes, on every wallet
  // in its selection, until the master switch goes off, the target is removed,
  // or the wallets run dry.
  //
  // What replaces the cap is VISIBILITY, because this repo's rule is that
  // nothing spends money silently, not that everything must be bounded: the
  // arming confirmation and the Copy & Snipe row both say the watch is
  // uncapped, and `spentEth` is still accumulated so the running total is on
  // screen. `_followerBuy` skips its budget test for this mode alone.
  //
  // COPY TRADES ('trades') KEEPS ITS CAP. It was not what was asked about — the
  // question was about the per-LAUNCH budget on the snipe panel — and silently
  // uncapping a second feature on the strength of a request about the first is
  // how a removal turns into an incident.
  const capped = mode !== 'launches';
  const me = capped ? ((maxEth == null || maxEth === '') ? perLaunch * 10 : Number(maxEth)) : 0;
  if (capped && !(me >= perLaunch)) throw new Error(perLaunch > be ? `total budget must be ≥ ${trimAmt(perLaunch)} — one launch buys on ${copyFanOut(u, { walletId, walletIds })} wallets` : 'total budget must be ≥ the per-buy amount');
  const tp = Number(opts.tpPct) || 0, sl = Number(opts.slPct) || 0;
  if (tp < 0 || tp > 100000) throw new Error('take-profit must be 0–100000%');
  if (sl < 0 || sl >= 100) throw new Error('stop-loss must be below 100%');
  const t = {
    id: 'cp' + crypto.randomBytes(4).toString('hex'), address, chain, mode,
    buyEth: String(be), maxEth: capped ? String(me) : undefined, spentEth: 0, bought: {}, holding: {}, copySell: true,
    walletId: walletId || undefined, walletIds,
    slipBps: Math.max(0, Math.min(5000, Math.round(Number(opts.slipBps) || 0))) || undefined,
    tpPct: tp || undefined, slPct: sl || undefined,
    cursor: 0, cursorSig: '', createdAt: Date.now(),
  };
  u.copy.targets.push(t);
  saveStore();
  return t;
}
// ---------------------------------------------------------------- snipe by CA
/*
 * "Buy THIS contract the moment it can be bought."
 *
 * The two snipes that already existed answer a different question — buy EVERY
 * new launch on a chain, or buy whatever a followed dev launches. Neither can
 * express the most common request there is: somebody has the contract address
 * before the pool opens and wants to be in the first block that has one.
 *
 * Each target carries its OWN amount and slippage. A global slippage is right
 * for ordinary trading and wrong here: a launch fills through a pool that is
 * one block old, and the bound that gets you filled there would be reckless on
 * anything else.
 */
const MAX_SNIPE_TARGETS = Math.max(1, Number(process.env.MAX_SNIPE_TARGETS || 20));
// A target that never launches must not poll forever. Long enough for "the team
// said tonight" to be wrong by a day, short enough that a forgotten address is
// not still armed against a wallet next month.
const SNIPE_TTL_MS = Math.max(3600000, Number(process.env.SNIPE_TARGET_TTL_MS || 48 * 3600 * 1000));

function snipeTargets(u) { return (u && Array.isArray(u.snipeTargets)) ? u.snipeTargets : []; }
function snipeTargetById(u, id) { return snipeTargets(u).find((t) => t.id === id) || null; }
/** Targets still worth polling: armed, not expired. */
function armedSnipeTargets(u, now = Date.now()) {
  return snipeTargets(u).filter((t) => t.status === 'armed' && (!t.expiresAt || t.expiresAt > now));
}

function addSnipeTarget(chatId, { ca, chain, amount, slipBps, walletId, walletIds, ttlMs, tpPct, slPct } = {}) {
  const u = ensureUser(chatId);
  const chainKey = chain && chainOf(chain) && isEnabled(chain) ? chain : userChain(u);
  const svm = isSvm(chainKey);
  ca = String(ca || '').trim();
  if (svm) { if (!solana.isSolAddress(ca)) throw new Error('invalid Solana token mint'); }
  else if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) throw new Error('invalid contract address');
  const amt = Number(amount);
  if (!(amt > 0)) throw new Error('amount must be > 0');
  // TP/SL ride ON the target and become real orders only when the snipe FILLS —
  // an order on a token you do not hold yet has nothing to trigger against.
  // SL is a percentage of a price, so ≥100 can never fire; TP is capped so a
  // typo ("tp 10000") cannot park an order nothing will ever reach.
  const tp = Number(tpPct) || 0, sl = Number(slPct) || 0;
  if (tp < 0 || tp > 100000) throw new Error('take-profit must be 0–100000%');
  if (sl < 0 || sl >= 100) throw new Error('stop-loss must be below 100%');
  u.snipeTargets = snipeTargets(u);
  // Only ARMED targets count against the cap. A finished snipe is history, and
  // making somebody delete their own receipts to arm the next one is the kind of
  // limit that reads as a bug.
  if (armedSnipeTargets(u).length >= MAX_SNIPE_TARGETS) throw new Error(`snipe limit (${MAX_SNIPE_TARGETS}) reached — remove one first`);
  const key = svm ? ca : ca.toLowerCase();
  if (armedSnipeTargets(u).some((t) => t.chain === chainKey && (svm ? t.ca : String(t.ca).toLowerCase()) === key)) {
    throw new Error('that contract is already armed on this chain');
  }
  // The wallet selection: '*' = EVERY wallet resolved at fire time, walletIds =
  // a chosen SUBSET, walletId = one. The amount is per wallet — the armed
  // confirmation states the multiplied total.
  let ids;
  if (Array.isArray(walletIds) && walletIds.length) {
    ids = [...new Set(walletIds.map(String))];
    for (const id of ids) if (!walletById(u, id)) throw new Error('no such wallet');
    // One id collapses to the plain single-wallet shape; several keep the list
    // AND pin walletId to the first, so older readers see a real wallet.
    walletId = ids[0];
    if (ids.length === 1) ids = undefined;
  }
  const w = (walletId && walletId !== '*') ? walletById(u, walletId) : activeWallet(u);
  if (!w) throw new Error('no wallet');
  const t = {
    id: 'sn' + crypto.randomBytes(4).toString('hex'),
    ca, chain: chainKey, amount: String(amt), tpPct: tp || undefined, slPct: sl || undefined,
    walletIds: ids,
    // 0 means "use my normal slippage" — stored as 0 rather than copying the
    // current value, so a later change to the global setting still reaches a
    // target the user never customised.
    slipBps: Math.max(0, Math.min(5000, Math.round(Number(slipBps) || 0))),
    walletId: walletId === '*' ? '*' : w.id,
    status: 'armed', createdAt: Date.now(),
    expiresAt: Date.now() + Math.max(60000, Number(ttlMs) || SNIPE_TTL_MS),
    checks: 0, firedAt: null, hash: null, lastErr: null, lastErrAt: null,
  };
  u.snipeTargets.push(t);
  // Trim finished history so a long-lived account cannot grow this without bound.
  const done = u.snipeTargets.filter((x) => x.status !== 'armed');
  if (done.length > 30) u.snipeTargets = u.snipeTargets.filter((x) => x.status === 'armed' || done.slice(-30).includes(x));
  saveStoreNow();
  return t;
}

function removeSnipeTarget(chatId, id) {
  const u = ensureUser(chatId);
  const before = snipeTargets(u).length;
  u.snipeTargets = snipeTargets(u).filter((t) => t.id !== id);
  if (u.snipeTargets.length !== before) { saveStoreNow(); return true; }
  return false;
}

/**
 * Claim a target for firing, ATOMICALLY and BEFORE the buy.
 *
 * A missed snipe is a shrug; a double buy is money spent twice, and the poll
 * that owns this runs every few seconds — so a target left `armed` while its
 * buy is in flight WILL be picked up again by the next tick. Same rule the
 * auto-raid cursor keeps, for the same reason, and it is written synchronously
 * (`saveStoreNow`) so a crash mid-buy cannot resurrect it either.
 *
 * Returns false when somebody already claimed it.
 */
function claimSnipeTarget(u, id) {
  const t = snipeTargetById(u, id);
  if (!t || t.status !== 'armed') return false;
  t.status = 'firing';
  t.firedAt = Date.now();
  saveStoreNow();
  return true;
}
function settleSnipeTarget(u, id, { ok, hash, err }) {
  const t = snipeTargetById(u, id);
  if (!t) return;
  t.status = ok ? 'done' : 'failed';
  if (hash) t.hash = hash;
  if (err) { t.lastErr = String(err).slice(0, 180); t.lastErrAt = Date.now(); }
  saveStoreNow();
}
/** Put a claimed target back — used only when nothing was spent. */
function rearmSnipeTarget(u, id, err) {
  const t = snipeTargetById(u, id);
  if (!t || t.status !== 'firing') return;
  t.status = 'armed';
  t.firedAt = null;
  if (err) { t.lastErr = String(err).slice(0, 180); t.lastErrAt = Date.now(); }
  saveStoreNow();
}
function expireSnipeTarget(u, id) {
  const t = snipeTargetById(u, id);
  if (!t || t.status !== 'armed') return;
  t.status = 'expired';
  saveStoreNow();
}

// ------------------------------------------------------------ snipe setup panel
/*
 * The tap-driven Snipe Setup panel — "sama seperti sol trading bot, ada
 * setingan lengkap, buat semudah mungkin" (2026-08-17).
 *
 * A DRAFT is the panel's state: one per user, persisted, so a half-configured
 * snipe survives a restart the way the reference panel's "Waiting for setup"
 * does. The draft owns per-field BOUNDS only; arming goes through
 * addSnipeTarget, the single owner of what a valid target is, so the panel and
 * the one-line arm cannot drift into two ideas of one — the same reason three
 * snipe callers share canTradeNow().
 *
 * The amount has NO default on purpose. The "buy ngasal" incident was an amount
 * set weeks earlier on another screen, silently reused — so the panel makes the
 * spend an explicit choice every time, exactly like auto-snipe's Step 2.
 */
const SNIPE_DRAFT_TTL_H = Math.max(1, Math.min(168, Math.round(SNIPE_TTL_MS / 3600000)));

function _snipeAddrOk(ca, chainKey) {
  return isSvm(chainKey) ? solana.isSolAddress(String(ca || '')) : /^0x[0-9a-fA-F]{40}$/.test(String(ca || ''));
}
function snipeDraft(u) {
  return (u && u.snipeDraft && typeof u.snipeDraft === 'object') ? u.snipeDraft : null;
}
function newSnipeDraft(chatId) {
  const u = ensureUser(chatId);
  const w = activeWallet(u);
  u.snipeDraft = {
    // kind 'ca' = buy THIS contract when its pool opens; 'dev' = buy every new
    // token a developer wallet launches (a copy target in 'launches' mode).
    // One panel serves both — "dmn target dev walletnya".
    kind: 'ca',
    // The wallet selection is a SET ("bisa pilih multi wallet, all on atau all
    // off, sama kaya beli"): an array of wallet ids, or '*' for every wallet
    // resolved at fire time. Same model as the buy/sell wallet picker.
    chain: userChain(u), ca: null, walletIds: w ? [w.id] : [],
    amount: null, slipPct: 0, tpPct: 0, slPct: 0, ttlH: SNIPE_DRAFT_TTL_H,
    createdAt: Date.now(),
  };
  saveStore();
  return u.snipeDraft;
}
/** Patch one or more rows. Throws (and changes nothing else) on a value outside
 *  the same bounds addSnipeTarget enforces, so the panel can never display a
 *  setting the arm step would then refuse. */
function updateSnipeDraft(chatId, patch = {}) {
  const u = ensureUser(chatId);
  const d = snipeDraft(u) || newSnipeDraft(chatId);
  if (patch.chain !== undefined) {
    if (!chainOf(patch.chain) || !isEnabled(patch.chain)) throw new Error('chain not enabled');
    d.chain = patch.chain;
    // A CA that cannot exist on the new chain is DROPPED, never silently kept:
    // an EVM address left "armed" under a Solana row is the wrong-chain bounce
    // the chain-first rule exists to prevent, one screen later.
    if (d.ca && !_snipeAddrOk(d.ca, d.chain)) d.ca = null;
  }
  if (patch.kind !== undefined) {
    if (patch.kind !== 'ca' && patch.kind !== 'dev') throw new Error('unknown target kind');
    // Switching kinds CLEARS the address: a token CA reinterpreted as a dev
    // wallet (or the reverse) is shape-valid and semantically wrong — it would
    // arm a watch that can never fire, the inert-watch failure mode.
    if ((d.kind || 'ca') !== patch.kind) d.ca = null;
    d.kind = patch.kind;
  }
  if (patch.ca !== undefined) {
    if (patch.ca === null) d.ca = null;
    else {
      const ca = String(patch.ca).trim();
      if (!_snipeAddrOk(ca, d.chain)) throw new Error(isSvm(d.chain) ? 'invalid Solana token mint' : 'invalid contract address');
      d.ca = ca;
    }
  }
  if (patch.walletId !== undefined) {
    // Legacy single-wallet patch, kept so older callers and the one-line paths
    // stay valid — it maps onto the selection set.
    if (patch.walletId !== '*' && !walletById(u, patch.walletId)) throw new Error('no such wallet');
    d.walletIds = patch.walletId === '*' ? '*' : [patch.walletId];
  }
  if (patch.walletIds !== undefined) {
    // The selection SET: '*' (every wallet, resolved at fire time — a wallet
    // added after arming still snipes), or an array of wallet ids. An EMPTY
    // array is a valid mid-edit state (the user just tapped "all off"); arming
    // is where at-least-one is enforced.
    if (patch.walletIds === '*') d.walletIds = '*';
    else {
      const ids = [...new Set((Array.isArray(patch.walletIds) ? patch.walletIds : []).map(String))];
      for (const id of ids) if (!walletById(u, id)) throw new Error('no such wallet');
      d.walletIds = ids;
    }
  }
  if (patch.amount !== undefined) {
    if (patch.amount === null) d.amount = null;
    else {
      const a = Number(patch.amount);
      if (!(a > 0)) throw new Error('amount must be > 0');
      d.amount = String(a);
    }
  }
  if (patch.slipPct !== undefined) {
    const s = Number(patch.slipPct);
    if (!Number.isFinite(s) || s < 0 || s > 50) throw new Error('slippage must be 0–50%');
    d.slipPct = s;
  }
  if (patch.tpPct !== undefined || patch.slPct !== undefined) {
    const tp = patch.tpPct !== undefined ? (Number(patch.tpPct) || 0) : (Number(d.tpPct) || 0);
    const sl = patch.slPct !== undefined ? (Number(patch.slPct) || 0) : (Number(d.slPct) || 0);
    if (tp < 0 || tp > 100000) throw new Error('take-profit must be 0–100000%');
    if (sl < 0 || sl >= 100) throw new Error('stop-loss must be below 100%');
    d.tpPct = tp; d.slPct = sl;
  }
  if (patch.ttlH !== undefined) {
    const h = Number(patch.ttlH);
    if (!Number.isFinite(h) || h < 1 || h > 168) throw new Error('expiry must be 1–168 hours');
    d.ttlH = h;
  }
  saveStore();
  return d;
}
function clearSnipeDraft(chatId) {
  const u = ensureUser(chatId);
  if (u.snipeDraft) { u.snipeDraft = null; saveStore(); }
}
/** Arm the draft — THROUGH addSnipeTarget, never around it. The draft is
 *  cleared only on SUCCESS: a refused arm ("already armed", cap reached) leaves
 *  the panel intact so the user fixes one row instead of retyping seven. */
/**
 * The target already watching this (kind, chain, address), or null.
 *
 * THE SINGLE OWNER of "is this a duplicate", because two of them had already
 * appeared: `addSnipeTarget` and `addCopyTarget` each refuse one at arm time,
 * and the PANEL knew about neither — so it rendered every row ✅, printed
 * "Ready … tap ⚡ ARM SNIPE", and offered a live button for a target that
 * could only ever be refused. A screen that offers an action which cannot
 * succeed is a screen that gets reported as broken, and it was.
 *
 * `kind` is 'dev' (a copy target in launches mode) or 'ca' (an armed snipe
 * target). Address comparison is chain-correct: base58 is case-SIGNIFICANT.
 */
function armedTargetFor(chatId, { kind, chain, ca }) {
  const u = getUser(chatId);
  if (!u || !chain || !ca) return null;
  const norm = (a) => (isSvm(chain) ? String(a || '').trim() : String(a || '').trim().toLowerCase());
  const want = norm(ca);
  if (kind === 'dev') {
    const list = (u.copy && Array.isArray(u.copy.targets)) ? u.copy.targets : [];
    return list.find((t) => t.mode === 'launches' && t.chain === chain && norm(t.address) === want) || null;
  }
  return armedSnipeTargets(u).find((t) => t.chain === chain && norm(t.ca) === want) || null;
}

/**
 * Re-terms a target that is already watching, from the panel's draft.
 *
 * The bounds are the ARMING sites' bounds, re-checked here — a second set of
 * limits would be a way to edit a target into a state ⚡ would have refused to
 * create. A dev target has no budget to re-check (the cap was removed on the
 * owner's call — see addCopyTarget); a copy-TRADES target keeps its own.
 *
 * `_updated` is how the caller tells "armed" from "re-termed" on the message it
 * sends back — the two are different events to a reader, and a confirmation
 * saying "armed" over a target that has already spent money is a lie about what
 * just happened.
 */
function updateArmedTarget(chatId, t, d, walletOpts) {
  const u = ensureUser(chatId);
  const dev = t.mode === 'launches';
  const be = Number(d.amount);
  if (!(be > 0)) throw new Error('no amount yet — pick how much to spend first');
  const spent = Number(t.spentEth) || 0;
  const tp = Number(d.tpPct) || 0, sl = Number(d.slPct) || 0;
  if (tp < 0 || tp > 100000) throw new Error('take-profit must be 0–100000%');
  if (sl < 0 || sl >= 100) throw new Error('stop-loss must be below 100%');
  t.buyEth = String(be);
  t.walletId = walletOpts.walletId || undefined;
  t.walletIds = walletOpts.walletIds;
  t.slipBps = Math.max(0, Math.min(5000, Math.round(Number(d.slipPct) * 100) || 0)) || undefined;
  t.tpPct = tp || undefined;
  t.slPct = sl || undefined;
  if (!dev && Number(d.ttlH) > 0) t.expiresAt = Date.now() + Number(d.ttlH) * 3600000;
  saveStoreNow();
  return Object.assign(Object.create(Object.getPrototypeOf(t)), t, { _updated: true, _spent: spent });
}

function armSnipeDraft(chatId) {
  const u = ensureUser(chatId);
  const d = snipeDraft(u);
  if (!d) throw new Error('nothing to arm — open the setup panel first');
  // addSnipeTarget falls back to the ACTIVE chain when handed a disabled one —
  // right for a typed line, silently wrong-chain for a panel whose chain row is
  // the first thing on the screen. Refuse instead.
  if (!chainOf(d.chain) || !isEnabled(d.chain)) throw new Error('that chain is disabled — pick another on the panel');
  if (!d.ca) throw new Error('no target yet — set the target first');
  if (!(Number(d.amount) > 0)) throw new Error('no amount yet — pick how much to spend first');
  // The wallet SELECTION: '*' rides through as-is (resolved at fire time), a
  // set of ids rides as walletIds, one id as the plain walletId — and an empty
  // set is refused HERE, where the fix is one row away, not at fire time.
  const sel = d.walletIds === '*' ? '*' : [...new Set((Array.isArray(d.walletIds) ? d.walletIds : []).filter((id) => walletById(u, id)))];
  if (sel !== '*' && sel.length === 0) throw new Error('no wallet selected — pick at least one on the panel');
  const walletOpts = sel === '*'
    ? { walletId: '*' }
    : sel.length === 1 ? { walletId: sel[0] } : { walletIds: sel };
  // ALREADY WATCHING THIS TARGET? Then ⚡ UPDATES it — it does not refuse.
  //
  // "saya kan set 0.01 eth 5 wallet tpi laporanya hanya 1 wallet". A new draft
  // defaults its wallet row to the ACTIVE wallet, so a target armed before that
  // row was touched watches with one; changing the row afterwards and tapping ⚡
  // was refused as a duplicate, and the only route to the settings the user
  // wanted was to know they had to REMOVE the target first — which nothing said.
  // Tapping ⚡ on a panel showing this target with new settings has exactly one
  // possible meaning: watch it with THESE. Refusing is the least useful reading
  // of an unambiguous request.
  //
  // What is REWRITTEN is the terms (amount, budget, wallets, slippage, TP/SL).
  // What is PRESERVED is the history — `spentEth`, `bought`, `holding`,
  // `copySell`, the id and the cursor — because a budget that reset itself on an
  // edit would let one target spend its cap again, and a cleared `bought` map
  // would re-buy a launch it already holds. An edit changes the rules going
  // forward; it never un-spends money.
  const existing = armedTargetFor(chatId, { kind: (d.kind || 'ca') === 'dev' ? 'dev' : 'ca', chain: d.chain, ca: d.ca });
  if (existing) {
    const upd = updateArmedTarget(chatId, existing, d, walletOpts);
    u.snipeDraft = null;
    saveStoreNow();
    return upd;
  }
  // A dev-wallet target is a copy target in 'launches' mode — the SAME store
  // the wizard and /copy write, so the panel cannot grow a second idea of what
  // a dev snipe is. The caller tells them apart by `mode === 'launches'`.
  let t;
  if ((d.kind || 'ca') === 'dev') {
    // Budget unset = ten buys (addCopyTarget's default) — a cap without a
    // question. Every other panel row rides the target and is honoured by
    // _followerBuy: wallet selection, slippage, TP/SL.
    t = addCopyTarget(chatId, d.ca, d.chain, d.amount, null, 'launches', {
      ...walletOpts,
      slipBps: Math.round((Number(d.slipPct) || 0) * 100),
      tpPct: d.tpPct, slPct: d.slPct,
    });
  } else {
    t = addSnipeTarget(chatId, {
      ca: d.ca, chain: d.chain, amount: d.amount, ...walletOpts,
      slipBps: Math.round((Number(d.slipPct) || 0) * 100),
      tpPct: d.tpPct, slPct: d.slPct,
      ttlMs: Number(d.ttlH) > 0 ? Number(d.ttlH) * 3600000 : undefined,
    });
  }
  u.snipeDraft = null;
  saveStoreNow();
  return t;
}

function removeCopyTarget(chatId, id) {
  const u = getUser(chatId); if (!u || !u.copy || !Array.isArray(u.copy.targets)) return false;
  const before = u.copy.targets.length;
  u.copy.targets = u.copy.targets.filter((t) => t.id !== id);
  if (u.copy.targets.length !== before) { saveStore(); return true; }
  return false;
}
/** Turn exit-mirroring on or off for ONE followed wallet. Off leaves anything
 *  already copy-bought exactly where it is — the user sells it themselves. */
function setCopySell(chatId, targetId, on) {
  const u = ensureUser(chatId);
  const t = (u.copy && u.copy.targets || []).find((x) => x.id === targetId);
  if (!t) throw new Error('not following that wallet');
  t.copySell = !!on; saveStore();
  return t.copySell;
}
/** Remember that WE copy-bought `token` from this target, and how much of it the
 *  target held at that moment. That number is the baseline the exit watcher
 *  measures against: the position is only ours to mirror out of if it was ours
 *  to mirror into. */
function copyHoldingAdd(t, token, targetBalRaw, walletId, boughtRaw, legs) {
  t.holding = t.holding || {};
  // `wid` pins the exit to the wallet that actually opened the position. Without
  // it the sell goes to whatever wallet happens to be ACTIVE at exit time, and a
  // user who switched wallets in between gets "token balance is 0" on a bag they
  // are still holding.
  // `own` is the RAW amount this mirror actually filled — the only part of the
  // user's bag copy is entitled to sell. Without it the exit closed 100% of
  // whatever the wallet held, so a 0.01 ETH mirror could market-sell a 20 ETH
  // position the user had opened themselves a year earlier. The operator's rule
  // has always been "only tokens bought via copy"; that guarded WHICH token was
  // sold and never how much.
  let own = '';
  try { if (boughtRaw != null) { const v = BigInt(boughtRaw); if (v > 0n) own = v.toString(); } } catch (_) { own = ''; }
  const rec = { bal: String(targetBalRaw == null ? '' : targetBalRaw), own, at: Date.now(), wid: walletId || null, tries: 0 };
  // A multi-wallet fill records one LEG per wallet — {wid, own} — because the
  // exit must sell each wallet's slice from that wallet; a single wid would
  // sell one bag and strand the rest. The top-level wid/own mirror the first
  // leg so a reader that predates legs still sees a real position.
  if (Array.isArray(legs) && legs.length) {
    rec.legs = legs.map((l) => ({ wid: l.wid || null, own: String(l.own || '') }));
    rec.wid = rec.legs[0].wid; rec.own = rec.legs[0].own;
  }
  t.holding[copyTokenKey(t.chain, token)] = rec;
  saveStoreNow();   // written through: a crash here would lose the exit baseline
}
/** Put a position BACK on the ledger after an exit attempt failed, so the next
 *  cycle retries it. An exit that vanishes because one sell reverted is the
 *  worst outcome available: the user is left holding a bag the bot promised to
 *  close, and told nothing. Returns the attempt count. */
function copyHoldingRetry(t, token, rec) {
  const k = copyTokenKey(t.chain, token);
  t.holding = t.holding || {};
  const tries = (Number(rec && rec.tries) || 0) + 1;
  t.holding[k] = { ...(rec || {}), tries, lastTryAt: Date.now() };
  saveStoreNow();
  return tries;
}
/** Narrow a tracked position to the legs that have NOT been attempted yet,
 *  without touching the retry accounting.
 *
 *  The exit loop sells one leg at a time and each leg must be off the ledger
 *  for the duration of its own sell (a crash mid-sell must not let the next
 *  cycle sell it again) — while the legs behind it stay ON, because nothing was
 *  broadcast for those and dropping them would strand real money. Written
 *  through for the same reason the rest of this ledger is. */
function copyHoldingSet(t, token, rec) {
  const k = copyTokenKey(t.chain, token);
  t.holding = t.holding || {};
  t.holding[k] = rec;
  saveStoreNow();
}
function copyHoldingDrop(t, token) {
  if (!t.holding) return;
  delete t.holding[copyTokenKey(t.chain, token)];
  saveStoreNow();
}
/** Raise the baseline when the target adds to its position, so a later partial
 *  sale is measured from its PEAK and not from where we happened to join. */
function copyHoldingBump(t, token, targetBalRaw) {
  const k = copyTokenKey(t.chain, token);
  const h = t.holding && t.holding[k]; if (!h) return false;
  let prev = 0n; try { prev = BigInt(h.bal || '0'); } catch (_) { prev = 0n; }
  const now = (() => { try { return BigInt(targetBalRaw); } catch (_) { return 0n; } })();
  if (now > prev) { h.bal = String(now); saveStore(); return true; }
  return false;
}
// Solana mints are case-SENSITIVE base58; EVM addresses are not. Same rule as posKey.
function copyTokenKey(chainKey, token) { return isSvm(chainKey) ? String(token) : String(token).toLowerCase(); }

function setCopyOn(chatId, on) {
  const u = ensureUser(chatId);
  u.copy = u.copy || { on: false, targets: [] };
  u.copy.on = !!on; saveStore();
  return u.copy.on;
}

// ---------------------------------------------------------------- settings
// Getter that RE-ASSERTS the render constraint the setter enforces (short plain
// decimal, ≤100), so the token card can never build an invalid/oversized callback
// even if the store was hand-edited. Falls back to the defaults if anything's off.
function _presetsOk(a) {
  const okOne = (x) => x > 0 && x <= 100 && String(x).length <= 6 && !/e/i.test(String(x));
  return Array.isArray(a) && a.length >= PRESETS_MIN && a.length <= PRESETS_MAX && a.every(okOne);
}
// Quick-buy amounts. Per-chain override (settings.presetsByChain[chainKey]) wins,
// then the global settings.buyPresets, then the default. Chain amounts differ in
// value (0.01 ETH != 0.01 BNB) so a per-chain default is genuinely useful.
function buyPresets(u, chainKey) {
  const s = (u && u.settings) || {};
  if (chainKey && s.presetsByChain && _presetsOk(s.presetsByChain[chainKey])) return s.presetsByChain[chainKey];
  // A user who never touched the setting gets the CHAIN's default, not a global
  // one denominated in somebody else's coin. Anyone who DID set a global keeps it
  // — an explicit choice outranks a better default, which is what buyPresetsSet
  // records. It matters that this is a FLAG and not "does it differ from the
  // default": every user is SEEDED with the default (see ensureUser), and
  // setBuyPresets can only reach the global when the chain is disabled, so
  // "differs from the default" would be false for essentially everyone and the
  // chain default would never apply.
  if (s.buyPresetsSet && _presetsOk(s.buyPresets)) return s.buyPresets;
  const byChain = defaultPresetsFor(chainKey);
  return _presetsOk(byChain) ? byChain : (_presetsOk(s.buyPresets) ? s.buyPresets : DEFAULT_BUY_PRESETS);
}
function setSlippage(chatId, pct) {
  const u = ensureUser(chatId);
  const n = Number(pct);
  if (!(n >= 0) || n > 50) throw new Error('slippage must be a number 0–50 (%)');
  u.settings.slippage = n; saveStore();
  return n;
}
// Gas priority as a small integer multiplier on the gas price: 1 = Normal (the
// default 2× base-fee buffer), 2 = Fast, 3 = Turbo. Higher confirms quicker when
// the chain is busy; on the cheap Robinhood L2 even Turbo costs a fraction of a
// cent. Retry escalation (on a failed sell) still bumps ON TOP of this.
function userGasBoost(u) { const v = Math.round(Number(u && u.settings && u.settings.gasBoost)); return (v >= 1 && v <= 6) ? v : 1; }
function setGasBoost(chatId, n) {
  const u = ensureUser(chatId);
  let v = Math.round(Number(n));
  if (!(v >= 1)) v = 1;
  if (v > 6) v = 6;
  u.settings.gasBoost = v; saveStore();
  return v;
}
// Set the 3 quick-buy amounts. If chainKey is given, they apply to THAT chain only
// (settings.presetsByChain[chainKey]); otherwise they set the global default.
function setBuyPresets(chatId, input, chainKey) {
  const u = ensureUser(chatId);
  const toks = String(input).trim().split(/[\s,]+/).filter(Boolean);
  // A RANGE, matching _presetsOk and the store migration — all three used to
  // demand exactly 3 and every one of them had to be loosened together, or a
  // longer set would be accepted here and then silently reverted on load.
  if (toks.length < PRESETS_MIN || toks.length > PRESETS_MAX) throw new Error(`give ${PRESETS_MIN}–${PRESETS_MAX} positive amounts, e.g. "0.1 0.2 0.5 1 2"`);
  const nums = [];
  for (const t of toks) {
    // Plain decimals only — exponential like "1e-7" would pass Number() but then
    // ethers.parseEther() rejects it at buy time, and it also encodes weirdly.
    if (!/^\d*\.?\d+$/.test(t)) throw new Error('amounts must be plain numbers, e.g. 0.01 0.05 0.1');
    const n = Number(t);
    // Embedded in a Telegram callback (≤64 bytes) beside a 42-char address, so keep
    // the printed form short + a plain decimal (no exponential from tiny values).
    if (!(n > 0) || n > 100 || String(n).length > 6 || /e/i.test(String(n))) throw new Error('keep each amount a short plain number ≤ 100 (e.g. 0.01 0.05 0.1)');
    nums.push(n);
  }
  if (chainKey && isEnabled(chainKey)) { u.settings.presetsByChain = u.settings.presetsByChain || {}; u.settings.presetsByChain[chainKey] = nums; }
  else { u.settings.buyPresets = nums; u.settings.buyPresetsSet = true; }   // an explicit global choice, so a chain default must not override it
  saveStore();
  return nums;
}
function setAutoBuy(chatId, on, amount) {
  const u = ensureUser(chatId);
  if (on !== undefined && on !== null) u.settings.autoBuy = !!on;
  if (amount !== undefined && amount !== null) { const a = Number(amount); if (!(a > 0)) throw new Error('amount must be > 0'); u.settings.autoBuyAmount = String(a); }
  saveStore();
  return { autoBuy: u.settings.autoBuy, autoBuyAmount: u.settings.autoBuyAmount };
}
// Confirm-before-buy: when ON, a buy asks for a Yes/No confirmation first.
function setConfirmBuy(chatId, on) { const u = ensureUser(chatId); u.settings.confirmBuy = !!on; saveStore(); return u.settings.confirmBuy; }
// Expert/fast mode: skip the intermediate "⏳ Buying…" progress messages.
function setExpert(chatId, on) { const u = ensureUser(chatId); u.settings.expert = !!on; saveStore(); return u.settings.expert; }
// Multi-wallet receipts: 'per_wallet' (one message each, as each fills) or
// 'combined' (one message for the batch, once every wallet has settled).
function setReceiptStyle(chatId, style) { const u = ensureUser(chatId); u.settings.receiptStyle = style === 'combined' ? 'combined' : 'per_wallet'; saveStore(); return u.settings.receiptStyle; }
const perWalletReceipts = (u) => ((u && u.settings && u.settings.receiptStyle) || 'per_wallet') !== 'combined';
function getLang(chatId) { const u = getUser(chatId); return (u && (u.lang === 'id' || u.lang === 'en')) ? u.lang : 'en'; }
function setLang(chatId, lang) { const u = ensureUser(chatId); u.lang = (lang === 'id') ? 'id' : 'en'; saveStore(); return u.lang; }
// Auto-exit: after every buy, auto-place a take-profit at +tpPct and/or a stop-loss at
// −slPct (0 disables that leg). Clamped to sane ranges.
function setAutoExit(chatId, tpPct, slPct) {
  const u = ensureUser(chatId);
  const tp = Math.max(0, Math.min(100000, Math.round(Number(tpPct) || 0)));   // +% gain
  const sl = Math.max(0, Math.min(99, Math.round(Number(slPct) || 0)));       // −% loss (can't be ≥100%)
  u.settings.autoTpPct = tp; u.settings.autoSlPct = sl; saveStore();
  return { autoTpPct: tp, autoSlPct: sl };
}
// Rug guard (opt-in): when ON, the positions watcher auto-sells 100% of a held bag if it
// crashes far below its peak OR its safety check flips to DANGER (honeypot / LP pulled /
// sell-tax spike). A genuine honeypot may still block the exit — best-effort protection.
function setAutoProtect(chatId, on) {
  const u = ensureUser(chatId);
  u.settings.autoProtect = !!on; saveStore();
  return u.settings.autoProtect;
}
// Per-type notification toggles for PASSIVE bot actions (snipe / copy). User-created
// signals — price alerts and your own limit/TP/SL fills — always notify (muting a
// one-shot alert would silently delete the very signal you asked for).
const NOTIFY_TYPES = ['snipe', 'copy'];
function setNotify(chatId, type, on) {
  const u = ensureUser(chatId);
  if (!NOTIFY_TYPES.includes(type)) throw new Error('unknown notify type');
  u.settings.notify = u.settings.notify || {};
  u.settings.notify[type] = !!on; saveStore();
  return u.settings.notify;
}
function notifyOn(chatId, type) {
  const u = getUser(chatId); if (!u) return true;
  const n = u.settings && u.settings.notify;
  if (!n || typeof n !== 'object' || n[type] === undefined) return true;   // default ON
  return !!n[type];
}
// ── Multi-wallet trade selection (Maestro style) ─────────────────────────────
// Which wallets a Buy/Sell tap acts on. { all:true } = every wallet; else an
// explicit id list. Empty/absent = single-wallet (the card's bound wallet).
function _tradeSel(u) { u.settings = u.settings || {}; if (!u.settings.tradeSel || typeof u.settings.tradeSel !== 'object') u.settings.tradeSel = { all: false, ids: [] }; if (!Array.isArray(u.settings.tradeSel.ids)) u.settings.tradeSel.ids = []; return u.settings.tradeSel; }
function tradeSelection(chatId) { const u = ensureUser(chatId); const s = _tradeSel(u); return { all: !!s.all, ids: s.ids.slice() }; }
function setTradeAll(chatId, on) { const u = ensureUser(chatId); const s = _tradeSel(u); s.all = !!on; if (on) s.ids = []; else s.ids = []; saveStore(); return tradeSelection(chatId); }
function toggleTradeWallet(chatId, walletId) {
  const u = ensureUser(chatId); const s = _tradeSel(u);
  const all = walletList(u).map((w) => w.id);
  if (!all.includes(walletId)) return tradeSelection(chatId);
  const set = new Set(s.all ? all : s.ids.filter((id) => all.includes(id)));
  if (set.has(walletId)) set.delete(walletId); else set.add(walletId);
  s.all = (all.length > 0 && set.size === all.length);
  s.ids = s.all ? [] : Array.from(set);
  saveStore();
  return tradeSelection(chatId);
}
// Effective, existence-filtered wallet ids a trade should hit. [] = none explicitly
// selected → caller falls back to the card's single wallet.
function tradeWalletIds(chatId) {
  const u = getUser(chatId); if (!u) return [];
  const s = _tradeSel(u); const all = walletList(u).map((w) => w.id);
  if (s.all) return all.slice();
  return s.ids.filter((id) => all.includes(id));
}

// ---------------------------------------------------------------- chain reads
// ---------------------------------------------------------------- read caches
// A token's name/symbol/decimals never change, and a launchpad curve's address is
// fixed the moment that token is created. Re-reading them on every buy, sell, card
// render and watcher tick cost a live round trip each, ON the trade's critical
// path. They are cached for the life of the process — but ONLY when the read
// actually succeeded, because caching a fallback would stamp "TOKEN"/18-decimals
// onto a user's position permanently after one RPC blip.
const _metaCache = new Map();    // `${chain}:${ca}`    → { name, sym, decimals }
const _curveCache = new Map();   // `${chain}:${ca}`    → { curve, ts }; '' = none (re-checked)
const _gradCache = new Set();    // `${chain}:${curve}` — graduation is ONE-WAY, so only `true` is cached
const NO_CURVE_TTL_MS = 60000;   // a token CAN gain a curve later, so a negative answer expires
const _ckey = (chainKey, x) => chainKey + ':' + (isSvm(chainKey) ? String(x) : String(x).toLowerCase());
// Exported for tests: resolveCurve short-circuits on a NEGATIVE cache entry
// BEFORE its try block, so a test that expects the provider to be called has to
// start from a clean cache or it silently asserts against a previous test's
// answer — which is order- and timing-dependent, i.e. green here and red on the
// server.
// _dsCache too: it is a 30s memo of an EXTERNAL answer, and a test that swaps
// the indexer out gets the previous test's response without this.
function _clearReadCaches() { _metaCache.clear(); _curveCache.clear(); _gradCache.clear(); _dsCache.clear(); _gtCache.clear(); _venueCache.clear(); curveTrade._reset(); }

// Why the launchpad last failed to answer, per chain. resolveCurve deliberately
// collapses a factory error into '' — the same value that means "this token genuinely
// has no curve" — because an RPC blip must not read as a graduation. The cost of that
// (correct) choice is that a factory which is simply WRONG for this chain, and reverts
// on every single call, is indistinguishable from a market full of graduated tokens:
// every buy quietly routes to the DEX and the card says "no pool/curve found here".
// Nothing recorded that, anywhere. This does.
const _launchpadFail = new Map();   // chainKey -> { err, at, count, factory }
const LAUNCHPAD_LOG_EVERY_MS = 60000;
function launchpadDiag(chainKey) { return chainKey ? (_launchpadFail.get(chainKey) || null) : Object.fromEntries(_launchpadFail); }

async function resolveCurve(ca, chainKey) {
  const chain = chainOf(chainKey); if (!chain || !chain.curve) return '';
  const k = _ckey(chainKey, ca);
  const hit = _curveCache.get(k);
  if (hit && (hit.curve || Date.now() - hit.ts < NO_CURVE_TTL_MS)) return hit.curve;
  try {
    const c = await new ethers.Contract(chain.factory, FACTORY_ABI, providerFor(chainKey)).curveOf(ca);
    const curve = (c && c !== ethers.ZeroAddress) ? c : '';
    _curveCache.set(k, { curve, ts: Date.now() });
    _launchpadFail.delete(chainKey);   // it answered — whatever was wrong is over
    return curve;
  } catch (e) {
    // Routing is UNCHANGED (still '' → DEX): a transient failure must keep behaving
    // like an RPC blip. All that is added is a record and a rate-limited log, so a
    // permanently wrong factory stops being silent.
    const prev = _launchpadFail.get(chainKey);
    const rec = { err: (e && (e.shortMessage || e.message)) || String(e), at: Date.now(), count: (prev ? prev.count : 0) + 1, factory: chain.factory };
    _launchpadFail.set(chainKey, rec);
    if (!prev || Date.now() - (prev.loggedAt || 0) > LAUNCHPAD_LOG_EVERY_MS) {
      rec.loggedAt = Date.now();
      console.error(`[launchpad] ${chainKey}: curveOf() failed on factory ${chain.factory} (${rec.count} time(s)) — ${rec.err}`);
      console.error(`[launchpad] every ${chainKey} token now routes to the DEX as if graduated. If this persists, the factory address is wrong for this chain: node scripts/robinhood-preflight.js`);
    } else { rec.loggedAt = prev.loggedAt; }
    return hit ? hit.curve : '';   // an RPC blip must not read as "no curve"
  }
}
async function isGraduated(curveAddr, chainKey) {
  const k = _ckey(chainKey, curveAddr);
  if (_gradCache.has(k)) return true;   // a graduated token never un-graduates
  try {
    const g = await new ethers.Contract(curveAddr, CURVE_ABI, providerFor(chainKey)).graduated();
    if (g) _gradCache.add(k);
    return g;
  } catch (_) { return false; }
}
async function tokenDecimals(ca, chainKey) {
  const hit = _metaCache.get(_ckey(chainKey, ca)); if (hit) return hit.decimals;
  try { return Number(await new ethers.Contract(ca, ERC20_ABI, providerFor(chainKey)).decimals()); } catch (_) { return 18; }
}
/**
 * Decimals, or NULL when the read failed.
 *
 * ⚠️ `tokenDecimals` answers 18 for a read that did not happen, which is right
 * for a display path — a wrong exponent on a card is a wrong-looking number and
 * nothing more. It is wrong wherever the exponent scales a value the engine
 * then ACTS on: on a 6-decimal token that guess is off by 10^12, and a gate fed
 * it refuses with "the curve disagrees with the market" — a confident wrong
 * diagnosis pointing at the token instead of at our own failed RPC.
 *
 * The Solana side already had to learn this (`solana.splDecimalsOrNull`); the
 * EVM side had no such reader until the curve route needed one.
 */
async function tokenDecimalsOrNull(ca, chainKey) {
  const hit = _metaCache.get(_ckey(chainKey, ca));
  if (hit && Number.isFinite(Number(hit.decimals))) return Number(hit.decimals);
  try {
    const d = Number(await new ethers.Contract(ca, ERC20_ABI, providerFor(chainKey)).decimals());
    return Number.isFinite(d) ? d : null;
  } catch (_) { return null; }
}
/** Total supply in raw units, or null. Null is "could not ask", never zero —
 *  a zero supply would divide a market cap into an infinite price. */
async function tokenSupplyRaw(ca, chainKey) {
  try {
    const ts = await new ethers.Contract(ca, ERC20_ABI, providerFor(chainKey)).totalSupply();
    const v = BigInt(ts);
    return v > 0n ? v : null;
  } catch (_) { return null; }
}
// ⚠️ A CACHE MISS IS A STAMPEDE ON THE BUY PATH. Five wallets buying one token
// call this at the same instant, and until one of them has ANSWERED the cache is
// still empty for the other four — so an uncached mint cost five identical reads
// (on Solana: five `getTokenSupply` RPC calls AND five Jupiter token-registry
// requests) into two budgets that are both metered per IP. That is a quarter of
// the burst that made a five-wallet buy fail with "Couldn't read live pricing".
//
// The in-flight map is not a second cache: it holds only a read that has not yet
// answered, and `_metaCache` — which already shares one object with every future
// caller — remains the only thing that remembers. So this changes how many
// requests are made and nothing at all about what is returned.
const _metaInflight = new Map();
async function tokenMeta(ca, chainKey) {
  const k = _ckey(chainKey, ca);
  const hit = _metaCache.get(k); if (hit) return hit;
  const joined = _metaInflight.get(k); if (joined) return joined;
  const p = _tokenMeta(ca, chainKey, k);
  _metaInflight.set(k, p);
  p.catch(() => {}).then(() => { if (_metaInflight.get(k) === p) _metaInflight.delete(k); });
  return p;
}
async function _tokenMeta(ca, chainKey, k) {
  if (isSvm(chainKey)) {
    const m = await solana.splMeta(providerFor(chainKey), ca);
    const out = { name: m.name, sym: m.sym, decimals: m.decimals };
    if (m.name && m.sym) _metaCache.set(k, out);
    return out;
  }
  const erc = new ethers.Contract(ca, ERC20_ABI, providerFor(chainKey));
  // ONE batched round trip, not two. decimals() used to be awaited AFTER
  // name()/symbol() had resolved, so every uncached token cost two serial calls
  // — and this runs on the buy path, after the fill, while the user waits.
  const [n, s, d] = await Promise.all([
    erc.name().catch(() => null), erc.symbol().catch(() => null), erc.decimals().catch(() => null),
  ]);
  const out = { name: String(n == null ? 'Token' : n).slice(0, 40), sym: String(s == null ? 'TOKEN' : s).slice(0, 20), decimals: d == null ? 18 : Number(d) };
  if (n != null && s != null && d != null) _metaCache.set(k, out);   // complete reads only
  return out;
}
// Native balance in the chain's smallest unit (wei on EVM, lamports on Solana),
// always a BigInt. Solana lamports are 1e9 — callers format with the chain's decimals.
// The native reserved for gas, in wei. L1 Ethereum gas dwarfs the L2 default, so
// it reserves far more — and that difference is exactly what made the sniper
// spam. watchers.js pre-checked a user's balance against CFG.gasBufferEth
// (0.0004) while buy() demanded ETH_GAS_BUFFER (0.006): a wallet holding
// 0.01499 passed the cheap check, entered buy(), and threw "insufficient ETH —
// need ~0.016, have 0.01499" on EVERY new Ethereum pair, for ever. Two checks
// of the same thing must read one number.
function gasBufferWei(chainKey) {
  return ethers.parseEther(
    chainKey === 'ethereum' ? (process.env.ETH_GAS_BUFFER || '0.006') : CFG.gasBufferEth,
  );
}

async function ethBalance(addr, chainKey) {
  const v = await ethBalanceOrNull(addr, chainKey);
  return v == null ? 0n : v;
}
/**
 * The native balance, or NULL when it could not be read.
 *
 * `ethBalance` answers 0n for a dead RPC and an empty wallet alike, and every
 * screen that decides something on the answer needs those apart — the wallet
 * dashboard prints "couldn't read it just now", the sweep picker prints `?`, and
 * the removal guard must not offer a one-tap ✅ Remove over a balance nobody
 * read. Same contract as `tokenBalanceOrNull` two functions down.
 */
async function ethBalanceOrNull(addr, chainKey) {
  // ⚠️ THROUGH nativeBalances, not a private read of its own. That is where the
  // Solana host list and web3.js's 7.5s-on-a-429 retry are switched off, and a
  // second door onto the same chain would keep the old behaviour on whichever
  // screen happened to use it — which is exactly how the removal guard and the
  // dashboard came to disagree about a wallet holding 2.15 SOL.
  if (isSvm(chainKey)) return (await nativeBalances(chainKey, [addr])).bals[0];
  try { return await providerFor(chainKey).getBalance(addr); } catch (_) { return null; }
}
/**
 * The native balance of MANY addresses on one chain — the one owner of a
 * per-chain COLUMN, which is the shape every screen that lists wallets reads.
 *
 * ⚠️ ON SOLANA THIS IS ONE REQUEST, AND THAT IS THE WHOLE POINT. The wallet
 * dashboard reads wallets × chains concurrently, so five wallets used to put
 * five separate `getBalance` calls on the public Solana endpoint in the same
 * millisecond — and it answers a burst with 429s, which web3.js retries past
 * the screen's 2.5s bound. Every wallet then rendered "Couldn't reach Solana"
 * while every EVM chain answered: `getSignatureStatuses`' lesson
 * ("five wallets were throttling each other"), never applied to the balance.
 *
 * EVM keeps one request per address — that is what the JSON-RPC offers, those
 * endpoints are not the ones refusing us, and ethers already batches on the
 * chains where `batchMaxCount` allows it.
 *
 * Returns `{ bals, why }`: a null cell is "we could not read THIS one", and
 * `why` is the upstream's own reason rather than another silent null. "Never
 * discard the reason", on the read that had been discarding it longest.
 */
async function nativeBalances(chainKey, addrs) {
  const list = Array.isArray(addrs) ? addrs : [addrs];
  if (isSvm(chainKey)) {
    const r = await solana.solBalancesX(providerFor(chainKey), list, {
      conns: solana.readConnections(chains.chainOf(chainKey) && chains.chainOf(chainKey).rpc),
    });
    return { bals: r.bals, why: r.ok ? null : r.why };
  }
  const p = providerFor(chainKey);
  let why = null;
  const bals = await Promise.all(list.map(async (a) => {
    try { return await p.getBalance(a); }
    catch (e) { if (!why) why = String((e && e.message) || e).slice(0, 160); return null; }
  }));
  return { bals, why };
}
// Raw token balance (BigInt) held by `addr`. On Solana `ca` is an SPL mint and `addr`
// the owner; splBalance sums the owner's token accounts. Raw units — decimals differ
// per mint (6 or 9), so callers pair this with tokenDecimals/splBalance().decimals.
async function tokenBalance(ca, addr, chainKey) {
  if (isSvm(chainKey)) { const { raw } = await solana.splBalance(providerFor(chainKey), addr, ca); return raw; }
  try { return await new ethers.Contract(ca, ERC20_ABI, providerFor(chainKey)).balanceOf(addr); } catch (_) { return 0n; }
}
/** Same read, but a FAILURE is distinguishable from a genuine zero.
 *
 *  tokenBalance() collapses both to 0n, which is fine for a display but wrong
 *  wherever the answer decides something: the live monitor read a failed RPC as
 *  "position closed", unpinned itself and stopped forever, one blip after a buy
 *  that had actually filled. Callers that ACT on the number must use this. */
async function tokenBalanceOrNull(ca, addr, chainKey) {
  try {
    // splBalance() swallows its own errors and answers 0n, so on Solana this
    // function could never do the one thing it exists for — the monitor read a
    // dead RPC as "position closed" and unpinned itself on a live bag.
    if (isSvm(chainKey)) return await solana.splBalanceOrNull(providerFor(chainKey), addr, ca);
    return await new ethers.Contract(ca, ERC20_ABI, providerFor(chainKey)).balanceOf(addr);
  } catch (_) { return null; }
}
// Total supply in UI units, cached — a holding is only a statement once the
// reader knows what SHARE of the token it is ("harus ada berapa % dari
// supply"). Returns null when it cannot be read: an unknown supply must never
// render as "0% of supply", and on an EVM chain with unknown decimals a
// guessed 18 would print a share off by orders of magnitude — worse than none.
const _supplyCache = new Map();   // chain:ca → { v, ts }
const SUPPLY_TTL_MS = 10 * 60 * 1000;
async function tokenSupplyUi(ca, chainKey, dec) {
  const key = `${chainKey}:${ca}`;
  const hit = _supplyCache.get(key);
  if (hit && Date.now() - hit.ts < SUPPLY_TTL_MS) return hit.v;
  // ⚠️ An EVM call that does not KNOW the decimals never asked the chain, so
  // its null is not an answer — caching it would poison the entry for ten
  // minutes and blank the share on every later caller that does know them.
  // (The receipt can race the meta read; the monitor always has `dec`.)
  if (!isSvm(chainKey) && !Number.isFinite(dec)) return null;
  let v = null;
  try {
    if (isSvm(chainKey)) {
      const s = await providerFor(chainKey).getTokenSupply(new (require('@solana/web3.js').PublicKey)(ca));
      v = s.value.uiAmount != null ? Number(s.value.uiAmount) : Number(s.value.amount) / 10 ** s.value.decimals;
    } else if (Number.isFinite(dec)) {
      const raw = await new ethers.Contract(ca, ERC20_ABI, providerFor(chainKey)).totalSupply();
      v = Number(ethers.formatUnits(raw, dec));
    }
  } catch (_) { v = null; }
  if (!(v > 0)) v = null;
  if (_supplyCache.size >= 500) _supplyCache.delete(_supplyCache.keys().next().value);
  _supplyCache.set(key, { v, ts: Date.now() });
  return v;
}
// Maestro-style: this token's balance (+ native) across EVERY one of the user's
// wallets, read LIVE on-chain (so tokens acquired outside the bot — e.g. a token
// you launched on the site — still show up). Best-effort: a failed read is 0, never
// throws. Returns rows in wallet order + `holderId` = the wallet holding the MOST of
// this token (used to auto-bind the card to the wallet that can actually sell it).
async function tokenAcrossWallets(chatId, ca, chainKey, decimals) {
  const u = getUser(chatId); if (!u) return { rows: [], holderId: null, supply: 0n };
  chainKey = chainKey || userChain(u);
  const svm = isSvm(chainKey);
  const nativeDec = svm ? 9 : 18;                          // lamports vs wei
  let dec = Number.isFinite(decimals) ? decimals : (svm ? 9 : 18);
  let supply = 0n;
  if (svm) {
    try { const s = await providerFor(chainKey).getTokenSupply(new (require('@solana/web3.js').PublicKey)(ca)); supply = BigInt(s.value.amount); dec = s.value.decimals; } catch (_) {}
  } else {
    try { supply = await new ethers.Contract(ca, ERC20_ABI, providerFor(chainKey)).totalSupply(); } catch (_) {}
  }
  const list = walletList(u);
  const rows = await Promise.all(list.map(async (w, i) => {
    const addr = walletAddress(w, chainKey);
    const [tb, eb] = await Promise.all([tokenBalance(ca, addr, chainKey), ethBalance(addr, chainKey)]);
    const pct = supply > 0n ? (Number(tb) / Number(supply)) * 100 : 0;   // ratio only — display precision is fine
    return { id: w.id, index: i + 1, label: walletLabel(w, i + 1), address: addr, active: w.id === u.activeWalletId, raw: tb, tokens: Number(ethers.formatUnits(tb, dec)), pctSupply: pct, eth: Number(ethers.formatUnits(eb, nativeDec)) };
  }));
  let holderId = null, max = 0n;
  for (const r of rows) { if (r.raw > max) { max = r.raw; holderId = r.id; } }
  return { rows, holderId, supply };
}
// Native price in USD, cached per symbol. This is an off-box HTTP call with a 6s
// timeout that every trade report, every Solana snapshot and every card render
// hit fresh — and a spot price does not move enough in 30s to be worth waiting
// on Coinbase for. A stale-but-good value also beats returning 0 (which renders
// as "—") when the API is briefly unreachable.
const _usdCache = new Map();   // sym → { px, ts }
const USD_CACHE_MS = Math.max(0, Number(process.env.USD_CACHE_MS || 30000));
/** This token's balance on EVERY one of the user's wallets, read together.
 *
 *  Deliberately NOT tokenAcrossWallets: that one is for the card, so it also
 *  pulls total supply and each wallet's native balance, and it reads through
 *  tokenBalance() — which collapses a FAILED read to 0n. The live monitor closes
 *  a position on a zero, so a flaky RPC reading as zero would unpin a card over a
 *  bag the user still holds. Here `raw` is null when that wallet's read failed,
 *  and only a real zero is a zero. */
async function tokenBalancesAcross(chatId, ca, chainKey) {
  const u = getUser(chatId); if (!u) return [];
  chainKey = chainKey || userChain(u);
  const list = walletList(u);
  return Promise.all(list.map(async (w, i) => ({
    id: w.id,
    index: i + 1,
    label: walletLabel(w, i + 1),
    raw: await tokenBalanceOrNull(ca, walletAddress(w, chainKey), chainKey),
  })));
}
async function ethUsd(chainKey) {
  // Price the chain's native in USD: BNB, SOL, or ETH (default). Coinbase has spot for all.
  const nat = (chainOf(chainKey) || {}).native;
  const sym = nat === 'BNB' ? 'BNB' : nat === 'SOL' ? 'SOL' : 'ETH';
  const hit = _usdCache.get(sym);
  if (hit && Date.now() - hit.ts < USD_CACHE_MS) return hit.px;
  try {
    const r = await fetch(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`, { signal: AbortSignal.timeout(6000) });
    const j = await r.json(); const p = Number(j?.data?.amount);
    if (p > 0) { _usdCache.set(sym, { px: p, ts: Date.now() }); return p; }
    return hit ? hit.px : 0;
  } catch (_) { return hit ? hit.px : 0; }
}
// ------------------------------------------------- venues we cannot route through
// DexScreener indexes markets this bot has no way to FIND on-chain, and Uniswap
// v4 is the one that matters: every v4 pool lives inside a single PoolManager
// singleton, keyed by a hash of the PoolKey, so there is no pair contract for a
// factory getPair/getPool call to return. bestDexVenue therefore comes back
// empty, tokenSnapshot returns null, and the card says "couldn't price it" about
// a token that is trading perfectly well.
//
// This is a PRICE source, never a routing one: everything it returns is marked
// routable:false, and the buy path refuses those. Quoting a price the engine
// cannot actually fill is the one failure mode worse than saying "not supported".
// robinhood joined when DexScreener added the chain (~July 2026) — before
// that, a robinhood pair in a DS response was impossible and the missing key
// was correct. Display/enrichment only, same as every entry here.
const DS_CHAIN_KEY = { ethereum: 'ethereum', base: 'base', bsc: 'bsc', arbitrum: 'arbitrum', solana: 'solana', robinhood: 'robinhood' };
const DS_TO_CHAIN = Object.fromEntries(Object.entries(DS_CHAIN_KEY).map(([k, v]) => [v, k]));
const _dsCache = new Map();   // caLower → { at, pairs }
const DS_TTL_MS = 30000;
const DS_CACHE_MAX = 500;

/** Every DexScreener pair for a token, across all chains. [] on any failure —
 *  this is an enrichment, and a dead indexer must never break a trade screen. */
async function dsPairsX(ca) {
  const key = String(ca).toLowerCase();
  const hit = _dsCache.get(key);
  if (hit && Date.now() - hit.at < DS_TTL_MS) return hit;
  let pairs = [], ok = false;
  try {
    // LOWERCASED. An EVM address is case-insensitive but its EIP-55 checksum
    // form is not the string these indexes are keyed on, and a paste from a
    // block explorer is always the checksummed one.
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${_idQ(ca)}`, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } });
    // `ok` is whether the INDEX ANSWERED, kept apart from whether it had
    // anything. A 429 and "this token has no market" both used to arrive as an
    // empty array, and the card then told the user, flatly, that the token
    // trades nowhere — about a token it had priced twenty minutes earlier.
    ok = r.ok;
    if (r.ok) { const j = await r.json(); pairs = Array.isArray(j && j.pairs) ? j.pairs : []; }
  } catch (_) { ok = false; }
  const rec = { at: Date.now(), pairs, ok };
  if (_dsCache.size >= DS_CACHE_MAX) _dsCache.delete(_dsCache.keys().next().value);
  // Only a real answer is cached. Caching a throttled miss for 30s would spread
  // one rate-limited second across every paste in the next half minute.
  if (ok) _dsCache.set(key, rec);
  return rec;
}
const dsPairs = async (ca) => (await dsPairsX(ca)).pairs;

/**
 * The token's own artwork, for the PnL card.
 *
 * DexScreener carries it on the pair (`info.imageUrl`) and GeckoTerminal on the
 * token — the same two indexes the rest of this file already asks, so no new
 * upstream and no new failure mode. Best-effort by design: a card with a
 * monogram where the logo would be is a card; a card that waited on an image
 * host is not.
 *
 * Cached per contract INCLUDING the misses (as null), because the common case
 * for a fresh launch is that no index has art for it yet and re-asking on every
 * render would spend a round trip to learn that again.
 */
const _logoCache = new Map();
const LOGO_TTL_MS = 6 * 3600 * 1000;
async function tokenLogoUrl(ca, chainKey) {
  const key = (isSvm(chainKey) ? String(ca) : String(ca).toLowerCase()) + '@' + chainKey;
  const hit = _logoCache.get(key);
  if (hit && Date.now() - hit.at < LOGO_TTL_MS) return hit.url;
  let url = null;
  try {
    const slug = DS_CHAIN_KEY[chainKey];   // the map this file already keeps — a second copy would drift
    if (slug) {
      const pairs = (await dsPairsX(ca)).pairs.filter((p) => p && p.chainId === slug);
      for (const p of pairs) {
        const u = p.info && p.info.imageUrl;
        if (u && /^https?:\/\//.test(u)) { url = u; break; }
      }
    }
    if (!url) {
      // GeckoTerminal covers what DexScreener does not — Robinhood Chain, and
      // a token whose only pool is too new for DS to carry art for.
      const net = GT_NETWORK_LOGO[chainKey];
      if (net) {
        const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/tokens/${_idQ(ca)}`, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
        if (r.ok) {
          const j = await r.json();
          const u = j && j.data && j.data.attributes && j.data.attributes.image_url;
          // GeckoTerminal answers the string "missing" rather than omitting it.
          if (u && /^https?:\/\//.test(u) && !/missing/i.test(u)) url = u;
        }
      }
    }
  } catch (_) { url = null; }
  if (_logoCache.size >= 500) _logoCache.delete(_logoCache.keys().next().value);
  _logoCache.set(key, { at: Date.now(), url });
  return url;
}
const GT_NETWORK_LOGO = { robinhood: 'robinhood', ethereum: 'eth', base: 'base', bsc: 'bsc', arbitrum: 'arbitrum_nova', solana: 'solana' };

// Solana mints are base58 and CASE-SIGNIFICANT — lowercasing one destroys it.
const _idQ = (ca) => (/^0x[a-fA-F0-9]{40}$/.test(String(ca)) ? String(ca).toLowerCase() : String(ca));

// GeckoTerminal, the SECOND opinion. Not redundancy for its own sake: one
// indexer is a single point of failure the operator cannot see past — DexScreener
// rate-limits datacenter IPs, and when it returns nothing there is no way to tell
// "this token has no market" from "this VPS is being throttled". GT also names
// the venue precisely ("uniswap-v4"), where DexScreener splits it across dexId
// and a label.
const GT_NET = { ethereum: 'eth', base: 'base', bsc: 'bsc', arbitrum: 'arbitrum', solana: 'solana', robinhood: 'robinhood' };
const _gtCache = new Map();   // `${chainKey}:${caLower}` → { at, m }

async function gtMarketX(ca, chainKey) {
  const net = GT_NET[chainKey];
  if (!net) return { m: null, ok: true };   // a chain GT does not cover — an answered 'no', not a failure
  const key = chainKey + ':' + String(ca).toLowerCase();
  const hit = _gtCache.get(key);
  if (hit && Date.now() - hit.at < DS_TTL_MS) return hit;
  let m = null, ok = false;
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/tokens/${_idQ(ca)}/pools?page=1`, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } });
    ok = r.ok;
    if (r.ok) {
      const j = await r.json();
      const pools = Array.isArray(j && j.data) ? j.data : [];
      const best = pools
        .filter((p) => p && p.attributes && Number(p.attributes.base_token_price_usd) > 0)
        .sort((a, b) => Number(b.attributes.reserve_in_usd || 0) - Number(a.attributes.reserve_in_usd || 0))[0];
      if (best) {
        const a = best.attributes;
        const dex = ((best.relationships && best.relationships.dex && best.relationships.dex.data) || {}).id || '';
        m = {
          priceUsd: Number(a.base_token_price_usd),
          mcapUsd: Number(a.market_cap_usd || a.fdv_usd || 0) || 0,
          liqUsd: Number(a.reserve_in_usd || 0) || 0,
          volH24Usd: (a.volume_usd && a.volume_usd.h24 != null) ? Number(a.volume_usd.h24) : null,
          dexId: String(dex), labels: [], name: '', sym: String(a.name || '').split('/')[0].trim(),
        };
      }
    }
  } catch (_) { ok = false; }
  const rec = { at: Date.now(), m, ok };
  if (_gtCache.size >= DS_CACHE_MAX) _gtCache.delete(_gtCache.keys().next().value);
  if (ok) _gtCache.set(key, rec);
  return rec;
}
const gtMarket = async (ca, chainKey) => (await gtMarketX(ca, chainKey)).m;

const _dsLiq = (p) => Number((p && p.liquidity && p.liquidity.usd) || 0);

/** The deepest indexed market for `ca` on `chainKey`, or null. */
async function dsMarket(ca, chainKey) {
  const slug = DS_CHAIN_KEY[chainKey];
  if (!slug) return null;   // a chain DexScreener does not index (Robinhood) — GeckoTerminal covers those elsewhere
  const pairs = (await dsPairs(ca)).filter((p) => p && p.chainId === slug && Number(p.priceUsd) > 0);
  if (!pairs.length) return null;
  const p = pairs.sort((a, b) => _dsLiq(b) - _dsLiq(a))[0];
  return {
    priceUsd: Number(p.priceUsd),
    mcapUsd: Number(p.marketCap || p.fdv || 0) || 0,
    liqUsd: _dsLiq(p),
    volH24Usd: (p.volume && p.volume.h24 != null) ? Number(p.volume.h24) : null,
    dexId: String(p.dexId || ''),
    labels: Array.isArray(p.labels) ? p.labels : [],
    name: (p.baseToken && p.baseToken.name) || '',
    sym: (p.baseToken && p.baseToken.symbol) || '',
  };
}

/** Enabled chain keys where `ca` actually TRADES, deepest market first.
 *  Used by chain auto-detect: a chain the token merely has bytecode on is a much
 *  weaker signal than one where somebody is buying it. */
async function dsChainsOf(ca) {
  const enabled = new Set(chains.enabledChains().map((c) => c.key));
  const byChain = new Map();
  for (const p of await dsPairs(ca)) {
    const key = DS_TO_CHAIN[p && p.chainId];
    if (!key || !enabled.has(key) || !(Number(p.priceUsd) > 0)) continue;
    byChain.set(key, Math.max(byChain.get(key) || 0, _dsLiq(p)));
  }
  return [...byChain.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

// A market label an operator will recognise. DexScreener's dexId for Uniswap v4
// is "uniswap" with a "v4" label, so the version has to be glued back on or the
// card claims plain "uniswap" for a venue the router cannot reach. GeckoTerminal
// gives it whole ("uniswap-v4"), hyphen and all.
function dsVenueLabel(m) {
  if (!m) return 'an indexed DEX';
  const dex = String(m.dexId || 'dex').replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  const ver = (m.labels || []).find((l) => /^v\d/i.test(String(l)));
  return ver ? `${dex} ${String(ver).toLowerCase()}` : dex;
}

/** The best market for `ca` on `chainKey` from EITHER indexer. */
async function marketOf(ca, chainKey) {
  const ds = await dsMarket(ca, chainKey).catch(() => null);
  if (ds) return ds;
  return gtMarket(ca, chainKey).catch(() => null);
}

/**
 * Which enabled chains this token trades on, and what was actually consulted.
 *
 * The `checked` list is the point. "Couldn't price it" told the user nothing
 * they could act on and told the operator nothing they could debug — a token on
 * a chain whose RPC was throttled looked identical to one that does not exist.
 * The failure card prints this, so a screenshot IS the diagnosis.
 */
async function marketProbe(ca, preferChain) {
  const enabled = chains.enabledChains().map((c) => c.key);
  const ds = await dsPairsX(ca).catch(() => ({ pairs: [], ok: false }));
  const dsHits = _chainsFromPairs(ds.pairs, new Set(enabled));
  if (dsHits.length) return { chains: dsHits, checked: enabled, source: 'dexscreener', degraded: false };
  // DexScreener had nothing — which is ALSO what a throttled request looks like.
  // Ask GeckoTerminal, but SEQUENTIALLY and starting with the chain the user is
  // on. The first cut fired one request per enabled chain in parallel on every
  // paste; six bursts a minute is how a free index starts answering 429, and a
  // 429 read as "no market" is what made a token that priced fine at 19:50 read
  // as nonexistent at 21:12.
  const order = preferChain && enabled.includes(preferChain)
    ? [preferChain, ...enabled.filter((k) => k !== preferChain)]
    : enabled;
  let gtOk = false;
  for (const k of order) {
    const r = await gtMarketX(ca, k).catch(() => ({ m: null, ok: false }));
    gtOk = gtOk || r.ok;
    if (r.m) return { chains: [k], checked: enabled, source: 'geckoterminal', degraded: false };
  }
  // Nothing found. Whether that means "no market" or "nobody answered" is the
  // difference between a fact and a guess, and the card says which.
  return { chains: [], checked: enabled, source: 'none', degraded: !ds.ok && !gtOk };
}

/** Enabled chains present in a DexScreener pair list, deepest market first. */
function _chainsFromPairs(pairs, enabled) {
  const byChain = new Map();
  for (const p of pairs || []) {
    const key = DS_TO_CHAIN[p && p.chainId];
    if (!key || !enabled.has(key) || !(Number(p.priceUsd) > 0)) continue;
    byChain.set(key, Math.max(byChain.get(key) || 0, _dsLiq(p)));
  }
  return [...byChain.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

/**
 * Can the engine actually FILL a swap for this mint right now?
 *
 * Asked only on the path where a token has a launchpad price and no indexed
 * pool — i.e. it is still on a bonding curve. The aggregator does route most
 * curves, so the answer is usually yes and the user gets a Buy button they
 * would otherwise not have been offered; when it is no, the card says so
 * instead of quoting a price nothing can honour.
 *
 * A QUOTE IS NOT A TRADE: this prices 0.01 SOL and signs nothing. Wide
 * slippage because the question is "does a route exist", not "at what price" —
 * a thin curve rejecting a 1% bound would read as "no route" and hide a Buy
 * button that would have worked. Any failure is a no; this must never throw
 * into the card.
 */
const SOL_ROUTE_PROBE_LAMPORTS = 10000000n;   // 0.01 SOL — priced, never sent
async function _solRoutable(mint) {
  try {
    const q = await solana.getQuote({ inputMint: solana.WSOL_MINT, outputMint: mint, amountRaw: SOL_ROUTE_PROBE_LAMPORTS, slippageBps: 500 });
    return !!(q && q.outAmount > 0n);
  } catch (_) { return false; }
}

/**
 * Can a swap for `ca` actually be FILLED on `chainKey` right now?
 *
 * The single owner of that question, because three callers were about to grow
 * three private answers to it — and "there is a price" is not the same question,
 * which is the distinction v4.js already draws between `price()` and
 * `canSwapLive()`. A snipe that fires on a price it cannot fill spends gas to
 * revert; one that waits for a fill it could already make arrives late.
 *
 * Deliberately CHEAP, because the CA-snipe polls this on a timer for every armed
 * target. In order of cost:
 *   • Solana  — one aggregator quote (the only thing that can answer there).
 *   • curve   — a launchpad curve exists ⇒ the launchpad will fill it.
 *   • V2/V3   — a pool with a non-zero native reserve. `bestDexVenue` caches for
 *               ten minutes on a HIT; a miss is re-read, which is what a snipe
 *               needs.
 *   • v4      — no pair contract exists to look up, so this is the only way to
 *               see one. Last, and cached per chain by v4.js itself.
 *
 * Never throws: a probe that can throw is a watcher that can die.
 */
// ---------------------------------------------- the DISCOVERED launchpad curve
/*
 * A token still on a bonding curve has no AMM pool, so `bestDexVenue` finds
 * nothing and the buy used to end at "which Dexvra can't route through yet".
 * `curveIface` reads the pad's buy/sell interface off REAL trades on the chain,
 * `curveRoute` builds our own call and refuses anything it cannot explain, and
 * `curvePrice` supplies the independent number that check is made against.
 *
 * ⚠️ IT SHIPS ON, and that CHANGES an existing install's behaviour on deploy —
 * deliberately, the way the trending floors did. `CURVE_ROUTE=0` is the kill
 * switch. What it does NOT change is the refusal: every gate still refuses to
 * SIGN rather than declaring a verdict on the token, and a refusal is always
 * cheaper than a wrong fill.
 */
const CURVE_ROUTE_ON = !/^(0|false|off|no)$/i.test(String(process.env.CURVE_ROUTE ?? '').trim());
/*
 * ⚠️ DISCOVERY HAPPENS INSIDE `withWalletLock`, so it needs a ceiling.
 *
 * Reading an interface is up to a dozen serial `getTransaction` calls plus a
 * stepped `getLogs` walk, and ethers' own request timeout is 300s. Every queued
 * operation for that wallet waits behind it — a triggered stop-loss, an
 * auto-protect rescue, a copy-exit leg. A bounded refusal is a shrug; an
 * unbounded one holds the exit.
 */
const CURVE_DISCOVER_MS = Math.max(1000, Number(process.env.CURVE_DISCOVER_MS || 12000));
/** A gas limit, not a verdict: the estimate is padded, floored so a buy that
 *  fills the curve and triggers graduation (which seeds a pool, and costs
 *  millions) is not sent out-of-gas, and capped so a wild estimate cannot make
 *  the node refuse the transaction for want of balance. */
const _curveGas = (est) => {
  const padded = est > 0n ? est + est / 4n : 0n;
  const floor = 900000n, ceil = 3000000n;
  const g = padded > floor ? padded : floor;
  return g > ceil ? ceil : g;
};

/*
 * DISCOVERY SEED HASHES — see curveTrade's `_receiptLogs` header for why the
 * window ladder alone is structurally blind to a quiet token's trades on a
 * range-capped node. The pool asked about is the indexer's own pair for this
 * token, which for an indexed curve token IS the curve contract. Hashes are
 * pointers only: everything decoded is read back from the chain's receipts,
 * so a wrong hash contributes nothing. [] on any failure — the ladder still
 * runs without it.
 *
 * TWO SOURCES, the chain's first:
 *   1. The curve's OWN Transfer legs, topic-filtered. The node that silently
 *      empties a wide ADDRESS-filtered `getLogs` has answered wide
 *      TOPIC-filtered asks on this same box — it is how the preflight found
 *      the real Pons factory when both researched guesses were wrong. The
 *      filter carries no address on purpose: adding one is what re-triggers
 *      the cap, and a foreign token's log in the answer costs nothing — only
 *      the HASH travels, and the receipts are filtered to OUR token.
 *   2. GeckoTerminal's trade list for the pool, where GT carries it.
 */
const CURVE_SEED_MAX = 12;
const CURVE_SEED_SPAN = Math.max(10_000, Number(process.env.CURVE_SEED_SPAN || 400_000));

/** The pool/curve address the INDEXER names for this token — DS pair first
 *  (for an indexed curve token the pair IS the curve contract), GT's deepest
 *  pool second. null when nobody names one. */
async function _curvePoolOf(chainKey, ca) {
  try {
    let pool = null;
    const slug = DS_CHAIN_KEY[chainKey];
    if (slug) {
      const pairs = (await dsPairsX(ca)).pairs.filter((p) => p && p.chainId === slug && p.pairAddress);
      const best = pairs.sort((a, b) => _dsLiq(b) - _dsLiq(a))[0];
      if (best) pool = best.pairAddress;
    }
    const net = GT_NET[chainKey];
    if (!pool && net) {
      const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/tokens/${_idQ(ca)}/pools?page=1`, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } });
      if (r.ok) {
        const j = await r.json();
        const best = (Array.isArray(j && j.data) ? j.data : [])
          .sort((a, b) => Number(((b || {}).attributes || {}).reserve_in_usd || 0) - Number(((a || {}).attributes || {}).reserve_in_usd || 0))[0];
        if (best && best.attributes && best.attributes.address) pool = best.attributes.address;
      }
    }
    return pool && /^0x[a-fA-F0-9]{40}$/.test(String(pool)) ? String(pool) : null;
  } catch (_) { return null; }
}

/*
 * SIBLINGS ON THE SAME PAD — so the bot TEACHES ITSELF.
 *
 * The learned-shape transfer needs one token on the pad whose interface was
 * read. Making that a manual step ("paste a traded token first") is the
 * "apt-get install is not a fix, it is a request" defect, on the feature the
 * operator has already asked for four times: it reads as the route still not
 * working, because from Telegram it IS.
 *
 * The indexer that prices our token also lists the pad's OTHER pools, and a
 * busy one has the trade history a fresh launch lacks. Each candidate is
 * checked by BYTECODE before anything is learned from it, so a sibling from a
 * different pad — or a wrong list — teaches nothing.
 */
const CURVE_SIBLINGS = Math.max(0, Number(process.env.CURVE_SIBLINGS || 6));
const _sibCache = new Map();   // `${chainKey}:${dexId}` → { at, list }
const SIB_TTL_MS = 10 * 60_000;
async function _curveSiblingsOf(chainKey, dexId) {
  const net = GT_NET[chainKey];
  const dex = String(dexId || '').trim();
  if (!net || !dex || !CURVE_SIBLINGS) return [];
  const key = `${chainKey}:${dex}`;
  const hit = _sibCache.get(key);
  if (hit && Date.now() - hit.at < SIB_TTL_MS) return hit.list;
  let list = [];
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/dexes/${encodeURIComponent(dex)}/pools?page=1`, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (r.ok) {
      const j = await r.json();
      for (const p of (Array.isArray(j && j.data) ? j.data : [])) {
        const pool = p && p.attributes && p.attributes.address;
        // GT ids are "<net>_<address>" — the base token of the pool is the
        // launched token, which is what a sibling's interface is read from.
        const bid = p && p.relationships && p.relationships.base_token && p.relationships.base_token.data && p.relationships.base_token.data.id;
        const token = typeof bid === 'string' ? bid.split('_').slice(1).join('_') : null;
        if (/^0x[a-fA-F0-9]{40}$/.test(String(pool || '')) && /^0x[a-fA-F0-9]{40}$/.test(String(token || ''))) {
          list.push({ pool: String(pool), token: String(token) });
        }
        if (list.length >= CURVE_SIBLINGS) break;
      }
    }
  } catch (_) { list = []; }
  _sibCache.set(key, { at: Date.now(), list });
  return list;
}

/*
 * SIBLINGS FROM THE CHAIN — the source that cannot be missing.
 *
 * The first cut asked GeckoTerminal for the pad's other pools, and on the one
 * chain this feature is for GT need not carry the pad at all: the card came
 * back saying "no trades found … nothing to read its interface from yet", i.e.
 * nothing had taught the pad and nothing could. Meanwhile the bot's own snipe
 * loop had already SEEN 227 Pons launches — from the factory's announcements,
 * on this node, topic-filtered (the ask shape this RPC serves).
 *
 * ⚠️ AND THE EVENT'S ABI IS UNKNOWN, so which word is the token and which is
 * the pool cannot be decoded — 1050 candidate spellings were hashed against
 * that topic0 and none matched. It does not need to be: BYTECODE IDENTITY does
 * the identification. Every address a launch log NAMES is a candidate, and the
 * ones whose deployed code hashes equal OUR curve's code are sibling curves by
 * construction.
 *
 * ⚠️ THE CODE COMPARISON HERE IS A COST FILTER, NOT THE SAFETY BOUNDARY — and
 * saying so is the point, because it reads like the boundary. Mutation-testing
 * proved it: dropping it changes no outcome, since a shape is recorded under
 * the code hash of the curve it was READ from and `curveTrade._shapeFor` looks
 * it up under OURS. A foreign candidate therefore teaches nothing whatever
 * this filter does; what it saves is the legs-and-receipts read on contracts
 * that could never have taught us. The boundary is `_shapeFor`, and it carries
 * its own test.
 */
const CURVE_SIB_SPAN = Math.max(10_000, Number(process.env.CURVE_SIB_SPAN || 400_000));
const CURVE_SIB_CANDIDATES = Math.max(1, Number(process.env.CURVE_SIB_CANDIDATES || 14));
const _codeHash = async (prov, addr) => {
  try {
    const c = await prov.getCode(addr);
    return c && c !== '0x' ? ethers.keccak256(c) : null;
  } catch (_) { return null; }
};
/** Every address a log names — indexed topics plus data words shaped like a
 *  left-padded address. Order-independent, because a layout guess is exactly
 *  what an unknown ABI forbids. */
function _namedAddrs(log) {
  const out = [];
  const add = (w) => {
    if (typeof w !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(w)) return;
    const a = '0x' + w.slice(26).toLowerCase();
    if (!/^0x0+$/.test(a) && !out.includes(a)) out.push(a);
  };
  for (const t of (log.topics || []).slice(1)) add(t);
  const data = String(log.data || '0x').slice(2);
  for (let i = 0; i + 64 <= data.length; i += 64) add('0x' + data.slice(i, i + 64));
  return out;
}

/** Sibling CURVES on this pad: addresses from recent launch announcements whose
 *  deployed bytecode is identical to `ourCurve`'s. */
async function _chainSiblingCurves(chainKey, ourCurve) {
  const anns = padFactory.announcersFor(chainKey);
  if (!anns.length) return [];
  const prov = providerFor(chainKey);
  const want = await _codeHash(prov, ourCurve);
  if (!want) return [];
  const head = Number(await prov.getBlockNumber());
  const seen = [];
  for (const a of anns) {
    for (const f of a.factories) {
      // Topic-filtered AND address-filtered on the factory: a factory is one
      // address, so this is the narrow ask the node serves happily — it is the
      // same read the snipe loop already makes every few seconds.
      const w = await curveSteppedLogs(prov, { address: f, topics: [a.topic0] },
        { head, span: CURVE_SIB_SPAN, want: CURVE_SIB_CANDIDATES });
      for (const lg of (w.logs || [])) {   // the walk runs newest-first already
        for (const addr of _namedAddrs(lg)) if (!seen.includes(addr)) seen.push(addr);
        if (seen.length >= CURVE_SIB_CANDIDATES) break;
      }
      if (seen.length >= CURVE_SIB_CANDIDATES) break;
    }
  }
  const mine = String(ourCurve).toLowerCase();
  const out = [];
  for (const addr of seen.slice(0, CURVE_SIB_CANDIDATES)) {
    if (addr === mine) continue;
    if (await _codeHash(prov, addr) === want) out.push(addr);
    if (out.length >= 3) break;   // the first with a readable history teaches; three is plenty
  }
  return out;
}

/** The token a curve trades, learned from the curve's own recent legs: the
 *  ERC-20 whose Transfer moved to or from it. Returns {token, hashes} so the
 *  caller can hand the hashes straight to the decoder — no second lookup, and
 *  no indexer involved at any point. */
async function _curveTokenAndTrades(chainKey, curve) {
  const prov = providerFor(chainKey);
  const head = Number(await prov.getBlockNumber());
  const t = '0x' + '0'.repeat(24) + String(curve).slice(2).toLowerCase();
  const [outs, ins] = await Promise.all([
    curveSteppedLogs(prov, { topics: [CURVE_TRANSFER_TOPIC, t] }, { head, span: CURVE_SEED_SPAN, want: CURVE_SEED_MAX }),
    curveSteppedLogs(prov, { topics: [CURVE_TRANSFER_TOPIC, null, t] }, { head, span: CURVE_SEED_SPAN, want: CURVE_SEED_MAX }),
  ]);
  const legs = [...(outs.logs || []), ...(ins.logs || [])]
    .filter((l) => l && l.transactionHash && /^0x[a-fA-F0-9]{40}$/.test(String(l.address || '')))
    .sort((a, b) => Number(b.blockNumber || 0) - Number(a.blockNumber || 0));
  if (!legs.length) return null;
  // The commonest token across the legs — a curve trades exactly one.
  const tally = new Map();
  for (const l of legs) {
    const k = String(l.address).toLowerCase();
    tally.set(k, (tally.get(k) || 0) + 1);
  }
  const token = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const hashes = [];
  for (const l of legs) {
    if (String(l.address).toLowerCase() !== token) continue;
    if (!hashes.includes(l.transactionHash)) hashes.push(l.transactionHash);
    if (hashes.length >= CURVE_SEED_MAX) break;
  }
  return hashes.length ? { token, hashes } : null;
}

/** The pad's other tokens, for the self-teaching pass. The CHAIN first (it
 *  cannot be missing), the indexer second. Excludes `ca` itself — a token
 *  cannot teach the shape it is missing. */
async function _curveSiblings(chainKey, ca) {
  const me = String(ca).toLowerCase();
  const out = [];
  try {
    const ourCurve = await _curvePoolOf(chainKey, ca);
    if (ourCurve) {
      for (const curve of await _chainSiblingCurves(chainKey, ourCurve)) {
        const hit = await _curveTokenAndTrades(chainKey, curve).catch(() => null);
        if (hit && hit.token !== me) out.push({ token: hit.token, pool: curve, hashes: hit.hashes });
      }
    }
  } catch (_) { /* the chain source failing falls through to the indexer */ }
  const m = await marketOf(ca, chainKey).catch(() => null);
  for (const s of await _curveSiblingsOf(chainKey, m && m.dexId)) {
    if (String(s.token).toLowerCase() !== me && !out.some((x) => x.token === String(s.token).toLowerCase())) out.push(s);
  }
  return out;
}

/*
 * ⚠️ A TOKEN NO INDEXER KNOWS YET STILL HAS A CURVE — the chain announced it.
 *
 * `_curvePoolOf` asks DexScreener and GeckoTerminal, so a launch minutes old
 * that neither has indexed has no curve address at all: the card fell to
 * "❌ Couldn't price it", which is the state a launch snipe exists to act in.
 * The pad's factory names both the token and its pool in ONE log, so the launch
 * announcement that NAMES this token is the binding — every contract that log
 * names is a candidate for its curve.
 *
 * ⚠️ THE CANDIDATES ARE NOT TRUSTED, THEY ARE OFFERED. A launch log also names
 * the dex factory and the quote token, and picking wrong would aim a buy at the
 * wrong contract — so the caller tries each against `curveTrade._shapeFor`,
 * which only matches an address whose deployed BYTECODE is a learned pad
 * curve's. Filtering to logs that name our token is what keeps a matched
 * candidate OUR launch's curve rather than a sibling's.
 *
 * Only walked when the indexers gave nothing, so an ordinary indexed token
 * pays for none of it.
 */
async function _curveFromLaunchLog(chainKey, ca) {
  const anns = padFactory.announcersFor(chainKey);
  if (!anns.length) return [];
  const prov = providerFor(chainKey);
  const head = Number(await prov.getBlockNumber());
  const me = String(ca).toLowerCase();
  /*
   * ⚠️ ONE STEP AT A TIME, AND IT STOPS AT THE LAUNCH IT WAS LOOKING FOR.
   *
   * `steppedLogs`' `want` counts LOGS, and any launch matches that — what this
   * needs is the launch naming OUR token, which only the caller can recognise.
   * Handing it the whole budget made an unindexed token pay 48 SERIAL round
   * trips before the card could render, on the one screen a user stares at
   * after pasting an address. Walking a step at a time and stopping on the
   * match makes the ordinary case (a launch minutes old, near the head) one or
   * two.
   */
  const STEP = curveIfaceMod.LOG_STEP;
  for (const a of anns) {
    for (const f of a.factories) {
      const floor = Math.max(0, head - CURVE_SIB_SPAN);
      for (let to = head, steps = 0; to > floor && steps < curveIfaceMod.LOG_STEPS; to -= STEP, steps++) {
        const lo = Math.max(floor, to - STEP + 1);
        const logs = await prov.getLogs({ address: f, topics: [a.topic0], fromBlock: lo, toBlock: to }).catch(() => []);
        for (const lg of (logs || []).slice().reverse()) {   // newest launch in this step first
          const named = _namedAddrs(lg);
          if (!named.includes(me)) continue;                 // not THIS token's launch
          const others = named.filter((x) => x !== me);
          const coded = await Promise.all(others.map((x) => prov.getCode(x).catch(() => '0x')));
          const out = others.filter((_, i) => coded[i] && coded[i] !== '0x');
          if (out.length) return out;
        }
      }
    }
  }
  return [];
}

/** Every address that might be this token's curve, best first: what the
 *  indexer names, then what its launch announcement named. */
async function _curvePoolCandidates(chainKey, ca) {
  const out = [];
  const indexed = await _curvePoolOf(chainKey, ca).catch(() => null);
  if (indexed) out.push(indexed);
  if (!out.length) {
    try { for (const c of await _curveFromLaunchLog(chainKey, ca)) if (!out.includes(c)) out.push(c); }
    catch (_) { /* the chain fallback failing leaves the indexer's answer */ }
  }
  return out;
}

async function _curveTradeHashes(chainKey, ca) {
  try {
    const pool = await _curvePoolOf(chainKey, ca);
    const net = GT_NET[chainKey];
    if (!pool) return [];
    const out = [];
    const push = (h) => { if (typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h) && !out.includes(h) && out.length < CURVE_SEED_MAX) out.push(h); };

    try {
      const prov = providerFor(chainKey);
      const head = Number(await prov.getBlockNumber());
      const poolTopic = '0x' + '0'.repeat(24) + String(pool).slice(2).toLowerCase();
      // Buys pay OUT of the curve (topics[1]); sells pay INTO it (topics[2]).
      // ⚠️ STEPPED, not one wide ask: this node answers a too-wide getLogs with
      // [] rather than an error, so the wide version of this read was silently
      // empty every time — the same defect the decoder's own walk carried.
      const [outs, ins] = await Promise.all([
        curveSteppedLogs(prov, { topics: [CURVE_TRANSFER_TOPIC, poolTopic] }, { head, span: CURVE_SEED_SPAN, want: CURVE_SEED_MAX }),
        curveSteppedLogs(prov, { topics: [CURVE_TRANSFER_TOPIC, null, poolTopic] }, { head, span: CURVE_SEED_SPAN, want: CURVE_SEED_MAX }),
      ]);
      const legs = [...(outs.logs || []), ...(ins.logs || [])]
        .filter((l) => l && l.transactionHash)
        .sort((a, b) => Number(b.blockNumber || 0) - Number(a.blockNumber || 0));   // newest first, like an indexer answers
      for (const lg of legs) push(lg.transactionHash);
    } catch (_) { /* the chain source failing costs the chain source */ }

    if (out.length < 2 && net) {
      const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/pools/${_idQ(pool)}/trades`, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
      if (r.ok) {
        const j = await r.json();
        for (const t of (Array.isArray(j && j.data) ? j.data : [])) {
          push(t && t.attributes && (t.attributes.tx_hash || t.attributes.txHash));
        }
      }
    }
    return out;
  } catch (_) { return []; }
}

/** What `curvePrice` needs, wired to this module's own readers. `iface` carries
 *  the observed samples for its last-resort tier. */
const _curveDeps = (iface) => ({
  record: (chainKey, ca, opts) => launchpads.record(chainKey, ca, opts),
  nativeUsd: (chainKey) => ethUsd(chainKey),
  decimals: (ca, chainKey) => tokenDecimalsOrNull(ca, chainKey),
  // Tier 2b's source — the indexer's own cap for an indexed curve token. On a
  // box where the pad's HTTP host is unreachable and a fresh launch has no
  // fills, this is the only strong price there is.
  indexerMcapUsd: async (ca, chainKey) => {
    const m = await marketOf(ca, chainKey).catch(() => null);
    return m && Number(m.mcapUsd) > 0 ? Number(m.mcapUsd) : null;
  },
  totalSupply: (ca, chainKey) => tokenSupplyRaw(ca, chainKey),
  iface,
});

/*
 * A CURVE PRICED IN AN ERC-20, NOT IN THE NATIVE COIN.
 *
 * Robinhood's pads take the native coin; Virtuals-class pads take their own
 * token. "Any launchpad" means both, and the second needs two legs: swap into
 * what the pad charges, approve the curve for exactly that, then call it.
 *
 * ⚠️ IT IS THE EXISTING ROUTER, NOT A NEW MONEY PATH. Leg one is the same V2 or
 * V3 swap `buy()` already makes, aimed at the quote token instead of at the
 * token being bought — and the quote token is by definition one with a real
 * pool, or the pad could not price in it.
 *
 * ⚠️ AND A FAILURE BETWEEN THE LEGS LEAVES THE USER HOLDING THE QUOTE TOKEN,
 * which every caller must SAY. The v4 path already sets that precedent with
 * "Your ETH is safe as WETH in the wallet": money that moved and did not arrive
 * where the user expected is a fact they are owed immediately, not one they
 * discover in a block explorer.
 */
async function _acquireQuote(wallet, chainKey, quoteToken, spendWei, slip, gasBoost, gas, sent) {
  const chain = chainOf(chainKey);
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(quoteToken || ''))) throw new Error('this pad is priced in a token Dexvra could not read — nothing was sent');
  const before = await tokenBalance(quoteToken, wallet.address, chainKey);
  const pick = await bestDexVenue(quoteToken, chainKey);
  const v3 = pick && pick.kind === 'v3' ? v3Cfg(chainKey) : null;
  let hash;
  if (v3) {
    const expTok = await v3ExpectedOutRaw(chainKey, pick.pool, pick.feeTier, chain.weth, spendWei);
    if (expTok == null || expTok <= 0n) throw new Error(`could not price ${chain.native} → this pad's own token — nothing was sent`);
    const minTok = expTok * (10000n - slip) / 10000n;
    const ri = new ethers.Interface(V3_ROUTER_ABI);
    const data = ri.encodeFunctionData('exactInputSingle', [{ tokenIn: chain.weth, tokenOut: quoteToken, fee: pick.feeTier, recipient: wallet.address, amountIn: spendWei, amountOutMinimum: minTok, sqrtPriceLimitX96: 0n }]);
    hash = await rawSend(wallet, chainKey, v3.router, data, await v3SwapGas(chainKey, wallet.address, v3.router, data, spendWei), spendWei, gasBoost, { fee: gas });
  } else if (_v2Fillable(pick)) {
    const router = new ethers.Contract(chain.router, ROUTER_ABI, wallet);
    let expTok = 0n;
    try { const amts = await router.getAmountsOut(spendWei, [chain.weth, quoteToken]); expTok = amts[1]; }
    catch (e) { throw new Error(`could not price ${chain.native} → this pad's own token (${(e && e.shortMessage) || e.message || e}) — nothing was sent`); }
    const minTok = expTok > 0n ? expTok * (10000n - slip) / 10000n : 0n;
    if (minTok <= 0n) throw new Error(`no liquidity to buy this pad's own token with — nothing was sent`);
    const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(minTok, [chain.weth, quoteToken], wallet.address, Math.floor(Date.now() / 1000) + 600, { value: spendWei, ...gas });
    hash = tx.hash;
  } else {
    // The pad's own token has no market on this chain, which is a fact about
    // the pad rather than a failure of ours — and nothing has been spent.
    throw new Error(`this pad charges in a token there is no pool for on ${chain.name} — nothing was sent`);
  }
  if (sent) sent(hash);
  const rc = await waitHash(hash, chainKey);
  if (rc && rc.status === 0) throw new Error(`the swap into this pad's own token reverted — nothing else was sent. Tx: ${hash}`);
  const after = await tokenBalance(quoteToken, wallet.address, chainKey);
  const got = after > before ? after - before : 0n;
  // A confirmed swap that produced nothing is not a zero-sized swap. Never
  // continue on it: the second leg would be built for an amount we do not hold.
  if (got <= 0n) throw new Error(`the swap into this pad's own token confirmed but nothing arrived — check the wallet before retrying. Tx: ${hash}`);
  return { got, hash };
}

/** The reverse leg: a curve that PAYS in an ERC-20 leaves the proceeds in it,
 *  and a sell whose money is stranded in a token the user did not ask for is a
 *  sell that did not finish. Best-effort by design — the tokens are already in
 *  the wallet, so a failed swap-back is a nuisance, never a loss. */
async function _dumpQuote(wallet, chainKey, quoteToken, amountRaw, slip, gasBoost, gas) {
  const chain = chainOf(chainKey);
  if (!(amountRaw > 0n)) return null;
  try {
    const pick = await bestDexVenue(quoteToken, chainKey);
    const v3 = pick && pick.kind === 'v3' ? v3Cfg(chainKey) : null;
    await approveExact(wallet, quoteToken, v3 ? v3.router : chain.router, amountRaw, chainKey, gasBoost, gas);
    if (v3) {
      const expW = await v3ExpectedOutRaw(chainKey, pick.pool, pick.feeTier, quoteToken, amountRaw);
      if (expW == null || expW <= 0n) return null;
      const ri = new ethers.Interface(V3_ROUTER_ABI);
      const data = ri.encodeFunctionData('exactInputSingle', [{ tokenIn: quoteToken, tokenOut: chain.weth, fee: pick.feeTier, recipient: wallet.address, amountIn: amountRaw, amountOutMinimum: expW * (10000n - slip) / 10000n, sqrtPriceLimitX96: 0n }]);
      const h = await rawSend(wallet, chainKey, v3.router, data, await v3SwapGas(chainKey, wallet.address, v3.router, data, 0n), 0n, gasBoost, { fee: gas });
      await waitHash(h, chainKey);
      return h;
    }
    if (!_v2Fillable(pick)) return null;
    const router = new ethers.Contract(chain.router, ROUTER_ABI, wallet);
    const amts = await router.getAmountsOut(amountRaw, [quoteToken, chain.weth]);
    if (!(amts[1] > 0n)) return null;
    const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(amountRaw, amts[1] * (10000n - slip) / 10000n, [quoteToken, chain.weth], wallet.address, Math.floor(Date.now() / 1000) + 600, gas);
    await waitBounded(tx);
    return tx.hash;
  } catch (_) { return null; }
}

/*
 * A REFUSAL THAT NOBODY CAN READ IS THE SAME AS NO REFUSAL.
 *
 * The CARD path has logged `[curve] card … unroutable: <why>` since it was
 * written; the TRADE path — the one that renders "Stage that refused: …" to the
 * person who pressed Buy — logged NOTHING AT ALL. So four separate rounds of
 * "masih sama aja" each began from a screenshot of a Telegram message, with no
 * way to tell whether the bound tripped because the window ladder walked,
 * because the node was slow, or because the box was simply on older code.
 *
 * ⚠️ IT SITS AT THE CONVERGENCE, NOT AT ONE STAGE. `why` is set by the interface
 * read, then possibly replaced by the price gate and again by the build — three
 * stages, one throw. Logging inside `_curveIface` would have covered only the
 * stage that happens to be reported today, which is this file's own scar: a
 * lesson applied to one branch of an if/else is a lesson half-learnt. Buy and
 * sell both call it for the same reason.
 *
 * ELAPSED is asserted rather than the wording, because elapsed is the
 * discriminator: ~12000ms is the bound tripping — something walked — and a few
 * hundred is a real refusal with a real reason, and those two send an operator
 * to completely different places.
 *
 * Only a REFUSAL is logged. A trade that filled writes nothing: this path runs
 * on every paste and every warm, into a log the snipe loop is already filling,
 * and a line per success is exactly how the card path's own line scrolled away.
 */
function _curveRefused(side, chainKey, ca, t0, why) {
  console.log(`[curve] ${side} ${chainKey}/${String(ca).slice(0, 10)}… refused after ${Date.now() - t0}ms: ${why || 'no reason given'}`);
}

/**
 * Discover the curve, bounded — or say why not.
 *
 * ONE owner, because buy() and sell() would otherwise grow two ideas of how
 * long a discovery may take and two ideas of what an unbounded one means.
 */
async function _curveIface(chainKey, ca) {
  if (!CURVE_ROUTE_ON) return { ok: false, why: 'the discovered-curve route is switched off (CURVE_ROUTE=0)' };
  let timer;
  const bound = new Promise((res) => { timer = setTimeout(() => res({ ok: false, why: `reading this curve's interface took longer than ${Math.round(CURVE_DISCOVER_MS / 1000)}s — nothing was sent` }), CURVE_DISCOVER_MS); });
  try {
    return await Promise.race([
      curveTrade.ifaceFor(providerFor(chainKey), chainKey, ca, {
        tradeHashes: () => _curveTradeHashes(chainKey, ca),
        // The learned-shape transfer's anchor: the curve address the indexer
        // names, whose bytecode is then matched against a taught sibling's.
        poolHint: () => _curvePoolCandidates(chainKey, ca),
        // …and where to LEARN that shape from when nothing has taught the pad
        // yet. Each candidate is bytecode-checked before it teaches anything.
        siblings: () => _curveSiblings(chainKey, ca),
        siblingHashes: (sibCa) => _curveTradeHashes(chainKey, sibCa),
      }),
      bound,
    ]);
  } catch (e) {
    return { ok: false, why: `could not read this curve (${(e && e.message) || e})` };
  } finally { clearTimeout(timer); }
}

/*
 * Warm curveTrade's cache for a token something is actively polling.
 *
 * FIRE-AND-FORGET AND PACED, because the callers are timers: `canTradeNow` is
 * probed every few seconds by the CA snipe and the launch retry ring, and a
 * discovery per probe would spend the RPC budget the buy itself needs. One
 * bounded discovery per token per CURVE_WARM_MS is the whole cost, it runs off
 * the probe's own latency path, and curveTrade's cache (hits 30 min, misses
 * 90s) absorbs everything in between. The map is capped the way _cardReuse is.
 */
const CURVE_WARM_MS = Math.max(30_000, Number(process.env.CURVE_WARM_MS || 120_000));
const _curveWarmAt = new Map();   // `${chain}:${ca}` → last attempt ms
function _curveWarm(ca, chainKey) {
  if (!CURVE_ROUTE_ON || isSvm(chainKey)) return;
  const k = chainKey + ':' + String(ca).toLowerCase();
  const now = Date.now();
  if (now - (_curveWarmAt.get(k) || 0) < CURVE_WARM_MS) return;
  _curveWarmAt.set(k, now);
  if (_curveWarmAt.size > 500) { const f = _curveWarmAt.keys().next().value; _curveWarmAt.delete(f); }
  _curveIface(chainKey, ca).catch(() => {});
}

async function canTradeNow(ca, chainKey) {
  try {
    if (isSvm(chainKey)) return await _solRoutable(ca);
    const chain = chainOf(chainKey);
    if (!chain) return false;
    if (chain.curve) {
      const curve = await resolveCurve(ca, chainKey).catch(() => null);
      if (curve) return true;
    }
    const pick = await bestDexVenue(ca, chainKey).catch(() => null);
    // A pair that EXISTS but holds nothing is not tradeable — it is a deployed
    // contract waiting for liquidity, and buying into it is how a snipe fills at
    // an arbitrary price. The reserve is the launch, not the pair.
    if (pick && pick.wethBal != null && pick.wethBal > 0n) return true;
    if (await v4.canSwapLive(ca, chainKey, { chainOf, providerFor }).catch(() => false)) return true;
    /*
     * ⚠️ THE CURVE LEG. It ANSWERS from the cache only — and it WARMS the
     * cache in the background, paced, because a cache nothing ever fills is a
     * leg that never fires.
     *
     * Without the leg every AUTOMATED path stays inert while the manual Buy
     * button works: the dev snipe, the CA snipe, `_fireLaunch`'s gate and the
     * launch retry ring all poll this predicate. And without the WARM the leg
     * itself was inert for exactly those callers: "buy() does the discovering"
     * assumed a first manual buy that a snipe-watched launch never gets, so a
     * curve token nobody happened to buy by hand answered "not tradeable"
     * until graduation — the state the ring, the CA-snipe handoff and the
     * bot's own "I will buy it the moment it becomes tradeable" promise all
     * sat waiting on.
     *
     * The probe itself still may NOT block on discovery: it is polled on a
     * timer, and a dozen serial RPC reads per probe would cost the launch the
     * snipe exists to catch. So the discovery runs FIRE-AND-FORGET, bounded
     * (CURVE_DISCOVER_MS), and paced per token (CURVE_WARM_MS) on top of
     * curveTrade's own cache — this tick answers from what is known, and the
     * next tick reads what the warm learned. A brand-new curve with no trades
     * yet stays unreadable until somebody trades on the pad; the warm makes
     * the snipe fire within a poll or two of that first observed trade,
     * instead of at graduation.
     */
    if (CURVE_ROUTE_ON) {
      const hit = curveTrade.cached(chainKey, ca);
      if (hit && hit.ok && hit.buy) return true;
      if (!hit) _curveWarm(ca, chainKey);
    }
    return false;
  } catch (_) { return false; }
}

// How long a card waits for the launchpad badge once it already has a price.
// Short on purpose: the badge is a nicety and the paste is the thing the user
// is staring at. The registry caches, so a second render pays nothing.
const CURVE_BADGE_WAIT_MS = Math.max(0, Number(process.env.CURVE_BADGE_WAIT_MS || 700));

// Live token snapshot on a given chain: price (native), mcap (native), curve state.
async function tokenSnapshot(ca, chainKey) {
  const chain = chainOf(chainKey); if (!chain) return null;
  // Solana: no router/curve — price + depth come from DexScreener (deepest pool). We keep
  // priceEth/mcapEth in SOL (native) so the card/USD math is identical to EVM, and pass
  // through the USD figures + liquidity/volume that enrich() surfaces.
  if (isSvm(chainKey)) {
    // ASKED TOGETHER, because they answer different questions and a bonding
    // token frequently has BOTH: DexScreener indexes the curve pair (price,
    // depth, volume) while only the launchpad knows the curve's phase. Serially
    // this would cost the sum of two timeouts on the one path where the token is
    // brand new and neither is fast.
    // THE LAUNCHPAD IS NOT AWAITED WITH THE PRICE.
    //
    // It was, and that put up to LAUNCHPAD_TIMEOUT_MS of somebody else's HTTP
    // in front of every card render — four pads asked concurrently, the caller
    // waiting for the slowest. When DexScreener answers, the pads add a badge
    // and nothing else; a badge may not hold the price hostage. It is awaited
    // in full only on the path where it is the ONLY source (no indexed pool),
    // which is the case the whole feature exists for.
    const lpP = launchpads.covers(chainKey) ? launchpads.record(chainKey, ca).catch(() => null) : Promise.resolve(null);
    const [d, mintDec] = await Promise.all([
      solana.dexScreener(ca),
      // THE MINT'S OWN DECIMALS, read from the chain, in the same wave so it
      // costs nothing. This field used to be the literal `9`, because
      // DexScreener does not report decimals and nine is what a Solana example
      // uses — but every pump.fun token is SIX, and the monitor card trusts this
      // number above all others when it decodes a balance.
      //
      // A user bought 1,075.29 tokens on five wallets, and the position card
      // pinned above the receipts read "You hold: 5.38 · Profit/Loss −99.90%".
      // Nothing had moved: 1075 ÷ 1000 is 1.08, and 10^(9−6) is 1000. The
      // receipts were right, the card was off by three decimal places, and the
      // number it printed was the one that makes somebody sell.
      //
      // Same line, same defect, as the `graduated: true, progressPct: 100` that
      // was hardcoded beside it — a placeholder that reads as a fact.
      solana.splDecimalsOrNull(providerFor(chainKey), ca).catch(() => null),
    ]);
    let solUsd = 0; try { solUsd = await ethUsd(chainKey); } catch (_) {}
    if (!d || !(d.priceUsd > 0)) {
      // NO POOL ANYWHERE — which used to end here, with `return null`, and the
      // card said "❌ Couldn't price it" about a token trading perfectly well on
      // its launchpad. That is the entire pre-migration life of every Solana
      // launch, and it is the window in which people actually ask.
      // No pool anywhere, so the launchpad is the only thing that can price
      // this at all — here it IS the answer, and worth waiting for.
      const lpRec = await lpP;
      const snap = launchpads.curveSnapshot(ca, chainKey, lpRec, solUsd);
      if (!snap) return null;   // no pool AND no launchpad knows it — genuinely nothing to show
      snap.lp = lpRec || null;
      // ROUTABILITY IS MEASURED, NEVER INFERRED FROM HAVING A PRICE. Reading a
      // number off an HTTP API says nothing about whether a swap can be filled;
      // that is the same line v4.js draws between price() and canSwapLive(), and
      // quoting a price the engine cannot honour is worse than saying "not yet".
      // The aggregator routes most bonding curves, so asking is usually a Buy
      // button the user would otherwise not have been offered.
      snap.routable = await _solRoutable(ca);
      return snap;
    }
    const priceEth = solUsd > 0 ? d.priceUsd / solUsd : (d.priceNative || 0);
    const mcapEth = solUsd > 0 ? d.mcapUsd / solUsd : 0;
    const liquiditySol = solUsd > 0 ? d.liquidityUsd / solUsd : 0;
    const snap = { ca, curve: '', priceEth, priceUsd: d.priceUsd, mcapEth, mcapUsd: d.mcapUsd, graduated: true, progressPct: 100,
      // OMITTED when the mint could not be read, never guessed. Downstream
      // (monitorPayload) prefers this field over every other source, so a
      // fabricated 9 here overrides a correct 6 recorded at buy time. Leaving it
      // undefined lets that fallback chain reach the value the buy actually used.
      ...(Number.isFinite(mintDec) ? { decimals: mintDec } : {}),
      dex: true, liquiditySol, liquidityUsd: d.liquidityUsd, volH24Usd: d.volH24Usd, name: d.name, sym: d.symbol };
    // `graduated: true, progressPct: 100` above is the DEFAULT, and it used to
    // be the only answer this branch could give — every Solana token was
    // labelled "◆ DEX" on the card, including one sitting at 12% of a bonding
    // curve. It is still the right default (most indexed Solana tokens have
    // migrated), but a launchpad that says otherwise now overrides it. The
    // overlay returns null unless a pad states the token is ON the curve, so a
    // pad that merely knows the token changes nothing.
    // Whatever arrived by now, bounded. A pad that is slow costs the badge, not
    // the card: the price, the depth and the volume above are already read.
    const lpRec = await Promise.race([lpP, new Promise((r) => setTimeout(r, CURVE_BADGE_WAIT_MS, null))]);
    // Carried on the snapshot so tokeninfo.enrich does not ask again. The
    // registry caches, so the second lookup was usually free — but "usually
    // free" depends on a TTL, and handing over the answer we already hold costs
    // nothing and depends on nothing.
    snap.lp = lpRec || null;
    const overlay = launchpads.curveOverlay(lpRec);
    return overlay ? { ...snap, ...overlay } : snap;
  }
  const prov = providerFor(chainKey);
  if (chain.curve) {
    const curve = await resolveCurve(ca, chainKey);
    if (curve) {
      const c = new ethers.Contract(curve, CURVE_ABI, prov);
      const out = { ca, curve, priceEth: 0, mcapEth: 0, graduated: false, progressPct: 0, decimals: 18, dex: false };
      try { out.graduated = await c.graduated(); } catch (_) {}
      try { out.priceEth = Number(ethers.formatEther(await c.currentPrice())); } catch (_) {}
      try { out.mcapEth = Number(ethers.formatEther(await c.marketCapEth())); } catch (_) {}
      try { const [col, tgt] = await c.graduationProgress(); out.progressPct = tgt > 0n ? Number(col) / Number(tgt) * 100 : 0; } catch (_) {}
      if (!out.graduated) return out;   // still on the curve → curve is the source of truth
      // graduated → price now lives on the DEX; fall through to read it there
    }
  }
  // DEX snapshot (any chain with a router): price from the venue a trade would
  // actually use — V3 QuoterV2 when the deep pool is V3, else V2 getAmountsOut.
  // Pricing off the wrong (dusty) pool made PnL/TP/SL lie for V3-heavy tokens.
  const dec = await tokenDecimals(ca, chainKey);
  let priceEth = 0, mcapEth = 0, dexVenue = 'v2', venueWethEth = null;
  try {
    const one = 10n ** BigInt(dec);
    const pick = await bestDexVenue(ca, chainKey);
    if (pick && pick.wethBal != null) venueWethEth = Number(ethers.formatEther(pick.wethBal));
    if (pick && pick.kind === 'v3') {
      dexVenue = 'v3';
      // Price 1 whole token → WETH from the pool's slot0 spot (no quoter).
      const outW = await v3ExpectedOutRaw(chainKey, pick.pool, pick.feeTier, ca, one);
      priceEth = outW != null ? Number(ethers.formatEther(outW)) : 0;
    } else {
      const router = new ethers.Contract(chain.router, ROUTER_ABI, prov);
      const amts = await router.getAmountsOut(one, [ca, chain.weth]);
      priceEth = Number(ethers.formatEther(amts[1]));
    }
    const ts = await new ethers.Contract(ca, ERC20_ABI, prov).totalSupply();
    mcapEth = priceEth * Number(ethers.formatUnits(ts, dec));
  } catch (_) {}
  if (!(priceEth > 0)) {
    // Nothing V2 or V3 can see. Try the PoolManager directly — a v4 pool has no
    // pair contract for a factory to return, so reading its storage is the ONLY
    // way such a token is ever priced. This is what Maestro does, and it is why
    // Maestro showed $TLNCH on Robinhood Chain while this bot said it could not
    // price it.
    //
    // NOT gated on v4.enabled() any more — that only asked whether an operator
    // had already pasted a PoolManager into .env, and answering "no market" on
    // that basis is what this whole path exists to stop doing. v4.js discovers
    // the deployment from the chain's own logs and caches it, so an unconfigured
    // chain costs one sweep and every token after it is free.
    const p4 = await v4.price(ca, chainKey, dec, { chainOf, providerFor }).catch(() => null);
    /*
     * ⚠️ `priceEth` IS THE PRICE IN THE POOL'S QUOTE CURRENCY, WHATEVER THAT IS.
     *
     * It comes straight off `sqrtPriceX96`, so on a pool paired against a third
     * token it is a price in THAT token — and printing it as native is a WRONG
     * number rather than a missing one, which is the worse of the two. It also
     * feeds `mcapEth` and, through `ethUsd`, the market cap on the card.
     *
     * So a foreign-quoted pool does not price the card. It is remembered and the
     * indexer prices it instead (correctly, in USD), and the ROUTE it proves is
     * carried down to the indexed branch — losing the Buy button here would undo
     * the whole point of being able to fill this pool.
     */
    const p4Quote = p4 ? String(p4.quote).toLowerCase() : '';
    const p4Native = !!p4 && (p4Quote === v4.NATIVE || (_isAddr(chain.weth) && p4Quote === String(chain.weth).toLowerCase()));
    const v4Alt = p4 && !p4Native ? p4 : null;
    if (p4 && p4Native) {
      let ts = 0n; try { ts = await new ethers.Contract(ca, ERC20_ABI, prov).totalSupply(); } catch (_) {}
      return {
        ca, curve: '', decimals: dec, dex: true, graduated: true, progressPct: 100,
        priceEth: p4.priceEth, mcapEth: ts > 0n ? p4.priceEth * Number(ethers.formatUnits(ts, dec)) : 0,
        // Routable exactly when a router can be reached — configured OR observed
        // filling swaps on this PoolManager. Reading a v4 price and being able
        // to FILL a v4 swap are still different capabilities, and the card must
        // not offer a Buy button for the first alone; the difference now is that
        // the second question is answered by the chain instead of by .env.
        dexVenue: 'v4', extVenue: 'Uniswap v4', v4: p4,
        routable: await v4.canSwapLive(ca, chainKey, { chainOf, providerFor }).catch(() => false),
      };
    }
    // Still nothing on-chain. The indexers see venues we have no reader for at
    // all, so they are the last word before giving up.
    //
    // The native's USD rate is started WITH the market lookup, not after it:
    // every branch below needs it, it depends on nothing either indexer says,
    // and awaiting it afterwards put a second HTTP round trip on the end of the
    // card's critical path. (`ethUsd` caches, so a warm render pays nothing.)
    const usdP = ethUsd(chainKey).catch(() => 0);
    const m = await marketOf(ca, chainKey);
    if (!m) {
      /*
       * ⚠️ AND `return null` HERE WOULD HAVE MADE THE WHOLE CURVE ROUTE
       * UNREACHABLE.
       *
       * A pre-migration EVM token has no pool and no indexer, so this branch
       * answered null and the card said "❌ Couldn't price it" — with no Buy
       * button — about a token trading perfectly well on its launchpad.
       * `core.buy` being able to fill it changes nothing if the only surface a
       * user can press it from never offers the tap. Inert in the way that
       * matters, and the Solana branch has had a launchpad leg since the day it
       * was written; the EVM branch never got one.
       *
       * ⚠️ AND THE PAD IS NOT ENOUGH ON ITS OWN. The operator's own box reports
       * `✗ pons — can't reach api.pons.fun`, so a launchpad-only leg would be
       * null exactly where it is needed. The token's own TRADES are on the
       * chain we are already talking to, and that is the source that cannot be
       * unreachable.
       */
      const lpRec = launchpads.covers(chainKey) ? await launchpads.record(chainKey, ca).catch(() => null) : null;
      const usd0 = await usdP;
      const padSnap = launchpads.curveSnapshot(ca, chainKey, lpRec, usd0);
      const iface = CURVE_ROUTE_ON ? await _curveIface(chainKey, ca) : { ok: false };
      // ROUTABLE IS MEASURED, NEVER INFERRED FROM HAVING A PRICE.
      // `curveSnapshot` returns `routable: false` always and says why in its own
      // header; this is the same override the Solana branch makes with
      // `_solRoutable`, and reading a price is still not being able to fill.
      const routable = !!(iface.ok && iface.buy);
      if (padSnap) {
        padSnap.decimals = dec; padSnap.lp = lpRec || null; padSnap.routable = routable;
        return padSnap;
      }
      if (!routable) return null;   // genuinely nothing: no pool, no indexer, no pad, no readable curve
      // The pad could not be reached, so the price comes from the token's own
      // fills. `weak` rides along so nothing downstream mistakes it for an
      // indexed quote.
      const px = await curvePrice.priceWeiPerToken(chainKey, ca, _curveDeps(iface));
      if (!px.ok) return null;
      const pe = Number(ethers.formatEther(px.weiPerTok));
      const ts = await tokenSupplyRaw(ca, chainKey);
      return {
        ca, curve: iface.curve, decimals: dec, dex: false, graduated: false, progressPct: 0,
        priceEth: pe, priceUsd: usd0 > 0 ? pe * usd0 : 0,
        mcapEth: ts ? pe * Number(ethers.formatUnits(ts, dec)) : 0,
        mcapUsd: ts && usd0 > 0 ? pe * Number(ethers.formatUnits(ts, dec)) * usd0 : 0,
        // NULL, never 0 — a curve has no pool depth to report, and "0" on a card
        // reads as a rug. The rule launchpads.js states for the same field.
        liquidityUsd: null, volH24Usd: null,
        dexVenue: 'curve', extVenue: 'a launchpad curve', onCurve: true,
        priceSource: px.source, priceWeak: !!px.weak,
        routable: true,
      };
    }
    const usd = await usdP;
    /*
     * ⚠️ AN INDEXED TOKEN CAN STILL BE ON A BONDING CURVE, and this branch used
     * to be the one place that never asked.
     *
     * DexScreener indexes several pads' curves as ordinary pairs — Pons on
     * Robinhood among them — so `m` answering says nothing about a ROUTE. This
     * returned `routable: false` unconditionally, the card rendered
     * "liquidity is on Pons v2, which Dexvra can't route through yet" with no
     * Buy button, and `core.buy` — whose own curve leg fills exactly this
     * shape — was unreachable from the one surface a user can press Buy on.
     * The unindexed twin of this branch (above) has consulted the curve since
     * the feature shipped; being indexed made a token LESS buyable.
     *
     * The probe is bounded (CURVE_DISCOVER_MS) and cached (curveTrade: hits
     * 30 min, misses 90s), and an AMM can never read as a curve: the curve is
     * the contract the token itself moves to and from, which a router never is.
     */
    const extBase = {
      ca, decimals: dec,
      priceEth: usd > 0 ? m.priceUsd / usd : 0, priceUsd: m.priceUsd,
      mcapEth: usd > 0 && m.mcapUsd ? m.mcapUsd / usd : 0, mcapUsd: m.mcapUsd,
      liquidityUsd: m.liqUsd, volH24Usd: m.volH24Usd, name: m.name, sym: m.sym,
      extVenue: dsVenueLabel(m),
    };
    /*
     * A v4 pool quoted in a THIRD token: the indexer priced it, and the chain
     * proved the venue. `buy()` fills this by acquiring the pool's own quote
     * first — the same two legs the curve path already uses — so it is routable,
     * and the numbers on the card stay the indexer's rather than being read out
     * of a pool denominated in something other than the native coin.
     */
    if (v4Alt && await v4.canSwapLive(ca, chainKey, { chainOf, providerFor }).catch(() => false)) {
      return { ...extBase, curve: '', dex: true, graduated: true, progressPct: 100, dexVenue: 'v4', v4: v4Alt, routable: true };
    }
    const iface = CURVE_ROUTE_ON ? await _curveIface(chainKey, ca) : { ok: false };
    if (iface.ok && iface.buy) {
      return {
        ...extBase, curve: iface.curve, dex: false, graduated: false, progressPct: 0,
        dexVenue: 'curve', onCurve: true, routable: true,
      };
    }
    // The one line that separates "not deployed", "discovery timed out" and
    // "genuinely unreadable" from pm2 alone. The card cannot carry it (it is
    // an operator diagnostic on a user surface), and without it every round of
    // "masih sama aja" starts from zero.
    const curveWhy = CURVE_ROUTE_ON
      ? (iface.why || (iface.ok ? 'interface read, but no BUY leg observed yet' : 'unreadable'))
      : null;
    if (curveWhy) console.log(`[curve] card ${chainKey}/${String(ca).slice(0, 10)}… unroutable: ${curveWhy}`);
    // `curveWhy` rides ON the snapshot so the CARD can say it — see
    // unroutableCard: the pm2 line above was unretrievable on this box.
    return { ...extBase, curve: '', dex: true, graduated: true, progressPct: 100, dexVenue: 'ext', routable: false, curveWhy };
  }
  return { ca, curve: '', priceEth, mcapEth, graduated: true, progressPct: 100, decimals: dec, dex: true, dexVenue, venueWethEth, routable: true };
}

// ---------------------------------------------------------------- gas
// The chain's base fee, cached for a couple of seconds. gasOverrides() is called
// up to THREE times inside one buy — the preflight, the swap's rawSend, and the
// bot-fee transfer's rawSend — and each call was its own eth_getBlock: three
// serial round trips to learn a number that cannot meaningfully have moved
// between them. The 2x buffer below already absorbs far more drift than a 2.5s
// window can produce.
const _feeCache = new Map();   // chainKey → { base, tip, gasPrice, ts }
const FEE_CACHE_MS = Math.max(0, Number(process.env.GAS_CACHE_MS || 2500));
// Base fee AND the node's priority-fee suggestion, read together in one wave.
async function _feeInfo(chainKey) {
  const hit = _feeCache.get(chainKey);
  if (hit && Date.now() - hit.ts < FEE_CACHE_MS) return hit;
  const prov = providerFor(chainKey);
  let base = 0n, tip = 0n, gasPrice = 0n;
  const [blk, fd] = await Promise.all([
    prov.getBlock('latest').catch(() => null),
    prov.getFeeData().catch(() => null),
  ]);
  if (blk && blk.baseFeePerGas) base = blk.baseFeePerGas;
  if (fd) { if (fd.maxPriorityFeePerGas) tip = fd.maxPriorityFeePerGas; if (fd.gasPrice) gasPrice = fd.gasPrice; }
  const rec = { base, tip, gasPrice, ts: Date.now() };
  _feeCache.set(chainKey, rec);
  return rec;
}
// Floor for the priority fee, per chain. A node that reports a 0 tip (routine on
// L2s) would otherwise produce a transaction with nothing in it for the builder,
// which is exactly the transaction that sits in the mempool.
const MIN_TIP_GWEI = { ethereum: '1', bsc: '1', base: '0.005', arbitrum: '0.01', robinhood: '0.001' };
const _gwei = (s) => ethers.parseUnits(String(s), 'gwei');

/** Fee overrides for a write on `chainKey`, scaled by `gasMult` (1 Normal,
 *  2 Fast, 3 Turbo; the sell retry escalation pushes it to 2 then 4).
 *
 *  THIS USED TO RETURN `{}` FOR EVERY CHAIN EXCEPT ROBINHOOD. Two things rode on
 *  that empty object and both silently did nothing off Robinhood:
 *    • the user's ⛽ Gas priority setting — Fast/Turbo were sold as "confirms
 *      quicker" and changed not one wei of what got signed;
 *    • the sell retry escalation — a sell that failed BECAUSE the gas was too
 *      low retried twice more at exactly the same gas, so the escalation only
 *      made a stuck exit take three times as long to give up.
 *
 *  Now every chain gets a real answer, and EIP-1559 chains get 1559 fees:
 *  `maxFeePerGas` carries 2x base-fee headroom so a base fee that ticks up
 *  between signing and inclusion cannot strand the transaction, while
 *  `maxPriorityFeePerGas` — the part that actually competes for a slot, and the
 *  only part the boost needs to touch — is what scales. You still only pay
 *  base + tip, so the headroom is free. */
async function gasOverrides(chainKey, gasMult) {
  const boost = BigInt(Math.max(1, Math.min(6, Math.round(Number(gasMult) || 1))));
  const info = await _feeInfo(chainKey);
  // Robinhood keeps its fixed/cheap legacy floor: its node is quirky enough that
  // the proven type-0 path stays exactly as it was.
  const mode = chainKey === 'robinhood' ? CFG.gasMode : 'auto';
  if (mode !== 'auto') {
    const base = info.base > 0n ? info.base : info.gasPrice;
    const buffered = base > 0n ? base * 2n : _gwei('0.02');
    if (mode === 'cheap') return { gasPrice: buffered * boost };
    const want = _gwei(CFG.gasGwei > 0 ? CFG.gasGwei : 0.01);
    return { gasPrice: (want > buffered ? want : buffered) * boost };
  }
  if (info.base > 0n) {
    const floor = _gwei(MIN_TIP_GWEI[chainKey] || '0.01');
    let tip = info.tip > floor ? info.tip : floor;
    tip = tip * boost;                       // boost the competitive part only
    return { maxFeePerGas: info.base * 2n + tip, maxPriorityFeePerGas: tip };
  }
  // No base fee reported → pre-1559 chain (BNB has run at base 0). Legacy, but
  // the boost is honoured rather than thrown away.
  const gp = info.gasPrice > 0n ? info.gasPrice : _gwei('1');
  return { gasPrice: gp * boost };
}
async function waitBounded(tx) { try { return await tx.wait(1, 180000); } catch (e) { if (e && e.code === 'TIMEOUT') return null; throw e; } }
async function waitHash(hash, chainKey) { try { return await providerFor(chainKey).waitForTransaction(hash, 1, 180000); } catch (e) { if (e && e.code === 'TIMEOUT') return null; throw e; } }
// Wait for a BROADCAST buy's receipt without ever mistaking a post-broadcast wait
// error for a clean failure. The tx is already in the mempool (we hold its hash), so:
//   • a genuine on-chain revert (CALL_EXCEPTION — ethers throws this on a status-0
//     receipt) RE-THROWS: the buy really failed and the ETH was refunded, so a
//     copy/dev-snipe caller SHOULD roll back its committed budget.
//   • any OTHER wait error (TRANSACTION_REPLACED, a transient RPC hiccup during receipt
//     polling) returns null, routing buy() into its "broadcast but unconfirmed" path —
//     the tx may still land, so the caller must NOT refund the budget (which would let
//     the maxEth cap be exceeded if the tx actually confirms). Audit #2 fix.
async function waitBuyReceipt(waiter) {
  try { return await waiter(); }
  catch (e) {
    if (e && e.code === 'CALL_EXCEPTION') throw e;   // real revert → funds refunded → real failure
    if (e && e.code === 'TIMEOUT') return null;
    return null;                                      // any other post-broadcast wait error → treat as unconfirmed (never refund)
  }
}
// Broadcast a signed write WITHOUT ethers' send/estimate path. On the Robinhood node
// ethers' own send can throw an opaque "could not coalesce error" / "missing revert
// data" because the node returns a non-standard JSON-RPC error envelope and strips
// custom-error/revert data on eth_estimateGas. We sign locally and POST
// eth_sendRawTransaction ourselves, so the node's REAL reason reaches the user (e.g. a
// beta-allowlist NotAllowed) instead of an ethers wrapper. Returns the tx hash.
// `opts.fee` lets a caller that ALREADY computed the fee for this exact trade hand
// it over instead of having it re-derived here. Beyond saving the read, it
// guarantees the fee quoted during preflight is the fee actually signed.
//
// TRANSACTION TYPE follows the fee, and that matters most on Ethereum. This used
// to force `type: 0` (legacy) everywhere with gasPrice = the node's current
// suggestion — i.e. no headroom at all. A legacy transaction's gasPrice IS its
// max fee, so the moment the base fee ticked up between signing and inclusion the
// transaction became unmineable and sat in the mempool until the base fee came
// back down. That is how a 12-second Ethereum trade turns into a two-minute one.
// When gasOverrides returns 1559 fees we now sign type-2, which is precisely the
// mechanism that avoids it. Robinhood still yields a gasPrice, so it still signs
// the type-0 its node is known to accept.
async function rawSend(wallet, chainKey, to, data, gasLimit, value, gasMult, opts) {
  const prov = providerFor(chainKey);
  const ch = chainOf(chainKey);
  let fee = (opts && opts.fee) || await gasOverrides(chainKey, gasMult);
  if (!fee || (!fee.gasPrice && !fee.maxFeePerGas)) {
    try { const fd = await prov.getFeeData(); fee = fd.maxFeePerGas ? { maxFeePerGas: fd.maxFeePerGas, maxPriorityFeePerGas: fd.maxPriorityFeePerGas || 0n } : { gasPrice: fd.gasPrice }; } catch (_) {}
  }
  if (!fee || (!fee.gasPrice && !fee.maxFeePerGas)) fee = { gasPrice: ethers.parseUnits('0.02', 'gwei') };
  const nonce = await prov.getTransactionCount(wallet.address, 'pending');
  const req = { to, data, value: value || 0n, gasLimit, nonce, chainId: ch.chainId };
  if (fee.maxFeePerGas) { req.type = 2; req.maxFeePerGas = fee.maxFeePerGas; req.maxPriorityFeePerGas = fee.maxPriorityFeePerGas || 0n; }
  else { req.type = 0; req.gasPrice = fee.gasPrice; }
  const signed = await wallet.signTransaction(req);
  let j = null;
  try {
    const r = await fetch(ch.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [signed] }), signal: AbortSignal.timeout(25000) });
    j = await r.json();
  } catch (_) {
    const resp = await prov.broadcastTransaction(signed); return resp.hash;   // network hiccup on the POST → ethers fallback
  }
  if (j && j.error) throw new Error((j.error && (j.error.message || JSON.stringify(j.error))) || 'node rejected the transaction');
  if (!j || !j.result) throw new Error('no transaction hash returned by the node');
  return j.result;
}
// ---------------------------------------------------------------- Uniswap V3 venue
// The engine can route DEX trades through Uniswap V3 when the token's depth
// lives there (the Maestro behavior): pick the deepest token↔WETH pool across
// V2 and the V3 fee tiers, quote via QuoterV2, swap via SwapRouter02. V3 is
// active per chain only when factory+router+quoter are all configured.
const V3_FEES = [100, 500, 3000, 10000];
const V3_FACTORY_ABI = ['function getPool(address,address,uint24) view returns (address)'];
const V3_ROUTER_ABI = ['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)'];
const V3_POOL_ABI = ['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool unlocked)', 'function token0() view returns (address)'];
const WETH9_ABI = ['function withdraw(uint256)'];

// V3 is enabled for a chain only when factory+router are WELL-FORMED addresses.
// The QUOTER is intentionally NOT required: on custom V3 forks (e.g. Robinhood
// Chain) the canonical QuoterV2 doesn't match the fork's factory and reverts,
// so we price/route off the pool's own slot0 (sqrtPriceX96) instead — no quoter
// dependency. A blank/malformed value disables V3 and falls back to V2.
const _isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a == null ? '' : a).trim());
function v3Cfg(chainKey) { const c = chainOf(chainKey); const v = c && c.v3; return (v && _isAddr(v.factory) && _isAddr(v.router)) ? v : null; }

// Pool spot price P = token1_raw per token0_raw, from slot0's sqrtPriceX96
// (P = (sqrtPriceX96/2^96)^2). Cached briefly. Returns { P, token0 } or null.
const _v3PoolCache = new Map();
async function v3PoolState(chainKey, pool) {
  const ck = chainKey + ':' + pool.toLowerCase();
  const hit = _v3PoolCache.get(ck); if (hit && Date.now() - hit.ts < 15000) return hit.v;
  try {
    const pc = new ethers.Contract(pool, V3_POOL_ABI, providerFor(chainKey));
    const [s0, token0] = await Promise.all([pc.slot0(), pc.token0()]);
    const sqrt = Number(s0[0]);
    if (!(sqrt > 0)) return null;
    const P = (sqrt / 2 ** 96) ** 2;   // token1_raw per token0_raw
    const v = { P, token0: String(token0).toLowerCase() };
    _v3PoolCache.set(ck, { v, ts: Date.now() });
    return v;
  } catch (_) { return null; }
}
// Expected raw output of a V3 exact-input swap, from spot price. Decimal-
// INDEPENDENT: P is raw/raw, so out_raw = (in is token0 ? in·P : in/P)·(1-fee).
// Used only to set amountOutMinimum (a protective FLOOR with slippage on top) —
// the on-chain swap still guarantees ≥ minOut or reverts, so a small estimate
// error is safe. null if the pool can't be read.
async function v3ExpectedOutRaw(chainKey, pool, feeTier, tokenIn, amountInRaw) {
  const st = await v3PoolState(chainKey, pool); if (!st) return null;
  const inIsT0 = String(tokenIn).toLowerCase() === st.token0;
  const feeMul = 1 - feeTier / 1e6;
  const outFloat = (inIsT0 ? Number(amountInRaw) * st.P : Number(amountInRaw) / st.P) * feeMul;
  if (!(outFloat > 0) || !isFinite(outFloat)) return null;
  return BigInt(Math.floor(outFloat));
}

// Deepest token↔WETH V3 pool across fee tiers, measured by the WETH the pool
// holds (directly comparable to a V2 pair's WETH reserve).
async function v3BestPool(ca, chainKey) {
  const v3 = v3Cfg(chainKey); if (!v3) return null;
  const chain = chainOf(chainKey); const prov = providerFor(chainKey);
  const f = new ethers.Contract(v3.factory, V3_FACTORY_ABI, prov);
  const weth = new ethers.Contract(chain.weth, ERC20_ABI, prov);
  const rows = await Promise.all(V3_FEES.map(async (feeTier) => {
    try {
      const pool = await f.getPool(ca, chain.weth, feeTier);
      if (!pool || pool === ethers.ZeroAddress) return null;
      const balW = await weth.balanceOf(pool);
      return balW > 0n ? { pool, feeTier, wethBal: balW } : null;
    } catch (_) { return null; }
  }));
  let best = null;
  for (const r of rows) if (r && (!best || r.wethBal > best.wethBal)) best = r;
  return best;
}

// V2 pair depth in WETH (raw). { pair:null, wethBal:0n } when there is no pair.
async function v2Depth(ca, chainKey) {
  const chain = chainOf(chainKey);
  try {
    const prov = providerFor(chainKey);
    const factory = await new ethers.Contract(chain.router, ['function factory() view returns (address)'], prov).factory();
    if (!factory || factory === ethers.ZeroAddress) return { pair: null, wethBal: 0n };
    const pair = await new ethers.Contract(factory, ['function getPair(address,address) view returns (address)'], prov).getPair(ca, chain.weth);
    if (!pair || pair === ethers.ZeroAddress) return { pair: null, wethBal: 0n };
    const balW = await new ethers.Contract(chain.weth, ERC20_ABI, prov).balanceOf(pair);
    return { pair, wethBal: balW };
  } catch (_) { return { pair: null, wethBal: 0n }; }
}

/**
 * Is this V2 pick something a trade could actually fill?
 *
 * A pair CONTRACT existing is not a market. A token can have an empty or
 * abandoned V2 pair — someone deployed one and never funded it, or the
 * liquidity was pulled and moved to v4 — and the pair address alone was enough
 * to send every buy down the V2 leg, where getAmountsOut returns nothing and the
 * trade dies on "no liquidity / zero quote" while a funded v4 pool sat right
 * there. An unfundable pair is the same situation as no pair at all, so it takes
 * the same branch.
 */
const _v2Fillable = (pick) => !!(pick && pick.pair && pick.wethBal > 0n);

// Venue pick with a short cache (watchers snapshot frequently — don't re-probe
// 10 contracts per tick). V3 wins only when it is CLEARLY deeper (>2× the V2
// WETH reserve): stick with the battle-tested V2 path when they're comparable.
const _venueCache = new Map();   // `${chainKey}:${ca}` → { v, ts }
async function bestDexVenue(ca, chainKey) {
  const ck = chainKey + ':' + String(ca).toLowerCase();
  const hit = _venueCache.get(ck);
  if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return hit.v;
  const [v2, v3] = await Promise.all([v2Depth(ca, chainKey), v3BestPool(ca, chainKey)]);
  const v = (v3 && v3.wethBal > v2.wethBal * 2n)
    ? { kind: 'v3', wethBal: v3.wethBal, feeTier: v3.feeTier, pool: v3.pool }
    : { kind: 'v2', wethBal: v2.wethBal, pair: v2.pair };
  _venueCache.set(ck, { v, ts: Date.now() });
  return v;
}

// Gas limit for a plain native transfer. The hard 21000 is ONLY valid for an
// EOA→EOA transfer on a chain with no L1 data component — it reverts (out of
// gas) on Arbitrum-Orbit chains like Robinhood Chain (extra L1-calldata gas)
// and to any CONTRACT recipient (Safe/multisig/exchange deposit contract whose
// receive() needs gas). This silently killed fee collection there. Estimate and
// bump; fall back generously. estimateGas on Orbit chains already folds in the
// L1 component, so this returns a limit that actually lands.
// Cached per (chain, destination). The gas a native transfer costs depends on the
// chain and on whether the RECIPIENT is a contract — neither of which changes
// between trades. Every single trade was re-estimating the transfer to the same
// fee wallet, one round trip each. Keyed on the destination so a withdrawal to a
// user-supplied address (which may be a contract with an expensive receive()) is
// still estimated for that address, never served a fee-wallet number.
const _nativeGasCache = new Map();   // `${chain}:${to}` → { limit, ts }
const NATIVE_GAS_TTL_MS = 5 * 60 * 1000;
async function nativeTransferGas(chainKey, from, to, value) {
  const k = chainKey + ':' + String(to).toLowerCase();
  const hit = _nativeGasCache.get(k);
  if (hit && Date.now() - hit.ts < NATIVE_GAS_TTL_MS) return hit.limit;
  try {
    const g = await providerFor(chainKey).estimateGas({ from, to, value: value > 1n ? value : 1n });
    const limit = g + g / 4n;   // +25% headroom
    _nativeGasCache.set(k, { limit, ts: Date.now() });
    return limit;
  } catch (_) { return 120000n; }   // covers Orbit L1 gas + a contract recipient's receive()
}
/**
 * The L1 data fee an OP-stack chain will charge ON TOP of `gasLimit × gasPrice`.
 *
 * It exists because op-geth's balance pre-check is `value + gas × price + l1Cost`,
 * and NOTHING in this file used to account for the third term. A max withdrawal
 * that left behind exactly the L2 execution cost was therefore short by the L1
 * fee and bounced with "insufficient funds for gas * price + value" — a message
 * that names the two terms that were covered and not the one that was not.
 *
 * Arbitrum and Robinhood need nothing here: Nitro folds the L1 component into
 * the gas UNITS, so `nativeTransferGas`'s estimate already carries it. This is
 * the OP-stack shape only, and it DISCOVERS whether a chain has one rather than
 * carrying a list — the rule `v4.js` follows for the PoolManager. A chain
 * without the predeploy answers 0 forever after one `getCode`.
 */
const OP_GAS_ORACLE = '0x420000000000000000000000000000000000000F';
const _hasL1Oracle = new Map();   // chainKey → boolean (ONLY ever set from a read that answered)
async function _l1DataFee(chainKey, req) {
  const prov = providerFor(chainKey);
  let has = _hasL1Oracle.get(chainKey);
  if (has === undefined) {
    // ⚠️ `.catch(() => '0x')` HERE WOULD BE THE BUG THIS FILE KEEPS WRITING.
    // "this chain has no oracle" and "the node did not answer" are different
    // facts, and caching the second as the first disables L1 accounting on Base
    // for the life of the process — after one transient 403 or timeout, silently,
    // on the exact path where being short by the L1 fee means the withdrawal does
    // not send. A failed read is not cached and is reported to the caller.
    let code;
    try { code = await prov.getCode(OP_GAS_ORACLE); }
    catch (_) { return { fee: 0n, ok: false, oracle: null }; }
    has = !!(code && code !== '0x');
    _hasL1Oracle.set(chainKey, has);
  }
  if (!has) return { fee: 0n, ok: true, oracle: false };   // not an OP-stack chain: 0 is the true answer
  try {
    // The unsigned serialization under-counts by the signature bytes the oracle
    // would see; the caller's headroom covers that, and an over-estimate here
    // only ever means a slightly smaller sweep.
    const raw = ethers.Transaction.from(req).unsignedSerialized;
    const oracle = new ethers.Contract(OP_GAS_ORACLE, ['function getL1Fee(bytes) view returns (uint256)'], prov);
    const f = await oracle.getL1Fee(raw);
    return { fee: f > 0n ? BigInt(f) : 0n, ok: true, oracle: true };
  } catch (_) { return { fee: 0n, ok: false, oracle: true }; }
}
// Gas limit for a V3 swap / unwrap CONTRACT call. Same reason as
// nativeTransferGas: a hardcoded limit ignores the Orbit L1-calldata component
// (folded into gas units on Nitro chains), so a fixed 500k could out-of-gas an
// exactInputSingle during an L1 fee spike and block exits. Estimate + 25%;
// generous fallback (> curve's 600k) covers L1 data + ~200k L2 compute.
async function v3SwapGas(chainKey, from, to, data, value) {
  try {
    const g = await providerFor(chainKey).estimateGas({ from, to, data, value: value || 0n });
    return g + g / 4n;
  } catch (_) { return 800000n; }
}

/**
 * Approve EXACTLY this much, to a spender the bot INFERRED.
 *
 * ⚠️ `ensureApprove` grants `MaxUint256`, which is right for a router this repo
 * ships the address of and wrong for a contract picked out of Transfer logs by
 * a popularity score. v4.js already draws the line in as many words: "an
 * operator-set router gets a standing allowance; a discovered one gets this
 * sell and nothing more."
 *
 * It matters more here than anywhere else in the file: every other risk on the
 * discovered-curve path is bounded by one trade, and an unlimited grant to a
 * wrong address is bounded by the whole bag, for ever, and outlives the trade
 * that asked for it.
 */
async function approveExact(wallet, ca, spender, amount, chainKey, gasMult, gas) {
  const erc = new ethers.Contract(ca, ERC20_ABI, wallet);
  const cur = await erc.allowance(wallet.address, spender).catch(() => 0n);
  if (cur >= amount) return cur;
  const data = new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [spender, amount]);
  const h = await rawSend(wallet, chainKey, ca, data, 120000n, 0n, gasMult || 1, gas ? { fee: gas } : undefined);
  const r = await waitHash(h, chainKey);
  if (r && r.status === 0) throw new Error('the approval for this curve reverted — nothing was sold. Tx: ' + h);
  // ⚠️ RE-READ, never assume. A token with a non-standard `approve` (one that
  // returns false, or refuses a non-zero-to-non-zero change) leaves the
  // allowance short with nothing thrown, and passing an assumed value would
  // push a call that reverts at the transferFrom straight past the gate.
  return await erc.allowance(wallet.address, spender).catch(() => 0n);
}

async function ensureApprove(wallet, ca, spender, amount, chainKey) {
  const erc = new ethers.Contract(ca, ERC20_ABI, wallet);
  const cur = await erc.allowance(wallet.address, spender).catch(() => 0n);
  if (cur < amount) { const gas = await gasOverrides(chainKey); const tx = await erc.approve(spender, ethers.MaxUint256, gas); await tx.wait(); }
}

// ---------------------------------------------------------------- fee + referral
/**
 * The slippage bound for a trade, in basis points.
 *
 * `overrideBps` REPLACES the user's setting rather than adding to it, which is
 * what a snipe needs: a launch fills through a pool one block old, and the bound
 * that gets you in there would be reckless on ordinary trading. `slipAddBps`
 * (the retry escalation) stays additive on top of whichever of the two applies —
 * the two knobs answer different questions and must not be folded together.
 * Capped at 50% either way; nothing may quietly authorise more.
 */
function slipBps(u, overrideBps) {
  const o = Number(overrideBps);
  if (Number.isFinite(o) && o > 0) return BigInt(Math.min(5000, Math.round(o)));
  let s = Number(u && u.settings && u.settings.slippage); if (!(s > 0)) s = 5; if (s > 50) s = 50; return BigInt(Math.round(s * 100));
}
// Charge the bot fee. BROADCAST-AND-DEFER: this returns as soon as the transfer is
// in the mempool, and the receipt is awaited in the BACKGROUND.
//
// It used to await the receipt inline. That put a second, entirely separate
// confirmation between the user's fill and the user's fill message: the swap
// landed, and then the bot sat waiting for its OWN 1% transfer to confirm before
// it would say "Bought". On a chain with 2s blocks that is another full block
// plus poll on every single trade, spent on something the trader does not care
// about and cannot act on.
//
// The money invariant is unchanged: the referral share is still credited ONLY
// after the fee transfer actually confirms — that just now happens a second or
// two later, off the trade path, instead of holding the receipt hostage. `onOk`
// runs on confirmation; a revert or a failed broadcast simply never calls it.
function _chargeFee(wallet, feeWei, chainKey, onOk) {
  if (feeWei <= 0n || !CFG.feeWallet || !/^0x[0-9a-fA-F]{40}$/.test(CFG.feeWallet)) return Promise.resolve(null);
  // rawSend, NOT wallet.sendTransaction: the Robinhood node rejects ethers'
  // estimate/send path (see rawSend), which made every fee transfer there
  // fail silently while the trade itself succeeded — zero revenue collected.
  // Gas is estimated (not a hard 21000) — 21000 reverts on Robinhood (Orbit
  // L1 gas) and to a contract treasury, which is why the treasury stayed 0.
  return (async () => {
    const gasLimit = await nativeTransferGas(chainKey, wallet.address, CFG.feeWallet, feeWei);
    const hash = await rawSend(wallet, chainKey, CFG.feeWallet, '0x', gasLimit, feeWei);
    // Confirm off the critical path. The nonce for any FOLLOWING tx from this
    // wallet is read with 'pending', which already counts this one, so not
    // awaiting it here cannot desync the nonce.
    waitHash(hash, chainKey).then((rc) => {
      if (!rc || rc.status === 0) { if (rc && rc.status === 0) console.error('fee tx reverted (status 0) — is FEE_WALLET reachable? gas?', hash); return; }
      if (onOk) { try { onOk(hash); } catch (e) { console.error('fee post-confirm', e.message); } }
    }).catch((e) => console.error('fee confirm', e && e.message));
    return hash;
  })().catch((e) => { console.error('fee charge failed', e.message); return null; });
}
function _creditReferral(user, feeWei, chainKey) {
  if (!user.referredBy || feeWei <= 0n) return;
  const refId = DB.refByCode[user.referredBy];
  const ref = refId && DB.users[refId];
  if (!ref) return;
  const share = (feeWei * BigInt(CFG.refShareBps)) / 10000n;
  // Bucket per chain — a BNB fee share must NOT be summed with ETH shares (1 BNB
  // != 1 ETH). refOwed[chainKey] = wei string, settled per native.
  ref.refOwed = ref.refOwed || {};
  ref.refOwed[chainKey] = ((BigInt(ref.refOwed[chainKey] || '0')) + share).toString();
  saveStoreNow();   // write-through: the fee already moved on-chain; don't lose the credit in the debounce window
}
// Position/map key. EVM addresses are case-insensitive (lowercase for a stable key);
// Solana base58 mints are CASE-SENSITIVE, so keep their original case — lowercasing
// could collide two distinct mints onto one position.
function posKey(chainKey, ca) { return chainKey + ':' + (isSvm(chainKey) ? String(ca) : String(ca).toLowerCase()); }

/**
 * A freshly (re)opened bag forgets the last one's risk history.
 *
 * A POSITION RECORD SURVIVES BEING SOLD TO ZERO — it is what carries the
 * lifetime ethIn/ethOut for the ×-multiple and the stats — so everything hanging
 * off it survives too, and gets applied to the next bag in the same token as
 * though it described that one.
 *
 * That cost a false alarm once already: the "Possible rug / dump" alert compared
 * a brand-new bag against a peak left behind by a holding that had been sold
 * (2026-08-16 — "value fell to 0.0131 from a peak of 0.1004", on a token bought
 * sixty seconds earlier, four times over). That alert has since been removed
 * entirely, and `peakValueEth` with it.
 *
 * WHAT KEEPS THIS FUNCTION ALIVE is the auto-protect cooldown. A stale
 * `protectAt` SUPPRESSES a real rescue on the new position — the same defect
 * with the loss reversed, and a much more expensive one than a spurious message.
 *
 * It existed on the EVM path only; `_buySol` never got it, so the alarm was
 * Solana-only. One owner now, called from both, because the next chain would
 * have made it three.
 */
function _resetRiskIfFresh(p) {
  let prevHeld = 0n; try { prevHeld = BigInt(p.tokens || '0'); } catch (_) {}
  if (!(p.closed || prevHeld <= 0n)) return;   // adding to a live bag keeps its history
  // Legacy cleanup: nothing writes these any more, but a store written before
  // the alert was removed still carries them on every position it ever tracked.
  delete p.peakValueEth;
  if (p.notified && typeof p.notified === 'object') {
    delete p.notified.rug;
    delete p.notified.protectAt;
    delete p.notified.protectCheckAt;
  }
}
// Append a trade to a wallet's history (newest last), bounded so the store can't grow forever.
function _pushHistory(wal, entry) {
  if (!Array.isArray(wal.history)) wal.history = [];
  entry.ts = Date.now();
  wal.history.push(entry);
  if (wal.history.length > 50) wal.history = wal.history.slice(-50);
}

// ---------------------------------------------------------------- Solana trade (Jupiter)
// The bot fee on Solana is a SEPARATE SOL transfer to SOL_FEE_WALLET (mirrors the EVM
// _chargeFee), so we don't need Jupiter's referral/ATA fee plumbing.
//
// Like its EVM twin this BROADCASTS AND DEFERS: it resolves with the signature as
// soon as the transfer is sent, and confirms in the background. Awaiting a second
// Solana confirmation inline added a full confirm round (~1-2s, more under load)
// to every Solana fill, for a transfer the trader has no stake in. `onOk` fires
// on confirmation, so the referral credit stays gated on the fee landing.
function _chargeFeeSol(conn, keypair, feeLamports, onOk) {
  if (feeLamports <= 0n || !CFG.solFeeWallet || !solana.isSolAddress(CFG.solFeeWallet)) return Promise.resolve(null);
  return solana.sendSol(conn, keypair, CFG.solFeeWallet, feeLamports, { confirm: false })
    .then(({ sig, confirmed }) => {
      confirmed
        .then(() => { if (onOk) { try { onOk(sig); } catch (e) { console.error('sol fee post-confirm', e.message); } } })
        .catch((e) => console.error('sol fee confirm', e && e.message));
      return sig;
    })
    .catch((e) => { console.error('sol fee charge failed', e.message); return null; });
}
// Buy `amount` SOL of the SPL mint `ca` via Jupiter. Positions/history reuse the EVM
// ethIn/ethOut fields (SOL-denominated) so the portfolio/PnL code is chain-agnostic.
async function _buySol(u, ca, amount, chainKey, walletId, opts) {
  ca = String(ca || '').trim();
  if (!solana.isSolAddress(ca)) throw new Error('invalid Solana token mint');
  const sent = (h) => { try { if (opts && opts.onSent && h) opts.onSent(h); } catch (_) {} };
  const wal = _resolveWallet(u, walletId);
  return withWalletLock(wal.address, async () => {
    const signer = _signer(wal, chainKey);   // { svm, address, keypair, connection }
    const conn = signer.connection, kp = signer.keypair;
    const tStart = Date.now();
    const gross = solana.solToLamports(amount);
    if (gross <= 0n) throw new Error('amount must be > 0');
    // Everything the QUOTE needs is known right here — the two mints, the amount
    // and the slippage. None of it comes from the chain.
    const fee = solana.feeLamports(gross, CFG.feeBps);
    const spend = gross - fee;
    const slip = Number(slipBps(u, opts && opts.slipBps));
    // THE QUOTE STARTS NOW, not after the reads.
    //
    // It used to be issued inside solana.swap(), i.e. only once the three reads
    // below had all come back — so Jupiter's round trip was stacked on top of an
    // RPC round trip it does not depend on. On a public RPC
    // getParsedTokenAccountsByOwner alone is a few hundred milliseconds, and a
    // snipe paid all of it before asking for a price.
    //
    // The wasted-request case is a buy that fails its balance check, which is
    // one quote nobody used. The .catch keeps that from surfacing as an unhandled
    // rejection when a pre-check throws before the promise is ever awaited.
    const quoteP = solana.getQuote({ inputMint: solana.WSOL_MINT, outputMint: ca, amountRaw: spend, slippageBps: slip });
    quoteP.catch(() => {});
    // The divergence guard's reference read, started here for the same reason —
    // see the guard below. Earliest possible start is the only thing that keeps
    // it off the critical path.
    const refP = withTmo(tokenSnapshot(ca, chainKey).catch(() => null), 5000, null);
    // Three independent lookups — SOL balance, the current bag, and the mint's
    // identity — that used to be awaited one at a time ahead of every Solana buy.
    // tokenMeta alone is an RPC call plus a Jupiter registry fetch, so this was
    // comfortably the slowest stretch of a snipe.
    const [bal, beforeBag, meta] = await Promise.all([
      solana.solBalance(conn, signer.address),
      solana.splBalance(conn, signer.address, ca),
      tokenMeta(ca, chainKey),
    ]);
    const gasBuf = solana.solToLamports(CFG.solGasBuffer);
    if (bal < gross + gasBuf) throw new Error(`insufficient SOL — need ~${solana.lamportsToSol(gross + gasBuf).toFixed(4)} incl. fees, have ${solana.lamportsToSol(bal).toFixed(4)}`);
    const before = beforeBag.raw;
    // THE DIVERGENCE GUARD.
    //
    // A user bought a token whose card said $0.00000967 and filled at $0.0000297
    // — 3.07x worse — and lost 78% on a market that had moved 15%. It was not
    // slippage: permitting a 3.07x-worse fill needs 6744 bps and this codebase
    // cannot express more than 5000. It was not a post-quote skim either; that
    // would have broken minOut and reverted. It was that the price on the card
    // and the price of the trade come from two different systems that nothing
    // reconciles — the card from a single DexScreener pair, the fill from
    // Jupiter routing across every AMM — and Jupiter QUOTED 3x worse.
    //
    // So compare them, at the one moment it is still free: after Jupiter has
    // priced the trade and before anything is signed. The reference read is
    // started at the top of this function, concurrently with everything else.
    const onQuote = async (q) => {
      if (!(CFG.solMaxQuoteDivergence > 0)) return;
      // AND IT IS NEVER WAITED FOR.
      //
      // "The reference runs concurrently, so this costs no fill time" was true
      // only while the reference was faster than the quote. When DexScreener is
      // slow it is not, and this await then sat here — between a live quote and
      // the signature — for up to the reference's own 5s timeout, holding a
      // trade for a DISPLAY value. That is the exact rule the guard was written
      // under, broken by the guard.
      //
      // Not a weakening: "no reference is not a reason to block a trade" is
      // already this function's position two lines down. A reference that has
      // not arrived by now is the same as one that never comes.
      const ref = await withTmo(refP.catch(() => null), GUARD_REF_WAIT_MS, null);
      const refPx = ref && ref.priceEth > 0 ? ref.priceEth : 0;
      if (!(refPx > 0) || !(q.outAmount > 0n)) return;   // no reference is not a reason to block a trade
      const outTokens = Number(solana.fmtUnits(q.outAmount, meta.decimals));
      if (!(outTokens > 0)) return;
      const quotedPx = solana.lamportsToSol(spend) / outTokens;   // SOL per token, executable
      const times = quotedPx / refPx;
      if (times > CFG.solMaxQuoteDivergence) {
        const err = new Error(
          `quote is ${times.toFixed(1)}x worse than the price shown (${quotedPx.toPrecision(3)} vs ${refPx.toPrecision(3)} SOL/token) — nothing was sent`);
        err.divergence = times;
        throw err;
      }
    };
    let sig, quote;
    const tSwap = Date.now();
    // WHERE THE TIME WENT, PHASE BY PHASE. Every speed change on this path had
    // been argued from reading the code — which is how the reference-price await
    // survived being described as free for as long as it did. And one opaque
    // `swap=2289ms` cannot separate a slow router from a throttled RPC from a
    // transaction that took ten slots to land; those want three different
    // answers, one of which is not code at all.
    const T = {};
    try { ({ sig, quote } = await solana.swap(conn, kp, { inputMint: solana.WSOL_MINT, outputMint: ca, amountRaw: spend, slippageBps: slip, priorityLamports: CFG.solPriorityLamports, onSent: sent, onQuote, quoteP, timings: T })); }
    catch (e) {
      // Logged on the failure path too: a buy that gave up waiting is the one
      // whose timings most need reading.
      console.log(`[buy] sol ${ca.slice(0, 8)} FAILED reads=${tSwap - tStart}ms ${_phases(T)} prio=${CFG.solPriorityLamports}`);
      const err = new Error('buy failed on Solana: ' + (e.message || e)); if (e && e.broadcast) { err.broadcast = true; err.sig = e.sig; } throw err;
    }
    // `prio` is on this line because a zero priority fee is the difference
    // between landing in the next slot and landing in ten — and it is a default
    // nobody ever sees. One line per buy, ops-side only.
    console.log(`[buy] sol ${ca.slice(0, 8)} reads=${tSwap - tStart}ms ${_phases(T)} prio=${CFG.solPriorityLamports}`);
    const after = (await solana.splBalance(conn, signer.address, ca)).raw;
    const got = after > before ? after - before : (quote ? quote.outAmount : 0n);
    // Jupiter's PROMISE and the wallet's REALITY, on two adjacent lines, never
    // subtracted. A token that skims on transfer (Token-2022 TransferFeeConfig,
    // which nothing in this repo can otherwise see) delivers less than the quote
    // said, and this is the one place the difference is observable for free.
    const shortfall = (quote && quote.outAmount > 0n && got > 0n && got < quote.outAmount)
      ? 1 - Number(got) / Number(quote.outAmount) : 0;
    if (shortfall > 0.01) console.warn(`[sol] ${ca} delivered ${(shortfall * 100).toFixed(1)}% under quote — possible transfer fee`);
    // Broadcast-and-defer, same as EVM — AND NO LONGER AWAITED, even for the
    // broadcast. Deferring the confirmation already took a full confirm round
    // off every fill, but what remained still sat on the critical path between
    // the swap landing and the user seeing a receipt: `getLatestBlockhash`, then
    // a send the RPC SIMULATES first — the fee transfer runs with preflight ON,
    // unlike the swap. Two round trips and a simulation, for a transfer the
    // trader has no stake in and no screen shows.
    //
    // `feeHash` has exactly one reader — `feeCollected` in the ops report — so
    // the REPORT is what waits now, not the receipt, and that flag stays
    // truthful rather than becoming optimistic.
    const feeP = _chargeFeeSol(conn, kp, fee, () => _creditReferral(u, fee, chainKey));
    feeP.catch(() => {});

    const key = posKey(chainKey, ca);
    const p = wal.positions[key] || { chain: chainKey, ca, name: meta.name, sym: meta.sym, dec: meta.decimals, ethIn: 0, ethOut: 0, realizedEth: 0, tokens: '0', costEth: 0 };
    _resetRiskIfFresh(p);
    if (p.costEth == null) p.costEth = Math.max(0, (p.ethIn || 0) - (p.ethOut || 0));   // migrate legacy
    p.name = meta.name; p.sym = meta.sym; p.dec = meta.decimals;
    const spendSol = solana.lamportsToSol(spend);
    p.ethIn += spendSol;
    p.costEth += spendSol;
    p.tokens = after.toString();
    delete p.closed;
    wal.positions[key] = p;
    _pushHistory(wal, { side: 'buy', chain: chainKey, ca, sym: meta.sym, ethAmount: solana.lamportsToSol(spend), tokens: solana.fmtUnits(got, meta.decimals), hash: sig });
    saveStore();
    // `grossEth` is what actually left the wallet for this trade; `spentEth` is
    // what reached the swap. They differ by the bot's own cut, which is taken
    // BEFORE the swap on a buy — so every screen that said "Invested 0.04950"
    // for a 0.05 SOL action was quietly reporting the smaller of the two, in the
    // direction that flatters the trade. `shortfall` is the quote-vs-delivered
    // gap; a receipt that can name it is the only warning a transfer-fee token
    // ever gives.
    // `impactPct` is a PERCENT, and Jupiter's `priceImpactPct` is a FRACTION —
    // "0.0042" means 0.42%. The name is the trap, so the conversion lives here,
    // once, rather than at each screen that prints it. It was parsed by solana.js
    // and read by nothing: the one number that says whether a fill above the
    // displayed price was the pool being thin or our price feed disagreeing with
    // the router. Those need different answers and used to get one shrug.
    const impactPct = quote && Number.isFinite(Number(quote.priceImpactPct)) ? Math.abs(Number(quote.priceImpactPct)) * 100 : 0;
    const res = { chain: chainKey, native: 'SOL', ca, venue: 'jupiter', hash: sig, feeHash: null, spentEth: solana.lamportsToSol(spend), grossEth: solana.lamportsToSol(gross), feeEth: solana.lamportsToSol(fee), gotTokens: solana.fmtUnits(got, meta.decimals), gotRaw: got.toString(), shortfall, impactPct, dec: meta.decimals, sym: meta.sym };
    // The report waits for the fee signature; the RECEIPT does not. `res` is
    // returned before this settles, and nothing user-facing reads `feeHash` —
    // the receipt's fee line is built from `feeEth`, which is arithmetic.
    feeP.then((feeSig) => { res.feeHash = feeSig || null; }).catch(() => {})
      .then(() => _afterTrade(u, 'buy', res)).catch(() => {});
    return res;
  });
}
// Sell `pct`% of the SPL bag `ca` for SOL via Jupiter.
async function _sellSol(u, ca, pct, chainKey, walletId, opts) {
  ca = String(ca || '').trim();
  if (!solana.isSolAddress(ca)) throw new Error('invalid Solana token mint');
  const wal = _resolveWallet(u, walletId);
  // Retry escalation from doSell: widen slippage and raise the Solana priority fee.
  const slipAdd = Math.max(0, Math.round((opts && opts.slipAddBps) || 0));
  const gasMult = Math.max(1, Math.round((opts && opts.gasMult) || 1));
  const sent = (h) => { try { if (opts && opts.onSent && h) opts.onSent(h); } catch (_) {} };
  return withWalletLock(wal.address, async () => {
    const signer = _signer(wal, chainKey);
    const conn = signer.connection, kp = signer.keypair;
    // The bag and the pre-trade SOL balance are read together — an exit should not
    // spend two serial round trips working out what it is about to sell.
    const [bag, solBefore] = await Promise.all([
      solana.splBalance(conn, signer.address, ca),
      solana.solBalance(conn, signer.address),
    ]);
    const bal = bag.raw;
    // AN EXACT AMOUNT, when the caller knows precisely what part of this bag is
    // theirs to sell. Copy-sell does: it may only ever close the slice IT
    // bought, and a percentage cannot express that. A 0.01 ETH slice of a 20 ETH
    // position is 0.05%, which rounds to 0, which the clamp below turns into 1%
    // — twenty times too much of somebody else's money.
    let amount;
    if (opts && opts.exactTokens != null) {
      let want = 0n; try { want = BigInt(opts.exactTokens); } catch (_) { want = 0n; }
      amount = want > bal ? bal : want;   // never more than is actually there
    } else {
      const p0 = Math.max(1, Math.min(100, Math.round(Number(pct) || 0)));
      amount = (bal * BigInt(p0)) / 100n;
    }
    // What fraction of the bag this actually is, for the receipt.
    const p = bal > 0n ? Number((amount * 100n) / bal) : 0;
    if (amount <= 0n) throw new Error('token balance is 0');
    const slip = Math.min(5000, Number(slipBps(u)) + slipAdd);
    const prio = (Number(CFG.solPriorityLamports) || 0) * gasMult + (gasMult > 1 ? 200000 : 0);   // bump priority fee on retry
    let sig, quote;
    try { ({ sig, quote } = await solana.swap(conn, kp, { inputMint: ca, outputMint: solana.WSOL_MINT, amountRaw: amount, slippageBps: slip, priorityLamports: prio, onSent: sent })); }
    catch (e) { const err = new Error('sell failed on Solana: ' + (e.message || e)); if (e && e.broadcast) { err.broadcast = true; err.sig = e.sig; } throw err; }
    const solAfter = await solana.solBalance(conn, signer.address);
    // Net SOL received (swap tx fee already netted out, exactly like EVM ethAfter-ethBefore).
    const proceeds = solAfter > solBefore ? solAfter - solBefore : (quote ? quote.outAmount : 0n);
    const fee = solana.feeLamports(proceeds, CFG.feeBps);
    // Not awaited — see the identical note on the buy path. Same two round trips
    // and the same simulation, on the path to the same receipt.
    const feeP = _chargeFeeSol(conn, kp, fee, () => _creditReferral(u, fee, chainKey));
    feeP.catch(() => {});

    const key = posKey(chainKey, ca);
    const pos = wal.positions[key];
    // HOISTED out of the `if (pos)` block, exactly as the EVM path does with
    // realizedThisSell. It used to live only inside, so the number existed,
    // was computed correctly and was written to the stored position — and then
    // the returned object omitted it. telegram.js reads `Number(r.realizedEth)`,
    // got NaN, and its `Number.isFinite` guard silently dropped the line. Every
    // Solana sell the bot has ever done printed a receipt with no profit or
    // loss on it, on both the single- and multi-wallet paths.
    let realizedThisSell = 0;
    if (pos) {
      if (pos.costEth == null) pos.costEth = Math.max(0, (pos.ethIn || 0) - (pos.ethOut || 0));   // migrate legacy
      const soldFrac = bal > 0n ? Number(amount) / Number(bal) : 1;
      const costOfSold = pos.costEth * Math.min(1, Math.max(0, soldFrac));
      const netProceeds = solana.lamportsToSol(proceeds - fee);
      realizedThisSell = netProceeds - costOfSold;
      pos.ethOut += netProceeds;
      pos.realizedEth = (Number(pos.realizedEth) || 0) + realizedThisSell;
      pos.costEth = Math.max(0, pos.costEth - costOfSold);
      pos.tokens = (await solana.splBalance(conn, signer.address, ca)).raw.toString();
      if (pos.tokens === '0') { pos.costEth = 0; pos.closed = true; }
    }
    _pushHistory(wal, { side: 'sell', chain: chainKey, ca, sym: (pos && pos.sym) || '', ethAmount: solana.lamportsToSol(proceeds), pct: p, hash: sig });
    saveStore();
    // `proceedsEth` is the wallet delta BEFORE the bot's cut — that transfer is
    // broadcast after the delta is measured — so "Total received" was never what
    // landed. `netEth` is. Both are returned: the gross keeps every existing
    // reader working, the net is what a receipt should print, and `realizedEth`
    // is the P/L the EVM path has always returned and this one silently did not.
    // `soldTokens` is HOW MUCH left the wallet, and until now no sell returned
    // it — so a receipt could say "Sold 100%" but never "Sold 10,279,471.93
    // $RUIN", which is the line every other bot leads with and the only one that
    // states the trade in the units the user thinks in. Free here: the amount
    // and the mint's decimals were both already in hand.
    const res = { chain: chainKey, native: 'SOL', ca, venue: 'jupiter', hash: sig, feeHash: null, soldPct: p, soldTokens: Number(solana.fmtUnits(amount, bag.decimals)), proceedsEth: solana.lamportsToSol(proceeds), netEth: solana.lamportsToSol(proceeds - fee), feeEth: solana.lamportsToSol(fee), realizedEth: realizedThisSell, sym: (pos && pos.sym) || '' };
    // Report waits for the fee signature, receipt does not — see the buy path.
    feeP.then((feeSig) => { res.feeHash = feeSig || null; }).catch(() => {})
      .then(() => _afterTrade(u, 'sell', res)).catch(() => {});
    return res;
  });
}
/**
 * How much of a SOL balance a withdrawal may send — and, when it may not, the
 * reason in a sentence the user can act on. PURE: bigints in, a decision out,
 * no RPC, so the rule that made every `max` withdrawal impossible can be tested
 * without a validator.
 *
 * The rule Solana enforces and this bot did not: after the transfer and its fee,
 * the wallet must hold either NOTHING or at least `rentMin`. Anything in between
 * is a "rent-paying" account and the transaction is rejected before it lands —
 * with a simulation error that names neither the balance nor the floor.
 *
 * Which is why a refusal here always names the amounts that WOULD work. The old
 * code sent the transaction and let the simulator do the explaining, and the
 * explaining it did was "insufficient funds for rent".
 */
function solWithdrawPlan(bal, fee, rentMin, amount) {
  const sol = (l) => solana.lamportsToSol(l);
  const isMax = String(amount).toLowerCase() === 'max';
  // `empty` is not a failure: asked to sweep a wallet that holds nothing, doing
  // nothing is the right answer. It matters on a MULTI-wallet sweep, where a red
  // cross beside eight untouched wallets sends people hunting for a fault —
  // the ⚪️-not-❌ rule the trade receipts already follow.
  if (bal <= 0n) return { error: 'this wallet has no SOL to withdraw', empty: true };
  // A sweep lands on the balance EXACTLY. Zero is a legal place to leave an
  // account (it is purged, and reappears on the next deposit); the 10,000-lamport
  // "fee reserve" this replaced was not.
  const lamports = isMax ? bal - fee : solana.solToLamports(amount);
  if (lamports <= 0n) {
    return { empty: isMax, error: isMax
      ? `this wallet holds ${sol(bal)} SOL, which is below the ${sol(fee)} SOL network fee — there is nothing left to send.`
      : 'nothing to withdraw (after fees)' };
  }
  if (lamports + fee > bal) {
    return { error: `amount exceeds balance after the ${sol(fee)} SOL network fee — you can send at most ${sol(bal - fee)} SOL (type "max").` };
  }
  const left = bal - lamports - fee;
  if (left > 0n && left < rentMin) {
    const most = bal - fee - rentMin;
    const alt = most > 0n ? `, or send at most ${sol(most)} SOL to keep it open` : '';
    return { error: `Solana won't let a wallet keep less than ${sol(rentMin)} SOL — sending that much would leave ${sol(left)} SOL behind. Type "max" to empty the wallet${alt}.` };
  }
  return { lamports, isMax, left };
}

/**
 * Withdraw native SOL to a base58 address. `max` sweeps the wallet to EXACTLY
 * zero.
 *
 * THIS USED TO KEEP A 10,000-LAMPORT "FEE RESERVE" BEHIND, and that made every
 * `max` withdrawal in the bot's history impossible — not unlucky, impossible.
 * Solana refuses to leave an account holding more than nothing and less than the
 * rent-exempt minimum (~890,880 lamports); the reserve was 10,000, so the sweep
 * always landed in the one band the runtime rejects, and the user got
 *
 *     ❌ Simulation failed. Transaction results in an account (0) with
 *        insufficient funds for rent
 *
 * which names neither the reserve nor the rule. Zero is a legal destination
 * (the account is purged and reappears the moment somebody sends to it), so a
 * sweep has to land on the balance exactly — hence a MEASURED fee rather than a
 * guessed reserve, from `solana.transferFee`, against the very message that gets
 * signed.
 *
 * An explicit amount can walk into the same band from the other side, so the
 * remainder is checked and REFUSED WITH THE TWO AMOUNTS THAT WOULD WORK. The old
 * code sent it and let the simulator produce the sentence above.
 */
async function _withdrawSol(u, to, amount, chainKey, walletId, guarded) {
  guarded = guarded !== false;
  to = String(to || '').trim();
  if (!solana.isSolAddress(to)) throw new Error('invalid Solana destination address');
  if (guarded) _guardWithdraw(u, to, chainKey);   // vault lock / whitelist / rate limit
  const wal = _resolveWallet(u, walletId);
  return withWalletLock(wal.address, async () => {
    const signer = _signer(wal, chainKey);
    const conn = signer.connection, kp = signer.keypair;
    const [bal, rentMin] = await Promise.all([
      solana.solBalance(conn, signer.address),
      solana.rentExemptMin(conn),
    ]);
    const fee = await solana.transferFee(conn, kp.publicKey, to, bal);
    const plan = solWithdrawPlan(bal, fee, rentMin, amount);
    if (plan.error) { const e = new Error(plan.error); e.empty = !!plan.empty; throw e; }
    if (guarded) _noteWithdraw(u);
    const sig = await solana.sendSol(conn, kp, to, plan.lamports);
    return { hash: sig, sentEth: solana.lamportsToSol(plan.lamports), native: 'SOL', swept: plan.isMax };
  });
}

// ---------------------------------------------------------------- v4 approvals
/**
 * The Permit2 approvals a v4 swap needs before it can pull an ERC20 — the token
 * on a sell, wrapped native on a WETH-quoted buy.
 *
 * Returns the router the allowance was granted to. That matters because of an
 * ordering problem with no way around it: the router cannot be ELECTED by
 * simulation until it has an allowance, and the allowance cannot be granted
 * until a router has been picked. So the top-ranked candidate is approved, and
 * if the simulation then proves it wrong the caller demotes it — the retry
 * approves somebody else instead of failing identically forever.
 *
 * A v4 pool's counterparty is the router, not a pair contract, so this replaces
 * ensureApprove on this path rather than adding to it.
 */
async function _v4Approve(wallet, chainKey, pool, token, amount, gasMult, gas) {
  const deps = { chainOf, providerFor };
  const discToken = String(pool.tokenIsZero ? pool.currency0 : pool.currency1);
  const c = await v4.cfgLive(chainKey, discToken, deps).catch(() => null);
  const cands = c ? await v4.routerCandidates(chainKey, c, deps).catch(() => []) : [];
  const router = cands[0] || null;
  const pre = await v4.permit2Calls(providerFor(chainKey), chainKey, token, wallet.address, amount, router);
  // null is a REFUSAL, not "nothing to do": no Permit2 on this chain means the
  // router can never be funded, and sending the swap anyway buys a revert.
  if (!pre) throw new Error(`a Uniswap v4 swap on ${chainOf(chainKey).name} needs Permit2, and there is no contract at its address there — set ${chainKey.toUpperCase()}_V4_PERMIT2 to this chain's deployment`);
  for (const c2 of pre) {
    const h = await rawSend(wallet, chainKey, c2.to, c2.data, 150000n, 0n, gasMult, { fee: gas });
    const r = await waitHash(h, chainKey);
    if (r && r.status === 0) throw new Error(`could not ${c2.what} — the approval reverted. Tx: ${h}`);
  }
  return router;
}

// ---------------------------------------------------------------- trade
// Buy `ethAmount` (human native) of `ca` on the user's active chain (or chainKey).
// `opts.onSent(hash)` fires the MOMENT the transaction is broadcast, before any
// waiting for it to confirm. On a 12-second chain that is the difference between
// a user watching a static "Buying…" line for a whole block and a user holding a
// live explorer link one second in. The trade itself is unaffected — the hook is
// invoked fire-and-forget and can never delay or fail a fill.
async function buy(chatId, ca, ethAmount, chainKey, walletId, opts) {
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  chainKey = chainKey || userChain(u);
  const sent = (h) => { try { if (opts && opts.onSent && h) opts.onSent(h); } catch (_) {} };
  if (isSvm(chainKey)) return _buySol(u, ca, ethAmount, chainKey, walletId, opts);
  const wal = _resolveWallet(u, walletId);
  return withWalletLock(wal.address, async () => {
    chainKey = chainKey || userChain(u);
    const chain = chainOf(chainKey);
    const wallet = _signer(wal, chainKey);
    const gross = ethers.parseEther(String(ethAmount));
    if (gross <= 0n) throw new Error('amount must be > 0');
    const deadline = Math.floor(Date.now() / 1000) + 600;
    // The user's own gas priority is the FLOOR; a caller may escalate above it.
    // sell() has taken opts.gasMult/opts.slipAddBps since the retry work — buy()
    // did not, so a triggered limit buy went out at ordinary priority however
    // urgent the fill was. The two sides are symmetric now.
    const gasBoost = Math.max(userGasBoost(u), (opts && opts.gasMult) || 1);
    const slipAdd = BigInt(Math.max(0, Math.round((opts && opts.slipAddBps) || 0)));
    const slip = (() => { const s = slipBps(u, opts && opts.slipBps) + slipAdd; return s > 5000n ? 5000n : s; })();   // capped 50%

    // PREFLIGHT — IN PARALLEL. These four reads do not depend on each other, and
    // they used to run strictly in series: balance, then curve, then gas, then the
    // pre-trade token balance. That is four full RPC round trips (~0.6-2s on a
    // public node) spent before the bot even knew where it was routing, on every
    // single buy. As one batch it is one round trip.
    //
    // Token metadata is kicked off here too and deliberately NOT awaited: it is
    // only needed after the fill, so starting it now means it has already resolved
    // (and cached) by the time the receipt lands, instead of adding round trips to
    // the stretch where the user is watching a "Buying…" message.
    const metaP = tokenMeta(ca, chainKey).catch(() => ({ name: 'Token', sym: 'TOKEN', decimals: 18 }));
    const [bal, curve, gas, before] = await Promise.all([
      ethBalance(wallet.address, chainKey),
      resolveCurve(ca, chainKey),
      gasOverrides(chainKey, gasBoost),
      tokenBalance(ca, wallet.address, chainKey),
    ]);
    // L1 Ethereum gas dwarfs the L2 default — reserve more so a buy isn't left
    // unable to pay for its own swap.
    const gasBuf = gasBufferWei(chainKey);
    if (bal < gross + gasBuf) throw new Error(`insufficient ${chain.native} — need ~${ethers.formatEther(gross + gasBuf)} incl. gas, have ${Number(ethers.formatEther(bal)).toFixed(5)}`);
    const fee = (gross * BigInt(CFG.feeBps)) / 10000n;
    const spend = gross - fee;
    const grad = curve ? await isGraduated(curve, chainKey) : true;

    let venue, hash, trc;
    // What checked this trade, when it went through a DISCOVERED curve. A gate
    // nobody can read is the same as no gate — the receipt says which price
    // agreed, and says when it was the weak one.
    let curveVia = null;
    // …and, on a pad that charges in its own token, the leg that got us there.
    // Two transactions for one tap is a fact the receipt has to carry.
    let quoteLeg = null;
    if (curve && !grad) {
      const cc = new ethers.Contract(curve, CURVE_ABI, wallet);
      let minTok;
      try { const exp = await cc.buy.staticCall(0n, deadline, { value: spend }); minTok = exp * (10000n - slip) / 10000n; }
      catch (e) { throw new Error('could not quote this buy (try again / lower amount): ' + (e.shortMessage || e.message || e)); }
      // rawSend, NOT cc.buy(...): the Robinhood node rejects ethers' estimate/send
      // envelope (same reason curve SELL, withdraw and _chargeFee use rawSend) —
      // a plain cc.buy could throw the opaque "could not coalesce error" there.
      const data = cc.interface.encodeFunctionData('buy', [minTok, deadline]);
      hash = await rawSend(wallet, chainKey, curve, data, 600000n, spend, gasBoost, { fee: gas });
      venue = 'curve'; sent(hash); trc = await waitBuyReceipt(() => waitHash(hash, chainKey));
      if (trc && trc.status === 0) throw new Error('the buy reverted on-chain — you may not be allowed to buy this token yet (private beta), or try a smaller amount. Tx: ' + hash);
    } else {
      const dexSlip = slip + 1200n > 5000n ? 5000n : slip + 1200n;
      const pick = await bestDexVenue(ca, chainKey);
      // No V2 pair and no V3 pool — but the token may still be trading, on a
      // venue with nothing for a factory lookup to return (Uniswap v4 keeps every
      // pool inside one PoolManager). Say which venue, instead of the old
      // "no pool? try again", which sends the user to retry a buy that can never
      // fill no matter how many times they press it.
      if (pick.kind === 'v2' && !_v2Fillable(pick)) {
        // NOT gated on v4.canSwap() any more. That asked "has an operator pasted
        // a Universal Router into .env?", and the answer being no is why a token
        // with a live pool and real liquidity was told Dexvra could not route to
        // it. v4.js finds the PoolManager and the router from the chain's own
        // logs when the env is unset, so the question to ask is whether a pool
        // EXISTS — and then to prove the route by simulating it.
        const p4 = await v4.bestPool(ca, chainKey, { chainOf, providerFor }).catch(() => null);
        if (p4) {
          const dec4 = await tokenDecimals(ca, chainKey);
          // The currency this pool actually TAKES. A v4 pool pairs against ETH
          // directly (address(0)) or against WETH, and the old code paid every
          // pool in native — which on a WETH-quoted pool made zeroForOne come
          // out backwards and built a SELL while the user was buying.
          /*
           * ⚠️ THE POOL'S QUOTE IS NOT ALWAYS NATIVE OR WETH, and reading it as
           * "not native ⇒ WETH" is what kept a whole class of token unbuyable.
           *
           * `bestPool` finds a pool of ANY pairing — `discoverPoolKeys` reads
           * the whole PoolKey off the Initialize log and takes whichever
           * currency is not ours, verified by recomputing the poolId. But the
           * payment side assumed only two currencies could ever come back, so a
           * pool quoted in a THIRD token wrapped the user's native into WETH,
           * approved WETH, and then tried to swap a token it did not hold.
           *
           * That is the real reason a Pons token on Robinhood Chain would not
           * trade: $CD's pool is quoted in NVDA. The venue was found, the price
           * was right, and the payment was built in the wrong currency.
           *
           * A launchpad pairing against something other than the native coin is
           * the ordinary case on a chain of tokenised assets, and it is exactly
           * what `_acquireQuote` was written for one branch down — swap into
           * what the venue takes, approve exactly that, then swap. This reuses
           * it rather than growing a second idea of the same two legs.
           *
           * ⚠️ EVERY ADDRESS HERE COMES FROM THE CHAIN. `p4.quote` is a field of
           * the PoolKey whose id was recomputed and matched; no launchpad, and
           * no guess, reaches this line.
           */
          const payWith = String(p4.quote).toLowerCase();
          const wethAddr = _isAddr(chain.weth) ? String(chain.weth).toLowerCase() : '';
          const wrapping = !!wethAddr && payWith === wethAddr;
          const foreign = payWith !== v4.NATIVE && !wrapping;

          // Leg one, and ONLY for a third currency: buy what the pool takes.
          // Sized in that token from here on — quoting a foreign-quoted pool
          // with a native amount prices the trade in the wrong unit entirely.
          let payAmt = spend;
          if (foreign) {
            const leg = await _acquireQuote(wallet, chainKey, payWith, spend, slip, gasBoost, gas, sent);
            payAmt = leg.got;
          }
          // ⚠️ WHAT THE USER IS HOLDING IF THE NEXT STEP FAILS. Money that moved
          // and did not arrive where they expected is a fact they are owed
          // immediately, not one they find in a block explorer — the precedent
          // the WETH branch set with "Your ETH is safe as WETH in the wallet".
          const safe = foreign
            ? ` Your ${ethers.formatEther(spend)} ${chain.native} is now this pool's own quote token in your wallet — nothing is lost, and selling it back is one tap on 📤.`
            : (wrapping ? ` Your ${chain.native} is safe as W${chain.native} in the wallet.` : '');

          // Quoted off the pool's OWN depth and fee, not its spot price. Spot
          // charges no fee and has no depth term, so on the thin pools this
          // feature exists for it overstated the fill and quietly spent the
          // user's slippage before their slippage had protected anything.
          let expTok = v4.quoteExactIn(p4, payAmt, payWith);
          if (expTok <= 0n) {
            // No in-range liquidity to walk (an empty tick) — fall back to spot
            // so a quotable pool still trades, with slippage as the only floor.
            const px = v4.priceNativeFromSqrt(p4.sqrtPriceX96, dec4, p4.tokenIsZero);
            if (!(px > 0)) throw new Error(`the v4 pool did not price — try again.${safe}`);
            expTok = (payAmt * 10n ** BigInt(dec4)) / BigInt(Math.max(1, Math.round(px * 1e18)));
          }
          const minTok = expTok * (10000n - slip) / 10000n;
          if (minTok <= 0n) throw new Error(`zero quote from the v4 pool for this token.${safe}`);
          // A WETH-quoted pool is paid in WETH, so the native has to be wrapped
          // and handed to Permit2 before the router can pull it. A foreign-quoted
          // one is already held after leg one and only needs the allowance.
          let approved = null;
          if (wrapping) {
            const wi = new ethers.Interface(WETH9_ABI);
            const wh = await rawSend(wallet, chainKey, chain.weth, wi.encodeFunctionData('deposit', []), 150000n, spend, gasBoost, { fee: gas });
            const wr = await waitHash(wh, chainKey);
            if (wr && wr.status === 0) throw new Error(`could not wrap ${chain.native} for this v4 pool — nothing else was sent. Tx: ${wh}`);
            approved = await _v4Approve(wallet, chainKey, p4, chain.weth, payAmt, gasBoost, gas);
          } else if (foreign) {
            approved = await _v4Approve(wallet, chainKey, p4, payWith, payAmt, gasBoost, gas);
          }
          const prep = await v4.prepareSwap(providerFor(chainKey), chainKey, p4, wallet.address,
            { tokenIn: payWith, amountIn: payAmt, minOut: minTok, deadline }, { chainOf, providerFor });
          // SIMULATED BEFORE SIGNED, and that is also how the router is chosen —
          // a candidate that cannot fill this exact calldata for free never gets
          // to fill it for money.
          if (prep.err) {
            if (approved) v4.demoteRouter(chainKey, approved);
            throw new Error(`the v4 swap would revert (${prep.err}) — nothing was sent.${safe}`);
          }
          hash = await rawSend(wallet, chainKey, prep.call.to, prep.call.data, 700000n, prep.call.value, gasBoost, { fee: gas });
          venue = 'dex·v4'; sent(hash); trc = await waitBuyReceipt(() => waitHash(hash, chainKey));
          if (trc && trc.status === 0) throw new Error('the v4 buy reverted on-chain (price moved past your slippage, or gas) — try again. Tx: ' + hash);
        } else {
          /*
           * NO POOL ANYWHERE — so this is a token still on a launchpad's
           * bonding curve, and the curve is the only place to buy it.
           *
           * ⚠️ THIS ONE INSERTION CLOSES TWO DEAD ENDS, and the second is the
           * one the target tokens actually hit. The throw below is guarded on
           * `m`, and a pre-migration token has no indexed pool, so `marketOf`
           * returns null, nothing is thrown, and control used to fall through
           * to the V2 router and die at `getAmountsOut` with "no pool? try
           * again". Setting `hash` here makes the `if (!hash)` guard below
           * false, which skips both.
           *
           * ⚠️ AND THE FIRST ARGUMENT IS THE PROVIDER, NOT `chain`. The local
           * `chain` is the config record from `chainOf` and has no `getLogs`;
           * passing it does not throw — it returns "could not read the chain
           * head (chain.getBlockNumber is not a function)" and the buy falls
           * straight back to the old sentence. The feature would ship INERT
           * with no error anywhere.
           */
          // ⚠️ SWITCHED OFF MEANS THE OLD BEHAVIOUR, EXACTLY. A kill switch that
          // leaves a new sentence behind is a kill switch that half-works: the
          // operator who turned it off gets a message about a feature they
          // disabled instead of the one they had before it shipped.
          const curveT0 = Date.now();
          const iface = CURVE_ROUTE_ON ? await _curveIface(chainKey, ca) : { ok: false, why: null };
          let why = iface.why;
          if (iface.ok) {
            // The independent price FIRST. It is what `sane()` is checked
            // against, and — when it is a strong one — it is also the floor the
            // call carries on-chain, which is strictly better than stretching a
            // stranger's bound across a convex curve.
            let exp = await curvePrice.expectedTokensFor(chainKey, ca, spend, _curveDeps(iface));
            /*
             * ⚠️ A QUOTE-TOKEN PAD MAY NOT BE PRICEABLE UNTIL AFTER LEG ONE,
             * and that must not be discovered by spending first.
             *
             * The observed tier is a rate per unit of what the pad CHARGES, so
             * on such a pad it can only be turned into a token count once we
             * know how much of that token we hold — which is after the swap.
             * Whether that rate EXISTS is knowable now, from the samples alone,
             * so the refusal still happens before any money moves.
             */
            const padCharges = !!(iface.buy && !iface.buy.native && iface.buy.quote);
            const laterRate = padCharges && !!curvePrice.observedRate(iface.buy);
            if (!exp.ok && !laterRate) why = exp.why;
            else {
              const args = {
                wallet: wallet.address,
                valueWei: spend,
                slippageBps: Number(slip),          // slip is a BigInt here; Math.min inside would throw on one
                expectedTokens: exp.ok ? exp.raw : 0n,
                tolPct: exp.tolPct,
                // A weak price may check the interface but may not become the
                // on-chain floor: it is read from the same trades the interface
                // is, so the size band stays in force for it.
                minOutRaw: exp.ok && !exp.weak ? exp.raw : undefined,
              };
              let prep = await curveTrade.prepareBuy(providerFor(chainKey), chainKey, ca, args);
              /*
               * THE PAD CHARGES IN ITS OWN TOKEN. Swap into it, approve the
               * curve for exactly that, and build again.
               *
               * ⚠️ AND THE INDEPENDENTLY-PRICED FLOOR IS DROPPED FOR THIS LEG.
               * It was computed for the native we no longer hold in full — leg
               * one spent its own slippage — so carrying it over would set a
               * bound above what the curve can now pay and revert our own buy.
               * The ratio-derived bound applies instead, which is sized in the
               * quote token and therefore in the same units as what we hold,
               * and the size band stays in force for it.
               */
              if (!prep.ok && prep.stage === 'quote' && prep.quoteToken) {
                const leg = await _acquireQuote(wallet, chainKey, prep.quoteToken, spend, slip, gasBoost, gas, sent);
                const safe = ` Your ${ethers.formatEther(spend)} ${chain.native} is now this pad's own token in your wallet — nothing is lost, and selling it back is one tap on 📤.`;
                try {
                  await approveExact(wallet, prep.quoteToken, iface.curve, leg.got, chainKey, gasBoost, gas);
                } catch (e) { throw new Error(`${(e && e.message) || e}${safe}`); }
                // Priced again, now in the pad's OWN denomination — the only
                // basis on which the observed tier means anything here.
                const exp2 = await curvePrice.expectedTokensFor(chainKey, ca, spend, _curveDeps(iface), { sizeRaw: leg.got });
                if (!exp2.ok) throw new Error(`${exp2.why}${safe}`);
                exp = exp2;
                prep = await curveTrade.prepareBuy(providerFor(chainKey), chainKey, ca, {
                  ...args, valueWei: 0n, quoteRaw: leg.got, minOutRaw: undefined,
                  expectedTokens: exp2.raw, tolPct: exp2.tolPct,
                });
                if (!prep.ok) throw new Error(`Dexvra could not build a safe buy on this token's launchpad curve (${prep.why}).${safe}`);
                quoteLeg = { token: prep.quoteToken, raw: leg.got, hash: leg.hash };
              }
              if (!prep.ok) why = prep.why;
              else {
                curveVia = { source: exp.source, weak: !!exp.weak, curve: prep.call.to, bound: !!prep.boundedByIndependentPrice, quote: quoteLeg };
                hash = await rawSend(wallet, chainKey, prep.call.to, prep.call.data, _curveGas(prep.gas), prep.call.value, gasBoost, { fee: gas });
                venue = 'curve·obs'; sent(hash); trc = await waitBuyReceipt(() => waitHash(hash, chainKey));
                if (trc && trc.status === 0) throw new Error('the curve rejected this buy on-chain — nothing was bought. Tx: ' + hash);
              }
            }
          }
          if (hash) {
            // Filled on the discovered curve. The shared tail below books it
            // exactly as it books every other venue.
          } else {
            const m = await marketOf(ca, chainKey).catch(() => null);
            // ⚠️ THE WORDING DECIDES WHETHER A SNIPE RETRIES THIS. watchers.js
            // excludes anything matching /route through/i from the retry ring,
            // on the reasoning that an unroutable venue will not change. A
            // curve refusal that one more trade on the pad would fix must NOT
            // carry that phrase, or the ring drops a launch it could have
            // filled two minutes later.
            if (m && !why) throw new Error(`this token's liquidity is on ${dsVenueLabel(m)}, which Dexvra can't route through yet — no swap to sign`);
            if (why) { _curveRefused('buy', chainKey, ca, curveT0, why); throw new Error(`Dexvra could not build a safe buy on this token's launchpad curve (${why}) — nothing was sent`); }
            // Neither — which only happens with the route switched off and the
            // token unindexed. Fall through untouched, so the V2 leg reports it
            // exactly as it did before this feature existed.
          }
        }
      }
      if (!hash) {
      // NO price-impact ceiling. Operator's rule: the user must always be able
      // to buy. Their slippage is the only limit that applies, and the on-chain
      // minOut below enforces it — a trade that would fill worse than they
      // asked for reverts by itself, which is the protection that actually
      // works. A pre-trade refusal only ever lost trades the competition took.
      // Do not reintroduce one here or in the UI.
      if (pick.kind === 'v3') {
        // Deepest liquidity is a Uniswap V3 pool. minOut is floored off the pool's
        // slot0 SPOT (v3ExpectedOutRaw has no depth term) using ONLY the user's own
        // slippage — NOT the extra +1200bps V2 padding. This is deliberate: slot0
        // can't see concentrated-liquidity depth, so the tight floor makes a buy
        // that would actually fill worse than the user's slippage REVERT instead of
        // silently filling at a loss (audit B1). Gas is estimated (audit B2).
        const v3 = v3Cfg(chainKey);
        const expTok = await v3ExpectedOutRaw(chainKey, pick.pool, pick.feeTier, chain.weth, spend);
        if (expTok == null || expTok <= 0n) throw new Error('could not price this buy on ' + chain.name + ' V3 (pool read failed) — try again');
        const minTok = expTok * (10000n - slip) / 10000n;
        if (minTok <= 0n) throw new Error('no V3 liquidity / zero quote for this token on ' + chain.name);
        const ri = new ethers.Interface(V3_ROUTER_ABI);
        const dataV3 = ri.encodeFunctionData('exactInputSingle', [{ tokenIn: chain.weth, tokenOut: ca, fee: pick.feeTier, recipient: wallet.address, amountIn: spend, amountOutMinimum: minTok, sqrtPriceLimitX96: 0n }]);
        const gLim = await v3SwapGas(chainKey, wallet.address, v3.router, dataV3, spend);
        hash = await rawSend(wallet, chainKey, v3.router, dataV3, gLim, spend, gasBoost, { fee: gas });
        venue = 'dex·v3'; sent(hash); trc = await waitBuyReceipt(() => waitHash(hash, chainKey));
        if (trc && trc.status === 0) throw new Error('the V3 buy reverted on-chain (price moved past your slippage, or gas) — try again or a smaller amount. Tx: ' + hash);
      } else {
        const router = new ethers.Contract(chain.router, ROUTER_ABI, wallet);
        let expTok = 0n;
        try { const amts = await router.getAmountsOut(spend, [chain.weth, ca]); expTok = amts[1]; }
        catch (e) { throw new Error('could not quote this buy on ' + chain.name + ' (no pool? try again): ' + (e.shortMessage || e.message || e)); }
        const minTok = expTok > 0n ? expTok * (10000n - dexSlip) / 10000n : 0n;
        if (minTok <= 0n) throw new Error('no liquidity / zero quote for this token on ' + chain.name);
        const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(minTok, [chain.weth, ca], wallet.address, deadline, { value: spend, ...gas });
        venue = 'dex'; hash = tx.hash; sent(hash); trc = await waitBuyReceipt(() => waitBounded(tx));
        if (trc && trc.status === 0) throw new Error('the buy reverted on-chain (price moved past your slippage, or gas) — try again or a smaller amount. Tx: ' + hash);
      }
      }
    }
    // metaP was started with the preflight and is almost always already resolved;
    // the balance read is the only thing genuinely outstanding here.
    const [after, meta] = await Promise.all([tokenBalance(ca, wallet.address, chainKey), metaP]);
    const got = after > before ? after - before : 0n;
    // Confirmed = receipt status 1 (waitBounded returns it; a revert would have
    // thrown) OR a positive balance change. Only "pending" if BOTH the receipt
    // timed out (null) AND the balance read shows no gain — so a successful buy
    // whose balance read merely failed isn't falsely retried (double-buy).
    /*
     * ⚠️ A CONFIRMED CURVE BUY THAT RECEIVED NOTHING IS A FAILURE, and only on
     * this venue is that state reachable.
     *
     * The guard below needs BOTH a missing receipt AND no balance gain, so a
     * receipt with `status === 1` and zero tokens falls straight through and is
     * booked as a completed buy: full cost added to the position, `gotTokens:
     * 0`, and a green tick on the receipt. On v2/v3/v4 a positive minimum-out
     * makes that impossible; a discovered curve makes it reachable — a constant
     * slot that is really a recipient delivers the tokens elsewhere, a replayed
     * `minOut = 0` leaves no on-chain protection at all, and a mint into a
     * vesting escrow looks identical.
     *
     * `broadcast` because the transaction DID land: the caller must not roll
     * back a budget or re-arm a snipe on it.
     */
    if (venue === 'curve·obs' && got <= 0n) {
      const e = new Error('the curve accepted the transaction but no tokens reached your wallet — check it before retrying. Tx: ' + hash);
      e.broadcast = true; throw e;
    }
    if (!trc && got <= 0n) {
      // Broadcast succeeded but we can't confirm the fill (receipt timed out AND the
      // balance read shows no gain). The tx MAY still land, so tag it: callers that
      // committed budget/dedup before the buy (copy-trade) must NOT roll it back.
      const e = new Error('trade sent but not confirmed / no tokens received yet — check your wallet before retrying. Tx: ' + hash);
      e.broadcast = true; throw e;
    }

    // Broadcast the fee and move on — the referral credit fires from the
    // background confirmation (see _chargeFee), so it stays gated on the fee
    // actually landing without the fill waiting for it.
    const feeHash = await _chargeFee(wallet, fee, chainKey, () => _creditReferral(u, fee, chainKey));

    const key = posKey(chainKey, ca);
    const p = wal.positions[key] || { chain: chainKey, ca, name: meta.name, sym: meta.sym, dec: meta.decimals, ethIn: 0, ethOut: 0, realizedEth: 0, tokens: '0', costEth: 0 };
    _resetRiskIfFresh(p);
    // costEth = cost basis of the CURRENTLY-HELD tokens (drained proportionally on
    // sells). ethIn/ethOut stay as LIFETIME totals for the ×-multiple/stats.
    // Migrate a legacy position (no costEth) from its net cash still in the trade.
    if (p.costEth == null) p.costEth = Math.max(0, (p.ethIn || 0) - (p.ethOut || 0));
    p.name = meta.name; p.sym = meta.sym; p.dec = meta.decimals;
    const spendEth = Number(ethers.formatEther(spend));
    p.ethIn += spendEth;       // lifetime invested
    p.costEth += spendEth;     // basis of the held bag
    p.tokens = after.toString();
    delete p.closed;
    wal.positions[key] = p;
    _pushHistory(wal, { side: 'buy', chain: chainKey, ca, sym: meta.sym, ethAmount: Number(ethers.formatEther(spend)), tokens: Number(ethers.formatUnits(got, meta.decimals)), hash });
    saveStore();

    const res = { chain: chainKey, native: chain.native, ca, venue, hash, feeHash, spentEth: Number(ethers.formatEther(spend)), feeEth: Number(ethers.formatEther(fee)), gotTokens: Number(ethers.formatUnits(got, meta.decimals)), gotRaw: got.toString(), dec: meta.decimals, sym: meta.sym, curveVia };
    _afterTrade(u, 'buy', res).catch(() => {});   // account + report (fire-and-forget)
    return res;
  });
}

async function sell(chatId, ca, pct, chainKey, walletId, opts) {
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  chainKey = chainKey || userChain(u);
  if (isSvm(chainKey)) return _sellSol(u, ca, pct, chainKey, walletId, opts);
  const wal = _resolveWallet(u, walletId);
  // Retry escalation (from doSell): opts.gasMult raises the gas price, opts.slipAddBps
  // widens slippage — so a sell rejected for gas or a tight quote can be re-tried harder.
  // The user's own gas-priority setting is the FLOOR, so a normal (first-try) sell
  // already honours Fast/Turbo; retries escalate above it.
  const gasMult = Math.max(userGasBoost(u), (opts && opts.gasMult) || 1);
  const slipAdd = BigInt(Math.max(0, Math.round((opts && opts.slipAddBps) || 0)));
  const sent = (h) => { try { if (opts && opts.onSent && h) opts.onSent(h); } catch (_) {} };
  return withWalletLock(wal.address, async () => {
    chainKey = chainKey || userChain(u);
    const chain = chainOf(chainKey);
    const wallet = _signer(wal, chainKey);
    const erc = new ethers.Contract(ca, ERC20_ABI, wallet);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    // Same story as buy(): the bag size, the curve lookup and the gas price are
    // three independent reads that were awaited one after another. An exit is the
    // trade where latency is felt most, so they go out together.
    // `dec` rides along for the RECEIPT, not for the trade: it is what turns a
    // raw u256 into "10,279,471.93 $RUIN". Added to this wave rather than
    // awaited on its own, and tokenDecimals answers from _metaCache on anything
    // the user has already opened a card for — so on the exit path, where
    // latency is felt most, it normally costs nothing at all.
    const [bal, curve, gas, dec] = await Promise.all([
      erc.balanceOf(wallet.address),
      resolveCurve(ca, chainKey),
      gasOverrides(chainKey, gasMult),
      tokenDecimals(ca, chainKey).catch(() => 18),
    ]);
    // AN EXACT AMOUNT, when the caller knows precisely what part of this bag is
    // theirs to sell. Copy-sell does: it may only ever close the slice IT
    // bought, and a percentage cannot express that. A 0.01 ETH slice of a 20 ETH
    // position is 0.05%, which rounds to 0, which the clamp below turns into 1%
    // — twenty times too much of somebody else's money.
    let amount;
    if (opts && opts.exactTokens != null) {
      let want = 0n; try { want = BigInt(opts.exactTokens); } catch (_) { want = 0n; }
      amount = want > bal ? bal : want;   // never more than is actually there
    } else {
      const p0 = Math.max(1, Math.min(100, Math.round(Number(pct) || 0)));
      amount = (bal * BigInt(p0)) / 100n;
    }
    // What fraction of the bag this actually is, for the receipt.
    const p = bal > 0n ? Number((amount * 100n) / bal) : 0;
    if (amount <= 0n) throw new Error('token balance is 0');

    const grad = curve ? await isGraduated(curve, chainKey) : true;
    const slip = (() => { let s = slipBps(u) + slipAdd; return s > 5000n ? 5000n : s; })();   // capped 50%
    const onCurve = !!(curve && !grad);
    // DEX sells route to whichever venue is deepest (V2 pair vs V3 pool) — the
    // approval must target that venue's router, so pick it before approving.
    const pick = onCurve ? null : await bestDexVenue(ca, chainKey);
    const v3 = pick && pick.kind === 'v3' ? v3Cfg(chainKey) : null;
    // A v4 bag has no V2 pair and no V3 pool to approve, and its exit runs
    // through Permit2 rather than a plain allowance — so it is resolved here,
    // alongside the venue pick, and skips ensureApprove entirely. Buying into a
    // venue that cannot be sold out of would be a trap, so this is not optional.
    // ONE reading of "there is no AMM pair worth routing to", used by the v4
    // probe and by the discovered-curve fallback below it. Two copies of this
    // predicate would eventually disagree about which bags have an exit.
    const noAmm = !onCurve && pick.kind === 'v2' && !_v2Fillable(pick);
    const p4Sell = noAmm
      ? await v4.bestPool(ca, chainKey, { chainOf, providerFor }).catch(() => null)
      : null;
    /*
     * A BAG WITH NO POOL TO SELL INTO — the exit side of the discovered curve.
     *
     * ⚠️ IT IS PREPARED HERE, ABOVE THE `ethBefore` SNAPSHOT, and that placement
     * is load-bearing: an approval sent after the snapshot has its gas
     * subtracted from the native balance delta, and on a curve sell that delta
     * IS the proceeds figure — so the bot's fee, the receipt and the stored
     * realised P/L would all be understated. The comment on the existing
     * `ensureApprove` line says the same thing and this path has to obey it.
     *
     * ⚠️ AND WIRING THE SELL IS NOT OPTIONAL ONCE THE BUY IS WIRED. A position
     * the bot can open and cannot close is the stop-loss-the-user-believes-
     * exists, one field over — and there is no `resolveCurve` for these tokens,
     * so nothing else in this function can reach them.
     */
    let obsSell = null, obsWhy = null, obsVia = null;
    const curveT0 = Date.now();
    const noVenue = CURVE_ROUTE_ON && noAmm && !p4Sell;
    if (noVenue) {
      const iface = await _curveIface(chainKey, ca);
      obsWhy = iface.why;
      if (iface.ok && !iface.sell) obsWhy = 'no SELL has been seen through this curve yet — one sale by anyone on the pad teaches it';
      else if (iface.ok) {
        const exp = await curvePrice.expectedNativeFor(chainKey, ca, amount, _curveDeps(iface));
        if (!exp.ok) obsWhy = exp.why;
        else {
          const args = {
            wallet: wallet.address, amountRaw: amount, slippageBps: Number(slip),
            expectedNative: exp.raw, tolPct: exp.tolPct,
            minOutRaw: exp.weak ? undefined : exp.raw,
          };
          const have = await erc.allowance(wallet.address, iface.curve).catch(() => 0n);
          let prep = await curveTrade.prepareSell(providerFor(chainKey), chainKey, ca, { ...args, allowance: have });
          // ⚠️ ONE retry, never a loop. `approveExact` re-reads the allowance
          // and an RPC failure there reads as 0 — a while-loop on that spins
          // for ever, granting an approval per turn.
          if (!prep.ok && prep.stage === 'approve') {
            const now = await approveExact(wallet, ca, prep.needsApprove.spender, prep.needsApprove.amountRaw, chainKey, gasMult, gas);
            prep = await curveTrade.prepareSell(providerFor(chainKey), chainKey, ca, { ...args, allowance: now });
          }
          if (prep.ok) { obsSell = prep; obsVia = { source: exp.source, weak: !!exp.weak, curve: prep.call.to, bound: !!prep.boundedByIndependentPrice }; }
          else obsWhy = prep.why;
        }
      }
    }
    if (!p4Sell && !obsSell) {
      const spender = onCurve ? curve : (v3 ? v3.router : chain.router);
      // ⚠️ AND NOT AT ALL WHEN THERE IS NOWHERE TO SELL. This used to grant an
      // unlimited allowance to the V2 router for a bonding-curve token whose
      // pair does not exist, then fail at `getAmountsOut` — an approval for a
      // route that can never run, on every attempt, before the curve route was
      // even a thing.
      if (!noVenue) await ensureApprove(wallet, ca, spender, amount, chainKey);   // before ethBefore snapshot
    }
    const ethBefore = await ethBalance(wallet.address, chainKey);

    // v3ProceedsWei: the WETH the swap produced — the accounting source of truth
    // for any venue that pays out in WETH rather than native (V3 always, v4 when
    // the pool is WETH-quoted). v4QuoteToken names that token, or is null when
    // the pool paid native and the balance delta is the source.
    let venue, hash, trc, v3ProceedsWei = null, v4QuoteToken = null;
    let realizedThisSell = 0;   // profit/loss realized on this specific sell (for the receipt)
    // What actually LEFT the wallet, for the receipt. Normally `amount`, but the
    // curve path shaves the last dust off to get a full exit past the reserve
    // boundary (see the loop below) — and a receipt that prints the amount we
    // ASKED to sell rather than the amount that sold is a receipt that will not
    // reconcile against the explorer.
    let filledRaw = amount;
    if (p4Sell) {
      const dec4 = await tokenDecimals(ca, chainKey);
      // Same depth-aware quote as the buy: the pool's own fee and liquidity,
      // falling back to spot only when there is no in-range liquidity to walk.
      let expEth = v4.quoteExactIn(p4Sell, amount, ca);
      if (expEth <= 0n) {
        const px = v4.priceNativeFromSqrt(p4Sell.sqrtPriceX96, dec4, p4Sell.tokenIsZero);
        if (!(px > 0)) throw new Error('the v4 pool did not price — try again');
        expEth = (amount * BigInt(Math.max(1, Math.round(px * 1e18)))) / 10n ** BigInt(dec4);
      }
      const minEth4 = expEth * (10000n - slip) / 10000n;
      if (minEth4 <= 0n) throw new Error('zero quote from the v4 pool for this sell');
      // Permit2 first: the router pulls the token through it, so the approvals
      // have to land before the swap can even be simulated.
      const approved = await _v4Approve(wallet, chainKey, p4Sell, ca, amount, gasMult, gas);
      const prep = await v4.prepareSwap(providerFor(chainKey), chainKey, p4Sell, wallet.address,
        { tokenIn: ca, amountIn: amount, minOut: minEth4, deadline }, { chainOf, providerFor });
      if (prep.err) {
        // The approved candidate could not fill it, so it is not the router.
        // Demote it or the retry approves the same wrong address and fails the
        // same way — see _v4Approve.
        if (approved && (prep.tried || []).length) v4.demoteRouter(chainKey, approved);
        throw new Error(`the v4 sell would revert (${prep.err}) — nothing was sent. Your tokens are untouched; try again.`);
      }
      // A WETH-quoted pool pays out WETH, and native-balance accounting would
      // book that confirmed sell as ZERO proceeds — no fee, and a profitable
      // exit recorded as a total loss — while the WETH sat in the wallet with
      // nothing ever unwrapping it. Track the real payout currency instead.
      /*
       * ⚠️ THE PAYOUT CURRENCY IS THE POOL'S, AND "not native ⇒ WETH" IS THE
       * SAME WRONG READING AS ON THE BUY SIDE — with a worse ending here.
       *
       * A pool quoted in a third token (a Pons pair against a tokenised asset,
       * say) pays out THAT token. Watching the WETH balance instead sees no
       * change, books `gained = 0`, and the comment above describes precisely
       * what follows: a confirmed, profitable exit recorded as a total loss —
       * and then `withdraw()` called on a contract that has no such function,
       * leaving the proceeds stranded in a currency nothing ever converts back.
       *
       * Track what the pool actually pays. `_dumpQuote` below returns it to
       * native, the same way the curve path already does.
       */
      const p4Quote = String(p4Sell.quote).toLowerCase();
      v4QuoteToken = p4Quote === v4.NATIVE ? null : p4Quote;
      const wethOut = !!v4QuoteToken && _isAddr(chain.weth) && v4QuoteToken === String(chain.weth).toLowerCase();
      let wBefore = null;
      if (v4QuoteToken) {
        const wc = new ethers.Contract(v4QuoteToken, ERC20_ABI, providerFor(chainKey));
        for (let i = 0; i < 3 && wBefore == null; i++) { try { wBefore = await wc.balanceOf(wallet.address); } catch (_) { wBefore = null; } }
        if (wBefore == null) throw new Error(`could not read wallet W${chain.native} balance on ${chain.name} — try again in a moment`);
      }
      hash = await rawSend(wallet, chainKey, prep.call.to, prep.call.data, 700000n, 0n, gasMult, { fee: gas });
      venue = 'dex·v4'; sent(hash); trc = await waitHash(hash, chainKey);
      if (trc && trc.status === 0) throw new Error('the v4 sell reverted on-chain (price moved past your slippage, or gas) — try again. Tx: ' + hash);
      if (v4QuoteToken) {
        const wc = new ethers.Contract(v4QuoteToken, ERC20_ABI, providerFor(chainKey));
        let wAfter = null;
        for (let i = 0; i < 3 && wAfter == null; i++) { try { wAfter = await wc.balanceOf(wallet.address); } catch (_) { wAfter = null; } }
        let gained = (wAfter != null && wAfter > wBefore) ? wAfter - wBefore : 0n;
        if (gained <= 0n) gained = expEth;   // confirmed swap, unreadable balance → the quote, never 0
        v3ProceedsWei = gained;
        if (wethOut) {
          const wi = new ethers.Interface(WETH9_ABI);
          let unwrapped = false;
          for (let i = 0; i < 3 && !unwrapped; i++) {
            try {
              const uh = await rawSend(wallet, chainKey, v4QuoteToken, wi.encodeFunctionData('withdraw', [gained]), await v3SwapGas(chainKey, wallet.address, v4QuoteToken, wi.encodeFunctionData('withdraw', [gained]), 0n), 0n, gasMult + i);
              const urc = await waitHash(uh, chainKey);
              if (!urc || urc.status !== 0) unwrapped = true;
            } catch (e) { console.error('WETH unwrap after v4 sell failed:', e.message); }
          }
          if (!unwrapped) console.error('WETH unwrap failed after a v4 sell — proceeds are safe as WETH in the wallet.');
        } else {
          // A THIRD currency cannot be unwrapped — there is nothing to unwrap it
          // INTO. It is swapped back through the router the rest of this file
          // already uses, best-effort by design: the proceeds are in the wallet
          // either way, so a failed swap-back is a nuisance and never a loss,
          // and refusing the whole sell over it would be worse. The curve path
          // draws exactly this line with `_dumpQuote`.
          const back = await _dumpQuote(wallet, chainKey, v4QuoteToken, gained, slip, gasMult, gas);
          if (!back) console.error('could not swap this v4 pool\'s quote token back to native — the proceeds are safe in the wallet as that token.');
        }
      }
    } else if (onCurve) {
      const cc = new ethers.Contract(curve, CURVE_ABI, wallet);
      // Quote with a SHAVE-TO-FIT guard. A holder of ~all circulating supply can sit
      // exactly on the curve's reserveEth boundary where selling the full bag makes the
      // curve's `reserveEth -= gross` underflow (Solidity Panic 0x11) — so a naive 100%
      // sell reverts. Step the amount down a hair until the sell simulates cleanly, so a
      // full exit ALWAYS lands (worst case shaves ~0.005% off the very last dust).
      let sellAmt = amount, minEth = 0n, ok = false;
      for (let i = 0; i < 48 && sellAmt > 0n; i++) {
        try { const exp = await cc.sell.staticCall(sellAmt, 0n, deadline); minEth = exp * (10000n - slip) / 10000n; ok = true; break; }
        catch (e) {
          const m = (e && (e.shortMessage || e.message)) || String(e);
          if (/overflow|0x11|arithmetic|panic|missing revert/i.test(m)) { sellAmt = sellAmt - sellAmt / 1000000n - 1n; continue; }
          throw new Error('could not quote this sell (try again): ' + m);
        }
      }
      if (!ok) throw new Error('could not quote this sell (try again)');
      // Sign + raw-broadcast with a fixed generous gasLimit — NEVER let ethers run
      // eth_estimateGas or its send path on the quirky Robinhood node (that is what
      // throws the opaque "could not coalesce error" / "missing revert data"). A curve
      // sell is bounded work, so 600k is safe headroom; rawSend surfaces the node's real
      // reason if it rejects (e.g. a private-beta NotAllowed).
      filledRaw = sellAmt;   // the shaved amount is the one that actually sells
      const data = cc.interface.encodeFunctionData('sell', [sellAmt, minEth, deadline]);
      hash = await rawSend(wallet, chainKey, curve, data, 600000n, 0n, gasMult, { fee: gas });
      venue = 'curve'; sent(hash);
      trc = await waitHash(hash, chainKey);
      if (trc && trc.status === 0) throw new Error('the sell reverted on-chain — you may not be allowed to sell this token yet (private beta), or try a slightly smaller amount. Tx: ' + hash);
    } else if (obsSell) {
      // The DISCOVERED curve. Built, priced against an independent source and
      // executed by an eth_call before it got here; all that is left is to send
      // it. `filledRaw` is MEASURED in the tail, never assumed — see there.
      hash = await rawSend(wallet, chainKey, obsSell.call.to, obsSell.call.data, _curveGas(obsSell.gas), 0n, gasMult, { fee: gas });
      venue = 'curve·obs'; sent(hash);
      trc = await waitHash(hash, chainKey);
      if (trc && trc.status === 0) throw new Error('the curve rejected this sell on-chain — nothing was sold. Tx: ' + hash);
    } else if (noVenue) {
      // Nowhere to sell, and the curve route could not be built. Say WHICH,
      // because "could not quote this sell (no pool? try again)" sends the user
      // to retry something that cannot change, three times, with rising gas.
      _curveRefused('sell', chainKey, ca, curveT0, obsWhy);
      throw new Error(`Dexvra could not build a safe sell on this token's launchpad curve${obsWhy ? ` (${obsWhy})` : ''} — nothing was sold`);
    } else if (v3) {
      // V3 sell: token → WETH via SwapRouter02, then unwrap. minOut floored off
      // slot0 spot using ONLY the user's slippage (no +1200 padding) so a fill
      // worse than their slippage REVERTS rather than silently losing (audit B1).
      const expW = await v3ExpectedOutRaw(chainKey, pick.pool, pick.feeTier, ca, amount);
      if (expW == null || expW <= 0n) throw new Error('could not price this sell on ' + chain.name + ' V3 (pool read failed) — try again');
      const minW = expW * (10000n - slip) / 10000n;
      if (minW <= 0n) throw new Error('no V3 liquidity / zero quote for this sell on ' + chain.name);   // never send minOut=0 (sandwich drain)
      const wethC = new ethers.Contract(chain.weth, ERC20_ABI, providerFor(chainKey));
      // wethBefore MUST be read reliably — a failed read defaulting to 0 would
      // later sweep + mis-credit pre-existing WETH (audit B4). Retry; abort the
      // whole sell BEFORE broadcasting if it can't be read.
      let wethBefore = null;
      for (let i = 0; i < 3 && wethBefore == null; i++) { try { wethBefore = await wethC.balanceOf(wallet.address); } catch (_) { wethBefore = null; } }
      if (wethBefore == null) throw new Error('could not read wallet WETH balance on ' + chain.name + ' — try again in a moment');
      const ri = new ethers.Interface(V3_ROUTER_ABI);
      const dataV3 = ri.encodeFunctionData('exactInputSingle', [{ tokenIn: ca, tokenOut: chain.weth, fee: pick.feeTier, recipient: wallet.address, amountIn: amount, amountOutMinimum: minW, sqrtPriceLimitX96: 0n }]);
      const gLim = await v3SwapGas(chainKey, wallet.address, v3.router, dataV3, 0n);   // audit B2: estimate, don't hardcode
      hash = await rawSend(wallet, chainKey, v3.router, dataV3, gLim, 0n, gasMult, { fee: gas });
      venue = 'dex·v3'; sent(hash); trc = await waitHash(hash, chainKey);
      if (trc && trc.status === 0) throw new Error('the V3 sell reverted on-chain (price moved past your slippage, or gas) — try again or a slightly smaller amount. Tx: ' + hash);
      // Post-swap WETH received. Retry the read; if it can't be read at all after
      // a CONFIRMED swap, fall back to the expected output (expW) rather than
      // booking 0 — a transient read must never record a profitable exit as a
      // total loss with no fee (audit B3).
      let wethAfter = null;
      for (let i = 0; i < 3 && wethAfter == null; i++) { try { wethAfter = await wethC.balanceOf(wallet.address); } catch (_) { wethAfter = null; } }
      let gained = (wethAfter != null && wethAfter > wethBefore) ? wethAfter - wethBefore : 0n;
      if (gained <= 0n) gained = expW;   // swap confirmed but read failed / showed no delta → use the priced estimate, never 0
      v3ProceedsWei = gained;
      if (gained > 0n) {
        const wi = new ethers.Interface(WETH9_ABI);
        let unwrapped = false;
        for (let i = 0; i < 3 && !unwrapped; i++) {
          try { const ug = await v3SwapGas(chainKey, wallet.address, chain.weth, wi.encodeFunctionData('withdraw', [gained]), 0n); const uh = await rawSend(wallet, chainKey, chain.weth, wi.encodeFunctionData('withdraw', [gained]), ug, 0n, gasMult + i); const urc = await waitHash(uh, chainKey); if (!urc || urc.status !== 0) unwrapped = true; }
          catch (e) { console.error('WETH unwrap attempt failed:', e.message); }
        }
        if (!unwrapped) console.error('WETH unwrap failed — proceeds are safe as WETH in the wallet (sell/send them manually).');
      }
    } else {
      const router = new ethers.Contract(chain.router, ROUTER_ABI, wallet);
      let expEth = 0n;
      try { const amts = await router.getAmountsOut(amount, [ca, chain.weth]); expEth = amts[1]; }
      catch (e) { throw new Error('could not quote this sell on ' + chain.name + ' (no pool? try again): ' + (e.shortMessage || e.message || e)); }
      const dexSlip = slip + 1200n > 5000n ? 5000n : slip + 1200n;
      const minEth = expEth > 0n ? expEth * (10000n - dexSlip) / 10000n : 0n;
      if (minEth <= 0n) throw new Error('no liquidity / zero quote for this sell on ' + chain.name);   // never send minOut=0 (sandwich drain)
      const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(amount, minEth, [ca, chain.weth], wallet.address, deadline, gas);
      venue = 'dex'; hash = tx.hash; sent(hash); trc = await waitBounded(tx);
    }
    const tokAfter = await erc.balanceOf(wallet.address);
    // Confirmed = receipt status 1, OR tokens actually left the wallet. Only
    // "pending" if the receipt timed out AND the balance read shows no change.
    if (!trc && tokAfter >= bal) throw new Error('sell sent but not confirmed yet — check your wallet before retrying. Tx: ' + hash);
    /*
     * ⚠️ ON A DISCOVERED CURVE, WHAT SOLD IS MEASURED — never assumed.
     *
     * `filledRaw` defaults to `amount`, which is what we ASKED to sell, and a
     * discovered call may hand over less: an argument that tracks the trade
     * size is slippage-cut by `buildCurveCall`, and on a `sell(tokensIn, …)`
     * shape that argument IS the amount. A receipt printing the ask rather than
     * the fill is a receipt that will not reconcile against the explorer — the
     * same reason the pools.trade branch sets `filledRaw` to its shaved amount.
     */
    if (venue === 'curve·obs' && tokAfter < bal) filledRaw = bal - tokAfter;
    /*
     * ⚠️ AND A CONFIRMED SELL THAT PRODUCED NO NATIVE IS NOT A ZERO-PROCEEDS
     * SELL. `curveIface` establishes which currency the BUY is paid in
     * (`native`) and has no sell-side equivalent, so a pad that pays out in
     * WETH would leave the delta at zero: a profitable exit booked as a total
     * loss, with the WETH sitting unswept. The audit-B3 rule, on a venue that
     * can genuinely hit it.
     */
    if (venue === 'curve·obs' && tokAfter < bal) {
      /*
       * A CURVE THAT PAYS IN ITS OWN TOKEN leaves the proceeds in that token,
       * and a sell whose money is stranded somewhere the user did not ask for
       * is a sell that did not finish. Swapped back through the same router the
       * buy leg used — best-effort, because the tokens ARE in the wallet: a
       * failed swap-back is a nuisance, never a loss, and refusing the whole
       * sell over it would be worse.
       */
      if (obsSell && obsSell.quoteToken) {
        const q = await tokenBalance(obsSell.quoteToken, wallet.address, chainKey).catch(() => 0n);
        if (q > 0n) await _dumpQuote(wallet, chainKey, obsSell.quoteToken, q, slip, gasMult, gas);
      }
      const paid = await ethBalance(wallet.address, chainKey).catch(() => null);
      if (paid != null && paid <= ethBefore) {
        const e = new Error('the curve took your tokens but paid out nothing this wallet can see — it may settle in a wrapped token. Check the wallet before selling more. Tx: ' + hash);
        e.broadcast = true; throw e;
      }
    }
    const ethAfter = await ethBalance(wallet.address, chainKey);
    // Proceeds: for a V3 sell — and a v4 sell out of a WETH-quoted pool — use
    // the WETH the swap produced (v3ProceedsWei). It's exact and independent of
    // gas and of whether the unwrap confirmed, so the fee/PnL are right even if
    // unwrapping timed out. Curve/V2 and a native-quoted v4 pool pay native
    // directly, so the native balance delta is the source there.
    // Guard the V3 source with > 0n (audit B3): a 0n here means the read chain
    // failed — never silently book a confirmed sell as zero proceeds; fall back
    // to the native delta rather than recording a total loss.
    const proceeds = (v3ProceedsWei != null && v3ProceedsWei > 0n) ? v3ProceedsWei : (ethAfter > ethBefore ? ethAfter - ethBefore : 0n);
    const fee = (proceeds * BigInt(CFG.feeBps)) / 10000n;
    // Broadcast the fee and move on — the referral credit fires from the
    // background confirmation (see _chargeFee), so it stays gated on the fee
    // actually landing without the fill waiting for it.
    const feeHash = await _chargeFee(wallet, fee, chainKey, () => _creditReferral(u, fee, chainKey));

    const key = posKey(chainKey, ca);
    const pos = wal.positions[key];
    if (pos) {
      // Pro-rate the cost basis to the fraction of the bag actually sold, so
      // realized PnL is correct on PARTIAL sells and a full exit zeroes the
      // basis (a later re-buy then starts fresh instead of inheriting old cash).
      if (pos.costEth == null) pos.costEth = Math.max(0, (pos.ethIn || 0) - (pos.ethOut || 0));   // migrate legacy
      // ⚠️ The basis is pro-rated by what ACTUALLY sold. It used to use
      // `amount` — the ask — which on a curve that fills short leaves the
      // position claiming a smaller remaining basis than the bag it still
      // holds, and a later re-buy inherits it.
      const soldFrac = bal > 0n ? Number(filledRaw) / Number(bal) : 1;   // sold / bag held
      const costOfSold = pos.costEth * Math.min(1, Math.max(0, soldFrac));
      const netProceeds = Number(ethers.formatEther(proceeds - fee));
      realizedThisSell = netProceeds - costOfSold;   // profit/loss on THIS sell (for the receipt)
      pos.ethOut += netProceeds;                                   // lifetime received
      pos.realizedEth = (Number(pos.realizedEth) || 0) + realizedThisSell;   // accumulate realized PnL
      pos.costEth = Math.max(0, pos.costEth - costOfSold);         // remaining basis
      pos.tokens = tokAfter.toString();
      // Treat a dust remainder (e.g. curve shave-to-fit leaving a few wei) as
      // closed too, so a full exit zeroes the basis and doesn't trip a false
      // "possible rug" alert on the leftover dust (audit C3).
      // ⚠️ CLOSED is judged on the BAG, not on the percentage asked for. `p` is
      // computed from `amount`, so a 100% sell that only moved 95% used to book
      // the position closed with 5% of it still in the wallet — a false close,
      // and a later re-buy starting from a zeroed basis.
      if (pos.tokens === '0' || (p >= 100 && tokAfter <= bal / 1000000n)) { pos.costEth = 0; pos.closed = true; }
    }
    _pushHistory(wal, { side: 'sell', chain: chainKey, ca, sym: (pos && pos.sym) || '', ethAmount: Number(ethers.formatEther(proceeds)), pct: p, hash });
    saveStore();
    // `netEth` is what the user actually KEPT, and until now only the Solana
    // sell returned it. On EVM the bot's cut is a separate transfer broadcast
    // after the wallet delta is measured, so `proceedsEth` is the gross — and
    // every EVM sell receipt has been printing that as "Received", overstating
    // it by the fee. A receipt may not claim the user got more than they did.
    const res = { chain: chainKey, native: chain.native, ca, venue, hash, feeHash, soldPct: p, soldTokens: Number(ethers.formatUnits(filledRaw, dec)), proceedsEth: Number(ethers.formatEther(proceeds)), netEth: Number(ethers.formatEther(proceeds - fee)), feeEth: Number(ethers.formatEther(fee)), realizedEth: realizedThisSell, sym: (pos && pos.sym) || '', curveVia: obsVia };
    _afterTrade(u, 'sell', res).catch(() => {});   // account + report (fire-and-forget)
    return res;
  });
}

/**
 * The same decision on the EVM side, and pure for the same reason. `gasCost` is
 * the RESERVE — what the caller has worked out this transfer can cost at the
 * worst, including the L1 data fee on an OP-stack chain — not what it will be
 * charged.
 *
 * A refusal names the largest amount that fits, because "amount exceeds balance
 * after gas" leaves the user to guess at a number they cannot see.
 */
function evmWithdrawPlan(bal, gasCost, amount, nativeSym) {
  const eth = (v) => Number(ethers.formatEther(v)).toFixed(6);
  const isMax = String(amount).toLowerCase() === 'max';
  const value = isMax ? bal - gasCost : ethers.parseEther(String(amount));
  if (value <= 0n) {
    // Only a SWEEP counts as empty. Asking for a fixed amount a wallet does not
    // have is a real failure the user needs to see, not an untouched wallet.
    return { empty: isMax, error: `this wallet holds ${eth(bal)} ${nativeSym}, which does not cover the ≈${eth(gasCost)} ${nativeSym} of gas this transfer needs — there is nothing left to send.` };
  }
  if (value + gasCost > bal) {
    return { error: `amount exceeds balance after gas — you can send at most ${eth(bal - gasCost)} ${nativeSym} (type "max").` };
  }
  return { value, isMax };
}

async function withdraw(chatId, to, amount, chainKey, walletId, guarded) {
  guarded = guarded !== false;   // only withdrawMany passes false, having guarded once itself
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  chainKey = chainKey || userChain(u);
  // Branch svm BEFORE the 0x check — a base58 Solana destination isn't a 0x address.
  if (isSvm(chainKey)) return _withdrawSol(u, to, amount, chainKey, walletId, guarded);
  to = String(to || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('invalid destination address');
  if (/^0x0{40}$/i.test(to)) throw new Error('refusing to send to the zero address');
  if (guarded) _guardWithdraw(u, to, chainKey);   // vault lock / whitelist / rate limit
  const wal = _resolveWallet(u, walletId);
  const chain = chainOf(chainKey) || {};
  const nativeSym = chain.native || 'ETH';
  return withWalletLock(wal.address, async () => {
    const wallet = _signer(wal, chainKey);
    const bal = await ethBalance(wallet.address, chainKey);
    // ONE fee object, reserved against AND signed with.
    //
    // THIS USED TO RESERVE AGAINST A DIFFERENT NUMBER THAN IT SIGNED. The
    // reserve read `gasOverrides().gasPrice` — which is undefined on every
    // 1559 chain, i.e. everything but Robinhood — and fell through to
    // `getFeeData().gasPrice` (≈ base + tip), while `rawSend` went on to sign
    // `maxFeePerGas` = base×2 + a per-chain tip FLOOR. On Ethereum the 2×
    // multiplier hid the gap; on Base, where the floor tip dwarfs a 0.005 gwei
    // base, the reserve came out several times too small and the node refused
    // the transaction outright. `opts.fee` exists precisely so the fee quoted
    // during preflight is the fee that gets signed — the withdraw path was the
    // one write that did not use it.
    const fee = await gasOverrides(chainKey);
    let perGas = fee.maxFeePerGas || fee.gasPrice || 0n;
    if (perGas <= 0n) { try { const fd = await providerFor(chainKey).getFeeData(); perGas = fd.maxFeePerGas || fd.gasPrice || 0n; } catch (_) {} }
    if (perGas <= 0n) perGas = ethers.parseUnits('0.1', 'gwei');
    // Estimate the REAL gas for this transfer — 21000 reverts on Orbit chains
    // (Robinhood) and to contract recipients (exchange deposit contracts, Safes).
    const gasLimit = await nativeTransferGas(chainKey, wallet.address, to, 1n);
    const l2Cost = perGas * gasLimit;
    // The L1 data fee is a THIRD term in an OP-stack node's balance check, and a
    // sweep that ignores it is short by exactly that much. Priced against a
    // representative transfer — the value it carries does not change the
    // calldata length, which is what the oracle charges for.
    const l1 = await _l1DataFee(chainKey, {
      type: fee.maxFeePerGas ? 2 : 0, chainId: chain.chainId, nonce: 0, to, data: '0x',
      value: bal > 0n ? bal : 1n, gasLimit,
      ...(fee.maxFeePerGas
        ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas || 0n }
        : { gasPrice: fee.gasPrice }),
    });
    // A read that FAILED must not reserve zero. Zero is the right answer only
    // where the chain has no L1 fee at all; where we could not find out, or the
    // oracle would not answer, the conservative stand-in is the L2 cost itself —
    // over-reserving costs a sliver of a sweep, under-reserving costs the whole
    // transaction.
    const l1Cost = l1.ok ? l1.fee : l2Cost;
    // Headroom on top of the exact signed cost: the base fee can rise between
    // this read and inclusion, and `maxFeePerGas` only bounds what is CHARGED,
    // never what must be RESERVED. A withdrawal that reserves too much sends
    // slightly less than everything; one that reserves too little does not send
    // at all — the asymmetry decides the direction to round.
    const gasCost = l2Cost + l2Cost / 2n + l1Cost + l1Cost / 4n;
    const plan = evmWithdrawPlan(bal, gasCost, amount, nativeSym);
    if (plan.error) { const e = new Error(plan.error); e.empty = !!plan.empty; throw e; }
    const value = plan.value;
    // rawSend, NOT wallet.sendTransaction — same Robinhood-node quirk as
    // _chargeFee: the ethers send path fails there, which would have made
    // native withdrawals on Robinhood Chain fail too.
    const hash = await rawSend(wallet, chainKey, to, '0x', gasLimit, value, undefined, { fee });
    if (guarded) _noteWithdraw(u);
    const rc = await waitHash(hash, chainKey);
    // A reverted withdraw (e.g. a contract recipient that rejects the transfer)
    // must NOT be reported as sent — funds stayed put.
    if (rc && rc.status === 0) throw new Error('the withdraw reverted on-chain — the recipient may reject direct transfers. Funds were NOT sent. Tx: ' + hash);
    return { hash, sentEth: Number(ethers.formatEther(value)), native: nativeSym, swept: plan.isMax };
  });
}

/**
 * Sweep several wallets on ONE chain to ONE address — "withdraw all wallets",
 * with the chain picked first.
 *
 * ⚠️ THE RATE LIMIT IS CHECKED AND CHARGED ONCE, for the whole sweep. It has to
 * be. `MAX_WD_PER_HOUR` defaults to 10 and a full account is 10 wallets, so
 * charging per wallet would let a single sweep spend the entire hour's budget
 * and, on the eleventh wallet, stop halfway with "rate limit reached" — funds
 * moved out of some wallets and not others, from one confirmation the user gave
 * once. A half-done irreversible action is worse than a refused one. The limit
 * exists to bound how fast a compromised session can move money to a NEW
 * destination, and this is one destination, confirmed once.
 *
 * Wallets run CONCURRENTLY — each holds its own `withWalletLock`, so there is no
 * contention — and every one gets its own row in the result. A wallet that held
 * nothing is `empty`, never `error`: asked to sweep an empty wallet, doing
 * nothing is the right answer, and a red cross beside it sends the reader
 * hunting for a fault that is not there.
 *
 * Nothing here throws for a per-wallet failure. The caller renders the rows.
 */
async function withdrawMany(chatId, to, amount, chainKey, walletIds) {
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  chainKey = chainKey || userChain(u);
  if (!isEnabled(chainKey)) throw new Error('chain not enabled');
  const list = walletList(u);
  const wanted = (Array.isArray(walletIds) && walletIds.length ? walletIds : list.map((w) => w.id))
    .filter((id) => list.some((w) => w.id === id));
  if (!wanted.length) throw new Error('no wallets selected');
  // Validate the destination and the security posture BEFORE any wallet moves,
  // so a bad address or a locked vault costs nothing and moves nothing.
  const dest = String(to || '').trim();
  if (isSvm(chainKey)) { if (!solana.isSolAddress(dest)) throw new Error('invalid Solana destination address'); }
  else {
    if (!/^0x[0-9a-fA-F]{40}$/.test(dest)) throw new Error('invalid destination address');
    if (/^0x0{40}$/i.test(dest)) throw new Error('refusing to send to the zero address');
  }
  _guardWithdraw(u, dest, chainKey);
  _noteWithdraw(u);
  return Promise.all(wanted.map(async (id) => {
    const w = walletById(u, id);
    const index = list.findIndex((x) => x.id === id) + 1;
    const row = { walletId: id, index, label: walletLabel(w, index) };
    try {
      const r = await withdraw(chatId, dest, amount, chainKey, id, false);
      return { ...row, ok: true, sentEth: r.sentEth, native: r.native, hash: r.hash, swept: r.swept };
    } catch (e) {
      return { ...row, ok: false, empty: !!(e && e.empty), error: (e && e.message) || String(e) };
    }
  }));
}

// Withdraw a HELD TOKEN (ERC20 on EVM, SPL on Solana) to an external address. Same
// security guards as native withdraw (vault lock / whitelist / rate limit). `amount`
// is human units or 'max'. On Solana the sender pays ~0.002 SOL to open the recipient's
// token account if it doesn't exist yet.
async function withdrawToken(chatId, ca, to, amount, chainKey, walletId) {
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  chainKey = chainKey || userChain(u);
  ca = String(ca || '').trim(); to = String(to || '').trim();
  const svm = isSvm(chainKey);
  if (svm) {
    if (!solana.isSolAddress(ca)) throw new Error('invalid token mint');
    if (!solana.isSolAddress(to)) throw new Error('invalid Solana destination address');
  } else {
    if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) throw new Error('invalid token address');
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('invalid destination address');
    if (/^0x0{40}$/i.test(to)) throw new Error('refusing to send to the zero address');
  }
  _guardWithdraw(u, to, chainKey);   // vault lock / whitelist / rate limit
  const wal = _resolveWallet(u, walletId);
  return withWalletLock(wal.address, async () => {
    const meta = await tokenMeta(ca, chainKey);
    const dec = meta.decimals;
    const addr = walletAddress(wal, chainKey);
    const balRaw = await tokenBalance(ca, addr, chainKey);
    if (balRaw <= 0n) throw new Error('no ' + meta.sym + ' in this wallet to withdraw');
    let raw;
    if (String(amount).toLowerCase() === 'max') raw = balRaw;
    else raw = svm ? solana.toRaw(amount, dec) : ethers.parseUnits(String(amount), dec);
    if (raw <= 0n) throw new Error('amount must be > 0');
    if (raw > balRaw) throw new Error(`amount exceeds your ${meta.sym} balance (${Number(ethers.formatUnits(balRaw, dec))})`);
    _noteWithdraw(u);
    if (svm) {
      const signer = _signer(wal, chainKey);
      const sig = await solana.sendSplToken(signer.connection, signer.keypair, ca, to, raw, dec);
      return { hash: sig, sym: meta.sym, amount: Number(solana.fmtUnits(raw, dec)), native: 'SOL', ca, chain: chainKey };
    }
    // EVM: ERC20.transfer via raw broadcast (bypass the quirky-RPC estimateGas path).
    const wallet = _signer(wal, chainKey);
    const data = new ethers.Contract(ca, ERC20_ABI, wallet).interface.encodeFunctionData('transfer', [to, raw]);
    const hash = await rawSend(wallet, chainKey, ca, data, 120000n);
    const trc = await waitHash(hash, chainKey);
    if (trc && trc.status === 0) throw new Error('the token transfer reverted on-chain. Tx: ' + hash);
    return { hash, sym: meta.sym, amount: Number(ethers.formatUnits(raw, dec)), native: (chainOf(chainKey) || {}).native, ca, chain: chainKey };
  });
}

// ---------------------------------------------------------------- referral auto-payout (opt-in)
// Enabled only if FEE_WALLET_KEY is set AND it derives FEE_WALLET (so a wrong key
// can never move funds). This is a HOT key — off unless the operator opts in.
function feePayoutEnabled() {
  if (!CFG.feeWalletKey) return false;
  try { return !!CFG.feeWallet && new ethers.Wallet(CFG.feeWalletKey).address.toLowerCase() === CFG.feeWallet.toLowerCase(); }
  catch (_) { return false; }
}
// Pay `wei` native from the fee wallet to `to`. Nonce-serialized. We build + sign
// the tx LOCALLY, then broadcast as a distinct step, so failure classification is
// exact: anything before broadcast (nonce/estimate/sign) throws plainly → the caller
// may safely restore the debt; a failure DURING broadcast is tagged `e.ambiguous`
// (the node may have accepted the tx) → the caller must NOT re-pay. A timeout while
// waiting for the receipt returns { confirmed:false } (already broadcast → no re-pay).
async function payFromFeeWallet(chainKey, to, wei) {
  if (!feePayoutEnabled()) throw new Error('fee payout disabled');
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(to))) throw new Error('bad destination');
  wei = BigInt(wei);
  if (wei <= 0n) throw new Error('nothing to pay');
  const prov = providerFor(chainKey);
  const signer = new ethers.Wallet(CFG.feeWalletKey, prov);
  return withWalletLock(signer.address, async () => {
    const bal = await ethBalance(signer.address, chainKey);
    const gas = await gasOverrides(chainKey);
    let gp = gas.gasPrice;
    if (!gp) { try { const fd = await prov.getFeeData(); gp = fd.gasPrice || fd.maxFeePerGas; } catch (_) {} }
    if (!gp || gp <= 0n) gp = ethers.parseUnits('0.1', 'gwei');
    let gasLimit = 21000n;   // plain value transfer; bump if the chain estimates higher (e.g. Arbitrum L1 component)
    try { const est = await prov.estimateGas({ from: signer.address, to, value: wei }); if (est > gasLimit) gasLimit = est + est / 5n; } catch (_) {}
    if (wei + gp * gasLimit * 2n > bal) throw new Error('fee wallet balance too low for payout + gas');
    // Everything up to broadcast is PRE-broadcast: a throw here means nothing was sent.
    const nonce = await prov.getTransactionCount(signer.address, 'pending');
    const signed = await signer.signTransaction({ to, value: wei, gasPrice: gp, gasLimit, nonce, chainId: chainOf(chainKey).chainId, type: 0 });
    // Broadcast — from here on the node MAY have accepted the tx even if the RPC
    // errors, so a throw is AMBIGUOUS and the caller must NOT restore the debt.
    let tx;
    try { tx = await prov.broadcastTransaction(signed); }
    catch (e) { e.ambiguous = true; throw e; }
    let rc = null;
    try { rc = await waitBounded(tx); } catch (_) { rc = null; }   // already broadcast → never treat a wait failure as "not sent"
    if (rc && rc.status === 0) { const e = new Error('payout reverted'); e.reverted = true; throw e; }   // reverted value-transfer returns the ETH → safe to restore
    return { hash: tx.hash, confirmed: !!rc };
  });
}

// Portfolio for the ACTIVE (or specified) wallet on its active chain: value + PnL.
async function portfolio(chatId, walletId) {
  const u = getUser(chatId); if (!u) return { rows: [], totalValueEth: 0, address: null, chain: null };
  const wal = walletId ? walletById(u, walletId) : activeWallet(u);
  if (!wal) return { rows: [], totalValueEth: 0, address: null, chain: null };
  const chainKey = userChain(u);
  const chain = chainOf(chainKey);
  const rows = [];
  let totalValueEth = 0;
  for (const key of Object.keys(wal.positions || {})) {
    const p = wal.positions[key];
    if (p.chain !== chainKey) continue;   // show only the active chain
    const balRaw = await tokenBalance(p.ca, walletAddress(wal, chainKey), chainKey);
    const bal = Number(ethers.formatUnits(balRaw, p.dec || 18));
    if (bal <= 1e-9 && !(p.ethIn > 0)) continue;
    const snap = await tokenSnapshot(p.ca, chainKey).catch(() => null);
    // A price we could not read is UNKNOWN, not zero — see the note on
    // portfolioAll below. `unrealizedEth: null` means "we don't know", and the
    // renderer must print that rather than a loss.
    const priceEth = (snap && snap.priceEth > 0) ? snap.priceEth : 0;
    const priced = priceEth > 0 || bal <= 1e-9;
    const valueEth = bal * priceEth;
    totalValueEth += valueEth;
    const costBasis = (p.costEth != null) ? p.costEth : Math.max(0, (p.ethIn || 0) - (p.ethOut || 0));
    rows.push({ ca: p.ca, name: p.name, sym: p.sym, tokens: bal, valueEth, priced, ethIn: p.ethIn, ethOut: p.ethOut, costEth: costBasis, unrealizedEth: priced ? valueEth - costBasis : null, realizedEth: p.realizedEth || 0 });
  }
  rows.sort((a, b) => b.valueEth - a.valueEth);
  return { rows, totalValueEth, address: walletAddress(wal, chainKey), chain, native: chain.native };
}
// Maestro-style aggregate portfolio: every token any wallet has a position in on the
// active chain, summed across ALL wallets (live balances) with a per-wallet breakdown.
// This is what makes a token you bought on Wallet 1 still show when Wallet 4 is active.
async function portfolioAll(chatId) {
  const u = getUser(chatId); if (!u) return { rows: [], totalValueEth: 0, chain: null };
  const chainKey = userChain(u);
  const chain = chainOf(chainKey);
  const list = walletList(u);
  // Union of every CA seen in any wallet's positions on this chain.
  const cas = new Map();   // caLower -> { ca, name, sym, dec, ethIn, ethOut }
  for (const wal of list) {
    for (const key of Object.keys(wal.positions || {})) {
      const p = wal.positions[key];
      if (p.chain !== chainKey) continue;
      const k = p.ca.toLowerCase();
      const agg = cas.get(k) || { ca: p.ca, name: p.name, sym: p.sym, dec: p.dec || 18, ethIn: 0, ethOut: 0, costEth: 0, realizedEth: 0 };
      agg.ethIn += p.ethIn || 0; agg.ethOut += p.ethOut || 0;
      agg.costEth += (p.costEth != null) ? p.costEth : Math.max(0, (p.ethIn || 0) - (p.ethOut || 0));
      // Profit BOOKED on sells, tracked per position by sell(). ethOut - ethIn is
      // not the same thing and is wrong on a partial exit: proceeds are cash out,
      // not profit, so a token sold halfway looks like a loss until it is closed.
      agg.realizedEth += Number(p.realizedEth) || 0;
      cas.set(k, agg);
    }
  }
  const rows = [];
  let totalValueEth = 0;
  for (const agg of cas.values()) {
    // Live balance summed across every wallet + which wallets hold it.
    let totalTokens = 0; const holders = [];
    for (const wal of list) {
      const balRaw = await tokenBalance(agg.ca, walletAddress(wal, chainKey), chainKey);
      const bal = Number(ethers.formatUnits(balRaw, agg.dec));
      if (bal > 1e-9) { totalTokens += bal; holders.push({ index: list.indexOf(wal) + 1, label: walletLabel(wal, list.indexOf(wal) + 1), tokens: bal }); }
    }
    if (totalTokens <= 1e-9 && !(agg.ethIn > 0)) continue;
    // A closed row holds nothing, so there is no live price to fetch and nothing a
    // snapshot could tell us — skip the network call entirely. On a wallet with a
    // long history that is most of the list.
    const open = totalTokens > 1e-9;
    const snap = open ? await tokenSnapshot(agg.ca, chainKey).catch(() => null) : null;
    // A PRICE WE COULD NOT READ IS NOT A PRICE OF ZERO.
    //
    // This used to be `snap ? snap.priceEth : 0`, so a failed lookup — a network
    // blip, a rate limit, a pool with no liquidity right now — set valueEth to 0
    // and therefore unrealized to MINUS THE ENTIRE COST BASIS. The row read as a
    // 100% loss, and it was summed into the header's "Unrealized", so a user who
    // opened /portfolio during an API hiccup watched their whole book get wiped
    // out. The number was invented by us, not by the market.
    //
    // We cannot tell "the source failed" from "the source says zero": the
    // snapshot fallback object itself carries priceEth 0. So anything that is
    // not a positive price is treated as UNKNOWN. The asymmetry decides it —
    // reporting a real zero as unknown costs a line of copy, reporting an
    // unknown as zero costs the user their trust in the whole screen. Same rule
    // as the tokens screen, deliberately, so the two agree.
    const priceEth = (snap && snap.priceEth > 0) ? snap.priceEth : 0;
    const priced = !open || priceEth > 0;
    const valueEth = totalTokens * priceEth;
    totalValueEth += valueEth;
    rows.push({ ca: agg.ca, name: agg.name, sym: agg.sym, open, tokens: totalTokens, valueEth, priced,
      ethIn: agg.ethIn, ethOut: agg.ethOut, costEth: agg.costEth, realizedEth: agg.realizedEth,
      // Unrealized is only meaningful while something is still held. On a closed
      // row it is zero by construction, and printing it beside a realized figure
      // is what made "3.99x (+299%)" sit next to "PnL +0.0000". null = unknown.
      unrealizedEth: !open ? 0 : (priced ? valueEth - agg.costEth : null), holders });
  }
  rows.sort((a, b) => (Number(b.open) - Number(a.open)) || (b.valueEth - a.valueEth) || (b.realizedEth - a.realizedEth));
  const totalRealizedEth = rows.reduce((t, r) => t + (Number(r.realizedEth) || 0), 0);
  // Cost and unrealized are summed over the SAME rows — the priced ones. Leaving
  // an unpriced row's cost in the denominator while its gain is missing from the
  // numerator prints a percentage against money the numerator never saw.
  const priced = rows.filter((r) => r.priced);
  const totalCostEth = priced.reduce((t, r) => t + (r.open ? Number(r.costEth) || 0 : 0), 0);
  const totalUnrealEth = priced.reduce((t, r) => t + (Number(r.unrealizedEth) || 0), 0);
  const unpriced = rows.filter((r) => !r.priced).length;
  return { rows, totalValueEth, totalCostEth, totalUnrealEth, totalRealizedEth, unpriced, chain, native: chain.native };
}

// Trade history (newest first) + realized PnL for a wallet.
function getHistory(chatId, walletId) {
  const u = getUser(chatId); if (!u) return [];
  const wal = walletId ? walletById(u, walletId) : activeWallet(u);
  return (wal && Array.isArray(wal.history)) ? wal.history.slice().reverse() : [];
}
function realizedEth(wal, chainKey) {
  let r = 0;
  for (const k of Object.keys((wal && wal.positions) || {})) {
    const p = wal.positions[k];
    if (!p || typeof p.realizedEth !== 'number') continue;
    if (chainKey && p.chain !== chainKey) continue;   // don't sum ETH + BNB realized together
    r += p.realizedEth;
  }
  return r;
}

/**
 * Everything needed to answer "how did I do on THIS token" — sold or not.
 *
 * /portfolio and portfolioAll answer it for the ACTIVE chain's whole book. This
 * answers it for one contract on whichever chain it lives on, across every
 * wallet, and — the part the book cannot do — it still answers after the bag is
 * gone: a position record survives being sold to zero (it is what carries the
 * lifetime ethIn/ethOut), so a closed trade is history, not a hole.
 *
 * THE MONEY VIEW IS THE HEADLINE. `pnlEth = (ethOut + value held) − ethIn`:
 * what came back minus what went in. It is the number a user can check against
 * their own wallet, it is exactly profit once the bag is closed, and it needs no
 * basis accounting to be true. `realizedEth` (booked on each sell) and
 * `unrealizedEth` are reported beside it, because a half-sold bag makes the two
 * views differ and hiding that is how "3.99x" ends up next to "PnL +0.0000".
 *
 * A PRICE WE COULD NOT READ IS NOT A PRICE OF ZERO — the /portfolio rule, kept
 * here for the same reason: `priced:false` leaves the live value UNKNOWN rather
 * than reporting a 100% loss on a network blip.
 */
async function tokenPnl(chatId, ca, chainKey) {
  const u = ensureUser(chatId); if (!u) return null;
  chainKey = (chainKey && chainOf(chainKey)) ? chainKey : userChain(u);
  const key = posKey(chainKey, ca);
  const list = walletList(u);
  // Lifetime totals, summed over every wallet that ever held it.
  const agg = { ethIn: 0, ethOut: 0, costEth: 0, realizedEth: 0, sym: '', name: '', dec: null, wallets: 0 };
  for (const wal of list) {
    const p = (wal.positions || {})[key];
    if (!p) continue;
    agg.wallets++;
    agg.ethIn += Number(p.ethIn) || 0;
    agg.ethOut += Number(p.ethOut) || 0;
    agg.costEth += (p.costEth != null) ? (Number(p.costEth) || 0) : Math.max(0, (Number(p.ethIn) || 0) - (Number(p.ethOut) || 0));
    agg.realizedEth += Number(p.realizedEth) || 0;
    if (!agg.sym && p.sym) agg.sym = p.sym;
    if (!agg.name && p.name) agg.name = p.name;
    if (agg.dec == null && p.dec != null) agg.dec = p.dec;
  }
  const traded = agg.wallets > 0;
  // The symbol/decimals still have to be right for a token this bot never
  // traded — the answer there is "no trades", and it should still name the token.
  let meta = null;
  if (!traded || agg.dec == null || !agg.sym) meta = await tokenMeta(ca, chainKey).catch(() => null);
  const dec = (agg.dec != null) ? agg.dec : (meta ? meta.decimals : (isSvm(chainKey) ? 9 : 18));
  const sym = agg.sym || (meta && meta.sym) || '';
  const name = agg.name || (meta && meta.name) || '';
  // Live balance per wallet — what is still held decides open vs closed, and a
  // token moved to another wallet by hand must not read as sold.
  //
  // ⚠️ A BALANCE WE COULD NOT READ IS NOT A BALANCE OF ZERO — the /portfolio
  // price rule, one field over, and it bites harder here: a failed read makes a
  // held bag look SOLD, so the card would state "🏁 CLOSED" and −100% about a
  // position the user is still fully exposed to. `tokenBalanceOrNull` exists
  // for exactly this (it is what stopped the monitor unpinning live bags on a
  // dead RPC); one unreadable wallet marks the whole answer unknown rather than
  // quietly under-counting the bag.
  const holders = [];
  let tokens = 0;
  let balUnknown = false;
  await Promise.all(list.map(async (wal, i) => {
    const raw = await module.exports.tokenBalanceOrNull(ca, walletAddress(wal, chainKey), chainKey);
    if (raw == null) { balUnknown = true; return; }
    const bal = Number(ethers.formatUnits(raw, dec));
    if (bal > 1e-9) holders.push({ index: i + 1, label: walletLabel(wal, i + 1), tokens: bal });
  }));
  holders.sort((a, b) => b.tokens - a.tokens);
  tokens = holders.reduce((t, h) => t + h.tokens, 0);
  // Unknown reads keep the position OPEN-but-unpriced rather than closed: the
  // renderer then says "couldn't read it just now" and suppresses every figure
  // derived from it, which is the honest answer. A position with no trades and
  // no readable balance is simply "no trades".
  const open = tokens > 1e-9 || (balUnknown && traded);
  // The share of supply this bag is. Best-effort and cached; null (never 0)
  // when the supply cannot be read, and the renderers print nothing then.
  const supplyUi = (open && !balUnknown && tokens > 1e-9)
    ? await module.exports.tokenSupplyUi(ca, chainKey, dec).catch(() => null) : null;
  const snap = (open && !balUnknown) ? await module.exports.tokenSnapshot(ca, chainKey).catch(() => null) : null;
  const priceEth = (snap && snap.priceEth > 0) ? snap.priceEth : 0;
  // An unreadable BALANCE is as disqualifying as an unreadable price: both leave
  // the live value unknown, and the card must not derive a total from either.
  const priced = !open || (!balUnknown && priceEth > 0);
  const valueEth = open && priced ? tokens * priceEth : 0;
  // The trade log is capped per wallet (50), so these are "what we still have on
  // file", never a claim of completeness — the renderer says so.
  let buys = 0, sells = 0, firstAt = null, lastAt = null;
  const caL = isSvm(chainKey) ? String(ca) : String(ca).toLowerCase();
  for (const wal of list) {
    for (const h of (wal.history || [])) {
      if (!h || h.chain !== chainKey) continue;
      const hc = isSvm(chainKey) ? String(h.ca || '') : String(h.ca || '').toLowerCase();
      if (hc !== caL) continue;
      if (h.side === 'sell') sells++; else buys++;
      if (h.ts && (!firstAt || h.ts < firstAt)) firstAt = h.ts;
      if (h.ts && (!lastAt || h.ts > lastAt)) lastAt = h.ts;
    }
  }
  const backEth = agg.ethOut + valueEth;                  // proceeds + what is still held
  const pnlEth = traded ? backEth - agg.ethIn : 0;
  return {
    ca, chain: chainKey, sym, name, dec, traded,
    open, tokens, holders, priced, priceEth, valueEth, balUnknown,
    supplyPct: (supplyUi > 0 && tokens > 0) ? (tokens / supplyUi) * 100 : null,
    ethIn: agg.ethIn, ethOut: agg.ethOut, costEth: agg.costEth,
    realizedEth: agg.realizedEth,
    // Only meaningful while something is held, and only when we could price it.
    unrealizedEth: !open ? 0 : (priced ? valueEth - agg.costEth : null),
    pnlEth: (open && !priced) ? null : pnlEth,            // unknown price → unknown total
    multiple: (agg.ethIn > 0 && !(open && !priced)) ? backEth / agg.ethIn : null,
    // The entry of the bag STILL HELD — cost ÷ tokens, the same two figures the
    // Monitor's P/L line is built from, so the percentage is checkable against
    // the card that states it. A closed bag has no entry left to state.
    entryEth: (open && tokens > 1e-9 && agg.costEth > 0) ? agg.costEth / tokens : null,
    trades: { buys, sells, firstAt, lastAt, capped: true },
  };
}

module.exports = {
  gasBufferWei,
  CFG, chains, chainOf, userChain, providerFor, FACTORY_ABI, CURVE_ABI, ERC20_ABI,
  getHistory, realizedEth,
  loadStore, saveStore, saveStoreNow, allUsers, getUser, ensureUser, signerFor, exportKey, walletFromSecret, setChain,
  noteUser, findUser, recordTrade, reportSnapshot, resetReportWindow, recapDue, markRecap, opsDue, markOps,
  monitorsAll, monitorSave, monitorDrop,
  walletList, walletById, activeWallet, activeAddress, addWallet, switchWallet, removeWallet, listWallets, WALLET_CAP,
  renameWallet, walletLabel, hasChainPresets, solAddressOf, walletAddress,
  getSecurity, setWithdrawLock, addWhitelist, removeWhitelist, MAX_WD_PER_HOUR, backupNow,
  buyPresets, setSlippage, setBuyPresets, setAutoBuy, userGasBoost, setGasBoost, DEFAULT_BUY_PRESETS, defaultPresetsFor, PRESETS_MIN, PRESETS_MAX, setSnipeChain, setSnipeAmount,
  setConfirmBuy, setExpert, setReceiptStyle, perWalletReceipts, setAutoExit, setAutoProtect, getLang, setLang, setNotify, notifyOn, NOTIFY_TYPES,
  tradeSelection, setTradeAll, toggleTradeWallet, tradeWalletIds,
  addCopyTarget, removeCopyTarget, setCopyOn, setCopySell, copyHoldingAdd, copyHoldingDrop, copyHoldingSet, copyHoldingBump, copyHoldingRetry, copyTokenKey, MAX_COPY_TARGETS, canDevSnipe,
  canTradeNow, addSnipeTarget, removeSnipeTarget, snipeTargets, snipeTargetById, armedSnipeTargets, armedTargetFor, updateArmedTarget,
  claimSnipeTarget, settleSnipeTarget, rearmSnipeTarget, expireSnipeTarget, MAX_SNIPE_TARGETS, SNIPE_TTL_MS,
  snipeDraft, newSnipeDraft, updateSnipeDraft, clearSnipeDraft, armSnipeDraft, SNIPE_DRAFT_TTL_H, copyFanOut,
  feePayoutEnabled, payFromFeeWallet,
  resolveCurve, isGraduated, launchpadDiag, tokenMeta, tokenDecimals, tokenSnapshot, ethBalance, tokenBalance, tokenBalanceOrNull, tokenSupplyUi, tokenAcrossWallets, tokenBalancesAcross, ethUsd, gasOverrides, rawSend, posKey, bestDexVenue,
  dsMarket, gtMarket, marketOf, dsChainsOf, marketProbe, dsVenueLabel, v4,
  // Exported the way `v4` is: as MODULE OBJECTS, so the test seam is DECLARED
  // rather than incidental. A test replaces `core.curveTrade.prepareBuy` and
  // stubs the whole discovery + simulate + price stack; destructured at the
  // require above, that seam would be dead and the failure silent.
  curveTrade, curvePrice, tokenDecimalsOrNull, tokenSupplyRaw, approveExact,
  walletFunds, solWithdrawPlan, evmWithdrawPlan, exportMnemonic,
  ethBalanceOrNull, nativeBalances,
  buy, sell, withdraw, withdrawMany, withdrawToken, portfolio, portfolioAll, tokenPnl, tokenLogoUrl, DB,
  // Test-only seams — see the notes at each definition.
  _deps,
  _clearReadCaches, _launchpadFailClear: () => _launchpadFail.clear(),
};
