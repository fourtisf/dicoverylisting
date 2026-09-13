"use client";

import { useEffect, useMemo, useState } from "react";
import type { BoardToken, Trade } from "@/lib/types";
import { CHAINS } from "@/config/chains";
import { fmtNum, fmtPrice } from "@/lib/format";
import { figureReading } from "@/lib/home";
import { TRADES_POLL_MS } from "@/lib/trades";

function ago(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
const short = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

// ⚠️ THERE IS NO DEMO DATA HERE ANY MORE, AND THERE MUST NEVER BE AGAIN.
//
// This file used to carry `demoTrades(t)`: twelve deterministic buys and sells
// with invented USD amounts, invented token amounts, a price jittered ±0.5%
// around the card's, and invented trader addresses ("0x" + random hex). It was
// drawn whenever the feed could not be read — and the only thing separating it
// from real trades was a 10px label reading "Recent" instead of "Live" beside a
// dot at 40% opacity. A visitor could not tell, and on a box being rate-limited
// by GeckoTerminal that was EVERY token page.
//
// This repo's whole doctrine is that an unreadable reading is a blank, never a
// fabricated number — a printed `0.00%` is refused on the trending board, and a
// hash-generated price curve was just deleted from this very page. Twelve made
// up transactions with trader addresses is the same lie with more rows.
//
// So: real trades, or a sentence saying which of the two reasons there are none.

// ⚠️ NOT A NUMBER OF ITS OWN. It used to be 12s against a route that cached for
// 8s, so every poll was a guaranteed upstream miss. lib/trades keeps the two
// together — the chart learnt the same rule as `pollMsFor`.
const POLL_MS = TRADES_POLL_MS;
/** The ceiling the failure back-off climbs to — still often enough that a feed
 *  which recovers is picked up inside a minute and a half. */
const MAX_POLL_MS = 96_000;
const tradeKey = (tr: Trade) => `${tr.ts}:${tr.trader}:${tr.usd.toFixed(2)}`;

/**
 * What the panel can still SAY when the trade list cannot be read.
 *
 * ⚠️ "PERBAIKI TRANSAKSINYA, AMBIL AJA SEMUA DARI DEXSCREENER KALO GECKO
 * TERMINAL DELAY" — and the honest half of that is: a trade LIST has exactly
 * ONE free source. GeckoTerminal publishes `/pools/{pool}/trades`; DexScreener
 * publishes no per-trade endpoint on any documented host (`latest/dex/tokens`,
 * `latest/dex/pairs`, `token-pairs/v1`, `search` — none of them returns
 * individual fills), and its own site reads them off `io.dexscreener.com`,
 * which answers this box 403. A second source for the ROWS does not exist to be
 * wired, and shipping a guess that cannot fire reads exactly like one that
 * never helps.
 *
 * What DexScreener DOES publish is the pool's own buy/sell counts and volume —
 * and they are already in hand: `t.txns` and `t.vol` ride the board payload
 * this component is handed, so this costs NOT ONE REQUEST. An apology over an
 * empty table, on a token doing 1.3K transactions a day, is strictly worse than
 * the true sentence "1,247 buys · 812 sells · $34.2K in the last 24h".
 *
 * ⚠️ ONLY FROM A LIVE ROW. `figureReading` is the one owner of "is this figure
 * a measurement or a captured-at-listing default", and a seed row's zeros are
 * not a quiet market — they are numbers nobody took. Rendering those here would
 * be the fabricated reading this repo refuses everywhere else, one panel over.
 */
function activity(t: BoardToken): { buys: number; sells: number; vol: number | null } | null {
  if (t.source !== "live") return null;
  const tx = t.txns?.["24h"];
  if (!tx) return null;
  const buys = Number(tx.buys) || 0;
  const sells = Number(tx.sells) || 0;
  // Zero trades in a day is a READING and a real answer about the token — but
  // it is the same answer the empty table already gives, so it adds nothing.
  if (buys + sells <= 0) return null;
  return { buys, sells, vol: figureReading(t, t.vol?.["24h"] ?? null) };
}

export function TokenTrades({ t }: { t: BoardToken }) {
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [live, setLive] = useState(false);
  /** Why there are none — the panel's whole answer when the list is empty. */
  const [why, setWhy] = useState<string | null>(null);
  const network = CHAINS[t.chain]?.geckoNetwork ?? null;
  // ⚠️ ONLY THE CHAIN DECIDES WHETHER TO ASK. This used to require
  // `t.poolAddress` as well and short-circuit to "no indexed pool for this
  // token yet" without a single request — but that field is null for every
  // token DexScreener priced rather than GeckoTerminal, which GT frequently
  // indexes perfectly well. The panel would have asserted, to a visitor, that a
  // token with a live feed had no pool. The route resolves the pool now; the
  // address is the question, the pool is a hint.
  const canLive = Boolean(network);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setTrades(null);
    setLive(false);
    setWhy(null);

    if (!canLive) {
      // A token with no indexed pool has no trade feed. That is a fact about
      // the token, and saying it is the entire job here.
      setTrades([]);
      setWhy("No indexed pool for this token yet, so there are no trades to show.");
      return;
    }

    const url =
      `/api/trades?chain=${encodeURIComponent(t.chain)}&address=${encodeURIComponent(t.address)}` +
      (t.poolAddress ? `&pool=${encodeURIComponent(t.poolAddress)}` : "");

    // ⚠️ A BUSY GECKOTERMINAL WAS BEING ASKED HARDER, NOT LESS.
    //
    // This route is one of the app's biggest GT consumers — every open token
    // page polls it every ~12s — against a budget of a handful of requests a
    // minute for the WHOLE box, shared with the board, the pools and the
    // candles. So the state the reader reported ("live data is busy") is a
    // state in which this panel alone can spend five requests a minute proving
    // the same refusal, per open tab, for ever. That is the CoinGecko sweep's
    // defect and `dsChart`'s 403 retry, on a third caller.
    //
    // A failure therefore BACKS OFF and a success resets it — and a hidden tab
    // is not asked at all, because nobody is reading it. Neither costs a
    // visitor anything: the panel keeps the rows it has, and the first poll
    // after the tab comes forward is immediate.
    let wait: number = POLL_MS;

    const tick = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      try {
        const r = await fetch(url, { cache: "no-store" });
        const j = (await r.json()) as { trades?: Trade[]; why?: string | null };
        if (stop) return;
        if (j.trades && j.trades.length) {
          setTrades(j.trades);
          setLive(true);
          setWhy(null);
          wait = POLL_MS;
        } else {
          // A poll that fails never blanks a panel that already has REAL
          // trades — the pool did not stop trading because one request did not
          // land. But it does stop claiming to be live.
          setLive(false);
          setTrades((prev) => (prev && prev.length ? prev : []));
          setWhy(j.why ?? "Couldn't read recent trades just now.");
          wait = Math.min(wait * 2, MAX_POLL_MS);
        }
      } catch {
        if (stop) return;
        setLive(false);
        setTrades((prev) => (prev && prev.length ? prev : []));
        setWhy("Couldn't read recent trades just now.");
        wait = Math.min(wait * 2, MAX_POLL_MS);
      } finally {
        if (!stop) timer = setTimeout(tick, wait);
      }
    };
    tick();

    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.chain, t.address, t.poolAddress]);

  const sym = useMemo(() => t.symbol.replace(/^\$/, ""), [t.symbol]);
  // Computed from the token in hand, so it is ready before the first poll and
  // survives every one that fails.
  const act = useMemo(() => activity(t), [t]);

  return (
    <div className="trades panel" style={{ padding: 0 }}>
      <div className="trades-head">
        Transactions
        {/* "Recent" used to be the only tell that the rows below were made up.
            With the fabricator gone the rows are always real, so the marker
            says whether the feed is CURRENT — and stops pulsing when it is
            not. A live dot over a stale panel is the reassuring reading. */}
        <span className={`trades-live ${live ? "on" : ""}`}>
          <span className="dot-live" /> {live ? "Live" : trades && trades.length ? "Stale" : "—"}
        </span>
      </div>
      {/* Real rows, but not current ones: the reader is looking at the last
          good read and is told so, rather than being left to trust a feed that
          silently stopped moving. */}
      {why && trades && trades.length > 0 && <div className="trades-stale">{why}</div>}
      <div className="trades-scroll">
        <div className="trades-row trades-hd">
          <div>Time</div>
          <div>Type</div>
          <div className="c-num">USD</div>
          <div className="c-num tr-amt">{sym}</div>
          <div className="c-num">Price</div>
          <div className="tr-trader">Trader</div>
        </div>
        {trades == null ? (
          <div className="board-loading"><span className="dot-live" /> Loading trades…</div>
        ) : trades.length === 0 ? (
          // The state that used to be filled with invented rows. It says which
          // of the two reasons it is — a token with no pool and a feed we could
          // not read need different reactions from the reader.
          <div className="trades-none">
            <div>{why ?? "No trades to show."}</div>
            {/* The reader came here to see whether the token is trading. When
                the per-trade feed cannot answer that, the pool's own counts
                can — and they are already on the page. */}
            {act && (
              <div className="trades-act">
                {/* ⚠️ GROUPED, NEVER ABBREVIATED. `fmtNum` gives "1.2K",
                    which is right for a market cap and wrong for a COUNT of
                    transactions: 1,247 and 1,299 both render "1.2K", and the
                    number a reader came for is how many trades there were.
                    `qty()` in the trade bot's receipt carries the same rule for
                    the same reason. */}
                <span className="ta-b">{act.buys.toLocaleString("en-US")} buys</span>
                <span className="ta-dot">·</span>
                <span className="ta-s">{act.sells.toLocaleString("en-US")} sells</span>
                {act.vol != null && (
                  <>
                    <span className="ta-dot">·</span>
                    <span>${fmtNum(act.vol)} volume</span>
                  </>
                )}
                <span className="ta-w">in the last 24h · via DexScreener</span>
              </div>
            )}
          </div>
        ) : (
          trades.map((tr) => (
            <div className={`trades-row ${tr.kind}`} key={tradeKey(tr)}>
              <div className="tr-time">{ago(tr.ts)} ago</div>
              <div className={`tr-type ${tr.kind}`}>{tr.kind === "buy" ? "▲ Buy" : "▼ Sell"}</div>
              <div className="c-num tr-usd">${fmtNum(tr.usd)}</div>
              <div className="c-num tr-amt">{fmtNum(tr.amount)}</div>
              <div className="c-num">{fmtPrice(tr.price)}</div>
              <div className="tr-trader">{short(tr.trader)}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
