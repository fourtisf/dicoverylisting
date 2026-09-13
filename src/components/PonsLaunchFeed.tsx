"use client";

import { useEffect, useState } from "react";
import { Coin } from "@/components/Coin";
import { CHAINS } from "@/config/chains";
import { fmtAge, fmtCap, fmtPrice, shortAddr } from "@/lib/format";
import { visualFor } from "@/lib/visual";

// Discovery feed for launches nobody has paid to list. Kept visually distinct
// from the paid board on purpose: Dexvra is paid-listing only, so every card
// here says so and links out to Pons rather than into a Dexvra token page.
interface FeedItem {
  address: string;
  chain: string;
  symbol: string | null;
  name: string | null;
  logo: string | null;
  ageMinutes: number;
  graduated: boolean;
  phase: string;
  progressPct: number | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  ponsUrl: string;
}

interface FeedResponse {
  items?: FeedItem[];
  live?: boolean;
  coverageMinutes?: number;
}

const POLL_MS = 60_000;

export function PonsLaunchFeed({ limit = 12 }: { limit?: number }) {
  const [feed, setFeed] = useState<FeedResponse | null>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const res = await fetch(`/api/pons/launches?limit=${limit}`, { cache: "no-store" });
        const json = (await res.json()) as FeedResponse;
        if (!stop) setFeed(json);
      } catch {
        if (!stop) setFeed((prev) => prev ?? { items: [], live: false });
      } finally {
        if (!stop) timer = setTimeout(tick, POLL_MS);
      }
    };
    tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [limit]);

  const items = feed?.items ?? [];
  const chain = CHAINS.robinhood;

  return (
    <div className="pons-feed">
      <div className="pons-feed-head">
        <span className="pons-feed-title">
          Fresh from Pons
          <span className="pons-chip">{chain?.label ?? "Robinhood"}</span>
        </span>
        <span className="pons-feed-sub">
          Auto-indexed launches straight off the Pons factory — <b>not</b> Dexvra listings. DYOR.
        </span>
      </div>

      {feed == null ? (
        <div className="board-loading"><span className="dot-live" /> Reading the Pons factory…</div>
      ) : items.length === 0 ? (
        <div className="a-chain pons-feed-empty">
          {feed.live === false
            ? "Robinhood Chain RPC is unreachable right now — the feed will fill in on the next refresh."
            : "No launches inside the scanned window yet."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {items.map((item) => {
            const symbol = item.symbol ? `$${item.symbol.replace(/^\$/, "")}` : shortAddr(item.address);
            const v = visualFor(symbol);
            const progress = item.progressPct == null ? null : Math.max(0, Math.min(100, item.progressPct));
            return (
              <a
                key={item.address}
                className="listing-card pons-card"
                href={item.ponsUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Coin
                  token={{
                    emoji: v.emoji,
                    gradient: v.gradient,
                    logoUrl: item.logo,
                    chain: item.chain,
                    symbol,
                  }}
                  size={40}
                  fontSize={19}
                />
                <div className="lc-id">
                  <div className="lc-sym">
                    {symbol}
                    <span className="pons-tag">PONS · UNLISTED</span>
                    {item.graduated && <span className="pons-tag grad">GRADUATED</span>}
                  </div>
                  <div className="lc-nm">
                    {item.name || "Unnamed launch"} ·{" "}
                    <span style={{ color: chain?.color }}>{chain?.label ?? item.chain}</span>
                  </div>
                </div>
                <div className="lc-age">
                  <div className="lc-age-v">⏱ {fmtAge(item.ageMinutes)}</div>
                  <div className="lc-age-l">LAUNCHED AGO</div>
                </div>
                <div className="lc-metric">
                  <div className="lc-price">{item.priceUsd != null ? fmtPrice(item.priceUsd) : "—"}</div>
                  <div className="lc-age-l">{item.mcapUsd != null ? fmtCap(item.mcapUsd) : "NO PRICE"}</div>
                </div>
                <div className="lc-metric lc-hide pons-progress">
                  {item.graduated || progress == null ? (
                    <div className="lc-age-l">{item.phase}</div>
                  ) : (
                    <>
                      <div className="pons-bar">
                        <span className="pons-bar-fill" style={{ width: `${progress}%` }} />
                      </div>
                      <div className="lc-age-l">CURVE {progress.toFixed(0)}%</div>
                    </>
                  )}
                </div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
