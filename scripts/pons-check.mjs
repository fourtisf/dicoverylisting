// Why does a Pons launch come back with no ticker and no price?
//
// The feed has three layers and they fail independently, but the JSON renders
// all three failures identically as `null`:
//
//   1. the factory's TokenLaunched logs   → token / curve / deployer
//   2. eth_call on the curve and the token → reserves, decimals, symbol, logo
//   3. GeckoTerminal's ETH reference price → every USD figure
//
// A layer-2 failure and a layer-3 failure need completely different fixes (an
// RPC that caps batches, versus a shared GeckoTerminal quota), so this asks
// each one separately and says which it is.
//
// Node 18 on the server, so: plain .mjs, no src/**/*.ts imports — the rule
// logos:check and market:check already follow.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── env ───────────────────────────────────────────────────────────────────
// A standalone script gets none of Next's env loading, and reporting a value
// as unset when we simply never read its file is a diagnostic about nothing —
// so the files actually read are named in the output.
const envFiles = [];
for (const name of [".env", ".env.local"]) {
  const path = join(ROOT, name);
  if (!existsSync(path)) continue;
  envFiles.push(name);
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

// ⚠️ A PORT of src/config/pons.ts, because production runs Node 18 and a check
// script cannot import a .ts module. test-pons.mjs asserts it stays equal —
// a drifted default makes this report a healthy box as broken.
const RPC = (process.env.PONS_RPC_URL || "https://rpc.mainnet.chain.robinhood.com").trim();
const FACTORY = (process.env.PONS_FACTORY || "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e").trim().toLowerCase();
const CHAIN_ID = 4663;
const SITE = (process.env.SITE_ORIGIN || "http://127.0.0.1:3005").replace(/\/+$/, "");
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// Selectors, each verified against its signature. The four well-known ones
// (decimals/totalSupply/symbol/getReserves) are the cross-check that the
// derivation is right.
const SEL = {
  getLaunchedToken: "0x3cf28b5a", // getLaunchedToken(address)
  getReserves: "0x0902f1ac",      // getReserves()
  realQuoteReserve: "0x4f1f58fd", // realQuoteReserve()
  sellableTokens: "0x808bcddc",   // sellableTokens()
  graduated: "0xe7c2b772",        // graduated()
  decimals: "0x313ce567",         // decimals()
  totalSupply: "0x18160ddd",      // totalSupply()
  symbol: "0x95d89b41",           // symbol()
  name: "0x06fdde03",             // name()
  logo: "0xfb7f21eb",             // logo()
};

const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m", b: "\x1b[1m" };
const head = (s) => console.log(`\n${C.b}${s}${C.x}`);
const ok = (s) => console.log(`  ${C.g}✓${C.x} ${s}`);
const bad = (s) => console.log(`  ${C.r}✗${C.x} ${s}`);
const warn = (s) => console.log(`  ${C.y}⚠${C.x} ${s}`);
const note = (s) => console.log(`    ${C.d}${s}${C.x}`);

let broken = 0;

async function rpc(body, timeoutMs = 12000) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const one = (method, params) => rpc({ jsonrpc: "2.0", id: 1, method, params }).then((j) => {
  if (j.error) throw new Error(j.error.message || `rpc error ${j.error.code ?? ""}`);
  return j.result;
});

const ethCall = (to, data) => one("eth_call", [{ to, data }, "latest"]);

const addrArg = (a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const wordAt = (hex, i) => hex.replace(/^0x/, "").slice(i * 64, i * 64 + 64);
const asAddr = (w) => `0x${w.slice(24)}`;
const asNum = (w) => (w ? BigInt(`0x${w}`) : 0n);
function asString(hex) {
  const body = hex.replace(/^0x/, "");
  const off = Number(BigInt(`0x${body.slice(0, 64)}`)) * 2;
  const len = Number(BigInt(`0x${body.slice(off, off + 64)}`));
  if (!Number.isFinite(len) || len <= 0) return "";
  return Buffer.from(body.slice(off + 64, off + 64 + len * 2), "hex").toString("utf8");
}

const why = (err) => String(err?.message || err).slice(0, 140);

// ── 1. Is the chain reachable at all? ─────────────────────────────────────
head("1 · Robinhood Chain RPC");
console.log(`  ${C.d}${RPC}${C.x}`);
console.log(`  ${C.d}env read from: ${envFiles.length ? envFiles.join(", ") : "no .env file in the repo root"}${C.x}`);
let head_ = null;
try {
  const [blk, cid] = await Promise.all([one("eth_blockNumber", []), one("eth_chainId", [])]);
  head_ = Number(BigInt(blk));
  const id = Number(BigInt(cid));
  ok(`answers — head ${head_}, chain id ${id}`);
  if (id !== CHAIN_ID) { bad(`expected chain id ${CHAIN_ID} — this RPC is a different chain`); broken++; }
} catch (e) {
  bad(`unreachable — ${why(e)}`);
  note("everything below depends on this; PONS_RPC_URL in the repo-root .env pins another endpoint");
  process.exit(1);
}

// ── 2. Does it honour BATCHED calls? ──────────────────────────────────────
// The feed asks 9 eth_calls per token in one batch. A node that caps or
// refuses batches is the difference between a full row and a row of nulls.
head("2 · Batched requests (cheap methods)");
let batchOk = false;
try {
  const j = await rpc([
    { jsonrpc: "2.0", id: 0, method: "eth_chainId", params: [] },
    { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
  ]);
  if (Array.isArray(j) && j.length === 2) { batchOk = true; ok("2-call batch honoured"); }
  else { warn(`answered a batch with ${Array.isArray(j) ? `${j.length} item(s)` : "a non-array"} — the app falls back to one call at a time`); }
} catch (e) {
  warn(`batches refused (${why(e)}) — the app falls back to one call at a time`);
}
if (batchOk) {
  // The size that matters is the one the feed actually sends.
  try {
    const big = Array.from({ length: 27 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "eth_chainId", params: [] }));
    const j = await rpc(big);
    if (Array.isArray(j) && j.length === 27) ok("27-call batch honoured (the size one 3-token refresh sends)");
    else { bad(`27-call batch came back with ${Array.isArray(j) ? `${j.length} item(s)` : "a non-array"} — THIS is why metadata is null`); broken++; }
  } catch (e) {
    bad(`27-call batch refused — ${why(e)}`);
    note("lower the batch size, or pin a paid RPC");
    broken++;
  }
}
// ⚠️ eth_chainId TOUCHES NO STATE, and the app batches eth_call. A node can
// honour one and cap the other, so a green mark here proves only that batching
// per se works — section 5 replays the calls the app really sends.
note("this proves batching works at all; section 5 replays the app's own eth_calls");

// ── 3. Which tokens ───────────────────────────────────────────────────────
// No placeholder command anywhere: with no argument this asks the running
// server for the launches it is actually serving, which are real addresses.
head("3 · Launches to inspect");
let tokens = process.argv.slice(2).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
if (tokens.length) {
  ok(`${tokens.length} address(es) given on the command line`);
} else {
  try {
    const r = await fetch(`${SITE}/api/pons/launches?limit=3`, { signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    tokens = (j.items || []).map((i) => i.address).filter(Boolean);
    if (tokens.length) ok(`${tokens.length} from the running server's own feed`);
    else { warn("the server's feed is empty — nothing to inspect"); note(`pass a token address as an argument to inspect one directly`); }
  } catch (e) {
    warn(`could not read ${SITE}/api/pons/launches — ${why(e)}`);
    note("pass a Pons token address as an argument to inspect one directly");
  }
}

// ── 4/5. The two eth_call layers, per token, one call at a time ───────────
// Sequentially and individually, so a single failing call is named rather
// than nulling its whole group the way the app's grouping does.
let metaFailures = 0;
// ⚠️ A 429 FROM THE NODE IS ABOUT THIS BOX, NOT ABOUT THE TOKEN — and this
// check printed it as one ✗ per token, then went on reading, then reported
// "the creator filled nothing in" and "every rung refuses" over the same
// refusal, then a verdict line that called the chain layer healthy. Every
// process on the box shares that node; this check's own serial reads were
// part of the load. So it is named ONCE, the reads stop, and the sections
// below say they could not measure rather than measuring the limit.
let rateLimited = false;
const isRateLimit = (e) => /HTTP 429/.test(why(e));
const replay = []; // exactly what the app batches: {label, to, data}
// What the CONTRACT said, per token — section 6 compares it against what the
// app actually serves for the same token.
const onChain = new Map();
tokenLoop: for (const token of tokens) {
  head(`4 · ${token}`);
  let curve = null;
  try {
    const raw = await ethCall(FACTORY, SEL.getLaunchedToken + addrArg(token));
    const exists = asNum(wordAt(raw, 14)) !== 0n;
    curve = asAddr(wordAt(raw, 1));
    const pair = asAddr(wordAt(raw, 4));
    const tax = Number(asNum(wordAt(raw, 8)));
    if (!exists) { bad("the factory has no launch record for this token"); continue; }
    ok(`launch record — curve ${curve}`);
    note(`pairToken ${pair}${pair === "0x0000000000000000000000000000000000000000" ? " (native ETH)" : " — an ERC-20 quote, so USD figures are skipped by design"}`);
    note(`creator tax ${(tax / 100).toFixed(2)}%`);
  } catch (e) {
    if (isRateLimit(e)) { rateLimited = true; break tokenLoop; }
    bad(`getLaunchedToken failed — ${why(e)}`); broken++; continue;
  }

  const reads = [
    ["curve.getReserves()", curve, SEL.getReserves, (h) => `quote ${asNum(wordAt(h, 0))} · token ${asNum(wordAt(h, 1))}`],
    ["curve.realQuoteReserve()", curve, SEL.realQuoteReserve, (h) => String(asNum(wordAt(h, 0)))],
    ["curve.sellableTokens()", curve, SEL.sellableTokens, (h) => String(asNum(wordAt(h, 0)))],
    ["curve.graduated()", curve, SEL.graduated, (h) => (asNum(wordAt(h, 0)) ? "true" : "false")],
    ["token.decimals()", token, SEL.decimals, (h) => String(asNum(wordAt(h, 0)))],
    ["token.totalSupply()", token, SEL.totalSupply, (h) => String(asNum(wordAt(h, 0)))],
    ["token.symbol()", token, SEL.symbol, asString],
    ["token.name()", token, SEL.name, asString],
    ["token.logo()", token, SEL.logo, (h) => asString(h) || "(empty)"],
  ];
  for (const [label, to, sel, render] of reads) {
    replay.push({ label: `${token.slice(0, 10)}… ${label}`, to, data: sel });
    try {
      const raw = await ethCall(to, sel);
      if (!raw || raw === "0x") { bad(`${label} → empty (the contract has no such function, or reverted)`); metaFailures++; continue; }
      let shown;
      try { shown = render(raw); } catch { shown = `undecodable (${raw.slice(0, 26)}…)`; }
      ok(`${label} → ${shown}`);
      if (label.startsWith("token.")) {
        const field = label.slice(6, -2); // token.symbol() → symbol
        const seen = onChain.get(token) || {};
        seen[field] = shown === "(empty)" ? "" : shown;
        onChain.set(token, seen);
      }
    } catch (e) {
      if (isRateLimit(e)) { rateLimited = true; break tokenLoop; }
      bad(`${label} → ${why(e)}`); metaFailures++;
    }
  }
}
if (rateLimited) {
  head("4 · The node");
  bad("the RPC is rate-limiting this box — HTTP 429 to this check's own reads");
  note("every process on this box shares that node (the site, the bot, the trade bot), and this check just added its own serial reads");
  note("a 429 says nothing about the chain or the app, only about the quota — the reads stopped here rather than spend more of it");
  note("PONS_RPC_URL in the repo-root .env takes a comma-separated list: a host that refuses is parked and the next takes the same calls, so a second node is a line, not a deploy");
  broken++;
}

// ── 5. The SAME calls, batched exactly as the app batches them ────────────
// This is the whole question. Section 4 proves each call answers on its own;
// the app sends all of them as ONE batched eth_call array, and `meta` is null
// unless BOTH decimals and totalSupply come back, `curve` unless all four curve
// reads do. So one call the batch quietly drops nulls a whole group — which is
// exactly what a feed full of nulls over a healthy chain looks like.
head("5 · The app's own reads, batched");
if (rateLimited) {
  note("skipped — the node is rate-limiting; a replay now would measure the limit, not the batch");
} else if (!replay.length) {
  note("no reads to replay");
} else {
  for (const size of [9, replay.length]) {
    if (size > replay.length) continue;
    const slice = replay.slice(0, size);
    let answered = 0;
    const failures = [];
    try {
      const j = await rpc(slice.map((c, i) => ({
        jsonrpc: "2.0", id: i, method: "eth_call", params: [{ to: c.to, data: c.data }, "latest"],
      })), 20000);
      if (!Array.isArray(j)) {
        bad(`batch of ${size} answered with a non-array — the app falls back to one call at a time`);
        note(String(j?.error?.message || JSON.stringify(j)).slice(0, 200));
        continue;
      }
      const byId = new Map(j.map((e, i) => [typeof e?.id === "number" ? e.id : i, e]));
      slice.forEach((c, i) => {
        const e = byId.get(i);
        // ⚠️ "0x" is an ANSWER shaped like a success and decodes to nothing —
        // the app reads it as a failed call, so it is counted as one here.
        if (e && !e.error && e.result && e.result !== "0x") answered++;
        else failures.push(`${c.label} → ${e?.error?.message || (e ? `empty (${e.result ?? "no result"})` : "missing from the response")}`);
      });
      if (failures.length === 0) {
        ok(`batch of ${size} — all ${answered} answered`);
      } else {
        bad(`batch of ${size} — ${answered}/${size} answered, ${failures.length} lost`);
        for (const f of failures.slice(0, 8)) note(f);
        if (failures.length > 8) note(`…and ${failures.length - 8} more`);
        broken++;
      }
    } catch (e) {
      bad(`batch of ${size} refused outright — ${why(e)}`);
      note("the app retries these one at a time, so this alone is survivable");
      broken++;
    }
  }
}

// ── 6. What the APP serves for the same token ─────────────────────────────
// ⚠️ THE SECTIONS ABOVE READ THE CONTRACT, AND THE APP IS WHAT THE BOT AND THE
// SITE ACTUALLY READ. Those are different stacks, and this check has already
// printed a green `token.logo() → ipfs://…` over an app that was discarding it
// — the provider kept only `https://`, so the listing form said `Logo: not set`
// about a token whose artwork is on its own pad page. A guard is only honest
// while it measures the stack the caller uses, so this asks /api/pons for the
// very fields the listing form autofills and names any the app dropped.
head("6 · The listing autofill, as the app serves it");
if (!tokens.length) {
  note("no tokens to compare");
} else {
  for (const token of tokens) {
    const seen = onChain.get(token) || {};
    let launch = null;
    try {
      const r = await fetch(`${SITE}/api/pons?address=${token}`, { signal: AbortSignal.timeout(20000) });
      if (r.status === 404) { warn(`${token.slice(0, 10)}… — the app says this is not a Pons launch`); broken++; continue; }
      if (!r.ok) { bad(`${token.slice(0, 10)}… — /api/pons answered HTTP ${r.status}`); broken++; continue; }
      launch = (await r.json())?.launch || null;
    } catch (e) {
      warn(`could not read ${SITE}/api/pons — ${why(e)}`);
      note("this section says nothing about the app while the server cannot be reached");
      break;
    }
    if (!launch) { bad(`${token.slice(0, 10)}… — /api/pons answered with no launch`); broken++; continue; }

    const socials = launch.socials || {};
    const filled = ["symbol", "name", "logo"].filter((f) => launch[f]).concat(
      Object.keys(socials).filter((k) => socials[k]),
    );
    // ⚠️ THE APP'S OWN READ FAILED — name, symbol and logo are null for the
    // NODE's reason, and "the creator filled nothing in" would be a claim
    // about a person made over a 429. The record says so itself now.
    if (launch.readWhy) {
      bad(`${token.slice(0, 10)}… — the app's own read failed: ${launch.readWhy}`);
      note("that is the node (section 4), not the app — symbol, name and logo are null for OUR reason, not the creator's");
      if (!rateLimited) broken++;
      continue;
    }
    // …and with no contract reads of our own (section 4 did not get that far)
    // there is nothing to compare against: say so, never guess who left the
    // fields blank.
    if (!onChain.has(token)) {
      warn(`${token.slice(0, 10)}… — could not compare: this check's own contract reads did not answer (section 4); the app serves ${filled.join(" · ") || "nothing"} for the form`);
      continue;
    }

    // Only the fields the form fills in. A value the CHAIN did not publish is
    // not a defect — "the creator set no logo" and "the app dropped one" are
    // different facts, and only the second is worth a red mark.
    const dropped = [];
    for (const [field, served] of [["symbol", launch.symbol], ["name", launch.name], ["logo", launch.logo]]) {
      const chain = seen[field];
      // Two different silences, one answer: section 4 could not read the call
      // (undefined — already a red mark up there, and one fault gets one
      // alert), or the creator filled nothing in ("" — not a defect at all).
      // ⚠️ ONE line, not two: `!chain` covers both, and a separate
      // `chain === undefined` guard above it is DEAD — a mutation run kills
      // this line and cannot kill that one, so writing it would be a guard
      // claiming cover it does not provide.
      if (!chain) continue;
      if (served) continue;
      dropped.push(`${field} — the contract publishes ${String(chain).slice(0, 80)}, the app serves nothing`);
    }
    if (dropped.length) {
      bad(`${token.slice(0, 10)}… — the app drops ${dropped.length} field(s) the chain published`);
      for (const d of dropped) note(d);
      broken++;
    } else {
      ok(`${token.slice(0, 10)}… — the form would autofill: ${filled.join(" · ") || "(nothing — the creator filled nothing in)"}`);
    }
  }
}

// ── 7. The USD reference price — AS THE APP READS IT ──────────────────────
// Layer 3, and it fails on its own: every USD figure on the feed is the curve
// price multiplied by this, so a refused reference nulls all of them while the
// chain reads are perfect.
//
// ⚠️ This used to probe GeckoTerminal ALONE and print "every USD figure is
// null while this is refused" over its 429 — true while GT was the app's only
// source, and a check lying in the ALARMING direction the day the app grew a
// ladder (providers/pons/quoteUsd.ts: Coinbase spot → DexScreener's WETH pair →
// GeckoTerminal last). A guard is only honest while it measures the stack the
// caller uses, so the VERDICT comes from the app's own record — `/api/pons`
// says which rung priced ETH, or names every rung that refused — and the
// direct probes below are diagnostics about THIS box's egress, never the
// verdict.
head("7 · The ETH/USD reference, as the app serves it");
{
  let launch = null;
  if (!tokens.length) {
    note("no tokens to read a USD figure for");
  } else {
    try {
      const r = await fetch(`${SITE}/api/pons?address=${tokens[0]}`, { signal: AbortSignal.timeout(20000) });
      if (r.ok) launch = (await r.json())?.launch || null;
      else warn(`/api/pons answered HTTP ${r.status} — section 6 has the details`);
    } catch (e) {
      warn(`could not read ${SITE}/api/pons — ${why(e)}`);
      note("this section says nothing about the app while the server cannot be reached");
    }
  }
  if (launch) {
    const px = Number(launch.priceUsd);
    // ⚠️ FOUR different reasons for a null priceUsd, and the ladder is only
    // ONE of them. The first cut printed the ladder's sentences ("every rung
    // refuses", "GECKOTERMINAL_API_KEY…") under ANY marketWhy — directly above
    // three probes showing every rung answering — over a curve the node had
    // refused to read. The record's own fields say which it is.
    if (px > 0) {
      ok(`${tokens[0].slice(0, 10)}… priced at $${px.toPrecision(4)} — ETH reference from ${launch.quoteUsdSource || "(source not reported — an older build?)"}`);
      note("the ladder is Coinbase spot → DexScreener (WETH) → GeckoTerminal; the first rung that answers wins");
    } else if (launch.readWhy) {
      warn(`no ETH price to convert — the curve could not be read: ${launch.readWhy}`);
      note("that is the node (section 4), not the ETH/USD ladder — the probes below say whether the ladder itself answers from this box");
    } else if (launch.quoteSymbol === null) {
      note("quoted in an ERC-20, not ETH — no USD reference by design");
    } else if (launch.priceQuote === null) {
      // `=== null`, not `== null`: the app serialises priceQuote on every
      // record (a number, or an explicit null when the curve answered no
      // price). A record with NO such field is a build older than the
      // ladder, and that is the last branch — claiming "the curve answered
      // no price" about a record that never carried the field is a claim
      // nobody measured.
      warn("no ETH price to convert — the curve and the pool answered no price; the ladder cannot be judged from this record");
    } else if (launch.marketWhy) {
      bad(`no USD price — ${launch.marketWhy}`);
      note("every USD figure on the feed is null while EVERY rung refuses; the chain reads (and priceQuote, in ETH) are unaffected");
      note("Coinbase and DexScreener are keyless — a box they refuse is an egress fact; GECKOTERMINAL_API_KEY raises only the last rung's ceiling");
      broken++;
    } else {
      warn("the app reports no USD price and no reason — a build older than the ladder");
    }
  }

  // Which rung answers FROM THIS BOX. Whether a keyless host serves a
  // datacenter IP is a property of the server's egress today — measured, not
  // assumed, and never the verdict: the app's own read above is.
  const probes = [
    ["coinbase", async () => {
      const r = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Number((await r.json())?.data?.amount);
    }],
    ["dexscreener", async () => {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/ethereum/${WETH}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const pairs = await r.json();
      return Number((Array.isArray(pairs) ? pairs : []).find((q) => String(q?.baseToken?.address || "").toLowerCase() === WETH.toLowerCase())?.priceUsd);
    }],
    ["geckoterminal", async () => {
      const r = await fetch(`https://api.geckoterminal.com/api/v2/simple/networks/eth/token_price/${WETH}`, { headers: { accept: "application/json;version=20230302" }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 429 ? " — rate limited" : ""}`);
      const prices = (await r.json())?.data?.attributes?.token_prices || {};
      return Number(prices[WETH] ?? prices[WETH.toLowerCase()]);
    }],
  ];
  let answering = 0;
  for (const [name, fn] of probes) {
    try {
      const px = await fn();
      if (px > 0) { answering++; note(`${name} → ETH = $${px.toLocaleString("en-US", { maximumFractionDigits: 2 })}`); }
      else note(`${name} → answered, but with no usable price`);
    } catch (e) {
      note(`${name} → ${why(e)}`);
    }
  }
  // A summary, and never the verdict: which rungs THIS box can reach is an
  // egress fact, and the app's own record above is what the post reads.
  if (answering === probes.length) ok("every rung of the ETH/USD ladder answers from this box");
  else if (answering) warn(`${answering} of ${probes.length} rungs answer from this box`);
  else warn("no rung of the ETH/USD ladder answers from this box — an egress fact, and the reason a curve token would print TBA");
}

// ── Verdict ───────────────────────────────────────────────────────────────
head("Verdict");
try {
  const r = await fetch(`${SITE}/api/tokens`, { signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  if (j.build) console.log(`  ${C.d}serving build ${j.build}${C.x}`);
} catch {}

if (rateLimited) {
  bad("the node rate-limited this box (HTTP 429) — sections 4–7 measured that limit, not the app");
  note("wait a minute and run this again; if it repeats, the box has outgrown the public node — give PONS_RPC_URL a second host");
} else if (metaFailures) {
  bad(`${metaFailures} contract read(s) failed — that is why symbol, name and price are null`);
  broken++;
} else if (tokens.length) {
  ok("every contract read answered individually — the chain layer is healthy");
  note("section 5 is the one that matters: it replays those same calls the way the app sends them");
}
console.log(
  broken
    ? `\n${C.r}Something is broken — the sections above say which layer.${C.x}`
    : `\n${C.g}Every layer answered.${C.x}`,
);
process.exit(broken ? 1 : 0);
