// The ⏳ pace controls on the Auto Listing panel, driven through REAL Telegraf
// updates.
//
// The reason this is a separate file from autoListerPace.test.js: a service
// test proves the engine paces, and says nothing about whether an operator can
// reach the setting. `alchKb()` once shipped with `cb` undefined — the module
// required cleanly, every service test was green, and each tap answered and
// then threw inside bot.catch, i.e. a button that visibly did nothing, live.
// Only DISPATCHING the tap fails on that revision.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dexvra-alpacepanel-"));
process.env.ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || "123456:TEST_ALPACE_PANEL";

const test = require("node:test");
const assert = require("node:assert");

const { Telegram } = require("telegraf");
const adminBot = require("../src/admin/adminBot");
const autoLister = require("../src/services/autoLister");
const { ADMIN_IDS } = require("../src/config/constants");

const ADMIN = { id: Number(ADMIN_IDS[0]), is_bot: false, first_name: "Owner", username: "owner" };
const CHAT = { id: 4242, type: "private" };
const REAL_CALL_API = Telegram.prototype.callApi;

/**
 * Stub the discovery module for a test that drives the REAL registered handler
 * (which takes no `deps`).
 *
 * ⚠️ THE `X` SEAMS ARE THE ONES THE SCAN CALLS. `fetchDiscovery` /
 * `fetchTokenInfo` are back-compat wrappers now — patching those alone leaves
 * the handler talking to the real DexScreener, which is a test that passes or
 * fails on somebody's network rather than on the code. Both are replaced here
 * so a caller of either sees the stub, and the X pair is what actually matters.
 */
function stubSeams({ candidates, info } = {}) {
  const ds = require("../src/discovery");
  const real = {
    d: ds.fetchDiscovery,
    dx: ds.fetchDiscoveryX,
    i: ds.fetchTokenInfo,
    ix: ds.fetchTokenInfoX,
  };
  const rows = candidates || [
    { chain: "solana", address: "So1a" },
    { chain: "solana", address: "So1b" },
  ];
  const rec = info || {
    name: "Tok",
    symbol: "TOK",
    mcap: 1.5e6,
    liq: 120_000,
    vol24: 300_000,
    priceUsd: 1,
    pairCreatedAt: Date.now() - 48 * 3600_000,
  };
  ds.fetchDiscovery = async () => rows;
  ds.fetchDiscoveryX = async () => ({ items: rows, ok: true, why: null, sources: [] });
  ds.fetchTokenInfo = async () => rec;
  ds.fetchTokenInfoX = async () => ({ info: rec, ok: true, why: null });
  return () => {
    ds.fetchDiscovery = real.d;
    ds.fetchDiscoveryX = real.dx;
    ds.fetchTokenInfo = real.i;
    ds.fetchTokenInfoX = real.ix;
  };
}

function harness() {
  const bot = adminBot.build();
  bot.botInfo = { id: 777, is_bot: true, first_name: "Dexvra Admin", username: "dexvraadminbot" };
  // A handler that throws must FAIL the test — swallowing it is exactly how the
  // live `cb undefined` bug looked healthy from every angle but the operator's.
  let thrown = null;
  bot.catch((e) => {
    thrown = e;
  });
  const calls = [];
  let mid = 100;
  Telegram.prototype.callApi = async function (method, payload) {
    calls.push({ method, payload });
    if (method === "sendMessage") return { message_id: ++mid, date: 0, chat: CHAT, text: payload && payload.text };
    return true;
  };
  let uid = 0;
  const tap = async (data) => {
    await bot.handleUpdate({
      update_id: ++uid,
      callback_query: {
        id: String(++uid),
        from: ADMIN,
        chat_instance: "1",
        data,
        message: { message_id: ++mid, date: 0, chat: CHAT, from: ADMIN, text: "panel" },
      },
    });
    if (thrown) throw thrown;
  };
  const edits = () => calls.filter((c) => c.method === "editMessageText");
  const answers = () => calls.filter((c) => c.method === "answerCallbackQuery");
  const lastText = () => {
    const e = edits();
    return e.length ? e[e.length - 1].payload.text : "";
  };
  const buttons = () => {
    const e = edits();
    return e.length ? e[e.length - 1].payload.reply_markup.inline_keyboard.flat() : [];
  };
  return { tap, edits, answers, lastText, buttons, calls };
}

const restore = () => {
  Telegram.prototype.callApi = REAL_CALL_API;
};

test("the panel states the pace, and drops the per-scan number it makes impossible", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.resetState();
  await autoLister.set({ maxPerRun: 3, maxPerDay: 12 });
  const h = harness();
  await h.tap("al");
  const txt = h.lastText();
  assert.match(txt, /Listing pace: 🟢 one free listing every 2h–3h/);
  // The arithmetic, out loud: "1 every 2h–3h" and "12/day" govern one feed and
  // it is not obvious which binds. The 🧲 "max 3/chain" label was misread for
  // exactly this reason.
  assert.match(txt, /a day/, "the panel must reconcile the pace against the daily cap itself");
  assert.ok(!/<b>3<\/b>\/scan/.test(txt), "a paced scan lists at most one — the panel must not offer 3");
  assert.match(txt, /🔢 Max <b>12<\/b>\/day/, "the daily cap still applies and is still shown");
});

test("the pace band is reachable and every tap ANSWERS and re-renders", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.resetState();
  const h = harness();
  await h.tap("al");
  const labels = h.buttons().map((b) => b.text);
  assert.ok(
    labels.some((l) => /Pace: 1 every 2h–3h/.test(l)),
    `no pace toggle on the panel: ${labels.join(" | ")}`,
  );
  assert.ok(labels.some((l) => /Every 2h/.test(l)) && labels.some((l) => /to 3h/.test(l)), "no band rows");

  const before = h.edits().length;
  await h.tap("alpmin:30");
  assert.strictEqual(autoLister.get().minListGapMin, 150);
  assert.ok(h.edits().length > before, "a tap must EDIT the panel, not only answer");
  assert.ok(h.answers().length >= 2, "…and it must answer, or the button spins");
  assert.match(h.answers().pop().payload.text, /2h30m–3h/, "the whole BAND is reported, not just the end tapped");

  await h.tap("alpmax:-120");
  const c = autoLister.get();
  // Dropping the ceiling under the floor moves the ceiling to the floor. An
  // answer naming one number while the other moved is the ✅-carrying-a-number-
  // nobody-asked-for defect the gainers settings paid for.
  assert.strictEqual(c.maxListGapMin, 150);
  // …and the note names the right REFUSAL: 1h is well inside the rails, it is
  // the 2h30m floor that pins it. Pointing at the limits would send the
  // operator to change the wrong setting.
  const said = h.answers().pop().payload.text;
  assert.match(said, /one every 2h30m/);
  assert.match(said, /ceiling under the 2h30m floor/);
  assert.ok(!/outside the limits/.test(said), "1h is not outside the limits — that is a different refusal");
});

test("the band cannot be pushed outside its rails, and a refused value SAYS so", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.resetState();
  const h = harness();
  await h.tap("al");
  for (let i = 0; i < 6; i++) await h.tap("alpmin:-30"); // 120 → below zero
  assert.strictEqual(autoLister.get().minListGapMin, 0, "0 is the floor, and it is legal");
  const last = h.answers().pop().payload.text;
  assert.match(last, /a negative wait is outside the limits/, "a clamped value is not answered as if it were stored");
});

test("turning the pace OFF is a show_alert that says what the feed will do", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.resetState();
  await autoLister.set({ maxPerRun: 3, maxPerDay: 12 });
  const h = harness();
  await h.tap("al");
  await h.tap("alpace");
  assert.strictEqual(autoLister.get().paceListings, false);
  const a = h.answers().pop().payload;
  assert.strictEqual(a.show_alert, true, "it changes what the PUBLIC feed does — a toast is furniture");
  assert.match(a.text, /3 listings can go out in one scan/);
  assert.match(a.text, /12\/day/, "…and names what is left holding it back");

  const txt = h.lastText();
  assert.match(txt, /Listing pace: 🔴 OFF/);
  assert.match(txt, /<b>3<\/b>\/scan/, "with the pace off the burst size is back on screen");
  // The band rows are hidden: a setting that governs nothing is one an operator
  // can change and never see act.
  assert.ok(!h.buttons().some((b) => /Every 2h/.test(b.text)), "the band rows must be hidden while it is off");

  await h.tap("alpace");
  assert.strictEqual(autoLister.get().paceListings, true);
  assert.notStrictEqual(h.answers().pop().payload.show_alert, true, "turning it ON needs no alert");
});

test("no bare '<' can reach Telegram — one would make it reject the whole panel", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.resetState();
  const h = harness();
  // The states whose copy is generated rather than fixed: no floor, a wait
  // longer than a day, a daily cap the pace cannot reach, and the pace off.
  const cases = [
    { minListGapMin: 0, maxListGapMin: 180 },
    { minListGapMin: 1440, maxListGapMin: 4320 },
    { minListGapMin: 30, maxListGapMin: 30, maxPerDay: 2 },
    { paceListings: false },
  ];
  for (const cfg of cases) {
    await autoLister.set(cfg);
    await h.tap("al");
    const bare = h.lastText().replace(/<\/?(?:b|i|u|s|a|code|pre)(?:\s[^>]*)?>/g, "");
    assert.ok(!bare.includes("<"), `a literal "<" survives for ${JSON.stringify(cfg)}: ${bare.slice(0, 300)}`);
  }
});

// ── The copy that is COMPUTED, state by state ──────────────────────────────
//
// Every branch below produced a sentence that was wrong before it was found by
// an audit, and each was wrong in this repo's recurring way: a claim the reader
// has no reason to doubt.

test("a band slower than a day does not report a rate of ZERO", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.resetState();
  const h = harness();
  for (const cfg of [
    { minListGapMin: 2880, maxListGapMin: 4320 },
    { minListGapMin: 10080, maxListGapMin: 10080 },
    { minListGapMin: 1441, maxListGapMin: 1441 },
  ]) {
    await autoLister.set(cfg);
    await h.tap("al");
    const txt = h.lastText();
    // "≈ up to 0 a day" for a feed that lists every other day is the printed
    // 0.00% this repo refuses on the trending board, one screen over.
    assert.ok(!/\b0<\/b> a day/.test(txt) && !/up to <b>0<\/b>/.test(txt), `a rate of zero: ${txt.match(/⏳.*\n.*/)}`);
    assert.match(txt, /slower than <b>one a day<\/b>/);
    assert.match(txt, /cap never binds/, "…and the day cap cannot be what stops a feed slower than it");
  }
});

test("a floor of zero does not claim the daily cap is the ONLY bound", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.resetState();
  await autoLister.set({ minListGapMin: 0, maxListGapMin: 240, minGapMin: 25, maxGapMin: 90 });
  const h = harness();
  await h.tap("al");
  const txt = h.lastText();
  assert.ok(!/only bound/.test(txt), "pacing still forces one per scan — the cap is not the only bound");
  assert.match(txt, /one per scan/);
  assert.match(txt, /25–90 min apart/, "…and the scan cadence is the other half of that bound");
});

test("a PINNED band is not described as 'never a fixed heartbeat' — it is exactly one", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.resetState();
  const h = harness();
  await h.tap("al");
  assert.match(h.lastText(), /never a fixed heartbeat/, "a real band is rolled");

  // Two ➕ taps from the shipped default.
  await autoLister.set({ minListGapMin: 180, maxListGapMin: 180 });
  await h.tap("al");
  const txt = h.lastText();
  assert.ok(!/never a fixed heartbeat/.test(txt), "a pinned band IS a fixed heartbeat — paceGapMs returns the floor");
  assert.match(txt, /a fixed wait/);
});

test("the ready line is DROPPED where a gate above the pace holds the scan", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.resetState();
  const h = harness();

  // runOnce checks `enabled` and the daily cap BEFORE it ever reaches the pace,
  // so pace().due says nothing about either. "the next scan may list one" under
  // 🔴 OFF is a ready line contradicting the screen it is on — the auto-raid
  // panel had to learn to drop its ready line rather than reword it.
  await autoLister.set({ enabled: false });
  await h.tap("al");
  assert.match(h.lastText(), /held<\/b> — the service is 🔴 OFF/);
  assert.ok(!/the next scan may list one/.test(h.lastText()));

  await autoLister.set({ enabled: true, maxPerDay: 1 });
  await autoLister.rememberListed([]); // no-op; the count comes from state.day
  const fss2 = require("node:fs");
  const path2 = require("node:path");
  const f = path2.join(process.env.BOT_DATA_DIR, "autoListerState.json");
  const st = JSON.parse(fss2.readFileSync(f, "utf8"));
  st.day = { key: new Date().toISOString().slice(0, 10), n: 1 };
  fss2.writeFileSync(f, JSON.stringify(st));
  await h.tap("al");
  assert.match(h.lastText(), /held<\/b> — today's <b>1\/1<\/b> cap is reached/);
});

test("'nothing listed yet' is a claim about the CLOCK, and every install upgrades without one", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.resetState();
  // Enabled, or the 🔴 OFF branch above wins and this branch is never rendered.
  await autoLister.set({ enabled: true });
  // The state an existing server has on deploy day: a history of listings, and
  // no pace clock — the field is new. Saying "nothing listed yet" over its own
  // "Listed so far: 2" is a panel disagreeing with itself.
  const fss2 = require("node:fs");
  const path2 = require("node:path");
  const f = path2.join(process.env.BOT_DATA_DIR, "autoListerState.json");
  fss2.writeFileSync(
    f,
    JSON.stringify({
      listed: { "solana:a": { at: 1, sym: "AAA" }, "solana:b": { at: 2, sym: "BBB" } },
      everListed: { "solana:a": 1, "solana:b": 2 },
      // ⚠️ A FRESH SCAN REPORT, because the clock line only exists over a loop
      // the panel believes is alive. Without one, the ready line is DROPPED for
      // "the scanner has not reported" — correct, and a different sentence from
      // the one this test is about. Stated rather than inherited.
      scan: { at: Date.now(), candidates: 3, priced: 3, listed: 0, known: 0, cooled: 0, offChain: 0, unsupported: 0, reasons: {}, refused: 0, refusals: {}, unpriced: 0, unpricedWhy: {}, capped: null, paced: null, blocker: null },
    }),
  );
  const h = harness();
  await h.tap("al");
  const txt = h.lastText();
  assert.match(txt, /Listed so far: <b>2<\/b>/);
  assert.ok(!/nothing listed yet/.test(txt), "it contradicted its own 'Listed so far' two lines down");
  assert.match(txt, /no listing on the clock yet/);
});

test("🔎 Test scan does not contradict the pace line four lines above it", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.resetState();
  await autoLister.set({ enabled: true, minMcap: 1e6, maxMcap: 1.5e6, minListGapMin: 150, maxListGapMin: 150 });

  const api = require("../src/api/dexvra");
  const real = { g: api.getListings, c: api.canCreate };
  t.after(() => {
    api.getListings = real.g;
    api.canCreate = real.c;
    restoreSeams();
  });
  // ⚠️ The WRITE PROBE too — 🔎 Test scan asks `api.canCreate()` now.
  api.canCreate = async () => ({ ok: true, status: 400, why: null });
  const restoreSeams = stubSeams({
    candidates: [
      { chain: "solana", address: "So1a" },
      { chain: "solana", address: "So1b" },
    ],
  });
  api.getListings = async () => [];

  // Put a listing on the clock so the pace is mid-wait.
  const fss2 = require("node:fs");
  const path2 = require("node:path");
  const f = path2.join(process.env.BOT_DATA_DIR, "autoListerState.json");
  const st = JSON.parse(fss2.readFileSync(f, "utf8"));
  st.lastListAt = Date.now() - 30 * 60_000; // 30 min into a 150 min wait
  st.paceRoll = 0;
  // A live loop, for the reason above: the pace line is dropped over one the
  // panel has already worked out is not running.
  st.scan = { at: Date.now(), candidates: 2, priced: 2, listed: 0, known: 0, cooled: 0, offChain: 0, unsupported: 0, reasons: {}, refused: 0, refusals: {}, unpriced: 0, unpricedWhy: {}, capped: null, paced: null, blocker: null };
  fss2.writeFileSync(f, JSON.stringify(st));

  const h = harness();
  await h.tap("alscan");
  const txt = h.lastText();
  assert.match(txt, /next one due <b>in 2h<\/b>/, "the pace line is where it always was");
  // …and the verdict beneath it may not say the opposite.
  assert.ok(!/would be listed right now/.test(txt), `the verdict contradicts the pace line: ${txt.slice(-400)}`);
  assert.match(txt, /but the pace holds the next listing for <b>2h<\/b>/);
  assert.match(txt, /TOK/, "it still reports the MARKET — that is what a test scan is for");
});

test("…and with the pace open the verdict says only the FIRST of them goes", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.resetState();
  await autoLister.set({ enabled: true, minMcap: 1e6, maxMcap: 1.5e6, maxPerRun: 3 });

  const api = require("../src/api/dexvra");
  const real = { g: api.getListings, c: api.canCreate };
  const restoreSeams = stubSeams({
    candidates: [
      { chain: "solana", address: "So1c" },
      { chain: "solana", address: "So1d" },
    ],
  });
  t.after(() => {
    api.getListings = real.g;
    api.canCreate = real.c;
    restoreSeams();
  });
  api.canCreate = async () => ({ ok: true, status: 400, why: null });
  api.getListings = async () => [];

  const h = harness();
  await h.tap("alscan");
  const txt = h.lastText();
  // maxPerRun is 3 and two qualify, but a paced scan lists ONE — a verdict
  // promising two is a number the engine cannot produce.
  assert.ok(!/would be listed right now/.test(txt));
  assert.match(txt, /a real scan would list <b>the first one<\/b>/);
});

// ── The buttons that START and RESET the feed, driven for real ──────────────
//
// ⚠️ ▶️ Enable is the single switch that starts free listings, and until now
// NOTHING drove it: eleven buttons on this panel could be made completely inert
// with the whole suite green. If ▶️ Enable stops persisting — or ↩️ Reset goes
// back to taking `enabled` with the thresholds — the report is "free listing di
// admin bot tidak bekerja, sebelumnya bekerja", which is exactly how this
// feature arrived here.

test("▶️ Enable / ⏸ Disable persist, and the label follows", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.set({ enabled: false });
  const h = harness();

  await h.tap("alen");
  assert.strictEqual(autoLister.get().enabled, true, "▶️ Enable did not persist — free listings never start");
  assert.match(h.lastText(), /Status: <b>🟢 ON<\/b>/);

  await h.tap("alen");
  assert.strictEqual(autoLister.get().enabled, false);
  assert.match(h.lastText(), /Status: <b>🔴 OFF<\/b>/);
});

test("⚠️ ↩️ Reset restores the thresholds and LEAVES THE SERVICE RUNNING", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.set({ enabled: true, minMcap: 7e6, maxPerDay: 3 });
  const h = harness();

  await h.tap("alrst");
  const c = autoLister.get();
  assert.strictEqual(c.enabled, true, "resetting the numbers silently stopped a live public feed");
  assert.strictEqual(c.minMcap, autoLister.DEFAULTS.minMcap, "…while still doing what the button says");
  assert.strictEqual(c.maxPerDay, autoLister.DEFAULTS.maxPerDay);
  assert.match(h.lastText(), /Status: <b>🟢 ON<\/b>/);
});

test("⚠️ a write the config refuses ANSWERS — it does not leave the button spinning", async (t) => {
  t.after(restore);
  await autoLister.reset();
  await autoLister.set({ enabled: false });
  const fss2 = require("node:fs");
  const path2 = require("node:path");
  const f = path2.join(process.env.BOT_DATA_DIR, "autoLister.json");
  const good = fss2.readFileSync(f, "utf8");
  fss2.writeFileSync(f, '{"enabled":false,');
  const h = harness();
  try {
    // `set()` and `reset()` refuse over an unreadable config — the right call,
    // because writing DEFAULTS over it wipes every tuned threshold. But a throw
    // inside a bot.action is swallowed by bot.catch, so the operator taps
    // ▶️ Enable, the button spins, the panel never changes and free listings
    // stay stopped: the guard producing the symptom it was written to end.
    await h.tap("alen");
    const answers = h.calls.filter((c) => c.method === "answerCallbackQuery");
    assert.ok(answers.length, "the tap was never answered");
    assert.match(String(answers[answers.length - 1].payload.text), /cannot read autoLister\.json/);
    assert.strictEqual(answers[answers.length - 1].payload.show_alert, true);
    // …and ↩️ Reset must NOT be the one button that "works" here, by wiping it.
    await h.tap("alrst");
    assert.strictEqual(fss2.readFileSync(f, "utf8"), '{"enabled":false,', "↩️ Reset overwrote a config it could not read");
  } finally {
    fss2.writeFileSync(f, good);
  }
});
