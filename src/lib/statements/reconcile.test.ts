import { describe, expect, it } from "vitest";
import type { StatementLine } from "./parse";
import { alertSpans, amountAgreement, emiNamesPurchase, followCovered, matchLines, merchantsAgree, numberInUse, planRemovals, secondPass, statementLineKey, type DbTxn, type RemovalCandidate, type StmtLineRef } from "./reconcile";

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

describe("bank alerts win over merchant receipts", () => {
  it("gives a statement line to the bank's alert when a receipt for the same charge also fits", () => {
    // Real case: a Tada receipt (SGD 14.12) and HDFC's alert (₹878.08) for one ride.
    const l = line({ key: "tada", amount: 878.08, foreign: { currency: "SGD", amount: 14.12 } });
    const receipt = txn({ id: "receipt", amount_inr: 875.21, original_currency: "SGD", original_amount: 14.12, fromBank: false });
    const alert = txn({ id: "alert", amount_inr: 878.08, original_amount: 878.08 });
    for (const order of [[receipt, alert], [alert, receipt]]) {
      const out = matchLines([l], order);
      expect(out.matches.map((m) => m.txn.id)).toEqual(["alert"]);
      expect(out.unmatchedTxns.map((t) => t.id)).toEqual(["receipt"]);
    }
  });

  it("still matches a receipt when it is the only record of the charge", () => {
    const out = matchLines([line({ key: "a" })], [txn({ id: "receipt", fromBank: false })]);
    expect(out.matches).toHaveLength(1);
  });
});

describe("followCovered", () => {
  const monthly = ["2025-07-19", "2025-08-19", "2025-09-19", "2025-10-19"];
  it("needs a statement before the day and an unbroken run of statements 21 days past it", () => {
    expect(followCovered(monthly, "2025-08-25")).toBe(true);
    expect(followCovered(monthly, "2025-10-01")).toBe(false); // nothing 21 days later yet
    expect(followCovered(monthly, "2025-07-01")).toBe(false); // nothing before
    expect(followCovered(["2025-07-19", "2025-10-19"], "2025-08-25")).toBe(false); // missing months
  });
});

describe("planRemovals", () => {
  const c = (over: Partial<RemovalCandidate> & { id: string }): RemovalCandidate => ({
    kind: "not_on_statement", account: "4455", day: "2025-08-10", direction: "debit", amount: 500, foreign: null,
    followCovered: true, emiEvidence: false, ...over,
  });
  const reasons = (p: ReturnType<typeof planRemovals>) => Object.fromEntries([...p.remove, ...p.keep].map((x) => [x.id, x.reason]));

  it("removes second copies and charges a covered statement never billed", () => {
    expect(reasons(planRemovals([c({ id: "dup", kind: "duplicate" }), c({ id: "hold" })]))).toEqual({ dup: "second_copy", hold: "not_charged" });
  });

  it("removes a hold and its release together, even without the next statement", () => {
    const p = planRemovals([
      c({ id: "d", followCovered: false }),
      c({ id: "r", direction: "credit", day: "2025-08-12", followCovered: false }),
    ]);
    expect(reasons(p)).toEqual({ d: "hold_released", r: "hold_released" });
  });

  it("pairs zero-rupee foreign holds by their foreign amount", () => {
    const fx = { currency: "LKR", amount: 1320 };
    const p = planRemovals([c({ id: "d", amount: 0, foreign: fx }), c({ id: "r", amount: 0, foreign: fx, direction: "credit" }), c({ id: "x", amount: 0, foreign: { currency: "LKR", amount: 99 }, direction: "credit", followCovered: false })]);
    expect(reasons(p)).toEqual({ d: "hold_released", r: "hold_released", x: "next_statement_missing" });
  });

  it("keeps a charge whose next statement isn't available", () => {
    expect(reasons(planRemovals([c({ id: "late", followCovered: false })]))).toEqual({ late: "next_statement_missing" });
  });

  it("keeps one copy of a purchase the bank turned into EMI and removes the rest", () => {
    const p = planRemovals([c({ id: "a", amount: 43825.5, emiEvidence: true }), c({ id: "b", amount: 43825.5, emiEvidence: true })]);
    expect(reasons(p)).toEqual({ a: "shown_as_emi", b: "second_copy" });
  });

  it("never pairs a debit with a credit of a different amount or more than a week apart", () => {
    const p = planRemovals([c({ id: "d", followCovered: false }), c({ id: "r1", direction: "credit", amount: 499, followCovered: false }), c({ id: "r2", direction: "credit", day: "2025-08-20", followCovered: false })]);
    expect(p.remove).toEqual([]);
  });
});

describe("emiNamesPurchase", () => {
  it("recognises a merchant-EMI instalment by the merchant named after M-", () => {
    // Real case: "Razorpay Payments" is all generic words, so name matching alone missed it.
    expect(emiNamesPurchase("Razorpay Payments", "M-RAZORPAY PAYMENTS ,P:01,0000976 (Ref# 0999)")).toBe(true);
    expect(emiNamesPurchase("Croma", "M-CROMA RETAIL ,P:01,0001")).toBe(true);
  });

  it("doesn't tie an unrelated purchase or a bank EMI to it", () => {
    expect(emiNamesPurchase("Swiggy", "M-RAZORPAY PAYMENTS ,P:01,0000976")).toBe(false);
    expect(emiNamesPurchase("Razorpay Payments", "OFFUS EMI,PRIN NB:01,00000095837424")).toBe(false);
    expect(emiNamesPurchase(null, "M-RAZORPAY PAYMENTS ,P:01,0000976")).toBe(false);
  });
});
