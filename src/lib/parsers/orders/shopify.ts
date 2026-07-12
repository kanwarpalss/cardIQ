// Shopify order-confirmation parser — one parser for the whole D2C-on-Shopify
// family. Most Indian direct-to-consumer brands (The Postbox, Inmarwar, …) run
// on Shopify and send the standard Shopify "Thank you for your order" email.
//
// Verified against KP's real emails (2026-07-12):
//   The Postbox  care@thepostbox.in  "…Confirmation email for Order #118863"
//     item "Spark - Stationery Zipper Case / Classic Tan", Total Rs. 1,499.00
//   Inmarwar     care@inmarwar.com   "Your order 10111500 confirmed."
//     item "Sideboard, solid sheesham wood and steel, 4 doors × 1", Total Rs. 23,999
//
// Body shape (after HTML-strip):
//   … Your order summary  <NAME> × <QTY>  Rs. <price>
//     Subtotal Rs X  [Shipping/Discount/Tax …]  Total Rs <TOTAL>  Payment …
//
// The grand total is a BARE "Total" line — "Subtotal" and "Total excl. tax"
// must be excluded, else we'd capture the pre-tax figure and never match the
// card charge. The merchant/brand can't be read reliably from the body (logos,
// spaced wordmarks) so it comes from the sender — which is also what gives the
// amount+time match its affinity (Razorpay bills "Raz*inmarwar" → "inmarwar").

import {
  type ParsedOrder,
  type OrderItem,
  parseInrAmount,
  decodeEntities,
  merchantFromSender,
  isShippingStatusEmail,
} from "./types";

const MONEY = String.raw`(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)`;
// "Total" as a whole word (skips "Subtotal") and not "Total excl. tax".
const GRAND_TOTAL_RE = new RegExp(String.raw`(?<![a-z])total(?!\s+excl)[\s:]*` + MONEY, "gi");
const ORDER_REF_RE = /order\s*(?:number|no\.?|#)\s*[,:#]*\s*([A-Za-z0-9][\w-]{3,})/i;

/** Cheap signature check so generic order emails don't get Shopify treatment. */
export function looksLikeShopify(html: string, text: string): boolean {
  if (/cdn\.shopify\.com|shopifycloud|myshopify\.com/i.test(html)) return true;
  // Structural fallback for stripped/forwarded copies with no Shopify URLs.
  return (
    /your order summary/i.test(text) &&
    /\bsub-?total\b/i.test(text) &&
    new RegExp(String.raw`(?<![a-z])total(?!\s+excl)`, "i").test(text)
  );
}

export function parseShopifyOrder(
  sender: string,
  subject: string,
  text: string,
  _html: string
): ParsedOrder | null {
  // Shipping/delivery status pings are not the order — skip so the charge
  // matches the (correctly-dated) confirmation email instead.
  if (isShippingStatusEmail(subject)) return null;

  // Grand total — LAST match wins (the grand total follows Subtotal / pre-tax).
  let total: number | undefined;
  for (const m of text.matchAll(GRAND_TOTAL_RE)) total = parseInrAmount(m[1]);
  if (total == null) return null; // no order total we can match on → skip

  return {
    source: "shopify",
    kind: /\brefund(ed)?\b/i.test(subject) ? "refund" : "order",
    order_ref: ORDER_REF_RE.exec(subject)?.[1] ?? ORDER_REF_RE.exec(text)?.[1],
    merchant_name: merchantFromSender(sender),
    total_amount: total,
    items: extractItems(text),
  };
}

/** Best-effort line items from the "order summary … Subtotal" block. */
function extractItems(text: string): OrderItem[] {
  const block = /your order summary(.*?)\bsub-?total\b/is.exec(text)?.[1];
  if (!block) return [];

  const items: OrderItem[] = [];
  // Primary: "<name> × <qty>  Rs <price>" (qty is the reliable delimiter).
  const withQty = new RegExp(
    String.raw`([^×]{2,120}?)\s*×\s*(\d+)(?:[^0-9]*?(?:rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?))?`,
    "gi"
  );
  for (const m of block.matchAll(withQty)) {
    const name = decodeEntities(m[1]).replace(/^[\s·|,-]+/, "").trim();
    if (!name) continue;
    items.push({ name, qty: parseInt(m[2], 10), ...(m[3] ? { price: parseInrAmount(m[3]) } : {}) });
  }
  if (items.length) return items;

  // Fallback: the text before the first price line (variants may repeat).
  const single = new RegExp(String.raw`(.{2,120}?)\s*(?:rs\.?|₹)\s*[\d,]+(?:\.\d{1,2})?`, "i").exec(block);
  const name = single ? decodeEntities(single[1]).trim() : "";
  return name ? [{ name }] : [];
}
