// Pons v2 provider — the app's only source of market data for Robinhood Chain.
//
// Pons publishes no HTTP API: the launch factory and the per-launch bonding
// curves are the source of truth, so everything here is read straight off the
// chain over JSON-RPC (see config/pons.ts for the deployment constants).
import { CHAINS } from "@/config/chains";
import { rpcSelfLimited } from "@/lib/evm/rpc";
import { PONS } from "@/config/pons";
import type { ScanFlag } from "@/lib/types";
import type { LiveMarket } from "../market";
import { readLaunchSnapshots } from "./contracts";
import { fetchPonsMarket } from "./market";

export { fetchPonsMarket, fetchPonsLaunch, fetchPonsTrades, nativeUsd, nativeUsdX, unpricedByUs, __resetNativeUsd } from "./market";
export type { PonsLaunchInfo } from "./market";
export { fetchPonsLaunchFeed, readPonsLaunchEvents } from "./launches";
export type { PonsLaunchEvent, PonsLaunchFeed, PonsLaunchFeedItem } from "./launches";

/** True when this chain's market data comes from the Pons launchpad. */
export const isPonsChain = (chain: string): boolean => CHAINS[chain]?.launchpad === "pons-v2";

/** Chains this provider covers, in Dexvra's chain ids. */
export const ponsChains = (): string[] =>
  Object.values(CHAINS).filter((c) => c.launchpad === "pons-v2").map((c) => c.id);

// ── Last-resort market source ─────────────────────────────────────────────
// The board calls this on every cycle, so it may never reject and may never
// outrun its own deadline: a chain this box cannot reach must cost one bounded
// attempt and then nothing. A failure (or a slow answer) parks the reader for
// COOLDOWN_MS, the way gt.ts parks GeckoTerminal after a 429.
const DEADLINE_MS = 4_000;
const COOLDOWN_MS = 5 * 60_000;
let coolingUntil = 0;

/** Null means "no answer" — never an error, never a hang. */
export async function fetchPonsFallbackMarket(
  chain: string,
  addresses: string[],
): Promise<Map<string, LiveMarket> | null> {
  if (!isPonsChain(chain) || addresses.length === 0 || Date.now() < coolingUntil) return null;

  const park = (why: string) => {
    coolingUntil = Date.now() + COOLDOWN_MS;
    console.warn(
      `[market] ${chain}: on-chain launchpad read ${why} — parking it for ${COOLDOWN_MS / 60_000}m ` +
        `(this is the bottom source; the indexer and the launchpad API are unaffected)`,
    );
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), DEADLINE_MS);
    });
    const result = await Promise.race([fetchPonsMarket(addresses), deadline]);
    if (result === null) park(`did not answer inside ${DEADLINE_MS}ms`);
    return result;
  } catch (err) {
    const why = err instanceof Error ? err.message : "";
    // ⚠️ OUR OWN PACING MAY NOT BECOME A FIVE-MINUTE OUTAGE. The RPC client
    // benches a refusing host for one to ten seconds and answers the calls
    // behind it without a request; that throw reaching here used to park the
    // whole on-chain reader for five minutes — a rate limit escalated into an
    // outage by the code that noticed it, which is the ladder's own scar one
    // transport down. The park exists for a chain this box cannot reach.
    if (rpcSelfLimited(why)) {
      console.warn(`[market] ${chain}: on-chain launchpad read is rate limited — ${why}; asking again next cycle`);
      return null;
    }
    park(why ? `failed — ${why}` : "failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam: forget the cooldown. */
export const __resetPonsCooldown = (): void => {
  coolingUntil = 0;
};

// ── Scanner ───────────────────────────────────────────────────────────────
// A Pons launch is unusually legible: the supply is fixed and minted entirely
// to the curve, the deployer holds no privileges over the token, and a
// graduated position is locked with no withdrawal path in the locker. These
// are contract facts, not heuristics — but the verdict still says DYOR.
export interface PonsSafety {
  fps: { flag: ScanFlag; penalty: number }[];
  chain: string;
  source: string;
  name: string | null;
  symbol: string | null;
}

const info = (label: string, value: string): { flag: ScanFlag; penalty: number } => ({
  flag: { label, value, status: "ok" },
  penalty: 0,
});

export async function scanPonsToken(address: string): Promise<PonsSafety | null> {
  const snapshots = await readLaunchSnapshots([address]);
  const snapshot = snapshots.get(address.toLowerCase());
  if (!snapshot) return null;

  const { launch, curve, meta } = snapshot;
  const taxPct = launch.creatorTaxBps / 100;
  const onCurve = launch.phase === "NotGraduated";

  const fps: { flag: ScanFlag; penalty: number }[] = [
    info("Launchpad", "Pons v2"),
    info("Mintable", "No"),
    info("Owner privileges", "None"),
    {
      flag: {
        label: "Liquidity",
        value: launch.phase === "PoolCreated" ? "Locked permanently" : onCurve ? "Bonding curve" : "Migrating",
        status: launch.phase === "PoolCreated" ? "ok" : onCurve ? "ok" : "warn",
      },
      penalty: launch.phase === "PoolCreated" || onCurve ? 0 : 8,
    },
    {
      flag: {
        label: "Creator tax",
        value: `${taxPct.toFixed(1)}%`,
        status: taxPct < 5 ? "ok" : taxPct < 10 ? "warn" : "bad",
      },
      penalty: taxPct < 5 ? 0 : Math.min(30, Math.round(taxPct * 2)),
    },
    {
      flag: { label: "Graduation", value: launch.phase, status: launch.phase === "Rescued" ? "warn" : "ok" },
      penalty: launch.phase === "Rescued" ? 10 : 0,
    },
    info("Buyback vault", launch.buybackEnabled ? "Enabled" : "Disabled"),
  ];

  if (onCurve && curve) {
    const threshold = launch.graduationThreshold;
    const progress = threshold > 0n ? Number((curve.realQuoteReserve * 10000n) / threshold) / 100 : 0;
    fps.push(info("Curve progress", `${Math.min(100, progress).toFixed(1)}%`));
  }

  return {
    fps,
    chain: PONS.chain,
    source: "Pons v2 (on-chain)",
    name: meta?.name || null,
    symbol: meta?.symbol || null,
  };
}
