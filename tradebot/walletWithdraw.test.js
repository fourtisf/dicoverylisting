// Emptying a wallet, and then removing it.
//
// One report, 2026-08-21, with two screenshots. The first: "❌ this wallet still
// holds 2.15713 SOL on Solana — withdraw it (or export the key) first." on a
// user trying to delete what they thought of as an EVM wallet. The second: the
// withdrawal they were sent off to do, failing —
//
//     ❌ Simulation failed.
//     Message: Transaction simulation failed: Transaction results in an account
//     (0) with insufficient funds for rent.
//
// The two are the same defect seen from both ends: the guard told them to
// withdraw, and withdrawing did not work, so there was no sequence of taps that
// removed that wallet. These tests pin each half.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-wdraw-"));
process.env.SKIP_DOTENV = "1";
// Solana is NOT in the shipped default set, and the whole two-keypair half of
// this file only exists when it is on — which it is on the box that reported
// this. chains.js freezes ENABLED at require time, so it has to be set here.
process.env.ENABLED_CHAINS = "ethereum,base,solana";
process.env.WALLET_SECRET = process.env.WALLET_SECRET || "0123456789abcdef0123456789abcdef";

const test = require("node:test");
const assert = require("node:assert");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
const code = (f) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

let core = null;
try {
  core = require("./core");
} catch {
  /* deps not installed in this checkout */
}
let solanaMod = null;
try { solanaMod = require("./solana"); } catch { /* deps not installed */ }

// The numbers the chain actually enforces, so the arithmetic below is checked
// against Solana's rule and not against a restatement of the code's.
const RENT_MIN = 890880n;   // rent-exempt minimum for a 0-byte system account
const FEE = 5000n;          // one signature at the base fee
const SOL = 1000000000n;

// ---------------------------------------------------------------- Solana sweep

test("`max` leaves the wallet at EXACTLY zero, never in the band Solana refuses", { skip: !core }, () => {
  const bal = 2157130000n;   // the 2.15713 SOL from the report
  const p = core.solWithdrawPlan(bal, FEE, RENT_MIN, "max");
  assert.equal(p.error, undefined, p.error);
  // The whole bug in one assertion: what is left after the transfer and its fee.
  assert.equal(bal - p.lamports - FEE, 0n, "a sweep must land on the balance exactly");
  assert.equal(p.lamports, bal - FEE);
  assert.equal(p.isMax, true);
});

test("the old 10,000-lamport reserve is what the chain rejected", { skip: !core }, () => {
  // Not a test of the new code so much as a statement of why the old code could
  // never work: the reserve it kept back sat between zero and the rent floor, so
  // EVERY max withdrawal this bot has ever offered was rejected before it landed.
  const OLD_RESERVE = 10000n;
  const leftBehind = OLD_RESERVE - FEE;
  assert.ok(leftBehind > 0n && leftBehind < RENT_MIN,
    "the old sweep left a rent-paying remainder — arithmetically certain, not unlucky");
});

test("a partial amount that would leave rent dust is refused, with the two amounts that work", { skip: !core }, () => {
  const bal = 2n * SOL;
  // Leaves ~0.0001 SOL — non-zero and far below the rent floor.
  const p = core.solWithdrawPlan(bal, FEE, RENT_MIN, "1.9999");
  assert.ok(p.error, "must not be sent — the simulator would reject it");
  assert.equal(p.lamports, undefined);
  assert.match(p.error, /max/, "names the sweep");
  assert.match(p.error, /0\.00089088/, "names the floor it would break");
  assert.match(p.error, /send at most/, "names the largest amount that keeps the wallet open");
});

test("an amount that leaves a rent-exempt remainder goes straight through", { skip: !core }, () => {
  const bal = 2n * SOL;
  const p = core.solWithdrawPlan(bal, FEE, RENT_MIN, "1.5");
  assert.equal(p.error, undefined, p.error);
  assert.equal(p.lamports, 1500000000n);
  assert.ok(bal - p.lamports - FEE >= RENT_MIN);
  assert.equal(p.isMax, false);
});

test("a wallet holding less than the fee is told so, not sent", { skip: !core }, () => {
  const p = core.solWithdrawPlan(4000n, FEE, RENT_MIN, "max");
  assert.match(p.error, /below the .* network fee/);
});

test("a wallet already below the rent floor can still be swept clean", { skip: !core }, () => {
  // A rent-paying account may shrink, and to zero — so someone who was sent
  // 0.0005 SOL is not locked out of their own dust.
  const bal = 500000n;
  const p = core.solWithdrawPlan(bal, FEE, RENT_MIN, "max");
  assert.equal(p.error, undefined, p.error);
  assert.equal(bal - p.lamports - FEE, 0n);
});

test("over-balance is refused with the number that fits", { skip: !core }, () => {
  const p = core.solWithdrawPlan(1n * SOL, FEE, RENT_MIN, "1");
  assert.match(p.error, /send at most 0\.999995 SOL/);
});

test("the fee and the rent floor are READ from the chain, never assumed", { skip: !core }, () => {
  const c = code("core.js");
  assert.match(c, /solana\.rentExemptMin\(conn\)/, "the floor is a chain read");
  assert.match(c, /solana\.transferFee\(conn, kp\.publicKey, to, bal\)/, "the fee is measured for this transfer");
  assert.doesNotMatch(c, /const feeReserve = 10000n/, "the reserve that caused this is gone");
  const s = code("solana.js");
  assert.match(s, /getMinimumBalanceForRentExemption\(0\)/);
  assert.match(s, /getFeeForMessage\(tx\.compileMessage\(\)/,
    "measured against the message that gets signed, not a per-signature constant");
});

// ---------------------------------------------------------------- EVM sweep

test("the gas reserved is the gas SIGNED — one fee object, both jobs", { skip: !core }, () => {
  const c = code("core.js");
  const body = c.slice(c.indexOf("async function withdraw(chatId"), c.indexOf("async function withdrawToken"));
  // The defect: the reserve read getFeeData().gasPrice while rawSend signed
  // gasOverrides().maxFeePerGas — different numbers, and on an L2 the reserve
  // came out several times too small.
  assert.match(body, /const fee = await gasOverrides\(chainKey\)/);
  assert.match(body, /perGas = fee\.maxFeePerGas \|\| fee\.gasPrice/);
  assert.match(body, /rawSend\([^)]*\{ fee \}\)/, "the same object is handed to the signer");
  assert.doesNotMatch(body, /let gp = gas\.gasPrice/, "the old mismatched read is gone");
});

test("an OP-stack chain's L1 data fee is part of the reserve", { skip: !core }, () => {
  const c = code("core.js");
  // op-geth's balance check is value + gas×price + l1Cost. A sweep that ignores
  // the third term is short by exactly it.
  assert.match(c, /_l1DataFee\(chainKey, \{/);
  assert.match(c, /getL1Fee\(bytes\) view returns \(uint256\)/);
  assert.match(c, /0x420000000000000000000000000000000000000F/);
  // Discovered, not listed: a chain without the predeploy answers 0 after one
  // getCode, so adding a chain needs no edit here.
  assert.match(c, /getCode\(OP_GAS_ORACLE\)/);
});

test("a max EVM withdrawal keeps back the whole reserve and no more", { skip: !core }, () => {
  const gasCost = 3000000000000000n;   // 0.003 ETH
  const bal = 1000000000000000000n;    // 1 ETH
  const p = core.evmWithdrawPlan(bal, gasCost, "max", "ETH");
  assert.equal(p.error, undefined, p.error);
  assert.equal(p.value, bal - gasCost);
  assert.equal(p.isMax, true);
});

test("an EVM balance under the gas cost says so instead of 'nothing to withdraw'", { skip: !core }, () => {
  const p = core.evmWithdrawPlan(1000000000000000n, 3000000000000000n, "max", "ETH");
  assert.match(p.error, /does not cover/);
  assert.match(p.error, /ETH/);
});

test("an over-balance EVM amount names the largest that fits", { skip: !core }, () => {
  const p = core.evmWithdrawPlan(1000000000000000000n, 3000000000000000n, "1", "ETH");
  assert.match(p.error, /send at most 0\.997000 ETH/);
});

// ---------------------------------------------------------------- removal

test("removeWallet surveys every chain, and the guard reads the same survey as the screen", { skip: !core }, () => {
  const c = code("core.js");
  assert.match(c, /async function walletFunds\(chatId, walletId\)/);
  // Concurrent: the old guard was a serial for-loop, so a throttled RPC cost one
  // full timeout per chain before the screen could say anything.
  assert.match(c, /return Promise\.all\(chains\.enabledChains\(\)\.map\(async \(ch\) => \{/);
  const rm = c.slice(c.indexOf("async function removeWallet(chatId"), c.indexOf("function listWallets"));
  assert.match(rm, /const funds = await walletFunds\(chatId, walletId\)/,
    "the guard must not grow a second idea of what the wallet holds");
  assert.match(rm, /e\.holdings = holding/, "the refusal carries the survey, so the screen can act on it");
  assert.match(rm, /if \(!\(opts && opts\.force\)\)/);
});

test("`ok:false` is not a zero — an unreadable chain never blocks removal", { skip: !core }, () => {
  const c = code("core.js");
  const wf = c.slice(c.indexOf("async function walletFunds(chatId"), c.indexOf("async function removeWallet(chatId"));
  assert.match(wf, /holds: ok && bal > \(ch\.kind === 'svm'/, "we could not look ≠ it is empty");
});

test("the removal screen offers a withdraw per holding chain, and explains the pair of keys", { skip: !core }, () => {
  const tg = code("telegram.js");
  const scr = tg.slice(tg.indexOf("async function removeWalletScreen"), tg.indexOf("function unroutableCard"));
  assert.match(scr, /await core\.walletFunds\(chatId, walletId\)/);
  // The hands the old refusal did not have.
  assert.match(scr, /wdw:\$\{walletId\}:\$\{f\.chain\}/, "one withdraw button per chain that holds something");
  assert.match(scr, /two keypairs/, "the question the report actually asked");
  assert.match(scr, /Solana address/, "both addresses, because both go");
  assert.match(scr, /rmwf:/, "the informed override");
  assert.match(scr, /Couldn't read/, "an unreadable chain says so rather than rendering as zero");
});

test("a blocked removal lands back on the screen with the buttons, never on a bare ❌", { skip: !core }, () => {
  const tg = code("telegram.js");
  const h = tg.slice(tg.indexOf("if (k === 'rmwok')"));
  const body = h.slice(0, h.indexOf("\n  if (k === 'rmwf')"));
  assert.match(body, /if \(e && e\.holdings\)/);
  assert.match(body, /removeWalletScreen\(chatId, ca\)/);
});

test("removing a funded wallet hands over the keys FIRST, and only then removes", { skip: !core }, () => {
  const tg = code("telegram.js");
  const h = tg.slice(tg.indexOf("if (k === 'rmwfy')"));
  const body = h.slice(0, h.indexOf("\n  if (k === 'wdw')"));
  const keys = body.indexOf("exportKeyMsg(chatId, ca)");
  const gone = body.indexOf("core.removeWallet(chatId, ca, { force: true })");
  assert.ok(keys > -1 && gone > -1, "both steps present");
  assert.ok(keys < gone, "the other order loses the keys if the send fails");
  assert.match(body, /the wallet was <b>not<\/b> removed/, "a failed export must not be followed by a removal");
  // `send` resolves with Telegram's answer and does not throw on an error_code,
  // so a try/catch alone would have removed the wallet after silently failing to
  // deliver the only copy of its keys.
  assert.match(body, /delivered = !!\(r && r\.ok\)/);
  assert.ok(body.indexOf("if (!delivered)") < gone, "the gate is BEFORE the removal");
});

test("export hands over BOTH keys — the row is two keypairs and it is about to go", { skip: !core }, () => {
  const tg = code("telegram.js");
  const fn = tg.slice(tg.indexOf("function exportKeyMsg(chatId, walletId)"), tg.indexOf("const _monitors = new Map()"));
  assert.match(fn, /EVM private key/);
  assert.match(fn, /Solana private key/);
  // The trap: it used to export whichever half matched the ACTIVE chain and
  // print a note telling the user to switch chain and come back — advice with a
  // destructive tap waiting on the other side of it.
  assert.doesNotMatch(fn, /switch 🌐 to/, "a note is not a safeguard before a delete");
  assert.doesNotMatch(fn, /if \(core\.chains\.isSvm\(ck\)\)/, "no longer branches on the active chain");
  assert.match(fn, /nothing was exported/, "a failed read must not pass for 'this wallet had one key'");
});

// ---------------------------------------------------------------- per-wallet withdraw

test("a withdrawal spends the wallet and chain it was OPENED on, not the active ones", { skip: !core }, () => {
  const tg = code("telegram.js");
  // Each step carries them forward. Re-deriving the chain at every step is how a
  // Solana withdrawal opened from an EVM screen bounced as an invalid address.
  assert.match(tg, /if \(p\.action === 'wd_addr'\) \{ const wch = \(p\.chain && core\.chains\.isEnabled\(p\.chain\) && core\.chainOf\(p\.chain\)\) \|\| activeChain\(chatId\)/);
  assert.match(tg, /setPending\(chatId, \{ action: 'wd_amt', to: t, chain: wch\.key, walletId: p\.walletId \}\)/);
  assert.match(tg, /setPending\(chatId, \{ action: 'wd_confirm', to: p\.to, amt: t, chain: ch\.key, walletId: p\.walletId \}\)/);
  assert.match(tg, /core\.withdraw\(chatId, pp\.to, pp\.amt, pp\.chain, pp\.walletId\)/,
    "the confirmed wallet is the wallet spent");
});

test("every withdrawal is bound to a chain — named by the button, or asked for", { skip: !core }, () => {
  const tg = code("telegram.js");
  // Two shapes, and between them there is no third: a button that already knows
  // the wallet AND the chain (the deposit and removal screens) skips both
  // pickers; everything else ASKS. What must not exist again is an entry that
  // silently borrows whatever chain happens to be active.
  assert.match(tg, /if \(k === 'wdw'\)/, "per-wallet, per-chain entry");
  assert.match(tg, /btn\(`📤 Withdraw \$\{ch\.native\}`\.slice\(0, 24\), `wdw:\$\{w\.id\}:\$\{ch\.key\}`\)/,
    "the per-wallet screen: emptying wallet 9 used to mean switching to it first");
  assert.match(tg, /if \(data === 'wd' \|\| data === 'wdall'\) \{ const sc = wdSweepChainScreen\(chatId\)/);
  assert.match(tg, /if \(text === '\/withdraw' \|\| text === '\/withdrawall'\)/);
});

test("a swept wallet's receipt says it is empty — that is the errand, not a footnote", { skip: !core }, () => {
  const c = code("core.js");
  assert.match(c, /swept: plan\.isMax/, "both chains report it");
  assert.equal((c.match(/swept: plan\.isMax/g) || []).length, 2);
  const tg = code("telegram.js");
  assert.match(tg, /r\.swept \?/);
});

test("the confirm screen names the wallet whenever there is more than one", { skip: !core }, () => {
  const tg = code("telegram.js");
  assert.match(tg, /function wdWalletLine\(chatId, walletId\)/);
  assert.match(tg, /if \(list\.length < 2\) return ''/, "noise on a single-wallet account");
  const h = tg.slice(tg.indexOf("if (p.action === 'wd_amt')"));
  assert.match(h.slice(0, 900), /wdWalletLine\(chatId, p\.walletId\)/);
});

test("'max' is described as emptying the wallet, because that is now what it does", { skip: !core }, () => {
  const tg = code("telegram.js");
  // The old prompt promised "a little is kept back for network fees" — which was
  // both untrue of the new sweep and the exact thing that used to break it.
  assert.doesNotMatch(tg, /a little is kept back for network fees/);
  assert.match(tg, /to empty the wallet \(the network fee comes out of it\)/);
});

// ---------------------------------------------------------------- driven

// A source scan sees the calls and reads as fine; these run the renderers. Two
// wallets, because removal keeps the last one.
let tg = null;
try { tg = require("./telegram"); } catch { /* deps not installed */ }

const CHAT = "770001";
function twoWallets() {
  core.ensureUser(CHAT);
  const u = core.getUser(CHAT);
  if (u.wallets.length < 2) core.addWallet(CHAT);
  return u.wallets[1].id;
}
// The survey the screen reads. Stubbed rather than measured: what is under test
// is what the screen DOES with a holding, not whether an RPC answers.
function stubFunds(rows) {
  const real = core.walletFunds;
  core.walletFunds = async () => rows;
  return () => { core.walletFunds = real; };
}
const SOL_HELD = (addr) => ({ chain: "solana", name: "Solana", emoji: "🟣", native: "SOL", svm: true, address: addr, ok: true, bal: 2157130000n, holds: true, human: "2.15713" });
const ETH_CLEAN = (addr) => ({ chain: "ethereum", name: "Ethereum", emoji: "🔷", native: "ETH", svm: false, address: addr, ok: true, bal: 0n, holds: false, human: "0.00000" });
const BASE_UNREAD = (addr) => ({ chain: "base", name: "Base", emoji: "🔵", native: "ETH", svm: false, address: addr, ok: false, bal: 0n, holds: false, human: "0.00000" });

test("DRIVEN: the blocked screen answers the question the old refusal provoked", { skip: !core || !tg }, async () => {
  const wid = twoWallets();
  const u = core.getUser(CHAT);
  const evm = u.wallets[1].address;
  const sol = core.walletAddress(u.wallets[1], "solana");
  const undo = stubFunds([ETH_CLEAN(evm), BASE_UNREAD(evm), SOL_HELD(sol)]);
  try {
    const s = await tg._test.removeWalletScreen(CHAT, wid);
    // Both addresses, because both keys go.
    assert.ok(s.text.includes(evm), "the EVM address");
    assert.ok(s.text.includes(sol), "the Solana address");
    assert.match(s.text, /2\.15713 SOL/, "the amount that is blocking it");
    assert.match(s.text, /two keypairs/);
    assert.match(s.text, /Couldn't read Ethereum|Couldn't read Base/, "the unread chain is named");
    const flat = s.kb.inline_keyboard.flat();
    // The hands. One button per chain that holds something, and none for the
    // chains that do not.
    const wd = flat.filter((b) => String(b.callback_data).startsWith("wdw:"));
    assert.equal(wd.length, 1);
    assert.equal(wd[0].callback_data, `wdw:${wid}:solana`);
    assert.match(wd[0].text, /SOL/);
    assert.ok(flat.some((b) => b.callback_data === "rmwf:" + wid), "the informed override");
    assert.ok(!flat.some((b) => b.callback_data === "rmwok:" + wid), "no one-tap remove while it holds money");
    assert.ok(flat.some((b) => b.callback_data === "expw:" + wid));
  } finally { undo(); }
});

test("DRIVEN: an empty wallet gets the one-tap remove back", { skip: !core || !tg }, async () => {
  const wid = twoWallets();
  const evm = core.getUser(CHAT).wallets[1].address;
  const undo = stubFunds([ETH_CLEAN(evm), { ...SOL_HELD(evm), bal: 0n, holds: false, human: "0.00000" }]);
  try {
    const s = await tg._test.removeWalletScreen(CHAT, wid);
    const flat = s.kb.inline_keyboard.flat();
    assert.ok(flat.some((b) => b.callback_data === "rmwok:" + wid));
    assert.ok(!flat.some((b) => String(b.callback_data).startsWith("wdw:")), "nothing to withdraw, no button");
    assert.ok(!flat.some((b) => b.callback_data === "rmwf:" + wid), "no override where there is nothing to override");
    assert.match(s.text, /empty of native/);
  } finally { undo(); }
});

test("DRIVEN: export hands over both keys, and they are the wallet's own", { skip: !core || !tg }, () => {
  const wid = twoWallets();
  const u = core.getUser(CHAT);
  const out = tg._test.exportKeyMsg(CHAT, wid);
  assert.ok(out.includes(u.wallets[1].address), "the EVM address");
  assert.ok(out.includes(core.walletAddress(u.wallets[1], "solana")), "the Solana address");
  assert.ok(out.includes(core.exportKey(CHAT, wid)), "the EVM key");
  assert.ok(out.includes(core.exportKey(CHAT, wid, "solana")), "the Solana key");
  // The closing line depends on whether the wallet has a phrase, but either way
  // it has to say the two keys are ONE wallet — that is the misreading the
  // original report was built on.
  const phrase = core.exportMnemonic(CHAT, wid);
  assert.match(out, phrase ? /the same wallet, one side each/ : /save both/);
  if (phrase) assert.ok(out.includes(phrase), "and the phrase leads");
});

test("DRIVEN: the withdraw flow carries the wallet and chain it was opened on", { skip: !core || !tg }, async () => {
  const wid = twoWallets();
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    try { const b = JSON.parse(opt.body); if (/sendMessage/.test(String(url))) sent.push(b.text); } catch (_) {}
    return { json: async () => ({ ok: true, result: { message_id: sent.length + 1 } }) };
  };
  const realWd = core.withdraw;
  let spent = null;
  core.withdraw = async (cid, to, amt, chain, walletId) => { spent = { to, amt, chain, walletId }; return { hash: "sig", sentEth: 2.157125, native: "SOL", swept: true }; };
  try {
    // Step 1 opened on a NAMED wallet + Solana, while the ACTIVE chain is not
    // Solana — the case that used to bounce as "not a valid address".
    core.setChain(CHAT, "ethereum");
    const DEST = "E9MRKqAUH5RA4dqFUkcW3Hair1GxeWtUVQzdXgWw1RPV";
    await tg._test.resolvePending(CHAT, { action: "wd_addr", chain: "solana", walletId: wid }, DEST, null);
    await tg._test.resolvePending(CHAT, { action: "wd_amt", chain: "solana", walletId: wid, to: DEST }, "max", null);
    const confirm = sent[sent.length - 1];
    assert.match(confirm, /Solana/, "confirmed against the chain it was opened on, not the active one");
    assert.match(confirm, /every SOL in this wallet/, "'max' is described as what it does");
    assert.match(confirm, /Wallet 2/, "and names which wallet it will empty");
    // A Solana sweep lands on zero, and a wallet at zero cannot pay the fee to
    // move an SPL bag — said before the tap, not discovered after it.
    assert.match(confirm, /can't pay the fee to move them/);
    // …and the confirmation actually spends that wallet on that chain.
    await tg._test.onCallback({ id: "1", data: "wdok", message: { message_id: 1, chat: { id: CHAT } }, from: { id: CHAT } });
    assert.deepEqual(spent, { to: DEST, amt: "max", chain: "solana", walletId: wid });
    assert.match(sent[sent.length - 1], /balance is now zero/, "a sweep says the wallet is empty — that is the errand");
  } finally { core.withdraw = realWd; global.fetch = realFetch; }
});


// ---------------------------------------------------------------- audit round

test("the fee is measured against the message sendSol actually builds", { skip: !core }, () => {
  // The sweep lands on the balance EXACTLY, so the measured fee and the signed
  // fee have to be the fee of the SAME message. They are today because both
  // build a bare SystemProgram.transfer — add a compute-budget/priority-fee
  // instruction to one and not the other and `max` silently goes back to
  // leaving a rent-paying remainder, which is the original bug.
  const s = code("solana.js");
  const fn = s.slice(s.indexOf("async function sendSol("), s.indexOf("async function sendSplToken("));
  const adds = fn.match(/\.add\(/g) || [];
  assert.equal(adds.length, 1, "sendSol must build exactly one instruction");
  assert.match(fn, /new Transaction\(\)\.add\(SystemProgram\.transfer\(/);
  assert.doesNotMatch(fn, /ComputeBudgetProgram/,
    "a priority fee here has to be priced in transferFee too — see solWithdrawPlan");
  const probe = s.slice(s.indexOf("async function transferFee("), s.indexOf("async function sendSol("));
  assert.match(probe, /new Transaction\(\)\.add\(SystemProgram\.transfer\(/, "same shape, or the price is of a different message");
});

test("a failed getCode is NOT cached as 'this chain has no L1 fee'", { skip: !core }, () => {
  const c = code("core.js");
  const fn = c.slice(c.indexOf("async function _l1DataFee("), c.indexOf("async function v3SwapGas("));
  // The bug: `.catch(() => '0x')` makes a transient RPC failure indistinguishable
  // from a chain without the predeploy, and then caches it — so one blip
  // disables L1 accounting on Base for the life of the process, silently, on the
  // path where being short by the L1 fee means the withdrawal does not send.
  assert.doesNotMatch(fn, /getCode\(OP_GAS_ORACLE\)\.catch/);
  assert.match(fn, /catch \(_\) \{ return \{ fee: 0n, ok: false, oracle: null \}; \}/);
  // Only a read that ANSWERED is cached.
  const cacheAt = fn.indexOf("_hasL1Oracle.set(chainKey, has)");
  const readAt = fn.indexOf("code = await prov.getCode");
  assert.ok(readAt > -1 && cacheAt > readAt);
  // …and a failed read reserves the conservative stand-in, never zero.
  assert.match(c, /const l1Cost = l1\.ok \? l1\.fee : l2Cost;/);
});

test("a survey that did not happen is not an empty wallet", { skip: !core || !tg }, async () => {
  const wid = twoWallets();
  const real = core.walletFunds;
  core.walletFunds = async () => { throw new Error("every RPC is down"); };
  try {
    const s = await tg._test.removeWalletScreen(CHAT, wid);
    assert.match(s.text, /couldn't check any chain's balance/);
    assert.doesNotMatch(s.text, /looks <b>empty of native<\/b>/,
      "an unread wallet must never render as an empty one");
    const flat = s.kb.inline_keyboard.flat();
    assert.ok(!flat.some((b) => b.callback_data === "rmwok:" + wid),
      "no one-tap remove on a balance nobody read");
    assert.ok(flat.some((b) => b.callback_data === "rmwf:" + wid), "the informed path stays open");
    assert.ok(flat.some((b) => /without checking/.test(b.text)));
  } finally { core.walletFunds = real; }
});

test("…and the override still works when the survey is down (no bounce loop)", { skip: !core || !tg }, async () => {
  // The screen's only forward button is `rmwf`, and `rmwf` used to send anything
  // with no holdings back to the screen — so an unreadable wallet bounced
  // between the two for ever and could never be removed.
  const wid = twoWallets();
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    try { const b = JSON.parse(opt.body); if (/sendMessage|editMessageText/.test(String(url))) sent.push({ text: b.text, kb: b.reply_markup }); } catch (_) {}
    return { json: async () => ({ ok: true, result: { message_id: sent.length + 1 } }) };
  };
  const real = core.walletFunds;
  core.walletFunds = async () => { throw new Error("every RPC is down"); };
  try {
    await tg._test.onCallback({ id: "1", data: "rmwf:" + wid, message: { message_id: 5, chat: { id: CHAT } }, from: { id: CHAT } });
    const last = sent[sent.length - 1];
    assert.match(last.text, /without checking it/, "it reaches the confirmation, not the screen it came from");
    const flat = last.kb.inline_keyboard.flat();
    assert.ok(flat.some((b) => b.callback_data === "rmwfy:" + wid), "and offers the tap that actually removes");
  } finally { core.walletFunds = real; global.fetch = realFetch; }
});

test("a surveyed-and-empty wallet still goes back for the one-tap remove", { skip: !core || !tg }, async () => {
  const wid = twoWallets();
  const evm = core.getUser(CHAT).wallets[1].address;
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    try { const b = JSON.parse(opt.body); if (/sendMessage|editMessageText/.test(String(url))) sent.push({ text: b.text, kb: b.reply_markup }); } catch (_) {}
    return { json: async () => ({ ok: true, result: { message_id: sent.length + 1 } }) };
  };
  const undo = stubFunds([ETH_CLEAN(evm)]);
  try {
    await tg._test.onCallback({ id: "1", data: "rmwf:" + wid, message: { message_id: 5, chat: { id: CHAT } }, from: { id: CHAT } });
    const flat = sent[sent.length - 1].kb.inline_keyboard.flat();
    assert.ok(flat.some((b) => b.callback_data === "rmwok:" + wid));
  } finally { undo(); global.fetch = realFetch; }
});

test("a wallet is not removed when Telegram refuses the keys message", { skip: !core || !tg }, async () => {
  const wid = twoWallets();
  const before = core.walletList(core.getUser(CHAT)).length;
  const sent = [];
  const realFetch = global.fetch;
  // `send` RESOLVES with Telegram's answer on an error_code — it does not throw.
  // A try/catch alone would have removed a funded wallet after silently failing
  // to deliver the only copy of its keys.
  global.fetch = async (url, opt) => {
    try { const b = JSON.parse(opt.body); if (/sendMessage/.test(String(url))) sent.push(b.text); } catch (_) {}
    if (/sendMessage/.test(String(url)) && sent.length === 1) return { json: async () => ({ ok: false, error_code: 400, description: "can't parse entities" }) };
    return { json: async () => ({ ok: true, result: { message_id: sent.length + 1 } }) };
  };
  try {
    await tg._test.onCallback({ id: "1", data: "rmwfy:" + wid, message: { message_id: 5, chat: { id: CHAT } }, from: { id: CHAT } });
    assert.equal(core.walletList(core.getUser(CHAT)).length, before, "the wallet survives a failed key delivery");
    const errs = sent.filter((t) => t.startsWith("❌"));
    assert.equal(errs.length, 1, "one ❌, not a generic one stacked on a specific one");
    // Escaped, because it is Telegram's text going back into an HTML message.
    assert.match(errs[0], /parse entities/, "and it carries the reason");
    assert.match(errs[0], /was <b>not<\/b> removed/);
  } finally { global.fetch = realFetch; }
});

test("a disabled chain is not reachable from a callback", { skip: !core }, () => {
  const tg = code("telegram.js");
  // chainOf answers from the WHOLE table, so it alone would let a stale button
  // open a withdrawal on a chain the operator turned off.
  assert.match(tg, /const wch = \(core\.chains\.isEnabled\(arg\) && core\.chainOf\(arg\)\) \|\| activeChain\(chatId\)/);
  assert.match(tg, /p\.chain && core\.chains\.isEnabled\(p\.chain\) && core\.chainOf\(p\.chain\)/);
  assert.equal((tg.match(/core\.chains\.isEnabled\(p\.chain\)/g) || []).length, 2, "both pending steps");
});

test("one unaddressable chain does not take the whole survey down", { skip: !core }, async () => {
  // Promise.all rejects on the first throw, and resolving a Solana address
  // derives a keypair — so a wallet that could not be derived used to turn a
  // per-chain `ok:false` into an exception out of walletFunds.
  const c = code("core.js");
  const wf = c.slice(c.indexOf("async function walletFunds(chatId"), c.indexOf("async function removeWallet(chatId"));
  assert.match(wf, /catch \(_\) \{ return row\(ch, '', false, 0n\); \}/);
  // Driven: a wallet with no key material at all still surveys, as unread rows.
  const CH2 = "770002";
  core.ensureUser(CH2);
  const u = core.getUser(CH2);
  u.wallets.push({ id: "broken", name: "", address: "0x" + "ab".repeat(20), positions: {}, orders: [] });   // no enc
  const funds = await core.walletFunds(CH2, "broken");
  assert.ok(funds.length > 0, "it answers rather than throwing");
  const sol = funds.find((f) => f.svm);
  assert.equal(sol.ok, false, "the chain it could not address is unread, not empty");
  assert.equal(sol.holds, false);
});

// ---------------------------------------------------------------- seed phrase
//
// "kalo gitu kirimnya harus seed pharse bukan hanya privatekey" (2026-08-21).
// Right, and it named a real gap: every wallet this bot generates is born from a
// mnemonic — it is what derives the Solana key on Phantom's own path — and the
// phrase was computed, used, and thrown away. Two keys went out for a wallet
// that had one phrase behind it, and a private key cannot be run backwards into
// the mnemonic it came from.

const bip39 = (() => { try { return require("bip39"); } catch { return null; } })();
const edhd = (() => { try { return require("ed25519-hd-key"); } catch { return null; } })();
const web3 = (() => { try { return require("@solana/web3.js"); } catch { return null; } })();
const ethersLib = (() => { try { return require("ethers"); } catch { return null; } })();

const SEED_CHAT = "770003";
function freshUser(id) { core.ensureUser(id); return core.getUser(id); }

test("a generated wallet keeps its phrase, and it is THE phrase Phantom would use", { skip: !core || !bip39 || !edhd || !web3 }, () => {
  const u = freshUser(SEED_CHAT);
  const w = u.wallets[0];
  const phrase = core.exportMnemonic(SEED_CHAT, w.id);
  assert.ok(phrase && phrase.split(/\s+/).length >= 12, "a generated wallet has a phrase now");
  assert.ok(bip39.validateMnemonic(phrase), "and it is a valid BIP39 mnemonic");
  // The claim on the export screen is "restores this whole wallet, both sides,
  // in one import". Proven against the real derivations rather than asserted:
  // Phantom's m/44'/501'/0'/0' and MetaMask's BIP44 account 0.
  const seed = bip39.mnemonicToSeedSync(phrase);
  const { key } = edhd.derivePath("m/44'/501'/0'/0'", seed.toString("hex"));
  assert.equal(web3.Keypair.fromSeed(Uint8Array.from(key)).publicKey.toBase58(),
    core.walletAddress(w, "solana"), "Phantom lands on the bot's Solana address");
  if (ethersLib) assert.equal(ethersLib.Wallet.fromPhrase(phrase).address, w.address, "and MetaMask on its EVM one");
});

test("an imported phrase round-trips exactly", { skip: !core }, () => {
  const P = "legal winner thank year wave sausage worth useful legal winner thank yellow";
  const nw = core.addWallet(SEED_CHAT, P);
  assert.equal(core.exportMnemonic(SEED_CHAT, nw.id), P, "byte-for-byte what was pasted");
});

test("a wallet with no phrase answers null — never a guess, never an error", { skip: !core || !ethersLib }, () => {
  // Two ways to have none, and both are ordinary: imported from a bare private
  // key (never had one), or created before the bot kept them.
  const bare = core.addWallet(SEED_CHAT, ethersLib.Wallet.createRandom().privateKey);
  assert.equal(core.exportMnemonic(SEED_CHAT, bare.id), null);
  const u = core.getUser(SEED_CHAT);
  const legacy = { ...JSON.parse(JSON.stringify(u.wallets[0])), id: "legacyw" };
  delete legacy.mnemEnc;
  u.wallets.push(legacy);
  assert.equal(core.exportMnemonic(SEED_CHAT, "legacyw"), null, "a legacy record must not throw");
});

test("the export leads with the phrase, and SAYS SO when there isn't one", { skip: !core || !tg || !ethersLib }, () => {
  const u = core.getUser(SEED_CHAT);
  const withPhrase = tg._test.exportKeyMsg(SEED_CHAT, u.wallets[0].id);
  assert.match(withPhrase, /Seed phrase/);
  assert.ok(withPhrase.includes(core.exportMnemonic(SEED_CHAT, u.wallets[0].id)), "the real phrase is in it");
  assert.match(withPhrase, /more powerful than the keys below/, "the phrase is the bigger secret and is labelled as one");
  // …and the two keys are still there: not every app takes a phrase.
  assert.match(withPhrase, /EVM private key/);
  assert.match(withPhrase, /Solana private key/);
  // The absence is STATED. A blank there reads as a bot that forgot to print it,
  // and sends people hunting for a phrase that does not exist.
  const none = tg._test.exportKeyMsg(SEED_CHAT, "legacyw");
  assert.doesNotMatch(none, /Seed phrase/);
  assert.match(none, /no seed phrase/);
  assert.match(none, /Two imports, one per side/);
});

test("removing a wallet archives the phrase with the keys", { skip: !core }, () => {
  // Archiving the keys but dropping the phrase would make "export before you
  // delete" quietly hand back less than the wallet had.
  const c = code("core.js");
  assert.match(c, /u\.oldWallets\.push\(\{ address: w\.address, enc: w\.enc, solAddress: w\.solAddress, solEnc: w\.solEnc, mnemEnc: w\.mnemEnc, at: Date\.now\(\) \}\)/);
});

test("both export confirmations name the phrase before showing it", { skip: !core }, () => {
  const t = code("telegram.js");
  assert.equal((t.match(/seed phrase<\/b> \(if it has one\)/g) || []).length, 2,
    "the per-wallet screen and the active-wallet screen");
  assert.match(t, /the phrase gives away all of it at once/);
});

// ---------------------------------------------------------------- multi-wallet sweep
//
// "harus ada command withdraw di sini dan bisa withdraw semua wallet tapi
// dipilih dulu chainnya apa" (2026-08-21). 📤 Withdraw (active) only ever spent
// the active wallet on the active chain, so emptying ten wallets was twenty
// screen switches.

test("the sweep asks WHICH CHAIN first", { skip: !core || !tg }, () => {
  const s = tg._test.wdSweepChainScreen(CHAT);
  const flat = s.kb.inline_keyboard.flat();
  // A flow bound to whatever chain happens to be active is the wrong-chain dead
  // end the snipe panel had to be rescued from.
  for (const c of core.chains.enabledChains()) {
    assert.ok(flat.some((b) => b.callback_data === "wdac:" + c.key), "a button for " + c.key);
  }
  assert.match(s.text, /Which chain\?/);
});

test("the picker defaults to EVERY wallet — 'all wallets' is the ask", { skip: !core || !tg }, async () => {
  const u = core.ensureUser(CHAT);
  const ids = core.walletList(u).map((w) => w.id);
  const s = await tg._test.wdSweepPickScreen(CHAT, { chain: "solana", ids });
  const flat = s.kb.inline_keyboard.flat();
  assert.equal(flat.filter((b) => b.text.startsWith("✅ Wallet")).length, ids.length, "all ticked");
  assert.ok(flat.some((b) => b.callback_data === "wdaA"), "select all");
  assert.ok(flat.some((b) => b.callback_data === "wdaN"), "clear");
  assert.ok(flat.some((b) => b.callback_data === "wdaGo"));
});

test("the sweep selection NEVER touches the trade selection", { skip: !core }, () => {
  const t = code("telegram.js");
  const h = t.slice(t.indexOf("if (k === 'wdat' || data === 'wdaA'"), t.indexOf("if (data === 'wdaGo')"));
  // core.tradeSelection is persisted and drives which wallets every future Buy
  // and Sell act on. A withdraw picker writing to it would silently re-aim the
  // user's trading as a side effect of emptying a wallet.
  assert.doesNotMatch(h, /toggleTradeWallet|setTradeAll|tradeSelection/);
  assert.match(h, /pp\.ids = \[\.\.\.ids\]; setPending\(chatId, pp\)/, "the selection lives in the pending step");
  // Concurrent taps redraw one message; last tap must win.
  assert.match(h, /const isLatest = redrawTicket\(chatId, mid\)/);
  assert.match(h, /if \(!isLatest\(\)\) return;/);
});

test("the confirmation does the per-wallet arithmetic out loud", { skip: !core || !tg }, async () => {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    try { const b = JSON.parse(opt.body); if (/sendMessage/.test(String(url))) sent.push(b.text); } catch (_) {}
    return { json: async () => ({ ok: true, result: { message_id: sent.length + 1 } }) };
  };
  try {
    const DEST = "E9MRKqAUH5RA4dqFUkcW3Hair1GxeWtUVQzdXgWw1RPV";
    await tg._test.resolvePending(CHAT, { action: "wd_sweep_amt", chain: "solana", ids: ["a", "b", "c"], to: DEST }, "0.1", null);
    const t = sent[sent.length - 1];
    // "0.1" across three wallets is 0.3, and a user who read it as a total finds
    // out afterwards — irreversibly.
    assert.match(t, /from EACH/);
    assert.match(t, /0\.3 SOL<\/b> in total/);
    sent.length = 0;
    await tg._test.resolvePending(CHAT, { action: "wd_sweep_amt", chain: "solana", ids: ["a", "b"], to: DEST }, "max", null);
    const m = sent[sent.length - 1];
    assert.match(m, /every SOL in <b>all 2 wallets<\/b>/);
    assert.match(m, /can't pay the fee to move them/, "a Solana sweep lands on zero");
  } finally { global.fetch = realFetch; }
});

test("a sweep is ONE withdrawal against the rate limit, not N", { skip: !core }, () => {
  const c = code("core.js");
  const fn = c.slice(c.indexOf("async function withdrawMany("), c.indexOf("async function withdrawToken("));
  // MAX_WD_PER_HOUR defaults to 10 and a full account is 10 wallets, so charging
  // per wallet would let one sweep spend the whole hour and stop halfway with
  // "rate limit reached" — funds out of some wallets and not others, from one
  // confirmation. A half-done irreversible action is worse than a refused one.
  assert.equal((fn.match(/_guardWithdraw\(/g) || []).length, 1);
  assert.equal((fn.match(/_noteWithdraw\(/g) || []).length, 1);
  // …and the per-wallet calls must therefore NOT re-guard.
  assert.match(fn, /withdraw\(chatId, dest, amount, chainKey, id, false\)/);
  // The destination is validated before anything moves.
  assert.ok(fn.indexOf("invalid destination address") < fn.indexOf("_guardWithdraw("));
});

test("an empty wallet in a sweep is ⚪️, never ❌", { skip: !core || !tg }, () => {
  const rows = [
    { walletId: "a", index: 1, label: "Wallet 1", ok: true, sentEth: 2.157125, native: "SOL", hash: "sig" },
    { walletId: "b", index: 2, label: "Wallet 2", ok: false, empty: true, error: "this wallet has no SOL to withdraw" },
    { walletId: "c", index: 3, label: "Wallet 3", ok: false, empty: false, error: "node rejected the transaction" },
  ];
  const t = tg._test.wdSweepResultText(CHAT, "solana", "E9MRKqAUH5RA4dqFUkcW3Hair1GxeWtUVQzdXgWw1RPV", rows);
  assert.match(t, /🟢 <b>Wallet 1<\/b>/);
  // Asked to sweep an empty wallet, doing nothing is the right answer — a red
  // cross there sends the reader hunting for a fault that is not present.
  assert.match(t, /⚪️ <b>Wallet 2<\/b> — nothing to send/);
  assert.match(t, /❌ <b>Wallet 3<\/b> — node rejected/);
  assert.match(t, /Sent 2\.157125 SOL<\/b> from 1\/3 wallets · 1 empty · 1 failed/);
});

test("a whole-sweep refusal says nothing was sent", { skip: !core }, () => {
  const t = code("telegram.js");
  const h = t.slice(t.indexOf("if (data === 'wdaok')"));
  const body = h.slice(0, h.indexOf("\n  if (data === 'wdok')"));
  assert.match(body, /Nothing was sent/, "a locked vault or a bad address moved no money and must say so");
  assert.match(body, /core\.withdrawMany\(chatId, pp\.to, pp\.amt, pp\.chain, pp\.ids\)/);
});

test("an unreadable SOLANA balance is not a zero — on any screen", { skip: !core }, () => {
  // solBalance answers 0n for a dead RPC, a 429 and an empty wallet alike. The
  // removal guard is where it mattered: an unreadable Solana balance rendered as
  // "empty of native on every chain I could read", under a one-tap ✅ Remove, on
  // a wallet holding 2.15 SOL. _balanceResilient could only ever catch the 6s
  // TIMEOUT there — a node that answered with an error came back ok:true, 0.
  assert.equal(typeof solanaMod.solBalanceOrNull, "function");
  const c = code("core.js");
  const fn = c.slice(c.indexOf("async function _balanceResilient("), c.indexOf("async function walletFunds("));
  // ⚠️ ASSERT THE RULE, NOT THE SPELLING. This used to pin the literal
  // `solana.solBalanceOrNull(providerFor(chainKey), addr)`, so it went RED the
  // day both reads moved behind core.nativeBalances — code that keeps this
  // rule on MORE screens — and would have passed on a reader that answered 0n.
  // The rule is: the survey must not use the SWALLOWING read, and a null must
  // mean retry-then-report rather than "empty".
  assert.match(fn, /nativeBalances\(chainKey, \[addr\]\)/, 'through the one owner, where the host list and the 429 retry-off live');
  assert.match(fn, /if \(bal == null\) continue;/);
  assert.doesNotMatch(fn, /solana\.solBalance\(/, "the swallowing read is gone from the survey");
  // …and the screens read it through CORE, not by reaching into the solana
  // module: every other chain read on that screen goes through core, and going
  // around it is how a stubbed render test ends up bypassing its own stub.
  assert.match(c, /async function ethBalanceOrNull\(addr, chainKey\)/);
  const eb = c.slice(c.indexOf('async function ethBalanceOrNull(addr, chainKey)'));
  const ebFn = eb.slice(0, eb.indexOf('\n}') + 2);
  assert.match(ebFn, /nativeBalances\(chainKey, \[addr\]\)/, 'one door onto the chain, not a private read per screen');
  assert.doesNotMatch(ebFn, /solana\.solBalance\(/, 'never the read that answers 0n for a dead RPC');
  const t = code("telegram.js");
  const rnStart = t.indexOf("const readNative = async (w, c) =>");
  const rn = t.slice(rnStart, t.indexOf("\n};", rnStart));   // the function ONLY — tg() below legitimately uses solana.netErr
  assert.match(rn, /core\.ethBalanceOrNull\(wAddr\(w, c\.key\), c\.key\)/);
  assert.match(rn, /throw new Error\('balance unreadable'\)/, "so the picker renders ? rather than 0");
  assert.doesNotMatch(rn, /solana\./, "no layering break");
});

test("a total of balances nobody read is not 0", { skip: !core || !tg }, async () => {
  // The `?` beside each wallet exists so an unread balance is not shown as
  // empty. Summing those same unread balances into "holding 0 SOL" one line
  // above would put the lie back, in bold.
  const u = core.ensureUser(CHAT);
  const ids = core.walletList(u).map((w) => w.id);
  const s = await tg._test.wdSweepPickScreen(CHAT, { chain: "solana", ids });
  assert.match(s.text, /\? SOL|balances couldn't be read/);
  assert.doesNotMatch(s.text, /holding <b>0 SOL<\/b>/);
});

// ---------------------------------------------------------------- command case
//
// "/WITHDRAW" → "🤔 I didn't recognise that." Every command in this file is
// matched with === against a lowercase literal, Telegram does not lowercase what
// the user typed, and a phone keyboard capitalises the first letter — so all 33
// of them were one shift key away from not existing.

test("a command is recognised whatever its case, and with the bot suffix", { skip: !core || !tg }, () => {
  const n = tg._test.normalizeCommand;
  for (const v of ["/WITHDRAW", "/Withdraw", "/withdraw", "/withdraw@DexvraTradeBot", "/WITHDRAW@DexvraTradeBot"]) {
    assert.equal(n(v), "/withdraw", v);
  }
  // In a group Telegram appends the bot's own username; that failed identically.
  assert.equal(n("/start@SomeBot ref_ABC"), "/start ref_ABC");
});

test("…and NOTHING but the first word is touched", { skip: !core || !tg }, () => {
  const n = tg._test.normalizeCommand;
  // ⚠️ Lowercasing the whole message would be a far worse bug than the one being
  // fixed: this same string is what a contract address is pasted into, and a
  // base58 Solana mint and a checksummed EVM address are both case-SENSITIVE.
  const mint = "Ge87EtsjKpMbXyzABCdefGH";
  const evm = "0xC29041CFa0788B63F367A02105A46b7c6627FA47";
  assert.equal(n(mint), mint, "a pasted mint is not a command");
  assert.equal(n(evm), evm, "nor a pasted EVM address");
  assert.equal(n(`/start ca_solana_${mint}`), `/start ca_solana_${mint}`, "a deep-link payload survives verbatim");
  assert.equal(n(`/START ca_solana_${mint}`), `/start ca_solana_${mint}`);
  assert.equal(n(`/send ${mint} ${evm} max`), `/send ${mint} ${evm} max`, "arguments untouched");
  assert.equal(n(`/pnl ${evm}`), `/pnl ${evm}`);
});

test("DRIVEN: /WITHDRAW reaches the withdraw flow, not the fallback", { skip: !core || !tg }, async () => {
  const CHATC = "770004";
  core.ensureUser(CHATC);
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    try { const b = JSON.parse(opt.body); if (/sendMessage/.test(String(url))) sent.push(b.text); } catch (_) {}
    return { json: async () => ({ ok: true, result: { message_id: sent.length + 1 } }) };
  };
  try {
    for (const cmd of ["/WITHDRAW", "/Withdraw", "/withdraw@DexvraTradeBot"]) {
      sent.length = 0;
      await tg._test.onMessage({ message_id: 1, chat: { id: CHATC }, from: { id: CHATC }, text: cmd });
      assert.ok(sent.length, cmd + " produced no reply");
      assert.match(sent[0], /Withdraw/, cmd);
      assert.doesNotMatch(sent[0], /didn't recognise/, cmd + " fell through to the fallback");
    }
  } finally { global.fetch = realFetch; }
});

test("the normalisation happens ONCE, at the entry point", { skip: !core }, () => {
  const t = code("telegram.js");
  // 33 commands matched by ===; a fix applied per-command is one the 34th
  // forgets. It has to be the single read of the message.
  assert.match(t, /const text = normalizeCommand\(\(m\.text \|\| ''\)\.trim\(\)\);/);
  assert.equal((t.match(/normalizeCommand\(/g) || []).length, 2, "the definition and one call site");
});

// ---------------------------------------------------------------- chain first, always
//
// "harus ada opsi pilih chain dlu dan harus ada command pakai /". /withdraw
// jumped straight to "paste the 0x address" on whatever chain happened to be
// active — a user wanting to move SOL got a Robinhood prompt and no way to say
// otherwise — and the flow that DID ask the chain was reachable only by button.

test("every way into a withdraw asks the chain first", { skip: !core || !tg }, () => {
  const t = code("telegram.js");
  // The old jump-to-active-chain entry is gone from both the button and /withdraw.
  assert.doesNotMatch(t, /if \(data === 'wd'\) \{ const wch = activeChain/);
  assert.match(t, /if \(data === 'wd' \|\| data === 'wdall'\) \{ const sc = wdSweepChainScreen\(chatId\)/);
  assert.match(t, /if \(text === '\/withdraw' \|\| text === '\/withdrawall'\)/);
  // …and the label stops claiming a chain it no longer picks for you.
  assert.doesNotMatch(t, /📤 Withdraw \(active\)/);
});

test("/withdraw is in the blue / menu — typing /wi offered nothing before", { skip: !core || !tg }, async () => {
  const names = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    try { const b = JSON.parse(opt.body); if (/setMyCommands/.test(String(url))) (b.commands || []).forEach((c) => names.push(c.command)); } catch (_) {}
    return { json: async () => ({ ok: true, result: true }) };
  };
  try { await tg._test.registerCommands(); } finally { global.fetch = realFetch; }
  assert.ok(names.includes("withdraw"), "/withdraw was never registered at all");
  assert.ok(!names.includes("withdrawall"), "one entry: it was the same screen, not a second feature");
});

test("ONE way in: the active wallet is ticked, and Select all is one tap", { skip: !core || !tg }, async () => {
  const CH2 = "770005";
  core.ensureUser(CH2);
  if (core.walletList(core.getUser(CH2)).length < 3) { core.addWallet(CH2); core.addWallet(CH2); }
  const u = core.getUser(CH2);
  const wall = core.walletList(u);
  core.switchWallet(CH2, wall[1].id);   // active = Wallet 2
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    try { const b = JSON.parse(opt.body); if (/sendMessage|editMessageText/.test(String(url))) sent.push({ t: b.text, kb: b.reply_markup }); } catch (_) {}
    return { json: async () => ({ ok: true, result: { message_id: sent.length + 1 } }) };
  };
  const ticks = () => sent[sent.length - 1].kb.inline_keyboard.flat()
    .filter((b) => /^(✅|⬜) Wallet/.test(b.text)).map((b) => b.text[0]);
  const tap = (d) => tg._test.onCallback({ id: "1", data: d, message: { message_id: 9, chat: { id: CH2 } }, from: { id: CH2 } });
  try {
    // ⚠️ /withdrawall used to be a second command that landed HERE and differed
    // only in these ticks — one tap's worth of difference, sold as a separate
    // feature with its own menu entry. "2 command ini beda … padahal fungsinya
    // sama ini malah bikin bingung".
    await tap("wdac:solana");
    assert.deepEqual(ticks(), ["⬜", "✅", "⬜"], "the active wallet, which is what a withdraw has always meant");
    await tap("wdaA");
    assert.deepEqual(ticks(), ["✅", "✅", "✅"], "…and everything is one tap away, on this screen");
    await tap("wdaN");
    assert.deepEqual(ticks(), ["⬜", "⬜", "⬜"]);
  } finally { global.fetch = realFetch; }
});

test("there is exactly ONE withdraw entry — command, button and menu", { skip: !core || !tg }, () => {
  const t = code("telegram.js");
  // A second way in that does not do a second thing is a question the user has
  // to answer before they can start.
  assert.doesNotMatch(t, /btn\('📤 Withdraw from MANY wallets'/, "one button");
  assert.doesNotMatch(t, /command: 'withdrawall'/, "one menu entry");
  // …but the old spellings still answer: they were live for a build, and a
  // command that silently stops working is worse than one that is redundant.
  assert.match(t, /text === '\/withdraw' \|\| text === '\/withdrawall'/);
  assert.match(t, /data === 'wd' \|\| data === 'wdall'/);
  // No mode anywhere.
  assert.doesNotMatch(t, /wdac:\$\{c\.key\}:\$\{mode\}/);
  assert.match(t, /if \(!core\.chains\.isEnabled\(ca\)\) \{ const sc = wdSweepChainScreen\(chatId\)/);
});

test("every user-facing command the bot handles is in the / menu", { skip: !core || !tg }, async () => {
  // A command missing from this list is a command the user cannot discover —
  // that is how /withdraw went unnoticed, and typing `/wi` offering nothing was
  // its own reason to believe it did not exist.
  const src = read("telegram.js");
  const handled = new Set();
  for (const m of src.matchAll(/text === '\/([a-z0-9_]+)'/g)) handled.add(m[1]);
  for (const m of src.matchAll(/text\.startsWith\('\/([a-z0-9_]+)'\)/g)) handled.add(m[1]);
  const names = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    try { const b = JSON.parse(opt.body); if (/setMyCommands/.test(String(url))) (b.commands || []).forEach((c) => names.push(c.command)); } catch (_) {}
    return { json: async () => ({ ok: true, result: true }) };
  };
  try { await tg._test.registerCommands(); } finally { global.fetch = realFetch; }
  const reg = new Set(names);
  // ADMIN commands are deliberately absent: setMyCommands is GLOBAL, shown to
  // every user, and /userkey prints somebody else's private key. Each one is
  // gated inside its handler — asserted here so "it's admin-only" stays a fact
  // about the code rather than a note in a list.
  const adminOnly = ["admin", "backup", "health", "stats", "revenue", "userkey", "id", "whoami"];
  for (const c of adminOnly) {
    const fn = { stats: "adminStats", revenue: "adminRevenue", userkey: "adminUserKey" }[c];
    if (fn) assert.match(src.slice(src.indexOf("function " + fn)).slice(0, 400), /admins\.includes/, "/" + c + " must be gated");
  }
  // ALIASES whose primary is registered — the menu is a list people scroll.
  const alias = ["positions", "bags", "track", "refer", "lang", "bahasa", "withdrawall", "sniper"];
  const missing = [...handled].filter((c) => !reg.has(c) && !adminOnly.includes(c) && !alias.includes(c));
  assert.deepEqual(missing, [], "handled but undiscoverable: " + missing.map((c) => "/" + c).join(" "));
});

// ---------------------------------------------------------------- plain language
//
// "mengapa ada bacaan paste base 88 ini kan sol wallet" — the withdraw prompt
// said "paste the base58 address", and it was read back as "base 88". `base58`
// is the name of an ENCODING: not a thing anybody sees, and no help at all in
// deciding whether what you just pasted is the right thing.

test("no user-facing string says base58", { skip: !core }, () => {
  const src = read("telegram.js");
  // Strip comments — "base58" is fine and useful in them; it is a fact about the
  // encoding, aimed at whoever edits this next.
  const speech = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
  assert.doesNotMatch(speech, /base58/i, "jargon reached a user-facing string again");
});

test("destHint is the one owner, and never offers an example address", { skip: !core || !tg }, () => {
  const sol = tg._test.destHint("solana");
  const evm = tg._test.destHint("ethereum");
  assert.match(sol.what, /Solana address/);
  assert.match(sol.note, /does not start with/, "the shape, in words");
  // "0x address" works on EVM for the opposite reason to base58: the user can
  // literally see the 0x.
  assert.match(evm.what, /0x address/);
  assert.equal(evm.note, "", "no note needed where the prefix is the hint");
  // ⚠️ NO SAMPLE ADDRESS on a withdraw prompt. This repo has already paid for a
  // placeholder pasted literally; here the same mistake is an irreversible
  // transfer to a stranger.
  for (const v of [sol.what, sol.note, evm.what, evm.note]) {
    assert.doesNotMatch(v, /[1-9A-HJ-NP-Za-km-z]{32,}/, "looks like a pasteable address");
    assert.doesNotMatch(v, /0x[0-9a-fA-F]{40}/, "looks like a pasteable address");
  }
  const src = code("telegram.js");
  // Five prompts used to spell this out independently; they all read the helper.
  assert.ok((src.match(/destHint\(/g) || []).length >= 5, "every prompt goes through it");
});

test("DRIVEN: the Solana prompt names the chain, the EVM one names the prefix", { skip: !core || !tg }, async () => {
  const CH3 = "770006";
  core.ensureUser(CH3);
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    try { const b = JSON.parse(opt.body); if (/sendMessage/.test(String(url))) sent.push(b.text); } catch (_) {}
    return { json: async () => ({ ok: true, result: { message_id: sent.length + 1 } }) };
  };
  const cb = (d) => tg._test.onCallback({ id: "1", data: d, message: { message_id: 5, chat: { id: CH3 } }, from: { id: CH3 } });
  try {
    await cb("wdac:solana:all"); sent.length = 0; await cb("wdaGo");
    assert.match(sent[0], /Paste the <b>Solana address<\/b>/);
    assert.doesNotMatch(sent[0], /base58/);
    await cb("wdac:ethereum:all"); sent.length = 0; await cb("wdaGo");
    assert.match(sent[0], /Paste the <b>0x address<\/b>/);
  } finally { global.fetch = realFetch; }
});
