// Classes of silent miss found while adding HSBC Premier on 2026-10-31. The
// bodies are real unless a test says its wording is inferred.

import { describe, it, expect } from "vitest";
import { parseHdfcTxn } from "@/lib/parsers/hdfc";
import { parseHsbcTxn } from "@/lib/parsers/hsbc";
import { genericSniff } from "@/lib/parsers/generic-sniffer";
import { parseTxnEmail, parseTxnEmailWithFallback } from "@/lib/parsers/registry";
import {
  buildUnlistedSenderQuery,
  findQuietCards,
  findUnlistedSenderCandidates,
  type SeenRow,
} from "@/lib/parsers/format-watch";

describe("a parser must never store a transaction with no card", () => {
  const body = (card: string) =>
    `HDFC BANK --> Dear Customer, Thank you for using your HDFC Bank Card ${card} for Rs. 5988.0 at IND*LinkedIn (PGSI) on 17-08-2026 13:46:23 . Authorization code: 098078 Please note that this transaction was conducted without OTP /PIN.`;

  it("reads the XX form of HDFC's card number", () => {
    expect(parseHdfcTxn("A charge just happened on your Credit Card without OTP", body("XX5906"))).toMatchObject({
      card_last4: "5906",
      amount_inr: 5988,
      txn_type: "debit",
    });
  });

  it("the registry refuses any parser result without a 4-digit card", () => {
    const out = parseTxnEmail("alerts@hdfcbank.net", "Alert", body("number hidden"));
    expect(out).toBeNull();
  });
});

describe("HSBC's older template in a foreign currency", () => {
  it("books the charge instead of dropping it", () => {
    const out = parseTxnEmailWithFallback(
      "hsbc@mail.hsbc.co.in",
      "You have used your HSBC Credit Card ending with 3337 for a purchase transaction",
      "your Credit card no ending with 3337, has been used for AED 200.00 for payment to DUBAI MALL on 01 May 2026 at 21:22.",
      "",
      new Set(["3337"]),
    );
    expect(out).toMatchObject({ card_last4: "3337", currency: "AED", amount_original: 200, amount_inr: 0, merchant_raw: "DUBAI MALL" });
    expect(out?.low_confidence).toBeUndefined();
  });
});

describe("the generic sniffer's amount", () => {
  it("reads 'Rs. 100' rather than a later figure like the available limit", () => {
    const out = genericSniff(
      "Alert",
      "Rs. 100.50 has been debited from your card ending 4502. Available limit INR 66297.00",
      "",
      new Set(["4502"]),
    );
    expect(out?.amount_inr).toBe(100.5);
  });
});

describe("mail the sync never fetches", () => {
  const banks = ["hsbc.bank.in", "hsbc.co.in", "axis.bank.in"];
  const known = new Set(["4502", "4455"]);
  const row = (raw_from: string, raw_subject: string, raw_body: string): SeenRow => ({
    gmail_message_id: "m",
    raw_from,
    raw_subject,
    raw_body,
  });

  it("flags a bank alert from a new domain, which is how HSBC's move went unnoticed", () => {
    const out = findUnlistedSenderCandidates(
      [row("hsbc@alerts.hsbcindia.com", "Card update", "Your HSBC Credit Card xx4502 was used at SHOP.")],
      known,
      banks,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sender: "hsbc@alerts.hsbcindia.com", matched_last4: "4502" });
  });

  it("flags a forward that lost HSBC as the sender", () => {
    const out = findUnlistedSenderCandidates(
      [row("birsimrat1@gmail.com", "Fwd: Credit Card Transaction Alert", "your HSBC Credit Card xx4502 was used for a transaction of INR 100.00 at SHOP on 01/11/26.")],
      known,
      banks,
    );
    expect(out).toHaveLength(1);
  });

  it("flags an explicit alert subject even when the card number is unreadable", () => {
    const out = findUnlistedSenderCandidates(
      [row("alerts@newbank.example", "Credit Card Transaction Alert", "A charge happened.")],
      known,
      banks,
    );
    expect(out).toEqual([expect.objectContaining({ matched_last4: "unknown" })]);
  });

  it("ignores listed senders, which the ordinary watch already covers", () => {
    expect(findUnlistedSenderCandidates([row("hsbc@hsbc.bank.in", "Credit Card Transaction Alert", "xx4502")], known, banks)).toEqual([]);
  });

  it("ignores merchant receipts naming the card, OTPs and banker correspondence", () => {
    const rows = [
      row("store@shop.example", "Your order receipt", "Paid with Visa ending in 9999."),
      row("hsbc@alerts.hsbcindia.com", "Your HSBC Credit Card OTP", "A One-Time Password (OTP) has been generated for a transaction on your HSBC Credit Card ending with 4502."),
      row("birsimrat1@gmail.com", "EXTERNAL: Request for Credit Limit Enhancement", "HSBC Premier card ending 4502"),
      row("banker@hsbcindia.com", "EXTERNAL: Re: Request for Credit Limit Enhancement", "card ending 4502"),
    ];
    expect(findUnlistedSenderCandidates(rows, known, banks)).toEqual([]);
  });

  it("builds a query that excludes listed senders and looks back a fixed window", () => {
    const q = buildUnlistedSenderQuery(banks, 21);
    expect(q).toContain("from:hsbc");
    expect(q).toContain("subject:fwd");
    expect(q).toContain("-from:hsbc.bank.in");
    expect(q).toContain("-from:axis.bank.in");
    expect(q).toContain("newer_than:21d");
  });
});

describe("a card that goes quiet", () => {
  const now = new Date("2026-12-01T12:00:00Z");
  const charge = (last4: string, day: string, txn_type: "debit" | "credit" = "debit") => ({
    card_last4: last4,
    txn_type,
    txn_at: `${day}T12:00:00Z`,
  });
  const regular = (last4: string, lastDay: string) => [
    charge(last4, "2026-09-01"),
    charge(last4, "2026-09-08"),
    charge(last4, "2026-09-15"),
    charge(last4, "2026-09-22"),
    charge(last4, lastDay),
  ];

  it("flags a regularly used card with no charge for far longer than its usual gap", () => {
    const out = findQuietCards(regular("4502", "2026-09-29"), ["4502"], now);
    expect(out).toEqual([{ last4: "4502", lastChargeAt: "2026-09-29T12:00:00Z", daysQuiet: 63, longestGapDays: 7 }]);
  });

  it("stays silent while the card is in use", () => {
    expect(findQuietCards(regular("4502", "2026-11-28"), ["4502"], now)).toEqual([]);
  });

  it("stays silent on a card used too rarely to judge", () => {
    expect(findQuietCards([charge("3337", "2026-09-01"), charge("3337", "2026-09-05")], ["3337"], now)).toEqual([]);
  });

  it("stays silent on a card that always has long gaps", () => {
    const lumpy = ["2026-05-01", "2026-06-15", "2026-07-30", "2026-09-15"].map((d) => charge("9004", d));
    expect(findQuietCards(lumpy, ["9004"], now)).toEqual([]);
  });

  it("doesn't let refunds count as the card being in use", () => {
    const out = findQuietCards([...regular("4502", "2026-09-29"), charge("4502", "2026-11-30", "credit")], ["4502"], now);
    expect(out).toHaveLength(1);
  });
});

describe("HSBC's old foreign wording on the strict parser", () => {
  it("still refuses a zero amount", () => {
    expect(parseHsbcTxn("x", "your Credit card no ending with 3337, has been used for AED 0.00 for payment to X on 01 May 2026 at 21:22.")).toBeNull();
  });
});
