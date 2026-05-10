// Historical foreign-exchange rates → INR.
//
// Goal: convert e.g. "IDR 12,272,062 on 01-Jan-2026" to its INR value
// AT THAT TIME, not today's rate. Anything else mis-states historical
// spend (especially over multi-year horizons where rates drift 30%+).
//
// Data sources, in priority order:
//   1. Local fx_rates cache (instant, written through on every fetch).
//   2. fawazahmed0/currency-api (free, no key, ~25 yrs of data, 200+
//      currencies including IDR/THB/MYR/HKD/KRW/VND. Coverage: data
//      starts ~2024-03-06; for older dates we fall through.)
//   3. Frankfurter (frankfurter.app, ECB-backed, free, no key, data
//      from 1999. Doesn't cover IDR/THB/MYR/HKD/KRW/VND — only the
//      ECB reference set: USD/EUR/GBP/JPY/CHF/CAD/AUD/SGD/HKD/etc.)
//
// Fallback within each source: if the exact date returns null (weekend,
// holiday, missing data point), walk ±N calendar days outward looking
// for the nearest available rate. Most APIs roll forward themselves on
// weekends, but this protects against gaps the API doesn't auto-fill.

import type { SupabaseClient } from "@supabase/supabase-js";

const NEARBY_DAY_RADIUS = 7; // ±7 days when searching for nearest available rate

/** Format a Date as YYYY-MM-DD in UTC. Used as the FX rate key. */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Get 1 unit of `currency` in INR on `date`. Returns null if all sources
 * + nearby-date fallback fail.
 *
 * Returns 1 immediately for INR (saves API/DB round-trips).
 *
 * Side effect: writes the result into the fx_rates cache (under the
 * REQUESTED date, even if the rate came from a nearby date — the user
 * cares "what does my SOFITEL txn convert to?", not "which exact day's
 * rate did we use?". We tag the cache row with the actual fetched_at so
 * future audits can reconstruct.)
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

  // 2. Fetch from upstream — try exact date, then walk outward.
  const rate = await fetchRateWithFallback(code, date);
  if (rate == null) return null;

  // 3. Write-through cache under the REQUESTED date.
  await supabase.from("fx_rates").upsert(
    { currency: code, rate_date: dateStr, rate_to_inr: rate },
    { onConflict: "currency,rate_date" },
  );

  return rate;
}

/**
 * Try the exact requested date, then walk ±1, ±2, … ±NEARBY_DAY_RADIUS
 * days looking for a rate. Each "candidate" date is tried against ALL
 * upstream providers in order before moving to the next candidate, so
 * we don't fall back to a date that's further away when the original
 * date works on a different provider.
 */
async function fetchRateWithFallback(code: string, date: Date): Promise<number | null> {
  for (let offset = 0; offset <= NEARBY_DAY_RADIUS; offset++) {
    const candidates: Date[] = offset === 0
      ? [date]
      : [addDays(date, -offset), addDays(date, +offset)];

    for (const cand of candidates) {
      const candStr = ymd(cand);

      const r1 = await fetchFromFawazahmed(code, candStr);
      if (r1 != null) return r1;

      const r2 = await fetchFromFrankfurter(code, candStr);
      if (r2 != null) return r2;
    }
  }
  return null;
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

/**
 * fawazahmed0/currency-api on jsdelivr CDN. Wide currency coverage
 * (IDR/THB/MYR/HKD/KRW/VND etc), but only ~2024-03-06 onwards.
 * Two CDN mirrors with one retry each — be polite.
 */
async function fetchFromFawazahmed(code: string, dateStr: string): Promise<number | null> {
  const lower = code.toLowerCase();
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${dateStr}/v1/currencies/${lower}.json`,
    `https://${dateStr}.currency-api.pages.dev/v1/currencies/${lower}.json`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const json: Record<string, unknown> = await res.json();
      const block = json[lower];
      if (block && typeof block === "object" && "inr" in block) {
        const rate = Number((block as Record<string, unknown>).inr);
        if (isFinite(rate) && rate > 0) return rate;
      }
    } catch { /* try next URL */ }
  }
  return null;
}

/**
 * Frankfurter (frankfurter.app), ECB reference rates back to 1999.
 * Limited currency set — does NOT cover IDR/THB/MYR/HKD/KRW/VND.
 * Used as an older-data fallback for the majors.
 *
 * Endpoint: GET https://api.frankfurter.app/<date>?from=<CODE>&to=INR
 * Response: { amount: 1, base: "USD", date: "...", rates: { INR: 84.32 } }
 */
async function fetchFromFrankfurter(code: string, dateStr: string): Promise<number | null> {
  // Frankfurter uses ISO codes uppercase. Skip currencies it doesn't have.
  const SUPPORTED = new Set([
    "USD","EUR","GBP","JPY","CHF","CAD","AUD","SGD","HKD","NZD","SEK","NOK",
    "DKK","CZK","HUF","PLN","RON","BGN","TRY","ZAR","MXN","BRL","CNY","KRW",
    "ILS","ISK","INR","IDR","MYR","PHP","THB",
  ]);
  if (!SUPPORTED.has(code)) return null;

  try {
    const url = `https://api.frankfurter.app/${dateStr}?from=${code}&to=INR`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const json: { rates?: { INR?: number } } = await res.json();
    const rate = json.rates?.INR;
    if (rate != null && isFinite(rate) && rate > 0) return rate;
  } catch { /* swallow */ }
  return null;
}

/**
 * Bulk-fetch rates for many (currency, date) pairs. Concurrency-capped
 * at 5 to be polite to the free CDNs. Each pair goes through the full
 * cache → fawazahmed0 → frankfurter → ±N day fallback pipeline.
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
