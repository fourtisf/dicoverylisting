"use client";

import { useMemo, useState } from "react";
import type { BoardToken, PeriodKey } from "@/lib/types";
import { fmtCap, fmtPrice } from "@/lib/format";
import { HOME_BOARD_ROWS, changeReading, topCoins, type CoinSort } from "@/lib/home";
import { scoreTier } from "@/lib/score";
import { useApp } from "./AppState";
import { SkeletonRows } from "./TokenBoard";
import { Coin } from "./Coin";
import { TierTag } from "./TierTag";

const SORTS: { key: CoinSort; label: string }[] = [
  { key: "mcap", label: "Market Cap" },
  { key: "vol", label: "Volume" },
  { key: "score", label: "DXS Score" },
];

/**
 * The market ranking, under the trending board.
 *
 * Where Trending answers "what is being pushed right now", this answers "what
 * is actually big here" — so it is deliberately the calm surface: no flicker,
 * no medals, one row height, the numbers in the mono voice.
 *
 * DXS Score is a third ranking and it is the one a competitor cannot copy: it
 * ranks by on-chain signal rather than by what a project paid, which is the
 * whole argument for the score existing.
 *
 * It opens on ten rows and grows in place. There is no "view all" link because
 * there is no page that answers THIS question — sending someone to /trending
 * for a market-cap ranking would be a link that quietly changes the subject.
 */
export function TopCoinsBoard({
  tokens,
  period = "24h",
  loading = false,
}: {
  tokens: BoardToken[];
  period?: PeriodKey;
  /** "Nothing listed on this chain yet" is a claim about the market, and it
   *  must never render before the market has been read once. */
  loading?: boolean;
}) {
  const { openDetail } = useApp();
  const [sort, setSort] = useState<CoinSort>("mcap");
  const [all, setAll] = useState(false);

  const { rows, unpriced } = useMemo(
    () => topCoins(tokens, sort, period, all ? 0 : HOME_BOARD_ROWS),
    [tokens, sort, period, all],
  );
  const pool = sort === "mcap" ? tokens.length - unpriced : tokens.length;
  const hidden = Math.max(0, pool - rows.length);

  return (
    <div className="topcoins">
      <div className="sec-head">
        <div className="sec-title">
          <div className="sec-ic tc-ic">
            <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
            </svg>
          </div>
          <h2>Top Coins</h2>
        </div>
        <div className="ttabs tc-sorts">
          {SORTS.map((s) => (
            <button
              key={s.key}
              className={`ttab ${s.key === sort ? "active" : ""}`}
              onClick={() => setSort(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="tc-board">
        <div className="tc-row tc-head">
          <div>#</div>
          <div>Coin</div>
          <div className="c-num">Price</div>
          <div className="c-num tc-h1">1h</div>
          <div className="c-num">{period}</div>
          <div className="c-num tc-cap">Market Cap</div>
          <div className="c-num tc-dxs">DXS</div>
        </div>

        {loading ? (
          <SkeletonRows n={6} />
        ) : tokens.length === 0 ? (
          <div className="empty">Nothing listed on this chain yet.</div>
        ) : rows.length === 0 ? (
          <div className="empty">No token here has a readable market cap right now.</div>
        ) : (
          rows.map((t, i) => {
            const h1 = changeReading(t, "1h");
            const hp = changeReading(t, period);
            const st = scoreTier(t.score);
            return (
              <div className="tc-row" key={t.key} onClick={() => openDetail(t)}>
                <div className="tc-rank">{i + 1}</div>
                <div className="tc-tok">
                  <Coin token={t} size={30} fontSize={14} />
                  <div className="tc-id">
                    <div className="tc-sym">
                      <span className="tc-sym-txt">{t.symbol}</span>
                      <TierTag tier={t.tier} showRank={false} ageMinutes={t.listedMinutesAgo} />
                    </div>
                    <div className="tc-nm">{t.name}</div>
                  </div>
                </div>
                <div className="c-num tc-px">{fmtPrice(t.priceUsd)}</div>
                <div className={`c-num tc-chg tc-h1 ${(h1 ?? 0) >= 0 ? "up" : "dn"}`}>
                  {h1 == null ? "—" : `${h1 >= 0 ? "+" : ""}${h1.toFixed(2)}%`}
                </div>
                <div className={`c-num tc-chg ${(hp ?? 0) >= 0 ? "up" : "dn"}`}>
                  {hp == null ? "—" : `${hp >= 0 ? "+" : ""}${hp.toFixed(2)}%`}
                </div>
                <div className="c-num tc-cap tc-mono">{fmtCap(t.mcap)}</div>
                <div className="c-num tc-dxs">
                  <span className="dscore" style={{ color: st.color }} title={`Dexvra Score — ${st.label}`}>
                    {t.score}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* A cap is never silent, and neither is an exclusion: a token we could
          not price is REPORTED rather than quietly missing from a ranking it
          belongs in. */}
      {!loading && (hidden > 0 || unpriced > 0 || all) && (
        <div className="tc-foot">
          <span>
            Showing {rows.length} of {pool}
            {unpriced > 0 && (
              <>
                {" "}
                · <b>{unpriced}</b> hidden — no readable market cap
              </>
            )}
          </span>
          {(hidden > 0 || all) && (
            <button className="tc-more" onClick={() => setAll((v) => !v)}>
              {all ? "Show less" : `Show all ${pool}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
