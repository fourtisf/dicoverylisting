// "bagaimana agar masalah ini tidak terjadi lagi?? trending minimal harus 5 token"
//
// Three reports of the same symptom in two days, three different causes, and in
// every one of them the OPERATOR was the detector: they counted rows in the
// channel and asked. A fourth cause will turn up — so what is watched here is
// the PROMISE (every chain carries at least perChainMin), not the causes.
const test = require("node:test");
const assert = require("node:assert");
const watch = require("../src/services/trendingWatch");

const MIN = 60_000;
const chain = (over = {}) => ({ id: "ethereum", featured: 3, floor: 5, eligible: 0, fillWhy: null, gainFloor: 5, ...over });

test("a chain short for ONE cycle is not an incident", () => {
  // A slot rolling over between cycles must not page anybody.
  const t0 = 1_000_000;
  let { state, alerts } = watch.evaluate([chain()], {}, { now: t0 });
  assert.deepStrictEqual(alerts, [], "paged on the first sight of a short board");
  ({ state, alerts } = watch.evaluate([chain()], state, { now: t0 + 10 * MIN }));
  assert.deepStrictEqual(alerts, [], "still inside the grace period");
});

test("…but one that STAYS short is said out loud, once, with the reason", () => {
  const t0 = 1_000_000;
  let { state } = watch.evaluate([chain()], {}, { now: t0 });
  const late = watch.evaluate([chain()], state, { now: t0 + 60 * MIN });
  assert.strictEqual(late.alerts.length, 1);
  assert.match(late.alerts[0].text, /short on ethereum/i);
  assert.match(late.alerts[0].text, /3<\/b> on the board, minimum is <b>5/, late.alerts[0].text);
  assert.match(late.alerts[0].text, /60 min/);

  // Not once per cycle: an alert every cycle is a channel nobody reads.
  const again = watch.evaluate([chain()], late.state, { now: t0 + 75 * MIN });
  assert.deepStrictEqual(again.alerts, [], "re-paged inside the repeat window");

  // …but it does repeat eventually, or a board short for a week is one message
  // on day one that everybody has scrolled past.
  const day = watch.evaluate([chain()], late.state, { now: t0 + 60 * MIN + watch.REPEAT_MS });
  assert.strictEqual(day.alerts.length, 1, "never repeated at all");
});

test("a RECOVERY is an alert too", () => {
  // Otherwise the operator cannot tell a fixed board from a forgotten one.
  const t0 = 1_000_000;
  let { state } = watch.evaluate([chain()], {}, { now: t0 });
  ({ state } = watch.evaluate([chain()], state, { now: t0 + 60 * MIN }));
  const back = watch.evaluate([chain({ featured: 5 })], state, { now: t0 + 90 * MIN });
  assert.strictEqual(back.alerts.length, 1);
  assert.match(back.alerts[0].text, /back at target/);
  assert.deepStrictEqual(back.state, {}, "a healthy chain keeps no state");

  // A chain that recovers before anyone was told says nothing at all.
  const quiet = watch.evaluate([chain({ featured: 5 })], { ethereum: { since: t0 } }, { now: t0 + 5 * MIN });
  assert.deepStrictEqual(quiet.alerts, []);
});

test("the three causes get three different answers — that is what took three rounds", () => {
  // ⚠️ `considered` STATED, not inherited. It is how many of the spares the
  // caller actually priced, and without it this branch is not reachable at all
  // any more — see the unmeasured test below for why.
  const spares = watch.diagnose({ featured: 3, floor: 5, eligible: 4, considered: 4 });
  assert.strictEqual(spares.code, "spares_unusable");
  assert.match(spares.text, /−15%/, "must not read as 'no listings'");
  assert.match(spares.text, /next cycle/, "with the filler on, that state resolves itself");

  const failed = watch.diagnose({ featured: 3, floor: 5, eligible: 0, fillWhy: "rate limited" });
  assert.strictEqual(failed.code, "fill_failed");
  assert.match(failed.text, /rate limited/, "the filler's own reason is the diagnosis");

  // A chain can have BOTH: spares that are all in free-fall, and a fill that
  // then failed. The filler's reason is the specific one — answering "there are
  // 2 spares here" over the top of "GT is rate-limited" sends the operator off
  // to list tokens by hand for a problem that clears itself in ten minutes.
  const both = watch.diagnose({ featured: 4, floor: 5, eligible: 2, fillWhy: "rate limited" });
  assert.strictEqual(both.code, "fill_failed");
  assert.match(both.text, /rate limited/);
  assert.match(both.text, /2 spare/, "…but the spares are still worth naming: they are why it needed a fill");

  const none = watch.diagnose({ featured: 0, floor: 5, eligible: 0 });
  assert.strictEqual(none.code, "no_listings");
  assert.match(none.text, /Fill from market/, "it must name the switch that fixes it");

  assert.strictEqual(watch.diagnose({ featured: 5, floor: 5, eligible: 0 }), null, "at the floor is not a problem");
  assert.strictEqual(watch.diagnose({ featured: 9, floor: 5, eligible: 0 }), null);
});

test("⚠️ the cause named must ACCOUNT for the shortfall, not just be first in the list", () => {
  // Live board, 17:57: `Ethereum 4/5 · 18 spare listing(s) · 10 of 18 opened
  // are below the floors` — under the sentence "they are below the
  // free-trending floors, and none went on". EIGHT of the eighteen had CLEARED
  // the floors and something else refused them, so the cause on screen could
  // not explain the shortfall — and it is the cause an operator acts on, which
  // is how two rounds of this went to the wrong setting. `trendFill` has
  // reported the DOMINANT counter since it was written; the promoter never got
  // that ladder.
  const base = { featured: 4, floor: 5, eligible: 18, considered: 18, floorsText: "cap $100.0K" };
  const mixed = watch.diagnose({ ...base, floorRefused: 10, freeFall: 8 });
  assert.strictEqual(mixed.code, "below_floors", mixed.text);
  assert.match(mixed.text, /10 of the 18/, `it claimed the floors accounted for all of them: ${mixed.text}`);

  // The dominant one wins, not the first one written down.
  assert.strictEqual(watch.diagnose({ ...base, floorRefused: 2, freeFall: 9 }).code, "free_fall");
  assert.strictEqual(watch.diagnose({ ...base, floorRefused: 1, noReading: 7 }).code, "no_reading");

  // …and when one counter IS all of them, it says so without the fraction.
  const all = watch.diagnose({ ...base, freeFall: 8 });
  assert.strictEqual(all.code, "free_fall");
  assert.match(all.text, /^8 spare listing\(s\) opened here, and none went on/, all.text);
});

test("⚠️ a booking the SITE refused is not a shortage of candidates", () => {
  // `bookTrending` failing was logged at DEBUG while the SUCCESS beside it was
  // INFO — so production printed nothing at all, the board decayed, and every
  // surface blamed the floors. It outranks the refusal ladder: no floor will
  // fix a site that says no.
  const why = watch.diagnose({
    featured: 4, floor: 5, eligible: 18, considered: 18,
    floorRefused: 10, freeFall: 8, bookFailed: 2, bookWhy: "404: Listing not found",
  });
  assert.strictEqual(why.code, "book_failed", why.text);
  assert.match(why.text, /404: Listing not found/, "the site's own reason is the diagnosis");
  assert.ok(!/below the free-trending floors/.test(why.text), `it blamed the floors for a refused booking: ${why.text}`);
});

test("⚠️ a cause NOBODY MEASURED is not a cause", () => {
  // Live run, straight after the deploy: `trending:check` (no --floors) printed
  // "63 spare listing(s) here, and none went on — they are below −15%" for
  // Robinhood and "75 spare listing(s)…" for another chain, having priced not
  // one row. `floorRefused: 0` and `unread: 0` mean "we looked and found none"
  // to this function and "we never looked" from that caller, and the confident
  // sentence was the reading an operator would act on.
  const blind = watch.diagnose({ featured: 3, floor: 5, eligible: 63 });
  assert.strictEqual(blind.code, "unmeasured", blind.text);
  assert.ok(!/−15%/.test(blind.text), `it asserted a cause it did not measure: ${blind.text}`);
  assert.match(blind.text, /--floors/, "it must name what would answer it");
  assert.match(blind.text, /63 spare/, "the count it DOES know is still worth naming");

  // …and a caller that DID measure still gets the specific answer.
  assert.strictEqual(watch.diagnose({ featured: 3, floor: 5, eligible: 63, considered: 40 }).code, "spares_unusable");

  // ⚠️ NEVER MORE SPARES THAN THE CHAIN HAS LEFT. `considered` is measured
  // BEFORE the pass promotes anything and `eligible` is counted after, so on a
  // chain that filled part of its gap the window is the bigger number — and
  // printing it would claim more spares than are actually there.
  const partly = watch.diagnose({ featured: 4, floor: 5, eligible: 2, considered: 40 });
  assert.match(partly.text, /^2 spare/, partly.text);
});

test("every chain is judged on its own — one healthy chain must not mask a short one", () => {
  const t0 = 1_000_000;
  const chains = [chain({ id: "solana", featured: 7 }), chain({ id: "base", featured: 2, eligible: 3 })];
  let { state } = watch.evaluate(chains, {}, { now: t0 });
  const late = watch.evaluate(chains, state, { now: t0 + 60 * MIN });
  assert.deepStrictEqual(late.alerts.map((a) => a.chain), ["base"]);
});
