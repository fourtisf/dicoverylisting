// Rolling block-scan window, shared by the trade history and the launch feed.
//
// Both read logs off a chain nobody indexes, so both face the same problem: a
// full backfill is far too expensive to run inside a page request. The answer
// is the same in both cases — hold a scanned range, and on each refresh spend a
// bounded number of requests first catching up to the head (so the newest
// events are always there) and then reaching further back.
//
// Planning is pure and cursors only move over ranges that actually came back,
// so a rejected request is simply re-planned rather than leaving a hole.

/** Inclusive range of blocks already scanned; empty while `head < tail`. */
export interface ScannedRange {
  head: number;
  tail: number;
}

export interface ScanRequest {
  from: number;
  to: number;
  direction: "forward" | "backward";
}

/** An empty range positioned so the first plan asks for the newest chunk. */
export function initialRange(head: number, oldestWanted: number, chunk: number): ScannedRange {
  const start = Math.max(oldestWanted, head - chunk + 1);
  return { head: start - 1, tail: start };
}

export function planScan(
  state: ScannedRange,
  head: number,
  oldestWanted: number,
  chunk: number,
  budget: number,
): ScanRequest[] {
  const plan: ScanRequest[] = [];
  let remaining = budget;

  let cursor = state.head;
  while (remaining > 0 && cursor < head) {
    const to = Math.min(cursor + chunk, head);
    plan.push({ from: cursor + 1, to, direction: "forward" });
    cursor = to;
    remaining--;
  }

  let tail = state.tail;
  while (remaining > 0 && tail > oldestWanted) {
    const to = tail - 1;
    const from = Math.max(oldestWanted, to - chunk + 1);
    plan.push({ from, to, direction: "backward" });
    tail = from;
    remaining--;
  }

  return plan;
}

/** Advances the range over the longest contiguous run of successes each way. */
export function commitScan(state: ScannedRange, outcomes: { range: ScanRequest; ok: boolean }[]): void {
  const forward = outcomes
    .filter((o) => o.range.direction === "forward")
    .sort((a, b) => a.range.from - b.range.from);
  for (const entry of forward) {
    if (!entry.ok || entry.range.from !== state.head + 1) break;
    state.head = entry.range.to;
  }

  const backward = outcomes
    .filter((o) => o.range.direction === "backward")
    .sort((a, b) => b.range.to - a.range.to);
  for (const entry of backward) {
    if (!entry.ok || entry.range.to !== state.tail - 1) break;
    state.tail = entry.range.from;
  }
}

export const coveredBlocks = (state: ScannedRange): number => Math.max(0, state.head - state.tail + 1);
