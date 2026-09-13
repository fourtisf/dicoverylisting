// listings:fix --keep — FILL the logos, delete nothing.
//
// "tugas anda adalah tambahkan logo project nya cari di beberapa sumber dan
// download" (2026-08-26). The resolver already reaches seven sources; what was
// missing is a way to USE it without the other half of this script, which
// removes every row it could not find artwork for.
//
// The property worth pinning is the destructive one: --keep must delete
// NOTHING, and a flag that spared the logo pass while quietly dropping
// duplicates would be the reassuring reading of its own name. So the test
// drives the real script with a stubbed API and asserts deleteListing is never
// called — a source scan would pass on a version that calls it once.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
const { execFileSync } = require("node:child_process");

const test = require("node:test");
const assert = require("node:assert");

const SCRIPT = path.join(__dirname, "..", "scripts", "fix-listings.js");

/**
 * Run the real script against a fake site and a fake resolver.
 *
 * Both are injected by pre-loading a module that patches the two seams before
 * the script requires them, so the script itself is unmodified — the rule this
 * repo states as "a guard is only honest while it measures the stack that
 * actually runs".
 */
function run(args, { rows, logos = {} }) {
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-fixlist-"));
  const calls = path.join(dir, "calls.json");
  const stub = path.join(dir, "stub.js");
  fss.writeFileSync(
    stub,
    `
const fs = require("node:fs");
const Module = require("node:module");
const CALLS = ${JSON.stringify(calls)};
const ROWS = ${JSON.stringify(rows)};
const LOGOS = ${JSON.stringify(logos)};
const log = [];
const flush = () => fs.writeFileSync(CALLS, JSON.stringify(log));
process.on("exit", flush);
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id.endsWith("/api/dexvra") || id === "../src/api/dexvra") {
    return {
      getListings: async () => ROWS,
      updateListing: async (id, patch) => { log.push({ fn: "update", id, patch }); return {}; },
      deleteListing: async (id) => { log.push({ fn: "delete", id }); return {}; },
    };
  }
  if (id.endsWith("/services/tokenLogo") || id === "../src/services/tokenLogo") {
    return {
      resolveLogo: async (chain, address) => {
        const url = LOGOS[chain + ":" + address] || null;
        // ok:true means every source ANSWERED — the only state in which the
        // script may conclude "this token has no artwork".
        return { ok: true, url, source: url ? "dexscreener" : null, tried: ["dexscreener"], unreachable: [] };
      },
    };
  }
  return orig.apply(this, arguments);
};
`,
  );
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, ["-r", stub, SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, BOT_DATA_DIR: dir, NO_COLOR: "1" },
    });
  } catch (e) {
    stdout = String(e.stdout || "") + String(e.stderr || "");
  }
  const log = fss.existsSync(calls) ? JSON.parse(fss.readFileSync(calls, "utf8")) : [];
  return { stdout, deletes: log.filter((c) => c.fn === "delete"), updates: log.filter((c) => c.fn === "update") };
}

const row = (o) => ({ id: o.id, sym: o.sym, name: o.sym, chain: o.chain, address: o.address, source: "bot", tier: "FREE", trendingRank: null, logoUrl: o.logoUrl ?? "", ...o });

// One that a source has artwork for, one that nothing does, one stablecoin that
// slipped in, and a duplicate pair — every row the script can act on.
const ROWS = [
  row({ id: "1", sym: "HASLOGO", chain: "bsc", address: "0xaaa" }),
  row({ id: "2", sym: "NOLOGO", chain: "bsc", address: "0xbbb" }),
  row({ id: "3", sym: "USDT", chain: "bsc", address: "0xccc" }),
  row({ id: "4", sym: "DUPE", chain: "bsc", address: "0xddd" }),
  row({ id: "5", sym: "DUPE", chain: "bsc", address: "0xeee" }),
];
const LOGOS = { "bsc:0xaaa": "https://dd.dexscreener.com/x.png" };

test("⚠️ --keep deletes NOTHING — not a logo-less row, not a stablecoin, not a duplicate", () => {
  const r = run(["--keep", "--apply"], { rows: ROWS, logos: LOGOS });
  assert.deepStrictEqual(r.deletes, [], `--keep deleted ${r.deletes.length} row(s): ${JSON.stringify(r.deletes)}`);
});

test("…and it still does the job it was run for: the logo is written", () => {
  const r = run(["--keep", "--apply"], { rows: ROWS, logos: LOGOS });
  assert.strictEqual(r.updates.length, 1, `expected one logo write, got ${JSON.stringify(r.updates)}`);
  assert.strictEqual(r.updates[0].id, "1");
  assert.match(r.updates[0].patch.logoUrl, /dexscreener/);
});

test("the rows left without artwork are NAMED, with the address that fixes them", () => {
  const r = run(["--keep", "--apply"], { rows: ROWS, logos: LOGOS });
  // A count alone sends the operator back to the board to work out WHICH.
  assert.match(r.stdout, /still have no artwork anywhere/);
  assert.match(r.stdout, /\$NOLOGO/);
  assert.match(r.stdout, /0xbbb/, "the address is what lets them set one by hand");
  assert.match(r.stdout, /\$USDT/);
  assert.match(r.stdout, /nothing was deleted/i);
});

test("the header says which mode the run is in, before it does anything", () => {
  assert.match(run(["--keep", "--apply"], { rows: ROWS, logos: LOGOS }).stdout, /nothing is deleted/i);
  assert.match(run(["--keep"], { rows: ROWS, logos: LOGOS }).stdout, /nothing would be deleted/i);
});

test("WITHOUT --keep the old behaviour is exactly what still happens", () => {
  // The delete answers an earlier operator request in this script's own header.
  // Reversing it quietly would surprise whoever relies on it, so --keep is an
  // opt-out and this is the test that says so.
  const r = run(["--apply"], { rows: ROWS, logos: LOGOS });
  const ids = r.deletes.map((d) => d.id).sort();
  assert.ok(ids.includes("2"), "the logo-less row is still removed by default");
  assert.ok(ids.includes("3"), "the stablecoin is still removed by default");
  assert.ok(ids.length >= 3, `expected the duplicate too, got ${JSON.stringify(ids)}`);
});

test("a DRY RUN writes nothing, with or without --keep", () => {
  for (const args of [[], ["--keep"]]) {
    const r = run(args, { rows: ROWS, logos: LOGOS });
    assert.deepStrictEqual(r.deletes, [], `dry run deleted something with ${JSON.stringify(args)}`);
    assert.deepStrictEqual(r.updates, [], `dry run wrote something with ${JSON.stringify(args)}`);
  }
});
