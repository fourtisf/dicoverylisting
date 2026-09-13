import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// /api/pons imports through "@/" aliases and `next/server`, which this runner
// cannot load — the rule it keeps is pinned by a comment-stripped source scan,
// and the predicate it calls (`unpricedByUs`) is DRIVEN in scripts/test-pons.mjs.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const ROUTE = strip(readFileSync(new URL("../../../app/api/pons/route.ts", import.meta.url), "utf8"));

test("⚠️ a launch unpriced for OUR reason is not served for the full TTL", () => {
  // The diagnose pass's one confirmed finding, part (4): a record the ETH/USD
  // ladder could not price was cached for LAUNCH_TTL and served stale after
  // it, so a recovered ladder still answered TBA to the bot for twenty seconds.
  assert.match(ROUTE, /unpricedByUs\(launch\)/, "the route asks the one owner of that question");
  const ttl = /const UNPRICED_TTL = ([\d_]+);/.exec(ROUTE);
  const full = /const LAUNCH_TTL = ([\d_]+);/.exec(ROUTE);
  assert.ok(ttl && full, "both TTLs are named constants");
  const unpriced = Number(ttl![1].replace(/_/g, ""));
  const launch = Number(full![1].replace(/_/g, ""));
  assert.ok(unpriced < launch, `the unpriced TTL (${unpriced}) must be shorter than the launch TTL (${launch})`);
  assert.ok(unpriced > 0, "…and never zero — every reader re-running a dead ladder is the stampede the cache exists to stop");
  assert.match(ROUTE, /cache\.set\(key, launch, UNPRICED_TTL\)/, "the shorter TTL is written over the cached record");
  // ORDER: the re-set must follow the cached read (it re-keys what was just stored).
  assert.ok(ROUTE.indexOf("await cached(key") < ROUTE.indexOf("cache.set(key, launch, UNPRICED_TTL)"));
});
