import type { ReactNode } from "react";
import { pageMetadata } from "@/lib/seo";

// The page itself is a client component, so it cannot export `metadata` — this
// layout carries it. Without one, every page inherited the homepage's title and
// the whole site read as a single page to a crawler.
export const metadata = pageMetadata({
  title: "Leaderboard",
  description:
    "Listed tokens ranked by Dexvra Score — pure on-chain signal from liquidity, volume and buy pressure. Never paid votes.",
  path: "/leaderboard",
});

export default function Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
