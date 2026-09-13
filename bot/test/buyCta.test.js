// The three links under every buy alert, and what happens on a token that is
// not on dexvra.io — which is most of them, because the buy bot is free.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-cta-"));

const test = require("node:test");
const assert = require("node:assert");
const mon = require("../src/group/buyMonitor");
const { chartUrl, CHAIN_IDS } = require("../src/config/chains");

const g = (over = {}) => ({
  chatId: "-100", chain: "solana", address: "So1Token", pairAddress: "PooLAddr",
  sym: "RUSS", name: "The Nietzschean Dog", ...over,
});
const pool = { priceUsd: 0.00004823, mcap: 15511897, liquidity: 183475, change24h: 18.42 };
const buy = { txHash: "5xTx", buyer: "AFqu1Maaaaaaaaaaaaaaaaaaaaaaajail", usd: 804.72, tokenAmount: 51874.15 };

/** label → url for every link in a rendered card. */
function links(payload) {
  const out = {};
  for (const e of payload.entities || []) {
    if (e.type === "text_link") out[payload.text.substr(e.offset, e.length)] = e.url;
  }
  return out;
}

test("Trade on Dexvra opens the TRADE BOT already scanning this CA", () => {
  // ?start=ca_<chain>_<address> — the payload tradebot/telegram.js reads to skip
  // straight to the scan instead of asking for an address.
  const l = links(mon.renderRealAlert(g(), buy, pool, null));
  assert.match(l["Trade on Dexvra"], /^https:\/\/t\.me\/[^/?]+\?start=ca_solana_So1Token$/);
});

test("Chart is DexScreener, on the POOL — the pair, not a token search", () => {
  const l = links(mon.renderRealAlert(g(), buy, pool, null));
  assert.strictEqual(l["Chart"], "https://dexscreener.com/solana/PooLAddr");
});

test("a group whose pool hasn't resolved yet still gets a chart", () => {
  const l = links(mon.renderRealAlert(g({ pairAddress: null }), buy, pool, null));
  assert.strictEqual(l["Chart"], "https://dexscreener.com/solana/So1Token", "DexScreener resolves a token too");
});

test("a chain DexScreener does not index never gets a dexscreener link", () => {
  // The slug is deliberately absent for a chain DS has no page for, and the
  // button falls back rather than 404ing. Robinhood carried this test until
  // DexScreener added the chain (~July 2026) — its alerts get a REAL
  // dexscreener chart link now, which is the button working, not a regression.
  assert.strictEqual(chartUrl("no-such-chain", "0xPool"), null);
  assert.strictEqual(chartUrl("robinhood", "0xPool"), "https://dexscreener.com/robinhood/0xPool");
  const l = links(mon.renderRealAlert(g({ chain: "robinhood", address: "0xCA" }), buy, pool, null));
  assert.match(l["Chart"], /dexscreener\.com\/robinhood/, "the chart button must use the page that exists now");
});

test("every chain the bot supports has a chart", () => {
  // The last known exception (robinhood) fell when DexScreener added the
  // chain; a chain reappearing in this list is a missing DEXSCREENER_SLUG row.
  const missing = CHAIN_IDS.filter((c) => !chartUrl(c, "X"));
  assert.deepStrictEqual(missing, [], "a new chain needs a DEXSCREENER_SLUG entry");
});

test("the third link is Dexvra, on the token's own page", () => {
  const l = links(mon.renderRealAlert(g(), buy, pool, null));
  assert.strictEqual(l["Dexvra"], "https://dexvra.io/token/solana/So1Token");
});

// ── A token nobody has listed ────────────────────────────────────────────────

test("the Dexvra link is there whether or not the token is listed", () => {
  // It used to be hidden for an unlisted token, because /token/<chain>/<ca>
  // 404'd — and the buy bot is free and runs on any contract, so that was most
  // of them. The SITE renders a real page for an unlisted contract now (live
  // price, chart, "List Your Token"), so the destination is never dead and the
  // alert has nothing to route around.
  for (const chain of ["solana", "bsc"]) {
    const l = links(mon.renderRealAlert(g({ chain }), buy, pool, null));
    assert.match(l["Dexvra"], new RegExp(`/token/${chain}/`), `${chain}: the link is on the card`);
  }
});

test("the card carries no apology about listing status", () => {
  // The alert reports a buy. Selling the listing is the token page's job, and
  // it does it with the whole page rather than a line squeezed under a CTA row.
  const p = mon.renderRealAlert(g(), buy, pool, null);
  assert.ok(!/isn't listed|not listed|not yet listed/i.test(p.text));
});

test("the token name headlines through the same page, always", () => {
  const l = links(mon.renderRealAlert(g(), buy, pool, null));
  assert.match(l["The Nietzschean Dog"], /dexvra\.io\/token\/solana\/So1Token$/);
});

test("the whale card carries the same three links as the ordinary one", () => {
  const whale = links(mon.renderWhaleAlert(g(), buy, pool, { held: 1e6, holdsUsd: 5e4, position: "+1%" }));
  assert.match(whale["Trade on Dexvra"], /\?start=ca_solana_So1Token$/);
  assert.strictEqual(whale["Chart"], "https://dexscreener.com/solana/PooLAddr");
  assert.match(whale["Dexvra"], /dexvra\.io\/token\/solana\/So1Token$/);
});

test("every alert links the transaction it is reporting", () => {
  // The claim a buy alert makes is "this happened, here is the proof". There is
  // no longer any path that posts one without the proof — the volume estimator
  // that used to is gone, and this is the assertion that keeps it gone.
  for (const [which, card] of Object.entries({
    buy: mon.renderRealAlert(g(), buy, pool, null),
    whale: mon.renderWhaleAlert(g(), buy, pool, { held: 1e6, holdsUsd: 5e4, position: "+1%" }),
  })) {
    assert.ok(links(card).Txn, `${which}: the transaction is linked`);
  }
  assert.strictEqual(typeof mon.renderEstimateAlert, "undefined", "no estimated-alert renderer exists");
  assert.strictEqual(typeof mon.estimateBuys, "undefined", "and nothing to feed one");
});
