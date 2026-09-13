"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BRAND_NAME, BRAND_SUB } from "@/config/brand";
import { Logo } from "./Logo";
import { useApp } from "./AppState";
import { BOT_URL, TELEGRAM_HANDLE, TELEGRAM_URL, X_URL } from "@/config/brand";

export interface NavItem {
  href: string;
  label: string;
  icon: JSX.Element;
  badge?: "hot" | "new" | "live";
}

const stroke = { fill: "none" as const };

const DISCOVER: NavItem[] = [
  { href: "/", label: "Home", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10.5V20h13v-9.5" /></svg> },
  { href: "/trending", label: "Gainers & Losers", badge: "hot", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg> },
  { href: "/new-listings", label: "New Listings", badge: "live", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /></svg> },
  { href: "/leaderboard", label: "Leaderboard", badge: "new", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3" /></svg> },
  { href: "/search", label: "Search", icon: <svg viewBox="0 0 24 24" {...stroke}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.8-3.8" /></svg> },
  { href: "/watchlist", label: "Watchlist", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="m12 3.5 2.5 5.2 5.7.7-4.2 4 1.1 5.6L12 16.3 6.9 19l1.1-5.6-4.2-4 5.7-.7L12 3.5z" /></svg> },
];

const SIGNALS: NavItem[] = [
  { href: "/signals", label: "Signal Feed", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M4 12h3l2.5-7 5 14 2.5-7H20" /></svg> },
  { href: "/scanner", label: "Safety Scan", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M12 3 5 6v5c0 4.5 3 7.9 7 9.5 4-1.6 7-5 7-9.5V6l-7-3z" /><path d="m9 12 2.2 2.2L15.5 10" /></svg> },
  { href: "/alerts", label: "Alerts", badge: "new", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M6 9.5a6 6 0 1 1 12 0c0 4 1.6 5.3 2 6H4c.4-.7 2-2 2-6z" /><path d="M10 19a2 2 0 0 0 4 0" /></svg> },
];

const GROW: NavItem[] = [
  { href: "/verified", label: "Get Verified", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M12 2l2.4 1.7 2.9-.2 1 2.8 2.4 1.6-.7 2.8.7 2.8-2.4 1.6-1 2.8-2.9-.2L12 22l-2.4-1.7-2.9.2-1-2.8L3.3 16l.7-2.8L3.3 10l2.4-1.6 1-2.8 2.9.2z" /><path d="m9 12 2.2 2.2L15.5 10" /></svg> },
  { href: "/advertise", label: "Advertise", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M4 10v4h3l6 4V6l-6 4H4z" /><path d="M17 9.5a4 4 0 0 1 0 5" /></svg> },
];

const APP: NavItem[] = [
  { href: "/community", label: "Community", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M4 9h9l4 3.5V9h3V4H4v5z" /><path d="M8 13v4h8l4 3v-3h0" /></svg> },
  { href: "/install", label: "Install App", icon: <svg viewBox="0 0 24 24" {...stroke}><path d="M12 3v11M8 10l4 4 4-4" /><path d="M5 19h14" /></svg> },
  { href: "/account", label: "Account", icon: <svg viewBox="0 0 24 24" {...stroke}><circle cx="12" cy="8.5" r="3.8" /><path d="M4.5 20c1.4-3.4 4.1-5 7.5-5s6.1 1.6 7.5 5" /></svg> },
];

// Shared so the mobile ⋮ menu (Topbar) exposes the exact same features as the
// desktop sidebar — which is hidden on phones.
export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  { label: "Discover", items: DISCOVER },
  { label: "Signals", items: SIGNALS },
  { label: "Grow", items: GROW },
  { label: "App", items: APP },
];

function NavGroup({ label, items, pathname }: { label: string; items: NavItem[]; pathname: string }) {
  return (
    <div style={{ width: "100%" }}>
      <div className="nav-label">{label}</div>
      <nav className="nav">
        {items.map((it) => (
          <Link key={it.href} href={it.href} title={it.label} className={pathname === it.href ? "active" : ""}>
            {it.icon}
            <span className="lbl">{it.label}</span>
            {it.badge === "hot" && <span className="badge-hot">HOT</span>}
            {it.badge === "new" && <span className="badge-new">NEW</span>}
            {it.badge === "live" && <span className="ldot" />}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const { openListing } = useApp();
  void openListing; // kept for the in-app submit flow elsewhere
  return (
    <aside className="sidebar">
      <Link href="/" className="brand" aria-label={`${BRAND_NAME} home`}>
        <div className="brand-logo spin"><Logo size={40} /></div>
        <div className="brand-txt">
          <div className="brand-name">{BRAND_NAME}</div>
          <div className="brand-sub">{BRAND_SUB}</div>
        </div>
      </Link>

      <a className="fasttrack" href={BOT_URL} target="_blank" rel="noopener noreferrer">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M13 2 4.5 13.5H11L9.6 22 19 10h-6.6L13 2z" />
        </svg>
        <span className="lbl">List My Token</span>
      </a>

      <NavGroup label="Discover" items={DISCOVER} pathname={pathname} />
      <NavGroup label="Signals" items={SIGNALS} pathname={pathname} />
      <NavGroup label="Grow" items={GROW} pathname={pathname} />
      <NavGroup label="App" items={APP} pathname={pathname} />

      {/* Quick reach for the two primary accounts. The full list — listing,
          trending, bot — lives on /community, linked in the App group above. */}
      <div className="side-soc">
        <a href={TELEGRAM_URL} target="_blank" rel="noopener noreferrer" title={`Telegram ${TELEGRAM_HANDLE}`}>
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M21.9 4.3 18.9 19c-.2 1-.8 1.2-1.7.8l-4.6-3.4-2.2 2.2c-.3.3-.5.4-.9.4l.3-4.7 8.5-7.7c.4-.3-.1-.5-.6-.2L7.2 12.9 2.6 11.5c-1-.3-1-1 .2-1.5l18-6.9c.8-.3 1.5.2 1.1 1.2z" />
          </svg>
          <span>Telegram</span>
        </a>
        <a href={X_URL} target="_blank" rel="noopener noreferrer" title="X">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M18.2 2h3.3l-7.2 8.3L23 22h-6.7l-5.2-6.8L5.1 22H1.8l7.7-8.8L1 2h6.8l4.7 6.2L18.2 2zm-1.2 18h1.8L7.1 3.9H5.2L17 20z" />
          </svg>
          <span>X</span>
        </a>
      </div>
    </aside>
  );
}
