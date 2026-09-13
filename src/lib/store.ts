// Server-only: uses node:fs. Never import from a client component (the dashboard
// uses `import type` only, which is erased at compile time).
import { promises as fs } from "node:fs";
import path from "node:path";
import { SEED_ROWS, SEED_SOCIALS, type ListingRow } from "./listings";

/** Fill a seed/demo row's missing socials from the known-good map (its own
 *  values always win). Keyed by ticker. Mutates in place. */
function fillSeedSocials(r: { sym: string; website?: string; twitter?: string; telegram?: string }): void {
  const s = SEED_SOCIALS[String(r.sym).replace(/^\$/, "").toUpperCase()];
  if (!s) return;
  if (!r.website) r.website = s.website;
  if (!r.twitter) r.twitter = s.twitter;
  if (!r.telegram) r.telegram = s.telegram;
}
import { kvGet, kvSet, mongoConfigured } from "./mongo";
import { applyLostUpload, applyPinnedLogo, applyResolvedLogo, healUploadUrls } from "./logoWrite";
import { keepStatus, mergeRelist } from "./relist";

// Mongo mirror key for this store (doc _id in the `web` collection).
const MIRROR_KEY = "listings";

// Server-side listing store — the admin panel's source of truth. Persisted as a
// JSON file on disk (writable on a VPS; survives restarts and `git pull` since
// data/ is gitignored). Seeded from SEED_ROWS on first run.

export type ListingStatus = "approved" | "pending" | "rejected";

export interface StoredListing extends ListingRow {
  id: string;
  status: ListingStatus;
  createdAt: number;
  source?: "seed" | "submission" | "admin" | "bot";
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "listings.json");
// Cap the public-submission (pending) queue so a flood can't grow the store
// without bound. Oldest pending rows are evicted once the cap is hit.
const MAX_PENDING = 200;

let cache: StoredListing[] | null = null;
let writeChain: Promise<void> = Promise.resolve();
let tmpSeq = 0;
let createdSeq = 1; // monotonic stamp for FIFO ordering of new rows

function seed(): StoredListing[] {
  return SEED_ROWS.map((r, i) => {
    const row: StoredListing = {
      ...r,
      id: `seed-${i}`,
      status: "approved" as ListingStatus,
      createdAt: 0,
      source: "seed" as const,
    };
    fillSeedSocials(row); // demo tokens carry their real socials
    return row;
  });
}

/** Heal rows persisted BEFORE seed rows gained logoUrl: an existing
 *  data/listings.json wins over the in-code seeds, so older deployments kept
 *  showing emoji placeholders (and flip-flopped whenever live enrichment came
 *  and went). Merge the seed logo in by chain+address at load time. */
function healSeedLogos(rows: StoredListing[]): void {
  const seedLogo = new Map(
    SEED_ROWS.filter((r) => r.logoUrl).map((r) => [`${r.chain}:${r.address.toLowerCase()}`, r.logoUrl!]),
  );
  for (const r of rows) {
    if (!r.logoUrl) {
      const l = seedLogo.get(`${r.chain}:${String(r.address).toLowerCase()}`);
      if (l) r.logoUrl = l;
    }
    // Same reason as logos: a data/listings.json persisted before seed tokens
    // gained socials would keep them link-less on the bot's trending board.
    // Backfill missing socials on SEED rows only (real listings keep their own).
    if (r.source === "seed") fillSeedSocials(r);
  }
}

async function load(): Promise<StoredListing[]> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      cache = parsed as StoredListing[];
      healSeedLogos(cache);
      healUploadUrls(cache);
      // Backfill listedAt for real (non-seed) rows persisted before this field
      // existed, so "listed X ago" is live instead of frozen at listedMin=0.
      // True creation time is unrecoverable, so start the clock now (persisted
      // on the next mutation); seeds keep their curated demo ages.
      const now = Date.now();
      for (const r of cache) if (r.source !== "seed" && r.listedAt == null) r.listedAt = now;
      return cache;
    }
    throw new Error("corrupt store");
  } catch {
    // File missing/corrupt (e.g. fresh container after a VPS reset) → restore
    // from the durable Mongo mirror before seeding. Reads must never WRITE the
    // local file (that would race the mutation path); the next mutation persists
    // it back to disk, and Mongo already holds the durable copy.
    const mirrored = await restoreFromMirror();
    if (mirrored && mirrored.length) {
      cache = mirrored;
      healSeedLogos(cache);
      healUploadUrls(cache);
      const now = Date.now();
      for (const r of cache) if (r.source !== "seed" && r.listedAt == null) r.listedAt = now;
      return cache;
    }
    // Seed in memory only — the file is written on the first mutation.
    cache = seed();
    return cache;
  }
}

async function restoreFromMirror(): Promise<StoredListing[] | null> {
  if (!mongoConfigured()) return null;
  try {
    const rows = await kvGet<StoredListing[]>(MIRROR_KEY);
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

async function persist(rows: StoredListing[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.${tmpSeq++}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), "utf8");
  await fs.rename(tmp, FILE);
  cache = rows;
  // Durable mirror — best-effort, never blocks or fails the local write.
  if (mongoConfigured()) void kvSet(MIRROR_KEY, rows);
}

/** Serialize mutations so concurrent writes never clobber each other. */
function mutate(fn: (rows: StoredListing[]) => StoredListing[]): Promise<StoredListing[]> {
  const run = writeChain.then(async () => {
    const rows = await load();
    const next = fn(rows.map((r) => ({ ...r })));
    await persist(next);
    return next;
  });
  // keep the chain alive even if this mutation throws
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ── Reads ───────────────────────────────────────────────────────────────
export async function allListings(): Promise<StoredListing[]> {
  return [...(await load())];
}

export async function approvedRows(): Promise<ListingRow[]> {
  return (await load()).filter((r) => r.status === "approved");
}

// ── Mutations ───────────────────────────────────────────────────────────
export async function addListing(rec: ListingRow, opts?: { status?: ListingStatus; source?: StoredListing["source"] }): Promise<StoredListing> {
  const id = `l_${Math.abs(hashId(`${rec.chain}:${rec.address}:${rec.sym}`)).toString(36)}`;
  let created!: StoredListing;
  await mutate((rows) => {
    const dupIdx = rows.findIndex(
      (r) => r.chain === rec.chain && r.address.toLowerCase() === rec.address.toLowerCase(),
    );
    // ⚠️ A RE-LIST MAY FILL A FIELD, NEVER BLANK ONE. This used to write `rec`
    // over the stored row whole, and `buildRow` renders an absent optional
    // field as `undefined` — so every re-POST of a token the site already
    // carried erased the logo the project uploaded, their socials, the
    // overview, and a trending window that was still running. See relist.ts;
    // clearing a field is the PATCH path's job, where "" means "clear this".
    const base = dupIdx >= 0 ? mergeRelist(rows[dupIdx], rec) : rec;
    created = {
      ...base,
      id: dupIdx >= 0 ? rows[dupIdx].id : id,
      // ⚠️ A CREATE MAY PROMOTE A ROW, NEVER DEMOTE ONE. `/api/submit` is
      // unauthenticated and creates with `pending`; on a duplicate this used to
      // set an APPROVED paid listing back to pending, and `approvedRows()`
      // filters on approved — so a stranger could unpublish a customer by
      // typing their contract into the public form. See relist.ts; demoting is
      // `setStatus`'s job, which is what an admin rejecting a listing calls.
      status:
        dupIdx >= 0
          ? (keepStatus(rows[dupIdx].status, opts?.status ?? "pending") as ListingStatus)
          : (opts?.status ?? "pending"),
      createdAt: dupIdx >= 0 ? rows[dupIdx].createdAt : createdSeq++,
      // Real listing timestamp so the site shows a LIVE "listed X ago" instead of
      // the frozen listedMin=0 → "0m ago". Preserved across dup re-submits/patches.
      listedAt: dupIdx >= 0 ? (rows[dupIdx].listedAt ?? Date.now()) : Date.now(),
      source: opts?.source ?? "submission",
    };
    if (dupIdx >= 0) {
      rows[dupIdx] = created;
      return rows;
    }
    const next = [created, ...rows];
    // Bound the pending queue: evict the oldest pending rows past the cap.
    if (created.status === "pending") {
      const pending = next.filter((r) => r.status === "pending");
      if (pending.length > MAX_PENDING) {
        const evict = new Set(
          pending
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(0, pending.length - MAX_PENDING)
            .map((r) => r.id),
        );
        return next.filter((r) => !evict.has(r.id));
      }
    }
    return next;
  });
  return created;
}

export async function updateListing(id: string, patch: Partial<ListingRow>): Promise<StoredListing | null> {
  let found: StoredListing | null = null;
  await mutate((rows) => {
    const i = rows.findIndex((r) => r.id === id);
    if (i >= 0) {
      // Never allow id/status to be overwritten through the field patch path.
      const { ...safe } = patch;
      rows[i] = { ...rows[i], ...safe, id: rows[i].id, status: rows[i].status };
      found = rows[i];
    }
    return rows;
  });
  return found;
}

/**
 * Remember a logo the site RESOLVED for a listing that had none.
 *
 * Keyed on chain + address rather than on the row id, because the caller is the
 * board pipeline and it works in BoardTokens — and because the answer is a fact
 * about the token, not about which row happens to carry it.
 *
 * ⚠️ NEVER OVERWRITES A LOGO THAT IS ALREADY THERE. An admin-set logo and a
 * project's own upload are decisions somebody made; a resolved one is the site
 * filling a blank. This function can only ever turn "nothing" into "something",
 * which is also what makes it safe to call from a background sweep.
 *
 * Returns whether a row was actually written, so a sweep can report how much of
 * its work became permanent instead of only living in this process's memory.
 */
/** Point a row that still holds `fromUrl` at our own copy `toUrl` — the CAS in
 *  lib/logoWrite, run inside `mutate` so the compare and the swap are one
 *  atomic edit against the live rows and the Mongo mirror. */
export async function pinLogo(chain: string, address: string, fromUrl: string, toUrl: string): Promise<boolean> {
  let wrote = false;
  await mutate((rows) => {
    const out = applyPinnedLogo(rows, chain, address, fromUrl, toUrl);
    wrote = out.wrote;
    return out.rows as StoredListing[];
  });
  return wrote;
}

export async function setResolvedLogo(chain: string, address: string, logoUrl: string): Promise<boolean> {
  let wrote = false;
  await mutate((rows) => {
    // The RULE lives in lib/logoWrite as a pure function — "never overwrites" is
    // a mutation property, and this file cannot be loaded by the test runner.
    const out = applyResolvedLogo(rows, chain, address, logoUrl);
    wrote = out.wrote;
    return out.rows as StoredListing[];
  });
  return wrote;
}

/**
 * Forget uploaded logos whose files are no longer on disk.
 *
 * Called by the board pipeline, which is where the absence is established (one
 * directory listing per rebuild — see lib/mediaFile.ts). The RULE is in
 * lib/logoWrite as a pure function, next to the write it unblocks: while a row
 * keeps a dead `/api/media/…`, `setResolvedLogo` can never replace it, because
 * that guard stops at any `logoUrl` at all.
 *
 * ⚠️ ALL OF THEM IN ONE MUTATION. A box restored from the Mongo mirror has lost
 * EVERY upload at once, so a per-row call would rewrite the whole store once
 * per row — dozens of serialized disk writes and dozens of Mongo mirrors for
 * one fact discovered in one directory listing.
 *
 * Returns the rows actually written, so the caller can say it once in the log
 * rather than on every 60s rebuild. Artwork disappearing off a paid listing is
 * a fact an operator is owed, even when the site heals it by itself.
 */
export async function forgetLostUploads(
  targets: readonly { chain: string; address: string }[],
): Promise<{ chain: string; address: string }[]> {
  if (targets.length === 0) return [];
  const cleared: { chain: string; address: string }[] = [];
  await mutate((rows) => {
    let out = rows;
    for (const t of targets) {
      const r = applyLostUpload(out, t.chain, t.address);
      if (r.wrote) cleared.push(t);
      out = r.rows;
    }
    return out as StoredListing[];
  });
  return cleared;
}

export async function setStatus(id: string, status: ListingStatus): Promise<StoredListing | null> {
  let found: StoredListing | null = null;
  await mutate((rows) => {
    const i = rows.findIndex((r) => r.id === id);
    if (i >= 0) {
      rows[i] = { ...rows[i], status };
      found = rows[i];
    }
    return rows;
  });
  return found;
}

export async function deleteListing(id: string): Promise<boolean> {
  let removed = false;
  await mutate((rows) => {
    const next = rows.filter((r) => r.id !== id);
    removed = next.length !== rows.length;
    return next;
  });
  return removed;
}

function hashId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}
