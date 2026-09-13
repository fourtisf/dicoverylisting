import type { ReactNode } from "react";
import { pageMetadata } from "@/lib/seo";

// The page itself is a client component, so it cannot export `metadata` — this
// layout carries it. Without one, every page inherited the homepage's title and
// the whole site read as a single page to a crawler.
export const metadata = pageMetadata({
  title: "Token Scanner",
  description:
    "Paste any contract address for an instant safety snapshot — honeypot, tax, mint authority and LP checks on Solana and EVM chains.",
  path: "/scanner",
});

export default function Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
