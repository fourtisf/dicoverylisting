// "FREE LISTING DI ADMIN BOT TIDAK BEKERJA, SEBELUMNYA BEKERJA" (2026-08-28).
//
// The panel read 🟢 ON, the scan line read `40 candidates · 40 priced · 0
// listed`, and nothing anywhere said why — because that sentence is what BOTH a
// quiet market and a site refusing every single create look like. A create the
// site turned down was one log.warn and a `continue`: no counter, no reason on
// the panel, `blocker` null, and the blocked-scan watchdog silent. A rotated
// INTERNAL_API_TOKEN, a moved DEXVRA_API_BASE, a payload the validator now
// rejects and a 500 all rendered identically, and identically to nothing being
// wrong at all.
//
// These tests pin the four things that fix it: a refusal is COUNTED, it is
// NAMED, a scan where every create was refused is a BLOCKER, and the symptom
// itself — "switched on and publishing nothing" — is watched rather than left
// for the operator to detect by reading the site.
const path = require("node:path");
const os = require("node:os");
const fss = require("node:fs");
process.env.BOT_DATA_DIR = fss.mkdtempSync(path.join(os.tmpdir(), "dexvra-alblk-"));

const test = require("node:test");
const assert = require("node:assert");

const al = require("../src/services/autoLister");
const watch = require("../src/services/listingWatch");
const api = require("../src/api/dexvra");
const log = require("../src/helpers/logger");

const M = 1_000_000;
const HOUR = 3_600_000;
const now = 1_800_000_000_000;

const healthy = (over = {}) => ({
  name: "Nine Hood",
  symbol: "NINEHOOD",
  mcap: 1.9 * M,
  liq: 120_000,
  vol24: 300_000,
  priceUsd: 0.0012,
  pairCreatedAt: now - 48 * HOUR,
  ...over,
});

function stubApi(t, { listings = [], create } = {}) {
  const real = { createListing: api.createListing, getListings: api.getListings, canCreate: api.canCreate };
  api.getListings = async () => listings;
  api.createListing = create || (async (i) => ({ id: "x", ...i }));
  // ⚠️ The WRITE PROBE too. 🔎 Test scan asks `api.canCreate()` now — it used to
  // exercise only the read path and so reported "2 qualify" over a service whose
  // every create was being refused. A stub that leaves it out talks to the real
  // site, which is a test passing or failing on somebody's network.
  api.canCreate = async () => ({ ok: true, status: 400, why: null });
  t.after(() => Object.assign(api, real));
}

function capture(t) {
  const real = log.alert;
  const seen = [];
  log.alert = (html) => seen.push(String(html));
  t.after(() => (log.alert = real));
  return seen;
}

const reset = async () => {
  await al.reset();
  await al.resetState();
  // paceListings stated OUT LOUD rather than inherited: it ships ON, and a
  // second listing in one scan is what several of these tests need.
  await al.set({ enabled: true, minMcap: 1 * M, maxMcap: 1.5 * M, postChannel: false, paceListings: false });
};

const scanOf = (cands, info = healthy(), at = now) =>
  al.runOnce({ now: at, deps: { fetchDiscovery: async () => cands, fetchTokenInfo: async () => info } });

const THREE = [
  { chain: "solana", address: "Aaa1" },
  { chain: "solana", address: "Bbb2" },
  { chain: "solana", address: "Ccc3" },
];

// ── A refusal is a FACT, not a silence ──────────────────────────────────────

test("a create the site refuses is COUNTED and NAMED on the scan report", async (t) => {
  await reset();
  stubApi(t, {
    create: async () => {
      throw new Error("POST /api/internal/listings → 400: Invalid ticker");
    },
  });
  const n = await scanOf(THREE);

  assert.strictEqual(n, 0);
  const r = al.lastScan();
  assert.strictEqual(r.priced, 3, "all three cleared the gates and were attempted");
  assert.strictEqual(r.refused, 3, "every refusal must be counted");
  // The site's own words, verbatim — that sentence is the difference between a
  // listing payload problem and a credentials problem.
  assert.deepStrictEqual(Object.keys(r.refusals), ["POST /api/internal/listings → 400: Invalid ticker"]);
  assert.deepStrictEqual(r.reasons, {}, "a refusal is NOT a market rejection and must not be filed as one");
});

test("a 2xx that returns no listing is a refusal too — the request worked and the row does not exist", async (t) => {
  await reset();
  stubApi(t, { create: async () => null });
  await scanOf(THREE);
  const r = al.lastScan();
  assert.strictEqual(r.refused, 3);
  assert.match(Object.keys(r.refusals)[0], /returned no listing/);
});

test("⚠️ a scan where EVERY create was refused is a BLOCKER — it is not a quiet market", async (t) => {
  await reset();
  stubApi(t, {
    create: async () => {
      throw new Error("POST /api/internal/listings → 401: unauthorized");
    },
  });
  await scanOf(THREE);
  const r = al.lastScan();
  assert.ok(r.blocker, "an all-refused scan could not do its job and must say so");
  assert.match(r.blocker, /refused all 3 listing/);
  assert.match(r.blocker, /401: unauthorized/, "the blocker carries the site's reason, or it is a shrug");
  // …and the panel line leads with it rather than printing the healthy-looking
  // "3 candidates · 3 priced · 0 listed" this whole test file exists about.
  assert.match(al.scanLine(r), /^⛔/);
});

test("a scan that listed something and refused one token is NOT a blocker — that is a per-token problem", async (t) => {
  await reset();
  let first = true;
  stubApi(t, {
    create: async (i) => {
      if (first) {
        first = false;
        throw new Error("POST /api/internal/listings → 400: X must be a full https:// URL");
      }
      return { id: "x", ...i };
    },
  });
  const n = await scanOf(THREE);
  const r = al.lastScan();
  assert.ok(n >= 1, "the other candidates still listed");
  assert.strictEqual(r.refused, 1);
  assert.strictEqual(r.blocker, null, "paging for one bad token is how a monitor gets muted");
  // …but it is still VISIBLE, which was the whole defect.
  assert.match(al.scanLine(r), /1 refused by the site/);
});

test("three refused scans in a row page the ops channel", async (t) => {
  await reset();
  const alerts = capture(t);
  stubApi(t, {
    create: async () => {
      throw new Error("POST /api/internal/listings → 500: internal error");
    },
  });
  for (let i = 0; i < 3; i++) await scanOf(THREE, healthy(), now + i * HOUR);
  const stuck = alerts.filter((a) => /Auto-Listing has stopped working/.test(a));
  assert.strictEqual(stuck.length, 1, "the existing blocked-scan watchdog must see a refused scan");
  assert.match(stuck[0], /500: internal error/);
});

// ── A candidate on an unresolvable chain is counted, not evaporated ─────────

test("a candidate on a chain the bot cannot resolve is COUNTED, not dropped in silence", async (t) => {
  await reset();
  stubApi(t);
  await scanOf([
    { chain: "nosuchchain", address: "Zz1" },
    { chain: "alsomissing", address: "Yy2" },
  ]);
  const r = al.lastScan();
  assert.strictEqual(r.unsupported, 2);
  assert.strictEqual(r.priced, 0);
  // Without this the panel showed candidates that vanished between "seen" and
  // "priced" — which is what one whole network going invisible looks like.
  assert.match(al.scanLine(r), /2 on an unmappable chain/);
});

// ── One owner for the DexScreener slug ──────────────────────────────────────

test("⚠️ the DexScreener slug has ONE owner — config/chains.js — and discovery reads it", () => {
  const { CHAINS, DEXSCREENER_SLUG } = require("../src/config/chains");
  const { DS_CHAIN } = require("../src/dexscreener");
  // Two maps of the same fact drifted on exactly one chain, and one chain is
  // all it takes: DexScreener spells Sei `seiv2`, so with identity every Sei
  // token answered "no market data" and every Sei feed entry was dropped before
  // it was counted — a whole network invisible to free listings, silently.
  for (const c of Object.keys(CHAINS)) {
    assert.strictEqual(DS_CHAIN[c], DEXSCREENER_SLUG[c] || c, `${c}: dexscreener.js and config/chains.js disagree about the slug`);
  }
  assert.strictEqual(DS_CHAIN.sei, "seiv2", "the chain that proved the rule");
  // Identity is still the fallback, so adding a chain to chains.js keeps making
  // it discoverable without a second edit.
  assert.strictEqual(Object.keys(DS_CHAIN).length, Object.keys(CHAINS).length);
  const slugs = Object.values(DS_CHAIN);
  assert.strictEqual(new Set(slugs).size, slugs.length, "two chains sharing a slug would misattribute a token");
});

// ── The symptom watch ───────────────────────────────────────────────────────

const HOURS = (h) => h * HOUR;
const quiet = (over = {}) => ({
  enabled: true,
  lastListAt: null,
  scan: { at: now, candidates: 40, priced: 12, listed: 0, known: 0, cooled: 0, offChain: 0, unsupported: 0, reasons: { "below its trigger": 12 }, refused: 0, refusals: {}, capped: null, paced: null, blocker: null },
  ...over,
});

test("the watch says nothing while the service is OFF — that is the operator's own decision", () => {
  const { alerts, state } = watch.evaluate(quiet({ enabled: false }), { since: now - HOURS(80) }, { now });
  assert.deepStrictEqual(alerts, []);
  assert.deepStrictEqual(state, {}, "the clock restarts when it is switched back on, or it pages instantly for the hours it was off");
});

test("the watch is quiet inside the grace period — a quiet afternoon is not an incident", () => {
  const { alerts } = watch.evaluate(quiet(), {}, { now, graceMs: HOURS(12) });
  assert.deepStrictEqual(alerts, []);
});

test("⚠️ the first look ANCHORS and does not page for the hours before the watch existed", () => {
  // `lastListAt` is null on every install that upgrades — anchoring on `now` is
  // what stops a deploy-day alert about a feed that was fine.
  const first = watch.evaluate(quiet(), {}, { now, graceMs: HOURS(12) });
  assert.deepStrictEqual(first.alerts, []);
  assert.strictEqual(first.state.since, now);
});

test("past the grace it alerts ONCE, names the cause, and repeats only after the repeat window", () => {
  const opts = { now, graceMs: HOURS(12), repeatMs: HOURS(24) };
  const s0 = { since: now - HOURS(20) };
  const a = watch.evaluate(quiet(), s0, opts);
  assert.strictEqual(a.alerts.length, 1);
  assert.match(a.alerts[0].text, /published nothing for 20h/);
  assert.match(a.alerts[0].text, /below its trigger/, "the alert names WHICH cause, or the reader repeats the investigation");
  // Same state an hour later: no second alert.
  const b = watch.evaluate(quiet(), a.state, { ...opts, now: now + HOURS(1) });
  assert.deepStrictEqual(b.alerts, []);
  // …and it does repeat once the window has passed, or day one's message is
  // scrolled past by day three.
  const c = watch.evaluate(quiet(), a.state, { ...opts, now: now + HOURS(25) });
  assert.strictEqual(c.alerts.length, 1);
});

test("a quiet MARKET is reported as not-a-fault; a refusing SITE is reported as one", () => {
  const opts = { now, graceMs: HOURS(12) };
  const s0 = { since: now - HOURS(20) };
  const market = watch.evaluate(quiet(), s0, opts).alerts[0];
  assert.strictEqual(market.kind, "listing_quiet");
  assert.match(market.text, /running correctly/, "crying fault at a quiet market is how a monitor gets muted");

  const refusing = watch.evaluate(
    quiet({ scan: { ...quiet().scan, reasons: {}, refused: 12, refusals: { "POST /api/internal/listings → 401: unauthorized": 12 } } }),
    s0,
    opts,
  ).alerts[0];
  assert.strictEqual(refusing.kind, "listing_stuck");
  assert.match(refusing.text, /401: unauthorized/);
  assert.match(refusing.text, /INTERNAL_API_TOKEN/);
});

test("a BLOCKED scan is left to the blocked-scan watchdog — one fault, one alert", () => {
  const r = watch.evaluate(
    quiet({ scan: { ...quiet().scan, blocker: "site API unreachable: fetch failed" } }),
    { since: now - HOURS(20) },
    { now, graceMs: HOURS(12) },
  );
  assert.deepStrictEqual(r.alerts, [], "fileReport already paged with the verbatim error");
  assert.strictEqual(r.state.since, now - HOURS(20), "the clock keeps running so the recovery still fires");
});

test("a RECOVERY is an alert too — a fixed feed and a forgotten one look identical otherwise", () => {
  const opts = { now, graceMs: HOURS(12) };
  const complained = { since: now - HOURS(20), alertedAt: now - HOURS(1) };
  const r = watch.evaluate(quiet({ lastListAt: now - 60_000 }), complained, opts);
  assert.strictEqual(r.alerts.length, 1);
  assert.strictEqual(r.alerts[0].kind, "listing_ok");
  assert.deepStrictEqual(r.state, {});
});

test("a feed that healed before anyone was told says nothing at all", () => {
  const r = watch.evaluate(quiet({ lastListAt: now - 60_000 }), { since: now - HOURS(2) }, { now, graceMs: HOURS(12) });
  assert.deepStrictEqual(r.alerts, []);
});

test("every cause the scan can record has its own sentence", () => {
  const base = quiet().scan;
  const cases = [
    [{ ...base, reasons: {}, capped: "12/12" }, /daily cap/],
    [{ ...base, reasons: {}, priced: 0, known: 40 }, /never-relist ledger/],
    [{ ...base, reasons: {}, priced: 0, unsupported: 40 }, /could not resolve/],
    [{ ...base, reasons: {}, priced: 0, offChain: 40 }, /chain scope/],
    [{ ...base, reasons: {}, priced: 0, paced: { waitMs: 1, nextAt: 2, gapMs: 3 } }, /pace clock/],
    [null, /never filed a report/],
  ];
  for (const [scan, re] of cases) assert.match(watch.diagnose(scan).text, re, `no sentence for ${JSON.stringify(scan && Object.keys(scan))}`);
});

// ── …and the watch runs where every scan passes through ─────────────────────

test("the watch is folded into fileReport, so a scan that runs FINE and lists nothing still advances it", async (t) => {
  await reset();
  const alerts = capture(t);
  stubApi(t);
  // A healthy scan in a market that has nothing: no blocker, so the
  // blocked-scan watchdog will never fire however long this lasts. That gap is
  // the entire reason the symptom watch exists — "it ran perfectly and could
  // never have published" was outside every alarm this service had.
  const dull = healthy({ mcap: 40_000 }); // far below any trigger in the band
  await scanOf(THREE, dull, now); // anchors the clock
  await scanOf(THREE, dull, now + HOURS(30)); // past the 12h grace
  const said = alerts.filter((a) => /Auto-Listing has published nothing/.test(a));
  assert.strictEqual(said.length, 1, `the symptom watch never fired: ${JSON.stringify(alerts)}`);
  assert.match(said[0], /below its trigger/, "and it names the cause");
  assert.ok(
    !alerts.some((a) => /has stopped working/.test(a)),
    "a quiet market must never be reported as the service being broken",
  );
});

test("⚠️ an all-refused scan does NOT double-page — it is a blocker, and that watchdog owns it", async (t) => {
  await reset();
  const alerts = capture(t);
  stubApi(t, {
    create: async () => {
      throw new Error("POST /api/internal/listings → 401: unauthorized");
    },
  });
  await scanOf(THREE, healthy(), now);
  await scanOf(THREE, healthy(), now + HOURS(30));
  assert.ok(
    !alerts.some((a) => /Auto-Listing is ON and has published nothing/.test(a)),
    "two alerts for one fault is how a channel stops being read",
  );
  // …and the third consecutive blocked scan is what pages, with the site's own
  // words — the layer that already existed, now reached by a refused create.
  await scanOf(THREE, healthy(), now + HOURS(31));
  assert.ok(alerts.some((a) => /Auto-Listing has stopped working/.test(a) && /401: unauthorized/.test(a)));
});

// ── "We could not ask" is not "this token has no market" ────────────────────

test("⚠️ a pricing source that REFUSED us is not filed as 'no market data'", async (t) => {
  await reset();
  stubApi(t);
  await al.runOnce({
    now,
    deps: {
      fetchDiscovery: async () => THREE,
      // The X seam is the one the scan reads, and it is the only one that can
      // say "we could not ask".
      fetchTokenInfoX: async () => ({ info: null, ok: false, why: "DexScreener HTTP 429" }),
    },
  });
  const r = al.lastScan();
  assert.strictEqual(r.unpriced, 3);
  assert.deepStrictEqual(r.reasons, {}, "a refusal is not a verdict about the token");
  assert.match(Object.keys(r.unpricedWhy)[0], /429/);
  // …and every candidate unpriceable is the scan unable to do its job at all.
  assert.ok(r.blocker, "a scan that could price nothing is blocked, not quiet");
  assert.match(r.blocker, /could not price a single one of 3/);
});

test("⚠️ …and it writes NO cool entry — a refusal must not bench a token for 12 hours", async (t) => {
  await reset();
  stubApi(t);
  const priced = [];
  const deps = {
    fetchDiscovery: async () => THREE,
    fetchTokenInfoX: async (c, a) => {
      priced.push(a);
      return { info: null, ok: false, why: "DexScreener HTTP 403" };
    },
  };
  await al.runOnce({ now, deps });
  // The very next scan must look at the same tokens again. Under the old
  // behaviour `coolUntil` gave "no market data" a 12h bench, so an outage of
  // one minute cost half a day of candidates.
  priced.length = 0;
  await al.runOnce({ now: now + 60_000, deps });
  assert.strictEqual(priced.length, 3, "the tokens were benched by a failure that was never about them");
});

test("a source that ANSWERED with no record still means 'no market data' — the other half of the same line", async (t) => {
  await reset();
  stubApi(t);
  // The legacy dep shape asserts "it answered": null means no market.
  await al.runOnce({ now, deps: { fetchDiscovery: async () => THREE, fetchTokenInfo: async () => null } });
  const r = al.lastScan();
  assert.strictEqual(r.unpriced, 0);
  assert.strictEqual(r.reasons["no market data"], 3);
  assert.strictEqual(r.blocker, null, "a market with nothing in it is not a blocked scan");
});

test("the discovery blocker NAMES each source's own reason, instead of asserting 'every source empty'", async (t) => {
  await reset();
  stubApi(t);
  await al.runOnce({
    now,
    deps: {
      fetchDiscoveryX: async () => ({
        items: [],
        ok: false,
        why: "x",
        sources: [
          { name: "dexscreener", n: 0, ok: false, why: "token-boosts/top/v1: HTTP 403" },
          { name: "poolstrade", n: 0, ok: true, why: null },
        ],
      }),
    },
  });
  const b = al.lastScan().blocker;
  assert.match(b, /some sources/);
  assert.match(b, /dexscreener: token-boosts\/top\/v1: HTTP 403/);
  assert.ok(!/every source empty/.test(b), "that sentence sent the operator to look for a quiet market");
});

// ── ↩️ Reset resets the thresholds, not the switch ──────────────────────────

test("⚠️ ↩️ Reset puts the thresholds back and LEAVES THE SERVICE RUNNING", async (t) => {
  await reset();
  await al.set({ enabled: true, minMcap: 5 * M });
  const c = await al.reset();
  assert.strictEqual(c.enabled, true, "resetting the numbers silently stopped a live public feed");
  assert.strictEqual(c.minMcap, al.DEFAULTS.minMcap, "…while still doing what the button says");
  // And it does not switch a stopped service ON either — it carries the switch,
  // it does not choose for the operator.
  await al.set({ enabled: false });
  assert.strictEqual((await al.reset()).enabled, false);
});

test("⚠️ a scan skipped because the service is OFF still FILES a report", async (t) => {
  await reset();
  stubApi(t);
  await al.set({ enabled: false });
  await al.runOnce({ now, deps: { fetchDiscovery: async () => THREE } });
  const r = al.lastScan();
  assert.ok(r, "no report is what made the panel accuse the loop of having died");
  assert.strictEqual(r.off, true);
  assert.match(al.scanLine(r), /switched OFF/);
  // A stale report is meant to mean the LOOP stopped. It can only mean that if
  // every other reason files one.
  assert.strictEqual(r.at, now);
});

// ── An optional social may not cost the whole listing ───────────────────────

test("⚠️ a social the site would 400 on is DROPPED, not sent — the listing is worth more than the link", () => {
  const inp = (over) => al.listingInput("solana", "Abc", { symbol: "TOK", name: "Tok", mcap: 1, ...over });
  // A launchpad publishes bare handles and scheme-less hosts; adminValidate
  // refuses the ENTIRE row over one of them.
  assert.strictEqual(inp({ twitter: "@bare_handle" }).twitter, undefined);
  assert.strictEqual(inp({ website: "TBA" }).website, undefined);
  // …and anything it can vouch for still travels, scheme added where it is
  // unambiguous.
  assert.strictEqual(inp({ telegram: "t.me/foo" }).telegram, "https://t.me/foo");
  assert.strictEqual(inp({ twitter: "https://x.com/a" }).twitter, "https://x.com/a");
  // The site's own rule, so this cannot drift looser than the validator.
  const URL_RE = /^https?:\/\/[^\s]+$/i;
  for (const v of ["@a", "TBA", "n/a", "", "https://a.io/x y"]) {
    const out = inp({ website: v }).website;
    assert.ok(out === undefined || URL_RE.test(out), `${v} → ${out} would 400 the whole listing`);
  }
});

// ── A refusal is memoed only when it is about the ROW ───────────────────────

test("⚠️ a 400 memoes the token — the same payload will be refused for ever otherwise", async (t) => {
  await reset();
  const priced = [];
  stubApi(t, {
    create: async () => {
      throw new Error("POST /api/internal/listings → 400: Invalid ticker");
    },
  });
  const deps = {
    fetchDiscovery: async () => THREE,
    fetchTokenInfo: async (c, a) => (priced.push(a), healthy()),
  };
  await scanOf(THREE);
  await al.runOnce({ now, deps });
  priced.length = 0;
  await al.runOnce({ now: now + 60_000, deps });
  assert.strictEqual(priced.length, 0, "a validator refusal will not change on the next scan; re-pricing it burns the budget");
  assert.strictEqual(al.lastScan().cooled, 3);
});

test("⚠️ …but a 401 does NOT — that is the site refusing this bot, not this token", async (t) => {
  await reset();
  const priced = [];
  stubApi(t, {
    create: async () => {
      throw new Error("POST /api/internal/listings → 401: unauthorized");
    },
  });
  const deps = {
    fetchDiscovery: async () => THREE,
    fetchTokenInfo: async (c, a) => (priced.push(a), healthy()),
  };
  await al.runOnce({ now, deps });
  priced.length = 0;
  await al.runOnce({ now: now + 60_000, deps });
  // Memoing it would bench the whole candidate list over a credentials problem
  // and leave the feed dead long after the token was fine.
  assert.strictEqual(priced.length, 3);
});

// ── The permanent ledger records what was LISTED ────────────────────────────

test("⚠️ a PENDING public submission does not lock a token out of free listing for ever", async (t) => {
  await reset();
  stubApi(t, {
    listings: [
      { chain: "solana", address: "Aaa1", status: "pending" }, // anyone can create this
      { chain: "solana", address: "Bbb2", status: "rejected" }, // an admin refused it
      { chain: "solana", address: "Ccc3", status: "approved" }, // this one was really listed
    ],
  });
  await scanOf(THREE);
  assert.strictEqual(al.wasEverListed("solana", "Ccc3"), true, "an approved row is what the ledger is for");
  assert.strictEqual(al.wasEverListed("solana", "Aaa1"), false, "a stranger typing a contract into the public form must not lock it out");
  assert.strictEqual(al.wasEverListed("solana", "Bbb2"), false, "…nor an admin rejecting a submission");
  // …and all three are still skipped THIS cycle, which is a different rule.
  assert.strictEqual(al.lastScan().known, 3);
});

// ── 🔎 Test scan measures the stack the SCAN uses ───────────────────────────

test("⚠️ Test scan says the site will not take a listing, instead of promising one would go out", async (t) => {
  await reset();
  stubApi(t);
  const r = await al.dryRun({
    now,
    deps: {
      fetchDiscovery: async () => THREE,
      fetchTokenInfo: async () => healthy(),
      canCreate: async () => ({ ok: false, status: 401, why: "the site refuses this bot's credentials (401)" }),
    },
  });
  // Before this, the one button whose job is answering "why has nothing been
  // listed?" reported "2 qualify — a real scan would list the first one" over a
  // service that could not publish at all. A guard is only honest while it
  // measures the stack the runner uses.
  assert.ok(r.blocker, "the read path answering is not the same question as the write path working");
  assert.match(r.blocker, /will not take a listing/);
  assert.match(r.blocker, /401/);
});

test("…and a healthy write path leaves the market verdicts exactly as they were", async (t) => {
  await reset();
  stubApi(t);
  const r = await al.dryRun({
    now,
    deps: {
      fetchDiscovery: async () => THREE,
      fetchTokenInfo: async () => healthy(),
      canCreate: async () => ({ ok: true, status: 400, why: null }),
    },
  });
  assert.strictEqual(r.blocker, null);
  assert.strictEqual(r.priced, 3);
  assert.ok((r.qualified || []).length >= 1, "the probe must not change what the market says");
});

// ── The audit round: the guards must not become the next silent failure ─────

test("⚠️ an unreadable CONFIG halts the scan — it does not read as 'switched OFF'", async (t) => {
  await reset();
  stubApi(t);
  const f = path.join(process.env.BOT_DATA_DIR, "autoLister.json");
  fss.writeFileSync(f, '{"enabled":true,"minMcap":');
  const n = await scanOf(THREE);
  assert.strictEqual(n, 0);
  const h = al.lastHalt();
  assert.ok(h, "an unreadable config took the OFF branch, and the panel then told the operator to tap ▶️ Enable");
  assert.match(h.why, /cannot read autoLister\.json/);
  // …and ▶️ Enable would have written the DEFAULTS over the file we could not
  // read — one bad read laundered into a permanent settings wipe.
  await assert.rejects(() => al.set({ enabled: true }), /Refusing to overwrite/);
  fss.writeFileSync(f, JSON.stringify({ enabled: true }));
});

test("⚠️ rememberListed refuses to write over an unreadable state file — from ANY caller", async (t) => {
  await reset();
  const f = path.join(process.env.BOT_DATA_DIR, "autoListerState.json");
  const good = fss.readFileSync(f, "utf8");
  fss.writeFileSync(f, '{"everListed":{"solana:paid":1}');
  // fulfillment.js calls this the moment a PAID listing goes live, outside any
  // scan. Writing here would re-open every contract the site has ever held.
  const added = await al.rememberListed([{ chain: "solana", address: "New1" }]);
  assert.strictEqual(added, 0);
  assert.strictEqual(fss.readFileSync(f, "utf8"), '{"everListed":{"solana:paid":1}', "the corrupt file was overwritten");
  fss.writeFileSync(f, good);
});

test("⚠️ 🧹 Clear history is NOT undone by a scan that started before it", async (t) => {
  await reset();
  let release;
  const gate = new Promise((r) => (release = r));
  stubApi(t, { listings: [{ chain: "solana", address: "Old1", status: "approved" }] });
  // ⚠️ SYNCHRONISED ON THE SCAN, NOT ON A TICK. This used to wait one
  // setImmediate and assume the scan had got as far as its first lookup — and
  // therefore past the point where it takes its ledger snapshot. That is a race:
  // under load (a busy `node --test`, which runs files in parallel) the scan is
  // still in discovery or the site read, resetState lands BEFORE the snapshot,
  // and the assertion inverts. Green on a quiet machine, red on a full suite —
  // which is exactly what it did. The stub signals when it is genuinely
  // mid-flight.
  let reached;
  const midFlight = new Promise((r) => (reached = r));
  // A scan whose ledger snapshot is taken, and which then stalls mid-flight —
  // the real window is up to forty serial lookups, minutes wide when
  // DexScreener is slow, which is exactly when an operator taps Clear history.
  const scan = al.runOnce({
    now,
    deps: {
      fetchDiscovery: async () => THREE,
      fetchTokenInfo: async () => {
        reached();
        await gate;
        return healthy();
      },
    },
  });
  await midFlight;
  await al.resetState(now + 1000); // the operator taps 🧹 Clear history
  release();
  await scan;
  assert.strictEqual(al.wasEverListed("solana", "Old1"), false, "the scan's stale snapshot restored what the operator just deleted");
});

test("…and an ordinary scan still merges a ledger entry another writer added mid-scan", async (t) => {
  await reset();
  let release;
  const gate = new Promise((r) => (release = r));
  stubApi(t);
  // Same handshake as the test above, and for the same reason: one setImmediate
  // is not a signal that the scan has reached its first lookup.
  let reached;
  const midFlight = new Promise((r) => (reached = r));
  const scan = al.runOnce({
    now,
    deps: {
      fetchDiscovery: async () => THREE,
      fetchTokenInfo: async () => {
        reached();
        await gate;
        return healthy({ mcap: 100 }); // rejected, so the scan writes only its report
      },
    },
  });
  await midFlight;
  // fulfillment.js: a PAID listing went live while the scan was running.
  await al.rememberListed([{ chain: "solana", address: "Paid1" }], now + 500);
  release();
  await scan;
  assert.strictEqual(al.wasEverListed("solana", "Paid1"), true, "the scan's snapshot dropped a paid listing's ledger entry");
});

test("⚠️ 🧹 Clear history keeps the scan report — it is an observation about the LOOP", async (t) => {
  await reset();
  stubApi(t);
  await scanOf(THREE, healthy({ mcap: 100 }));
  assert.ok(al.lastScan(), "setup");
  await al.resetState(now + 1000);
  // Wiping it made alScanLine print "the scanner has never reported … it is NOT
  // running" over a loop running perfectly, from the operator's own tap.
  assert.ok(al.lastScan(), "the panel now accuses a healthy loop of being dead");
  assert.strictEqual(al.stats().everListed, 0, "…while still clearing what it is for");
});

test("⚠️ a halt is readable from ANOTHER PROCESS — the panel and the check are not the loop", async (t) => {
  await reset();
  stubApi(t);
  const f = path.join(process.env.BOT_DATA_DIR, "autoLister.json");
  const good = fss.readFileSync(f, "utf8");
  fss.writeFileSync(f, '{"enabled":true,');
  await scanOf(THREE);
  // The loop runs in dexvra-bot, the panel in dexvra-adminbot, and
  // `listing:check` is a third process — so an in-memory halt is invisible to
  // both, and they would go on diagnosing "the loop is not running" about a
  // loop running perfectly. It lives in its own small file, which is safe to
  // write even when the state file is not.
  const onDisk = JSON.parse(fss.readFileSync(path.join(process.env.BOT_DATA_DIR, "autoListerHealth.json"), "utf8"));
  assert.match(onDisk.why, /cannot read autoLister\.json/);
  assert.deepStrictEqual(al.lastHalt(), onDisk);

  // …and the first scan that gets far enough to file a report clears it, or a
  // stale halt is the stale scan report pointing the other way.
  fss.writeFileSync(f, good);
  const alerts = capture(t);
  await scanOf(THREE, healthy({ mcap: 100 }));
  assert.strictEqual(al.lastHalt(), null);
  assert.ok(alerts.some((a) => /scanning again/.test(a)), "a recovery is an alert too");
});
