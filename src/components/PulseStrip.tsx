"use client";

import Link from "next/link";
import { CHAINS } from "@/config/chains";
import { fmtCap } from "@/lib/format";
import { BRAND_NAME } from "@/config/brand";
import { useApp } from "./AppState";
import { ChainLogo } from "./ChainLogo";

// Clean line icons (Lucide-style) instead of emoji section-glyphs — crisp and
// identical across every device, not the OS emoji-of-the-day.
function Ic({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d.split("|").map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}
const IC = {
  pulse: "M22 12h-4l-3 9L9 3l-3 9H2", // activity line
  gauge: "m12 14 4-4|M3.34 19a10 10 0 1 1 17.32 0", // half-gauge
  signal: "M4.9 19.1C1 15.2 1 8.8 4.9 4.9|M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5|M12 12h.01|M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5|M19.1 4.9C23 8.8 23 15.1 19.1 19",
  flame: "M15 14c.2-1 .7-1.7 1.5-2.5C18 10 18.5 8.5 18 7c-.5-1.4-1.6-2.6-3-3 .5 2-1 3.5-2.5 4.5C9 10 8 12 8 14a5 5 0 0 0 10 0",
};

function FearGreedGauge({ value }: { value: number }) {
  const cx = 100,
    cy = 100,
    r = 78;
  const segs: [string, number, number][] = [
    ["#FF4D6D", 0, 36],
    ["#FF9D4D", 36, 72],
    ["#FFD166", 72, 108],
    ["#A8E063", 108, 144],
    ["#3DF59F", 144, 180],
  ];
  const rad = (a: number) => (Math.PI / 180) * (180 - a);
  const arc = (a1: number, a2: number, c: string, key: number) => {
    const x1 = cx + r * Math.cos(rad(a1)),
      y1 = cy - r * Math.sin(rad(a1)),
      x2 = cx + r * Math.cos(rad(a2)),
      y2 = cy - r * Math.sin(rad(a2));
    return (
      <path
        key={key}
        d={`M${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 0 1 ${x2.toFixed(1)},${y2.toFixed(1)}`}
        fill="none"
        stroke={c}
        strokeWidth="12"
        strokeLinecap="round"
      />
    );
  };
  const ang = -90 + (value / 100) * 180;
  return (
    <svg viewBox="0 0 200 110">
      {segs.map((s, i) => arc(s[1] + 3, s[2] - 3, s[0], i))}
      <g transform={`rotate(${ang} ${cx} ${cy})`}>
        <line x1={cx} y1={cy - 4} x2={cx} y2={cy - 56} stroke="#F1F5FB" strokeWidth="3.5" strokeLinecap="round" />
      </g>
      <circle cx={cx} cy={cy} r="6.5" fill="#F1F5FB" />
      <circle cx={cx} cy={cy} r="2.8" fill="#0B0E15" />
    </svg>
  );
}

function fngZone(v: number): [string, string] {
  if (v < 25) return ["Extreme Fear", "#FF4D6D"];
  if (v < 45) return ["Fear", "#FF9D4D"];
  if (v < 55) return ["Neutral", "#FFD166"];
  if (v < 75) return ["Greed", "#A8E063"];
  return ["Extreme Greed", "#3DF59F"];
}

export function PulseStrip() {
  const { data, fng } = useApp();
  const heat = data?.heat ?? [];
  const hottest = heat.length ? heat.reduce((a, b) => (a.temp > b.temp ? a : b)) : null;
  const fngVal = fng?.value ?? null;
  const zone = fngVal != null ? fngZone(fngVal) : null;

  return (
    <div className="pulse-strip">
      <div className="wcard" title="Which chains are hottest right now — a heat score from 24h volume + momentum, per chain.">
        <div className="wcard-head">
          <div className="ic"><Ic d={IC.pulse} /></div>
          <h3>{BRAND_NAME} Pulse</h3>
          <span className="live-pill">● LIVE</span>
          <a className="more">
            {hottest ? `${CHAINS[hottest.chain]?.label ?? hottest.chain} ${hottest.temp}°` : "…"}
          </a>
        </div>
        <div className="heat">
          {heat.map((h) => {
            const c = CHAINS[h.chain];
            if (!c) return null;
            return (
              <div className="heat-cell" key={h.chain}>
                <div className="heat-chain">
                  <ChainLogo chain={h.chain} size={16} />
                  <span className="heat-name">{c.label}</span>
                </div>
                <div className="heat-temp">
                  {h.temp}<span className="deg">°</span>
                </div>
                <div className="heat-kv">
                  <span>VOL</span>
                  <b>{fmtCap(h.vol24h)}</b>
                </div>
                <div className="heat-bar">
                  <i style={{ width: `${Math.min(h.temp * 2.2, 100)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="wcard">
        <div className="wcard-head">
          <div className="ic"><Ic d={IC.gauge} /></div>
          <h3>Fear &amp; Greed</h3>
          <a className="more">{fng?.source === "live" ? "LIVE" : "History"}</a>
        </div>
        <div className="fg">
          {fngVal != null && <FearGreedGauge value={fngVal} />}
          <div className="fg-col">
            <div className="fg-num" style={{ color: zone?.[1] }}>{fngVal ?? "…"}</div>
            <div className="fg-label" style={{ color: zone?.[1] }}>{zone?.[0] ?? ""}</div>
            <div className="fg-note">
              {fng ? `Updated ${fng.updatedMinutesAgo} min ago` : "Loading…"}
            </div>
          </div>
        </div>
      </div>

      <div className="wcard">
        <div className="wcard-head">
          <div className="ic"><Ic d={IC.signal} /></div>
          <h3>Signals</h3>
          <Link className="more" href="/signals">View all</Link>
        </div>
        <div className="wire-list">
          {(data?.wire ?? []).map((w, i) => (
            <div className="wire-item" key={i}>
              <span className="wdot" style={{ background: w.color, boxShadow: `0 0 8px ${w.color}` }} />
              <span className="wire-text" dangerouslySetInnerHTML={{ __html: w.html }} />
              <span className="t">{w.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
