import { describe, it, expect } from "vitest";
import { findBlinkitOrderTargets, mergeBlinkitOrders, parseBlinkitOrderDetails, parseBlinkitOrders } from "./blinkit-json";

describe("parseBlinkitOrders (shape-tolerant)", () => {
  // A plausible Blinkit-style envelope: {data:{orders:[{...items:[...]}]}}.
  const json = {
    data: {
      orders: [
        {
          order_id: "ORD700706538",
          created_at: "2026-07-10T08:15:00Z",
          grand_total: 512,
          items: [
            { product_name: "Amul Gold Milk 500ml", quantity: 2, price: 68 },
            { product_name: "Britannia Brown Bread", qty: 1, selling_price: 45 },
          ],
        },
        {
          order_id: "ORD700706999",
          order_time: 1752000000000,
          items: [{ name: "Surf Excel 1kg", count: 1, mrp: 220 }],
        },
      ],
    },
  };

  const orders = parseBlinkitOrders(json);

  it("finds both orders inside the nested envelope", () => {
    expect(orders.map((o) => o.orderRef).sort()).toEqual(["ORD700706538", "ORD700706999"]);
  });

  it("reads item name/qty/price via aliases (product_name/qty/selling_price)", () => {
    const o = orders.find((o) => o.orderRef === "ORD700706538")!;
    expect(o.items).toEqual([
      { name: "Amul Gold Milk 500ml", qty: 2, price: 68 },
      { name: "Britannia Brown Bread", qty: 1, price: 45 },
    ]);
    expect(o.total).toBe(512);
    expect(o.orderedAt).toBe("2026-07-10T08:15:00.000Z");
  });

  it("handles epoch-millis dates and falls back to summed total", () => {
    const o = orders.find((o) => o.orderRef === "ORD700706999")!;
    expect(o.items[0]).toEqual({ name: "Surf Excel 1kg", qty: 1, price: 220 });
    expect(o.total).toBe(220);
    expect(o.orderedAt).toBe(new Date(1752000000000).toISOString());
  });

  it("returns [] when no order-like objects are present", () => {
    expect(parseBlinkitOrders({ hello: "world", nums: [1, 2, 3] })).toEqual([]);
  });

  it("reads Blinkit's real order-history widget shape", () => {
    const orders = parseBlinkitOrders({
      response: { snippets: [{
        widget_type: "order_history_container_vr",
        data: { items: [
          {
            data: {
              subtitle: { text: "10 Jul, 8:15 AM" },
              left_underlined_subtitle: { text: "₹512.50" },
            },
            tracking: { common_attributes: { order_id: "BLK-700706538" } },
          },
          { data: { title: { text: "Order details" } } },
          { data: { horizontal_item_list: [
            { data: { image: { accessibility_text: { text: "Amul Gold Milk 500 ml" } } } },
            { data: { image: { accessibility_text: { text: "Britannia Brown Bread" } } } },
          ] } },
        ] },
      }] },
    }, new Date(2026, 6, 15, 12, 0, 0));

    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      orderRef: "BLK-700706538", merchant: "Blinkit", total: 512.5,
      items: [{ name: "Amul Gold Milk 500 ml" }, { name: "Britannia Brown Bread" }],
    });
    expect(new Date(orders[0].orderedAt).getFullYear()).toBe(2026);
    expect(new Date(orders[0].orderedAt).getMonth()).toBe(6);
    expect(new Date(orders[0].orderedAt).getDate()).toBe(10);
  });

  it("infers the preceding year for a future-looking no-year label", () => {
    const orders = parseBlinkitOrders({ response: { snippets: [{
      widget_type: "order_history_container_vr",
      data: { items: [
        { data: { subtitle: { text: "31 Dec, 9:00 PM" }, left_underlined_subtitle: { text: "₹99" } }, tracking: { common_attributes: { order_id: "BLK-OLD" } } },
        { data: {} },
        { data: { horizontal_item_list: [{ data: { image: { accessibility_text: { text: "Bananas" } } } }] } },
      ] },
    }] } }, new Date(2026, 0, 2, 12, 0, 0));
    expect(new Date(orders[0].orderedAt).getFullYear()).toBe(2025);
  });

  it("reads every product, paid price, quantity, total and placed time from an order-detail response", () => {
    const details = parseBlinkitOrderDetails({ is_success: true, response: { snippets: [
      { widget_type: "z_v3_image_text_snippet_type_30", data: { title: { text: "Nandini Paneer" }, subtitle1: { text: "200 g x 1" }, subtitle3: { text: "₹96" } }, tracking: { common_attributes: { order_id: "1883053579", product_id: "37076" } } },
      { widget_type: "z_v3_image_text_snippet_type_30", data: { title: { text: "Banana - Pack of 2" }, subtitle1: { text: "2 x 3 pcs x 2" }, subtitle3: { text: "~~ ₹118 ~~ ₹98" } }, tracking: { common_attributes: { order_id: "1883053579", product_id: "534991" } } },
      { widget_type: "cart_bill_item", data: { left_header: { text: "Bill total" }, right_header: { text: "₹946" } } },
      { widget_type: "v2_restaurant_card_vr_type_4", data: { title: { text: "Order placed" }, subtitle2: { text: "placed on Sun, 22 Mar'26, 9:37 AM" } } },
    ] } });
    expect(details).toEqual([{
      orderRef: "1883053579", merchant: "Blinkit", total: 946,
      orderedAt: new Date(2026, 2, 22, 9, 37, 0, 0).toISOString(),
      items: [{ name: "Nandini Paneer", qty: 1, price: 96 }, { name: "Banana - Pack of 2", qty: 2, price: 98 }],
    }]);
  });

  it("replaces a history tile's truncated products with full detail", () => {
    const merged = mergeBlinkitOrders(
      [{ orderRef: "1883053579", orderedAt: "2026-03-22T04:07:00.000Z", merchant: "Blinkit", total: 946, items: [{ name: "Nandini Paneer" }] }],
      [{ orderRef: "1883053579", orderedAt: "2026-03-22T04:07:00.000Z", merchant: "Blinkit", total: 946, items: [{ name: "Nandini Paneer" }, { name: "Orange Carrot", qty: 3, price: 45 }] }],
    );
    expect(merged[0].items).toHaveLength(2);
    expect(merged[0].items[1]).toEqual({ name: "Orange Carrot", qty: 3, price: 45 });
  });

  it("discovers order/cart pairs from tracking and detail-action URLs", () => {
    expect(findBlinkitOrderTargets({ response: { snippets: [
      { tracking: { common_attributes: { order_id: 1883053579, cart_id: 2871946693 } } },
      { data: { click_action: { fetch_api: { url: "v1/layout/order_details/1883053580?cart_id=2871946694" } } } },
    ] } })).toEqual([
      { orderId: "1883053579", cartId: "2871946693" },
      { orderId: "1883053580", cartId: "2871946694" },
    ]);
  });
});
