// Shared parsing boundary for the Orders upload endpoint. Keeping this pure
// means the browser route and its tests agree on exactly what a valid export is.

import { parseAmazonOrderHistory, type ImportedOrder } from "./amazon-csv";
import { mergeBlinkitOrders, parseBlinkitOrderDetails, parseBlinkitOrders } from "./blinkit-json";

export type OrderUploadSource = "amazon" | "blinkit";

/** Old Amazon Delivered emails are deliberately not ledger orders anymore.
 * CSV imports use this stable synthetic identity, so they remain visible. */
export function isObsoleteAmazonDeliveryOrder(order: {
  source?: unknown;
  kind?: unknown;
  gmail_message_id?: unknown;
}): boolean {
  return order.source === "amazon" && order.kind === "order"
    && (typeof order.gmail_message_id !== "string" || !order.gmail_message_id.startsWith("amazon-csv:"));
}

export function parseOrderUpload(
  source: OrderUploadSource,
  contents: string,
  now = new Date()
): ImportedOrder[] {
  if (source === "amazon") return parseAmazonOrderHistory(contents, null);

  let payload: unknown;
  try {
    payload = JSON.parse(contents);
  } catch {
    throw new Error("That Blinkit file isn't valid JSON.");
  }

  // A collector capture can contain history cards, detail responses, or both.
  // Detail responses win because they carry the full basket.
  return mergeBlinkitOrders(
    parseBlinkitOrders(payload, now),
    parseBlinkitOrderDetails(payload)
  );
}
