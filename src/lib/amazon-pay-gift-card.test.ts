import { describe, expect, it } from "vitest";
import { matchConfirmedAmazonPayGiftCard, parseAmazonPayGiftCardEmail } from "./amazon-pay-gift-card";

const baseEmail = () => parseAmazonPayGiftCardEmail({
  gmailMessageId: "amazon-email", from: "Amazon Pay India <no-reply@amazonpay.in>",
  subject: "Your BIRKENSTOCK Gift Card is here!", text: "Your gift card has arrived.",
  receivedAt: "2026-07-15T19:19:19.000Z",
})!;
const valid = () => ({
  email: baseEmail(), voucherId: "amazon-voucher", confirmedFaceValue: 5000,
  order: { id: "order", brand: "Birkenstock India", total: 5793, orderedAt: "2026-07-15T19:21:11.000Z" },
  directCardDebit: { id: "debit", amount: 793, txnAt: "2026-07-15T19:21:10.000Z", txnType: "debit" },
});

describe("parseAmazonPayGiftCardEmail", () => {
  it("recognizes Amazon Pay's exact gift-card delivery receipt", () => {
    expect(baseEmail()).toMatchObject({ brand: "BIRKENSTOCK", brandKey: "birkenstock", faceValue: null });
  });

  it("keeps an amount only when the email explicitly states one", () => {
    const email = parseAmazonPayGiftCardEmail({
      gmailMessageId: "m", from: "no-reply@amazonpay.in", subject: "Your Birkenstock Gift Card is here!",
      text: "Gift card value: INR 5,000", receivedAt: "2026-07-15T19:19:19Z",
    });
    expect(email?.faceValue).toBe(5000);
  });

  it.each([
    ["a lookalike sender", "Amazon Pay <no-reply@amazonpay.example>", "Your Birkenstock Gift Card is here!"],
    ["a forwarded/replied subject", "no-reply@amazonpay.in", "Re: Your Birkenstock Gift Card is here!"],
    ["a reminder", "no-reply@amazonpay.in", "Your Birkenstock Gift Card is here! Reminder"],
  ])("rejects %s", (_case, from, subject) => {
    expect(parseAmazonPayGiftCardEmail({ gmailMessageId: "m", from, subject, text: "Value ₹5000", receivedAt: "2026-07-15T19:19:19Z" })).toBeNull();
  });
});

describe("matchConfirmedAmazonPayGiftCard", () => {
  it("keeps the Birkenstock ₹5,000 email tied to its exact voucher and ₹793 debit", () => {
    expect(matchConfirmedAmazonPayGiftCard(valid())).toEqual({
      voucherId: "amazon-voucher", voucherAmount: 5000, cardAmount: 793, orderId: "order", cardTxnId: "debit",
    });
  });

  it.each([
    ["a one-paise mismatch", (x: ReturnType<typeof valid>) => { x.confirmedFaceValue = 4999.99; }],
    ["a different merchant", (x: ReturnType<typeof valid>) => { x.order.brand = "Birkenstock Kids"; }],
    ["a credit/refund", (x: ReturnType<typeof valid>) => { x.directCardDebit.txnType = "credit"; }],
    ["a debit equal to the order", (x: ReturnType<typeof valid>) => { x.directCardDebit.amount = 5793; }],
    ["an event over fifteen minutes apart", (x: ReturnType<typeof valid>) => { x.order.orderedAt = "2026-07-15T19:34:20.000Z"; }],
  ])("refuses %s", (_case, mutate) => {
    const x = valid(); mutate(x);
    expect(matchConfirmedAmazonPayGiftCard(x)).toBeNull();
  });

  it("never invents a balance from an amount-less email", () => {
    const x = valid();
    x.confirmedFaceValue = 0;
    expect(matchConfirmedAmazonPayGiftCard(x)).toBeNull();
  });
});
