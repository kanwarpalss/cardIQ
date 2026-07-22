// Order-parser registry — mirrors the bank-parser registry pattern
// (src/lib/parsers/registry.ts): sender-matched, first match wins.
//
// Blinkit is intentionally ABSENT: verified against KP's Gmail on
// 2026-07-11 — Blinkit sends no order emails at all (invoices live only in
// the app), so a parser would be untestable dead code. If Blinkit ever adds
// email receipts, add blinkit.ts + a sender entry here; the orders table
// already accepts source='blinkit'.

import { type ParsedOrder } from "./types";
import { applyMerchantItemOverride } from "./merchant-items";
import { parseSwiggyOrder } from "./swiggy";
import { parseZomatoOrder } from "./zomato";
import { parseBigbasketOrder } from "./bigbasket";
import { parseAmazonOrder } from "./amazon";
import { parseRazorpayOrder } from "./razorpay";
import { parseSmartbuyOrder } from "./smartbuy";
import { parseAppleOrder } from "./apple";
import { looksLikeShopify, parseShopifyOrder } from "./shopify";
import { parseGenericOrder } from "./generic";

export type { ParsedOrder, OrderItem, OrderSource } from "./types";

/**
 * Marketplace senders that get a rich, format-specific parser. These are still
 * queried explicitly so a Swiggy/Zomato/BigBasket/Amazon email is always caught
 * even if Gmail didn't file it under the Purchases category.
 */
export const ORDER_QUERY_SENDERS = [
  "noreply@swiggy.in",
  "noreply@zomato.com",
  "alerts@bigbasket.com",
  "order-update@amazon.in",
  "payments-messages@amazon.in",
  // Razorpay is the universal payment rail — one "Payment successful for
  // <entity>" email per charge, carrying the exact merchant/amount/time that
  // matches the bank descriptor. Highest-yield single sender.
  "no-reply@razorpay.com",
  "subscriptions@razorpay.com",
] as const;

/**
 * Gmail query clauses for order DISCOVERY (feature C, generic rewrite).
 * Merchants can be anything (D2C brands charge direct via Razorpay/Shopify), so
 * we no longer scan only the five senders above. `category:purchases` is
 * Gmail's own order/receipt bucket — high-precision across every merchant — and
 * the subject terms catch the rest. Parsers stay strict, so non-orders that
 * slip in are recorded as seen but never stored as orders.
 */
export const ORDER_DISCOVERY_CLAUSES = [
  "category:purchases",
  "subject:(order OR receipt OR invoice OR confirmation)",
  ...ORDER_QUERY_SENDERS.map((s) => `from:${s}`),
  // Gyftr voucher-issuance emails (the voucher bridge). Their subject
  // ("…Gift Voucher details…") carries none of the order keywords above, so
  // add the sender explicitly. They're parsed as vouchers, not orders.
  "from:gifts@gyftr.com",
  // SmartBuy travel — subject is "… Booking with SmartBuy is Successful", no
  // order/receipt keyword, so add the sender.
  "from:donotreply@smartbuyoffers.co",
] as const;

/** "Swiggy <noreply@swiggy.in>" → "noreply@swiggy.in" (lowercased). */
function senderAddress(sender: string): string {
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(sender);
  return (angle ? angle[1] : sender).trim().toLowerCase();
}

/**
 * Domain-anchored sender check — NOT a substring test. Gmail's `from:` query
 * is the first guard, but this function is directly callable, so it must not
 * route "billing@fakeamazon.in.phish.example" into the Amazon parser just
 * because "amazon.in" appears somewhere in the string.
 */
function fromDomain(sender: string, domain: string): boolean {
  const addr = senderAddress(sender);
  return addr.endsWith("@" + domain) || addr.endsWith("." + domain);
}

// Pure logistics / courier intermediaries. They only ever relay fulfilment
// status ("shipped", "reached your city", "delivered") for a purchase made
// elsewhere — the real merchant sends its own order email. Their mail must NEVER
// become an order: merchant_name would be the courier (useless in the ledger),
// and they evade same-purchase dedup (courier name ≠ merchant, no shared
// order_ref, dated days after the charge). Confirmed sender: info@net.shiprocket.in.
const LOGISTICS_DOMAINS = [
  "shiprocket.in", "delhivery.com", "bluedart.com", "ekartlogistics.com",
  "xpressbees.com", "dtdc.com", "ecomexpress.in", "shadowfax.in", "gati.com",
  "aftership.com", "clickpost.in",
];

/** A courier/logistics relay whose mail is always a status ping, never an order. */
export function isLogisticsSender(sender: string): boolean {
  return LOGISTICS_DOMAINS.some((d) => fromDomain(sender, d));
}

const ORDER_SENDER_PARSERS: Array<{
  match: (sender: string) => boolean;
  parse: (subject: string, text: string, html: string) => ParsedOrder | null;
}> = [
  { match: (s) => fromDomain(s, "swiggy.in"),                    parse: parseSwiggyOrder },
  { match: (s) => fromDomain(s, "zomato.com"),                   parse: parseZomatoOrder },
  { match: (s) => senderAddress(s) === "alerts@bigbasket.com",   parse: parseBigbasketOrder },
  { match: (s) => fromDomain(s, "amazon.in"),                    parse: parseAmazonOrder },
  { match: (s) => fromDomain(s, "razorpay.com"),                 parse: parseRazorpayOrder },
  { match: (s) => fromDomain(s, "smartbuyoffers.co"),            parse: parseSmartbuyOrder },
  { match: (s) => fromDomain(s, "apple.com"),                    parse: parseAppleOrder },
];

export function parseOrderEmail(
  sender: string,
  subject: string,
  text: string,
  html: string
): ParsedOrder | null {
  const parsed = runParsers(sender, subject, text, html);
  // Post-parse: stamp a known item for override merchants (e.g. GoRally →
  // "Pickleball Game") when the parser found none — regardless of source, since
  // such merchants often bill via a payment rail that lists no items.
  return parsed ? applyMerchantItemOverride(parsed, `${parsed.merchant_name ?? ""} ${subject} ${sender}`) : null;
}

function runParsers(sender: string, subject: string, text: string, html: string): ParsedOrder | null {
  // 0. Courier/logistics relays never carry a real order — reject before any
  //    parser can mistake their status ping (with a total) for a purchase.
  if (isLogisticsSender(sender)) return null;
  // 1. Known marketplaces — sender-gated, richest extraction. A marketplace
  //    match is authoritative: if its parser returns null (e.g. a Swiggy
  //    cancellation), that's a real "not an order", not a fall-through.
  for (const { match, parse } of ORDER_SENDER_PARSERS) {
    if (match(sender)) return parse(subject, text, html);
  }
  // 2. Shopify — covers the large D2C-on-Shopify family from any sender.
  if (looksLikeShopify(html, text)) {
    const parsed = parseShopifyOrder(sender, subject, text, html);
    if (parsed) return parsed;
  }
  // 3. Generic fallback — any other merchant with a labelled total.
  return parseGenericOrder(sender, subject, text, html);
}
