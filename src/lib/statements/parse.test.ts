import { describe, expect, it } from "vitest";
import { classify, leadingDate, parseMoney, parseStatement, stitchAuRows, tieOut, type Line, type StatementDoc } from "./parse";

// Each row is written the way the unlock step stores it: positioned cells.
const row = (y: number, ...cells: (string | [number, string])[]): Line => ({
  y,
  cells: cells.map((c, i) => (typeof c === "string" ? { x: 40 + i * 60, s: c } : { x: c[0], s: c[1] })),
});
const doc = (family: string, pages: Line[][], date = "2026-10-19T08:00:00Z"): StatementDoc => ({ uid: 1, gmail_id: "g1", family, subject: "s", date, pages });

describe("parseMoney", () => {
  it("reads Indian and Western grouping, rupee prefixes and Cr/Dr", () => {
    expect(parseMoney("1,23,456.70")).toEqual({ value: 123456.7, sign: 1, marker: null });
    expect(parseMoney("600,460.56")?.value).toBe(600460.56);
    expect(parseMoney("Rs.-2957.90")).toEqual({ value: 2957.9, sign: -1, marker: null });
    expect(parseMoney("450.00 Cr")?.marker).toBe("cr");
    expect(parseMoney("1.00CR")?.marker).toBe("cr");
    expect(parseMoney("`45,735.60")?.value).toBe(45735.6); // ICICI's rupee glyph
  });

  it("rejects things that aren't money", () => {
    expect(parseMoney("16/09/2026")).toBeNull();
    expect(parseMoney("ABC")).toBeNull();
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("1,2,3.00")).toBeNull();
  });
});

describe("leadingDate", () => {
  it("reads DD/MM/YYYY with an optional time", () => {
    expect(leadingDate("16/09/2026| 16:51 | ABC", "hdfc", null)).toEqual({ date: "2026-09-16", rest: "ABC" });
    expect(leadingDate("28 Apr 26 | X", "idfc", null)?.date).toBe("2026-04-28");
  });

  it("gives Citi's yearless dates the statement's year, or the year before", () => {
    expect(leadingDate("11/01 | 019 | SHOP", "citi", "2020-02-12")?.date).toBe("2020-01-11");
    expect(leadingDate("28/12 | 019 | SHOP", "citi", "2020-01-12")?.date).toBe("2019-12-28");
  });

  it("refuses impossible dates", () => {
    expect(leadingDate("31/02/2026 | X", "axis", null)).toBeNull();
    expect(leadingDate("13/13/2026 | X", "axis", null)).toBeNull();
  });
});

describe("classify", () => {
  it("separates real spend from bookkeeping", () => {
    expect(classify("RAZ*AIRBNB,BENGALURU", "debit")).toBe("purchase");
    expect(classify("FOREIGN CURRENCY TRANSACTION FEE", "debit")).toBe("fee");
    expect(classify("RKR FUEL STATION HPCL", "debit")).toBe("purchase");
    expect(classify("BBPS PAYMENT RECEIVED - DP0162", "credit")).toBe("payment");
    expect(classify("TELE TRANSFER CREDIT (Ref# ST2)", "credit")).toBe("payment");
    expect(classify("CRED Visa Direct", "credit")).toBe("payment");
    expect(classify("REVERSAL -NEFT PAYMENT RECEIVED", "debit")).toBe("payment");
    expect(classify("10% Swiggy CashBack", "credit")).toBe("cashback");
    expect(classify("PETRO SURCHARGE WAIVER", "credit")).toBe("fee_reversal");
    expect(classify("AGGREGATOR EMI - OFFUS (Ref# 1)", "credit")).toBe("emi");
    expect(classify("OFFUS EMI,PRIN NB:03,123", "debit")).toBe("emi");
    expect(classify("M-RAZORPAY PAYMENTS ,P:01,0000", "debit")).toBe("emi");
    expect(classify("AMAZON HDFC SMARTBUY MUMBAI", "credit")).toBe("refund");
  });
});

describe("tieOut", () => {
  it("passes only when previous − credits + debits = a printed total", () => {
    expect(tieOut(594488.31 + 6436.1, 173042.23 + 463.85, [173042.23, 600460.56]).ok).toBe(true);
    expect(tieOut(594488.31 + 6436.1 - 1, 173042.23 + 463.85, [173042.23, 600460.56]).ok).toBe(false);
  });

  it("accepts a rounded total only when the debit or credit sum is itself printed", () => {
    // HDFC: 461,241.84 − 464,904.06 + 127,044.85 = 123,382.63, printed as 1,23,383.00
    expect(tieOut(127044.85, 464904.06, [461241.84, 464904.06, 123383]).how).toBe("rounded");
    expect(tieOut(127044.85, 464904.06, [461241.84, 123383]).ok).toBe(false);
  });

  it("labels a statement with no lines 'empty' rather than claiming it balanced", () => {
    expect(tieOut(0, 0, [500]).how).toBe("empty");
  });
});

describe("parseStatement", () => {
  it("reads Axis lines, keeps foreign amounts and credits, and ties out", () => {
    const page = [
      row(800, "Previous Balance - Payments - Credits + Purchase + Cash Advance + Other Debit&Charges"),
      row(790, "100.00 Dr", "100.00", "0.00", "5,450.16", "0.00", "0.00", "5,450.16", "Dr"),
      row(780, "Card No:", "5241 29XX XXXX 4455"),
      row(770, "04/10/2026", "ALL.ACCOR* MERCURE ZUR,CRISSIER", "( CHF 45.25 )", "HOTELS", "5,300.16 Dr"),
      row(760, "25/09/2026", "RAZ*GORALLY,BENGALURU", "ENTERTAINMENT", "450.00 Dr"),
      row(750, "25/09/2026", "RAZ*GORALLY,BENGALURU", "ENTERTAINMENT", "450.00 Cr"),
      row(740, "26/09/2026", "BBPS PAYMENT RECEIVED", "100.00 Cr"),
      row(730, "27/09/2026", "SPOTIFY", "MISC", "150.00 Dr"),
    ];
    const p = parseStatement(doc("axis", [page]));
    expect(p.lines).toHaveLength(5);
    expect(p.lines[0]).toMatchObject({ date: "2026-10-04", amount: 5300.16, direction: "debit", foreign: { currency: "CHF", amount: 45.25 }, cardLast4: "4455", merchant: "ALL.ACCOR* MERCURE ZUR,CRISSIER" });
    expect(p.lines[2]).toMatchObject({ direction: "credit", kind: "refund" });
    expect(p.lines[3].kind).toBe("payment");
    expect(p.tie.ok).toBe(true);
  });

  it("reads HDFC's '+ C' credits, skips reward points, and joins wrapped merchant names", () => {
    const page = [
      row(500, "C", "1,000.00", "C", "1,195.00", "+", "C", "1,391.35", "+", "C", "0.00", "=", "C", "1,196.00"),
      row(410, [251, "MYNTRA VIA SMARTBUYGURGAON (Ref#"]),
      row(400, [170, "16/09/2026| 00:00"], [300, "- 35"], [330, "+"], [340, "C"], [360, "1,195.00"], [380, "l"]),
      row(390, [251, "VT262610075030980000127)"]),
      row(380, [170, "18/09/2026| 15:46"], [200, "ABCOFFEEMUMBAI"], [300, "+ 35"], [340, "C"], [360, "196.35"], [380, "l"]),
      row(370, [170, "19/09/2026| 15:48"], [200, "EMI"], [220, "RKR FUEL STATION HPCLBANGALORE"], [340, "C"], [360, "1,195.00"], [380, "l"]),
    ];
    const p = parseStatement(doc("hdfc", [page]));
    expect(p.lines.map((l) => [l.amount, l.direction])).toEqual([
      [1195, "credit"],
      [196.35, "debit"],
      [1195, "debit"],
    ]);
    expect(p.lines[0].merchant).toBe("MYNTRA VIA SMARTBUYGURGAON");
    expect(p.lines[1].merchant).toBe("ABCOFFEEMUMBAI");
    expect(p.tie.ok).toBe(true);
  });

  it("ignores side-panel text after the amount and chart labels before the date", () => {
    // 1,000 previous − 1,000 credit + 3,107 debits = 3,107 due
    const page = [
      row(500, "1,000.00", "3,107.00"),
      row(400, "19/03/2023", "EAZYDINER GURGAON IN", "RESTAURANTS", "111", "1107.00", "DR", "Statement Date"),
      row(390, "66%", "26/07/2025", "1167", "I SHOP HTTPS://ISHOP IN", "60", "2,000.00"),
      row(380, "For exclusive", "08/08/2025", "1175", "Pets Centric", "90", "1,000.00", "CR"),
    ];
    const p = parseStatement(doc("indusind", [page]));
    expect(p.lines.map((l) => l.amount)).toEqual([1107, 2000, 1000]);
    expect(p.lines[2].direction).toBe("credit");
    expect(p.tie.ok).toBe(true);
  });

  it("never reads an EMI schedule row that starts with a number as a transaction", () => {
    // The real failure: the row has no merchant text, so the HDFC wrapped-name
    // fallback borrowed the schedule heading above it and invented a line.
    const page = [row(410, [300, "SMARTBUY EMI LOAN SCHEDULE"]), row(400, "69066200", "28/05/2021", "28,629.25", "6", "1.25", "14,581.30")];
    expect(parseStatement(doc("hdfc", [page])).lines).toHaveLength(0);
  });

  it("skips pages that only illustrate how interest is charged", () => {
    const page = [row(500, "The following illustration will indicate the method"), row(400, "05/12/2025", "Apparel Purchase", "10,000.00")];
    expect(parseStatement(doc("icici", [page])).lines).toHaveLength(0);
  });

  it("marks a statement unreconciled when a line is missing", () => {
    const page = [row(500, "1,000.00", "2,107.00"), row(400, "19/03/2023", "EAZYDINER", "1107.00", "DR")];
    expect(parseStatement(doc("indusind", [page])).tie.ok).toBe(true);
    const missingLine = [row(500, "1,000.00", "2,207.00"), row(400, "19/03/2023", "EAZYDINER", "1107.00", "DR")];
    expect(parseStatement(doc("indusind", [missingLine])).tie.ok).toBe(false);
  });
});

describe("stitchAuRows", () => {
  it("joins AU's three-row transactions and leaves other rows alone", () => {
    const page = [row(500, "Your Transactions"), row(490, "PYMNT RCV BBPS"), row(480, "05", "+₹208.86"), row(470, "Oct 26", "Cr"), row(460, "Page 1 of 4")];
    const out = stitchAuRows(page);
    expect(out.map((l) => l.cells.map((c) => c.s).join(" | "))).toEqual(["Your Transactions", "05 Oct 26 | PYMNT RCV BBPS | 208.86 | Cr", "Page 1 of 4"]);
  });
});
