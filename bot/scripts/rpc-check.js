#!/usr/bin/env node
// Does every configured RPC endpoint actually answer from THIS server?
//
// WHY THIS SCRIPT EXISTS
// A dead RPC does not announce itself. It shows up as a customer who "paid but
// the bot never noticed" and as whale alerts that quietly stop appearing —
// both of which look like a bug in the bot rather than a node having a bad
// afternoon. The endpoints are also public, keyless and shared with the whole
// internet, so the one that worked last month may be rate-limiting your IP
// today.
//
//     cd bot && npm run rpc:check              every chain
//     cd bot && npm run rpc:check -- bsc solana   just these
//
// Read-only: one `eth_chainId` (or `getHealth`/`getNowBlock`) per endpoint.
// No keys are read, nothing is signed, no balance is queried.
//
// Reading the output:
//   ✅            the endpoint answered inside the timeout.
//   ❌ on line 1  the primary is down. Reads fall through to the next endpoint,
//                 so nothing breaks — but a sweep then broadcasts from that
//                 next one, which is why every url you list has to be a node
//                 you trust to SEND, not just to read.
//   ❌ everywhere the bot cannot read that chain at all: payment detection and
//                 whale lookups on it are blind until one comes back.
//   ⚠️  no fallback  a single endpoint means no second opinion. Add one with
//                 RPC_<CHAIN>_URLS=a,b,c.
require("../src/config/loadEnv").loadEnv();

const rpc = require("../src/config/rpc");

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const TIMEOUT_MS = 8000;

// The cheapest "are you alive" call each family answers. All read-only.
function probeFor(chain) {
  // getHealth answers with a JSON-RPC ERROR when the node is unhealthy
  // ("Behind by 4239 slots") — so reading `r.error.message` as the success
  // detail reports a lagging node as green, which is the one thing this probe
  // exists to catch. A healthy node returns exactly "ok".
  if (chain === "solana") return { method: "getHealth", params: [], read: (r) => (r.result === "ok" ? "ok" : null) };
  if (chain === "ton") return { url: (u) => u, method: "getMasterchainInfo", params: {}, read: (r) => (r.ok ? "ok" : null) };
  if (chain === "tron") return { rest: "/wallet/getnowblock", read: (r) => r?.block_header?.raw_data?.number };
  return { method: "eth_chainId", params: [], read: (r) => (r.result ? `chainId ${parseInt(r.result, 16)}` : null) };
}

async function probe(chain, url) {
  const p = probeFor(chain);
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const target = p.rest ? url.replace(/\/+$/, "") + p.rest : url;
    const res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctl.signal,
      body: p.rest ? "{}" : JSON.stringify({ jsonrpc: "2.0", id: 1, method: p.method, params: p.params }),
    });
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, ms, why: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    const detail = body ? p.read(body) : null;
    if (!detail) return { ok: false, ms, why: body?.error?.message || "unreadable response" };
    return { ok: true, ms, detail: String(detail) };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, why: e.name === "AbortError" ? `timeout ${TIMEOUT_MS}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const chains = only.length ? only : rpc.RPC_CHAINS;

  console.log("Dexvra RPC check");
  console.log(dim(`  ${chains.length} chain(s), ${TIMEOUT_MS}ms timeout per endpoint\n`));

  let deadPrimaries = 0;
  let blindChains = 0;

  for (const chain of chains) {
    const urls = rpc.rpcUrls(chain);
    if (!urls.length) {
      console.log(`${bad("✗")} ${chain} ${bad("no endpoint configured")}`);
      blindChains++;
      continue;
    }
    console.log(`${chain}${urls.length === 1 ? warn("  (no fallback)") : ""}`);
    let alive = 0;
    for (let i = 0; i < urls.length; i++) {
      const r = await probe(chain, urls[i]);
      const tag = i === 0 ? dim(" [primary — tried first]") : "";
      if (r.ok) {
        alive++;
        console.log(`  ${ok("✓")} ${urls[i]} ${dim(`${r.ms}ms · ${r.detail}`)}${tag}`);
      } else {
        if (i === 0) deadPrimaries++;
        console.log(`  ${bad("✗")} ${urls[i]} ${bad(r.why)} ${dim(`${r.ms}ms`)}${tag}`);
      }
    }
    if (!alive) {
      blindChains++;
      console.log(`  ${bad("→ every endpoint failed — this chain cannot be read at all")}`);
    }
    console.log("");
  }

  console.log("── Summary ───────────────────────────────────────────────────");
  if (blindChains) console.log(bad(`  ${blindChains} chain(s) unreadable — payment detection and whale lookups are blind there`));
  if (deadPrimaries)
    console.log(
      warn(`  ${deadPrimaries} dead primary — reads fall through, but every listed endpoint`) +
        warn("\n    is then a node a SWEEP may broadcast from. Only list nodes you trust to send."),
    );
  if (!blindChains && !deadPrimaries) console.log(ok("  every primary answered"));
  console.log(dim("  set RPC_<CHAIN>=url (leads, defaults stay as backup)"));
  console.log(dim("  or  RPC_<CHAIN>_URLS=a,b,c (replaces the list entirely)"));

  // Non-zero so a cron/CI caller can act on it. A dead primary alone is a
  // warning; a chain with nothing alive is a failure.
  process.exit(blindChains ? 1 : 0);
}

main().catch((e) => {
  console.error(bad(`rpc:check failed: ${e && e.message}`));
  process.exit(1);
});
