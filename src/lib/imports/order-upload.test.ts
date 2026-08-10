import { describe, expect, it } from "vitest";
import { isObsoleteAmazonDeliveryOrder, parseOrderUpload } from "./order-upload";

describe("parseOrderUpload", () => {
  it("accepts an Amazon order-history CSV and keeps all currencies from the supplied export", () => {
    const orders = parseOrderUpload("amazon",
      "Order Date,Order ID,Currency,Total Amount,Quantity,Product Name\n" +
      "2026-07-01T10:00:00Z,402-111,USD,12.50,1,Travel adaptor\n");

    expect(orders).toEqual([expect.objectContaining({
      orderRef: "402-111", merchant: "Amazon", total: 12.5,
    })]);
  });

  it("rejects a Blinkit file that is not JSON instead of silently importing nothing", () => {
    expect(() => parseOrderUpload("blinkit", "not JSON")).toThrow("isn't valid JSON");
  });

  it("uses Blinkit's full detail basket over its shortened history card", () => {
    const orders = parseOrderUpload("blinkit", JSON.stringify([
      { data: { orders: [{ order_id: "BLK-1", created_at: "2026-07-10T08:15:00Z", items: [{ name: "Milk" }] }] } },
      { response: { snippets: [
        { widget_type: "z_v3_image_text_snippet_type_30", data: { title: { text: "Milk" }, subtitle1: { text: "x 2" }, subtitle3: { text: "₹60" } }, tracking: { common_attributes: { order_id: "BLK-1", product_id: "1" } } },
        { widget_type: "z_v3_image_text_snippet_type_30", data: { title: { text: "Bread" }, subtitle1: { text: "x 1" }, subtitle3: { text: "₹45" } }, tracking: { common_attributes: { order_id: "BLK-1", product_id: "2" } } },
        { widget_type: "cart_bill_item", data: { left_header: { text: "Bill total" }, right_header: { text: "₹105" } } },
      ] } },
    ]));

    expect(orders).toEqual([expect.objectContaining({
      orderRef: "BLK-1", total: 105, items: [
        { name: "Milk", qty: 2, price: 60 }, { name: "Bread", qty: 1, price: 45 },
      ],
    })]);
  });

  it("hides only old Amazon delivery orders, never CSV orders or refunds", () => {
    expect(isObsoleteAmazonDeliveryOrder({ source: "amazon", kind: "order", gmail_message_id: "gmail-123" })).toBe(true);
    expect(isObsoleteAmazonDeliveryOrder({ source: "amazon", kind: "order", gmail_message_id: "amazon-csv:402-111" })).toBe(false);
    expect(isObsoleteAmazonDeliveryOrder({ source: "amazon", kind: "refund", gmail_message_id: "gmail-456" })).toBe(false);
  });
});
