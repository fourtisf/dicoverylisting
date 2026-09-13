"use client";

import { useApp } from "@/components/AppState";
import { PageHead } from "@/components/PageHead";
import { CHAINS } from "@/config/chains";
import { BOT_URL } from "@/config/brand";
import { shortAddr } from "@/lib/walletConnect";
import { tierLabel } from "@/lib/packages";

export default function AccountPage() {
  const { wallet, openWalletModal, disconnectWallet, watchlist, myListings } = useApp();

  return (
    <section className="view">
      <PageHead icon="👤" title="Account" sub="Your wallet, your listings, your watchlist — all in one place." />
      <div className="panel" style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 2 }}>
        <div className="acct-row">
          Wallet<span className="av">{wallet ? `${wallet.name} · ${shortAddr(wallet.address)}` : "Not connected"}</span>
        </div>
        <div className="acct-row">
          Watchlist
          <span className="av">
            {watchlist.size} token{watchlist.size === 1 ? "" : "s"}
          </span>
        </div>
        <div className="acct-row">
          Member since<span className="av">Jul 2026</span>
        </div>
        <button
          className="btn-primary"
          style={{ alignSelf: "flex-start", marginTop: 12 }}
          onClick={wallet ? disconnectWallet : openWalletModal}
        >
          {wallet ? "⏏ Disconnect" : "Connect wallet"}
        </button>
      </div>

      <div className="page-head" style={{ marginTop: 2 }}>
        <h2 style={{ fontSize: 17 }}>My listings</h2>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9, maxWidth: 640 }}>
        {myListings.length === 0 ? (
          <div className="panel big-empty">
            <div className="em">🪙</div>
            <p>No listings yet. Submit your first token and it shows up here with live status.</p>
            <a className="btn-primary" href={BOT_URL} target="_blank" rel="noopener noreferrer">⚡ List my token</a>
          </div>
        ) : (
          myListings.map((m, i) => {
            const c = CHAINS[m.chain];
            return (
              <div className="mini-listing" key={`${m.symbol}-${i}`}>
                <div
                  className="coin"
                  style={{
                    width: 36,
                    height: 36,
                    fontSize: 17,
                    background: "radial-gradient(circle at 32% 26%,#B8FFD0,#3DF59F 45%,#0B9E5E)",
                  }}
                >
                  {m.emoji}
                </div>
                <div>
                  <div style={{ fontFamily: "var(--fd)", fontWeight: 700, fontSize: 14 }}>{m.symbol}</div>
                  <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                    {m.name} · <span style={{ color: c?.color }}>{c?.label ?? m.chain}</span> · {tierLabel(m.tier)}
                  </div>
                </div>
                <span className="status-chip">{m.status}</span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
