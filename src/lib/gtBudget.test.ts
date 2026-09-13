// The GeckoTerminal budget: every rule here exists because the production box
// was being 429'd on a quota counted PER IP and shared with the bot suite, and
// the owner does not want to pay for a key. So each of these is a request the
// app used to spend and no longer does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TRADES_POLL_MS, TRADES_TTL_MS } from "./trades.ts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const ROUTE = read("src/app/api/trades/route.ts");
const PANEL = read("src/components/TokenTrades.tsx");
const APP = read("src/components/AppState.tsx");
const PIPE = read("src/lib/providers/index.ts");
const MARKET = read("src/lib/providers/geckoterminal.ts");

test("⚠️ the trades poll never lands inside its own cache window", () => {
  // TTL 8s under a 12s poll meant the entry expired ~4s before every single
  // poll arrived: one viewer = one guaranteed upstream miss per tick, and the
  // cache coalesced concurrent viewers and nothing else.
  assert.ok(TRADES_POLL_MS > TRADES_TTL_MS, `${TRADES_POLL_MS}ms poll vs ${TRADES_TTL_MS}ms ttl`);
  assert.match(PANEL, /const POLL_MS = TRADES_POLL_MS;/, "the panel derives it, never restates it");
  assert.match(ROUTE, /TRADES_TTL_MS/);
});

test("a pool GeckoTerminal does not index costs ONE request, not one per poll", () => {
  // fetchTrades retried on ANY throw, and a 404 never becomes a 200 — so an
  // unindexed pool cost two upstream requests per poll, per viewer, for as long
  // as the page stayed open. A 404 is an answer, and answers are cacheable.
  assert.match(ROUTE, /if \(res\.status === 404\) return \[\];/);
  assert.ok(!/setTimeout\(r, 600\)/.test(ROUTE), "the blanket retry is gone");
});

test("a hidden tab stops spending the site's quota", () => {
  assert.match(APP, /visibilityState === "visible"/);
  assert.match(APP, /addEventListener\("visibilitychange"/);
  assert.match(APP, /removeEventListener\("visibilitychange"/, "and it is cleaned up");
});

test("the board plants the pool it already knows where the chart routes look", () => {
  // GT returns the top pool with every board refresh; /api/ohlcv and
  // /api/trades were each paying a separate lookup for the same answer.
  assert.match(PIPE, /rememberPool\(net, t\.address, m\.poolAddress\)/);
});

test("⚠️ ONE owner for the pool cache — four files used to declare their own TTL", () => {
  // providers/index.ts, /api/pool, /api/ohlcv and /api/trades each declared
  // `POOL_TTL = 10 * 60_000` and each built the SAME cache key by hand. Four
  // copies of one number sharing one key means whichever writes last sets the
  // expiry, and raising one of them looks like it works while three others
  // quietly disagree. This test replaces one that asserted the literal — a
  // source scan that passed on the duplication it was meant to describe.
  const strip = (src: string) => src.replace(/^\s*\/\/.*$/gm, "");
  for (const [name, src] of Object.entries({
    "providers/index.ts": PIPE,
    "api/pool": read("src/app/api/pool/route.ts"),
    "api/ohlcv": read("src/app/api/ohlcv/route.ts"),
    "api/trades": ROUTE,
  })) {
    const body = strip(src);
    assert.ok(!/POOL_(?:CACHE_)?TTL\s*=/.test(body), `${name} declares its own pool TTL`);
    assert.ok(!/`pool:\$\{/.test(body), `${name} builds the pool cache key by hand`);
  }
  // …and the owner is where everyone can find it.
  const OWNER = read("src/lib/providers/poolCache.ts");
  assert.match(OWNER, /export const POOL_TTL_MS/);
  assert.match(OWNER, /export const poolKey/);
});

test("⚠️ a cycle cut short by the cooldown is a FAILED cycle, not a partial one", () => {
  // Returning it hands the caller 30 live tokens and 140 silently unpriced
  // ones, and `cached()` serves that as the board for a minute. Throwing sends
  // the whole chain to DexScreener, which covers 22 of the 23 chains.
  assert.match(MARKET, /if \(failed > 0 && gtInCooldown\(\)\) throw/);
});

// ── The board's freshness ────────────────────────────────────────────────────
// `providers/index.ts` cannot be imported by this runner (it reaches for the
// `@/` alias through `@/lib/store`), so these are source scans — mutation
// tested against the revision each one describes.

const stripComments = (src: string) => src.replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, "");

test("⚠️ the board is dated from the CACHE, never from the clock", () => {
  // An expired board is served instantly now (lib/cache.ts), so a `Date.now()`
  // stamp presents an hour-old reading as a reading from this second — and
  // `freshness()` prints exactly that stamp under the board as "3s ago". The
  // staleness the reader cannot see is the reassuring reading of a state that
  // is not.
  const body = stripComments(PIPE);
  assert.ok(!/updatedAt:\s*Date\.now\(\),/.test(body), "the payload is stamped with the response time");
  assert.match(body, /updatedAt:\s*\(live \? cache\.storedAt\(BOARD_KEY\) : undefined\)/);
});

test("⚠️ ONE spelling of the board's cache key, or the payload dates some other entry", () => {
  const body = stripComments(PIPE);
  assert.match(body, /const BOARD_KEY = "listings:market";/);
  assert.equal((body.match(/"listings:market"/g) ?? []).length, 1, "the key is written twice");
});

test("a COLD start is bounded, and what it falls back to says so on the page", () => {
  // Only the first visitor after a restart can still wait on the loader — and
  // this box is redeployed constantly. Past the deadline the captured board
  // goes out under its own `demo data` pill (live: false), and the abandoned
  // load still lands in the cache for the next 30s poll.
  const body = stripComments(PIPE);
  assert.match(body, /const COLD_WAIT_MS = [\d_]+;/);
  assert.match(
    body,
    /within\(cached\(BOARD_KEY, PRICE_TTL, loadListedTokens\), COLD_WAIT_MS\)/,
    "the board load is not bounded",
  );
  assert.match(body, /tokens = rowsToBoardTokens\(await loadRows\(\)\);\s*live = false;/);
});

test("Fear & Greed reports the age it has SINCE spent in the cache", () => {
  // `updatedMinutesAgo` is alternative.me's own reading age, measured when we
  // fetched it. Served stale for three hours it would go on reporting the age
  // it had when we last reached them.
  const body = stripComments(PIPE);
  assert.match(body, /const held = Math\.max\(0, Math\.round\(\(Date\.now\(\) - at\) \/ 60_000\)\);/);
  assert.match(body, /updatedMinutesAgo: v\.updatedMinutesAgo \+ held/);
});
