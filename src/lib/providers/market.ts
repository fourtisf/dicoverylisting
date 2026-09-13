import type { PeriodKey } from "@/lib/types";
import type { LiveMarket } from "./geckoterminal";

// LiveMarket itself lives with the indexer that defined it; this module only
// carries what a partially-filled provider needs on top of it.
export type { LiveMarket };

/** Periods whose stats a market actually covers, given its declared coverage.
 *  A provider that makes no claim covers everything. */
export const coveredPeriods = (market: LiveMarket): Set<PeriodKey> => {
  const minutes: Record<PeriodKey, number> = { "5m": 5, "1h": 60, "6h": 360, "24h": 1440 };
  const keys = Object.keys(minutes) as PeriodKey[];
  const coverage = market.statsCoverageMinutes;
  return coverage == null ? new Set(keys) : new Set(keys.filter((k) => minutes[k] <= coverage));
};
