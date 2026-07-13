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
  it("uses the CARD charge, not the first 'Paid Via' line, when payment is split", () => {
    const text =
      "Order ID: 242283010812320 BILL DETAILS " +
      "Paid Via Swiggy Money ₹50.00 Paid Via Credit/Debit card ₹315.00";
    const o = parseSwiggyOrder("Your Swiggy order was successfully delivered", text, "");
    expect(o!.total_amount).toBe(315);
  });

  it("falls back to the LAST 'Paid Via' line when none mentions a card", () => {
    const text = "Order ID: 111 BILL DETAILS Paid Via Swiggy Money ₹50.00 Paid Via UPI ₹315.00";
    const o = parseSwiggyOrder("Your Swiggy order was successfully delivered", text, "");
    expect(o!.total_amount).toBe(315);
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
