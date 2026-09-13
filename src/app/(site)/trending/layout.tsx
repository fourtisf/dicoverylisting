import type { ReactNode } from "react";
import { pageMetadata } from "@/lib/seo";

// The page itself is a client component, so it cannot export `metadata` — this
// layout carries it. Without one, every page inherited the homepage's title and
// the whole site read as a single page to a crawler.
export const metadata = pageMetadata({
  title: "Gainers & Losers",
  description:
    "The biggest 24h movers among listed tokens on Solana, Base, Ethereum, BSC, TON and Tron — pick your timeframe and see what is actually running.",
  path: "/trending",
});

export default function Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
