import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/dining/search?q=<query>&limit=<n>
 *
 * Returns restaurants matching `q` (ILIKE on canonical_name),
 * each with all platform listings + the LATEST snapshot's offers.
 *
 * Sorted by best offer % descending (nulls last), then by name.
 *
 * Until the scrapers populate data, this returns an empty array —
 * the UI handles that gracefully.
 */
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 100);

  // Fetch matching restaurants. We deliberately don't filter by user_id
  // — restaurant + offer data is global (see migration 010 design notes).
  let query = supabase
    .from("dining_restaurants")
    .select("id, canonical_name, area, city, cuisines, price_for_two, lat, lng, last_seen_at")
    .eq("city", "Bangalore")
    .order("canonical_name", { ascending: true })
    .limit(limit);

  if (q.length > 0) {
    query = query.ilike("canonical_name", `%${q}%`);
  }

  const { data: restaurants, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!restaurants || restaurants.length === 0) {
    return NextResponse.json({ restaurants: [] });
  }

  const restaurantIds = restaurants.map((r) => r.id);

  // Pull listings for these restaurants.
  const { data: listings } = await supabase
    .from("dining_listings")
    .select("id, restaurant_id, platform, external_id, url, headline_offer, last_scraped_at")
    .in("restaurant_id", restaurantIds);

  // Pull the most-recent-snapshot offers per listing.
  // (Cheap heuristic: max snapshot_run_id observed per listing.)
  const listingIds = (listings ?? []).map((l) => l.id);
  let offers: Array<{
    listing_id: string;
    headline: string;
    discount_pct: number | null;
    min_bill: number | null;
    max_discount: number | null;
    terms: string | null;
    offer_type: string | null;
    snapshot_run_id: string;
    observed_at: string;
  }> = [];
  if (listingIds.length > 0) {
    const { data: rawOffers } = await supabase
      .from("dining_offers")
      .select("listing_id, headline, discount_pct, min_bill, max_discount, terms, offer_type, snapshot_run_id, observed_at")
      .in("listing_id", listingIds)
      .order("observed_at", { ascending: false });
    offers = (rawOffers ?? []) as typeof offers;
  }

  // Group offers by listing → keep only those from the latest snapshot_run_id seen for that listing.
  const offersByListing = new Map<string, typeof offers>();
  for (const o of offers) {
    const existing = offersByListing.get(o.listing_id);
    if (!existing) {
      offersByListing.set(o.listing_id, [o]);
    } else if (existing[0].snapshot_run_id === o.snapshot_run_id) {
      existing.push(o);
    }
    // else: older snapshot, skip
  }

  // Compose the response.
  const listingsByRestaurant = new Map<string, typeof listings>();
  for (const l of listings ?? []) {
    const arr = listingsByRestaurant.get(l.restaurant_id) ?? [];
    arr.push(l);
    listingsByRestaurant.set(l.restaurant_id, arr);
  }

  const out = restaurants.map((r) => {
    const ls = (listingsByRestaurant.get(r.id) ?? []).map((l) => ({
      ...l,
      offers: offersByListing.get(l.id) ?? [],
    }));
    const bestPct = Math.max(
      0,
      ...ls.flatMap((l) => l.offers.map((o) => o.discount_pct ?? 0)),
    );
    return { ...r, listings: ls, best_discount_pct: bestPct };
  });

  // Sort: best discount first, then name.
  out.sort((a, b) => {
    if (b.best_discount_pct !== a.best_discount_pct) {
      return b.best_discount_pct - a.best_discount_pct;
    }
    return a.canonical_name.localeCompare(b.canonical_name);
  });

  return NextResponse.json({ restaurants: out });
}
