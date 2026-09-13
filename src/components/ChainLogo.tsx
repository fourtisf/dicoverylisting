import type { CSSProperties } from "react";
import { chainOf } from "@/config/chains";

// Recognizable per-chain mark (nominative use — labels which chain a token
// trades on, like every DEX aggregator). Kept as compact inline SVG so it
// stays crisp and needs no network image.
function Solana({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Solana">
      <defs>
        <linearGradient id="sol" x1="3" y1="20" x2="21" y2="4" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9945FF" />
          <stop offset="1" stopColor="#19FB9B" />
        </linearGradient>
      </defs>
      {/* three slanted bars — top & bottom lean one way, middle the other */}
      <g fill="url(#sol)">
        <path d="M6.4 4.6H21l-3.4 3.2H3z" />
        <path d="M3 10.4h14.6L21 13.6H6.4z" />
        <path d="M6.4 16.2H21l-3.4 3.2H3z" />
      </g>
    </svg>
  );
}
function Ethereum({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Ethereum">
      <g fill="#8A92B2">
        <path d="M12 2 5.5 12.3 12 16z" />
        <path d="M12 2 18.5 12.3 12 16z" fill="#62688F" />
        <path d="M12 17.2 5.5 13.5 12 22z" />
        <path d="M12 17.2 18.5 13.5 12 22z" fill="#62688F" />
      </g>
    </svg>
  );
}
function Bnb({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="BNB Chain">
      <circle cx="12" cy="12" r="10" fill="#F3BA2F" />
      {/* official Binance/BNB mark, scaled to sit inside the coin */}
      <g fill="#fff" transform="translate(12 12) scale(0.64) translate(-12 -12)">
        <path d="M16.624 13.9202l2.7175 2.7175-7.353 7.353-7.353-7.352 2.7175-2.7175 4.6355 4.6355 4.6355-4.6365zm4.6355-4.6355L24 12l-2.7415 2.7415L18.5415 12l2.7175-2.7153zm-9.271.0005l2.7188 2.7167-2.7189 2.7186-2.7175-2.7168.0006-.0006.4762-.4763.2307-.2304 2.0093-2.011zM5.458 9.2842l2.7175 2.7178L5.458 14.72l-2.7176-2.718L5.458 9.2842zM11.9885.2842l7.353 7.3525-2.7168 2.7175-4.6362-4.6355-4.6355 4.6383L4.6362 7.6372 11.9885.2842z" />
      </g>
    </svg>
  );
}
function Base({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Base">
      <circle cx="12" cy="12" r="10" fill="#0052FF" />
      <path d="M12 5.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 6.4-5.4H8.6v-2.2h9.8A6.5 6.5 0 0 0 12 5.5z" fill="#fff" />
    </svg>
  );
}
function Ton({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="TON">
      <circle cx="12" cy="12" r="10" fill="#0098EA" />
      <path d="M7.5 8.5h9L12 17zM12 9.7 9.6 9.7 12 14.4 14.4 9.7z" fill="#fff" />
    </svg>
  );
}
function Robinhood({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Robinhood Chain">
      <circle cx="12" cy="12" r="10" fill="#0B0F10" />
      {/* stylized feather quill */}
      <path
        d="M16.5 6.2c-3.4.3-6.2 2-7.7 4.8-.7 1.3-1 2.8-1 4.4l-1 1.4c-.2.3 0 .7.4.6l1.7-.4c1.4.5 3 .5 4.4-.1 2.9-1.3 4.7-4.1 5.1-7.6l.4-2.9c0-.4-.3-.7-.7-.6l-1.3.9z"
        fill="#C5F94B"
      />
      <path d="M9 15.5c1.6-2.9 3.9-4.9 6.7-6" stroke="#0B0F10" strokeWidth="1" fill="none" strokeLinecap="round" />
    </svg>
  );
}
function Tron({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Tron">
      <circle cx="12" cy="12" r="10" fill="#EF0027" />
      {/* TRON angular tri-mark */}
      <path
        d="M6.2 7.4 15.4 8.9c.3 0 .5.2.6.4l2 3.3c.2.3.1.6-.1.8L11.6 18c-.3.3-.8.1-.9-.3L6 8c-.1-.4.2-.7.6-.6zm1.7 1.5 3 5.9.1-4.9zm4.2 1 .0 4.6 3.8-3.2zm.9-.9 2.6 1.9-1.2-2z"
        fill="#fff"
      />
    </svg>
  );
}

const MAP: Record<string, (p: { s: number }) => JSX.Element> = {
  solana: Solana,
  ethereum: Ethereum,
  bsc: Bnb,
  base: Base,
  ton: Ton,
  robinhood: Robinhood,
  tron: Tron,
  sui: Sui,
  plasma: Plasma,
  polygon: Polygon,
  arbitrum: Arbitrum,
  optimism: Optimism,
  avalanche: Avalanche,
  berachain: Berachain,
  sonic: Sonic,
  hyperevm: HyperEvm,
  abstract: Abstract,
  apechain: ApeChain,
  blast: Blast,
  sei: Sei2,
  aptos: Aptos,
  unichain: Unichain,
};

function Sui({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Sui">
      <circle cx="12" cy="12" r="10" fill="#4DA2FF" />
      {/* Sui water-drop mark */}
      <path
        d="M12 4.6c2.9 3.6 5 6 5 8.9a5 5 0 1 1-10 0c0-2.9 2.1-5.3 5-8.9z"
        fill="#fff"
      />
      <path
        d="M12 8.2c1.8 2.2 3.1 3.7 3.1 5.5a3.1 3.1 0 1 1-6.2 0c0-1.8 1.3-3.3 3.1-5.5z"
        fill="#4DA2FF"
        opacity=".55"
      />
    </svg>
  );
}
function Plasma({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Plasma">
      <rect x="2" y="2" width="20" height="20" rx="6" fill="#0D1512" />
      <rect x="2" y="2" width="20" height="20" rx="6" fill="none" stroke="#00FF9C" strokeWidth="1.6" />
      {/* plasma arc */}
      <path
        d="M6.5 14.5c2-.6 3-3.4 5.5-3.4s3.2 2.6 5.5 2.2"
        fill="none"
        stroke="#00FF9C"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="12" cy="11.1" r="1.6" fill="#00FF9C" />
    </svg>
  );
}
// ── Added chains — recognizable brand marks (nominative use), same style. ────
function Polygon({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Polygon">
      <circle cx="12" cy="12" r="10" fill="#8247E5" />
      {/* purple 'polygon' — hexagon outline + solid inner hexagon */}
      <path d="M12 5.6 17.5 8.8 17.5 15.2 12 18.4 6.5 15.2 6.5 8.8Z" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M12 9.4 15 11.1 15 14.9 12 16.6 9 14.9 9 11.1Z" fill="#fff" />
    </svg>
  );
}
function Arbitrum({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Arbitrum">
      <circle cx="12" cy="12" r="10" fill="#213147" />
      {/* navy field + light-blue 'A' peak */}
      <path d="M8.5 16.4 11.2 9.6c.3-.7 1.3-.7 1.6 0l2.7 6.8" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.1 11.5 14.9 16" fill="none" stroke="#28A0F0" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
function Optimism({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Optimism">
      <circle cx="12" cy="12" r="10" fill="#FF0420" />
      {/* the OP 'O' */}
      <circle cx="12" cy="12" r="4.4" fill="none" stroke="#fff" strokeWidth="2.6" />
    </svg>
  );
}
function Avalanche({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Avalanche">
      <circle cx="12" cy="12" r="10" fill="#E84142" />
      {/* white 'A' with a triangular cut */}
      <path d="M12 7.1 6.5 16.9h2.6l.95-1.75h4L14.9 16.9h2.6L12 7.1Zm0 4.1 1 1.85h-2L12 11.2Z" fill="#fff" />
    </svg>
  );
}
function Berachain({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Berachain">
      <circle cx="12" cy="12" r="10" fill="#B8651B" />
      {/* bear face */}
      <circle cx="8.3" cy="8.7" r="1.9" fill="#fff" />
      <circle cx="15.7" cy="8.7" r="1.9" fill="#fff" />
      <circle cx="12" cy="12.6" r="4.4" fill="#fff" />
      <circle cx="10.3" cy="11.8" r="0.8" fill="#B8651B" />
      <circle cx="13.7" cy="11.8" r="0.8" fill="#B8651B" />
      <ellipse cx="12" cy="14" rx="1.5" ry="1.1" fill="#B8651B" />
    </svg>
  );
}
function Sonic({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Sonic">
      <circle cx="12" cy="12" r="10" fill="#5AB8F0" />
      <text x="12" y="16.4" textAnchor="middle" fontSize="13" fontWeight="800" fill="#fff" fontFamily="system-ui,-apple-system,'Segoe UI',sans-serif">S</text>
    </svg>
  );
}
function HyperEvm({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="HyperEVM">
      <circle cx="12" cy="12" r="10" fill="#0B2E2A" />
      {/* Hyperliquid mint 'H' */}
      <rect x="8" y="8" width="1.9" height="8" rx="0.6" fill="#50D2C1" />
      <rect x="14.1" y="8" width="1.9" height="8" rx="0.6" fill="#50D2C1" />
      <rect x="8" y="11.05" width="8" height="1.9" fill="#50D2C1" />
    </svg>
  );
}
function Abstract({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Abstract">
      <circle cx="12" cy="12" r="10" fill="#3CE68B" />
      {/* rounded-square mark */}
      <rect x="8" y="8" width="8" height="8" rx="2.4" fill="none" stroke="#06251A" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="1.7" fill="#06251A" />
    </svg>
  );
}
function ApeChain({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="ApeChain">
      <circle cx="12" cy="12" r="10" fill="#0054FA" />
      {/* ape face — side ears distinguish it from the bear */}
      <circle cx="6.9" cy="12" r="1.8" fill="#fff" />
      <circle cx="17.1" cy="12" r="1.8" fill="#fff" />
      <circle cx="12" cy="12" r="4.4" fill="#fff" />
      <circle cx="10.4" cy="11.4" r="0.75" fill="#0054FA" />
      <circle cx="13.6" cy="11.4" r="0.75" fill="#0054FA" />
      <path d="M10.2 13.7c.9.8 2.7.8 3.6 0" fill="none" stroke="#0054FA" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}
function Blast({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Blast">
      <circle cx="12" cy="12" r="10" fill="#FCFC03" />
      <text x="12" y="16.4" textAnchor="middle" fontSize="13" fontWeight="800" fill="#0A0A0A" fontFamily="system-ui,-apple-system,'Segoe UI',sans-serif">B</text>
    </svg>
  );
}
function Sei2({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Sei">
      <circle cx="12" cy="12" r="10" fill="#9E1C1C" />
      <text x="12" y="16.4" textAnchor="middle" fontSize="12.5" fontWeight="800" fill="#fff" fontFamily="system-ui,-apple-system,'Segoe UI',sans-serif">S</text>
    </svg>
  );
}
function Aptos({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Aptos">
      <circle cx="12" cy="12" r="10" fill="#12141C" />
      {/* white 'A' — Aptos' mark reads as an A/peak */}
      <path d="M12 7 8 16.6" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 7 16 16.6" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M9.7 13.1 14.3 13.1" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function Unichain({ s }: { s: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-label="Unichain">
      <circle cx="12" cy="12" r="10" fill="#F50DB4" />
      <text x="12" y="16.4" textAnchor="middle" fontSize="12.5" fontWeight="800" fill="#fff" fontFamily="system-ui,-apple-system,'Segoe UI',sans-serif">U</text>
    </svg>
  );
}

export function ChainLogo({ chain, size = 16, style }: { chain: string; size?: number; style?: CSSProperties }) {
  const C = MAP[chain];
  if (!C) {
    // No hand-drawn mark yet (e.g. a newly-added chain) → a colored initial
    // badge from the chain registry, so it still reads as a recognizable tag
    // instead of a blank gap.
    const cfg = chainOf(chain);
    const color = cfg?.color ?? "#5A6E74";
    const initial = (cfg?.label ?? chain ?? "?").slice(0, 1).toUpperCase();
    return (
      <span
        aria-label={cfg?.label ?? chain}
        style={{
          width: size,
          height: size,
          display: "inline-grid",
          placeItems: "center",
          borderRadius: "50%",
          background: color,
          color: "#0A1219",
          fontSize: Math.round(size * 0.58),
          fontWeight: 700,
          lineHeight: 1,
          ...style,
        }}
      >
        {initial}
      </span>
    );
  }
  return (
    <span style={{ width: size, height: size, display: "inline-grid", placeItems: "center", ...style }}>
      <C s={size} />
    </span>
  );
}
