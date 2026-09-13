// The scan card next to Maestro's: ours printed bare fragments — "LP burned"
// alone on a line, "Liq 0.02 ETH" with nothing to compare it against — and when
// a data source returned nothing it silently dropped whole lines, so a token on
// a chain with no indexer rendered three lines and read like a broken bot rather
// than a thin token.
//
// These tests run the card's REAL text-building block against fixtures, so the
// layout is checked, not just the presence of a string somewhere in the file.
const fs = require("node:fs");
const path = require("node:path");

const test = require("node:test");
const assert = require("node:assert");

const SRC = fs.readFileSync(path.join(__dirname, "telegram.js"), "utf8");

/** The card's header + market block, lifted verbatim and run against a fixture.
 *  Slicing the source keeps this honest: it cannot pass against a copy of the
 *  code that has drifted from what the bot sends. */
function render(f) {
  const start = SRC.indexOf("  // ── Header: name · symbol");
  const end = SRC.indexOf("  const valueEth = bal * px;");
  assert.ok(start > -1 && end > start, "the card's market block moved — update the markers here");
  const block = SRC.slice(start, end)
    .split("\n")
    .filter((l) => !/^\s*(const sel =|const selIds =|const selN =|const usdOf =)/.test(l))
    .join("\n");
  const L = [];
  const gap = () => { if (L.length && L[L.length - 1] !== '') L.push(''); };
  const SEP = "━━━━━━━━━━━━━━━━";
  const { info, ch, api, sec, name, sym, nat, px, priceUsd, ca } = f;
  const esc = (x) => String(x);
  const fmt = (n) => { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(2) + "M"; if (n >= 1e3) return (n / 1e3).toFixed(2) + "K"; return n.toFixed(n < 1 ? 4 : 2); };
  const nativeUsd = () => f.rate;
  const usd = (a) => "$" + fmt(Number(a) * f.rate);
  const taxStr = (v) => (v == null ? "?" : `${Number(v).toFixed(0)}%`);
  const fmtAge = (ms) => { const s = Math.floor((Date.now() - ms) / 1000); if (s < 3600) return Math.floor(s / 60) + "m"; if (s < 86400) return Math.floor(s / 3600) + "h"; return Math.floor(s / 86400) + "d"; };
  // Fixture-driven so the four safety states can each be rendered: a verdict
  // level, and whether the chain supports screening at all.
  const safety = { verdict: () => ({ level: f.secLevel || "ok", red: f.secRed || [], warn: f.secWarn || [] }),
    supported: () => f.secSupported !== false };
  const chainKey = ch.key;
  const chatId = 1;
  // The REAL copy, so a test cannot pass against wording the bot does not send.
  const i18n = require("./i18n");
  const T = (_id, key, vars) => i18n.t("en", key, vars);
  void chatId; void T;
  void chainKey; void safety; void esc; void fmt; void nativeUsd; void usd; void taxStr; void fmtAge; void SEP;
  void info; void ch; void api; void sec; void name; void sym; void nat; void px; void priceUsd; void ca;
  eval(block);
  return L.join("\n");
}
const plain = (s) => s.replace(/<\/?(b|i|code|a)[^>]*>/g, "");

const ROBINHOOD = {
  rate: 1820, nat: "ETH", ca: "0x1E3a870326C9c1ed08558e75d2C8c2b884EdE280",
  name: "Portfi.fun", sym: "PORTFI", px: 0.00000000142, priceUsd: 0.00000259,
  ch: { key: "robinhood", name: "Robinhood Chain", emoji: "🪶", curve: true, native: "ETH" },
  api: null, sec: null,
  info: { dex: true, dexVenue: "v3", graduated: true, mcapEth: 1.42, liquidityNative: 0.02, market: null, gas: { gwei: 0.045, feeNative: 0.0000135 } },
};
const FULL = {
  rate: 1820, nat: "ETH", ca: "0x4200000000000000000000000000000000000042",
  name: "Higher", sym: "HIGHER", px: 0.0000412, priceUsd: 0.075,
  ch: { key: "base", name: "Base", emoji: "🔵", curve: false, native: "ETH" },
  api: null,
  sec: { holders: 4128, lpLockedPct: 100, buyTaxPct: 0, sellTaxPct: 0, honeypot: false, openSource: true },
  info: {
    dex: true, dexVenue: "v3", mcapEth: 4120, liquidityNative: 210.4,
    market: { volH24Usd: 1284000, chgH1: 3.4, chgH24: -12.8, buysH24: 1840, sellsH24: 1620, liqUsd: 383000, createdAt: Date.now() - 86400000 * 91 },
    gas: { gwei: 0.021, feeNative: 0.0000063 },
  },
};

test("every value on the card says what it is", () => {
  // The old card's second line was literally "Liq 0.02 ETH ($36.39)" followed by
  // a line reading only "LP burned". A reader had to already know the format.
  const out = plain(render(FULL));
  for (const label of ["Price", "Mcap", "Liquidity", "Change", "Vol 24h", "holders", "Tax", "Gas", "Updated"]) {
    assert.ok(out.includes(label), `no "${label}" label:\n${out}`);
  }
  // No line may be a bare value with no word in front of it.
  for (const line of out.split("\n").slice(3)) {
    if (!line || line.startsWith("━")) continue;
    assert.match(line, /[A-Za-z]{3,}/, `a line with no label: ${line}`);
  }
});

test("liquidity is shown against the market cap — the number people actually need", () => {
  // $36 of liquidity under a $2.59K cap is the entire story of a token, and the
  // card used to leave the reader to do that division themselves.
  const out = plain(render(ROBINHOOD));
  assert.match(out, /Liquidity 0\.020 ETH \(\$36\.40\)\s+·\s+1\.4% of mcap/, out);
  // Decimals follow the magnitude: 0.020 and 210.4 must both read cleanly.
  assert.match(plain(render(FULL)), /Liquidity 210\.4 ETH/, "a big pool must not print six digits");
});

test("a chain with no indexer says so instead of rendering a stub", () => {
  // THE fix. Robinhood has no DexScreener and no GoPlus, so volume, change and
  // holders were simply absent — and an absent line is indistinguishable from a
  // broken bot.
  const out = plain(render(ROBINHOOD));
  assert.match(out, /No indexer covers Robinhood Chain yet — volume, price change and holder count unavailable/, out);
  assert.match(out, /read straight from the chain/, "…and it must say the prices ARE real");
  // The note appears only when something is genuinely missing.
  assert.ok(!plain(render(FULL)).includes("No indexer"), "a fully-covered token must not be apologised for");
});

test("the card carries a timestamp, because a scan is a moment in time", () => {
  // Maestro's own card prints "Updated | Jul 26 14:49:08" — and in the
  // side-by-side that timestamp was 14 minutes stale, which was the whole reason
  // its numbers disagreed with ours. Ours are fetched on render; saying so is
  // what makes a moving price trustworthy.
  const out = plain(render(FULL));
  assert.match(out, /Updated \d{2}:\d{2}:\d{2} UTC · tap 🔄 Refresh/, out);
});

test("what a trade costs is on the card", () => {
  // On a cheap L2 "about two cents" is often what decides whether a small buy is
  // worth making, and the card could not answer it at all.
  assert.match(plain(render(ROBINHOOD)), /Gas 0\.045 gwei · ≈\$0\.02 per trade/);
  // Sub-gwei prices must not round to "0.0 gwei".
  assert.ok(!/Gas 0\.0 gwei/.test(plain(render(FULL))), "sub-gwei needs more precision, not less");
  assert.match(plain(render(FULL)), /Gas 0\.021 gwei/);
});

test("age sits beside the name, where it changes how you read everything below", () => {
  assert.match(plain(render(FULL)).split("\n")[1], /^🔵 Base\b.*·\s+91d old$/, plain(render(FULL)).split("\n")[1]);
  // A token with no known creation time must not print "undefined old".
  assert.ok(!/old/.test(plain(render(ROBINHOOD)).split("\n")[1]), "no age, no age line");
});

test("direction is readable before the number is", () => {
  const out = plain(render(FULL));
  assert.match(out, /1h 🟢 \+3\.4%/, out);
  assert.match(out, /24h 🔴 -12\.8%/, out);
});

test("a launchpad token is not accused of hiding its tax", () => {
  // GoPlus does not cover Robinhood, so `sec` is null — but a curve token cannot
  // set a tax at all. Printing nothing implied the tax was unknown.
  const out = plain(render(ROBINHOOD));
  assert.match(out, /Fair launch · 0% tax/, out);
  assert.ok(!/holders and tax/.test(out), "tax is known here, so it must not be listed as missing");
});

test("the danger flags still come first and still shout", () => {
  const hp = JSON.parse(JSON.stringify(FULL));
  hp.sec = { ...FULL.sec, honeypot: true, openSource: false, buyTaxPct: 25, sellTaxPct: 99 };
  const out = plain(render(hp));
  assert.match(out, /🚨 HONEYPOT/);
  assert.match(out, /closed-source/);
  assert.match(out, /Tax 25% buy \/ 99% sell/);
});

test("the thin-pool warning survived the rewrite", () => {
  // It is the one line that stops someone buying into a pool the bot can't reach.
  const thin = JSON.parse(JSON.stringify(FULL));
  thin.info.liquidityNative = 0.5;       // the pool the bot can trade
  thin.info.market.liqUsd = 383000;      // what the indexer advertises
  assert.match(plain(render(thin)), /Thin tradeable pool/);
});

test("⚠️ the card's two RPC waves run CONCURRENTLY — the balances do not wait for the scan", () => {
  /*
   * "bot respon dari kirim pesan lama sekali" (2026-08-28). The card awaited
   * `tokeninfo.enrich` — which on a bonding-curve token reads the curve's
   * interface, the slowest thing this bot does — and only THEN read a
   * totalSupply plus two balances per wallet, five wallets deep. Two
   * independent waves in series, on the one screen a user stares at after
   * pasting an address. The header already states this lesson about
   * `tokenMeta`; the balances are the same shape one wave further down.
   *
   * A source scan is the honest guard here: the win is that `acrossP` is
   * CREATED before the enrich await and COLLECTED after it, and a timing test
   * against stubbed RPC would measure its own fakes.
   */
  const src = fs.readFileSync(path.join(__dirname, "telegram.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");   // comments quote the defect they guard
  const start = src.indexOf("const acrossP =");
  const awaitEnrich = src.indexOf("await tokeninfo.enrich(");
  const collect = src.indexOf("await acrossP");
  assert.ok(start > 0 && awaitEnrich > 0 && collect > 0, "the card's balance wave is not where this expects it");
  assert.ok(start < awaitEnrich, "the balances must START before the scan is awaited, or they are serial again");
  assert.ok(collect > awaitEnrich, "and be COLLECTED after it, or the overlap buys nothing");
  assert.match(src, /const acrossP[\s\S]{0,320}?\.catch\(/, "with a catch at creation — every early return leaves it in flight");
});

test("gas is read from the chain, and the swap cost is labelled an estimate", () => {
  const src = fs.readFileSync(path.join(__dirname, "tokeninfo.js"), "utf8");
  assert.match(src, /async function gasSnapshot\(chainKey\)/);
  assert.match(src, /const fd = await core\.providerFor\(chainKey\)\.getFeeData\(\);/, "the price is real, not a constant");
  assert.match(src, /const SWAP_GAS_UNITS = 300000n;/, "the units are representative — hence the ≈ on the card");
  assert.match(src, /if \(core\.chains\.isSvm\(chainKey\)\) return null;/, "Solana fees are not gwei");
  // Best-effort like every other leg: a slow RPC must not hold up the card.
  // ⚠️ THE PROPERTY, NOT THE LINE. This used to match the exact `tasks.push(
  // gasSnapshot(chainKey)...)` spelling, so starting the read EARLIER — beside
  // the snapshot instead of behind it, which is a straight latency win on the
  // screen the product is judged by — failed a test about gas being real. What
  // matters is that it is read from the chain, that it lands on `info.gas`, and
  // that it is awaited inside the bounded task list.
  assert.match(src, /gasSnapshot\(chainKey\)/, "the read is made");
  assert.match(src, /info\.gas = g;/, "and it lands on the card's field");
  assert.match(src, /tasks\.push\(gasP\.then/, "collected in the bounded task list, so a slow RPC cannot hold the card");
});

// ---------------------------------------------------------------------------
// The card's KEYBOARD, driven for real. Everything above slices the text block;
// what follows renders the whole card, because which buttons exist beside which
// is the thing being changed.
const os = require("node:os");
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tokcard-"));
process.env.WALLET_SECRET = "w".repeat(48);
process.env.TRADEBOT_TOKEN = "x:y";
process.env.ENABLED_CHAINS = "robinhood";
const core = require("./core");
const tg = require("./telegram");
const tokeninfo = require("./tokeninfo");
const CA = "0x39dBED3a2bd333467115dE45665cC57F813C4571";
const CHAIN = "robinhood";
const CHAT = 7;

// ---------------------------------------------------------------- buy vs sell
//
// The token card carried twenty-two buttons across eight rows: three Buy rows
// and four Sell rows interleaved, plus wallets, plus links. Someone arriving to
// do one thing had to find it in a wall — and a Buy sitting one row above a
// Sell 100% is not only confusing, it is a misfire waiting to happen.

async function tcard({ side, holding = true, chat = CHAT } = {}) {
  core.DB.users = {};
  const u = core.ensureUser(chat);
  u.wallets = [2, 3, 4].map((i) => ({ id: 'w' + i, name: 'Wallet ' + i, address: '0x' + String(i).repeat(40), positions: {}, orders: [], history: [] }));
  u.activeWalletId = 'w4';
  core.setTradeAll(chat, true);
  const bag = holding ? 56270000000000000000n : 0n;
  const realEnrich = tokeninfo.enrich, realMeta = core.tokenMeta, realAcross = core.tokenAcrossWallets;
  tokeninfo.enrich = async () => ({ sym: 'PONS', name: 'Pons', priceEth: 0.0000145, priceUsd: 0.0272, mcapUsd: 27e6, chainKey: CHAIN, native: 'ETH' });
  core.tokenMeta = async () => ({ sym: 'PONS', name: 'Pons', decimals: 18 });
  core.tokenAcrossWallets = async () => ({ rows: u.wallets.map((w, i) => ({ id: w.id, index: i + 1, label: w.name, address: w.address, active: w.id === 'w4', raw: bag, tokens: holding ? 56.27 : 0, pctSupply: 0, eth: 0.3 })), holderId: 'w4', supply: 0n });
  tg._test.PRICES.ETH = 1870;
  try { return await tg._test.tokenCard(chat, CA, CHAIN, 'w4', { side }); }
  finally { tokeninfo.enrich = realEnrich; core.tokenMeta = realMeta; core.tokenAcrossWallets = realAcross; }
}
const cbs = (p) => p.kb.inline_keyboard.flat().map((b) => b.callback_data || '').filter(Boolean);

test('a Buy button and a Sell button are never on the same card', async () => {
  // The misfire this prevents: Sell 100% one row below Buy 0.1.
  const buy = cbs(await tcard({ side: 'buy' }));
  assert.ok(buy.some((d) => d.startsWith('b:')), 'the buy side has no Buy');
  for (const d of buy) assert.ok(!/^s:/.test(d), `a Sell survived on the buy side: ${d}`);

  const sell = cbs(await tcard({ side: 'sell' }));
  assert.ok(sell.some((d) => d.startsWith('s:')), 'the sell side has no Sell');
  for (const d of sell) assert.ok(!/^b:/.test(d), `a Buy survived on the sell side: ${d}`);
});

test('the side you are on is the one you are most likely here for', async () => {
  // Holding a bag → Sell. Holding none → Buy. The common case costs no taps.
  assert.equal(tg._test.cardSide(1, CA, undefined, true), 'sell');
  assert.equal(tg._test.cardSide(2, CA, undefined, false), 'buy');
  // Rendered on a chat with no remembered choice for this token, so what is
  // being measured is the DEFAULT and not a leftover from the test above.
  const held = cbs(await tcard({ holding: true, chat: 8001 }));
  assert.ok(held.some((d) => d.startsWith('s:')), 'a holder landed on the Buy side');
  const empty = cbs(await tcard({ holding: false, chat: 8002 }));
  assert.ok(empty.some((d) => d.startsWith('b:')), 'someone holding nothing landed on the Sell side');
});

test('a remembered SELL is dropped once the bag is gone', async () => {
  // The choice was made about a position that no longer exists, and a Sell side
  // with nothing to sell is a screen of buttons that can only fail.
  const chat = 5150;
  assert.equal(tg._test.cardSide(chat, CA, 'sell', true), 'sell');
  assert.equal(tg._test.cardSide(chat, CA, undefined, false), 'buy', 'a sold-out position still opened on Sell');
  // …a remembered BUY always stands: wanting more of something you hold is ordinary.
  assert.equal(tg._test.cardSide(chat, CA, 'buy', false), 'buy');
  assert.equal(tg._test.cardSide(chat, CA, undefined, true), 'buy');
});

test('an explicit choice sticks — tapping Buy while holding means it', async () => {
  const chat = 4242;
  assert.equal(tg._test.cardSide(chat, CA, 'buy', true), 'buy');
  assert.equal(tg._test.cardSide(chat, CA, undefined, true), 'buy', 'the choice was forgotten on the next render');
  assert.equal(tg._test.cardSide(chat, CA, 'sell', true), 'sell');
  assert.equal(tg._test.cardSide(chat, '0x' + 'ff'.repeat(20), undefined, false), 'buy', 'the choice leaked to another token');
});

test('the switch is ONE button, and it names where you are going', async () => {
  // Not two tabs naming where you are. Which side you are on is already obvious
  // from the buttons underneath; a lit tab spends a slot restating it, and two
  // buttons where one will do is how a card gets to twenty-two.
  for (const [side, goes] of [['buy', /Go to Sell/i], ['sell', /Go to Buy/i]]) {
    const first = (await tcard({ side })).kb.inline_keyboard[0];
    assert.equal(first.length, 1, `the switch is ${first.length} buttons`);
    assert.match(first[0].callback_data, /^tok:/, 'the first row is not the side switch');
    assert.match(first[0].text, goes, `on the ${side} side the switch reads "${first[0].text}"`);
    // …and it must actually take you to the OTHER side.
    assert.match(first[0].callback_data, side === 'buy' ? /:s$/ : /:b$/, 'the switch points back at the side you are on');
  }
});

test('splitting the card lost nothing — every action is still reachable', async () => {
  // The failure mode of a redesign: a feature that quietly stops existing.
  const all = new Set([...cbs(await tcard({ side: 'buy' })), ...cbs(await tcard({ side: 'sell' }))]);
  const prefix = (p) => [...all].some((d) => d.startsWith(p));
  for (const p of ['b:', 'bx:', 's:', 'sx:', 'lb:', 'tp:', 'sl:', 'trl:', 'wt:', 'monn:', 'alt:', 'dca:', 'tok:']) {
    assert.ok(prefix(p), `"${p}" is not reachable from either side any more`);
  }
  assert.ok(all.has('menu'), 'the way back to the menu is gone');
});

test('neither side is a wall of buttons any more', async () => {
  for (const side of ['buy', 'sell']) {
    const rows = (await tcard({ side })).kb.inline_keyboard;
    assert.ok(rows.length <= 8, `the ${side} side is ${rows.length} rows`);
    assert.ok(rows.flat().length <= 20, `the ${side} side carries ${rows.flat().length} buttons`);
    for (const r of rows) assert.ok(r.length <= 4, `a row carries ${r.length} buttons`);
  }
});

test('every token-card callback fits Telegram\'s 64-byte limit', async () => {
  // The side switch appends a field to `tok:`, which was already 61 bytes on the
  // longest chain key.
  for (const side of ['buy', 'sell']) {
    for (const d of cbs(await tcard({ side }))) {
      assert.ok(d.length <= 64, `${d} is ${d.length} bytes — Telegram rejects >64`);
    }
  }
});

// ── "no warning" used to mean two opposite things ────────────────────────────
// The card printed a line only for `danger` and `warn`. So a token that PASSED
// the check and a token whose check FAILED — a GoPlus/RugCheck timeout, an
// unindexed mint, a rate limit; tokeninfo.js catches every one of them to null
// — rendered identically: nothing at all. A user who has learned this bot warns
// about honeypots reads that silence as "checked, fine", on the one screen
// where the next tap is Buy.

test("a token that passed the check SAYS it passed", () => {
  const f = JSON.parse(JSON.stringify(FULL));
  f.secLevel = "ok";
  assert.match(plain(render(f)), /Safety check passed/);
});

test("a check that could not be made says so — it does not stay quiet", () => {
  const f = JSON.parse(JSON.stringify(FULL));
  f.sec = null;                 // what tokeninfo.js stores on timeout/failure
  f.secSupported = true;        // …on a chain that DOES support screening
  const out = plain(render(f));
  assert.match(out, /Not checked/);
  assert.match(out, /has NOT been screened/);
  assert.ok(!/Safety check passed/.test(out), 'a failed check is claiming to have passed');
});

test("a chain with no screening says that, rather than nothing", () => {
  const f = JSON.parse(JSON.stringify(FULL));
  f.sec = null;
  f.secSupported = false;
  const out = plain(render(f));
  assert.match(out, /Not checked/);
  assert.match(out, /unavailable on/);
});

test("passed, unchecked and dangerous are three different sentences", () => {
  const mk = (over) => plain(render(Object.assign(JSON.parse(JSON.stringify(FULL)), over)));
  const passed = mk({ secLevel: "ok" });
  const unchecked = mk({ sec: null, secSupported: true });
  const danger = mk({ secLevel: "danger", secRed: ["honeypot (can’t sell)"] });
  assert.notStrictEqual(passed, unchecked, 'a passed check and a failed one render the same');
  assert.notStrictEqual(passed, danger);
  assert.notStrictEqual(unchecked, danger);
});
