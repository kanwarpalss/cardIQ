import { describe, it, expect } from "vitest";
import { parseBlinkitOrders } from "./blinkit-json";

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
});
