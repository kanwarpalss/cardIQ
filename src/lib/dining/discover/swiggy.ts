// Swiggy Dineout discovery — bootstrap by name from canonicals already
// found via District + EazyDiner.
//
// Why this shape (not bulk listing like the other two)
// ────────────────────────────────────────────────────
// Swiggy's dineout listing API is internal — every public endpoint we
// probed (page_type variants, /dapi/dineout/*, disc.swiggy.com/listing)
// returns either food-delivery results or 503. So we can't bulk-discover.
//
// Workaround: for each canonical we already have (with a lat/lng from
// EazyDiner, hopefully), search Swiggy's food-delivery search and pick
// the result closest to the canonical's geo with the best name match.
// Then VERIFY the candidate ID has dineout data — if not, reject.
//
// Coverage tradeoff: ~30-50% of canonicals will resolve cleanly.
// Misses are handled by the manual-link review UI (later chunk).

import { diningFetchWithBackoff } from "../http";
import { normalizeName, levenshtein, haversineMeters } from "../normalize";
import type { DiscoveredListing, DiscoveryResult } from "./types";

const BANGALORE_LAT = 12.9716;
const BANGALORE_LNG = 77.5946;

// Markers that prove an ID is dineout-valid (not just food-delivery).
const DINEOUT_MARKERS = ["DealAndOfferInfo", "dayWiseOfferInfo", "tabsOfferInfo"];

interface CanonicalLite {
  name: string;
  lat?: number | null;
  lng?: number | null;
}

interface SearchCandidate {
  id: string;
  name: string;
  lat?: number | null;
  lng?: number | null;
  locality?: string;
}

/**
 * Try to find a Swiggy Dineout listing for one canonical restaurant.
 *
 * Returns null when:
 *   - search returns no plausible name match
 *   - top candidate's ID has no dineout data on verification
 *
 * Cost: 2 HTTP calls per canonical (1 search + 1 verify) when there's a
 * match; 1 call (search only) when there's none.
 */
export async function discoverSwiggyForRestaurant(
  c: CanonicalLite,
): Promise<DiscoveredListing | null> {
  const candidate = await searchTopCandidate(c);
  if (!candidate) return null;

  const isDineout = await verifyDineoutId(candidate.id);
  if (!isDineout) return null;

  return {
    platform: "swiggy",
    externalId: candidate.id,
    name: candidate.name,
    area: candidate.locality ?? null,
    lat: candidate.lat ?? null,
    lng: candidate.lng ?? null,
    url: `https://www.swiggy.com/restaurants/${candidate.id}/dineout`,
  };
}

/**
 * Batch driver — runs discoverSwiggyForRestaurant against many canonicals
 * sequentially (politeness controller in http.ts handles throttling).
 */
export async function discoverSwiggyBatch(
  canonicals: CanonicalLite[],
): Promise<DiscoveryResult> {
  const stats = { pagesFetched: 0, pagesFailed: 0, listingsRaw: 0, listingsUnique: 0 };
  const listings: DiscoveredListing[] = [];
  const seenIds = new Set<string>();

  for (const c of canonicals) {
    const found = await discoverSwiggyForRestaurant(c);
    stats.pagesFetched += found ? 2 : 1;
    if (!found) {
      stats.pagesFailed++;
      continue;
    }
    stats.listingsRaw++;
    if (seenIds.has(found.externalId)) continue;
    seenIds.add(found.externalId);
    listings.push(found);
  }

  stats.listingsUnique = listings.length;
  return { platform: "swiggy", listings, stats };
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

async function searchTopCandidate(c: CanonicalLite): Promise<SearchCandidate | null> {
  const lat = c.lat ?? BANGALORE_LAT;
  const lng = c.lng ?? BANGALORE_LNG;
  const url =
    `https://www.swiggy.com/dapi/restaurants/search/v3` +
    `?lat=${lat}&lng=${lng}&str=${encodeURIComponent(c.name)}` +
    `&trackingId=undefined&submitAction=ENTER&queryUniqueId=undefined`;

  const res = await diningFetchWithBackoff(url, {
    headers: { Referer: "https://www.swiggy.com/" },
  });
  if (res.kind !== "ok") return null;

  let body: unknown;
  try {
    body = JSON.parse(res.body);
  } catch {
    return null;
  }

  const candidates = extractSearchCandidates(body);
  if (candidates.length === 0) return null;

  return pickBestCandidate(c, candidates);
}

/**
 * Extract all restaurant candidates from a Swiggy search v3 response.
 *
 * Response shape (confirmed 2026-05-19):
 *   data.cards[*].groupedCard.cardGroupMap.RESTAURANT.cards[*]
 *     .card.card.info                       → single result
 *     .card.card.restaurants[*].info        → grouped results
 *
 * Exported (pure) so the test can run against captured fixtures.
 */
export function extractSearchCandidates(body: unknown): SearchCandidate[] {
  const out: SearchCandidate[] = [];
  walk(body);
  return out;

  function walk(obj: unknown): void {
    if (!obj) return;
    if (Array.isArray(obj)) {
      for (const x of obj) walk(x);
      return;
    }
    if (typeof obj !== "object") return;
    const o = obj as Record<string, unknown>;
    const info = o.info as Record<string, unknown> | undefined;
    if (
      info &&
      typeof info.id === "string" &&
      typeof info.name === "string" &&
      (info.locality !== undefined || info.latLong !== undefined)
    ) {
      const ll = (info.latLong as string | undefined) ?? "";
      const [latS, lngS] = ll.split(",");
      out.push({
        id: info.id,
        name: info.name,
        locality: (info.locality as string | undefined) ?? (info.areaName as string | undefined),
        lat: latS ? parseFloat(latS) : null,
        lng: lngS ? parseFloat(lngS) : null,
      });
    }
    for (const v of Object.values(o)) walk(v);
  }
}

/**
 * Pick the candidate with the highest combined score:
 *   - 70% weight: normalized-name similarity (1 - levenshtein/max-length)
 *   - 30% weight: geo proximity (1 - clamp(dist_m / 2000, 0, 1))
 *
 * Reject if score < 0.6 — better to miss than match wrong.
 */
export function pickBestCandidate(
  target: CanonicalLite,
  candidates: SearchCandidate[],
): SearchCandidate | null {
  const targetName = normalizeName(target.name);
  if (!targetName) return null;

  let best: { c: SearchCandidate; score: number } | null = null;
  for (const c of candidates) {
    const candName = normalizeName(c.name);
    if (!candName) continue;
    const dist = levenshtein(targetName, candName);
    const maxLen = Math.max(targetName.length, candName.length);
    const nameSim = maxLen === 0 ? 0 : 1 - dist / maxLen;

    let geoSim = 0.5; // neutral when one side has no geo
    if (target.lat != null && target.lng != null && c.lat != null && c.lng != null) {
      const d = haversineMeters(
        { lat: target.lat, lng: target.lng },
        { lat: c.lat, lng: c.lng },
      );
      geoSim = 1 - Math.min(d / 2000, 1);
    }

    const score = 0.7 * nameSim + 0.3 * geoSim;
    if (!best || score > best.score) best = { c, score };
  }

  return best && best.score >= 0.6 ? best.c : null;
}

async function verifyDineoutId(id: string): Promise<boolean> {
  const url = `https://disc.swiggy.com/api/v1/dinersone-restaurant/json?restaurantId=${id}`;
  const res = await diningFetchWithBackoff(url, {
    headers: {
      latitude: String(BANGALORE_LAT),
      longitude: String(BANGALORE_LNG),
      Referer: "https://www.swiggy.com/dineout",
      Origin: "https://www.swiggy.com",
    },
  });
  if (res.kind !== "ok") return false;
  return DINEOUT_MARKERS.some((m) => res.body.includes(m));
}
