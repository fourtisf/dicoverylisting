"use client";

import { fmtPrice } from "@/lib/format";
import { changeReading, tradedEnough } from "@/lib/home";
import { coinBg, monogram } from "@/lib/visual";
import { logoSrc } from "@/lib/logo";
import { useApp } from "./AppState";

export function Ticker() {
  const { data } = useApp();
  // Ranked and shown through the sane reading — a five-million-percent figure
  // off a near-dead pool must not lead the top-movers bar (see changeReading).
  // …and through `tradedEnough`, which is the same rule at the other end of the
  // scale. This marquee is a numbered top-EIGHT on every page of the site, so a
  // token that traded five cents in a day led it — while the board directly
  // underneath, which reads the volume, ranked it tenth. One screen, two
  // rankings, disagreeing. EXCLUDED rather than demoted, like `movers`: there
  // is no honest place in a curated eight for a number that means nothing.
  const top = data
    ? data.tokens
        .filter(tradedEnough)
        .map((t) => ({ t, r: changeReading(t, "24h") }))
        .filter((x): x is { t: (typeof data.tokens)[number]; r: number } => x.r != null)
        .sort((a, b) => b.r - a.r)
        .slice(0, 8)
    : [];
  if (!top.length) return <div className="ticker" />;

  const renderItems = (prefix: string) =>
    top.map(({ t, r }, i) => {
      const up = r >= 0;
      return (
        <span className="tick-item" key={prefix + t.key + i}>
          <span className="rnk">{i + 1}.</span>
          <span className="tick-coin" style={{ background: coinBg(t.gradient) }}>
            {logoSrc(t.logoUrl) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoSrc(t.logoUrl)}
                alt=""
                style={{ width: "100%", height: "100%", borderRadius: "50%", objectFit: "cover" }}
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
              />
            ) : (
              <span className="coin-mono">{monogram(t.symbol)}</span>
            )}
          </span>
          <span className="sym">{t.symbol}</span>
          <span className="px">{fmtPrice(t.priceUsd)}</span>
          <span className={`pct ${up ? "up" : "dn"}`}>
            ({up ? "+" : ""}
            {r.toFixed(1)}%)
          </span>
        </span>
      );
    });

  // items rendered twice so the -50% marquee loops seamlessly (prototype trick)
  return (
    <div className="ticker">
      <div className="ticker-track">
        {renderItems("a")}
        {renderItems("b")}
      </div>
    </div>
  );
}
