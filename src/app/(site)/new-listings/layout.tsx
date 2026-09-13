import type { ReactNode } from "react";
import { pageMetadata } from "@/lib/seo";

// The page itself is a client component, so it cannot export `metadata` — this
// layout carries it. Without one, every page inherited the homepage's title and
// the whole site read as a single page to a crawler.
export const metadata = pageMetadata({
  title: "New Listings",
  description:
    "The freshest token listings first. Every new project that lists on Dexvra, in order, with live price, market cap and liquidity.",
  path: "/new-listings",
});

export default function Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
