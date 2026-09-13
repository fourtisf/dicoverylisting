'use strict';
/*
 * snipePanel.test.js — the 🎛 Snipe Setup panel ("saya ingin fitur snipe sama
 * seperti sol trading bot ada setingan lengkap buat semudah mungkin").
 *
 * The panel is a persisted DRAFT rendered as tappable rows over the SAME
 * target store as the one-line arm. The money rules this file holds:
 *
 *   • a draft never spends and never arms by itself — only ⚡ does, and it
 *     goes THROUGH addSnipeTarget, the single owner of what a valid target is;
 *   • the amount has NO default — the "buy ngasal" incident was an amount set
 *     weeks earlier on another screen, silently reused;
 *   • a REFUSED arm keeps the draft, so the user fixes one row, not seven;
 *   • a chain switch drops a target address that cannot exist on the new
 *     chain — keeping it would be the wrong-chain bounce one screen later.
 *
 * Offline: no RPC, no Telegram. The Telegram driver stubs global.fetch.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'snipepanel-'));
process.env.WALLET_SECRET = 'w'.repeat(48);
process.env.TRADEBOT_TOKEN = 'x:y';
process.env.ENABLED_CHAINS = 'robinhood,solana';

const core = require('./core');
const tg = require('./telegram');
const watchers = require('./watchers');

const CA = '0x39dBED3a2bd333467115dE45665cC57F813C4571';
const CA2 = '0x' + 'b'.repeat(40);
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const CHAT = 77;

function user() {
  core.DB.users = {};
  const u = core.ensureUser(CHAT);
  u.wallets = [
    { id: 'w1', name: 'utama', address: '0x' + '1'.repeat(40), positions: {}, orders: [], history: [] },
    { id: 'w2', name: '', address: '0x' + '2'.repeat(40), positions: {}, orders: [], history: [] },
  ];
  u.activeWalletId = 'w1';
  u.snipeDraft = null;
  return u;
}

/** Drive the real Telegram text handler with a pending step — a bare action
 *  name, or a full pending object for mid-wizard steps. */
async function typed(action, text) {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    try { const b = JSON.parse(opt.body); if (/sendMessage/.test(String(url))) sent.push(b.text); } catch (_) {}
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  try { await tg._test.resolvePending(CHAT, typeof action === 'string' ? { action } : action, text, {}); }
  finally { global.fetch = realFetch; }
  return sent.join('\n');
}

// ── the draft ────────────────────────────────────────────────────────────────

test('a new draft starts on the user chain and active wallet, with NO amount', () => {
  const u = user();
  const d = core.newSnipeDraft(CHAT);
  assert.equal(d.chain, core.userChain(u));
  assert.deepEqual(d.walletIds, ['w1']);
  // The "buy ngasal" rule: spending is an explicit choice every time. A draft
  // with a default amount is an amount set by nobody.
  assert.strictEqual(d.amount, null);
  assert.strictEqual(d.ca, null);
  assert.equal(d.slipPct, 0);
  assert.equal(d.tpPct, 0);
  assert.equal(d.slPct, 0);
  assert.equal(d.ttlH, core.SNIPE_DRAFT_TTL_H);
});

test('every row is bounded exactly like addSnipeTarget, and a refused patch changes nothing', () => {
  user();
  core.newSnipeDraft(CHAT);
  assert.throws(() => core.updateSnipeDraft(CHAT, { slipPct: 90 }), /0–50/);
  assert.throws(() => core.updateSnipeDraft(CHAT, { slPct: 100 }), /below 100/);
  assert.throws(() => core.updateSnipeDraft(CHAT, { tpPct: 200000 }), /0–100000/);
  assert.throws(() => core.updateSnipeDraft(CHAT, { ttlH: 0 }), /1–168/);
  assert.throws(() => core.updateSnipeDraft(CHAT, { ttlH: 200 }), /1–168/);
  assert.throws(() => core.updateSnipeDraft(CHAT, { amount: 0 }), /> 0/);
  assert.throws(() => core.updateSnipeDraft(CHAT, { walletId: 'nope' }), /no such wallet/);
  assert.throws(() => core.updateSnipeDraft(CHAT, { chain: 'ethereum' }), /not enabled/);
  const d = core.snipeDraft(core.ensureUser(CHAT));
  assert.strictEqual(d.amount, null);
  assert.equal(d.slipPct, 0);
  assert.deepEqual(d.walletIds, ['w1']);
});

test('a Solana mint is refused on an EVM chain row, and vice versa', () => {
  user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood' });
  assert.throws(() => core.updateSnipeDraft(CHAT, { ca: MINT }), /invalid contract address/);
  core.updateSnipeDraft(CHAT, { chain: 'solana' });
  assert.throws(() => core.updateSnipeDraft(CHAT, { ca: CA }), /invalid Solana token mint/);
});

test('switching chains DROPS a target that cannot exist there, keeps one that can', () => {
  user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA });
  // EVM → Solana: a 0x address cannot be a mint. Keeping it would be the
  // wrong-chain bounce one screen later; silence would read as the bot losing
  // the address (the caller renders the note).
  let d = core.updateSnipeDraft(CHAT, { chain: 'solana' });
  assert.strictEqual(d.ca, null);
  core.updateSnipeDraft(CHAT, { ca: MINT });
  d = core.updateSnipeDraft(CHAT, { chain: 'robinhood' });
  assert.strictEqual(d.ca, null);
  // Same-shape switch keeps the address.
  core.updateSnipeDraft(CHAT, { ca: CA2 });
  d = core.updateSnipeDraft(CHAT, { chain: 'robinhood' });
  assert.equal(d.ca, CA2);
});

// ── arming ───────────────────────────────────────────────────────────────────

test('a draft never arms by itself — filling every row creates no target', () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA, amount: 0.05, slipPct: 25, tpPct: 100, slPct: 50, ttlH: 12 });
  assert.equal(core.armedSnipeTargets(u).length, 0, 'updating the panel armed a snipe');
});

test('⚡ refuses a panel with no target or no amount, and says WHICH row is missing', () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  assert.throws(() => core.armSnipeDraft(CHAT), /no target/i);
  core.updateSnipeDraft(CHAT, { ca: CA });
  assert.throws(() => core.armSnipeDraft(CHAT), /no amount/i);
  // A refused arm keeps the draft — the user fixes one row, not seven.
  const d = core.snipeDraft(u);
  assert.ok(d && d.ca === CA, 'a refused arm discarded the draft');
  assert.equal(core.armedSnipeTargets(u).length, 0);
});

test('⚡ arms THROUGH addSnipeTarget with every panel row mapped, then clears the draft', () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA, walletId: 'w2', amount: 0.05, slipPct: 25, tpPct: 100, slPct: 50, ttlH: 12 });
  const t = core.armSnipeDraft(CHAT);
  assert.equal(t.status, 'armed');
  assert.equal(t.chain, 'robinhood');
  assert.equal(t.ca, CA);
  assert.equal(t.amount, '0.05');
  assert.equal(t.slipBps, 2500);
  assert.equal(t.tpPct, 100);
  assert.equal(t.slPct, 50);
  assert.equal(t.walletId, 'w2', 'the snipe did not bind to the wallet picked on the panel');
  assert.ok(Math.abs((t.expiresAt - t.createdAt) - 12 * 3600000) < 2000, 'the panel expiry was ignored');
  assert.strictEqual(core.snipeDraft(u), null, 'an armed draft must not linger and re-arm');
});

test('a REFUSED arm leaves the draft intact — the user fixes one row, not seven', () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  // No amount: the refusal this rule was written for. (An ALREADY-ARMED target
  // is no longer a refusal at all — tapping the panel's arm row re-terms it,
  // see the update tests below.)
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA });
  assert.throws(() => core.armSnipeDraft(CHAT), /no amount/);
  assert.ok(core.snipeDraft(u), 'the draft was discarded on a refused arm');
  assert.equal(core.armedSnipeTargets(u).length, 0, 'the refused arm still created a target');
});

test('arming the SAME contract twice re-terms one target, never a second', () => {
  const u = user();
  core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05 });
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA, amount: 0.1 });
  const t = core.armSnipeDraft(CHAT);
  assert.equal(t._updated, true, 'a duplicate CA arm is still refused instead of updating');
  assert.equal(core.armedSnipeTargets(u).length, 1, 'a second target was armed for one contract');
  assert.equal(core.snipeDraft(u), null, 'a SPENT draft must be cleared');
});

test('a chain disabled AFTER the draft was written is refused, never silently swapped', () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA, amount: 0.05 });
  // Simulate ENABLED_CHAINS changing under a stored draft. addSnipeTarget
  // would fall back to the ACTIVE chain — right for a typed line, silently
  // wrong-chain for a panel whose chain row is the first thing on screen.
  core.snipeDraft(u).chain = 'ethereum';
  assert.throws(() => core.armSnipeDraft(CHAT), /disabled/);
});

// ── restarts ─────────────────────────────────────────────────────────────────

test('a restart keeps a half-configured panel and normalizes garbage', () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { ca: CA, slipPct: 25 });
  core.ensureUser(CHAT);   // the migration pass every load runs
  assert.equal(core.snipeDraft(u).ca, CA, 'a restart lost the draft');
  u.snipeDraft = 'garbage';
  core.ensureUser(CHAT);
  assert.strictEqual(core.snipeDraft(u), null, 'a corrupt draft survived the migration');
});

// ── the panel screen ─────────────────────────────────────────────────────────

test('required rows read ⏳ until set and ✅ after — the reference STATUS column', () => {
  user();
  core.newSnipeDraft(CHAT);
  const before = tg._test.snipeSetupScreen(CHAT).text;
  assert.ok(before.includes('⏳'), 'an unset required row shows no waiting state');
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA, amount: 0.05 });
  const after = tg._test.snipeSetupScreen(CHAT).text.replace(/<[^>]+>/g, '');
  assert.ok(!after.includes('⏳'), 'a fully configured panel still says waiting');
  assert.ok(after.includes(CA), 'the target address is not on the panel');
  assert.ok(after.includes('0.05'), 'the amount is not on the panel');
});

test('the keyboard is label + value per row, and ⚡ is on it', () => {
  user();
  core.newSnipeDraft(CHAT);
  const kb = tg._test.snipeSetupScreen(CHAT).kb.inline_keyboard;
  // Two buttons a row, both opening the same editor — the reference's
  // two-column table, with no wrong half to tap.
  const chainRow = kb[0];
  assert.equal(chainRow.length, 2);
  assert.equal(chainRow[0].callback_data, 'snw:chain');
  assert.equal(chainRow[1].callback_data, 'snw:chain');
  const flat = kb.flat().map((b) => b.callback_data);
  for (const cb of ['snw:ca', 'snw:wal', 'snw:amt', 'snw:slip', 'snw:tpsl', 'snw:ttl', 'snw:arm', 'snw:cancel', 'csnadd']) {
    assert.ok(flat.includes(cb), `the panel keyboard lost ${cb}`);
  }
});

test('the sniper home offers the panel FIRST, the one-line arm second', () => {
  user();
  const kb = tg._test.caSnipeScreen(CHAT).kb.inline_keyboard;
  assert.equal(kb[0][0].callback_data, 'snw:open');
  assert.equal(kb[1][0].callback_data, 'csnadd');
});

test('🎯 Snipe and /snipe open the sniper HOME, not the buy-everything screen', () => {
  // "masih sama aja, setinganya bukan yang saya inginkan": the panel shipped,
  // but the menu's 🎯 Snipe still opened the mass-mode screen — and the user,
  // hunting for the sniper there, armed a 0.1 SOL buy-every-launch instead.
  // The word "snipe" means "snipe THIS token"; mass mode is a labelled choice.
  const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  assert.match(SRC, /if \(data === 'snipe'\) \{ const s = caSnipeScreen\(chatId\)/, "the menu's 🎯 Snipe reverted to mass mode");
  assert.match(SRC, /if \(data === 'snmass'\) \{ const s = snipeScreen\(chatId\)/, 'mass mode lost its own route');
  assert.match(SRC, /text === '\/snipe' \|\| text === '\/sniper'\) \{ const s = caSnipeScreen/, '/snipe reverted to mass mode');
});

test('the home SAYS when mass mode is armed — money state is never two screens away', () => {
  const u = user();
  u.snipe.chains = { solana: true };
  u.snipe.ethAmount = '0.1';
  const s = tg._test.caSnipeScreen(CHAT);
  assert.match(s.text.replace(/<[^>]+>/g, ''), /0\.1/, 'the per-launch spend is not on the home');
  const buttons = s.kb.inline_keyboard.flat();
  const mass = buttons.find((b) => b.callback_data === 'snmass');
  assert.ok(mass, 'no way from the home to mass mode');
  assert.match(mass.text, /🟢/, 'an armed mass mode looks the same as an idle one');
  assert.match(mass.text, /0\.1/, 'the armed button hides the spend');
  assert.ok(buttons.some((b) => b.callback_data === 'cpaddd'), 'no way from the home into the dev-snipe wizard');
  // …and idle reads idle, or the green dot means nothing.
  u.snipe.chains = {};
  const idle = tg._test.caSnipeScreen(CHAT).kb.inline_keyboard.flat().find((b) => b.callback_data === 'snmass');
  assert.ok(!/🟢/.test(idle.text), 'an idle mass mode still shows the armed dot');
});

test('the amount editor offers the CHAIN\'s presets, not another coin\'s', () => {
  user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'solana' });
  const kb = tg._test.snwAmountScreen(CHAT).kb.inline_keyboard;
  const labels = kb.flat().map((b) => b.text).join(' ');
  // Solana's presets (0.1…2 SOL) — 0.01 of one coin is not 0.01 of another,
  // and the sub-dollar ETH ladder was exactly the dust-trade defect.
  assert.match(labels, /0\.1 SOL/);
  assert.ok(!/0\.01 SOL/.test(labels), 'the ETH-denominated ladder leaked onto Solana');
});

test('the armed confirmation is a NEW message, not an edit of the panel', () => {
  // "dmn ada teks snipe atau confirm??" — it was there, written into the panel
  // message in place. An in-place edit notifies nobody and lands off screen the
  // moment the user has scrolled, so arming a snipe that spends real money
  // looked like nothing happened at all. Same lesson the raid card cost us.
  const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  const arm = SRC.slice(SRC.indexOf("if (ca === 'arm')"), SRC.indexOf('// \'open\' and anything unrecognised'));
  assert.ok(arm.length > 200, 'the arm handler moved — this test is asserting nothing');
  // The panel is retired where it stands (its buttons must not survive a spent
  // draft) and the confirmation is SENT.
  assert.match(arm, /await edit\(chatId, mid, T\(chatId, 'snipe\.panel\.spent'\)\)/, 'the stale panel is left tappable');
  assert.match(arm, /return send\(chatId, text, kb\)/, 'the confirmation is edited in place again — it will not be seen');
  // …and the confirmation itself still carries the money facts of both kinds.
  assert.match(arm, /dev\.armed_wallets/);
  assert.match(arm, /snipeArmedText\(chatId, tgt\)/);
});

test('the panel says it is not armed until ⚡ is tapped', () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  const empty = tg._test.snipeSetupScreen(CHAT).text.replace(/<[^>]+>/g, '');
  assert.match(empty, /Fill the rows|Isi dulu/i, 'an unfinished panel gives no next step');
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA, amount: 0.05 });
  const done = tg._test.snipeSetupScreen(CHAT).text.replace(/<[^>]+>/g, '');
  assert.match(done, /Ready|Siap/i, 'a finished panel never says it is ready');
  assert.match(done, /Nothing is armed yet|Belum terpasang/i, 'a finished panel reads as already armed');
  assert.equal(core.armedSnipeTargets(u).length, 0);
});

test('the ⚡ handler goes through core.armSnipeDraft and never around it', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  const block = SRC.slice(SRC.indexOf("if (k === 'snw')"), SRC.indexOf("if (data === 'rstog')"));
  assert.match(block, /core\.armSnipeDraft\(chatId\)/, '⚡ no longer arms through the draft');
  assert.ok(!block.includes('addSnipeTarget'), 'the panel grew a second arming site around armSnipeDraft');
  assert.ok(!block.includes('addCopyTarget'), 'the panel arms dev targets around armSnipeDraft');
  // The panel re-renders with the reason IN it, where the row to fix is one tap
  // away — AND the reason is sent to the bottom of the chat, because the panel
  // edit lands off screen for anyone scrolled to the buttons ("pas pilih arm
  // malah tidak mau respon"). Both, not either.
  assert.match(block, /const s = snipeSetupScreen\(chatId, why\)/, 'the refusal stopped re-rendering the panel');
  assert.match(block, /return send\(chatId, T\(chatId, 'snipe\.panel\.refused_msg'/, 'a refused arm is silent again wherever the reader is scrolled');
});

// ── the Target paste ─────────────────────────────────────────────────────────

test('pasting a full one-line arm into the Target step fills EVERY panel row', async () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood' });
  await typed('snw_ca', `${CA} 0.05 25 100/50 12`);
  const d = core.snipeDraft(u);
  assert.equal(d.ca, CA);
  assert.equal(d.amount, '0.05');
  assert.equal(d.slipPct, 25);
  assert.equal(d.tpPct, 100);
  assert.equal(d.slPct, 50);
  assert.equal(d.ttlH, 12);
  assert.equal(core.armedSnipeTargets(u).length, 0, 'a pasted line armed without ⚡');
});

test('a bare address fills only the Target row and leaves the rest alone', async () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', slipPct: 10 });
  await typed('snw_ca', CA);
  const d = core.snipeDraft(u);
  assert.equal(d.ca, CA);
  assert.strictEqual(d.amount, null, 'a bare address invented an amount');
  assert.equal(d.slipPct, 10, 'a bare address reset a configured row');
});

test('a mint pasted under an EVM row switches the chain when the shape is unambiguous', async () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood' });
  const out = await typed('snw_ca', MINT);
  const d = core.snipeDraft(u);
  assert.equal(d.chain, 'solana', 'the wrong-chain bounce is back');
  assert.equal(d.ca, MINT);
  // …and says so — a chain that moves silently is a setting the user cannot explain.
  assert.match(out.replace(/<[^>]+>/g, ''), /Solana/);
});

test('a bad paste is refused with a reason and the draft is untouched', async () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood' });
  const out = await typed('snw_ca', 'not-an-address 0.05');
  assert.match(out.replace(/<[^>]+>/g, ''), /not a valid/i);
  assert.strictEqual(core.snipeDraft(u).ca, null);
  const out2 = await typed('snw_ca', `${CA} 0.05 90`);
  assert.match(out2.replace(/<[^>]+>/g, ''), /Slippage/i);
  assert.strictEqual(core.snipeDraft(u).ca, null, 'a line refused for slippage still stored its address');
});

test('the panel flows FORWARD: a saved target asks for the amount next', async () => {
  // "jadiin 1 aja, jangan pisah2": after a required row lands, the next
  // missing one is asked immediately — the user is never dumped back at the
  // panel to find the next ⏳ themselves.
  user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood' });
  const out = await typed('snw_ca', CA);
  assert.match(out.replace(/<[^>]+>/g, ''), /Amount|Jumlah/i, 'after the target the user was dumped back at the panel');
  // …but with the amount already set, the paste returns to the panel, ready to ⚡.
  core.updateSnipeDraft(CHAT, { amount: 0.05 });
  const out2 = await typed('snw_ca', CA2);
  assert.match(out2.replace(/<[^>]+>/g, ''), /Snipe Setup|Setup Snipe/i);
});

test("the panel's Target offers BOTH kinds — token contract and dev wallet", () => {
  // "dmn target dev walletnya": the reference panel's Targeted mode covers a
  // dev wallet as well as a token address; ours hid dev snipe behind another
  // screen. A wallet and a CA share the same address shape on every chain, so
  // the user says which they mean — no paste can be auto-classified.
  const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  const block = SRC.slice(SRC.indexOf("if (k === 'snw')"), SRC.indexOf("if (data === 'rstog')"));
  assert.match(block, /'snw:cat'/, 'the token-contract choice is gone from the Target step');
  assert.match(block, /'snw:cad'/, 'the dev-wallet choice is gone from the Target step');
  // The dev choice lands ON THE DRAFT (kind 'dev') and the panel takes over.
  assert.match(block, /updateSnipeDraft\(chatId, \{ kind: 'dev' \}\)/);
  assert.match(block, /setPending\(chatId, \{ action: 'snw_dev' \}\)/);
});

test('switching target kind clears the address — a CA is not a dev wallet', () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA });
  // Shape-valid both ways, semantically wrong both ways: keeping it would arm
  // a watch that can never fire — the inert-watch failure mode.
  const d = core.updateSnipeDraft(CHAT, { kind: 'dev' });
  assert.strictEqual(d.ca, null, 'a token CA survived becoming a "dev wallet"');
  core.updateSnipeDraft(CHAT, { ca: CA2 });
  assert.strictEqual(core.updateSnipeDraft(CHAT, { kind: 'ca' }).ca, null);
  assert.ok(core.snipeDraft(u));
});

test('the dev panel carries every setting the engine honours, and only those', () => {
  // "berapa banyak wallet serta slippage … auto sale tp dimana fiturnya":
  // wallet, slippage and TP/SL are honoured by _followerBuy now, so they get
  // rows. Expiry is not (a copy target does not expire) and stays hidden — a
  // row the backend ignores is the stop-loss-the-user-believes-exists.
  user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'solana', kind: 'dev' });
  const s = tg._test.snipeSetupScreen(CHAT);
  const flat = s.kb.inline_keyboard.flat().map((b) => b.callback_data);
  for (const cb of ['snw:wal', 'snw:slip', 'snw:tpsl']) {
    assert.ok(flat.includes(cb), `the dev panel lost ${cb}`);
  }
  assert.ok(!flat.includes('snw:ttl'), 'the dev panel shows an expiry the dev path ignores');
  // The budget row went with the FEATURE, not just off the screen — a row for
  // a setting the engine no longer reads is the same defect as an expiry row.
  assert.ok(!flat.includes('snw:bud'), 'the budget row is back, for a cap that no longer exists');
  // …and the wallet picker is the same multi-select the CA kind gets: the
  // exit mirror records one LEG per wallet now, so every slice is sold from
  // the wallet that bought it.
  const pick = tg._test.snwWalletScreen(CHAT).kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(pick.includes('snww:*'), 'the dev wallet picker lost ✅ All on');
  assert.ok(pick.includes('snw:waln'), 'the dev wallet picker lost ⬜ All off');
  assert.ok(pick.some((cb) => String(cb).startsWith('snwwt:')), 'the dev wallet picker lost its toggles');
});

test('the engine honours the dev rows: wallet, slippage, TP/SL at the fill', () => {
  const W = fs.readFileSync(path.join(__dirname, 'watchers.js'), 'utf8');
  const fn = W.slice(W.indexOf('async function _followerBuy('), W.indexOf('async function _targetBalance('));
  assert.ok(fn.length > 400, '_followerBuy moved — this test is asserting nothing');
  // The panel-picked SELECTION wins — '*', a subset (deleted wallets dropped),
  // or one — and no selection falls back to the active wallet rather than
  // silently buying nothing.
  assert.match(fn, /t\.walletId === '\*'/);
  assert.match(fn, /t\.walletIds\.filter\(\(id\) => wl\.some\(\(w\) => w\.id === id\)\)/);
  assert.match(fn, /t\.walletId && wl\.some\(\(w\) => w\.id === t\.walletId\)/);
  // Per-target slippage REPLACES the user's normal bound, unset means normal —
  // the same contract as the CA snipe.
  assert.match(fn, /\{ slipBps: t\.slipBps \|\| undefined \}/);
  // TP/SL become real orders at the fill, at the realised entry, bound to the
  // wallet that bought — and a placement failure is said out loud.
  assert.match(fn, /const entry = Number\(r\.spentEth\) \/ \(Number\(r\.gotTokens\) \|\| 1\);/);
  assert.match(fn, /targetPriceEth: entry \* \(1 \+ t\.tpPct \/ 100\)/);
  assert.match(fn, /targetPriceEth: entry \* \(1 - t\.slPct \/ 100\)/);
  assert.match(fn, /Couldn't place the auto-exit/);
  assert.strictEqual((fn.match(/\}, wid\)/g) || []).length, 2, 'a dev TP/SL order binds to the wrong wallet');
});

test('the dev target stores wallet, slippage and TP/SL, and NO budget', () => {
  const u = user();
  const t = core.addCopyTarget(CHAT, MINT, 'solana', 0.05, null, 'launches', { walletId: 'w2', slipBps: 2500, tpPct: 100, slPct: 50 });
  assert.equal(t.walletId, 'w2');
  assert.equal(t.slipBps, 2500);
  assert.equal(t.tpPct, 100);
  assert.equal(t.slPct, 50);
  // NO CAP AT ALL: the budget feature was removed outright on the owner's call
  // ("hapus fitur budget jdi budget fiturnya tidak ada"). What replaces it is
  // the panel and the confirmation saying the watch is uncapped — see
  // buys by default, stated on the armed message.
  assert.equal(t.maxEth, undefined, 'a dev target grew a cap back');
  assert.throws(() => core.addCopyTarget(CHAT, CA, 'robinhood', 0.05, null, 'launches', { walletId: 'nope' }), /no such wallet/);
  assert.ok(u.copy.targets.length >= 1);
});

test('a multi-wallet dev target prices its LAUNCH by the selection', () => {
  // The budget that made this a floor is gone; the per-LAUNCH arithmetic it was
  // built on is not — it is what every screen and the confirmation quote.
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { kind: 'dev', chain: 'robinhood', ca: CA, walletIds: '*', amount: 0.05 });
  const t = core.armSnipeDraft(CHAT);
  assert.equal(core.copyFanOut(u, t), core.walletList(u).length, 'the selection did not reach the target');
  assert.equal(t.buyEth, '0.05', 'the per-WALLET amount is what is stored');
  assert.equal(t.maxEth, undefined, 'an uncapped target must carry no cap field');
});


test('a dev snipe on several wallets says PER LAUNCH, not one-shot', () => {
  // The cadence belongs to the feature: a CA snipe fires once, a dev snipe
  // fires on every launch. Keying the sentence on '*'-vs-subset put the
  // one-shot wording on the recurring watch.
  const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  const arm = SRC.slice(SRC.indexOf("if (ca === 'arm')"), SRC.indexOf("if (ca === 'cancel')") > SRC.indexOf("if (ca === 'arm')") ? SRC.indexOf("if (ca === 'cancel')") : SRC.indexOf("if (k === 'snww'"));
  assert.match(arm, /walletScopeLine\(chatId, tgt, tgt\.buyEth, chG\.native, 'dev\.armed_wallets'\)/, 'the dev arm lost its recurring wording');
  const i18n = require('./i18n');
  // EVERY launch, and no cap — the two facts that separate this from the CA
  // snipe's one-shot total.
  const devLine = i18n.t('en', 'dev.armed_wallets', { scope: '3 wallets', amt: '0.05', native: 'SOL', total: '0.15' });
  assert.match(devLine, /EVERY launch/i);
  assert.match(devLine, /no cap/i, 'the recurring line no longer says the spend is uncapped');
  assert.match(i18n.t('en', 'snipe.panel.armed_wallets', { scope: '3 wallets', amt: '0.05', native: 'SOL', total: '0.15' }), /in total/i);
});

// ── the dev-wallet target, on the panel ──────────────────────────────────────

test('the dev flow is wallet → amount → ⚡, and nothing arms before ⚡', async () => {
  // "aturan hapus aja, jadiin 1 aja … pas udah drop wallet harusnya ada custom
  // amount." Two questions total: the wallet, then the amount — there is no
  // budget question, because there is no budget.
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'solana', kind: 'dev' });
  const out1 = await typed('snw_dev', MINT);
  assert.match(out1.replace(/<[^>]+>/g, ''), /Amount|Jumlah/i, 'the wallet alone did not lead to the amount question');
  const out2 = await typed('snw_amt', '0.05');
  assert.match(out2.replace(/<[^>]+>/g, ''), /Snipe Setup|Setup Snipe/i, 'the amount did not return to the panel');
  assert.equal(((u.copy && u.copy.targets) || []).length, 0, 'the panel armed before ⚡');
  const tgt = core.armSnipeDraft(CHAT);
  assert.equal(tgt.mode, 'launches');
  assert.equal(tgt.chain, 'solana');
  assert.equal(tgt.address, MINT);
  assert.equal(tgt.buyEth, '0.05');
  assert.equal(tgt.maxEth, undefined, 'the dev flow grew a budget back');
  assert.strictEqual(core.snipeDraft(u), null, 'an armed dev draft lingered');
});

test('a re-pasted dev wallet re-asks the amount even when one is already set', async () => {
  // The spend is confirmed PER TARGET — a stale amount silently reused is the
  // "buy ngasal" incident at the wizard level.
  user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'solana', kind: 'dev', amount: 0.1 });
  const out = await typed('snw_dev', MINT);
  assert.match(out.replace(/<[^>]+>/g, ''), /Amount|Jumlah/i, 'a stale amount was silently reused');
});

test('the old one-line dev arm fills every row in one go', async () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'solana', kind: 'dev' });
  await typed('snw_dev', `${MINT} 0.05 0.5`);
  const d = core.snipeDraft(u);
  assert.equal(d.ca, MINT);
  assert.equal(d.amount, '0.05');
  // A THIRD word on the old line was the budget. The feature is gone and the
  // word is IGNORED rather than refused — an operator with the old grammar in
  // muscle memory must not have their target rejected over a dead setting.
  assert.equal(d.budget, undefined, 'the draft grew the budget field back');
  assert.ok(core.armSnipeDraft(CHAT), 'a fully pasted line could not arm');
});

test('a refused dev step keeps the draft where it was', async () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'solana', kind: 'dev' });
  assert.match((await typed('snw_dev', 'not-an-address')).replace(/<[^>]+>/g, ''), /not a valid|bukan alamat/i);
  assert.strictEqual(core.snipeDraft(u).ca, null);
  core.updateSnipeDraft(CHAT, { ca: MINT, amount: 0.05 });
  // A bad AMOUNT is refused by the same rule the store enforces — at the row,
  // instead of being discovered at ⚡. (The budget step it used to test is
  // gone with the feature.)
  assert.throws(() => core.updateSnipeDraft(CHAT, { amount: 0 }), /amount/i);
  assert.strictEqual(core.snipeDraft(u).amount, '0.05', 'a refused row changed the draft anyway');
  const tgt = core.armSnipeDraft(CHAT);
  assert.equal(tgt.maxEth, undefined);
});

test('an OFF master switch is said at ⚡, with the one-tap fix', () => {
  // Arming a watch that silently does nothing is the stop-loss-the-user-
  // believes-exists — dev snipe only runs while copy.on is true, so the arm
  // handler says so with the 🟢 button on the same message.
  const SRC = fs.readFileSync(path.join(__dirname, 'telegram.js'), 'utf8');
  const block = SRC.slice(SRC.indexOf("if (k === 'snw')"), SRC.indexOf("if (data === 'rstog')"));
  assert.match(block, /dev\.master_off/, 'an inert dev arm reads as a live one');
  assert.match(block, /dev\.on_btn'\), 'cptog'/, 'the OFF note lost its one-tap fix');
});

// ── all wallets ──────────────────────────────────────────────────────────────

test('the wallet row offers 👥 All, arms as "*", and the total is stated', () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  const kb = tg._test.snwWalletScreen(CHAT).kb.inline_keyboard;
  assert.ok(kb.flat().some((b) => b.callback_data === 'snww:*'), 'no All-wallets choice on the picker');
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA, amount: 0.05, walletId: '*' });
  const t = core.armSnipeDraft(CHAT);
  assert.equal(t.walletId, '*');
  // The armed confirmation states the multiplied total — real money must never
  // hide behind a multiplier. user() has 2 wallets: 0.05 × 2 = 0.1.
  const txt = tg._test.snipeArmedText(CHAT, t).replace(/<[^>]+>/g, '');
  assert.match(txt, /0\.1/, 'the multiplied total is not on the confirmation');
  assert.ok(core.snipeTargetById(u, t.id), 'the target was not stored');
});

test('an all-wallet target buys on EVERY wallet from one probe, and settles once', async () => {
  const u = user();
  const t = core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05, walletId: '*' });
  let probes = 0;
  const wids = [];
  const real = { can: core.canTradeNow, buy: core.buy };
  core.canTradeNow = async () => { probes++; return true; };
  core.buy = async (cid, ca2, amt, chain, wid) => { wids.push(wid); return { chain, native: 'ETH', ca: ca2, hash: '0x' + wids.length, spentEth: 0.05, gotTokens: 10, sym: 'P' }; };
  const notes = [];
  watchers.setNotifier((chatId, text) => { notes.push(text); });
  try { await watchers._test.caSnipeCycle(); } finally { core.canTradeNow = real.can; core.buy = real.buy; watchers.setNotifier(() => {}); }
  assert.deepEqual(wids.sort(), ['w1', 'w2'], 'not every wallet bought');
  assert.equal(probes, 1, 'the contract was probed once per wallet');
  assert.equal(core.snipeTargetById(u, t.id).status, 'done');
  assert.ok(notes.some((n) => /2\/2 wallets/.test(n)), 'the fill does not say how many wallets filled');
});

test('the picker is a MULTI-SELECT: toggles compose a subset, and the subset fires', async () => {
  // "bisa pilih multi wallet, all on atau all off, sama kaya beli atau sell."
  const u = user();
  core.newSnipeDraft(CHAT);
  // The picker carries toggles plus ✅ All on / ⬜ All off.
  const pick = tg._test.snwWalletScreen(CHAT).kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(pick.includes('snwwt:w1') && pick.includes('snwwt:w2'), 'the per-wallet toggles are gone');
  assert.ok(pick.includes('snww:*'), '✅ All on is gone');
  assert.ok(pick.includes('snw:waln'), '⬜ All off is gone');
  // A subset survives the round trip to the target and fires on EXACTLY it.
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA, amount: 0.05, walletIds: ['w1', 'w2'] });
  const t = core.armSnipeDraft(CHAT);
  assert.deepEqual(t.walletIds, ['w1', 'w2']);
  // …and the armed confirmation states the multiplied total (0.05 × 2 = 0.1),
  // in the ONE-SHOT cadence: a CA snipe fires once.
  const armed = tg._test.snipeArmedText(CHAT, t).replace(/<[^>]+>/g, '');
  assert.match(armed, /2 wallets[\s\S]*0\.1/);
  assert.match(armed, /in total/i, 'a one-shot CA snipe is described as recurring');
  assert.ok(!/per launch|every time it fires/i.test(armed), 'a one-shot CA snipe claims a recurring spend');
  const wids = [];
  const real = { can: core.canTradeNow, buy: core.buy };
  core.canTradeNow = async () => true;
  core.buy = async (cid, ca2, amt, chain, wid) => { wids.push(wid); return { chain, native: 'ETH', ca: ca2, hash: '0x' + wids.length, spentEth: 0.05, gotTokens: 10, sym: 'P' }; };
  watchers.setNotifier(() => {});
  try { await watchers._test.caSnipeCycle(); } finally { core.canTradeNow = real.can; core.buy = real.buy; watchers.setNotifier(() => {}); }
  assert.deepEqual(wids.sort(), ['w1', 'w2'], 'the subset did not fire on exactly the picked wallets');
  assert.equal(core.snipeTargetById(u, t.id).status, 'done');
  // An empty selection is refused at ⚡, where the fix is one row away.
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { chain: 'robinhood', ca: CA2, amount: 0.05, walletIds: [] });
  assert.throws(() => core.armSnipeDraft(CHAT), /no wallet selected/i);
});

test('a multi-wallet dev snipe buys on each wallet and records one exit LEG per wallet', async () => {
  const u = user();
  u.copy = { on: true, targets: [] };
  const t = core.addCopyTarget(CHAT, MINT, 'solana', 0.05, null, 'launches', { walletIds: ['w1', 'w2'] });
  assert.deepEqual(t.walletIds, ['w1', 'w2']);
  const wids = [];
  const solana = require('./solana');
  const realBuy = core.buy, realSpl = solana.splBalance;
  core.buy = async (cid, token, amt, chain, wid) => { wids.push(wid); return { chain, native: 'SOL', ca: token, hash: 'sig' + wids.length, spentEth: Number(amt), gotTokens: 100, gotRaw: '1000', sym: 'P' }; };
  solana.splBalance = async () => ({ raw: 5000n });   // the dev's own bag — the exit baseline
  watchers.setNotifier(() => {});
  try { await watchers._test._followerBuy(u, t, MINT, 'solana'); }
  finally { core.buy = realBuy; solana.splBalance = realSpl; watchers.setNotifier(() => {}); }
  assert.deepEqual(wids.sort(), ['w1', 'w2'], 'not every selected wallet bought');
  // The budget was charged for the WHOLE fan-out: 2 × 0.05.
  assert.ok(Math.abs(Number(t.spentEth) - 0.1) < 1e-9, `spentEth ${t.spentEth} — the fan-out was not charged whole`);
  const h = t.holding[core.copyTokenKey('solana', MINT)];
  assert.ok(h, 'the position was not mirrored');
  assert.equal((h.legs || []).length, 2, 'the exit mirror did not record one leg per wallet');
  assert.deepEqual(h.legs.map((l) => l.wid).sort(), ['w1', 'w2']);
  for (const l of h.legs) assert.equal(l.own, '1000', 'a leg lost its own fill amount');
});

test('an inert dev target SAYS so instead of skipping launches in silence', () => {
  // A copy target has no status to settle, so a selection whose wallets were
  // all deleted would sit on the Copy screen reading as live and buy nothing,
  // for ever — the inert-watch failure this repo refuses.
  const W = fs.readFileSync(path.join(__dirname, 'watchers.js'), 'utf8');
  const fn = W.slice(W.indexOf('async function _followerBuy('), W.indexOf('async function _targetBalance('));
  const gate = fn.slice(fn.indexOf('if (!wids.length)'), fn.indexOf('if (!wids.length)') + 700);
  assert.match(gate, /_notify\(/, 'an inert dev target is still skipped silently');
  assert.match(gate, /devnowallet/, 'the notice is not muted per target — it would repeat every launch');
});

test("a '*' CA target with no wallets right now is re-armed, never disarmed", () => {
  // '*' resolves at FIRE time — the documented promise is that a wallet added
  // after arming still snipes, so an empty list is transient. A named
  // selection whose wallets are all gone cannot come back: that one settles.
  const W = fs.readFileSync(path.join(__dirname, 'watchers.js'), 'utf8');
  const fn = W.slice(W.indexOf('async function _fireCaSnipe('), W.indexOf('const chainName ='));
  const gate = fn.slice(fn.indexOf('if (!wids.length)'), fn.indexOf('if (!wids.length)') + 800);
  assert.match(gate, /if \(t\.walletId === '\*'\) \{\s*\n\s*core\.rearmSnipeTarget/, "a '*' target is permanently disarmed by a transient empty wallet list");
  assert.match(gate, /core\.settleSnipeTarget\(u, t\.id, \{ ok: false, err: 'no wallet' \}\)/, 'a dead named selection is left polling for ever');
});

test('a broadcast leg sell is never retried, and the ledger keeps untouched legs', () => {
  const W = fs.readFileSync(path.join(__dirname, 'watchers.js'), 'utf8');
  const loop = W.slice(W.indexOf('let pending = resolved.map('), W.indexOf('if (neverRecorded)'));
  // The buy path's rule, applied to the exit: a broadcast may still land, and a
  // retry would sell the same slice twice.
  assert.match(loop, /if \(err && err\.broadcast\)/, 'a broadcast sell is retried — it may sell the slice twice');
  assert.ok(!/failedLegs\.push[\s\S]{0,200}broadcast/.test(loop) || /err\.broadcast[\s\S]{0,400}continue;/.test(loop));
  // Each leg leaves the ledger only for its OWN sell; the rest stay on, so a
  // crash mid-loop strands nothing that was never attempted.
  assert.match(loop, /core\.copyHoldingSet\(t, token, \{ \.\.\.h, bal: String\(base\), own: pending\[0\]\.own, wid: pending\[0\]\.wid, legs: pending \}\)/);
});

test('the exit mirror sells EVERY leg, each from its own wallet', async () => {
  // The reason multi-wallet dev snipe is honest at all: when the dev dumps,
  // both wallets exit — selling one and stranding the other would be the
  // stop-loss-the-user-believes-exists, per wallet.
  const u = user();
  u.copy = { on: true, targets: [] };
  const t = core.addCopyTarget(CHAT, MINT, 'solana', 0.05, null, 'launches', { walletIds: ['w1', 'w2'] });
  t.holding[core.copyTokenKey('solana', MINT)] = {
    bal: '10000', own: '1000', wid: 'w1', tries: 0,
    legs: [{ wid: 'w1', own: '1000' }, { wid: 'w2', own: '900' }],
  };
  const sold = [];
  const solana = require('./solana');
  const realSell = core.sell, realAcross = core.tokenBalancesAcross, realSpl = solana.splBalance;
  core.sell = async (cid, token, pct, chain, wid, opts) => { sold.push({ wid, exact: opts.exactTokens }); return { sym: 'P', native: 'SOL', hash: 'sig', proceedsEth: 0.04 }; };
  core.tokenBalancesAcross = async () => [
    { id: 'w1', index: 1, label: 'a', raw: 1000n },
    { id: 'w2', index: 2, label: 'b', raw: 900n },
  ];
  // The dev dumped: its own balance reads far below the recorded baseline.
  solana.splBalance = async () => ({ raw: 0n });
  watchers.setNotifier(() => {});
  try { await watchers.copyExitCycle(); }
  finally { core.sell = realSell; core.tokenBalancesAcross = realAcross; solana.splBalance = realSpl; watchers.setNotifier(() => {}); }
  assert.deepEqual(sold.map((s) => s.wid).sort(), ['w1', 'w2'], 'a leg was stranded');
  assert.deepEqual(sold.map((s) => s.exact).sort(), ['1000', '900'].sort(), 'a leg sold the wrong amount');
  assert.ok(!t.holding[core.copyTokenKey('solana', MINT)], 'the position stayed on the ledger after a full exit');
});

test('a mixed record never claims "Nothing was sold" right after selling', async () => {
  // A fan-out that FILLED on w1 and only broadcast on w2 records legs
  // [{w1, own}, {w2, own:''}]. The per-leg loop sells w1 and announces it, then
  // reaches w2's unrecorded fill — and the old wording asserted "Nothing was
  // sold." one message later, about a position that had just been sold.
  const u = user();
  u.copy = { on: true, targets: [] };
  const t = core.addCopyTarget(CHAT, MINT, 'solana', 0.05, null, 'launches', { walletIds: ['w1', 'w2'] });
  t.holding[core.copyTokenKey('solana', MINT)] = {
    bal: '10000', own: '1000', wid: 'w1', tries: 0,
    legs: [{ wid: 'w1', own: '1000' }, { wid: 'w2', own: '' }],
  };
  const solana = require('./solana');
  const notes = [];
  const realSell = core.sell, realAcross = core.tokenBalancesAcross, realSpl = solana.splBalance;
  let sells = 0;
  core.sell = async () => { sells++; return { sym: 'P', native: 'SOL', hash: 'sig', proceedsEth: 0.04 }; };
  core.tokenBalancesAcross = async () => [
    { id: 'w1', index: 1, label: 'a', raw: 1000n },
    { id: 'w2', index: 2, label: 'b', raw: 900n },
  ];
  solana.splBalance = async () => ({ raw: 0n });   // the dev dumped
  watchers.setNotifier((cid, text) => { notes.push(text.replace(/<[^>]+>/g, '')); });
  try { await watchers.copyExitCycle(); }
  finally { core.sell = realSell; core.tokenBalancesAcross = realAcross; solana.splBalance = realSpl; watchers.setNotifier(() => {}); }
  assert.equal(sells, 1, 'the recorded leg did not sell');
  const joined = notes.join('\n');
  assert.match(joined, /you exited/i, 'the sold leg was not reported');
  assert.ok(!/Nothing was sold/i.test(joined), `a sale was followed by "Nothing was sold":\n${joined}`);
  assert.match(joined, /that wallet was not sold/i, 'the unrecorded leg was not reported at all');
});

test('one broke wallet does not stop the others; every wallet empty disarms', async () => {
  const u = user();
  const t = core.addSnipeTarget(CHAT, { ca: CA, chain: 'robinhood', amount: 0.05, walletId: '*' });
  const real = { can: core.canTradeNow, buy: core.buy };
  core.canTradeNow = async () => true;
  const notes = [];
  watchers.setNotifier((chatId, text) => { notes.push(text); });
  core.buy = async (cid, ca2, amt, chain, wid) => {
    if (wid === 'w1') throw new Error('insufficient funds for gas');
    return { chain, native: 'ETH', ca: ca2, hash: '0xok', spentEth: 0.05, gotTokens: 10, sym: 'P' };
  };
  try {
    await watchers._test.caSnipeCycle();
    assert.equal(core.snipeTargetById(u, t.id).status, 'done');
    assert.ok(notes.some((n) => /1\/2 wallets/.test(n)), 'a partial fill reads as a full one');
    // Every wallet empty → disarmed, the same rule the single-wallet path keeps.
    const t2 = core.addSnipeTarget(CHAT, { ca: CA2, chain: 'robinhood', amount: 0.05, walletId: '*' });
    core.buy = async () => { throw new Error('insufficient funds for gas'); };
    await watchers._test.caSnipeCycle();
    assert.equal(core.snipeTargetById(u, t2.id).status, 'failed');
  } finally { core.canTradeNow = real.can; core.buy = real.buy; watchers.setNotifier(() => {}); }
});

test('the typed TP/SL editor accepts 100/50 and off, refuses an impossible SL', async () => {
  const u = user();
  core.newSnipeDraft(CHAT);
  await typed('snw_tpsl', '100/50');
  let d = core.snipeDraft(u);
  assert.equal(d.tpPct, 100);
  assert.equal(d.slPct, 50);
  await typed('snw_tpsl', 'off');
  d = core.snipeDraft(u);
  assert.equal(d.tpPct, 0);
  assert.equal(d.slPct, 0);
  const out = await typed('snw_tpsl', '100/150');
  assert.match(out.replace(/<[^>]+>/g, ''), /TP\/SL/i);
  assert.equal(core.snipeDraft(u).slPct, 0, 'an impossible stop-loss was stored');
});

// ── "pas pilih arm malah tidak mau respon" ──────────────────────────────────
//
// The tap DID respond: `armSnipeDraft` refused (an already-armed dev, a full
// target list) and the reason was written into the panel — near the TOP of a
// twenty-line message the reader is scrolled past, because the buttons are at
// the BOTTOM and that is where they are looking. Off screen, an in-place edit
// notifies nobody: from the user's seat the button is dead. Worse, the panel's
// LAST line still read "tap ⚡ ARM SNIPE below to start watching", directly
// above the button that had just refused.

/** Drive the real callback handler and capture what Telegram was asked to do. */
async function tapped(data) {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    let b = {}; try { b = JSON.parse(opt.body); } catch (_) {}
    calls.push({ method: String(url).split('/').pop(), text: b.text || '' });
    return { json: async () => ({ ok: true, result: { message_id: 9 } }) };
  };
  try { await tg._test.onCallback({ id: 'q', data, message: { chat: { id: CHAT }, message_id: 5 } }); }
  finally { global.fetch = realFetch; }
  return calls;
}

function devDraft() {
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, {
    kind: 'dev', chain: 'robinhood', ca: CA, walletIds: '*', amount: '0.01', slipPct: 50,
  });
}

test('a REFUSED arm reaches the user where the tap was made, not only in the panel', async () => {
  user();
  devDraft();
  const first = await tapped('snw:arm');
  assert.ok(first.some((c) => c.method === 'sendMessage' && /armed/i.test(c.text)), 'the first arm did not confirm');

  // A refusal that reaches the ARM step. (An already-armed target is no longer
  // one — the arm row re-terms it, see the update tests below; and a budget
  // under one launch is refused at its own ROW by updateSnipeDraft, which is
  // the panel never displaying a setting the arm would then reject.)
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { kind: 'dev', chain: 'robinhood', ca: CA2, walletIds: '*' });
  const again = await tapped('snw:arm');
  const sent = again.find((c) => c.method === 'sendMessage');
  assert.ok(sent, 'the refusal never left the panel — off screen, the button reads as dead');
  assert.match(sent.text, /no amount/i, 'the sent message must carry the REASON, not a generic error');
  assert.match(sent.text, /nothing was spent/i, 'a refused arm must say no money moved');
  // The panel still carries it too — the row to fix stays one tap away.
  const edited = again.find((c) => c.method === 'editMessageText');
  assert.match(edited.text, /no amount/i);
});

test('a panel carrying a refusal never tells the reader to tap ARM again', async () => {
  user();
  devDraft();
  await tapped('snw:arm');          // arms it
  devDraft();
  await tapped('snw:arm');          // refused
  const refused = tg._test.snipeSetupScreen(CHAT, 'already sniping that dev on this chain').text;
  assert.ok(!/tap <b>⚡ ARM SNIPE<\/b> below to start watching/.test(refused),
    'the ready line survives beside a refusal — the reassuring line is LAST, right above the button');
  assert.match(refused, /Not armed/i, 'a refused panel must say it is not armed');
  // …and an un-refused panel still says its ready line, or this fix would have
  // deleted the line whose absence started the whole "dmn ada teks confirm??".
  user();
  devDraft();
  assert.match(tg._test.snipeSetupScreen(CHAT).text, /ARM SNIPE/);
});

test('a panel whose target is ALREADY watching says so, and its arm row says UPDATE', async () => {
  // "mengapa seperti ini" — the refusal was correct and the panel that produced
  // it was not: every row ✅, "Ready … tap ⚡ ARM SNIPE", and a live ⚡ button
  // for a dev the store already watches. Indistinguishable from a panel that
  // has never been armed, which is exactly how it gets tapped.
  user();
  devDraft();
  await tapped('snw:arm');                       // now armed
  devDraft();                                    // re-open the panel, same dev
  const s = tg._test.snipeSetupScreen(CHAT);
  assert.match(s.text, /Already watching this developer/i, 'the panel still reads as un-armed');
  assert.ok(!/tap <b>⚡ ARM SNIPE<\/b>/.test(s.text), 'it still tells the reader to arm what is armed');
  const flat = s.kb.inline_keyboard.flat();
  const arm = flat.find((b) => b.callback_data === 'snw:arm');
  assert.ok(arm, 'the arm row is gone — a re-term is exactly what this panel is for');
  assert.match(arm.text, /UPDATE|PERBARUI/, 'the button still promises to ARM what is already armed');
  assert.ok(flat.some((b) => b.callback_data === 'copy'), 'no route to the list the target is already on');
});

test('armedTargetFor is the ONE owner, and it is chain- and kind-correct', () => {
  user();
  devDraft();
  const before = core.armedTargetFor(CHAT, { kind: 'dev', chain: 'robinhood', ca: CA });
  assert.equal(before, null, 'nothing is armed yet');
  core.armSnipeDraft(CHAT);
  assert.ok(core.armedTargetFor(CHAT, { kind: 'dev', chain: 'robinhood', ca: CA }), 'the armed dev is not found');
  // A dev target is NOT a CA target — the two stores are separate, and reading
  // one for the other would render a panel that refuses to arm something
  // arm-able.
  assert.equal(core.armedTargetFor(CHAT, { kind: 'ca', chain: 'robinhood', ca: CA }), null);
  // …and not on another chain: the same address is a different target there.
  assert.equal(core.armedTargetFor(CHAT, { kind: 'dev', chain: 'solana', ca: CA }), null);
  // EVM address comparison is case-insensitive; the checksum spelling a user
  // pastes must not read as a second, un-armed target.
  assert.ok(core.armedTargetFor(CHAT, { kind: 'dev', chain: 'robinhood', ca: CA.toLowerCase() }));
});

// ── "set 0.01 eth 5 wallet tpi laporanya hanya 1 wallet" ────────────────────
//
// A NEW draft defaults its wallet row to the ACTIVE wallet, so a target armed
// before that row is touched watches with one. Changing the row afterwards and
// tapping ⚡ was refused as a duplicate — and the only route to the settings
// the user wanted was knowing they had to REMOVE the target first, which
// nothing said. ⚡ updates now.

test('⚡ on an already-watching target RE-TERMS it — the wallet selection takes effect', async () => {
  const u = user();
  // Armed the way theirs was: the default wallet row, i.e. ONE wallet.
  core.newSnipeDraft(CHAT);
  core.updateSnipeDraft(CHAT, { kind: 'dev', chain: 'robinhood', ca: CA, amount: '0.01' });
  const first = core.armSnipeDraft(CHAT);
  assert.equal(core.copyFanOut(u, first), 1, 'the default draft armed more than the active wallet');
  first.spentEth = 0.02;   // two launches already bought

  // Re-open the panel, pick All, tap ⚡.
  devDraft();              // kind dev, All wallets, 0.01
  const calls = await tapped('snw:arm');
  const stored = core.ensureUser(CHAT).copy.targets;
  assert.equal(stored.length, 1, 'a second target was armed instead of the first being updated');
  const nAll = core.walletList(u).length;
  assert.ok(nAll > 1, 'this fixture needs more than one wallet to prove a multiplier');
  assert.equal(core.copyFanOut(u, stored[0]), nAll, 'the wallet selection still does not take effect — the reported defect');
  assert.equal(stored[0].maxEth, undefined, 'a cap came back on an uncapped feature');
  // AN EDIT NEVER UN-SPENDS MONEY: a budget that reset here would let one
  // target spend its cap twice.
  assert.equal(Number(stored[0].spentEth), 0.02, 'the spend history was wiped by an edit');
  assert.ok(stored[0].bought, 'the dedup map was dropped — launches it already holds could be re-bought');
  // …and the confirmation says RE-TERMED, not "armed": the two are different
  // events to a reader whose budget is already partly spent.
  const sent = calls.find((c) => c.method === 'sendMessage');
  assert.match(sent.text, /Updated/i, 'a re-termed target was announced as freshly armed');
  assert.match(sent.text, /0\.020/, 'the confirmation hides what was already spent');
});

test('an uncapped dev watch SAYS it is uncapped, with the per-launch figure', () => {
  // The budget feature was removed outright ("hapus fitur budget jdi budget
  // fiturnya tidak ada"). What may not go with it is the reader knowing what
  // they just armed: an auto-buyer that does not say it is unbounded is the one
  // shape this panel will not ship.
  const u = user();
  devDraft();
  const txt = tg._test.snipeSetupScreen(CHAT).text;
  assert.match(txt, /No spending cap/i, 'the panel is silent about being uncapped');
  assert.match(txt, /EVERY launch/i, 'nothing says how often it buys');
  assert.match(txt, /until you turn it off/i, 'nothing says what the only stop is');
  // The per-LAUNCH figure is the multiplied one — the number actually leaving
  // the wallets on each launch, not the per-wallet slice.
  const per = 0.01 * core.walletList(u).length;
  assert.ok(txt.includes(String(per)), `the panel does not state the ${per} that leaves per launch`);
  // …and no budget row survives anywhere on the screen.
  assert.ok(!/💰/.test(txt), 'a budget line is still rendered');
});

