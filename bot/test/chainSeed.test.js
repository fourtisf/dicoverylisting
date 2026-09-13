// Seeding a chain to N listings — "tambahkan token chain bsc base eth 50 token
// top nya … tidak perlu di announce cukup tambahkan aja tokennya".
//
// What these pin, each one a way a bulk lister could quietly do the wrong
// thing to a public site: it lists with the `free` package and never the
// `trending` one (which books a board slot nobody sold), it ANNOUNCES nothing,
// the target is up-to rather than add-N (so a re-run cannot double a chain),
// a token already listed or listed-once-and-removed is skipped, and "the
// market could not be read" stays a different answer from "there was nothing
// to add".
const test = require("node:test");
const assert = require("node:assert");

const seeder = require("../src/services/chainSeed");
const autoLister = require("../src/services/autoLister");

/** The module's CODE, comments stripped. A scan over the raw file matches the
 *  header explaining why the rule exists, so a correct module fails its own
 *  guard — the same trap the base58 ban in tradebot had to be rescued from. */
function code() {
  return require("node:fs")
    .readFileSync(require.resolve("../src/services/chainSeed.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** A GT-shaped big-coin row. */
const coin = (i, over = {}) => ({
  address: `0x${String(i).padStart(40, "a")}`,
  symbol: `T${i}`,
  name: `Token ${i}`,
  mcap: 10_000_000 - i,
  liq: 500_000,
  priceUsd: 1,
  // Every candidate carries artwork, because the seeder now REFUSES one that
  // does not — "setiap token harus punya logonya". A fixture without it would
  // make every test here a test of the logo gate.
  logoUrl: `https://img.test/${i}.png`,
  ...over,
});

/** seedChain with every dependency injected — no network, no disk. */
function harness({ items = [], ok = true, why = null, rows = [], ever = () => false, createImpl, topImpl, geckoImpl, logoImpl, cooldown = () => 0, sleepImpl } = {}) {
  const calls = { create: [], info: [], top: [], gecko: [], logo: [], slept: [] };
  const deps = {
    cooldownRemaining: cooldown,
    async topByMcap(chain, o) {
      calls.top.push([chain, o]);
      if (topImpl) return topImpl(chain, o, calls.top.length);
      return { ok, why, items };
    },
    async topByMcapGecko(chain, o) {
      calls.gecko.push([chain, o]);
      if (geckoImpl) return geckoImpl(chain, o, calls.gecko.length);
      return { ok: true, why: null, items: [], nextPage: null };
    },
    async getListings() {
      return rows;
    },
    wasEverListed: ever,
    async resolveLogo(chain, address) {
      calls.logo.push([chain, address]);
      return logoImpl ? logoImpl(chain, address) : null;
    },
    async fetchTokenInfo(chain, address) {
      calls.info.push([chain, address]);
      return { name: "Enriched", symbol: "ENR", logoUrl: "https://x.test/y.png" };
    },
    async createFromInfo(chain, address, info, opts) {
      calls.create.push({ chain, address, info, opts });
      if (createImpl) return createImpl(chain, address, info, opts);
      return { listing: { id: address }, input: { sym: info.symbol } };
    },
    async sleep(ms) {
      calls.slept.push(ms);
      if (sleepImpl) await sleepImpl(ms);
    },
  };
  return { deps, calls };
}

test("plan is pure and takes exactly the shortfall, best first", () => {
  const p = seeder.plan({
    chain: "bsc",
    target: 50,
    current: 47,
    candidates: [coin(1), coin(2), coin(3), coin(4), coin(5)],
    known: new Set(),
    everListed: () => false,
  });
  assert.strictEqual(p.need, 3);
  assert.deepStrictEqual(p.take.map((c) => c.symbol), ["T1", "T2", "T3"]);
});

test("the target is UP TO, not add-N — a chain already there lists nothing", async () => {
  const { deps, calls } = harness({
    items: [coin(1), coin(2)],
    rows: Array.from({ length: 50 }, (_, i) => ({ chain: "base", address: `0x${i}` })),
  });
  const r = await seeder.seedChain("base", { target: 50, apply: true, deps, gapMs: 0, spread: false });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.listed, []);
  assert.match(r.why, /already at 50\/50/);
  assert.strictEqual(calls.create.length, 0, "nothing may be created at target");
  assert.strictEqual(calls.top.length, 0, "and the market is not even asked");
});

test("it lists with the FREE package — never `trending`, which books a board slot", async () => {
  const { deps, calls } = harness({ items: [coin(1), coin(2)] });
  await seeder.seedChain("bsc", { target: 2, apply: true, deps, gapMs: 0, spread: false });
  assert.strictEqual(calls.create.length, 2);
  for (const c of calls.create) {
    assert.strictEqual(c.opts.pkgKey, "free", "a seeded row is a plain listing, not a purchase");
  }
});

test("nothing is announced — no channel path exists on this module at all", () => {
  // `announce()` is reachable only from autoLister.runOnce, and only when it is
  // given a `tg`. A seeder that grew either would post fifty cards to a channel
  // of 12,607 subscribers — exactly what the operator asked not to happen.
  const src = code();
  assert.ok(!/\btg\b/.test(src), "chainSeed must never hold a telegram handle");
  assert.ok(!/announce|postChannel|runOnce/.test(src), "chainSeed must not reach the announcing path");
});

test("a token already listed, or listed once and removed, is skipped", async () => {
  const { deps, calls } = harness({
    items: [coin(1), coin(2), coin(3)],
    rows: [{ chain: "bsc", address: coin(1).address.toUpperCase() }], // case must not matter
    ever: (chain, address) => address === coin(2).address,
  });
  const r = await seeder.seedChain("bsc", { target: 3, apply: true, deps, gapMs: 0, spread: false });
  assert.deepStrictEqual(calls.create.map((c) => c.address), [coin(3).address]);
  assert.match(r.why, /1 already listed, 1 listed before and removed/);
});

test("an unreadable market is ok:false — NOT an empty chain", async () => {
  const { deps, calls } = harness({ ok: false, why: "429 from GeckoTerminal", items: [] });
  const r = await seeder.seedChain("ethereum", { target: 50, apply: true, deps, gapMs: 0, spread: false, source: "gecko" });
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /could not read the market.*429/);
  assert.strictEqual(calls.create.length, 0);

  // …and the readable-but-empty case is a different answer with ok:true.
  const empty = harness({ ok: true, items: [] });
  const r2 = await seeder.seedChain("ethereum", { target: 50, apply: true, deps: empty.deps, gapMs: 0, spread: false, source: "gecko" });
  assert.strictEqual(r2.ok, true);
  assert.match(r2.why, /clear the floor/);
});

test("under `auto`, unreadable means BOTH sources failed — one answer is an answer", async () => {
  // A DexScreener outage while GeckoTerminal answers is not an unreadable
  // chain: GT is the authoritative enumeration here, and reporting its "there
  // is nothing above the floor" as "we could not look" would send the operator
  // to check a network that is fine.
  const half = harness({ ok: false, why: "ENOTFOUND", items: [] });
  const r = await seeder.seedChain("ethereum", { target: 50, deps: half.deps, gapMs: 0, spread: false });
  assert.strictEqual(r.ok, true, "GeckoTerminal answered");
  assert.strictEqual(half.calls.gecko.length, 1, "and it was asked, because DS came up short");

  const both = harness({ ok: false, why: "ENOTFOUND", items: [], geckoImpl: () => ({ ok: false, why: "cooldown", items: [] }) });
  const r2 = await seeder.seedChain("ethereum", { target: 50, deps: both.deps, gapMs: 0, spread: false });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.why, /could not read the market/);
});

test("a dry run plans and writes nothing", async () => {
  const { deps, calls } = harness({ items: [coin(1), coin(2), coin(3)] });
  const r = await seeder.seedChain("base", { target: 3, deps, gapMs: 0, spread: false });
  assert.strictEqual(r.planned, 3);
  assert.deepStrictEqual(r.listed, []);
  assert.strictEqual(calls.create.length, 0, "--apply is the only thing that writes");
});

test("one refusal does not end the run, and is reported", async () => {
  const { deps, calls } = harness({
    items: [coin(1), coin(2), coin(3)],
    createImpl: (chain, address, info) => {
      if (address === coin(2).address) throw new Error("site said 400");
      return { listing: {}, input: { sym: info.symbol } };
    },
  });
  const r = await seeder.seedChain("bsc", { target: 3, apply: true, deps, gapMs: 0, spread: false });
  assert.strictEqual(calls.create.length, 3, "the third candidate is still tried");
  assert.strictEqual(r.listed.length, 2);
  assert.strictEqual(r.failed, 1);
  assert.match(r.why, /1 refused by the site/);
});

test("token info is an UPGRADE — a failed lookup still lists the token", async () => {
  const { deps, calls } = harness({ items: [coin(1)] });
  deps.fetchTokenInfo = async () => {
    throw new Error("timeout");
  };
  const r = await seeder.seedChain("bsc", { target: 1, apply: true, deps, gapMs: 0, spread: false });
  assert.strictEqual(r.listed.length, 1);
  assert.strictEqual(calls.create[0].info.name, "Token 1", "GT's own name carries the listing");
});

test("an unknown chain is refused before anything is read", async () => {
  const { deps, calls } = harness({ items: [coin(1)] });
  const r = await seeder.seedChain("notachain", { target: 50, apply: true, deps, gapMs: 0, spread: false });
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /unknown chain/);
  assert.strictEqual(calls.top.length, 0);
});

test("it asks GT for far MORE than the shortfall, within GT's page limit", async () => {
  const { deps, calls } = harness({ items: [] });
  await seeder.seedChain("bsc", { target: 50, pages: 99, deps, gapMs: 0, spread: false });
  const [, o] = calls.top[0];
  // The biggest tokens on a chain are the ones most likely to be listed
  // already, so a limit of exactly `need` comes back mostly consumed.
  assert.ok(o.limit >= 50 * 4, `limit ${o.limit} must exceed the shortfall`);
  assert.strictEqual(o.pages, seeder.GT_MAX_PAGES, "GT serves 10 pages — asking for more is a wasted request");
});

test("createFromInfo is the ONE owner of turning a priced token into a listing", () => {
  // The seeder must not grow a second idea of what an auto listing is — the
  // rule trendFill was written under, and the reason everListed is honoured
  // through both doors.
  assert.strictEqual(typeof autoLister.createFromInfo, "function");
  assert.ok(!/createListing/.test(code()), "chainSeed must go through autoLister, never the API directly");
});


// ── GeckoTerminal's shared 120s cooldown ─────────────────────────────────────
//
// The first live dry run is what these are about. BSC read one page, GT 429'd
// on page 2 — which arms a PROCESS-WIDE cooldown — and the run then reported
// "only 7 token(s) on bsc clear the floor" plus two chains that were never
// asked anything at all:
//
//   ✗ base — could not read the market for base: cooldown
//   ✗ ethereum — could not read the market for ethereum: cooldown
//
// Every line of that is our own quota, printed as three facts about three
// chains. A bulk one-off is exactly the caller that can afford to wait.

test("a cooldown is WAITED OUT and the read RESUMES at the page that failed", async () => {
  let left = 120_000;
  const { deps, calls } = harness({
    cooldown: () => left,
    topImpl: (chain, o, n) =>
      n === 1
        ? { ok: true, why: "rate limited", nextPage: 2, pagesRead: 1, items: [coin(1)] }
        : { ok: true, why: null, nextPage: null, pagesRead: 3, items: [coin(2), coin(3)] },
    sleepImpl: async () => {
      left = 0;
    },
  });
  const r = await seeder.seedChain("bsc", { target: 3, apply: true, deps, gapMs: 0, spread: false });

  assert.strictEqual(calls.top.length, 2, "it asked again after waiting");
  assert.strictEqual(calls.top[1][1].startPage, 2, "resumed at the page that did NOT arrive");
  assert.ok(calls.slept[0] >= 120_000, `slept ${calls.slept[0]}ms — it must wait the cooldown out`);
  assert.strictEqual(r.listed.length, 3, "all three tokens found across the two reads");
  // Re-reading pages 1..N would spend the very quota that just ran out.
  assert.deepStrictEqual(calls.create.map((c) => c.address).sort(), [coin(1), coin(2), coin(3)].map((c) => c.address).sort());
});

test("a truncated read is reported as TRUNCATED, never as a thin chain", async () => {
  const { deps } = harness({
    cooldown: () => 0, // the cooldown already lifted; the read still ended early
    topImpl: () => ({ ok: true, why: "rate limited", nextPage: 2, pagesRead: 1, items: [coin(1)] }),
  });
  const r = await seeder.seedChain("bsc", { target: 50, deps, gapMs: 0, spread: false });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.truncated, "rate limited");
  // "only 1 token(s) on bsc clear the floor" would send the operator to lower
  // the market-cap floor for a problem that clears itself in two minutes.
  assert.match(r.why, /cut short/);
  assert.match(r.why, /Re-run to continue/);
  assert.ok(!/clear the floor/.test(r.why), "the quota must outrank the count");
});

test("the wait is BOUNDED — a stuck cooldown cannot hold the run for ever", async () => {
  const { deps, calls } = harness({
    cooldown: () => 120_000, // never lifts
    topImpl: () => ({ ok: true, why: "rate limited", nextPage: 2, pagesRead: 1, items: [coin(1)] }),
  });
  const r = await seeder.seedChain("bsc", { target: 50, deps, gapMs: 0, maxWaitMs: 200_000 });
  const total = calls.slept.reduce((a, b) => a + b, 0);
  assert.ok(total <= 200_000, `slept ${total}ms against a 200000ms budget`);
  assert.ok(calls.slept.length >= 1 && calls.slept.length < 20, "it stops, rather than spinning");
  assert.match(r.truncated, /wait budget is spent/);
});

test("only a COOLDOWN is worth sleeping on — a timeout answers the same in 2min", async () => {
  const { deps, calls } = harness({
    cooldown: () => 0,
    topImpl: () => ({ ok: true, why: "request failed", nextPage: 2, pagesRead: 1, items: [coin(1)] }),
  });
  await seeder.seedChain("bsc", { target: 50, deps, gapMs: 0, spread: false });
  assert.deepStrictEqual(calls.slept, [], "a dead socket is not a quota problem");
  assert.strictEqual(calls.top.length, 1);
});

test("waiting stops once there are enough candidates", async () => {
  const plenty = Array.from({ length: 300 }, (_, i) => coin(i + 1));
  const { deps, calls } = harness({
    cooldown: () => 120_000,
    topImpl: () => ({ ok: true, why: "rate limited", nextPage: 2, pagesRead: 1, items: plenty }),
  });
  await seeder.seedChain("bsc", { target: 50, deps, gapMs: 0, spread: false });
  assert.deepStrictEqual(calls.slept, [], "a target already met must not buy another two minutes");
});

test("topByMcap says WHERE it stopped, so a caller can resume there", async () => {
  const gt = require("../src/group/gtPairs");
  const bigCoins = require("../src/services/bigCoins");
  const asked = [];
  const real = gt.gtGet;
  try {
    gt.gtGet = async (path, params) => {
      asked.push(params.page);
      // page 3 is where the quota runs out
      if (params.page >= 3) return { ok: false, status: 429, reason: "rate limited" };
      return { ok: true, status: 200, body: { data: [], included: [] } };
    };
    const r = await bigCoins.topByMcap("bsc", { pages: 5, startPage: 2 });
    assert.deepStrictEqual(asked, [2, 3], "startPage is honoured, and it stops at the refusal");
    assert.strictEqual(r.nextPage, 3, "the page that did NOT arrive");
    assert.strictEqual(r.pagesRead, 1);
    assert.strictEqual(r.why, "rate limited");

    asked.length = 0;
    gt.gtGet = async (path, params) => {
      asked.push(params.page);
      return { ok: true, status: 200, body: { data: [], included: [] } };
    };
    const full = await bigCoins.topByMcap("bsc", { pages: 2 });
    assert.strictEqual(full.nextPage, null, "null means every page asked for was read");
    assert.strictEqual(full.why, null);
  } finally {
    gt.gtGet = real;
  }
});

test("the CLI halves its own GT budget BEFORE requiring the client", () => {
  // Two processes on one IP, each pacing itself at the free ceiling, is ~2x the
  // ceiling — which is how the first live run 429'd on its second page. And a
  // 429 the running BOT catches pauses every group's buy alerts for 120s, so
  // this script's convenience is charged to a paying customer's chat.
  //
  // ORDER is the rule, not presence: `gtPairs` freezes GT_MAX_RPM at require
  // time, so a line set after the require reads exactly like one that works.
  // The loadEnv guard is written the same way, for the same reason.
  const src = require("node:fs").readFileSync(require.resolve("../scripts/seed-chain.js"), "utf8");
  const set = src.indexOf("GT_MAX_RPM");
  const req = src.search(/require\('\.\.\/src\//);
  assert.ok(set > 0, "the script must lower its own GT budget");
  assert.ok(req > 0, "the script must require repo code (this guard is measuring nothing otherwise)");
  assert.ok(set < req, "GT_MAX_RPM must be set BEFORE the first repo require");
  // …and it must not overrule an operator who chose a number in .env.
  assert.match(src, /if \(!process\.env\.GT_MAX_RPM\)/);
});

test("a chain read only in PART exits non-zero — it is not a settled chain", () => {
  const src = require("node:fs").readFileSync(require.resolve("../scripts/seed-chain.js"), "utf8");
  assert.match(src, /process\.exit\(unreadable \|\| truncated \? 1 : 0\)/);
});

test("a progress renderer that throws cannot break the run", async () => {
  // The countdown is chrome. A broken terminal, a closed pipe, an EPIPE from a
  // dropped SSH session — none of them may cost the listings, which is the
  // same contract the banner renderers have with the posts they decorate.
  const { deps } = harness({ items: [coin(1), coin(2)] });
  const r = await seeder.seedChain("bsc", {
    target: 2,
    apply: true,
    deps,
    gapMs: 0,
    spread: false,
    onProgress() {
      throw new Error("EPIPE");
    },
  });
  assert.strictEqual(r.listed.length, 2);
});

test("progress reports a WAIT before sleeping, not after", async () => {
  // Reported after the sleep it is describing, a countdown says "I waited two
  // minutes" to somebody who has already decided the terminal is stuck.
  const seenEvents = [];
  let left = 120_000;
  const { deps } = harness({
    cooldown: () => left,
    topImpl: (chain, o, n) =>
      n === 1
        ? { ok: true, why: "rate limited", nextPage: 2, pagesRead: 1, items: [coin(1)] }
        : { ok: true, why: null, nextPage: null, pagesRead: 2, items: [coin(2)] },
    sleepImpl: async () => {
      seenEvents.push("slept");
      left = 0;
    },
  });
  await seeder.seedChain("bsc", {
    target: 3,
    apply: true,
    deps,
    gapMs: 0,
    spread: false,
    onProgress: (ev) => seenEvents.push(ev.kind),
  });
  assert.ok(seenEvents.indexOf("wait") < seenEvents.indexOf("slept"), "the wait is announced first");
  assert.ok(seenEvents.indexOf("slept") < seenEvents.indexOf("resume"), "and resume lands after it");
  assert.ok(seenEvents.includes("read"), "a page that arrived is reported too");
});

// ── Which market source the seeder uses ─────────────────────────────────────

test("`auto` asks DexScreener FIRST and GeckoTerminal only for the shortfall", async () => {
  // Neither alone is enough: DS has no pool ranking to paginate, GT has a
  // quota the buy alerts are also on. So the expensive one is asked only when
  // it can still change the answer.
  const filled = harness({ items: Array.from({ length: 40 }, (_, i) => coin(i + 1)) });
  await seeder.seedChain("bsc", { target: 5, deps: filled.deps, gapMs: 0, spread: false });
  assert.strictEqual(filled.calls.top.length, 1, "DexScreener leads");
  assert.deepStrictEqual(filled.calls.gecko, [], "a chain DS can fill never touches the quota");

  const short = harness({ items: [coin(1)] });
  const r = await seeder.seedChain("bsc", { target: 30, deps: short.deps, gapMs: 0, spread: false });
  assert.strictEqual(short.calls.gecko.length, 1, "…and it IS asked when DS came up short");
  assert.match(r.source, /dexscreener/);
});

test("`auto` MERGES, and a GeckoTerminal row never overwrites a richer one", async () => {
  const rich = { ...coin(1), logoUrl: "https://i/a.png", twitter: "https://x.com/a", enriched: true };
  const { deps, calls } = harness({
    items: [rich],
    geckoImpl: () => ({ ok: true, why: null, items: [{ ...coin(1) }, coin(2)], nextPage: null }),
  });
  const r = await seeder.seedChain("bsc", { target: 3, apply: true, deps, gapMs: 0, spread: false });
  assert.strictEqual(r.listed.length, 2, "the duplicate is not listed twice");
  const one = calls.create.find((c) => c.address === coin(1).address);
  // DS rows carry the logo and socials that make a seeded listing look real;
  // a GT row for the same token carries less, and must not replace it.
  assert.strictEqual(one.info.twitter, "https://x.com/a");
});

test("only `gecko` reads GeckoTerminal's cooldown — DexScreener has none", async () => {
  // `gather`'s wait/resume loop exists for GT's PROCESS-WIDE cooldown. A 429
  // from DexScreener is one request's answer, so sleeping two minutes on gt's
  // clock there would be waiting out a failure that had nothing to do with it.
  const gtMod = require("../src/group/gtPairs");
  try {
    gtMod.armCooldown("test"); // as if the bot had just been rate limited
    assert.ok(gtMod.cooldownRemaining() > 0, "the cooldown really is armed");
    const slept = [];
    const { deps } = harness({
      ok: true,
      why: "HTTP 429",
      items: [coin(1)],
      topImpl: () => ({ ok: true, why: "HTTP 429", nextPage: 2, pagesRead: 1, items: [coin(1)] }),
      sleepImpl: async (ms) => slept.push(ms),
    });
    deps.cooldownRemaining = undefined; // let the real clock through
    const r = await seeder.seedChain("bsc", { target: 50, source: "dexscreener", deps, gapMs: 0, spread: false });
    assert.deepStrictEqual(slept, [], "GT's cooldown is not this source's cooldown");
    assert.strictEqual(r.truncated, "HTTP 429", "…and the truncation is still reported honestly");
  } finally {
    gtMod._reset();
  }
});

test("a candidate that arrived enriched is not looked up a second time", async () => {
  const { deps, calls } = harness({
    items: [
      { ...coin(1), enriched: true, twitter: "https://x.com/a", logoUrl: "https://i/a.png" },
      { ...coin(2), enriched: false },
    ],
  });
  const r = await seeder.seedChain("bsc", { target: 2, apply: true, deps, gapMs: 0, spread: false });
  assert.strictEqual(r.listed.length, 2);
  assert.deepStrictEqual(calls.info.map((c) => c[1]), [coin(2).address], "only the bare one pays for a lookup");
  // …and the socials it arrived with still reach the listing.
  const enriched = calls.create.find((c) => c.address === coin(1).address);
  assert.strictEqual(enriched.info.twitter, "https://x.com/a");
});

test("no liquidity floor by default — the operator's call, stated", async () => {
  // "min mc 1 juta gada vol dll". A cap with no depth behind it is a real
  // hazard, so `--min-liq=` still works; it is simply not imposed.
  assert.strictEqual(seeder.DEFAULTS.minLiq, 0);
  assert.strictEqual(seeder.DEFAULTS.minMcap, 1_000_000);
  const { deps, calls } = harness({ items: [coin(1)] });
  await seeder.seedChain("bsc", { target: 1, deps, gapMs: 0, spread: false });
  assert.strictEqual(calls.top[0][1].minLiq, 0);
  assert.strictEqual(calls.top[0][1].minMcap, 1_000_000);
});

// ── "setiap chain harus beda2 jumlah totalnya jangan sama" ──────────────────

test("every chain gets its OWN total, and no two of the big ones collide", () => {
  const chains = ["bsc", "base", "ethereum", "solana", "robinhood", "polygon", "arbitrum", "avalanche"];
  const targets = chains.map((c) => seeder.targetFor(c, 100));
  for (const t of targets) assert.ok(t >= 70 && t <= 100, `${t} is outside [70, 100]`);
  // One number for every chain makes a site read as generated rather than as a
  // market — the same complaint the trending board's fixed perChain produced.
  assert.ok(new Set(targets).size >= chains.length - 2, `too many chains share a total: ${targets}`);
});

test("⚠️ the total is STABLE per chain — a rolled one would break `up to`", () => {
  // The whole feature rests on the target being UP TO rather than add-N: a
  // re-run must list nothing on a chain already there. A target that rolled
  // fresh each run destroys exactly that — one run picks 94, the next picks 78
  // and calls the chain over target, the one after picks 99 and lists five
  // more, for ever. Derived from the chain name, never Math.random().
  for (let i = 0; i < 5; i++) assert.strictEqual(seeder.targetFor("bsc", 100), seeder.targetFor("bsc", 100));
  // Comments stripped — the header explaining the rule would fail its own guard.
  assert.ok(!/Math\.random/.test(code()), "a seeded target may never be random");
});

test("a pinned range is one number, and the ceiling is never exceeded", () => {
  assert.strictEqual(seeder.targetFor("bsc", 50, 50), 50);
  for (const c of ["bsc", "base", "ethereum", "solana"]) {
    assert.ok(seeder.targetFor(c, 50, 50) === 50);
    assert.ok(seeder.targetFor(c, 100) <= 100, "the number the operator typed is the CEILING");
  }
});

test("the spread reaches the run — a chain seeds to ITS number, not the ceiling", async () => {
  const { deps } = harness({ items: [] });
  const r = await seeder.seedChain("base", { target: 100, deps, gapMs: 0 });
  assert.strictEqual(r.target, seeder.targetFor("base", 100));
  assert.notStrictEqual(r.target, 100, "base's own number is not the ceiling");
});

test("--same pins every chain to the ceiling, for when one number IS wanted", async () => {
  const { deps } = harness({ items: [] });
  const r = await seeder.seedChain("base", { target: 100, spread: false, deps, gapMs: 0 });
  assert.strictEqual(r.target, 100);
});

test("the CLI offers --all and --same, and defaults to the auto source", () => {
  const src = require("node:fs").readFileSync(require.resolve("../scripts/seed-chain.js"), "utf8");
  // A flag that is documented and not wired, or wired and not documented, is
  // a feature nobody finds — the lesson `fr_open` cost one repo over.
  for (const f of ["--all", "--same", "--target-min", "--source"]) {
    assert.ok(src.includes(f), `${f} is not in the CLI`);
  }
  assert.match(src, /flags\.includes\('--all'\)/, "--all must be read, not only printed");
  assert.match(src, /flags\.includes\('--same'\)/, "--same must be read, not only printed");
  assert.strictEqual(seeder.DEFAULTS.source, "auto");
});

// ── The GeckoTerminal top-up may not hold the run ───────────────────────────

test("under `auto` the GT top-up NEVER sleeps by default", async () => {
  // At --target=100 DexScreener will essentially never fill a chain, so GT is
  // asked on EVERY chain and is rate limited on every request. With --all that
  // is 22 chains × several 120-second waits — hours, for a job whose whole
  // point was not to wait.
  const slept = [];
  const { deps } = harness({
    items: [coin(1)],
    geckoImpl: () => ({ ok: true, why: "rate limited", nextPage: 2, pagesRead: 0, items: [] }),
    cooldown: () => 120_000,
    sleepImpl: async (ms) => slept.push(ms),
  });
  const r = await seeder.seedChain("solana", { target: 100, deps, gapMs: 0, spread: false });
  assert.deepStrictEqual(slept, [], "the top-up takes what it can get and moves on");
  assert.ok(r.topUp, "…and says the chain can be topped up");
});

test("a GT skip is a TOP-UP, never a warning — or the real warnings stop being read", async () => {
  const { deps } = harness({
    items: [coin(1)],
    geckoImpl: () => ({ ok: true, why: "cooldown", nextPage: 1, pagesRead: 0, items: [] }),
    cooldown: () => 120_000,
  });
  const r = await seeder.seedChain("solana", { target: 100, deps, gapMs: 0, spread: false });
  // `truncated` is loud — yellow, and a non-zero exit. Firing it on every one
  // of 22 chains would paint a working run red, and a warning that fires every
  // time is one nobody sees when it finally matters.
  assert.strictEqual(r.truncated, null);
  assert.match(r.topUp, /cooldown/);
  assert.strictEqual(r.ok, true);
});

test("--gt-wait restores the wait, and --source=gecko still waits", async () => {
  let left = 120_000;
  const slept = [];
  const mk = () =>
    harness({
      items: [coin(1)],
      geckoImpl: (chain, o, n) =>
        n === 1
          ? { ok: true, why: "rate limited", nextPage: 2, pagesRead: 1, items: [] }
          : { ok: true, why: null, nextPage: null, pagesRead: 2, items: [coin(2)] },
      topImpl: (chain, o, n) =>
        n === 1
          ? { ok: true, why: "rate limited", nextPage: 2, pagesRead: 1, items: [coin(1)] }
          : { ok: true, why: null, nextPage: null, pagesRead: 2, items: [coin(2)] },
      cooldown: () => left,
      sleepImpl: async (ms) => {
        slept.push(ms);
        left = 0;
      },
    });

  const a = mk();
  await seeder.seedChain("solana", { target: 100, deps: a.deps, gapMs: 0, spread: false, gtWaitMs: 200_000 });
  assert.ok(slept.length >= 1, "an operator who asks for the wait gets it");

  slept.length = 0;
  left = 120_000;
  const b = mk();
  await seeder.seedChain("solana", { target: 100, deps: b.deps, gapMs: 0, spread: false, source: "gecko" });
  // There GT is the ONLY source, so waiting is the whole strategy rather than
  // a bonus that can be skipped.
  assert.ok(slept.length >= 1, "--source=gecko still waits it out");
});

test("the CLI reports a top-up as recoverable, not as a failure", () => {
  const src = require("node:fs").readFileSync(require.resolve("../scripts/seed-chain.js"), "utf8");
  assert.match(src, /can be topped up/);
  assert.match(src, /--gt-wait/);
  // Only an unreadable or truncated chain is worth a non-zero exit; a top-up
  // is the expected state of every chain here and re-running continues it.
  assert.match(src, /process\.exit\(unreadable \|\| truncated \? 1 : 0\)/);
  assert.ok(!/toppable \? 1/.test(src), "a top-up must not fail the run");
});

// ── "setiap token harus punya logonya" ─────────────────────────────────────

test("a token with no logo ANYWHERE is never listed", async () => {
  // A blank circle reads as broken rather than as a project that has not
  // uploaded artwork, and on a seeded board that would be most of the page.
  // "Anywhere" is the operative word — the market read is one source of four.
  const { deps, calls } = harness({
    items: [coin(1, { logoUrl: null }), coin(2, { logoUrl: "" }), coin(3)],
  });
  deps.fetchTokenInfo = async () => ({ name: "Enriched" }); // enrichment has none either
  const r = await seeder.seedChain("bsc", { target: 3, apply: true, deps, gapMs: 0, spread: false });
  assert.deepStrictEqual(calls.create.map((c) => c.address), [coin(3).address]);
  assert.match(r.why, /2 had no logo/, "and the shortfall says WHY, not just that it is short");
  // …and it did not give up without asking the other sources.
  assert.deepStrictEqual(calls.logo.map((c) => c[1]).sort(), [coin(1).address, coin(2).address].sort());
});

test("a logo found by ANOTHER source rescues the listing", async () => {
  // "cari sumber logo entah dri dexscrener pumpfun atau apalah cri dri banyak
  // sumber" — a candidate that arrives without artwork is not yet a candidate
  // without artwork.
  const { deps, calls } = harness({
    items: [coin(1, { logoUrl: null })],
    logoImpl: async () => ({ url: "https://pump.test/a.png", source: "launchpad" }),
  });
  deps.fetchTokenInfo = async () => ({ name: "Enriched" });
  const r = await seeder.seedChain("bsc", { target: 1, apply: true, deps, gapMs: 0, spread: false });
  assert.strictEqual(r.listed.length, 1);
  assert.strictEqual(calls.create[0].info.logoUrl, "https://pump.test/a.png");
});

test("an http-only logo is refused — the site serves https", async () => {
  const { deps, calls } = harness({ items: [coin(1, { logoUrl: "http://insecure/x.png" })] });
  deps.fetchTokenInfo = async () => ({ name: "Enriched" });
  await seeder.seedChain("bsc", { target: 1, apply: true, deps, gapMs: 0, spread: false });
  assert.deepStrictEqual(calls.create, []);
});

test("⚠️ the logo is re-checked at CREATE, not only when planning", async () => {
  // Enrichment can only ADD a logo, never remove one — but a candidate whose
  // url turns out unusable must not slip through on the strength of having had
  // one when it was planned.
  const { deps, calls } = harness({ items: [coin(1)] });
  deps.fetchTokenInfo = async () => ({ logoUrl: "" }); // answers, with nothing usable
  const r = await seeder.seedChain("bsc", { target: 1, apply: true, deps, gapMs: 0, spread: false });
  // The candidate's own https logo survives the merge, so this one still lists…
  assert.strictEqual(calls.create.length, 1);
  assert.strictEqual(calls.create[0].info.logoUrl, coin(1).logoUrl);
  assert.strictEqual(r.listed.length, 1);
});
