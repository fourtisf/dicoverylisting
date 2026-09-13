// The trades panel, and the twelve invented transactions it used to draw.
//
// On a box being rate-limited by GeckoTerminal — which is the state the
// production server was found in — EVERY token page rendered `demoTrades(t)`:
// twelve deterministic buys and sells with invented USD amounts, invented token
// amounts, a price jittered around the card's, and invented trader addresses
// ("0x" + random hex). The only thing separating them from real trades was a
// 10px label reading "Recent" and a dot at 40% opacity.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const PANEL = read("src/components/TokenTrades.tsx");
const ROUTE = read("src/app/api/trades/route.ts");
const CSS = read("src/app/globals.css");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("⚠️ nothing in the trades panel invents a trade", () => {
  const body = code(PANEL);
  assert.ok(!/demoTrades/.test(body), "the fabricator is gone");
  assert.ok(!/Math\.random|1103515245/.test(body), "and so is the generator it was built on");
  assert.ok(!/"0x" \+/.test(body), "no invented trader addresses");
});

test("an empty panel SAYS which of the two reasons it is", () => {
  // A token with no indexed pool and a feed we could not read need different
  // reactions from the reader; an empty grid gives them the same one.
  assert.match(PANEL, /No indexed pool for this token yet/);
  assert.match(PANEL, /Couldn't read recent trades just now/);
  assert.match(PANEL, /trades-none/);
  assert.match(CSS, /\.trades-none\{/);
});

test("the route carries the reason instead of a bare empty list", () => {
  assert.match(ROUTE, /readWhy\(err\)/);
  assert.match(ROUTE, /trades: \[\], why:/);
  // An empty list from a pool that exists is an ANSWER, not a failure.
  assert.match(ROUTE, /No trades in this pool's recent window/);
});

test("a failed poll keeps REAL rows but stops calling them live", () => {
  // The pool did not stop trading because one request did not land — but a
  // pulsing "Live" over a feed that has stopped moving is the reassuring
  // reading of a state that is not.
  assert.match(PANEL, /setLive\(false\);\s*\n\s*setTrades\(\(prev\) => \(prev && prev\.length \? prev : \[\]\)\)/);
  assert.match(PANEL, /trades-stale/);
  assert.match(CSS, /\.trades-stale\{/);
  assert.ok(!/\{live \? "Live" : "Recent"\}/.test(PANEL), "'Recent' used to mean 'made up'");
});
