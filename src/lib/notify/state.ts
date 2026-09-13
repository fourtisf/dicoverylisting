// Server-only: uses node:fs. Persisted announce markers so the bot never posts
// the same launch or listing twice — including across restarts and deploys.
// Same atomic write + serialized-mutation discipline as lib/store.ts.
import { promises as fs } from "node:fs";
import path from "node:path";

export interface NotifyState {
  /** Newest launch timestamp already announced (unix seconds). */
  lastLaunchTs: number;
  /** Recently announced launch addresses — guards equal/interpolated stamps. */
  launches: string[];
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "notify.json");
const KEEP = 300;

const EMPTY: NotifyState = { lastLaunchTs: 0, launches: [] };

let cache: NotifyState | null = null;
let writeChain: Promise<void> = Promise.resolve();
let tmpSeq = 0;

async function load(): Promise<NotifyState> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, "utf8")) as Partial<NotifyState>;
    cache = {
      lastLaunchTs: Number(parsed.lastLaunchTs) || 0,
      launches: Array.isArray(parsed.launches) ? parsed.launches.map(String) : [],
    };
  } catch {
    cache = { ...EMPTY };
  }
  return cache;
}

async function persist(next: NotifyState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.${tmpSeq++}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, FILE);
  cache = next;
}

/** Serialize mutations so two concurrent cron hits can't clobber each other. */
function mutate<T>(fn: (state: NotifyState) => { next: NotifyState; result: T }): Promise<T> {
  const run = writeChain.then(async () => {
    const { next, result } = fn({ ...(await load()) });
    await persist({
      lastLaunchTs: next.lastLaunchTs,
      launches: next.launches.slice(-KEEP),
    });
    return result;
  });
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export const readNotifyState = (): Promise<NotifyState> => load().then((s) => ({ ...s }));

/** Records launches as announced and advances the high-water mark. */
export const markLaunchesAnnounced = (addresses: string[], newestTs: number): Promise<void> =>
  mutate((state) => ({
    next: {
      ...state,
      lastLaunchTs: Math.max(state.lastLaunchTs, newestTs),
      launches: [...state.launches, ...addresses.map((a) => a.toLowerCase())],
    },
    result: undefined,
  }));

/** First run: adopt the current head without announcing the backlog. */
export const primeLaunchMarker = (newestTs: number): Promise<void> =>
  mutate((state) => ({
    next: { ...state, lastLaunchTs: Math.max(state.lastLaunchTs, newestTs) },
    result: undefined,
  }));

/** Test seam. */
export const __resetNotifyCache = (): void => {
  cache = null;
};
