// Generic order-confirmation parser — the any-merchant safety net.
//
// Runs only after the marketplace parsers (sender-gated) and the Shopify parser
// (signature-gated) decline. Deliberately strict so ordinary mail (newsletters,
// shipping-status pings, "order now!" promos) does NOT become a phantom order:
//   1. the email must carry an order-intent phrase, AND
//   2. a labelled total must be extractable.
// Both true → an order we can match on amount + time; otherwise null (recorded
// as seen, never stored). Items are left empty — arbitrary templates have no
// reliable item structure, and the match (merchant + total) is the point.

import { type ParsedOrder, parseInrAmount, merchantFromSender, isShippingStatusEmail } from "./types";

const MONEY = String.raw`(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)`;

const ORDER_INTENT_RE =
  /order\s*(?:confirmation|confirmed|placed|summary|number|no\.?|#)|your\s+order|thank\s+you\s+for\s+(?:your\s+)?order|payment\s+(?:successful|received|confirmation)|amount\s+paid|tax\s+invoice|\breceipt\b/i;

const ORDER_REF_RE =
  /order\s*(?:number|no\.?|id|#)\s*[,:#]*\s*([A-Za-z0-9][\w-]{3,})/i;

// Total labels in priority order — most specific first so "Amount Paid"
// beats a bare "Total". Each is paired with a nearby money value.
const TOTAL_LABELS = [
  /amount\s+paid/i,
  /grand\s+total/i,
  /order\s+total/i,
  /total\s+payable/i,
  /net\s+payable/i,
  /(?:you\s+)?paid/i,
  /total\s+amount/i,
  new RegExp(String.raw`(?<![a-z])total(?!\s+excl)`, "i"),
];

function extractTotal(text: string): number | undefined {
  // Payment-rail phrasing where the amount PRECEDES the keyword:
  // "Rs. 470 paid to Cosmo via PayEazy", "₹310 has been made". The label loop
  // below only finds "<label> … <amount>", so catch this pattern first.
  const prePaid =
    /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)\s+(?:paid\b|was\s+paid|has\s+been\s+(?:paid|made))/i.exec(text);
  if (prePaid) return parseInrAmount(prePaid[1]);

  for (const label of TOTAL_LABELS) {
    const at = text.search(label);
    if (at === -1) continue;
    // Money must appear within a short window after the label (same row/cell).
    const money = new RegExp(MONEY, "i").exec(text.slice(at, at + 48));
    if (money) return parseInrAmount(money[1]);
  }
  return undefined;
}

export function parseGenericOrder(
  sender: string,
  subject: string,
  text: string,
  _html: string
): ParsedOrder | null {
  const hay = `${subject}\n${text}`;
  if (isShippingStatusEmail(subject)) return null; // status ping, not the order
  if (!ORDER_INTENT_RE.test(hay)) return null;

  const total = extractTotal(text);
  if (total == null) return null;

  return {
    source: "generic",
    kind: /\brefund(ed)?\b/i.test(subject) ? "refund" : "order",
    order_ref: ORDER_REF_RE.exec(hay)?.[1],
    merchant_name: merchantFromSender(sender),
    total_amount: total,
    items: [],
  };
}
