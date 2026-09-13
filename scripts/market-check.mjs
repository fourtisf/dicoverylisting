#!/usr/bin/env node
// market:check — why does a chain's board row have no price?
//
//   npm run market:check                     # every chain, worst one probed
//   npm run market:check -- robinhood        # probe ONE chain against GT
//   BASE_URL=http://127.0.0.1:3005 npm run market:check
//
// Three different failures render identically as "$0 / — on every row of a
// chain", and they need three different fixes:
//
//   1. GeckoTerminal has no data for these tokens  → nothing to configure; the
//      tokens have no indexed pool (fresh launchpad tokens live here)
//   2. GeckoTerminal is refusing/limiting this box → quota; GECKOTERMINAL_API_KEY
//   3. GT answers fine and the SITE still shows 0  → the site's pipeline; read
//      pm2 logs dexvra | grep -F '[market]'  (and '[gt]')
//
// So this drives BOTH halves and says which one broke: the RUNNING SERVER's
// own /api/tokens (what the board actually serves), and then GeckoTerminal
// DIRECTLY with the exact request shape src/lib/providers/geckoterminal.ts
// sends. Whether GT answers is a property of this box's egress today — the
// rule raid:check, launchpads:check, fonts:check and chart:check all state —
// so it has to be measured here, not reasoned about in a sandbox.
//
// Plain Node 18, no src/** imports — production runs 18.19, where importing
// TS from a script simply throws (the logos:check rule).

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3005").replace(/\/+$/, "");
const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const TARGET = (args[0] || "").toLowerCase();

// ⚠️ PORTS of src/config/chains.ts — a check script cannot import TS on the
// production Node. A guard test pins both maps equal to the real ones, because
// a check reading a different network id than the site proves nothing.
const GECKO_NETWORK = {
  solana: "solana", bsc: "bsc", ethereum: "eth", base: "base",
  robinhood: "robinhood", tron: "tron", ton: "ton", sui: "sui-network", plasma: "plasma",
  polygon: "polygon_pos", arbitrum: "arbitrum", optimism: "optimism", avalanche: "avax",
  berachain: "berachain", sonic: "sonic", hyperevm: "hyperevm", abstract: "abstract",
  apechain: "apechain", blast: "blast", sei: "sei-evm", aptos: "aptos", unichain: "unichain",
};
const DEXSCREENER_SLUG = {
  solana: "solana", bsc: "bsc", ethereum: "ethereum", base: "base",
  robinhood: "robinhood", tron: "tron", ton: "ton", sui: "sui", plasma: "plasma",
  polygon: "polygon", arbitrum: "arbitrum", optimism: "optimism", avalanche: "avalanche",
  berachain: "berachain", sonic: "sonic", hyperevm: "hyperevm", abstract: "abstract",
  apechain: "apechain", blast: "blast", sei: "seiv2", aptos: "aptos", unichain: "unichain",
};

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;

async function fetchTokens() {
  // `pm2 restart dexvra && npm run market:check` is the order an operator
  // actually types, and Next takes a few seconds to bind — a check that fails
  // on its own happy path teaches the reader to ignore it.
  const deadline = Date.now() + 30000;
  let lastErr;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/tokens`, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`${BASE}/api/tokens answered ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (Date.now() > deadline) break;
      process.stdout.write("  … waiting for the server to come up\r");
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
  console.error(R(`\ncould not read ${BASE}/api/tokens — ${lastErr?.message || lastErr}`));
  console.error("Is the web app running? BASE_URL= points this check somewhere else.");
  process.exit(2);
}

function priced(t) {
  return t.source === "live" || Number(t.priceUsd) > 0;
}

const payload = await fetchTokens();
console.log(`\nmarket:check — board build ${payload.build || "?"} · live=${payload.live}\n`);

const byChain = new Map();
for (const t of payload.tokens || []) {
  const c = byChain.get(t.chain) || { rows: 0, live: 0, blank: [] };
  c.rows++;
  if (priced(t)) c.live++;
  else c.blank.push(t);
  byChain.set(t.chain, c);
}
if (!byChain.size) { console.error(R("the board served zero tokens — nothing to check")); process.exit(2); }

let worst = null;
for (const [chain, c] of [...byChain.entries()].sort()) {
  const all = c.live === c.rows;
  const none = c.live === 0;
  const mark = all ? G("✓") : none ? R("✗") : Y("~");
  console.log(`${mark} ${chain.padEnd(10)} ${c.live}/${c.rows} priced${none ? "  ← every row is blank" : ""}`);
  if (none && (!worst || c.rows > worst.c.rows)) worst = { chain, c };
}

const target = TARGET ? { chain: TARGET, c: byChain.get(TARGET) } : worst;
if (TARGET && !target.c) { console.error(R(`\nno listings on chain '${TARGET}'`)); process.exit(2); }
if (!target) { console.log(G("\nEvery chain has at least one priced row — nothing to probe.")); process.exit(0); }

const { chain, c } = target;
const net = GECKO_NETWORK[chain];
const dsSlug = DEXSCREENER_SLUG[chain];
console.log(`\n── probing the sources directly for ${chain} ──────────────────`);
if (!net && !dsSlug) {
  console.log(R(`no indexer covers '${chain}' — its rows can only ever carry captured figures`));
  process.exit(1);
}
const rows = (c.blank.length ? c.blank : (payload.tokens || []).filter((t) => t.chain === chain)).slice(0, 10);
const addrs = rows.map((t) => t.address);

/** One source's answer per address: a Map, or null when we COULD NOT ASK.
 *  Those are different facts — the whole reason this repo keeps them apart —
 *  and collapsing them is what made this check report a healthy board as
 *  broken because one probe of one source hit a rate limit. */
async function probe(label, url, parse) {
  if (!url) return { asked: false, why: `no ${label} coverage for this chain`, map: null };
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12000) });
    if (r.status === 429) return { asked: true, why: `${label} answered 429 — over its rate limit from this box`, map: null };
    if (!r.ok) return { asked: true, why: `${label} answered ${r.status}`, map: null };
    return { asked: true, why: "", map: parse(await r.json()) };
  } catch (e) {
    return { asked: true, why: `could not reach ${label} — ${e?.message || e}`, map: null };
  }
}

// The site's own requests, byte for byte (geckoterminal.ts fetchChunk /
// dexscreener.ts fetchDsMarket). A check that asks differently proves nothing.
const [gt, ds] = await Promise.all([
  probe("GeckoTerminal",
    net && `https://api.geckoterminal.com/api/v2/networks/${net}/tokens/multi/${addrs.join(",")}?include=top_pools`,
    (j) => new Map((j.data || []).map((d) => [String(d.attributes?.address || "").toLowerCase(), Number(d.attributes?.price_usd) || 0]))),
  probe("DexScreener",
    dsSlug && `https://api.dexscreener.com/tokens/v1/${dsSlug}/${addrs.join(",")}`,
    (j) => {
      const m = new Map();
      for (const p of Array.isArray(j) ? j : []) {
        const k = p.baseToken?.address?.toLowerCase();   // base side only, as the site does
        if (!k) continue;
        m.set(k, Math.max(m.get(k) || 0, Number(p.priceUsd) || 0));
      }
      return m;
    }),
]);

for (const p of [gt, ds]) if (p.why) console.log(`  ${p.map ? Y("~") : Y("!")} ${p.why}`);
// NEITHER source could be ASKED. That is a fact about this box's egress right
// now, not about the board — which may be serving perfectly from the cache or
// from a cycle that ran a minute ago. Reporting it as a board failure is how a
// check ends up permanently red, which trains the reader to ignore the red.
if (!gt.map && !ds.map) {
  console.log(Y(`\nNeither source could be asked just now, so this run says nothing about the board.`));
  console.log(`The board itself reads ${c.live}/${c.rows} priced on ${chain} — that number is the answer to "is it working".`);
  console.log("Re-run in a minute; if GeckoTerminal keeps answering 429, GECKOTERMINAL_API_KEY in");
  console.log("the repo-root .env is the only thing that raises the ceiling rather than dividing it.");
  process.exit(c.live > 0 ? 0 : 1);
}

let recoverable = 0, nowhere = 0;
for (const t of rows) {
  const k = String(t.address).toLowerCase();
  const g = gt.map?.get(k) || 0;
  const d = ds.map?.get(k) || 0;
  if (g > 0 || d > 0) {
    recoverable++;
    const who = g > 0 && d > 0 ? "GT+DS" : g > 0 ? "GT" : "DS";
    console.log(`  ${G("✓")} ${t.symbol.padEnd(10)} priced RIGHT NOW by ${who} at $${g || d}`);
  } else if (gt.map && ds.map) {
    nowhere++;
    console.log(`  ${R("✗")} ${t.symbol.padEnd(10)} neither source has a priced record — no indexed pool yet`);
  } else {
    console.log(`  ${Y("~")} ${t.symbol.padEnd(10)} not priced by the source(s) we could ask`);
  }
}

console.log("");
if (recoverable > 0) {
  // The one genuine red: a row the board renders blank that a source prices
  // right now. Everything else is the market, or our own egress.
  console.log(R(`${recoverable}/${rows.length} of these are priced by a source RIGHT NOW and the board still shows nothing —`));
  console.log("the fault is on the site's side of the pipe. Read, in this order:");
  console.log("  pm2 logs dexvra --lines 100 --nostream | grep -F '[market]'   ← which provider failed, per chain");
  console.log("  pm2 logs dexvra --lines 100 --nostream | grep -F '[gt]'       ← tier and budget this box runs");
  process.exit(1);
}
if (nowhere === rows.length) {
  console.log(Y(`No source has a priced record for any of these ${rows.length} — the board is honest about them.`));
  console.log("These tokens have no indexed pool yet (a launchpad token lives here until its pool");
  console.log("is created and an indexer picks it up). Their curve-side data can come only from the");
  console.log("launchpad itself: cd bot && npm run poolstrade:check, or the Pons on-chain path.");
  // NOT a failure of the code. A board that draws a dash for a token with no
  // market is the board working — the alternative is inventing a price.
  process.exit(0);
}
console.log(G(`${chain} is serving ${c.live}/${c.rows} priced, and nothing blank here is recoverable from a source we could reach.`));
process.exit(0);
