// Importer for Blinkit order history. Blinkit has NO order emails and NO public
// export, so the source is the JSON its own web app returns for your logged-in
// order history (captured via scripts/blinkit-fetch.ts or the browser DevTools
// Network tab). That JSON's exact shape isn't documented and may change, so this
// parser is deliberately SHAPE-TOLERANT: it hunts for order-like objects and
// reads item fields by common aliases. If it misses items on your real export,
// the fix is to add the observed key names to the alias lists below.

import type { OrderItem } from "../parsers/orders/types";
import type { ImportedOrder } from "./amazon-csv";

const ORDER_ARRAY_KEYS = ["orders", "order_list", "orderlist", "results", "data", "items"];
const ITEM_ARRAY_KEYS = ["items", "products", "cart_items", "order_items", "line_items", "productlist"];
const ID_KEYS = ["order_id", "orderid", "id", "cart_id", "order_number"];
const DATE_KEYS = ["created_at", "order_time", "placed_at", "order_date", "createdon", "timestamp"];
const TOTAL_KEYS = ["total", "grand_total", "order_total", "amount", "final_amount", "paid_amount", "bill_amount"];
const NAME_KEYS = ["name", "product_name", "title", "display_name", "item_name"];
const QTY_KEYS = ["quantity", "qty", "count", "units"];
const PRICE_KEYS = ["price", "total_price", "amount", "selling_price", "mrp", "unit_price", "final_price"];

const pick = (o: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of Object.keys(o)) if (keys.includes(k.toLowerCase())) return o[k];
  return undefined;
};
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v.replace(/[₹,\s]/g, "")) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** An object is "order-like" if it has an id AND an array of item-like children. */
function itemArrayOf(o: Record<string, unknown>): Record<string, unknown>[] | null {
  for (const k of Object.keys(o)) {
    if (!ITEM_ARRAY_KEYS.includes(k.toLowerCase())) continue;
    const v = o[k];
    if (Array.isArray(v) && v.some((x) => x && typeof x === "object" && pick(x as Record<string, unknown>, NAME_KEYS) != null)) {
      return v as Record<string, unknown>[];
    }
  }
  return null;
}

function toOrder(o: Record<string, unknown>): ImportedOrder | null {
  const itemsRaw = itemArrayOf(o);
  if (!itemsRaw) return null;
  const items: OrderItem[] = [];
  for (const it of itemsRaw) {
    const name = str(pick(it, NAME_KEYS));
    if (!name) continue;
    const item: OrderItem = { name };
    const q = num(pick(it, QTY_KEYS));
    const p = num(pick(it, PRICE_KEYS));
    if (q != null) item.qty = q;
    if (p != null) item.price = p;
    items.push(item);
  }
  if (items.length === 0) return null;
  const id = str(pick(o, ID_KEYS)) ?? String(pick(o, ID_KEYS) ?? "");
  const date = pick(o, DATE_KEYS);
  const d = date != null ? new Date(typeof date === "number" ? date : String(date)) : null;
  return {
    orderRef: id || `blinkit-${d?.getTime() ?? Math.random().toString(36).slice(2)}`,
    orderedAt: d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString(),
    merchant: "Blinkit",
    total: num(pick(o, TOTAL_KEYS)) ?? (items.reduce((s, i) => s + (i.price ?? 0), 0) || null),
    items,
  };
}

/** Walk any JSON, collecting every order-like object found. */
export function parseBlinkitOrders(json: unknown): ImportedOrder[] {
  const out: ImportedOrder[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const o = node as Record<string, unknown>;
    const order = toOrder(o);
    if (order) out.push(order);
    // Recurse regardless (nested envelopes: {data:{orders:[...]}}).
    for (const k of Object.keys(o)) {
      if (order && ITEM_ARRAY_KEYS.includes(k.toLowerCase())) continue; // don't re-walk this order's items as orders
      visit(o[k]);
    }
    void ORDER_ARRAY_KEYS;
  };
  visit(json);
  // De-dupe by orderRef (an order can be reachable by multiple paths).
  const byRef = new Map<string, ImportedOrder>();
  for (const o of out) if (!byRef.has(o.orderRef)) byRef.set(o.orderRef, o);
  return [...byRef.values()];
}
