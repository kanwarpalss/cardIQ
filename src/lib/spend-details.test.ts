import { describe, expect, it } from "vitest";
import { groupVoucherSpendDetails, hasExpandableSpendDetails } from "./spend-details";

describe("spend detail expansion", () => {
  it("offers the same expansion affordance for order items or vouchers", () => {
    expect(hasExpandableSpendDetails([{ name: "Shirt" }], [])).toBe(true);
    expect(hasExpandableSpendDetails([], groupVoucherSpendDetails([{ brand: "Luxe", face_value: 5_000 }]))).toBe(true);
    expect(hasExpandableSpendDetails([], [])).toBe(false);
  });

  it("groups repeated vouchers without losing their value", () => {
    expect(groupVoucherSpendDetails([
      { brand: "Luxe", face_value: 5_000 },
      { brand: "luxe", face_value: 5_000 },
      { brand: "Luxe", face_value: 2_000 },
    ])).toEqual([
      { brand: "Luxe", faceValue: 5_000, quantity: 2, total: 10_000 },
      { brand: "Luxe", faceValue: 2_000, quantity: 1, total: 2_000 },
    ]);
  });

  it("does not create an expansion for malformed voucher details", () => {
    const groups = groupVoucherSpendDetails([
      { brand: "   ", face_value: 5_000 },
      { brand: "Luxe", face_value: 0 },
      { brand: "Luxe", face_value: Number.NaN },
    ]);
    expect(groups).toEqual([]);
    expect(hasExpandableSpendDetails([], groups)).toBe(false);
  });
});
