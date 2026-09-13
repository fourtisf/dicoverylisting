// EVERY FREE LISTING IS REPORTED TO THE VISITOR CHANNEL.
//
// "setiap free listing harus ada kirim laporan di channel dexvra visitor, bawah
// free listing yang jelas". Until now a free listing left no trace an operator
// could read: `announce()` only fires when 📣 Post to channel is ON *and* the
// package is the one that reaches @dexvraio, so `free` and `xpress` auto
// listings — the great majority — went live with nothing but a pm2 line.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-flr-"));

const test = require("node:test");
const assert = require("node:assert");
const log = require("../src/helpers/logger");
const api = require("../src/api/dexvra");
const al = require("../src/services/autoLister");

const INFO = {
  symbol: "GOODCOIN", name: "Good Coin", mcap: 2_400_000, liq: 180_000, vol24: 95_000,
  priceUsd: 0.0024, pairCreatedAt: Date.now() - 5 * 3600_000,
};

// ⚠️ A UNIQUE ADDRESS PER SCAN. `everListed` is the permanent ledger that stops
// a token being listed twice, so a second scan reusing the first one's address
// lists nothing and the assertion fails for a reason that has nothing to do
// with what it covers.
let seq = 0;
async function scanOnce({ pkgs = ["free"], postChannel = false } = {}) {
  const addr = `So1111${seq++}`;
  const reports = [];
  const realReport = log.report;
  const realCreate = api.createListing;
  const realList = api.getListings;
  log.report = (h) => reports.push(String(h));
  api.getListings = async () => [];
  api.createListing = async (input) => ({ ...input, id: "l_1" });
  try {
    await al.set({
      enabled: true, pkgs, postChannel, paceListings: false,
      maxPerRun: 1, maxPerDay: 12, minMcap: 1_000_000, maxMcap: 100_000_000,
      minLiq: 1000, minVol24: 1000, minAgeHours: 0, chains: ["solana"],
    });
    await al.runOnce({
      tg: null,
      deps: {
        fetchDiscovery: async () => [{ chain: "solana", address: addr, symbol: "GOODCOIN" }],
        fetchTokenInfo: async () => INFO,
      },
    });
  } finally {
    log.report = realReport;
    api.createListing = realCreate;
    api.getListings = realList;
  }
  return { reports, addr };
}

test("a free listing sends a clear report to the visitor channel", async () => {
  const { reports, addr } = await scanOnce();
  const r = reports.find((x) => /FREE LISTING/.test(x));
  assert.ok(r, `no free-listing report was sent: ${JSON.stringify(reports)}`);
  // It must be readable WITHOUT opening the site — that is the state it
  // replaces. Ticker, name, chain, what it was worth, and where to look.
  for (const bit of ["GOODCOIN", "Good Coin", "Solana", "dexvra.io", addr]) {
    assert.ok(r.includes(bit), `the report does not say ${bit}:\n${r}`);
  }
  assert.match(r, /\$2\.40M/, `the market cap is missing or unformatted:\n${r}`);
});

test("⚠️ it is sent even with 📣 Post to channel OFF", async () => {
  // The whole gap. `announce()` is gated on that switch and on the package;
  // this is a report to the OPERATOR, not a public post, so neither gate
  // applies — an operator who turned the public post off did not ask to stop
  // being told what their own bot listed.
  const off = await scanOnce({ postChannel: false });
  assert.ok(off.reports.some((x) => /FREE LISTING/.test(x)), "no report with the channel post off");
  const on = await scanOnce({ postChannel: true });
  assert.ok(on.reports.some((x) => /FREE LISTING/.test(x)), "no report with the channel post on");
});

test("⚠️ a visitor channel that is down never costs the listing", async () => {
  // The report runs AFTER the row is live. A throw here used to be able to
  // unwind the scan, which would turn a successful listing into a failed one.
  const realReport = log.report;
  const realCreate = api.createListing;
  const realList = api.getListings;
  const created = [];
  log.report = () => { throw new Error("channel unreachable"); };
  api.getListings = async () => [];
  api.createListing = async (input) => (created.push(input.sym), { ...input, id: "l_2" });
  try {
    await al.set({
      enabled: true, pkgs: ["free"], postChannel: false, paceListings: false,
      maxPerRun: 1, maxPerDay: 12, minMcap: 1_000_000, maxMcap: 100_000_000,
      minLiq: 1000, minVol24: 1000, minAgeHours: 0, chains: ["solana"],
    });
    const n = await al.runOnce({
      tg: null,
      deps: {
        fetchDiscovery: async () => [{ chain: "solana", address: "So2222", symbol: "GOODCOIN" }],
        fetchTokenInfo: async () => INFO,
      },
    });
    assert.strictEqual(n, 1, "the listing was lost because the report threw");
    assert.deepStrictEqual(created, ["GOODCOIN"]);
  } finally {
    log.report = realReport;
    api.createListing = realCreate;
    api.getListings = realList;
  }
});
