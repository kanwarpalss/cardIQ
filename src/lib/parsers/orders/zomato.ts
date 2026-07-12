// Zomato order email parser.
//
// Confirmed format (real email, noreply@zomato.com, 2026-06-22):
//   Subject: "Your Zomato order from YUKI"   ← restaurant lives in the subject
//   Text (stripped): "… Thank you for ordering from YUKI ORDER ID: 8266257923
//     Delivered YUKI <address> 1 X Volcano Roll. … Total paid - ₹747.33 …"
//   HTML: each item is its own <p>: ">1 X Volcano Roll.<"
//
// Rules:
//   • Zomato emails carry NO per-item prices — items get name+qty only.
//   • total_amount is "Total paid - ₹X" (what hit the card).

import { type ParsedOrder, type OrderItem, parseInrAmount, decodeEntities } from "./types";

const SUBJECT_RE   = /order\s+from\s+(.{1,80})$/i;
const ORDER_ID_RE  = /ORDER\s+ID:\s*(\d{6,})/i;
const TOTAL_RE     = /Total\s+paid\s*[-–—:]?\s*₹\s*([\d,]+(?:\.\d{1,2})?)/i;
// Item in HTML: ">1 X Volcano Roll.<" — qty first, then name, in one text node.
const ITEM_HTML_RE = />\s*(\d+)\s*X\s+([^<>]{2,100}?)\s*<\//g;
// Text fallback (recategorize-from-stored-body path stores stripped text only):
// items run together, each terminated by the next "N X " or by "Total paid".
const ITEM_TEXT_RE = /(\d+)\s+X\s+(.+?)(?=\s+\d+\s+X\s+|\s+Total\s+paid|$)/g;

export function parseZomatoOrder(subject: string, text: string, html: string): ParsedOrder | null {
  const subjectMatch = SUBJECT_RE.exec(subject.trim());
  if (!subjectMatch) return null; // promos, ratings nags, etc.

  const totalMatch = TOTAL_RE.exec(text);
  if (!totalMatch) return null;

  const items: OrderItem[] = [];
  // Dedupe on name+qty: Zomato HTML repeats blocks for responsive layouts
  // (same item twice = layout duplication), but "1 X Coke" and "2 X Coke"
  // are two REAL lines and both must survive.
  const seen = new Set<string>();
  const pushItem = (qty: string, rawName: string) => {
    const name = decodeEntities(rawName).replace(/\.\s*$/, "");
    const key = `${name.toLowerCase()}|${qty}`;
    if (!name || seen.has(key)) return;
    seen.add(key);
    items.push({ name, qty: parseInt(qty, 10) });
  };

  if (html) {
    for (const m of html.matchAll(ITEM_HTML_RE)) pushItem(m[1], m[2]);
  }
  if (items.length === 0) {
    for (const m of text.matchAll(ITEM_TEXT_RE)) pushItem(m[1], m[2]);
  }

  return {
    source: "zomato",
    kind: "order",
    order_ref: ORDER_ID_RE.exec(text)?.[1],
    merchant_name: decodeEntities(subjectMatch[1]),
    total_amount: parseInrAmount(totalMatch[1]),
    items,
  };
}
