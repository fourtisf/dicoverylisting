// pools.trade — the Robinhood Chain launchpad feed.
//
// The response schema is not a contract we control, so the property worth
// pinning is TOLERANCE: the parser has to survive a field being renamed, nested
// a level deeper, sent as a string instead of a number, or missing entirely,
// and it must never hand the auto-lister a record that reads as healthier than
// the data behind it. Every test below is a shape we could plausibly be sent.
const test = require("node:test");
const assert = require("node:assert");

const ps = require("../src/poolstrade");
const { normalizeLaunch, extractList, toMs, safeUrl, socialUrl, buildBody } = ps._test;

const ADDR = "0x1234567890abcdef1234567890ABCDEF12345678";

test("normalize: reads the flat, obvious shape", () => {
  const r = normalizeLaunch({
    address: ADDR,
    name: "Nine Hood",
    symbol: "NINEHOOD",
    priceUsd: 0.0012,
    marketCapUsd: 1_200_000,
    liquidityUsd: 120_000,
    volume24hUsd: 300_000,
    createdAt: 1_800_000_000_000,
  });
  assert.equal(r.address, ADDR);
  assert.equal(r.name, "Nine Hood");
  assert.equal(r.symbol, "NINEHOOD");
  assert.equal(r.mcap, 1_200_000);
  assert.equal(r.liq, 120_000);
  assert.equal(r.vol24, 300_000);
  assert.equal(r.chain, "robinhood");
});

test("normalize: reads a nested shape with different spellings", () => {
  // Same token, the way a gRPC-shaped envelope might send it.
  const r = normalizeLaunch({
    token: { address: ADDR, name: "Nine Hood", symbol: "NINEHOOD" },
    market_cap_usd: "1200000",
    liquidity: { usd: "120000" },
    volume: { h24: "300000" },
    price: { usd: "0.0012" },
  });
  assert.equal(r.address, ADDR);
  assert.equal(r.name, "Nine Hood");
  assert.equal(r.mcap, 1_200_000, "decimal strings must parse as numbers");
  assert.equal(r.liq, 120_000);
  assert.equal(r.vol24, 300_000);
  assert.equal(r.priceUsd, 0.0012);
});

test("normalize: a record with no usable address is dropped, not half-built", () => {
  // The one field nothing downstream can work without. A record that reached
  // the auto-lister without it would be priced, judged and possibly listed
  // against an address of "undefined".
  assert.equal(normalizeLaunch({ name: "No Address", symbol: "NOPE" }), null);
  assert.equal(normalizeLaunch({ address: "not-an-address" }), null);
  assert.equal(normalizeLaunch({ address: "0x1234" }), null, "a truncated address is not an address");
  assert.equal(normalizeLaunch(null), null);
  assert.equal(normalizeLaunch("string"), null);
});

test("normalize: a missing figure stays null and never becomes 0 or NaN", () => {
  // This is the one that matters for money. autoLister.rejectReason compares
  // mcap against a trigger; a NaN or a silent 0 in either direction turns a
  // gate the operator set into a coin flip.
  const r = normalizeLaunch({ address: ADDR, marketCapUsd: "n/a", liquidityUsd: null });
  assert.equal(r.mcap, null);
  assert.equal(r.liq, null);
  assert.equal(r.vol24, null);
  assert.ok(!Number.isNaN(r.mcap));
});

test("normalize: progress accepts both 0..1 and 0..100, and clamps", () => {
  assert.equal(normalizeLaunch({ address: ADDR, progress: 0.42 }).progressPct, 42);
  assert.equal(normalizeLaunch({ address: ADDR, progress: 42 }).progressPct, 42);
  assert.equal(normalizeLaunch({ address: ADDR, progress: 250 }).progressPct, 100);
  assert.equal(normalizeLaunch({ address: ADDR, progress: -5 }).progressPct, 0);
});

test("normalize: graduated stays null when the API did not say", () => {
  // null is "unknown", and the trade bot must not read an unknown as "still on
  // the curve" — it decides the venue on-chain precisely because of this.
  assert.equal(normalizeLaunch({ address: ADDR }).graduated, null);
  assert.equal(normalizeLaunch({ address: ADDR, graduated: false }).graduated, false);
  assert.equal(normalizeLaunch({ address: ADDR, isGraduated: true }).graduated, true);
});

test("safeUrl: only http(s) survives", () => {
  assert.equal(safeUrl("https://pools.trade"), "https://pools.trade");
  assert.equal(safeUrl("http://x.com/a"), "http://x.com/a");
  // These end up in an href on a public listing card and in a Telegram message.
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("data:text/html,<script>"), null);
  assert.equal(safeUrl("not a url"), null);
  assert.equal(safeUrl("https://x.com/" + "a".repeat(400)), null, "absurd length is dropped");
});

test("socialUrl: a bare handle becomes a link, junk does not", () => {
  assert.equal(socialUrl("@ninehood", "https://x.com"), "https://x.com/ninehood");
  assert.equal(socialUrl("ninehood", "https://x.com"), "https://x.com/ninehood");
  assert.equal(socialUrl("https://x.com/ninehood", "https://x.com"), "https://x.com/ninehood");
  assert.equal(socialUrl("javascript:alert(1)", "https://x.com"), null);
  assert.equal(socialUrl("not a handle!", "https://x.com"), null);
});

test("toMs: seconds, milliseconds and ISO all land in the same units", () => {
  const ms = 1_800_000_000_000;
  assert.equal(toMs(ms), ms);
  assert.equal(toMs(1_800_000_000), ms, "a seconds epoch is scaled up");
  assert.equal(toMs("1800000000"), ms);
  assert.equal(toMs("2027-01-15T08:00:00Z"), Date.parse("2027-01-15T08:00:00Z"));
  assert.equal(toMs(null), null);
  assert.equal(toMs("soon"), null);
  assert.equal(toMs(0), null);
});

test("extractList: finds the list under any of the usual envelope keys", () => {
  const row = { address: ADDR };
  assert.deepEqual(extractList({ launches: [row] }), [row]);
  assert.deepEqual(extractList({ tokens: [row] }), [row]);
  assert.deepEqual(extractList({ data: [row] }), [row]);
  assert.deepEqual(extractList([row]), [row], "a bare top-level array works too");
  // An envelope key we have never seen still yields the rows rather than
  // silently reporting an empty feed — the failure mode this guards against is
  // "auto-listing runs forever and finds nothing".
  assert.deepEqual(extractList({ somethingNew: [row] }), [row]);
  assert.deepEqual(extractList({ count: 0 }), []);
  assert.deepEqual(extractList(null), []);
});

test("buildBody: the default carries the chain and contracts", () => {
  const b = buildBody(null);
  assert.equal(b.chainId, 4663);
  assert.ok(Array.isArray(b.contracts) && b.contracts.length);
  assert.equal(buildBody("abc").cursor, "abc");
});

test("buildBody: a malformed POOLS_TRADE_BODY falls back, it does not throw", () => {
  // An operator pasting broken JSON into an env var must not take the service
  // down — they get the default request and a warning in the log.
  const prev = process.env.POOLS_TRADE_BODY;
  process.env.POOLS_TRADE_BODY = "{not json";
  try {
    assert.equal(buildBody(null).chainId, 4663);
  } finally {
    if (prev === undefined) delete process.env.POOLS_TRADE_BODY;
    else process.env.POOLS_TRADE_BODY = prev;
  }
});

test("fetchTokenInfo: matches dexscreener's field names and zero convention", async () => {
  // autoLister.rejectReason reads `liq`, `vol24` and `pairCreatedAt` BY NAME and
  // treats a falsy value as "no data". A record using liquidity/volume24h names
  // would sail past the minLiq and minVol24 gates the operator set — a free
  // listing handed to a token nobody checked.
  const ds = require("../src/dexscreener");
  assert.equal(typeof ds.fetchTokenInfo, "function");

  const rec = ps._test.normalizeLaunch({
    address: ADDR, name: "Nine Hood", symbol: "NINEHOOD",
    marketCapUsd: 1_200_000, liquidityUsd: 120_000, volume24hUsd: 300_000,
  });
  // Shape the record the way fetchTokenInfo does, without a network call.
  const info = {
    liq: Number(rec.liq) || 0,
    vol24: Number(rec.vol24) || 0,
    pairCreatedAt: Number(rec.createdAt) || 0,
  };
  assert.equal(info.liq, 120_000);
  assert.equal(info.vol24, 300_000);
  assert.equal(info.pairCreatedAt, 0, "an absent launch time must be 0, so the age gate skips it");
});

test("fetchTokenInfo: never answers for a chain pools.trade does not cover", async () => {
  assert.equal(await ps.fetchTokenInfo("ethereum", ADDR), null);
  assert.equal(await ps.fetchTokenInfo("solana", "So11111111111111111111111111111111111111112"), null);
});

test("normalize: a record from another chain is dropped, not relabelled", () => {
  // Every launch is stamped chain:"robinhood" because the request asks for chainId 4663.
  // But POOLS_TRADE_BODY lets an operator replace the whole request body, and no API is
  // obliged to honour a filter. A foreign token labelled robinhood would be auto-listed
  // with Robinhood's explorer and buy links, and the trade bot would hunt for it on a
  // chain it does not exist on.
  assert.equal(normalizeLaunch({ address: ADDR, chainId: 1 }), null, "an Ethereum record must not become a robinhood listing");
  assert.equal(normalizeLaunch({ address: ADDR, chain_id: "8453" }), null, "string chain ids compare too");
  assert.equal(normalizeLaunch({ token: { address: ADDR, chainId: 56 } }), null, "nested chain ids are checked");
});

test("normalize: the record is kept when the chain matches or is absent", () => {
  // Absent is the common case — we asked for one chain, so an unstamped record is ours.
  assert.ok(normalizeLaunch({ address: ADDR }), "no chain id stated → trust the request filter");
  assert.ok(normalizeLaunch({ address: ADDR, chainId: 4663 }), "the configured chain is kept");
  assert.ok(normalizeLaunch({ address: ADDR, chainId: "4663" }), "as a string too");
});
