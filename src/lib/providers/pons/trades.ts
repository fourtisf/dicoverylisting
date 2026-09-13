// Trade history for a Pons launch, read from its bonding curve's CurveBuy /
// CurveSell logs.
//
// There is no indexer to ask, so we keep a rolling in-process window per curve
// and extend it incrementally: each refresh spends a small, bounded number of
// eth_getLogs calls catching up to the chain head and reaching further back,
// until the configured history window is covered. A cold start therefore
// serves partial-but-real stats within seconds instead of blocking a page load
// on a full backfill — callers get `coverageMinutes` and must not present a
// period longer than that as complete.
import { PONS } from "@/config/pons";
import { decodeLogData, topic0, topicToAddress } from "@/lib/evm/abi";
import { getLogs, rpcBatch, type RpcLog } from "@/lib/evm/rpc";
import { blockSeconds, blockTag, chainHead, timestampOf, __resetChainCache } from "./chain";
import {
  commitScan,
  coveredBlocks,
  initialRange,
  planScan,
  type ScanRequest,
  type ScannedRange,
} from "./window";

const CURVE_BUY = topic0("CurveBuy(address,address,uint256,uint256,uint256,uint256)");
const CURVE_SELL = topic0("CurveSell(address,address,uint256,uint256,uint256,uint256)");

export interface PonsTrade {
  ts: number; // unix seconds (interpolated from the chain head — see blockSeconds)
  block: number;
  logIndex: number;
  kind: "buy" | "sell";
  /** Quote amount on the AMM leg, i.e. net of fee and creator tax. */
  quote: bigint;
  tokens: bigint;
  trader: string;
  tx: string;
}

export interface CurveHistory {
  trades: PonsTrade[]; // ascending by (block, logIndex)
  coverageMinutes: number;
}

interface HistoryState extends ScannedRange {
  trades: PonsTrade[];
}

// Survive dev-mode module reloads, like lib/cache.ts.
const g = globalThis as { __ponsHistories?: Map<string, HistoryState> };
const histories: Map<string, HistoryState> = (g.__ponsHistories ??= new Map());

const decodeTrade = (log: RpcLog, tsOf: (block: number) => number): PonsTrade | null => {
  const kind = log.topics[0] === CURVE_BUY ? "buy" : log.topics[0] === CURVE_SELL ? "sell" : null;
  if (!kind) return null;
  let values: unknown[];
  try {
    values = decodeLogData(["uint256", "uint256", "uint256", "uint256"], log.data);
  } catch {
    return null;
  }
  const [a, b, fee, tax] = values as [bigint, bigint, bigint, bigint];
  // CurveBuy(quoteIn, tokensOut, fee, tax) — the trader's spend carries the
  // fee, so the AMM leg is what is left after it.
  // CurveSell(tokensIn, quoteOut, fee, tax) — the payout is already net, so
  // the AMM leg is the payout plus what was withheld.
  const quote = kind === "buy" ? a - fee - tax : b + fee + tax;
  const tokens = kind === "buy" ? b : a;
  if (quote <= 0n || tokens <= 0n) return null;
  const block = Number(BigInt(log.blockNumber));
  return {
    ts: tsOf(block),
    block,
    logIndex: Number(BigInt(log.logIndex ?? "0x0")),
    kind,
    quote,
    tokens,
    trader: log.topics[1] ? topicToAddress(log.topics[1]) : "",
    tx: log.transactionHash ?? "",
  };
};

type RangeRequest = ScanRequest & { curve: string };

/** Plans this refresh's log requests for one curve, creating its window on
 *  first sight. */
function planRanges(curve: string, head: number, oldestWanted: number): RangeRequest[] {
  let state = histories.get(curve);
  if (!state) {
    state = { trades: [], ...initialRange(head, oldestWanted, PONS.logChunkBlocks) };
    histories.set(curve, state);
  }
  return planScan(state, head, oldestWanted, PONS.logChunkBlocks, PONS.logChunksPerRefresh).map(
    (range) => ({ ...range, curve }),
  );
}

function merge(state: HistoryState, incoming: PonsTrade[], cutoffTs: number): void {
  if (incoming.length) {
    const seen = new Set(state.trades.map((t) => `${t.block}:${t.logIndex}`));
    for (const trade of incoming) {
      const key = `${trade.block}:${trade.logIndex}`;
      if (!seen.has(key)) {
        seen.add(key);
        state.trades.push(trade);
      }
    }
    state.trades.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
  }
  const kept = state.trades.filter((t) => t.ts >= cutoffTs);
  if (kept.length !== state.trades.length) state.trades = kept;
}

/**
 * Extends the rolling history of every given curve and returns it. Failures
 * are per-curve: a rejected range leaves that curve's existing window intact.
 */
export async function readCurveHistories(curves: string[]): Promise<Map<string, CurveHistory>> {
  const out = new Map<string, CurveHistory>();
  const unique = [...new Set(curves.map((c) => c.toLowerCase()))];
  if (unique.length === 0) return out;

  const head = await chainHead();
  const seconds = await blockSeconds(head);
  const tsOf = timestampOf(head, seconds);
  const windowBlocks = Math.ceil((PONS.historyMinutes * 60) / Math.max(seconds, 0.01));
  const oldestWanted = Math.max(0, head.number - windowBlocks);
  const cutoffTs = head.ts - PONS.historyMinutes * 60;

  const plan = unique.flatMap((curve) => planRanges(curve, head.number, oldestWanted));
  const results = await rpcBatch(
    PONS.rpcUrls,
    plan.map((range) =>
      getLogs({
        address: range.curve,
        topics: [[CURVE_BUY, CURVE_SELL]],
        fromBlock: blockTag(range.from),
        toBlock: blockTag(range.to),
      }),
    ),
    PONS.rpcTimeoutMs,
  );

  const byCurve = new Map<string, PonsTrade[]>();
  const outcomes = new Map<string, { range: RangeRequest; ok: boolean }[]>();
  plan.forEach((range, i) => {
    const outcome = results[i];
    const good = outcome?.ok === true && Array.isArray(outcome.value);
    const entries = outcomes.get(range.curve) ?? [];
    entries.push({ range, ok: good });
    outcomes.set(range.curve, entries);
    if (!good) return;
    const trades = (outcome.value as RpcLog[])
      .map((log) => decodeTrade(log, tsOf))
      .filter((t): t is PonsTrade => t !== null);
    const bucket = byCurve.get(range.curve) ?? [];
    bucket.push(...trades);
    byCurve.set(range.curve, bucket);
  });

  for (const curve of unique) {
    const state = histories.get(curve);
    if (!state) continue;
    commitScan(state, outcomes.get(curve) ?? []);
    merge(state, byCurve.get(curve) ?? [], cutoffTs);
    out.set(curve, {
      trades: state.trades,
      coverageMinutes: Math.min(PONS.historyMinutes, Math.floor((coveredBlocks(state) * seconds) / 60)),
    });
  }
  return out;
}

/** Test seam: forget every rolling window (used by the offline unit tests). */
export const __resetHistories = (): void => {
  histories.clear();
  __resetChainCache();
};
