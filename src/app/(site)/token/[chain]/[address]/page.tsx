"use client";

import { useParams, useRouter } from "next/navigation";
import { useMemo } from "react";
import { useApp } from "@/components/AppState";
import { CandleChart } from "@/components/CandleChart";
import { Coin } from "@/components/Coin";
import { ChainLogo } from "@/components/ChainLogo";
import { Socials } from "@/components/Socials";
import { TokenTrades } from "@/components/TokenTrades";
import { UnlistedToken } from "@/components/UnlistedToken";
import { TierTag, TrendingBadge } from "@/components/TierTag";
import { CHAINS } from "@/config/chains";
import { fmtAge, fmtCap, fmtNum, fmtPrice } from "@/lib/format";
import { scoreTier } from "@/lib/score";

export default function TokenPage() {
  const params = useParams<{ chain: string; address: string }>();
  const chain = params.chain;
  const address = decodeURIComponent(params.address ?? "");
  const router = useRouter();
  const { data, watchlist, toggleWatch, toast } = useApp();

  const t = useMemo(
    () =>
      (data?.tokens ?? []).find(
        (x) => x.chain === chain && x.address.toLowerCase() === address.toLowerCase(),
      ),
    [data, chain, address],
  );

  if (!data) {
    return (
      <section className="view">
        <div className="board-loading"><span className="dot-live" /> Loading token…</div>
      </section>
    );
  }
  // NOT a dead end. Every buy-bot alert links here, the buy bot is free and
  // runs on any contract, so most arrivals on this page are for a token nobody
  // has listed — see UnlistedToken.
  if (!t) return <UnlistedToken chain={chain} address={address} />;

  const c = CHAINS[t.chain];
  const network = c?.geckoNetwork ?? null;
  const up = t.chg["24h"] >= 0;
  const col = up ? "#3DDC97" : "#F76A85";
  const watching = watchlist.has(t.key);
  const st = scoreTier(t.score);
  const copyCa = () => {
    navigator.clipboard?.writeText(t.address).catch(() => {});
    toast("Contract address copied 📋");
  };

  const stats: [string, string, string?][] = [
    ["Price", fmtPrice(t.priceUsd)],
    ["24h", `${up ? "+" : ""}${t.chg["24h"].toFixed(1)}%`, up ? "up" : "dn"],
    ["MCAP", fmtCap(t.mcap)],
    ["Liquidity", fmtCap(t.liq)],
    ["Vol · 24h", fmtCap(t.vol["24h"])],
    ["Holders", fmtNum(t.holders)],
    ["Tax", t.taxPct != null ? `${t.taxPct}%` : "—"],
    ["Txns · 24h", fmtNum(t.txns["24h"].buys + t.txns["24h"].sells)],
  ];

  return (
    <section className="view token-page">
      <button className="back-link" onClick={() => router.back()}>← Back</button>

      <div className="tp-head">
        <Coin token={t} size={56} fontSize={26} />
        <div className="tp-id">
          <div className="tp-sym">
            {t.symbol}
            <TierTag tier={t.tier} ageMinutes={t.listedMinutesAgo} />
            {t.trendingRank != null && <TrendingBadge />}
          </div>
          <div className="tp-nm">
            {t.name} · <ChainLogo chain={t.chain} size={14} style={{ verticalAlign: "-2px" }} />{" "}
            <span style={{ color: c?.color }}>{c?.label ?? t.chain}</span> · listed {fmtAge(t.listedMinutesAgo)} ago
          </div>
        </div>
        <div className="tp-price">
          <div className="tp-px">{fmtPrice(t.priceUsd)}</div>
          <div className="tp-chg" style={{ color: col }}>{up ? "+" : ""}{t.chg["24h"].toFixed(1)}%</div>
        </div>
        <div className="tp-actions">
          <button
            className={`btn-ghost2 ${watching ? "on" : ""}`}
            style={{ color: watching ? "var(--acc)" : undefined }}
            onClick={() => toggleWatch(t.key, t.symbol)}
          >
            {watching ? "★ Watching" : "☆ Watch"}
          </button>
          <a className="btn-primary" href={c?.buyUrl(t.address)} target="_blank" rel="noopener noreferrer">
            Buy {t.symbol} →
          </a>
        </div>
      </div>

      <div className="tp-subrow">
        <div className="ca-box">
          <code>{t.address}</code>
          <button className="copy-btn" onClick={copyCa}>COPY</button>
        </div>
        <Socials t={t} />
      </div>

      {t.overview && (
        <div className="panel tp-about">
          <div className="tp-about-k">About {t.symbol}</div>
          <p className="tp-about-p">{t.overview}</p>
        </div>
      )}

      <div className="tp-grid">
        <div className="tp-chart-wrap">
          {/* Real candles, ours. What used to be here was a GeckoTerminal
              iframe when a pool address happened to be known and a curve
              generated from the ticker's hash when it was not — see
              components/CandleChart.tsx for why neither could stay. */}
          <CandleChart
            chain={t.chain}
            address={t.address}
            symbol={t.symbol}
            poolHint={t.poolAddress}
            gtUrl={network ? `https://www.geckoterminal.com/${network}/tokens/${t.address}` : null}
          />
        </div>

        <aside className="tp-side">
          <div
            className="dscore-banner"
            style={{ borderColor: st.color }}
            title="Dexvra Score (0–100) — a transparent on-chain blend: momentum 30% · liquidity depth 25% · tax/safety 15% · buy pressure 15% · holder base 15%. Deterministic, not AI, not paid votes."
          >
            <div className="dsb-num" style={{ color: st.color }}>{t.score}</div>
            <div className="dsb-meta">
              <div className="dsb-title">Dexvra Score · <span style={{ color: st.color }}>{st.label}</span></div>
              <div className="dsb-sub">Signal-based. Not votes.</div>
            </div>
          </div>
          <div className="tp-stats">
            {stats.map(([k, v, cls]) => (
              <div className="ds" key={k}>
                <div className="k">{k}</div>
                <div className={`v ${cls === "up" ? "tp-up" : cls === "dn" ? "tp-dn" : ""}`}>{v}</div>
              </div>
            ))}
          </div>
        </aside>
      </div>

      <TokenTrades t={t} />
    </section>
  );
}
