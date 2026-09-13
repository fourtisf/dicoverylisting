import type { BoardToken } from "@/lib/types";
import { CHAINS } from "@/config/chains";
import Link from "next/link";

const XLogo = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-label="X">
    <path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.65l-5.2-6.82-5.96 6.82H.9l7.73-8.84L.5 2.25h6.83l4.7 6.22 5.4-6.22Zm-1.17 17.52h1.83L7.02 4.13H5.06l12.01 15.64Z" />
  </svg>
);
const TgLogo = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-label="Telegram">
    <path d="M21.94 4.3 18.9 19.1c-.23 1.02-.84 1.27-1.7.79l-4.7-3.47-2.27 2.19c-.25.25-.46.46-.94.46l.34-4.78 8.7-7.86c.38-.34-.08-.53-.59-.19L6.28 13.4l-4.64-1.45c-1.01-.32-1.03-1.01.24-1.5L20.63 3c.84-.31 1.58.2 1.31 1.3Z" />
  </svg>
);
const WebLogo = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18" />
  </svg>
);
const ScanLogo = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M12 3 5 6v5c0 4.5 3 7.9 7 9.5 4-1.6 7-5 7-9.5V6l-7-3z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </svg>
);

export function Socials({ t }: { t: BoardToken }) {
  const c = CHAINS[t.chain];
  // Only the project's REAL socials — each icon shows ONLY when its real link
  // exists. Never point X at a search or Telegram at the website; a wrong link
  // is worse than a missing one.
  return (
    <div className="soc-row">
      {t.links.twitter && (
        <a className="soc soc-x" href={t.links.twitter} target="_blank" rel="noopener noreferrer" title="X (Twitter)">
          <XLogo />
        </a>
      )}
      {t.links.telegram && (
        <a className="soc soc-tg" href={t.links.telegram} target="_blank" rel="noopener noreferrer" title="Telegram">
          <TgLogo />
        </a>
      )}
      {t.links.website && (
        <a className="soc" href={t.links.website} target="_blank" rel="noopener noreferrer" title="Website">
          <WebLogo />
        </a>
      )}
      {c && !c.explorer(t.address).includes("dexscreener") && (
        <a className="soc" href={c.explorer(t.address)} target="_blank" rel="noopener noreferrer" title="Explorer">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M9 15 15 9M10.5 6.5 13 4a4 4 0 0 1 6 6l-2.5 2.5M13.5 17.5 11 20a4 4 0 0 1-6-6l2.5-2.5" />
          </svg>
        </a>
      )}
      <Link className="soc soc-scan" href="/scanner" title="Safety Scan">
        <ScanLogo />
      </Link>
    </div>
  );
}
