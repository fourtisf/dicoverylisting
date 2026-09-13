// "FREE TRENDING TIDAK BEGITU BEKERJA — tidak sesuai dengan minimum yang sudah
// di set" (2026-08-28), with the panel showing `Solana 3/5–8 · BSC 1/5–8 ·
// Ethereum 1 · Base 1 · Robinhood 1 · Tron 3/5–8` and the pinned board
// matching it exactly. Every chain under the floor, and the board carrying
// big established coins — the market filler's own work.
//
// The cause was one `catch {}` in `byGain`. A market read that FAILED — a
// shared-429 from GeckoTerminal, a timeout, a `fetchMarket` that answers null
// because neither reader could be reached — left `_change`, `_mcap` and
// `_vol24` null, which is byte-identical to an indexer ANSWERING that the token
// has no data. Three rules then act on it: `hasReading` refuses the row,
// `rowRefusal` reads the null cap as failing the free-trending floors, and the
// log accuses the operator's own listings of being too small. So the board
// publishes only as many rows as the read happened to answer for, and the one
// line explaining it names the wrong cause.
//
// GT's free tier is ~30 req/min PER IP and this box shares it with the website,
// so losing most of a cycle's reads is ordinary here — which is why this is the
// difference between a board that fills and one stuck at 1.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-trunpriced-"));

const test = require("node:test");
const assert = require("node:assert");

const autoTrend = require("../src/services/autoTrend");
const watch = require("../src/services/trendingWatch");
const market = require("../src/marketdata");

const M = 1_000_000;

/** Stand in for the market reader for one test. */
function stubMarket(t, fn) {
  const real = market.fetchMarket;
  market.fetchMarket = fn;
  t.after(() => (market.fetchMarket = real));
}

const row = (i, over = {}) => ({ chain: "solana", address: `So1${i}`, sym: `T${i}`, status: "approved", ...over });

// ── byGain must record WHY a row has no numbers ─────────────────────────────

test("⚠️ a market read that THREW is marked unread — not as a token with no data", async (t) => {
  stubMarket(t, async () => {
    throw new Error("GeckoTerminal 429 (rate limited)");
  });
  const rows = [row(1), row(2)];
  await autoTrend.byGain(rows, () => 0.5);
  for (const r of rows) {
    assert.strictEqual(r._unread, true, "a failed read looked exactly like an empty token");
    assert.strictEqual(r._change, null);
  }
});

test("⚠️ a fetchMarket that answers NULL is unread too — both readers came up empty", async (t) => {
  stubMarket(t, async () => null);
  const rows = [row(1)];
  await autoTrend.byGain(rows, () => 0.5);
  assert.strictEqual(rows[0]._unread, true);
});

test("a token the indexer ANSWERED about, with no 24h reading, is NOT unread", async (t) => {
  // This is the real "quiet pool" case, and it must keep behaving exactly as it
  // did: refused from the board, and counted honestly.
  stubMarket(t, async () => ({ priceUsd: 0.01, mcap: 5 * M, vol24h: 90_000, change24h: null }));
  const rows = [row(1)];
  await autoTrend.byGain(rows, () => 0.5);
  assert.strictEqual(rows[0]._unread, false);
  assert.strictEqual(rows[0]._change, null);
  assert.strictEqual(rows[0]._mcap, 5 * M, "the cap it DID publish must survive");
});

// ── …and an unread row is not accused of failing a floor ────────────────────

test("⚠️ an unread row is NOT counted as 'below the free-trending floors'", async (t) => {
  stubMarket(t, async () => {
    throw new Error("GeckoTerminal 429 (rate limited)");
  });
  const rows = [row(1), row(2), row(3)];
  const ranked = await autoTrend.byGain(rows, () => 0.5);
  const cfg = { ...autoTrend.DEFAULTS, minMcapUsd: 100_000, minVol24hUsd: 10_000 };
  // A null cap cannot satisfy a floor, so these rows are still refused — that
  // half is right and unchanged. What must not happen is telling the operator
  // their tokens are too small, about tokens nobody could read.
  assert.strictEqual(
    autoTrend.countFloorRefusals(ranked, cfg),
    0,
    "the log would accuse the operator's own listings over an upstream that refused us",
  );
});

test("…while a row that really IS below the floors is still counted", async (t) => {
  stubMarket(t, async () => ({ priceUsd: 0.01, mcap: 40_000, vol24h: 5, change24h: 3 }));
  const rows = [row(1)];
  const ranked = await autoTrend.byGain(rows, () => 0.5);
  const cfg = { ...autoTrend.DEFAULTS, minMcapUsd: 100_000, minVol24hUsd: 10_000 };
  assert.strictEqual(autoTrend.countFloorRefusals(ranked, cfg), 1, "the floors must still do their job");
});

// ── the watch names the upstream, not the operator's settings ───────────────

test("⚠️ the watch reports an unpriceable chain as an UPSTREAM problem", () => {
  const why = watch.diagnose({
    featured: 1,
    floor: 5,
    eligible: 12,
    unread: 12,
    floorRefused: 12, // the floors "refused" them too — but only because of the null cap
    floorsText: "min cap $100K, min vol $10K",
  });
  assert.strictEqual(why.code, "unpriced", `got "${why.code}" — the operator is sent to change a setting`);
  assert.match(why.text, /could not be PRICED/);
  assert.match(why.text, /GECKOTERMINAL_API_KEY/);
});

test("…and a chain whose spares really are too small still says so", () => {
  const why = watch.diagnose({
    featured: 1,
    floor: 5,
    eligible: 12,
    unread: 0,
    floorRefused: 12,
    floorsText: "min cap $100K, min vol $10K",
  });
  assert.strictEqual(why.code, "below_floors");
  assert.match(why.text, /min cap \$100K/);
});

test("a PARTIAL read is not blamed on the upstream — some rows answered", () => {
  // The exemption is deliberately narrow: only where the read failed for every
  // spare is the upstream the answer. Two unread out of twelve is a quota blip,
  // and the chain's real problem is whatever refused the other ten.
  const why = watch.diagnose({
    featured: 1,
    floor: 5,
    eligible: 12,
    unread: 2,
    floorRefused: 10,
    floorsText: "min cap $100K, min vol $10K",
  });
  assert.strictEqual(why.code, "below_floors");
});

// ── "kenapa tidak pakai dexscreener??" — because this pass never asked it ────
//
// The promoter prices up to PROBE_CAP candidates on EVERY configured chain,
// every cycle — six chains is up to 150 reads — and it was GT-first, into a
// ~30 req/min ceiling counted PER IP that this box shares with the website's
// charts. A lost read is a row that does not reach the board, which is the
// whole reported symptom. A PRICE has two free sources; only a CANDLE has one.

const marketdata = require("../src/marketdata");

test("⚠️ the promoter asks DexScreener FIRST, and never reaches GT when it answers", async (t) => {
  let asked = null;
  const real = marketdata.fetchMarket;
  marketdata.fetchMarket = async (chain, address, opts) => {
    asked = opts;
    return { priceUsd: 0.01, mcap: 9 * M, vol24h: 250_000, change24h: 12.5 };
  };
  t.after(() => (marketdata.fetchMarket = real));

  const rows = [row(1)];
  await autoTrend.byGain(rows, () => 0.5);

  assert.ok(asked && asked.cheap === true, "the pass is still GT-first — it spends the shared quota it does not need");
  // It must name every field it actually reads, or DexScreener answers without
  // the 24h change and the promoter reads that as "no reading" and refuses the
  // row — a cheap read that makes the board SHORTER.
  assert.deepStrictEqual(
    [...asked.need].sort(),
    ["change24h", "mcap", "priceUsd", "vol24h"],
    "a field this loop reads is missing from `need`",
  );
  assert.strictEqual(rows[0]._change, 12.5);
  assert.strictEqual(rows[0]._mcap, 9 * M);
  assert.strictEqual(rows[0]._vol24, 250_000);
  assert.strictEqual(rows[0]._unread, false);
});

test("⚠️ 0.00% and $0 volume are READINGS — `need` must not drop them as falsy", async (t) => {
  let asked = null;
  const real = marketdata.fetchMarket;
  marketdata.fetchMarket = async (chain, address, opts) => {
    asked = opts;
    // A pool that traded nothing all day. Every one of these is a real value,
    // and a truthiness test would throw all three away and send the row to GT.
    return { priceUsd: 0.01, mcap: 2 * M, vol24h: 0, change24h: 0 };
  };
  t.after(() => (marketdata.fetchMarket = real));
  const rows = [row(1)];
  await autoTrend.byGain(rows, () => 0.5);
  assert.strictEqual(rows[0]._change, 0, "a measured 0.00% became 'no reading'");
  assert.strictEqual(rows[0]._vol24, 0, "a measured $0 volume became 'no reading'");
  assert.strictEqual(rows[0]._unread, false);
});
