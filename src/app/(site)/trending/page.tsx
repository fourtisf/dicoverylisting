"use client";

import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { StdBoard } from "@/components/TokenBoard";
import type { CSSProperties } from "react";
import { Coin } from "@/components/Coin";
import { TierTag } from "@/components/TierTag";
import { ChainLogo } from "@/components/ChainLogo";
import { byChange } from "@/lib/home";
import { fmtPrice } from "@/lib/format";
import { tierColor, tierRank } from "@/lib/packages";
import { chainOf } from "@/config/chains";
import type { PeriodKey } from "@/lib/types";

// Sort priority for the Trending rail: higher-tier package first (Diamond #1 →
// Bronze #5). Xpress (rank 0) sits after the ranked tiers.
const trendPriority = (tier: string): number => {
  const r = tierRank(tier);
  return r === 0 ? 90 : r;
};

const FRAMES: PeriodKey[] = ["1h", "6h", "24h"];

export default function TrendingPage() {
  const { data, openDetail } = useApp();
  const [mode, setMode] = useState<"gain" | "lose">("gain");
  const [frame, setFrame] = useState<PeriodKey>("24h");
  const [chain, setChain] = useState<string>("all");

  // Chains actually present in the data, most-populated first — so the picker
  // only offers chains that have tokens (no dead filters).
  const chains = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of data?.tokens ?? []) counts.set(t.chain, (counts.get(t.chain) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }, [data]);
  const inChain = useMemo(() => (c: string) => chain === "all" || c === chain, [chain]);
  // If the selected chain disappears from the data (delisted / dropped from a
  // later poll), fall back to "all" — otherwise the picker unmounts and the
  // board would be stuck filtering to zero rows with no way to reset.
  useEffect(() => {
    if (chain !== "all" && !chains.includes(chain)) setChain("all");
  }, [chain, chains]);

  // ⚠️ THROUGH `byChange`, NOT THE RAW FIELD. This sort used to read
  // `b.chg[frame] - a.chg[frame]` — so the one page whose whole heading is
  // "Top Gainers" went through NEITHER gate the rest of the site uses: a
  // five-million-percent figure off a near-dead pool could lead it, and
  // `$MRNA +465%` on five cents of 24h volume took its 🥇 medal. One owner
  // now, shared with the home board's comparator, and an unrankable row sinks
  // on the LOSERS tab too rather than being crowned by it.
  const list = useMemo(
    () => byChange((data?.tokens ?? []).filter((t) => inChain(t.chain)), frame, mode === "gain" ? -1 : 1),
    [data, mode, frame, inChain],
  );

  // Paid Trending slots — ordered by the package booked: Diamond first, then
  // Gold, Platinum, Silver, Bronze, Xpress. No numbering; order shows priority.
  const featured = useMemo(
    () =>
      [...(data?.tokens ?? [])]
        .filter((t) => t.trendingRank != null && inChain(t.chain))
        .sort(
          (a, b) =>
            trendPriority(a.tier) - trendPriority(b.tier) ||
            (a.trendingRank ?? 99) - (b.trendingRank ?? 99),
        ),
    [data, inChain],
  );

  return (
    <section className="view">
      {chains.length > 1 && (
        <div className="chain-pick" role="group" aria-label="Filter by chain">
          <button
            className={`chain-chip ${chain === "all" ? "active" : ""}`}
            onClick={() => setChain("all")}
            aria-pressed={chain === "all"}
          >
            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" />
            </svg>
            All chains
          </button>
          {chains.map((id) => (
            <button
              key={id}
              className={`chain-chip ${chain === id ? "active" : ""}`}
              onClick={() => setChain(id)}
              aria-pressed={chain === id}
            >
              <ChainLogo chain={id} size={15} />
              {chainOf(id)?.label ?? id}
            </button>
          ))}
        </div>
      )}
      {featured.length > 0 && (
        <div className="feat-trend">
          {/* no emoji glyph — the head joins the microlabel voice, like every
              section marker since the rebuild */}
          <div className="feat-head">Trending Now <span className="feat-sub">Paid featured slots</span></div>
          <div className="feat-rail">
            {featured.map((t) => {
              const up = t.chg["24h"] >= 0;
              return (
                <button
                  className="feat-card"
                  key={t.key}
                  onClick={() => openDetail(t)}
                  style={{ "--tc": tierColor(t.tier) } as CSSProperties}
                >
                  <Coin token={t} size={38} fontSize={17} />
                  <div className="feat-id">
                    <div className="feat-sym">{t.symbol}</div>
                    <TierTag tier={t.tier} showRank={false} ageMinutes={t.listedMinutesAgo} />
                  </div>
                  <div className="feat-px">
                    <div>{fmtPrice(t.priceUsd)}</div>
                    <div className={up ? "feat-up" : "feat-dn"}>{up ? "+" : ""}{t.chg["24h"].toFixed(1)}%</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <PageHead
        icon="🔥"
        title="Gainers & Losers"
        sub="Biggest movers among paid listings — pick your timeframe."
      >
        <div className="ttabs">
          <button className={`ttab ${mode === "gain" ? "active" : ""}`} onClick={() => setMode("gain")}>
            Top Gainers
          </button>
          <button className={`ttab ${mode === "lose" ? "active" : ""}`} onClick={() => setMode("lose")}>
            Top Losers
          </button>
        </div>
        <div className="ttabs">
          {FRAMES.map((f) => (
            <button key={f} className={`ttab ${frame === f ? "active" : ""}`} onClick={() => setFrame(f)}>
              {f}
            </button>
          ))}
        </div>
      </PageHead>
      <StdBoard tokens={list} period={frame} loading={!data} />
    </section>
  );
}
