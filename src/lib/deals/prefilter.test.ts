import { describe, it, expect } from "vitest";
import { screen, matchBank, bankOfIssuer, dealSearchQuery } from "./prefilter";
import { CARD_REGISTRY } from "@/lib/cards/registry";

// Real subject lines and senders from KP's inbox and the four blog feeds,
// Jul–Nov 2026. Each one is labelled by what it actually was.
const DEALS: [string, string][] = [
  ["Marriott-Bonvoy@points-mail.com", "Kanwar P, Buy Points Before The Highest Bonus Drops"],
  ["Marriott-Bonvoy@points-mail.com", "Your 55% Bonus Points Offer Is Going Fast"],
  ["marriottbonvoy@email-marriott.com", "Act Fast to Get up to 55% Bonus Points ⏰"],
  ["marriottbonvoy@email-marriott.com", "Ends 9/9: Get up to 50% Bonus Points, Kanwar Pal Singh"],
  ["marriottbonvoy@email-marriott.com", "Limited Availability! Get Your Bonus Points Offer Now."],
  ["marriottbonvoy@info.email-marriott.com", "Last Chance! KrisFlyer Miles to Points: 10% Bonus"],
  ["singaporeair@email.singaporeair.com", "Enjoy 50% bonus rewards when you convert between KrisFlyer miles and ALL Accor Reward points"],
  ["singaporeair@email.singaporeair.com", "Enjoy 10% bonus Marriott Bonvoy® points this September"],
  ["noreply@h5.hilton.com", "Kanwar Pal, last call for 100% Bonus Points"],
  ["Live From A Lounge", "Deal: Buy Finnair Plus Avios with a 50% Discount"],
  ["CardExpert", "Amex Membership Rewards Just Got Better: Improved Transfers to Virgin Atlantic & Hilton"],
  ["Live From A Lounge", "Flipkart SuperCoins Conversion Bonus With 1:1 Airline Miles and 2:1 Accor Points through November 8, 2026"],
  ["alerts@axisbank.com", "Transfer your EDGE Miles to Accor with a 30% bonus"],
];

const NOISE: [string, string][] = [
  ["marriottbonvoy@email-marriott.com", "Don’t Miss up to 4,500 Bonus Points per Stay"],
  ["marriottbonvoy@email-marriott.com", "Get 1,000 Bonus Points and Earn Twice on Flights and Stays"],
  ["noreply@h5.hilton.com", "New promo alert! Up to 3,000 Bonus Points on every stay"],
  ["noreply@h5.hilton.com", "Earn Up to 5,000 Bonus Points at New Hotels"],
  ["mail@e.itc-hotels.net", "Discover More, Stay More, Earn Up to 50,000 Bonus Green Points"],
  ["singaporeair@email.singaporeair.com", "11 bonus KrisFlyer miles awaits you this 11.11 on KrisShop!"],
  ["singaporeair@email.singaporeair.com", "Earn up to 4X bonus KrisFlyer miles on KrisShop!"],
  ["singaporeair@email.singaporeair.com", "Double your purchases on KrisShop for bonus KrisFlyer miles!"],
  ["travel@pelago.co", "+9 bonus miles per S$1"],
  ["cards@cheq.one", "This Diwali, unlock 4000 bonus CheQ Points! 🪔"],
  ["The MileLion", "HSBC TravelOne Card launches 30,000 miles sign-up bonus"],
  ["The MileLion", "Qatar Airways Privilege Deals: Save 25% off selected awards for November and December 2026"],
  ["CardExpert", "Transfer Club ITC Points to Marriott Bonvoy: Everything You Need to Know"],
  ["CardExpert", "Club ITC Offer: Earn up to 50,000 Bonus Green Points on Your Hotel Stays"],
];

describe("screen — the free first pass", () => {
  it.each(DEALS)("passes the real deal from %s: %s", (from, subject) => {
    expect(screen({ from, subject }).pass).toBe(true);
  });

  it.each(NOISE)("drops the earning promo / article from %s: %s", (from, subject) => {
    expect(screen({ from, subject }).pass).toBe(false);
  });

  it("names the program from the sender when the subject doesn't", () => {
    const s = screen({ from: "Marriott-Bonvoy@points-mail.com", subject: "Buy Points Before The Highest Bonus Drops" });
    expect(s).toMatchObject({ pass: true, signal: "buy", program: "marriott" });
  });

  it("reads the bank from a bank's own sender domain", () => {
    expect(screen({ from: "alerts@axisbank.com", subject: "Transfer your EDGE Miles to Accor with a 30% bonus" }))
      .toMatchObject({ pass: true, signal: "transfer", program: "accor", bank: "axis" });
  });

  it("drops a deal-shaped line that names no program or bank", () => {
    expect(screen({ from: "offers@shop.example", subject: "Buy points now: 50% bonus on SuperCoins" }))
      .toMatchObject({ pass: false, reason: "no known program or bank named" });
  });

  it("uses the preview text when the subject alone is vague", () => {
    expect(screen({ from: "x@email-marriott.com", subject: "Don't Leave This Behind" }).pass).toBe(false);
    expect(screen({ from: "x@email-marriott.com", subject: "Don't Leave This Behind", snippet: "Buy or gift points before the bonus is reduced." }).pass).toBe(true);
  });

  it("does not let a stay promo through on its percentage", () => {
    expect(screen({ from: "x@hilton.com", subject: "Earn 50% more points per night this winter" }).pass).toBe(false);
  });

  it("survives empty and odd input", () => {
    expect(screen({ from: "", subject: "" }).pass).toBe(false);
    expect(screen({ from: "x", subject: "   \n\t " }).pass).toBe(false);
  });
});

describe("matchBank / bankOfIssuer", () => {
  it("maps every registry issuer to a bank key", () => {
    for (const spec of Object.values(CARD_REGISTRY)) expect(bankOfIssuer(spec.issuer), spec.issuer).not.toBeNull();
  });

  it("knows the banks' portal names", () => {
    expect(matchBank("SmartBuy flight offer")).toBe("hdfc");
    expect(matchBank("EDGE Miles transfer")).toBe("axis");
    expect(matchBank("americanexpress.co.in")).toBe("amex");
  });

  it("does not see a bank inside an unrelated word", () => {
    expect(matchBank("taxis and axes")).toBeNull();
  });
});

describe("dealSearchQuery", () => {
  it("is bounded by a whole-second date and excludes social mail", () => {
    const q = dealSearchQuery(1794054732.9);
    expect(q).toContain("after:1794054732 ");
    expect(q).toContain("-category:social");
  });
});
