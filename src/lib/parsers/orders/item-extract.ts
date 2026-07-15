// Shared, format-agnostic line-item extractor for the D2C-on-Shopify and generic
// merchant families. Runs as a FALLBACK after shopify.ts / generic.ts try their
// own extraction, so it can only ADD coverage, never regress the orders that
// already parse. Verified against real emails in KP's Gmail (sampled 2026-07-15):
//
//   Instamart    "Order Items 1 x <name> ₹110.00 …"         qty-first
//   Dot Badges   "Order summary … <name> ×2 ₹78.00 …"        × sign
//   DaMENSCH     "Product Price <name> Qty:1 INR 1590 …"     Qty: colon
//   HUFT         "ITEM(S) QTY PRICE <name> 1 ₹1,499 ₹1,381"  qty + two prices
//   Sleepy Owl   "Order Details … <name> ₹1,234 …"           single price
//   Google Play  "Item Price <name> ₹2,100.00/year …"        single price
//
// Strategy: isolate the item BLOCK (between an order/items header and the first
// totals/address line), then run a prioritised list of row patterns and keep the
// FIRST that yields items. Every candidate name is filtered against a stopword
// list so fee/total/tax lines never masquerade as products.

import { type OrderItem, parseInrAmount, decodeEntities } from "./types";

// Invisible spacer noise some ESPs (Shopify preheaders, Nicobar) pack into the
// body: zero-width spaces, BOM, word joiner, soft hyphen, combining joiner →
// dropped; figure/narrow/no-break spaces → normalised to a real space. Without
// this the item block is unreachable behind thousands of junk code points.
const ZERO_WIDTH = /[​-‏⁠﻿­͏᠎]/g;
const ODD_SPACE = /[     ]/g;

// Opening markers for the item block (broad — first occurrence wins).
const BLOCK_START =
  /(?:here'?s what you ordered|your order details|your product details|product details|order details|your order summary|order summary|items?\s+ordered|order items|item\(s\)\s+qty\s+price|items?\s+qty\s+(?:cost|price)|product\s+(?:quantity|qty\.?)\s+price|product\s+price|item\s+name\s+quantity\s+price|item\s+quantity\s+price|item\s+price|bill details|your items)/i;

// Closing markers — the first one AFTER the start ends the block. Kept tight to
// the money-summary / address region so item rows aren't swallowed by totals.
const BLOCK_END =
  /sub\s*-?\s*total|cart total|bag total|order discount|grand total|total amount|order total|total payable|amount payable|payment summary|payment details|payment info|payment method|shipping address|billing address|delivery details|delivery address|not seeing everything|you saved/i;

// A candidate "name" that is really a fee / tax / total / metadata line. Matched
// against the START of the cleaned name, so "Shipping Charges" or "IGST" is
// rejected while "Shipping Bag by X" (a real product) survives only if longer.
const NAME_STOPWORD =
  /^(?:shipping|sub-?total|subtotal|total|grand total|cart total|bag total|order total|net total|igst|cgst|sgst|utgst|gst|tax|taxes|vat|discount|coupon|promo|payment|convenience fee|delivery|handling|mrp|amount|amount paid|paid|to be paid|wallet|order status|round(?:ing)?|packaging|platform fee|fund sources|current wallet|order id|order no|order number|invoice|qty|quantity|price|item|product|form size)\b/i;

type Row = { name: string; qty?: number; price?: number };

// A secondary column header that sits between the section title and the first
// item row ("… Order summary Order #291218 Product Quantity Price <item> …",
// or Nicobar's "PER ITEM ALL ITEM(S) <item> …").
const COLUMN_HEADER =
  /per\s+item\s+all\s+item\(s\)|all\s+item\(s\)|item\(s\)\s+qty\s+price|items?\s+qty\s+(?:cost|price)|product\s+(?:quantity|qty\.?)\s+price|product\s+price|item\s+name\s+quantity\s+price|item\s+quantity\s+price|item\s+price/i;

// Prioritised row patterns. Each is global; the first pattern to yield ≥1 valid
// item wins, so an unambiguous qty-bearing pattern is preferred over the loose
// qty-less one. `qtyless` patterns face an extra product-shape guard.
const PATTERNS: Array<{ re: RegExp; pick: (m: RegExpMatchArray) => Row; qtyless?: boolean }> = [
  // Shopify "attribute" theme (Nicobar): "<name> Color: X Size: Y Qty : 1
  // Delivery by <date> ₹760 ₹950 ₹760" — qty and price are separated by variant
  // attributes and a delivery date, so consume through them to the first price.
  {
    re: /([A-Za-z][^₹\n]{1,80}?)\s+(?:colou?r|size)\s*:[^₹\n]*?qty\s*:?\s*(\d+)[^₹\n]*?(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/gi,
    pick: (m) => ({ name: m[1], qty: parseInt(m[2], 10), price: parseInrAmount(m[3]) }),
  },
  // "1 x Brik Oven … ₹110.00" — qty, then name, then price.
  {
    re: /(\d{1,3})\s*[x×]\s*([^₹\n]{2,120}?)\s*(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/gi,
    pick: (m) => ({ name: m[2], qty: parseInt(m[1], 10), price: parseInrAmount(m[3]) }),
  },
  // "<name> QTY 1 ₹799" (BBW) and "<name> Qty:1 INR 1590" (DaMENSCH).
  {
    re: /([^₹\n]{2,120}?)\s*qty\s*:?\s*(\d+)\s*(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/gi,
    pick: (m) => ({ name: m[1], qty: parseInt(m[2], 10), price: parseInrAmount(m[3]) }),
  },
  // "<name> ×2 ₹78.00" — × sign, consuming any repeated-qty column before ₹.
  {
    re: /([^×₹\n]{2,120}?)\s*×\s*(\d+)[^×₹]{0,12}?(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/gi,
    pick: (m) => ({ name: m[1], qty: parseInt(m[2], 10), price: parseInrAmount(m[3]) }),
  },
  // "<name> 1 ₹1,499.00 ₹1,381.32" — qty then list price then PAID price (HUFT).
  {
    re: /([^₹\n]{2,120}?)\s+(\d{1,2})\s+(?:rs\.?|inr|₹)\s*[\d,]+(?:\.\d{1,2})?\s+(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/gi,
    pick: (m) => ({ name: m[1], qty: parseInt(m[2], 10), price: parseInrAmount(m[3]) }),
  },
  // Lacoste GST grid: "<name> SKU: RK4711001 … 12 ₹220 1 ₹2,050.00" — name up to
  // the SKU, then (skipping the zero-rate GST columns) the qty + the line total,
  // which is the only ₹ amount carrying paise, so \.\d{2} pins it unambiguously.
  {
    re: /([A-Za-z][^₹\n]{2,90}?)\s+SKU\s*:[^\n]*?(\d+)\s+(?:rs\.?|inr|₹)\s*([\d,]+\.\d{2})/gi,
    pick: (m) => ({ name: m[1], qty: parseInt(m[2], 10), price: parseInrAmount(m[3]) }),
  },
  // DailyObjects: "<name> 699 1499 Order Status : Placed" — bare numbers (sale,
  // then MRP), delimited by the per-item "Order Status" label. Anchored on that
  // label so it never fires on ordinary prose. Price = the sale (first) number.
  {
    re: /([A-Za-z][^₹\n]{2,90}?)\s+(\d{2,6})\s+\d{2,6}\s+order\s+status\s*:/gi,
    pick: (m) => ({ name: m[1], price: parseInrAmount(m[2]) }),
  },
  // "<name> ₹1,234" — single price, no qty. Loosest: runs last, and every match
  // must also pass looksLikeProduct() so address/order-ref lines never qualify.
  {
    re: /([^₹\n]{3,80}?)\s*(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/gi,
    pick: (m) => ({ name: m[1], price: parseInrAmount(m[2]) }),
    qtyless: true,
  },
];

/**
 * Product-shape guard for the qty-less pattern: a real product name has letters,
 * isn't dominated by a long digit run (postal code / order number), and isn't an
 * address fragment. Keeps "200 GB (Google One)"; drops "560066 Order 274645 …".
 */
function looksLikeProduct(name: string): boolean {
  if (name.length > 80) return false;
  if (/\d{5,}/.test(name)) return false; // postal codes, order numbers
  if (!/[a-z]{3,}/i.test(name)) return false; // must have a real word
  if (/\b(flat|road|street|nagar|bengaluru|bangalore|mumbai|pune|india|karnataka|maharashtra|pin|pincode)\b/i.test(name)) return false;
  return true;
}

/**
 * Best-practice first pass: read schema.org line items from JSON-LD markup in
 * the RAW html (Google's Gmail "Order" markup — the most reliable source when a
 * merchant embeds it). Rare in Indian D2C mail today, but when present it beats
 * every heuristic: exact names, prices, quantities. Never throws on bad JSON.
 */
export function extractItemsFromMarkup(html: string): OrderItem[] {
  if (!html || !/application\/ld\+json/i.test(html)) return [];
  const items: OrderItem[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    let data: unknown;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    for (const node of Array.isArray(data) ? data : [data]) collectOffers(node, items);
  }
  // De-dupe by name (some emails repeat the Order node in <head> and <body>).
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = i.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Walk a JSON-LD node for Order/Invoice line items (acceptedOffer / orderedItem). */
function collectOffers(node: unknown, out: OrderItem[]): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;

  const offers = n.acceptedOffer ?? n.orderedItem ?? n.orderItem;
  for (const off of toArray(offers)) {
    if (!off || typeof off !== "object") continue;
    const o = off as Record<string, unknown>;
    // Offer.itemOffered.name  |  OrderItem.orderedItem.name  |  bare .name
    const offered = (o.itemOffered ?? o.orderedItem) as Record<string, unknown> | undefined;
    const name = str(offered?.name) ?? str(o.name);
    if (!name) continue;
    const price = num(o.price) ?? num(offered?.price) ?? num((o.priceSpecification as Record<string, unknown>)?.price);
    const qty = num(o.orderQuantity) ?? num((o.eligibleQuantity as Record<string, unknown>)?.value) ?? num(offered?.orderQuantity);
    const item: OrderItem = { name: decodeEntities(name) };
    if (qty != null) item.qty = qty;
    if (price != null) item.price = price;
    out.push(item);
  }
  // Recurse into common wrappers (Invoice.referencesOrder, arrays, @graph).
  for (const key of ["referencesOrder", "@graph", "mainEntity", "itemListElement"]) {
    for (const child of toArray(n[key])) collectOffers(child, out);
  }
}

const toArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v.replace(/[₹,\s]/g, "")) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Isolate the item block; strips a secondary column header if one leads it. */
function itemBlock(content: string): string | null {
  const start = content.search(BLOCK_START);
  if (start < 0) return null;
  let after = content.slice(start).replace(BLOCK_START, "");
  // A column header near the block start ("Product Quantity Price") plus any
  // order-ref line before it is noise — cut through to the first real row.
  const col = after.search(COLUMN_HEADER);
  if (col >= 0 && col < 160) after = after.slice(col).replace(COLUMN_HEADER, "");
  // Shopify "Order Details" theme (Sleepy Owl) leads with an invoice/address
  // preamble ending in the order number, then the item. If an "Order <digits>"
  // appears before the first ₹ and within the first stretch, cut past it so the
  // address doesn't get glued onto the item name.
  const pre = /^[^₹]{0,220}?\bOrder\s+#?\d{4,}\s+/i.exec(after);
  if (pre) after = after.slice(pre[0].length);
  // Lacoste GST grid: a "Items CGST Rate (%) … IGST Rate (%) Amount Qty Subtotal"
  // header sits right before the first product — strip it so its column words
  // don't glue onto the item name.
  after = after.replace(/^[^₹]*?(?:cgst|sgst|igst|utgst)\s+rate\s*\(%\)[^₹]*?qty\s+subtotal\s+/i, "");
  const end = after.search(BLOCK_END);
  return (end >= 0 ? after.slice(0, end) : after).trim() || null;
}

/**
 * General-purpose item extraction. `brand` (the merchant name) is stripped from
 * a trailing position when present, since some themes append it after products.
 */
export function extractItemsGeneral(content: string, brand?: string): OrderItem[] {
  const block = itemBlock(content.replace(ZERO_WIDTH, "").replace(ODD_SPACE, " "));
  if (!block) return [];

  for (const { re, pick, qtyless } of PATTERNS) {
    const items: OrderItem[] = [];
    const seen = new Set<string>();
    re.lastIndex = 0;
    for (let m = re.exec(block); m; m = re.exec(block)) {
      const row = pick(m);
      const name = cleanName(row.name, brand);
      // Reject fee/total/metadata lines, zero-price rows, and duplicates.
      if (name.length < 2 || NAME_STOPWORD.test(name)) continue;
      if (qtyless && !looksLikeProduct(name)) continue;
      if (row.price != null && row.price <= 0) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const item: OrderItem = { name };
      if (row.qty != null && Number.isFinite(row.qty)) item.qty = row.qty;
      if (row.price != null) item.price = row.price;
      items.push(item);
      if (items.length >= 40) break;
    }
    if (items.length) return items;
  }
  return [];
}

/** Collapse a doubled title to its first occurrence (themes repeat it). */
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

/** Trim label/variant residue, strip a trailing brand, collapse a doubled title. */
function cleanName(raw: string, brand?: string): string {
  let s = decodeEntities(raw)
    .replace(/^(?:form\s+size|form|size|qty|quantity|price)\b[\s:·|,–—-]*/i, "")
    .replace(/^[\s·|,\-–—]+/, "")
    .replace(/[\s·|,\-–—]+$/, "")
    .trim();
  if (brand && brand.length >= 3) {
    const b = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp(String.raw`\s*${b}\s*$`, "i"), "").trim();
  }
  return collapseRepeat(s).replace(/[\s·|,\-–—]+$/, "").trim();
}
