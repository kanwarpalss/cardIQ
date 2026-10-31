// HSBC's 2026-09 sender + template change. Bodies are real alerts from card
// 4502 (the OTP digits are masked). The old parser and sender list dropped all
// of these without an error.

import { describe, it, expect } from "vitest";
import { parseHsbcTxn } from "@/lib/parsers/hsbc";
import { parseTxnEmail, parseTxnEmailWithFallback } from "@/lib/parsers/registry";
import { findUnrecognizedFormatCandidates } from "@/lib/parsers/format-watch";
import { CARD_REGISTRY } from "@/lib/cards/registry";
import { cleanMerchant } from "@/lib/merchant-clean";

const SENDER = "hsbc@hsbc.bank.in";
const SUBJECT = "Credit Card Transaction Alert";
const alert = (money: string, merchant: string, date: string) =>
  `Dear Customer, We’re writing to confirm that your HSBC Credit Card xx4502 was used for a transaction of ${money} at ${merchant} on ${date}. Available limit: INR 66297.00 Amount due: INR 33703.00 If you did not make this transaction, please contact us promptly using the details available at: https://www.hsbc.bank.in/help/contact/ Regards, HSBC India`;

const OTP_BODY =
  "Dear Customer, A One-Time Password (OTP) has been generated for a transaction on your HSBC Credit Card ending with 4502. This OTP is valid for 5 minutes. OTP: ****** Transaction details: Amount: INR 2590.65 Merchant: MYGATE Reference: HZDS Please don’t share this OTP with anyone. Regards, HSBC India";
const CREDITS_BODY =
  "We have received credits of ₹ 1,140.00 on your HSBC credit card ending with 4502 on 22/10/2026. The amount has been adjusted against your outstanding balance. Kindly make the remaining payment of ₹ 89,208.42 within timeline to avoid any finance charges.";
const LIMITS_BODY =
  "Dear Customer, Transaction limits for your HSBC Credit Card ending with 4502 have been changed as per your request. Yours sincerely, HSBC India";

describe("HSBC 2026-09 alert template", () => {
  it("reads the transaction amount, not the available limit or amount due", () => {
    const out = parseHsbcTxn(SUBJECT, alert("INR 2590.65", "MYGATE", "31/10/26"));
    expect(out).toMatchObject({ card_last4: "4502", amount_inr: 2590.65, merchant_raw: "MYGATE", txn_type: "debit" });
    expect(out?.txn_at.getFullYear()).toBe(2026);
    expect(out?.txn_at.getMonth()).toBe(9); // October
    expect(out?.txn_at.getDate()).toBe(31);
  });

  it("handles lakh separators", () => {
    expect(parseHsbcTxn(SUBJECT, alert("INR 1,25,000.50", "EMIRATES", "01/09/26"))?.amount_inr).toBe(125000.5);
  });

  it("reads the date as day first", () => {
    const out = parseHsbcTxn(SUBJECT, alert("INR 100.00", "SHOP", "03/04/26"));
    expect(out?.txn_at.getMonth()).toBe(3); // April, not March
    expect(out?.txn_at.getDate()).toBe(3);
  });

  it("keeps a USD 1.00 hold as a foreign row, leaving INR to the FX step", () => {
    const out = parseHsbcTxn(SUBJECT, alert("USD 1.00", "GOOGLE", "19/09/26"));
    expect(out).toMatchObject({
      card_last4: "4502",
      amount_inr: 0,
      currency: "USD",
      amount_original: 1,
      merchant_raw: "GOOGLE",
      txn_type: "debit",
    });
  });

  it("keeps a merchant name that itself contains ' on ' or ' at '", () => {
    expect(parseHsbcTxn(SUBJECT, alert("INR 500.00", "CAFE AT THE PARK ON MG ROAD", "01/09/26"))?.merchant_raw)
      .toBe("CAFE AT THE PARK ON MG ROAD");
  });

  it("refuses an impossible date rather than guessing one", () => {
    expect(parseHsbcTxn(SUBJECT, alert("INR 100.00", "SHOP", "31/02/26"))).toBeNull();
    expect(parseHsbcTxn(SUBJECT, alert("INR 100.00", "SHOP", "12/13/26"))).toBeNull();
  });

  it("refuses a zero amount", () => {
    expect(parseHsbcTxn(SUBJECT, alert("INR 0.00", "SHOP", "01/09/26"))).toBeNull();
  });
});

describe("HSBC's new sender", () => {
  it("is in the list the sync searches", () => {
    expect(CARD_REGISTRY.hsbc_premier.gmail.senders).toContain("hsbc.bank.in");
  });

  it("routes to the HSBC parser", () => {
    expect(parseTxnEmail(`HSBC <${SENDER}>`, SUBJECT, alert("INR 2590.65", "MYGATE", "31/10/26"))?.amount_inr).toBe(2590.65);
  });

  it("still routes a forwarded alert, which keeps HSBC as the sender", () => {
    const out = parseTxnEmailWithFallback(SENDER, SUBJECT, alert("USD 1.00", "GOOGLE", "19/09/26"), "", new Set(["4502"]));
    expect(out).toMatchObject({ currency: "USD", amount_original: 1 });
    expect(out?.low_confidence).toBeUndefined();
  });
});

describe("HSBC emails that must never become transactions", () => {
  const known = new Set(["4502"]);

  it("OTP email: no charge has happened yet, and the alert follows separately", () => {
    expect(parseTxnEmailWithFallback(SENDER, "Your HSBC Credit Card OTP", OTP_BODY, "", known)).toBeNull();
  });

  it("'received credits' email: reads as a bill payment, and its 'payment of' must not book a debit", () => {
    expect(parseTxnEmailWithFallback(SENDER, "We have received credits on your HSBC credit card", CREDITS_BODY, "", known)).toBeNull();
  });

  it("limit-change notice", () => {
    expect(parseTxnEmailWithFallback(SENDER, "Transaction Limits", LIMITS_BODY, "", known)).toBeNull();
  });

  it("the OTP veto doesn't hide a real alert that merely warns about OTPs", () => {
    const body = "INR 100.00 has been debited from your card ending 4502 towards SHOP on 01 Sep, 2026. Never share your One-Time Password with anyone.";
    expect(parseTxnEmailWithFallback("alerts@somebank.com", "Alert", body, "", known)?.amount_inr).toBe(100);
  });
});

describe("a reversal of a hold (wording inferred, no real sample yet)", () => {
  it("books as a credit in the original currency", () => {
    const body = "USD 1.00 has been reversed on your HSBC Credit Card ending with 4502 on 20/09/26.";
    const out = parseTxnEmailWithFallback(SENDER, "Credit Card Transaction Alert", body, "", new Set(["4502"]));
    expect(out).toMatchObject({ card_last4: "4502", currency: "USD", amount_original: 1, txn_type: "credit" });
  });
});

describe("format watch over HSBC's new mail", () => {
  const domains = CARD_REGISTRY.hsbc_premier.gmail.senders;
  const row = (subject: string, body: string) => ({
    gmail_message_id: "m", raw_from: SENDER, raw_subject: subject, raw_body: body,
  });

  it("stays quiet on OTP, credits and limit-change emails", () => {
    const rows = [
      row("Your HSBC Credit Card OTP", OTP_BODY),
      row("We have received credits on your HSBC credit card", CREDITS_BODY),
      row("Transaction Limits", LIMITS_BODY),
    ];
    expect(findUnrecognizedFormatCandidates(rows, new Set(["4502"]), domains)).toEqual([]);
  });

  it("still flags an alert in a wording nobody has seen", () => {
    const out = findUnrecognizedFormatCandidates(
      [row(SUBJECT, "Your HSBC Credit Card xx4502 had a brand new kind of event for INR 500.")],
      new Set(["4502"]),
      domains,
    );
    expect(out).toHaveLength(1);
  });
});

describe("the USD 1.00 holds' merchant", () => {
  it("keeps the brand instead of the word after the star", () => {
    expect(cleanMerchant("FACEBK *PAYMENT")).toBe("Facebook");
  });
});
