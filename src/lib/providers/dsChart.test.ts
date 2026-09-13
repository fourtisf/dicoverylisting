// THE SECOND CANDLE SOURCE.
//
// "beberapa token chartnya tidak ada, mending tambahkan api dari dexscreener",
// reported with the token page showing:
//
//     Chart unavailable right now
//     Couldn't read the chart just now (GeckoTerminal 429 (rate limited)).
//
// Every test here fails on a plausible half-fix, and the two at the top are the
// ones that would have shipped a source that answers perfectly and draws
// nothing: a millisecond timestamp silently refused as "the future", and a
// DexScreener PAIR address published where a GeckoTerminal POOL id is expected.
//
// No network: `fetch` is stubbed throughout.
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chartPrefOf } from "../ohlcv.ts";
import {
  DS_RES,
  _dsChartReset,
  barToRow,
  barsOf,
  dsArmCooldown,
  dsCandles,
  dsChartBases,
  dsChartPaths,
  dsChartQuery,
  dsCooldownWhy,
  dsInCooldown,
  dsPairUrl,
  dsTopPair,
  toSeconds,
} from "./dsChart.ts";
import { TIMEFRAMES } from "../ohlcv.ts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Comment-stripped source, for the guards — a rule stated in a comment is not
 *  a rule, and a test that matched one would pass on code that broke it. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const PAIR = { pairAddress: "0xPAIR", dexId: "uniswap", chainId: "bsc", liquidityUsd: 100_000 };

/** Route `fetch` by URL. A handler may return a body, or `{status}` to answer
 *  with one, or throw to simulate a transport failure. */
function stubFetch(router: (url: string) => unknown) {
  const orig = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    seen.push(u);
    const out = router(u) as { status?: number; body?: unknown } | unknown;
    const r = out as { status?: number; body?: unknown };
    if (r && typeof r === "object" && typeof r.status === "number") {
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: { get: () => null },
        body: { cancel: async () => {} },
        json: async () => r.body ?? null,
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: { cancel: async () => {} },
      json: async () => out,
    } as unknown as Response;
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = orig; } };
}

// ── the two that would have shipped a silent blank ───────────────────────────

test("⚠️ a MILLISECOND timestamp is converted — everything downstream is seconds", () => {
  // `Candle.t` is documented as seconds (GeckoTerminal's unit), CandleChart
  // multiplies it by 1000, and normalizeCandles refuses a stamp more than six
  // hours ahead. So a millisecond feed is not merely wrong: every candle is
  // DROPPED as "the future", the list comes back empty, and the panel reports
  // "no candles on this timeframe" about a source that answered perfectly.
  const ms = 1_756_200_000_000;
  assert.strictEqual(toSeconds(ms), 1_756_200_000);
  // …and a value already in seconds is left alone. Both spellings are plausible
  // from an undocumented feed, and guessing one costs the whole chart.
  assert.strictEqual(toSeconds(1_756_200_000), 1_756_200_000);
  const row = barToRow({ t: ms, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 });
  assert.deepStrictEqual(row, [1_756_200_000, 1, 2, 0.5, 1.5, 10]);
});

test("⚠️ the DS PAIR address never reaches a field that means a GT POOL", () => {
  // This repo states the rule in seven places: /api/pool and /api/trades read
  // the `pool:` cache and hand its value to GeckoTerminal, and CandleChart used
  // to build a geckoterminal.com/<network>/pools/<pool> link out of it. A pair
  // address in any of them 404s inside the token page.
  const route = code(read("src/app/api/ohlcv/route.ts"));
  const dsWin = route.slice(route.indexOf('source: "dexscreener"') - 400, route.indexOf('source: "dexscreener"') + 200);
  assert.match(dsWin, /pool: gt\.pool/, "a DexScreener answer still reports GT's pool — never the DS pair");
  assert.ok(!/pool: ds\./.test(route), "the DS pair was published as `pool`");
  // The provider must not touch the shared pool cache either — that key is read
  // by two other routes that hand its value straight to GeckoTerminal.
  const prov = code(read("src/lib/providers/dsChart.ts"));
  assert.ok(!/poolCache|cachedPool|`pool:/.test(prov), "the DS provider wrote into the GT pool namespace");
});

// ── the request shape, and why every part of it is overridable ───────────────

test("a base LIST, and _API pins one AND skips the list", () => {
  // An override and a SKIP — the same contract <CHAIN>_V4_POOLMANAGER, JUP_BASE
  // and LAUNCHPAD_<PAD>_API already have. An operator who pinned a host must
  // not be outvoted by a default further down the list.
  assert.deepStrictEqual(dsChartBases("https://pinned.example/"), ["https://pinned.example"]);
  const dflt = dsChartBases("");
  assert.ok(dflt.length >= 1);
  assert.ok(dflt.includes("https://io.dexscreener.com"));
  // An extra base goes in FRONT of the shipped one, current-first.
  assert.deepStrictEqual(dsChartBases("", "https://a.example, https://b.example").slice(0, 2), [
    "https://a.example",
    "https://b.example",
  ]);
});

test("the PATH is a template list too — a renamed segment is a .env line, not a deploy", () => {
  // The whole reason an unverified request shape may ship: DexScreener
  // publishes no OHLCV endpoint, so this is a guess about somebody else's
  // private API and it has to be fixable without a build.
  const dflt = dsChartPaths("");
  assert.ok(dflt.length >= 2, "more than one spelling ships — the AMM family decides which");
  for (const p of dflt) {
    assert.match(p, /\{dex\}/);
    assert.match(p, /\{chain\}/);
    assert.match(p, /\{pair\}/);
  }
  assert.deepStrictEqual(dsChartPaths("/x/{dex}/{chain}/{pair}"), ["/x/{dex}/{chain}/{pair}"]);
});

test("every timeframe has a resolution — a table, never arithmetic", () => {
  // A combination the upstream does not serve comes back an error, which is
  // exactly why `TF` is a table and not a calculation.
  for (const tf of TIMEFRAMES) assert.ok(DS_RES[tf], `${tf} has no DexScreener resolution`);
  assert.strictEqual(DS_RES["1d"], "1D", "days are not minutes");
});

test("the bar list is found whatever it is wrapped in", () => {
  // Not a published contract, so a renamed envelope key must cost nothing.
  const bars = [{ t: 1, o: 1, h: 1, l: 1, c: 1 }];
  assert.deepStrictEqual(barsOf(bars), bars);
  assert.deepStrictEqual(barsOf({ bars }), bars);
  assert.deepStrictEqual(barsOf({ data: { bars } }), bars);
  assert.deepStrictEqual(barsOf({ schemaVersion: "1", candles: bars }), bars);
  assert.strictEqual(barsOf({ nothing: 1 }), null, "an unreadable shape is null, never an empty list");
});

test("a bar missing a price is dropped; a missing VOLUME is a zero", () => {
  // The rule normalizeCandles already states: a quiet five minutes is a fact,
  // and dropping an otherwise good candle over it loses real history.
  assert.strictEqual(barToRow({ t: 1, o: 1, h: 2, l: 0.5 }), null, "no close → not a candle");
  assert.deepStrictEqual(barToRow({ t: 1, o: 1, h: 2, l: 0.5, c: 1.5 }), [1, 1, 2, 0.5, 1.5, 0]);
  // Parallel-array bars are a UDF shape and are read too.
  assert.deepStrictEqual(barToRow([1, 1, 2, 0.5, 1.5, 7]), [1, 1, 2, 0.5, 1.5, 7]);
  assert.strictEqual(barToRow("nope"), null);
});

// ── the pair lookup ──────────────────────────────────────────────────────────

test("the pair is OUR token's DEEPEST, base side only", async () => {
  // Base-side: a token also appears as the QUOTE side of somebody else's pair,
  // and charting that draws the other asset's price under our ticker — the
  // wrong number rather than a missing one, which is the worse of the two.
  // Deepest: a real token seen through a thin pool reads as a different asset.
  _dsChartReset();
  const f = stubFetch(() => [
    { chainId: "bsc", dexId: "pancake", pairAddress: "THIN", baseToken: { address: "0xUS" }, liquidity: { usd: 1_000 } },
    { chainId: "bsc", dexId: "pancake", pairAddress: "DEEP", baseToken: { address: "0xUS" }, liquidity: { usd: 900_000 } },
    { chainId: "bsc", dexId: "pancake", pairAddress: "QUOTE", baseToken: { address: "0xOTHER" }, liquidity: { usd: 9e9 } },
  ]);
  try {
    const r = await dsTopPair("bsc", "0xUS");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.pair?.pairAddress, "DEEP", "the thin pair or the quote-side one won");
  } finally {
    f.restore();
  }
});

test("'no pair' and 'could not ask' are different answers", async () => {
  // The pumpfunNewX rule, on the surface that publishes charts. Collapsing them
  // is how one rate-limited minute is cached as "this token has no history".
  _dsChartReset();
  let f = stubFetch(() => ({ status: 404 }));
  try {
    const r = await dsTopPair("bsc", "0xUS");
    assert.strictEqual(r.ok, true, "a 404 is an ANSWER about the token");
    assert.strictEqual(r.pair, null);
  } finally {
    f.restore();
  }
  _dsChartReset();
  f = stubFetch(() => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }); });
  try {
    const r = await dsTopPair("bsc", "0xUS");
    assert.strictEqual(r.ok, false, "a dead socket is NOT an answer about the token");
    assert.match(r.why!, /ENOTFOUND/, "the syscall is never dropped — `fetch failed` alone names nothing");
  } finally {
    f.restore();
  }
});

// ── candles ──────────────────────────────────────────────────────────────────

test("candles come back through the ONE normaliser, sorted and cleaned", async () => {
  // normalizeCandles owns every rule about a candle list. A second source that
  // grew its own idea of a valid candle is the two-pump.fun-hosts defect, on
  // the surface a person is looking at.
  _dsChartReset();
  const now = 1_756_200_000_000;
  const f = stubFetch((u) => {
    if (u.includes("token-pairs")) return [{ chainId: "bsc", dexId: "uniswap", pairAddress: "0xPAIR", baseToken: { address: "0xus" }, liquidity: { usd: 5e5 } }];
    return {
      bars: [
        // Deliberately out of order, in MILLISECONDS, with one zero close.
        { t: now - 900_000, o: 2, h: 2.4, l: 1.9, c: 2.2, v: 5 },
        { t: now - 1_800_000, o: 1, h: 1.2, l: 0.9, c: 1.1, v: 3 },
        { t: now - 2_700_000, o: 0, h: 0, l: 0, c: 0, v: 0 },
      ],
    };
  });
  try {
    const r = await dsCandles("bsc", "0xUS", "15m", { now });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.candles.length, 2, "the zero-priced row is not a price");
    assert.ok(r.candles[0].t < r.candles[1].t, "sorted by timestamp, never trusted by position");
    assert.ok(r.candles.every((c) => c.t < now / 1000 + 1), "…and in seconds, or they read as the future");
    assert.strictEqual(r.pair?.pairAddress, "0xPAIR");
  } finally {
    f.restore();
  }
});

test("a 404 tries the OTHER path; a 429 does not", async () => {
  // ⚠️ TWO DIFFERENT FAILOVER RULES, and mixing them is the bug. Across BASES
  // it is transport only — an HTTP status means the host answered and the same
  // request gets the same status everywhere else. Across PATHS a 404 is worth
  // retrying, because that is a DIFFERENT RESOURCE on the same host and "that
  // spelling is not here" is exactly when the other spelling is right.
  _dsChartReset();
  let tried: string[] = [];
  let f = stubFetch((u) => {
    if (u.includes("token-pairs")) return [{ chainId: "bsc", dexId: "uniswap", pairAddress: "0xPAIR", baseToken: { address: "0xus" }, liquidity: { usd: 1 } }];
    tried.push(u);
    return u.includes("/v3/") ? { status: 404 } : { bars: [{ t: 1_756_200_000_000, o: 1, h: 1, l: 1, c: 1, v: 1 }] };
  });
  try {
    const r = await dsCandles("bsc", "0xUS", "15m", { now: 1_756_200_000_000 });
    assert.strictEqual(r.ok, true, "the second path was never tried");
    assert.strictEqual(tried.length, 2);
    assert.match(tried[1], /\/v2\//);
  } finally {
    f.restore();
  }

  _dsChartReset();
  tried = [];
  f = stubFetch((u) => {
    if (u.includes("token-pairs")) return [{ chainId: "bsc", dexId: "uniswap", pairAddress: "0xPAIR", baseToken: { address: "0xus" }, liquidity: { usd: 1 } }];
    tried.push(u);
    return { status: 429 };
  });
  try {
    const r = await dsCandles("bsc", "0xUS", "15m", { bases: ["http://first.example", "http://second.example"] });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(tried.length, 1, "a 429 was retried — it says nothing about which path or host is right");
    assert.match(r.why!, /429/);
  } finally {
    f.restore();
  }
});

test("a TRANSPORT failure is the one thing that moves to the next base", async () => {
  // The other half of the rule, and the half the shipped one-entry base list
  // can never exercise: a host that never answered says nothing about the
  // request, so the next host is worth asking. `JUP_BASES`, verbatim.
  _dsChartReset();
  const hosts: string[] = [];
  const f = stubFetch((u) => {
    if (u.includes("token-pairs")) return [{ chainId: "bsc", dexId: "uniswap", pairAddress: "0xPAIR", baseToken: { address: "0xus" }, liquidity: { usd: 1 } }];
    const host = new URL(u).host;
    hosts.push(host);
    if (host === "dead.example") throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return { bars: [{ t: 1_756_200_000_000, o: 1, h: 1, l: 1, c: 1, v: 1 }] };
  });
  try {
    const r = await dsCandles("bsc", "0xUS", "15m", { now: 1_756_200_000_000, bases: ["http://dead.example", "http://live.example"] });
    assert.strictEqual(r.ok, true, "a dead host ended the lookup instead of moving on");
    assert.strictEqual(r.candles.length, 1);
    assert.ok(hosts.includes("live.example"), "the second base was never asked");
    // …and it did not burn the second PATH on the dead host first: a transport
    // failure is about the host, not the spelling.
    assert.strictEqual(hosts.filter((h) => h === "dead.example").length, 1);
  } finally {
    f.restore();
  }
});

test("⚠️ the base rule holds at the END of the path list too", async () => {
  // Falling out of the path loop means every spelling ANSWERED, with a 404 —
  // the host is plainly there and saying no, so another base would say the same.
  // Without an explicit stop the inner `continue` leaks into the outer loop and
  // the rule is true in the comment and false in the code.
  //
  // ⚠️ IT NEEDS TWO BASES TO MEAN ANYTHING. The shipped list has one, so a test
  // driving the real list cannot tell a correct loop from a broken one — and
  // the first version of this test was exactly that: deleting the stop left the
  // whole suite green. Caught by mutating the source, not by reading it.
  _dsChartReset();
  const hosts = new Set<string>();
  const f = stubFetch((u) => {
    if (u.includes("token-pairs")) return [{ chainId: "bsc", dexId: "uniswap", pairAddress: "0xPAIR", baseToken: { address: "0xus" }, liquidity: { usd: 1 } }];
    hosts.add(new URL(u).host);
    return { status: 404 };
  });
  try {
    const r = await dsCandles("bsc", "0xUS", "15m", { bases: ["http://first.example", "http://second.example"] });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(hosts.size, 1, `a second base was tried after a host answered 404: ${[...hosts].join(", ")}`);
    assert.strictEqual([...hosts][0], "first.example");
    // …and the reason blames the GUESS, not the pool. DexScreener's own API
    // named this pair a moment ago, so "no chart here" is far more likely to be
    // our path than their data — and it is a .env fix, which is the whole point
    // of the override contract.
    assert.match(r.why!, /DS_CHART_PATH/);
  } finally {
    f.restore();
  }
});

test("a 429 arms a cooldown, and nothing asks again while it holds", async () => {
  // A client that hammers through its own 429 is precisely the defect gt.ts was
  // written to end. Adding a second upstream without one reintroduces it a host
  // over.
  _dsChartReset();
  assert.strictEqual(dsInCooldown(), false);
  dsArmCooldown(60_000);
  assert.strictEqual(dsInCooldown(), true);
  const f = stubFetch(() => { throw new Error("no request may be made while the cooldown holds"); });
  try {
    const r = await dsCandles("bsc", "0xUS", "15m");
    assert.strictEqual(r.ok, false);
    assert.match(r.why!, /cooling down/, "…and it says so, so the caller treats it as 'could not ask'");
  } finally {
    f.restore();
    _dsChartReset();
  }
});

test("a chain DexScreener does not carry is an ANSWER, not a failure", async () => {
  // A chain with no `dexscreener` slug in the registry costs one source and is
  // never a failure. Robinhood used to be the live example until DexScreener
  // added the chain (~July 2026); an unregistered id keeps the rule testable.
  _dsChartReset();
  const r = await dsCandles("no-such-chain", "ANY", "15m");
  assert.strictEqual(r.ok, true, "ok:false would read as 'DexScreener is down'");
  assert.deepStrictEqual(r.candles, []);
  assert.match(r.why!, /does not carry/);
});

test("an unrecognised envelope names the env var that fixes it", async () => {
  // "It answered with nothing" and "it answered in a shape we cannot read" are
  // different facts, and only the first is about the pool. The second is ours,
  // and it is fixable without a deploy — which is the whole licence for
  // shipping a request shape nobody here has exercised.
  _dsChartReset();
  const f = stubFetch((u) =>
    u.includes("token-pairs")
      ? [{ chainId: "bsc", dexId: "uniswap", pairAddress: "0xPAIR", baseToken: { address: "0xus" }, liquidity: { usd: 1 } }]
      : { somethingElse: true },
  );
  try {
    const r = await dsCandles("bsc", "0xUS", "15m");
    assert.strictEqual(r.ok, false);
    assert.match(r.why!, /DS_CHART_BARS_KEY/);
  } finally {
    f.restore();
  }
});

test("the human link is built from the PAIR — the one place that is the right value", () => {
  assert.strictEqual(dsPairUrl(PAIR), "https://dexscreener.com/bsc/0xPAIR");
});

// ── the route: GT first, DexScreener when GT cannot answer ───────────────────

test("⚠️ GeckoTerminal is NOT asked while its cooldown holds", () => {
  // This is the state the report was taken in: one 429 anywhere arms a
  // process-wide 120s silence and every chart on the site reads "GeckoTerminal
  // 429 (rate limited)". Answering during exactly that window is the entire
  // reason a second source exists — so the route must reach for it rather than
  // spend a call that cannot succeed.
  const route = code(read("src/app/api/ohlcv/route.ts"));
  assert.match(route, /gtInCooldown\(\)/, "the route must check before it asks");
  assert.match(route, /dsCandles\(/, "…and reach the second source");
  // Positions, not a literal: the argument list is not the property under test,
  // and a guard test that breaks on a `!` is a test about formatting.
  const gtCall = route.indexOf("await fromGeckoTerminal(");
  const guard = route.indexOf("!gtInCooldown()");
  assert.ok(gtCall > 0, "the GT read must still be a call this test can find");
  assert.ok(guard > 0 && guard < gtCall, "the cooldown is checked BEFORE the GT read, not after");
});

test("a guess must lose to an answer — GeckoTerminal stays first BY DEFAULT", () => {
  // DexScreener's candle shape is a guess about somebody else's private API;
  // GT's is documented, and its pool ids are what `pool` means to every other
  // route. `pickLogo` states the same rule one pipeline over.
  //
  // ⚠️ THIS IS NOW ABOUT THE DEFAULT, because an operator asked to reorder it:
  // "saya ingin pakai api dexscreener aja untuk chart". Their call to make —
  // GeckoTerminal's ~30 req/min is per IP and shared with four bot processes,
  // so a chart that reaches for DexScreener first leaves that allowance for
  // everything else. What may NOT change is that an unset `CHART_SOURCE`
  // resolves to the documented source, and that the guess never becomes the
  // ONLY source (see the next test).
  const route = code(read("src/app/api/ohlcv/route.ts"));
  assert.match(route, /chartPrefOf\(process\.env\.CHART_SOURCE\)/, "the order is an operator preference");
  assert.match(route, /if \(dsFirst\) \{/, "…and it is ONE boolean, so the two sources cannot drift");
  // Blank resolves to `auto`, and `auto` is GT-first.
  assert.equal(chartPrefOf(undefined), "auto");
  assert.equal(chartPrefOf(""), "auto");
  assert.equal(chartPrefOf("   "), "auto");
  assert.equal(chartPrefOf("nonsense"), "auto", "an unreadable value is the shipped default, never a guess");
  assert.equal(chartPrefOf("dexscreener"), "dexscreener");
  assert.equal(chartPrefOf("DS"), "dexscreener");
  assert.equal(chartPrefOf("geckoterminal"), "geckoterminal");
});

test("⚠️ reordering is an ORDER, never a deletion — the guess is never the only source", () => {
  // Making a guess primary is a legitimate trade: it costs nothing while it
  // works. Making it the ONLY source means the day DexScreener renames a path,
  // every chart on the site goes dark with no way back. `CHART_SOURCE` moves
  // GT behind DexScreener; it does not switch it off.
  const route = code(read("src/app/api/ohlcv/route.ts"));
  // In the DexScreener-first branch, GeckoTerminal is still asked afterwards.
  const branch = route.slice(route.indexOf("if (dsFirst) {"), route.indexOf("// ── Nothing to draw"));
  assert.match(branch, /askDs\(\)[\s\S]*askGtNow\(\)/, "DS first, then GT — both asked");
  assert.match(branch, /askGtNow\(\)[\s\S]*askDs\(\)/, "…and GT first, then DS, in the other mode");
  // `askGt` may only be switched off by the ?source= PIN (the check script's
  // seam), never by the operator's ordering preference.
  assert.match(route, /const askGt = Boolean\(network\) && pin !== "dexscreener";/);
  assert.ok(!/const askGt = [^;]*PREF/.test(route), "the preference must not silence GeckoTerminal");
});

test("both reasons travel when neither source could be asked", () => {
  // "GeckoTerminal 429" alone, with a second source silently unreachable behind
  // it, is the shrug this endpoint has already been fixed for once.
  const route = code(read("src/app/api/ohlcv/route.ts"));
  assert.match(route, /gtSilent \? gt\.why : null/);
  assert.match(route, /const dsWhy = dsSilent \? \(ds\?\.why \?\? "DexScreener was not asked"\)/);
  assert.match(route, /reasons = \[gtSilent \? gt\.why : null, dsWhy\]/, "both, still joined");
  // ⚠️ The attempted URL rides along ONLY under the `?source=` pin — the check
  // script's seam. A visitor must never see a raw upstream URL in the panel,
  // and an operator cannot fix a guessed request shape they cannot see.
  assert.match(route, /pin && ds\?\.url \? ` \[tried \$\{ds\.url\}\]` : ""/);
  // …and the sentence must still carry "couldn't read", because the panel
  // classifies error-vs-answer on that substring and only errors get the fast
  // retry that lets a chart appear the moment a cooldown lifts.
  //
  // ⚠️ ASSERTED AS A PROPERTY, NOT AS THE LITERAL. This used to match
  // `Couldn't read the chart just now (${readWhy(err)})` — the exact spelling of
  // the code — so it failed on a fix that kept every one of its guarantees: the
  // joined reason now goes to the LOG and the visitor gets a translated
  // sentence, because the raw one names two env vars and this process's budget
  // and was being rendered on a public token page. What must hold is that the
  // reason still reaches the operator and the words still reach the panel.
  assert.match(route, /console\.warn\([^\n]*readWhy\(err\)/, "the full reason must still reach the log");
  assert.match(route, /publicNote\("the chart", err\)/, "…and the visitor gets the translated one");
  const note = code(read("src/lib/publicNote.ts"));
  assert.match(note, /Couldn't read \$\{subject\} just now/, "both branches keep the classifier's words");
  assert.ok(!/`Live [^`]*\$\{subject\}/.test(note), "a sentence without \"couldn't read\" stops the fast retry");
  assert.match(code(read("src/components/CandleChart.tsx")), /couldn't read/i);
});

test("⚠️ a source that could not be ASKED is THROWN, so it is never cached", () => {
  // `load()` IS the cached loader. A returned failure goes straight into the
  // cache for the timeframe's TTL — up to FIFTEEN MINUTES on 1d, longer than
  // the 120s cooldown it would be reporting. The rule has been in this file
  // since it was written; wrapping GeckoTerminal in a try/catch so DexScreener
  // could be tried afterwards quietly turned the throw into a return.
  const route = code(read("src/app/api/ohlcv/route.ts"));
  const loader = route.slice(route.indexOf("async function load("), route.indexOf("export async function GET"));
  assert.match(loader, /throw new Unreadable\(/, "the could-not-ask branch must THROW out of the cached loader");
  assert.ok(!/return fail\(tf, `Couldn't read/.test(loader), "…and must not return a cacheable failure instead");
  // The cached() call wraps load, which is what makes the above load-bearing.
  assert.match(route, /cached\(key, TF\[tf\]\.ttlMs, \(\) => load\(/);

  // ⚠️ AND THROWING BUYS A SECOND THING, WHICH IS THE BIGGER ONE. `cached()`
  // answers a THROWN loader with `getStale` — the last good value, expired or
  // not (cache.test.ts pins it: "an expired entry is still the stale copy
  // served when a provider is down"). So a reader whose chart was already
  // drawn keeps seeing real candles through a GT cooldown instead of a
  // "Chart unavailable" panel. RETURNING the failure did the opposite: it
  // `cache.set` the error OVER the good candles, so the safety net had nothing
  // left to serve and the failure became the stale value.
  assert.match(read("src/lib/cache.ts"), /const stale = cache\.getStale<T>\(key\);/, "the stale-on-throw net is gone");
});

test("⚠️ EVERY applicable source must have answered before 'no candles' is published", () => {
  // With GeckoTerminal cooling down and DexScreener replying "no pair for this
  // token", ONE source answered — and publishing that as the settled answer
  // says "No candles yet" about a token GT indexes perfectly well, on the panel
  // state that never fast-retries. A source that is not applicable at all (no
  // DS coverage for the chain, or a ?source= pin) is not an unanswered source.
  const route = code(read("src/app/api/ohlcv/route.ts"));
  assert.match(route, /const gtSilent = askGt && !gt\.answered;/);
  assert.match(route, /const dsSilent = dsAvailable && !dsAnswered;/);
  assert.match(route, /if \(!gtSilent && !dsSilent && \(gt\.answered \|\| dsAnswered\)\)/);
});

test("the panel SAYS when it drew from the fallback", () => {
  // A chart drawn by DexScreener and one drawn by GeckoTerminal are identical
  // from outside, so "the second source works" and "the second source never
  // fires" are the same picture — the reassuring reading, which this repo has
  // paid for repeatedly.
  const chart = code(read("src/components/CandleChart.tsx"));
  assert.match(chart, /feed\?\.source === "dexscreener"/);
  assert.match(chart, /via DexScreener/);
  // …and the "open it at the source" link follows the source, or it points at
  // a GeckoTerminal page for a pool GT never indexed.
  assert.match(chart, /feed\?\.sourceUrl/);
  assert.match(chart, /Open the pool on \{srcName\}/);
});

test("this provider is DexScreener's DATA, never its widget", () => {
  // Two separate bans, and collapsing them is how one comes back. THIS one is
  // about the PROVIDER: adding a second data source must not turn into
  // embedding the source's page, or the fallback quietly stops being a chart of
  // ours at all. It is unchanged and unrelaxed.
  assert.ok(!/<iframe/i.test(read("src/lib/providers/dsChart.ts")));
  assert.ok(!/dexscreener\.com\/[^"']*embed/i.test(read("src/lib/providers/dsChart.ts")));
  // ⚠️ The component's iframe is a DIFFERENT decision, made later and on the
  // operator's explicit call ("gpp ada watermark"): it appears only where we
  // could not READ a chart, in place of an apology over an empty panel. Its
  // boundary is pinned in chartRoute.test.ts — exactly one iframe, gated on the
  // error state, never on "none", and labelled. What must not come back is the
  // embed as the DEFAULT, which is what planted a competitor's wordmark on
  // every token page.
  const chart = read("src/components/CandleChart.tsx");
  assert.equal((chart.match(/<iframe/gi) ?? []).length, 1, "the embed must stay a single fallback");
  // The PROPERTY — that the embed is reachable only from the error state — not
  // the line that happened to express it. See chartRoute.test.ts, where the
  // same guard had to be un-pinned from its own spelling.
  assert.match(chart, /status === "error" \? embedUrl : null/);
});

test("?source pins ONE upstream, and it is part of the cache key", () => {
  // With GeckoTerminal healthy the DexScreener path never runs, so a check that
  // only asked normally would report a green chart and say nothing about
  // whether the FALLBACK works — `fonts:check`'s nine green ticks over a banner
  // drawing boxes. `chart:check` asks each source separately.
  const route = code(read("src/app/api/ohlcv/route.ts"));
  assert.match(route, /q\.get\("source"\)/);
  assert.match(route, /pinOf/, "…and it is normalised — this value reaches a cache key");
  assert.match(route, /raw === "geckoterminal" \|\| raw === "dexscreener" \? raw : null/, "anything else is null, never free text");
  // ⚠️ A forced single-source answer must not be served to an ordinary visitor.
  assert.match(route, /\$\{pin \?\? "auto"\}/, "the pin is part of the cache key");
  // …and the chain is STILL checked before any key is built.
  const handler = route.slice(route.indexOf("export async function GET"));
  assert.ok(handler.indexOf("if (!network)") > 0);
  assert.ok(handler.indexOf("`ohlcv:") > handler.indexOf("if (!network)"));
});

test("the check drives the SERVER, not the .ts provider — production runs node 18", () => {
  // Importing src/**/*.ts needs node's type stripping (the test script passes
  // --experimental-strip-types). Production runs 18.19, where that import
  // throws — and a check that cannot run on the box is the class of fix this
  // repo has already paid six days for.
  const script = read("scripts/chart-check.mjs");
  assert.ok(!/from "\.\.\/src\//.test(script), "the check must not import the app's TypeScript");
  assert.match(script, /\/api\/ohlcv\?/, "…it goes through the running route instead");
  assert.match(script, /source: "geckoterminal"|source=geckoterminal|"geckoterminal"/);
  assert.match(script, /process\.exit\(1\)/, "a check that cannot fail is not a check");
  // It prints BOTH build stamps, because a check read off a stale server is how
  // every round of this has started.
  assert.match(script, /serverBuild/);
  const pkg = JSON.parse(read("package.json"));
  assert.strictEqual(pkg.scripts["chart:check"], "node scripts/chart-check.mjs", "…and it is registered");
  assert.ok(pkg.scripts.comment_chart_check, "with the prose rationale beside it, as every other script here has");
});

test("⚠️ chart:check goes green only when EVERY sample drew from EVERY source", () => {
  // The gate was `gtOk && dsOk` — two COUNTS tested for truthiness while only
  // `anyDrawn` was compared against the sample size. One DexScreener success
  // out of three satisfied it, so the script printed two red DexScreener lines
  // and then "Both sources answer from this box", and exited 0. Reproduced
  // against a stub. Green must mean "the charts are safe", never "it answered
  // somewhere" — and a partial miss is the EXPECTED shape of a wrong path
  // guess, since the template interpolates the AMM per pair.
  const script = read("scripts/chart-check.mjs");
  assert.match(script, /gtOk === targets\.length && dsOk === targets\.length/, "the green gate still tests a count for truthiness");
  assert.ok(!/&& gtOk && dsOk\)/.test(script), "the truthiness gate is back");
  // …and the ⚠ tier names WHICH source is patchy, with the counts.
  assert.match(script, /gtOk < targets\.length/);
  assert.match(script, /dsOk < targets\.length/);
  assert.match(script, /NO fallback/);
});

test("the env reader checks the BLANK STRING before Number()", () => {
  // `Number('')` is 0 — finite, non-negative — and it has silently replaced
  // every default with zero four times in this repo.
  const prov = code(read("src/lib/providers/dsChart.ts"));
  assert.match(prov, /if \(s === ""\) return dflt;/);
  // …and blank is NOT false for the kill switch: a bare `DS_CHART=` is "never
  // decided", not "refused".
  assert.match(prov, /s === "0" \|\| s === "false" \|\| s === "off" \|\| s === "no"/);
});

test("⚠️ a 403 arms the cooldown — retrying a refusal is the 429 defect one status over", async () => {
  // Reported live: "GeckoTerminal is rate limited — cooling down for 92s;
  // io.dexscreener.com 403". The panel fast-retries a transient chart failure
  // every 5s so the chart draws itself the moment a GT cooldown lifts — free
  // upstream, because gtGet answers a cooled-down request WITHOUT making one.
  // DexScreener had no such guard for a 403, so every chart view spent eight
  // requests proving the same refusal.
  _dsChartReset();
  let bars = 0;
  const f = stubFetch((u) => {
    if (u.includes("token-pairs"))
      return [{ chainId: "bsc", dexId: "uniswap", pairAddress: "0xPAIR", baseToken: { address: "0xus" }, liquidity: { usd: 1 } }];
    bars++;
    return { status: 403 };
  });
  try {
    const a = await dsCandles("bsc", "0xUS", "15m", {});
    assert.strictEqual(a.ok, false);
    assert.match(a.why!, /403/);
    assert.ok(dsInCooldown(), "a host refusing us is not asked again straight away");
    const spent = bars;
    const b = await dsCandles("bsc", "0xUS", "15m", {});
    assert.strictEqual(bars, spent, "the next request made no upstream call at all");
    assert.match(b.why!, /cooling down/);
  } finally {
    f.restore();
    _dsChartReset();
  }
});

test("…but a 404 does NOT arm it — that is an answer about the pair, not a refusal of us", async () => {
  // Caching it as an outage would blind the fallback for every other token.
  _dsChartReset();
  const f = stubFetch((u) => {
    if (u.includes("token-pairs"))
      return [{ chainId: "bsc", dexId: "uniswap", pairAddress: "0xPAIR", baseToken: { address: "0xus" }, liquidity: { usd: 1 } }];
    return { status: 404 };
  });
  try {
    await dsCandles("bsc", "0xUS", "15m", {});
    assert.ok(!dsInCooldown(), "the next token is still asked");
  } finally {
    f.restore();
    _dsChartReset();
  }
});

test("a 429-armed cooldown still reads as a rate limit", () => {
  // The two are different facts and both have to survive to the panel.
  _dsChartReset();
  dsArmCooldown(5000, Date.now(), "io.dexscreener.com is rate limited");
  assert.match(dsCooldownWhy(), /rate limited/);
  assert.ok(!/refusing/.test(dsCooldownWhy()));
  _dsChartReset();
  assert.equal(dsCooldownWhy(), "rate limited", "and it falls back to the honest default when nothing armed it");
});

test("⚠️ every part of the request is env-overridable — including the QUERY", () => {
  // The whole licence for shipping an unverified shape is that a wrong guess
  // costs a line in .env rather than a deploy. The query string was the one
  // part that was hardcoded — and it is the half most likely to be wrong:
  // io.dexscreener.com answered 403 to a bare request and 400 once it was sent
  // browser headers, i.e. it is TALKING to us and refusing the parameters.
  assert.equal(
    dsChartQuery(100, 200, "15", 384, undefined),
    "from=100&to=200&res=15&cb=384",
    "the shipped default",
  );
  assert.equal(
    dsChartQuery(100, 200, "1D", 365, "from={from}&to={to}&resolution={res}&countback={limit}&currency=usd"),
    "from=100&to=200&resolution=1D&countback=365&currency=usd",
    "an operator can paste the shape they read out of their own browser",
  );
  assert.equal(dsChartQuery(1, 2, "5", 9, "   "), "from=1&to=2&res=5&cb=9", "blank is the default, never empty");
});

test("a 400 tries the OTHER path spelling; a 403 does not", () => {
  // 404 ("not here") and 400 ("not with these parameters") are both about THIS
  // spelling — v2 and v3 of an API routinely take different params, which is
  // the whole reason two templates are listed. A refusal says nothing about
  // which path is right.
  const src = code(read("src/lib/providers/dsChart.ts"));
  assert.match(src, /if \(res\.status === 404 \|\| res\.status === 400\) continue;/);
  assert.ok(!/res\.status === 403[^\n]*continue/.test(src), "a refusal is not a spelling problem");
});

test("⚠️ an HTTP error carries the upstream's own explanation", () => {
  // "Never discard the reason" — an HTTP error puts the explanation in the
  // response body, and a bare `io.dexscreener.com 400` said the guessed shape
  // is wrong and nothing about WHICH part.
  const src = code(read("src/lib/providers/dsChart.ts"));
  assert.match(src, /await bodyHint\(res\)/);
  assert.match(src, /replace\(\/<\[\^>\]\*>\/g, " "\)/, "an HTML error page is flattened, not pasted into the panel");
  assert.match(src, /slice\(0, 140\)/, "and bounded");
});

test("⚠️ the query template can express BOTH time units", () => {
  // `{from}`/`{to}` are milliseconds because the caller passes Date.now(). A
  // feed that wants seconds could not be described at all before `{fromSec}`
  // existed — and the probe on the box got a 400 with an EMPTY BODY, which is
  // exactly what a wrong unit looks like: no message, nothing to read.
  const ms = 1_700_000_000_000;
  const q = dsChartQuery(ms - 3_600_000, ms, "15", 100, "from={from}&to={to}&res={res}&cb={limit}");
  assert.equal(q, `from=${ms - 3_600_000}&to=${ms}&res=15&cb=100`);

  const secQ = dsChartQuery(ms - 3_600_000, ms, "15", 100, "from={fromSec}&to={toSec}&res={res}");
  assert.equal(secQ, `from=${(ms - 3_600_000) / 1000}&to=${ms / 1000}&res=15`);
});

test("{from} substitution does not corrupt {fromSec}", () => {
  // Replacing the shorter token first would leave a stray "Sec" behind, and
  // the upstream would answer 400 about a parameter the operator can see is
  // correct in their .env.
  const ms = 1_700_000_000_000;
  const q = dsChartQuery(ms, ms, "15", 1, "a={from}&b={fromSec}&c={to}&d={toSec}");
  assert.ok(!/Sec/.test(q), q);
  assert.equal(q, `a=${ms}&b=${ms / 1000}&c=${ms}&d=${ms / 1000}`);
});
