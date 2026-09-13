// Auto-Trending config rails + top-up logic. Isolated data dir before requires.
//
// ⚠️ WHY EVERY set() BELOW SAYS `minMcapUsd: 0, minVol24hUsd: 0` OUT LOUD.
// The free-trending quality floors (a market-cap floor and a 24h-volume floor,
// autoTrend.DEFAULTS) ship ON, and the fixtures here stub a market that
// publishes neither — so with the shipped defaults every candidate in this file
// would be refused for "market cap could not be read" and the tests would fail
// for a reason that has nothing to do with what they cover. STATED, never
// inherited: the same rule the pace tests had to learn. A test that silently
// depended on a floor being off would go on passing for a NEW reason the day
// somebody changed the default, which is worse than failing.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-at-"));

const test = require("node:test");
const assert = require("node:assert");
const api = require("../src/api/dexvra");
const autoTrend = require("../src/services/autoTrend");
const log = require("../src/helpers/logger");

test("autotrend: defaults + rails (max 18h, valid ranges, capped per-chain target)", async () => {
  const d = autoTrend.get();
  assert.strictEqual(d.enabled, false);
  assert.strictEqual(d.maxHours, 18);
  // 24h/48h are clamped down to the 18h hard cap.
  let c = await autoTrend.set({ maxHours: 48 });
  assert.strictEqual(c.maxHours, 18, "48h clamped to 18h");
  c = await autoTrend.set({ maxHours: 24 });
  assert.strictEqual(c.maxHours, 18, "24h clamped to 18h");
  // max can't drop below min; target and gap stay within rails.
  c = await autoTrend.set({ minHours: 10, maxHours: 4 });
  assert.ok(c.maxHours >= c.minHours, "max kept >= min");
  c = await autoTrend.set({ perChainMin: 9999 });
  assert.strictEqual(c.perChain, autoTrend.HARD.perChainMax, "per-chain target capped");
  // An unknown network would be topped up forever with nothing eligible.
  c = await autoTrend.set({ chains: ["solana", "not-a-chain", "BSC"] });
  assert.deepStrictEqual(c.chains, ["solana", "bsc"], "unknown ids dropped, case normalised");
  // An empty list is a mistake, not an instruction — "auto-trend nothing" is
  // what the enabled switch is for. It falls back to the shipped set.
  c = await autoTrend.set({ chains: [] });
  assert.deepStrictEqual(c.chains, autoTrend.DEFAULTS.chains);
  c = await autoTrend.set({ minGapMin: 200, maxGapMin: 50 });
  assert.ok(c.maxGapMin >= c.minGapMin, "gap range kept valid");
  await autoTrend.reset();
  assert.deepStrictEqual(autoTrend.get(), autoTrend.DEFAULTS);
});

test("autotrend: disabled → no promotions", async () => {
  await autoTrend.reset(); // enabled:false
  api.getListings = async () => [{ status: "approved", chain: "solana", address: "a", sym: "A", trendingRank: null }];
  let booked = 0;
  api.bookTrending = async () => (booked++, {});
  assert.strictEqual(await autoTrend.runOnce(), 0);
  assert.strictEqual(booked, 0, "nothing promoted while disabled");
});

test("every chain is topped up against its OWN count, not one shared pool", async () => {
  // THE bug, in one fixture. The board groups by network, and a single global
  // target let the network with the most listings win every shuffle: the live
  // board showed 5 Solana tokens, one BSC, one Ethereum, one Base — and no
  // Robinhood at all. Five listings per chain must produce five per chain.
  await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, perChainMin: 5, perChainMax: 5, minHours: 3, maxHours: 18 });
  const now = Date.now();
  const rows = [];
  for (const chain of ["solana", "bsc", "ethereum", "base", "robinhood"]) {
    // Solana is the crowded one — 12 candidates against everyone else's 5. Under
    // the old code that head start was the whole board.
    const n = chain === "solana" ? 12 : 5;
    for (let i = 0; i < n; i++) rows.push({ status: "approved", chain, address: `${chain}${i}`, sym: `${chain}${i}`, trendingRank: null });
  }
  api.getListings = async () => rows;
  const calls = [];
  api.bookTrending = async (chain, address, hours) => (calls.push({ chain, address, hours }), {});
  const promoted = await autoTrend.runOnce({ rng: () => 0.5 });

  const byChain = {};
  for (const c of calls) byChain[c.chain] = (byChain[c.chain] || 0) + 1;
  assert.deepStrictEqual(byChain, { solana: 5, bsc: 5, ethereum: 5, base: 5, robinhood: 5 }, JSON.stringify(byChain));
  assert.strictEqual(promoted, 25);
  for (const c of calls) assert.ok(c.hours >= 3 && c.hours <= 18, `duration ${c.hours} within 3–18h`);
  void now;
});

test("a chain already at its count is left alone; a short one is topped up", async () => {
  await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, perChainMin: 2, perChainMax: 2 });
  const now = Date.now();
  api.getListings = async () => [
    // solana: two already featured → nothing needed
    { status: "approved", chain: "solana", address: "s1", trendingRank: 1, trendExp: now + 3600e3 },
    { status: "approved", chain: "solana", address: "s2", trendingRank: 2, trendExp: now + 3600e3 },
    { status: "approved", chain: "solana", address: "s3", trendingRank: null },
    // bsc: one featured, one free → needs exactly one
    { status: "approved", chain: "bsc", address: "b1", trendingRank: 3, trendExp: now + 3600e3 },
    { status: "approved", chain: "bsc", address: "b2", trendingRank: null },
    // an EXPIRED slot is not featured — it is the whole reason this loop exists
    { status: "approved", chain: "base", address: "x1", trendingRank: 9, trendExp: now - 1000 },
    { status: "approved", chain: "base", address: "x2", trendingRank: null },
    // never eligible
    { status: "pending", chain: "solana", address: "np", trendingRank: null },
  ];
  const calls = [];
  api.bookTrending = async (chain, address) => (calls.push({ chain, address }), {});
  await autoTrend.runOnce({ rng: () => 0.5 });
  const got = calls.map((c) => c.address).sort();
  assert.deepStrictEqual(got, ["b2", "x1", "x2"], `promoted ${got.join(",")}`);
  assert.ok(!got.includes("s3"), "solana was already at 2 — do not overfill it");
  assert.ok(!got.includes("np"), "never promotes a non-approved listing");
});

test("only the configured chains are filled", async () => {
  // Tron has no listings and nobody sells trending there; topping it up every
  // cycle would just log a failure forever.
  await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, perChainMin: 3, perChainMax: 3, chains: ["solana", "robinhood"] });
  api.getListings = async () => [
    { status: "approved", chain: "solana", address: "s1", trendingRank: null },
    { status: "approved", chain: "robinhood", address: "r1", trendingRank: null },
    { status: "approved", chain: "tron", address: "t1", trendingRank: null },
    { status: "approved", chain: "ethereum", address: "e1", trendingRank: null },
  ];
  const calls = [];
  api.bookTrending = async (chain, address) => (calls.push(address), {});
  await autoTrend.runOnce({ rng: () => 0.5 });
  assert.deepStrictEqual(calls.sort(), ["r1", "s1"]);
  await autoTrend.set({ chains: autoTrend.DEFAULTS.chains });
});

test("a chain that CANNOT be filled says so — silence looks identical to 'not yet'", async () => {
  // Robinhood with two listings can never reach five, and no number of cycles
  // will change that. Without this line the operator waits for a loop that has
  // already done everything it can.
  await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, perChainMin: 5, perChainMax: 5 });
  api.getListings = async () => [{ status: "approved", chain: "robinhood", address: "r1", trendingRank: null }];
  api.bookTrending = async () => ({});
  const warns = [];
  const realWarn = log.noise;
  log.noise = (...a) => warns.push(a.join(" "));
  await autoTrend._test.resetShortWarn();
  try {
    await autoTrend.runOnce({ rng: () => 0.5 });
  } finally {
    log.noise = realWarn;
  }
  const line = warns.join("\n");
  assert.match(line, /board below target/, line);
  assert.match(line, /robinhood \(needs 5, only 1 eligible\)/, line);
  assert.match(line, /solana \(needs 5, none eligible\)/, line);
  assert.match(line, /list more tokens on those chains, or lower the per-chain target/, "it must say what to DO");
});

// These three spy on log.noise rather than log.warn. The line is still emitted,
// still throttled, and still survives a restart — what changed is that it no
// longer pages the operator's Telegram channel, because a board that is short
// because the market is short is not something anyone can go and fix. It is in
// pm2 logs, and OPS_VERBOSE=1 puts it back in the channel. See opsNoise.test.js.
test("the shortfall warning does not repeat every cycle", async () => {
  // It is a standing condition on a loop that runs every few minutes. Saying it
  // each time is how a real warning becomes wallpaper.
  await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, perChainMin: 5, perChainMax: 5 });
  api.getListings = async () => [{ status: "approved", chain: "bsc", address: "b1", trendingRank: null }];
  api.bookTrending = async () => ({});
  const warns = [];
  const realWarn = log.noise;
  log.noise = (...a) => warns.push(a.join(" "));
  await autoTrend._test.resetShortWarn();
  try {
    for (let i = 0; i < 5; i++) await autoTrend.runOnce({ rng: () => 0.5 });
  } finally {
    log.noise = realWarn;
  }
  assert.strictEqual(warns.filter((w) => w.includes("board below target")).length, 1, warns.join("\n"));
});

test("forced run promotes on the requested chain only", async () => {
  const rows = [
    { status: "approved", chain: "solana", address: "s1", sym: "S1" },
    { status: "approved", chain: "solana", address: "s2", sym: "S2" },
    { status: "approved", chain: "bsc", address: "b1", sym: "B1" },
  ];
  const booked = [];
  const realGet = api.getListings;
  const realBook = api.bookTrending;
  api.getListings = async () => rows;
  api.bookTrending = async (chain, address, hours) => {
    booked.push({ chain, address, hours });
    return {};
  };
  try {
    await autoTrend.set({ enabled: false, minMcapUsd: 0, minVol24hUsd: 0 }); // forced runs work with the service OFF
    assert.strictEqual(await autoTrend.runOnce({ chain: "bsc" }), 1);
    assert.strictEqual(booked.length, 1);
    assert.strictEqual(booked[0].chain, "bsc", `promoted the wrong chain: ${JSON.stringify(booked)}`);
    const cfg = autoTrend.get();
    assert.ok(booked[0].hours >= cfg.minHours && booked[0].hours <= cfg.maxHours, "duration stays inside the configured band");
  } finally {
    api.getListings = realGet;
    api.bookTrending = realBook;
  }
});

test("forced run: nothing eligible on that chain → 0, not an error", async () => {
  const now = Date.now();
  const realGet = api.getListings;
  const realBook = api.bookTrending;
  let booked = 0;
  // The only Solana token is already featured.
  api.getListings = async () => [
    { status: "approved", chain: "solana", address: "s1", sym: "S1", trendingRank: 1, trendExp: now + 3_600_000 },
  ];
  api.bookTrending = async () => {
    booked++;
    return {};
  };
  try {
    assert.strictEqual(await autoTrend.runOnce({ chain: "solana" }), 0);
    assert.strictEqual(booked, 0);
  } finally {
    api.getListings = realGet;
    api.bookTrending = realBook;
  }
});

test("featuredByChain counts what the panel shows", async () => {
  const now = Date.now();
  const realGet = api.getListings;
  api.getListings = async () => [
    { status: "approved", chain: "solana", address: "s1", trendingRank: 1, trendExp: now + 3_600_000 },
    { status: "approved", chain: "solana", address: "s2" },
    { status: "approved", chain: "bsc", address: "b1" },
    // Xpress is listing-only and can never be auto-promoted, so counting it as
    // "eligible" made the panel promise a token the promoter would never touch
    // — while Run now on the same chain answered "all listed tokens are already
    // trending". It gets its own bucket.
    { status: "approved", chain: "bsc", address: "b3", tier: "XPRESS" },
    { status: "approved", chain: "bsc", address: "b4", tier: "xpress" }, // case must not matter
    { status: "pending", chain: "bsc", address: "b2" }, // not approved → invisible
  ];
  try {
    const by = await autoTrend.featuredByChain(now);
    assert.deepStrictEqual(by.solana, { featured: 1, eligible: 1 });
    // Xpress counts as eligible like anything else — it is promotable.
    assert.deepStrictEqual(by.bsc, { featured: 0, eligible: 3 });
  } finally {
    api.getListings = realGet;
  }
});

// forceChain() exists because a button has to explain a zero. "0 promoted" has
// three very different causes and the operator can only act on the right one;
// silence on a tap reads as "the button is broken", which is how this was
// reported.
test("forceChain: promotes and names what it promoted", async () => {
  const realGet = api.getListings;
  const realBook = api.bookTrending;
  api.getListings = async () => [
    { status: "approved", chain: "bsc", address: "b1", sym: "$B1" },
    { status: "approved", chain: "solana", address: "s1", sym: "$S1" },
  ];
  api.bookTrending = async () => ({});
  try {
    const r = await autoTrend.forceChain("bsc");
    assert.strictEqual(r.promoted, 1);
    assert.match(r.syms[0], /\$B1 \d+h/, `names the token and its run: ${JSON.stringify(r.syms)}`);
    assert.strictEqual(r.reason, "", "no reason needed when it worked");
  } finally {
    api.getListings = realGet;
    api.bookTrending = realBook;
  }
});

test("forceChain: each kind of zero explains itself", async () => {
  const now = Date.now();
  const realGet = api.getListings;
  const realBook = api.bookTrending;
  try {
    // 1. nothing listed on that chain
    api.getListings = async () => [{ status: "approved", chain: "bsc", address: "b1", sym: "$B1" }];
    api.bookTrending = async () => ({});
    let r = await autoTrend.forceChain("solana");
    assert.strictEqual(r.promoted, 0);
    assert.match(r.reason, /no listings on solana/i, r.reason);

    // 2. everything there is already trending
    api.getListings = async () => [
      { status: "approved", chain: "solana", address: "s1", sym: "$S1", trendingRank: 1, trendExp: now + 3_600_000 },
    ];
    r = await autoTrend.forceChain("solana");
    assert.strictEqual(r.promoted, 0);
    assert.match(r.reason, /already trending/i, r.reason);

    // 3. the site refused the booking — the reason must carry the API's words
    api.getListings = async () => [{ status: "approved", chain: "solana", address: "s2", sym: "$S2" }];
    api.bookTrending = async () => {
      throw new Error("400: token not found");
    };
    r = await autoTrend.forceChain("solana");
    assert.strictEqual(r.promoted, 0);
    assert.match(r.reason, /refused|400/i, r.reason);

    // 4. the listings API is down
    api.getListings = async () => {
      throw new Error("ECONNREFUSED");
    };
    r = await autoTrend.forceChain("solana");
    assert.strictEqual(r.promoted, 0);
    assert.match(r.reason, /unavailable/i, r.reason);
  } finally {
    api.getListings = realGet;
    api.bookTrending = realBook;
  }
});

test("forceChain works while Auto Trending is OFF — it is a deliberate act", async () => {
  const realGet = api.getListings;
  const realBook = api.bookTrending;
  api.getListings = async () => [{ status: "approved", chain: "base", address: "x1", sym: "$X1" }];
  api.bookTrending = async () => ({});
  try {
    await autoTrend.set({ enabled: false, minMcapUsd: 0, minVol24hUsd: 0 });
    const r = await autoTrend.forceChain("base");
    assert.strictEqual(r.promoted, 1);
  } finally {
    api.getListings = realGet;
    api.bookTrending = realBook;
  }
});

// ── Announcing an auto-promotion ────────────────────────────────────────────
// Posting these publicly is the operator's call, but the volume is not: a slot
// lasts 3-18h and the target is 8, so refills alone are ~18 promotions a day.
// Every rail below exists to keep that from burying the PAID posts in the same
// channel — including the deep link a buyer was just DM'd as proof of delivery.
test("announce is OFF by default and every rail is railed", async () => {
  await autoTrend.reset();
  const c = autoTrend.get();
  assert.strictEqual(c.announce, false, "publishing must be opt-in");
  const wild = await autoTrend.set({ announcePerDay: 9999, announceGapMin: 0, announceCooldownDays: -5 });
  assert.ok(wild.announcePerDay <= 200, `daily cap railed: ${wild.announcePerDay}`);
  assert.ok(wild.announceGapMin >= 5, `spacing railed: ${wild.announceGapMin}`);
  assert.ok(wild.announceCooldownDays >= 0, `cooldown railed: ${wild.announceCooldownDays}`);
  await autoTrend.reset();
});

test("announceReason names every refusal", async () => {
  const now = 1_800_000_000_000;
  const DAY = 86_400_000;
  const row = { chain: "solana", address: "s1", sym: "$S1" };
  const cfg = { announce: true, announcePerDay: 3, announceGapMin: 60, announceCooldownDays: 7 };
  const empty = { announced: {}, day: null, lastAt: 0, pending: [] };
  assert.strictEqual(autoTrend.announceReason(row, empty, cfg, now), null, "a clean state may post");
  assert.match(autoTrend.announceReason(row, empty, { ...cfg, announce: false }, now), /off/i);
  assert.match(
    autoTrend.announceReason(row, { ...empty, day: { key: new Date(now).toISOString().slice(0, 10), n: 3 } }, cfg, now),
    /daily cap/i,
  );
  assert.match(autoTrend.announceReason(row, { ...empty, lastAt: now - 60_000 }, cfg, now), /too soon/i);
  assert.match(
    autoTrend.announceReason(row, { ...empty, announced: { "solana:s1": now - 2 * DAY } }, cfg, now),
    /cooldown/i,
  );
  // …and past the cooldown the same token is allowed again.
  assert.strictEqual(
    autoTrend.announceReason(row, { ...empty, announced: { "solana:s1": now - 8 * DAY } }, cfg, now),
    null,
  );
});

test("every listed token is eligible — no package is skipped", async () => {
  // The operator's rule, in their words: every listed token can get trending,
  // free or paid. An earlier version held Xpress back from the free fill to
  // protect an upsell; it left chains visibly stuck and was not what was wanted.
  await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, perChainMin: 5, perChainMax: 5 });
  const realGet = api.getListings;
  api.getListings = async () => [
    { status: "approved", chain: "solana", address: "x1", sym: "X1", tier: "XPRESS", trendingRank: null },
    { status: "approved", chain: "solana", address: "g1", sym: "G1", tier: "GOLD", trendingRank: null },
  ];
  const calls = [];
  api.bookTrending = async (chain, address) => (calls.push(address), {});
  try {
    await autoTrend.runOnce({ rng: () => 0.5 });
    assert.deepStrictEqual(calls.sort(), ["g1", "x1"], "both go up; the package is not a gate");
  } finally {
    api.getListings = realGet;
  }
});

test("no tier gate survives anywhere in the promoter", () => {
  // Cheap and blunt on purpose: this rule has been re-broken once already.
  const fss = require("node:fs");
  const src = fss
    .readFileSync(require.resolve("../src/services/autoTrend.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/XPRESS|NEVER_PROMOTE/.test(src), "a tier exclusion is back in autoTrend");
});


test("Run now promotes ANY package — it is the admin's own hand, not the policy", async () => {
  // The operator's rule, in their words: a listed token, whatever package it
  // holds, gets trending when it is asked for. Applying the give-away rule to
  // this button left a chain visibly stuck with no way to override it, and the
  // alert claimed "all 5 are already trending" when two were.
  const realGet = api.getListings;
  const soon = Date.now() + 3600e3;
  api.getListings = async () => [
    { status: "approved", chain: "bsc", address: "b1", sym: "A", trendingRank: 1, trendExp: soon },
    { status: "approved", chain: "bsc", address: "b2", sym: "B", trendingRank: 2, trendExp: soon },
    { status: "approved", chain: "bsc", address: "b3", sym: "C", tier: "XPRESS" },
  ];
  const calls = [];
  api.bookTrending = async (chain, address) => (calls.push(address), {});
  try {
    const res = await autoTrend.forceChain("bsc");
    assert.strictEqual(res.promoted, 1, res.reason);
    assert.deepStrictEqual(calls, ["b3"], "the Xpress token is placed, because the admin asked");
    assert.strictEqual(res.reason, "");
  } finally {
    api.getListings = realGet;
  }
});

test("a genuinely full chain still says so", async () => {
  const realGet = api.getListings;
  const soon = Date.now() + 3600e3;
  api.getListings = async () => [
    { status: "approved", chain: "base", address: "x1", trendingRank: 1, trendExp: soon },
    { status: "approved", chain: "base", address: "x2", trendingRank: 2, trendExp: soon },
  ];
  try {
    const res = await autoTrend.forceChain("base");
    assert.match(res.reason, /all 2 listed token\(s\) on base are already trending/, res.reason);
  } finally {
    api.getListings = realGet;
  }
});

test("a PAID trending order is never refused for its package", () => {
  // The guarantee behind all of the above: "token yang sudah listing, mau apapun
  // package, kalau client pesan trending harus dilakukan." The purchase flow
  // resolves the listing by address and books it — there is no tier check, and
  // adding one would be refusing a sale.
  const fss = require("node:fs");
  const flow = fss.readFileSync(require.resolve("../src/handlers/trending.js"), "utf8");
  // The listing lookup is the only gate: approved, and the address matches.
  // A tier term anywhere in that filter would be refusing a sale. (The file does
  // mention Xpress — as the button offered when the token is NOT listed yet.)
  const lookup = flow.slice(flow.indexOf("listing = all.find("), flow.indexOf("if (!listing)"));
  assert.match(lookup, /r\.status === "approved"/);
  assert.ok(!/tier/i.test(lookup), `the purchase flow filters on tier: ${lookup}`);
  assert.ok(!/NEVER_PROMOTE/.test(flow));
  const fulfil = fss.readFileSync(require.resolve("../src/fulfillment.js"), "utf8");
  const fn = fulfil.slice(fulfil.indexOf("async function fulfillTrending("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /await api\.bookTrending\(p\.chain, p\.address, p\.hours\)/, "it books what was paid for");
  assert.ok(!/XPRESS|NEVER_PROMOTE/.test(body), "…unconditionally");
});


test("a forced run QUEUES its announcement — the admin process cannot post", async () => {
  // channels/post.attach() happens only in src/bot.js (the main bot), so a post
  // from the admin process would throw "not attached to a bot". forceChain
  // hands the announcement over instead.
  const realGet = api.getListings;
  const realBook = api.bookTrending;
  api.getListings = async () => [{ status: "approved", chain: "base", address: "b9", sym: "$B9" }];
  api.bookTrending = async () => ({});
  try {
    await autoTrend.resetAnnounceState();
    await autoTrend.set({ announce: true });
    const r = await autoTrend.forceChain("base");
    assert.strictEqual(r.promoted, 1);
    const state = JSON.parse(fss.readFileSync(path.join(process.env.BOT_DATA_DIR, "autoTrendState.json"), "utf8"));
    assert.strictEqual(state.pending.length, 1, "queued for the main process");
    assert.strictEqual(state.pending[0].address, "b9");
  } finally {
    api.getListings = realGet;
    api.bookTrending = realBook;
    await autoTrend.resetAnnounceState();
    await autoTrend.reset();
  }
});

test("the auto post uses the SAME template as a paid trending purchase", () => {
  // Operator's call (2026-07-25): "templatenya harus sama dengan trending yang
  // sudah di set, nothing beda". So there is no separate auto template — an
  // edit to Post: Trending in the admin bot must change BOTH.
  const src = fss.readFileSync(require.resolve("../src/services/autoTrend.js"), "utf8");
  assert.match(src, /fmt\.trendingPost\(coin\)/, "renders the paid trending card");
  assert.ok(!/trendingAutoPost|post_trending_auto/.test(src), "no separate auto card");
  const tpl = require("../src/templates");
  assert.ok(!tpl.keys().includes("post_trending_auto"), "the separate template is gone from the editor too");
  // …and the artwork badge states the slot's real length, like a paid run.
  assert.match(src, /Trending \$\{hours\}H/, "same badge shape as fulfillment.js");
});

test("the announce path never posts to the announcement channel", () => {
  // A @dexvraio headline is a 24H/48H PAID inclusion. Auto runs cap at 18h, so
  // today this holds by accident — pin it on purpose.
  const src = fss.readFileSync(require.resolve("../src/services/autoTrend.js"), "utf8");
  assert.ok(!/CHANNELS\.announce/.test(src), "autoTrend must never reference the announcement channel");
  assert.ok(/CHANNELS\.trending/.test(src), "…only the trending channel");
  assert.ok(!/pin:\s*true/.test(src), "and never pin — that pin belongs to the board");
});





// ── Top gainers ──────────────────────────────────────────────────────────────
const market = require("../src/marketdata");

test("the board is filled by 24h gain, best first — not by a coin flip", async () => {
  // "trending di liat dari top gainers." A trending board is a claim about what
  // is moving; a random fill made that claim false, and put a token down 80%
  // beside one up 40% with nothing to tell them apart.
  const realFetch = market.fetchMarket;
  const gains = { a: 5, b: 140, c: -62, d: 38 };
  market.fetchMarket = async (_chain, address) => ({ change24h: gains[address] });
  try {
    const rows = ["a", "b", "c", "d"].map((address) => ({ chain: "bsc", address }));
    const ranked = await autoTrend.byGain(rows);
    assert.deepStrictEqual(ranked.map((r) => r.address), ["b", "d", "a", "c"]);
  } finally {
    market.fetchMarket = realFetch;
  }
});

test("only the top N are promoted, and they are the top N", async () => {
  const realFetch = market.fetchMarket;
  const realGet = api.getListings;
  const gains = { s1: 12, s2: 300, s3: -40, s4: 90, s5: 2 };
  market.fetchMarket = async (_c, address) => ({ change24h: gains[address] });
  api.getListings = async () =>
    Object.keys(gains).map((address) => ({ status: "approved", chain: "solana", address, sym: address, trendingRank: null }));
  const calls = [];
  api.bookTrending = async (_c, address) => (calls.push(address), {});
  try {
    await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, perChainMin: 2, perChainMax: 2, chains: ["solana"] });
    await autoTrend.runOnce({ rng: () => 0.5 });
    assert.deepStrictEqual(calls, ["s2", "s4"], `promoted ${calls.join(",")}`);
  } finally {
    market.fetchMarket = realFetch;
    api.getListings = realGet;
    await autoTrend.set({ chains: autoTrend.DEFAULTS.chains, perChainMin: 5, perChainMax: 5 });
  }
});

test("a token with no price still gets a turn — it just goes last", async () => {
  // Robinhood has no indexer, so most of its listings price as null. Dropping
  // them would quietly mean that chain is never auto-filled at all.
  const realFetch = market.fetchMarket;
  market.fetchMarket = async (_c, address) => (address === "priced" ? { change24h: 7 } : null);
  try {
    const rows = ["dark1", "priced", "dark2"].map((address) => ({ chain: "robinhood", address }));
    const ranked = await autoTrend.byGain(rows, () => 0);
    assert.strictEqual(ranked[0].address, "priced", "a real gain outranks an unknown");
    assert.deepStrictEqual(ranked.slice(1).map((r) => r.address).sort(), ["dark1", "dark2"], "…but the rest are still there");
  } finally {
    market.fetchMarket = realFetch;
  }
});

test("a price lookup that throws does not take the cycle down", async () => {
  const realFetch = market.fetchMarket;
  market.fetchMarket = async () => { throw new Error("429 rate limited"); };
  try {
    const rows = [{ chain: "bsc", address: "a" }, { chain: "bsc", address: "b" }];
    const ranked = await autoTrend.byGain(rows, () => 0);
    assert.strictEqual(ranked.length, 2, "everything is still promotable");
  } finally {
    market.fetchMarket = realFetch;
  }
});

test("Run now places the best mover, not an arbitrary one", async () => {
  const realFetch = market.fetchMarket;
  const realGet = api.getListings;
  const gains = { b1: -5, b2: 210, b3: 44 };
  market.fetchMarket = async (_c, address) => ({ change24h: gains[address] });
  api.getListings = async () =>
    Object.keys(gains).map((address) => ({ status: "approved", chain: "bsc", address, sym: address, trendingRank: null }));
  const calls = [];
  api.bookTrending = async (_c, address) => (calls.push(address), {});
  try {
    const res = await autoTrend.forceChain("bsc");
    assert.strictEqual(res.promoted, 1);
    assert.deepStrictEqual(calls, ["b2"], `placed ${calls.join(",")}`);
  } finally {
    market.fetchMarket = realFetch;
    api.getListings = realGet;
  }
});

test("the price probe is bounded — this runs on a timer", async () => {
  // A chain with 400 listings must not fire 400 lookups every cycle at the same
  // API the board poster is using.
  //
  // ⚠️ SIZED FROM THE CAP, never a literal. The old fixture was 60 rows against
  // a hardcoded `<= 25`; the day the budget was raised that turned a rule-check
  // into a number nobody could read, and a fixture SMALLER than the cap cannot
  // reach the branch at all — it would pass over a probe that was not bounded.
  const N = autoTrend.PROBE_CAP + 20;
  const realFetch = market.fetchMarket;
  let calls = 0;
  market.fetchMarket = async () => (calls++, { change24h: 1 });
  try {
    const rows = Array.from({ length: N }, (_, i) => ({ chain: "bsc", address: `t${i}` }));
    const ranked = await autoTrend.byGain(rows, () => 0);
    assert.ok(calls <= autoTrend.PROBE_CAP, `probed ${calls} candidates, cap is ${autoTrend.PROBE_CAP}`);
    assert.ok(calls < N, "the fixture must exceed the cap, or this test proves nothing");
    assert.strictEqual(ranked.length, N, "the unprobed tail is still eligible, just unranked");
  } finally {
    market.fetchMarket = realFetch;
  }
});

test("⚠️ the probe WINDOW ROTATES — a fixed prefix starved a chain of 190 listings", async () => {
  // THE bug, in one fixture. `byGain` used to price `rows.slice(0, PROBE_CAP)`
  // — the first N in store order, which is the same N on every cycle for ever.
  // So a chain whose front rows are dead could never reach its minimum from its
  // own listings however many good tokens sat behind them: the live board
  // published 1–2 rows per chain against a minimum of 5, and every surface
  // reported it as "every spare is below the floors" about rows nobody opened.
  await autoTrend._test.forgetProbes();
  const realFetch = market.fetchMarket;
  const realGet = api.getListings;
  const N = autoTrend.PROBE_CAP;
  const rows = [];
  for (let i = 0; i < N * 2; i++) rows.push({ status: "approved", chain: "bsc", address: `dead${i}`, sym: `DEAD${i}`, trendingRank: null });
  for (let i = 0; i < 10; i++) rows.push({ status: "approved", chain: "bsc", address: `good${i}`, sym: `GOOD${i}`, trendingRank: null });
  market.fetchMarket = async (_c, a) =>
    String(a).startsWith("dead")
      ? { priceUsd: 1e-7, mcap: 1_000, vol24h: 5, change24h: -2 }
      : { priceUsd: 1, mcap: 50_000_000, vol24h: 2_000_000, change24h: 12 };
  api.getListings = async () => rows;
  const booked = [];
  api.bookTrending = async (_c, a) => (booked.push(a), {});
  try {
    await autoTrend.set({
      enabled: true, chains: ["bsc"], perChainMin: 5, perChainMax: 5, minGainPct: 5,
      minMcapUsd: 100_000, minVol24hUsd: 10_000, fillFromMarket: false,
    });
    // Two passes open the dead rows and correctly promote nothing…
    await autoTrend.runOnce({ rng: () => 0.5 });
    assert.deepStrictEqual(booked, [], "the dead rows are refused, which is the floors working");
    await autoTrend.runOnce({ rng: () => 0.5 });
    assert.deepStrictEqual(booked, [], "still inside the dead rows");
    // …and the third reaches the ones a prefix could never have opened.
    await autoTrend.runOnce({ rng: () => 0.5 });
    assert.strictEqual(booked.length, 5, `the window did not rotate — booked ${booked.join(",") || "nothing"}`);
    assert.ok(booked.every((a) => a.startsWith("good")), `promoted a dead row: ${booked.join(",")}`);
  } finally {
    market.fetchMarket = realFetch;
    api.getListings = realGet;
    await autoTrend._test.forgetProbes();
    await autoTrend.set({ chains: autoTrend.DEFAULTS.chains, perChainMin: 5, perChainMax: 5, minGainPct: 0, minMcapUsd: 0, minVol24hUsd: 0, fillFromMarket: true });
  }
});

test("⚠️ the BOT always measures, so an ops alert can never say 'this run did not price them'", async () => {
  // `trendingWatch` answers `unmeasured` when nobody priced the spares — right
  // for `trending:check` without --floors, and nonsense in the ops channel: the
  // cycle is the thing that prices them. So every chain the bot reports on with
  // spares must carry a `considered`, or an early `continue` added above
  // `byGain` one day turns the alert into a shrug.
  await autoTrend._test.forgetProbes();
  const watch = require("../src/services/trendingWatch");
  const realEval = watch.evaluate;
  const realFetch = market.fetchMarket;
  const realGet = api.getListings;
  const seen = [];
  watch.evaluate = (snapshot, prev, opts) => (seen.push(...snapshot), realEval(snapshot, prev, opts));
  market.fetchMarket = async () => ({ priceUsd: 1e-7, mcap: 1_000, vol24h: 5, change24h: -2 });
  api.getListings = async () => [
    { status: "approved", chain: "bsc", address: "a1", sym: "A1", trendingRank: null },
    { status: "approved", chain: "bsc", address: "a2", sym: "A2", trendingRank: null },
  ];
  api.bookTrending = async () => ({});
  try {
    await autoTrend.set({ enabled: true, chains: ["bsc"], perChainMin: 5, perChainMax: 5, minMcapUsd: 100_000, minVol24hUsd: 10_000, fillFromMarket: false });
    await autoTrend.runOnce({ rng: () => 0.5 });
    const bsc = seen.find((c) => c.id === "bsc");
    assert.ok(bsc, "the cycle must report on the chain it just worked");
    assert.ok(bsc.eligible > 0, "the fixture must leave spares, or this proves nothing");
    assert.strictEqual(typeof bsc.considered, "number", "the cycle handed the watch an unmeasured chain");
    assert.notStrictEqual(watch.diagnose(bsc).code, "unmeasured", watch.diagnose(bsc).text);
  } finally {
    watch.evaluate = realEval;
    market.fetchMarket = realFetch;
    api.getListings = realGet;
    await autoTrend._test.forgetProbes();
    await autoTrend.set({ chains: autoTrend.DEFAULTS.chains, minMcapUsd: 0, minVol24hUsd: 0, fillFromMarket: true });
  }
});

test("⚠️ a cycle that cannot read the listings API is LOUD, not silent", async () => {
  // It was `log.debug`, so a site the bot cannot read stopped every promotion
  // on every chain in silence — the board decayed as slots expired, and
  // `trending:check` kept working because it is a different process with its
  // own env. Nine hours and three restarts on a live box with no `[autotrend]`
  // line at all is what that looks like.
  const realGet = api.getListings;
  const realWarn = log.warn;
  const warned = [];
  log.warn = (m) => warned.push(String(m));
  api.getListings = async () => { throw new Error("fetch failed"); };
  try {
    await autoTrend.set({ enabled: true, chains: ["bsc"] });
    assert.strictEqual(await autoTrend.runOnce({ rng: () => 0.5 }), 0);
    assert.ok(
      warned.some((m) => /cycle ABORTED/.test(m) && /fetch failed/.test(m)),
      `the cycle died silently: ${JSON.stringify(warned)}`,
    );
  } finally {
    api.getListings = realGet;
    log.warn = realWarn;
    await autoTrend.set({ chains: autoTrend.DEFAULTS.chains });
  }
});

test("⚠️ a cycle that COMPLETES says so — silence must mean the loop is dead", async () => {
  // The heartbeat. Every failure path logged at debug and every success at
  // info, so "the loop is not running", "it ran and had nothing to do" and "it
  // threw" were one observation: none. `start()` is the only production caller
  // of the tick, so the assertion drives it rather than `runOnce` — a heartbeat
  // written into a function nothing schedules is the guard that never fires.
  const realGet = api.getListings;
  const realInfo = log.info;
  const lines = [];
  log.info = (m) => lines.push(String(m));
  api.getListings = async () => [];
  const realEnv = process.env.AUTOTREND_TICK_MS;
  try {
    await autoTrend.set({ enabled: true, chains: ["bsc"], minGapMin: 5, maxGapMin: 5 });
    const src = fss.readFileSync(path.join(__dirname, "..", "src", "services", "autoTrend.js"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.match(code, /cycle done in/, "the tick must emit a completion line");
    assert.ok(
      /const tick = async \(\) => \{[\s\S]*?cycle done in/.test(code),
      "the heartbeat must live in the scheduled tick, not somewhere nothing calls",
    );
    assert.ok(
      /catch \(e\) \{[\s\S]{0,200}cycle FAILED/.test(code),
      "a cycle that threw must be as loud as one that worked",
    );
  } finally {
    api.getListings = realGet;
    log.info = realInfo;
    if (realEnv === undefined) delete process.env.AUTOTREND_TICK_MS;
    await autoTrend.set({ chains: autoTrend.DEFAULTS.chains, minGapMin: 20, maxGapMin: 120 });
  }
});

test("⚠️ a booking the site refuses is LOUD, and reaches the watch", async () => {
  // It was `log.debug` while the success beside it was `log.info`, so on a box
  // where the site refuses every booking the board decays with nothing anywhere
  // saying why — the chain reads as short, every surface blames the floors, and
  // the operator is sent to change a setting that refused nothing. This file's
  // notes say the same asymmetry has had to be fixed in three services.
  await autoTrend._test.forgetProbes();
  const watch = require("../src/services/trendingWatch");
  const realEval = watch.evaluate;
  const realFetch = market.fetchMarket;
  const realGet = api.getListings;
  const realWarn = log.warn;
  const warned = [];
  const seen = [];
  watch.evaluate = (snap, prev, opts) => (seen.push(...snap), realEval(snap, prev, opts));
  log.warn = (m) => warned.push(String(m));
  market.fetchMarket = async () => ({ priceUsd: 1, mcap: 5e7, vol24h: 2e6, change24h: 12 });
  api.getListings = async () => [
    { status: "approved", chain: "bsc", address: "b1", sym: "B1", trendingRank: null },
    { status: "approved", chain: "bsc", address: "b2", sym: "B2", trendingRank: null },
  ];
  api.bookTrending = async () => { throw new Error("404: Listing not found"); };
  try {
    await autoTrend.set({ enabled: true, chains: ["bsc"], perChainMin: 5, perChainMax: 5, minGainPct: 0, minMcapUsd: 0, minVol24hUsd: 0, fillFromMarket: false });
    const n = await autoTrend.runOnce({ rng: () => 0.5 });
    assert.strictEqual(n, 0, "nothing was booked");
    assert.ok(
      warned.some((m) => /refused a booking/.test(m) && /404: Listing not found/.test(m)),
      `a refused booking was silent: ${JSON.stringify(warned)}`,
    );
    const bsc = seen.find((c) => c.id === "bsc");
    assert.ok(bsc && bsc.bookFailed > 0, "the watch was never told the site refused");
    assert.strictEqual(watch.diagnose(bsc).code, "book_failed", watch.diagnose(bsc).text);
  } finally {
    watch.evaluate = realEval;
    log.warn = realWarn;
    market.fetchMarket = realFetch;
    api.getListings = realGet;
    await autoTrend._test.forgetProbes();
    await autoTrend.set({ chains: autoTrend.DEFAULTS.chains, fillFromMarket: true });
  }
});

test("⚠️ a short board never claims something about rows nobody opened", async () => {
  // The log line, the ops alert and ⚡ Run now all said "every spare is below
  // the free-trending floors" while the ranking pass had opened a bounded
  // window of them. A failure rendered as a fact — and the fact it invents
  // sends the operator to lower a floor that refused nothing of the sort.
  await autoTrend._test.forgetProbes();
  const realFetch = market.fetchMarket;
  const realGet = api.getListings;
  const N = autoTrend.PROBE_CAP + 30;
  const rows = Array.from({ length: N }, (_, i) => ({ status: "approved", chain: "bsc", address: `d${i}`, sym: `D${i}`, trendingRank: null }));
  market.fetchMarket = async () => ({ priceUsd: 1e-7, mcap: 1_000, vol24h: 5, change24h: -2 });
  api.getListings = async () => rows;
  api.bookTrending = async () => ({});
  try {
    await autoTrend.set({ enabled: true, chains: ["bsc"], perChainMin: 5, perChainMax: 5, minMcapUsd: 100_000, minVol24hUsd: 10_000, fillFromMarket: false });
    const res = await autoTrend.forceChain("bsc");
    assert.strictEqual(res.promoted, 0);
    // ⚠️ ASSERTED AS ARITHMETIC, not as a phrase. A first cut matched on the
    // OLD sentence ("all 70 spare…"), which the fix had already reworded — so
    // it passed under the mutation it exists to catch, over a reason reading
    // "70 of the 40 spare listing(s) opened". The rule is that the accused
    // count can never exceed the opened count.
    const m = res.reason.match(/(\d+) of the (\d+) spare listing\(s\) opened/);
    assert.ok(m, `the refusal must say how many of how many were opened: ${res.reason}`);
    const [refused, openedN] = [Number(m[1]), Number(m[2])];
    assert.ok(
      refused <= openedN,
      `Run now accused ${refused} spares of failing a floor it only read ${openedN} of: ${res.reason}`,
    );
    assert.strictEqual(openedN, autoTrend.PROBE_CAP, "the fixture must exceed the window, or this proves nothing");
    assert.match(res.reason, /queued for the next passes/, res.reason);
  } finally {
    market.fetchMarket = realFetch;
    api.getListings = realGet;
    await autoTrend._test.forgetProbes();
    await autoTrend.set({ chains: autoTrend.DEFAULTS.chains, minMcapUsd: 0, minVol24hUsd: 0, fillFromMarket: true });
  }
});

test("a token in FREE-FALL is never auto-promoted, even to reach the minimum", async () => {
  // The board carried $Z at -99.94% with a $1,648 market cap. Ranking alone
  // could not stop that: five slots, five candidates, and sorting still
  // promotes the worst of them. A floor is what makes the board's claim true.
  //
  // The floor now YIELDS below the per-chain minimum (a board short of the
  // number the operator set is the thing they keep reporting) — but only down
  // to FLOOR_FILL_MAX_DROP. So -8% goes on to fill the minimum and -99.94%
  // never does, which is exactly the line the incident drew.
  const realFetch = market.fetchMarket;
  const realGet = api.getListings;
  const gains = { up1: 40, down1: -8, down2: -99.94, up2: 3 };
  market.fetchMarket = async (_c, address) => ({ change24h: gains[address] });
  api.getListings = async () =>
    Object.keys(gains).map((address) => ({ status: "approved", chain: "bsc", address, sym: address, trendingRank: null }));
  const calls = [];
  api.bookTrending = async (_c, address) => (calls.push(address), {});
  try {
    await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, perChainMin: 5, perChainMax: 5, chains: ["bsc"], minGainPct: 0 });
    await autoTrend.runOnce({ rng: () => 0.5 });
    assert.deepStrictEqual(calls, ["up1", "up2", "down1"], `promoted ${calls.join(",")}`);
    assert.ok(!calls.includes("down2"), "-99.94% must never reach the board, full or not");
  } finally {
    market.fetchMarket = realFetch;
    api.getListings = realGet;
    await autoTrend.set({ chains: autoTrend.DEFAULTS.chains });
  }
});

test("an unpriced token is exempt from the floor — otherwise Robinhood never fills", async () => {
  // Most Robinhood listings price as null: no indexer covers that chain.
  // Judging them against a number nobody can read would exclude the whole
  // network from the automatic fill, permanently and silently.
  const realFetch = market.fetchMarket;
  const realGet = api.getListings;
  market.fetchMarket = async () => null;
  api.getListings = async () => [
    { status: "approved", chain: "robinhood", address: "r1", sym: "R1", trendingRank: null },
    { status: "approved", chain: "robinhood", address: "r2", sym: "R2", trendingRank: null },
  ];
  const calls = [];
  api.bookTrending = async (_c, address) => (calls.push(address), {});
  try {
    await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, perChainMin: 5, perChainMax: 5, chains: ["robinhood"], minGainPct: 0 });
    await autoTrend.runOnce({ rng: () => 0.5 });
    assert.strictEqual(calls.length, 2, "both unpriced tokens are still promotable");
  } finally {
    market.fetchMarket = realFetch;
    api.getListings = realGet;
    await autoTrend.set({ chains: autoTrend.DEFAULTS.chains });
  }
});

test("a lone candidate is priced too — no shortcut past the floor", async () => {
  // byGain used to return a single row untouched, so the floor saw an
  // unannotated candidate and could not tell "no price" from "never looked".
  const realFetch = market.fetchMarket;
  market.fetchMarket = async () => ({ change24h: -50 });
  try {
    const [only] = await autoTrend.byGain([{ chain: "bsc", address: "solo" }]);
    assert.strictEqual(only._change, -50, "a lone candidate is still measured");
  } finally {
    market.fetchMarket = realFetch;
  }
});

test("Run now ignores the floor — the admin asked for it", async () => {
  // A deliberate act, not the automatic policy: sometimes the operator wants
  // SOMETHING on an empty chain, whatever the day's prices look like.
  const realFetch = market.fetchMarket;
  const realGet = api.getListings;
  market.fetchMarket = async () => ({ change24h: -30 });
  api.getListings = async () => [{ status: "approved", chain: "base", address: "d1", sym: "D1", trendingRank: null }];
  const calls = [];
  api.bookTrending = async (_c, address) => (calls.push(address), {});
  try {
    await autoTrend.set({ minGainPct: 0 });
    const res = await autoTrend.forceChain("base");
    assert.strictEqual(res.promoted, 1, res.reason);
    assert.deepStrictEqual(calls, ["d1"]);
  } finally {
    market.fetchMarket = realFetch;
    api.getListings = realGet;
  }
});

test("Robinhood is the third section on the board, not the last", () => {
  // Operator's call: it is Dexvra's own chain, and it was sitting under
  // Ethereum and Base at the bottom of its own board. One array drives the
  // board, the chain picker and the admin panel's rows, so a chain inserted in
  // the wrong place silently reshuffles a pinned public message.
  const { CHAIN_ORDER } = require("../src/config/chains");
  assert.deepStrictEqual(CHAIN_ORDER.slice(0, 5), ["solana", "bsc", "robinhood", "ethereum", "base"]);
  assert.strictEqual(CHAIN_ORDER.indexOf("robinhood"), 2, "third, counting from one");
});

test("the shortfall warning survives a restart — it is the reason it spammed", async () => {
  // The bug the operator saw: five identical "board below target" warnings in
  // the log channel inside ninety minutes, on a message that carried an HOURLY
  // guard. Both the guard (`lastShortWarnAt`) and the logger's own 15-minute
  // de-duplication lived in process memory, so every pm2 restart re-armed them
  // — and a deploy afternoon is a dozen restarts.
  const ops = require("../src/helpers/opsThrottle");
  await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, perChainMin: 5, perChainMax: 5 });
  api.getListings = async () => [{ status: "approved", chain: "bsc", address: "b1", trendingRank: null }];
  api.bookTrending = async () => ({});
  const warns = [];
  const realWarn = log.noise;
  log.noise = (...a) => warns.push(a.join(" "));
  await autoTrend._test.resetShortWarn();
  try {
    await autoTrend.runOnce({ rng: () => 0.5 });
    // A restart clears every module-level variable in the process. The mark is
    // on disk, so it must still be in force.
    delete require.cache[require.resolve("../src/services/autoTrend")];
    delete require.cache[require.resolve("../src/helpers/opsThrottle")];
    const fresh = require("../src/services/autoTrend");
    fresh._test.setAnnouncer(() => {});
    await fresh.runOnce({ rng: () => 0.5 });
  } finally {
    log.noise = realWarn;
  }
  assert.strictEqual(
    warns.filter((w) => w.includes("board below target")).length,
    1,
    `a restart must not re-arm the warning:\n${warns.join("\n")}`,
  );
  // Read through a module instance that never saw the first run: the mark can
  // only come from disk.
  assert.strictEqual(ops.due("autotrend_board_short", 3600_000), false, "the mark is persisted, not in memory");
});

test("the advice is daily, not hourly — it is a standing condition, not an incident", () => {
  const src = fss.readFileSync(require.resolve("../src/services/autoTrend"), "utf8");
  assert.match(src, /AUTOTREND_SHORT_WARN_HOURS \|\| 24/, "default is once a day");
  assert.match(src, /log\.debug\(line\);/, "…and pm2 logs still get it every cycle");
});

// ── The per-chain target is a RANGE, rolled ─────────────────────────────────
//
// "min 5 max 8 harus random per chain": one fixed number made every chain
// publish exactly the same count for ever — five rows, five rows, five rows —
// which reads as a generated list rather than a board.

test("a chain below the floor is topped up to a target ROLLED inside the range", async () => {
  const realGet = api.getListings;
  const calls = [];
  api.getListings = async () =>
    Array.from({ length: 12 }, (_, i) => ({ status: "approved", chain: "solana", address: `s${i}`, sym: `S${i}`, trendingRank: null }));
  api.bookTrending = async (_c, address) => (calls.push(address), {});
  try {
    await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, chains: ["solana"], perChainMin: 5, perChainMax: 8 });
    // rng at the bottom of the range → 5; at the top → 8. Both are legal
    // targets, and that IS the feature: two chains on one board land on
    // different counts.
    await autoTrend.runOnce({ rng: () => 0 });
    assert.strictEqual(calls.length, 5, `rolled the floor: ${calls.length}`);
    calls.length = 0;
    await autoTrend.runOnce({ rng: () => 0.999 });
    assert.strictEqual(calls.length, 8, `rolled the ceiling: ${calls.length}`);
  } finally {
    api.getListings = realGet;
    await autoTrend.reset();
  }
});

test("a chain at or above the FLOOR is left alone — that is what keeps the counts different", async () => {
  // Topping every chain up to a freshly rolled target on every cycle would
  // converge on the maximum: nothing ever takes a slot away, so a chain would
  // ratchet up to the highest number it ever rolled and stay there.
  const realGet = api.getListings;
  const now = Date.now();
  const calls = [];
  api.getListings = async () => [
    ...Array.from({ length: 6 }, (_, i) => ({ status: "approved", chain: "solana", address: `f${i}`, trendingRank: i + 1, trendExp: now + 3.6e6 })),
    { status: "approved", chain: "solana", address: "spare", trendingRank: null },
  ];
  api.bookTrending = async (_c, address) => (calls.push(address), {});
  try {
    await autoTrend.set({ enabled: true, minMcapUsd: 0, minVol24hUsd: 0, chains: ["solana"], perChainMin: 5, perChainMax: 8 });
    await autoTrend.runOnce({ rng: () => 0.999 }); // would roll 8 if it rolled at all
    assert.deepStrictEqual(calls, [], "6 ≥ the floor of 5, so nothing should have been promoted");
  } finally {
    api.getListings = realGet;
    await autoTrend.reset();
  }
});

test("the range cannot be inverted, and a legacy single target becomes the FLOOR", async () => {
  const { loadJSONSync, saveJSON } = require("../src/helpers/persist");
  void loadJSONSync;
  // max under min is a range nothing can satisfy; the floor wins because it is
  // the number set to keep the board from looking empty.
  let c = await autoTrend.set({ perChainMin: 7, perChainMax: 3 });
  assert.strictEqual(c.perChainMax, 7, "an inverted range must not survive");

  // An install that predates the range has `perChain` stored — a STORED value
  // beats a shipped default, so it becomes the floor rather than vanishing.
  await saveJSON("autoTrend.json", { enabled: true, perChain: 4 });
  c = autoTrend.get();
  assert.strictEqual(c.perChainMin, 4, "the operator's stored target was thrown away");
  assert.ok(c.perChainMax >= 4);
  await autoTrend.reset();

  // ⚠️ Number(null) is 0 — a finite zero that clamps to the FLOOR instead of
  // falling back to the default. A fresh install came out with a per-chain
  // minimum of zero, i.e. a board that never fills itself, and nothing errored.
  await saveJSON("autoTrend.json", { enabled: true });
  c = autoTrend.get();
  assert.strictEqual(c.perChainMin, autoTrend.DEFAULTS.perChainMin, "a config with no target must use the DEFAULT, not zero");
  await autoTrend.reset();
});
