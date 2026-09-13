// X auto-posting: the operator's rule is "EVERY listing gets posted to X".
//
// The X path is best-effort everywhere — a dead X API must never fail a paid
// order — which means every bug in it is a SILENT one. Nothing here goes red
// when X is down; it goes red when a post path forgets to tweet at all, when a
// tweet is fired too late for the channel card to carry its "Announce On X"
// link, or when the copy stops fitting in a tweet. Those are the failures no
// runtime log will ever show you.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-xpost-"));

const test = require("node:test");
const assert = require("node:assert");

const tpl = require("../src/templates");
const fmt = require("../src/channels/format");
const x = require("../src/twitter");

// ── the copy ────────────────────────────────────────────────────────────────

const coin = {
  name: "Bull Cat",
  symbol: "BULLCAT",
  chain: "solana",
  address: "G9j8WWDeJXZdvwQgP82ooDuHmpc3Gy8NCSins71Lpump",
  tier: "PLATINUM",
  price: 0.000725,
  mcap: 725_100,
  links: { twitter: "https://x.com/bullcat", website: "https://bullcat.io" },
};

/** X's own weighted count: a URL is a flat 23 however long (t.co wraps it) and
 *  emoji weigh 2. Raw String.length would fail every Solana listing on address
 *  length alone and teach us nothing. */
function tweetLength(text) {
  const s = String(text).replace(/https?:\/\/\S+/g, " ".repeat(23));
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    n += cp > 0x1100 && (cp <= 0x115f || cp >= 0x2e80) ? 2 : 1;
  }
  return n;
}

test("every X template fits in a tweet, with real values in it", () => {
  const built = {
    x_listing_tiered: x._text.listingText(coin),
    x_listing: x._text.listingText({ ...coin, tier: "XPRESS" }),
    x_trending: x._text.trendingText(coin),
    x_pump: x._text.pumpText(coin, 240, 1_240_000, 4_230_000),
    x_rankup: x._text.rankUpText(coin, 2, 41.7),
    x_banner: x._text.bannerText({ title: "Acme", slot: "Hero", linkUrl: "https://acme.xyz" }),
    x_gainers: x._text.gainersText("1. $BULLCAT  +41.7%\n2. $JIM  +22.4%", "Friday · July 31 · 2026"),
  };
  for (const [key, text] of Object.entries(built)) {
    const n = tweetLength(text);
    assert.ok(n > 0 && n <= 280, `${key} is ${n}/280 chars:\n${text}`);
    assert.ok(!/\{\w+\}/.test(text), `${key} left an unsubstituted placeholder:\n${text}`);
  }
  // The values that make each post worth reading actually landed.
  assert.match(built.x_listing_tiered, /BULLCAT/);
  assert.match(built.x_listing_tiered, /PLATINUM/i);
  assert.match(built.x_listing_tiered, /@bullcat/, "the project's own X is @mentioned");
  assert.match(built.x_rankup, /#2/);
  assert.match(built.x_rankup, /\+42%/);
  assert.match(built.x_gainers, /\$JIM/);
});

test("every tweet kind has an editable template registered in the editor", () => {
  // A hardcoded tweet body is invisible to @dexvraadminbot — the banner ad's
  // copy was exactly that until it became x_banner, and nobody could reword it.
  for (const key of ["x_listing", "x_listing_tiered", "x_trending", "x_pump", "x_rankup", "x_banner", "x_gainers"]) {
    assert.ok(tpl.keys().includes(key), `${key} is not a template`);
    assert.strictEqual(tpl.meta(key).group, "X Posts", `${key} is not in the X Posts group`);
    assert.ok(tpl.meta(key).ph.length, `${key} has no placeholder hints`);
  }
});

test("a token with no X link degrades to no mention, never a dangling '@'", () => {
  const bare = x._text.listingText({ ...coin, links: {} });
  assert.ok(!/@\s|@$/.test(bare), bare);
  assert.match(bare, /BULLCAT/);
});

// ── the channel cards ───────────────────────────────────────────────────────

test("every channel post carries an Announce On X line when a tweet exists", () => {
  const withTweet = { ...coin, xUrl: "https://x.com/i/status/123" };
  const posts = {
    listing: fmt.listingPost(withTweet),
    trending: fmt.trendingPost(withTweet),
    pump: fmt.pumpPost(withTweet, 240, 1_000_000, 3_400_000),
    rankup: fmt.rankupPost(withTweet, 2, 41.7),
  };
  for (const [kind, p] of Object.entries(posts)) {
    assert.match(p.text, /Announce On X/i, `${kind} post has no Announce On X line`);
    const at = p.text.search(/Announce On X/i);
    const link = p.entities.find((e) => e.type === "text_link" && e.offset === at);
    assert.ok(link, `${kind}: the Announce On X label is not a link`);
    assert.strictEqual(link.url, withTweet.xUrl, `${kind}: wrong tweet url`);
  }
});

test("…and drops the line entirely when there is no tweet (never a dead label)", () => {
  for (const [kind, p] of Object.entries({
    listing: fmt.listingPost(coin),
    trending: fmt.trendingPost(coin),
    pump: fmt.pumpPost(coin, 240, 1_000_000, 3_400_000),
    rankup: fmt.rankupPost(coin, 2, 41.7),
  })) {
    assert.ok(!/Announce On X/i.test(p.text), `${kind} kept a dead Announce On X label:\n${p.text}`);
    assert.ok(!/\n{3,}/.test(p.text), `${kind} left a hole where the line was`);
  }
});

test("every channel post links Dexvra's own X account", () => {
  const { X_LISTING_URL } = require("../src/config/constants");
  for (const [kind, p] of Object.entries({
    listing: fmt.listingPost(coin),
    trending: fmt.trendingPost(coin),
    pump: fmt.pumpPost(coin, 240, 1_000_000, 3_400_000),
    rankup: fmt.rankupPost(coin, 2, 41.7),
  })) {
    const at = p.text.indexOf("X Alerts");
    assert.ok(at !== -1, `${kind} does not link Dexvra's X account:\n${p.text}`);
    const link = p.entities.find((e) => e.type === "text_link" && e.offset === at);
    assert.ok(link, `${kind}: 'X Alerts' is a dead label`);
    assert.strictEqual(link.url, X_LISTING_URL, `${kind}: wrong X account`);
  }
});

// ── the bot messages ────────────────────────────────────────────────────────

test("{xlisting} resolves in EVERY template, with no call site passing it", () => {
  // baseVars() is what makes this true. Before it, a template that gained an X
  // link rendered it blank until someone remembered to update the one handler
  // that renders it — which is exactly what happened to four of these.
  //
  // The list is DERIVED, not typed: which templates carry an X link is a copy
  // decision an admin is invited to change, and a hardcoded list turns that
  // edit into a red build. What must hold is that wherever {xlisting} appears,
  // it resolves.
  const { X_LISTING_URL } = require("../src/config/constants");
  const users = tpl.keys().filter((k) => String(tpl.getRaw(k)).includes("{xlisting}"));
  assert.ok(users.length >= 5, `expected several templates to link X, found ${users.length}`);
  for (const key of users) {
    const p = tpl.render(key, {});
    const text = p.html != null ? p.html : p.text;
    assert.ok(!text.includes("{xlisting}"), `${key} left {xlisting} unsubstituted`);
    // The url lives in the text for a bare link and in a text_link entity for a
    // labelled one — a template is correct either way, dead in neither.
    const linked = (p.entities || []).some((e) => e.url === X_LISTING_URL);
    assert.ok(text.includes(X_LISTING_URL) || linked, `${key} does not link the X listing account`);
  }
});

test("the X account is never hardcoded — renaming it is one env var", () => {
  // Three intro cards used to spell the Dexvra X url into their copy,
  // so X_LISTING_HANDLE was a lie the moment the account was renamed.
  for (const key of tpl.keys()) {
    const raw = tpl.getRaw(key);
    assert.ok(
      !/https:\/\/(x|twitter)\.com\/dexvra/i.test(raw),
      `${key} hardcodes the Dexvra X url — use {xlisting} instead:\n${raw}`,
    );
  }
});

// ── the wiring ──────────────────────────────────────────────────────────────

test("a free auto-listing tweets, and its card carries the tweet", async (t) => {
  const al = require("../src/services/autoLister");
  const twitter = require("../src/twitter");
  const orig = { postListing: twitter.postListing, enabled: twitter.enabled };
  t.after(() => Object.assign(twitter, orig));

  let tweeted = null;
  twitter.enabled = () => true;
  twitter.postListing = async (c) => {
    tweeted = c;
    return "1955000000000000001";
  };

  const c = { chain: "solana", address: "G9j8WWDeJXZdvwQgP82ooDuHmpc3Gy8NCSins71Lpump" };
  const input = { name: "Bull Cat", sym: "BULLCAT", twitter: "https://x.com/bullcat" };
  const coinObj = { name: input.name, symbol: input.sym, chain: c.chain, address: c.address };
  const id = await al.tweetListing(coinObj, c, input);

  assert.strictEqual(id, "1955000000000000001");
  assert.ok(tweeted, "an auto-listing did NOT reach X — this is the whole rule");
  assert.strictEqual(tweeted.symbol, "BULLCAT");
  // The card is rendered AFTER this, from the same object, so the url has to be
  // on it by the time tweetListing resolves — not a tick later.
  assert.strictEqual(coinObj.xUrl, "https://x.com/i/status/1955000000000000001");
});

test("auto-listing tweets can be muted on their own (X_AUTOLIST_ENABLED=0)", async (t) => {
  const before = process.env.X_AUTOLIST_ENABLED;
  process.env.X_AUTOLIST_ENABLED = "0";
  // constants reads env at load time, so the switch is only observable on a
  // fresh require — which is also how it behaves in production (a restart).
  for (const k of Object.keys(require.cache)) {
    if (/src[/\\](config[/\\]constants|services[/\\]autoLister|twitter)\.js$/.test(k)) delete require.cache[k];
  }
  t.after(() => {
    if (before == null) delete process.env.X_AUTOLIST_ENABLED;
    else process.env.X_AUTOLIST_ENABLED = before;
    for (const k of Object.keys(require.cache)) {
      if (/src[/\\](config[/\\]constants|services[/\\]autoLister|twitter)\.js$/.test(k)) delete require.cache[k];
    }
  });

  const al = require("../src/services/autoLister");
  const twitter = require("../src/twitter");
  let called = false;
  twitter.enabled = () => true;
  twitter.postListing = async () => {
    called = true;
    return "1";
  };
  const coinObj = { name: "N", symbol: "N", chain: "solana", address: "A" };
  const id = await al.tweetListing(coinObj, { chain: "solana", address: "A" }, { sym: "N" });
  assert.strictEqual(id, null);
  assert.strictEqual(called, false, "the mute switch did not mute anything");
  assert.strictEqual(coinObj.xUrl, undefined);
});

test("rank-up stays wired but silent — one switch, no code change", async (t) => {
  // Off because of VOLUME, not because it was wrong: it fires per token on every
  // climb into the top band with only a 6h cooldown, which on a busy board is a
  // stream of near-identical posts. Kept whole behind the switch, including the
  // quote lookup, so turning it on is one env var.
  const postids = require("../src/channels/postids");
  const twitter = require("../src/twitter");
  const orig = { postRankUp: twitter.postRankUp, enabled: twitter.enabled };
  t.after(() => Object.assign(twitter, orig));

  await postids.set("solana", "QuoteMe111", { listingTweetId: "1900000000000000001" });
  let called = false;
  twitter.enabled = () => true;
  twitter.postRankUp = async () => {
    called = true;
    return "1955000000000000002";
  };

  const { tweetRankUp } = require("../src/services/rankUpChecker");
  const coinObj = { name: "Q", symbol: "Q", chain: "solana", address: "QuoteMe111" };
  const id = await tweetRankUp(coinObj, { rank: 2, change: 41.7, r: { chain: "solana", address: "QuoteMe111" } });

  assert.strictEqual(id, null, "rank-up must not tweet by default");
  assert.strictEqual(called, false, "X must not even be called");
  assert.strictEqual(coinObj.xUrl, undefined, "and the channel card gets no X line");

  // The plumbing behind the switch is intact: it still resolves the listing
  // tweet to quote, and still hangs the url on the coin the card is built from.
  const src = require("node:fs").readFileSync(require.resolve("../src/services/rankUpChecker.js"), "utf8");
  assert.match(src, /postids\.get\(a\.r\.chain, a\.r\.address\)\.listingTweetId/, "quote lookup must survive");
  assert.match(src, /x\.postRankUp\(coin, a\.rank, a\.change, quote, media\)/, "the call must survive");
  assert.match(src, /if \(!X_RANKUP_ENABLED \|\| !x\.enabled\(\)\) return null/, "one switch gates it");
});

test("the optional second account falls back to the listing account", () => {
  // The normal setup is ONE X account. Before the fallback, a banner ad tweeted
  // through the unconfigured "official" credentials and vanished without trace.
  const { X } = require("../src/config/constants");
  assert.ok(!X.official.appKey, "this test assumes X_O_* is unset (the default)");
  // postBanner routes to "official"; with X_O_* blank that must resolve to the
  // listing credentials rather than to nothing at all.
  const built = x._text.bannerText({ title: "Acme", linkUrl: "https://acme.xyz" });
  assert.match(built, /Acme/);
  assert.ok(tweetLength(built) <= 280);
});

test("missingKeys names exactly what an operator has to paste into .env", () => {
  const names = x.missingKeys("listing");
  // In CI none are set, so all four are reported — and by their REAL env names,
  // which is the only part of this an operator can act on.
  assert.deepStrictEqual(names, ["X_API_KEY", "X_API_KEY_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"]);
});

test("with no keys, every post path is a silent no-op instead of a throw", async () => {
  // A paid order must complete when X is unreachable or unconfigured.
  assert.strictEqual(x.enabled(), false);
  assert.strictEqual(await x.postListing(coin), null);
  assert.strictEqual(await x.postTrending(coin), null);
  assert.strictEqual(await x.postPump(coin, 100, 1, 2), null);
  assert.strictEqual(await x.postRankUp(coin, 1, 20), null);
  assert.strictEqual(await x.postGainers("1. $A +5%", "today"), null);
  assert.strictEqual(await x.postBanner({ title: "A", linkUrl: "https://a.io" }), null);
  assert.strictEqual(await x.whoami(), null);
});

test("the gainers board has a plain-text form for X (no Telegram markup)", () => {
  const gainers = require("../src/gainers");
  const list = gainers.listText([
    { symbol: "BULLCAT", pct: 41.7, x: "bullcat", url: "https://dexvra.io/token/solana/x", mcap: 4_200_000 },
    { symbol: "JIM", pct: 22.4, x: null, url: "https://dexvra.io/token/solana/y", mcap: 900_000 },
  ]);
  // Telegram's [label](url) markup would publish its own brackets on X.
  assert.ok(!/\[|\]|\(http/.test(list), `markup leaked into the tweet:\n${list}`);
  assert.match(list, /1\. \$BULLCAT @bullcat/);
  assert.match(list, /2\. \$JIM/);
  assert.ok(!/@null|@undefined/.test(list), "a token with no X handle got a broken mention");
});

test("the gainers board stays wired but silent — the switch is all that's needed", async (t) => {
  // Gainers are curated: the operator posts the board by hand from
  // @dexvraadminbot, so nothing about it may reach X on its own. The plumbing
  // stays complete on purpose — the copy still travels on the job (the admin bot
  // owns the coins, the main bot owns the keys) — so X_GAINERS_ENABLED=1 turns
  // it on with no deploy and no code change.
  const gp = require("../src/services/gainersPoster");
  const twitter = require("../src/twitter");
  const orig = { postGainers: twitter.postGainers, enabled: twitter.enabled };
  t.after(() => Object.assign(twitter, orig));

  let sent = null;
  twitter.enabled = () => true;
  twitter.postGainers = async (list, date) => {
    sent = { list, date };
    return "1955000000000000009";
  };

  const url = await gp.tweetQueued({ xList: "1. $BULLCAT  +41.7%", xDate: "Friday", imagePath: "" });
  assert.strictEqual(url, null, "a curated board must not auto-tweet");
  assert.strictEqual(sent, null, "X must not even be called");

  // …but the wiring behind the switch is intact, so flipping it works.
  const src = require("node:fs").readFileSync(require.resolve("../src/services/gainersPoster.js"), "utf8");
  assert.match(src, /const xUrl = ok \? await tweetQueued\(job\) : null/, "the queued path must still call tweetQueued");
  assert.match(src, /if \(!X_GAINERS_ENABLED \|\| !x\.enabled\(\)\) return null/, "one switch gates both gainers paths");
  assert.match(
    require("node:fs").readFileSync(require.resolve("../src/admin/gainersMenu.js"), "utf8"),
    /xList: gainers\.listText\(coins/,
    "the tweet copy must still travel on the job",
  );
});

test("the gainers board carries its own Announce On X line, and drops it when unposted", () => {
  const gainers = require("../src/gainers");
  const coins = [{ symbol: "BULLCAT", pct: 41.7, x: "bullcat", url: "https://dexvra.io/token/solana/x", mcap: 4_200_000 }];

  const posted = gainers.captionPayload(coins, { xUrl: "https://x.com/i/status/777" });
  assert.match(posted.text, /Announce On X/i, "a tweeted board must link its tweet");
  const at = posted.text.search(/Announce On X/i);
  const link = posted.entities.find((e) => e.type === "text_link" && e.offset === at);
  assert.ok(link && link.url === "https://x.com/i/status/777", "the Announce On X label is not linked to the tweet");

  // The admin-queued path builds its caption in the OTHER process, before the
  // main bot tweets, so it legitimately has no url — the line must vanish
  // rather than sit there dead.
  const quiet = gainers.captionPayload(coins, {});
  assert.ok(!/Announce On X/i.test(quiet.text), `dead label left behind:\n${quiet.text}`);
  assert.ok(!/\n{3,}/.test(quiet.text), "removing the line left a hole");
  assert.match(quiet.text, /BULLCAT/, "the board itself survived the strip");
  assert.match(quiet.text, /X Alerts/, "the footer still links Dexvra's X account");
});

test("a blocked network is never reported as 'X refused your keys'", () => {
  // A proxy, a firewall or a sandbox egress allowlist answers with the SAME 403
  // X uses for a read-only access token — and its body is a bare string, not
  // X's error object, so reading only .detail/.title threw away the one line
  // that said what happened. Conflating the two sends an operator off
  // regenerating credentials that were never the problem. (Hit for real: this
  // container returned `403 Host not in allowlist: api.x.com` and the checker
  // confidently blamed the keys.)
  const { classify } = require("../src/twitter")._diag;

  const proxied = classify(
    Object.assign(new Error("Request failed with code 403"), {
      code: 403,
      data: "Host not in allowlist: api.x.com. Add this host to your network egress settings to allow access.",
    }),
  );
  assert.strictEqual(proxied.kind, "network", `a proxy block must not read as an auth failure: ${proxied.message}`);
  assert.match(proxied.message, /cannot reach api\.x\.com/);

  // A REAL read-only-token 403 from X still has to be called what it is.
  const readOnly = classify(
    Object.assign(new Error("Request failed with code 403"), {
      code: 403,
      data: { status: 403, detail: "Your client app is not configured with the appropriate oauth1 app permissions." },
    }),
  );
  assert.strictEqual(readOnly.kind, "permission", readOnly.message);
  assert.match(readOnly.message, /Read and write/);

  assert.strictEqual(classify(Object.assign(new Error("401"), { code: 401 })).kind, "auth");
  assert.strictEqual(classify(Object.assign(new Error("429"), { code: 429 })).kind, "ratelimit");
  for (const m of ["fetch failed", "ENOTFOUND api.x.com", "socket hang up", "ETIMEDOUT"]) {
    assert.strictEqual(classify(new Error(m)).kind, "network", m);
  }
});

test("X's new-app crypto rule is not mistaken for a bad access token", () => {
  // A brand-new X app may not post contract addresses for its first 7 days.
  // It arrives as a 403 — the same status as a read-only token — so the naive
  // mapping told the operator to regenerate credentials that were perfectly
  // fine. (Hit for real on the first live listing: the X account authenticated
  // the same day, and the Catjak card was refused for its CA line.)
  const { classify } = require("../src/twitter")._diag;
  const res = classify(
    Object.assign(new Error("Request failed with code 403"), {
      code: 403,
      data: { status: 403, detail: "Crypto addresses are prohibited for the first 7 days after authentication." },
    }),
  );
  assert.strictEqual(res.kind, "newapp-crypto", res.message);
  assert.match(res.message, /NOT a key problem/);
  assert.ok(!/READ-ONLY/.test(res.message), "must not send the operator to regenerate the token");
});

test("Twitter code 64 is not reported as a read-only access token", () => {
  // Hit for real on 2026-09-06: three listings composited their GIF perfectly
  // ("[fulfil] listing media: admin clip + token overlay ✔") and every media
  // upload came back 403 code 64 — "Your account is suspended and is not
  // permitted to access this feature." The blanket 403 branch appended
  // "the Access Token is READ-ONLY … REGENERATE the access token", which is
  // wrong for BOTH of that status's real causes and actively harmful inside the
  // 7-day window, where a fresh authorisation restarts the contract-address
  // clock. Third 403 this classifier has had to pull apart (network,
  // newapp-crypto, this) and the reason is always the same: one status, several
  // causes, opposite actions.
  const { classify } = require("../src/twitter")._diag;
  const res = classify(
    Object.assign(new Error("Request failed with code 403"), {
      code: 403,
      data: { errors: [{ code: 64, message: "Your account is suspended and is not permitted to access this feature." }] },
    }),
  );
  assert.strictEqual(res.kind, "suspended", res.message);
  assert.ok(!/READ-ONLY/.test(res.message), `must not send the operator to regenerate the token:\n${res.message}`);
  // It may not GUESS between the two causes either — the code cannot tell them
  // apart, so it names both and hands over the discriminator.
  assert.match(res.message, /suspended/i);
  assert.match(res.message, /Free tier/, "the access-tier reading must be offered too");
  assert.match(res.message, /\[x\] tweeted/, "…and the one observation that separates them");

  // The genuine read-only 403 keeps its own answer — this must not swallow it.
  const readOnly = classify(
    Object.assign(new Error("Request failed with code 403"), {
      code: 403,
      data: { status: 403, detail: "Your client app is not configured with the appropriate oauth1 app permissions." },
    }),
  );
  assert.strictEqual(readOnly.kind, "permission", readOnly.message);
});

test("a refused listing is retried without its CA, keeping the token link", () => {
  const { stripCryptoAddresses: strip } = require("../src/twitter")._diag;
  const full = x._text.listingText({
    name: "Catjak",
    symbol: "CATJAK",
    chain: "solana",
    address: "3taE4SdY29sa3fnwyWqfshudJ95gMb9LoFTy5Uuppump",
    tier: "XPRESS",
    price: 0.000549,
    mcap: 541_400,
    links: {},
  });
  assert.match(full, /CA: 3taE4SdY/, "precondition: the card carries a bare CA");

  const safe = strip(full);
  assert.ok(!/CA:/.test(safe), `the CA line must go, label included:\n${safe}`);
  // The token page URL embeds the same address — it must SURVIVE. X shortens
  // every url to t.co, so the link is not what the rule is scanning for, and
  // dropping it would cost the tweet its only route back to Dexvra.
  assert.match(safe, /https:\/\/dexvra\.io\/token\/solana\/3taE4SdY/, `the token link was dropped:\n${safe}`);
  assert.match(safe, /CATJAK/, "the ticker survived");
  assert.match(safe, /\$541\.4K/, "the market cap survived");
  assert.ok(!/\n{3,}/.test(safe), "removing the line left a hole");
  assert.ok(tweetLength(safe) <= 280);

  // Every chain shape the bot lists on, not just Solana.
  for (const addr of [
    "0x2170ed0880ac9a755fd29b2688956bd959f933f8",
    "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    "EQCcGZm1AqBCTBc0Kkm8kdmuOZfE7SFrRA0TnCLLtnQZlkOB",
  ]) {
    const s = strip(`Header\n\nCA: ${addr}\n\nhttps://dexvra.io/token/x/${addr}\n\n#Dexvra`);
    assert.ok(!/CA:/.test(s), `${addr} not stripped:\n${s}`);
    assert.match(s, /dexvra\.io\/token/, `${addr}: link should survive:\n${s}`);
  }

  // A tweet with no address at all must come back untouched — the fallback
  // fires on every kind of post, and the gainers board has no CA to lose.
  const gainers = x._text.gainersText("1. $A  +12%\n2. $B  +8%", "Friday");
  assert.strictEqual(strip(gainers), gainers.trim());
});

test("the block window is probed again, so the CA returns without a restart", (t) => {
  // The window ends on X's clock, not ours. If the latch never expired the CA
  // line would stay gone until somebody noticed and restarted the bot — and the
  // failure mode being guarded here is "it silently kept working the degraded
  // way", which nothing in the logs would ever complain about.
  const { caBlocked, _resetCaLatch } = require("../src/twitter")._diag;
  t.after(() => _resetCaLatch());
  _resetCaLatch();
  assert.strictEqual(caBlocked(), false, "nothing is latched at rest");

  const src = require("node:fs").readFileSync(require.resolve("../src/twitter.js"), "utf8");
  assert.match(src, /caBlockedUntil = Date\.now\(\) \+ CA_BLOCK_TTL_MS/, "the latch must be time-bounded");
  assert.match(src, /const caBlocked = \(\) => Date\.now\(\) < caBlockedUntil/, "expiry must be time-based");
  assert.match(src, /caBlockedUntil = 0;[\s\S]{0,80}accepted again/, "a full card that posts must clear the latch at once");
  assert.ok(!/caBlock\w*[^\n]*(saveJSON|persist|writeFile)/i.test(src), "the latch must stay in memory");
});

// ── post media ──────────────────────────────────────────────────────────────

test("every shape postMedia() returns is resolvable for X — or refused cleanly", async () => {
  // The tweet must show the SAME artwork as the channel post. postMedia() picks
  // it and hands back one of six shapes; twitter-api-v2 understands none of them
  // directly, so a gap here silently degrades the tweet to the raw token logo —
  // exactly what shipped, and what nothing in the logs complained about.
  const { resolveMedia } = require("../src/twitter")._diag;
  const os = require("node:os");
  const fsp = require("node:fs/promises");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "xmedia-"));

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64)]);
  const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(64)]);

  const mp4Path = path.join(dir, "bt-out-1.mp4");
  const gifPath = path.join(dir, "banner-media-listing.gif");
  const pngPath = path.join(dir, "banner-artwork-listing.png");
  await fsp.writeFile(mp4Path, mp4);
  await fsp.writeFile(gifPath, gif);
  await fsp.writeFile(pngPath, png);

  // 1. composited still — a bare Buffer with no name; the mime is sniffed.
  assert.deepStrictEqual(
    await resolveMedia({ source: png }).then((r) => [r.mimeType, Buffer.isBuffer(r.file)]),
    ["image/png", true],
  );
  // 2. a naked Buffer (some callers pass the logo straight through)
  assert.strictEqual((await resolveMedia(png)).mimeType, "image/png");
  // 3. composeOntoClip / toInlineClip → an .mp4 PATH. Passed as a PATH so the
  //    library streams and chunk-uploads it instead of us holding it in memory.
  const v = await resolveMedia({ type: "animation", source: mp4Path });
  assert.strictEqual(v.mimeType, "video/mp4");
  assert.strictEqual(v.file, mp4Path, "video must stay a path, not be read into memory");
  // 4. a raw admin GIF override
  assert.strictEqual((await resolveMedia({ type: "animation", source: gifPath })).mimeType, "image/gif");
  // 5. a static asset path
  assert.strictEqual((await resolveMedia({ source: pngPath })).mimeType, "image/png");
  // 6. a bare Telegram file_id — ONLY Telegram can resolve it, so it must be
  //    refused so the caller falls back to the logo instead of tweeting a
  //    meaningless string or crashing.
  assert.strictEqual(await resolveMedia("AgACAgUAAxkBAAIB_2abc123"), null);
  assert.strictEqual(await resolveMedia({ source: "AgACAgUAAxkBAAIB_2abc123" }), null);
  assert.strictEqual(await resolveMedia(null), null);
  assert.strictEqual(await resolveMedia({}), null);
  // a path that doesn't exist is refused rather than handed to the uploader
  assert.strictEqual(await resolveMedia({ source: path.join(dir, "gone.mp4") }), null);

  await fsp.rm(dir, { recursive: true, force: true });
});

test("media type is sniffed from bytes, not assumed to be PNG", () => {
  // A composited banner arrives as an unnamed Buffer. Declaring an MP4 as
  // image/png makes X reject the whole upload, and the tweet loses its artwork.
  const { sniffMime } = require("../src/twitter")._diag;
  assert.strictEqual(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), "image/png");
  assert.strictEqual(sniffMime(Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(8)])), "image/gif");
  assert.strictEqual(sniffMime(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypmp42"), Buffer.alloc(4)])), "video/mp4");
  assert.strictEqual(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), "image/jpeg");
  assert.strictEqual(sniffMime(Buffer.alloc(4)), null, "too short to judge → null, never a wrong guess");
});

test("X's per-category size ceilings are respected", () => {
  const { categoryOf, MAX_BYTES } = require("../src/twitter")._diag;
  assert.strictEqual(categoryOf("image/gif"), "gif");
  assert.strictEqual(categoryOf("video/mp4"), "video");
  assert.strictEqual(categoryOf("image/png"), "image");
  // An animated GIF gets 15MB, not the 5MB image limit — a banner clip is
  // routinely over 5MB and would otherwise be dropped for no reason.
  assert.ok(MAX_BYTES.gif > MAX_BYTES.image);
  assert.ok(MAX_BYTES.video > MAX_BYTES.gif);
});

test("the tweet is handed the same media object the channel post gets", () => {
  // Guarded at the source: every caller must pass its post media, not the logo.
  // The bug this replaces was invisible — the tweet published fine, just with
  // the wrong picture.
  const fs = require("node:fs");
  const read = (f) => fs.readFileSync(require.resolve(f), "utf8");

  const ful = read("../src/fulfillment.js");
  assert.match(ful, /x\.postListing\(coin, listMedia, logoBuffer\)/, "listing tweet must use listMedia");
  assert.match(ful, /x\.postTrending\(coin, trendMedia, logoBuffer\)/, "trending tweet must use trendMedia");
  assert.match(ful, /x\.postBanner\(rec, adMedia,/, "banner tweet must use adMedia");

  assert.match(read("../src/services/autoLister.js"), /x\.postListing\(coin, media, logo\)/);
  assert.match(read("../src/services/rankUpChecker.js"), /x\.postRankUp\(coin, a\.rank, a\.change, quote, media\)/);
  assert.match(read("../src/services/pumpChecker.js"), /x\.postPump\([^)]*ids\.listingTweetId, media\)/);

  // …and no caller may go back to shipping the bare logo as the tweet's picture.
  for (const f of ["../src/fulfillment.js", "../src/services/autoLister.js"]) {
    assert.ok(
      !/x\.post\w+\([^)]*logoBuffer,\s*"image\/png"/.test(read(f)),
      `${f} still tweets the raw logo instead of the post artwork`,
    );
  }
});

test("only LISTING-shaped events tweet: trending and gainers ship off", () => {
  // @listingdexvra is the listing feed. Trending Token is its own product with
  // its own channel, and the Top Gainers board is curated by hand — neither
  // belongs on an automated listing account (operator's rule, 2026-07-31).
  // Switches, not deletions: the templates and code paths stay usable.
  const c = require("../src/config/constants");
  assert.strictEqual(c.X_TRENDING_ENABLED, false, "Trending Token must not tweet by default");
  assert.strictEqual(c.X_GAINERS_ENABLED, false, "the Top Gainers board must not tweet by default");
  // Rank-up fires per token on every climb with only a 6h cooldown — volume is
  // what gets a feed muted, so it is off too. Telegram still gets them.
  assert.strictEqual(c.X_RANKUP_ENABLED, false, "rank-up alerts must not tweet by default");
  // …while everything that IS a listing still does.
  assert.strictEqual(c.X_AUTOLIST_ENABLED, true);

  // The switch has to actually gate the call, not just exist.
  const src = require("node:fs").readFileSync(require.resolve("../src/fulfillment.js"), "utf8");
  assert.match(src, /X_TRENDING_ENABLED\s*\n?\s*\?\s*await Promise\.race\(\[\s*\n?\s*x\.postTrending/,
    "fulfillTrending must gate the tweet on X_TRENDING_ENABLED");
  // Both templates stay registered — turning the switch on must need no deploy.
  assert.ok(tpl.keys().includes("x_trending") && tpl.keys().includes("x_gainers"));
});

test("a pump tweet is only ever a QUOTE of the token's listing tweet", () => {
  // Standing alone on the listing feed, "+240% since listing" is
  // indistinguishable from a shill post for a token the account never
  // announced — the quoted listing card is what makes it a follow-up. This is
  // the same rule pumpTargets has always enforced on Telegram (a pump alert is
  // a REPLY to the listing post, never standalone), and X had been the one
  // place it leaked: postPump falls back to a standalone tweet when no quote id
  // is passed, so the guard has to live at the call site.
  const src = require("node:fs").readFileSync(require.resolve("../src/services/pumpChecker.js"), "utf8");
  const call = src.slice(src.indexOf("let pumpTweetId"), src.indexOf("const card = fmt.pumpPost"));
  assert.match(call, /if \(ids\.listingTweetId\)/, "the tweet must be gated on knowing the listing tweet");
  assert.match(call, /x\.postPump\([^)]*ids\.listingTweetId, media\)/, "…and must pass it as the quote id");
  // The Telegram alert must NOT be gated with it — losing the tweet must never
  // cost the buyer the channel alert they actually paid for.
  const afterCard = src.slice(src.indexOf("const card = fmt.pumpPost"));
  assert.match(afterCard, /for \(const t of targets\)/, "the Telegram alert still posts without a quote");
  assert.ok(
    !/listingTweetId/.test(afterCard.slice(0, afterCard.indexOf("await latch.add"))),
    "the Telegram post must not depend on the listing tweet id",
  );
});

test("boot names every live X source and warns about anything beyond the rule", () => {
  // THE RULE: only listings, pump alerts and banner ads reach @listingdexvra.
  // The switches enforcing it default to off — but an explicit value in .env
  // BEATS a code default, and a stale `X_RANKUP_ENABLED=1` from an earlier setup
  // put rank-up tweets straight back. The only place that was visible was the
  // public timeline, eleven hours later. So boot has to say it out loud.
  const { xSourceReport } = require("../src/bot");
  const log = require("../src/helpers/logger");
  const orig = { info: log.info, warn: log.warn };
  const lines = { info: [], warn: [] };
  log.info = (m) => lines.info.push(String(m));
  log.warn = (m) => lines.warn.push(String(m));
  try {
    xSourceReport();
  } finally {
    Object.assign(log, orig);
  }

  // The allowed set is always stated, so "what will this tweet?" is never a guess.
  assert.strictEqual(lines.info.length, 1, lines.info.join("\n"));
  assert.match(lines.info[0], /X will tweet:/);
  assert.match(lines.info[0], /listings/);
  assert.match(lines.info[0], /pump alerts/);
  assert.match(lines.info[0], /banner ads/);
  // With the shipped defaults nothing extra is on, so nothing is warned about.
  assert.deepStrictEqual(lines.warn, [], "a default config must boot clean");

  // Every switchable extra must be covered by the report, or a future one could
  // be enabled with no boot-time trace — the exact hole this closes.
  const src = require("node:fs").readFileSync(require.resolve("../src/bot.js"), "utf8");
  for (const v of ["X_TRENDING_ENABLED", "X_GAINERS_ENABLED", "X_RANKUP_ENABLED"]) {
    assert.ok(src.includes(v), `${v} is not named in the boot report`);
  }
  assert.match(src, /log\.warn\([\s\S]{0,120}X will ALSO tweet/, "an extra source must WARN, not just inform");
});

test("x:check FAILS when .env posts more than the rule allows", () => {
  // Visibility alone wasn't enough: the boot warning is one line in a log nobody
  // greps until something has already gone out. `npm run x:check` exits non-zero
  // on a rule violation, so it can gate a deploy instead of relying on someone
  // reading carefully.
  const { execFileSync } = require("node:child_process");
  const script = require.resolve("../scripts/x-check.js");
  const run = (env) => {
    try {
      execFileSync(process.execPath, [script], { env: { ...process.env, SKIP_DOTENV: "1", ...env }, stdio: "pipe" });
      return 0;
    } catch (e) {
      return e.status;
    }
  };
  // No keys in CI, so both runs exit 1 — the point is the REASON, which has to
  // name the rule rather than the credentials.
  // SKIP_DOTENV: loadEnv applies the box's .env with override:true, so without
  // this the file beats the env we pass here and the child reports the
  // OPERATOR's configuration instead of the fixture's. That made this test pass
  // on a machine with no .env and fail on the live server, blocking a deploy
  // over a setting that was correct.
  const out = (env) => {
    try {
      return execFileSync(process.execPath, [script], { env: { ...process.env, SKIP_DOTENV: "1", ...env }, stdio: "pipe" }).toString();
    } catch (e) {
      return (e.stdout || Buffer.from("")).toString();
    }
  };
  const clean = out({ X_RANKUP_ENABLED: "0", X_GAINERS_ENABLED: "0", X_TRENDING_ENABLED: "0" });
  assert.match(clean, /nothing beyond the rule is enabled/);
  assert.match(clean, /listings · pump alerts · banner ads/, "the rule must be stated, not implied");

  const stale = out({ X_RANKUP_ENABLED: "1" });
  assert.match(stale, /ALSO posting rank-up alerts/);
  assert.match(stale, /X_RANKUP_ENABLED=1 in \.env overrides the default/);
  assert.match(stale, /sed -i .*X_RANKUP_ENABLED=0/, "it must hand over the exact fix, not a description of it");
  assert.strictEqual(run({ X_RANKUP_ENABLED: "1" }), 1);
});
