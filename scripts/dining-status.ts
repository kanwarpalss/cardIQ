#!/usr/bin/env -S npx tsx
/**
 * dining-status.ts — quick DB snapshot for the dining pipeline.
 *
 * Shows restaurant/listing/offer counts, Phase 2 readiness (how many
 * canonicals still have no Swiggy listing), the review queue size, and
 * the last scrape run result.
 *
 * Usage:  npm run dining:status
 *
 * NOTE: Supabase caps single queries at 1,000 rows. Every query that
 * touches a large table (dining_listings has 29K+ rows) MUST paginate.
 * Use fetchAllPages() for those — never a bare .select() without .limit().
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/** Paginate through ALL rows of a query, bypassing Supabase's 1000-row cap. */
async function fetchAllPages<T extends Record<string, unknown>>(
  builder: () => ReturnType<typeof supabase.from>,
  columns: string,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await (builder() as any)
      .select(columns)
      .range(from, from + PAGE - 1);
    if (error) { console.warn("  paginate error:", error.message); break; }
    if (!data || data.length === 0) break;
    out.push(...(data as T[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function main() {
  console.log("\n📊  Dining pipeline status\n");

  // ── Restaurants (count only — no row cap issue) ────────────────────

  const { count: totalRestaurants } = await supabase
    .from("dining_restaurants")
    .select("*", { count: "exact", head: true })
    .eq("city", "Bangalore");

  const { count: withCuisines } = await supabase
    .from("dining_restaurants")
    .select("*", { count: "exact", head: true })
    .eq("city", "Bangalore")
    .not("cuisines", "eq", "{}");

  // ── Listings by platform — MUST paginate (29K+ rows) ───────────────

  const allListings = await fetchAllPages<{ platform: string; restaurant_id: string }>(
    () => supabase.from("dining_listings"),
    "platform, restaurant_id",
  );

  const platformCounts = new Map<string, number>();
  const restaurantsWithPlatform = new Map<string, Set<string>>();

  for (const l of allListings) {
    const p = l.platform === "zomato" ? "district" : l.platform;
    platformCounts.set(p, (platformCounts.get(p) ?? 0) + 1);
    if (!restaurantsWithPlatform.has(p)) restaurantsWithPlatform.set(p, new Set());
    restaurantsWithPlatform.get(p)!.add(l.restaurant_id);
  }

  const swiggyDone = restaurantsWithPlatform.get("swiggy")?.size ?? 0;
  const withoutSwiggy = (totalRestaurants ?? 0) - swiggyDone;

  // ── Offers + queue (count only) ────────────────────────────────────

  const { count: totalOffers } = await supabase
    .from("dining_offers")
    .select("*", { count: "exact", head: true });

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

  // ── Print ──────────────────────────────────────────────────────────

  console.log(`Restaurants (canonicals): ${totalRestaurants ?? 0}`);
  console.log(`  ↳ with cuisines data:   ${withCuisines ?? 0}`);

  console.log(`\nListings by platform:`);
  for (const p of ["district", "swiggy", "eazydiner"]) {
    const count = platformCounts.get(p) ?? 0;
    const unique = restaurantsWithPlatform.get(p)?.size ?? 0;
    console.log(`  ${p.padEnd(12)} ${String(count).padStart(6)} listings  (${unique} restaurants)`);
  }

  console.log(`\nPhase 2 — Swiggy:`);
  console.log(`  Done:      ${swiggyDone} restaurants`);
  console.log(`  Remaining: ${withoutSwiggy} restaurants`);

  console.log(`\nOffers in DB:    ${totalOffers ?? 0}`);
  console.log(`Review queue:    ${pendingReview ?? 0} pending`);

  if (lastRun) {
    const fmt = (ts: string | null) =>
      ts ? new Date(ts).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—";
    console.log(`\nLast scrape run:`);
    console.log(`  Status:   ${lastRun.status}`);
    console.log(`  Started:  ${fmt(lastRun.started_at as string | null)}`);
    console.log(`  Finished: ${fmt(lastRun.finished_at as string | null)}`);
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
