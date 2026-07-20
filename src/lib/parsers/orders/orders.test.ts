// Regression tests for order-email parsers (V2 feature C).
//
// Fixtures are condensed from REAL emails in KP's Gmail (sampled 2026-07-11):
//   swiggy    — "Your Swiggy order was successfully delivered", 2026-07-06
//   zomato    — "Your Zomato order from YUKI", 2026-06-22
//   bigbasket — "Your bigbasket order confirmation ( BNN-… )", 2026-07-03
//   amazon    — refund + Delivered subjects, 2026-07-02..11
// The amounts/ids in assertions are the real ones — if a parser change
// breaks any of these, it breaks on production data by definition.

import { describe, it, expect } from "vitest";
import { parseSwiggyOrder } from "./swiggy";
import { parseZomatoOrder } from "./zomato";
import { parseBigbasketOrder } from "./bigbasket";
import { parseAmazonOrder } from "./amazon";
import { parseOrderEmail } from "./registry";

// ── Swiggy ──────────────────────────────────────────────────────────────────

const SWIGGY_SUBJECT = "Your Swiggy order was successfully delivered";
const SWIGGY_TEXT =
  "₹216 saved on this order ₹36 saved with Swiggy ₹180 saved with Promotional Savings " +
  "ORDER JOURNEY Third Wave Coffee Shop No. 3 & 4, 49, Sahaney Sujan Park, Lulla Nagar, Pune, Maharashtra Jul 6, 10:20 AM " +
  "Ma 402, Building A6, Wanowrie, Pune Jul 6, 10:50 AM Order ID: 242283010812320 " +
  "BILL DETAILS Hot Latte [Regular] x2 ₹478 With Milk (₹0) Restaurant Packaging ₹35.00 " +
  "Platform fee with GST ₹17.58 Discount Applied - ₹180.00 Delivery Fee (FREE with Swiggy One) ₹36 FREE " +
  "Taxes ₹14.90 Paid Via Credit/Debit card ₹365.00 Disclaimer: Attached is the invoice";
const SWIGGY_HTML = `
  <p style="margin: 0 12px 16px 12px; color: #02060C73; font-weight: 700;">ORDER JOURNEY</p>
  <p style="margin: 0;color: #02060CBF;font-size: 12px;font-weight: 700;line-height: 19px;">Third Wave Coffee</p>
  <p style="margin: 1px 0 0;">Shop No. 3 &amp; 4, 49, Sahaney Sujan Park, Lulla Nagar, Pune</p>
  <p style="margin: 0;color: #02060CBF;font-size: 12px;font-weight: 700;">Ma</p>
  <span>Order ID: <span>242283010812320</span></span>
  <div style="font-weight:700;">BILL DETAILS</div>
  <tr><td style="padding:8px 16px; font-size:14px;">Hot Latte [Regular] x2</td><td></td>
  <td align="right" style="padding:8px 16px;"><span>₹478</span></td></tr>
  <tr><td><div style="padding:4px 8px;">With Milk (₹0)</div></td></tr>
  <tr><td style="padding:8px 16px;">Restaurant Packaging</td><td></td><td align="right"><span>₹35.00</span></td></tr>
  <tr><td style="padding:8px 16px;">Paid Via Credit/Debit card</td><td></td><td align="right"><span>₹365.00</span></td></tr>`;

describe("parseSwiggyOrder", () => {
  const order = parseSwiggyOrder(SWIGGY_SUBJECT, SWIGGY_TEXT, SWIGGY_HTML);

  it("parses the real 2026-07-06 delivered email", () => {
    expect(order).not.toBeNull();
    expect(order!.source).toBe("swiggy");
    expect(order!.kind).toBe("order");
    expect(order!.order_ref).toBe("242283010812320");
  });

  it("total is the PAID amount (₹365), never the item subtotal (₹478)", () => {
    expect(order!.total_amount).toBe(365);
  });

  it("extracts restaurant from the ORDER JOURNEY block, not the delivery address", () => {
    expect(order!.merchant_name).toBe("Third Wave Coffee");
  });

  it("extracts items with qty and price, skipping addons and fee rows", () => {
    expect(order!.items).toEqual([{ name: "Hot Latte [Regular]", qty: 2, price: 478 }]);
  });

  it("returns null for Swiggy emails without a paid amount (promos)", () => {
    expect(parseSwiggyOrder("Craving something?", "50% off today only", "")).toBeNull();
  });

  it("accepts the Swiggy Gourmet subject variant", () => {
    const g = parseSwiggyOrder(
      "Your Swiggy Gourmet order was delivered superfast",
      "Order ID: 111222333444555 BILL DETAILS Sushi Box x1 ₹1200 Paid Via UPI ₹1,234.56",
      ""
    );
    expect(g).not.toBeNull();
    expect(g!.total_amount).toBe(1234.56);
  });
});

// Format B — the COMMON "Your Order Summary" text-table template. Real email
// (Corner House Ice Cream, 2024-07-06). Had ZERO items until the text fallback:
// its item list, restaurant and order-ref live in plain text, not the HTML the
// Format-A parser reads. This block fails on the pre-fix parser.
describe("parseSwiggyOrder — Format B (Order Summary text table)", () => {
  const TEXT =
    "Greetings from Swiggy Your order was delivered in 36 minutes! Order No: 179253759225214 " +
    "Restaurant Corner House Ice Cream Your Order Summary: Order No: 179253759225214 " +
    "Order placed at: Saturday, July 6, 2024 10:12 PM Order Status: Delivered " +
    "Ordered from: Corner House Ice Cream GROUND FLOOR, BROOKE FIELD MALL " +
    "Item Name Quantity Price Cafe Caramel 1 ₹ 200 Death By Chocolate 1 ₹ 230 " +
    "Item Total: ₹ 430.00 Platform fee: ₹ 5.00 Taxes: ₹ 78.30 " +
    "Paid Via Credit/Debit card: ₹ 563.00 Order Total: ₹ 563";
  const o = parseSwiggyOrder("Your Swiggy order was delivered before time", TEXT, "");

  it("parses with the paid card amount as total", () => {
    expect(o).not.toBeNull();
    expect(o!.total_amount).toBe(563);
  });
  it("extracts every item with qty + price from the text table", () => {
    expect(o!.items).toEqual([
      { name: "Cafe Caramel", qty: 1, price: 200 },
      { name: "Death By Chocolate", qty: 1, price: 230 },
    ]);
  });
  it("reads the restaurant name from the text label", () => {
    expect(o!.merchant_name).toBe("Corner House Ice Cream");
  });
  it("reads the order ref from 'Order No:'", () => {
    expect(o!.order_ref).toBe("179253759225214");
  });
});

// ── Zomato ──────────────────────────────────────────────────────────────────

const ZOMATO_SUBJECT = "Your Zomato order from YUKI";
const ZOMATO_TEXT =
  "Hi Kanwar Pal Singh, Thank you for ordering from YUKI ORDER ID: 8266257923 Delivered YUKI " +
  "71/1A, Khatha 1707, 3rd Floor, PLR Square, Sarjapur Road, Bangalore 1 X Volcano Roll. " +
  "Total paid - ₹747.33 Eternal employees or representatives will NEVER ask you";
const ZOMATO_HTML = `
  <p style="line-height:24px;color:#333;font-size:16px;">1 X Volcano Roll.</p>
  <p><strong>Total paid - ₹747.33</strong></p>`;

describe("parseZomatoOrder", () => {
  const order = parseZomatoOrder(ZOMATO_SUBJECT, ZOMATO_TEXT, ZOMATO_HTML);

  it("parses the real 2026-06-22 YUKI email", () => {
    expect(order).not.toBeNull();
    expect(order!.source).toBe("zomato");
    expect(order!.order_ref).toBe("8266257923");
    expect(order!.total_amount).toBe(747.33);
  });

  it("restaurant comes from the subject line", () => {
    expect(order!.merchant_name).toBe("YUKI");
  });

  it("items get name + qty (Zomato sends no per-item prices)", () => {
    expect(order!.items).toEqual([{ name: "Volcano Roll", qty: 1 }]);
  });

  it("parses multiple items from stripped text when no HTML (stored-body reparse path)", () => {
    const o = parseZomatoOrder(
      "Your Zomato order from Haka",
      "Thank you for ordering from Haka ORDER ID: 8175309364 1 X Sweet Corn Soup Chicken 1 X Veg Hakka Noodles Total paid - ₹612.45",
      ""
    );
    expect(o!.items).toEqual([
      { name: "Sweet Corn Soup Chicken", qty: 1 },
      { name: "Veg Hakka Noodles", qty: 1 },
    ]);
  });

  it("returns null for non-order Zomato emails (promos, rating nags)", () => {
    expect(parseZomatoOrder("How was YUKI?", "Rate your recent order", "")).toBeNull();
  });
});

// ── BigBasket ───────────────────────────────────────────────────────────────

const BB_SUBJECT = "Your bigbasket order confirmation ( BNN-2032973738-20260703 )";
const BB_TEXT =
  "BigBasket.com Dear Kanwar Pal Singh, Thank you for your order at bigbasket Order No: BNN-2032973738-20260703 " +
  "Your order will be delivered to this address: Delivery slot: Fri, 03 Jul 2026 " +
  "Sl No. Item Details Qty. Unit Price Sub Total Savings CHILLED ITEMS " +
  "1 Nandini Curd 500 g 1.0 Rs. 28.00 Rs. 28.00 Rs. 0.0 " +
  "2 Akshayakalpa Organic Cow Milk - Pasteurized 500 ml 1.0 Rs. 45.00 Rs. 45.00 Rs. 0.0 " +
  "Bakery, Cakes & Dairy 1 Nandini GoodLife Toned Milk 500 ml 8.0 Rs. 32.00 Rs. 256.00 Rs. 0.0 " +
  "Sub Total: Rs. 482.84 Final Total: Rs. 0.00 Happy shopping! Team bigbasket";
const BB_HTML = `
  <a style="text-decoration:none;" href="https://www.bigbasket.com/pd/40149830/?utm_source=bigbasket">Nandini Curd 500 g </a>
  <a style="text-decoration:none;" href="https://www.bigbasket.com/pd/40148723/?utm_source=bigbasket">Akshayakalpa Organic Cow Milk - Pasteurized 500 ml </a>
  <a style="text-decoration:none;" href="https://www.bigbasket.com/pd/242671/?utm_source=bigbasket">Nandini GoodLife Toned Milk 500 ml </a>`;

describe("parseBigbasketOrder", () => {
  const order = parseBigbasketOrder(BB_SUBJECT, BB_TEXT, BB_HTML);

  it("parses the real 2026-07-03 confirmation email", () => {
    expect(order).not.toBeNull();
    expect(order!.source).toBe("bigbasket");
    expect(order!.order_ref).toBe("BNN-2032973738-20260703");
  });

  it("falls back to Sub Total when Final Total is BigBasket's broken 0.00", () => {
    expect(order!.total_amount).toBe(482.84);
  });

  it("extracts items with decimal qty and line subtotal", () => {
    expect(order!.items).toContainEqual({ name: "Nandini Curd 500 g", qty: 1, price: 28 });
    expect(order!.items).toContainEqual({ name: "Nandini GoodLife Toned Milk 500 ml", qty: 8, price: 256 });
    expect(order!.items).toHaveLength(3);
  });

  it("uses Final Total when it is a real amount", () => {
    const o = parseBigbasketOrder(
      "Your bigbasket order confirmation ( BNN-1-2 )",
      "Order No: BNN-1-2 Sub Total: Rs. 400.00 Final Total: Rs. 425.50",
      ""
    );
    expect(o!.total_amount).toBe(425.5);
  });

  it("returns null for delivery notices and marketing", () => {
    expect(parseBigbasketOrder("Your order is delivered", "Your order BNN-1-2 is delivered.", "")).toBeNull();
    expect(parseBigbasketOrder("These fruits won't wait, bigbasketeer", "Season ending soon", "")).toBeNull();
  });
});

// ── Amazon ──────────────────────────────────────────────────────────────────

describe("parseAmazonOrder", () => {
  it("parses the real refund email (amount + order ref, kind=refund)", () => {
    const o = parseAmazonOrder(
      "Refund on order 404-8063799-7205955",
      "Dear Customer, Greetings from Amazon.in We are writing to confirm that your refund for ₹69.42 has been processed for your Order # 404-8063799-7205955. This refund is for the following items",
      ""
    );
    expect(o).not.toBeNull();
    expect(o!.kind).toBe("refund");
    expect(o!.total_amount).toBe(69.42);
    expect(o!.order_ref).toBe("404-8063799-7205955");
  });

  it("parses the real Delivered subject into an amount-less item-only order", () => {
    const o = parseAmazonOrder("Delivered: “Emwel Dog Food Mat,...”", "Your package was delivered.", "");
    expect(o).not.toBeNull();
    expect(o!.kind).toBe("order");
    expect(o!.total_amount).toBeUndefined();
    expect(o!.items).toEqual([{ name: "Emwel Dog Food Mat" }]);
  });

  it("returns null for review nags, returns, and shipping updates", () => {
    expect(parseAmazonOrder("Kanwar Pal Singh, ever wonder if your reviews are getting noticed?", "Keep it up by reviewing", "")).toBeNull();
    expect(parseAmazonOrder("Your return for Amazon order 403-9355363-6889110", "You were then granted a refund. Please note that it takes 3-5 days", "")).toBeNull();
    expect(parseAmazonOrder("Shipped: “TIENER Glass Pitcher”", "Arriving tomorrow", "")).toBeNull();
  });
});

// ── Registry routing ────────────────────────────────────────────────────────

describe("parseOrderEmail (registry)", () => {
  it("routes by sender domain", () => {
    expect(parseOrderEmail("noreply@swiggy.in", SWIGGY_SUBJECT, SWIGGY_TEXT, SWIGGY_HTML)?.source).toBe("swiggy");
    expect(parseOrderEmail("Zomato <noreply@zomato.com>", ZOMATO_SUBJECT, ZOMATO_TEXT, ZOMATO_HTML)?.source).toBe("zomato");
    expect(parseOrderEmail("alerts@bigbasket.com", BB_SUBJECT, BB_TEXT, BB_HTML)?.source).toBe("bigbasket");
  });

  it("marketing sender alert@info.bigbasket.com does NOT route to the bigbasket parser", () => {
    expect(parseOrderEmail("alert@info.bigbasket.com", BB_SUBJECT, BB_TEXT, BB_HTML)).toBeNull();
  });

  it("unknown senders return null", () => {
    expect(parseOrderEmail("newsletters-noreply@linkedin.com", "Amazon goes for the quick commerce pie", "…", "")).toBeNull();
  });
});

// ── Boundary-prover regressions (2026-07-11) ────────────────────────────────
// Every test in this block FAILED on the first implementation — they encode
// real silent-wrong-answer bugs, not synthetic edge cases. TEST-01 compliant.

describe("parseSwiggyOrder — split payments (boundary-prover)", () => {
  it("preserves the whole split while identifying the direct-card portion", () => {
    const text =
      "Order ID: 242283010812320 BILL DETAILS " +
      "Paid Via Swiggy Money ₹50.00 Paid Via Credit/Debit card ₹315.00";
    const o = parseSwiggyOrder("Your Swiggy order was successfully delivered", text, "");
    expect(o).toMatchObject({
      total_amount: 365,
      card_paid_amount: 315,
      voucher_paid_amount: 50,
      voucher_brand: "Swiggy Money",
    });
  });

  it("falls back to the LAST 'Paid Via' line when none mentions a card", () => {
    const text = "Order ID: 111 BILL DETAILS Paid Via Swiggy Money ₹50.00 Paid Via UPI ₹315.00";
    const o = parseSwiggyOrder("Your Swiggy order was successfully delivered", text, "");
    expect(o!.total_amount).toBe(365);
    expect(o!.voucher_paid_amount).toBe(50);
  });

  it("handles lakh-separator totals (₹1,23,456.78)", () => {
    const text = "Order ID: 111222 BILL DETAILS Paid Via Credit/Debit card ₹1,23,456.78";
    const o = parseSwiggyOrder("Your Swiggy order was successfully delivered", text, "");
    expect(o!.total_amount).toBe(123456.78);
  });
});

describe("parseSwiggyOrder — cancelled orders (boundary-prover)", () => {
  it("does not parse a cancelled/refunded email as a normal paid order", () => {
    const o = parseSwiggyOrder(
      "Your Swiggy order was cancelled and refunded",
      "Order ID: 242283010812320 BILL DETAILS Paid Via Credit/Debit card ₹365.00",
      ""
    );
    expect(o).toBeNull();
  });
});

describe("parseBigbasketOrder — zero total (boundary-prover)", () => {
  it("a genuinely free order (both totals ₹0.00) is recorded, not dropped", () => {
    const o = parseBigbasketOrder(
      "Your bigbasket order confirmation ( BNN-1-2 )",
      "Order No: BNN-1-2 Sub Total: Rs. 0.00 Final Total: Rs. 0.00",
      ""
    );
    expect(o).not.toBeNull();
    expect(o!.total_amount).toBe(0);
  });

  it("still rejects confirmation-shaped emails where NO total line parses", () => {
    const o = parseBigbasketOrder(
      "Your bigbasket order confirmation ( BNN-1-2 )",
      "Order No: BNN-1-2 — totals arriving separately",
      ""
    );
    expect(o).toBeNull();
  });
});

describe("parseAmazonOrder — refund resilience (boundary-prover)", () => {
  it("a refund amount survives a short/odd order number", () => {
    const o = parseAmazonOrder(
      "Refund on order 123456",
      "your refund for ₹69.42 has been processed for your Order # 123456",
      ""
    );
    expect(o).not.toBeNull();
    expect(o!.total_amount).toBe(69.42);
    expect(o!.order_ref).toBe("123456");
  });

  it("a ₹0.00 refund is preserved, not falsy-dropped", () => {
    const o = parseAmazonOrder(
      "Refund on order 404-1-1",
      "your refund for ₹0.00 has been processed for your Order # 404-8063799-7205955",
      ""
    );
    expect(o).not.toBeNull();
    expect(o!.total_amount).toBe(0);
    expect(o!.kind).toBe("refund");
  });

  it("an all-ellipsis Delivered subject yields null, not a '.' item", () => {
    expect(parseAmazonOrder("Delivered: “...”", "Your package was delivered.", "")).toBeNull();
  });
});

describe("parseZomatoOrder — item edge cases (boundary-prover)", () => {
  it("keeps two REAL lines for the same item name with different quantities", () => {
    const o = parseZomatoOrder(
      "Your Zomato order from YUKI",
      "1 X Coke 2 X Coke Total paid - ₹200.00",
      ""
    );
    expect(o!.items).toEqual([
      { name: "Coke", qty: 1 },
      { name: "Coke", qty: 2 },
    ]);
  });

  it("still dedupes responsive-layout duplication (same name AND qty twice in HTML)", () => {
    const html = `<p>1 X Coke</p><p>1 X Coke</p>`;
    const o = parseZomatoOrder("Your Zomato order from YUKI", "Total paid - ₹90.00", html);
    expect(o!.items).toEqual([{ name: "Coke", qty: 1 }]);
  });

  it("accepts the colon separator variant ('Total paid: ₹X')", () => {
    const o = parseZomatoOrder("Your Zomato order from YUKI", "1 X Coke Total paid: ₹90.00", "");
    expect(o!.total_amount).toBe(90);
  });
});

describe("parseOrderEmail — sender boundary (boundary-prover)", () => {
  it("a domain merely CONTAINING 'amazon.in' must not route to the Amazon parser", () => {
    const result = parseOrderEmail(
      "billing@fakeamazon.in.phish-example.com",
      "Refund on order 404-8063799-7205955",
      "your refund for ₹9999.00 has been processed for your Order # 404-8063799-7205955",
      ""
    );
    expect(result).toBeNull();
  });

  it("display-name sender headers still route correctly", () => {
    const o = parseOrderEmail(
      "Amazon.in <payments-messages@amazon.in>",
      "Refund on order 404-8063799-7205955",
      "your refund for ₹69.42 has been processed for your Order # 404-8063799-7205955",
      ""
    );
    expect(o?.kind).toBe("refund");
  });
});

// ── Shopify (D2C) ────────────────────────────────────────────────────────────
// Fixtures condensed from REAL emails in KP's Gmail (2026-07-12):
//   Inmarwar  care@inmarwar.com   "Your order 10111500 confirmed."  Total ₹23,999
//   ThePostbox care@thepostbox.in "…Order #118863"                  Total ₹1,499
// Both are Shopify. Inmarwar's bank descriptor is "Raz*inmarwar" (name overlap);
// Postbox's is an unrelated "hourglass" (amount+time only) — see order-match.test.

const INMARWAR_SENDER = "Inmarwar <care@inmarwar.com>";
const INMARWAR_SUBJECT = "Your order 10111500 confirmed. We're processing your order.";
const INMARWAR_TEXT =
  "I N M A R W A R Thank you for your order. We are getting your order ready for shipment. " +
  "Order number, 10111500 Placed on 21 Jun 2026 Your order summary " +
  "Sideboard, solid sheesham wood and steel, 4 doors × 1 Rs. 23,999.00 " +
  "Subtotal Rs. 23,999.00 Shipping Rs. 0.00 Total Rs. 23,999 " +
  "Customer information Payment Razorpay secure";
const INMARWAR_HTML = '<img src="https://cdn.shopify.com/s/files/1/0260/x.jpg"/>';

const POSTBOX_SENDER = "The Postbox <care@thepostbox.in>";
const POSTBOX_SUBJECT = "The Postbox: Confirmation email for Order #118863";
const POSTBOX_TEXT =
  "This email confirms your order with The Postbox. #118863 " +
  "Spark - Stationery Zipper Case / Classic Tan Classic Tan Rs. 1,699.00 " +
  "Discount -Rs. 200.00 Subtotal Rs. 1,499.00 Total excl. tax Rs. 1,270.34 " +
  "Sales tax Rs. 228.66 Total Rs. 1,499.00 Rs. 1,499.00 Shipping Address";
const POSTBOX_HTML = '<a href="https://cdn.shopify.com/">logo</a>';

describe("parseOrderEmail — Shopify D2C brands", () => {
  it("Inmarwar: total, item (name × qty → price), order ref, merchant from sender", () => {
    const o = parseOrderEmail(INMARWAR_SENDER, INMARWAR_SUBJECT, INMARWAR_TEXT, INMARWAR_HTML);
    expect(o).not.toBeNull();
    expect(o!.source).toBe("shopify");
    expect(o!.kind).toBe("order");
    expect(o!.total_amount).toBe(23999);            // grand Total, not Subtotal
    expect(o!.order_ref).toBe("10111500");
    expect(o!.merchant_name).toBe("Inmarwar");
    expect(o!.items[0]).toEqual({
      name: "Sideboard, solid sheesham wood and steel, 4 doors",
      qty: 1,
      price: 23999,
    });
  });

  it("Postbox: picks grand Total (₹1,499), NOT 'Total excl. tax' (₹1,270.34) or Subtotal", () => {
    const o = parseOrderEmail(POSTBOX_SENDER, POSTBOX_SUBJECT, POSTBOX_TEXT, POSTBOX_HTML);
    expect(o).not.toBeNull();
    expect(o!.source).toBe("shopify");
    expect(o!.total_amount).toBe(1499);
    expect(o!.order_ref).toBe("118863");
    expect(o!.merchant_name).toBe("The Postbox");
  });

  it("Postbox REAL email: reads items from HTML when text/plain is junk CSS", () => {
    // The actual synced email: text/plain is leaked CSS (0 items until fixed),
    // while the HTML carries the order. Parser must read the HTML.
    const junkText = "96 /* remove spaces */ html, body { Margin: 0 !important; } * { -webkit-font-smoothing: antialiased; }";
    const realHtml =
      '<div>Order Confirmation Order No. #118863 11/07/2026 Hi Kanwar,</div>' +
      '<table><tr><td>Items ordered</td></tr>' +
      '<tr><td>Spark - Stationery Zipper Case / Classic Tan Classic Tan The Postbox x 1 Rs. 1,699.00</td></tr>' +
      '<tr><td>Discount (Rs 200/- Off) -Rs. 200.00</td></tr>' +
      '<tr><td>Subtotal Rs. 1,499.00</td></tr><tr><td>Total excl. tax Rs. 1,270.34</td></tr>' +
      '<tr><td>Sales tax Rs. 228.66</td></tr><tr><td>Total Rs. 1,499.00</td></tr></table>';
    const o = parseOrderEmail(POSTBOX_SENDER, POSTBOX_SUBJECT, junkText, realHtml);
    expect(o).not.toBeNull();
    expect(o!.total_amount).toBe(1499);          // grand Total, from the HTML
    expect(o!.items).toHaveLength(1);
    expect(o!.items[0].name).toContain("Spark - Stationery Zipper Case");
    expect(o!.items[0]).toMatchObject({ qty: 1, price: 1699 });
  });

  it("PRDGY REAL: 'Order summary' header (no 'your') + variant suffix on the row", () => {
    // Gokwik-checkout Shopify theme: header is a bare "Order summary" and each
    // row carries a size variant between the qty and the price ("× 1 L ₹ …").
    const html =
      '<a href="https://cdn.shopify.com/">x</a>' +
      "Order summary PRDGY Love In Fur Oversized t-shirt × 1 L ₹ 1,699.00 " +
      "PRDGY Stuck in Traffic Oversized Tshirt × 1 L / Back ₹ 1,699.00 " +
      "Subtotal ₹ 3,398.00 Order discount -₹ 599.70 Total ₹ 2,798.30";
    const o = parseOrderEmail("PRDGY <support@prdgy.in>", "Order PC61260 confirmed", "", html);
    expect(o!.source).toBe("shopify");
    expect(o!.total_amount).toBe(2798.3); // grand Total, not Subtotal
    expect(o!.items).toHaveLength(2);
    expect(o!.items[0]).toMatchObject({ name: "PRDGY Love In Fur Oversized t-shirt", qty: 1, price: 1699 });
    expect(o!.items[1].name).toBe("PRDGY Stuck in Traffic Oversized Tshirt");
  });

  it("Ellementry REAL (Shopflo): 'Product Qty. Price' header, 'Bag Total' footer, repeated qty column", () => {
    const html =
      '<a href="https://cdn.shopify.com/">x</a>' +
      "Thank you for shopping with ellementry. Your order with id 124140599 has been placed successfully. " +
      "Product Qty. Price Crown Glass Bottle with Tumbler × 1 1 ₹ 1,182.00 " +
      "Drop Glass Water Bottle With Ceramic Stopper Set of 2 × 1 1 ₹ 1,437.00 " +
      "Bag Total ₹ 2,619.00 Shipping ₹ 00.0 Grand Total ₹ 2,469.00";
    const o = parseOrderEmail("ellementry <noreply@ellementry.com>", "Order 124140599 confirmed", "", html);
    expect(o!.source).toBe("shopify");
    expect(o!.total_amount).toBe(2469); // grand Total, not Bag Total
    expect(o!.items).toHaveLength(2);
    expect(o!.items[0]).toMatchObject({ name: "Crown Glass Bottle with Tumbler", qty: 1, price: 1182 });
    expect(o!.items[1]).toMatchObject({ name: "Drop Glass Water Bottle With Ceramic Stopper Set of 2", qty: 1, price: 1437 });
  });

  it("routes to Shopify only via signature — a marketplace sender still wins", () => {
    // BigBasket order text carrying a stray shopify URL must still parse as bigbasket.
    const o = parseOrderEmail(
      "BigBasket <alerts@bigbasket.com>",
      "Your bigbasket order confirmation ( BNN-2032973738-20260703 )",
      "Sub Total: Rs. 482.84 Final Total: Rs. 0.00",
      '<a href="cdn.shopify.com">x</a>'
    );
    expect(o!.source).toBe("bigbasket");
  });
});

// ── Generic fallback ─────────────────────────────────────────────────────────
// NOTE: SYNTHETIC shape (no confirmed non-Shopify D2C sample in Gmail). Tests
// the generic logic only — order-intent gate + labelled-total extraction.
describe("parseOrderEmail — generic any-merchant fallback", () => {
  it("parses a non-Shopify order with an 'Amount Paid' total + brand from sender", () => {
    const o = parseOrderEmail(
      "BrandX <orders@brandx.co.in>",
      "Your BrandX order is confirmed",
      "Thank you for your order. Order number: BX-99213. Amount Paid Rs. 2,340.00. Ships in 3 days.",
      ""
    );
    expect(o).not.toBeNull();
    expect(o!.source).toBe("generic");
    expect(o!.total_amount).toBe(2340);
    expect(o!.merchant_name).toBe("BrandX"); // display name preferred, real casing kept
    expect(o!.order_ref).toBe("BX-99213");
  });

  it("a newsletter with no total is NOT an order (recorded as seen, not stored)", () => {
    const o = parseOrderEmail(
      "BrandX <news@brandx.co.in>",
      "New arrivals just for you",
      "Check out our latest collection. Shop now and save big!",
      ""
    );
    expect(o).toBeNull();
  });

  it("an order-shaped email with no extractable total → null (never a phantom order)", () => {
    const o = parseOrderEmail(
      "BrandX <orders@brandx.co.in>",
      "Your order has shipped",
      "Your order is on the way! Track your shipment here.",
      ""
    );
    expect(o).toBeNull();
  });

  it("recovers the item from the subject ('… Order for <X>') — the Flipkart pattern", () => {
    const o = parseOrderEmail(
      "Flipkart <noreply@flipkart.com>",
      "Your Order for DeckUp Bei 4-Door Engineered Wood Cabinet",
      "Thank you for your order. Order Id: OD12345678. Order Total Rs. 8,499.00",
      ""
    );
    expect(o).not.toBeNull();
    expect(o!.total_amount).toBe(8499);
    expect(o!.items).toEqual([{ name: "DeckUp Bei 4-Door Engineered Wood Cabinet" }]);
  });
});

// ── Merchant item overrides (KP-curated) ─────────────────────────────────────
describe("parseOrderEmail — merchant item overrides", () => {
  it("GoRally (bills via Razorpay, no items) → 'Pickleball Game'", () => {
    const o = parseOrderEmail(
      "Payments <no-reply@razorpay.com>",
      "Payment successful for GoRally",
      "GoRally ₹ 350.00 Paid Successfully Payment Id pay_SqnDroYU8hQG8t Method card XXXX-XXXX-XXXX-5906 " +
        "Paid On 18 May, 2026 03:54:15 PM IST",
      ""
    );
    expect(o).not.toBeNull();
    expect(o!.source).toBe("razorpay");
    expect(o!.merchant_name).toBe("GoRally");
    expect(o!.total_amount).toBe(350);
    expect(o!.items).toEqual([{ name: "Pickleball Game" }]);
  });

  it("Hudle + Hsquare (pickleball venues, via Razorpay) → 'Pickleball Game'", () => {
    const hudle = parseOrderEmail("no-reply@razorpay.com", "Payment successful for Hudle",
      "Hudle ₹ 400.00 Paid Successfully Payment Id pay_abc123 Paid On 1 Jun, 2026 06:00:00 PM IST", "");
    expect(hudle!.items).toEqual([{ name: "Pickleball Game" }]);
    const hsq = parseOrderEmail("no-reply@razorpay.com", "Payment receipt for your successful transaction",
      "Hsquare Sports Private Limited ₹ 500.00 Paid Successfully Payment Id pay_xyz789 Paid On 1 Jun, 2026", "");
    expect(hsq!.items).toEqual([{ name: "Pickleball Game" }]);
  });

  it("does not override a merchant whose parser already found real items", () => {
    // A Swiggy order keeps its real items even if its name matched nothing.
    const o = parseOrderEmail(
      "noreply@swiggy.in",
      "Your Swiggy order was delivered before time",
      "Restaurant Corner House Your Order Summary: Item Name Quantity Price Cafe Caramel 1 ₹ 200 " +
        "Item Total: ₹ 200.00 Paid Via Credit/Debit card: ₹ 250.00",
      ""
    );
    expect(o!.items).toEqual([{ name: "Cafe Caramel", qty: 1, price: 200 }]);
  });
});

// ── SmartBuy travel (flights + hotels) ───────────────────────────────────────
describe("parseOrderEmail — SmartBuy travel", () => {
  it("flight: itinerary (route, date, airline, passenger, PNR) + card amount", () => {
    const text =
      "smartbuy Flight --> Dear Amarjit, Your flight booking through our booking partner CLEARTRIP is Successful! " +
      "Order ID 44116973458171036841 Order Date 15 Oct 2023 10:26:58 Amount Paid Rs 6,915 " +
      "Contact Number 9650077811 IndiGo 6E - 6634 IXC BLR Class E Quantity 1 Adult Ticket(s) " +
      "Airline PNR V3YIXX 2023-OCT-19 08:10 IXC Chandigarh Terminal :- 3 h 05 min --Via -- Non-Stop " +
      "2023-OCT-19 11:15 BLR Bangalore Terminal :- 1 Passengers Adult 1: Mr. Amarjit Anand " +
      "Payments Basefare Rs 4,500 Netpay Rs 6,915 Paid by points Rs 0 Paid by card Rs 6,915";
    const o = parseOrderEmail("SmartBuy <donotreply@smartbuyoffers.co>", "Your Flight Booking with SmartBuy is Successful", text, "");
    expect(o!.source).toBe("smartbuy");
    expect(o!.total_amount).toBe(6915);
    expect(o!.order_ref).toBe("44116973458171036841");
    const name = o!.items[0].name;
    expect(name).toContain("Chandigarh (IXC) → Bangalore (BLR)");
    expect(name).toContain("19 Oct 2023");
    expect(name).toContain("IndiGo 6E - 6634");
    expect(name).toContain("Mr. Amarjit Anand");
    expect(name).toContain("PNR V3YIXX");
  });

  it("hotel: name, dates, room, guest + the CARD portion (not the points-inclusive total)", () => {
    const text =
      "smartbuy Hotel --> Dear Kanwar, Your hotel booking through our booking partner MAKEMYTRIP is Successful. " +
      "Order ID 43673407147532910026 Amount Paid Rs. 53,820 Contact Number 9650077811 " +
      "Goa Marriott Resort & Spa Miramar Beach, PO Box No 64 Panjim Goa -IN 2023-09-29 2023-10-01 " +
      "Guests room1 Guest room, 1 King, Garden view Inclusion NA Adult 1: Kanwar Fare Summary " +
      "Room Type : Guest room, 1 King, Garden view No of Guests: room1 Adult : 2 " +
      "Netpay Rs 53,820 Paid by points Rs 4,875 Paid by card Rs 48,945";
    const o = parseOrderEmail("SmartBuy <donotreply@smartbuyoffers.co>", "Your Hotel Booking with SmartBuy is Successful", text, "");
    expect(o!.source).toBe("smartbuy");
    expect(o!.total_amount).toBe(48945); // paid by card, not ₹53,820 (points included)
    const name = o!.items[0].name;
    expect(name).toContain("Goa Marriott Resort & Spa Miramar Beach");
    expect(name).toContain("29 Sep 2023");
    expect(name).toContain("Guest room, 1 King, Garden view");
  });
});

// ── Apple (subscriptions + receipts) ─────────────────────────────────────────
describe("parseOrderEmail — Apple", () => {
  it("invoice: subscription name + charge", () => {
    const text =
      "Tax Invoice 7 July 2026 Order ID: MNMTFBW03Y Document: 694158047395 Apple Account: kanwarpalss@gmail.com " +
      "Apple One Family (Monthly) SAC: 998439 Renews 8 August 2026 ₹ 365.00 Billing and Payment " +
      "Subtotal ₹ 309.32 IGST charged at 18% ₹ 55.68 Store Credit ₹ 365.00";
    const o = parseOrderEmail("Apple <no_reply@email.apple.com>", "Your invoice from Apple.", text, "");
    expect(o!.source).toBe("apple");
    expect(o!.total_amount).toBe(365);
    expect(o!.order_ref).toBe("MNMTFBW03Y");
    expect(o!.items).toEqual([{ name: "Apple One Family (Monthly)" }]);
  });

  it("invoice Format B: item after DOCUMENT NO. + TOTAL (BILLED-TO address first)", () => {
    // Real variant that returned null before: "APPLE ACCOUNT" (no colon), a
    // BILLED-TO address block, item after DOCUMENT NO., grand TOTAL.
    const text =
      "Tax Invoice APPLE ACCOUNT kanwarpalss@gmail.com BILLED TO Store Credit Kanwar Pal Sethi #461 Sector 37 " +
      "Chandigarh, CH 160036 IND INVOICE DATE 18 Sept 2024 ORDER ID MNMNSD58ZL DOCUMENT NO. 133851255535 " +
      "App Store YouTube Music YouTube Premium Family (Monthly) Renews 18 Oct 2024 SAC:998434 Report a Problem ₹ 249 " +
      "Subtotal ₹ 211 IGST charged at 18% ₹ 38 TOTAL ₹ 249";
    const o = parseOrderEmail("Apple <no_reply@email.apple.com>", "Your invoice from Apple.", text, "");
    expect(o!.source).toBe("apple");
    expect(o!.total_amount).toBe(249);
    expect(o!.order_ref).toBe("MNMNSD58ZL");
    expect(o!.items[0].name).toBe("App Store YouTube Music YouTube Premium Family (Monthly)");
  });

  it("invoice Format B: a movie rental", () => {
    const text =
      "Tax Invoice APPLE ACCOUNT kanwarpalss@gmail.com BILLED TO Store Credit Kanwar Pal Sethi #461 " +
      "ORDER ID MNMNSN17MD DOCUMENT NO. 184852956859 Apple TV Her Drama Movie Rental Apple TV SAC:998433 " +
      "Report a Problem ₹ 150 Subtotal ₹ 127 IGST charged at 18% ₹ 23 TOTAL ₹ 150";
    const o = parseOrderEmail("Apple <no_reply@email.apple.com>", "Your invoice from Apple.", text, "");
    expect(o!.total_amount).toBe(150);
    expect(o!.items[0].name).toBe("Apple TV Her Drama Movie Rental Apple TV");
  });

  it("receipt: app/service line + TOTAL", () => {
    const text =
      "Receipt APPLE ACCOUNT kanwarpalss@gmail.com DATE Jul 8, 2026 ORDER ID MNMTFH764G DOCUMENT NO. 820158479139 " +
      "Apple Services ₹ 100 Add Funds to Apple Account Kanwar's iPhone Pro ₹ 100 TOTAL ₹ 100 Get help";
    const o = parseOrderEmail("Apple <no_reply@email.apple.com>", "Your receipt from Apple.", text, "");
    expect(o!.source).toBe("apple");
    expect(o!.total_amount).toBe(100);
    expect(o!.order_ref).toBe("MNMTFH764G");
    expect(o!.items[0].name).toContain("Add Funds to Apple Account");
  });
});

// ── Generic item tables (Dominos, Supertails, …) ─────────────────────────────
describe("parseOrderEmail — generic item tables", () => {
  it("Dominos: bare-decimal item rows", () => {
    const text =
      "Thank you for choosing Domino's. Order Confirmed Order No. 86 | 21-04-2020 Order Total Rs.645.00 " +
      "Items Qty Price Chicken Fiesta Medium | Wheat Thin Crust 1 500.00 Pepsi Black Can 2 120.00 " +
      "Sub Total : Rs.620.00 GST : Rs.25.00 Grand Total : Rs.645.00";
    const o = parseOrderEmail("Dominos India <do-not-reply@dominos.co.in>", "Order Successful", text, "");
    expect(o!.total_amount).toBe(645);
    expect(o!.items).toEqual([
      { name: "Chicken Fiesta Medium | Wheat Thin Crust", qty: 1, price: 500 },
      { name: "Pepsi Black Can", qty: 2, price: 120 },
    ]);
  });

  it("Supertails: a 'delivered' receipt WITH an item table is kept (not skipped as shipping)", () => {
    const text =
      "Woohoo! Delivered on Sat, 11 April Shipment details ID: ST272689312507 " +
      "Items QTY COST MSD Animal Health Bravecto (1 tablet) 2 ₹3508 " +
      "Payment details Total MRP ₹4126 Total Amount ₹3343 Your order is Prepaid";
    const o = parseOrderEmail("Supertails <support@send.supertails.com>", "Your Supertails order has been delivered!", text, "");
    expect(o).not.toBeNull();
    expect(o!.total_amount).toBe(3343);
    expect(o!.items).toEqual([{ name: "MSD Animal Health Bravecto (1 tablet)", qty: 2, price: 3508 }]);
  });
});

// ── Razorpay (universal payment rail) ────────────────────────────────────────
// Fixtures condensed from REAL emails in KP's Gmail (2026-07-12), no-reply@razorpay.com.
// The merchant string is the registered ENTITY ("HOURGLASS DESIGN PVT LTD"),
// which matches the bank descriptor "hourglass" — see order-match affinity.

describe("parseOrderEmail — Razorpay payments", () => {
  it("success: merchant entity, exact amount, payment id (matches bank descriptor)", () => {
    const o = parseOrderEmail(
      "no-reply@razorpay.com",
      "Payment successful for HOURGLASS DESIGN PVT LTD",
      "HOURGLASS DESIGN PVT LTD ₹1499.00 Paid Successfully Payment Id pay_TC9eNwlrjKi1dV " +
        "Method card XXXX-XXXX-XXXX-4455 Paid On 11 Jul, 2026 03:29:39 PM IST Email kanwarpalss@gmail.com",
      ""
    );
    expect(o).not.toBeNull();
    expect(o!.source).toBe("razorpay");
    expect(o!.kind).toBe("order");
    expect(o!.total_amount).toBe(1499);
    expect(o!.merchant_name).toBe("HOURGLASS DESIGN PVT LTD");
    expect(o!.order_ref).toBe("pay_TC9eNwlrjKi1dV");
  });

  it("FAILED payment is never stored (real: Fleck failed then instantly retried)", () => {
    const o = parseOrderEmail(
      "no-reply@razorpay.com",
      "Payment failed for Fleck",
      "Fleck ₹2788.20 Payment Failed In case your money has been debited, it will be credited...",
      ""
    );
    expect(o).toBeNull();
  });

  it("subscription charge: 'a payment of ₹X has been made' → order + subscription id", () => {
    const o = parseOrderEmail(
      "subscriptions@razorpay.com",
      "Subscription Initialized for Trendlyne.com",
      "Subscription Started at Trendlyne.com Subscription ID: sub_TAiywVNa0AJrIi " +
        "You have been successfully subscribed and a payment of ₹ 310 has been made.",
      ""
    );
    expect(o!.total_amount).toBe(310);
    expect(o!.merchant_name).toBe("Trendlyne.com");
    expect(o!.order_ref).toBe("sub_TAiywVNa0AJrIi");
  });
});

// The whole point of Razorpay: its entity name earns affinity with the bank
// descriptor that the brand's own order email cannot. Locked here end-to-end.
describe("order-match: Razorpay entity ↔ bank descriptor", () => {
  it("'HOURGLASS DESIGN PVT LTD' order matches a 'hourglass' bank txn at HIGH", async () => {
    const { matchOrderToTxn } = await import("../../order-match");
    const m = matchOrderToTxn(
      { source: "razorpay", kind: "order", total_amount: 1499, order_at: "2026-07-11T10:00:08Z",
        merchant_name: "HOURGLASS DESIGN PVT LTD" },
      [{ id: "t1", amount_inr: 1499, txn_at: "2026-07-11T09:59:00Z", merchant: "hourglass", txn_type: "debit" }]
    );
    expect(m).toEqual({ txnId: "t1", confidence: "high" });
  });
});

describe("parseOrderEmail — generic 'amount before paid' rails (PayEazy etc.)", () => {
  it("EazyDiner PayEazy: 'Rs. 470 paid to Cosmo' → order with amount", () => {
    const o = parseOrderEmail(
      "EazyDiner <noreply@eazydiner.com>",
      "Rs. 470 paid to Cosmo via PayEazy",
      "Payment Successful Hello KANWAR, Your PayEazy transaction is successful! Rs. 470 paid to Cosmo via PayEazy.",
      ""
    );
    expect(o).not.toBeNull();
    expect(o!.total_amount).toBe(470);
  });
});

describe("shipping-status emails are never treated as the order", () => {
  it("Shopify 'on its way' / 'shipped' pings are skipped (order email matches the charge instead)", () => {
    const body = "Your order summary Sub-total Rs 1499 Total Rs 1499 Widget × 1";
    expect(parseOrderEmail("care@thepostbox.in", "A shipment from order #19882 is on the way", body, "")).toBeNull();
    expect(parseOrderEmail("care@inmarwar.com", "Your order has shipped", body, "")).toBeNull();
    // The actual confirmation still parses.
    expect(parseOrderEmail("care@thepostbox.in", "Order #19882 confirmed", body, "")).not.toBeNull();
  });
});

// ── Bath & Body Works (order-bbw@apparelgroup.in) — condensed from the REAL
// BBW01373248 confirmation (2026-07-12). The format that beat the generic
// parser: a "YOUR ITEMS" header, then "<name> QTY <n> ₹<price> Form Size"
// rows, no per-item table header, "ORDER TOTAL" as the grand total. Before the
// fix this parsed to 0 items (total only). ──
const BBW_FROM = "Bath&Body Works <order-bbw@apparelgroup.in>";
const BBW_ITEMS_BODY =
  "Order Number BBW01373248 Dear Kanwar, Thank you for your order. Order Confirmed " +
  "VIEW ORDER STATUS Your order can't be changed at this time. YOUR ITEMS " +
  "Backyard Honey Suckle QTY 1 ₹1,499.00 Form Size Multi QTY 1 ₹799.00 Form Size " +
  "Gingerbread Bakery QTY 1 ₹750.00 Form Size Pink Gumball QTY 1 ₹799.00 Form Size " +
  "Black QTY 1 ₹799.00 Form Size Not seeing everything in your order? Find complete details here " +
  "SHIPPING Ship To Kanwar Singh Bellandur Bangalore Karnataka 560103 Payment Method Razorpay " +
  "PAYMENT SUMMARY MERCHANDISE SUBTOTAL: ₹4,646.00 SHIPPING & HANDLING: ₹0.00 DISCOUNT - 10349.0 " +
  "ORDER TOTAL ₹4,181.00 Bath&BodyWorks";

describe("parseOrderEmail — Bath & Body Works (apparelgroup 'QTY n ₹' format)", () => {
  const o = parseOrderEmail(BBW_FROM, "Your Order has been Successfully placed", BBW_ITEMS_BODY, "");

  it("extracts all five items with qty + price", () => {
    expect(o).not.toBeNull();
    expect(o!.items).toEqual([
      { name: "Backyard Honey Suckle", qty: 1, price: 1499 },
      { name: "Multi", qty: 1, price: 799 },
      { name: "Gingerbread Bakery", qty: 1, price: 750 },
      { name: "Pink Gumball", qty: 1, price: 799 },
      { name: "Black", qty: 1, price: 799 },
    ]);
  });

  it("total is the ORDER TOTAL (₹4181), not the merchandise subtotal (₹4646)", () => {
    expect(o!.total_amount).toBe(4181);
  });

  it("'SUCCESSFULLY PACKED' / 'SUCCESSFULLY SHIPPED' status pings are dropped even though they carry items", () => {
    expect(parseOrderEmail(BBW_FROM, "YOUR ORDER HAS BEEN SUCCESSFULLY PACKED", BBW_ITEMS_BODY, "")).toBeNull();
    expect(parseOrderEmail(BBW_FROM, "YOUR ORDER HAS BEEN SUCCESSFULLY SHIPPED", BBW_ITEMS_BODY, "")).toBeNull();
  });
});

// ── The Postbox item-name hygiene. The real #118863 confirmation repeats the
// variant and appends the brand, so the naive capture was
// "Spark - Stationery Zipper Case / Classic Tan Classic Tan The Postbox". The
// cleaned name must drop the trailing brand and the "x 1" tail. ──
describe("parseOrderEmail — Postbox item name is cleaned of brand/qty residue", () => {
  const POSTBOX_BODY =
    "Order Confirmation Order No. #118863 11/07/2026 Hi Kanwar, This email confirms your order. " +
    "Items ordered Spark - Stationery Zipper Case / Classic Tan - Classic Tan " +
    "Spark - Stationery Zipper Case / Classic Tan Classic Tan The Postbox x 1 Rs. 1,699.00 " +
    "Discount (Rs 200/- Off) -Rs. 200.00 Subtotal Rs. 1,499.00 Total excl. tax Rs. 1,270.34 " +
    "Sales tax Rs. 228.66 Total Rs. 1,499.00 Payment Info Razorpay";
  const o = parseOrderEmail("The Postbox <care@thepostbox.in>", "The Postbox: Confirmation email for Order #118863", POSTBOX_BODY, "");

  it("parses one item at ₹1499 total", () => {
    expect(o!.total_amount).toBe(1499);
    expect(o!.items).toHaveLength(1);
  });

  it("item name starts with the product and does NOT include the brand or 'x 1'", () => {
    expect(o!.items[0].name).toMatch(/^Spark - Stationery Zipper Case/);
    expect(o!.items[0].name).not.toMatch(/The Postbox/);
    expect(o!.items[0].name).not.toMatch(/\bx\s*1\b/i);
    // The doubled title collapsed — "Spark" appears once, not twice.
    expect(o!.items[0].name.match(/Spark/g)).toHaveLength(1);
  });
});
