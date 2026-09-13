#!/usr/bin/env node
// Payment-config + stranded-funds report.
//
//   node scripts/treasury.js          config only (no network)
//   node scripts/treasury.js --live   also query live balances
//
// Answers the two questions that matter after a payment goes missing:
//   1. Which treasury addresses are actually configured? An unset one makes the
//      sweep a no-op — the funds simply stay in the temp wallet and a single
//      warn line says so.
//   2. Which temp wallets still hold money, and for which order?
//
// Prints addresses and balances only. Private keys are never read here.
const envFiles = require("../src/config/loadEnv").loadEnv();
const { TREASURY, RPC, WALLETS_DIR, WALLET_ENC_KEY } = require("../src/config/constants");
const { familyOf } = require("../src/config/chains");

const LIVE = process.argv.includes("--live");
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

// Family → the chains that pay into it, so an unset treasury names what breaks.
const CHAINS_BY_FAMILY = {};
for (const chain of Object.keys(RPC)) {
  const fam = familyOf(chain);
  if (!fam) continue;
  (CHAINS_BY_FAMILY[fam] = CHAINS_BY_FAMILY[fam] || []).push(chain);
}

const SHAPE = {
  evm: [/^0x[0-9a-fA-F]{40}$/, "0x + 40 hex"],
  solana: [/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "base58, 32–44 chars"],
  tron: [/^T[1-9A-HJ-NP-Za-km-z]{33}$/, "T + 33 base58"],
  ton: [/^[UEk0-9A-Za-z_-]{48}$/, "48-char address"],
};

function reportConfig() {
  console.log("\n── .env actually read ────────────────────────────────────────");
  if (envFiles.length) envFiles.forEach((f) => console.log(`  ${ok("✓")} ${f}`));
  else console.log(`  ${bad("✗")} none found — every value below is a default or from the shell`);

  console.log("\n── Treasury (sweep destinations) ─────────────────────────────");
  let missing = 0;
  for (const [fam, addr] of Object.entries(TREASURY)) {
    const pays = (CHAINS_BY_FAMILY[fam] || []).join(", ") || fam;
    const envVar = `TREASURY_${fam === "solana" ? "SOL" : fam.toUpperCase()}`;
    if (!addr) {
      missing++;
      console.log(`${bad("✗")} ${fam.padEnd(7)} ${bad("NOT SET")} ${dim(`(${envVar}) — sweeps SKIPPED for: ${pays}`)}`);
      continue;
    }
    const [re, shape] = SHAPE[fam] || [null, ""];
    const shapeOk = !re || re.test(addr);
    console.log(
      `${shapeOk ? ok("✓") : bad("!")} ${fam.padEnd(7)} ${addr} ${dim(`(${envVar}) → ${pays}`)}` +
        (shapeOk ? "" : bad(`\n    ↑ does not look like ${shape} — check it before taking payments`)),
    );
  }

  console.log("\n── RPC endpoints ─────────────────────────────────────────────");
  console.log(dim("  (the first is tried first; ONE sweep uses ONE node — whichever answers its"));
  console.log(dim("   opening balance read — so every endpoint listed must be trusted to send)"));
  const rpc = require("../src/config/rpc");
  for (const chain of rpc.RPC_CHAINS) {
    const urls = rpc.rpcUrls(chain);
    const defaults = rpc.DEFAULTS[chain] || [];
    const custom = urls[0] && urls[0] !== defaults[0];
    const spare = urls.length - 1;
    console.log(
      `  ${chain.padEnd(10)} ${urls[0]} ${custom ? ok("(custom)") : dim("(public default — rate-limited)")}` +
        (spare > 0 ? dim(` +${spare} fallback${spare > 1 ? "s" : ""}`) : warn(" — no fallback")),
    );
  }
  console.log(dim("  run `npm run rpc:check` to see which of these actually answer"));

  console.log("\n── Key storage ───────────────────────────────────────────────");
  console.log(`  dir        ${WALLETS_DIR}`);
  console.log(`  at rest    ${WALLET_ENC_KEY ? ok("encrypted (WALLET_ENC_KEY set)") : bad("PLAINTEXT — set WALLET_ENC_KEY")}`);
  return missing;
}

async function reportFunds() {
  const orders = require("../src/payments/orders");
  const wallets = require("../src/payments/wallets");
  const all = orders.allOrders().filter((o) => o.address && !o.adminFree);
  if (!all.length) {
    console.log("\n── Temp wallets ──────────────────────────────────────────────\n  (no orders yet)");
    return;
  }
  console.log(`\n── Temp wallets (${all.length} order(s)${LIVE ? ", live balances" : ", --live for balances"}) ──`);
  let held = 0;
  let noTx = 0;
  for (const o of all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 40)) {
    let balTxt = dim("(not checked)");
    if (LIVE) {
      try {
        const bal = BigInt(await wallets.getBalance(o.chain, o.address));
        if (bal > 0n) held++;
        balTxt = bal > 0n ? bad(`HOLDS ${bal}`) : ok("empty");
      } catch (e) {
        balTxt = bad(`error: ${e.message.slice(0, 60)}`);
      }
    }
    // "swept" must never be printed for a wallet nothing was sent FROM. An
    // order gets marked done either because a sweep landed (there is a tx
    // hash) or because the wallet was found empty — and "found empty" says
    // nothing about where the money went. Conflating the two is how an
    // operator concludes funds reached the treasury when they did not.
    let swept;
    if (o.sweptTx) swept = ok(`swept tx=${o.sweptTx}`);
    else if (o.sweptAt) swept = warn(`closed: ${o.sweptNote || "no tx recorded"}`);
    else if (o.status === "pending") swept = dim("pending");
    else swept = bad("UNSWEPT");
    console.log(`  ${String(o.chain).padEnd(9)} ${o.address}`);
    console.log(`    ${dim(o.id)}  status=${o.status}  ${swept}  ${balTxt}`);
    noTx += o.sweptAt && !o.sweptTx && o.status !== "pending" ? 1 : 0;
  }
  if (LIVE && held) {
    console.log(
      bad(`\n  ${held} wallet(s) still hold funds.`) +
        " sweepRetry re-tries every 6h and 90s after boot;\n  a treasury marked NOT SET above is the usual reason nothing moves.",
    );
  }
  if (noTx) {
    console.log(
      warn(`\n  ${noTx} paid order(s) closed with no sweep transaction.`) +
        "\n  Their wallet was empty when checked — the funds left by some other route\n" +
        "  (a manual transfer, or a sweep from before this was recorded). Confirm on\n" +
        "  an explorer where they actually went; the bot cannot vouch for it.",
    );
  }
}

(async () => {
  const missing = reportConfig();
  await reportFunds();
  console.log("");
  if (missing) console.log(bad(`${missing} treasury address(es) unset — those chains cannot sweep.\n`));
  process.exit(0);
})();
