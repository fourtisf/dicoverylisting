"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { BRAND_NAME } from "@/config/brand";
import { CHAINS } from "@/config/chains";
import { fmtCap, fmtPrice } from "@/lib/format";
import { Coin } from "./Coin";
import { Logo } from "./Logo";
import { useApp } from "./AppState";
import { BOT_URL } from "@/config/brand";
import { shortAddr } from "@/lib/walletConnect";
import { NAV_GROUPS } from "./Sidebar";
import { usePathname, useRouter } from "next/navigation";
import { logoSrc } from "@/lib/logo";
import { changeReading } from "@/lib/home";

/** What /api/token-preview hands back for a contract nobody has listed. */
interface UnlistedHit {
  name: string | null;
  symbol: string | null;
  priceUsd: number | null;
  mcap: number | null;
  logoUrl: string | null;
}

export function Topbar() {
  const { data, wallet, openWalletModal, disconnectWallet, toast, openDetail, homeQuery, setHomeQuery } = useApp();
  const [walletMenu, setWalletMenu] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false); // mobile ⋮ feature menu
  const pathname = usePathname();
  const router = useRouter();

  // "/" focuses the topbar search from anywhere (prototype behavior)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (e.key === "/" && !["input", "select", "textarea"].includes(tag)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const q = homeQuery.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return [];
    return (data?.tokens ?? [])
      .filter((t) => (t.symbol + t.name + t.address).toLowerCase().includes(q))
      .slice(0, 8);
  }, [data, q]);

  const go = (t: (typeof matches)[number]) => {
    setHomeQuery("");
    setOpen(false);
    openDetail(t);
  };

  // ── Pasting a CA that nobody has listed ────────────────────────────────────
  // The buy bot is free and runs on any contract, so a pasted address is far
  // more often an UNLISTED token than a listed one — and the box answered "No
  // token matches", which is both wrong (the token exists) and a dead end.
  const isCa = /^(0x[a-fA-F0-9]{40}|0x[a-fA-F0-9]+::.+|T[1-9A-HJ-NP-Za-km-z]{33}|(EQ|UQ|0:).{10,}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(
    homeQuery.trim(),
  );
  const [probe, setProbe] = useState<{ chain: string; token: UnlistedHit } | null>(null);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    const address = homeQuery.trim();
    // Only when the local list has nothing AND the text is a whole address:
    // this reaches the network, so it must not fire on every keystroke of a
    // ticker search that is about to match locally anyway.
    if (!isCa || matches.length > 0) {
      setProbe(null);
      setProbing(false);
      return;
    }
    let live = true;
    setProbing(true);
    const timer = setTimeout(() => {
      fetch(`/api/token-preview?address=${encodeURIComponent(address)}`)
        .then((r) => r.json())
        .then((j) => {
          if (!live) return;
          setProbe(j?.token && j?.chain ? { chain: j.chain, token: j.token } : null);
        })
        .catch(() => live && setProbe(null))
        .finally(() => live && setProbing(false));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [homeQuery, isCa, matches.length]);

  const goUnlisted = () => {
    if (!probe) return;
    const to = `/token/${probe.chain}/${encodeURIComponent(homeQuery.trim())}`;
    setHomeQuery("");
    setOpen(false);
    router.push(to);
  };

  return (
    <header className="topbar">
      <Link href="/" className="brand-top" aria-label={`${BRAND_NAME} home`}>
        <div className="brand-logo sm spin"><Logo size={32} /></div>
        <div className="brand-name">{BRAND_NAME}</div>
      </Link>
      {/* Primary navigation — the sidebar is gone, the header is the one nav.
          Watchlist keeps its href here: the smoke script drives it. */}
      <nav className="nav topnav" aria-label="Primary">
        {[
          { href: "/", label: "Home" },
          { href: "/trending", label: "Gainers" },
          { href: "/new-listings", label: "New" },
          { href: "/leaderboard", label: "Leaderboard" },
          { href: "/watchlist", label: "Watchlist" },
        ].map((l) => (
          <Link key={l.href} href={l.href} className={pathname === l.href ? "active" : ""}>
            {l.label}
          </Link>
        ))}
      </nav>
      {/* ⋮ holds every page the inline nav does not — at EVERY width now, not
          only phones: it is the whole secondary navigation. */}
      <div className="topmenu">
        <button
          className="topmenu-btn"
          aria-label="Menu"
          aria-expanded={menu}
          onClick={() => setMenu((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width={20} height={20} fill="currentColor" aria-hidden>
            <circle cx="12" cy="5" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="12" cy="19" r="1.8" />
          </svg>
        </button>
        {menu && (
          <>
            <div className="topmenu-scrim" onClick={() => setMenu(false)} />
            <div className="topmenu-dd" role="menu">
              {NAV_GROUPS.map((g) => (
                <div className="tmg" key={g.label}>
                  <div className="tmg-label">{g.label}</div>
                  {g.items.map((it) => (
                    <Link
                      key={it.href}
                      href={it.href}
                      role="menuitem"
                      className={`tmg-item ${pathname === it.href ? "active" : ""}`}
                      onClick={() => setMenu(false)}
                    >
                      <span className="tmg-ic">{it.icon}</span>
                      <span>{it.label}</span>
                      {it.badge && <span className={`tmg-badge ${it.badge}`}>{it.badge}</span>}
                    </Link>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="search-wrap">
        <label className="search">
          <svg viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.8-3.8" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search token, name, or paste CA…"
            value={homeQuery}
            onChange={(e) => {
              setHomeQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0]) go(matches[0]);
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <kbd>/</kbd>
        </label>
        {open && q && (
          <div className="search-dd">
            {matches.length === 0 ? (
              probing ? (
                <div className="sdd-empty">Checking that contract…</div>
              ) : probe ? (
                <button className="sdd-item" onMouseDown={(e) => { e.preventDefault(); goUnlisted(); }}>
                  {logoSrc(probe.token.logoUrl) ? (
                    // Through the proxy like every other logo on the site: a
                    // hotlinked CDN load fails often enough that the search
                    // preview would show a placeholder for a token we can see.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="sdd-logo" src={logoSrc(probe.token.logoUrl)} alt="" width={30} height={30} />
                  ) : (
                    <div className="sdd-logo sdd-logo-ph">{(probe.token.symbol ?? "?").slice(0, 2).toUpperCase()}</div>
                  )}
                  <div className="sdd-id">
                    <div className="sdd-sym">{probe.token.symbol ?? "Unknown"}</div>
                    <div className="sdd-nm">
                      {probe.token.name ?? shortAddr(homeQuery.trim())} · {CHAINS[probe.chain]?.label ?? probe.chain}
                    </div>
                  </div>
                  <div className="sdd-px">
                    {probe.token.priceUsd != null && <div>{fmtPrice(probe.token.priceUsd)}</div>}
                    {probe.token.mcap != null && <div className="sdd-mc">MC {fmtCap(probe.token.mcap)}</div>}
                  </div>
                  <span className="sdd-unlisted">Not Yet Listed</span>
                </button>
              ) : (
                <div className="sdd-empty">
                  No token matches “{homeQuery.trim()}”.
                  {isCa && " That contract isn't on any network we index."}
                </div>
              )
            ) : (
              matches.map((t) => {
                // Through the sane reading — a search hit must not show a
                // five-million-percent figure any more than the board does.
                const reading = changeReading(t, "24h");
                const up = (reading ?? 0) >= 0;
                return (
                  <button key={t.key} className="sdd-item" onMouseDown={(e) => { e.preventDefault(); go(t); }}>
                    <Coin token={t} size={30} fontSize={14} />
                    <div className="sdd-id">
                      <div className="sdd-sym">{t.symbol}</div>
                      <div className="sdd-nm">{t.name} · {CHAINS[t.chain]?.label ?? t.chain}</div>
                    </div>
                    <div className="sdd-px">
                      <div>{fmtPrice(t.priceUsd)}</div>
                      {reading != null && (
                        <div className={up ? "sdd-up" : "sdd-dn"}>{up ? "+" : ""}{reading.toFixed(1)}%</div>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
      <div className="top-stat">
        <span className="dot-live" />
        24H TRACKED <b>{data ? fmtCap(data.trackedVol24h) : "…"}</b>
      </div>
      <div className="wallet-wrap">
        <button
          className={`btn-wallet ${wallet ? "connected" : ""}`}
          onClick={() => (wallet ? setWalletMenu((v) => !v) : openWalletModal())}
        >
          <svg viewBox="0 0 24 24">
            <rect x="3" y="6" width="18" height="13" rx="3" />
            <path d="M16 12h.01M3 10h18" />
          </svg>
          <span className="lbl">{wallet ? shortAddr(wallet.address) : "Connect Wallet"}</span>
        </button>
        {wallet && walletMenu && (
          <div className="wallet-menu" onMouseLeave={() => setWalletMenu(false)}>
            <div className="wmn-head">
              {wallet.name} · {wallet.chainType.toUpperCase()}
            </div>
            <button
              className="wmn-item"
              onClick={() => {
                navigator.clipboard?.writeText(wallet.address).catch(() => {});
                toast("Address copied");
                setWalletMenu(false);
              }}
            >
              📋 Copy address
            </button>
            <button
              className="wmn-item"
              onClick={() => {
                openWalletModal();
                setWalletMenu(false);
              }}
            >
              🔁 Switch wallet
            </button>
            <button
              className="wmn-item danger"
              onClick={() => {
                disconnectWallet();
                setWalletMenu(false);
              }}
            >
              ⏏ Disconnect
            </button>
          </div>
        )}
      </div>
      <a className="btn-primary" href={BOT_URL} target="_blank" rel="noopener noreferrer">
        ⚡ <span className="lbl">List Token</span>
      </a>
    </header>
  );
}
