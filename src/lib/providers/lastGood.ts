// Last-known-good market memory — the sticky layer between "the providers
// answered this token" and "they missed it this one cycle".
//
// WHY IT EXISTS ("new listing persenan naik atau turun masa tidak ada"):
// a token the indexers priced an hour ago can miss ONE refresh — a failed GT
// chunk, an indexer de-listing blip, a launchpad feed that only pages the
// newest launches — and the row then collapses all the way back to the figures
// captured at listing time. Those carry chg24h 0, `changeReading` rightly
// refuses to print a fabricated zero, and 12,000 readers see a dash on a token
// that was priced sixty seconds earlier. The `cached` layer only bridges a
// WHOLE refresh failing; a per-token miss inside a successful refresh had no
// bridge at all.
//
// So every priced reading is remembered per chain+address, and a miss is
// served the last real observation for up to LAST_GOOD_TTL_MS — a measurement
// that is at most a few hours old, never a fabricated value. The backend repo
// runs the same pattern (`gt:md:last`, the sticky last-known-good its negative
// cache serves through). Past the TTL the dash returns, honestly: at some
// point a frozen reading stops being a reading.
//
// Relative import, not the "@/" alias — node:test resolves this file too.
import type { LiveMarket } from "./geckoterminal.ts";

/** How long a previously observed market may stand in for a missed one. */
export const LAST_GOOD_TTL_MS = 3 * 60 * 60 * 1000;

const mem = new Map<string, { at: number; m: LiveMarket }>();

/**
 * ⚠️ SERVING A LAST-KNOWN READING IS THE SYSTEM WORKING, AND IT WAS BEING
 * REPORTED AS A FAULT EVERY SIXTY SECONDS.
 *
 * `[market] solana: served last-known reading for 24 token(s)` went out at WARN
 * level, once per chain per cycle, for ever — six lines a minute on a box where
 * this is the ORDINARY state: the site's GeckoTerminal budget is 5/min against
 * ~19 chunks a cycle, so some chunks always lose and this layer is what keeps
 * their rows priced. It buried everything else in pm2, including the one line
 * that says a stablecoin was filtered.
 *
 * "An alert every cycle is a channel nobody reads by the second hour" —
 * `upstreams.js`, borrowed for the fourth time. So: the TRANSITION only, a
 * RECOVERY is an alert too (a chain that healed and one nobody noticed look
 * identical otherwise), and it repeats while the state holds so a long outage
 * does not scroll away.
 */
const REPORT_REPEAT_MS = 30 * 60_000;
const reported = new Map<string, { n: number; at: number }>();

/**
 * Should this cycle's fill be SAID? Pure, so a test can walk a chain through
 * days of cycles in milliseconds — the shape `trendingWatch` already uses.
 */
export function shouldReport(
  chain: string,
  filled: number,
  now = Date.now(),
  repeatMs = REPORT_REPEAT_MS,
): "started" | "recovered" | "still" | null {
  const prev = reported.get(chain);
  if (filled === 0) {
    if (!prev) return null;
    reported.delete(chain);
    return "recovered";
  }
  // ⚠️ The count is remembered but does NOT re-trigger on its own. A chain
  // drifting 24 → 23 → 24 every cycle is one incident, not thirty; reporting
  // each change is the flood again with an extra condition on it.
  if (!prev) {
    reported.set(chain, { n: filled, at: now });
    return "started";
  }
  if (now - prev.at >= repeatMs) {
    reported.set(chain, { n: filled, at: now });
    return "still";
  }
  prev.n = filled;
  return null;
}

/** Test seam — module state outliving one test is how the next one lies. */
export const _resetReports = (): void => reported.clear();

/**
 * Remember every reading in `map`, then fill this cycle's misses (addresses
 * asked for but absent) from memory. Mutates `map`; returns the lowercased
 * addresses it filled so the caller can say a recovery happened — a bridge
 * nobody can see working is one nobody notices failing.
 *
 * A fresh reading ALWAYS wins: memory is consulted only for addresses the
 * providers did not answer, and remembering runs first so a live value
 * refreshes its own memory before any fill is considered.
 */
export function fillFromLastGood(
  chain: string,
  map: Map<string, LiveMarket>,
  addrs: string[],
  now = Date.now(),
  ttl = LAST_GOOD_TTL_MS,
): string[] {
  for (const [addr, m] of map) mem.set(`${chain}:${addr}`, { at: now, m });
  const filled: string[] = [];
  for (const a of addrs) {
    const key = a.toLowerCase();
    if (map.has(key)) continue;
    const hit = mem.get(`${chain}:${key}`);
    if (!hit) continue;
    if (now - hit.at > ttl) {
      mem.delete(`${chain}:${key}`); // expired — the dash is the honest render now
      continue;
    }
    map.set(key, hit.m);
    filled.push(key);
  }
  return filled;
}

/** Test hook — the memory is module state and tests must not leak into each
 *  other (the bot repo's persisted-setting-leaks-between-tests lesson). */
export function resetLastGood(): void {
  mem.clear();
}
