#!/usr/bin/env -S npx tsx
/**
 * dining-scrape.ts — production scraper and demo runner.
 *
 * Scrapes District.in, Swiggy Dineout, and EazyDiner for a curated
 * list of Bangalore restaurants and writes the results to Supabase.
 *
 * Usage:
 *   npm run dining:scrape                      # all restaurants
 *   npm run dining:scrape -- --slug hoot       # one restaurant
 *   npm run dining:scrape -- --dry-run         # print only, no DB writes
 *
 * After a successful run, the DiningTab UI will show live offer data.
 */

import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { scrapeDistrict } from "../src/lib/dining/scrapers/district";
import { scrapeSwiggy } from "../src/lib/dining/scrapers/swiggy";
import { scrapeEazyDiner } from "../src/lib/dining/scrapers/eazydiner";
import type { ScrapedOffer } from "../src/lib/dining/types";

// ── CLI args ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const slugFilter = args.includes("--slug") ? args[args.indexOf("--slug") + 1] : null;
const dryRun = args.includes("--dry-run");

// ── Supabase client ───────────────────────────────────────────────────

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ── Restaurant list ───────────────────────────────────────────────────

interface ScrapeTarget {
  slug: string;
  name: string;
  area: string;
  lat: number;
  lng: number;
  districtSlugs: string[];
  swiggyDineoutId?: string;
  eazyDinerSlug?: string;
}

const TARGETS: ScrapeTarget[] = [
  {
    slug: "hoot",
    name: "Hoot",
    area: "Koramangala",
    lat: 12.9279, lng: 77.6271,
    districtSlugs: ["hoot-craftwork-2-0-1-sarjapur-road-bangalore"],
    swiggyDineoutId: "1152615",
  },
  {
    slug: "onesta",
    name: "Onesta",
    area: "Koramangala",
    lat: 12.9355, lng: 77.6245,
    districtSlugs: ["onesta-koramangala-5th-block-bangalore", "onesta-indiranagar-bangalore"],
    swiggyDineoutId: "401186",
  },
  {
    slug: "smoke-house-deli",
    name: "Smoke House Deli",
    area: "Indiranagar",
    lat: 12.9784, lng: 77.6408,
    districtSlugs: ["smoke-house-deli-indiranagar-bangalore", "smoke-house-deli-lavelle-road"],
    swiggyDineoutId: "834227",
    eazyDinerSlug: "smoke-house-deli-lavelle-road-335752",
  },
  {
    slug: "tiger-trail",
    name: "Tiger Trail",
    area: "Jayamahal",
    lat: 12.9969, lng: 77.5829,
    districtSlugs: ["tiger-trail-regenta-place-shivajinagar-bangalore"],
    eazyDinerSlug: "tiger-trail-ramada-bangalore-shivajinagar-330037",
  },
  {
    slug: "shiro",
    name: "Shiro",
    area: "UB City",
    lat: 12.9726, lng: 77.5972,
    districtSlugs: ["shiro-lavelle-road"],
    swiggyDineoutId: "7341",
    eazyDinerSlug: "shiro-ub-city-330141",
  },
  {
    slug: "absolute-barbecues",
    name: "Absolute Barbecues",
    area: "Koramangala",
    lat: 12.9255, lng: 77.6227,
    districtSlugs: ["abs-absolute-barbecues-koramangala-5th-block-bangalore"],
    eazyDinerSlug: "abs-absolute-barbecues-whitefield-east-bengaluru-662250",
  },
  {
    slug: "barbeque-nation",
    name: "Barbeque Nation",
    area: "Indiranagar",
    lat: 12.9784, lng: 77.6408,
    districtSlugs: ["barbeque-nation-indiranagar"],
    eazyDinerSlug: "barbeque-nation-ascendas-park-square-whitefield-335312",
  },
  {
    slug: "byg-brewski",
    name: "Byg Brewski",
    area: "Hennur",
    lat: 13.0456, lng: 77.6511,
    districtSlugs: ["byg-brewski-brewing-company-hennur-bangalore"],
    eazyDinerSlug: "byg-brewski-brewing-company-hennur-north-bengaluru-656351",
  },
  {
    slug: "yauatcha",
    name: "Yauatcha",
    area: "UB City",
    lat: 12.9726, lng: 77.5972,
    districtSlugs: ["yauatcha-mg-road"],
    eazyDinerSlug: "yauatcha-1-mg-road-mall-mg-road-330178",
  },
  {
    slug: "black-pearl",
    name: "The Black Pearl",
    area: "Indiranagar",
    lat: 12.9784, lng: 77.6408,
    districtSlugs: ["the-black-pearl-indiranagar-bangalore"],
    swiggyDineoutId: "157210",
  },
];

// ── Types ─────────────────────────────────────────────────────────────

interface PlatformResult {
  platform: "district" | "swiggy" | "eazydiner";
  offers: ScrapedOffer[];
  error?: string;
}

// ── DB helpers ────────────────────────────────────────────────────────

async function upsertRestaurant(t: ScrapeTarget): Promise<string> {
  const { data, error } = await supabase
    .from("dining_restaurants")
    .upsert(
      {
        canonical_name: t.name,
        area: t.area,
        city: "Bangalore",
        lat: t.lat,
        lng: t.lng,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "canonical_name,lat,lng" },
    )
    .select("id")
    .single();

  if (error) throw new Error(`upsertRestaurant ${t.name}: ${error.message}`);
  return data.id as string;
}

async function upsertListing(
  restaurantId: string,
  platform: string,
  externalId: string,
  url: string,
  headlineOffer: string | null,
): Promise<string> {
  const { data, error } = await supabase
    .from("dining_listings")
    .upsert(
      {
        restaurant_id: restaurantId,
        platform,
        external_id: externalId,
        url,
        headline_offer: headlineOffer,
        last_scraped_at: new Date().toISOString(),
      },
      { onConflict: "platform,external_id" },
    )
    .select("id")
    .single();

  if (error) throw new Error(`upsertListing ${platform}/${externalId}: ${error.message}`);
  return data.id as string;
}

async function insertOffers(
  listingId: string,
  snapshotRunId: string,
  offers: ScrapedOffer[],
): Promise<void> {
  if (offers.length === 0) return;
  const rows = offers.map((o) => ({
    listing_id: listingId,
    offer_type: o.offer_type,
    booking_type: o.booking_type,
    headline: o.headline,
    terms: o.terms ?? null,
    discount_pct: o.discount_pct ?? null,
    snapshot_run_id: snapshotRunId,
    observed_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from("dining_offers").insert(rows);
  if (error) throw new Error(`insertOffers: ${error.message}`);
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const targets = slugFilter
    ? TARGETS.filter((t) => t.slug === slugFilter)
    : TARGETS;

  if (targets.length === 0) {
    console.error(`No target found for slug: ${slugFilter}`);
    process.exit(1);
  }

  console.log(`\n🍽  Dining scrape — ${targets.length} restaurant(s)${dryRun ? " [DRY RUN]" : ""}\n`);

  // Create one dining_run row for this entire run
  let runId = "dry-run";
  if (!dryRun) {
    const { data, error } = await supabase
      .from("dining_runs")
      .insert({
        platform: "all",
        city: "Bangalore",
        kind: "adhoc",
        status: "running",
      })
      .select("id")
      .single();
    if (error) { console.error("Failed to create dining_run:", error.message); process.exit(1); }
    runId = data.id as string;
  }

  let totalOffers = 0;
  let errors = 0;

  for (const target of targets) {
    console.log(`\n── ${target.name} (${target.area}) ──`);

    const results: PlatformResult[] = [];

    // District
    try {
      const offers = await scrapeDistrict(target.districtSlugs);
      results.push({ platform: "district", offers });
      console.log(`  district:   ${offers.length} offers`);
    } catch (e) {
      results.push({ platform: "district", offers: [], error: String(e) });
      console.log(`  district:   ERROR — ${String(e)}`);
      errors++;
    }

    // Swiggy
    if (target.swiggyDineoutId || target.name) {
      try {
        const offers = await scrapeSwiggy(target.name, target.swiggyDineoutId);
        results.push({ platform: "swiggy", offers });
        console.log(`  swiggy:     ${offers.length} offers`);
      } catch (e) {
        results.push({ platform: "swiggy", offers: [], error: String(e) });
        console.log(`  swiggy:     ERROR — ${String(e)}`);
        errors++;
      }
    }

    // EazyDiner
    if (target.eazyDinerSlug) {
      try {
        const offers = await scrapeEazyDiner(target.eazyDinerSlug);
        results.push({ platform: "eazydiner", offers });
        console.log(`  eazydiner:  ${offers.length} offers`);
      } catch (e) {
        results.push({ platform: "eazydiner", offers: [], error: String(e) });
        console.log(`  eazydiner:  ERROR — ${String(e)}`);
        errors++;
      }
    }

    // Print offer details
    for (const r of results) {
      for (const o of r.offers) {
        const tag = o.booking_type === "prebook" ? "📅" : "💳";
        console.log(`    ${tag} [${o.offer_type}] ${o.headline}`);
      }
    }

    if (dryRun) continue;

    // Write to DB
    try {
      const restaurantId = await upsertRestaurant(target);

      for (const r of results) {
        if (r.error) continue;

        const externalId =
          r.platform === "district" ? `district:${target.slug}` :
          r.platform === "swiggy"   ? `swiggy:${target.swiggyDineoutId ?? target.slug}` :
                                      `eazydiner:${target.eazyDinerSlug}`;
        const platformUrl =
          r.platform === "district" ? `https://www.district.in/dining/bangalore/${target.districtSlugs[0] ?? target.slug}` :
          r.platform === "swiggy"   ? `https://www.swiggy.com/restaurants/${target.swiggyDineoutId ?? target.slug}/dineout` :
                                      `https://www.eazydiner.com/bengaluru/${target.eazyDinerSlug}`;

        const bestPrebook = r.offers.filter((o) => o.booking_type === "prebook" && o.discount_pct)
          .sort((a, b) => (b.discount_pct ?? 0) - (a.discount_pct ?? 0))[0];
        const headlineOffer = bestPrebook?.headline ?? r.offers[0]?.headline ?? null;

        const listingId = await upsertListing(restaurantId, r.platform === "district" ? "zomato" : r.platform, externalId, platformUrl, headlineOffer);
        await insertOffers(listingId, runId, r.offers);
        totalOffers += r.offers.length;
      }
    } catch (e) {
      console.error(`  DB write failed for ${target.name}: ${e}`);
      errors++;
    }
  }

  // Mark run complete
  if (!dryRun) {
    await supabase
      .from("dining_runs")
      .update({ status: errors > 0 ? "partial" : "ok", finished_at: new Date().toISOString(), offers_seen: totalOffers })
      .eq("id", runId);
  }

  console.log(`\n✅ Done — ${totalOffers} offers written${errors > 0 ? `, ${errors} error(s)` : ""}${dryRun ? " (DRY RUN — nothing written to DB)" : ""}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
