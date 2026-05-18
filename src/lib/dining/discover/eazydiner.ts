// EazyDiner discovery via paginated HTML listings.
//
// EazyDiner SSRs restaurant data into __NEXT_DATA__ on every listing page.
// Structure (confirmed 2026-05-19):
//   __NEXT_DATA__.props.pageProps.listing.data.data[]
//     → { name, res_id, code (slug), restaurant_area, lat, lng, ... }
//
// Pagination: ?page=N until data.data is empty (confirmed last page = ~210).
//
// We hit www.eazydiner.com (not force.eazydiner.com) — www has Allow: / in
// robots.txt; force has Disallow: /. Discovery stays compliant.

import { diningFetchWithBackoff } from "../http";
import type { DiscoveredListing, DiscoveryResult } from "./types";

const PAGE_URL = (n: number) => `https://www.eazydiner.com/bengaluru/restaurants?page=${n}`;
const MAX_PAGES = 300; // hard ceiling — actual is ~210. Stops earlier on first empty page.

interface EazyDinerListItem {
  res_id: number;
  name: string;
  code: string;             // slug used in URLs: "bengaluru/<slug>"
  restaurant_area?: string;
  restaurant_subarea?: string | null;
  lat?: number;
  lng?: number;
}

/**
 * Discover all Bangalore restaurants on EazyDiner.
 *
 * Pages through /bengaluru/restaurants?page=1.. until we hit an empty page.
 * Each page yields ~10 restaurants with full metadata (incl. lat/lng).
 *
 * Network cost: ~210 sequential page fetches. With the http.ts politeness
 * floor (500-2000ms jitter) this takes ~5–7 min end-to-end.
 */
export async function discoverEazyDiner(): Promise<DiscoveryResult> {
  const stats = { pagesFetched: 0, pagesFailed: 0, listingsRaw: 0, listingsUnique: 0 };
  const seenIds = new Set<number>();
  const listings: DiscoveredListing[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await diningFetchWithBackoff(PAGE_URL(page), {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    stats.pagesFetched++;
    if (res.kind !== "ok") {
      stats.pagesFailed++;
      continue;
    }

    const items = extractNextDataItems(res.body);
    if (items.length === 0) break; // past the last page

    for (const item of items) {
      stats.listingsRaw++;
      if (seenIds.has(item.res_id)) continue;
      seenIds.add(item.res_id);

      // res_code looks like "bengaluru/<slug-with-id>". The slug-with-id is
      // what our existing scraper passes to the per-restaurant API.
      const slug = item.code.replace(/^bengaluru\//, "");

      listings.push({
        platform: "eazydiner",
        externalId: slug,
        name: item.name,
        area: humanizeArea(item.restaurant_area ?? item.restaurant_subarea ?? null),
        lat: item.lat ?? null,
        lng: item.lng ?? null,
        url: `https://www.eazydiner.com/bengaluru/restaurants/${slug}`,
      });
    }
  }

  stats.listingsUnique = listings.length;
  return { platform: "eazydiner", listings, stats };
}

/**
 * Extract the EazyDiner listing array from a page's __NEXT_DATA__ blob.
 *
 * Exported (and pure) so we can unit-test against captured fixtures
 * without hitting the network.
 */
export function extractNextDataItems(html: string): EazyDinerListItem[] {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  try {
    const json = JSON.parse(m[1]);
    const arr = json?.props?.pageProps?.listing?.data?.data;
    if (!Array.isArray(arr)) return [];
    return arr as EazyDinerListItem[];
  } catch {
    return [];
  }
}

function humanizeArea(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
