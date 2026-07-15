// Importer for Amazon's official data export ("Request Your Information" →
// Your Orders → Retail.OrderHistory.1.csv). Pure + unit-tested; the DB write
// lives in scripts/import-amazon.ts. One CSV row = one item; rows sharing an
// Order ID collapse into one order with an items[] list — matching CardIQ's
// order shape so Amazon purchases the email parser never saw still land in the
// dashboard (and dedupe against email-sourced Amazon orders by order_ref).
//
// Column names drift across Amazon locales/exports, so headers are matched
// fuzzily by keyword rather than by exact string.

import type { OrderItem } from "../parsers/orders/types";

export type ImportedOrder = {
  orderRef: string;
  orderedAt: string; // ISO
  merchant: string;
  total: number | null;
  items: OrderItem[];
};

/** RFC-4180-ish CSV parse: handles quoted fields, escaped "" quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Find the index of the first header that contains ALL given keywords (case-insensitive). */
function col(headers: string[], ...keywords: string[]): number {
  return headers.findIndex((h) => {
    const hl = h.toLowerCase();
    return keywords.every((k) => hl.includes(k));
  });
}

function money(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = parseFloat(raw.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Best-effort ISO date from Amazon's varied date formats. */
function toIso(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Parse a Retail.OrderHistory CSV into CardIQ orders. `onlyCurrency` (default
 * "INR") drops foreign-currency rows so amounts stay comparable to the INR
 * transaction ledger; pass null to keep everything.
 */
export function parseAmazonOrderHistory(
  csvText: string,
  onlyCurrency: string | null = "INR"
): ImportedOrder[] {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());

  const iOrder = col(headers, "order", "id");
  const iDate = col(headers, "order", "date") >= 0 ? col(headers, "order", "date") : col(headers, "date");
  const iName = col(headers, "product", "name") >= 0 ? col(headers, "product", "name") : col(headers, "title");
  const iQty = col(headers, "quantity");
  const iUnit = [col(headers, "unit", "price"), col(headers, "per", "unit"), col(headers, "purchase", "price")].find((x) => x >= 0) ?? -1;
  const iItemTotal = [col(headers, "item", "subtotal"), col(headers, "item", "total"), col(headers, "total", "owed")].find((x) => x >= 0) ?? -1;
  const iCur = col(headers, "currency");
  if (iOrder < 0 || iName < 0) return []; // not a recognisable order-history CSV

  const byOrder = new Map<string, ImportedOrder>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const orderRef = (row[iOrder] ?? "").trim();
    const name = (row[iName] ?? "").trim();
    if (!orderRef || !name || /^(not available|not applicable|n\/a)$/i.test(name)) continue;
    if (onlyCurrency && iCur >= 0 && (row[iCur] ?? "").trim().toUpperCase() !== onlyCurrency) continue;

    const qty = iQty >= 0 ? parseInt(row[iQty], 10) : NaN;
    const unit = money(row[iUnit]);
    const itemTotal = money(row[iItemTotal]) ?? (unit != null && Number.isFinite(qty) ? unit * qty : unit);

    const item: OrderItem = { name };
    if (Number.isFinite(qty)) item.qty = qty;
    if (itemTotal != null) item.price = Math.round(itemTotal * 100) / 100;

    const existing = byOrder.get(orderRef);
    if (existing) {
      existing.items.push(item);
      if (item.price != null) existing.total = (existing.total ?? 0) + item.price;
    } else {
      byOrder.set(orderRef, {
        orderRef,
        orderedAt: toIso(row[iDate]) ?? new Date().toISOString(),
        merchant: "Amazon",
        total: item.price ?? null,
        items: [item],
      });
    }
  }
  return [...byOrder.values()];
}
