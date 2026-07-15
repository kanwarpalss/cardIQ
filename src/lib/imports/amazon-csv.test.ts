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
});
