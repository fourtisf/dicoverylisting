"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { capped, changeRank, changeReading, expander, figureReading } from "@/lib/home";
import type { BoardToken, PeriodKey } from "@/lib/types";
import { fmtAge, fmtCap, fmtNum, fmtPrice } from "@/lib/format";
import { scoreTier } from "@/lib/score";
import { Coin } from "./Coin";
import { TierTag } from "./TierTag";
import { useApp } from "./AppState";

/** Top-three ranks are DRAWN, not the OS emoji-of-the-day — the same rule the
 *  Pulse cards state for their section glyphs. An Apple gold medal next to a
 *  Windows one is two different products; a gradient roundel is ours on every
 *  device. */
const Medal = ({ n }: { n: number }) => <span className={`medal medal-${n}`}>{n}</span>;

/** Shimmer placeholder rows. Loading must LOOK like loading: before the first
 *  /api/tokens answer the empty states below would render as facts ("no tokens
 *  match") about a market nobody has read yet. */
export function SkeletonRows({ n = 8 }: { n?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div className="skr" key={i} style={{ opacity: 1 - i * 0.09 }}>
          <span className="sk sk-dot" />
          <span className="sk sk-coin" />
          <span className="sk-id">
            <span className="sk sk-line" style={{ width: "38%" }} />
            <span className="sk sk-line thin" style={{ width: "58%" }} />
          </span>
          <span className="sk sk-cell" />
          <span className="sk sk-pill" />
        </div>
      ))}
    </div>
  );
}

type SortKey = "price" | "chg" | "mcap" | "liq" | "vol" | "tx";

const SORT_VAL: Record<SortKey, (t: BoardToken, p: PeriodKey) => number> = {
  price: (t) => t.priceUsd,
  // Through `changeRank`, not the raw field and not `changeReading` — an
  // unreadable/absurd change sinks to the bottom, AND so does a real percentage
  // with no trading behind it. The board opens on this sort, so whatever wins
  // it is what the site says is trending; `$MRNA +465%` on $0.05 of 24h volume
  // held rank 1 over every real market until this read the volume too. The row
  // still renders its own percentage — see changeRank, which demotes and never
  // hides.
  chg: (t, p) => changeRank(t, p),
  mcap: (t) => t.mcap ?? 0,
  liq: (t) => t.liq ?? 0,
  vol: (t, p) => t.vol[p],
  tx: (t, p) => t.txns[p].buys + t.txns[p].sells,
};

function StarButton({ token }: { token: BoardToken }) {
  const { watchlist, toggleWatch } = useApp();
  const on = watchlist.has(token.key);
  return (
    <button
      className={`star ${on ? "on" : ""}`}
      title="Watchlist"
      aria-pressed={on}
      onClick={(e) => {
        // star must never bubble into the row's open-detail click
        e.stopPropagation();
        toggleWatch(token.key, token.symbol);
      }}
    >
      <svg viewBox="0 0 24 24">
        <path d="m12 3.5 2.5 5.2 5.7.7-4.2 4 1.1 5.6L12 16.3 6.9 19l1.1-5.6-4.2-4 5.7-.7L12 3.5z" />
      </svg>
    </button>
  );
}

/** Track real price movements between refreshes and flash rows; in demo
 *  (seed) mode, replicate the prototype's random flicker so the board still
 *  feels alive. Overrides only touch what's displayed, never app state. */
function useFlicker(tokens: BoardToken[], reducedMotion: boolean) {
  const [flash, setFlash] = useState<Record<string, "up" | "dn">>({});
  const [override, setOverride] = useState<Record<string, { price: number; chgDelta: number }>>({});
  const prevPrices = useRef<Map<string, number>>(new Map());
  const timeouts = useRef<ReturnType<typeof setTimeout>[]>([]);

  const isSeed = tokens.length > 0 && tokens[0].source === "seed";

  useEffect(() => {
    if (reducedMotion) return;
    const next: Record<string, "up" | "dn"> = {};
    for (const t of tokens) {
      const prev = prevPrices.current.get(t.key);
      if (prev !== undefined && prev !== t.priceUsd) next[t.key] = t.priceUsd > prev ? "up" : "dn";
      prevPrices.current.set(t.key, t.priceUsd);
    }
    if (Object.keys(next).length) {
      setFlash((f) => ({ ...f, ...next }));
      const id = setTimeout(() => setFlash({}), 700);
      timeouts.current.push(id);
    }
    // live data refreshes invalidate any demo overrides
    if (!isSeed) setOverride({});
  }, [tokens, reducedMotion, isSeed]);

  useEffect(() => {
    if (!isSeed || reducedMotion) return;
    const id = setInterval(() => {
      const t = tokens[Math.floor(Math.random() * tokens.length)];
      if (!t) return;
      const dir = Math.random() > 0.45 ? 1 : -1;
      setOverride((o) => {
        const cur = o[t.key] ?? { price: t.priceUsd, chgDelta: 0 };
        return {
          ...o,
          [t.key]: {
            price: cur.price * (1 + dir * Math.random() * 0.006),
            chgDelta: cur.chgDelta + dir * Math.random() * 0.4,
          },
        };
      });
      setFlash((f) => ({ ...f, [t.key]: dir > 0 ? "up" : "dn" }));
      const to = setTimeout(() => setFlash((f) => {
        const { [t.key]: _drop, ...rest } = f;
        return rest;
      }), 700);
      timeouts.current.push(to);
    }, 2600);
    return () => clearInterval(id);
  }, [isSeed, reducedMotion, tokens]);

  useEffect(() => () => timeouts.current.forEach(clearTimeout), []);

  return { flash, override };
}

function StdRow({
  t,
  i,
  period,
  flashDir,
  override,
}: {
  t: BoardToken;
  i: number;
  period: PeriodKey;
  flashDir?: "up" | "dn";
  override?: { price: number; chgDelta: number };
}) {
  const { openDetail } = useApp();
  // EVERY money figure goes through figureReading: a zero on a row no provider
  // priced is the store's captured default, not a market fact, and this board
  // rendered seven Robinhood listings as "$0 · $0 · $0" — three claims per row
  // that nobody measured. The dash the 24h column already draws, on every
  // column that can lie the same way.
  const price = override?.price ?? figureReading(t, t.priceUsd);
  const mcap = figureReading(t, t.mcap);
  const liq = figureReading(t, t.liq);
  const vol = figureReading(t, t.vol[period]);
  const reading = changeReading(t, period);
  const chg = (reading ?? 0) + (override?.chgDelta ?? 0);
  const up = chg >= 0;
  // a fallback row whose demo flicker has nudged it counts as a reading —
  // the flicker only runs in seed mode, where the whole board is the demo
  const hasReading = reading != null || override?.chgDelta != null;
  const dec = period === "5m" ? 2 : 1;
  const { buys, sells } = t.txns[period];
  const tx = figureReading(t, buys + sells);
  const rank = i < 3 ? <Medal n={i + 1} /> : i + 1;

  return (
    <div
      className={`row ${flashDir === "up" ? "flash-up" : ""} ${flashDir === "dn" ? "flash-dn" : ""}`}
      onClick={() => openDetail(t)}
    >
      <div className="rank">{rank}</div>
      <div className="tok">
        <Coin token={t} />
        <div className="ts">
          <div className="sym">
            <span className="sym-txt">{t.symbol}</span>
            <TierTag tier={t.tier} showRank={false} ageMinutes={t.listedMinutesAgo} />
          </div>
          <div className="nm">{t.name}</div>
          {/* phones: the hidden table columns condense into this line */}
          <div className="m-stats">
            <b>MC</b> {fmtCap(mcap)} · <b>V</b> {fmtCap(vol)} · <b>TX</b> {fmtNum(tx)} ·{" "}
            <span style={{ color: scoreTier(t.score).color }}>DXS {t.score}</span>
          </div>
        </div>
      </div>
      <div className="c-num price">{fmtPrice(price)}</div>
      <div className="c-num">
        {hasReading ? (
          <span className={`chg ${up ? "up" : "dn"}`}>
            {up ? "+" : ""}
            {chg.toFixed(dec)}%
          </span>
        ) : (
          <span className="chg none" title="No market reading yet — too new for the indexers">
            —
          </span>
        )}
      </div>
      <div className="c-num c-mcap mono-dim">{fmtCap(mcap)}</div>
      <div className="c-num c-liq mono-dim">{fmtCap(liq)}</div>
      <div className="c-num c-vol mono-dim">{fmtCap(vol)}</div>
      <div className="c-txns tx-cell">
        <div className="tx-main">{fmtNum(tx)}</div>
        {tx != null && (
          <div className="tx-split">
            <span className="b">{fmtNum(buys)}</span>
            <span className="sl"> / </span>
            <span className="s">{fmtNum(Math.max(sells, 0))}</span>
          </div>
        )}
      </div>
      <div className="c-info info-cell">
        <span className="dscore" style={{ color: scoreTier(t.score).color }} title="Dexvra Score">
          <span className="dl">DXS</span>
          {t.score}
        </span>
        {t.taxPct != null && (
          <span className={`ichip ${t.taxPct === 0 ? "good" : ""}`}>🛡 {t.taxPct}%</span>
        )}
      </div>
      <StarButton token={t} />
    </div>
  );
}

function NpRow({ t, i, flashDir }: { t: BoardToken; i: number; flashDir?: "up" | "dn" }) {
  const { openDetail } = useApp();
  const reading = changeReading(t, "24h");
  const up = (reading ?? 0) >= 0;
  // The same figureReading rule as the main row — a fresh pair is exactly the
  // row most likely to carry captured zeros nobody measured.
  const npTx = figureReading(t, t.txns["24h"].buys + t.txns["24h"].sells);
  return (
    <div
      className={`row ${flashDir === "up" ? "flash-up" : ""} ${flashDir === "dn" ? "flash-dn" : ""}`}
      onClick={() => openDetail(t)}
    >
      <div className="rank">{i + 1}</div>
      <div className="tok">
        <Coin token={t} />
        <div className="ts">
          <div className="sym">{t.symbol}</div>
          <div className="nm">{t.name}</div>
        </div>
      </div>
      <div>
        <span className="age-chip">⏱ {fmtAge(t.ageMinutes)}</span>
      </div>
      <div className="c-num price c-mcap">{fmtPrice(figureReading(t, t.priceUsd))}</div>
      <div className="c-num">
        {reading != null ? (
          <span className={`chg ${up ? "up" : "dn"}`}>
            {up ? "+" : ""}
            {reading.toFixed(1)}%
          </span>
        ) : (
          <span className="chg none" title="No 24h reading — the pool is too new or too thin to measure">
            —
          </span>
        )}
      </div>
      <div className="c-num c-liq mono-dim">{fmtCap(figureReading(t, t.liq))}</div>
      <div className="c-txns tx-cell">
        <div className="tx-main">{fmtNum(npTx)}</div>
        {npTx != null && (
          <div className="tx-split">
            <span className="b">{fmtNum(t.txns["24h"].buys)}</span>
            <span className="sl"> / </span>
            <span className="s">{fmtNum(t.txns["24h"].sells)}</span>
          </div>
        )}
      </div>
      <StarButton token={t} />
    </div>
  );
}

export function StdBoardHead({
  period = "24h",
  sortable = false,
  sortKey,
  sortDir,
  onSort,
}: {
  period?: PeriodKey;
  sortable?: boolean;
  sortKey?: SortKey;
  sortDir?: 1 | -1;
  onSort?: (k: SortKey) => void;
}) {
  const col = (key: SortKey, label: string, extraClass = "") => {
    if (!sortable)
      return <div className={`c-num ${extraClass}`}>{label}</div>;
    const on = sortKey === key;
    return (
      <div
        className={`sortable c-num ${extraClass} ${on ? "on" : ""}`}
        onClick={() => onSort?.(key)}
      >
        {label}
        <span className="sarrow">{on && sortDir === 1 ? "▲" : "▼"}</span>
      </div>
    );
  };
  return (
    <div className="row head">
      <div>#</div>
      <div>Token</div>
      {col("price", "Price")}
      {col("chg", `${period} %`)}
      {col("mcap", "MCAP", "c-mcap")}
      {col("liq", "Liquidity", "c-liq")}
      {col("vol", `Vol · ${period}`, "c-vol")}
      {col("tx", `Txns · ${period}`, "c-txns")}
      <div className="c-info">Score</div>
      <div></div>
    </div>
  );
}

export function StdBoard({
  tokens,
  period = "24h",
  sortable = false,
  emptyText = "No tokens match — try another chain or clear your search.",
  loading = false,
  limit = 0,
  expandTo = 0,
  expandNoun = "rows",
  viewAllHref,
}: {
  tokens: BoardToken[];
  period?: PeriodKey;
  sortable?: boolean;
  emptyText?: string;
  loading?: boolean;
  /** Rows to show. 0 = every row — the full board pages stay full; the home
   *  board caps so the sections under it stay reachable. Never a SILENT cap:
   *  a capped board renders the footer below with the total and a way through. */
  limit?: number;
  /** How far the expander grows the board IN PLACE. 0 = no expander, which is
   *  what every full board page wants. */
  expandTo?: number;
  /** What the button calls the rows — "Show all 15 trending". */
  expandNoun?: string;
  viewAllHref?: string;
}) {
  const { reducedMotion } = useApp();
  const [sortKey, setSortKey] = useState<SortKey>("chg");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [open, setOpen] = useState(false);

  const sorted = useMemo(() => {
    if (!sortable) return tokens;
    return [...tokens].sort((a, b) => {
      const va = SORT_VAL[sortKey](a, period);
      const vb = SORT_VAL[sortKey](b, period);
      // ⚠️ AN UNRANKABLE ROW SINKS IN BOTH DIRECTIONS.
      //
      // `-Infinity` is how this sort says "there is no number here" — an
      // unreadable change, or a real percentage with no trading behind it. It
      // is LESS THAN EVERYTHING, so on the descending board it sinks correctly
      // and on the ASCENDING one it rises to the top: one tap on the 24H %
      // header and the board is led by exactly the rows the reading rule and
      // the volume floor exist to keep off the top of it. `movers` already had
      // to learn this — -Infinity fed to a "Top Losers" filter CROWNS a quiet
      // token — and the header tap is the same bug on the full board.
      //
      // So an unrankable row goes last whatever the direction, and the real
      // values sort among themselves. It is not hidden: the row still renders
      // its own percentage, in its own column.
      const ua = !Number.isFinite(va);
      const ub = !Number.isFinite(vb);
      if (ua || ub) return ua && ub ? 0 : ua ? 1 : -1;
      return (vb - va) * -sortDir;
    });
  }, [tokens, sortable, sortKey, sortDir, period]);

  const exp = useMemo(() => expander(sorted.length, limit || sorted.length, expandTo), [sorted.length, limit, expandTo]);
  const shown = useMemo(
    () => capped(sorted, open ? exp.expanded : limit),
    [sorted, limit, open, exp.expanded],
  );

  // The flicker is fed the VISIBLE rows. Given it to the full list, its random
  // pick lands off-screen most of the time on a capped board and a live board
  // reads as a frozen one.
  const { flash, override } = useFlicker(shown.rows, reducedMotion);

  const onSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(k);
      setSortDir(-1);
    }
  };

  return (
    <div className="board">
      <StdBoardHead
        period={period}
        sortable={sortable}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
      />
      {loading ? (
        <SkeletonRows n={8} />
      ) : shown.rows.length === 0 ? (
        <div className="empty">{emptyText}</div>
      ) : (
        shown.rows.map((t, i) => (
          <StdRow
            key={t.key}
            t={t}
            i={i}
            period={period}
            flashDir={flash[t.key]}
            override={override[t.key]}
          />
        ))
      )}
      {/* The expander is a full-width bar, not a link in a corner: it is the
          board's own last row, which is where the eye already is after ten of
          them. It NAMES the number it will show — a button promising "all 40"
          that stops at 15 is the silent cap with a label on it. */}
      {exp.canExpand && (
        <button className={`board-expand ${open ? "open" : ""}`} onClick={() => setOpen((v) => !v)}>
          {open ? "Show less" : `Show ${exp.showsAll ? "all " : ""}${exp.reveal} ${expandNoun}`}
          <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      )}
      {/* Rows the expander cannot reach — the full board is the only place they
          exist, so the count and the way through stay, open or collapsed. */}
      {(exp.canExpand ? exp.beyond > 0 : shown.hidden > 0) && (
        <div className="board-foot">
          <span>
            Showing {shown.rows.length} of {shown.total}
          </span>
          {viewAllHref && (
            <Link className="board-all" href={viewAllHref}>
              View all {shown.total}
              <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 12h13M13 6l6 6-6 6" />
              </svg>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

export function NpBoard({ tokens, loading = false }: { tokens: BoardToken[]; loading?: boolean }) {
  const { reducedMotion } = useApp();
  const { flash } = useFlicker(tokens, reducedMotion);
  return (
    <div className="board np">
      <div className="row head">
        <div>#</div>
        <div>Token</div>
        <div>Age</div>
        <div className="c-num c-mcap">Price</div>
        <div className="c-num">24h %</div>
        <div className="c-num c-liq">Liquidity</div>
        <div className="c-num c-txns">Txns</div>
        <div></div>
      </div>
      {loading ? (
        <SkeletonRows n={6} />
      ) : tokens.length === 0 ? (
        <div className="empty">No fresh pairs right now — check back in a minute.</div>
      ) : (
        tokens.map((t, i) => <NpRow key={t.key} t={t} i={i} flashDir={flash[t.key]} />)
      )}
    </div>
  );
}
