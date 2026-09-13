"use client";

// Visual layout editor for a channel banner: drag the logo, $ticker+name and
// chips over the actual template (clip/artwork) to position where the bot draws
// them. Coordinates are the bot's 2560×1280 reference space; the preview scales
// with container-query units so it maps 1:1. Approximate (fonts differ from the
// server canvas) — verify the exact composite with 👁 Preview in @dexvraadminbot.
import { useRef, useState } from "react";

const REF_W = 2560;
const REF_H = 1280;

type Layout = {
  logoSize: number;
  logoX: number | "center";
  logoY: number | "center";
  showText: boolean;
  showChain: boolean;
  showPrice: boolean;
  showMcap: boolean;
  tickerFontSize: number;
  tickerX: number | "center";
  tickerY: number;
  tickerColor: string;
  nameFontSize: number;
  nameOffsetY: number;
  nameColor: string;
  metaFontSize: number;
  metaX: number | "center";
  metaY: number;
  // Pump-only overlay elements (optional — only pump carries them).
  pctX?: number | "center";
  pctY?: number;
  pctFontSize?: number;
  priceX?: number | "center";
  priceY?: number;
  priceFontSize?: number;
};
type Backdrop = { url: string; kind: "image" | "video" } | null;
type Elem = { key: string; label: string; xKey: string; yKey: string; sizeKey: string; sizeStep: number };

const BASE_ELEMS: Elem[] = [
  { key: "logo", label: "🪙 Logo", xKey: "logoX", yKey: "logoY", sizeKey: "logoSize", sizeStep: 20 },
  { key: "ticker", label: "🔤 Ticker + Name", xKey: "tickerX", yKey: "tickerY", sizeKey: "tickerFontSize", sizeStep: 6 },
  { key: "meta", label: "📊 Chips", xKey: "metaX", yKey: "metaY", sizeKey: "metaFontSize", sizeStep: 4 },
];
// Pump has its own overlay handles — the big ▲ +N% headline and old→new price.
const PUMP_ELEMS: Elem[] = [
  { key: "pct", label: "📈 % Change", xKey: "pctX", yKey: "pctY", sizeKey: "pctFontSize", sizeStep: 8 },
  { key: "price", label: "💱 Price →", xKey: "priceX", yKey: "priceY", sizeKey: "priceFontSize", sizeStep: 4 },
];
const elemsFor = (kind: string): Elem[] =>
  kind === "pump" ? [BASE_ELEMS[0], ...PUMP_ELEMS, BASE_ELEMS[1], BASE_ELEMS[2]] : BASE_ELEMS;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const numX = (v: number | "center", size: number) => (v === "center" ? Math.round((REF_W - size) / 2) : v);

export function LayoutEditor({
  kind,
  layout: initial,
  backdrop,
  onSaved,
}: {
  kind: string;
  layout: Layout;
  backdrop: Backdrop;
  onSaved: (l: Layout) => void;
}) {
  const ELEMS = elemsFor(kind);
  const isPump = kind === "pump";
  // Resolve any "center" X to a numeric left edge so dragging is unambiguous.
  const [layout, setLayout] = useState<Layout>(() => ({
    ...initial,
    logoX: numX(initial.logoX, initial.logoSize),
    logoY: initial.logoY === "center" ? Math.round((REF_H - initial.logoSize) / 2) : initial.logoY,
    tickerX: numX(initial.tickerX, initial.tickerFontSize * 4),
    metaX: numX(initial.metaX, initial.metaFontSize * 12),
    ...(isPump
      ? {
          pctX: numX(initial.pctX ?? "center", (initial.pctFontSize ?? 172) * 4),
          priceX: numX(initial.priceX ?? "center", (initial.priceFontSize ?? 78) * 6),
        }
      : {}),
  }));
  const [sel, setSel] = useState<string>(isPump ? "pct" : "ticker");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ xKey: string; yKey: string; sx: number; sy: number; px: number; py: number } | null>(null);

  const pctX = (v: number | "center") => ((typeof v === "number" ? v : REF_W / 2) / REF_W) * 100;
  const pctY = (v: number) => (v / REF_H) * 100;
  const cqw = (px: number) => `${(px / REF_W) * 100}cqw`;

  const down = (xKey: string, yKey: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSel(ELEMS.find((el) => el.xKey === xKey)!.key);
    drag.current = { xKey, yKey, sx: layout[xKey as keyof Layout] as number, sy: layout[yKey as keyof Layout] as number, px: e.clientX, py: e.clientY };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const w = boxRef.current?.getBoundingClientRect().width || 1;
    const f = REF_W / w; // px → reference units (same factor for X and Y: box is 2:1)
    setLayout((l) => ({
      ...l,
      [d.xKey]: clamp(Math.round(d.sx + (e.clientX - d.px) * f), 0, REF_W),
      [d.yKey]: clamp(Math.round(d.sy + (e.clientY - d.py) * f), 0, REF_H),
    }));
    setDirty(true);
  };
  const up = () => {
    drag.current = null;
  };

  const bump = (delta: number) => {
    const el = ELEMS.find((e) => e.key === sel)!;
    setLayout((l) => ({ ...l, [el.sizeKey]: clamp((l[el.sizeKey as keyof Layout] as number) + delta, 12, REF_W) }));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch("/api/admin/channel-banners", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, layout }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.layout) {
        setLayout((l) => ({
          ...l,
          ...j.layout,
          logoX: numX(j.layout.logoX, j.layout.logoSize),
          tickerX: numX(j.layout.tickerX, j.layout.tickerFontSize * 4),
          metaX: numX(j.layout.metaX, j.layout.metaFontSize * 12),
          ...(isPump
            ? {
                pctX: numX(j.layout.pctX ?? "center", (j.layout.pctFontSize ?? 172) * 4),
                priceX: numX(j.layout.priceX ?? "center", (j.layout.priceFontSize ?? 78) * 6),
              }
            : {}),
        }));
        setDirty(false);
        onSaved(j.layout);
      }
    } finally {
      setSaving(false);
    }
  };

  const elBox = (key: string) => ({
    outline: sel === key ? "2px solid #4EE6A8" : "1px dashed rgba(255,255,255,.5)",
    outlineOffset: 2,
    cursor: "grab",
    touchAction: "none" as const,
    userSelect: "none" as const,
  });

  return (
    <div style={{ marginTop: 10 }}>
      <div
        ref={boxRef}
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "2 / 1",
          containerType: "inline-size",
          borderRadius: 10,
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,.12)",
          background: "#0b1220",
        }}
      >
        {backdrop?.kind === "video" ? (
          <video src={backdrop.url} autoPlay loop muted playsInline style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        ) : backdrop?.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={backdrop.url} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        ) : null}

        {/* Logo (drag by top-left) */}
        <div
          onPointerDown={down("logoX", "logoY")}
          onPointerMove={move}
          onPointerUp={up}
          style={{
            position: "absolute",
            left: `${pctX(layout.logoX)}%`,
            top: `${pctY(layout.logoY as number)}%`,
            width: cqw(layout.logoSize),
            height: cqw(layout.logoSize),
            borderRadius: "50%",
            background: "rgba(78,230,168,.18)",
            display: "grid",
            placeItems: "center",
            color: "#EAF6F2",
            fontSize: cqw(120),
            ...elBox("logo"),
          }}
        >
          ◆
        </div>

        {layout.showText && (
          <>
            {isPump && (
              <>
                {/* ▲ +N% headline (pump) — drag by anchor, vertical-centered */}
                <div
                  onPointerDown={down("pctX", "pctY")}
                  onPointerMove={move}
                  onPointerUp={up}
                  style={{
                    position: "absolute",
                    left: `${pctX(layout.pctX ?? 250)}%`,
                    top: `${pctY(layout.pctY ?? 545)}%`,
                    transform: "translateY(-50%)",
                    whiteSpace: "nowrap",
                    fontSize: cqw(layout.pctFontSize ?? 172),
                    fontWeight: 800,
                    color: layout.tickerColor || "#33E5C9",
                    lineHeight: 1,
                    ...elBox("pct"),
                  }}
                >
                  ▲ +28%
                </div>
                {/* old → new price (pump) */}
                <div
                  onPointerDown={down("priceX", "priceY")}
                  onPointerMove={move}
                  onPointerUp={up}
                  style={{
                    position: "absolute",
                    left: `${pctX(layout.priceX ?? 262)}%`,
                    top: `${pctY(layout.priceY ?? 762)}%`,
                    transform: "translateY(-50%)",
                    whiteSpace: "nowrap",
                    fontSize: cqw(layout.priceFontSize ?? 78),
                    fontWeight: 700,
                    lineHeight: 1,
                    ...elBox("price"),
                  }}
                >
                  <span style={{ color: "#93AAA4" }}>$0.032</span>
                  <span style={{ color: layout.tickerColor || "#33E5C9", margin: `0 ${cqw((layout.priceFontSize ?? 78) * 0.3)}` }}>→</span>
                  <span style={{ color: layout.tickerColor || "#33E5C9" }}>$0.049</span>
                </div>
              </>
            )}
            {/* Ticker + name (drag by ticker anchor; vertical-centered) */}
            <div
              onPointerDown={down("tickerX", "tickerY")}
              onPointerMove={move}
              onPointerUp={up}
              style={{
                position: "absolute",
                left: `${pctX(layout.tickerX)}%`,
                top: `${pctY(layout.tickerY)}%`,
                transform: "translateY(-50%)",
                whiteSpace: "nowrap",
                ...elBox("ticker"),
              }}
            >
              <div style={{ fontSize: cqw(layout.tickerFontSize), fontWeight: 800, color: layout.tickerColor || "#EAF6F2", lineHeight: 1 }}>$SAMPLE</div>
              <div style={{ fontSize: cqw(layout.nameFontSize), color: layout.nameColor || "#B8CCC8", marginTop: cqw(layout.nameOffsetY - layout.tickerFontSize) }}>Sample Token</div>
            </div>

            {/* Chips (drag by row start) */}
            <div
              onPointerDown={down("metaX", "metaY")}
              onPointerMove={move}
              onPointerUp={up}
              style={{
                position: "absolute",
                left: `${pctX(layout.metaX)}%`,
                top: `${pctY(layout.metaY)}%`,
                display: "flex",
                gap: cqw(layout.metaFontSize * 0.5),
                whiteSpace: "nowrap",
                ...elBox("meta"),
              }}
            >
              {[
                layout.showChain !== false ? "SOLANA" : null,
                layout.showPrice !== false ? "$0.0042" : null,
                layout.showMcap !== false ? (kind === "pump" ? "MCAP $120M" : "MC $1.2M") : null,
              ]
                .filter((t): t is string => Boolean(t))
                .map((t) => (
                <span
                  key={t}
                  style={{
                    fontSize: cqw(layout.metaFontSize),
                    padding: `${cqw(layout.metaFontSize * 0.35)} ${cqw(layout.metaFontSize * 0.62)}`,
                    borderRadius: 999,
                    border: "1px solid rgba(120,220,210,.5)",
                    background: "rgba(255,255,255,.06)",
                    color: "#EAF6F2",
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Chip content toggles */}
      {layout.showText && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <span className="a-chain" style={{ fontSize: 11 }}>Chips:</span>
          {([["showChain", "Chain"], ["showPrice", "Price"], ["showMcap", "MC"]] as const).map(([k, lbl]) => (
            <button
              key={k}
              className={`abtn ${layout[k] !== false ? "p" : ""}`}
              style={{ fontSize: 11, padding: "4px 10px" }}
              onClick={() => {
                setLayout((l) => ({ ...l, [k]: l[k] === false }));
                setDirty(true);
              }}
            >
              {layout[k] !== false ? "✓ " : "✕ "}
              {lbl}
            </button>
          ))}
        </div>
      )}

      {/* Text colours */}
      {layout.showText && (
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginTop: 8 }}>
          <label className="a-chain" style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
            $ticker color
            <input
              type="color"
              value={layout.tickerColor || "#FFFFFF"}
              onChange={(e) => {
                setLayout((l) => ({ ...l, tickerColor: e.target.value }));
                setDirty(true);
              }}
              style={{ width: 34, height: 24, padding: 0, border: "none", background: "none" }}
            />
          </label>
          <label className="a-chain" style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
            Name color
            <input
              type="color"
              value={layout.nameColor || "#B8CCC8"}
              onChange={(e) => {
                setLayout((l) => ({ ...l, nameColor: e.target.value }));
                setDirty(true);
              }}
              style={{ width: 34, height: 24, padding: 0, border: "none", background: "none" }}
            />
          </label>
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <span className="a-chain" style={{ fontSize: 11 }}>Drag to move. Selected:</span>
        {ELEMS.map((e) => (
          <button key={e.key} className={`abtn ${sel === e.key ? "p" : ""}`} onClick={() => setSel(e.key)} style={{ fontSize: 11, padding: "4px 8px" }}>
            {e.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="abtn" onClick={() => bump(-(ELEMS.find((e) => e.key === sel)!.sizeStep))}>➖ size</button>
        <button className="abtn" onClick={() => bump(ELEMS.find((e) => e.key === sel)!.sizeStep)}>➕ size</button>
        <button className="abtn p" onClick={save} disabled={saving || !dirty}>
          {saving ? "Saving…" : dirty ? "Save layout" : "Saved ✓"}
        </button>
      </div>
    </div>
  );
}
