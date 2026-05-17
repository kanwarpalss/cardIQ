# Dining Offer Taxonomy

> Derived from: recon of 30 Bangalore restaurants × 3 platforms (2026-05-17)
> Gates: Migration 012, all three production scrapers
> Status: **LOCKED** — do not build scrapers until this doc is agreed

---

## 1. What we observed

### District (Zomato's dine-out platform)

Data source: `https://www.district.in/dining/bangalore/{slug}?_rsc=1` (Next.js RSC payload)

| Label | Seen on | Description | Example |
|---|---|---|---|
| `[prebook]` | 7 restaurants | Restaurant's own pre-booking discount — pre-pay to reserve, receive X% off or a complimentary item | "FLAT 30% OFF", "FLAT 20% OFF", "FLAT 10% OFF", "Get Chocolate Pebble" |
| `[bank]` | 15 restaurants | Card/bank payment discount — applies at billing time with qualifying card. 20–30 variants per restaurant | "Flat ₹150 OFF using Google Pay", "25% OFF up to ₹5000 using RBL Bank LUMIÈRE Credit Card" |

**Coverage:** 28/30 found; 2 not in District sitemap.

**Key observation:** `[bank]` offers are extremely noisy — every restaurant shows the same 20+ platform-wide bank partnerships. These are not restaurant-specific. `[prebook]` is the only offer that varies meaningfully per restaurant.

---

### Swiggy Dineout

Data source: `disc.swiggy.com/api/v1/dinersone-restaurant/json?restaurantId={id}` (Spring Boot, requires `latitude`/`longitude` request headers)

| Label | Seen on | Description | Example |
|---|---|---|---|
| `[addon]` | 11 restaurants | Platform-wide bank/payment coupon codes. The **same 9 offers** appear on every participating restaurant — these are Swiggy platform deals, not restaurant-specific | "Flat 10% off* — use HDFCINFINIA", "Cashback 10%* — Swiggy HDFC Bank Credit Card" |

**The 9 platform-wide addon offers (as of 2026-05-17):**

| Offer | Coupon | Type |
|---|---|---|
| Flat 10% off (max ₹500) | HDFCINFINIA | HDFC Infinia CC, min ₹3500 bill |
| Flat 10% off (max ₹500) | HDFCCCEMI | HDFC CC EMI, min ₹3500 bill |
| Flat 10% off (max ₹400) | HDFCDINERS | HDFC Diners CC |
| Flat ₹200 off | HDFCCARDS | All HDFC cards |
| Cashback ₹50 | MBKDINEUPI | MobiKwik UPI, min ₹1500 |
| Cashback ₹50 | MBKDINE | MobiKwik Wallet, min ₹1500 |
| Cashback ₹50 | POPUPI | POP UPI, min ₹999 |
| Cashback 10%* (max ₹1500/mo) | — | Swiggy HDFC Bank Credit Card |
| Cashback 5%* (max ₹1500/mo) | — | Swiggy Ornge HDFC Bank Credit Card |

**Coverage:** 29/30 found (Indigo Deli absent). 11/29 have addon offers; 18 are on the platform but have no deals attached.

**Key observation:** No restaurant-specific pre-booking or walk-in percentage discounts surfaced in the API. Swiggy Dineout's value proposition for this data set is entirely payment/loyalty card offers.

---

### EazyDiner

Data source: `force.eazydiner.com/web/restaurants/bengaluru/{slug}` (JSON API, no auth)

| Label | Seen on | Description | Example |
|---|---|---|---|
| `[payeazy]` | 7 restaurants | In-app PayEazy payment discount — always "Pay now & get EXTRA 25% OFF upto ₹1000". Pay bill via EazyDiner app at restaurant to redeem | "Pay now & get EXTRA 25% OFF upto ₹1000" |
| `[discount] restaurant offer` | 3 restaurants | Restaurant's own EazyDiner discount, from `sample_discount_calculator.restaurant_offer` — ₹ amount off on a given bill size | "₹250 off on ₹2500 bill" |
| `[discount] PayEazy` | 7 restaurants | PayEazy payment additional discount, from `sample_discount_calculator.payment_offer` | "₹562 off on ₹2500 bill" |
| `[buffet]` | 4 restaurants | Buffet packages available. Count only in recon; full detail in `buffet_deals[]` array (meal/type/price/time/days) | "28 buffet deal(s) available" |

**Coverage:** 21/30 found (9 not in EazyDiner sitemap).

---

## 2. Canonical offer_type enum

These are the values for the `offer_type` column in `dining_offers`:

| offer_type | Platform(s) | What it means |
|---|---|---|
| `prebook_pct` | District, Swiggy | Pre-booking %-off discount (e.g. "FLAT 30% OFF", "Flat 20% off on Total Bill"). In District: from `allOffers[]`. In Swiggy: from `tabsOfferInfo.offersTab[].tabOffers.offers[]` where type is `Pre-Book` or `RESERVATION` |
| `prebook_item` | District | Pre-booking complimentary item (e.g. "Get Chocolate Pebble") |
| `bank_card` | District | Bank/card payment discount — flat ₹ or % off with qualifying card |
| `addon_coupon` | Swiggy | Platform-wide coupon code offer (HDFC, MobiKwik, POP UPI) |
| `addon_cashback` | Swiggy | Platform loyalty cashback (Swiggy HDFC Card, Swiggy Ornge Card) |
| `payeazy` | EazyDiner | In-app PayEazy payment discount |
| `restaurant_discount` | EazyDiner | Restaurant's own %-off or ₹-off when booking through EazyDiner |
| `buffet` | EazyDiner | Buffet package (advance booking) |

---

## 3. booking_type enum

Whether the offer requires advance booking/pre-payment or is available walk-in:

| booking_type | Meaning | Offer types that use it |
|---|---|---|
| `prebook` | Must book/pre-pay in advance to redeem | `prebook_pct`, `prebook_item`, `restaurant_discount`, `buffet` |
| `walkin` | Available at the time of dining — no advance booking required | `bank_card`, `addon_coupon`, `addon_cashback`, `payeazy` |
| `either` | Applies regardless of booking method | (reserved for future; not seen in recon) |

---

## 4. DB schema changes — Migration 012

Add two columns to `dining_offers`:

```sql
ALTER TABLE dining_offers
  ADD COLUMN IF NOT EXISTS offer_type  TEXT,
  ADD COLUMN IF NOT EXISTS booking_type TEXT CHECK (booking_type IN ('prebook', 'walkin', 'either'));
```

No enum type — plain TEXT with a check constraint. Easier to add values later without a migration.

For `offer_type`, no constraint — platform-specific values evolve; keep it open.

---

## 5. Scraper parsing rules (per platform)

### District scraper

```
allOffers[].offerTitle   → offer_type = prebook_pct (if contains %) or prebook_item (otherwise)
                           booking_type = prebook
                           headline = offerTitle text

bankOffers[].title       → offer_type = bank_card
                           booking_type = walkin
                           headline = title text
                           terms = subTitle text (card name / conditions)
```

Discard: `bankOffers` entries with `title` in skip list ("Offers", "Menu", "Reviews", "About", "Location") or length < 5 or > 120.

### Swiggy Dineout scraper

Parse TWO sections per restaurant (both present on 5 of 29 restaurants in recon):

**Section 1 — addon offers (platform-wide)**
```
DealAndOfferInfo
  .dayWiseOfferInfo[]
  .addOnOffer.offers[].title      → headline
  .addOnOffer.offers[].description → coupon code / short desc (e.g. "use HDFCINFINIA")
  .addOnOffer.offers[].tnc.texts[] → full T&C lines

Classify offer_type:
  "cashback" in title.lower()     → addon_cashback, booking_type = walkin
  otherwise                       → addon_coupon,   booking_type = walkin
```

**Section 2 — prebook offers (restaurant-specific, confirmed in recon)**
```
DealAndOfferInfo
  .dayWiseOfferInfo[]
  .tabsOfferInfo.offersTab[]       → iterate tabs
    .tabInfo.id == "PREBOOK"       → process this tab
    .tabOffers.offers[].type       → "Pre-Book" or "RESERVATION" — both map to prebook_pct
    .tabOffers.offers[].title      → headline (e.g. "Flat 20% off on Total Bill")
    .tabOffers.offers[].textInfo.info → full text (use as headline if title missing)

offer_type = prebook_pct, booking_type = prebook
```

Note: `tabsOfferInfo.offersTab` was non-empty for 5/29 restaurants (Hoot, Onesta, Shiro, Smoke House Deli, Tiger Trail). The field always exists but `offersTab` array is empty for restaurants without prebook deals — safe to iterate without null check.

### EazyDiner scraper

```
deal_data.title            (if != "More Deals") → restaurant_discount, booking_type = prebook
  headline = deal_data.title

eazypay_details.text       → payeazy, booking_type = walkin
  headline = eazypay_details.text

sample_discount_calculator:
  restaurant_offer > 0     → restaurant_discount, booking_type = prebook
    headline = "₹{restaurant_offer} off on ₹{total_bill} bill"
  payment_offer > 0        → payeazy, booking_type = walkin
    headline = "₹{payment_offer} off on ₹{total_bill} bill (PayEazy)"

buffet_deals[]             → buffet, booking_type = prebook
  headline = "{count} buffet package(s) — from ₹{min_price}"
  store full array as raw_json
```

---

## 6. What "best offer" means per platform

For the DiningTab "best offer" comparison, rank within a restaurant × platform by this priority:

1. `prebook_pct` / `restaurant_discount` — concrete money off (highest signal; present on District and Swiggy)
2. `buffet` — distinct product, not comparable to % discounts
3. `payeazy` — payment discount, generally ₹200–₹750 depending on bill
4. `addon_coupon` / `addon_cashback` — platform-wide, same on every restaurant
5. `bank_card` — platform-wide, same on every restaurant; lowest signal

**Display rule:** Show headline offer per platform. Expand to full list on tap.

---

## 7. Data quality notes

| Issue | Impact | Handling |
|---|---|---|
| District `[bank]` offers are platform-wide (20–30 per restaurant, identical across all) | Noise; not useful for "best offer" ranking | Extract but deprioritise in UI — show as secondary list under "Bank offers" |
| Swiggy addon offers are platform-wide (same 9 on every participating restaurant) | Same noise issue | Group as "Payment offers" in UI, not restaurant-specific headline |
| EazyDiner `sample_discount_calculator` is a single example bill, not actual deal terms | Approximation only | Use as headline (e.g. "₹562 off on ₹2500") but note it's illustrative |
| District prebook text sometimes contains items not discounts ("Get Chocolate Pebble") | Can't parse % value | Store as-is in headline; `offer_type = prebook_item` |
| Swiggy Dineout: no restaurant-specific prebook deals surfaced in API | May exist but not in `dinersone-restaurant/json` | Accept gap for v1; monitor if `tabsOfferInfo.tabs[]` appears |

---

## 8. Open questions — RESOLVED

| # | Question | Resolution |
|---|---|---|
| 1 | Does District `allOffers` also include walk-in offers (not just prebook)? | **Confirmed: prebook only.** Across all 7 restaurants with prebook data, every `allOffers` entry is a %-off or complimentary-item pre-booking deal. Walk-in payment offers are exclusively in `bankOffers`. Classification is correct as written in §5. |
| 2 | Does Swiggy `tabsOfferInfo.tabs[]` ever contain pre-booking deals? | **YES — and this changed the scraper spec.** `tabsOfferInfo.offersTab` contains restaurant-specific prebook deals for 5/29 restaurants (Hoot 20%, Onesta 50%/30%/20%, Shiro 10%, Smoke House Deli 20%, Tiger Trail 30%/25%/15%). Offer types: `Pre-Book` and `RESERVATION` — both map to `prebook_pct`. Scraper must parse both sections. §5 and §2 updated accordingly. |
| 3 | Should `bank_card` and `addon_coupon` be stored at all, or filtered at scrape time? | **Store everything.** Raw capture is irreversible; filtering loses data we may want later (e.g. card-specific matching). Suppress in UI per §6 priority ranking — these are already ranked 4th and 5th. |
