"use client";

// Real multi-wallet connect — no heavy SDKs, no cloud project IDs:
// - EVM: EIP-6963 provider discovery (lists EVERY installed wallet — MetaMask,
//   Rabby, OKX, Bitget, Coinbase, …) with window.ethereum as the fallback.
// - Solana: Phantom / Solflare injected providers.
// - Tron: TronLink.
// Connect = request accounts; we keep address + wallet name client-side only
// (display / future gating) — no signatures, no server round-trip.

export interface DetectedWallet {
  id: string;
  name: string;
  icon: string | null; // data: URI from EIP-6963, else null (emoji fallback in UI)
  chainType: "evm" | "solana" | "tron";
  connect: () => Promise<string>; // resolves the selected account address
}

export interface ConnectedWallet {
  address: string;
  name: string;
  icon: string | null;
  chainType: "evm" | "solana" | "tron";
}

type Eip6963Detail = {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
};

const anyWin = () => (typeof window === "undefined" ? ({} as Record<string, unknown>) : (window as unknown as Record<string, any>));

/** Discover every installed wallet. EIP-6963 wallets announce asynchronously,
 *  so this waits a short beat for announcements before resolving. */
export async function detectWallets(): Promise<DetectedWallet[]> {
  const w = anyWin();
  const out: DetectedWallet[] = [];
  const seen = new Set<string>();

  // EVM via EIP-6963 multi-provider discovery
  const announced: Eip6963Detail[] = [];
  if (typeof window !== "undefined") {
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<Eip6963Detail>).detail;
      if (d && !announced.some((a) => a.info.uuid === d.info.uuid)) announced.push(d);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce as EventListener);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    await new Promise((r) => setTimeout(r, 120));
    window.removeEventListener("eip6963:announceProvider", onAnnounce as EventListener);
  }
  for (const d of announced) {
    const key = `evm:${d.info.rdns || d.info.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: key,
      name: d.info.name,
      icon: d.info.icon || null,
      chainType: "evm",
      connect: async () => {
        const accts = (await d.provider.request({ method: "eth_requestAccounts" })) as string[];
        if (!accts?.length) throw new Error("No account authorized");
        return accts[0];
      },
    });
  }
  // Legacy fallback when nothing announced but window.ethereum exists
  if (!out.some((o) => o.chainType === "evm") && w.ethereum) {
    out.push({
      id: "evm:injected",
      name: w.ethereum.isMetaMask ? "MetaMask" : "Browser Wallet",
      icon: null,
      chainType: "evm",
      connect: async () => {
        const accts = (await w.ethereum.request({ method: "eth_requestAccounts" })) as string[];
        if (!accts?.length) throw new Error("No account authorized");
        return accts[0];
      },
    });
  }

  // Solana — Phantom
  const phantom = w.phantom?.solana ?? (w.solana?.isPhantom ? w.solana : null);
  if (phantom) {
    out.push({
      id: "sol:phantom",
      name: "Phantom",
      icon: null,
      chainType: "solana",
      connect: async () => {
        const res = await phantom.connect();
        const pk = res?.publicKey ?? phantom.publicKey;
        if (!pk) throw new Error("No account authorized");
        return pk.toString();
      },
    });
  }
  // Solana — Solflare
  if (w.solflare?.isSolflare) {
    out.push({
      id: "sol:solflare",
      name: "Solflare",
      icon: null,
      chainType: "solana",
      connect: async () => {
        await w.solflare.connect();
        const pk = w.solflare.publicKey;
        if (!pk) throw new Error("No account authorized");
        return pk.toString();
      },
    });
  }

  // Tron — TronLink
  if (w.tronLink || w.tronWeb) {
    out.push({
      id: "tron:tronlink",
      name: "TronLink",
      icon: null,
      chainType: "tron",
      connect: async () => {
        if (w.tronLink?.request) {
          await w.tronLink.request({ method: "tron_requestAccounts" });
        }
        const addr = w.tronWeb?.defaultAddress?.base58;
        if (!addr) throw new Error("Unlock TronLink first");
        return addr;
      },
    });
  }

  return out;
}

export const shortAddr = (a: string) =>
  a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a;

export const CHAIN_TYPE_EMOJI: Record<ConnectedWallet["chainType"], string> = {
  evm: "⬨",
  solana: "◎",
  tron: "▲",
};

// Install links shown when nothing is detected.
export const WALLET_INSTALLS = [
  { name: "MetaMask", url: "https://metamask.io/download/" },
  { name: "Phantom", url: "https://phantom.com/download" },
  { name: "TronLink", url: "https://www.tronlink.org/" },
];
