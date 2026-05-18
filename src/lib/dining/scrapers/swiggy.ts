import { diningFetchWithBackoff } from "../http";
import type { ScrapedOffer } from "../types";

const BANGALORE_LAT = "12.9716";
const BANGALORE_LNG = "77.5946";

/**
 * Scrape Swiggy Dineout for one restaurant.
 *
 * Requires an explicit swiggyDineoutId — the Dineout restaurant ID from
 * disc.swiggy.com (NOT the food-delivery ID; they share IDs in most cases
 * but diverge for multi-outlet chains like Tiger Trail).
 *
 * Fetches disc.swiggy.com/api/v1/dinersone-restaurant/json and parses:
 *   - addOnOffer.offers[]       → addon_coupon / addon_cashback (walkin, platform-wide)
 *   - tabsOfferInfo.offersTab[] → prebook_pct (prebook, restaurant-specific)
 */
export async function scrapeSwiggy(
  restaurantName: string,
  swiggyDineoutId: string,
): Promise<ScrapedOffer[]> {
  const id = swiggyDineoutId;
  // IDs stored by dining-discover.ts are verified dineout IDs.
  // IDs in the original hand-curated list were also manually verified.
  // If an unverified food-delivery ID slips through, scrapeSwiggy returns []
  // gracefully (the dineout endpoint returns a valid 200 with no offer cards).
  if (!id) return [];

  const url = `https://disc.swiggy.com/api/v1/dinersone-restaurant/json?restaurantId=${id}`;
  const res = await diningFetchWithBackoff(url, {
    headers: {
      latitude: BANGALORE_LAT,
      longitude: BANGALORE_LNG,
      Referer: "https://www.swiggy.com/dineout",
      Origin: "https://www.swiggy.com",
    },
  });

  if (res.kind !== "ok") return [];

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    return [];
  }

  return parseSwiggyOffers(body);
}


function parseSwiggyOffers(body: Record<string, unknown>): ScrapedOffer[] {
  const offers: ScrapedOffer[] = [];
  const cards = (((body.success as Record<string, unknown> | undefined)?.cards ?? []) as Array<Record<string, unknown>>);

  for (const c of cards) {
    const card = ((c.card as Record<string, unknown>)?.card as Record<string, unknown> | undefined);
    if (!card) continue;
    if (!((card["@type"] as string | undefined)?.includes("DealAndOfferInfo"))) continue;

    const dayWise = (card.dayWiseOfferInfo as Array<Record<string, unknown>>) ?? [];
    for (const day of dayWise) {
      // Section 1: platform-wide addon offers (bank/card coupons, cashback)
      const addOnOffers = (((day.addOnOffer as Record<string, unknown> | undefined)?.offers ?? []) as Array<Record<string, unknown>>);
      for (const o of addOnOffers) {
        const title = (o.title as string | undefined)?.trim();
        const desc = (o.description as string | undefined)?.trim();
        if (!title) continue;
        const isCashback = title.toLowerCase().includes("cashback");
        const headline = desc ? `${title} — ${desc}` : title;
        offers.push({
          offer_type: isCashback ? "addon_cashback" : "addon_coupon",
          booking_type: "walkin",
          headline,
          discount_pct: extractPct(title),
        });
      }

      // Section 2: restaurant-specific prebook offers from tabsOfferInfo
      const offersTab = (((day.tabsOfferInfo as Record<string, unknown> | undefined)?.offersTab ?? []) as Array<Record<string, unknown>>);
      for (const tab of offersTab) {
        const tabId = ((tab.tabInfo as Record<string, unknown> | undefined)?.id as string | undefined) ?? "";
        if (tabId !== "PREBOOK") continue;
        const tabOffers = (((tab.tabOffers as Record<string, unknown> | undefined)?.offers ?? []) as Array<Record<string, unknown>>);
        for (const o of tabOffers) {
          const title = ((o.title as string | undefined) ?? (o.textInfo as Record<string, unknown> | undefined)?.info as string | undefined)?.trim();
          if (!title) continue;
          offers.push({
            offer_type: "prebook_pct",
            booking_type: "prebook",
            headline: title,
            discount_pct: extractPct(title),
          });
        }
      }
    }
  }

  // Dedupe by headline (addOn offers are platform-wide and repeat; keep first occurrence)
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
