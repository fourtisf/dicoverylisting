// A PASTED CONTRACT ADDRESS MUST BE ANSWERED.
//
// Reported 2026-09-12 with a screenshot: a Mass DM buyer pasted
// 0x92e4b008161ac64a7d0c5e540f453f8e6b8bd8d7, the bot replied "🔍 Detecting
// your token's chain…" and then said nothing at all — for minutes, on a box
// whose four processes were all online.
//
// Nothing had crashed. resolveToken is SERIAL and an 0x… address has FIVE
// candidate chains, so it is up to five gt.fetchPool calls — each queued on
// gtSlot(PRIO_BACKGROUND), which has NO DEADLINE OF ITS OWN — and then up to
// five chainPools log sweeps behind them. That is the LISTING FORM's defect
// ("bot tidak merespon untuk paket listing setelah di minta drop ca"), in the
// two flows that never got its fix.
//
// ⚠️ THE DEADLINE IS ONLY HALF OF IT. Which chain this resolves to decides
// which CURRENCY the buyer pays in, and the fallback for any 0x… is simply the
// first candidate — so a timeout rendered through "✅ Token detected on
// Ethereum" would be a failure of ours dressed as a fact about their token, on
// the screen that takes the money. The two silences get two cards, and the
// fact that separates them is `timedOut`.
//
// Every test here drives the REAL bound: gt.fetchPool is made to hang and the
// handler is called the way a paste calls it. A unit test of resolveTokenSoon
// alone would pass on a captureCa that never calls it — the curveBuyPath scar.

// ⚠️ BEFORE ANY require: CA_RESOLVE_MS is frozen at module-eval time, so a
// value set after the first require of group/setup.js is read by nothing. The
// loadEnv.test.js lesson, on a constant instead of a file.
//
// ⚠️ AND IT HAS A 1000ms FLOOR, which the first cut of this file did not know:
// setting 120 here and asserting against 120 reported the deadline as broken
// on code that binds perfectly. A test that fails on working code is as
// expensive as one that passes on broken code. So the DRIVEN tests wait out
// the real floor and the unit tests name their own ms — which is what the
// second argument is for.
process.env.CA_RESOLVE_MS = "1000";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fss = require("node:fs");

const gt = require("../src/group/gtPairs");
const chainPools = require("../src/group/chainPools");
const groupSetup = require("../src/group/setup");
const massdm = require("../src/handlers/massdm");
const tpl = require("../src/templates");

const CA = "0x92e4b008161ac64a7d0c5e540f453f8e6b8bd8d7"; // the address in the report
const DEADLINE = 1000; // the floor, i.e. what the driven flows actually wait

// Hold the real implementations so a test can put them back.
const real = { fetchPool: gt.fetchPool, findPool: chainPools.findPool, supports: chainPools.supports };
function restore() { Object.assign(gt, { fetchPool: real.fetchPool }); Object.assign(chainPools, { findPool: real.findPool, supports: real.supports }); }

/** Make pool discovery hang the way a long GeckoTerminal queue does. */
function hang() {
  gt.fetchPool = () => new Promise(() => {});
  chainPools.supports = () => true;
  chainPools.findPool = () => new Promise(() => {});
}
/** Make it answer "nothing here" on every chain — a fact about the token. */
function empty() {
  gt.fetchPool = async () => null;
  chainPools.supports = () => false;
  chainPools.findPool = async () => null;
}

// ⚠️ A HANG MUST FAIL WITH THE DEFECT'S NAME. Awaiting a handler that never
// returns does fail — node ends the file with "Promise resolution is still
// pending but the event loop has already resolved" — but that sentence tells
// the next reader nothing about what broke, and it does not raise node's own
// `# fail` count, which is how the first mutation run over this file reported
// the reported bug as SURVIVING. The harness was reading the wrong line; this
// makes the line unambiguous either way.
function withDeadline(p, ms, what) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: still nothing after ${ms}ms — this is the reported hang`)), ms); }),
  ]);
}

function ctxFor(text) {
  const sent = [];
  return {
    sent,
    chat: { id: 7, type: "private" },
    from: { id: 7 },
    message: { text, message_id: 1 },
    session: { type: "massdm", awaitingField: "massdm_ca" },
    reply: async (t) => { sent.push(t); return { message_id: sent.length + 100 }; },
    telegram: { deleteMessage: async () => {} },
  };
}

// ── the one owner ─────────────────────────────────────────────────────────

test("a resolve that hangs answers inside the deadline, and says it timed out", async () => {
  hang();
  try {
    const t0 = Date.now();
    const out = await groupSetup.resolveTokenSoon(CA, 120);
    const ms = Date.now() - t0;
    assert.deepStrictEqual(out, { res: null, timedOut: true });
    assert.ok(ms < 2000, `waited ${ms}ms — the 120ms deadline did not bind`);
  } finally { restore(); }
});

// ⚠️ THE DISTINCTION IS THE POINT. Both come back with no chain, and the two
// flows owe the user different sentences: one is about us, the other is about
// their token.
test("a resolve that ANSWERS with nothing is not a timeout", async () => {
  empty();
  try {
    assert.deepStrictEqual(await groupSetup.resolveTokenSoon(CA), { res: null, timedOut: false });
  } finally { restore(); }
});

test("a resolve that THROWS is not a timeout either — it answered, badly", async () => {
  gt.fetchPool = async () => { throw new Error("boom"); };
  chainPools.supports = () => { throw new Error("boom"); };
  try {
    assert.deepStrictEqual(await groupSetup.resolveTokenSoon(CA), { res: null, timedOut: false });
  } finally { restore(); }
});

test("a resolve that answers in time is passed through untouched", async () => {
  gt.fetchPool = async (chain) => (chain === "bsc" ? { poolAddress: "0xpool", symbol: "X" } : null);
  chainPools.supports = () => false;
  try {
    const { res, timedOut } = await groupSetup.resolveTokenSoon(CA);
    assert.strictEqual(timedOut, false);
    assert.strictEqual(res && res.chain, "bsc");
  } finally { restore(); }
});

// ⚠️ THE TIMER IS NOT unref'd, so it MUST be cleared on the winning path: an
// unref'd timer does not hold the event loop open and a process with nothing
// else pending would exit with the flow hung for ever, while a timer left
// armed keeps this process alive for its full budget after a 1ms answer. The
// scar is in helpers/bounded.js and in tradebot's own bounded(); measured here
// rather than argued, because a comment cannot fail.
test("the deadline timer is cleared once the resolve answers", async () => {
  gt.fetchPool = async () => ({ poolAddress: "0xpool" });
  chainPools.supports = () => false;
  try {
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    await groupSetup.resolveTokenSoon(CA, 45_000);
    const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    assert.ok(after <= before, `a 45s timer is still armed (${before} → ${after})`);
  } finally { restore(); }
});

// ── the reported symptom, driven ──────────────────────────────────────────

test("the reported paste is ANSWERED even though discovery never returns", async () => {
  hang();
  const ctx = ctxFor(CA);
  try {
    const t0 = Date.now();
    await withDeadline(massdm.handleText(ctx), DEADLINE * 12, "the pasted CA");
    const ms = Date.now() - t0;
    assert.ok(ms < DEADLINE * 12, `the paste took ${ms}ms — this is the reported hang`);
    // "🔍 Detecting…" first, then a real card. One message is the bug.
    assert.ok(ctx.sent.length >= 2, `only ${ctx.sent.length} message(s): ${JSON.stringify(ctx.sent)}`);
    assert.match(ctx.sent[0], /Detecting/);
    assert.ok(ctx.sent[ctx.sent.length - 1].length > 0);
  } finally { restore(); }
});

// ⚠️ A GUESSED CHAIN MAY NOT BE ANNOUNCED AS A DETECTED ONE — the fallback for
// any 0x… is the FIRST candidate, so this is a claim about what the buyer pays.
test("an unresolved chain is offered as a guess, never as a detection", async () => {
  hang();
  const ctx = ctxFor(CA);
  try {
    await withDeadline(massdm.handleText(ctx), DEADLINE * 12, "the pasted CA");
    const card = ctx.sent[ctx.sent.length - 1];
    assert.doesNotMatch(card, /Token detected/, `a timeout claimed a detection: ${card}`);
    assert.match(card, /couldn't confirm/i, card);
    // …and it still moves the flow on, with a price on screen.
    assert.strictEqual(ctx.session.awaitingField, "massdm_compose");
    assert.match(card, /\d/, "the card must still quote what they would pay");
  } finally { restore(); }
});

test("a chain we really detected still gets the confident card", async () => {
  gt.fetchPool = async (chain) => (chain === "bsc" ? { poolAddress: "0xpool" } : null);
  chainPools.supports = () => false;
  const ctx = ctxFor(CA);
  try {
    await massdm.handleText(ctx);
    const card = ctx.sent[ctx.sent.length - 1];
    assert.match(card, /Token detected/, card);
    assert.doesNotMatch(card, /couldn't confirm/i, card);
    assert.strictEqual(ctx.session.massForm.chain, "bsc");
  } finally { restore(); }
});

// ── the one-owner guard ───────────────────────────────────────────────────

// ⚠️ A rule the second caller has to remember is one the third forgets. Both
// user-facing flows go through the bounded resolver; the background callers
// keep their queue semantics, which is why this is a scan of the two flows
// rather than a deadline buried inside resolveToken.
test("no user-facing flow awaits the unbounded resolveToken", () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  // ⚠️ THE BODY, NOT THE FILE. The first cut scanned whole files and counted
  // two perfectly correct things in setup.js — the definition of resolveToken,
  // and the call to it INSIDE resolveTokenSoon, which is the wrapper doing its
  // job. A guard that cannot tell the fix from the defect is not a guard.
  const body = (file, fn) => {
    const src = strip(fss.readFileSync(require.resolve(file), "utf8"));
    const at = src.indexOf(`async function ${fn}(`);
    assert.ok(at > -1, `${fn} not found in ${file} — this scan proves nothing`);
    const end = src.indexOf("\nasync function ", at + 1);
    return src.slice(at, end > -1 ? end : src.length);
  };
  for (const [file, fn] of [["../src/handlers/massdm.js", "captureCa"], ["../src/group/setup.js", "applyToken"]]) {
    const src = body(file, fn);
    assert.ok(!/(?<!Soon)\bresolveToken\s*\(/.test(src), `${fn} awaits the unbounded resolveToken`);
    assert.match(src, /resolveTokenSoon\s*\(/, `${fn} must go through the bounded resolver`);
  }
});

// ── the sibling flow, driven ──────────────────────────────────────────────

// ⚠️ "A lesson applied to one of two siblings is a fix half-made." /settoken
// pastes a CA into the same serial, unbounded discovery — and it has the extra
// hazard that it ALREADY had a null branch, so an unbounded hang and a real
// "no pool" were about to be joined by a third state with nothing to tell them
// apart. The first mutation run over this file found no test here at all.
function groupCtx(text) {
  const sent = [];
  return {
    sent,
    chat: { id: -100123, type: "supergroup" },
    from: { id: 7 },
    message: { text, message_id: 1 },
    reply: async (t) => { sent.push(t); return { message_id: 1 }; },
    telegram: { getChatMember: async () => ({ status: "creator" }), deleteMessage: async () => {} },
  };
}

test("/settoken on a hanging lookup answers, and blames the QUEUE not the token", async () => {
  hang();
  const ctx = groupCtx(`/settoken ${CA}`);
  try {
    await withDeadline(groupSetup.settoken(ctx), DEADLINE * 12, "/settoken");
    const last = ctx.sent[ctx.sent.length - 1];
    assert.doesNotMatch(last, /No live pool/i, `a timeout was reported as a fact about the address: ${last}`);
    assert.match(last, /ran out of time/i, last);
  } finally { restore(); }
});

test("/settoken on a token with no pool anywhere still says NO POOL", async () => {
  empty();
  const ctx = groupCtx(`/settoken ${CA}`);
  try {
    await withDeadline(groupSetup.settoken(ctx), DEADLINE * 12, "/settoken");
    const last = ctx.sent[ctx.sent.length - 1];
    assert.match(last, /No live pool/i, `a real answer was reported as a timeout: ${last}`);
    assert.doesNotMatch(last, /ran out of time/i, last);
  } finally { restore(); }
});

// ⚠️ Both templates must EXIST and be editable, or the branch above renders an
// empty card — tpl.render on an unknown key is not an error.
test("both outcomes have a real, admin-editable template", () => {
  for (const k of ["massdm_compose_prompt", "massdm_chain_unconfirmed", "settoken_not_found", "settoken_resolve_slow"]) {
    assert.ok(tpl.keys().includes(k), `${k} is not an editable template`);
    assert.ok(String(tpl.DEFAULTS[k] || "").length > 20, `${k} has no default copy`);
  }
  assert.notStrictEqual(tpl.DEFAULTS.settoken_resolve_slow, tpl.DEFAULTS.settoken_not_found);
  // …and the timeout card must not assert the thing it cannot know.
  assert.doesNotMatch(tpl.DEFAULTS.settoken_resolve_slow, /No live pool/i);
});

// ── the chain the bot NAMES ───────────────────────────────────────────────

// Reported 2026-09-12, after the deadline above shipped: the bot ANSWERED —
// which is the fix working — and the answer was wrong. A Robinhood contract
// came back "it looks like Ethereum … so you'd pay 0.1 ETH".
//
// Two causes, and neither is the timeout:
//
//   1. `gtPairs` carried a PRIVATE seven-entry copy of the DexScreener chain
//      map with NO robinhood, so fetchDsPool("robinhood", …) returned null
//      WITHOUT MAKING A REQUEST. DexScreener was never asked about the chain
//      with the most listings on the box.
//   2. resolveToken loops the five candidates SERIALLY with robinhood FOURTH,
//      and each one can fall through to the GeckoTerminal queue — so under the
//      8s bound it never reached candidate 4 whatever DexScreener knew.
//
// And the endpoint it was calling per-chain answers for EVERY chain at once,
// so the loop made five identical requests and discarded four fifths of each.

const { DEXSCREENER_SLUG } = require("../src/config/chains");

/** DexScreener's token endpoint, answering for several chains in one payload. */
function dsServing(pairs) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ pairs }) };
  };
  return calls;
}
const pair = (chainId, liq, extra = {}) => ({
  chainId,
  pairAddress: `0xpool-${chainId}`,
  baseToken: { address: CA, symbol: "HMM", name: "Hmm" },
  quoteToken: { address: "0xweth", symbol: "WETH" },
  priceUsd: "1",
  liquidity: { usd: liq },
  ...extra,
});

// ⚠️ THE MAP HAS ONE OWNER. A hand-written copy is how robinhood went missing,
// and the slug is not always the chain key (`sei` → `seiv2`), which is exactly
// what a copy gets wrong. Asserted by SCAN because the copy was private: a
// value test cannot see a map that is never exported.
test("gtPairs reads the one DexScreener chain map, never its own copy", () => {
  const src = fss.readFileSync(require.resolve("../src/group/gtPairs.js"), "utf8");
  assert.ok(!/const\s+DS_CHAIN\s*=\s*\{/.test(src), "gtPairs declares its own DexScreener chain map again");
  assert.match(src, /DEXSCREENER_SLUG/, "gtPairs must read the one owner");
  assert.strictEqual(DEXSCREENER_SLUG.robinhood, "robinhood", "the one map carries robinhood");
  assert.strictEqual(DEXSCREENER_SLUG.sei, "seiv2", "…and a slug that is not its chain key");
});

test("a Robinhood contract resolves to robinhood, not to the first candidate", async () => {
  const calls = dsServing([pair("robinhood", 90_000)]);
  hang(); // GeckoTerminal and the log walk never answer — DexScreener alone must do it
  try {
    const { res, timedOut } = await groupSetup.resolveTokenSoon(CA);
    assert.strictEqual(timedOut, false, "one DexScreener request must beat the deadline");
    assert.strictEqual(res && res.chain, "robinhood", `resolved to ${res && res.chain}`);
    assert.strictEqual(calls.length, 1, `made ${calls.length} requests — the endpoint answers every chain at once`);
  } finally { restore(); }
});

// ⚠️ NOT BY THE CANDIDATE LIST'S ORDER. `0x…` puts ethereum first and robinhood
// fourth, so a positional pick answers "ethereum" for any EVM token with so
// much as a dust pair there — and on the Mass DM flow that decides whether the
// buyer is charged in ETH or in something else.
test("the chain is chosen by POOL DEPTH, not by candidate order", async () => {
  dsServing([pair("ethereum", 800), pair("robinhood", 250_000)]);
  hang();
  try {
    const { res } = await groupSetup.resolveTokenSoon(CA);
    assert.strictEqual(res && res.chain, "robinhood", "a dust ethereum pair must not outrank a real robinhood pool");
  } finally { restore(); }
});

test("…and the deepest pool still wins when it IS the first candidate", async () => {
  dsServing([pair("ethereum", 500_000), pair("robinhood", 250)]);
  hang();
  try {
    const { res } = await groupSetup.resolveTokenSoon(CA);
    assert.strictEqual(res && res.chain, "ethereum");
  } finally { restore(); }
});

// A chain nobody asked about may not answer: the same 0x address can carry a
// pair on a network this paste has no candidate for.
test("a pair on a chain outside the candidates is ignored", async () => {
  dsServing([pair("polygon", 900_000)]);
  hang();
  try {
    const { res, timedOut } = await groupSetup.resolveTokenSoon(CA, 400);
    assert.strictEqual(res, null, "polygon is not a candidate for this paste");
    assert.strictEqual(timedOut, true, "…so it falls through to the bounded loop");
  } finally { restore(); }
});

test("the Mass DM card names the chain it really resolved", async () => {
  dsServing([pair("robinhood", 90_000)]);
  hang();
  const ctx = ctxFor(CA);
  try {
    await withDeadline(massdm.handleText(ctx), DEADLINE * 12, "the pasted CA");
    const card = ctx.sent[ctx.sent.length - 1];
    assert.match(card, /Token detected/, card);
    assert.doesNotMatch(card, /Ethereum/, `named the wrong network: ${card}`);
    assert.strictEqual(ctx.session.massForm.chain, "robinhood");
  } finally { restore(); }
});
