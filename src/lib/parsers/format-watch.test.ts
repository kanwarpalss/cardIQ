import { describe, expect, it } from "vitest";
import { findUnrecognizedFormatCandidates, type SeenRow } from "./format-watch";

const base: SeenRow = { gmail_message_id: "test", raw_from: "alerts@hdfcbank.bank.in", raw_subject: "We noticed a transaction on your Credit Card", raw_body: "Credit Card ending in 3034 .You made a transaction of Rs.553.00 at Swiggy." };
const banks = ["hdfcbank.bank.in", "hsbc.bank.in", "citicorp.com"];
const known = new Set(["3034"]);
describe("format watch catches gaps independently of parsing", () => {
  it("detects the real HDFC ending-in wording the parser missed", () => {
    expect(findUnrecognizedFormatCandidates([base], known, banks)).toHaveLength(1);
  });
  it("keeps an explicit bank transaction alert even if the card field is damaged", () => {
    expect(findUnrecognizedFormatCandidates([{ ...base, raw_body: "A new bank template with an unreadable card field" }], known, banks))
      .toMatchObject([{ matched_last4: "unknown" }]);
  });
  it("keeps an explicit HSBC alert for a card not yet registered", () => {
    expect(findUnrecognizedFormatCandidates([{ ...base, raw_from: "hsbc@hsbc.bank.in", raw_subject: "Credit Card Transaction Alert", raw_body: "Credit Card xx3337 was used for INR 9140" }], known, banks)).toHaveLength(1);
  });
  it("never hides a real Citi alert behind its marketing footer", () => {
    expect(findUnrecognizedFormatCandidates([{ ...base, raw_from: "CitiAlert.India@citicorp.com", raw_subject: "Transaction confirmation on your Citibank credit card", raw_body: "Card 4304XXXXXXXX6589. Click here. Special offer. Unsubscribe." }], known, banks)).toHaveLength(1);
  });
  it("excludes an ordinary HDFC newsletter using the extracted local part", () => {
    expect(findUnrecognizedFormatCandidates([{ ...base, raw_from: "HDFC <information@hdfcbank.bank.in>", raw_subject: "A privilege update", raw_body: "Your credit card ending 3034" }], known, banks)).toHaveLength(0);
  });
});
