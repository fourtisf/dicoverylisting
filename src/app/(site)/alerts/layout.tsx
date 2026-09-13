import type { ReactNode } from "react";
import { pageMetadata } from "@/lib/seo";

// The page itself is a client component, so it cannot export `metadata` — this
// layout carries it. Without one, every page inherited the homepage's title and
// the whole site read as a single page to a crawler.
export const metadata = pageMetadata({
  title: "Price Alerts",
  description:
    "Get pinged when a token moves. Set a target and Dexvra tells you the moment it hits.",
  path: "/alerts",
});

export default function Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
