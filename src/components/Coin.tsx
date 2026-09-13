"use client";

import type { BoardToken } from "@/lib/types";
import { coinBg, monogram } from "@/lib/visual";
import { logoSrc } from "@/lib/logo";
import { useState, type CSSProperties } from "react";
import { ChainLogo } from "./ChainLogo";

/** Emoji-gradient coin (prototype look) that upgrades to the real logo when
 *  the provider supplies one. The chain badge is the real chain logo. */
export function Coin({
  token,
  size,
  fontSize,
  withBadge = true,
}: {
  token: Pick<BoardToken, "emoji" | "gradient" | "logoUrl" | "chain" | "symbol">;
  size?: number;
  fontSize?: number;
  withBadge?: boolean;
}) {
  const style: CSSProperties = { background: coinBg(token.gradient) };
  if (size) {
    style.width = size;
    style.height = size;
  }
  if (fontSize) style.fontSize = fontSize;
  const logoSize = size ? Math.max(14, Math.round(size * 0.4)) : 15;
  const ring = logoSize + 4; // badge = logo + a thin card-colored ring, so nothing clips
  // A logo URL is best-effort (CDN guesses can 404) — fall back to the emoji
  // instead of ever showing a broken-image square.
  const [broken, setBroken] = useState(false);
  const src = logoSrc(token.logoUrl);
  const showImg = src && !broken;
  const inner = (
    <div className="coin" style={style}>
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} />
      ) : (
        <span className="coin-mono">{monogram(token.symbol)}</span>
      )}
    </div>
  );
  if (!withBadge) return inner;
  return (
    <span className="coin-wrap">
      {inner}
      <span className="cbadge cbadge-logo" style={{ width: ring, height: ring }}>
        <ChainLogo chain={token.chain} size={logoSize} />
      </span>
    </span>
  );
}
