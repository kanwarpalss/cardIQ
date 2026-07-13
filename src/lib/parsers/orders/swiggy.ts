// Swiggy order-delivered email parser.
//
// Swiggy sends TWO different delivered-order templates; this parser handles both.
//
// Format A — "ORDER JOURNEY / BILL DETAILS" (HTML-structured, 2026-07-06):
//   "… ORDER JOURNEY Third Wave Coffee <address> … Order ID: 2422830… BILL
//    DETAILS Hot Latte [Regular] x2 ₹478 … Paid Via Credit/Debit card ₹365.00"
//   Items are ">name x<qty><" HTML cells; restaurant is the first bold <p>.
//
// Format B — "Your Order Summary" table (the COMMON one, real 2024-07-06 email):
//   "… Order No: 1792537… Restaurant Corner House Ice Cream Your Order Summary:
//    … Item Name Quantity Price Cafe Caramel 1 ₹ 200 Death By Chocolate 1 ₹ 230
//    Item Total: ₹ 430.00 … Paid Via Credit/Debit card: ₹ 563.00"
//   Items + restaurant + order-ref are all in plain TEXT here — no HTML needed.
//   (Format A's HTML item extraction silently yields nothing on Format B, which
//    is why 91 real orders had zero item detail until this fallback was added.)
//
// Rules:
//   • total_amount is the "Paid Via … ₹X" figure — the amount that actually
//     hit the card — NEVER the item subtotal (discounts/fees make them differ).
//   • Item/restaurant extraction tries the HTML path first, then the text table.

import { type ParsedOrder, type OrderItem, parseInrAmount, decodeEntities } from "./types";

// Global on purpose: split payments produce MULTIPLE "Paid Via" rows
// (e.g. "Paid Via Swiggy Money ₹50.00" + "Paid Via Credit/Debit card ₹315.00").
// The card row is what hits the bank statement — prefer it; otherwise the
// last row (bill layouts end with the final figure).
const TOTAL_ALL_RE = /Paid\s+Via\s+([^₹]{0,60}?)₹\s*([\d,]+(?:\.\d{1,2})?)/gi;
// Order reference — Format A uses "Order ID:", Format B uses "Order No:".
const ORDER_REF_RE = /Order\s+(?:ID|No)\.?:\s*(\d{6,})/i;
// Item cell in HTML: ">Hot Latte [Regular] x2<" — name then xQty, no nested tags.
const ITEM_HTML_RE = />([^<>]{2,100}?)\s+x(\d+)\s*<\//gi;
// Price near an item cell: first ₹amount within the next chunk of HTML.
const PRICE_RE     = /₹\s*([\d,]+(?:\.\d{1,2})?)/;
// Restaurant: first bold <p> after ORDER JOURNEY in the raw HTML.
const RESTAURANT_HTML_RE = /<p[^>]*font-weight:\s*700[^>]*>([^<]{2,80})<\/p>/i;
// Format B — restaurant sits between "Restaurant" and "Your Order Summary".
const RESTAURANT_TEXT_RE = /\bRestaurant\s+(.+?)\s+Your\s+Order\s+Summary/i;
// Format B item table lives between the "Item Name Quantity Price" header and
// "Item Total:". Each row is "<name> <qty> ₹ <price>".
const ITEM_TEXT_BLOCK_RE = /Item\s+Name\s+Quantity\s+Price\s+(.+?)\s+Item\s+Total/i;
const ITEM_TEXT_ROW_RE   = /([^₹]+?)\s+(\d+)\s+₹\s*([\d,]+(?:\.\d{1,2})?)/g;

/** Format B: line items from the plain-text "Item Name Quantity Price" table. */
function itemsFromText(text: string): OrderItem[] {
  const block = ITEM_TEXT_BLOCK_RE.exec(text)?.[1];
  if (!block) return [];
  const items: OrderItem[] = [];
  ITEM_TEXT_ROW_RE.lastIndex = 0;
  for (let m = ITEM_TEXT_ROW_RE.exec(block); m; m = ITEM_TEXT_ROW_RE.exec(block)) {
    const name = decodeEntities(m[1]).replace(/^[\s·|,-]+/, "").trim();
    if (!name) continue;
    items.push({ name, qty: parseInt(m[2], 10), price: parseInrAmount(m[3]) });
  }
  return items;
}

function pickPaidAmount(text: string): number | undefined {
  const paid: Array<{ method: string; amount: number }> = [];
  for (const m of text.matchAll(TOTAL_ALL_RE)) {
    paid.push({ method: m[1], amount: parseInrAmount(m[2]) });
  }
  if (paid.length === 0) return undefined;
  const card = paid.filter((p) => /card/i.test(p.method));
  return (card.length > 0 ? card[card.length - 1] : paid[paid.length - 1]).amount;
}

export function parseSwiggyOrder(subject: string, text: string, html: string): ParsedOrder | null {
  // "delivered" is required: cancellation/refund emails ("Your Swiggy order
  // was cancelled and refunded") can still recap the paid amount and would
  // otherwise be misfiled as a normal spend.
  if (!/swiggy.*order/i.test(subject) || !/delivered/i.test(subject)) return null;

  const total = pickPaidAmount(text);
  if (total === undefined) return null; // no paid amount → not the delivered-order template

  // ── Items: Format A (HTML BILL DETAILS) first, then Format B (text table). ──
  const items: OrderItem[] = [];
  const billIdx = html.indexOf("BILL DETAILS");
  if (billIdx >= 0) {
    const billHtml = html.slice(billIdx);
    for (const m of billHtml.matchAll(ITEM_HTML_RE)) {
      const name = decodeEntities(m[1]);
      // Fee/addon rows never carry x<qty>, but guard against label-shaped names.
      if (/^(restaurant packaging|platform fee|delivery fee|taxes|discount)/i.test(name)) continue;
      const price = PRICE_RE.exec(billHtml.slice(m.index! + m[0].length, m.index! + m[0].length + 600));
      items.push({
        name,
        qty: parseInt(m[2], 10),
        ...(price ? { price: parseInrAmount(price[1]) } : {}),
      });
    }
  }
  if (items.length === 0) items.push(...itemsFromText(text));

  // ── Restaurant: HTML bold-<p> (Format A), else the text label (Format B). ──
  const journeyIdx = html.indexOf("ORDER JOURNEY");
  const restaurantHtml = journeyIdx >= 0 ? RESTAURANT_HTML_RE.exec(html.slice(journeyIdx))?.[1] : undefined;
  const restaurant = restaurantHtml ?? RESTAURANT_TEXT_RE.exec(text)?.[1];

  return {
    source: "swiggy",
    kind: "order",
    order_ref: ORDER_REF_RE.exec(text)?.[1],
    merchant_name: restaurant ? decodeEntities(restaurant).trim() : undefined,
    total_amount: total,
    items,
  };
}
