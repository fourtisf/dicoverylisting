// Auto-Listing: free listings for projects that climb past ~$1M.
//
// The operator's requirement in one line: "jangan kaya bot" — the listings must
// not all land on the same round number. That is what the per-token trigger is
// for, and it is the property most worth pinning: a naive implementation lists
// everything at exactly the floor and the feed reads as machine-generated.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-autolist-"));

const test = require("node:test");
const assert = require("node:assert");

const al = require("../src/services/autoLister");
const api = require("../src/api/dexvra");

const M = 1_000_000;
const HOUR = 3_600_000;
const now = 1_800_000_000_000;

// A healthy $1.2M project — the baseline every rejection test bends one field of.
const healthy = (over = {}) => ({
  name: "Nine Hood",
  symbol: "NINEHOOD",
  mcap: 1.2 * M,
  liq: 120_000,
  vol24: 300_000,
  priceUsd: 0.0012,
  logoUrl: "https://dd.dexscreener.com/x.png",
  pairCreatedAt: now - 48 * HOUR,
  ...over,
});

test("off by default — nothing is listed until the operator turns it on", async () => {
  await al.reset();
  assert.strictEqual(al.get().enabled, false);
  let discovered = false;
  const n = await al.runOnce({
    now,
    deps: {
      fetchDiscovery: async () => {
        discovered = true;
        return [{ chain: "solana", address: "A" }];
      },
    },
  });
  assert.strictEqual(n, 0);
  assert.strictEqual(discovered, false, "a disabled service must not even poll");
});

test("each token gets its OWN trigger inside the band — not everything at $1M", () => {
  const cfg = { minMcap: 1 * M, maxMcap: 1.5 * M };
  const addrs = ["0xaaa", "0xbbb", "0xccc", "So1ana1", "So1ana2", "0xdef", "0x123", "0x456"];
  const triggers = addrs.map((a) => al.triggerMcap(a, cfg));
  for (const t of triggers) {
    assert.ok(t >= cfg.minMcap && t <= cfg.maxMcap, `${t} outside the band`);
  }
  // The whole point: they must not collapse onto one value.
  assert.ok(new Set(triggers).size >= addrs.length - 1, `triggers barely vary: ${triggers}`);
  // …and at least one lands meaningfully past the floor, so a listing shows
  // 1.1M / 1.4M rather than a suspiciously round 1.0M.
  assert.ok(triggers.some((t) => t > 1.05 * M), `every trigger hugs the floor: ${triggers}`);
});

// ── The wide-band starvation (2026-08-28) ───────────────────────────────────
// The operator set the band to $1M–$100M — with Ignore-above at $100M, plainly
// "list anything from $1M to $100M" — and the uniform draw across the whole
// band handed out $50M mean triggers: 0.4% of tokens drew one under $1.5M and
// the feed went from 105 lifetime listings to ZERO per day, with every panel
// light green. The jitter is bounded by the floor now, so the band top past
// half-the-floor cannot starve anything.
test("a WIDE band cannot starve the feed — the jitter is bounded by the floor", () => {
  const cfg = { minMcap: 1 * M, maxMcap: 100 * M, maxMcapHard: 100 * M, minLiq: 25_000, minVol24: 30_000, minAgeHours: 6 };
  const addrs = Array.from({ length: 40 }, (_, i) => `0xwide${i}`);
  for (const a of addrs) {
    const t = al.triggerMcap(a, cfg);
    assert.ok(
      t >= cfg.minMcap && t <= cfg.minMcap * 1.5,
      `trigger $${t} escaped the floor's own smear — the wide band is starving the feed again`,
    );
  }
  // The consequence that actually matters: an ordinary $5M project qualifies.
  // Under the unbounded draw ~96% of these were refused "below its trigger".
  for (const a of addrs) {
    const why = al.rejectReason(healthy({ mcap: 5 * M }), cfg, al.triggerMcap(a, cfg), now);
    assert.strictEqual(why, null, `a $5M token was refused under a $1M–$100M band: ${why}`);
  }
});

test("the shipped band draws bit-for-bit what it always drew — no install's triggers move", () => {
  const cfg = { minMcap: 1 * M, maxMcap: 1.5 * M };
  // The pre-fix formula, inlined: uniform across the whole band. On the shipped
  // band the bounded span IS the band, so the two must agree exactly.
  const crypto = require("node:crypto");
  for (const a of ["0xaaa", "0xbbb", "So1ana1", "0xStableAddress"]) {
    const h = crypto.createHash("sha1").update(a.toLowerCase()).digest();
    const old = cfg.minMcap + (h.readUInt32BE(0) % (500_000 + 1));
    assert.strictEqual(al.triggerMcap(a, cfg), old, `the default band's draw moved for ${a}`);
  }
});

test("a token's trigger is STABLE — it must climb to its own number", () => {
  const cfg = { minMcap: 1 * M, maxMcap: 1.5 * M };
  const a = al.triggerMcap("0xStableAddress", cfg);
  for (let i = 0; i < 5; i++) assert.strictEqual(al.triggerMcap("0xStableAddress", cfg), a);
  // Re-rolling per scan would eventually draw a number under the current cap and
  // list at the floor — the exact behaviour the operator asked us to avoid.
  assert.strictEqual(al.triggerMcap("0xSTABLEADDRESS", cfg), a, "case-insensitive on the address");
});

test("rejection reasons: each guard names itself", () => {
  const cfg = al.get();
  const trigger = 1.1 * M;
  const cases = [
    [healthy({ mcap: 1.05 * M }), /below its trigger/],
    [healthy({ mcap: 80 * M }), /above the ceiling/],
    [healthy({ liq: 1_000 }), /thin liquidity/],
    [healthy({ vol24: 100 }), /low 24h volume/],
    [healthy({ pairCreatedAt: now - HOUR }), /too new/],
    [healthy({ symbol: "🚀🚀" }), /ticker/],
    [healthy({ name: "" }), /name/],
    [healthy({ mcap: 0 }), /market cap/],
    [null, /no market data/],
  ];
  for (const [info, re] of cases) {
    const why = al.rejectReason(info, cfg, trigger, now);
    assert.ok(why && re.test(why), `expected ${re}, got ${JSON.stringify(why)}`);
  }
  assert.strictEqual(al.rejectReason(healthy(), cfg, trigger, now), null, "a healthy $1.2M project passes");
});

test("an auto listing is FREE tier — never a paid package", () => {
  const input = al.listingInput("solana", "So1ana1", healthy());
  assert.strictEqual(input.tier, "FREE", "must not impersonate a paid Bronze listing");
  assert.strictEqual(input.sym, "NINEHOOD");
  assert.strictEqual(input.chain, "solana");
});

test("a scan lists a qualifying token once, and never re-lists it", async () => {
  await al.set({ enabled: true, minMcap: 1 * M, maxMcap: 1.5 * M, postChannel: false });
  const created = [];
  const realCreate = api.createListing;
  const realGet = api.getListings;
  api.createListing = async (input) => {
    created.push(input);
    return { id: "x", ...input };
  };
  api.getListings = async () => [];
  try {
    const deps = {
      fetchDiscovery: async () => [{ chain: "solana", address: "So1ana1" }],
      // At the TOP of the band, so every possible trigger is cleared — the test
      // must not depend on where a particular address hashes.
      fetchTokenInfo: async () => healthy({ mcap: 1.5 * M }),
    };
    assert.strictEqual(await al.runOnce({ now, deps }), 1);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].sym, "NINEHOOD");
    // Second scan: already ours. ⚠️ WELL past the listing pace's longest wait,
    // or this 0 would be the pace holding the scan back rather than the dedupe
    // under test — a green assertion measuring something else entirely.
    assert.strictEqual(await al.runOnce({ now: now + 6 * HOUR, deps }), 0, "no duplicate listing");
    assert.strictEqual(created.length, 1);
    const s = al.stats(now + 6 * HOUR);
    assert.strictEqual(s.total, 1);
    assert.strictEqual(s.today, 1);
    assert.strictEqual(al.history()[0].sym, "NINEHOOD");
  } finally {
    api.createListing = realCreate;
    api.getListings = realGet;
  }
});

test("a token already on the site is left alone — including a paying customer's", async () => {
  // ⚠️ resetState() clears the PACE CLOCK, which the test above set by listing.
  // Without it this scan returns 0 because the pace holds it, `known.has(key)`
  // could be deleted outright and the assertion below would stay green — the
  // rule under test answered for by a rule that is not under test.
  await al.resetState();
  await al.set({ enabled: true });
  const realCreate = api.createListing;
  const realGet = api.getListings;
  let calls = 0;
  api.createListing = async () => {
    calls++;
    return { id: "x" };
  };
  api.getListings = async () => [{ chain: "bsc", address: "0xPAID" }];
  try {
    const n = await al.runOnce({
      now,
      deps: {
        fetchDiscovery: async () => [{ chain: "bsc", address: "0xpaid" }], // different case
        fetchTokenInfo: async () => healthy({ mcap: 1.5 * M }),
      },
    });
    assert.strictEqual(n, 0);
    assert.strictEqual(calls, 0, "never touch a token that is already listed");
    // …and it says WHICH rule stopped it, so a future gate cannot answer for
    // this one silently.
    assert.strictEqual(al.lastScan().known, 1, "it was skipped as already-known, not held by anything else");
    assert.strictEqual(al.lastScan().paced, null, "the pace must not be what produced this 0");
  } finally {
    api.createListing = realCreate;
    api.getListings = realGet;
  }
});

test("when the site's listing list is unreachable the scan stops", async () => {
  // Guessing here risks double-listing a paid token; skipping a cycle costs
  // nothing.
  await al.set({ enabled: true });
  const realCreate = api.createListing;
  const realGet = api.getListings;
  let calls = 0;
  api.createListing = async () => {
    calls++;
    return { id: "x" };
  };
  api.getListings = async () => {
    throw new Error("ECONNREFUSED");
  };
  try {
    const n = await al.runOnce({
      now,
      deps: {
        fetchDiscovery: async () => [{ chain: "bsc", address: "0xnew" }],
        fetchTokenInfo: async () => healthy({ mcap: 1.5 * M }),
      },
    });
    assert.strictEqual(n, 0);
    assert.strictEqual(calls, 0);
  } finally {
    api.createListing = realCreate;
    api.getListings = realGet;
  }
});

test("caps hold: per run and per day", async () => {
  await al.reset();
  await al.resetState(); // earlier tests already spent part of today's budget
  // The per-RUN cap is what this test is about, and the listing pace overrides
  // it to one — a different limit, with its own file. Stated, not inherited.
  await al.set({ enabled: true, paceListings: false, maxPerRun: 2, maxPerDay: 3, minMcap: 1 * M, maxMcap: 1.5 * M });
  const realCreate = api.createListing;
  const realGet = api.getListings;
  api.createListing = async (i) => ({ id: "x", ...i });
  api.getListings = async () => [];
  try {
    const deps = {
      fetchDiscovery: async () =>
        ["a", "b", "c", "d", "e"].map((x) => ({ chain: "solana", address: `So1ana_${x}` })),
      fetchTokenInfo: async () => healthy({ mcap: 1.5 * M }),
    };
    assert.strictEqual(await al.runOnce({ now, deps }), 2, "per-run cap");
    assert.strictEqual(await al.runOnce({ now, deps }), 1, "per-day cap leaves room for one more");
    assert.strictEqual(await al.runOnce({ now, deps }), 0, "day is full");
    // A new day releases the cap.
    assert.strictEqual(await al.runOnce({ now: now + 26 * HOUR, deps }), 2);
  } finally {
    api.createListing = realCreate;
    api.getListings = realGet;
    // `paceListings` is PERSISTED, so leaving it off here would hand it to
    // every test written below this one — which would then be measuring the
    // old behaviour without saying so.
    await al.reset();
  }
});

test("config rails: an impossible band or a runaway cap is clamped", async () => {
  await al.set({ minMcap: 5 * M, maxMcap: 1 * M, maxPerDay: 99999, minGapMin: 999, maxGapMin: 1 });
  const c = al.get();
  assert.ok(c.maxMcap >= c.minMcap, "band stays valid");
  assert.ok(c.maxPerDay <= 100, "daily cap railed");
  assert.ok(c.maxGapMin >= c.minGapMin, "gap stays valid");
  // ⚠️ THE SWITCH IS NOT A THRESHOLD, and ↩️ Reset carries it over. It used to
  // take `enabled` with everything else — and `DEFAULTS.enabled` is false — so
  // resetting the numbers silently stopped a live public feed, announced as a
  // bare "↩️ Reset", after which the panel accused the loop of having died.
  // Stated out loud here rather than inherited from whatever ran before.
  await al.set({ enabled: true });
  await al.reset();
  assert.deepStrictEqual(al.get(), { ...al.DEFAULTS, enabled: true }, "reset returns the shipped thresholds and keeps the switch");
  await al.set({ enabled: false });
  await al.reset();
  assert.deepStrictEqual(al.get(), { ...al.DEFAULTS, enabled: false }, "…and it does not switch a stopped service on either");
});

// ── Package selection ───────────────────────────────────────────────────────
// The operator picks what an auto-listed token receives: a plain free listing,
// an Xpress Listing, or Listing & Trending.
test("package: xpress hands out the real XPRESS tier", async () => {
  await al.set({ pkg: "xpress" });
  const input = al.listingInput("solana", "So1ana1", healthy(), al.get(), now);
  assert.strictEqual(input.tier, "XPRESS");
  assert.strictEqual(input.trendingRank, undefined, "xpress is a listing, not a trending slot");
});

test("package: trending adds a time-boxed slot AND a drawn paid tier", async () => {
  await al.set({ pkg: "trending", trendHours: 12 });
  const input = al.listingInput("solana", "So1ana1", healthy(), al.get(), now);
  // Reversed on the operator's call (2026-08-04): this package used to be FREE
  // so paid tiers always sorted above it. It now carries a real one.
  assert.ok(al.TREND_TIERS.includes(input.tier), `expected one of ${al.TREND_TIERS}, got ${input.tier}`);
  assert.strictEqual(input.trendingRank, 1);
  assert.strictEqual(input.trendStart, now);
  assert.strictEqual(input.trendExp, now + 12 * HOUR, "the slot expires on its own");
});

test("package: free is the default and stays plain", async () => {
  await al.reset();
  assert.deepStrictEqual(al.get().pkgs, ["free"]);
  const input = al.listingInput("solana", "So1ana1", healthy(), al.get(), now);
  assert.strictEqual(input.tier, "FREE");
  assert.strictEqual(input.trendExp, undefined);
});

test("package: an unknown value falls back to free, never to a paid tier", async () => {
  await al.set({ pkg: "diamond_please" });
  assert.deepStrictEqual(al.get().pkgs, ["free"]);
  assert.strictEqual(al.pkgOf("nonsense").tier, "FREE");
  // …and the trending window is railed, so a fat-finger can't hand out 30 days.
  await al.set({ pkg: "trending", trendHours: 9999 });
  assert.ok(al.get().trendHours <= 48, `trendHours railed: ${al.get().trendHours}`);
  await al.reset();
});
