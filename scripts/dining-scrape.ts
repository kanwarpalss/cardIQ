#!/usr/bin/env -S npx tsx
/**
 * dining-scrape.ts — production offer scraper (DB-driven).
 *
 * Loads ALL dining_listings from Supabase (populated by dining-discover.ts),
 * scrapes fresh offers from District, Swiggy Dineout, and EazyDiner, and
 * writes results back to dining_offers.
 *
 * Run dining-discover.ts first on a fresh install.
 *
 * Usage:
 *   npm run dining:scrape                          # all restaurants
 *   npm run dining:scrape -- --slug "Toit"         # filter by canonical name
 *   npm run dining:scrape -- --dry-run             # print only, no DB writes
 *   npm run dining:scrape -- --limit 50            # first N restaurants
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
const nameFilter = args.includes("--slug") ? args[args.indexOf("--slug") + 1] : null;
const dryRun = args.includes("--dry-run");
const limitArg = args.includes("--limit") ? parseInt(args[args.indexOf("--limit") + 1], 10) : null;

// ── Supabase client ───────────────────────────────────────────────────

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ── Types ─────────────────────────────────────────────────────────────

interface PlatformListing {
  listingId: string;      // dining_listings.id — used when writing offers
  platform: "zomato" | "swiggy" | "eazydiner";
  externalId: string;     // raw from DB (may have "platform:" prefix)
  url: string;
}

interface ScrapeTarget {
  restaurantId: string;
  name: string;
  area: string;
  listings: PlatformListing[];
}

interface PlatformResult {
  platform: "district" | "swiggy" | "eazydiner";
  listingId: string;
  offers: ScrapedOffer[];
  error?: string;
}

// ── Load targets from DB ──────────────────────────────────────────────

/**
 * External IDs were written in two formats:
 *   Old (pre-discover): "district:hoot", "swiggy:1152615"
 *   New (from discover): "hoot", "1152615"
 *
 * Strip the prefix so scrapers always get the bare key.
 */
function stripPlatformPrefix(externalId: string): string {
  return externalId.replace(/^(district|swiggy|eazydiner|zomato):/, "");
}

async function loadTargets(): Promise<ScrapeTarget[]> {
  let q = supabase
    .from("dining_restaurants")
    .select(`
      id, canonical_name, area,
      dining_listings ( id, platform, external_id, url )
    `)
    .eq("city", "Bangalore")
    .order("canonical_name");

  if (nameFilter) {
    q = q.ilike("canonical_name", `%${nameFilter}%`);
  }
  if (limitArg) {
    q = q.limit(limitArg);
  }

  const { data, error } = await q;
  if (error) {
    console.error("Failed to load targets from DB:", error.message);
    process.exit(1);
  }

  return (data ?? [])
    .map((r) => ({
      restaurantId: r.id as string,
      name: r.canonical_name as string,
      area: r.area as string ?? "",
      listings: ((r.dining_listings as Array<{
        id: string; platform: string; external_id: string; url: string;
      }>) ?? []).map((l) => ({
        listingId: l.id,
        platform: l.platform as PlatformListing["platform"],
        externalId: stripPlatformPrefix(l.external_id),
        url: l.url,
      })),
    }))
    .filter((t) => t.listings.length > 0); // skip restaurants with no platform listings yet
}

// ── DB write helpers ──────────────────────────────────────────────────

async function updateListingHeadline(listingId: string, headlineOffer: string | null): Promise<void> {
  await supabase
    .from("dining_listings")
    .update({ headline_offer: headlineOffer, last_scraped_at: new Date().toISOString() })
    .eq("id", listingId);
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
  const targets = await loadTargets();

  if (targets.length === 0) {
    console.error(nameFilter ? `No restaurants found matching: ${nameFilter}` : "No restaurants in DB. Run dining:discover first.");
    process.exit(1);
  }

  console.log(`\n🍽  Dining scrape — ${targets.length} restaurant(s)${dryRun ? " [DRY RUN]" : ""}\n`);

  // Create one dining_run row for this entire run.
  let runId = "dry-run";
  if (!dryRun) {
    const { data, error } = await supabase
      .from("dining_runs")
      .insert({ platform: "all", city: "Bangalore", kind: "adhoc", status: "running" })
      .select("id")
      .single();
    if (error) { console.error("Failed to create dining_run:", error.message); process.exit(1); }
    runId = data.id as string;
  }

  let totalOffers = 0;
  let errors = 0;

  for (const target of targets) {
    console.log(`\n── ${target.name} (${target.area}) ──`);

    // Group listings by platform.
    const byPlatform = new Map<string, PlatformListing[]>();
    for (const l of target.listings) {
      const key = l.platform === "zomato" ? "district" : l.platform;
      if (!byPlatform.has(key)) byPlatform.set(key, []);
      byPlatform.get(key)!.push(l);
    }

    const results: PlatformResult[] = [];

    // District — aggregate all outlet slugs for this restaurant.
    const districtListings = byPlatform.get("district") ?? [];
    if (districtListings.length > 0) {
      const slugs = districtListings.map((l) => l.externalId).filter(Boolean);
      try {
        const offers = await scrapeDistrict(slugs);
        // Attribute offers to the first listing (they share the same canonical).
        results.push({ platform: "district", listingId: districtListings[0].listingId, offers });
        console.log(`  district:   ${offers.length} offers (${slugs.length} outlet(s))`);
      } catch (e) {
        results.push({ platform: "district", listingId: districtListings[0].listingId, offers: [], error: String(e) });
        console.log(`  district:   ERROR — ${String(e)}`);
        errors++;
      }
    }

    // Swiggy — first listing only (dineout has one listing per restaurant).
    const swiggyListing = (byPlatform.get("swiggy") ?? [])[0];
    if (swiggyListing) {
      try {
        const offers = await scrapeSwiggy(target.name, swiggyListing.externalId);
        results.push({ platform: "swiggy", listingId: swiggyListing.listingId, offers });
        console.log(`  swiggy:     ${offers.length} offers`);
      } catch (e) {
        results.push({ platform: "swiggy", listingId: swiggyListing.listingId, offers: [], error: String(e) });
        console.log(`  swiggy:     ERROR — ${String(e)}`);
        errors++;
      }
    }

    // EazyDiner — first listing only.
    const eazyListing = (byPlatform.get("eazydiner") ?? [])[0];
    if (eazyListing) {
      try {
        const offers = await scrapeEazyDiner(eazyListing.externalId);
        results.push({ platform: "eazydiner", listingId: eazyListing.listingId, offers });
        console.log(`  eazydiner:  ${offers.length} offers`);
      } catch (e) {
        results.push({ platform: "eazydiner", listingId: eazyListing.listingId, offers: [], error: String(e) });
        console.log(`  eazydiner:  ERROR — ${String(e)}`);
        errors++;
      }
    }

    // Print offers.
    for (const r of results) {
      for (const o of r.offers) {
        const tag = o.booking_type === "prebook" ? "📅" : "💳";
        console.log(`    ${tag} [${o.offer_type}] ${o.headline}`);
      }
    }

    if (dryRun) continue;

    // Write to DB.
    for (const r of results) {
      if (r.error) continue;
      try {
        const bestPrebook = r.offers
          .filter((o) => o.booking_type === "prebook" && o.discount_pct)
          .sort((a, b) => (b.discount_pct ?? 0) - (a.discount_pct ?? 0))[0];
        await updateListingHeadline(r.listingId, bestPrebook?.headline ?? r.offers[0]?.headline ?? null);
        await insertOffers(r.listingId, runId, r.offers);
        totalOffers += r.offers.length;
      } catch (e) {
        console.error(`  DB write failed for ${target.name}/${r.platform}: ${e}`);
        errors++;
      }
    }
  }

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
