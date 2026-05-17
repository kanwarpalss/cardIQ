#!/usr/bin/env -S npx tsx
/**
 * dining-recon.ts — reconnaissance scraper for offer taxonomy analysis.
 *
 * Hits Zomato, Swiggy Dineout, and EazyDiner as a guest (no auth) for
 * a curated list of ~30 Bangalore restaurants. Dumps raw API responses
 * to recon/<platform>/<slug>.json and generates recon/SUMMARY.md so we
 * can identify the full offer-type taxonomy before writing production
 * scrapers.
 *
 * Usage:
 *   npm run dining:recon
 *   npm run dining:recon -- --platform zomato   # one platform only
 *   npm run dining:recon -- --slug toit          # one restaurant only
 *
 * Output:
 *   recon/zomato/<slug>.json
 *   recon/swiggy/<slug>.json
 *   recon/eazydiner/<slug>.json
 *   recon/SUMMARY.md
 */

import fs from "fs";
import path from "path";

// ── CLI args ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const platformFilter = args.includes("--platform") ? args[args.indexOf("--platform") + 1] : null;
const slugFilter = args.includes("--slug") ? args[args.indexOf("--slug") + 1] : null;

// ── Restaurant list ───────────────────────────────────────────────────
// Name + search hints per platform. We use the platform's own search
// API to find each restaurant, then fetch its detail page.

interface ReconRestaurant {
  slug: string;            // our internal key (used for filenames)
  name: string;            // display name
  area: string;            // Bangalore neighbourhood — helps disambiguate
  districtSlugs: string[]; // all District.in path segments for this brand; [] = not listed
  eazyDinerSlug?: string;  // eazydiner.com/bengaluru/{slug}; undefined = not listed
}

const RESTAURANTS: ReconRestaurant[] = [
  // Pubs / casual
  { slug: "toit",            name: "Toit Brewpub",         area: "Indiranagar",    districtSlugs: ["toit-indiranagar", "toit-mahadevapura-mahadevapura-bangalore"],          eazyDinerSlug: "toit-indiranagar-330151" },
  { slug: "permit-room",     name: "The Permit Room",       area: "Indiranagar",    districtSlugs: ["the-permit-room-indiranagar-bangalore"],                                      eazyDinerSlug: "the-permit-room-richmond-town-central-bengaluru-613800" },
  { slug: "communiti",       name: "Communiti",             area: "Indiranagar",    districtSlugs: ["communiti-brigade-road-bangalore"] },
  { slug: "foxtrot",         name: "Foxtrot",               area: "Koramangala",    districtSlugs: ["foxtrot-marathahalli-bangalore"],                                             eazyDinerSlug: "foxtrot-gastropub-marathahalli-east-bengaluru-652608" },
  { slug: "hoot",            name: "Hoot",                  area: "Koramangala",    districtSlugs: ["hoot-craftwork-2-0-1-sarjapur-road-bangalore"] },
  { slug: "byg-brewski",    name: "Byg Brewski",           area: "Hennur",         districtSlugs: ["byg-brewski-brewing-company-hennur-bangalore", "byg-brewski-brewing-company-sarjapur-road-bangalore", "byg-brewski-brewing-company-yeshwantpur-bangalore"],          eazyDinerSlug: "byg-brewski-brewing-company-hennur-north-bengaluru-656351" },
  // Fine dining
  { slug: "karavalli",       name: "Karavalli",             area: "Residency Road", districtSlugs: ["karavalli-the-gateway-hotel-residency-road"],                                eazyDinerSlug: "karavalli-the-gateway-hotel-residency-road-330289" },
  { slug: "olive-beach",     name: "Olive Beach",           area: "Sankey Road",    districtSlugs: ["olive-beach-richmond-road-bangalore"],                                       eazyDinerSlug: "olive-beach-richmond-road-330137" },
  { slug: "fatty-bao",       name: "The Fatty Bao",         area: "Indiranagar",    districtSlugs: ["the-fatty-bao-indiranagar-bangalore", "the-fatty-bao-lavelle-road-bangalore"], eazyDinerSlug: "the-fatty-bao-lavelle-road-central-bengaluru-682670" },
  { slug: "yauatcha",        name: "Yauatcha",              area: "UB City",        districtSlugs: ["yauatcha-mg-road", "yauatcha-patisserie-mg-road-bangalore"],               eazyDinerSlug: "yauatcha-1-mg-road-mall-mg-road-330178" },
  { slug: "shiro",           name: "Shiro",                 area: "UB City",        districtSlugs: ["shiro-lavelle-road"],                                                        eazyDinerSlug: "shiro-ub-city-330141" },
  // Indian
  { slug: "truffles",        name: "Truffles",              area: "Koramangala",    districtSlugs: ["truffles-1-jp-nagar-bangalore", "truffles-2-st-marks-road", "truffles-indiranagar", "truffles-jakkur-bangalore", "truffles-kalyan-nagar", "truffles-koramangala-1st-block-bangalore", "truffles-koramangala-5th-block", "truffles-new-bel-road", "truffles-st-marks-road"], eazyDinerSlug: "truffles-st-marks-road-334765" },
  { slug: "meghana-foods",   name: "Meghana Foods",         area: "Koramangala",    districtSlugs: ["meghana-foods-banashankari-bangalore", "meghana-foods-hosur-road-bangalore", "meghana-foods-indiranagar", "meghana-foods-jayanagar", "meghana-foods-koramangala-5th-block", "meghana-foods-marathahalli-bangalore", "meghana-foods-residency-road", "meghana-foods-sarjapur-road-bangalore", "meghana-foods-whitefield-bangalore"], eazyDinerSlug: "meghana-foods-residency-road-334874" },
  { slug: "mtr",             name: "MTR",                   area: "Lalbagh",        districtSlugs: ["mavalli-tiffin-room-mtr-basavanagudi-bangalore", "mavalli-tiffin-room-mtr-jakkur-bangalore", "mtr-since-1924-1-kalyan-nagar-bangalore", "mtr-since-1924-hsr-bangalore", "mtr-since-1924-indiranagar-bangalore", "mtr-since-1924-jp-nagar-bangalore", "mtr-since-1924-kalyan-nagar-bangalore", "mtr-since-1924-kanakapura-road-bangalore", "mtr-since-1924-majestic-bangalore", "mtr-since-1924-st-marks-road-bangalore"], eazyDinerSlug: "mtr-1924-st-marks-road-334798" },
  { slug: "nagarjuna",       name: "Nagarjuna",             area: "Residency Road", districtSlugs: ["nagarjuna-since-1984-btm-bangalore", "nagarjuna-since-1984-indiranagar-bangalore", "nagarjuna-since-1984-koramangala-5th-block-bangalore", "nagarjuna-since-1984-marathahalli-bangalore", "nagarjuna-since-1984-residency-road-bangalore", "nagarjuna-since-1984-sarjapur-road-bangalore", "nagarjuna-since-1984-whitefield-bangalore"], eazyDinerSlug: "nagarjuna-residency-road-334689" },
  // International
  { slug: "farzi-cafe",      name: "Farzi Cafe",            area: "UB City",        districtSlugs: ["farzi-cafe-lavelle-road"],                                                   eazyDinerSlug: "farzi-cafe-vittal-mallya-road-337292" },
  { slug: "misu",            name: "Misu",                  area: "Indiranagar",    districtSlugs: ["misu-1-race-course-road-bangalore", "misu-ashok-nagar-bangalore", "misu-hebbal-bangalore", "misu-indiranagar-bangalore", "misu-kumaraswamy-layout-bangalore"] },
  { slug: "indigo-deli",     name: "Indigo Deli",           area: "Koramangala",    districtSlugs: [] },
  { slug: "black-pearl",     name: "The Black Pearl",       area: "Indiranagar",    districtSlugs: ["the-black-pearl-1-rajajinagar-bangalore", "the-black-pearl-indiranagar-bangalore", "the-black-pearl-kadubeesanahalli-bangalore"] },
  // Cafes
  { slug: "third-wave",      name: "Third Wave Coffee",     area: "Indiranagar",    districtSlugs: ["third-wave-coffee-1-bellandur-bangalore", "third-wave-coffee-1-brigade-road-bangalore", "third-wave-coffee-1-btm-bangalore", "third-wave-coffee-1-devanahalli", "third-wave-coffee-1-hebbal-bangalore", "third-wave-coffee-1-hsr-bangalore", "third-wave-coffee-1-indiranagar-bangalore", "third-wave-coffee-1-jp-nagar-bangalore", "third-wave-coffee-1-lavelle-road-bangalore", "third-wave-coffee-1-varthur-main-road-whitefield-bangalore", "third-wave-coffee-2-bellandur-bangalore", "third-wave-coffee-2-btm-bangalore", "third-wave-coffee-2-varthur-main-road-whitefield-bangalore", "third-wave-coffee-3-hsr-bangalore", "third-wave-coffee-3-varthur-main-road-whitefield-bangalore", "third-wave-coffee-5-bellandur-bangalore", "third-wave-coffee-anekal-bangalore", "third-wave-coffee-arekere-bangalore", "third-wave-coffee-banashankari-bangalore", "third-wave-coffee-basaveshwara-nagar-bangalore", "third-wave-coffee-bellandur-bangalore", "third-wave-coffee-bommanahalli-bangalore", "third-wave-coffee-brigade-road-bangalore", "third-wave-coffee-brookefield-bangalore", "third-wave-coffee-choodasandra-bangalore", "third-wave-coffee-church-street-bangalore", "third-wave-coffee-cunningham-road-bangalore", "third-wave-coffee-devanahalli", "third-wave-coffee-frazer-town-bangalore", "third-wave-coffee-hebbal-bangalore", "third-wave-coffee-hsr-bangalore", "third-wave-coffee-indiranagar-bangalore", "third-wave-coffee-itpl-main-road-whitefield-bangalore", "third-wave-coffee-jayanagar-bangalore", "third-wave-coffee-jp-nagar-bangalore", "third-wave-coffee-kadubeesanahalli-bangalore", "third-wave-coffee-kalyan-nagar-bangalore", "third-wave-coffee-kanakapura-road-bangalore", "third-wave-coffee-koramangala-4th-block-bangalore", "third-wave-coffee-koramangala-8th-block-bangalore", "third-wave-coffee-lavelle-road-bangalore", "third-wave-coffee-malleshwaram-bangalore", "third-wave-coffee-marathahalli-bangalore", "third-wave-coffee-nagawara-bangalore", "third-wave-coffee-rajajinagar-bangalore", "third-wave-coffee-sadashiv-nagar-bangalore", "third-wave-coffee-sanjay-nagar-bangalore", "third-wave-coffee-sarjapur-road-bangalore", "third-wave-coffee-varthur-main-road-whitefield-bangalore", "third-wave-coffee-vijay-nagar-bangalore", "third-wave-coffee-whitefield-bangalore"], eazyDinerSlug: "third-wave-coffee-roasters-koramangala-south-bengaluru-640094" },
  { slug: "blue-tokai",      name: "Blue Tokai Coffee",     area: "Indiranagar",    districtSlugs: ["blue-tokai-coffee-roasters-1-hsr-bangalore", "blue-tokai-coffee-roasters-2-hsr-bangalore", "blue-tokai-coffee-roasters-aecs-layout-bangalore", "blue-tokai-coffee-roasters-bellandur-bangalore", "blue-tokai-coffee-roasters-domlur-bangalore", "blue-tokai-coffee-roasters-electronic-city-bangalore", "blue-tokai-coffee-roasters-infantry-road-bangalore", "blue-tokai-coffee-roasters-itpl-main-road-whitefield-bangalore", "blue-tokai-coffee-roasters-jayanagar-bangalore", "blue-tokai-coffee-roasters-jp-nagar-bangalore", "blue-tokai-coffee-roasters-kalyan-nagar-bangalore", "blue-tokai-coffee-roasters-kanakapura-road-bangalore", "blue-tokai-coffee-roasters-koramangala-5th-block-bangalore", "blue-tokai-coffee-roasters-koramangala-8th-block-bangalore", "blue-tokai-coffee-roasters-kr-puram-bangalore", "blue-tokai-coffee-roasters-lavelle-road-bangalore", "blue-tokai-coffee-roasters-mahadevapura-bangalore", "blue-tokai-coffee-roasters-malleshwaram-bangalore", "blue-tokai-coffee-roasters-marathahalli-bangalore", "blue-tokai-coffee-roasters-rajarajeshwari-nagar-bangalore", "blue-tokai-coffee-roasters-sadashiv-nagar-bangalore", "blue-tokai-coffee-roasters-sahakara-nagar-bangalore", "blue-tokai-coffee-roasters-whitefield-bangalore", "blue-tokai-coffee-roasters-yeshwantpur-bangalore"], eazyDinerSlug: "blue-tokai-infantry-road-central-bengaluru-683567" },
  { slug: "glens-bakehouse", name: "Glen's Bakehouse",      area: "Koramangala",    districtSlugs: ["glen-s-bakehouse-bannerghatta-road-bangalore", "glen-s-bakehouse-hsr-bangalore", "glen-s-bakehouse-kalyan-nagar-bangalore", "glen-s-bakehouse-koramangala-6th-block-bangalore", "glen-s-bakehouse-lavelle-road-bangalore", "glen-s-bakehouse-sahakara-nagar-bangalore", "glen-s-bakehouse-sanjay-nagar-bangalore", "glen-s-bakehouse-whitefield-bangalore", "glens-bakehouse-1-jayanagar-bangalore", "glens-bakehouse-1-rajarajeshwari-nagar-bangalore", "glens-bakehouse-basaveshwara-nagar-bangalore", "glens-bakehouse-hennur-hennur-bangalore", "glens-bakehouse-indiranagar-bangalore", "glens-bakehouse-sarjapur-road-bangalore"], eazyDinerSlug: "glens-bakehouse-indiranagar-331919" },
  // Buffet / casual chains
  { slug: "barbeque-nation", name: "Barbeque Nation",       area: "Indiranagar",    districtSlugs: ["barbeque-nation-1-electronic-city-bangalore", "barbeque-nation-1-itpl-main-road-whitefield-bangalore", "barbeque-nation-1-marathahalli-bangalore", "barbeque-nation-1-whitefield-bangalore", "barbeque-nation-3-rajarajeshwari-nagar-bangalore", "barbeque-nation-5-rajarajeshwari-nagar-bangalore", "barbeque-nation-brigade-road-bangalore", "barbeque-nation-electronic-city", "barbeque-nation-hebbal-bangalore", "barbeque-nation-indiranagar", "barbeque-nation-itpl-main-road-whitefield-bangalore", "barbeque-nation-jakkur-bangalore", "barbeque-nation-jp-nagar", "barbeque-nation-kalyan-nagar", "barbeque-nation-kanakapura-road-bangalore", "barbeque-nation-koramangala-1st-block", "barbeque-nation-kr-puram-bangalore", "barbeque-nation-majestic-bangalore", "barbeque-nation-rajajinagar", "barbeque-nation-sarjapur-road-bangalore", "barbeque-nation-yelahanka", "barbeque-nation-yeshwantpur-bangalore"], eazyDinerSlug: "barbeque-nation-ascendas-park-square-whitefield-335312" },
  { slug: "absolute-barbecues", name: "Absolute Barbecues", area: "Koramangala",    districtSlugs: ["abs-absolute-barbecues-btm", "abs-absolute-barbecues-electronic-city-bangalore", "abs-absolute-barbecues-kalyan-nagar-bangalore", "abs-absolute-barbecues-koramangala-5th-block-bangalore", "abs-absolute-barbecues-marathahalli", "abs-absolute-barbecues-whitefield", "abs-absolute-barbecues-yelahanka-bangalore", "abs-absolute-barbecues-yeshwantpur-bangalore"], eazyDinerSlug: "abs-absolute-barbecues-whitefield-east-bengaluru-662250" },
  { slug: "onesta",          name: "Onesta",                area: "Koramangala",    districtSlugs: ["onesta-1-bommanahalli-bangalore", "onesta-1-electronic-city-bangalore", "onesta-1-mahadevapura-bangalore", "onesta-1-marathahalli-bangalore", "onesta-2-electronic-city-bangalore", "onesta-aecs-layout-bangalore", "onesta-bannerghatta-road-bangalore", "onesta-basaveshwara-nagar-bangalore", "onesta-hebbal-bangalore", "onesta-hsr", "onesta-indiranagar-bangalore", "onesta-jp-nagar", "onesta-kammanahalli", "onesta-kanakapura-road-bangalore", "onesta-koramangala-4th-block-bangalore", "onesta-koramangala-5th-block-bangalore", "onesta-mahadevapura-bangalore", "onesta-new-bel-road", "onesta-rajarajeshwari-nagar", "onesta-yelahanka"] },
  // Wildcard — budget / hyped / chain
  { slug: "vidyarthi-bhavan",name: "Vidyarthi Bhavan",      area: "Gandhi Bazaar",  districtSlugs: ["vidyarthi-bhavan-since-1943-basavanagudi-bangalore"] },
  { slug: "smoke-house-deli",name: "Smoke House Deli",      area: "Indiranagar",    districtSlugs: ["smoke-house-deli-indiranagar-bangalore", "smoke-house-deli-lavelle-road", "smoke-house-deli-whitefield-bangalore", "the-drawing-room-by-smoke-house-deli-indiranagar-bangalore"], eazyDinerSlug: "smoke-house-deli-lavelle-road-335752" },
  { slug: "asia-kitchen",    name: "Asia Kitchen",          area: "Indiranagar",    districtSlugs: [] },
  { slug: "flechazo",        name: "Flechazo",              area: "Indiranagar",    districtSlugs: ["flechazo-1-marathahalli-bangalore", "flechazo-gold-whitefield-bangalore", "flechazo-whitefield-bangalore"] },
  { slug: "tiger-trail",     name: "Tiger Trail",           area: "Jayamahal",      districtSlugs: ["tiger-trail-regenta-place-shivajinagar-bangalore", "tiger-trail-royal-orchid-hotel-airport-road-bangalore"], eazyDinerSlug: "tiger-trail-ramada-bangalore-shivajinagar-330037" },
];

// ── Platform scrapers ─────────────────────────────────────────────────

// "district" = District.in (Zomato's dining platform) — replaces Zomato direct scraping.
// Zomato's API has bot-detection that returns empty results; District.in does not.
type Platform = "district" | "swiggy" | "eazydiner";

interface ReconResult {
  restaurant: ReconRestaurant;
  platform: Platform;
  found: boolean;
  raw: unknown;
  offerSummary: string[];  // human-readable bullet per offer observed
  error?: string;
}

// Shared polite fetch — jitter + basic headers, no auth.
async function guestFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const jitter = 800 + Math.random() * 1200; // 0.8–2s
  await new Promise((r) => setTimeout(r, jitter));
  return fetch(url, {
    ...options,
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-IN,en;q=0.9",
      ...(options.headers ?? {}),
    },
  });
}

// ── District.in ──────────────────────────────────────────────────────
// District.in is Zomato's dining platform. It serves Zomato offer data
// (pre-booking discounts, bank offers) without the bot-detection that
// blocks direct Zomato API calls.
//
// Data comes from the Next.js RSC payload of each restaurant page — no
// separate search API needed. Slugs are pre-mapped from District's sitemap.

async function reconDistrict(r: ReconRestaurant): Promise<ReconResult> {
  const base: ReconResult = { restaurant: r, platform: "district", found: false, raw: null, offerSummary: [] };

  if (r.districtSlugs.length === 0) {
    return { ...base, error: "not in District.in sitemap" };
  }

  // Fetch every location and union the offers across all of them.
  const allOffers = new Set<string>();
  const locationResults: Array<{ slug: string; offerCount: number }> = [];
  let anyFound = false;

  for (const districtSlug of r.districtSlugs) {
    try {
      const res = await guestFetch(
        `https://www.district.in/dining/bangalore/${districtSlug}?_rsc=1`,
        { headers: { "Accept": "text/x-component", "RSC": "1", "Referer": "https://www.district.in/dining/bangalore" } },
      );
      if (!res.ok) { locationResults.push({ slug: districtSlug, offerCount: -1 }); continue; }

      const rscText = await res.text();
      if (rscText.toLowerCase().includes(r.name.split(" ")[0].toLowerCase())) anyFound = true;

      const offers = extractDistrictOffers(rscText);
      offers.forEach((o) => allOffers.add(o));
      locationResults.push({ slug: districtSlug, offerCount: offers.length });
    } catch {
      locationResults.push({ slug: districtSlug, offerCount: -1 });
    }
  }

  return {
    ...base,
    found: anyFound || allOffers.size > 0,
    raw: { locations: locationResults },
    offerSummary: [...allOffers],
  };
}

function extractDistrictOffers(rscText: string): string[] {
  const offers: string[] = [];

  // District embeds offers in the OFFERS_SECTION of mainSections.
  // Shape: { allOffers: [{offerTitle, title, subTitle}], bankOffers: [{title, subTitle}] }
  // We extract each array by finding its key then walking to the balanced closing ].

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
      const clean = m[1].replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
      if (clean) offers.push(`[prebook] ${clean}`);
    }
  }

  const bankOffersArr = extractArray("bankOffers");
  if (bankOffersArr) {
    const skipLabels = new Set(["Offers", "Menu", "Reviews", "About", "Location"]);
    for (const m of [...bankOffersArr.matchAll(/"title":"([^"]+)"/g)].slice(0, 12)) {
      const clean = m[1].trim();
      if (clean.length > 4 && clean.length < 120 && !skipLabels.has(clean)) {
        offers.push(`[bank] ${clean}`);
      }
    }
  }

  return [...new Set(offers)];
}

// ── Swiggy ───────────────────────────────────────────────────────────
// Swiggy Dineout's internal restaurant search.

async function reconSwiggy(r: ReconRestaurant): Promise<ReconResult> {
  const base: ReconResult = { restaurant: r, platform: "swiggy", found: false, raw: null, offerSummary: [] };
  try {
    // Swiggy Dineout search
    const searchUrl = `https://www.swiggy.com/dapi/restaurants/search/v3?lat=12.9716&lng=77.5946&str=${encodeURIComponent(r.name)}&trackingId=undefined&submitAction=ENTER&queryUniqueId=undefined`;
    const searchRes = await guestFetch(searchUrl, {
      headers: {
        "Referer": "https://www.swiggy.com/dineout",
        "Content-Type": "application/json",
      },
    });

    if (!searchRes.ok) {
      // Try dineout-specific search endpoint
      const dineoutSearchUrl = `https://www.swiggy.com/dapi/dineout/search?lat=12.9716&lng=77.5946&query=${encodeURIComponent(r.name)}`;
      const fallbackRes = await guestFetch(dineoutSearchUrl, {
        headers: { "Referer": "https://www.swiggy.com/dineout" },
      });
      if (!fallbackRes.ok) {
        return { ...base, error: `Search HTTP ${searchRes.status} / fallback ${fallbackRes.status}` };
      }
      const fallback = await fallbackRes.json();
      return { ...base, found: true, raw: fallback, offerSummary: extractSwiggyOffers(fallback) };
    }

    const searchBody = await searchRes.json();
    const offers = extractSwiggyOffers(searchBody);

    return { ...base, found: true, raw: searchBody, offerSummary: offers };
  } catch (e) {
    return { ...base, error: String(e) };
  }
}

function extractSwiggyOffers(body: unknown): string[] {
  const offers: string[] = [];
  if (typeof body !== "object" || body === null) return offers;
  const str = JSON.stringify(body);

  // Pull any strings that look like discount offers.
  const discountMatches = str.match(/"[^"]*(?:off|discount|prebook|pre-book|walk.?in|flat|upto|up to)[^"]*"/gi) ?? [];
  for (const m of discountMatches.slice(0, 20)) {
    const clean = m.replace(/^"|"$/g, "").trim();
    if (clean.length > 4 && clean.length < 120) {
      offers.push(clean);
    }
  }
  return [...new Set(offers)];
}

// ── EazyDiner ────────────────────────────────────────────────────────
// EazyDiner's internal API: force.eazydiner.com/web/restaurants/bengaluru/{slug}
// Returns JSON with deal_data, eazypay_details, and sample_discount_calculator.
// Slugs are pre-mapped from EazyDiner's Bengaluru sitemap (details pages 1–22).
// No auth needed — guest access confirmed 2026-05-17.

async function reconEazyDiner(r: ReconRestaurant): Promise<ReconResult> {
  const base: ReconResult = { restaurant: r, platform: "eazydiner", found: false, raw: null, offerSummary: [] };

  if (!r.eazyDinerSlug) {
    return { ...base, error: "not in EazyDiner sitemap — slug not mapped" };
  }

  try {
    const apiUrl = `https://force.eazydiner.com/web/restaurants/bengaluru/${r.eazyDinerSlug}`;
    const res = await guestFetch(apiUrl, {
      headers: {
        "Accept": "application/json",
        "Referer": `https://www.eazydiner.com/bengaluru/${r.eazyDinerSlug}`,
        "Origin": "https://www.eazydiner.com",
      },
    });

    if (!res.ok) {
      return { ...base, error: `HTTP ${res.status}` };
    }

    const body = await res.json() as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;
    const offers = extractEazyDinerOffers(data);
    const found = typeof data.name === "string" && data.name.length > 0;
    return { ...base, found, raw: body, offerSummary: offers };
  } catch (e) {
    return { ...base, error: String(e) };
  }
}

function extractEazyDinerOffers(data: Record<string, unknown>): string[] {
  const offers: string[] = [];

  // 1. Headline deal (shown on listing cards) — from deal_data.title
  const dealData = data.deal_data as Record<string, unknown> | undefined;
  if (typeof dealData?.title === "string" && dealData.title !== "More Deals") {
    offers.push(`[deal] ${dealData.title}`);
  }

  // 2. PayEazy in-app payment offer — from eazypay_details.text
  const eazy = data.eazypay_details as Record<string, unknown> | undefined;
  if (typeof eazy?.text === "string") {
    offers.push(`[payeazy] ${eazy.text}`);
  }

  // 3. Sample discount figures — concrete ₹ amounts from sample_discount_calculator
  const calc = data.sample_discount_calculator as Record<string, unknown> | undefined;
  if (calc) {
    const restOff = calc.restaurant_offer as number | undefined;
    const payOff = calc.payment_offer as number | undefined;
    const bill = calc.total_bill as number | undefined;
    if (restOff && restOff > 0) offers.push(`[discount] ₹${restOff} off on ₹${bill} bill (restaurant offer)`);
    if (payOff && payOff > 0) offers.push(`[discount] ₹${payOff} off on ₹${bill} bill (PayEazy)`);
  }

  // 4. Buffet deals if present
  const buffet = data.buffet_deals;
  if (Array.isArray(buffet) && buffet.length > 0) {
    offers.push(`[buffet] ${buffet.length} buffet deal(s) available`);
  }

  return [...new Set(offers)];
}

// ── Output helpers ────────────────────────────────────────────────────

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeResult(result: ReconResult) {
  const dir = path.join("recon", result.platform);
  ensureDir(dir);
  const file = path.join(dir, `${result.restaurant.slug}.json`);
  fs.writeFileSync(file, JSON.stringify({ meta: { restaurant: result.restaurant, found: result.found, error: result.error, offerSummary: result.offerSummary }, raw: result.raw }, null, 2));
  console.log(`  ${result.found ? "✓" : "✗"} ${result.restaurant.slug} → ${file}${result.error ? ` (${result.error})` : ""}`);
}

function writeSummary(results: ReconResult[]) {
  const platforms: Platform[] = ["district", "swiggy", "eazydiner"];
  const lines: string[] = [
    "# Dining Recon — Offer Summary",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Restaurants: ${RESTAURANTS.length} | Platforms: ${platforms.length}`,
    "",
  ];

  for (const platform of platforms) {
    const pr = results.filter((r) => r.platform === platform);
    const found = pr.filter((r) => r.found);
    const withOffers = pr.filter((r) => r.offerSummary.length > 0);
    lines.push(`## ${platform.toUpperCase()}`);
    lines.push(`Found: ${found.length}/${pr.length} | With offer data: ${withOffers.length}`);
    lines.push("");

    for (const r of pr) {
      lines.push(`### ${r.restaurant.name} (${r.restaurant.area})`);
      if (r.error) {
        lines.push(`> ❌ ${r.error}`);
      } else if (r.offerSummary.length === 0) {
        lines.push("> (found, no offers extracted)");
      } else {
        for (const o of r.offerSummary) {
          lines.push(`- ${o}`);
        }
      }
      lines.push("");
    }
  }

  // Cross-platform offer keyword frequency
  lines.push("## Offer keyword frequency (all platforms)");
  const allOfferText = results.flatMap((r) => r.offerSummary).join(" ").toLowerCase();
  const keywords = ["prebook", "pre-book", "walk-in", "walk in", "walkin", "flat", "off", "bogo", "1+1", "prime", "gold", "pro", "instant", "buffet", "cocktail", "bank"];
  for (const kw of keywords) {
    const count = (allOfferText.match(new RegExp(kw, "g")) ?? []).length;
    if (count > 0) lines.push(`- \`${kw}\`: ${count} mentions`);
  }

  const summaryPath = path.join("recon", "SUMMARY.md");
  ensureDir("recon");
  fs.writeFileSync(summaryPath, lines.join("\n"));
  console.log(`\n📄 Summary written to ${summaryPath}`);
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const restaurants = slugFilter
    ? RESTAURANTS.filter((r) => r.slug === slugFilter)
    : RESTAURANTS;

  const platforms: Platform[] = platformFilter
    ? [platformFilter as Platform]
    : ["district", "swiggy", "eazydiner"];

  if (restaurants.length === 0) {
    console.error(`No restaurant matching slug "${slugFilter}"`);
    process.exit(1);
  }

  console.log(`\n🍽  Dining recon — ${restaurants.length} restaurants × ${platforms.length} platforms`);
  console.log(`   Output: recon/<platform>/<slug>.json + recon/SUMMARY.md\n`);

  const results: ReconResult[] = [];

  for (const platform of platforms) {
    console.log(`\n── ${platform.toUpperCase()} ──`);
    for (const restaurant of restaurants) {
      let result: ReconResult;
      if (platform === "district") result = await reconDistrict(restaurant);
      else if (platform === "swiggy") result = await reconSwiggy(restaurant);
      else result = await reconEazyDiner(restaurant);
      writeResult(result);
      results.push(result);
    }
  }

  writeSummary(results);

  const found = results.filter((r) => r.found).length;
  const total = results.length;
  console.log(`\n✅ Done — ${found}/${total} successful. Review recon/SUMMARY.md for offer taxonomy.`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
