import { CHAINS } from "@/config/chains";
import { scanPonsToken } from "@/lib/providers/pons";
import type { ScanFlag, ScanResult } from "@/lib/types";

// Fourtis-style safety snapshot. Token identity comes from DexScreener (works on
// every chain); security detail from GoPlus (EVM + Solana) and RugCheck (Solana).
// We never claim "100% safe" — the verdict always keeps the DYOR disclaimer.

const isEvmAddress = (a: string) => /^0x[a-fA-F0-9]{40}$/.test(a);

function detectFamily(address: string): "solana" | "evm" | "ton" | "tron" | null {
  if (isEvmAddress(address)) return "evm";
  if (CHAINS.tron.addressPattern.test(address)) return "tron";
  if (CHAINS.ton.addressPattern.test(address)) return "ton";
  if (CHAINS.solana.addressPattern.test(address)) return "solana";
  return null;
}

// ── DexScreener: token name / symbol / chain (all chains) ─────────────────
async function dexInfo(address: string): Promise<{ name: string | null; symbol: string | null; chain: string | null }> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(String(res.status));
    const json = (await res.json()) as {
      pairs?: { chainId?: string; baseToken?: { address?: string; name?: string; symbol?: string } }[];
    };
    const pair = (json.pairs ?? []).find(
      (p) => p.baseToken?.address?.toLowerCase() === address.toLowerCase(),
    ) ?? json.pairs?.[0];
    if (!pair?.baseToken) return { name: null, symbol: null, chain: null };
    const chain = pair.chainId && CHAINS[pair.chainId] ? pair.chainId : null;
    return { name: pair.baseToken.name ?? null, symbol: pair.baseToken.symbol ?? null, chain };
  } catch {
    return { name: null, symbol: null, chain: null };
  }
}

// ── Flag helpers ──────────────────────────────────────────────────────────
type St = ScanFlag["status"];
interface FP {
  flag: ScanFlag;
  penalty: number;
}

const yn = (v: unknown): boolean | null =>
  v === "1" || v === 1 || v === true ? true : v === "0" || v === 0 || v === false ? false : null;

/** Risk boolean flag: `risky=true` is the bad direction. */
function riskFlag(label: string, risky: boolean | null, penalty: number, hard = false): FP {
  if (risky === null) return { flag: { label, value: "—", status: "na" }, penalty: 0 };
  const status: St = risky ? (hard ? "bad" : "warn") : "ok";
  return { flag: { label, value: risky ? "Yes" : "No", status }, penalty: risky ? penalty : 0 };
}

/** Positive boolean flag: `good=true` is the safe direction. */
function goodFlag(label: string, good: boolean | null, penalty: number): FP {
  if (good === null) return { flag: { label, value: "—", status: "na" }, penalty: 0 };
  return { flag: { label, value: good ? "Yes" : "No", status: good ? "ok" : "warn" }, penalty: good ? 0 : penalty };
}

function taxFlag(label: string, pct: number | null): FP {
  if (pct === null || Number.isNaN(pct)) return { flag: { label, value: "—", status: "na" }, penalty: 0 };
  const status: St = pct < 5 ? "ok" : pct < 10 ? "warn" : "bad";
  const penalty = pct < 5 ? 0 : Math.min(30, Math.round(pct * 2));
  return { flag: { label, value: `${pct.toFixed(1)}%`, status }, penalty };
}

function assemble(fps: FP[]): { flags: ScanFlag[]; score: number } {
  const flagPenalty = fps.reduce((s, f) => s + f.penalty, 0);
  const naCount = fps.filter((f) => f.flag.status === "na").length;
  // Nothing is ever "perfect": a small residual for inherent uncertainty, plus
  // a little for each check we couldn't verify — keeps clean tokens in the
  // mid-90s (like established scanners) instead of a flat, unrealistic 100.
  const residual = 4 + naCount * 2;
  const score = Math.max(0, Math.min(96, 100 - flagPenalty - residual));
  return { flags: fps.map((f) => f.flag), score };
}

// ── GoPlus EVM ────────────────────────────────────────────────────────────
async function goPlusEvm(goPlusId: string, address: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(
    `https://api.gopluslabs.io/api/v1/token_security/${goPlusId}?contract_addresses=${address}`,
    { signal: AbortSignal.timeout(9000), cache: "no-store" },
  );
  if (!res.ok) throw new Error(`GoPlus ${res.status}`);
  const json = (await res.json()) as { result?: Record<string, Record<string, unknown>> };
  const r = json.result?.[address.toLowerCase()];
  return r && Object.keys(r).length > 0 ? r : null;
}

async function scanEvm(address: string): Promise<{ fps: FP[]; chainId: string }> {
  const evmChains = Object.values(CHAINS).filter((c) => c.goPlusChainId);
  const attempts = await Promise.allSettled(
    evmChains.map(async (c) => {
      const r = await goPlusEvm(c.goPlusChainId!, address);
      if (!r) throw new Error("not found");
      return { chainId: c.id, raw: r };
    }),
  );
  const hit = attempts.find(
    (a): a is PromiseFulfilledResult<{ chainId: string; raw: Record<string, unknown> }> => a.status === "fulfilled",
  );
  if (!hit) throw new Error("GoPlus: not an EVM token on supported chains");
  const r = hit.value.raw;
  const buyTax = r.buy_tax != null ? Number(r.buy_tax) * 100 : null;
  const sellTax = r.sell_tax != null ? Number(r.sell_tax) * 100 : null;
  const lpLocked = Number(r.lp_locked_percent ?? 0) * 100;
  const ownerKnown = r.owner_address !== undefined && r.owner_address !== null;
  const ownerRenounced =
    r.owner_address === "" || r.owner_address === "0x0000000000000000000000000000000000000000";
  const scam = yn(r.is_honeypot) || yn(r.cannot_sell_all) || yn(r.is_blacklisted) || yn(r.honeypot_with_same_creator);

  const fps: FP[] = [
    riskFlag("Honeypot", yn(r.is_honeypot), 70, true),
    riskFlag("Mintable", yn(r.is_mintable), 12),
    riskFlag("Freezable / Pausable", yn(r.transfer_pausable), 12),
    riskFlag("Potential Scam", scam === null ? null : scam, 50, true),
    riskFlag("Self-destruct", yn(r.selfdestruct), 20, true),
    riskFlag("Fee Upgradable", yn(r.slippage_modifiable), 12),
    riskFlag("Cannot sell all", yn(r.cannot_sell_all), 15),
    taxFlag("Buy Tax", buyTax),
    taxFlag("Sell Tax", sellTax),
    goodFlag("Open source", yn(r.is_open_source), 8),
    goodFlag("Ownership renounced", ownerKnown ? ownerRenounced : null, 8),
    riskFlag("LP locked", lpLocked >= 50 ? false : lpLocked > 0 ? true : null, 8),
  ];
  // Show LP locked as a percent rather than yes/no when we have it.
  if (lpLocked > 0) fps[fps.length - 1].flag.value = `${Math.round(lpLocked)}%`;
  return { fps, chainId: hit.value.chainId };
}

// ── GoPlus Solana ─────────────────────────────────────────────────────────
async function scanSolanaGoPlus(address: string): Promise<FP[] | null> {
  const res = await fetch(
    `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}`,
    { signal: AbortSignal.timeout(9000), cache: "no-store" },
  );
  if (!res.ok) throw new Error(`GoPlus SOL ${res.status}`);
  const json = (await res.json()) as { result?: Record<string, Record<string, unknown>> };
  const r = json.result?.[address] ?? json.result?.[address.toLowerCase()];
  if (!r || Object.keys(r).length === 0) return null;

  const st = (o: unknown): boolean | null => yn((o as { status?: unknown })?.status ?? o);
  const mintable = st(r.mintable);
  const freezable = st(r.freezable);
  const closable = st(r.closable);
  const nonTransferable = yn(r.non_transferable);
  const feeUpgradable = st(r.transfer_fee_upgradable) ?? st(r.transfer_hook_upgradable);
  const metaMutable = st(r.metadata_mutable) ?? st(r.balance_mutable_authority);
  const feeObj = r.transfer_fee as { current_fee?: unknown } | undefined;
  const transferFee = feeObj?.current_fee != null ? Number(feeObj.current_fee) : null;

  const fps: FP[] = [
    riskFlag("Mintable", mintable, 12),
    riskFlag("Freezable", freezable, 15),
    riskFlag("Closable", closable, 20, true),
    riskFlag("Non-Transferable", nonTransferable, 40, true),
    riskFlag("Fee Upgradable", feeUpgradable, 12),
    riskFlag("Mutable metadata", metaMutable, 6),
    taxFlag("Transfer Fee", transferFee),
  ];
  return fps;
}

// ── RugCheck (Solana risks) ───────────────────────────────────────────────
async function rugCheck(address: string): Promise<FP[] | null> {
  const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${address}/report/summary`, {
    signal: AbortSignal.timeout(9000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`RugCheck ${res.status}`);
  const json = (await res.json()) as {
    score_normalised?: number;
    risks?: { name: string; level: string }[];
  };
  const risks = json.risks ?? [];
  const danger = risks.filter((r) => r.level === "danger");
  const warn = risks.filter((r) => r.level === "warn");
  const fps: FP[] = [
    riskFlag("Potential Scam", danger.length > 0, 50, true),
    { flag: { label: "Risk flags", value: risks.length ? String(risks.length) : "None", status: danger.length ? "bad" : warn.length ? "warn" : "ok" }, penalty: warn.length * 4 },
  ];
  return fps;
}

function verdictFor(score: number): { verdict: "ok" | "warn"; verdictText: string; label: string } {
  if (score >= 80) return { verdict: "ok", verdictText: "🛡️ Looks clean — still DYOR, always.", label: "SAFE" };
  if (score >= 50) return { verdict: "warn", verdictText: "⚠️ Some risk signals — review the flags before aping.", label: "CAUTION" };
  return { verdict: "warn", verdictText: "🚨 High risk — multiple red flags. Be very careful.", label: "HIGH RISK" };
}

export async function scanToken(address: string): Promise<ScanResult> {
  const family = detectFamily(address);
  const [info, security] = await Promise.all([
    dexInfo(address),
    (async (): Promise<
      { fps: FP[]; chain: string | null; source: string; name?: string | null; symbol?: string | null } | null
    > => {
      try {
        if (family === "evm") {
          try {
            const r = await scanEvm(address);
            return { fps: r.fps, chain: r.chainId, source: "GoPlus" };
          } catch {
            // No aggregator covers Robinhood Chain, but its launchpad does:
            // if Pons launched this token, its contracts answer definitively.
            const pons = await scanPonsToken(address);
            if (!pons) return null;
            return { fps: pons.fps, chain: pons.chain, source: pons.source, name: pons.name, symbol: pons.symbol };
          }
        }
        if (family === "solana") {
          const [gp, rug] = await Promise.allSettled([scanSolanaGoPlus(address), rugCheck(address)]);
          const fps: FP[] = [];
          let source = "";
          if (gp.status === "fulfilled" && gp.value) {
            fps.push(...gp.value);
            source = "GoPlus";
          }
          if (rug.status === "fulfilled" && rug.value) {
            fps.push(...rug.value);
            source = source ? `${source} + RugCheck` : "RugCheck";
          }
          if (!fps.length) return null;
          return { fps, chain: "solana", source };
        }
        return null;
      } catch {
        return null;
      }
    })(),
  ]);

  const chain = security?.chain ?? info.chain ?? (family === "ton" ? "ton" : family === "tron" ? "tron" : null);
  const name = info.name ?? security?.name ?? null;
  const symbol = info.symbol ?? security?.symbol ?? null;

  if (!security) {
    // Basic snapshot only (no security provider covered this chain/token).
    const flags: ScanFlag[] = [
      { label: "Name", value: name ?? "Unknown", status: name ? "ok" : "na" },
      { label: "Chain", value: chain ? CHAINS[chain]?.label ?? chain : "Unknown", status: chain ? "ok" : "na" },
      { label: "Security data", value: "Limited", status: "warn" },
    ];
    return {
      address,
      chain,
      name,
      symbol,
      score: null,
      scoreLabel: "LIMITED",
      flags,
      verdict: "warn",
      verdictText: "ℹ️ Limited security data for this token — basic info only. DYOR.",
      live: Boolean(name),
      dataSource: name ? "DexScreener (basic)" : "unavailable",
    };
  }

  const { flags, score } = assemble(security.fps);
  const v = verdictFor(score);
  return {
    address,
    chain,
    name,
    symbol,
    score,
    scoreLabel: v.label,
    flags,
    verdict: v.verdict,
    verdictText: v.verdictText,
    live: true,
    dataSource: security.source,
  };
}
