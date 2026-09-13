"use client";

import { useMemo } from "react";
import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { Coin } from "@/components/Coin";
import { CHAINS } from "@/config/chains";
import { fmtAge, fmtCap, fmtPrice } from "@/lib/format";
import { scoreTier } from "@/lib/score";
import { TierTag } from "@/components/TierTag";
import { PonsLaunchFeed } from "@/components/PonsLaunchFeed";

export default function NewListingsPage() {
  const { data, openDetail } = useApp();

  const list = useMemo(
    () => [...(data?.tokens ?? [])].sort((a, b) => a.listedMinutesAgo - b.listedMinutesAgo),
    [data],
  );

  return (
    <section className="view">
      <PageHead icon="🛰️" title="New Listings" sub="Freshest paid listings first — the trenches, in order.">
        <span className="live-pill">● LIVE</span>
      </PageHead>

      {!data ? (
        <div className="board-loading">
          <span className="dot-live" /> Loading listings…
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {list.map((t) => {
            const up = t.chg["24h"] >= 0;
            const st = scoreTier(t.score);
            return (
              <div key={t.key} className="listing-card" onClick={() => openDetail(t)}>
                <Coin token={t} size={40} fontSize={19} />
                <div className="lc-id">
                  <div className="lc-sym">
                    {t.symbol}
                    <TierTag tier={t.tier} ageMinutes={t.listedMinutesAgo} />
                  </div>
                  <div className="lc-nm">
                    {t.name} · <span style={{ color: CHAINS[t.chain]?.color }}>{CHAINS[t.chain]?.label ?? t.chain}</span>
                  </div>
                </div>
                <div className="lc-age">
                  <div className="lc-age-v">⏱ {fmtAge(t.listedMinutesAgo)}</div>
                  <div className="lc-age-l">LISTED AGO</div>
                </div>
                <div className="lc-metric">
                  <div className="lc-price">{fmtPrice(t.priceUsd)}</div>
                  <div className={`lc-chg ${up ? "up" : "dn"}`}>
                    {up ? "+" : ""}
                    {t.chg["24h"].toFixed(1)}%
                  </div>
                </div>
                <div className="lc-metric lc-hide">
                  <div className="lc-price">{fmtCap(t.liq)}</div>
                  <div className="lc-age-l">LIQUIDITY</div>
                </div>
                <span className="dscore" style={{ color: st.color }}>
                  <span className="dl">DXS</span>
                  {t.score}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <PonsLaunchFeed />
    </section>
  );
}
