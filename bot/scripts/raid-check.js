#!/usr/bin/env node
// Dexvra Raid: which X metric source actually answers from THIS server?
//
// WHY THIS SCRIPT EXISTS
// A raid never fails loudly. If no X source answers it launches crew-only and
// carries on, which is the right behaviour and also means a broken key, an
// exhausted prepaid balance or an IP block all look identical from the group:
// a raid with no like counts. This asks each source in turn and says which one
// answered, so the difference is one command instead of an afternoon.
//
//     cd bot && npm run raid:check
//     cd bot && npm run raid:check -- https://x.com/dexvraio/status/123456
//
// Read-only: it fetches public post metrics and nothing else.
// One owner for "which .env does this process read" — repo root, then bot/, then
// the cwd, with override. dotenv on its own resolves against the CWD alone, so
// four scripts here quietly disagreed about which file counted.
require("../src/config/loadEnv").loadEnv();

const xMetrics = require("../src/raid/xMetrics");
const xEmbed = require("../src/raid/xEmbed");
const xGuest = require("../src/raid/xGuest");

// Jack Dorsey's first tweet — public, permanent, and a useful control: if this
// fails, the problem is this server's access, not the post you were raiding.
const DEFAULT_POST = "20";

/**
 * Resolve the argument to a post id.
 *
 * Deliberately LOOSER than xMetrics.parseTweetId for a BARE numeric argument.
 * That parser requires 5-25 digits because it runs on messages typed into a
 * group chat, where a stray "42" must not be mistaken for a post. Here the
 * argument is unambiguous — someone ran this script and passed a number — and
 * being strict would reject the one id most worth probing with: early-Twitter
 * ids are short, and the control post above is two digits. (The reference
 * implementation shipped exactly this bug: its diagnostic answered "no post id"
 * and exited before making a single request.)
 */
function resolvePostId(arg) {
  const s = String(arg || "").trim();
  if (/^\d{1,25}$/.test(s)) return s;
  return xMetrics.parseTweetId(s);
}

const line = () => console.log("─".repeat(64));

async function tryOne(name, enabled, why, fn) {
  if (!enabled) {
    console.log(`   ${name.padEnd(22)} off        ${why}`);
    return null;
  }
  const res = await fn();
  if (res.ok) {
    const reposts = res.retweets == null ? "n/a" : res.retweets;
    console.log(`   ${name.padEnd(22)} ✅ ok      likes ${res.likes} · replies ${res.replies} · reposts ${reposts}`);
    if (res.retweets == null) {
      console.log(`   ${"".padEnd(22)}            (this source cannot see reposts — a repost goal would be dropped)`);
    }
    return res;
  }
  console.log(`   ${name.padEnd(22)} ❌ ${res.gone ? "gone" : "failed"}  ${res.error}`);
  if (res.advice) console.log(`   ${"".padEnd(22)}            ${res.advice}`);
  return null;
}

async function main() {
  const arg = process.argv[2] || DEFAULT_POST;
  const id = resolvePostId(arg);

  console.log("Dexvra Raid — X metrics check");
  line();
  if (!id) {
    console.log(`Could not read a post id out of: ${arg}`);
    console.log("Pass a full X post URL (it contains /status/) or a bare numeric id.");
    process.exit(2);
  }
  console.log(`post          : ${xMetrics.tweetUrl(id)}${arg === DEFAULT_POST ? "  (control post)" : ""}`);

  const raw = String(process.env.X_BEARER_TOKEN || "").trim();
  const token = xMetrics.apiToken();
  let tokenState;
  if (!raw) tokenState = "not set — raids will run crew-only unless a keyless source is on";
  else if (!token && /^A+$/.test(raw)) tokenState = "set, but it is the .env.example PLACEHOLDER — treated as absent, so it cannot arm a 401 backoff";
  else if (!token) tokenState = "set, but too short to be a real token — treated as absent";
  else tokenState = `set (${raw.length} chars)`;
  console.log(`X_BEARER_TOKEN: ${tokenState}`);
  line();

  console.log("\nSources, in the order the resolver tries them:\n");
  const api = await tryOne("paid API", !!token, "X_BEARER_TOKEN is not usable", async () => {
    // Go through the resolver so the cooldown and error mapping are the real ones.
    const res = await xMetrics.fetchTweetMetrics(id, { force: true });
    return res.source === "api" || !xGuest.isEnabled() ? res : { ok: false, error: "not reached" };
  });
  const guest = api
    ? null
    : await tryOne("guest GraphQL", xGuest.isEnabled(), "RAID_GUEST_METRICS=0 in .env — it is ON by default", () =>
        xGuest.fetchGuestMetrics(id),
      );
  const embed = api || guest
    ? null
    : await tryOne("embed endpoint", xEmbed.isEnabled(), "RAID_FREE_METRICS=0 in .env — it is ON by default", () =>
        xEmbed.fetchEmbedMetrics(id),
      );

  line();
  const winner = api || guest || embed;
  if (winner) {
    console.log(`\n✅ Raids on this server CAN read X (via the ${winner.source} source).`);
    if (winner.retweets == null) {
      console.log("   Reposts are not measurable from this source — set a paid X_BEARER_TOKEN if you need them.");
    }
    process.exit(0);
  }

  console.log("\n⚠️  No X source answered. Raids will still work — the 🤝 Crew goal needs no key at all —");
  console.log("   but likes/replies/reposts will be unavailable and the card will say so.");
  // The two keyless sources are ON unless .env says otherwise, so "off" here is
  // an explicit choice on this box — say that, rather than telling an operator
  // to enable something they already believe is enabled.
  const offByEnv = [
    !xGuest.isEnabled() ? "RAID_GUEST_METRICS" : null,
    !xEmbed.isEnabled() ? "RAID_FREE_METRICS" : null,
  ].filter(Boolean);

  console.log("\n   To fix, pick one:");
  if (offByEnv.length) {
    const many = offByEnv.length > 1;
    console.log(`   • ${offByEnv.join(" and ")} ${many ? "are" : "is"} set to 0 in this server's .env — that is the whole reason.`);
    console.log(`     Set ${many ? "them" : "it"} to 1 (or delete the ${many ? "lines" : "line"}) and restart with --update-env.`);
  }
  console.log("   • set a real X_BEARER_TOKEN (≈ half a cent per raid; reads are billed per post per day)");
  if (!offByEnv.length) {
    console.log("\n   Both keyless sources are ON and still failed, so this is almost always this server's IP —");
    console.log("   X blocks datacenter ranges hardest, and both keyless routes share that one reputation.");
    console.log("   A paid X_BEARER_TOKEN is metered per app rather than per IP, so it is the way out.");
    console.log("   A repeated 404 from the guest source is a different thing: X rotated its GraphQL hash.");
    console.log("   The bot rediscovers that by itself after a 404 — if it persists, x.com is unreachable");
    console.log("   from here too, or a stale X_GUEST_QUERY_ID is pinned in .env (clear it to self-heal).");
  }
  process.exit(1);
}

main().catch((e) => {
  console.error(`\n❌ check failed: ${e && e.message}`);
  process.exit(1);
});
