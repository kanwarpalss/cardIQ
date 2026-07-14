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
import { stripHtml } from "../../gmail/strip";

const MONEY = String.raw`₹\s*([\d,]+(?:\.\d{1,2})?)`;
// Where the item name ends — the first field label after it.
const ITEM_END = String.raw`SAC:|Renews|Expires|Report a Problem|Subtotal|TOTAL`;

/** Pull item + charge from one rendering (plain text OR stripped HTML). */
function extractApple(content: string): ParsedOrder | null {
  // The purchased line sits after "DOCUMENT NO. <n>" (receipt + newer invoices,
  // where the header carries a BILLED-TO address first) OR after "Apple Account:
  // <email>" (older invoices). DOCUMENT NO. wins when present — it comes after
  // the address block, so it isolates the item cleanly. Tolerate a ":" + spacing.
  const byDoc = new RegExp(String.raw`DOCUMENT NO\.?:?\s*\d+\s+(.+?)\s+(?:` + ITEM_END + `)`, "is").exec(content);
  const byAcct = new RegExp(String.raw`Apple Account:?\s*\S+@\S+\s+(.+?)\s+(?:` + ITEM_END + `)`, "is").exec(content);
  const rawName = byDoc?.[1] ?? byAcct?.[1] ?? "";
  // Strip any ₹ amounts embedded in the name (receipts repeat the price inline).
  const name = decodeEntities(rawName.replace(/₹\s*[\d,]+(?:\.\d{1,2})?/g, " ")).replace(/\s+/g, " ").trim();

  // Charge: the grand TOTAL, else Store Credit (older invoices have no TOTAL),
  // else the price beside "Renews", else the first ₹ amount.
  const total =
    (new RegExp(String.raw`(?<![A-Za-z])TOTAL:?\s*` + MONEY, "i").exec(content) ?? // not "Subtotal"
      new RegExp(String.raw`Store Credit\s*` + MONEY, "i").exec(content) ??
      new RegExp(String.raw`Renews[^₹]*` + MONEY, "i").exec(content) ??
      new RegExp(MONEY).exec(content))?.[1];
  if (!total) return null;

  return {
    source: "apple",
    kind: "order",
    order_ref: /ORDER ID:?\s*([A-Z0-9]{6,})/i.exec(content)?.[1],
    merchant_name: "Apple",
    total_amount: parseInrAmount(total),
    items: name ? [{ name }] : [],
  };
}

export function parseAppleOrder(subject: string, text: string, html: string): ParsedOrder | null {
  if (!/from Apple\b/i.test(subject) && !/APPLE ACCOUNT|Apple Account/i.test(text)) return null;
  // Some Apple emails carry a sparse colon-formatted text/plain part with the
  // item only in the HTML — try both renderings and prefer the one that yields
  // the item; fall back to whichever at least has the charge.
  const results = [text, html ? stripHtml(html) : ""]
    .map(extractApple)
    .filter((r): r is ParsedOrder => r !== null);
  return results.find((r) => r.items.length > 0) ?? results[0] ?? null;
}
