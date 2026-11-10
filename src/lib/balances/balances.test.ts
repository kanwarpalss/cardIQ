import { describe, it, expect } from "vitest";
import { LOYALTY_READERS, parseDayMonthYear, parsePoints, planLoyaltyUpdate, type LoyaltyReading } from "./loyalty-emails";
import { readAxisPoints, readHdfcPoints } from "./statement-points";

// Text shapes copied from KP's real emails and statements (10 Nov 2026), with
// membership, customer and card numbers replaced by dummies.
const reader = (k: string) => LOYALTY_READERS.find((r) => r.program === k)!;

describe("loyalty email readers", () => {
  it("Hilton: balance and tier from any email's header, dated by the email", () => {
    const t = "links ) Silver Member #1234567890 ( # )21,315 Points*****120% more Points. Starting at 51,000 Points per night.";
    expect(reader("hilton").read(t, "2026-11-03T08:00:00Z")).toEqual({ program: "hilton", balance: 21315, as_of: "2026-11-03", tier: "Silver" });
  });

  it("Hilton: an email without the header gives nothing — never a 'Starting at 51,000 Points' price", () => {
    expect(reader("hilton").read("Starting at 51,000 Points per night. Earn 2X Points.", "2026-10-27T00:00:00Z")).toBeNull();
  });

  it("KrisFlyer: the account summary, both spacings the emails use", () => {
    const a = "Dear Mr X, Here's your membership statement. ACCOUNT SUMMARY AS OF 01 Oct 2026 31485 CURRENT KRISFLYER MILES EXPIRING* KRISFLYER MILES 0 in Oct 2026";
    const b = "ACCOUNT SUMMARYAS OF 01 Sep 2026 31485CURRENT KRISFLYER MILES EXPIRING*";
    expect(reader("krisflyer").read(a, "2026-10-09T00:00:00Z")).toMatchObject({ balance: 31485, as_of: "2026-10-01" });
    expect(reader("krisflyer").read(b, "2026-09-11T00:00:00Z")).toMatchObject({ balance: 31485, as_of: "2026-09-01" });
  });

  it("Qatar: Avios and the stated as-of date, including a zero balance", () => {
    const t = "Kanwar Pal Privilege Club Burgundy 123456789 102 Qpoints to Silver Your Avios 3,514 Avios expiry date Qpoints Qcredits 15 October 2029 33 0 Balance as of 28 October 2026 There's always more";
    expect(reader("qatar_avios").read(t, "2026-10-28T00:00:00Z")).toEqual({ program: "qatar_avios", balance: 3514, as_of: "2026-10-28", tier: "Burgundy" });
    const zero = "Privilege Club Burgundy 123456789 135 Qpoints to Silver Your Avios 0 Qpoints Qcredits 0 0 Balance as of 26 August 2026";
    expect(reader("qatar_avios").read(zero, "2026-08-26T00:00:00Z")?.balance).toBe(0);
  });

  it("Club ITC: closing balance only when the four columns add up", () => {
    const ok = "TIER Member ACCOUNT SUMMARY AS ON 30th SEPTEMBER'26 (Point Balance & Tier Status) OPENING BALANCE GREEN POINTS EARNED GREEN POINTS REDEEMED / LAPSED CLOSING BALANCE 10000.00 10100.00 16520.00 3580.00 [banner]";
    expect(reader("club_itc").read(ok, "2026-10-02T00:00:00Z")).toEqual({ program: "club_itc", balance: 3580, as_of: "2026-09-30", tier: "Member" });
    const broken = ok.replace("3580.00 [banner]", "3590.00 [banner]");
    expect(reader("club_itc").read(broken, "2026-10-02T00:00:00Z")).toBeNull();
  });

  it("number and date helpers refuse junk", () => {
    expect(parsePoints("2,12,337")).toBe(212337);
    expect(parsePoints("12a")).toBeNull();
    expect(parsePoints("-5")).toBeNull();
    expect(parseDayMonthYear("31st OCTOBER'26")).toBe("2026-10-31");
    expect(parseDayMonthYear("31 Sept 2026")).toBeNull();
    expect(parseDayMonthYear("no date")).toBeNull();
  });
});

describe("planLoyaltyUpdate — a newer saved balance always wins", () => {
  const reading: LoyaltyReading = { program: "hilton", balance: 21315, as_of: "2026-11-03", tier: "Silver" };
  it("updates a balance saved before the email", () => {
    expect(planLoyaltyUpdate(reading, [{ id: "h", program_key: "hilton", points_balance: 20000, updated_at: "2026-08-15T05:15:08Z" }]))
      .toEqual({ action: "update", id: "h", reading });
  });
  it("keeps a balance KP typed in after the email arrived", () => {
    expect(planLoyaltyUpdate(reading, [{ id: "h", program_key: "hilton", points_balance: 25000, updated_at: "2026-11-05T10:00:00Z" }]).action).toBe("keep");
  });
  it("keeps a balance saved later the same day", () => {
    expect(planLoyaltyUpdate(reading, [{ id: "h", program_key: "hilton", points_balance: 1, updated_at: "2026-11-04T00:00:00Z" }]).action).toBe("keep");
  });
  it("adds a program he hasn't logged yet", () => {
    expect(planLoyaltyUpdate(reading, [{ id: "k", program_key: "krisflyer", points_balance: 1, updated_at: "2026-01-01T00:00:00Z" }]).action).toBe("insert");
  });
});

describe("statement point balances", () => {
  const axis = [
    "Manager, Customer Care,Axis Bank Ltd | nodal.officer@axis.bank.in",
    "eDGE REWARD | BALANCE AS | CUSTOMER ID",
    "POINTS | ON DATE",
    "\"Gigaplex\", Plot No I.T.5, MIDC | Axis Bank Ltd, CPU 1st Floor",
    "765241 | 15-10-2026 | 999999999 | Navi Mumbai-400708 | Park, Airoli",
  ];
  it("Axis: reads the EDGE balance and its date", () => {
    expect(readAxisPoints(axis)).toEqual({ balance: 765241, as_of: "2026-10-15" });
  });
  it("Axis: no balance block, or an impossible date, gives nothing", () => {
    expect(readAxisPoints(axis.slice(2))).toBeNull();
    expect(readAxisPoints([...axis.slice(0, 4), "765241 | 31-02-2026 | 9"])).toBeNull();
  });

  const hdfc = [
    "KANWAR PAL SINGH SETHI | Credit Card No. | 123456XXXXXX5906",
    "Statement Date | 15 Oct, 2026",
    "Opening Balance | Feature + Bonus Reward | Disbursed | Adjusted/Lapsed",
    "Reward Points",
    "Points Earned",
    "2,12,337 | 14,526 | 0 | 750",
    "2,26,113",
  ];
  it("HDFC: closing balance when opening + earned − disbursed − lapsed adds up", () => {
    expect(readHdfcPoints(hdfc)).toEqual({ last4: "5906", balance: 226113, as_of: "2026-10-15" });
  });
  it("HDFC: refuses a closing figure that doesn't add up", () => {
    expect(readHdfcPoints([...hdfc.slice(0, 6), "2,26,114"])).toBeNull();
  });
  it("HDFC: refuses a statement with no card number or date", () => {
    expect(readHdfcPoints(hdfc.slice(1))).toBeNull();
    expect(readHdfcPoints([hdfc[0], ...hdfc.slice(2)])).toBeNull();
  });
});
