#!/usr/bin/env node
// GeckoTerminal trades-feed connectivity + schema check for the group buy bot.
//
// WHY THIS SCRIPT EXISTS
// The buy bot posts REAL per-transaction alerts read from
// /networks/{net}/pools/{pool}/trades, and posts NOTHING when that feed cannot
// be read — there is no estimated fallback any more. So a quiet group has two
// completely different explanations, "nobody is buying" and "this server cannot
// read the feed", and from inside the chat they look identical. This script
// tells them apart by asking the live API exactly what the bot asks.
//
//     cd bot && npm run buybot:check
//     cd bot && npm run buybot:check -- solana <token-address>
//
// It makes at most two read-only requests. It reads nothing local, writes
// nothing and signs nothing.
//
// Reading the output:
//   ✅ verified alerts     you are done — alerts will carry tx + buyer links.
//   ⚠️  feed answered, 0    the pool is genuinely quiet, or the token address
//                          does not match either side of the pool's trades
//                          (check you passed the TOKEN address, not the pool).
//   ❌ feed unavailable     the group is getting NO alerts at all. The status
//                          printed tells you whether it is egress (no response),
//                          a rate limit (429) or a bad pool (404).
// One owner for "which .env does this process read" — repo root, then bot/, then
// the cwd, with override. dotenv on its own resolves against the CWD alone, so
// four scripts here quietly disagreed about which file counted.
require("../src/config/loadEnv").loadEnv();

const { BUYBOT_POOL_MIN_MS: POOL_MIN_MS } = require("../src/config/constants");
/** How many distinct pools this deployment polls. null when it cannot be read —
 *  a missing config file is not a reason to fail the check. */
function poolCount() {
  try {
    const groups = require("../src/group/config");
    return new Set(
      groups.active().map((g) => `${g.chain}:${String(g.pairAddress || g.address).toLowerCase()}`),
    ).size;
  } catch (_) {
    return null;
  }
}

const gt = require("../src/group/gtPairs");
const trades = require("../src/group/gtTrades");
const { chainOf, txUrl, accountUrl, shortAddress } = require("../src/config/chains");

// A liquid, permanently-live pool so the default run proves the PATH works even
// if the operator has no group configured yet.
const DEFAULT_CHAIN = "solana";
const DEFAULT_TOKEN = "So11111111111111111111111111111111111111112"; // wrapped SOL

const money = (n) => (n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }));

async function main() {
  const [chainArg, tokenArg] = process.argv.slice(2);
  const chain = chainArg || DEFAULT_CHAIN;
  const token = tokenArg || (chainArg ? null : DEFAULT_TOKEN);

  console.log("Dexvra buy-bot feed check");
  console.log("─".repeat(64));

  if (!token) {
    // ⚠️ NOT PRINTED AS A COMMAND. It needs a chain and a token address, and
    // this script knows neither — so it describes them rather than offering a
    // line with placeholders in it, which is what gets pasted verbatim into a
    // live shell (bash reads `<` and `>` as redirects, and a bracket-less
    // placeholder simply arrives as a literal). Only real values, or no
    // command at all.
    console.log("Run it with two arguments after `npm run buybot:check --`:");
    console.log("  1. a chain key, one of: " + Object.keys(require("../src/config/chains").CHAINS).join(", "));
    console.log("  2. the token's contract address on that chain (0x… on EVM, the mint on Solana)");
    process.exit(2);
  }

  const net = gt.networkOf(chain);
  console.log(`chain        : ${chain}${chainOf(chain) ? ` (${chainOf(chain).label})` : " — UNKNOWN CHAIN"}`);
  console.log(`gecko network: ${net || "— none mapped, the real feed can never run for this chain"}`);
  console.log(`token        : ${token}`);
  console.log("─".repeat(64));

  if (!net) {
    console.log("\n❌ This chain has no geckoNetwork in src/config/chains.js, so the buy bot can never");
    console.log("   read trades for it and will never post. Add the GT network slug to that chain's entry.");
    process.exit(1);
  }

  // 1. Resolve the pool the way the bot does.
  console.log("① resolving the token's deepest pool…");
  const pool = await gt.fetchPool(chain, token);
  if (!pool || !pool.poolAddress) {
    console.log("\n❌ No pool found. Either the token has no liquidity on this chain, or GeckoTerminal");
    console.log("   is unreachable from this server. Nothing else can work until this does.");
    process.exit(1);
  }
  console.log(`   pool     : ${pool.poolAddress}  (via ${pool.source})`);
  console.log(`   price    : ${pool.priceUsd == null ? "—" : "$" + pool.priceUsd}`);
  console.log(`   mcap/liq : ${money(pool.mcap)} / ${money(pool.liquidity)}`);

  // 2. Ask for real trades — the thing that decides whether anything posts.
  console.log("\n② reading the per-transaction trades feed…");
  const buys = await trades.fetchPoolBuys(net, pool.poolAddress, token, { minUsd: 0 });

  if (buys === null) {
    console.log("\n❌ FEED UNAVAILABLE — this pool posts NOTHING until it reads again.");
    console.log("   Nothing is lost: buys from the last 30 minutes still post, with their hashes,");
    console.log("   on the first poll that works. Beyond that they age out silently.");
    console.log(`   GeckoTerminal cooldown armed: ${gt.inCooldown() ? "yes (429 seen — every group is quiet right now)" : "no"}`);
    console.log(`   API key                     : ${gt.hasApiKey() ? "set (Pro base)" : "NOT set — free tier, ~30 req/min for this whole process"}`);
    // The arithmetic that decides whether a key is optional or the only fix.
    const { rpm } = gt.gtPressure();
    const pools = poolCount();
    if (pools != null) {
      const need = (pools * 60000) / POOL_MIN_MS;
      console.log(`   pools tracked               : ${pools} → ~${need.toFixed(1)} trades reads/min needed, ${rpm}/min budgeted`);
      if (need > rpm) {
        console.log(`   ⚠️  DEMAND EXCEEDS BUDGET. Alerts will be late no matter what, because the`);
        console.log(`      requests cannot all fit. Set GECKOTERMINAL_API_KEY, or raise`);
        console.log(`      BUYBOT_POOL_MIN_MS above ${Math.ceil((pools * 60000) / rpm / 1000)}s to fit ${pools} pools in ${rpm}/min.`);
      }
    }
    console.log("\n   What to check, in order:");
    console.log(`   • egress from this server to ${gt.GT_BASE} (curl it)`);
    // Named, not hinted at. "something else" sent an operator looking for a
    // stranger on the IP; it is the website on this same box, its charts have
    // no second source of candles, and the two budgets are meant to add up to
    // GT's ~30/min — `[gt]` in each process's boot log prints both halves.
    console.log("   • the website on this same box also spends this IP's ~30 req/min (grep -F '[gt]' in both logs)");
    console.log("   • GECKOTERMINAL_API_KEY — the real fix if the cooldown keeps arming");
    console.log("   • BUYBOT_POOL_MIN_MS — raise it if you track many pools");
    process.exit(1);
  }

  if (!buys.length) {
    console.log("\n⚠️  The feed ANSWERED but returned no buys of this token in the last 24h.");
    console.log("   That is a healthy result for a quiet pool. If you expected trades, check that");
    console.log("   you passed the TOKEN address (not the pool address) and the right chain.");
    process.exit(0);
  }

  const shown = buys.slice(-5);
  console.log(`\n✅ VERIFIED ALERTS — ${buys.length} buy(s) in the feed. Newest ${shown.length}:\n`);
  for (const b of shown) {
    const when = b.blockTimeMs ? new Date(b.blockTimeMs).toISOString().slice(11, 19) + "Z" : "—";
    console.log(`   ${when}  ${money(b.usd).padStart(12)}  block ${b.blockNumber}  ${b.legs > 1 ? `(${b.legs} legs merged) ` : ""}`);
    console.log(`      tx    ${txUrl(chain, b.txHash) || b.txHash}`);
    console.log(`      buyer ${b.buyer ? accountUrl(chain, b.buyer) || shortAddress(b.buyer) : "—"}`);
  }
  console.log("\n   Every field above appears on the alert card. If the tx link opens the right");
  console.log("   transaction in a block explorer, the buy bot is fully live on this chain.");
}

main().catch((e) => {
  console.error(`\n❌ check failed: ${e && e.message}`);
  process.exit(1);
});
