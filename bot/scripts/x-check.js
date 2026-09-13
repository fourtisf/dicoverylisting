#!/usr/bin/env node
// `npm run x:check` — does X auto-posting actually work on this server?
//
// The X path is best-effort by design: a dead X API must never fail an order
// somebody paid for, so every failure in it is a swallowed warning. That is the
// right behaviour in production and a terrible way to set the thing up, because
// a mistyped key looks exactly like a working bot that happens not to tweet.
// This script is the opposite: it is loud, it is specific, and it fails.
//
//   node scripts/x-check.js            verify the keys + name the account
//   node scripts/x-check.js --tweet    …and publish a real test tweet
//   node scripts/x-check.js --preview  …and print every X template with sample data
//   node scripts/x-check.js --official check the optional second account too
//
// Exit code 0 = ready to auto-post, 1 = something an operator must fix.
const envFiles = require("../src/config/loadEnv").loadEnv();

const {
  X,
  X_KEY_NAMES,
  X_ENABLED,
  X_HANDLE,
  X_LISTING_HANDLE,
  X_LISTING_URL,
  X_AUTOLIST_ENABLED,
  X_TRENDING_ENABLED,
  X_RANKUP_ENABLED,
  X_GAINERS_ENABLED,
  xMissingKeys,
  xComplete,
} = require("../src/config/constants");

const args = process.argv.slice(2);
// Set when a check failed because the request never reached X, so the verdict
// can say "unproven" instead of accusing the keys.
let netBlocked = false;
// Set when .env enables an X source beyond listings / pump alerts / banner ads.
let ruleViolated = false;
const has = (f) => args.includes(f);

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YEL = "\x1b[33m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";
const ok = (m) => console.log(`${GREEN}✔${OFF} ${m}`);
const bad = (m) => console.log(`${RED}✘${OFF} ${m}`);
const warn = (m) => console.log(`${YEL}!${OFF} ${m}`);
const dim = (m) => console.log(`${DIM}${m}${OFF}`);
const head = (m) => console.log(`\n${m}\n${"─".repeat(m.length)}`);

/** Show a secret as its length + last 4, never in full: this runs on a shared
 *  screen often enough (and gets pasted into chats) that printing the real
 *  value would be the most likely way these keys ever leak. */
const mask = (v) => {
  const s = String(v || "");
  if (!s) return `${RED}(blank)${OFF}`;
  return `${DIM}${s.length} chars ending …${s.slice(-4)}${OFF}`;
};

async function checkAccount(account, label) {
  head(`${label} account`);
  const cfg = account === "official" ? X.official : X.listing;
  for (const name of X_KEY_NAMES[account]) {
    const key = { [X_KEY_NAMES[account][0]]: "appKey", [X_KEY_NAMES[account][1]]: "appSecret", [X_KEY_NAMES[account][2]]: "accessToken", [X_KEY_NAMES[account][3]]: "accessSecret" }[name];
    console.log(`  ${name.padEnd(20)} ${mask(cfg[key])}`);
  }
  const missing = xMissingKeys(account);
  if (missing.length) {
    bad(`${missing.length} of 4 keys missing: ${missing.join(", ")}`);
    return null;
  }
  ok("all 4 keys present");

  // Present is not the same as valid. v2.me() is the cheapest call that proves
  // the credentials authenticate AND tells us which account they belong to.
  const x = require("../src/twitter");
  const res = await x.verify(account);
  if (res.ok) {
    ok(`authenticated as @${res.handle}`);
    return res.handle;
  }
  // "Couldn't reach X" is NOT "X rejected you". A firewall, a corporate proxy
  // or a sandbox egress allowlist answers with the same 403 X uses for a
  // read-only token, and conflating them sends an operator off regenerating
  // credentials that were never the problem.
  if (res.kind === "network") {
    netBlocked = true;
    warn("could not reach api.x.com — the keys were NOT tested");
    dim(`    ${res.message}`);
    dim("    This box cannot talk to X: check the firewall / HTTPS_PROXY / egress allowlist,");
    dim("    then run this again. Allow api.x.com and upload.twitter.com (media).");
    return null;
  }
  bad("the X API REFUSED these keys — nothing will be tweeted");
  dim(`    ${res.message}`);
  if (res.kind === "permission") dim("    Fix: app → Read and write, then REGENERATE the access token pair.");
  if (res.kind === "auth") dim("    Fix: re-copy all four values from the SAME app in the console.");
  return null;
}

(async () => {
  head("Environment");
  console.log(`  .env files loaded: ${envFiles.length ? envFiles.join(", ") : `${RED}none${OFF}`}`);
  console.log(`  X_ENABLED          ${process.env.X_ENABLED == null ? `${DIM}(unset → on)${OFF}` : process.env.X_ENABLED}`);
  console.log(`  X_LISTING_HANDLE   @${X_LISTING_HANDLE}  ${DIM}${X_LISTING_URL}${OFF}`);
  console.log(`  X_HANDLE           @${X_HANDLE}  ${DIM}(named in banner-ad copy)${OFF}`);

  // THE RULE, audited against what this .env actually resolves to. The defaults
  // live in code, but an explicit line in .env beats them — which is exactly how
  // rank-up tweets came back after being turned off, invisibly, and were found
  // on the public timeline eleven hours later. Checking it needs to be something
  // you can DO, not something you hope you remember.
  head("What will be posted");
  console.log(`  ${GREEN}always${OFF}   listings · pump alerts · banner ads`);
  console.log(
    `  ${DIM}auto-listings (free)${OFF}  ${X_AUTOLIST_ENABLED ? `${GREEN}on${OFF}` : `${YEL}OFF${OFF} (paid listings still tweet)`}`,
  );
  const extras = [
    ["Trending Token", "X_TRENDING_ENABLED", X_TRENDING_ENABLED],
    ["Top Gainers board", "X_GAINERS_ENABLED", X_GAINERS_ENABLED],
    ["rank-up alerts", "X_RANKUP_ENABLED", X_RANKUP_ENABLED],
  ];
  const on = extras.filter(([, , v]) => v);
  if (!on.length) {
    ok("nothing beyond the rule is enabled");
  } else {
    for (const [what, envVar] of on) {
      warn(`ALSO posting ${what} — ${envVar}=1 in .env overrides the default`);
    }
    dim(`  Fix: sed -i ${on.map(([, v]) => `-e 's|^${v}=.*|${v}=0|'`).join(" ")} .env`);
    ruleViolated = true;
  }

  const handle = await checkAccount("listing", "Listing (@" + X_LISTING_HANDLE + ")");

  if (has("--official") || xComplete("official")) {
    const oh = await checkAccount("official", "Official (optional, banner ads)");
    if (!oh && !xComplete("official")) dim("    not configured — banner ads fall back to the listing account");
  } else {
    head("Official account (optional, banner ads)");
    dim("  not configured — banner ads go out from the listing account. That is fine.");
  }

  if (handle && handle.toLowerCase() !== String(X_LISTING_HANDLE).toLowerCase()) {
    head("Mismatch");
    warn(`the keys post as @${handle} but X_LISTING_HANDLE is @${X_LISTING_HANDLE}`);
    dim("  Every \"Listing Alerts on X\" link in the posts points at X_LISTING_HANDLE.");
    dim(`  Fix: set X_LISTING_HANDLE=${handle} in .env`);
  }

  if (has("--preview")) {
    head("Template preview (what the bot would tweet)");
    const x = require("../src/twitter");
    const coin = {
      name: "Bullcat",
      symbol: "BULLCAT",
      chain: "solana",
      address: "8x2FsyEyM1TDtqYCPuVMSPGb2FTLKnBEsvVfCoJppump",
      tier: "PLATINUM",
      price: 0.0004231,
      mcap: 4_230_000,
      links: { twitter: "https://x.com/bullcat" },
    };
    // X's own weighted count, not String.length: every URL counts as a flat 23
    // characters however long it is (t.co wraps them), and CJK/emoji count 2.
    // Measuring raw length would flag a perfectly valid listing tweet as too
    // long purely because Solana addresses are 44 characters.
    const weigh = (text) => {
      let s = String(text).replace(/https?:\/\/\S+/g, " ".repeat(23));
      let n = 0;
      for (const ch of s) {
        const cp = ch.codePointAt(0);
        // CJK/Hangul and everything outside the BMP (emoji) weigh 2.
        n += cp > 0x1100 && (cp <= 0x115f || cp >= 0x2e80) ? 2 : 1;
      }
      return n;
    };
    const show = (title, text) => {
      const n = weigh(text);
      const flag = n > 280 ? `${RED}${n}/280 — TOO LONG${OFF}` : `${GREEN}${n}/280${OFF}`;
      console.log(`\n${DIM}── ${title} (${flag})${DIM} ──${OFF}\n${text}`);
    };
    show("x_listing_tiered", x._text.listingText(coin));
    show("x_listing", x._text.listingText({ ...coin, tier: "XPRESS" }));
    show("x_trending", x._text.trendingText(coin));
    show("x_pump", x._text.pumpText(coin, 240, 1_240_000, 4_230_000));
    show("x_rankup", x._text.rankUpText(coin, 2, 41.7));
    show("x_banner", x._text.bannerText({ title: "Acme Protocol", slot: "Hero Banner", linkUrl: "https://acme.xyz" }));
    show("x_gainers", x._text.gainersText("1. $BULLCAT @bullcat  +41.7%\n2. $JIM  +22.4%", "Friday · July 31 · 2026"));
  }

  if (has("--tweet")) {
    head("Test tweet");
    if (!X_ENABLED) {
      bad("X is disabled — nothing to send");
    } else {
      const x = require("../src/twitter");
      const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
      // Every tweet is unique-by-timestamp on purpose: X rejects a duplicate of
      // a recent tweet, and "duplicate content" would read here as "broken keys".
      const id = await x.postGainers("(no tokens — this is a connectivity test)", stamp);
      if (id) ok(`posted → https://x.com/${handle || X_LISTING_HANDLE}/status/${id}   (delete it from the app)`);
      else bad("the tweet did NOT go out — see the warning above this line");
    }
  }

  head("Verdict");
  if (X_ENABLED && handle && !ruleViolated) {
    ok("auto-posting is READY — listings, pump alerts and banner ads only");
    if (!has("--tweet")) dim("  Prove it end to end with: npm run x:check -- --tweet");
    process.exit(0);
  }
  if (X_ENABLED && handle && ruleViolated) {
    // Working credentials are not the same as correct behaviour. Exiting
    // non-zero is what lets this be wired into a deploy step.
    bad("auto-posting works, but .env posts MORE than listings / pump alerts / banner ads");
    dim("  See 'What will be posted' above for the exact fix.");
    process.exit(1);
  }
  if (!xComplete("listing")) bad(`auto-posting is OFF — fill in: ${xMissingKeys("listing").join(", ")}`);
  else if (!X_ENABLED) bad("auto-posting is OFF — X_ENABLED is set to 0");
  else if (netBlocked) {
    warn("UNPROVEN — the keys look complete but this box cannot reach api.x.com");
    dim("  Nothing is wrong with the keys as far as this check can tell. Run it again");
    dim("  from the server that actually runs the bot, with egress to api.x.com open.");
  } else bad("auto-posting is OFF — the keys were refused by X");
  process.exit(1);
})().catch((e) => {
  bad(`x-check crashed: ${e && e.message}`);
  process.exit(1);
});
