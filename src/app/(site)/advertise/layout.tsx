import type { ReactNode } from "react";
import { pageMetadata } from "@/lib/seo";

// The page itself is a client component, so it cannot export `metadata` — this
// layout carries it. Without one, every page inherited the homepage's title and
// the whole site read as a single page to a crawler.
export const metadata = pageMetadata({
  title: "Listing & Trending Packages",
  description:
    "List your token, take a trending slot, or book a banner. Every package is billed in the chain's own coin — SOL on Solana, BNB on BSC, ETH on Ethereum and Base.",
  path: "/advertise",
});

export default function Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
