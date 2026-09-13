// The USD price of Robinhood Chain's native quote asset (ETH) — a LADDER.
//
// "bagaimana kalo token listing di pons v2 dan bot kita tidak bisa baca price
// dan marketcap masih tba" (2026-09-09). A Pons bonding-curve token has no
// pool, so the curve contract is the only place its price lives — and this
// app reads it there perfectly well. It then multiplied by an ETH/USD reference
// that came from GECKOTERMINAL AND NOWHERE ELSE: the one metered source on this
// box, sharing a ~30 req/min per-IP ceiling with the bot suite, budgeted at
// 5/min for the site and armed with a process-wide 120s cooldown on any 429.
// `describe()` nulls priceUsd AND mcapUsd AND priceQuote whenever that read
// fails, so on a busy minute every curve token on the site — and every paid
// post the bot builds through /api/pons — read TBA over a price the chain had
// just answered. A PRICE has more than one free source; a curve's USD figure
// hung on the scarcest one.
//
//   1. Coinbase spot   — keyless, unmetered in practice; the trade bot has
//                        priced every card through it since it was written
//   2. DexScreener     — WETH's own pair on Ethereum, the site's existing reader
//   3. GeckoTerminal   — LAST, because it is the only one that costs a chart
//
// Every rung is bounded, because this sits inside /api/pons, which the bot
// reads with a 5s timeout of its own: a rung that hangs for its full network
// timeout is the same TBA by a longer road. A rung that FAILS says why, and the
// caller carries the reasons — "no USD reference" with three named refusals is
// a diagnosis; a bare null is another round of guessing.
//
// Alias-free (relative imports only) so `npm test` can drive the ladder.
import { PONS } from "../../../config/pons.ts";
import { fetchDsMarket } from "../dexscreener.ts";
import { fetchTokenPriceUsd } from "../geckoterminal.ts";

export type QuoteUsdSource = "coinbase" | "dexscreener" | "geckoterminal";

export interface QuoteUsdRead {
  usd: number | null;
  source: QuoteUsdSource | null;
  /** One line per rung that did not answer, in ladder order. Empty on success. */
  why: string[];
}

export interface QuoteUsdDeps {
  coinbase?: () => Promise<number>;
  dexscreener?: () => Promise<number>;
  geckoterminal?: () => Promise<number>;
  /** Per-rung ceiling. */
  stepMs?: number;
}

/** WETH on Ethereum mainnet — the pair DexScreener prices ETH through. */
export const WETH_MAINNET = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
export const COINBASE_SPOT = "https://api.coinbase.com/v2/prices/ETH-USD/spot";
/** Each rung's ceiling. Three rungs at this fit inside the bot's 5s read of
 *  /api/pons with the chain reads running beside them. */
export const STEP_MS = 3000;

async function coinbaseSpot(): Promise<number> {
  const res = await fetch(COINBASE_SPOT, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(STEP_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Coinbase ${res.status}`);
  const j = (await res.json()) as { data?: { amount?: string } };
  const p = Number(j?.data?.amount);
  if (!(p > 0)) throw new Error("Coinbase: no amount");
  return p;
}

async function dexscreenerWeth(): Promise<number> {
  const m = await fetchDsMarket("ethereum", [WETH_MAINNET]);
  const px = m.get(WETH_MAINNET.toLowerCase())?.priceUsd;
  if (!(typeof px === "number" && px > 0)) throw new Error("DexScreener: no WETH price");
  return px;
}

const geckoTerminal = (): Promise<number> =>
  fetchTokenPriceUsd(PONS.nativeUsdRef.network, PONS.nativeUsdRef.address);

/** Race a rung against its ceiling, KEEPING the reason: `within()` in lib/cache
 *  absorbs a rejection, and a rung's own sentence is the whole diagnosis here.
 *  ⚠️ Not `unref`'d — a request is waiting on it. */
function bounded(fn: () => Promise<number>, ms: number): Promise<{ ok: true; value: number } | { ok: false; why: string }> {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false, why: `no answer inside ${ms}ms` });
    }, ms);
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve(value > 0 ? { ok: true, value } : { ok: false, why: `answered ${String(value)}` });
        },
        (e: unknown) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve({ ok: false, why: e instanceof Error ? e.message : String(e) });
        },
      );
  });
}

/** The first rung that answers, and every refusal above it. Never throws. */
export async function readNativeUsd(deps: QuoteUsdDeps = {}): Promise<QuoteUsdRead> {
  const stepMs = deps.stepMs ?? STEP_MS;
  const rungs: [QuoteUsdSource, () => Promise<number>][] = [
    ["coinbase", deps.coinbase ?? coinbaseSpot],
    ["dexscreener", deps.dexscreener ?? dexscreenerWeth],
    ["geckoterminal", deps.geckoterminal ?? geckoTerminal],
  ];
  const why: string[] = [];
  for (const [source, fn] of rungs) {
    const r = await bounded(fn, stepMs);
    if (r.ok) return { usd: r.value, source, why };
    why.push(`${source}: ${r.why}`);
  }
  return { usd: null, source: null, why };
}
