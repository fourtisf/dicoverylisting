#!/usr/bin/env node
// launchpads:check — which launchpad APIs answer FROM THIS BOX, and what a
// listing would autofill from them.
//
// Whether a launchpad answers is a property of this server's egress today, not
// of the code: these hosts block datacenter IP ranges, retire endpoints without
// notice, and none of the request shapes is a published contract. A unit test
// asserts what we believe; this asserts what is true right now on the machine
// that has to make the call — the same reason `raid:check` and
// `poolstrade:check` exist.
//
//   npm run launchpads:check                        # every pad's feed
//   npm run launchpads:check -- <address> [chain]   # one token, pad by pad
//
// The trade bot has its own copy of this against the SAME registry
// (tradebot: npm run launchpads:check). Both are worth running: the two
// processes can sit behind different egress if the operator ever splits them.
require("../src/config/loadEnv").loadEnv(); // NB: requiring it loads nothing — the call is the point.

const lp = require("../../shared/launchpads");
const launchpads = require("../src/launchpads");

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const D = (s) => `\x1b[2m${s}\x1b[0m`;

const money = (n) => (n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 8 : 2 }));
const age = (ms) => (ms ? Math.round((Date.now() - ms) / 60000) + "m ago" : "—");

function padHeader(p) {
  const flags = [];
  if (!p.enabled) flags.push(Y("disabled"));
  if (!p.verified) flags.push(D("shape unverified"));
  return `${p.key.padEnd(10)} ${p.label}${flags.length ? "  (" + flags.join(", ") + ")" : ""}`;
}

async function checkFeeds() {
  console.log("\n── new-launch feeds ──────────────────────────────────────────\n");
  const byChain = {};
  for (const p of lp.enabled()) for (const c of p.chains) (byChain[c] = byChain[c] || []).push(p);
  if (!Object.keys(byChain).length) { console.log(R("  every pad is disabled — check LAUNCHPADS / LAUNCHPAD_<PAD>")); return false; }
  let any = false;
  // Named explicitly, because a pad with no feed endpoint cannot be probed
  // without an address and would otherwise be silently absent from this
  // report — which reads as "not configured" rather than "not checkable here".
  const noFeed = lp.enabled().filter((p) => !p.feedPath);
  if (noFeed.length) {
    console.log(D(`  ${noFeed.map((p) => p.key).join(", ")}: no launches feed — pass an address to check ${noFeed.length > 1 ? "them" : "it"}\n`));
  }
  for (const [chain, pads] of Object.entries(byChain)) {
    const withFeed = pads.filter((p) => p.feedPath);
    if (!withFeed.length) continue;
    // `force` so this measures the HOST rather than our own circuit breaker —
    // a check that reports its own local state back at you proves nothing.
    const r = await lp.newLaunches(chain, 5, { only: withFeed.map((p) => p.key), force: true });
    for (const p of withFeed) {
      const res = r.byPad[p.key] || { ok: false, why: "not run", items: [] };
      any = any || res.ok;
      if (!res.ok) { console.log(`  ${R("✗")} ${padHeader(p)}\n      ${R(res.why)}`); continue; }
      console.log(`  ${G("✓")} ${padHeader(p)}`);
      console.log(D(`      ${res.items.length} launches via ${lp.padBase(p.key) || "?"}`));
      for (const it of res.items.slice(0, 3)) {
        const curve = it.progressPct != null ? `${it.progressPct.toFixed(0)}% (${it.progressSource})` : it.graduated ? "graduated" : "phase unknown";
        console.log(D(`      · $${it.symbol || "??"}  ${it.address}  ${money(it.mcapUsd)}  ${curve}  ${age(it.createdAt)}`));
      }
    }
  }
  return any;
}

async function checkToken(address, chain) {
  console.log(`\n── ${address} on ${chain} ─────────────────────────────────\n`);
  const pads = lp.padsFor(chain);
  if (!pads.length) { console.log(R(`  no enabled pad covers ${chain}`)); return false; }
  const r = await lp.tokenRecord(chain, address);
  for (const t of r.tried) {
    const p = pads.find((x) => x.key === t.pad) || { key: t.pad, label: t.pad, enabled: true, verified: true };
    const mark = t.skipped ? Y("•") : t.found ? G("✓") : t.ok ? D("·") : R("✗");
    const note = t.skipped
      ? Y(t.why)
      : t.found
        ? G("knows it")
        : t.ok
          ? D(t.status === 404 ? "answered: never heard of it" : "answered, no record")
          : R(t.why);
    console.log(`  ${mark} ${padHeader(p)}\n      ${note}`);
  }
  if (!r.record) {
    console.log(`\n  ${r.ok ? Y("No pad knows this token — normal for anything that migrated a while ago.") : R("No pad answered — a network/host problem, not a token problem.")}`);
    if (!r.ok) console.log(`  ${R(r.why)}`);
    return r.ok;
  }
  // The listing form's own view: this is exactly what autofill would put in it.
  const info = await launchpads.fetchTokenInfo(chain, address);
  console.log("\n  " + G("what listing autofill would prefill") + "\n");
  const row = (k, v) => console.log(`    ${k.padEnd(12)} ${v === null || v === undefined || v === "" || v === 0 ? D("—") : v}`);
  row("name", info.name);
  row("ticker", info.symbol);
  row("logo", info.logoUrl);
  row("website", info.website);
  row("X", info.twitter);
  row("telegram", info.telegram);
  row("overview", info.description ? info.description.slice(0, 60) + "…" : null);
  row("market cap", money(info.mcap));
  row("liquidity", money(info.liq));
  row("launchpad", info.launchpad);
  row("phase", info.onCurve === true
    ? `bonding · ${info.progressPct != null ? info.progressPct.toFixed(1) + "%" : "?"} (${info.progressSource || "?"})`
    : info.graduated === true ? "graduated" : Y("unknown — no pad said"));
  row("from", info.source);
  if (r.record.progressDisagreement) console.log(`\n  ${Y("pads disagree on progress: " + r.record.progressDisagreement)}`);
  return true;
}

(async () => {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  console.log("\nDexvra — launchpad APIs, measured from this box\n");
  console.log(D("pads: " + (lp.all().map((p) => p.key + (p.enabled ? "" : "(off)")).join(", ") || "none")));

  let ok;
  if (args.length) {
    const address = args[0];
    const chain = args[1] || (/^0x[a-fA-F0-9]{40}$/.test(address) ? "bsc" : "solana");
    ok = await checkToken(address, chain);
  } else {
    ok = await checkFeeds();
    console.log(D("\n  (pass a mint or contract address to see what a listing would autofill)"));
  }

  console.log(`
${D("A pad failing above is almost always config rather than code — every host and")}
${D("path is overridable, so a launchpad that moved costs a line in .env and a")}
${D("restart, not a deploy:")}

    LAUNCHPADS=0                     ${D("turn the whole registry off")}
    LAUNCHPAD_<PAD>=0                ${D("turn one pad off (blank/absent = on)")}
    LAUNCHPAD_<PAD>_API=<base>       ${D("pin one host and skip the base list")}
    LAUNCHPAD_<PAD>_TOKEN_PATH=…     ${D("per-token path, {id} placeholder")}
    LAUNCHPAD_<PAD>_FEED_PATH=…      ${D("new-launches path, {n} placeholder")}

${D("<PAD> is the key in the left column. Restart with --update-env, or the new")}
${D("value is not read. Both bot processes share this registry, so restart via")}
${D("the ecosystem file: pm2 restart ecosystem.config.js --update-env")}
`);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(R("check crashed: " + ((e && e.stack) || e)));
  process.exit(1);
});
