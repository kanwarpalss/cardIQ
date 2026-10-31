import { describe, expect, it } from "vitest";
import { CARD_REGISTRY } from "./registry";

const tiers = (key: string) => CARD_REGISTRY[key].milestones_anniversary.map((m) => m.spend_inr);

describe("card specs match the bank terms read on 2026-10-31", () => {
  it("every card states its utility and rent rules and the check date", () => {
    for (const spec of Object.values(CARD_REGISTRY)) {
      expect(spec.bill_rules?.utilities.earns, spec.product_key).toBeTruthy();
      expect(spec.bill_rules?.rent.earns, spec.product_key).toBeTruthy();
      expect(spec.benefits_verified_at, spec.product_key).toBe("2026-10-31");
    }
  });

  it("ICICI is not described as uncapped and pays vouchers at ₹4L and ₹8L", () => {
    const spec = CARD_REGISTRY.icici_emeralde_private_metal;
    expect(spec.rewards?.earn_summary).not.toMatch(/uncapped/i);
    expect(spec.bill_rules?.utilities.limit).toMatch(/1,000 points/);
    expect(tiers(spec.product_key)).toEqual([400000, 800000, 1000000]);
  });

  it("keeps KP's ICICI ₹1.5L monthly milestone", () => {
    expect(CARD_REGISTRY.icici_emeralde_private_metal.milestones_monthly[0].spend_inr).toBe(150000);
  });

  it("Infinia's utility limit equals 2,000 points at its earn rate", () => {
    const { points_per_unit, unit_inr } = CARD_REGISTRY.hdfc_infinia.rewards!;
    expect((2000 / points_per_unit) * unit_inr).toBe(60000);
    expect(CARD_REGISTRY.hdfc_infinia.bill_rules?.utilities.limit).toMatch(/₹60,000/);
  });

  it("ICICI's utility limit equals 1,000 points at its earn rate", () => {
    const { points_per_unit, unit_inr } = CARD_REGISTRY.icici_emeralde_private_metal.rewards!;
    expect(Math.round((1000 / points_per_unit) * unit_inr)).toBe(33333);
  });

  it("HSBC shows the shared ₹1L limit and drops the unsourced overseas rate", () => {
    const earn = CARD_REGISTRY.hsbc_premier.rewards?.earn_summary;
    expect(earn).toMatch(/₹1L monthly limit/);
    expect(earn).not.toMatch(/overseas/i);
  });

  it("Axis earns nothing on utilities and has a 4-guest international allowance", () => {
    const spec = CARD_REGISTRY.axis_magnus_burgundy;
    expect(spec.bill_rules?.utilities.earns).toMatch(/^No points/);
    expect(spec.bill_rules?.utilities.fee).toMatch(/₹25,000/);
    expect(spec.lounge.international?.visits_per_year).toBe("unlimited");
    expect(spec.milestones_monthly).toEqual([]); // ₹1.5L is an earn-rate kink, never a milestone
  });

  it("Swiggy tracks its ₹2L fee waiver", () => {
    expect(tiers("hdfc_swiggy")).toEqual([200000]);
  });

  it("Amex has ₹4L and ₹7L milestones and no ₹1.9L", () => {
    expect(tiers("amex_platinum_travel")).toEqual([400000, 700000]);
  });

  it("adding Amex leaves the mail sync's sender list unchanged", () => {
    const senders = new Set(Object.values(CARD_REGISTRY).flatMap((s) => s.gmail.senders));
    expect(CARD_REGISTRY.amex_platinum_travel.gmail.senders).toEqual([]);
    expect([...senders].sort()).toEqual([
      "axis.bank.in", "axisbank.com",
      "hdfcbank.bank.in", "hdfcbank.com", "hdfcbank.net",
      "hsbc.bank.in", "hsbc.co.in",
      "icici.bank.in", "icicibank.com",
      "mail.hsbc.co.in",
    ]);
  });
});
