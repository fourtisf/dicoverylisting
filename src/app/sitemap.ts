import type { MetadataRoute } from "next";
import { absolute } from "@/config/site";
import { approvedRows } from "@/lib/store";

// Served at /sitemap.xml.
//
// A sitemap does not make pages rank. It makes them FINDABLE without waiting
// for a crawler to stumble across an internal link — which matters here because
// most of the site is client-rendered, so a crawler that does not run the JS
// sees very few links to follow. Every public route is listed explicitly for
// that reason, rather than trusting discovery.
//
// The personal pages (/account, /watchlist) are deliberately absent: they are
// empty for everyone but their owner, and an empty page is not worth an index
// slot. Their layouts also carry `noindex` — this list and that flag have to
// agree, and a test checks that they do.

/** Public routes, in rough order of how much of the product they represent.
 *  `priority` is a hint about RELATIVE importance within this site — it says
 *  nothing to Google about other sites, which is the usual misunderstanding. */
const ROUTES: Array<{ path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }> = [
  { path: "/", priority: 1.0, changeFrequency: "hourly" },
  { path: "/trending", priority: 0.9, changeFrequency: "hourly" },
  { path: "/new-listings", priority: 0.9, changeFrequency: "hourly" },
  { path: "/leaderboard", priority: 0.8, changeFrequency: "hourly" },
  { path: "/signals", priority: 0.8, changeFrequency: "hourly" },
  { path: "/advertise", priority: 0.8, changeFrequency: "weekly" },
  { path: "/scanner", priority: 0.7, changeFrequency: "weekly" },
  { path: "/verified", priority: 0.7, changeFrequency: "weekly" },
  { path: "/community", priority: 0.6, changeFrequency: "weekly" },
  { path: "/search", priority: 0.5, changeFrequency: "weekly" },
  { path: "/alerts", priority: 0.5, changeFrequency: "monthly" },
  { path: "/install", priority: 0.4, changeFrequency: "monthly" },
];

// Rebuilt hourly rather than frozen at build time: listings arrive from the bot
// continuously, and a sitemap baked once would never mention any of them.
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const staticEntries: MetadataRoute.Sitemap = ROUTES.map((r) => ({
    url: absolute(r.path),
    lastModified: now,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));

  // Token pages are the bulk of the site and the only part that grows. A store
  // that is unreachable must not take the sitemap down with it — a sitemap with
  // twelve routes is far better than a 500, which makes Google drop the file.
  let tokens: MetadataRoute.Sitemap = [];
  try {
    const rows = await approvedRows();
    tokens = rows.map((r) => ({
      url: absolute(`/token/${r.chain}/${r.address}`),
      lastModified: r.listedAt ? new Date(r.listedAt) : now,
      changeFrequency: "daily" as const,
      priority: 0.6,
    }));
  } catch {
    /* listings unavailable — ship the static routes rather than nothing */
  }

  return [...staticEntries, ...tokens];
}
