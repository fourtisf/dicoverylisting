// Server-only: shared MongoDB connection for the web app. Used by the listing
// and banner stores as a DURABLE MIRROR of their on-disk JSON — so a VPS reset /
// container replace doesn't lose data, and (with the bot pointed at the same
// MONGO_URI) the site and the Telegram bot share one database.
//
// Fail-open: no MONGO_URI or an unreachable server → getDb() returns null and the
// stores fall back to their local files exactly as before. Mongo is never on a
// request's critical path — mirror writes are best-effort.
import { MongoClient, type Db } from "mongodb";

const uri = process.env.MONGO_URI || "";
const dbName = process.env.MONGO_DB || undefined;

// Reuse one client across Next.js hot-reloads / route modules (the standard
// Next pattern) so we don't open a new pool per request.
const g = globalThis as unknown as { _dexvraMongo?: Promise<MongoClient> };

export function mongoConfigured(): boolean {
  return !!uri;
}

export async function getDb(): Promise<Db | null> {
  if (!uri) return null;
  try {
    if (!g._dexvraMongo) {
      g._dexvraMongo = new MongoClient(uri, {
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 8000,
        maxIdleTimeMS: 60000,
      })
        .connect()
        .then(async (c) => {
          await c.db(dbName).command({ ping: 1 }); // prove reachability
          return c;
        });
    }
    const client = await g._dexvraMongo;
    return client.db(dbName);
  } catch (e) {
    g._dexvraMongo = undefined; // allow a later retry
    console.warn("[mongo] connect failed — web running on local files:", (e as Error).message);
    return null;
  }
}

// KV-blob helpers — one doc per store in the `web` collection: {_id, data, at}.
export async function kvGet<T>(name: string): Promise<T | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  try {
    const doc = await db.collection("web").findOne({ _id: name as never });
    return doc ? (doc.data as T) : undefined;
  } catch (e) {
    console.warn(`[mongo] kvGet(${name}) failed:`, (e as Error).message);
    return undefined;
  }
}

export async function kvSet(name: string, data: unknown): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.collection("web").updateOne(
      { _id: name as never },
      { $set: { data, at: Date.now() } },
      { upsert: true },
    );
  } catch (e) {
    console.warn(`[mongo] kvSet(${name}) failed:`, (e as Error).message);
  }
}
