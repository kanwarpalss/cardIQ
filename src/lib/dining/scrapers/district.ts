import { diningFetchWithBackoff } from "../http";
import type { ScrapedOffer } from "../types";

const SKIP_BANK_LABELS = new Set(["Offers", "Menu", "Reviews", "About", "Location"]);

/**
 * Scrape District.in (Zomato's dining platform) for one restaurant.
 *
 * Fetches the Next.js RSC payload for each districtSlug, unions offers
 * across all locations, and returns typed ScrapedOffer[].
 *
 * allOffers → prebook_pct / prebook_item
 * bankOffers → bank_card
 */
export async function scrapeDistrict(
  districtSlugs: string[],
): Promise<ScrapedOffer[]> {
  if (districtSlugs.length === 0) return [];

  const seen = new Set<string>();
  const offers: ScrapedOffer[] = [];

  for (const slug of districtSlugs) {
    const url = `https://www.district.in/dining/bangalore/${slug}?_rsc=1`;
    const res = await diningFetchWithBackoff(url, {
      headers: {
        Accept: "text/x-component",
        RSC: "1",
        Referer: "https://www.district.in/dining/bangalore",
      },
    });
    if (res.kind !== "ok") continue;

    for (const o of parseDistrictRsc(res.body)) {
      const key = `${o.offer_type}::${o.headline}`;
      if (!seen.has(key)) {
        seen.add(key);
        offers.push(o);
      }
    }
  }

  return offers;
}

function parseDistrictRsc(rscText: string): ScrapedOffer[] {
  const offers: ScrapedOffer[] = [];

  function extractArray(key: string): string {
    const marker = `"${key}":[`;
    const start = rscText.indexOf(marker);
    if (start === -1) return "";
    let depth = 0, inStr = false, i = start + marker.length - 1;
    while (i < rscText.length) {
      const c = rscText[i];
      if (c === '"' && rscText[i - 1] !== "\\") inStr = !inStr;
      if (!inStr) {
        if (c === "[") depth++;
        else if (c === "]") { depth--; if (depth === 0) return rscText.slice(start + marker.length - 1, i + 1); }
      }
      i++;
    }
    return "";
  }

  const allOffersArr = extractArray("allOffers");
  if (allOffersArr) {
    for (const m of allOffersArr.matchAll(/"offerTitle":"([^"]+)"/g)) {
      const headline = m[1].replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
      if (!headline) continue;
      const isPct = /\d+%/.test(headline);
      offers.push({
        offer_type: isPct ? "prebook_pct" : "prebook_item",
        booking_type: "prebook",
        headline,
        discount_pct: extractPct(headline),
      });
    }
  }

  const bankOffersArr = extractArray("bankOffers");
  if (bankOffersArr) {
    for (const m of [...bankOffersArr.matchAll(/"title":"([^"]+)"/g)].slice(0, 30)) {
      const headline = m[1].trim();
      if (headline.length < 5 || headline.length > 120) continue;
      if (SKIP_BANK_LABELS.has(headline)) continue;
      offers.push({
        offer_type: "bank_card",
        booking_type: "walkin",
        headline,
        discount_pct: extractPct(headline),
      });
    }
  }

  return offers;
}

function extractPct(text: string): number | undefined {
  const m = text.match(/(\d+)%/);
  return m ? parseInt(m[1], 10) : undefined;
}
