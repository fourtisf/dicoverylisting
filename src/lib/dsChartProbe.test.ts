// The pure halves of `scripts/ds-chart-probe.mjs` — the script that finds
// DexScreener's real candle request on a box that can reach it.
//
// These are REAL tests, not the source guards this repo falls back to when a
// module cannot be imported: the script exports its pure functions and only
// runs its sweep when invoked directly, so the runner can drive them. Each
// case below pins a defect that actually happened while it was written, on a
// sandbox that cannot reach any dexscreener.com host — which is exactly why
// the parts that do not need the network have to be provable without it.
import test from "node:test";
import assert from "node:assert/strict";
import { barsOf, classify, fill, scanBundle, upsertEnv } from "../../scripts/ds-chart-probe.mjs";

test("⚠️ a discovered template survives the braces in its own placeholders", () => {
  // THE DEFECT: the template pattern's character class stopped at `{`, so
  // `/dex/chart/amm/v9/{dex}/bars/{chain}/{pair}` — the one string worth
  // finding — never reached `templates`, and the sweep probed six built-in
  // guesses while ignoring what the bundle had just handed it.
  const bundle = `var H="https://io.dexscreener.com";var P="/dex/chart/amm/v9/{dex}/bars/{chain}/{pair}";`;
  const found = scanBundle(bundle);
  assert.ok([...found.templates].includes("/dex/chart/amm/v9/{dex}/bars/{chain}/{pair}"));
  assert.ok([...found.hosts].includes("io.dexscreener.com"));
});

test("the datafeed host is recovered from any dexscreener.com subdomain", () => {
  const found = scanBundle(`fetch("https://io.dexscreener.com/x");img("https://dd.dexscreener.com/y")`);
  assert.deepEqual([...found.hosts].sort(), ["dd.dexscreener.com", "io.dexscreener.com"]);
});

test("a prefix with no pair placeholder is reported but is not a candidate path", () => {
  // "/dex/log/amm/v9/" is real and worth PRINTING for a human to assemble; it
  // cannot address a pair, so spending an HTTP request on it is noise.
  const found = scanBundle(`var L="/dex/log/amm/v9/";`);
  assert.ok([...found.fragments].includes("/dex/log/amm/v9/"));
  const addressable = (p: string) => p.includes("{pair}") || p.includes("{chain}");
  assert.equal([...found.fragments].filter(addressable).length, 0);
});

test("fill substitutes every placeholder, including repeats", () => {
  const v = { dex: "raydium", chain: "solana", pair: "P1", from: 1, to: 2, res: "15", limit: 100 };
  assert.equal(fill("/dex/chart/amm/v3/{dex}/bars/{chain}/{pair}", v), "/dex/chart/amm/v3/raydium/bars/solana/P1");
  assert.equal(fill("symbol={pair}&x={pair}&res={res}", v), "symbol=P1&x=P1&res=15");
});

test("⚠️ 404 and 400 are different facts and must not collapse", () => {
  // The whole point of the sweep: a 404 is the wrong path, a 400 is the RIGHT
  // path refusing the parameters. Reporting both as "failed" is what sent an
  // operator back to guessing paths when only the query was wrong.
  assert.match(classify({ status: 404, ok: false, body: "Cannot GET /x", ms: 1 }).verdict, /wrong path/);
  assert.match(classify({ status: 400, ok: false, body: "Bad Request", ms: 1 }).verdict, /RIGHT PATH/);
  assert.equal(classify({ status: 404, ok: false, body: "", ms: 1 }).win, false);
  assert.equal(classify({ status: 400, ok: false, body: "", ms: 1 }).win, false);
});

test("a refusal of this server is not a statement about the path", () => {
  for (const status of [401, 403, 451]) {
    assert.match(classify({ status, ok: false, body: "", ms: 1 }).verdict, /refuses THIS SERVER/);
  }
  assert.match(classify({ status: 429, ok: false, body: "", ms: 1 }).verdict, /rate limited/);
  assert.match(classify({ status: 0, ok: false, body: null, ms: 1, why: "ENOTFOUND" }).verdict, /could not ask/);
});

test("only a 200 carrying bars wins, and an empty list is an answer rather than a win", () => {
  const bars = [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }];
  const won = classify({ status: 200, ok: true, body: JSON.stringify({ data: { bars } }), ms: 1 });
  assert.equal(won.win, true);
  assert.equal(won.bars?.length, 1);

  const empty = classify({ status: 200, ok: true, body: JSON.stringify({ bars: [] }), ms: 1 });
  assert.equal(empty.win, false);
  assert.match(empty.verdict, /empty bar list/);

  const noList = classify({ status: 200, ok: true, body: JSON.stringify({ nope: 1 }), ms: 1 });
  assert.equal(noList.win, false);
  assert.match(noList.verdict, /DS_CHART_BARS_KEY/);
});

test("barsOf reads the same envelopes the provider does, one level of nesting in", () => {
  const rows = [1, 2, 3];
  assert.deepEqual(barsOf(rows), rows);
  for (const k of ["bars", "data", "candles", "rows", "result"]) {
    assert.deepEqual(barsOf({ [k]: rows }), rows, k);
  }
  assert.deepEqual(barsOf({ data: { bars: rows } }), rows);
  assert.equal(barsOf({ a: { b: { c: { d: rows } } } }), null, "must not recurse without bound");
  assert.equal(barsOf(null), null);
  assert.equal(barsOf("nope"), null);
});

test("⚠️ writing to .env.local never disturbs a line it did not put there", () => {
  // That file holds ADMIN_PASS_HASH, INTERNAL_API_TOKEN and the bot keys. A
  // probe that rewrites, reorders or reformats any of them is a far worse
  // outage than the chart it was fixing.
  const before = [
    "ADMIN_PASS_HASH=scrypt:abc:def",
    "# the chart source",
    "GECKOTERMINAL_API_KEY=CG-existing",
    "",
  ].join("\n");
  const after = upsertEnv(before, { DS_CHART_PATH: "/dex/chart/{dex}/history" });
  assert.ok(after.startsWith("ADMIN_PASS_HASH=scrypt:abc:def\n# the chart source\nGECKOTERMINAL_API_KEY=CG-existing"));
  assert.match(after, /^DS_CHART_PATH=\/dex\/chart\/\{dex\}\/history$/m);
});

test("a key that is already set is replaced in place, not duplicated", () => {
  const before = "A=1\nDS_CHART_PATH=/old\nB=2\n";
  const after = upsertEnv(before, { DS_CHART_PATH: "/new" });
  assert.equal((after.match(/^DS_CHART_PATH=/gm) ?? []).length, 1);
  assert.match(after, /^DS_CHART_PATH=\/new$/m);
  // …and it stays where it was, so a diff of the file reads as one line changed.
  assert.equal(after.trim().split("\n")[1], "DS_CHART_PATH=/new");
});

test("a commented-out key is left commented and the real one is appended", () => {
  // `#DS_CHART_PATH=…` is an operator's note to themselves, not an assignment.
  const after = upsertEnv("#DS_CHART_PATH=/tried-this\n", { DS_CHART_PATH: "/real" });
  assert.match(after, /^#DS_CHART_PATH=\/tried-this$/m);
  assert.match(after, /^DS_CHART_PATH=\/real$/m);
});

test("a file with no trailing newline does not get two keys on one line", () => {
  const after = upsertEnv("A=1", { DS_CHART_API: "https://io.dexscreener.com" });
  assert.match(after, /^A=1$/m);
  assert.match(after, /^DS_CHART_API=https:\/\/io\.dexscreener\.com$/m);
});

test("an empty or absent file is a valid starting point", () => {
  assert.match(upsertEnv("", { A: "1" }), /^A=1$/m);
  assert.match(upsertEnv(undefined, { A: "1" }), /^A=1$/m);
});
