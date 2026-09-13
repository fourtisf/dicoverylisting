import type { ReactNode } from "react";
import { pageMetadata } from "@/lib/seo";

// The page itself is a client component, so it cannot export `metadata` — this
// layout carries it. Without one, every page inherited the homepage's title and
// the whole site read as a single page to a crawler.
export const metadata = pageMetadata({
  title: "Account",
  description:
    "Your wallet, your listings and your watchlist — all in one place.",
  path: "/account",
  // Empty for everyone but its owner — not worth an index slot, and it is
  // left out of sitemap.ts for the same reason.
  noindex: true,
});

export default function Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
