import { diningFetchWithBackoff } from "../http";
import type { ScrapedOffer } from "../types";

/**
 * Result from scraping EazyDiner for one restaurant.
 * Includes both offer data and restaurant metadata (cuisines, price)
 * extracted from the same API response — no extra network call.
 */
export interface EazyDinerResult {
  offers: ScrapedOffer[];
  /** Cuisine tags, e.g. ["North Indian", "Chinese"]. Empty when API omits them. */
  cuisines: string[];
  /** Typical spend for two people in INR. Null when API omits it. */
  priceForTwo: number | null;
}

/**
 * Scrape EazyDiner for one restaurant.
 *
 * Endpoint: force.eazydiner.com/web/restaurants/bengaluru/{slug}
 * No auth required — guest access confirmed 2026-05-17.
 *
 * Parsed sections:
 *   deal_data.title                         → restaurant_discount (prebook)
 *   eazypay_details.text                    → payeazy (walkin)
 *   sample_discount_calculator.restaurant_offer → restaurant_discount (prebook)
 *   sample_discount_calculator.payment_offer    → payeazy (walkin)
 *   buffet_deals[]                          → buffet (prebook)
 *   cuisines / cuisine_names                → EazyDinerResult.cuisines
 *   average_cost / cost_for_two             → EazyDinerResult.priceForTwo
 */
export async function scrapeEazyDiner(
  eazyDinerSlug: string,
): Promise<EazyDinerResult> {
  const url = `https://force.eazydiner.com/web/restaurants/bengaluru/${eazyDinerSlug}`;
  const res = await diningFetchWithBackoff(url, {
    headers: {
      Accept: "application/json",
      Referer: `https://www.eazydiner.com/bengaluru/${eazyDinerSlug}`,
      Origin: "https://www.eazydiner.com",
    },
  });

  if (res.kind !== "ok") return { offers: [], cuisines: [], priceForTwo: null };

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    return { offers: [], cuisines: [], priceForTwo: null };
  }

  const data = (body.data ?? {}) as Record<string, unknown>;
  return {
    offers: parseEazyDinerOffers(data),
    cuisines: extractCuisines(data),
    priceForTwo: extractPriceForTwo(data),
  };
}

function parseEazyDinerOffers(data: Record<string, unknown>): ScrapedOffer[] {
  const offers: ScrapedOffer[] = [];

  // 1. Headline restaurant deal
  const dealData = data.deal_data as Record<string, unknown> | undefined;
  if (typeof dealData?.title === "string" && dealData.title !== "More Deals") {
    offers.push({
      offer_type: "restaurant_discount",
      booking_type: "prebook",
      headline: dealData.title,
      discount_pct: extractPct(dealData.title),
    });
  }

  // 2. PayEazy in-app payment offer
  const eazy = data.eazypay_details as Record<string, unknown> | undefined;
  if (typeof eazy?.text === "string") {
    offers.push({
      offer_type: "payeazy",
      booking_type: "walkin",
      headline: eazy.text,
      discount_pct: extractPct(eazy.text),
    });
  }

  // 3. Sample discount calculator — concrete ₹ amounts
  const calc = data.sample_discount_calculator as Record<string, unknown> | undefined;
  if (calc) {
    const bill = calc.total_bill as number | undefined;
    const restOff = calc.restaurant_offer as number | undefined;
    const payOff = calc.payment_offer as number | undefined;
    if (restOff && restOff > 0 && bill) {
      offers.push({
        offer_type: "restaurant_discount",
        booking_type: "prebook",
        headline: `₹${restOff} off on ₹${bill} bill`,
      });
    }
    if (payOff && payOff > 0 && bill) {
      offers.push({
        offer_type: "payeazy",
        booking_type: "walkin",
        headline: `₹${payOff} off on ₹${bill} bill (PayEazy)`,
      });
    }
  }

  // 4. Buffet packages
  const buffet = data.buffet_deals;
  if (Array.isArray(buffet) && buffet.length > 0) {
    const prices = (buffet as Array<Record<string, unknown>>)
      .map((b) => Number(b.price ?? b.net_price ?? 0))
      .filter((p) => p > 0)
      .sort((a, b) => a - b);
    const fromPrice = prices[0];
    const headline = fromPrice
      ? `${buffet.length} buffet package(s) — from ₹${fromPrice}`
      : `${buffet.length} buffet package(s) available`;
    offers.push({
      offer_type: "buffet",
      booking_type: "prebook",
      headline,
    });
  }

  // Dedupe (deal_data.title and calculator can overlap)
  const seen = new Set<string>();
  return offers.filter((o) => {
    const key = `${o.offer_type}::${o.headline}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractPct(text: string): number | undefined {
  const m = text.match(/(\d+)%/);
  return m ? parseInt(m[1], 10) : undefined;
}

/**
 * Extract cuisine tags from the EazyDiner API response.
 *
 * The API uses different keys across restaurant types:
 *   data.cuisines          → array of strings (most common)
 *   data.cuisine_names     → comma-separated string (older entries)
 *   data.tags              → fallback array (may include non-cuisine tags)
 */
export function extractCuisines(data: Record<string, unknown>): string[] {
  const raw = data.cuisines ?? data.cuisine_names;
  if (Array.isArray(raw)) {
    return raw
      .map((c) => (typeof c === "string" ? c.trim() : typeof c === "object" && c !== null ? String((c as Record<string, unknown>).name ?? "").trim() : ""))
      .filter(Boolean);
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",").map((c) => c.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Extract price-for-two from the EazyDiner API response.
 *
 * Key priority:
 *   data.average_cost      → direct INR integer (most common)
 *   data.cost_for_two      → alternative key
 *   data.cost_for_one * 2  → fallback when only per-person cost is present
 */
export function extractPriceForTwo(data: Record<string, unknown>): number | null {
  const candidates = [
    data.average_cost,
    data.cost_for_two,
    typeof data.cost_for_one === "number" ? data.cost_for_one * 2 : null,
  ];
  for (const v of candidates) {
    if (typeof v === "number" && v > 0) return Math.round(v);
  }
  return null;
}
