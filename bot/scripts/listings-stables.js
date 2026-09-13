#!/usr/bin/env node
/*
 * REMOVE THE STABLECOINS AND WRAPPERS ALREADY ON THE SITE.
 *
 * "jangan pernah listing stable coin jika sudah terlanjur hapus smua stable
 * coin yang listing". The first half is `createFromInfo`, which now refuses
 * them at the one door every listing goes through. This is the second half:
 * the rows listed BEFORE that gate existed are still on the site, and no gate
 * can reach backwards.
 *
 * ⚠️ IT DELETES, SO IT SHOWS FIRST. Dry run is the default and `--apply` is the
 * only thing that removes anything — the `listings:fix` contract, and it
 * matters more here because a listing is gone for good and the site is public.
 *
 * ⚠️ AND IT PRINTS THE TIER. `FREE` is the tier the bot books itself and
 * nobody can buy; anything else was PAID FOR. The instruction was "all", so
 * `--apply` removes all of them — but a paid row can never leave without being
 * named on screen first, because that one is somebody's money and a refund
 * conversation, not a tidy-up.
 */
// ⚠️ ORDER, not presence: loadEnv() runs BEFORE any repo require, because
// config/constants.js freezes every value at require time — a script that
// reads an empty environment reports it as a fact about the server.
require("../src/config/loadEnv").loadEnv();
const api = require("../src/api/dexvra");
const { notAProject } = require("../src/services/bigCoins");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const build = () => {
  try {
    return require("node:child_process").execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

// The site's own field names, and BOTH spellings: the bot writes `sym`, and a
// row that came in through the public form or an older shape may carry
// `symbol`. Reading one only is how half the roster reads as clean.
const symOf = (r) => String(r.sym ?? r.symbol ?? "");
const nameOf = (r) => String(r.name ?? "");

(async () => {
  console.log(`\nListed stablecoins & wrappers — build ${build()}\n`);
  let rows;
  try {
    rows = await api.getListings();
  } catch (err) {
    console.error(`✗ could not read the listings API: ${err?.message ?? err}`);
    console.error("  INTERNAL_API_TOKEN and SITE_URL are read from the repo's .env files;");
    console.error("  this must run on the box, where those exist.");
    process.exit(1);
  }
  if (!Array.isArray(rows)) {
    console.error("✗ the listings API did not answer with a list");
    process.exit(1);
  }

  const hits = rows.filter((r) => notAProject(symOf(r), nameOf(r)));
  console.log(`${rows.length} listing(s) read · ${hits.length} match the money rule\n`);
  if (hits.length === 0) {
    console.log("Nothing to remove — the board carries no stablecoins or wrappers.\n");
    return;
  }

  const paid = hits.filter((r) => String(r.tier || "").toUpperCase() !== "FREE");
  if (paid.length)
    console.log(
      `⚠️  ${paid.length} of these is a PAID tier — somebody bought that listing.\n` +
        "   It is included below because the instruction was to remove all of them.\n" +
        "   Read the tier column before running --apply.\n",
    );

  for (const r of hits) {
    const tier = String(r.tier || "?").toUpperCase();
    console.log(
      `  ${tier === "FREE" ? " " : "⚠"} ${tier.padEnd(9)} ${String(r.chain || "?").padEnd(10)} ` +
        `$${symOf(r).padEnd(10)} ${nameOf(r).slice(0, 28).padEnd(28)} ${r.status || ""} ${r.id || ""}`,
    );
  }
  console.log("");

  if (!APPLY) {
    console.log("Dry run — nothing was deleted. Re-run with --apply to remove them:");
    console.log("  npm run listings:nostables -- --apply\n");
    return;
  }

  let gone = 0;
  const failed = [];
  for (const r of hits) {
    try {
      const res = await api.deleteListing(r.id);
      // ⚠️ A CALL THAT RETURNED IS NOT A ROW THAT WENT. The route answers
      // `{deleted:false}` for an id it does not hold, and counting that as a
      // deletion is how a report says 7 removed over a board that still has 7.
      if (res && res.deleted === false) failed.push(`$${symOf(r)} — the site does not hold that id`);
      else gone++;
    } catch (err) {
      failed.push(`$${symOf(r)} — ${err?.message ?? err}`);
    }
  }
  console.log(`Removed ${gone} of ${hits.length}.`);
  for (const f of failed) console.log(`  ✗ ${f}`);
  console.log(
    "\nThey will not come back: `createFromInfo` refuses them at the one door\n" +
      "every listing goes through (the scan, the board filler and the seeder).\n",
  );
  if (failed.length) process.exit(1);
})().catch((err) => {
  console.error("✗ " + (err?.stack || err));
  process.exit(1);
});
