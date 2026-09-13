// A logo for every listing — "cari sumber logo entah dri dexscrener pumpfun
// atau apalah cri dri banyak sumber dan jika tidak ada logo hapus aja tokenya".
//
// The board was drawing `FL` initials for $FLOKI: the site's monogram
// fallback, which is the right thing to draw and the wrong thing to have to
// draw on a row nobody will ever come and fix.
const test = require("node:test");
const assert = require("node:assert");
const { resolveLogo, cdnGuess, isImage } = require("../src/services/tokenLogo");

const deps = (over = {}) => ({
  dsInfo: async () => null,
  gtInfo: async () => null,
  padInfo: async () => null,
  cgInfo: async () => ({ ok: true, url: null }),
  ptInfo: async () => null,
  gtInCooldown: () => false,
  isImage: async () => true,
  ...over,
});

test("it asks SEVEN sources, in order of how much each knows about the token", async () => {
  const order = [];
  const d = deps({
    dsInfo: async () => (order.push("ds"), null),
    gtInfo: async () => (order.push("gt"), null),
    padInfo: async () => (order.push("pad"), null),
    cgInfo: async () => (order.push("cg"), { ok: true, url: null }),
    ptInfo: async () => (order.push("pt"), null),
  });
  const hit = await resolveLogo("bsc", "0xabc", { deps: d });
  assert.deepStrictEqual(order.sort(), ["cg", "ds", "gt", "pad", "pt"], "every index is asked");
  // The CDN path is a CONVENTION we construct, so it is the last resort.
  assert.strictEqual(hit.source, "dexscreener-cdn");
  assert.strictEqual(hit.url, cdnGuess("bsc", "0xabc"));
});

test("CoinGecko and Trust Wallet are real sources, keyed their OWN way", () => {
  const { trustWallet, CG_PLATFORM, TW_CHAIN } = require("../src/services/tokenLogo");
  // ⚠️ Trust Wallet's path is the EIP-55 CHECKSUMMED address — a lowercase one
  // 404s, and every address this repo stores is whatever the source gave us.
  const tw = trustWallet("ethereum", "0x6982508145454ce325ddbe47a25d4ec3d2311933");
  assert.match(tw, /0x6982508145454Ce325dDbE47a25d4ec3d2311933\/logo\.png$/);
  assert.strictEqual(trustWallet("solana", "So111"), null, "EVM only — no path to build");
  assert.strictEqual(trustWallet("ethereum", "not-an-address"), null);
  // Three different spellings of one chain set. A chain missing from either
  // table costs ONE source and must never throw.
  assert.strictEqual(CG_PLATFORM.bsc, "binance-smart-chain");
  assert.strictEqual(TW_CHAIN.bsc, "smartchain");
  assert.strictEqual(trustWallet("notachain", "0x6982508145454ce325ddbe47a25d4ec3d2311933"), null);
});

test("⚠️ six empty answers is INFORMATION, not a gap in the search", async () => {
  // "ga mungkin kalo project g punya logo" is right about projects, and the
  // tokens it was said about were not projects: $SAFE, $BONK, $CAT, $WOJAK,
  // $MEME — one per search TERM the seeder uses, across three chains, none
  // with artwork on any index. A real project is on at least one within a day.
  const d = deps({ isImage: async () => false });
  const r = await resolveLogo("ethereum", "0xjunk", { deps: d });
  assert.strictEqual(r.url, null);
  assert.strictEqual(r.ok, true, "every source ANSWERED — that is what makes it safe to act on");
});

test("the project's own upload wins, and a later source is not even fetched", async () => {
  const fetched = [];
  const d = deps({
    dsInfo: async () => ({ logoUrl: "https://ds/a.png" }),
    gtInfo: async () => ({ logoUrl: "https://gt/b.png" }),
    isImage: async (u) => (fetched.push(u), true),
  });
  const hit = await resolveLogo("bsc", "0xabc", { deps: d });
  assert.strictEqual(hit.source, "dexscreener");
  assert.deepStrictEqual(fetched, ["https://ds/a.png"], "a verified hit ends the search");
});

test("the LAUNCHPAD carries artwork before either index does", async () => {
  // pump.fun and friends have a logo from the first minute; DexScreener and
  // GeckoTerminal only have one once somebody submits it.
  const d = deps({ padInfo: async () => ({ logoUrl: "https://pump/c.png" }) });
  const hit = await resolveLogo("solana", "mint", { deps: d });
  assert.strictEqual(hit.source, "launchpad");
});

test("⚠️ every candidate is FETCHED before it is believed", async () => {
  // The CDN path can always be CONSTRUCTED and is very often a 404. Storing one
  // unverified turns "no logo" into "broken image", which is worse — the
  // monogram at least looks deliberate.
  const d = deps({
    dsInfo: async () => ({ logoUrl: "https://ds/dead.png" }),
    isImage: async (u) => u !== "https://ds/dead.png",
  });
  const hit = await resolveLogo("bsc", "0xabc", { deps: d });
  assert.strictEqual(hit.source, "dexscreener-cdn", "a dead url falls through to the next source");
});

test("no source has one → null, never a guess", async () => {
  const d = deps({ isImage: async () => false });
  assert.strictEqual((await resolveLogo("bsc", "0xabc", { deps: d })).url, null);
});

test("an http url is refused — the site serves https", async () => {
  const d = deps({ dsInfo: async () => ({ logoUrl: "http://insecure/a.png" }), isImage: async () => false });
  assert.strictEqual((await resolveLogo("bsc", "0xabc", { deps: d })).url, null);
});

test("a source that THROWS costs that source, never the search", async () => {
  const d = deps({
    dsInfo: async () => {
      throw new Error("ENOTFOUND");
    },
    gtInfo: async () => ({ logoUrl: "https://gt/ok.png" }),
  });
  const hit = await resolveLogo("bsc", "0xabc", { deps: d });
  assert.strictEqual(hit.source, "geckoterminal");
  assert.deepStrictEqual(hit.unreachable, ["dexscreener: ENOTFOUND"], "…and the throw is REPORTED, not swallowed");
});

test("a chain DexScreener does not index still gets the three real sources", async () => {
  assert.strictEqual(cdnGuess("notachain", "0xabc"), null);
  const d = deps({ gtInfo: async () => ({ logoUrl: "https://gt/x.png" }) });
  assert.strictEqual((await resolveLogo("notachain", "0xabc", { deps: d })).source, "geckoterminal");
  const none = deps({ isImage: async () => true });
  assert.strictEqual((await resolveLogo("notachain", "0xabc", { deps: none })).url, null, "and no CDN guess to fall back on");
});

test("isImage rejects an HTML error page served with a 200", async () => {
  const real = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => "text/html; charset=utf-8" } });
    assert.strictEqual(await isImage("https://cdn/x.png"), false, "a CDN's miss page is not a logo");
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => "image/png" } });
    assert.strictEqual(await isImage("https://cdn/x.png"), true);
    // Some CDNs refuse HEAD while serving the file — treating that as a miss
    // would discard a good logo.
    let n = 0;
    global.fetch = async (u, o) => {
      n++;
      return o.method === "HEAD"
        ? { ok: false, status: 405, headers: { get: () => "" } }
        : { ok: true, status: 200, headers: { get: () => "image/webp" } };
    };
    assert.strictEqual(await isImage("https://cdn/x.png"), true);
    assert.strictEqual(n, 2, "HEAD then GET");
  } finally {
    global.fetch = real;
  }
});

test("a network failure is a miss, never a throw", async () => {
  const real = global.fetch;
  try {
    global.fetch = async () => {
      throw new Error("socket hang up");
    };
    assert.strictEqual(await isImage("https://cdn/x.png"), false);
  } finally {
    global.fetch = real;
  }
});


// ── ⚠️ A source that could not be ASKED has not said no ─────────────────────
//
// The first live cleanup run printed "83 row(s) with no logo" directly under
// `GeckoTerminal backing off for 120s — HTTP 429`. Source two answered nothing
// for every one of those rows, the script called it "no logo anywhere", and it
// was one --apply away from deleting eighty-three public listings on it.

test("⚠️ GeckoTerminal is a bonus ONLY where CoinGecko covers the chain", async () => {
  // GT is CoinGecko's and its token images come from the same catalogue, so
  // asking CoinGecko already covers it. It is also the only source here with a
  // shared rate limit, and treating it as required cost a whole cleanup run:
  // 429 after two rows, then 120s, over and over, for eighty-three of them.
  let asked = false;
  const d = deps({
    gtInCooldown: () => true,
    gtInfo: async () => ((asked = true), null),
    isImage: async () => false,
  });
  const r = await resolveLogo("bsc", "0xabc", { deps: d });
  assert.strictEqual(asked, false, "a parked source is not even called");
  assert.strictEqual(r.ok, true, "CoinGecko covers BSC and shares GT's catalogue");
  assert.match(r.unreachable.join(" "), /geckoterminal: cooldown/, "…and it is still REPORTED");
  assert.deepStrictEqual(r.blocking, [], "nothing that matters was missing");
});

test("⚠️ …and it BLOCKS on a chain nothing else indexes", async () => {
  // The rule's first cut skipped GT everywhere, and every row in that cleanup
  // run was ROBINHOOD: DexScreener does not index the chain, CoinGecko has no
  // platform id for it, Trust Wallet has no path. GT is one of only two places
  // the artwork can be, so "GeckoTerminal skipped — no artwork on any source"
  // was a claim resting on nothing.
  const { CG_PLATFORM } = require("../src/services/tokenLogo");
  assert.ok(!CG_PLATFORM.robinhood, "the premise: CoinGecko does not cover it");
  const d = deps({ gtInCooldown: () => true, isImage: async () => false });
  const r = await resolveLogo("robinhood", "0xabc", { deps: d });
  assert.strictEqual(r.ok, false, "we did not look — that is not 'nothing is there'");
  assert.deepStrictEqual(r.blocking, ["geckoterminal: cooldown"]);
});

test("pools.trade is the OTHER place a Robinhood token's artwork lives", async () => {
  const d = deps({ ptInfo: async () => ({ logoUrl: "https://pools/a.png" }) });
  const hit = await resolveLogo("robinhood", "0xabc", { deps: d });
  assert.strictEqual(hit.source, "poolstrade");
  // …and it is a real module in this repo, not a URL invented here.
  const src = require("node:fs").readFileSync(require.resolve("../src/services/tokenLogo.js"), "utf8");
  assert.match(src, /require\('\.\.\/poolstrade'\)/);
});

test("any OTHER unreachable source still blocks the decision", async () => {
  const d = deps({
    dsInfo: async () => {
      throw new Error("ENOTFOUND");
    },
    isImage: async () => false,
  });
  const r = await resolveLogo("bsc", "0xabc", { deps: d });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.blocking, ["dexscreener: ENOTFOUND"]);
});

test("a REACHABLE GeckoTerminal is still used, and still wins its slot", async () => {
  const d = deps({ gtInfo: async () => ({ url: "https://gt/a.png" }) });
  const hit = await resolveLogo("bsc", "0xabc", { deps: d });
  assert.strictEqual(hit.source, "geckoterminal");
  assert.strictEqual(hit.url, "https://gt/a.png");
});

test("CoinGecko: 404 is an answer, 429 is not", async () => {
  const real = global.fetch;
  const { coingecko } = require("../src/services/tokenLogo");
  try {
    global.fetch = async () => ({ status: 404, ok: false });
    assert.deepStrictEqual(await coingecko("bsc", "0xabc"), { ok: true, url: null }, "curated index, token simply absent");

    global.fetch = async () => ({ status: 429, ok: false });
    assert.strictEqual((await coingecko("bsc", "0xabc")).ok, false, "rate limited is not 'not listed'");

    global.fetch = async () => {
      throw new Error("ETIMEDOUT");
    };
    assert.strictEqual((await coingecko("bsc", "0xabc")).ok, false);

    global.fetch = async () => ({ status: 200, ok: true, json: async () => ({ image: { large: "https://cg/a.png" } }) });
    assert.deepStrictEqual(await coingecko("bsc", "0xabc"), { ok: true, url: "https://cg/a.png" });
  } finally {
    global.fetch = real;
  }
  // A chain CoinGecko has no id for is ANSWERED — there is nothing to ask.
  assert.deepStrictEqual(await coingecko("notachain", "0xabc"), { ok: true, url: null });
});

test("ok:true with no url is the ONLY state a caller may delete on", async () => {
  const answered = await resolveLogo("ethereum", "0xjunk", { deps: deps({ isImage: async () => false }) });
  assert.strictEqual(answered.ok, true);
  assert.strictEqual(answered.url, null);

  const blind = await resolveLogo("ethereum", "0xjunk", {
    deps: deps({ isImage: async () => false, dsInfo: async () => { throw new Error("down"); } }),
  });
  assert.strictEqual(blind.ok, false);
  assert.strictEqual(blind.url, null, "same url, completely different fact");
});

test("the cleanup deletes only on ok:true, and says so when it cannot", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "scripts", "fix-listings.js"),
    "utf8",
  );
  assert.match(src, /\} else if \(!hit\.ok\) \{/, "undecided must branch BEFORE the delete");
  assert.match(src, /undecided\+\+/);
  assert.match(src, /UNDECIDED/);
  assert.match(src, /process\.exit\(refused \|\| undecided \? 1 : 0\)/, "unfinished work must not exit clean");
  // The logo-less delete is reached only when `hit.url` is falsy AND `hit.ok`.
  // (`removedNoLogo++` also appears earlier, in the not-a-project branch, which
  // needs no resolver answer at all — so this measures the LAST one.)
  assert.ok(
    src.indexOf("} else if (!hit.ok) {") < src.lastIndexOf("removedNoLogo++"),
    "the undecided guard is upstream of the logo-less delete",
  );
});


// ── ⚠️ Two services, two rate limits, one wait keyed to the wrong one ───────

test("CoinGecko is PACED — an unpaced call per row is what started refusing", async () => {
  // A cleanup walks a row every 120ms; CoinGecko's free tier is a handful of
  // calls a minute. It refused, `ok:false` blocked the run, and the run then
  // slept on GECKOTERMINAL'S clock — a limit that had nothing to do with it.
  const logo = require("node:fs")
    .readFileSync(require.resolve("../src/services/tokenLogo.js"), "utf8");
  assert.match(logo, /cgGapMs\(\)/);
  assert.match(logo, /process\.env\.CG_MIN_GAP_MS/);
  assert.match(logo, /await cgSlot\(\)/, "every call takes a slot");
  assert.match(logo, /res\.status === 429 && !retried/, "and a refusal is retried ONCE");
  assert.match(logo, /retryAfterMs\(res\)/, "honouring their own number");
});

test("a 429 is retried once, then reported rather than held", async () => {
  const real = global.fetch;
  const { coingecko } = require("../src/services/tokenLogo");
  process.env.CG_MIN_GAP_MS = "0";
  try {
    let n = 0;
    global.fetch = async () => {
      n++;
      return { status: 429, ok: false, headers: { get: () => "0" } };
    };
    const r = await coingecko("bsc", "0xabc");
    assert.strictEqual(n, 2, "one retry, not a loop");
    assert.strictEqual(r.ok, false, "a second refusal is reported, never waited out for ever");

    n = 0;
    global.fetch = async () =>
      n++ === 0
        ? { status: 429, ok: false, headers: { get: () => "0" } }
        : { status: 200, ok: true, json: async () => ({ image: { large: "https://cg/a.png" } }) };
    assert.deepStrictEqual(await coingecko("bsc", "0xabc"), { ok: true, url: "https://cg/a.png" });
  } finally {
    global.fetch = real;
    delete process.env.CG_MIN_GAP_MS;
  }
});

test("the cleanup backs off on the NAMED blocker, and holds a row back once", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "scripts", "fix-listings.js"),
    "utf8",
  );
  assert.match(src, /hit\.blocking\.join/, "the wait says WHICH source stopped it");
  assert.match(src, /!heldBack\.has\(r\.id\)/, "…and a row is held back once, not in a loop");
  assert.match(src, /heldBack\.add\(r\.id\)/);
  // The old form slept for GeckoTerminal's cooldown whatever was blocking.
  assert.ok(
    !/gt\.cooldownRemaining\(\) > 0\)/.test(src.replace(/^\s*\/\/.*$/gm, "")),
    "the backoff must not key on one service's clock while another blocks",
  );
});

// ── The metered sources are asked LAST, and usually not at all ──────────────
//
// "jangan ambil dari gecko terminal ambil dri dexscrener updated pumpfun dll"
// (2026-08-26), sent while the operator watched their own buy alerts stop:
//
//   WARN [buybot] GeckoTerminal backing off for 120s — HTTP 429 (rate
//   limited). Buy alerts are paused process-wide until it lifts.
//
// …printed over and over while `listings:fix` walked 463 rows. Every row asked
// all five sources CONCURRENTLY, so a token whose logo DexScreener already had
// still spent a GeckoTerminal request out of a ~30/min per-IP ceiling shared
// with the running bot. The cleanup was starving production.

test("⚠️ a row DexScreener can answer never touches GeckoTerminal or CoinGecko", async () => {
  const asked = [];
  const d = deps({
    dsInfo: async () => (asked.push("ds"), { logoUrl: "https://ds/a.png" }),
    gtInfo: async () => (asked.push("gt"), { logoUrl: "https://gt/b.png" }),
    cgInfo: async () => (asked.push("cg"), { ok: true, url: "https://cg/c.png" }),
  });
  const hit = await resolveLogo("bsc", "0xabc", { deps: d });
  assert.strictEqual(hit.source, "dexscreener");
  assert.ok(!asked.includes("gt"), "GeckoTerminal was asked for a row it was not needed for");
  assert.ok(!asked.includes("cg"), "CoinGecko was asked for a row it was not needed for");
});

test("…and so does one the LAUNCHPAD can answer — pump.fun has artwork from minute one", async () => {
  const asked = [];
  const d = deps({
    dsInfo: async () => (asked.push("ds"), null),
    padInfo: async () => (asked.push("pad"), { logoUrl: "https://pump/c.png" }),
    gtInfo: async () => (asked.push("gt"), { logoUrl: "https://gt/b.png" }),
    cgInfo: async () => (asked.push("cg"), { ok: true, url: "https://cg/c.png" }),
  });
  const hit = await resolveLogo("solana", "mint", { deps: d });
  assert.strictEqual(hit.source, "launchpad");
  assert.deepStrictEqual(asked.sort(), ["ds", "pad"], `the metered sources were asked anyway: ${asked}`);
});

test("only a row NOTHING free can answer reaches the metered ones", async () => {
  const asked = [];
  const d = deps({
    dsInfo: async () => (asked.push("ds"), null),
    padInfo: async () => (asked.push("pad"), null),
    ptInfo: async () => (asked.push("pt"), null),
    gtInfo: async () => (asked.push("gt"), { logoUrl: "https://gt/b.png" }),
    cgInfo: async () => (asked.push("cg"), { ok: true, url: null }),
  });
  const hit = await resolveLogo("bsc", "0xabc", { deps: d });
  assert.strictEqual(hit.source, "geckoterminal", "GT is still USED where it is the one that has it");
  assert.ok(asked.includes("gt"), "…so it must still be asked when wave 1 came up empty");
});

test("⚠️ GeckoTerminal is DEFERRED, never dropped — Robinhood has nowhere else to look", async () => {
  // Dropping it outright would turn "we did not look" into a permanent
  // `undecided` for a whole chain: DexScreener does not index Robinhood and
  // CoinGecko has no platform id for it. Asking it last is the fix; not
  // asking it is a different bug.
  const asked = [];
  const d = deps({
    dsInfo: async () => null,
    padInfo: async () => null,
    ptInfo: async () => null,
    gtInfo: async () => (asked.push("gt"), { logoUrl: "https://gt/rh.png" }),
  });
  const hit = await resolveLogo("robinhood", "0xrh", { deps: d });
  assert.ok(asked.includes("gt"), "Robinhood must still reach GeckoTerminal");
  assert.strictEqual(hit.source, "geckoterminal");
});

test("the CONVENTION stays last — a guess must lose to an answer", async () => {
  const d = deps({
    dsInfo: async () => null,
    padInfo: async () => null,
    ptInfo: async () => null,
    gtInfo: async () => null,
    cgInfo: async () => ({ ok: true, url: "https://cg/real.png" }),
  });
  const hit = await resolveLogo("bsc", "0xabc", { deps: d });
  assert.strictEqual(hit.source, "coingecko", "the CDN path outranked a source that actually answered");
});
