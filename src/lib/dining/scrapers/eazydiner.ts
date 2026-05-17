import { diningFetchWithBackoff } from "../http";
import type { ScrapedOffer } from "../types";

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
 */
export async function scrapeEazyDiner(
  eazyDinerSlug: string,
): Promise<ScrapedOffer[]> {
  const url = `https://force.eazydiner.com/web/restaurants/bengaluru/${eazyDinerSlug}`;
  const res = await diningFetchWithBackoff(url, {
    headers: {
      Accept: "application/json",
      Referer: `https://www.eazydiner.com/bengaluru/${eazyDinerSlug}`,
      Origin: "https://www.eazydiner.com",
    },
  });

  if (res.kind !== "ok") return [];

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    return [];
  }

  const data = (body.data ?? {}) as Record<string, unknown>;
  return parseEazyDinerOffers(data);
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
