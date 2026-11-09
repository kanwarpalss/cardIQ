import { describe, expect, it } from "vitest";
import type { StatementLine } from "./parse";
import { alertSpans, amountAgreement, matchLines, merchantsAgree, numberInUse, secondPass, statementLineKey, type DbTxn, type StmtLineRef } from "./reconcile";

const line = (over: Partial<StmtLineRef> & { key: string }): StmtLineRef => ({
  date: "2026-10-04",
  description: "SPOTIFY",
  merchant: "SPOTIFY",
  amount: 299,
  direction: "debit",
  kind: "purchase",
  foreign: null,
  cardLast4: "4455",
  page: 1,
  ...over,
});
const txn = (over: Partial<DbTxn> & { id: string }): DbTxn => ({
  card_last4: "4455",
  amount_inr: 299,
  txn_type: "debit",
  day: "2026-10-04",
  original_currency: "INR",
  original_amount: 299,
  ...over,
});

describe("amountAgreement", () => {
  it("needs the exact rupee amount for INR alerts", () => {
    expect(amountAgreement(line({ key: "a" }), txn({ id: "1" }))).toBe("exact");
    expect(amountAgreement(line({ key: "a", amount: 299.01 }), txn({ id: "1" }))).toBeNull();
  });

  it("matches foreign alerts on the original amount, or within 5% when the statement omits the currency", () => {
    const usd = txn({ id: "1", amount_inr: 372.3, original_currency: "USD", original_amount: 5.23 });
    expect(amountAgreement(line({ key: "a", amount: 387.52, foreign: { currency: "USD", amount: 5.23 } }), usd)).toBe("foreign");
    expect(amountAgreement(line({ key: "a", amount: 387.52 }), usd)).toBe("foreign_inr_approx");
    expect(amountAgreement(line({ key: "a", amount: 500 }), usd)).toBeNull();
  });
});

describe("matchLines", () => {
  it("pairs one-to-one: two identical coffees need two alerts", () => {
    const lines = [line({ key: "a", amount: 196.35 }), line({ key: "b", amount: 196.35 })];
    const r = matchLines(lines, [txn({ id: "1", amount_inr: 196.35 })]);
    expect(r.matches).toHaveLength(1);
    expect(r.unmatchedLines).toHaveLength(1);
  });

  it("respects card, direction and the 3-day window", () => {
    const l = line({ key: "a" });
    expect(matchLines([l], [txn({ id: "1", card_last4: "1111" })]).matches).toHaveLength(0);
    expect(matchLines([l], [txn({ id: "1", txn_type: "credit" })]).matches).toHaveLength(0);
    expect(matchLines([l], [txn({ id: "1", day: "2026-10-08" })]).matches).toHaveLength(0);
    expect(matchLines([l], [txn({ id: "1", day: "2026-10-07" })]).matches).toHaveLength(1);
  });

  it("prefers the nearest date when two alerts could pair", () => {
    const r = matchLines([line({ key: "a" })], [txn({ id: "far", day: "2026-10-01" }), txn({ id: "near", day: "2026-10-04" })]);
    expect(r.matches[0].txn.id).toBe("near");
  });

  it("pairs across a reissued card's old and new numbers only when told they're one account", () => {
    const l = line({ key: "a", cardLast4: "6589" });
    const t = txn({ id: "1", card_last4: "0817" });
    expect(matchLines([l], [t]).matches).toHaveLength(0);
    expect(matchLines([l], [t], (n) => (n === "0817" ? "6589" : n)).matches).toHaveLength(1);
  });
});

describe("secondPass", () => {
  it("treats an exact amount posted within 10 days as already present", () => {
    const r = secondPass([line({ key: "a", date: "2026-10-12" })], [txn({ id: "1", day: "2026-10-04" })], () => null);
    expect(r.latePosted).toHaveLength(1);
    expect(r.unmatchedLines).toHaveLength(0);
  });

  it("pairs a hotel hold with its settled charge by merchant, up to 21 days later", () => {
    const hold = txn({ id: "1", day: "2025-12-03", amount_inr: 246621.11, original_currency: "USD", original_amount: 2742.92 });
    const charge = line({ key: "a", date: "2025-12-15", amount: 218091.93, description: "HAMPTON INNS,SUNNYVALE HOTELS" });
    const r = secondPass([charge], [hold], () => "Hampton");
    expect(r.repriced).toHaveLength(1);
  });

  it("leaves a different merchant's charge missing, so it gets added", () => {
    const r = secondPass([line({ key: "a", amount: 500, description: "NOBROKER TECHNOLOGIES" })], [txn({ id: "1", amount_inr: 450 })], () => "Swiggy");
    expect(r.unmatchedLines).toHaveLength(1);
  });

  it("won't call a 10x difference the same purchase", () => {
    const r = secondPass([line({ key: "a", amount: 21248.96, description: "HERTZ RENT A CAR" })], [txn({ id: "1", amount_inr: 185875.13 })], () => "Hertz Rent A");
    expect(r.repriced).toHaveLength(0);
  });
});

describe("merchantsAgree", () => {
  it("matches on a meaningful shared word, not on city or filler words", () => {
    expect(merchantsAgree("Hampton", "HAMPTON INNS,SUNNYVALE HOTELS")).toBe(true);
    expect(merchantsAgree("Irctc Smart", "SMARTBUY IRCTC BANGALORE")).toBe(true);
    expect(merchantsAgree("Bangalore Payments", "SWIGGY BANGALORE")).toBe(false);
    expect(merchantsAgree(null, "ANY")).toBe(false);
  });
});

describe("numberInUse", () => {
  const txns = [txn({ id: "1", card_last4: "6589", day: "2019-12-20" }), txn({ id: "2", card_last4: "0817", day: "2020-01-14" }), txn({ id: "3", card_last4: "0817", day: "2020-10-16" }), txn({ id: "4", card_last4: "6016", day: "2020-11-09" })];
  const spans = alertSpans(txns);
  it("picks the number whose alerts cover that day, or the nearest", () => {
    expect(numberInUse(["6589", "0817", "6016"], "2020-05-01", spans, "6589")).toBe("0817");
    expect(numberInUse(["6589", "0817", "6016"], "2023-01-01", spans, "6589")).toBe("6016");
    expect(numberInUse(["6589", "0817", "6016"], "2019-12-01", spans, "6589")).toBe("6589");
  });
  it("keeps the printed number when it's in use that day", () => {
    expect(numberInUse(["0817", "6016"], "2020-05-01", spans, "0817")).toBe("0817");
  });
});

describe("statementLineKey", () => {
  const l: StatementLine & { cardLast4: string } = { date: "2026-10-04", description: "X", merchant: "X", amount: 1, direction: "debit", kind: "purchase", foreign: null, cardLast4: "1", page: 1 };
  it("is stable, prefixed, and distinct per occurrence", () => {
    expect(statementLineKey("g", l, 1)).toBe(statementLineKey("g", l, 1));
    expect(statementLineKey("g", l, 1)).toMatch(/^stmt:g:[0-9a-f]{16}$/);
    expect(statementLineKey("g", l, 1)).not.toBe(statementLineKey("g", l, 2));
  });
});
