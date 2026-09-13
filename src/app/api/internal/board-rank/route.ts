import { NextRequest, NextResponse } from "next/server";
import { internalAuthorized, unauthorizedInternal } from "@/lib/internalAuth";
import { getTokensPayload } from "@/lib/providers";
import { byChange, changeReading, figureReading } from "@/lib/home";
import { PERIOD_KEYS, type PeriodKey } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/internal/board-rank?frame=24h
//
// THE SITE'S OWN TRENDING ORDER, per chain, for the Telegram board to mirror.
//
// "di website sudah ada trending, nah itu aja yang diambil, harus sinkron" —
// the channel and dexvra.io were showing different tokens because they ranked
// from different places: the site orders every listing by 24h % (`byChange`),
// the channel renders whoever holds a booked slot. Two answers to one question,
// on two surfaces a project checks against each other.
//
// ⚠️ THE RANKING IS NOT REBUILT HERE AND MUST NEVER BE. `byChange` is the site's
// one owner of "which change may rank this" — its own header records that the
// /trending page's private copy read the raw field and let `$MRNA +465%` on
// five cents of volume take a medal, and that three private copies is how the
// board's fabricated-percentage saga ran three rounds. A fourth copy inside the
// bot would drift exactly the way these two surfaces already have.
export async function GET(req: NextRequest) {
  if (!internalAuthorized(req)) return unauthorizedInternal();
  const asked = new URL(req.url).searchParams.get("frame");
  const frame: PeriodKey = (PERIOD_KEYS as string[]).includes(asked ?? "") ? (asked as PeriodKey) : "24h";
  const { tokens, live, updatedAt } = await getTokensPayload();

  // Grouped by chain because the channel board is grouped by chain. A flat list
  // would make the caller re-derive the split, which is one more place for the
  // two to disagree about what "on this chain" means.
  const chains: Record<string, unknown[]> = {};
  for (const t of byChange(tokens, frame, -1)) {
    (chains[t.chain] ||= []).push({
      chain: t.chain,
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      // ⚠️ THE HONEST READINGS, not the raw fields. `changeReading` and
      // `figureReading` are what keep a captured-at-listing zero off the site
      // as a measurement nobody made; sending `t.chg[frame]` raw would export
      // exactly the fabricated figure both boards refuse to render, to a
      // channel 10,543 people read. null means "no reading" and the caller must
      // render it as such — never as 0%.
      change24h: changeReading(t, frame),
      mcap: figureReading(t, t.mcap),
      // Already holds a booked Trending slot. The caller pins those itself; this
      // is here so it can tell a row it has already shown from one it has not.
      booked: t.trendingRank != null,
    });
  }
  // `live:false` is the site's own "these are captured-at-listing numbers, not a
  // reading" flag. It travels so the caller can refuse to publish a board built
  // from demo data rather than discovering that on the channel.
  return NextResponse.json({ frame, live, updatedAt, chains });
}
