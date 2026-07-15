// Shared types for order-confirmation email parsers (V2 feature C).
//
// Contract mirrors the bank-parser contract: a parser receives one email
// (subject + HTML-stripped text + raw HTML) and returns a ParsedOrder or
// null. Null means "not an order email" — the sync route records the message
// as seen and moves on, exactly like a skipped bank email.

// Known platforms get rich, format-specific parsers. "shopify" covers the
// large family of D2C brands on Shopify (Postbox, Inmarwar, …) with one
// parser; "generic" is the any-merchant fallback. `source` is stored free-form
// in the DB (migration 013 drops the CHECK constraint) so a new brand never
// needs a schema change — the brand itself lives in `merchant_name`.
export type OrderSource =
  | "amazon" | "swiggy" | "zomato" | "bigbasket" | "blinkit"
  | "razorpay" | "shopify" | "smartbuy" | "apple" | "ikea" | "generic";

export type OrderItem = {
  name: string;
  /** Quantity — BigBasket sends decimals ("8.0"), so number not int. */
  qty?: number;
  /** Line total in INR for this item row, when the email provides it. */
  price?: number;
};

export type ParsedOrder = {
  source: OrderSource;
  /** 'refund' orders match CREDIT transactions; 'order' matches DEBIT. */
  kind: "order" | "refund";
  /** Platform's own order number (BNN-…, 8266257923, 404-1234567-1234567). */
  order_ref?: string;
  /** Restaurant / store name when the platform is a marketplace. */
  merchant_name?: string;
  /**
   * Amount actually paid, in INR. undefined when the email carries no
   * amount at all (Amazon "Delivered:" emails) — such orders can only ever
   * be a low-confidence match.
   */
  total_amount?: number;
  items: OrderItem[];
};

export function parseInrAmount(raw: string): number {
  return parseFloat(raw.replace(/,/g, ""));
}

/**
 * Brand name from a From header, for D2C orders where the merchant isn't a
 * known marketplace. Prefers the display name ("The Postbox <care@…>" → "The
 * Postbox"); falls back to the domain's second-level label ("care@inmarwar.com"
 * → "Inmarwar"). Used both as the shown merchant and — critically — for
 * amount+time match affinity against the bank's descriptor (Razorpay sends
 * "Raz*inmarwar", which cleans to "inmarwar" → token overlap → confident match).
 */
export function merchantFromSender(from: string): string {
  const display = /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1]?.trim();
  if (display && !display.includes("@")) return decodeEntities(display);

  const addr = /<([^<>@\s]+@[^<>\s]+)>/.exec(from)?.[1] ?? from;
  const domain = (addr.split("@")[1] ?? "").replace(/>.*$/, "").trim().toLowerCase();
  if (!domain) return "Unknown";
  // thepostbox.in → thepostbox ; shop.brand.co.in → brand ; drop TLD + common
  // subdomain noise (mail., email., shop., store., care.).
  const labels = domain.split(".").filter(Boolean);
  const tldCount = /\.(co|com|net|org|gov|ac)\.[a-z]{2}$/.test(domain) ? 2 : 1;
  const core = labels.slice(0, Math.max(1, labels.length - tldCount));
  const root = core[core.length - 1] ?? domain;
  return root ? root.charAt(0).toUpperCase() + root.slice(1) : "Unknown";
}

// Fulfilment-progress pings that are NEVER the purchase itself: packed,
// shipped, dispatched, out-for-delivery, in-transit. A purchase ALWAYS has a
// prior confirmation email, so these are safe to drop outright — even when they
// carry the item list (BBW/apparelgroup repeats the items in every status
// email). "delivered" is deliberately EXCLUDED here — for some marketplaces the
// delivered email IS the receipt (Supertails/Instamart), so it's handled
// conditionally (dropped only when it carries no item detail).
const IN_TRANSIT_RE =
  /\b(on its way|is on the way|has shipped|been shipped|successfully shipped|order shipped|shipped|shipment|shipping update|out for delivery|arriving|has been packed|successfully packed|been packed|packed|dispatched|track(ing)? (your )?(order|package|shipment)|at your doorstep)\b/i;
const DELIVERED_RE = /\b(delivered|been delivered|order (is )?(now )?delivered)\b/i;

/**
 * A pure in-transit / fulfilment-progress ping (packed / shipped / dispatched /
 * out-for-delivery). These are ALWAYS dropped — there is always a separate
 * order-confirmation email to match the charge on, so keeping a status ping
 * would double-count the purchase (and show a delivery date, not order date).
 */
export function isInTransitStatusEmail(subject: string): boolean {
  return IN_TRANSIT_RE.test(subject);
}

/**
 * Is this a shipping / delivery STATUS email rather than the order itself?
 * A purchase generates one order-confirmation email (dated at purchase time,
 * with the items + total) plus several later status pings ("on its way",
 * "shipped", "out for delivery", "delivered"). Only the confirmation should be
 * matched to the charge — the status pings are dated days later, so they blow
 * the time window and, worse, would show stale/no item detail. KP's rule: "if
 * you have a shipped email you have an order email too" → always prefer the
 * order email and skip the status ones.
 *
 * NOTE: marketplace parsers (Swiggy/Zomato) are sender-gated and handle their
 * own "delivered = the receipt" semantics; this guard is for Shopify/generic.
 */
export function isShippingStatusEmail(subject: string): boolean {
  return IN_TRANSIT_RE.test(subject) || DELIVERED_RE.test(subject);
}

/** Decode the handful of HTML entities that survive into text we capture. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
