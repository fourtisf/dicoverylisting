// Multi-wallet trading (Maestro's 🟢 Multi panel). The engine already ran a Buy
// on several wallets at once — but the only way to choose them was a button that
// replaced the token card with a separate picker, so the price and liquidity you
// were choosing against disappeared while you chose. The toggles now sit on the
// card itself.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-multiwallet-"));

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
/** A user with `n` wallets. Planted straight into the store rather than minted:
 *  the selection logic under test does not care what is inside a wallet, and
 *  generating real keys would drag key derivation into a UI test. */
function userWith(n, chatId) {
  if (!core) return null;
  const u = (core.DB.users[chatId] = core.DB.users[chatId] || { chatId, wallets: [] });
  u.wallets = Array.from({ length: n }, (_, i) => u.wallets[i] || { id: `w${chatId}_${i + 1}`, name: "", positions: {}, orders: [] });
  u.activeWalletId = u.wallets[0].id;
  return core.walletList(u);
}

test("the toggles render on the card, not on a screen that replaces it", () => {
  const tg = code("telegram.js");
  assert.match(tg, /async function tokenCard\(chatId, ca, chainKey, walletId, opts\)/);
  assert.match(tg, /const multiOpen = !!\(opts && opts\.multi\);/);
  // The grid is built into the card's own keyboard rows.
  assert.match(tg, /if \(multiOpen\) \{/);
  assert.match(tg, /walletRow\.push\(\[btn\('🟢 All ON'/);
  assert.match(tg, /btn\('🔴 All OFF'/);
  // …and the card keeps rendering it, rather than a handler sending a new message.
  // Position-independent: the grid must be spread into the card's OWN keyboard,
  // which is the property. Pinning it to the first line of the array made the
  // Buy/Sell side switch — a row that legitimately sits above it — read as a
  // regression.
  assert.match(tg, /const ikb = \[[\s\S]{0,600}\.\.\.walletRow,/);
});

test("the panel is a toggle — open it, close it, same message", () => {
  const tg = code("telegram.js");
  assert.match(tg, /\$\{multiOpen \? 'wex0' : 'wex1'\}/, "one button, two directions");
  const h = tg.slice(tg.indexOf("if (k === 'wex1'"));
  const body = h.slice(0, h.indexOf("\n  }"));
  // Same card, same message: `multi` flips with the direction of the tap. The
  // render also reuses the last full scan — a toggle changes which wallets are
  // lit and nothing a network read would tell us (see walletToggle.test.js).
  assert.match(body, /const c = await tokenCard\(chatId, mca, chainK, wid, \{ multi: k !== 'wex0', reuse: true \}\);/);
  assert.match(body, /return edit\(chatId, mid, c\.text, c\.kb\);/, "edit, never send — a run of taps must not fill the chat");
});

test("every new callback fits Telegram's 64-byte limit", () => {
  // The card's Buy callback is already at ~64 with a Robinhood chain key and a
  // 42-char address; these carry a wallet number on top. A template that grew
  // one field would be rejected by Telegram at render time, on that chain only.
  const src = read("telegram.js");
  const WORST = {
    chainKey: "robinhood".length, // longest chain key
    wi: 2, // wallet index, capped at 99
    ca: 44, // a Solana mint is longer than an EVM address
    n: 2,
    "multiOpen ? 'wex0' : 'wex1'": 4,
  };
  const found = src.match(/`(?:wex[01]|wtcA|wtcN|wtc|\$\{multiOpen[^}]*\})[^`]*`/g) || [];
  assert.ok(found.length >= 4, `expected the multi callbacks, found ${found.length}`);
  for (const tpl of found) {
    const size = tpl.slice(1, -1).replace(/\$\{([^}]*)\}/g, (_, expr) => {
      const key = expr.trim();
      assert.ok(key in WORST, `unknown interpolation ${key} in ${tpl} — add its worst case here`);
      return "x".repeat(WORST[key]);
    }).length;
    assert.ok(size <= 64, `${tpl} is ${size} bytes at worst — Telegram rejects >64`);
  }
});

test("a second wallet ADDS to the selection, it never replaces the first", (t) => {
  // The bug this guards: in single mode there is no selection list, but the
  // card's own wallet is drawn lit because it is the one that trades. A plain
  // toggle of the wallet you tapped would produce a list of exactly ONE — the
  // first wallet silently dropped out, and the next Buy spent half of what the
  // user thought they had committed.
  const list = userWith(3, 900001);
  if (!list) return t.skip("deps not installed in this checkout");
  core.setTradeAll(900001, false);
  assert.deepStrictEqual(core.tradeWalletIds(900001), [], "starts in single mode");

  // What the handler does: seed with the card's wallet, then toggle the tapped one.
  core.toggleTradeWallet(900001, list[0].id);
  core.toggleTradeWallet(900001, list[1].id);
  const ids = core.tradeWalletIds(900001);
  assert.strictEqual(ids.length, 2, `both wallets must trade, got ${ids.length}`);
  assert.ok(ids.includes(list[0].id) && ids.includes(list[1].id));
});

test("selecting every wallet collapses to ALL, so adding a wallet later includes it", (t) => {
  const list = userWith(3, 900002);
  if (!list) return t.skip("deps not installed in this checkout");
  core.setTradeAll(900002, false);
  for (const w of list) core.toggleTradeWallet(900002, w.id);
  assert.strictEqual(core.tradeSelection(900002).all, true, "all three selected → 'ALL', not a frozen list of three");
  const grown = userWith(4, 900002);
  assert.strictEqual(core.tradeWalletIds(900002).length, grown.length, "a wallet added afterwards is included");
});

test("All OFF returns to single — it does not leave zero wallets trading", (t) => {
  const list = userWith(2, 900003);
  if (!list) return t.skip("deps not installed in this checkout");
  core.setTradeAll(900003, true);
  assert.strictEqual(core.tradeWalletIds(900003).length, 2);
  core.setTradeAll(900003, false);
  assert.deepStrictEqual(core.tradeWalletIds(900003), [], "empty means 'fall back to the card wallet', never 'trade nothing'");
  // The card proves that: with no selection it falls back to the bound wallet.
  assert.match(code("telegram.js"), /const pick = ids\.length \? ids : \[cardWalletId \|\| \(core\.activeWallet\(u\) \|\| \{\}\)\.id\]\.filter\(Boolean\);/);
});

test("a lit dot means that wallet trades on the next tap — nothing else", () => {
  const tg = code("telegram.js");
  assert.match(tg, /const on = selN \? selIds\.has\(wobj\.id\) : wobj\.id === w\.id;/);
  // Same rule as the balance table above it, so the two can never disagree.
  assert.match(tg, /const on = selN \? selIds\.has\(r\.id\) : \(r\.id === w\.id\);/);
});

test("the selection actually drives the trade, on both sides", () => {
  const tg = code("telegram.js");
  // Started as one Promise.allSettled over every target — parallel, and (since
  // the latency work) in flight before the progress message is awaited.
  // The fan-out itself is what this pins — one call per target, all in flight
  // at once. It is no longer written inline inside the allSettled: each buy now
  // carries a `.then` tap that posts that wallet's own receipt the moment it
  // settles (see receipt.js), so the promises are created first and the
  // reporting is attached to them. That changes the telling, not the
  // parallelism.
  assert.match(tg, /const raw = targets\.map\(\(t\) => core\.buy\(chatId, ca, amt, chain, t\.id\)\);/,
    "a multi Buy runs on every selected wallet, in parallel");
  assert.match(tg, /Promise\.allSettled\(raw\.map\(/, "…as one settled batch");
  assert.match(tg, /await Promise\.all\(\[progressP, buys\]\)/, "…and every one of them is awaited");
  const sell = tg.slice(tg.indexOf("async function doSell("));
  assert.match(sell, /const targets = tradeTargets\(chatId, walletId\);/, "Sell reads the same selection");
  // Both report per wallet, so a partial failure is visible rather than averaged
  // into a single number.
  // The per-wallet tally moved into the i18n template with the rest of the
  // receipt copy; both languages must still carry it. The template is now
  // CHOSEN by the outcome (see multiBuyReceipt.test.js — ✅ may not head a
  // receipt where nothing filled), so the tally is what this pins, not the key.
  assert.match(tg, /T\(chatId, headKey, \{ sym: esc\(symShown\), ok: okN, n: targets\.length/);
  const i18n = require("./i18n");
  for (const lang of i18n.LANGS) {
    const head = i18n.t(lang, "buy.receipt.multi", { sym: "PEPE", ok: 2, n: 3, tokens: "1.2M", spent: "0.05", native: "ETH", usd: "" });
    assert.match(head, /2\/3/, `${lang} multi-buy head lost the per-wallet tally`);
  }
});

test("one tap answers exactly once", () => {
  // Telegram accepts a single answerCallbackQuery per tap. The blanket ack at
  // the top of onCallback plus a toast in the handler = the toast never shows.
  //
  // This test used to pin the literal condition `k !== 'oc' && k !== 'al' &&
  // k !== 'wtc'`, which made it a LOCK on the bug rather than a guard against
  // it: five more handlers grew text answers, every one of them was mute, and
  // this assertion held the broken condition in place while they did. The
  // exempt list is now data, and callbackAck.test.js checks it against every
  // call site in the file.
  const tg = code("telegram.js");
  assert.match(tg, /if \(!ANSWERS_ITSELF\.has\(k\)\) answer\(q\.id\)\.catch/);
  assert.match(tg, /const ANSWERS_ITSELF = new Set\(\[[^\]]*'wtc'/, "wtc must stay exempt");
  const h = tg.slice(tg.indexOf("else if (k === 'wtc')"));
  const body = h.slice(0, h.indexOf("\n    }"));
  assert.match(body, /answer\(q\.id, 'Already the wallet that trades/, "the one case with something to say");
  assert.match(body, /\n\s*answer\(q\.id\)\.catch/, "…and a plain ack on every other path, or the spinner hangs");
});

test("the detailed picker is still reachable — it shows each wallet's bag", () => {
  // The inline grid has room for a name and a dot. Which wallet holds how much
  // of THIS token is the thing you actually decide on, and that screen still
  // exists behind the 👛 button.
  const tg = code("telegram.js");
  assert.match(tg, /btn\(selLabel, `wsel:\$\{chainKey\}:\$\{ca\}`\)/);
  assert.match(tg, /async function walletPickScreen\(chatId, ca, chainKey\)/);
});
