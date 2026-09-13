// Editable content for the homepage promo carousel's "showcase" — the
// "Pumped on Dexvra" highlight (and the hero blip tag derived from it). Shipped
// hardcoded ($WARCHEST 412×); now admin-editable so the featured example is a
// real token. Persisted as data/promo.json with a durable Mongo mirror, exactly
// like the listings + banners stores.
import { promises as fs } from "node:fs";
import path from "node:path";
import { kvGet, kvSet, mongoConfigured } from "./mongo";

const MIRROR_KEY = "promo";
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "promo.json");

export interface PromoConfig {
  emoji: string; // coin glyph, e.g. "⚔️"
  symbol: string; // "$WARCHEST"
  multiplier: string; // "412×"
  mcap: string; // launch/entry market cap, "$310K"
  ath: string; // all-time-high market cap, "$128.4M"
  chain: string; // "Solana"
}

export const PROMO_DEFAULTS: PromoConfig = {
  emoji: "⚔️",
  symbol: "$WARCHEST",
  multiplier: "412×",
  mcap: "$310K",
  ath: "$128.4M",
  chain: "Solana",
};

let cache: PromoConfig | null = null;
let writeChain: Promise<void> = Promise.resolve();
let tmpSeq = 0;

export async function getPromo(): Promise<PromoConfig> {
  if (cache) return cache;
  let result: PromoConfig;
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, "utf8"));
    result = { ...PROMO_DEFAULTS, ...parsed };
  } catch {
    // File missing (fresh container) → restore from the durable Mongo mirror.
    let mirrored: Partial<PromoConfig> | undefined;
    if (mongoConfigured()) {
      try {
        mirrored = await kvGet<Partial<PromoConfig>>(MIRROR_KEY);
      } catch {
        /* fall through to defaults */
      }
    }
    result = { ...PROMO_DEFAULTS, ...(mirrored || {}) };
  }
  cache = result;
  return result;
}

const clean = (v: unknown, max: number, fallback: string): string => {
  const s = String(v ?? "").replace(/[\r\n\t]/g, " ").trim().slice(0, max);
  return s || fallback;
};

export async function setPromo(patch: Partial<PromoConfig>): Promise<PromoConfig> {
  const run = writeChain.then(async () => {
    const cur = await getPromo();
    const next: PromoConfig = {
      emoji: clean(patch.emoji ?? cur.emoji, 8, PROMO_DEFAULTS.emoji),
      symbol: clean(patch.symbol ?? cur.symbol, 24, PROMO_DEFAULTS.symbol),
      multiplier: clean(patch.multiplier ?? cur.multiplier, 12, PROMO_DEFAULTS.multiplier),
      mcap: clean(patch.mcap ?? cur.mcap, 16, PROMO_DEFAULTS.mcap),
      ath: clean(patch.ath ?? cur.ath, 16, PROMO_DEFAULTS.ath),
      chain: clean(patch.chain ?? cur.chain, 24, PROMO_DEFAULTS.chain),
    };
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.${tmpSeq++}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
    await fs.rename(tmp, FILE);
    cache = next;
    if (mongoConfigured()) void kvSet(MIRROR_KEY, next);
    return next;
  });
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
