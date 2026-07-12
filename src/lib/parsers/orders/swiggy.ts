// Swiggy order-delivered email parser.
//
// Confirmed format (real email, noreply@swiggy.in, 2026-07-06):
//   Subject: "Your Swiggy order was successfully delivered"
//            (also "Your Swiggy Gourmet order was delivered superfast")
//   Text (stripped): "… ORDER JOURNEY Third Wave Coffee <address> Jul 6,
//     10:20 AM … Order ID: 242283010812320 BILL DETAILS Hot Latte [Regular]
//     x2 ₹478 With Milk (₹0) Restaurant Packaging ₹35.00 Platform fee with
//     GST ₹17.58 Discount Applied - ₹180.00 Delivery Fee (FREE with Swiggy
//     One) ₹36 FREE Taxes ₹14.90 Paid Via Credit/Debit card ₹365.00"
//
// Rules:
//   • total_amount is the "Paid Via … ₹X" figure — the amount that actually
//     hit the card — NEVER the item subtotal (discounts/fees make them differ).
//   • Restaurant name comes from the raw HTML: the first bold <p> after
//     "ORDER JOURNEY" (in stripped text the name fuses with the address, so
//     text alone can't separate them).
//   • Item rows are "<name> x<qty>" table cells in the HTML with the ₹price
//     nearby; addon lines like "With Milk (₹0)" have no x<qty> and are
//     skipped automatically.

import { type ParsedOrder, type OrderItem, parseInrAmount, decodeEntities } from "./types";

// Global on purpose: split payments produce MULTIPLE "Paid Via" rows
// (e.g. "Paid Via Swiggy Money ₹50.00" + "Paid Via Credit/Debit card ₹315.00").
// The card row is what hits the bank statement — prefer it; otherwise the
// last row (bill layouts end with the final figure).
const TOTAL_ALL_RE = /Paid\s+Via\s+([^₹]{0,60}?)₹\s*([\d,]+(?:\.\d{1,2})?)/gi;
const ORDER_ID_RE  = /Order\s+ID:\s*(\d{6,})/i;
// Item cell in HTML: ">Hot Latte [Regular] x2<" — name then xQty, no nested tags.
const ITEM_HTML_RE = />([^<>]{2,100}?)\s+x(\d+)\s*<\//gi;
// Price near an item cell: first ₹amount within the next chunk of HTML.
const PRICE_RE     = /₹\s*([\d,]+(?:\.\d{1,2})?)/;
// Restaurant: first bold <p> after ORDER JOURNEY in the raw HTML.
const RESTAURANT_HTML_RE = /<p[^>]*font-weight:\s*700[^>]*>([^<]{2,80})<\/p>/i;

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

  const items: OrderItem[] = [];
  const journeyIdx = html.indexOf("ORDER JOURNEY");
  const restaurantMatch = journeyIdx >= 0
    ? RESTAURANT_HTML_RE.exec(html.slice(journeyIdx))
    : null;

  // Items only exist below BILL DETAILS — search from there so the x<qty>
  // pattern can't accidentally hit anything in the header/journey blocks.
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

  return {
    source: "swiggy",
    kind: "order",
    order_ref: ORDER_ID_RE.exec(text)?.[1],
    merchant_name: restaurantMatch ? decodeEntities(restaurantMatch[1]) : undefined,
    total_amount: total,
    items,
  };
}
