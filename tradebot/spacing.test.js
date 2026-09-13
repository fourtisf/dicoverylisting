// "copy writing harusnya semuanya pake spasi ... agar tidak keliatan spam."
//
// A message with eleven lines and no break in it reads as a wall — the eye has
// nowhere to land, and in a chat that is exactly what bot spam looks like. The
// rule is one line: blocks are separated by a blank line, and nothing runs more
// than four lines without one.
//
// A rule with no test is a preference, and preferences drift back. This file is
// the rule: it renders the real screens and fails on any wall.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-spacing-"));

const test = require("node:test");
const assert = require("node:assert");

const MAX_RUN = 4;

/** Lines in a run that all repeat the same leading token are a LIST — ten
 *  wallets or twenty trades belong together, and breaking them up every fourth
 *  row would be the arbitrary-looking thing. Prose does not repeat a marker. */
function isList(run) {
  const body = run.length > 1 ? run.slice(1) : run;   // a header may lead the list
  if (body.length < 2) return false;
  const lead = (l) => {
    const m = l.replace(/<[^>]*>/g, "").match(/^(\s*)(\S{1,2})/);
    return m ? (m[1] ? "indent" : m[2]) : "";
  };
  const first = lead(body[0]);
  return first !== "" && body.every((l) => lead(l) === first);
}

/** Every run of non-blank lines that is too long to read as one block. */
function walls(text) {
  const out = [];
  let run = [];
  // A standalone bold heading is itself a break — it tells the eye a new group
  // started — so it does not count against the block's four lines.
  const isHeading = (l) => /^<b>[^<]{1,40}<\/b>$/.test(l.trim());
  const flush = () => {
    const body = run.length && isHeading(run[0]) ? run.slice(1) : run;
    if (body.length > MAX_RUN && !isList(run)) out.push(run.join("\n"));
    run = [];
  };
  for (const line of String(text).split("\n")) {
    if (line.trim() === "") flush();
    else run.push(line);
  }
  flush();
  return out;
}

test("the rule itself is right — it catches a wall and spares a list", () => {
  // Guarding the guard: a rule that cannot fail proves nothing about the screens.
  const wall = "Active chain: X\nSlippage: Y\nGas: Z\nQuick-buy: A\nConfirm: B\nFast mode: C";
  assert.strictEqual(walls(wall).length, 1, "six prose lines with no break is a wall");
  const list = "👛 Balance across wallets\n▫️ Wallet 1 · 0.10\n▫️ Wallet 2 · 0.20\n▫️ Wallet 3 · 0.30\n▫️ Wallet 4 · 0.40\n▫️ Wallet 5 · 0.50";
  assert.deepStrictEqual(walls(list), [], "a list of wallets is one block, however long");
  assert.deepStrictEqual(walls("a\nb\nc\nd"), [], "four lines is the limit, not an error");
});

// ── The token card ──────────────────────────────────────────────────────────
// Rendered from the real source (same harness as tokenCard.test.js), because
// this is the message the complaint was about.
const SRC = fs.readFileSync(path.join(__dirname, "telegram.js"), "utf8");
function renderCard(f) {
  const start = SRC.indexOf("  // ── Header: name · symbol");
  const end = SRC.indexOf("  const valueEth = bal * px;");
  const block = SRC.slice(start, end).split("\n")
    .filter((l) => !/^\s*(const sel =|const selIds =|const selN =|const usdOf =)/.test(l)).join("\n");
  const L = [];
  const gap = () => { if (L.length && L[L.length - 1] !== "") L.push(""); };
  const { info, ch, api, sec, name, sym, nat, px, priceUsd, ca } = f;
  const esc = (x) => String(x);
  const fmt = (n) => { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(2) + "M"; if (n >= 1e3) return (n / 1e3).toFixed(2) + "K"; return n.toFixed(n < 1 ? 4 : 2); };
  const nativeUsd = () => f.rate;
  const usd = (a) => "$" + fmt(Number(a) * f.rate);
  const taxStr = (v) => (v == null ? "?" : `${Number(v).toFixed(0)}%`);
  const fmtAge = (ms) => Math.floor((Date.now() - ms) / 86400000) + "d";
  const safety = { verdict: () => ({ level: f.secLevel || "ok", red: [], warn: [] }),
    supported: () => f.secSupported !== false };
  const chainKey = ch.key;
  const chatId = 1;
  const i18n = require("./i18n");
  const T = (_id, key, vars) => i18n.t("en", key, vars);
  void chatId; void T;
  void gap; void chainKey; void safety; void esc; void fmt; void nativeUsd; void usd; void taxStr; void fmtAge;
  void info; void ch; void api; void sec; void name; void sym; void nat; void px; void priceUsd; void ca;
  eval(block);
  return L.join("\n");
}
const CARDS = {
  "thin token, no indexer": {
    rate: 1820, nat: "ETH", ca: "0x1E3a870326C9c1ed08558e75d2C8c2b884EdE280",
    name: "Portfi.fun", sym: "PORTFI", px: 1.42e-9, priceUsd: 0.00000259,
    ch: { key: "robinhood", name: "Robinhood Chain", emoji: "🪶", curve: true, native: "ETH" },
    api: null, sec: null,
    info: { dex: true, dexVenue: "v3", graduated: true, mcapEth: 1.42, liquidityNative: 0.02, market: null, gas: { gwei: 0.045, feeNative: 0.0000135 } },
  },
  "everything present": {
    rate: 1820, nat: "ETH", ca: "0x4200000000000000000000000000000000000042",
    name: "Higher", sym: "HIGHER", px: 0.0000412, priceUsd: 0.075,
    ch: { key: "base", name: "Base", emoji: "🔵", curve: false, native: "ETH" },
    api: { links: { website: "https://x.io", twitter: "https://x.com/a", telegram: "https://t.me/a" } },
    sec: { holders: 4128, lpLockedPct: 100, buyTaxPct: 5, sellTaxPct: 5, honeypot: true, openSource: false },
    info: {
      dex: true, dexVenue: "v3", mcapEth: 4120, liquidityNative: 0.5,
      market: { volH24Usd: 1284000, chgH1: 3.4, chgH24: -12.8, buysH24: 1840, sellsH24: 1620, liqUsd: 383000, createdAt: Date.now() - 86400000 * 91 },
      gas: { gwei: 0.021, feeNative: 0.0000063 },
    },
  },
};

test("the token card breathes, in every shape it can take", () => {
  for (const [label, fixture] of Object.entries(CARDS)) {
    const out = renderCard(fixture);
    assert.deepStrictEqual(walls(out), [], `${label} renders a wall:\n${out}`);
    assert.ok(out.includes("\n\n"), `${label} has no blank line at all:\n${out}`);
  }
});

test("the card separates blocks with space, not with a drawn rule", () => {
  // ━━━━ lines cost a line of noise per section and still leave the block itself
  // unbroken. Whitespace groups just as well and disappears when read.
  const card = SRC.slice(SRC.indexOf("async function tokenCard("), SRC.indexOf("async function walletPickScreen("));
  assert.ok(!/L\.push\(SEP\)/.test(card), "the card must not draw rules between its blocks");
  assert.match(card, /const gap = \(\) => \{ if \(L\.length && L\[L\.length - 1\] !== ''\) L\.push\(''\); \};/);
  // gap() must be idempotent — two blocks that both open with one must not
  // produce a double blank line.
  const L = ["a"];
  const gap = () => { if (L.length && L[L.length - 1] !== "") L.push(""); };
  gap(); gap(); gap();
  assert.deepStrictEqual(L, ["a", ""], "consecutive gaps collapse to one");
});

// ── Every other screen ──────────────────────────────────────────────────────
let tg = null;
let core = null;
try {
  core = require("./core");
  tg = require("./telegram");
} catch {
  /* deps not installed in this checkout */
}
function plantUser(chatId) {
  const u = (core.DB.users[chatId] = core.DB.users[chatId] || { chatId });
  u.wallets = [{ id: "w1", name: "", positions: {}, orders: [], history: [] }];
  u.activeWalletId = "w1";
  return core.ensureUser(chatId);
}

test("no screen in the bot is a wall of text", (t) => {
  if (!tg) return t.skip("deps not installed in this checkout");
  const id = 970001;
  plantUser(id);
  const screens = {
    Settings: () => tg._test.settingsScreen(id),
    Gas: () => tg._test.gasScreen(id),
    Notifications: () => tg._test.notifyScreen(id),
    Security: () => tg._test.securityScreen(id),
    Snipe: () => tg._test.snipeScreen(id),
    Copy: () => tg._test.copyScreen(id),
    DCA: () => tg._test.dcaScreen(id),
    Help: () => ({ text: tg._test.helpText(id) }),
    Stats: () => ({ text: tg._test.statsText(core.reportSnapshot(), 1234) }),
  };
  const failures = [];
  for (const [name, run] of Object.entries(screens)) {
    let text;
    try { text = run().text; } catch (e) { failures.push(`${name} threw: ${e.message}`); continue; }
    for (const wall of walls(text)) failures.push(`${name}:\n${wall}`);
  }
  assert.deepStrictEqual(failures, [], `these screens read as walls:\n\n${failures.join("\n\n")}`);
});

test("every screen actually uses blank lines — not one long line each", (t) => {
  if (!tg) return t.skip("deps not installed in this checkout");
  const id = 970002;
  plantUser(id);
  for (const [name, s] of Object.entries({
    Settings: tg._test.settingsScreen(id),
    Gas: tg._test.gasScreen(id),
    Snipe: tg._test.snipeScreen(id),
    Help: { text: tg._test.helpText(id) },
  })) {
    assert.ok(s.text.includes("\n\n"), `${name} has no block break at all`);
  }
});

test("settings groups its rows by what they govern", (t) => {
  if (!tg) return t.skip("deps not installed in this checkout");
  const id = 970003;
  plantUser(id);
  const text = tg._test.settingsScreen(id).text;
  // Nine unlabelled rows in a column is a form, not an answer to "what is my
  // bot doing". Headings tell you which row you are looking for.
  for (const head of ["<b>Trading</b>", "<b>How buys behave</b>", "<b>Automatic exits</b>"]) {
    assert.ok(text.includes(head), `settings is missing the ${head} group:\n${text}`);
  }
});
