// The cache is bounded, and the bound is the point: half its keys come from a
// query string (/api/token-preview, /api/pool, /api/ohlcv all key on an address
// a stranger typed), and nothing ever removed an entry.
//
// …and it is STALE-WHILE-REVALIDATE, which is the half that decides whether the
// site renders. `cached()` blocked on expiry for as long as it existed: the
// stale copy was reached only from the `catch`, so a loader that THREW was
// covered and a loader that was merely SLOW was not — and the board's loader is
// ~19 GeckoTerminal chunks against a 15/min budget. Every 60 seconds one
// visitor paid for the whole refresh with the page on skeleton rows.
import test from "node:test";
import assert from "node:assert/strict";
import { CACHE_MAX_ENTRIES, cache, cached, within } from "./cache.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));
const defer = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

test("a flood of one-off keys cannot grow the process without limit", () => {
  for (let i = 0; i < CACHE_MAX_ENTRIES + 500; i++) cache.set(`junk:${i}`, i, 60_000);
  assert.ok((cache.size ?? 0) <= CACHE_MAX_ENTRIES, `held ${cache.size}`);
});

test("⚠️ the key the app lives on survives the flood, because it is rewritten", () => {
  // A Map keeps a key's ORIGINAL insertion position on overwrite, so a naive
  // implementation evicts the busiest key first — exactly backwards.
  cache.set("listings:market", "board", 60_000);
  for (let i = 0; i < 200; i++) {
    cache.set(`flood:${i}`, i, 60_000);
    cache.set("listings:market", "board", 60_000); // the refresh cycle
  }
  assert.equal(cache.get("listings:market"), "board");
});

test("an expired entry is still the stale copy served when a provider is down", async () => {
  // Evicting by EXPIRY rather than by write order would delete exactly the
  // value that keeps a provider outage from emptying the board.
  cache.set("prov:x", "last good", 1);
  await tick();
  assert.equal(cache.get("prov:x"), undefined, "not fresh");
  const out = await cached("prov:x", 60_000, async () => {
    throw new Error("provider down");
  });
  assert.equal(out, "last good");
  await tick();
  // …and the failed refresh did not overwrite it, so the NEXT reader is still
  // covered. (Serving it is now the stale-while-revalidate branch's job — this
  // asserts what the failure left behind, which is the half that outlives it.)
  assert.equal(cache.getStale("prov:x"), "last good");
});

test("a load overtaken by another writer resolves to what was PLANTED, never to the error", async () => {
  // The shape that still reaches the loader-failed→stale fallback now that an
  // expired entry is served before the loader is ever consulted: a COLD key
  // with two owners. `poolCache` is exactly that — a token page resolves
  // `pool:<net>:<addr>` from GeckoTerminal while the board's own refresh plants
  // the same key from the market read it already paid for. Rejecting there
  // would throw away an answer we are holding.
  const d = defer<string | null>();
  const p = cached("plant:k", 60_000, async () => d.promise);
  await tick();
  cache.set("plant:k", "0xpool-from-the-board", 60_000); // rememberPool()
  d.reject(new Error("GeckoTerminal 429"));
  assert.equal(await p, "0xpool-from-the-board");
});

test("⚠️ an expired entry is served WHILE the refresh runs — a slow loader never holds the page", async () => {
  // The defect this whole feature exists for: the loader is slow, not broken,
  // so the `catch` never runs and the reader waits out the entire refresh.
  cache.set("swr:slow", "board@t0", 1);
  await tick();
  const d = defer<string>();
  let started = 0;
  const began = Date.now();
  const out = await cached("swr:slow", 60_000, async () => {
    started++;
    return d.promise;
  });
  assert.equal(out, "board@t0", "the stale board, not a wait");
  assert.ok(Date.now() - began < 50, `served in ${Date.now() - began}ms`);
  assert.equal(started, 1, "and the refresh was actually started");
  d.resolve("board@t1");
  await tick();
  assert.equal(await cached("swr:slow", 60_000, async () => "never"), "board@t1", "which then lands");
});

test("concurrent stale readers cost ONE refresh, not one each", async () => {
  cache.set("swr:dedupe", "old", 1);
  await tick();
  const d = defer<string>();
  let started = 0;
  const loader = async () => {
    started++;
    return d.promise;
  };
  const all = await Promise.all([
    cached("swr:dedupe", 60_000, loader),
    cached("swr:dedupe", 60_000, loader),
    cached("swr:dedupe", 60_000, loader),
  ]);
  assert.deepEqual(all, ["old", "old", "old"]);
  assert.equal(started, 1, `${started} refreshes for one expiry`);
  d.resolve("new");
  await tick();
});

test("⚠️ a background refresh that fails cannot take the process down", async () => {
  // Nobody is awaiting the refresh on the stale path, and in Node 18 an
  // unhandled rejection ends the process — a provider outage would stop the
  // whole site rather than leave it stale.
  const seen: unknown[] = [];
  const onUnhandled = (e: unknown) => seen.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    cache.set("swr:boom", "held", 1);
    await tick();
    assert.equal(await cached("swr:boom", 60_000, async () => { throw new Error("boom"); }), "held");
    await tick();
    // and again with the stale copy pulled out from under the refresh, which is
    // the one shape where `refresh` itself can still reject
    cache.set("swr:boom2", "held", 1);
    await tick();
    const d = defer<string>();
    const p = cached("swr:boom2", 60_000, async () => d.promise);
    cache.set("swr:boom2", undefined as unknown as string, 60_000); // evicted under it
    d.reject(new Error("boom"));
    await p;
    await tick();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(seen, [], "an unhandled rejection escaped the refresh");
});

test("a COLD start still blocks — there is nothing else to serve", async () => {
  const d = defer<string>();
  let done = false;
  const p = cached("swr:cold", 60_000, async () => d.promise).then((v) => {
    done = true;
    return v;
  });
  await tick();
  assert.equal(done, false, "resolved before the loader did — with what?");
  d.resolve("first board");
  assert.equal(await p, "first board");
});

test("storedAt dates the WRITE, so a caller can report the age of the data", async () => {
  const before = Date.now();
  cache.set("age:k", "v", 1);
  const at = cache.storedAt("age:k");
  assert.ok(at !== undefined && at >= before && at <= Date.now());
  await tick();
  assert.equal(cache.get("age:k"), undefined, "expired");
  assert.equal(cache.storedAt("age:k"), at, "…and still dated, because it is still servable");
  assert.equal(cache.storedAt("age:never-set"), undefined);
});

test("within() gives up on a slow load and leaves it RUNNING", async () => {
  const d = defer<string>();
  const p = cached("within:slow", 60_000, async () => d.promise);
  const r = await within(p, 20);
  assert.deepEqual(r, { ok: false });
  d.resolve("landed late");
  await tick();
  // the abandoned load still filled the cache, so the next reader pays nothing
  assert.equal(cache.get("within:slow"), "landed late");
});

test("within() absorbs a rejection rather than letting it escape", async () => {
  const seen: unknown[] = [];
  const onUnhandled = (e: unknown) => seen.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const r = await within(Promise.reject(new Error("down")), 1000);
    assert.deepEqual(r, { ok: false });
    await tick();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(seen, []);
});

test("within() resolves at once when the value is already there", async () => {
  const began = Date.now();
  const r = await within(Promise.resolve("here"), 5_000);
  assert.deepEqual(r, { ok: true, value: "here" });
  assert.ok(Date.now() - began < 50, "waited for the deadline it did not need");
});
