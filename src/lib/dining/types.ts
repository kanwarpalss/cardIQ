export type Platform = "zomato" | "swiggy" | "eazydiner";

export const PLATFORMS: Platform[] = ["zomato", "swiggy", "eazydiner"];

export type OfferType =
  | "prebook_pct"        // %-off pre-booking deal (District allOffers, Swiggy tabsOfferInfo)
  | "prebook_item"       // complimentary item on pre-booking (District allOffers)
  | "bank_card"          // bank/card payment discount (District bankOffers)
  | "addon_coupon"       // platform-wide coupon code (Swiggy addOnOffer)
  | "addon_cashback"     // platform loyalty cashback (Swiggy addOnOffer)
  | "payeazy"            // EazyDiner in-app payment discount
  | "restaurant_discount"// restaurant's own ₹-off deal (EazyDiner)
  | "buffet";            // buffet package (EazyDiner)

export type BookingType = "prebook" | "walkin" | "either";

export interface ScrapedOffer {
  offer_type: OfferType;
  booking_type: BookingType;
  headline: string;
  terms?: string;
  discount_pct?: number; // extracted for ranking; null for non-% offers
}
