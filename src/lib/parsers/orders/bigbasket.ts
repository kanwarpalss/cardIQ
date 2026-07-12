// BigBasket order-confirmation email parser.
//
// Confirmed format (real email, alerts@bigbasket.com, 2026-07-03):
//   Subject: "Your bigbasket order confirmation ( BNN-2032973738-20260703 )"
//   HTML: item names live inside product links —
//     <a href="https://www.bigbasket.com/pd/40149830/…">Nandini Curd 500 g</a>
//   Text row per item: "<name> 1.0 Rs. 28.00 Rs. 28.00 Rs. 0.0"
//     (qty with one decimal, then unit price, line subtotal, savings)
//   Totals: "Sub Total: Rs. 482.84 … Final Total: Rs. 0.00"
//
// Rules:
//   • Only the "order confirmation" subject parses; delivery notices and
//     marketing from info.bigbasket.com are skipped (recorded as seen).
//   • BigBasket's "Final Total" is unreliable — the real 2026-07-03 sample
//     says Rs. 0.00 on a ₹482.84 order. Use Final Total only when > 0,
//     else fall back to Sub Total. A wrong total simply fails to match any
//     transaction (exact-amount matching), never mislabels one.

import { type ParsedOrder, type OrderItem, parseInrAmount, decodeEntities } from "./types";

const ORDER_REF_RE   = /(BNN-[\d]+-[\d]+)/;
const FINAL_TOTAL_RE = /Final\s+Total:\s*Rs\.\s*([\d,]+(?:\.\d{1,2})?)/i;
const SUB_TOTAL_RE   = /Sub\s+Total:\s*Rs\.\s*([\d,]+(?:\.\d{1,2})?)/i;
// Item names are anchor text of /pd/ product links — the one structural
// element BigBasket can't render the email without.
const ITEM_LINK_RE   = /<a[^>]*\/pd\/\d+[^>]*>\s*([^<]{2,120}?)\s*<\/a>/gi;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseBigbasketOrder(subject: string, text: string, html: string): ParsedOrder | null {
  if (!/order\s+confirmation/i.test(subject)) return null;

  const orderRef = ORDER_REF_RE.exec(subject)?.[1] ?? ORDER_REF_RE.exec(text)?.[1];

  const finalTotal = FINAL_TOTAL_RE.exec(text);
  const subTotal   = SUB_TOTAL_RE.exec(text);
  // Template check is "did EITHER total line parse", not "is the total
  // truthy" — a genuinely free order (₹0.00 everywhere) is still an order
  // and must be recorded, not silently dropped (boundary-prover finding).
  if (!finalTotal && !subTotal) return null;
  const finalAmt = finalTotal ? parseInrAmount(finalTotal[1]) : 0;
  const subAmt   = subTotal   ? parseInrAmount(subTotal[1])   : 0;
  const total    = finalAmt > 0 ? finalAmt : subAmt;

  const items: OrderItem[] = [];
  for (const m of html.matchAll(ITEM_LINK_RE)) {
    const name = decodeEntities(m[1]);
    if (!name) continue;
    // Qty + line subtotal live in the stripped text right after the name:
    // "<name> 1.0 Rs. 28.00 Rs. 28.00 Rs. 0.0" (qty, unit, subtotal, savings)
    const row = new RegExp(
      escapeRegex(name) + String.raw`\s+([\d.]+)\s+Rs\.\s*([\d,]+(?:\.\d{1,2})?)\s+Rs\.\s*([\d,]+(?:\.\d{1,2})?)`
    ).exec(text);
    items.push({
      name,
      ...(row ? { qty: parseFloat(row[1]), price: parseInrAmount(row[3]) } : {}),
    });
  }

  return {
    source: "bigbasket",
    kind: "order",
    order_ref: orderRef,
    total_amount: total,
    items,
  };
}
