# Dining tab — data-source feasibility evaluation

**Date**: 2026-05-16
**Status**: Pre-build evaluation. Do NOT start implementation until KP picks a path from §5.

---

## 1. The question

Can the Dining tab fetch **restaurant listings + per-restaurant
discounts** from any of {Zomato, Swiggy/Dineout, EazyDiner} via an
**official API** or **open-source dataset**?

**TL;DR**: **No** — none of the three offers a public API, and there
is no open-source dataset that stays fresh. Every realistic path
involves either (a) scraping internal mobile/web APIs (brittle + ToS
risk), (b) a B2B partner deal (gated, slow), or (c) Google Places
(legit + paid + missing the discount data, which is the whole point).
We need to choose a tradeoff, not "find the API".

---

## 2. Platform-by-platform breakdown

### 2.1 Zomato

| Aspect | Status |
|---|---|
| Public REST API (`developers.zomato.com`) | **Discontinued in 2021.** New keys not issued; existing keys revoked. |
| Internal web/mobile API | Exists (`/webroutes/...`, app-side `/gw/...`). Returns JSON. Frequently re-shaped. |
| ToS | Explicitly prohibits scraping (Zomato §3, §7). Cease-and-desists have been sent in past. |
| Discount/offer data | "Zomato Pro" / "Gold" + bank-card offers are gated behind user auth + a valid Indian payment instrument. Not visible to anonymous clients. |
| Open-source datasets | A few Kaggle dumps (`zomato.csv`) from 2019–2020. **Stale**, missing current offers, useless for live data. |
| Realistic options | (a) Reverse-engineer the mobile API per-city (high maintenance), (b) skip Zomato. |

### 2.2 Swiggy / Dineout

| Aspect | Status |
|---|---|
| Public REST API | **Never existed.** No developer portal. |
| Internal API (`swiggy.com/dapi/...`, `dineout-api.swiggy.com`) | Heavily used by community scrapers (`swiggy-analytics`, `swiggy-tracker` on GitHub). Returns JSON. Aggressive bot protection (Akamai + Cloudflare) added in 2024. |
| ToS | Prohibits automated access. |
| Discount/offer data | Restaurant-level "flat 25% off" is visible to logged-out clients. Card-linked offers (HDFC, Axis Magnus) require a logged-in user with the card tokenised. |
| Open-source datasets | Same as Zomato — old Kaggle dumps, no current offers. |
| Realistic options | (a) Scrape the Dineout listing endpoint per city (best signal-to-noise of the three, since Swiggy ate Dineout in 2022 and consolidated everything), (b) skip. |

### 2.3 EazyDiner

| Aspect | Status |
|---|---|
| Public REST API | None. |
| Partner API | **Exists** — used by HDFC Diners Club, Axis Magnus, IndusInd, etc. to surface "EazyDiner Prime" discounts inside bank apps. Requires a signed B2B agreement. Not accessible to individuals. |
| Internal mobile API | Reverse-engineerable but small surface area, less community tooling than Swiggy/Zomato. |
| ToS | Standard "no automated access" boilerplate. |
| Discount/offer data | **This is the platform that matters most for CardIQ** — EazyDiner's whole value-prop is *card-linked* dining discounts (e.g. "25% off on HDFC Diners, 20% on Axis Magnus"), which maps 1:1 onto CardIQ's existing card registry. |
| Open-source datasets | None. |
| Realistic options | (a) B2B partnership (not realistic for a personal app), (b) scrape mobile API, (c) skip. |

---

## 3. Adjacent legitimate sources (no app-specific discounts, but solid for the "listings" half)

- **Google Places API (New)** — official, ~$17/1000 Nearby Search calls, includes rating/price-level/cuisine. **No dining discount data.**
- **Foursquare Places API** — free tier of 1000 calls/day, similar shape. **No discounts.**
- **OpenStreetMap / Overpass** — free, decent restaurant coverage in metros, no ratings or discounts.
- **Bank issuer pages** (HDFC SmartBuy, Axis Dining Delights, ICICI Culinary Treats) — published HTML lists of partner restaurants + discount %. Static-ish (refreshed monthly). **Most legitimately scrapable** of any source here, and aligns perfectly with CardIQ's "what does each card give me" thesis.

---

## 4. Honest assessment vs. CardIQ's architecture

CardIQ's superpower is that it **already knows which cards KP holds**
(`src/lib/cards/registry.ts`). The most CardIQ-native framing for a
Dining tab is not "show me Zomato listings" — it's **"given I'm
about to dine, which of my cards gives me the best offer at this
restaurant?"**. That reframing changes which data source matters:

| Framing | Best data source | Build complexity | Maintenance burden |
|---|---|---|---|
| "Show me listings + offers like the Zomato app does" | Scrape Swiggy Dineout + EazyDiner mobile APIs | High | High — bot-protection cat-and-mouse |
| **"Which of my cards wins at restaurant X?"** | **Issuer dining-program pages + EazyDiner public restaurant pages (HTML)** | **Medium** | **Low–medium — pages change ~quarterly** |
| "Notify me when there's a new offer at a place I've been" | Same as above + CardIQ's existing merchant history | Medium | Low |

The middle row is the one I'd defend in code review.

---

## 5. Recommendation — pick one before we code

**Option A — Card-first dining (recommended)**
Scrape the four issuer pages KP cares about (HDFC SmartBuy Dineout,
Axis Dining Delights, ICICI Culinary Treats, HSBC) nightly into a
`dining_offers` Supabase table. Build the tab as "search restaurant
→ rank by best card discount". No Zomato/Swiggy/EazyDiner dependency.
Legit, low maintenance, leverages CardIQ's unique data. ~1 week.

**Option B — Aggregator scrape (the original ask)**
Reverse-engineer Swiggy Dineout + EazyDiner mobile APIs. Cache per
city. Accept ToS risk and ~monthly breakage. ~2–3 weeks initial,
ongoing maintenance significant. No Zomato (too hostile + Dineout
data overlaps anyway).

**Option C — Hybrid**
Option A as the data backbone, Option B as a best-effort overlay
when scrapers happen to work. Falls back gracefully to A. Most code,
most upside. ~3 weeks.

**Option D — Defer / kill**
The honest "this isn't worth building right now" answer. If KP
mainly wants to *track* dining spend (already covered by SpendTab's
category breakdown), the Dining tab is a feature looking for a
problem.

---

## 6. What I'd need from KP to proceed

1. Pick A / B / C / D.
2. If A or C: confirm the four issuer pages are still the right
   list (HDFC SmartBuy, Axis Dining Delights, ICICI Culinary
   Treats, HSBC — anything else?).
3. If B or C: explicit acknowledgement of ToS risk and that
   scrapers will break and need fixing.
4. Cities in scope (Bangalore / Mumbai / Delhi NCR / all of India?).
   Listing data volume scales linearly with this.
