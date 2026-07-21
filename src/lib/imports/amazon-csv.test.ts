import { describe, it, expect } from "vitest";
import { parseCsv, parseAmazonOrderHistory } from "./amazon-csv";

describe("parseCsv", () => {
  it("handles quoted fields with commas, escaped quotes, and newlines", () => {
    const rows = parseCsv('a,b,c\n"x, y","he said ""hi""","line1\nline2"\n');
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["x, y", 'he said "hi"', "line1\nline2"],
    ]);
  });
});

describe("parseAmazonOrderHistory", () => {
  // Shape of Amazon.in "Retail.OrderHistory.1.csv": one row per item, orders
  // spread across rows sharing an Order ID.
  const csv =
    "Order Date,Order ID,Currency,Unit Price,Item Subtotal,Quantity,Product Name\n" +
    '2024-03-01T10:00:00Z,402-111,INR,499.00,998.00,2,"Colgate Toothpaste, 200g (Pack of 2)"\n' +
    "2024-03-01T10:00:00Z,402-111,INR,150.00,150.00,1,Dettol Handwash\n" +
    "2024-04-15T09:30:00Z,402-222,INR,1200.00,1200.00,1,Prestige Kettle\n" +
    "2024-04-15T09:30:00Z,402-222,USD,20.00,20.00,1,Imported Gadget\n";

  const orders = parseAmazonOrderHistory(csv);

  it("groups rows into orders by Order ID", () => {
    expect(orders).toHaveLength(2);
    expect(orders.map((o) => o.orderRef)).toEqual(["402-111", "402-222"]);
  });

  it("collapses an order's item rows into one items[] with qty + line price", () => {
    const o = orders.find((o) => o.orderRef === "402-111")!;
    expect(o.items).toEqual([
      { name: "Colgate Toothpaste, 200g (Pack of 2)", qty: 2, price: 998 },
      { name: "Dettol Handwash", qty: 1, price: 150 },
    ]);
    expect(o.total).toBe(1148);
    expect(o.orderedAt).toBe("2024-03-01T10:00:00.000Z");
  });

  it("drops foreign-currency rows so INR totals stay clean (402-222 keeps only the INR item)", () => {
    const o = orders.find((o) => o.orderRef === "402-222")!;
    expect(o.items).toEqual([{ name: "Prestige Kettle", qty: 1, price: 1200 }]);
  });

  it("returns [] for a CSV that isn't an order-history export", () => {
    expect(parseAmazonOrderHistory("foo,bar\n1,2\n")).toEqual([]);
  });

  // Real Amazon.in export schema: "Shipment Item Subtotal" is a per-SHIPMENT
  // total repeated on every item row (here 123.97 = 54.99+33.99+34.99 across the
  // first three items). Summing it would triple-count → 528. The true per-item
  // charged figure is "Total Amount"; the order total must be their sum ≈ 305.62.
  // (order 114-7490334-2986640, 2026-07 export.)
  it("uses per-item Total Amount, not the repeated Shipment Item Subtotal", () => {
    const real =
      "Order Date,Order ID,Currency,Unit Price,Shipment Item Subtotal,Total Amount,Original Quantity,Product Name\n" +
      "2025-11-30T05:23:00Z,114-777,USD,54.99,123.97,60.01,1,Little Tikes Story Dream Machine\n" +
      "2025-11-30T05:23:00Z,114-777,USD,33.99,123.97,37.09,1,SEREED Baby Balance Bike\n" +
      "2025-11-30T05:23:00Z,114-777,USD,34.99,123.97,38.18,1,CMYK Wavelength Party Game\n" +
      "2025-11-30T05:23:00Z,114-777,USD,89.60,89.60,97.78,1,POLO RALPH LAUREN Sunglasses\n" +
      "2025-11-30T05:23:00Z,114-777,USD,66.49,66.49,72.56,1,Yoto Mini 2024 Edition\n";
    const [order] = parseAmazonOrderHistory(real, null);
    expect(order.items.map((i) => i.price)).toEqual([60.01, 37.09, 38.18, 97.78, 72.56]);
    expect(order.total).toBeCloseTo(305.62, 2);
    expect(order.total).not.toBeCloseTo(528, 0); // guards against the shipment-subtotal regression
  });
});
