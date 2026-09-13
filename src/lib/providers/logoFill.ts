// THE SWEEP THAT MAKES "every token has a logo" TRUE WITHOUT ANYONE TYPING
// ANYTHING.
//
// resolveLogo() finds the artwork; this decides WHEN it is worth going to look,
// remembers what came back, and writes the answer into the listing store so it
// is found once and then belongs to the site, the bot's board and the channel
// posts alike.
//
// The three rules it is built around are all one lesson from this repo:
//
//  • IT NEVER BLOCKS A BOARD RENDER. CoinGecko is paced at one call every 2.5s
//    (its free tier is per IP and the bot suite shares that IP), so a sweep
//    that a page waited on would be a page that hangs. The board reads what is
//    already known and the sweep runs behind it; a logo appears on the next
//    refresh, never later than a minute.
//  • "NOTHING THERE" AND "COULD NOT ASK" ARE DIFFERENT FACTS. Only the first is
//    remembered as an answer. Caching a 429 as "this project has no logo" is
//    how one rate-limited minute leaves a row monogrammed for good.
//  • IT IS BOUNDED. A cap per sweep and one sweep at a time, so a board with
//    eighty logo-less rows costs a slow trickle rather than eighty concurrent
//    lookups against three rate-limited APIs.
//
// Relative imports with extensions: node:test resolves this file.
import { resolveLogo, type LogoResult } from "./tokenLogo.ts";

/** How many tokens one sweep may look up. At CoinGecko's pace this is ~20s of
 *  background work; the board rebuilds every 60s, so a backlog drains steadily
 *  instead of arriving as one burst against three rate-limited APIs. */
const MAX_PER_SWEEP = 8;

/** A token every source ANSWERED about and none had artwork for. Long enough
 *  not to re-ask on every board rebuild, short enough that a project that
 *  uploads artwork this morning is wearing it this evening. */
const MISS_TTL_MS = 12 * 60 * 60_000;

/** A token we could not get a decision on (an upstream was down or refusing).
 *
 *  ⚠️ This is a RATE LIMIT, not an answer: nothing is remembered about the
 *  token, we simply do not spend the next sweep's budget on the same row while
 *  the outage lasts. Without it one undecided token would be retried every
 *  cycle for ever and starve every other row of the cap above. */
const UNDECIDED_TTL_MS = 30 * 60_000;

interface Known {
  url: string | null;
  /** When this was decided. Absent expiry (a found logo) never expires. */
  at: number;
  kind: "found" | "miss" | "undecided";
}

// Per-process memory. The durable copy is the listing store — this only spares
// a restart from re-asking for rows it has already written.
const g = globalThis as { __dexvraLogoMem?: Map<string, Known>; __dexvraLogoSweeping?: { on: boolean } };
const mem: Map<string, Known> = g.__dexvraLogoMem ?? (g.__dexvraLogoMem = new Map());
// The "one sweep at a time" flag lives on the same global as the memory, and
// for the same reason: Next can hold more than one instance of a module, and a
// per-instance flag would let two sweeps run while sharing one memory — which
// is precisely the state the flag exists to prevent.
const running = g.__dexvraLogoSweeping ?? (g.__dexvraLogoSweeping = { on: false });

const key = (chain: string, address: string) => `${chain}:${String(address).toLowerCase()}`;

/** The logo this process has already resolved for a token, or null when it has
 *  none to show. A RENDERER's question — it never says why, because a row with
 *  no artwork and a row we have not looked at yet draw identically. */
export function knownLogo(chain: string, address: string): string | null {
  const hit = mem.get(key(chain, address));
  return hit?.kind === "found" ? hit.url : null;
}

/** Is it worth spending a lookup on this token? A SWEEP's question, and
 *  deliberately a different one from `knownLogo`.
 *
 *  Never asked before → yes. A found logo → never again. A miss → not until it
 *  goes stale, because "no artwork anywhere" is an answer with a shelf life. An
 *  undecided → not until the retry window passes, which is a rate limit on us
 *  rather than a claim about the token. */
export function shouldLookUp(chain: string, address: string, now = Date.now()): boolean {
  const hit = mem.get(key(chain, address));
  if (!hit) return true;
  if (hit.kind === "found") return false;
  return now - hit.at > (hit.kind === "miss" ? MISS_TTL_MS : UNDECIDED_TTL_MS);
}

/** Seed the memory with a logo we did not have to resolve — a listing that
 *  already carries one, or one a market provider supplied. Stops the sweep
 *  spending its budget on rows that were never missing anything. */
export function rememberLogo(chain: string, address: string, url: string, now = Date.now()): void {
  mem.set(key(chain, address), { url, at: now, kind: "found" });
}

export interface FillDeps {
  /** How many rows are waiting, so the line can say how long the queue is.
   *  Absent, it reports no backlog rather than guessing one. */
  queued?: number;
  resolve?: (chain: string, address: string) => Promise<LogoResult>;
  /** Writes the resolved logo into the listing store. Best-effort: a failed
   *  write costs permanence, never the logo — the process memory still has it. */
  persist?: (chain: string, address: string, url: string) => Promise<unknown>;
  /** Copy the resolved artwork onto our own disk and move the row onto it.
   *  Best-effort and AFTER `persist`: a pin that cannot be made leaves exactly
   *  the behaviour that shipped before it, which is a working gateway url. */
  pin?: (chain: string, address: string, url: string) => Promise<string | null>;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface SweepReport {
  looked: number;
  found: number;
  missing: number;
  undecided: number;
  persisted: number;
  /** How many stopped depending on a public gateway this pass. */
  pinned: number;
  /** Which source each logo came from — "6 of 7 from CoinGecko" is the
   *  difference between a working chain of sources and one carrying all of it. */
  bySource: Record<string, number>;
  /**
   * WHICH upstream could not be asked, and the first reason it gave.
   *
   * ⚠️ `undecided` was a COUNT with nothing behind it, and a box whose sources
   * are all refusing it printed `0 found, 0 with no artwork anywhere, 5
   * undecided (an upstream could not be asked), 0 written` for hours. Every
   * word of that is true and none of it says WHICH upstream, so it reads as the
   * resolver being broken — and `resolveLogo` had the answer in `unreachable`
   * the whole time and threw it away here. "DexScreener is refusing this
   * server" sends an operator to their egress; "CoinGecko 429" sends them to a
   * pace. One line, two different places to go.
   */
  whyUnreachable: Record<string, string>;
}

/** The longest a reason may be. These carry urls and per-second countdowns, and
 *  this line already prints once per board rebuild. */
const WHY_MAX = 90;

/** Record `"<source>: <message>"` under its source, keeping the first message. */
function noteWhy(report: SweepReport, line: string): void {
  const s = String(line ?? "").trim();
  if (!s) return;
  const i = s.indexOf(": ");
  const src = (i > 0 ? s.slice(0, i) : s).slice(0, 32);
  const why = (i > 0 ? s.slice(i + 2) : "").trim().slice(0, WHY_MAX);
  if (src && report.whyUnreachable[src] === undefined) report.whyUnreachable[src] = why;
}

/**
 * The last all-undecided line printed, so the same silence is not re-printed
 * every rebuild.
 *
 * ⚠️ A PASS THAT PRODUCED NOTHING BUT UNDECIDEDS IS THE SAME OBSERVATION AS THE
 * ONE BEFORE IT, and on a box whose sources are refusing it that is every pass,
 * for ever — the wall this whole change was reported over. It is the transition
 * rule `upstreams.js` states and `lastGood` already borrowed, applied to the one
 * state that repeats with nothing new in it. Anything the sweep actually DID —
 * a logo found, a miss decided, a row written or pinned — always prints, so the
 * recovery is never the silent one.
 */
let lastQuiet: string | null = null;

/**
 * Resolve logos for tokens that have none. Awaited by the tests; called
 * FIRE-AND-FORGET by the board pipeline (see backfillLogos below).
 *
 * Candidates are taken in the ORDER GIVEN and the cap bites at MAX_PER_SWEEP,
 * so the order is a decision, not a detail: the board pipeline sorts featured
 * rows first and then by 24h volume before calling this.
 */
export async function sweepLogos(
  candidates: { chain: string; address: string }[],
  deps: FillDeps = {},
): Promise<SweepReport> {
  const resolve = deps.resolve ?? ((c: string, a: string) => resolveLogo(c, a));
  const now = deps.now ?? Date.now;
  const report: SweepReport = { looked: 0, found: 0, missing: 0, undecided: 0, persisted: 0, pinned: 0, bySource: {}, whyUnreachable: {} };

  for (const t of candidates) {
    if (report.looked >= MAX_PER_SWEEP) break;
    if (!shouldLookUp(t.chain, t.address, now())) continue; // decided since the list was built
    report.looked++;
    let r: LogoResult;
    try {
      r = await resolve(t.chain, t.address);
    } catch (e) {
      // resolveLogo does not throw, but a caller's stub or a future edit might,
      // and a sweep that dies takes every later row with it.
      r = { ok: false, url: null, source: null, tried: [], unreachable: [String((e as Error)?.message ?? e)] };
    }

    if (r.url) {
      mem.set(key(t.chain, t.address), { url: r.url, at: now(), kind: "found" });
      report.found++;
      report.bySource[r.source ?? "?"] = (report.bySource[r.source ?? "?"] ?? 0) + 1;
      if (deps.persist) {
        try {
          if (await deps.persist(t.chain, t.address, r.url)) report.persisted++;
        } catch {
          /* permanence is best-effort; the logo is already in memory */
        }
      }
      // ⚠️ AND THEN OFF THE GATEWAY ALTOGETHER. Persisting a gateway url makes
      // the ANSWER permanent and leaves the DELIVERY a dice roll — the same CID
      // flipped ✓/✗ across four deploys with no code change. Pinning is what
      // makes it a file on our own disk. AFTER the persist, never instead of
      // it: the pin's compare-and-set requires the row to already hold the url
      // it is moving off.
      if (deps.pin) {
        try {
          const pinned = await deps.pin(t.chain, t.address, r.url);
          if (pinned) {
            report.pinned++;
            // The in-process copy moves too, or this board render keeps handing
            // out the gateway url the store no longer holds.
            mem.set(key(t.chain, t.address), { url: pinned, at: now(), kind: "found" });
          }
        } catch {
          /* a pin that cannot be made leaves a url that already loaded */
        }
      }
      continue;
    }
    // ⚠️ THE ONE LINE THIS FILE IS ABOUT. `ok` is what separates "every source
    // answered and this project has no artwork" from "an upstream refused".
    mem.set(key(t.chain, t.address), { url: null, at: now(), kind: r.ok ? "miss" : "undecided" });
    if (r.ok) report.missing++;
    else {
      report.undecided++;
      // The reasons are `"<source>: <message>"`. Keyed by SOURCE and keeping the
      // FIRST message: the rest carry a per-row url and a per-second countdown,
      // so the raw strings never repeat and a tally of them is a wall rather
      // than an answer.
      for (const line of r.unreachable) noteWhy(report, line);
    }
  }

  if (deps.log && report.looked > 0) {
    const src = Object.entries(report.bySource).map(([k, n]) => `${n} ${k}`).join(", ");
    // WHICH upstream, capped: three names is a diagnosis, ten is the wall again.
    const whys = Object.entries(report.whyUnreachable);
    const why = whys.length
      ? ` — could not ask: ${whys.slice(0, 3).map(([k, m]) => (m ? `${k} (${m})` : k)).join(", ")}` +
        (whys.length > 3 ? ` +${whys.length - 3} more` : "")
      : "";
    // A pass that found, decided, wrote or pinned NOTHING is news exactly once.
    // The key is the SET OF UPSTREAMS that could not be asked, so a box losing
    // a second source says so — and the empty key is a real state (undecided
    // with no reason given), not an absent one. `undecided > 0` is deliberately
    // NOT part of it: every `looked++` lands in exactly one of found/missing/
    // undecided, so a pass that did nothing with `looked > 0` is undecided by
    // arithmetic, and a mutation run confirmed the term changed no outcome. It
    // becomes load-bearing again only if a fourth counter is added below.
    const didNothing = report.found === 0 && report.missing === 0 && report.persisted === 0 && report.pinned === 0;
    const quietKey = didNothing ? Object.keys(report.whyUnreachable).sort().join(",") : null;
    if (quietKey !== null && quietKey === lastQuiet) return report;
    lastQuiet = quietKey;
    // ⚠️ THE BACKLOG, because without it the line cannot answer the question it
    // is read for. "Some tokens have no logo" has two completely different
    // causes that this line rendered identically: the resolver is failing, or
    // it is working through a queue at 8 rows a minute and simply has not
    // reached that row yet. `queued` turns the second into arithmetic an
    // operator can do — 214 left is under half an hour — instead of a fault
    // they go hunting for.
    const left = Math.max(0, (deps.queued ?? report.looked) - report.looked);
    const eta = left > 0 ? ` · ${left} still queued (~${Math.ceil(left / MAX_PER_SWEEP)} more rebuild(s))` : "";
    deps.log(
      `[logos] looked up ${report.looked}: ${report.found} found${src ? ` (${src})` : ""}` +
        `, ${report.missing} with no artwork anywhere, ${report.undecided} undecided (an upstream could not be asked)` +
        `, ${report.persisted} written to the listing store` +
        // A value nobody can read is the same as no value. "6 written" and "6
        // written, 6 pinned" are different states: the second is off the public
        // gateways for good, the first is a working url that re-rolls its dice
        // on every render.
        (report.pinned ? `, ${report.pinned} pinned to our own disk` : "") +
        why +
        eta +
        // …and say that the repeats are deliberate, or a wall going quiet reads
        // as the sweep having stopped — which is the state it exists to report.
        (quietKey !== null ? " (repeats are silent until this changes)" : "") +
        // A store that refuses every write is a sweep whose work dies with the
        // process — the logos come back on the next restart and nothing said
        // why. The count alone reads as a detail; this reads as a fault.
        (report.found > 0 && report.persisted === 0 ? " ⚠️ NONE of them could be written — they will be lost on restart" : ""),
    );
  }
  return report;
}

/**
 * Kick a sweep off behind a board render. Returns immediately, always.
 *
 * One at a time: the board rebuilds on a 60s cache and CoinGecko is paced in
 * seconds, so overlapping sweeps would multiply the upstream calls for no extra
 * coverage — and the second sweep would be working from a list the first one is
 * already halfway through.
 */
export function backfillLogos(candidates: { chain: string; address: string }[], deps: FillDeps = {}): void {
  if (running.on || candidates.length === 0) return;
  running.on = true;
  void sweepLogos(candidates, deps)
    .catch(() => {})
    .finally(() => {
      running.on = false;
    });
}

/** Test seam only — the memory is a module singleton by design (it must
 *  survive between board rebuilds), so a test that asserts on a fresh sweep has
 *  to be able to clear it. */
export function _resetLogoMemory(): void {
  mem.clear();
  running.on = false;
  // The quiet memo is module state and the suite shares one process: a test
  // that leaves it behind silences the next test's line, which reads exactly
  // like the logging being broken. Stated, never inherited.
  lastQuiet = null;
}

export const _MAX_PER_SWEEP = MAX_PER_SWEEP;
export const _MISS_TTL_MS = MISS_TTL_MS;
export const _UNDECIDED_TTL_MS = UNDECIDED_TTL_MS;
