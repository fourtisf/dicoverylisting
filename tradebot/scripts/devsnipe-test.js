'use strict';
process.env.SNIPE_SEEN_CAP = '4000';   // pin to the min cap (floor) so eviction is testable without a huge flood
/* Offline unit test for the dev-wallet snipe internals (no network / no chain):
 *   • _snipeMark  — per-launch dedup (audit #1)
 *   • _followerBuy — crash-safe commit / rollback / budget-cap / dedup / broadcast
 *   • launchFollowers — master-switch + mode filter
 * Run: node scripts/devsnipe-test.js */
const path = require('path');

// ---- Stubs injected before watchers.js requires them ----
let BUY_BEHAVIOR = { ok: true };   // toggled per case
const saved = [];                   // records saveStoreNow calls
const notes = [];                   // captured notifications
let SNAP_PRICE = 0;                  // tokenSnapshot priceEth (positions test)
let SELL_BEHAVIOR = { ok: true };   // core.sell behavior (positions test)
const sellCalls = [];               // records core.sell(chatId, ca, pct, chain, wid, opts)
let SAFE = { supported: false, sec: null };   // safety re-check result (positions test)
const ONE_WALLET = [{ id: 'w1', address: '0xME' }];
const coreStub = {
  CFG: { gasBufferEth: '0.001', solGasBuffer: '0.01' },
  chains: { isSvm: (k) => k === 'solana', isEnabled: () => true, enabledChains: () => [] },
  // The multi-wallet dev snipe resolves the target's wallet SELECTION at fire
  // time (walletId/'*'/walletIds → walletList, falling back to activeWallet),
  // and records one exit-mirror LEG per buying wallet through copyHoldingAdd.
  // The stub predated all of that, so this script had been crashing on
  // `core.activeWallet is not a function` since the selection landed — i.e. the
  // one offline check of the dev snipe could not run at all.
  activeWallet: () => ONE_WALLET[0],
  copyHoldingAdd: () => {},
  chainOf: (k) => ({ key: k, name: k, emoji: '◆', native: k === 'solana' ? 'SOL' : 'ETH', explorer: 'https://x' }),
  allUsers: () => USERS,
  walletList: (u) => u.wallets || ONE_WALLET,
  notifyOn: () => false,   // alerts OFF → only autoProtect can drive positionsCycle
  tokenSnapshot: async () => (SNAP_PRICE > 0 ? { priceEth: SNAP_PRICE, sym: 'DEV' } : null),
  sell: async (chatId, ca, pct, chain, wid, opts) => {
    sellCalls.push({ chatId, ca, pct, chain, wid, opts });
    if (SELL_BEHAVIOR.throw) throw new Error(SELL_BEHAVIOR.msg || 'sell failed');
    return { proceedsEth: 0.05, native: 'ETH', hash: '0xsellhash', soldPct: pct };
  },
  saveStoreNow: () => saved.push(1),
  saveStore: () => {},
  buy: async (chatId, token, amt) => {
    if (BUY_BEHAVIOR.throw) { const e = new Error(BUY_BEHAVIOR.msg || 'boom'); if (BUY_BEHAVIOR.broadcast) e.broadcast = true; throw e; }
    return { sym: 'DEV', gotTokens: 123, spentEth: amt, native: 'ETH', hash: '0xhash', chain: 'robinhood' };
  },
};
const safetyStub = { supported: () => SAFE.supported, tokenSecurity: async () => SAFE.sec, verdict: () => ({ level: 'ok' }) };
const dir = path.resolve(__dirname, '..');
const inject = (rel, exp) => { const p = require.resolve(path.join(dir, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
inject('core', coreStub);
inject('safety', safetyStub);
inject('goplus', {});
inject('solana', { isSolAddress: () => true, WSOL_MINT: 'W' });

const USERS = [];
const w = require(path.join(dir, 'watchers'));
w.setNotifier((chatId, text) => notes.push({ chatId, text }));
const T = w._test;

let pass = 0, fail = 0;
const A = (name, cond) => { console.log((cond ? '✅' : '❌') + ' ' + name); cond ? pass++ : fail++; };
const mkT = (over) => Object.assign({ id: 'cp1', address: '0xDEV', chain: 'robinhood', mode: 'launches', buyEth: '0.02', maxEth: '0.06', spentEth: 0, bought: {} }, over);

(async () => {
  // ---- _snipeMark ----
  A('_snipeMark first = true', T._snipeMark('robinhood', '0xAaa') === true);
  A('_snipeMark repeat = false', T._snipeMark('robinhood', '0xAAA') === false);      // case-insensitive
  A('_snipeMark other chain = true', T._snipeMark('base', '0xAaa') === true);
  // Per-chain isolation (audit #1): flooding a busy chain PAST its cap (default floor 4000)
  // must NOT evict a different chain's still-remembered launch. This is the core #1 fix.
  T._snipeMark('slowchain', '0xKEEP');
  for (let i = 0; i < 4200; i++) T._snipeMark('busychain', '0xB' + i);   // exceed the pinned cap 4000
  A('_snipeMark cross-chain isolation (busy chain cannot evict slow chain)', T._snipeMark('slowchain', '0xKEEP') === false);   // still remembered
  A('_snipeMark same-chain eviction works', T._snipeMark('busychain', '0xB0') === true);  // oldest on busychain evicted

  // ---- launchFollowers ----
  USERS.length = 0;
  USERS.push({ chatId: 1, copy: { on: true, targets: [mkT({})] } });
  USERS.push({ chatId: 2, copy: { on: false, targets: [mkT({})] } });                // master OFF → excluded
  USERS.push({ chatId: 3, copy: { on: true, targets: [mkT({ mode: 'trades' })] } });  // trades mode → excluded
  const lf = T.launchFollowers('robinhood');
  A('launchFollowers only ON+launches', lf.length === 1 && lf[0].chatId === 1);
  A('launchFollowers wrong chain empty', T.launchFollowers('solana').length === 0);

  // ---- _followerBuy: success commits + notifies + returns true ----
  BUY_BEHAVIOR = { ok: true }; notes.length = 0;
  let t = mkT({});
  let ret = await T._followerBuy({ chatId: 1 }, t, '0xToken1', 'robinhood');
  A('success: returns true', ret === true);
  A('success: bought marked', t.bought['0xtoken1'] === true);
  A('success: spent += buyEth', Math.abs(Number(t.spentEth) - 0.02) < 1e-9);
  A('success: notified', notes.length === 1 && /Dev snipe/.test(notes[0].text));

  // ---- dedup: second call for same token is a no-op, returns false ----
  notes.length = 0;
  ret = await T._followerBuy({ chatId: 1 }, t, '0xTOKEN1', 'robinhood');   // case-insensitive dup
  A('dedup: returns false', ret === false);
  A('dedup: no second buy', Number(t.spentEth) === 0.02 && notes.length === 0);

  // ---- budget cap: spent at max blocks further buys, returns false ----
  t = mkT({ spentEth: 0.05, maxEth: 0.06 });   // 0.05 + 0.02 = 0.07 > 0.06 → blocked
  ret = await T._followerBuy({ chatId: 1 }, t, '0xToken2', 'robinhood');
  A('budget cap: returns false', ret === false);
  A('budget cap: blocked', t.bought['0xtoken2'] === undefined && Number(t.spentEth) === 0.05);

  // ---- rollback: non-broadcast failure restores spent + dedup (still returns true = committed) ----
  BUY_BEHAVIOR = { throw: true, msg: 'reverted', broadcast: false }; notes.length = 0;
  t = mkT({});
  ret = await T._followerBuy({ chatId: 1 }, t, '0xToken3', 'robinhood');
  A('rollback: returns false (rolled back → snipe-all fallback allowed)', ret === false);
  A('rollback: spent restored to 0', Number(t.spentEth) === 0);
  A('rollback: dedup cleared', t.bought['0xtoken3'] === undefined);
  A('rollback: failure DM sent', notes.length === 1 && /failed/.test(notes[0].text));

  // ---- broadcast failure: keep commit (may still land) ----
  BUY_BEHAVIOR = { throw: true, msg: 'not confirmed', broadcast: true }; notes.length = 0;
  t = mkT({});
  ret = await T._followerBuy({ chatId: 1 }, t, '0xToken4', 'robinhood');
  A('broadcast: returns true', ret === true);
  A('broadcast: spent KEPT', Math.abs(Number(t.spentEth) - 0.02) < 1e-9);
  A('broadcast: dedup KEPT', t.bought['0xtoken4'] === true);

  // ---- Auto-protect (rug guard) in positionsCycle — COST-based, not peak-based ----
  const TOK = '1000000000000000000';   // 1 token (18 dec) → value = SNAP_PRICE; cost basis = 0.1
  const mkPos = (over) => Object.assign({ chain: 'robinhood', ca: '0xtok', sym: 'DEV', dec: 18, ethIn: 0.1, costEth: 0.1, tokens: TOK, peakValueEth: 1.0, notified: {} }, over);
  const mkUser = (autoProtect, pos) => ({ chatId: 1, settings: { autoProtect }, wallets: [{ id: 'w1', positions: { 'robinhood:0xtok': pos } }] });
  const resetPos = () => { sellCalls.length = 0; notes.length = 0; };

  // Loss: value 0.03 vs cost 0.10 = 70% down on entry ≥ 60% → auto-sell 100%
  resetPos(); SNAP_PRICE = 0.03; SELL_BEHAVIOR = { ok: true }; SAFE = { supported: false, sec: null };
  USERS.length = 0; USERS.push(mkUser(true, mkPos({})));
  await T.positionsCycle();
  A('autoProtect loss → sells 100%', sellCalls.length === 1 && sellCalls[0].pct === 100 && sellCalls[0].wid === 'w1');
  A('autoProtect loss → aggressive slippage/gas opts', !!sellCalls[0] && sellCalls[0].opts && sellCalls[0].opts.slipAddBps >= 1000 && sellCalls[0].opts.gasMult >= 2);
  A('autoProtect loss → DM sent', notes.some((n) => /Auto-protect sold/.test(n.text)));

  // Guard OFF: same loss, autoProtect false → no sell
  resetPos(); USERS.length = 0; USERS.push(mkUser(false, mkPos({})));
  await T.positionsCycle();
  A('guard OFF → no auto-sell', sellCalls.length === 0);

  // AUDIT #1 FIX: a WINNER that retraced from a high peak is still in profit → must NOT sell.
  // value 0.5 vs cost 0.10 = +400% profit, but 90% below peak 5.0.
  resetPos(); SNAP_PRICE = 0.5; SAFE = { supported: true, sec: { honeypot: false, sellTaxPct: 0 } };
  USERS.length = 0; USERS.push(mkUser(true, mkPos({ peakValueEth: 5.0 })));
  await T.positionsCycle();
  A('profitable retrace from peak → NOT sold', sellCalls.length === 0);

  // Mild loss (20% down on entry), contract safe → no sell
  resetPos(); SNAP_PRICE = 0.08; SAFE = { supported: true, sec: { honeypot: false, sellTaxPct: 0 } };
  USERS.length = 0; USERS.push(mkUser(true, mkPos({})));
  await T.positionsCycle();
  A('mild loss + safe → no auto-sell', sellCalls.length === 0);

  // AUDIT #2 FIX: honeypot flag triggers even in mild loss; pausable/blacklist (not modeled
  // here) would NOT. Only honeypot / sellTax≥50 fire.
  resetPos(); SNAP_PRICE = 0.08; SAFE = { supported: true, sec: { honeypot: true } };
  USERS.length = 0; USERS.push(mkUser(true, mkPos({})));
  await T.positionsCycle();
  A('honeypot flag → auto-sell 100%', sellCalls.length === 1 && sellCalls[0].pct === 100);

  // sell-tax spike (≥50%) also triggers
  resetPos(); SNAP_PRICE = 0.08; SAFE = { supported: true, sec: { honeypot: false, sellTaxPct: 80 } };
  USERS.length = 0; USERS.push(mkUser(true, mkPos({})));
  await T.positionsCycle();
  A('sell-tax spike → auto-sell 100%', sellCalls.length === 1);

  // legit high BUY tax but sellable → NOT sold (only sellTax matters)
  resetPos(); SNAP_PRICE = 0.08; SAFE = { supported: true, sec: { honeypot: false, buyTaxPct: 40, sellTaxPct: 5 } };
  USERS.length = 0; USERS.push(mkUser(true, mkPos({})));
  await T.positionsCycle();
  A('high buy-tax but sellable → NOT sold', sellCalls.length === 0);

  // Cooldown: loss but protectAt just now → no repeat sell
  resetPos(); SNAP_PRICE = 0.03; SAFE = { supported: false, sec: null };
  USERS.length = 0; USERS.push(mkUser(true, mkPos({ notified: { protectAt: Date.now() } })));
  await T.positionsCycle();
  A('cooldown → no repeat auto-sell', sellCalls.length === 0);

  // Honeypot: loss triggers sell but sell throws → failure DM, no crash
  resetPos(); SNAP_PRICE = 0.03; SELL_BEHAVIOR = { throw: true, msg: 'reverted: cannot sell' };
  USERS.length = 0; USERS.push(mkUser(true, mkPos({})));
  await T.positionsCycle();
  A('honeypot sell fails → failure DM, no throw', sellCalls.length === 1 && notes.some((n) => /couldn't exit/.test(n.text)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
