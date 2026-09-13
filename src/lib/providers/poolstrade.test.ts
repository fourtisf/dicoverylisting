import test from "node:test";
import assert from "node:assert";

import { extractList, launchToMarket, normalizeLaunch, type PoolsLaunch } from "./poolstrade.ts";

// The response schema is not a contract we control, so what matters is that the
// parser tolerates a field being renamed, nested deeper or sent as a string —
// and that when it does NOT understand something, it says null rather than
// inventing a number the board will render as fact.

const ADDR = "0x1234567890abcdef1234567890ABCDEF12345678";

const launch = (over: Partial<PoolsLaunch> = {}): PoolsLaunch => ({
  chain: "robinhood",
  address: ADDR,
  name: "Nine Hood",
  symbol: "NINEHOOD",
  logoUrl: null,
  priceUsd: 0.0012,
  mcap: 1_200_000,
  liq: 120_000,
  vol24h: 300_000,
  chg24h: 12,
  holders: null,
  createdAt: null,
  graduated: false,
  progressPct: 40,
  website: null,
  twitter: null,
  telegram: null,
  launchUrl: `https://pools.trade/token/${ADDR}`,
  ...over,
});

test("normalizeLaunch reads the flat shape", () => {
  const r = normalizeLaunch({
    address: ADDR,
    name: "Nine Hood",
    symbol: "NINEHOOD",
    priceUsd: 0.0012,
    marketCapUsd: 1_200_000,
    liquidityUsd: 120_000,
  });
  assert.equal(r?.address, ADDR);
  assert.equal(r?.mcap, 1_200_000);
  assert.equal(r?.chain, "robinhood");
});

test("normalizeLaunch reads a nested shape with string numbers", () => {
  const r = normalizeLaunch({
    token: { address: ADDR, name: "Nine Hood", symbol: "NINEHOOD" },
    market_cap_usd: "1200000",
    liquidity: { usd: "120000" },
    price: { usd: "0.0012" },
  });
  assert.equal(r?.address, ADDR);
  assert.equal(r?.name, "Nine Hood");
  assert.equal(r?.mcap, 1_200_000);
  assert.equal(r?.priceUsd, 0.0012);
});

test("normalizeLaunch drops a record with no usable address", () => {
  assert.equal(normalizeLaunch({ name: "no address" }), null);
  assert.equal(normalizeLaunch({ address: "0x123" }), null);
  assert.equal(normalizeLaunch(null), null);
});

test("normalizeLaunch never turns an unparseable figure into 0 or NaN", () => {
  const r = normalizeLaunch({ address: ADDR, marketCapUsd: "n/a" });
  assert.equal(r?.mcap, null);
  assert.ok(!Number.isNaN(r?.mcap as number));
});

test("normalizeLaunch rejects non-http links", () => {
  // These would land in an href on a public page.
  const r = normalizeLaunch({ address: ADDR, website: "javascript:alert(1)", twitter: "@ninehood" });
  assert.equal(r?.website, null);
  assert.equal(r?.twitter, "https://x.com/ninehood");
});

test("extractList finds the rows under a key we have never seen", () => {
  const row = { address: ADDR };
  assert.deepEqual(extractList({ launches: [row] }), [row]);
  assert.deepEqual(extractList([row]), [row]);
  assert.deepEqual(extractList({ brandNewKey: [row] }), [row]);
  assert.deepEqual(extractList({ total: 0 }), []);
});

test("launchToMarket claims movement only for the period the launchpad reports", () => {
  // The launchpad gives one 24h window; GeckoTerminal gives 5m/1h/6h/24h.
  // Copying the 24h figure into the shorter periods would feed the score and
  // the movers board a number nothing measured.
  const m = launchToMarket(launch({ chg24h: 12, vol24h: 300_000 }));
  assert.ok(m);
  assert.equal(m.chg["24h"], 12);
  assert.equal(m.chg["5m"], 0);
  assert.equal(m.chg["1h"], 0);
  assert.equal(m.chg["6h"], 0);
  assert.equal(m.vol["24h"], 300_000);
  assert.equal(m.vol["5m"], 0);
  assert.deepEqual(m.txns["24h"], { buys: 0, sells: 0 }, "no txn split is reported, so none is claimed");
});

test("launchToMarket returns null without a price, so the listing keeps its fallback figures", () => {
  assert.equal(launchToMarket(launch({ priceUsd: null })), null);
  assert.equal(launchToMarket(launch({ priceUsd: 0 })), null);
});

test("launchToMarket reports no pool address while a token is on its curve", () => {
  // The chart embed is keyed on a pool address. A token still bonding has no
  // pool, and a wrong one renders someone else's chart.
  assert.equal(launchToMarket(launch())?.poolAddress, null);
});

test("launchToMarket derives age from the launch time", () => {
  const m = launchToMarket(launch({ createdAt: Date.now() - 90 * 60_000 }));
  assert.ok(m?.ageMinutes != null && Math.abs(m.ageMinutes - 90) <= 1);
  assert.equal(launchToMarket(launch({ createdAt: null }))?.ageMinutes, null);
});

test("normalizeLaunch drops a record that names another chain", () => {
  // It would render on the public board with the wrong chain badge and buy deeplink.
  assert.equal(normalizeLaunch({ address: ADDR, chainId: 1 }), null);
  assert.equal(normalizeLaunch({ address: ADDR, chain_id: "8453" }), null);
  assert.ok(normalizeLaunch({ address: ADDR, chainId: 4663 }));
  assert.ok(normalizeLaunch({ address: ADDR }), "absent chain id → trust the request filter");
});
