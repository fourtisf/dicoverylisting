import type { ReactNode } from "react";
import { pageMetadata } from "@/lib/seo";

// The page itself is a client component, so it cannot export `metadata` — this
// layout carries it. Without one, every page inherited the homepage's title and
// the whole site read as a single page to a crawler.
export const metadata = pageMetadata({
  title: "Signal Feed",
  description:
    "Algorithmic on-chain signals: whale flow, liquidity moves, momentum and fresh listings across every supported chain. No human votes.",
  path: "/signals",
});

export default function Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
