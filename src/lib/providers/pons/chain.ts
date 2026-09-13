// Shared chain-head plumbing for the Pons reads.
//
// Logs carry no timestamp, so both the trade window and the launch feed date
// their events by interpolating from the head. The block time is measured once
// per process from two real headers rather than trusted from config, and the
// head itself is cached briefly so a refresh that touches several curves and
// the factory costs one header fetch, not several.
import { PONS } from "@/config/pons";
import { getBlock, rpcSend, type RpcBlockHeader } from "@/lib/evm/rpc";

export interface ChainHead {
  number: number;
  ts: number;
}

const HEAD_TTL_MS = 5_000;

let headCache: { at: number; value: ChainHead } | null = null;
let secondsPerBlock: number | null = null;

export async function chainHead(): Promise<ChainHead> {
  const now = Date.now();
  if (headCache && now - headCache.at < HEAD_TTL_MS) return headCache.value;
  const block = await rpcSend<RpcBlockHeader>(PONS.rpcUrls, getBlock("latest"), PONS.rpcTimeoutMs);
  const value = { number: Number(BigInt(block.number)), ts: Number(BigInt(block.timestamp)) };
  headCache = { at: now, value };
  return value;
}

/** Observed seconds per block, measured once per process from two headers. */
export async function blockSeconds(head: ChainHead): Promise<number> {
  if (secondsPerBlock !== null) return secondsPerBlock;
  const span = Math.min(100_000, Math.max(1, head.number - 1));
  try {
    const older = await rpcSend<RpcBlockHeader>(
      PONS.rpcUrls,
      getBlock(`0x${(head.number - span).toString(16)}`),
      PONS.rpcTimeoutMs,
    );
    const delta = head.ts - Number(BigInt(older.timestamp));
    secondsPerBlock = delta > 0 ? delta / span : PONS.blockSeconds;
  } catch {
    // ⚠️ NOT MEMOISED. This is cached because a chain's block time does not
    // move — true of a MEASUREMENT and false of the shipped default, which a
    // single refused read used to pin for the life of the process, dating
    // every trade in every history from a number nobody measured. The default
    // answers this call and the next one asks again.
    return PONS.blockSeconds;
  }
  return secondsPerBlock;
}

/** Dates a block by interpolating back from the head. */
export const timestampOf = (head: ChainHead, seconds: number) => (block: number): number =>
  Math.round(head.ts - (head.number - block) * seconds);

export const blockTag = (block: number): string => `0x${Math.max(0, Math.floor(block)).toString(16)}`;

/** Test seam: forget the measured head and block time. */
export const __resetChainCache = (): void => {
  headCache = null;
  secondsPerBlock = null;
};
