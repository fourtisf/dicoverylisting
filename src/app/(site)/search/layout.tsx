import type { ReactNode } from "react";
import { pageMetadata } from "@/lib/seo";

// The page itself is a client component, so it cannot export `metadata` — this
// layout carries it. Without one, every page inherited the homepage's title and
// the whole site read as a single page to a crawler.
export const metadata = pageMetadata({
  title: "Search Tokens",
  description:
    "Find any listed token by name, ticker or contract address across Solana, Base, Ethereum, BSC, TON, Tron and Robinhood Chain.",
  path: "/search",
});

export default function Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
