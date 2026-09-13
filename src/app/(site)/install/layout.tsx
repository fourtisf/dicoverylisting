import type { ReactNode } from "react";
import { pageMetadata } from "@/lib/seo";

// The page itself is a client component, so it cannot export `metadata` — this
// layout carries it. Without one, every page inherited the homepage's title and
// the whole site read as a single page to a crawler.
export const metadata = pageMetadata({
  title: "Install the App",
  description:
    "Dexvra on your home screen — full-screen, fast, and no app store needed. Works on iPhone, iPad and Android.",
  path: "/install",
});

export default function Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
