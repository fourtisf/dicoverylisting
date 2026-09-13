// TTL cache behind a minimal interface so the in-memory impl can be swapped
// for Redis (Upstash) without touching providers. stale value is kept and
// served when a refresh fails — providers are flaky free tiers.
interface Entry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
}

export interface KVCache {
  get<T>(key: string): T | undefined;
  getStale<T>(key: string): T | undefined;
  /** When the held value was WRITTEN, expired or not; `undefined` if the key is
   *  not held at all. It is what lets a caller report the age of the DATA
   *  rather than of the response — with a stale value served instantly (below),
   *  a `Date.now()` stamp on the payload is a claim nobody measured. */
  storedAt(key: string): number | undefined;
  set<T>(key: string, value: T, ttlMs: number): void;
  /** How many entries are held. Present so the bound below can be tested. */
  readonly size?: number;
}

/**
 * ⚠️ THE CACHE IS BOUNDED, because half its keys come from a query string.
 *
 * `/api/token-preview`, `/api/pool` and `/api/ohlcv` all key on an address a
 * stranger typed, and nothing here ever removed an entry — an expired one just
 * sat in the Map until something overwrote it. So a loop over random addresses
 * grew this process's memory without limit, and the biggest entries are candle
 * arrays (a couple of hundred rows each).
 *
 * Evicted by INSERTION ORDER of the last write, not by expiry: an expired entry
 * is still the stale copy `cached()` serves while a refresh runs, and that
 * safety net is the difference between a stale board and a demo one. The keys
 * the app actually lives on are rewritten every cycle, so they move to the back
 * of the queue and are never the ones dropped.
 */
const MAX_ENTRIES = 1200;

class MemoryCache implements KVCache {
  private store = new Map<string, Entry<unknown>>();

  get<T>(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) return undefined;
    return e.value as T;
  }

  getStale<T>(key: string): T | undefined {
    return this.store.get(key)?.value as T | undefined;
  }

  storedAt(key: string): number | undefined {
    return this.store.get(key)?.storedAt;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    // Delete before set: a Map keeps a key's ORIGINAL insertion position on
    // overwrite, so without this the most-written key would be the first one
    // evicted — exactly backwards.
    this.store.delete(key);
    const now = Date.now();
    this.store.set(key, { value, storedAt: now, expiresAt: now + ttlMs });
    if (this.store.size > MAX_ENTRIES) {
      for (const k of this.store.keys()) {
        this.store.delete(k);
        if (this.store.size <= MAX_ENTRIES) break;
      }
    }
  }

  /** Entries currently held — exported for the test that pins the bound. */
  get size(): number {
    return this.store.size;
  }
}

// Survive Next.js dev-mode module reloads with a global singleton.
const g = globalThis as { __appCache?: KVCache };
export const cache: KVCache = g.__appCache ?? (g.__appCache = new MemoryCache());
export const CACHE_MAX_ENTRIES = MAX_ENTRIES;

// In-flight loads coalesced by key so a burst of concurrent misses triggers
// one provider call, not N — the third-party free tiers are rate-limited.
const g2 = globalThis as { __appInflight?: Map<string, Promise<unknown>> };
const inflight: Map<string, Promise<unknown>> =
  g2.__appInflight ?? (g2.__appInflight = new Map());

/** One deduped refresh per key. Resolves to the stale copy rather than
 *  rejecting whenever there is one, so a caller that is no longer awaiting it
 *  (the stale-while-revalidate path below) can never leave an unhandled
 *  rejection behind — in Node 18 that ends the process. */
function refresh<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const load = (async () => {
    try {
      const value = await loader();
      cache.set(key, value, ttlMs);
      return value;
    } catch (err) {
      const stale = cache.getStale<T>(key);
      if (stale !== undefined) return stale;
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, load);
  return load;
}

/**
 * Fetch-through helper: fresh hit → cached; expired hit → the stale copy NOW
 * while a refresh runs behind it; nothing held → the loader, awaited.
 *
 * ⚠️ THIS USED TO BLOCK ON EXPIRY, and that was the whole reason the site sat
 * on skeleton rows. `cache.get()` answers `undefined` the moment an entry
 * expires, so control fell straight through to `await loader()`; the stale copy
 * was reached only from the `catch`, i.e. when the loader THREW and never when
 * it was merely SLOW. The board's TTL is 60s and its loader is ~19
 * GeckoTerminal chunks paced against a per-process budget of 15/min, each able
 * to wait 3s for a slot and then time out after 9s — on a rate-limited minute
 * that is a minute or more of wall clock. So once every 60 seconds one visitor
 * paid for the entire refresh with the page held blank, over a perfectly good
 * board that was sixty-one seconds old. The payload's own HTTP header
 * (`stale-while-revalidate=30`) had been promising every CDN in front of it the
 * opposite behaviour since the route was written.
 *
 * ⚠️ THERE IS DELIBERATELY NO UPPER BOUND ON HOW STALE A SERVED VALUE MAY BE.
 * The alternative to serving it is blocking and then serving the very same
 * value out of the `catch` — the same data behind a spinner. What a long outage
 * owes the reader is the AGE, not a wait, and `cache.storedAt(key)` is how a
 * caller reports it.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = cache.get<T>(key);
  if (hit !== undefined) return hit;

  const stale = cache.getStale<T>(key);
  if (stale !== undefined) {
    // Deduped by `refresh`, so a burst of readers still costs one load. The
    // `.catch` is not belt-and-braces: `refresh` only rejects when the stale
    // copy has been evicted under us, and nobody is awaiting this one.
    void refresh(key, ttlMs, loader).catch(() => {});
    return stale;
  }

  return refresh(key, ttlMs, loader);
}

/**
 * Resolve `p` if it settles within `ms`, otherwise give up waiting — and leave
 * `p` RUNNING, because its result still lands in the cache for the next reader.
 *
 * For the one case a stale copy cannot cover: a COLD start, where there is
 * genuinely nothing to serve. A process restarted by a deploy has an empty
 * cache, so the first visitor pays the full refresh; on a rate-limited minute
 * that is the page hanging for a minute or two, which reads as a broken site
 * rather than a slow one. A caller with an honest fallback to show (the board's
 * `live: false` demo pill) is better off showing it and picking the real thing
 * up on the next poll.
 *
 * `{ok: false}` covers slow AND failed, deliberately — the caller's answer to
 * both is its fallback, and `p`'s own rejection is absorbed here so it can
 * never surface as an unhandled rejection once nobody is awaiting it.
 */
export function within<T>(
  p: Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false });
    }, ms);
    // ⚠️ NOT `unref`'d. A REQUEST is waiting on this deadline, and an unref'd
    // timer does not hold the event loop open — a process with nothing else
    // pending exits with the caller hung for ever, which is what the trade
    // bot's `bounded()` had to learn. It is cleared the moment `p` settles.
    p.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false });
      },
    );
  });
}
