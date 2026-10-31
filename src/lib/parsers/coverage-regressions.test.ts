import { describe, expect, it } from "vitest";
import { parseTxnEmail, parseTxnEmailWithFallback } from "./registry";
import { BANK_EMAIL_SENDERS } from "../cards/registry";

describe("real all-card coverage gaps, 31 October 2026", () => {
  it("keeps the actual HSBC and legacy Citi senders in live discovery", () => {
    expect(BANK_EMAIL_SENDERS).toContain("hsbc.bank.in");
    expect(BANK_EMAIL_SENDERS).toContain("citicorp.com");
  });

  it.each(["Rs 703.00", "SGD 1.55"])("reads the older ICICI amount field %s", (amount) => {
    const result = parseTxnEmail("credit_cards@icicibank.com", "Transaction alert for your ICICI Bank credit card",
      `Your ICICI Bank Credit Card XX8006 has been used for a transaction of ${amount} on October 16, 2022; 03:32:17. Info: BUS/MRT. The Available Credit Limit is INR 1045570.16.`);
    expect(result).toMatchObject({ card_last4: "8006", amount_inr: amount.startsWith("Rs") ? 703 : 0 });
    if (amount.startsWith("SGD")) expect(result).toMatchObject({ currency: "SGD", amount_original: 1.55 });
  });
  it("reads HDFC's noticed-transaction alert for the current Swiggy card", () => {
    expect(parseTxnEmail("alerts@hdfcbank.bank.in", "We noticed a transaction on your Credit Card",
      "Thank you for using your HDFC Bank Credit Card ending in 3034 .You made a transaction of Rs. 553.00 at RAZ*Swiggy on 16-06-2026 18:21:22 . Authorization code: 044042 Important Note: If you did not do this transaction, please act immediately."))
      .toMatchObject({ card_last4: "3034", amount_inr: 553, merchant_raw: "RAZ*Swiggy", txn_type: "debit" });
  });

  it.each(["is reversed", "has been reversed"])("reads HDFC's old %s credit", (verb) => {
    expect(parseTxnEmail("alerts@hdfcbank.net", "Alert : Update on your HDFC Bank Credit Card",
      `We note that a transaction for Rs 2.00, on your HDFC Bank Credit Card ending 0204 at UBER INDIA SYSTEMS PRI on 06-03-2022 22:52:22 ${verb}.`))
      .toMatchObject({ card_last4: "0204", amount_inr: 2, merchant_raw: "UBER INDIA SYSTEMS PRI", txn_type: "credit" });
  });

  it("reads HDFC's archived RsA/endingA refund fields", () => {
    expect(parseTxnEmail("alerts@hdfcbank.net", "Alert : Update on your HDFC Bank Credit Card",
      "We note that a refund for RsA 97.66, from Amazon Prime is credited to your HDFC Bank Credit Card endingA 8609 on 08-01-2023 14:34:31."))
      .toMatchObject({ card_last4: "8609", amount_inr: 97.66, merchant_raw: "Amazon Prime", txn_type: "credit" });
  });

  it("reads ICICI's older full-month date followed by a semicolon", () => {
    expect(parseTxnEmail("credit_cards@icicibank.com", "Transaction alert for your ICICI Bank credit card",
      "Your ICICI Bank Credit Card XX8006 has been used for a transaction of INR 1,679.00 on December 26, 2021; 14:23:43. Info: MARKS AND SPENCER. The Available Credit Limit on your card is INR 10,87,827.00."))
      .toMatchObject({ card_last4: "8006", amount_inr: 1679, merchant_raw: "MARKS AND SPENCER", txn_type: "debit" });
  });

  it("reads HSBC's real new-domain alert without using the available limit", () => {
    expect(parseTxnEmail("HSBC <hsbc@hsbc.bank.in>", "Credit Card Transaction Alert",
      "We’re writing to confirm that your HSBC Credit Card xx3337 was used for a transaction of INR 9140.00 at EAZYDINER PRIVATE LI on 21/09/26. Available limit: INR 1490860.00 Amount due: INR 9140.00"))
      .toMatchObject({ card_last4: "3337", amount_inr: 9140, merchant_raw: "EAZYDINER PRIVATE LI", txn_type: "debit" });
  });

  it.each([
    ["Rs 1,472.40 was spent on your Credit Card 4304XXXXXXXX6589 on 25-JUL-17 at CITRUS PAY JAZZCINEM. Save while you spend with over 5000 offers", "6589", 1472.40, "CITRUS PAY JAZZCINEM"],
    ["Rs. 955.00 spent on card 6016 on 07-JUN-24 at Swiggy. Limit available=Rs. 218,107.90.", "6016", 955, "Swiggy"],
    ["Rs.108.00 was spent on your Citi Credit Card ending 4304XXXXXXXX6589 on 25-AUG-17 at EMBAR SUPER STORE. Your available credit limit now is Rs.132920.25.", "6589", 108, "EMBAR SUPER STORE"],
    ["12,283.00 INR was spent on your Credit Card 4304XXXXXXXX6589 on 26-JUL-17 at SRILANKAN AIRLINES L.Final FX rates and charges are applicable.", "6589", 12283, "SRILANKAN AIRLINES L"],
  ])("reads Citi purchase %s", (body, last4, amount, merchant) => {
    expect(parseTxnEmail("CitiAlert.India@citicorp.com", "Transaction confirmation on your Citibank credit card", String(body)))
      .toMatchObject({ card_last4: last4, amount_inr: amount, merchant_raw: merchant, txn_type: "debit" });
  });

  it("reads Citi's merchant refund with the actual card suffix", () => {
    expect(parseTxnEmail("CitiAlert.India@citicorp.com", "Credit Transaction on your Citibank credit card",
      "Credit of Rs.2099.00 received from CITRUS PAY GO AIR has been processed on your Credit Card ************6589 on 25/09/17."))
      .toMatchObject({ card_last4: "6589", amount_inr: 2099, merchant_raw: "CITRUS PAY GO AIR", txn_type: "credit" });
  });

  it("keeps a Citi foreign cancellation as a separate foreign credit", () => {
    expect(parseTxnEmail("CitiAlert.India@citicorp.com", "Cancellation of transaction on your Citibank credit card",
      "Transaction of 70.50TRY on your Citi Credit Card ending 4304XXXXXXXX6589 on 25-DEC-17 at BTA CAFE INN DOM has been cancelled. Available credit limit is Rs.105,935.37."))
      .toMatchObject({ card_last4: "6589", currency: "TRY", amount_original: 70.5, amount_inr: 0, merchant_raw: "BTA CAFE INN DOM", txn_type: "credit" });
  });

  it("reads a Citi provisional credit as a dated credit, not the disputed debit", () => {
    expect(parseTxnEmail("CitiAlert.India@citicorp.com", "Provisional credit to your Citibank credit card",
      "Rs.169.00 has been provisionally credited to Credit Card no ************0817 on 15/10/20 for disputed transaction at CR-I2010133040-AMAZON STA. Please note the final credit or reversal of this provisional credit will be based on the investigation."))
      .toMatchObject({ card_last4: "0817", amount_inr: 169, txn_type: "credit" });
  });

  it.each([
    ["Trnx of 1,320.00LKR on card 4304XXXXXXXX6589 on 30-JUL-19 at CARGILLS FC COL 2 is cancelled.FX charges as per TnC.", "LKR", 1320, 0],
    ["Transaction of Rs. 26.26 on your Citi Card ending 4304XXXXXXXX6589 on 04-NOV-19 at DC FOODS is cancelled. Available credit limit is Rs.112056.02", undefined, undefined, 26.26],
  ])("reads the shorter Citi cancellation %s", (body, currency, original, inr) => {
    expect(parseTxnEmail("CitiAlert.India@citicorp.com", "Cancellation of transaction on your Citibank credit card", body as string))
      .toMatchObject({ card_last4: "6589", txn_type: "credit", amount_inr: inr, ...(currency ? { currency, amount_original: original } : {}) });
  });

  it.each(["", "9�55.00", "9,,55.00", "0.00", "-955.00", "955.001", "9".repeat(400)])("rejects an uncertain Citi amount %s", (amount) => {
    expect(parseTxnEmailWithFallback("CitiAlert.India@citicorp.com", "Transaction confirmation on your Citibank credit card",
      `Rs. ${amount} spent on card 6016 on 07-JUN-24 at Swiggy. Limit available=Rs.218107.90`, "", new Set(["6016"]))).toBeNull();
  });

  it.each([
    ["CitiAlert - Credit Balance Refund", "Your Citi Credit Card account ending 6016 has a credit balance of INR 7990.00. Please add your bank account for us to initiate refund."],
    ["Credit Alert regarding your Citi Credit Card", "Credit of Rs. 642.00 received on your Citi credit card ending 6016 has been adjusted against your total outstanding. Revised total due= Rs.0.00."],
    ["Transaction declined", "Your transaction of INR 553 on Credit Card XX3034 was declined."],
  ])("does not invent spend from %s", (subject, body) => {
    expect(parseTxnEmailWithFallback("CitiAlert.India@citicorp.com", subject, body, "", new Set(["6016", "3034"]))).toBeNull();
  });
});

describe("new parser branches reject unsafe fields", () => {
  const known = new Set(["3034", "3337", "6016"]);
  it.each(["0.00", "9".repeat(400)])("rejects invalid HDFC noticed amount %s", (amount) => {
    expect(parseTxnEmailWithFallback("alerts@hdfcbank.bank.in", "We noticed a transaction on your Credit Card",
      `Your HDFC Bank Credit Card ending in 3034 .You made a transaction of Rs. ${amount} at RAZ*Swiggy on 16-06-2026 18:21:22 . Authorization code: 044042`, "", known)).toBeNull();
  });
  it.each(["31/02/26", "21/13/26"])("rejects impossible HSBC date %s", (date) => {
    expect(parseTxnEmailWithFallback("hsbc@hsbc.bank.in", "Credit Card Transaction Alert",
      `Your HSBC Credit Card xx3337 was used for a transaction of INR 9140.00 at EAZYDINER PRIVATE LI on ${date}.`, "", known)).toBeNull();
  });
  it("reads HSBC without a currency separator and preserves its historical date", () => {
    const parsed = parseTxnEmail("hsbc@hsbc.bank.in", "Credit Card Transaction Alert", "Your HSBC Credit Card xx3337 was used for a transaction of INR9140.00 at EAZYDINER PRIVATE LI on 21/09/26.");
    expect(parsed?.amount_inr).toBe(9140);
    expect(parsed?.txn_at.toISOString()).toBe("2026-09-21T06:30:00.000Z");
  });
  it("rejects a Citi alert explicitly stating this transaction was declined", () => {
    expect(parseTxnEmailWithFallback("CitiAlert.India@citicorp.com", "Transaction confirmation on your Citibank credit card", "Rs.955.00 spent on card 6016 on 07-JUN-24 at Swiggy. This transaction was declined and no amount was spent.", "", known)).toBeNull();
  });
});
