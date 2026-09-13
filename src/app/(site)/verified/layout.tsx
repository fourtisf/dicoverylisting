import type { ReactNode } from "react";
import { pageMetadata } from "@/lib/seo";

// The page itself is a client component, so it cannot export `metadata` — this
// layout carries it. Without one, every page inherited the homepage's title and
// the whole site read as a single page to a crawler.
export const metadata = pageMetadata({
  title: "Get Verified",
  description:
    "The green check tells traders your project passed Dexvra review. It comes with the top listing tiers — there is no separate fee.",
  path: "/verified",
});

export default function Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
