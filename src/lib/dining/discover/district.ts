// District (Zomato Dining) discovery via the public sitemap index.
//
// Sitemap structure (confirmed 2026-05-19):
//   district.in/dining/search-sitemap/sitemap-dining.xml       (index)
//     ├── sitemap-restaurant-pages1.xml.gz   (NCR)
//     ├── sitemap-restaurant-pages2.xml.gz   (Bangalore — 20K urls)
//     ├── sitemap-restaurant-pages3.xml.gz   (Bangalore — 7K urls)
//     └── ... (other cities)
//
// We follow the index, gunzip each sub-sitemap, and keep only the
// `<loc>` entries matching /dining/bangalore/<slug>. Slug is parsed
// for a best-effort name + area; lat/lng are unknown at this stage
// (filled in by the offer scrape's per-restaurant call).

import { gunzipSync } from "node:zlib";
import { diningFetchWithBackoff } from "../http";
import { parseSlug } from "./slug";
import type { DiscoveredListing, DiscoveryResult } from "./types";

const SITEMAP_INDEX_URL =
  "https://www.district.in/dining/search-sitemap/sitemap-dining.xml";

const BANGALORE_URL_RE = /https:\/\/www\.district\.in\/dining\/bangalore\/([a-z0-9-]+)/g;

/**
 * Discover all Bangalore restaurants on District via the sitemap index.
 *
 * Returns one `DiscoveredListing` per outlet slug — chains will appear
 * many times (Third Wave has ~50 outlets). Cross-platform dedupe collapses
 * these to canonicals downstream.
 *
 * Network cost: 1 index fetch + ~9 sub-sitemap fetches = ~10 requests.
 * All sub-sitemaps are downloaded even if they don't contain Bangalore —
 * we don't know which one(s) do without parsing.
 */
export async function discoverDistrict(): Promise<DiscoveryResult> {
  const stats = { pagesFetched: 0, pagesFailed: 0, listingsRaw: 0, listingsUnique: 0 };

  // 1. Fetch the index.
  const indexRes = await diningFetchWithBackoff(SITEMAP_INDEX_URL);
  stats.pagesFetched++;
  if (indexRes.kind !== "ok") {
    stats.pagesFailed++;
    return { platform: "zomato", listings: [], stats };
  }

  // 2. Extract sub-sitemap URLs (.xml.gz).
  const subSitemapUrls = [...indexRes.body.matchAll(/<loc>([^<]+\.xml\.gz)<\/loc>/g)]
    .map((m) => m[1]);

  // 3. For each sub-sitemap, fetch + gunzip + extract Bangalore URLs.
  const seenSlugs = new Set<string>();
  const listings: DiscoveredListing[] = [];

  for (const url of subSitemapUrls) {
    const res = await diningFetchWithBackoff(url, { binary: true });
    stats.pagesFetched++;
    if (res.kind !== "ok" || !res.bodyBytes) {
      stats.pagesFailed++;
      continue;
    }

    let xml: string;
    try {
      xml = gunzipSync(Buffer.from(res.bodyBytes)).toString("utf8");
    } catch {
      stats.pagesFailed++;
      continue;
    }

    for (const m of xml.matchAll(BANGALORE_URL_RE)) {
      const slug = m[1];
      stats.listingsRaw++;
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);

      const { name, area } = parseSlug(slug);
      listings.push({
        platform: "zomato",
        externalId: slug,
        name,
        area,
        url: `https://www.district.in/dining/bangalore/${slug}`,
      });
    }
  }

  stats.listingsUnique = listings.length;
  return { platform: "zomato", listings, stats };
}
