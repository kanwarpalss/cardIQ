import { describe, expect, it } from "vitest";
import { parseTxnEmailWithFallback } from "./registry";

const known = new Set(["4502"]);
const sender = "HSBC <hsbc@hsbc.bank.in>";
const subject = "Credit Card Transaction Alert";
function alert(money = "INR 16387.79", date = "31/10/26", merchant = "MYGATE") {
  return `Dear Customer, We’re writing to confirm that your HSBC Credit Card xx4502 was used for a transaction of ${money} at ${merchant} on ${date}. Available limit: INR 74068.95 Amount due: INR 25931.05`;
}
const parse = (body: string) => parseTxnEmailWithFallback(sender, subject, body, "", known);

describe("HSBC Premier purchase alerts", () => {
  it("reads the reported MYGATE purchase without substituting either balance", () => {
    const result = parse(alert());
    expect(result).toMatchObject({ card_last4: "4502", amount_inr: 16387.79, merchant_raw: "MYGATE", txn_type: "debit" });
    expect(result?.txn_at.toISOString()).toBe("2026-10-31T06:30:00.000Z");
    expect(result?.low_confidence).toBeUndefined();
  });

  it.each(["24/10/26", "23/10/26", "27/09/26", "20/09/26", "17/09/26", "16/09/26"])("captures the real USD Facebook layout dated %s", (date) => {
    expect(parse(alert("USD 1.00", date, "FACEBK *PAYMENT"))).toMatchObject({
      card_last4: "4502", amount_inr: 0, currency: "USD", amount_original: 1,
      merchant_raw: "FACEBK *PAYMENT", txn_type: "debit",
    });
  });

  it("uses the purchase currency even when the available INR limit appears first", () => {
    expect(parse(`Available limit: INR 74068.95. ${alert("USD 1.00")}`))
      .toMatchObject({ currency: "USD", amount_original: 1, amount_inr: 0 });
  });

  it.each(["INR 16,387.79", "INR 1,63,887.79", "INR16387.79"])("supports valid HSBC money formatting %s", (money) => {
    expect(parse(alert(money))?.amount_inr).toBe(Number(money.replace(/INR|,/g, "").trim()));
  });

  it.each(["", "0.00", "-1.00", "1.001", ",1.00", "1,00.00", "1,,000.00", "1,000,.00", "1e3", "9".repeat(400)])("rejects damaged purchase amount %j, including with a payment footer", (amount) => {
    expect(parse(`${alert(`USD ${amount}`)} Payment of your statement may be made online.`)).toBeNull();
  });

  it.each(["31/02/26", "29/02/25", "00/10/26", "31/00/26", "31/13/26", "31/10/2026oops"])("rejects impossible or damaged purchase date %s", (date) => {
    expect(parse(`${alert("USD 1.00", date)} Payment of your statement may be made online.`)).toBeNull();
  });

  it("accepts leap day", () => {
    expect(parse(alert("USD 1.00", "29/02/24"))?.txn_at.toISOString()).toBe("2024-02-29T06:30:00.000Z");
  });

  it("does not manufacture spend from an HSBC OTP or balance notice", () => {
    expect(parse("Use your OTP for a transaction of INR 16387.79 on HSBC Credit Card xx4502 at MYGATE.")).toBeNull();
    expect(parse("Available limit on HSBC Credit Card xx4502: INR 74068.95. Amount due INR 25931.05.")).toBeNull();
  });

  it("does not turn the real aggregate-credit notice into a purchase or merchant refund", () => {
    expect(parseTxnEmailWithFallback("HSBC India <alerts@mail.hsbc.bank.in>",
      "We have received credits on your HSBC credit card",
      "We have received credits of ₹ 1,140.00 on your HSBC credit card ending with 4502 on 22/10/2026. The amount has been adjusted against your outstanding balance. Kindly make the remaining payment of ₹ 89,208.42 within timeline to avoid any finance charges.", "", known)).toBeNull();
  });
});
