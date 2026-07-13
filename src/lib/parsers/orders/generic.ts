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

import { type ParsedOrder, type OrderItem, parseInrAmount, decodeEntities, merchantFromSender, isShippingStatusEmail } from "./types";

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

// Some merchants put the product name straight in the subject:
// "Your Order for DeckUp Bei 4-Door Engineered Wood…". Capture it as the item.
const SUBJECT_ITEM_RE = /(?:your\s+)?order\s+for\s+(.+?)\s*$/i;

// Many merchants render a line-item table: a header, then "<name> <qty> <price>"
// rows, then a totals footer. Catches Dominos, Printo, Supertails, etc.
const TABLE_HEADER_RE =
  /Item\s+Name\s+Quantity\s+Price|Items?\s+Qty\s+Price|Items?\s+QTY\s+COST|Item\s+Quantity\s+Price(?:\s+Total)?|Item\s+Price/i;
const TABLE_FOOTER_RE =
  /Sub\s*-?\s*Total|Payment\s+details|Grand\s+Total|Total\s+(?:MRP|Amount|Paid)|\bTotal\s*:/i;
// Price ₹/Rs-prefixed …
const ROW_CURRENCY_RE = /(.+?)\s+(\d{1,3})\s+(?:Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/g;
// … or a bare decimal amount (Dominos: "Chicken … 1 500.00").
const ROW_DECIMAL_RE = /(.+?)\s+(\d{1,3})\s+([\d,]+\.\d{2})\b/g;

/** Line items from a "<header> … <name> <qty> <price> … <footer>" table. */
function itemsFromTable(text: string): OrderItem[] {
  const hAt = text.search(TABLE_HEADER_RE);
  if (hAt < 0) return [];
  const afterHeader = text.slice(hAt).replace(TABLE_HEADER_RE, "");
  const fAt = afterHeader.search(TABLE_FOOTER_RE);
  const block = (fAt >= 0 ? afterHeader.slice(0, fAt) : afterHeader).trim();
  if (!block) return [];

  for (const rowRe of [ROW_CURRENCY_RE, ROW_DECIMAL_RE]) {
    const items: OrderItem[] = [];
    rowRe.lastIndex = 0;
    for (let m = rowRe.exec(block); m; m = rowRe.exec(block)) {
      const name = decodeEntities(m[1]).replace(/^[\s·|,\-–—]+/, "").trim();
      if (name.length < 2) continue;
      items.push({ name, qty: parseInt(m[2], 10), price: parseInrAmount(m[3]) });
      if (items.length >= 40) break;
    }
    if (items.length) return items;
  }
  return [];
}

/** Best-effort single item from the subject line ("… order for <X>"). */
function itemsFromSubject(subject: string): OrderItem[] {
  const m = SUBJECT_ITEM_RE.exec(subject.trim());
  if (!m) return [];
  const name = m[1]
    .replace(/[.…\s]+$/, "")                 // trailing "…" truncation
    .replace(/\s+(?:has|is|was|from|#).*$/i, "")  // "… has shipped", "… #123"
    .trim();
  return name.length >= 2 ? [{ name }] : [];
}

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
  if (!ORDER_INTENT_RE.test(hay)) return null;

  const total = extractTotal(text);
  if (total == null) return null;

  // Item detail: a line-item table wins, else the subject ("… order for X").
  const items = itemsFromTable(text);
  if (items.length === 0) items.push(...itemsFromSubject(subject));

  // A shipping-status subject with NO detail is just a status ping → skip. But a
  // "delivered" email that carries a real item table IS the receipt (Supertails,
  // Instamart) — keep it.
  if (isShippingStatusEmail(subject) && items.length === 0) return null;

  return {
    source: "generic",
    kind: /\brefund(ed)?\b/i.test(subject) ? "refund" : "order",
    order_ref: ORDER_REF_RE.exec(hay)?.[1],
    merchant_name: merchantFromSender(sender),
    total_amount: total,
    items,
  };
}
