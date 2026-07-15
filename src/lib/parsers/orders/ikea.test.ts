import { describe, it, expect, vi } from "vitest";
import { parseIkeaPdf, isIkeaSender } from "./ikea";
import { findPdfAttachments, parseOrderFromPdfs } from "../../gmail/pdf";

// ── Real extracted-text fixtures ─────────────────────────────────────────────
// Captured from KP's actual IKEA PDF invoices on 2026-07-15 (billing/shipping
// address blocks removed — the Articles rows themselves carry no personal data).
// IKEA India emits three invoice layouts; one fixture per format, plus a refund.

// Format A — modern GST invoice (TaxInvoice / ReceiptVoucher). Two items, no
// discount column.
const FORMAT_A_SIMPLE = `Original for Recipient Tax Invoice SELLER: IKEA India Pvt Ltd GSTIN: 27AADCI3006N1ZK Document information: Order No: 221536748 Transaction date: 17/08/2025 Place of supply: Karnataka (29) Articles: # HSN/ SAC Item No. Description Quantity/ UoM Tax rate Unit price incl. tax Amount Total amount 1 69120010 504.571.53 GLADELIG mug 37 cl grey AP 2 EA IGST 12 % 299.00 598.00 598.00 2 69120010 705.814.63 GLADELIG mug 30 cl grey AP 2 EA IGST 12 % 249.00 498.00 498.00 Total: 1,096.00 INR Payment type VISA_CREDIT`;

// Format A — with per-line IKEA Family Savings discounts (the case that broke
// the first name-cleaner). Seven items; note GRADVIS + FEJKA discount rows.
const FORMAT_A_DISCOUNTS = `Original for Recipient Tax Invoice SELLER: IKEA India Pvt Ltd Document information: Order No: 223248324 Place of supply: Karnataka (29) Articles: # HSN/ SAC Item No. Description Quantity/ UoM Tax rate Unit price incl. tax Amount Discount Total amount 1 94032010 404.885.03 HYLLIS shelv ut 40x27x183 in/outdoor AP 1 EA IGST 18 % 2,990.00 2,990.00 2,990.00 2 94036000 305.086.53 BILLY bookcs 80x28x202 brown walnut effect AP 1 EA IGST 18 % 8,990.00 8,990.00 8,990.00 3 94039100 405.086.76 OXBERG door 40x97 brown walnut effect AP 2 EA IGST 18 % 2,200.00 4,400.00 4,400.00 4 67029090 204.523.69 FEJKA N artifi pttd plant 15 in/out eucal AP IKEA Family Savings: -200.00 1 EA IGST 18 % 1,490.00 1,490.00 -200.00 1,290.00 5 67021010 205.197.65 FEJKA N art ptplwpot 6cm 3p in/out Succulent 3p AP IKEA Family Savings: -50.00 1 EA IGST 18 % 249.00 249.00 -50.00 199.00 6 39269080 705.444.56 BUSKVERK plant pot 9 in/outdoor grey AP 2 EA IGST 18 % 59.00 118.00 118.00 7 69139000 203.915.35 GRADVIS plant pot 15 grey AP IKEA Family Savings: -94.00 1 EA IGST 5 % 561.00 561.00 -94.00 467.00 Total: 18,454.00 INR © Inter IKEA Systems B.V. 2025`;

// Format B — legacy POS "Sales invoice" (2024). Names are POS-truncated.
const FORMAT_B = `Welcome to IKEA Bengaluru - Nagasandra IKEA India Private Ltd. Tax Invoice Date 08/12/2024 Number S57824A001134500 Place Of Supply KARNATAKA Item 30493345 / HSN 67021010 FEJKA artifi pttd pl ( 1 EA * 699.00) 699.00 incl. CGST 9.0% SGST 9.0% Item 00516409 / HSN 46021100 KLYNNON plant pot 12 ( 1 EA * 399.00) 399.00 incl. CGST 2.5% SGST 2.5% Item 50504055 / HSN 39249090 UPPDATERA box 24x17 ( 2 EA * 199.00) 398.00 Page 1 of 4 incl. CGST 9.0% SGST 9.0% Total Amount Payable 1,496.00 INR Total items: 4`;

// Format C — order-confirmation "Goods Summary" (the _0.pdf). Prices have no
// decimals; there is no printed grand total (we sum the rows).
const FORMAT_C = `Order Confirmation(iSOM) Order Number: 230567312 IKEA contact information Goods Summary Qty Description: Art Nr Service code Price Tot. Price * 1 SKRUVBY sideboard 120x38x90 black-blue AP 505.687.21 A 11,042 11,042 Thank you for shopping at IKEA.`;

// Credit Note — a return. Negative quantities/amounts; "NBO Furniture 15%" discount label.
const CREDIT_NOTE = `Original for Recipient Credit Note SELLER: IKEA India Pvt Ltd Document information: Order No: 229764090 Return reason: Sales Return Articles: # HSN/ SAC Item No. Description Quantity/ UoM Tax rate Unit price incl. tax Amount Discount Total amount 1 94036000 505.687.21 SKRUVBY sideboard 120x38x90 black-blue AP NBO Furniture 15%: -1,948.50 -1 EA IGST 18 % 12,990.00 -12,990.00 1,948.50 -11,041.50 Total: -11,041.50 INR`;

// The delivery T&C PDF that rides along with every order — no article rows.
const TERMS_PDF = `GeneralTermaandCondition Delivery Service Terms of Carriage This document sets out the arrangements that will apply to the purchase of an IKEA Delivery Service. Agreement 1. Delivery will take place at the location specified by the Customer.`;

describe("parseIkeaPdf — Format A (modern GST invoice)", () => {
  it("parses a simple two-item invoice with qty, price and total", () => {
    const r = parseIkeaPdf(FORMAT_A_SIMPLE)!;
    expect(r).not.toBeNull();
    expect(r.source).toBe("ikea");
    expect(r.kind).toBe("order");
    expect(r.merchant_name).toBe("IKEA");
    expect(r.order_ref).toBe("221536748");
    expect(r.total_amount).toBe(1096);
    expect(r.items).toEqual([
      { name: "GLADELIG mug 37 cl grey", qty: 2, price: 598 },
      { name: "GLADELIG mug 30 cl grey", qty: 2, price: 498 },
    ]);
  });

  it("keeps full names on discounted rows and uses the post-discount line total", () => {
    // Regression (2026-07-15): the first name-cleaner ate the whole description
    // back to the first space, turning "GRADVIS plant pot 15 grey" into "GRADVIS".
    const r = parseIkeaPdf(FORMAT_A_DISCOUNTS)!;
    expect(r.items).toHaveLength(7);
    expect(r.total_amount).toBe(18454);

    const gradvis = r.items.find((i) => i.name.startsWith("GRADVIS"))!;
    expect(gradvis.name).toBe("GRADVIS plant pot 15 grey"); // NOT "GRADVIS"
    expect(gradvis.price).toBe(467); // 561 − 94 discount, not 561

    const fejka = r.items.find((i) => i.name.startsWith("FEJKA N art ptplwpot"))!;
    expect(fejka.name).toBe("FEJKA N art ptplwpot 6cm 3p in/out Succulent 3p"); // "Succulent 3p" kept
    expect(fejka.price).toBe(199);

    // A non-discounted row keeps its clean name (trailing " AP" stripped).
    expect(r.items[0]).toEqual({ name: "HYLLIS shelv ut 40x27x183 in/outdoor", qty: 1, price: 2990 });
    // Multi-qty line total is the last money column.
    expect(r.items[2]).toEqual({ name: "OXBERG door 40x97 brown walnut effect", qty: 2, price: 4400 });
  });
});

describe("parseIkeaPdf — Format B (legacy Sales invoice)", () => {
  it("parses 'Item .. / HSN ..' rows and the payable total", () => {
    const r = parseIkeaPdf(FORMAT_B)!;
    expect(r.source).toBe("ikea");
    expect(r.total_amount).toBe(1496);
    expect(r.items).toEqual([
      { name: "FEJKA artifi pttd pl", qty: 1, price: 699 },
      { name: "KLYNNON plant pot 12", qty: 1, price: 399 },
      { name: "UPPDATERA box 24x17", qty: 2, price: 398 }, // "Page 1 of 4" noise ignored
    ]);
  });
});

describe("parseIkeaPdf — Format C (order confirmation goods summary)", () => {
  it("parses no-decimal prices and sums the rows for the total", () => {
    const r = parseIkeaPdf(FORMAT_C)!;
    expect(r.order_ref).toBe("230567312");
    expect(r.items).toEqual([
      { name: "SKRUVBY sideboard 120x38x90 black-blue", qty: 1, price: 11042 },
    ]);
    expect(r.total_amount).toBe(11042); // summed (no printed grand total)
  });
});

describe("parseIkeaPdf — Credit Note (refund)", () => {
  it("flags a return as kind=refund with positive magnitudes", () => {
    const r = parseIkeaPdf(CREDIT_NOTE)!;
    expect(r.kind).toBe("refund");
    expect(r.order_ref).toBe("229764090");
    expect(r.total_amount).toBe(11041.5); // abs of -11,041.50
    expect(r.items).toEqual([
      { name: "SKRUVBY sideboard 120x38x90 black-blue", qty: 1, price: 11041.5 },
    ]);
  });
});

describe("parseIkeaPdf — non-invoice text", () => {
  it("returns null for the delivery T&C PDF (no article rows)", () => {
    expect(parseIkeaPdf(TERMS_PDF)).toBeNull();
  });
  it("returns null for text with no IKEA marker", () => {
    expect(parseIkeaPdf("Some random receipt with 1 EA of nothing.")).toBeNull();
  });
});

// Silent-corruption cases surfaced by the boundary-prover (2026-07-15). Each of
// these FAILED an earlier draft of the parser; they lock the fixes in.
describe("parseIkeaPdf — boundary cases", () => {
  const A = (rows: string, total: string) =>
    `Original for Recipient Tax Invoice SELLER: IKEA India Pvt Ltd Document information: Order No: 111 Articles: ${rows} ${total}`;

  it("flags a refund by its negative total even when not titled 'Credit Note'", () => {
    // The reliable refund signal is negative amounts, not one hardcoded string —
    // a 'Refund Note' must not book as a positive purchase (matches a DEBIT).
    const r = parseIkeaPdf(A(
      "1 94036000 505.687.21 SKRUVBY sideboard AP -1 EA IGST 18 % 12,990.00 -12,990.00 -12,990.00",
      "Total: -12,990.00 INR",
    ).replace("Tax Invoice", "Refund Note"))!;
    expect(r.kind).toBe("refund");
    expect(r.total_amount).toBe(12990); // positive magnitude
  });

  it("recovers the item when the grand total isn't the literal 'Total:' token", () => {
    const r = parseIkeaPdf(A(
      "1 69120010 504.571.53 GLADELIG mug 37 cl grey AP 2 EA IGST 12 % 299.00 598.00 598.00",
      "Grand Total 598.00 INR",
    ));
    expect(r).not.toBeNull();
    expect(r!.items).toEqual([{ name: "GLADELIG mug 37 cl grey", qty: 2, price: 598 }]);
  });

  it("does not drop the LAST item when the total wording lacks a colon", () => {
    const r = parseIkeaPdf(A(
      "1 69120010 504.571.53 GLADELIG mug 37 cl grey AP 2 EA IGST 12 % 299.00 598.00 598.00 " +
        "2 69120010 705.814.63 KORKEN jar AP 1 EA IGST 12 % 400.00 400.00 400.00",
      "Grand Total 998.00 INR",
    ))!;
    expect(r.items.map((i) => i.name)).toEqual(["GLADELIG mug 37 cl grey", "KORKEN jar"]);
  });

  it("parses rows even when a 'Total:' string precedes the Articles section", () => {
    const r = parseIkeaPdf(
      "Original for Recipient Tax Invoice SELLER: IKEA India Pvt Ltd Total: 598.00 INR Articles: " +
        "1 69120010 504.571.53 GLADELIG mug 37 cl grey AP 2 EA IGST 12 % 299.00 598.00 598.00 Total: 598.00 INR",
    );
    expect(r).not.toBeNull();
    expect(r!.items).toHaveLength(1);
  });

  it("keeps the price when a 'Page N of M' break lands mid-row", () => {
    const r = parseIkeaPdf(A(
      "1 69120010 504.571.53 GLADELIG mug 37 cl grey AP 2 EA IGST 12 % Page 2 of 3 299.00 598.00 598.00",
      "Total: 598.00 INR",
    ))!;
    expect(r.items[0].price).toBe(598);
  });

  it("does not let a digit+'EA' token inside the description hijack the qty", () => {
    const r = parseIkeaPdf(A(
      "1 69120010 504.571.53 SMAGORA 2 EA pack storage box AP 3 EA IGST 12 % 299.00 897.00 897.00",
      "Total: 897.00 INR",
    ))!;
    expect(r.items[0].name).toBe("SMAGORA 2 EA pack storage box");
    expect(r.items[0].qty).toBe(3);
  });

  it("keeps qty:0 for a genuine zero-quantity freebie row", () => {
    const r = parseIkeaPdf(A(
      "1 69120010 504.571.53 FREEBIE gift AP 0 EA IGST 18 % 0.00 0.00 0.00",
      "Total: 0.00 INR",
    ))!;
    expect(r.items[0]).toHaveProperty("qty", 0);
  });

  it("parses Indian lakh-grouped totals (1,00,000.00)", () => {
    const r = parseIkeaPdf(A(
      "1 69120010 504.571.53 BIG sofa AP 1 EA IGST 18 % 1,00,000.00 1,00,000.00 1,00,000.00",
      "Total: 1,00,000.00 INR",
    ))!;
    expect(r.total_amount).toBe(100000);
    expect(r.items[0].price).toBe(100000);
  });

  it("keeps Swedish/unicode product names intact", () => {
    const r = parseIkeaPdf(A(
      "1 69120010 504.571.53 SMÅGÖRA JÄTTELIK plant pot AP 1 EA IGST 18 % 199.00 199.00 199.00",
      "Total: 199.00 INR",
    ))!;
    expect(r.items[0].name).toBe("SMÅGÖRA JÄTTELIK plant pot");
  });
});

describe("isIkeaSender", () => {
  it("matches ikea.com and its subdomains, not lookalikes", () => {
    expect(isIkeaSender("IKEA <do-not-reply@ikea.com>")).toBe(true);
    expect(isIkeaSender("IKEA <information@cm.order.email.ikea.com>")).toBe(true);
    expect(isIkeaSender("no.reply@ikea.com")).toBe(true);
    expect(isIkeaSender("phish <billing@ikea.com.evil.example>")).toBe(false);
    expect(isIkeaSender("Amazon <order-update@amazon.in>")).toBe(false);
  });
});

describe("findPdfAttachments", () => {
  it("finds application/pdf AND octet-stream .pdf parts (IKEA uses the latter)", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/html", body: { data: "x" } },
        { mimeType: "application/octet-stream", filename: "230567312_0.pdf", body: { attachmentId: "att0", size: 77552 } },
        { mimeType: "application/pdf", filename: "E579_TaxInvoice.pdf", body: { attachmentId: "att1", size: 44857 } },
        { mimeType: "image/png", filename: "logo.png", body: { attachmentId: "att2", size: 10 } },
      ],
    };
    const found = findPdfAttachments(payload);
    expect(found.map((f) => f.attachmentId)).toEqual(["att0", "att1"]);
  });
});

describe("parseOrderFromPdfs — gating + richest-wins", () => {
  it("returns null WITHOUT downloading for a non-IKEA sender", async () => {
    const download = vi.fn();
    const out = await parseOrderFromPdfs("Amazon <x@amazon.in>", [{ filename: "a.pdf", attachmentId: "1", mimeType: "application/pdf", size: 1 }], download);
    expect(out).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it("keeps the richest PDF, ignores the T&C, and survives a broken PDF", async () => {
    // Two IKEA attachments arrive per order: the T&C PDF (no items) and the
    // real invoice. A third here is corrupt — it must be skipped, not fatal.
    const pdfs = [
      { filename: "terms.pdf", attachmentId: "terms", mimeType: "application/pdf", size: 1 },
      { filename: "broken.pdf", attachmentId: "broken", mimeType: "application/pdf", size: 1 },
      { filename: "invoice.pdf", attachmentId: "inv", mimeType: "application/pdf", size: 1 },
    ];
    const download = async (id: string) => new TextEncoder().encode(id);
    const extract = async (data: Uint8Array) => {
      const id = new TextDecoder().decode(data);
      if (id === "terms") return TERMS_PDF;
      if (id === "broken") throw new Error("Invalid PDF structure");
      return FORMAT_A_SIMPLE;
    };
    const out = await parseOrderFromPdfs("IKEA <do-not-reply@ikea.com>", pdfs, download, extract);
    expect(out).not.toBeNull();
    expect(out!.source).toBe("ikea");
    expect(out!.items).toHaveLength(2); // the invoice won; T&C + broken ignored
  });

  it("returns null when no attachment yields items", async () => {
    const pdfs = [{ filename: "terms.pdf", attachmentId: "terms", mimeType: "application/pdf", size: 1 }];
    const out = await parseOrderFromPdfs(
      "IKEA <do-not-reply@ikea.com>", pdfs,
      async () => new Uint8Array(), async () => TERMS_PDF,
    );
    expect(out).toBeNull();
  });
});
