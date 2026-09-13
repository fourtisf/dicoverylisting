// Bearer-token gate for the internal bot API (/api/internal/*). The Telegram
// bot is a separate process on the same VPS; it writes listings/trending
// through these routes so the Next.js process stays the SOLE writer of
// data/listings.json (the store caches in memory — two writers would race).
//
// Auth is a shared secret in INTERNAL_API_TOKEN (>= 24 chars). Fails CLOSED:
// if the token isn't configured, every internal route returns 401, so the API
// is inert until an operator opts in. These routes run on `runtime = "nodejs"`.
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

const MIN_LEN = 24;

/** True when the request carries the correct `Authorization: Bearer <token>`. */
export function internalAuthorized(req: NextRequest): boolean {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token || token.length < MIN_LEN) return false; // not configured → closed
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export const unauthorizedInternal = () =>
  NextResponse.json({ error: "Unauthorized" }, { status: 401 });
