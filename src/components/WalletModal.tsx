"use client";

// Multi-wallet connect modal: lists every wallet detected in the browser
// (EIP-6963 EVM wallets, Phantom/Solflare, TronLink) — pick one to connect.
// Shows install links when nothing is detected.
import { useEffect, useState } from "react";
import {
  CHAIN_TYPE_EMOJI,
  WALLET_INSTALLS,
  detectWallets,
  type DetectedWallet,
} from "@/lib/walletConnect";
import { useApp } from "./AppState";

export function WalletModal() {
  const { walletModalOpen, closeWalletModal, setWalletConnected, toast } = useApp();
  const [wallets, setWallets] = useState<DetectedWallet[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!walletModalOpen) return;
    setWallets(null);
    detectWallets().then(setWallets).catch(() => setWallets([]));
  }, [walletModalOpen]);

  if (!walletModalOpen) return null;

  const pick = async (w: DetectedWallet) => {
    setBusy(w.id);
    try {
      const address = await w.connect();
      setWalletConnected({ address, name: w.name, icon: w.icon, chainType: w.chainType });
    } catch (e) {
      toast(`Connect failed: ${e instanceof Error ? e.message : "rejected"}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-ov on" onClick={closeWalletModal}>
      <div className="modal wallet-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-x" onClick={closeWalletModal}>
          ✕
        </button>
        <h3 className="wm-title">Connect a wallet</h3>
        <p className="wm-sub">
          Your wallet stays in your browser — Dexvra never asks for signatures or funds.
        </p>

        {wallets == null ? (
          <div className="wm-empty">Scanning for wallets…</div>
        ) : wallets.length === 0 ? (
          <div className="wm-empty">
            No wallet extensions detected in this browser.
            <div className="wm-installs">
              {WALLET_INSTALLS.map((w) => (
                <a key={w.name} href={w.url} target="_blank" rel="noopener noreferrer" className="wm-install">
                  Install {w.name} ↗
                </a>
              ))}
            </div>
          </div>
        ) : (
          <div className="wm-list">
            {wallets.map((w) => (
              <button key={w.id} className="wm-item" disabled={busy != null} onClick={() => pick(w)}>
                {w.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={w.icon} alt="" className="wm-icon" />
                ) : (
                  <span className="wm-icon wm-icon-fallback">{CHAIN_TYPE_EMOJI[w.chainType]}</span>
                )}
                <span className="wm-name">{w.name}</span>
                <span className="wm-kind">{w.chainType.toUpperCase()}</span>
                {busy === w.id && <span className="wm-busy">…</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
