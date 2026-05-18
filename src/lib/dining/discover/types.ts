import type { Platform } from "../types";

/**
 * A restaurant listing as it appears on one platform, surfaced by a
 * discovery pass. Skeleton-shaped: just enough to mint a `dining_listings`
 * row and run dedupe against existing canonicals.
 *
 * Some fields are best-effort:
 * - `area` is parsed from the slug, often noisy ("5th-block").
 * - `lat`/`lng` are usually unknown at discovery time; the per-restaurant
 *   offer scrape fills these in later.
 *
 * `url` is the canonical platform deep-link (used for offer scraping).
 */
export interface DiscoveredListing {
  platform: Platform;
  externalId: string;       // platform's stable id (slug or numeric id)
  name: string;             // best-effort display name
  area?: string | null;     // best-effort neighbourhood
  lat?: number | null;
  lng?: number | null;
  url: string;
}

export interface DiscoveryResult {
  platform: Platform;
  listings: DiscoveredListing[];
  /** Diagnostics — counts of pages fetched, errors, etc. */
  stats: {
    pagesFetched: number;
    pagesFailed: number;
    listingsRaw: number;     // before in-platform dedupe (chains have many outlets)
    listingsUnique: number;  // after platform-internal dedupe by externalId
  };
}
