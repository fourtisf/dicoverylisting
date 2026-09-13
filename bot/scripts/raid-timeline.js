#!/usr/bin/env node
// Dexvra Raid: can THIS server see a given X account's posts?
//
// WHY THIS EXISTS
// Auto-raid fails silently by nature: a watcher that works and a watcher that
// cannot see anything both produce the same thing in a group — nothing. And the
// answer is not a property of the code, it is a property of this machine's
// egress today AND of X's decision about that ACCOUNT: X serves logged-out
// profile timelines selectively, so two public accounts read from one IP can
// give different answers. That is why this probes a CONTROL account as well —
// "X is unreachable from this box" and "X won't serve THIS account" need to come
// back as different verdicts rather than one shrug.
//
//     cd bot && npm run raid:timeline -- @yourproject
//
// Read-only: it fetches public timelines and nothing else.
// One owner for "which .env does this process read" — repo root, then bot/, then
// the cwd, with override. dotenv on its own resolves against the CWD alone, so
// four scripts here quietly disagreed about which file counted.
require("../src/config/loadEnv").loadEnv();

const xTimeline = require("../src/raid/xTimeline");
const xGuestTimeline = require("../src/raid/xGuestTimeline");

const CONTROL = "X"; // @X — public, permanent, and served to everyone
const line = () => console.log("─".repeat(64));

async function probe(handle) {
  const started = Date.now();
  const res = await xTimeline.fetchLatestPosts(handle);
  const ms = Date.now() - started;
  if (res.ok) {
    const newest = res.posts[0];
    console.log(`   @${handle.padEnd(20)} ✅ ${String(res.posts.length).padStart(2)} post(s) via ${res.source} (${ms}ms)`);
    if (newest) console.log(`   ${"".padEnd(22)}    newest ${newest.id} — "${newest.text.slice(0, 40).replace(/\n/g, " ")}"`);
    // A readable answer with nothing in it is a DIFFERENT state, and the one
    // most often misread as "the bot is broken".
    if (!res.posts.length) {
      console.log(
        `   ${"".padEnd(22)}    ${res.raw > 0 ? "the account has only been reposting" : "X served an EMPTY timeline for this account"}`,
      );
    }
    return res;
  }
  console.log(`   @${handle.padEnd(20)} ❌ ${res.gone ? "gone" : "failed"} — ${res.error} (${ms}ms)`);
  return res;
}

async function main() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));
  const handle = xTimeline.parseHandle(arg || "");
  console.log("\nDexvra Raid — can this server see an account's posts?");
  line();
  if (arg && !handle) {
    console.log(`"${arg}" doesn't look like an X account. Pass @handle or a profile link.`);
    process.exit(1);
  }
  console.log(`guest GraphQL : ${xGuestTimeline.isEnabled() ? "on" : "off (RAID_GUEST_METRICS=0 in .env)"}`);
  console.log(`X_BEARER_TOKEN: ${xTimeline.apiToken() ? "set — hidden accounts are readable" : "not set"}`);
  console.log(`sources tried : ${xTimeline.sourceOrder().map((s) => s.name).join(" → ")}`);
  line();

  console.log("\nReads:\n");
  const control = await probe(CONTROL);
  const target = handle ? await probe(handle) : null;
  line();

  if (!handle) {
    console.log("\nPass an account to test yours:  npm run raid:timeline -- @yourproject");
    process.exit(control.ok ? 0 : 1);
  }

  if (target.ok && target.posts.length) {
    console.log("\n✅ Auto-raid can watch this account from this server.");
    process.exit(0);
  }

  // The verdict has to AGREE with the advice under it. A footer that recommends
  // the free sources while the finding is "X won't serve this account to anyone
  // logged out" teaches an operator to believe neither half.
  console.log("\n⚠️  Auto-raid will NOT spot new posts by this account from this server.");
  if (control.ok && !target.ok) {
    console.log("\n   X answers this box fine — it is refusing THIS ACCOUNT to logged-out readers.");
    console.log("   The one route that still sees it is a paid X_BEARER_TOKEN. No flag switches it on,");
    console.log("   and no free source gets past it — that is an authorization decision about the account.");
  } else if (control.ok && target.ok && !target.posts.length) {
    console.log("\n   X answered, with an empty timeline. Either the account only reposts (auto-raid");
    console.log("   is for ORIGINAL posts) or X is hiding it from logged-out readers — set X_BEARER_TOKEN");
    console.log("   to tell those apart.");
  } else {
    console.log("\n   The control account failed too, so this is this SERVER's access, not the account.");
    if (xTimeline.isOnCooldown()) {
      console.log("   Every source is cooling down right now — re-run in ~2min before concluding anything.");
    }
    console.log("   Check egress to api.x.com and syndication.twimg.com, and RAID_GUEST_METRICS in .env.");
  }
  console.log("\n   And whatever the answer: an admin pasting the post link in the group ALWAYS raids it.");
  console.log("   That route asks X nothing at all, so it works even on an account X hides.\n");
  process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`\n❌ check failed: ${e && e.message}`);
    process.exit(1);
  });
}

module.exports = { main, probe };
