// IKEA order-invoice parser — operates on the TEXT extracted from IKEA's PDF
// ATTACHMENTS, not the email body. IKEA's order emails put nothing parseable in
// the HTML body ("Attached is a copy of your order"); every line item lives in
// a PDF invoice. See src/lib/gmail/pdf.ts for the download + text-extraction
// plumbing that feeds this parser.
//
// Verified against KP's real IKEA PDFs (sampled 2026-07-15). IKEA India emits
// THREE distinct invoice layouts over the years — this parser recognises all
// three and, per the "let the content self-select" pattern, tries each and
// keeps whichever yields items:
//
//   A. Modern GST invoice (2025–26) — "TaxInvoice" / "ReceiptVoucher" /
//      "CreditNote" PDFs. Columns run together in the extracted text as:
//        <#> <HSN> <ArtNo ddd.ddd.dd> <description> <qty> EA <IGST n %> \
//              <unit> <amount> [discount] <total>
//      Ends "Total: <amt> INR". A CreditNote is a RETURN — negative amounts.
//
//   B. Legacy POS "Sales invoice" (2023–24):
//        Item <art8> / HSN <hsn8> <description> ( <qty> EA * <unit>) <total> \
//              incl. CGST … SGST …
//      Ends "Total Amount Payable <amt> INR".
//
//   C. Order-confirmation "Goods Summary" (the _0.pdf on "Order confirmation"):
//        * <qty> <description> <ArtNo ddd.ddd.dd> <svc> <price> <total>
//      Pre-payment order form — no clean grand total, so we sum the line rows.

import {
  type OrderItem,
  type ParsedOrder,
  parseInrAmount,
  decodeEntities,
} from "./types";

/** Domain-anchored IKEA sender check (all IKEA mail flows through *.ikea.com). */
export function isIkeaSender(from: string): boolean {
  const addr = (/<([^<>\s]+@[^<>\s]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
  return addr.endsWith("@ikea.com") || addr.endsWith(".ikea.com");
}

// A single IKEA article number, e.g. 505.687.21 — the strongest row anchor in
// formats A and C.
const ART_NO = String.raw`\d{3}\.\d{3}\.\d{2}`;

/** Every money token in a string, e.g. "2,990.00" or "-11,041.50". */
function moneyTokens(s: string): number[] {
  return (s.match(/-?[\d,]+\.\d{2}/g) ?? []).map((m) => parseInrAmount(m));
}

/**
 * A quantity from a matched digit string. Uses an explicit NaN check (NOT
 * `parseInt(...) || undefined`) so a genuine `0`-qty row keeps qty:0 instead of
 * silently dropping the field. Magnitude only (credit-note rows carry "-1").
 */
function toQty(raw: string): number | undefined {
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? undefined : Math.abs(n);
}

/**
 * Tidy an IKEA description into a display name:
 *  - drop trailing discount annotations ("IKEA Family Savings: -200.00",
 *    "NBO Furniture 15%: -1,948.50") that the extractor glues onto the name,
 *  - drop the trailing " AP" pickup-location marker present on every modern row,
 *  - collapse whitespace / decode stray entities.
 */
function cleanName(raw: string): string {
  let s = raw.trim();
  // Trailing discount annotation. Anchor on the label keyword right before the
  // colon (Savings / Discount / "<n>%") so a long product description — which
  // never ends in those words — is never swallowed. Two seen forms:
  //   "IKEA Family Savings: -94.00"   "NBO Furniture 15%: -1,948.50"
  s = s.replace(/\s+(?:[A-Za-z]+ ){0,3}(?:Savings|Discount)\s*:\s*-[\d,]+\.\d{2}\s*$/i, "");
  s = s.replace(/\s+[A-Za-z][A-Za-z ]*\d+%\s*:\s*-[\d,]+\.\d{2}\s*$/i, "");
  // Trailing " AP" pickup marker (+ optional 2-letter country code: "AP JP").
  s = s.replace(/\s+AP(?:\s+[A-Z]{2})?$/, "");
  return decodeEntities(s).trim();
}

/**
 * Format A — modern GST invoice (TaxInvoice / ReceiptVoucher / CreditNote).
 *
 * Each row is matched SELF-CONTAINED: article no, then a non-greedy name up to
 * the quantity, the "<qty> EA", one-or-more tax tokens ("IGST 18 %" / "CGST 9 %
 * SGST 9 %"), then the 1–4 trailing money columns (unit, amount, [discount],
 * total). Anchoring the quantity to the tax token that ALWAYS follows it is what
 * makes the row self-contained — it needs no lookahead onto the next row or the
 * grand-total line, so a differently-worded total ("Grand Total"), a stray
 * earlier "Total:", or a single-item order can never starve a row of its
 * terminator (the failure mode that silently dropped whole orders / last items).
 * The trade-off: a row with no tax column won't match — but every real IKEA GST
 * row carries one.
 */
function parseFormatA(text: string): OrderItem[] {
  const items: OrderItem[] = [];
  const rowRe = new RegExp(
    `(${ART_NO})\\s+(.+?)\\s+(-?\\d+)\\s+EA\\s+` + // artNo, name, qty, "EA"
      `(?:(?:IGST|CGST|SGST|UTGST)\\s+[\\d.]+\\s*%\\s*)+` + // 1+ tax tokens
      `((?:-?[\\d,]+\\.\\d{2}\\s*){1,4})`, // 1–4 money columns
    "g"
  );
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(text)) !== null) {
    const name = cleanName(m[2]);
    if (!name) continue;
    const qty = toQty(m[3]);
    // Line total is the LAST money column (after any discount column).
    const nums = moneyTokens(m[4]);
    const price = nums.length ? Math.abs(nums[nums.length - 1]) : undefined;
    items.push({ name, ...(qty !== undefined ? { qty } : {}), ...(price != null ? { price } : {}) });
  }
  return items;
}

/** Format B — legacy POS "Sales invoice". */
function parseFormatB(text: string): OrderItem[] {
  const items: OrderItem[] = [];
  const rowRe =
    /Item\s+\d{6,}\s*\/\s*HSN\s+\d{6,}\s+(.+?)\s+\(\s*(\d+)\s+EA\s*\*\s*[\d,]+\.\d{2}\s*\)\s+([\d,]+\.\d{2})/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(text)) !== null) {
    const name = cleanName(m[1]);
    if (!name) continue;
    const qty = toQty(m[2]);
    const price = parseInrAmount(m[3]);
    items.push({ name, ...(qty !== undefined ? { qty } : {}), price });
  }
  return items;
}

/** Format C — order-confirmation "Goods Summary" (the _0.pdf). */
function parseFormatC(text: string): OrderItem[] {
  const items: OrderItem[] = [];
  // * <qty> <description> <ArtNo> <svc-letter> <price> <total> — prices here
  // carry no decimals ("11,042").
  const rowRe = new RegExp(
    `\\*\\s+(\\d+)\\s+(.+?)\\s+${ART_NO}\\s+[A-Z]\\s+([\\d,]+)\\s+([\\d,]+)\\b`,
    "g"
  );
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(text)) !== null) {
    const name = cleanName(m[2]);
    if (!name) continue;
    const qty = toQty(m[1]);
    const price = parseInrAmount(m[4]); // total column
    items.push({ name, ...(qty !== undefined ? { qty } : {}), price });
  }
  return items;
}

/**
 * Parse the text of ONE IKEA invoice PDF into a ParsedOrder, or null if the
 * text isn't a recognisable IKEA invoice (e.g. the delivery T&C PDF, which
 * carries no article rows). Callers pass every PDF attachment through this and
 * keep the richest result.
 */
export function parseIkeaPdf(rawText: string): ParsedOrder | null {
  if (!/IKEA/i.test(rawText)) return null;
  // Multi-page invoices interleave "Page N of M" markers into the text, which on
  // a page boundary can land mid-row (between the tax rate and the price
  // columns) and break a row match. Strip them before parsing.
  const text = rawText.replace(/Page\s+\d+\s+of\s+\d+/gi, " ");

  // Try each format; keep whichever recovered the most items.
  const candidates = [parseFormatA(text), parseFormatB(text), parseFormatC(text)];
  const items = candidates.reduce((best, c) => (c.length > best.length ? c : best), [] as OrderItem[]);
  if (items.length === 0) return null;

  // Order number, when the layout carries one.
  const order_ref =
    /Order No:\s*(\d+)/i.exec(text)?.[1] ??
    /Order Number:\s*(\d+)/i.exec(text)?.[1] ??
    undefined;

  // Grand total: explicit "Total[ Amount Payable]: <amt> INR" when present,
  // else the sum of the line totals (format C has no printed grand total).
  const explicit =
    /Total(?:\s+Amount\s+Payable)?:?\s*(-?[\d,]+\.\d{2})\s*INR/i.exec(text)?.[1];
  const explicitTotal = explicit != null ? parseInrAmount(explicit) : undefined;

  // A return/refund. The RELIABLE signal is a NEGATIVE total (every IKEA refund
  // layout carries negative line amounts); the "Credit Note" title is a second
  // signal for the one layout whose printed total isn't itself negative. We do
  // NOT match the bare word "refund" — it appears in the return-policy
  // boilerplate of ordinary purchase invoices, which would misbook a real
  // purchase as money-back (matching a DEBIT the wrong way).
  const isRefund =
    (explicitTotal != null && explicitTotal < 0) || /credit note/i.test(text);

  let total_amount: number | undefined;
  if (explicitTotal != null) {
    total_amount = Math.abs(explicitTotal);
  } else {
    const sum = items.reduce((a, it) => a + (it.price ?? 0), 0);
    total_amount = sum > 0 ? sum : undefined;
  }

  return {
    source: "ikea",
    kind: isRefund ? "refund" : "order",
    ...(order_ref ? { order_ref } : {}),
    merchant_name: "IKEA",
    ...(total_amount != null ? { total_amount } : {}),
    items,
  };
}
