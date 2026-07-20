// Blinkit has no order emails or official export. This parser reads the JSON
// rendered by the logged-in order-history web view. Keep the exact widget
// parser separate from the older generic fallback: the former is grounded in
// Blinkit's observed response, while the latter preserves compatibility with
// any previously captured, conventional order JSON.

import type { OrderItem } from "../parsers/orders/types";
import type { ImportedOrder } from "./amazon-csv";

type JsonObject = Record<string, unknown>;
export type BlinkitOrderTarget = { orderId: string; cartId: string };

const ITEM_ARRAY_KEYS = ["items", "products", "cart_items", "order_items", "line_items", "productlist"];
const ID_KEYS = ["order_id", "orderid", "id", "cart_id", "order_number"];
const DATE_KEYS = ["created_at", "order_time", "placed_at", "order_date", "createdon", "timestamp"];
const TOTAL_KEYS = ["total", "grand_total", "order_total", "amount", "final_amount", "paid_amount", "bill_amount"];
const NAME_KEYS = ["name", "product_name", "title", "display_name", "item_name"];
const QTY_KEYS = ["quantity", "qty", "count", "units"];
const PRICE_KEYS = ["price", "total_price", "amount", "selling_price", "mrp", "unit_price", "final_price"];

const isObject = (value: unknown): value is JsonObject => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const asObjects = (value: unknown): JsonObject[] => Array.isArray(value) ? value.filter(isObject) : [];
const pick = (o: JsonObject, keys: string[]): unknown => {
  for (const k of Object.keys(o)) if (keys.includes(k.toLowerCase())) return o[k];
  return undefined;
};
const str = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const id = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return str(value);
};
const textAt = (value: unknown): string | undefined => isObject(value) ? str(value.text) : undefined;
const num = (value: unknown): number | undefined => {
  const n = typeof value === "number" ? value : typeof value === "string" ? parseFloat(value.replace(/[^0-9.\-]/g, "")) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Blinkit's order date label has no year (e.g. "10 Jul, 8:15 AM"). */
function parseDisplayDate(label: string | undefined, now: Date): string | undefined {
  if (!label) return undefined;
  const direct = new Date(label);
  if (!Number.isNaN(direct.getTime()) && /\b\d{4}\b/.test(label)) return direct.toISOString();

  const today = /^today(?:,|\s)+(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(label.trim());
  const yesterday = /^yesterday(?:,|\s)+(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(label.trim());
  const dated = /\b(\d{1,2})\s+([a-z]{3,9})(?:,|\s)+(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(label);
  let candidate: Date;
  if (today || yesterday) {
    const match = today ?? yesterday!;
    candidate = new Date(now);
    if (yesterday) candidate.setDate(candidate.getDate() - 1);
    candidate.setHours(Number(match[1]), Number(match[2]), 0, 0);
    if (match[3]) candidate.setHours((candidate.getHours() % 12) + (match[3].toLowerCase() === "pm" ? 12 : 0));
  } else if (dated) {
    const month = new Date(`${dated[2]} 1, 2000`).getMonth();
    if (Number.isNaN(month)) return undefined;
    let hour = Number(dated[3]);
    if (dated[5]) hour = (hour % 12) + (dated[5].toLowerCase() === "pm" ? 12 : 0);
    candidate = new Date(now.getFullYear(), month, Number(dated[1]), hour, Number(dated[4]), 0, 0);
    // An order-history entry cannot be in the future. January's history may
    // legitimately contain last December, hence the year rollover.
    if (candidate.getTime() > now.getTime() + 60_000) candidate.setFullYear(candidate.getFullYear() - 1);
  } else return undefined;
  return candidate.toISOString();
}

function widgetOrder(snippet: JsonObject, now: Date): ImportedOrder | null {
  if (snippet.widget_type !== "order_history_container_vr") return null;
  const data = isObject(snippet.data) ? snippet.data : null;
  const cells = asObjects(data?.items);
  const header = isObject(cells[0]?.data) ? cells[0].data : null;
  const tracking = isObject(cells[0]?.tracking) ? cells[0].tracking : null;
  const common = isObject(tracking?.common_attributes) ? tracking.common_attributes : null;
  const orderRef = str(common?.order_id);
  if (!orderRef) return null; // Never invent an import identity; upserts need a stable key.

  const itemsCell = cells.find((cell) => isObject(cell.data) && Array.isArray((cell.data as JsonObject).horizontal_item_list));
  const rawItems = asObjects((itemsCell?.data as JsonObject | undefined)?.horizontal_item_list);
  const names = rawItems
    .map((item) => textAt((isObject(item.data) ? item.data : {}).image && isObject((item.data as JsonObject).image)
      ? ((item.data as JsonObject).image as JsonObject).accessibility_text
      : undefined))
    .filter((name): name is string => Boolean(name));
  const uniqueNames = [...new Set(names)];
  if (uniqueNames.length === 0) return null;

  return {
    orderRef,
    orderedAt: parseDisplayDate(textAt(header?.subtitle), now) ?? now.toISOString(),
    merchant: "Blinkit",
    total: num(textAt(header?.left_underlined_subtitle)) ?? null,
    items: uniqueNames.map((name) => ({ name })),
  };
}

function widgetOrders(json: unknown, now: Date): ImportedOrder[] {
  const found: ImportedOrder[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const object = node as JsonObject;
    const order = widgetOrder(object, now);
    if (order) found.push(order);
    Object.values(object).forEach(visit);
  };
  visit(json);
  return found;
}

/** Legacy fallback for conventional captured order JSON. */
function itemArrayOf(o: JsonObject): JsonObject[] | null {
  for (const key of Object.keys(o)) {
    if (!ITEM_ARRAY_KEYS.includes(key.toLowerCase())) continue;
    const value = asObjects(o[key]);
    if (value.some((item) => pick(item, NAME_KEYS) != null)) return value;
  }
  return null;
}

function conventionalOrder(o: JsonObject): ImportedOrder | null {
  const itemsRaw = itemArrayOf(o);
  if (!itemsRaw) return null;
  const items: OrderItem[] = itemsRaw.flatMap((item) => {
    const name = str(pick(item, NAME_KEYS));
    if (!name) return [];
    const parsed: OrderItem = { name };
    const quantity = num(pick(item, QTY_KEYS));
    const price = num(pick(item, PRICE_KEYS));
    if (quantity != null) parsed.qty = quantity;
    if (price != null) parsed.price = price;
    return [parsed];
  });
  const id = str(pick(o, ID_KEYS));
  const date = pick(o, DATE_KEYS);
  const parsedDate = date != null ? new Date(typeof date === "number" ? date : String(date)) : null;
  if (!id || items.length === 0) return null;
  return {
    orderRef: id,
    orderedAt: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : new Date().toISOString(),
    merchant: "Blinkit",
    total: num(pick(o, TOTAL_KEYS)) ?? (items.reduce((sum, item) => sum + (item.price ?? 0), 0) || null),
    items,
  };
}

function conventionalOrders(json: unknown): ImportedOrder[] {
  const found: ImportedOrder[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const object = node as JsonObject;
    const order = conventionalOrder(object);
    if (order) found.push(order);
    Object.values(object).forEach(visit);
  };
  visit(json);
  return found;
}

/** Parse one response or an array of paginated order-history responses. */
export function parseBlinkitOrders(json: unknown, now = new Date()): ImportedOrder[] {
  const byRef = new Map<string, ImportedOrder>();
  // Prefer the real widget representation if both it and a nested legacy-like
  // structure occur in one capture. Its items are what Blinkit actually shows.
  for (const order of [...widgetOrders(json, now), ...conventionalOrders(json)]) {
    if (!byRef.has(order.orderRef)) byRef.set(order.orderRef, order);
  }
  return [...byRef.values()];
}

/** The full-order page exposes every product as its own detail snippet. */
function detailOrderFromResponse(response: JsonObject): ImportedOrder | null {
  const snippets = asObjects(response.snippets);
  const productSnippets = snippets.filter((snippet) => {
    const data = isObject(snippet.data) ? snippet.data : null;
    const tracking = isObject(snippet.tracking) ? snippet.tracking : null;
    const common = isObject(tracking?.common_attributes) ? tracking.common_attributes : null;
    return snippet.widget_type === "z_v3_image_text_snippet_type_30" && Boolean(textAt(data?.title)) && Boolean(common?.product_id);
  });
  const firstTracking = isObject(productSnippets[0]?.tracking) ? productSnippets[0].tracking : null;
  const firstCommon = isObject(firstTracking?.common_attributes) ? firstTracking.common_attributes : null;
  const orderRef = str(firstCommon?.order_id);
  if (!orderRef || productSnippets.length === 0) return null;

  const items: OrderItem[] = productSnippets.map((snippet) => {
    const data = snippet.data as JsonObject;
    const name = textAt(data.title)!;
    const quantityLabel = textAt(data.subtitle1);
    const quantities = [...(quantityLabel?.matchAll(/\bx\s*(\d+(?:\.\d+)?)/gi) ?? [])];
    // Blinkit uses labels such as "2 x 3 pcs x 2"; the LAST multiplier is
    // how many sellable packs were ordered, while earlier numbers describe the
    // pack itself.
    const qty = quantities.length ? Number(quantities[quantities.length - 1][1]) : undefined;
    const prices = [...(textAt(data.subtitle3)?.matchAll(/₹\s*([\d,]+(?:\.\d{1,2})?)/g) ?? [])];
    // Discounted lines contain both struck-through MRP and paid price. The
    // rightmost rupee amount is the amount actually paid for this line.
    const price = prices.length ? num(prices[prices.length - 1][1]) : undefined;
    return { name, ...(qty != null && Number.isFinite(qty) ? { qty } : {}), ...(price != null ? { price } : {}) };
  });

  const bill = snippets.find((snippet) => {
    const data = isObject(snippet.data) ? snippet.data : null;
    return snippet.widget_type === "cart_bill_item" && textAt(data?.left_header)?.toLowerCase() === "bill total";
  });
  const billData = isObject(bill?.data) ? bill.data : null;
  const total = num(textAt(billData?.right_header)) ?? (items.reduce((sum, item) => sum + (item.price ?? 0), 0) || null);

  const placed = snippets.find((snippet) => textAt((isObject(snippet.data) ? snippet.data : {}).title)?.toLowerCase() === "order placed");
  const placedText = textAt((isObject(placed?.data) ? placed.data : {}).subtitle2);
  const dateMatch = /placed on (?:[a-z]+,\s*)?(\d{1,2})\s+([a-z]{3})'?(\d{2,4}),\s*(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(placedText ?? "");
  let orderedAt = new Date().toISOString();
  if (dateMatch) {
    const month = new Date(`${dateMatch[2]} 1, 2000`).getMonth();
    const year = dateMatch[3].length === 2 ? 2000 + Number(dateMatch[3]) : Number(dateMatch[3]);
    const hour = (Number(dateMatch[4]) % 12) + (dateMatch[6].toLowerCase() === "pm" ? 12 : 0);
    orderedAt = new Date(year, month, Number(dateMatch[1]), hour, Number(dateMatch[5]), 0, 0).toISOString();
  }
  return { orderRef, orderedAt, merchant: "Blinkit", total, items };
}

/** Parse one detail response, or an array of captured detail responses. */
export function parseBlinkitOrderDetails(json: unknown): ImportedOrder[] {
  const found: ImportedOrder[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const object = node as JsonObject;
    if (isObject(object.response)) {
      const order = detailOrderFromResponse(object.response);
      if (order) found.push(order);
    }
    Object.values(object).forEach(visit);
  };
  visit(json);
  return [...new Map(found.map((order) => [order.orderRef, order])).values()];
}

/** Detail responses replace the truncated history-card line items by order id. */
export function mergeBlinkitOrders(history: ImportedOrder[], details: ImportedOrder[]): ImportedOrder[] {
  const detailByRef = new Map(details.map((order) => [order.orderRef, order]));
  const merged = history.map((order) => detailByRef.get(order.orderRef) ?? order);
  const historyRefs = new Set(history.map((order) => order.orderRef));
  return [...merged, ...details.filter((order) => !historyRefs.has(order.orderRef))];
}

/** Find the order/cart pairs required by Blinkit's full-detail endpoint. */
export function findBlinkitOrderTargets(json: unknown): BlinkitOrderTarget[] {
  const found = new Map<string, BlinkitOrderTarget>();
  const add = (orderId: unknown, cartId: unknown) => {
    const order = id(orderId), cart = id(cartId);
    if (order && cart) found.set(`${order}\u0000${cart}`, { orderId: order, cartId: cart });
  };
  const fromUrl = (raw: unknown) => {
    if (typeof raw !== "string" || !raw.includes("v1/layout/order_details/")) return;
    try {
      const url = new URL(raw, "https://blinkit.com");
      const match = /\/v1\/layout\/order_details\/([^/?#]+)/.exec(url.pathname);
      if (match) add(decodeURIComponent(match[1]), url.searchParams.get("cart_id"));
    } catch { /* Ignore unrelated malformed action URLs. */ }
  };
  const seen = new Set<unknown>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const object = node as JsonObject;
    add(object.order_id, object.cart_id);
    Object.values(object).forEach((value) => { fromUrl(value); visit(value); });
  };
  visit(json);
  return [...found.values()];
}
