// Item-extractor tests. Every fixture is the REAL stripped body (or a faithful
// condensation) of an email in KP's Gmail (sampled 2026-07-15) that the parsers
// previously read 0 items from. If these break, coverage regressed on real data.

import { describe, it, expect } from "vitest";
import { extractItemsGeneral } from "./item-extract";

describe("extractItemsGeneral", () => {
  it("Instamart — 'Order Items 1 x <name> ₹price' (qty-first grocery list)", () => {
    const body =
      "Greetings from Instamart Your Instamart order id: 241864665511482 was successfully delivered. " +
      "Deliver To: Flat E301 Bengaluru Order Items 1 x Brik Oven Artisanal Sourdough Bread (Freshly Baked) ₹110.00 " +
      "1 x organic tattva Whole Wheat Flour Chakki Atta ₹279.00 1 x Milky Mist Greek Yoghurt ₹299.00 " +
      "2 x Theobroma cheese crackers (No Preservatives) ₹318.00 1 x Vim Floor Cleaner UltraPro (1 ltr) ₹220.00 " +
      "1 x Dettol Antiseptic Liquid ₹141.00 Grand Total ₹1367.00";
    const items = extractItemsGeneral(body);
    expect(items).toHaveLength(6);
    expect(items[0]).toEqual({ name: "Brik Oven Artisanal Sourdough Bread (Freshly Baked)", qty: 1, price: 110 });
    expect(items.find((i) => i.name.startsWith("Theobroma"))).toMatchObject({ qty: 2, price: 318 });
  });

  it("Dot Badges — 'Order summary … Product Quantity Price <name> ×2 ₹78' (× rows, header stripped)", () => {
    const body =
      "Thank you for your order Order summary Order #291218 ( 04/01/2026 ) Product Quantity Price " +
      "Talk Data to Me - Laptop Sticker ×2 ₹ 78.00 World in Suitcase - Laptop Sticker ×2 ₹ 78.00 " +
      "Woof Woof - Pin-back Button Badge ×1 ₹ 49.00 Luggage Tags - Musafir Hoon Yaaron ×1 ₹ 99.00 " +
      "Subtotal: ₹ 578.00 Discount: - ₹ 50.00 Total: ₹ 528.00";
    const items = extractItemsGeneral(body);
    expect(items).toHaveLength(4);
    expect(items[0]).toEqual({ name: "Talk Data to Me - Laptop Sticker", qty: 2, price: 78 });
    // The "Order #291218 … Product Quantity Price" header must NOT leak into name 1.
    expect(items[0].name).not.toMatch(/Product Quantity Price|291218/);
  });

  it("DaMENSCH — 'Product Price <name> Qty:1 INR 1590' (Qty-colon, INR)", () => {
    const body =
      "Order Details Order ID: 313290 Product Price " +
      "CRED X Damensch Trunks Combo 2 L (36-38 in / 90-95 cm) Qty:1 INR 1590 " +
      "Cart Total INR 1590 Discount INR 795 Grand Total INR 845";
    const items = extractItemsGeneral(body);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ qty: 1, price: 1590 });
    expect(items[0].name).toMatch(/Trunks Combo/);
  });

  it("Google Play — 'Item Price <name> ₹2,100/year' (qty-less single price, unit-led name kept)", () => {
    const body =
      "Google Play purchase Order number: SOP.3386 Item Price " +
      "200 GB (Google One) (by Google LLC) ₹2,100.00 Total : ₹2,100.00";
    const items = extractItemsGeneral(body);
    expect(items).toHaveLength(1);
    expect(items[0].name).toMatch(/Google One/);
    expect(items[0].price).toBe(2100);
  });

  it("Nicobar — 'Product details PER ITEM ALL ITEM(S) <name> Color:… Qty:1 … ₹760' (attribute theme + spacer junk)", () => {
    const body =
      "We're so happy to have you shop with us. Your order is confirmed.膙﻿͏膙﻿͏​​ " +
      "Your product details PER ITEM ALL ITEM(S) " +
      "Starfish Glass Color: Clear Size: 8.5 x 8 cm Qty : 1 Delivery by Jul 15 ₹760 ₹950 ₹760 " +
      "Palash Tall Mug Color: Multi Size: 9 x 9 x 15.5 Cm Qty : 1 Delivery by Jul 15 ₹875 ₹1250 ₹875 " +
      "Ele Palm Tall Mug Color: White Size: 13.8 x 9.3 x 14.8 Cm Qty : 1 Delivery by Jul 15 ₹550 ₹1100 ₹550 " +
      "SUBTOTAL ₹2185 SHIPPING ₹0 TOTAL ₹ 2185.00";
    const items = extractItemsGeneral(body);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ name: "Starfish Glass", qty: 1, price: 760 });
    expect(items[1]).toEqual({ name: "Palash Tall Mug", qty: 1, price: 875 });
    expect(items[2]).toEqual({ name: "Ele Palm Tall Mug", qty: 1, price: 550 });
  });

  it("does NOT emit fee/total/tax/address lines as items (qty-less guard + stopwords)", () => {
    const body =
      "Order Details Widget Deluxe ₹999 Shipping ₹0 IGST ₹59 Total ₹1058 " +
      "Billing Address Kanwar Singh Flat N249 Bengaluru 560066 Grand Total ₹1058";
    const items = extractItemsGeneral(body);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Widget Deluxe");
  });

  it("Lacoste — GST-grid 'Items … <name> SKU:… 12 ₹220 1 ₹2,050.00'", () => {
    const body =
      "Your order summary is below. Your Order #OR2122-00084690 Placed on Sep 24, 2021 " +
      "Items CGST Rate (%) Amount SGST Rate (%) Amount UTGST Rate (%) Amount IGST Rate (%) Amount Qty Subtotal " +
      "Men's Contrast Strap And Oversized Crocodile Cotton Cap SKU: RK4711001 TU Color White 0 ₹0 0 ₹0 0 ₹0 12 ₹220 1 ₹2,050.00 " +
      "Subtotal ₹2,050.00 Shipping & Handling ₹0.00 IGST ₹219.64 Grand Total ₹2,050.00";
    const items = extractItemsGeneral(body);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ name: "Men's Contrast Strap And Oversized Crocodile Cotton Cap", qty: 1, price: 2050 });
  });

  it("DailyObjects — '<name> 699 1499 Order Status : Placed' (bare-number sale/MRP)", () => {
    const body =
      "HERE'S WHAT YOU ORDERED " +
      "Pebble MagSafe Compatible Charging Stand (Black) 699 1499 Order Status : Placed " +
      "Grey Velour Snap On Apple WatchBand (42/44/45/49mm) 1199 2499 Order Status : Placed " +
      "Blue Leather Loop Apple WatchBand (42/44/45/49mm) 999 1999 Order Status : Placed";
    const items = extractItemsGeneral(body);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ name: "Pebble MagSafe Compatible Charging Stand (Black)", price: 699 });
    expect(items[2].name).toMatch(/Blue Leather Loop/);
  });

  it("Sleepy Owl — single item after an address preamble (preamble stripped)", () => {
    const body =
      "Order Details Invoice Kanwar Pal Singh Sethi Flat N249, Brigade Woods Whitefield " +
      "Bangalore, Karnataka 560066 Order 274645 Anti Fall, No Spill Coffee Mug + Free Coffee Blue ₹1,234 " +
      "Shipping I'll Pay Online ₹0 IGST ₹59 Total ₹1,234";
    const items = extractItemsGeneral(body);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Anti Fall, No Spill Coffee Mug + Free Coffee Blue");
    expect(items[0].price).toBe(1234);
  });

  it("returns nothing when there is no recognisable item block", () => {
    expect(extractItemsGeneral("Convenience Fee Rs. 12.71 Total GST Rs. 2.29 Total Amount Rs. 15")).toEqual([]);
  });
});
