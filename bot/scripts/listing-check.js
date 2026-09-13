#!/usr/bin/env node
'use strict';
/*
 * listing:check — is Auto-Listing actually able to publish a free listing right
 * now, and if not, WHICH of the reasons is it?
 *
 * WHY THIS EXISTS. "free listing di admin bot tidak bekerja, sebelumnya
 * bekerja" (2026-08-28) — and there was no way to answer it. Every other
 * subsystem in this repo has an on-box check (`raid:check`, `launchpads:check`,
 * `fonts:check`, `trending:check`, `market:check`, `logos:check`) for the same
 * stated reason: whether a third party answers is a property of the SERVER'S
 * EGRESS today, not of the code, so it has to be measured on the box. The
 * service that publishes free listings had none, and the panel's own scan line
 * rendered a healthy quiet market and a site refusing every single create with
 * byte-identical text.
 *
 * Six questions, in the order the scan itself asks them, because the first NO
 * is the diagnosis:
 *
 *   1  the switch          is it even on
 *   2  the loop            has the scanner reported recently
 *   3  discovery           can this box see the market at all
 *   4  the site (READ)     can it tell what is already listed
 *   5  the site (WRITE)    ⚠️ can it actually create — the step that was invisible
 *   6  the gates           would anything qualify right now
 *
 * Exits non-zero when free listings CANNOT happen, and zero when the service is
 * healthy and the market simply had nothing — a check that is always red trains
 * the reader to ignore the red, which is the state `chart:preview` sat in for
 * weeks.
 */
// ⚠️ .env FIRST, before anything requires config/constants — `constants.js`
// freezes every value at require time, so a script that loads the env
// afterwards reports an unset token on a server where it is set, and the
// failure it invents points the operator at their own .env. `loadEnv()` is the
// one owner of which files that means.
require("../src/config/loadEnv").loadEnv();

const autoLister = require("../src/services/autoLister");
const watch = require("../src/services/listingWatch");
const discovery = require("../src/discovery");
const dsFeeds = require("../src/dexscreener");
const poolstrade = require("../src/poolstrade");
const api = require("../src/api/dexvra");
const { chainOf, CHAINS, DEXSCREENER_SLUG } = require("../src/config/chains");
const build = require("../src/helpers/build");
const { fmtCap } = require("../src/helpers/format");

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
const ok = (s) => console.log(`  ${G}✓${X} ${s}`);
const bad = (s) => console.log(`  ${R}✗${X} ${s}`);
const warn = (s) => console.log(`  ${Y}⚠${X} ${s}`);
const note = (s) => console.log(`    ${D}${s}${X}`);

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const ago = (ms) => (ms < 90_000 ? `${Math.round(ms / 1000)}s ago` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min ago` : `${(ms / 3_600_000).toFixed(1)}h ago`);

/** Reasons free listings cannot happen. Anything pushed here turns the exit
 *  code; a quiet market never does. */
const faults = [];

(async () => {
  const cfg = autoLister.get();
  const now = Date.now();
  console.log(`\n${B}Auto-Listing — can a free listing go out right now?${X}   ${D}build ${build.stamp()}${X}\n`);

  // ── 1 · the switch ────────────────────────────────────────────────────────
  console.log(`${B}1 · The switch${X}`);
  // ⚠️ THE READ COMES FIRST. `DEFAULTS.enabled` is false, so an unreadable
  // config reads as "the operator switched it off" — and this check would then
  // tell them to tap ▶️ Enable, which writes the shipped defaults over the file
  // it could not read. A bad read laundered into a settings wipe, by the very
  // script written to diagnose it.
  const cfgRead = autoLister.configOk();
  if (!cfgRead.ok) {
    bad(`data/autoLister.json cannot be read — ${cfgRead.why}`);
    note(`Your settings are NOT lost, and everything printed below is the SHIPPED DEFAULT, not what you set.`);
    note(`⚠️ Do NOT tap ▶️ Enable until the file is readable: that writes the defaults over it.`);
    faults.push(`data/autoLister.json is unreadable: ${cfgRead.why}`);
  } else if (!cfg.enabled) {
    bad(`Auto Listing is OFF — that is why nothing is being listed.`);
    note(`@dexvraadminbot → 🆓 Auto Listing → ▶️ Enable. Everything below still runs, so one pass answers both questions.`);
    faults.push("the service is switched off");
  } else {
    ok(`Auto Listing is ON`);
  }
  note(
    `trigger ${fmtCap(cfg.minMcap)}–${fmtCap(cfg.maxMcap)} · ignore above ${fmtCap(cfg.maxMcapHard)} · ` +
      `liq ≥ ${fmtCap(cfg.minLiq)} · vol ≥ ${fmtCap(cfg.minVol24)} · age ≥ ${cfg.minAgeHours}h`,
  );
  note(
    `pace ${cfg.paceListings ? `1 every ${autoLister.paceRange(cfg)}` : "OFF"} · max ${cfg.maxPerDay}/day · ` +
      `scans every ${cfg.minGapMin}–${cfg.maxGapMin} min · chains ${cfg.chains.length ? cfg.chains.join(", ") : "all"} · ` +
      `packages ${cfg.pkgs.join(" → ")}`,
  );

  // ── 2 · the loop ──────────────────────────────────────────────────────────
  // A scan report is the ONLY proof the timer chain is alive: the ON switch
  // reads a config file and has never known whether the loop behind it runs.
  console.log(`\n${B}2 · The scan loop${X}`);
  const scan = autoLister.lastScan();
  const stale = 2 * cfg.maxGapMin * 60_000 + 600_000;
  // ⚠️ A HALT CANNOT REACH THE SCAN REPORT — the scan refuses to write the very
  // file the report lives in. Read it first, or this check reports "the loop is
  // not running" about a loop that is running perfectly and points the operator
  // at pm2 logs that prove the opposite.
  const haltNow = autoLister.lastHalt();
  if (haltNow) {
    bad(`halted ${ago(now - haltNow.at)}: ${haltNow.why}`);
    note(`The loop IS running — it is refusing to write rather than lose data.`);
    faults.push(`the scan is halted: ${haltNow.why}`);
  } else if (!scan) {
    bad(`the scanner has never filed a report`);
    note(`If dexvra-bot has been up more than ~${cfg.maxGapMin} min the service did not start.`);
    note(`pm2 logs dexvra-bot --lines 200 --nostream | grep -F '[monitoring]'`);
    faults.push("the scan loop has never reported");
  } else if (now - scan.at > stale) {
    bad(`last report ${ago(now - scan.at)} — it should run every ${cfg.minGapMin}–${cfg.maxGapMin} min. The loop has stopped.`);
    faults.push("the scan loop has stopped");
  } else {
    ok(`last scan ${ago(now - scan.at)}: ${autoLister.scanLine(scan)}`);
    if (scan.blocker) faults.push(`the last scan was blocked: ${scan.blocker}`);
  }
  // The pace clock and the daily cap, read from the SAME function the scan
  // gates on — a check that computed its own version of the rule would
  // eventually disagree with the rule it is checking.
  const p = autoLister.pace(cfg);
  const stats = autoLister.stats(now);
  if (cfg.paceListings) {
    if (p.skewed) warn(`the stored pace clock reads in the FUTURE and was discarded — a listing is due now`);
    else if (p.waitMs > 0) note(`pace: next free listing due in ${autoLister.fmtGap(p.waitMs / 60_000)} (this wait: ${autoLister.fmtGap(p.gapMs / 60_000)})`);
    else note(`pace: due now${p.lastAt ? "" : " — no listing on the clock yet"}`);
  }
  if (stats.today >= cfg.maxPerDay) warn(`today's cap is reached (${stats.today}/${cfg.maxPerDay}) — nothing more today, by your setting`);
  else note(`today: ${stats.today}/${cfg.maxPerDay} · listed all-time ${stats.total} · never-relist ledger ${stats.everListed} contracts`);

  // ── 3 · discovery ─────────────────────────────────────────────────────────
  // Whether these hosts answer is a property of THIS box's egress. Each source
  // is asked separately, because "DexScreener is blocked" and "pools.trade is
  // blocked" are different problems and the merged list renders them the same.
  console.log(`\n${B}3 · Discovery — can this box see the market?${X}`);
  // Per feed, with the reason — the whole point of the `X` shapes. All three
  // DexScreener feeds live on ONE host, so a single refusal takes them together
  // and "0 candidates" alone reads as a quiet market.
  const short = (u) => u.replace("https://api.dexscreener.com/", "");
  const dsAns = await dsFeeds.fetchDiscoveryX().catch((e) => ({ items: [], ok: false, why: e.message, feeds: [] }));
  for (const f of dsAns.feeds || []) {
    if (!f.ok) bad(`${short(f.url)} → ${f.why}`);
    else (f.n ? ok : warn)(`${short(f.url)} → ${f.n} candidate(s)`);
  }
  if (!(dsAns.feeds || []).length && !dsAns.ok) bad(`DexScreener feeds → ${dsAns.why}`);
  // ⚠️ DexScreener supplies almost every listable candidate, so it being down
  // while pools.trade still answers is NOT a healthy scan — and the merged list
  // being non-empty is exactly what used to hide it.
  if (!dsAns.ok) {
    bad(`DexScreener answered none of its feeds — that is where the $1M+ projects come from`);
    faults.push(`DexScreener discovery is unreachable: ${dsAns.why}`);
    if (dsFeeds.benched()) note(dsFeeds.benched());
  }
  let candidates = [];
  let sources = [];
  try {
    const d = await discovery.fetchDiscoveryX();
    candidates = d.items || [];
    sources = d.sources || [];
    for (const src of sources) {
      if (src.name === "dexscreener") continue; // already reported per feed above
      if (!src.ok) {
        bad(`${src.name} → ${src.why}`);
        // ⚠️ RED, BUT NOT FATAL — AND IT HAS TO SAY WHY. A ✗ over a green
        // verdict is a mixed signal the reader has to decode, which is how a
        // check stops being read. pools.trade supplies PRE-MIGRATION launches:
        // a bonding-curve token has no pool, so it fails minLiq / minVol24 /
        // minAgeHours by definition and could never have been free-listed
        // anyway. DexScreener carries the chain now, so what this costs is
        // visibility of launches before they graduate — not listings.
        if (src.name === "poolstrade") {
          note(`Costs pre-migration Robinhood launches only — those fail your liquidity/volume/age gates anyway,`);
          note(`and DexScreener indexes the chain now. Not why free listings would stop. \`npm run poolstrade:check\` digs in.`);
        } else {
          faults.push(`${src.name} discovery is unreachable: ${src.why}`);
        }
      }
      // A source that ANSWERED with nothing is a quiet launchpad, and says so
      // rather than wearing the same ⚠ as one that could not be reached.
      else if (!src.n) note(`${src.name} → answered, 0 candidate(s) (nothing new launched)`);
      else ok(`${src.name} → ${src.n} candidate(s)`);
    }
  } catch (e) {
    bad(`merged discovery threw: ${e.message}`);
  }
  if (!candidates.length) {
    const down = sources.filter((x) => !x.ok);
    bad(
      down.length
        ? `no candidates — ${[...new Set(down.map((x) => `${x.name}: ${x.why}`))].join(" · ")}`
        : `no candidates, and every source answered — the feeds really are empty right now`,
    );
    faults.push("discovery returned no candidates");
  } else {
    ok(`${candidates.length} candidate(s) merged across sources`);
    // ⚠️ A candidate on a chain `chainOf()` cannot resolve never reaches the
    // pricing step, and until the scan report grew `unsupported` it did not
    // even get counted — one whole network invisible, silently. Sei is the
    // chain that was: DexScreener spells it `seiv2`.
    const unmapped = candidates.filter((c) => !chainOf(c.chain));
    if (unmapped.length) {
      bad(`${unmapped.length} candidate(s) are on a chain this bot cannot resolve: ${[...new Set(unmapped.map((c) => c.chain))].join(", ")}`);
      faults.push("discovery returned candidates on unresolvable chains");
    }
    const byChain = {};
    for (const c of candidates) byChain[c.chain] = (byChain[c.chain] || 0) + 1;
    note(
      Object.entries(byChain)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([c, n]) => `${c} ${n}`)
        .join(" · "),
    );
    if (cfg.chains.length) {
      const inScope = candidates.filter((c) => autoLister.chainAllowed(cfg, c.chain)).length;
      (inScope ? ok : bad)(`${inScope} of them are inside your 🌐 chain scope (${cfg.chains.join(", ")})`);
      if (!inScope) faults.push("no candidate is on a chain inside your scope");
    }
  }
  // The slug map has ONE owner (config/chains.js). This is the assertion, not a
  // second copy of it: a check that carried its own map would print green over
  // exactly the disagreement it exists to catch.
  const drift = Object.keys(CHAINS).filter((c) => dsFeeds.DS_CHAIN[c] !== (DEXSCREENER_SLUG[c] || c));
  if (drift.length) {
    bad(`the DexScreener slug map has drifted for: ${drift.join(", ")}`);
    faults.push("the DexScreener slug map has two owners again");
  }

  // ── 4 · the site, reading ─────────────────────────────────────────────────
  console.log(`\n${B}4 · The site — reading what is already listed${X}`);
  let rows = null;
  try {
    rows = (await api.getListings()) || [];
    ok(`/api/internal/listings → ${rows.length} listing(s)`);
  } catch (e) {
    bad(`could not read the listings API: ${e.message}`);
    if (/INTERNAL_API_TOKEN/.test(e.message)) {
      // Naming the files that WERE read is the whole diagnosis: "not set" over a
      // list containing bot/.env is a missing line in that file; "not set" over
      // an empty list is a script that read no .env at all.
      const envFiles = require("../src/config/loadEnv").loadEnv();
      note(`.env read: ${envFiles.length ? envFiles.join(", ") : "NONE — no .env at the repo root, in bot/, or here"}`);
    }
    note(`Without this list the scan bails rather than risk double-listing a paying customer's token.`);
    faults.push(`the site's listings API is unreachable: ${e.message}`);
  }

  // ── 5 · the site, WRITING ─────────────────────────────────────────────────
  //
  // ⚠️ THE STEP THAT WAS INVISIBLE. A create that the site refuses used to be
  // one log.warn and a `continue` — no counter, no reason on the panel, no
  // blocker — so a rotated token, a moved base URL, a payload the validator now
  // rejects and a 500 all rendered as "40 candidates · 40 priced · 0 listed".
  //
  // Probed with a payload that CANNOT create anything: the route authorises
  // first and then hands the body to `buildRow`, which refuses an empty chain
  // outright. So a 400 proves the write path is reachable AND authorised, which
  // is exactly the fact that had no way of being known.
  console.log(`\n${B}5 · The site — can it actually CREATE a listing?${X}`);
  // ONE OWNER, shared with 🔎 Test scan on the panel — a check that asked this
  // its own way would eventually disagree with the button beside it, which is
  // how `fonts:check` came to print nine green ticks over a broken banner.
  const write = await api.canCreate().catch((e) => ({ ok: false, status: null, why: e.message }));
  if (write.ok) {
    ok(`write path reachable and authorised (the site refused a deliberately empty payload: 400)`);
  } else {
    bad(write.why);
    if (write.status === 401 || write.status === 403) {
      note(`INTERNAL_API_TOKEN in bot/.env must equal the one the web app reads from the repo-root .env.`);
    }
    faults.push(write.why);
  }

  // ── 6 · the gates ─────────────────────────────────────────────────────────
  // The same read-only pass 🔎 Test scan runs, driven through the SERVICE'S own
  // dryRun rather than re-implemented here — the guard has to measure the stack
  // the scan actually uses.
  if (!has("--no-scan") && candidates.length && rows) {
    console.log(`\n${B}6 · The gates — would anything qualify right now?${X}`);
    let r;
    try {
      r = await autoLister.dryRun({ now });
    } catch (e) {
      bad(`the test scan threw: ${e.message}`);
      faults.push(`the test scan threw: ${e.message}`);
    }
    if (r) {
      if (r.blocker) {
        bad(r.blocker);
        faults.push(r.blocker);
      } else {
        const qual = (r.qualified || []).length;
        (qual ? ok : warn)(
          `${r.priced} priced${r.sampled ? " (a sample — more candidates remain)" : ""} · ` +
            `${qual} would be listed · ${r.known} already known${r.cooled ? ` · ${r.cooled} on cool-off` : ""}` +
            `${r.offChain ? ` · ${r.offChain} outside scope` : ""}`,
        );
        for (const q of (r.qualified || []).slice(0, 5)) note(`would list $${q.sym || q.address} on ${q.chain} at ${fmtCap(q.mcap)}`);
        const why = Object.entries(r.reasons || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
        for (const [text, n] of why) note(`${text} ×${n}`);
        // NOT a fault. "Nothing qualifies in this sample" is the service working
        // correctly in a quiet market, and failing on it is how a check becomes
        // permanently red and therefore useless.
        if (!qual) note(`Nothing in this sample clears your gates. That is the market, not a fault — lower 🎯/💧/📊 to widen it.`);
      }
    }
  } else if (has("--no-scan")) {
    console.log(`\n${B}6 · The gates${X}`);
    note(`skipped (--no-scan)`);
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log("");
  if (!faults.length) {
    console.log(`${G}Free listings can go out: the loop is alive, the market is visible, and the site takes writes.${X}`);
    console.log(`  ${D}The bot pages the ops channel by itself when nothing is published for ${Math.round(watch.GRACE_MS / 3_600_000)}h — services/listingWatch.js.${X}\n`);
    process.exit(0);
  }
  console.log(`${R}Free listings cannot go out. ${faults.length} blocking reason(s):${X}`);
  for (const f of faults) console.log(`  ${R}·${X} ${f}`);
  console.log(`  ${D}The bot pages the ops channel by itself when nothing is published for ${Math.round(watch.GRACE_MS / 3_600_000)}h — services/listingWatch.js.${X}\n`);
  process.exit(1);
})().catch((e) => {
  console.error(`listing:check failed: ${e.stack || e.message}`);
  process.exit(1);
});
