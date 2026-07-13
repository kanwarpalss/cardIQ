// Apple receipt/invoice parser (V2 feature C).
//
// Apple (no_reply@email.apple.com) sends two shapes, both verified against KP's
// real emails:
//
//  INVOICE ("Your invoice from Apple." / "Tax Invoice"):
//    "… Apple Account: kanwarpalss@gmail.com Apple One Family (Monthly)
//     SAC: 998439 Renews 8 August 2026 ₹ 365.00 … Store Credit ₹ 365.00"
//    → item = the subscription name; charge = the ₹ beside it.
//
//  RECEIPT ("Your receipt from Apple."):
//    "… DOCUMENT NO. 820158479139 Apple Services ₹ 100 Add Funds to Apple
//     Account Kanwar's iPhone Pro ₹ 100 TOTAL ₹ 100"
//    (the whole block is then repeated — parse the FIRST copy only.)
//    → item = the app/service + description; charge = TOTAL.

import { type ParsedOrder, parseInrAmount, decodeEntities } from "./types";

const MONEY = String.raw`₹\s*([\d,]+(?:\.\d{1,2})?)`;

export function parseAppleOrder(subject: string, text: string, _html: string): ParsedOrder | null {
  if (!/from Apple\b/i.test(subject) && !/APPLE ACCOUNT|Apple Account:/i.test(text)) return null;

  // ── Invoice (subscription) ──
  if (/Tax Invoice/i.test(text) || /invoice from Apple/i.test(subject)) {
    const name = /Apple Account:\s*\S+\s+(.+?)\s+(?:SAC:|Renews|Expires|₹)/i.exec(text)?.[1]?.trim();
    const price =
      new RegExp(String.raw`Renews[^₹]*` + MONEY, "i").exec(text)?.[1] ??
      new RegExp(String.raw`Store Credit\s*` + MONEY, "i").exec(text)?.[1] ??
      new RegExp(MONEY).exec(text)?.[1];
    if (!name || !price) return null;
    return {
      source: "apple",
      kind: "order",
      order_ref: /Order ID:?\s*([A-Z0-9]{6,})/i.exec(text)?.[1],
      merchant_name: "Apple",
      total_amount: parseInrAmount(price),
      items: [{ name: decodeEntities(name) }],
    };
  }

  // ── Receipt ──
  const total = new RegExp(String.raw`TOTAL\s*` + MONEY, "i").exec(text)?.[1];
  if (!total) return null;
  // The purchased line(s) sit between DOCUMENT NO. and TOTAL. Strip the ₹ amounts
  // out of it to leave the app/service + description (+ device) as the item name.
  const seg = /DOCUMENT NO\.?\s*\d+\s+(.+?)\s+TOTAL\s*₹/is.exec(text)?.[1] ?? "";
  const name = decodeEntities(seg.replace(/₹\s*[\d,]+(?:\.\d{1,2})?/g, " ")).replace(/\s+/g, " ").trim();
  return {
    source: "apple",
    kind: "order",
    order_ref: /ORDER ID\s+([A-Z0-9]{6,})/i.exec(text)?.[1],
    merchant_name: "Apple",
    total_amount: parseInrAmount(total),
    items: name ? [{ name }] : [],
  };
}
