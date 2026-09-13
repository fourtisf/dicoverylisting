// The listing PACE — "berapa jam sekali baru free listing di range misal range
// 2 sampai 3 jam" (2026-08-25).
//
// The requirement in one line: the gap that matters is between one free LISTING
// and the next, not between one SCAN and the next. A scan that finds nothing
// lists nothing, so the scan cadence was never a statement about the feed —
// with maxPerRun 3 behind it the site could take three listings in a minute and
// three more half an hour later, which is the firehose maxPerDay was supposed
// to bound and does not.
//
// The property most worth pinning is the one a naive implementation gets wrong:
// re-rolling the wait on every scan collapses the spacing to the FLOOR, because
// the first roll that lands under the elapsed time opens the gate. That makes
// the band decorative while every number on the panel still reads correct.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-alpace-"));

const test = require("node:test");
const assert = require("node:assert");

const al = require("../src/services/autoLister");
const api = require("../src/api/dexvra");

const M = 1_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const now = 1_800_000_000_000;

const healthy = (over = {}) => ({
  name: "Nine Hood",
  symbol: "NINEHOOD",
  mcap: 1.5 * M,
  liq: 120_000,
  vol24: 300_000,
  priceUsd: 0.0012,
  logoUrl: "https://dd.dexscreener.com/x.png",
  pairCreatedAt: now - 48 * HOUR,
  ...over,
});

/** A scan harness with the network stubbed. Returns what the site was asked to
 *  create, and how many tokens were PRICED — the second one is the point of the
 *  gate sitting where it does. */
function harness(addresses, { info = healthy } = {}) {
  const created = [];
  let priced = 0;
  let discovered = 0;
  let siteReads = 0;
  const realCreate = api.createListing;
  const realGet = api.getListings;
  const realCan = api.canCreate;
  // ⚠️ The WRITE PROBE too — 🔎 Test scan asks `api.canCreate()` now, and a stub
  // that leaves it out talks to the real site.
  api.canCreate = async () => ({ ok: true, status: 400, why: null });
  api.createListing = async (input) => {
    created.push(input);
    return { id: `id${created.length}`, ...input };
  };
  api.getListings = async () => {
    siteReads++;
    return [];
  };
  const deps = {
    fetchDiscovery: async () => {
      discovered++;
      return addresses.map((a) => ({ chain: "solana", address: a }));
    },
    fetchTokenInfo: async (_chain, a) => {
      priced++;
      return info(a);
    },
  };
  return {
    deps,
    created,
    counts: () => ({ priced, discovered, siteReads }),
    restore: () => {
      api.createListing = realCreate;
      api.getListings = realGet;
      api.canCreate = realCan;
    },
  };
}

/** Wipe both the config and the clock between tests. A persisted setting that
 *  leaks turns a later test's failure into a mystery about the code under it. */
async function fresh(cfg = {}) {
  await al.reset();
  await al.resetState();
  return al.set({ enabled: true, minMcap: 1 * M, maxMcap: 1.5 * M, postChannel: false, ...cfg });
}

// ── The band, and the roll that picks inside it ─────────────────────────────

test("the pace ships ON at the operator's own 2–3h, and it is a BAND", () => {
  assert.strictEqual(al.DEFAULTS.paceListings, true);
  assert.strictEqual(al.DEFAULTS.minListGapMin, 120);
  assert.strictEqual(al.DEFAULTS.maxListGapMin, 180);
  assert.strictEqual(al.paceRange(al.DEFAULTS), "2h–3h");
});

test("the wait is the roll's position inside the band", () => {
  const cfg = { minListGapMin: 120, maxListGapMin: 180 };
  assert.strictEqual(al.paceGapMs(cfg, 0), 120 * MIN);
  assert.strictEqual(al.paceGapMs(cfg, 0.5), 150 * MIN);
  assert.ok(Math.abs(al.paceGapMs(cfg, 0.999999) - 180 * MIN) < MIN / 10);
  // An unreadable roll falls to the FLOOR, never the ceiling: it must not be
  // able to freeze the feed for the longest wait in the band.
  // ⚠️ Number(null) is 0 and 0 is finite — 0 is also the intended fallback here.
  for (const bad of [undefined, null, NaN, "", "x", -1, 1, 2, {}])
    assert.strictEqual(al.paceGapMs(cfg, bad), 120 * MIN, `roll ${JSON.stringify(bad)} must fall to the floor`);
});

test("an inverted band resolves to the FLOOR — never a wait nobody typed", async () => {
  const c = await fresh({ minListGapMin: 180, maxListGapMin: 60 });
  assert.strictEqual(c.minListGapMin, 180);
  assert.strictEqual(c.maxListGapMin, 180);
  assert.strictEqual(al.paceRange(c), "3h", "a pinned band prints as one number");
});

test("durations are spelled ONE way", () => {
  assert.strictEqual(al.fmtGap(0), "0 min");
  assert.strictEqual(al.fmtGap(45), "45 min");
  assert.strictEqual(al.fmtGap(60), "1h");
  assert.strictEqual(al.fmtGap(150), "2h30m");
  assert.strictEqual(al.fmtGap(1440), "24h");
});

// ── The clock ───────────────────────────────────────────────────────────────

test("never listed yet → due now (a fresh install must not sit out a wait)", async () => {
  await fresh();
  const p = al.pace();
  assert.strictEqual(p.on, true);
  assert.strictEqual(p.lastAt, null);
  assert.strictEqual(p.due, true, "a wait for a listing that never happened");
});

test("a listing starts the clock, and the next one waits it out", async () => {
  await fresh({ minListGapMin: 120, maxListGapMin: 120 });
  const h = harness(["So1", "So2"]);
  try {
    assert.strictEqual(await al.runOnce({ now, deps: h.deps }), 1, "the first one goes out");
    assert.strictEqual(h.created.length, 1, "and ONLY one, though two qualified");

    // 119 minutes later: still inside the wait.
    assert.strictEqual(await al.runOnce({ now: now + 119 * MIN, deps: h.deps }), 0);
    assert.strictEqual(h.created.length, 1);
    const scan = al.lastScan();
    assert.ok(scan.paced, "the report says it was paced");
    assert.strictEqual(scan.blocker, null, "being paced is not a fault");
    assert.match(al.scanLine(scan), /paced — next free listing due in 1 min/);

    // 121 minutes later: the wait is over.
    assert.strictEqual(await al.runOnce({ now: now + 121 * MIN, deps: h.deps }), 1);
    assert.strictEqual(h.created.length, 2);
  } finally {
    h.restore();
  }
});

test("a paced scan costs NO price lookup — but still proves discovery and the site are alive", async () => {
  await fresh({ minListGapMin: 120, maxListGapMin: 120 });
  const h = harness(["So1", "So2", "So3"]);
  try {
    await al.runOnce({ now, deps: h.deps });
    const after = h.counts().priced;
    await al.runOnce({ now: now + 10 * MIN, deps: h.deps });
    assert.strictEqual(h.counts().priced, after, "a scan that may not list must not spend a lookup");
    // …and the two cheap calls the blocked-scan watchdog is built on still ran,
    // or BLOCKED_ALERTS_AT would stop meaning 1.5–4.5 hours.
    assert.strictEqual(h.counts().discovered, 2);
    assert.strictEqual(h.counts().siteReads, 2);
  } finally {
    h.restore();
  }
});

test("THE ROLL IS NOT RE-ROLLED BY THE SCANS THAT WAIT — the band would collapse to its floor", async () => {
  await fresh({ minListGapMin: 120, maxListGapMin: 180 });
  const h = harness(["So1", "So2"]);
  try {
    // The listing rolls the LONGEST wait in the band.
    await al.runOnce({ now, deps: h.deps, rng: () => 0.999999 });
    const rolled = al.pace().gapMs;
    assert.ok(rolled > 179 * MIN, `expected ~180 min, got ${rolled / MIN}`);

    // Now scan repeatedly with an rng that WOULD roll the shortest wait. If the
    // roll were taken fresh each time, the gate would open at 120 min and every
    // listing would land on the floor — the band decorative, the panel still
    // reading "2h–3h".
    for (const t of [125, 140, 160, 175]) {
      assert.strictEqual(await al.runOnce({ now: now + t * MIN, deps: h.deps, rng: () => 0 }), 0, `listed at ${t} min`);
      assert.strictEqual(al.pace().gapMs, rolled, `the wait moved while it was being waited out (${t} min)`);
    }
    assert.strictEqual(await al.runOnce({ now: now + 181 * MIN, deps: h.deps, rng: () => 0 }), 1);
  } finally {
    h.restore();
  }
});

test("the clock survives a restart — a redeploy must not publish back to back", async () => {
  await fresh({ minListGapMin: 120, maxListGapMin: 120 });
  const h = harness(["So1", "So2"]);
  try {
    await al.runOnce({ now, deps: h.deps });
    // A restart is a fresh REQUIRE — the same move the package-rotation test
    // makes, and for the same reason. Reading pace() off the live module would
    // pass on a clock held in a module-level variable, which is precisely the
    // implementation this rule exists to forbid: this service is redeployed far
    // more often than it is paced.
    delete require.cache[require.resolve("../src/services/autoLister")];
    const rebooted = require("../src/services/autoLister");
    const p = rebooted.pace(rebooted.get(), undefined, now + 30 * MIN);
    assert.strictEqual(p.due, false, "the clock went back to zero across a restart");
    assert.strictEqual(p.waitMs, 90 * MIN);
    assert.strictEqual(p.lastAt, now);
  } finally {
    h.restore();
  }
});

test("⚠️ a stamp in the FUTURE does not freeze the feed — it is treated as SPENT", async () => {
  await fresh({ minListGapMin: 120, maxListGapMin: 120 });
  const h = harness(["So1", "So2"]);
  try {
    // Clock skew, or a restored backup: the listing is recorded an hour ahead.
    await al.runOnce({ now: now + HOUR, deps: h.deps });
    const p = al.pace(al.get(), undefined, now);
    assert.strictEqual(p.skewed, true, "the clock is named as unreadable rather than believed");
    assert.strictEqual(p.due, true, "…and the feed goes on");
    // The first cut clamped lastAt to `now` instead. That reads as caution and
    // freezes the service FOREVER: nextAt recedes with every tick, and the
    // panel goes on saying 🟢 ON over a feed that will never list again.
    assert.strictEqual(await al.runOnce({ now, deps: h.deps }), 1);
    // …and the listing heals the clock.
    assert.strictEqual(al.pace(al.get(), undefined, now).skewed, false);
    assert.strictEqual(al.pace(al.get(), undefined, now).due, false);
  } finally {
    h.restore();
  }
});

test("editing the band applies to a wait already in progress", async () => {
  await fresh({ minListGapMin: 180, maxListGapMin: 180 });
  const h = harness(["So1", "So2"]);
  try {
    await al.runOnce({ now, deps: h.deps });
    assert.strictEqual(al.pace(al.get(), undefined, now + 90 * MIN).due, false);
    // The operator shortens it. A stored "next at" timestamp would go on
    // honouring the old range, which from the panel looks like a stopped clock.
    await al.set({ minListGapMin: 60, maxListGapMin: 60 });
    assert.strictEqual(al.pace(al.get(), undefined, now + 90 * MIN).due, true);
    assert.strictEqual(await al.runOnce({ now: now + 90 * MIN, deps: h.deps }), 1);
  } finally {
    h.restore();
  }
});

// ── What the pace does and does not govern ──────────────────────────────────

test("with the pace ON a scan lists at most ONE, whatever maxPerRun says", async () => {
  await fresh({ maxPerRun: 3, minListGapMin: 120, maxListGapMin: 120 });
  const h = harness(["So1", "So2", "So3", "So4"]);
  try {
    assert.strictEqual(await al.runOnce({ now, deps: h.deps }), 1);
    assert.strictEqual(h.created.length, 1);
  } finally {
    h.restore();
  }
});

test("with the pace OFF the old burst behaviour is exactly what happens", async () => {
  await fresh({ paceListings: false, maxPerRun: 3 });
  const h = harness(["So1", "So2", "So3", "So4"]);
  try {
    assert.strictEqual(await al.runOnce({ now, deps: h.deps }), 3, "maxPerRun again");
    // …and back to back: no wait between scans.
    assert.strictEqual(await al.runOnce({ now: now + MIN, deps: h.deps }), 1, "the fourth, one minute later");
    assert.strictEqual(al.pace().on, false);
    assert.strictEqual(al.pace().due, true);
  } finally {
    h.restore();
  }
});

test("the daily cap still binds under the pace, and still reports as the cap", async () => {
  await fresh({ maxPerDay: 1, minListGapMin: 1, maxListGapMin: 1 });
  const h = harness(["So1", "So2"]);
  try {
    assert.strictEqual(await al.runOnce({ now, deps: h.deps }), 1);
    assert.strictEqual(await al.runOnce({ now: now + 5 * MIN, deps: h.deps }), 0);
    assert.strictEqual(al.lastScan().capped, "1/1", "the cap, not the pace — they are different answers");
  } finally {
    h.restore();
  }
});

test("the TEST SCAN is not paced — it is the operator asking what the market looks like", async () => {
  await fresh({ minListGapMin: 600, maxListGapMin: 600 });
  const h = harness(["So1", "So2"]);
  try {
    await al.runOnce({ now, deps: h.deps });
    const before = h.counts().priced;
    const r = await al.dryRun({ now: now + MIN, deps: h.deps });
    assert.ok(h.counts().priced > before, "a read-only scan must still price");
    assert.ok(!r.paced, "and must never report itself as paced — it reports the MARKET");
    assert.ok(r.listed >= 1, "it says what qualifies right now");
    // …but it KNOWS about the pace, or the panel prints "2 would be listed
    // right now" four lines under "next one due in 2h30m" — one screen
    // contradicting itself, which is what this feature keeps being audited for.
    assert.ok(r.pace, "the dry run must carry the pace as context");
    assert.strictEqual(r.pace.due, false);
    assert.ok(r.pace.waitMs > 0);
  } finally {
    h.restore();
  }
});

test("createFromInfo is NOT paced — the market filler and the chain seeder list through it", async () => {
  await fresh({ minListGapMin: 600, maxListGapMin: 600 });
  const h = harness(["So1"]);
  try {
    await al.runOnce({ now, deps: h.deps });
    const clock = al.pace(al.get(), undefined, now).lastAt;
    // trendFill/chainSeed call this directly. Pacing it would put the "board
    // stays short" saga straight back, and its own limits already govern it.
    const made = await al.createFromInfo("solana", "So9", healthy(), { now: now + MIN });
    assert.ok(made && made.listing, "the filler's door is not gated by the scan's pace");
    // `pace()` defaults `now` to real time and this suite's clock is synthetic,
    // so the comparison has to name the same instant on both sides.
    assert.strictEqual(al.pace(al.get(), undefined, now).lastAt, clock, "…and it does not move the scan's clock");
  } finally {
    h.restore();
  }
});

// ── Reporting ───────────────────────────────────────────────────────────────

test("a paced scan is not a blocked scan — it must never page the operator", async () => {
  await fresh({ minListGapMin: 120, maxListGapMin: 120 });
  const h = harness(["So1", "So2"]);
  try {
    await al.runOnce({ now, deps: h.deps });
    for (let i = 1; i <= 4; i++) await al.runOnce({ now: now + i * MIN, deps: h.deps });
    const scan = al.lastScan();
    assert.strictEqual(scan.blocker, null);
    // The candidate count rides along so a long paced stretch cannot read as a
    // service that has gone blind.
    assert.strictEqual(scan.candidates, 2);
    assert.match(al.scanLine(scan), /2 candidates seen · paced/);
    assert.match(al.scanLine(scan), /this wait: 2h/);
  } finally {
    h.restore();
  }
});

test("the package rotation still takes turns ACROSS paced scans", async () => {
  // The rotation used to be read off several listings in ONE scan, which the
  // pace makes impossible. It has to keep alternating when the listings are
  // hours apart instead — the turn is on disk for exactly this reason.
  await fresh({ pkgs: ["xpress", "trending"], minListGapMin: 120, maxListGapMin: 120 });
  const h = harness(["So1", "So2", "So3", "So4"]);
  try {
    const shape = [];
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(await al.runOnce({ now: now + i * 121 * MIN, deps: h.deps }), 1, `scan ${i}`);
      shape.push(h.created[h.created.length - 1].trendExp ? "trending" : "xpress");
    }
    assert.deepStrictEqual(shape, ["xpress", "trending", "xpress", "trending"]);
  } finally {
    h.restore();
  }
});

test("a scan the pace holds back does not burn a package turn", async () => {
  // The turn advances at the listing, so a wait must leave it where it is —
  // otherwise a slow feed silently drifts toward whichever package the paced
  // scans happen to land on, which is the defect a REJECTED token already has
  // a rule against.
  await fresh({ pkgs: ["xpress", "trending"], minListGapMin: 120, maxListGapMin: 120 });
  const h = harness(["So1", "So2"]);
  try {
    await al.runOnce({ now, deps: h.deps });
    const next = al.nextPkg().key;
    for (const t of [10, 20, 30, 60, 90]) await al.runOnce({ now: now + t * MIN, deps: h.deps });
    assert.strictEqual(al.nextPkg().key, next, "five paced scans moved the rotation on");
  } finally {
    h.restore();
  }
});

// ── The scan cadence must not turn the band into a bigger one ───────────────

test("⚠️ the loop never sleeps PAST the moment the pace opens", async () => {
  // Without this the feed is the rolled wait PLUS a scan gap. Measured on a
  // simulated day before the rule existed: gaps of 134, 173, 192, 212 and 225
  // min against a 120–180 band — a label that overstates itself by an hour.
  await fresh({ minGapMin: 25, maxGapMin: 90, minListGapMin: 120, maxListGapMin: 180 });
  const h = harness(["So1", "So2"]);
  try {
    await al.runOnce({ now, deps: h.deps, rng: () => 0.5 }); // rolls a 150 min wait
    const st = () => undefined; // pace() re-reads state from disk, as start() does

    // Far from the boundary: the ordinary cadence, untouched.
    const early = al.nextScanDelayMs(al.get(), undefined, now + 10 * MIN, () => 0.5);
    assert.ok(Math.abs(early - 57.5 * MIN) < MIN, `expected the rolled scan gap, got ${early / MIN} min`);

    // Close to it — 10 min of wait left — the scan is pulled FORWARD to just
    // after it opens, with up to 4.5 min of jitter so the listings do not land
    // on a clock of their own either.
    for (const r of [0, 0.5, 1]) {
      const late = al.nextScanDelayMs(al.get(), st(), now + 140 * MIN, () => r);
      assert.ok(late >= 10 * MIN, `it scanned BEFORE the boundary (${late / MIN} min) — the wait is a floor`);
      assert.ok(late <= 14.5 * MIN, `it slept past the boundary by more than the jitter: ${late / MIN} min`);
    }
  } finally {
    h.restore();
  }
});

test("the shortening can only ever make a scan SOONER — the watchdog keeps its resolution", async () => {
  await fresh({ minGapMin: 25, maxGapMin: 90, minListGapMin: 600, maxListGapMin: 600 });
  const h = harness(["So1", "So2"]);
  try {
    await al.runOnce({ now, deps: h.deps });
    for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
      const plain = (25 + r * 65) * MIN;
      const got = al.nextScanDelayMs(al.get(), undefined, now + 5 * MIN, () => r);
      assert.ok(got <= plain + 1, `a 10h wait made the scan LATER (${got / MIN} vs ${plain / MIN} min)`);
    }
    // …and with the pace off it is exactly the old cadence.
    await al.set({ paceListings: false });
    assert.strictEqual(al.nextScanDelayMs(al.get(), undefined, now, () => 0), 25 * MIN);
    assert.strictEqual(al.nextScanDelayMs(al.get(), undefined, now, () => 1), 90 * MIN);
  } finally {
    h.restore();
  }
});

test("a wait with seconds left still schedules a real sleep, never a spin", async () => {
  // The shortened delay is waitMs plus the jitter, so the smallest it can be is
  // the jitter's own floor. Asserted against a wait of ONE SECOND — the case
  // that reaches it — rather than a zero band, where the base 5-min scan gap
  // makes the assertion true no matter what the branch does.
  await fresh({ minGapMin: 5, maxGapMin: 5, minListGapMin: 60, maxListGapMin: 60 });
  const h = harness(["So1", "So2"]);
  try {
    await al.runOnce({ now, deps: h.deps });
    const t = now + 60 * MIN - 1000; // one second of wait left
    for (const r of [0, 0.5, 1]) {
      const ms = al.nextScanDelayMs(al.get(), undefined, t, () => r);
      assert.ok(ms >= 30_000, `a one-second wait scheduled a ${ms}ms sleep`);
      assert.ok(ms >= 1000, "…and never before the boundary");
    }
  } finally {
    h.restore();
  }
});

test("START ITSELF honours the pace — not just the helper it calls", async () => {
  // The three tests above call nextScanDelayMs directly, and `start()` is its
  // only production caller. A start() that went back to rolling its own gap
  // would leave all three green — the repo's own rule that a guard is honest
  // only while it measures the stack that actually runs.
  //
  // ⚠️ On the REAL clock, deliberately: `start()` and `runOnce`'s default both
  // read Date.now(), and this suite's synthetic `now` is years ahead — under it
  // every stored stamp reads as skewed and the pace never engages at all, so
  // the test would pass over a start() that ignored it.
  const t0 = Date.now();
  await fresh({ minGapMin: 60, maxGapMin: 60, minListGapMin: 10, maxListGapMin: 10 });
  const h = harness(["So1", "So2"], { info: () => ({ ...healthy(), pairCreatedAt: t0 - 48 * HOUR }) });
  const realSetTimeout = global.setTimeout;
  try {
    assert.strictEqual(await al.runOnce({ now: t0, deps: h.deps }), 1, "the clock has to start");
    const delays = [];
    let boot = null;
    global.setTimeout = (fn, ms) => {
      delays.push(ms);
      if (!boot) boot = fn;
      return { unref() {} };
    };
    const svc = al.start(null, { rng: () => 0.5 });
    await boot(); // the first scan runs, finds the pace closed, and reschedules
    svc.stop();
    const scheduled = delays[delays.length - 1]; // schedule() is the last thing run() does
    // The cadence alone would be 60 min. The wait has ~10 left, so the loop must
    // wake for it instead — the whole point of the shortening.
    assert.ok(scheduled < 20 * MIN, `start() ignored the pace and slept ${(scheduled / MIN).toFixed(1)} min`);
    assert.ok(scheduled > 5 * MIN, `start() woke before the boundary: ${(scheduled / MIN).toFixed(1)} min`);
  } finally {
    global.setTimeout = realSetTimeout;
    h.restore();
  }
});

test("a positive wait under half a minute is not reported as NONE", () => {
  // fmtGap rounds, and the paced scan line's whole job is answering "why has
  // nothing been listed" — stating a wait of zero on the scan the wait held
  // back is the printed-0.00% shape one surface over.
  assert.strictEqual(al.fmtGap(20 / 60), "under a minute");
  assert.strictEqual(al.fmtGap(29 / 60), "under a minute");
  assert.strictEqual(al.fmtGap(0), "0 min", "a configured zero is a real setting and still reads as one");
  // …and it must never be spelled with a bare "<": these strings reach a
  // parse_mode HTML message, where one makes Telegram reject the whole thing.
  assert.ok(!al.fmtGap(20 / 60).includes("<"));
});

test("the scan line never says the wait is over on a scan the wait stopped", async () => {
  await fresh({ minListGapMin: 120, maxListGapMin: 120 });
  const h = harness(["So1", "So2"]);
  try {
    await al.runOnce({ now, deps: h.deps });
    await al.runOnce({ now: now + 120 * MIN - 20_000, deps: h.deps }); // 20s left
    const line = al.scanLine(al.lastScan());
    assert.match(line, /due in under a minute/);
    assert.ok(!/due in 0 min/.test(line), `it reported a wait of none: ${line}`);
  } finally {
    h.restore();
  }
});
