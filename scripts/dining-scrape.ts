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
  // ── Already scraped (10 original) ─────────────────────────────────
  {
    slug: "hoot",
    name: "Hoot",
    area: "Koramangala",
    lat: 12.9141, lng: 77.6786,
    districtSlugs: ["hoot-craftwork-2-0-1-sarjapur-road-bangalore"],
    swiggyDineoutId: "1152615",
  },
  {
    slug: "onesta",
    name: "Onesta",
    area: "Koramangala",
    lat: 12.9787, lng: 77.6436,
    districtSlugs: ["onesta-koramangala-5th-block-bangalore"],
    swiggyDineoutId: "401186",
  },
  {
    slug: "smoke-house-deli",
    name: "Smoke House Deli",
    area: "Indiranagar",
    lat: 12.9656, lng: 77.6413,
    districtSlugs: ["smoke-house-deli-indiranagar-bangalore"],
    swiggyDineoutId: "834227",
    eazyDinerSlug: "smoke-house-deli-lavelle-road-335752",
  },
  {
    slug: "tiger-trail",
    name: "Tiger Trail",
    area: "Jayamahal",
    lat: 12.9969, lng: 77.5829,
    districtSlugs: ["tiger-trail-regenta-place-shivajinagar-bangalore"],
    swiggyDineoutId: "581549",   // Regenta Place outlet (HAL Airport = 25281, wrong location)
    eazyDinerSlug: "tiger-trail-ramada-bangalore-shivajinagar-330037",
  },
  {
    slug: "shiro",
    name: "Shiro",
    area: "UB City",
    lat: 12.9719, lng: 77.5962,
    districtSlugs: ["shiro-lavelle-road"],
    swiggyDineoutId: "7341",
    eazyDinerSlug: "shiro-ub-city-330141",
  },
  {
    slug: "absolute-barbecues",
    name: "Absolute Barbecues",
    area: "Koramangala",
    lat: 12.9347, lng: 77.6158,
    districtSlugs: ["abs-absolute-barbecues-koramangala-5th-block-bangalore"],
    swiggyDineoutId: "528133",
    eazyDinerSlug: "abs-absolute-barbecues-whitefield-east-bengaluru-662250",
  },
  {
    slug: "barbeque-nation",
    name: "Barbeque Nation",
    area: "Indiranagar",
    lat: 12.9704, lng: 77.6102,
    districtSlugs: ["barbeque-nation-indiranagar"],
    swiggyDineoutId: "302699",
    eazyDinerSlug: "barbeque-nation-ascendas-park-square-whitefield-335312",
  },
  {
    slug: "byg-brewski",
    name: "Byg Brewski",
    area: "Hennur",
    lat: 13.0708, lng: 77.6519,
    districtSlugs: ["byg-brewski-brewing-company-hennur-bangalore"],
    swiggyDineoutId: "781599",
    eazyDinerSlug: "byg-brewski-brewing-company-hennur-north-bengaluru-656351",
  },
  {
    slug: "yauatcha",
    name: "Yauatcha",
    area: "UB City",
    lat: 12.9732, lng: 77.6203,
    districtSlugs: ["yauatcha-mg-road"],
    swiggyDineoutId: "281835",
    eazyDinerSlug: "yauatcha-1-mg-road-mall-mg-road-330178",
  },
  {
    slug: "black-pearl",
    name: "The Black Pearl",
    area: "Indiranagar",
    lat: 12.9784, lng: 77.6408,
    districtSlugs: ["the-black-pearl-indiranagar-bangalore"],
    swiggyDineoutId: "588676",
  },

  // ── New restaurants (20 added) ────────────────────────────────────
  {
    slug: "blue-tokai",
    name: "Blue Tokai Coffee",
    area: "Indiranagar",
    lat: 12.9719, lng: 77.5942,
    districtSlugs: ["blue-tokai-coffee-roasters-infantry-road-bangalore"],
    swiggyDineoutId: "966182",
    eazyDinerSlug: "blue-tokai-infantry-road-central-bengaluru-683567",
  },
  {
    slug: "communiti",
    name: "Communiti",
    area: "Indiranagar",
    lat: 12.9725, lng: 77.6082,
    districtSlugs: ["communiti-brigade-road-bangalore"],
    swiggyDineoutId: "390913",
  },
  {
    slug: "farzi-cafe",
    name: "Farzi Cafe",
    area: "UB City",
    lat: 12.9715, lng: 77.5959,
    districtSlugs: ["farzi-cafe-lavelle-road"],
    swiggyDineoutId: "302257",
    eazyDinerSlug: "farzi-cafe-vittal-mallya-road-337292",
  },
  {
    slug: "fatty-bao",
    name: "The Fatty Bao",
    area: "Indiranagar",
    lat: 12.9704, lng: 77.6453,
    districtSlugs: ["the-fatty-bao-indiranagar-bangalore"],
    swiggyDineoutId: "17327",
    eazyDinerSlug: "the-fatty-bao-lavelle-road-central-bengaluru-682670",
  },
  {
    slug: "flechazo",
    name: "Flechazo",
    area: "Indiranagar",
    lat: 12.9784, lng: 77.6408,
    districtSlugs: ["flechazo-whitefield-bangalore"],
    swiggyDineoutId: "775734",
  },
  {
    slug: "foxtrot",
    name: "Foxtrot",
    area: "Koramangala",
    lat: 12.9250, lng: 77.6329,
    districtSlugs: ["foxtrot-marathahalli-bangalore"],
    swiggyDineoutId: "157210",
    eazyDinerSlug: "foxtrot-gastropub-marathahalli-east-bengaluru-652608",
  },
  {
    slug: "glens-bakehouse",
    name: "Glen's Bakehouse",
    area: "Koramangala",
    lat: 12.9700, lng: 77.5974,
    districtSlugs: ["glen-s-bakehouse-koramangala-6th-block-bangalore"],
    swiggyDineoutId: "17376",
    eazyDinerSlug: "glens-bakehouse-indiranagar-331919",
  },
  {
    slug: "karavalli",
    name: "Karavalli",
    area: "Residency Road",
    lat: 12.9719, lng: 77.6089,
    districtSlugs: ["karavalli-the-gateway-hotel-residency-road"],
    swiggyDineoutId: "941651",
    eazyDinerSlug: "karavalli-the-gateway-hotel-residency-road-330289",
  },
  {
    slug: "meghana-foods",
    name: "Meghana Foods",
    area: "Koramangala",
    lat: 12.9726, lng: 77.6091,
    districtSlugs: ["meghana-foods-koramangala-5th-block"],
    swiggyDineoutId: "3241",
    eazyDinerSlug: "meghana-foods-residency-road-334874",
  },
  {
    slug: "misu",
    name: "Misu",
    area: "Indiranagar",
    lat: 12.9755, lng: 77.6026,
    districtSlugs: ["misu-indiranagar-bangalore"],
    swiggyDineoutId: "29063",
  },
  {
    slug: "mtr",
    name: "MTR",
    area: "Lalbagh",
    lat: 12.9722, lng: 77.6009,
    districtSlugs: ["mtr-since-1924-indiranagar-bangalore"],
    swiggyDineoutId: "49096",
    eazyDinerSlug: "mtr-1924-st-marks-road-334798",
  },
  {
    slug: "nagarjuna",
    name: "Nagarjuna",
    area: "Residency Road",
    lat: 12.9732, lng: 77.6092,
    districtSlugs: ["nagarjuna-since-1984-residency-road-bangalore"],
    swiggyDineoutId: "41100",
    eazyDinerSlug: "nagarjuna-residency-road-334689",
  },
  {
    slug: "olive-beach",
    name: "Olive Beach",
    area: "Sankey Road",
    lat: 12.9674, lng: 77.6083,
    districtSlugs: ["olive-beach-richmond-road-bangalore"],
    swiggyDineoutId: "477654",
    eazyDinerSlug: "olive-beach-richmond-road-330137",
  },
  {
    slug: "permit-room",
    name: "The Permit Room",
    area: "Indiranagar",
    lat: 12.9705, lng: 77.6105,
    districtSlugs: ["the-permit-room-indiranagar-bangalore"],
    swiggyDineoutId: "63024",
    eazyDinerSlug: "the-permit-room-richmond-town-central-bengaluru-613800",
  },
  {
    slug: "third-wave",
    name: "Third Wave Coffee",
    area: "Indiranagar",
    lat: 12.9720, lng: 77.5981,
    districtSlugs: ["third-wave-coffee-1-indiranagar-bangalore"],
    swiggyDineoutId: "533773",
    eazyDinerSlug: "third-wave-coffee-roasters-koramangala-south-bengaluru-640094",
  },
  {
    slug: "toit",
    name: "Toit Brewpub",
    area: "Indiranagar",
    lat: 12.9792, lng: 77.6408,
    districtSlugs: ["toit-indiranagar"],
    swiggyDineoutId: "1271281",
    eazyDinerSlug: "toit-indiranagar-330151",
  },
  {
    slug: "truffles",
    name: "Truffles",
    area: "Koramangala",
    lat: 12.9718, lng: 77.6010,
    districtSlugs: ["truffles-koramangala-5th-block"],
    swiggyDineoutId: "3369",
    eazyDinerSlug: "truffles-st-marks-road-334765",
  },
  {
    slug: "vidyarthi-bhavan",
    name: "Vidyarthi Bhavan",
    area: "Gandhi Bazaar",
    lat: 12.9452, lng: 77.5715,
    districtSlugs: ["vidyarthi-bhavan-since-1943-basavanagudi-bangalore"],
    swiggyDineoutId: "3883",
  },
  {
    // Not on District sitemap, not on EazyDiner; Swiggy only
    slug: "asia-kitchen",
    name: "Asia Kitchen",
    area: "Indiranagar",
    lat: 12.9752, lng: 77.6039,
    districtSlugs: [],
    swiggyDineoutId: "305776",
  },
  {
    // Not on any platform — skipped by scrapers gracefully
    slug: "indigo-deli",
    name: "Indigo Deli",
    area: "Koramangala",
    lat: 12.9355, lng: 77.6245,
    districtSlugs: [],
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

    // Swiggy — only attempt when an explicit Dineout ID is configured.
    // The food-delivery fallback resolver was removed: it used a different ID namespace
    // and silently returned wrong outlets (e.g. Tiger Trail HAL Airport vs Regenta Place).
    if (target.swiggyDineoutId) {
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
