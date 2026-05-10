// Historical foreign-exchange rates → INR.
//
// Goal: convert e.g. "IDR 12,272,062 on 01-Jan-2026" to its INR value
// AT THAT TIME, not today's rate. Anything else mis-states historical
// spend (especially over multi-year horizons where rates drift 30%+).
//
// Data flow:
//   1. Check the fx_rates table cache (currency, date) → rate_to_inr.
//   2. Cache miss → hit the upstream API (fawazahmed0/currency-api on
//      jsdelivr; free, no API key, ECB-backed for majors + IDR/THB/etc.).
//   3. Write result back to fx_rates so the next call is instant.
//
// Failure handling:
//   • If the API returns nothing (rare currency, weekend gap, network
//     down), we return null. The caller decides what to do (typically
//     leave amount_inr=0 and let the user click "Refresh rates").
//   • Weekends/holidays: the API itself rolls forward to the most recent
//     business day, so we don't need to do that ourselves.
//
// API details:
//   GET https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@<date>/v1/currencies/<from>.json
//   Where <date> is "YYYY-MM-DD" or "latest".
//   Response shape: { date: "...", <from>: { inr: 0.0053, usd: 0.000063, ... } }

import type { SupabaseClient } from "@supabase/supabase-js";

/** Format a Date as YYYY-MM-DD in UTC. Used as the FX rate key. */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Get 1 unit of `currency` in INR on `date`. Returns null if unavailable.
 * Returns 1 immediately for INR (degenerate case — saves API/DB calls).
 */
export async function getRateToInr(
  supabase: SupabaseClient,
  currency: string,
  date: Date,
): Promise<number | null> {
  const code = currency.toUpperCase();
  if (code === "INR") return 1;

  const dateStr = ymd(date);

  // 1. Cache hit?
  const { data: cached } = await supabase
    .from("fx_rates")
    .select("rate_to_inr")
    .eq("currency", code)
    .eq("rate_date", dateStr)
    .maybeSingle();

  if (cached?.rate_to_inr != null) return Number(cached.rate_to_inr);

  // 2. Cache miss — fetch from upstream.
  const rate = await fetchUpstreamRate(code, dateStr);
  if (rate == null) return null;

  // 3. Write-through cache. Ignore conflict (race with another writer is
  //    fine — same rate either way).
  await supabase.from("fx_rates").upsert(
    { currency: code, rate_date: dateStr, rate_to_inr: rate },
    { onConflict: "currency,rate_date" },
  );

  return rate;
}

/**
 * Hit the fawazahmed0/currency-api endpoint. Returns null on any failure
 * (network, 404, malformed JSON, missing INR key) — caller treats null
 * as "not available, try later".
 *
 * The CDN URL is intentionally hard-coded (jsdelivr) — no env var, no
 * config. If/when we want a different provider, swap this function.
 */
async function fetchUpstreamRate(code: string, dateStr: string): Promise<number | null> {
  const lower = code.toLowerCase();

  // Two CDN mirrors — try the second if the first fails (jsdelivr has
  // occasional regional flakiness).
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${dateStr}/v1/currencies/${lower}.json`,
    `https://${dateStr}.currency-api.pages.dev/v1/currencies/${lower}.json`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const json: Record<string, unknown> = await res.json();
      // Response shape: { date: "...", "<lower>": { inr: <number>, ... } }
      const block = json[lower];
      if (block && typeof block === "object" && "inr" in block) {
        const rate = Number((block as Record<string, unknown>).inr);
        if (isFinite(rate) && rate > 0) return rate;
      }
    } catch {
      // Fall through to the next URL.
    }
  }
  return null;
}

/**
 * Bulk-fetch rates for many (currency, date) pairs. Used by the
 * "Refresh rates" sweep endpoint to avoid N synchronous HTTP calls.
 *
 * Returns a Map keyed by `${code}|${date}` → rate (or null if unavailable).
 * Rates are written to the cache as a side effect.
 *
 * Concurrency capped at 5 to be polite to the free CDN.
 */
export async function getRatesBulk(
  supabase: SupabaseClient,
  pairs: Array<{ currency: string; date: Date }>,
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  const queue = pairs.map(({ currency, date }) => ({
    currency: currency.toUpperCase(),
    date,
    key: `${currency.toUpperCase()}|${ymd(date)}`,
  }));

  const CONCURRENCY = 5;
  let cursor = 0;

  async function worker() {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      const rate = await getRateToInr(supabase, item.currency, item.date);
      result.set(item.key, rate);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return result;
}
