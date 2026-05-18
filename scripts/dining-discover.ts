#!/usr/bin/env -S npx tsx
/**
 * dining-discover.ts — discovery pass for all Bangalore restaurants.
 *
 * Phase 1: Pulls District (27K outlets) + EazyDiner (~2K restaurants)
 *          via public sitemaps / paginated HTML. Fast, ~10 min total.
 * Phase 2: For each canonical found in Phase 1, searches Swiggy by name
 *          to find its Swiggy Dineout ID (if any). Slow, ~2-4h for all.
 *
 * Results are written to dining_listings (skeletons) and dining_restaurants
 * (canonicals). Existing rows are upserted — safe to re-run.
 *
 * Usage:
 *   npm run dining:discover                        # full Phase 1 + 2
 *   npm run dining:discover -- --phase=1           # District + EazyDiner only
 *   npm run dining:discover -- --dry-run           # print counts, no DB writes
 *   npm run dining:discover -- --platform=district # one platform only
 *
 * After running, dining-scrape.ts will automatically pick up the new
 * listings from the DB (it's been refactored to be DB-driven).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { discoverDistrict } from "../src/lib/dining/discover/district";
import { discoverEazyDiner } from "../src/lib/dining/discover/eazydiner";
import { discoverSwiggyBatch } from "../src/lib/dining/discover/swiggy";
import {
  preFilterCandidates,
  resolveListing,
  findMergeCandidates,
} from "../src/lib/dining/dedupe";
import type { CanonicalCandidate, IncomingListing, ManualLink } from "../src/lib/dining/dedupe";
import type { DiscoveredListing } from "../src/lib/dining/discover/types";

// ── CLI args ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const phaseArg = args.includes("--phase") ? args[args.indexOf("--phase") + 1] : null;
const platformArg = args.includes("--platform") ? args[args.indexOf("--platform") + 1] : null;
const dryRun = args.includes("--dry-run");
const phase1Only = phaseArg === "1";

// ── Supabase client ───────────────────────────────────────────────────

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ── DB helpers ────────────────────────────────────────────────────────

async function loadManualLinks(): Promise<ManualLink[]> {
  const { data, error } = await supabase
    .from("dining_manual_links")
    .select("platform_a,external_id_a,platform_b,external_id_b,decision");
  if (error) { console.warn("  Could not load manual links:", error.message); return []; }
  return (data ?? []).map((r) => ({
    platformA: r.platform_a as ManualLink["platformA"],
    externalIdA: r.external_id_a,
    platformB: r.platform_b as ManualLink["platformB"],
    externalIdB: r.external_id_b,
    decision: r.decision as "same" | "different",
  }));
}

/**
 * Load canonicals for a given area from the DB (bounded memory).
 * Falls back to loading ALL canonicals if area is null.
 */
async function loadCandidatesForArea(area: string | null): Promise<CanonicalCandidate[]> {
  let q = supabase
    .from("dining_restaurants")
    .select(`
      id, canonical_name, area, lat, lng,
      dining_listings ( platform, external_id )
    `)
    .eq("city", "Bangalore");

  if (area) {
    q = q.ilike("area", `%${area.split(" ")[0]}%`); // fuzzy area match on first word
  }

  const { data, error } = await q.limit(500);
  if (error) { console.warn("  DB load error:", error.message); return []; }

  return (data ?? []).map((r) => ({
    id: r.id as string,
    canonicalName: r.canonical_name as string,
    area: r.area as string | null,
    lat: r.lat != null ? Number(r.lat) : null,
    lng: r.lng != null ? Number(r.lng) : null,
    linkedListings: ((r.dining_listings as Array<{ platform: string; external_id: string }>) ?? [])
      .map((l) => ({ platform: l.platform as IncomingListing["platform"], externalId: l.external_id })),
  }));
}

async function upsertCanonical(listing: DiscoveredListing): Promise<string> {
  const { data, error } = await supabase
    .from("dining_restaurants")
    .upsert(
      {
        canonical_name: listing.name,
        area: listing.area ?? null,
        city: "Bangalore",
        lat: listing.lat ?? null,
        lng: listing.lng ?? null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "canonical_name,lat,lng" },
    )
    .select("id")
    .single();
  if (error) throw new Error(`upsertCanonical ${listing.name}: ${error.message}`);
  return data.id as string;
}

async function upsertListing(restaurantId: string, listing: DiscoveredListing): Promise<void> {
  const platformDb = listing.platform === "zomato" ? "zomato" : listing.platform;
  const { error } = await supabase
    .from("dining_listings")
    .upsert(
      {
        restaurant_id: restaurantId,
        platform: platformDb,
        external_id: listing.externalId,
        url: listing.url,
        discovered_at: new Date().toISOString(),
        last_scraped_at: new Date().toISOString(),
      },
      { onConflict: "platform,external_id" },
    );
  if (error) throw new Error(`upsertListing ${listing.platform}/${listing.externalId}: ${error.message}`);
}

async function queueForReview(
  incoming: IncomingListing,
  peerPlatform: IncomingListing["platform"],
  peerExternalId: string,
  canonicalId: string,
  reason: string,
  nameA: string,
  nameB?: string,
): Promise<void> {
  console.log(
    `    ⚠  REVIEW: ${incoming.platform}::${incoming.externalId} vs ${peerPlatform}::${peerExternalId}`,
  );
  const { error } = await supabase
    .from("dining_dedupe_queue")
    .upsert(
      {
        platform_a: incoming.platform,
        external_id_a: incoming.externalId,
        name_a: nameA,
        platform_b: peerPlatform,
        external_id_b: peerExternalId,
        name_b: nameB ?? null,
        canonical_id: canonicalId,
        reason,
        status: "pending",
      },
      { onConflict: "platform_a,external_id_a,platform_b,external_id_b", ignoreDuplicates: true },
    );
  if (error) console.warn("    Could not queue review pair:", error.message);
}

// ── Dedupe + write one listing ────────────────────────────────────────

async function ingestListing(
  listing: DiscoveredListing,
  manualLinks: ManualLink[],
  candidatesByArea: Map<string, CanonicalCandidate[]>,
): Promise<"created" | "attached" | "review" | "skipped"> {
  const incoming: IncomingListing = {
    platform: listing.platform,
    externalId: listing.externalId,
    name: listing.name,
    area: listing.area,
    lat: listing.lat,
    lng: listing.lng,
  };

  // Load area-scoped candidates (bounded memory vs. loading all 15K).
  const areaKey = listing.area ?? "__none__";
  if (!candidatesByArea.has(areaKey)) {
    const cands = await loadCandidatesForArea(listing.area ?? null);
    candidatesByArea.set(areaKey, cands);
  }
  const allCandidates = candidatesByArea.get(areaKey)!;
  const candidates = preFilterCandidates(incoming, allCandidates);
  const action = resolveListing(incoming, candidates, manualLinks);

  if (dryRun) return "skipped";

  try {
    if (action.kind === "create") {
      const id = await upsertCanonical(listing);
      await upsertListing(id, listing);
      // Add to in-memory cache so subsequent listings in the same area see it.
      allCandidates.push({
        id,
        canonicalName: listing.name,
        area: listing.area,
        lat: listing.lat,
        lng: listing.lng,
        linkedListings: [{ platform: listing.platform, externalId: listing.externalId }],
      });
      return "created";
    }

    if (action.kind === "attach" || action.kind === "attach_by_override") {
      await upsertListing(action.canonicalId, listing);
      // Update in-memory candidate.
      const c = allCandidates.find((c) => c.id === action.canonicalId);
      if (c) c.linkedListings.push({ platform: incoming.platform, externalId: incoming.externalId });
      return "attached";
    }

    if (action.kind === "attach_for_review") {
      await upsertListing(action.canonicalId, listing);
      const peer = allCandidates.find((c) => c.id === action.canonicalId);
      await queueForReview(
        incoming,
        action.candidatePair.bPlatform,
        action.candidatePair.bExternalId,
        action.canonicalId,
        action.reason,
        listing.name,
        peer?.canonicalName,
      );
      return "review";
    }
  } catch (e) {
    console.error(`    DB error for ${listing.platform}/${listing.externalId}: ${e}`);
  }

  return "skipped";
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 Dining discovery — Bangalore${dryRun ? " [DRY RUN]" : ""}\n`);

  const manualLinks = dryRun ? [] : await loadManualLinks();
  const candidatesByArea = new Map<string, CanonicalCandidate[]>();

  let totalCreated = 0, totalAttached = 0, totalReview = 0, totalSkipped = 0;

  // ── Phase 1: District + EazyDiner bulk discovery ──────────────────

  const phase1Platforms: Array<"district" | "eazydiner"> = [];
  if (!platformArg || platformArg === "district") phase1Platforms.push("district");
  if (!platformArg || platformArg === "eazydiner") phase1Platforms.push("eazydiner");

  for (const platform of phase1Platforms) {
    console.log(`\n── ${platform === "district" ? "District (Zomato Dining)" : "EazyDiner"} ──`);
    const result = platform === "district"
      ? await discoverDistrict()
      : await discoverEazyDiner();

    console.log(
      `  Discovery: ${result.stats.listingsUnique} unique listings` +
      ` (${result.stats.listingsRaw} raw, ` +
      `${result.stats.pagesFetched} pages fetched, ${result.stats.pagesFailed} failed)`,
    );

    let created = 0, attached = 0, review = 0, skipped = 0;
    let i = 0;
    for (const listing of result.listings) {
      i++;
      if (i % 500 === 0) console.log(`  Progress: ${i}/${result.listings.length}…`);
      const outcome = await ingestListing(listing, manualLinks, candidatesByArea);
      if (outcome === "created") created++;
      else if (outcome === "attached") attached++;
      else if (outcome === "review") review++;
      else skipped++;
    }

    console.log(`  Result: +${created} new canonicals, ${attached} attached, ${review} queued for review`);
    totalCreated += created; totalAttached += attached;
    totalReview += review; totalSkipped += skipped;
  }

  // ── Phase 2: Swiggy bootstrap from existing canonicals ───────────

  if (!phase1Only && (!platformArg || platformArg === "swiggy")) {
    console.log("\n── Swiggy Dineout (bootstrap from canonicals) ──");

    // Load ALL canonicals for Swiggy matching (need names + geo).
    const { data: allCanonicals } = await supabase
      .from("dining_restaurants")
      .select("id, canonical_name, lat, lng")
      .eq("city", "Bangalore");

    // Only run Swiggy for canonicals that don't already have a Swiggy listing.
    const { data: existingSwiggy } = await supabase
      .from("dining_listings")
      .select("restaurant_id")
      .eq("platform", "swiggy");

    const existingSwiggyRestaurantIds = new Set(
      (existingSwiggy ?? []).map((r) => r.restaurant_id as string),
    );

    const toSearch = (allCanonicals ?? [])
      .filter((r) => !existingSwiggyRestaurantIds.has(r.id as string))
      .map((r) => ({ name: r.canonical_name as string, lat: r.lat as number | null, lng: r.lng as number | null }));

    console.log(`  Searching Swiggy for ${toSearch.length} canonicals without Swiggy listing…`);

    const swiggyResult = await discoverSwiggyBatch(toSearch);
    console.log(`  Found: ${swiggyResult.stats.listingsUnique} valid Swiggy Dineout IDs`);

    // Write Swiggy listings — these need to be linked to the right canonical.
    // Since we searched by canonical name, we match back by name.
    const nameToCanonicalId = new Map<string, string>(
      (allCanonicals ?? []).map((r) => [r.canonical_name as string, r.id as string]),
    );

    let swiggyLinked = 0;
    for (const sl of swiggyResult.listings) {
      // Find canonical by name match (the search used this name as the query).
      const canonicalId = nameToCanonicalId.get(sl.name);
      if (!canonicalId || dryRun) continue;
      try {
        await upsertListing(canonicalId, sl);
        swiggyLinked++;
      } catch (e) {
        console.error(`  Swiggy link error: ${e}`);
      }
    }
    console.log(`  Linked ${swiggyLinked} Swiggy listings to existing canonicals`);
    totalAttached += swiggyLinked;
  }

  // ── Post-run merge pass ───────────────────────────────────────────

  if (!dryRun && !phase1Only) {
    console.log("\n── Post-run merge pass ──");
    const allCandidates: CanonicalCandidate[] = [];
    for (const cands of candidatesByArea.values()) allCandidates.push(...cands);
    const mergePairs = findMergeCandidates(allCandidates);
    const definite = mergePairs.filter((p) => p.confidence === "definite");
    const maybe = mergePairs.filter((p) => p.confidence === "maybe" || p.confidence === "likely");
    if (definite.length > 0) {
      console.log(`  ${definite.length} definite merge candidates found (manual review recommended)`);
    }
    if (maybe.length > 0) {
      console.log(`  ${maybe.length} maybe/likely pairs — surfacing in review UI`);
    }
  }

  console.log(
    `\n✅ Done — ${totalCreated} new canonicals, ${totalAttached} listings attached` +
    (totalReview > 0 ? `, ${totalReview} queued for review` : "") +
    (dryRun ? " [DRY RUN — nothing written]" : ""),
  );
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
