// ONE GeckoTerminal client for the whole web app: one base, one key, one
// cooldown.
//
// WHY THIS FILE EXISTS
// A live server answered `{"why":"Couldn't read the chart just now
// (GeckoTerminal 429)."}` while a bare `curl` to GT from the same box also
// returned 429 — the IP was over its quota, which is ~30 requests a minute on
// the free tier and counted PER IP, not per process or per caller. The bot
// suite runs on that same box and that same IP.
//
// The web app was making it worse in the way this repo has already documented:
// SIX modules with their own `fetch` and their own idea of failure — the market
// pipeline, the pool resolver, the candles route, the trades feed, the token
// preview and the logo resolver. `bot/src/group/gtPairs.js` states the rule in
// its own header: "Two modules with their own fetch and their own backoff means
// one of them keeps hammering through a 429 that the other has already
// noticed." The web app had five more than that.
//
// So: a 429 seen by ANY caller silences ALL of them for the cooldown, nobody
// re-asks during it, and the key — if the operator has one — is read from the
// same env var the bot already uses.
//
// Relative imports with extensions: node:test resolves this file.

/** The API key raises the ceiling from ~30/min to the Pro tier's, and it is the
 *  ONLY real way past it. Same variable the bot reads, so one line in the
 *  server's env serves both processes. Unset — the default — nothing changes. */
const GT_KEY = String(process.env.GECKOTERMINAL_API_KEY || "").trim();

/**
 * ⚠️ A COINGECKO KEY COMES IN TWO TIERS, AND THEY ARE DIFFERENT HOSTS.
 *
 * This used to assume every key was a PRO key: pro base, `x-cg-pro-api-key`.
 * The key an operator will realistically get first is the **free Demo** one —
 * it costs nothing, and it answers on `api.coingecko.com` with
 * `x-cg-demo-api-key`. Handed to the pro branch it is simply refused, so the
 * one line that was supposed to fix a rate-limited chart would have looked like
 * it changed nothing at all. "Set GECKOTERMINAL_API_KEY" is only advice if the
 * key an operator can actually obtain is one this code accepts.
 *
 * And the Demo key is not a small win here: its ~30 calls/min are counted PER
 * KEY, not per IP. This box's whole problem is that the web app and the bot
 * suite split ONE IP's allowance — a Demo key gives the website its own.
 *
 * The tier is DISCOVERED, not demanded (`v4.js`'s rule): the two key formats
 * are indistinguishable, so a key is tried on one tier and, if that tier
 * refuses it with a 401/403, once on the other — and the answer is remembered
 * for the process. `GECKOTERMINAL_API_TIER=demo|pro` pins it and skips the
 * discovery, the same override-and-skip contract as everything else here.
 */
export type GtTier = "demo" | "pro";
const TIER_ENV = String(process.env.GECKOTERMINAL_API_TIER || "").trim().toLowerCase();
const PINNED_TIER: GtTier | null = TIER_ENV === "demo" || TIER_ENV === "pro" ? TIER_ENV : null;

export const gtBaseForTier = (tier: GtTier): string =>
  tier === "pro" ? "https://pro-api.coingecko.com/api/v3/onchain" : "https://api.coingecko.com/api/v3/onchain";

/** The base for a given key. `GECKOTERMINAL_API_BASE` pins a host and skips the
 *  choice — the same override-and-skip contract the launchpad registry uses. */
export const gtBaseFor = (key: string, override = "", tier: GtTier = "demo"): string =>
  override.trim().replace(/\/+$/, "") ||
  (key.trim() ? gtBaseForTier(tier) : "https://api.geckoterminal.com/api/v2");

export const gtHeadersFor = (key: string, tier: GtTier = "demo"): Record<string, string> => {
  const accept = { accept: "application/json;version=20230302" };
  if (!key.trim()) return accept;
  return { ...accept, [tier === "pro" ? "x-cg-pro-api-key" : "x-cg-demo-api-key"]: key.trim() };
};

const BASE_OVERRIDE = String(process.env.GECKOTERMINAL_API_BASE || "");
// The tier currently believed correct. Starts at the pin, or at `demo` — the
// free one, which is what an operator following the advice will have.
let tier: GtTier = PINNED_TIER ?? "demo";
/** Whether the OTHER tier is still worth trying once. A pinned tier is never
 *  second-guessed: an operator who said which they have is not overruled. */
let tierUnsettled = PINNED_TIER === null;

export const gtTier = (): GtTier => tier;
export const GT_BASE = gtBaseFor(GT_KEY, BASE_OVERRIDE, tier);
export const GT_HEADERS: Record<string, string> = gtHeadersFor(GT_KEY, tier);
/** Live values — GT_BASE/GT_HEADERS are captured at import for the boot line and
 *  the tests, but a request must read whatever the discovery settled on. */
const baseNow = () => gtBaseFor(GT_KEY, BASE_OVERRIDE, tier);
const headersNow = () => gtHeadersFor(GT_KEY, tier);

/** Whether a key is configured. Reported by /api/health-style checks and by the
 *  boot line — "is a key set" is the fact worth printing; WHICH key it is, is a
 *  secret, and this app's logs are not the place for one. */
export const GT_KEYED = Boolean(GT_KEY);

const num = (raw: string | undefined, dflt: number, min: number): number => {
  const s = String(raw ?? "").trim();
  // Number('') is 0 — finite and non-negative — so the blank check is the whole
  // guard, exactly as in the launchpad env reader.
  if (s === "") return dflt;
  const n = Number(s);
  return Number.isFinite(n) && n >= min ? n : dflt;
};

/** How long a 429 silences every caller. 120s matches the bot's, so there is
 *  one number to reason about across the two processes on one IP. */
const COOLDOWN_MS = num(process.env.GT_COOLDOWN_MS, 120_000, 1000);
/** A floor between two GT requests from this process — just enough that a page
 *  opening four panels at once does not arrive as one burst. */
const MIN_GAP_MS = num(process.env.GT_MIN_GAP_MS, 120, 0);

/**
 * ⚠️ THIS PROCESS'S HALF OF ONE IP'S ALLOWANCE, and the half that was missing.
 *
 * The ceiling is counted PER IP and the bot suite lives on the same box — so,
 * as CLAUDE.md puts it, "the two processes' budgets have to ADD UP TO IT". The
 * site never got its half at first: a 120ms floor is ~500 req/min, i.e. no
 * budget at all, so the bot held politely to fifteen while the site took
 * whatever it liked and both of them ate the 429. A split one side observes is
 * not a split.
 *
 * ⚠️ AND THE CEILING ITSELF WAS WRONG. Both halves were computed from ~30/min,
 * which nobody had checked. GeckoTerminal's own API page states the free figure
 * while advertising the paid one — "increase rate limits by 25X, from 10
 * calls/min to 250 calls/min". Ten. So 15 + 15 was three times the allowance,
 * and the endless "GeckoTerminal is rate limited — cooling down" on the token
 * page was not a busy neighbour: it was us, every minute, by design.
 *
 * It is a PACE, not a refusal: over budget, a request WAITS for a slot rather
 * than failing, because a chart that draws a second late beats one that does
 * not draw. Only when a slot cannot be had inside `GT_BUDGET_WAIT_MS` does it
 * give up — and it gives up the way the cooldown does, `status: 0`, which
 * every caller already reads as "could not ask" rather than "nothing there".
 *
 * `GT_MAX_RPM=0` disables it. An operator on a Pro key raises it in one line;
 * the boot line prints whatever is in force, because a budget nobody can read
 * is how this one stayed missing.
 */
const FREE_CEILING_RPM = num(process.env.GT_FREE_CEILING_RPM, 10, 1);
/** Half of the IP's allowance — the bot's client computes its half the same way
 *  from the same figure, so the two add up to the ceiling instead of tripling
 *  it. A key makes both irrelevant. */
const MAX_RPM = num(process.env.GT_MAX_RPM, Math.max(1, Math.floor(FREE_CEILING_RPM / 2)), 0);

/** This process's budget, in requests a minute. Exported because a test that
 *  writes the number down again is a second copy of it — and the copy that was
 *  written down (15, half of an unchecked ~30) is precisely what went wrong. */
export const gtBudgetRpm = (): number => MAX_RPM;
/** The whole IP's allowance, which the two processes split. */
export const gtFreeCeilingRpm = (): number => FREE_CEILING_RPM;
/** The longest a request may wait for a budget slot before answering "could not
 *  ask". Longer than a couple of seconds and a page reads as hung, which is a
 *  worse failure than a chart that retries. */
const BUDGET_WAIT_MS = num(process.env.GT_BUDGET_WAIT_MS, 3000, 0);
/** This process's budget, and how long a caller may wait for a slot in it. */
export const gtBudgetWaitMs = (): number => BUDGET_WAIT_MS;
const TIMEOUT_MS = 9000;

// Next can hold more than one instance of a module; a per-instance cooldown
// would let one instance hammer through a 429 the other already saw, which is
// the exact failure this file exists to prevent.
const g = globalThis as { __dexvraGt?: { until: number; nextAt: number; chain: Promise<void>; sent: number[] } };
const state = g.__dexvraGt ?? (g.__dexvraGt = { until: 0, nextAt: 0, chain: Promise.resolve(), sent: [] });

export const gtInCooldown = (at = Date.now()): boolean => at < state.until;
export const gtCooldownLeftMs = (at = Date.now()): number => Math.max(0, state.until - at);

/** Arm the shared cooldown. Exported so a caller that learns about a 429 by
 *  another route can silence everyone too. */
export function gtArmCooldown(ms = COOLDOWN_MS, at = Date.now()): void {
  const until = at + Math.max(1000, ms);
  if (until > state.until) state.until = until;
}

/** Test seam — the cooldown is process-wide by design. */
export function _gtReset(): void {
  state.until = 0;
  state.nextAt = 0;
  state.sent.length = 0;
}

/** How many of this minute's budget slots are already spent. Exported so a test
 *  — and `/api/gt-status` if it ever wants it — can read the split rather than
 *  infer it. */
export function gtSpentThisMinute(at = Date.now()): number {
  const cut = at - 60_000;
  while (state.sent.length && state.sent[0] <= cut) state.sent.shift();
  return state.sent.length;
}

/**
 * The line an operator greps for to answer "which GeckoTerminal tier is this
 * box on?" — the single thing most likely to make a busy deployment look
 * broken, because from outside "the chart is empty" looks identical whether the
 * ceiling is 30 requests a minute or the Pro tier's. The trade bot prints the
 * same kind of line for its RPC (`rpc PUBLIC default (rate-limited)`).
 *
 * ⚠️ CALLED FROM instrumentation.ts, NOT FROM MODULE SCOPE. It used to print on
 * import, which in a Next production server means "whenever the first request
 * happens to reach a route that uses GT" — so an operator who restarted and
 * immediately grepped the log got NOTHING, which reads exactly like a build
 * that was never deployed. A boot line that is not printed at boot is worse
 * than no boot line.
 *
 * The KEY is never printed: it would land in pm2's log. The base carries none.
 */
export function gtBanner(): void {
  console.log(
    `[gt] ${
      GT_KEYED
        ? `API key set · ${PINNED_TIER ? `${PINNED_TIER.toUpperCase()} tier (pinned)` : `trying the ${tier.toUpperCase()} tier first, the other on a 401/403`} — the allowance is counted PER KEY, not per IP`
        : `PUBLIC free tier (~${FREE_CEILING_RPM} req/min per IP, shared with the bot suite on this box) — set GECKOTERMINAL_API_KEY to raise it (a free CoinGecko Demo key works)`
    } · budget ${MAX_RPM > 0 ? `${MAX_RPM}/min from THIS process` : "OFF (GT_MAX_RPM=0)"} · base ${baseNow()}`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serialise the gap so concurrent callers space out instead of all firing at
 *  once (the same shape as the CoinGecko pacer in tokenLogo). */
function slot(waitMs: number): Promise<boolean> {
  const wait = state.chain.then(async () => {
    const now = Date.now();
    const delay = Math.max(0, state.nextAt - now);
    if (delay) await sleep(delay);
    state.nextAt = Math.max(now, state.nextAt) + MIN_GAP_MS;
    if (MAX_RPM <= 0) return true;
    // A ROLLING window, not a per-minute bucket: a bucket lets 15 requests go
    // at :59 and 15 more at :00, which is the burst the ceiling actually
    // punishes.
    const giveUpAt = Date.now() + waitMs;
    for (;;) {
      const at = Date.now();
      if (gtSpentThisMinute(at) < MAX_RPM) {
        // Counted when the slot is TAKEN, not when the response lands: a
        // request that is then skipped by the cooldown re-check below has still
        // reserved its place. Over-counting spends a little less than the
        // allowance; under-counting spends more than it, and that is the 429.
        state.sent.push(at);
        return true;
      }
      if (at >= giveUpAt) return false;
      // Sleep until the oldest request falls out of the window — never a fixed
      // poll, which would spin for a whole minute on a saturated budget.
      await sleep(Math.min(giveUpAt - at, Math.max(25, state.sent[0] + 60_000 - at)));
    }
  });
  state.chain = wait.then(() => {}).catch(() => {});
  return wait;
}

export interface GtResult<T = unknown> {
  ok: boolean;
  /** HTTP status, or 0 when no request was made (cooldown) or none arrived. */
  status: number;
  /** Why it failed, in words — never dropped. `null` on success. */
  reason: string | null;
  body: T | null;
}

/**
 * One GET against GeckoTerminal.
 *
 * Returns rather than throws, so every caller has to look at `ok` — and can
 * tell a 404 (an answer about the token) from a 429 (a fact about our quota)
 * from a dead socket (a fact about the box).
 *
 *  • WHILE THE COOLDOWN IS ARMED NO REQUEST IS MADE. It answers
 *    `status: 0, reason: "rate limited — cooling down for Ns"`, which every
 *    caller must treat as "could not ask", never as "nothing there".
 *  • A 429 ARMS IT, honouring `Retry-After` when GT sends one.
 *  • A 5xx OR A TIMEOUT DOES NOT. Those are per-request failures and say
 *    nothing about the quota; arming a process-wide cooldown for one slow pool
 *    would take every chart on the site down for two minutes. 429 is the only
 *    status that means "all of you, stop" — the bot's client draws the same
 *    line for the same reason.
 */
export interface GtOpts {
  /**
   * ⚠️ HOW LONG THIS CALLER MAY HOLD THE SHARED QUEUE WAITING FOR A BUDGET SLOT.
   * Defaults to `GT_BUDGET_WAIT_MS`; `0` means "take a free slot, never queue
   * for one".
   *
   * `slot()` is serialised process-wide, so the wait is not paid by the waiter
   * alone — it is paid by everything behind it. Measured on a box with the
   * shipped free budget (10/min for the IP, 5/min for this process): one board
   * refresh is ~19 chunks, so ~14 of them cannot have a slot and each held that
   * one queue for the full three seconds. Forty seconds of the site's GT
   * pipeline, every cycle, spent waiting for slots that were never coming —
   * with a token page's chart request stuck behind all of it.
   *
   * So a caller that HAS a second source does not queue: it takes a slot if one
   * is free and goes to DexScreener if not, which is what it would have done
   * three seconds later anyway. A caller with no second source still waits,
   * because for it the wait is the difference between data and none.
   */
  waitMs?: number;
}

export async function gtGet<T = unknown>(path: string, params?: Record<string, string | number>, opts?: GtOpts): Promise<GtResult<T>> {
  if (gtInCooldown())
    return { ok: false, status: 0, reason: `rate limited — cooling down for ${Math.ceil(gtCooldownLeftMs() / 1000)}s`, body: null };

  const qs = params ? new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : "";
  const url = `${baseNow()}${path}${qs ? `?${qs}` : ""}`;
  const waitMs = Number.isFinite(opts?.waitMs) ? Math.max(0, opts!.waitMs!) : BUDGET_WAIT_MS;
  if (!(await slot(waitMs)))
    return {
      ok: false,
      status: 0,
      // Named as OURS, not as GeckoTerminal's — this is our own budget holding
      // the request back, and reporting it as an upstream failure would send an
      // operator to check a service that is perfectly healthy.
      reason: `over this process's GeckoTerminal budget (${MAX_RPM}/min, shared with the bot suite on this IP) — raise GT_MAX_RPM or set GECKOTERMINAL_API_KEY`,
      body: null,
    };
  // Re-checked AFTER the gap: a request that waited its turn may have been
  // overtaken by a 429 armed by whatever went out ahead of it, and firing it
  // anyway is how a cooldown gets extended.
  if (gtInCooldown())
    return { ok: false, status: 0, reason: `rate limited — cooling down for ${Math.ceil(gtCooldownLeftMs() / 1000)}s`, body: null };

  try {
    const res = await fetch(url, { headers: headersNow(), signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    // ⚠️ THE KEY WAS REFUSED — TRY THE OTHER TIER ONCE, THEN REMEMBER.
    //
    // A free Demo key on the Pro host and a Pro key on the Demo host both come
    // back 401/403, and from the panel that is indistinguishable from "the key
    // is wrong". Since the two key formats cannot be told apart, the honest
    // move is to ask the other host rather than to demand the operator know
    // which they hold — `v4.js` discovers its PoolManager for the same reason.
    // Only ONCE, and only while unsettled: a key that both hosts refuse really
    // is wrong, and retrying it for ever would double every request.
    if (GT_KEY && tierUnsettled && (res.status === 401 || res.status === 403)) {
      void res.body?.cancel().catch(() => {});
      tier = tier === "demo" ? "pro" : "demo";
      tierUnsettled = false;
      const retried = await fetch(`${baseNow()}${path}${qs ? `?${qs}` : ""}`, {
        headers: headersNow(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
      if (retried.ok) {
        console.log(`[gt] API key accepted on the ${tier.toUpperCase()} tier — set GECKOTERMINAL_API_TIER=${tier} to skip this probe`);
        return { ok: true, status: retried.status, reason: null, body: (await retried.json()) as T };
      }
      void retried.body?.cancel().catch(() => {});
      return {
        ok: false,
        status: retried.status,
        reason: `GeckoTerminal refused the API key on both tiers (${res.status}/${retried.status}) — check GECKOTERMINAL_API_KEY`,
        body: null,
      };
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after"));
      gtArmCooldown(Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 10 * 60_000) : COOLDOWN_MS);
      void res.body?.cancel().catch(() => {});
      return { ok: false, status: 429, reason: "GeckoTerminal 429 (rate limited)", body: null };
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      // ⚠️ A REFUSED KEY IS NOT A QUOTA PROBLEM, and "GeckoTerminal 403" reads
      // exactly like one on the panel. Once the tier has settled the probe above
      // no longer runs, so without this a wrong or expired key would report the
      // same sentence as a busy minute — and an operator would go on waiting for
      // a cooldown that is never coming. Name the variable that fixes it.
      if (GT_KEY && (res.status === 401 || res.status === 403))
        return {
          ok: false,
          status: res.status,
          reason: `GeckoTerminal refused the API key (${res.status}) — check GECKOTERMINAL_API_KEY`,
          body: null,
        };
      return { ok: false, status: res.status, reason: `GeckoTerminal ${res.status}`, body: null };
    }
    return { ok: true, status: res.status, reason: null, body: (await res.json()) as T };
  } catch (err) {
    // undici hides the syscall in err.cause; `fetch failed` alone names neither
    // the host nor what went wrong.
    const e = err as { message?: string; cause?: { code?: string } };
    const code = e?.cause?.code;
    return { ok: false, status: 0, reason: `${e?.message || "request failed"}${code ? `: ${code}` : ""}`, body: null };
  }
}
