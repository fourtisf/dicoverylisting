import { NextRequest, NextResponse } from "next/server";
import { announceLaunch } from "@/lib/notify/announce";
import { markLaunchesAnnounced, primeLaunchMarker, readNotifyState } from "@/lib/notify/state";
import { telegramConfigured } from "@/lib/notify/telegram";
import { fetchPonsLaunchFeed } from "@/lib/providers/pons";
import { safeEqualStr } from "@/lib/password";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The listing bot's heartbeat: posts newly discovered Pons launches to the
// Telegram channel. Call it on a schedule (see README) — it is idempotent, so
// running it twice in a row posts nothing the second time.
//
// Two deliberate behaviours:
//   • First run adopts the current head WITHOUT posting, so wiring up the bot
//     never dumps the whole scanned window into the channel.
//   • A backlog is drained oldest-first, `PONS_BOT_MAX_POSTS` per run, and the
//     marker only advances past what actually went out — nothing is skipped.
const MAX_POSTS = Math.max(1, Math.floor(Number(process.env.PONS_BOT_MAX_POSTS) || 8));

function authorized(req: NextRequest, secret: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const key = (req.nextUrl.searchParams.get("key") ?? "").trim();
  return safeEqualStr(bearer, secret) || safeEqualStr(key, secret);
}

async function run(req: NextRequest) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  // No secret means no endpoint — never leave this callable by anyone.
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  if (!authorized(req, secret)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!telegramConfigured()) {
    return NextResponse.json({ ok: true, posted: 0, reason: "telegram not configured" });
  }

  let items;
  try {
    ({ items } = await fetchPonsLaunchFeed());
  } catch {
    return NextResponse.json({ error: "Robinhood Chain RPC unavailable" }, { status: 503 });
  }
  if (items.length === 0) return NextResponse.json({ ok: true, posted: 0, pending: 0 });

  const state = await readNotifyState();
  const newest = Math.max(...items.map((i) => i.launchedAt));

  if (state.lastLaunchTs === 0) {
    await primeLaunchMarker(newest);
    return NextResponse.json({ ok: true, posted: 0, initialized: true, adoptedAt: newest });
  }

  const seen = new Set(state.launches);
  const fresh = items
    .filter((i) => i.launchedAt > state.lastLaunchTs && !seen.has(i.address.toLowerCase()))
    .sort((a, b) => a.launchedAt - b.launchedAt); // chronological in the channel

  const batch = fresh.slice(0, MAX_POSTS);
  const posted: string[] = [];
  for (const launch of batch) {
    if (await announceLaunch(launch)) posted.push(launch.address);
    else break; // channel is unhealthy — stop and retry the rest next run
  }

  if (posted.length > 0) {
    const newestPosted = Math.max(...batch.slice(0, posted.length).map((i) => i.launchedAt));
    await markLaunchesAnnounced(posted, newestPosted);
  }

  return NextResponse.json({
    ok: true,
    posted: posted.length,
    pending: fresh.length - posted.length,
  });
}

export const GET = run;
export const POST = run;
