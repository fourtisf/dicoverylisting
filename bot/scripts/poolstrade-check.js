#!/usr/bin/env node
// pools.trade connectivity + schema check.
//
// WHY THIS SCRIPT EXISTS
// pools.trade indexes through Uniswap's launches API, and that request shape is
// not published as a stable public contract. The defaults in src/poolstrade.js
// are our best reading of it, and they may be wrong for your deployment or may
// drift later. Rather than have that show up as "auto-listing quietly finds no
// Robinhood tokens, forever", this script asks the live API the exact question
// the bot asks and shows you what came back.
//
//   cd bot && npm run poolstrade:check
//
// It makes ONE request, reads nothing, writes nothing and signs nothing.
//
// Reading the output:
//   ✅ everything parsed  → you are done, no env vars needed.
//   ⚠️  HTTP ok, 0 parsed → the endpoint answered but we could not find the list
//                           or the address field. The raw sample printed below
//                           tells you which keys it actually uses; set
//                           POOLS_TRADE_LIST_KEY / POOLS_TRADE_BODY to match, or
//                           add the field spelling to `pick()` in poolstrade.js.
//   ❌ HTTP error         → wrong base URL or path. Open pools.trade with the
//                           browser network tab open, find the launches request,
//                           and copy its URL into POOLS_TRADE_API +
//                           POOLS_TRADE_LIST_PATH and its payload into
//                           POOLS_TRADE_BODY.
// One owner for "which .env does this process read" — repo root, then bot/, then
// the cwd, with override. dotenv on its own resolves against the CWD alone, so
// four scripts here quietly disagreed about which file counted.
require("../src/config/loadEnv").loadEnv();

const poolstrade = require("../src/poolstrade");

const BASE = (process.env.POOLS_TRADE_API || "https://interface.gateway.uniswap.org/v2").replace(/\/+$/, "");
const PATH = (process.env.POOLS_TRADE_LIST_PATH || "data.v2.DataApiService/ListLaunches").replace(/^\/+/, "");
const METHOD = process.env.POOLS_TRADE_METHOD || "POST";
const TIMEOUT = Math.max(2000, Number(process.env.POOLS_TRADE_TIMEOUT_MS || 10000) || 10000);

const money = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));

// Keys of an object, one level deep, so an unfamiliar envelope is readable
// without dumping a megabyte of JSON.
function shape(v, depth = 0) {
  if (Array.isArray(v)) return `array(${v.length})${v.length && depth < 1 ? ` of ${shape(v[0], depth + 1)}` : ""}`;
  if (v && typeof v === "object") return `{ ${Object.keys(v).slice(0, 25).join(", ")} }`;
  return typeof v;
}

async function main() {
  console.log("pools.trade check");
  console.log("─".repeat(60));
  console.log(`endpoint : ${METHOD} ${BASE}/${PATH}`);
  console.log(`body     : ${JSON.stringify(poolstrade._test.buildBody(null))}`);
  console.log(`enabled  : ${poolstrade.ENABLED ? "yes" : "no (POOLS_TRADE_ENABLED=0)"}`);
  console.log(`chain    : ${poolstrade.OUR_CHAIN}`);
  console.log("─".repeat(60));

  if (!poolstrade.ENABLED) {
    console.log("\nDisabled by POOLS_TRADE_ENABLED=0 — unset it to use pools.trade.");
    process.exit(0);
  }

  let res;
  try {
    res = await fetch(`${BASE}/${PATH}`, {
      method: METHOD,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(poolstrade._test.buildBody(null)),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (e) {
    console.log(`\n❌ request failed: ${e.message}`);
    console.log("\n   Network unreachable, DNS failure, or a timeout. If the host is right,");
    console.log("   check that this machine can reach it (proxy/firewall) before changing anything.");
    process.exit(1);
  }

  console.log(`\nHTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  if (!res.ok) {
    console.log(`\n❌ the endpoint refused the request.\n`);
    console.log(text.slice(0, 600));
    console.log("\n   → Fix POOLS_TRADE_API / POOLS_TRADE_LIST_PATH / POOLS_TRADE_BODY (see the header of this file).");
    process.exit(1);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    console.log(`\n❌ response is not JSON: ${e.message}`);
    console.log(text.slice(0, 400));
    process.exit(1);
  }

  console.log(`envelope : ${shape(json)}`);
  const rows = poolstrade._test.extractList(json);
  console.log(`rows     : ${rows.length}`);

  if (!rows.length) {
    console.log("\n⚠️  HTTP ok, but no list found in the response.");
    console.log("\n   Raw response (first 1200 chars) — look for the key holding the launches:\n");
    console.log(JSON.stringify(json, null, 2).slice(0, 1200));
    console.log("\n   → Set POOLS_TRADE_LIST_KEY to that key (comma-separated list, first match wins).");
    process.exit(1);
  }

  const parsed = rows.map((r) => poolstrade._test.normalizeLaunch(r)).filter(Boolean);
  console.log(`parsed   : ${parsed.length}/${rows.length}`);

  if (!parsed.length) {
    console.log("\n⚠️  rows found, but none carried a usable contract address.");
    console.log("\n   One raw row — find the field holding the 0x… token address:\n");
    console.log(JSON.stringify(rows[0], null, 2).slice(0, 1200));
    console.log("\n   → Add that field's path to the `address` list in pick() (src/poolstrade.js).");
    process.exit(1);
  }

  // What actually came through, per field. A field that is null on EVERY token
  // is the useful signal here: it means the spelling we look for is wrong, and
  // it is invisible when you only eyeball one sample.
  const fields = ["name", "symbol", "priceUsd", "mcap", "liq", "vol24", "createdAt", "logoUrl", "website", "twitter", "telegram", "graduated"];
  console.log("\ncoverage (non-null across all parsed tokens):");
  const missing = [];
  for (const f of fields) {
    const n = parsed.filter((p) => p[f] != null).length;
    const pct = Math.round((n / parsed.length) * 100);
    const mark = n === 0 ? "✗" : pct >= 50 ? "✓" : "~";
    console.log(`  ${mark} ${f.padEnd(11)} ${String(n).padStart(4)}/${parsed.length}  (${pct}%)`);
    if (n === 0) missing.push(f);
  }

  console.log("\nsample:");
  for (const p of parsed.slice(0, 5)) {
    console.log(`  ${(p.symbol || "?").padEnd(10)} ${(p.name || "").slice(0, 24).padEnd(26)} ${money(p.mcap).padStart(14)}  ${p.address}`);
  }

  // The gates the auto-lister applies. A feed where nothing has a market cap or
  // a liquidity figure will pass this script and still never list anything, so
  // say so here rather than let it look healthy.
  const withMcap = parsed.filter((p) => p.mcap != null && p.mcap > 0).length;
  const withLiq = parsed.filter((p) => p.liq != null && p.liq > 0).length;
  console.log(`\nauto-lister readiness: ${withMcap} priced, ${withLiq} with liquidity`);
  if (!withMcap) {
    console.log("  ⚠️  no token carries a market cap — auto-listing rejects every one of them");
    console.log("     ('no market cap'). Find the mcap field in the raw row and add its path to pick().");
  }
  if (!withLiq) {
    console.log("  ⚠️  no token carries a liquidity figure — the minLiq gate ($25k by default)");
    console.log("     will reject every one. Add the field, or lower minLiq in @dexvraadminbot.");
  }

  if (missing.length) {
    console.log(`\n⚠️  always-null fields: ${missing.join(", ")}`);
    console.log("   Either the API does not return them, or we look for the wrong name.");
    console.log("   Raw row for comparison:\n");
    console.log(JSON.stringify(rows[0], null, 2).slice(0, 1500));
  } else {
    console.log("\n✅ every field parsed — no env overrides needed.");
  }
}

main().catch((e) => {
  console.error(`\n❌ ${e.stack || e.message}`);
  process.exit(1);
});
