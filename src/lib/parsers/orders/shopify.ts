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
import { stripHtml } from "../../gmail/strip";
import { extractItemsGeneral, extractItemsFromMarkup } from "./item-extract";

const MONEY = String.raw`(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)`;
// "Total" as a whole word (skips "Subtotal") and not "Total excl. tax".
const GRAND_TOTAL_RE = new RegExp(String.raw`(?<![a-z])total(?!\s+excl)[\s:]*` + MONEY, "gi");
const ORDER_REF_RE = /order\s*(?:number|no\.?|#)\s*[,:#]*\s*([A-Za-z0-9][\w-]{3,})/i;

/** Cheap signature check so generic order emails don't get Shopify treatment. */
export function looksLikeShopify(html: string, text: string): boolean {
  if (/cdn\.shopify\.com|shopifycloud|myshopify\.com/i.test(html)) return true;
  // Structural fallback for stripped/forwarded copies with no Shopify URLs.
  // Scan BOTH text and stripped HTML — a brand's text/plain part may be junk
  // (leaked CSS) while the order lives in the HTML.
  const hay = `${text} ${html ? stripHtml(html) : ""}`;
  return (
    /(?:your order summary|items ordered)/i.test(hay) &&
    /\bsub-?total\b/i.test(hay) &&
    new RegExp(String.raw`(?<![a-z])total(?!\s+excl)`, "i").test(hay)
  );
}

export function parseShopifyOrder(
  sender: string,
  subject: string,
  text: string,
  html: string
): ParsedOrder | null {
  // Shipping/delivery status pings are not the order — skip so the charge
  // matches the (correctly-dated) confirmation email instead.
  if (isShippingStatusEmail(subject)) return null;

  // Read the order from whichever source actually carries it. Some brands'
  // text/plain part is junk (leaked CSS — e.g. The Postbox), so the stripped
  // HTML is tried first; but a thin/stub HTML falls back to the plain text.
  // "Has an order" == "has a grand-Total line we can match the charge on".
  const merchant = merchantFromSender(sender);
  for (const content of [html ? stripHtml(html) : "", text]) {
    const total = grandTotal(content);
    if (total == null) continue;
    // schema.org markup (most reliable) → theme-specific extraction → the shared
    // heuristic extractor (Sleepy Owl, Supertails, Nicobar, …).
    const markup = extractItemsFromMarkup(html);
    const items = markup.length ? markup : extractItems(content, merchant);
    return {
      source: "shopify",
      kind: /\brefund(ed)?\b/i.test(subject) ? "refund" : "order",
      order_ref: ORDER_REF_RE.exec(subject)?.[1] ?? ORDER_REF_RE.exec(content)?.[1],
      merchant_name: merchant,
      total_amount: total,
      items: items.length ? items : extractItemsGeneral(content, merchant),
    };
  }
  return null; // no order total in either source → not a parseable order
}

/** Grand total — LAST match wins (it follows Subtotal / "Total excl. tax"). */
function grandTotal(content: string): number | undefined {
  let total: number | undefined;
  for (const m of content.matchAll(GRAND_TOTAL_RE)) total = parseInrAmount(m[1]);
  return total;
}

// The item block's start marker and its terminating totals line. Themes vary:
//   header — "Your order summary" / "Order summary" (Gokwik) / "Items ordered"
//            / a bare "Product Qty. Price" column head (Shopflo, e.g. Ellementry)
//   footer — the first totals line: "Subtotal" / "Bag Total" / "Order discount"
//            / "Grand Total". Whichever comes first ends the block.
const ITEM_BLOCK_RE = new RegExp(
  String.raw`(?:your\s+order\s+summary|order\s+summary|items?\s+ordered|product\s+qty\.?\s+price)` +
    String.raw`(.*?)` +
    String.raw`(?:\bsub-?total\b|\bbag\s+total\b|\border\s+discount\b|\bgrand\s+total\b)`,
  "is"
);

/**
 * Best-effort line items from the order block. Delimits the qty with a × sign or
 * a spaced letter "x" ("Postbox x 1 Rs. 1,699.00").
 */
function extractItems(content: string, brand?: string): OrderItem[] {
  const block = ITEM_BLOCK_RE.exec(content)?.[1];
  if (!block) return [];

  const items: OrderItem[] = [];
  // Primary: "<name> × <qty> … ₹<price>". The × never occurs in a name, and we
  // consume THROUGH the price (skipping a variant "L" or a repeated qty column
  // between the ×-qty and the ₹) so the next item's name starts clean —
  // "… × 1 1 ₹1,182  Drop Bottle × 1 1 ₹1,437" splits into two tidy items.
  const withMultSign = new RegExp(
    String.raw`([^×]{2,150}?)\s*×\s*(\d+)[^×₹]*?(?:rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)`,
    "gi"
  );
  for (const m of block.matchAll(withMultSign)) {
    const name = cleanItemName(m[1], brand);
    if (name) items.push({ name, qty: parseInt(m[2], 10), price: parseInrAmount(m[3]) });
  }
  if (items.length) return items;

  // No per-line price in this theme: "<name> × <qty>" only (total lives below).
  const noPriceMult = new RegExp(String.raw`([^×]{2,150}?)\s*×\s*(\d+)`, "gi");
  for (const m of block.matchAll(noPriceMult)) {
    const name = cleanItemName(m[1], brand);
    if (name) items.push({ name, qty: parseInt(m[2], 10) });
  }
  if (items.length) return items;

  // Fallback for the letter-"x" theme: "<name> x <qty> Rs <price>". A bare "x"
  // occurs inside words ("Postbox"), so anchor on spaced-x + qty + a price to
  // disambiguate — the price must follow, which a product name's "x" never does.
  const withLetterX = new RegExp(
    String.raw`(.+?)\s+x\s+(\d+)\s+(?:rs\.?|₹|inr)\s*([\d,]+(?:\.\d{1,2})?)`,
    "gi"
  );
  for (const m of block.matchAll(withLetterX)) {
    const name = cleanItemName(m[1], brand);
    if (name) items.push({ name, qty: parseInt(m[2], 10), price: parseInrAmount(m[3]) });
  }
  if (items.length) return items;

  // Last resort: the text before the first price line (single-item orders).
  const single = new RegExp(String.raw`(.{2,150}?)\s*(?:rs\.?|₹)\s*[\d,]+(?:\.\d{1,2})?`, "i").exec(block);
  const name = single ? cleanItemName(single[1], brand) : "";
  return name ? [{ name }] : [];
}

/**
 * A doubled product title collapses to its first occurrence. The "Items ordered"
 * theme repeats the title around the variant ("Spark … / Classic Tan - Classic
 * Tan Spark … / Classic Tan Classic Tan"), so once the tail re-states the head
 * phrase, cut there. Only phrases ≥10 chars count, so short repeated words
 * ("Tan … Tan") never trigger a false truncation.
 */
function collapseRepeat(name: string): string {
  const words = name.split(/\s+/);
  for (let take = Math.min(10, words.length - 1); take >= 3; take--) {
    const head = words.slice(0, take).join(" ");
    if (head.length < 10) continue;
    const idx = name.indexOf(head, head.length);
    if (idx > 0) return name.slice(0, idx).trim();
  }
  return name;
}

/**
 * Trim list punctuation and a leading "Items ordered"-style label residue, then
 * (for D2C themes) strip a trailing brand the theme appends after the product
 * ("… Classic Tan The Postbox") and collapse a doubled title.
 */
function cleanItemName(raw: string, brand?: string): string {
  let s = decodeEntities(raw).replace(/^[\s·|,\-–—]+/, "").replace(/[\s·|,\-–—]+$/, "").trim();
  if (brand && brand.length >= 3) {
    const b = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp(String.raw`\s*${b}\s*$`, "i"), "").trim();
  }
  return collapseRepeat(s).replace(/[\s·|,\-–—]+$/, "").trim();
}
