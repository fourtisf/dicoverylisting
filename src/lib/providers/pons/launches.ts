// The Pons launch feed — every token the factory has ever minted, newest first.
//
// `TokenLaunched` is emitted once per launch by PonsV2LaunchFactory, so one log
// stream on one address is the whole discovery surface for Robinhood Chain.
// The window fills incrementally (see window.ts): the newest chunk is scanned
// first, so a fresh process shows today's launches immediately and reaches
// further back over the following refreshes.
import { PONS, ponsExplorerUrl, ponsTokenUrl, type GraduationPhase } from "@/config/pons";
import { decodeLogData, topic0, topicToAddress } from "@/lib/evm/abi";
import { getLogs, rpcBatch, type RpcLog } from "@/lib/evm/rpc";
import { blockSeconds, blockTag, chainHead, timestampOf } from "./chain";
import { readLaunchSnapshots, type LaunchSnapshot } from "./contracts";
import { nativeUsd, summarise } from "./market";
import {
  commitScan,
  coveredBlocks,
  initialRange,
  planScan,
  type ScanRequest,
  type ScannedRange,
} from "./window";

const TOKEN_LAUNCHED = topic0("TokenLaunched(address,address,address,address,uint256,uint256)");

export interface PonsLaunchEvent {
  token: string;
  curve: string;
  deployer: string;
  pairToken: string;
  launchConfigId: number;
  graduationThreshold: bigint;
  block: number;
  logIndex: number;
  ts: number;
  tx: string;
}

export interface PonsLaunchFeedItem {
  chain: string;
  address: string;
  curve: string;
  deployer: string;
  symbol: string | null;
  name: string | null;
  logo: string | null;
  launchedAt: number; // unix seconds
  ageMinutes: number;
  phase: GraduationPhase;
  graduated: boolean;
  nativeQuote: boolean;
  creatorTaxBps: number | null;
  progressPct: number | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  liquidityUsd: number | null;
  ponsUrl: string;
  explorerUrl: string;
}

export interface PonsLaunchFeed {
  items: PonsLaunchFeedItem[];
  /** How far back the scan currently reaches — the feed is complete only
   *  within this window, and grows towards `launchWindowMinutes`. */
  coverageMinutes: number;
  updatedAt: number;
}

interface FeedState extends ScannedRange {
  events: PonsLaunchEvent[]; // ascending by (block, logIndex)
}

const g = globalThis as { __ponsLaunchFeed?: FeedState };

function decodeLaunch(log: RpcLog, tsOf: (block: number) => number): PonsLaunchEvent | null {
  if (log.topics[0] !== TOKEN_LAUNCHED || log.topics.length < 4) return null;
  let values: unknown[];
  try {
    values = decodeLogData(["address", "uint256", "uint256"], log.data);
  } catch {
    return null;
  }
  const [pairToken, launchConfigId, graduationThreshold] = values as [string, bigint, bigint];
  const block = Number(BigInt(log.blockNumber));
  return {
    token: topicToAddress(log.topics[1]),
    curve: topicToAddress(log.topics[2]),
    deployer: topicToAddress(log.topics[3]),
    pairToken,
    launchConfigId: Number(launchConfigId),
    graduationThreshold,
    block,
    logIndex: Number(BigInt(log.logIndex ?? "0x0")),
    ts: tsOf(block),
    tx: log.transactionHash ?? "",
  };
}

/** Extends the factory scan and returns every launch currently in the window,
 *  newest first. Raw — no on-chain enrichment. */
export async function readPonsLaunchEvents(): Promise<{ events: PonsLaunchEvent[]; coverageMinutes: number }> {
  const head = await chainHead();
  const seconds = await blockSeconds(head);
  const tsOf = timestampOf(head, seconds);
  const windowBlocks = Math.ceil((PONS.launchWindowMinutes * 60) / Math.max(seconds, 0.01));
  const oldestWanted = Math.max(0, head.number - windowBlocks);
  const cutoffTs = head.ts - PONS.launchWindowMinutes * 60;

  const state = (g.__ponsLaunchFeed ??= {
    events: [],
    ...initialRange(head.number, oldestWanted, PONS.logChunkBlocks),
  });

  const plan = planScan(
    state,
    head.number,
    oldestWanted,
    PONS.logChunkBlocks,
    PONS.launchChunksPerRefresh,
  );

  if (plan.length > 0) {
    const results = await rpcBatch(
      PONS.rpcUrls,
      plan.map((range) =>
        getLogs({
          address: PONS.factoryV2,
          topics: [TOKEN_LAUNCHED],
          fromBlock: blockTag(range.from),
          toBlock: blockTag(range.to),
        }),
      ),
      PONS.rpcTimeoutMs,
    );

    const outcomes: { range: ScanRequest; ok: boolean }[] = [];
    // The first range the node did not answer, for the throw below: "Pons RPC
    // unavailable" alone cannot tell a rate limit from a dead socket, and this
    // feed is read by the site and the snipe alike.
    const scanWhy = (results.find((r) => r && !r.ok) as { ok: false; error: string } | undefined)?.error ?? null;
    const incoming: PonsLaunchEvent[] = [];
    plan.forEach((range, i) => {
      const outcome = results[i];
      const good = outcome?.ok === true && Array.isArray(outcome.value);
      outcomes.push({ range, ok: good });
      if (!good) return;
      for (const log of outcome.value as RpcLog[]) {
        const event = decodeLaunch(log, tsOf);
        if (event) incoming.push(event);
      }
    });

    // Every range failing means the endpoint is down, not that Pons has never
    // launched anything — say so rather than publishing an empty feed.
    if (outcomes.length > 0 && outcomes.every((o) => !o.ok) && state.events.length === 0) {
      throw new Error(`Pons RPC unavailable${scanWhy ? ` — ${scanWhy}` : ""}`);
    }

    commitScan(state, outcomes);

    if (incoming.length) {
      const seen = new Set(state.events.map((e) => `${e.block}:${e.logIndex}`));
      for (const event of incoming) {
        const key = `${event.block}:${event.logIndex}`;
        if (!seen.has(key)) {
          seen.add(key);
          state.events.push(event);
        }
      }
      state.events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    }
    state.events = state.events.filter((e) => e.ts >= cutoffTs);
  }

  return {
    events: [...state.events].reverse(),
    coverageMinutes: Math.min(
      PONS.launchWindowMinutes,
      Math.floor((coveredBlocks(state) * seconds) / 60),
    ),
  };
}

/** The launch feed, newest first, enriched with metadata, price and curve
 *  progress for the newest `limit` entries. */
export async function fetchPonsLaunchFeed(limit = PONS.launchEnrichLimit): Promise<PonsLaunchFeed> {
  const { events, coverageMinutes } = await readPonsLaunchEvents();
  const now = Math.floor(Date.now() / 1000);
  const wanted = events.slice(0, Math.max(0, Math.min(limit, PONS.launchEnrichLimit)));

  const empty = new Map<string, LaunchSnapshot>();
  const [quoteUsd, snapshots] = await Promise.all([
    nativeUsd().catch(() => null),
    wanted.length ? readLaunchSnapshots(wanted.map((e) => e.token)).catch(() => empty) : empty,
  ]);

  const items = wanted.map((event): PonsLaunchFeedItem => {
    const snapshot = snapshots.get(event.token.toLowerCase());
    const summary = snapshot ? summarise(snapshot, quoteUsd) : null;
    return {
      chain: PONS.chain,
      address: event.token,
      curve: event.curve,
      deployer: event.deployer,
      symbol: snapshot?.meta?.symbol || null,
      name: snapshot?.meta?.name || null,
      logo: snapshot?.meta?.logo ?? null,
      launchedAt: event.ts,
      ageMinutes: Math.max(0, Math.round((now - event.ts) / 60)),
      phase: snapshot?.launch.phase ?? "NotGraduated",
      graduated: (snapshot?.launch.phase ?? "NotGraduated") !== "NotGraduated",
      nativeQuote: snapshot?.launch.nativeQuote ?? event.pairToken === "0x0000000000000000000000000000000000000000",
      creatorTaxBps: snapshot?.launch.creatorTaxBps ?? null,
      progressPct: summary?.progressPct ?? null,
      priceUsd: summary?.priceUsd ?? null,
      mcapUsd: summary?.mcapUsd ?? null,
      liquidityUsd: summary?.liquidityUsd ?? null,
      ponsUrl: ponsTokenUrl(event.token),
      explorerUrl: ponsExplorerUrl(event.token),
    };
  });

  return { items, coverageMinutes, updatedAt: Date.now() };
}

/** Test seam: forget the launch window. */
export const __resetLaunchFeed = (): void => {
  delete g.__ponsLaunchFeed;
};
