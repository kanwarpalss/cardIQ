// Browser-side loader for Rewards → Live deals. Reads through Supabase RLS
// (own rows only), the same way the rest of the Redemptions section loads.

import { createClient } from "@/lib/supabase/client";
import { isMissingTableError } from "@/lib/supabase/errors";
import { toStoredDeal } from "./status";
import type { DealRun, StoredDeal } from "./types";

export type DealsData = {
  deals: StoredDeal[];
  /** Newest first, enough to judge the job's health. */
  runs: DealRun[];
  /** Migration 024 hasn't been run yet. */
  tableMissing: boolean;
  error: string | null;
};

const PAGE = 1000;

export async function loadDeals(): Promise<DealsData> {
  const sb = createClient();
  const deals: StoredDeal[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from("deals").select("*")
      .order("last_seen_at", { ascending: false }).range(from, from + PAGE - 1);
    if (error) {
      return { deals: [], runs: [], tableMissing: isMissingTableError(error), error: isMissingTableError(error) ? null : error.message };
    }
    // numeric columns arrive as strings from PostgREST.
    deals.push(...(data ?? []).map(toStoredDeal));
    if (!data || data.length < PAGE) break;
  }
  const { data: runs, error } = await sb.from("deal_runs")
    .select("started_at, finished_at, ok, summary").order("started_at", { ascending: false }).limit(10);
  return { deals, runs: (runs ?? []) as DealRun[], tableMissing: false, error: error?.message ?? null };
}
