// The shared GeckoTerminal client. The live failure it was written for: the
// server answered `(GeckoTerminal 429)` and a bare curl from the same box did
// too — the IP was over its quota, and the web app had SIX modules taking turns
// discovering that independently.
import test from "node:test";
import assert from "node:assert/strict";

process.env.GT_MIN_GAP_MS = "0"; // the pacing gap is not what these pin
// Short enough to assert on, long enough that "it waited" is measurable. Read
// at module load, which is why it is set before the import.
process.env.GT_BUDGET_WAIT_MS = "150";
const { _gtReset, gtArmCooldown, gtBaseFor, gtBudgetRpm, gtGet, gtHeadersFor, gtInCooldown, gtSpentThisMinute } = await import("./gt.ts");
const { readFileSync } = await import("node:fs");
/** Read the module's SOURCE. The env knobs are read at load, so the shape of
 *  the knob is what a test can pin without a second module instance. */
const readGt = () => readFileSync("src/lib/providers/gt.ts", "utf8");

const withFetch = async (impl: typeof fetch, fn: () => Promise<void>) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
};
const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test.beforeEach(_gtReset);

test("an API key switches the base AND sends the header — the only real way past the ceiling", () => {
  // Same variable the bot reads, so one line in the server's env serves both
  // processes on that IP.
  assert.equal(gtBaseFor(""), "https://api.geckoterminal.com/api/v2");
  // ⚠️ A COINGECKO KEY COMES IN TWO TIERS, ON TWO DIFFERENT HOSTS, and this
  // used to know only the paid one. The key an operator will actually obtain
  // first is the FREE Demo key — so "set GECKOTERMINAL_API_KEY" was advice that
  // would have been refused, and the fix for a rate-limited chart would have
  // looked like it changed nothing.
  assert.equal(gtBaseFor("k3y", "", "demo"), "https://api.coingecko.com/api/v3/onchain");
  assert.equal(gtBaseFor("k3y", "", "pro"), "https://pro-api.coingecko.com/api/v3/onchain");
  assert.equal(gtHeadersFor("k3y", "demo")["x-cg-demo-api-key"], "k3y");
  assert.equal(gtHeadersFor("k3y", "pro")["x-cg-pro-api-key"], "k3y");
  // …and never the wrong header for the tier, which is how a good key reads as
  // a bad one.
  assert.ok(!("x-cg-pro-api-key" in gtHeadersFor("k3y", "demo")));
  assert.ok(!("x-cg-demo-api-key" in gtHeadersFor("k3y", "pro")));
  assert.ok(!("x-cg-pro-api-key" in gtHeadersFor("")), "no empty header when there is no key");
  assert.ok(!("x-cg-demo-api-key" in gtHeadersFor("")), "…on either tier");
});

test("an explicit base pins the host and skips the choice", () => {
  assert.equal(gtBaseFor("k3y", "https://gt.internal/v2/"), "https://gt.internal/v2", "trailing slash trimmed");
});

test("a success carries the body and no reason", async () => {
  await withFetch(async () => reply(200, { data: [1] }), async () => {
    const r = await gtGet<{ data: number[] }>("/networks/solana/tokens/x");
    assert.equal(r.ok, true);
    assert.deepEqual(r.body?.data, [1]);
    assert.equal(r.reason, null);
  });
});

test("⚠️ a 429 silences EVERY caller, and the next one makes no request at all", async () => {
  // "Two modules with their own fetch and their own backoff means one of them
  // keeps hammering through a 429 that the other has already noticed" — the
  // bot's client, about two. The web app had six.
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return reply(429, {});
    },
    async () => {
      const first = await gtGet("/networks/solana/tokens/a");
      assert.equal(first.status, 429);
      assert.match(first.reason ?? "", /429/);
      assert.equal(gtInCooldown(), true);

      const second = await gtGet("/networks/solana/pools/b/trades");
      assert.equal(second.status, 0, "no request was made");
      assert.match(second.reason ?? "", /cooling down/);
    },
  );
  assert.equal(calls, 1, "one request, not one per caller");
});

test("the cooldown honours Retry-After when GeckoTerminal sends one", async () => {
  await withFetch(async () => reply(429, {}, { "retry-after": "300" }), async () => {
    await gtGet("/x");
  });
  // 300s is far past the 120s default — the upstream's own number wins.
  assert.ok(gtInCooldown(Date.now() + 200_000), "still cooling at +200s");
});

test("a 5xx does NOT arm it — one bad pool must not take the whole site down", async () => {
  // The cooldown is process-wide; a per-request failure says nothing about our
  // quota. 429 is the only status that means "all of you, stop".
  await withFetch(async () => reply(503, {}), async () => {
    const r = await gtGet("/x");
    assert.equal(r.status, 503);
    assert.equal(gtInCooldown(), false);
  });
});

test("a dead socket does not arm it either, and still names the syscall", async () => {
  await withFetch(
    async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
    },
    async () => {
      const r = await gtGet("/x");
      assert.equal(r.status, 0);
      assert.match(r.reason ?? "", /fetch failed: ECONNRESET/);
      assert.equal(gtInCooldown(), false, "a timeout is not a rate limit");
    },
  );
});

test("a 404 is an answer, not a silence", async () => {
  await withFetch(async () => reply(404, {}), async () => {
    const r = await gtGet("/x");
    assert.equal(r.status, 404, "callers key their 'not indexed' branch off this");
    assert.equal(gtInCooldown(), false);
  });
});

test("the cooldown only ever extends, never shortens", async () => {
  gtArmCooldown(300_000);
  gtArmCooldown(1000);
  assert.ok(gtInCooldown(Date.now() + 200_000), "a short arm must not cancel a long one");
});

// ── the site's half of one IP's allowance ───────────────────────────────────
//
// The bot's client was cut to 15/min so the two processes on this box would ADD
// UP to the ~30/min ceiling. The site never got its half — a 120ms floor is
// ~500/min, i.e. no budget at all — so the bot held politely to fifteen while
// the site took whatever it liked, and both of them ate the 429. A split one
// side observes is not a split.

test("under budget, nothing is held back", async () => {
  let hits = 0;
  await withFetch(async () => { hits++; return reply(200, { ok: 1 }); }, async () => {
    assert.equal((await gtGet("/x")).ok, true);
    assert.equal((await gtGet("/y")).ok, true);
  });
  assert.equal(hits, 2);
  assert.equal(gtSpentThisMinute(), 2, "a request that went out takes exactly one slot");
});

test("⚠️ the budget PACES — the request past the budget waits for a slot before it gives up", async () => {
  // A refusal would blank a chart the moment a board rebuild used the minute's
  // allowance. Waiting is the point: a chart that draws a second late beats one
  // that does not draw.
  //
  // ⚠️ THE BUDGET IS READ, NOT WRITTEN DOWN HERE. This used to hardcode 15 —
  // half of a ~30/min ceiling nobody had checked — and GeckoTerminal's own API
  // page says the free tier is 10. A test that repeats a wrong constant fails
  // for the right change, which is what it just did.
  const budget = gtBudgetRpm();
  let hits = 0;
  const t0 = Date.now();
  let over: Awaited<ReturnType<typeof gtGet>> | null = null;
  await withFetch(async () => { hits++; return reply(200, { ok: 1 }); }, async () => {
    for (let i = 0; i < budget; i++) assert.equal((await gtGet(`/p${i}`)).ok, true);
    over = await gtGet(`/p${budget}`);
  });
  const waited = Date.now() - t0;
  assert.equal(hits, budget, "the request past the budget must not have been made");
  assert.ok(waited >= 120, `it must actually wait for a slot, waited ${waited}ms`);
  assert.equal(over!.ok, false);
  // ⚠️ status 0 is "we did not ask" — the same answer the cooldown gives, which
  // every caller already reads as "could not ask" rather than "nothing there".
  assert.equal(over!.status, 0);
  assert.match(over!.reason ?? "", /budget/i);
  // Our own pacing must never be reported as the upstream's refusal: that sends
  // an operator to check a service that is perfectly healthy, and reads as a
  // fact about the quota rather than about us.
  assert.doesNotMatch(over!.reason ?? "", /429/);
  assert.match(over!.reason ?? "", /GT_MAX_RPM|GECKOTERMINAL_API_KEY/, "the refusal names the knob that lifts it");
});

test("⚠️ a caller with a second source takes a free slot and NEVER queues for one", async () => {
  // `slot()` is serialised process-wide, so a wait is charged to everything
  // behind it, not to the waiter. One board refresh is ~19 chunks against a
  // 5/min budget: ~14 of them queued the full wait for a slot that was never
  // coming, and a token page's chart request sat behind all of it. A caller
  // that has DexScreener behind it loses nothing by leaving at once — that is
  // where those tokens were going three seconds later anyway.
  const budget = gtBudgetRpm();
  let hits = 0;
  await withFetch(async () => { hits++; return reply(200, { ok: 1 }); }, async () => {
    // a free slot is still TAKEN — this is not "skip GeckoTerminal"
    const first = await gtGet("/free", undefined, { waitMs: 0 });
    assert.equal(first.ok, true, "a free slot must still be used");
    for (let i = 1; i < budget; i++) assert.equal((await gtGet(`/q${i}`)).ok, true);

    const t0 = Date.now();
    const over = await gtGet("/over", undefined, { waitMs: 0 });
    const waited = Date.now() - t0;
    assert.equal(over.ok, false);
    assert.equal(over.status, 0, "the same 'we did not ask' every caller already reads");
    assert.match(over.reason ?? "", /budget/i);
    assert.ok(waited < 100, `it queued for ${waited}ms — the whole point is that it does not`);
  });
  assert.equal(hits, budget, "and nothing extra was sent");
});

test("waitMs defaults to the shared budget wait — an omitted option may not silently mean 0", () => {
  // The GT-ONLY chains depend on the wait: for them it is the difference
  // between a priced row and a dash, and they are the reason the scheduler
  // orders the cycle at all.
  const src = readGt();
  assert.match(src, /Number\.isFinite\(opts\?\.waitMs\) \? Math\.max\(0, opts!\.waitMs!\) : BUDGET_WAIT_MS/);
});

test("the board asks for the no-queue slot on covered chains ONLY, off the same map the scheduler reads", () => {
  const src = readFileSync("src/lib/providers/geckoterminal.ts", "utf8").replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, "");
  assert.match(src, /const waitMs = dsCovers\(chainId\) \? 0 : undefined;/,
    "the board either queues for everything or for nothing");
  assert.match(src, /waitMs === undefined \? undefined : \{ waitMs \}/, "…and it reaches the request");
  // A second list of "which chains DexScreener covers" is how two of them end
  // up disagreeing; dsCovers is the one owner and partitionByFallback reads it.
  assert.doesNotMatch(src, /dexscreener:\s*(?:null|")/, "geckoterminal.ts is keeping its own coverage list");
});

test("the budget is a ROLLING window, not a per-minute bucket", async () => {
  // A bucket lets 15 requests go at :59 and 15 more at :00 — the burst the
  // ceiling actually punishes.
  const src = readGt();
  assert.match(src, /gtSpentThisMinute/, "the window is measured, not counted per calendar minute");
  assert.match(src, /at - 60_000/);
  assert.doesNotMatch(src, /getMinutes\(\)/);
});

test("GT_MAX_RPM is READ from the env and 0 turns it off — the escape hatch a Pro key needs", () => {
  const src = readGt();
  assert.match(src, /num\(process\.env\.GT_MAX_RPM, Math\.max\(1, Math\.floor\(FREE_CEILING_RPM \/ 2\)\), 0\)/,
    "the default is DERIVED from the ceiling, never a second copy of the number");
  assert.match(src, /if \(MAX_RPM <= 0\) return true;/);
});

test("⚠️ this process takes HALF the IP's allowance, because the bot suite takes the other", () => {
  // The two budgets have to ADD UP TO the ceiling. They used to add up to three
  // times it — 15 here and 15 in the bot, against a documented 10 — so the
  // "GeckoTerminal is rate limited" the token page kept showing was ours.
  const src = readGt();
  assert.match(src, /num\(process\.env\.GT_FREE_CEILING_RPM, 10, 1\)/,
    "the free ceiling is 10/min per geckoterminal.com/dex-api, and overridable");
  assert.ok(gtBudgetRpm() * 2 <= 10, `two halves must fit the ceiling, got ${gtBudgetRpm()} each`);
});

test("the boot line PRINTS the budget — a split nobody can read is how this one stayed missing", () => {
  const src = readGt();
  const banner = src.slice(src.indexOf("export function gtBanner"));
  assert.match(banner, /budget \$\{MAX_RPM/, "the banner must state the budget in force");
});
