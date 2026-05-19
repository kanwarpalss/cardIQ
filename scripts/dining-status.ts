#!/usr/bin/env -S npx tsx
/**
 * dining-status.ts — quick DB snapshot for the dining pipeline.
 *
 * Shows restaurant/listing/offer counts, Phase 2 readiness (how many
 * canonicals still have no Swiggy listing), the review queue size, and
 * the last scrape run result.
 *
 * Usage:  npm run dining:status
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  console.log("\n📊  Dining pipeline status\n");

  // ── Restaurants ────────────────────────────────────────────────────

  const { count: totalRestaurants } = await supabase
    .from("dining_restaurants")
    .select("*", { count: "exact", head: true })
    .eq("city", "Bangalore");

  // ── Listings by platform ───────────────────────────────────────────

  const { data: allListings } = await supabase
    .from("dining_listings")
    .select("platform, restaurant_id");

  const platformCounts = new Map<string, number>();
  const restaurantsWithPlatform = new Map<string, Set<string>>();

  for (const l of allListings ?? []) {
    const p = l.platform === "zomato" ? "district" : (l.platform as string);
    platformCounts.set(p, (platformCounts.get(p) ?? 0) + 1);
    if (!restaurantsWithPlatform.has(p)) restaurantsWithPlatform.set(p, new Set());
    restaurantsWithPlatform.get(p)!.add(l.restaurant_id as string);
  }

  const swiggyRestaurantIds = restaurantsWithPlatform.get("swiggy") ?? new Set();
  const withoutSwiggy = (totalRestaurants ?? 0) - swiggyRestaurantIds.size;

  // ── Offers ─────────────────────────────────────────────────────────

  const { count: totalOffers } = await supabase
    .from("dining_offers")
    .select("*", { count: "exact", head: true });

  // ── Review queue ───────────────────────────────────────────────────

  const { count: pendingReview } = await supabase
    .from("dining_dedupe_queue")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending");

  // ── Last scrape run ────────────────────────────────────────────────

  const { data: lastRuns } = await supabase
    .from("dining_runs")
    .select("status, started_at, finished_at, offers_seen")
    .order("started_at", { ascending: false })
    .limit(1);

  const lastRun = lastRuns?.[0];

  // ── Restaurants with cuisines populated ────────────────────────────

  const { count: withCuisines } = await supabase
    .from("dining_restaurants")
    .select("*", { count: "exact", head: true })
    .eq("city", "Bangalore")
    .not("cuisines", "eq", "{}");

  // ── Print ──────────────────────────────────────────────────────────

  console.log(`Restaurants (canonicals): ${totalRestaurants ?? 0}`);
  console.log(`  ↳ with cuisines data:   ${withCuisines ?? 0}`);

  console.log(`\nListings by platform:`);
  const PLATFORM_ORDER = ["district", "swiggy", "eazydiner"];
  for (const p of PLATFORM_ORDER) {
    const count = platformCounts.get(p) ?? 0;
    const unique = restaurantsWithPlatform.get(p)?.size ?? 0;
    console.log(`  ${p.padEnd(12)} ${String(count).padStart(5)} listings  (${unique} restaurants)`);
  }

  console.log(`\nPhase 2 readiness:`);
  console.log(`  Canonicals without Swiggy: ${withoutSwiggy}  ← run --platform=swiggy when Phase 1 done`);

  console.log(`\nOffers in DB:    ${totalOffers ?? 0}`);
  console.log(`Review queue:    ${pendingReview ?? 0} pending`);

  if (lastRun) {
    const started = lastRun.started_at
      ? new Date(lastRun.started_at as string).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
      : "?";
    const finished = lastRun.finished_at
      ? new Date(lastRun.finished_at as string).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
      : "still running";
    console.log(`\nLast scrape run:`);
    console.log(`  Status:   ${lastRun.status}`);
    console.log(`  Started:  ${started}`);
    console.log(`  Finished: ${finished}`);
    console.log(`  Offers:   ${lastRun.offers_seen ?? 0}`);
  } else {
    console.log(`\nLast scrape run: never`);
  }

  console.log("");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
