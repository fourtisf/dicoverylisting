import type { MetadataRoute } from "next";
import { absolute } from "@/config/site";

// Served at /robots.txt.
//
// There was no robots.txt at all, which is not the same as "allow everything":
// it leaves the crawler with no sitemap to find, and nothing keeping it out of
// the admin panel and the API. Both of those would otherwise be crawled,
// indexed, and — in the panel's case — shown in results as a login screen
// carrying the brand name, which is the worst possible thing to rank for a
// brand query.
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/panel", // admin — also noindex'd in its layout, belt and braces
          "/api/", // JSON endpoints: nothing a searcher wants, and they change constantly
        ],
      },
    ],
    sitemap: absolute("/sitemap.xml"),
    host: absolute("/"),
  };
}
