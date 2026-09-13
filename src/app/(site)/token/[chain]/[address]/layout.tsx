import type { Metadata } from "next";
import type { ReactNode } from "react";
import { chainOf } from "@/config/chains";
import { pageMetadata } from "@/lib/seo";
import { approvedRows } from "@/lib/store";

// Token pages are the bulk of the site and the only part that grows, so they
// are also the part that a single shared title would waste most. Every one gets
// its own: "$TICKER (Name) price, chart & safety scan on Solana".
//
// The page is a client component; this layout carries the metadata.

interface Params {
  chain: string;
  address: string;
}

/** The listing behind this url, or null when the store is unreachable or the
 *  token is not (or no longer) listed. Never throws: a metadata function that
 *  rejects fails the whole page render, and a generic title beats a 500. */
async function findRow({ chain, address }: Params) {
  try {
    const addr = decodeURIComponent(address).toLowerCase();
    const rows = await approvedRows();
    return rows.find((r) => r.chain === chain && String(r.address).toLowerCase() === addr) ?? null;
  } catch {
    return null;
  }
}

// `params` is a plain object on Next 14 (it became a Promise in 15) — awaiting
// a non-thenable is harmless, but typing it as one is a lie the compiler
// enforces on every caller.
export async function generateMetadata({ params: p }: { params: Params }): Promise<Metadata> {
  const chainLabel = chainOf(p.chain)?.label ?? p.chain;
  const row = await findRow(p);
  const path = `/token/${p.chain}/${p.address}`;

  if (!row) {
    // Unknown or delisted. Still a real page (it renders live market data by
    // address), but there is nothing worth putting in an index for it — a title
    // that is a raw contract address helps nobody searching.
    return pageMetadata({
      title: `Token on ${chainLabel}`,
      description: `Live price, liquidity, market cap and safety scan for this ${chainLabel} contract.`,
      path,
      noindex: true,
    });
  }

  const ticker = String(row.sym || "").replace(/^\$/, "");
  return pageMetadata({
    title: `$${ticker} (${row.name}) price & chart on ${chainLabel}`,
    description:
      `Live $${ticker} price, market cap, liquidity and 24h volume on ${chainLabel}, ` +
      `plus holder count, tax and a safety scan. ${row.name} is listed on Dexvra.`,
    path,
  });
}

export default function Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
